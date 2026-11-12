'use strict';
// Shared renderer state, DOM helpers, toasts and modals. Classic script;
// everything hangs off window.App. Loaded after i18n.js.

// Apply the cached theme before first paint to avoid a flash; app.js boot
// reconciles with the persisted store setting afterwards.
(function () {
  const THEMES = ['midnight', 'daylight', 'phosphor', 'nebula'];
  let th = 'midnight';
  try {
    const saved = localStorage.getItem('srs.theme');
    if (THEMES.includes(saved)) th = saved;
  } catch { /* storage unavailable */ }
  document.documentElement.dataset.theme = th;
})();

window.App = {
  state: {
    connections: [],
    activeId: null,
    sessions: {},        // id -> { state }
    cwd: null,
    selected: null,      // selected remote entry path
    openFile: null,      // { path, content, original, binary, size, mtime, mode, dirty }
    forwards: [],
    appInfo: null,
  },
  ui: { theme: document.documentElement.dataset.theme || 'midnight', mini: false, pinned: true },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Inline SVG icon from the sprite in index.html.
function icon(name, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

function fmtRate(n) { return fmtBytes(Math.max(0, Math.round(n || 0))) + '/s'; }

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Translate known core error codes; fall back to the raw message.
App.errMsg = (e) => {
  if (!e) return '';
  if (e.code && hasText('err.' + e.code)) return t('err.' + e.code);
  return e.message || String(e);
};

App.setStatus = (text) => {
  $('#status-text').textContent = text === undefined ? t('status.ready') : text;
  const dot = $('#status-dot');
  if (dot) {
    const busy = /…|\.\.\.$/.test(String(text));
    dot.className = 'status-dot' + (busy ? ' busy' : '');
  }
};
App.setStatusRight = (text) => { $('#status-right').textContent = text; };

const TOAST_ICONS = { info: 'info', success: 'check-circle', warn: 'alert', error: 'x-circle' };
App.toast = (msg, { type = 'info', title = '', timeout = 4200 } = {}) => {
  const wrap = $('#toasts');
  while (wrap.children.length >= 5) wrap.firstChild.remove();
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    node.style.transition = 'opacity .22s, transform .22s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(16px)';
    setTimeout(() => node.remove(), 240);
  };
  const node = el('div', { class: `toast ${type}`, style: `--toast-life:${timeout}ms`, role: 'status' },
    icon(TOAST_ICONS[type] || 'info', 'toast-ic'),
    el('div', { class: 'toast-body' },
      title ? el('div', { class: 't-title' }, title) : null,
      el('div', { class: 't-msg' }, msg)),
    el('button', { class: 'toast-x', 'aria-label': 'close', onclick: dismiss }, icon('x')));
  wrap.append(node);
  setTimeout(dismiss, timeout);
};

// Generic modal. body is an HTMLElement. buttons: [{label, class, onClick(close)}].
App.modal = ({ title, body, buttons = [], width = 460, persistent = false }) => {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');
  modal.style.width = width + 'px';
  modal.innerHTML = '';
  const close = () => { overlay.hidden = true; modal.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !persistent) close(); };

  modal.append(el('div', { class: 'modal-head' }, title));
  const bodyWrap = el('div', { class: 'modal-body' });
  bodyWrap.append(body);
  modal.append(bodyWrap);
  if (buttons.length) {
    const foot = el('div', { class: 'modal-foot' });
    for (const b of buttons) {
      foot.append(el('button', {
        class: b.class || 'ghost',
        onclick: () => b.onClick && b.onClick(close),
      }, b.label));
    }
    modal.append(foot);
  }
  overlay.hidden = false;
  overlay.onclick = (e) => { if (e.target === overlay && !persistent) close(); };
  document.addEventListener('keydown', onKey);
  const firstInput = modal.querySelector('input, select, textarea, button');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
  return { close, root: modal };
};

App.prompt = ({ title, label, value = '', placeholder = '', hint = '' }) => new Promise((resolve) => {
  const input = el('input', { type: 'text', value, placeholder, spellcheck: 'false' });
  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, label), input, hint ? el('div', { class: 'field-hint' }, hint) : null));
  let done = false;
  const finish = (val) => { if (!done) { done = true; resolve(val); } };
  const m = App.modal({
    title, body,
    buttons: [
      { label: t('cancel'), class: 'ghost', onClick: (close) => { finish(null); close(); } },
      { label: t('ok'), class: 'primary', onClick: (close) => { finish(input.value); close(); } },
    ],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { finish(input.value); m.close(); } });
});

App.confirm = ({ title, message, danger = false, okLabel }) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  App.modal({
    title,
    body: el('div', { class: 'muted', style: 'line-height:1.6' }, message),
    buttons: [
      { label: t('cancel'), class: 'ghost', onClick: (close) => { finish(false); close(); } },
      { label: okLabel || t('ok'), class: danger ? 'ghost danger' : 'primary', onClick: (close) => { finish(true); close(); } },
    ],
  });
});

// Run an async action with status + error toast wrapping.
App.guard = async (label, fn) => {
  try {
    App.setStatus(label + '…');
    const r = await fn();
    App.setStatus();
    return r;
  } catch (e) {
    App.setStatus();
    App.toast(App.errMsg(e), { type: 'error', title: t('guard.failed', { label }) });
    throw e;
  }
};
