#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  check-after-restart.js — что из правок ДОЕХАЛО до живого хаба :8200.
//
//  Зачем файл существует. Дашборд правится на ходу, а перезапускает его только
//  владелец: рестарт рвёт front-door :20100, а через него ходит Claude Code.
//  Поэтому стек постоянно живёт в двух состояниях сразу: HTML читается с диска
//  на КАЖДЫЙ запрос (то есть новый), а роуты и функции лежат в памяти процесса
//  (то есть старые). Отсюда классика этого проекта — «правка в файле есть»
//  принимают за «работает в бою», и красная проверка приходит через сутки.
//
//  Скрипт спрашивает у ЖИВОГО процесса, а не у файлов: одна команда после
//  рестарта отвечает, что доехало, а что нет.
//
//  Чем отличается от соседей: check-league.js вырезает функции лиги из
//  transparent-proxy.js и считает арифметику среза в песочнице — он проверяет
//  КОД НА ДИСКЕ и живой хаб не трогает. Здесь наоборот: спрашивается процесс.
//
//  Безопасность — условие задачи, запуск идёт по живой системе:
//    · только чтение и замер: ни одного удаления, ни одной записи в общий чат,
//      ни одной правки конфигов;
//    · POST'ы делаются ТОЛЬКО с телом, которое хаб отбивает своей валидацией
//      ДО обращения к приёмнику (пустое сообщение, пустая аватарка) — это
//      проба маршрута, а не действие;
//    · POST /__switch/api/league/sync НЕ зовётся — он шлёт срез соседям;
//    · GET /__switch/api/health НЕ зовётся — он делает git fetch и чинит
//      протухшие записи конвертеров, то есть пишет в конфиг;
//    · что нельзя проверить безопасно — печатается как skip с причиной, а не
//      выдаётся за проверенное;
//    · ключ лиги (routing/league-config.json) не печатается ни в одной ветке:
//      он читается ровно затем, чтобы затирать себя же в чужих строках.
//
//  Запуск:  node tools/check-after-restart.js
//           node tools/check-after-restart.js --with-receiver
//           (второй вариант добавляет пробы, которые уходят на приёмник по
//            сети: чтение чата и удаление несуществующего сообщения)
//
//  Порт хаба — SWITCHER_PORT (по умолчанию 8200), как у остальных tools/.
//  exit 1 = что-то не доехало.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SWITCHER_PORT || process.env.HUB_PORT || 8200);
const WITH_RECEIVER = process.argv.includes('--with-receiver')
    || process.env.CHECK_WITH_RECEIVER === '1';
// Порог второго среза. Замер 05.09 (три прогона по три вызова): без кеша
// журналов 130…190 мс, с кешем 11…13 мс. 60 мс — середина, в которую не
// попадает ни то, ни другое даже когда машина занята.
const SLICE_SLOW_MS = Number(process.env.CHECK_SLICE_MS || 60);

// ── Секреты: читаем, чтобы затирать, и никогда не печатаем ───────────────────
// Ключ лиги ходит только в заголовке запроса, и в сообщениях об ошибках его нет
// by design. Но отчёт этого скрипта уезжает в чат и в вики, поэтому страховка
// стоит на выходе: любая строка перед печатью проходит через safe().
// 🪤 Список строится ОБХОДОМ конфига целиком, а не по именам `key`/`pin`. Разбор
// 05.09 показал мину: при смене формы конфига (личный секрет участника вместо
// одного общего ключа) затирать по именам стало бы нечего, и секрет уехал бы в
// отчёт молча. Поэтому берём каждое строковое значение подходящей длины, кроме
// заведомо не секретных полей.
const SECRET_SKIP = new Set(['url', 'ip', 'host', 'name', 'nick', 'note', 'comment']);
const SECRETS = [];
try {
    const raw = fs.readFileSync(path.join(ROOT, 'routing', 'league-config.json'), 'utf8');
    const c = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 4) return;
        for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object') { walk(v, depth + 1); continue; }
            if (typeof v !== 'string' || v.length < 8) continue;
            if (SECRET_SKIP.has(k)) continue;
            SECRETS.push(v);
        }
    };
    walk(c, 0);
    // Длинные затираем первыми: иначе короткий секрет, входящий в длинный,
    // порежет его на куски и остаток длинного попадёт в вывод.
    SECRETS.sort((a, b) => b.length - a.length);
} catch (e) { /* лиги нет — и затирать нечего */ }

function safe(v) {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined) s = String(v);
    for (const k of SECRETS) s = s.split(k).join('«скрыто»');
    // Адрес приёмника секретом не считается (его вписал сам владелец, и хаб
    // отдаёт его в /api/league), но светить IP в отчётах незачем.
    return s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
        m => (m === '127.0.0.1' ? m : m.split('.')[0] + '.x.x.x'));
}

const TTY = !!process.stdout.isTTY;
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const MARK = { ok: paint(32, '✅ ok'), fail: paint(31, '❌ FAIL'), skip: paint(33, '⏭ skip') };

let nOk = 0, nBad = 0, nSkip = 0, num = 0;
function tell(verdict, name, want, got) {
    num++;
    if (verdict === 'ok') nOk++; else if (verdict === 'fail') nBad++; else nSkip++;
    console.log(`\n[${String(num).padStart(2)}] ${name}  ${MARK[verdict]}`);
    console.log(`     ждём: ${safe(want)}`);
    console.log(`     факт: ${safe(got)}`);
}
const vd = cond => (cond ? 'ok' : 'fail');

function req(method, p, body, timeoutMs) {
    const tmo = timeoutMs || 30000;
    return new Promise((resolve) => {
        const data = (body === undefined || body === null) ? null : JSON.stringify(body);
        const t0 = process.hrtime.bigint();
        const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
        const r = http.request({
            host: '127.0.0.1', port: PORT, path: p, method, timeout: tmo,
            headers: data
                ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
                : {},
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* не JSON — так и скажем */ }
                resolve({ status: res.statusCode, ms: ms(), json, text, bytes: text.length });
            });
        });
        r.on('timeout', () => r.destroy(new Error(`таймаут ${Math.round(tmo / 1000)} с`)));
        r.on('error', e => resolve({ error: e.message, ms: ms() }));
        if (data) r.write(data);
        r.end();
    });
}

// Хаб печатает время старта только как ЧЧ:ММ (см. 404-ответ под /__switch/api/
// в transparent-proxy.js). Достраиваем дату: время из будущего значит вчера.
function hhmmToday(h, m) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() > Date.now() + 60000) d.setDate(d.getDate() - 1);
    return d.getTime();
}
const hm = ms => new Date(ms).toTimeString().slice(0, 5);
const ago = (iso) => {
    const d = Date.now() - Date.parse(iso);
    if (!Number.isFinite(d)) return '?';
    const mn = Math.round(d / 60000);
    return mn < 1 ? 'только что' : mn < 60 ? `${mn} мин назад` : `${(mn / 60).toFixed(1)} ч назад`;
};
const sum = a => (a || []).reduce((x, y) => x + y, 0);
const r2 = v => Math.round(v * 100) / 100;
const num0 = v => (Number.isFinite(v) ? v.toLocaleString('ru-RU') : String(v));

// Модули, которые тело хаба тянет через require. Список СОБИРАЕТСЯ из кода, а не
// пишется руками: иначе он устареет первым же новым `require`. Отступ в строке
// объявления отличает ленивый require (внутри обработчика — файл читается при
// первом вызове и дальше живёт из кеша) от жадного (на старте процесса).
function loadedModules(src) {
    const seen = new Map();
    const re = /require\('(\.[^']+)'\)/g;
    let m;
    while ((m = re.exec(src))) {
        let p = path.resolve(ROOT, 'routing', m[1]);
        if (!fs.existsSync(p) && fs.existsSync(p + '.js')) p += '.js';
        let stat = null;
        try { stat = fs.statSync(p); } catch (e) { continue; }
        if (!stat.isFile()) continue;
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const eager = /^const\s/.test(src.slice(lineStart, m.index + 1));
        const prev = seen.get(p);
        if (!prev) seen.set(p, { p, mtime: stat.mtimeMs, eager });
        else if (eager) prev.eager = true;
    }
    return [...seen.values()];
}

function gitHead() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
            { cwd: ROOT, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) { return null; }
}

async function main() {
    console.log(`\ncheck-after-restart → http://127.0.0.1:${PORT}/__switch`
        + (WITH_RECEIVER ? '   (пробы на приёмник ВКЛЮЧЕНЫ)' : '   (пробы на приёмник выключены)'));

    // ── 1. хаб отвечает вообще ───────────────────────────────────────────────
    const WANT_ST = `200 на GET /__switch/api/status, в теле current и таблица backends`;
    const st = await req('GET', '/__switch/api/status', null, 8000);
    if (st.error || st.status !== 200 || !st.json || !st.json.backends) {
        tell('fail', 'хаб отвечает', WANT_ST, st.error
            ? `не ответил: ${st.error}`
            : `код ${st.status}, тело «${String(st.text || '').slice(0, 120)}»`);
        console.log(`\nитог: ${nOk} прошло, ${nBad} упало, ${nSkip} пропущено`);
        console.log(`дальше идти некуда: на :${PORT} не отвечает дашборд.`);
        process.exit(1);
    }
    tell('ok', 'хаб отвечает', WANT_ST,
        `200 за ${st.ms.toFixed(0)} мс, активный бэкенд ${st.json.current},`
        + ` в таблице ${Object.keys(st.json.backends).length} шлюзов`);

    // ── 2. процесс не старее кода (спрашиваем сам хаб) ───────────────────────
    // Хаб сам умеет это сказать: на неизвестный роут под /__switch/api/ он
    // отвечает JSON'ом с `stale_process` — сравнением mtime своего файла со
    // временем старта. Проба безопасна by design: роута нет, обработчика нет.
    const probe = await req('GET', `/__switch/api/__check-after-restart-${Date.now()}`, null, 8000);
    const pmsg = (probe.json && probe.json.error) || probe.text || '';
    const bootM = /процесс поднят в (\d{1,2}):(\d{2})/i.exec(pmsg);
    const bootedAt = bootM ? hhmmToday(+bootM[1], +bootM[2]) : null;
    const codeM = /код на диске правлен в (\d{1,2}):(\d{2})/i.exec(pmsg);
    if (!probe.json || typeof probe.json.stale_process !== 'boolean') {
        tell('fail', 'процесс не старее своего кода',
            'JSON с полем stale_process на неизвестный роут под /__switch/api/',
            `код ${probe.status}, тело «${String(pmsg).slice(0, 140)}» — это сборка старше 24.08,`
            + ' в ней 404 приходит текстом и признака свежести нет вообще');
    } else {
        tell(vd(probe.json.stale_process === false), 'процесс не старее своего кода',
            'stale_process = false (transparent-proxy.js не правлен после старта процесса)',
            `stale_process = ${probe.json.stale_process}`
            + (bootedAt ? `, процесс поднят в ${hm(bootedAt)}` : ', время старта не разобрано')
            + (codeM ? `, код правлен в ${codeM[1]}:${codeM[2]}` : ''));
    }

    // ── 3. правки в загружаемых модулях доехали ──────────────────────────────
    // Признак хаба смотрит только на СВОЙ файл. Дашборд тянет ещё десяток
    // модулей, и правка в любом из них так же не доедет без рестарта: жадный
    // require прочитан на старте, ленивый — при первом вызове и дальше живёт из
    // кеша require. Поэтому «новее старта» здесь и есть «в процессе не то».
    const PROXY_SRC = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
    if (!bootedAt) {
        tell('skip', 'модули хаба не новее времени старта',
            'ни один загружаемый через require модуль не правлен после старта процесса',
            'время старта неизвестно — хаб не сказал его в 404-ответе');
    } else {
        const mods = loadedModules(PROXY_SRC)
            .filter(x => x.mtime > bootedAt + 60000)
            .sort((a, b) => b.mtime - a.mtime);
        tell(vd(mods.length === 0), 'модули хаба не новее времени старта',
            `ни один загружаемый через require модуль не правлен после ${hm(bootedAt)}`,
            mods.length === 0
                ? 'все загружаемые модули старше старта процесса'
                : `правлены после старта: ` + mods.slice(0, 5).map(x =>
                    `${path.relative(ROOT, x.p).replace(/\\/g, '/')} (${hm(x.mtime)}, ${x.eager ? 'жадный' : 'ленивый'})`)
                    .join('; ') + (mods.length > 5 ? ` и ещё ${mods.length - 5}` : ''));
    }

    // ── 4. кеш журналов: второй срез обязан быть дешёвым ─────────────────────
    // Срез лиги читает три append-only журнала (token-usage 4.9 МБ, history 6.5,
    // finance-history 1 МБ). До 05.09 каждый запрос перечитывал их целиком —
    // 130…190 мс на пустом месте; теперь помнится смещение и читается хвост.
    // Первый запрос ПОСЛЕ РЕСТАРТА честно читает всё (~200 мс) — это цена
    // холодного старта процесса, поэтому вердикт ставится по второму.
    const s1 = await req('GET', '/__switch/api/league', null, 60000);
    const s2 = await req('GET', '/__switch/api/league', null, 60000);
    const doc = (s2.json && s2.json.me) ? s2.json : (s1.json && s1.json.me ? s1.json : null);
    const me = doc && doc.me;
    const src = (me && me.src) || {};
    const WANT_CACHE = `второй срез ≤ ${SLICE_SLOW_MS} мс (без кеша журналов было 130…190 мс, с кешем 11…13)`
        + ' и журнал при этом реально разобран';
    if (!me) {
        tell('fail', 'кеш журналов: второй срез дешёвый', WANT_CACHE,
            `срез не собрался: ${s2.error || `код ${s2.status}, тело «${String(s2.text || '').slice(0, 160)}»`}`);
    } else {
        const lines = Number(src.journalLines) || 0;
        tell(vd(s2.ms <= SLICE_SLOW_MS && lines > 0), 'кеш журналов: второй срез дешёвый', WANT_CACHE,
            `первый ${s1.ms ? s1.ms.toFixed(0) : '—'} мс, второй ${s2.ms.toFixed(0)} мс;`
            + ` строк token-usage ${num0(lines)}, записей finance-history ${num0(Number(src.financeLines) || 0)}`
            + (lines === 0 ? ' — быстро, но по нулю строк: это не кеш, а пустой журнал' : '')
            + (s2.ms > SLICE_SLOW_MS && s1.ms > s2.ms * 3
                ? ' — похоже на холодный старт процесса, прогони ещё раз' : ''));
    }

    // ── 5. сборка, которую отдаёт живой процесс ──────────────────────────────
    // `hubBuild()` считается ОДИН раз и кешируется на весь срок жизни процесса,
    // поэтому sha в срезе — это HEAD на момент первой сборки после старта.
    // Разошёлся с HEAD на диске — работает не тот код, что лежит в чекауте.
    const head = gitHead();
    let pkgVer = null;
    try { pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null; } catch (e) {}
    if (!me) {
        tell('skip', 'сборка хаба совпадает с чекаутом', 'ver из package.json и sha = git HEAD',
            'срез не собрался — версию спросить негде');
    } else if (!me.ver && !me.sha) {
        tell('fail', 'сборка хаба совпадает с чекаутом', 'в срезе поля ver и sha (hubBuild)',
            'срез без ver/sha — сборка до появления hubBuild(), версию хаб не сообщает вообще');
    } else {
        const okVer = !pkgVer || me.ver === pkgVer;
        const okSha = !head || me.sha === head;
        tell(vd(okVer && okSha), 'сборка хаба совпадает с чекаутом',
            `ver = ${pkgVer || '?'} (package.json), sha = ${head || '?'} (git HEAD)`,
            `хаб отдаёт ver ${me.ver || '—'}, sha ${me.sha || '—'}`
            + (okSha ? '' : ` — процесс держит сборку ${me.sha}, а на диске уже ${head}`)
            + (okVer ? '' : ` — версия расходится с package.json (${pkgVer})`));
    }

    const WINS = ['h24', 'd7', 'd30', 'all'];
    const keysOf = w => ((me && me.keys && me.keys[w]) || []);

    // ── 6. в срезе есть НАЛИВ (`tu`) ─────────────────────────────────────────
    // Раньше срез отдавал только расход, и вкладка не могла показать, откуда
    // деньги взялись: за неделю сожжено $6970 при наливе $17559 — без второй
    // цифры первая читается как убыток. Имена полей из leagueSelf(): ряды `tu`
    // по четырём окнам плюс итоги tuD/tuW/tuM/tuA в `tot`.
    const WANT_TU = 'ряды tu.{h24,d7,d30,all} длиной в подписи + итоги tot.{tuD,tuW,tuM,tuA},'
        + ' и итог недели равен сумме своего ряда';
    if (!me) {
        tell('skip', 'срез отдаёт налив (tu)', WANT_TU, 'срез не собрался');
    } else {
        const tu = me.tu || {};
        const tot = me.tot || {};
        const rowsOk = WINS.every(w => Array.isArray(tu[w]) && tu[w].length === keysOf(w).length);
        const totOk = ['tuD', 'tuW', 'tuM', 'tuA'].every(k => Number.isFinite(tot[k]));
        const sumOk = rowsOk && totOk && Math.abs(r2(sum(tu.d7)) - tot.tuW) < 0.02;
        tell(vd(rowsOk && totOk && sumOk), 'срез отдаёт налив (tu)', WANT_TU,
            !me.tu ? 'поля tu в срезе НЕТ — процесс на сборке до налива'
                : `ряды ${WINS.map(w => `${w}:${(tu[w] || []).length}/${keysOf(w).length}`).join(' ')};`
                + ` налито сутки $${tot.tuD} · неделя $${tot.tuW} · месяц $${tot.tuM} · всё $${tot.tuA}`
                + `; сумма ряда d7 = $${r2(sum(tu.d7))}`
                + (sumOk ? '' : ' — итог недели и ряд разошлись'));
    }

    // ── 7. в срезе есть ПРИРОСТ АККАУНТОВ (`acc*`) ───────────────────────────
    // Кривая `acc` — уровень счётчика, итоги `tot.accD/accW/accM` — прирост
    // ВНУТРИ окна, `accA` — уровень. До 05.09 итогом всех окон брался уровень, и
    // три плитки показывали одно и то же 174. Ровно этот регресс и ловим.
    const WANT_ACC = 'ряды acc.{h24,d7,d30,all} + итоги tot.{accD,accW,accM,accA,accDated},'
        + ' причём accD/accW/accM — прирост окна, а не уровень счётчика';
    if (!me) {
        tell('skip', 'срез отдаёт прирост аккаунтов (acc*)', WANT_ACC, 'срез не собрался');
    } else {
        const tot = me.tot || {};
        const acc = me.acc || {};
        const rowsOk = WINS.every(w => Array.isArray(acc[w]) && acc[w].length === keysOf(w).length);
        const fields = ['accD', 'accW', 'accM', 'accA'];
        const totOk = fields.every(k => Number.isInteger(tot[k])) && Number.isInteger(tot.accDated);
        const levelBug = totOk && tot.accA > 0
            && new Set(fields.map(k => tot[k])).size === 1;
        const monoOk = totOk && tot.accW >= tot.accD && tot.accM >= tot.accW && tot.accA >= tot.accM;
        tell(vd(rowsOk && totOk && !levelBug && monoOk), 'срез отдаёт прирост аккаунтов (acc*)', WANT_ACC,
            !me.acc || !totOk
                ? `нет полей: ${['acc', ...fields, 'accDated'].filter(k => (k === 'acc' ? !me.acc : !Number.isInteger(tot[k]))).join(', ')}`
                : `заведено сегодня ${tot.accD} · за 7 дней ${tot.accW} · за 30 ${tot.accM}`
                + ` · всего ${tot.accA} (закуплено ${tot.bought} + зарегано ${tot.reg}, датировано ${tot.accDated})`
                + (levelBug ? ' — все четыре равны: итогом окна взят УРОВЕНЬ счётчика' : '')
                + (monoOk ? '' : ' — окна не вложены друг в друга')
                + (rowsOk ? '' : `; длины рядов не совпадают с подписями (${WINS.map(w => `${w}:${(acc[w] || []).length}/${keysOf(w).length}`).join(' ')})`));
    }

    // ── 8. лицо едет в срезе ─────────────────────────────────────────────────
    // Аватарку разносит только обмен срезами: другого канала между установками
    // нет. Поле обязано ПРИСУТСТВОВАТЬ; null — законное значение (лицо не
    // поставлено). Содержимое не печатается, только размер.
    const WANT_AV = 'в срезе поле avatar: либо null, либо data-URL с webp';
    if (!me) {
        tell('skip', 'лицо едет в срезе (avatar)', WANT_AV, 'срез не собрался');
    } else {
        const has = Object.prototype.hasOwnProperty.call(me, 'avatar');
        const v = me.avatar;
        const good = has && (v === null
            || (typeof v === 'string' && /^data:image\/webp;base64,/.test(v)));
        const b64 = typeof v === 'string' ? v.replace(/^data:[^,]{0,64},/, '') : '';
        tell(vd(good), 'лицо едет в срезе (avatar)', WANT_AV,
            !has ? 'поля avatar в срезе НЕТ — сборка до аватарок'
                : v === null ? 'поле есть, лицо не поставлено (null)'
                    : good ? `поле есть, webp ≈ ${Math.round(b64.length * 3 / 4 / 1024 * 10) / 10} КБ`
                        : `поле есть, но значение не похоже на data-URL с webp (${typeof v}, ${String(v).length} симв.)`);
    }

    // ── 9. обмен с приёмником: ТРИ состояния, а не два ───────────────────────
    // Вкладка раньше писала «приёмник не поднят» намертво — и врала: приёмник
    // работал, обмен проходил, просто соседи ещё не прислали свой срез. Чтобы
    // сказать правду, хабу мало флага «настроен»: нужны время и результат
    // последнего обмена (LEAGUE_SYNC_LAST в receiver.last).
    const rc = (doc && doc.receiver) || null;
    const last = (rc && rc.last) || null;
    const hasLast = !!(rc && Object.prototype.hasOwnProperty.call(rc, 'last')
        && last && typeof last === 'object'
        && Object.prototype.hasOwnProperty.call(last, 'ok')
        && Object.prototype.hasOwnProperty.call(last, 'at'));
    let state = 'неизвестно';
    if (rc && !rc.configured) state = 'приёмник не настроен';
    else if (rc && hasLast && !last.at) state = 'настроен, обмена ещё не было';
    else if (rc && hasLast && last.ok === false) state = 'настроен, обмен ПАДАЕТ';
    else if (rc && hasLast) state = 'обмен идёт';
    const WANT_RC = 'в /api/league объект receiver с configured + last{at,ok,error}: этого хватает,'
        + ' чтобы различить «не настроен» / «обмена ещё не было» / «обмен идёт»';
    if (!rc) {
        tell('fail', 'состояние приёмника: три состояния различимы', WANT_RC,
            doc ? 'в ответе нет объекта receiver вообще' : 'срез не собрался');
    } else {
        tell(vd(hasLast && state !== 'настроен, обмен ПАДАЕТ'),
            'состояние приёмника: три состояния различимы', WANT_RC,
            `состояние: ${state}`
            + (hasLast
                ? `; последний обмен ${last.at ? `${last.at} (${ago(last.at)})` : 'не случался'}`
                + `, ok=${last.ok}${last.error ? `, ошибка: ${String(last.error).slice(0, 120)}` : ''}`
                + `, соседей ${last.peers}`
                : '; поля last НЕТ — хаб умеет сказать только «настроен/нет», то есть два состояния')
            + `; период ${rc.everyMin} мин, peers-файл обновлён ${doc.peersUpdated || '—'}`
            + `, срезов соседей в файле ${((doc.peers) || []).length}`);
    }

    // ── 10. пиннинг переживает ПОВТОРНЫЙ обмен ───────────────────────────────
    // Тот баг: первый обмен проходил, а следующий падал с «отпечаток не совпал»
    // и пустым отпечатком — на возобновлённой TLS-сессии сервер не присылает
    // сертификат заново, и сравнивать нечем. Лечится агентом с keepAlive:false
    // и maxCachedSessions:0. Сам обмен отсюда НЕ инициируется (он шлёт срез
    // соседям) — доказательство берётся из счётчиков хаба: тиков с рестарта
    // прошло ≥2 и последний закончился успехом.
    const WANT_PIN = 'с момента старта прошло ≥2 тика обмена и последний прошёл успешно'
        + ' (вторая попытка — ровно то место, где пин рвался)';
    const everyMin = Math.max(2, Number(rc && rc.everyMin) || 10);
    // Первый тик — через минуту после старта, дальше раз в everyMin (leagueTick).
    const ticks = bootedAt
        ? Math.max(0, Math.floor((Date.now() - bootedAt - 60000) / (everyMin * 60000)) + 1)
        : null;
    const certRe = /отпечаток|сертификат/i;
    if (!rc || !hasLast) {
        tell('skip', 'пиннинг переживает повторный обмен', WANT_PIN,
            'состояния обмена нет — проверять нечем');
    } else if (!rc.configured) {
        tell('skip', 'пиннинг переживает повторный обмен', WANT_PIN,
            'лига не настроена: обмена нет, пин не задействован');
    } else if (last.ok === false) {
        tell('fail', 'пиннинг переживает повторный обмен', WANT_PIN,
            certRe.test(String(last.error || ''))
                ? `обмен падает НА ПИНЕ: ${String(last.error).slice(0, 160)}`
                + ' — это тот самый регресс keepAlive/maxCachedSessions'
                : `обмен падает: ${String(last.error || '?').slice(0, 160)}`);
    } else if (!last.at) {
        tell('skip', 'пиннинг переживает повторный обмен', WANT_PIN,
            `обмена ещё не было: первый тик — через минуту после старта, дальше раз в ${everyMin} мин`);
    } else if (ticks !== null && ticks < 2) {
        tell('skip', 'пиннинг переживает повторный обмен', WANT_PIN,
            `с рестарта прошёл ${ticks} тик — второй обмен ещё не случался.`
            + ` Повторить проверку через ${everyMin} мин`);
    } else {
        tell('ok', 'пиннинг переживает повторный обмен', WANT_PIN,
            `тиков с рестарта ≈${ticks === null ? '?' : ticks} (раз в ${everyMin} мин),`
            + ` последний обмен успешен: ${last.at} (${ago(last.at)})`);
    }

    // ── 11. маршрут ОТПРАВКИ в чат ───────────────────────────────────────────
    // Проба безопасна не по договорённости, а по коду: пустое тело хаб отбивает
    // своей проверкой `if (!text && !out.att)` ДО обращения к приёмнику, значит
    // в общий чат ничего не уходит. Приёмник, если бы дело до него дошло, тоже
    // отвечает 400 на пустое (league-receiver.js: `if (!text && !att)`).
    const WANT_POST = '400 «пустое сообщение» на POST /__switch/api/league/chat с пустым телом'
        + ' (маршрут есть, в чат ничего не уходит)';
    const p11 = await req('POST', '/__switch/api/league/chat', {}, 15000);
    const j11 = p11.json || {};
    tell(vd(p11.status === 400 && /пустое сообщение/i.test(String(j11.error || ''))
        || (p11.status === 503 && /не настроен/i.test(String(j11.error || '')))),
        'маршрут отправки в чат', WANT_POST,
        p11.error ? `запрос не прошёл: ${p11.error}`
            : j11.not_found ? `404: маршрута нет в процессе (${String(j11.error || '').split('\n')[0]})`
                : `код ${p11.status}, ответ ${JSON.stringify(j11).slice(0, 160)}`);

    // ── 12. маршрут ВЛОЖЕНИЯ ─────────────────────────────────────────────────
    // Нецифровое имя отбивается регуляркой handleLeagueAtt до всякой сети — это
    // и есть мягкая проба. Если маршрута в процессе нет, запрос свалится строкой
    // ниже, в чтение чата, и вернёт messages или срез — по ответу это видно.
    const WANT_ATT = '400 «ждём /chat/att/<номер>.webp» на GET .../league/chat/att/nan.webp';
    const p12 = await req('GET', '/__switch/api/league/chat/att/nan.webp', null, 15000);
    const j12 = p12.json || {};
    tell(vd(p12.status === 400 && /chat\/att/.test(String(j12.error || ''))),
        'маршрут вложения в чате', WANT_ATT,
        p12.error ? `запрос не прошёл: ${p12.error}`
            : j12.not_found ? '404: маршрута нет в процессе'
                : (j12.messages || j12.me) ? `код ${p12.status}: ответил не обработчик вложения, а ${j12.me ? 'срез лиги' : 'чтение чата'} — маршрута нет`
                    : `код ${p12.status}, ответ ${JSON.stringify(j12).slice(0, 160)}`);

    // ── 13. маршрут АВАТАРКИ ─────────────────────────────────────────────────
    // Пустое тело отбивает leagueImgParse, hubIdentityWrite до этого не доходит:
    // лицо на месте, файл личности не тронут.
    const WANT_AVR = '400 «нет картинки» на POST /__switch/api/league/avatar с пустым телом'
        + ' (маршрут есть, hub-identity.json не тронут)';
    const p13 = await req('POST', '/__switch/api/league/avatar', {}, 15000);
    const j13 = p13.json || {};
    tell(vd(p13.status === 400 && /нет картинки|webp/i.test(String(j13.error || ''))),
        'маршрут аватарки', WANT_AVR,
        p13.error ? `запрос не прошёл: ${p13.error}`
            : j13.not_found ? '404: маршрута нет в процессе'
                : `код ${p13.status}, ответ ${JSON.stringify(j13).slice(0, 160)}`);

    // ── 14. маршрут ЧТЕНИЯ чата ──────────────────────────────────────────────
    // Настроенный приёмник означает, что чтение уходит по сети на ноду. По
    // условию задачи туда не ходим — кроме явного --with-receiver. Локальная
    // проба разрешена ТОЛЬКО когда точно известно, что лига не настроена: тогда
    // ответ (200 и пустой список) хаб собирает у себя. Неизвестное состояние
    // (срез не собрался) считается настроенным — иначе проба уедет наружу вслепую.
    const WANT_GET = 'GET .../league/chat?since=<max> отвечает объектом с messages';
    const cfgOff = !!(rc && rc.configured === false);
    if (!cfgOff && !WITH_RECEIVER) {
        tell('skip', 'маршрут чтения чата', WANT_GET,
            (rc ? 'приёмник настроен: чтение уходит на ноду по сети.'
                : 'состояние приёмника неизвестно (срез не собрался) — считаем, что настроен.')
            + ' Запустить с --with-receiver, если дёргать приёмник можно');
    } else {
        const p14 = await req('GET', '/__switch/api/league/chat?since=9007199254740990', null, 20000);
        const j14 = p14.json || {};
        tell(vd(p14.status === 200 && Array.isArray(j14.messages)),
            'маршрут чтения чата', WANT_GET,
            p14.error ? `запрос не прошёл: ${p14.error}`
                : j14.not_found ? '404: маршрута нет в процессе'
                    : `код ${p14.status}, messages ${Array.isArray(j14.messages) ? j14.messages.length : '—'},`
                    + ` seq ${j14.seq}${j14.receiver ? `, приёмник настроен: ${!!j14.receiver.configured}` : ''}`);
    }

    // ── 15. маршрут УДАЛЕНИЯ ─────────────────────────────────────────────────
    // 🪤 Мягкой пробы этого маршрута при настроенном приёмнике НЕ СУЩЕСТВУЕТ:
    // handleLeagueChatDelete не имеет ни одной ветки, которая отвечала бы до
    // запроса на ноду, а DELETE .../chat БЕЗ номера снимает ВСЕ свои сообщения.
    // Поэтому по умолчанию — skip с причиной, а не «проверено». С флагом
    // --with-receiver уходит самый безобидный вариант: удаление seq 0, которого
    // не бывает (приёмник выдаёт номера с единицы) — он отвечает 404 «нет такого
    // сообщения» и журнал не переписывает.
    const routeInFile = /req\.method === 'DELETE' && req\.url\.startsWith\('\/__switch\/api\/league\/chat'\)/
        .test(PROXY_SRC);
    const WANT_DEL = 'маршрут DELETE /__switch/api/league/chat[/<seq>] отвечает обработчиком чата,'
        + ' а не 404';
    if (cfgOff) {
        const p15 = await req('DELETE', '/__switch/api/league/chat', null, 15000);
        const j15 = p15.json || {};
        tell(vd(p15.status === 200 && j15.removed === 0
            && !!j15.receiver && j15.receiver.configured === false),
            'маршрут удаления в чате', WANT_DEL,
            p15.error ? `запрос не прошёл: ${p15.error}`
                : j15.not_found ? '404: маршрута нет в процессе'
                    : `код ${p15.status}, ответ ${JSON.stringify(j15).slice(0, 160)}`
                    + ' (лига не настроена — ответ собран локально, ничего не удалялось)');
    } else if (WITH_RECEIVER) {
        const p15 = await req('DELETE', '/__switch/api/league/chat/0', null, 20000);
        const j15 = p15.json || {};
        tell(vd(!j15.not_found && (p15.status === 404 || p15.status === 200)),
            'маршрут удаления в чате', WANT_DEL,
            p15.error ? `запрос не прошёл: ${p15.error}`
                : j15.not_found ? '404 от самого хаба: маршрута нет в процессе'
                    : `код ${p15.status}, ответ приёмника ${JSON.stringify(j15).slice(0, 160)}`
                    + ' (сообщения с номером 0 не бывает — ничего не удалено)');
    } else {
        tell('skip', 'маршрут удаления в чате', WANT_DEL,
            (rc ? 'приёмник настроен' : 'состояние приёмника неизвестно — считаем, что настроен')
            + ', а безопасной пробы у DELETE нет: без номера он снимает все свои'
            + ' сообщения. В коде на диске маршрут '
            + (routeInFile ? 'зарегистрирован' : 'НЕ НАЙДЕН — это отдельный разбор')
            + `; соседние ручки того же блока (отправка, вложение) проверены выше.`
            + ' Полная проверка — с --with-receiver');
    }

    // ── 16. фронт различает три состояния словами ────────────────────────────
    // HTML отдаётся с диска на каждый запрос, поэтому эта половина не зависит от
    // рестарта — и проверять её надо именно на живом хабе, иначе непонятно, что
    // видит браузер. Три ветки lgReceiverState и есть тот самый разбор, который
    // раньше был захардкоженной строкой «приёмник не поднят».
    const WANT_UI = 'в отдаваемом HTML есть lgReceiverState с тремя ветками:'
        + ' «не настроен» / «обмена ещё не было» / «обмен идёт|падает»';
    const ui = await req('GET', '/__switch', null, 20000);
    const html = ui.text || '';
    const uiOk = /function lgReceiverState\(/.test(html)
        && /приёмник не настроен/.test(html)
        && /ещё не было/.test(html)
        && /обмен падает/.test(html);
    tell(vd(ui.status === 200 && uiOk), 'фронт различает три состояния приёмника', WANT_UI,
        ui.error ? `страница не отдалась: ${ui.error}`
            : `код ${ui.status}, ${Math.round(html.length / 1024)} КБ;`
            + ` lgReceiverState ${/function lgReceiverState\(/.test(html) ? 'есть' : 'НЕТ'},`
            + ` ветки: не настроен ${/приёмник не настроен/.test(html) ? '+' : '−'},`
            + ` обмена не было ${/ещё не было/.test(html) ? '+' : '−'},`
            + ` обмен падает ${/обмен падает/.test(html) ? '+' : '−'}`);

    // ── 17. код на диске: что поедет следующим рестартом ─────────────────────
    // Единственная проверка ФАЙЛА, и она здесь не для красоты: пин живёт ровно
    // на этих двух опциях агента, а падение приходит с задержкой в один тик —
    // потерять их правкой легко, а заметить трудно.
    const agentSrc = (PROXY_SRC.match(/const LEAGUE_AGENT[\s\S]{0,200}?\);/) || [''])[0];
    const noKeep = /keepAlive:\s*false/.test(agentSrc);
    const noCache = /maxCachedSessions:\s*0/.test(agentSrc);
    tell(vd(noKeep && noCache), 'код на диске: агент лиги без переиспользования TLS-сессий',
        'в LEAGUE_AGENT одновременно keepAlive: false и maxCachedSessions: 0',
        agentSrc
            ? `keepAlive:false ${noKeep ? '+' : '−'}, maxCachedSessions:0 ${noCache ? '+' : '−'}`
            + (noKeep && noCache ? '' : ' — на возобновлённой сессии сертификата не будет и пин порвётся')
            : 'объявление LEAGUE_AGENT в transparent-proxy.js не найдено');

    // ── итог ─────────────────────────────────────────────────────────────────
    console.log(`\nитог: ${nOk} прошло, ${nBad} упало, ${nSkip} пропущено (всего ${num})`);
    if (nBad) {
        console.log('\nкрасное про сборку/модули = процесс поднят на старом коде. Перезапуск'
            + ' дашборда рвёт front-door :20100 и живые сессии Claude Code, поэтому его делает'
            + ' ВЛАДЕЛЕЦ (routing/restart-dashboard.bat). После рестарта прогнать этот же скрипт'
            + ' ещё раз — красное обязано позеленеть.');
    }
    process.exit(nBad ? 1 : 0);
}

main().catch((e) => {
    console.error(`\ncheck-after-restart упал: ${safe(e && e.message || e)}`);
    process.exit(1);
});
