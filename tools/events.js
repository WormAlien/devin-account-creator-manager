#!/usr/bin/env node
/*
 * events.js — что происходило с прокси, включая время ДО последнего рестарта.
 *
 * `GET /__state` показывает счётчики текущего процесса и обнуляется вместе с ним, а
 * рестарты частые: 05.09 дашборд поднимался в 02:40, 02:54, 03:23 и 03:36. История
 * событий лежит в `routing/keepalive-events-<порт>.json` минутными бакетами и рестарт
 * переживает — этот скрипт её печатает. Процесс для работы НЕ нужен: читаем файл.
 *
 *   node tools/events.js              # активный порт из ~/.claude/active-backend.json, 24ч
 *   node tools/events.js 20161 6      # порт и окно в часах
 *   node tools/events.js 20161 6 --by-hour
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const es = require('../routing/event-store.js');

const ROUTING = path.join(__dirname, '..', 'routing');

// Порт активного бэкенда — тот, по которому чаще всего и спрашивают.
function activePort() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'active-backend.json'), 'utf8'));
    const m = /:(\d+)/.exec(String(doc.upstream || ''));
    return m ? Number(m[1]) : null;
  } catch (e) { return null; }
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const byHour = process.argv.includes('--by-hour');
const port = Number(args[0]) || activePort();
const hours = Math.max(1, Math.min(48, Number(args[1]) || 24));

if (!port) {
  console.error('не понял порт: передай его первым аргументом (node tools/events.js 20161)');
  process.exit(2);
}

const file = es.fileFor(port, ROUTING);
const store = es.readFile(file);
if (!store || !store.buckets.length) {
  console.log(`истории нет: ${path.basename(file)} отсутствует или пуст.`);
  console.log('Она появляется после рестарта прокси с этим кодом — старый писал только stats в память.');
  process.exit(0);
}

const s = es.summarize(store.buckets, hours * 3600);
const fmt = (t) => new Date(t).toLocaleString('sv').slice(5, 16);
const T = s.totals;
const n = (k) => T[k] || 0;

console.log(`порт ${port} · окно ${hours}ч · история ${fmt(s.oldest_at)} … ${fmt(s.newest_at)}`);
console.log('');
const req = n('req');
const bad = n('err');
console.log(`запросов        ${req}`);
console.log(`ответов 2xx     ${n('ok')}`);
console.log(`ошибок клиенту  ${bad}${req ? `  (${(bad / req * 100).toFixed(2)}%)` : ''}`);
console.log('');
console.log('сработали защиты:');
console.log(`  удержание пути      ${n('hold')}`);
console.log(`  пустой поток        ${n('empty')}`);
console.log(`  подмена модели      ${n('route')}`);
console.log(`  ротация аккаунта    ${n('rotate')}`);
console.log(`  пре-коммит SSE      ${n('precommit')}`);
console.log(`  JSON пробелами      ${n('jsonhold')}`);
console.log('');
console.log('потери:');
console.log(`  шлюз оборвал ответ  ${n('abort')}`);
console.log(`  мы порвали вставший ${n('stall')}`);
console.log(`  клиент ушёл сам     ${n('clientgone')}`);
console.log('');
console.log(`рестартов прокси в окне: ${n('boot')}`);

if (byHour) {
  console.log('');
  console.log('по часам (запросы / ошибки / обрывы шлюза / рестарты):');
  const byH = new Map();
  for (const p of s.points) {
    const h = new Date(p.t).toISOString().slice(0, 13);
    const acc = byH.get(h) || { req: 0, err: 0, abort: 0, boot: 0 };
    for (const k of Object.keys(acc)) acc[k] += p.c[k] || 0;
    byH.set(h, acc);
  }
  for (const [h, a] of [...byH.entries()].sort()) {
    const mark = a.boot ? `  ← рестарт ×${a.boot}` : '';
    console.log(`  ${h.replace('T', ' ')}:00   ${String(a.req).padStart(5)} / ${String(a.err).padStart(3)} / ${String(a.abort).padStart(3)}${mark}`);
  }
}
