'use strict';
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('node:path');
const { Store } = require('../core/store');
const { RemoteManager } = require('../core/remote-manager');
const { registerIpc } = require('./ipc');
const { buildCipher } = require('./safe-storage');

let win = null;
let manager = null;
let store = null;

function uiLang() {
  const saved = store && store.getSetting('ui.lang', null);
  if (saved === 'zh' || saved === 'en') return saved;
  return /^zh/i.test(app.getLocale() || '') ? 'zh' : 'en';
}

const MENU_TEXT = {
  zh: {
    file: '文件(&F)', newConn: '新建连接', quit: '退出',
    view: '视图(&V)', mini: '小窗模式', reload: '重新加载', devtools: '开发者工具',
    actualSize: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '全屏',
    help: '帮助(&H)', about: '关于 SSH Remote Studio', aboutTitle: '关于',
    aboutDetail: (v, p, a) => `版本 ${v}\nSSH 隧道工作台：图形化管理本地/远程/动态转发，隧道可保存、可恢复、可观测。\n平台: ${p} (${a})`,
  },
  en: {
    file: '&File', newConn: 'New Connection', quit: 'Quit',
    view: '&View', mini: 'Mini Mode', reload: 'Reload', devtools: 'Developer Tools',
    actualSize: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Full Screen',
    help: '&Help', about: 'About SSH Remote Studio', aboutTitle: 'About',
    aboutDetail: (v, p, a) => `Version ${v}\nSSH tunnel workspace: manage local, remote and dynamic forwards with persistence, recovery and live traffic.\nPlatform: ${p} (${a})`,
  },
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'SSH Remote Studio',
    backgroundColor: '#0a0e13',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // The renderer is a single local page; it never navigates anywhere.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  // Open external links in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const L = MENU_TEXT[uiLang()];
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: L.file,
      submenu: [
        { label: L.newConn, accelerator: 'CmdOrCtrl+N', click: () => win && win.webContents.send('event:menu-new-connection') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: L.quit },
      ],
    },
    {
      label: L.view,
      submenu: [
        {
          label: L.mini, accelerator: 'CmdOrCtrl+M',
          click: () => win && win.webContents.send('event:menu-toggle-mini'),
        },
        { type: 'separator' },
        { role: 'reload', label: L.reload },
        { role: 'toggleDevTools', label: L.devtools },
        { type: 'separator' },
        { role: 'resetZoom', label: L.actualSize },
        { role: 'zoomIn', label: L.zoomIn },
        { role: 'zoomOut', label: L.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: L.fullscreen },
      ],
    },
    {
      label: L.help,
      submenu: [
        {
          label: L.about,
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(win, {
              type: 'info',
              title: L.aboutTitle,
              message: 'SSH Remote Studio',
              detail: L.aboutDetail(app.getVersion(), process.platform, process.arch),
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
    // Windows: explicit AppUserModelID so the taskbar groups by app, not exe.
    if (process.platform === 'win32') app.setAppUserModelId('com.sshremotestudio.app');
    const userData = app.getPath('userData');
    store = new Store(userData, { cipher: await buildCipher() });
    manager = new RemoteManager({
      store,
      hostKeyPolicy: store.getSetting('hostKeyPolicy', 'tofu'),
    });
    registerIpc({ manager, store, getWindow: () => win, rebuildMenu: () => buildMenu() });
    buildMenu();
    createWindow();

    // Resume the sessions that were connected at last shutdown; each connect
    // also re-establishes its saved port forwards. Failures surface as
    // session-error events (toast) and never block startup.
    for (const id of store.getSetting('activeSessions', [])) {
      manager.connect(id).catch((e) => {
        manager.emit('session-error', { id, error: { message: e.friendly || e.message || String(e), code: e.code || null } });
      });
    }

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
