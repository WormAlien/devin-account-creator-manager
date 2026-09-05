#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  check-hub.js — регресс на хаб запуска/остановки/обновления (2026-08-24).
//
//  Проверяет три вещи, каждая из которых уже ломалась живьём:
//    1. Список портов существует в ОДНОМ месте. Именно его размножение по пяти
//       файлам и было корнем «перезапустил, а не помогло»: bat знал 8 портов,
//       .sh — 10, START.bat — 2.
//    2. Механика убийства и старта работает НА САМОМ ДЕЛЕ — на подставном порту,
//       не на живом стеке. Живой трогать нельзя: через front-door ходит Claude Code.
//    3. Форвардеры показывают на хаб, а не хранят свою копию логики.
//
//  Запуск: node tools/check-hub.js
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'routing', 'lifecycle.js'));

let pass = 0;
const fails = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, why) => { fails.push(`${name} — ${why}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${why}`); };
const t = (name, fn) => { try { const r = fn(); if (r === true || r === undefined) ok(name); else bad(name, String(r)); } catch (e) { bad(name, e.message); } };
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = p => fs.existsSync(path.join(ROOT, p));

// Самопроба кадра: тот же файл с `--frame-probe` печатает JSON и выходит. Отдельный
// процесс нужен именно потому, что набор глифов не переключается внутри уже загруженного
// hub.js — а проверять надо оба.
//
// 🪤 Развилка стоит ВЫШЕ прибивания режима: иначе строка ниже перетирала бы
// `HUB_SAFE_GLYPHS=1`, которым эту самопробу и зовут, и безопасный набор проверялся бы
// сам на себе — тест зеленел бы, ничего не проверив.
if (process.argv.includes('--frame-probe')) { frameProbe(); return; }

// Набор глифов шапки (`SAFE` в hub.js) считается ОДИН раз при загрузке модуля, и в
// conhost он включается сам. Регресс от этого зависеть не должен: запущенный из cmd.exe
// он видел бы упрощённую шапку и валил проверки анимации, а из Windows Terminal —
// проходил. Поэтому здесь режим прибит явно, а безопасный набор проверяется отдельным
// процессом с `HUB_SAFE_GLYPHS=1` (см. ниже). Дети наследуют process.env, включая pty.
process.env.HUB_SAFE_GLYPHS = '0';

async function frameProbe() {
    const H = require(path.join(ROOT, 'hub.js'));
    const real = process.stdout.write.bind(process.stdout);
    const res = [];
    for (const [cols, rows] of [[113, 30], [80, 24], [70, 50]]) {
        Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
        Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
        let buf = '';
        process.stdout.write = s => { buf += s; return true; };
        let lay;
        try {
            lay = H.layout();
            await H.intro();
            H.statusBlock({ compact: lay.compact });
            if (!lay.compact) buf += '\n';
            for (const it of H.menuItems()) buf += H.itemLine(it, false) + '\n';
            buf += 'подсказка\n';
            if (lay.tip) buf += H.safeHint() + '\n';
        } finally { process.stdout.write = real; }
        const clean = buf.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        res.push({
            cols, rows, used: clean.split('\n').length - 1,
            art: !!lay.withArt, tip: !!lay.tip, text: clean,
        });
    }
    real(JSON.stringify({ safe: H.SAFE, res }));
}

console.log('\n\x1b[1m1. Ядро и таблица портов\x1b[0m');

t('lifecycle.js экспортирует то, на что опираются хаб и dashboard-api', () => {
    for (const k of ['SERVICES', 'children', 'killPlan', 'listeners', 'killPort', 'status', 'start', 'stop', 'restart', 'startService']) {
        if (!(k in L)) return `нет ${k}`;
    }
    return true;
});

t('у каждого сервиса существующий скрипт, дашборд стартует последним', () => {
    // Число сервисов не фиксируем: 24.08 к четырём добавился вотчдог пулов :20134.
    // Важен порядок — дашборд на boot спавнит детей и сметает лежалых, к его старту
    // порты уже должны быть свободны.
    if (L.SERVICES.length < 4) return `сервисов ${L.SERVICES.length}, это меньше четырёх базовых`;
    for (const s of L.SERVICES) {
        if (!has(path.join('routing', s.script))) return `нет файла routing/${s.script}`;
    }
    // Три прокси обязаны встать ДО дашборда (он занимает :8200 последним из них), а
    // после дашборда порядок свободен: вотчдог пулов :20134 добавлен 24.08 именно
    // после — без активного бэкенда ему нечего мерить.
    const order = L.SERVICES.map(s => s.port);
    const dash = order.indexOf(8200);
    if (dash < 0) return 'дашборда :8200 нет в списке вообще';
    for (const p of [20126, 20130, 20131]) {
        const i = order.indexOf(p);
        if (i >= 0 && i > dash) return `:${p} стартует после дашборда, а должен до`;
    }
    return true;
});

t('конвертеры провайдеров поднимаются по выбору, а не на старте', () => {
    // Решение владельца 05.09: «дашборд, вотчдог, фронтдор — а прокси по последнему
    // выбранному провайдеру». До этого FM-ротатор, FM-OpenAI и VyceAI стартовали всегда:
    // три процесса node по ~45 МБ и лишние секунды ради панелей, в которые не заходят.
    // 🪤 Список в `stop()`/`status()` обязан остаться ПОЛНЫМ — иначе «остановил» оставит
    // живой процесс на порту, а «статус» промолчит про него. Поэтому здесь проверяется
    // не отсутствие в SERVICES, а наличие метки `provider` и обвязки под неё.
    const lazy = L.SERVICES.filter(s => s.provider);
    if (lazy.length !== 3) return `помечено provider: ${lazy.length}, ожидалось 3 (FM-ротатор, FM-OpenAI, VyceAI)`;
    for (const p of [20126, 20130, 20131]) {
        if (!lazy.some(s => s.port === p)) return `:${p} не помечен provider`;
    }
    if (typeof L.activeUpstreamPort !== 'function') return 'нет activeUpstreamPort — по чему решать, кто выбран';
    if (typeof L.ensureProviderService !== 'function') return 'нет ensureProviderService — кто поднимет при выборе';
    const port = L.activeUpstreamPort();
    if (!Number.isInteger(port)) return 'activeUpstreamPort вернул не число';
    const src = read('routing/lifecycle.js');
    if (!/svc\.provider && svc\.port !== activePort/.test(src)) return 'start() не пропускает невыбранные конвертеры';
    if (!/start-lazy/.test(src)) return 'пропуск не сообщается наружу — в выводе хаба сервис просто исчезнет';
    if (!/start-lazy/.test(read('hub.js'))) return 'хаб не печатает строку про пропущенный конвертер';
    // Обратная сторона: раз на старте не поднимают, обязан поднимать выбор провайдера.
    const proxy = read('routing/transparent-proxy.js');
    if (!/ensureProviderService\(port\)/.test(proxy)) return 'applyTarget не поднимает конвертер при переключении';
    const apply = proxy.slice(proxy.indexOf('async function applyTarget'));
    const iEnsure = apply.indexOf('ensureProviderService');
    const iRotKey = apply.indexOf("'/__fmrot/api/active-key'");
    if (iEnsure < 0 || (iRotKey >= 0 && iEnsure > iRotKey)) {
        return 'конвертер поднимается ПОСЛЕ запроса ключа у ротатора — на пустом порту ключ придёт пустым';
    }
    return true;
});

t('«Здоровье»: неподнятый конвертер — покой, а не поломка', () => {
    const proxy = read('routing/transparent-proxy.js');
    for (const p of ['20126', '20130', '20131']) {
        if (!new RegExp(`port: ${p}, path: '[^']+', lazy:`).test(proxy)) return `проверка :${p} без флага lazy`;
    }
    if (!/lazy: c\.lazy \|\| undefined/.test(proxy)) return 'флаг lazy не доезжает до фронта';
    const html = read('routing/proxy-dashboard.html');
    if (!/const isIdle = \(s\) => \(s\.keepalive \|\| s\.lazy\)/.test(html)) return 'isIdle не считает lazy-сервисы простаивающими';
    if (!/idle \? 'не поднят' : 'упал'/.test(html)) return 'бейдж по-прежнему пишет «не запущен»/«упал» вместо «не поднят»';
    if (!/поднимется при выборе провайдера/.test(html)) return 'нет подсказки, когда он поднимется';
    // Настоящая поломка обязана остаться красной: активный порт из isIdle исключён.
    if (!/s\.port !== wiredPort/.test(html)) return 'из простаивающих не исключён активный порт — упавший активный станет серым';
    return true;
});

t('табло хаба не пугает: красное только настоящая недостача', () => {
    // 🪤 Пока в знаменателе стояли ВСЕ известные порты, а в «лежат:» — любой неподнятый
    // сервис, табло писало «5/16 · лежат: FM-ротатор, FM-OpenAI, VyceAI» на полностью
    // штатном состоянии. Владелец 05.09: «пугающе выглядит». Цифра описывала устройство
    // стека (11 из 16 — keepalive неактивных шлюзов), а не поломку.
    const src = read('hub.js');
    const fn = src.slice(src.indexOf('function statusBlock('), src.indexOf('function statusBlock(') + 3000);
    if (!fn) return 'statusBlock не найден';
    if (!/expected !== false/.test(fn)) return 'в «лежат:» по-прежнему попадают сервисы, которых сейчас не ждут';
    if (!/expected === false/.test(fn)) return 'ленивые сервисы не выделены отдельно — про них нельзя молчать';
    if (/\$\{alive\.length\}\/\$\{rest\.length\}/.test(fn)) return 'знаменатель — все известные порты, а не то, что должно быть живым';
    if (!/ждут выбора провайдера/.test(fn)) return 'нет строки, объясняющей, куда делись конвертеры';
    // Настоящая недостача обязана остаться красной, иначе проверка бессмысленна.
    if (!/downSvc\.length \? red\(/.test(fn)) return 'недостача больше не красная — так поломку не заметить';
    return true;
});

t('логи разведены по файлу на сервис', () => {
    // Один общий лог не работает на Windows физически: cmd-редирект `>>` не может
    // открыть файл, который держат живые процессы стека, — старт падает молча.
    const logs = new Set(L.SERVICES.map(s => L.serviceLog(s)));
    if (logs.size !== L.SERVICES.length) return 'два сервиса пишут в один файл — на Windows второй не поднимется';
    for (const f of logs) if (!/logs[\\/]hub[\\/]/.test(f)) return `лог не в logs/hub/: ${f}`;
    return true;
});

// Разница между restart и stop — не косметика. Она была источником двух разных
// поломок: гасили keepalive активного провайдера при рестарте (провайдер оставался
// без канала до следующей активации) и НЕ гасили их при остановке (четыре живых
// прокси после «остановил дашборд»).
t('restart не трогает keepalive неактивных провайдеров', () => {
    const p = L.killPlan('restart').map(x => x.port);
    for (const port of [20155, 20156, 20157, 20158, 20159]) {
        if (p.includes(port)) return `:${port} попал в план рестарта — его снимает сам дашборд на boot`;
    }
    return true;
});

t('stop гасит и keepalive, и легаси :8300', () => {
    const p = L.killPlan('stop').map(x => x.port);
    for (const port of [20155, 20156, 20157, 20158, 20159, 8300]) {
        if (!p.includes(port)) return `:${port} не в плане остановки — снять его потом будет некому`;
    }
    return true;
});

t('оба плана гасят детей, которых дашборд поднимает обратно сам', () => {
    for (const phase of ['restart', 'stop']) {
        const p = L.killPlan(phase).map(x => x.port);
        for (const port of [L.frontdoorPort(), 20132, 20133]) {
            if (!p.includes(port)) return `${phase}: :${port} не гасится — доживёт на старом коде`;
        }
    }
    return true;
});

t('дашборд гасится раньше своих детей', () => {
    const p = L.killPlan('stop').map(x => x.port);
    if (p.indexOf(8200) > p.indexOf(L.frontdoorPort())) return 'живой дашборд успеет поднять ребёнка обратно';
    return true;
});

t('в плане нет повторов', () => {
    for (const phase of ['restart', 'stop']) {
        const p = L.killPlan(phase).map(x => x.port);
        if (new Set(p).size !== p.length) return `${phase}: порт встречается дважды`;
    }
    return true;
});

t('front-door читается из frontdoor.json, а не захардкожен', () => {
    const src = read('routing/lifecycle.js');
    if (!src.includes('frontdoor.json')) return 'порт front-door взят из константы — «остановил, а порт слушает» вернётся';
    return true;
});

t('порты конвертеров Custom читаются из файла', () => {
    const src = read('routing/lifecycle.js');
    if (!src.includes('custom-providers.json')) return 'их номера заранее неизвестны, сканировать диапазон нельзя';
    return Array.isArray(L.customPorts());
});

console.log('\n\x1b[1m2. Ни одной второй копии логики\x1b[0m');

// Живьём: у каждого из пяти скриптов был свой netstat/taskkill и свой список
// портов. Ловим возврат этого класса — не по «плохим словам», а по факту, что
// скрипт запуска сам поднимает node или сам разбирает порты.
const LAUNCHERS = [
    'START.bat', 'DASHBOARD.command',
    'routing/restart-dashboard.bat', 'routing/restart-dashboard.sh',
    'routing/stop-dashboard.sh', 'routing/start-switcher.bat', 'routing/start-proxy.bat',
];

t('скрипты запуска не поднимают node сами', () => {
    const guilty = [];
    for (const f of LAUNCHERS) {
        if (!has(f)) continue;
        const src = read(f);
        // hub.js звать можно и нужно — это и есть форвардинг.
        const spawns = src.match(/\bnode\b[^\n]*\.js/g) || [];
        for (const m of spawns) if (!/hub\.js/.test(m)) guilty.push(`${f}: ${m.trim()}`);
    }
    return guilty.length ? guilty.join(' | ') : true;
});

t('скрипты запуска не разбирают порты сами', () => {
    const guilty = [];
    for (const f of LAUNCHERS) {
        if (!has(f)) continue;
        const src = read(f).split('\n')
            .filter(l => !/^\s*(rem|REM|#)/.test(l))     // комментарии с разбором истории — можно
            .join('\n');
        if (/netstat|taskkill|lsof -ti/.test(src)) guilty.push(f);
    }
    return guilty.length ? guilty.join(', ') + ' — своя копия убийства портов' : true;
});

t('каждый форвардер показывает на хаб', () => {
    const guilty = [];
    for (const f of LAUNCHERS) {
        if (!has(f)) continue;
        if (!/HUB\.(bat|command)|hub\.js/.test(read(f))) guilty.push(f);
    }
    return guilty.length ? guilty.join(', ') : true;
});

t('снятое не вернулось: FIX.bat, fix.sh, routing/dashboard.bat', () => {
    const back = ['FIX.bat', 'fix.sh', 'routing/dashboard.bat'].filter(has);
    return back.length ? back.join(', ') + ' снова на месте' : true;
});

// Поймано при сдаче работы: в .gitignore на корневые .bat стоит `*.bat` с
// allowlist'ом, и HUB.bat под него попал. На свежем клоне под Windows не
// запустилось бы НИЧЕГО — все форвардеры зовут именно его. Так же, но незамеченным,
// потерялся SHARE.bat: в README описан, в git отсутствует.
t('точки входа не выброшены .gitignore', () => {
    const missing = [];
    for (const f of ['HUB.bat', 'HUB.command', 'START.bat', 'DASHBOARD.command', 'hub.js', 'routing/lifecycle.js', 'internal/hub-art.txt']) {
        const r = spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT });
        if (r.status === 0) missing.push(f);
    }
    return missing.length ? missing.join(', ') + ' игнорируются git — до чужой машины не доедут' : true;
});

t('кнопка перезапуска в UI идёт через хаб на обеих платформах', () => {
    const src = read('internal/dashboard-api.js');
    if (!src.includes('LIFECYCLE_VERBS')) return 'launchBatFile не знает про хаб';
    // Прежний не-win32 путь звал bash по .bat — на маке кнопка не работала вовсе.
    if (/spawn\('bash', \[batPath\]/.test(src) && !src.includes('launchHub')) return 'на маке всё ещё bash по .bat';
    return true;
});

console.log('\n\x1b[1m3. Кодировки и переводы строк\x1b[0m');

// Правило проекта, обратное для двух типов файлов, и мы на нём уже стояли:
// .bat — ASCII без BOM (иначе нужен chcp, а BOM cmd печатает мусором),
// .command/.sh — LF (с CRLF mac ругается на интерпретатор).
t('HUB.bat и START.bat — чистый ASCII без BOM', () => {
    for (const f of ['HUB.bat', 'START.bat']) {
        const b = fs.readFileSync(path.join(ROOT, f));
        if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return `${f}: BOM — cmd напечатает его мусором`;
        const nonAscii = b.filter(x => x > 127).length;
        if (nonAscii) return `${f}: ${nonAscii} не-ASCII байт — тогда нужен chcp, а он под запретом`;
        // Именно команда, а не слово: в шапках этих файлов chcp упомянут как
        // объяснение, почему его тут нет.
        const cmd = b.toString('latin1').split(/\r?\n/)
            .filter(l => !/^\s*(rem|REM|::)/.test(l))
            .some(l => /^\s*chcp\b/i.test(l));
        if (cmd) return `${f}: chcp вернулся`;
    }
    return true;
});

t('.bat в CRLF (иначе cmd не находит метки :LABEL)', () => {
    for (const f of ['HUB.bat', 'START.bat', 'routing/start-switcher.bat', 'routing/start-proxy.bat', 'routing/restart-dashboard.bat']) {
        if (!has(f)) continue;
        const s = fs.readFileSync(path.join(ROOT, f), 'latin1');
        if (/(?<!\r)\n/.test(s)) return `${f}: одиночные LF`;
    }
    return true;
});

t('.command и .sh — строго LF, с shebang', () => {
    for (const f of ['HUB.command', 'DASHBOARD.command', 'tools/doctor.sh', 'tools/share.sh', 'routing/stop-dashboard.sh', 'routing/restart-dashboard.sh']) {
        const s = fs.readFileSync(path.join(ROOT, f), 'latin1');
        if (s.includes('\r')) return `${f}: CR внутри — mac не найдёт интерпретатор`;
        if (!s.startsWith('#!')) return `${f}: нет shebang`;
    }
    return true;
});

t('точки входа для мака сами добирают PATH', () => {
    // У GUI-процесса на маке PATH минимальный: ни Homebrew, ни nvm. Без этого
    // двойной клик падает «node: command not found» при живом node в терминале.
    for (const f of ['HUB.command', 'routing/restart-dashboard.sh', 'routing/stop-dashboard.sh']) {
        const s = read(f);
        if (!s.includes('/opt/homebrew/bin')) return `${f}: не добирает Homebrew в PATH`;
    }
    return true;
});

// Уборка корня 24.08: было 30 файлов, накопившихся с самого начала проекта.
// Правило — в корне только то, что человек открывает/запускает руками, плюс то, что
// обязано лежать по URL установки. Тест держит правило, а не число: новый файл в
// корне заставит либо обосновать его здесь, либо положить в папку.
const ROOT_ALLOWED = new Set([
    // читают
    'README.md', 'CLAUDE.md', 'ARCHITECTURE.md',
    // запускают
    'HUB.bat', 'HUB.command', 'START.bat', 'DASHBOARD.command', 'hub.js', 'RESCUE.bat',
    // установка одной строкой: URL показывает на корень репо, переезд ломает ссылку
    'install.ps1', 'install-mac.sh', 'install.sh', 'install-lib.sh', 'install-deps.sh',
    // инфраструктура, обязана быть в корне
    'package.json', 'package-lock.json', '.gitignore', '.gitattributes',
    // локальные конфиги (в .gitignore, у каждого свои)
    'config.js', 'opencode.json',
]);

t('в корне нет посторонних файлов', () => {
    const extra = fs.readdirSync(ROOT)
        .filter(n => fs.statSync(path.join(ROOT, n)).isFile())
        .filter(n => !ROOT_ALLOWED.has(n))
        .filter(n => !/^\.(env|DS_Store)|-report\.txt$|\.log$/.test(n));
    return extra.length ? extra.join(', ') + ' — либо в папку, либо в ROOT_ALLOWED с объяснением' : true;
});

t('package.json не показывает на удалённые файлы', () => {
    const p = JSON.parse(read('package.json'));
    const refs = [p.main, ...Object.values(p.scripts || {})]
        .join(' ').match(/[\w./-]+\.js\b/g) || [];
    const missing = [...new Set(refs)].filter(r => !has(r));
    // main был autoreger.js, которого нет ни на диске, ни в git — Devin свёрнут
    // давно, а `npm start` всё это время звал пустоту.
    return missing.length ? missing.join(', ') + ' в package.json, но файлов нет' : true;
});

t('переехавшие скрипты работают от корня репо, а не от своей папки', () => {
    for (const f of ['tools/doctor.sh', 'tools/share.sh']) {
        const s = read(f);
        if (!/cd "\$\(dirname "\$0"\)\/\.\."/.test(s)) return `${f}: cd не поднимается в корень — скрипт написан от корня`;
    }
    return true;
});

t('menu.js после переезда в internal/ не тянет пути от корня', () => {
    const s = read('internal/menu.js');
    if (!/const ROOT = path\.join\(__dirname, '\.\.'\)/.test(s)) return 'нет ROOT — пути к routing/ и notion/ отсчитываются от internal/';
    if (/path\.join\(ROOT, '\.\.'\)/.test(s)) return 'ROOT определён через себя (сам себя затёр при патче)';
    if (/require\('\.\/internal\//.test(s)) return "остался require('./internal/...) — теперь это internal/internal/";
    return true;
});

t('в исходниках нет литеральных управляющих байтов ESC', () => {
    const ESC = String.fromCharCode(27);
    for (const f of ['hub.js', 'routing/lifecycle.js']) {
        if (read(f).includes(ESC)) return `${f}: литеральный ESC вместо \\x1b — теряется при копировании через редактор`;
    }
    return true;
});

console.log('\x1b[1m\n4. Шапка хаба\x1b[0m');

t('картинка на месте и это прямоугольник', () => {
    if (!has('internal/hub-art.txt')) return 'нет internal/hub-art.txt — шапка останется без картинки';
    const lines = read('internal/hub-art.txt').replace(/\r/g, '').split('\n').filter(Boolean);
    if (lines.length < 3) return `строк всего ${lines.length}`;
    const w = [...lines[0]].length;
    for (const l of lines) if ([...l].length !== w) return `строки разной длины (${w} и ${[...l].length}) — картинка поедет`;
    if (w > 76) return `ширина ${w} — в 80 колонках не влезет с отступом`;
    return true;
});

// Второй файл картинки — для старого conhost. В Consolas и Lucida Console (единственные
// два шрифта, которые он предлагает) нет ни брайля, ни `✓`/`✗`/`❯` — замерено по таблицам
// глифов самих файлов шрифтов. Размеры обязаны совпадать с оригиналом: раскладка шапки
// считает ширину картинки и вычитает её из окна, а высоту складывает с панелью баланса.
t('вторая картинка шапки — глифами старого conhost и тех же размеров', () => {
    if (!has('internal/hub-art-blocks.txt')) return 'нет internal/hub-art-blocks.txt — в conhost шапка будет квадратами';
    const dims = f => {
        const lines = read(f).replace(/\r/g, '').split('\n').filter(Boolean);
        return { rows: lines.length, cols: Math.max(...lines.map(l => [...l].length)), lines };
    };
    const a = dims('internal/hub-art.txt');
    const b = dims('internal/hub-art-blocks.txt');
    if (a.rows !== b.rows || a.cols !== b.cols) {
        return `размеры разошлись: брайль ${a.cols}×${a.rows}, полублоки ${b.cols}×${b.rows}`;
    }
    const allowed = new Set([...' ░▒▓█▀▄']);
    const bad = new Set([...b.lines.join('')].filter(c => !allowed.has(c)));
    if (bad.size) {
        return `глифы, которых нет в шрифтах conhost: ${[...bad].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ')}`;
    }
    return true;
});

// Картинку легко «поправить руками» и получить расхождение с оригиналом, которое никто
// не заметит: обе версии выглядят правдоподобно. Поэтому вторая версия обязана быть
// ровно тем, что печатает генератор из первой — и это же ловит забытую пересборку после
// правки оригинала владельцем.
t('вторая картинка пересобирается генератором байт в байт', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'make-art-blocks.js'), '--stdout'],
        { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) return `генератор упал: ${String(r.stderr || '').trim().slice(0, 200)}`;
    if (r.stdout.replace(/\r/g, '') !== read('internal/hub-art-blocks.txt').replace(/\r/g, '')) {
        return 'файл разошёлся с генератором: либо правили руками, либо не пересобрали после правки оригинала '
            + '(node tools/make-art-blocks.js)';
    }
    return true;
});

// Главная проверка безопасного набора: в кадре не должно остаться НИ ОДНОГО глифа, которого
// нет в шрифтах conhost'а. Отдельным процессом, потому что набор считается при загрузке
// hub.js. Заодно проверяется порядок жертв: подсказка про упрощённую шапку уходит раньше
// самой картинки — иначе на 80×24 она стоила бы картинки, которую владелец просил хранить
// до последнего.
t('в безопасном наборе кадр рисуется только «дешёвыми» глифами', () => {
    const r = spawnSync(process.execPath, [__filename, '--frame-probe'],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, HUB_SAFE_GLYPHS: '1' } });
    if (r.status !== 0) return `самопроба кадра упала: ${String(r.stderr || '').trim().slice(0, 200)}`;
    let probe;
    try { probe = JSON.parse(r.stdout); } catch { return `самопроба вернула не JSON: ${r.stdout.slice(0, 120)}`; }
    if (!probe.safe) return 'HUB_SAFE_GLYPHS=1 не включил безопасный набор';

    // ASCII, кириллица и вот эти: ░▒▓█▀▄ √ • ○ · ─ — – … ↑ ↓ → « » × §.
    const extra = new Set([0x2591, 0x2592, 0x2593, 0x2588, 0x2580, 0x2584, 0x221A, 0x2022, 0x25CB,
        0x00B7, 0x2500, 0x2014, 0x2013, 0x2026, 0x2191, 0x2193, 0x2192, 0x00AB, 0x00BB, 0x00D7, 0x00A7]);
    const problems = [];
    for (const s of probe.res) {
        const bad = new Set();
        for (const ch of s.text) {
            const n = ch.codePointAt(0);
            if (n < 0x80 || (n >= 0x400 && n <= 0x4FF) || extra.has(n)) continue;
            bad.add('U+' + n.toString(16).toUpperCase());
        }
        if (bad.size) problems.push(`${s.cols}x${s.rows}: ${[...bad].join(' ')}`);
        if (s.used > s.rows) problems.push(`${s.cols}x${s.rows}: занято ${s.used} строк`);
        if (s.tip && !s.art) problems.push(`${s.cols}x${s.rows}: подсказка осталась, а картинку выбросили`);
        if (s.cols === 113 && s.rows === 30 && !(s.art && s.tip)) {
            problems.push(`113x30: ожидались и картинка, и подсказка (картинка ${s.art}, подсказка ${s.tip})`);
        }
    }
    return problems.length ? problems.join('; ') : true;
});

// Надпись собирается из глифов, а не пишется руками. До 25.08 она была строкой в
// полублочном шрифте, и «ABUSE» читалось как «AЬUSE»: у буквы B там нет верхней
// перекладины. Проверяем не картинку, а сам факт сборки — и что все буквы есть.
// Вордмарк «ABUSE HUB» снят 25.08 — владелец перебрал три варианта блочного шрифта и
// ни один не понравился. Проверяем, что он не вернулся: название и так в заголовке окна.
t('блочной надписи ABUSE HUB в шапке нет', () => {
    const src = read('hub.js');
    if (/const GLYPHS|function word\(/.test(src)) return 'таблица глифов вернулась';
    if (/[╔╗╚╝╠╣╦╩]{3}/.test(src)) return 'в исходнике снова блочные буквы';
    return true;
});

// Кадр обязан влезать в окно целиком: иначе верх уезжает за экран и картинки не видно
// (так дважды и было — при 33 строках и при 30). Мерить по дампу pty нельзя: анимация
// оставляет в потоке кадры с cursor-up, и реконструкция экрана из байтов врёт.
// Считаем строки, которые печатают сами функции, подменив stdout.
t('картинка сверху, кадр влезает в окно', () => {
    const H = require(path.join(ROOT, 'hub.js'));
    const sizes = [[113, 30], [113, 33], [120, 40], [113, 26], [80, 24], [200, 45], [70, 50]];
    const problems = [];

    for (const [cols, rows] of sizes) {
        Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
        Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
        let out = '';
        const real = process.stdout.write.bind(process.stdout);
        process.stdout.write = s => { out += s; return true; };
        let lay;
        try {
            lay = H.layout();
            H.intro();
            H.statusBlock({ compact: lay.compact });
            if (!lay.compact) out += '\n';
            for (const it of H.menuItems()) out += H.itemLine(it, false) + '\n';
            out += 'подсказка\n';
        } finally {
            process.stdout.write = real;
        }
        const lines = out.split('\n');
        const used = lines.length - 1;
        if (used > rows) problems.push(`${cols}x${rows}: занято ${used} строк`);

        const body = lines.filter(l => l.length);
        if (lay.withArt && !/[⠀-⣿]/.test(body[0] || '')) problems.push(`${cols}x${rows}: сверху не картинка`);
        // Окно владельца — эталон: 113×30, картинка обязана быть.
        if (cols === 113 && rows === 30 && !lay.withArt) problems.push('113x30: картинка скрыта, а обязана быть');
    }
    return problems.length ? problems.join('; ') : true;
});

t('дашборд один строкой и с кликабельным адресом, остальные свёрнуты', () => {
    const src = read('hub.js');
    if (!/function link\(/.test(src)) return 'нет OSC 8 — адрес дашборда снова просто текст';
    if (!/link\(url/.test(src)) return 'ссылка есть, но адрес дашборда её не использует';
    // Пять сервисов по строке каждый — то, что владелец попросил убрать.
    if (/for \(const r of svc\)/.test(src)) return 'сервисы снова печатаются по строке на каждый';
    return true;
});

console.log('\x1b[1m\n5. Фикс диктовки Orca\x1b[0m');

t('модуль читает состояние и НИЧЕГО не меняет', () => {
    const D = require(path.join(ROOT, 'internal', 'dictation-fix.js'));
    for (const k of ['state', 'install', 'disable', 'remove']) if (typeof D[k] !== 'function') return `нет ${k}()`;
    const before = D.state();
    const after = D.state();
    // Чтение состояния обязано быть идемпотентным: этот экран открывают, чтобы
    // посмотреть, а не чтобы что-то включить.
    if (before.installed !== after.installed || before.task !== after.task) return 'два чтения дали разное состояние';
    for (const k of ['ahk', 'installed', 'pid', 'startup', 'task', 'managed']) {
        if (!(k in before)) return `в состоянии нет поля ${k}`;
    }
    return true;
});

t('процесс ищется по командной строке, а не по имени образа', () => {
    // 🪤 На машине живёт второй AutoHotkey — индикатор раскладки в трее. Убийство или
    // счёт по имени образа сносит именно его, это уже случалось.
    const src = read('internal/dictation-fix.js');
    if (!/CommandLine -like '\*clip-as-typing\.ahk\*'/.test(src)) return 'фильтр по CommandLine исчез';
    // Комментарии выкидываем: в них `taskkill /IM` упомянут как предупреждение —
    // ровно про этот случай, когда им однажды снесли индикатор раскладки.
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/taskkill[^\n]*\/IM/.test(code)) return 'вернулся taskkill /IM — снесёт чужой AutoHotkey';
    if (!/'\/F', '\/PID'/.test(code)) return 'гашение не по PID';
    return true;
});

t('AutoHotkey сам не ставится, только подсказывается команда', () => {
    const src = read('internal/dictation-fix.js');
    if (/winget install AutoHotkey/.test(src) && /spawnSync\(\s*'winget'/.test(src)) return 'ставит сам — а это решение владельца';
    if (!/winget install AutoHotkey/.test(src)) return 'нет даже подсказки, чем ставить';
    return true;
});

t('обёртки генерируются в ASCII и через vbs-шим', () => {
    const src = read('internal/dictation-fix.js');
    // .ps1 без BOM PowerShell 5.1 читает как ANSI и рушится на кириллице; с BOM
    // ломается путь `irm … | iex`. ASCII годится в обоих случаях.
    if (!/'ascii'/.test(src)) return 'сгенерированные .ps1/.vbs пишутся не в ASCII';
    if (!/wscript\.exe \/\/B/.test(src)) return 'задача зовёт powershell напрямую — будет мигать окном каждые 10 минут';
    if (!/\/SC', 'MINUTE', '\/MO', '10'/.test(src)) return 'сторож не каждые 10 минут';
    return true;
});

t('пункт меню и вердикт в «Проверке» на месте', () => {
    const src = read('hub.js');
    if (!/doDictationFix/.test(src)) return 'нет экрана фикса';
    if (!/фикс диктовки/i.test(src)) return 'в «Проверке» нет строки про фикс';
    // Пункт только для Windows: AutoHotkey на macOS не существует.
    const m = src.match(/if \(L\.IS_WIN\) items\.push\(\{[\s\S]{0,400}?doDictationFix/);
    if (!m) return 'пункт не обёрнут в if (L.IS_WIN)';
    // Своё меню со своим выходом: пауза после него не нужна, иначе «q назад» упирается
    // в «Enter — вернуться», и кажется, что q не работает (так и было).
    if (!/noPause: true/.test(src)) return 'после подменю снова пауза — q будет казаться нерабочей';

    // Стрелки и точечная перерисовка. Кадр подменю рисуется через draw() под флагом
    // needFull; на стрелку меняются ровно две строки. Пока весь кадр перерисовывался
    // на каждое нажатие, логотип и состояние мигали (владелец 25.08: «на стрелочке
    // жмёшь, обновляется опять текст»).
    const sub = src.slice(src.indexOf('async function doDictationFix'));
    const body = sub.slice(0, sub.indexOf('\n}\n'));
    if (!/name === 'up' \|\| name === 'k'/.test(body)) return 'в подменю нет стрелок';
    if (!/const move = dir =>[\s\S]{0,400}acts\.length/.test(body)) return 'в подменю нет точечной перерисовки';
    if (!/itemLine\(acts\[i\]/.test(body)) return 'стрелка не перепечатывает строку пункта';
    if (!/const draw = \(\) => \{/.test(body)) return 'кадр подменю не вынесен в draw()';
    if (!/if \(needFull\) \{ draw\(\)/.test(body)) return 'кадр подменю рисуется без флага needFull — будет мигать';
    if ((body.match(/clearScreen\(\)/g) || []).length !== 1) return 'clearScreen в подменю зовётся не только из draw()';
    return true;
});

t('хоткеи работают в русской раскладке', () => {
    const src = read('hub.js');
    // readline для кириллицы отдаёт key.name === undefined: на «й» вместо q приходило
    // пустое имя, и выход из меню не работал (владелец 25.08: «на русском не работают
    // хоткей»). Нормализация ровно одна, и оба экрана ходят через неё.
    if (!/const RU_TO_EN = \{/.test(src)) return 'нет карты раскладки';
    if (!/function keyName\(k\)/.test(src)) return 'нет нормализации имени клавиши';
    const need = { 'й': 'q', 'ф': 'a', 'о': 'j', 'л': 'k' };
    for (const [ru, en] of Object.entries(need)) {
        if (!new RegExp(`'${ru}': '${en}'`).test(src)) return `в карте нет ${ru} → ${en}`;
    }
    // Ни один экран не должен читать k.name напрямую — иначе раскладка снова отвалится
    // именно там. Единственное разрешённое место — сама keyName.
    const raw = src.split('\n').filter(l => /k\.name/.test(l) && !/^\s*\/\//.test(l));
    if (raw.length !== 1) return `k.name читается в ${raw.length} местах, а должно только в keyName`;
    for (const fn of ['async function menu', 'async function doDictationFix']) {
        const part = src.slice(src.indexOf(fn), src.indexOf(fn) + 4000);
        if (!/const name = keyName\(k\)/.test(part)) return `${fn} не пользуется keyName`;
    }
    return true;
});

t('знак доллара на месте, это прямоугольник и он ровно высоты суммы', () => {
    // Копия обязана лежать в репо: вики это другой репозиторий, у форка её нет вообще.
    // С 26.08 это не арт из вики, а глиф в шрифте цифр — владелец забраковал прежний
    // размер («огромен»), а затем и торчащую перекладину («должно быть ровно»).
    if (!has('internal/hub-dollar.txt')) return 'нет internal/hub-dollar.txt';
    const lines = read('internal/hub-dollar.txt').replace(/\r/g, '').split('\n').filter(Boolean);
    const w = [...lines[0]].length;
    for (const l of lines) if ([...l].length !== w) return 'строки разной длины — знак поедет';
    if (!/[⠁-⣿]/.test(lines[0])) return 'это не брайль';
    // Ширина 10 точек = 5 символов, и это не вкусовщина: на 8 точках перекладина
    // разрезана границей ячеек и читается двумя чёрточками.
    if (w !== 5) return `ширина знака ${w} символов вместо 5 — перекладина разъедется`;
    // Высота РОВНО как у цифр: лишняя строка растянет панель, а с ней и шапку.
    const H = require(path.join(ROOT, 'hub.js'));
    const digits = (H.balancePanel(80, { big: true }).digitsAt || {}).rows || [];
    if (lines.length !== digits.length) return `знак ${lines.length} строк против ${digits.length} у суммы — не вровень`;
    // Уменьшать арт на ходу нельзя: замер показал пятно вместо S. Значит в коде не
    // должно появиться никакого «сжатия» знака — только готовый глиф из файла.
    const src = read('hub.js');
    if (/DOLLAR.*shrink|shrinkDollar/.test(src)) return 'в коде появилось уменьшение знака — оно даёт пятно';
    return true;
});

t('панель со знаком влезает в окно владельца и отступает на узком', () => {
    const H = require(path.join(ROOT, 'hub.js'));
    const plain = s => String(s).replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '');
    // 113×30 — окно владельца. Знак обязан влезать целиком, и ни одна строка шапки не
    // должна упираться в правый край: перенос разорвал бы картинку.
    const wide = H.layout({ cols: 113, rows: 30 });
    const artH = wide.art.length;
    // Высота шапки задаётся КАРТИНКОЙ: до 26.08 её раздувал большой знак (11 строк
    // против 9), теперь знак вровень с суммой и шапка не должна расти вообще.
    if (wide.headerRows !== artH) return `на 113×30 шапка ${wide.headerRows} строк при картинке ${artH} — знак снова её раздувает`;
    // 🪤 Признак присутствия знака — `dollarW`, а НЕ отступ цифр: блок центрируется, и у
    // панели без знака отступ тоже ненулевой (замерено: на 95 колонках col=3 без знака).
    if (!(wide.panel.digitsAt || {}).dollarW) return 'на 113×30 знак не встал слева от суммы';
    const artW = Math.max(...wide.art.map(l => [...l].length));
    for (let i = 0; i < wide.headerRows; i++) {
        const a = wide.art[i] === undefined ? ' '.repeat(artW) : wide.art[i];
        const len = [...('  ' + a + (wide.panel[i] ? '   ' + plain(wide.panel[i]) : ''))].length;
        if (len > 113) return `строка шапки ${i} шириной ${len} — не влезает в 113`;
    }
    // Лестница жертв стала узкой полосой, и это следствие центровки: знак стоит ВНУТРИ
    // блока, ширину панели задаёт подпись (25) и пулы, а знак добавляет всего 7 колонок,
    // из которых видны только 1 — пулы к этому моменту уже сжались. Поэтому пороги
    // проверяем точками, а не «узким окном вообще»: на 95 колонках отступает знак, на 94
    // уходит вся панель. Раньше на 90 она молча вылезала за край и рвала картинку.
    const at = cols => H.layout({ cols, rows: 30 });
    const c95 = at(95), c94 = at(94);
    if (!c95.withArt || !c94.withArt) return 'картинку выбросили раньше панели';
    if (!c95.panel.length) return 'на 95 колонках панель исчезла целиком, а должен был отступить только знак';
    if ((c95.panel.digitsAt || {}).dollarW) return 'на 95 колонках знак не отступил';
    if (c94.panel.length) return 'на 94 колонках панель осталась — она вылезет за край и разорвёт картинку';
    return true;
});

t('элементы панели соосны по вертикальной оси', () => {
    // Владелец: «доллар и баланс сместить направо, чтобы всё было соосно по вертикальной
    // центральной линии элементов». Значит у каждой непустой строки панели середина
    // содержимого обязана лежать на одной вертикали. «Знак + сумма» — один элемент на три
    // строки, поэтому у всех трёх её строк середина одна и та же.
    const H = require(path.join(ROOT, 'hub.js'));
    const plain = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
    const P = H.balancePanel(80, { big: true });
    if (!P.length) return 'панели нет';
    if (!(P.digitsAt || {}).dollarW) return 'знака в панели нет, центрировать нечего';
    // Середина строки = левый отступ + половина содержимого.
    const centre = P.map(r => plain(r)).filter(s => s.trim()).map(s => {
        const left = s.length - s.trimStart().length;
        return left + [...s.trim()].length / 2;
    });
    const lo = Math.min(...centre), hi = Math.max(...centre);
    // Допуск в одну колонку: подпись 25 символов, панель 30 — половинки не сходятся
    // ровно, и округление отступа вниз даёт законные полсимвола расхождения.
    if (hi - lo > 1) {
        return `оси разъехались на ${hi - lo} колонок: ${JSON.stringify(centre)}\n` +
            P.map(r => '|' + plain(r) + '|').join('\n');
    }
    return true;
});

t('Windows Terminal ищется НЕ через existsSync', () => {
    const src = read('hub.js');
    // 🪤 Причина серого окна администратора: wt.exe в WindowsApps — точка повторного
    // разбора «алиас выполнения приложения», stat по ней не проходит, поэтому
    // existsSync врёт FALSE, и хаб уходил на прямой запуск node = conhost.
    const fn = src.slice(src.indexOf('function findWt'), src.indexOf('function relaunchElevated'));
    if (!fn) return 'нет findWt()';
    if (/existsSync/.test(fn)) return 'снова existsSync — на алиасе он отвечает false, окно будет серым';
    if (!/where\.exe/.test(fn)) return 'wt не ищется через where.exe';
    if (!/lstatSync/.test(fn)) return 'нет запасного пути через lstat';
    // И сама элевация обязана иметь лестницу попыток, а не одну. Строки строит
    // elevateCommands(), поэтому смотрим её, а не relaunchElevated.
    const re = src.slice(src.indexOf('function elevateCommands'), src.indexOf('function relaunchElevated'));
    if ((re.match(/tries\.push/g) || []).length < 3) return 'у элевации меньше трёх попыток — при отказе wt не будет ничего';
    if (!/Verb RunAs/.test(re)) return 'элевация без -Verb RunAs';
    return true;
});

t('wt.exe найден на этой машине', () => {
    const H = require(path.join(ROOT, 'hub.js'));
    const wt = H.findWt();
    if (!wt) return 'Windows Terminal не найден — окно администратора будет серым (conhost)';
    return /wt\.exe$/i.test(wt) ? true : `непохожий путь: ${wt}`;
});

t('переезд в Windows Terminal защищён от вечной цепочки окон', () => {
    const src = read('hub.js');
    const fn = src.slice(src.indexOf('function moveToWindowsTerminal'), src.indexOf('async function main'));
    if (!fn) return 'нет moveToWindowsTerminal()';
    for (const guard of ['WT_SESSION', 'HUB_IN_WT', 'HUB_NO_WT']) {
        if (!fn.includes(guard)) return `нет проверки ${guard} — окна будут плодиться`;
    }
    // Элевацию тут просить нельзя: wt наследует права, а -Verb RunAs дал бы UAC на
    // КАЖДЫЙ запуск хаба — ровно то, за что сняли старый restart-dashboard.bat.
    if (/Verb RunAs/.test(fn)) return 'переезд просит UAC — этого быть не должно';
    // Старое окно не закрывается, пока новое не подало признаков жизни. Один раз это
    // уже стоило владельцу рабочего хаба: окно создавалось скрытым, процесс жил
    // невидимым, консоль закрывалась — снаружи «HUB.bat не работает».
    if (!/--wt-mark=/.test(fn)) return 'переезд не передаёт метку — старое окно закроется вслепую';
    if (!/existsSync\(mark\)/.test(fn)) return 'метка не ожидается — признак жизни нового окна не проверяется';
    if (!/^async function moveToWindowsTerminal/m.test(src)) return 'функция не async, ждать метку нечем';
    // И сам переехавший экземпляр обязан метку СОЗДАТЬ и больше не переезжать.
    const mainPart = src.slice(src.indexOf('async function main'));
    if (!/markArg/.test(mainPart)) return 'main() не разбирает метку — переехавший хаб поедет по кругу';
    if (!/!markArg && await moveToWindowsTerminal\(\)/.test(mainPart)) return 'переехавший экземпляр снова вызывает переезд';
    if (!/writeFileSync\(mark, String\(process\.pid\)\)/.test(mainPart)) return 'метка не создаётся — старое окно будет ждать зря';
    return true;
});

t('аргументы элевации не разваливаются на пробелах', () => {
    const H = require(path.join(ROOT, 'hub.js'));
    const cmds = H.elevateCommands([]);
    if (!cmds.length) return 'elevateCommands() ничего не вернул';
    // 🪤 Start-Process с любым -Verb идёт через ShellExecute: PowerShell склеивает
    // элементы -ArgumentList пробелами и НЕ кавычит их сам. Замер живьём (эхо argv):
    // и запись через запятую, и через @(...) дают ["--title","ABUSE","HUB","(админ)"],
    // то есть wt получает команду «HUB» и падает. Спасает только двойная кавычка внутри
    // значения. Ровно это и проверяем — по самим строкам, которые уйдут в powershell.
    for (const cmd of cmds) {
        const from = cmd.indexOf('@('), to = cmd.indexOf('); Start-Process');
        if (from < 0 || to < 0) return 'в команде нет массива аргументов';
        // Токены вынимаем сканером по одинарным кавычкам, а не split(',') — в значениях
        // есть и запятые, и скобки («ABUSE HUB (админ)»), и первая же наивная версия
        // этой проверки на них и сломалась.
        const tokens = cmd.slice(from + 2, to).match(/'(?:[^']|'')*'/g) || [];
        if (!tokens.length) return 'массив аргументов пуст';
        for (const raw of tokens) {
            const val = raw.slice(1, -1).replace(/''/g, "'");
            if (/\s/.test(val) && !(val.startsWith('"') && val.endsWith('"'))) {
                return `аргумент с пробелом без двойных кавычек: ${raw} — приедет разорванным`;
            }
        }
        // А вот -FilePath наоборот: двойных кавычек внутри быть НЕ должно, это параметр
        // PowerShell, и они уехали бы в имя файла.
        const fp = cmd.match(/-FilePath '([^']*)'/);
        if (fp && /^"/.test(fp[1])) return `-FilePath взят в двойные кавычки: ${fp[1]}`;
    }
    return true;
});

t('элевация и переезд открывают HUB.bat, чтобы окно пережило падение', () => {
    const H = require(path.join(ROOT, 'hub.js'));
    const args = H.wtHubArgs('ABUSE HUB');
    if (!has('HUB.bat')) return 'нет HUB.bat — не с чем сравнивать';
    // node напрямую = вкладка закрывается вместе с процессом, и стек падения увидеть
    // нельзя (владелец 25.08: «вылетал именно из внутрянки»). HUB.bat делает pause.
    if (!args.some(a => /HUB\.bat$/i.test(a))) return 'wt запускает node напрямую — окно закроется вместе с ошибкой';
    if (!args.includes('cmd.exe')) return 'bat запускается без cmd.exe';
    if (args[0] !== '-w' || args[1] !== '-1') return 'потеряно новое окно (-w -1)';
    return true;
});

t('падение хаба пишется в лог, а не теряется вместе с окном', () => {
    const src = read('hub.js');
    if (!/function installCrashLog/.test(src)) return 'нет обработчика падений';
    for (const ev of ['uncaughtException', 'unhandledRejection']) {
        if (!src.includes(ev)) return `не перехватывается ${ev}`;
    }
    if (!/hub-crash\.log/.test(src)) return 'стек никуда не пишется';
    if (!/installCrashLog\(\);/.test(src)) return 'обработчик объявлен, но не установлен';
    return true;
});

t('HUB.bat не выключает переезд в Windows Terminal', () => {
    const src = read('HUB.bat');
    // Строка `set "HUB_NO_WT=1"` тут появлялась 25.08 и отменяла ровно то, о чём просил
    // владелец: окно администратора должно выглядеть как обычное. Защита от цепочки
    // окон делается не здесь, а маркером HUB_IN_WT в окружении ребёнка.
    const live = src.split('\n').filter(l => !/^\s*rem\b/i.test(l)).join('\n');
    if (/HUB_NO_WT/.test(live)) return 'HUB.bat снова гасит переезд — двойной клик останется в conhost';
    return true;
});

t('окно Windows Terminal не запускается скрытым', () => {
    const src = read('hub.js');
    const fn = src.slice(src.indexOf('function moveToWindowsTerminal'), src.indexOf('async function main'));
    if (!fn) return 'нет moveToWindowsTerminal()';
    // 🪤 Замер видимых окон класса CASCADIA_HOSTING_WINDOW_CLASS до и после запуска:
    // с `windowsHide: true` 0→0, без него 0→1. То есть с флагом хаб жив, работает и
    // НЕВИДИМ — снаружи это выглядит как «HUB.bat не работает».
    const spawnCall = fn.slice(fn.indexOf('spawnSync(wt'), fn.indexOf('spawnSync(wt') + 400);
    if (/windowsHide:\s*true/.test(spawnCall)) return 'окно терминала создаётся скрытым — хаб будет работать невидимым';
    return true;
});

t('логотип Wispr на месте и это прямоугольник', () => {
    if (!has('internal/wispr-art.txt')) return 'нет internal/wispr-art.txt';
    const lines = read('internal/wispr-art.txt').replace(/\r/g, '').split('\n').filter(Boolean);
    const w = [...lines[0]].length;
    for (const l of lines) if ([...l].length !== w) return 'строки разной длины — логотип поедет';
    // Он рисуется СЛЕВА от состояния: сверху 19 строк не оставили бы места под текст.
    if (!/sideBySide/.test(read('hub.js'))) return 'логотип снова над текстом, а не рядом';
    return true;
});

t('последний известный запас пулов считается с диска и не врёт', () => {
    const B = require(path.join(ROOT, 'internal', 'hub-balance.js'));
    const b = B.balance();
    if (!b.pools.length) return 'нет ни одного пула';
    if (b.available < 0) return 'отрицательный остаток';
    // 🪤 Мёртвый ключ с остатком — не деньги, и неопрошенная цифра — не ноль. Оба
    // предиката обязаны стоять ДО суммы: тот же приём в сортировке таблиц дашборда.
    const src = read('internal/hub-balance.js');
    if (!/status[\s\S]{0,40}dead/.test(src)) return 'мёртвые ключи попадают в сумму';
    if (!/balanceCheckedAt/.test(src)) return 'неопрошенные ключи считаются нулём';
    if (b.pools.some(p => /xpeach/i.test(p.id + p.file))) return 'XPeach вернулся в сумму — он легаси';
    // Сумма должна биться с суммой пулов: расхождение = потерянный или удвоенный пул.
    const sum = b.pools.reduce((s, p) => s + p.available, 0);
    if (Math.abs(sum - b.available) > 0.01) return `итог ${b.available} не равен сумме пулов ${sum}`;
    return true;
});

t('панель запаса влезает рядом с картинкой, а не рвёт её', () => {
    const H = require(path.join(ROOT, 'hub.js'));
    Object.defineProperty(process.stdout, 'columns', { value: 113, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
    let out = '';
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = s => { out += s; return true; };
    try { H.intro(); } finally { process.stdout.write = real; }

    const lines = out.split('\n').filter(l => l.length);
    // Высота шапки берётся из раскладки, а не из картинки: с брайлевым долларом справа
    // шапка выше картинки на две строки, и это норма, а не «панель добавила свои».
    const head = H.layout({ cols: 113, rows: 30 }).headerRows;
    if (lines.length !== head) return `строк ${lines.length}, а шапка обещала ${head}`;
    if (lines.length < H.art().length) return 'шапка короче картинки — часть картинки потеряна';
    const tooWide = lines.filter(l => [...l.replace(/\x1b\[[0-9;]*m/g, '')].length > 113);
    if (tooWide.length) return `${tooWide.length} строк шире окна — картинка перенесётся и развалится`;
    if (!/ЗАПАС/.test(out)) return 'панели запаса нет вообще';
    return true;
});

t('вкладки не зовут функций, которых нет: сверка «зовут ↔ объявлено» по всем префиксам', () => {
    // 🪤 Ровно этот дефект дважды ломал вкладку целиком и дважды был не виден регрессам:
    // у TrueSOTA не было `tsResetKeepalive` (нашли 31.08 сверкой множеств), у HCNsec —
    // `hnResetKeepalive`, а у менеджера ящиков `olRowHtml` (нашлось 05.09 по жалобе
    // владельца `olRowHtml is not defined`). Каждый раз собственный чекер вкладки был
    // зелёным, потому что проверял НАЛИЧИЕ вызова, а не то, что вызываемое существует.
    // `switchTab` зовёт такую функцию первой — открытие вкладки падает ReferenceError и
    // не доходит до конца, то есть пустая вкладка вместо содержимого.
    const src = read('routing/proxy-dashboard.html');
    const PREF = '(?:ar|go|tb|xp|jw|sk|ts|kk|hn|ol)';
    const called = new Set([...src.matchAll(new RegExp('\\b(' + PREF + '[A-Z][A-Za-z0-9]*)\\s*\\(', 'g'))].map(m => m[1]));
    const defined = new Set();
    for (const re of [
        new RegExp('(?:async\\s+)?function\\s+(' + PREF + '[A-Z][A-Za-z0-9]*)\\s*\\(', 'g'),
        new RegExp('(?:const|let|var)\\s+(' + PREF + '[A-Z][A-Za-z0-9]*)\\s*=', 'g'),
        new RegExp('(' + PREF + '[A-Z][A-Za-z0-9]*)\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()', 'g'),
    ]) for (const m of src.matchAll(re)) defined.add(m[1]);
    // 🪤 Отбрасываем упоминания ИЗ КОММЕНТАРИЕВ: в файле есть ссылки на серверные функции
    // («arSettingsModel() в transparent-proxy.js — править синхронно»), и они не вызовы.
    // Резать `//`-хвосты у всего файла нельзя — в коде полно `https://`, срезало бы код.
    // Поэтому кандидат отбрасывается, только если ВСЕ его вхождения закомментированы.
    const lines = src.split('\n');
    const liveCall = (n) => {
        const re = new RegExp('\\b' + n + '\\s*\\(');
        return lines.some((l) => {
            const m = re.exec(l);
            if (!m) return false;
            const before = l.slice(0, m.index);
            return !/\/\/|^\s*\*/.test(before);
        });
    };
    const miss = [...called].filter((n) => !defined.has(n) && liveCall(n));
    if (miss.length) return `зовут, но не объявлено: ${miss.sort().join(', ')}`;
    return true;
});

t('дефолтный набор вкладок дашборда — как на рабочей установке', () => {
    const src = read('routing/proxy-dashboard.html');
    const m = src.match(/const DEFAULT_TABS_VISIBLE = \[([^\]]+)\]/);
    if (!m) return 'DEFAULT_TABS_VISIBLE не найден';
    const tabs = m[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
    // 25.08: добавился 'truesota' (седьмой шлюз, sub2api) — вкладка живая и в дефолте.
    // 31.08: добавился 'kktoken' (восьмой шлюз, New API + Kiro) — тоже живой и в дефолте.
    // 05.09: добавилась 'league' — рейтинг между установками, стоит сразу за «Финансами».
    // 05.09: 'truesota' УБРАН из дефолта решением владельца — вкладка живая, но место
    // в сайдбаре не оправдывает; включается в «Настроить вкладки» одним кликом.
    // 31.08 → восстановлено 05.09: 'outlook' (менеджер купленных ящиков) стоит сразу за
    // 'github' — оба про аккаунты, а не про шлюзы; 'hcnsec' (девятый шлюз, New API без
    // GitHub-входа) — сразу за 'kktoken', рядом со своим поколением панели. Обе вкладки
    // 04.09 пропали из дефолта не по решению, а откатом: код лежал незакоммиченным.
    const want = ['fin', 'league', 'github', 'outlook', 'agentrouter', 'gorouter', 'justwoker', 'kktoken', 'hcnsec', 'tabi', 'custom', 'plugins', 'health', 'settings'];
    if (tabs.join(',') !== want.join(',')) return `набор разъехался: ${tabs.join(',')}`;
    return true;
});

console.log('\x1b[1m\n6. CLI\x1b[0m');

const hub = (args, env) => spawnSync(process.execPath, [path.join(ROOT, 'hub.js'), ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

t('status отвечает нулём и перечисляет все известные порты', () => {
    const r = hub(['status']);
    if (r.status !== 0) return `код ${r.status}: ${String(r.stderr).slice(0, 200)}`;
    for (const p of [8200, 20126, 20130, 20131, L.frontdoorPort()]) {
        if (!r.stdout.includes(':' + p)) return `в выводе нет :${p}`;
    }
    return true;
});

t('без TTY в выводе нет ANSI (иначе лог и скриншоты — каша)', () => {
    const r = hub(['status']);
    const ESC = String.fromCharCode(27);
    return r.stdout.includes(ESC) ? 'в выводе есть escape-коды' : true;
});

t('неизвестная команда — код 2 и подсказка, а не тишина', () => {
    const r = hub(['ерунда']);
    if (r.status !== 2) return `код ${r.status}, ждали 2`;
    return /node hub\.js/.test(r.stdout) ? true : 'нет usage';
});

t('без аргументов и без TTY печатает статус, а не висит в ожидании клавиши', () => {
    const r = hub([]);
    if (r.status !== 0) return `код ${r.status}`;
    return r.stdout.includes(':8200') ? true : 'пустой вывод';
});

console.log('\x1b[1m\n7. Права и отказ в правах\x1b[0m');

// Именно этого не проверял ни один прежний скрипт, и именно здесь жили обе главные
// ошибки: старт «успешен», хотя node умер на первой строке, и «порт освобождён»
// сразу перед EADDRINUSE. Порт 28299 выбран вне всех рабочих диапазонов.
const PROBE_PORT = 28299;
const probeFile = path.join(os.tmpdir(), 'hub-check-probe.js');

async function mechanics() {
    fs.writeFileSync(probeFile, `require('http').createServer((q,s)=>s.end('ok')).listen(${PROBE_PORT},'127.0.0.1');`);
    const held = () => (L.listeners().get(PROBE_PORT) || new Set()).size;

    if (held()) { bad('порт для пробы свободен', `:${PROBE_PORT} кем-то занят, проба невозможна`); return; }
    ok('порт для пробы свободен');

    L.startService({ port: PROBE_PORT, name: 'проба', script: probeFile });
    let up = false;
    for (let i = 0; i < 24 && !up; i++) { await L.sleep(250); up = held() > 0; }
    if (!up) { bad('startService поднимает процесс', 'порт не занялся за 6 с'); return; }
    ok('startService поднимает процесс');

    const pids = [...L.listeners().get(PROBE_PORT)];
    pids.length === 1 ? ok('listeners() находит слушателя') : bad('listeners() находит слушателя', `найдено ${pids.length}: ${pids}`);

    // Наш ли процесс держит порт — вопрос, на котором start() раньше молча ошибался.
    // Проверяем на двух заведомо известных: наш собственный node и System (PID 4).
    L.isOurs(pids[0]) ? ok(`наш процесс распознан как свой (${L.pidImage(pids[0])})`)
        : bad('наш процесс распознан как свой', `pidImage вернул «${L.pidImage(pids[0])}»`);
    L.pidAlive(4) && !L.isOurs(4) ? ok(`System (PID 4) распознан как чужой (${L.pidImage(4) || 'имя недоступно'})`)
        : bad('System распознан как чужой', `isOurs(4)=${L.isOurs(4)}, image=«${L.pidImage(4)}»`);

    const r = await L.killPort(PROBE_PORT);
    r.freed && !held() ? ok('killPort освобождает порт и дожидается этого по факту') : bad('killPort освобождает порт', JSON.stringify(r));

    const again = await L.killPort(PROBE_PORT);
    again.freed && again.was.length === 0 ? ok('killPort по пустому порту не ошибка') : bad('killPort по пустому порту', JSON.stringify(again));

    try { fs.unlinkSync(probeFile); } catch { /* уже нет */ }
}

// ── Отказ в правах отвечает СРАЗУ ────────────────────────────────────────────
// Раньше отказ всё равно уходил в 8-секундный таймаут на каждый порт: на плане из
// 14 портов это до двух минут «он что-то долго думает» вместо мгновенного ответа.
// Проверяем на настоящем отказе, а не на подделке: порт, который слушает процесс
// System (PID 4). Его нельзя убить даже администратором, так что попытка безопасна
// и всегда даёт ровно тот отказ, который нас интересует.
async function denialIsInstant() {
    if (!L.IS_WIN) { console.log('  \x1b[33m·\x1b[0m проверка отказа — только для Windows, пропущено'); return; }

    let port = 0;
    for (const [p, pids] of L.listeners()) if (pids.has(4)) { port = p; break; }
    if (!port) { console.log('  \x1b[33m·\x1b[0m не нашёл порта у System (PID 4) — отказ проверить нечем'); return; }

    const t0 = Date.now();
    const r = await L.killPort(port);
    const ms = Date.now() - t0;

    r.denied ? ok(`отказ в правах распознан (:${port}, PID 4 = System)`)
        : bad('отказ в правах распознан', `killPort вернул denied=${r.denied} — значит отказ мы не видим`);
    r.freed === false ? ok('порт System честно помечен как неосвобождённый')
        : bad('порт System помечен как неосвобождённый', 'freed=true при живом System — врём в отчёте');
    ms < 2000 ? ok(`ответ пришёл за ${ms} мс, а не через таймаут`)
        : bad('ответ приходит сразу', `ждали ${ms} мс — таймаут 8 с на порт вернулся, на 14 портах это две минуты`);
    r.fast === true ? ok('пометка fast стоит — хаб знает, что ждать было нечего')
        : bad('пометка fast', 'её нет, отчёт не отличит отказ от честного таймаута');
}

t('порядок «погасить → поднять» существует в одном месте', () => {
    // Хаб раньше держал свою копию последовательности рестарта, а lifecycle.restart()
    // лежал мёртвым. Две копии порядка — та самая болезнь, из-за которой всё и
    // переписывалось, поэтому проверяем, что хаб зовёт общую реализацию.
    const hub = read('hub.js');
    if (!/L\.restart\(/.test(hub)) return 'хаб не зовёт L.restart — значит собрал порядок заново у себя';
    if (/L\.stop\(\{ phase: 'restart'/.test(hub)) return 'в хабе осталась своя копия фазы рестарта';
    return true;
});

t('чужой процесс на порту отличается от нашего', () => {
    const src = read('routing/lifecycle.js');
    if (!/isOurs|pidImage/.test(src)) return 'занятый порт снова читается как «уже поднято», чей бы он ни был';
    if (!/start-foreign/.test(src)) return 'наверх о чужаке не сообщают';
    // Имя образа не переводится ни на одной локали — в отличие от всего остального
    // вывода консольных утилит Windows, на котором мы уже стояли (см. taskkill).
    if (!/\^node\(\\\.exe\)\?\$/.test(src)) return 'сравнение имени процесса стало нестрогим';
    return true;
});

t('слушателей ищем не по слову LISTENING', () => {
    // На части локалей Windows netstat переводит состояния (заголовки таблицы на этой
    // машине уже переведены). Языконезависимая примета — внешний порт 0.
    const src = read('routing/lifecycle.js');
    if (!/:0\$/.test(src)) return 'нет признака «внешний порт 0» — на локализованном netstat потеряем все порты';
    return true;
});

t('«Проверка» и «Отчёт для отправки» — разные пункты с разным смыслом', () => {
    const src = read('hub.js');
    if (!/async function doCheck/.test(src)) return 'нет быстрой проверки — остаётся только 168-строчный дамп';
    if (!/case 'check'/.test(src)) return 'из CLI проверку не позвать';
    if (!/Отчёт для отправки/.test(src)) return 'доктор снова называется непонятно';
    // Проверка обязана быть безопасной: никаких kill/start внутри.
    const body = src.slice(src.indexOf('async function doCheck'), src.indexOf('// ── Обновление'));
    if (/L\.(stop|start|restart|killPort)\(/.test(body)) return 'проверка что-то меняет — она обязана только смотреть';
    return true;
});

t('на рестарте отказ прекращает работу, а не гасит остаток стека', () => {
    const src = read('routing/lifecycle.js');
    if (!/r\.denied && phase === 'restart'/.test(src)) return 'нет раннего выхода — уронит больше и всё равно не соберёт';
    if (!/type: 'abort'/.test(src)) return 'выход есть, но наверх о нём не сообщают';
    return true;
});

t('права считаются один раз и не требуются для работы', () => {
    const src = read('routing/lifecycle.js');
    if (!/let _elevated = null/.test(src)) return 'нет кеша — 130 мс на каждую отрисовку меню';
    const t0 = Date.now();
    L.isElevated(); L.isElevated(); L.isElevated();
    const ms = Date.now() - t0;
    if (ms > 400) return `три вызова заняли ${ms} мс — кеш не работает`;
    // Хаб обязан работать без прав: элевация — лечение, а не условие запуска.
    if (/isElevated\(\)[\s\S]{0,80}(process\.exit|throw)/.test(read('hub.js'))) return 'хаб отказывается работать без админа — это регресс';
    return true;
});

// ── Три свойства запуска на Windows ──────────────────────────────────────────
// Ни одно не абстрактное, каждое ломалось живьём 24.08. Третье — про консоль —
// и есть причина «лютого спама окон»: сервис без консоли заставляет каждый свой
// вызов netstat/git/sqlite3 заводить новую, а у новой есть окно.
async function windowsSpawnProps() {
    if (!L.IS_WIN) { console.log('  \x1b[33m·\x1b[0m свойства запуска — только для Windows, пропущено'); return; }

    const PORT = 28297;
    const mark = path.join(os.tmpdir(), 'check-hub-console.txt');
    const srv = path.join(os.tmpdir(), 'check-hub-props.js');
    // Ребёнок сам отвечает, есть ли у него консоль: `mode con` без консоли не работает.
    // Опрашивать окна снаружи нельзя — прошлая попытка делать это через PowerShell с
    // Add-Type в цикле САМА породила спам окон, который искала.
    fs.writeFileSync(srv, `
const { spawnSync } = require('child_process');
const fs = require('fs');
require('http').createServer((q,s)=>s.end('ok')).listen(${PORT},'127.0.0.1');
const r = spawnSync('cmd', ['/c','mode','con'], { encoding: 'utf8' });
fs.writeFileSync(${JSON.stringify(mark)}, /Lines|CON|строк/i.test(String(r.stdout)) ? 'ЕСТЬ' : 'НЕТ');
`);
    try { fs.unlinkSync(mark); } catch { /* нет */ }

    if ((L.listeners().get(PORT) || new Set()).size) { bad('порт 28297 свободен', 'занят'); return; }

    // Запускаем через процесс-посредник, который СРАЗУ выходит: иначе «переживает
    // родителя» не проверить — родителем был бы сам регресс.
    const launcher = path.join(os.tmpdir(), 'check-hub-launcher.js');
    fs.writeFileSync(launcher, `
const L = require(${JSON.stringify(path.join(ROOT, 'routing', 'lifecycle.js').replace(/\\/g, '/'))});
L.startService({ port: ${PORT}, name: 'проба', script: ${JSON.stringify(srv.replace(/\\/g, '/'))} });
process.exit(0);
`);
    const lr = spawnSync(process.execPath, [launcher], { encoding: 'utf8', windowsHide: true });
    if (lr.status !== 0) { bad('посредник стартует сервис', String(lr.stderr).slice(0, 200)); return; }

    let up = false;
    for (let i = 0; i < 24 && !up; i++) { await L.sleep(250); up = (L.listeners().get(PORT) || new Set()).size > 0; }
    up ? ok('сервис поднялся') : bad('сервис поднялся', 'порт не занялся');

    await L.sleep(1200);
    up && (L.listeners().get(PORT) || new Set()).size
        ? ok('переживает выход родителя (иначе стек умрёт вместе с хабом)')
        : bad('переживает выход родителя', 'процесс умер вместе с посредником');

    const con = fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').trim() : '(не отчитался)';
    con === 'ЕСТЬ'
        ? ok('у сервиса ЕСТЬ консоль — его внуки не будут плодить окна')
        : bad('у сервиса есть консоль', `ответ «${con}» — вернётся спам окон при каждом netstat/git/sqlite3 внутри дашборда`);

    const src = fs.readFileSync(path.join(ROOT, 'routing', 'lifecycle.js'), 'utf8');
    /detached: true,[\s\S]{0,120}windowsHide: true|windowsHide: true,[\s\S]{0,120}detached: true/.test(src)
        ? bad('detached и windowsHide не стоят вместе', 'MSDN запрещает эту пару, detached побеждает — консоли не будет')
        : ok('detached и windowsHide не стоят вместе на одном spawn');

    await L.killPort(PORT);
    for (const f of [srv, launcher, mark]) { try { fs.unlinkSync(f); } catch { /* нет */ } }
}

// Проверять TUI подделкой isTTY бессмысленно: половина поведения — реакция на
// клавиши в raw-режиме. Поднимаем настоящий pty (node-pty уже в зависимостях,
// его использует терминал дашборда) и разговариваем с меню как человек.
async function tui() {
    let pty;
    try { pty = require('node-pty'); } catch (e) {
        console.log(`  \x1b[33m·\x1b[0m меню пропущено: node-pty недоступен (${e.message.slice(0, 60)})`);
        return;
    }
    const term = pty.spawn(process.execPath, [path.join(ROOT, 'hub.js')], {
        // 113×36 — окно владельца с запасом на одну строку: при 30 строках картинка
        // скрывается по гейту, и тест ловил бы её отсутствие как поломку.
        // HUB_NO_DRIP — чтобы мерить точечную перерисовку: капель шлёт свои кадры сама,
        // и в дельте после стрелки они выглядели бы как перерисовка всего кадра.
        // HUB_NO_WT — чтобы хаб не уехал из pty в новое окно Windows Terminal: у pty нет
        // ни WT_SESSION, ни TERM, и он честно принимает его за conhost.
        cwd: ROOT, cols: 113, rows: 36, env: { ...process.env, HUB_NO_DRIP: '1', HUB_NO_WT: '1' },
    });
    let buf = '';
    term.onData(d => { buf += d; });

    const waitFor = (re, ms) => new Promise(resolve => {
        const started = Date.now();
        const iv = setInterval(() => {
            if (re.test(buf)) { clearInterval(iv); resolve(true); }
            else if (Date.now() - started > ms) { clearInterval(iv); resolve(false); }
        }, 100);
    });

    const gotMenu = await waitFor(/Запустить[\s\S]*Остановить[\s\S]*Обновить/, 12000);
    gotMenu ? ok('меню рисуется: старт, стоп, обновление на месте') : bad('меню рисуется', 'за 12 с не увидели пунктов\n' + buf.slice(-400));

    // Картинка — брайль (U+2800…), вордмарк — элементы двойной рамки. Проверяем оба:
    // раньше здесь стояли только блоки ▀▄█, и после смены шрифта тест ловил не то.
    /[⠀-⣿]/.test(buf) ? ok('картинка печатается брайлем') : bad('картинка печатается', 'символов брайля в выводе нет');
    // Адрес дашборда обязан быть гиперссылкой: OSC 8 в потоке — `ESC ] 8 ; ;`.
    buf.includes('\x1b]8;;') ? ok('адрес дашборда — кликабельная ссылка') : bad('адрес дашборда — ссылка', 'OSC 8 в выводе нет');
    buf.includes(String.fromCharCode(27)) ? ok('в TTY цвета включены') : bad('в TTY цвета включены', 'ни одного escape-кода');
    /сервис|живой|лежит/.test(buf) ? ok('в шапке видно состояние портов') : bad('состояние портов в шапке', 'нет ни одной метки состояния');

    // Стрелка вниз обязана двигать курсор ❯, а не печатать «B» (так выглядит
    // необработанная escape-последовательность).
    const before = buf.length;
    term.write('\x1b[B');
    await L.sleep(400);
    const afterArrow = buf.slice(before);
    !/\bB\b/.test(afterArrow.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) ? ok('стрелки не печатаются как буквы') : bad('стрелки не печатаются как буквы', 'в выводе появилась «B»');

    // И перерисовка на стрелку обязана быть точечной. Мерим сам поток: полный кадр —
    // это картинка (брайль) и заголовок панели баланса. Если они прилетели снова,
    // значит экран мигнул целиком.
    if (/[⠀-⣿]/.test(afterArrow) || /ПОСЛЕДНИЙ/.test(afterArrow)) bad('стрелка не перерисовывает кадр', 'в ответ на стрелку приехала вся шапка');
    else if (afterArrow.length > 900) bad('стрелка не перерисовывает кадр', `на стрелку прилетело ${afterArrow.length} байт — это похоже на полный кадр`);
    else ok(`стрелка перерисовывает только строки пунктов (${afterArrow.length} байт)`);

    // Последний известный запас — в шапке справа от картинки, брайлевым шрифтом
    // (вариант 1 владельца от 26.08). Проверяем и подпись, и сами цифры.
    /ПОСЛЕДНИЙ ИЗВЕСТНЫЙ ЗАПАС/.test(buf) ? ok('в шапке есть последний известный запас') : bad('запас в шапке', 'подписи панели нет');
    /опрошено/.test(buf) ? ok('у суммы стоит время опроса') : bad('время опроса', 'нет отметки «опрошено»');
    // Искать «брайль в выводе» бессмысленно: им же нарисованы картинка и доллар.
    // Поэтому набираем цифры тем же шрифтом, что и hub.js, и ищем их дословно.
    // 🪤 Брать сумму из `balancePanel` НЕЛЬЗЯ: запас опрашивается фоном и за время теста
    // успевает измениться (11302 → 11282 за сессию), проверка падала бы через раз. Сумму
    // берём из САМОГО вывода — ту, которую видел терминал.
    // 🪤 Сравнивать с ХВОСТОВЫМ пробелом нельзя: `bigNum` ставит его после каждой цифры,
    // а ConPTY хвост строки не печатает — вместо него приезжает `ESC[K`. Поэтому trim.
    const shown = (buf.match(/\$(\d+)\.(\d\d)/) || [])[0];
    const dg = shown ? require(path.join(ROOT, 'hub.js')).bigNum(String(Math.round(Number(shown.slice(1))))).map(r => r.trimEnd()) : [];
    dg.length === 3 && dg.every(r => buf.includes(r))
        ? ok(`сумма набрана брайлевым шрифтом — все три строки цифр на экране (${shown})`)
        : bad('шрифт суммы', shown ? 'строк цифр в выводе нет:\n' + JSON.stringify(dg) : 'суммы в выводе нет вообще');

    // Русская раскладка: «о» это физическая клавиша j (вниз), «й» — q (выход). До 25.08
    // readline отдавал для кириллицы пустое имя, и на русском не работало ничего.
    const beforeRu = buf.length;
    term.write('о');
    await L.sleep(400);
    const afterRu = buf.slice(beforeRu);
    /❯/.test(afterRu) ? ok('«о» двигает выбор как j — русская раскладка понята') : bad('русская раскладка: «о» = j', 'курсор не сдвинулся\n' + JSON.stringify(afterRu.slice(0, 200)));

    const exited = new Promise(resolve => term.onExit(({ exitCode }) => resolve(exitCode)));
    term.write('й');
    const code = await Promise.race([exited, L.sleep(6000).then(() => 'таймаут')]);
    if (code === 0) ok('«й» выходит из меню с нулём — q в русской раскладке');
    else { bad('«й» выходит из меню', `получили ${code}`); try { term.kill(); } catch { /* уже мёртв */ } }
}

// ── 12. Готовность к macOS ───────────────────────────────────────────────────
// Проверки статические: регресс гоняется на Windows, живого мака под рукой нет.
// Смысл в том, чтобы правка «под винду» не выбила POSIX-ветку молча — а именно так
// и происходит, когда ветки лежат в одной функции и одна из них не исполняется.
function macReady() {
    const life = read('routing/lifecycle.js');
    const hub = read('hub.js');

    // У каждой платформенной функции обязана быть вторая половина. Ищем по инструменту:
    // на POSIX это lsof/ss (порты), ps (имя процесса), getuid (права), detached (запуск).
    const posix = {
        'слушатели портов': /lsof/.test(life) && /'ss'/.test(life),
        'имя процесса по PID': /ps',\s*\['-p'/.test(life),
        'права': /process\.getuid/.test(life),
        'запуск сервиса': /detached: true/.test(life),
        'убийство процесса': /process\.kill\(pid, hard \? 'SIGKILL' : 'SIGTERM'\)/.test(life),
    };
    for (const [what, present] of Object.entries(posix)) {
        present ? ok(`POSIX-ветка на месте: ${what}`) : bad(`POSIX-ветка: ${what}`, 'на маке эта функция ничего не вернёт');
    }

    // Windows-инструменты вне гейта. Считаем построчно и только по коду: в комментариях
    // они упоминаются постоянно (и уже дважды ломали этот тест ложным провалом).
    const guilty = [];
    for (const [f, src] of [['hub.js', hub], ['routing/lifecycle.js', life]]) {
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
            if (!/taskkill|tasklist|wt\.exe|'powershell'|'netstat'|'cmd'|LOCALAPPDATA/.test(l)) continue;
            // Гейт может стоять на этой же строке или выше в теле функции — смотрим
            // окно назад до начала функции. 25 строк: в relaunchElevated между
            // `if (!L.IS_WIN) return false` и вызовом powershell лежат 16 строк сборки
            // команды, и окно поменьше давало ложный провал.
            const back = lines.slice(Math.max(0, i - 25), i + 1).join('\n');
            if (!/IS_WIN|platform === 'win32'/.test(back)) guilty.push(`${f}:${i + 1}`);
        }
    }
    guilty.length === 0 ? ok('вызовов Windows-утилит вне гейта IS_WIN нет')
        : bad('Windows-утилиты вне гейта', guilty.join(', ') + ' — на маке это ENOENT');

    // Браузер и установщик — развилки, без которых на маке ломается «Открыть» и «Обновить».
    /'open', \[url\]|'open'/.test(hub) && /xdg-open/.test(hub)
        ? ok('открытие браузера знает open и xdg-open') : bad('открытие браузера', 'нет ветки для darwin/linux');
    /darwin' \? 'install-mac\.sh' : 'install\.sh'/.test(hub)
        ? ok('обновление зовёт install-mac.sh на маке') : bad('установщик на маке', 'обновление уедет в install.sh для git-bash');
    /if \(!L\.IS_WIN\) return '\/bin\/bash'/.test(hub)
        ? ok('bash на маке берётся из /bin, а не ищется как git-bash') : bad('поиск bash', 'на маке вернётся null');

    // Шелл-скрипты обязаны работать на bash 3.2: в macOS до сих пор он, и bash 4-only
    // синтаксис падает не сообщением, а строкой про syntax error в середине установки.
    const b4 = /declare -A|mapfile|readarray|\$\{[A-Za-z_]+,,\}|\$\{[A-Za-z_]+\^\^\}/;
    const olds = [];
    for (const f of ['install-mac.sh', 'install.sh', 'install-lib.sh', 'install-deps.sh', 'tools/doctor.sh', 'tools/share.sh',
        'HUB.command', 'DASHBOARD.command']) {
        if (has(f) && b4.test(read(f))) olds.push(f);
    }
    olds.length === 0 ? ok('шелл-скрипты обходятся синтаксисом bash 3.2 (в macOS он)')
        : bad('bash 4-only синтаксис', olds.join(', '));

    // Exec-бит в индексе. `core.fileMode false` на Windows скрывает разницу, и файл
    // легко уезжает как 100644 — на маке двойной клик тогда падает «нет прав».
    const idx = String(require('child_process').execFileSync('git', ['ls-files', '-s',
        'HUB.command', 'DASHBOARD.command', 'install-mac.sh', 'install.sh', 'install-deps.sh'], { cwd: ROOT, encoding: 'utf8' }));
    const notExec = idx.split('\n').filter(Boolean).filter(l => !l.startsWith('100755')).map(l => l.split('\t')[1]);
    notExec.length === 0 ? ok('точки входа для мака лежат в git с exec-битом')
        : bad('exec-бит в индексе', notExec.join(', ') + ' — двойной клик на маке упрётся в права');
}

// ── 14. Пачка нажатий не теряется ────────────────────────────────────────────
//
// Быстрое листание стрелками приезжает в поток ОДНИМ куском, и readline разбирает
// его в несколько событий подряд. Пока readKey() ставил одноразовый слушатель и
// снимал его на первом же событии, остальные нажатия падали в никуда: замер на
// живом коде — 5 нажатий одним куском, доставлено 1. Снаружи это «полистал резко,
// и меню зависло, перестало реагировать» (владелец 04.09).
//
// Проверяем машинку клавиш НАПРЯМУЮ, подменив stdin обычным потоком: через node-pty
// это не воспроизводится — ConPTY по-своему обрабатывает escape-последовательности,
// записанные во ввод, и залп доезжает как одно нажатие независимо от нашего кода.
async function keyBurst() {
    const { PassThrough } = require('stream');
    const readline = require('readline');
    const src = read('hub.js');
    const i = src.indexOf('const KEYQ = [];');
    const j = src.indexOf('// Русская раскладка');
    if (i < 0 || j < 0) { bad('машинка клавиш', 'блок KEYQ/readKey в hub.js не найден'); return; }

    const fake = new PassThrough();
    fake.isTTY = false;
    let M;
    try {
        M = new Function('readline', 'process', 'focusHook',
            src.slice(i, j) + '; return { readKey, keysRelease, KEYQ };')(readline, { stdin: fake }, null);
    } catch (e) { bad('машинка клавиш исполняется', e.message); return; }

    const seq = ['down', 'down', 'up', 'down', 'up'];
    fake.write('\x1b[B\x1b[B\x1b[A\x1b[B\x1b[A');
    await L.sleep(100);
    const got = [];
    for (let n = 0; n < seq.length; n++) {
        got.push((await Promise.race([
            M.readKey(),
            L.sleep(300).then(() => ({ name: 'ПОТЕРЯНО' })),
        ])).name);
    }
    got.join(',') === seq.join(',')
        ? ok(`залп из ${seq.length} нажатий одним куском доехал целиком`)
        : bad('залп нажатий', `получено ${got.join(',')}, ожидалось ${seq.join(',')}`);

    // Очередь обязана чиститься на keysRelease(): нажатия, сделанные во время
    // рестарта или перед вопросом, не должны потом отработать как команды меню.
    fake.write('\x1b[B\x1b[B');
    await L.sleep(100);
    M.keysRelease();
    M.KEYQ.length === 0 ? ok('keysRelease чистит очередь — нажатия во время операции не выстрелят')
        : bad('keysRelease', `в очереди осталось ${M.KEYQ.length} нажатий`);

    // Слушатель после release снят: иначе дочерний процесс со stdio inherit делил бы
    // ввод с хабом (и Ctrl+C не прерывал бы его).
    fake.listenerCount('keypress') === 0 ? ok('после release слушатель ввода снят')
        : bad('release слушателя', `на потоке осталось ${fake.listenerCount('keypress')} слушателей`);
}

// ── 13. Анимация шапки: проявление, капель, фокус ─────────────────────────────
// Отдельная сессия pty, потому что предыдущая идёт с HUB_NO_DRIP=1. Здесь наоборот:
// капель должна капать сама, а при потере фокуса — замолчать полностью.
async function headerAnim() {
    let pty;
    try { pty = require('node-pty'); } catch (e) {
        console.log(`  \x1b[33m·\x1b[0m анимация пропущена: node-pty недоступен (${e.message.slice(0, 60)})`);
        return;
    }
    const term = pty.spawn(process.execPath, [path.join(ROOT, 'hub.js')], {
        cwd: ROOT, cols: 113, rows: 36, env: { ...process.env, HUB_NO_WT: '1' },
    });
    let buf = '';
    term.onData(d => { buf += d; });
    const kill = () => { try { term.kill(); } catch { /* уже мёртв */ } };

    const gotMenu = await (async () => {
        for (let i = 0; i < 120; i++) { if (/Выход/.test(buf)) return true; await L.sleep(100); }
        return false;
    })();
    if (!gotMenu) { bad('анимация: меню поднялось', 'за 12 с не дождались'); kill(); return; }

    // Знак доллара — глиф из internal/hub-dollar.txt, 5×6, справа от картинки. Ищем все
    // его непустые строки: одна распознаваемая строка ничего не доказывает, знак мелкий.
    const dollar = read('internal/hub-dollar.txt').replace(/\r/g, '').split('\n')
        .filter(l => l.length && /[⠁-⣿]/.test(l));
    dollar.length && dollar.every(l => buf.includes(l)) ? ok(`знак доллара нарисован в шапке (${dollar.length} строк)`)
        : bad('знак доллара', 'строк знака в выводе нет');

    // Капель идёт сама, без единого нажатия, и зелёная. Тем же таймером бежит волна
    // света по цифрам суммы, поэтому поток тут больше, чем у одной капели.
    let mark = buf.length;
    await L.sleep(2500);
    const anim = buf.slice(mark);
    const grow = anim.length;
    grow > 200 ? ok(`капель и мерцание идут сами (${(grow / 2.5 / 1024).toFixed(1)} КБ/с)`)
        : bad('капель идёт сама', `за 2.5 с прилетело ${grow} байт — анимация стоит`);
    /38;5;46/.test(buf) ? ok('капли зелёные, ярче картинки') : bad('цвет капель', 'зелёного 38;5;46 в выводе нет');
    grow < 20000 ? ok('поток анимации скромный') : bad('поток анимации', `${grow} байт за 2.5 с — это перерисовка кадрами, а не ячейками`);

    // Волна по сумме: ищем её белое ядро. Одного попадания мало — волна обязана бежать,
    // а не мигнуть один раз, поэтому считаем кадры за окно замера.
    const shine = (anim.match(/38;5;231/g) || []).length;
    shine >= 4 ? ok(`волна света бежит по сумме (${shine} кадров за 2.5 с)`)
        : bad('мерцание суммы', `ядро 38;5;231 встретилось ${shine} раз — волна стоит`);
    // 🪤 Стирание строки в этих кадрах = съеденный знак доллара: он стоит на тех же
    // строках левее цифр. Мерцание обязано печатать поверх, а не стирать.
    !/\x1b\[[0-2]?K/.test(anim) ? ok('мерцание печатает поверх, строк не стирает')
        : bad('мерцание стирает строку', 'в кадрах анимации есть ESC[K — знак доллара под угрозой');

    // Потеря фокуса обязана снимать таймер НАСОВСЕМ: не «реже», а ноль байт.
    term.write('\x1b[O');
    await L.sleep(700);
    mark = buf.length;
    await L.sleep(1500);
    const bgGrow = buf.length - mark;
    bgGrow === 0 ? ok('в фоне не отправлено ни байта — таймер снят')
        : bad('в фоне капель молчит', `прилетело ${bgGrow} байт за 1.5 с`);

    term.write('\x1b[I');
    await L.sleep(1200);
    buf.length - mark > bgGrow ? ok('фокус вернулся — капель ожила') : bad('возврат фокуса', 'после ESC[I ничего не приехало');

    // Курсор после капели вернулся на место: иначе стрелка перепишет не ту строку.
    mark = buf.length;
    term.write('\x1b[B');
    await L.sleep(400);
    /❯/.test(buf.slice(mark)) ? ok('стрелка работает поверх капели — курсор возвращается')
        : bad('курсор после капели', 'стрелка не перерисовала строку пункта');

    // И события фокуса не должны читаться как нажатия: до 25.08 их вообще не было в
    // потоке, а теперь есть — если readKey отдаст их как клавишу, меню запустит пункт.
    !/гашу |поднимаю |Обновление|Отчёт собран/.test(buf) ? ok('события фокуса не сработали как нажатие')
        : bad('события фокуса', 'меню выполнило пункт от ESC[I/ESC[O');

    const exited = new Promise(resolve => term.onExit(({ exitCode }) => resolve(exitCode)));
    term.write('q');
    const code = await Promise.race([exited, L.sleep(6000).then(() => 'таймаут')]);
    code === 0 ? ok('выход из меню с капелью — чистый') : (bad('выход с капелью', `получили ${code}`), kill());
}

(async () => {
    console.log('\x1b[1m\n8. Механика на подставном порту (живой стек не трогаем)\x1b[0m');
    await mechanics();
    console.log('\x1b[1m\n9. Отказ в правах отвечает сразу\x1b[0m');
    await denialIsInstant();
    console.log('\x1b[1m\n10. Три свойства запуска на Windows: окно, выживание, консоль\x1b[0m');
    await windowsSpawnProps();
    console.log('\x1b[1m\n11. Меню в настоящем терминале (node-pty)\x1b[0m');
    await tui();
    console.log('\x1b[1m\n12. Готовность к macOS (статически)\x1b[0m');
    macReady();
    console.log('\x1b[1m\n13. Анимация шапки: проявление, капель, фокус\x1b[0m');
    await headerAnim();
    console.log('\x1b[1m\n14. Пачка нажатий не теряется\x1b[0m');
    await keyBurst();
    console.log(`\n\x1b[1mИтого: ${pass} проверок пройдено, ${fails.length} провалено\x1b[0m`);
    if (fails.length) {
        for (const f of fails) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
        process.exit(1);
    }
    process.exit(0);
})();
