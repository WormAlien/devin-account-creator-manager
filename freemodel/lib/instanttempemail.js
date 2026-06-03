// freemodel/lib/instanttempemail.js
//
// Тонкий клиент к публичному REST API instanttempemail.com.
// Никакого браузера — обычный fetch, CORS открыт, авторизация не требуется.
// Контракт раскрыт через Playwright MCP 2026-06-01:
//
//   POST /api/create
//     → { address: "xxx@fpklm.com", expires: "...", token: "<uuid>" }
//
//   GET /api/inbox/{token}
//     → { address, expires, emails: [...] }
//
// Имена полей в emails[] пока не подтверждены живым письмом —
// парсер строит "haystack" из всех строковых полей и тянет 6 цифр оттуда.
// Это устойчиво к тому, что у них окажется {from, subject, body} vs {sender, text} vs т.п.
//
// Node >= 18 (использует встроенный fetch).
// Если запускать на 16 — добавь node-fetch и заверни в require.

const BASE = 'https://instanttempemail.com';

// Тот же UA что в config — чтобы антифрод meaning не дёргался от node/curl.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function _headers() {
    return {
        'user-agent': UA,
        'accept': 'application/json',
        'referer': `${BASE}/`,
        'origin': BASE,
    };
}

// Создать одноразовый email.
// Возвращает { address, token, expires }.
async function createEmail() {
    const res = await fetch(`${BASE}/api/create`, {
        method: 'POST',
        headers: _headers(),
    });
    if (!res.ok) {
        throw new Error(`instanttempemail /api/create вернул ${res.status}`);
    }
    const data = await res.json();
    if (!data || !data.address || !data.token) {
        throw new Error('instanttempemail /api/create: нет address/token в ответе');
    }
    return { address: data.address, token: data.token, expires: data.expires };
}

// Один поллинг inbox — список писем как пришёл от API.
async function fetchInbox(token) {
    const res = await fetch(`${BASE}/api/inbox/${encodeURIComponent(token)}`, {
        method: 'GET',
        headers: _headers(),
    });
    if (!res.ok) {
        throw new Error(`instanttempemail /api/inbox вернул ${res.status}`);
    }
    const data = await res.json();
    return Array.isArray(data?.emails) ? data.emails : [];
}

// Склеить ВСЕ строковые поля письма (на любой глубине) в один haystack —
// устойчиво к разной структуре API (from/subject/body, sender/text, etc.).
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

// Один email → плоский текст для regex.
function emailToText(email) {
    const parts = _flattenStrings(email);
    return _stripHtml(parts.join(' \n '));
}

// Содержит ли это письмо отправителя/тему/тело про fromHint? (lower-case substring)
function emailMatchesFrom(email, fromHint) {
    if (!fromHint) return true;
    return emailToText(email).toLowerCase().includes(fromHint.toLowerCase());
}

// Извлечь 6-значный OTP из текста. Фильтрует годы 200000..209999.
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

    // Берём тот, у которого рядом ключевые слова (code/verification/otp).
    const kw = /(?:code|verification|otp|verify|пин|код)/i;
    for (const c of candidates) {
        const idx = text.indexOf(c);
        if (idx < 0) continue;
        const window = text.substring(Math.max(0, idx - 80), idx + 86);
        if (kw.test(window)) return c;
    }
    return candidates[0];
}

// Извлечь magic-link (на случай если freemodel передумает и снова перейдёт на ссылки).
function extractMagicLink(text) {
    if (!text) return null;
    const re = /https?:\/\/(?:www\.)?freemodel\.dev\/[^\s"'<>]+/i;
    const m = text.match(re);
    return m ? m[0] : null;
}

// Главная функция — поллит inbox пока не появится письмо от fromHint и в нём 6-значный код.
// Возвращает { code, link, raw } или null по таймауту.
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
            log(`[ite] inbox error: ${e.message}`);
            await _sleep(pollMs);
            continue;
        }

        if (emails.length !== lastCount) {
            log(`[ite] inbox: ${emails.length} письм(а)`);
            lastCount = emails.length;
        }

        for (const em of emails) {
            if (!emailMatchesFrom(em, fromHint)) continue;
            const text = emailToText(em);
            const code = extractOtp6(text);
            const link = extractMagicLink(text);
            if (code || link) {
                return { code, link, raw: em };
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
};
