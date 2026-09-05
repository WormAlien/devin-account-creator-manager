#!/usr/bin/env node
// Локальные копии внешних ресурсов дашборда (05.09).
//
// Зачем проверка: раньше старт `:8200` ждал четыре чужих хоста — unpkg.com (Tailwind,
// 282 КБ), cdn.jsdelivr.net (Sortable), fonts.googleapis.com и fonts.gstatic.com (Geist).
// Без сети страница открывалась БЕЗ ВЁРСТКИ вообще: Tailwind тут собирает CSS в браузере
// из `<style type="text/tailwindcss">`, и когда его скрипт не пришёл, не применяется ни
// один класс. Теперь всё в `routing/vendor/` и коммитится.
//
// 🪤 Главный риск не в коде, а в файлах: ссылка на `/vendor/…` остаётся, а файл не
// доезжает (забыли добавить в git, снесли при уборке, переименовали). Симптом тот же —
// дашборд без вёрстки, — но причина другая. Поэтому здесь проверяется СУЩЕСТВОВАНИЕ
// каждого файла, на который ссылаются HTML и fonts.css, а не только текст ссылок.
//
// Запуск: node tools/check-vendor-assets.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const HTML = R('routing/proxy-dashboard.html');
const PROXY = R('routing/transparent-proxy.js');
const HEAD_RAW = HTML.slice(0, HTML.indexOf('</head>') + 7);
// 🪤 Комментарии вырезаем ДО проверок. В шапке стоит пояснение, зачем вендорили, и в нём
// перечислены те самые хосты — «в <head> нет unpkg.com» краснело на собственном
// комментарии. Та же грабля, что с `arSettingsModel()` в сверке «зовут ↔ объявлено».
const HEAD = HEAD_RAW.replace(/<!--[\s\S]*?-->/g, '');

let fail = 0;
const check = (ok, what) => { console.log(`   ${ok ? '·' : '×'} ${what}`); if (!ok) fail++; };

console.log('\n== check-vendor-assets: дашборд не зависит от интернета на старте ==\n');

// ── 1. в <head> не осталось чужих хостов ──
console.log('── <head> ──');
for (const host of ['unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']) {
    check(!HEAD.includes(host), `в <head> нет ${host}`);
}
check(!/rel="preconnect"/.test(HEAD), 'preconnect-ов не осталось — соединять больше не с кем');
// Tailwind собирает CSS из inline-блока, поэтому обязан быть ДО него и без defer/async:
// иначе первый рендер уйдёт без классов и страница мигнёт нестилизованной.
const twIdx = HEAD.indexOf('/vendor/tailwindcss-browser-4.js');
const styleIdx = HEAD.indexOf('<style type="text/tailwindcss">');
check(twIdx > 0 && styleIdx > twIdx, 'скрипт Tailwind стоит ДО блока text/tailwindcss');
check(!/vendor\/tailwindcss-browser-4\.js"[^>]*\b(defer|async)\b/.test(HEAD),
    'у скрипта Tailwind нет defer/async — он нужен до первого рендера');

// ── 2. каждый /vendor/… из HTML лежит на диске ──
console.log('\n── файлы, на которые ссылается HTML ──');
const refs = [...HEAD.matchAll(/(?:src|href)="\/vendor\/([^"]+)"/g)].map((m) => m[1]);
check(refs.length >= 3, `ссылок на /vendor/ найдено ${refs.length} (Tailwind, Sortable, шрифты)`);
for (const rel of refs) {
    check(fs.existsSync(path.join(ROOT, 'routing', 'vendor', rel)), `есть файл routing/vendor/${rel}`);
}

// ── 3. fonts.css: только локальные пути, и все файлы на месте ──
console.log('\n── routing/vendor/fonts.css ──');
const CSS = R('routing/vendor/fonts.css');
check(!/https?:\/\//.test(CSS), 'в fonts.css не осталось ни одного внешнего URL');
const faces = (CSS.match(/@font-face/g) || []).length;
check(faces >= 8, `начертаний ${faces} (Geist 400/500/600/700 + Mono 400/500/600 × latin/cyrillic)`);
check(/unicode-range/.test(CSS), 'unicode-range сохранён — иначе браузер тянет ВСЕ файлы, а не нужный');
const woff = [...CSS.matchAll(/url\(\/vendor\/([^)]+\.woff2)\)/g)].map((m) => m[1]);
check(woff.length === faces, `у каждого начертания свой woff2 (${woff.length})`);
let missing = 0;
for (const rel of woff) if (!fs.existsSync(path.join(ROOT, 'routing', 'vendor', rel))) missing++;
check(missing === 0, missing ? `НЕ ХВАТАЕТ ${missing} файлов шрифтов` : 'все файлы шрифтов на месте');
// Кириллица обязательна: интерфейс русский, и без неё текст уедет в системный фолбэк.
check(woff.some((f) => /cyrillic/.test(f)), 'кириллическое подмножество вендорено');

// ── 4. маршрут /vendor/* и его страж ──
console.log('\n── маршрут в transparent-proxy.js ──');
check(/req\.url\.startsWith\('\/vendor\/'\)/.test(PROXY), 'маршрут /vendor/* зарегистрирован');
check(/VENDOR_MIME/.test(PROXY) && /'\.woff2': 'font\/woff2'/.test(PROXY),
    'типы отдаются по белому списку расширений, а не угадываются');
check(/p === '\.\.'/.test(PROXY), 'путь с `..` отбивается — маршрут отдаёт файлы по имени из URL');
check(/path\.basename\(p\)/.test(PROXY), 'каждый сегмент прогоняется через basename — вторая линия против обхода');
check(/parts\.length > 2/.test(PROXY), 'глубже одного подкаталога (fonts/) не пускаем');
check(/max-age=31536000, immutable/.test(PROXY), 'кеш на год — файлы версионированы именем');

console.log(fail ? `\n❌ ${fail} провалено` : '\nВёрстка и шрифты локальные: старт не ждёт сеть.');
process.exit(fail ? 1 : 0);
