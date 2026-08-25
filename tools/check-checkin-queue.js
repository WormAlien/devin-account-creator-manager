#!/usr/bin/env node
// Очередь чек-инов: залп по кнопкам ⚡/🎁 не отбивается, а идёт конвейером (25.08).
//
// Было: три окна сразу, четвёртый клик — 429 «уже открыто 3 браузера». Плюс шлюз ловил
// нас на частоте и выключал точный баланс всему пулу. Стало: один прогон за раз плюс
// пауза между стартами; клик отвечает «N в очереди, старт через ~Xс».
//
// Запуск: node tools/check-checkin-queue.js
'use strict';
const fs = require('fs');
const path = require('path');

const lf = (s) => s.replace(/\r\n/g, '\n');
const PROXY = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8'));
const HTML = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8'));

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

// ── 1. отказа больше нет ──
check(!/уже открыто \$\{alive\.length\} браузеров/.test(PROXY), 'ответ 429 «уже открыто N браузеров» убран');
check(/AR_CHECKIN_QUEUE/.test(PROXY), 'очередь есть');
check(/queued: true/.test(PROXY), 'клик получает ответ «в очереди», а не ошибку');

// ── 2. один за раз + пауза ──
const gap = Number((PROXY.match(/const AR_CHECKIN_GAP_MS = ([\d_]+)/) || [])[1]?.replace(/_/g, ''));
check(gap >= 10_000, `пауза между прогонами не меньше 10 с (получили ${gap / 1000}с)`);
const busy = cutFn(PROXY, 'function arCheckinBusy(');
check(/arLkPids\.values\(\)/.test(busy) && /some\(/.test(busy),
    'занятость считается по ЛЮБОМУ живому окну ЛК, а не только по чек-инам');
const wait = cutFn(PROXY, 'function arCheckinWaitMs(');
check(/arCheckinBusy\(\)/.test(wait) && /arCheckinLastStart/.test(wait),
    'ждём и закрытия окна, и остатка паузы после прошлого старта');
const pump = cutFn(PROXY, 'function arCheckinPump(');
check(/AR_CHECKIN_QUEUE\.shift\(\)/.test(pump), 'очередь разбирается по одному, FIFO');
check(/setTimeout\(arCheckinPump/.test(pump), 'если ждать — насос сам просыпается');
check(/unref/.test(pump), 'таймер не держит процесс');
check(/st\.state === 'queued'/.test(pump) && /position/.test(pump),
    'пока стоим в очереди, статус обновляет позицию и время до старта');

// ── 3. спавн один на два пути ──
const spawnFn = cutFn(PROXY, 'function arSpawnSession(');
check(/spawn\(process\.execPath/.test(spawnFn), 'спавн вынесен в общую функцию');
check(/arCheckinPump\(\)/.test(spawnFn) && /arCheckinLastStart = Date\.now\(\)/.test(spawnFn),
    'после закрытия окна насос берёт следующего, отметка старта обновляется');
check(/arAutoCheckinFinish\(/.test(spawnFn) && /newapiRecheckAfterLk\('ar', id\)/.test(spawnFn),
    'хвосты обоих режимов (чек-ин и обычный визит) на месте');
{
    // Дублей спавна open-session в обработчике остаться не должно.
    const handler = PROXY.slice(PROXY.indexOf('async function handleArSessionOpen('), PROXY.indexOf('async function handleArAdd('));
    check(!/spawn\(process\.execPath/.test(handler), 'в обработчике своей копии спавна нет');
    check((handler.match(/arSpawnSession\(/g) || []).length === 2,
        'обработчик зовёт общий спавн ровно в двух местах (чек-ин без ожидания и обычный визит)');
}

// ── 4. фронт: ждёт очередь, а не сдаётся ──
const watch = cutFn(HTML, 'async function arCheckinWatch(');
check(/run\.state === 'queued'/.test(watch), 'наблюдатель понимает состояние queued');
check(/until = Date\.now\(\) \+ maxMs/.test(watch),
    'пока стоим в очереди, таймаут не течёт — иначе пятый аккаунт сдался бы до старта');
check(/toldQueued/.test(watch), 'про очередь сообщается один раз, а не каждые 3 с');
check(/data\.queued/.test(HTML), 'клик показывает позицию в очереди');
check((HTML.match(/data\.queued/g) || []).length >= 2, 'и ⚡, и 🎁 говорят про очередь');

console.log(fail ? `\n❌ ${fail} провалено` : '\nОчередь чек-инов: по одному, с паузой, без отказов.');
process.exit(fail ? 1 : 0);
