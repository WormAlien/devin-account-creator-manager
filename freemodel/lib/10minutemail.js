// freemodel/lib/10minutemail.js
//
// Клиент к 10minutemail.com (session/cookie API).
// Сайт защищён Cloudflare — чистый Node fetch/HTTPS отдаёт 403, а curl с теми же
// заголовками проходит. Поэтому весь HTTP делается через curl.exe.
//
// Рабочие endpoint'ы (из JS сайта):
//   GET /session/address       -> { address: "xxx@yyy.zz" }
//   GET /messages/messageCount -> { messageCount: N }
//   GET /messages/messagesAfter/{index} -> [ { id, sender, subject, bodyPlainText, bodyHtmlContent, ... } ]
//
// Зависимости: Node >= 18, curl.exe в PATH.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = 'https://10minutemail.com';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Временная cookie-табличка для сессии. Удаляется при dispose().
class CookieJar {
    constructor() {
        this.jarPath = path.join(os.tmpdir(), `10mm_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    }

    curlArgs() {
        return ['-c', this.jarPath, '-b', this.jarPath];
    }

    dispose() {
        try { fs.unlinkSync(this.jarPath); } catch {}
    }
}

function curlJson(url, cookieJar, opts = {}) {
    return new Promise((resolve, reject) => {
        const args = [
            '-A', UA,
            '-s', '-S',
            '--max-time', String(opts.timeout || 10),
            '-H', 'Accept: application/json, text/plain, */*',
            '-H', 'Referer: https://10minutemail.com/',
            ...cookieJar.curlArgs(),
            url,
        ];

        const proc = spawn('curl.exe', args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) {
                return reject(new Error(`curl ${url} exited ${code}: ${stderr.trim()}`));
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error(`curl ${url} non-JSON: ${stdout.slice(0, 200)} (stderr: ${stderr.trim()})`));
            }
        });
    });
}

async function curlJsonWithRetry(url, cookieJar, opts = {}) {
    const retries = opts.retries ?? 3;
    const baseDelay = opts.retryDelayMs ?? 2000;
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            return await curlJson(url, cookieJar, opts);
        } catch (e) {
            lastErr = e;
            const msg = e.message || '';
            if (msg.includes('403') || msg.includes('Forbidden') || msg.includes('non-JSON')) {
                await _sleep(baseDelay * (i + 1));
                continue;
            }
            throw e;
        }
    }
    throw lastErr;
}

// Создать сессию и получить адрес.
async function createEmail() {
    const jar = new CookieJar();
    const data = await curlJsonWithRetry(`${BASE}/session/address`, jar, { retries: 3, retryDelayMs: 3000 });
    if (!data || !data.address) throw new Error(`10minutemail: нет address в ответе: ${JSON.stringify(data).slice(0, 200)}`);
    return { address: data.address, token: jar, jar };
}

// Один поллинг inbox.
async function fetchInbox(jar) {
    const data = await curlJson(`${BASE}/messages/messageCount`, jar);
    return { count: data.messageCount || 0 };
}

// Получить сообщения, начиная с index.
async function fetchMessagesAfter(jar, index = 0) {
    return curlJson(`${BASE}/messages/messagesAfter/${index}`, jar);
}

// Склеить ВСЕ строковые поля письма в haystack.
function _flattenStrings(obj, acc = []) {
    if (obj == null) return acc;
    if (typeof obj === 'string') { acc.push(obj); return acc; }
    if (typeof obj === 'number' || typeof obj === 'boolean') return acc;
    if (Array.isArray(obj)) {
        for (const v of obj) _flattenStrings(v, acc);
        return acc;
    }
    if (typeof obj === 'object') {
        for (const v of Object.values(obj)) _flattenStrings(v, acc);
    }
    return acc;
}

function _stripHtml(s) {
    return String(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&').replace(/&#x?\w+;/g, ' ')
                    .replace(/\s+/g, ' ').trim();
}

function emailToText(email) {
    const parts = _flattenStrings(email);
    return _stripHtml(parts.join(' \n '));
}

function emailMatchesFrom(email, fromHint) {
    if (!fromHint) return true;
    return emailToText(email).toLowerCase().includes(fromHint.toLowerCase());
}

function extractOtp6(text) {
    if (!text) return null;
    const matches = text.match(/(?<!\d)\d{6}(?!\d)/g) || [];
    const candidates = [];
    for (const m of matches) {
        const n = parseInt(m, 10);
        if (n < 100000) continue;
        if (m.startsWith('20') && n >= 200000 && n <= 209999) continue;
        candidates.push(m);
    }
    if (!candidates.length) return null;
    const kw = /(?:code|verification|otp|verify|пин|код)/i;
    for (const c of candidates) {
        const idx = text.indexOf(c);
        if (idx < 0) continue;
        const window = text.substring(Math.max(0, idx - 80), idx + 86);
        if (kw.test(window)) return c;
    }
    return candidates[0];
}

function extractMagicLink(text) {
    if (!text) return null;
    const re = /https?:\/\/(?:www\.)?freemodel\.dev\/[^\s"'<>]+/i;
    const m = text.match(re);
    return m ? m[0] : null;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Главная функция — ждёт письмо от fromHint с 6-значным кодом.
async function waitForOtp(jar, {
    fromHint = 'freemodel',
    timeoutMs = 60000,
    pollMs = 4000,
    log = () => {},
} = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;

    while (Date.now() < deadline) {
        let count;
        try {
            const inbox = await fetchInbox(jar);
            count = inbox.count;
        } catch (e) {
            log(`[10mm] inbox error: ${e.message}`);
            await _sleep(pollMs);
            continue;
        }

        if (count !== lastCount) {
            log(`[10mm] inbox: ${count} письм(а)`);
            lastCount = count;
        }

        if (count > 0) {
            try {
                const emails = await fetchMessagesAfter(jar, 0);
                log(`[10mm] fetched ${emails.length} messages`);
                for (const em of (Array.isArray(emails) ? emails : [])) {
                    const text = emailToText(em);
                    const matchedFrom = emailMatchesFrom(em, fromHint);
                    const code = extractOtp6(text);
                    const link = extractMagicLink(text);
                    log(`[10mm] msg from=${matchedFrom} text=${text.slice(0, 80).replace(/\n/g, ' ')} code=${code || '-'} link=${link ? 'yes' : 'no'}`);
                    if (matchedFrom && (code || link)) {
                        return { code, link, raw: em };
                    }
                    // Fallback: если ни одно письмо не матчится по fromHint,
                    // но содержит 6-значный код — берём его (на случай другого sender/subject).
                    if (!matchedFrom && code) {
                        log(`[10mm] fallback: берём код из не-matching письма`);
                        return { code, link, raw: em };
                    }
                }
            } catch (e) {
                log(`[10mm] messages error: ${e.message}`);
            }
        }

        await _sleep(pollMs);
    }
    return null;
}

module.exports = {
    createEmail,
    fetchInbox,
    fetchMessagesAfter,
    waitForOtp,
    emailToText,
    extractOtp6,
    extractMagicLink,
};
