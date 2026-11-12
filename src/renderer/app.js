'use strict';
// Renderer bootstrap: wire DOM events, tab routing, shortcuts, theme/language
// controls, mini-mode and main-process event subscriptions. Loaded last.
(function () {
  const api = window.api;

  const THEMES = [
    { id: 'midnight', trio: ['#0a0e13', '#2ee6a8', '#38bdf8'] },
    { id: 'daylight', trio: ['#faf9f4', '#0e9f6e', '#0891b2'] },
    { id: 'phosphor', trio: ['#030905', '#46ff8a', '#b8ff5e'] },
    { id: 'nebula', trio: ['#0c0918', '#c084fc', '#f472b6'] },
  ];

  // ---------- tabs ----------
  function switchTab(name) {
    $all('.tab').forEach((tb) => tb.classList.toggle('active', tb.dataset.tab === name));
    $('#view-files').hidden = name !== 'files';
    $('#view-ports').hidden = name !== 'ports';
    if (name === 'ports') App.ports.refresh();
  }
  $all('.tab').forEach((tb) => tb.addEventListener('click', () => switchTab(tb.dataset.tab)));

  // ---------- sidebar / welcome ----------
  $('#btn-add-conn').addEventListener('click', () => App.connections.openForm());
  $('#btn-welcome-add').addEventListener('click', () => App.connections.openForm());
  $('#btn-disconnect').addEventListener('click', () => {
    if (App.state.activeId) App.connections.disconnect(App.state.activeId);
  });

  // ---------- files toolbar ----------
  $('#btn-home').addEventListener('click', async () => {
    const h = await api.fs.home(App.state.activeId);
    App.files.navigate(h);
  });
  $('#btn-up').addEventListener('click', () => App.files.navigate(App.files.dirname(App.state.cwd || '/')));
  $('#btn-refresh').addEventListener('click', () => App.files.loadRoot());
  $('#path-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') App.files.navigate(e.target.value); });
  $('#btn-new-file').addEventListener('click', () => App.files.newFile());
  $('#btn-new-dir').addEventListener('click', () => App.files.newDir());
  $('#btn-upload').addEventListener('click', () => App.files.upload());
  $('#btn-download').addEventListener('click', () => App.files.download());
  $('#btn-rename').addEventListener('click', () => App.files.rename());
  $('#btn-delete').addEventListener('click', () => App.files.remove());

  // ---------- editor ----------
  const editor = $('#editor');
  editor.addEventListener('input', () => App.files.onEditorInput());
  editor.addEventListener('scroll', () => { $('#gutter').scrollTop = editor.scrollTop; });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      App.files.onEditorInput();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); App.files.save(); }
  });
  $('#btn-save').addEventListener('click', () => App.files.save());
  $('#btn-close-file').addEventListener('click', async () => {
    const f = App.state.openFile;
    if (f && f.dirty) {
      const ok = await App.confirm({ title: t('discard.title'), message: t('discard.msg'), danger: true, okLabel: t('discard.ok') });
      if (!ok) return;
    }
    App.files.closeEditor();
  });

  // ---------- ports ----------
  $('#btn-add-forward').addEventListener('click', () => App.ports.openForm());
  $('#btn-add-forward-empty').addEventListener('click', () => App.ports.openForm());
  $('#btn-refresh-ports').addEventListener('click', () => App.ports.refresh());
  $('#chk-restore-forwards').addEventListener('change', (e) => {
    api.settings.set('restoreForwards', e.target.checked).catch(() => {});
  });

  // ---------- theme ----------
  function renderThemeButton() {
    const th = THEMES.find((x) => x.id === App.ui.theme) || THEMES[0];
    $('#theme-swatch').style.background = `linear-gradient(135deg, ${th.trio[1]}, ${th.trio[2]})`;
    $('#theme-name').textContent = t('theme.' + th.id);
  }
  function buildThemeMenu() {
    const menu = $('#theme-menu');
    menu.innerHTML = '';
    for (const th of THEMES) {
      const opt = el('button', {
        class: 'theme-option' + (th.id === App.ui.theme ? ' current' : ''),
        role: 'menuitem',
        onclick: () => { App.setTheme(th.id); closeThemeMenu(); },
      },
        el('span', { class: 'trio' }, th.trio.map((c) => el('i', { style: `background:${c}` }))),
        el('span', { class: 't-name' }, t('theme.' + th.id)),
        th.id === App.ui.theme ? icon('check') : null);
      menu.append(opt);
    }
  }
  function closeThemeMenu() { $('#theme-menu').hidden = true; }
  $('#theme-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#theme-menu');
    menu.hidden = !menu.hidden;
    if (!menu.hidden) buildThemeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('#theme-picker').contains(e.target)) closeThemeMenu();
  });

  App.setTheme = async (id) => {
    if (!THEMES.some((x) => x.id === id)) return;
    App.ui.theme = id;
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem('srs.theme', id); } catch { /* ignore */ }
    renderThemeButton();
    buildThemeMenu();
    if (App.ui.mini) App.mini.drawSpark();
    try { await api.settings.set('ui.theme', id); } catch { /* non-fatal */ }
  };

  // ---------- language ----------
  function renderLangSeg() {
    $all('#lang-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.lang === getLang()));
  }
  function renderEncState() {
    if (!App.state.appInfo) return;
    const enc = App.state.appInfo.encryptionAvailable;
    const encEl = $('#enc-state');
    encEl.textContent = (enc ? '🔒 ' : '🔓 ') + t(enc ? 'enc.encrypted' : 'enc.plain');
    encEl.title = t(enc ? 'enc.encrypted.title' : 'enc.plain.title');
    encEl.className = 'enc-chip ' + (enc ? 'ok' : 'bad');
  }
  App.setLang = async (l) => {
    setLang(l);
    applyI18n();
    renderLangSeg();
    renderThemeButton();
    buildThemeMenu();
    renderEncState();
    App.connections.render();
    App.ports.render();
    if (App.ui.mini) App.mini.render();
    App.setStatus();
    try { await api.settings.set('ui.lang', getLang()); } catch { /* non-fatal */ }
    try { await api.app.rebuildMenu(); } catch { /* non-fatal */ }
  };
  $all('#lang-switch .seg-btn').forEach((b) => b.addEventListener('click', () => App.setLang(b.dataset.lang)));

  // ---------- mini mode ----------
  function renderPinBtn() {
    const btn = $('#mini-pin');
    btn.classList.toggle('pinned', App.ui.pinned);
    btn.title = App.ui.pinned ? t('mini.pin') : t('mini.pin.off');
  }
  App.setMini = async (mini) => {
    let st;
    try { st = await api.window.setMini(mini, App.ui.pinned); }
    catch { st = { mini: false }; }
    App.ui.mini = !!st.mini;
    document.body.classList.toggle('mini', App.ui.mini);
    $('#mini').hidden = !App.ui.mini;
    closeThemeMenu();
    if (App.ui.mini) {
      // Seed fresh counters before the first render so a just-added forward
      // never shows an empty panel while waiting for the next monitor tick.
      try { await App.monitor.tick(); } catch { /* non-fatal */ }
      App.mini.enter();
      renderPinBtn();
    } else App.ports.updateLive();
  };
  $('#btn-mini').addEventListener('click', () => App.setMini(true));
  $('#mini-expand').addEventListener('click', () => App.setMini(false));
  $('#mini-pin').addEventListener('click', async () => {
    App.ui.pinned = !App.ui.pinned;
    renderPinBtn();
    if (App.ui.mini) { try { await api.window.setMini(true, App.ui.pinned); } catch { /* ignore */ } }
  });
  $('#mini-connect').addEventListener('click', async () => {
    const id = $('#mini-conn-select').value;
    if (!id) return;
    App.mini.selId = id;
    await App.connections.connect(id);
    if (App.ui.mini) App.mini.render();
  });
  $('#mini-add-fwd').addEventListener('click', async () => {
    await App.setMini(false);
    App.ports.openForm();
  });
  $('#mini-new-conn').addEventListener('click', async () => {
    await App.setMini(false);
    App.connections.openForm();
  });

  // ---------- global shortcuts ----------
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); App.connections.openForm(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') { e.preventDefault(); App.setMini(!App.ui.mini); }
    if (e.key === 'Escape') closeThemeMenu();
  });

  // ---------- main-process events ----------
  api.on('state', ({ id, state }) => App.connections.setState(id, state));
  api.on('ready', ({ id }) => App.connections.setState(id, 'connected'));
  api.on('close', ({ id }) => {
    App.connections.setState(id, 'disconnected');
    if (App.state.activeId === id) App.toast(t('toast.connClosed'), { type: 'warn', title: t('toast.connClosed.title') });
  });
  api.on('session-error', ({ error }) => App.toast(error.message, { type: 'error', title: t('toast.sessionError') }));
  api.on('hostkey-new', ({ host, port, fingerprint }) => {
    App.toast(t('toast.hostkeyNew', { host: `${host}:${port}`, fp: fingerprint }), { type: 'info', title: t('toast.hostkeyNew.title'), timeout: 6000 });
  });
  api.on('hostkey-mismatch', ({ host, port }) => {
    App.toast(t('toast.hostkeyMismatch', { host: `${host}:${port}` }), { type: 'error', title: t('toast.hostkeyMismatch.title'), timeout: 12000 });
  });
  api.on('forward-added', () => App.ports.refresh());
  api.on('forward-removed', () => App.ports.refresh());
  api.on('forward-changed', () => App.ports.refresh());
  api.on('forward-error', ({ error }) => {
    App.toast((error && error.message) || t('fwd.startFailed'), { type: 'error', title: t('fwd.errorTitle') });
    App.ports.refresh();
  });
  api.on('menu-new-connection', () => App.connections.openForm());
  api.on('menu-toggle-mini', () => App.setMini(!App.ui.mini));

  // ---------- boot ----------
  async function boot() {
    try {
      App.state.appInfo = await api.app.info();
      $('#app-version').textContent = 'v' + App.state.appInfo.version;
      $('#brand-version').textContent = 'v' + App.state.appInfo.version;
      renderEncState();

      // Reconcile persisted UI settings (store is authoritative over the
      // localStorage cache applied before first paint).
      const [theme, lang] = await Promise.all([
        api.settings.get('ui.theme', App.ui.theme),
        api.settings.get('ui.lang', getLang()),
      ]);
      if (THEMES.some((x) => x.id === theme)) {
        App.ui.theme = theme;
        document.documentElement.dataset.theme = theme;
        try { localStorage.setItem('srs.theme', theme); } catch { /* ignore */ }
      }
      setLang(lang === 'en' ? 'en' : 'zh');
      applyI18n();
      renderThemeButton();
      buildThemeMenu();
      renderLangSeg();
      renderPinBtn();

      await App.connections.refresh();

      // Restore mini state if the window was reloaded while compact.
      try {
        const ws = await api.window.state();
        App.ui.pinned = ws.pinned !== false;
        renderPinBtn();
        if (ws.mini) {
          App.ui.mini = true;
          document.body.classList.add('mini');
          $('#mini').hidden = false;
          try { await App.monitor.tick(); } catch { /* non-fatal */ }
          App.mini.enter();
        }
      } catch { /* window API unavailable — stay full */ }

      App.monitor.start();

      // Resume the workspace of a session restored at startup: wait briefly
      // for the auto-reconnect to land, then activate it (loads its tree and
      // forwards). If it never connects, the user can pick one manually.
      const resumeIds = await api.settings.get('activeSessions', []);
      if (Array.isArray(resumeIds) && resumeIds.length && !App.state.activeId) {
        for (let i = 0; i < 24; i++) {
          const first = App.state.connections.find((c) => App.state.sessions[c.id] && App.state.sessions[c.id].state === 'connected');
          if (first) { await App.connections.setActive(first.id); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      $('#chk-restore-forwards').checked = (await api.settings.get('restoreForwards', true)) !== false;
      App.setStatus();
    } catch (e) {
      App.toast(App.errMsg(e), { type: 'error', title: t('init.failed') });
    }
  }
  boot();
})();
