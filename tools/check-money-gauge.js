#!/usr/bin/env node
// Регресс на арифметику денежной шапки дашборда.
//
// Зачем: на 04.09 на `poolMoneyStat` / `balanceUsable` / `renderGlobalGauge` не было
// ни одного теста — грепом по tools/ они не упоминались нигде. За это время в шапку
// приехали два расхождения: отрицательный остаток складывался сырым (ячейка строки
// его обрезает, сумма пула нет — шапка и строки разошлись на $2192.18, 12.4%), и
// та же цифра печаталась зелёным как «$-2174.41 доступно».
//
// Как: функции НЕ переписываются, а вытаскиваются из живого HTML и исполняются —
// иначе тест проверяет сам себя. Ровно эта ошибка есть в check-token-agg.js: он
// воспроизводит логику агрегатора у себя вместе с UTC-нарезкой и потому держит
// дефект часового пояса как эталон.
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const src = fs.readFileSync(HTML, 'utf8');

// Вырезает `function name(...) {...}` по балансу фигурных скобок.
function grab(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`в дашборде нет function ${name}`);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`не закрыта function ${name}`);
}

const api = new Function(
  `${grab('balanceUsable')}\n${grab('balanceDenom')}\n${grab('poolMoneyStat')}\n`
  + 'return { balanceUsable, balanceDenom, poolMoneyStat };'
)();

let ok = 0, bad = 0;
const check = (name, cond, got) => {
  if (cond) { ok++; console.log(`  ✅ ${name}`); }
  else { bad++; console.log(`  ❌ ${name}${got === undefined ? '' : ` — получено ${JSON.stringify(got)}`}`); }
};

// Пул со всеми случаями, которые встречаются на флоте живьём.
const POOL = [
  { api_key: 'sk-a', status: 'live', balance: 120.5, granted: 200, balanceSource: 'self'   },
  { api_key: 'sk-b', status: 'live', balance: 0,     granted: 175, balanceSource: 'self'   },
  { api_key: 'sk-c', status: 'live', balance: 37.25, balanceAnchor: 50, balanceSource: 'anchor' },
  { api_key: 'sk-d', status: 'live', balance: -2174.41, balanceSource: 'guess' }, // hcnsec
  { api_key: 'sk-e', status: 'dead', balance: 30,    granted: 30,  balanceSource: 'guess'  }, // xpeach
  { api_key: 'sk-f', status: 'no_key', balanceSource: null },
  { api_key: 'sk-g', status: 'live', balance: null,  balanceSource: 'unknown' },  // после правки 04.09
  { api_key: 'sk-h', status: 'unknown', balance: 12.73, granted: 20, balanceSource: 'self' },
];
const st = api.poolMoneyStat(POOL, 10);
console.log('poolMoneyStat:', JSON.stringify(st));

const positives = POOL.filter(s => api.balanceUsable(s) && s.balance >= 0);
const rowsSum = positives.reduce((a, s) => a + s.balance, 0);

console.log('\nинварианты шапки:');
check('сумма шапки = сумма того, что рисуют строки', Math.abs(st.sumBalance - rowsSum) < 1e-9,
  { sumBalance: st.sumBalance, rowsSum });
check('ни одна показанная сумма не отрицательна', st.sumBalance >= 0 && st.sumGrant >= 0, st);
check('отрицательный остаток не попал в сумму', st.sumBalance < 200 && st.sumBalance > 100, st.sumBalance);
check('отрицательный остаток посчитан неизвестным', st.unknown === 1, st.unknown);
check('неизвестный (null) остаток не считается ни деньгами, ни unknown',
  st.withBalance === 4 && st.unknown === 1, { withBalance: st.withBalance, unknown: st.unknown });
check('мёртвый ключ не приносит ни баланса, ни знаменателя',
  st.deadBalance === 30 && !positives.some(s => s.status === 'dead'), st.deadBalance);
check('no_key не приносит ничего', !positives.some(s => s.status === 'no_key'), true);
check('запас в пределах 0…100 %',
  (() => { const p = st.sumGrant > 0 ? Math.round(st.sumBalance / st.sumGrant * 100) : 0;
           return p >= 0 && p <= 100; })(), st);
check('всего ключей считается по всем записям', st.total === POOL.length, st.total);

// Пул целиком без вычислимого остатка: сумма нулевая, но это НЕ «$0.00 доступно» —
// строка под шкалой обязана уметь сказать «выдача неизвестна» (st.unknown > 0).
const BLIND = [
  { api_key: 'sk-x', status: 'live', balance: -100.5, balanceSource: 'guess' },
  { api_key: 'sk-y', status: 'unknown', balanceSource: 'guess' },
];
const stBlind = api.poolMoneyStat(BLIND, 10);
console.log('\nпул без вычислимого остатка:', JSON.stringify(stBlind));
check('слепой пул: денег ноль', stBlind.sumBalance === 0, stBlind.sumBalance);
check('слепой пул: withBalance ноль', stBlind.withBalance === 0, stBlind.withBalance);
check('слепой пул: виден признак «неизвестно»', stBlind.unknown === 1, stBlind.unknown);

// Строка под шкалой: «выдача неизвестна» вместо зелёного нуля.
const rowSrc = src.slice(src.indexOf('const money = st.withBalance'), src.indexOf('const money = st.withBalance') + 600);
check('строка пула умеет «выдача неизвестна»', /st\.unknown\s*>\s*0/.test(rowSrc), rowSrc.slice(0, 120));
check('в шапке нет отрицательных: sumBalance печатается только при > 0',
  /sumBalance > 0 \?/.test(src), true);

console.log(`\nитог: ${ok} прошло, ${bad} упало`);
process.exit(bad ? 1 : 0);

