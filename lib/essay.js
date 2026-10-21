'use strict';

/**
 * Shared essay handling for every LLM provider (HTTP llama-server and the
 * in-process model).
 *
 * Keeping sanitising, validation and length normalisation here means both
 * providers behave identically and the server's fallback logic has a single
 * set of failure reasons to reason about.
 */

const { countWords, normalizeLength } = require('./fallback-essays');

/** Below this a completion is too short to practise on (scaled by target). */
const MIN_USABLE_WORDS = 120;

/** Typed error carrying a machine-readable reason. */
class LlmError extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.name = 'LlmError';
    this.reason = reason;
    Object.assign(this, extra);
  }
}

/** Human-readable explanation for each failure reason. */
const REASON_TEXT = {
  unreachable: 'llama-server is not reachable',
  timeout: 'llama-server did not respond in time',
  cancelled: 'generation was cancelled',
  'http-error': 'llama-server returned an error',
  'bad-response': 'llama-server returned an unexpected response',
  'empty-content': 'the model returned no text',
  'thinking-only': 'the model spent its whole budget thinking and returned no essay',
  'too-short': 'the model returned too little text to practise with',
  'bad-request': 'llama-server rejected the request',
  'model-missing': 'the built-in model file is missing',
  'model-load-failed': 'the built-in model could not be loaded',
  'local-busy': 'the built-in model is busy'
};

function describeReason(reason) {
  return REASON_TEXT[reason] || 'llama-server was unavailable';
}

/** Sentence splitter that keeps terminal punctuation. */
function splitIntoSentences(text) {
  return (String(text).match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Lowercase, punctuation-free form used to compare sentences. */
function comparisonKey(sentence) {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove repeated material from model output.
 *
 * Small models loop: they emit a rhetorical template, then restate it with
 * slightly different wording. Exact-sentence dedupe misses the paraphrase, so
 * a sentence is also dropped when it reuses a 7-word run already seen — long
 * enough to be a real repeat, short enough to leave normal prose alone.
 *
 * Only applied to model output; the offline library deliberately repeats
 * templates to reach long lengths.
 */
const SHINGLE_SIZE = 7;

function dedupeRepeatedSentences(text) {
  const sentences = splitIntoSentences(text);
  if (sentences.length < 2) return text;

  const seenSentences = new Set();
  const seenShingles = new Set();
  const kept = [];

  for (const sentence of sentences) {
    const key = comparisonKey(sentence);
    if (!key) continue;

    if (seenSentences.has(key)) continue;

    const words = key.split(' ');
    let redundant = false;

    if (words.length >= SHINGLE_SIZE) {
      for (let i = 0; i + SHINGLE_SIZE <= words.length; i += 1) {
        if (seenShingles.has(words.slice(i, i + SHINGLE_SIZE).join(' '))) {
          redundant = true;
          break;
        }
      }
    }
    if (redundant) continue;

    seenSentences.add(key);
    if (words.length >= SHINGLE_SIZE) {
      for (let i = 0; i + SHINGLE_SIZE <= words.length; i += 1) {
        seenShingles.add(words.slice(i, i + SHINGLE_SIZE).join(' '));
      }
    }
    kept.push(sentence);
  }

  // Guard: if dedupe would gut the passage, keep the original.
  if (kept.length < 2 || kept.length < sentences.length * 0.4) return sentences.join(' ');
  return kept.join(' ');
}

/**
 * Strip markdown, wrappers and conversational preamble so the reader gets clean
 * prose.
 */
function sanitizeEssay(raw) {
  let text = String(raw || '').replace(/\r\n?/g, '\n');

  text = text.replace(/```[a-zA-Z]*\n?/g, '');
  // Drop heading lines entirely — a stray title reads oddly in the pacer.
  text = text.replace(/^\s{0,3}#{1,6}\s*.*$/gm, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, '');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ ?\n ?/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // Small models like to announce the length they were asked for.
  text = text.replace(/\(\s*(?:about\s*)?\d+\s*words?\s*\)/gi, '');
  text = text.replace(/\bword count\s*:\s*\d+\b/gi, '');

  // Drop a one-line preamble such as "Here is a cheerful essay about otters:".
  const lines = text.trim().split('\n');
  if (lines.length > 1) {
    const first = lines[0].trim();
    const looksLikePreamble =
      first.length < 120 &&
      countWords(first) < 20 &&
      /(essay|here is|here's|sure|certainly|of course)/i.test(first) &&
      /[:!]$/.test(first);
    if (looksLikePreamble) lines.shift();
  }

  const cleaned = lines.join('\n').trim();
  return dedupeRepeatedSentences(cleaned).replace(/\s{2,}/g, ' ').trim();
}

/** Shortest completion we will accept for a given requested length. */
function minWordsFor(targetWords) {
  return Math.max(40, Math.min(MIN_USABLE_WORDS, Math.round(targetWords * 0.5)));
}

/**
 * Sanitise, validate and trim a completion.
 *
 * @param {string} rawText
 * @param {number} targetWords
 * @returns {{ text: string, words: number }}
 * @throws {LlmError} with reason `empty-content` or `too-short`
 */
function assessEssay(rawText, targetWords = 300) {
  const text = sanitizeEssay(rawText);
  const words = countWords(text);

  if (words === 0) {
    throw new LlmError('empty-content', 'Model returned empty content.');
  }

  const minWords = minWordsFor(targetWords);
  if (words < minWords) {
    throw new LlmError('too-short', `Model returned only ${words} words.`, { words, minWords });
  }

  return { text: normalizeLength(text, targetWords, { extend: false }), words };
}

module.exports = {
  LlmError,
  dedupeRepeatedSentences,
  MIN_USABLE_WORDS,
  REASON_TEXT,
  describeReason,
  sanitizeEssay,
  assessEssay,
  minWordsFor
};
