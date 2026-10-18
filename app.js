'use strict';

/**
 * Pacer — local speed reading + touch typing trainer.
 *
 * Serves the static frontend, proxies essay generation to a local llama-server
 * (with offline fallbacks), and persists session history to stats.json.
 */

const path = require('node:path');
const http = require('node:http');
const express = require('express');

// `node:sqlite` is still flagged experimental in Node 22. Silence just that one
// warning here so plain `npm start` (or `node app.js`) runs with no CLI flags,
// while every other warning keeps printing.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  const isSqliteNotice =
    warning.name === 'ExperimentalWarning' && /SQLite/i.test(String(warning.message));
  if (isSqliteNotice) return;
  console.warn(warning.stack || `${warning.name}: ${warning.message}`);
});

const { createLlamaClient, LlamaError, describeReason } = require('./lib/llama');
const {
  offlineEssay,
  countWords,
  DEFAULT_WORDS,
  MIN_WORDS,
  MAX_WORDS
} = require('./lib/fallback-essays');
const { cleanText } = require('./lib/stats-store');
const { createStats } = require('./lib/stats');

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 3001,
  llamaUrl: process.env.LLAMA_URL || 'http://127.0.0.1:8282/v1/chat/completions',
  llamaModelsUrl: process.env.LLAMA_MODELS_URL || 'http://127.0.0.1:8282/v1/models',
  llamaModel: process.env.LLAMA_MODEL || '',
  // Generation on a large local model takes tens of seconds; be generous.
  // This is the budget for a 300-word essay and scales up with longer requests.
  llamaTimeoutMs: Number(process.env.LLAMA_TIMEOUT_MS) || 120000,
  // SQLite is the default; set STATS_BACKEND=json to force the JSON store.
  statsDb: process.env.STATS_DB || path.join(__dirname, 'pacer.db'),
  statsFile: process.env.STATS_FILE || path.join(__dirname, 'stats.json'),
  statsBackend: process.env.STATS_BACKEND || 'auto',
  defaultWords: Number(process.env.ESSAY_WORDS) || DEFAULT_WORDS,
  publicDir: path.join(__dirname, 'public')
};

const llama = createLlamaClient({
  url: config.llamaUrl,
  modelsUrl: config.llamaModelsUrl,
  model: config.llamaModel || undefined,
  timeoutMs: config.llamaTimeoutMs
});

// History lives in SQLite by default, falling back to JSON where node:sqlite
// is unavailable. Any pre-existing stats.json is migrated in on first run.
const storePromise = createStats({
  dbFile: config.statsDb,
  jsonFile: config.statsFile,
  backend: config.statsBackend
});

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(config.publicDir, { extensions: ['html'] }));

/** Validate an optional topic string. */
function parseTopic(value) {
  if (value === undefined || value === null) return { ok: true, topic: '' };
  if (typeof value !== 'string') {
    return { ok: false, error: 'Field "topic" must be a string.' };
  }
  const cleaned = cleanText(value);
  if (cleaned.length > 200) {
    return { ok: false, error: 'Field "topic" must be 200 characters or fewer.' };
  }
  return { ok: true, topic: cleaned };
}

/** Validate an optional target word count. */
function parseWordTarget(value) {
  if (value === undefined || value === null || value === '') return config.defaultWords;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return config.defaultWords;
  return Math.min(MAX_WORDS, Math.max(MIN_WORDS, Math.round(numeric)));
}

app.get('/api/health', async (req, res) => {
  const [llamaStatus, store] = await Promise.all([llama.probe(), storePromise]);
  res.json({
    ok: true,
    port: config.port,
    limits: { minWords: MIN_WORDS, maxWords: MAX_WORDS, defaultWords: config.defaultWords },
    storage: { backend: store.kind, file: store.file },
    llama: {
      url: config.llamaUrl,
      timeoutMs: config.llamaTimeoutMs,
      ...llamaStatus
    }
  });
});

/**
 * POST /api/generate
 * Body: { topic?: string, words?: number }
 *
 * Always answers 200 with usable prose when the server itself is reachable:
 * llama output when the local model cooperates, otherwise a cheerful offline
 * essay plus a reason describing what went wrong.
 */
app.post('/api/generate', async (req, res) => {
  const body = req.body || {};

  const topicResult = parseTopic(body.topic);
  if (!topicResult.ok) {
    return res.status(400).json({ error: topicResult.error });
  }

  const topic = topicResult.topic;
  const targetWords = parseWordTarget(body.words);

  // Abort the upstream request if the browser disconnects (Cancel button).
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const startedAt = Date.now();

  try {
    const result = await llama.generateEssay(topic || 'the little joys of everyday life', {
      targetWords,
      signal: controller.signal
    });

    return res.json({
      text: result.text,
      topic: topic || 'the little joys of everyday life',
      source: 'llama',
      wordCount: countWords(result.text),
      targetWords: result.targetWords,
      model: result.model,
      durationMs: result.durationMs,
      tokPerSec: result.tokPerSec,
      finishReason: result.finishReason
    });
  } catch (error) {
    const reason = error instanceof LlamaError ? error.reason : 'unreachable';
    const detail = error instanceof LlamaError ? error.message : String(error && error.message);

    if (reason !== 'cancelled') {
      console.warn(`[generate] llama unavailable (${reason}): ${detail} — serving offline essay`);
    }

    const fallback = offlineEssay(topic, targetWords);

    return res.json({
      text: fallback.text,
      topic: fallback.topic,
      source: 'fallback',
      wordCount: countWords(fallback.text),
      targetWords,
      matched: fallback.matched,
      fallbackReason: describeReason(reason),
      fallbackDetail: reason,
      durationMs: Date.now() - startedAt
    });
  }
});

/** GET /api/stats?limit=N — recent sessions plus aggregates over all history. */
app.get('/api/stats', async (req, res, next) => {
  try {
    const store = await storePromise;
    res.json(await store.getState({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

/** POST /api/stats — append one finished session. */
app.post('/api/stats', async (req, res, next) => {
  try {
    const store = await storePromise;
    const result = await store.append(req.body);
    res.status(201).json(result);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

/** DELETE /api/stats — clear all history. */
app.delete('/api/stats', async (req, res, next) => {
  try {
    const store = await storePromise;
    res.json(await store.clear());
  } catch (error) {
    next(error);
  }
});

/* ---------------------------------------------------------- favourites ---- */

/** GET /api/favourites — every saved passage, newest first. */
app.get('/api/favourites', async (req, res, next) => {
  try {
    const store = await storePromise;
    const favourites = await store.listFavourites();
    res.json({ favourites, count: favourites.length, backend: store.kind });
  } catch (error) {
    next(error);
  }
});

/** POST /api/favourites — save the current passage. Identical text is deduped. */
app.post('/api/favourites', async (req, res, next) => {
  try {
    const store = await storePromise;
    const result = await store.addFavourite(req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

/** DELETE /api/favourites/:id — forget one saved passage. */
app.delete('/api/favourites/:id', async (req, res, next) => {
  try {
    const store = await storePromise;
    const result = await store.deleteFavourite(req.params.id);
    if (!result.deleted) {
      return res.status(404).json({ error: 'No saved passage with that id.' });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.originalUrl}` });
});

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error('[error]', error);
  const status = error.statusCode || 500;
  res.status(status).json({ error: error.message || 'Internal server error' });
});

async function start() {
  const store = await storePromise;

  // Build the server explicitly rather than using app.listen(): Express also
  // registers the listen callback as an 'error' listener, which would fire the
  // "ready" banner even when the port is already taken.
  const server = http.createServer(app);

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error('');
      console.error(`  ✖  Port ${config.port} on ${config.host} is already in use.`);
      console.error('     Another program owns it (Gitea uses port 3000 on this machine).');
      console.error('     Start Pacer on a different port instead, for example:');
      console.error('       PORT=3002 npm start');
      console.error('');
      process.exit(1);
    }
    console.error('[fatal] server error:', error);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    console.log('');
    console.log('  🌈  Pacer is ready');
    console.log(`      http://${config.host}:${config.port}`);
    console.log(`      history: ${store.kind === 'sqlite' ? 'SQLite' : 'JSON'} → ${store.file}`);
    console.log(`      essays: ${MIN_WORDS}-${MAX_WORDS} words (default ${config.defaultWords})`);
    console.log(`      llama-server: ${config.llamaUrl} (timeout ${config.llamaTimeoutMs}ms)`);
    console.log('');
    llama
      .probe()
      .then((status) => {
        if (status.reachable) {
          console.log(`  ✨  llama-server reachable — model: ${status.model}`);
        } else {
          console.log(`  📴  llama-server unreachable (${status.detail}) — offline essays will be used`);
        }
        console.log('');
      })
      .catch(() => {});
  });

  // Close the database cleanly so WAL contents are checkpointed.
  const shutdown = async () => {
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[fatal]', error);
    process.exit(1);
  });
}

module.exports = { app, start, config, llama, storePromise, parseWordTarget };
