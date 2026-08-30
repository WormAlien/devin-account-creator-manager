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

// ── Безопасные глифы (старый conhost) ────────────────────────────────────────
// Шапка нарисована брайлем (U+2800…28FF), метки — `✓` / `✗` / `❯`. Старый conhost
// предлагает ровно два шрифта, Consolas и Lucida Console, и НИ В ОДНОМ из них этих
// символов нет: замерено по `CharacterToGlyphMap` самих файлов шрифтов, а не на глаз
// (`✗` отсутствует даже в Cascadia Mono — там его рисует фолбэк терминала, которого
// у conhost'а нет). Человек без Windows Terminal видит вместо шапки стену одинаковых
// квадратов и считает, что хаб сломан — так это и приехало 28.08 скриншотом от друга.
// В conhost рисуем то же самое глифами, которые есть в ОБОИХ его шрифтах:
// картинку ` ░▒▓█▀▄` (`internal/hub-art-blocks.txt`), метки `√ x > •`.
//
// Признак — ровно тот, которым moveToWindowsTerminal() узнаёт conhost, и это
// сознательно: два разных определения «плохого терминала» разъехались бы при первой
// же правке. Пустые TERM и TERM_PROGRAM = терминал человек не выбирал; git-bash,
// VS Code и WezTerm их ставят и шрифт подбирают сами.
//
// 🪤 Вид в Windows Terminal не меняется НИ НА СИМВОЛ — решение владельца 28.08.
// Это фолбэк, а не новый стиль: брайлевый шрифт цифр он выбирал из семи вариантов,
// а полублочный тогда же забраковал словами «шрифт не нравится».
// 🪤 Не-TTY (кнопка перезапуска в дашборде, перенаправление в файл) — НЕ conhost:
// там текст читает браузер или редактор, со своими шрифтами. Иначе владелец увидел
// бы упрощённую картинку в логе дашборда, то есть ровно то, чего просил не делать.
//
// `HUB_SAFE_GLYPHS=1` включает набор принудительно (регресс, терминал с плохим
// шрифтом), `=0` выключает даже в conhost.
const SAFE = (() => {
    const force = process.env.HUB_SAFE_GLYPHS;
    if (force === '1') return true;
    if (force === '0') return false;
    if (!L.IS_WIN || !process.stdout.isTTY) return false;
    if (process.env.WT_SESSION || process.env.HUB_IN_WT) return false;
    return !(process.env.TERM || process.env.TERM_PROGRAM);
})();

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
// Счётчик напечатанных строк. Нужен ровно для одного: капель должна знать, сколько
// строк кадра лежит НИЖЕ картинки, чтобы прыгать к ней курсором. Считать формулой
// нельзя — состав кадра меняется от размера окна и числа пунктов.
let printedLines = 0;
const line = (s = '') => { printedLines++; out(s + '\n'); };
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
const ART_FILE = path.join(__dirname, 'internal', SAFE ? 'hub-art-blocks.txt' : 'hub-art.txt');
const WISPR_ART_FILE = path.join(__dirname, 'internal', 'wispr-art.txt');
// Отступ слева и зазор между картинкой и панелью — в одном месте: из них считается,
// сколько колонок остаётся панели, и разъехавшиеся копии этой арифметики уже дважды
// прятали панель целиком.
const PAD = '  ';
const GAP = '   ';

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
//
// Шрифт брайлевый, 3 строки — выбран владельцем 26.08 из семи вариантов (черновик
// `Downloads/digit-dots.js`, вне репо; он же печатает этот литерал по `--js`). Тем же
// алфавитом нарисованы картинка в шапке и знак доллара, поэтому шапка стала однородной.
// Полублочный шрифт, стоявший тут с 25.08, отклонён владельцем: «шрифт не нравится».
//
// Геометрия: ячейка брайля несёт 2×4 точки, значит цифра 6×12 точек = ровно 3×3 символа —
// та же высота, что у полублочного, перекладывать панель не пришлось. Штрих 2 точки,
// у единицы флажок и подставка (в семисегментном варианте она выглядела голой палкой).
const DIGIT_ROWS = 3;
const DIGITS_BRAILLE = {
    0: ['⣿⠛⣿', '⣿⠀⣿', '⣿⣤⣿'], 1: ['⠴⣿⠀', '⠀⣿⠀', '⣤⣿⣤'],
    2: ['⠛⠛⣿', '⣶⠶⠿', '⣿⣤⣤'], 3: ['⠛⠛⣿', '⠶⠶⣿', '⣤⣤⣿'],
    4: ['⣿⠀⣿', '⠿⠶⣿', '⠀⠀⣿'], 5: ['⣿⠛⠛', '⠿⠶⣶', '⣤⣤⣿'],
    6: ['⣿⠛⠛', '⣿⠶⣶', '⣿⣤⣿'], 7: ['⠛⠛⣿', '⠀⠀⣿', '⠀⠀⣿'],
    8: ['⣿⠛⣿', '⣿⠶⣿', '⣿⣤⣿'], 9: ['⣿⠛⣿', '⠿⠶⣿', '⣤⣤⣿'],
    ' ': ['⠀⠀⠀', '⠀⠀⠀', '⠀⠀⠀'],
};

// Полублочная таблица — фолбэк для conhost (см. SAFE). Это ровно тот шрифт, что стоял
// здесь до 26.08: он уже был нарисован и выверен, а глифы `█▀▄` есть в обоих шрифтах
// conhost'а. Владельцу он не понравился, поэтому живёт только там, где брайль
// физически не рисуется — заново такое рисовать незачем, а выбрасывать было бы жаль.
//
// 🪤 Пробел здесь ТРИ символа, а не два, как было в оригинале 25.08: ширина ячейки
// задаёт шаг центровки всего блока, и цифра-пробел на символ короче уводила бы сумму
// на треть ячейки влево. В брайлевой таблице пробел тоже трёхсимвольный.
const DIGITS_SAFE = {
    0: ['█▀█', '█ █', '█▄█'], 1: [' ▄█', '  █', '  █'],
    2: ['▀▀█', '▄▀ ', '█▄▄'], 3: ['▀▀█', ' ▀█', '▄▄█'],
    4: ['█ █', '█▄█', '  █'], 5: ['█▀▀', '▀▀█', '▄▄█'],
    6: ['█▀▀', '█▀█', '█▄█'], 7: ['▀▀█', '  █', '  █'],
    8: ['█▀█', '█▀█', '█▄█'], 9: ['█▀█', '▀▀█', '▄▄█'],
    ' ': ['   ', '   ', '   '],
};
const DIGITS = SAFE ? DIGITS_SAFE : DIGITS_BRAILLE;

function bigNum(text) {
    const rows = Array.from({ length: DIGIT_ROWS }, () => '');
    for (const ch of String(text)) {
        const g = DIGITS[ch];
        if (!g) continue;
        for (let r = 0; r < DIGIT_ROWS; r++) rows[r] += g[r] + ' ';
    }
    // Хвостовой пробел снимаем: по ширине этих строк центрируется весь блок, и лишний
    // символ сдвинул бы сумму на полсимвола влево от общей оси.
    return rows.map(r => r.trimEnd());
}

// Знак доллара — `internal/hub-dollar.txt`. С 26.08 это НЕ арт из вики, а глиф,
// нарисованный тем же шрифтом, что цифры суммы (штрих 2 точки, бары по 2, боковины по 3
// ряда): владелец забраковал прежний размер — «арт доллара бы по размеру баланса, потому
// что огромен». Было 14×11 символов, стало 5×3, и шапка из-за этого сжалась с 11 строк до 9.
//
// 🪤 Уменьшить сам арт вики нельзя, и это замерено дважды: 28×44 точки в 12 — это 3.7×,
// штрих S становится тоньше точки и рассыпается (черновики `Downloads\dollar-shrink.js`
// и `dollar-small.js`, семь порогов усреднения на трёх высотах). Поэтому знак нарисован
// заново. Оригинал арта не потерян — он лежит в вике, `wiki/WORKSPACE/ART 1.md`.
//
// 🪤 Ширина 10 точек, а не 8, ради перекладины: на 8 точках она встаёт на колонки 3–4 и
// оказывается РАЗРЕЗАНА границей ячеек, а между ячейками в шрифте просвет — вблизи вместо
// палки видны две чёрточки. На 10 точках перекладина целиком внутри одной ячейки.
//
// Знак РОВНО той же высоты, что цифры (3 строки), и это условие, а не совпадение: он
// стоит с ними в одном центрируемом блоке, и любая лишняя строка растянула бы панель, а
// с ней и шапку — то есть вернула бы ту самую претензию, с которой всё началось. Вариант
// с перекладиной, торчащей выше и ниже цифр, отвергнут именно поэтому: он давал 11 строк.
// Пересобрать: `node Downloads\dollar-small.js --js 4`.
//
// В безопасном наборе (SAFE, старый conhost) знак не рисуется вообще: он тоже брайлевый,
// а второй его вариант полублоками — это чужая работа ради окна, в котором и так стоит
// текстовая строка `$594.27` под цифрами. Панель просто отдаёт знак, как отдаёт его при
// нехватке ширины — путь уже есть и проверен.
const DOLLAR_FILE = path.join(__dirname, 'internal', 'hub-dollar.txt');

// Правая колонка шапки: последний ИЗВЕСТНЫЙ запас пулов. Читается с диска, поэтому
// цифра есть и когда дашборд лежит — как раз тогда её больше негде посмотреть.
// Отсюда и подпись «последний известный», а не «баланс»: это кэш опроса.
//
// maxW — сколько колонок реально свободно справа от картинки. Панель обязана в них
// уложиться: перенос строки разорвал бы картинку пополам.
function balancePanel(maxW, { big = true } = {}) {
    let b;
    try { b = require('./internal/hub-balance').balance(); } catch { return []; }
    if (!b.keys) return [];

    // Разряды не разделяем: пробел любого вида в блочном шрифте читается как разрыв числа.
    const whole = String(Math.round(b.available));
    const when = b.checkedAt ? new Date(b.checkedAt).toLocaleString('sv').slice(11, 16) : '—';
    const money = n => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n)));
    const parts = b.pools.filter(p => p.keys).map(p => `${p.id.toUpperCase()} ${money(p.available)}`);
    const digits = bigNum(whole);
    const title = 'ПОСЛЕДНИЙ ИЗВЕСТНЫЙ ЗАПАС';
    const sumText = '$' + b.available.toFixed(2) + '  опрошено ' + when;
    const sum = `${bold('$' + b.available.toFixed(2))}${dim('  опрошено ' + when)}`;
    // Пулы сжимаем, а не режем: сначала точки-разделители, потом пробелы, и только
    // если и так не лезет — обрезаем. Потерять «TB 184» хуже, чем потерять точки.
    const poolsFit = w => {
        for (const sep of [' · ', ' ']) {
            const s = parts.join(sep);
            if (s.length <= w) return s;
        }
        const s = parts.join(' ');
        return s.slice(0, Math.max(1, w - 1)) + '…';
    };

    // Все элементы панели центрируются по ОДНОЙ вертикальной оси — решение владельца
    // 26.08: «доллар и баланс сместить направо, чтобы всё было соосно по вертикальной
    // центральной линии элементов». До этого знак с суммой жили отдельной левой колонкой
    // и выпирали влево, а подпись с пулами были прижаты к своей — блок читался кривым.
    //
    // «Знак + сумма» — ОДИН элемент на три строки, поэтому центрируется целиком, а не
    // построчно: иначе строки знака разъехались бы между собой.
    const D = big && !SAFE ? readArt(DOLLAR_FILE) : [];
    const dw = D.length ? Math.max(...D.map(l => [...l].length)) : 0;
    const digitsW = Math.max(...digits.map(l => [...l].length));
    const blockW = (dw ? dw + 2 : 0) + digitsW;
    const pools = poolsFit(Math.min(maxW, parts.join(' · ').length));
    const W = Math.max(blockW, title.length, sumText.length, [...pools].length);
    // Не влезаем — сперва отдаём знак, потом панель целиком. Резать её нельзя: перенос
    // строки разорвал бы картинку пополам.
    if (W > maxW) return big ? balancePanel(maxW, { big: false }) : [];

    const pad = s => ' '.repeat(Math.max(0, Math.floor((W - [...s].length) / 2)));
    // Знак и цифры могут быть разной высоты — тогда каждый центрируется внутри блока.
    // Сейчас оба по 3 строки, но арт в файле владелец меняет, и от этого не должно
    // зависеть ничего, кроме высоты блока.
    const bh = Math.max(D.length, digits.length);
    const dTop = Math.floor((bh - D.length) / 2);
    const gTop = Math.floor((bh - digits.length) / 2);
    const blockPad = ' '.repeat(Math.max(0, Math.floor((W - blockW) / 2)));
    const block = Array.from({ length: bh }, (_, i) => {
        const d = dw ? (D[i - dTop] || '⠀'.repeat(dw)).padEnd(dw, '⠀') + '  ' : '';
        const g = digits[i - gTop] || '';
        return blockPad + (d ? green(d) : '') + (g ? green(g) : '');
    });

    // 🪤 Отступ считается по ТЕКСТУ, а красится уже раскрашенная строка: длина `sum` с
    // escape-последовательностями к вёрстке отношения не имеет, поэтому центруем по
    // `sumText`. Перепутать их — значит уехать на десяток колонок.
    const rows = [
        pad(title) + dim(title),
        '',
        ...block,
        '',
        pad(sumText) + sum,
        pad(pools) + dim(pools),
    ];
    // Где именно лежат цифры — нужно мерцанию (startDrip): оно перекрашивает ровно эти
    // три строки, не стирая их, потому что слева на тех же строках стоит знак доллара.
    // Метаданные висят на массиве, а не в возвращаемом объекте: `balancePanel` отдаёт
    // массив строк, на это опирается регресс.
    //
    // 🪤 `dollarW` — отдельный признак присутствия знака, и по `col` его не определить:
    // блок центрируется, поэтому у панели БЕЗ знака отступ тоже ненулевой.
    rows.digitsAt = { row: 2 + gTop, col: [...blockPad].length + (dw ? dw + 2 : 0), rows: digits, dollarW: dw };
    return rows;
}

// ── Раскладка ────────────────────────────────────────────────────────────────
// На экране: КАРТИНКА сверху → состояние → меню → подсказка. Всё.
//
// 🪤 История трёх выброшенных вариантов надписи «ABUSE HUB» — в ARCHITECTURE.md.
// Короткий вывод: я трижды решал за владельца, как должен выглядеть его инструмент,
// и трижды был неправ. Больше блочных надписей тут нет.
// Размер окна принимаем аргументом: `process.stdout.columns` в Node только для чтения,
// и регресс не мог проверить раскладку на семи размерах, не подменяя поток целиком.
function layout({ cols = process.stdout.columns || 80, rows = process.stdout.rows || 24 } = {}) {
    const A = art();
    const artW = A.length ? Math.max(...A.map(l => [...l].length)) : 0;
    const artOk = A.length > 0 && cols >= artW + 4;
    const room = cols - PAD.length - artW - GAP.length;

    // Панель бывает двух размеров, и от этого зависит ВЫСОТА шапки: с брайлевым
    // долларом она 11 строк, без него 8. Считаем оба варианта заранее — раскладка
    // жертвует ими по очереди, а не решает за один проход.
    const panels = artOk
        ? [balancePanel(room, { big: true }), balancePanel(room, { big: false }), []]
        : [[]];

    const items = menuItems().length;
    // Строк в кадре: шапка + (отступ + дашборд + прочее + права) + пункты + подсказка.
    // extra — строка про упрощённую шапку в безопасном наборе. Она обязана попасть в
    // арифметику, а не «просто печататься»: кадр, не влезающий в окно, уводит верх за
    // экран, и картинки не видно — так уже было дважды, при 33 строках и при 30.
    const total = (head, compact, extra = 0) => head + extra
        + (compact ? 3 : 4) + (compact ? items + 1 : items + 2);

    // Порядок жертв: сперва отступы, потом большой доллар, потом панель целиком, и
    // только в конце картинка — её владелец просил в первую очередь.
    //
    // Подсказка про упрощённую шапку уходит РАНЬШЕ всего остального, и порядок циклов
    // это ровно и означает: для каждой раскладки сначала пробуем с ней, и если не лезет —
    // тот же вариант без неё, а к следующей (более урезанной) раскладке переходим уже
    // потом. Иначе на 80×24 подсказка стоила бы картинки: она её объясняет, значит без
    // картинки не нужна вообще.
    if (artOk) {
        for (const panel of panels) {
            const head = Math.max(A.length, panel.length);
            for (const compact of [false, true]) {
                for (const tip of (SAFE ? [true, false] : [false])) {
                    if (total(head, compact, tip ? 1 : 0) <= rows) {
                        return {
                            art: A, panel: centerPanel(panel, head), headerRows: head,
                            withArt: true, compact, tip,
                        };
                    }
                }
            }
        }
    }
    for (const compact of [false, true]) {
        if (total(0, compact) <= rows) return { art: A, panel: [], headerRows: 0, withArt: false, compact, tip: false };
    }
    return { art: A, panel: [], headerRows: 0, withArt: false, compact: true, tip: false };
}

// Панель короче картинки — центрируем её по вертикали. До 26.08 этого не требовалось:
// панель со знаком доллара во всю высоту (11 строк) сама задавала высоту шапки. Знак стал
// 6 строк, панель — 8, картинка осталась 9, и без центровки баланс висел бы у верхней
// кромки, а под ним пустовала строка.
//
// Сдвиг цифр внутри панели обязан уехать вместе с ней: по `digitsAt.row` мерцание ищет
// строки курсором, и ошибка на одну строку красит не цифры, а картинку.
function centerPanel(panel, head) {
    const pad = Math.floor((head - panel.length) / 2);
    if (!panel.length || pad <= 0) return panel;
    const out = Array.from({ length: pad }, () => '').concat(panel);
    if (panel.digitsAt) out.digitsAt = { ...panel.digitsAt, row: panel.digitsAt.row + pad };
    return out;
}

function artFits(lines) {
    if (!lines.length) return false;
    const w = Math.max(...lines.map(l => [...l].length));
    return (process.stdout.columns || 80) >= w + 4;
}

// Шапка: картинка ПРОЯВЛЯЕТСЯ по точкам сверху вниз, ~350 мс. Разово — при входе в
// меню и при возврате из подменю; постоянное движение делает капель (см. ниже).
// В не-TTY один плоский кадр.
//
// Проявление считается по точкам брайля, а не по строкам: одна ячейка это 2×4 точки,
// и биты лежат в коде символа. Построчный вариант, стоявший тут до 25.08, выглядел
// как открывающиеся жалюзи.
//
// Возвращает высоту шапки: она НЕ равна высоте картинки, когда справа стоит брайлевый
// доллар (11 строк против 9), а капели эта цифра нужна, чтобы найти картинку курсором.
async function intro({ animate = true } = {}) {
    const { art: A, panel, headerRows, withArt } = layout();
    if (!withArt) return 0;

    const artW = Math.max(...A.map(l => [...l].length));
    const blank = ' '.repeat(artW);
    // Картинка прижата к НИЗУ шапки. Знак доллара выше её на две строки, и при
    // выравнивании по верху он свисал ниже картинки — владелец провёл по этому месту
    // линию на скриншоте («не ровно, не по линии»). Теперь нижние кромки совпадают,
    // а лишние две строки уходят наверх, где у знака и так пустой купол.
    const artTop = headerRows - A.length;
    const row = (artLine, panelLine) =>
        PAD + (TTY ? cyan(artLine) : artLine) + (panelLine ? GAP + panelLine : '');
    const at = (src, i) => (i < artTop || src[i - artTop] === undefined ? blank : src[i - artTop]);
    const composed = Array.from({ length: headerRows }, (_, i) => row(at(A, i), panel[i]));

    // 🪤 Безопасный набор печатается ОДНИМ плоским кадром: проявление считает точки по
    // коду символа (`code - 0x2800`), и на полублочной картинке это дало бы не анимацию,
    // а мусор из случайного брайля поверх шапки. То же и с капелью — см. startDrip().
    if (!TTY || !animate || SAFE) {
        for (const l of composed) line(l);
        return headerRows;
    }

    const AN = require('./internal/art-anim');
    const B = AN.create(A);
    const R = AN.reveal(B);
    line('\n'.repeat(headerRows - 1));         // место под шапку
    for (;;) {
        const f = R.next();
        up(headerRows);
        // Панель появляется только в финальном кадре: мигать вместе с картинкой ей
        // нельзя — цифра баланса, которая скачет, читается как «баланс скачет».
        for (let i = 0; i < headerRows; i++) { eraseLine(); line(row(at(f.lines, i), '')); }
        if (f.done) break;
        await sleep(24);
    }
    up(headerRows);
    for (const l of composed) { eraseLine(); line(l); }
    return headerRows;
}

// ── Капель ───────────────────────────────────────────────────────────────────
// Постоянное движение в шапке, пока открыто меню: зелёные капли отрываются от
// нижних кромок картинки и падают. Решение владельца 25.08 — «капли зелёные, чтобы
// были постоянно», сама картинка остаётся голубой и целой.
//
// Три вещи, из которых это дёшево:
//   * перерисовываются только ЯЧЕЙКИ с каплями (десятки символов), а не строки;
//   * символ капли смешан с картинкой, поэтому точки под ней не пропадают;
//   * при потере фокуса окна таймер СНИМАЕТСЯ (см. focus reporting ниже) — в фоне
//     не тратится вообще ничего, а не «тратится мало».
//
// `HUB_NO_DRIP=1` выключает капель совсем: нужно для замеров точечной перерисовки в
// регрессе и на случай терминала, который такой поток не любит.
const DROP = '\x1b[38;5;46m';                 // ярко-зелёный, ярче картинки
const FOCUS_ON = '\x1b[?1004h';
const FOCUS_OFF = '\x1b[?1004l';

// ── Мерцание суммы ───────────────────────────────────────────────────────────
// По цифрам баланса слева направо бежит волна света, потом пауза — так в Claude Code
// подсвечено слово `ultracode`, владелец попросил «как там» (26.08).
//
// Три вещи, из которых это дёшево:
//   * перекрашиваются ТОЛЬКО три строки цифр, никакой другой части кадра;
//   * не по символу, а прогонами одного цвета: в кадре 8 escape-последовательностей
//     на строку вместо двадцати;
//   * между проходами волны в поток не уходит ни байта, и таймер общий с капелью —
//     значит при потере фокуса окна мерцание тоже встаёт.
//
// 🪤 `eraseLine` тут применять нельзя: на этих же строках слева стоит знак доллара, и
// стирание съело бы его. Печатаем поверх, ровно той же видимой длиной.
const SHINE = [
    '\x1b[38;5;28m',   // тёмная кромка волны
    '\x1b[92m',        // база — ровно то, чем красит green(), в покое цвет не меняется
    '\x1b[38;5;46m',
    '\x1b[38;5;83m',
    '\x1b[38;5;120m',
    '\x1b[38;5;231m',  // белое ядро
];
const SHINE_PROFILE = [5, 4, 3, 2];           // яркость по расстоянию от центра волны
const SHINE_IDLE = 16;                        // кадров паузы между проходами (~1.4 с)

// Одна строка цифр с волной в колонке `centre`. centre = null — базовый цвет целиком.
function shineRow(text, centre) {
    if (centre === null) return SHINE[1] + text + '\x1b[0m';
    const ch = [...text];
    let s = '', cur = -1;
    for (let i = 0; i < ch.length; i++) {
        const d = Math.abs(i - centre);
        const k = d < SHINE_PROFILE.length ? SHINE_PROFILE[d] : 1;
        if (k !== cur) { s += SHINE[k]; cur = k; }
        s += ch[i];
    }
    return s + '\x1b[0m';
}

let dripStop = null;
// Хук фокуса окна. Ставит его капель, дёргает readKey: последовательности ESC[I/ESC[O
// приходят в тот же поток ввода, что и клавиши, поэтому разбираются там же.
let focusHook = null;

// Курсор стоит под всем кадром; картинка — `linesBelow + A.length` строк выше.
// Каждую ячейку рисуем от сохранённой позиции (ESC 7 / ESC 8): относительные
// прыжки пришлось бы складывать, а любая ошибка в сумме уводит рисунок в текст.
//
// Здесь же живёт мерцание суммы: таймер один на оба эффекта, иначе они разошлись бы
// по фазе и делили курсор через два независимых ESC 7 / ESC 8.
function startDrip(A, linesBelow, headerRows, digitsAt = null) {
    if (!TTY || !A.length || process.env.HUB_NO_DRIP) return;
    // 🪤 Капель в безопасном наборе не заводится, а мерцание суммы — заводится, и это
    // не половинчатость. Капель ЧИТАЕТ картинку как битмап (`art-anim.js`: код символа
    // минус 0x2800) и дописывает в ячейку точки — на полублочной картинке она печатала
    // бы поверх шапки случайный брайль, то есть ровно те квадраты, от которых мы уходим.
    // Мерцание же только перекрашивает уже напечатанные строки цифр и от алфавита не
    // зависит вообще: волна по сумме остаётся и в старом conhost.
    const AN = SAFE ? null : require('./internal/art-anim');
    const D = AN ? AN.drip(AN.create(A)) : null;
    // Картинка прижата к низу шапки (см. intro), поэтому её строка cy лежит ровно на
    // `linesBelow + A.length - cy` выше курсора — высота шапки в эту арифметику уже не
    // входит. Аргумент headerRows оставлен для проверки: если он меньше картинки,
    // раскладка развалилась и капель лучше не заводить.
    if (headerRows && headerRows < A.length) return;
    const top = linesBelow + A.length;
    let timer = null, paused = false;

    // Цифры адресуются от ВЕРХА шапки (панель выровнена по верху, картинка — по низу),
    // поэтому своя арифметика: строка панели r стоит на `headerRows - r + linesBelow`
    // выше курсора. Колонка — отступ, ширина картинки, зазор и смещение внутри панели.
    const artW = Math.max(...A.map(l => [...l].length));
    const shine = digitsAt && headerRows ? {
        col: PAD.length + artW + GAP.length + digitsAt.col + 1,
        rows: digitsAt.rows,
        up: digitsAt.rows.map((_, r) => headerRows - (digitsAt.row + r) + linesBelow),
        width: Math.max(...digitsAt.rows.map(l => [...l].length)),
        phase: 0,
    } : null;
    // Ни капели, ни цифр — заводить таймер незачем: он бы тикал каждые 90 мс впустую.
    // Достижимо только в безопасном наборе без панели баланса (узкое окно conhost).
    if (!D && !shine) return;

    // Кадр волны: `null` — покой, число — центр волны. Один раз после прохода красим
    // базовым цветом и умолкаем до следующего прохода: последний кадр волны оставляет
    // светлыми три последние колонки, и без сброса они бы так и застыли.
    // Разгон и выбег — на полширины профиля: дальше него точки уже базовые, и кадр,
    // в котором не светится ничего, отправлять незачем.
    const shineFrame = () => {
        const edge = SHINE_PROFILE.length - 1;
        const span = shine.width + edge * 2;
        const p = shine.phase++;
        if (p < span) return p - edge;
        if (p === span) return null;
        if (p >= span + SHINE_IDLE) shine.phase = 0;
        return false;                            // в поток не уходит ничего
    };

    const tick = () => {
        timer = null;
        if (paused) return;
        const { paint, clear } = D ? D.next() : { paint: [], clear: [] };
        const centre = shine ? shineFrame() : false;
        if (paint.length || clear.length || centre !== false) {
            let s = '\x1b7';
            for (const c of clear) s += `\x1b8\x1b[${top - c.cy}A\x1b[${c.cx + 3}G${cyan(c.ch)}`;
            for (const c of paint) s += `\x1b8\x1b[${top - c.cy}A\x1b[${c.cx + 3}G${DROP}${c.ch}\x1b[0m`;
            if (centre !== false) {
                shine.rows.forEach((l, r) => {
                    s += `\x1b8\x1b[${shine.up[r]}A\x1b[${shine.col}G${shineRow(l, centre)}`;
                });
            }
            out(s + '\x1b8');
        }
        timer = setTimeout(tick, 90);
    };

    dripStop = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        dripStop = null;
        focusHook = null;
        out(FOCUS_OFF);
    };
    // Фокус ушёл — снимаем таймер; вернулся — заводим заново.
    focusHook = on => {
        paused = !on;
        if (!on && timer) { clearTimeout(timer); timer = null; }
        if (on && !timer) timer = setTimeout(tick, 90);
    };
    // Просим терминал сообщать о фокусе. Windows Terminal умеет, старый conhost
    // молча игнорирует — там капель будет капать и в фоне, стоимость известна.
    out(FOCUS_ON);
    timer = setTimeout(tick, 300);
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
// Метки статуса. Правые части — безопасный набор для conhost (см. SAFE): `√` (U+221A)
// есть и в Consolas, и в Lucida Console, `•` (U+2022) тоже, а вот `●` (U+25CF) есть
// только в Consolas — поэтому в фолбэке именно `•`, иначе на Lucida Console получился бы
// второй квадрат вместо первого. Знак ошибки в обычном виде остаётся `✗` (решение
// владельца 28.08), подменяется только здесь.
const G = (rich, safe) => (SAFE ? safe : rich);
const OK = () => green(G('✓', '√'));
const NO = () => red(G('✗', 'x'));
const SKIP = () => grey('·');                  // U+00B7 есть везде, подменять нечего
const DOT_ON = G('●', '•');
const DOT_OFF = '○';                           // U+25CB есть в обоих шрифтах conhost'а
const CURSOR = G('❯', '>');

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
    line(`  ${bold('Дашборд')}  ${dash.up ? green(DOT_ON + ' живой') : red(DOT_OFF + ' лежит')}` +
        (dash.up ? dim(`  pid ${dash.pids.join(',')}  `) + link(url, cyan(url)) : dim('  ' + url)));

    const alive = rest.filter(r => r.up);
    const downSvc = rest.filter(r => !r.up && r.role === 'service');
    const names = alive.map(r => r.name.replace(' keepalive', '')).join(' · ') || 'никого';
    const room = Math.max(20, W() - (compact ? 34 : 24));
    line(`  ${dim('живы:')} ${alive.length ? green(DOT_ON) + ' ' : ''}` +
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
// Где лежит Windows Terminal.
//
// 🪤 `fs.existsSync` на нём отвечает FALSE, и это была та самая причина серого окна:
// `wt.exe` в `WindowsApps` — не файл и не обычная ссылка, а точка повторного разбора
// «алиас выполнения приложения». `stat` по ней не проходит (значит `existsSync` = false),
// а `lstat` проходит и показывает ссылку в 93 байта. Проверка через `existsSync` считала,
// что терминала нет вовсе, и хаб честно уходил на прямой запуск node — то есть в conhost
// (владелец 25.08: «когда от админа запускаю, оно такое серое становится»).
// Правильных путей два, оба проверены: `where.exe` и `lstat`.
function findWt() {
    if (!L.IS_WIN) return null;
    const r = spawnSync('where.exe', ['wt.exe'], { encoding: 'utf8', windowsHide: true });
    const first = String(r.stdout || '').split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
    const alias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
    try { fs.lstatSync(alias); return alias; } catch { return null; }
}

// Перезапустить себя с правами администратора. Нужно ровно в одном случае: старый
// процесс поднят элевированным (так делал restart-dashboard.bat до 24.08, он просил
// UAC на каждом запуске), и обычный taskkill его не берёт.
//
// Открываем в Windows Terminal, а не напрямую node: элевированный процесс, запущенный
// через Start-Process, получает СВОЁ окно, и это старый conhost — серый, с другим
// шрифтом и без темы. `wt.exe` уносит окно в нормальный терминал с профилем по
// умолчанию. Порядок попыток: сам wt → wt из-под cmd → прямой node. Последняя даёт то
// самое серое окно, но она лучше, чем «ничего не произошло» — и такой хаб при старте
// сам переедет в терминал (moveToWindowsTerminal).
//
// 🪤 Аргумент с ПРОБЕЛОМ надо обернуть в двойные кавычки ВНУТРИ значения. Start-Process
// с любым `-Verb` идёт через ShellExecute, а тот принимает одну строку: PowerShell
// склеивает элементы `-ArgumentList` пробелами и НЕ кавычит их сам. Замер (черновик
// `Downloads\elevate-args-probe.js`, вариант с эхом argv): и запись через запятую, и
// через `@(...)` дают `["--title","ABUSE","HUB","(админ)"]` — wt видит команду «HUB»
// и падает; вариант с внутренними кавычками приезжает целым. Ломался не только
// заголовок: `C:\Program Files\nodejs\node.exe` разрывался ровно так же.
// 🪤 Шим на .cmd эту задачу решает, но кириллицу в нём коверкает консольная кодировка
// (в замере заголовок приехал как «ABUSE HUB (04<8=)»), а .cmd у нас по правилу ASCII.
function elevateCommands(argv = []) {
    if (!L.IS_WIN) return [];
    const hubArgs = [__filename, ...argv];
    const wt = findWt();
    // Два разных квотирования, и путать их нельзя: `-FilePath` уходит параметром
    // PowerShell (хватает одинарных кавычек), а элементы `-ArgumentList` склеиваются в
    // одну строку для ShellExecute — им нужны ещё и внутренние двойные.
    const psq = s => `'${String(s).replace(/'/g, "''")}'`;
    const psArr = list => `@(${list.map(s => psq(/\s/.test(s) ? `"${s}"` : s)).join(',')})`;

    const tries = [];
    if (wt) {
        // `-w -1` — новое окно, а не вкладка в уже открытом (иначе элевированная вкладка
        // подсядет к обычному окну, чего Windows Terminal не разрешает). Внутри окна
        // запускается HUB.bat, а не node: при падении bat делает pause, и стек остаётся
        // на экране вместо мгновенно закрывшейся вкладки.
        const wtArgs = wtHubArgs('ABUSE HUB (админ)', argv);
        tries.push(`$a = ${psArr(wtArgs)}; Start-Process -FilePath ${psq(wt)} -ArgumentList $a -Verb RunAs`);
        tries.push(`$a = ${psArr(['/c', 'start', '""', 'wt.exe', ...wtArgs])}; `
            + `Start-Process -FilePath 'cmd.exe' -ArgumentList $a -Verb RunAs`);
    }
    tries.push(`$a = ${psArr(hubArgs)}; Start-Process -FilePath ${psq(process.execPath)} `
        + `-ArgumentList $a -Verb RunAs -WorkingDirectory ${psq(L.ROOT)}`);
    return tries;
}

function relaunchElevated(argv) {
    if (!L.IS_WIN) return false;
    for (const cmd of elevateCommands(argv)) {
        const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore', windowsHide: true });
        if (r.status === 0) return true;
    }
    return false;
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

    // 3б. Бэкенд куки — от него зависит ТОЧНЫЙ баланс шлюзов, и больше ничего.
    // 🪤 Зачем отдельный вердикт: `better-sqlite3` — нативный модуль, он лежит в
    // package.json, ставится вместе со всеми и при этом умеет молча не собраться под
    // конкретную версию Node. Отказ виден только в подсказке на бейдже баланса внутри
    // вкладки шлюза — то есть человек видит «прикидку» и не имеет ни одной причины
    // связать её со сборкой модуля. Ровно так 30.08 встал второй пользователь на свежей
    // установке: вошёл в ЛК, как сказано, а баланс остался прикидкой.
    try {
        const na = require(path.join(L.ROOT, 'routing', 'lib', 'newapi-account.js'));
        const cb = na.cookieBackendReady ? na.cookieBackendReady() : { ok: true };
        cb.ok
            ? good('бэкенд куки готов', 'точный баланс шлюзов доступен')
            : warn('better-sqlite3 не загружается — баланс останется ПРИКИДКОЙ',
                `${cb.error} · лечится: npm rebuild better-sqlite3`);
    } catch (e) {
        warn('не удалось проверить бэкенд куки', String(e.message).slice(0, 90));
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

    const acts = [
        { key: '1', label: 'Установить и включить', hint: 'скопировать, запустить, автозагрузка + сторож', act: 'install' },
        { key: '2', label: 'Выключить', hint: 'погасить по PID, снять ярлык и задачу; файлы оставить', act: 'disable' },
        { key: '3', label: 'Удалить полностью', hint: 'то же плюс удалить файлы рабочей папки', act: 'remove' },
        { key: 'q', label: 'Назад', hint: '', act: '' },
    ];

    // Кадр рисуется целиком только при входе и после действия — состояние фикса между
    // нажатиями стрелок не меняется, а D.state() лезет в планировщик и в список
    // процессов. Раньше кадр перерисовывался на каждое нажатие (владелец 25.08:
    // «на стрелочке жмёшь, обновляется опять текст»).
    const draw = () => {
        clearScreen();
        const s = D.state();
        const mark = ok => (ok ? OK() : grey(DOT_OFF));

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
        for (const [i, a] of acts.entries()) line(itemLine(a, i === sel));
        line(dim('  ↑↓ выбрать · Enter · цифра — сразу · q назад'));
    };

    let needFull = true;
    for (;;) {
        if (needFull) { draw(); needFull = false; }

        const k = await readKey();
        const name = keyName(k);

        // Те же две строки, что в главном меню: снятая и надетая. Ничего больше не
        // трогаем, поэтому логотип и состояние не мигают.
        const move = dir => {
            const prev = sel;
            sel = (sel + dir + acts.length) % acts.length;
            if (!TTY) return;
            for (const i of [prev, sel]) {
                const upBy = acts.length - i + 1;       // +1 — строка подсказки
                out(`\x1b[${upBy}A`);
                eraseLine();
                out(itemLine(acts[i], i === sel));
                out(`\r\x1b[${upBy}B`);
            }
        };

        // Стрелки тут работают так же, как в главном меню: до 25.08 их не было вовсе,
        // и экран управлялся только цифрами — владелец: «нет управления на стрелочках
        // и кнопка Q не работает назад».
        if (name === 'up' || name === 'k') { move(-1); continue; }
        if (name === 'down' || name === 'j') { move(1); continue; }
        if (name === 'q' || name === 'escape' || (name === 'c' && k.ctrl)) return true;

        let pick = null;
        if (name === 'return' || name === 'enter' || name === 'space') pick = acts[sel];
        else pick = acts.find(a => a.key === name);
        if (!pick) continue;
        if (!pick.act) return true;                      // «Назад» выбрано Enter'ом
        const act = pick.act;

        // Выключение и удаление трогают автозагрузку и планировщик — спрашиваем.
        if (act !== 'install' && !(await confirm(act === 'remove' ? 'Удалить фикс полностью?' : 'Выключить фикс?', false))) { needFull = true; continue; }

        line();
        const r = D[act]();
        for (const st of r.steps) line(`  ${st.ok ? OK() : NO()} ${st.what}${st.note ? dim('  ' + st.note) : ''}`);
        line();
        line(r.ok ? `  ${green('готово')}` : `  ${red('сделано не всё — смотри строки выше')}`);
        if (act === 'install' && r.ok) {
            line(`  ${dim('проверить живьём: надиктуй фразу в панель Orca, ничего не нажимая — текст должен приехать')}`);
        }
        await pause('Enter — вернуться к состоянию фикса');
        needFull = true;                                 // состояние изменилось — кадр заново
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
//
// 🪤 Сюда же приходят события фокуса окна (ESC[I / ESC[O от DECSET 1004) — их нужно
// отдать капели и ПРОДОЛЖИТЬ ждать клавишу, а не вернуть как нажатие: иначе щелчок
// мышью по другому окну выглядел бы для меню как нажатая кнопка.
function readKey() {
    return new Promise(resolve => {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        const onKey = (str, key) => {
            const seq = (key && key.sequence) || str || '';
            if (seq === '\x1b[I' || seq === '\x1b[O') {
                if (focusHook) focusHook(seq === '\x1b[I');
                return;                                   // ждём дальше
            }
            process.stdin.removeListener('keypress', onKey);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve(key || { name: str });
        };
        process.stdin.on('keypress', onKey);
    });
}

// Русская раскладка. readline для кириллицы отдаёт `key.name === undefined` — то есть
// на «й» вместо `q` приходило пустое имя, и ни выход, ни vim-клавиши не работали
// (владелец 25.08: «на русском не работают хоткей»). Переводим нажатие по ФИЗИЧЕСКОЙ
// клавише, а не по букве: ЙЦУКЕН лежит на QWERTY один в один.
const RU_TO_EN = {
    'й': 'q', 'ц': 'w', 'у': 'e', 'к': 'r', 'е': 't', 'н': 'y', 'г': 'u', 'ш': 'i', 'щ': 'o', 'з': 'p',
    'ф': 'a', 'ы': 's', 'в': 'd', 'а': 'f', 'п': 'g', 'р': 'h', 'о': 'j', 'л': 'k', 'д': 'l', 'ж': ';',
    'я': 'z', 'ч': 'x', 'с': 'c', 'м': 'v', 'и': 'b', 'т': 'n', 'ь': 'm', 'б': ',', 'ю': '.',
};

// Имя нажатой клавиши, приведённое к латинице. Единственная точка, где разбирается
// раскладка: экраны сравнивают уже нормализованное имя.
function keyName(k) {
    if (!k) return '';
    const seq = String(k.sequence || '').toLowerCase();
    return RU_TO_EN[seq] || k.name || '';
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
    const mark = on ? cyan(CURSOR) : ' ';
    const label = on ? bold(e(97, it.label)) : it.label;
    return `  ${mark} ${dim('[' + it.key + ']')} ${label}${it.hint ? dim('  — ' + it.hint) : ''}`;
}

// Строка под меню в безопасном наборе: человек обязан узнать, ПОЧЕМУ шапка не такая, как
// на скриншотах в README, и что с этим делать. Без неё упрощённая картинка читается как
// собственная поломка — «у меня почему-то по-другому», а именно с этого вопроса всё и
// началось. В Windows Terminal строки нет вообще.
//
// 🪤 Форма зависит от ширины: перенос строки добавил бы кадру высоту, которой layout()
// не считал, а он считает подсказку одной строкой.
function safeHint() {
    if (!SAFE) return null;
    return dim(W() >= 96
        ? '  шапка упрощена: в шрифте окна нет брайля · winget install Microsoft.WindowsTerminal'
        : '  шапка упрощена: в шрифте окна нет брайля · нужен Windows Terminal');
}

async function menu() {
    hideCursor();
    process.on('exit', () => { showCursor(); if (TTY) out(FOCUS_OFF); });
    let sel = 0;
    const items = menuItems();

    // Полный кадр рисуется ТОЛЬКО когда содержимое действительно изменилось: при входе
    // и после выполнения пункта. Раньше он перерисовывался на каждое нажатие, и это
    // выглядело как мигание всего экрана (владелец 25.08: «не нравится, что при каждом
    // клике происходит переотрисовка»). Плюс каждая перерисовка звала netstat — 112 мс
    // на стрелку впустую.
    let needFull = true;
    // Сколько строк напечатано ПОД меню. Обычно одна — подсказка по клавишам; в
    // безопасном наборе вместе с картинкой ещё одна, про упрощённую шапку. Это число
    // нужно точечной перерисовке: она поднимается курсором на нужную строку, и ошибка
    // на единицу стирает не пункт меню, а подсказку.
    let below = 1;

    for (;;) {
        if (needFull) {
            if (dripStop) dripStop();
            clearScreen();
            const { art: A, panel, withArt, compact, tip: wantTip } = layout();
            const headerRows = await intro();             // проявление по точкам
            const belowFrom = printedLines;
            statusBlock({ compact });
            if (!compact) line();
            for (const [i, it] of items.entries()) line(itemLine(it, i === sel));
            line(dim('  ↑↓ выбрать · Enter запустить · цифра — сразу · q выход'));
            const tip = wantTip ? safeHint() : null;
            if (tip) line(tip);
            below = 1 + (tip ? 1 : 0);
            needFull = false;
            // Капель и мерцание суммы заводятся ПОСЛЕ кадра: им нужно знать, сколько
            // строк под шапкой, а мерцанию — ещё и где именно стоят цифры.
            if (withArt) startDrip(A, printedLines - belowFrom, headerRows, panel.digitsAt);
        }

        const k = await readKey();
        const name = keyName(k);

        // Перерисовка ровно двух строк: снятая и надетая. Курсор поднимается на нужную
        // строку, стирает её и печатает БЕЗ перевода строки, потом возвращается вниз —
        // поэтому кадр не дёргается вообще.
        const move = dir => {
            const prev = sel;
            sel = (sel + dir + items.length) % items.length;
            if (!TTY) return;
            for (const i of [prev, sel]) {
                const upBy = items.length - i + below;   // строки под меню: подсказка (+ упрощение)
                out(`\x1b[${upBy}A`);
                eraseLine();
                out(itemLine(items[i], i === sel));
                out(`\r\x1b[${upBy}B`);
            }
        };

        if (name === 'up' || name === 'k') { move(-1); continue; }
        if (name === 'down' || name === 'j') { move(1); continue; }
        if (name === 'c' && k.ctrl) { if (dripStop) dripStop(); showCursor(); process.exit(0); }
        let pick = null;
        if (name === 'return' || name === 'enter' || name === 'space') pick = items[sel];
        else pick = items.find(it => it.key === name);
        if (!pick) continue;

        // Капель гасим до операции: она рисует по абсолютной позиции кадра, а вывод
        // операции этот кадр сдвинет. Плюс на время дочерних процессов со stdio inherit
        // снимается focus reporting — иначе ESC[I/ESC[O улетали бы им в ввод.
        if (dripStop) dripStop();
        showCursor();
        clearScreen();
        await intro({ animate: false });        // шапка над выводом операции — без проявления
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
        const mark = r.up ? green(DOT_ON) : grey(DOT_OFF);
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
    line(dim('  флаги: --no-open (не открывать браузер), HUB_PLAIN=1 (без ANSI),'));
    line(dim('         HUB_SAFE_GLYPHS=1 (шапка глифами старого conhost), =0 (выключить подмену)'));
}

// Переехать в Windows Terminal, если хаб запустили в старом conhost. Именно так
// выглядит «Запуск от имени администратора» из проводника: правый клик по HUB.bat даёт
// серое окно с другим шрифтом, потому что для элевированных запусков система берёт
// conhost, а не терминал по умолчанию (владелец 25.08 просил, чтобы окно администратора
// выглядело так же, как обычное).
//
// Элевацию НЕ запрашиваем: wt наследует права текущего процесса, то есть админский
// хаб останется админским, а обычный — обычным. Признак «мы уже в терминале» — переменная
// WT_SESSION, её ставит сам wt; плюс свой маркер HUB_IN_WT на случай, если её не будет,
// иначе вышла бы вечная цепочка окон. `HUB_NO_WT=1` выключает переезд совсем.
//
// 🪤 Переезжаем ТОЛЬКО из conhost, а не из любого не-WT терминала. Признак conhost —
// пустые `TERM` и `TERM_PROGRAM`: их не ставит никто, кроме терминалов, которые человек
// выбрал сам (git-bash, VS Code, WezTerm). Без этой проверки хаб выдёргивал бы себя из
// встроенного терминала редактора — и, что нашлось сразу, из pty регресса: тесты меню
// падали «за 12 с не увидели пунктов», потому что процесс честно уезжал в новое окно.
//
// И самое важное: пока новое окно не подало признаков жизни, СТАРОЕ не закрываем.
// Один раз это уже стоило владельцу рабочего хаба: `windowsHide` создавал окно скрытым,
// процесс жил невидимым, а консоль закрывалась — снаружи «HUB.bat не работает».
// Переехавший хаб трогает файл-маркер (`--wt-mark`), и только увидев его, мы уходим.
async function moveToWindowsTerminal() {
    if (!L.IS_WIN || !TTY) return false;
    if (process.env.WT_SESSION || process.env.HUB_IN_WT || process.env.HUB_NO_WT) return false;
    if (process.env.TERM || process.env.TERM_PROGRAM) return false;
    const wt = findWt();
    if (!wt) return false;

    const mark = path.join(L.LOG_DIR, '.wt-mark');
    try { fs.mkdirSync(L.LOG_DIR, { recursive: true }); fs.unlinkSync(mark); } catch { /* его и не было */ }

    // 🪤 `windowsHide` тут стоять НЕ ДОЛЖЕН, и это замерено: с ним новое окно создаётся
    // скрытым (видимых окон класса CASCADIA_HOSTING_WINDOW_CLASS до и после: `true` →
    // 0→0, `false` → 0→1). Флаг приехал копипастой из вызовов, где прятать надо.
    const r = spawnSync(wt, wtHubArgs('ABUSE HUB', [`--wt-mark=${mark}`]), {
        cwd: L.ROOT,
        stdio: 'ignore',
        env: { ...process.env, HUB_IN_WT: '1' },
    });
    if (r.status !== 0) return false;

    for (let i = 0; i < 40; i++) {                 // до 4 секунд
        if (fs.existsSync(mark)) return true;
        await sleep(100);
    }
    line();
    line(`  ${yellow('Окно Windows Terminal не отозвалось — остаюсь здесь.')}`);
    line(`  ${dim('выключить переезд совсем: HUB_NO_WT=1')}`);
    return false;
}

// Падение хаба обязано оставлять след. Раньше след терялся дважды: элевированное окно
// закрывалось вместе с процессом (владелец 25.08: «вылетал именно из внутрянки» —
// разбирать было нечего), а в не-TTY стек уходил в никуда. Теперь стек и в окно, и в
// `logs/hub/hub-crash.log`, а окно, открытое через HUB.bat, само делает pause.
function installCrashLog() {
    const dump = (kind, err) => {
        try { if (dripStop) dripStop(); } catch { /* уже снята */ }
        showCursor();
        const stack = (err && err.stack) || String(err);
        try {
            fs.mkdirSync(L.LOG_DIR, { recursive: true });
            fs.appendFileSync(path.join(L.LOG_DIR, 'hub-crash.log'),
                `\n=== ${new Date().toLocaleString('sv')} ${kind} · ${process.argv.slice(2).join(' ') || 'меню'}`
                + ` · права ${L.IS_WIN && L.isElevated() ? 'администратор' : 'обычные'} ===\n${stack}\n`);
        } catch { /* некуда писать — не повод молчать в окно */ }
        line();
        line(`  ${red('Хаб упал: ' + ((err && err.message) || err))}`);
        line(`  ${dim('стек целиком — logs/hub/hub-crash.log')}`);
        line();
        process.exit(1);
    };
    process.on('uncaughtException', e => dump('uncaughtException', e));
    process.on('unhandledRejection', e => dump('unhandledRejection', e));
}

// Аргументы для wt: запускаем не node напрямую, а HUB.bat. Разница не косметическая —
// bat держит окно открытым при ненулевом коде (`pause`), поэтому падение видно, а не
// «окно мигнуло и закрылось». Нет bat (запуск из клона без него) — зовём node.
function wtHubArgs(title, argv = []) {
    const bat = path.join(L.ROOT, 'HUB.bat');
    const run = fs.existsSync(bat)
        ? ['cmd.exe', '/c', bat, ...argv]
        : [process.execPath, __filename, ...argv];
    return ['-w', '-1', 'new-tab', '--title', title, ...run];
}

async function main() {
    installCrashLog();
    const argv = process.argv.slice(2);
    const open = !argv.includes('--no-open');
    const verb = argv.find(a => !a.startsWith('-'));

    // Метка «я и есть переехавшее окно»: её кладёт нам в аргументы прошлый процесс и
    // ждёт появления файла, прежде чем закрыть своё окно. Через окружение это передать
    // нельзя — wt.exe передаёт запуск живому процессу терминала, и env до ребёнка не
    // доезжает. Заодно метка сама служит защитой от повторного переезда.
    const markArg = argv.find(a => a.startsWith('--wt-mark='));
    if (markArg) {
        const mark = markArg.slice('--wt-mark='.length);
        try { fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, String(process.pid)); } catch { /* не критично */ }
    }

    if (argv.includes('--post-update')) {
        process.exit((await doPostUpdate({ interactive: argv.includes('--interactive') })) ? 0 : 1);
    }
    if (!verb) {
        // Без TTY меню рисовать некому (запуск из планировщика, из дашборда,
        // перенаправление в файл) — печатаем состояние и уходим с нулём.
        if (!TTY) { printStatus(); return; }
        // Переехавший экземпляр (у него есть метка) больше никуда не едет — он и есть
        // конечная точка.
        if (!markArg && await moveToWindowsTerminal()) return;
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

module.exports = {
    intro, statusBlock, menuItems, itemLine, art, artFits, layout, link, readArt,
    balancePanel, bigNum, findWt, elevateCommands, wtHubArgs, WISPR_ART_FILE, DOLLAR_FILE,
    SAFE, safeHint, ART_FILE, DIGITS,
};
