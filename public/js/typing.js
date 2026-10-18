/* Pacer — Tab 2: Touch Typing with live colour coding and a virtual keyboard. */
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

  const AI_WORD_BUDGET = 38;

  const el = {};
  const state = {
    mode: 'words',
    text: '',
    target: [],
    spans: [],
    typed: '',
    totalKeystrokes: 0,
    correctKeystrokes: 0,
    startedAt: null,
    timerId: null,
    finished: false,
    logged: false,
    caret: null,
    keyNodes: new Map(),
    aiBusy: false
  };

  function cacheElements() {
    el.viewport = document.getElementById('typing-viewport');
    el.text = document.getElementById('typing-text');
    el.keyboard = document.getElementById('keyboard');
    el.wpm = document.getElementById('typing-wpm');
    el.accuracy = document.getElementById('typing-accuracy');
    el.errors = document.getElementById('typing-errors');
    el.time = document.getElementById('typing-time');
    el.progress = document.getElementById('typing-progress');
    el.result = document.getElementById('typing-result');
    el.restart = document.getElementById('typing-restart');
    el.newText = document.getElementById('typing-new');
    el.save = document.getElementById('typing-save');
    el.modeButtons = Array.from(document.querySelectorAll('[data-typing-mode]'));
    el.help = document.getElementById('typing-help');
  }

  /* -------------------------------------------------------------- metrics */

  /** Live metrics, computed exactly as specified in the plan. */
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

  function paintMetrics() {
    const m = metrics();
    el.wpm.textContent = String(Math.round(m.netWpm));
    el.accuracy.textContent = m.accuracy.toFixed(1);
    el.errors.textContent = String(m.errors);
    el.time.textContent = formatTime(m.elapsedMs / 1000);

    const ratio = state.target.length ? clamp(state.typed.length / state.target.length, 0, 1) : 0;
    el.progress.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  function ensureTimer() {
    if (state.timerId) return;
    state.timerId = window.setInterval(paintMetrics, 250);
  }

  function stopTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
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

  /** Repaint the characters that a single keystroke could have touched. */
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

  function buildText(text) {
    state.text = text;
    state.target = Array.from(text);
    state.spans = [];
    state.typed = '';
    state.totalKeystrokes = 0;
    state.correctKeystrokes = 0;
    state.startedAt = null;
    state.finished = false;
    state.logged = false;

    stopTimer();

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
    state.spans[0] && (state.spans[0].className = 'char char--current');
    moveCaret();

    el.result.hidden = true;
    el.result.textContent = '';
    highlightNextKey();
    paintMetrics();
    if (el.viewport) el.viewport.scrollTop = 0;
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

  function clearKeyStates() {
    state.keyNodes.forEach((node) => {
      node.classList.remove('key--next', 'key--active', 'key--error');
    });
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
      return;
    }

    // Ignore navigation and modifier keys, but let Shift show on the keyboard.
    if (event.key === 'Shift') {
      flashKey('shift', 'key--active');
      return;
    }
    if (event.key.length !== 1) return;

    event.preventDefault();
    if (state.finished) return;
    if (state.typed.length >= state.target.length) return;

    if (id) {
      // Wrong physical key for the expected character.
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

    if (state.typed.length >= state.target.length) finish();
  }

  /* ------------------------------------------------------------- results */

  function finish() {
    if (state.finished) return;
    state.finished = true;
    stopTimer();
    paintMetrics();

    const m = metrics();
    el.result.hidden = false;
    el.result.textContent = '';

    const heading = document.createElement('h3');
    heading.className = 'title';
    heading.style.fontSize = '1.15rem';
    heading.textContent = 'Run complete! 🎉';
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
        wordCount: state.target.length
      });
      Pacer.ui.toast(auto ? 'Typing run saved ✨' : 'Typing run saved to history ✨', 'ok');
      if (Pacer.analytics) Pacer.analytics.invalidate();
    } catch (error) {
      state.logged = false;
      Pacer.ui.toast(`Could not save run: ${error.message}`, 'error');
    }
  }

  /* ---------------------------------------------------------- text sources */

  function wordsText() {
    const picked = [];
    for (let i = 0; i < 28; i += 1) {
      picked.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
    }
    return picked.join(' ');
  }

  function sentenceText() {
    const shuffled = SENTENCES.slice().sort(() => Math.random() - 0.5);
    return `${shuffled[0]} ${shuffled[1]}`;
  }

  /** First few complete sentences of an essay, capped to a sane length. */
  function excerpt(text) {
    const sentences = String(text).match(/[^.!?]+[.!?]+/g) || [String(text)];
    let out = '';
    for (const sentence of sentences) {
      if ((out + sentence).split(/\s+/).length > AI_WORD_BUDGET && out) break;
      out += sentence;
    }
    return out.trim() || String(text).trim();
  }

  async function loadAiText() {
    if (state.aiBusy) return;

    // Reuse whatever the reading tab already generated — no second 40s wait.
    const existing = Pacer.reader && Pacer.reader.getGeneratedText
      ? Pacer.reader.getGeneratedText()
      : '';

    if (existing) {
      buildText(excerpt(existing));
      el.help.textContent = 'Practising on the essay from the Speed Reading tab. Type away!';
      return;
    }

    state.aiBusy = true;
    el.help.textContent = 'Asking your local model for an essay… this can take 30–60s.';
    try {
      const topic = (Pacer.reader && Pacer.reader.getTopic && Pacer.reader.getTopic()) || '';
      const result = await Pacer.api.generateText(topic);
      buildText(excerpt(result.text));
      el.help.textContent =
        result.source === 'llama'
          ? `Practising on a fresh ${result.wordCount}-word essay from ${result.model}.`
          : `Practising on a built-in essay (${result.fallbackReason}).`;
    } catch (error) {
      buildText(sentenceText());
      el.help.textContent = `Could not reach the generator (${error.message}) — using a built-in sentence.`;
    } finally {
      state.aiBusy = false;
    }
  }

  function setMode(mode) {
    state.mode = mode;
    el.modeButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.typingMode === mode));
      button.classList.toggle('btn--lav', button.dataset.typingMode === mode);
    });

    if (mode === 'words') {
      buildText(wordsText());
      el.help.textContent = 'Just start typing — the timer begins on your first keystroke. Backspace corrects, but the mistake stays in your accuracy score.';
    } else if (mode === 'sentences') {
      buildText(sentenceText());
      el.help.textContent = 'Full sentences, capital letters and punctuation included. Shift is your friend.';
    } else {
      loadAiText();
    }
  }

  function nextText() {
    setMode(state.mode);
  }

  /* --------------------------------------------------------------- setup */

  function bindControls() {
    el.modeButtons.forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.typingMode));
    });

    el.restart.addEventListener('click', () => buildText(state.text));
    el.newText.addEventListener('click', nextText);
    el.save.addEventListener('click', () => logSession(false));

    // Clicking anywhere in the practice area focuses it.
    el.viewport.addEventListener('click', () => el.viewport.focus());

    document.addEventListener('keydown', handleKeydown);
  }

  function init() {
    cacheElements();
    buildKeyboard();
    bindControls();
    setMode('words');
  }

  Pacer.typing = { init, setMode, state, metrics };
})();
