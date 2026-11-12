'use strict';
// Shared renderer state, DOM helpers, toasts and modals. Classic script;
// everything hangs off window.App. Loaded first.
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

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

App.setStatus = (text) => { $('#status-text').textContent = text; };
App.setStatusRight = (text) => { $('#status-right').textContent = text; };

App.toast = (msg, { type = 'info', title = '', timeout = 4200 } = {}) => {
  const node = el('div', { class: `toast ${type}` },
    title ? el('div', { class: 't-title' }, title) : null,
    el('div', { class: 't-msg' }, msg));
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, timeout);
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
      { label: '取消', class: 'ghost', onClick: (close) => { finish(null); close(); } },
      { label: '确定', class: 'primary', onClick: (close) => { finish(input.value); close(); } },
    ],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { finish(input.value); m.close(); } });
});

App.confirm = ({ title, message, danger = false, okLabel = '确定' }) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  const m = App.modal({
    title,
    body: el('div', { class: 'muted', style: 'line-height:1.6' }, message),
    buttons: [
      { label: '取消', class: 'ghost', onClick: (close) => { finish(false); close(); } },
      { label: okLabel, class: danger ? 'ghost danger' : 'primary', onClick: (close) => { finish(true); close(); } },
    ],
  });
});

// Run an async action with status + error toast wrapping.
App.guard = async (label, fn) => {
  try {
    App.setStatus(label + '…');
    const r = await fn();
    App.setStatus('就绪');
    return r;
  } catch (e) {
    App.setStatus('就绪');
    App.toast(e.message || String(e), { type: 'error', title: label + '失败' });
    throw e;
  }
};
