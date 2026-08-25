// bench-latency.js — стенд замера латентности шлюзов на КЛИЕНТСКОЙ форме запроса.
//
// ЗАЧЕМ. Предыдущие замеры врали, потому что посылали не то, что посылает Claude
// Code. На «say OK» без `system` шлюз отвечает за 2с, на реальном запросе — за 10–25с,
// и вывод «шлюз быстрый» получался из формы запроса, а не из шлюза. Урок уже был
// записан по JustWoker 22.08, и на него наступили повторно.
//
// ЧТО ИМЕННО МЕРИТ. Не одно «время ответа», а четыре точки — иначе «долго» не
// разбирается на причины:
//   ttfb        первый байт тела (может быть наш keepalive-ping, не шлюз)
//   firstEvent  первое `message_start` — шлюз принял запрос и начал отвечать
//   firstThink  первый `thinking_delta` — модель начала РАССУЖДАТЬ
//   firstText   первый `text_delta` — начал появляться ОТВЕТ (это и есть «отвисло»)
//   total       весь поток
// Если firstThink рано, а firstText поздно — время съедает рассуждение.
// Если оба поздно — время съедает обработка промпта.
//
// ФАКТОРЫ (включаются по одному, чтобы изолировать причину):
//   sys    системный промпт реального размера
//   beta   заголовок anthropic-beta с interleaved-thinking + путь ?beta=true
//   think  поле thinking:{type:'enabled'} в теле
//   ctx    история с tool_use/tool_result — имитация хода ПОСЛЕ инструментов
//
// ЗАПУСК
//   node bench-latency.js factors [провайдер]   факторный прогон (что виновато)
//   node bench-latency.js gateways              все шлюзы на реалистичной форме
//   node bench-latency.js selftest              проверка стенда, сеть не нужна
//
// ПЕРЕМЕННЫЕ
//   REPS=3          повторов на ячейку
//   MAX_TOKENS=64   потолок ответа (мерим начало, не длину)
//   PAUSE_MS=1500   пауза между запросами
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');   // прямой режим: тот же запрос минуя наш агент
const path = require('path');

const REPS = Number(process.env.REPS || 3);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 2000);
const PAUSE_MS = Number(process.env.PAUSE_MS || 1500);
// DETAIL=0 гасит построчный вывод прогонов, если нужна только сводка.
const DETAIL = process.env.DETAIL !== '0';

// Куда стучимся: локальный keepalive провайдера. Именно он и есть «наш стек»,
// плюс он сам подставит ключ — секреты в этом файле не нужны.
const GATEWAYS = {
    agentrouter: { port: 20133, label: 'AgentRouter', host: 'agentrouter.org', keyFile: 'ar-active-key.txt' },
    tabi: { port: 20155, label: 'Tabi', host: 'tabitoken.com', keyFile: 'tabi-active-key.txt' },
    gorouter: { port: 20156, label: 'GoRouter', host: 'gorouter.app', keyFile: 'gorouter-active-key.txt' },
    justwoker: { port: 20158, label: 'JustWoker', host: 'api.justwoker.icu', keyFile: 'justwoker-active-key.txt' },
};

// ── Тело запроса: собирается по факторам ──────────────────────────────────────
// Размеры взяты не с потолка: системный промпт Claude Code — единицы килобайт,
// а ход после нескольких инструментов легко даёт десятки. Держим их в константах,
// чтобы в отчёте было видно, ЧТО именно мерили.
const SYS_KB = 8;
const CTX_KB = 60;

// 🪤 Размер набираем ПО БАЙТАМ, а не по символам: в строках кириллица, в UTF-8 она
// два байта, и наивный `repeat(KB*1024/длина_в_символах)` дал 79 КБ вместо 60 —
// то есть отчёт врал бы о том, что мерил.
function padTo(unit, kb) {
    const want = kb * 1024;
    let out = '';
    while (Buffer.byteLength(out) < want) out += unit;
    return out;
}

const SYSTEM = 'You are a coding assistant working in a terminal.\n'
    + 'Follow the project conventions. Be concise.\n'
    + padTo('Rule: prefer existing helpers over new abstractions. ', SYS_KB);

// История с tool_use/tool_result — имитация именно того хода, на котором владелец
// видит зависание: инструмент отработал, отправляем всё заново вместе с результатом.
function toolHistory() {
    const fileDump = padTo('const x = 1; // line of code for volume\n', CTX_KB);
    return [
        { role: 'user', content: 'Find where the retry policy lives and summarize it.' },
        {
            role: 'assistant',
            content: [
                { type: 'text', text: 'Смотрю файл.' },
                { type: 'tool_use', id: 'toolu_bench_1', name: 'Read', input: { file_path: 'routing/keepalive-proxy.js' } },
            ],
        },
        {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_bench_1', content: fileDump }],
        },
    ];
}

function buildBody(f) {
    const b = {
        model: 'claude-opus-5',
        stream: true,
        max_tokens: MAX_TOKENS,
        messages: f.ctx
            ? toolHistory()
            : [{ role: 'user', content: 'Reply with exactly one short sentence about retries.' }],
    };
    if (f.sys) b.system = [{ type: 'text', text: SYSTEM }];
    // 🪤 budget_tokens обязан быть МЕНЬШЕ max_tokens (спецификация Anthropic), иначе
    // запрос отвергается до модели. Эти шлюзы его не проверяют (при max_tokens 64 и
    // budget 1024 ответ пришёл), но полагаться на их снисходительность нельзя.
    // И потолок должен быть щедрым: при max_tokens 64 рассуждение съело весь бюджет,
    // текста не пришло вообще, и `ответ` стал неизмеримым.
    if (f.think) b.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(MAX_TOKENS * 0.6)) };
    return JSON.stringify(b);
}

function buildHeaders(f, len) {
    const h = {
        'content-type': 'application/json',
        'content-length': len,
        'anthropic-version': '2023-06-01',
        'accept': 'text/event-stream',
        'x-api-key': 'dummy',                    // настоящий ключ подставит keepalive
        'user-agent': 'claude-cli/2.1.220 (external, cli)',
        'x-app': 'cli',
    };
    if (f.beta) {
        h['anthropic-beta'] = 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12';
    }
    return h;
}

// ── Один выстрел ──────────────────────────────────────────────────────────────
// gw передаётся только для прямого режима: там нужен хост шлюза и живой ключ.
// Через keepalive ни то, ни другое не нужно — он подставит сам.
function shot(port, f, gw) {
    return new Promise((resolve) => {
        const body = buildBody(f);
        const len = Buffer.byteLength(body);
        const t0 = Date.now();
        const r = { bodyKB: Math.round(len / 1024), ttfb: null, firstEvent: null, firstThink: null, firstText: null, total: null, code: 0, bytes: 0, think: 0, text: 0, tools: 0, stop: null };
        let tail = '';
        const direct = !!(f.direct && gw);
        const headers = buildHeaders(f, len);
        if (direct) {
            // Ключ читаем ТОЛЬКО в прямом режиме и только здесь: в лог он не попадает.
            const key = fs.readFileSync(path.join(os.homedir(), '.claude', gw.keyFile), 'utf8').trim();
            headers.authorization = `Bearer ${key}`;
            headers['x-api-key'] = key;
        }
        const opts = direct
            ? { hostname: gw.host, port: 443, method: 'POST', path: f.beta ? '/v1/messages?beta=true' : '/v1/messages', headers }
            : { hostname: '127.0.0.1', port, method: 'POST', path: f.beta ? '/v1/messages?beta=true' : '/v1/messages', headers };
        const req = (direct ? https : http).request(opts, (res) => {
            r.code = res.statusCode;
            res.on('data', (c) => {
                r.bytes += c.length;
                if (r.ttfb === null) r.ttfb = Date.now() - t0;
                // Разбираем по строкам, копя хвост: событие может разорваться между чанками.
                tail += c.toString('utf8');
                let nl;
                while ((nl = tail.indexOf('\n')) >= 0) {
                    const line = tail.slice(0, nl); tail = tail.slice(nl + 1);
                    if (!line.startsWith('data: ')) continue;
                    let j; try { j = JSON.parse(line.slice(6)); } catch { continue; }
                    if (j.type === 'message_start' && r.firstEvent === null) r.firstEvent = Date.now() - t0;
                    // 🪤 Ход может закончиться ВЫЗОВОМ ИНСТРУМЕНТА, и тогда текста не
                    // будет вовсе — это нормальный ответ, а не потеря. Без учёта этого
                    // «ответ —» читается как «шлюз сломан»: на таком выводе 25.08 был
                    // сделан ложный вывод «GoRouter отдаёт только рассуждение», снятый
                    // прямым сравнением с апстримом (stop_reason=tool_use у обоих).
                    if (j.type === 'content_block_start' && (j.content_block || {}).type === 'tool_use') r.tools += 1;
                    if (j.type === 'message_delta' && (j.delta || {}).stop_reason) r.stop = j.delta.stop_reason;
                    if (j.type === 'content_block_delta') {
                        const d = j.delta || {};
                        if (d.type === 'thinking_delta') {
                            if (r.firstThink === null) r.firstThink = Date.now() - t0;
                            r.think += (d.thinking || '').length;
                        }
                        if (d.type === 'text_delta') {
                            if (r.firstText === null) r.firstText = Date.now() - t0;
                            r.text += (d.text || '').length;
                        }
                    }
                    if (j.type === 'error') r.err = JSON.stringify(j.error || j).slice(0, 120);
                }
            });
            res.on('end', () => { r.total = Date.now() - t0; resolve(r); });
            res.on('error', () => { r.total = Date.now() - t0; r.err = r.err || 'stream'; resolve(r); });
        });
        req.setTimeout(180000, () => { req.destroy(); r.err = 'timeout'; r.total = Date.now() - t0; resolve(r); });
        req.on('error', (e) => { r.err = e.code || e.message; r.total = Date.now() - t0; resolve(r); });
        req.end(body);
    });
}

// ── Сводка ────────────────────────────────────────────────────────────────────
const med = (a) => {
    const v = a.filter((x) => x != null).sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : null;
};
const s = (ms) => (ms == null ? '   —  ' : (ms / 1000).toFixed(1).padStart(5) + 'с');

function line(name, rows) {
    const okRows = rows.filter((r) => r.code === 200);
    const errs = rows.filter((r) => r.code !== 200 || r.err);
    const e = errs.length ? `  ⚠ ${errs.length}/${rows.length} ${errs[0].err || 'код ' + errs[0].code}` : '';
    console.log(
        '  ' + name.padEnd(26)
        + ' тело' + String(rows[0] ? rows[0].bodyKB : 0).padStart(4) + 'КБ'
        + '  ответ' + s(med(okRows.map((r) => r.firstText)))
        + '  событие' + s(med(okRows.map((r) => r.firstEvent)))
        + '  мысли' + s(med(okRows.map((r) => r.firstThink)))
        + '  всего' + s(med(okRows.map((r) => r.total)))
        + '  ' + (med(okRows.map((r) => r.think)) || 0) + 'з/' + (med(okRows.map((r) => r.text)) || 0) + 'о'
        + e,
    );
    // 🪤 Медианы столбцов считаются НЕЗАВИСИМО, поэтому на малом n рядом могут встать
    // числа из разных прогонов — и «ответ» окажется РАНЬШЕ «события», чего физически
    // быть не может. Чтобы вывод нельзя было прочитать неправильно, печатаем сырые
    // прогоны: на них видно и разброс, и что ни один отдельный запрос не противоречив.
    if (DETAIL) {
        for (const r of rows) {
            console.log('        прогон: ответ' + s(r.firstText) + '  событие' + s(r.firstEvent)
                + '  мысли' + s(r.firstThink) + '  всего' + s(r.total)
                + '  ' + r.think + 'з/' + r.text + 'о'
                + (r.tools ? '  тулзов ' + r.tools : '')
                + '  stop=' + (r.stop || '—')
                + '  код ' + r.code + (r.err ? '  ' + r.err : ''));
        }
    }
}

async function runCell(port, f, reps, gw) {
    const rows = [];
    for (let i = 0; i < reps; i++) {
        rows.push(await shot(port, f, gw));
        await new Promise((x) => setTimeout(x, PAUSE_MS));
    }
    return rows;
}

// ── Кто рвёт соединение: путь до шлюза или наш пул ────────────────────────────
// Замер 25.08 по логам: 61% всех повторов — `read ECONNRESET`, и рвётся оно НЕ при
// соединении, а посреди ожидания (медиана 11.3с, p90 22.8с). Два подозреваемых:
//   • путь до шлюза (роутер/туннель/Cloudflare) рубит простаивающее соединение;
//   • наш пул (`keepAlive: true`) переиспользует сокет, который дальний конец уже
//     закрыл, и обрыв прилетает на первой же записи.
// Различает их ровно один опыт: тот же запрос БЕЗ нашего агента. Чередуем, чтобы
// эпизод на стороне шлюза не лёг целиком на один из вариантов.
async function cmdResets(name) {
    const key = name || 'justwoker';
    const g = GATEWAYS[key];
    if (!g) { console.log('  неизвестный шлюз: ' + key); return; }
    const f = { sys: 1, beta: 1, think: 1, ctx: 1 };
    console.log(`\n  Кто рвёт связь: ${g.label}, повторов ${REPS} на каждый режим`);
    console.log('  «через нас» = keepalive :' + g.port + ' · «напрямую» = ' + g.host + ' минуя наш агент\n');
    const acc = { proxy: [], direct: [] };
    for (let i = 0; i < REPS; i++) {
        for (const mode of ['direct', 'proxy']) {
            const r = await shot(g.port, Object.assign({}, f, { direct: mode === 'direct' }), g);
            acc[mode].push(r);
            console.log('  круг ' + (i + 1) + '  ' + mode.padEnd(7)
                + ' код ' + String(r.code).padEnd(4)
                + ' событие' + s(r.firstEvent) + ' всего' + s(r.total)
                + '  ' + r.think + 'з/' + r.text + 'о  stop=' + (r.stop || '—')
                + (r.err ? '  ⚠ ' + r.err : ''));
            await new Promise((x) => setTimeout(x, PAUSE_MS));
        }
    }
    console.log('');
    for (const mode of ['direct', 'proxy']) {
        const rows = acc[mode];
        const resets = rows.filter((r) => /ECONNRESET|hang up|socket disconnected/i.test(r.err || '')).length;
        const bad = rows.filter((r) => r.code !== 200 || r.err).length;
        console.log('  ' + (mode === 'direct' ? 'напрямую ' : 'через нас')
            + '  обрывов ' + resets + '/' + rows.length
            + '  прочих отказов ' + (bad - resets)
            + '  медиана события ' + s(med(rows.filter((r) => r.code === 200).map((r) => r.firstEvent))));
    }
    console.log('\n  Читать так: обрывы ТОЛЬКО через нас → виноват наш пул соединений.');
    console.log('  Обрывы в обоих режимах → рубит путь до шлюза, лечится TCP-keepalive.');
    console.log('  Обрывов нет вовсе → эпизод прошёл, замер надо повторить на живой нагрузке.\n');
}

// Факторный прогон: каждый фактор включаем ПООДИНОЧКЕ поверх базы, потом всё вместе.
// Так видно вклад каждого, а не только итог — итог мы и без стенда знаем, что медленный.
async function cmdFactors(name) {
    const g = GATEWAYS[name] || GATEWAYS.justwoker;
    console.log(`\n  Факторный замер: ${g.label} :${g.port}, повторов ${REPS}, max_tokens ${MAX_TOKENS}`);
    console.log('  «ответ» = первый text_delta (это и есть «отвисло»). «з/о» = символов рассуждения / ответа\n');
    const cells = [
        ['база (без ничего)', {}],
        ['+ system 8КБ', { sys: 1 }],
        ['+ anthropic-beta', { beta: 1 }],
        ['+ thinking в теле', { think: 1 }],
        ['+ контекст 60КБ', { ctx: 1 }],
        ['всё вместе (как CC)', { sys: 1, beta: 1, think: 1, ctx: 1 }],
    ];
    for (const [label, f] of cells) line(label, await runCell(g.port, f, REPS));
}

// Сравнение шлюзов на ОДНОЙ реалистичной форме. Прошлый прогон сравнивал их на
// «say OK» и поэтому назвал самым быстрым того, кто просто не включил рассуждение.
async function cmdGateways() {
    const f = { sys: 1, beta: 1, think: 1, ctx: 1 };
    console.log(`\n  Шлюзы на клиентской форме запроса (system+beta+thinking+контекст), повторов ${REPS}\n`);
    for (const [key, g] of Object.entries(GATEWAYS)) {
        const up = await new Promise((res) => {
            const r = http.get({ hostname: '127.0.0.1', port: g.port, path: '/__keepalive/api/status', timeout: 1500 }, (x) => { x.resume(); res(x.statusCode === 200); });
            r.on('timeout', () => { r.destroy(); res(false); });
            r.on('error', () => res(false));
        });
        if (!up) { console.log('  ' + g.label.padEnd(26) + ' keepalive не слушает — пропуск'); continue; }
        line(g.label, await runCell(g.port, f, REPS));
    }
}

function cmdSelftest() {
    const assert = require('assert');
    // Тело должно расти ровно от тех факторов, которые заявлены.
    const base = buildBody({});
    const withSys = buildBody({ sys: 1 });
    const withCtx = buildBody({ ctx: 1 });
    assert.ok(withSys.length > base.length + 6000, 'system добавляет ~8КБ');
    assert.ok(withCtx.length > base.length + 50000, 'контекст добавляет ~60КБ');
    assert.ok(!JSON.parse(base).system, 'без фактора system его в теле нет');
    assert.ok(JSON.parse(withCtx).messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')),
        'контекст содержит tool_result — это имитация хода после инструмента');
    // budget_tokens < max_tokens, иначе Anthropic отвергает запрос до модели.
    const th = JSON.parse(buildBody({ think: 1 })).thinking;
    assert.ok(th && th.budget_tokens < Math.max(MAX_TOKENS, 1024) + 1, 'budget_tokens не превышает max_tokens');
    // Заголовок и путь — один фактор: у Claude Code они всегда вместе.
    assert.ok(buildHeaders({ beta: 1 }, 1)['anthropic-beta'], 'beta ставит заголовок');
    assert.ok(!buildHeaders({}, 1)['anthropic-beta'], 'без фактора заголовка нет');
    // Размеры набираются по байтам — проверяем, что заявленное совпадает с фактом.
    assert.strictEqual(Math.round(Buffer.byteLength(SYSTEM) / 1024), SYS_KB, `system ровно ${SYS_KB}КБ`);
    // Ключей стенд не читает: настоящий подставляет keepalive, мы шлём заглушку.
    // 🪤 Проверять это грепом своего же исходника нельзя — регэксп совпал бы с
    // текстом самой проверки (наступил дважды). Проверяем поведение, а не текст.
    assert.strictEqual(buildHeaders({}, 1)['x-api-key'], 'dummy', 'уходит заглушка, не живой ключ');
    assert.ok(!('authorization' in buildHeaders({}, 1)), 'своего Authorization стенд не ставит');
    // У каждого шлюза есть хост и файл ключа — иначе прямой режим молча ушёл бы в прокси.
    for (const [k, g] of Object.entries(GATEWAYS)) {
        assert.ok(g.host && g.keyFile, `у ${k} есть host и keyFile для прямого режима`);
    }
    console.log('  selftest OK');
}

(async () => {
    const cmd = process.argv[2];
    if (cmd === 'factors') await cmdFactors(process.argv[3]);
    else if (cmd === 'gateways') await cmdGateways();
    else if (cmd === 'resets') await cmdResets(process.argv[3]);
    else if (cmd === 'selftest') cmdSelftest();
    else {
        console.log('\n  node bench-latency.js factors [провайдер]   что именно даёт задержку');
        console.log('  node bench-latency.js gateways              шлюзы на клиентской форме');
        console.log('  node bench-latency.js resets [провайдер]    кто рвёт связь: путь или наш пул');
        console.log('  node bench-latency.js selftest              проверка стенда без сети\n');
        process.exit(1);
    }
})();
