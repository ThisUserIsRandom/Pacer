'use strict';

/**
 * Mock llama-server for testing Pacer's failure paths without a real model.
 *
 *   node scripts/mock-llama.js            # listens on 127.0.0.1:8283
 *   STUB_PORT=9000 node scripts/mock-llama.js
 *
 * Point Pacer at it and drive behaviour from the topic string:
 *
 *   LLAMA_URL=http://127.0.0.1:8283/v1/chat/completions \
 *   LLAMA_MODELS_URL=http://127.0.0.1:8283/v1/models \
 *   PORT=3003 node app.js
 *
 * Topics:  trap · boom · hang · template · tiny · markdown · anything else
 */

const http = require('node:http');

const GOOD_ESSAY =
  'Otters are pure joy wrapped in fur, and they have a way of making an ordinary afternoon feel like a holiday. ' +
  'These playful creatures bring a splash of happiness to any day, reminding us of the simple pleasures found in nature. ' +
  'With their sleek bodies and bright, curious eyes, they turn a riverbank into a stage and a quiet pool into a playground. ' +
  'There is something wonderfully unserious about an otter, and it is exactly what most of us need more of. ' +
  'They float on their backs, cracking shells with a casual expertise that suggests they have all the time in the world. ' +
  'Watching them, you begin to suspect that they do, and that the rest of us are simply doing it wrong. ' +
  'Otters are also surprisingly social, chattering and wrestling and grooming one another with obvious affection. ' +
  'They hold hands while sleeping so they do not drift apart, which is the kind of detail that makes people smile all day. ' +
  'Their dens, called holts, are cosy burrows dug into riverbanks and lined with leaves and moss, which sounds delightful. ' +
  'They keep the water clean and the kelp forests healthy, quietly doing important work while looking like they are playing. ' +
  'A river with otters in it is a river with a heartbeat, and the whole landscape seems livelier for their presence. ' +
  'So if you ever get the chance to watch one for a while, take it, and let the cheerful example sink in. ' +
  'Move through the water with purpose, eat with enthusiasm, nap in the sun, and hold on to the people you love. ' +
  'That is the otter way, and it is a very good way to be.';

const SHORT_ESSAY =
  'Otters are lovely creatures that swim in rivers and bring joy to everyone who watches them play.';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model.gguf', object: 'model' }] }));
    return;
  }

  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* ignore malformed bodies */
    }

    const userMessage = (body.messages || []).find((message) => message.role === 'user');
    const topic = String((userMessage && userMessage.content) || '').toLowerCase();
    const hasThinkingKwarg = Boolean(body.chat_template_kwargs);

    const reply = (payload, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };

    // Never answers, so the client-side timeout has to fire.
    if (topic.includes('hang')) return;

    if (topic.includes('boom')) {
      reply({ error: 'internal server error' }, 500);
      return;
    }

    // Rejects the Qwen-specific kwarg, then succeeds without it.
    if (topic.includes('template')) {
      if (hasThinkingKwarg) {
        reply({ error: { message: 'chat template does not support enable_thinking' } }, 400);
        return;
      }
      reply({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: GOOD_ESSAY } }],
        timings: { predicted_n: 220, predicted_ms: 1000 }
      });
      return;
    }

    // The thinking-model trap: all budget spent on reasoning, empty content.
    if (topic.includes('trap')) {
      reply({
        choices: [
          {
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: '',
              reasoning_content:
                'Let me think carefully about how to write a cheerful essay. '.repeat(40)
            }
          }
        ],
        usage: { completion_tokens: 700 }
      });
      return;
    }

    if (topic.includes('tiny')) {
      reply({
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: SHORT_ESSAY } }]
      });
      return;
    }

    // Markdown, headings, bullets and a preamble that all need sanitising.
    if (topic.includes('markdown')) {
      reply({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content:
                'Here is a cheerful 300-word essay about otters:\n\n' +
                '# The Joy of Otters\n\n' +
                '**Otters** are *delightful* creatures.\n\n' +
                '- They swim\n- They play\n\n' +
                '`They` bring joy to everyone who watches them glide through the water. ' +
                GOOD_ESSAY
            }
          }
        ]
      });
      return;
    }

    reply({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: GOOD_ESSAY } }],
      timings: { predicted_n: 240, predicted_ms: 1200 }
    });
  });
});

const port = Number(process.env.STUB_PORT) || 8283;
server.listen(port, '127.0.0.1', () => {
  console.log(`mock llama-server listening on http://127.0.0.1:${port}`);
});
