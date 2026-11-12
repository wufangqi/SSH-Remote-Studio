'use strict';
// Mini mode: a compact always-on-top "tunnel monitor" plus the shared live
// monitor engine. The engine polls session status + forward counters once a
// second, derives per-forward rates and an aggregate throughput history, and
// feeds both the mini panel and the full-mode ports table.

App.monitor = {
  rates: {},            // "sessionId/forwardId" -> { up, down } bytes/sec
  counts: {},           // sessionId -> active forward count
  forwardsBySession: {},
  history: [],          // last 90 aggregate samples { t, up, down }
  prev: {},             // counters snapshot for delta computation
  up: 0, down: 0,       // current aggregate rates
  bytesUp: 0, bytesDown: 0,
  timer: null,
  _countsKey: '',

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
    this.tick().catch(() => {});
  },
  stop() { clearInterval(this.timer); this.timer = null; },

  async tick() {
    const api = window.api;
    let sessions = [];
    try { sessions = await api.session.status(); } catch { return; }

    // Reconcile renderer session states with the authoritative manager view.
    let changed = false;
    const seen = new Set();
    for (const s of sessions) {
      seen.add(s.id);
      const cur = App.state.sessions[s.id];
      // Keep a sticky renderer-side 'error' while the manager idles, so the
      // failure stays visible until the next connect attempt.
      const next = (cur && cur.state === 'error' && s.state === 'disconnected') ? 'error' : s.state;
      if (!cur || cur.state !== next) { App.state.sessions[s.id] = { state: next }; changed = true; }
    }
    for (const id of Object.keys(App.state.sessions)) {
      if (!seen.has(id) && App.state.sessions[id].state !== 'connecting') {
        delete App.state.sessions[id];
        changed = true;
      }
    }
    if (changed) App.connections.render();

    const now = Date.now();
    const rates = {};
    const counts = {};
    const bySession = {};
    let up = 0, down = 0, bytesUp = 0, bytesDown = 0;

    for (const s of sessions) {
      if (s.state !== 'connected') continue;
      let fwds = [];
      try { fwds = await api.forward.list(s.id); } catch { continue; }
      bySession[s.id] = fwds;
      counts[s.id] = fwds.filter((f) => f.status === 'active').length;
      for (const f of fwds) {
        bytesUp += f.bytesUp || 0;
        bytesDown += f.bytesDown || 0;
        const key = s.id + '/' + f.id;
        const p = this.prev[key];
        let ru = 0, rd = 0;
        if (p && now > p.t) {
          const dt = (now - p.t) / 1000;
          ru = Math.max(0, ((f.bytesUp || 0) - p.up) / dt);
          rd = Math.max(0, ((f.bytesDown || 0) - p.down) / dt);
        }
        this.prev[key] = { t: now, up: f.bytesUp || 0, down: f.bytesDown || 0 };
        rates[key] = { up: ru, down: rd };
        if (f.status === 'active') { up += ru; down += rd; }
      }
    }
    // Prune snapshots of forwards that no longer exist.
    for (const key of Object.keys(this.prev)) {
      if (!rates[key]) delete this.prev[key];
    }

    this.rates = rates;
    this.counts = counts;
    this.forwardsBySession = bySession;
    this.up = up; this.down = down;
    this.bytesUp = bytesUp; this.bytesDown = bytesDown;
    this.history.push({ t: now, up, down });
    if (this.history.length > 90) this.history.shift();

    // Live sidebar forward-count chips (only re-render when counts change).
    const ck = JSON.stringify(counts);
    if (ck !== this._countsKey) { this._countsKey = ck; App.connections.render(); }

    if (App.ui.mini) App.mini.render();
    else App.ports.updateLive();
  },
};

App.mini = {
  selId: null,

  enter() {
    const connected = App.state.connections.filter((c) => App.state.sessions[c.id] && App.state.sessions[c.id].state === 'connected');
    this.selId = (App.state.activeId && connected.some((c) => c.id === App.state.activeId))
      ? App.state.activeId
      : (connected[0] && connected[0].id) || null;
    this.render();
  },

  liveSessions() {
    return App.state.connections.filter((c) => {
      const st = App.state.sessions[c.id] && App.state.sessions[c.id].state;
      return st === 'connected' || st === 'connecting' || st === 'error';
    });
  },

  render() {
    if (!App.ui.mini) return;
    const mon = App.monitor;
    const live = this.liveSessions();

    // clock
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    $('#mini-clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;

    // quick connect: saved connections that are not live
    const sel = $('#mini-conn-select');
    const prevVal = sel.value;
    sel.innerHTML = '';
    const idle = App.state.connections.filter((c) => {
      const st = App.state.sessions[c.id] && App.state.sessions[c.id].state;
      return st !== 'connected' && st !== 'connecting';
    });
    if (!idle.length) {
      sel.append(el('option', { value: '' }, t('mini.noSaved')));
      sel.disabled = true;
      $('#mini-connect').disabled = true;
    } else {
      sel.disabled = false;
      $('#mini-connect').disabled = false;
      for (const c of idle) {
        sel.append(el('option', { value: c.id }, c.name || `${c.username}@${c.host}`));
      }
      if (prevVal && idle.some((c) => c.id === prevVal)) sel.value = prevVal;
    }

    // empty state
    $('#mini-empty').hidden = live.length > 0;
    $('#mini-live').hidden = live.length === 0;

    // keep selection valid
    if (this.selId && !live.some((c) => c.id === this.selId)) this.selId = null;
    if (!this.selId && live.length) {
      const firstConnected = live.find((c) => App.state.sessions[c.id].state === 'connected');
      this.selId = (firstConnected || live[0]).id;
    }

    // sessions
    $('#mini-sess-count').textContent = String(live.length);
    const sessWrap = $('#mini-sessions');
    sessWrap.innerHTML = '';
    for (const c of live) {
      const st = App.state.sessions[c.id].state;
      const nFwd = mon.counts[c.id] || 0;
      const card = el('div', {
        class: 'mini-conn' + (this.selId === c.id ? ' current' : ''),
        title: t('mini.selectSession'),
        onclick: () => this.selectSession(c.id),
      },
        el('span', { class: 'dot ' + (st === 'connected' ? 'connected' : st === 'connecting' ? 'connecting' : 'error') }),
        el('div', { class: 'mini-conn-meta' },
          el('div', { class: 'mini-conn-name' }, c.name || `${c.username}@${c.host}`),
          el('div', { class: 'mini-conn-sub' }, `${c.username}@${c.host}:${c.port}` + (nFwd ? ` · ${nFwd} ⇄` : ''))),
        el('button', {
          class: 'icon-btn danger', title: t('mini.disconnect'),
          onclick: (e) => { e.stopPropagation(); App.connections.disconnect(c.id); },
        }, icon('power')));
      sessWrap.append(card);
    }

    // forwards of the selected session
    const fwds = (this.selId && mon.forwardsBySession[this.selId]) || [];
    $('#mini-fwd-count').textContent = String(fwds.filter((f) => f.status === 'active').length);
    const fwdWrap = $('#mini-forwards');
    fwdWrap.innerHTML = '';
    if (!fwds.length) {
      fwdWrap.append(el('div', { class: 'mini-empty-fw' }, t('mini.emptyForwards')));
    }
    const typeLetter = { local: 'L', remote: 'R', dynamic: 'D' };
    const statusText = (f) => {
      if (f.status === 'active') return t('fwd.status.active');
      if (f.status === 'starting') return t('fwd.status.starting');
      if (f.status === 'error') return t('fwd.status.retrying', { n: Math.max(1, f.attempts || 1), max: f.maxAttempts || 5 });
      return t('fwd.status.disconnected');
    };
    for (const f of fwds) {
      const r = mon.rates[(this.selId || '') + '/' + f.id] || { up: 0, down: 0 };
      const btn = f.status === 'active'
        ? el('button', {
          class: 'icon-btn danger', title: t('mini.stop'),
          onclick: () => this.stopForward(f.id),
        }, icon('x'))
        : el('button', {
          class: 'icon-btn', title: t('fwd.restart.title'),
          onclick: () => this.restartForward(f.id),
        }, icon('refresh'));
      const card = el('div', { class: 'mini-fwd' },
        el('div', { class: 'mini-fwd-top' },
          el('span', { class: 'fwd-type ' + f.type }, typeLetter[f.type] || f.type),
          el('span', { class: 'mini-fwd-label', title: f.error || f.label }, f.label),
          btn),
        el('div', { class: 'mini-fwd-bottom' },
          el('span', { class: 'status-pill ' + f.status, title: f.error || '' }, el('span', { class: 'sd' }), statusText(f)),
          el('span', { class: 'mini-fwd-rates' },
            el('span', { class: 't-up' }, `↑ ${fmtRate(r.up)}`), ' ',
            el('span', { class: 't-down' }, `↓ ${fmtRate(r.down)}`))),
        el('div', { class: 'mini-fwd-total' },
          `${f.connections || 0} conn · ↑ ${fmtBytes(f.bytesUp || 0)} · ↓ ${fmtBytes(f.bytesDown || 0)}`));
      fwdWrap.append(card);
    }

    // aggregate rates + sparkline + footer
    $('#mini-rate-up').textContent = `↑ ${fmtRate(mon.up)}`;
    $('#mini-rate-down').textContent = `↓ ${fmtRate(mon.down)}`;
    const activeFwd = Object.values(mon.counts).reduce((a, b) => a + b, 0);
    $('#mini-total-sess').textContent = t('mini.total.sessions', { n: live.filter((c) => App.state.sessions[c.id].state === 'connected').length });
    $('#mini-total-fwd').textContent = t('mini.total.forwards', { n: activeFwd });
    $('#mini-total-bytes').textContent = t('mini.total.bytes', { bytes: fmtBytes(mon.bytesUp + mon.bytesDown) });
    this.drawSpark();
  },

  selectSession(id) {
    this.selId = id;
    const st = App.state.sessions[id] && App.state.sessions[id].state;
    if (st === 'connected') App.connections.setActive(id);
    this.render();
  },

  async stopForward(fid) {
    if (!this.selId) return;
    try {
      await window.api.forward.stop(this.selId, fid);
      App.toast(t('toast.fwdStopped'), { type: 'success', timeout: 1800 });
      App.monitor.tick().catch(() => {});
      if (App.state.activeId === this.selId) App.ports.refresh(this.selId);
    } catch (e) {
      App.toast(App.errMsg(e), { type: 'error', title: t('fwd.stopFailed') });
    }
  },

  async restartForward(fid) {
    if (!this.selId) return;
    try {
      const f = await window.api.forward.restart(this.selId, fid);
      App.monitor.tick().catch(() => {});
      if (App.state.activeId === this.selId) App.ports.refresh(this.selId);
      if (f && f.status === 'active') App.toast(t('toast.fwdStarted', { label: f.label }), { type: 'success' });
      else App.toast(t('toast.fwdFailed', { msg: (f && f.error) || '' }), { type: 'error', title: t('fwd.errorTitle') });
    } catch (e) {
      App.toast(App.errMsg(e), { type: 'error', title: t('fwd.startFailed') });
    }
  },

  drawSpark() {
    const c = $('#mini-spark');
    if (!c || !App.ui.mini) return;
    const w = c.clientWidth || 320;
    const h = 46;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const colUp = (css.getPropertyValue('--info') || '#38bdf8').trim();
    const colDown = (css.getPropertyValue('--accent') || '#2ee6a8').trim();
    const colGrid = (css.getPropertyValue('--border-soft') || '#223042').trim();

    // grid
    ctx.strokeStyle = colGrid;
    ctx.lineWidth = 1;
    for (const gy of [h * 0.33, h * 0.66]) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    const hist = App.monitor.history;
    if (hist.length < 2) return;
    let max = 1024;
    for (const s of hist) max = Math.max(max, s.up, s.down);
    const x = (i) => (i / (hist.length - 1)) * (w - 2) + 1;
    const y = (v) => h - 3 - (v / max) * (h - 8);

    const drawSeries = (key, color) => {
      ctx.beginPath();
      hist.forEach((s, i) => { const px = x(i), py = y(s[key]); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();
      // soft fill
      ctx.lineTo(x(hist.length - 1), h);
      ctx.lineTo(x(0), h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, color + '33');
      grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad;
      ctx.fill();
    };
    drawSeries('down', colDown);
    drawSeries('up', colUp);
  },
};
