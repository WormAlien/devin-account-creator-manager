// ─────────────────────────────────────────────────────────────────────────────
//  internal/art-anim.js — анимация картинки в шапке хаба.
//
//  Два эффекта, оба по решению владельца 25.08:
//    reveal — «проявление» при входе в меню и при возврате из подменю, разово;
//    drip   — зелёная капель, постоянно, пока меню открыто.
//
//  Считаем по ТОЧКАМ, а не по символам. Картинка — брайль, и одна ячейка несёт
//  2×4 точки, биты которых лежат в самом коде символа (U+2800 + маска). Поэтому
//  капля может быть крупнее одной точки и падать плавно, а кадр остаётся дешёвым:
//  капель перерисовывает не строки, а только те ячейки, где капли сейчас есть или
//  были в прошлом кадре — десятки символов, не сотни.
//
//  🪤 Порядок точек в ячейке НЕ подряд: левый столбец сверху вниз это 1,2,3,7,
//  правый — 4,5,6,8. Сдвинуть точку вниз сдвигом байта нельзя, нужна таблица.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const BIT = [
    [0x01, 0x08],   // dy = 0
    [0x02, 0x10],   // dy = 1
    [0x04, 0x20],   // dy = 2
    [0x40, 0x80],   // dy = 3
];

// Разбор картинки в битовую карту + готовые символы ячеек (их отдаём при очистке
// клетки от капли — то есть возвращаем ровно тот символ, что был в файле).
function create(lines) {
    const cw = Math.max(...lines.map(l => [...l].length));
    const ch = lines.length;
    const w = cw * 2, h = ch * 4;
    const px = new Uint8Array(w * h);
    const cells = [];
    for (let cy = 0; cy < ch; cy++) {
        const row = [...lines[cy]];
        const codes = new Uint8Array(cw);
        for (let cx = 0; cx < cw; cx++) {
            const code = (row[cx] || ' ').codePointAt(0) - 0x2800;
            if (code < 0 || code > 0xff) continue;
            codes[cx] = code;
            for (let dy = 0; dy < 4; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    if (code & BIT[dy][dx]) px[(cy * 4 + dy) * w + cx * 2 + dx] = 1;
                }
            }
        }
        cells.push(codes);
    }
    return { w, h, cw, ch, px, cells, lines: lines.slice() };
}

const chr = code => String.fromCodePoint(0x2800 + code);

function encode(B, px) {
    const out = [];
    for (let cy = 0; cy < B.ch; cy++) {
        let s = '';
        for (let cx = 0; cx < B.cw; cx++) {
            let code = 0;
            for (let dy = 0; dy < 4; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    if (px[(cy * 4 + dy) * B.w + cx * 2 + dx]) code |= BIT[dy][dx];
                }
            }
            s += chr(code);
        }
        out.push(s);
    }
    return out;
}

// ── Проявление ───────────────────────────────────────────────────────────────
// Фронт идёт сверху вниз по РЯДАМ ТОЧЕК, а не по строкам: за спиной фронта
// картинка добирается до конца, в самом фронте точки зажигаются вразнобой —
// отсюда ощущение проявления, а не открывающихся жалюзи.
function reveal(B, { speed = 3.5, tail = 9 } = {}) {
    const px = new Uint8Array(B.px.length);
    let front = 0;
    return {
        next() {
            front += speed;
            const edge = Math.min(Math.ceil(front), B.h);
            for (let y = 0; y < edge; y++) {
                const solid = y < front - tail;
                for (let x = 0; x < B.w; x++) {
                    const i = y * B.w + x;
                    if (!B.px[i] || px[i]) continue;
                    if (solid || Math.random() < 0.4) px[i] = 1;
                }
            }
            const done = front > B.h + tail;
            if (done) px.set(B.px);            // финальный кадр — точно вся картинка
            return { lines: encode(B, px), done };
        },
    };
}

// ── Капель ───────────────────────────────────────────────────────────────────
// Картинка остаётся целой: капли — отдельный слой поверх. Капля не точка, а
// капсула `dw × dh` точек (по умолчанию 2×3, то есть на глаз заметный сгусток),
// у неё есть хвост в одну точку.
//
// Возвращаем не кадр, а РАЗНИЦУ по ячейкам: paint — что залить зелёным (символ
// уже смешан с картинкой, поэтому точки под каплей не пропадают), clear — что
// вернуть в исходный вид. Отсюда десятки символов на кадр вместо девяти строк.
function drip(B, { max = 9, dw = 2, dh = 3, chance = 0.3, vmin = 0.7, vmax = 1.9 } = {}) {
    // Капля отрывается только от точки, под которой пустота: иначе она выныривает
    // из середины заливки, и это читается как дырка в картинке, а не как капля.
    const edges = [];
    for (let y = 0; y < B.h - 1; y++) {
        for (let x = 0; x < B.w; x++) {
            if (B.px[y * B.w + x] && !B.px[(y + 1) * B.w + x]) edges.push([x, y]);
        }
    }
    const drops = [];
    let prev = new Map();

    return {
        alive: () => drops.length,
        next() {
            if (drops.length < max && edges.length && Math.random() < chance) {
                const [x, y] = edges[Math.floor(Math.random() * edges.length)];
                drops.push({ x: Math.min(x, B.w - dw), y: y + 1, v: vmin + Math.random() * (vmax - vmin) });
            }

            const now = new Map();
            const put = (dx, dy) => {
                if (dx < 0 || dx >= B.w || dy < 0 || dy >= B.h) return;
                const cx = dx >> 1, cy = dy >> 2;
                const key = cy * B.cw + cx;
                const base = now.get(key);
                now.set(key, (base === undefined ? B.cells[cy][cx] : base) | BIT[dy & 3][dx & 1]);
            };

            for (let k = drops.length - 1; k >= 0; k--) {
                const d = drops[k];
                d.y += d.v;
                if (d.y - dh > B.h) { drops.splice(k, 1); continue; }
                const top = Math.floor(d.y);
                for (let dy = 0; dy < dh; dy++) for (let dx = 0; dx < dw; dx++) put(d.x + dx, top + dy);
                put(d.x + (dw >> 1), top - 1);                  // хвост
            }

            // Ячейки, которые капля покинула, возвращаем в исходный символ.
            const clear = [];
            for (const key of prev.keys()) {
                if (now.has(key)) continue;
                const cy = Math.floor(key / B.cw), cx = key % B.cw;
                clear.push({ cy, cx, ch: chr(B.cells[cy][cx]) });
            }
            const paint = [];
            for (const [key, code] of now) {
                const cy = Math.floor(key / B.cw), cx = key % B.cw;
                paint.push({ cy, cx, ch: chr(code) });
            }
            prev = now;
            return { paint, clear };
        },
    };
}

module.exports = { create, encode, reveal, drip, BIT };
