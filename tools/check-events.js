#!/usr/bin/env node
/*
 * check-events.js — регресс на историю событий прокси (routing/event-store.js).
 *
 * Зачем файл существует: `GET /__state` обнуляется вместе с процессом, а рестарты
 * частые — 05.09 дашборд поднимался четыре раза за час. История в минутных бакетах
 * рестарт переживает, и цена ошибки в ней ровно та же, что у любого журнала: если он
 * молча теряет данные или, наоборот, растёт без предела, узнают об этом в самый
 * неподходящий момент.
 *
 * Живой стек НЕ трогает: всё в своём временном каталоге.
 *
 * Запуск: node tools/check-events.js      (exit 1 = история сломана)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const es = require('../routing/event-store.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-check-'));
const file = path.join(TMP, 'ev.json');
let checks = 0;

try {
  // 1. Пустое место: читатель обязан сказать «нечего», а не упасть.
  assert.strictEqual(es.readFile(path.join(TMP, 'нет-такого.json')), null, 'нет файла → null');
  checks += 1;

  // 2. Счётчики складываются, неизвестные ключи игнорируются молча.
  const w = es.createWriter(file, { flushMs: 1 });
  w.note('req', 3);
  w.note('req');
  w.note('err');
  w.note('такого-события-нет');
  w.flush();
  let st = es.readFile(file);
  assert.strictEqual(st.buckets.length, 1, 'одна минута — один бакет');
  assert.deepStrictEqual(st.buckets[0].c, { req: 4, err: 1 }, 'счётчики сложились, мусор отброшен');
  checks += 2;

  // 3. Главное свойство: новый писатель ДОЧИТЫВАЕТ файл, а не затирает его. Иначе
  //    история терялась бы при каждом рестарте — то есть ровно тогда, когда нужна.
  const w2 = es.createWriter(file, { flushMs: 1 });
  w2.note('boot');
  w2.note('req', 2);
  w2.flush();
  st = es.readFile(file);
  assert.deepStrictEqual(st.buckets[0].c, { req: 6, err: 1, boot: 1 }, 'после «рестарта» прежние цифры на месте');
  checks += 1;

  // 4. Окно: сводка считает только своё окно, но границы всей истории отдаёт всегда —
  //    иначе «данных нет» не отличить от «данные старше окна».
  const nowM = Math.floor(Date.now() / es.BUCKET_MS);
  const old = { m: nowM - 200, c: { req: 7 } };
  fs.writeFileSync(file, JSON.stringify({ v: 1, buckets: [old, { m: nowM, c: { req: 1 } }] }));
  const s1 = es.summarize(es.readFile(file).buckets, 3600);
  assert.strictEqual(s1.totals.req, 1, 'в окно часа попал только свежий бакет');
  assert.ok(s1.oldest_at < s1.newest_at, 'границы всей истории видны за пределами окна');
  const s2 = es.summarize(es.readFile(file).buckets, 24 * 3600);
  assert.strictEqual(s2.totals.req, 8, 'окно сутки видит оба бакета');
  checks += 3;

  // 5. Размер ограничен: бакеты старше BUCKETS минут не читаются и не переписываются.
  //    Без этого файл рос бы вечно — та же беда, что у забытого лога статуслайна на 80 МБ.
  fs.writeFileSync(file, JSON.stringify({ v: 1, buckets: [{ m: nowM - es.BUCKETS - 5, c: { req: 99 } }] }));
  assert.deepStrictEqual(es.readFile(file), { buckets: [] }, 'бакет старше окна истории отброшен');
  const w3 = es.createWriter(file, { flushMs: 1 });
  w3.note('req');
  w3.flush();
  assert.strictEqual(es.readFile(file).buckets.length, 1, 'при записи старьё не возвращается в файл');
  checks += 2;

  // 6. Битый файл не роняет ни читателя, ни писателя: история — не критичный путь.
  fs.writeFileSync(file, 'это не json');
  assert.strictEqual(es.readFile(file), null, 'мусор в файле → null, без исключения');
  const w4 = es.createWriter(file, { flushMs: 1 });
  w4.note('req');
  w4.flush();
  assert.strictEqual(es.readFile(file).buckets[0].c.req, 1, 'писатель поверх мусора начинает заново');
  checks += 2;

  // 7. Запись атомарная: временного файла после сброса не остаётся.
  assert.ok(!fs.existsSync(`${file}.tmp`), 'tmp-файл убран после rename');
  checks += 1;

  // 8. Список событий закрытый — опечатка в вызове не создаёт «новое событие».
  assert.ok(es.EVENTS.includes('hold') && es.EVENTS.includes('empty') && es.EVENTS.includes('stall'),
    'ключевые защиты в списке событий');
  checks += 1;

  console.log(`check-events OK (${checks} проверок): история складывается, переживает рестарт писателя, `
    + 'ограничена по размеру и не падает от мусора');
  process.exitCode = 0;
} catch (e) {
  console.error('ПРОВАЛ: ' + e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* не критично */ }
}
