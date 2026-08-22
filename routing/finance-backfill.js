#!/usr/bin/env node
// Ретро-заполнение истории финансов из того, что уже есть в пулах.
//
// Логов расхода до 21.08 не существует, но в sessions.json лежат три факта на
// каждый ключ: `created` (когда завёлся), `granted` (сколько шлюз налил всего)
// и `spent` (сколько с него сожрано). Из них восстанавливается правдоподобная
// история: выдача падает на дату создания ключа, расход растягивается ровно по
// дням жизни ключа. Это ОЦЕНКА, и она помечена в каждой строке полем est:true —
// чтобы потом было видно, где реконструкция, а где живой лог.
//
// Запуск:  node finance-backfill.js --dry-run   (только показать)
//          node finance-backfill.js             (дописать в finance-history.jsonl)
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = path.join(DIR, 'finance-history.jsonl');
const POOLS = {
    agentrouter: 'agentrouter-sessions.json',
    gorouter: 'gorouter-sessions.json',
    tabitoken: 'tabi-sessions.json',
    xpeach: 'xpeach-sessions.json',
    // Ключ = имя провайдера в поле `p` истории (то же, что в pools вкладки «Финансы»),
    // а не префикс вкладки: там `justwoker`, а не `jw`.
    justwoker: 'justwoker-sessions.json',
};
const dry = process.argv.includes('--dry-run');
const midnight = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const today = midnight(new Date());

const events = [];
for (const [provider, file] of Object.entries(POOLS)) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch (e) { continue; }
    const arr = Array.isArray(raw) ? raw : (raw.sessions || Object.values(raw).find(Array.isArray) || []);
    for (const s of arr) {
        if (!s || !s.created) continue;
        const born = new Date(s.created);
        if (isNaN(born)) continue;
        const id = s.id || s.email || String(s.api_key || '').slice(-6);
        const granted = Number(s.granted) || 0;
        const spent = Number(s.spent) || 0;
        // выдача — одним событием в день создания ключа
        if (granted > 0) events.push({ t: born.toISOString(), p: provider, id, dSpent: 0, dGrant: +granted.toFixed(4), est: true });
        if (spent <= 0) continue;
        // Расход — равномерно по дням жизни ключа, включая день создания и сегодня.
        // Дни считаются по полуночам: разница «как есть» в миллисекундах давала на
        // один день меньше или больше в зависимости от часа регистрации, и сумма
        // реконструкции не сходилась с пулом (расходилась на ~$570 из $5000).
        const days = Math.max(1, Math.round((today - midnight(born)) / 86400000) + 1);
        const per = spent / days;
        for (let i = 0; i < days; i++) {
            const d = new Date(born); d.setDate(d.getDate() + i);
            events.push({ t: d.toISOString(), p: provider, id, dSpent: +per.toFixed(6), dGrant: 0, est: true });
        }
    }
}
events.sort((a, b) => a.t.localeCompare(b.t));

// сводка по дням — она же проверка, что цифры сошлись с пулами
const byDay = {};
for (const e of events) {
    const k = e.t.slice(0, 10);
    byDay[k] = byDay[k] || { spend: 0, topup: 0, n: 0 };
    byDay[k].spend += e.dSpent; byDay[k].topup += e.dGrant; byDay[k].n++;
}
let sumS = 0, sumT = 0;
console.log('день         расход    наливка   событий');
for (const k of Object.keys(byDay).sort()) {
    const b = byDay[k]; sumS += b.spend; sumT += b.topup;
    console.log(`${k}  ${('$' + b.spend.toFixed(2)).padStart(9)} ${('$' + b.topup.toFixed(2)).padStart(9)}   ${b.n}`);
}
console.log(`итого        ${('$' + sumS.toFixed(2)).padStart(9)} ${('$' + sumT.toFixed(2)).padStart(9)}   ${events.length}`);

// Сверка с пулами: реконструкция обязана давать те же суммы, что лежат в файлах.
// Без этой проверки ошибка в арифметике дней проходит незамеченной — график
// выглядит правдоподобно, но занижает расход.
let poolS = 0, poolT = 0;
for (const file of Object.values(POOLS)) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch (e) { continue; }
    const arr = Array.isArray(raw) ? raw : (raw.sessions || Object.values(raw).find(Array.isArray) || []);
    for (const s of arr) {
        if (!s || !s.created) continue;
        poolS += Number(s.spent) || 0; poolT += Number(s.granted) || 0;
    }
}
const dS = Math.abs(poolS - sumS), dT = Math.abs(poolT - sumT);
console.log(`в пулах      ${('$' + poolS.toFixed(2)).padStart(9)} ${('$' + poolT.toFixed(2)).padStart(9)}`);
console.log(`расхождение  ${('$' + dS.toFixed(2)).padStart(9)} ${('$' + dT.toFixed(2)).padStart(9)}`
    + (dS < 1 && dT < 1 ? '  ✓ сходится' : '  ✗ проверь арифметику'));

if (dry) { console.log('\n--dry-run: файл не тронут'); process.exit(0); }
if (fs.existsSync(OUT)) {
    const has = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean);
    if (has.some(l => l.includes('"est":true'))) {
        console.log(`\n${path.basename(OUT)} уже содержит реконструкцию — второй раз не дописываю.`);
        process.exit(0);
    }
}
fs.appendFileSync(OUT, events.map(e => JSON.stringify(e)).join('\n') + '\n');
console.log(`\nдописано ${events.length} строк в ${path.basename(OUT)}`);
