// freemodel/lib/mailtm.js
//
// Тонкий клиент к публичному REST API mail.tm (2026).
// Контракт API:
//   GET  /domains                    -> список доступных доменов
//   POST /accounts { address, password } -> создание ящика
//   POST /token    { address, password } -> JWT token
//   GET  /messages Authorization: Bearer -> список писем
//   GET  /messages/<id> Authorization: Bearer -> тело письма
//
// Node >= 18 (использует встроенный fetch).

const BASE = 'https://api.mail.tm';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function _headers(token) {
    const h = {
        'user-agent': UA,
        'accept': 'application/json',
        'content-type': 'application/json',
    };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
}

async function _get(path, token) {
    const res = await fetch(`${BASE}${path}`, { method: 'GET', headers: _headers(token) });
    if (!res.ok) throw new Error(`mail.tm GET ${path} -> ${res.status}`);
    return res.json();
}

async function _post(path, body) {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: _headers(), body: JSON.stringify(body) });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`mail.tm POST ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

async function getDomains() {
    const data = await _get('/domains');
    const domains = (data['hydra:member'] || []).filter(d => d.isActive).map(d => d.domain);
    if (!domains.length) throw new Error('mail.tm: нет активных доменов');
    return domains;
}

async function createEmail() {
    const domains = await getDomains();
    const domain = domains[Math.floor(Math.random() * domains.length)];
    const user = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    const address = `${user}@${domain}`;
    const password = Math.random().toString(36).slice(2, 14) + 'A1!';
    await _post('/accounts', { address, password });
    const tokenData = await _post('/token', { address, password });
    const token = tokenData.token;
    if (!token) throw new Error('mail.tm: не получен token');
    return { address, password, token };
}

async function fetchInbox(token) {
    const data = await _get('/messages', token);
    return Array.isArray(data['hydra:member']) ? data['hydra:member'] : [];
}

async function fetchMessage(token, id) {
    return _get(`/messages/${id}`, token);
}

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

async function waitForOtp(token, {
    fromHint = 'freemodel',
    timeoutMs = 60000,
    pollMs = 4000,
    log = () => {},
} = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;

    while (Date.now() < deadline) {
        let emails;
        try {
            emails = await fetchInbox(token);
        } catch (e) {
            log(`[mtm] inbox error: ${e.message}`);
            await _sleep(pollMs);
            continue;
        }

        if (emails.length !== lastCount) {
            log(`[mtm] inbox: ${emails.length} письм(а)`);
            lastCount = emails.length;
        }

        for (const em of emails) {
            if (!emailMatchesFrom(em, fromHint)) continue;
            let full = em;
            if (em.id && !em.text && !em.html) {
                try { full = await fetchMessage(token, em.id); } catch (e) { log(`[mtm] msg error: ${e.message}`); }
            }
            const text = emailToText(full);
            const code = extractOtp6(text);
            const link = extractMagicLink(text);
            if (code || link) {
                return { code, link, raw: full };
            }
        }

        await _sleep(pollMs);
    }
    return null;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
    createEmail,
    fetchInbox,
    waitForOtp,
    emailToText,
    extractOtp6,
    extractMagicLink,
    getDomains,
};
