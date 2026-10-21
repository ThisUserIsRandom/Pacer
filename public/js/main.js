/* Pacer — tab router, shared state, and app bootstrap. */
(function () {
  'use strict';

  const Pacer = (window.Pacer = window.Pacer || {});

  const main = {
    activeTab: 'reading',
    isTypingTarget(element) {
      if (!element) return false;
      const tag = element.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        element.isContentEditable === true
      );
    }
  };

  const TABS = ['reading', 'typing', 'analytics'];

  function tabButtons() {
    return Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
  }

  function setTab(name, options) {
    if (!TABS.includes(name)) return;
    const focus = options && options.focus;

    tabButtons().forEach((button) => {
      const selected = button.dataset.tab === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });

    TABS.forEach((tabName) => {
      const panel = document.getElementById(`panel-${tabName}`);
      if (panel) panel.hidden = tabName !== name;
    });

    main.activeTab = name;

    // Keep the URL in sync so a tab can be bookmarked or reloaded directly.
    if (window.location.hash !== `#${name}`) {
      try {
        window.history.replaceState(null, '', `#${name}`);
      } catch {
        window.location.hash = name;
      }
    }

    if (name === 'analytics' && Pacer.analytics) Pacer.analytics.load();
    if (name === 'reading' && Pacer.reader) {
      // Word positions are only valid while the panel is visible, so re-measure.
      // (Previously this reset lastIndex, which left a stale word highlighted.)
      Pacer.reader.invalidateLayout();
    }
  }

  /** Tab named in the URL hash, if it is one we know. */
  function tabFromHash() {
    const name = (window.location.hash || '').replace(/^#/, '');
    return TABS.includes(name) ? name : 'reading';
  }

  function bindTabs() {
    const buttons = tabButtons();

    buttons.forEach((button) => {
      button.addEventListener('click', () => setTab(button.dataset.tab));
    });

    // Arrow-key navigation across the tab list.
    document.querySelectorAll('[role="tablist"]').forEach((list) => {
      list.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        const current = buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true');
        if (current === -1) return;
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const next = (current + delta + buttons.length) % buttons.length;
        event.preventDefault();
        setTab(buttons[next].dataset.tab, { focus: true });
      });
    });
  }

  /** Shorten a model id for the header badge. */
  function shortModel(model) {
    if (!model) return '';
    const clean = String(model).replace(/\.gguf$/i, '').replace(/^.*[\\/]/, '');
    return clean.length > 26 ? `${clean.slice(0, 25)}…` : clean;
  }

  const providerUi = { data: null };

  /** Header badge: which provider is active and whether it is usable. */
  function renderProviderBadge(data) {
    const badge = document.getElementById('llama-badge');
    if (!badge) return;

    if (data.provider === 'local') {
      const local = data.providers.local;
      if (local.available) {
        badge.className = 'badge badge--llama';
        badge.textContent = `🧠 built-in${local.model ? ` · ${shortModel(local.model)}` : ''}`;
        badge.title = `${local.modelPath}${local.loaded ? ' — loaded' : ' — loads on first use'}`;
      } else {
        badge.className = 'badge badge--offline';
        badge.textContent = '🧠 built-in · no model file';
        badge.title = `${local.modelPath} — run: npm run model:download`;
      }
      return;
    }

    const server = data.providers.server;
    if (server.reachable) {
      badge.className = 'badge badge--llama';
      badge.textContent = `✨ llama-server${server.model ? ` · ${shortModel(server.model)}` : ''}`;
      badge.title = server.url;
    } else {
      badge.className = 'badge badge--offline';
      badge.textContent = '📴 llama-server offline';
      badge.title = server.detail;
    }
  }

  /** Fill the picker from live provider status. */
  function renderProviderDialog(data, selected) {
    const server = data.providers.server;
    const local = data.providers.local;

    const serverStatus = document.getElementById('provider-server-status');
    const serverUrl = document.getElementById('provider-server-url');
    const localStatus = document.getElementById('provider-local-status');
    const localPath = document.getElementById('provider-local-path');
    const localHelp = document.getElementById('provider-local-help');
    const localRadio = document.getElementById('provider-local');

    if (serverStatus) {
      serverStatus.textContent = server.reachable
        ? `reachable${server.model ? ` · ${server.model}` : ''}`
        : `not reachable — ${server.detail}`;
    }
    if (serverUrl) serverUrl.textContent = server.url;
    if (localStatus) {
      localStatus.textContent = local.available
        ? `ready${local.model ? ` · ${local.model}` : ''}${local.loaded ? ' · loaded' : ' · loads on first use'}`
        : 'no model file found';
    }
    if (localPath) localPath.textContent = local.modelPath;
    if (localHelp) localHelp.hidden = Boolean(local.available);
    if (localRadio) localRadio.disabled = !local.available;

    const choice = selected || data.provider;
    const wanted = document.querySelector(`#provider-dialog input[value="${choice}"]`);
    if (wanted && !wanted.disabled) wanted.checked = true;
    else {
      const fallback = document.getElementById('provider-server');
      if (fallback) fallback.checked = true;
    }
  }

  async function refreshProvider(options) {
    try {
      const data = await Pacer.api.getSettings();
      providerUi.data = data;
      renderProviderBadge(data);
      renderProviderDialog(data);

      // First run: nothing has been chosen yet, so ask.
      if (options && options.openIfUnset && data.configured === false) openProviderDialog();
      return data;
    } catch {
      const badge = document.getElementById('llama-badge');
      if (badge) {
        badge.className = 'badge badge--offline';
        badge.textContent = '📴 server unreachable';
      }
      return null;
    }
  }

  function openProviderDialog() {
    const dialog = document.getElementById('provider-dialog');
    if (!dialog) return;
    if (providerUi.data) renderProviderDialog(providerUi.data);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeProviderDialog() {
    const dialog = document.getElementById('provider-dialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  async function saveProvider() {
    const picked = document.querySelector('#provider-dialog input[name="provider"]:checked');
    if (!picked) return;

    const button = document.getElementById('provider-save');
    const note = document.getElementById('provider-note');
    button.disabled = true;
    note.textContent = picked.value === 'local' ? 'Loading the built-in model…' : 'Saving…';

    try {
      const data = await Pacer.api.saveSettings({ provider: picked.value });
      providerUi.data = data;
      renderProviderBadge(data);
      renderProviderDialog(data, data.provider);
      closeProviderDialog();
      Pacer.ui.toast(
        data.provider === 'local'
          ? 'Essays will come from the built-in model 🧠'
          : 'Essays will come from your llama-server ✨',
        'ok'
      );
    } catch (error) {
      note.textContent = error.message;
      Pacer.ui.toast(`Could not save the choice: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function bindProviderPicker() {
    const open = document.getElementById('provider-open');
    const close = document.getElementById('provider-close');
    const save = document.getElementById('provider-save');
    const dialog = document.getElementById('provider-dialog');

    if (open) {
      open.addEventListener('click', async () => {
        await refreshProvider();
        openProviderDialog();
      });
    }
    if (close) close.addEventListener('click', closeProviderDialog);
    if (save) save.addEventListener('click', saveProvider);

    // Clicking the backdrop closes it.
    if (dialog) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) closeProviderDialog();
      });
    }
  }

  function boot() {
    if (Pacer.reader) Pacer.reader.init();
    if (Pacer.typing) Pacer.typing.init();
    if (Pacer.analytics) Pacer.analytics.init();

    bindTabs();
    setTab(tabFromHash());

    // Support back/forward and manually edited hashes.
    window.addEventListener('hashchange', () => setTab(tabFromHash()));

    bindProviderPicker();
    refreshProvider({ openIfUnset: true });
    window.setInterval(() => refreshProvider(), 60000);
  }

  Pacer.main = main;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
