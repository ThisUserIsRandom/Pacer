/* Pacer — Tab 2: Touch Typing.
   Sources: common words · sentences · AI essay · a saved passage.
   Options: drill length, capitals/punctuation/numbers, timed or finish-the-text. */
(function () {
  'use strict';

  const Pacer = (window.Pacer = window.Pacer || {});
  const { formatTime, clamp } = Pacer.ui;

  const WORDS = (
    'the of and to in that it is was for on are as with his they at be this have from or one had by word ' +
    'but not what all were we when your can said there use an each which she do how their if will up other ' +
    'about out many then them these so some her would make like him into time has look two more write go see ' +
    'number no way could people my than first water been call who oil its now find long down day did get come ' +
    'made may part over new sound take only little work know place year live me back give most very after thing ' +
    'our just name good sentence man think say great where help through much before line right too mean old any ' +
    'same tell boy follow came want show also around form three small set put end does another well large must ' +
    'big even such because turn here why ask went men read need land different home us move try kind hand picture ' +
    'again change off play spell air away animal house point page letter mother answer found study still learn ' +
    'should world high every near add food between own below country plant last school father keep tree never ' +
    'start city earth eye light thought head under story saw left few while along might close something seem next ' +
    'hard open example begin life always those both paper together got group often run'
  ).split(/\s+/);

  const SENTENCES = [
    'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the quiet hills.',
    'Pack my box with five dozen liquor jugs, then carry them gently down to the sparkling river.',
    'How vexingly quick daft zebras jump when the morning breeze arrives full of warm promise.',
    'Sphinx of black quartz, judge my vow as the colourful parade wanders past the bakery window.',
    'Bright kites dance above the park while children laugh and bicycles wobble along the path.',
    'We wandered through lavender fields and counted every cloud that drifted over the meadow.',
    'Kind words cost nothing but they travel further than almost anything else you can give away.'
  ];

  const HOME_KEYS = new Set(['a', 's', 'd', 'f', 'j', 'k', 'l', ';']);

  const KEY_ROWS = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
    ['shift', ' ', 'backspace']
  ];

  const KEY_LABELS = { shift: '⇧ shift', ' ': 'space', backspace: '⌫' };
  const KEY_CLASSES = { shift: 'key--wide', ' ': 'key--space', backspace: 'key--wide' };

  const MIN_DRILL = 10;
  const MAX_DRILL = 1000;
  const DEFAULT_DRILL = 28;
  const MIN_ESSAY = 50;
  const MAX_ESSAY = 5000;
  const DEFAULT_ESSAY = 300;
  /** Words built per second of a timed drill (≈130 wpm of headroom). */
  const TIMED_WORDS_PER_SEC = 2.2;
  const PREFS_KEY = 'pacer.typing';

  const SOURCE_LABELS = {
    words: 'common words',
    sentences: 'sentences',
    ai: 'AI essay',
    favourite: 'saved passage'
  };

  const PUNCTUATION = ['.', '.', '.', ',', ',', '!', '?', ';'];
  const STRIP_PUNCTUATION = /[.,!?;:"“”'’()\[\]{}<>/\\|~`^*_+=&%$#@-]/g;

  const el = {};
  const state = {
    source: 'words',
    drillWords: DEFAULT_DRILL,
    options: { capitals: true, punctuation: true, numbers: false },
    timed: false,
    durationSec: 0,
    aiWords: DEFAULT_ESSAY,
    aiText: '',
    favouriteText: '',
    favouriteTopic: '',
    text: '',
    target: [],
    spans: [],
    typed: '',
    drillWordCount: 0,
    totalKeystrokes: 0,
    correctKeystrokes: 0,
    startedAt: null,
    timerId: null,
    finished: false,
    logged: false,
    caret: null,
    keyNodes: new Map(),
    generating: false,
    controller: null,
    scrollTarget: 0,
    scrollRaf: null,
    reduceMotion: false
  };

  function cacheElements() {
    el.viewport = document.getElementById('typing-viewport');
    el.text = document.getElementById('typing-text');
    el.keyboard = document.getElementById('keyboard');
    el.status = document.getElementById('typing-status');
    el.wpm = document.getElementById('typing-wpm');
    el.accuracy = document.getElementById('typing-accuracy');
    el.errors = document.getElementById('typing-errors');
    el.time = document.getElementById('typing-time');
    el.timeLabel = document.getElementById('typing-time-label');
    el.progress = document.getElementById('typing-progress');
    el.result = document.getElementById('typing-result');
    el.restart = document.getElementById('typing-restart');
    el.newText = document.getElementById('typing-new');
    el.save = document.getElementById('typing-save');
    el.help = document.getElementById('typing-help');
    el.sourceButtons = Array.from(document.querySelectorAll('[data-typing-mode]'));
    el.timerButtons = Array.from(document.querySelectorAll('[data-typing-timer]'));
    el.aiPanel = document.getElementById('typing-ai-panel');
    el.topic = document.getElementById('typing-topic');
    el.generate = document.getElementById('typing-generate');
    el.generateLabel = document.getElementById('typing-generate-label');
    el.spinner = document.getElementById('typing-spinner');
    el.generateStatus = document.getElementById('typing-generate-status');
    el.lengthValue = document.getElementById('typing-length-value');
    el.lengthRange = document.getElementById('typing-length-range');
    el.lengthUp = document.getElementById('typing-length-up');
    el.lengthDown = document.getElementById('typing-length-down');
    el.drillValue = document.getElementById('typing-drill-value');
    el.drillRange = document.getElementById('typing-drill-range');
    el.drillNote = document.getElementById('typing-drill-note');
    el.optCapitals = document.getElementById('typing-opt-capitals');
    el.optPunctuation = document.getElementById('typing-opt-punctuation');
    el.optNumbers = document.getElementById('typing-opt-numbers');
    el.favSelect = document.getElementById('typing-fav-select');
    el.favLoad = document.getElementById('typing-fav-load');
    el.favSave = document.getElementById('typing-fav-save');
    el.favDelete = document.getElementById('typing-fav-delete');
    el.favCount = document.getElementById('typing-fav-count');
  }

  /* ------------------------------------------------------------ scrolling */

  /** Keep the caret's line inside the comfortable band of the viewport. */
  function scrollCaretIntoView(immediate) {
    const viewport = el.viewport;
    if (!viewport || state.spans.length === 0) return;

    const height = viewport.clientHeight;
    if (height === 0) return;

    const index = Math.min(state.typed.length, state.spans.length - 1);
    const span = state.spans[index];
    if (!span) return;

    const maxScroll = Math.max(0, viewport.scrollHeight - height);
    const lineTop = span.offsetTop;
    const lineBottom = lineTop + span.offsetHeight;

    // Headroom below the caret so the next line is already visible.
    const bandTop = state.scrollTarget + height * 0.18;
    const bandBottom = state.scrollTarget + height * 0.68;

    if (lineTop < bandTop || lineBottom > bandBottom) {
      state.scrollTarget = clamp(lineTop - height * 0.28, 0, maxScroll);
    }
    state.scrollTarget = clamp(state.scrollTarget, 0, maxScroll);

    if (immediate || state.reduceMotion) {
      cancelScrollAnimation();
      viewport.scrollTop = state.scrollTarget;
      return;
    }
    animateScroll();
  }

  function cancelScrollAnimation() {
    if (state.scrollRaf) {
      window.cancelAnimationFrame(state.scrollRaf);
      state.scrollRaf = null;
    }
  }

  /** Ease towards the scroll target on the next frames. */
  function animateScroll() {
    if (state.scrollRaf) return;

    const step = () => {
      const viewport = el.viewport;
      if (!viewport) {
        state.scrollRaf = null;
        return;
      }

      const difference = state.scrollTarget - viewport.scrollTop;
      if (Math.abs(difference) <= 0.5) {
        viewport.scrollTop = state.scrollTarget;
        state.scrollRaf = null;
        return;
      }

      viewport.scrollTop += difference * 0.25;
      state.scrollRaf = window.requestAnimationFrame(step);
    };

    state.scrollRaf = window.requestAnimationFrame(step);
  }

  /* -------------------------------------------------------------- metrics */

  /** Live metrics. */
  function metrics() {
    let correctChars = 0;
    const compareLength = Math.min(state.typed.length, state.target.length);
    for (let i = 0; i < compareLength; i += 1) {
      if (state.typed[i] === state.target[i]) correctChars += 1;
    }

    const errors = state.totalKeystrokes - state.correctKeystrokes;
    const elapsedMs = state.startedAt ? Date.now() - state.startedAt : 0;
    const elapsedMin = Math.max(elapsedMs / 60000, 1 / 600);

    const netWpm = state.startedAt ? (correctChars / 5) / elapsedMin : 0;
    const grossWpm = state.startedAt ? (state.totalKeystrokes / 5) / elapsedMin : 0;
    const accuracy = state.totalKeystrokes
      ? (state.correctKeystrokes / state.totalKeystrokes) * 100
      : 100;

    return { correctChars, errors, elapsedMs, netWpm, grossWpm, accuracy };
  }

  /** Words actually typed so far (state.target holds characters, not words). */
  function typedWordCount() {
    const typed = state.typed.trim();
    return typed ? typed.split(/\s+/).length : 0;
  }

  /** Time left in a timed drill, in seconds (null when untimed). */
  function secondsLeft() {
    if (!state.timed) return null;
    if (!state.startedAt) return state.durationSec;
    return state.durationSec - (Date.now() - state.startedAt) / 1000;
  }

  function paintMetrics() {
    const m = metrics();
    el.wpm.textContent = String(Math.round(m.netWpm));
    el.accuracy.textContent = m.accuracy.toFixed(1);
    el.errors.textContent = String(m.errors);

    const left = secondsLeft();
    if (left === null) {
      el.timeLabel.textContent = 'Time';
      el.time.textContent = formatTime(m.elapsedMs / 1000);
      const ratio = state.target.length
        ? clamp(state.typed.length / state.target.length, 0, 1)
        : 0;
      el.progress.style.width = `${(ratio * 100).toFixed(2)}%`;
    } else {
      el.timeLabel.textContent = 'Time left';
      el.time.textContent = formatTime(Math.max(0, left));
      const ratio = state.durationSec
        ? clamp(1 - Math.max(0, left) / state.durationSec, 0, 1)
        : 0;
      el.progress.style.width = `${(ratio * 100).toFixed(2)}%`;
    }
  }

  function ensureTimer() {
    if (state.timerId) return;
    state.timerId = window.setInterval(() => {
      paintMetrics();
      if (state.timed && !state.finished && state.startedAt && secondsLeft() <= 0) {
        finish('time');
      }
    }, 200);
  }

  function stopTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  /* ----------------------------------------------------------- drill text */

  function drillTarget() {
    const timedNeed = state.timed ? Math.ceil(state.durationSec * TIMED_WORDS_PER_SEC) : 0;
    return Math.max(state.drillWords, timedNeed);
  }

  function randomInt(max) {
    return Math.floor(Math.random() * max);
  }

  /** Pick `count` words, reshuffling so drills do not repeat in a fixed order. */
  function wordList(count) {
    const picked = [];
    for (let i = 0; i < count; i += 1) {
      picked.push(WORDS[randomInt(WORDS.length)]);
    }
    return picked;
  }

  function sentenceList(count) {
    const pool = SENTENCES.slice();
    const picked = [];
    let words = 0;
    let guard = 0;
    while (words < count && guard < count * 3) {
      if (pool.length === 0) pool.push(...SENTENCES);
      const sentence = pool.splice(randomInt(pool.length), 1)[0];
      picked.push(sentence);
      words += sentence.split(/\s+/).length;
      guard += 1;
    }
    return picked;
  }

  /**
   * Take whole sentences from `text` until at least `count` words are collected,
   * starting at a random sentence so "new text" varies. Cycles when the source
   * is shorter than the requested drill (long timed drills).
   */
  function excerptFrom(text, count, randomize) {
    const sentences = String(text)
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    if (sentences.length === 0) return String(text).trim();

    const parts = [];
    let words = 0;
    let index = randomize ? randomInt(sentences.length) : 0;
    let guard = 0;

    while (words < count && guard < sentences.length * 4) {
      const sentence = sentences[index % sentences.length];
      parts.push(sentence);
      words += sentence.split(/\s+/).length;
      index += 1;
      guard += 1;
    }

    return parts.join(' ');
  }

  /** Apply the capitals / punctuation / numbers options to a drill. */
  function applyDifficulty(text, isWordDrill) {
    let out = String(text);

    if (isWordDrill) {
      let tokens = out.split(/\s+/).filter(Boolean);

      if (state.options.numbers) {
        tokens = tokens.map((token) =>
          Math.random() < 0.15 ? String(randomInt(9000) + 100) : token
        );
      }
      if (state.options.capitals) {
        tokens = tokens.map((token, index) =>
          index === 0 || Math.random() < 0.22
            ? token.charAt(0).toUpperCase() + token.slice(1)
            : token
        );
      }
      if (state.options.punctuation) {
        tokens = tokens.map((token, index) =>
          index === tokens.length - 1 || Math.random() < 0.18
            ? token + PUNCTUATION[randomInt(PUNCTUATION.length)]
            : token
        );
      }
      return tokens.join(' ');
    }

    // Prose sources already carry capitals and punctuation; the toggles remove them.
    if (!state.options.punctuation) {
      out = out.replace(STRIP_PUNCTUATION, '').replace(/\s{2,}/g, ' ');
    }
    if (!state.options.capitals) out = out.toLowerCase();
    return out.trim();
  }

  /** Build the drill text for the current source, or null when none is loaded. */
  function buildDrillText(randomize) {
    const need = drillTarget();
    const isWordDrill = state.source === 'words';

    if (isWordDrill) {
      return applyDifficulty(wordList(need).join(' '), true);
    }

    if (state.source === 'sentences') {
      return applyDifficulty(sentenceList(need).join(' '), false);
    }

    const raw = state.source === 'ai' ? state.aiText : state.favouriteText;
    if (!raw) return null;

    return applyDifficulty(excerptFrom(raw, need, randomize), false);
  }

  /* ------------------------------------------------------------- painting */

  function paintChar(index) {
    const span = state.spans[index];
    if (!span) return;

    if (index >= state.typed.length) {
      span.className = index === state.typed.length ? 'char char--current' : 'char char--pending';
      return;
    }

    const correct = state.typed[index] === state.target[index];
    span.className = `char ${correct ? 'char--correct' : 'char--wrong'}`;
  }

  function paintAround(index) {
    paintChar(index - 1);
    paintChar(index);
    paintChar(index + 1);
  }

  function moveCaret() {
    if (!state.caret) return;
    const index = state.typed.length;
    if (index < state.spans.length) {
      el.text.insertBefore(state.caret, state.spans[index]);
    } else {
      el.text.appendChild(state.caret);
    }
  }

  function updateStatus() {
    if (!el.status) return;
    const mode = state.timed ? `${state.durationSec}s timed` : 'untimed';
    const source = SOURCE_LABELS[state.source] || state.source;
    el.status.textContent = state.drillWordCount
      ? `${state.drillWordCount} words · ${mode} · ${source}`
      : `${mode} · ${source}`;
  }

  function updateDrillNote() {
    if (!el.drillNote) return;
    el.drillNote.textContent = state.timed
      ? `Timed drill: at least ${drillTarget()} words are built so you do not run out.`
      : 'Word and sentence drills use exactly this many words.';
  }

  function resetRunState() {
    state.typed = '';
    state.totalKeystrokes = 0;
    state.correctKeystrokes = 0;
    state.startedAt = null;
    state.finished = false;
    state.logged = false;
    stopTimer();
  }

  /** Generic message in place of a drill (nothing loaded yet). */
  function showPlaceholder(message) {
    resetRunState();
    state.text = '';
    state.target = [];
    state.spans = [];
    state.drillWordCount = 0;

    el.text.textContent = '';
    const note = document.createElement('div');
    note.className = 'typing-placeholder';
    note.textContent = message;
    el.text.appendChild(note);

    el.result.hidden = true;
    el.result.textContent = '';
    highlightNextKey();
    updateStatus();
    paintMetrics();
  }

  function buildText(text) {
    state.text = text;
    state.target = Array.from(text);
    state.spans = [];
    state.drillWordCount = (text.match(/\S+/g) || []).length;
    resetRunState();

    state.caret = document.createElement('span');
    state.caret.className = 'typing-caret';

    el.text.textContent = '';
    const fragment = document.createDocumentFragment();
    state.target.forEach((character) => {
      const span = document.createElement('span');
      span.className = 'char char--pending';
      span.textContent = character;
      fragment.appendChild(span);
      state.spans.push(span);
    });

    el.text.appendChild(fragment);
    if (state.spans[0]) state.spans[0].className = 'char char--current';
    moveCaret();

    el.result.hidden = true;
    el.result.textContent = '';
    highlightNextKey();
    updateStatus();
    paintMetrics();
    cancelScrollAnimation();
    state.scrollTarget = 0;
    if (el.viewport) el.viewport.scrollTop = 0;
  }

  /** Rebuild the drill from the current source and options. */
  function rebuild(randomize) {
    const text = buildDrillText(randomize);

    if (!text) {
      if (state.source === 'ai') {
        showPlaceholder('Type a topic and press Generate for typing ✨');
      } else {
        showPlaceholder('Pick a saved passage and press Practise ❤');
      }
      return false;
    }

    buildText(text);
    return true;
  }

  /* ------------------------------------------------------------ keyboard */

  function buildKeyboard() {
    el.keyboard.textContent = '';
    state.keyNodes.clear();

    KEY_ROWS.forEach((row) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'kbd-row';

      row.forEach((key) => {
        const keyEl = document.createElement('div');
        const classes = ['key'];
        if (HOME_KEYS.has(key)) classes.push('key--home');
        if (KEY_CLASSES[key]) classes.push(KEY_CLASSES[key]);
        keyEl.className = classes.join(' ');
        keyEl.textContent = KEY_LABELS[key] || key;
        keyEl.dataset.key = key;
        rowEl.appendChild(keyEl);
        state.keyNodes.set(key, keyEl);
      });

      el.keyboard.appendChild(rowEl);
    });
  }

  /** Normalise an expected character to a physical key id. */
  function keyIdFor(character) {
    if (!character) return null;
    if (character === ' ') return ' ';
    if (character === '\n') return null;
    const lower = character.toLowerCase();
    if (/[a-z]/.test(lower)) return lower;
    if (HOME_KEYS.has(character)) return character;
    return null;
  }

  function highlightNextKey() {
    state.keyNodes.forEach((node) => node.classList.remove('key--next'));
    const id = keyIdFor(state.target[state.typed.length]);
    const node = id ? state.keyNodes.get(id) : null;
    if (node) node.classList.add('key--next');
  }

  function flashKey(id, className) {
    const node = id ? state.keyNodes.get(id) : null;
    if (!node) return;
    node.classList.add(className);
    window.setTimeout(() => node.classList.remove(className), 130);
  }

  /** Translate a KeyboardEvent to a virtual key id. */
  function eventKeyId(event) {
    const code = event.code || '';
    if (code === 'Space') return ' ';
    if (code === 'Backspace') return 'backspace';
    if (code === 'ShiftLeft' || code === 'ShiftRight') return 'shift';
    const match = /^Key([A-Z])$/.exec(code);
    if (match) return match[1].toLowerCase();
    if (event.key && event.key.length === 1) return event.key.toLowerCase();
    return null;
  }

  /* --------------------------------------------------------------- input */

  function handleKeydown(event) {
    const main = Pacer.main;
    if (!main || main.activeTab !== 'typing') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const id = eventKeyId(event);

    if (event.key === 'Backspace') {
      event.preventDefault();
      flashKey('backspace', 'key--active');
      if (state.finished) return;
      if (state.typed.length === 0) return;

      const index = state.typed.length - 1;
      state.typed = state.typed.slice(0, -1);
      paintAround(index);
      moveCaret();
      highlightNextKey();
      paintMetrics();
      scrollCaretIntoView(false);
      return;
    }

    // Let Shift show on the keyboard, then ignore non-printable keys.
    if (event.key === 'Shift') {
      flashKey('shift', 'key--active');
      return;
    }
    if (event.key.length !== 1) return;

    event.preventDefault();
    if (state.finished) return;
    if (state.target.length === 0) return;
    if (state.typed.length >= state.target.length) return;

    if (id) {
      const expected = keyIdFor(state.target[state.typed.length]);
      flashKey(id, expected && id !== expected ? 'key--error' : 'key--active');
    }

    if (!state.startedAt) {
      state.startedAt = Date.now();
      ensureTimer();
    }

    const index = state.typed.length;
    const expectedChar = state.target[index];
    state.totalKeystrokes += 1;
    if (event.key === expectedChar) state.correctKeystrokes += 1;

    state.typed += event.key;
    paintAround(index);
    moveCaret();
    highlightNextKey();
    paintMetrics();
    scrollCaretIntoView(false);

    if (state.typed.length >= state.target.length) finish('complete');
  }

  /* ------------------------------------------------------------- results */

  function finish(reason) {
    if (state.finished) return;
    state.finished = true;
    stopTimer();
    paintMetrics();

    const m = metrics();
    const timedOut = reason === 'time';

    el.result.hidden = false;
    el.result.textContent = '';

    const heading = document.createElement('h3');
    heading.className = 'title';
    heading.style.fontSize = '1.15rem';
    heading.textContent = timedOut ? "Time's up! ⏱" : 'Run complete! 🎉';
    el.result.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'grid-3';
    row.style.marginTop = '0.6rem';
    [
      ['Speed', `${Math.round(m.netWpm)} wpm`],
      ['Accuracy', `${m.accuracy.toFixed(1)}%`],
      ['Errors', String(m.errors)],
      ['Time', formatTime(m.elapsedMs / 1000)]
    ].forEach(([label, value]) => {
      const metric = document.createElement('div');
      metric.className = 'metric';

      const labelEl = document.createElement('span');
      labelEl.className = 'metric__label';
      labelEl.textContent = label;

      const valueEl = document.createElement('span');
      valueEl.className = 'metric__value';
      valueEl.textContent = value;

      metric.appendChild(labelEl);
      metric.appendChild(valueEl);
      row.appendChild(metric);
    });
    el.result.appendChild(row);

    logSession(true);
  }

  async function logSession(auto) {
    const m = metrics();

    if (state.logged) {
      if (auto) return;
      Pacer.ui.toast('This run is already saved.', 'ok');
      return;
    }
    if (!state.startedAt || m.correctChars === 0) {
      if (!auto) Pacer.ui.toast('Type something first, then save.', 'error');
      return;
    }

    state.logged = true;
    try {
      await Pacer.api.saveSession({
        type: 'typing',
        wpm: Math.round(m.netWpm * 10) / 10,
        accuracy: Math.round(m.accuracy * 10) / 10,
        errors: m.errors,
        durationSec: Math.round((m.elapsedMs / 1000) * 10) / 10,
        wordCount: typedWordCount()
      });
      Pacer.ui.toast(auto ? 'Typing run saved ✨' : 'Typing run saved to history ✨', 'ok');
      if (Pacer.analytics) Pacer.analytics.invalidate();
    } catch (error) {
      state.logged = false;
      Pacer.ui.toast(`Could not save run: ${error.message}`, 'error');
    }
  }

  /* ---------------------------------------------------------- AI passages */

  function setGenerating(active) {
    state.generating = active;
    el.generate.disabled = active;
    el.spinner.hidden = !active;
    el.generateLabel.textContent = active ? 'Writing…' : '✨ Generate for typing';
  }

  function setEssayLength(next) {
    const rounded = Math.round(Number(next) / 10) * 10;
    state.aiWords = clamp(Number.isFinite(rounded) ? rounded : DEFAULT_ESSAY, MIN_ESSAY, MAX_ESSAY);
    el.lengthValue.textContent = String(state.aiWords);
    el.lengthRange.value = String(state.aiWords);
    savePrefs();
  }

  async function generateForTyping() {
    if (state.generating) return;

    const topic = el.topic.value.trim();
    setGenerating(true);

    const startedAt = Date.now();
    const ticker = window.setInterval(() => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
      el.generateStatus.textContent = `Asking your local model for ${state.aiWords} words… ${seconds}s`;
    }, 500);
    el.generateStatus.textContent = `Asking your local model for ${state.aiWords} words… 0s`;

    const controller = new AbortController();
    state.controller = controller;

    try {
      const result = await Pacer.api.generateText(topic, {
        signal: controller.signal,
        words: state.aiWords
      });

      state.aiText = result.text;
      state.source = 'ai';
      updateSourceButtons();
      rebuild(false);

      const from = result.provider === 'local' ? 'built-in model' : 'llama-server';
      el.generateStatus.textContent =
        result.source === 'llama'
          ? `${result.wordCount} words from the ${from} · ${(result.durationMs / 1000).toFixed(1)}s · ready to type`
          : `Offline passage (${result.fallbackReason}). Ready to type.`;
    } catch (error) {
      el.generateStatus.textContent =
        error.name === 'AbortError' ? 'Generation cancelled.' : `Generation failed: ${error.message}`;
      if (error.name !== 'AbortError') {
        Pacer.ui.toast(`Generation failed: ${error.message}`, 'error');
      }
    } finally {
      window.clearInterval(ticker);
      setGenerating(false);
      state.controller = null;
    }
  }

  /* ------------------------------------------------------------ favourites */

  function mountFavourites() {
    if (!Pacer.favourites) return;

    state.favourites = Pacer.favourites.mount({
      select: el.favSelect,
      load: el.favLoad,
      remove: el.favDelete,
      save: el.favSave,
      count: el.favCount,
      getCurrent: () => ({
        text: state.source === 'favourite' ? state.favouriteText : state.text,
        topic: state.source === 'favourite' ? state.favouriteTopic : SOURCE_LABELS[state.source],
        source: SOURCE_LABELS[state.source]
      }),
      onLoad: (favourite) => {
        state.source = 'favourite';
        state.favouriteText = favourite.text;
        state.favouriteTopic = favourite.topic || '';
        updateSourceButtons();
        rebuild(false);
        Pacer.ui.toast(
          favourite.topic ? `Practising “${favourite.topic}”` : 'Practising your saved passage',
          'ok'
        );
      }
    });

    state.favourites.refresh();
  }

  /* --------------------------------------------------------------- source */

  function updateSourceButtons() {
    el.sourceButtons.forEach((button) => {
      const active = button.dataset.typingMode === state.source;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('btn--lav', active);
    });
    if (el.aiPanel) el.aiPanel.hidden = state.source !== 'ai';
  }

  function setSource(source, randomize) {
    state.source = source;
    updateSourceButtons();

    if (source === 'ai' && !state.aiText) {
      showPlaceholder('Type a topic and press Generate for typing ✨');
      updateStatus();
      return;
    }
    if (source === 'favourite' && !state.favouriteText) {
      showPlaceholder('Pick a saved passage and press Practise ❤');
      updateStatus();
      return;
    }

    rebuild(randomize === true);
    savePrefs();
  }

  function setTimed(durationSec) {
    state.timed = durationSec > 0;
    state.durationSec = durationSec;
    el.timerButtons.forEach((button) => {
      const active = Number(button.dataset.typingTimer) === durationSec;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('btn--lav', active);
    });
    updateDrillNote();
    rebuild(false);
    savePrefs();
  }

  function setDrillWords(next) {
    state.drillWords = clamp(Math.round(Number(next)), MIN_DRILL, MAX_DRILL);
    el.drillValue.textContent = String(state.drillWords);
    el.drillRange.value = String(state.drillWords);
    updateDrillNote();
    rebuild(false);
    savePrefs();
  }

  /* ------------------------------------------------------------ prefs */

  function savePrefs() {
    try {
      window.localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          source: state.source,
          drillWords: state.drillWords,
          options: state.options,
          timed: state.timed,
          durationSec: state.durationSec,
          aiWords: state.aiWords
        })
      );
    } catch {
      /* storage unavailable; options simply are not remembered */
    }
  }

  function loadPrefs() {
    let prefs = null;
    try {
      prefs = JSON.parse(window.localStorage.getItem(PREFS_KEY) || 'null');
    } catch {
      prefs = null;
    }
    if (!prefs || typeof prefs !== 'object') return;

    if (Number.isFinite(prefs.drillWords)) state.drillWords = clamp(prefs.drillWords, MIN_DRILL, MAX_DRILL);
    if (Number.isFinite(prefs.aiWords)) state.aiWords = clamp(prefs.aiWords, MIN_ESSAY, MAX_ESSAY);
    if (prefs.options && typeof prefs.options === 'object') {
      state.options = {
        capitals: prefs.options.capitals !== false,
        punctuation: prefs.options.punctuation !== false,
        numbers: prefs.options.numbers === true
      };
    }
    if (Number.isFinite(prefs.durationSec)) state.durationSec = prefs.durationSec;
    state.timed = typeof prefs.timed === 'boolean' ? prefs.timed : state.durationSec > 0;
    if (['words', 'sentences', 'ai', 'favourite'].includes(prefs.source)) state.source = prefs.source;
  }

  /* --------------------------------------------------------------- setup */

  function bindControls() {
    el.sourceButtons.forEach((button) => {
      button.addEventListener('click', () => setSource(button.dataset.typingMode, false));
    });

    el.timerButtons.forEach((button) => {
      button.addEventListener('click', () => setTimed(Number(button.dataset.typingTimer)));
    });

    el.drillRange.addEventListener('input', () => setDrillWords(Number(el.drillRange.value)));

    el.optCapitals.addEventListener('change', () => {
      state.options.capitals = el.optCapitals.checked;
      rebuild(false);
      savePrefs();
    });
    el.optPunctuation.addEventListener('change', () => {
      state.options.punctuation = el.optPunctuation.checked;
      rebuild(false);
      savePrefs();
    });
    el.optNumbers.addEventListener('change', () => {
      state.options.numbers = el.optNumbers.checked;
      rebuild(false);
      savePrefs();
    });

    el.lengthUp.addEventListener('click', () => setEssayLength(state.aiWords + 50));
    el.lengthDown.addEventListener('click', () => setEssayLength(state.aiWords - 50));
    el.lengthRange.addEventListener('input', () => setEssayLength(Number(el.lengthRange.value)));
    el.generate.addEventListener('click', generateForTyping);
    el.topic.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        generateForTyping();
      }
    });

    // Restart replays the same drill; New text reshuffles it.
    el.restart.addEventListener('click', () => rebuild(false));
    el.newText.addEventListener('click', () => rebuild(true));
    el.save.addEventListener('click', () => logSession(false));

    el.viewport.addEventListener('click', () => el.viewport.focus());

    window.addEventListener('resize', () => scrollCaretIntoView(true));

    document.addEventListener('keydown', handleKeydown);
  }

  function init() {
    cacheElements();
    buildKeyboard();
    loadPrefs();

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

    // Reflect restored preferences in the controls.
    el.optCapitals.checked = state.options.capitals;
    el.optPunctuation.checked = state.options.punctuation;
    el.optNumbers.checked = state.options.numbers;
    setEssayLength(state.aiWords);
    el.drillValue.textContent = String(state.drillWords);
    el.drillRange.value = String(state.drillWords);
    el.timerButtons.forEach((button) => {
      const active = Number(button.dataset.typingTimer) === (state.timed ? state.durationSec : 0);
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('btn--lav', active);
    });
    updateDrillNote();

    bindControls();
    mountFavourites();
    setSource(state.source, false);
  }

  Pacer.typing = {
    init,
    setSource,
    state,
    metrics,
    /** Load a saved passage straight into a drill (used by the reading tab). */
    practise: (favourite) => {
      state.source = 'favourite';
      state.favouriteText = favourite.text;
      state.favouriteTopic = favourite.topic || '';
      updateSourceButtons();
      rebuild(false);
    }
  };
})();
