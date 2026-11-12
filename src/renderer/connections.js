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
      list.append(el('li', { class: 'muted', style: 'padding:10px 12px;font-size:12px' }, '暂无连接，点击 ＋ 新建'));
      return;
    }
    for (const c of App.state.connections) {
      const st = (App.state.sessions[c.id] && App.state.sessions[c.id].state) || 'disconnected';
      const dotClass = st === 'connected' ? 'connected' : st === 'connecting' ? 'connecting' : st === 'error' ? 'error' : '';
      const item = el('li', {
        class: 'conn-item' + (App.state.activeId === c.id ? ' active' : ''),
        onclick: () => this.onItemClick(c.id),
      },
        el('span', { class: 'dot ' + dotClass }),
        el('div', { class: 'conn-meta' },
          el('div', { class: 'conn-name' }, c.name || `${c.username}@${c.host}`),
          el('div', { class: 'conn-sub' }, `${c.username}@${c.host}:${c.port}`)),
        el('div', { class: 'conn-actions' },
          el('button', { class: 'icon-btn', title: '编辑', onclick: (e) => { e.stopPropagation(); this.openForm(c); } }, '✎'),
          el('button', { class: 'icon-btn', title: '删除', onclick: (e) => { e.stopPropagation(); this.remove(c.id); } }, '🗑')));
      list.append(item);
    }
  },

  async onItemClick(id) {
    const st = App.state.sessions[id] && App.state.sessions[id].state;
    if (st === 'connected') this.setActive(id);
    else await this.connect(id);
  },

  setState(id, state) {
    App.state.sessions[id] = { state };
    this.render();
    if (App.state.activeId === id) {
      const dot = $('#conn-state');
      dot.className = 'state-dot ' + (state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : '');
    }
  },

  setActive(id) {
    App.state.activeId = id;
    const c = App.state.connections.find((x) => x.id === id);
    $('#welcome').hidden = true;
    $('#workspace').hidden = false;
    $('#conn-label').textContent = c ? `${c.username}@${c.host}:${c.port}` : id;
    const st = (App.state.sessions[id] && App.state.sessions[id].state) || 'connected';
    $('#conn-state').className = 'state-dot ' + (st === 'connected' ? 'connected' : '');
    this.render();
  },

  async connect(id) {
    this.setState(id, 'connecting');
    App.setStatus('正在连接…');
    try {
      await window.api.session.connect(id);
      this.setState(id, 'connected');
      this.setActive(id);
      await App.files.init(id);
      await App.ports.refresh(id);
      App.setStatus('已连接');
      App.toast('连接成功', { type: 'success', title: 'SSH' });
    } catch (e) {
      this.setState(id, 'error');
      App.setStatus('连接失败');
      App.toast(e.message || String(e), { type: 'error', title: '连接失败', timeout: 7000 });
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
      App.setStatus('已断开');
    } catch (e) {
      App.toast(e.message, { type: 'error' });
    }
  },

  async remove(id) {
    const ok = await App.confirm({ title: '删除连接', message: '确定删除该连接配置吗？此操作不可撤销。', danger: true, okLabel: '删除' });
    if (!ok) return;
    await window.api.connections.delete(id);
    delete App.state.sessions[id];
    if (App.state.activeId === id) {
      App.state.activeId = null;
      $('#workspace').hidden = true;
      $('#welcome').hidden = false;
    }
    await this.refresh();
    App.toast('连接已删除', { type: 'success' });
  },

  openForm(existing = null) {
    const isEdit = !!existing;
    const c = existing || {};
    const host = el('input', { type: 'text', value: c.host || '', placeholder: '例如 192.168.1.10 或 example.com' });
    const port = el('input', { type: 'number', value: c.port || 22, min: '1', max: '65535' });
    const username = el('input', { type: 'text', value: c.username || '', placeholder: '例如 root' });
    const name = el('input', { type: 'text', value: c.name || '', placeholder: '可选，便于识别' });

    const authType = c.authType || 'password';
    const password = el('input', { type: 'password', value: '', placeholder: c.has_password ? '已保存，留空则不修改' : '登录密码' });
    const keyPath = el('input', { type: 'text', value: c.privateKeyPath || '', placeholder: '私钥文件路径，例如 C:\\Users\\me\\.ssh\\id_ed25519' });
    const passphrase = el('input', { type: 'password', value: '', placeholder: c.has_passphrase ? '已保存，留空则不修改' : '私钥口令（可选）' });
    const browseBtn = el('button', { class: 'ghost', type: 'button', onclick: async () => {
      const p = await window.api.dialog.openFile({ title: '选择私钥文件' });
      if (p) keyPath.value = p;
    } }, '浏览…');

    const pwdSection = el('div', { class: 'field' }, el('label', {}, '密码'), password);
    const keySection = el('div', {},
      el('div', { class: 'field' }, el('label', {}, '私钥文件'), el('div', { class: 'input-with-btn' }, keyPath, browseBtn)),
      el('div', { class: 'field' }, el('label', {}, '私钥口令'), passphrase));
    const agentSection = el('div', { class: 'field-hint', style: 'margin-bottom:12px' },
      '使用系统 SSH Agent（Windows 上为 Pageant / OpenSSH Agent）。请确保代理已运行并加载了密钥。');

    const radios = {};
    const radioRow = el('div', { class: 'radio-row' });
    const sections = { password: pwdSection, key: keySection, agent: agentSection };
    const labels = { password: '密码', key: '私钥', agent: 'Agent' };
    const selectAuth = (type) => {
      for (const t of Object.keys(sections)) {
        sections[t].hidden = t !== type;
        radios[t].classList.toggle('checked', t === type);
      }
    };
    for (const t of ['password', 'key', 'agent']) {
      const lbl = el('label', {}, labels[t]);
      radios[t] = lbl;
      lbl.addEventListener('click', () => selectAuth(t));
      radioRow.append(lbl);
    }

    const errLine = el('div', { class: 'form-error' });
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', {}, '名称'), name),
      el('div', { class: 'field-row' },
        el('div', { class: 'field', style: 'flex:2' }, el('label', {}, '主机 *'), host),
        el('div', { class: 'field' }, el('label', {}, '端口'), port)),
      el('div', { class: 'field' }, el('label', {}, '用户名 *'), username),
      el('div', { class: 'field' }, el('label', {}, '认证方式'), radioRow),
      pwdSection, keySection, agentSection, errLine);
    selectAuth(authType);

    const gather = () => {
      const type = Object.keys(radios).find((t) => radios[t].classList.contains('checked')) || 'password';
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
      if (!conn.host) { errLine.textContent = '请填写主机地址'; return; }
      if (!conn.username) { errLine.textContent = '请填写用户名'; return; }
      try {
        const saved = await window.api.connections.save(conn);
        await App.connections.refresh();
        close();
        App.toast(isEdit ? '连接已更新' : '连接已保存', { type: 'success' });
        if (thenConnect) await App.connections.connect(saved.id);
      } catch (e) {
        errLine.textContent = e.message || String(e);
      }
    };

    App.modal({
      title: isEdit ? '编辑连接' : '新建连接',
      body,
      width: 480,
      buttons: [
        { label: '取消', class: 'ghost', onClick: (close) => close() },
        { label: '保存', class: 'ghost', onClick: (close) => save(close, false) },
        { label: '保存并连接', class: 'primary', onClick: (close) => save(close, true) },
      ],
    });
  },
};
