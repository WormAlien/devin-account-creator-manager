#!/usr/bin/env node
// Журнал подмен живёт в «Истории уведомлений», а не отдельной карточкой (24.08).
//
// Проверяем ровно то, что легко сломать при следующей правке:
//   1. карточки `#<p>-rotate-log` и функции renderMoneyRotateLog в дашборде больше нет;
//   2. на одну подмену приходится ОДНА строка истории — тост из sideDetectRotation убран;
//   3. повторный опрос статуса (каждые 10 с отдаёт те же 20 записей) историю не набивает;
//   4. штамп берётся из записи журнала, а не из момента импорта, и порядок newest-first.
//
// Запуск: node tools/check-rotate-history.js
'use strict';
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const src = fs.readFileSync(HTML, 'utf8');

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};

// ── 1. отдельной карточки не осталось ──
check(!/id="[a-z]{2}-rotate-log"/.test(src), 'контейнеров карточки #<p>-rotate-log в разметке нет');
check(!/renderMoneyRotateLog/.test(src), 'функции renderMoneyRotateLog и её вызовов нет');
check(!/Авторотация — последние подмены/.test(src), 'заголовка карточки в разметке нет');
check(/function moneyRotateToHistory\(/.test(src), 'журнал уезжает в историю через moneyRotateToHistory');

// ── 2. второго следа того же события нет ──
const detect = src.slice(src.indexOf('function sideDetectRotation('));
const detectBody = detect.slice(0, detect.indexOf('\n}\n') + 2);
check(!/toast\(/.test(detectBody), 'sideDetectRotation больше не бросает свой тост про подмену');
check(/return true;/.test(detectBody), 'признак подмены по-прежнему возвращается (форсирует перечитку статуса)');

// ── 3-4. поведение самой функции: дедуп, штамп, порядок ──
const fnStart = src.indexOf('const _moneyRotateSeen');
const fnEnd = src.indexOf('\n}', src.indexOf('function moneyRotateToHistory(')) + 2;
const fnSrc = src.slice(fnStart, fnEnd);
const reasonStart = src.indexOf('const MONEY_ROTATE_REASON');
const reasonSrc = src.slice(reasonStart, src.indexOf('};', reasonStart) + 2);

const sandbox = {
    state: { toastLog: [] },
    MONEY_PROVIDERS: { justwoker: { p: 'jw', label: 'JustWoker', sym: '$' } },
    moneyAutoLast: {},
    renders: 0,
};
const factory = new Function('state', 'MONEY_PROVIDERS', 'moneyAutoLast', 'renderLogPanel',
    `${reasonSrc}\n${fnSrc}\nreturn moneyRotateToHistory;`);
const moneyRotateToHistory = factory(
    sandbox.state, sandbox.MONEY_PROVIDERS, sandbox.moneyAutoLast,
    () => { sandbox.renders++; },
);

const T0 = Date.parse('2026-08-24T01:00:00Z');
sandbox.moneyAutoLast.justwoker = {
    enabled: true,
    recent: [
        { ts: new Date(T0 + 60_000).toISOString(), from: 'presentkid', to: 'creamyevoluti', balance: 80.35, reason: 'out-of-balance' },
        { ts: new Date(T0).toISOString(), from: 'greenpoor', to: 'presentkid', balance: 3.07, reason: 'zero-cache', needUsd: 5 },
    ],
};

moneyRotateToHistory('justwoker');
check(sandbox.state.toastLog.length === 2, `две подмены → две строки истории (получили ${sandbox.state.toastLog.length})`);
check(sandbox.renders === 1, 'панель перерисована один раз, а не на каждую строку');

const top = sandbox.state.toastLog[0];
check(top.t === T0 + 60_000, 'штамп взят из записи журнала, а не из момента импорта');
check(sandbox.state.toastLog[0].t > sandbox.state.toastLog[1].t, 'порядок newest-first — как у остальных тостов');
check(/JustWoker/.test(top.text) && /presentkid/.test(top.text) && /creamyevoluti/.test(top.text),
    'в строке видно шлюз, откуда и куда переехали');
check(/\$80\.35/.test(top.text), 'сумма на новом аккаунте попала в строку');
check(/нет баланса/.test(top.text), 'причина отказа расшифрована, а не показана кодом');
check(/шлюз требовал \$5/.test(sandbox.state.toastLog[1].text), 'требуемая шлюзом предоплата не потерялась');

// Повторный опрос — те же записи. История расти не должна.
const before = sandbox.state.toastLog.length, rendersBefore = sandbox.renders;
moneyRotateToHistory('justwoker');
check(sandbox.state.toastLog.length === before, 'повторный опрос статуса копий не добавил');
check(sandbox.renders === rendersBefore, 'без новых записей панель не перерисовывается');

// Новая подмена доезжает.
sandbox.moneyAutoLast.justwoker.recent.unshift({
    ts: new Date(T0 + 120_000).toISOString(), from: 'creamyevoluti', to: 'faithfulpho', balance: 90, reason: 'dead',
});
moneyRotateToHistory('justwoker');
check(sandbox.state.toastLog.length === 3, 'новая подмена приехала в историю');
check(/faithfulpho/.test(sandbox.state.toastLog[0].text), 'она встала сверху');

// Провайдер без подмен: пустой `recent` ничего не ломает и не рисует.
sandbox.moneyAutoLast.agentrouter = { enabled: true, recent: [] };
sandbox.MONEY_PROVIDERS.agentrouter = { p: 'ar', label: 'AgentRouter', sym: '$' };
const r2 = sandbox.renders;
moneyRotateToHistory('agentrouter');
check(sandbox.renders === r2 && sandbox.state.toastLog.length === 3, 'пустой журнал шлюза историю не трогает');

console.log(fail ? `\n❌ ${fail} провалено` : '\nЖурнал подмен: одна строка на подмену, живёт в «Истории уведомлений».');
process.exit(fail ? 1 : 0);
