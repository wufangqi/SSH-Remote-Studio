'use strict';
// Remote file tree + text editor + file operations.
App.files = {
  _mdToken: 0,
  join(dir, name) { return dir.endsWith('/') ? dir + name : dir + '/' + name; },
  dirname(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); },
  basename(p) { return p.slice(p.lastIndexOf('/') + 1); },
  isMarkdown(p) { return /\.(md|markdown|mdown|mkd)$/i.test(String(p || '')); },

  normalizeRemote(p) {
    const out = [];
    for (const seg of String(p || '/').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return '/' + out.join('/');
  },

  resolveRemoteImage(mdPath, src) {
    let s = String(src || '').trim().split('#')[0].split('?')[0];
    if (!s) return null;
    try { s = decodeURIComponent(s); } catch { /* keep raw */ }
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
    if (s.startsWith('/')) return this.normalizeRemote(s);
    return this.normalizeRemote(this.dirname(mdPath) + '/' + s);
  },

  mimeFor(p) {
    const ext = String(p || '').toLowerCase().split('.').pop();
    return ({
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
    })[ext] || null;
  },

  // The per-connection home directory wins; ~ is expanded against the real
  // server home. Invalid/non-directory paths fall back to the server home so
  // a stale setting never leaves the file panel unusable.
  async homePath(id) {
    const c = App.state.connections.find((x) => x.id === id);
    const configured = c && c.homeDir ? String(c.homeDir).trim() : '';
    if (!configured) return window.api.fs.home(id);
    try {
      let p = configured;
      if (p === '~' || p.startsWith('~/')) {
        const remote = await window.api.fs.home(id);
        p = p === '~' ? remote : remote.replace(/\/$/, '') + p.slice(1);
      }
      const real = await window.api.fs.realpath(id, p);
      const st = await window.api.fs.stat(id, real);
      if (!st || st.type !== 'dir') throw new Error('not a directory');
      return real;
    } catch {
      App.toast(t('files.homeFailed', { path: configured }), { type: 'warn', title: t('files.listFailed') });
      return window.api.fs.home(id);
    }
  },

  async init(id) {
    App.state.openFile = null;
    App.state.selected = null;
    this.closeEditor();
    const home = await this.homePath(id);
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
      const markdown = this.isMarkdown(entry.path);
      // Drop the previous document's preview before anything of the new file
      // is shown: the old tree can hold megabytes of image data URLs, and the
      // token bump invalidates SFTP reads that are still in flight for it.
      // Done after the read succeeds so a failed open never blanks the view.
      this._mdToken++;
      this.closeImagePreview();
      $('#markdown-preview').innerHTML = '';
      App.state.openFile = {
        path: entry.path, content: data.content, original: data.content,
        binary: false, size: data.size, mtime: data.mtime, mode: data.mode, dirty: false,
        markdown, mdMode: markdown ? 'preview' : 'edit',
      };
      $('#editor-empty').hidden = true;
      $('#editor-header').hidden = false;
      $('#editor-wrap').hidden = false;
      $('#markdown-preview').hidden = true;
      $('#btn-md-mode').hidden = !markdown;
      $('#btn-save').hidden = false;
      $('#editor-path').textContent = entry.path;
      $('#editor-path').title = entry.path;
      $('#editor-info').textContent = `${fmtBytes(data.size)} · ${fmtTime(data.mtime)} · UTF-8`;
      $('#editor-modified').hidden = true;
      const editor = $('#editor');
      editor.value = data.content;
      editor.disabled = false;
      this.updateGutter();
      if (markdown) this.setMdMode('preview');
      else editor.focus();
    } catch (e) {
      App.setStatus();
      App.toast(App.errMsg(e), { type: 'error', title: t('files.openFailed') });
    }
  },

  setMdMode(mode) {
    const f = App.state.openFile;
    if (!f || !f.markdown) return;
    f.mdMode = mode === 'preview' ? 'preview' : 'edit';
    const preview = f.mdMode === 'preview';
    $('#editor-wrap').hidden = preview;
    $('#markdown-preview').hidden = !preview;
    $('#btn-save').hidden = preview;
    const btn = $('#btn-md-mode');
    if (btn) {
      const label = btn.querySelector('span');
      const use = btn.querySelector('use');
      if (label) {
        label.textContent = t(preview ? 'md.edit' : 'md.preview');
        label.setAttribute('data-i18n', preview ? 'md.edit' : 'md.preview');
      }
      if (use) use.setAttribute('href', preview ? '#i-edit' : '#i-eye');
    }
    if (preview) this.renderMarkdownPreview();
    else {
      this.closeImagePreview();
      this.updateGutter();
      $('#editor').focus();
    }
  },

  toggleMdMode() {
    const f = App.state.openFile;
    if (!f || !f.markdown) return;
    this.setMdMode(f.mdMode === 'preview' ? 'edit' : 'preview');
  },

  renderMarkdownPreview() {
    const f = App.state.openFile;
    if (!f || !f.markdown) return;
    const box = $('#markdown-preview');
    const token = ++this._mdToken;
    this.closeImagePreview();
    box.innerHTML = AppMarkdown.render($('#editor').value);
    // The renderer only emits markup + data-i18n* hooks; labels live in the
    // dictionary, so they must be applied before the enhancements are wired.
    applyI18n(box);
    this.enhancePreview(box);
    this.loadMarkdownImages(box, token);
  },

  // ---- preview reading aids (copy / zoom / anchors) ----
  // CSP is `script-src 'self'`, so the renderer never emits inline handlers:
  // every interaction here goes through one delegated pair of listeners on
  // the preview container, which survives innerHTML re-renders.
  enhancePreview(box) {
    for (const img of box.querySelectorAll('img.md-img')) {
      img.setAttribute('role', 'button');
      if (!img.hasAttribute('tabindex')) img.setAttribute('tabindex', '0');
    }
    if (box.__mdEnhanced) return;
    box.__mdEnhanced = true;
    box.addEventListener('click', (e) => this.onPreviewClick(e));
    box.addEventListener('keydown', (e) => this.onPreviewKeyDown(e));
    const lb = $('#md-lightbox');
    if (lb) lb.addEventListener('click', (e) => {
      // The scrim and the close button dismiss; a click on the picture itself
      // does not, so zooming can't be lost by an over-eager click.
      if (e.target === lb || (e.target.closest && e.target.closest('.md-lightbox-close'))) this.closeImagePreview();
    });
  },

  onPreviewClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const btn = t.closest('.md-code-copy');
    if (btn) { e.preventDefault(); this.copyCodeBlock(btn); return; }
    const anchor = t.closest('a.md-anchor');
    if (anchor) { e.preventDefault(); this.scrollToHeading(anchor); return; }
    const img = t.closest('img.md-img');
    if (img) { e.preventDefault(); this.openImagePreview(img); }
  },

  onPreviewKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const img = e.target && e.target.closest && e.target.closest('img.md-img');
    if (img && e.target === img) { e.preventDefault(); this.openImagePreview(img); }
  },

  // Clipboard on a file:// window needs both paths: the async API is the
  // polite one but rejects while the window is unfocused, and execCommand is
  // the only thing left there. Neither failure is fatal.
  async writeClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall back to execCommand */ }
    try {
      const ta = el('textarea', { style: 'position:fixed;top:-1000px;left:0;opacity:0' }, text);
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch { return false; }
  },

  async copyCodeBlock(btn) {
    const block = btn.closest('.md-code');
    const code = block && block.querySelector('pre code');
    if (!code) return;
    if (await this.writeClipboard(code.textContent)) this.markCopied(btn);
    else App.toast(t('md.copyFailed'), { type: 'error', timeout: 2600 });
  },

  // In-button feedback instead of a toast: the copied text is right there and
  // a popup would cover the next block.
  markCopied(btn) {
    if (btn.__mdCopyTimer) clearTimeout(btn.__mdCopyTimer);
    const label = btn.querySelector('[data-i18n="md.copy"]');
    const use = btn.querySelector('use');
    btn.classList.add('copied');
    // Restored through t() rather than a cached string, so a language switch
    // while the button reads "Copied" still puts back the right words.
    if (label) label.textContent = t('md.copied');
    if (use) use.setAttribute('href', '#i-check');
    btn.__mdCopyTimer = setTimeout(() => {
      btn.__mdCopyTimer = null;
      if (!btn.isConnected) return;
      btn.classList.remove('copied');
      if (label) label.textContent = t('md.copy');
      if (use) use.setAttribute('href', '#i-copy');
    }, 1600);
  },

  scrollToHeading(anchor) {
    const heading = anchor.parentElement;
    if (!heading || !heading.id) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    heading.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    // replaceState keeps the anchor shareable without pushing a history entry.
    try { history.replaceState(null, '', '#' + heading.id); } catch { /* non-fatal */ }
  },

  openImagePreview(img) {
    const box = $('#md-lightbox');
    const big = $('#md-lightbox-img');
    if (!box || !big || !img) return;
    // Only an image that actually resolved can be zoomed: loadMarkdownImages
    // assigns src after the SFTP read succeeds, so a missing src means the
    // picture is still loading or failed (then it is a .md-img-error span).
    const src = img.getAttribute('src');
    if (!src) return;
    this.__mdLbTrigger = img;
    big.src = src;
    big.alt = img.alt || '';
    box.hidden = false;
    if (!this.__mdLbKey) this.__mdLbKey = (e) => this.onLightboxKey(e);
    document.addEventListener('keydown', this.__mdLbKey, true);
    const closeBtn = $('#md-lightbox-close');
    if (closeBtn) closeBtn.focus();
  },

  onLightboxKey(e) {
    if (e.key === 'Tab') {
      // The zoom dialog has exactly one control, so the tab ring stays inside
      // it instead of wandering through the document behind the scrim.
      e.preventDefault();
      const btn = $('#md-lightbox-close');
      if (btn) btn.focus();
      return;
    }
    if (e.key !== 'Escape') return;
    // Capture + stop: the zoom layer is on top, so Esc must not also close the
    // theme menu or a modal underneath it.
    e.preventDefault();
    e.stopPropagation();
    this.closeImagePreview();
  },

  closeImagePreview() {
    const box = $('#md-lightbox');
    if (this.__mdLbKey) document.removeEventListener('keydown', this.__mdLbKey, true);
    if (box && box.hidden) return;
    const big = $('#md-lightbox-img');
    // Drop the (possibly 20 MiB) data URL as soon as the layer is hidden.
    if (big) { big.removeAttribute('src'); big.alt = ''; }
    if (box) box.hidden = true;
    const trigger = this.__mdLbTrigger;
    this.__mdLbTrigger = null;
    if (trigger && trigger.isConnected) trigger.focus();
  },

  async loadMarkdownImages(box, token) {
    const f = App.state.openFile;
    const id = App.state.activeId;
    if (!f || !id) return;
    const imgs = Array.from(box.querySelectorAll('img[data-md-src]'));
    await Promise.all(imgs.map(async (img) => {
      const raw = img.getAttribute('data-md-src') || '';
      if (/^data:image\//i.test(raw)) { img.removeAttribute('data-md-src'); img.src = raw; return; }
      if (/^https?:\/\//i.test(raw)) { img.removeAttribute('data-md-src'); img.src = raw; return; }
      const remote = this.resolveRemoteImage(f.path, raw);
      const mime = remote && this.mimeFor(remote);
      if (!remote || !mime) { this.markImageError(img, raw); return; }
      try {
        const data = await window.api.fs.read(id, remote, { encoding: 'base64', maxBytes: 20 * 1024 * 1024 });
        if (token !== this._mdToken || App.state.openFile !== f || App.state.activeId !== id) return;
        img.removeAttribute('data-md-src');
        img.src = `data:${mime};base64,${data.content}`;
      } catch (e) {
        if (token !== this._mdToken) return;
        this.markImageError(img, raw, e);
      }
    }));
  },

  markImageError(img, raw, err) {
    const span = document.createElement('span');
    span.className = 'md-img-error';
    span.textContent = err ? `${t('md.imageFailed', { path: raw })} (${App.errMsg(err)})` : t('md.imageFailed', { path: raw });
    img.replaceWith(span);
  },

  closeEditor() {
    App.state.openFile = null;
    this._gutterLines = 0;
    this._mdToken = (this._mdToken || 0) + 1;
    this.closeImagePreview();
    $('#editor-header').hidden = true;
    $('#editor-wrap').hidden = true;
    $('#markdown-preview').hidden = true;
    $('#markdown-preview').innerHTML = '';
    $('#btn-md-mode').hidden = true;
    $('#btn-save').hidden = false;
    $('#editor-empty').hidden = false;
    $('#editor').value = '';
    $('#gutter').textContent = '';
  },

  async save({ force = false } = {}) {
    const f = App.state.openFile;
    if (!f || f.binary) return;
    const id = App.state.activeId;
    try {
      App.setStatus(t('status.saving'));
      const content = $('#editor').value;
      const res = await window.api.fs.write(id, f.path, content, {
        mode: f.mode,
        expectedMtime: force ? undefined : f.mtime,
      });
      f.original = content; f.content = content; f.dirty = false;
      f.size = res.size; f.mtime = res.mtime;
      $('#editor-modified').hidden = true;
      $('#editor-info').textContent = `${fmtBytes(res.size)} · ${fmtTime(res.mtime)} · UTF-8`;
      App.setStatus(t('status.saved'));
      App.toast(t('toast.fileSaved', { name: this.basename(f.path) }), { type: 'success', timeout: 2200 });
    } catch (e) {
      App.setStatus();
      if (App.errCode(e) === 'ECONFLICT' && !force) {
        const ok = await App.confirm({
          title: t('files.conflict.title'),
          message: t('files.conflict.msg', { name: this.basename(f.path) }),
          danger: true,
          okLabel: t('files.conflict.ok'),
        });
        if (ok) await this.save({ force: true });
        return;
      }
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
    const v = $('#editor').value;
    let n = 1;
    let i = -1;
    while ((i = v.indexOf('\n', i + 1)) !== -1) n++;
    this._gutterLines = n;
    this.syncGutter();
  },

  // Only the visible slice of line numbers is materialized: rebuilding the
  // whole gutter on every keystroke stalls on files near the 8 MiB read cap.
  syncGutter() {
    const editor = $('#editor');
    const gutter = $('#gutter');
    const lh = parseFloat(getComputedStyle(editor).lineHeight) || 20;
    const total = this._gutterLines || 1;
    const start = Math.max(0, Math.floor(editor.scrollTop / lh));
    const end = Math.min(total, start + Math.ceil(editor.clientHeight / lh) + 2);
    let s = '';
    for (let i = start + 1; i <= end; i++) s += i + '\n';
    gutter.textContent = s;
    gutter.scrollTop = editor.scrollTop - start * lh;
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
