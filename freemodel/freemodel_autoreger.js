// freemodel/freemodel_autoreger.js
//
// Massовая регистрация на freemodel.dev по реф-цепочке (пирамида).
//
// Поток (по подтверждённой механике):
//   1. Создаём guerrillamail-инбокс
//   2. Открываем https://freemodel.dev/invite/{CODE}, проходим signup form
//   3. На email прилетает ссылка/магиклинк (НЕТ пароля — вход по подтверждению почты)
//   4. Кликаем линк через Playwright в той же сессии → попадаем в Dashboard залогиненными
//   5. Сохраняем storageState + cookies.json в freemodel/accounts/<N>_<label>/
//   6. Идём в API Keys → Create → копируем fe_xxx
//   7. Берём свою реф-ссылку из Dashboard → она становится INVITE для следующего акка
//   8. keys.txt: email|api_key|next_invite_code
//
// ВАЖНО: точные селекторы формы и страницы API Keys я не угадываю.
// Они конфигурируются ниже в SELECTORS — заполнишь ручной проверкой первого прогона
// (см. README) или скрипт сам спросит при первой ошибке селектора.
//
// Использование:
//   node freemodel/freemodel_autoreger.js
//   node freemodel/freemodel_autoreger.js 3        # сколько аккаунтов

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { GuerrillaInbox } = require('./lib/guerrillamail');

// ─── СЕЛЕКТОРЫ ──────────────────────────────────────────────────
// Если страница freemodel изменится — правишь здесь.
// На первом ручном прогоне сверь их с реальностью.
const SELECTORS = {
    // На /invite/<code>
    emailInput: 'input[type="email"], input[name="email"], input[placeholder*="mail" i]',
    submitSignup: 'button:has-text("Sign up"), button:has-text("Continue"), button:has-text("Регистрация"), button[type="submit"]',

    // Dashboard признак (что-то одно из этих должно появиться)
    dashboardMarker: 'text=Dashboard, text=API Keys, [href*="/dashboard"]',

    // API Keys
    apiKeysLink: 'a[href*="api-keys"], a[href*="keys"], text=API Keys',
    createKeyBtn: 'button:has-text("Create"), button:has-text("New key"), button:has-text("Создать")',
    keyValueText: 'code, .api-key, [data-testid*="key"]',

    // Реф-ссылка (Dashboard → Invite/Referrals)
    refLinkHint: 'a[href*="/invite/"], input[value*="/invite/"], text=/FRE-[A-Za-z0-9]+/',
};

// ─── УТИЛИТЫ ────────────────────────────────────────────────────
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
    // Любая ссылка на freemodel.dev — берём первую с верифицирующим путём
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

// ─── ЭКСПОРТ АККАУНТА ───────────────────────────────────────────
function exportAccount({ index, email, apiKey, inviteCode, sessionFile, cookies, success }) {
    if (!fs.existsSync(config.ACCOUNTS_DIR)) fs.mkdirSync(config.ACCOUNTS_DIR, { recursive: true });

    const label = success ? 'ok' : 'err';
    const ident = email.split('@')[0].replace(/[^\w-]/g, '_');
    const dir = path.join(config.ACCOUNTS_DIR, `${index}_${ts()}_${label}_${ident}`);
    fs.mkdirSync(dir, { recursive: true });

    // session.json
    if (sessionFile && fs.existsSync(sessionFile)) {
        fs.copyFileSync(sessionFile, path.join(dir, 'session.json'));
    }

    // cookies.json (формат для импорта в Chrome extension)
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

    // restore_session.js
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

    // account_info.txt
    const info = `Index: ${index}
Email: ${email}
API Key: ${apiKey || '(не получен)'}
Invite Code (мой реф): ${inviteCode || '(не получен)'}
Status: ${success ? '✅ OK' : '❌ ERROR'}
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

    // Найти поле email во фреймах
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
    if (!filled) throw new Error('поле email не найдено (правь SELECTORS.emailInput)');

    await page.waitForTimeout(500);

    // Submit
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
    if (!submitted) {
        // Пробуем Enter
        await page.keyboard.press('Enter');
    }
}

async function waitForVerificationLink(inbox) {
    log(`[почта] жду письмо от freemodel...`);
    const matcher = ({ from, subject }) => {
        const f = (from || '').toLowerCase();
        const s = (subject || '').toLowerCase();
        if (f.includes(config.EMAIL_FROM_HINT)) return true;
        return config.EMAIL_SUBJECT_HINTS.some(h => s.includes(h));
    };
    const msg = await inbox.waitForMessage(matcher, {
        pollMs: config.EMAIL_POLL_MS,
        timeoutMs: config.EMAIL_WAIT_MAX_MS,
    });
    if (!msg) throw new Error('письмо от freemodel не пришло за тайм-аут');

    const body = msg.mail_body || '';
    log(`[почта] 📬 от: ${msg.mail_from} | тема: ${msg.mail_subject}`);

    const link = extractMagicLink(body) || extractMagicLink(stripHtml(body));
    if (!link) {
        log('[почта] ⚠️ ссылка не извлечена. Кусок тела:');
        log(stripHtml(body).slice(0, 500));
        throw new Error('magic-link не найден в письме (см. лог)');
    }
    log(`[почта] 🔗 ${link}`);
    return link;
}

async function visitMagicLink(context, link) {
    const page = await context.newPage();
    log(`[магиклинк] открываю...`);
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Дать редиректам отработать
    for (let i = 0; i < 6; i++) {
        const u = page.url();
        if (u.includes('/dashboard') || u.includes('/app') || u.includes('/account')) break;
        await page.waitForTimeout(2000);
    }
    log(`[магиклинк] URL после клика: ${page.url()}`);
    return page;
}

async function createApiKey(page) {
    log('[ключ] перехожу к API Keys');
    // Пытаемся открыть страницу ключей напрямую
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

    // Клик "Create"
    try {
        await page.locator(SELECTORS.createKeyBtn).first().click({ timeout: 8000 });
        await page.waitForTimeout(2500);
    } catch (e) {
        log(`[ключ] ⚠️ кнопка Create не нажалась: ${e.message}`);
    }

    // Иногда нужен инпут с названием — пробуем подтвердить ещё раз
    try {
        const confirm = page.locator('button:has-text("Create"), button:has-text("Confirm"), button[type="submit"]').first();
        if (await confirm.count() > 0 && await confirm.isVisible()) {
            await confirm.click({ timeout: 4000 });
            await page.waitForTimeout(2500);
        }
    } catch {}

    // Поиск ключа в DOM
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const m = bodyText.match(/fe[_-][A-Za-z0-9_-]{20,}/);
    if (m) {
        log(`[ключ] 🔑 ${m[0]}`);
        return m[0];
    }

    // Поиск в инпутах
    const inputs = await page.locator('input, textarea, code').all();
    for (const inp of inputs) {
        try {
            const v = (await inp.inputValue().catch(() => '')) || (await inp.innerText().catch(() => ''));
            const mm = v.match(/fe[_-][A-Za-z0-9_-]{20,}/);
            if (mm) {
                log(`[ключ] 🔑 ${mm[0]}`);
                return mm[0];
            }
        } catch {}
    }

    log('[ключ] ❌ ключ не найден в DOM. Проверь страницу вручную.');
    return null;
}

async function grabReferralCode(page) {
    log('[реф] ищу свою реф-ссылку');
    // Подтверждённый путь: /dashboard/refer
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
            if (code) {
                log(`[реф] 🔗 ${code}`);
                return code;
            }
            // Также смотрим в href
            const hrefs = await page.locator('a[href*="/invite/"]').all();
            for (const a of hrefs) {
                const href = await a.getAttribute('href').catch(() => '');
                const c = extractInviteCode(href);
                if (c) { log(`[реф] 🔗 ${c}`); return c; }
            }
        } catch {}
    }
    log('[реф] ⚠️ реф-код не найден — продолжаем с тем же инвайтом');
    return null;
}

// ─── ОДИН АККАУНТ ───────────────────────────────────────────────
async function registerOne(index, inviteCode) {
    log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(`[#${index}] инвайт: ${inviteCode}`);

    const inbox = new GuerrillaInbox();
    const email = await inbox.create();
    log(`[#${index}] email: ${email}`);

    const launchOpts = { headless: config.HEADLESS, args: ['--disable-blink-features=AutomationControlled'] };
    const proxy = parseProxy(config.PROXY);
    if (proxy) launchOpts.proxy = proxy;

    const browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
        viewport: config.VIEWPORT,
        userAgent: config.USER_AGENT,
        locale: config.LOCALE,
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    const sessionFile = path.join(config.ACCOUNTS_DIR, `_tmp_session_${index}.json`);

    let apiKey = null, refCode = null, success = false, cookies = [];

    try {
        const signupUrl = config.SIGNUP_URL_TPL.replace('{CODE}', inviteCode);
        log(`[#${index}] открываю ${signupUrl}`);
        await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);

        await fillSignupForm(page, email);
        await page.waitForTimeout(2000);

        const link = await waitForVerificationLink(inbox);
        const dashPage = await visitMagicLink(context, link);

        // Проверим что мы реально внутри
        const url = dashPage.url();
        if (!/\/(dashboard|app|account)/.test(url)) {
            log(`[#${index}] ⚠️ после магиклинка URL: ${url} — возможно надо ещё шаг`);
        }

        // Сохраним сессию ДО создания ключа — на случай если что-то упадёт
        await context.storageState({ path: sessionFile });
        cookies = (await context.cookies()).filter(c => c.domain.includes('freemodel'));

        apiKey = await createApiKey(dashPage);
        refCode = await grabReferralCode(dashPage);

        // Финальный snapshot сессии
        await context.storageState({ path: sessionFile });

        success = !!apiKey;
    } catch (e) {
        log(`[#${index}] ❌ ${e.message}`);
        try {
            const shot = path.join(config.ACCOUNTS_DIR, `_error_${index}_${ts()}.png`);
            await page.screenshot({ path: shot });
            log(`[#${index}] 📸 ${shot}`);
        } catch {}
        try { await context.storageState({ path: sessionFile }); } catch {}
        try { cookies = (await context.cookies()).filter(c => c.domain.includes('freemodel')); } catch {}
    } finally {
        exportAccount({ index, email, apiKey, inviteCode: refCode, sessionFile, cookies, success });
        appendKeysFile(email, apiKey, refCode);
        if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
        await browser.close().catch(() => {});
    }

    return { success, refCode, email, apiKey };
}

// ─── ОСНОВНОЙ ЦИКЛ ──────────────────────────────────────────────
(async () => {
    const count = Number(process.argv[2]) || config.ACCOUNTS_COUNT || 1;
    log(`════════════════════════════════════════`);
    log(`  FREEMODEL AUTOREG — ${count} акк(а)`);
    log(`  Старт инвайт: ${config.INITIAL_INVITE}`);
    log(`  Прокси: ${config.PROXY || '(нет)'}`);
    log(`════════════════════════════════════════`);

    let currentInvite = config.INITIAL_INVITE;
    let ok = 0, fail = 0;

    let stop = false;
    process.on('SIGINT', () => { log('\n[!] Ctrl+C — останавливаемся после текущего акка'); stop = true; });

    for (let i = 1; i <= count; i++) {
        if (stop) break;
        try {
            const r = await registerOne(i, currentInvite);
            if (r.success) ok++; else fail++;
            // Пирамида: следующий регится по реф-коду этого аккаунта
            if (r.refCode) {
                currentInvite = r.refCode;
                log(`[цепочка] следующий инвайт: ${currentInvite}`);
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

    log(`\n════════════════════════════════════════`);
    log(`  ИТОГ: ✅ ${ok} | ❌ ${fail}`);
    log(`  Ключи: ${config.KEYS_FILE}`);
    log(`  Аккаунты: ${config.ACCOUNTS_DIR}`);
    log(`════════════════════════════════════════`);
})().catch(e => { log(`💥 ${e.message}`); process.exit(1); });
