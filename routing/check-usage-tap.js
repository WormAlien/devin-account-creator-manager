#!/usr/bin/env node
// check-usage-tap.js — тесты счётчика токенов front-door. Порт не занимают,
// прокси не трогают, в token-usage.jsonl не пишут (запись подменена).
//
//   node routing/check-usage-tap.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTap, harnessOf, pickUsage, rotateJournal, appendRecord, dayKey } = require('./usage-tap.js');

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
};

// Ответ из живого замера 25.08 через :20100 (JustWoker). Важное: usage приходит
// ДВАЖДЫ и первый — заниженный.
const SSE = [
  'event: message_start',
  'data: {"message":{"id":"msg_1","model":"claude-opus-5","type":"message","usage":{"input_tokens":374,"output_tokens":1}},"type":"message_start"}',
  '',
  'event: content_block_delta',
  'data: {"delta":{"text":"Hi","type":"text_delta"},"index":0,"type":"content_block_delta"}',
  '',
  'event: message_delta',
  'data: {"delta":{"stop_reason":"end_turn"},"type":"message_delta","usage":{"cost":0.0013162506673300167,"input_tokens":7304,"kiro_credits":0.0658,"output_tokens":40}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '', '',
].join('\n');

const META = {
  method: 'POST', url: '/v1/messages?beta=true', backend: 'justwoker',
  ua: 'claude-cli/2.1.220 (external, cli)', status: 200,
  headers: { 'content-type': 'text/event-stream' },
};

function run(meta, body, chunkSize = 4096) {
  const written = [];
  const tap = createTap(meta, r => written.push(r));
  if (!tap) return { tap: null, written };
  for (let i = 0; i < body.length; i += chunkSize) {
    tap.chunk(Buffer.from(body.slice(i, i + chunkSize), 'utf8'));
  }
  tap.end();
  return { tap, written };
}

console.log('разбор SSE');
ok('берётся ПОСЛЕДНИЙ usage, а не первый и не сумма', () => {
  const { written } = run(META, SSE);
  assert.strictEqual(written.length, 1, 'одна запись на ответ');
  assert.strictEqual(written[0].in, 7304, 'вход из message_delta');
  assert.strictEqual(written[0].out, 40, 'выход из message_delta');
});
ok('модель, бэкенд и харнесс попадают в запись', () => {
  const { written } = run(META, SSE);
  assert.strictEqual(written[0].m, 'claude-opus-5');
  assert.strictEqual(written[0].bk, 'justwoker');
  assert.strictEqual(written[0].h, 'claude-code');
  assert.strictEqual(written[0].st, 1);
});
ok('цена запроса от шлюза сохраняется — по ней считается настоящая ставка', () => {
  const { written } = run(META, SSE);
  assert.ok(Math.abs(written[0].cost - 0.0013162506673300167) < 1e-12);
});
ok('разрыв чанков посреди JSON-строки ничего не теряет', () => {
  for (const size of [1, 7, 13, 64, 200, 999]) {
    const { written } = run(META, SSE, size);
    assert.strictEqual(written.length, 1, 'чанк ' + size + ': запись есть');
    assert.strictEqual(written[0].in, 7304, 'чанк ' + size + ': вход целый');
  }
});
ok('кеш-поля забираются, когда шлюз их отдаёт', () => {
  const body = 'data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":2,'
    + '"cache_read_input_tokens":900,"cache_creation_input_tokens":100}}\n\n';
  const { written } = run(META, body);
  assert.strictEqual(written[0].cr, 900);
  assert.strictEqual(written[0].cw, 100);
});
ok('обрыв соединения пишет то, что успело прийти', () => {
  const written = [];
  const tap = createTap(META, r => written.push(r));
  tap.chunk(Buffer.from(SSE.slice(0, SSE.indexOf('message_stop')), 'utf8'));
  tap.end();                                   // как on('aborted')
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].in, 7304);
});

console.log('не-SSE и отказы');
ok('обычный JSON-ответ разбирается целиком', () => {
  const meta = Object.assign({}, META, { headers: { 'content-type': 'application/json' } });
  const body = JSON.stringify({ model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 3 } });
  const { written } = run(meta, body);
  assert.strictEqual(written[0].in, 5);
  assert.strictEqual(written[0].st, 0);
});
ok('сжатый ответ не считается вовсе', () => {
  const meta = Object.assign({}, META, {
    headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
  });
  assert.strictEqual(createTap(meta, () => {}), null);
});
ok('не-POST, чужие пути и ошибки мимо', () => {
  assert.strictEqual(createTap(Object.assign({}, META, { method: 'GET' }), () => {}), null);
  assert.strictEqual(createTap(Object.assign({}, META, { url: '/v1/models' }), () => {}), null);
  assert.strictEqual(createTap(Object.assign({}, META, { url: '/v1/messages/count_tokens' }), () => {}), null);
  assert.strictEqual(createTap(Object.assign({}, META, { status: 429 }), () => {}), null);
});
ok('ответ без usage записи не создаёт', () => {
  const { written } = run(META, 'data: {"type":"ping"}\n\n');
  assert.strictEqual(written.length, 0);
});
ok('битый JSON в SSE не ломает разбор соседних строк', () => {
  const body = 'data: {ломаный\n\ndata: {"type":"message_delta","usage":{"input_tokens":11,"output_tokens":1}}\n\n';
  const { written } = run(META, body);
  assert.strictEqual(written[0].in, 11);
});
ok('огромный не-SSE ответ не буферизуется целиком', () => {
  const meta = Object.assign({}, META, { headers: { 'content-type': 'application/json' } });
  const { written } = run(meta, 'x'.repeat(2 * 1024 * 1024));
  assert.strictEqual(written.length, 0, 'мусор на 2 МБ просто не считается');
});

console.log('харнессы');
ok('user-agent → имя харнесса', () => {
  assert.strictEqual(harnessOf('claude-cli/2.1.220 (external, cli)'), 'claude-code');
  assert.strictEqual(harnessOf('opencode/0.4.1'), 'opencode');
  assert.strictEqual(harnessOf('curl/8.5.0'), 'curl');
  assert.strictEqual(harnessOf(''), 'unknown');
  assert.strictEqual(harnessOf('MyBot/1.0'), 'mybot');
});
ok('usage без токенов не считается за usage', () => {
  assert.strictEqual(pickUsage({ cost: 0.1 }), null);
  assert.strictEqual(pickUsage(null), null);
});

console.log('ротация журнала');
// ── стенд для ротации ────────────────────────────────────────────────────────
// Свои временные каталоги, живой `token-usage.jsonl` не участвует ни в одном тесте.
const TMP = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'usagetap-'));
  TMP.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});
const shift = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  dt.setDate(dt.getDate() + n);
  return dayKey(dt);
};
// Метка времени, у которой ЛОКАЛЬНЫЙ день равен `day`: журнал хранит UTC, а сутки и
// у потребителя, и у ротации местные — иначе тест зависел бы от часового пояса.
const tsAt = (day, hh, mm) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hh == null ? 12 : hh, mm || 0, 0, 0).toISOString();
};
function writeJournal(dir, spec, pad) {
  const file = path.join(dir, 'token-usage.jsonl');
  const out = [];
  for (const day of Object.keys(spec).sort()) {
    for (let i = 0; i < spec[day]; i++) {
      const rec = { t: tsAt(day, 1 + (i % 22), i % 60), m: 'claude-opus-5', bk: 'jw',
        h: 'claude-code', st: 1, ms: 10, in: 100 + i, out: 10, cr: 0, cw: 0 };
      if (pad) rec.pad = 'x'.repeat(pad);
      out.push(JSON.stringify(rec));
    }
  }
  fs.writeFileSync(file, out.join('\n') + '\n');
  return file;
}
const linesOf = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
// Сутки → число строк, ровно как их считает потребитель: по ЛОКАЛЬНОМУ дню метки.
function daysIn(file) {
  const m = new Map();
  for (const ln of linesOf(file)) {
    let d; try { d = new Date(JSON.parse(ln).t); } catch (e) { continue; }
    if (isNaN(d.getTime())) continue;
    const k = dayKey(d);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
const spanDays = (last, n, per) => {
  const s = {};
  for (let i = 0; i < n; i++) s[shift(last, -i)] = per;
  return s;
};
ok('маленький журнал не ротируется вовсе', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, { '2026-09-04': 5, '2026-09-05': 5 });
  const before = fs.readFileSync(file);
  const r = rotateJournal(file, { now: tsAt('2026-09-05', 20), statsLast: '2026-09-01' });
  assert.strictEqual(r.rotated, false, 'ротации быть не должно, а причина: ' + r.reason);
  assert.ok(Buffer.compare(before, fs.readFileSync(file)) === 0, 'файл байт в байт тот же');
  assert.ok(!fs.existsSync(path.join(dir, 'archive')), 'пустой архив не создаётся');
});

ok('режется по границе суток: ни одни сутки не разорваны', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, spanDays('2026-09-05', 40, 7));
  const before = daysIn(file);
  const r = rotateJournal(file, { now: tsAt('2026-09-05', 23), statsLast: '2026-09-01', keepDays: 30 });
  assert.strictEqual(r.rotated, true, 'ротация должна была случиться: ' + r.reason);
  const after = daysIn(file);
  assert.strictEqual(after.size, 30, 'осталось ровно 30 суток, а не ' + after.size);
  for (const [d, n] of after) assert.strictEqual(n, before.get(d), `сутки ${d} должны остаться целыми`);
  for (const d of r.droppedDays) assert.ok(!after.has(d), `сутки ${d} остались половиной — резали по байтам`);
  assert.strictEqual(r.droppedDays.length, 10, 'выброшено 10 суток');
});

ok('выброшенное уезжает в архив, а не исчезает', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, spanDays('2026-09-05', 40, 7));
  const all = linesOf(file);
  const r = rotateJournal(file, { now: tsAt('2026-09-05', 23), statsLast: '2026-09-01', keepDays: 30 });
  const kept = linesOf(file);
  const arch = r.archives.flatMap(linesOf);
  assert.strictEqual(arch.length + kept.length, all.length, 'сумма строк сошлась: ничего не потеряно');
  assert.deepStrictEqual([...arch, ...kept].sort(), all.slice().sort(), 'строки те же, без подмены');
  for (const f of r.archives) {
    const day = path.basename(f).replace('token-usage-', '').replace('.jsonl', '');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(day), 'в имени архива дата: ' + path.basename(f));
    for (const ln of linesOf(f))
      assert.strictEqual(dayKey(new Date(JSON.parse(ln).t)), day, 'в архиве суток только свои строки');
  }
});
ok('нужное потребителю окно остаётся даже при недостижимом потолке', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, spanDays('2026-09-05', 40, 40), 400);
  // stats-cache отстал на 9 суток → журнал обязан дотянуться до 2026-08-27.
  const r = rotateJournal(file, { now: tsAt('2026-09-05', 23), statsLast: '2026-08-27',
    keepDays: 30, maxBytes: 1024 });
  assert.strictEqual(r.rotated, true, 'ротация должна была случиться: ' + r.reason);
  assert.strictEqual(r.need, 10, 'пол растянут по stats-cache: 9 суток отставания + текущие');
  const first = [...daysIn(file).keys()].sort()[0];
  assert.ok(first <= '2026-08-27',
    `первые сутки журнала ${first} перескочили конец stats-cache 2026-08-27 — тут и появляется дыра`);
  assert.ok(fs.statSync(file).size > 1024, 'пол выше потолка: файл осознанно больше потолка');
});

ok('сутки после конца stats-cache не могут пропасть — регрессия 05.09', () => {
  const dir = tmpdir();
  // Форма живого журнала на 05.09, строки поделены на 10: 25.08…05.09.
  const spec = { '2026-08-25': 66, '2026-08-26': 444, '2026-08-27': 154, '2026-08-28': 138,
    '2026-08-29': 104, '2026-08-30': 125, '2026-08-31': 296, '2026-09-01': 79,
    '2026-09-02': 94, '2026-09-03': 518, '2026-09-04': 424, '2026-09-05': 1194 };
  const file = writeJournal(dir, spec, 120);
  const before = daysIn(file);
  const opts = { now: tsAt('2026-09-05', 23), statsLast: '2026-09-01', maxBytes: 300 * 1024 };
  const r = rotateJournal(file, opts);
  assert.strictEqual(r.rotated, true, 'потолок пробит, ротация обязана быть: ' + r.reason);
  const after = daysIn(file);
  // Сшивка потребителя: дни ДО `cut` берутся из stats-cache (он кончается 01.09),
  // от `cut` — из журнала. `cut` = первые сутки журнала + 1.
  const cut = shift([...after.keys()].sort()[0], 1);
  for (const day of ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) {
    assert.ok(day >= cut,
      `сутки ${day} не покрыты ничем: stats-cache кончился 2026-09-01, журнал начинается с ${cut}`);
    assert.strictEqual(after.get(day), before.get(day), `сутки ${day} целые`);
  }
});
ok('потолок режет целыми сутками и тоже в архив', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, spanDays('2026-09-05', 12, 100), 300);
  const total = fs.statSync(file).size;
  const all = linesOf(file).length;
  const perDay = total / 12;                  // строки одной длины, сутки равновелики
  // Окно по суткам (30) не срабатывает: журналу всего 12 суток. Режет потолок, и
  // ему хватает выбросить четверо старших суток — пол (7 суток) не мешает.
  const r = rotateJournal(file, { now: tsAt('2026-09-05', 23), statsLast: '2026-09-04',
    keepDays: 30, maxBytes: perDay * 8 });
  assert.strictEqual(r.rotated, true, 'ротация по потолку: ' + r.reason);
  assert.ok(fs.statSync(file).size <= perDay * 8, 'влезли в потолок');
  const after = daysIn(file);
  assert.strictEqual(after.size, 8, 'осталось 8 суток, а не ' + after.size);
  assert.strictEqual(r.droppedDays.length, 4, 'выброшено ровно 4 суток');
  for (const [, n] of after) assert.strictEqual(n, 100, 'все оставшиеся сутки целые');
  assert.strictEqual(r.archives.flatMap(linesOf).length + linesOf(file).length, all,
    'выброшенное потолком тоже в архиве');
});

ok('после ротации файл КОРОЧЕ — на этом потребитель и ловит подмену', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, spanDays('2026-09-05', 40, 7));
  const st0 = fs.statSync(file);
  const r = rotateJournal(file, { now: tsAt('2026-09-05', 23), statsLast: '2026-09-01' });
  const st1 = fs.statSync(file);
  assert.ok(st1.size < st0.size, 'размер уменьшился — tailRead перечитает файл целиком');
  assert.strictEqual(r.size, st1.size, 'отчёт о размере честный');
  if (st0.ino) assert.strictEqual(st1.ino, st0.ino, 'перезапись НА МЕСТЕ: ino не меняется');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('\n'), 'файл кончается переводом строки');
  assert.ok(!raw.includes('\r'), 'CR не появился');
  assert.ok(!raw.startsWith('\n'), 'пустой первой строки нет');
  JSON.parse(raw.slice(0, raw.indexOf('\n')));            // первая строка — целая запись
});

ok('повторная ротация не дублирует архив', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, spanDays('2026-09-05', 40, 7));
  const original = fs.readFileSync(file);
  const opts = { now: tsAt('2026-09-05', 23), statsLast: '2026-09-01' };
  const r1 = rotateJournal(file, opts);
  const sizes = r1.archives.map(f => [f, fs.statSync(f).size]);
  fs.writeFileSync(file, original);          // как будто упали между архивом и перезаписью
  const r2 = rotateJournal(file, opts);
  assert.strictEqual(r2.rotated, true, 'второй проход снова режет: ' + r2.reason);
  for (const [f, size] of sizes)
    assert.strictEqual(fs.statSync(f).size, size, 'архив ' + path.basename(f) + ' не вырос вдвое');
});
ok('нераспознанные строки не теряются', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, spanDays('2026-09-05', 40, 7));
  const all = linesOf(file);
  all.splice(3, 0, '{битая строка старых суток');
  all.push('{битая строка свежих суток');
  fs.writeFileSync(file, all.join('\n') + '\n');
  const r = rotateJournal(file, { now: tsAt('2026-09-05', 23), statsLast: '2026-09-01' });
  const back = [...linesOf(file), ...r.archives.flatMap(linesOf)];
  assert.strictEqual(back.length, all.length, 'ни одна строка не пропала');
  for (const bad of ['{битая строка старых суток', '{битая строка свежих суток'])
    assert.strictEqual(back.filter(l => l === bad).length, 1, 'мусорная строка на месте и одна: ' + bad);
});

ok('никогда не оставляет журнал пустым', () => {
  const dir = tmpdir();
  const file = writeJournal(dir, { '2026-01-01': 50 }, 400);      // только древние сутки
  const before = fs.readFileSync(file);
  const r = rotateJournal(file, { now: tsAt('2026-09-05', 12), statsLast: null,
    keepDays: 1, minKeepDays: 1, maxBytes: 512 });
  assert.strictEqual(r.rotated, false, 'выбрасывать всё нельзя, причина: ' + r.reason);
  assert.strictEqual(r.reason, 'would-empty');
  assert.ok(Buffer.compare(before, fs.readFileSync(file)) === 0, 'файл не тронут');
});

ok('appendRecord не меняет формат строки и подрезает переросшее окно', () => {
  const dir = tmpdir();
  // 90 суток: окно по суткам (30) обязано срабатывать даже если stats-cache на этой
  // машине отстал сильно. Отстал больше чем на 90 — тест упадёт, и это правильно.
  const today = dayKey(new Date());
  const file = writeJournal(dir, spanDays(today, 90, 3), 200);
  const before = fs.statSync(file).size;
  appendRecord({ t: new Date().toISOString(), m: 'claude-opus-5', in: 1, out: 2 }, file);
  const raw = fs.readFileSync(file, 'utf8');
  const last = JSON.parse(raw.slice(0, -1).split('\n').pop());
  assert.deepStrictEqual(Object.keys(last), ['t', 'm', 'in', 'out'], 'строка = тот же JSON, что дали');
  assert.ok(fs.statSync(file).size < before, 'первая же запись подрезала журнал по суткам');
  assert.ok(fs.existsSync(path.join(dir, 'archive')), 'архив создан рядом с журналом');
  assert.ok(fs.existsSync(path.join(dir, 'archive', '.gitignore')), 'архив закрыт от git');
  const days = [...daysIn(file).keys()].sort();
  assert.ok(days.length <= 30, 'осталось не больше 30 суток, а ' + days.length);
  assert.strictEqual(days[days.length - 1], today, 'сегодняшние сутки на месте');
});

console.log(`\n${pass} проверок зелёные`);
