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

    const typeLabel = { local: '本地 -L', remote: '远程 -R', dynamic: 'SOCKS -D' };
    const statusLabel = { active: '运行中', starting: '启动中', error: '错误', stopped: '已停止' };

    for (const f of forwards) {
      const stopBtn = el('button', {
        class: 'ghost danger', title: '停止转发',
        onclick: () => this.stop(f.id),
      }, '停止');
      const tr = el('tr', {},
        el('td', {}, el('span', { class: 'fwd-type ' + f.type }, typeLabel[f.type] || f.type)),
        el('td', {}, el('span', { class: 'fwd-label', title: f.error || '' }, f.label)),
        el('td', {}, el('span', { class: 'fwd-addr' }, `${f.bindHost}:${f.bindPort}`)),
        el('td', {}, el('span', { class: 'status-pill ' + f.status }, el('span', { class: 'sd' }), statusLabel[f.status] || f.status)),
        el('td', {}, String(f.connections || 0)),
        el('td', { class: 'muted' }, `${fmtBytes(f.bytesUp || 0)} ↑ / ${fmtBytes(f.bytesDown || 0)} ↓`),
        el('td', {}, stopBtn));
      body.append(tr);
    }
  },

  async stop(fid) {
    const id = App.state.activeId;
    try {
      await window.api.forward.stop(id, fid);
      await this.refresh(id);
      App.toast('转发已停止', { type: 'success', timeout: 2000 });
    } catch (e) {
      App.toast(e.message, { type: 'error', title: '停止失败' });
    }
  },

  openForm() {
    if (!App.state.activeId) { App.toast('请先连接一个主机', { type: 'warn' }); return; }
    const types = {
      local: { name: '本地 -L', hint: '把本地端口的流量转发到远程可达的目标服务。例如本地 8080 → 远程数据库 127.0.0.1:5432。' },
      remote: { name: '远程 -R', hint: '把远程主机上的端口转发回本地目标服务。远程访问该端口即访问你本地的服务。' },
      dynamic: { name: '动态 -D', hint: '在本地启动一个 SOCKS5 代理，浏览器/应用通过它经 SSH 隧道访问远程网络。' },
    };
    let curType = 'local';

    const bindHost = el('input', { type: 'text', value: '127.0.0.1' });
    const bindPort = el('input', { type: 'number', value: '8080', min: '0', max: '65535' });
    const destHost = el('input', { type: 'text', value: '127.0.0.1' });
    const destPort = el('input', { type: 'number', value: '80', min: '1', max: '65535' });
    const hint = el('div', { class: 'field-hint' }, types.local.hint);

    const destHostField = el('div', { class: 'field' }, el('label', {}, '目标主机'), destHost);
    const destPortField = el('div', { class: 'field' }, el('label', {}, '目标端口'), destPort);
    const destRow = el('div', { class: 'field-row' }, destHostField, destPortField);

    const radioRow = el('div', { class: 'radio-row' });
    const radios = {};
    const selectType = (t) => {
      curType = t;
      hint.textContent = types[t].hint;
      const isDyn = t === 'dynamic';
      destRow.hidden = isDyn;
      bindPort.value = isDyn ? '1080' : (t === 'remote' ? '8080' : '8080');
      for (const k of Object.keys(radios)) radios[k].classList.toggle('checked', k === t);
    };
    for (const t of ['local', 'remote', 'dynamic']) {
      const lbl = el('label', {}, types[t].name);
      radios[t] = lbl;
      lbl.addEventListener('click', () => selectType(t));
      radioRow.append(lbl);
    }

    const errLine = el('div', { class: 'form-error' });
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', {}, '转发类型'), radioRow),
      hint,
      el('div', { class: 'field-row', style: 'margin-top:12px' },
        el('div', { class: 'field', style: 'flex:2' }, el('label', {}, '监听地址'), bindHost),
        el('div', { class: 'field' }, el('label', {}, '监听端口'), bindPort)),
      destRow,
      el('div', { class: 'field-hint' }, '监听端口填 0 表示自动分配可用端口。'),
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
        if (!def.destPort) { errLine.textContent = '请填写目标端口'; return; }
      }
      if (Number.isNaN(def.bindPort)) { errLine.textContent = '请填写有效的监听端口'; return; }
      try {
        const fwd = await window.api.forward.add(App.state.activeId, def);
        await this.refresh();
        close();
        if (fwd.status === 'error') App.toast(fwd.error || '转发启动失败', { type: 'error', title: '转发' });
        else App.toast(`转发已启动：${fwd.label}`, { type: 'success' });
      } catch (e) {
        errLine.textContent = e.message || String(e);
      }
    };

    App.modal({
      title: '转发端口',
      body,
      width: 480,
      buttons: [
        { label: '取消', class: 'ghost', onClick: (close) => close() },
        { label: '转发', class: 'primary', onClick: (close) => submit(close) },
      ],
    });
  },
};
