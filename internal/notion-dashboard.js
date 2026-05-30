// internal/notion-dashboard.js
//
// Клиент для notion-abuz_ai дашборда.
// Логинится паролем (salt+SHA256), кэширует сессию,
// постит token_v2 в /admin/accounts/add и читает список аккаунтов
// чтобы избегать дубликатов при батч-импорте.

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'notion', '.dashboard-config.json');
const CACHE_FILE = path.join(__dirname, '..', 'notion', '.dashboard-cache.json');

function loadDashboardConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
        return null;
    }
}

function saveDashboardConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Кэш email'ов аккаунтов в дашборде. Используется чтобы при старте менеджера
// сразу показать "В дашборде / Не в дашборде" не дожидаясь ответа от сервера.
function loadDashboardCache() {
    try {
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        return {
            emails: Array.isArray(data.emails) ? data.emails : [],
            updatedAt: data.updated_at || null,
        };
    } catch {
        return { emails: [], updatedAt: null };
    }
}

function saveDashboardCache(emails) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
            emails,
            updated_at: new Date().toISOString(),
        }, null, 2));
    } catch {}
}

function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { return reject(e); }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + (u.search || ''),
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: 15000,
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body,
            }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function login(baseUrl, password) {
    // 1. Salt
    const saltResp = await request(`${baseUrl}/dashboard/auth/salt`);
    if (saltResp.status !== 200) {
        throw new Error(`Не удалось получить salt: HTTP ${saltResp.status}`);
    }
    let saltData;
    try { saltData = JSON.parse(saltResp.body); } catch {
        throw new Error('Дашборд вернул не-JSON на /dashboard/auth/salt');
    }
    const salt = saltData.salt;
    if (!salt) throw new Error('В ответе нет salt');

    // 2. Hash
    const hash = crypto.createHash('sha256').update(salt + password).digest('hex');

    // 3. Login
    const loginResp = await request(`${baseUrl}/dashboard/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
    });

    if (loginResp.status !== 200) {
        throw new Error(`Login failed: HTTP ${loginResp.status} — ${loginResp.body.slice(0, 200)}`);
    }

    const setCookie = loginResp.headers['set-cookie'];
    if (!setCookie || !setCookie.length) {
        throw new Error('Дашборд не вернул session cookie');
    }
    const cookie = setCookie.map(c => c.split(';')[0]).join('; ');
    return cookie;
}

async function listAccountEmails(baseUrl, cookie) {
    // Не передаём page/page_size — сервер вернёт полный список (backward-compat path).
    // С пагинацией max page_size = 500, что обрезало бы большие пулы.
    const resp = await request(`${baseUrl}/admin/accounts`, {
        headers: { 'Cookie': cookie, 'Accept': 'application/json' },
    });
    if (resp.status !== 200) {
        throw new Error(`Список аккаунтов: HTTP ${resp.status}`);
    }
    let data;
    try { data = JSON.parse(resp.body); } catch {
        throw new Error('Список аккаунтов вернулся не-JSON');
    }
    const accounts = data.accounts || data.items || data.data || [];
    return accounts
        .map(a => (a.email || a.user_email || a.UserEmail || '').toLowerCase())
        .filter(Boolean);
}

async function addAccount(baseUrl, cookie, tokenV2) {
    const resp = await request(`${baseUrl}/admin/accounts/add`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Cookie': cookie,
        },
        body: JSON.stringify({ token_v2: tokenV2 }),
    });
    let data = {};
    try { data = JSON.parse(resp.body); } catch {}
    if (resp.status !== 200) {
        return { ok: false, error: data.error || `HTTP ${resp.status}` };
    }
    return { ok: true, account: data.account || {}, filename: data.filename };
}

module.exports = {
    loadDashboardConfig,
    saveDashboardConfig,
    loadDashboardCache,
    saveDashboardCache,
    login,
    listAccountEmails,
    addAccount,
};
