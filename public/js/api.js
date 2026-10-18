/* Pacer — shared API helpers and tiny UI utilities. */
(function () {
  'use strict';

  const Pacer = (window.Pacer = window.Pacer || {});

  /** JSON fetch wrapper that turns non-2xx responses into thrown Errors. */
  async function request(url, options) {
    const opts = Object.assign({}, options);
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
      opts.body = JSON.stringify(opts.body);
    }

    const response = await fetch(url, opts);
    const raw = await response.text();

    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { error: raw };
      }
    }

    if (!response.ok) {
      const error = new Error((payload && payload.error) || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const api = {
    health: () => request('/api/health'),
    getStats: (limit) =>
      request(`/api/stats${Number.isFinite(Number(limit)) ? `?limit=${Math.round(Number(limit))}` : ''}`),
    clearStats: () => request('/api/stats', { method: 'DELETE' }),
    saveSession: (session) => request('/api/stats', { method: 'POST', body: session }),
    generateText: (topic, options) => {
      const opts = options || {};
      const body = { topic: topic || undefined };
      if (Number.isFinite(Number(opts.words)) && Number(opts.words) > 0) {
        body.words = Math.round(Number(opts.words));
      }
      return request('/api/generate', { method: 'POST', body, signal: opts.signal });
    }
  };

  /** Lightweight toast notifications. */
  function toast(message, kind) {
    const host = document.getElementById('toast-host');
    if (!host) return;

    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ` toast--${kind}` : '');
    el.textContent = message;
    host.appendChild(el);

    window.setTimeout(() => {
      el.style.transition = 'opacity .3s ease, transform .3s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      window.setTimeout(() => el.remove(), 320);
    }, 4200);
  }

  /** m:ss from seconds. */
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const total = Math.round(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  Pacer.api = api;
  Pacer.ui = { toast, formatTime, clamp };
})();
