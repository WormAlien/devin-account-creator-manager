/*
 * latency-store.js — минутные бакеты времени ответа: формат, нарезка окна, файл.
 *
 * Читают ДВА процесса, поэтому логика живёт здесь, а не в одном из них:
 *   - keepalive-proxy.js  — пишет живые замеры и отдаёт их из памяти (`GET /__latency`);
 *   - transparent-proxy.js — когда прокси провайдера не запущен (провайдер неактивен,
 *     его keepalive снят), отдаёт ту же историю ПРЯМО С ДИСКА. Иначе график был бы
 *     только у активного провайдера, а у остальных «не отвечает» — при том, что
 *     измерения за сутки лежат в файле рядом.
 *
 * Бакет = минута: {m: индекс минуты (Date.now()/60000), n, sum, min, max}.
 * Кольца тут нет — оно нужно только пишущей стороне; здесь массив бакетов.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BUCKET_MS = 60000;
const BUCKETS = 1440;                 // 24ч при бакете в минуту

function fileFor(port, dir) {
  return path.join(dir || __dirname, `keepalive-latency-${Number(port)}.json`);
}

// Точки за окно, по возрастанию времени. Пустые минуты НЕ выдумываем нулями: «в эту
// минуту запросов не было» и «в эту минуту отвечали за 0мс» — разные вещи, и ноль на
// графике читался бы как мгновенный ответ.
function series(buckets, windowSec, meta) {
  const m0 = meta || {};
  const win = Math.max(60, Math.min(86400, Number(windowSec) || 86400));
  const now = Date.now();
  const nowM = Math.floor(now / BUCKET_MS);
  const fromM = nowM - Math.ceil(win / 60) + 1;
  const pts = [];
  for (const b of buckets || []) {
    if (!b || !(b.n > 0) || b.m < fromM || b.m > nowM) continue;
    pts.push({ t: b.m * BUCKET_MS, n: b.n, avg: Math.round(b.sum / b.n), min: b.min, max: b.max });
  }
  pts.sort((a, z) => a.t - z.t);
  const all = pts.reduce((acc, p) => {
    acc.n += p.n; acc.sum += p.avg * p.n;
    if (p.max > acc.max) acc.max = p.max;
    return acc;
  }, { n: 0, sum: 0, max: 0 });
  return {
    window_sec: win, bucket_ms: BUCKET_MS, now,
    last_ms: Number(m0.last_ms) || 0, last_at: Number(m0.last_at) || 0,
    total: all.n, avg_ms: all.n ? Math.round(all.sum / all.n) : 0, max_ms: all.max,
    points: pts,
  };
}

// Прочитать файл истории. null = файла нет или он битый (для читателя это одно и то же:
// показывать нечего). Бакеты старше суток отбрасываем здесь же — они всё равно вне
// любого окна, но так не тащим мусор в память.
function readFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return null; }
  let o;
  try { o = JSON.parse(raw) || {}; } catch (e) { return null; }
  const nowM = Math.floor(Date.now() / BUCKET_MS);
  const buckets = [];
  for (const b of o.buckets || []) {
    const m = Number(b && b.m);
    const n = Number(b && b.n) || 0;
    if (!Number.isFinite(m) || n <= 0 || m > nowM || m <= nowM - BUCKETS) continue;
    buckets.push({ m, n, sum: Number(b.sum) || 0, min: Number(b.min) || 0, max: Number(b.max) || 0 });
  }
  return { buckets, last_ms: Number(o.last_ms) || 0, last_at: Number(o.last_at) || 0 };
}

const readStore = (port, dir) => readFile(fileFor(port, dir));

module.exports = { BUCKET_MS, BUCKETS, fileFor, series, readFile, readStore };
