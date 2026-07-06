// freemodel/lib/mail-provider.js
//
// Единый интерфейс для двух почтовых backend'ов:
//   1) tmailor.com через Camoufox (стелс, но иногда ловит Cloudflare
//      captcha → {"msg":"errorcaptcha","client-block":1});
//   2) instanttempemail.com — чистый HTTP, без браузера.
//
// Логика: пытаемся tmailor; если .create() падает с captcha/CF-подобной
// ошибкой ИЛИ tmailor вообще не стартовал — переключаемся на ITE и
// больше не возвращаемся к tmailor в рамках этого аккаунта.
//
// API совпадает с CamoufoxTmailor чтобы вызывающий код (v3) не менялся:
//   const mail = new MailProvider({ headless, log });
//   await mail.start();
//   const { email, accesstoken } = await mail.create();
//   const { email, accesstoken } = await mail.regenerate();
//   const { code, link } = await mail.waitOtp({ timeout, poll, fromHint });
//   await mail.stop();

const { CamoufoxTmailor } = require("./camoufox-tmailor-client");
const ite = require("./instanttempemail");

const CAPTCHA_MARKERS = [
    "errorcaptcha",
    "client-block",
    "\"captcha\":1",
    "captcha\":1",
    "cloudflare",
    "turnstile",
    "cf-chl",
];

function looksLikeCaptcha(err) {
    if (!err) return false;
    const msg = String(err.message || err).toLowerCase();
    return CAPTCHA_MARKERS.some((m) => msg.includes(m));
}

class MailProvider {
    constructor(opts = {}) {
        this.headless = opts.headless !== false;
        this.log = opts.log || (() => {});
        this.python = opts.python || "python";
        this.tmailor = null;
        this.backend = null; // 'tmailor' | 'ite'
        this.iteToken = null;
        this.iteAddress = null;
    }

    async start() {
        // Пытаемся поднять Camoufox; если не стартует — сразу ITE.
        try {
            this.tmailor = new CamoufoxTmailor({
                headless: this.headless,
                log: this.log,
                python: this.python,
            });
            await this.tmailor.start();
            this.backend = "tmailor";
        } catch (e) {
            this.log(`[mail] tmailor не стартовал (${e.message}), fallback на instanttempemail`);
            this.tmailor = null;
            this.backend = "ite";
        }
    }

    async _fallbackToIte(reason) {
        if (this.backend === "ite") return;
        this.log(`[mail] ⚠️ переключаю на instanttempemail: ${reason}`);
        this.backend = "ite";
        // Camoufox больше не нужен — гасим, чтобы не жрал ресурсы.
        if (this.tmailor) {
            try { await this.tmailor.stop(); } catch {}
            this.tmailor = null;
        }
    }

    async _iteCreate() {
        const mailbox = await ite.createEmail();
        this.iteAddress = mailbox.address;
        this.iteToken = mailbox.token;
        this.log(`[mail/ite] новый ящик: ${mailbox.address}`);
        // accesstoken имя оставляем для совместимости с существующим кодом.
        return { email: mailbox.address, accesstoken: mailbox.token };
    }

    async create() {
        if (this.backend === "tmailor" && this.tmailor) {
            try {
                return await this.tmailor.create();
            } catch (e) {
                if (looksLikeCaptcha(e)) {
                    await this._fallbackToIte(`tmailor create: ${e.message}`);
                } else {
                    throw e;
                }
            }
        }
        return this._iteCreate();
    }

    async regenerate() {
        if (this.backend === "tmailor" && this.tmailor) {
            try {
                return await this.tmailor.regenerate();
            } catch (e) {
                if (looksLikeCaptcha(e)) {
                    await this._fallbackToIte(`tmailor regenerate: ${e.message}`);
                } else {
                    throw e;
                }
            }
        }
        // ITE не умеет "переиспользовать" ящик — просто выдаём новый.
        return this._iteCreate();
    }

    async waitOtp(opts = {}) {
        if (this.backend === "tmailor" && this.tmailor) {
            return this.tmailor.waitOtp(opts);
        }
        if (!this.iteToken) {
            return { ok: false, error: "no email created yet" };
        }
        const timeoutMs = (opts.timeout || 120) * 1000;
        const pollMs = (opts.poll || 4) * 1000;
        const got = await ite.waitForOtp(this.iteToken, {
            fromHint: opts.fromHint || "freemodel",
            timeoutMs,
            pollMs,
            log: (m) => this.log(m),
        });
        if (!got) return { ok: false, error: "timeout" };
        return { ok: true, code: got.code, link: got.link, raw: got.raw };
    }

    async stop() {
        if (this.tmailor) {
            try { await this.tmailor.stop(); } catch {}
            this.tmailor = null;
        }
    }
}

module.exports = { MailProvider, looksLikeCaptcha };
