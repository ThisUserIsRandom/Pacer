/* Pacer — shared "my paragraphs" widget: save, load and delete passages.
   Mounted once per tab (reading + typing) against the same SQLite-backed list. */
(function () {
  'use strict';

  const Pacer = (window.Pacer = window.Pacer || {});

  /**
   * Every mounted widget (one per tab). Saving or deleting in one tab must
   * refresh the others, otherwise the lists drift apart until a reload.
   */
  const instances = [];

  /** Short human label for a saved passage. */
  function describe(favourite) {
    const name = favourite.topic || 'untitled';
    const source = favourite.source ? ` · ${favourite.source}` : '';
    return `${name} · ${favourite.wordCount}w${source}`;
  }

  /**
   * @param {object} options
   * @param {HTMLSelectElement} options.select
   * @param {HTMLButtonElement} options.load
   * @param {HTMLButtonElement} options.remove
   * @param {HTMLButtonElement} options.save
   * @param {HTMLElement} [options.count]
   * @param {() => ({text: string, topic?: string, source?: string})} options.getCurrent
   * @param {(favourite: object) => void} options.onLoad
   */
  function mount(options) {
    const { select, load, remove, save, count } = options;
    let items = [];
    let busy = false;

    function render(preserveId) {
      const keep = preserveId || select.value || null;
      select.textContent = '';

      if (items.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Nothing saved yet';
        select.appendChild(option);
      } else {
        items.forEach((favourite) => {
          const option = document.createElement('option');
          option.value = favourite.id;
          option.textContent = describe(favourite);
          select.appendChild(option);
        });
        if (keep && items.some((favourite) => favourite.id === keep)) select.value = keep;
      }

      const empty = items.length === 0;
      load.disabled = empty;
      remove.disabled = empty;
      if (count) count.textContent = `${items.length} saved`;
    }

    async function refresh(preserveId) {
      try {
        const data = await Pacer.api.getFavourites();
        items = data.favourites || [];
        render(preserveId);
      } catch (error) {
        Pacer.ui.toast(`Could not load saved passages: ${error.message}`, 'error');
      }
    }

    /** Refresh this widget (optionally keeping a selection) and all the others. */
    async function broadcast(preserveId) {
      await Promise.all(
        instances.map((instance) => instance.refresh(instance === self ? preserveId : undefined))
      );
    }

    async function saveCurrent() {
      if (busy) return;

      const current = options.getCurrent();
      if (!current || !current.text || !current.text.trim()) {
        Pacer.ui.toast('There is no passage to save yet.', 'error');
        return;
      }

      busy = true;
      save.disabled = true;
      try {
        const result = await Pacer.api.saveFavourite(current);
        Pacer.ui.toast(
          result.duplicate ? 'That passage is already saved ❤' : 'Saved to your paragraphs ❤',
          'ok'
        );
        await broadcast(result.favourite && result.favourite.id);
      } catch (error) {
        Pacer.ui.toast(`Could not save the passage: ${error.message}`, 'error');
      } finally {
        busy = false;
        save.disabled = false;
      }
    }

    function selected() {
      return items.find((favourite) => favourite.id === select.value) || null;
    }

    function loadSelected() {
      const favourite = selected();
      if (!favourite) {
        Pacer.ui.toast('Pick a saved passage from the list first.', 'error');
        return;
      }
      options.onLoad(favourite);
    }

    async function removeSelected() {
      const favourite = selected();
      if (!favourite) return;

      const name = favourite.topic || 'this passage';
      if (!window.confirm(`Delete the saved passage "${name}"?`)) return;

      try {
        await Pacer.api.deleteFavourite(favourite.id);
        Pacer.ui.toast('Saved passage deleted.', 'ok');
        await broadcast();
      } catch (error) {
        Pacer.ui.toast(`Could not delete the passage: ${error.message}`, 'error');
      }
    }

    save.addEventListener('click', saveCurrent);
    load.addEventListener('click', loadSelected);
    remove.addEventListener('click', removeSelected);
    // Double-clicking the list loads it, which is a common expectation.
    select.addEventListener('dblclick', loadSelected);

    render();

    const self = {
      refresh,
      save: saveCurrent,
      get items() {
        return items.slice();
      }
    };
    instances.push(self);
    return self;
  }

  Pacer.favourites = { mount };
})();
