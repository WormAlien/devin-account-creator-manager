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
 *   2. Пре-коммит (PRE_COMMIT_MS): для POST /v1/messages со stream:true через
 *      cfg.preCommitMs тишины открываем SSE-ответ клиенту И держим поток
 *      keepalive'ами, ретраи идут за кулисами. Друг измерил: клиент сдаётся сам,
 *      получив 0 байт за ~18с, поэтому дефолт 10с — с запасом до дедлайна.
 *      Финальные ошибки уходят in-band как `event: error`.
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
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1500);
const COUNT_TOKENS_FALLBACK = process.env.COUNT_TOKENS_FALLBACK !== '0';
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

// Заголовки, по которым WAF agentrouter узнаёт Claude Code. Ставим только те,
// которых нет в запросе клиента (см. makeUpstream). Копия CC_HEADERS из
// agentrouter-proxy.js — при обновлении версии CLI менять в обоих местах.
const CC_FALLBACK_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
};

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

// ── Имя модели в ОТВЕТЕ: возвращаем клиенту то, что он просил ──
// Шлюзы (gorouter/agentrouter) отдают в ответе своё внутреннее имя модели,
// например `anthropic/claude-opus-5-ps-aws-dst` вместо `claude-opus-5`. Claude Code
// берёт его из ответа и показывает в статусбаре, дописывая наш суффикс окна:
// `gorouter/anthropic/claude-opus-5-ps-aws-dst[1m]`. Мало того что это мусор в баре —
// по такому имени не понять, какое окно реально активно, и юзер лезет набирать
// /model руками, теряя суффикс [1m] и получая 200k вместо 1M.
// Поэтому подменяем имя обратно на запрошенное клиентом.
// Работает и для ремапа тиров: haiku-вызов сабагента вернётся как haiku, а не как
// целевая модель — CC ожидает ровно то, что отправлял.
// MODEL_ECHO=0 выключает (для отладки: увидеть реальное имя модели у шлюза).
const MODEL_ECHO = process.env.MODEL_ECHO !== '0';
const MODEL_FIELD_RE = /"model"\s*:\s*"(?:[^"\\]|\\.)*"/;
// Сжатый ответ апстрима. zstd обязателен в списке: свежий Claude Code шлёт
// `accept-encoding: zstd`, шлюз отвечает zstd — а тело мы для MODEL_ECHO прогоняли
// через toString('utf8'), где каждый невалидный UTF-8 байт становится U+FFFD.
// Клиент получал битые байты с `content-encoding: zstd` и падал в
// ZstdDecompressionError на /model. Сжатые тела не трогаем вообще.
const RESP_COMPRESSED_RE = /\b(?:gzip|deflate|br|zstd|compress)\b/i;
function isCompressedBody(headers) {
    const enc = String((headers && headers['content-encoding']) || '').trim();
    return enc !== '' && !/^identity$/i.test(enc);
}
function rewriteModelJson(text, clientModel) {
    if (!MODEL_ECHO || !clientModel) return text;
    if (!MODEL_FIELD_RE.test(text)) return text;
    return text.replace(MODEL_FIELD_RE, `"model":${JSON.stringify(clientModel)}`);
}

const upstream = new URL(UPSTREAM);
const upRequester = upstream.protocol === 'https:' ? https.request : http.request;
const upBase = upstream.pathname.replace(/\/+$/, '');
const gptProxy = new URL(HAIKU_GPT_PROXY);
const gptRequester = gptProxy.protocol === 'https:' ? https.request : http.request;
const gptBase = gptProxy.pathname.replace(/\/+$/, '');
// Конвертер :20132 — агентроутеровский: он ходит на agentrouter.org и берёт ключ из
// ar-active-key.txt. Уводить туда gpt-запросы инстанса, который смотрит на ДРУГОЙ шлюз
// (tabi :20155 / gorouter :20156), значит молча тратить баланс AgentRouter чужим ключом
// и ловить его content-filter вместо своего шлюза. Поэтому конвертер включён только для
// инстанса с UPSTREAM=agentrouter.org; принудительно — GPT_PROXY_FORCE=1.
// `let`, а не `const`, чтобы selftest мог проверить обе ветки роутинга.
let GPT_PROXY_ENABLED = !!HAIKU_GPT_PROXY
  && (process.env.GPT_PROXY_FORCE === '1' || /(^|\.)agentrouter\.org$/i.test(upstream.hostname));
// Настоящее SSE-событие на границе событий: watchdog клиента считает только
// реальные события (замер v1tusha), комментарий его НЕ сбрасывает.
const PING = 'event: ping\ndata: {"type":"ping"}\n\n';
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
  preCommitMs: Number(process.env.PRE_COMMIT_MS || 10000),
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
  const p = patchNum(c.preCommitMs, 2000, 120000, true);
  if (p !== null) cfg.preCommitMs = p;
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
  if ('preCommitMs' in p) {
    const pc = patchNum(p.preCommitMs, 2000, 120000, true);
    if (pc !== null) cfg.preCommitMs = pc;
  }
  saveConfig();
  log(`config updated: хедж ${cfg.hedgeMs ? `${cfg.hedgeMs}ms` : 'off'}, попыток на запрос ${cfg.maxAttempts}, пре-коммит ${cfg.preCommitMs ? `${cfg.preCommitMs}ms` : 'off'}`);
}
function publicState() {
  return { cfg: Object.assign({}, cfg), upstream: UPSTREAM, port: PORT, idle_ms: IDLE_MS, uptime_ms: Date.now() - startedAt, stats: Object.assign({}, stats) };
}
// Счётчики «с момента старта процесса»: показываются в дашборде на вкладке
// AgentRouter в том же блоке, что и крутилки хеджа. retries — всего повторов,
// byStatus/byModel — распределение финальных ответов для отладки.
const stats = { requests: 0, remaps: 0, keepalives: 0, hedges: 0, errors: 0, retries: 0, byStatus: {}, byModel: {} };
const startedAt = Date.now();
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

const RETRY_NO = /invalid|authentication|api[ _-]?key|expired|billing|quota|permission|denied|bad request|missing|required|incorrect|not supported|bad gateway upstream/i;
// Отклонение контента шлюзом — ДЕТЕРМИНИРОВАННОЕ: тот же body даёт тот же ответ,
// ретрай только жжёт запросы (проверено 2026-08-16: фраза из блок-листа → 500
// "sensitive words detected" стабильно 12/12). Без этого правила такая ошибка
// проваливалась в fallback `status >= 500` и уходила наверх maxAttempts раз.
// Нейтрализация самих фраз — в agentrouter-proxy.js (WAF_PHRASES).
const RETRY_NO_CONTENT = /sensitive words|content-blocked/i;
// Постоянные ошибки New API на китайском (не ретраить): нет прав, неверный/
// просроченный токен, нет средств/квоты, модель/канал не существует.
const RETRY_NO_ZH = /无权|权限|无效|过期|余额|额度|欠费|不存在|认证|封禁|禁用/;
const RETRY_OK = /unauthorized client detected|overloaded|too many|rate limit|internal|upstream|temporar|busy|unavailable/i;

function isTransientBody(status, buf) {
  const s = buf.toString('utf8');
  if (!s.trim()) return true;
  if (RETRY_NO.test(s) || RETRY_NO_ZH.test(s) || RETRY_NO_CONTENT.test(s)) return false;
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
// HAIKU_REMAP=0 выключает ТОЛЬКО маппинг тиров (haiku и ar-modelmap.json). Роутинг
// gpt-моделей на конвертер :20132 под флаг не попадает: у agentrouter gpt живёт лишь
// на OpenAI-эндпоинте, и «выключенный ремап» означал бы gpt голым в /v1/messages —
// т.е. ровно ту поломку, ради которой конвертер и написан.
// Возвращает { body, requester, hostname, port, base, host } или null.
function remapHaiku(method, reqPath, body) {
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
  // gpt-модели уходят на конвертер всегда — до и независимо от маппинга тиров.
  // Но только если конвертер наш (см. GPT_PROXY_ENABLED): на tabi/gorouter gpt остаётся
  // на своём шлюзе, иначе запрос уходит чужим ключом на agentrouter.
  if (isGptLike(model)) {
    if (!GPT_PROXY_ENABLED) return null;
    log(`${method} ${reqPath} ${model} via ${HAIKU_GPT_PROXY}`);
    return { body, requester: gptRequester, hostname: gptProxy.hostname, port: gptProxy.port || 80, base: gptBase, host: gptProxy.host };
  }
  if (!HAIKU_REMAP) return null;
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
      // Конвертера нет (не агентроутеровский инстанс) — маппинг уважаем, но модель
      // отдаём своему же шлюзу, а не чужому конвертеру.
      if (!GPT_PROXY_ENABLED) {
        label = `${tm.tier}→${target} (map, gpt, без конвертера)`;
        log(`${method} ${reqPath} ${label} via ${upstream.host}`);
        return { body: newBody, requester: upRequester, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), base: upBase, host: upstream.host };
      }
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
    // Fallback-цель HAIKU_TO_MODEL — gpt-модель, а значит нужна через конвертер.
    // Без конвертера рвать haiku некуда: отдаём как есть.
    if (!GPT_PROXY_ENABLED) return null;
    newBody = Buffer.from(JSON.stringify(Object.assign({}, j, { model: HAIKU_TO_MODEL })), 'utf8');
    label = `haiku→${HAIKU_TO_MODEL}`;
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
  let preTimer = null;            // таймер отложенного пре-коммита (preCommitMs)
  let reqBody = Buffer.alloc(0);  // тело запроса (после ремапа)
  let tgt = null;                 // результат remapHaiku
  let streaming = false;          // стримовый запрос (ранний SSE + identity)
  let clientModel = '';           // модель, которую просил КЛИЕНТ (до ремапа) — см. rewriteModelJson
  let modelEchoDone = false;      // имя модели в ответе уже подменено (message_start)

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
    if (preTimer !== null) {
      clearTimeout(preTimer);
      preTimer = null;
    }
  };

  // keepalive-тик на уровне запроса — работает и ДО прихода заголовков upstream,
  // и во время retry-пауз (в этом всё лечение TTFB/retry-дыр).
  const tick = () => {
    sseTimer = null;
    if (aborted || res.writableEnded) return;
    // model-echo придерживает начало потока до границы события (`\n\n`). Если пауза
    // случилась ПОСРЕДИ первого события, придержанное обязано уйти клиенту раньше
    // keepalive-вставки: иначе `tail` не знает о недописанном `data:`, тик считает
    // поток стоящим на границе и вставляет полное `event: ping` внутрь чужого
    // события (test-hedge F). Ждать границу дольше паузы всё равно нельзя — ради
    // косметики имени модели рвать поток нельзя, поэтому здесь эхо сдаётся.
    const heldEcho = flushSseEcho();
    if (heldEcho) { res.write(heldEcho); noteBytes(heldEcho); }
    const t = tail.toString('utf8');
    if (t.length === 0 || t.endsWith('\n\n')) {
      res.write(PING);
      tail = Buffer.concat([tail, Buffer.from(PING)]).slice(-4);
      keepalives += 1;
      stats.keepalives += 1;
      log(`${req.method} ${reqPath} keepalive ping #${keepalives}`);
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

  // Отложенный пре-коммит (v1tusha): если через cfg.preCommitMs тишины апстрим
  // так и не прислал заголовки, открываем клиенту SSE-ответ и держим keepalive,
  // пока ретраи добиваются upstream. Если апстрим ответил раньше — коммит не нужен.
  const commitSSE = () => {
    preTimer = null;
    if (aborted || res.writableEnded || res.headersSent) return;
    clientSSE = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    });
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    armTimer();
    log(`${req.method} ${reqPath} пре-коммит SSE (${cfg.preCommitMs}ms тишины)`);
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

  // Подмена имени модели в SSE-потоке. Имя приходит один раз, в message_start —
  // первом событии. Чтобы не напороться на разрыв события между TCP-чанками,
  // придерживаем начало потока до границы события (`\n\n`), патчим ТОЛЬКО этот
  // префикс, а хвост чанка отдаём сырыми байтами и дальше не вмешиваемся вообще.
  // Важно резать по границе, а не гонять весь буфер через toString/Buffer.from:
  // многобайтный UTF-8 (кириллица) может быть разорван на стыке чанков, и
  // round-trip через строку испортил бы символ.
  const ECHO_MAX_HOLD = 65536;   // страховка: не придерживать поток бесконечно
  let echoBuf = null;
  const patchSseChunk = (chunk) => {
    if (!MODEL_ECHO || modelEchoDone || !clientModel) return chunk;
    echoBuf = echoBuf ? Buffer.concat([echoBuf, chunk]) : chunk;
    const boundary = echoBuf.indexOf('\n\n');
    if (boundary < 0) {
      // границы события всё ещё нет — ждём, но не дольше ECHO_MAX_HOLD
      if (echoBuf.length < ECHO_MAX_HOLD) return null;
      modelEchoDone = true;
      const raw = echoBuf; echoBuf = null;
      log(`${req.method} ${reqPath} model-echo: границы события нет в ${ECHO_MAX_HOLD}Б — отдаю как есть`);
      return raw;
    }
    modelEchoDone = true;
    const head = echoBuf.subarray(0, boundary + 2);
    const tailRaw = echoBuf.subarray(boundary + 2);
    echoBuf = null;
    const patched = Buffer.from(rewriteModelJson(head.toString('utf8'), clientModel), 'utf8');
    return tailRaw.length ? Buffer.concat([patched, tailRaw]) : patched;
  };
  // Поток кончился, границы события так и не было — отдаём придержанное как есть.
  const flushSseEcho = () => {
    if (!echoBuf) return null;
    modelEchoDone = true;
    const raw = echoBuf; echoBuf = null;
    return raw;
  };

  const forward = (status, headers, stream) => {
    const isSSE = /text\/event-stream/i.test(String(headers['content-type'] || ''));
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    try {
      const m = JSON.parse((reqBody || Buffer.alloc(0)).toString('utf8')).model;
      if (typeof m === 'string') stats.byModel[m] = (stats.byModel[m] || 0) + 1;
    } catch (e) {}
    log(`${req.method} ${reqPath} -> ${status}${isSSE ? ' (SSE)' : ''} ${Date.now() - started}ms`);

    // Клиенту уже отправлены заголовки (пре-коммит) — writeHead больше нельзя.
    if (clientSSE) {
      // Апстрим сжал ответ (игнорируя accept-encoding: identity) — сырые gzip-байты
      // в SSE-канале = мусор. Отдаём честную in-band ошибку (v1tusha).
      const enc = String(headers['content-encoding'] || '').toLowerCase();
      const compressed = enc !== '' && enc !== 'identity';
      // 2xx, но НЕ event-stream (апстрим отдал JSON/пустое на stream:true) —
      // сырые байты в SSE-канале = "malformed response (HTTP 200)". Отдаём in-band.
      if (status >= 200 && status < 300 && isSSE && !compressed) {
        if (res.socket) res.socket.setNoDelay(true);
        stream.on('data', (chunk) => {
          const out = patchSseChunk(chunk);
          if (out === null) return;          // придержали до границы события
          res.write(out);
          noteBytes(out);
          armTimer();
        });
        stream.on('end', () => {
          const rest = flushSseEcho();
          if (rest) { res.write(rest); noteBytes(rest); }
          stopTimer();
          if (!res.writableEnded) res.end();
        });
        stream.on('error', (err) => {
          stopTimer();
          log(`${req.method} ${reqPath} upstream stream error: ${err.message}`);
          if (!res.writableEnded && !res.destroyed) res.destroy(err);
        });
      } else {
        // не-2xx после исчерпания ретраев / сжатый поток → in-band SSE-ошибка
        const ec = [];
        stream.on('data', (c) => ec.push(c));
        stream.on('end', () => {
          if (compressed) {
            inbandError(status, Buffer.from(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `шлюз сжал поток (${enc}) вопреки accept-encoding: identity` } })));
          } else {
            inbandError(status, Buffer.concat(ec));
          }
        });
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

    if (!isSSE) {
      // Не-stream ответ: тело целиком уже в буфере (forwardBuffered), можно
      // подменить имя модели и пересчитать content-length.
      const bufs = [];
      stream.on('data', (c) => bufs.push(c));
      stream.on('end', () => {
        if (res.writableEnded || res.destroyed) return;
        let body = Buffer.concat(bufs);
        // Сжатое тело (gzip/zstd/br) — только сквозняком: toString('utf8') по бинарю
        // подменяет невалидные байты на U+FFFD и клиент получает битый архив.
        if (MODEL_ECHO && clientModel && !isCompressedBody(hdrs) && /json/i.test(String(hdrs['content-type'] || ''))) {
          const patched = Buffer.from(rewriteModelJson(body.toString('utf8'), clientModel), 'utf8');
          if (patched.length !== body.length) hdrs = Object.assign({}, hdrs, { 'content-length': String(patched.length) });
          body = patched;
        }
        res.writeHead(status, hdrs);
        res.end(body);
      });
      stream.on('error', (err) => {
        log(`${req.method} ${reqPath} upstream stream error: ${err.message}`);
        if (!res.writableEnded && !res.destroyed) res.destroy(err);
      });
      return;
    }

    res.writeHead(status, hdrs);
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    armTimer();

    stream.on('data', (chunk) => {
      const out = patchSseChunk(chunk);
      if (out === null) return;            // придержали до границы события
      res.write(out);
      noteBytes(out);
      armTimer();
    });
    stream.on('end', () => {
      const rest = flushSseEcho();
      if (rest) { res.write(rest); noteBytes(rest); }
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
      stats.retries += 1;
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
    // WAF agentrouter пускает только запросы, похожие на Claude Code: смотрит на
    // user-agent (`claude-cli/…` → 200, `curl/8.0` → 401 "unauthorized client detected",
    // проверено 2026-08-16). Живой CC эти заголовки присылает сам, поэтому подставляем
    // ТОЛЬКО отсутствующие — свои значения клиента не перебиваем. Мирроринг CC_HEADERS
    // из agentrouter-proxy.js: там та же защита, но для gpt-конвертера.
    for (const [k, v] of Object.entries(CC_FALLBACK_HEADERS)) {
      if (!headers[k]) headers[k] = v;
    }
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
    // Просим апстрим НЕ кодировать ответ — и для стрима (gzip-мусор в SSE-канале
    // после раннего SSE/хеджа ломает поток, v1tusha), и для обычных запросов: тело
    // нужно читать как текст (MODEL_ECHO, проверка на пустой 200, isTransientBody).
    // Клиентский `accept-encoding: zstd` не пробрасываем: если шлюз всё же сожмёт,
    // тело уйдёт клиенту байт-в-байт (isCompressedBody), но уже без эха модели.
    headers['accept-encoding'] = 'identity';
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
      const hasEnc = RESP_COMPRESSED_RE.test(String(headers['content-encoding'] || ''));
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
    // Модель ДО ремапа — её ждёт клиент в ответе (см. rewriteModelJson).
    try { clientModel = String(JSON.parse(rawBody.toString('utf8') || '{}').model || ''); } catch (e) { clientModel = ''; }
    const remapped = remapHaiku(req.method, reqPath, rawBody);
    reqBody = remapped ? remapped.body : rawBody;
    tgt = remapped;
    if (remapped) stats.remaps += 1;
    streaming = wantsStream(req.method, reqPath, req.headers, reqBody);
    // Пре-коммит (v1tusha): открываем SSE клиенту только после cfg.preCommitMs
    // тишины от upstream, не сразу. 0 = отложенный пре-коммит выключен.
    if (streaming && cfg.preCommitMs > 0 && preTimer === null) {
      preTimer = setTimeout(commitSSE, cfg.preCommitMs);
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

// Самопроверка нетривиальной логики: `node keepalive-proxy.js selftest`.
// Адаптировано под наши сигнатуры (remapHaiku / wantsStream / isTransientBody).
// applyPatch пишет в CONFIG_FILE — запоминаем живой конфиг и возвращаем как было,
// иначе прогон затрёт настройку, выставленную через дашборд.
if (process.argv[2] === 'selftest') {
  const assert = require('assert');
  const parse = (b) => JSON.parse(b.toString('utf8'));
  let savedCfg = null;
  try { savedCfg = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (e) { /* файла нет */ }

  // ремап haiku: приоритет у ar-modelmap.json (правится на вкладке), env HAIKU_TO_MODEL —
  // только fallback для пустого тира. Ассерт читает живой файл, поэтому сверяемся с
  // ним, а не с env: иначе смена haiku-тира в дашборде «ломала» бы selftest.
  const mapHaiku = (readModelMap() || {}).haiku || '';
  // Ветку с конвертером проверяем при заведомо включённом гейте: у чужого шлюза
  // (tabi/gorouter) gpt-цель haiku намеренно не ремапится — это отдельный ассерт ниже.
  const haikuGate = GPT_PROXY_ENABLED;
  GPT_PROXY_ENABLED = true;
  const h = remapHaiku('POST', '/v1/messages', Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] })));
  GPT_PROXY_ENABLED = haikuGate;
  assert.ok(h, 'haiku должен ремапиться');
  assert.strictEqual(parse(h.body).model, mapHaiku || HAIKU_TO_MODEL, 'haiku -> тир из маппинга (или env-fallback)');
  // и уходит туда, куда указывает тип цели: gpt-цель → конвертер, claude-цель → agentrouter
  assert.strictEqual(
    h.host,
    isGptLike(mapHaiku || HAIKU_TO_MODEL) ? gptProxy.host : upstream.host,
    'haiku-цель роутится по своему типу');
  // ремап: не-маппленная модель (не haiku, не gpt, без суффикса) — passthrough (null)
  const o = Buffer.from(JSON.stringify({ model: 'custom-model-x' }));
  assert.strictEqual(remapHaiku('POST', '/v1/messages', o), null, 'не-маппленная модель без изменений');
  // ремап: не-JSON не трогаем (null)
  assert.strictEqual(remapHaiku('POST', '/v1/messages', Buffer.from('not json')), null, 'не-JSON без изменений');
  // ремап: не /v1/messages не трогаем
  assert.strictEqual(remapHaiku('POST', '/v1/count_tokens', o), null, 'не /v1/messages без изменений');
  // роутинг gpt: уходит на конвертер :20132, тело не переписывается.
  // Обе ветки гейта проверяем явно, чтобы прогон не зависел от UPSTREAM инстанса.
  const gptWas = GPT_PROXY_ENABLED;
  GPT_PROXY_ENABLED = true;
  const g = remapHaiku('POST', '/v1/messages?beta=true', Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [] })));
  assert.ok(g, 'gpt должен уходить на конвертер');
  assert.strictEqual(g.host, gptProxy.host, 'gpt -> gpt-прокси');
  assert.strictEqual(parse(g.body).model, 'gpt-5.6-sol', 'модель gpt не переписывается');
  // роутинг gpt не зависит от HAIKU_REMAP: флаг про маппинг тиров, а не про конвертер.
  // Само поведение при HAIKU_REMAP=0 в одном процессе не проверить (const), но
  // gpt-ветка стоит ДО этой проверки в remapHaiku — см. комментарий там.

  // ── чужой шлюз: конвертер :20132 агентроутеровский, туда нельзя уводить gpt
  // с инстанса tabi/gorouter (чужой ключ + чужой content-filter). GPT_PROXY_ENABLED=false
  // → gpt остаётся passthrough на своём upstream.
  GPT_PROXY_ENABLED = false;
  try {
    assert.strictEqual(
      remapHaiku('POST', '/v1/messages', Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [] }))),
      null, 'без своего конвертера gpt не уводится на :20132');
    const hb = remapHaiku('POST', '/v1/messages', Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5', messages: [] })));
    if (isGptLike(mapHaiku || '')) {
      assert.strictEqual(hb, null, 'gpt-цель haiku без конвертера не ремапится');
    } else if (mapHaiku) {
      // haiku замаплен на claude-цель — маппинг работает и без конвертера
      assert.strictEqual(hb && hb.host, upstream.host, 'claude-цель haiku идёт на свой шлюз');
    }
  } finally {
    GPT_PROXY_ENABLED = gptWas;
  }

  // ── имя модели в ответе: возвращаем клиенту то, что он просил ──
  // Шлюз отдаёт внутреннее имя (anthropic/…-ps-aws-dst) → в статусбаре мусор.
  assert.strictEqual(
    rewriteModelJson('{"type":"message","model":"anthropic/claude-opus-5-ps-aws-dst","role":"assistant"}', 'claude-opus-5'),
    '{"type":"message","model":"claude-opus-5","role":"assistant"}',
    'имя модели в ответе подменяется на запрошенное');
  // message_start в SSE — там же, где CC читает модель для бара
  assert.ok(
    rewriteModelJson('event: message_start\ndata: {"type":"message_start","message":{"id":"x","model":"anthropic/claude-opus-5-ps-aws-dst"}}\n\n', 'claude-opus-5[1m]')
      .includes('"model":"claude-opus-5[1m]"'),
    'подмена работает в message_start');
  // патчим ТОЛЬКО первое вхождение (имя модели), остальной JSON не трогаем
  assert.strictEqual(
    rewriteModelJson('{"model":"up","messages":[{"model":"nested"}]}', 'req'),
    '{"model":"req","messages":[{"model":"nested"}]}',
    'патчится только первое поле model');
  // пустой clientModel = не трогаем ничего
  assert.strictEqual(rewriteModelJson('{"model":"up"}', ''), '{"model":"up"}', 'без clientModel без изменений');
  // тело без поля model не ломается
  assert.strictEqual(rewriteModelJson('{"type":"ping"}', 'claude-opus-5'), '{"type":"ping"}', 'нет поля model — как есть');

  // классификатор: китайский «нет доступа» — постоянная ошибка, НЕ ретраить
  assert.strictEqual(
    isTransientBody(403, Buffer.from('{"error":{"message":"该令牌无权访问模型 claude-haiku-4-5"}}')),
    false, 'zh 无权访问 = постоянная');
  // классификатор: отклонение контента шлюзом детерминировано — НЕ ретраить
  assert.strictEqual(
    isTransientBody(500, Buffer.from('{"error":{"message":"sensitive words detected (request id: 2026)"}}')),
    false, 'sensitive words = постоянная, ретрай только жжёт запросы');
  assert.strictEqual(isTransientBody(400, Buffer.from('content-blocked')), false, 'content-blocked = постоянная');
  // классификатор: транзиентное всё ещё ретраим
  assert.strictEqual(isTransientBody(403, Buffer.from('unauthorized client detected')), true, 'транзиентное ретраим');
  assert.strictEqual(isTransientBody(429, Buffer.from('')), true, 'пустое тело ретраим');
  // классификатор: постоянные (в т.ч. новые из апдейта v1tusha)
  assert.strictEqual(isTransientBody(500, Buffer.from('missing required field')), false, 'missing required = постоянная');
  assert.strictEqual(isTransientBody(500, Buffer.from('model not supported')), false, 'not supported = постоянная');

  // publicState отдаёт апстрим и пре-коммит, без сюрпризов
  const pub = publicState();
  assert.strictEqual(pub.upstream, UPSTREAM, 'publicState отдаёт upstream');
  assert.strictEqual(typeof pub.uptime_ms, 'number', 'publicState отдаёт uptime_ms');

  // wantsStream: пре-коммит заголовков имеет смысл только для стримовых запросов
  assert.strictEqual(wantsStream('POST', '/v1/messages', {}, Buffer.from('{"model":"x","stream":true}')), true, 'stream:true = поток');
  assert.strictEqual(wantsStream('POST', '/v1/messages', {}, Buffer.from('{"model":"x"}')), false, 'без stream = не поток');
  assert.strictEqual(wantsStream('POST', '/v1/messages', { accept: 'text/event-stream' }, Buffer.alloc(0)), true, 'accept SSE = поток');
  assert.strictEqual(wantsStream('POST', '/v1/messages', {}, Buffer.from('not json')), false, 'не-JSON = не поток');
  assert.strictEqual(wantsStream('GET', '/v1/messages', {}, Buffer.alloc(0)), false, 'GET = не поток');

  // Ручки хеджа/пре-коммита на лету: применяются, мусор игнорируется, дурь зажимается.
  applyPatch({ hedgeMs: 7000, maxAttempts: 4, preCommitMs: 12000 });
  assert.strictEqual(cfg.hedgeMs, 7000, 'hedgeMs применился');
  assert.strictEqual(cfg.maxAttempts, 4, 'maxAttempts применился');
  assert.strictEqual(cfg.preCommitMs, 12000, 'preCommitMs применился');
  applyPatch({ hedgeMs: 5, maxAttempts: 999, preCommitMs: 999999 }); // опечатка -> зажимаем
  assert.strictEqual(cfg.hedgeMs, 1000, 'hedgeMs зажат по нижней границе');
  assert.strictEqual(cfg.maxAttempts, 10, 'maxAttempts зажат по верхней границе');
  assert.strictEqual(cfg.preCommitMs, 120000, 'preCommitMs зажат по верхней границе');
  applyPatch({ hedgeMs: 'нет' });
  assert.strictEqual(cfg.hedgeMs, 1000, 'мусор в hedgeMs игнорируется');
  applyPatch({ hedgeMs: 0 });
  assert.strictEqual(cfg.hedgeMs, 0, '0 выключает хедж');
  applyPatch({ preCommitMs: 0 });
  assert.strictEqual(cfg.preCommitMs, 0, '0 выключает пре-коммит');

  // ВОССТАНОВЛЕНИЕ — строго последним: любой applyPatch выше пишет в CONFIG_FILE,
  // и если восстановить раньше, прогон затрёт живую настройку дашборда.
  if (savedCfg === null) {
    try { fs.unlinkSync(CONFIG_FILE); } catch (e) { /* selftest создал config — уберём */ }
  } else {
    fs.writeFileSync(CONFIG_FILE, savedCfg); // вернули то, что было до прогона
  }

  console.log('selftest OK');
  process.exit(0);
}

loadConfig();

server.keepAliveTimeout = 0;   // не убивать долгие SSE-соединения (v1tusha)
server.headersTimeout = 0;
server.setTimeout(0);
server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) { if (!socket.destroyed) socket.destroy(); return; }
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM} (idle ${IDLE_MS}ms, попыток ${cfg.maxAttempts} x ${RETRY_DELAY_MS}ms, хедж ${cfg.hedgeMs ? cfg.hedgeMs + 'ms' : 'off'}, пре-коммит ${cfg.preCommitMs ? cfg.preCommitMs + 'ms' : 'off'}, upstream_timeout ${UPSTREAM_TIMEOUT_MS}ms)`);
  log(`gpt-конвертер: ${GPT_PROXY_ENABLED ? HAIKU_GPT_PROXY : 'off (чужой шлюз — gpt остаётся на ' + upstream.host + ')'}`);
});
