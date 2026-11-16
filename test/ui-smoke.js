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
// Windows marks an occluded window hidden, which stops all painting and makes
// capturePage() return a stale frame (and pauses timers + rAF). Disable the
// native occlusion calculation so the screenshots and the animation-driven
// assertions describe what a real user would see.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Running a bare script makes app.getVersion() fall back to the Electron
// version; pin the real app version so artifacts match the shipped app.
app.setVersion(require('../package.json').version);

app.whenReady().then(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-smoke-root-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-smoke-data-'));
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'img'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello remote\n');
  fs.writeFileSync(path.join(root, 'project', 'app.js'), 'console.log("hi");\n');
  fs.copyFileSync(path.join(__dirname, '..', 'build', 'icon.png'), path.join(root, 'img', 'icon.png'));
  // D-1 fixtures: a token with no space anywhere in it and > 100 characters —
  // the shape of a generated identifier or a long URL. One per inline context,
  // so a narrow pane has to wrap them instead of scrolling the reading layer.
  const longTok = (kind) => (kind + 'UnbreakableTokenSegment').repeat(4) + kind;
  // A document that is taller than the pane, so the anchor jump below always
  // has somewhere to scroll back up from.
  fs.writeFileSync(path.join(root, 'README.md'), [
    '# Preview',
    '',
    '**bold** and ![icon](img/icon.png)',
    '',
    '## Preview',
    '',
    '- [x] shipped',
    '- [ ] pending',
    '',
    '### ' + longTok('heading'),
    '',
    'Paragraph ' + longTok('paragraph') + ' with `' + longTok('inlineCode') + '` and',
    '[https://example.invalid/' + longTok('url') + '](https://example.invalid/' + longTok('url') + ') in one line.',
    '',
    '- list item ' + longTok('listItem'),
    '',
    '> quoted ' + longTok('blockquote'),
    '',
    '| Name | Count | Note |',
    '| --- | :---: | ---: |',
    '| alpha | 3 | one |',
    '| experimentalVeryLongConfigurationKeyThatRemoteServersSometimesActuallyDoUseInConfigFilesAndNeverWrap | 12 | two |',
    '',
    'Reading paragraph that keeps the document taller than the pane, so the',
    'anchor jump below always has somewhere to scroll back up from.',
    '',
    '```js',
    'const copied = "through-ui";',
    'const veryLongSingleLineStatement = computeValue(firstArgument, secondArgument, thirdArgument, fourthArgument, fifthArgument);',
    '```',
    '',
    '## End',
    '',
    'Trailing body text: ' + 'lorem ipsum dolor sit amet '.repeat(12),
    '',
  ].join('\n'));
  // Second markdown document: switching md -> md must re-render cleanly.
  fs.writeFileSync(path.join(root, 'NOTES.md'), [
    '# Notes',
    '',
    'Second document ' + longTok('notes') + ' body text.',
    '',
  ].join('\n'));

  const server = new TestSshServer({ root });
  const info = await server.start(0);
  const echo = await startEchoServer();

  const jumpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-smoke-jump-'));
  const jumpServer = new TestSshServer({ root: jumpRoot });
  const jumpInfo = await jumpServer.start(0);

  // Point the importer at a fixture so the smoke test never touches the real
  // user's ~/.ssh/config.
  const sshConfigFile = path.join(userData, 'ssh-config-fixture');
  fs.writeFileSync(sshConfigFile, [
    'Host smoke-jump',
    `  HostName ${jumpInfo.host}`,
    `  User ${jumpInfo.username}`,
    `  Port ${jumpInfo.port}`,
    '',
    'Host smoke-target',
    `  HostName ${info.host}`,
    `  User ${info.username}`,
    `  Port ${info.port}`,
    '  ProxyJump smoke-jump',
    `  LocalForward 0 127.0.0.1:${echo.port}`,
    '',
  ].join('\n'));
  process.env.SRS_SSH_CONFIG = sshConfigFile;

  const store = new Store(userData, { cipher: null });
  const manager = new RemoteManager({ store, hostKeyPolicy: 'accept' });
  let win = null;
  registerIpc({ manager, store, getWindow: () => win });

  const consoleErrors = [];
  win = new BrowserWindow({
    width: 1280, height: 820, show: true, backgroundColor: '#1b1c20',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
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
  // Layout is persisted in localStorage, which Electron shares with the real
  // app profile; reset it so this smoke run is deterministic.
  await exec(`(() => {
    ['srs.sidebarWidth','srs.treeWidth','srs.sidebarCollapsed','srs.treeCollapsed'].forEach((k) => localStorage.removeItem(k));
    App.layout.state.sidebar = 264; App.layout.state.tree = 300;
    App.layout.state.sidebarCollapsed = false; App.layout.state.treeCollapsed = false;
    App.layout.apply();
  })()`);
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

  // ---- saving over an out-of-band edit must prompt, not clobber ----
  await exec(`App.files.openFile({path:'/hello.txt',name:'hello.txt',type:'file'})`);
  await sleep(150);
  fs.writeFileSync(path.join(root, 'hello.txt'), 'changed by someone else\n');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(root, 'hello.txt'), later, later);
  await exec('void App.files.save()'); // resolves only after the user answers
  await sleep(300);
  check('conflicting save opens a prompt', await exec(`!document.getElementById('modal-overlay').hidden && document.getElementById('modal').textContent.includes(t('files.conflict.title'))`));
  await exec(`document.getElementById('modal-overlay').click()`);
  await sleep(150);
  check('cancelled conflict leaves the remote file untouched', await exec(`window.api.fs.read('${connId}','/hello.txt').then(d=>d.content.includes('changed by someone else'))`));

  // ---- connection form exposes credential clearing + host key policy ----
  await exec(`App.connections.openForm(App.state.connections.find(c=>c.id==='${connId}'))`);
  await sleep(200);
  check('edit form offers "clear saved password"', await exec(`Array.from(document.querySelectorAll('#modal .check-row')).some(n => n.textContent.includes(t('conn.clearPassword')))`));
  check('edit form offers host key policy', await exec(`!!document.querySelector('#modal select')`));
  await exec(`document.getElementById('modal-overlay').click()`);

  // ---- binding a forward beyond loopback warns about exposure ----
  await exec(`App.ports.openForm()`);
  await sleep(200);
  await exec(`(() => { const i = document.querySelectorAll('#modal input')[0]; i.value = '0.0.0.0'; i.dispatchEvent(new Event('input')); })()`);
  await sleep(100);
  check('non-loopback listen address warns', await exec(`Array.from(document.querySelectorAll('#modal .field-hint.warn')).some(n => !n.hidden)`));
  await exec(`document.getElementById('modal-overlay').click()`);

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

  // ---- import from ~/.ssh/config (fixture) ----
  await exec(`App.connections.importFromSshConfig()`);
  await sleep(300);
  check('ssh config import lists fixture hosts', await exec(`document.querySelectorAll('#modal .sshconfig-row').length === 2`));
  await shot('screenshot-sshconfig.png');
  await exec(`(() => { const b = document.querySelector('#modal .modal-foot button.primary'); b.click(); })()`);
  await sleep(600);
  check('ssh config import creates profiles', await exec(`App.state.connections.some(c=>c.name==='smoke-target') && App.state.connections.some(c=>c.name==='smoke-jump')`));
  check('imported target keeps jump host', await exec(`(() => { const c=App.state.connections.find(x=>x.name==='smoke-target'); return c && Array.isArray(c.jump) && c.jump.length===1; })()`));

  const importedId = await exec(`App.state.connections.find(c=>c.name==='smoke-target').id`);
  await exec(`(async()=>{
    const c = App.state.connections.find(x=>x.name==='smoke-target');
    const jump = (c.jump||[]).map(h=>({host:h.host,port:h.port,username:h.username,authType:'password',password:'testpass'}));
    await window.api.connections.save({id:c.id,name:c.name,host:c.host,port:c.port,username:c.username,authType:'password',password:'testpass',jump,hostKeyPolicy:'tofu'});
    await App.connections.refresh();
    await App.connections.connect(c.id);
  })()`);
  await sleep(900);
  check('imported profile connects through ProxyJump', await exec(`App.state.sessions['${importedId}'] && App.state.sessions['${importedId}'].state==='connected'`));
  check('imported forward restored after connect', await exec(`window.api.forward.list('${importedId}').then(l => l.length >= 1 && l[0].status === 'active')`));
  check('imported profile reaches target files', await exec(`Array.from(document.querySelectorAll('#tree .tname')).some(n=>n.textContent==='hello.txt')`));

  // ---- per-connection home directory ----
  const homeId = await exec(`(async()=>{
    const s = await window.api.connections.save({ host:'${info.host}', port:${info.port}, username:'${info.username}', password:'${info.password}', name:'home-host', homeDir:'/project' });
    await App.connections.refresh();
    await App.connections.connect(s.id);
    return s.id;
  })()`);
  await sleep(600);
  check('configured home directory is used', await exec(`App.state.cwd === '/project'`));
  check('configured home directory lists its files', await exec(`Array.from(document.querySelectorAll('#tree .tname')).some(n=>n.textContent==='app.js')`));
  await exec(`App.files.navigate('/')`);
  await sleep(300);
  await exec(`document.getElementById('btn-home').click()`);
  await sleep(500);
  check('home button returns to configured home', await exec(`App.state.cwd === '/project'`));
  await exec(`App.connections.onItemClick('${importedId}')`);
  await sleep(500);

  // ---- Markdown preview, including a relative image loaded over SFTP ----
  await exec(`document.querySelector('.tab[data-tab="files"]').click()`);
  await exec(`App.files.openFile({path:'/README.md',name:'README.md',type:'file'})`);
  await sleep(700);
  check('markdown preview opens by default', await exec(`!document.getElementById('markdown-preview').hidden && document.getElementById('editor-wrap').hidden`));
  check('markdown heading rendered with anchor id', await exec(`(() => { const h = document.querySelector('#markdown-preview h1'); return !!h && h.id === 'preview' && h.textContent === 'Preview#'; })()`));
  check('markdown image resolved to data URL', await exec(`(() => { const i = document.querySelector('#markdown-preview img.md-img'); return i && i.src.startsWith('data:image/png;base64,'); })()`));
  check('markdown image is keyboard reachable', await exec(`(() => { const i = document.querySelector('#markdown-preview img.md-img'); return i.getAttribute('role') === 'button' && i.getAttribute('tabindex') === '0'; })()`));
  check('preview text is selectable', await exec(`getComputedStyle(document.getElementById('markdown-preview')).userSelect === 'text'`));
  check('repeated headings get unique ids', await exec(`(() => { const ids = Array.from(document.querySelectorAll('#markdown-preview h1, #markdown-preview h2')).map((h) => h.id); return ids.join(',') === 'preview,preview-1,end'; })()`));
  check('code block has language label and copy button', await exec(`(() => { const b = document.querySelector('#markdown-preview .md-code-copy'); return !!b && document.querySelector('#markdown-preview .md-code-lang').textContent === 'js' && b.querySelector('use').getAttribute('href') === '#i-copy'; })()`));
  check('preview emits no inline event handlers', await exec(`!document.querySelector('#markdown-preview [onclick], #markdown-preview [onload], #markdown-preview [onerror], #markdown-preview [onmouseover]')`));
  check('table scrolls horizontally with alignment classes', await exec(`(() => { const w = document.querySelector('#markdown-preview .md-table-wrap'); const t = w && w.querySelector('table.md-table'); return !!t && getComputedStyle(w).overflowX === 'auto' && !!t.querySelector('th.ta-left') && !!t.querySelector('th.ta-center') && !!t.querySelector('th.ta-right') && t.scrollWidth > w.clientWidth; })()`));
  check('task list rendered as checkboxes', await exec(`document.querySelectorAll('#markdown-preview li input[type="checkbox"]').length === 2`));

  // Copy button: a real click must give feedback either way — the clipboard
  // can legitimately refuse an unfocused window, which is a toast, not a bug.
  console.log('markdown env:', await exec(`JSON.stringify({ hidden: document.hidden, hasFocus: document.hasFocus(), scrollHeight: document.getElementById('markdown-preview').scrollHeight })`));
  await exec(`document.querySelector('#markdown-preview .md-code-copy').click()`);
  await sleep(400);
  check('code copy click reports success or a graceful failure', await exec(`(() => { const b = document.querySelector('#markdown-preview .md-code-copy'); const failed = Array.from(document.querySelectorAll('#toasts .toast')).some((x) => x.textContent.includes(t('md.copyFailed'))); return b.classList.contains('copied') || failed; })()`));
  check('copied label is localized', await exec(`(() => { const b = document.querySelector('#markdown-preview .md-code-copy'); const ok = b.classList.contains('copied'); return !ok || (b.querySelector('span').textContent === t('md.copied') && b.querySelector('use').getAttribute('href') === '#i-check'); })()`));
  // The 1.6s reset runs on a timer Chromium throttles for a hidden window, so
  // only the "already reset" branch is asserted here; the deterministic reset
  // path (re-render) is checked next.
  const copyReset = await exec(`(async () => {
    const b = document.querySelector('#markdown-preview .md-code-copy');
    for (let i = 0; i < 25; i++) { if (!b.classList.contains('copied')) break; await new Promise((r) => setTimeout(r, 120)); }
    return {
      copied: b.classList.contains('copied'),
      hidden: document.hidden,
      restored: b.querySelector('span').textContent === t('md.copy') && b.querySelector('use').getAttribute('href') === '#i-copy',
    };
  })()`);
  check('copy feedback clears itself', copyReset.restored || copyReset.hidden);
  await exec(`App.files.renderMarkdownPreview()`);
  await sleep(200);
  check('re-render rebuilds the button in its clean state', await exec(`(() => { const b = document.querySelector('#markdown-preview .md-code-copy'); return !b.classList.contains('copied') && b.querySelector('span').textContent === t('md.copy') && b.querySelector('use').getAttribute('href') === '#i-copy'; })()`));
  await exec(`document.querySelector('#markdown-preview .md-code-copy').click()`);
  await sleep(400);
  check('copy stays wired after a re-render (delegated listener)', await exec(`(() => { const b = document.querySelector('#markdown-preview .md-code-copy'); return b.classList.contains('copied') || Array.from(document.querySelectorAll('#toasts .toast')).some((x) => x.textContent.includes(t('md.copyFailed'))); })()`));
  await exec(`App.files.renderMarkdownPreview()`);
  await sleep(200);

  // Anchor jump: scroll to the bottom, click the first heading's anchor and
  // require both the hash and the scroll position to follow.
  const anchor = await exec(`(async () => {
    const box = document.getElementById('markdown-preview');
    box.scrollTop = box.scrollHeight;
    const from = Math.round(box.scrollTop);
    const a = document.querySelector('#markdown-preview .md-anchor[href="#preview"]');
    if (!a) return { found: false, from };
    a.click();
    // The smooth-scroll animation is paused while the window is hidden, so in
    // that case jump to the very same target instantly to prove the wiring.
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (document.hidden && target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
    for (let i = 0; i < 25; i++) { if (box.scrollTop < 12) break; await new Promise((r) => setTimeout(r, 60)); }
    return { found: true, from, to: Math.round(box.scrollTop), hash: location.hash };
  })()`);
  // The first heading settles scroll-margin-top below the pane top, so "back
  // to the top" is a handful of pixels rather than literally zero.
  check('heading anchor scrolls back to the top and records the hash', anchor.found && anchor.hash === '#preview' && anchor.to < 12 && anchor.from - anchor.to > 200);

  // Lightbox: click, Esc, focus handling, backdrop click, keyboard open.
  const imgReady = await exec(`(async () => {
    for (let i = 0; i < 40; i++) { const im = document.querySelector('#markdown-preview img.md-img'); if (im && im.getAttribute('src')) return true; await new Promise((r) => setTimeout(r, 50)); }
    return false;
  })()`);
  check('relative image resolves again after a re-render', imgReady);
  await exec(`document.querySelector('#markdown-preview img.md-img').click()`);
  await sleep(200);
  check('image click opens the lightbox', await exec(`(() => { const lb = document.getElementById('md-lightbox'); const big = document.getElementById('md-lightbox-img'); return !lb.hidden && big.getAttribute('src').startsWith('data:image/png;base64,'); })()`));
  check('lightbox is a labelled dialog that takes focus', await exec(`(() => { const lb = document.getElementById('md-lightbox'); return lb.getAttribute('role') === 'dialog' && lb.getAttribute('aria-modal') === 'true' && !!lb.getAttribute('aria-label') && document.activeElement === document.getElementById('md-lightbox-close'); })()`));
  const lbGeom = await exec(`(() => {
    const lb = document.getElementById('md-lightbox');
    const r = lb.getBoundingClientRect(), cs = getComputedStyle(lb);
    const big = document.getElementById('md-lightbox-img').getBoundingClientRect();
    const corner = document.elementFromPoint(8, window.innerHeight - 8);
    return {
      layer: [Math.round(r.width), Math.round(r.height)], viewport: [window.innerWidth, window.innerHeight],
      display: cs.display, position: cs.position, zIndex: cs.zIndex,
      image: [Math.round(big.width), Math.round(big.height)],
      topAtCorner: corner ? (corner.id || corner.className) : null,
    };
  })()`);
  console.log('lightbox geom:', JSON.stringify(lbGeom));
  check('lightbox layer covers the viewport and paints above the app',
    lbGeom.display === 'flex' && lbGeom.position === 'fixed'
    && Math.abs(lbGeom.layer[0] - lbGeom.viewport[0]) <= 1 && Math.abs(lbGeom.layer[1] - lbGeom.viewport[1]) <= 1
    && Number(lbGeom.zIndex) >= 1000 && lbGeom.topAtCorner === 'md-lightbox'
    && lbGeom.image[0] > 0 && lbGeom.image[1] > 0);
  await shot('screenshot-markdown-lightbox.png');
  await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  check('Esc closes the lightbox, drops the image and restores focus', await exec(`(() => { const lb = document.getElementById('md-lightbox'); const img = document.querySelector('#markdown-preview img.md-img'); return lb.hidden && !document.getElementById('md-lightbox-img').getAttribute('src') && document.activeElement === img; })()`));
  await exec(`(() => { const i = document.querySelector('#markdown-preview img.md-img'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(200);
  check('Enter on a focused image opens the lightbox', await exec(`!document.getElementById('md-lightbox').hidden`));
  check('Tab keeps the focus inside the zoom dialog', await exec(`(() => {
    const btn = document.getElementById('md-lightbox-close');
    btn.blur();
    document.getElementById('md-lightbox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    return document.activeElement === btn;
  })()`));
  await exec(`document.getElementById('md-lightbox').click()`);
  await sleep(200);
  check('backdrop click closes the lightbox', await exec(`document.getElementById('md-lightbox').hidden`));
  await exec(`document.querySelector('#markdown-preview img.md-img').click()`);
  await sleep(150);
  await exec(`document.getElementById('md-lightbox-close').click()`);
  await sleep(150);
  check('close button dismisses the lightbox', await exec(`(() => { const lb = document.getElementById('md-lightbox'); return lb.hidden && document.activeElement === document.querySelector('#markdown-preview img.md-img'); })()`));
  await exec(`document.getElementById('markdown-preview').scrollTop = 0`);
  await shot('screenshot-markdown.png');
  // The blocks view (table + code card) is where the reading layer is visible,
  // so it is captured once per theme below; keep it scrolled there.
  await exec(`document.querySelector('#markdown-preview .md-code').scrollIntoView({ block: 'start' })`);
  await sleep(300);
  await shot('screenshot-markdown-blocks.png');

  // i18n coverage for the new strings, in both languages.
  await exec(`App.setLang('en')`);
  await sleep(200);
  check('preview strings localized (EN)', await exec(`(() => {
    const b = document.querySelector('#markdown-preview .md-code-copy');
    const lb = document.getElementById('md-lightbox');
    return b.querySelector('span').textContent === 'Copy' && b.title === 'Copy' && b.getAttribute('aria-label') === 'Copy'
      && t('md.copied') === 'Copied' && t('md.copyFailed').indexOf('Copy failed') === 0
      && lb.getAttribute('aria-label') === 'Image preview' && document.getElementById('md-lightbox-close').getAttribute('aria-label') === 'Close'
      && document.querySelector('#markdown-preview img.md-img').getAttribute('aria-label') === 'Zoom image';
  })()`));
  await exec(`App.setLang('zh')`);
  await sleep(200);
  check('preview strings localized (ZH)', await exec(`(() => {
    const b = document.querySelector('#markdown-preview .md-code-copy');
    return b.querySelector('span').textContent === '复制' && b.title === '复制' && b.getAttribute('aria-label') === '复制'
      && t('md.copied') === '已复制' && document.getElementById('md-lightbox-close').getAttribute('aria-label') === '关闭'
      && document.querySelector('#markdown-preview img.md-img').getAttribute('aria-label') === '放大图片';
  })()`));

  // All four themes must keep the reading layer legible; the light/dark pair
  // is captured for visual review.
  for (const theme of ['midnight', 'daylight', 'phosphor', 'nebula']) {
    await exec(`App.setTheme('${theme}')`);
    await sleep(240);
    const colors = await exec(`(() => {
      const card = getComputedStyle(document.querySelector('#markdown-preview .md-code'));
      const text = getComputedStyle(document.querySelector('#markdown-preview .md-code pre code'));
      const head = getComputedStyle(document.querySelector('#markdown-preview .md-code-head'));
      return { card: card.backgroundColor, code: text.color, head: head.backgroundColor };
    })()`);
    check(`markdown code block legible in the ${theme} theme`, !!colors.card && !!colors.code && colors.card !== colors.code && colors.head !== colors.code);
    if (theme === 'daylight' || theme === 'phosphor') await shot('screenshot-markdown-' + theme + '.png');
  }
  await exec(`App.setTheme('midnight')`);
  await sleep(240);

  await exec(`document.getElementById('btn-md-mode').click()`);
  await sleep(200);
  check('markdown edit toggle shows textarea', await exec(`!document.getElementById('editor-wrap').hidden && document.getElementById('markdown-preview').hidden`));
  await exec(`document.getElementById('btn-md-mode').click()`);
  await sleep(500);
  check('markdown preview toggles back', await exec(`!document.getElementById('markdown-preview').hidden && document.getElementById('markdown-preview').textContent.includes('bold')`));
  // A zoom layer must never outlive the view it belongs to.
  await exec(`document.querySelector('#markdown-preview img.md-img').click()`);
  await sleep(200);
  await exec(`document.getElementById('btn-md-mode').click()`);
  await sleep(200);
  check('switching to the editor closes an open lightbox', await exec(`document.getElementById('md-lightbox').hidden`));
  await exec(`document.getElementById('btn-md-mode').click()`);
  await sleep(400);
  await exec(`document.querySelector('#markdown-preview img.md-img').click()`);
  await sleep(150);
  await exec(`App.files.closeEditor()`);
  check('closing the file closes an open lightbox', await exec(`document.getElementById('md-lightbox').hidden`));

  // ---- D-1: unbreakable tokens must wrap, never push the pane sideways ----
  // The window is narrowed to ~965x700: at that size the reading column is far
  // shorter than every fixture token, so a missing overflow-wrap shows up
  // immediately as a horizontally scrolling #markdown-preview.
  await exec(`App.files.openFile({path:'/README.md',name:'README.md',type:'file'})`);
  await sleep(700);
  win.setBounds({ width: 965, height: 700 });
  await sleep(600);
  const narrow = await exec(`(() => {
    const box = document.getElementById('markdown-preview');
    const tok = /\\S{100,}/;
    // Only an element that actually holds an unbreakable token can prove the
    // wrapping rule, so pick the right one per context instead of the first.
    const pick = (sel) => Array.from(box.querySelectorAll(sel)).find((el) => tok.test(el.textContent || ''));
    const over = (el) => (el ? Math.round(el.scrollWidth - el.clientWidth) : -1);
    const cs = (el) => (el ? getComputedStyle(el).overflowWrap : 'missing');
    const pre = box.querySelector('.md-code pre');
    const wrap = box.querySelector('.md-table-wrap');
    return {
      paneClient: Math.round(box.clientWidth),
      paneScroll: Math.round(box.scrollWidth),
      paneOverflow: over(box),
      h3: over(pick('h3')),
      p: over(pick('p')),
      li: over(pick('li')),
      blockquote: over(pick('blockquote')),
      linkWrap: cs(pick('a')),
      inlineCodeWrap: cs(pick('p code')),
      preOverflow: over(pre),
      preWrap: cs(pre),
      preCodeWrap: cs(pre.querySelector('code')),
      preWhite: getComputedStyle(pre).whiteSpace,
      tableOverflow: over(wrap),
    };
  })()`);
  console.log('narrow wrap:', JSON.stringify(narrow));
  check('narrow pane does not scroll sideways on unbreakable tokens',
    narrow.paneOverflow <= 1 && narrow.paneScroll <= narrow.paneClient + 1);
  check('headings, paragraphs, lists and quotes wrap in the narrow pane',
    narrow.h3 <= 1 && narrow.p <= 1 && narrow.li <= 1 && narrow.blockquote <= 1);
  check('links and inline code use the same wrapping rule',
    narrow.linkWrap === 'anywhere' && narrow.inlineCodeWrap === 'anywhere');
  check('fenced code keeps its own horizontal scroll',
    narrow.preOverflow > 1 && narrow.preWrap === 'normal' && narrow.preCodeWrap === 'normal' && narrow.preWhite === 'pre');
  check('tables keep their own horizontal scroll in the narrow pane', narrow.tableOverflow > 1);
  await exec(`document.querySelector('#markdown-preview h3').scrollIntoView({ block: 'start' })`);
  await sleep(250);
  await shot('screenshot-markdown-narrow.png');
  win.setBounds({ width: 1280, height: 820 });
  await sleep(600);

  // ---- D-2: opening another file must drop the previous preview tree ----
  const stale = await exec(`(() => {
    const box = document.getElementById('markdown-preview');
    const img = box.querySelector('img.md-img');
    return { nodes: box.querySelectorAll('*').length, bytes: box.innerHTML.length,
      token: App.files._mdToken, imgBytes: img && img.getAttribute('src') ? img.getAttribute('src').length : 0 };
  })()`);
  await exec(`document.querySelector('#markdown-preview img.md-img').click()`);
  await sleep(200);
  await exec(`App.files.openFile({path:'/hello.txt',name:'hello.txt',type:'file'})`);
  await sleep(700);
  const clean = await exec(`(() => {
    const box = document.getElementById('markdown-preview');
    const lb = document.getElementById('md-lightbox');
    return { nodes: box.querySelectorAll('*').length, bytes: box.innerHTML.length,
      token: App.files._mdToken, hidden: box.hidden,
      lbHidden: lb.hidden, lbSrc: document.getElementById('md-lightbox-img').getAttribute('src') || '',
      // hello.txt is rewritten by the conflict test above, so compare against
      // the state the open actually produced rather than a hard-coded string.
      openPath: App.state.openFile.path,
      editorMatches: document.getElementById('editor').value === App.state.openFile.content,
      markdown: App.state.openFile.markdown, editorHidden: document.getElementById('editor-wrap').hidden };
  })()`);
  console.log('preview residue:', JSON.stringify({ stale, clean }));
  check('the markdown preview really held image bytes before the switch', stale.bytes > 10000 && stale.imgBytes > 10000);
  check('opening a text file drops the old markdown preview', clean.nodes === 0 && clean.bytes === 0);
  check('opening a text file invalidates in-flight preview images', clean.token > stale.token);
  check('opening a text file closes a stale lightbox', clean.lbHidden && clean.lbSrc === '');
  check('the text file opens normally with the preview hidden',
    clean.openPath === '/hello.txt' && clean.editorMatches && !clean.markdown && clean.hidden && !clean.editorHidden);
  await exec(`App.files.openFile({path:'/NOTES.md',name:'NOTES.md',type:'file'})`);
  await sleep(700);
  const second = await exec(`(() => {
    const box = document.getElementById('markdown-preview');
    return { nodes: box.querySelectorAll('*').length, h1: (box.querySelector('h1') || {}).id || '',
      text: box.textContent, oldImg: !!box.querySelector('img.md-img'),
      lbHidden: document.getElementById('md-lightbox').hidden,
      lbSrc: document.getElementById('md-lightbox-img').getAttribute('src') || '' };
  })()`);
  check('switching to another markdown file re-renders it', second.nodes > 0 && second.h1 === 'notes' && second.text.includes('Second document'));
  check('markdown -> markdown leaves no image or lightbox residue', !second.oldImg && second.lbHidden && second.lbSrc === '');
  // The cleanup deliberately runs only after the read succeeded: a failed open
  // must leave the previous document on screen, not blank the pane.
  await exec(`App.files.openFile({path:'/README.md',name:'README.md',type:'file'})`);
  await sleep(700);
  const keep = await exec(`document.getElementById('markdown-preview').querySelectorAll('*').length`);
  await exec(`App.files.openFile({path:'/missing.md',name:'missing.md',type:'file'})`);
  await sleep(500);
  const afterFail = await exec(`(() => {
    const box = document.getElementById('markdown-preview');
    return { nodes: box.querySelectorAll('*').length, path: App.state.openFile.path, hidden: box.hidden };
  })()`);
  check('a failed open keeps the previous preview intact',
    keep > 0 && afterFail.nodes === keep && afterFail.path === "/README.md" && !afterFail.hidden);
  await exec(`App.files.closeEditor()`);
  await sleep(200);
  check('closing an editor empties the preview too', await exec(`document.getElementById('markdown-preview').querySelectorAll('*').length === 0`));

  // ---- panels minimize/restore and resize ----
  const waitWidth = (id, expected) => exec(`new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const w = Math.round(document.getElementById('${id}').getBoundingClientRect().width);
      if (w === ${expected} || ++n > 30) resolve(w);
      else setTimeout(tick, 50);
    };
    tick();
  })`);
  await exec(`document.getElementById('btn-collapse-sidebar').click()`);
  check('sidebar minimizes', await exec(`document.getElementById('sidebar').hidden && document.getElementById('btn-toggle-sidebar').classList.contains('active')`));
  await sleep(250);
  await shot('screenshot-sidebar-min.png');
  await exec(`document.getElementById('btn-toggle-sidebar').click()`);
  check('sidebar restores', await exec(`!document.getElementById('sidebar').hidden`));
  await exec(`App.layout.setSidebarWidth(320)`);
  check('sidebar width resizes', (await waitWidth('sidebar', 320)) === 320);
  check('sidebar drag resize updates width', await exec(`(() => {
    const h = document.getElementById('sidebar-resizer');
    const start = App.layout.state.sidebar;
    h.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 320, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 360, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 360, pointerId: 1, bubbles: true }));
    return App.layout.state.sidebar === start + 40 && localStorage.getItem('srs.sidebarWidth') === String(start + 40);
  })()`));
  await exec(`document.getElementById('btn-toggle-tree').click()`);
  check('file tree minimizes', await exec(`document.getElementById('tree-pane').hidden && document.getElementById('tree-resizer').hidden`));
  await exec(`document.getElementById('btn-toggle-tree').click()`);
  check('file tree restores', await exec(`!document.getElementById('tree-pane').hidden && !document.getElementById('tree-resizer').hidden`));
  await exec(`App.layout.setTreeWidth(260)`);
  check('file tree width resizes', (await waitWidth('tree-pane', 260)) === 260);

  // ---- with auto-start off, saved forwards remain visible and startable ----
  await exec(`window.api.settings.set('restoreForwards', false)`);
  await exec(`window.api.session.disconnect('${importedId}')`);
  await sleep(300);
  await exec(`App.connections.connect('${importedId}')`);
  await sleep(900);
  check('saved forward stays visible when auto-start is off', await exec(`window.api.forward.list('${importedId}').then(l => l.length >= 1 && l.every(f => f.status !== 'active'))`));
  check('disconnected saved forward offers manual start', await exec(`document.querySelectorAll('#ports-body tr').length >= 1 && document.querySelectorAll('#ports-body tr .fwd-actions .ghost').length >= 2 && !document.querySelector('#ports-body tr .status-pill.active')`));
  await exec(`window.api.settings.set('restoreForwards', true)`);

  check('no renderer console errors', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('CONSOLE ERRORS:\n' + consoleErrors.join('\n'));

  await manager.destroy();
  echo.server.close();
  await server.stop();
  await jumpServer.stop();
  try {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(jumpRoot, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {}

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((e) => {
  console.error('SMOKE FATAL:', e);
  app.exit(1);
});
