'use strict';

/**
 * Session history persistence for Pacer.
 *
 * Guarantees:
 *  - the file is never left half-written (write to .tmp, then rename)
 *  - concurrent appends are serialised through a promise chain
 *  - a corrupt file is backed up rather than silently destroyed
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE_VERSION = 2;
const MAX_SESSIONS = 1000;
const MAX_TOPIC_LENGTH = 200;
const MAX_FAVOURITE_LENGTH = 100000;
const SESSION_TYPES = new Set(['reading', 'typing']);

/** Strip control characters and collapse whitespace. */
function cleanText(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalise an incoming session payload.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validateSession(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'Body must be a JSON object.' };
  }

  const { type } = payload;
  if (typeof type !== 'string' || !SESSION_TYPES.has(type)) {
    return { ok: false, error: 'Field "type" must be "reading" or "typing".' };
  }

  const wpm = Number(payload.wpm);
  if (!Number.isFinite(wpm) || wpm < 0 || wpm > 2000) {
    return { ok: false, error: 'Field "wpm" must be a number between 0 and 2000.' };
  }

  let accuracy = null;
  if (payload.accuracy !== undefined && payload.accuracy !== null) {
    accuracy = Number(payload.accuracy);
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) {
      return { ok: false, error: 'Field "accuracy" must be a number between 0 and 100, or null.' };
    }
    accuracy = Math.round(accuracy * 10) / 10;
  }

  let errors = 0;
  if (payload.errors !== undefined && payload.errors !== null) {
    errors = Number(payload.errors);
    if (!Number.isInteger(errors) || errors < 0 || errors > 100000) {
      return { ok: false, error: 'Field "errors" must be a non-negative integer.' };
    }
  }

  let durationSec = 0;
  if (payload.durationSec !== undefined && payload.durationSec !== null) {
    durationSec = Number(payload.durationSec);
    if (!Number.isFinite(durationSec) || durationSec < 0 || durationSec > 86400) {
      return { ok: false, error: 'Field "durationSec" must be a number between 0 and 86400.' };
    }
    durationSec = Math.round(durationSec * 10) / 10;
  }

  let wordCount = 0;
  if (payload.wordCount !== undefined && payload.wordCount !== null) {
    wordCount = Number(payload.wordCount);
    if (!Number.isInteger(wordCount) || wordCount < 0 || wordCount > 1000000) {
      return { ok: false, error: 'Field "wordCount" must be a non-negative integer.' };
    }
  }

  let topic = null;
  if (payload.topic !== undefined && payload.topic !== null && payload.topic !== '') {
    if (typeof payload.topic !== 'string') {
      return { ok: false, error: 'Field "topic" must be a string.' };
    }
    topic = cleanText(payload.topic).slice(0, MAX_TOPIC_LENGTH) || null;
  }

  return {
    ok: true,
    value: {
      id: `s_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
      type,
      createdAt: new Date().toISOString(),
      wpm: Math.round(wpm * 10) / 10,
      accuracy,
      errors,
      durationSec,
      wordCount,
      topic
    }
  };
}

/**
 * Validate a saved passage ("favourite").
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validateFavourite(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'Body must be a JSON object.' };
  }

  if (typeof payload.text !== 'string' || payload.text.trim() === '') {
    return { ok: false, error: 'Field "text" must be a non-empty string.' };
  }

  const text = payload.text.replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_FAVOURITE_LENGTH) {
    return { ok: false, error: `Field "text" must be ${MAX_FAVOURITE_LENGTH} characters or fewer.` };
  }

  let topic = null;
  if (typeof payload.topic === 'string' && payload.topic.trim() !== '') {
    topic = cleanText(payload.topic).slice(0, MAX_TOPIC_LENGTH) || null;
  }

  let source = null;
  if (typeof payload.source === 'string' && payload.source.trim() !== '') {
    source = cleanText(payload.source).slice(0, 40) || null;
  }

  return {
    ok: true,
    value: {
      id: `f_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
      text,
      topic,
      source,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      createdAt: new Date().toISOString()
    }
  };
}

/** Settings the server is allowed to persist. */
const SETTING_KEYS = new Set(['provider']);
const SETTING_VALUES = { provider: new Set(['server', 'local']) };

/** Keep only known, valid settings from a patch. */
function sanitizeSettings(patch) {
  const out = {};
  if (!isPlainObject(patch)) return out;

  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.has(key)) continue;
    if (SETTING_VALUES[key] && !SETTING_VALUES[key].has(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Keep only entries that still look like favourites when loading from disk. */
function sanitizeLoadedFavourites(raw) {
  if (!Array.isArray(raw)) return [];
  const valid = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.text !== 'string' || entry.text.trim() === '') continue;
    valid.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `f_loaded_${valid.length}`,
      text: entry.text,
      topic: typeof entry.topic === 'string' && entry.topic ? cleanText(entry.topic) : null,
      source: typeof entry.source === 'string' && entry.source ? cleanText(entry.source) : null,
      wordCount: Number.isInteger(entry.wordCount)
        ? entry.wordCount
        : entry.text.split(/\s+/).filter(Boolean).length,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString()
    });
  }
  return valid;
}

function average(values) {  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10) / 10;
}

function round(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

/** Compute dashboard aggregates from a session list. */
function computeAggregates(sessions) {
  const reading = sessions.filter((session) => session.type === 'reading');
  const typing = sessions.filter((session) => session.type === 'typing');
  const typingAccuracy = typing
    .map((session) => session.accuracy)
    .filter((value) => typeof value === 'number');

  return {
    totalSessions: sessions.length,
    totalPracticeSec: Math.round(sessions.reduce((sum, session) => sum + (session.durationSec || 0), 0)),
    reading: {
      count: reading.length,
      avgWpm: average(reading.map((session) => session.wpm)),
      bestWpm: reading.length ? round(Math.max(...reading.map((session) => session.wpm))) : null
    },
    typing: {
      count: typing.length,
      avgWpm: average(typing.map((session) => session.wpm)),
      bestWpm: typing.length ? round(Math.max(...typing.map((session) => session.wpm))) : null,
      avgAccuracy: average(typingAccuracy),
      totalErrors: typing.reduce((sum, session) => sum + (session.errors || 0), 0)
    }
  };
}

/** Keep only entries that still look like sessions when loading from disk. */
function sanitizeLoadedSessions(raw) {
  if (!Array.isArray(raw)) return [];
  const valid = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.type !== 'string' || !SESSION_TYPES.has(entry.type)) continue;
    if (!Number.isFinite(Number(entry.wpm))) continue;
    valid.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `s_loaded_${valid.length}`,
      type: entry.type,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
      wpm: Number(entry.wpm),
      accuracy: Number.isFinite(Number(entry.accuracy)) ? Number(entry.accuracy) : null,
      errors: Number.isInteger(entry.errors) ? entry.errors : 0,
      durationSec: Number.isFinite(Number(entry.durationSec)) ? Number(entry.durationSec) : 0,
      wordCount: Number.isInteger(entry.wordCount) ? entry.wordCount : 0,
      topic: typeof entry.topic === 'string' && entry.topic ? cleanText(entry.topic) : null
    });
  }
  return valid.slice(-MAX_SESSIONS);
}

/**
 * Create the stats store.
 * @param {{ file: string, logger?: Console }} options
 */
function createStatsStore(options) {
  const file = path.resolve(options.file);
  const log = options.logger || console;
  const dir = path.dirname(file);

  let sessions = [];
  let favourites = [];
  let settings = {};
  let loaded = false;
  let writeChain = Promise.resolve();

  /** Serialise every write so concurrent POSTs cannot interleave. */
  function enqueue(task) {
    const next = writeChain.then(task, task);
    // Keep the chain alive even if a write rejects.
    writeChain = next.catch(() => {});
    return next;
  }

  async function writeFileAtomic(payload) {
    const tmp = `${file}.tmp`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  }

  function snapshot() {
    return { version: STORE_VERSION, sessions, favourites, settings };
  }

  function persist() {
    return enqueue(() => writeFileAtomic(snapshot()));
  }

  /** Load from disk, recovering from missing or corrupt files. */
  async function init() {
    if (loaded) return;

    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        sessions = [];
        favourites = [];
        loaded = true;
        await persist();
        log.log(`[stats] created new history file at ${file}`);
        return;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || !('sessions' in parsed)) {
        throw new Error('missing "sessions" array');
      }
      sessions = sanitizeLoadedSessions(parsed.sessions);
      favourites = sanitizeLoadedFavourites(parsed.favourites);
      settings = sanitizeSettings(parsed.settings);
      loaded = true;
      log.log(
        `[stats] loaded ${sessions.length} session(s) and ${favourites.length} ` +
          `favourite(s) from ${file}`
      );
    } catch (error) {
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        await fs.rename(file, backup);
        log.warn(`[stats] ${file} was unreadable (${error.message}); backed up to ${backup}`);
      } catch (renameError) {
        log.warn(`[stats] ${file} was unreadable (${error.message}) and could not be backed up: ${renameError.message}`);
      }
      sessions = [];
      favourites = [];
      loaded = true;
      await persist();
    }
  }

  /**
   * Current history plus aggregates.
   * Mirrors the SQLite store's shape so the server is backend-agnostic.
   */
  async function getState(query = {}) {
    await init();

    const limit = Math.min(1000, Math.max(1, Number(query.limit) || 200));
    const total = sessions.length;
    const window = sessions.slice(-limit);

    return {
      sessions: window.slice(),
      count: window.length,
      total,
      limit,
      truncated: total > window.length,
      backend: 'json',
      aggregates: computeAggregates(sessions)
    };
  }

  /** Validate and append one session. Throws { statusCode } on invalid input. */
  async function append(payload) {
    await init();

    const result = validateSession(payload);
    if (!result.ok) {
      const error = new Error(result.error);
      error.statusCode = 400;
      throw error;
    }

    sessions.push(result.value);
    if (sessions.length > MAX_SESSIONS) {
      sessions = sessions.slice(-MAX_SESSIONS);
    }

    await persist();
    return { session: result.value, count: sessions.length };
  }

  /* -------------------------------------------------------------- settings */

  async function getSettings() {
    await init();
    return Object.assign({}, settings);
  }

  async function setSettings(patch) {
    await init();
    settings = Object.assign({}, settings, sanitizeSettings(patch));
    await persist();
    return Object.assign({}, settings);
  }

  /* ------------------------------------------------------------ favourites */

  /** All saved passages, newest first. */
  async function listFavourites() {
    await init();
    return favourites
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((favourite) => Object.assign({}, favourite));
  }

  /** Save a passage. Identical text is not stored twice. */
  async function addFavourite(payload) {
    await init();

    const result = validateFavourite(payload);
    if (!result.ok) {
      const error = new Error(result.error);
      error.statusCode = 400;
      throw error;
    }

    const existing = favourites.find((favourite) => favourite.text === result.value.text);
    if (existing) return { favourite: Object.assign({}, existing), duplicate: true };

    favourites.push(result.value);
    await persist();
    return { favourite: result.value, duplicate: false };
  }

  async function deleteFavourite(id) {
    await init();
    const before = favourites.length;
    favourites = favourites.filter((favourite) => favourite.id !== String(id));
    if (favourites.length === before) return { deleted: false };
    await persist();
    return { deleted: true };
  }

  /** Wipe all history. */
  async function clear() {
    await init();
    sessions = [];
    await persist();
    return {
      sessions: [],
      count: 0,
      total: 0,
      backend: 'json',
      aggregates: computeAggregates([])
    };
  }

  return {
    kind: 'json',
    file,
    init,
    getState,
    append,
    clear,
    listFavourites,
    addFavourite,
    deleteFavourite,
    getSettings,
    setSettings,
    close: async () => {},
    MAX_SESSIONS
  };
}

module.exports = {
  createStatsStore,
  validateSession,
  validateFavourite,
  sanitizeSettings,
  computeAggregates,
  sanitizeLoadedSessions,
  sanitizeLoadedFavourites,
  cleanText,
  STORE_VERSION,
  MAX_SESSIONS,
  MAX_FAVOURITE_LENGTH
};
