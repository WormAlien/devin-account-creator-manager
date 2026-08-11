// helpcoder/helpcoder_autoreg.js
//
// Автореги helpcoder.cc (New-API). Чистый HTTP, без email/капчи/подтверждения.
// На каждый аккаунт генерируется случайный username+password.
//
//   node helpcoder/helpcoder_autoreg.js [count]
//
// Результат: helpcoder/accounts/<idx>_<ts>_ok_<username>/
//   session.json      — cookies (storageState) + user id
//   account_info.txt  — Username/User ID/API Key/Balance $/Base URL

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const api = require('./lib/helpcoder-api');

const ACCOUNTS_DIR = path.join(__dirname, 'accounts');
const REG_RETRIES = 4;          // aff_code duplicate retry
const RATE_RETRIES = 3;         // 429 retry

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// 429 (rate-limit) — ждём и повторяем, с логом чтобы не выглядело «зависшим»
async function retryOnRate(label, fn, attempts = RATE_RETRIES, baseMs = 15000) {
    let last;
    for (let i = 0; i < attempts; i++) {
        last = await fn();
        if (!(last.status === 429)) return last;
        log(`  ⏳ ${label} 429 → ретрай ${i + 2}/${attempts} через ${baseMs * (i + 1) / 1000}с`);
        await sleep(baseMs * (i + 1));
    }
    return last;
}

function randomUsername() {
    const adj = ['swift','keen','calm','lucky','nova','mint','pine','iris','onix','echo'];
    const noun = ['fox','wolf','bird','hare','owl','koi','lynx','moth','apex','lake'];
    const a = adj[Math.floor(Math.random() * adj.length)];
    const n = noun[Math.floor(Math.random() * noun.length)];
    return `${a}${n}${crypto.randomBytes(3).toString('hex')}`;
}

function randomPassword() {
    return crypto.randomBytes(12).toString('base64url') + 'A1a';
}

const AFF_CODE_RE = /idx_users_aff_code|Duplicate entry/i;

async function registerOne(index) {
    const username = randomUsername();
    const password = randomPassword();
    const cookies = [];

    // Регистрация (aff_code может сколлизиться — ретраим)
    let reg = null;
    for (let attempt = 0; attempt < REG_RETRIES; attempt++) {
        reg = await retryOnRate('register', () => api.register(cookies, { username, password }));
        if (reg.ok) break;
        if (attempt < REG_RETRIES - 1 && AFF_CODE_RE.test(reg.error)) {
            log(`#${index} ⚠ ${username} aff_code duplicate → ретрай ${attempt + 2}/${REG_RETRIES}`);
            await sleep(1200);
            continue;
        }
        break;
    }
    if (!reg.ok) {
        return { ok: false, error: `register: ${reg.error}` };
    }

    // Логин — гарантирует валидную session cookie
    const lr = await retryOnRate('login', () => api.login(cookies, { username, password }));
    if (!lr.ok) {
        return { ok: false, error: `login: ${lr.error}` };
    }

    // self → id + quota
    const userId = (lr.raw?.data?.id) || (reg.raw?.data?.id) || null;
    const self = await api.getSelf(cookies, userId);
    const me = self.ok ? self.me : null;
    const id = userId || me?.id || null;
    const quota = me?.quota ?? null;
    if (!id) {
        return { ok: false, error: `no user id (self ${self.ok ? 'ok' : self.error})` };
    }

    // Токен: автогенерируется при регистрации ("初始令牌") → полный ключ
    let apiKey = null;
    try {
        const tokens = await api.listTokens(cookies, id);
        const tk = (tokens.tokens || [])[0];
        if (tk?.id) {
        const k = await retryOnRate('token key', () => api.getTokenKey(cookies, id, tk.id));
        if (k.ok) apiKey = k.key;
        }
    } catch {}
    if (!apiKey) {
        return { ok: false, error: 'token key not available' };
    }

    // Сохраняем
    const dir = _accountDir(index, username);
    fs.mkdirSync(dir, { recursive: true });
    api.saveCookies(path.join(dir, 'session.json'), cookies);
    _writeInfo(dir, index, username, password, id, apiKey, quota);

    const usd = api.quotaToUsd(quota);
    log(`#${index} ✅ ${username} | id=${id} | ключ …${apiKey.slice(-6)} | $${usd != null ? usd.toFixed(2) : '—'}`);
    return { ok: true, apiKey, username, dir };
}

function _accountDir(index, username) {
    return path.join(ACCOUNTS_DIR, `${index}_${ts()}_ok_${username}`);
}
function _writeInfo(dir, index, username, password, userId, apiKey, quota) {
    const usd = api.quotaToUsd(quota);
    const lines = [
        `Ident: helpcoder#${index}`,
        `Saved: ${new Date().toISOString()}`,
        `Username: ${username}`,
        `Password: ${password}`,
        `User ID: ${userId || '(?)'}`,
        `API Key: ${apiKey}`,
        `Balance: ${usd != null ? `$${usd.toFixed(2)}` : '(?)'}`,
        `Base URL: ${api.API_BASE}`,
    ];
    fs.writeFileSync(path.join(dir, 'account_info.txt'), lines.join('\n') + '\n', 'utf8');
}

async function main() {
    const count = Math.max(1, parseInt(process.argv[2], 10) || 1);
    log(`HELPCODER autoreg: ${count} аккаунт(ов) | ${api.BASE}`);
    let ok = 0;
    for (let i = 1; i <= count; i++) {
        const r = await registerOne(i);
        if (r.ok) ok++;
        else log(`#${i} ❌ ${r.error}`);
        if (i < count) await sleep(3000);
    }
    log(`Готово: ${ok}/${count}.`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { registerOne, randomUsername, randomPassword, ACCOUNTS_DIR };
