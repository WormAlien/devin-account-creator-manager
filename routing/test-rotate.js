/*
 * test-rotate.js — авторотация аккаунтов против фейкового шлюза и фейкового дашборда.
 * Запуск: node test-rotate.js   (свои порты 8795-8797, живой стек не трогает)
 *
 * Зачем. Шлюз отказывает по деньгам ПОСРЕДИ работы, двумя разными текстами, и до
 * ротации оба вели в тупик: китайский `预扣费额度失败 … 额度` попадал в список
 * постоянных ошибок и улетал клиенту как 403 (это и увидел владелец 22.08), а
 * английский `Insufficient account balance` считался транзиентным — три попытки в
 * тот же пустой аккаунт и 502. Здесь проверяется весь путь целиком: классификатор →
 * звонок дашборду → перечитывание файла ключа → повтор запроса.
 *
 * A: китайский отказ по деньгам → подмена ключа → клиент получает 200, а не 403.
 *    Заодно: в дашборд уехали ЦИФРЫ из текста ошибки (нужно $0.80, осталось $0.31).
 * B: английский `Insufficient account balance` → то же самое (раньше жёг ретраи).
 * C: мёртвый ключ (`User has been banned`) → подмена с причиной dead.
 * D: пул сухой (дашборд ответил pool-dry) → клиент получает ИСХОДНУЮ ошибку шлюза,
 *    а не выдуманную: подменять нечем, и человек обязан это узнать.
 * E: цепочка при maxAttempts=1 — первая замена тоже пустая, вторая рабочая. Проверяет,
 *    что у ротаций свой бюджет попыток (bonusAttempts), а не бюджет ретраев.
 * F: AUTOROTATE=0 → ротации нет вообще, поведение как до фичи (аварийный выключатель).
 * G: «нет прав на модель» (не деньги) → ротации нет, ошибка уходит клиенту как есть.
 *
 * Ни одного реального запроса в шлюз: и апстрим, и дашборд здесь фейковые, ключи —
 * строки вида sk-test-*. Живые пулы и ~/.claude/*-active-key.txt не задеты.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const UP_PORT = 8796;    // фейковый шлюз
const DASH_PORT = 8797;  // фейковый дашборд (эндпоинт ротации)
const PX_PORT = 8795;    // испытуемый keepalive-proxy

const KEY_FILE = path.join(os.tmpdir(), 'warp-rotate-test-key.txt');
const TEST_CFG = path.join(os.tmpdir(), 'warp-rotate-test-config.json');
const LAT_FILE = path.join(os.tmpdir(), 'warp-rotate-test-latency.json');

const EMPTY_KEY = 'sk-test-empty';
const NEXT_KEY = 'sk-test-next';
const NEXT2_KEY = 'sk-test-next2';

const SSE_BODY = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
// Тексты — дословно те, что видели живьём: китайский со скриншота владельца 22.08,
// английский из routing/keepalive-proxy.log (13 вхождений).
const ZH_OOB = '{"error":{"message":"预扣费额度失败, 用户剩余额度: $0.309854, 需要预扣费额度: $0.800000 (request id: 2026)"}}';
const EN_OOB = '{"error":{"type":"bad_response_status_code","message":"Insufficient account balance (request id: 2026)"}}';
const BANNED = '{"error":{"message":"User has been banned"}}';
const NO_MODEL = '{"error":{"message":"该令牌无权访问模型 claude-haiku-4-5"}}';

// Какие ключи фейковый шлюз считает пустыми и каким текстом отказывает.
let emptyKeys = new Set([EMPTY_KEY]);
let failBody = ZH_OOB;
const seenKeys = [];   // ключи, с которыми шлюз реально видел запросы

const upstream = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    seenKeys.push(auth);
    req.resume();
    req.on('end', () => {
        if (emptyKeys.has(auth)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(failBody);
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(SSE_BODY);
    });
});

// Фейковый дашборд: подменяет ключ в файле — ровно то, что делает moneyRotate
// (файл активного ключа + флаг active в пуле; флаг здесь проверять нечему).
let rotateTo = [NEXT_KEY];   // очередь замен
let rotateReply = null;      // если задан — отвечаем им (для pool-dry)
const rotateCalls = [];

const dash = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/__switch/api/go/rotate') {
        res.writeHead(404); res.end('{}'); return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* пустое тело */ }
        rotateCalls.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (rotateReply) { res.end(JSON.stringify(rotateReply)); return; }
        const next = rotateTo.shift();
        if (!next) { res.end(JSON.stringify({ ok: false, error: 'pool-dry' })); return; }
        fs.writeFileSync(KEY_FILE, next, 'utf8');
        res.end(JSON.stringify({ ok: true, email: 'acc-' + next.slice(-5), mask: '***' + next.slice(-6) }));
    });
});

function ask() {
    const body = JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [] });
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
        const r = http.request({
            port: PX_PORT, method: 'POST', path: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'accept-encoding': 'gzip, deflate',
            },
        }, (res) => {
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: buf, ms: Date.now() - t0 }));
        });
        r.on('error', reject);
        r.end(body);
    });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnProxy(extraEnv) {
    const child = spawn(process.execPath, ['keepalive-proxy.js'], {
        cwd: __dirname,
        env: Object.assign({}, process.env, {
            PORT: String(PX_PORT),
            UPSTREAM: `http://127.0.0.1:${UP_PORT}`,
            // Провайдер задаём явно: фейковый шлюз живёт на 127.0.0.1, а по хосту
            // выводится только реальный (gorouter.app и т.п.).
            ROTATE_PROVIDER: 'go',
            DASHBOARD_URL: `http://127.0.0.1:${DASH_PORT}`,
            KEY_FILE,
            CONFIG_FILE: TEST_CFG,
            LATENCY_FILE: LAT_FILE,
            MODELMAP_FILE: path.join(os.tmpdir(), 'warp-rotate-nonexistent-modelmap.json'),
            HAIKU_REMAP: '0',
            HEDGE_MS: '0',            // дубли тут только мешают считать попытки
            PRE_COMMIT_MS: '0',
            RETRY_DELAY_MS: '50',
            IDLE_MS: '5000',
            LOG_FILE: '',
        }, extraEnv || {}),
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.plog = '';
    child.stderr.on('data', (c) => { child.plog += c; });
    return child;
}
async function waitProxy() {
    for (let i = 0; i < 50; i += 1) {
        try {
            const r = await new Promise((resolve, reject) => {
                const q = http.request({ port: PX_PORT, path: '/__keepalive/api/status' }, resolve);
                q.on('error', reject);
                q.end();
            });
            r.resume();
            if (r.statusCode === 200) return;
        } catch (e) { await wait(200); }
    }
    throw new Error('прокси не поднялся');
}
async function stopProxy(child) {
    child.kill();
    for (let i = 0; i < 30; i += 1) {
        const free = await new Promise((resolve) => {
            const s = require('net').createServer();
            s.once('error', () => resolve(false));
            s.listen(PX_PORT, '127.0.0.1', () => s.close(() => resolve(true)));
        });
        if (free) return;
        await wait(100);
    }
}
// Сброс перед каждым случаем: ключ, счётчики, очередь замен.
function reset(opts = {}) {
    fs.writeFileSync(KEY_FILE, EMPTY_KEY, 'utf8');
    seenKeys.length = 0;
    rotateCalls.length = 0;
    rotateTo = opts.rotateTo || [NEXT_KEY];
    rotateReply = opts.rotateReply || null;
    emptyKeys = new Set(opts.emptyKeys || [EMPTY_KEY]);
    failBody = opts.failBody || ZH_OOB;
}

(async () => {
    await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
    await new Promise((r) => dash.listen(DASH_PORT, '127.0.0.1', r));
    try { fs.unlinkSync(TEST_CFG); } catch { /* могло не быть */ }

    let proxy = spawnProxy();
    try {
        await waitProxy();

        // --- A: китайский отказ по деньгам → подмена → 200 ---
        reset();
        const a = await ask();
        assert.strictEqual(a.status, 200, `A: клиент должен получить 200 после подмены (получил ${a.status}: ${a.body.slice(0, 120)})`);
        assert.ok(a.body.includes('message_stop'), 'A: тело — настоящий ответ шлюза с нового ключа');
        assert.deepStrictEqual(seenKeys, [EMPTY_KEY, NEXT_KEY], `A: шлюз видел пустой, потом новый ключ (${seenKeys.join(',')})`);
        assert.strictEqual(rotateCalls.length, 1, `A: дашборд попросили один раз (${rotateCalls.length})`);
        assert.strictEqual(rotateCalls[0].reason, 'out-of-balance', 'A: причина — нет баланса');
        assert.strictEqual(rotateCalls[0].fromKey, EMPTY_KEY, 'A: дашборду сказали, на КАКОМ ключе отказ (нужно для дедупа)');
        assert.strictEqual(rotateCalls[0].needUsd, 0.8, 'A: «需要预扣费额度: $0.800000» уехало цифрой — по нему выбирают кандидата');
        assert.strictEqual(rotateCalls[0].leftUsd, 0.309854, 'A: «用户剩余额度» уехало цифрой — бесплатное уточнение кеша');
        assert.ok(/нет баланса|out-of-balance/.test(proxy.plog), 'A: в логе видно причину');
        assert.ok(!proxy.plog.includes(EMPTY_KEY), 'A: ключ целиком в лог не попал (только маска)');
        console.log(`A ok: ${a.ms}ms, ключей у шлюза ${seenKeys.length}, ротаций 1`);

        // --- B: английская формулировка (раньше жгла три ретрая и отдавала 502) ---
        reset({ failBody: EN_OOB });
        const b = await ask();
        assert.strictEqual(b.status, 200, `B: 200 после подмены (получил ${b.status})`);
        assert.deepStrictEqual(seenKeys, [EMPTY_KEY, NEXT_KEY], `B: ровно одна лишняя попытка, без пустых ретраев (${seenKeys.join(',')})`);
        assert.strictEqual(rotateCalls[0].needUsd, null, 'B: цифр в английском тексте нет — передаём null, а не выдумываем');
        console.log(`B ok: ${b.ms}ms, попыток к шлюзу ${seenKeys.length}`);

        // --- C: мёртвый ключ → подмена с причиной dead ---
        reset({ failBody: BANNED });
        const c = await ask();
        assert.strictEqual(c.status, 200, `C: 200 после подмены (получил ${c.status})`);
        assert.strictEqual(rotateCalls[0].reason, 'dead', 'C: причина — мёртвый ключ (дашборд пометит status:dead)');
        console.log(`C ok: ${c.ms}ms`);

        // --- D: сухой пул → клиент получает ИСХОДНУЮ ошибку шлюза ---
        reset({ rotateReply: { ok: false, error: 'pool-dry' } });
        const d = await ask();
        assert.strictEqual(d.status, 403, `D: подменять нечем — отдаём исходный 403 (получили ${d.status})`);
        assert.ok(d.body.includes('预扣费额度失败'), 'D: тело ошибки шлюза доходит целиком, без подмены на свой текст');
        assert.deepStrictEqual(seenKeys, [EMPTY_KEY], `D: второй попытки не было (${seenKeys.join(',')})`);
        console.log(`D ok: ${d.ms}ms, тело шлюза сохранено`);

        // --- E: цепочка «замена тоже пустая» при maxAttempts=1 ---
        // Без своего бюджета (bonusAttempts) вторая попытка не запустилась бы вовсе.
        await stopProxy(proxy);
        try { fs.unlinkSync(TEST_CFG); } catch { /* могло не быть */ }
        proxy = spawnProxy({ MAX_ATTEMPTS: '1' });
        await waitProxy();
        reset({ rotateTo: [NEXT_KEY, NEXT2_KEY], emptyKeys: [EMPTY_KEY, NEXT_KEY] });
        const e = await ask();
        assert.strictEqual(e.status, 200, `E: цепочка должна доехать до рабочего аккаунта (получили ${e.status}: ${e.body.slice(0, 120)})`);
        assert.deepStrictEqual(seenKeys, [EMPTY_KEY, NEXT_KEY, NEXT2_KEY], `E: прошли по цепочке (${seenKeys.join(',')})`);
        assert.strictEqual(rotateCalls.length, 2, `E: две просьбы о подмене (${rotateCalls.length})`);
        console.log(`E ok: ${e.ms}ms, цепочка из ${rotateCalls.length} подмен при maxAttempts=1`);

        // --- F: аварийный выключатель ---
        await stopProxy(proxy);
        proxy = spawnProxy({ AUTOROTATE: '0' });
        await waitProxy();
        reset();
        const f = await ask();
        assert.strictEqual(f.status, 403, `F: с AUTOROTATE=0 поведение прежнее — 403 клиенту (получили ${f.status})`);
        assert.strictEqual(rotateCalls.length, 0, `F: дашборд не звался (${rotateCalls.length})`);
        console.log('F ok: выключатель работает');

        // --- G: не деньги — не ротируем ---
        await stopProxy(proxy);
        proxy = spawnProxy();
        await waitProxy();
        reset({ failBody: NO_MODEL });
        const g = await ask();
        assert.strictEqual(g.status, 403, `G: нет прав на модель — отдаём как есть (получили ${g.status})`);
        assert.strictEqual(rotateCalls.length, 0, 'G: подмена аккаунта такую ошибку не лечит — не звоним');
        assert.deepStrictEqual(seenKeys, [EMPTY_KEY], `G: без ретраев (${seenKeys.join(',')})`);
        console.log('G ok: чужие ошибки не трогаем');

        console.log('\ntest-rotate: A-G OK');
    } catch (err) {
        console.error('\nПРОВАЛ:', err.message);
        if (proxy && proxy.plog) console.error('--- лог прокси ---\n' + proxy.plog.split('\n').slice(-40).join('\n'));
        process.exitCode = 1;
    } finally {
        if (proxy) proxy.kill();
        upstream.close();
        dash.close();
        for (const f of [KEY_FILE, TEST_CFG, LAT_FILE, `${TEST_CFG}.v1.bak`]) {
            try { fs.unlinkSync(f); } catch { /* мог не появиться */ }
        }
    }
})();
