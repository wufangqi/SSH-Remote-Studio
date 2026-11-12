'use strict';
// Renderer bootstrap: wire DOM events, tab routing, shortcuts and main-process
// event subscriptions. Loaded last.
(function () {
  const api = window.api;

  function switchTab(name) {
    $all('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('#view-files').hidden = name !== 'files';
    $('#view-ports').hidden = name !== 'ports';
    if (name === 'ports') App.ports.refresh();
  }
  $all('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // sidebar / welcome
  $('#btn-add-conn').addEventListener('click', () => App.connections.openForm());
  $('#btn-welcome-add').addEventListener('click', () => App.connections.openForm());
  $('#btn-disconnect').addEventListener('click', () => {
    if (App.state.activeId) App.connections.disconnect(App.state.activeId);
  });

  // files toolbar
  $('#btn-home').addEventListener('click', async () => {
    const h = await api.fs.home(App.state.activeId);
    App.files.navigate(h);
  });
  $('#btn-up').addEventListener('click', () => App.files.navigate(App.files.dirname(App.state.cwd || '/')));
  $('#btn-refresh').addEventListener('click', () => App.files.loadRoot());
  $('#path-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') App.files.navigate(e.target.value); });
  $('#btn-new-file').addEventListener('click', () => App.files.newFile());
  $('#btn-new-dir').addEventListener('click', () => App.files.newDir());
  $('#btn-upload').addEventListener('click', () => App.files.upload());
  $('#btn-download').addEventListener('click', () => App.files.download());
  $('#btn-rename').addEventListener('click', () => App.files.rename());
  $('#btn-delete').addEventListener('click', () => App.files.remove());

  // editor
  const editor = $('#editor');
  editor.addEventListener('input', () => App.files.onEditorInput());
  editor.addEventListener('scroll', () => { $('#gutter').scrollTop = editor.scrollTop; });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      App.files.onEditorInput();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); App.files.save(); }
  });
  $('#btn-save').addEventListener('click', () => App.files.save());
  $('#btn-close-file').addEventListener('click', async () => {
    const f = App.state.openFile;
    if (f && f.dirty) {
      const ok = await App.confirm({ title: '放弃更改', message: '文件有未保存的更改，确定关闭吗？', danger: true, okLabel: '放弃并关闭' });
      if (!ok) return;
    }
    App.files.closeEditor();
  });

  // ports
  $('#btn-add-forward').addEventListener('click', () => App.ports.openForm());
  $('#btn-add-forward-empty').addEventListener('click', () => App.ports.openForm());
  $('#btn-refresh-ports').addEventListener('click', () => App.ports.refresh());

  // global shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); App.connections.openForm(); }
  });

  // main-process events
  api.on('state', ({ id, state }) => App.connections.setState(id, state));
  api.on('ready', ({ id }) => App.connections.setState(id, 'connected'));
  api.on('close', ({ id }) => {
    App.connections.setState(id, 'disconnected');
    if (App.state.activeId === id) App.toast('SSH 连接已关闭', { type: 'warn', title: '连接' });
  });
  api.on('session-error', ({ error }) => App.toast(error.message, { type: 'error', title: '会话错误' }));
  api.on('hostkey-new', ({ host, port, fingerprint }) => {
    App.toast(`已信任新主机密钥 ${host}:${port}\n${fingerprint}`, { type: 'info', title: '主机密钥 (TOFU)', timeout: 6000 });
  });
  api.on('hostkey-mismatch', ({ host, port }) => {
    App.toast(`主机 ${host}:${port} 的密钥与已记录的不一致，连接已被拒绝。请核实服务器是否被篡改。`, { type: 'error', title: '⚠ 主机密钥警告', timeout: 12000 });
  });
  api.on('forward-added', () => App.ports.refresh());
  api.on('forward-removed', () => App.ports.refresh());
  api.on('forward-changed', () => App.ports.refresh());
  api.on('forward-error', ({ error }) => {
    App.toast((error && error.message) || '转发错误', { type: 'error', title: '转发' });
    App.ports.refresh();
  });
  api.on('menu-new-connection', () => App.connections.openForm());

  async function boot() {
    try {
      App.state.appInfo = await api.app.info();
      $('#app-version').textContent = 'v' + App.state.appInfo.version;
      $('#enc-state').textContent = App.state.appInfo.encryptionAvailable ? '🔒 密钥加密' : '🔓 明文';
      $('#enc-state').title = App.state.appInfo.encryptionAvailable
        ? '密码与私钥口令使用系统加密存储'
        : '当前系统未提供加密存储，密钥以明文保存';
      await App.connections.refresh();
      App.setStatus('就绪');
    } catch (e) {
      App.toast(e.message || String(e), { type: 'error', title: '初始化失败' });
    }
  }
  boot();
})();
