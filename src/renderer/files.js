'use strict';
// Remote file tree + text editor + file operations.
App.files = {
  _mdToken: 0,
  _recent: [],
  _recentLoaded: false,
  _revealToken: 0,
  RECENT_LIMIT: 40,
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

  async ensureRecent() {
    if (this._recentLoaded) return;
    this._recentLoaded = true;
    try {
      const list = await window.api.settings.get('recentFiles', []);
      this._recent = Array.isArray(list) ? list.filter((item) => item && item.connId && item.path) : [];
    } catch {
      this._recent = [];
    }
  },

  recentUri(item) {
    const path = String(item.path || '').startsWith('/') ? item.path : `/${item.path || ''}`;
    return `ssh://${item.connId}${path}`;
  },

  recentConn(item) {
    const c = (App.state.connections || []).find((x) => x.id === item.connId);
    if (!c) return null;
    return {
      name: c.name || `${c.username}@${c.host}`,
      host: `${c.username}@${c.host}:${c.port || 22}`,
    };
  },

  async rememberRecent(entry) {
    if (!entry || !entry.path || !App.state.activeId) return;
    await this.ensureRecent();
    const item = {
      connId: App.state.activeId,
      path: entry.path,
      name: entry.name || this.basename(entry.path),
      at: Date.now(),
    };
    this._recent = [item, ...this._recent.filter((x) => !(x.connId === item.connId && x.path === item.path))];
    if (this._recent.length > this.RECENT_LIMIT) this._recent.length = this.RECENT_LIMIT;
    try { await window.api.settings.set('recentFiles', this._recent); } catch { /* keep the in-memory list */ }
  },

  renderRecent() {
    const list = $('#recent-list');
    const empty = $('#recent-empty');
    if (!list) return;
    list.innerHTML = '';
    const items = this._recent || [];
    if (empty) empty.hidden = items.length > 0;
    for (const item of items) {
      const name = item.name || this.basename(item.path);
      const conn = this.recentConn(item);
      const mark = conn
        ? el('span', { class: 'recent-conn' },
            el('span', { class: 'recent-conn-name' }, conn.name),
            el('span', { class: 'recent-conn-host' }, conn.host))
        : el('span', { class: 'recent-conn missing' }, t('recent.connMissing'));
      list.append(el('li', {},
        el('button', {
          type: 'button',
          class: 'recent-item',
          title: this.recentUri(item),
          onclick: () => this.openRecent(item),
        },
          el('span', { class: 'recent-name' }, name),
          mark,
          el('span', { class: 'recent-path' }, item.path))));
    }
  },

  async clearRecent() {
    this._recent = [];
    this._recentLoaded = true;
    try { await window.api.settings.set('recentFiles', []); } catch { /* still clear the view */ }
    this.renderRecent();
  },

  async forgetConnection(connId) {
    await this.ensureRecent();
    const next = this._recent.filter((item) => item.connId !== connId);
    if (next.length === this._recent.length) return;
    this._recent = next;
    try { await window.api.settings.set('recentFiles', this._recent); } catch { /* ignore */ }
    this.renderRecent();
  },

  async retargetRecent(connId, fromPath, toPath) {
    await this.ensureRecent();
    let changed = false;
    this._recent = this._recent.map((item) => {
      if (item.connId !== connId || item.path !== fromPath) return item;
      changed = true;
      return { ...item, path: toPath, name: this.basename(toPath) };
    });
    if (!changed) return;
    try { await window.api.settings.set('recentFiles', this._recent); } catch { /* ignore */ }
    this.renderRecent();
  },

  async openRecent(item) {
    const conn = App.state.connections.find((c) => c.id === item.connId);
    if (!conn) {
      App.toast(t('recent.missing'), { type: 'warn' });
      return;
    }
    const state = App.state.sessions[item.connId] && App.state.sessions[item.connId].state;
    if (state !== 'connected') await App.connections.connect(item.connId);
    else if (App.state.activeId !== item.connId || $('#workspace').hidden) await App.connections.setActive(item.connId);
    if (App.state.activeId !== item.connId) return;
    const session = App.state.sessions[item.connId];
    if (!session || session.state !== 'connected') return;
    const entry = { path: item.path, name: item.name || this.basename(item.path), type: 'file' };
    await this.openFile(entry);
    await this.revealInTree(entry.path);
  },

  isUnder(root, filePath) {
    const base = this.normalizeRemote(root || '/');
    const file = this.normalizeRemote(filePath || '/');
    if (base === '/') return file.startsWith('/');
    return file === base || file.startsWith(base + '/');
  },

  // Expand every parent of filePath under the current tree root, select the
  // file, and scroll the tree pane so that row is in view. A file outside the
  // current root moves the root to the home directory when the file lives
  // there, otherwise to the file's parent folder.
  async revealInTree(filePath) {
    const token = ++this._revealToken;
    const id = App.state.activeId;
    if (!id || !filePath) return;
    const alive = () => token === this._revealToken && App.state.activeId === id;
    let target = this.normalizeRemote(filePath);
    try {
      const real = await window.api.fs.realpath(id, filePath);
      if (!alive()) return;
      if (real) target = this.normalizeRemote(real);
    } catch { /* a missing path still gets one attempt against the tree */ }
    if (!alive()) return;
    if (!this.isUnder(App.state.cwd || '/', target)) {
      let root = this.dirname(target);
      try {
        const home = await this.homePath(id);
        if (!alive()) return;
        if (home && this.isUnder(home, target)) root = home;
      } catch { /* keep the parent directory */ }
      if (this.normalizeRemote(App.state.cwd || '/') !== this.normalizeRemote(root)) {
        await this.navigate(root);
        if (!alive()) return;
      }
      if (!this.isUnder(App.state.cwd || '/', target)) return;
    }
    const found = await this.expandTo(target, alive);
    if (alive() && !found) App.toast(t('files.reveal.missing'), { type: 'warn' });
  },

  async expandTo(filePath, alive) {
    const cwd = this.normalizeRemote(App.state.cwd || '/');
    const target = this.normalizeRemote(filePath);
    if (!this.isUnder(cwd, target) || target === cwd) return false;
    const rest = cwd === '/' ? target.slice(1) : target.slice(cwd.length + 1);
    const parts = rest.split('/').filter(Boolean);
    let dir = cwd;
    for (let i = 0; i < parts.length; i++) {
      if (alive && !alive()) return false;
      const full = dir === '/' ? '/' + parts[i] : dir + '/' + parts[i];
      const row = $('#tree') && $('#tree').querySelector(`.tree-node[data-path="${CSS.escape(full)}"]`);
      if (!row || !row.isConnected) return false;
      const last = i === parts.length - 1;
      if (last) {
        this.select({ path: full, name: parts[i], type: 'file' }, row);
        row.classList.remove('located');
        void row.offsetWidth;
        row.classList.add('located');
        this.scrollTreeTo(row);
        return true;
      }
      if (typeof row._setExpanded !== 'function') return false;
      await row._setExpanded(true);
      if (alive && !alive()) return false;
      dir = full;
    }
    return false;
  },

  scrollTreeTo(row) {
    const pane = $('#tree-pane');
    if (!pane || !row) return;
    if (App.layout && App.layout.state.treeCollapsed) App.layout.toggleTree(false);
    const align = () => {
      if (!row.isConnected) return;
      const paneRect = pane.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const top = pane.scrollTop + (rowRect.top - paneRect.top) - (pane.clientHeight - rowRect.height) / 2;
      pane.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    };
    requestAnimationFrame(align);
  },

  async init(id) {
    await this.ensureRecent();
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
      const state = { loaded: false, expanded: false };
      let pending = null;
      const setExpanded = async (open) => {
        state.expanded = !!open;
        twisty.classList.toggle('open', state.expanded);
        childUl.hidden = !state.expanded;
        if (!state.expanded || state.loaded) return;
        if (!pending) {
          pending = (async () => {
            childUl.append(el('li', { class: 'tree-loading' }, t('files.loading')));
            try {
              const res = await window.api.fs.list(App.state.activeId, entry.path);
              childUl.innerHTML = '';
              if (!res.entries.length) childUl.append(el('li', { class: 'tree-loading' }, t('files.empty')));
              for (const ch of res.entries) childUl.append(this.makeNode(ch));
              state.loaded = true;
            } catch (err) {
              childUl.innerHTML = '';
              childUl.append(el('li', { class: 'tree-loading' }, t('files.loadFailed')));
              App.toast(App.errMsg(err), { type: 'error' });
              state.loaded = false;
              state.expanded = false;
              twisty.classList.remove('open');
              childUl.hidden = true;
            } finally {
              pending = null;
            }
          })();
        }
        await pending;
      };
      row._setExpanded = setExpanded;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.select(entry, row);
        await setExpanded(!state.expanded);
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
      $('#editor-path').title = t('files.reveal.title');
      $('#editor-info').textContent = `${fmtBytes(data.size)} · ${fmtTime(data.mtime)} · UTF-8`;
      $('#editor-modified').hidden = true;
      const editor = $('#editor');
      editor.value = data.content;
      editor.disabled = false;
      this.updateGutter();
      if (markdown) this.setMdMode('preview');
      else editor.focus();
      await this.rememberRecent(entry);
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
    this.renderMermaid(box, token);
  },

  loadMermaid() {
    if (window.mermaid && typeof window.mermaid.render === 'function') return Promise.resolve(window.mermaid);
    if (this._mermaidLoading) return this._mermaidLoading;
    this._mermaidLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid.min.js';
      s.async = true;
      s.onload = () => (window.mermaid && window.mermaid.render) ? resolve(window.mermaid) : reject(new Error('mermaid'));
      s.onerror = () => reject(new Error('mermaid'));
      document.head.append(s);
    });
    return this._mermaidLoading;
  },

  mermaidConfig() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    const dark = document.documentElement.dataset.theme !== 'daylight';
    const fg = pick('--fg', '#dce6f2');
    const bg = pick('--bg', '#0a0e13');
    const surface = pick('--surface-2', '#1c2430');
    const accent = pick('--accent', '#2ee6a8');
    const border = pick('--border', '#2a3544');
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      logLevel: 'fatal',
      fontFamily: pick('--sans', 'sans-serif'),
      theme: 'base',
      themeVariables: {
        darkMode: dark,
        background: bg,
        primaryColor: surface,
        primaryTextColor: fg,
        primaryBorderColor: accent,
        secondaryColor: pick('--surface-3', '#242d3b'),
        secondaryTextColor: fg,
        tertiaryColor: pick('--surface', '#141a22'),
        tertiaryTextColor: fg,
        lineColor: pick('--fg-muted', '#93a0b4'),
        textColor: fg,
        mainBkg: surface,
        nodeBorder: accent,
        clusterBkg: pick('--surface', '#141a22'),
        clusterBorder: border,
        titleColor: fg,
        edgeLabelBackground: bg,
        actorBkg: surface,
        actorBorder: accent,
        actorTextColor: fg,
        signalColor: fg,
        signalTextColor: fg,
        noteBkgColor: pick('--surface-3', '#242d3b'),
        noteTextColor: fg,
        noteBorderColor: border,
      },
      flowchart: { htmlLabels: false, useMaxWidth: true },
      sequence: { useMaxWidth: true },
    };
  },

  // Mermaid's SVG is drawn from untrusted remote text. Keep the picture, drop
  // anything that could run or navigate: scripts, event handlers, and foreign
  // HTML. Fragment links inside the SVG stay so arrow markers still resolve.
  adoptMermaidSvg(svgText) {
    const doc = new DOMParser().parseFromString(String(svgText || ''), 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('bad svg');
    const drop = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'link']);
    const cleanStyle = (value) => String(value || '').replace(/url\s*\(\s*(['"]?)(?!#)[^)'"]*\1\s*\)/gi, 'none');
    const walk = (el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
        if (name === 'href' || name.endsWith(':href')) {
          if (value && !value.startsWith('#') && !/^https?:/i.test(value)) el.removeAttribute(attr.name);
        }
        if (name === 'style') el.setAttribute(attr.name, cleanStyle(value));
      }
      for (const child of [...el.children]) {
        if (drop.has(child.localName.toLowerCase())) { child.remove(); continue; }
        if (child.localName === 'style') child.textContent = cleanStyle(child.textContent);
        walk(child);
      }
    };
    walk(root);
    return document.importNode(root, true);
  },

  showMermaidError(block) {
    const view = block.querySelector('.md-mermaid-view');
    const err = block.querySelector('.md-mermaid-error');
    const pre = block.querySelector('pre');
    if (view) { view.hidden = true; view.replaceChildren(); }
    if (pre) pre.hidden = false;
    if (err) { err.hidden = false; err.textContent = t('md.mermaidFailed'); }
  },

  async renderMermaid(box, token) {
    const blocks = [...box.querySelectorAll('.md-mermaid')];
    if (!blocks.length) return;
    let api;
    try { api = await this.loadMermaid(); }
    catch {
      if (token !== this._mdToken) return;
      blocks.forEach((block) => this.showMermaidError(block));
      return;
    }
    if (token !== this._mdToken) return;
    api.initialize(this.mermaidConfig());
    let n = 0;
    for (const block of blocks) {
      if (token !== this._mdToken) return;
      const code = block.querySelector('code');
      const src = code ? code.textContent : '';
      const view = block.querySelector('.md-mermaid-view');
      if (!view || src.length > 48 * 1024) { this.showMermaidError(block); continue; }
      const id = `mmd${token}x${n++}`;
      try {
        const { svg } = await api.render(id, src);
        if (token !== this._mdToken || !view.isConnected) return;
        // render() also stamps this id onto the <svg>. Drop any scratch node
        // mermaid left in <body> first, then clear the id so the picture we
        // insert is not removed along with that scratch node.
        const scratch = document.getElementById(id);
        if (scratch && !view.contains(scratch)) scratch.remove();
        const node = this.adoptMermaidSvg(svg);
        node.removeAttribute('id');
        view.replaceChildren(node);
        view.hidden = false;
        const pre = block.querySelector('pre');
        const err = block.querySelector('.md-mermaid-error');
        if (pre) pre.hidden = true;
        if (err) { err.hidden = true; err.textContent = ''; }
      } catch {
        if (token !== this._mdToken) return;
        this.showMermaidError(block);
      }
    }
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
    const block = btn.closest('.md-code, .md-mermaid');
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
    this.renderRecent();
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
    await this.retargetRecent(id, sel.path, newPath);
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
