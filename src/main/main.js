'use strict';
const { app, BrowserWindow, Menu, safeStorage, shell } = require('electron');
const path = require('node:path');
const { Store } = require('../core/store');
const { RemoteManager } = require('../core/remote-manager');
const { registerIpc } = require('./ipc');

let win = null;
let manager = null;
let store = null;

// Encrypt secrets at rest when the OS provides it (Windows DPAPI / macOS
// Keychain / Linux libsecret). Falls back to plaintext only when unavailable.
async function buildCipher() {
  const available = safeStorage.isAsyncEncryptionAvailable
    ? await safeStorage.isAsyncEncryptionAvailable()
    : safeStorage.isEncryptionAvailable();
  if (!available) return null;
  return {
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'SSH Remote Studio',
    backgroundColor: '#1b1c20',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // Open external links in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件(&F)',
      submenu: [
        { label: '新建连接', accelerator: 'CmdOrCtrl+N', click: () => win && win.webContents.send('event:menu-new-connection') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '关于 SSH Remote Studio',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于',
              message: 'SSH Remote Studio',
              detail: `版本 ${app.getVersion()}\n通过 SSH 打开远程文件夹并管理端口转发。\n平台: ${process.platform} (${process.arch})`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single-instance: focus the existing window on a second launch.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    store = new Store(userData, { cipher: await buildCipher() });
    manager = new RemoteManager({
      store,
      hostKeyPolicy: store.getSetting('hostKeyPolicy', 'tofu'),
    });
    registerIpc({ manager, store, getWindow: () => win });
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (e) => {
    if (manager) {
      e.preventDefault();
      try { await manager.destroy(); } catch {}
      manager = null;
      app.quit();
    }
  });
}
