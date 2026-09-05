#!/usr/bin/env node
/**
 * check-journal-tail.js — регресс на хвостовое чтение журналов хаба.
 *
 * Зачем файл существует. С 05.09 три журнала читаются НЕ целиком, а с запомненного
 * смещения: `finance-history.jsonl`, `token-usage.jsonl` (4.9 МБ, дописывается на
 * каждый запрос через front-door) и `~/.claude/history.jsonl` (6.5 МБ). Выигрыш
 * большой — повторная сборка среза «Лиги» с 130…190 мс упала до 8…12 мс, — но у
 * инкрементального чтения есть ровно три способа тихо соврать, и все три уже ломались
 * в этом проекте на других механизмах:
 *   1. ОБРЕЗКА. `usage-tap.js` на 8 МБ выкидывает половину строк, `finance-history`
 *      режется так же. Если не заметить, что файл стал короче, суммы навсегда
 *      останутся с вкладом строк, которых на диске больше нет.
 *   2. НЕПОЛНАЯ ПОСЛЕДНЯЯ СТРОКА. Чтение может застать запись на середине строки.
 *      Остаток обязан доехать следующим чтением РОВНО один раз: потеря — минус
 *      запрос в статистике, дубль — плюс запрос.
 *   3. ГРАНИЦА МНОГОБАЙТОВОГО СИМВОЛА. `history.jsonl` — это русский текст промптов
 *      (не-ASCII в 14 671 строке из 17 743 на 05.09). Обрыв внутри символа даёт
 *      U+FFFD, битый JSON и потерянный промпт.
 * Плюс `first` — самая ранняя запись за всю историю журнала: по ней считается граница
 * сшивки со stats-cache, и если она сползёт на начало последнего хвоста, сутки
 * посчитаются дважды.
 *
 * Как: функции вырезаются из transparent-proxy.js и исполняются в песочнице поверх
 * ВРЕМЕННЫХ журналов в temp-каталоге. Живые журналы и `~/.claude/history.jsonl` не
 * трогаются ни на чтение, ни на запись. Эталон — намеренно тупое полное чтение файла
 * тут же в тесте: сравнивается инкрементальный результат с ним, а не с самим собой.
 *
 * Запуск: node tools/check-journal-tail.js      (exit 1 = чтение хвостом разъехалось)
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
  console.error('не нашёл блок журналов в transparent-proxy.js');
  process.exit(1);
}
const block = SRC.slice(from, to);

let ok = 0, bad = 0;
const check = (name, cond, got) => {
  if (cond) { ok++; console.log(`  ✅ ${name}`); }
  else { bad++; console.log(`  ❌ ${name}${got === undefined ? '' : ` — получено ${JSON.stringify(got)}`}`); }
};

// Своя песочница на свой каталог: у каждой — свои накопители, поэтому «журнала нет»
// проверяется на отдельном экземпляре, а не порчей состояния основного.
// `LISTEN_PORT` и настоящий `jsonRes` нужны ручке удаления чата (см. её раздел ниже):
// порт объявлен в transparent-proxy.js ВЫШЕ вырезаемого блока, а без честного `jsonRes`
// не видно кода ответа.
function jsonResReal(res, code, body) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function mkApi(dir) {
  fs.mkdirSync(path.join(dir, 'home', '.claude'), { recursive: true });
  const osFake = new Proxy(os, {
    get(t, k) { return k === 'homedir' ? () => path.join(dir, 'home') : t[k]; },
  });
  const api = new Function(
    'fs', 'path', 'os', 'crypto', 'execFileSync', 'http', 'https', '__dirname', 'logLine', 'round2',
    'jsonRes', 'readJsonBody', 'TOKEN_USAGE_FILE', 'FINANCE_HISTORY_FILE', 'LISTEN_PORT',
    'ghLoad', 'arLoad', 'goLoad', 'tbLoad', 'xpLoad', 'jwLoad', 'skLoad', 'tsLoad', 'kkLoad',
    `${block}\nreturn { tokenJournalCounts, ccPromptCounts, financeEntries, financeAggregate,`
    + ` tailRead, tailLines, utf8Cut, dayKey, pad2, timeKeys, handleLeagueChatDelete, hubIdentity };`
  )(
    fs, path, osFake, crypto, execFileSync, require('http'), require('https'), dir,
    () => {}, v => Math.round(v * 100) / 100, jsonResReal, async () => ({}),
    path.join(dir, 'token-usage.jsonl'), path.join(dir, 'finance-history.jsonl'), 8200,
    () => [], () => [], () => [], () => [], () => [], () => [], () => [], () => [], () => []
  );
  return { api, tok: path.join(dir, 'token-usage.jsonl'),
    fin: path.join(dir, 'finance-history.jsonl'),
    cc: path.join(dir, 'home', '.claude', 'history.jsonl'), dir };
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-tail-'));
const S = mkApi(path.join(ROOT, 'main'));

// ── Эталоны: полное чтение файла, намеренно в лоб ────────────────────────────
// Незавершённую последнюю строку (файл не кончается переводом строки) эталон
// ОТБРАСЫВАЕТ: недописанная запись не событие, её нельзя считать до того, как она
// доедет. Это единственное место, где новое поведение отличается от прежнего полного
// чтения, — и отличается в правильную сторону.
const bodyLines = file => {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const parts = raw.split('\n');
  if (!raw.endsWith('\n')) parts.pop();
  return parts.filter(Boolean);
};
const refTok = file => {
  const day = new Map(), hour = new Map(), cday = new Map(), chour = new Map();
  let lines = 0, seen = 0, badLn = 0, first = null;
  for (const ln of bodyLines(file)) {
    seen++;
    let e; try { e = JSON.parse(ln); } catch { badLn++; continue; }
    const d = new Date(e.t);
    if (isNaN(d.getTime())) continue;
    lines++;
    if (!first) first = d;
    const dk = S.api.dayKey(d), hk = `${dk}T${S.api.pad2(d.getHours())}`;
    const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    add(day, dk, (Number(e.in) || 0) + (Number(e.out) || 0));
    add(hour, hk, (Number(e.in) || 0) + (Number(e.out) || 0));
    add(cday, dk, (Number(e.cr) || 0) + (Number(e.cw) || 0));
    add(chour, hk, (Number(e.cr) || 0) + (Number(e.cw) || 0));
  }
  return { lines, seen, bad: badLn, first, day, hour, cday, chour };
};
const refCc = file => {
  const day = new Map(), hour = new Map();
  let total = 0, first = null;
  for (const ln of bodyLines(file)) {
    let e; try { e = JSON.parse(ln); } catch { continue; }
    const d = new Date(Number(e.timestamp) || 0);
    if (isNaN(d.getTime()) || d.getFullYear() < 2024) continue;
    total++;
    if (!first) first = d;
    const dk = S.api.dayKey(d), hk = `${dk}T${S.api.pad2(d.getHours())}`;
    day.set(dk, (day.get(dk) || 0) + 1);
    hour.set(hk, (hour.get(hk) || 0) + 1);
  }
  return { total, first, day, hour };
};
// Снимок для сравнения: Map → отсортированные пары, Date → ISO.
const snapTok = o => JSON.stringify({ lines: o.lines, seen: o.seen, bad: o.bad,
  first: o.first ? new Date(o.first).toISOString() : null,
  day: [...o.day].sort(), hour: [...o.hour].sort(),
  cday: [...o.cday].sort(), chour: [...o.chour].sort() });
const snapCc = o => JSON.stringify({ total: o.total,
  first: o.first ? new Date(o.first).toISOString() : null,
  day: [...o.day].sort(), hour: [...o.hour].sort() });

const mkTok = (t, over = {}) => JSON.stringify({ t, m: 'claude-opus-5', bk: 'kktoken',
  h: 'claude-code', st: 1, ms: 10, in: 100, out: 10, cr: 5, cw: 2, cost: 0.01, ...over }) + '\n';
const mkCc = (ms, text) => JSON.stringify({ display: text, pastedContents: {},
  timestamp: ms, project: 'D:\\WORMALIENAIGIGANT', sessionId: 's' }) + '\n';
const mkFin = (t, over = {}) => JSON.stringify({ t, p: 'kktoken', id: 'kk_1', dSpent: 1,
  dGrant: 0, spent: 10, balance: 5, src: 'self', ...over }) + '\n';
// Обрезка ровно как в usage-tap.js: выкидываем первую половину строк.
const halve = file => {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
  return lines.length - Math.floor(lines.length / 2);
};

// ── Журнал токенов: рост, недописанная строка, обрезка ───────────────────────
console.log('\nжурнал токенов (token-usage.jsonl):');
// 240 записей: 5 суток × 8 часов × 6 записей — чтобы день и час были не по одному
// ключу, иначе обрезка «совпала бы» и на сломанном коде.
let seed = '';
for (let d = 1; d <= 5; d++) {
  for (let h = 6; h < 14; h++) {
    for (let n = 0; n < 6; n++) {
      seed += mkTok(`2026-09-0${d}T${S.api.pad2(h)}:${S.api.pad2(n * 7)}:00.000Z`,
        { in: 100 * d + h, out: n, cr: h, cw: n });
    }
  }
}
fs.writeFileSync(S.tok, seed);
check('холодное чтение = полное чтение файла',
  snapTok(S.api.tokenJournalCounts()) === snapTok(refTok(S.tok)));
check('прочитано 240 записей', S.api.tokenJournalCounts().lines === 240,
  S.api.tokenJournalCounts().lines);
const firstEver = new Date(S.api.tokenJournalCounts().first).toISOString();
check('разобранных записей столько же, сколько строк',
  S.api.tokenJournalCounts().list.length === 240, S.api.tokenJournalCounts().list.length);

fs.appendFileSync(S.tok, mkTok('2026-09-05T15:00:00.000Z', { in: 7000, out: 3 })
  + mkTok('2026-09-05T15:01:00.000Z', { in: 11, out: 1 })
  + mkTok('2026-09-05T16:02:00.000Z', { in: 13, out: 1 }));
check('после дописывания трёх строк = полное чтение',
  snapTok(S.api.tokenJournalCounts()) === snapTok(refTok(S.tok)));
check('старые строки не пересчитаны второй раз', S.api.tokenJournalCounts().lines === 243,
  S.api.tokenJournalCounts().lines);
check('`first` осталась самой ранней за всю историю',
  new Date(S.api.tokenJournalCounts().first).toISOString() === firstEver);

// Недописанная строка: чтение застало запись на середине.
const half = mkTok('2026-09-05T17:00:00.000Z', { in: 999, out: 9 });
const cutAt = Math.floor(half.length / 2);
fs.appendFileSync(S.tok, half.slice(0, cutAt));
const beforePartial = snapTok(S.api.tokenJournalCounts());
check('недописанная строка НЕ посчитана', S.api.tokenJournalCounts().lines === 243,
  S.api.tokenJournalCounts().lines);
check('недописанная строка не сдвинула суммы', beforePartial === snapTok(refTok(S.tok)));
fs.appendFileSync(S.tok, half.slice(cutAt));
check('доехавший остаток посчитан ровно один раз',
  S.api.tokenJournalCounts().lines === 244, S.api.tokenJournalCounts().lines);
check('после доезда остатка = полное чтение',
  snapTok(S.api.tokenJournalCounts()) === snapTok(refTok(S.tok)));
check('дублей в разобранных записях нет',
  S.api.tokenJournalCounts().list.length === 244, S.api.tokenJournalCounts().list.length);

// Битая строка: в `seen` и `bad` попадает, в `lines` — нет.
fs.appendFileSync(S.tok, '{это не json}\n');
const withBad = S.api.tokenJournalCounts();
check('битая строка ушла в bad, не в lines',
  withBad.bad === 1 && withBad.lines === 244, { bad: withBad.bad, lines: withBad.lines });
check('битая строка посчитана в seen (её показывает вкладка)', withBad.seen === 245, withBad.seen);
check('с битой строкой = полное чтение', snapTok(withBad) === snapTok(refTok(S.tok)));

// ── Обрезка: главный случай, из-за которого этот файл написан ────────────────
console.log('\nобрезка журнала токенов (usage-tap режет по 8 МБ):');
const leftTok = halve(S.tok);
const afterCut = S.api.tokenJournalCounts();
check('после обрезки = полное чтение обрезанного файла',
  snapTok(afterCut) === snapTok(refTok(S.tok)));
check(`осталось ${leftTok} записей, а не 245`, afterCut.seen === leftTok,
  { seen: afterCut.seen, ждали: leftTok });
check('накопители обнулены: разобранных записей столько же, сколько строк',
  afterCut.list.length === afterCut.lines, { list: afterCut.list.length, lines: afterCut.lines });
check('битые строки пересчитаны по обрезанному файлу, а не унаследованы',
  afterCut.bad === refTok(S.tok).bad, { bad: afterCut.bad, ref: refTok(S.tok).bad });
check('`first` стала самой ранней ИЗ ОСТАВШИХСЯ',
  new Date(afterCut.first).toISOString() !== firstEver
  && new Date(afterCut.first).toISOString() === new Date(refTok(S.tok).first).toISOString(),
  new Date(afterCut.first).toISOString());
fs.appendFileSync(S.tok, mkTok('2026-09-05T18:00:00.000Z', { in: 5, out: 5 }));
check('дописывание после обрезки продолжает с нового смещения',
  snapTok(S.api.tokenJournalCounts()) === snapTok(refTok(S.tok)));
// Журнал подменили заведомо коротким — накопленное обязано уйти целиком, включая
// счётчик битых строк: он копится так же, как суммы, и так же соврал бы навсегда.
fs.writeFileSync(S.tok, mkTok('2026-09-03T07:00:00.000Z') + mkTok('2026-09-03T08:00:00.000Z'));
const tiny = S.api.tokenJournalCounts();
check('подмена коротким файлом обнуляет всё накопленное',
  tiny.lines === 2 && tiny.seen === 2 && tiny.bad === 0 && tiny.list.length === 2,
  { lines: tiny.lines, seen: tiny.seen, bad: tiny.bad, list: tiny.list.length });
check('после подмены = полное чтение', snapTok(tiny) === snapTok(refTok(S.tok)));

// ── Подмена файла: размер совпал, содержимое другое ──────────────────────────
// Четвёртый способ соврать, и он был открыт до 05.09: свежесть определялась РАЗМЕРОМ.
// Замер на сломанном коде — журнал из 20 строк подменили на 20 других того же объёма
// (`"in":1000` → `"in":9999`): показывалось 20 000 токенов при 199 980 на диске, и это
// навсегда, потому что размер больше не менялся. Так бывает не в теории: ротация с
// обрезкой и доливкой, подмена `tmp+rename`, правка одной цифры руками.
console.log('\nподмена файла тем же размером (детект по размеру этого не видел):');
const mkRow = v => mkTok('2026-09-01T05:00:00.000Z', { in: v, out: 0, cr: 0, cw: 0 });
const twenty = n => { let s = ''; for (let i = 0; i < 20; i++) s += mkRow(n); return s; };
const seedA = twenty(1000), seedB = twenty(9999);        // одинаковая длина, разные цифры
check('подготовка: подменный файл ровно того же размера',
  Buffer.byteLength(seedA) === Buffer.byteLength(seedB), Buffer.byteLength(seedB) - Buffer.byteLength(seedA));
// mtime двигаем вперёд намеренно: так выглядит подмена, случившаяся ПОЗЖЕ нашего чтения.
// Подмену внутри одного тика файловых часов (mtime и размер не изменились оба) stat не
// видит вообще — это отмечено в transparent-proxy.js как осознанно незакрытое.
const later = f => fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
const W = mkApi(path.join(ROOT, 'swap'));
fs.writeFileSync(W.tok, seedA);
W.api.tokenJournalCounts();
fs.writeFileSync(W.tok, seedB); later(W.tok);
const sw = W.api.tokenJournalCounts();
check('содержимое подменили при том же размере → пересчитано с нуля',
  snapTok(sw) === snapTok(refTok(W.tok)), { было: [...sw.day], надо: [...refTok(W.tok).day] });
check('накопители не удвоились: записей столько же, сколько строк',
  sw.list.length === sw.lines && sw.lines === 20, { list: sw.list.length, lines: sw.lines });

// Подмена через tmp+rename: у файла меняется `ino`, размер может совпасть до байта.
const W2 = mkApi(path.join(ROOT, 'swap-rename'));
fs.writeFileSync(W2.tok, seedA);
W2.api.tokenJournalCounts();
const tmpPath = path.join(ROOT, 'swap-rename', 'x.tmp');
fs.writeFileSync(tmpPath, seedB); fs.renameSync(tmpPath, W2.tok); later(W2.tok);
check('подмена tmp+rename тем же размером → пересчитано с нуля',
  snapTok(W2.api.tokenJournalCounts()) === snapTok(refTok(W2.tok)));
// Тот же rename, но содержимое ДОПИСАНО: инкрементально это было бы верно, однако новый
// `ino` заставляет перечитать. Правильно и медленнее — цена, взятая осознанно.
const W3 = mkApi(path.join(ROOT, 'swap-append'));
fs.writeFileSync(W3.tok, seedA);
W3.api.tokenJournalCounts();
const tmp2 = path.join(ROOT, 'swap-append', 'y.tmp');
fs.writeFileSync(tmp2, seedA + mkRow(77)); fs.renameSync(tmp2, W3.tok); later(W3.tok);
const w3 = W3.api.tokenJournalCounts();
check('rename с дописанной строкой: цифры верные, накопитель не удвоен',
  snapTok(w3) === snapTok(refTok(W3.tok)) && w3.list.length === 21, w3.list.length);

// Правка одной цифры руками: размер тот же, строка в СЕРЕДИНЕ уже прочитанного.
const W4 = mkApi(path.join(ROOT, 'edit-mid'));
fs.writeFileSync(W4.tok, seedA);
W4.api.tokenJournalCounts();
const rowsMid = seedA.split('\n').filter(Boolean).map(s => s + '\n');
rowsMid[3] = rowsMid[3].replace('"in":1000', '"in":9000');
fs.writeFileSync(W4.tok, rowsMid.join('')); later(W4.tok);
check('правка одной цифры в середине прочитанного → пересчитано с нуля',
  snapTok(W4.api.tokenJournalCounts()) === snapTok(refTok(W4.tok)));
// То же в ПОСЛЕДНЕЙ прочитанной строке — ровно там, где стоит якорь.
const W5 = mkApi(path.join(ROOT, 'edit-last'));
fs.writeFileSync(W5.tok, seedA);
W5.api.tokenJournalCounts();
const rowsEnd = seedA.split('\n').filter(Boolean).map(s => s + '\n');
rowsEnd[19] = rowsEnd[19].replace('"in":1000', '"in":9000');
fs.writeFileSync(W5.tok, rowsEnd.join('')); later(W5.tok);
check('правка цифры в последней строке → пересчитано с нуля',
  snapTok(W5.api.tokenJournalCounts()) === snapTok(refTok(W5.tok)));

// ── Ротация с обрезкой: голову выкинули, хвост долили ────────────────────────
// Самый злой вариант: размер после ротации ДОГНАЛ прежний (или перерос его), поэтому
// «файл стал короче» не срабатывает. На сломанном коде читалось от старого смещения —
// либо с середины строки (битая строка в `bad`), либо ровно по границе, и тогда цифры
// врали молча: замер на 40 строках дал 37 против 17 за одни сутки и 3 против 10 003 за
// другие при совпавшем счётчике строк.
console.log('\nротация с обрезкой (размер догнал прежний):');
const rot = (dir2, keepFrom, addRows, vary) => {
  const A = mkApi(path.join(ROOT, dir2));
  let before = '';
  for (let i = 0; i < 40; i++) before += mkTok(`2026-09-02T${S.api.pad2(i % 24)}:00:00.000Z`,
    { in: vary ? 10 ** (i % 5) : 1, out: 0, m: vary ? 'm'.repeat(1 + (i % 7)) : 'claude-opus-5' });
  fs.writeFileSync(A.tok, before);
  A.api.tokenJournalCounts();
  let after = before.split('\n').filter(Boolean).slice(keepFrom).map(s => s + '\n').join('');
  for (let i = 0; i < addRows; i++) after += mkTok(`2026-09-03T${S.api.pad2(i % 24)}:00:00.000Z`,
    { in: 500, out: 0, m: vary ? 'z'.repeat(1 + (i % 5)) : 'claude-opus-5' });
  fs.writeFileSync(A.tok, after); later(A.tok);
  return { A, sizeBefore: Buffer.byteLength(before), sizeAfter: fs.statSync(A.tok).size };
};
const r1 = rot('rot-equal', 20, 20, false);         // строки одной длины → размер тот же
check(`подготовка: размер после ротации ${r1.sizeAfter} ≥ прежнего ${r1.sizeBefore}`,
  r1.sizeAfter >= r1.sizeBefore, { after: r1.sizeAfter, before: r1.sizeBefore });
const rot1 = r1.A.api.tokenJournalCounts();
check('ротация при том же размере = полное чтение ротированного файла',
  snapTok(rot1) === snapTok(refTok(r1.A.tok)), { было: [...rot1.day], надо: [...refTok(r1.A.tok).day] });
check('битых строк нет: не читали с середины строки', rot1.bad === 0, rot1.bad);
const r2 = rot('rot-bigger', 18, 25, true);         // строки разной длины, размер перерос
check(`подготовка: размер после ротации ${r2.sizeAfter} > прежнего ${r2.sizeBefore}`,
  r2.sizeAfter > r2.sizeBefore, { after: r2.sizeAfter, before: r2.sizeBefore });
const rot2 = r2.A.api.tokenJournalCounts();
check('ротация с ростом размера = полное чтение ротированного файла',
  snapTok(rot2) === snapTok(refTok(r2.A.tok)));
check('и здесь битых строк нет', rot2.bad === 0 && rot2.list.length === rot2.lines,
  { bad: rot2.bad, list: rot2.list.length, lines: rot2.lines });

// Перезапись, застигнувшая нас с недописанной строкой в `rest`: остаток от прежнего
// файла обязан уйти, иначе он склеится с первой строкой нового и даст битую запись.
const P = mkApi(path.join(ROOT, 'rest-drop'));
fs.writeFileSync(P.tok, seedA + mkRow(555).slice(0, 40));   // хвост обрублен на середине
P.api.tokenJournalCounts();
fs.writeFileSync(P.tok, twenty(2222) + mkRow(3333)); later(P.tok);
const pd = P.api.tokenJournalCounts();
check('перезапись при недописанной строке: остаток выброшен, битых нет',
  snapTok(pd) === snapTok(refTok(P.tok)) && pd.bad === 0, { bad: pd.bad });

// ── Главное свойство: дописывание НЕ вызывает полный перечит ─────────────────
// Иначе смысла в хвостовом чтении нет — вернёмся к 150 мс на срез.
console.log('\nдописывание читается хвостом, а не файлом целиком:');
const T = mkApi(path.join(ROOT, 'tail-only'));
let fat = '';
for (let i = 0; i < 200 * 6; i++) fat += mkTok(`2026-09-0${1 + (i % 5)}T${S.api.pad2(6 + (i % 8))}:${S.api.pad2(i % 60)}:00.000Z`,
  { in: 100 + i, out: i % 7 });
fs.writeFileSync(T.tok, fat);
const cold = T.api.tokenJournalCounts();
const fatSize = fs.statSync(T.tok).size;
check(`подготовка: файл ${fatSize} Б, ${cold.lines} записей прочитаны холодным чтением`,
  cold.lines === 1200 && fatSize > 100000, { lines: cold.lines, size: fatSize });
const realRead = fs.readSync;
let asked = 0, calls = 0;
fs.readSync = function (fd, buf, off, len, pos) { calls++; asked += len; return realRead.apply(fs, arguments); };
const addRow = mkTok('2026-09-06T09:00:00.000Z', { in: 42, out: 1 });
fs.appendFileSync(T.tok, addRow);
const grown = T.api.tokenJournalCounts();
const askedAppend = asked, callsAppend = calls;
fs.readSync = realRead;
check(`дописали ${addRow.length} Б → с диска запрошено ${askedAppend} Б, а не ${fatSize}`,
  askedAppend < 1024 && askedAppend >= addRow.length, { asked: askedAppend, calls: callsAppend });
check('дописанная строка посчитана, старые не пересчитаны',
  grown.lines === 1201 && grown.list.length === 1201, { lines: grown.lines, list: grown.list.length });
check('после дописывания = полное чтение', snapTok(grown) === snapTok(refTok(T.tok)));

// `ino` — половина защиты, и она платформенная. Если проверка покраснела, значит на этой
// ФС идентификатора файла нет, и подмену ловит только якорь плюс правило равного размера.
const inoA = path.join(ROOT, 'ino-a.txt'), inoB = path.join(ROOT, 'ino-b.tmp');
fs.writeFileSync(inoA, 'x'.repeat(64));
const ino1 = fs.statSync(inoA).ino;
fs.appendFileSync(inoA, 'y'.repeat(8));
const ino2 = fs.statSync(inoA).ino;
fs.writeFileSync(inoB, 'z'.repeat(72)); fs.renameSync(inoB, inoA);
const ino3 = fs.statSync(inoA).ino;
check('на этой ФС `ino` не ноль, держится при дописывании и меняется при подмене файла',
  ino1 !== 0 && ino1 === ino2 && ino3 !== ino1, { ino1, ino2, ino3 });

// ── История промптов: то же плюс граница многобайтового символа ───────────────
console.log('\nистория промптов (~/.claude/history.jsonl, русский текст):');
const CC_BASE = Date.parse('2026-09-01T09:00:00.000Z');
let ccSeed = '';
for (let i = 0; i < 60; i++) {
  ccSeed += mkCc(CC_BASE + i * 37 * 60000, `промпт номер ${i} — проверка кодировки, ёжик`);
}
fs.writeFileSync(S.cc, ccSeed);
check('холодное чтение = полное чтение файла',
  snapCc(S.api.ccPromptCounts()) === snapCc(refCc(S.cc)));
check('прочитано 60 промптов', S.api.ccPromptCounts().total === 60, S.api.ccPromptCounts().total);
const ccFirstEver = new Date(S.api.ccPromptCounts().first).toISOString();
fs.appendFileSync(S.cc, mkCc(CC_BASE + 99 * 37 * 60000, 'ещё один промпт с буквой ы'));
check('после дописывания = полное чтение',
  snapCc(S.api.ccPromptCounts()) === snapCc(refCc(S.cc)));
check('промптов стало 61', S.api.ccPromptCounts().total === 61, S.api.ccPromptCounts().total);

// Обрыв ВНУТРИ многобайтового символа. Режем по байтам там, где стоит байт
// продолжения UTF-8, — то есть ровно посреди русской буквы. Ищем от начала: хвост
// JSON-строки (`pastedContents`, `timestamp`, `sessionId`) целиком ASCII, и от
// середины такой позиции просто нет.
const ru = Buffer.from(mkCc(CC_BASE + 120 * 37 * 60000, 'русский промпт про кодировку'), 'utf8');
let mid = 0;
while (mid < ru.length && (ru[mid] & 0xC0) !== 0x80) mid++;
check('позиция реза найдена внутри многобайтового символа',
  mid > 0 && mid < ru.length && (ru[mid] & 0xC0) === 0x80, { mid, len: ru.length });
fs.appendFileSync(S.cc, ru.subarray(0, mid));
check('обрывок посреди символа не посчитан и не сломал разбор',
  S.api.ccPromptCounts().total === 61, S.api.ccPromptCounts().total);
fs.appendFileSync(S.cc, ru.subarray(mid));
check('доехавшая строка посчитана ровно один раз',
  S.api.ccPromptCounts().total === 62, S.api.ccPromptCounts().total);
check('после доезда = полное чтение',
  snapCc(S.api.ccPromptCounts()) === snapCc(refCc(S.cc)));

// Счётчик по строкам такой обрыв бы не поймал: U+FFFD — законный символ внутри
// JSON-строки, разбор бы прошёл, а текст промпта молча испортился. Поэтому границу
// символа проверяем на самом `tailRead`: склейка двух чтений обязана дать исходные
// байты один в один.
const RU = path.join(ROOT, 'ru.txt');
const rub = Buffer.from('строка один\nстрока два — ёжик\n', 'utf8');
let rcut = 0;
while ((rub[rcut] & 0xC0) !== 0x80) rcut++;
const st8 = { mtime: 0, size: 0, rest: '' };
fs.writeFileSync(RU, rub.subarray(0, rcut));
const part1 = S.api.tailRead(RU, st8);
check('первое чтение не содержит U+FFFD (незаконченный символ отложен)',
  !part1.text.includes('�'), part1.text.slice(-6));
check('смещение не уехало за незаконченный символ', st8.size === rcut - 1,
  { size: st8.size, rcut });
fs.appendFileSync(RU, rub.subarray(rcut));
const part2 = S.api.tailRead(RU, st8);
check('склейка двух чтений = исходный текст байт в байт',
  part1.text + part2.text === rub.toString('utf8'),
  { got: (part1.text + part2.text).slice(0, 20), want: rub.toString('utf8').slice(0, 20) });
check('смещение доехало до конца файла', st8.size === rub.length, st8.size);

const leftCc = halve(S.cc);
const ccCut = S.api.ccPromptCounts();
check('после обрезки = полное чтение обрезанного файла', snapCc(ccCut) === snapCc(refCc(S.cc)));
check(`осталось ${leftCc} промптов, а не 62`, ccCut.total === leftCc,
  { total: ccCut.total, ждали: leftCc });
check('`first` истории сдвинулась вперёд после обрезки',
  new Date(ccCut.first).toISOString() !== ccFirstEver, new Date(ccCut.first).toISOString());

// ── Журнал денег: обрезка обязана обнулять разобранные записи ─────────────────
console.log('\nжурнал денег (finance-history.jsonl):');
let finSeed = '';
for (let i = 0; i < 24; i++) finSeed += mkFin(new Date(Date.now() - i * 3600e3).toISOString());
fs.writeFileSync(S.fin, finSeed);
check('холодное чтение: 24 записи', S.api.financeEntries().list.length === 24,
  S.api.financeEntries().list.length);
fs.appendFileSync(S.fin, mkFin(new Date().toISOString()) + mkFin(new Date().toISOString()));
check('после дописывания: 26 записей', S.api.financeEntries().list.length === 26,
  S.api.financeEntries().list.length);
const leftFin = halve(S.fin);
check(`после обрезки: ${leftFin} записей, накопитель обнулён`,
  S.api.financeEntries().list.length === leftFin,
  { list: S.api.financeEntries().list.length, ждали: leftFin });
const fa = S.api.financeAggregate(S.api.timeKeys(2).keys, false);
check('агрегат окна считается по обрезанному журналу, а не по памяти',
  fa.lines === leftFin && fa.used <= leftFin, { lines: fa.lines, used: fa.used });

// ── Журнала нет вовсе ────────────────────────────────────────────────────────
console.log('\nжурнала нет на диске:');
const E = mkApi(path.join(ROOT, 'empty'));
check('журнал токенов отсутствует → нули без исключения',
  E.api.tokenJournalCounts().lines === 0 && E.api.tokenJournalCounts().list.length === 0);
check('история промптов отсутствует → нули', E.api.ccPromptCounts().total === 0);
check('журнал денег отсутствует → нули', E.api.financeEntries().list.length === 0);
fs.writeFileSync(E.tok, '');
check('пустой файл → нули', E.api.tokenJournalCounts().lines === 0);

// ── Кирпичи по отдельности ───────────────────────────────────────────────────
console.log('\nмеханика (`tailLines`, `utf8Cut`):');
const st = { rest: '' };
check('первая половина строки уходит в rest',
  JSON.stringify(S.api.tailLines(st, 'один\nдв', false)) === '["один"]' && st.rest === 'дв');
check('остаток склеивается со следующим чтением, ровно один раз',
  JSON.stringify(S.api.tailLines(st, 'а\n', false)) === '["два"]' && st.rest === '');
check('reset выбрасывает остаток: файл прочитан заново с нуля',
  JSON.stringify(S.api.tailLines({ rest: 'мусор' }, 'три\n', true)) === '["три"]');
const b = t => Buffer.from(t, 'utf8');
check('целая строка не режется', S.api.utf8Cut(b('привет')) === b('привет').length);
check('ASCII не режется', S.api.utf8Cut(b('abc')) === 3);
check('двухбайтовый символ без второго байта отрезан',
  S.api.utf8Cut(b('да').subarray(0, 3)) === 2, S.api.utf8Cut(b('да').subarray(0, 3)));
check('трёхбайтовый символ без хвоста отрезан',
  S.api.utf8Cut(b('a€').subarray(0, 3)) === 1 && S.api.utf8Cut(b('a€').subarray(0, 2)) === 1);
check('четырёхбайтовый символ без хвоста отрезан',
  S.api.utf8Cut(b('a😀').subarray(0, 4)) === 1 && S.api.utf8Cut(b('a😀')) === 5);

// ── DELETE /league/chat: неразобранный путь не смеет стать «удалить все мои» ──
// Живёт в этом файле по владению: `tools/check-league-chat.js` в это же время правит
// другой агент, а `transparent-proxy.js` и этот регресс — мои. Там проверяются рабочие
// ветки удаления через настоящий приёмник; здесь — ровно то, чего там нет: что кривой
// хвост URL получает 400 и НЕ доходит до приёмника вовсе.
// Почему это важнее, чем выглядит: маршрут ловит запрос ПРЕФИКСОМ
// (`req.url.startsWith('/__switch/api/league/chat')`), а до 05.09 «всё, что не /chat/<цифры>
// и не all=1» означало «удалить ВСЕ мои сообщения». То есть `/chat/5/`, `/chat/abc`,
// 16-значный номер и даже `/chat/att/5.webp` стирали человеку всю его переписку с кодом 200.
console.log('\nудаление в чате лиги: кривой путь не расширяется до массового:');
const D = mkApi(path.join(ROOT, 'chat-del'));
// Приёмник настроен, но адрес заведомо мёртвый: порт 1 никто не слушает. Ветки-400
// отвечают ДО первого `await`, то есть синхронно, — а значит любой ответ, пришедший
// синхронно, гарантированно получен без обращения к приёмнику.
fs.writeFileSync(path.join(D.dir, 'league-config.json'),
  JSON.stringify({ enabled: true, url: 'http://127.0.0.1:1', key: 'k'.repeat(16), everyMin: 10 }));
const callDel = url => {
  const out = { code: 0, body: '', sync: false };
  const res = { writableEnded: false, headersSent: false,
    setHeader() {}, writeHead(c) { out.code = c; this.headersSent = true; },
    end(b) { out.body = String(b || ''); this.writableEnded = true; } };
  D.api.handleLeagueChatDelete({ url, method: 'DELETE', headers: {} }, res).catch(() => {});
  out.sync = res.writableEnded;                       // ответ до первого await = приёмник не звали
  return out;
};
const B0 = '/__switch/api/league/chat';
const bad400 = [
  ['хвостовой слэш `/chat/5/`', `${B0}/5/`],
  ['не цифры `/chat/abc`', `${B0}/abc`],
  ['16 цифр в номере (регулярка ждёт до 15)', `${B0}/1234567890123456`],
  ['номер ноль', `${B0}/0`],
  ['путь вложения `/chat/att/5.webp`', `${B0}/att/5.webp`],
  ['вложение с `all=1` в запросе', `${B0}/att/5.webp?all=1`],
  ['голый `/chat` без признака', B0],
  ['`/chat/` со слэшем без признака', `${B0}/`],
  ['`force=1` сам по себе признаком не считается', `${B0}?force=1`],
  ['`mine=0` — это не признак', `${B0}?mine=0`],
];
for (const [name, url] of bad400) {
  const r = callDel(url);
  check(`${name} → 400 и приёмник не позван`, r.code === 400 && r.sync === true,
    { code: r.code, sync: r.sync, body: r.body.slice(0, 90) });
}
// Обратная сторона: рабочие ветки НЕ должны отвечать синхронно — они идут к приёмнику.
// Что именно уходит наружу, проверяет check-league-chat.js на живом приёмнике.
for (const [name, url] of [['одно сообщение `/chat/5`', `${B0}/5`],
  ['все свои `?mine=1`', `${B0}?mine=1`], ['весь журнал `?all=1`', `${B0}?all=1`]]) {
  const r = callDel(url);
  check(`${name} → разобран, запрос уходит к приёмнику`, r.code === 0 && r.sync === false,
    { code: r.code, sync: r.sync });
}

// Свой временный каталог — можно удалять напрямую (правило про корзину про чужие данные).
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
console.log(`\nитог: ${ok} прошло, ${bad} упало`);
process.exit(bad ? 1 : 0);
