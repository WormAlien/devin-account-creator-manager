// svrtr/lib/svrtr-manager.js
//
// Менеджер аккаунтов svrtr.org. По образцу conduit-manager.js.
// Аккаунт: svrtr/accounts/<dir>/
//   session.json      — cookies (storageState)
//   account_info.txt  — Ident/Username/API Key/Balance/TG Phone

const fs = require('fs');
const path = require('path');
const api = require('./svrtr-api');

const ACCOUNTS_DIR = path.join(__dirname, '..', 'accounts');

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
            else if (k === 'api key') info.apiKey = v.startsWith('(') ? '' : v;
            else if (k === 'balance') info.balance = v;
            else if (k === 'tg phone' || k === 'tgphone') info.tgPhone = v;
        }
    } catch {}
    return info;
}

function parseAccount(item, itemPath) {
    const sessionFile = path.join(itemPath, 'session.json');
    const hasSession = fs.existsSync(sessionFile);
    const info = readAccountInfo(itemPath);
    if (!hasSession && !info.apiKey) return null;

    const dtFull = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const okMark = /_ok_/.test(item) || hasSession || !!info.apiKey;

    return {
        name: item,
        path: itemPath,
        sessionFile: hasSession ? sessionFile : null,
        hasSession,
        username: info.username || '—',
        apiKey: info.apiKey || null,
        tgPhone: info.tgPhone || null,
        balance: info.balance || null,
        date: dtFull ? `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}` : '—',
        status: okMark ? '✅' : '❌',
    };
}

function getSvrtrAccounts() {
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

// Квота через /api/balance + /api/me (cookie-fetch, без браузера)
async function checkSvrtrQuota(account) {
    const sessionFile = account.sessionFile || (account.path && path.join(account.path, 'session.json'));
    if (!sessionFile || !fs.existsSync(sessionFile)) {
        // key-only — нечего проверять без куки (api.svrtr.org/api/balance = overloaded)
        return account.apiKey ? { keyOnly: true, apiKey: account.apiKey } : null;
    }
    const cookies = api.loadCookies(sessionFile);
    // Проверяем сессию
    const me = await api.getMe(cookies);
    if (!me.ok) {
        if (me.status === 401 || me.status === 403) return { dead: true };
        return null;
    }
    // Баланс
    const bal = await api.getBalance(cookies);
    const balance = bal.ok ? (bal.balance?.balance ?? null) : null;
    const spent = bal.ok ? (bal.balance?.spent ?? null) : null;
    return {
        username: me.me?.name || null,
        userId: me.me?.id || null,
        balance,
        spent,
        apiKey: account.apiKey,
    };
}

async function extractSvrtrApiKey(account) {
    if (account.apiKey) return { ok: true, apiKey: account.apiKey };
    return { ok: false, error: 'no api key' };
}

module.exports = {
    ACCOUNTS_DIR,
    getSvrtrAccounts, checkSvrtrQuota, extractSvrtrApiKey, readAccountInfo,
};
