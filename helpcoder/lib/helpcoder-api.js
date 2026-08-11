// helpcoder/lib/helpcoder-api.js
//
// Cookie-клиент helpcoder.cc (New-API инстанс).
//
// Флоу авторега (чистый HTTP, без email/капчи):
//   POST /api/register  { username, password, password2 }  → ставит session cookie
//   POST /api/user/login { username, password }             → ставит session cookie
//   GET  /api/user/self  (Cookie: session + New-Api-User: <id>) → { id, quota, ... }
//   GET  /api/token/                                        → список токенов
//   POST /api/token/<id>/key                                → { data: { key: "sk-..." } }
//   GET  /v1/models (Bearer sk-...)                         → модели
//
// Баланс: quota (новый акк = 100 000 000) → USD = quota / 500000.
// Сессия = httpOnly cookie `session` + заголовок `New-Api-User: <id>` для /api/user/self.

const fs = require('fs');

const BASE = 'https://helpcoder.cc';
const API_BASE = BASE;                       // New-API инстанс, API и панель на одном хосте
const QUOTA_PER_UNIT = 500000;               // quota_per_unit из /api/status
const NEW_ACCOUNT_QUOTA = 100_000_000;       // бонус нового аккаунта

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
            return d === 'helpcoder.cc' || d.endsWith('.helpcoder.cc');
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
        else cookies.push({ name, value, domain: 'helpcoder.cc', path: '/' });
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

async function apiFetch(cookies, pathQuery, { method = 'GET', body = null, userId = null, timeoutMs = 20000, accept = 'application/json' } = {}) {
    const headers = {
        'cookie': cookieHeader(cookies),
        'accept': accept,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) helpcoder-autoreger',
        'referer': BASE + '/login',
    };
    if (body != null) headers['content-type'] = 'application/json';
    if (userId) headers['new-api-user'] = String(userId);
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

function isAuthError(r) {
    return r.status === 401 || r.status === 403;
}

function errorText(r) {
    if (!r) return 'no response';
    if (r.json?.message) return String(r.json.message);
    return r.text?.slice(0, 120) || `HTTP ${r.status}`;
}

// POST /api/user/register?turnstile= — turnstile_check=false → пустой токен
async function register(cookies, { username, password }) {
    const r = await apiFetch(cookies, '/api/user/register?turnstile=', {
        method: 'POST',
        body: { username, password, password2: password },
        timeoutMs: 30000,
    });
    if (r.status === 200 && r.ok) return { ok: true, status: r.status, raw: r.json };
    return { ok: false, status: r.status, error: errorText(r), raw: r.json };
}

// POST /api/user/login { username, password } → session cookie
async function login(cookies, { username, password }) {
    const r = await apiFetch(cookies, '/api/user/login', {
        method: 'POST',
        body: { username, password },
        timeoutMs: 30000,
    });
    if (r.status === 200 && r.ok) return { ok: true, status: r.status, raw: r.json };
    return { ok: false, status: r.status, error: errorText(r), raw: r.json };
}

// GET /api/user/self — только Cookie + New-Api-User
async function getSelf(cookies, userId) {
    const r = await apiFetch(cookies, '/api/user/self', { userId });
    if (isAuthError(r)) return { ok: false, status: r.status, error: 'unauthorized' };
    if (!r.ok || !r.json) return { ok: false, status: r.status, error: errorText(r) };
    const d = r.json.data || r.json;
    return { ok: true, me: d };
}

// GET /api/token/ → список токенов (data: { items: [...] })
async function listTokens(cookies, userId) {
    const r = await apiFetch(cookies, '/api/token/', { userId });
    if (isAuthError(r)) return { ok: false, status: r.status, error: 'unauthorized' };
    if (!r.ok || !r.json) return { ok: false, status: r.status, error: errorText(r) };
    const d = r.json.data || {};
    const items = Array.isArray(d) ? d : (d.items || []);
    return { ok: true, tokens: items, raw: r.json };
}

// POST /api/token/<id>/key → { data: { key: "sk-..." } }
async function getTokenKey(cookies, userId, tokenId) {
    const r = await apiFetch(cookies, `/api/token/${encodeURIComponent(tokenId)}/key`, {
        method: 'POST',
        userId,
        timeoutMs: 30000,
    });
    if (!r.ok || !r.json) return { ok: false, status: r.status, error: errorText(r) };
    const key = r.json.data?.key || null;
    return { ok: !!key, key, raw: r.json };
}

// GET /v1/models — Bearer sk-...
async function getModels(apiKey, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${BASE}/v1/models`, {
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'accept': 'application/json',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) helpcoder',
            },
        });
        let json = null, text = null;
        try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch {}
        return { status: res.status, ok: res.ok, json, text };
    } finally { clearTimeout(timeout); }
}

function quotaToUsd(quota) {
    if (quota == null) return null;
    return quota / QUOTA_PER_UNIT;
}

module.exports = {
    BASE, API_BASE, QUOTA_PER_UNIT, NEW_ACCOUNT_QUOTA,
    loadCookies, saveCookies, cookieHeader, mergeSetCookie,
    apiFetch, register, login, getSelf, listTokens, getTokenKey, getModels,
    quotaToUsd,
};
