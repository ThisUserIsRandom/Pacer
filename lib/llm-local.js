'use strict';

/**
 * In-process LLM provider backed by `node-llama-cpp`.
 *
 * Runs a GGUF model inside the Node process — no external `llama-server`, no
 * port to manage. Chosen explicitly by the user; nothing is auto-detected or
 * loaded in the background.
 *
 * Measured on a 12-core CPU with Qwen3-0.6B (Q8_0, 806 MB):
 *   model load ≈ 1.3 s, generation ≈ 14 words/s.
 *
 * The model stops early on its own (a 300-word request yields ~120-150 words),
 * so generation continues in rounds until the target is reached. A fresh
 * context per request keeps requests from leaking into each other.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { countWords } = require('./fallback-essays');
const { LlmError, assessEssay, dedupeRepeatedSentences } = require('./essay');

const MAX_ROUNDS = 4;
const CONTINUE_PROMPT =
  'Continue the essay with new material only, without repeating anything already written.';

const SYSTEM_PROMPT =
  'You are a cheerful, upbeat writing assistant. Write flowing plain prose only, with no ' +
  'headings, lists or commentary about the request. Never mention word counts. ' +
  'Never repeat a sentence or phrase.';

/*
 * Measured trade-off on Qwen3-0.6B: pushing the repeat penalty up (1.3 with a
 * 256-token window) does suppress loops but collapses coherence and cuts output
 * to ~100 words. The mild penalty below plus the sentence dedupe in essay.js
 * gives full-length, coherent text with no repeated sentences — that is the
 * combination to keep.
 */
const REPEAT_PENALTY = {
  penalty: 1.12,
  frequencyPenalty: 0.1,
  presencePenalty: 0.1
};

/** Generous wall-clock budget: ~4 words/s, floors at 60s, caps at 20 min. */
function budgetFor(targetWords) {
  return Math.min(1200000, Math.max(60000, Math.round(targetWords * 250)));
}

/**
 * @param {{ modelPath: string, logger?: Console, threads?: number }} options
 */
function createLocalLlm(options) {
  const { modelPath, logger = console, threads = 0 } = options;

  const resolvedPath = path.resolve(modelPath);
  let sdkPromise = null;
  let modelPromise = null;
  let modelInstance = null;
  let loading = false;
  let disposeRequested = false;

  // One generation at a time: a CPU-bound 0.6B model thrashes if parallelised.
  let queue = Promise.resolve();

  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = import('node-llama-cpp').catch((error) => {
        sdkPromise = null;
        throw new LlmError(
          'model-load-failed',
          `node-llama-cpp could not be loaded: ${error.message}`
        );
      });
    }
    return sdkPromise;
  }

  async function fileExists() {
    try {
      await fs.access(resolvedPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Load (once) and keep the model resident for the life of the process. */
  function ensureModel() {
    if (modelPromise) return modelPromise;

    modelPromise = (async () => {
      if (disposeRequested) throw new LlmError('model-load-failed', 'Model was disposed.');

      if (!(await fileExists())) {
        throw new LlmError('model-missing', `No model file at ${resolvedPath}`, {
          modelPath: resolvedPath
        });
      }

      const { getLlama } = await loadSdk();
      let llama;
      try {
        llama = await getLlama({ gpu: false, ...(threads ? { maxThreads: threads } : {}) });
      } catch (error) {
        throw new LlmError('model-load-failed', `llama backend failed: ${error.message}`);
      }

      const startedAt = Date.now();
      loading = true;
      try {
        const model = await llama.loadModel({ modelPath: resolvedPath });
        modelInstance = model;
        logger.log(
          `[local] loaded ${path.basename(resolvedPath)} in ${Date.now() - startedAt}ms`
        );
        return model;
      } catch (error) {
        throw new LlmError('model-load-failed', `Could not load the model: ${error.message}`);
      } finally {
        loading = false;
      }
    })();

    // Allow a later retry if loading failed (e.g. file appeared afterwards).
    modelPromise.catch(() => {
      modelPromise = null;
    });

    return modelPromise;
  }

  /**
   * Generate an essay, continuing in rounds until the target is roughly met.
   * @returns {Promise<{text: string, model: string, provider: 'local', durationMs: number, words: number}>}
   */
  async function runGeneration(topic, targetWords, externalSignal) {
    if (externalSignal && externalSignal.aborted) {
      throw new LlmError('cancelled', 'Request was cancelled before it started.');
    }

    const model = await ensureModel();
    const { LlamaChatSession } = await loadSdk();

    const contextSize = Math.min(32768, Math.max(2048, Math.round(targetWords * 3) + 1024));
    let context;
    try {
      context = await model.createContext({ contextSize });
    } catch (error) {
      throw new LlmError('model-load-failed', `Could not create a context: ${error.message}`);
    }

    const budget = budgetFor(targetWords);
    const timeoutSignal = AbortSignal.timeout(budget);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;

    const startedAt = Date.now();
    let essay = '';

    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: SYSTEM_PROMPT
      });

      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        if (signal.aborted) {
          throw externalSignal && externalSignal.aborted
            ? new LlmError('cancelled', 'Generation was cancelled.')
            : new LlmError('timeout', 'The built-in model took too long.');
        }

        const prompt =
          round === 0 ? `Write a cheerful essay about ${topic}.` : CONTINUE_PROMPT;
        const maxTokens = round === 0 ? Math.min(1200, Math.round(targetWords * 1.6) + 120) : 520;

        let chunk;
        try {
          chunk = await session.prompt(prompt, {
            maxTokens,
            temperature: 0.85,
            repeatPenalty: REPEAT_PENALTY,
            signal
          });
        } catch (error) {
          if (signal.aborted) {
            throw externalSignal && externalSignal.aborted
              ? new LlmError('cancelled', 'Generation was cancelled.')
              : new LlmError('timeout', 'The built-in model took too long.');
          }
          throw new LlmError('bad-response', `The built-in model failed: ${error.message}`);
        }

        const merged = essay ? `${essay} ${chunk}`.replace(/\s+/g, ' ').trim() : chunk;
        const novel = dedupeRepeatedSentences(merged);
        const added = countWords(novel) - countWords(essay);
        essay = novel;

        // A round that only restated earlier material is a loop; stop early.
        if (added < 8) break;

        if (countWords(essay) >= targetWords * 0.9) break;
        if (Date.now() - startedAt > budget) break;
      }
    } finally {
      await context.dispose().catch(() => {});
    }

    const { text, words } = assessEssay(essay, targetWords);
    const durationMs = Date.now() - startedAt;

    logger.log(
      `[local] "${topic}" -> ${words}/${targetWords} words in ${(durationMs / 1000).toFixed(1)}s`
    );

    return {
      text,
      words,
      model: path.basename(resolvedPath),
      provider: 'local',
      durationMs,
      contextSize
    };
  }

  /** Serialise generations so two requests never fight over the CPU. */
  function generateEssay(topic, opts = {}) {
    const targetWords = opts.targetWords || 300;
    const run = queue.then(() => runGeneration(topic, targetWords, opts.signal));
    queue = run.catch(() => {});
    return run;
  }

  /** Status for the provider picker. Never throws. */
  async function probe() {
    const exists = await fileExists();
    return {
      available: exists,
      loaded: Boolean(modelInstance),
      loading,
      modelPath: resolvedPath,
      model: exists ? path.basename(resolvedPath) : null,
      detail: exists ? 'ready' : 'model file not found'
    };
  }

  /** Preload so the first real request is fast. */
  async function warmup() {
    if (!(await fileExists())) return false;
    try {
      await ensureModel();
      return true;
    } catch (error) {
      logger.warn(`[local] warmup failed: ${error.message}`);
      return false;
    }
  }

  async function dispose() {
    disposeRequested = true;
    if (modelPromise) {
      try {
        const model = await modelPromise;
        await model.dispose();
      } catch {
        /* already gone */
      }
      modelPromise = null;
      modelInstance = null;
    }
  }

  return {
    kind: 'local',
    modelPath: resolvedPath,
    generateEssay,
    probe,
    warmup,
    dispose,
    get loaded() {
      return Boolean(modelInstance);
    }
  };
}

module.exports = { createLocalLlm };
