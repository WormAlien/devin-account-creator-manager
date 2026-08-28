#!/usr/bin/env node
/*
 * make-art-blocks.js — пересобрать шапку хаба глифами, которые есть в шрифтах
 * старого conhost.
 *
 * Зачем. Картинка `internal/hub-art.txt` нарисована брайлем (U+2800…28FF), и это
 * правильный выбор: 2×4 точки на ячейку — вчетверо больше вертикального
 * разрешения, чем у полублоков. Но conhost предлагает ровно два шрифта, Consolas
 * и Lucida Console, и брайля нет ни в одном (замер по `CharacterToGlyphMap`
 * файлов шрифтов, а не на глаз) — у человека без Windows Terminal вместо шапки
 * стена одинаковых квадратов. Отсюда второй файл: та же картинка символами
 * ` ░▒▓█▀▄`, которые есть в ОБОИХ шрифтах conhost'а.
 *
 * Почему генератором, а не рисованием заново: брайлевый арт — это и есть битмап
 * 130×36 точек, биты лежат в кодах символов. Пересчёт механический, значит
 * картинка не разъедется с оригиналом, когда владелец поменяет оригинал.
 *
 * Использование:
 *   node tools/make-art-blocks.js            # записать internal/hub-art-blocks.txt
 *   node tools/make-art-blocks.js --stdout   # только показать, ничего не писать
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'internal', 'hub-art.txt');
const DST = path.join(ROOT, 'internal', 'hub-art-blocks.txt');

// Раскладка точек в брайлевой ячейке: бит → [колонка, строка]. Порядок битов
// исторический (первые шесть — старый шеститочечный брайль, седьмой и восьмой
// дописаны снизу), поэтому таблицей, а не арифметикой.
const BITS = [
    [0, 0], [0, 1], [0, 2],   // 0x01 0x02 0x04 — левая колонка, строки 0..2
    [1, 0], [1, 1], [1, 2],   // 0x08 0x10 0x20 — правая колонка, строки 0..2
    [0, 3], [1, 3],           // 0x40 0x80 — нижняя строка, слева и справа
];

// Ячейка → символ. Считаем точки в верхней половине (строки 0–1) и в нижней
// (строки 2–3), каждая половина это 2×2 точки, то есть 0..4.
//
// 🪤 Полутон и полублок — взаимоисключающие способы соврать. `▀` говорит «верх
// закрашен целиком», `▒` — «закрашено примерно поровну везде». Если половина
// заполнена одной точкой из четырёх, `▀` раздувает её вчетверо и картинка
// заплывает; если заполнена полностью, `▒` её растворяет. Поэтому полублоки
// только на явном перекосе (одна половина пустая, другая набрана), в остальном
// плотность.
function cellChar(top, bottom) {
    if (!top && !bottom) return ' ';
    if (!bottom) return top >= 2 ? '▀' : '░';
    if (!top) return bottom >= 2 ? '▄' : '░';
    const sum = top + bottom;
    if (sum <= 2) return '░';
    if (sum <= 4) return '▒';
    if (sum <= 6) return '▓';
    return '█';
}

function convert(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
    const out = [];
    for (const [y, line] of lines.entries()) {
        let row = '';
        for (const [x, ch] of [...line].entries()) {
            const code = ch.codePointAt(0) - 0x2800;
            if (code < 0 || code > 0xff) {
                throw new Error(`не брайль в строке ${y + 1}, символ ${x + 1}: ${JSON.stringify(ch)} `
                    + `(U+${ch.codePointAt(0).toString(16).toUpperCase()})`);
            }
            let top = 0, bottom = 0;
            for (const [bit, [, dy]] of BITS.entries()) {
                if (!(code & (1 << bit))) continue;
                if (dy <= 1) top++; else bottom++;
            }
            row += cellChar(top, bottom);
        }
        // Хвостовые пробелы снимаем: ширину картинки считает `layout()` по самой
        // длинной строке, и невидимый хвост раздувал бы её, отбирая колонки у
        // панели баланса справа.
        out.push(row.replace(/ +$/, ''));
    }
    return out;
}

const src = fs.readFileSync(SRC, 'utf8');
const rows = convert(src);
const text = rows.join('\n') + '\n';

if (process.argv.includes('--stdout')) {
    process.stdout.write(text);
} else {
    fs.writeFileSync(DST, text, 'utf8');
    const w = Math.max(...rows.map(l => [...l].length));
    console.log(`${path.relative(ROOT, DST)}: ${rows.length} строк × ${w} символов`);
}
