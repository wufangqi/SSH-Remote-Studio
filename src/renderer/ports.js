'use strict';
// Port forwarding panel: list active forwards and add local/remote/dynamic ones.
App.ports = {
  async refresh(id) {
    const sid = id || App.state.activeId;
    if (!sid) { App.state.forwards = []; this.render(); return; }
    try {
      App.state.forwards = await window.api.forward.list(sid);
    } catch (e) {
      App.state.forwards = [];
    }
    this.render();
  },

  render() {
    const body = $('#ports-body');
    body.innerHTML = '';
    const forwards = App.state.forwards;
    const badge = $('#port-count');
    const active = forwards.filter((f) => f.status === 'active').length;
    badge.textContent = active;
    badge.hidden = active === 0;
    $('#ports-empty').hidden = forwards.length > 0;
    $('#ports-table').hidden = forwards.length === 0;

    const typeLabel = { local: t('fwd.local'), remote: t('fwd.remote'), dynamic: t('fwd.dynamic') };
    const statusLabel = {
      active: t('fwd.status.active'), starting: t('fwd.status.starting'),
      error: t('fwd.status.error'), stopped: t('fwd.status.stopped'),
    };

    for (const f of forwards) {
      const stopBtn = el('button', {
        class: 'ghost danger small', title: t('fwd.stop.title'),
        onclick: () => this.stop(f.id),
      }, icon('x'), t('fwd.stop'));
      const copyBtn = el('button', {
        class: 'icon-btn copy-btn', title: t('ports.copy'),
        onclick: () => this.copyAddr(`${f.bindHost}:${f.bindPort}`),
      }, icon('copy'));
      const tr = el('tr', { 'data-fid': f.id },
        el('td', {}, el('span', { class: 'fwd-type ' + f.type }, typeLabel[f.type] || f.type)),
        el('td', {}, el('span', { class: 'fwd-label', title: f.error || f.label }, f.label)),
        el('td', {}, el('span', { class: 'fwd-addr-wrap' }, el('span', { class: 'fwd-addr' }, `${f.bindHost}:${f.bindPort}`), copyBtn)),
        el('td', {}, el('span', { class: 'status-pill ' + f.status }, el('span', { class: 'sd' }), statusLabel[f.status] || f.status)),
        el('td', { class: 'mono' }, String(f.connections || 0)),
        el('td', {},
          el('div', { class: 'fwd-traffic' },
            el('span', { class: 't-up' }, `↑ ${fmtBytes(f.bytesUp || 0)}`), ' ',
            el('span', { class: 't-down' }, `↓ ${fmtBytes(f.bytesDown || 0)}`)),
          el('div', { class: 'fwd-rate', 'data-rate': f.id }, '')),
        el('td', {}, stopBtn));
      body.append(tr);
    }
    this.updateLive();
  },

  // Targeted per-second traffic/rate refresh without rebuilding rows.
  updateLive() {
    if ($('#view-ports').hidden) return;
    const mon = App.monitor;
    if (!mon) return;
    const sid = App.state.activeId;
    for (const f of App.state.forwards) {
      const row = $(`#ports-body tr[data-fid="${CSS.escape(f.id)}"]`);
      if (!row) continue;
      const traffic = row.querySelector('.fwd-traffic');
      if (traffic) {
        traffic.innerHTML = '';
        traffic.append(
          el('span', { class: 't-up' }, `↑ ${fmtBytes(f.bytesUp || 0)}`), ' ',
          el('span', { class: 't-down' }, `↓ ${fmtBytes(f.bytesDown || 0)}`));
      }
      const rateEl = row.querySelector('.fwd-rate');
      const r = mon.rates[(sid || '') + '/' + f.id];
      if (rateEl) {
        rateEl.textContent = (f.status === 'active' && r)
          ? `↑ ${fmtRate(r.up)}  ↓ ${fmtRate(r.down)}`
          : '';
      }
    }
  },

  async copyAddr(addr) {
    try {
      let ok = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(addr); ok = true; } catch { /* fall through */ }
      }
      if (!ok) {
        const ta = el('textarea', { style: 'position:fixed;opacity:0' }, addr);
        document.body.append(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      }
      if (ok) App.toast(t('ports.copied'), { type: 'success', timeout: 1600 });
    } catch { /* clipboard unavailable — non-fatal */ }
  },

  async stop(fid) {
    const id = App.state.activeId;
    try {
      await window.api.forward.stop(id, fid);
      await this.refresh(id);
      App.toast(t('toast.fwdStopped'), { type: 'success', timeout: 2000 });
    } catch (e) {
      App.toast(App.errMsg(e), { type: 'error', title: t('fwd.stopFailed') });
    }
  },

  openForm() {
    if (!App.state.activeId) { App.toast(t('fwd.needConn'), { type: 'warn' }); return; }
    const types = {
      local: { name: t('fwd.local'), hint: t('fwd.local.hint') },
      remote: { name: t('fwd.remote'), hint: t('fwd.remote.hint') },
      dynamic: { name: t('fwd.dynamic'), hint: t('fwd.dynamic.hint') },
    };
    let curType = 'local';

    const bindHost = el('input', { type: 'text', value: '127.0.0.1' });
    const bindPort = el('input', { type: 'number', value: '8080', min: '0', max: '65535' });
    const destHost = el('input', { type: 'text', value: '127.0.0.1' });
    const destPort = el('input', { type: 'number', value: '80', min: '1', max: '65535' });
    const hint = el('div', { class: 'field-hint' }, types.local.hint);

    const destHostField = el('div', { class: 'field' }, el('label', {}, t('fwd.destHost')), destHost);
    const destPortField = el('div', { class: 'field' }, el('label', {}, t('fwd.destPort')), destPort);
    const destRow = el('div', { class: 'field-row' }, destHostField, destPortField);

    const radioRow = el('div', { class: 'radio-row' });
    const radios = {};
    const selectType = (tp) => {
      curType = tp;
      hint.textContent = types[tp].hint;
      const isDyn = tp === 'dynamic';
      destRow.hidden = isDyn;
      bindPort.value = isDyn ? '1080' : '8080';
      for (const k of Object.keys(radios)) radios[k].classList.toggle('checked', k === tp);
    };
    for (const tp of ['local', 'remote', 'dynamic']) {
      const lbl = el('label', {}, types[tp].name);
      radios[tp] = lbl;
      lbl.addEventListener('click', () => selectType(tp));
      radioRow.append(lbl);
    }

    const errLine = el('div', { class: 'form-error' });
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', {}, t('fwd.type')), radioRow),
      hint,
      el('div', { class: 'field-row', style: 'margin-top:12px' },
        el('div', { class: 'field', style: 'flex:2' }, el('label', {}, t('fwd.bindHost')), bindHost),
        el('div', { class: 'field' }, el('label', {}, t('fwd.bindPort')), bindPort)),
      destRow,
      el('div', { class: 'field-hint' }, t('fwd.autoPort')),
      errLine);
    selectType('local');

    const submit = async (close) => {
      const def = {
        type: curType,
        bindHost: bindHost.value.trim() || '127.0.0.1',
        bindPort: Number(bindPort.value),
      };
      if (curType !== 'dynamic') {
        def.destHost = destHost.value.trim() || '127.0.0.1';
        def.destPort = Number(destPort.value);
        if (!def.destPort) { errLine.textContent = t('err.destPort'); return; }
      }
      if (Number.isNaN(def.bindPort)) { errLine.textContent = t('err.bindPort'); return; }
      try {
        const fwd = await window.api.forward.add(App.state.activeId, def);
        await this.refresh();
        close();
        if (fwd.status === 'error') App.toast(fwd.error || t('fwd.startFailed'), { type: 'error', title: t('fwd.errorTitle') });
        else App.toast(t('toast.fwdStarted', { label: fwd.label }), { type: 'success' });
      } catch (e) {
        errLine.textContent = App.errMsg(e);
      }
    };

    App.modal({
      title: t('fwd.title'),
      body,
      width: 480,
      buttons: [
        { label: t('cancel'), class: 'ghost', onClick: (close) => close() },
        { label: t('fwd.submit'), class: 'primary', onClick: (close) => submit(close) },
      ],
    });
  },
};
