#!/usr/bin/env node
/**
 * check-league.js — регресс на срез вкладки «Лига».
 *
 * Зачем файл существует. Этот объект — единственное, что уедет с машины на приёмник,
 * когда лига станет межмашинной. Поэтому у него два класса требований, и оба
 * проверяются здесь, а не глазами:
 *   1. АРИФМЕТИКА: длины рядов совпадают с длинами подписей; итог окна равен сумме
 *      своего ряда (иначе плитка и кривая покажут разные числа — так уже было);
 *      накопительный ряд аккаунтов не убывает; расход не отрицательный в итоге.
 *      Отдельная статья с 05.09 — ИТОГ накопительной метрики: у аккаунтов итог окна
 *      это прирост ВНУТРИ окна, а не уровень счётчика. Уровень от окна не зависит по
 *      определению, и витрина показывала 174 во всех трёх плитках сразу. Плюс налив:
 *      агрегатор считал его давно, а срез не отдавал, и расход читался как убыток.
 *   2. ПРИВАТНОСТЬ: в срезе нет ни ключей, ни почт, ни паролей, ни текста промптов.
 *      Активность считается по ~/.claude/history.jsonl, где лежат сами промпты, —
 *      ровно тот файл, из которого проще всего случайно вынести лишнее.
 *
 * Как: текст функций вырезается из transparent-proxy.js и исполняется в песочнице с
 * НАСТОЯЩИМИ журналами (чтение) и запрещённой записью. Сервер не поднимается, порт
 * :8200 не занимается, живой хаб не трогается.
 *
 * Запуск: node tools/check-league.js       (exit 1 = срез сломан)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROUTING = path.join(__dirname, '..', 'routing');
const SRC = fs.readFileSync(path.join(ROUTING, 'transparent-proxy.js'), 'utf8');

const from = SRC.indexOf('const HUB_IDENTITY_FILE');
const to = SRC.indexOf('async function handleFinanceHistory');
if (from < 0 || to < 0 || to < from) {
  console.error('не нашёл блок лиги в transparent-proxy.js');
  process.exit(1);
}
const block = SRC.slice(from, to);

// Запись запрещена, но с одним исключением: `hub-identity.json` создаётся при первом
// обращении — это и есть постоянная личность установки. Запоминаем ЧТО писали.
const blockedWrites = [];
const fsRO = new Proxy(fs, {
  get(t, k) {
    if (k === 'writeFileSync' || k === 'appendFileSync' || k === 'renameSync') {
      return (p) => { blockedWrites.push(path.basename(String(p))); };
    }
    return t[k];
  },
});

const load = f => {
  try {
    const raw = fs.readFileSync(path.join(ROUTING, f), 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return Array.isArray(j) ? j : (j.sessions || j.accounts || []);
  } catch { return []; }
};
const api = new Function(
  'fs', 'path', 'os', 'crypto', 'execFileSync', 'http', 'https', '__dirname', 'logLine', 'round2',
  'jsonRes', 'readJsonBody', 'TOKEN_USAGE_FILE', 'FINANCE_HISTORY_FILE',
  'ghLoad', 'arLoad', 'goLoad', 'tbLoad', 'xpLoad', 'jwLoad', 'skLoad', 'tsLoad', 'kkLoad',
  `${block}\nreturn { leagueSelf, hubIdentity, financeAggregate, timeKeys, dayKey, leagueAccounts, leagueBalance, leagueNickClean };`
)(
  fsRO, path, os, crypto, execFileSync, require('http'), require('https'), ROUTING,
  () => {}, v => Math.round(v * 100) / 100,
  () => {}, async () => ({}),
  path.join(ROUTING, 'token-usage.jsonl'), path.join(ROUTING, 'finance-history.jsonl'),
  () => load('github-accounts.json'), () => load('agentrouter-sessions.json'),
  () => load('gorouter-sessions.json'), () => load('tabi-sessions.json'),
  () => load('xpeach-sessions.json'), () => load('justwoker-sessions.json'),
  () => load('seekai-sessions.json'), () => load('truesota-sessions.json'),
  () => load('kktoken-sessions.json')
);

let ok = 0, bad = 0;
const check = (name, cond, got) => {
  if (cond) { ok++; console.log(`  ✅ ${name}`); }
  else { bad++; console.log(`  ❌ ${name}${got === undefined ? '' : ` — получено ${JSON.stringify(got)}`}`); }
};

const t0 = Date.now();
const me = api.leagueSelf();
const ms = Date.now() - t0;
const sum = a => a.reduce((x, y) => x + y, 0);
const M = v => (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' M';

console.log(`\nсрез собран за ${ms} мс, ник «${me.nick}», installId ${me.installId}`);
console.log(`токены: сутки ${M(me.tot.tokD)} · неделя ${M(me.tot.tokW)} · месяц ${M(me.tot.tokM)} · всё ${(me.tot.tokA / 1e9).toFixed(2)} млрд`);
console.log(`деньги: сутки $${me.tot.spD} · неделя $${me.tot.spW} · месяц $${me.tot.spM} · остаток $${me.tot.bal}`);
console.log(`налито: сутки $${me.tot.tuD} · неделя $${me.tot.tuW} · месяц $${me.tot.tuM} · всё $${me.tot.tuA}`);
console.log(`  из налива отсеяно дублей: сутки $${me.src.dupTopupD} · неделя $${me.src.dupTopupW}`
  + ` · месяц $${me.src.dupTopupM} · всё $${me.src.dupTopupA}`);
console.log(`промпты: ${me.tot.ppd}/д за неделю, всего ${me.tot.promptsAll}, стрик ${me.tot.streak} дн`);
console.log(`аккаунты: закуплено ${me.tot.bought} (с кредами ${me.src.boughtCreds}) · зарегано ${me.tot.reg}`);
console.log(`заведено: сегодня ${me.tot.accD} · за 7 дней ${me.tot.accW} · за 30 дней ${me.tot.accM}`
  + ` · всего ${me.tot.accA}${me.tot.accD === 0 ? '  (ноль за сегодня — это ответ, а не поломка)' : ''}`);
console.log(`сшивка: журнал с ${me.src.journalFirst}, граница ${me.src.cutover}, stats-cache до ${me.src.statsCacheLast}`);
console.log(`окно «всё время»: ${me.tok.all.length} суток, подписи ${me.keys.all.length}`);

console.log('\nарифметика:');
for (const [w, n] of [['h24', 24], ['d7', 7], ['d30', 30]]) {
  check(`окно ${w}: четыре ряда по ${n} точек`,
    [me.tok[w], me.sp[w], me.act[w], me.acc[w]].every(a => Array.isArray(a) && a.length === n),
    [me.tok[w].length, me.sp[w].length, me.act[w].length, me.acc[w].length]);
}
check('окно all: ряды и подписи одной длины',
  new Set([me.tok.all.length, me.sp.all.length, me.act.all.length, me.acc.all.length,
    me.keys.all.length]).size === 1,
  { tok: me.tok.all.length, sp: me.sp.all.length, act: me.act.all.length,
    acc: me.acc.all.length, keys: me.keys.all.length });
check('подписи есть у всех четырёх окон',
  ['h24', 'd7', 'd30', 'all'].every(w => me.keys[w].length === me.tok[w].length));

// Плитка обязана совпадать с кривой: расхождение итога и суммы ряда — тот самый
// дефект, из-за которого «всего» и график показывали разные числа.
check('итог суток = сумма часового ряда', me.tot.tokD === sum(me.tok.h24), { tot: me.tot.tokD, series: sum(me.tok.h24) });
check('итог недели = сумма семи суток', me.tot.tokW === sum(me.tok.d7), { tot: me.tot.tokW, series: sum(me.tok.d7) });
check('итог месяца = сумма тридцати суток', me.tot.tokM === sum(me.tok.d30));
check('итог «всё время» = сумма своего ряда', me.tot.tokA === sum(me.tok.all));
check('месяц не меньше недели, неделя не меньше суток',
  me.tot.tokM >= me.tot.tokW - 1 && me.tot.tokW >= me.tot.tokD - 1,
  { d: me.tot.tokD, w: me.tot.tokW, m: me.tot.tokM });
check('токены нигде не отрицательные',
  ['h24', 'd7', 'd30', 'all'].every(w => me.tok[w].every(v => v >= 0)));
check('промпты целые и неотрицательные',
  ['h24', 'd7', 'd30', 'all'].every(w => me.act[w].every(v => Number.isInteger(v) && v >= 0)));
check('счётчик аккаунтов не убывает',
  me.acc.all.every((v, i) => i === 0 || v >= me.acc.all[i - 1]), me.acc.all.slice(-6));
// Накопительная метрика не имеет права начинать окно с нуля, если ДО окна аккаунты уже
// были: счётчик на начало недели — это то, что заведено раньше, а не «ничего». Иначе
// кривая обрывалась на сутки и рисовала разрыв данных там, где данные есть.
// Проверяем ровно это: короткое окно обязано быть хвостом общей кривой, день в день.
// Формулировка не ломается на свежей установке, где ноль в начале месяца — правда.
const allAt = new Map(me.keys.all.map((k, i) => [k, me.acc.all[i]]));
check('окна аккаунтов — хвост общей кривой, день в день',
  ['d7', 'd30'].every(w => me.keys[w].every((k, i) =>
    !allAt.has(k) || me.acc[w][i] === allAt.get(k))),
  { d7: me.acc.d7, allTail: me.acc.all.slice(-7) });
check('накопление аккаунтов доходит до текущего итога',
  me.acc.all.at(-1) === me.tot.bought + me.tot.reg,
  { curve: me.acc.all.at(-1), bought: me.tot.bought, reg: me.tot.reg });
check('часовое окно аккаунтов совпадает с концом накопления',
  me.acc.h24.every(v => v === me.acc.all.at(-1)), { h24: me.acc.h24[0], all: me.acc.all.at(-1) });
check('ключи бакетов — полные, не подписи для оси',
  /^\d{4}-\d{2}-\d{2}$/.test(me.keys.all.at(-1)) && /T\d{2}$/.test(me.keys.h24.at(-1)),
  { all: me.keys.all.at(-1), h24: me.keys.h24.at(-1) });
check('остаток на руках не отрицательный', me.tot.bal >= 0, me.tot.bal);
check('стрик хотя бы сутки', me.tot.streak >= 1, me.tot.streak);
check('ключи пулов посчитаны', me.tot.reg > 0 && me.tot.keys > 0, { reg: me.tot.reg, keys: me.tot.keys });

// ── Прирост аккаунтов: уровень счётчика в роли итога окна ────────────────────
// Было: итогом всех трёх окон брался `bought + reg` — УРОВЕНЬ счётчика, который от окна
// не зависит по определению. Владелец увидел это глазами: «моё · сутки», «· неделя» и
// «· всё время» показывали одно и то же 174. Итог накопительной метрики обязан быть
// приростом ВНУТРИ окна и считаться по настоящим датам (`added` / `created`).
console.log('\nприрост аккаунтов (итог окна — прирост, а не уровень):');
const accWin = [me.tot.accD, me.tot.accW, me.tot.accM];
check('прирост — целые и не отрицательные',
  accWin.every(v => Number.isInteger(v) && v >= 0), accWin);
check('accA = закуплено + зарегано', me.tot.accA === me.tot.bought + me.tot.reg,
  { accA: me.tot.accA, bought: me.tot.bought, reg: me.tot.reg });
check('прирост не больше общего числа', accWin.every(v => v <= me.tot.accA),
  { win: accWin, accA: me.tot.accA });
// Короткое окно — подмножество длинного, значит прирост в нём не может быть больше.
// Нарушить это легко, если окна посчитать разными способами (уровнем и приростом).
check('неделя ≥ суток, месяц ≥ недели',
  me.tot.accW >= me.tot.accD && me.tot.accM >= me.tot.accW, accWin);
check('прирост не превышает числа датированных заведений', me.tot.accM <= me.tot.accDated,
  { accM: me.tot.accM, dated: me.tot.accDated });
// Независимый пересчёт по сырым файлам: итог обязан сойтись с прямым счётом дат, а не
// только сам с собой. Так ловится промах часового пояса — в UTC всё, заведённое в MSK
// после 03:00 прошлой ночи, уезжает в другой день.
const rawToday = (() => {
  const today = api.dayKey(new Date());
  let n = 0;
  const cnt = (arr, field) => {
    for (const r of arr) {
      const d = new Date((r || {})[field]);
      if (!isNaN(d.getTime()) && api.dayKey(d) === today) n++;
    }
  };
  cnt(load('github-accounts.json'), 'added');
  for (const f of ['agentrouter-sessions.json', 'gorouter-sessions.json', 'tabi-sessions.json',
    'xpeach-sessions.json', 'justwoker-sessions.json', 'seekai-sessions.json',
    'truesota-sessions.json', 'kktoken-sessions.json']) cnt(load(f), 'created');
  return n;
})();
check('заведено сегодня сходится с прямым счётом по файлам', me.tot.accD === rawToday,
  { accD: me.tot.accD, files: rawToday });

// ── Налив: агрегатор считал, срез не отдавал ─────────────────────────────────
// Расход без налива читается как убыток: на неделе сожжено $6970 при наливе $17559.
// Ряд `tu` живёт по тем же правилам, что остальные метрики, и берётся из
// financeAggregate — второй реализации дедупа наливки в проекте быть не должно.
console.log('\nналив (сожжено рядом с налитым):');
const r2 = v => Math.round(v * 100) / 100;
for (const w of ['h24', 'd7', 'd30', 'all'])
  check(`ряд налива ${w} длиной в подписи (${me.keys[w].length})`,
    Array.isArray(me.tu[w]) && me.tu[w].length === me.keys[w].length,
    { tu: (me.tu[w] || []).length, keys: me.keys[w].length });
for (const [w, f] of [['h24', 'tuD'], ['d7', 'tuW'], ['d30', 'tuM'], ['all', 'tuA']])
  check(`итог ${f} = сумма ряда ${w}`, r2(sum(me.tu[w])) === me.tot[f],
    { tot: me.tot[f], series: r2(sum(me.tu[w])) });
check('итоги налива не отрицательные',
  [me.tot.tuD, me.tot.tuW, me.tot.tuM, me.tot.tuA].every(v => v >= 0),
  [me.tot.tuD, me.tot.tuW, me.tot.tuM, me.tot.tuA]);
// Суточные бакеты неотрицательны — это и проверяется. ЧАСОВЫЕ так проверять нельзя:
// дельты знаковые, как у расхода, откат выданной квоты вычитается, и на 05.09 шесть
// часов из 24 отрицательные на −$10.78 при +$9405.47 налива за сутки. Внутри суток
// откаты закрываются наливом того же дня, поэтому отрицательных суточных нет ни одного
// из 120. Если такой день появится — это разбор, а не шум, и тест обязан покраснеть.
check('суточные бакеты налива не отрицательные',
  ['d7', 'd30', 'all'].every(w => me.tu[w].every(v => v >= 0)),
  me.tu.all.filter(v => v < 0));
check('отсеянные дубли наливки не отрицательные',
  [me.src.dupTopupD, me.src.dupTopupW, me.src.dupTopupM, me.src.dupTopupA].every(v => v >= 0),
  [me.src.dupTopupD, me.src.dupTopupW, me.src.dupTopupM, me.src.dupTopupA]);
// `topupW` — старое поле вкладки; та же неделя, посчитанная тем же агрегатором, обязана
// совпасть с новым итогом. Расхождение здесь = разъехались две реализации.
check('старое src.topupW совпадает с новым tot.tuW', r2(me.src.topupW) === r2(me.tot.tuW),
  { topupW: me.src.topupW, tuW: me.tot.tuW });

console.log('\nприватность (этот объект уедет на приёмник):');
const flat = JSON.stringify(me);
for (const [what, re] of [
  ['ключи шлюзов (sk-…)', /sk-[A-Za-z0-9]{12}/],
  ['почты', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
  ['пароли и TOTP', /"(password|totpSecret|recoveryCodes|totp)"/i],
  ['текст промптов', /"display"/],
  ['абсолютные пути машины', /[A-Za-z]:\\\\/],
  ['токены авторизации', /"(authorization|bearer|cookie|api_key|apiKey)"/i],
]) check(`в срезе нет: ${what}`, !re.test(flat), (flat.match(re) || [''])[0].slice(0, 24));
check('размер среза разумный (< 64 КБ)', flat.length < 65536, flat.length);
check('сборка среза пишет на диск только личность установки',
  blockedWrites.every(f => f === 'hub-identity.json'), blockedWrites);

console.log('\nник:');
check('пробелы уходят в подчёркивания', api.leagueNickClean('  worm alien ') === 'worm_alien');
check('односимвольный не проходит', api.leagueNickClean('w') === '');
check('обрезается до 20', api.leagueNickClean('a'.repeat(40)).length === 20);
check('кириллица живёт', api.leagueNickClean('Витя') === 'Витя');
check('разметка вычищается', api.leagueNickClean('<b>hack</b>') === 'bhackb');

console.log(`\nитог: ${ok} прошло, ${bad} упало`);
process.exit(bad ? 1 : 0);
