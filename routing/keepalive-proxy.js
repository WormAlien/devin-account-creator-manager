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
const path = require('path');
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

// Активный ключ agentrouter: keepalive инжектит его в исходящие заголовки на каждый
// запрос, поэтому переключение ключа на вкладке дашборда работает на лету (без
// рестарта Claude Code). В settings.json лежит заглушка AUTH_TOKEN='dummy'.
// KEY_FILE параметризован env'ом: второй экземпляр прокси (Tabi) инжектит свой ключ.
const AR_ACTIVE_KEY_FILE = process.env.KEY_FILE
    || path.join(require('os').homedir(), '.claude', 'ar-active-key.txt');

// Ремап claude-haiku* (CC шлёт для быстрых подзадач) на gpt-модель через локальный
// agentrouter-proxy :20132 (у agentrouter gpt через /v1/messages сломан — нужен
// Anthropic→OpenAI конвертер; эмулируем gpt-прокси, не меняя claude-путь).
// Приоритет маппинга: routing/ar-modelmap.json (правится на вкладке AgentRouter,
// перечитывается по mtime) → env HAIKU_TO_MODEL.
const HAIKU_REMAP = process.env.HAIKU_REMAP !== '0';
const HAIKU_TO_MODEL = process.env.HAIKU_TO_MODEL || 'gpt-5.6-sol';
const HAIKU_GPT_PROXY = process.env.HAIKU_GPT_PROXY || 'http://127.0.0.1:20132';
// Файл маппинга claude-тиров параметризован env'ом: второй экземпляр прокси (Tabi)
// читает свой tabi-modelmap.json; первый (AgentRouter) — как раньше, ar-modelmap.json.
const AR_MODELMAP_FILE = process.env.MODELMAP_FILE
    || path.join(__dirname, 'ar-modelmap.json');

const modelMapCache = { data: null, mtime: 0 };
function readModelMap() {
    try {
        const st = fs.statSync(AR_MODELMAP_FILE);
        if (modelMapCache.data && st.mtimeMs === modelMapCache.mtime) return modelMapCache.data;
        const raw = fs.readFileSync(AR_MODELMAP_FILE, 'utf8');
        const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        modelMapCache.data = { opus: '', sonnet: '', haiku: '', ...data };
        modelMapCache.mtime = st.mtimeMs;
        return modelMapCache.data;
    } catch { return { opus: '', sonnet: '', haiku: '' }; }
}

// Маппинг claude-тира → целевая модель (как в agentrouter-proxy.js).
const TIER_RE = [{ tier: 'opus', re: /(^|[-_.\/])?opus([-\/]|$)/i }, { tier: 'sonnet', re: /(^|[-_.\/])?sonnet([-\/]|$)/i }, { tier: 'haiku', re: /(^|[-_.\/])?haiku([-\/]|$)/i }];
function tierTargetFor(model) {
    const mm = readModelMap();
    for (const { tier, re } of TIER_RE) {
        if (mm[tier] && re.test(String(model || ''))) return { tier, target: mm[tier] };
    }
    return null;
}
function isGptLike(model) {
    return /gpt|o[0-9]|davinci|chatgpt/i.test(String(model || ''));
}

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

// --- Runtime-конфиг хеджинга (меняется на лету через POST /__config) ---
// Хедж: если шлюз молчит дольше cfg.hedgeMs, пускаем ПАРАЛЛЕЛЬНЫЙ дубль запроса и
// берём того, кто ответил первым, остальных рвём. Дефолты (20с / 2 попытки)
// замерены на живом agentrouter (v1tusha, 15.08.2026): hedgeMs=5000 + 5 попыток
// дали ~3x нагрузку и рост ответов 8с → 15-30с; 20с/2 вернули 6.6–8.6с.
// 0 = выключить. CONFIG_FILE кейсуется по PORT — у нас 3 экземпляра прокси на
// одном скрипте (:20133 agentrouter, :20155 tabi, :20156 gorouter).
const CONFIG_FILE = process.env.CONFIG_FILE
  || path.join(__dirname, `keepalive-config-${Number(process.env.PORT || 8787)}.json`);
const cfg = {
  hedgeMs: Number(process.env.HEDGE_MS || 20000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS || process.env.MAX_RETRIES || 3),
};

// Числовая ручка из патча: мусор игнорируем, дурь зажимаем (иначе опечатка
// hedgeMs:5 устроит шлюзу лавину дублей).
function patchNum(v, min, max, allowZero) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (allowZero && n === 0) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function loadConfig() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (e) { return; }
  let c;
  try { c = JSON.parse(raw); } catch (e) { log(`config.json битый, игнорирую: ${e.message}`); return; }
  const h = patchNum(c.hedgeMs, 1000, 120000, true);
  if (h !== null) cfg.hedgeMs = h;
  const a = patchNum(c.maxAttempts, 1, 10, false);
  if (a !== null) cfg.maxAttempts = a;
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) { log(`config save error: ${e.message}`); }
}
function applyPatch(p) {
  if ('hedgeMs' in p) {
    const h = patchNum(p.hedgeMs, 1000, 120000, true);
    if (h !== null) cfg.hedgeMs = h;
  }
  if ('maxAttempts' in p) {
    const a = patchNum(p.maxAttempts, 1, 10, false);
    if (a !== null) cfg.maxAttempts = a;
  }
  saveConfig();
  log(`config updated: хедж ${cfg.hedgeMs ? `${cfg.hedgeMs}ms` : 'off'}, попыток на запрос ${cfg.maxAttempts}`);
}
function publicState() {
  return { cfg: Object.assign({}, cfg), upstream: UPSTREAM, port: PORT, idle_ms: IDLE_MS, stats: Object.assign({}, stats) };
}
// Счётчики «с момента старта процесса»: показываются в дашборде на вкладке
// AgentRouter в том же блоке, что и крутилки хеджа.
const stats = { requests: 0, remaps: 0, keepalives: 0, hedges: 0, errors: 0 };
// Служебные пути: статус (health-check дашборда), состояние и патч конфига.
function handleControl(req, res, reqPath) {
  if (req.method === 'GET' && reqPath === '/__keepalive/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, port: PORT, upstream: UPSTREAM, idle_ms: IDLE_MS, retries: cfg.maxAttempts, hedge_ms: cfg.hedgeMs }));
    return;
  }
  if (req.method === 'GET' && reqPath === '/__state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(publicState()));
    return;
  }
  if (req.method === 'POST' && reqPath === '/__config') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        applyPatch(patch);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(publicState()));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    req.on('error', () => {});
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
}

function shouldRetryStatus(status) {
  return status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599);
}

const RETRY_NO = /invalid|authentication|api[ _-]?key|expired|billing|quota|permission|denied|bad request|bad gateway upstream/i;
// Постоянные ошибки New API на китайском (не ретраить): нет прав, неверный/
// просроченный токен, нет средств/квоты, модель/канал не существует.
const RETRY_NO_ZH = /无权|权限|无效|过期|余额|额度|欠费|不存在|认证|封禁|禁用/;
const RETRY_OK = /unauthorized client detected|overloaded|too many|rate limit|internal|upstream|temporar|busy|unavailable/i;

function isTransientBody(status, buf) {
  const s = buf.toString('utf8');
  if (!s.trim()) return true;
  if (RETRY_NO.test(s) || RETRY_NO_ZH.test(s)) return false;
  if (RETRY_OK.test(s)) return true;
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

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

// stream:true в теле POST /v1/messages или accept: text/event-stream?
// Только такие запросы кандидаты на ранний SSE.
function wantsStream(method, reqPath, headers, body) {
  if (method !== 'POST') return false;
  const p = reqPath.replace(/\?.*$/, '');
  if (p !== '/v1/messages') return false;
  if (/text\/event-stream/i.test(String((headers && headers.accept) || ''))) return true;
  try {
    return JSON.parse(body.toString('utf8') || '{}').stream === true;
  } catch (e) {
    return false;
  }
}

// Ремап маршрутизации для POST /v1/messages:
//   • claude-haiku/opus/sonnet с замапленным тиром в ar-modelmap.json →
//     переписываем модель на целевую; gpt-цель → gpt-прокси :20132,
//     claude-цель → agentrouter как есть (pass-through);
//   • claude-haiku* без маппинга в файле → fallback env HAIKU_TO_MODEL (gpt);
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

  // Маппинг из ar-modelmap.json (вкладка AgentRouter) — приоритетнее env.
  const tm = tierTargetFor(model);
  if (tm && tm.target && tm.target !== model) {
    const target = tm.target;
    if (isGptLike(target)) {
      newBody = Buffer.from(JSON.stringify(Object.assign({}, j, { model: target })), 'utf8');
      label = `${tm.tier}→${target} (map, gpt)`;
      log(`${method} ${reqPath} ${label} via ${HAIKU_GPT_PROXY}`);
      return { body: newBody, requester: gptRequester, hostname: gptProxy.hostname, port: gptProxy.port || 80, base: gptBase, host: gptProxy.host };
    }
    newBody = Buffer.from(JSON.stringify(Object.assign({}, j, { model: target })), 'utf8');
    label = `${tm.tier}→${target} (map, claude)`;
    log(`${method} ${reqPath} ${label} via ${upstream.host}`);
    return { body: newBody, requester: upRequester, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), base: upBase, host: upstream.host };
  }

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
  let sseTimer = null;
  let keepalives = 0;
  let aborted = false;
  let clientSSE = false;          // мы уже открыли SSE-ответ клиенту (ранний SSE)
  let tail = Buffer.alloc(0);     // последние ≤4 байта отправленного клиенту (для формата keepalive)
  let activeSet = new Set();      // все живые попытки (ретраи + хедж-дубли)
  let winner = null;              // победитель гонки
  let finished = false;           // исход решён (победитель или сдались)
  let launched = 0;               // сколько попыток/дублей уже запущено
  let hedgeTimer = null;          // таймер хедж-дубля
  let reqBody = Buffer.alloc(0);  // тело запроса (после ремапа)
  let tgt = null;                 // результат remapHaiku
  let streaming = false;          // стримовый запрос (ранний SSE + identity)

  // Служебные пути: статус (health-check дашборда), состояние, runtime-конфиг.
  if (req.url.startsWith('/__')) {
    handleControl(req, res, req.url);
    return;
  }

  log(`>> ${req.method} ${reqPath} start`);
  stats.requests += 1;

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
      stats.keepalives += 1;
      log(`${req.method} ${reqPath} keepalive #${keepalives}`);
    } else if (t.endsWith('\n')) {
      res.write(KEEPALIVE_COMMENT);
      tail = Buffer.concat([tail, Buffer.from(KEEPALIVE_COMMENT)]).slice(-4);
      keepalives += 1;
      stats.keepalives += 1;
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
    // Апстрим отдаёт не-stream JSON как text/plain; CC v2 SDK требует
    // application/json для парсинга — переписываем content-type для /v1/messages.
    let hdrs = headers;
    if (!isSSE && /\/v1\/messages/.test(reqPath)) {
      const ct = String(headers['content-type'] || '');
      if (/^text\/plain/i.test(ct)) {
        hdrs = Object.assign({}, headers, { 'content-type': ct.replace(/^text\/plain/i, 'application/json') });
      }
    }
    res.writeHead(status, hdrs);

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

  const settle = (r) => {
    winner = r;
    finished = true;
    for (const x of activeSet) {
      if (x !== r && !x.destroyed) {
        try { x.destroy(); } catch (e) {}
      }
    }
    // Победитель остаётся в activeSet: на обрыв клиента его тоже надо рвать.
    activeSet.clear();
    if (!r.destroyed) activeSet.add(r);
    log(`${req.method} ${reqPath} winner settled`);
  };
  const giveUp = (why) => {
    finished = true;
    stats.errors += 1;
    for (const x of activeSet) {
      if (!x.destroyed) { try { x.destroy(); } catch (e) {} }
    }
    activeSet.clear();
    log(`${req.method} ${reqPath} все попытки исчерпаны: ${why}`);
    if (clientSSE) {
      inbandError(502, Buffer.from(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `upstream: ${why}` } })));
    } else if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `upstream: ${why}` } }));
    } else if (!res.writableEnded) {
      res.destroy();
    }
  };
  const attemptDone = (r, why, delayMs) => {
    activeSet.delete(r);
    if (finished || aborted) return;
    if (launched < cfg.maxAttempts) {
      log(`${req.method} ${reqPath} -> ретрай/дубль #${launched + 1} через ${delayMs}ms (${why})`);
      setTimeout(() => { if (!aborted && !finished) makeUpstream(); }, delayMs);
      return;
    }
    if (activeSet.size === 0) giveUp(why);
  };

  // Хедж-дубль: если через cfg.hedgeMs апстрим всё ещё молчит (нет даже заголовков),
  // запускаем ПАРАЛЛЕЛЬНУЮ попытку. Победит тот, кто ответит первым — остальных рвём.
  const scheduleHedge = () => {
    if (cfg.hedgeMs <= 0 || finished || aborted || hedgeTimer !== null) return;
    if (launched >= cfg.maxAttempts) return;
    hedgeTimer = setTimeout(() => {
      hedgeTimer = null;
      if (finished || aborted) return;
      log(`${req.method} ${reqPath} хедж: тишина ${Date.now() - started}ms, пускаю дубль #${launched + 1}`);
      stats.hedges += 1;
      makeUpstream();
      scheduleHedge();
    }, cfg.hedgeMs);
  };

  const makeUpstream = () => {
    if (finished || aborted) return;
    if (launched >= cfg.maxAttempts) {
      if (activeSet.size === 0) giveUp('попытки исчерпаны');
      return;
    }
    launched += 1;
    const attempt = launched;
    const body = reqBody;
    const t = tgt || { requester: upRequester, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), base: upBase, host: upstream.host };
    const headers = Object.assign({}, req.headers, { host: t.host });
    // Активный ключ agentrouter из ar-active-key.txt (смена на лету): перекрываем
    // клиентский AUTH_TOKEN-заглушку реальным ключом из файла.
    try {
      const arKey = fs.readFileSync(AR_ACTIVE_KEY_FILE, 'utf8').trim();
      if (arKey) {
        headers.authorization = `Bearer ${arKey}`;
        headers['x-api-key'] = arKey;
      }
    } catch {}
    // Ремап мог заменить body (haiku→gpt, срезание суффикса) — content-length от клиента
    // больше не соответствует длине тела, Node отправит заголовок со старой длиной и
    // сервер будет ждать недостающие байты (запрос висит). Пересчитываем сами.
    if (tgt) {
      headers['content-length'] = Buffer.byteLength(body);
    }
    // Стримовые запросы: просим НЕ кодировать (иначе gzip-мусор в SSE-канале после
    // раннего SSE/хеджа ломает поток). v1tusha: accept-encoding identity.
    if (streaming) {
      headers['accept-encoding'] = 'identity';
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
      const isSSE = /text\/event-stream/i.test(String(headers['content-type'] || ''));
      const jsonLike = !isSSE && /application\/json|text\/plain/i.test(String(headers['content-type'] || ''));
      const hasEnc = /gzip|deflate|br/i.test(String(headers['content-encoding'] || ''));
      const chunks = [];
      let size = 0;
      const drain = (onEnd) => {
        upRes.on('data', (c) => { chunks.push(c); size += c.length; });
        upRes.on('end', onEnd);
        upRes.on('error', () => onEnd());
      };
      const forwardBuffered = (buf, hdrs) => {
        const pt = new PassThrough();
        pt.end(buf);
        settle(upReq);
        forward(status, hdrs, pt);
      };

      // 200 на не-stream /v1/messages: апстрим отдаёт JSON как text/plain, иногда
      // пустое тело (после долгого thinking). Драним всегда — тело маленькое, зато
      // пустоту/валидность ловим до проброса клиенту.
      if (status === 200 && jsonLike && !hasEnc) {
        drain(() => {
          if (finished || aborted) return;
          const buf = Buffer.concat(chunks, size);
          const text = buf.toString('utf8').trim();
          if (!text) {
            attemptDone(upReq, `пустой 200 (попытка ${attempt})`, RETRY_DELAY_MS * attempt);
            return;
          }
          forwardBuffered(buf, headers);
        });
        return;
      }

      if (shouldRetryStatus(status)) {
        drain(() => {
          if (finished || aborted) return;
          const buf = Buffer.concat(chunks, size);
          if (isTransientBody(status, buf)) {
            attemptDone(upReq, `${status}: ${buf.toString('utf8').slice(0, 100)}`, RETRY_DELAY_MS * attempt);
          } else {
            forwardBuffered(buf, headers);
          }
        });
        return;
      }

      settle(upReq);
      forward(status, headers, upRes);
    });

    activeSet.add(upReq);
    upReq.on('timeout', () => {
      if (finished || aborted) return;
      log(`${req.method} ${reqPath} upstream timeout ${UPSTREAM_TIMEOUT_MS}ms (attempt ${attempt})`);
      upReq.destroy(new Error('upstream timeout'));
    });
    upReq.on('error', (err) => {
      if (finished || aborted || res.destroyed) { activeSet.delete(upReq); return; }
      log(`${req.method} ${reqPath} upstream error (attempt ${attempt}): ${err.message}`);
      attemptDone(upReq, err.message, 0);
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
    reqBody = remapped ? remapped.body : rawBody;
    tgt = remapped;
    if (remapped) stats.remaps += 1;
    streaming = wantsStream(req.method, reqPath, req.headers, reqBody);
    // ФИКС 2 — ранний SSE: открываем клиенту поток и keepalive ещё ДО upstream.
    if (EARLY_SSE && streaming) {
      startClientSSE();
    }
    makeUpstream();
    scheduleHedge();
  });

  req.on('error', () => { aborted = true; stopTimer(); for (const x of activeSet) { try { x.destroy(); } catch (e) {} } activeSet.clear(); if (hedgeTimer !== null) { clearTimeout(hedgeTimer); hedgeTimer = null; } });
  res.on('error', () => { aborted = true; stopTimer(); for (const x of activeSet) { try { x.destroy(); } catch (e) {} } activeSet.clear(); if (hedgeTimer !== null) { clearTimeout(hedgeTimer); hedgeTimer = null; } });
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      stopTimer();
      for (const x of activeSet) { try { x.destroy(); } catch (e) {} }
      activeSet.clear();
      if (hedgeTimer !== null) { clearTimeout(hedgeTimer); hedgeTimer = null; }
    }
  });
  req.on('close', () => {
    if (!req.complete) {
      aborted = true;
      stopTimer();
      for (const x of activeSet) { try { x.destroy(); } catch (e) {} }
      activeSet.clear();
      if (hedgeTimer !== null) { clearTimeout(hedgeTimer); hedgeTimer = null; }
    }
  });
});

loadConfig();

server.keepAliveTimeout = 0;   // не убивать долгие SSE-соединения (v1tusha)
server.headersTimeout = 0;
server.setTimeout(0);
server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) { if (!socket.destroyed) socket.destroy(); return; }
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM} (idle ${IDLE_MS}ms, попыток ${cfg.maxAttempts} x ${RETRY_DELAY_MS}ms, хедж ${cfg.hedgeMs ? cfg.hedgeMs + 'ms' : 'off'}, early_sse ${EARLY_SSE ? 'on' : 'off'}, upstream_timeout ${UPSTREAM_TIMEOUT_MS}ms)`);
});
