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
      App.toast(App.errMsg(e), { type: 'error', title: t('files.jumpFailed') });
    }
  },

  async loadRoot() {
    const id = App.state.activeId;
    const cwd = App.state.cwd;
    $('#path-input').value = cwd;
    const tree = $('#tree');
    tree.innerHTML = '';
    tree.append(el('li', { class: 'tree-loading' }, t('files.loading')));
    try {
      const res = await window.api.fs.list(id, cwd);
      tree.innerHTML = '';
      if (!res.entries.length) tree.append(el('li', { class: 'tree-loading' }, t('files.emptyDir')));
      for (const entry of res.entries) tree.append(this.makeNode(entry));
      App.setStatusRight(t('files.items', { n: res.entries.length, cwd }));
    } catch (e) {
      tree.innerHTML = '';
      tree.append(el('li', { class: 'tree-loading' }, t('files.loadFailed')));
      App.toast(App.errMsg(e), { type: 'error', title: t('files.listFailed') });
    }
  },

  makeNode(entry) {
    const isDir = entry.type === 'dir';
    const twisty = el('span', { class: 'twisty' }, isDir ? icon('chev-r') : null);
    const iconCls = isDir ? 'dir' : entry.type === 'symlink' ? 'link' : 'file';
    const iconNode = el('span', { class: 'ticon ' + iconCls }, icon(isDir ? 'folder' : entry.type === 'symlink' ? 'link' : 'file'));
    const name = el('span', { class: 'tname', title: entry.path }, entry.name);
    const size = el('span', { class: 'tsize' }, isDir ? '' : fmtBytes(entry.size));
    const row = el('div', { class: 'tree-node', 'data-path': entry.path }, twisty, iconNode, name, size);
    const li = el('li', {}, row);

    if (isDir) {
      const childUl = el('ul', { hidden: true });
      li.append(childUl);
      let loaded = false, expanded = false;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.select(entry, row);
        expanded = !expanded;
        twisty.classList.toggle('open', expanded);
        childUl.hidden = !expanded;
        if (expanded && !loaded) {
          loaded = true;
          childUl.append(el('li', { class: 'tree-loading' }, t('files.loading')));
          try {
            const res = await window.api.fs.list(App.state.activeId, entry.path);
            childUl.innerHTML = '';
            if (!res.entries.length) childUl.append(el('li', { class: 'tree-loading' }, t('files.empty')));
            for (const ch of res.entries) childUl.append(this.makeNode(ch));
          } catch (err) {
            childUl.innerHTML = '';
            childUl.append(el('li', { class: 'tree-loading' }, t('files.loadFailed')));
            App.toast(App.errMsg(err), { type: 'error' });
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
      App.setStatus(t('status.opening'));
      const data = await window.api.fs.read(id, entry.path);
      App.setStatus();
      if (data.binary) {
        App.toast(t('files.binary', { name: entry.name, size: fmtBytes(data.size) }), { type: 'warn', title: t('files.binary.title') });
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
      $('#editor-info').textContent = `${fmtBytes(data.size)} · ${fmtTime(data.mtime)} · UTF-8`;
      $('#editor-modified').hidden = true;
      const editor = $('#editor');
      editor.value = data.content;
      editor.disabled = false;
      this.updateGutter();
      editor.focus();
    } catch (e) {
      App.setStatus();
      App.toast(App.errMsg(e), { type: 'error', title: t('files.openFailed') });
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
      App.setStatus(t('status.saving'));
      const content = $('#editor').value;
      const res = await window.api.fs.write(id, f.path, content, { mode: f.mode });
      f.original = content; f.content = content; f.dirty = false;
      f.size = res.size; f.mtime = res.mtime;
      $('#editor-modified').hidden = true;
      $('#editor-info').textContent = `${fmtBytes(res.size)} · ${fmtTime(res.mtime)} · UTF-8`;
      App.setStatus(t('status.saved'));
      App.toast(t('toast.fileSaved', { name: this.basename(f.path) }), { type: 'success', timeout: 2200 });
    } catch (e) {
      App.setStatus();
      App.toast(App.errMsg(e), { type: 'error', title: t('files.saveFailed') });
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
    const name = await App.prompt({ title: t('newFile.title'), label: t('newFile.label'), placeholder: t('newFile.ph') });
    if (!name) return;
    const id = App.state.activeId;
    const p = this.join(App.state.cwd, name);
    await App.guard(t('newFile.title'), () => window.api.fs.write(id, p, ''));
    await this.loadRoot();
    await this.openFile({ path: p, name, type: 'file' });
  },

  async newDir() {
    const name = await App.prompt({ title: t('newDir.title'), label: t('newDir.label'), placeholder: t('newDir.ph') });
    if (!name) return;
    const id = App.state.activeId;
    await App.guard(t('newDir.title'), () => window.api.fs.mkdir(id, this.join(App.state.cwd, name)));
    await this.loadRoot();
  },

  async upload() {
    const id = App.state.activeId;
    const local = await window.api.dialog.openFile({ title: t('upload.dialog') });
    if (!local) return;
    const remote = this.join(App.state.cwd, this.basename(local.replace(/\\/g, '/')));
    await App.guard(t('upload.guard'), () => window.api.fs.upload(id, local, remote));
    await this.loadRoot();
    App.toast(t('toast.uploaded', { path: remote }), { type: 'success' });
  },

  async download() {
    const sel = App.state.selectedEntry;
    if (!sel || sel.type === 'dir') { App.toast(t('download.selectFile'), { type: 'warn' }); return; }
    const id = App.state.activeId;
    const local = await window.api.dialog.saveFile({ title: t('download.dialog'), defaultName: sel.name });
    if (!local) return;
    await App.guard(t('download.guard'), () => window.api.fs.download(id, sel.path, local));
    App.toast(t('toast.downloaded', { path: local }), { type: 'success' });
  },

  async rename() {
    const sel = App.state.selectedEntry;
    if (!sel) { App.toast(t('files.selectFirst'), { type: 'warn' }); return; }
    const id = App.state.activeId;
    const newName = await App.prompt({ title: t('rename.title'), label: t('rename.label'), value: sel.name });
    if (!newName || newName === sel.name) return;
    const newPath = this.join(this.dirname(sel.path), newName);
    await App.guard(t('rename.guard'), () => window.api.fs.rename(id, sel.path, newPath));
    if (App.state.openFile && App.state.openFile.path === sel.path) this.closeEditor();
    App.state.selected = null; App.state.selectedEntry = null;
    await this.loadRoot();
  },

  async remove() {
    const sel = App.state.selectedEntry;
    if (!sel) { App.toast(t('files.selectFirst'), { type: 'warn' }); return; }
    const ok = await App.confirm({
      title: t('remove.title'), danger: true, okLabel: t('conn.delete.ok'),
      message: t('remove.msg', { name: sel.name, dir: sel.type === 'dir' ? t('remove.dirPart') : '' }),
    });
    if (!ok) return;
    const id = App.state.activeId;
    await App.guard(t('remove.guard'), () => window.api.fs.remove(id, sel.path, { recursive: true }));
    if (App.state.openFile && App.state.openFile.path === sel.path) this.closeEditor();
    App.state.selected = null; App.state.selectedEntry = null;
    await this.loadRoot();
    App.toast(t('toast.removed'), { type: 'success' });
  },
};
