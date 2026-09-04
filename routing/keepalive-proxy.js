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
const net = require('net');
const path = require('path');
const { PassThrough } = require('stream');

const PORT = Number(process.env.PORT || 8787);
const UPSTREAM = process.env.UPSTREAM || 'https://agentrouter.org';
const IDLE_MS = Number(process.env.IDLE_MS || 5000);
// Файл лога ЭТОГО инстанса — всегда по порту. Это не косметика, а две разные поломки.
// 🪤 До 29.08 путь брался из `LOG_FILE`, и получалось ровно наоборот от задуманного:
//   1) кому переменную не передали — тот не писал НИКУДА. Дашборд поднимает keepalive
//      шлюзов (jw/go/tb/xp/sk/ts) с `stdio: 'ignore'` и без `LOG_FILE`, поэтому от них
//      оставалось только кольцо в памяти дашборда, которое сам же keepalive забивает
//      пингами за секунды (transparent-proxy.js § /api/logs) и которое умирает вместе с
//      рестартом — а рестарт это первое, что делают, когда шлюз залагал. То есть лога не
//      было именно там и тогда, где он нужен;
//   2) а кому передали — писали в ОДИН файл. `LOG_FILE` наследуется дочерними процессами
//      (childEnv отдаёт весь process.env), поэтому достаточно одного экспорта в оболочке,
//      из которой поднят дашборд, чтобы все инстансы слились в `keepalive-proxy.log` без
//      единой пометки, чей это шлюз. Так и вырос тот файл на 18 МБ, по которому «не
//      разбирается, какой провайдер» — замечено живьём 29.08.
// Поэтому `LOG_FILE` здесь сознательно НЕ участвует: имя считает сам процесс, который
// единственный точно знает свой порт. Явный override оставлен под отдельным именем,
// которое ничего не наследует случайно.
const IS_SELFTEST = process.argv[2] === 'selftest';
const LOG_FILE = process.env.KEEPALIVE_LOG_FILE
  || (IS_SELFTEST ? '' : path.join(__dirname, `keepalive-${PORT}.log`));
// Ротация: до этого лог не крутился вообще и дорос до 18 МБ. Порог и правило те же, что
// у lifecycle.rotateLog — переименовать в `.1`, глубина истории один файл.
const LOG_MAX = Number(process.env.LOG_MAX || 5 * 1024 * 1024);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1500);
// ── Удержание запроса при обрыве пути (2026-09-03) ───────────────────────────
// Сколько раз максимум переспросить шлюз за окно cfg.holdMs и с какими отступами.
// Потолок нужен ровно из-за плоского тарифа: kktoken игнорирует `max_tokens` и
// досчитывает брошенную генерацию до конца, выставляя полный счёт, — значит попытка,
// успевшая дойти до генерации, платная независимо от нас. Гейт по достижимости
// (probePath) убирает большинство таких попыток — в мёртвый путь мы не стреляем вовсе, —
// а потолок страхует от патологии вроде шлюза, который рвёт соединение на первом байте.
const HOLD_MAX_LAUNCHES = Number(process.env.HOLD_MAX_LAUNCHES || 6);
const HOLD_BACKOFF_MS = [2000, 4000, 8000, 10000];
const HOLD_PROBE_TIMEOUT_MS = Number(process.env.HOLD_PROBE_TIMEOUT_MS || 3000);
// Сколько раз переигрывать ПУСТОЙ поток (заголовки пришли, содержимого нет). Два —
// потому что это уже не «сеть мигнула», а поведение шлюза: третий заход в тот же
// молчащий шлюз только жжёт запрос.
const EMPTY_MAX_RETRIES = Number(process.env.EMPTY_MAX_RETRIES || 2);
const COUNT_TOKENS_FALLBACK = process.env.COUNT_TOKENS_FALLBACK !== '0';
// UPSTREAM_TIMEOUT_MS переехал в cfg (см. DEFAULT_CFG.upstreamTimeoutMs): он стал
// такой же крутилкой, как мульти-запрос и пре-коммит, и правится на живом процессе через
// POST /__config. Env-переменная с прежним именем по-прежнему работает — ею уже
// запускают процессы в bat/ps1 и в спавне дашборда.

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
        if (mm[tier] && re.test(String(model || ''))) {
            const target = mm[tier];
            // Карта — пожелание, каталог шлюза — факт. Если цели у шлюза нет, берём
            // живую замену: иначе запрос гарантированно умрёт на 503 model_not_found
            // (03.09: justwoker убрал claude-opus-4-8, и 255 запросов сабагентов легли).
            const alt = availableTarget(tier, target, model, mm);
            if (alt) return { tier, target: alt, from: target, substituted: true };
            return { tier, target };
        }
    }
    return null;
}
function isGptLike(model) {
    return /gpt|o[0-9]|davinci|chatgpt/i.test(String(model || ''));
}
// Какая модель реально лежит в теле запроса — нужно, чтобы сравнить «что послали» с
// «что получилось после подмены» и не повторять запрос той же самой моделью.
function modelInBody(buf) {
    try { return String(JSON.parse((buf || Buffer.alloc(0)).toString('utf8') || '{}').model || ''); } catch { return ''; }
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
// Пул исходящих коннектов. В глобальном агенте Node 24 keepAlive уже включён, но
// maxSockets = Infinity: мульти-дубль плюс ретраи давали пачку одновременных TLS-
// рукопожатий через туннель (happ-tun/sing-tun часть их роняет — в логе это выглядело
// как `Client network socket disconnected before secure TLS`). Явный лимит гасит эти
// кластеры обрывов и заодно переиспользует сокет: замер 20.08 — первое рукопожатие
// ~0.5с, дальше запросы идут за ~0.25с. 16 — с запасом на N агентов Orca на одном ключе.
const MAX_SOCKETS = Number(process.env.MAX_SOCKETS || 16);
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
const agentFor = requester => (requester === https.request ? httpsAgent : httpAgent);
// ── Трассировка исходящего соединения: почему первый запрос после простоя тормозит ──
// Симптом (28.08): после АФК активный шлюз «не раздупляет», и лечит только перезапуск
// процесса — значит портится состояние ЗДЕСЬ, а не у шлюза (Cloudflare и квота от
// рестарта не чинятся). Улика при этом живёт только до рестарта, а рестарт — первое,
// что делает человек. Поэтому пишем её в лог на каждом запросе, а не ловим живьём.
// Три причины разводятся тремя цифрами одной строки:
//   • `в очереди N` > 0 — сокеты выедены зависшими запросами: свободных нет, и новый
//     запрос ЖДЁТ в очереди агента, не отправив ещё ни байта. Единственная из трёх, что
//     объясняет, почему помогает только рестарт: он рвёт все сокеты разом.
//   • `сокет из пула` + огромный «первый байт» при пустых dns/tcp/tls — взяли соединение,
//     которое апстрим (или NAT/туннель) закрыл молча: пишем в мёртвую трубу и ждём до
//     upstreamTimeoutMs, а это 300с.
//   • большие `dns`/`tcp`/`tls` — тормозит сам канал, прокси не при чём.
const CONN_TRACE = process.env.CONN_TRACE !== '0';
// `agent.requests` — очередь запросов, которым не досталось сокета; `sockets` — занятые,
// `freeSockets` — живые простаивающие. Все три объекта вида {хост: [...]}, поэтому счёт
// идёт по длинам массивов, а не по числу ключей.
function poolSnapshot(requester) {
  const a = agentFor(requester || upRequester);
  const cnt = o => Object.values(o || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  return { active: cnt(a.sockets), free: cnt(a.freeSockets), queued: cnt(a.requests), max: MAX_SOCKETS };
}
// Простой считаем от ПРЕДЫДУЩЕЙ отправки, а не от времени ответа: интересен разрыв между
// обращениями, за который сокет успевает отмереть незамеченным.
let lastUpAt = 0;
function traceConn(upReq, requester) {
  const t0 = Date.now();
  const tr = {
    t0, idleMs: lastUpAt ? t0 - lastUpAt : -1, pool: poolSnapshot(requester),
    reused: null, socketMs: null, dnsMs: null, tcpMs: null, tlsMs: null,
  };
  lastUpAt = t0;
  upReq.on('socket', (s) => {
    tr.socketMs = Date.now() - t0;
    // Свежий сокет на момент события ещё соединяется, взятый из пула — уже нет.
    // `__kaSeen` — страховка: если Node изменит момент выдачи события, флаг переживёт.
    tr.reused = s.connecting === false && s.__kaSeen === true;
    s.__kaSeen = true;
    if (tr.reused) return;
    s.once('lookup', () => { tr.dnsMs = Date.now() - t0; });
    s.once('connect', () => { tr.tcpMs = Date.now() - t0; });
    s.once('secureConnect', () => { tr.tlsMs = Date.now() - t0; });
  });
  return tr;
}
function fmtConn(tr) {
  const p = tr.pool;
  const ms = v => (v === null ? '—' : `${v}мс`);
  const born = tr.reused === null
    ? 'сокета не дождался'
    : tr.reused
      ? 'сокет из пула'
      : `сокет новый (dns ${ms(tr.dnsMs)}, tcp ${ms(tr.tcpMs)}, tls ${ms(tr.tlsMs)})`;
  return `${p.queued > 0 ? '⚠ ' : ''}простой ${tr.idleMs < 0 ? '—' : Math.round(tr.idleMs / 1000) + 'с'}`
    + ` · ${born} за ${ms(tr.socketMs)}`
    + ` · пул ${p.active}/${p.max} занято, ${p.free} свободно, ${p.queued} в очереди`
    + ` · первый байт ${Date.now() - tr.t0}мс`;
}
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

// Крутим по размеру, а не по дате: инстансы живут от минут до недель, и «файл за сутки»
// у неактивного шлюза был бы пустым. Проверка не на каждой строке — statSync на каждый
// ping это лишний сисколл; раз в 2000 строк при пороге 5 МБ даёт перебег максимум на
// пару сотен килобайт. Первая же строка после старта попадает на проверку (счётчик с 0).
const LOG_KEEP = Number(process.env.LOG_KEEP || 5);
let logWrites = 0;
function rotateLogIfBig() {
  try {
    if (fs.statSync(LOG_FILE).size <= LOG_MAX) return;
  } catch (e) { return; }            // файла нет — первый запуск, крутить нечего
  // 🪤 Имя архива со ВРЕМЕНЕМ, а не один слот `.1`. Слот стоил живой истории 29.08:
  // проверка размера идёт на первой строке КАЖДОГО процесса, поэтому два коротких
  // запуска подряд дают две ротации — и вторая переименовывает поверх архива первой.
  // Так 18 МБ лога :20133 уехали в `.1`, а следующий инстанс затёр этот `.1` своими
  // двумя килобайтами. С временной меткой перезаписать чужой архив невозможно.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  try { fs.renameSync(LOG_FILE, `${LOG_FILE}.${stamp}`); } catch (e) { return; }
  // Оставляем последние LOG_KEEP архивов — иначе на долгоживущем прокси они копятся без
  // предела. Под нож идут только файлы, которые создала эта же ротация: узнаём их по
  // своему префиксу И по формату метки, чужого рядом не тронем.
  try {
    const dir = path.dirname(LOG_FILE);
    const base = path.basename(LOG_FILE) + '.';
    const olds = fs.readdirSync(dir)
      .filter(f => f.startsWith(base) && /\.\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(f))
      .sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - LOG_KEEP))) fs.unlinkSync(path.join(dir, f));
  } catch (e) { /* уборка не критична */ }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  if (LOG_FILE) {
    try {
      if ((logWrites++ % 2000) === 0) rotateLogIfBig();
      fs.appendFileSync(LOG_FILE, line);
    } catch (e) {
      /* ignore */
    }
  }
  logLine(msg);
}

// --- Runtime-конфиг мульти-запросынга (меняется на лету через POST /__config) ---
// Мульти-запрос: если шлюз молчит дольше cfg.hedgeMs, пускаем ПАРАЛЛЕЛЬНЫЙ дубль запроса и
// берём того, кто ответил первым, остальных рвём. Дефолты замерены на живом
// agentrouter (v1tusha, 15.08.2026): hedgeMs=5000 + 5 попыток дали ~3x нагрузку и
// рост ответов 8с → 15-30с; 20с/2 вернули 6.6–8.6с. А/Б 20.08 на медиане: 12с/3 и
// 20с/2 идут одинаково (20.4с против 19.3с — шум), но дублей на запрос ≈0.99 против
// ≈0.50. Дубль стоит НЕ денег (замер 21.08: убитый на 20-й секунде списал 0.3% цены
// полного запроса — биллинг идёт по факту завершения генерации), а полосы шлюза,
// пачек для WAF и TLS-рукопожатий через туннель. Отсюда дефолт **20с / 3 попытки /
// не больше 1 дубля / пре-коммит 10с**: дубль летит только на реально молчащем
// шлюзе и ровно один, а бюджет попыток остаётся на ретрай транзиентной 500.
// Менять — в дашборде (POST /__config, без рестарта), файл
// keepalive-config-<PORT>.json переживает рестарт и имеет приоритет над этими
// дефолтами. 0 = выключить.
// CONFIG_FILE кейсуется по PORT — у нас 6 экземпляров прокси на одном скрипте
// (:20133 agentrouter, :20155 tabi, :20156 gorouter, :20157 xpeach, :20158 justwoker,
// :20159 seekai).
const CONFIG_FILE = process.env.CONFIG_FILE
  || path.join(__dirname, `keepalive-config-${Number(process.env.PORT || 8787)}.json`);
// ЕДИНСТВЕННОЕ место, где живут обкатанные цифры. Дашборд не хранит их копию, а
// читает отсюда через /__state → `defaults`: плейсхолдеры инпутов и кнопка
// «Рекомендованные» берутся из этого объекта. Раньше цифры были и в коде, и в
// плейсхолдерах, и в keepalive-restart.ps1, и в спавне дашборда — и разъезжались.
// Замерено на agentrouter (см. routing/KEEPALIVE-TUNING.md):
//   hedgeMs 20000    — 75-й перцентиль ответа ≈20с, то есть дубль летит только в
//                      худшую четверть запросов; на 20с побеждают 67% дублей
//                      против 47% на 12с
//   maxHedges 1      — второй параллельный дубль скорости не добавлял, только полосы
//   maxAttempts 3    — 1 запрос + 1 мульти-запрос + 1 ретрай на транзиентную 500 (无可用渠道)
//   preCommitMs 10000 — шлюз молчит >10с на 46% запросов, а клиент при нуле байт
//                      сдаётся сам на ~18-20с; 10с оставляют запас на пинги
const DEFAULT_CFG = {
  hedgeMs: 20000,
  maxAttempts: 3,
  maxHedges: 1,
  preCommitMs: 10000,
  // Таймаут ПРОСТОЯ сокета на попытку. Был константой 600000 мимо конфига — и это
  // единственная ручка, которую нельзя было покрутить, не пересобрав процесс.
  //
  // Почему 600с плохо: это таймаут БЕЗДЕЙСТВИЯ, живой стрим его сбрасывает каждым
  // чанком, поэтому длинным ответам он не мешает вообще. Зато мёртвый запрос висел
  // десять минут на попытку, а при maxAttempts 3 — до получаса. Симптом наблюдался
  // живьём: `POST /v1/messages?beta=true justwoker: таймаут 600000мс` во
  // frontdoor-proxy.log (22.08), плюс max 325с в суточной истории латентности.
  //
  // Почему 300с, а не 150с и не 60с. Первая версия этой правки поставила 150с по
  // своему замеру (максимум наблюдённого молчания до первого события — 65.8с). Это
  // было МАЛО: хендофф автора апстрима (`docs/HANDOFF-upstream-keepalive.md` § 1.2)
  // приводит замеры на порядок шире — n=153: медиана 20.4с, p75 32.5с, худший ответ
  // 135.3с; n=376 в другом окне: худший **159.6с**. То есть 150с режет не аномалию, а
  // хвост нормального распределения, и каждый такой обрыв ещё и жжёт попытку.
  // Рекомендация того же документа — минимум 300с. Берём её: она стоит на 529
  // наблюдениях против моих двадцати.
  upstreamTimeoutMs: 300000,
  // Окно УДЕРЖАНИЯ запроса, пока лежит путь до шлюза. Считается отдельно от maxAttempts
  // намеренно: попытки измеряют, сколько раз мы спросили шлюз, а держать клиента надо
  // столько, сколько лежит СЕТЬ. Замер 03.09: три попытки с отступами 1500 и 3000 мс
  // исчерпываются за ~5 с, а переключение VPN на станции роняет путь на 5–30 с — то есть
  // попытки кончались раньше простоя, и запрос умирал в момент, когда чинить было ещё
  // нечего. Цена смерти несоразмерна: подагент Claude Code от одной ошибки API умирает
  // целиком, а ошибок за сутки 246 на 3376 запросов (7.3%) на justwoker и 47 на 1583 на
  // kktoken. 120с покрывают наблюдавшиеся простои с запасом. 0 = удержание выключено.
  // Разбор — вики, «Обрывы пути к шлюзам — план удержания запроса».
  holdMs: 120000,
  // Сколько ждать СОДЕРЖИМОГО после того, как поток уже открылся. Отдельная болезнь и
  // отдельная ручка: 03.09 в 21:13 kktoken принял запрос на 564k контекста, отдал
  // заголовки — и молчал **пять минут**, пока прокси честно кормил клиента пингами
  // (60 пингов, ноль байт содержимого), после чего оборвал соединение сам. Claude Code
  // увидел `Stream idle timeout - no chunks received`: пинги для него не содержимое.
  // Таких обрывов у kktoken за сутки 55.
  // 🪤 Наш собственный таймаут сокета (upstreamTimeoutMs) в этой сцене НЕ срабатывает:
  // после прихода заголовков стоит `finished`, а обработчик `timeout` под этим флагом
  // выходит молча — то есть молчащий поток жил бы неограниченно долго.
  // 180с выбраны с запасом над честным максимумом (по хендоффу автора апстрима худший
  // наблюдённый ответ 159.6с): живой медленный шлюз не обрываем, мёртвый не ждём вечно.
  // 0 = выключить.
  emptyStreamMs: 180000,
  // Как часто перечитывать каталог моделей шлюза — и он же выключатель подмены.
  // **0 = каталога нет вовсе**: маппинг работает строго по карте, ровно как до 04.09.
  // Ручка нужна не для тюнинга, а для отката: если шлюз в `/v1/models` СОВРЁТ (не покажет
  // модель, которую на самом деле отдаёт), подмена заменит рабочую цель на другую — и
  // выключить это надо будет на живом процессе, без рестарта.
  catalogTtlMs: 600000,
  // ── Удержание НЕ-стримового запроса (2026-09-04) ────────────────────────────
  // Пре-коммит и пинги применимы только к потоку: пинг это событие SSE, и в ответ,
  // который клиент ждёт обычным JSON, его не вставить — клиент попытается разобрать
  // `event: ping` как JSON и упадёт с мусором вместо таймаута. Поэтому не-стримовый
  // запрос до сих пор не получал НИ ОДНОГО байта, пока шлюз не закончит генерацию, а
  // Claude Code сдаётся на ~20 с тишины: так падал `/compact`
  // (`Stream idle timeout - no chunks received`). Замер 03.09: 216 не-стримовых
  // ответов за сутки, 78 из них дольше 20 с, максимум 245 с.
  // Лечение: через jsonHoldMs тишины открываем `200 application/json` чанками и капаем
  // ПРОБЕЛ каждые IDLE_MS. Ведущие пробелы — легальный JSON (RFC 8259 § 2), парсер
  // клиента их игнорирует, а байтовый таймер не срабатывает.
  // 🪤 Плата: после коммита 200 честный код ошибки уже не отдать — останется обрыв
  // соединения (его клиент читает как повторяемый). Поэтому порог не маленький: быстрые
  // отказы шлюза (400/403/model_not_found) приходят за секунды и до коммита не доживают,
  // то есть платим только за те запросы, которые и так уже долго считаются.
  // 0 = выключить, тогда поведение ровно прежнее.
  jsonHoldMs: 15000,
  // Поток ВСТАЛ посреди ответа: содержимое уже пошло, потом байты кончились и не
  // возобновились. Переиграть такое нельзя (клиенту ушла часть ответа), но и висеть
  // вечно нельзя — а именно вечно оно и висело: наш таймаут сокета после прихода
  // заголовков не работает (`if (finished || aborted) return` в обработчике timeout).
  // Для вызывающей стороны бесконечное ожидание хуже ошибки: сессия, ждущая подагента,
  // не узнаёт об этом никогда. Поэтому рвём и даём клиенту увидеть обрыв.
  // 180с — тот же запас, что у пустого потока: живой thinking такие паузы не делает.
  // 0 = выключить.
  stallMs: 180000,
};
// Шлюзы с ПЛОСКИМ тарифом за запрос — там мульти-запрос выключен из коробки.
// Замер 21.08: tabitoken списывает 50¢, gorouter 20¢ — одинаково за полный ответ на
// 2000 токенов, за крошечный на 16 токенов И за дубль, который мы порвали на 20-й
// секунде. То есть на них страховка от висяка покупается по полной цене запроса, а не
// за 0.3% как на agentrouter (тот считает по токенам и убитую генерацию не берёт).
// При 0.25 дубля на запрос это +25% к счёту за то, что ускорения не даёт.
// Пре-коммит и пинги остаются: они не стоят ничего и именно они держат клиента.
// xpeach здесь по аналогии (тот же форк New-API) — замерить не удалось, все три ключа
// отдают 403 «User has been banned». Заработает — замер повторить и решить по цифрам.
// justwoker (22.08) — тоже по аналогии и тоже не замерен: тот же форк New-API, у него
// вообще только opus-модели. 🪤 Ошибка тут не симметрична: не внести хост = дубли по
// полной цене запроса молча, внести зря = потеря страховки от висяка. Поэтому вносим
// до замера, а не после.
// seekai.cc (24.08) — ЗАМЕРЕН, и он плоский: два запроса по ~211 токенов
// (`claude-sonnet-5`, 205 in / 6 out) сняли 3.38¢ и 3.16¢ по
// `/dashboard/billing/usage`. Токенами такой ответ стоит доли цента, то есть шлюз
// берёт почти фиксированную ставку за вызов — мульти-запрос удвоил бы счёт без ускорения.
// true-sota.com (sub2api) добавлен 2026-08-25 по той же причине, но обоснование другое:
// тариф там ПОДПИСОЧНЫЙ (квота плана, а не токены), плюс шлюз приклеивает к каждому
// запросу свой префикс 4.1–6.9к токенов — дубль съедает окно плана целиком, а
// ускорения не даёт.
// kktoken.cc (2026-08-31) — тариф у него НЕ плоский (считает по токенам), но хост здесь
// намеренно: шлюз ИГНОРИРУЕТ `max_tokens`, поэтому брошенный на 20-й секунде дубль
// апстрим досчитывает до конца и выставляет нам полный счёт за ответ, который никто не
// увидел. То есть цена дубля та же, что у плоского тарифа, — хедж запрещаем
// (maxHedges: 0). Пре-коммит и пинги остаются, они бесплатны.
const FLAT_RATE_HOSTS = new Set(['tabitoken.com', 'gorouter.app', 'xpeach.codes', 'api.justwoker.icu', 'seekai.cc', 'true-sota.com', 'kktoken.cc']);
if (FLAT_RATE_HOSTS.has(upstream.hostname)) DEFAULT_CFG.maxHedges = 0;
// Мульти-запрос считается выключенным и при maxHedges=0, и при hedgeMs=0 — для логов и UI.
const hedgeOff = c => !(c.hedgeMs > 0 && c.maxHedges > 0);
const cfg = {
  hedgeMs: Number(process.env.HEDGE_MS || DEFAULT_CFG.hedgeMs),
  maxAttempts: Number(process.env.MAX_ATTEMPTS || process.env.MAX_RETRIES || DEFAULT_CFG.maxAttempts),
  // Сколько ПАРАЛЛЕЛЬНЫХ дублей максимум на один запрос. Раньше ограничения не было:
  // scheduleHedge перевзводил себя, и при maxAttempts=3 на молчащем шлюзе в воздухе
  // оказывалось три копии, а бюджет попыток был выеден мульти-запросами — на транзиентную 500
  // ретрая не оставалось. Счётчик отдельный именно поэтому. 0 = мульти-запрос выкл.
  maxHedges: Number(process.env.MAX_HEDGES || DEFAULT_CFG.maxHedges),
  preCommitMs: Number(process.env.PRE_COMMIT_MS || DEFAULT_CFG.preCommitMs),
  // Старое имя переменной сохранено: им уже запускают процессы в bat/ps1 и в спавне
  // дашборда, ломать совместимость ради красоты нельзя.
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || DEFAULT_CFG.upstreamTimeoutMs),
  holdMs: Number(process.env.HOLD_MS || DEFAULT_CFG.holdMs),
  emptyStreamMs: Number(process.env.EMPTY_STREAM_MS || DEFAULT_CFG.emptyStreamMs),
  catalogTtlMs: Number(process.env.CATALOG_TTL_MS || DEFAULT_CFG.catalogTtlMs),
  jsonHoldMs: Number(process.env.JSON_HOLD_MS || DEFAULT_CFG.jsonHoldMs),
  stallMs: Number(process.env.STALL_MS || DEFAULT_CFG.stallMs),
};

// Числовая ручка из патча: мусор игнорируем, дурь зажимаем (иначе опечатка
// hedgeMs:5 устроит шлюзу лавину дублей).
function patchNum(v, min, max, allowZero) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (allowZero && n === 0) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}
// Версия набора дефолтов. **Поднимать при каждой смене DEFAULT_CFG.** Конфиг с прошлой
// версией не читается вовсе: он архивируется рядом и переписывается новыми дефолтами.
// Иначе новая цифра не доедет до тех, кто однажды нажал «Применить» — json приоритетнее
// кода, и они навсегда останутся на настройках того дня. А это ровно те люди, которые
// потом жгут баланс дублями на плоском тарифе и приходят с «у меня деньги текут».
// v3 (2026-08-25): в DEFAULT_CFG добавлен upstreamTimeoutMs (150с вместо константы
// 600с). Версию поднимаем ровно по правилу выше — иначе у того, кто однажды нажал
// «Применить», в json нет этого поля, cfg остался бы на дефолте кода, а вот прежние
// мульти-запрос/пре-коммит из файла применились бы: полусостояние, которое не отладить.
// v5 (2026-09-04): добавлены emptyStreamMs, catalogTtlMs и jsonHoldMs — правило то же.
// v4 (2026-09-03): в DEFAULT_CFG добавлен holdMs — окно удержания запроса, пока лежит
// путь до шлюза. Правило то же: без поднятия версии у тех, кто однажды нажал «Применить»,
// в json нет нового поля, удержание осталось бы на дефолте кода, а старые цифры доехали
// бы из файла — полусостояние, в котором непонятно, что именно работает.
const CFG_VERSION = 5;
// Платный мульти-запрос: на плоскотарифных шлюзах дубль стоит полную цену запроса, поэтому там
// его нельзя включить ни из json, ни из панели, ни curl'ом — только осознанным
// ALLOW_PAID_HEDGE=1 при запуске процесса. Гвоздь прибит НАД конфигом намеренно:
// «не высасывать баланс» важнее, чем «уважать любую цифру в файле».
const ALLOW_PAID_HEDGE = process.env.ALLOW_PAID_HEDGE === '1';
const PAID_HEDGE_HOST = FLAT_RATE_HOSTS.has(upstream.hostname) && !ALLOW_PAID_HEDGE;
function clampPaidHedge(why) {
  if (!PAID_HEDGE_HOST || !(cfg.maxHedges > 0)) return false;
  log(`${why}: у ${upstream.hostname} тариф плоский за запрос — дубль стоит столько же, `
    + `сколько сам ответ. maxHedges ${cfg.maxHedges} → 0 (перебить: ALLOW_PAID_HEDGE=1)`);
  cfg.maxHedges = 0;
  return true;
}
function loadConfig() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (e) { return; }
  let c;
  try { c = JSON.parse(raw); } catch (e) { log(`config.json битый, игнорирую: ${e.message}`); return; }
  const was = Number(c.v) || 1;
  if (was !== CFG_VERSION) {
    const bak = `${CONFIG_FILE}.v${was}.bak`;
    try { fs.writeFileSync(bak, raw); } catch (e) { /* бэкап не критичен */ }
    log(`config версии ${was} устарел (сейчас ${CFG_VERSION}) — беру дефолты кода, `
      + `прежние настройки в ${path.basename(bak)}`);
    saveConfig();
    return;
  }
  const h = patchNum(c.hedgeMs, 1000, 120000, true);
  if (h !== null) cfg.hedgeMs = h;
  const a = patchNum(c.maxAttempts, 1, 10, false);
  if (a !== null) cfg.maxAttempts = a;
  const mh = patchNum(c.maxHedges, 1, 5, true);
  if (mh !== null) cfg.maxHedges = mh;
  const p = patchNum(c.preCommitMs, 2000, 120000, true);
  if (p !== null) cfg.preCommitMs = p;
  // Нижняя граница 20с не случайна: наблюдалось честное молчание 65.8с, и порог ниже
  // него превратил бы таймаут из страховки в генератор лишних платных ретраев.
  const ut = patchNum(c.upstreamTimeoutMs, 20000, 600000, false);
  if (ut !== null) cfg.upstreamTimeoutMs = ut;
  // 0 выключает удержание целиком. Нижняя граница 5с: окно короче этого не покрывает
  // даже самый быстрый флап и только создаёт иллюзию защиты. Верхняя 600с — дальше
  // клиент уйдёт сам, держать его дольше бессмысленно.
  const hm = patchNum(c.holdMs, 5000, 600000, true);
  if (hm !== null) cfg.holdMs = hm;
  const es = patchNum(c.emptyStreamMs, 30000, 600000, true);
  if (es !== null) cfg.emptyStreamMs = es;
  const ct = patchNum(c.catalogTtlMs, 60000, 3600000, true);
  if (ct !== null) cfg.catalogTtlMs = ct;
  const jh = patchNum(c.jsonHoldMs, 3000, 60000, true);
  if (jh !== null) cfg.jsonHoldMs = jh;
  const sm = patchNum(c.stallMs, 30000, 900000, true);
  if (sm !== null) cfg.stallMs = sm;
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(Object.assign({ v: CFG_VERSION }, cfg), null, 2)); } catch (e) { log(`config save error: ${e.message}`); }
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
  if ('maxHedges' in p) {
    const mh = patchNum(p.maxHedges, 1, 5, true);
    if (mh !== null) cfg.maxHedges = mh;
  }
  if ('preCommitMs' in p) {
    const pc = patchNum(p.preCommitMs, 2000, 120000, true);
    if (pc !== null) cfg.preCommitMs = pc;
  }
  if ('upstreamTimeoutMs' in p) {
    const ut = patchNum(p.upstreamTimeoutMs, 20000, 600000, false);
    if (ut !== null) cfg.upstreamTimeoutMs = ut;
  }
  if ('holdMs' in p) {
    const hm = patchNum(p.holdMs, 5000, 600000, true);
    if (hm !== null) cfg.holdMs = hm;
  }
  if ('emptyStreamMs' in p) {
    const es = patchNum(p.emptyStreamMs, 30000, 600000, true);
    if (es !== null) cfg.emptyStreamMs = es;
  }
  if ('catalogTtlMs' in p) {
    const ct = patchNum(p.catalogTtlMs, 60000, 3600000, true);
    if (ct !== null) cfg.catalogTtlMs = ct;
  }
  if ('jsonHoldMs' in p) {
    const jh = patchNum(p.jsonHoldMs, 3000, 60000, true);
    if (jh !== null) cfg.jsonHoldMs = jh;
  }
  if ('stallMs' in p) {
    const sm = patchNum(p.stallMs, 30000, 900000, true);
    if (sm !== null) cfg.stallMs = sm;
  }
  const clamped = clampPaidHedge('патч конфига');
  saveConfig();
  log(`config updated: мульти-запрос ${hedgeOff(cfg) ? 'выкл' : `${cfg.hedgeMs}ms`}, копий максимум ${cfg.maxHedges}, попыток на запрос ${cfg.maxAttempts}, пре-коммит ${cfg.preCommitMs ? `${cfg.preCommitMs}ms` : 'выкл'}, таймаут апстрима ${cfg.upstreamTimeoutMs}ms, удержание ${cfg.holdMs ? `${cfg.holdMs}ms` : 'выкл'}, пустой поток ${cfg.emptyStreamMs ? `${cfg.emptyStreamMs}ms` : 'выкл'}, каталог ${cfg.catalogTtlMs ? `${cfg.catalogTtlMs}ms` : 'выкл'}, JSON-удержание ${cfg.jsonHoldMs ? `${cfg.jsonHoldMs}ms` : 'выкл'}, вставший поток ${cfg.stallMs ? `${cfg.stallMs}ms` : 'выкл'}`);
  return clamped;
}
function publicState() {
  return {
    cfg: Object.assign({}, cfg),
    defaults: Object.assign({}, DEFAULT_CFG),
    // flatRate — чтобы панель могла объяснить, почему дублей 0, а не делать вид, что
    // юзер сам так настроил. paidHedgeLocked = ручку крутить бессмысленно, зажмём.
    flatRate: FLAT_RATE_HOSTS.has(upstream.hostname),
    paidHedgeLocked: PAID_HEDGE_HOST,
    cfgVersion: CFG_VERSION,
    upstream: UPSTREAM, port: PORT, idle_ms: IDLE_MS, uptime_ms: Date.now() - startedAt,
    // Авторотация: включена ли и в какой пул звоним. Без этого в панели невозможно
    // отличить «тумблер выключен» от «прокси не знает этот шлюз».
    rotate: { on: ROTATE_ON, provider: ROTATE_PROVIDER || null, maxPerRequest: MAX_ROTATIONS },
    stats: Object.assign({}, stats),
    // Время последнего ответа — в /__state, чтобы панель показывала цифру тем же
    // поллингом, что и счётчики, не дёргая график.
    latency: { last_ms: lat.lastMs, last_at: lat.lastAt },
    // Пул исходящих сокетов ПРЯМО СЕЙЧАС. `queued` > 0 = запросам не хватает сокетов и
    // они стоят в очереди агента — та самая цифра, которую иначе пришлось бы ловить
    // netstat'ом в момент лага, до перезапуска (см. traceConn).
    pool: poolSnapshot(),
  };
}
// Счётчики «с момента старта процесса»: показываются в дашборде на вкладке
// AgentRouter в том же блоке, что и крутилки мульти-запроса. retries — всего повторов,
// byStatus/byModel — распределение финальных ответов для отладки.
// winBy — КТО принёс ответ: `первый` / `мульти-запрос` / `ретрай`. Это единственная цифра,
// по которой можно настраивать hedgeMs не наугад: если `мульти-запрос` почти нулевой, дубли
// только грузят шлюз (его WAF чувствителен к пачкам) и hedgeMs надо ПОДНИМАТЬ.
const stats = { requests: 0, remaps: 0, keepalives: 0, hedges: 0, errors: 0, retries: 0, holds: 0, rotations: 0, byStatus: {}, byModel: {}, winBy: {} };
const startedAt = Date.now();

// ── История времени ответа: минутные бакеты за сутки ────────────────────────
// Одна цифра «последний ответ» ничего не объясняет: шлюз то отдаёт за 3с, то за 40с,
// и увидеть это можно только по форме кривой. Поэтому держим агрегат ПО МИНУТАМ, а не
// сырые замеры: 1440 бакетов = сутки при фиксированной памяти (~100КБ), и на график
// ложится любое окно от 5 минут до 24 часов без пересчёта.
// Замеряем время до ПЕРВЫХ БАЙТ победившей попытки (TTFB) — ровно то, чем шлюз
// отличается медленный от быстрого. Полное время ответа зависит от длины генерации,
// то есть от вопроса пользователя, и про шлюз не говорит ничего.
// Формат бакетов, нарезка окна и файл — в `latency-store.js`: тот же модуль читает
// дашборд, чтобы показывать график провайдера, чей прокси СЕЙЧАС не запущен. Держать
// две копии этой арифметики нельзя — разъедутся, и на диске окажется формат, который
// вторая сторона молча прочитает неправильно.
const latStore = require('./latency-store.js');
const LAT_BUCKET_MS = latStore.BUCKET_MS;
const LAT_BUCKETS = latStore.BUCKETS;             // 24ч при бакете в минуту
// Файл кейсуется по PORT — как keepalive-config-<PORT>.json: на одном скрипте живут
// пять прокси, и общая история слепила бы agentrouter с tabi в одну кривую.
const LAT_FILE = process.env.LATENCY_FILE || latStore.fileFor(PORT, __dirname);
const lat = { slots: new Array(LAT_BUCKETS).fill(null), lastMs: 0, lastAt: 0 };
let latDirty = false;

function noteLatency(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  lat.lastMs = Math.round(ms);
  lat.lastAt = Date.now();
  const m = Math.floor(lat.lastAt / LAT_BUCKET_MS);
  const i = ((m % LAT_BUCKETS) + LAT_BUCKETS) % LAT_BUCKETS;
  const b = lat.slots[i];
  // Слот занят ЧУЖОЙ минутой = кольцо провернулось на сутки, перезаписываем.
  if (!b || b.m !== m) lat.slots[i] = { m, n: 1, sum: lat.lastMs, min: lat.lastMs, max: lat.lastMs };
  else {
    b.n += 1; b.sum += lat.lastMs;
    if (lat.lastMs < b.min) b.min = lat.lastMs;
    if (lat.lastMs > b.max) b.max = lat.lastMs;
  }
  latDirty = true;
}

const latSeries = (windowSec) => latStore.series(
  lat.slots.filter(Boolean), windowSec, { last_ms: lat.lastMs, last_at: lat.lastAt });

// История переживает рестарт прокси: иначе после каждого «Применить» (а он поднимает
// процесс заново) суточный график обнулялся бы, и смысл суточного окна пропадал.
function latLoad() {
  const st = latStore.readFile(LAT_FILE);
  if (!st) return;
  for (const b of st.buckets) {
    lat.slots[((b.m % LAT_BUCKETS) + LAT_BUCKETS) % LAT_BUCKETS] = b;
  }
  if (st.last_at > 0) { lat.lastMs = st.last_ms; lat.lastAt = st.last_at; }
}
function latSave() {
  if (!latDirty) return;
  latDirty = false;
  const buckets = lat.slots.filter(Boolean);
  try {
    fs.writeFileSync(LAT_FILE, JSON.stringify({ v: 1, last_ms: lat.lastMs, last_at: lat.lastAt, buckets }));
  } catch (e) { log(`latency-история не сохранилась: ${e.message}`); }
}
latLoad();
// Раз в минуту, и только если что-то менялось: сброс на диск чаще смысла не имеет —
// бакет всё равно минутный.
setInterval(latSave, LAT_BUCKET_MS).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { latSave(); process.exit(0); });
// Служебные пути: статус (health-check дашборда), состояние и патч конфига.
function handleControl(req, res, reqPath) {
  if (req.method === 'GET' && reqPath === '/__keepalive/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, port: PORT, upstream: UPSTREAM, idle_ms: IDLE_MS, retries: cfg.maxAttempts, hedge_ms: cfg.hedgeMs, max_hedges: cfg.maxHedges }));
    return;
  }
  if (req.method === 'GET' && reqPath === '/__state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(publicState()));
    return;
  }
  // GET /__latency?window=<сек> — история времени ответа для графика в панели.
  // Отдельно от /__state: точек до 1440, таскать их на каждом тике счётчиков незачем.
  if (req.method === 'GET' && reqPath.split('?')[0] === '/__latency') {
    const q = reqPath.indexOf('?') >= 0 ? new URLSearchParams(reqPath.slice(reqPath.indexOf('?') + 1)) : null;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(latSeries(q && q.get('window'))));
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

// Жив ли путь до шлюза. Дешёвая проба: TCP-connect и сразу разрыв — ни запроса, ни тела,
// ни денег. Нужна для удержания: пока путь лежит, повторять бессмысленно, а на плоском
// тарифе ещё и платно.
// 🪤 На рабочей станции под happ-tun проба может СОВРАТЬ «путь жив»: туннель завершает
// handshake локально для любого адреса (та же ловушка, из-за которой пробы портов на
// нодах врут). Удержание от этого не ломается, потому что гейт здесь — оптимизация, а не
// механизм: соврала в плюс — повторим сразу, как было до правки; сказала «лежит» —
// сэкономили платную попытку в мёртвую сеть.
function probePath(hostname, port, cb) {
  let done = false;
  const finish = (ok) => { if (!done) { done = true; cb(ok); } };
  let s;
  try {
    s = net.connect({ host: hostname, port: Number(port) });
  } catch (e) {
    finish(false);
    return;
  }
  s.setTimeout(HOLD_PROBE_TIMEOUT_MS);
  s.once('connect', () => { finish(true); s.destroy(); });
  s.once('timeout', () => { finish(false); s.destroy(); });
  s.once('error', () => finish(false));
}

// ── Каталог моделей шлюза: чем маппинг проверяет себя ────────────────────────
// Зачем. Карта тиров (`*-modelmap.json`) — это НАШЕ пожелание, а не факт. Шлюзы
// меняют ассортимент без предупреждения: 03.09 justwoker убрал `claude-opus-4-8`, на
// который у нас указывали тиры `sonnet` и `haiku`, и каждый запрос сабагента стал
// умирать (`503 model_not_found: No available channel`). Замер того дня: 255 запросов
// `sonnet→claude-opus-4-8` — все мёртвые, при 256 живых `opus→claude-opus-5`; шлюз при
// этом отдавал по `/v1/models` ровно две модели: `claude-opus-5` и `-thinking`.
// Поэтому спрашиваем у шлюза его список и, если цель тира в нём отсутствует, берём
// живую замену вместо гарантированной ошибки.
//
// Каталог НИКОГДА не блокирует запрос: пустой или устаревший — работаем по карте как
// раньше, а обновление идёт в фоне. Точный момент, когда он нужен, — ответ
// `model_not_found`: там мы обновляем список принудительно и повторяем запрос уже с
// живой моделью (см. ROUTE_MISS_RE в makeUpstream).
const catalog = { ids: null, at: 0, fetching: false };

// Каталог выключен ручкой → ведём себя ровно как до его появления: подмен нет,
// решает только карта тиров.
function catalogOff() {
  return !(cfg.catalogTtlMs > 0);
}
function catalogStale() {
  if (catalogOff()) return false;
  return catalog.ids === null || Date.now() - catalog.at > cfg.catalogTtlMs;
}
// null = каталога нет (или он выключен), судить не берёмся. true/false = модель есть/нет.
function catalogHas(id) {
  if (catalogOff() || !catalog.ids) return null;
  return catalog.ids.has(String(id || ''));
}
function refreshCatalog(force, cb) {
  const done = (ok) => { catalog.fetching = false; if (cb) cb(ok); };
  if (catalogOff()) { if (cb) cb(false); return; }
  if (catalog.fetching) { if (cb) cb(false); return; }
  if (!force && !catalogStale()) { if (cb) cb(true); return; }
  catalog.fetching = true;
  let key = '';
  try { key = fs.readFileSync(AR_ACTIVE_KEY_FILE, 'utf8').trim(); } catch { /* ключ инжектит не всегда мы */ }
  const headers = Object.assign({ accept: 'application/json', 'accept-encoding': 'identity' }, CC_FALLBACK_HEADERS);
  if (key) { headers.authorization = `Bearer ${key}`; headers['x-api-key'] = key; }
  const req = upRequester({
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    method: 'GET',
    path: `${upBase}/v1/models`,
    headers,
    agent: agentFor(upRequester),
    timeout: 15000,
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try {
        const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const list = Array.isArray(doc.data) ? doc.data : (Array.isArray(doc.models) ? doc.models : []);
        const ids = list.map((x) => String((x && (x.id || x.name)) || x || '')).filter(Boolean);
        if (!ids.length) throw new Error('пустой список');
        catalog.ids = new Set(ids);
        catalog.at = Date.now();
        log(`каталог ${upstream.host}: ${ids.length} моделей (${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''})`);
        done(true);
      } catch (e) {
        // 404/HTML/мусор — у шлюза может не быть этого эндпоинта. Молчим и работаем
        // по карте: отсутствие каталога не должно менять поведение.
        log(`каталог ${upstream.host} недоступен (${res.statusCode}: ${e.message}) — маппинг работает по карте`);
        done(false);
      }
    });
    res.on('error', () => done(false));
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (e) => { log(`каталог ${upstream.host}: ${e.message}`); done(false); });
  req.end();
}

// Живая замена мёртвой цели тира. null = менять не надо или нечем.
// Порядок кандидатов: цели соседних тиров из той же карты (их владелец уже выбрал
// осознанно) → то, что просил клиент → модель каталога с тем же словом тира →
// любая claude-модель каталога. Первый кандидат, который есть у шлюза, побеждает.
function availableTarget(tier, target, clientModel, mm) {
  if (catalogHas(target) !== false) return null;
  const order = tier === 'haiku' ? ['sonnet', 'opus'] : (tier === 'sonnet' ? ['opus', 'haiku'] : ['sonnet', 'haiku']);
  const cands = [];
  for (const t of order) if (mm[t] && mm[t] !== target) cands.push(mm[t]);
  cands.push(String(clientModel || '').replace(/\s*\[[^\]]*\]\s*$/, ''));
  const ids = Array.from(catalog.ids || []);
  const tierRe = new RegExp(tier, 'i');
  for (const id of ids) if (tierRe.test(id)) cands.push(id);
  for (const id of ids) if (/claude/i.test(id)) cands.push(id);
  for (const c of cands) if (c && c !== target && catalogHas(c) === true) return c;
  return null;
}

function shouldRetryStatus(status) {
  return status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599);
}

// 🪤 `required` раньше стоял голым словом — и матчил `owner_action_required` внутри
// тела Cloudflare на 522. То есть «origin не отвечает, попробуй ещё» классифицировалось
// как ПОСТОЯННАЯ ошибка, ретрая не было вовсе, и 23.08 это положило агентов. Ловушка
// общая: угадывать класс ошибки по прозе — значит ловить подстроки в чужих
// идентификаторах. Отрицательный lookbehind оставляет «field X is required» (это
// правда постоянная ошибка) и снимает `*_required` / `*-required`.
const RETRY_NO = /invalid|authentication|api[ _-]?key|expired|billing|quota|permission|denied|bad request|missing|(?<![_-])required|incorrect|not supported|bad gateway upstream/i;
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
// ── Промах МАРШРУТА, а не сбой шлюза ─────────────────────────────────────────
// Шлюз отвечает 503, но означает это «такой модели у меня нет ни на одном канале».
// Повтор канала не создаёт: 03.09 на justwoker это дало **179 смертей из 220** —
// тир `sonnet`/`haiku` указывает на `claude-opus-4-8`, группа `g` шлюза её не отдаёт,
// и прокси трижды спрашивал одно и то же, прежде чем убить вызывающего.
// 🪤 Ни один словарь эту формулировку не ловил, и промах был неочевиден: в теле стоит
// `No available channel`, а в RETRY_OK — `unavailable`; подстроки разные, поэтому решал
// fallback `status >= 500` → «транзиентно». Классическая цена угадывания класса ошибки
// по прозе (тот же род ошибки, что `owner_action_required` на 522, см. RETRY_NO).
// Почему отдать сразу лучше, чем ретраить: отказ успевает уйти ДО пре-коммита, то есть
// обычным HTTP-кодом, который клиент умеет повторить, а не `event: error` внутрь уже
// открытого потока — начатый поток Claude Code повторить не может и убивает подагента.
const ROUTE_MISS_RE = /model_not_found|no available channel|no channel available|无可用渠道|渠道不存在/i;

// ── Структурный ответ вместо угадывания по прозе ──────────────────────────────
// Cloudflare и часть шлюзов СООБЩАЮТ класс ошибки полями, а не текстом:
//   {"retryable": true, "retry_after": 120, "error_category": "origin", …}
// Читать их надо ДО словарей: поле — это утверждение сервера, а регулярка по прозе —
// наша догадка, и на 522 догадка была неверной (см. RETRY_NO выше).
// Возвращает true / false / null («ничего структурного не нашли, решай словарями»).
function structuredRetry(s) {
  let doc;
  try { doc = JSON.parse(s); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  // Поле может лежать и в корне, и внутри error — проверяем оба места.
  const nodes = [doc, doc.error].filter((x) => x && typeof x === 'object');
  for (const n of nodes) {
    if (typeof n.retryable === 'boolean') return n.retryable;
  }
  for (const n of nodes) {
    const cat = String(n.error_category || n.errorCategory || '').toLowerCase();
    // origin/timeout/upstream — не отвечает сторона ЗА шлюзом, это транзиентно.
    if (/^(origin|timeout|upstream|gateway)$/.test(cat)) return true;
    // конфигурация и авторизация повтором не лечатся
    if (/^(auth|authorization|configuration|validation|billing)$/.test(cat)) return false;
  }
  return null;
}

// Сколько шлюз просит подождать. Мы этому НЕ подчиняемся буквально: `retry_after: 120`
// больше терпения клиента (~18-20с без байт), и честнее отдать ошибку, чем держать
// его две минуты. Но в лог пишем — по этой цифре видно, что шлюз считает себя
// лежачим надолго, и это повод переключить провайдера руками.
function retryAfterSec(s) {
  let doc;
  try { doc = JSON.parse(s); } catch { return null; }
  for (const n of [doc, doc && doc.error].filter((x) => x && typeof x === 'object')) {
    const v = Number(n.retry_after || n.retryAfter);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function isTransientBody(status, buf) {
  const s = buf.toString('utf8');
  if (!s.trim()) return true;
  // Структурный вердикт приоритетнее словарей: сервер сам сказал, повторять или нет.
  const structured = structuredRetry(s);
  if (structured !== null) {
    const ra = retryAfterSec(s);
    if (ra) log(`тело ответа: retryable=${structured}, шлюз просит ${ra}с (ждать столько не будем)`);
    return structured;
  }
  // Промах маршрута — постоянная ошибка, но проверяем ПОСЛЕ структурного вердикта:
  // если шлюз сам сказал `retryable: true`, это его утверждение, а наше — догадка.
  if (ROUTE_MISS_RE.test(s)) return false;
  if (RETRY_NO.test(s) || RETRY_NO_ZH.test(s) || RETRY_NO_CONTENT.test(s)) return false;
  if (RETRY_OK.test(s)) return true;
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

// ── Отказ по деньгам и мёртвый ключ: причина сменить аккаунт, а не умереть ────
// Один и тот же смысл шлюз говорит ТРЕМЯ способами, и до авторотации все ветки
// вели в тупик (замеры 22.08 по keepalive-proxy.log):
//   • `预扣费额度失败, 用户剩余额度: $0.309854, 需要预扣费额度: $0.800000` — предоплата
//     под запрос не прошла. Ловилось RETRY_NO_ZH (`额度`) как постоянная ошибка и
//     улетало в Claude Code как `403`, роняя задачу.
//   • `Insufficient account balance` — ни один список не совпадал, fallback
//     `status === 403` считал её ТРАНЗИЕНТНОЙ: три попытки в пустой аккаунт и `502`.
//   • `pre-consume quota failed, user quota: ＄0.055238, need quota: ＄1.797580` —
//     англоязычный перевод той же китайской предоплаты (`预扣费额度失败` дословно и есть
//     «pre-consume quota failed»). Пойман живьём 22.08 дважды подряд. В OUT_OF_BALANCE
//     не совпадал ничем, зато RETRY_NO матчил слово `quota` → снова «постоянная
//     ошибка» и `403` в лицо. Доллар в этой формулировке ПОЛНОШИРИННЫЙ `＄` (U+FF04),
//     поэтому суммы не читались и планка кандидата не поднималась до нужной — см. moneyNum.
// Поэтому проверка стоит ВЫШЕ isTransientBody и решает раньше него.
const OUT_OF_BALANCE_RE = /insufficient (?:account |user )?(?:balance|quota|credit)|pre[- ]?consumed?\s+quota\s+failed|余额不足|额度不足|预扣费额度失败|额度已用完|欠费/i;
// Ключ отозван/забанен — деньги на нём не помогут, аккаунт надо пометить мёртвым.
// `无效的令牌` = «недействительный токен», `令牌已过期` = «токен истёк».
const DEAD_KEY_RE = /has been banned|account (?:is )?(?:banned|disabled|suspended)|无效的令牌|令牌已过期|令牌不存在|用户已被封禁|token has expired|invalid (?:api[ _-]?key|token|access token)/i;
// Числа из текста ошибки. `需要预扣费额度` / `need quota` — сколько шлюз хочет придержать
// под запрос, `用户剩余额度` / `user quota` — сколько реально осталось на аккаунте. Первое
// отбирает кандидата (иначе уйдём на аккаунт, которому тоже не хватит), второе бесплатно
// уточняет кеш баланса в дашборде — точнее, чем анкер и угадывание.
// Метки пробуются ПО ПОРЯДКУ, китайская первой: у английской формулировки те же числа, но
// своя разметка и полноширинный `＄` (U+FF04) вместо `$`. Без него `need quota: ＄1.797580`
// не читалось вовсе, а молча непрочитанная сумма опаснее ошибки: планка годности кандидата
// падала до MONEY_MIN_BAL, и ротация уходила на аккаунт, которому тоже не хватит.
function moneyNum(s, ...labels) {
  for (const label of labels) {
    const m = new RegExp(label + '\\s*[:：]?\\s*[$＄]?\\s*(-?[0-9]+(?:\\.[0-9]+)?)', 'i').exec(s);
    if (!m) continue;
    const v = Number(m[1]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}
function neededUsd(s) { return moneyNum(s, '需要预扣费额度', 'need\\s+quota'); }
function leftUsd(s) { return moneyNum(s, '用户剩余额度', 'user\\s+quota'); }
// Причина ротации по ответу шлюза: 'out-of-balance' | 'dead' | null.
// Статус проверяем, чтобы фраза из чужого контекста (эхо тела в 200) не считалась
// отказом. 402 сюда добавлен на будущее: в HTTP это и есть Payment Required.
function rotateReason(status, buf) {
  if (status !== 401 && status !== 402 && status !== 403) return null;
  const s = buf.toString('utf8');
  if (OUT_OF_BALANCE_RE.test(s)) return 'out-of-balance';
  if (DEAD_KEY_RE.test(s)) return 'dead';
  return null;
}

// Куда звонить за подменой аккаунта. Префикс ВЫВОДИМ из апстрима, а не получаем
// env'ом: спавнов прокси минимум три (дашборд на провайдера, keepalive-spawn.js,
// keepalive-restart.ps1) и env в них уже разъезжался — новая переменная просто не
// доехала бы до части путей запуска. Хосты те же строки, что в MONEY_GW дашборда.
const GW_BY_HOST = {
  'agentrouter.org': 'ar',
  'gorouter.app': 'go',
  'tabitoken.com': 'tb',
  'xpeach.codes': 'xp',
  // 🪤 У JustWoker панель и API на одном хосте, поэтому ключ здесь с поддоменом —
  // `api.justwoker.icu` буквально как в MONEY_GW дашборда. `justwoker.icu` не резолвится,
  // и опечатка в этой строке выглядит не ошибкой, а молча выключенной авторотацией.
  'api.justwoker.icu': 'jw',
  'seekai.cc': 'sk',
  'true-sota.com': 'ts',
  'kktoken.cc': 'kk',
  // api.hcnsec.cn — ключ С ПОДДОМЕНОМ, как у justwoker: панель и API на одном хосте,
  // `hcnsec.cn` без `api.` не наш адрес вовсе. 🪤 Забыть эту строку = молча выключенная
  // авторотация: прокси просто не знает, в какой пул звонить, и ошибки в логе нет.
  'api.hcnsec.cn': 'hn',
};
const ROTATE_P = GW_BY_HOST[upstream.hostname] || '';
// ROTATE_PROVIDER — только для тестов (routing/test-rotate.js прогоняет весь путь
// против фейкового шлюза на 127.0.0.1, которого в таблице хостов нет) и как аварийный
// ход, если шлюз сменит домен. Основной путь остаётся выводом из апстрима: env,
// который надо помнить в трёх местах спавна, уже разъезжался.
const ROTATE_PROVIDER = process.env.ROTATE_PROVIDER || ROTATE_P;
const DASH_URL = process.env.DASHBOARD_URL || `http://127.0.0.1:${process.env.SWITCHER_PORT || 8200}`;
// Не наш шлюз (или AUTOROTATE=0) → фича спит, поведение прежнее.
const ROTATE_ON = process.env.AUTOROTATE !== '0' && !!ROTATE_PROVIDER;
// Потолок цепочки на ОДИН запрос. Владелец выбрал стратегию «самый маленький
// достаточный»: на маленьком может не хватить, тогда идём дальше. Без потолка
// единственный запрос мог бы прокрутить весь пул.
const MAX_ROTATIONS = Number(process.env.MAX_ROTATIONS || 5);

// Просьба к дашборду сменить активный ключ. Возвращает {ok, already?, email, mask}.
// Таймаут щедрый: на той стороне живой чек баланса кандидата (~1.5с на аккаунт,
// до трёх кандидатов). Ключ в лог не пишем — только маску (контракт прокси).
function askRotate(payload) {
  return new Promise((resolve) => {
    let body;
    try { body = Buffer.from(JSON.stringify(payload)); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const u = new URL(`${DASH_URL}/__switch/api/${ROTATE_PROVIDER}/rotate`);
    const requester = u.protocol === 'https:' ? https.request : http.request;
    const r = requester({
      hostname: u.hostname, port: u.port, method: 'POST', path: u.pathname,
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout: 20000,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (e) { resolve({ ok: false, error: 'дашборд ответил не JSON' }); }
      });
      resp.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    r.on('timeout', () => { r.destroy(new Error('rotate timeout')); });
    r.on('error', (e) => resolve({ ok: false, error: e.message }));
    r.end(body);
  });
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
    label = tm.substituted
      ? `${tm.tier}→${target} (map, claude; ПОДМЕНА: ${tm.from} нет у шлюза)`
      : `${tm.tier}→${target} (map, claude)`;
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
  // То же для НЕ-стримового запроса: заголовки `200 application/json` уже отданы, и
  // тело дописывается пробелами, пока шлюз считает. См. DEFAULT_CFG.jsonHoldMs.
  let clientJSON = false;
  let jsonTimer = null;           // таймер отложенного коммита JSON
  let jsonTick = null;            // таймер капания пробела
  let jsonDrips = 0;
  let stallTimer = null;          // страховка от потока, который встал посреди ответа
  let tail = Buffer.alloc(0);     // последние ≤4 байта отправленного клиенту (для формата keepalive)
  let activeSet = new Set();      // все живые попытки (ретраи + мульти-дубли)
  let winner = null;              // победитель гонки
  let finished = false;           // исход решён (победитель или сдались)
  let launched = 0;               // сколько попыток/дублей уже запущено
  let hedgesLaunched = 0;         // из них ПАРАЛЛЕЛЬНЫХ дублей (кэп cfg.maxHedges)
  // Ротаций аккаунта в этом запросе и подаренных за них попыток. Бюджет ОТДЕЛЬНЫЙ от
  // cfg.maxAttempts намеренно: цепочка «самый маленький аккаунт → не хватило →
  // следующий» иначе съела бы попытки, отложенные на транзиентную 500, и запрос
  // умирал бы ровно там, где ротация начала работать. Потолок — MAX_ROTATIONS.
  let rotations = 0;
  let bonusAttempts = 0;
  let rotating = false;           // ждём ответа дашборда — новых попыток не пускаем
  // Удержание запроса, пока лежит путь до шлюза (см. DEFAULT_CFG.holdMs). Бюджет свой,
  // отдельно и от maxAttempts, и от ротации: он мерит не «сколько раз спросили», а
  // «сколько ждали сеть», и подаренные им попытки не должны выедать ретраи на 500.
  let holdLaunches = 0;
  let holdProbing = false;        // ждём, пока путь оживёт — сдаваться и пускать попытки нельзя
  // Пустой поток: заголовки от шлюза пришли, содержимое — нет. Пока `contentSent` false,
  // наружу ушли максимум пинги, значит попытку ещё можно переиграть незаметно для клиента.
  let contentSent = false;
  let emptyTimer = null;
  let emptyRetries = 0;
  let hedgeTimer = null;          // таймер мульти-дубля
  let preTimer = null;            // таймер отложенного пре-коммита (preCommitMs)
  let reqBody = Buffer.alloc(0);  // тело запроса (после ремапа)
  let rawBody = Buffer.alloc(0);  // тело КАК ПРИШЛО: нужно, чтобы переиграть ремап на другую модель
  let routeFixTried = false;      // подмену модели по ответу «нет такой модели» пробуем один раз
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
    if (emptyTimer !== null) {
      clearTimeout(emptyTimer);
      emptyTimer = null;
    }
    if (jsonTimer !== null) { clearTimeout(jsonTimer); jsonTimer = null; }
    if (jsonTick !== null) { clearTimeout(jsonTick); jsonTick = null; }
    if (stallTimer !== null) { clearTimeout(stallTimer); stallTimer = null; }
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

  // ── То же для НЕ-стримового запроса: капаем пробел вместо пинга ───────────────
  // Пинг — событие SSE, в JSON-ответ его не вставить. Но ведущие пробелы перед
  // значением JSON легальны (RFC 8259 § 2), поэтому клиенту можно капать ' ' сколько
  // угодно: его байтовый таймер сбрасывается, а `JSON.parse` пробелы съедает.
  // Отдаём `Transfer-Encoding: chunked` (просто не ставим content-length) — иначе длину
  // пришлось бы знать заранее, а мы её ещё не знаем.
  const armJsonTick = () => {
    if (jsonTick !== null) clearTimeout(jsonTick);
    jsonTick = setTimeout(() => {
      jsonTick = null;
      if (aborted || res.writableEnded || !clientJSON) return;
      res.write(' ');
      jsonDrips += 1;
      if (jsonDrips === 1 || jsonDrips % 12 === 0) {
        log(`${req.method} ${reqPath} держу JSON пробелами, капель ${jsonDrips}`);
      }
      armJsonTick();
    }, IDLE_MS);
  };
  const commitJson = () => {
    jsonTimer = null;
    if (aborted || res.writableEnded || res.headersSent) return;
    clientJSON = true;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    res.write(' ');
    jsonDrips = 1;
    armJsonTick();
    log(`${req.method} ${reqPath} пре-коммит JSON (${cfg.jsonHoldMs}ms тишины) — дальше пробелы, пока шлюз считает`);
  };
  // Отказ, когда JSON-ответ уже открыт: статус сменить нельзя, а писать объект ошибки с
  // кодом 200 нельзя тем более — клиент разберёт его как сообщение модели. Единственный
  // честный выход — обрыв: его Claude Code читает как сетевую ошибку и повторяет сам.
  const jsonHoldFail = (why) => {
    stopTimer();
    log(`${req.method} ${reqPath} JSON уже открыт (${jsonDrips} капель), отдать код ошибки нельзя: ${why} — рву соединение`);
    if (!res.writableEnded && !res.destroyed) res.destroy();
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
        armEmptyGuard(stream);
        stream.on('data', (chunk) => {
          const out = patchSseChunk(chunk);
          if (out === null) return;          // придержали до границы события
          if (!contentSent) { contentSent = true; clearEmptyGuard(); }
          armStall(stream);
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
          // Обрыв ДО первого байта содержимого — не поломка ответа, а неудавшаяся
          // попытка: клиент видел только пинги, значит запрос можно переиграть.
          if (retryEmptyStream(`обрыв до первого байта содержимого (${err.message})`, stream)) return;
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
        // JSON-ответ уже открыт пробелами — заголовки писать нельзя, дописываем тело.
        // Пробелы перед значением легальны, поэтому клиент разберёт это как обычный JSON.
        if (clientJSON) {
          if (status < 200 || status >= 300 || isCompressedBody(hdrs)) {
            return jsonHoldFail(`апстрим ответил ${status}${isCompressedBody(hdrs) ? ' сжатым телом' : ''}`);
          }
          stopTimer();
          log(`${req.method} ${reqPath} дописываю тело в открытый JSON (${jsonDrips} капель, ${body.length}Б)`);
          res.end(body);
          return;
        }
        res.writeHead(status, hdrs);
        res.end(body);
      });
      stream.on('error', (err) => {
        if (clientJSON) return jsonHoldFail(`обрыв тела: ${err.message}`);
        log(`${req.method} ${reqPath} upstream stream error: ${err.message}`);
        if (!res.writableEnded && !res.destroyed) res.destroy(err);
      });
      return;
    }

    // 🪤 Зеркальный случай: клиент просил JSON, мы уже открыли его пробелами, а шлюз
    // ответил `text/event-stream`. Дальше стоит writeHead — второй раз его звать нельзя,
    // это `ERR_HTTP_HEADERS_SENT`, а обработчика uncaughtException в файле нет, то есть
    // упал бы весь прокси. Отдаём обрыв: сырые SSE-байты в JSON-канале клиент всё равно
    // не разберёт.
    if (clientJSON) {
      return jsonHoldFail('шлюз ответил потоком на не-стримовый запрос');
    }
    res.writeHead(status, hdrs);
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    armTimer();
    // Заголовки SSE ушли клиенту — с этого момента канал открыт ровно так же, как после
    // пре-коммита. Отмечаем это явно: иначе переигровка пустого потока попыталась бы
    // писать заголовки второй раз, а отказ ушёл бы обрывом сокета вместо in-band ошибки.
    clientSSE = true;
    armEmptyGuard(stream);

    stream.on('data', (chunk) => {
      const out = patchSseChunk(chunk);
      if (out === null) return;            // придержали до границы события
      if (!contentSent) { contentSent = true; clearEmptyGuard(); }
      armStall(stream);
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
      if (retryEmptyStream(`обрыв до первого байта содержимого (${err.message})`, stream)) return;
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
    // Пишем ИМЕННО кто победил: без этого мульти-запрос настраивается наугад. `первый` = дубли
    // не нужны, `мульти-запрос`/`ретрай` = спасли. Агрегат — в stats.winBy (GET /__state).
    const wKind = r.__kind || 'первый';
    stats.winBy[wKind] = (stats.winBy[wKind] || 0) + 1;
    const took = Date.now() - started;
    // В историю идёт только победитель: убитый дубль показал бы не скорость шлюза, а
    // цифру мульти-запроса, а сдохшая попытка — таймаут. Пишем здесь, а не в forward(), потому
    // что forward для буферизованных ответов вызывается уже после дренажа тела.
    noteLatency(took);
    log(`${req.method} ${reqPath} winner: ${wKind} (попытка #${r.__attempt || 1} из ${launched}) за ${took}ms`);
  };
  const giveUp = (why) => {
    finished = true;
    stats.errors += 1;
    for (const x of activeSet) {
      if (!x.destroyed) { try { x.destroy(); } catch (e) {} }
    }
    activeSet.clear();
    log(`${req.method} ${reqPath} все попытки исчерпаны: ${why}`);
    if (clientJSON) {
      jsonHoldFail(why);
    } else if (clientSSE) {
      inbandError(502, Buffer.from(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `upstream: ${why}` } })));
    } else if (!res.headersSent) {
      // Форма отказа важнее его текста. `502 proxy_error` Claude Code читает как
      // окончательную поломку и убивает подагента на месте; `529 overloaded_error` —
      // как «шлюз занят», повторяет сам с отступом и переживает простой длиннее нашего
      // окна удержания. Смысл тела не меняется: причина остаётся в message.
      // Денег это не стоит: сюда мы попадаем, только когда ни одна попытка не дала байт,
      // то есть повторять клиенту предлагается запрос, за который никто не платил.
      res.writeHead(529, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '5' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: `upstream: ${why}` } }));
    } else if (!res.writableEnded) {
      res.destroy();
    }
  };
  // ── Удержание запроса, пока лежит путь ───────────────────────────────────────
  // Работает ТОЛЬКО в зоне «клиенту не ушло ни байта содержимого». Отдельного флага для
  // этого не нужно: как только победитель выбран, стоит `finished`, а attemptDone
  // из-под `finished` не зовётся вообще — значит сюда попадают лишь запросы, у которых
  // наружу ушли максимум SSE-заголовки пре-коммита и пинги. Такой запрос можно переиграть
  // незаметно для клиента. Поток, в который уже уехали дельты, переиграть нельзя: пришлось
  // бы дописывать чужую генерацию, а при включённом thinking там ещё и подпись блока.
  const holdLeftMs = () => cfg.holdMs - (Date.now() - started);
  const canHold = () => cfg.holdMs > 0 && !finished && !aborted && !rotating
    && holdLaunches < HOLD_MAX_LAUNCHES && holdLeftMs() > 1000;
  const holdRetry = (why) => {
    const t = tgt || {
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    };
    const wait = HOLD_BACKOFF_MS[Math.min(holdLaunches, HOLD_BACKOFF_MS.length - 1)];
    holdLaunches += 1;
    stats.holds += 1;
    holdProbing = true;
    log(`${req.method} ${reqPath} удержание #${holdLaunches}: ${why} — жду путь до ${t.hostname}, `
      + `в запасе ${Math.round(holdLeftMs() / 1000)}с`);
    const attempt = () => {
      if (finished || aborted) { holdProbing = false; return; }
      probePath(t.hostname, t.port, (alive) => {
        if (finished || aborted) { holdProbing = false; return; }
        if (!alive) {
          if (holdLeftMs() <= 1000) {
            holdProbing = false;
            giveUp(`${why} (путь до ${t.hostname} не ожил за ${cfg.holdMs}мс удержания)`);
            return;
          }
          setTimeout(attempt, 1500);
          return;
        }
        holdProbing = false;
        bonusAttempts += 1;
        log(`${req.method} ${reqPath} путь до ${t.hostname} жив — повторяю (удержание #${holdLaunches})`);
        makeUpstream('удержание');
      });
    };
    setTimeout(attempt, wait);
  };
  // ── Пустой поток: заголовки есть, содержимого нет ────────────────────────────
  // Отдельно от удержания, потому что и симптом другой: путь жив, шлюз ответил, но
  // ничего не генерирует. Пока наружу ушли только пинги, попытку можно переиграть —
  // для этого приходится «расстраховаться»: победитель, не давший ни байта, победителем
  // не является, и гонка продолжается с чистого листа.
  const clearEmptyGuard = () => {
    if (emptyTimer !== null) { clearTimeout(emptyTimer); emptyTimer = null; }
  };
  const retryEmptyStream = (why, stream) => {
    clearEmptyGuard();
    if (contentSent || aborted || cfg.emptyStreamMs <= 0) return false;
    if (emptyRetries >= EMPTY_MAX_RETRIES) return false;
    emptyRetries += 1;
    try { if (stream && !stream.destroyed) stream.destroy(); } catch (e) { /* уже мёртв */ }
    for (const x of activeSet) { try { x.destroy(); } catch (e) { /* уже мёртв */ } }
    activeSet.clear();
    finished = false;          // победителя не было: то, что пришло, содержимого не несёт
    winner = null;
    bonusAttempts += 1;        // переигровка пустого потока не съедает бюджет ретраев
    stats.retries += 1;
    log(`${req.method} ${reqPath} пустой поток #${emptyRetries}: ${why} — переигрываю запрос`);
    makeUpstream('пустой поток');
    return true;
  };
  // Поток встал посреди ответа: переиграть нельзя, но висеть вечно — хуже, чем ошибка.
  // Взводится и перевзводится на КАЖДОМ байте содержимого, поэтому живой поток его не
  // видит вообще.
  const armStall = (stream) => {
    if (cfg.stallMs <= 0) return;
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (aborted || res.writableEnded) return;
      stopTimer();
      log(`${req.method} ${reqPath} поток встал: ${cfg.stallMs}мс без байт после начала ответа — рву, иначе вызывающий ждёт вечно`);
      try { if (stream && !stream.destroyed) stream.destroy(); } catch (e) { /* уже мёртв */ }
      if (!res.writableEnded && !res.destroyed) res.destroy();
    }, cfg.stallMs);
  };
  const armEmptyGuard = (stream) => {
    if (cfg.emptyStreamMs <= 0) return;
    clearEmptyGuard();
    emptyTimer = setTimeout(() => {
      emptyTimer = null;
      if (contentSent || aborted || finished === false) return;
      if (!retryEmptyStream(`${cfg.emptyStreamMs}мс без единого байта содержимого`, stream)) {
        log(`${req.method} ${reqPath} пустой поток: переигрывать больше нечем (лимит ${EMPTY_MAX_RETRIES}) — жду шлюз как есть`);
      }
    }, cfg.emptyStreamMs);
  };
  const attemptDone = (r, why, delayMs) => {
    activeSet.delete(r);
    if (finished || aborted) return;
    if (launched < cfg.maxAttempts + bonusAttempts) {
      stats.retries += 1;
      log(`${req.method} ${reqPath} -> повтор/копия #${launched + 1} через ${delayMs}ms (${why})`);
      setTimeout(() => { if (!aborted && !finished) makeUpstream('ретрай'); }, delayMs);
      return;
    }
    if (activeSet.size === 0) {
      // Удержание уже идёт (его начала другая попытка) — она же и доведёт запрос.
      if (holdProbing) return;
      // Бюджет попыток кончился — но, возможно, кончился он не потому, что шлюз отказал, а
      // потому что лежал путь. Держим клиента пингами и ждём сеть, вместо того чтобы
      // убивать сессию через пять секунд.
      if (canHold()) { holdRetry(why); return; }
      giveUp(why);
    }
  };

  // Подмена аккаунта и повтор запроса. Зовётся только из ветки ответа шлюза, когда
  // тот отказал по деньгам или ключу (rotateReason). Ключ, на котором прилетел
  // отказ, передаём дашборду: по нему он и дедупит параллельные просьбы от
  // нескольких сессий Orca, сидящих на одном аккаунте.
  // onFail — отдать клиенту исходную ошибку: подменять нечем, врать нельзя.
  const tryRotate = (r, reason, buf, status, key, onFail) => {
    activeSet.delete(r);
    rotating = true;
    const body = buf.toString('utf8');
    const need = neededUsd(body);
    const left = leftUsd(body);
    const mask = key ? '***' + key.slice(-6) : '?';
    stats.rotations += 1;
    log(`${req.method} ${reqPath} ${status} «${reason}» на ${mask}`
      + `${need != null ? `, шлюз просит $${need}` : ''}${left != null ? `, осталось $${left}` : ''}`
      + ` — прошу дашборд подменить аккаунт`);
    askRotate({ reason, fromKey: key || null, needUsd: need, leftUsd: left }).then((rot) => {
      rotating = false;
      if (finished || aborted) return;
      if (rot && rot.ok) {
        rotations += 1;
        bonusAttempts += 1;   // ротация не должна съедать бюджет ретраев
        log(`${req.method} ${reqPath} ротация #${rotations}: → ${rot.email || rot.mask || '?'}`
          + `${rot.already ? ' (ключ уже сменил параллельный запрос)' : ''} — повторяю запрос`);
        makeUpstream('после ротации');
        return;
      }
      // 'disabled' — тумблер выключен, это осознанный выбор пользователя, а не сбой.
      // 'pool-dry' — в пуле нет живого аккаунта с деньгами; человек должен это узнать.
      const err = (rot && rot.error) || 'нет ответа дашборда';
      log(`${req.method} ${reqPath} ротация не состоялась (${err}) — отдаю ${status} клиенту`);
      onFail();
    }).catch((e) => {
      rotating = false;
      if (finished || aborted) return;
      log(`${req.method} ${reqPath} ротация упала: ${e.message} — отдаю ${status} клиенту`);
      onFail();
    });
  };

  // Мульти-запрос-дубль: если через cfg.hedgeMs апстрим всё ещё молчит (нет даже заголовков),
  // запускаем ПАРАЛЛЕЛЬНУЮ попытку. Победит тот, кто ответит первым — остальных рвём.
  // Дублей не больше cfg.maxHedges: своим счётчиком, а не бюджетом maxAttempts, иначе
  // мульти-запросы выедали попытки и на транзиентную 500 ретраить было уже нечем.
  const scheduleHedge = () => {
    if (cfg.hedgeMs <= 0 || cfg.maxHedges <= 0 || finished || aborted || hedgeTimer !== null) return;
    if (launched >= cfg.maxAttempts) return;
    if (hedgesLaunched >= cfg.maxHedges) return;
    hedgeTimer = setTimeout(() => {
      hedgeTimer = null;
      if (finished || aborted) return;
      log(`${req.method} ${reqPath} мульти-запрос: тишина ${Date.now() - started}ms, пускаю дубль #${launched + 1}`);
      stats.hedges += 1;
      hedgesLaunched += 1;
      makeUpstream('мульти-запрос');
      scheduleHedge();
    }, cfg.hedgeMs);
  };

  const makeUpstream = (kind) => {
    if (finished || aborted) return;
    if (launched >= cfg.maxAttempts + bonusAttempts) {
      // Тот же выбор, что в attemptDone: прежде чем сдаваться, проверить, не лежит ли
      // просто путь. Сюда попадаем, когда бюджет выели параллельные дубли.
      if (activeSet.size === 0 && !holdProbing) {
        if (canHold()) holdRetry('попытки исчерпаны');
        else giveUp('попытки исчерпаны');
      }
      return;
    }
    launched += 1;
    const attempt = launched;
    const kindLabel = kind || 'первый';
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
    // Он же — `fromKey` для авторотации: дашборду нужно знать, на КАКОМ аккаунте
    // прилетел отказ. Читается на каждую попытку, поэтому попытка после ротации
    // уезжает уже с новым ключом сама, без перезапуска прокси.
    let sentKey = '';
    try {
      const arKey = fs.readFileSync(AR_ACTIVE_KEY_FILE, 'utf8').trim();
      if (arKey) {
        sentKey = arKey;
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
    // после раннего SSE/мульти-запроса ломает поток, v1tusha), и для обычных запросов: тело
    // нужно читать как текст (MODEL_ECHO, проверка на пустой 200, isTransientBody).
    // Клиентский `accept-encoding: zstd` не пробрасываем: если шлюз всё же сожмёт,
    // тело уйдёт клиенту байт-в-байт (isCompressedBody), но уже без эха модели.
    headers['accept-encoding'] = 'identity';
    // Заполняется traceConn сразу после создания запроса (событие `socket` Node отдаёт
    // через nextTick, поэтому успеваем подписаться). Нужен внутри колбэка ответа.
    let ctrace = null;
    const upReq = t.requester({
      hostname: t.hostname,
      port: t.port,
      method: req.method,
      path: t.base + reqPath,
      headers: headers,
      agent: agentFor(t.requester),
      timeout: cfg.upstreamTimeoutMs,
    }, (upRes) => {
      const status = upRes.statusCode;
      if (CONN_TRACE && ctrace) log(`${req.method} ${reqPath} ${status} conn: ${fmtConn(ctrace)}`);
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
          // Отказ по деньгам или мёртвый ключ — это не ошибка запроса, а конец
          // аккаунта. Ретрай тем же ключом бессмыслен (проверено: три попытки в
          // пустой аккаунт и 502), отдать клиенту тоже нельзя, пока в пуле есть
          // живые деньги. Просим дашборд подменить активный ключ и повторяем ТОТ ЖЕ
          // запрос — Claude Code видит только успешный ответ.
          const reason = ROTATE_ON ? rotateReason(status, buf) : null;
          if (reason) {
            // Ротация уже идёт (её начал параллельный мульти-дубль) — эта попытка
            // просто уходит: запрос доведёт та, что стартует после подмены.
            if (rotating) { activeSet.delete(upReq); return; }
            if (rotations < MAX_ROTATIONS) {
              tryRotate(upReq, reason, buf, status, sentKey, () => forwardBuffered(buf, headers));
              return;
            }
            log(`${req.method} ${reqPath} ${status} «${reason}»: лимит ротаций ${MAX_ROTATIONS} на запрос исчерпан — отдаю ошибку клиенту`);
          }
          // ── «Нет такой модели» — лечится подменой модели, а не повтором ──────────
          // Шлюз сказал, что модели из карты у него нет ни на одном канале. Повтор
          // канал не создаст, но и умирать рано: у шлюза почти наверняка есть другая
          // модель того же класса. Обновляем каталог принудительно (карта могла
          // устареть минуту назад — 03.09 justwoker снял claude-opus-4-8 на ходу),
          // пересобираем ремап и, если цель сменилась, повторяем запрос уже живой
          // моделью. Клиент видит только успешный ответ.
          if (ROUTE_MISS_RE.test(buf.toString('utf8')) && !routeFixTried) {
            routeFixTried = true;
            activeSet.delete(upReq);
            const wasModel = modelInBody(body);
            log(`${req.method} ${reqPath} ${status} «нет модели ${wasModel}» — обновляю каталог шлюза и ищу замену`);
            refreshCatalog(true, () => {
              if (finished || aborted) return;
              const again = remapHaiku(req.method, reqPath, rawBody);
              const nextBody = again ? again.body : rawBody;
              const nextModel = modelInBody(nextBody);
              if (nextModel && nextModel !== wasModel) {
                reqBody = nextBody;
                tgt = again;
                bonusAttempts += 1;   // подмена модели не должна съедать бюджет ретраев
                log(`${req.method} ${reqPath} подмена модели: ${wasModel} → ${nextModel}, повторяю`);
                makeUpstream('другая модель');
                return;
              }
              log(`${req.method} ${reqPath} замены нет: у ${upstream.host} нет ни одной подходящей модели — отдаю ошибку клиенту`);
              forwardBuffered(buf, headers);
            });
            return;
          }
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

    ctrace = traceConn(upReq, t.requester);
    activeSet.add(upReq);
    upReq.__attempt = attempt;
    upReq.__kind = kindLabel;
    upReq.on('timeout', () => {
      if (finished || aborted) return;
      // Трассировку печатаем и здесь: висящий запрос до колбэка ответа не доходит, а
      // именно он и есть симптом «после простоя не раздупляет».
      log(`${req.method} ${reqPath} upstream timeout ${cfg.upstreamTimeoutMs}ms (attempt ${attempt})`
        + (CONN_TRACE && ctrace ? ` · conn: ${fmtConn(ctrace)}` : ''));
      upReq.destroy(new Error('upstream timeout'));
    });
    upReq.on('error', (err) => {
      if (finished || aborted || res.destroyed) { activeSet.delete(upReq); return; }
      // Обрыв на сокете ИЗ ПУЛА — подпись отмершего keep-alive соединения: апстрим закрыл
      // его молча, пока мы простаивали, и узнали мы об этом только записью в трубу.
      log(`${req.method} ${reqPath} upstream error (attempt ${attempt}): ${err.message}`
        + (CONN_TRACE && ctrace ? ` · conn: ${fmtConn(ctrace)}` : ''));
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
    const rawBody0 = Buffer.concat(bodyChunks, bodySize);
    rawBody = rawBody0;
    // Каталог моделей шлюза освежаем в фоне, НЕ дожидаясь: этот запрос уедет по той
    // карте, что есть. Точный момент, когда каталог нужен, — ответ model_not_found.
    if (catalogStale()) refreshCatalog(false);
    // Модель ДО ремапа — её ждёт клиент в ответе (см. rewriteModelJson).
    try { clientModel = String(JSON.parse(rawBody0.toString('utf8') || '{}').model || ''); } catch (e) { clientModel = ''; }
    const remapped = remapHaiku(req.method, reqPath, rawBody0);
    reqBody = remapped ? remapped.body : rawBody;
    tgt = remapped;
    if (remapped) stats.remaps += 1;
    streaming = wantsStream(req.method, reqPath, req.headers, reqBody);
    // Пре-коммит (v1tusha): открываем SSE клиенту только после cfg.preCommitMs
    // тишины от upstream, не сразу. 0 = отложенный пре-коммит выключен.
    if (streaming && cfg.preCommitMs > 0 && preTimer === null) {
      preTimer = setTimeout(commitSSE, cfg.preCommitMs);
    }
    // Не-стримовый запрос за сообщением (`/compact` и всё, что просит готовый JSON):
    // пингов там быть не может, поэтому через jsonHoldMs начинаем капать пробел.
    // count_tokens сюда не попадает — на него прокси отвечает локально и мгновенно.
    if (!streaming && cfg.jsonHoldMs > 0 && jsonTimer === null
        && req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(reqPath) && !isCountTokens(req.method, reqPath)) {
      jsonTimer = setTimeout(commitJson, cfg.jsonHoldMs);
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
      // Маппинг тира на gpt-цель БЕЗ конвертера: цель уважаем (тело переписано), но
      // отдаём её своему же шлюзу — уводить на чужой :20132 нельзя. Ассерт правлен
      // 22.08: ждал null, хотя remapHaiku эту ветку обрабатывает явно (см. там
      // «Конвертера нет — маппинг уважаем, но модель отдаём своему же шлюзу»).
      // Из-за расхождения весь selftest падал ДО остальных проверок.
      assert.strictEqual(hb && hb.host, upstream.host, 'gpt-цель haiku без конвертера идёт на свой шлюз');
      assert.ok(hb && hb.body.toString('utf8').includes(`"model":"${mapHaiku}"`), 'тело переписано на gpt-цель');
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

  // ── 522 от Cloudflare: структурные поля решают, а не проза ───────────────────
  // Инцидент 23.08: тело содержало `owner_action_required`, слово `required` попадало
  // в RETRY_NO, ошибка считалась постоянной, ретрая не было — агенты легли.
  const cf522 = JSON.stringify({
    success: false, retryable: true, retry_after: 120,
    error_category: 'origin',
    errors: [{ code: 'owner_action_required', message: 'Web server is down (Error 522)' }],
  });
  assert.strictEqual(isTransientBody(522, Buffer.from(cf522)), true,
    '522 с retryable:true ретраим, несмотря на owner_action_required в теле');
  // Тот же текст БЕЗ структурных полей больше не ловится словарём: lookbehind
  // отсекает `*_required`, оставляя честное «field is required».
  assert.strictEqual(isTransientBody(522, Buffer.from('owner_action_required: Web server is down')), true,
    'owner_action_required без полей больше не считается постоянной');
  assert.strictEqual(isTransientBody(400, Buffer.from('field model is required')), false,
    '«field is required» по-прежнему постоянная');
  // retryable:false — уважаем, даже если проза выглядит транзиентной.
  assert.strictEqual(isTransientBody(503, Buffer.from('{"retryable":false,"error":{"message":"service unavailable"}}')), false,
    'retryable:false сильнее словаря RETRY_OK');
  // Поле внутри error, а не в корне.
  assert.strictEqual(isTransientBody(500, Buffer.from('{"error":{"retryable":true,"message":"bad request"}}')), true,
    'retryable внутри error читается и бьёт RETRY_NO');
  // Категории.
  assert.strictEqual(isTransientBody(502, Buffer.from('{"error_category":"origin"}')), true, 'категория origin = транзиентная');
  assert.strictEqual(isTransientBody(500, Buffer.from('{"error_category":"configuration"}')), false, 'категория configuration = постоянная');
  // Не-JSON и мусор не должны ронять классификатор.
  assert.strictEqual(structuredRetry('<html>502 Bad Gateway</html>'), null, 'не-JSON → решают словари');
  assert.strictEqual(structuredRetry('null'), null, 'JSON null → решают словари');
  assert.strictEqual(retryAfterSec(cf522), 120, 'retry_after читается');
  assert.strictEqual(retryAfterSec('не json'), null, 'retry_after из мусора — null');

  // ── авторотация: отказ по деньгам ловится в ОБЕИХ формулировках ──────────────
  // Это те самые два текста, которые до ротации вели в разные тупики: китайский
  // улетал клиенту как 403, английский жёг три попытки и отдавал 502.
  const ZH_OOB = '{"error":{"message":"预扣费额度失败, 用户剩余额度: $0.309854, 需要预扣费额度: $0.800000 (request id: 2026)"}}';
  const EN_OOB = '{"error":{"type":"bad_response_status_code","message":"Insufficient account balance (request id: 2026)"}}';
  assert.strictEqual(rotateReason(403, Buffer.from(ZH_OOB)), 'out-of-balance', 'zh предоплата не прошла = нет баланса');
  assert.strictEqual(rotateReason(403, Buffer.from(EN_OOB)), 'out-of-balance', 'en Insufficient balance = нет баланса');
  assert.strictEqual(rotateReason(402, Buffer.from('余额不足')), 'out-of-balance', '402 + 余额不足 = нет баланса');
  // Числа из китайского текста: по ним выбирается кандидат и уточняется кеш баланса.
  assert.strictEqual(neededUsd(ZH_OOB), 0.8, 'нужно $0.80 распарсилось');
  assert.strictEqual(leftUsd(ZH_OOB), 0.309854, 'осталось $0.31 распарсилось');
  assert.strictEqual(neededUsd(EN_OOB), null, 'у английского текста цифр нет — это не ошибка');
  // Третья формулировка — англоязычный перевод той же китайской предоплаты (`预扣费额度失败`
  // дословно и есть «pre-consume quota failed»). Поймана живьём 22.08 дважды: не совпадала
  // ни с одним списком, зато RETRY_NO матчил слово `quota` → «постоянная ошибка» → 403 в
  // лицо. Доллар в ней ПОЛНОШИРИННЫЙ (U+FF04), из-за чего суммы молча не читались, а это
  // хуже несовпадения: планка кандидата падала до MONEY_MIN_BAL и ротация шла в тот же тупик.
  const EN_PRE = '{"error":{"message":"pre-consume quota failed, user quota: ＄0.055238, need quota: ＄1.797580 (request id: 20260822132728743038807xq9qve9y9lsyJ)"}}';
  assert.strictEqual(rotateReason(403, Buffer.from(EN_PRE)), 'out-of-balance', 'en предоплата не прошла = нет баланса');
  assert.strictEqual(neededUsd(EN_PRE), 1.79758, 'нужно $1.80 прочитано из полноширинного ＄');
  assert.strictEqual(leftUsd(EN_PRE), 0.055238, 'осталось $0.055 — метка user quota не перехлестнулась с need quota');
  assert.strictEqual(rotateReason(200, Buffer.from(EN_PRE)), null, 'эхо английской формулировки в 200 — не отказ');
  // Слово `quota` само по себе деньгами не является: у New-API так же звучат «нет прав на
  // модель» и лимит запросов. Ротация на них крутила бы пул зря, не вылечив запрос.
  assert.strictEqual(rotateReason(403, Buffer.from('{"error":{"message":"quota exceeded for this model"}}')), null, 'просто quota ≠ нет денег');
  // Мёртвый ключ — тоже причина уйти, но с другой пометкой (аккаунт → dead).
  assert.strictEqual(rotateReason(403, Buffer.from('{"error":{"message":"User has been banned"}}')), 'dead', 'бан = мёртвый ключ');
  assert.strictEqual(rotateReason(401, Buffer.from('无效的令牌')), 'dead', 'zh невалидный токен = мёртвый ключ');
  // НЕ ротируем на том, что деньгами не является: нет доступа к модели, фильтр
  // контента, транзиентная 500, WAF. Иначе подмена аккаунта ничего не лечит, а
  // пул прокручивается зря.
  assert.strictEqual(rotateReason(403, Buffer.from('该令牌无权访问模型 claude-haiku-4-5')), null, 'нет прав на модель ≠ нет денег');
  assert.strictEqual(rotateReason(403, Buffer.from('unauthorized client detected')), null, 'WAF ≠ нет денег');
  assert.strictEqual(rotateReason(500, Buffer.from(EN_OOB)), null, 'фраза при 500 не считается отказом по деньгам');
  assert.strictEqual(rotateReason(200, Buffer.from(ZH_OOB)), null, 'эхо текста в 200 не считается отказом');
  // Цель звонка выводится из апстрима, а не из env (спавнов прокси три, env разъезжался).
  assert.strictEqual(GW_BY_HOST['gorouter.app'], 'go', 'gorouter.app → пул go');
  assert.strictEqual(GW_BY_HOST['agentrouter.org'], 'ar', 'agentrouter.org → пул ar');
  assert.strictEqual(GW_BY_HOST['api.justwoker.icu'], 'jw', 'api.justwoker.icu (с поддоменом!) → пул jw');
  assert.strictEqual(GW_BY_HOST['seekai.cc'], 'sk', 'seekai.cc → пул sk');
  assert.ok(FLAT_RATE_HOSTS.has('seekai.cc'), 'seekai.cc в плоских тарифах — мульти-запрос выключен (замер 24.08: ~3.2¢ за вызов)');
  assert.strictEqual(GW_BY_HOST['api.hcnsec.cn'], 'hn', 'api.hcnsec.cn (с поддоменом!) → пул hn');
  assert.ok(!FLAT_RATE_HOSTS.has('api.hcnsec.cn'), 'hcnsec тарифицируется по токенам, не за запрос — в плоских его быть не должно');
  assert.strictEqual(GW_BY_HOST['api.anthropic.com'], undefined, 'чужой хост → ротации нет');

  // publicState отдаёт апстрим и пре-коммит, без сюрпризов
  const pub = publicState();
  assert.strictEqual(pub.upstream, UPSTREAM, 'publicState отдаёт upstream');
  assert.strictEqual(typeof pub.uptime_ms, 'number', 'publicState отдаёт uptime_ms');
  assert.strictEqual(pub.rotate.provider, ROTATE_PROVIDER || null, 'publicState отдаёт пул ротации');

  // wantsStream: пре-коммит заголовков имеет смысл только для стримовых запросов
  assert.strictEqual(wantsStream('POST', '/v1/messages', {}, Buffer.from('{"model":"x","stream":true}')), true, 'stream:true = поток');
  assert.strictEqual(wantsStream('POST', '/v1/messages', {}, Buffer.from('{"model":"x"}')), false, 'без stream = не поток');
  assert.strictEqual(wantsStream('POST', '/v1/messages', { accept: 'text/event-stream' }, Buffer.alloc(0)), true, 'accept SSE = поток');
  assert.strictEqual(wantsStream('POST', '/v1/messages', {}, Buffer.from('not json')), false, 'не-JSON = не поток');
  assert.strictEqual(wantsStream('GET', '/v1/messages', {}, Buffer.alloc(0)), false, 'GET = не поток');

  // Ручки мульти-запроса/пре-коммита на лету: применяются, мусор игнорируется, дурь зажимается.
  applyPatch({ hedgeMs: 7000, maxAttempts: 4, preCommitMs: 12000 });
  assert.strictEqual(cfg.hedgeMs, 7000, 'hedgeMs применился');
  assert.strictEqual(cfg.maxAttempts, 4, 'maxAttempts применился');
  assert.strictEqual(cfg.preCommitMs, 12000, 'preCommitMs применился');
  applyPatch({ hedgeMs: 5, maxAttempts: 999, preCommitMs: 999999 }); // опечатка -> зажимаем
  assert.strictEqual(cfg.hedgeMs, 1000, 'hedgeMs зажат по нижней границе');
  assert.strictEqual(cfg.maxAttempts, 10, 'maxAttempts зажат по верхней границе');
  assert.strictEqual(cfg.preCommitMs, 120000, 'preCommitMs зажат по верхней границе');
  // Таймаут апстрима — такая же крутилка, и у неё свои границы. Нижняя (20с) важнее
  // верхней: порог ниже наблюдённого честного молчания 65.8с рвал бы живые запросы.
  applyPatch({ upstreamTimeoutMs: 1000 });
  assert.strictEqual(cfg.upstreamTimeoutMs, 20000, 'таймаут зажат по нижней границе');
  applyPatch({ upstreamTimeoutMs: 9999999 });
  assert.strictEqual(cfg.upstreamTimeoutMs, 600000, 'таймаут зажат по верхней границе');
  applyPatch({ upstreamTimeoutMs: 150000 });
  assert.strictEqual(cfg.upstreamTimeoutMs, 150000, 'валидный таймаут применяется');
  applyPatch({ upstreamTimeoutMs: 300000 });
  assert.strictEqual(cfg.upstreamTimeoutMs, 300000, 'поставочные 300с применяются');
  applyPatch({ upstreamTimeoutMs: 'нет' });
  assert.strictEqual(cfg.upstreamTimeoutMs, 300000, 'мусор в таймауте игнорируется');
  // 🪤 `0` таймаут НЕ выключает (в отличие от мульти-запроса и пре-коммита): `allowZero: false`,
  // и ноль зажимается в нижнюю границу. Так и надо — «ждать вечно» это то, от чего
  // мы уходим, и случайный ноль из UI не должен возвращать прежние 10 минут.
  applyPatch({ upstreamTimeoutMs: 0 });
  assert.strictEqual(cfg.upstreamTimeoutMs, 20000, '0 не выключает таймаут, а зажимается в минимум');
  assert.strictEqual(DEFAULT_CFG.upstreamTimeoutMs, 300000, 'поставочный таймаут 300с — по замерам хендоффа (n=529), не 150с');
  applyPatch({ hedgeMs: 'нет' });
  assert.strictEqual(cfg.hedgeMs, 1000, 'мусор в hedgeMs игнорируется');
  applyPatch({ hedgeMs: 0 });
  assert.strictEqual(cfg.hedgeMs, 0, '0 выключает мульти-запрос');
  applyPatch({ preCommitMs: 0 });
  assert.strictEqual(cfg.preCommitMs, 0, '0 выключает пре-коммит');

  // ── Промах маршрута и удержание (2026-09-03) ────────────────────────────────
  // Живое тело с justwoker за 03.09: 179 смертей из 220 пришлись ровно на него.
  const ROUTE_MISS_BODY = '{"error":{"code":"model_not_found","message":"No available channel for model claude-opus-4-8 under group g"}}';
  assert.strictEqual(isTransientBody(503, Buffer.from(ROUTE_MISS_BODY)), false,
    'model_not_found — промах маршрута, повтор канала не создаёт');
  assert.strictEqual(isTransientBody(503, Buffer.from('{"error":{"message":"当前分组下无可用渠道"}}')), false,
    'та же ошибка по-китайски (无可用渠道) тоже постоянная');
  // 🪤 Регресс на причину бага: раньше решал fallback `status >= 500`, потому что в теле
  // `No available channel`, а в словаре RETRY_OK — `unavailable`. Подстроки разные.
  assert.ok(!RETRY_OK.test(ROUTE_MISS_BODY) && !RETRY_NO.test(ROUTE_MISS_BODY),
    'ни один словарь эту формулировку не ловит — ловить её обязан отдельный класс');
  assert.strictEqual(isTransientBody(503, Buffer.from('{"retryable":true,"error":{"code":"model_not_found"}}')), true,
    'явный retryable:true шлюза сильнее нашей догадки про промах маршрута');

  applyPatch({ holdMs: 90000 });
  assert.strictEqual(cfg.holdMs, 90000, 'holdMs применился');
  applyPatch({ holdMs: 10 });
  assert.strictEqual(cfg.holdMs, 5000, 'holdMs зажат по нижней границе (окно короче 5с — иллюзия защиты)');
  applyPatch({ holdMs: 9999999 });
  assert.strictEqual(cfg.holdMs, 600000, 'holdMs зажат по верхней границе');
  applyPatch({ holdMs: 'нет' });
  assert.strictEqual(cfg.holdMs, 600000, 'мусор в holdMs игнорируется');
  applyPatch({ holdMs: 0 });
  assert.strictEqual(cfg.holdMs, 0, '0 выключает удержание — откат без рестарта процесса');
  assert.strictEqual(DEFAULT_CFG.holdMs, 120000, 'поставочное окно удержания 120с');
  applyPatch({ emptyStreamMs: 90000 });
  assert.strictEqual(cfg.emptyStreamMs, 90000, 'emptyStreamMs применился');
  applyPatch({ emptyStreamMs: 1000 });
  assert.strictEqual(cfg.emptyStreamMs, 30000, 'emptyStreamMs зажат по нижней границе');
  applyPatch({ emptyStreamMs: 0 });
  assert.strictEqual(cfg.emptyStreamMs, 0, '0 выключает страховку от пустого потока');
  assert.strictEqual(DEFAULT_CFG.emptyStreamMs, 180000,
    'поставочные 180с — с запасом над честным максимумом ответа 159.6с из хендоффа');
  assert.ok(CFG_VERSION >= 4, 'версия конфига поднята под holdMs (иначе поле не доедет до тех, кто нажимал «Применить»)');

  // Инварианты удержания — проверяем по исходнику: сцену с живым обрывом гоняет
  // tools/check-hold-window.js, а здесь фиксируем то, что нельзя нарушить правкой.
  const holdSrc = fs.readFileSync(__filename, 'utf8');
  // Главный инвариант: переигрывать можно только пока клиенту не ушло содержимое.
  // Признак этого — `!finished`: после settle() стоит finished, и attemptDone не зовётся.
  assert.ok(/const canHold = \(\) => cfg\.holdMs > 0 && !finished/.test(holdSrc),
    'удержание разрешено только до выбора победителя (!finished = клиенту не ушло дельт)');
  assert.ok(/holdLaunches < HOLD_MAX_LAUNCHES/.test(holdSrc),
    'у удержания есть потолок повторов — на плоском тарифе каждая дошедшая попытка платная');
  assert.ok(/probePath\(t\.hostname, t\.port/.test(holdSrc),
    'перед повтором проверяем путь, а не стреляем в мёртвую сеть');
  assert.ok(/bonusAttempts \+= 1;\n\s*log\(`\$\{req\.method\} \$\{reqPath\} путь до/.test(holdSrc),
    'подаренная удержанием попытка не съедает бюджет ретраев на транзиентную 500');
  // Форма отказа: 529 overloaded_error, а не 502 proxy_error — иначе подагент умирает
  // вместо того, чтобы повторить сам.
  assert.ok(/res\.writeHead\(529, \{ 'content-type': 'application\/json; charset=utf-8', 'retry-after': '5' \}\)/.test(holdSrc),
    'сдаёмся до пре-коммита с 529 и retry-after');
  assert.ok(/type: 'overloaded_error'/.test(holdSrc), 'тело отказа — overloaded_error (повторяемый класс)');

  // ── Умный маппинг: карта это пожелание, каталог шлюза — факт (2026-09-03) ────
  // Живой случай: justwoker снял `claude-opus-4-8`, на который смотрели тиры
  // sonnet/haiku, и отдавал по /v1/models только две модели.
  const JW_MAP = { opus: 'claude-opus-5', sonnet: 'claude-opus-4-8', haiku: 'claude-opus-4-8' };
  catalog.ids = null; catalog.at = 0;
  assert.strictEqual(catalogHas('что угодно'), null, 'без каталога не судим о моделях вообще');
  assert.strictEqual(availableTarget('sonnet', 'claude-opus-4-8', 'claude-sonnet-5[1m]', JW_MAP), null,
    'нет каталога — карту не трогаем (иначе подменяли бы наугад)');
  catalog.ids = new Set(['claude-opus-5', 'claude-opus-5-thinking']);
  catalog.at = Date.now();
  assert.strictEqual(availableTarget('sonnet', 'claude-opus-4-8', 'claude-sonnet-5[1m]', JW_MAP), 'claude-opus-5',
    'мёртвая цель тира заменяется на живую цель соседнего тира из той же карты');
  assert.strictEqual(availableTarget('opus', 'claude-opus-5', 'claude-opus-5[1m]', JW_MAP), null,
    'живую цель не подменяем');
  // Замена берётся из каталога и когда соседние тиры тоже мертвы.
  assert.strictEqual(availableTarget('haiku', 'claude-opus-4-8', 'claude-haiku-4-5', { opus: 'нет-такой', sonnet: '', haiku: 'claude-opus-4-8' }), 'claude-opus-5',
    'все цели карты мертвы — берём claude-модель из каталога шлюза');
  // Клиентская модель — тоже кандидат, если шлюз её знает.
  assert.strictEqual(availableTarget('sonnet', 'нет-такой', 'claude-opus-5[1m]', { opus: '', sonnet: 'нет-такой', haiku: '' }), 'claude-opus-5',
    'суффикс окна срезается, и модель клиента годится в кандидаты');
  // Каталог без единой claude-модели: подменять нечем, и выдумывать нельзя.
  // 🪤 Соблазн «взять что угодно из каталога» отвергнут намеренно: gpt-модель в ответ на
  // claude-тир поедет через конвертер и может сломать tool use, а карта тиров у владельца
  // осознанная. Честная ошибка лучше молчаливой подмены семейства.
  catalog.ids = new Set(['gpt-5.6-sol']);
  assert.strictEqual(availableTarget('sonnet', 'claude-opus-4-8', 'claude-sonnet-5', { opus: '', sonnet: 'claude-opus-4-8', haiku: '' }), null,
    'нечем заменить внутри семейства — не подменяем вовсе');
  catalog.ids = null; catalog.at = 0;   // не оставляем каталог селфтеста живому процессу
  // Выключатель: `catalogTtlMs: 0` возвращает поведение «строго по карте», как до 04.09.
  catalog.ids = new Set(['claude-opus-5']);
  catalog.at = Date.now();
  applyPatch({ catalogTtlMs: 0 });
  assert.strictEqual(cfg.catalogTtlMs, 0, '0 выключает каталог');
  assert.strictEqual(catalogHas('claude-opus-4-8'), null, 'с выключенным каталогом о моделях не судим');
  assert.strictEqual(availableTarget('sonnet', 'claude-opus-4-8', 'claude-sonnet-5', JW_MAP), null,
    'с выключенным каталогом подмен нет вообще — откат без рестарта');
  assert.strictEqual(catalogStale(), false, 'выключенный каталог не пытается обновляться');
  applyPatch({ catalogTtlMs: 600000 });
  assert.strictEqual(cfg.catalogTtlMs, 600000, 'ручка возвращается');
  catalog.ids = null; catalog.at = 0;
  const routeSrc = holdSrc;
  assert.ok(/if \(ROUTE_MISS_RE\.test\(buf\.toString\('utf8'\)\) && !routeFixTried\)/.test(routeSrc),
    'на «нет такой модели» пробуем подмену, и ровно один раз за запрос');
  assert.ok(/refreshCatalog\(true, \(\) => \{/.test(routeSrc),
    'каталог перед подменой обновляется принудительно (модель могли снять минуту назад)');
  assert.ok(/if \(catalogStale\(\)\) refreshCatalog\(false\)/.test(routeSrc),
    'в обычном пути каталог освежается в фоне и запрос не блокирует');

  // ── Пустой поток: заголовки есть, содержимого нет (2026-09-03, 21:13 kktoken) ──
  // Инварианты переигровки: только пока содержимого не было, с потолком, и со снятием
  // «победителя» — иначе makeUpstream упрётся в finished и повтор не стартует.
  assert.ok(/if \(contentSent \|\| aborted \|\| cfg\.emptyStreamMs <= 0\) return false;/.test(holdSrc),
    'переигрываем пустой поток только пока клиенту не ушло содержимое');
  assert.ok(/if \(emptyRetries >= EMPTY_MAX_RETRIES\) return false;/.test(holdSrc),
    'у переигровки пустого потока есть потолок');
  assert.ok(/finished = false;.*\n\s*winner = null;/.test(holdSrc),
    'пустой победитель снимается, иначе повтор не стартует');
  assert.ok(/if \(!contentSent\) \{ contentSent = true; clearEmptyGuard\(\); \}/.test(holdSrc),
    'первый байт содержимого закрывает страховку — дальше поток неприкосновенен');
  assert.strictEqual((holdSrc.match(/armEmptyGuard\(stream\);/g) || []).length, 2,
    'страховка ставится на обеих SSE-ветках: и после пре-коммита, и на прямом ответе');
  assert.ok(/clientSSE = true;\n\s*armEmptyGuard\(stream\);/.test(holdSrc),
    'на прямой SSE-ветке канал помечается открытым — иначе повтор полез бы писать заголовки заново');
  // ── Удержание не-стримового запроса пробелами (2026-09-04) ──────────────────
  applyPatch({ jsonHoldMs: 20000 });
  assert.strictEqual(cfg.jsonHoldMs, 20000, 'jsonHoldMs применился');
  applyPatch({ jsonHoldMs: 100 });
  assert.strictEqual(cfg.jsonHoldMs, 3000, 'jsonHoldMs зажат по нижней границе');
  applyPatch({ jsonHoldMs: 0 });
  assert.strictEqual(cfg.jsonHoldMs, 0, '0 выключает JSON-удержание (поведение как до 04.09)');
  assert.strictEqual(DEFAULT_CFG.jsonHoldMs, 15000,
    'поставочные 15с — по замеру 137 не-стримовых ответов: быстрее 15с только 24 из них, '
    + 'а путь giveUp успевает отдать честный 529 до коммита');
  assert.strictEqual(CFG_VERSION, 5, 'версия конфига поднята под три новых поля');
  // Ведущие пробелы перед значением — легальный JSON, на этом стоит весь приём.
  assert.deepStrictEqual(JSON.parse('   {"type":"message"}'), { type: 'message' },
    'JSON.parse съедает ведущие пробелы — иначе капать было бы нельзя');
  // Взвод только на POST /v1/messages без stream и не на count_tokens.
  assert.ok(/if \(!streaming && cfg\.jsonHoldMs > 0 && jsonTimer === null/.test(holdSrc),
    'JSON-удержание взводится только для не-стримового запроса');
  assert.ok(/!isCountTokens\(req\.method, reqPath\)\)[\s\S]{0,40}?jsonTimer = setTimeout\(commitJson/.test(holdSrc),
    'count_tokens под удержание не попадает — на него отвечаем локально и мгновенно');
  // Коммит НЕ ставит content-length: длину тела мы в этот момент не знаем.
  const commitJsonSrc = (holdSrc.match(/const commitJson = \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  assert.ok(/res\.writeHead\(200, \{[\s\S]*?\}\);/.test(commitJsonSrc), 'коммит JSON пишет заголовки');
  assert.ok(!/content-length/i.test(commitJsonSrc),
    'при коммите JSON content-length не выставляется (тело дописывается позже)');
  assert.ok(/res\.write\(' '\)/.test(commitJsonSrc), 'первая капля уходит сразу при коммите');
  // После коммита 200 объект ошибки с кодом 200 отдавать нельзя — только обрыв.
  assert.ok(/const jsonHoldFail = \(why\) => \{[\s\S]*?res\.destroy\(\);/.test(holdSrc),
    'отказ после коммита JSON — обрыв, а не 200 с телом ошибки');
  assert.ok(/if \(clientJSON\)[\s\S]{0,30}?jsonHoldFail\(why\);/.test(holdSrc),
    'giveUp знает про открытый JSON');

  // Вставший посреди ответа поток: переигрывать нельзя, но и висеть вечно нельзя.
  applyPatch({ stallMs: 240000 });
  assert.strictEqual(cfg.stallMs, 240000, 'stallMs применился');
  applyPatch({ stallMs: 1000 });
  assert.strictEqual(cfg.stallMs, 30000, 'stallMs зажат по нижней границе');
  applyPatch({ stallMs: 0 });
  assert.strictEqual(cfg.stallMs, 0, '0 выключает страховку от вставшего потока');
  assert.strictEqual(DEFAULT_CFG.stallMs, 180000, 'поставочные 180с');
  assert.strictEqual((holdSrc.match(/armStall\(stream\);/g) || []).length, 2,
    'страховка перевзводится на обеих SSE-ветках, то есть на каждом байте содержимого');
  assert.ok(/armStall = \(stream\) => \{[\s\S]*?res\.destroy\(\);/.test(holdSrc),
    'вставший поток рвётся: вызывающий увидит ошибку вместо бесконечного ожидания');

  // 🪤 Наш таймаут сокета в этой сцене бесполезен: после заголовков стоит finished, а
  // обработчик timeout под этим флагом выходит молча. Значит страховка обязана быть своя.
  assert.ok(/upReq\.on\('timeout', \(\) => \{\s*\n\s*if \(finished \|\| aborted\) return;/.test(holdSrc),
    'upstreamTimeoutMs не спасает начатый поток — это и есть причина отдельной страховки');

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
// Гвоздь после чтения конфига: даже если в json лежит maxHedges от прошлых
// экспериментов (или его вписали руками), на плоскотарифном шлюзе дубли не поедут.
if (clampPaidHedge('старт')) saveConfig();

server.keepAliveTimeout = 0;   // не убивать долгие SSE-соединения (v1tusha)
server.headersTimeout = 0;
server.setTimeout(0);
server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) { if (!socket.destroyed) socket.destroy(); return; }
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM} (idle ${IDLE_MS}ms, попыток ${cfg.maxAttempts} x ${RETRY_DELAY_MS}ms, мульти-запрос ${hedgeOff(cfg) ? 'выкл' : cfg.hedgeMs + 'ms (дублей ≤' + cfg.maxHedges + ')'}, пре-коммит ${cfg.preCommitMs ? cfg.preCommitMs + 'ms' : 'off'}, upstream_timeout ${cfg.upstreamTimeoutMs}ms, удержание ${cfg.holdMs ? cfg.holdMs + 'ms (≤' + HOLD_MAX_LAUNCHES + ' повторов)' : 'выкл'}, пустой поток ${cfg.emptyStreamMs ? cfg.emptyStreamMs + 'ms (≤' + EMPTY_MAX_RETRIES + ')' : 'выкл'}, каталог моделей ${cfg.catalogTtlMs ? cfg.catalogTtlMs + 'ms' : 'выкл (строго по карте)'}, JSON-удержание ${cfg.jsonHoldMs ? cfg.jsonHoldMs + 'ms' : 'выкл'}, вставший поток ${cfg.stallMs ? cfg.stallMs + 'ms' : 'выкл'})`);

  log(`gpt-конвертер: ${GPT_PROXY_ENABLED ? HAIKU_GPT_PROXY : 'off (чужой шлюз — gpt остаётся на ' + upstream.host + ')'}`);
  // Каталог моделей шлюза греем на старте: тогда первый же запрос с мёртвой целью тира
  // уедет уже подменённым, без круга через 503.
  refreshCatalog(true);
});
