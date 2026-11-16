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
          el('div', { class: 'conn-sub' },
            `${c.username}@${c.host}:${c.port}`,
            Array.isArray(c.jump) && c.jump.length
              ? ` · ${t('conn.via', { host: c.jump[c.jump.length - 1].host })}`
              : '')),
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
  async setActive(id, { force = false } = {}) {
    if (App.state.activeId === id && !$('#workspace').hidden && !force) { this.render(); return; }
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
      // Force a workspace refresh: reconnecting the already-active session
      // must still reload its saved forwards and file tree.
      await this.setActive(id, { force: true });
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
    try {
      await window.api.connections.delete(id);
      delete App.state.sessions[id];
      if (App.state.activeId === id) {
        App.state.activeId = null;
        $('#workspace').hidden = true;
        $('#welcome').hidden = false;
      }
      await this.refresh();
      App.toast(t('toast.connDeleted'), { type: 'success' });
    } catch (e) {
      App.toast(App.errMsg(e), { type: 'error', title: t('conn.delete.title') });
    }
  },

  async importFromSshConfig() {
    let res;
    try {
      res = await window.api.sshconfig.preview();
    } catch (e) {
      App.toast(App.errMsg(e), { type: 'error', title: t('sshconfig.title') });
      return;
    }
    if (!res || !res.exists) {
      App.toast(t('sshconfig.missing', { path: res ? res.path : '~/.ssh/config' }), { type: 'warn', title: t('sshconfig.title') });
      return;
    }
    if (!res.hosts.length) {
      App.toast(t('sshconfig.empty'), { type: 'warn', title: t('sshconfig.title') });
      return;
    }

    const selected = new Set();
    const rows = [];
    const list = el('div', { class: 'sshconfig-list' });
    for (const h of res.hosts) {
      selected.add(h.name);
      const cb = el('input', { type: 'checkbox' });
      cb.checked = true;
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(h.name);
        else selected.delete(h.name);
      });
      const meta = [`${h.username}@${h.host}:${h.port}`];
      if (h.hasKey) meta.push(t('sshconfig.key'));
      if (h.jump && h.jump.length) {
        meta.push(t('sshconfig.jump', { host: h.jump.map((j) => `${j.username}@${j.host}:${j.port}`).join(' → ') }));
      }
      if (h.forwards) meta.push(t('sshconfig.forwards', { n: h.forwards }));
      rows.push({ cb, name: h.name });
      list.append(el('label', { class: 'sshconfig-row' },
        cb,
        el('div', { class: 'sshconfig-meta' },
          el('div', { class: 'sshconfig-name' }, h.name),
          el('div', { class: 'sshconfig-sub' }, meta.join(' · ')))));
    }

    const selectAll = el('input', { type: 'checkbox' });
    selectAll.checked = true;
    selectAll.addEventListener('change', () => {
      for (const r of rows) {
        r.cb.checked = selectAll.checked;
        if (selectAll.checked) selected.add(r.name);
        else selected.delete(r.name);
      }
    });

    const body = el('div', {},
      el('div', { class: 'field-hint' }, t('sshconfig.hint', { path: res.path })),
      res.warnings && res.warnings.length
        ? el('div', { class: 'field-hint warn' }, res.warnings.join(' · '))
        : null,
      el('label', { class: 'check-row' }, selectAll, el('span', {}, t('sshconfig.selectAll'))),
      list);

    App.modal({
      title: t('sshconfig.title'),
      width: 620,
      body,
      buttons: [
        { label: t('cancel'), class: 'ghost', onClick: (close) => close() },
        {
          label: t('sshconfig.import'),
          class: 'primary',
          onClick: async (close) => {
            const names = [...selected];
            if (!names.length) { App.toast(t('sshconfig.none'), { type: 'warn' }); return; }
            try {
              const saved = await window.api.sshconfig.import(names);
              await this.refresh();
              close();
              App.toast(t('sshconfig.imported', { n: saved.length }), { type: 'success' });
            } catch (e) {
              App.toast(App.errMsg(e), { type: 'error', title: t('sshconfig.title') });
            }
          },
        },
      ],
    });
  },

  openForm(existing = null) {
    const isEdit = !!existing;
    const c = existing || {};
    const host = el('input', { type: 'text', value: c.host || '', placeholder: t('ph.host') });
    const port = el('input', { type: 'number', value: c.port || 22, min: '1', max: '65535' });
    const username = el('input', { type: 'text', value: c.username || '', placeholder: t('ph.username') });
    const homeDir = el('input', { type: 'text', value: c.homeDir || '', placeholder: t('ph.homeDir') });
    const name = el('input', { type: 'text', value: c.name || '', placeholder: t('ph.name') });

    // Jump hosts imported from ~/.ssh/config are shown read-only here; auth
    // comes from the config (key path or agent). Clearing is explicit.
    const jumps = Array.isArray(c.jump) ? c.jump : [];
    const clearJumpChk = el('input', { type: 'checkbox' });
    const jumpSection = jumps.length
      ? el('div', { class: 'field' },
        el('label', {}, t('conn.jump')),
        el('div', { class: 'field-hint' },
          jumps.map((h) => `${h.username}@${h.host}:${h.port}`).join(' → ')),
        el('label', { class: 'check-row' }, clearJumpChk, el('span', {}, t('conn.jump.clear'))))
      : null;

    const authType = c.authType || 'password';
    const password = el('input', { type: 'password', value: '', placeholder: c.has_password ? t('ph.password.saved') : t('ph.password') });
    const keyPath = el('input', { type: 'text', value: c.privateKeyPath || '', placeholder: t('ph.keyPath') });
    const passphrase = el('input', { type: 'password', value: '', placeholder: c.has_passphrase ? t('ph.passphrase.saved') : t('ph.passphrase') });
    const browseBtn = el('button', { class: 'ghost', type: 'button', onclick: async () => {
      const p = await window.api.dialog.openFile({ title: t('conn.browse.title') });
      if (p) keyPath.value = p;
    } }, t('conn.browse'));

    // A saved secret can only be removed by an explicit opt-in; leaving the
    // field blank means "keep the stored value".
    const clearPwdChk = el('input', { type: 'checkbox' });
    const clearPwdRow = c.has_password
      ? el('label', { class: 'check-row' }, clearPwdChk, el('span', {}, t('conn.clearPassword')))
      : null;
    const clearPassChk = el('input', { type: 'checkbox' });
    const clearPassRow = c.has_passphrase
      ? el('label', { class: 'check-row' }, clearPassChk, el('span', {}, t('conn.clearPassphrase')))
      : null;
    clearPwdChk.addEventListener('change', () => {
      password.disabled = clearPwdChk.checked;
      if (clearPwdChk.checked) password.value = '';
    });
    clearPassChk.addEventListener('change', () => {
      passphrase.disabled = clearPassChk.checked;
      if (clearPassChk.checked) passphrase.value = '';
    });

    const hostKeyPolicy = el('select', {},
      el('option', { value: 'tofu' }, t('hostkey.tofu')),
      el('option', { value: 'strict' }, t('hostkey.strict')),
      el('option', { value: 'accept' }, t('hostkey.accept')));
    hostKeyPolicy.value = ['tofu', 'strict', 'accept'].includes(c.hostKeyPolicy) ? c.hostKeyPolicy : 'tofu';

    const pwdSection = el('div', { class: 'field' }, el('label', {}, t('conn.password')), password, clearPwdRow);
    const keySection = el('div', {},
      el('div', { class: 'field' }, el('label', {}, t('conn.keyFile')), el('div', { class: 'input-with-btn' }, keyPath, browseBtn)),
      el('div', { class: 'field' }, el('label', {}, t('conn.passphrase')), passphrase, clearPassRow));
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
      el('div', { class: 'field' }, el('label', {}, t('conn.homeDir')), homeDir,
        el('div', { class: 'field-hint' }, t('conn.homeDir.hint'))),
      jumpSection,
      el('div', { class: 'field' }, el('label', {}, t('conn.auth')), radioRow),
      pwdSection, keySection, agentSection,
      el('div', { class: 'field' }, el('label', {}, t('conn.hostKeyPolicy')), hostKeyPolicy,
        el('div', { class: 'field-hint' }, t('conn.hostKeyPolicy.hint'))),
      errLine);
    selectAuth(authType);

    const gather = () => {
      const type = Object.keys(radios).find((k) => radios[k].classList.contains('checked')) || 'password';
      const conn = {
        id: c.id, name: name.value.trim(), host: host.value.trim(),
        port: Number(port.value) || 22, username: username.value.trim(), authType: type,
        homeDir: homeDir.value.trim() || null,
        hostKeyPolicy: hostKeyPolicy.value,
      };
      if (jumps.length && !clearJumpChk.checked) conn.jump = jumps;
      if (type === 'password') {
        if (clearPwdChk.checked) conn.password = null;
        else if (password.value) conn.password = password.value;
      }
      if (type === 'key') {
        if (keyPath.value.trim()) conn.privateKeyPath = keyPath.value.trim();
        if (clearPassChk.checked) conn.passphrase = null;
        else if (passphrase.value) conn.passphrase = passphrase.value;
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
