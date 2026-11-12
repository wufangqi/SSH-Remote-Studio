'use strict';
// Remote file tree + text editor + file operations.
App.files = {
  join(dir, name) { return dir.endsWith('/') ? dir + name : dir + '/' + name; },
  dirname(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); },
  basename(p) { return p.slice(p.lastIndexOf('/') + 1); },

  async init(id) {
    App.state.openFile = null;
    App.state.selected = null;
    this.closeEditor();
    const home = await window.api.fs.home(id);
    App.state.cwd = home || '/';
    await this.loadRoot();
  },

  async navigate(path) {
    const id = App.state.activeId;
    if (!id) return;
    try {
      const abs = await window.api.fs.realpath(id, path || '/');
      App.state.cwd = abs;
      await this.loadRoot();
    } catch (e) {
      App.toast(e.message, { type: 'error', title: '跳转失败' });
    }
  },

  async loadRoot() {
    const id = App.state.activeId;
    const cwd = App.state.cwd;
    $('#path-input').value = cwd;
    const tree = $('#tree');
    tree.innerHTML = '';
    tree.append(el('li', { class: 'tree-loading' }, '加载中…'));
    try {
      const res = await window.api.fs.list(id, cwd);
      tree.innerHTML = '';
      if (!res.entries.length) tree.append(el('li', { class: 'tree-loading' }, '（空目录）'));
      for (const entry of res.entries) tree.append(this.makeNode(entry));
      App.setStatusRight(`${res.entries.length} 项 · ${cwd}`);
    } catch (e) {
      tree.innerHTML = '';
      tree.append(el('li', { class: 'tree-loading' }, '加载失败'));
      App.toast(e.message, { type: 'error', title: '列出目录失败' });
    }
  },

  makeNode(entry) {
    const isDir = entry.type === 'dir';
    const twisty = el('span', { class: 'twisty' }, isDir ? '▶' : '');
    const icon = el('span', { class: 'ticon' }, isDir ? '📁' : entry.type === 'symlink' ? '🔗' : '📄');
    const name = el('span', { class: 'tname', title: entry.path }, entry.name);
    const size = el('span', { class: 'tsize' }, isDir ? '' : fmtBytes(entry.size));
    const row = el('div', { class: 'tree-node', 'data-path': entry.path }, twisty, icon, name, size);
    const li = el('li', {}, row);

    if (isDir) {
      const childUl = el('ul', { hidden: true });
      li.append(childUl);
      let loaded = false, expanded = false;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.select(entry, row);
        expanded = !expanded;
        twisty.textContent = expanded ? '▼' : '▶';
        childUl.hidden = !expanded;
        if (expanded && !loaded) {
          loaded = true;
          childUl.append(el('li', { class: 'tree-loading' }, '加载中…'));
          try {
            const res = await window.api.fs.list(App.state.activeId, entry.path);
            childUl.innerHTML = '';
            if (!res.entries.length) childUl.append(el('li', { class: 'tree-loading' }, '（空）'));
            for (const ch of res.entries) childUl.append(this.makeNode(ch));
          } catch (err) {
            childUl.innerHTML = '';
            childUl.append(el('li', { class: 'tree-loading' }, '加载失败'));
            App.toast(err.message, { type: 'error' });
            loaded = false;
          }
        }
      });
    } else {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(entry, row);
        this.openFile(entry);
      });
    }
    return li;
  },

  select(entry, row) {
    App.state.selected = entry.path;
    App.state.selectedEntry = entry;
    $all('.tree-node.selected').forEach((n) => n.classList.remove('selected'));
    if (row) row.classList.add('selected');
    else {
      const n = $(`.tree-node[data-path="${CSS.escape(entry.path)}"]`);
      if (n) n.classList.add('selected');
    }
  },

  async openFile(entry) {
    const id = App.state.activeId;
    try {
      App.setStatus('打开文件…');
      const data = await window.api.fs.read(id, entry.path);
      App.setStatus('就绪');
      if (data.binary) {
        App.toast(`「${entry.name}」是二进制文件（${fmtBytes(data.size)}），不支持文本编辑，可使用下载。`, { type: 'warn', title: '二进制文件' });
        return;
      }
      App.state.openFile = {
        path: entry.path, content: data.content, original: data.content,
        binary: false, size: data.size, mtime: data.mtime, mode: data.mode, dirty: false,
      };
      $('#editor-empty').hidden = true;
      $('#editor-header').hidden = false;
      $('#editor-wrap').hidden = false;
      $('#editor-path').textContent = entry.path;
      $('#editor-path').title = entry.path;
      $('#editor-info').textContent = `${fmtBytes(data.size)} · ${fmtTime(data.mtime)}`;
      $('#editor-modified').hidden = true;
      const editor = $('#editor');
      editor.value = data.content;
      editor.disabled = false;
      this.updateGutter();
      editor.focus();
    } catch (e) {
      App.setStatus('就绪');
      App.toast(e.message, { type: 'error', title: '打开文件失败' });
    }
  },

  closeEditor() {
    App.state.openFile = null;
    $('#editor-header').hidden = true;
    $('#editor-wrap').hidden = true;
    $('#editor-empty').hidden = false;
    $('#editor').value = '';
  },

  async save() {
    const f = App.state.openFile;
    if (!f || f.binary) return;
    const id = App.state.activeId;
    try {
      App.setStatus('保存中…');
      const content = $('#editor').value;
      const res = await window.api.fs.write(id, f.path, content, { mode: f.mode });
      f.original = content; f.content = content; f.dirty = false;
      f.size = res.size; f.mtime = res.mtime;
      $('#editor-modified').hidden = true;
      $('#editor-info').textContent = `${fmtBytes(res.size)} · ${fmtTime(res.mtime)}`;
      App.setStatus('已保存');
      App.toast(`已保存 ${this.basename(f.path)}`, { type: 'success', timeout: 2200 });
    } catch (e) {
      App.setStatus('就绪');
      App.toast(e.message, { type: 'error', title: '保存失败' });
    }
  },

  onEditorInput() {
    const f = App.state.openFile;
    if (!f) return;
    const dirty = $('#editor').value !== f.original;
    f.dirty = dirty;
    $('#editor-modified').hidden = !dirty;
    this.updateGutter();
  },

  updateGutter() {
    const lines = $('#editor').value.split('\n').length;
    let s = '';
    for (let i = 1; i <= lines; i++) s += i + '\n';
    $('#gutter').textContent = s;
    $('#gutter').scrollTop = $('#editor').scrollTop;
  },

  // ---- toolbar operations ----
  async newFile() {
    const name = await App.prompt({ title: '新建文件', label: '文件名', placeholder: '例如 notes.txt' });
    if (!name) return;
    const id = App.state.activeId;
    const p = this.join(App.state.cwd, name);
    await App.guard('新建文件', () => window.api.fs.write(id, p, ''));
    await this.loadRoot();
    await this.openFile({ path: p, name, type: 'file' });
  },

  async newDir() {
    const name = await App.prompt({ title: '新建文件夹', label: '文件夹名', placeholder: '例如 project' });
    if (!name) return;
    const id = App.state.activeId;
    await App.guard('新建文件夹', () => window.api.fs.mkdir(id, this.join(App.state.cwd, name)));
    await this.loadRoot();
  },

  async upload() {
    const id = App.state.activeId;
    const local = await window.api.dialog.openFile({ title: '选择要上传的文件' });
    if (!local) return;
    const remote = this.join(App.state.cwd, this.basename(local.replace(/\\/g, '/')));
    await App.guard('上传', () => window.api.fs.upload(id, local, remote));
    await this.loadRoot();
    App.toast(`已上传到 ${remote}`, { type: 'success' });
  },

  async download() {
    const sel = App.state.selectedEntry;
    if (!sel || sel.type === 'dir') { App.toast('请先在目录树中选择一个文件', { type: 'warn' }); return; }
    const id = App.state.activeId;
    const local = await window.api.dialog.saveFile({ title: '保存到本地', defaultName: sel.name });
    if (!local) return;
    await App.guard('下载', () => window.api.fs.download(id, sel.path, local));
    App.toast(`已下载到 ${local}`, { type: 'success' });
  },

  async rename() {
    const sel = App.state.selectedEntry;
    if (!sel) { App.toast('请先选择一个文件或文件夹', { type: 'warn' }); return; }
    const id = App.state.activeId;
    const newName = await App.prompt({ title: '重命名', label: '新名称', value: sel.name });
    if (!newName || newName === sel.name) return;
    const newPath = this.join(this.dirname(sel.path), newName);
    await App.guard('重命名', () => window.api.fs.rename(id, sel.path, newPath));
    if (App.state.openFile && App.state.openFile.path === sel.path) this.closeEditor();
    App.state.selected = null; App.state.selectedEntry = null;
    await this.loadRoot();
  },

  async remove() {
    const sel = App.state.selectedEntry;
    if (!sel) { App.toast('请先选择一个文件或文件夹', { type: 'warn' }); return; }
    const ok = await App.confirm({
      title: '删除', danger: true, okLabel: '删除',
      message: `确定删除「${sel.name}」吗？${sel.type === 'dir' ? '文件夹及其内容将被递归删除。' : ''}此操作不可撤销。`,
    });
    if (!ok) return;
    const id = App.state.activeId;
    await App.guard('删除', () => window.api.fs.remove(id, sel.path, { recursive: true }));
    if (App.state.openFile && App.state.openFile.path === sel.path) this.closeEditor();
    App.state.selected = null; App.state.selectedEntry = null;
    await this.loadRoot();
    App.toast('已删除', { type: 'success' });
  },
};
