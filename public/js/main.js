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
      // The reader measures word positions, which are only valid when visible.
      Pacer.reader.state.lastIndex = -1;
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
    if (!model) return 'local model';
    const clean = String(model).replace(/\.gguf$/i, '');
    return clean.length > 26 ? `${clean.slice(0, 25)}…` : clean;
  }

  async function loadHealth() {
    const badge = document.getElementById('llama-badge');
    if (!badge) return;

    try {
      const health = await Pacer.api.health();
      if (health.llama && health.llama.reachable) {
        badge.className = 'badge badge--llama';
        badge.textContent = `✨ ${shortModel(health.llama.model)} ready`;
        badge.title = `llama-server reachable at ${health.llama.url}`;
      } else {
        badge.className = 'badge badge--offline';
        badge.textContent = '📴 llama-server offline · built-in essays ready';
        badge.title = health.llama ? health.llama.detail : 'unreachable';
      }
    } catch {
      badge.className = 'badge badge--offline';
      badge.textContent = '📴 server unreachable';
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

    loadHealth();
    window.setInterval(loadHealth, 60000);
  }

  Pacer.main = main;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
