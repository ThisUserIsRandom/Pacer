# Pacer — code map

Orientation document for anyone (human or LLM) working on this repo. Read this
before editing; it records the contracts and the non-obvious decisions, not just
the file list. ~5.2k lines total, no build step, one npm dependency.

---

## 1. What it is

A local-only web app with three tabs: **Speed Reading** (glowing pacer line that
sweeps text at a target WPM), **Touch Typing** (character colour-coding +
virtual keyboard), **Analytics** (Chart.js graphs of saved history).

Essays come from a local llama-server, with a template-based offline library as
a fallback. History is stored in SQLite.

**Run:** `npm install --cache ./.npm-cache && npm start` → http://127.0.0.1:3001

| Constraint | Value | Why |
| --- | --- | --- |
| Port | `3001` | 3000 is already Gitea on this machine |
| Node | **≥ 22** | needs `node:sqlite` |
| npm install | **must** use `--cache ./.npm-cache` | `~/.npm` is read-only (EROFS) |
| Dependencies | `express` only | everything else is built in |

---

## 2. Architecture

```
browser (public/)
  index.html ── script order: api.js → reader.js → typing.js → analytics.js → main.js
      │                    (order is LOAD-BEARING, see §6)
      │  fetch /api/*
      ▼
app.js  (Express 5, binds 127.0.0.1)
      ├── lib/llm.js  (provider registry, chosen via persisted settings)
      │        ├── lib/llama.js     ──► http://127.0.0.1:8282  (llama-server, OpenAI-compatible)
      │        └── lib/llm-local.js ──► node-llama-cpp, GGUF in-process (models/model.gguf)
      │                both ──► lib/essay.js  (shared sanitise/validate/trim)
      │        └── on any failure: lib/fallback-essays.js  (offline essay library)
      └── lib/stats.js  (backend chooser + migration)
               ├── lib/stats-db.js     SQLite (default)      → pacer.db
               └── lib/stats-store.js  JSON   (fallback)     → stats.json
                       └── also owns validateSession(), shared by stats-db.js
```

Module dependency notes:

- `lib/stats-db.js` **requires `lib/stats-store.js`** purely to reuse
  `validateSession()` and `cleanText()`. Import direction is db → store even
  though the store is the "fallback". Do not create a cycle by importing db from store.
- `app.js` holds a **module-level `storePromise`** (not an `await`ed store), and
  every route does `const store = await storePromise;`. Exported for tests.

---

## 3. `app.js` — server (280 lines)

Env parsing + Express wiring only; no business logic.

| Symbol | Role |
| --- | --- |
| `config` | All env vars resolved once at load (see §8) |
| `storePromise` | `createStats(...)` promise, awaited by routes |
| `parseTopic(value)` | optional string, control chars stripped, ≤200 chars → `{ok, topic}` / `{ok:false, error}` |
| `parseWordTarget(value)` | clamps to `MIN_WORDS..MAX_WORDS`, default `config.defaultWords` |
| `start()` | creates the server, listens, prints banner, installs SIGINT/SIGTERM → `store.close()` |

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /` + static | `public/` via `express.static` |
| `GET /api/health` | `{ok, port, limits:{minWords,maxWords,defaultWords}, storage:{backend,file}, llama:{url,timeoutMs,reachable,model,detail}}` |
| `POST /api/generate` | `{topic?, words?}` → `{text, topic, source:'llama'\|'fallback', wordCount, targetWords, matched?, fallbackReason?, fallbackDetail?, model?, durationMs?, tokPerSec?, finishReason?}`. **200 even when llama fails** — the failure is described in `fallbackReason`, never surfaced as an HTTP error |
| `GET /api/stats?limit=N` | `{sessions, count, total, limit, truncated, backend, aggregates}` — `sessions` is the newest `N` (default 200, max 1000) **oldest-first**; `aggregates`/`total` cover **all** rows |
| `POST /api/stats` | validates + appends → `201 {session, count}`; `400 {error}` |
| `DELETE /api/stats` | wipes history → `{sessions:[], count:0, total:0, backend, aggregates}` |
| `/api/*` fallthrough | `404 {error}` via `app.use('/api', ...)` — **never** `app.get('*')` (Express 5 rejects bare `*`) |
| `GET /api/settings` | `{provider, configured, settings, providers:{server,local}, limits}`. `configured:false` until the user has picked one — the UI opens the picker then |
| `PUT /api/settings` | `{provider:'server'\|'local'}` → `200`; `400` when missing or invalid. Selecting `local` warms the model in the background |
| `GET /api/favourites` | `{favourites, count, backend}` — saved passages, newest first |
| `POST /api/favourites` | `{text, topic?, source?}` → `201 {favourite, duplicate:false}`, or `200 {favourite, duplicate:true}` when the identical text already exists |
| `DELETE /api/favourites/:id` | `{deleted:true}`, or `404` when the id is unknown |
| error handler | 4-arg middleware, JSON `{error}`, honours `error.statusCode` |

**`POST /api/generate` flow:** validate topic → `AbortController` wired to
`res.on('close')` so the browser's Cancel aborts the upstream fetch → try
`llama.generateEssay()` → on *any* `LlamaError` (except `cancelled`) log a warning
and return `offlineEssay(topic, targetWords)` instead.

---

## 4. `lib/llama.js` — model client (360 lines)

`createLlamaClient({url, modelsUrl, model, timeoutMs, logger})` →
`{generateEssay, discoverModel, probe, sanitizeEssay, url, modelsUrl, timeoutMs}`.

### The four hard-won behaviours (do not remove)

1. **`chat_template_kwargs: { enable_thinking: false }`** is always sent.
   The installed model (`Qwen3.6-35B-A3B-MTP-UD-Q2_K_XL.gguf`) is a *thinking*
   model: without this flag it spends the entire token budget on
   `reasoning_content` and returns an **empty** `message.content` with
   `finish_reason: "length"`. Measured: 700 tokens, 52s, empty text.
   If a server rejects the field (4xx mentioning template/thinking), we retry
   **once without it** for compatibility with non-Qwen models.
2. **`extractEssay()` rejects unusable output** with a typed `LlamaError.reason`:
   `empty-content`, `thinking-only` (content empty but reasoning present — the
   trap above), `too-short`, `bad-response`. `REASON_TEXT` maps reasons to
   user-facing sentences via `describeReason()`.
3. **`max_tokens` and the timeout scale with the request.**
   `max_tokens = min(4000, words*1.5 + 300)`; effective timeout =
   `min(600000, timeoutMs * max(1, words/300))`. Measured 1198 words / 130s for a
   1200-word request. A fixed 800-token/120s budget would truncate long essays.
4. **`sanitizeEssay()` strips markdown**: code fences, **heading lines are
   dropped entirely** (keeping the text leaves a stray title), bold/italic,
   bullets, numbered lists, backticks, and a one-line conversational preamble
   ("Here is a cheerful essay about…"). Then `normalizeLength(..., {extend:false})`
   trims to target.

`MIN_USABLE_WORDS = 120` scales down for short requests:
`minWords = max(40, min(120, round(words * 0.5)))`.

`discoverModel()` caches for the process (30s retry window on failure) and reads
`data[0].id`, else `models[0].name` / `models[0].model`, else `"local-model"`.

---

## 5. `lib/fallback-essays.js` — offline library (575 lines)

Exports: `TARGET_WORDS/DEFAULT_WORDS` (300), `MIN_WORDS` (50), `MAX_WORDS` (1200),
`countWords`, `normalizeLength`, `growToTarget`, `buildTopicEssay`,
`matchCannedEssay`, `offlineEssay`, `tokenize`, `hashString`, `CANNED_ESSAYS`,
`FILLER_SENTENCES`.

**`offlineEssay(topic, target)` dispatch:**

- no topic → random `CANNED_ESSAYS` entry
- keyword match (via `tokenize` + `matchCannedEssay`, plural-tolerant) → that canned essay
- otherwise → `buildTopicEssay(topic, target)` (fully generated)
- then `growToTarget(...)` if the source is shorter than the target, and
  `normalizeLength(..., {extend:true})` to land inside `target ± 10`.

`CANNED_ESSAYS` = 8 essays (~250–290 words each) on: slow mornings, the ocean,
kindness, coffee, walking, music, gardens, the night sky.

`TOPIC_SENTENCE_GROUPS` = 15 groups × 3 interchangeable variants = 45 sentences.

> **Invariant — breaking this is a bug I already made once:** the topic must
> **never be the grammatical subject** of a template sentence. Put it after a
> preposition or as a verb's object only. A bare `${topic}` in subject position
> produced *"Otters gives strangers…"* / *"Quantum computing has…"* for plural
> or phrase topics. Correct: `With ${t}, …`, `The world of ${t} …`,
> `What makes ${t} so durable is …`.

Determinism: `hashString(topic)` seeds group/variant rotation, so the same topic
+ target always yields the same text. Sentence repetition at 1200 words ≈ 37%,
0% up to ~600 words — inherent to templates. The UI warns when
`targetWords > 600` and the offline path is used.

---

## 6. Frontend (`public/`)

Three tabs, plain classic scripts (no bundler, no ES modules) so `node --check`
validates every file and there is no build step. Each file is an IIFE.

| File | Lines | Responsibility | Registers |
| --- | --- | --- | --- |
| `js/api.js` | ~90 | fetch wrapper (non-2xx → throw), toasts, `formatTime`, `clamp` | `Pacer.api`, `Pacer.ui` |
| `js/favourites.js` | ~150 | shared "my paragraphs" widget: save / load / delete, cross-tab sync | `Pacer.favourites` |
| `js/reader.js` | ~590 | tab 1: pacer engine, WPM, length, generation, favourites | `Pacer.reader` |
| `js/typing.js` | ~700 | tab 2: sources, drill options, typing model, metrics, keyboard | `Pacer.typing` |
| `js/analytics.js` | 302 | tab 3: Chart.js graphs, stat cards | `Pacer.analytics` |
| `js/main.js` | 138 | tab routing + hash, health badge, boot | `Pacer.main` |

> **Load order is load-bearing.** `reader.js` and `typing.js` destructure
> `Pacer.ui` **at module scope** (line 6: `const {formatTime, clamp} = Pacer.ui`),
> so `api.js` must execute before them — otherwise they throw and that tab is
> dead. `analytics.js` only touches `Pacer.ui` inside functions, so it is less
> sensitive, but keep `api.js` first. `main.js` must be last because it defines
> `Pacer.main`, which the other modules only read **inside event handlers**
> (never at load time). `favourites.js` sits between `api.js` and `reader.js`.

### Favourites widget (shared by both tabs)

`Pacer.favourites.mount({select, load, remove, save, count, getCurrent, onLoad})`
returns `{refresh, save, items}`. One instance per tab.

> **Cross-tab sync is mandatory.** All instances are held in a module-level
> `instances` array, and every save/delete calls `broadcast()`, which refreshes
> **every** widget. Refreshing only the widget that made the change leaves the
> other tab's list stale until a reload — that bug was caught by the browser
> suite. Any new mutation must go through `broadcast()`.

`getCurrent()` must return `{text, topic, source}` for the passage currently in
view; each tab supplies its own (reader uses `state.rawText`, typing uses the
drill or the loaded favourite).

### Cross-module contract

`Pacer.main.activeTab` (`'reading'|'typing'|'analytics'`) is the gate both
keyboard handlers consult. `Pacer.main.isTypingTarget(el)` returns true for
INPUT/TEXTAREA/SELECT/contenteditable.

- **Reading hotkeys** (`reader.js bindHotkeys`): `W` +10 wpm, `S` −10, Shift ×2.5
  (i.e. ±25), `Space` play/pause. Fires only when `activeTab === 'reading'` **and**
  `!isTypingTarget(event.target)`; always `preventDefault()` on Space so the page
  never scrolls.
- **Typing input** (`typing.js handleKeydown`): document-level, fires only when
  `activeTab === 'typing'`. Uses `event.code` (`KeyA→'a'`, `Space→' '`,
  `ShiftLeft/Right→'shift'`) via `eventKeyId()`. Paste/cut/drag-drop blocked.

Each module owns its own DOM ids (see the `getElementById` calls in
`cacheElements()`); ids are namespaced per tab (`reading-*`, `typing-*`,
`stat-*`, `analytics-*`). Nothing outside a module reads its ids.

### Tab routing

`main.js setTab(name)` toggles `aria-selected` + panel `hidden`, sets
`main.activeTab`, and syncs `location.hash` (`#reading` / `#typing` /
`#analytics`). `tabFromHash()` on boot restores a deep link; `hashchange` is
honoured, so tabs are bookmarkable and screenshot-able.

### Typing tab (`typing.js`)

**Sources**: `words` (from a 300-word frequency list) · `sentences` (7 pangram-ish
sentences, cycled) · `ai` (own topic + `state.aiText`) · `favourite`
(`state.favouriteText`). `buildDrillText(randomize)` dispatches on `state.source`
and returns `null` when the source has no text yet, in which case
`showPlaceholder()` renders a prompt instead of a drill.

**Drill length**: `drillTarget()` = `max(state.drillWords, timed ? durationSec × 2.2 : 0)`.
Timed drills deliberately over-build so the text never runs out mid-run.

**Difficulty** (`applyDifficulty(text, isWordDrill)`):
- word drills *add* capitals/punctuation/numbers when enabled,
- prose drills *keep* them, and strip/lowercase when the toggle is off.
- `STRIP_PUNCTUATION` also removes apostrophes, so "don't" becomes "dont" — fine
  for a drill, but do not reuse that helper for display text.

**Timed mode**: `state.timed` + `state.durationSec` (0 = finish-the-text). The
200ms interval calls `finish('time')` when `secondsLeft() <= 0`; the Time metric
switches to a countdown and the progress bar tracks time instead of characters.

**Caret auto-scroll** (`scrollCaretIntoView`): after every keystroke the caret's
line is kept inside the 18–68% band, easing `scrollTop` over a short rAF loop
(0.25 per frame). `buildText()` cancels any running animation and jumps to the
top. Without this, a 1000-word drill scrolls the caret out of sight.

**Options are persisted** as one JSON blob under `localStorage['pacer.typing']`
(`savePrefs`/`loadPrefs`) — source, drillWords, difficulty, timed, durationSec,
aiWords. Generated text is deliberately *not* persisted.

**Empty states**: `showPlaceholder()` sets empty `target`, so `handleKeydown`
returns early (`state.target.length === 0`) and typing is inert until a passage
is loaded. Keep that guard — without it a keystroke would immediately "finish" a
zero-length run.

### Reading tab (`reader.js`)

State: `words[]`, `spans[]`, `wordsRead` (float), `elapsedMs`, `wpm`,
`targetWords`, `pacerY`, `lastIndex`, `rawText`, `sourceKind`.

- `frame()` (rAF) **integrates** `wordsRead += dt * wpm/60` rather than deriving
  it from wall-clock, so changing WPM mid-read doesn't teleport the pacer.
- **Pacer styles**: `soft` (default), `rainbow`, `off`, persisted in
  `localStorage['pacer.style']` and applied as `.pacer--<style>`. Soft is 3px at
  45 % opacity with no animation; the old continuous rainbow shimmer was the
  main distraction and is gone. `setPacerStyle()` is the only place the classes
  are touched.
- `pacerTargetY()` returns the **top edge** of the rule and measures the word's
  **inline text box** (`Range.getBoundingClientRect()`, scroll-invariant after
  subtracting the track rect) so the rule lands in the leading gap *below* the
  glyphs — `PACER_GAP` (4px) under them. It is **cached per word index**
  (`state.pacerCacheIndex/Y`) because the rect reads force a layout and are only
  invalidated on new text, reset, and window resize.
  Do **not** go back to `offsetTop + offsetHeight/2`: that strikes through the
  letters (measured 6px overlap on a 5–6px bar). `.pacer` therefore has no
  negative `margin-top`, and `.reader-text` carries `position:relative; z-index:1`
  so the glow can never paint over the text. The former blurred `::after` band
  was removed for the same reason.
- Then **lerped**: `pacerY += (target - pacerY) * 0.18` for the smooth glide.
- `paintIndex()` is O(delta): marks passed words `.rw--done`, one `.rw--current`.
- **Auto-scroll** (`updateScroll(dt)`): a target is computed when the current word
  leaves the 22–72% band and the scroll eases toward it inside the same rAF loop
  (`1 - exp(-dt*12)`). The band is measured against `state.scrollTarget`, not the
  live `scrollTop` — using the live value creates a feedback loop that re-targets
  forever. `snapScroll()` is used for reset/seek/resize.
  **Never** call `scrollTo({behavior:'smooth'})` per frame: it restarts the
  browser animation on every tick and stutters. `.reader-viewport` therefore has
  no CSS `scroll-behavior`.
- Clicking a word seeks (pauses, sets `wordsRead`, repaints).

### Typing metrics (`typing.js metrics()`) — the exact formulas

```
correctChars       live matches in the typed prefix
totalKeystrokes    character keystrokes (excludes Backspace/modifiers)
correctKeystrokes  first-attempt matches (a corrected error still counts against accuracy)
elapsedMin         max((now - startedAt)/60000, 1/600)
netWPM             (correctChars/5)/elapsedMin      ← displayed
grossWPM           (totalKeystrokes/5)/elapsedMin
accuracy           correctKeystrokes/totalKeystrokes*100  (100 when no keystrokes)
errors             totalKeystrokes - correctKeystrokes
```
Timer starts on the first keystroke; 250ms interval refresh.

Note `state.target` is an **array of characters**, not words. Use
`typedWordCount()` when reporting a word count — storing `state.target.length`
silently recorded characters as words (149 chars saved as "149 words").

The server rejects `wpm > 2000`, so an automated or otherwise superhuman run
fails to save (the toast shows the validation error and `state.logged` resets so
a retry is possible). Only reachable with synthetic input.

### Analytics

`CHART_WINDOW = 120` — fetches `?limit=120`, plots that window, but the stat
cards use `data.total` and the note explains when charts are trimmed. Three
charts (wpm / accuracy / errors) are tracked in a `charts` object and
**`destroy()`ed before re-creation** to avoid Chart.js canvas-reuse errors.
Chart.js is loaded from a CDN UMD build in `index.html`.

### Styling

`css/styles.css` (877 lines) is the source of truth for the look: pastel design
tokens as CSS vars, `.card` / `.btn--*` / `.tab` / `.metric` / `.pacer` /
`.key--*` / `.char--*` components. Tailwind (Play CDN, `3.4.17`) supplements
layout only — the page stays presentable if the CDN is blocked, by design.

> Contrast is deliberate: every text colour clears WCAG AA on the cream
> background (measured: correct 4.83:1, wrong 5.46:1, pending 5.26:1).
> `--ink-faint` is `#756d8a` for that reason — do not lighten it.
> `.char--pending` uses `--ink-soft` because you must read text *before* typing it.

`prefers-reduced-motion` disables the pacer shimmer/caret pulse.

`localStorage`: `pacer.wpm`, `pacer.words`. All model/history text is rendered
with `textContent` (never `innerHTML`) — keep it that way.

---

### `lib/llm.js` — provider registry

`createLlmRouter({config})` builds both providers once and exposes
`{get(provider), status(), warmLocal(), dispose()}`. `get()` returns the HTTP
client for `'server'` and the in-process one for `'local'`. `status()` probes
both (never throws) and feeds the picker.

The choice lives in the settings store, read per request via
`selectedProvider()` in `app.js`. The built-in model is **never loaded** unless
`provider === 'local'`.

### `lib/llm-local.js` — in-process GGUF

Uses `node-llama-cpp` (ESM-only, so it is loaded with a **dynamic
`import()`** from CommonJS — `require()` will not work). Measured on this
machine with Qwen3-0.6B Q8_0: load ≈ 1.3 s, ≈14 words/s.

Design points that matter:
- The model is a **process-wide singleton** (`modelPromise`); a **fresh context
  per request** is created and disposed in `finally`, because reusing one session
  across prompts made the model answer the *new* prompt as a fresh essay and
  drift badly.
- A small model stops early (a 300-word request yields ~60–200 words), so
  generation **continues in rounds** until ≈90% of the target is reached.
  `MAX_ROUNDS = 24` and each round starts a **fresh session** on the *same*
  sequence with a **rotating** continuation prompt.
- **Sequence reuse matters:** `LlamaChatSession` does not dispose its sequence
  unless `autoDisposeSequence` is set (default `false`), so creating a session
  per round threw "No sequences left". Take one `context.getSequence()` and pass
  it to every session.
- **Do not prime the fresh session** with the essay tail (e.g. "reply OK").
  Measured: priming collapses rounds to ~32 words and often stalls at 0, while a
  bare fresh session reaches 280–304 words.
- **Empty rounds are retried, not treated as a loop.** A blank round used to end
  generation outright, which discarded a whole essay (and for a 50-word request
  failed the minimum length entirely). Up to 3 consecutive empty rounds are
  retried before giving up.
- Generations are **serialised** through a promise queue — a CPU-bound model
  thrashes if requests overlap.
- No model is auto-detected: `ensureModel()` looks only at the configured path
  and throws `model-missing` if it is absent.
- Budget: `budgetFor(words)` = 4 words/s, floor 60 s, cap 20 min.

### `lib/essay.js` — shared output contract

`dedupeRepeatedSentences`, `sanitizeEssay`, `assessEssay`, `minWordsFor`,
`LlmError`, `REASON_TEXT`, `describeReason`.

`sanitizeEssay` ends by calling `dedupeRepeatedSentences`, which drops a sentence
when it duplicates an earlier one **or** reuses a 7-word shingle already seen
(that second rule is what catches paraphrased loops). It bails out and returns
the original if dedupe would remove more than 60 % of the sentences. This runs on
model output only — the offline library deliberately repeats templates to reach
long lengths and must not go through it. Both providers import `assessEssay`, so a completion is
validated identically no matter where it came from. `lib/llama.js` re-exports
`LlamaError`/`sanitizeEssay`/`describeReason` for compatibility.

## 7. Storage

`lib/stats.js → createStats({dbFile, jsonFile, backend, initTimeoutMs, logger})`
tries SQLite, falls back to JSON, then runs a **one-time legacy import**.

### SQLite (`lib/stats-db.js`, default)

```sql
sessions(id TEXT PRIMARY KEY, type TEXT CHECK(type IN ('reading','typing')),
         created_at TEXT, wpm REAL, accuracy REAL, errors INTEGER,
         duration_sec REAL, word_count INTEGER, topic TEXT)
favourites(id TEXT PRIMARY KEY, text TEXT, topic TEXT, source TEXT,
           word_count INTEGER, created_at TEXT)
settings(key TEXT PRIMARY KEY, value TEXT)      -- e.g. provider=local
meta(key TEXT PRIMARY KEY, value TEXT)          -- schema_version (currently 2)
INDEX idx_sessions_created_at, idx_sessions_type,
      idx_favourites_created_at, idx_favourites_text
```
`PRAGMA journal_mode = WAL`, `synchronous = NORMAL`. `id` is a PK so imports are
idempotent (`INSERT OR IGNORE`). Aggregates are computed in SQL
(`AVG`/`MAX`/`SUM`/`GROUP BY type`), never by loading rows into JS.

### JSON (`lib/stats-store.js`, fallback + shared validation)

Whole-file atomic write (`.tmp` + `rename`) serialised through a module-level
promise chain; corrupt file → renamed to `stats.json.corrupt-<ts>`; 1000-session cap.
**Owns `validateSession()`** — the single validation source for both backends.

### Migration

If `stats.json` exists **with sessions**, they are imported into SQLite and the
old file becomes `stats.json.migrated-<ts>`. Empty legacy files are left alone.

### Session shape (the API contract)

```js
{ id, type:'reading'|'typing', createdAt:ISO, wpm:number,
  accuracy:number|null, errors:int, durationSec:number, wordCount:int, topic:string|null }
// POST accepts a subset; id/createdAt are server-set.
// Bounds: wpm 0..2000, accuracy 0..100|null, errors int>=0,
//         durationSec 0..86400, wordCount int>=0, topic<=200 chars
```
`aggregates` = `{totalSessions, totalPracticeSec, reading:{count,avgWpm,bestWpm}, typing:{count,avgWpm,bestWpm,avgAccuracy,totalErrors}}`.

Favourite shape (validated by `validateFavourite`, shared by both backends):

```js
{ id, text, topic:string|null, source:string|null, wordCount:int, createdAt:ISO }
// text 1..20000 chars (newlines preserved), topic<=200, source<=40
// identical `text` is deduplicated and returns the existing row
```
`DELETE /api/stats` clears **sessions only** — saved passages are user-curated and
survive "Clear history" on purpose.

---

## 8. Environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | localhost only |
| `LLAMA_URL` | `http://127.0.0.1:8282/v1/chat/completions` | |
| `LLAMA_MODELS_URL` | `http://127.0.0.1:8282/v1/models` | model-id discovery |
| `LLAMA_MODEL` | *(auto)* | overrides discovery |
| `LLAMA_TIMEOUT_MS` | `120000` | budget **for 300 words**; scales with request |
| `ESSAY_WORDS` | `300` | default essay length |
| `STATS_DB` | `./pacer.db` | |
| `STATS_FILE` | `./stats.json` | fallback store + legacy import source |
| `STATS_BACKEND` | `auto` | `auto` \| `sqlite` \| `json` |

---

## 9. Gotchas that have already bitten (read before "fixing")

1. **`fs.mkdir(dir, {recursive:true})` never settles on procfs** — it hangs
   forever, which silently blocked startup when `STATS_DB` was unusable.
   `ensureDir()` therefore uses a **non-recursive** mkdir (fails fast, tolerates
   `EEXIST`), plus `withTimeout()` (5s) around backend init as a guard. Do not
   "simplify" this back to recursive.
2. **Express registers your `app.listen` callback as an `'error'` listener too**,
   so it fires with the error argument on a busy port — printing a cheerful
   "Pacer is ready" banner right before `EADDRINUSE`. `app.js` therefore uses
   `http.createServer(app)` + explicit `.on('error')`.
3. **`rowid` is not projected through a subquery** — the paged-history query
   orders `DESC` and reverses in JS instead.
4. **Express 5 has no bare `'*'` route**; use `app.use()` for the 404 handler.
5. **`AbortSignal.any()` hides which input aborted**, so client-cancel vs timeout
   is distinguished by checking the client signal directly, not `signal.reason`.
6. **`node:sqlite` prints an ExperimentalWarning.** It is filtered in `app.js`
   (a `process.on('warning')` handler that drops only that notice), so
   `npm start` and plain `node app.js` both run clean with **no CLI flags**.
   Inline `node -e` snippets that open SQLite call
   `process.removeAllListeners('warning')` for the same reason.
7. **Frontend load order** (§6) — `api.js` first, `main.js` last.
8. **Template grammar** (§5) — never put the topic in subject position.
9. **`stats.json` is not the primary store any more**; don't add features to the
   JSON path only. Both backends share `validateSession()` and must keep the same
   `getState()` shape (`total`/`limit`/`truncated`/`backend`).

---

10. **`node-llama-cpp` is ESM-only.** Import it with `await import(...)` from
    CommonJS; `require('node-llama-cpp')` throws `ERR_REQUIRE_ESM`.
11. **Never reuse a chat session across essays.** A second `prompt()` on the
    same session is interpreted as a follow-up and returns a different, shorter
    essay. One context/session per request; continuation prompts are the
    exception and must be phrased as "continue…".
12. **The built-in model is opt-in.** Do not warm or load it at startup unless
    the stored provider is `local` — that is the whole point of the toggle.

13. **`paintIndex()` must clear the span it painted, not `spans[lastIndex]`.**
    Anything that resets `lastIndex` to `-1` (a tab switch used to) leaves the
    old `rw--current` class behind, so two words look current. The code tracks
    `state.currentSpan` for exactly this reason; `main.js` now calls
    `Pacer.reader.invalidateLayout()` instead of touching `lastIndex`.
14. **`LlamaChatSession` leaks sequences.** `autoDisposeSequence` defaults to
    `false`; one context has a limited pool, so per-round sessions fail with
    "No sequences left". Reuse a single `context.getSequence()`.
15. **A blank completion is a bad sample, not a stop signal.** Retry it — the
    first round of a short request comes back empty often enough to matter.
16. **Do not over-tune the small model's repeat penalty.** Measured on
    Qwen3-0.6B: `penalty 1.3` + 256-token window removes loops but collapses
    coherence and cut output to ~100 words. The working combination is the mild
    penalty (`1.12`, default window) **plus** post-generation dedupe, which gave
    0 % duplicate sentences at full length.
17. **Scroll animations belong in one loop.** Both tabs ease `scrollTop`
    themselves; adding CSS `scroll-behavior: smooth` (or repeated `scrollTo`
    calls) on top reintroduces stutter/stacking.

## 10. Verification

```bash
npm start                                   # http://127.0.0.1:3001
bash scripts/smoke.sh                       # 43 checks incl. one real generation
SKIP_GENERATE=1 bash scripts/smoke.sh       # fast: 37 checks, no llama round-trip
WORDS=900 bash scripts/smoke.sh             # exercise a different length
BASE=http://127.0.0.1:3002 bash scripts/smoke.sh
```

`smoke.sh` asserts static assets, validation (400s), the stats round-trip, paged
history, **20 concurrent writes**, `PRAGMA integrity_check`, and generation
length/quality (word count within 80–110% of target, no markdown artefacts).

`scripts/mock-llama.js` is a fake llama-server whose behaviour is chosen by the
**topic string** — see the table in README. Use it to test failure paths without
touching the real model: `trap` (thinking trap), `boom` (500), `hang` (timeout),
`template` (kwarg rejected → retry), `tiny` (too short), `markdown` (sanitising).

`.test-tmp/` (gitignored) holds the Playwright browser suites — `ui-check.js`
(48 checks: hotkeys, pacer geometry, typing metrics, length control, charts,
430px layout — it seeds and clears its own history), `typing-options.js`
(36 checks: drill length, difficulty toggles, sources, timed mode, persistence,
favourites across both tabs), `gen-check.js` (21 checks against the mock),
`pacer-geom.js`, `complete-run.js`, `style-audit.js`, `contrast.js` — plus
`shots/`. They need `playwright-core` installed ad hoc
(`npm install playwright-core --no-save --cache ./.npm-cache`) and hardcode the
Playwright Chromium path. Test scripts that exercise the AI source need the mock
instance running (see below), so start it and point a second server at it.

---

## 11. Common changes → where to touch

| Change | Files |
| --- | --- |
| New API endpoint | `app.js` (+ `scripts/smoke.sh`) |
| Change session fields/bounds | `lib/stats-store.js` (`validateSession`) → both backends inherit; add a column in `lib/stats-db.js` `SCHEMA` (bump `SCHEMA_VERSION`) |
| Change favourite fields/bounds | `lib/stats-store.js` (`validateFavourite`) → both backends inherit; mirror any column change in both `SCHEMA` and `rowToFavourite` |
| New aggregation for the dashboard | `lib/stats-db.js` (SQL) **and** `lib/stats-store.js` (`computeAggregates`), then `analytics.js` |
| New typing drill option | `public/index.html` (control) → `typing.js` (`state` + `loadPrefs`/`savePrefs` + `rebuild`) → `public/js/typing-options` test |
| New typing source | `typing.js` (`buildDrillText`, `SOURCE_LABELS`, `setSource`) + a button in `#typing-sources` |
| Favourites behaviour | `public/js/favourites.js` (widget + `broadcast`) — remember both tabs share it |
| Prompt / model call tuning | `lib/llama.js` (`buildBody`, `generateEssay`) |
| Offline essay content or length behaviour | `lib/fallback-essays.js` (`CANNED_ESSAYS`, `TOPIC_SENTENCE_GROUPS`, `normalizeLength`) |
| Essay length bounds | `MIN_WORDS`/`MAX_WORDS` in `lib/fallback-essays.js` **and** the slider `min`/`max`/`step` in `public/index.html` **and** `MIN_WORDS`/`MAX_WORDS` in `public/js/reader.js` |
| Reading pacer feel | `public/js/reader.js` (`frame`, `pacerTargetY`) + `.pacer` in `public/css/styles.css` |
| Typing metrics | `public/js/typing.js` (`metrics`) — update the formulas documented in §6 |
| Colours / typography / components | `public/css/styles.css` (tokens at the top) |
| New tab | `public/index.html` (tab + panel) + `TABS` in `public/js/main.js` + a new `public/js/<name>.js` |

---

## 12. Deliberate non-goals

- No build step, bundler, framework, or TypeScript.
- No test framework — shell + Playwright scripts instead.
- No mobile/IME touch-typing support (desktop physical keyboard assumed).
- No auth: binds to `127.0.0.1` only.
- No SSE/streaming generation (a spinner with elapsed time + Cancel instead).
- Tailwind/Chart.js come from CDNs; only `styles.css` is required for the page
  to remain usable offline.
