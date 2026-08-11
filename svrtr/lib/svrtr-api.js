// svrtr/lib/svrtr-api.js
//
// Cookie-клиент svrtr.org.
//
// Флоу авторега:
//   GET  /auth/start                → { nonce }  + set-cookie (сессия начинается)
//   /start <nonce> боту @svrtrbot
//   GET  /auth/poll?nonce=...       → 200 = аутентифицирован (ставит dash_session cookie)
//   POST /api/keys { name }         → { ok, key: "sk-sr-v1-..." }
//   GET  /api/me                    → { id, name, ... }
//   GET  /api/balance               → { balance, spent, deposits, address }

const fs = require('fs');

const BASE = 'https://svrtr.org';
const API_BASE = 'https://api.svrtr.org';
const BOT_USERNAME = 'svrtrbot';

// ── cookie-jar (Playwright storageState формат) ──
function loadCookies(sessionFile) {
    try {
        const raw = fs.readFileSync(sessionFile, 'utf8');
        const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(j.cookies) ? j.cookies : [];
    } catch { return []; }
}

function cookieHeader(cookies) {
    return cookies
        .filter(c => {
            const d = (c.domain || '').replace(/^\./, '');
            return d === 'svrtr.org' || d.endsWith('.svrtr.org');
        })
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
}

function mergeSetCookie(cookies, setCookieList) {
    for (const sc of setCookieList || []) {
        const m = sc.match(/^([^=;]+)=([^;]*)/);
        if (!m) continue;
        const name = m[1].trim(), value = m[2];
        const existing = cookies.find(c => c.name === name);
        if (existing) existing.value = value;
        else cookies.push({ name, value, domain: 'svrtr.org', path: '/' });
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

function extractSetCookie(res) {
    try { if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie(); } catch {}
    const h = res.headers.get('set-cookie');
    return h ? [h] : [];
}

async function apiFetch(cookies, pathQuery, { method = 'GET', body = null, timeoutMs = 20000, accept = 'application/json' } = {}) {
    const headers = {
        'cookie': cookieHeader(cookies),
        'accept': accept,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) svrtr-autoreger',
        'referer': BASE + '/login',
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

// GET /auth/start → { nonce }
async function authStart(cookies) {
    const r = await apiFetch(cookies, '/auth/start', { method: 'GET' });
    const nonce = r.json?.nonce || null;
    const token = nonce;
    const link = nonce ? `https://t.me/${BOT_USERNAME}?start=${nonce}` : null;
    return { ok: !!nonce, nonce, link, token, raw: r.json };
}

// GET /auth/poll?nonce=... → 200 = авторизован (ставит dash_session cookie)
async function authPoll(cookies, nonce) {
    const r = await apiFetch(cookies, `/auth/poll?nonce=${encodeURIComponent(nonce)}`, { timeoutMs: 8000 });
    return { done: r.status === 200, status: r.status, raw: r.json || r.text };
}

// GET /api/me → { id, name, photo, ... }
async function getMe(cookies) {
    const r = await apiFetch(cookies, '/api/me');
    if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, error: 'unauthorized' };
    if (!r.ok || !r.json) return { ok: false, status: r.status, error: r.text?.slice(0, 120) || 'no json' };
    return { ok: true, me: r.json };
}

// POST /api/keys { name } → { ok, key: "sk-sr-v1-..." }
async function createApiKey(cookies, name = 'autoreg') {
    const r = await apiFetch(cookies, '/api/keys', { method: 'POST', body: { name } });
    const key = r.json?.key || null;
    return { ok: !!key, key, id: r.json?.id || null, raw: r.json };
}

// GET /api/balance (с сессионными куками svrtr.org) → { balance, spent, ... }
async function getBalance(cookies) {
    const r = await apiFetch(cookies, '/api/balance');
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, balance: r.json };
}

module.exports = {
    BASE, API_BASE, BOT_USERNAME,
    loadCookies, saveCookies, cookieHeader, mergeSetCookie,
    apiFetch, authStart, authPoll, getMe, createApiKey, getBalance,
};
