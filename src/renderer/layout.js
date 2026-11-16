'use strict';
// Panel layout: collapse/restore the connection sidebar and file tree, plus
// pointer-drag resizing. Widths and collapsed states persist locally.
(function () {
  const DEFAULTS = { sidebar: 264, tree: 300 };
  const LIMITS = { sidebar: [180, 460], tree: [180, 640] };
  const KEYS = {
    sidebar: 'srs.sidebarWidth',
    tree: 'srs.treeWidth',
    sidebarCollapsed: 'srs.sidebarCollapsed',
    treeCollapsed: 'srs.treeCollapsed',
  };
  const byId = (id) => document.getElementById(id);
  const state = {
    sidebar: DEFAULTS.sidebar,
    tree: DEFAULTS.tree,
    sidebarCollapsed: false,
    treeCollapsed: false,
  };

  function readNumber(key, fallback) {
    try {
      const n = parseInt(localStorage.getItem(key), 10);
      return Number.isFinite(n) ? n : fallback;
    } catch { return fallback; }
  }
  function readBool(key) {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  }
  function clamp(kind, width) {
    const [min, max] = LIMITS[kind];
    return Math.min(max, Math.max(min, Math.round(width)));
  }
  function persist() {
    try {
      localStorage.setItem(KEYS.sidebar, String(state.sidebar));
      localStorage.setItem(KEYS.tree, String(state.tree));
      localStorage.setItem(KEYS.sidebarCollapsed, state.sidebarCollapsed ? '1' : '0');
      localStorage.setItem(KEYS.treeCollapsed, state.treeCollapsed ? '1' : '0');
    } catch { /* storage unavailable — layout still works for this run */ }
  }
  function apply() {
    document.documentElement.style.setProperty('--sidebar-w', state.sidebar + 'px');
    document.documentElement.style.setProperty('--tree-w', state.tree + 'px');

    const sidebar = byId('sidebar');
    const sidebarResizer = byId('sidebar-resizer');
    const tree = byId('tree-pane');
    const treeResizer = byId('tree-resizer');
    if (sidebar) sidebar.hidden = state.sidebarCollapsed;
    if (sidebarResizer) sidebarResizer.hidden = state.sidebarCollapsed;
    if (tree) tree.hidden = state.treeCollapsed;
    if (treeResizer) treeResizer.hidden = state.treeCollapsed;

    for (const [id, collapsed] of [['btn-toggle-sidebar', state.sidebarCollapsed], ['btn-toggle-tree', state.treeCollapsed]]) {
      const btn = byId(id);
      if (!btn) continue;
      btn.classList.toggle('active', collapsed);
      btn.setAttribute('aria-pressed', String(collapsed));
    }
  }

  function setWidth(kind, width) {
    state[kind] = clamp(kind, width);
    apply();
  }

  function bindDrag(el, kind) {
    if (!el) return;
    let startX = 0;
    let startW = 0;
    let dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      setWidth(kind, startW + e.clientX - startX);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('active');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      persist();
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = state[kind];
      el.classList.add('active');
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
    el.addEventListener('dblclick', () => {
      setWidth(kind, DEFAULTS[kind]);
      persist();
    });
  }

  App.layout = {
    state,
    apply,
    setSidebarWidth: (w) => setWidth('sidebar', w),
    setTreeWidth: (w) => setWidth('tree', w),
    toggleSidebar(force) {
      state.sidebarCollapsed = force === undefined ? !state.sidebarCollapsed : !!force;
      apply();
      persist();
      return state.sidebarCollapsed;
    },
    toggleTree(force) {
      state.treeCollapsed = force === undefined ? !state.treeCollapsed : !!force;
      apply();
      persist();
      return state.treeCollapsed;
    },
  };

  state.sidebar = clamp('sidebar', readNumber(KEYS.sidebar, DEFAULTS.sidebar));
  state.tree = clamp('tree', readNumber(KEYS.tree, DEFAULTS.tree));
  state.sidebarCollapsed = readBool(KEYS.sidebarCollapsed);
  state.treeCollapsed = readBool(KEYS.treeCollapsed);

  const toggleSidebarBtn = byId('btn-toggle-sidebar');
  if (toggleSidebarBtn) toggleSidebarBtn.addEventListener('click', () => App.layout.toggleSidebar());
  const collapseSidebarBtn = byId('btn-collapse-sidebar');
  if (collapseSidebarBtn) collapseSidebarBtn.addEventListener('click', () => App.layout.toggleSidebar(true));
  const toggleTreeBtn = byId('btn-toggle-tree');
  if (toggleTreeBtn) toggleTreeBtn.addEventListener('click', () => App.layout.toggleTree());

  bindDrag(byId('sidebar-resizer'), 'sidebar');
  bindDrag(byId('tree-resizer'), 'tree');
  apply();
})();
