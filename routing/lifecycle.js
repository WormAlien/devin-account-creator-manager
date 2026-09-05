'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  lifecycle.js — единственная реализация «поднять / погасить / посмотреть».
//
//  Зачем этот файл вообще появился (2026-08-24). Список портов жил в ПЯТИ копиях
//  и разъехался: restart-dashboard.bat знал 8 портов, restart-dashboard.sh и
//  stop-dashboard.sh — 10, START.bat — 2, fix.sh — 2. Каждую копию правили
//  отдельно, поэтому «перезапустил, а не помогло» означало разное в зависимости
//  от того, чем именно перезапускал. Здесь таблица одна, и её читают все.
//
//  Зовут отсюда: hub.js (TUI и CLI), тонкие форвардеры .bat/.command/.sh и
//  кнопка перезапуска в UI дашборда.
//
//  Платформы: win32 (netstat + taskkill) и darwin/linux (lsof + kill). Развилка
//  ровно в двух функциях — listeners() и killPid(); всё остальное общее.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROUTING = __dirname;
const ROOT = path.join(__dirname, '..');
const IS_WIN = process.platform === 'win32';

// ── Логи: по файлу на сервис ─────────────────────────────────────────────────
// Раньше все писали в один routing/dashboard.out.log, и это выяснилось как
// неработающее ровно в момент проверки: cmd-редирект `>>` НЕ МОЖЕТ открыть файл,
// который уже держат пять живых процессов стека, — cmd молча выходит, node не
// стартует, порт не занимается. Замерено 24.08: тот же код с тем же кавычками на
// свежий файл поднимается, на dashboard.out.log — нет.
//
// По файлу на сервис снимает конкуренцию и заодно отвечает на «кто именно упал»:
// хвост показывается из лога того сервиса, который не поднялся, а не из общей мешанины.
const LOG_DIR = path.join(ROOT, 'logs', 'hub');
const LOG_MAX = 5 * 1024 * 1024;          // больше — крутим в .1, иначе файл растёт вечно

function serviceLog(svc) {
    return path.join(LOG_DIR, path.basename(String(svc.script || 'service'), '.js') + '.log');
}

// ── Порт front-door ──────────────────────────────────────────────────────────
// Он НЕ константа: настраивается в routing/frontdoor.json, и дашборд читает
// оттуда же (transparent-proxy.js § frontdoorConfig). Хардкод 20100 здесь дал бы
// самый неприятный класс ошибки — «остановил, а порт всё ещё слушает», потому что
// гасили не тот номер. Значение по умолчанию совпадает с дашбордом намеренно.
const FD_DEFAULT_PORT = 20100;

function frontdoorPort() {
    try {
        const raw = fs.readFileSync(path.join(ROUTING, 'frontdoor.json'), 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        return Number(doc.port) || FD_DEFAULT_PORT;
    } catch {
        return FD_DEFAULT_PORT;                       // нет файла — режим выключен
    }
}

// ── Какой бэкенд выбран прямо сейчас ────────────────────────────────────────
// Нужно, чтобы не поднимать конвертеры провайдеров, которыми не пользуются (см. ниже).
// Источник правды тот же, что у дашборда (transparent-proxy.js § activeBackendPort):
// `~/.claude/settings.json` → ANTHROPIC_BASE_URL; если он смотрит в front-door, то
// настоящий адрес лежит в `~/.claude/active-backend.json`, потому что в settings всегда
// один и тот же `:20100`.
// 🪤 Читаем, а не спрашиваем дашборд по HTTP: на старте его ещё нет.
function activeUpstreamPort() {
    const read = (p) => {
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    };
    const home = os.homedir();
    let base = '';
    try { base = String((read(path.join(home, '.claude', 'settings.json')).env || {}).ANTHROPIC_BASE_URL || ''); } catch { return 0; }
    let target = base;
    const fdPort = frontdoorPort();
    if (new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${fdPort}(/|$)`).test(base)) {
        try { target = String(read(path.join(home, '.claude', 'active-backend.json')).upstream || ''); } catch { return 0; }
    }
    const m = target.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/);
    return m ? Number(m[1]) : 0;
}

// ── Что хаб поднимает своими руками, в этом порядке ──────────────────────────
// Дашборд идёт последним: он на boot спавнит своих детей (front-door, конвертер
// AR, keepalive активного бэкенда) и снимает лежалых с прошлого запуска, поэтому
// к его старту порты уже должны быть свободны.
//
// 🪤 `provider` — конвертер Anthropic→OpenAI одного конкретного бэкенда. Такие
// поднимаются ТОЛЬКО если этот бэкенд выбран последним (решение владельца 05.09:
// «дашборд, вотчдог, фронтдор, а прокси по последнему выбранному провайдеру»).
// Раньше все три стартовали всегда — три процесса node по ~45 МБ и лишние секунды
// на старте ради панелей, в которые никто не заходит. Девять шлюзовых keepalive
// живут по этому правилу с самого начала (см. children(), respawn: false), а эти
// три его не получили: они старше keepalive-механики и остались в списке с мая.
// В `stop()` и `status()` список по-прежнему ПОЛНЫЙ — иначе «остановил» означало бы
// живой процесс на порту, а «статус» врал бы про него молчанием.
const SERVICES = [
    { port: 20126, name: 'FM-ротатор', script: 'freemodel-rotator.js', provider: 'freemodel_rotator' },
    { port: 20130, name: 'FM-OpenAI', script: 'freemodel-openai-proxy.js', provider: 'fm_openai' },
    { port: 20131, name: 'VyceAI', script: 'vyceai-openai-proxy.js', provider: 'vyce_openai' },
    { port: 8200, name: 'Дашборд', script: 'transparent-proxy.js', ready: '/__switch/api/status' },
    // Вотчдог пулов: следит, не отдаёт ли активный шлюз «all nodes exhausted», и
    // ГРОМКО сообщает (лог + pool-alert.json), сам НЕ переключает. Стоит после
    // дашборда: без активного бэкенда ему нечего мерить. Разбор — pool-watchdog.js.
    { port: 20134, name: 'Вотчдог пулов', script: 'pool-watchdog.js', ready: '/__watchdog/api/status' },
];


// ── Дети дашборда: хаб их НЕ поднимает никогда ───────────────────────────────
// Разница между «перезапустить» и «остановить» живёт ровно здесь, и она не
// косметическая (см. transparent-proxy.js § bootSpawnActiveBackend / § bootSweepStaleChildren):
//
//   respawn: true  — дашборд поднимает их обратно сам на boot. Погасить обязаны:
//                    иначе после обновления они доживают на СТАРОМ коде, и снаружи
//                    это выглядит как «перезагрузил, а не перезагрузилось» (21.08).
//   respawn: false — keepalive неактивных провайдеров. На boot дашборд их только
//                    СНИМАЕТ, обратно поднимает активация провайдера. Значит при
//                    рестарте трогать их нельзя (отобрали бы канал у активного
//                    бэкенда до следующей активации), а при остановке — обязаны:
//                    после остановки дашборда снять их не сможет уже никто, и
//                    «остановил» означало бы четыре живых прокси на портах.
function children() {
    return [
        { port: frontdoorPort(), name: 'Front Door', respawn: true },
        { port: 20132, name: 'AR-конвертер', respawn: true },
        { port: 20133, name: 'AgentRouter keepalive', respawn: true },
        { port: 20155, name: 'Tabi keepalive', respawn: false },
        { port: 20156, name: 'GoRouter keepalive', respawn: false },
        { port: 20157, name: 'XPeach keepalive', respawn: false },
        { port: 20158, name: 'JustWoker keepalive', respawn: false },
        { port: 20159, name: 'SeekAi keepalive', respawn: false },
        { port: 20160, name: 'TrueSOTA keepalive', respawn: false },
        { port: 20161, name: 'KKtoken keepalive', respawn: false },
        { port: 20162, name: 'HCNsec keepalive', respawn: false },
        { port: 8300, name: 'Дашборд (легаси)', respawn: false },
    ];
}

// Конвертеры Custom-провайдеров сидят на портах из routing/custom-providers.json
// (диапазон 20150–20250), то есть их номера НЕЛЬЗЯ знать заранее. Старые bat/sh их
// не гасили вовсе: «остановил дашборд» оставляло висеть по прокси на каждого
// добавленного провайдера. Читаем файл, а не сканируем диапазон.
function customPorts() {
    try {
        const raw = fs.readFileSync(path.join(ROUTING, 'custom-providers.json'), 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        return (doc.providers || [])
            .map(p => ({ port: Number(p.proxyPort), name: `конвертер ${p.name || p.id || '?'}`, respawn: false }))
            .filter(p => p.port > 0);
    } catch {
        return [];
    }
}

// Кого гасить в каждой из двух операций. Порядок: сначала дашборд, потом его дети —
// живой дашборд успел бы заметить пропажу ребёнка и поднять его обратно.
function killPlan(phase) {
    const kids = [...children(), ...customPorts()];
    const list = [...SERVICES].reverse().map(s => ({ port: s.port, name: s.name }));
    for (const k of kids) {
        if (phase === 'stop' || k.respawn) list.push({ port: k.port, name: k.name });
    }
    const seen = new Set();
    return list.filter(x => (seen.has(x.port) ? false : seen.add(x.port)));
}

// ── Кто слушает: ОДИН снимок на все порты ────────────────────────────────────
// Раньше на каждый порт звался свой netstat|findstr, и на 12 портах это секунды
// подряд — при этом снимок ещё и разъезжался во времени. Здесь один вызов даёт
// карту порт → PID'ы, из неё же рисуется и статус, и план убийства.
//
// 🪤 Порт берём после ПОСЛЕДНЕГО двоеточия: у IPv6 адрес выглядит как `[::]:8200`,
// и наивный split(':')[1] дал бы пустую строку. И сравнивать надо числами —
// строчный `:8200` совпал бы с `:82000`, ровно поэтому в старых батниках стоял
// findstr с пробелом на конце.
function listeners() {
    const map = new Map();
    const add = (port, pid) => {
        if (!port || !pid) return;
        if (!map.has(port)) map.set(port, new Set());
        map.get(port).add(pid);
    };

    if (IS_WIN) {
        const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
        for (const line of String(r.stdout || '').split(/\r?\n/)) {
            const t = line.trim().split(/\s+/);
            if (t.length < 5 || t[0].toUpperCase() !== 'TCP') continue;
            // 🪤 По слову LISTENING фильтровать нельзя как по единственному признаку:
            // на части локалей Windows netstat переводит и состояния (заголовки
            // таблицы переведены уже на этой машине). Языконезависимая примета слушателя
            // — внешний адрес с портом 0 (`0.0.0.0:0`, `[::]:0`): у ESTABLISHED и
            // TIME_WAIT там настоящий порт собеседника.
            const listening = t[3] === 'LISTENING' || /:0$/.test(t[2]);
            if (!listening) continue;
            add(Number(t[1].slice(t[1].lastIndexOf(':') + 1)), Number(t[4]));
        }
        return map;
    }

    // -F pn — машинный формат: строка `p<pid>`, затем по строке `n<адрес>` на каждый
    // сокет этого процесса. Разбирать колонки обычного вывода нельзя: у COMMAND с
    // пробелом в имени их становится больше, и NAME съезжает.
    const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8' });
    if (r.status === 0 || r.stdout) {
        let pid = 0;
        for (const line of String(r.stdout || '').split('\n')) {
            if (line[0] === 'p') pid = Number(line.slice(1));
            else if (line[0] === 'n') add(Number(line.slice(line.lastIndexOf(':') + 1)), pid);
        }
        return map;
    }

    // Голый Linux без lsof (на маке он есть всегда). `ss -ltnpH`: адрес в 4-й
    // колонке, pid в хвосте вида `users:(("node",pid=123,fd=20))`.
    const s = spawnSync('ss', ['-ltnpH'], { encoding: 'utf8' });
    for (const line of String(s.stdout || '').split('\n')) {
        const t = line.trim().split(/\s+/);
        if (t.length < 4) continue;
        const port = Number(t[3].slice(t[3].lastIndexOf(':') + 1));
        for (const m of line.matchAll(/pid=(\d+)/g)) add(port, Number(m[1]));
    }
    return map;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Права: считаем один раз ──────────────────────────────────────────────────
// Нужны не для того, чтобы их требовать (хаб намеренно работает без них), а чтобы
// СРАЗУ сказать, в каком режиме он живёт. Элевированный хаб — не благо, а причина
// будущих проблем: его дети тоже становятся элевированными, и следующий обычный
// запуск их уже не убьёт.
//
// `net session` стоит ~130 мс, поэтому результат кешируется на процесс: за время
// одного запуска права не меняются. Проверки без запуска процесса пробовал —
// открытие `\\.\PHYSICALDRIVE0` в node даёт ENOENT и под админом, и без, то есть
// не различает ничего.
let _elevated = null;

function isElevated() {
    if (_elevated !== null) return _elevated;
    if (!IS_WIN) {
        _elevated = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
        return _elevated;
    }
    const r = spawnSync('net', ['session'], { windowsHide: true, encoding: 'utf8' });
    _elevated = r.status === 0;
    return _elevated;
}

// Жив ли процесс. Сигнал 0 ничего не посылает, только проверяет доступ:
//   ESRCH — процесса нет;
//   EPERM — процесс ЕСТЬ, но открыть его нам не дали (то есть жив и чужой).
function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Имя исполняемого файла по PID. Нужно ровно для одного вопроса: занятый порт — это
// НАШ процесс или чужой? Раньше start() в обоих случаях говорил «уже поднят, не
// трогаю», и посторонняя программа на :8200 выглядела как успешно поднятый дашборд.
// Имя образа не переводится ни на одной локали, в отличие от текста вокруг него.
function pidImage(pid) {
    try {
        if (IS_WIN) {
            const r = spawnSync('tasklist', ['/fi', `pid eq ${pid}`, '/fo', 'csv', '/nh'],
                { encoding: 'utf8', windowsHide: true });
            const m = String(r.stdout || '').match(/^"([^"]+)"/);
            return m ? m[1] : '';
        }
        const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
        return String(r.stdout || '').trim();
    } catch {
        return '';
    }
}

const isOurs = pid => /^node(\.exe)?$/i.test(pidImage(pid));

// Убить один PID. Возвращает 'ok' | 'denied' | 'gone'.
//
// 🪤 Текст taskkill'а разбирать НЕЛЬЗЯ, и на этом мы уже стояли: он печатает в
// OEM-кодировке (cp866 на русской Windows), а node декодирует как utf8 — «Отказано
// в доступе» превращается в мусор, регулярка не совпадает, и отказ проходил как
// «процесс уже умер». Дальше killPort честно ждал 8 секунд таймаута на каждый порт;
// на плане из 14 портов это две минуты тишины вместо мгновенного ответа.
// Код возврата тоже не годится: у taskkill и «нет такого процесса», и «нет прав» —
// это 1. Поэтому спрашиваем результат у системы: процесс ещё жив?
async function killPid(pid, hard) {
    if (!pidAlive(pid)) return 'gone';

    if (IS_WIN) {
        spawnSync('taskkill', hard ? ['/F', '/PID', String(pid)] : ['/PID', String(pid)],
            { windowsHide: true });
    } else {
        try {
            process.kill(pid, hard ? 'SIGKILL' : 'SIGTERM');
        } catch (e) {
            if (e.code === 'EPERM') return 'denied';
            return 'gone';
        }
    }

    // Умирают не мгновенно: даём 300 мс на исчезновение, прежде чем звать это отказом.
    // Вежливому сигналу на POSIX этого мало намеренно — там ждёт сам killPort.
    for (let i = 0; i < 6; i++) {
        if (!pidAlive(pid)) return 'ok';
        await sleep(50);
    }
    return IS_WIN || hard ? 'denied' : 'ok';
}

// Освободить порт и ДОЖДАТЬСЯ, пока ОС его реально отпустит.
//
// 🪤 Проверка после kill обязательна и является источником правды. Убитый процесс
// умирает не мгновенно, а сокет отпускается ещё позже; без ожидания следующий старт
// падал с EADDRINUSE, и человек видел «порт занят» сразу после «порт освобождён».
// Ровно поэтому в старом бате был цикл :KP_WAITFREE — он здесь сохранён, вместе с
// его же ограничением в ~8 секунд.
async function killPort(port, { timeoutMs = 8000 } = {}) {
    let pids = [...(listeners().get(port) || [])];
    if (!pids.length) return { port, was: [], freed: true, denied: false };

    const was = pids.slice();
    let denied = false;

    // 🪤 Ждать после отказа в правах — чистая потеря времени, и на 12 портах это
    // складывалось в полторы минуты «он что-то долго думает» вместо мгновенного
    // ответа (владелец, 25.08). Отказ не рассосётся сам: процесс элевированный, а мы
    // нет. Поэтому решение принимается по РЕЗУЛЬТАТУ убийства, а не по таймауту:
    // не смогли ни одного — выходим сразу.
    const round = async hard => {
        let killed = 0;
        for (const pid of pids) {
            const r = await killPid(pid, hard);
            if (r === 'denied') denied = true; else killed++;
        }
        return killed;
    };

    // На Windows taskkill без /F для node бесполезен, так что сразу /F; на POSIX
    // сначала SIGTERM — дашборд успевает закрыть сокеты и снять своих детей.
    if (await round(IS_WIN) === 0) return { port, was, freed: false, denied, holding: pids, fast: true };

    const deadline = Date.now() + timeoutMs;
    let hardened = IS_WIN;
    while (Date.now() < deadline) {
        await sleep(250);
        pids = [...(listeners().get(port) || [])];
        if (!pids.length) return { port, was, freed: true, denied };
        if (!hardened && Date.now() > deadline - timeoutMs + 1000) {
            hardened = true;
            if (await round(true) === 0) return { port, was, freed: false, denied, holding: pids, fast: true };
        }
    }
    return { port, was, freed: false, denied, holding: pids };
}

// ── Окружение для детей ──────────────────────────────────────────────────────
// На маке дашборд и его дети зовут внутри себя netstat/taskkill/python — виндовые
// имена, которых там нет. Подмена сделана шимами в mac-support/shims, и они должны
// стоять в PATH РЕБЁНКА. Своему процессу мы PATH не портим намеренно: lifecycle
// ищет реальный lsof, а шим `netstat` из этой же папки его бы подменил.
function childEnv() {
    const env = { ...process.env };
    if (!IS_WIN) {
        const shims = path.join(ROOT, 'mac-support', 'shims');
        if (fs.existsSync(shims)) env.PATH = shims + path.delimiter + (env.PATH || '');
        if (fs.existsSync('/usr/bin/sqlite3')) env.SQLITE3 = '/usr/bin/sqlite3';
    }
    return env;
}

// ── Подготовка платформы перед стартом ───────────────────────────────────────
// Указатель на корень репо для шима статус-лайна: settings.json показывает на
// ~/.claude/autoreger-statusline.sh, а тот читает путь отсюда. Благодаря этому
// перенос или переименование папки проекта не ломает статус-бар — достаточно
// запустить дашборд из нового места.
//
// 🪤 Слэши прямые даже на Windows: шим — bash-скрипт, и путь с обратными слэшами
// он бы съел как escape-последовательности. Старый bat делал то же самое через
// `%REPO_ROOT:\=/%`, формат файла обязан совпадать.
function preparePlatform() {
    const notes = [];
    try {
        const dir = path.join(os.homedir(), '.claude');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'autoreger-root.txt'), ROOT.replace(/\\/g, '/') + '\n', 'utf8');
        const shim = path.join(ROUTING, 'statusline-shim.sh');
        if (fs.existsSync(shim)) {
            const dst = path.join(dir, 'autoreger-statusline.sh');
            fs.copyFileSync(shim, dst);
            if (!IS_WIN) fs.chmodSync(dst, 0o755);
        }
    } catch (e) {
        notes.push(`указатель статус-лайна не обновлён: ${e.message}`);
    }

    // Exec-бит: в индексе git он есть (100755), но старые копии репо приехали как
    // 100644, а `core.fileMode false` (без него chmod ломает git pull) заставляет git
    // об этой разнице молчать. Восстанавливаем сами — иначе двойной клик по
    // .command падает с «нет прав доступа», а node не может позвать шимы.
    if (!IS_WIN) {
        const pats = [path.join(ROOT, 'mac-support', 'shims'), ROUTING, ROOT];
        for (const dir of pats) {
            let names = [];
            try { names = fs.readdirSync(dir); } catch { continue; }
            for (const n of names) {
                if (dir === ROUTING && !n.endsWith('.sh')) continue;
                if (dir === ROOT && !/\.(sh|command)$/.test(n)) continue;
                try { fs.chmodSync(path.join(dir, n), 0o755); } catch { /* не наш файл */ }
            }
        }
    }
    return notes;
}

// ── Лог ──────────────────────────────────────────────────────────────────────
// Своё окно у процессов больше не появляется (решение владельца 24.08), поэтому
// файл — единственное место, где видно причину падения: хаб показывает его хвост,
// если старт не удался.
function rotateLog(svc) {
    const f = serviceLog(svc);
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        if (fs.statSync(f).size > LOG_MAX) fs.renameSync(f, f + '.1');
    } catch { /* нет файла — первый запуск */ }
    return f;
}

function logTail(svc, lines = 25) {
    try {
        return fs.readFileSync(serviceLog(svc), 'utf8').split(/\r?\n/).slice(-lines).join('\n');
    } catch {
        return '(лог пуст — процесс не дожил до первой строки)';
    }
}

// ── Старт одного сервиса ─────────────────────────────────────────────────────
// Нужны ОДНОВРЕМЕННО три свойства, и на Windows их не даёт ни один флаг `spawn`:
//   1. окна нет;
//   2. процесс переживает выход хаба;
//   3. у процесса ЕСТЬ консоль — чтобы его собственные вызовы консольных программ
//      её наследовали, а не заводили себе новую (с окном).
//
// 🪤 Третье требование пропущено 24.08, и это вышло наружу мгновенно: хаб поднимал
// сервисы с `detached: true`, а на Windows это DETACHED_PROCESS — консоли нет ВООБЩЕ.
// Дашборд внутри себя зовёт `netstat`, `taskkill`, `git`, `sqlite3` и `powershell`
// синхронно и без `windowsHide` (47 мест, часть в циклах по портам). Пока он жил в
// видимом окне от `start /MIN`, они молча наследовали его консоль. Без консоли
// Windows обязана выдать каждому такому вызову НОВУЮ — с окном. Снаружи это
// «нажимаю рестарт, и начинается лютый спам окон» (владелец, 24.08).
//
// Замерено на подставных портах, все три свойства сразу:
//   detached: true                  — окон нет, переживает; консоли НЕТ  → внуки мигают
//   windowsHide: true без detached  — окно нет, консоль ЕСТЬ; УМИРАЕТ вместе с родителем
//   Start-Process -WindowStyle Hidden — всё три. Им же поднимал прокси старый bat.
// Комбинировать флаги нельзя: MSDN запрещает DETACHED_PROCESS вместе с
// CREATE_NO_WINDOW, а node передаёт оба — и выигрывает detached.
//
// cmd-обёртка нужна ради ОДНОГО лога: у `Start-Process` есть -RedirectStandardOutput,
// но два сервиса не могут писать в один файл (sharing violation), а `>>` из cmd
// дописывают конкурентно нормально. Кавычки проверены на путях с пробелами —
// сам node лежит в `C:\Program Files\nodejs`.
function startService(svc) {
    const script = path.resolve(ROUTING, svc.script);
    const log = rotateLog(svc);
    if (IS_WIN) {
        const q = s => `'${String(s).replace(/'/g, "''")}'`;
        const inner = `""${process.execPath}" "${script}" >> "${log}" 2>&1"`;
        const ps = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',${q(inner)} `
            + `-WorkingDirectory ${q(ROUTING)} -WindowStyle Hidden -PassThru; $p.Id`;
        const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
            { encoding: 'utf8', windowsHide: true });
        if (r.status !== 0) throw new Error(`Start-Process не смог поднять ${svc.script}: ${String(r.stderr || '').trim().slice(0, 200)}`);
        return Number(String(r.stdout).trim()) || 0;   // pid обёртки; настоящий узнаём по порту
    }

    // POSIX: detached (setsid) — своя группа процессов, закрытие терминала не
    // рассылает ей SIGHUP. Консоль в этом смысле проблемой не является.
    const out = fs.openSync(log, 'a');
    try {
        const child = spawn(process.execPath, [script], {
            cwd: ROUTING,
            detached: true,
            stdio: ['ignore', out, out],
            env: childEnv(),
        });
        child.unref();
        return child.pid;
    } finally {
        fs.closeSync(out);            // handle уже унаследован ребёнком, свой закрываем
    }
}

// Готовность дашборда — по его же ручке статуса, а не по факту «порт слушает»:
// порт открывается раньше, чем сервер готов отвечать.
async function waitReady(port, urlPath, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise(resolve => {
            const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 1500 },
                res => { res.resume(); resolve(res.statusCode > 0); });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
        if (ok) return true;
        await sleep(400);
    }
    return false;
}

// ── Статус ───────────────────────────────────────────────────────────────────
// Один снимок netstat/lsof на весь список. role различает, кто чей: 'service' мы
// поднимаем сами, 'child' поднимает дашборд, и лежащий child далеко не всегда
// поломка (keepalive неактивного провайдера лежит штатно).
function status() {
    const map = listeners();
    const activePort = activeUpstreamPort();
    const row = (x, role) => {
        const pids = [...(map.get(x.port) || [])];
        return {
            port: x.port, name: x.name, role, up: pids.length > 0, pids, respawn: !!x.respawn,
            // provider → сервис поднимается по выбору бэкенда. `expected` отвечает на
            // вопрос «должен ли он сейчас быть живым»: без него счётчик хаба показывал бы
            // жёлтое «2/5» на штатном состоянии и читался как недозапуск.
            provider: x.provider || undefined,
            expected: x.provider ? x.port === activePort : true,
        };
    };
    return [
        ...SERVICES.map(s => row(s, 'service')),
        ...children().map(c => row(c, 'child')),
        ...customPorts().map(c => row(c, 'child')),
    ];
}

// ── Остановить ───────────────────────────────────────────────────────────────
// phase: 'stop' — всё, включая keepalive неактивных провайдеров и конвертеры
// Custom (их не снимет уже никто). 'restart' — только то, что дашборд поднимет
// обратно сам; см. комментарий у children().
async function stop({ phase = 'stop', on = () => {} } = {}) {
    const plan = killPlan(phase);
    const results = [];
    for (const item of plan) {
        on({ type: 'kill-begin', ...item });
        const r = await killPort(item.port);
        results.push({ ...item, ...r });
        on({ type: 'kill-done', ...item, ...r });

        // Отказ в правах на рестарте прекращает работу немедленно: поднимать мы всё
        // равно не будем (start откажется на занятом порту), а гасить остальные —
        // значит уронить больше и всё равно не собрать. При stop продолжаем: цель
        // «освободить что можно», и погашенный keepalive лучше живого.
        if (r.denied && phase === 'restart') {
            on({ type: 'abort', ...item, ...r });
            break;
        }
    }
    const stuck = results.filter(r => !r.freed);
    return { results, stuck, denied: results.some(r => r.denied), elevated: isElevated() };
}

// ── Запустить ────────────────────────────────────────────────────────────────
// Идемпотентно: поднимается только то, что лежит. Это не мелочь — Claude Code
// ходит через front-door, который спавнит дашборд, поэтому «на всякий случай
// перезапустить» рвёт живую сессию агента. Хочешь именно рестарт — зови restart().
async function start({ on = () => {} } = {}) {
    for (const note of preparePlatform()) on({ type: 'note', text: note });

    const map = listeners();
    const started = [];
    const foreign = [];
    // Конвертер провайдера поднимаем только если этот провайдер выбран последним.
    const activePort = activeUpstreamPort();
    for (const svc of SERVICES) {
        if (svc.provider && svc.port !== activePort) {
            on({ type: 'start-lazy', ...svc });
            continue;
        }
        const holders = [...(map.get(svc.port) || [])];
        if (holders.length) {
            // Порт занят — но нами ли? Посторонняя программа на :8200 раньше читалась
            // как «дашборд уже поднят», и человек шёл искать, почему UI не отвечает.
            const alien = holders.filter(p => !isOurs(p));
            if (alien.length) {
                const who = alien.map(p => `${pidImage(p) || '?'} (pid ${p})`).join(', ');
                foreign.push({ ...svc, who });
                on({ type: 'start-foreign', ...svc, who });
            } else {
                on({ type: 'start-skip', ...svc });
            }
            continue;
        }
        on({ type: 'start-begin', ...svc });
        let pid = 0;
        try {
            pid = startService(svc);
        } catch (e) {
            on({ type: 'error', ...svc, text: e.message });
            return { ok: false, started, failed: svc, tail: logTail(svc), log: serviceLog(svc) };
        }

        // Ждём, пока порт реально займётся: старт «успешен» ровно тогда, когда
        // следующий сервис не упрётся в него, а node мог умереть на первой строке.
        let realPid = 0;
        for (let i = 0; i < 24 && !realPid; i++) {
            await sleep(250);
            realPid = [...(listeners().get(svc.port) || [])][0] || 0;
        }
        if (!realPid) {
            on({ type: 'error', ...svc, text: `порт :${svc.port} не занялся` });
            return { ok: false, started, failed: svc, tail: logTail(svc), log: serviceLog(svc) };
        }
        // PID берём с порта, а не из spawn: на Windows startService возвращает pid
        // cmd-обёртки, а человеку и `taskkill` нужен тот процесс, что реально слушает.
        pid = realPid;
        started.push({ ...svc, pid });

        if (svc.ready && !(await waitReady(svc.port, svc.ready))) {
            on({ type: 'error', ...svc, text: 'порт занят, но статус не отвечает' });
            return { ok: false, started, failed: svc, tail: logTail(svc), log: serviceLog(svc) };
        }
        on({ type: 'start-done', ...svc, pid });
    }
    return { ok: foreign.length === 0, started, foreign, url: 'http://localhost:8200/__switch' };
}

// Порядок «сначала погасить нужное, потом поднять» держится ЗДЕСЬ, а не в хабе:
// иначе он снова окажется в двух местах — ровно то, из-за чего затевался этот файл.
// Хаб добавляет к результату только текст.
async function restart({ on = () => {} } = {}) {
    const s = await stop({ phase: 'restart', on });
    if (s.stuck.length) return { ok: false, stage: 'stop', ...s };
    return { ...(await start({ on })), stage: 'start' };
}

// ── Поднять конвертер провайдера по требованию ───────────────────────────────
// Обратная сторона ленивого старта: раз на boot их больше не поднимают, кто-то обязан
// поднять при выборе провайдера. Зовёт дашборд из applyTarget ДО того, как обратится к
// порту (у freemodel_rotator он сразу спрашивает активный ключ у :20126, и на пустом
// порту переключение молча получало бы пустой ключ).
//
// Идемпотентно: порт уже слушает — ничего не делаем. Ждём именно ЗАНЯТИЯ ПОРТА, а не
// факта spawn: node мог умереть на первой строке, и «поднял» тогда означало бы неправду.
// → { ok, port, pid, already?, error? }
async function ensureProviderService(port) {
    const svc = SERVICES.find(s => s.provider && s.port === Number(port));
    if (!svc) return { ok: false, port: Number(port), error: 'это не конвертер провайдера' };
    const live = [...(listeners().get(svc.port) || [])];
    if (live.length) return { ok: true, port: svc.port, pid: live[0], already: true };
    try { startService(svc); } catch (e) { return { ok: false, port: svc.port, error: e.message }; }
    for (let i = 0; i < 24; i++) {
        await sleep(250);
        const pid = [...(listeners().get(svc.port) || [])][0];
        if (pid) return { ok: true, port: svc.port, pid, name: svc.name };
    }
    return { ok: false, port: svc.port, error: `порт :${svc.port} не занялся`, tail: logTail(svc) };
}

module.exports = {
    ROOT, ROUTING, IS_WIN, LOG_DIR, serviceLog, isElevated,
    SERVICES, children, customPorts, killPlan, frontdoorPort,
    listeners, killPort, killPid, status, start, stop, restart,
    preparePlatform, childEnv, waitReady, logTail, sleep, startService,
    pidAlive, pidImage, isOurs, activeUpstreamPort, ensureProviderService,
};
