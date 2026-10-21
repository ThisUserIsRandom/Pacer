'use strict';

/**
 * Provider registry for essay generation.
 *
 * Two interchangeable providers:
 *   - `server` : an external llama-server over HTTP (the original behaviour)
 *   - `local`  : a GGUF model running in-process via node-llama-cpp
 *
 * The user picks one in the UI; the choice is persisted through the settings
 * store. Nothing is auto-detected and the built-in model is never loaded unless
 * the `local` provider is actually used.
 */

const { createLlamaClient } = require('./llama');
const { createLocalLlm } = require('./llm-local');

const PROVIDERS = ['server', 'local'];
const DEFAULT_PROVIDER = 'server';

function isProvider(value) {
  return PROVIDERS.includes(value);
}

/**
 * @param {object} options
 * @param {object} options.config
 * @param {Console} [options.logger]
 */
function createLlmRouter(options) {
  const { config, logger = console } = options;

  const server = createLlamaClient({
    url: config.llamaUrl,
    modelsUrl: config.llamaModelsUrl,
    model: config.llamaModel || undefined,
    timeoutMs: config.llamaTimeoutMs
  });

  const local = createLocalLlm({
    modelPath: config.localModelPath,
    threads: config.localThreads,
    logger
  });

  function get(provider) {
    return provider === 'local' ? local : server;
  }

  /** Status of both providers, for the picker. Never throws. */
  async function status() {
    const [serverStatus, localStatus] = await Promise.all([
      server.probe().catch((error) => ({
        reachable: false,
        model: null,
        detail: error.message
      })),
      local.probe().catch((error) => ({
        available: false,
        loaded: false,
        model: null,
        detail: error.message
      }))
    ]);

    return {
      server: {
        reachable: Boolean(serverStatus.reachable),
        model: serverStatus.model || null,
        url: config.llamaUrl,
        detail: serverStatus.detail || 'ok'
      },
      local: {
        available: Boolean(localStatus.available),
        loaded: Boolean(localStatus.loaded),
        loading: Boolean(localStatus.loading),
        model: localStatus.model || null,
        modelPath: localStatus.modelPath,
        detail: localStatus.detail || 'ok'
      }
    };
  }

  /** Load the built-in model ahead of the first request. */
  async function warmLocal() {
    return local.warmup();
  }

  async function dispose() {
    await local.dispose();
  }

  return {
    PROVIDERS,
    DEFAULT_PROVIDER,
    isProvider,
    get,
    status,
    warmLocal,
    dispose,
    server,
    local
  };
}

module.exports = { createLlmRouter, PROVIDERS, DEFAULT_PROVIDER, isProvider };
