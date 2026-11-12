'use strict';
// End-to-end UI smoke test. Runs as an Electron main process: it reuses the
// REAL preload + IPC + renderer + core, starts an in-process SSH server, then
// drives the actual UI through window.api / App and captures screenshots.
// Run headless on Linux: xvfb-run -a electron test/ui-smoke.js --no-sandbox
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { TestSshServer, startEchoServer } = require('./test-server');
const { Store } = require('../src/core/store');
const { RemoteManager } = require('../src/core/remote-manager');
const { registerIpc } = require('../src/main/ipc');

const results = [];
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');
// Running a bare script makes app.getVersion() fall back to the Electron
// version; pin the real app version so artifacts match the shipped app.
app.setVersion(require('../package.json').version);

app.whenReady().then(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-smoke-root-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-smoke-data-'));
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello remote\n');
  fs.writeFileSync(path.join(root, 'project', 'app.js'), 'console.log("hi");\n');

  const server = new TestSshServer({ root });
  const info = await server.start(0);
  const echo = await startEchoServer();

  const store = new Store(userData, { cipher: null });
  const manager = new RemoteManager({ store, hostKeyPolicy: 'accept' });
  let win = null;
  registerIpc({ manager, store, getWindow: () => win });

  const consoleErrors = [];
  win = new BrowserWindow({
    width: 1280, height: 820, show: true, backgroundColor: '#1b1c20',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false,
    },
  });
  win.webContents.on('console-message', (...args) => {
    let level, message;
    if (args.length === 1 && args[0] && typeof args[0] === 'object') { level = args[0].level; message = args[0].message; }
    else { level = args[1]; message = args[2]; }
    if (level === 3 || level === 'error') consoleErrors.push(message);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const exec = (js) => win.webContents.executeJavaScript(js, true);
  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      const out = path.join(__dirname, '..', 'build', name);
      fs.writeFileSync(out, img.toPNG());
      console.log('screenshot ->', out);
    } catch (e) {
      // Best-effort artifact: no display surface (locked/headless desktop)
      // must not fail the functional assertions.
      console.log('screenshot skipped:', name, '(' + e.message + ')');
    }
  };

  // wait for renderer boot
  const booted = await exec(`new Promise((r)=>{const t=setInterval(()=>{if(window.App&&App.state.appInfo){clearInterval(t);r(true);}},50);setTimeout(()=>{clearInterval(t);r(false);},8000);})`);
  check('renderer booted (window.api + App)', booted && await exec(`!!window.api && !!window.App`));
  check('app info has version', await exec(`!!(App.state.appInfo && App.state.appInfo.version)`));
  await sleep(700); // let entrance animations settle before capturing
  await shot('screenshot-welcome.png');

  // create + connect through the real UI layer
  const connId = await exec(`(async()=>{const s=await window.api.connections.save({host:'${info.host}',port:${info.port},username:'${info.username}',password:'${info.password}',name:'smoke-host'});await App.connections.refresh();await App.connections.connect(s.id);return s.id;})()`);
  check('connected via UI', await exec(`App.state.sessions['${connId}'] && App.state.sessions['${connId}'].state==='connected'`));
  check('workspace visible', await exec(`!document.getElementById('workspace').hidden`));
  check('sidebar shows connection', await exec(`document.querySelectorAll('#conn-list .conn-item').length>=1`));
  check('tree lists hello.txt', await exec(`Array.from(document.querySelectorAll('#tree .tname')).some(n=>n.textContent==='hello.txt')`));
  check('tree lists project dir', await exec(`Array.from(document.querySelectorAll('#tree .tname')).some(n=>n.textContent==='project')`));

  // open + edit + save a remote file through the editor
  await exec(`App.files.openFile({path:'/hello.txt',name:'hello.txt',type:'file'})`);
  await sleep(150);
  check('editor shows remote content', await exec(`document.getElementById('editor').value.includes('hello remote')`));
  await exec(`(async()=>{const ed=document.getElementById('editor');ed.value=ed.value+'edited-through-ui\\n';App.files.onEditorInput();await App.files.save();})()`);
  check('edit saved to remote', await exec(`(async()=>{const d=await window.api.fs.read('${connId}','/hello.txt');return d.content.includes('edited-through-ui');})()`));
  await shot('screenshot-files.png');

  // add a local forward through the real forwarding API + panel
  const fwd = await exec(`(async()=>{const f=await window.api.forward.add('${connId}',{type:'local',bindHost:'127.0.0.1',bindPort:0,destHost:'127.0.0.1',destPort:${echo.port}});await App.ports.refresh();return f;})()`);
  check('local forward active', fwd && fwd.status === 'active');
  check('ports panel renders row', await exec(`document.querySelectorAll('#ports-body tr').length>=1`));
  await exec(`document.querySelector('.tab[data-tab="ports"]').click()`);
  await sleep(250);
  await shot('screenshot-ports.png');

  // verify the UI-created forward actually tunnels (probe from the main side)
  const tunnelOk = await new Promise((res) => {
    const s = net.connect(fwd.bindPort, '127.0.0.1', () => s.write('ping-through-ui'));
    let b = '';
    const t = setTimeout(() => { s.destroy(); res(false); }, 5000);
    s.on('data', (d) => { b += d; if (b.includes('ping-through-ui')) { clearTimeout(t); s.end(); res(true); } });
    s.on('error', () => { clearTimeout(t); res(false); });
  });
  check('UI-created forward tunnels end-to-end', tunnelOk);

  // ---- forward lifecycle: stop keeps a disconnected row, start revives it ----
  const fwdId = await exec(`window.api.forward.list('${connId}').then((l) => l[0] && l[0].id)`);
  await exec(`App.ports.stop('${fwdId}')`);
  await sleep(500);
  check('stop keeps the row marked 断开', await exec(`document.querySelectorAll('#ports-body tr').length === 1 && document.querySelector('#ports-body tr .status-pill.stopped') !== null`));
  check('disconnected row offers start + delete', await exec(`document.querySelectorAll('#ports-body tr .fwd-actions .ghost').length === 2`));
  await exec(`App.ports.restart('${fwdId}')`);
  await sleep(500);
  check('start revives the forward as active', await exec(`document.querySelector('#ports-body tr .status-pill.active') !== null`));

  // ---- switching connections switches the workspace ----
  const conn2Id = await exec(`(async()=>{const s=await window.api.connections.save({host:'${info.host}',port:${info.port},username:'${info.username}',password:'${info.password}',name:'second-host'});await App.connections.refresh();return s.id;})()`);
  await exec(`App.connections.onItemClick('${conn2Id}')`);
  await sleep(500);
  check('clicking a second connection activates it', await exec(`App.state.activeId === '${conn2Id}'`));
  check('ports panel switches to the new session (empty)', await exec(`document.querySelectorAll('#ports-body tr').length === 0 && !document.getElementById('ports-empty').hidden`));
  check('file tree reloaded for the new session', await exec(`Array.from(document.querySelectorAll('#tree .tname')).some(n => n.textContent === 'hello.txt')`));
  await exec(`App.connections.onItemClick('${connId}')`);
  await sleep(500);
  check('switching back restores the first session forwards', await exec(`App.state.activeId === '${connId}' && document.querySelectorAll('#ports-body tr').length >= 1`));

  // ---- theme switching ----
  await exec(`App.setTheme('daylight')`);
  check('theme switch applies', await exec(`document.documentElement.dataset.theme === 'daylight'`));
  check('theme persisted to store', await exec(`window.api.settings.get('ui.theme').then(v => v === 'daylight')`));
  await exec(`App.setTheme('phosphor')`);
  check('second theme applies', await exec(`document.documentElement.dataset.theme === 'phosphor'`));
  await exec(`App.setTheme('midnight')`);

  // ---- language switching ----
  await exec(`App.setLang('en')`);
  check('language switch applies (EN)', await exec(`document.querySelector('.tab[data-tab="files"]').textContent.includes('Files')`));
  check('language persisted to store', await exec(`window.api.settings.get('ui.lang').then(v => v === 'en')`));
  await exec(`App.setLang('zh')`);
  check('language switch back (ZH)', await exec(`document.querySelector('.tab[data-tab="files"]').textContent.includes('文件')`));

  // ---- mini mode (compact tunnel monitor) ----
  await exec(`App.setMini(true)`);
  await sleep(350);
  check('mini mode activates', await exec(`document.body.classList.contains('mini') && !document.getElementById('mini').hidden`));
  check('mini shows live session', await exec(`document.querySelectorAll('#mini-sessions .mini-conn').length >= 1`));
  check('mini shows forward card', await exec(`document.querySelectorAll('#mini-forwards .mini-fwd').length >= 1`));
  check('mini window state reported', await exec(`window.api.window.state().then(s => s.mini === true)`));
  check('mini sparkline drawn', await exec(`(() => { const c = document.getElementById('mini-spark'); return c.width > 0 && c.height > 0; })()`));
  await sleep(1100); // one monitor tick so rates are visible in the artifact
  await shot('screenshot-mini.png');
  await exec(`App.setMini(false)`);
  await sleep(250);
  check('expand restores full UI', await exec(`!document.body.classList.contains('mini') && !document.getElementById('workspace').hidden`));

  // ---- delete is the only operation that drops the record ----
  await exec(`window.api.forward.remove('${connId}', '${fwdId}')`);
  await exec(`App.ports.refresh()`);
  await sleep(400);
  check('delete removes the forward record', await exec(`document.querySelectorAll('#ports-body tr').length === 0 && !document.getElementById('ports-empty').hidden`));

  check('no renderer console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('CONSOLE ERRORS:\n' + consoleErrors.join('\n'));

  await manager.destroy();
  echo.server.close();
  await server.stop();
  try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); } catch {}

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((e) => {
  console.error('SMOKE FATAL:', e);
  app.exit(1);
});
