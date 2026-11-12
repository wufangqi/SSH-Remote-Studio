'use strict';
// IPC bridge: thin handlers over RemoteManager/Store + dialogs, and pushes
// manager events to the renderer. All request handlers return {ok,data|error}
// so error codes survive Electron's serialization.
const { ipcMain, dialog } = require('electron');

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(...args, event);
      return { ok: true, data: data === undefined ? null : data };
    } catch (e) {
      return { ok: false, error: { message: e.friendly || e.message || String(e), code: e.code || null } };
    }
  });
}

function registerIpc({ manager, store, getWindow }) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // ---- manager events -> renderer ----
  manager.on('state', (p) => send('event:state', p));
  manager.on('session-error', (p) => send('event:session-error', p));
  manager.on('close', (p) => send('event:close', p));
  manager.on('ready', (p) => send('event:ready', p));
  manager.on('hostkey-new', (p) => send('event:hostkey-new', p));
  manager.on('hostkey-mismatch', (p) => send('event:hostkey-mismatch', p));
  manager.on('forward-added', (p) => send('event:forward-added', p));
  manager.on('forward-removed', (p) => send('event:forward-removed', p));
  manager.on('forward-error', (p) => send('event:forward-error', p));
  manager.on('forward-changed', (p) => send('event:forward-changed', p));

  // ---- connections ----
  handle('connections:list', () => manager.listConnections());
  handle('connections:save', (conn) => manager.saveConnection(conn));
  handle('connections:delete', (id) => manager.deleteConnection(id));

  // ---- sessions ----
  handle('session:connect', (configOrId) => manager.connect(configOrId));
  handle('session:disconnect', (id) => manager.disconnect(id));
  handle('session:status', () => manager.status());

  // ---- filesystem ----
  handle('fs:home', (id) => manager.home(id));
  handle('fs:realpath', (id, p) => manager.realpath(id, p));
  handle('fs:list', (id, p) => manager.list(id, p));
  handle('fs:stat', (id, p) => manager.stat(id, p));
  handle('fs:read', (id, p, opts) => manager.readFile(id, p, opts));
  handle('fs:write', (id, p, content, opts) => manager.writeFile(id, p, content, opts));
  handle('fs:mkdir', (id, p, opts) => manager.mkdir(id, p, opts));
  handle('fs:rename', (id, oldP, newP) => manager.rename(id, oldP, newP));
  handle('fs:remove', (id, p, opts) => manager.remove(id, p, opts));
  handle('fs:upload', (id, local, remote) => manager.upload(id, local, remote));
  handle('fs:download', (id, remote, local) => manager.download(id, remote, local));
  handle('exec', (id, cmd) => manager.exec(id, cmd));

  // ---- forwarding ----
  handle('forward:add', (id, def) => manager.addForward(id, def));
  handle('forward:stop', (id, fid) => manager.stopForward(id, fid));
  handle('forward:list', (id) => manager.listForwards(id));

  // ---- settings ----
  handle('settings:get', (key, def) => store.getSetting(key, def));
  handle('settings:set', (key, val) => store.setSetting(key, val));

  // ---- dialogs ----
  handle('dialog:openFile', async (opts = {}) => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || '选择文件',
      properties: ['openFile'],
      filters: opts.filters || [],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('dialog:openDirectory', async (opts = {}) => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('dialog:saveFile', async (opts = {}) => {
    const win = getWindow();
    const res = await dialog.showSaveDialog(win, {
      title: opts.title || '保存文件',
      defaultPath: opts.defaultName || 'download',
      filters: opts.filters || [],
    });
    return res.canceled ? null : res.filePath;
  });

  // ---- app info ----
  handle('app:info', async () => {
    const { encryptionAvailable } = require('./safe-storage');
    return {
      version: require('electron').app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      encryptionAvailable: await encryptionAvailable(),
    };
  });
}

module.exports = { registerIpc };
