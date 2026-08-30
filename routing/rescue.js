// rescue.js — «всё сломалось, агента нет»: диагноз и откат состояния роутинга.
//
// ЗАЧЕМ. Когда конфиг разъезжается, Claude Code перестаёт отвечать — а починить его
// нужно именно тем инструментом, который лежит. Замок: чтобы позвать агента, нужен
// рабочий шлюз; чтобы шлюз стал рабочим, нужен агент. Этот скрипт разрывает замок:
// чистый Node без зависимостей, работает при мёртвом дашборде и мёртвом CLI.
//
// ПОЧЕМУ NODE, А НЕ .BAT/.PS1. У .bat консоль в cp866 (кириллица в мусор), у .ps1
// без BOM PowerShell 5.1 читает файл как ANSI и падает на случайной строке. Node уже
// нужен всему стеку, у него ни одной из этих ловушек. Двойной клик — RESCUE.bat,
// который включает UTF-8 и зовёт этот файл.
//
// КОМАНДЫ
//   node routing/rescue.js doctor          что живо, что врёт (только чтение)
//   node routing/rescue.js save [метка]    снимок состояния
//   node routing/rescue.js list            какие снимки есть
//   node routing/rescue.js good            пометить ТЕКУЩЕЕ состояние эталоном
//   node routing/rescue.js restore good    вернуть эталон
//   node routing/rescue.js restore last    вернуть последний снимок
//   node routing/rescue.js restore <метка>
//
// ЧЕГО НЕ ДЕЛАЕТ НАМЕРЕННО
//   • Не убивает и не поднимает процессы. Порты трогает только чтением. Рестарт —
//     `HUB.bat` / `node hub.js restart`, и он рвёт живые сессии Claude Code, поэтому
//     решение остаётся за человеком.
//   • Не восстанавливает пулы аккаунтов (`*-sessions.json`). Это данные, а не конфиг:
//     откат вернул бы отозванные ключи и пустые балансы как «рабочее состояние».
//   • Не трогает код в git. Если разошёлся код, доктор это скажет, а лечится оно
//     `git checkout -- routing/` — не дублируем git своими копиями.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');

const ROUTING = __dirname;
const CLAUDE = path.join(os.homedir(), '.claude');
const SNAP_DIR = path.join(ROUTING, '.rescue');
const GOOD = 'GOOD';                       // метка эталона — отдельным каталогом

// Что считаем состоянием. Пути относительные, база — либо routing/, либо ~/.claude.
// Глобы разворачиваем сами: имена файлов ключей заводятся вместе с провайдером, и
// перечисление рано или поздно разойдётся с реальностью (та же грабля, что у
// git-pull-safe.js — см. Debug Reference § забытая тир-карта).
const SETS = [
    { base: ROUTING, glob: /^[A-Za-z0-9_-]+-modelmap\.json$/ },
    { base: ROUTING, names: ['frontdoor.json', 'custom-providers.json', 'fm-openai-config.json'] },
    { base: CLAUDE, names: ['settings.json', 'active-backend.json'] },
    { base: CLAUDE, glob: /^[A-Za-z0-9_-]+-active-(key\.txt|model\.txt|tiers\.json)$/ },
];

// Код денежного пути. Снимаем ради «вернуть как было за секунду», но доктор
// сверяет его с git — источник правды для кода там, а не здесь.
const CODE = [
    'frontdoor-proxy.js', 'keepalive-proxy.js', 'transparent-proxy.js',
    'custom-openai-proxy.js', 'pool-watchdog.js', 'lifecycle.js',
];

// ── Вывод. Кириллица тут безопасна: RESCUE.bat включает UTF-8, git-bash и так в нём.
const C = { red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', dim: '\x1b[90m', off: '\x1b[0m' };
const say = (s) => process.stdout.write(s + '\n');
const ok = (s) => say(`  ${C.grn}OK${C.off}    ${s}`);
const warn = (s) => say(`  ${C.yel}ВНИМ${C.off}  ${s}`);
const bad = (s) => say(`  ${C.red}СЛОМ${C.off}  ${s}`);
const info = (s) => say(`  ${C.dim}·${C.off}     ${s}`);

// Список файлов состояния: {base, rel}. Каталога может не быть — это не ошибка.
function stateFiles() {
    const out = [];
    for (const s of SETS) {
        let names = s.names || [];
        if (s.glob) {
            try { names = fs.readdirSync(s.base).filter((n) => s.glob.test(n)); } catch { names = []; }
        }
        for (const n of names) {
            const p = path.join(s.base, n);
            if (fs.existsSync(p)) out.push({ base: s.base, rel: n, abs: p });
        }
    }
    for (const n of CODE) {
        const p = path.join(ROUTING, n);
        if (fs.existsSync(p)) out.push({ base: ROUTING, rel: n, abs: p, code: true });
    }
    return out;
}

// В снимке два подкаталога, чтобы восстановление знало, куда класть: routing/ и claude/.
const bucket = (base) => (base === CLAUDE ? 'claude' : 'routing');
const baseOf = (b) => (b === 'claude' ? CLAUDE : ROUTING);

function readJson(p) {
    try {
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch { return null; }
}

// Слушает ли кто-то порт. Строго IPv4: `localhost` на Windows резолвится в ::1
// первым, и connect в пустой IPv6-loopback отдаёт EACCES вместо ECONNREFUSED —
// «занято» и «не слушает» стали бы неразличимы (та же грабля, что в frontdoor-proxy).
function portUp(port, timeout = 700) {
    return new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
        s.setTimeout(timeout);
        s.on('connect', () => done(true));
        s.on('timeout', () => done(false));
        s.on('error', () => done(false));
    });
}

// Отвечает ли служба своим статусом. «Порт занят» и «служба работает» — разные
// вопросы: зомби-процесс держит порт и не отвечает, и по одному bind это неотличимо.
function statusOk(port, urlPath, timeout = 2500) {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: urlPath, timeout }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
            res.on('error', () => resolve(null));
        });
        req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: 'таймаут' }); });
        req.on('error', (e) => resolve({ code: 0, body: e.code || e.message }));
    });
}

// ── save / list / restore ─────────────────────────────────────────────────────
function cmdSave(label) {
    const stamp = label || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(SNAP_DIR, stamp);
    const files = stateFiles();
    if (!files.length) { bad('нечего снимать — ни одного файла состояния не найдено'); process.exit(1); }

    let n = 0;
    for (const f of files) {
        const to = path.join(dest, bucket(f.base), f.rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(f.abs, to);
        n += 1;
    }
    const meta = {
        v: 1, at: new Date().toISOString(), label: stamp,
        files: files.map((f) => `${bucket(f.base)}/${f.rel}`),
        activeBackend: readJson(path.join(CLAUDE, 'active-backend.json')),
    };
    fs.writeFileSync(path.join(dest, 'META.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    ok(`снимок «${stamp}»: ${n} файлов → routing/.rescue/${stamp}`);
    return stamp;
}

function cmdList() {
    let names = [];
    try { names = fs.readdirSync(SNAP_DIR).filter((n) => fs.existsSync(path.join(SNAP_DIR, n, 'META.json'))); } catch {}
    if (!names.length) { warn('снимков нет. Сделай эталон: node routing/rescue.js good'); return; }
    for (const n of names.sort()) {
        const m = readJson(path.join(SNAP_DIR, n, 'META.json')) || {};
        const b = m.activeBackend ? m.activeBackend.backend : '?';
        say(`  ${n === GOOD ? C.grn + 'ЭТАЛОН' + C.off : '      '} ${n.padEnd(22)} ${String(m.files ? m.files.length : 0).padStart(2)} файлов  бэкенд: ${b}`);
    }
}

function cmdRestore(which) {
    let label = which;
    if (label === 'good') label = GOOD;
    if (label === 'last') {
        const names = (() => { try { return fs.readdirSync(SNAP_DIR).filter((n) => n !== GOOD).sort(); } catch { return []; } })();
        label = names[names.length - 1];
        if (!label) { bad('обычных снимков нет (есть только эталон?) — попробуй restore good'); process.exit(1); }
    }
    const src = path.join(SNAP_DIR, label);
    if (!fs.existsSync(path.join(src, 'META.json'))) { bad(`нет снимка «${which}»`); cmdList(); process.exit(1); }

    // Перед откатом снимаем текущее: «откатился и понял, что зря» обязан иметь выход.
    // Стоит копейку, а спасает от необратимости, ради которой скрипт и написан.
    say('');
    info('сначала сохраняю текущее состояние…');
    cmdSave('before-restore-' + new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19));
    say('');

    let n = 0;
    for (const b of ['routing', 'claude']) {
        const dir = path.join(src, b);
        if (!fs.existsSync(dir)) continue;
        for (const rel of fs.readdirSync(dir)) {
            const to = path.join(baseOf(b), rel);
            fs.copyFileSync(path.join(dir, rel), to);
            n += 1;
        }
    }
    ok(`восстановлено из «${label}»: ${n} файлов`);
    const m = readJson(path.join(src, 'META.json')) || {};
    if (m.activeBackend) info(`бэкенд снимка: ${m.activeBackend.backend} → ${m.activeBackend.upstream}`);
    say('');
    warn('ПРОЦЕССЫ НЕ ТРОНУТЫ — это сделано намеренно.');
    info('Тир-карты и active-backend.json перечитываются НА ХОДУ (по mtime) — рестарт не нужен.');
    info('Если менялся код прокси — нужен рестарт: HUB.bat → «Перезапустить».');
    info('Рестарт гасит front-door :20100, то есть живые сессии Claude Code.');
}

function cmdGood() {
    const dest = path.join(SNAP_DIR, GOOD);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    cmdSave(GOOD);
    say('');
    info('Эталон = «состояние, в котором всё работало». Обновляй его ПОСЛЕ того, как');
    info('убедился, что стек жив, а не до. Вернуть: node routing/rescue.js restore good');
}

// ── doctor: отвечает на «почему не работает» без агента ────────────────────────
async function cmdDoctor() {
    say('');
    say('── 1. Куда смотрит Claude Code ───────────────────────────────');
    const st = readJson(path.join(CLAUDE, 'settings.json'));
    const baseUrl = st && st.env ? st.env.ANTHROPIC_BASE_URL : null;
    if (!st) bad('~/.claude/settings.json не читается (битый JSON?) — CLI не стартует');
    else if (!baseUrl) warn('в settings.json нет ANTHROPIC_BASE_URL — идём в официальный API');
    else ok(`ANTHROPIC_BASE_URL = ${baseUrl}`);
    if (st && st.env && st.env.ANTHROPIC_MODEL) info(`ANTHROPIC_MODEL = ${st.env.ANTHROPIC_MODEL}`);

    say('');
    say('── 2. Активный бэкенд ────────────────────────────────────────');
    const ab = readJson(path.join(CLAUDE, 'active-backend.json'));
    // Имя активного бэкенда нужно и разделу карт, и разделу ключей — объявляем здесь,
    // до первого использования.
    const abName = ab ? String(ab.backend) : '';
    if (!ab) bad('active-backend.json нет или битый → front-door отвечает 503 на всё');
    else {
        ok(`${ab.backend} → ${ab.upstream}`);
        const port = Number(new URL(ab.upstream).port);
        if (port) {
            const up = await portUp(port);
            if (!up) bad(`апстрим-порт :${port} НЕ слушает — это и есть «не отвечает»`);
            else {
                const s = await statusOk(port, '/__keepalive/api/status');
                if (s && s.code === 200) ok(`:${port} отвечает статусом`);
                else warn(`:${port} занят, но статус не отдал (${s ? s.code + ' ' + s.body.slice(0, 60) : 'нет ответа'})`);
            }
        }
    }

    say('');
    say('── 3. Порты стека ────────────────────────────────────────────');
    const PORTS = [
        [20100, 'front-door (вход Claude Code)', '/__frontdoor/api/status'],
        [8200, 'дашборд', '/__switch/api/status'],
        [20132, 'AR-конвертер', null],
        [20133, 'AgentRouter keepalive', '/__keepalive/api/status'],
        [20155, 'Tabi keepalive', '/__keepalive/api/status'],
        [20156, 'GoRouter keepalive', '/__keepalive/api/status'],
        [20158, 'JustWoker keepalive', '/__keepalive/api/status'],
        [20161, 'KKtoken keepalive', '/__keepalive/api/status'],
        [20134, 'вотчдог пулов', '/__watchdog/api/status'],
    ];
    for (const [p, name, sp] of PORTS) {
        const up = await portUp(p);
        if (!up) { info(`:${p} ${name} — не слушает`); continue; }
        if (!sp) { ok(`:${p} ${name}`); continue; }
        const s = await statusOk(p, sp);
        if (s && s.code === 200) ok(`:${p} ${name}`);
        else warn(`:${p} ${name} — держит порт, статус ${s ? s.code : '—'} (зомби?)`);
    }

    say('');
    say('── 4. Тир-карты провайдеров ──────────────────────────────────');
    // Два реальных класса поломки, оба уже стоили разбора:
    //   • пустой нижний тир → keepalive отправит `claude-haiku-*`, которого у
    //     opus-only шлюза нет, а «model not supported» это ПОСТОЯННАЯ ошибка:
    //     без ретрая, в лицо, на любом вызове сабагента;
    //   • `-thinking` в тирах → латентность на пустом месте, канон запрещает
    //     (ABUSE HUB § «Чем этот шлюз отличается от остальных четырёх»).
    // Легаси-шлюзы: пустая карта у них штатна, их не активируют. Если не разделить,
    // доктор будет краснеть на ровном месте — а отчёт, который всегда красный,
    // перестают читать, и он теряет смысл целиком.
    const LEGACY = new Set(['xpeach']);
    for (const f of fs.readdirSync(ROUTING).filter((n) => /-modelmap\.json$/.test(n)).sort()) {
        const m = readJson(path.join(ROUTING, f));
        const who = f.replace('-modelmap.json', '');
        if (!m) { bad(`${who}: карта не читается`); continue; }
        const empty = ['opus', 'sonnet', 'haiku'].filter((t) => !m[t]);
        const think = ['opus', 'sonnet', 'haiku'].filter((t) => /-thinking$/.test(String(m[t] || '')));
        const isActive = abName === who || (abName === 'agentrouter' && who === 'ar');
        if (empty.length && LEGACY.has(who)) info(`${who}: карта пуста — легаси-шлюз, так и должно быть`);
        else if (empty.length) {
            const how = isActive ? 'СЕЙЧАС АКТИВЕН' : 'при активации';
            bad(`${who}: пустые тиры [${empty.join(', ')}] → ${how} вызов такого тира падёт без ретрая`);
        } else if (think.length) warn(`${who}: -thinking в [${think.join(', ')}] → лишняя латентность, канон это снимает`);
        else ok(`${who}: opus=${m.opus} sonnet=${m.sonnet} haiku=${m.haiku}`);
    }

    say('');
    say('── 5. Активные ключи ─────────────────────────────────────────');
    const keys = fs.readdirSync(CLAUDE).filter((n) => /-active-key\.txt$/.test(n)).sort();
    for (const k of keys) {
        const v = (() => { try { return fs.readFileSync(path.join(CLAUDE, k), 'utf8').trim(); } catch { return ''; } })();
        const mine = abName && k.startsWith(abName.slice(0, 2));
        if (!v && mine) bad(`${k}: ПУСТ, а это ключ активного бэкенда → 503 «нет активного ключа»`);
        else if (!v) info(`${k}: пуст (провайдер не активирован)`);
        else ok(`${k}: ${v.length} симв.`);
    }

    say('');
    say('── 6. Код против git ─────────────────────────────────────────');
    // Своих копий кода не держим: если он разошёлся, лечит git, а не снимок.
    // 🪤 И НЕ советуем `git checkout --`: незакоммиченные строки в этом дереве
    // регулярно оказываются рабочими правками (24.08 их было 253 в двух файлах от
    // параллельной сессии). `checkout` сжигает их молча и без корзины, `stash` — нет.
    const { spawnSync } = require('child_process');
    const ROOT = path.join(ROUTING, '..');
    const g = spawnSync('git', ['status', '--short', '--', 'routing/'], { cwd: ROOT, encoding: 'utf8' });
    if (g.error) info('git недоступен — сверку кода пропускаю');
    else {
        const lines = (g.stdout || '').split('\n').map((l) => l.trim()).filter((l) => /\.js$/.test(l));
        const mod = lines.filter((l) => l.startsWith('M'));
        const untracked = lines.filter((l) => l.startsWith('??'));
        if (!lines.length) ok('изменённых .js в routing/ нет — код совпадает с git');
        else {
            const d = spawnSync('git', ['diff', '--shortstat', '--', 'routing/'], { cwd: ROOT, encoding: 'utf8' });
            warn(`.js расходится с git: изменено ${mod.length}, новых ${untracked.length}${d.stdout ? ' —' + d.stdout.trimEnd() : ''}`);
            for (const l of lines.slice(0, 10)) info(l);
            say('');
            info('Это НЕ обязательно поломка: так же выглядят несохранённые правки.');
            info('Сначала посмотреть:  git diff -- routing/');
            info('Убрать с ВОЗВРАТОМ:  git stash push -m rescue -- routing/');
            info('git checkout -- routing/ НЕ предлагаю: он сожжёт эти строки навсегда.');
        }
    }

    say('');
    say('── Что делать ────────────────────────────────────────────────');
    info('состояние испорчено  → node routing/rescue.js restore good');
    info('порты не слушают     → HUB.bat → «Перезапустить» (рвёт живые сессии CC)');
    info('подозрение на код    → git diff -- routing/, потом git stash (не checkout)');
    say('');
}

// ── Самопроверка: ничего не пишет и не сохраняет ──────────────────────────────
function cmdSelftest() {
    const assert = require('assert');
    const files = stateFiles();
    assert.ok(files.length > 0, 'состояние нашлось');
    assert.ok(files.some((f) => /-modelmap\.json$/.test(f.rel)), 'тир-карты попали в набор');
    assert.ok(files.some((f) => f.rel === 'active-backend.json'), 'active-backend попал в набор');
    assert.ok(files.some((f) => f.rel === 'settings.json'), 'settings.json попал в набор');
    assert.ok(files.some((f) => f.code), 'код денежного пути попал в набор');
    // Пулы аккаунтов — данные, не конфиг: в снимке их быть НЕ должно.
    assert.ok(!files.some((f) => /-sessions\.json$/.test(f.rel)),
        'пулы аккаунтов в снимок не попадают (иначе откат вернёт мёртвые ключи)');
    // Раскладка по двум базам обратима — на этом стоит restore.
    assert.strictEqual(baseOf(bucket(CLAUDE)), CLAUDE, 'claude-ведро резолвится обратно');
    assert.strictEqual(baseOf(bucket(ROUTING)), ROUTING, 'routing-ведро резолвится обратно');
    const src = fs.readFileSync(__filename, 'utf8');
    assert.ok(!/spawnSync\('taskkill|\bkill\(/.test(src), 'процессы не убиваем');
    // Совет «git checkout» уничтожил бы незакоммиченные правки — доктор его не даёт.
    assert.ok(!/info\('вернуть КОД как в git: git checkout/.test(src),
        'checkout как рецепт не предлагаем (сжигает незакоммиченное)');
    say(`  selftest OK (${files.length} файлов в наборе)`);
}

const [, , cmd, arg] = process.argv;
(async () => {
    switch (cmd) {
        case 'doctor': await cmdDoctor(); break;
        case 'save': cmdSave(arg); break;
        case 'list': cmdList(); break;
        case 'good': cmdGood(); break;
        case 'restore': cmdRestore(arg || 'good'); break;
        case 'selftest': cmdSelftest(); break;
        default:
            say('');
            say('  rescue.js — диагноз и откат состояния роутинга (без агента, без зависимостей)');
            say('');
            say('    node routing/rescue.js doctor         что живо, что врёт (только чтение)');
            say('    node routing/rescue.js good           пометить текущее состояние эталоном');
            say('    node routing/rescue.js restore good   вернуть эталон');
            say('    node routing/rescue.js save [метка]   снимок');
            say('    node routing/rescue.js list           список снимков');
            say('    node routing/rescue.js restore last   вернуть последний снимок');
            say('');
            say('  Процессы не трогает. Пулы аккаунтов не откатывает. Код лечится git.');
            say('');
            process.exit(1);
    }
})();
