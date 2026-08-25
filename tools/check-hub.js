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
    const art = H.art();
    if (lines.length !== art.length) return `строк ${lines.length}, а картинка ${art.length} — панель добавила свои`;
    const tooWide = lines.filter(l => [...l.replace(/\x1b\[[0-9;]*m/g, '')].length > 113);
    if (tooWide.length) return `${tooWide.length} строк шире окна — картинка перенесётся и развалится`;
    if (!/ЗАПАС/.test(out)) return 'панели запаса нет вообще';
    return true;
});

t('дефолтный набор вкладок дашборда — как на рабочей установке', () => {
    const src = read('routing/proxy-dashboard.html');
    const m = src.match(/const DEFAULT_TABS_VISIBLE = \[([^\]]+)\]/);
    if (!m) return 'DEFAULT_TABS_VISIBLE не найден';
    const tabs = m[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
    const want = ['fin', 'github', 'agentrouter', 'gorouter', 'justwoker', 'tabi', 'custom', 'plugins', 'health', 'settings'];
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
        cwd: ROOT, cols: 113, rows: 36, env: { ...process.env, HUB_NO_DRIP: '1' },
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

    // Последний известный запас — в шапке справа от картинки, полублочным шрифтом
    // (вариант владельца от 25.08). Проверяем и подпись, и сами цифры.
    /ПОСЛЕДНИЙ ИЗВЕСТНЫЙ ЗАПАС/.test(buf) ? ok('в шапке есть последний известный запас') : bad('запас в шапке', 'подписи панели нет');
    /опрошено/.test(buf) ? ok('у суммы стоит время опроса') : bad('время опроса', 'нет отметки «опрошено»');
    /[▀▄]/.test(buf) ? ok('сумма набрана полублочным шрифтом') : bad('шрифт суммы', 'полублочных глифов ▀▄ в выводе нет');

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

// ── 13. Анимация шапки: проявление, капель, фокус ─────────────────────────────
// Отдельная сессия pty, потому что предыдущая идёт с HUB_NO_DRIP=1. Здесь наоборот:
// капель должна капать сама, а при потере фокуса — замолчать полностью.
async function headerAnim() {
    let pty;
    try { pty = require('node-pty'); } catch (e) {
        console.log(`  \x1b[33m·\x1b[0m анимация пропущена: node-pty недоступен (${e.message.slice(0, 60)})`);
        return;
    }
    const term = pty.spawn(process.execPath, [path.join(ROOT, 'hub.js')], { cwd: ROOT, cols: 113, rows: 36, env: process.env });
    let buf = '';
    term.onData(d => { buf += d; });
    const kill = () => { try { term.kill(); } catch { /* уже мёртв */ } };

    const gotMenu = await (async () => {
        for (let i = 0; i < 120; i++) { if (/Выход/.test(buf)) return true; await L.sleep(100); }
        return false;
    })();
    if (!gotMenu) { bad('анимация: меню поднялось', 'за 12 с не дождались'); kill(); return; }

    // Доллар — тем же полублочным шрифтом и ПОСЛЕ числа (пометка владельца 25.08).
    /██▀▀/.test(buf) && /▄█▄█/.test(buf) ? ok('знак доллара нарисован шрифтом суммы')
        : bad('знак доллара', 'глифа $ в выводе нет');

    // Капель идёт сама, без единого нажатия, и зелёная.
    let mark = buf.length;
    await L.sleep(2000);
    const grow = buf.length - mark;
    grow > 200 ? ok(`капель идёт сама (${(grow / 2 / 1024).toFixed(1)} КБ/с)`)
        : bad('капель идёт сама', `за 2 с прилетело ${grow} байт — анимация стоит`);
    /38;5;46/.test(buf) ? ok('капли зелёные, ярче картинки') : bad('цвет капель', 'зелёного 38;5;46 в выводе нет');
    grow < 12000 ? ok('поток капели скромный') : bad('поток капели', `${grow} байт за 2 с — это перерисовка кадрами, а не ячейками`);

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
    console.log(`\n\x1b[1mИтого: ${pass} проверок пройдено, ${fails.length} провалено\x1b[0m`);
    if (fails.length) {
        for (const f of fails) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
        process.exit(1);
    }
    process.exit(0);
})();
