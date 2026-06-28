// conduit/lib/conduit-manager.js
//
// Лёгкий менеджер аккаунтов Conduit. В отличие от freemodel-manager (Playwright
// на каждую квоту) — целиком на cookie-fetch (conduit-api.js, контракт проверен
// живьём). Параллелит дёшево.
//
// Аккаунт на диске: conduit/accounts/<dir>/
//   session.json      — storageState (cookies) для /api/me   [опционально: key-only акк без него]
//   account_info.txt  — Ident/Username/Plan/Balance/API Key/Base URL/Referral/TG Phone
//
// Имя папки: <idx>_<ts>_ok_<ident>  (как у freemodel v3) ИЛИ любое (рекордер/ручное).

const fs = require('fs');
const path = require('path');
const api = require('./conduit-api');

const ACCOUNTS_DIR = path.join(__dirname, '..', 'accounts');
const TRIAL_CREDIT = 500; // $500 пробного баланса = потолок энергошкалы

// ── account_info.txt → { ... } (формат "Key: value", регистр ключа не важен) ──
function readAccountInfo(itemPath) {
    const info = {};
    const f = path.join(itemPath, 'account_info.txt');
    if (!fs.existsSync(f)) return info;
    try {
        for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
            const c = line.indexOf(':');
            if (c < 0) continue;
            const k = line.slice(0, c).trim().toLowerCase();
            const v = line.slice(c + 1).trim();
            if (k === 'username') info.username = v;
            else if (k === 'ident') info.ident = v;
            else if (k === 'plan') info.plan = v;
            else if (k === 'balance') info.balance = v;
            else if (k === 'api key') info.apiKey = v.startsWith('(') ? '' : v;
            else if (k === 'base url') info.baseUrl = v;
            else if (k === 'referral') info.referral = v;
            else if (k === 'tg phone' || k === 'tgphone') info.tgPhone = v;
        }
    } catch {}
    return info;
}

function parseAccount(item, itemPath) {
    const sessionFile = path.join(itemPath, 'session.json');
    const hasSession = fs.existsSync(sessionFile);
    const info = readAccountInfo(itemPath);
    // key-only акк (без сессии) валиден, только если в info есть ключ.
    if (!hasSession && !info.apiKey) return null;

    const dtFull = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const okMark = /_ok_/.test(item) || hasSession || !!info.apiKey;

    return {
        name: item,
        path: itemPath,
        sessionFile: hasSession ? sessionFile : null,
        hasSession,
        username: info.username || info.ident || '—',
        apiKey: info.apiKey || null,
        tgPhone: info.tgPhone || null,
        refLink: info.referral && info.referral !== '(?)' ? info.referral : null,
        date: dtFull ? `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}` : '—',
        status: okMark ? '✅' : '❌',
    };
}

// Скан conduit/accounts/<dir>/. Сорт: новые сверху.
function getConduitAccounts() {
    const list = [];
    if (!fs.existsSync(ACCOUNTS_DIR)) {
        try { fs.mkdirSync(ACCOUNTS_DIR, { recursive: true }); } catch {}
        return list;
    }
    for (const item of fs.readdirSync(ACCOUNTS_DIR)) {
        if (item.startsWith('_tmp_') || item.startsWith('_error_') || item.startsWith('.')) continue;
        const p = path.join(ACCOUNTS_DIR, item);
        try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
        const s = parseAccount(item, p);
        if (s) list.push(s);
    }
    return list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.name.localeCompare(a.name));
}

// Квота/баланс одного аккаунта через /api/me. Key-only (нет сессии) → quota null.
// Возвращает null при сетевой ошибке (UI оставит кеш); { dead:true } если сессия
// протухла (401/403).
async function checkConduitQuota(account) {
    const sessionFile = account.sessionFile || (account.path && path.join(account.path, 'session.json'));
    if (!sessionFile || !fs.existsSync(sessionFile)) {
        return account.apiKey ? { keyOnly: true, apiKey: account.apiKey, baseUrl: api.API_BASE } : null;
    }
    const r = await api.getMe(sessionFile);
    if (!r.ok) {
        if (r.status === 401 || r.status === 403) return { dead: true };
        return null; // сеть — не трогаем кеш
    }
    const s = api.summarize(r.me);
    const spendable = s.balance != null ? s.balance : 0;
    // usedFraction для энергошкалы: сколько ИЗРАСХОДОВАНО от триал-кредита.
    // ULTIMATE (безлимит) → 0 (всегда «полный бак»).
    const usedFraction = s.subActive ? 0 : Math.max(0, Math.min(1, 1 - spendable / TRIAL_CREDIT));
    return {
        plan: s.plan,
        subActive: s.subActive,
        balance: s.balance,
        trialBalance: s.trialBalance,
        referralBalance: s.referralBalance,
        limits: s.limits,
        health: s.health,
        usedFraction,
        apiKey: s.apiKey || account.apiKey || null,
        refLink: s.refLink,
        referrals: s.referrals,
        username: s.username,
        admin: s.admin,
        baseUrl: s.baseUrl,
    };
}

// Полный ключ аккаунта: из /api/me (свежий) или из account_info.txt (key-only).
async function extractConduitApiKey(account) {
    const q = await checkConduitQuota(account);
    if (q && q.apiKey) return { ok: true, apiKey: q.apiKey };
    if (account.apiKey) return { ok: true, apiKey: account.apiKey };
    return { ok: false, error: q?.dead ? 'session dead' : 'no api key' };
}

module.exports = {
    ACCOUNTS_DIR, TRIAL_CREDIT,
    getConduitAccounts, checkConduitQuota, extractConduitApiKey, readAccountInfo,
};
