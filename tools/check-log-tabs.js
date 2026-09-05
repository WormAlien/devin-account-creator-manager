#!/usr/bin/env node
// Четыре трубы в панели логов вместо двух (25.08).
//
// Зачем разделяли: «Server logs» были общими для дашборда и SSE-прокси, а keepalive
// логирует каждый ping — кольцо на 400 строк он затапливал за секунды, и разобрать
// прогон автоподарка было физически нечем. Теперь: 🔔 уведомления, «Дашборд» (без
// прокси), «SSE» (только прокси) и 🎁 (файлы прогонов logs/ar-checkin-*.log).
//
// Запуск: node tools/check-log-tabs.js
'use strict';
const fs = require('fs');
const path = require('path');

const lf = (s) => s.replace(/\r\n/g, '\n');
const HTML = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8'));
const PROXY = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8'));

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
const cutFn = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? undefined : j + 2);
};

// ── 1. разметка: четыре кнопки, у каждой подсказка ──
for (const id of ['toasts', 'server', 'keepalive', 'gift']) {
    check(new RegExp(`id="log-tab-${id}"[^>]*onclick="setLogMode\\('${id}'\\)"`).test(HTML), `кнопка вкладки ${id} на месте`);
}
const tabsRow = HTML.slice(HTML.indexOf('id="log-tab-toasts"'), HTML.indexOf('id="log-box"'));
check((tabsRow.match(/title="/g) || []).length >= 4, 'у всех четырёх кнопок есть подсказка (подписи короткие)');

// ── 2. фронт рулит вкладками через один реестр, а не набором if ──
check(/const LOG_TABS = \{/.test(HTML), 'описание вкладок собрано в LOG_TABS');
const tabsDecl = HTML.slice(HTML.indexOf('const LOG_TABS = {'), HTML.indexOf('let giftRuns'));
for (const k of ['toasts', 'server', 'keepalive', 'gift']) {
    check(new RegExp(`${k}:\\s*\\{`).test(tabsDecl), `LOG_TABS знает вкладку ${k}`);
}
check(/src: 'dash'/.test(tabsDecl) && /src: 'keepalive'/.test(tabsDecl),
    'дашборд и SSE тянут РАЗНЫЕ выборки (src)');
check(/toasts:\s*\{[^}]*poll: 0/.test(tabsDecl), 'уведомления сеть не гоняют (poll: 0)');
const setMode = cutFn(HTML, 'function setLogMode(');
check(/for \(const k of Object\.keys\(LOG_TABS\)\)/.test(setMode),
    'подсветка вкладок идёт циклом по реестру — добавление пятой не потребует правок');
check(/LOG_TABS\[logMode\]\.title/.test(setMode), 'полное имя вкладки уезжает в заголовок панели');
check(/startLogPoll\(\)/.test(setMode) && /serverLogLines = \[\]/.test(setMode),
    'смена вкладки перезапускает опрос и не показывает чужие строки');
const poll = cutFn(HTML, 'function startLogPoll(');
check(/tab\.poll/.test(poll) && /pollGiftLogs/.test(poll) && /pollServerLogs/.test(poll),
    'один опросчик на все вкладки, интервал из реестра');

// ── 3. бэкенд: разделение общей трубы ──
const logsHandler = PROXY.slice(PROXY.indexOf("startsWith('/__switch/api/logs')"), PROXY.indexOf("/__switch/api/logs/ingest"));
check(/src === 'dash'/.test(logsHandler) && /INGEST_TAG_RE/.test(logsHandler),
    'выборка «только дашборд» отбивает строки прокси по префиксу');
check(/tags\[/.test(logsHandler), 'бэкенд считает, сколько строк у какого источника');
check(/src === 'all'/.test(logsHandler), 'режим «всё вместе» сохранён — прежнее поведение не сломано');

// Классификация строк: то, на чём держится разделение.
const tagRe = new RegExp(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[([\w.@-]+)\]/);
check(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \\\[\(\[\\w\.@-\]\+\)\\\]/.test(String(PROXY.match(/const INGEST_TAG_RE = (.+);/)[1]).replace(/^\//, '').replace(/\/$/, ''))
    || /INGEST_TAG_RE = \/\^\\\[/.test(PROXY), 'INGEST_TAG_RE объявлен в прокси');
{
    const dash = '[12:23:32.514] agentrouter чек-ин [acct_ar_1]: готово';
    const ka = '[12:23:32.514] [keepalive] POST /v1/messages ping #2';
    check(!tagRe.test(dash), 'строка дашборда со скобками ВНУТРИ текста за прокси не считается');
    const m = tagRe.exec(ka);
    check(!!m && m[1] === 'keepalive', 'строка прокси распознаётся по префиксу сразу после метки времени');
}

// ── 4. бэкенд: файлы прогонов подарка ──
const giftHandler = PROXY.slice(PROXY.indexOf("startsWith('/__switch/api/ar/checkin-logs')"), PROXY.indexOf("startsWith('/__switch/api/ar/checkin-logs')") + 2200);
check(/CHECKIN_LOG_RE\.test\(file\)/.test(giftHandler), 'имя файла проверяется ДО обращения к диску');
check(giftHandler.indexOf('CHECKIN_LOG_RE.test(file)') < giftHandler.indexOf('path.join(dir, file)'),
    'проверка стоит раньше path.join — иначе параметр из браузера читал бы что угодно');
check(/\.sort\(\(a, b\) => b\.at - a\.at\)/.test(giftHandler), 'прогоны отдаются новыми сверху');
{
    const nameRe = new RegExp(/^ar-checkin-[\w.-]+\.log$/);
    check(nameRe.test('ar-checkin-acct_ar_1786714708322_4-2026-08-24T22-47-18.log'), 'настоящее имя прогона проходит');
    for (const bad of ['../settings.json', 'ar-checkin-../../x.log', 'ar-checkin-a.log.bak', 'settings.json']) {
        check(!nameRe.test(bad), `не проходит: ${bad}`);
    }
}

// ── 5. вид вкладки прогонов ──
const render = cutFn(HTML, 'function renderLogPanel(');
check(/logMode === 'server' \|\| logMode === 'keepalive'/.test(render), 'текстовые трубы рисуются одним путём');
check(/giftPickRun\(this\.value\)/.test(render), 'прогон выбирается селектом');
check(/AUTOCHECKIN_RESULT/.test(render), 'ключевые строки прогона подсвечены');
const clear = cutFn(HTML, 'function clearLog(');
check(/logMode === 'gift'/.test(clear) && /giftLines = \[\]/.test(clear) && !/unlink|delete/i.test(clear),
    '«Очистить» на вкладке прогонов чистит вид, а файлы на диске не трогает');

// ── 6. панель свёрнута по умолчанию (решение владельца 05.09) ──
// 🪤 Раньше на DOMContentLoaded висел САМ `toggleLogPanel` с комментарием «open by
// default»: он переключает, то есть из закрытой панели делал открытую на каждой загрузке,
// и свернуть её насовсем было нельзя вообще. Плюс открытая панель включает поллинг логов.
check(/<div id="log-panel" class="hidden/.test(HTML),
    'разметка панели логов начинается с hidden — до любого JS она свёрнута');
check(!/DOMContentLoaded', toggleLogPanel\)/.test(HTML),
    'на DOMContentLoaded НЕ висит сам toggleLogPanel — он переключает, а не восстанавливает');
check(/DOMContentLoaded', restoreLogPanel\)/.test(HTML),
    'на загрузке зовётся restoreLogPanel — читает сохранённое состояние');
const restore = cutFn(HTML, 'function restoreLogPanel(');
check(/_lsGet\(LOG_PANEL_LS\) === '1'/.test(restore),
    'разворачивается только при явном \'1\' в хранилище — отсутствие ключа значит свёрнуто');
const toggle = cutFn(HTML, 'function toggleLogPanel(');
check(/_lsSet\(LOG_PANEL_LS, logPanelOpen \? '1' : '0'\)/.test(toggle),
    'выбор владельца сохраняется — свернул значит свернул, F5 не возвращает');
check(/stopLogPoll\(\)/.test(toggle),
    'при сворачивании поллинг логов останавливается — иначе свёрнутая панель продолжала бы гонять сеть');

console.log(fail ? `\n❌ ${fail} провалено` : '\nПанель логов: четыре трубы, прогоны подарка читаются из файлов, по умолчанию свёрнута.');
process.exit(fail ? 1 : 0);
