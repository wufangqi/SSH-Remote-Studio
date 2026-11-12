'use strict';
// Secure bridge between the sandboxed renderer and the main process.
// contextIsolation is on; the renderer only sees `window.api`.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok === false) {
    const err = new Error(res.error ? res.error.message : '未知错误');
    err.code = res.error ? res.error.code : null;
    throw err;
  }
  return res ? res.data : null;
}

const EVENT_NAMES = [
  'state', 'session-error', 'close', 'ready',
  'hostkey-new', 'hostkey-mismatch',
  'forward-added', 'forward-removed', 'forward-error', 'forward-changed',
  'menu-new-connection',
];

const api = {
  connections: {
    list: () => call('connections:list'),
    save: (conn) => call('connections:save', conn),
    delete: (id) => call('connections:delete', id),
  },
  session: {
    connect: (configOrId) => call('session:connect', configOrId),
    disconnect: (id) => call('session:disconnect', id),
    status: () => call('session:status'),
  },
  fs: {
    home: (id) => call('fs:home', id),
    realpath: (id, p) => call('fs:realpath', id, p),
    list: (id, p) => call('fs:list', id, p),
    stat: (id, p) => call('fs:stat', id, p),
    read: (id, p, opts) => call('fs:read', id, p, opts),
    write: (id, p, content, opts) => call('fs:write', id, p, content, opts),
    mkdir: (id, p, opts) => call('fs:mkdir', id, p, opts),
    rename: (id, oldP, newP) => call('fs:rename', id, oldP, newP),
    remove: (id, p, opts) => call('fs:remove', id, p, opts),
    upload: (id, local, remote) => call('fs:upload', id, local, remote),
    download: (id, remote, local) => call('fs:download', id, remote, local),
  },
  exec: (id, cmd) => call('exec', id, cmd),
  forward: {
    add: (id, def) => call('forward:add', id, def),
    stop: (id, fid) => call('forward:stop', id, fid),
    list: (id) => call('forward:list', id),
  },
  settings: {
    get: (key, def) => call('settings:get', key, def),
    set: (key, val) => call('settings:set', key, val),
  },
  dialog: {
    openFile: (opts) => call('dialog:openFile', opts),
    openDirectory: (opts) => call('dialog:openDirectory', opts),
    saveFile: (opts) => call('dialog:saveFile', opts),
  },
  app: {
    info: () => call('app:info'),
  },
  // Subscribe to a main-process event. Returns an unsubscribe function.
  on: (name, cb) => {
    if (!EVENT_NAMES.includes(name)) throw new Error('未知事件: ' + name);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('event:' + name, listener);
    return () => ipcRenderer.removeListener('event:' + name, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
