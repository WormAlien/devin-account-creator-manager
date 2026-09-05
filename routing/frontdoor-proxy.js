// frontdoor-proxy.js — фиксированный вход Claude Code (:20100).
//
// Зачем: `env` из ~/.claude/settings.json Claude Code читает ОДИН раз, при старте
// процесса. Пока переключение провайдера меняло ANTHROPIC_BASE_URL, каждый свич
// требовал новой сессии CC — а с Orca, где одновременно живёт несколько pty с
// `claude`, это означало перезапуск всех терминалов.
//
// Поэтому base URL больше не меняется (навсегда http://127.0.0.1:20100), а выбор
// бэкенда переехал в файл состояния ~/.claude/active-backend.json, который этот
// прокси перечитывает по mtime на каждый запрос.
//
// Контракт (docs/frontdoor-concept.md):
//   • ЛОКАЛЬНЫЙ апстрим (keepalive :2013x/:2015x, конвертеры :2013x) — чистый релей:
//     заголовки клиента без изменений, ключ не трогаем, тело не трогаем. Ключ там
//     инжектит keepalive (keepalive-proxy.js:771), маппинг тиров тоже его.
//   • УДАЛЁННЫЙ апстрим (бывшие apiKeyHelper-режимы) — читаем ключ из
//     ~/.claude/<keyFile> на каждый запрос (смена ключа на лету, авто-ротация
//     FreeModel), ставим authorization+x-api-key, срезаем суффикс окна [1m] и
//     применяем <p>-modelmap.json по mtime.
//   • НЕ ретраим и не хеджируем (это делает keepalive; дубль сожжёт платный запрос),
//     НЕ конвертим Anthropic→OpenAI (это :20130/:20131/:20132), НЕ отвечаем сами на
//     count_tokens (локальную оценку даёт keepalive), НЕ логируем ключи.
//   • Нет/битый state → 503 с внятным телом, а не молчаливый уход на дефолт.
//
// Слушаем ТОЛЬКО 127.0.0.1: прокси инжектит реальные ключи, на 0.0.0.0 это открытый релей.
//
//   PORT=20100 node frontdoor-proxy.js
//   node frontdoor-proxy.js selftest     # самопроверка, порт не занимает
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');

const PORT = Number(process.env.PORT || 20100);
const LOG_FILE = process.env.LOG_FILE || '';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000);
const STATE_FILE = process.env.ACTIVE_BACKEND_FILE
    || path.join(os.homedir(), '.claude', 'active-backend.json');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { createLogger } = require('./proxy-logger.js');
const { logLine } = createLogger('frontdoor');
const { createTap } = require('./usage-tap.js');
const startedAt = Date.now();

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stderr.write(line);
    if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ } }
    logLine(msg);
}

// ── Состояние: единственный источник правды об активном бэкенде ───────────────
// Апстрим уже разрешён дашбордом (transparent-proxy.js → writeSettings), поэтому
// здесь НЕТ таблицы провайдеров и знания о портах: прокси только форвардит.
const stateCache = { mtime: 0, state: null, error: 'state ещё не читался' };

function parseState(raw) {
    const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    const upstream = String(doc.upstream || '').trim();
    if (!upstream) throw new Error('в active-backend.json нет upstream');
    const u = new URL(upstream);        // бросит на мусоре — поймает вызывающий
    if (!/^https?:$/.test(u.protocol)) throw new Error(`upstream не http(s): ${upstream}`);
    return {
        backend: String(doc.backend || '').trim() || 'unknown',
        upstream,
        url: u,
        local: isLocalHost(u.hostname),
        keyFile: doc.keyFile ? String(doc.keyFile) : null,
        modelmap: doc.modelmap ? String(doc.modelmap) : null,
        updatedAt: Number(doc.updatedAt) || 0,
    };
}

function isLocalHost(h) {
    return /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?|0\.0\.0\.0)$/i.test(String(h || ''));
}

// Локальный апстрим бьём строго в IPv4. `localhost` на Windows разрешается в ::1
// ПЕРВЫМ, а connect в IPv6-loopback, где никто не слушает, отдаёт EACCES вместо
// ECONNREFUSED (замерено 2026-08-20: net.connect('::1',20156) → EACCES,
// ('127.0.0.1',20156) → ECONNREFUSED). Пока прокси жив, happy-eyeballs это прячет —
// ::1 отваливается, IPv4 отвечает; но стоит прокси умереть, и упавший бэкенд
// выглядит как загадочный «502 front-door → gorouter: EACCES» вместо «не слушает».
// Все наши прокси слушают 127.0.0.1, так что терять нечего — заодно уходит
// лишний ::1-заход на каждом соединении.
function connectHost(hostname, local) {
    return local && /^(localhost|0\.0\.0\.0)$/i.test(String(hostname)) ? '127.0.0.1' : hostname;
}

// Локальный апстрим не отвечает на connect = процесса нет. Код при этом зависит от
// стека (ECONNREFUSED на IPv4, EACCES на ::1, ETIMEDOUT если порт съел файрвол) —
// подсказка одна на все, иначе юзер читает код ошибки и идёт искать причину в CC.
const UPSTREAM_DOWN = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL',
]);

// Читаем по mtime: кеш не длиннее одного запроса по смыслу — иначе теряется
// бесшовность свича, ради которой всё и делается.
function readState() {
    let st;
    try {
        st = fs.statSync(STATE_FILE);
    } catch (e) {
        stateCache.state = null;
        stateCache.mtime = 0;
        stateCache.error = `нет ${STATE_FILE} — дашборд ещё не записал активный бэкенд`;
        return null;
    }
    if (stateCache.state && st.mtimeMs === stateCache.mtime) return stateCache.state;
    try {
        const parsed = parseState(fs.readFileSync(STATE_FILE, 'utf8'));
        stateCache.state = parsed;
        stateCache.mtime = st.mtimeMs;
        stateCache.error = null;
        log(`backend: ${parsed.backend} → ${parsed.upstream}${parsed.local ? ' (локальный, ключ не трогаем)' : ' (удалённый, ключ из ' + parsed.keyFile + ')'}`);
        return parsed;
    } catch (e) {
        stateCache.state = null;
        stateCache.mtime = st.mtimeMs;
        stateCache.error = `active-backend.json битый: ${e.message}`;
        return null;
    }
}

// ── Маппинг тиров для удалённых апстримов ────────────────────────────────────
// Те же правила, что у keepalive-proxy.js (:92) и agentrouter-proxy.js: держим
// формат файла одинаковым, чтобы вкладки дашборда правили его без переучивания.
const TIER_RE = [
    { tier: 'opus', re: /(^|[-_.\/])?opus([-\/]|$)/i },
    { tier: 'sonnet', re: /(^|[-_.\/])?sonnet([-\/]|$)/i },
    { tier: 'haiku', re: /(^|[-_.\/])?haiku([-\/]|$)/i },
];
const mapCache = { file: '', mtime: 0, data: null };

function readModelMap(file) {
    if (!file) return null;
    const p = path.isAbsolute(file) ? file : path.join(__dirname, file);
    try {
        const st = fs.statSync(p);
        if (mapCache.data && mapCache.file === p && st.mtimeMs === mapCache.mtime) return mapCache.data;
        const raw = fs.readFileSync(p, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        mapCache.data = { opus: '', sonnet: '', haiku: '', ...doc };
        mapCache.file = p;
        mapCache.mtime = st.mtimeMs;
        return mapCache.data;
    } catch { return null; }
}

function tierTargetFor(model, mm) {
    if (!mm) return null;
    for (const { tier, re } of TIER_RE) {
        if (mm[tier] && re.test(String(model || ''))) return { tier, target: mm[tier] };
    }
    return null;
}

// ── Склейка пути: base шлюза + путь клиента ───────────────────────────────────
// У половины шлюзов base URL уже кончается на /v1 (`api.evomap.ai/v1`,
// `api.ourtoken.ai/v1`, `conduit.ozdoev.net/v1`, `localhost:20128/v1` — так они
// лежат в BACKENDS/константах transparent-proxy.js), а Claude Code шлёт
// `/v1/messages`. Наивная склейка даёт `/v1/v1/messages`, и шлюз отвечает 404
// `Invalid URL` — проверено на живых ourtoken/evomap 2026-08-20. Схлопываем дубль:
// одинарный /v1 — единственная форма, на которую эти шлюзы отвечают.
function joinUpstreamPath(basePath, reqPath) {
    const base = String(basePath || '').replace(/\/+$/, '');
    if (base.endsWith('/v1') && /^\/v1(\/|\?|$)/.test(reqPath)) return base.slice(0, -3) + reqPath;
    return base + reqPath;
}

// Что сделать с телом запроса перед удалённым шлюзом.
// Возвращает { body, from, to } либо null (тело не меняем).
// Суффикс окна ([1m], [200k]) — метка Claude Code, у шлюзов таких id нет: не срезать
// = 503/404 на первом же запросе. Маппинг тира приоритетнее среза суффикса.
function remapForRemote(method, reqPath, body, mm) {
    if (method !== 'POST') return null;
    if (reqPath.replace(/\?.*$/, '') !== '/v1/messages') return null;
    let j;
    try { j = JSON.parse(body.toString('utf8') || '{}'); } catch { return null; }
    if (typeof j.model !== 'string' || !j.model) return null;
    const model = j.model;
    const tm = tierTargetFor(model, mm);
    const target = tm && tm.target ? tm.target : model.replace(/\s*\[[^\]]*\]\s*$/, '');
    if (target === model) return null;
    return {
        body: Buffer.from(JSON.stringify(Object.assign({}, j, { model: target })), 'utf8'),
        from: model,
        to: target,
    };
}

// Ошибка в форме Anthropic: Claude Code печатает message как есть, иначе юзер
// видит только «unknown error» и лезет искать причину в CC, а не у нас.
// 🪤 Если заголовки уже ушли, `res.end()` ОТМЫВАЕТ обрыв в чистое завершение: клиент
// получает корректно закрытый ответ с недописанным телом и падает на разборе, а не
// повторяет запрос. Особенно больно с удержанием keepalive, где тело до отказа состоит
// из одних пробелов (`jsonHoldMs`) или из одних пингов: `JSON.parse` даёт SyntaxError
// вместо повторяемой сетевой ошибки. Поэтому здесь именно `destroy()` — обрыв должен
// доехать до клиента обрывом. Найдено чтением кода 2026-09-04.
function apiError(res, code, message) {
    const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message } });
    if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function statusPayload() {
    const s = readState();
    return {
        ok: true,
        port: PORT,
        uptime_ms: Date.now() - startedAt,
        backend: s ? s.backend : null,
        upstream: s ? s.upstream : null,
        local: s ? s.local : null,
        injectsKey: s ? (!s.local && !!s.keyFile) : null,
        modelmap: s ? s.modelmap : null,
        state_file: STATE_FILE,
        error: s ? null : stateCache.error,
    };
}

// ── Мягкая остановка: дожать начатое, а не расстрелять ───────────────────────
// Зачем. Рестарт хаба гасит front-door, и КАЖДЫЙ запрос в полёте превращается для
// Claude Code в `Connection closed mid-response` или `ECONNRESET`. 05.09 это било по
// живым сессиям раз за разом: дашборд поднимался по четыре раза в час, а владелец
// требовал прямо — «прокси не должна рвать соединение».
// 🪤 На Windows мягко погасить чужой процесс нельзя: SIGTERM не доставляется, а
// `taskkill` без `/F` для node бесполезен (об это же спотыкается lifecycle.killPort).
// Поэтому сигнал ВНУТРИПОЛОСНЫЙ: кто гасит — просит `POST /__drain`, и процесс сам
// перестаёт принимать новые соединения, дожимает начатые и выходит.
let draining = false;
let inflight = 0;
const DRAIN_MAX_MS = Number(process.env.DRAIN_MAX_MS || 120000);

function maybeExitAfterDrain() {
    if (!draining || inflight > 0) return;
    log('дренаж закончен: запросов в полёте нет, выхожу');
    setTimeout(() => process.exit(0), 250)   // запас на дослив последнего ответа в сокет.unref();
}

function startDrain(res) {
    const body = JSON.stringify({ ok: true, draining: true, inflight });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    if (draining) return;
    draining = true;
    log(`дренаж: закрываю слушателя, в полёте ${inflight} запрос(ов), потолок ожидания ${DRAIN_MAX_MS}мс`);
    try { server.close(); } catch (e) { /* уже закрыт */ }
    // Потолок обязателен: один долгий ответ (наблюдались 12-минутные) иначе держал бы
    // рестарт бесконечно, и человек убил бы процесс руками — то есть вернулся к разрыву.
    setTimeout(() => {
        if (!draining) return;
        log(`дренаж: потолок ${DRAIN_MAX_MS}мс истёк, в полёте ещё ${inflight} — выхожу`);
        process.exit(0);
    }, DRAIN_MAX_MS).unref();
    maybeExitAfterDrain();
}

function handle(req, res) {
    const reqPath = req.url || '/';
    if (req.method === 'POST' && reqPath.replace(/\?.*$/, '') === '/__drain') return startDrain(res);
    inflight += 1;
    res.on('close', () => { inflight -= 1; maybeExitAfterDrain(); });
    if (req.method === 'GET' && reqPath.replace(/\?.*$/, '') === '/__frontdoor/api/status') {
        const body = JSON.stringify(statusPayload());
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        return res.end(body);
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => { /* клиент отвалился — апстрим не дёргаем */ });
    req.on('end', () => {
        const state = readState();
        if (!state) {
            log(`${req.method} ${reqPath} → 503: ${stateCache.error}`);
            return apiError(res, 503, `front-door :${PORT}: ${stateCache.error}. Открой дашборд :8200 и выбери провайдера.`);
        }
        forward(req, res, state, Buffer.concat(chunks), reqPath);
    });
}

function forward(req, res, state, reqBody, reqPath) {
    const u = state.url;
    const requester = u.protocol === 'https:' ? https.request : http.request;
    const headers = Object.assign({}, req.headers, { host: u.host });
    let body = reqBody;

    if (!state.local) {
        // Ключ читаем на КАЖДЫЙ запрос: на этом стоит смена аккаунта без рестарта CC
        // и авто-ротация FreeModel. Мирроринг keepalive-proxy.js:771-774.
        let key = '';
        if (state.keyFile) {
            const kp = path.isAbsolute(state.keyFile) ? state.keyFile : path.join(CLAUDE_DIR, state.keyFile);
            try { key = fs.readFileSync(kp, 'utf8').trim(); } catch { key = ''; }
            if (!key) {
                log(`${req.method} ${reqPath} → 503: пустой ${state.keyFile} (${state.backend})`);
                return apiError(res, 503, `front-door: у ${state.backend} нет активного ключа (${state.keyFile}). Активируй аккаунт в дашборде.`);
            }
            headers.authorization = `Bearer ${key}`;
            headers['x-api-key'] = key;
        }
        const mm = readModelMap(state.modelmap);
        const remap = remapForRemote(req.method, reqPath, body, mm);
        if (remap) {
            body = remap.body;
            headers['content-length'] = String(Buffer.byteLength(body));
            log(`${req.method} ${reqPath} ${state.backend}: ${remap.from} → ${remap.to}`);
        } else if (!mm && req.method === 'POST' && /claude-/i.test(modelOf(body))) {
            // Шлюз без карты тиров: claude-модель уедет как есть. Первый признак
            // будущего 404 «no such model» — пусть это будет видно в логе, а не в догадках.
            log(`${req.method} ${reqPath} ${state.backend}: claude-* уходит на шлюз без ${state.modelmap || 'карты моделей'}`);
        }
    }

    const upReq = requester({
        protocol: u.protocol,
        hostname: connectHost(u.hostname, state.local),
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: joinUpstreamPath(u.pathname, reqPath),
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
    }, (upRes) => {
        // Тело не трогаем вообще: SSE, gzip/zstd, MODEL_ECHO — не наша забота,
        // ретраев нет, значит и буферизовать нечего. Просто труба.
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        // Счётчик токенов висит РЯДОМ с трубой: слушатель `data` получает те же
        // чанки, что и `pipe`, ответ клиенту от этого не задерживается и не меняется.
        // Через front-door идут все харнессы, поэтому это единственное место, где
        // видно весь расход разом (см. usage-tap.js).
        const tap = createTap({
            method: req.method, url: reqPath, backend: state.backend,
            ua: req.headers['user-agent'], status: upRes.statusCode, headers: upRes.headers,
        });
        if (tap) {
            upRes.on('data', tap.chunk);
            upRes.on('end', tap.end);
            upRes.on('aborted', tap.end);       // клиент ушёл — считаем то, что успело прийти
        }
        upRes.pipe(res);
        // Тот же принцип, что в apiError: недописанный ответ обязан выглядеть
        // недописанным. `res.end()` здесь закрывал бы поток штатно, и клиент считал бы
        // обрезанный ответ полным — вместо повторяемой транспортной ошибки.
        upRes.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    });

    upReq.on('timeout', () => {
        log(`${req.method} ${reqPath} ${state.backend}: таймаут ${UPSTREAM_TIMEOUT_MS}мс`);
        upReq.destroy(new Error('upstream timeout'));
    });
    upReq.on('error', (e) => {
        // Ретраев тут нет сознательно: они живут в keepalive, дубль = второй платный запрос.
        const hint = state.local && UPSTREAM_DOWN.has(e.code)
            ? ` Прокси ${state.upstream} не слушает — подними его кнопкой в Health или переактивируй провайдера.`
            : '';
        log(`${req.method} ${reqPath} ${state.backend}: ${e.code || e.message}`);
        apiError(res, 502, `front-door → ${state.backend}: ${e.code || e.message}.${hint}`);
    });
    // ── Клиент ушёл (Ctrl-C, ESC в CC, свой таймаут стрима) ───────────────────
    // 🪤 `req.on('aborted')` СЛОМАН на Node 17+ (deprecated с 16-й) — в обычном пути
    // обрыва он не приходит, и до 25.08 здесь стоял только он. Цена: front-door не
    // узнавал об уходе клиента и держал запрос к keepalive до своего таймаута 600с.
    // По логам за один день **349 таких висяков** против 3 у keepalive, который тот же
    // случай ловит правильно (`req.on('close')` + `res.on('close')`).
    // Хуже, чем просто занятый сокет: пока мы держим запрос, шлюз ПРОДОЛЖАЕТ
    // генерировать и берёт за это деньги — на плоском тарифе полную цену запроса за
    // ответ, которого никто не прочитает.
    // Поэтому слушаем `close` — но с ПРАВИЛЬНЫМИ сторожами, зеркаля keepalive-proxy.js
    // (§ конец handle): у `res` признак ухода — `!res.writableEnded`, у `req` — строго
    // `!req.complete`.
    // 🪤 Сторож у `req` обязателен и обязан быть именно таким: `close` на серверном
    // запросе приходит, когда ДОЧИТАНО ТЕЛО, а не когда ушёл клиент. Первая версия
    // этой правки проверяла у `req` тот же `res.writableEnded` — и рвала апстрим на
    // каждом запросе через 50 мс после старта. Поймано регрессом
    // `tools/check-frontdoor-abort.js` на подставном порту, до живого стека не дошло.
    let clientGone = false;
    const dropUpstream = (why) => {
        if (clientGone) return;
        clientGone = true;
        log(`${req.method} ${reqPath} ${state.backend}: клиент ушёл (${why}) — рву апстрим`);
        try { upReq.destroy(); } catch { /* уже мёртв */ }
    };
    req.on('aborted', () => dropUpstream('aborted'));
    req.on('close', () => { if (!req.complete) dropUpstream('тело запроса не дочитано'); });
    res.on('close', () => { if (!res.writableEnded) dropUpstream('ответ не дописан'); });
    upReq.end(body);
}

function modelOf(body) {
    try { return JSON.parse(body.toString('utf8') || '{}').model || ''; } catch { return ''; }
}

// ── Самопроверка (до server.listen: порт не занимаем) ─────────────────────────
if (process.argv[2] === 'selftest') {
    const assert = require('assert');

    // 1. Разбор состояния: local/remote, мусор.
    const local = parseState(JSON.stringify({ backend: 'gorouter', upstream: 'http://127.0.0.1:20156' }));
    assert.strictEqual(local.local, true, 'localhost = локальный апстрим');
    assert.strictEqual(local.keyFile, null, 'у локального нет keyFile');
    const remote = parseState(JSON.stringify({
        backend: 'conduit', upstream: 'https://conduit.ozdoev.net/v1',
        keyFile: 'cdt-active-key.txt', modelmap: 'cdt-modelmap.json',
    }));
    assert.strictEqual(remote.local, false, 'внешний хост = удалённый апстрим');
    assert.strictEqual(remote.keyFile, 'cdt-active-key.txt', 'keyFile читается');
    assert.strictEqual(parseState(JSON.stringify({ backend: 'x', upstream: 'http://localhost:20155' })).local, true, 'localhost по имени');
    assert.throws(() => parseState('{"backend":"x"}'), /нет upstream/, 'без upstream — ошибка');
    assert.throws(() => parseState('{"upstream":"ftp://x/"}'), /не http/, 'не-http upstream — ошибка');
    assert.throws(() => parseState('не json'), 'мусор — ошибка');

    // 2. Путь апстрима: base шлюза + путь клиента, с схлопыванием дубля /v1.
    //    Замерено на живых шлюзах 2026-08-20: ourtoken отвечает на /v1/models (403
    //    «banned» — т.е. путь дошёл) и 404 «Invalid URL (/v1/v1/models)» на дубле;
    //    evomap так же. aerolink (base без пути) отдал каталог 200.
    const jp = (up, p) => joinUpstreamPath(new URL(up).pathname, p);
    assert.strictEqual(jp('https://api.evomap.ai/v1', '/v1/messages'), '/v1/messages', 'дубль /v1 схлопнут');
    assert.strictEqual(jp('http://localhost:20128/v1', '/v1/messages'), '/v1/messages', 'omniroute тоже');
    assert.strictEqual(jp('https://api.svrtr.org', '/v1/messages'), '/v1/messages', 'base без пути');
    assert.strictEqual(jp('https://capi.aerolink.lat/', '/v1/models'), '/v1/models', 'хвостовой слэш не мешает');
    assert.strictEqual(jp('http://127.0.0.1:20156', '/v1/messages?beta=true'), '/v1/messages?beta=true', 'query не теряется');
    assert.strictEqual(jp('https://api.evomap.ai/v1', '/health'), '/v1/health', 'не-/v1 путь дописывается к base');
    assert.strictEqual(joinUpstreamPath('/api/v1', '/v1/messages'), '/api/v1/messages', 'схлопывание не съедает префикс');

    // 3. Ремап тела для удалённых: срез суффикса окна и карта тиров.
    const bodyOf = (o) => Buffer.from(JSON.stringify(o), 'utf8');
    const noMap = null;
    const r1 = remapForRemote('POST', '/v1/messages', bodyOf({ model: 'claude-opus-5[1m]', max_tokens: 1 }), noMap);
    assert.strictEqual(r1.to, 'claude-opus-5', 'суффикс [1m] срезан');
    assert.strictEqual(JSON.parse(r1.body).max_tokens, 1, 'остальное тело сохранено');
    assert.strictEqual(remapForRemote('POST', '/v1/messages', bodyOf({ model: 'claude-opus-5' }), noMap), null,
        'без суффикса и без карты тело не трогаем');
    const mm = { opus: 'gpt-5.4', sonnet: '', haiku: '' };
    const r2 = remapForRemote('POST', '/v1/messages', bodyOf({ model: 'claude-opus-5[1m]' }), mm);
    assert.strictEqual(r2.to, 'gpt-5.4', 'карта тиров приоритетнее среза суффикса');
    const r3 = remapForRemote('POST', '/v1/messages', bodyOf({ model: 'claude-sonnet-5[1m]' }), mm);
    assert.strictEqual(r3.to, 'claude-sonnet-5', 'пустой тир в карте = только срез суффикса');
    assert.strictEqual(remapForRemote('GET', '/v1/models', bodyOf({ model: 'claude-opus-5[1m]' }), mm), null, 'не POST — не трогаем');
    assert.strictEqual(remapForRemote('POST', '/v1/messages/count_tokens', bodyOf({ model: 'claude-opus-5[1m]' }), mm), null,
        'count_tokens форвардим как есть, своей оценки не даём');
    assert.strictEqual(remapForRemote('POST', '/v1/messages', Buffer.from('не json'), mm), null, 'битое тело не ломает прокси');
    // Пробник валидации модели CC (stream=false, 2 сообщения, без tools) — обычный запрос.
    const probe = remapForRemote('POST', '/v1/messages', bodyOf({
        model: 'claude-opus-5[1m]', stream: false, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
    }), noMap);
    assert.strictEqual(probe.to, 'claude-opus-5', 'пробник /model проходит как обычный запрос');

    // 3b. Хост соединения: локальный `localhost` → 127.0.0.1, удалённый не трогаем.
    assert.strictEqual(connectHost('localhost', true), '127.0.0.1', 'локальный localhost уходит в IPv4');
    assert.strictEqual(connectHost('0.0.0.0', true), '127.0.0.1', '0.0.0.0 тоже (connect в него бессмысленен)');
    assert.strictEqual(connectHost('127.0.0.1', true), '127.0.0.1', 'уже IPv4 — без изменений');
    assert.strictEqual(connectHost('::1', true), '::1', 'явный ::1 — воля пользователя, не подменяем');
    assert.strictEqual(connectHost('localhost', false), 'localhost', 'удалённый апстрим не переписываем');
    assert.strictEqual(connectHost('api.evomap.ai', false), 'api.evomap.ai', 'домен шлюза не трогаем');
    // Подсказка «прокси не слушает» должна ловить и EACCES: именно так выглядел
    // мёртвый gorouter :20156 через localhost/::1 (2026-08-20).
    assert.ok(UPSTREAM_DOWN.has('EACCES') && UPSTREAM_DOWN.has('ECONNREFUSED'),
        'оба кода мёртвого локального апстрима дают подсказку');

    // 4. Локальный апстрим: тело и ключ не трогаем (это делает keepalive).
    //    Проверяем самим кодом forward() — что ветка инжекта под !state.local.
    const src = fs.readFileSync(__filename, 'utf8');
    assert.ok(/if \(!state\.local\) \{[\s\S]*?headers\.authorization/.test(src),
        'инжект ключа только в ветке !state.local');
    // Ровно один вызов апстрима на запрос: ретраи и хеджи живут в keepalive, дубль
    // отсюда — второй платный запрос к шлюзу.
    assert.strictEqual((src.match(/^\s*const upReq = requester\(\{/gm) || []).length, 1,
        'апстрим дёргается ровно из одного места (нет ретраев/хеджей)');
    assert.ok(/server\.listen\(PORT, '127\.0\.0\.1'/.test(src), 'слушаем только 127.0.0.1 (инжектим ключи)');
    // Уход клиента ловится через `close`, а не только через сломанный на Node 17+
    // `aborted`: без этого front-door держал апстрим до своего таймаута (349 висяков
    // за день 25.08) и платил шлюзу за ответы, которые никто не читает.
    assert.ok(/req\.on\('close'/.test(src) && /res\.on\('close'/.test(src),
        'уход клиента ловится по close (req и res)');
    // Сторожа перепутать нельзя: у req это !req.complete, у res — !res.writableEnded.
    // С неверным сторожем у req прокси рвёт КАЖДЫЙ запрос сразу после чтения тела.
    assert.ok(/req\.on\('close', \(\) => \{ if \(!req\.complete\)/.test(src),
        'у req сторож — !req.complete (close приходит по дочитанному телу)');
    assert.ok(/res\.on\('close', \(\) => \{ if \(!res\.writableEnded\)/.test(src),
        'у res сторож — !res.writableEnded');

    // 5a. Обрыв должен доезжать обрывом: `res.end()` при уже отправленных заголовках
    //     превращает недописанный ответ в «успешный», и клиент падает на разборе тела
    //     вместо повтора. Критично для удержания keepalive, где до отказа наружу ушли
    //     только пробелы или пинги.
    assert.ok(/if \(res\.headersSent\) \{ try \{ res\.destroy\(\); \} catch/.test(src),
        'apiError при отправленных заголовках рвёт соединение, а не закрывает его штатно');
    assert.ok(/upRes\.on\('error', \(\) => \{ try \{ res\.destroy\(\); \} catch/.test(src),
        'ошибка тела апстрима тоже рвёт ответ клиенту');
    assert.strictEqual((src.match(/try \{ res\.end\(\); \} catch/g) || []).length, 0,
        'ни одного пути, где обрыв отмывается в res.end()');

    // 5. Ошибки в форме Anthropic.
    let captured = null;
    apiError({ writeHead() {}, end(b) { captured = b; }, headersSent: false }, 503, 'тест');
    const err = JSON.parse(captured);
    assert.strictEqual(err.type, 'error', 'тело ошибки в форме Anthropic');
    assert.ok(err.error.message.includes('тест'), 'сообщение доезжает до клиента');

    console.log('selftest OK');
    process.exit(0);
}

const server = http.createServer(handle);
server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
server.listen(PORT, '127.0.0.1', () => {
    log(`front-door на http://127.0.0.1:${PORT}, состояние из ${STATE_FILE}`);
    const s = readState();
    if (!s) log(`ВНИМАНИЕ: ${stateCache.error} — запросы будут отвечать 503, пока дашборд не запишет бэкенд`);
});
