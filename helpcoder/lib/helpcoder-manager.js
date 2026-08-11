// helpcoder/lib/helpcoder-manager.js
//
// Менеджер аккаунтов helpcoder.cc. По образцу svrtr-manager.js.
// Аккаунт: helpcoder/accounts/<dir>/
//   session.json      — cookies (storageState)
//   account_info.txt  — Username/Password/User ID/API Key/Balance/Base URL

const fs = require('fs');
const path = require('path');
const api = require('./helpcoder-api');

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
            else if (k === 'user id' || k === 'userid') info.userId = v;
            else if (k === 'api key') info.apiKey = v.startsWith('(') ? '' : v;
            else if (k === 'balance') info.balance = v;
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
        userId: info.userId || null,
        balance: info.balance || null,
        date: dtFull ? `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}` : '—',
        status: okMark ? '✅' : '❌',
    };
}

function getHelpcoderAccounts() {
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

// Квота через /api/user/self (cookie-fetch). 401/403 = мёртвый аккаунт.
async function checkHelpcoderQuota(account) {
    const sessionFile = account.sessionFile || (account.path && path.join(account.path, 'session.json'));
    if (!sessionFile || !fs.existsSync(sessionFile)) {
        return account.apiKey ? { keyOnly: true, apiKey: account.apiKey } : null;
    }
    const cookies = api.loadCookies(sessionFile);
    const userId = account.userId || null;
    const self = await api.getSelf(cookies, userId);
    if (!self.ok) {
        if (self.status === 401 || self.status === 403) return { dead: true };
        return null;
    }
    const me = self.me || {};
    const quota = me.quota ?? null;
    const usd = api.quotaToUsd(quota);
    return {
        username: me.username || account.username || null,
        userId: me.id || account.userId || null,
        quota,
        balance: usd,
        apiKey: account.apiKey,
    };
}

async function extractHelpcoderApiKey(account) {
    if (account.apiKey) return { ok: true, apiKey: account.apiKey };
    return { ok: false, error: 'no api key' };
}

module.exports = {
    ACCOUNTS_DIR,
    getHelpcoderAccounts, checkHelpcoderQuota, extractHelpcoderApiKey, readAccountInfo,
};
