// svrtr/svrtr_autoreger.js
//
// Автореги svrtr.org через Telegram. Без браузера: чистый gramjs + cookie-fetch.
// Один ТГ из общего пула (freemodel/tg_pool.json) = один аккаунт svrtr.
//
//   node svrtr/svrtr_autoreger.js [count]

const fs = require('fs');
const path = require('path');
const { Api } = require('telegram');
const tgPool = require('../freemodel/lib/tg-pool');
const tgClient = require('../freemodel/lib/tg-client');
const api = require('./lib/svrtr-api');

const BOT = 'svrtrbot';
const ACCOUNTS_DIR = path.join(__dirname, 'accounts');
const TG_USED_FILE = path.join(__dirname, '.tg_used.json');
const POLL_TIMEOUT_MS = 90_000;
const TG_CONNECT_TIMEOUT = 30_000;

// gramjs при disconnect иногда выбрасывает TypeError из _recvLoop (внутренний баг).
process.on('uncaughtException', (err) => {
    if (/canSend is not a function|_recvLoop|connection was closed/i.test(err.message || '')) return;
    console.error('[uncaughtException]', err);
    process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ── ТГ-учёт (отдельный от FreeModel) ──
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
function pickTg() {
    const used = loadTgUsed();
    return tgPool.list().find(e => e.status !== 'banned' && !used.has(String(e.phone))) || null;
}
function svrtrAvail() {
    const used = loadTgUsed();
    return tgPool.list().filter(e => e.status !== 'banned' && !used.has(String(e.phone))).length;
}

const BAN_RE = /AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|deactivated|USER_BANNED|FROZEN/i;

async function tryBind(index, entry) {
    const cookies = [];
    const start = await api.authStart(cookies);
    if (!start.ok || !start.nonce || !start.token) {
        return { ok: false, error: `authStart: ${JSON.stringify(start.raw)}` };
    }

    let tg = null;
    try {
        // Подключаемся к ТГ с таймаутом (может зависнуть на connect/getMe)
        const createPromise = tgClient.createClient(entry, { logger: (m) => log(`  ${m}`) });
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TG connect timeout')), TG_CONNECT_TIMEOUT)
        );
        tg = (await Promise.race([createPromise, timeoutPromise])).client;

        await tgClient.sendStartWithToken(tg, BOT, start.token, {
            timeoutMs: 15000,
            logger: (m) => log(`  ${m}`)
        });
        log(`#${index} /start ${start.token.slice(0, 8)}… → @${BOT}`);

        // Поллим /auth/poll до 200 (ставит dash_session cookie)
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let done = false;
        while (Date.now() < deadline) {
            await sleep(2500);
            const p = await api.authPoll(cookies, start.nonce);
            if (p.done) { done = true; break; }
        }
        await tgClient.disconnect(tg); tg = null;
        if (!done) return { ok: false, error: 'poll timeout' };

        // Получаем имя пользователя
        let username = '(?)';
        try {
            const me = await api.getMe(cookies);
            if (me.ok && me.me?.name) username = me.me.name;
        } catch {}

        // Создаём API ключ через POST /api/keys
        const keyRes = await api.createApiKey(cookies, 'autoreg');
        if (!keyRes.ok || !keyRes.key) {
            return { ok: false, error: `createApiKey: ${JSON.stringify(keyRes.raw)}` };
        }
        const apiKey = keyRes.key;

        // Сохраняем
        const dir = _accountDir(index, entry.phone);
        fs.mkdirSync(dir, { recursive: true });
        // session.json — cookies для будущих запросов (/api/me, /api/balance)
        api.saveCookies(path.join(dir, 'session.json'), cookies);
        _writeInfo(dir, index, entry.phone, apiKey, username);
        markTgUsed(entry.phone);
        log(`#${index} ✅ ${username} | ключ …${apiKey.slice(-6)} | TG +${entry.phone}`);
        return { ok: true, apiKey, dir };
    } catch (e) {
        if (tg) await tgClient.disconnect(tg).catch(() => {});
        throw e;
    }
}

async function registerOne(index) {
    let lastErr = 'нет доступного ТГ';
    for (let attempt = 0; attempt < 8; attempt++) {
        const entry = pickTg();
        if (!entry) return { ok: false, error: lastErr };
        log(`#${index} ТГ +${entry.phone} (попытка ${attempt + 1})`);
        try {
            const r = await tryBind(index, entry);
            if (r.ok) return r;
            lastErr = r.error;
            markTgUsed(entry.phone);
            log(`#${index} ⚠ ${r.error} → следующий ТГ`);
        } catch (e) {
            lastErr = e.message;
            if (BAN_RE.test(e.message || '')) {
                tgPool.markBanned(entry.phone, e.message);
                log(`#${index} ТГ +${entry.phone} забанен → следующий`);
            } else {
                markTgUsed(entry.phone);
                log(`#${index} ⚠ ${e.message} → следующий ТГ`);
            }
        }
    }
    return { ok: false, error: `исчерпаны попытки: ${lastErr}` };
}

function _accountDir(index, phone) {
    return path.join(ACCOUNTS_DIR, `${index}_${ts()}_ok_${phone}`);
}
function _writeInfo(dir, index, phone, apiKey, username) {
    const lines = [
        `Ident: svrtr#${index}`,
        `Saved: ${new Date().toISOString()}`,
        `Username: ${username || '(?)'}`,
        `API Key: ${apiKey}`,
        `Base URL: ${api.API_BASE}`,
        `TG Phone: ${phone}`,
    ];
    fs.writeFileSync(path.join(dir, 'account_info.txt'), lines.join('\n') + '\n', 'utf8');
}

async function main() {
    const count = Math.max(1, parseInt(process.argv[2], 10) || 1);
    log(`SVRTR autoreg: ${count} аккаунт(ов) | доступно ТГ: ${svrtrAvail()}`);
    let ok = 0;
    for (let i = 1; i <= count; i++) {
        const r = await registerOne(i);
        if (r.ok) ok++;
        else log(`#${i} ❌ ${r.error}`);
        if (i < count) await sleep(4000);
    }
    log(`Готово: ${ok}/${count}.`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { registerOne, pickTg, loadTgUsed, markTgUsed, unmarkTgUsed, svrtrAvail, TG_USED_FILE };
