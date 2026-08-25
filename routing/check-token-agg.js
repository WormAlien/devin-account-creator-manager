// Проверка агрегатора: подсовываем журнал и смотрим, что бакеты сходятся.
const fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokagg-'));
const file = path.join(dir, 'token-usage.jsonl');
const today = new Date().toISOString().slice(0, 10);
const yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const rows = [
  { t: today + 'T10:00:00.000Z', m: 'claude-opus-5', h: 'claude-code', in: 1000, out: 100, cr: 50, cw: 25, cost: 0.5 },
  { t: today + 'T11:00:00.000Z', m: 'claude-opus-5', h: 'opencode',    in: 2000, out: 200, cr: 0,  cw: 0,  cost: 1.0 },
  { t: yest  + 'T09:00:00.000Z', m: 'claude-fable-5', h: 'claude-code', in: 500, out: 50, cr: 0, cw: 0, cost: 0.25 },
  { t: '2020-01-01T00:00:00.000Z', m: 'x', h: 'y', in: 999999, out: 1, cost: 9 },   // вне окна
  '{битая строка',
].map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(file, rows);

// повторяем логику агрегатора из handleFinanceHistory на 7 дней
const conf = { n: 7 };
const now = new Date();
const keyOf = d => d.toISOString().slice(0, 10);
const buckets = [];
for (let i = conf.n - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i);
  buckets.push({ k: keyOf(d), tin: 0, tout: 0, tcr: 0, tcw: 0, tcost: 0, treq: 0 }); }
const idx = new Map(buckets.map((b, i) => [b.k, i]));
const tokens = { lines: 0, used: 0, bad: 0, harness: {}, model: {}, in: 0, out: 0, cr: 0, cw: 0, cost: 0, req: 0 };
for (const ln of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!ln) continue; tokens.lines++;
  let e; try { e = JSON.parse(ln); } catch (_) { tokens.bad++; continue; }
  const i = idx.get(String(e.t).slice(0, 10)); if (i == null) continue;
  tokens.used++; const b = buckets[i];
  b.tin += +e.in||0; b.tout += +e.out||0; b.tcr += +e.cr||0; b.tcw += +e.cw||0; b.tcost += +e.cost||0; b.treq++;
  tokens.in += +e.in||0; tokens.out += +e.out||0; tokens.cr += +e.cr||0; tokens.cw += +e.cw||0; tokens.cost += +e.cost||0; tokens.req++;
  if (e.h) tokens.harness[e.h] = (tokens.harness[e.h]||0) + ((+e.in||0)+(+e.out||0));
  if (e.m) tokens.model[e.m] = (tokens.model[e.m]||0) + ((+e.in||0)+(+e.out||0));
}
const assert = require('assert');
assert.strictEqual(tokens.lines, 5, 'строк прочитано');
assert.strictEqual(tokens.bad, 1, 'битая строка посчитана и пропущена');
assert.strictEqual(tokens.used, 3, 'вне окна не берём');
assert.strictEqual(tokens.in, 3500); assert.strictEqual(tokens.out, 350);
assert.strictEqual(tokens.cr, 50); assert.strictEqual(tokens.cw, 25);
assert.ok(Math.abs(tokens.cost - 1.75) < 1e-9, 'цена суммируется');
const t = buckets[buckets.length - 1];
assert.strictEqual(t.tin, 3000, 'сегодняшний бакет = две записи');
assert.strictEqual(t.treq, 2);
assert.strictEqual(tokens.harness['claude-code'], (1000+100)+(500+50));
assert.strictEqual(tokens.harness['opencode'], 2200);
assert.strictEqual(Object.keys(tokens.model).length, 2);
// ставка, которую видно из журнала
const total = tokens.in + tokens.out + tokens.cr + tokens.cw;
console.log('всего токенов', total, '| цена $' + tokens.cost.toFixed(2),
            '| ставка $' + (tokens.cost / (total / 1e6)).toFixed(2) + ' за 1M');
fs.rmSync(dir, { recursive: true, force: true });
console.log('агрегатор: 12 проверок зелёные');
