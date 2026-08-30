// pool-watchdog.js — «пул провайдера пуст» замечаем и ГРОМКО говорим. Не переключаем.
//
// ЗАЧЕМ. 24.08 go/jw начали отвечать `503 {"type":"<nil>","message":"all nodes
// exhausted; retry later"}` — это ошибка САМОГО Go-шлюза: у него не осталось живых
// каналов. keepalive честно ретраил три раза и отдавал 503 наверх, front-door его
// транслировал, Claude Code умирал. Со стороны это выглядело как «прокси сломался»,
// хотя сломался пул аккаунтов на той стороне. Полчаса ушло на то, чтобы это понять
// по логам — вотчдог существует, чтобы такого больше не было.
//
// ЧЕГО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ (решение владельца 2026-08-24):
//   • НЕ переписывает ~/.claude/active-backend.json. Автопереключение тратило бы
//     деньги другого аккаунта без спроса — выбор остаётся за человеком. На этот
//     запрет стоит ассерт в selftest, чтобы «полезное улучшение» его не сняло.
//   • НЕ делает платных запросов. Только локальный GET /__state у keepalive —
//     бесплатно и никак не влияет на пул. Узнать «есть ли деньги у go» без траты
//     нельзя, поэтому вотчдог говорит про ЗДОРОВЬЕ (кто отвечает), а не про баланс.
//   • НЕ трогает ни один процесс денежного пути. Отдельный процесс, отдельный файл.
//     Откат = убить его и удалить два файла.
//
// КАК ОПРЕДЕЛЯЕТ. У keepalive в /__state лежит stats.byStatus — распределение
// ФИНАЛЬНЫХ ответов клиенту с момента старта процесса. Пустой пул выглядит так:
// прирост 5xx есть, прироста 2xx нет. Одного окна мало (случайная 503 бывает у
// живого шлюза), поэтому нужно STRIKES окон подряд.
// 🪤 byStatus хранит только КОДЫ, без тел. Фразы `all nodes exhausted` тут нет —
// она живёт в keepalive-proxy.log. Поэтому вотчдог говорит «пул похоже пуст (5xx
// без 2xx)», а не цитирует шлюз: врать точной цитатой хуже, чем честно обобщить.
//
// ЗАПУСК
//   node pool-watchdog.js                  # следить (Ctrl-C — выход)
//   node pool-watchdog.js once             # один прогон: показать состояние и выйти
//   node pool-watchdog.js selftest         # самопроверка, сеть не нужна
//
// ПЕРЕМЕННЫЕ
//   POLL_MS=15000     период опроса
//   STRIKES=2         сколько окон подряд «5xx без 2xx» = тревога
//   ALERT_TOAST=1     плюс всплывашка Windows (по умолчанию выключено)
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

const POLL_MS = Number(process.env.POLL_MS || 15000);
const STRIKES = Number(process.env.STRIKES || 2);
const ALERT_TOAST = process.env.ALERT_TOAST === '1';
// Порт статуса. 20134 — вплотную к keepalive-блоку AgentRouter (20132 конвертер,
// 20133 keepalive) и ВНЕ диапазона Custom-конвертеров (те дефолтят на 20150+ и
// нумеруются дашбордом динамически — залезать туда рискованно).
const WATCHDOG_PORT = Number(process.env.WATCHDOG_PORT || 20134);
const STATE_FILE = process.env.ACTIVE_BACKEND_FILE
    || path.join(os.homedir(), '.claude', 'active-backend.json');
const ALERT_FILE = path.join(__dirname, 'pool-alert.json');
const LOG_FILE = path.join(__dirname, 'pool-watchdog.log');

// Порты keepalive-инстансов. Это ДУБЛЬ знания из transparent-proxy.js § BACKENDS —
// осознанный: вотчдог отдельный процесс и тянуть 14 тыс. строк дашборда ради пяти
// чисел незачем. Расхождение не тихое: имя провайдера мы всё равно берём из
// /__state.upstream, так что неверный порт даст «не слушает», а не путаницу.
// xpeach :20157 — легаси (все ключи banned, решение 22.08), в опрос не берём.
// seekai :20159 — легаси с 24.08 (реселл веб-Клода: подменяет системный промпт, для
// Claude Code непригоден), тоже не опрашиваем: тревожить о шлюзе, которым не пользуются,
// значит учить владельца игнорировать вотчдог.
const KEEPALIVES = [
    { backend: 'agentrouter', port: 20133 },
    { backend: 'tabi', port: 20155 },
    { backend: 'gorouter', port: 20156 },
    { backend: 'justwoker', port: 20158 },
    // truesota :20160 — живой шлюз с 25.08, поэтому в опросе. 🪤 Но пригодных моделей у
    // него две (opus-5 и opus-5-thinking): падение тут значит «шлюз не отвечает», а не
    // «модель не та» — про подмену системного промпта вотчдог ничего не знает.
    { backend: 'truesota', port: 20160 },
    // kktoken :20161 — восьмой шлюз, живой с 31.08, поэтому в опросе.
    { backend: 'kktoken', port: 20161 },
];

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stderr.write(line);
    try { fs.appendFileSync(LOG_FILE, line); } catch { /* лог не критичен */ }
}

// ── Чистая часть: посчитать прирост и вынести вердикт ─────────────────────────
// Отдельно от сети, чтобы проверялось ассертами без живых прокси.
function sumByPrefix(byStatus, prefix) {
    let n = 0;
    for (const [code, count] of Object.entries(byStatus || {})) {
        if (String(code).startsWith(prefix)) n += Number(count) || 0;
    }
    return n;
}

// prev/cur — снимки stats.byStatus. Вердикт только по ПРИРОСТУ: абсолютные числа
// накоплены с запуска процесса и про «сейчас» не говорят ничего.
function classify(prev, cur) {
    const d2 = sumByPrefix(cur, '2') - sumByPrefix(prev, '2');
    const d5 = sumByPrefix(cur, '5') - sumByPrefix(prev, '5');
    // Рестарт keepalive обнуляет счётчики → отрицательный прирост. Это не «починился»
    // и не «сломался», это новый процесс: окно пропускаем.
    if (d2 < 0 || d5 < 0) return { verdict: 'reset', d2, d5 };
    if (d5 > 0 && d2 === 0) return { verdict: 'bad', d2, d5 };
    if (d2 > 0) return { verdict: 'good', d2, d5 };
    return { verdict: 'idle', d2, d5 };
}

function getJson(port, urlPath, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.get({
            hostname: '127.0.0.1', port, path: urlPath, timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve({ up: true, error: `HTTP ${res.statusCode}` });
                try { resolve({ up: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
                catch (e) { resolve({ up: true, error: `битый JSON: ${e.message}` }); }
            });
            res.on('error', (e) => resolve({ up: true, error: e.message }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        // ECONNREFUSED = keepalive этого провайдера просто не запущен. Это НЕ поломка:
        // неактивные keepalive поднимаются только при активации (respawn:false).
        req.on('error', (e) => resolve({ up: false, error: e.code || e.message }));
    });
}

function activeBackend() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const port = Number(new URL(String(doc.upstream || '')).port) || null;
        return { backend: String(doc.backend || 'unknown'), upstream: String(doc.upstream || ''), port };
    } catch (e) {
        return { backend: null, upstream: null, port: null, error: e.message };
    }
}

const prevStats = new Map();   // port -> byStatus на прошлом опросе
const strikes = new Map();     // port -> сколько окон подряд «плохо»
let alerting = false;

async function pollOnce(quiet = false) {
    const active = activeBackend();
    const rows = [];

    for (const k of KEEPALIVES) {
        const r = await getJson(k.port, '/__state');
        const row = { backend: k.backend, port: k.port, active: k.port === active.port };
        if (!r.up) { row.state = 'не запущен'; row.detail = r.error; rows.push(row); strikes.delete(k.port); continue; }
        if (!r.json) { row.state = 'отвечает мусором'; row.detail = r.error; rows.push(row); continue; }

        const st = r.json.stats || {};
        const by = st.byStatus || {};
        row.upstream = r.json.upstream || null;
        row.requests = Number(st.requests) || 0;

        const prev = prevStats.get(k.port);
        prevStats.set(k.port, by);
        if (!prev) { row.state = 'первый опрос (нет базы для прироста)'; rows.push(row); continue; }

        const c = classify(prev, by);
        row.d2xx = c.d2; row.d5xx = c.d5;
        if (c.verdict === 'bad') {
            const s = (strikes.get(k.port) || 0) + 1;
            strikes.set(k.port, s);
            row.state = `5xx без 2xx (${s}/${STRIKES})`;
            row.exhausted = s >= STRIKES;
        } else {
            if (c.verdict === 'good') strikes.delete(k.port);
            row.state = { good: 'отвечает', idle: 'тишина', reset: 'счётчики обнулились (рестарт)' }[c.verdict];
        }
        rows.push(row);
    }

    const activeRow = rows.find((r) => r.active);
    const alive = rows.filter((r) => r.state === 'отвечает' && !r.active).map((r) => r.backend);
    const upNotActive = rows.filter((r) => r.upstream && !r.active).map((r) => r.backend);

    // Тревога только про АКТИВНЫЙ бэкенд: остальные могут молчать просто потому, что
    // через них никто не ходит, и «5xx без 2xx» у них ничего не значит.
    if (activeRow && activeRow.exhausted) {
        if (!alerting) {
            alerting = true;
            const cand = alive.length ? alive.join(', ') : (upNotActive.length ? upNotActive.join(', ') + ' (запущены, но трафика не видели)' : 'ни один другой keepalive не запущен');
            log('');
            log('  ╔══════════════════════════════════════════════════════════════╗');
            log(`  ║ ПУЛ ПУСТ: ${String(activeRow.backend).padEnd(50)}║`);
            log('  ╚══════════════════════════════════════════════════════════════╝');
            log(`  Активный бэкенд отдаёт 5xx и ни одного успеха (${activeRow.d5xx} ошибок за окно).`);
            log('  Похоже на "all nodes exhausted" — у шлюза не осталось живых каналов.');
            log(`  Живые альтернативы: ${cand}`);
            log('  Переключить: дашборд :8200 → вкладка провайдера → активировать.');
            log('  Вотчдог НЕ переключает сам (так решено) — деньги другого аккаунта твои.');
            log('');
            notifyToast(`Пул ${activeRow.backend} пуст. Живые: ${cand}`);
        }
    } else if (alerting && activeRow && activeRow.state === 'отвечает') {
        alerting = false;
        log(`ВОССТАНОВИЛОСЬ: ${activeRow.backend} снова отвечает 2xx — тревога снята.`);
    }

    const alert = {
        v: 1,
        at: new Date().toISOString(),
        active: active.backend,
        alerting,
        rows,
        hint: alerting ? 'активный пул пуст — переключи провайдера в дашборде :8200' : null,
    };
    try { fs.writeFileSync(ALERT_FILE, JSON.stringify(alert, null, 2) + '\n', 'utf8'); } catch { /* не критично */ }

    if (!quiet) {
        for (const r of rows) {
            const mark = r.active ? '→' : ' ';
            const d = (r.d2xx === undefined) ? '' : `  Δ2xx=${r.d2xx} Δ5xx=${r.d5xx}`;
            process.stderr.write(`  ${mark} ${String(r.backend).padEnd(12)} :${r.port}  ${r.state}${d}\n`);
        }
    }
    return alert;
}

// Всплывашка Windows. Строго опциональна: по умолчанию выключена, чтобы вотчдог не
// стал тем, что раздражает и потому выключается целиком.
function notifyToast(text) {
    if (!ALERT_TOAST) return;
    try {
        const { spawn } = require('child_process');
        // Кириллицу передаём аргументом, а не в тело скрипта: .ps1 с кириллицей без BOM
        // PowerShell 5.1 читает как ANSI и ломается (правило проекта по кодировкам).
        const ps = 'Add-Type -AssemblyName System.Windows.Forms;'
            + '$n=New-Object System.Windows.Forms.NotifyIcon;'
            + '$n.Icon=[System.Drawing.SystemIcons]::Warning;$n.Visible=$true;'
            + '$n.ShowBalloonTip(10000,"LLM-пул",$args[0],"Warning");Start-Sleep -Seconds 11';
        spawn('powershell.exe', ['-NoProfile', '-Command', ps, text], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) { log(`всплывашка не вышла: ${e.message}`); }
}

// ── Самопроверка ──────────────────────────────────────────────────────────────
if (process.argv[2] === 'selftest') {
    const assert = require('assert');

    // Прирост считается по префиксу кода, а не по точному совпадению.
    assert.strictEqual(sumByPrefix({ '200': 3, '201': 1, '503': 9 }, '2'), 4, '2xx суммируются');
    assert.strictEqual(sumByPrefix({ '500': 2, '503': 3 }, '5'), 5, '5xx суммируются');
    assert.strictEqual(sumByPrefix({}, '2'), 0, 'пустой byStatus = 0');
    assert.strictEqual(sumByPrefix(undefined, '2'), 0, 'отсутствующий byStatus не роняет');

    // Вердикты.
    assert.strictEqual(classify({ '200': 5 }, { '200': 5, '503': 3 }).verdict, 'bad',
        '5xx без новых 2xx = плохо');
    assert.strictEqual(classify({ '200': 5 }, { '200': 7, '503': 3 }).verdict, 'good',
        'есть новые 2xx = живой, даже если параллельно были 5xx');
    assert.strictEqual(classify({ '200': 5 }, { '200': 5 }).verdict, 'idle',
        'нет прироста вообще = тишина, не поломка');
    assert.strictEqual(classify({ '200': 9 }, { '200': 1 }).verdict, 'reset',
        'счётчики упали = рестарт процесса, окно пропускаем');
    // Именно этот случай стоил разбора 24.08: 503 идут, успехов ноль.
    assert.strictEqual(classify({ '503': 1 }, { '503': 4 }).verdict, 'bad', 'серия 503 подряд');

    // Запрет автопереключения — не на словах, а проверкой собственного исходника.
    const src = fs.readFileSync(__filename, 'utf8');
    assert.ok(!/writeFileSync\s*\(\s*STATE_FILE/.test(src),
        'вотчдог НЕ пишет active-backend.json (автопереключение запрещено владельцем)');
    assert.ok(!KEEPALIVES.some((k) => k.port === 20157 || k.backend === 'xpeach'),
        'xpeach :20157 в опрос не попадает (легаси, все ключи banned)');
    assert.strictEqual(KEEPALIVES.length, 4, 'опрашиваем четыре живых шлюза');

    console.log('selftest OK');
    process.exit(0);
}

(async () => {
    const once = process.argv[2] === 'once';
    const a = activeBackend();
    log(`вотчдог пулов: активный бэкенд ${a.backend || '?'} (${a.upstream || 'нет состояния'}), опрос ${POLL_MS}мс, порог ${STRIKES}`);
    log('переключать сам НЕ буду — только сообщу. Тревога дублируется в pool-alert.json');

    if (once) {
        // Один прогон не может дать прирост (нет базы), поэтому делаем два с паузой:
        // иначе `once` всегда печатал бы «первый опрос» и был бы бесполезен.
        await pollOnce(false);
        process.stderr.write(`  … пауза ${Math.min(POLL_MS, 5000)}мс для замера прироста\n`);
        await new Promise((r) => setTimeout(r, Math.min(POLL_MS, 5000)));
        await pollOnce(false);
        process.exit(0);
    }

    // Статус-эндпоинт: через него lifecycle.js держит вотчдог как обычный сервис
    // (поднимает по порту, health-чек, гасит при рестарте). Без слушающего порта
    // хаб не смог бы им управлять и вотчдог жил бы мимо общей машинерии.
    let lastAlert = null;
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && (req.url || '').split('?')[0] === '/__watchdog/api/status') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, port: WATCHDOG_PORT, poll_ms: POLL_MS, strikes: STRIKES, alerting: lastAlert ? lastAlert.alerting : false, last: lastAlert }));
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
    });
    server.on('error', (e) => log(`порт статуса :${WATCHDOG_PORT} занят (${e.code}) — работаю без него`));
    server.listen(WATCHDOG_PORT, '127.0.0.1', () => log(`статус: http://localhost:${WATCHDOG_PORT}/__watchdog/api/status`));

    const tick = async () => {
        try { lastAlert = await pollOnce(true); } catch (e) { log(`опрос упал: ${e.message}`); }
    };
    await tick();                                // первый опрос — только базовая линия
    setInterval(tick, POLL_MS);
})();
