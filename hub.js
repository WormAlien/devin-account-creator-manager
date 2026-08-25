#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  hub.js — одна точка входа: запустить, остановить, обновить, посмотреть.
//
//  Было до 24.08: на Windows пять конкурирующих скриптов запуска разного возраста
//  (START.bat гасил 2 порта из 8 и не поднимал :20130/:20131 вообще), остановки не
//  было ВООБЩЕ, а у мака не было двойного клика ни на стоп, ни на обновление.
//  Список портов жил в пяти копиях и разъехался. Теперь механика одна —
//  routing/lifecycle.js, — а это её лицо.
//
//  Двойной клик: HUB.bat (Windows) / HUB.command (mac).
//  Из терминала:  node hub.js                 — меню
//                 node hub.js start|stop|restart|update|status|doctor
//
//  Кириллица в консоли Windows работает без chcp: node в TTY пишет через
//  WriteConsoleW, кодовая страница на это не влияет. Поэтому в HUB.bat нет ни
//  одной русской буквы и ни одного chcp — весь текст печатает отсюда node.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const L = require('./routing/lifecycle');

const TTY = !!process.stdout.isTTY && !process.env.HUB_PLAIN;
const W = () => Math.max(52, Math.min(process.stdout.columns || 80, 100));

// ── ANSI ─────────────────────────────────────────────────────────────────────
// В не-TTY (кнопка перезапуска в дашборде, перенаправление в файл, CI) все
// украшения обязаны исчезнуть: иначе в логе оказывается каша из escape-кодов, а
// «пришли скриншот окна» превращается в «пришли скриншот мусора».
const e = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = s => e(1, s);
const dim = s => e(2, s);
const red = s => e(91, s);
const green = s => e(92, s);
const yellow = s => e(93, s);
const cyan = s => e(96, s);
const grey = s => e(90, s);

const out = s => process.stdout.write(s);
const line = (s = '') => out(s + '\n');
const clearScreen = () => TTY && out('\x1b[2J\x1b[H');
const hideCursor = () => TTY && out('\x1b[?25l');
const showCursor = () => TTY && out('\x1b[?25h');
const up = n => TTY && out(`\x1b[${n}A`);
const eraseLine = () => TTY && out('\x1b[2K\r');
const sleep = L.sleep;

// ── Шапка ────────────────────────────────────────────────────────────────────
// Только картинка. Вордмарк «ABUSE HUB» из блочных символов снят 25.08 по просьбе
// владельца — он его перебрал в трёх вариантах и ни один не понравился («уберём вот
// это»). Название и так стоит в заголовке окна (`title ABUSE HUB` в HUB.bat), рисовать
// его второй раз незачем.
const ART_FILE = path.join(__dirname, 'internal', 'hub-art.txt');
const WISPR_ART_FILE = path.join(__dirname, 'internal', 'wispr-art.txt');

function readArt(file) {
    try {
        return fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
    } catch {
        return [];
    }
}
const art = () => readArt(ART_FILE);

// Гиперссылка терминала (OSC 8). Windows Terminal её понимает и делает адрес
// кликабельным; в старом conhost и в не-TTY остаётся обычный текст.
function link(url, text = url) {
    return TTY ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

// Крупные цифры для суммы в шапке. Только цифры и пробел: буквы в блочном шрифте я
// уже трижды рисовал неправильно, а цифры однозначны сами по себе.
const DIGITS = {
    0: ['███', '█ █', '█ █', '█ █', '███'], 1: ['  █', '  █', '  █', '  █', '  █'],
    2: ['███', '  █', '███', '█  ', '███'], 3: ['███', '  █', '███', '  █', '███'],
    4: ['█ █', '█ █', '███', '  █', '  █'], 5: ['███', '█  ', '███', '  █', '███'],
    6: ['███', '█  ', '███', '█ █', '███'], 7: ['███', '  █', '  █', '  █', '  █'],
    8: ['███', '█ █', '███', '█ █', '███'], 9: ['███', '█ █', '███', '  █', '███'],
    ' ': ['  ', '  ', '  ', '  ', '  '],
};

function bigNum(text) {
    const rows = ['', '', '', '', ''];
    for (const ch of String(text)) {
        const g = DIGITS[ch];
        if (!g) continue;
        for (let r = 0; r < 5; r++) rows[r] += g[r] + ' ';
    }
    return rows;
}

// Правая колонка шапки: последний ИЗВЕСТНЫЙ запас пулов. Читается с диска, поэтому
// цифра есть и когда дашборд лежит — как раз тогда её больше негде посмотреть.
// Отсюда и подпись «последний известный», а не «баланс»: это кэш опроса.
function balancePanel() {
    let b;
    try { b = require('./internal/hub-balance').balance(); } catch { return []; }
    if (!b.keys) return [];

    // Разряды не разделяем: пробел любого вида в блочном шрифте читается как разрыв числа.
    const whole = String(Math.round(b.available));
    const when = b.checkedAt ? new Date(b.checkedAt).toLocaleString('sv').slice(11, 16) : '—';
    const money = n => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n)));
    const pools = b.pools.filter(p => p.keys).map(p => `${p.id.toUpperCase()} ${money(p.available)}`).join(' · ');

    // Ровно 9 строк — по высоте картинки, и каждая укладывается в ~34 символа: рядом
    // с 65-символьным артом на окне в 113 колонок больше не влезает, а перенос строки
    // разорвал бы картинку пополам.
    return [
        dim('ПОСЛЕДНИЙ ИЗВЕСТНЫЙ ЗАПАС'),
        '',
        ...bigNum(whole).map(l => green(l)),
        `${bold('$' + b.available.toFixed(2))}${dim('  опрошено ' + when)}`,
        dim(pools),
    ];
}

// ── Раскладка ────────────────────────────────────────────────────────────────
// На экране: КАРТИНКА сверху → состояние → меню → подсказка. Всё.
//
// 🪤 История трёх выброшенных вариантов надписи «ABUSE HUB» — в ARCHITECTURE.md.
// Короткий вывод: я трижды решал за владельца, как должен выглядеть его инструмент,
// и трижды был неправ. Больше блочных надписей тут нет.
function layout() {
    const A = art();
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    const artW = A.length ? Math.max(...A.map(l => [...l].length)) : 0;
    const artOk = A.length > 0 && cols >= artW + 4;

    const items = menuItems().length;
    // Строк в кадре: картинка + (отступ + дашборд + прочее + права) + пункты + подсказка.
    const total = (withArt, compact) =>
        (withArt ? A.length : 0)
        + (compact ? 3 : 4)
        + (compact ? items + 1 : items + 2);

    for (const [withArt, compact] of [[artOk, false], [artOk, true], [false, false], [false, true]]) {
        if (total(withArt, compact) <= rows) return { art: A, withArt, compact };
    }
    return { art: A, withArt: false, compact: true };
}

function artFits(lines) {
    if (!lines.length) return false;
    const w = Math.max(...lines.map(l => [...l].length));
    return (process.stdout.columns || 80) >= w + 4;
}

// Шапка: картинка проявляется построчно сверху вниз, ~200 мс. В не-TTY один плоский кадр.
async function intro() {
    const pad = '  ';
    const { art: A, withArt } = layout();
    if (!withArt) return;

    const artW = Math.max(...A.map(l => [...l].length));
    // Ширину берём НАСТОЯЩУЮ, а не через W(): тот режет до 100 колонок для читаемости
    // текста, и панель на окне в 113 колонок из-за этого не помещалась ни разу.
    const cols = process.stdout.columns || 80;
    const panel = cols >= artW + 3 + 34 ? balancePanel() : [];
    const composed = A.map((l, i) => pad + (TTY ? cyan(l) : l) + (panel[i] ? '   ' + panel[i] : ''));

    if (!TTY) {
        for (const l of composed) line(l);
        return;
    }
    // Проявление — только по картинке: панель появляется в финальном проходе, иначе
    // цифра мигала бы вместе с ней и читалась как «баланс скачет».
    for (const l of A) { line(pad + grey(l)); await sleep(20); }
    up(A.length);
    for (const l of composed) { eraseLine(); line(l); }
}

// ── Строка с крутилкой ───────────────────────────────────────────────────────
// Одна активная строка: пока операция идёт — крутится, по завершении затирается и
// печатается итог. В не-TTY крутилки нет, только итог: иначе в логе остаётся сотня
// строк с кадрами анимации.
const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

class Spin {
    constructor(label) {
        this.label = label;
        this.i = 0;
        this.timer = null;
        if (!TTY) return;
        this.timer = setInterval(() => {
            eraseLine();
            out(`  ${cyan(FRAMES[this.i++ % FRAMES.length])} ${this.label}`);
        }, 80);
    }
    done(mark, text) {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        eraseLine();
        line(`  ${mark} ${text}`);
    }
}
const OK = () => green('✓');
const NO = () => red('✗');
const SKIP = () => grey('·');

// ── Табло состояния ──────────────────────────────────────────────────────────
// Один снимок портов на всю отрисовку. Дети дашборда идут отдельной строкой и
// НЕ красным, когда лежат: keepalive неактивного провайдера лежит штатно, и
// пугать им человека — врать (ровно так читалось «половина стека мёртвая»).
// ── Состояние ────────────────────────────────────────────────────────────────
// Отдельной строкой — только дашборд, и его адрес сделан КЛИКАБЕЛЬНЫМ (OSC 8):
// это единственное, что человек в этом списке открывает. Остальные пять сервисов
// раньше занимали по строке каждый, хотя смотреть в них нечего, пока они живы —
// владелец 25.08: «не нравится, что вот это написано, пусть оно в детях лежит».
// Теперь они лежат в общей строке вместе с детьми дашборда.
//
// 🪤 Сворачивать можно только ЖИВЫХ. Лежащий сервис обязан быть назван — иначе
// «поднято 4 из 6» превращается в загадку, какие именно четыре.
function statusBlock({ compact = false } = {}) {
    const rows = L.status();
    const dash = rows.find(r => r.port === 8200) || { name: 'Дашборд', port: 8200, up: false, pids: [] };
    const rest = rows.filter(r => r !== dash);
    if (!compact) line();

    const url = 'http://localhost:8200/__switch';
    line(`  ${bold('Дашборд')}  ${dash.up ? green('● живой') : red('○ лежит')}` +
        (dash.up ? dim(`  pid ${dash.pids.join(',')}  `) + link(url, cyan(url)) : dim('  ' + url)));

    const alive = rest.filter(r => r.up);
    const downSvc = rest.filter(r => !r.up && r.role === 'service');
    const names = alive.map(r => r.name.replace(' keepalive', '')).join(' · ') || 'никого';
    const room = Math.max(20, W() - (compact ? 34 : 24));
    line(`  ${dim('живы:')} ${alive.length ? green('●') + ' ' : ''}` +
        (names.length > room ? names.slice(0, room - 1) + '…' : names) +
        dim(`  ${alive.length}/${rest.length}`) +
        (downSvc.length ? '  ' + red('лежат: ' + downSvc.map(r => `${r.name} :${r.port}`).join(', ')) : ''));

    // Права видны ДО того, как что-то нажато. Элевированный хаб — не благо: его дети
    // тоже станут элевированными, и следующий обычный запуск их уже не убьёт. Поэтому
    // жёлтым помечен именно режим администратора, а обычный — норма. Путь к папке рядом:
    // знать, из какой копии репо поднят стек, нужно — у владельца есть старое зеркало.
    const rights = L.IS_WIN
        ? (L.isElevated() ? `${dim('права:')} ${yellow('администратор')}` : dim('права: обычные'))
        : dim('папка:');
    line(`  ${rights}${dim(' · ' + L.ROOT)}`);
    return dash.up;
}

// ── Отчёт по событиям lifecycle ──────────────────────────────────────────────
function reporter() {
    let cur = null;
    return ev => {
        switch (ev.type) {
            case 'kill-begin':
                cur = new Spin(`гашу ${ev.name} ${dim(':' + ev.port)}`);
                break;
            case 'kill-done':
                if (!ev.was.length) cur.done(SKIP(), grey(`${ev.name} :${ev.port} — и не был поднят`));
                else if (ev.freed) cur.done(OK(), `${ev.name} ${dim(':' + ev.port)} остановлен ${dim('(pid ' + ev.was.join(',') + ')')}`);
                else if (ev.denied) cur.done(NO(), red(`${ev.name} :${ev.port} — нет прав убить pid ${(ev.holding || ev.was).join(',')}`));
                else cur.done(NO(), red(`${ev.name} :${ev.port} НЕ освободился`) + dim(` — держит pid ${(ev.holding || []).join(',')}`));
                cur = null;
                break;
            case 'abort':
                line(`  ${dim('дальше не иду: остальные порты держит тот же администратор')}`);
                break;
            case 'start-skip':
                line(`  ${SKIP()} ${grey(`${ev.name} :${ev.port} — уже поднят, не трогаю`)}`);
                break;
            case 'start-foreign':
                line(`  ${NO()} ${red(`${ev.name} :${ev.port} занят ЧУЖИМ процессом`)} ${dim('— ' + ev.who)}`);
                line(`     ${dim('это не наш сервис: поднять на этом порту нечего, пока порт не освободить')}`);
                break;
            case 'start-begin':
                cur = new Spin(`поднимаю ${ev.name} ${dim(':' + ev.port)}`);
                break;
            case 'start-done':
                cur.done(OK(), `${ev.name} ${dim(':' + ev.port)} поднят ${dim('(pid ' + ev.pid + ')')}`);
                cur = null;
                break;
            case 'error':
                if (cur) { cur.done(NO(), red(`${ev.name} :${ev.port} — ${ev.text}`)); cur = null; }
                else line(`  ${NO()} ${red(ev.text)}`);
                break;
            case 'note':
                line(`  ${yellow('!')} ${ev.text}`);
                break;
        }
    };
}

// Перезапустить себя с правами администратора. Нужно ровно в одном случае: старый
// процесс поднят элевированным (так делал restart-dashboard.bat до 24.08, он просил
// UAC на каждом запуске), и обычный taskkill его не берёт.
//
// Открываем в Windows Terminal, а не напрямую node: элевированный процесс, запущенный
// через Start-Process, получает СВОЁ окно, и это старый conhost — серый, с другим
// шрифтом и без темы (владелец 25.08: «серый интерфейс, некрасивый, а в терминале
// Windows всё чёрное, красивое»). `wt.exe` уносит окно в нормальный терминал с
// профилем по умолчанию. Нет wt (Windows 10 без него) — падаем на прямой запуск.
function relaunchElevated(argv) {
    if (!L.IS_WIN) return false;
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const hubArgs = [__filename, ...argv];

    const wt = [
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe'),
    ].find(p => p && fs.existsSync(p));

    // `-w -1` — новое окно, а не вкладка в уже открытом (иначе элевированная вкладка
    // подсядет к обычному окну, чего Windows Terminal не разрешает).
    const cmd = wt
        ? `Start-Process -FilePath ${q(wt)} -ArgumentList '-w','-1','new-tab','--title','ABUSE HUB (админ)',`
          + `${q(process.execPath)},${hubArgs.map(q).join(',')} -Verb RunAs`
        : `Start-Process -FilePath ${q(process.execPath)} -ArgumentList ${hubArgs.map(q).join(',')} `
          + `-Verb RunAs -WorkingDirectory ${q(L.ROOT)}`;

    const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore', windowsHide: true });
    return r.status === 0;
}

// ── Мелочи платформы ─────────────────────────────────────────────────────────
function openBrowser(url) {
    try {
        if (L.IS_WIN) spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true });
        else if (process.platform === 'darwin') spawnSync('open', [url]);
        else spawnSync('xdg-open', [url], { stdio: 'ignore' });
    } catch { /* нет браузера — не повод падать */ }
}

// git-bash на Windows ищем сами, а не через `where bash`: там первым найдётся bash
// из WSL, и установщик поедет внутри линуксовой подсистемы — с чужим PATH, чужим
// node и без доступа к Git Credential Manager. Порядок кандидатов тот же, что в
// UPDATE.bat/DOCTOR.bat, чтобы поведение двойного клика и хаба совпадало.
function findBash() {
    if (!L.IS_WIN) return '/bin/bash';
    const c = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\bin\\bash.exe'),
    ];
    return c.find(p => p && fs.existsSync(p)) || null;
}

// Хвост лога ТОГО сервиса, который не поднялся. По файлу на сервис — иначе причина
// тонула в общей мешанине, а на Windows её вообще не было: cmd-редирект не может
// открыть лог, который держат живые процессы стека, и старт падал молча.
function failTail(res) {
    const log = (res && res.log) || '';
    line();
    line(`  ${red('Старт не удался.')}${log ? ' Хвост ' + dim(path.relative(L.ROOT, log)) + ':' : ''}`);
    line();
    for (const l of String((res && res.tail) || '').split('\n')) line('    ' + dim(l));
    if (log) { line(); line(`  ${dim('полный лог: ')}${log}`); }
}

function stuckHint(res) {
    if (!res.denied) return;
    line();
    line(`  ${yellow('Порт держит процесс, которого нам не хватает прав убить — ждать нечего,')}`);
    line(`  ${yellow('поэтому остановился сразу, а не через минуту таймаутов.')}`);
    line(`  ${dim('Так бывает, если стек поднимали старым restart-dashboard.bat: он просил UAC,')}`);
    line(`  ${dim('и его дети остались элевированными. Лечится одним разом:')}`);
    line(`  ${bold('пункт «Перезапустить хаб с правами админа»')} ${dim('в меню (клавиша a)')}`);
    if (L.IS_WIN && L.isElevated()) {
        line(`  ${dim('…хотя мы УЖЕ администратор — значит порт держит служба или процесс SYSTEM.')}`);
        line(`  ${dim('Смотреть кто: ')}tasklist /fi "pid eq <PID>"`);
    }
}

// ── Операции ─────────────────────────────────────────────────────────────────
async function doStart({ open = true } = {}) {
    line();
    line(bold('  Запуск'));
    return finishStart(await L.start({ on: reporter() }), open);
}

// Разбор результата старта — общий для «Запустить» и «Перезапустить»: раньше второй
// звал первого целиком, и заголовок «Запуск» печатался внутри перезапуска.
function finishStart(r, open) {
    // Чужой процесс на нашем порту — не падение старта, а другая беда: хвост лога тут
    // ни при чём, и печатать его значило бы уводить в сторону.
    if (r.foreign && r.foreign.length) {
        line();
        line(`  ${red('Порты заняты посторонними процессами:')}`);
        for (const f of r.foreign) line(`    :${f.port} ${f.name} — ${f.who}`);
        line(`  ${dim('это не наш стек. Освободи порт (или смени его в конфиге) и запусти снова;')}`);
        line(`  ${dim('«Остановить» тут не поможет — хаб гасит только своё.')}`);
        return false;
    }
    if (!r.ok) { failTail(r); return false; }
    if (!r.started || !r.started.length) line(`  ${grey('всё уже было поднято — ничего не делал')}`);
    line();
    line(`  Дашборд: ${cyan('http://localhost:8200/__switch')}`);
    if (open && r.started && r.started.length) openBrowser('http://localhost:8200/__switch');
    return true;
}

// Остановка гасит и front-door, и keepalive провайдеров. Для Claude Code это
// означает отсутствие бэкенда вообще — предупреждаем ЗАРАНЕЕ, а не постфактум:
// «дашборд остановлен» и «агент отвалился» связаны, и связь неочевидна.
async function doStop({ ask = false } = {}) {
    line();
    line(bold('  Остановка'));
    line(`  ${dim('гашу всё, включая front-door — Claude Code останется без бэкенда')}`);

    // Спрашиваем только в меню: «3» нажимается рядом с «2», а последствие — все живые
    // сессии агента остаются без бэкенда до следующего запуска. У перезапуска
    // подтверждения нет намеренно: это частое и ожидаемое действие.
    if (ask && !(await confirm('Точно остановить весь стек?', false))) {
        line(`  ${dim('передумал — ничего не тронул')}`);
        return true;
    }
    const r = await L.stop({ phase: 'stop', on: reporter() });
    stuckHint(r);
    line();
    line(r.stuck.length ? `  ${red('осталось занятых портов: ' + r.stuck.length)}` : `  ${green('всё остановлено')}`);
    return !r.stuck.length;
}

async function doRestart({ open = true } = {}) {
    line();
    line(bold('  Перезапуск'));
    line(`  ${dim('keepalive неактивных провайдеров не трогаю — их дашборд разберёт сам на boot')}`);

    // Последовательность живёт в lifecycle.restart(), а не здесь: две копии порядка
    // «что гасим и что поднимаем» — это ровно та болезнь, из-за которой всё
    // переписывалось. Хаб добавляет только текст.
    const r = await L.restart({ on: reporter() });

    if (r.stage === 'stop') {
        stuckHint(r);
        line();
        line(`  ${red('не стал поднимать: порты не освободились')} ${dim('(EADDRINUSE был бы хуже)')}`);
        return false;
    }
    return finishStart(r, open);
}

// Полный отчёт для ОТПРАВКИ, а не для чтения глазами: 168 строк про venv, PATH,
// версии, бэкенд и куки. Понять по нему состояние нельзя — для этого «Проверка».
// Поэтому пункт и называется по своему назначению, и говорит, куда лёг файл.
async function doDoctor() {
    const bash = findBash();
    if (!bash) {
        line(`  ${NO()} ${red('git-bash не найден — отчёт собирает shell-скрипт tools/doctor.sh')}`);
        line(`  ${dim('поставь Git for Windows: winget install Git.Git')}`);
        return false;
    }
    line();
    line(bold('  Отчёт для отправки') + dim(' — ничего не меняет'));
    line(`  ${dim('собирает окружение целиком: версии, PATH, venv, порты, бэкенд, git.')}`);
    line(`  ${dim('это то, что нужно прислать, когда «не работает, а почему — непонятно».')}`);
    line();
    const r = spawnSync(bash, [path.join('tools', 'doctor.sh')], { cwd: L.ROOT, stdio: 'inherit' });
    line();
    line(`  ${dim('файл: ')}${path.join(L.ROOT, 'logs', 'doctor-report.txt')}`);
    return r.status === 0;
}

// Отдать свою версию репы обратно веткой и PR. Раньше это был SHARE.bat в корне —
// один из девяти файлов-запускалок, ради которых и затевалась уборка 24.08.
async function doShare() {
    const bash = findBash();
    if (!bash) {
        line(`  ${NO()} ${red('git-bash не найден — tools/share.sh это shell-скрипт')}`);
        return false;
    }
    line();
    line(bold('  Поделиться своей версией') + dim(' (ветка + Pull Request)'));
    const r = spawnSync(bash, [path.join('tools', 'share.sh')], { cwd: L.ROOT, stdio: 'inherit' });
    return r.status === 0;
}

// ── Проверка ─────────────────────────────────────────────────────────────────
// Отвечает на «всё ли в порядке» списком вердиктов, а не дампом. Это НЕ то же, что
// tools/doctor.sh: тот собирает 168-строчный отчёт для отправки в переписку, и по
// нему невозможно понять состояние глазами — на что владелец и жаловался 25.08.
// Здесь только то, что реально ломалось, и каждая строка сразу говорит «чинить или нет».
async function doCheck() {
    line();
    line(bold('  Проверка') + dim(' — ничего не меняет, только смотрит'));
    line();

    const V = { ok: 0, warn: 0, bad: 0 };
    const good = (what, note = '') => { V.ok++; line(`  ${OK()} ${what}${note ? dim('  ' + note) : ''}`); };
    const warn = (what, note = '') => { V.warn++; line(`  ${yellow('!')} ${what}${note ? dim('  ' + note) : ''}`); };
    const fail = (what, note = '') => { V.bad++; line(`  ${NO()} ${red(what)}${note ? dim('  ' + note) : ''}`); };

    // 1. Node. Ниже 18 не поедет ничего: в коде есть top-level await и fetch.
    const major = Number(process.versions.node.split('.')[0]);
    major >= 18 ? good(`node ${process.versions.node}`) : fail(`node ${process.versions.node} — нужен 18+`);

    // 2. Зависимости. Отсутствие playwright — самая частая причина «автореги не работают».
    const dep = n => fs.existsSync(path.join(L.ROOT, 'node_modules', n));
    if (!fs.existsSync(path.join(L.ROOT, 'node_modules'))) fail('node_modules нет', 'лечится пунктом «Обновить»');
    else {
        const missing = ['playwright', 'node-pty', 'telegraf'].filter(n => !dep(n));
        missing.length ? warn(`нет пакетов: ${missing.join(', ')}`, 'пункт «Обновить» доставит')
            : good('зависимости на месте');
    }

    // 3. git-bash: без него не работают ни установщик, ни отчёт для отправки.
    if (L.IS_WIN) {
        findBash() ? good('git-bash найден') : warn('git-bash не найден', 'обновление и отчёт работать не будут');
    }

    // 4. Сервисы.
    const rows = L.status();
    const svc = rows.filter(r => r.role === 'service');
    const down = svc.filter(r => !r.up);
    down.length === 0 ? good(`все сервисы подняты (${svc.length})`)
        : warn(`лежит ${down.length} из ${svc.length}: ${down.map(r => r.name + ' :' + r.port).join(', ')}`, 'пункт «Запустить»');

    // 5. Куда реально смотрит Claude Code. Рассогласование здесь — это «агент получает
    // 502 на каждый запрос», и по портам его не видно: front-door жив, а адрес чужой.
    let base = '';
    try {
        base = (JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {}).ANTHROPIC_BASE_URL || '';
    } catch { /* нет файла */ }
    const fdPort = L.frontdoorPort();
    const fdUp = rows.some(r => r.port === fdPort && r.up);
    if (!base) warn('в ~/.claude/settings.json нет ANTHROPIC_BASE_URL', 'Claude Code пойдёт в официальный API');
    else if (new RegExp(`:${fdPort}(/|$)`).test(base)) {
        fdUp ? good(`Claude Code смотрит в front-door :${fdPort}`, 'и он поднят')
            : fail(`Claude Code смотрит в front-door :${fdPort}, а он ЛЕЖИТ`, 'каждый запрос агента = отказ');
    } else {
        const m = base.match(/:(\d+)/);
        const p = m ? Number(m[1]) : 0;
        const up = rows.some(r => r.port === p && r.up);
        up ? good(`Claude Code смотрит в :${p} напрямую`, 'front-door в обход')
            : warn(`Claude Code смотрит в ${base}`, up ? '' : 'на этом порту никто не слушает');
    }

    // 6. Та ли это папка. У владельца есть устаревшее зеркало репо на другом диске, и
    // «правлю код, ничего не меняется» ровно про это: стек поднят из другой копии.
    try {
        const ptr = fs.readFileSync(path.join(os.homedir(), '.claude', 'autoreger-root.txt'), 'utf8').trim();
        const same = path.resolve(ptr) === path.resolve(L.ROOT);
        same ? good('указатель статус-лайна показывает на эту папку')
            : warn('стек последний раз поднимали из ДРУГОЙ папки', ptr);
    } catch {
        warn('указателя ~/.claude/autoreger-root.txt нет', 'появится при первом запуске');
    }

    // 7. Логи должны быть записываемы, иначе старт падает молча (уже ловили).
    try {
        fs.mkdirSync(L.LOG_DIR, { recursive: true });
        const probe = path.join(L.LOG_DIR, '.write-probe');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        good('logs/hub пишется');
    } catch (e) {
        fail(`в logs/hub не записать (${e.code})`, 'причину падения старта будет негде прочитать');
    }

    // 8. Права — справкой, не проблемой.
    if (L.IS_WIN) {
        L.isElevated() ? warn('хаб запущен администратором', 'дети унаследуют элевацию')
            : good('права обычные', 'так и надо');

        // 9. Фикс диктовки Orca. Не «всё ли поднято», а «работает ли то, что владелец
        // включил»: процесс сторожа умирает молча, и обнаруживается это тем, что
        // надиктованный текст перестал доезжать.
        try {
            const D = require('./internal/dictation-fix');
            const d = D.state();
            if (!d.pid && !d.installed && !d.startup && !d.task) good('фикс диктовки Orca не ставился', 'пункт [9]');
            else if (d.pid && d.startup && d.task) good('фикс диктовки Orca работает', `pid ${d.pid}`);
            else if (d.pid) warn('фикс диктовки работает, но не полностью', `автозагрузка ${d.startup ? 'есть' : 'нет'}, сторож ${d.task ? 'есть' : 'нет'}`);
            else fail('фикс диктовки установлен, но процесс мёртв', 'надиктованное будет теряться — пункт [9]');
        } catch { /* модуля нет — не повод падать проверке */ }
    }

    line();
    const verdict = V.bad ? red(`проблем: ${V.bad}`) : V.warn ? yellow(`замечаний: ${V.warn}`) : green('всё в порядке');
    line(`  ${verdict}${V.bad || V.warn ? dim(`  (в порядке: ${V.ok})`) : ''}`);
    if (V.bad || V.warn) line(`  ${dim('нужен полный отчёт для отправки — пункт «Отчёт для отправки»')}`);
    return V.bad === 0;
}

// ── Фикс диктовки Orca ───────────────────────────────────────────────────────
// Отдельный экран, а не галочка: у фикса четыре независимых признака (процесс,
// ярлык автозагрузки, задача планировщика, наличие AutoHotkey), и одно «вкл/выкл»
// их не описывает — непонятно, что именно сломано, когда диктовка снова теряется.
// Разбор устройства — internal/dictation-fix.js.
async function doDictationFix() {
    const D = require('./internal/dictation-fix');
    let sel = 0;

    for (;;) {
        clearScreen();
        const s = D.state();
        const mark = ok => (ok ? OK() : grey('○'));

        // Правая колонка — состояние. Четыре независимых признака, поэтому и экран, а
        // не галочка: «выключено» ничего не объясняет, когда диктовка снова теряется.
        const info = [
            bold('Фикс диктовки в терминалах Orca'),
            dim('Wispr кладёт текст в буфер и жмёт Ctrl+V, Orca отменяет вставку'),
            dim('панели, потерявшей фокус — с 1.4.185 молча. Фикс перехватывает'),
            dim('этот Ctrl+V и ПЕЧАТАЕТ текст: набор отменить нельзя.'),
            dim('Ручной Ctrl+V идёт мимо — у него Ctrl физически зажат.'),
            '',
            `${mark(!!s.ahk)} AutoHotkey v2${s.ahk ? '' : red('  нет: winget install AutoHotkey.AutoHotkey')}`,
            `${mark(s.pid > 0)} процесс${s.pid ? dim(`  pid ${s.pid}`) : grey('  не запущен')}`,
            `${mark(s.startup)} ярлык в автозагрузке`,
            `${mark(s.task)} сторож каждые 10 мин`,
            `${mark(s.installed)} копия под управлением хаба`,
        ];
        if (s.pid && !s.managed) {
            info.push('', yellow('запущен из другой папки:'), dim('  ' + (s.runningFrom || '?')),
                dim('«Установить» перенесёт на копию хаба'));
        }

        // Логотип слева, состояние справа: сам логотип 19 строк, и если ставить его
        // сверху, на окне в 30 строк для состояния уже не остаётся места.
        const A = readArt(WISPR_ART_FILE);
        const artW = A.length ? Math.max(...A.map(l => [...l].length)) : 0;
        const sideBySide = TTY && A.length && W() >= artW + 6 + 56;
        if (sideBySide) {
            for (let i = 0; i < Math.max(A.length, info.length); i++) {
                const l = A[i] ? cyan(A[i].padEnd(artW)) : ' '.repeat(artW);
                line(`  ${l}   ${info[i] || ''}`);
            }
        } else {
            for (const l of info) line('  ' + l);
        }

        if (s.logTail) { line(); line(`  ${dim('лог: ' + s.logTail.split('\n').pop())}`); }

        line();
        const acts = [
            { key: '1', label: 'Установить и включить', hint: 'скопировать, запустить, автозагрузка + сторож', act: 'install' },
            { key: '2', label: 'Выключить', hint: 'погасить по PID, снять ярлык и задачу; файлы оставить', act: 'disable' },
            { key: '3', label: 'Удалить полностью', hint: 'то же плюс удалить файлы рабочей папки', act: 'remove' },
            { key: 'q', label: 'Назад', hint: '', act: '' },
        ];
        for (const [i, a] of acts.entries()) line(itemLine(a, i === sel));
        line(dim('  ↑↓ выбрать · Enter · цифра — сразу · q назад'));

        const k = await readKey();
        const name = k.name || '';

        // Стрелки тут работают так же, как в главном меню: до 25.08 их не было вовсе,
        // и экран управлялся только цифрами — владелец: «нет управления на стрелочках
        // и кнопка Q не работает назад».
        if (name === 'up' || name === 'k') { sel = (sel - 1 + acts.length) % acts.length; continue; }
        if (name === 'down' || name === 'j') { sel = (sel + 1) % acts.length; continue; }
        if (name === 'q' || name === 'escape' || (name === 'c' && k.ctrl)) return true;

        let pick = null;
        if (name === 'return' || name === 'enter' || name === 'space') pick = acts[sel];
        else pick = acts.find(a => a.key === name);
        if (!pick) continue;
        if (!pick.act) return true;                      // «Назад» выбрано Enter'ом
        const act = pick.act;

        // Выключение и удаление трогают автозагрузку и планировщик — спрашиваем.
        if (act !== 'install' && !(await confirm(act === 'remove' ? 'Удалить фикс полностью?' : 'Выключить фикс?', false))) continue;

        line();
        const r = D[act]();
        for (const st of r.steps) line(`  ${st.ok ? OK() : NO()} ${st.what}${st.note ? dim('  ' + st.note) : ''}`);
        line();
        line(r.ok ? `  ${green('готово')}` : `  ${red('сделано не всё — смотри строки выше')}`);
        if (act === 'install' && r.ok) {
            line(`  ${dim('проверить живьём: надиктуй фразу в панель Orca, ничего не нажимая — текст должен приехать')}`);
        }
        await pause('Enter — вернуться к состоянию фикса');
    }
}

// ── Обновление ───────────────────────────────────────────────────────────────

// Две фазы, и это не украшение: pull может обновить сам hub.js, и продолжать в
// уже устаревшем процессе — тот самый случай «обновился, а поведение прежнее».
// Фаза 1 тянет код и передаёт управление СВЕЖЕМУ процессу (`--post-update`),
// фаза 2 доставляет зависимости и перезапускает стек.
//
// FIX.bat/fix.sh снесены 24.08 по решению владельца: они делали ровно это же,
// отличаясь от update.sh только рестартом в конце — а без рестарта обновление
// смысла и не имело.
function gitHead() {
    const r = spawnSync('git', ['log', '--oneline', '-1'], { cwd: L.ROOT, encoding: 'utf8' });
    return String(r.stdout || '').trim() || '(не git-репо?)';
}

async function doUpdate({ interactive }) {
    line();
    line(bold('  Обновление'));
    line(`  ${dim('было: ')}${gitHead()}`);
    line();

    const pull = spawnSync(process.execPath, [path.join('tools', 'git-pull-safe.js'), '--stash'],
        { cwd: L.ROOT, stdio: 'inherit' });
    const code = pull.status;

    if (code === 4) {
        line();
        line(`  ${yellow('код не обновлён: у тебя свои коммиты, разошедшиеся с master.')}`);
        line(`  ${dim('посмотреть своё:  git log --oneline @{u}..HEAD')}`);
        line(`  ${dim('разрулить:        git pull --rebase')}`);
        if (!interactive || !(await confirm('Продолжить на СТАРОМ коде (доставить зависимости и перезапустить)?', false))) {
            line(`  ${dim('остановился, ничего не тронул')}`);
            return false;
        }
    } else if (code === 3) {
        line();
        line(`  ${yellow('мешают правки в коде — git-pull-safe напечатал, какие именно.')}`);
        line(`  ${dim('спрятать их:  git stash push -m "before update"')}`);
        return false;
    } else if (code !== 0) {
        line();
        line(`  ${red('pull не прошёл')} ${dim('(код ' + code + ') — нужен интернет и доступ к GitHub')}`);
        return false;
    } else {
        line(`  ${dim('стало: ')}${gitHead()}`);
    }

    // Управление — свежему процессу. Тот же файл, но код читается с диска заново.
    line();
    line(`  ${dim('передаю управление обновлённому хабу…')}`);
    const r = spawnSync(process.execPath, [__filename, '--post-update', interactive ? '--interactive' : '--plain'],
        { cwd: L.ROOT, stdio: 'inherit' });
    return r.status === 0;
}

// Фаза 2. Установщики НЕ взаимозаменяемы: install.sh рассчитан на Windows/git-bash
// (правит user-PATH, ищет Git\usr\bin, опирается на Git Credential Manager),
// install-mac.sh — на macOS (Xcode CLT, Homebrew). Без развилки обновление на маке
// тянуло код и разваливалось в чужом установщике: код уже новый, а человек читает
// ошибку про Git for Windows и решает, что обновление не прошло.
async function doPostUpdate({ interactive }) {
    const bash = findBash();
    const installer = process.platform === 'darwin' ? 'install-mac.sh' : 'install.sh';
    line();
    line(bold(`  Доставляю зависимости (${installer}, без вопросов)`));
    if (!bash) {
        line(`  ${NO()} ${red('git-bash не найден — установщик запустить нечем')}`);
        line(`  ${dim('winget install Git.Git, потом повтори обновление')}`);
        return false;
    }
    const r = spawnSync(bash, [installer], {
        cwd: L.ROOT,
        stdio: 'inherit',
        env: { ...process.env, AUTO: '1' },
    });
    if (r.status !== 0) {
        line();
        line(`  ${red(`${installer} вышел с ошибкой (${r.status})`)} ${dim('— стек не перезапускаю')}`);
        return false;
    }
    line();
    line(`  ${OK()} зависимости на месте`);
    return doRestart({ open: interactive });
}

// ── Ввод ─────────────────────────────────────────────────────────────────────
function confirm(question, def = false) {
    if (!TTY) return Promise.resolve(def);
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`  ${bold(question)} ${dim(def ? '[Y/n] ' : '[y/N] ')}`, ans => {
            rl.close();
            const a = String(ans).trim().toLowerCase();
            resolve(a === '' ? def : (a[0] === 'y' || a[0] === 'д'));
        });
    });
}

function pause(text = 'Enter — вернуться в меню') {
    if (!TTY) return Promise.resolve();
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`\n  ${dim(text)}`, () => { rl.close(); resolve(); });
    });
}

// Одна нажатая клавиша. Raw-режим включаем только на время ожидания и снимаем
// перед запуском операций: пока он включён, дочерние процессы со stdio inherit
// (doctor.sh, установщик) не получают нормальный ввод, а Ctrl+C не прерывает их.
function readKey() {
    return new Promise(resolve => {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        const onKey = (str, key) => {
            process.stdin.removeListener('keypress', onKey);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve(key || { name: str });
        };
        process.stdin.on('keypress', onKey);
    });
}

// ── Меню ─────────────────────────────────────────────────────────────────────
function menuItems() {
    const items = [
        { key: '1', label: 'Запустить', hint: 'поднять то, что лежит', run: () => doStart() },
        { key: '2', label: 'Перезапустить', hint: 'погасить и поднять заново на свежем коде', run: () => doRestart() },
        { key: '3', label: 'Остановить', hint: 'погасить всё, включая front-door', run: () => doStop({ ask: true }) },
        { key: '4', label: 'Обновить', hint: 'git pull → зависимости → перезапуск', run: () => doUpdate({ interactive: true }) },
        { key: '5', label: 'Проверка', hint: 'всё ли в порядке — список вердиктов, ничего не меняет', run: () => doCheck() },
        { key: '6', label: 'Отчёт для отправки', hint: 'окружение целиком в файл, чтобы прислать', run: () => doDoctor() },
        { key: '7', label: 'Поделиться', hint: 'своя версия репы веткой и PR', run: () => doShare() },
        { key: '8', label: 'Открыть в браузере', hint: 'localhost:8200/__switch', run: async () => { openBrowser('http://localhost:8200/__switch'); return true; } },
    ];
    if (L.IS_WIN) items.push({
        key: '9', label: 'Фикс диктовки Orca',
        hint: 'вставка надиктованного в панели — состояние и установка',
        // Своё меню со своим выходом: после него пауза не нужна, иначе «q назад»
        // упирается в «Enter — вернуться», и кажется, что q не работает.
        noPause: true,
        run: () => doDictationFix(),
    });
    if (L.IS_WIN) items.push({
        key: 'a', label: 'Перезапустить хаб с правами админа',
        hint: 'если порт держит элевированный процесс',
        run: async () => { const ok = relaunchElevated([]); if (ok) process.exit(0); return ok; },
    });
    items.push({ key: 'q', label: 'Выход', hint: '', run: async () => { process.exit(0); } });
    return items;
}

// Одна строка пункта. Вынесена, потому что печатается из двух мест: при полной
// отрисовке кадра и при точечной перерисовке двух строк на стрелку.
function itemLine(it, on) {
    const mark = on ? cyan('❯') : ' ';
    const label = on ? bold(e(97, it.label)) : it.label;
    return `  ${mark} ${dim('[' + it.key + ']')} ${label}${it.hint ? dim('  — ' + it.hint) : ''}`;
}

async function menu() {
    hideCursor();
    process.on('exit', showCursor);
    let sel = 0;
    const items = menuItems();

    // Полный кадр рисуется ТОЛЬКО когда содержимое действительно изменилось: при входе
    // и после выполнения пункта. Раньше он перерисовывался на каждое нажатие, и это
    // выглядело как мигание всего экрана (владелец 25.08: «не нравится, что при каждом
    // клике происходит переотрисовка»). Плюс каждая перерисовка звала netstat — 112 мс
    // на стрелку впустую.
    let needFull = true;

    for (;;) {
        if (needFull) {
            clearScreen();
            const { compact } = layout();
            await intro();
            statusBlock({ compact });
            if (!compact) line();
            for (const [i, it] of items.entries()) line(itemLine(it, i === sel));
            line(dim('  ↑↓ выбрать · Enter запустить · цифра — сразу · q выход'));
            needFull = false;
        }

        const k = await readKey();
        const name = k.name || '';

        // Перерисовка ровно двух строк: снятая и надетая. Курсор поднимается на нужную
        // строку, стирает её и печатает БЕЗ перевода строки, потом возвращается вниз —
        // поэтому кадр не дёргается вообще.
        const move = dir => {
            const prev = sel;
            sel = (sel + dir + items.length) % items.length;
            if (!TTY) return;
            for (const i of [prev, sel]) {
                const upBy = items.length - i + 1;      // +1 — строка подсказки
                out(`\x1b[${upBy}A`);
                eraseLine();
                out(itemLine(items[i], i === sel));
                out(`\r\x1b[${upBy}B`);
            }
        };

        if (name === 'up' || name === 'k') { move(-1); continue; }
        if (name === 'down' || name === 'j') { move(1); continue; }
        if (name === 'c' && k.ctrl) { showCursor(); process.exit(0); }
        let pick = null;
        if (name === 'return' || name === 'enter' || name === 'space') pick = items[sel];
        else pick = items.find(it => it.key === name);
        if (!pick) continue;

        showCursor();
        clearScreen();
        await intro();
        await pick.run();
        if (!pick.noPause) await pause();
        hideCursor();
        needFull = true;
    }
}

// introStatic() снят 25.08: шапку рисует intro() (только картинка), а вордмарк —
// footer() в самом низу. Отдельная «статичная» копия шапки была третьим местом, где
// решалось, что показывать, и именно она однажды прятала картинку, пока intro()
// её рисовал.

// ── CLI ──────────────────────────────────────────────────────────────────────
// Те же операции без меню: этим путём ходят тонкие форвардеры (START.bat,
// DASHBOARD.command, routing/restart-dashboard.*) и кнопка перезапуска в дашборде.
// Коды выхода настоящие: 0 — получилось, 1 — нет. На них смотрит регресс.
function printStatus() {
    const rows = L.status();
    const w = Math.max(...rows.map(r => r.name.length));
    for (const r of rows) {
        const mark = r.up ? green('●') : grey('○');
        const role = r.role === 'service' ? 'сервис' : (r.respawn ? 'ребёнок (сам встанет)' : 'ребёнок');
        line(`  ${mark} ${r.name.padEnd(w)} ${dim((':' + r.port).padEnd(7))} ${dim(role.padEnd(22))}${r.up ? dim('pid ' + r.pids.join(',')) : ''}`);
    }
    const svcTotal = rows.filter(r => r.role === 'service').length;
    const svcUp = rows.filter(r => r.role === 'service' && r.up).length;
    line();
    line(`  сервисов поднято: ${svcUp === svcTotal ? green(`${svcUp}/${svcTotal}`) : yellow(`${svcUp}/${svcTotal}`)}`);
    if (L.IS_WIN) line(`  права: ${L.isElevated() ? 'администратор' : 'обычные'}`);
}

function usage() {
    line();
    line(bold('  hub.js — управление дашбордом ABUSE HUB'));
    line();
    line('  node hub.js              меню (двойной клик: HUB.bat / HUB.command)');
    line('  node hub.js start        поднять то, что лежит (идемпотентно)');
    line('  node hub.js stop         погасить всё, включая front-door и keepalive');
    line('  node hub.js restart      погасить и поднять заново');
    line('  node hub.js update       git pull → зависимости → перезапуск');
    line('  node hub.js status       кто слушает какие порты');
    line('  node hub.js check        всё ли в порядке — список вердиктов');
    line('  node hub.js doctor       полный отчёт окружения в файл (для отправки)');
    line('  node hub.js share        отдать свою версию репы веткой и PR');
    line();
    line(dim('  флаги: --no-open (не открывать браузер), HUB_PLAIN=1 (без ANSI)'));
}

async function main() {
    const argv = process.argv.slice(2);
    const open = !argv.includes('--no-open');
    const verb = argv.find(a => !a.startsWith('-'));

    if (argv.includes('--post-update')) {
        process.exit((await doPostUpdate({ interactive: argv.includes('--interactive') })) ? 0 : 1);
    }
    if (!verb) {
        // Без TTY меню рисовать некому (запуск из планировщика, из дашборда,
        // перенаправление в файл) — печатаем состояние и уходим с нулём.
        if (!TTY) { printStatus(); return; }
        return menu();
    }

    switch (verb) {
        case 'start': case 'up':
            process.exit((await doStart({ open })) ? 0 : 1);
            break;
        case 'stop': case 'down':
            process.exit((await doStop()) ? 0 : 1);
            break;
        case 'restart':
            process.exit((await doRestart({ open })) ? 0 : 1);
            break;
        case 'update':
            process.exit((await doUpdate({ interactive: TTY })) ? 0 : 1);
            break;
        case 'status':
            printStatus();
            break;
        case 'check':
            process.exit((await doCheck()) ? 0 : 1);
            break;
        case 'doctor':
            process.exit((await doDoctor()) ? 0 : 1);
            break;
        case 'share':
            process.exit((await doShare()) ? 0 : 1);
            break;
        default:
            usage();
            process.exit(2);
    }
}

// Запускаемся только как точка входа. Экспорт нужен регрессу: высоту шапки и меню
// нельзя честно померить по дампу pty — анимация вордмарка оставляет в потоке кадры с
// cursor-up, и любая попытка «вычислить экран» из байтов врёт (проверено). Регресс
// вместо этого подменяет stdout и считает строки, которые печатают сами функции.
if (require.main === module) {
    main().catch(err => {
        showCursor();
        line();
        line(`  ${red('хаб упал:')} ${err && err.stack ? err.stack : err}`);
        process.exit(1);
    });
}

module.exports = { intro, statusBlock, menuItems, itemLine, art, artFits, layout, link, readArt, WISPR_ART_FILE };
