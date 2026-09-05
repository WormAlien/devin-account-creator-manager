/*
 * event-store.js — минутные бакеты СОБЫТИЙ прокси: формат, окно, файл.
 *
 * Зачем отдельно от latency-store.js, хотя формат родственный: там измеряется время
 * ответа, здесь считаются события, из которых видно ПОВЕДЕНИЕ защит — сколько раз
 * удержание спасло запрос, сколько раз шлюз оборвал ответ, сколько раз мы сами порвали
 * вставший поток.
 *
 * Почему файл, а не только счётчики в памяти. `GET /__state` отдаёт статистику текущего
 * процесса, и она обнуляется при каждом рестарте. А рестарты частые: 05.09 дашборд
 * поднимался в 02:40, 02:54, 03:23 и 03:36 — четыре раза за час, и после каждого картина
 * начиналась с нуля. Разбирая отказ, приходилось искать в логе строку `listening on`,
 * считать от неё и складывать с предыдущим файлом лога. Здесь история переживает
 * рестарт, а метка `boot` показывает сами рестарты на той же шкале.
 *
 * Почему бакеты, а не строки. Строка на запрос — это мегабайты в сутки и ротация,
 * которая эту историю и уничтожает. Бакет = минута, в бакете только НЕнулевые счётчики:
 * 2880 бакетов (48ч) при полной нагрузке ≈ 170 КБ, и размер не растёт со временем.
 *
 * Бакет: { m: индекс минуты (Date.now()/60000), c: { req: 12, ok: 11, err: 1, … } }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BUCKET_MS = 60000;
const BUCKETS = 2880;                 // 48ч: сутки слишком мало, рестарты частые

// Известные события. Список закрытый намеренно: незнакомый ключ в файле игнорируется при
// чтении, иначе опечатка в вызове тихо создала бы «новое событие», которого никто не ждёт.
const EVENTS = [
  'boot',        // процесс поднялся — по этой метке видны рестарты на шкале
  'req',         // запрос принят
  'ok',          // ответ отдан клиенту с 2xx
  'err',         // клиенту ушла ошибка (любая)
  'precommit',   // пре-коммит SSE: клиент взят на пинги
  'jsonhold',    // не-стримовый ответ удержан пробелами
  'hold',        // удержание при обрыве пути (путь лежал, дождались)
  'empty',       // пустой поток переигран (заголовки/пинги были, содержимого нет)
  'stall',       // поток встал посреди ответа — порвали сами
  'abort',       // шлюз оборвал ответ, спасти нельзя
  'route',       // подмена мёртвой модели тира на живую
  'rotate',      // ротация аккаунта
  'clientgone',  // клиент ушёл сам
  'truncated',   // поток кончился БЕЗ `message_stop`: ответ неполный, и это невидимо
                 // без явной проверки — мы честно пересылаем байты, апстрим кончается,
                 // мы закрываем ответ, а клиент печатает `Connection closed mid-response`
];
const KNOWN = new Set(EVENTS);

function fileFor(port, dir) {
  return path.join(dir || __dirname, `keepalive-events-${Number(port)}.json`);
}

// Прочитать файл. null = нет файла или он битый: для читателя это одно и то же.
// Бакеты старше окна отбрасываем здесь, чтобы не тащить мусор ни в память, ни в ответ.
function readFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return null; }
  let o;
  try { o = JSON.parse(raw) || {}; } catch (e) { return null; }
  const nowM = Math.floor(Date.now() / BUCKET_MS);
  const buckets = [];
  for (const b of o.buckets || []) {
    const m = Number(b && b.m);
    if (!Number.isFinite(m) || m > nowM || m <= nowM - BUCKETS) continue;
    const c = {};
    for (const [k, v] of Object.entries((b && b.c) || {})) {
      const n = Number(v);
      if (KNOWN.has(k) && Number.isFinite(n) && n > 0) c[k] = n;
    }
    if (Object.keys(c).length) buckets.push({ m, c });
  }
  buckets.sort((a, z) => a.m - z.m);
  return { buckets };
}

const readStore = (port, dir) => readFile(fileFor(port, dir));

// Сводка за окно: итоги и точки по минутам. Пустые минуты нулями НЕ заполняем — «в эту
// минуту ничего не происходило» и «в эту минуту было ноль ошибок при сотне запросов» это
// разные утверждения, и второе видно только по наличию бакета.
function summarize(buckets, windowSec) {
  const win = Math.max(60, Math.min(BUCKETS * 60, Number(windowSec) || 86400));
  const nowM = Math.floor(Date.now() / BUCKET_MS);
  const fromM = nowM - Math.ceil(win / 60) + 1;
  const totals = {};
  const points = [];
  let oldestM = null, newestM = null;
  for (const b of buckets || []) {
    if (newestM === null || b.m > newestM) newestM = b.m;
    if (oldestM === null || b.m < oldestM) oldestM = b.m;
    if (b.m < fromM || b.m > nowM) continue;
    points.push({ t: b.m * BUCKET_MS, c: Object.assign({}, b.c) });
    for (const [k, v] of Object.entries(b.c)) totals[k] = (totals[k] || 0) + v;
  }
  return {
    window_sec: win, bucket_ms: BUCKET_MS, now: Date.now(),
    totals,
    // Границы ВСЕЙ истории, независимо от окна: без них «данных нет» не отличить от
    // «данные есть, но старше окна» — та же ловушка, что была у графика латентности.
    oldest_at: oldestM === null ? 0 : oldestM * BUCKET_MS,
    newest_at: newestM === null ? 0 : newestM * BUCKET_MS,
    points,
  };
}

// ── Пишущая сторона ───────────────────────────────────────────────────────────
// Живёт здесь же, чтобы формат знал ровно один файл. Возвращает { note, flush }.
//
// Запись отложенная (flushMs) и атомарная (tmp + rename): событие происходит в горячем
// пути запроса, и синхронный писать-на-диск на каждый чанк — это ровно та беда, из-за
// которой статуслайн разогнал свой лог до 80 МБ. Плата: при жёстком kill теряется
// последнее окно flushMs. Это осознанно — история нужна для разбора, а не для биллинга.
function createWriter(filePath, opts = {}) {
  const flushMs = Number(opts.flushMs) || 10000;
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  const loaded = readFile(filePath);
  const map = new Map();
  for (const b of (loaded && loaded.buckets) || []) map.set(b.m, b.c);
  let timer = null;
  let dirty = false;

  const write = () => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    const nowM = Math.floor(Date.now() / BUCKET_MS);
    const buckets = [];
    for (const [m, c] of map) {
      if (m <= nowM - BUCKETS) { map.delete(m); continue; }
      buckets.push({ m, c });
    }
    buckets.sort((a, z) => a.m - z.m);
    const tmp = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, buckets }));
      fs.renameSync(tmp, filePath);
    } catch (e) {
      onError(e);
      try { fs.unlinkSync(tmp); } catch (e2) { /* и так не вышло */ }
    }
  };

  const note = (kind, n) => {
    if (!KNOWN.has(kind)) return;
    const add = Number(n) || 1;
    const m = Math.floor(Date.now() / BUCKET_MS);
    let c = map.get(m);
    if (!c) { c = {}; map.set(m, c); }
    c[kind] = (c[kind] || 0) + add;
    dirty = true;
    if (timer === null) {
      timer = setTimeout(write, flushMs);
      if (timer.unref) timer.unref();     // не держим процесс живым из-за истории
    }
  };

  // Что накопилось в памяти прямо сейчас, включая ещё не сброшенную минуту. Нужно
  // публичному состоянию: читать файл на каждый `/__state` бессмысленно, а показывать
  // цифры на десять секунд отстающими — тем более.
  const snapshot = () => {
    const out = [];
    for (const [m, c] of map) out.push({ m, c: Object.assign({}, c) });
    out.sort((a, z) => a.m - z.m);
    return out;
  };

  return { note, flush: write, snapshot };
}

module.exports = { BUCKET_MS, BUCKETS, EVENTS, fileFor, readFile, readStore, summarize, createWriter };
