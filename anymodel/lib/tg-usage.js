// anymodel/lib/tg-usage.js
//
// Учёт ТГ, использованных ИМЕННО AnyModel. Один ТГ может регаться на разных
// сервисах (FreeModel, Conduit, AnyModel), поэтому общий tgPool.status не
// трогаем — это маркер FreeModel. banned остаётся единственным глобальным
// статусом: мёртвый ТГ мёртв везде.

const fs = require('fs');
const path = require('path');
const tgPool = require('../../freemodel/lib/tg-pool');

const TG_USED_FILE = path.join(__dirname, '..', '.tg_used.json');

function loadUsed() {
  try { return new Set(JSON.parse(fs.readFileSync(TG_USED_FILE, 'utf8'))); } catch { return new Set(); }
}

function markUsed(phone) {
  const s = loadUsed(); s.add(String(phone));
  try { fs.writeFileSync(TG_USED_FILE, JSON.stringify([...s], null, 2), 'utf8'); } catch {}
}

function unmarkUsed(phone) {
  const s = loadUsed();
  if (!s.delete(String(phone))) return false;
  try { fs.writeFileSync(TG_USED_FILE, JSON.stringify([...s], null, 2), 'utf8'); } catch {}
  return true;
}

// Живые кандидаты: не banned, не dead по health-кэшу, ещё не использованные AnyModel.
function available() {
  const used = loadUsed();
  const health = tgPool.loadHealthCache();
  return tgPool.list().filter(e =>
    e.status !== 'banned' &&
    !tgPool.isDead(e.phone, health) &&
    !used.has(String(e.phone))
  );
}

function pick() {
  return available()[0] || null;
}

function stats() {
  const used = loadUsed();
  const all = tgPool.list();
  return {
    total: all.length,
    usedByAnymodel: all.filter(e => used.has(String(e.phone))).length,
    banned: all.filter(e => e.status === 'banned').length,
    available: available().length,
  };
}

module.exports = { TG_USED_FILE, loadUsed, markUsed, unmarkUsed, available, pick, stats };
