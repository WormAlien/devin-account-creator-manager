// conduit/conduit_autoreger.js
//
// Автореги Conduit из Telegram. Без браузера/почты: чистый gramjs + device-code
// (/api/auth start→poll). Один ТГ из общего пула (freemodel/tg_pool.json) = один
// аккаунт Conduit.
//
//   node conduit/conduit_autoreger.js [count] [ref_XXXX]
//   count — сколько аккаунтов (по умолч. 1). ref — стартовый реф (иначе из .last_ref).
//
// Реф-цепочка: каждый новый акк реферится предыдущим (его refLink из /api/me).
// Стартовый реф персистится в conduit/.last_ref (как freemodel/.last_invite).
//
// ВАЖНО: один ТГ может регаться на РАЗНЫХ сервисах (FreeModel И Conduit). Поэтому
// общий tgPool.status НЕ трогаем (это маркер FreeModel) — ведём свой список
// использованных Conduit в conduit/.tg_used.json. banned — единственный глобальный
// статус (мёртвый ТГ мёртв везде).

const fs = require('fs');
const path = require('path');
const { Api } = require('telegram');
const tgPool = require('../freemodel/lib/tg-pool');
const tgClient = require('../freemodel/lib/tg-client');
const api = require('./lib/conduit-api');

const BOT = 'conduitoff_bot';
const CHANNEL = 'conduitapi';
const ACCOUNTS_DIR = path.join(__dirname, 'accounts');
const TG_USED_FILE = path.join(__dirname, '.tg_used.json');  // ТГ, использованные ИМЕННО Conduit
const POLL_TIMEOUT_MS = 90_000;

// Один ТГ может регаться на РАЗНЫХ сервисах (FreeModel И Conduit). Поэтому НЕ трогаем
// общий tgPool.status (это маркер FreeModel) — ведём свой список использованных Conduit.
function loadTgUsed() {
  try { return new Set(JSON.parse(fs.readFileSync(TG_USED_FILE, 'utf8'))); } catch { return new Set(); }
}
function markTgUsed(phone) {
  const s = loadTgUsed(); s.add(String(phone));
  try { fs.writeFileSync(TG_USED_FILE, JSON.stringify([...s], null, 2), 'utf8'); } catch {}
}
function unmarkTgUsed(phone) {
  const s = loadTgUsed(); if (!s.delete(String(phone))) return false;
  try { fs.writeFileSync(TG_USED_FILE, JSON.stringify([...s], null, 2), 'utf8'); } catch {}
  return true;
}
// Берём любой ТГ из пула, не banned и ещё не использованный Conduit.
function pickTg() {
  const used = loadTgUsed();
  return tgPool.list().find(e => e.status !== 'banned' && !used.has(String(e.phone))) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// Подписка на канал (для бонуса). Идемпотентно — "уже подписан" глотаем.
async function joinChannel(client) {
  try {
    await client.invoke(new Api.channels.JoinChannel({ channel: CHANNEL }));
    log(`  подписался на @${CHANNEL}`);
  } catch (e) {
    log(`  join @${CHANNEL}: ${e.message} (ок если уже подписан)`);
  }
}

const BAN_RE = /AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|deactivated|USER_BANNED|FROZEN/i;

// Одна попытка привязки конкретным ТГ. Бросает при бане ТГ (ловится снаружи).
// Возвращает { ok, refLink, dir } | { ok:false, error } для НЕ-бан-ошибок.
async function tryBind(index, ref, entry) {
  const cookies = [];                         // свежий jar
  const start = await api.authStart(cookies, ref);
  if (!start.ok || !start.token) return { ok: false, error: 'authStart: нет link/token' };

  let tg = null;
  try {
    tg = (await tgClient.createClient(entry, { logger: () => {} })).client;
    await joinChannel(tg);
    await tgClient.sendStartWithToken(tg, BOT, start.token, { timeoutMs: 15000 });
    log(`#${index} /start ${start.token.slice(0, 8)}… → @${BOT}`);

    // Поллим, пока сессия не подтвердится. На expired — перезапуск (до 2 раз).
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let okAuth = false, regen = 0;
    while (Date.now() < deadline) {
      await sleep(2000);
      const { status } = await api.authPoll(cookies);
      if (status === 'ok') { okAuth = true; break; }
      if (status === 'expired') {
        if (++regen > 2) break;
        const re = await api.authStart(cookies, ref);
        if (re.token) { await tgClient.sendStartWithToken(tg, BOT, re.token, { timeoutMs: 15000 }); log(`#${index} link протух → новый`); }
      }
    }
    await tgClient.disconnect(tg); tg = null;
    if (!okAuth) return { ok: false, error: 'poll timeout' };

    const me = await api.getMe(_writeSession(cookies, index, entry.phone));
    if (!me.ok && BAN_RE.test(me.error || '')) throw new Error(me.error);  // мёртвый ТГ виден на getMe
    const s = me.ok ? api.summarize(me.me) : {};
    const dir = _accountDir(index, entry.phone, s.username);
    fs.renameSync(_tmpDir(index, entry.phone), dir);
    _writeInfo(dir, index, entry.phone, s);
    markTgUsed(entry.phone);   // использован ИМЕННО Conduit (общий status не трогаем)
    log(`#${index} ✅ ${s.username || '?'} | $${s.balance ?? '?'} ${s.plan || ''} | key …${(s.apiKey || '').slice(-4)}`);
    return { ok: true, refLink: s.refLink, dir };
  } catch (e) {
    if (tg) await tgClient.disconnect(tg).catch(() => {});
    try { fs.rmSync(_tmpDir(index, entry.phone), { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// Один аккаунт с авто-перебором ТГ: забанен → markBanned, берём следующий, повторяем.
async function registerOne(index, ref) {
  let lastErr = 'нет доступного ТГ';
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = pickTg();
    if (!entry) return { ok: false, error: lastErr };
    log(`#${index} ТГ +${entry.phone} (попытка ${attempt + 1})`);
    try {
      const r = await tryBind(index, ref, entry);
      if (r.ok) return r;
      lastErr = r.error;
      // НЕ-бан-ошибка (timeout и т.п.): метим ТГ использованным Conduit, чтобы не
      // зациклиться на нём, и берём следующий.
      markTgUsed(entry.phone);
      log(`#${index} ⚠ ${r.error} → следующий ТГ`);
    } catch (e) {
      lastErr = e.message;
      if (BAN_RE.test(e.message || '')) {
        tgPool.markBanned(entry.phone, e.message);
        log(`#${index} ТГ +${entry.phone} забанен (мёртв везде) → следующий`);
      } else {
        markTgUsed(entry.phone);
        log(`#${index} ⚠ ${e.message} → следующий ТГ`);
      }
    }
  }
  return { ok: false, error: `исчерпаны попытки: ${lastErr}` };
}

// Пишем session.json во временную папку, возвращаем путь к файлу (для getMe).
function _tmpDir(index, phone) { return path.join(ACCOUNTS_DIR, `_tmp_${index}_${phone}`); }
function _writeSession(cookies, index, phone) {
  const d = _tmpDir(index, phone);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'session.json');
  api.saveCookies(f, cookies);
  return f;
}
function _accountDir(index, phone, username) {
  const ident = (username || phone).replace(/[^A-Za-z0-9_-]/g, '_').replace(/^@/, '');
  return path.join(ACCOUNTS_DIR, `${index}_${ts()}_ok_${ident}`);
}
function _writeInfo(dir, index, phone, s) {
  const lines = [
    `Ident: conduit#${index}`,
    `Saved: ${new Date().toISOString()}`,
    `Username: ${s.username || '(?)'}`,
    `Plan: ${s.plan || '(?)'}`,
    `Balance: ${s.balance != null ? '$' + s.balance : '(?)'}`,
    `API Key: ${s.apiKey || '(?)'}`,
    `Base URL: ${s.baseUrl || api.API_BASE}`,
    `Referral: ${s.refLink || '(?)'}`,
    `TG Phone: ${phone}`,
  ];
  fs.writeFileSync(path.join(dir, 'account_info.txt'), lines.join('\n') + '\n', 'utf8');
}

function conduitAvail() {
  const used = loadTgUsed();
  return tgPool.list().filter(e => e.status !== 'banned' && !used.has(String(e.phone))).length;
}

function refOf(refLink) {
  const m = String(refLink || '').match(/start=(ref_[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Реги ПАРАМИ, пары между собой НЕ связаны (защита от бана всей цепочки):
//   пара = [чистый аккаунт без рефа] → [аккаунт по рефу первого].
//   Следующая пара начинается заново с чистого. Так бан одной пары не тянет остальные.
// Нечётный аккаунт в паре (#1,#3,#5…) — чистый; чётный (#2,#4,#6…) — по рефу напарника.
async function main() {
  const count = Math.max(1, parseInt(process.argv[2], 10) || 1);
  // CLI-реф (опц.) применяется ТОЛЬКО к первому чистому аккаунту первой пары.
  let firstPairSeedRef = (process.argv[3] && /^ref_[A-Za-z0-9]+$/.test(process.argv[3])) ? process.argv[3] : null;
  log(`Conduit autoreg: ${count} аккаунт(ов), пары 2+2${firstPairSeedRef ? ', seed-реф ' + firstPairSeedRef : ''} | доступно ТГ: ${conduitAvail()}`);

  let ok = 0, pairRef = null;
  for (let i = 1; i <= count; i++) {
    const firstInPair = (i % 2 === 1);                 // #1,#3,#5 — первый в паре (чистый)
    let ref;
    if (firstInPair) {
      ref = (i === 1 && firstPairSeedRef) ? firstPairSeedRef : null;  // чистый (или seed на самом первом)
      log(`#${i} ▸ новая пара, чистый аккаунт (ref ${ref || '—'})`);
    } else {
      ref = pairRef;                                   // второй в паре — по рефу напарника
      log(`#${i} ▸ напарник по рефу ${ref || '—'}`);
    }

    const r = await registerOne(i, ref);
    if (r.ok) {
      ok++;
      if (firstInPair) pairRef = refOf(r.refLink);     // запомнить реф для напарника
    } else {
      log(`#${i} ❌ ${r.error}`);
      if (firstInPair) pairRef = null;                 // пара сломалась на первом — напарник тоже чистый
    }
    if (i < count) await sleep(5000);
  }
  log(`Готово: ${ok}/${count}. Пул: ${JSON.stringify(tgPool.stats())}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { registerOne, refOf, pickTg, loadTgUsed, markTgUsed, unmarkTgUsed, conduitAvail, TG_USED_FILE };
