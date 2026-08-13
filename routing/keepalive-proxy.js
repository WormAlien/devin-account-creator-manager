/*
 * keepalive-proxy.js — SSE keepalive proxy между Claude Code и Anthropic-совместимым
 * шлюзом (agentrouter.org / New API), который НЕ пересылает `event: ping` во время
 * длинных thinking-пауз, из-за чего watchdog Claude Code (~20с без байт) рвёт
 * поток и ретраит запрос до бесконечности.
 *
 * Канонический исходник: https://github.com/v1tusha/sse-keepalive-proxy (MIT).
 * Дополнение для дашборда: GET /__keepalive/api/status → 200 {"ok":true,...}.
 *
 * ФИКСЫ (2026-08-13), все под env-флагами:
 *   1. count_tokens fallback (COUNT_TOKENS_FALLBACK=1): шлюз 404-ит
 *      POST /v1/messages/count_tokens, CC читает input_tokens с тела ошибки и
 *      падает "Unable to validate model... z.usage.input_tokens", /model не
 *      переключается. Прокси отвечает сам локальной оценкой.
 *   2. Ранний SSE (EARLY_SSE=1): для POST /v1/messages со stream:true открываем
 *      SSE-ответ клиенту СРАЗУ и запускаем keepalive ДО обращения к upstream.
 *      Один таймер покрывает и TTFB-дыру (шлюз долго думает до первого байта),
 *      и retry-паузы. Финальные ошибки уходят in-band как `event: error`.
 *   3. Upstream-таймаут (UPSTREAM_TIMEOUT_MS): каждая попытка ограничена по
 *      времени — устраняет висящие минутами запросы (в логах были 129с).
 *   4. Не ретраить после отмены клиентом (проверка aborted перед retry).
 *
 * Запуск:
 *   node keepalive-proxy.js
 *   PORT=20133 UPSTREAM=https://agentrouter.org IDLE_MS=5000 node keepalive-proxy.js
 *
 * Переключение Claude Code (~/.claude/settings.json):
 *   "ANTHROPIC_BASE_URL": "http://127.0.0.1:20133"
 * Заголовки запроса релеятся БЕЗ изменений. authorization нигде не логируется.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');

const PORT = Number(process.env.PORT || 8787);
const UPSTREAM = process.env.UPSTREAM || 'https://agentrouter.org';
const IDLE_MS = Number(process.env.IDLE_MS || 5000);
const LOG_FILE = process.env.LOG_FILE || '';
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1500);
const COUNT_TOKENS_FALLBACK = process.env.COUNT_TOKENS_FALLBACK !== '0';
const EARLY_SSE = process.env.EARLY_SSE !== '0';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000);

// Ремап claude-haiku* (CC шлёт для быстрых подзадач) на gpt-модель через локальный
// agentrouter-proxy :20132 (у agentrouter gpt через /v1/messages сломан — нужен
// Anthropic→OpenAI конвертер; эмулируем gpt-прокси, не меняя claude-путь).
const HAIKU_REMAP = process.env.HAIKU_REMAP !== '0';
const HAIKU_TO_MODEL = process.env.HAIKU_TO_MODEL || 'gpt-5.6-sol';
const HAIKU_GPT_PROXY = process.env.HAIKU_GPT_PROXY || 'http://127.0.0.1:20132';

const upstream = new URL(UPSTREAM);
const upRequester = upstream.protocol === 'https:' ? https.request : http.request;
const upBase = upstream.pathname.replace(/\/+$/, '');
const gptProxy = new URL(HAIKU_GPT_PROXY);
const gptRequester = gptProxy.protocol === 'https:' ? https.request : http.request;
const gptBase = gptProxy.pathname.replace(/\/+$/, '');
const KEEPALIVE = ': keepalive\n\n';
const KEEPALIVE_COMMENT = ': keepalive\n';

const { createLogger } = require('./proxy-logger.js');
const { logLine } = createLogger('keepalive');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line);
    } catch (e) {
      /* ignore */
    }
  }
  logLine(msg);
}

function shouldRetryStatus(status) {
  return status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599);
}

const RETRY_NO = /invalid|authentication|api[ _-]?key|expired|billing|quota|permission|denied|bad request|bad gateway upstream/i;
const RETRY_OK = /unauthorized client detected|overloaded|too many|rate limit|internal|upstream|temporar|busy|unavailable/i;

function isTransientBody(status, buf) {
  const s = buf.toString('utf8');
  if (!s.trim()) return true;
  if (RETRY_NO.test(s)) return false;
  if (RETRY_OK.test(s)) return true;
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

function isCountTokens(method, reqPath) {
  return method === 'POST' && reqPath.replace(/\?.*$/, '') === COUNT_TOKENS_PATH;
}

// Грубая оценка на случай, когда апстрим не умеет count_tokens: ~4 символа на токен.
// Считаем только то, что реально видит клиент — system + текст сообщений + входы tool_use.
// Точность здесь не важна: Claude Code использует это как проверку «модель существует».
function estimateTokens(body) {
  try {
    const r = JSON.parse(body.toString('utf8') || '{}');
    const sys = typeof r.system === 'string'
      ? r.system
      : Array.isArray(r.system) ? r.system.map((b) => (b && b.text) || '').join('') : '';
    let chars = sys.length;
    for (const m of r.messages || []) {
      if (typeof m.content === 'string') {
        chars += m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          chars += ((b && b.text) || '').length;
          if (b && b.type === 'tool_use') chars += JSON.stringify(b.input || {}).length;
        }
      }
    }
    return Math.max(1, Math.ceil(chars / 4));
  } catch (e) {
    return 1;   // тело битое/пустое — лучше отдать 1, чем пробросить 404
  }
}

// stream:true в теле POST /v1/messages? Только такие запросы кандидаты на ранний SSE.
function wantsStream(method, reqPath, body) {
  if (method !== 'POST') return false;
  const p = reqPath.replace(/\?.*$/, '');
  if (p !== '/v1/messages') return false;
  try {
    return JSON.parse(body.toString('utf8') || '{}').stream === true;
  } catch (e) {
    return false;
  }
}

// Ремап маршрутизации для POST /v1/messages:
//   • claude-haiku*  → HAIKU_TO_MODEL (gpt) на gpt-прокси (у agentrouter haiku нет);
//   • gpt-*/прочие   → gpt-прокси как есть (у agentrouter gpt через /v1/messages сломан —
//                      нужен Anthropic→OpenAI конвертер :20132);
//   • claude-* с суффиксом контекста ([1m], [200k] и т.п.) → срезаем суффикс,
//                      шлём в agentrouter как есть (таких имён у него в /v1/models нет → 503);
//   • claude-*        → null (passthrough напрямую в agentrouter).
// Возвращает { body, requester, hostname, port, base, host } или null.
function remapHaiku(method, reqPath, body) {
  if (!HAIKU_REMAP) return null;
  if (method !== 'POST') return null;
  const p = reqPath.replace(/\?.*$/, '');
  if (p !== '/v1/messages') return null;
  let j;
  try {
    j = JSON.parse(body.toString('utf8') || '{}');
  } catch (e) {
    return null;
  }
  if (typeof j.model !== 'string') return null;
  const model = j.model;
  // Суффикс контекстного окна вида `[1m]`, `[200k]` — у agentrouter таких моделей нет.
  const bare = model.replace(/\s*\[[^\]]*\]\s*$/, '');
  let newBody = null;
  let label = null;
  if (/haiku/i.test(model)) {
    newBody = Buffer.from(JSON.stringify(Object.assign({}, j, { model: HAIKU_TO_MODEL })), 'utf8');
    label = `haiku→${HAIKU_TO_MODEL}`;
  } else if (/gpt|o[0-9]|davinci|chatgpt/i.test(model)) {
    newBody = body;
    label = model;
  } else if (bare !== model) {
    newBody = Buffer.from(JSON.stringify(Object.assign({}, j, { model: bare })), 'utf8');
    label = `${model}→${bare}`;
    log(`${method} ${reqPath} ${label} via ${upstream.host}`);
    return { body: newBody, requester: upRequester, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), base: upBase, host: upstream.host };
  } else {
    return null;
  }
  log(`${method} ${reqPath} ${label} via ${HAIKU_GPT_PROXY}`);
  return { body: newBody, requester: gptRequester, hostname: gptProxy.hostname, port: gptProxy.port || 80, base: gptBase, host: gptProxy.host };
}

const server = http.createServer((req, res) => {
  const reqPath = req.url;
  const started = Date.now();
  let active = null;
  let sseTimer = null;
  let keepalives = 0;
  let aborted = false;
  let clientSSE = false;          // мы уже открыли SSE-ответ клиенту (ранний SSE)
  let tail = Buffer.alloc(0);     // последние ≤4 байта отправленного клиенту (для формата keepalive)

  // Статус для дашборда (:8200 health-check).
  if (req.method === 'GET' && req.url === '/__keepalive/api/status') {
    log(`GET /__keepalive/api/status -> 200`);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, port: PORT, upstream: UPSTREAM, idle_ms: IDLE_MS, retries: MAX_RETRIES }));
    return;
  }

  log(`>> ${req.method} ${reqPath} start`);

  // ФИКС 1 — count_tokens fallback: шлюз обычно 404-ит этот endpoint, CC читает
  // input_tokens с тела ошибки и падает на валидации модели (/model не работает).
  if (COUNT_TOKENS_FALLBACK && isCountTokens(req.method, reqPath)) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (aborted) return;
      const tokens = estimateTokens(Buffer.concat(chunks));
      log(`${req.method} ${reqPath} -> 200 (local estimate ${tokens})`);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ input_tokens: tokens }));
    });
    req.on('error', () => { aborted = true; if (!res.writableEnded) res.destroy(); });
    return;
  }

  const stopTimer = () => {
    if (sseTimer !== null) {
      clearTimeout(sseTimer);
      sseTimer = null;
    }
  };

  // keepalive-тик на уровне запроса — работает и ДО прихода заголовков upstream,
  // и во время retry-пауз (в этом всё лечение TTFB/retry-дыр).
  const tick = () => {
    sseTimer = null;
    if (aborted || res.writableEnded) return;
    const t = tail.toString('utf8');
    if (t.length === 0 || t.endsWith('\n\n')) {
      res.write(KEEPALIVE);
      tail = Buffer.concat([tail, Buffer.from(KEEPALIVE)]).slice(-4);
      keepalives += 1;
      log(`${req.method} ${reqPath} keepalive #${keepalives}`);
    } else if (t.endsWith('\n')) {
      res.write(KEEPALIVE_COMMENT);
      tail = Buffer.concat([tail, Buffer.from(KEEPALIVE_COMMENT)]).slice(-4);
      keepalives += 1;
      log(`${req.method} ${reqPath} keepalive mid-event #${keepalives}`);
    }
    sseTimer = setTimeout(tick, IDLE_MS);
  };
  const armTimer = () => {
    if (sseTimer !== null) clearTimeout(sseTimer);
    sseTimer = setTimeout(tick, IDLE_MS);
  };
  const noteBytes = (chunk) => {
    tail = Buffer.concat([tail, chunk.length > 4 ? chunk.subarray(chunk.length - 4) : chunk]).slice(-4);
  };

  // Открываем клиенту SSE-ответ ДО обращения к upstream и запускаем keepalive.
  const startClientSSE = () => {
    clientSSE = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    });
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    armTimer();
  };

  // Ошибка, когда клиенту уже отправлены SSE-заголовки: отдаём in-band `event: error`.
  const inbandError = (status, buf) => {
    stopTimer();
    if (aborted || res.writableEnded) return;
    let obj;
    try {
      obj = JSON.parse((buf || Buffer.alloc(0)).toString('utf8'));
      if (!obj || !obj.error) throw 0;
    } catch (e) {
      obj = { type: 'error', error: { type: 'proxy_error', message: `upstream ${status}` } };
    }
    if (!obj.type) obj.type = 'error';
    res.write(`event: error\ndata: ${JSON.stringify(obj)}\n\n`);
    res.end();
  };

  const forward = (status, headers, stream) => {
    const isSSE = /text\/event-stream/i.test(String(headers['content-type'] || ''));
    log(`${req.method} ${reqPath} -> ${status}${isSSE ? ' (SSE)' : ''} ${Date.now() - started}ms`);

    // Клиенту уже отправлены заголовки (ранний SSE) — writeHead больше нельзя.
    if (clientSSE) {
      // 2xx, но НЕ event-stream (апстрим отдал JSON/пустое на stream:true) —
      // сырые байты в SSE-канале = "malformed response (HTTP 200)". Отдаём in-band.
      if (status >= 200 && status < 300 && isSSE) {
        if (res.socket) res.socket.setNoDelay(true);
        stream.on('data', (chunk) => {
          res.write(chunk);
          noteBytes(chunk);
          armTimer();
        });
        stream.on('end', () => { stopTimer(); if (!res.writableEnded) res.end(); });
        stream.on('error', (err) => {
          stopTimer();
          log(`${req.method} ${reqPath} upstream stream error: ${err.message}`);
          if (!res.writableEnded && !res.destroyed) res.destroy(err);
        });
      } else {
        // не-2xx после исчерпания ретраев → отдаём как in-band SSE-ошибку
        const ec = [];
        stream.on('data', (c) => ec.push(c));
        stream.on('end', () => inbandError(status, Buffer.concat(ec)));
        stream.on('error', () => inbandError(status, Buffer.alloc(0)));
      }
      return;
    }

    // Обычный путь (ранний SSE не применялся): как в оригинале.
    res.writeHead(status, headers);

    if (!isSSE) {
      stream.on('error', (err) => {
        log(`${req.method} ${reqPath} upstream stream error: ${err.message}`);
        if (!res.writableEnded && !res.destroyed) res.destroy(err);
      });
      stream.pipe(res);
      return;
    }

    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    armTimer();

    stream.on('data', (chunk) => {
      res.write(chunk);
      noteBytes(chunk);
      armTimer();
    });
    stream.on('end', () => {
      stopTimer();
      res.end();
    });
    stream.on('error', (err) => {
      stopTimer();
      log(`${req.method} ${reqPath} upstream stream error: ${err.message}`);
      if (!res.writableEnded && !res.destroyed) res.destroy(err);
    });
  };

  const makeUpstream = (attempt, body, tgt) => {
    const t = tgt || { requester: upRequester, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), base: upBase, host: upstream.host };
    const headers = Object.assign({}, req.headers, { host: t.host });
    // Ремап мог заменить body (haiku→gpt, срезание суффикса) — content-length от клиента
    // больше не соответствует длине тела, Node отправит заголовок со старой длиной и
    // сервер будет ждать недостающие байты (запрос висит). Пересчитываем сами.
    if (tgt) {
      headers['content-length'] = Buffer.byteLength(body);
    }
    const upReq = t.requester({
      hostname: t.hostname,
      port: t.port,
      method: req.method,
      path: t.base + reqPath,
      headers: headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    }, (upRes) => {
      const status = upRes.statusCode;
      const headers = upRes.headers;
      const transient = shouldRetryStatus(status) && attempt < MAX_RETRIES;

      if (transient) {
        const chunks = [];
        let size = 0;
        const drain = (onEnd) => {
          upRes.on('data', (c) => {
            chunks.push(c);
            size += c.length;
          });
          upRes.on('end', onEnd);
          upRes.on('error', () => onEnd());
        };
        drain(() => {
          if (aborted) return;
          const buf = Buffer.concat(chunks, size);
          if (isTransientBody(status, buf)) {
            log(`${req.method} ${reqPath} retry ${attempt}/${MAX_RETRIES} after ${status}: ${buf.toString('utf8').slice(0, 100)}`);
            if (aborted) return;   // ФИКС 4 — клиент отвалился, не плодим сирот
            setTimeout(() => { if (!aborted) makeUpstream(attempt + 1, body, tgt); }, RETRY_DELAY_MS * attempt);
          } else {
            const pt = new PassThrough();
            pt.end(buf);
            forward(status, headers, pt);
          }
        });
        return;
      }

      forward(status, headers, upRes);
    });

    active = upReq;
    upReq.on('timeout', () => {
      log(`${req.method} ${reqPath} upstream timeout ${UPSTREAM_TIMEOUT_MS}ms (attempt ${attempt})`);
      upReq.destroy(new Error('upstream timeout'));
    });
    upReq.on('error', (err) => {
      if (res.destroyed || aborted) return;
      log(`${req.method} ${reqPath} upstream error: ${err.message}`);
      if (clientSSE) {
        inbandError(502, Buffer.from(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `Bad Gateway: ${err.message}` } })));
      } else if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Bad Gateway: ${err.message}\n`);
      } else if (!res.writableEnded) {
        res.destroy(err);
      }
    });
    upReq.end(body);
  };

  const bodyChunks = [];
  let bodySize = 0;
  req.on('data', (c) => {
    bodyChunks.push(c);
    bodySize += c.length;
  });
  req.on('end', () => {
    const rawBody = Buffer.concat(bodyChunks, bodySize);
    const remapped = remapHaiku(req.method, reqPath, rawBody);
    const body = remapped ? remapped.body : rawBody;
    // ФИКС 2 — ранний SSE: открываем клиенту поток и keepalive ещё ДО upstream.
    if (EARLY_SSE && wantsStream(req.method, reqPath, body)) {
      startClientSSE();
    }
    makeUpstream(1, body, remapped);
  });

  req.on('error', () => { aborted = true; stopTimer(); if (active) active.destroy(); });
  res.on('error', () => { aborted = true; stopTimer(); if (active) active.destroy(); });
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      stopTimer();
      if (active) active.destroy();
    }
  });
  req.on('close', () => {
    if (!req.complete) {
      aborted = true;
      stopTimer();
      if (active) active.destroy();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM} (idle ${IDLE_MS}ms, retries ${MAX_RETRIES} x ${RETRY_DELAY_MS}ms, early_sse ${EARLY_SSE ? 'on' : 'off'}, upstream_timeout ${UPSTREAM_TIMEOUT_MS}ms)`);
});
