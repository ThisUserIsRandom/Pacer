'use strict';

/**
 * Thin client for a local llama-server (llama.cpp) OpenAI-compatible endpoint.
 *
 * Hard-won details baked in here:
 *  - The model behind this endpoint may be a *thinking* model (Qwen3.x and
 *    friends). Left alone, it can spend the entire token budget on
 *    `reasoning_content` and return an EMPTY `message.content` with
 *    `finish_reason: "length"`. We therefore send
 *    `chat_template_kwargs.enable_thinking = false`, and we still verify that
 *    usable prose came back.
 *  - Generation on a large quantised model takes tens of seconds, so the
 *    timeout is generous and configurable.
 *  - Anything unusable becomes a typed LlamaError carrying a machine-readable
 *    `reason`, which the server turns into a specific offline-fallback notice.
 */

const { countWords, normalizeLength } = require('./fallback-essays');
const {
  LlmError,
  REASON_TEXT,
  describeReason,
  sanitizeEssay,
  assessEssay
} = require('./essay');

// Kept for backwards compatibility: callers import `LlamaError` from here.
const LlamaError = LlmError;
const MIN_USABLE_WORDS = 120;

/**
 * @param {object} options
 * @param {string} options.url          chat completions endpoint
 * @param {string} options.modelsUrl    models endpoint used for id discovery
 * @param {string} [options.model]      explicit model id override
 * @param {number} [options.timeoutMs]
 * @param {Console} [options.logger]
 */
function createLlamaClient(options) {
  const {
    url,
    modelsUrl,
    model: modelOverride,
    timeoutMs = 120000,
    logger = console
  } = options;

  const DEFAULT_MODEL = 'local-model';
  let cachedModel = null;
  let modelProbe = null;

  /** Discover the loaded model id. Never throws — always yields a usable string. */
  async function discoverModel() {
    if (modelOverride) return modelOverride;
    if (cachedModel) return cachedModel;
    if (modelProbe) return modelProbe;

    modelProbe = (async () => {
      try {
        const response = await fetch(modelsUrl, {
          signal: AbortSignal.timeout(Math.min(timeoutMs, 5000))
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const candidates = [
          body?.data?.[0]?.id,
          body?.models?.[0]?.name,
          body?.models?.[0]?.model
        ].filter((value) => typeof value === 'string' && value.length > 0);

        if (candidates.length > 0) {
          cachedModel = candidates[0];
          logger.log(`[llama] discovered model: ${cachedModel}`);
          return cachedModel;
        }
        logger.warn('[llama] /v1/models returned no usable model id');
        return DEFAULT_MODEL;
      } catch (error) {
        logger.warn(`[llama] model discovery failed (${error.message}); using "${DEFAULT_MODEL}"`);
        return DEFAULT_MODEL;
      } finally {
        // Allow a later retry if discovery failed outright.
        setTimeout(() => {
          modelProbe = null;
        }, 30000).unref?.();
      }
    })();

    return modelProbe;
  }

  function buildBody(model, topic, targetWords, useThinkingKwarg) {
    // Scale the token budget with the requested length (plus headroom) so long
    // essays are not truncated mid-sentence.
    const maxTokens = Math.min(12000, Math.round(targetWords * 1.5) + 300);

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content:
            `You are a cheerful, upbeat writing assistant. Always reply with a joyful essay of about ${targetWords} words. ` +
            'Write flowing plain prose only: no headings, no markdown, no bullet points, no lists, ' +
            'and no commentary about the request itself. Begin directly with the essay.'
        },
        {
          role: 'user',
          content: `Write a cheerful ${targetWords}-word essay about ${topic}.`
        }
      ],
      temperature: 0.85,
      max_tokens: maxTokens,
      stream: false
    };
    if (useThinkingKwarg) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    return body;
  }

  async function postChatCompletion(body, signal, externalSignal) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        // AbortSignal.any() hides which input aborted, so consult the client
        // signal directly to tell a user cancel apart from a timeout.
        if (externalSignal?.aborted) {
          throw new LlamaError('cancelled', 'Request was cancelled by the client.');
        }
        throw new LlamaError('timeout', 'llama-server did not respond within the timeout.');
      }
      // ECONNREFUSED / DNS / socket errors all land here.
      throw new LlamaError('unreachable', `Could not reach llama-server: ${error.message}`);
    }

    const rawText = await response.text();

    if (!response.ok) {
      // A server/template that cannot handle chat_template_kwargs rejects it.
      const templateRejected =
        response.status >= 400 &&
        response.status < 500 &&
        /chat_template_kwargs|enable_thinking|template/i.test(rawText);
      throw new LlamaError('http-error', `llama-server responded with HTTP ${response.status}.`, {
        status: response.status,
        templateRejected,
        body: rawText.slice(0, 300)
      });
    }

    try {
      return JSON.parse(rawText);
    } catch {
      throw new LlamaError('bad-response', 'llama-server returned a non-JSON response.');
    }
  }

  /**
   * Validate the completion and extract usable prose.
   * @returns {{ text: string, finishReason: string }}
   */
  function extractEssay(payload, targetWords = 300) {
    const choice = payload?.choices?.[0];
    if (!choice || typeof choice !== 'object') {
      throw new LlamaError('bad-response', 'llama-server response contained no choices.');
    }

    const message = choice.message || {};
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';

    if (content.trim() === '') {
      // The thinking trap: all tokens went to reasoning, content is empty.
      if (reasoning.trim() !== '') {
        throw new LlamaError(
          'thinking-only',
          'Model produced reasoning tokens but no essay text.',
          { reasoningChars: reasoning.length, finishReason }
        );
      }
      throw new LlamaError('empty-content', 'Model returned empty content.', { finishReason });
    }

    // Shared with the in-process provider so both behave identically.
    const { text } = assessEssay(content, targetWords);
    return { text, finishReason };
  }

  /**
   * Generate a cheerful essay. Throws LlamaError on any unusable outcome.
   *
   * @param {string} topic
   * @param {{ targetWords?: number, signal?: AbortSignal }} [opts]
   */
  async function generateEssay(topic, opts = {}) {
    const targetWords = opts.targetWords || 300;
    const externalSignal = opts.signal;
    const model = await discoverModel();

    // A 1200-word essay needs roughly four times the tokens, so allow more time.
    const effectiveTimeout = Math.min(
      1800000,
      Math.round(timeoutMs * Math.max(1, targetWords / 300))
    );
    const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
    const signal =
      typeof AbortSignal.any === 'function' && externalSignal
        ? AbortSignal.any([externalSignal, timeoutSignal])
        : timeoutSignal;

    if (externalSignal?.aborted) {
      throw new LlamaError('cancelled', 'Request was cancelled before it started.');
    }

    const startedAt = Date.now();
    let payload;
    let usedThinkingKwarg = true;

    try {
      payload = await postChatCompletion(buildBody(model, topic, targetWords, true), signal, externalSignal);
    } catch (error) {
      // Compat: retry once without the Qwen-specific kwarg for other models.
      if (error instanceof LlamaError && error.reason === 'http-error' && error.templateRejected) {
        logger.warn('[llama] server rejected chat_template_kwargs; retrying without it');
        usedThinkingKwarg = false;
        payload = await postChatCompletion(buildBody(model, topic, targetWords, false), signal, externalSignal);
      } else {
        throw error;
      }
    }

    const durationMs = Date.now() - startedAt;
    const { text, finishReason } = extractEssay(payload, targetWords);

    const predictedN = Number(payload?.timings?.predicted_n);
    const predictedMs = Number(payload?.timings?.predicted_ms);
    const tokPerSec =
      Number.isFinite(predictedN) && Number.isFinite(predictedMs) && predictedMs > 0
        ? Math.round((predictedN / (predictedMs / 1000)) * 10) / 10
        : null;

    // The model tends to overshoot the requested length; trim to fit the pacer.
    const trimmed = normalizeLength(text, targetWords, { extend: false });

    logger.log(
      `[llama] "${topic}" -> ${countWords(trimmed)}/${targetWords} words in ${(durationMs / 1000).toFixed(1)}s` +
        `${tokPerSec ? ` (${tokPerSec} tok/s)` : ''}, finish_reason=${finishReason}`
    );

    return {
      text: trimmed,
      model,
      durationMs,
      tokPerSec,
      finishReason,
      usedThinkingKwarg,
      targetWords,
      timeoutMs: effectiveTimeout
    };
  }

  /** Lightweight reachability probe for /api/health. */
  async function probe() {
    try {
      const response = await fetch(modelsUrl, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return { reachable: false, model: null, detail: `HTTP ${response.status}` };
      const model = await discoverModel();
      return { reachable: true, model, detail: 'ok' };
    } catch (error) {
      return { reachable: false, model: null, detail: error.message };
    }
  }

  return {
    generateEssay,
    discoverModel,
    probe,
    sanitizeEssay,
    url,
    modelsUrl,
    timeoutMs,
    MIN_USABLE_WORDS
  };
}

module.exports = { createLlamaClient, LlamaError, sanitizeEssay, describeReason, REASON_TEXT };
