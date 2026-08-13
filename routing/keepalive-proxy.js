/*
 * keepalive-proxy.js — SSE keepalive proxy между Claude Code и Anthropic-совместимым
 * шлюзом (agentrouter.org / New API), который НЕ пересылает `event: ping` во время
 * длинных thinking-пауз, из-за чего watchdog Claude Code (~20с без байт) рвёт
 * поток и ретраит запрос до бесконечности.
 *
 * Канонический исходник: https://github.com/v1tusha/sse-keepalive-proxy (MIT).
 * Дополнение для дашборда: GET /__keepalive/api/status → 200 {"ok":true,...}.
 *
 * Запуск:
 *   node keepalive-proxy.js
 *   PORT=20133 UPSTREAM=https://agentrouter.org IDLE_MS=5000 node keepalive-proxy.js
 *
 * Переключение Claude Code (редактируем ~/.claude/settings.json, на Windows:
 * C:\Users\<you>\.claude\settings.json):
 *   "ANTHROPIC_BASE_URL": "http://127.0.0.1:20133"
 * ANTHROPIC_AUTH_TOKEN и ANTHROPIC_MODEL оставить как есть. Рестарт Claude Code.
 *
 * Заголовки запроса релеятся БЕЗ изменений (шлюз фингерпринтит клиента:
 * user-agent, x-app, x-stainless-*, anthropic-version, anthropic-beta,
 * authorization), переписывается только Host на хост апстрима.
 * Значение authorization нигде не логируется.
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

const upstream = new URL(UPSTREAM);
const upRequester = upstream.protocol === 'https:' ? https.request : http.request;
const upBase = upstream.pathname.replace(/\/+$/, '');
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

const server = http.createServer((req, res) => {
  const reqPath = req.url;
  const started = Date.now();
  let active = null;
  let sseTimer = null;
  let keepalives = 0;
  let aborted = false;

  // Статус для дашборда (:8200 health-check).
  if (req.method === 'GET' && req.url === '/__keepalive/api/status') {
    const h = http.STATUS_CODES[200] || '';
    log(`GET /__keepalive/api/status -> 200`);
    if (active) { /* noop */ }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, port: PORT, upstream: UPSTREAM, idle_ms: IDLE_MS, retries: MAX_RETRIES }));
    return;
  }

  log(`>> ${req.method} ${reqPath} start`);

  const stopTimer = () => {
    if (sseTimer !== null) {
      clearTimeout(sseTimer);
      sseTimer = null;
    }
  };

  const forward = (status, headers, stream) => {
    const isSSE = /text\/event-stream/i.test(String(headers['content-type'] || ''));
    log(`${req.method} ${reqPath} -> ${status}${isSSE ? ' (SSE)' : ''} ${Date.now() - started}ms`);

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

    let tail = Buffer.alloc(0);

    const tick = () => {
      sseTimer = null;
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
    sseTimer = setTimeout(tick, IDLE_MS);

    stream.on('data', (chunk) => {
      res.write(chunk);
      tail = Buffer.concat([
        tail,
        chunk.length > 4 ? chunk.subarray(chunk.length - 4) : chunk,
      ]).slice(-4);
      if (sseTimer !== null) clearTimeout(sseTimer);
      sseTimer = setTimeout(tick, IDLE_MS);
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

  const makeUpstream = (attempt, body) => {
    const upReq = upRequester({
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upBase + reqPath,
      headers: Object.assign({}, req.headers, { host: upstream.host }),
    }, (upRes) => {
      const status = upRes.statusCode;
      const headers = upRes.headers;

      // Шлюз не реализует count_tokens → отдаём локальную оценку вместо 404.
      // Пробуем апстрим ПЕРВЫМ: шлюзы, которые endpoint умеют, отдают точное число,
      // и подменять его оценкой не надо.
      if (COUNT_TOKENS_FALLBACK && status === 404 && isCountTokens(req.method, reqPath)) {
        upRes.resume();   // тело 404 не нужно — дренируем, чтобы освободить сокет
        if (aborted) return;
        const tokens = estimateTokens(body);
        log(`${req.method} ${reqPath} -> 200 (upstream 404, local estimate ${tokens})`);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ input_tokens: tokens }));
        return;
      }

      const transient = shouldRetryStatus(status) && attempt < MAX_RETRIES;

      if (transient) {
        const chunks = [];
        let size = 0;
        let drained = false;
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
            setTimeout(() => makeUpstream(attempt + 1, body), RETRY_DELAY_MS * attempt);
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
    upReq.on('error', (err) => {
      if (res.destroyed || aborted) return;
      log(`${req.method} ${reqPath} upstream error: ${err.message}`);
      if (!res.headersSent) {
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
    const body = Buffer.concat(bodyChunks, bodySize);
    makeUpstream(1, body);
  });

  req.on('error', () => { aborted = true; if (active) active.destroy(); });
  res.on('error', () => { aborted = true; if (active) active.destroy(); });
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
      if (active) active.destroy();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM} (idle ${IDLE_MS}ms, retries ${MAX_RETRIES} x ${RETRY_DELAY_MS}ms)`);
});