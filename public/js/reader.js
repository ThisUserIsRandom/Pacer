/* Pacer — Tab 1: Speed Reading with a glowing rainbow pacer line. */
(function () {
  'use strict';

  const Pacer = (window.Pacer = window.Pacer || {});
  const { formatTime, clamp } = Pacer.ui;

  const MIN_WPM = 60;
  const MAX_WPM = 900;
  const WPM_KEY = 'pacer.wpm';
  const LENGTH_KEY = 'pacer.words';
  const PACER_STYLE_KEY = 'pacer.style';
  const MIN_WORDS = 50;
  const MAX_WORDS = 5000;
  const MIN_WORDS_TO_LOG = 20;
  /** Gap between the bottom of the current line's glyphs and the pacer rule. */
  const PACER_GAP = 4;

  /** Shown on first load so the pacer is usable without waiting on the model. */
  const SAMPLE_TEXT =
    'Reading quickly is mostly a matter of trust. Your eyes already know how to glide across a line of text, ' +
    'and your brain is remarkably good at assembling meaning from a steady stream of words. ' +
    'What slows most people down is not the reading itself but the quiet habit of stopping to say every word silently. ' +
    'A pacer gives your eyes somewhere to go, and once the rhythm is set, comprehension tends to follow along quite happily. ' +
    'Start somewhere comfortable and let the speed creep upward. ' +
    'If the meaning starts to blur, ease it back down for a paragraph or two. ' +
    'The goal is not to race, but to find the pace where the ideas arrive whole.';

  const SAMPLE_TOPICS = [
    'the ocean',
    'slow mornings',
    'kindness',
    'coffee',
    'walking',
    'music',
    'gardens',
    'the night sky'
  ];

  const el = {};
  const state = {
    words: [],
    spans: [],
    wpm: 250,
    targetWords: 300,
    playing: false,
    wordsRead: 0,
    elapsedMs: 0,
    lastTs: 0,
    rafId: null,
    pacerY: 0,
    pacerCacheIndex: -1,
    pacerCacheY: 0,
    scrollTarget: 0,
    reduceMotion: false,
    currentSpan: null,
    pacerStyle: 'soft',
    lastIndex: -1,
    logged: false,
    topic: '',
    rawText: '',
    sourceKind: 'sample',
    generatedText: '',
    generating: false,
    controller: null
  };

  function cacheElements() {
    el.viewport = document.getElementById('reader-viewport');
    el.track = document.getElementById('reader-track');
    el.text = document.getElementById('reader-text');
    el.pacer = document.getElementById('pacer');
    el.progress = document.getElementById('reading-progress');
    el.words = document.getElementById('reading-words');
    el.wordsTotal = document.getElementById('reading-words-total');
    el.elapsed = document.getElementById('reading-elapsed');
    el.remaining = document.getElementById('reading-remaining');
    el.play = document.getElementById('reading-play');
    el.reset = document.getElementById('reading-reset');
    el.save = document.getElementById('reading-save');
    el.source = document.getElementById('reading-source');
    el.topicInput = document.getElementById('reading-topic');
    el.generate = document.getElementById('reading-generate');
    el.generateLabel = document.getElementById('reading-generate-label');
    el.spinner = document.getElementById('reading-spinner');
    el.generateStatus = document.getElementById('reading-generate-status');
    el.wpmValue = document.getElementById('wpm-value');
    el.wpmRange = document.getElementById('wpm-range');
    el.wpmUp = document.getElementById('wpm-up');
    el.wpmDown = document.getElementById('wpm-down');
    el.lengthValue = document.getElementById('length-value');
    el.lengthRange = document.getElementById('length-range');
    el.lengthUp = document.getElementById('length-up');
    el.lengthDown = document.getElementById('length-down');
    el.lengthNote = document.getElementById('length-note');
    el.paceNote = document.getElementById('reading-pace-note');
    el.paceTime = document.getElementById('reading-pace-time');
    el.sampleTopics = document.getElementById('sample-topics');
    el.favSelect = document.getElementById('reading-fav-select');
    el.favLoad = document.getElementById('reading-fav-load');
    el.favSave = document.getElementById('reading-fav-save');
    el.favDelete = document.getElementById('reading-fav-delete');
    el.favCount = document.getElementById('reading-fav-count');
    el.pacerStyles = document.getElementById('pacer-styles');
  }

  /* ------------------------------------------------------------- rendering */

  /** Word positions change when the text re-wraps, so drop the cache. */
  function invalidatePacerCache() {
    state.pacerCacheIndex = -1;
  }

  /** Split text into clickable word spans so the pacer can target them. */
  function renderText(text) {
    state.words = String(text).split(/\s+/).filter(Boolean);
    state.spans = [];
    invalidatePacerCache();
    el.text.textContent = '';

    const fragment = document.createDocumentFragment();
    state.words.forEach((word, index) => {
      const span = document.createElement('span');
      span.className = 'rw';
      span.dataset.index = String(index);
      span.textContent = word;
      fragment.appendChild(span);
      state.spans.push(span);
      if (index < state.words.length - 1) fragment.appendChild(document.createTextNode(' '));
    });

    el.text.appendChild(fragment);
    el.wordsTotal.textContent = `/ ${state.words.length}`;
  }

  /** Apply highlight classes for the word currently under the pacer. */
  function paintIndex(index) {
    const previous = state.lastIndex;
    if (previous === index && state.currentSpan === state.spans[index]) return;

    // Always clear the span we actually painted. Relying on lastIndex alone left
    // a stale highlight behind whenever lastIndex was reset to -1 (e.g. on a tab
    // switch), so two words could end up looking current at once.
    if (state.currentSpan) {
      state.currentSpan.classList.remove('rw--current');
      state.currentSpan = null;
    }

    if (index > previous) {
      // Mark everything we have passed as read.
      for (let i = Math.max(0, previous); i < index; i += 1) {
        if (state.spans[i]) state.spans[i].classList.add('rw--done');
      }
    } else {
      // Seeked backwards: unmark on the way back.
      for (let i = index; i <= previous; i += 1) {
        if (state.spans[i]) state.spans[i].classList.remove('rw--done');
      }
    }

    if (state.spans[index]) {
      state.spans[index].classList.add('rw--current');
      state.currentSpan = state.spans[index];
    }
    state.lastIndex = index;
  }

  function updateReadout() {
    const total = state.words.length || 0;
    const read = Math.min(total, Math.floor(state.wordsRead));
    el.words.textContent = String(read);

    const ratio = total ? clamp(state.wordsRead / total, 0, 1) : 0;
    el.progress.style.width = `${(ratio * 100).toFixed(2)}%`;

    const elapsedSec = state.elapsedMs / 1000;
    el.elapsed.textContent = formatTime(elapsedSec);

    const remainingWords = Math.max(0, total - state.wordsRead);
    const remainingSec = state.wpm > 0 ? (remainingWords / state.wpm) * 60 : 0;
    el.remaining.textContent = formatTime(remainingSec);
  }

  /* ---------------------------------------------------------------- pacer */

  function currentIndex() {
    if (state.words.length === 0) return 0;
    return clamp(Math.floor(state.wordsRead), 0, state.words.length - 1);
  }

  /**
   * Y for the pacer, returning the TOP edge of the bar.
   *
   * Measured from the word's inline text box (not its line box) so the rule
   * lands in the leading gap just below the letters instead of striking
   * through them. Cached per word index: the rect reads force a layout, and
   * the position only changes when the current word changes.
   */
  function pacerTargetY(index) {
    const span = state.spans[index];
    if (!span) return 0;

    if (index === state.pacerCacheIndex) return state.pacerCacheY;

    let y = span.offsetTop + span.offsetHeight - PACER_GAP;

    if (el.track && document.createRange) {
      try {
        const range = document.createRange();
        range.selectNodeContents(span);
        const glyph = range.getBoundingClientRect();
        const track = el.track.getBoundingClientRect();
        // Both rects are viewport-relative, so their difference is scroll-invariant.
        if (glyph.height > 0) y = glyph.bottom - track.top + PACER_GAP;
      } catch {
        /* fall back to the line-box estimate above */
      }
    }

    state.pacerCacheIndex = index;
    state.pacerCacheY = y;
    return y;
  }

  /**
   * Keep the current word in the comfortable band of the viewport.
   *
   * The old implementation called scrollTo({behavior:'smooth'}) every frame,
   * which restarted the browser's smooth-scroll animation on each tick and made
   * the text stutter. Instead we compute a target once and ease towards it from
   * the existing requestAnimationFrame loop, so the motion is frame-synced and
   * can never stack.
   */
  function updateScroll(dt) {
    const viewport = el.viewport;
    const span = state.spans[currentIndex()];
    if (!viewport || !span) return;

    const height = viewport.clientHeight;
    if (height === 0) return;

    const maxScroll = Math.max(0, viewport.scrollHeight - height);
    const wordTop = span.offsetTop;
    const wordBottom = wordTop + span.offsetHeight;

    // Band measured against the *target* position, not the live one: using the
    // live scrollTop creates a feedback loop that re-targets endlessly.
    const bandTop = state.scrollTarget + height * 0.22;
    const bandBottom = state.scrollTarget + height * 0.72;

    if (wordTop < bandTop || wordBottom > bandBottom) {
      state.scrollTarget = clamp(wordTop - height * 0.3, 0, maxScroll);
    }
    state.scrollTarget = clamp(state.scrollTarget, 0, maxScroll);

    const difference = state.scrollTarget - viewport.scrollTop;
    if (Math.abs(difference) < 0.4) {
      viewport.scrollTop = state.scrollTarget;
      return;
    }

    // Frame-rate independent easing (no dt accumulated across pauses).
    const alpha = state.reduceMotion ? 1 : 1 - Math.exp(-dt * 12);
    viewport.scrollTop += difference * alpha;
  }

  /** Jump the scroll position without animating (reset, seek, resize). */
  function snapScroll(target) {
    if (!el.viewport) return;
    const maxScroll = Math.max(0, el.viewport.scrollHeight - el.viewport.clientHeight);
    state.scrollTarget = clamp(target, 0, maxScroll);
    el.viewport.scrollTop = state.scrollTarget;
  }

  /* ------------------------------------------------------------- playback */

  function frame(timestamp) {
    if (!state.playing) return;

    let dt = 0;
    if (state.lastTs) {
      dt = Math.min(0.25, (timestamp - state.lastTs) / 1000);
      state.elapsedMs += dt * 1000;
      state.wordsRead = Math.min(
        state.words.length,
        state.wordsRead + dt * (state.wpm / 60)
      );
    }
    state.lastTs = timestamp;

    const index = currentIndex();
    paintIndex(index);

    // Smoothly glide the pacer toward the current line instead of snapping.
    const target = pacerTargetY(index);
    const smoothing = 0.18;
    state.pacerY += (target - state.pacerY) * smoothing;
    el.pacer.style.transform = `translateY(${state.pacerY.toFixed(2)}px)`;

    updateScroll(dt);
    updateReadout();

    if (state.wordsRead >= state.words.length) {
      finish();
      return;
    }

    state.rafId = window.requestAnimationFrame(frame);
  }

  function play() {
    if (state.playing || state.words.length === 0) return;
    if (state.wordsRead >= state.words.length) reset();

    state.playing = true;
    state.lastTs = 0;
    el.pacer.classList.add('is-active');
    el.play.textContent = '⏸ Pause';
    state.rafId = window.requestAnimationFrame(frame);
  }

  function pause() {
    if (!state.playing) return;
    state.playing = false;
    if (state.rafId) window.cancelAnimationFrame(state.rafId);
    state.rafId = null;
    el.play.textContent = '▶︎ Play';
  }

  function toggle() {
    if (state.playing) pause();
    else play();
  }

  function reset() {
    pause();
    state.wordsRead = 0;
    state.elapsedMs = 0;
    state.lastTs = 0;
    state.logged = false;
    state.lastIndex = -1;
    invalidatePacerCache();
    state.pacerY = pacerTargetY(0);
    el.pacer.style.transform = `translateY(${state.pacerY.toFixed(2)}px)`;

    state.spans.forEach((span) => span.classList.remove('rw--done', 'rw--current'));
    state.currentSpan = state.spans[0] || null;
    if (state.currentSpan) state.currentSpan.classList.add('rw--current');
    state.lastIndex = 0;

    snapScroll(0);
    updateReadout();
  }

  function finish() {
    pause();
    paintIndex(state.words.length - 1);
    el.pacer.style.transform = `translateY(${pacerTargetY(state.words.length - 1).toFixed(2)}px)`;
    updateReadout();
    Pacer.ui.toast(`Finished ${state.words.length} words at ${state.wpm} wpm 🎉`, 'ok');
    logSession(true);
  }

  /* ----------------------------------------------------------------- wpm */

  function persistWpm() {
    try {
      window.localStorage.setItem(WPM_KEY, String(state.wpm));
    } catch {
      /* storage may be unavailable; pace simply is not remembered */
    }
  }

  function setWpm(next) {
    state.wpm = clamp(Math.round(next), MIN_WPM, MAX_WPM);
    el.wpmValue.textContent = String(state.wpm);
    el.wpmRange.value = String(state.wpm);
    el.paceNote.textContent = String(state.wpm);
    const seconds = state.wpm > 0 ? (state.words.length / state.wpm) * 60 : 0;
    el.paceTime.textContent = formatTime(seconds);
    persistWpm();
    updateReadout();
  }

  /* ----------------------------------------------------------- text length */

  /** Rough generation time for a target length (~14 tok/s on the local model). */
  function estimateSeconds(words) {
    return Math.max(5, Math.round(words * 0.1) + 5);
  }

  function persistLength() {
    try {
      window.localStorage.setItem(LENGTH_KEY, String(state.targetWords));
    } catch {
      /* storage unavailable; length simply is not remembered */
    }
  }

  function setTargetWords(next) {
    const rounded = Math.round(Number(next) / 10) * 10;
    state.targetWords = clamp(Number.isFinite(rounded) ? rounded : 300, MIN_WORDS, MAX_WORDS);
    el.lengthValue.textContent = String(state.targetWords);
    el.lengthRange.value = String(state.targetWords);
    el.lengthNote.textContent =
      `About ${estimateSeconds(state.targetWords)}s for the local model to write ` +
      `${state.targetWords} words.`;
    persistLength();
  }

  /* ---------------------------------------------------------- pacer style */

  const PACER_STYLES = ['soft', 'rainbow', 'off'];

  function setPacerStyle(style) {
    const next = PACER_STYLES.includes(style) ? style : 'soft';
    state.pacerStyle = next;

    PACER_STYLES.forEach((name) => el.pacer.classList.remove(`pacer--${name}`));
    el.pacer.classList.add(`pacer--${next}`);

    if (el.pacerStyles) {
      Array.from(el.pacerStyles.querySelectorAll('[data-pacer-style]')).forEach((button) => {
        const active = button.dataset.pacerStyle === next;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('btn--lav', active);
      });
    }

    try {
      window.localStorage.setItem(PACER_STYLE_KEY, next);
    } catch {
      /* storage unavailable; the choice simply is not remembered */
    }
  }

  /* -------------------------------------------------------------- history */

  async function logSession(auto) {
    const wordsRead = Math.floor(state.wordsRead);
    if (state.logged) {
      if (auto) return;
      Pacer.ui.toast('This session is already saved.', 'ok');
      return;
    }
    if (wordsRead < MIN_WORDS_TO_LOG) {
      if (!auto) Pacer.ui.toast(`Read at least ${MIN_WORDS_TO_LOG} words before saving.`, 'error');
      return;
    }

    state.logged = true;
    try {
      await Pacer.api.saveSession({
        type: 'reading',
        wpm: state.wpm,
        durationSec: Math.round((state.elapsedMs / 1000) * 10) / 10,
        wordCount: wordsRead,
        topic: state.topic || null
      });
      Pacer.ui.toast(auto ? 'Session saved to your history ✨' : 'Reading session saved ✨', 'ok');
      if (Pacer.analytics) Pacer.analytics.invalidate();
    } catch (error) {
      state.logged = false;
      Pacer.ui.toast(`Could not save session: ${error.message}`, 'error');
    }
  }

  /* ---------------------------------------------------------- generation */

  function setGenerating(active) {
    state.generating = active;
    el.generate.disabled = active;
    el.spinner.hidden = !active;
    el.generateLabel.textContent = active ? 'Writing something cheerful…' : '✨ Generate text';
  }

  function describeSource(result) {
    if (result.source === 'llama') {
      const seconds = result.durationMs ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : '';
      const rate = result.tokPerSec ? ` · ${result.tokPerSec} tok/s` : '';
      const name = result.provider === 'local' ? '🧠 built-in' : '✨ llama-server';
      return {
        text: `${name}${result.model ? ` · ${result.model}` : ''}${seconds}${rate}`,
        className: 'badge badge--llama'
      };
    }
    return {
      text: `📴 Offline essay — ${result.fallbackReason || 'llama-server unavailable'}`,
      className: 'badge badge--offline'
    };
  }

  async function generate() {
    if (state.generating) return;

    const topic = el.topicInput.value.trim();
    state.topic = topic;
    setGenerating(true);

    const startedAt = Date.now();
    const ticker = window.setInterval(() => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
      el.generateStatus.textContent = `Asking your local model for ${state.targetWords} words… ${seconds}s elapsed.`;
    }, 500);
    el.generateStatus.textContent = `Asking your local model for ${state.targetWords} words… 0s elapsed.`;

    const controller = new AbortController();
    state.controller = controller;

    try {
      const result = await Pacer.api.generateText(topic, {
        signal: controller.signal,
        words: state.targetWords
      });
      const badge = describeSource(result);
      el.source.className = badge.className;
      el.source.textContent = badge.text;

      state.generatedText = result.text;
      state.sourceKind = result.source;
      setText(result.text, result.topic || topic || 'generated text');

      if (result.source === 'llama') {
        el.generateStatus.textContent =
          `${result.wordCount} words · ${(result.durationMs / 1000).toFixed(1)}s`;
      } else {
        const note =
          state.targetWords > 600
            ? ' Offline essays repeat some phrasing at this length.'
            : '';
        el.generateStatus.textContent =
          `Served a built-in essay (${result.fallbackReason}). Everything still works offline.${note}`;
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        el.generateStatus.textContent = 'Generation cancelled.';
      } else {
        el.generateStatus.textContent = `Generation failed: ${error.message}`;
        Pacer.ui.toast(`Generation failed: ${error.message}`, 'error');
      }
    } finally {
      window.clearInterval(ticker);
      setGenerating(false);
      state.controller = null;
    }
  }

  function setText(text, topic) {
    state.topic = topic || '';
    state.rawText = String(text || '');
    renderText(text);
    reset();
    setWpm(state.wpm);
  }

  /* --------------------------------------------------------------- setup */

  function bindHotkeys() {
    document.addEventListener('keydown', (event) => {
      // Only when the reading tab is the visible one and no field has focus.
      const main = Pacer.main;
      if (!main || main.activeTab !== 'reading') return;
      if (main.isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const step = event.shiftKey ? 25 : 10;

      switch (event.key) {
        case 'w':
        case 'W':
          event.preventDefault();
          setWpm(state.wpm + step);
          break;
        case 's':
        case 'S':
          event.preventDefault();
          setWpm(state.wpm - step);
          break;
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          toggle();
          break;
        default:
          break;
      }
    });
  }

  function bindControls() {
    el.play.addEventListener('click', toggle);
    el.reset.addEventListener('click', reset);
    el.save.addEventListener('click', () => logSession(false));
    el.wpmUp.addEventListener('click', () => setWpm(state.wpm + 10));
    el.wpmDown.addEventListener('click', () => setWpm(state.wpm - 10));
    el.wpmRange.addEventListener('input', () => setWpm(Number(el.wpmRange.value)));
    el.lengthUp.addEventListener('click', () => setTargetWords(state.targetWords + 50));
    el.lengthDown.addEventListener('click', () => setTargetWords(state.targetWords - 50));
    el.lengthRange.addEventListener('input', () => setTargetWords(Number(el.lengthRange.value)));
    if (el.pacerStyles) {
      el.pacerStyles.addEventListener('click', (event) => {
        const button = event.target.closest('[data-pacer-style]');
        if (button) setPacerStyle(button.dataset.pacerStyle);
      });
    }

    el.generate.addEventListener('click', generate);

    el.topicInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        generate();
      }
    });

    // A resize re-wraps the text, so measured word positions are stale.
    window.addEventListener('resize', () => {
      invalidatePacerCache();
      const index = currentIndex();
      state.pacerY = pacerTargetY(index);
      el.pacer.style.transform = `translateY(${state.pacerY.toFixed(2)}px)`;

      const span = state.spans[index];
      if (span && el.viewport) {
        snapScroll(span.offsetTop - el.viewport.clientHeight * 0.3);
      }
    });

    // Click a word to jump the pacer there.
    el.text.addEventListener('click', (event) => {
      const span = event.target.closest('.rw');
      if (!span) return;
      pause();
      state.wordsRead = Number(span.dataset.index);
      state.pacerY = pacerTargetY(state.wordsRead);
      el.pacer.style.transform = `translateY(${state.pacerY.toFixed(2)}px)`;
      paintIndex(state.wordsRead);
      const target = state.spans[state.wordsRead];
      if (target && el.viewport) {
        snapScroll(target.offsetTop - el.viewport.clientHeight * 0.3);
      }
      updateReadout();
    });
  }

  function renderSampleTopics() {
    SAMPLE_TOPICS.forEach((topic) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'btn btn--sm';
      chip.textContent = topic;
      chip.addEventListener('click', () => {
        el.topicInput.value = topic;
        generate();
      });
      el.sampleTopics.appendChild(chip);
    });
  }

  /** "My paragraphs" — save / reload passages you like. */
  function mountFavourites() {
    if (!Pacer.favourites) return;

    state.favourites = Pacer.favourites.mount({
      select: el.favSelect,
      load: el.favLoad,
      remove: el.favDelete,
      save: el.favSave,
      count: el.favCount,
      getCurrent: () => ({
        text: state.rawText,
        topic: state.topic,
        source: state.sourceKind
      }),
      onLoad: (favourite) => {
        pause();
        setText(favourite.text, favourite.topic || '');
        state.generatedText = favourite.text;
        state.sourceKind = 'saved';
        el.source.className = 'badge badge--muted';
        el.source.textContent = '❤ saved passage';
        el.generateStatus.textContent = favourite.topic
          ? `Loaded “${favourite.topic}” from your paragraphs.`
          : 'Loaded a saved passage.';
      }
    });

    state.favourites.refresh();
  }

  function init() {
    cacheElements();

    // Honour the OS setting: snap instead of easing.
    try {
      state.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window
        .matchMedia('(prefers-reduced-motion: reduce)')
        .addEventListener('change', (event) => {
          state.reduceMotion = event.matches;
        });
    } catch {
      state.reduceMotion = false;
    }

    let stored = NaN;
    let storedWords = NaN;
    try {
      stored = Number(window.localStorage.getItem(WPM_KEY));
      storedWords = Number(window.localStorage.getItem(LENGTH_KEY));
    } catch {
      stored = NaN;
      storedWords = NaN;
    }

    let storedPacer = null;
    try {
      storedPacer = window.localStorage.getItem(PACER_STYLE_KEY);
    } catch {
      storedPacer = null;
    }
    setPacerStyle(storedPacer || 'soft');

    setWpm(Number.isFinite(stored) && stored > 0 ? stored : 250);
    setTargetWords(Number.isFinite(storedWords) && storedWords > 0 ? storedWords : 300);
    renderSampleTopics();
    setText(SAMPLE_TEXT, '');
    el.source.className = 'badge badge--muted';
    el.source.textContent = 'built-in sample';

    bindControls();
    bindHotkeys();
    mountFavourites();
  }

  Pacer.reader = {
    init,
    setText,
    generate,
    state,
    /** Re-measure word positions after the tab becomes visible again. */
    invalidateLayout: () => {
      invalidatePacerCache();
      const span = state.spans[currentIndex()];
      if (span && el.viewport) {
        snapScroll(span.offsetTop - el.viewport.clientHeight * 0.3);
      }
    },
    /** Text produced by /api/generate, reused by the typing tab. */
    getGeneratedText: () => state.generatedText,
    getTopic: () => state.topic
  };
})();
