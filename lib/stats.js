'use strict';

/**
 * Storage chooser for Pacer's session history.
 *
 * SQLite (via Node's built-in `node:sqlite`) is the default because it is the
 * better long-term home for years of practice data: indexed SQL aggregation,
 * cheap appends, transactions and WAL durability, no session cap, and no npm
 * dependency or native build step.
 *
 * The original JSON file store is kept as an automatic fallback for runtimes
 * where `node:sqlite` is missing (Node < 22), so the app still works anywhere.
 *
 * Existing stats.json history is imported into SQLite once, then retired to
 * stats.json.migrated-<timestamp> so it is never imported twice.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { createStatsStore } = require('./stats-store');
const { createSqliteStore } = require('./stats-db');

/** Read a legacy stats.json, returning {sessions, favourites}. */
async function readLegacy(file, log) {
  const empty = { sessions: [], favourites: [] };

  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return empty;
    log.warn(`[stats] could not read legacy ${file}: ${error.message}`);
    return empty;
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { sessions: parsed, favourites: [] };
    return {
      sessions: Array.isArray(parsed && parsed.sessions) ? parsed.sessions : [],
      favourites: Array.isArray(parsed && parsed.favourites) ? parsed.favourites : []
    };
  } catch (error) {
    log.warn(`[stats] legacy ${file} was unreadable (${error.message}); leaving it untouched`);
    return empty;
  }
}

/**
 * Reject if a promise does not settle in time.
 *
 * A storage backend that never settles would otherwise hang startup silently
 * (no listener, no error). Turning that into a rejection means the JSON
 * fallback can take over and the failure is visible.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not complete within ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} options
 * @param {string} options.dbFile    SQLite database path
 * @param {string} options.jsonFile  legacy JSON path (also the fallback store)
 * @param {'auto'|'sqlite'|'json'} [options.backend]
 * @param {number} [options.initTimeoutMs]
 * @param {Console} [options.logger]
 */
async function createStats(options) {
  const {
    dbFile,
    jsonFile,
    backend = 'auto',
    initTimeoutMs = 5000,
    logger = console
  } = options;

  const wantsSqlite = backend !== 'json';
  let store = null;

  if (wantsSqlite) {
    try {
      const sqlite = createSqliteStore({ file: dbFile, logger });
      await withTimeout(sqlite.init(), initTimeoutMs, 'SQLite initialisation');
      store = sqlite;
    } catch (error) {
      if (backend === 'sqlite') throw error;
      logger.warn(
        `[stats] SQLite unavailable (${error.message}); falling back to the JSON store at ${jsonFile}`
      );
    }
  }

  if (!store) {
    store = createStatsStore({ file: jsonFile, logger });
    await withTimeout(store.init(), initTimeoutMs, 'JSON history initialisation');
  }

  // One-time import of any existing JSON history into SQLite.
  if (store.kind === 'sqlite') {
    const legacy = await readLegacy(jsonFile, logger);
    const hasLegacy = legacy.sessions.length > 0 || legacy.favourites.length > 0;

    if (hasLegacy) {
      try {
        const sessions = await store.importSessions(legacy.sessions);
        const favourites = await store.importFavourites(legacy.favourites);
        const retired = `${jsonFile}.migrated-${Date.now()}`;
        await fs.rename(jsonFile, retired);
        logger.log(
          `[stats] migrated ${sessions} session(s) and ${favourites} favourite(s) from ` +
            `stats.json into SQLite; old file kept at ${path.basename(retired)}`
        );
      } catch (error) {
        logger.warn(`[stats] could not migrate legacy history: ${error.message}`);
      }
    }
  }

  return store;
}

module.exports = { createStats };
