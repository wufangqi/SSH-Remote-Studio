'use strict';
// Connection sidebar + connection editor + connect/disconnect orchestration.
App.connections = {
  async refresh() {
    App.state.connections = await window.api.connections.list();
    this.render();
  },

  render() {
    const list = $('#conn-list');
    list.innerHTML = '';
    if (!App.state.connections.length) {
      list.append(el('li', { class: 'sidebar-empty' }, t('sidebar.empty')));
      return;
    }
    const counts = (App.monitor && App.monitor.counts) || {};
    for (const c of App.state.connections) {
      const st = (App.state.sessions[c.id] && App.state.sessions[c.id].state) || 'disconnected';
      const dotClass = st === 'connected' ? 'connected' : st === 'connecting' ? 'connecting' : st === 'error' ? 'error' : '';
      const nFwd = counts[c.id] || 0;
      const item = el('li', {
        class: 'conn-item' + (App.state.activeId === c.id ? ' active' : ''),
        'data-conn-id': c.id,
        onclick: () => this.onItemClick(c.id),
      },
        el('span', { class: 'dot ' + dotClass }),
        el('div', { class: 'conn-meta' },
          el('div', { class: 'conn-name' }, c.name || `${c.username}@${c.host}`),
          el('div', { class: 'conn-sub' }, `${c.username}@${c.host}:${c.port}`)),
        nFwd > 0 ? el('span', { class: 'conn-fwd-chip', title: t('mini.forwards') }, `${nFwd} ⇄`) : null,
        el('div', { class: 'conn-actions' },
          el('button', { class: 'icon-btn', title: t('sidebar.edit'), onclick: (e) => { e.stopPropagation(); this.openForm(c); } }, icon('edit')),
          el('button', { class: 'icon-btn danger', title: t('sidebar.delete'), onclick: (e) => { e.stopPropagation(); this.remove(c.id); } }, icon('trash'))));
      list.append(item);
    }
  },

  async onItemClick(id) {
    if (id === App.state.activeId && !$('#workspace').hidden) return;
    const st = App.state.sessions[id] && App.state.sessions[id].state;
    if (st === 'connected') await this.setActive(id);
    else await this.connect(id);
  },

  setState(id, state) {
    App.state.sessions[id] = { state };
    this.render();
    if (App.state.activeId === id) {
      const dot = $('#conn-state');
      dot.className = 'state-dot ' + (state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : '');
    }
    if (App.ui.mini && App.mini) App.mini.render();
  },

  // Activate a session AND switch the whole workspace (file tree, editor,
  // forwards panel) to it. Guards against losing unsaved editor changes.
  async setActive(id) {
    if (App.state.activeId === id && !$('#workspace').hidden) { this.render(); return; }
    const f = App.state.openFile;
    if (f && f.dirty) {
      const ok = await App.confirm({ title: t('discard.title'), message: t('discard.msg'), danger: true, okLabel: t('discard.ok') });
      if (!ok) return;
    }
    App.state.activeId = id;
    const c = App.state.connections.find((x) => x.id === id);
    $('#welcome').hidden = true;
    $('#workspace').hidden = false;
    $('#conn-label').textContent = c ? `${c.username}@${c.host}:${c.port}` : id;
    const st = (App.state.sessions[id] && App.state.sessions[id].state) || 'connected';
    $('#conn-state').className = 'state-dot ' + (st === 'connected' ? 'connected' : '');
    this.render();
    if (st === 'connected') {
      try { await App.files.init(id); } catch (e) { App.toast(App.errMsg(e), { type: 'error', title: t('files.listFailed') }); }
      await App.ports.refresh(id);
    }
  },

  async connect(id) {
    this.setState(id, 'connecting');
    App.setStatus(t('status.connecting'));
    try {
      await window.api.session.connect(id);
      this.setState(id, 'connected');
      await this.setActive(id);
      App.setStatus(t('status.connected'));
      App.toast(t('toast.connectOk'), { type: 'success', title: 'SSH' });
    } catch (e) {
      this.setState(id, 'error');
      App.setStatus(t('status.connectFailed'));
      App.toast(App.errMsg(e), { type: 'error', title: t('status.connectFailed'), timeout: 7000 });
    }
  },

  async disconnect(id) {
    try {
      await window.api.session.disconnect(id);
      this.setState(id, 'disconnected');
      if (App.state.activeId === id) {
        App.state.activeId = null;
        App.state.openFile = null;
        App.state.forwards = [];
        $('#workspace').hidden = true;
        $('#welcome').hidden = false;
      }
      App.setStatus(t('status.disconnected'));
    } catch (e) {
      App.toast(App.errMsg(e), { type: 'error' });
    }
  },

  async remove(id) {
    const ok = await App.confirm({ title: t('conn.delete.title'), message: t('conn.delete.msg'), danger: true, okLabel: t('conn.delete.ok') });
    if (!ok) return;
    await window.api.connections.delete(id);
    delete App.state.sessions[id];
    if (App.state.activeId === id) {
      App.state.activeId = null;
      $('#workspace').hidden = true;
      $('#welcome').hidden = false;
    }
    await this.refresh();
    App.toast(t('toast.connDeleted'), { type: 'success' });
  },

  openForm(existing = null) {
    const isEdit = !!existing;
    const c = existing || {};
    const host = el('input', { type: 'text', value: c.host || '', placeholder: t('ph.host') });
    const port = el('input', { type: 'number', value: c.port || 22, min: '1', max: '65535' });
    const username = el('input', { type: 'text', value: c.username || '', placeholder: t('ph.username') });
    const name = el('input', { type: 'text', value: c.name || '', placeholder: t('ph.name') });

    const authType = c.authType || 'password';
    const password = el('input', { type: 'password', value: '', placeholder: c.has_password ? t('ph.password.saved') : t('ph.password') });
    const keyPath = el('input', { type: 'text', value: c.privateKeyPath || '', placeholder: t('ph.keyPath') });
    const passphrase = el('input', { type: 'password', value: '', placeholder: c.has_passphrase ? t('ph.passphrase.saved') : t('ph.passphrase') });
    const browseBtn = el('button', { class: 'ghost', type: 'button', onclick: async () => {
      const p = await window.api.dialog.openFile({ title: t('conn.browse.title') });
      if (p) keyPath.value = p;
    } }, t('conn.browse'));

    const pwdSection = el('div', { class: 'field' }, el('label', {}, t('conn.password')), password);
    const keySection = el('div', {},
      el('div', { class: 'field' }, el('label', {}, t('conn.keyFile')), el('div', { class: 'input-with-btn' }, keyPath, browseBtn)),
      el('div', { class: 'field' }, el('label', {}, t('conn.passphrase')), passphrase));
    const agentSection = el('div', { class: 'field-hint', style: 'margin-bottom:12px' }, t('agent.hint'));

    const radios = {};
    const radioRow = el('div', { class: 'radio-row' });
    const sections = { password: pwdSection, key: keySection, agent: agentSection };
    const labels = { password: t('auth.password'), key: t('auth.key'), agent: t('auth.agent') };
    const selectAuth = (type) => {
      for (const k of Object.keys(sections)) {
        sections[k].hidden = k !== type;
        radios[k].classList.toggle('checked', k === type);
      }
    };
    for (const k of ['password', 'key', 'agent']) {
      const lbl = el('label', {}, labels[k]);
      radios[k] = lbl;
      lbl.addEventListener('click', () => selectAuth(k));
      radioRow.append(lbl);
    }

    const errLine = el('div', { class: 'form-error' });
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', {}, t('conn.name')), name),
      el('div', { class: 'field-row' },
        el('div', { class: 'field', style: 'flex:2' }, el('label', {}, t('conn.host')), host),
        el('div', { class: 'field' }, el('label', {}, t('conn.port')), port)),
      el('div', { class: 'field' }, el('label', {}, t('conn.username')), username),
      el('div', { class: 'field' }, el('label', {}, t('conn.auth')), radioRow),
      pwdSection, keySection, agentSection, errLine);
    selectAuth(authType);

    const gather = () => {
      const type = Object.keys(radios).find((k) => radios[k].classList.contains('checked')) || 'password';
      const conn = {
        id: c.id, name: name.value.trim(), host: host.value.trim(),
        port: Number(port.value) || 22, username: username.value.trim(), authType: type,
      };
      if (type === 'password' && password.value) conn.password = password.value;
      if (type === 'key') {
        if (keyPath.value.trim()) conn.privateKeyPath = keyPath.value.trim();
        if (passphrase.value) conn.passphrase = passphrase.value;
      }
      return conn;
    };

    const save = async (close, thenConnect) => {
      const conn = gather();
      if (!conn.host) { errLine.textContent = t('err.host'); return; }
      if (!conn.username) { errLine.textContent = t('err.username'); return; }
      try {
        const saved = await window.api.connections.save(conn);
        await App.connections.refresh();
        close();
        App.toast(isEdit ? t('toast.connUpdated') : t('toast.connSaved'), { type: 'success' });
        if (thenConnect) await App.connections.connect(saved.id);
      } catch (e) {
        errLine.textContent = App.errMsg(e);
      }
    };

    App.modal({
      title: isEdit ? t('conn.edit') : t('conn.new'),
      body,
      width: 480,
      buttons: [
        { label: t('cancel'), class: 'ghost', onClick: (close) => close() },
        { label: t('conn.save'), class: 'ghost', onClick: (close) => save(close, false) },
        { label: t('conn.saveConnect'), class: 'primary', onClick: (close) => save(close, true) },
      ],
    });
  },
};
