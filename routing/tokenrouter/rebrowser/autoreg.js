// routing/tokenrouter/rebrowser/autoreg.js
// TokenRouter.me auto-reg on rebrowser-playwright (patched CDP for Cloudflare bypass)
// Run: $env:TEMP\node20\node-v20.19.0-win-x64\node.exe autoreg.js [count]

const { chromium } = require('rebrowser-playwright');
const path = require('path');
const fs = require('fs');
const ite = require('../../../freemodel/lib/10minutemail');

const TOKENROUTER_URL = 'https://tokenrouter.me';
const KEYS_URL = 'https://tokenrouter.me/keys';
const ACCOUNTS_FILE = path.join(__dirname, '..', 'accounts.json');
const PROFILE = path.join(__dirname, '..', 'chrome-profile');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function log(tag, msg) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] [${tag}] ${msg}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function genPwd() {
    const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
    let p = ''; for (let i = 0; i < 16; i++) p += c[Math.floor(Math.random() * c.length)];
    return p + 'aA1!';
}

function loadAccounts() {
    try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
    catch { return []; }
}

function saveAccount(acc) {
    const a = loadAccounts();
    a.push(acc);
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2), 'utf8');
    log('save', `saved (total: ${a.length})`);
}

async function tryClick(page, selectors) {
    for (const sel of selectors) {
        try {
            const el = await page.waitForSelector(sel, { timeout: 3000, state: 'visible' });
            if (el) { await el.click(); log('click', sel); return sel; }
        } catch {}
    }
    return null;
}

async function tryFill(page, selectors, value) {
    for (const sel of selectors) {
        try {
            const el = await page.waitForSelector(sel, { timeout: 2000, state: 'visible' });
            if (el) { await el.click(); await el.fill(''); await el.fill(value); log('fill', sel); return sel; }
        } catch {}
    }
    return null;
}

async function handleTurnstile(page) {
    log('turnstile', 'waiting for Cloudflare Turnstile...');
    const start = Date.now();
    let warned = false;
    while (Date.now() - start < 45000) {
        try {
            const token = await page.$eval('input[name="cf-turnstile-response"]', el => el.value).catch(() => '');
            if (token && token.length > 10) { log('turnstile', 'passed (invisible)'); return true; }
            const marker = await page.$('.cf-turnstile[data-callback], .cf-turnstile-wrapper .cf-success');
            if (marker) { await sleep(1000); log('turnstile', 'passed (marker)'); return true; }
        } catch {}
        if (!warned && Date.now() - start > 20000) {
            console.log('\n  If you see a CAPTCHA, solve it manually...\n');
            warned = true;
        }
        await sleep(2000);
    }
    console.log('\n  Manual solve needed — press Enter after solving...');
    await new Promise(r => { process.stdin.once('data', () => r()); process.stdin.resume(); });
    const token = await page.$eval('input[name="cf-turnstile-response"]', el => el.value).catch(() => '');
    if (token && token.length > 10) { log('turnstile', 'manual solve OK'); return true; }
    log('turnstile', 'FAILED');
    return false;
}

async function createAccount(context, idx) {
    log('acc', `=== Account #${idx + 1} ===`);

    const emailData = await ite.createEmail();
    const email = emailData.address;
    const password = genPwd();
    log('email', email);

    const page = await context.newPage();
    
    await page.goto(TOKENROUTER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}

    // Click signup
    const signupClicked = await tryClick(page, [
        'text=Register', 'text=Sign Up', 'text=Get Started', 'text=Create Account',
        'a[href*="register"]', 'a[href*="signup"]', 'button:has-text("Register")',
    ]);
    if (!signupClicked) log('form', 'no explicit signup button');
    await sleep(3000);
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}

    log('form', `URL: ${page.url()}`);

    // Switch to signup tab if on a login page
    await tryClick(page, [
        'text=Sign up', 'text=Create account', 'text=Don\'t have an account',
        'a[href*="register"]', 'a[href*="signup"]', '[data-tab="signup"]',
    ]);
    await sleep(2500);
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}

    // Debug: show visible inputs
    const inputs = await page.evaluate(() => {
        const ix = document.querySelectorAll('input:not([type="hidden"])');
        return Array.from(ix).filter(e => e.offsetParent).slice(0, 5).map(e => ({
            type: e.type, name: e.name, id: e.id, placeholder: (e.placeholder || '').substring(0, 30),
        }));
    });
    log('form', `inputs: ${JSON.stringify(inputs)}`);

    // Fill email
    const emailOk = await tryFill(page, [
        'input[type="email"]', 'input[name="email"]', 'input[id="email"]',
        'input[placeholder*="email" i]', 'input[autocomplete="email"]', 'input[type="text"]',
    ], email);
    if (!emailOk) { log('form', 'EMAIL NOT FOUND'); await page.screenshot({ path: path.join(__dirname, 'debug_email.png') }); throw new Error('email not found'); }

    // Fill password
    const pwdOk = await tryFill(page, [
        'input[type="password"]', 'input[name="password"]', 'input[id="password"]',
        'input[placeholder*="password" i]', 'input[autocomplete="new-password"]',
    ], password);
    if (!pwdOk) { log('form', 'PASSWORD NOT FOUND'); throw new Error('password not found'); }

    // Confirm password if present
    for (const sel of ['input[name="confirmPassword"]', 'input[id*="confirm" i][type="password"]']) {
        try { const el = await page.$(sel); if (el && await el.isVisible()) { await el.fill(password); log('form', 'filled confirm'); break; } } catch {}
    }

    // Turnstile
    await handleTurnstile(page);

    // Submit
    const submitted = await tryClick(page, [
        'button[type="submit"]', 'button:has-text("Sign Up")', 'button:has-text("Create Account")',
        'button:has-text("Register")', 'button:has-text("Continue")', '[data-testid="submit"]',
    ]);
    if (!submitted) { await page.keyboard.press('Enter'); log('form', 'pressed Enter'); }
    await sleep(4000);

    // Check for "check email" message
    let sawSuccess = false;
    try { await page.waitForSelector('text=check your email', { timeout: 8000 }); sawSuccess = true; log('form', 'check email message'); } catch {}
    try { await page.waitForSelector('text=verify your email', { timeout: 3000 }); sawSuccess = true; } catch {}
    if (!sawSuccess && (page.url().includes('/keys') || page.url().includes('/dashboard'))) {
        sawSuccess = true; log('form', 'auto-logged in?');
    }

    // Poll inbox
    log('email', 'polling inbox...');
    const otp = await ite.waitForOtp(emailData.token, {
        fromHint: 'tokenrouter', timeoutMs: 120000, pollMs: 4000,
        log: m => log('email', m),
    });

    let verifyLink = null;
    if (otp && otp.code) {
        log('email', `OTP: ${otp.code}`);
        await tryFill(page, ['input[placeholder*="code" i]', 'input[name="code"]', 'input[name="otp"]', 'input[type="text"][maxlength="6"]'], otp.code);
        const verifyBtn = await page.$('button[type="submit"], button:has-text("Verify")');
        if (verifyBtn) { await verifyBtn.click(); await sleep(3000); }
    }
    if (otp && otp.link) verifyLink = otp.link;
    else if (otp && otp.raw) {
        const text = ite.emailToText(otp.raw);
        const m = text.match(/https?:\/\/tokenrouter\.me\/[^\s"'<>]+/i);
        if (m) verifyLink = m[0];
    }

    if (verifyLink) {
        log('nav', 'clicking verify link...');
        await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);
        try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
    }

    // Go to keys
    const url = page.url();
    if (!url.includes('/keys') && !url.includes('/dashboard')) {
        await page.goto(KEYS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);
    }

    // Login if needed
    const needsLogin = await page.$('input[type="email"], input[name="email"]').catch(() => null);
    if (needsLogin) {
        log('auth', 'logging in...');
        await tryFill(page, ['input[type="email"]', 'input[name="email"]'], email);
        await tryFill(page, ['input[type="password"]'], password);
        await tryClick(page, ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Sign in")']);
        await sleep(3000);
        if (!page.url().includes('/keys')) { await page.goto(KEYS_URL); await sleep(3000); }
    }

    // Create API key
    log('keys', 'creating API key...');
    await tryClick(page, [
        'text=Create API Key', 'text=Generate Key', 'text=New Key', 'text=Add Key',
        'button:has-text("Create")', 'button:has-text("Generate")',
    ]);
    await sleep(2000);

    const keyName = `auto-${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}`;
    await tryFill(page, ['input[name="name"]', 'input[placeholder*="name" i]', 'input[placeholder*="key" i]'], keyName);
    await tryClick(page, ['button:has-text("Create")', 'button:has-text("Generate")', 'button[type="submit"]']);
    await sleep(2500);

    // Extract key
    let apiKey = null;
    try {
        const body = await page.evaluate(() => document.body.innerText);
        const km = body.match(/(?:tr_|sk-)[A-Za-z0-9_-]{20,}/);
        if (km) apiKey = km[0];
    } catch {}
    if (!apiKey) {
        const codeEls = await page.$$('code, pre, input[readonly]');
        for (const el of codeEls) {
            const t = (await el.textContent()).trim();
            if (t.length > 20 && (t.startsWith('tr_') || t.startsWith('sk-'))) { apiKey = t; break; }
        }
    }
    if (apiKey) log('keys', `got key: ***${apiKey.slice(-8)}`);
    else { log('keys', 'NO KEY EXTRACTED'); await page.screenshot({ path: path.join(__dirname, 'debug_key.png') }); }

    const account = { email, password, apiKey, apiKeyName: keyName, createdAt: new Date().toISOString() };
    saveAccount(account);

    await page.close();
    log('acc', `DONE: ${email} ${apiKey ? '***' + apiKey.slice(-8) : 'NO KEY'}`);
    return account;
}

async function main() {
    let count = 1;
    for (const a of process.argv.slice(2)) { if (/^\d+$/.test(a)) count = Math.max(1, Math.min(20, +a)); }

    console.log('═'.repeat(60));
    console.log('  TokenRouter.me — rebrowser-playwright (patched CDP)');
    console.log(`  Accounts: ${count}  |  Profile: ${PROFILE}`);
    console.log('═'.repeat(60) + '\n');

    if (!fs.existsSync(PROFILE)) fs.mkdirSync(PROFILE, { recursive: true });

    const context = await chromium.launchPersistentContext(PROFILE, {
        headless: false,
        viewport: { width: 1920, height: 1080 },
        userAgent: UA,
        locale: 'en-US',
        timezoneId: 'America/Chicago',
        args: ['--no-first-run', '--no-default-browser-check'],
    });

    try {
        for (let i = 0; i < count; i++) {
            try { await createAccount(context, i); } catch (e) { log('err', e.message); console.error(e.stack); }
            if (i < count - 1) { console.log('  --- 3s pause ---\n'); await sleep(3000); }
        }
    } finally {
        await context.close();
    }
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
