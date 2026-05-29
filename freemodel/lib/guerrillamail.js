// freemodel/lib/guerrillamail.js
//
// Клиент к публичному JSON API guerrillamail.com.
// Доки: https://www.guerrillamail.com/GuerrillaMailAPI.html
//
// Особенности:
//   - При первом вызове get_email_address сервер возвращает SID_TOKEN (sid_token),
//     его надо передавать во все последующие запросы.
//   - check_email возвращает только НОВЫЕ письма (после seq). fetch_email достаёт тело.
//   - Cookie session_id тоже сохраняется — но проще передавать sid_token явно.
//   - Можно сменить hostname (set_email_user) если нужно нестандартный домен.

const https = require('https');
const { URL } = require('url');

const BASE = 'https://api.guerrillamail.com/ajax.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.get({
            hostname: u.hostname,
            path: u.pathname + u.search,
            headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Невалидный JSON от guerrillamail: ${data.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(new Error('guerrillamail timeout')); });
    });
}

function qs(obj) {
    return Object.entries(obj)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

class GuerrillaInbox {
    constructor() {
        this.sidToken = null;
        this.emailAddr = null;
        this.lastSeq = 0;
    }

    // Все guerrilla-домены ведут в один и тот же inbox (по sid_token).
    // Freemodel блокирует @guerrillamailblock.com, но принимает @guerrillamail.com —
    // поэтому форсим публичный домен.
    static FORCE_DOMAIN = 'guerrillamail.com';

    _normalize(addr) {
        if (!addr) return addr;
        const local = addr.split('@')[0];
        return `${local}@${GuerrillaInbox.FORCE_DOMAIN}`;
    }

    async create() {
        const r = await httpGet(`${BASE}?${qs({ f: 'get_email_address', ip: '127.0.0.1', agent: UA, lang: 'en' })}`);
        if (!r.email_addr) throw new Error(`get_email_address: ${JSON.stringify(r)}`);
        this.sidToken = r.sid_token;
        this.emailAddr = this._normalize(r.email_addr);
        return this.emailAddr;
    }

    // Поменять локальную часть (до @) — иногда дефолтный адрес банится сервисом
    async setUser(localPart) {
        if (!this.sidToken) throw new Error('сначала create()');
        const r = await httpGet(`${BASE}?${qs({ f: 'set_email_user', email_user: localPart, lang: 'en', sid_token: this.sidToken })}`);
        if (!r.email_addr) throw new Error(`set_email_user: ${JSON.stringify(r)}`);
        this.emailAddr = this._normalize(r.email_addr);
        this.sidToken = r.sid_token || this.sidToken;
        return this.emailAddr;
    }

    async checkNew() {
        if (!this.sidToken) throw new Error('сначала create()');
        const r = await httpGet(`${BASE}?${qs({ f: 'check_email', seq: this.lastSeq, sid_token: this.sidToken })}`);
        if (Array.isArray(r.list)) {
            for (const m of r.list) {
                if (typeof m.mail_id !== 'undefined') this.lastSeq = Math.max(this.lastSeq, Number(m.mail_id) || 0);
            }
        }
        return r.list || [];
    }

    async fetchEmail(mailId) {
        if (!this.sidToken) throw new Error('сначала create()');
        const r = await httpGet(`${BASE}?${qs({ f: 'fetch_email', email_id: mailId, sid_token: this.sidToken })}`);
        return r;
    }

    // Удобный хелпер: ждать письмо от matcher (функция, получает на вход {from, subject, mail_id})
    // Возвращает полное тело письма (mail_body) или null.
    async waitForMessage(matcher, { pollMs = 5000, timeoutMs = 5 * 60 * 1000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const list = await this.checkNew();
                for (const m of list) {
                    const meta = { from: m.mail_from, subject: m.mail_subject, mail_id: m.mail_id };
                    if (matcher(meta)) {
                        const full = await this.fetchEmail(m.mail_id);
                        return full;
                    }
                }
            } catch (e) {
                console.log(`[guerrilla] ⚠️ ${e.message}`);
            }
            await new Promise(r => setTimeout(r, pollMs));
        }
        return null;
    }
}

module.exports = { GuerrillaInbox };

// CLI-режим для ручного теста: node freemodel/lib/guerrillamail.js
if (require.main === module) {
    (async () => {
        const inbox = new GuerrillaInbox();
        const addr = await inbox.create();
        console.log(`📧 ${addr}`);
        console.log(`SID: ${inbox.sidToken}`);
        console.log('Шлю запрос check_email каждые 5с. Ctrl+C для выхода.');
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const list = await inbox.checkNew().catch(e => { console.log('err', e.message); return []; });
            if (list.length) {
                for (const m of list) {
                    console.log(`📬 from=${m.mail_from} subj=${m.mail_subject} id=${m.mail_id}`);
                    const full = await inbox.fetchEmail(m.mail_id);
                    console.log('--- body ---');
                    console.log((full.mail_body || '').slice(0, 1500));
                    console.log('--- end ---');
                }
            } else {
                process.stdout.write('.');
            }
            await new Promise(r => setTimeout(r, 5000));
        }
    })().catch(e => { console.error(e); process.exit(1); });
}
