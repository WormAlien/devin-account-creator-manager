// routing/tokenrouter-autoreg.js
//
// TokenRouter.me Auto-Registration + API Key Creator
// Использует Playwright channel:'chrome' — НАСТОЯЩИЙ Google Chrome,
// не Chromium. Cloudflare видит обычный пользовательский браузер.
// Temp email via 10minutemail.com cookie/curl API (no browser needed for mail).
//
// Usage: node routing/tokenrouter-autoreg.js [count]
//   count — number of accounts to create (default 1)

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const ite = require('../freemodel/lib/10minutemail');

// ═══════════════════ CONFIG ═══════════════════════════════════════════
const TOKENROUTER_URL = 'https://tokenrouter.me';
const KEYS_URL = 'https://tokenrouter.me/keys';
const ACCOUNTS_FILE = path.join(__dirname, 'tokenrouter', 'accounts.json');
const CHROME_PROFILE = path.join(__dirname, 'tokenrouter', 'chrome-profile');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ═══════════════════ HELPERS ══════════════════════════════════════════
function log(tag, msg) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] [${tag}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generatePassword(len = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
    let pw = '';
    for (let i = 0; i < len; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    return pw + 'aA1!'; // гарантируем uppercase + digit + special
}

function loadAccounts() {
    try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
    catch { return []; }
}

function saveAccount(acc) {
    const accounts = loadAccounts();
    accounts.push(acc);
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
    log('save', `✓ saved to accounts.json (total: ${accounts.length})`);
}

// ═══════════════════ STEALTH INIT ═════════════════════════════════════
const STEALTH_SCRIPT = `
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Fake plugins array
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            const arr = [1, 2, 3, 4, 5];
            arr.item = (i) => arr[i];
            arr.namedItem = () => null;
            arr.refresh = () => {};
            return arr;
        }
    });

    // Fake mimeTypes
    Object.defineProperty(navigator, 'mimeTypes', {
        get: () => {
            const arr = [
                { type: 'application/pdf', suffixes: 'pdf' },
                { type: 'text/pdf', suffixes: 'pdf' },
            ];
            arr.item = (i) => arr[i];
            arr.namedItem = () => null;
            return arr;
        }
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // Fake chrome object
    window.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {},
    };

    // Permission query override
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params);
`;

// ═══════════════════ BROWSER SETUP (Google Chrome) ═══════════════════
// channel: 'chrome' = Playwright запускает НАСТОЯЩИЙ системный Google Chrome,
// НЕ Chromium. В этом режиме Playwright НЕ добавляет --enable-automation
// и прочие детектящиеся флаги. Cloudflare видит обычный браузер юзера.
//
// launchPersistentContext = куки + localStorage + профиль сохраняются
// между запусками, фингерпринт стабильный.

async function launchBrowser() {
    if (!fs.existsSync(CHROME_PROFILE)) fs.mkdirSync(CHROME_PROFILE, { recursive: true });

    log('browser', 'запускаю Google Chrome (channel: chrome)...');

    const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
        channel: 'chrome',
        headless: false,
        viewport: { width: 1920, height: 1080 },
        userAgent: UA,
        locale: 'en-US',
        timezoneId: 'America/Chicago',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
        ],
    });

    // Stealth init — страховка, хоть с channel:'chrome' webdriver и так undefined
    context.on('page', async (page) => {
        await page.addInitScript(STEALTH_SCRIPT);
    });
    for (const page of context.pages()) {
        await page.addInitScript(STEALTH_SCRIPT);
    }

    log('browser', '✓ Google Chrome готов');
    return context;
}

// ═══════════════════ TURNSTILE HANDLER ════════════════════════════════
async function handleTurnstile(page, timeoutMs = 45000) {
    log('turnstile', 'detecting Cloudflare Turnstile...');

    const start = Date.now();
    let warned = false;

    while (Date.now() - start < timeoutMs) {
        try {
            // Check for cf-turnstile-response hidden input (invisible pass)
            const token = await page.$eval('input[name="cf-turnstile-response"]',
                el => el.value).catch(() => '');
            if (token && token.length > 10) {
                log('turnstile', '✓ passed (invisible)');
                return true;
            }

            // Check for iframe — if present with solved state
            const iframeSolved = await page.$eval(
                'iframe[src*="challenges.cloudflare.com"]',
                el => el.parentElement?.querySelector?.('.cf-success, [data-callback]') != null
            ).catch(() => false);
            if (iframeSolved) {
                log('turnstile', '✓ passed (visual solved)');
                return true;
            }

            // Check for success indicator markers
            const marker = await page.$('.cf-turnstile[data-callback], .cf-turnstile-wrapper .cf-success, #cf-chl-widget-*, div[style*="turnstile-wrapper"] .mark.success');
            if (marker) {
                await sleep(1000);
                log('turnstile', '✓ passed (marker detected)');
                return true;
            }

            // Check if there's no Turnstile at all (maybe not required)
            const hasIframe = await page.$('iframe[src*="cloudflare"]').catch(() => null);
            const hasWidget = await page.$('.cf-turnstile').catch(() => null);
            if (!hasIframe && !hasWidget) {
                // Might not be on the page — check for hidden input one more time
                const token2 = await page.$eval('input[name="cf-turnstile-response"]',
                    el => el.value).catch(() => '');
                if (token2 && token2.length > 10) {
                    log('turnstile', '✓ passed (hidden token)');
                    return true;
                }
                // No Turnstile detected at all — maybe form doesn't need it
                log('turnstile', 'no Turnstile element found on page, proceeding');
                return true;
            }

        } catch (e) {
            // Expected — elements might not exist yet
        }

        if (!warned && Date.now() - start > 25000) {
            console.log('\n  ⏳ Cloudflare Turnstile is taking a while...');
            console.log('  👆 If you see a CAPTCHA in the browser, please solve it manually.\n');
            warned = true;
        }

        await sleep(1500);
    }

    // Timeout — manual mode
    console.log('\n  ⚠ Turnstile не прошёл автоматически за 45 секунд.');
    console.log('  → Реши капчу вручную в открывшемся браузере.');
    console.log('  → После решения нажми Enter в этом терминале...\n');

    await new Promise(resolve => {
        process.stdin.once('data', () => resolve());
    });

    // Verify after manual intervention
    const token = await page.$eval('input[name="cf-turnstile-response"]',
        el => el.value).catch(() => '');
    if (token && token.length > 10) {
        log('turnstile', '✓ manual solve confirmed');
        return true;
    }

    log('turnstile', '✗ failed to solve');
    return false;
}

// ═══════════════════ SELECTOR HELPERS ═════════════════════════════════
async function tryClick(page, selectors) {
    for (const sel of selectors) {
        try {
            const el = await page.waitForSelector(sel, { timeout: 3000, state: 'visible' });
            if (el) {
                await el.click();
                log('click', `clicked: ${sel}`);
                return sel;
            }
        } catch {}
    }
    return null;
}

async function tryFill(page, selectors, value) {
    for (const sel of selectors) {
        try {
            const el = await page.waitForSelector(sel, { timeout: 2000, state: 'visible' });
            if (el) {
                await el.click();
                await el.fill('');
                await el.type(value, { delay: 30 });
                log('fill', `filled ${sel} = ***`);
                return sel;
            }
        } catch {}
    }
    return null;
}

// ═══════════════════ MAIN REGISTRATION FLOW ═══════════════════════════
async function createOneAccount(context, index) {
    log('account', `══════ Starting account #${index + 1} ══════`);

    // --- Step 1: Create temp email ---
    log('email', 'creating temp email via 10minutemail.com...');
    const emailData = await ite.createEmail();
    const email = emailData.address;
    const token = emailData.token;
    log('email', `created: ${email}`);

    // --- Step 2: Generate password ---
    const password = generatePassword();
    log('auth', `password generated (len=${password.length})`);

    // --- Step 3: Open tokenrouter.me ---
    const page = await context.newPage();
    await page.addInitScript(STEALTH_SCRIPT);

    log('nav', `navigating to ${TOKENROUTER_URL}...`);
    await page.goto(TOKENROUTER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Progressive wait — if page is still loading SPAs, wait a bit more
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}

    // --- Step 4: Find and click Sign Up ---
    log('form', 'looking for signup button...');
    const signupSelectors = [
        'text=Sign Up',
        'text=Get Started',
        'text=Register',
        'text=Create Account',
        'text=Start Free',
        'text=Try Free',
        'a[href*="signup"]',
        'a[href*="sign-up"]',
        'a[href*="register"]',
        'a[href*="auth"]',
        'button:has-text("Sign Up")',
        'button:has-text("Get Started")',
        'button:has-text("Register")',
        '[data-testid="signup-button"]',
        '.signup-btn',
        '.register-btn',
    ];

    let clicked = await tryClick(page, signupSelectors);
    if (!clicked) {
        log('form', 'no signup button found — form might be on landing page');
    }
    await sleep(3000);
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}

    const signupPageUrl = page.url();
    log('form', `URL after signup click: ${signupPageUrl}`);

    // Check if we landed on a tabbed auth page (login + signup tabs)
    const switchToSignupSelectors = [
        'text=Sign up',
        'text=Sign Up',
        'text=Create account',
        'text=Create Account',
        'text=Create an account',
        'text=Don\'t have an account',
        'text=No account yet',
        'text=No account',
        'text=Sign up instead',
        'text=Register now',
        'text=New here',
        'text=Get started',
        'a[href*="signup"]',
        'a[href*="sign-up"]',
        'a[href*="register"]',
        'button[role="tab"]:has-text("Sign")',
        '[data-value="signup"]',
        '[data-tab="signup"]',
        '.tab-signup',
        '.signup-tab',
    ];
    const switched = await tryClick(page, switchToSignupSelectors);
    if (switched) {
        log('form', `switched to signup tab: ${switched}`);
        await sleep(2000);
        try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
    }

    // --- Discover visible inputs for debugging ---
    const visibleInputs = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input:not([type="hidden"])');
        return Array.from(inputs)
            .filter(el => el.offsetParent !== null)
            .slice(0, 10)
            .map(el => ({
                type: el.type || '',
                name: el.name || '',
                id: el.id || '',
                placeholder: (el.placeholder || '').substring(0, 40),
                autocomplete: el.autocomplete || '',
            }));
    });
    log('form', `visible inputs: ${JSON.stringify(visibleInputs)}`);

    // --- Step 6: Fill email using discovered inputs + fallbacks ---
    log('form', 'filling email field...');
    let emailFilled = false;
    const emailSelectors = [
        'input[name="email"]',
        'input[type="email"]',
        'input[id*="email" i]',
        'input[placeholder*="email" i]',
        'input[placeholder*="Email"]',
        'input[autocomplete="email"]',
        'input[autocomplete="username"]',
        '#email',
        '[data-testid="email-input"]',
        '[data-cy="email"]',
        'input[name="username"]',
        'input[id*="username" i]',
        'input[type="text"]', // fallback: first text input
    ];
    for (const sel of emailSelectors) {
        try {
            const el = await page.waitForSelector(sel, { timeout: 2000, state: 'visible' });
            if (el) {
                await el.click();
                await el.fill('');
                await el.fill(email);
                log('form', `filled email: ${sel}`);
                emailFilled = true;
                break;
            }
        } catch {}
    }

    if (!emailFilled) {
        // Brute force: get the first text/email input and fill it
        const firstInput = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
            for (const el of inputs) {
                if (el.offsetParent === null) continue;
                if (el.type === 'email' || el.type === 'text') return { type: el.type, name: el.name, id: el.id };
            }
            return null;
        });
        if (firstInput) {
            const bruteSel = firstInput.id ? `#${firstInput.id}` :
                             firstInput.name ? `input[name="${firstInput.name}"]` :
                             `input[type="${firstInput.type}"]`;
            try {
                await page.fill(bruteSel, email);
                log('form', `brute-force filled email: ${bruteSel}`);
                emailFilled = true;
            } catch {}
        }
    }

    if (!emailFilled) {
        log('form', '✗ could not find email field — taking screenshot');
        await page.screenshot({ path: path.join(__dirname, 'tokenrouter', `debug_email_${index}.png`) });
        // Dump more HTML context for debugging
        const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 500));
        log('form', `page text: ${bodySnippet.replace(/\n/g, ' | ')}`);
        throw new Error('Email field not found');
    }

    // --- Step 7: Fill password ---
    log('form', 'filling password field...');
    const passwordSelectors = [
        'input[name="password"]',
        'input[type="password"]',
        'input[id*="password" i]',
        'input[placeholder*="password" i]',
        'input[placeholder*="Password"]',
        'input[autocomplete="new-password"]',
        'input[autocomplete="current-password"]',
        '#password',
        '[data-testid="password-input"]',
        '[data-cy="password"]',
        'input[type="password"]:not([name*="confirm"])',
    ];
    let pwdFilled = false;
    for (const sel of passwordSelectors) {
        try {
            const el = await page.waitForSelector(sel, { timeout: 2000, state: 'visible' });
            if (el) {
                await el.click();
                await el.fill('');
                await el.fill(password);
                log('form', `filled password: ${sel}`);
                pwdFilled = true;
                break;
            }
        } catch {}
    }

    if (!pwdFilled) {
        // Brute force: find any password input
        try {
            const pwdInputs = await page.$$('input[type="password"]');
            for (const el of pwdInputs) {
                if (await el.isVisible()) {
                    // Skip if it looks like a confirm field
                    const name = await el.getAttribute('name');
                    const id = await el.getAttribute('id');
                    if ((name || '').includes('confirm') || (id || '').includes('confirm')) continue;
                    await el.click();
                    await el.fill('');
                    await el.fill(password);
                    log('form', `brute-force filled password`);
                    pwdFilled = true;
                    break;
                }
            }
        } catch {}
    }

    if (!pwdFilled) {
        log('form', '✗ could not find password field');
        await page.screenshot({ path: path.join(__dirname, 'tokenrouter', `debug_pwd_${index}.png`) });
        throw new Error('Password field not found');
    }

    // --- Step 8: Password confirmation (if present) ---
    const confirmSelectors = [
        'input[name="confirmPassword"]',
        'input[name="password_confirm"]',
        'input[autocomplete="new-password"]:nth-of-type(2)',
        'input[id*="confirm" i][type="password"]',
    ];
    for (const sel of confirmSelectors) {
        try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) {
                await el.click();
                await el.fill('');
                await el.fill(password);
                log('form', `filled password confirmation`);
                break;
            }
        } catch {}
    }

    // --- Step 9: Handle Cloudflare Turnstile ---
    const turnstilePassed = await handleTurnstile(page);
    if (!turnstilePassed) {
        // Try one more approach — look for any submit button and try clicking it
        log('turnstile', 'attempting to proceed despite Turnstile uncertainty...');
    }

    // --- Step 10: Submit the form ---
    log('form', 'submitting registration form...');
    const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Sign Up")',
        'button:has-text("Create Account")',
        'button:has-text("Continue")',
        'button:has-text("Register")',
        'button:has-text("Get Started")',
        '[data-testid="submit-button"]',
        '.submit-btn',
    ];

    let submitted = await tryClick(page, submitSelectors);
    if (!submitted) {
        // Try pressing Enter on the last field
        log('form', 'no submit button — trying Enter key');
        await page.keyboard.press('Enter');
    }
    await sleep(3000);

    // --- Step 11: Wait for success indication ---
    log('form', 'waiting for "check email" confirmation...');
    const successSelectors = [
        'text=check your email',
        'text=verify your email',
        'text=confirmation email',
        'text=email sent',
        'text=please verify',
        'text=verification link',
        '.success-message',
        '[data-testid="verification-sent"]',
    ];

    let sawSuccess = false;
    for (const sel of successSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 8000 });
            log('form', `✓ confirmation: ${sel}`);
            sawSuccess = true;
            break;
        } catch {}
    }

    if (!sawSuccess) {
        // Check if we were redirected to a dashboard (maybe email verification is optional)
        const currentUrl = page.url();
        if (currentUrl.includes('/keys') || currentUrl.includes('/dashboard')) {
            log('form', 'seems to be logged in already (no email verify needed?)');
            sawSuccess = true;
        } else {
            log('form', '⚠ no explicit success message — will still try to poll email');
        }
    }

    // --- Step 12: Poll inbox for verification link ---
    log('email', 'polling inbox for verification link...');
    const otpResult = await ite.waitForOtp(token, {
        fromHint: 'tokenrouter',
        timeoutMs: 120000,
        pollMs: 4000,
        log: (msg) => log('email', msg),
    });

    let verifyLink = null;
    if (otpResult && otpResult.code) {
        log('email', `got 6-digit code: ${otpResult.code}`);
        // Try to use the code on the current page if there's an input
        const codeSelectors = [
            'input[type="text"][maxlength="6"]',
            'input[placeholder*="code" i]',
            'input[placeholder*="verification" i]',
            'input[name="code"]',
            'input[name="otp"]',
            'input[name="token"]',
        ];
        for (const sel of codeSelectors) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) {
                    await el.fill(otpResult.code);
                    log('email', 'filled verification code');
                    // Try to submit
                    const verifyBtn = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("Confirm")');
                    if (verifyBtn) await verifyBtn.click();
                    await sleep(3000);
                    break;
                }
            } catch {}
        }
    }

    if (otpResult && otpResult.link) {
        verifyLink = otpResult.link;
        log('email', `got magic link: ${verifyLink.substring(0, 60)}...`);
    } else if (otpResult && otpResult.raw) {
        // Try to extract any link from the email
        const text = ite.emailToText(otpResult.raw);
        const linkMatch = text.match(/https?:\/\/tokenrouter\.me\/[^\s"'<>]+/i);
        if (linkMatch) {
            verifyLink = linkMatch[0];
            log('email', `extracted link: ${verifyLink.substring(0, 60)}...`);
        }
    }

    if (verifyLink) {
        log('nav', 'clicking verification link...');
        await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);
        try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
    } else if (!otpResult) {
        log('email', '⚠ no verification email received within 2 minutes');
        log('email', '   continuing anyway — check if we are already logged in');
    }

    // --- Step 13: Check if logged in / navigate to keys ---
    const afterVerifyUrl = page.url();
    if (!afterVerifyUrl.includes('/keys') && !afterVerifyUrl.includes('/dashboard')) {
        log('nav', `navigating to ${KEYS_URL}...`);
        await page.goto(KEYS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);
        try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
    }

    // Check if we need to log in (verification might have logged us out or we're on a new session)
    const needsLogin = await page.$('input[type="email"], input[name="email"], text=Log in, text=Sign in').catch(() => null);
    if (needsLogin) {
        log('auth', 'need to log in after verification...');
        // Fill email
        await tryFill(page, emailSelectors, email);
        // Fill password
        const loginPwdSelectors = [
            'input[name="password"]',
            'input[type="password"]',
            'input[placeholder*="password" i]',
        ];
        await tryFill(page, loginPwdSelectors, password);

        const loginBtnSelectors = [
            'button[type="submit"]',
            'button:has-text("Log in")',
            'button:has-text("Sign in")',
            'button:has-text("Continue")',
        ];
        await tryClick(page, loginBtnSelectors);
        await sleep(3000);
        try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}

        // Navigate to keys if not there
        const url2 = page.url();
        if (!url2.includes('/keys') && !url2.includes('/dashboard')) {
            await page.goto(KEYS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(3000);
        }
    }

    // --- Step 14: Create API key ---
    log('keys', 'looking for "Create API Key" button...');
    const createKeySelectors = [
        'text=Create API Key',
        'text=Generate Key',
        'text=New Key',
        'text=Add Key',
        'text=Create Key',
        'button:has-text("Create")',
        'button:has-text("Generate")',
        'button:has-text("New")',
        'a[href*="create-key"]',
        'a[href*="new-key"]',
        '[data-testid="create-key-button"]',
        '.create-key-btn',
    ];

    let createClicked = await tryClick(page, createKeySelectors);
    if (!createClicked) {
        log('keys', '⚠ no "Create API Key" button visible');
        // Maybe there's a plus icon or similar
        const altSelectors = [
            'button[aria-label*="create" i]',
            'button[aria-label*="add" i]',
            '[title*="Create"]',
            '[title*="Add"]',
            'svg + button',
        ];
        createClicked = await tryClick(page, altSelectors);
    }

    if (!createClicked) {
        log('keys', '⚠ could not find create button — taking screenshot');
        await page.screenshot({ path: path.join(__dirname, 'tokenrouter', `debug_keys_${index}.png`) });
    }

    await sleep(2000);

    // --- Step 15: Fill key name (if modal/dialog appeared) ---
    const keyNameSelectors = [
        'input[name="name"]',
        'input[placeholder*="name" i]',
        'input[placeholder*="key" i]',
        'input[id*="name" i]',
        'input[id*="key" i]',
        '[data-testid="key-name-input"]',
    ];
    const keyName = `auto-${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}`;
    await tryFill(page, keyNameSelectors, keyName);

    // Confirm key creation
    const confirmKeySelectors = [
        'button:has-text("Create")',
        'button:has-text("Generate")',
        'button:has-text("Confirm")',
        'button:has-text("Save")',
        'button[type="submit"]',
    ];
    await tryClick(page, confirmKeySelectors);
    await sleep(2500);

    // --- Step 16: Extract the API key ---
    log('keys', 'extracting API key...');
    let apiKey = null;

    // Common patterns for displayed API keys
    const keyValueSelectors = [
        'code',
        'pre',
        '[data-testid="api-key-value"]',
        '.api-key',
        '.key-value',
        'input[readonly]',
        'input[type="text"][value*="tr_"]',
        'input[type="text"][value*="sk-"]',
        '[class*="key"] code',
        '[class*="key"] pre',
    ];

    for (const sel of keyValueSelectors) {
        try {
            const el = await page.$(sel);
            if (!el) continue;
            const text = (await el.textContent()).trim();
            // TokenRouter keys likely start with tr_ or sk-
            if (text.length > 20 && (text.startsWith('tr_') || text.startsWith('sk-') || text.includes('tr_') || text.includes('sk-'))) {
                apiKey = text;
                log('keys', `✓ found key: ***${apiKey.slice(-8)}`);
                break;
            }
            // Also check value attribute for readonly inputs
            const val = await el.getAttribute('value');
            if (val && val.length > 20 && (val.startsWith('tr_') || val.startsWith('sk-'))) {
                apiKey = val;
                log('keys', `✓ found key: ***${apiKey.slice(-8)}`);
                break;
            }
        } catch {}
    }

    // If not found, try getting all text on the page and regex-extract
    if (!apiKey) {
        try {
            const bodyText = await page.evaluate(() => document.body.innerText);
            const keyMatch = bodyText.match(/(?:tr_|sk-)[A-Za-z0-9_-]{20,}/);
            if (keyMatch) {
                apiKey = keyMatch[0];
                log('keys', `✓ extracted key from page: ***${apiKey.slice(-8)}`);
            }
        } catch {}
    }

    if (!apiKey) {
        log('keys', '⚠ could not extract API key — screenshotting for debug');
        await page.screenshot({ path: path.join(__dirname, 'tokenrouter', `debug_keyresult_${index}.png`) });
    }

    // --- Step 17: Save account ---
    const account = {
        email,
        password,
        apiKey: apiKey || null,
        apiKeyName: keyName,
        createdAt: new Date().toISOString(),
        tokenrouterToken: token,
    };
    saveAccount(account);

    // --- Step 18: Close page, keep context open for next account ---
    await page.close();

    log('account', `✓ done! email=${email} key=${apiKey ? '***' + apiKey.slice(-8) : 'MISSING'}`);
    return account;
}

// ═══════════════════ MAIN ═════════════════════════════════════════════
async function main() {
    const args = process.argv.slice(2);
    let count = 1;

    for (const arg of args) {
        if (/^\d+$/.test(arg)) count = Math.max(1, Math.min(20, parseInt(arg, 10)));
    }

    console.log('═'.repeat(60));
    console.log('  TokenRouter.me Auto-Registration + API Key Creator');
    console.log(`  Accounts: ${count}  |  Browser: Google Chrome (channel:chrome)`);
    console.log(`  Email: 10minutemail.com  |  Profile: ${CHROME_PROFILE}`);
    console.log('═'.repeat(60));
    console.log('');

    let context;
    try {
        context = await launchBrowser();

        const results = [];
        for (let i = 0; i < count; i++) {
            try {
                const acc = await createOneAccount(context, i);
                results.push(acc);
                console.log('');
            } catch (e) {
                log('error', `account #${i + 1} failed: ${e.message}`);
                console.error(e.stack);
                results.push({ error: e.message });
            }

            if (i < count - 1) {
                console.log('  --- waiting 3s before next account ---\n');
                await sleep(3000);
            }
        }

        console.log('═'.repeat(60));
        console.log('  Results:');
        const success = results.filter(r => r.apiKey);
        const failed = results.filter(r => !r.apiKey || r.error);
        console.log(`  ✓ Created: ${success.length}/${count}`);
        if (failed.length) console.log(`  ✗ Failed:  ${failed.length}/${count}`);

        for (const r of results) {
            if (r.apiKey) {
                console.log(`    ✓ ${r.email} → ***${r.apiKey.slice(-8)}`);
            } else {
                console.log(`    ✗ ${r.email || '?'} — ${r.error || 'no key extracted'}`);
            }
        }
        console.log(`  Saved to: ${ACCOUNTS_FILE}`);
        console.log('═'.repeat(60));

    } finally {
        if (context) await context.close();
    }
}

main().catch(e => {
    console.error('Fatal error:', e.message);
    console.error(e.stack);
    process.exit(1);
});
