// conduit/lib/conduit-api.js
//
// Cookie-авторизованный клиент conduit.ozdoev.net. Сессия (storageState от
// Playwright) хранит cookies — их достаточно для всех /api/* (creds=same-origin).
// Никакого браузера для чтения данных не нужно: чистый fetch.
//
// Контракт (реверс кабинета):
//   GET  /api/me                 → { user:{id,name,username,first_name}, apiKey,
//                                     plan, subscription:{active,expires},
//                                     entitlements:[{label}], balance(cents),
//                                     referralBalance, spendableBalance,
//                                     limits:{dailyRequests,requestsPerMinute,outputTokens},
//                                     health:{status}, refLink, referrals, admin }
//   GET  /api/me?usage=1&range=N → { series, models:[{name,calls}], total, tokens }
//   GET  /api/keys               → [{name,key,jti,createdAt}]  (key = sk-cdt-...)
//   POST /api/keys {name}        → { name, key, jti }
//   POST /api/auth?action=start  → { link: "t.me/<bot>?start=<token>" }   (+ set-cookie)
//   GET  /api/auth?action=poll   → { status: "ok"|"expired"|"pending" }   (+ set-cookie on ok)
//
// Все вызовы тащат cookies из storageState и обновляют его при set-cookie.

const fs = require('fs');

const BASE = 'https://conduit.ozdoev.net';
const API_BASE = `${BASE}/api/v1`;   // для Claude Code (Anthropic-совместимый эндпоинт)

// ── cookie-jar поверх storageState (Playwright формат) ──
function loadCookies(sessionFile) {
  try {
    const raw = fs.readFileSync(sessionFile, 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return Array.isArray(j.cookies) ? j.cookies : [];
  } catch { return []; }
}

function cookieHeader(cookies) {
  return cookies
    .filter(c => /(^|\.)conduit\.ozdoev\.net$/.test(c.domain.replace(/^\./, '')) || c.domain.includes('ozdoev'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// Слить Set-Cookie из ответа обратно в jar (для auth start/poll, которые ставят
// сессионную куку). Минимальный парсер: name=value; ...
function mergeSetCookie(cookies, setCookieList) {
  for (const sc of setCookieList || []) {
    const m = sc.match(/^([^=;]+)=([^;]*)/);
    if (!m) continue;
    const name = m[1].trim(), value = m[2];
    const existing = cookies.find(c => c.name === name);
    if (existing) existing.value = value;
    else cookies.push({ name, value, domain: 'conduit.ozdoev.net', path: '/' });
  }
  return cookies;
}

function saveCookies(sessionFile, cookies) {
  try {
    let j = { cookies: [], origins: [] };
    try {
      const raw = fs.readFileSync(sessionFile, 'utf8');
      j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch {}
    j.cookies = cookies;
    fs.writeFileSync(sessionFile, JSON.stringify(j, null, 2), 'utf8');
  } catch {}
}

// getSetCookie() есть в Node 18.14+/undici; fallback на raw header.
function extractSetCookie(res) {
  try { if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie(); } catch {}
  const h = res.headers.get('set-cookie');
  return h ? [h] : [];
}

async function apiFetch(cookies, pathQuery, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const headers = {
    'cookie': cookieHeader(cookies),
    'accept': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) conduit-autoreger',
  };
  if (body != null) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${pathQuery}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const setCookie = extractSetCookie(res);
  if (setCookie.length) mergeSetCookie(cookies, setCookie);
  let json = null, text = null;
  try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json, text, setCookie };
}

// ── High-level: данные кабинета ──
async function getMe(sessionFile) {
  const cookies = loadCookies(sessionFile);
  const r = await apiFetch(cookies, '/api/me');
  if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, error: 'unauthorized' };
  if (!r.ok || !r.json) return { ok: false, status: r.status, error: r.text?.slice(0, 120) || 'no json' };
  return { ok: true, status: r.status, me: r.json };
}

async function getUsage(sessionFile, range = 30) {
  const cookies = loadCookies(sessionFile);
  const r = await apiFetch(cookies, `/api/me?usage=1&range=${range}`);
  return r.ok && r.json ? { ok: true, usage: r.json } : { ok: false, status: r.status };
}

// Нормализованная сводка для UI/манагера.
function summarize(me) {
  if (!me) return null;
  const cents = (v) => (typeof v === 'number' ? v / 100 : null);
  const sub = me.subscription || {};
  const addons = (me.entitlements || []).map(a => a.label).filter(Boolean);
  return {
    userId: me.user?.id ?? null,
    username: me.user?.username ? '@' + me.user.username : null,
    name: me.user?.name || me.user?.first_name || null,
    plan: me.plan || (sub.active ? 'ULTIMATE' : 'FREE'),
    subActive: !!sub.active,
    subExpires: sub.expires || null,
    addons,
    apiKey: me.apiKey || null,
    balance: cents(me.spendableBalance) ?? cents(me.balance),
    trialBalance: cents(me.balance),
    referralBalance: cents(me.referralBalance),
    limits: me.limits || null,
    health: me.health?.status || null,
    refLink: me.refLink || null,
    referrals: me.referrals || 0,
    admin: !!me.admin,
    baseUrl: API_BASE,
  };
}

// ── Telegram device-code login (для автореги, без браузера) ──
// authStart мутирует переданный cookie-массив (ставит сессионную куку), его же
// надо передавать в authPoll и потом saveCookies.
async function authStart(cookies, ref) {
  const q = ref && /^ref_[A-Za-z0-9]+$/.test(ref) ? `?action=start&ref=${ref}` : '?action=start';
  const r = await apiFetch(cookies, `/api/auth${q}`, { method: 'POST' });
  const link = r.json?.link || null;
  const token = link && link.match(/start=([A-Za-z0-9_\-]+)/)?.[1] || null;
  return { ok: !!link, link, token, raw: r.json };
}
async function authPoll(cookies) {
  const r = await apiFetch(cookies, '/api/auth?action=poll');
  return { status: r.json?.status || 'pending', raw: r.json };
}

module.exports = {
  BASE, API_BASE,
  loadCookies, saveCookies, cookieHeader, mergeSetCookie,
  apiFetch, getMe, getUsage, summarize, authStart, authPoll,
};
