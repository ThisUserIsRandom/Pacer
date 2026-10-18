#!/usr/bin/env bash
#
# Pacer smoke tests — exercises every endpoint against a running server.
#
#   bash scripts/smoke.sh                       # full run (includes a real generation)
#   BASE=http://127.0.0.1:3002 bash scripts/smoke.sh
#   SKIP_GENERATE=1 bash scripts/smoke.sh       # skip the slow llama round-trip
#   WORDS=120 bash scripts/smoke.sh             # test a different essay length
#
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3001}"
SKIP_GENERATE="${SKIP_GENERATE:-0}"
WORDS="${WORDS:-300}"
TIMEOUT="${TIMEOUT:-500}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red() { printf '\033[31m%s\033[0m' "$1"; }
dim() { printf '\033[2m%s\033[0m' "$1"; }

ok() {
  pass=$((pass + 1))
  printf '  %s %s\n' "$(green '✓')" "$1"
}

bad() {
  fail=$((fail + 1))
  printf '  %s %s\n' "$(red '✗')" "$1"
  [ -n "${2:-}" ] && printf '      %s\n' "$(dim "$2")"
}

assert() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected: $2 / actual: $3"; fi
}

section() {
  printf '\n%s\n' "$(dim "── $1 ─────────────────────────────────────────")"
}

request() {
  local method="$1"
  local path="$2"
  shift 2
  curl -s -m "$TIMEOUT" -X "$method" "$BASE$path" -o "$TMP/body" -w '%{http_code}' "$@"
}

json() {
  node -e "
    let raw = '';
    process.stdin.on('data', (d) => (raw += d));
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        const value = (${1});
        console.log(value === undefined || value === null ? '' : value);
      } catch (error) {
        console.log('__PARSE_ERROR__');
      }
    });
  " <"$TMP/body"
}

printf '\n🌈  Pacer smoke tests against %s\n' "$BASE"

# ----------------------------------------------------------------- static --
section 'static frontend'

status="$(request GET /)"
assert 'GET / returns 200' '200' "$status"
if grep -q 'Pacer' "$TMP/body"; then ok 'index.html mentions Pacer'; else bad 'index.html mentions Pacer'; fi
if grep -q 'chart.js' "$TMP/body"; then ok 'index.html loads Chart.js from CDN'; else bad 'index.html loads Chart.js from CDN'; fi
if grep -q 'cdn.tailwindcss.com' "$TMP/body"; then ok 'index.html loads Tailwind from CDN'; else bad 'index.html loads Tailwind from CDN'; fi
if grep -q 'role="tab"' "$TMP/body"; then ok 'index.html has the three tabs'; else bad 'index.html has the three tabs'; fi
if grep -q 'id="length-range"' "$TMP/body"; then ok 'index.html has the adjustable length control'; else bad 'index.html has the adjustable length control'; fi

status="$(request GET /css/styles.css)"
assert 'GET /css/styles.css returns 200' '200' "$status"

for asset in api reader typing analytics main; do
  status="$(request GET "/js/$asset.js")"
  assert "GET /js/$asset.js returns 200" '200' "$status"
done

# ------------------------------------------------------------------ health --
section 'health'

status="$(request GET /api/health)"
assert 'GET /api/health returns 200' '200' "$status"
assert 'health reports ok' 'true' "$(json 'parsed.ok')"

backend="$(json 'parsed.storage.backend')"
store_file="$(json 'parsed.storage.file')"
printf '      storage backend: %s\n' "$backend"
printf '      storage file:    %s\n' "$store_file"
printf '      essay limits:    %s-%s (default %s)\n' \
  "$(json 'parsed.limits.minWords')" "$(json 'parsed.limits.maxWords')" "$(json 'parsed.limits.defaultWords')"
printf '      llama reachable: %s (%s)\n' "$(json 'parsed.llama.reachable')" "$(json 'parsed.llama.detail')"

if [ "$backend" = 'sqlite' ] || [ "$backend" = 'json' ]; then
  ok "storage backend is sqlite or json ($backend)"
else
  bad 'storage backend is sqlite or json' "got '$backend'"
fi

if [ -f "$store_file" ]; then ok 'storage file exists on disk'; else bad 'storage file exists on disk' "$store_file"; fi

# ------------------------------------------------------------- generation --
section 'POST /api/generate'

status="$(request POST /api/generate -H 'Content-Type: application/json' -d '{"topic":123}')"
assert 'non-string topic is rejected' '400' "$status"

long_topic="$(printf 'a%.0s' $(seq 1 210))"
status="$(request POST /api/generate -H 'Content-Type: application/json' -d "{\"topic\":\"$long_topic\"}")"
assert 'over-long topic is rejected' '400' "$status"

if [ "$SKIP_GENERATE" = '1' ]; then
  printf '  %s skipped real generation (SKIP_GENERATE=1)\n' "$(dim '•')"
else
  printf '  %s asking the local model for %s words — this can take a while…\n' "$(dim '•')" "$WORDS"
  status="$(request POST /api/generate -H 'Content-Type: application/json' \
    -d "{\"topic\":\"otters\",\"words\":$WORDS}")"
  assert 'generate returns 200' '200' "$status"

  words="$(json 'parsed.wordCount')"
  target="$(json 'parsed.targetWords')"
  source="$(json 'parsed.source')"
  printf '      source=%s words=%s/%s duration=%sms tok/s=%s\n' \
    "$source" "$words" "$target" "$(json 'parsed.durationMs')" "$(json 'parsed.tokPerSec')"

  assert 'target length is echoed back' "$WORDS" "$target"

  # Accept anywhere from 80% to 110% of the requested length.
  low=$((WORDS * 80 / 100))
  high=$((WORDS * 110 / 100))
  if [ "$words" -ge "$low" ] && [ "$words" -le "$high" ]; then
    ok "word count is within 80-110% of target ($words of $WORDS)"
  else
    bad "word count is within 80-110% of target" "got $words, wanted $low-$high"
  fi

  if [ "$source" = 'llama' ] || [ "$source" = 'fallback' ]; then
    ok "source is llama or fallback ($source)"
  else
    bad 'source is llama or fallback' "got $source"
  fi

  if [ "$(json "parsed.text && parsed.text.trim().length > 0 ? 'yes' : 'no'")" = 'yes' ]; then
    ok 'generate returns non-empty text'
  else
    bad 'generate returns non-empty text' 'text was empty'
  fi

  if [ "$(json "/[#*\`]/.test(parsed.text) ? 'yes' : 'no'")" = 'no' ]; then
    ok 'returned text has no markdown artefacts'
  else
    bad 'returned text has no markdown artefacts' 'found #, * or backtick'
  fi
fi

# ------------------------------------------------------------------ stats --
section 'POST /api/stats validation'

status="$(request POST /api/stats -H 'Content-Type: application/json' -d '{"type":"nope","wpm":50}')"
assert 'invalid type is rejected' '400' "$status"

status="$(request POST /api/stats -H 'Content-Type: application/json' -d '{"type":"typing","wpm":-5}')"
assert 'negative wpm is rejected' '400' "$status"

status="$(request POST /api/stats -H 'Content-Type: application/json' -d '{"type":"typing","wpm":50,"accuracy":150}')"
assert 'accuracy above 100 is rejected' '400' "$status"

status="$(request POST /api/stats -H 'Content-Type: application/json' -d '{"type":"typing"}')"
assert 'missing wpm is rejected' '400' "$status"

section 'stats round-trip'

status="$(request GET /api/stats)"
assert 'GET /api/stats returns 200' '200' "$status"
assert 'stats response reports its backend' "$backend" "$(json 'parsed.backend')"
before="$(json 'parsed.total')"

status="$(request POST /api/stats -H 'Content-Type: application/json' \
  -d '{"type":"typing","wpm":64.4,"accuracy":97.2,"errors":2,"durationSec":31,"wordCount":180}')"
assert 'valid typing session is accepted' '201' "$status"

status="$(request POST /api/stats -H 'Content-Type: application/json' \
  -d '{"type":"reading","wpm":250,"durationSec":60,"wordCount":250,"topic":"the ocean"}')"
assert 'valid reading session is accepted' '201' "$status"

after="$(request GET /api/stats >/dev/null; json 'parsed.total')"
assert 'session total increased by 2' "$((before + 2))" "$after"

section 'paged history'

request GET '/api/stats?limit=1' >/dev/null
assert 'limit is applied' '1' "$(json 'parsed.count')"
assert 'total still reports full history' "$after" "$(json 'parsed.total')"
if [ "$after" -gt 1 ]; then
  assert 'truncation is flagged' 'true' "$(json 'parsed.truncated')"
fi

# --------------------------------------------------------- concurrent writes
section 'concurrent writes'

parallel=20
for i in $(seq "$parallel"); do
  curl -s -m 20 -o /dev/null -X POST "$BASE/api/stats" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"typing\",\"wpm\":$((40 + i)),\"accuracy\":95,\"errors\":1,\"durationSec\":10,\"wordCount\":90}" &
done
wait

status="$(request GET /api/stats)"
assert 'server still responds after parallel writes' '200' "$status"
assert "all $parallel parallel sessions were stored" "$((after + parallel))" "$(json 'parsed.total')"

if [ "$backend" = 'sqlite' ]; then
  if node --disable-warning=ExperimentalWarning -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      const rows = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
      db.close();
      process.exit(rows > 0 ? 0 : 1);
    " "$store_file" 2>/dev/null; then
    ok 'SQLite database is readable and populated'
  else
    bad 'SQLite database is readable and populated' "$store_file"
  fi

  integrity="$(node --disable-warning=ExperimentalWarning -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const result = db.prepare('PRAGMA integrity_check').get();
    console.log(result.integrity_check);
    db.close();
  " "$store_file" 2>/dev/null)"
  assert 'PRAGMA integrity_check passes' 'ok' "$integrity"
else
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$store_file" 2>/dev/null; then
    ok 'stats.json is still valid JSON after concurrent writes'
  else
    bad 'stats.json is still valid JSON after concurrent writes' "$store_file"
  fi
fi

# ------------------------------------------------------------------ cleanup
section 'DELETE /api/stats'

status="$(request DELETE /api/stats)"
assert 'DELETE /api/stats returns 200' '200' "$status"
assert 'history is empty after delete' '0' "$(json 'parsed.total')"

status="$(request GET /api/bogus)"
assert 'unknown API route returns 404' '404' "$status"

# ------------------------------------------------------------------ report
printf '\n%s\n' "$(dim '────────────────────────────────────────────────────')"
if [ "$fail" -eq 0 ]; then
  printf '  %s  %d passed, 0 failed\n\n' "$(green 'All good!')" "$pass"
  exit 0
fi
printf '  %s  %d passed, %s failed\n\n' "$(red 'Failures:')" "$pass" "$fail"
exit 1
