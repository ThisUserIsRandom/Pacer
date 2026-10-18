'use strict';

/**
 * SQLite-backed session history for Pacer.
 *
 * Uses Node's built-in `node:sqlite` (Node 22+), so there is no npm dependency
 * and no native build step. Compared with the JSON file store this gives real
 * indexed aggregation, cheap appends, and crash-safe writes via WAL.
 *
 * The interface matches the JSON store exactly, so the server does not care
 * which one is active.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const { validateSession, validateFavourite, cleanText } = require('./stats-store');

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('reading', 'typing')),
  created_at   TEXT NOT NULL,
  wpm          REAL NOT NULL,
  accuracy     REAL,
  errors       INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL    NOT NULL DEFAULT 0,
  word_count   INTEGER NOT NULL DEFAULT 0,
  topic        TEXT
);

-- Passages the user saved to practise again, shared by both tabs.
CREATE TABLE IF NOT EXISTS favourites (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  topic      TEXT,
  source     TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at   ON sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_type         ON sessions (type);
CREATE INDEX IF NOT EXISTS idx_favourites_created_at ON favourites (created_at);
CREATE INDEX IF NOT EXISTS idx_favourites_text       ON favourites (text);
`;

/** Average that returns null for an empty set, rounded to 1dp. */
function avg(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (usable.length === 0) return null;
  return Math.round((usable.reduce((sum, value) => sum + value, 0) / usable.length) * 10) / 10;
}

/**
 * Create the database directory if needed.
 *
 * Deliberately NOT `mkdir(dir, { recursive: true })`: on some virtual file
 * systems (notably procfs) a recursive mkdir never settles, which would hang
 * startup forever with no error. A plain mkdir fails fast instead.
 */
async function ensureDir(dir) {
  try {
    await fs.mkdir(dir);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw new Error(`cannot create the database directory ${dir}: ${error.code || error.message}`);
    }
  }
}

function round1(value) {
  return value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10;
}

/**
 * @param {{ file: string, logger?: Console }} options
 */
function createSqliteStore(options) {
  const file = path.resolve(options.file);
  const log = options.logger || console;

  let DatabaseSync = null;
  let db = null;
  let closed = false;

  /** Map a database row to the API's session shape. */
  function rowToSession(row) {
    return {
      id: row.id,
      type: row.type,
      createdAt: row.created_at,
      wpm: row.wpm,
      accuracy: row.accuracy === null ? null : row.accuracy,
      errors: row.errors,
      durationSec: row.duration_sec,
      wordCount: row.word_count,
      topic: row.topic === null ? null : row.topic
    };
  }

  async function init() {
    if (db) return;

    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch (error) {
      const wrapped = new Error(`node:sqlite is unavailable: ${error.message}`);
      wrapped.code = 'SQLITE_UNAVAILABLE';
      throw wrapped;
    }

    await ensureDir(path.dirname(file));
    db = new DatabaseSync(file);

    // WAL keeps readers and writers from blocking each other and survives crashes.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION)
    );

    const count = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
    log.log(`[stats] sqlite ready at ${file} (${count} session(s))`);
  }

  /** Map a database row to the API's favourite shape. */
  function rowToFavourite(row) {
    return {
      id: row.id,
      text: row.text,
      topic: row.topic === null ? null : row.topic,
      source: row.source === null ? null : row.source,
      wordCount: row.word_count,
      createdAt: row.created_at
    };
  }

  async function getState(query = {}) {
    await init();

    const limit = Math.min(1000, Math.max(1, Number(query.limit) || 200));

    const total = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;

    // Most recent `limit` rows; reversed so charts read oldest-to-newest.
    const rows = db
      .prepare('SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit);
    rows.reverse();

    const byType = db
      .prepare(
        `SELECT type,
                COUNT(*)        AS count,
                AVG(wpm)        AS avg_wpm,
                MAX(wpm)        AS best_wpm
           FROM sessions
          GROUP BY type`
      )
      .all();

    const typingExtra = db
      .prepare(
        `SELECT AVG(accuracy)            AS avg_accuracy,
                COALESCE(SUM(errors), 0) AS total_errors
           FROM sessions
          WHERE type = 'typing'`
      )
      .get();

    const practice = db
      .prepare('SELECT COALESCE(SUM(duration_sec), 0) AS total_sec FROM sessions')
      .get();

    const find = (type) => byType.find((row) => row.type === type) || null;
    const reading = find('reading');
    const typing = find('typing');

    return {
      sessions: rows.map(rowToSession),
      count: rows.length,
      total,
      limit,
      truncated: total > rows.length,
      backend: 'sqlite',
      aggregates: {
        totalSessions: total,
        totalPracticeSec: Math.round(practice.total_sec),
        reading: {
          count: reading ? reading.count : 0,
          avgWpm: reading ? round1(reading.avg_wpm) : null,
          bestWpm: reading ? round1(reading.best_wpm) : null
        },
        typing: {
          count: typing ? typing.count : 0,
          avgWpm: typing ? round1(typing.avg_wpm) : null,
          bestWpm: typing ? round1(typing.best_wpm) : null,
          avgAccuracy: round1(typingExtra.avg_accuracy),
          totalErrors: typingExtra.total_errors
        }
      }
    };
  }

  async function append(payload) {
    await init();

    const result = validateSession(payload);
    if (!result.ok) {
      const error = new Error(result.error);
      error.statusCode = 400;
      throw error;
    }

    const session = result.value;
    db.prepare(
      `INSERT INTO sessions
         (id, type, created_at, wpm, accuracy, errors, duration_sec, word_count, topic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.type,
      session.createdAt,
      session.wpm,
      session.accuracy,
      session.errors,
      session.durationSec,
      session.wordCount,
      session.topic
    );

    const count = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
    return { session, count };
  }

  /** Bulk insert used by the one-time JSON migration. */
  async function importSessions(sessions) {
    await init();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO sessions
         (id, type, created_at, wpm, accuracy, errors, duration_sec, word_count, topic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let imported = 0;
    db.exec('BEGIN');
    try {
      for (const session of sessions) {
        const result = validateSession(session);
        if (!result.ok) continue;
        const value = result.value;
        const info = insert.run(
          // Preserve the original id/timestamp when migrating.
          typeof session.id === 'string' && session.id ? session.id : value.id,
          value.type,
          typeof session.createdAt === 'string' && session.createdAt ? session.createdAt : value.createdAt,
          value.wpm,
          value.accuracy,
          value.errors,
          value.durationSec,
          value.wordCount,
          value.topic
        );
        if (info.changes > 0) imported += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return imported;
  }

  /* ------------------------------------------------------------ favourites */

  /** All saved passages, newest first. */
  async function listFavourites() {
    await init();
    return db
      .prepare('SELECT * FROM favourites ORDER BY created_at DESC, rowid DESC')
      .all()
      .map(rowToFavourite);
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

    const existing = db
      .prepare('SELECT * FROM favourites WHERE text = ? LIMIT 1')
      .get(result.value.text);
    if (existing) return { favourite: rowToFavourite(existing), duplicate: true };

    const favourite = result.value;
    db.prepare(
      `INSERT INTO favourites (id, text, topic, source, word_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      favourite.id,
      favourite.text,
      favourite.topic,
      favourite.source,
      favourite.wordCount,
      favourite.createdAt
    );

    return { favourite, duplicate: false };
  }

  async function deleteFavourite(id) {
    await init();
    const info = db.prepare('DELETE FROM favourites WHERE id = ?').run(String(id));
    return { deleted: info.changes > 0 };
  }

  /** Bulk insert used by the one-time JSON migration. */
  async function importFavourites(favourites) {
    await init();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO favourites (id, text, topic, source, word_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    let imported = 0;
    db.exec('BEGIN');
    try {
      for (const entry of favourites) {
        const result = validateFavourite(entry);
        if (!result.ok) continue;
        const value = result.value;
        const info = insert.run(
          typeof entry.id === 'string' && entry.id ? entry.id : value.id,
          value.text,
          value.topic,
          value.source,
          value.wordCount,
          typeof entry.createdAt === 'string' && entry.createdAt ? entry.createdAt : value.createdAt
        );
        if (info.changes > 0) imported += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return imported;
  }

  async function clear() {
    await init();
    db.exec('DELETE FROM sessions');
    return {
      sessions: [],
      count: 0,
      total: 0,
      backend: 'sqlite',
      aggregates: {
        totalSessions: 0,
        totalPracticeSec: 0,
        reading: { count: 0, avgWpm: null, bestWpm: null },
        typing: { count: 0, avgWpm: null, bestWpm: null, avgAccuracy: null, totalErrors: 0 }
      }
    };
  }

  async function close() {
    if (db && !closed) {
      closed = true;
      db.close();
    }
  }

  return {
    kind: 'sqlite',
    file,
    init,
    getState,
    append,
    importSessions,
    listFavourites,
    addFavourite,
    deleteFavourite,
    importFavourites,
    clear,
    close
  };
}

module.exports = { createSqliteStore, SCHEMA_VERSION };
