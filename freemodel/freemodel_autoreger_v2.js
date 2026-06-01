// freemodel/freemodel_autoreger_v2.js
//
// v2: использует emailnator.com (dotted Gmail) вместо GuerrillaInbox —
// guerrillamail перестал работать (freemodel банит / письмо не доходит).
//
// Поток:
//   1. Создаём dotted Gmail через emailnator.com (видимый Playwright)
//   2. Открываем https://freemodel.dev/invite/{CODE}, signup form
//   3. На email прилетает magic-link
//   4. Открываем link через emailnator inbox → достаём URL → переходим
//   5. В сессии freemodel → /dashboard
//   6. Сохраняем storageState + cookies в freemodel/accounts/<N>_<label>/
//   7. Идём в API Keys → Create → копируем fe_xxx
//   8. Берём свою реф-ссылку с /dashboard/refer
//   9. keys.txt: email|api_key|next_invite_code
//
// Использование:
//   node freemodel/freemodel_autoreger_v2.js           # default config.ACCOUNTS_COUNT
//   node freemodel/freemodel_autoreger_v2.js 3         # сколько аккаунтов

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// File used to persist the referral chain ACROSS runs.
// Without this, every dashboard "+ Add account" click restarts from
// config.INITIAL_INVITE, breaking the pyramid.
const LAST_INVITE_FILE = path.join(__dirname, '.last_invite');

function loadLastInvite() {
    try {
        if (fs.existsSync(LAST_INVITE_FILE)) {
            const v = fs.readFileSync(LAST_INVITE_FILE, 'utf8').trim();
            if (/^FRE-[A-Za-z0-9]+$/.test(v)) return v;
        }
    } catch {}
    return null;
}

function saveLastInvite(code) {
    if (!code || !/^FRE-/.test(code)) return;
    try { fs.writeFileSync(LAST_INVITE_FILE, code + '\n', 'utf8'); } catch {}
}

// ─── СЕЛЕКТОРЫ freemodel.dev ──────────────────────────────────
const SELECTORS = {
    emailInput:   'input[type="email"], input[name="email"], input[placeholder*="mail" i]',
    submitSignup: 'button:has-text("Sign up"), button:has-text("Continue"), button:has-text("Регистрация"), button[type="submit"]',
    apiKeysLink:  'a[href*="api-keys"], a[href*="keys"], text=API Keys',
    createKeyBtn: 'button:has-text("Create"), button:has-text("New key"), button:has-text("Создать")',
    refLinkHint:  'a[href*="/invite/"], input[value*="/invite/"], text=/FRE-[A-Za-z0-9]+/',
};

const EMAILNATOR_URL = 'https://www.emailnator.com/';
const EMAILNATOR_INBOX_URL = (email) => `https://www.emailnator.com/mailbox#${email}`;

// ─── УТИЛИТЫ ──────────────────────────────────────────────────
function ts() {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return msk.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
        const dir = path.dirname(config.LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(config.LOG_FILE, line + '\n');
    } catch {}
}

function parseProxy(s) {
    if (!s) return null;
    const m = s.match(/^https?:\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (!m) return null;
    const p = { server: `http://${m[3]}:${m[4]}` };
    if (m[1] && m[2]) { p.username = m[1]; p.password = m[2]; }
    return p;
}

function extractInviteCode(text) {
    if (!text) return null;
    const m = text.match(/FRE-[A-Za-z0-9]+/);
    return m ? m[0] : null;
}

function extractMagicLink(body) {
    if (!body) return null;
    // freemodel.dev любые ссылки на верификацию/вход
    const patterns = [
        /https?:\/\/(?:www\.)?freemodel\.dev\/[^\s"'<>]*(?:verify|confirm|magic|login|signin|callback|token)[^\s"'<>]*/i,
        /https?:\/\/(?:www\.)?freemodel\.dev\/[^\s"'<>]+/i,
    ];
    for (const re of patterns) {
        const m = body.match(re);
        if (m) return m[0].replace(/&amp;/g, '&').replace(/&#x?\w+;/g, '');
    }
    return null;
}

function stripHtml(s) {
    if (!s) return '';
    return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
}

// ─── EMAILNATOR ───────────────────────────────────────────────
//
// createEmailnatorEmail — копия из notion/notion_workflow.js, проверенная.
// .Gmail dotted режим — freemodel такие принимает (Notion тоже).
//
async function createEmailnatorEmail() {
    log('[почта] создаю email через emailnator.com...');

    let browser;
    try {
        log('[почта]   1/4: запуск Chromium (headless)...');
        browser = await chromium.launch({ headless: true });
    } catch (e) {
        log(`[почта] ❌ chromium.launch упал: ${e.message}`);
        throw e;
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        log('[почта]   2/4: открываю emailnator.com');
        await page.goto(EMAILNATOR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Consent popup
        try {
            await page.click('button:has-text("Consent")', { timeout: 5000 });
            log('[почта]   ✓ consent popup закрыт');
        } catch {
            log('[почта]   - consent popup не появился');
        }

        await page.waitForTimeout(2000);

        log('[почта]   3/4: настраиваю .Gmail (dotted) режим...');

        // Снимаем +Gmail и GoogleMail
        for (const lbl of ['+Gmail', 'GoogleMail']) {
            try {
                const cb = page.locator(`label:has-text("${lbl}") input[type="checkbox"], input[type="checkbox"][value*="${lbl.replace('+', '')}"]`).first();
                if (await cb.count() > 0 && await cb.isChecked().catch(() => false)) {
                    await cb.click({ timeout: 1000 });
                    log(`[почта]     ✗ снял "${lbl}"`);
                }
            } catch {}
        }

        // Включаем .Gmail
        try {
            const cb = page.locator(`label:has-text(".Gmail") input[type="checkbox"], input[type="checkbox"][value*="dotGmail" i]`).first();
            if (await cb.count() > 0 && !(await cb.isChecked().catch(() => true))) {
                await cb.click({ timeout: 2000 });
                log('[почта]     ✓ включил ".Gmail"');
            } else {
                log('[почта]     ✓ ".Gmail" уже включен');
            }
        } catch {
            try {
                await page.click('label:has-text(".Gmail")', { timeout: 2000 });
                log('[почта]     ✓ кликнул label ".Gmail"');
            } catch {
                log('[почта]     ⚠️ не нашёл чекбокс .Gmail');
            }
        }

        await page.waitForTimeout(1000);

        // Generate New — могут вернуть +alias, тогда перегенерируем
        let email = '';
        const MAX_GEN_ATTEMPTS = 7;
        for (let gen = 0; gen < MAX_GEN_ATTEMPTS; gen++) {
            if (gen > 0) {
                await page.goto(EMAILNATOR_URL, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
                await page.waitForTimeout(2000);

                try {
                    const cb = page.locator(`label:has-text(".Gmail") input[type="checkbox"], input[type="checkbox"][value*="dotGmail" i]`).first();
                    if (await cb.count() > 0 && !(await cb.isChecked().catch(() => true))) {
                        await cb.click({ timeout: 2000 });
                    }
                } catch {}

                for (const lbl of ['+Gmail', 'GoogleMail']) {
                    try {
                        const cb = page.locator(`label:has-text("${lbl}") input[type="checkbox"]`).first();
                        if (await cb.count() > 0 && await cb.isChecked().catch(() => false)) {
                            await cb.click({ timeout: 1000 });
                        }
                    } catch {}
                }
                await page.waitForTimeout(1000);
            }

            try {
                await page.click('button:has-text("Generate"), button:has-text("Go")', { timeout: 5000 });
                log(`[почта]     ✓ нажал Generate (${gen + 1}/${MAX_GEN_ATTEMPTS})`);
            } catch {
                log(`[почта]     ⚠️ не нашёл Generate (попытка ${gen + 1})`);
                continue;
            }
            await page.waitForTimeout(2500);

            const url = page.url();
            const m = url.match(/#([\w.+-]+@(?:gmail|googlemail)\.com)/i);
            if (m) {
                const got = m[1];
                log(`[почта]     URL email: ${got}`);
                if (got.includes('+')) {
                    log('[почта]     ⚠️ получили +alias, перегенерирую...');
                    continue;
                }
                email = got;
                break;
            }
        }

        if (!email) {
            const dumpPath = path.join(__dirname, `emailnator_debug_${Date.now()}.png`);
            await page.screenshot({ path: dumpPath, fullPage: true }).catch(() => {});
            log(`[почта] 📸 ${dumpPath}`);
            throw new Error('emailnator: не получили dotted Gmail');
        }

        if (/@googlemail\.com$/i.test(email)) {
            email = email.replace(/@googlemail\.com$/i, '@gmail.com');
        }

        log(`[почта]   4/4: ✅ email: ${email}`);
        await browser.close();
        return email;
    } catch (e) {
        await browser.close().catch(() => {});
        throw e;
    }
}

//
// waitForOtpCodeEmail — FreeModel сейчас шлёт 6-значный код, НЕ magic-link.
// (Подтверждено probe_signup.js — форма после submit: 6 × <input maxLength=1>
// + "Verify & continue" / "Resend code".)
//
// Извлекаем ровно 6 подряд идущих цифр из видимого текста письма.
//
async function waitForOtpCodeEmail(email, timeoutMs) {
    log(`[почта] жду OTP для ${email} (макс ${Math.round(timeoutMs/1000)}с)...`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const deadline = Date.now() + timeoutMs;
    const pollInterval = config.EMAIL_POLL_MS || 5000;
    const fromHint = (config.EMAIL_FROM_HINT || 'freemodel').toLowerCase();
    const subjectHints = config.EMAIL_SUBJECT_HINTS || ['verify', 'verification', 'sign in', 'login', 'confirm', 'magic', 'code'];

    // Поднять ВСЕ 6-значные коды из всех фреймов, выбрать самый похожий на OTP.
    // OTP обычно стоит отдельной строкой, окружён пробелами/новыми строками,
    // и НЕ выглядит как год (2024-2026 фильтруем) или часть длинного числа.
    async function harvestOtpCodes() {
        const codes = [];
        for (const frame of page.frames()) {
            try {
                const text = await frame.locator('body').innerText().catch(() => '');
                if (!text) continue;
                // 6 цифр окружённые non-digit (чтобы не выдрать кусок длинного числа)
                const matches = text.match(/(?<!\d)\d{6}(?!\d)/g) || [];
                for (const m of matches) {
                    const n = parseInt(m, 10);
                    // Отсекаем годы 2000-2099 и совсем мелкие числа
                    if (n < 100000) continue;
                    if (m.startsWith('20') && n >= 200000 && n <= 209999) {
                        // Очень похоже на год типа 202612 — пропускаем
                        continue;
                    }
                    codes.push({ code: m, frameUrl: frame.url(), context: text });
                }
            } catch {}
        }
        return codes;
    }

    // Ранжируем код по близости к ключевым словам (code/verification/OTP)
    function pickBestCode(codes) {
        if (!codes.length) return null;
        const kw = /(?:code|verification|otp|verify|пин|код)/i;
        for (const c of codes) {
            const idx = c.context.indexOf(c.code);
            if (idx < 0) continue;
            const window = c.context.substring(Math.max(0, idx - 80), idx + 86);
            if (kw.test(window)) return c.code;
        }
        return codes[0].code;  // fallback — первый разумный
    }

    try {
        while (Date.now() < deadline) {
            await page.goto(EMAILNATOR_INBOX_URL(email), { timeout: 30000, waitUntil: 'domcontentloaded' });
            try { await page.click('button:has-text("Consent")', { timeout: 2000 }); } catch {}
            await page.waitForTimeout(3000);

            // 0. Может inbox уже показывает превью с кодом
            let codes = await harvestOtpCodes();
            let pick = pickBestCode(codes);
            if (pick) {
                log(`[почта] 🔢 OTP (inbox preview): ${pick}`);
                await browser.close();
                return pick;
            }

            const inboxText = await page.locator('body').innerText().catch(() => '');
            const lowerInbox = inboxText.toLowerCase();
            const fromHit = lowerInbox.includes(fromHint);
            const subjectHit = subjectHints.some(h => lowerInbox.includes(h.toLowerCase()));

            if (fromHit || subjectHit) {
                log('[почта] ✉ письмо найдено в inbox, пробую открыть...');

                const clickStrategies = [
                    async () => page.click(`text=/freemodel/i`, { timeout: 2500 }),
                    async () => {
                        for (const hint of subjectHints) {
                            try { await page.click(`text=/${hint}/i`, { timeout: 1500 }); return; } catch {}
                        }
                        throw new Error('no subject match');
                    },
                    async () => page.click('tbody tr:first-of-type', { timeout: 2500 }),
                    async () => page.click('[role="row"]:not(:has(th))', { timeout: 2500 }),
                    async () => page.click('.list-group-item, .message-item, [class*="email"]', { timeout: 2500 }),
                ];

                let opened = false;
                for (let i = 0; i < clickStrategies.length; i++) {
                    try { await clickStrategies[i](); opened = true; log(`[почта]   ✓ открыл стратегией #${i + 1}`); break; } catch {}
                }
                if (!opened) log('[почта]   ⚠️ не открылось — пробую harvest без клика');

                await page.waitForTimeout(3000);

                codes = await harvestOtpCodes();
                pick = pickBestCode(codes);

                if (pick) {
                    log(`[почта] 🔢 OTP: ${pick}`);
                    await browser.close();
                    return pick;
                }

                const dumpPath = path.join(__dirname, `inbox_debug_${Date.now()}.png`);
                await page.screenshot({ path: dumpPath, fullPage: true }).catch(() => {});
                log(`[почта]   📸 OTP не найден — ${dumpPath}`);
                log(`[почта]   текст письма (первые 300 символов): ${(await page.locator('body').innerText().catch(() => '')).slice(0, 300)}`);
            }

            process.stdout.write('.');
            await page.waitForTimeout(pollInterval);
        }

        log(`\n[почта] ⏰ таймаут (${Math.round(timeoutMs/1000)}с) — OTP не пришёл`);
        await browser.close();
        return null;
    } catch (e) {
        await browser.close().catch(() => {});
        throw e;
    }
}

// ─── ЭКСПОРТ АККАУНТА ───────────────────────────────────────────
function exportAccount({ index, email, apiKey, inviteCode, sessionFile, cookies, success }) {
    if (!fs.existsSync(config.ACCOUNTS_DIR)) fs.mkdirSync(config.ACCOUNTS_DIR, { recursive: true });

    const label = success ? 'ok' : 'err';
    const ident = email.split('@')[0].replace(/[^\w-]/g, '_');
    const dir = path.join(config.ACCOUNTS_DIR, `${index}_${ts()}_${label}_${ident}`);
    fs.mkdirSync(dir, { recursive: true });

    if (sessionFile && fs.existsSync(sessionFile)) {
        fs.copyFileSync(sessionFile, path.join(dir, 'session.json'));
    }

    if (Array.isArray(cookies)) {
        const fmt = cookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain,
            hostOnly: !c.domain.startsWith('.'), path: c.path || '/',
            secure: !!c.secure, httpOnly: !!c.httpOnly,
            sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite || 'lax').toLowerCase(),
            session: c.expires === -1, expirationDate: c.expires === -1 ? undefined : c.expires,
            storeId: '0',
        }));
        fs.writeFileSync(path.join(dir, 'cookies.json'), JSON.stringify(fmt, null, 2));
    }

    fs.writeFileSync(path.join(dir, 'restore_session.js'), `const { chromium } = require('playwright');
const path = require('path');
(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: path.join(__dirname, 'session.json') });
    const page = await context.newPage();
    await page.goto('${config.DASHBOARD_URL}', { waitUntil: 'domcontentloaded' });
    console.log('✅ Сессия восстановлена. Закрой браузер вручную.');
})();
`);

    const info = `Index: ${index}
Email: ${email}
API Key: ${apiKey || '(не получен)'}
Invite Code (мой реф): ${inviteCode || '(не получен)'}
Status: ${success ? '✅ OK' : '❌ ERROR'}
Backend: emailnator (v2)
Created: ${new Date().toISOString()}
`;
    fs.writeFileSync(path.join(dir, 'account_info.txt'), info);

    log(`[экспорт] 📦 ${dir}`);
    return dir;
}

function appendKeysFile(email, apiKey, inviteCode) {
    const line = `${email}|${apiKey || ''}|${inviteCode || ''}\n`;
    fs.appendFileSync(config.KEYS_FILE, line);
}

// ─── ШАГИ ───────────────────────────────────────────────────────
async function fillSignupForm(page, email) {
    log(`[форма] ввожу email: ${email}`);

    let filled = false;
    for (const frame of page.frames()) {
        try {
            const loc = frame.locator(SELECTORS.emailInput).first();
            if (await loc.count() > 0) {
                await loc.click({ timeout: 5000 });
                await loc.fill('');
                await loc.pressSequentially(email, { delay: 80 });
                filled = true;
                break;
            }
        } catch {}
    }
    if (!filled) throw new Error('поле email не найдено');

    await page.waitForTimeout(500);

    let submitted = false;
    for (const frame of page.frames()) {
        try {
            const btn = frame.locator(SELECTORS.submitSignup).first();
            if (await btn.count() > 0 && await btn.isVisible()) {
                await btn.click({ timeout: 5000 });
                submitted = true;
                break;
            }
        } catch {}
    }
    if (!submitted) await page.keyboard.press('Enter');
}

//
// fillOtpAndContinue — на freemodel.dev signup-step после email:
//   - 6 single-char <input> (maxLength=1) подряд
//   - "Verify & continue" / "Resend code" кнопки
// Стратегия: попробуем заполнить 6 инпутов по одной цифре, затем Verify.
//
async function fillOtpAndContinue(page, code) {
    log(`[OTP] ввожу код ${code}`);

    // Все inputs с maxlength=1 или autocomplete="one-time-code"
    const inputs = page.locator('input[maxlength="1"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    const n = await inputs.count();

    if (n >= 6) {
        // 6 раздельных полей
        for (let i = 0; i < 6; i++) {
            await inputs.nth(i).fill(code[i]).catch(async () => {
                // некоторые сетки требуют focus + press
                await inputs.nth(i).focus();
                await page.keyboard.press(code[i]);
            });
            await page.waitForTimeout(80);
        }
    } else if (n === 1) {
        // Один большой input — ввожу целиком
        await inputs.first().fill(code);
    } else {
        // Fallback: фокусируем первый видимый input и печатаем
        const first = page.locator('input').first();
        await first.click();
        await page.keyboard.type(code, { delay: 80 });
    }

    await page.waitForTimeout(500);

    // Иногда форма авто-сабмитится после 6-й цифры — ждём редиректа сначала
    const before = page.url();
    try {
        await page.waitForURL(u => u !== before, { timeout: 4000 });
        log('[OTP] авто-сабмит сработал');
    } catch {
        // Кликаем Verify & continue вручную
        const verify = page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Confirm"), button[type="submit"]').first();
        if (await verify.count() > 0) {
            await verify.click({ timeout: 5000 }).catch(() => {});
            log('[OTP] нажал Verify');
        }
    }

    await page.waitForTimeout(4500);
    for (let i = 0; i < 6; i++) {
        const u = page.url();
        if (u.includes('/dashboard') || u.includes('/app') || u.includes('/account') || u.includes('/welcome')) break;
        await page.waitForTimeout(2000);
    }
    log(`[OTP] URL после verify: ${page.url()}`);
    return page;
}

async function createApiKey(page) {
    log('[ключ] перехожу к API Keys');
    const urls = [
        `${config.DASHBOARD_URL}/api-keys`,
        `${config.DASHBOARD_URL}/keys`,
        `${config.DASHBOARD_URL}/settings/api-keys`,
        config.DASHBOARD_URL,
    ];
    for (const u of urls) {
        try {
            await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
            const has = await page.locator(SELECTORS.createKeyBtn).first().count();
            if (has > 0) break;
        } catch {}
    }

    try {
        await page.locator(SELECTORS.createKeyBtn).first().click({ timeout: 8000 });
        await page.waitForTimeout(2500);
    } catch (e) {
        log(`[ключ] ⚠️ Create не нажалась: ${e.message}`);
    }

    try {
        const confirm = page.locator('button:has-text("Create"), button:has-text("Confirm"), button[type="submit"]').first();
        if (await confirm.count() > 0 && await confirm.isVisible()) {
            await confirm.click({ timeout: 4000 });
            await page.waitForTimeout(2500);
        }
    } catch {}

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const m = bodyText.match(/fe[_-][A-Za-z0-9_-]{20,}/);
    if (m) { log(`[ключ] 🔑 ${m[0]}`); return m[0]; }

    const inputs = await page.locator('input, textarea, code').all();
    for (const inp of inputs) {
        try {
            const v = (await inp.inputValue().catch(() => '')) || (await inp.innerText().catch(() => ''));
            const mm = v.match(/fe[_-][A-Za-z0-9_-]{20,}/);
            if (mm) { log(`[ключ] 🔑 ${mm[0]}`); return mm[0]; }
        } catch {}
    }

    log('[ключ] ❌ не найден в DOM');
    return null;
}

async function grabReferralCode(page) {
    log('[реф] ищу свою реф-ссылку');
    const urls = [
        `${config.DASHBOARD_URL}/refer`,
        `${config.DASHBOARD_URL}/invite`,
        `${config.DASHBOARD_URL}/referrals`,
        config.DASHBOARD_URL,
    ];
    for (const u of urls) {
        try {
            await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
            const text = await page.locator('body').innerText().catch(() => '');
            const code = extractInviteCode(text);
            if (code) { log(`[реф] 🔗 ${code}`); return code; }
            const hrefs = await page.locator('a[href*="/invite/"]').all();
            for (const a of hrefs) {
                const href = await a.getAttribute('href').catch(() => '');
                const c = extractInviteCode(href);
                if (c) { log(`[реф] 🔗 ${c}`); return c; }
            }
        } catch {}
    }
    log('[реф] ⚠️ реф-код не найден');
    return null;
}

// ─── ОДИН АККАУНТ ───────────────────────────────────────────────
async function registerOne(index, inviteCode) {
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`[#${index}] инвайт: ${inviteCode}`);

    const launchOpts = { headless: config.HEADLESS, args: ['--disable-blink-features=AutomationControlled'] };
    const proxy = parseProxy(config.PROXY);
    if (proxy) launchOpts.proxy = proxy;

    let apiKey = null, refCode = null, success = false, cookies = [];
    let browser, context, page;
    let email = null;
    let sessionFile = path.join(config.ACCOUNTS_DIR, `_tmp_session_${index}.json`);

    try {
        // ── Email creation with retries (как у Notion) ──
        const MAX_EMAIL_RETRIES = 5;
        let otpCode = null;

        for (let attempt = 0; attempt < MAX_EMAIL_RETRIES; attempt++) {
            email = await createEmailnatorEmail();
            log(`[#${index}] email (попытка ${attempt + 1}): ${email}`);

            // Один браузер на все попытки — context shared, page закрываем между ретраями.
            if (!browser) {
                browser = await chromium.launch(launchOpts);
                context = await browser.newContext({
                    viewport: config.VIEWPORT,
                    userAgent: config.USER_AGENT,
                    locale: config.LOCALE,
                });
                await context.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                });
            }

            page = await context.newPage();
            const signupUrl = config.SIGNUP_URL_TPL.replace('{CODE}', inviteCode);
            log(`[#${index}] открываю ${signupUrl}`);
            await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2500);

            await fillSignupForm(page, email);
            await page.waitForTimeout(2500);

            // Проверка на bann/reject
            const bodyText = await page.locator('body').innerText().catch(() => '');
            const lower = bodyText.toLowerCase();
            const banPatterns = [
                'banned', 'suspended', 'blocked', 'not allowed',
                'cannot create', 'cannot sign up', 'invalid email',
                'something went wrong', 'try again',
            ];
            const banHit = banPatterns.find(p => lower.includes(p));
            if (banHit) {
                log(`[#${index}] ❌ email отклонён (${banHit}), беру новую почту`);
                await page.close().catch(() => {});
                page = null;
                continue;
            }

            // Жду OTP 60 сек
            otpCode = await waitForOtpCodeEmail(email, 60000);
            if (otpCode) break;

            log(`[#${index}] ⚠️ OTP не пришёл за 60с, новый email (${attempt + 2}/${MAX_EMAIL_RETRIES})`);
            await page.close().catch(() => {});
            page = null;
        }

        if (!otpCode) {
            throw new Error(`OTP не получен после ${MAX_EMAIL_RETRIES} попыток`);
        }

        // ── Ввод OTP в ту же открытую страницу с 6 input-полями ──
        const dashPage = await fillOtpAndContinue(page, otpCode);

        const url = dashPage.url();
        if (!/\/(dashboard|app|account|welcome)/.test(url)) {
            log(`[#${index}] ⚠️ после verify URL: ${url}`);
        }

        // ── Сохраняем сессию ДО создания ключа ──
        await context.storageState({ path: sessionFile });
        cookies = (await context.cookies()).filter(c => c.domain.includes('freemodel'));

        apiKey = await createApiKey(dashPage);
        refCode = await grabReferralCode(dashPage);

        // Финальный snapshot
        await context.storageState({ path: sessionFile });
        success = !!apiKey;
    } catch (e) {
        log(`[#${index}] ❌ ${e.message}`);
        try {
            const shot = path.join(config.ACCOUNTS_DIR, `_error_${index}_${ts()}.png`);
            if (page) { await page.screenshot({ path: shot }); log(`[#${index}] 📸 ${shot}`); }
        } catch {}
        try { if (context) await context.storageState({ path: sessionFile }); } catch {}
        try { if (context) cookies = (await context.cookies()).filter(c => c.domain.includes('freemodel')); } catch {}
    } finally {
        if (email) {
            exportAccount({ index, email, apiKey, inviteCode: refCode, sessionFile, cookies, success });
            appendKeysFile(email, apiKey, refCode);
        }
        if (fs.existsSync(sessionFile)) { try { fs.unlinkSync(sessionFile); } catch {} }
        if (browser) await browser.close().catch(() => {});
    }

    return { success, refCode, email, apiKey };
}

// ─── ОСНОВНОЙ ЦИКЛ ──────────────────────────────────────────────
(async () => {
    const count = Number(process.argv[2]) || config.ACCOUNTS_COUNT || 1;

    // Pick up where the previous run left off. CLI override > .last_invite > config.
    const cliInvite = process.argv.find(a => /^FRE-[A-Za-z0-9]+$/.test(a));
    const lastInvite = loadLastInvite();
    let currentInvite = cliInvite || lastInvite || config.INITIAL_INVITE;

    log('════════════════════════════════════════');
    log(`  FREEMODEL AUTOREG v2 (emailnator) — ${count} акк(а)`);
    log(`  Старт инвайт: ${currentInvite}` +
        (cliInvite     ? '  (CLI arg)'
        : lastInvite   ? '  (из .last_invite)'
                       : '  (config.INITIAL_INVITE)'));
    log(`  Прокси: ${config.PROXY || '(нет)'}`);
    log('════════════════════════════════════════');

    let ok = 0, fail = 0;

    let stop = false;
    process.on('SIGINT', () => { log('\n[!] Ctrl+C — остановка после текущего акка'); stop = true; });

    for (let i = 1; i <= count; i++) {
        if (stop) break;
        try {
            const r = await registerOne(i, currentInvite);
            if (r.success) ok++; else fail++;
            if (r.refCode) {
                currentInvite = r.refCode;
                saveLastInvite(r.refCode);   // persist for next run
                log(`[цепочка] следующий инвайт: ${currentInvite}  (сохранён в .last_invite)`);
            } else {
                log(`[цепочка] ⚠️ реф-код не получили, остаёмся на ${currentInvite}`);
            }
        } catch (e) {
            fail++;
            log(`[#${i}] фатально: ${e.message}`);
        }
        if (i < count && !stop) {
            log(`⏳ пауза ${config.DELAY_BETWEEN_ACCOUNTS_MS / 1000}с...`);
            await new Promise(r => setTimeout(r, config.DELAY_BETWEEN_ACCOUNTS_MS));
        }
    }

    log('\n════════════════════════════════════════');
    log(`  ИТОГ: ✅ ${ok} | ❌ ${fail}`);
    log(`  Ключи: ${config.KEYS_FILE}`);
    log(`  Аккаунты: ${config.ACCOUNTS_DIR}`);
    log(`  Последний реф: ${currentInvite}  (.last_invite)`);
    log('════════════════════════════════════════');
})().catch(e => { log(`💥 ${e.message}`); process.exit(1); });
