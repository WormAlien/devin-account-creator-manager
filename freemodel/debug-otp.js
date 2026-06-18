// freemodel/debug-otp.js
//
// Дебаг приёма OTP от FreeModel через 10minutemail.
// Создаёт ящик, регистрируется на freemodel.dev, поллит почту и печатает
// raw JSON каждого письма + извлечённый код.

const { chromium } = require('playwright');
const tmm = require('./lib/10minutemail');
const config = require('./config');
const fs = require('fs');
const path = require('path');

const LAST_INVITE_FILE = path.join(__dirname, '.last_invite');
function loadLastInvite() {
  try { if (fs.existsSync(LAST_INVITE_FILE)) return fs.readFileSync(LAST_INVITE_FILE, 'utf8').trim(); } catch {}
  return config.INITIAL_INVITE;
}

const invite = process.argv[2] || loadLastInvite();
const signupUrl = config.SIGNUP_URL_TPL.replace('{CODE}', invite);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[debug] ${msg}`); }

(async () => {
  let jar;
  let browser;
  try {
    let emailData;
    let domainTries = 0;
    const allowed = config.EMAIL_ALLOWED_DOMAINS || [];
    while (true) {
      emailData = await tmm.createEmail();
      const domain = emailData.address.split('@')[1];
      if (!allowed.length || allowed.includes(domain)) break;
      domainTries++;
      log(`domain @${domain} not allowed, retry #${domainTries}`);
      if (emailData.jar?.dispose) emailData.jar.dispose();
      if (domainTries >= 15) throw new Error('could not get allowed domain');
    }
    jar = emailData.jar;
    const email = emailData.address;
    log(`email: ${email}`);

    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: config.VIEWPORT, locale: 'en-US' });
    const page = await context.newPage();

    await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    log(`page url: ${page.url()}`);
    const shot1 = path.join(__dirname, 'accounts', `_debug_before_${Date.now()}.png`);
    await page.screenshot({ path: shot1, fullPage: true });
    log(`screenshot before: ${shot1}`);

    // fill email using same selectors as autoreger
    const SELECTORS = {
      emailInput: 'input[type="email"], input[name="email"], input[placeholder*="mail" i]',
      submitSignup: 'button:has-text("Sign up"), button:has-text("Continue"), button:has-text("Регистрация"), button[type="submit"]',
    };
    let filled = false;
    for (const frame of page.frames()) {
      const loc = frame.locator(SELECTORS.emailInput).first();
      if ((await loc.count()) > 0) {
        await loc.fill('');
        await loc.pressSequentially(email, { delay: 80 });
        filled = true;
        log('email filled');
        break;
      }
    }
    if (!filled) {
      log('email input not found, body text:');
      console.log((await page.locator('body').innerText().catch(() => '')).slice(0, 500));
    }
    await sleep(500);

    let submitted = false;
    for (const frame of page.frames()) {
      const btn = frame.locator(SELECTORS.submitSignup).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 5000 });
        submitted = true;
        log('submit clicked');
        break;
      }
    }
    if (!submitted) {
      await page.keyboard.press('Enter');
      log('submitted via Enter');
    }
    await sleep(3500);
    log(`after submit url: ${page.url()}`);
    const shot2 = path.join(__dirname, 'accounts', `_debug_after_${Date.now()}.png`);
    await page.screenshot({ path: shot2, fullPage: true });
    log(`screenshot after: ${shot2}`);

    log('polling inbox...');
    const deadline = Date.now() + 120000;
    let lastCount = 0;
    while (Date.now() < deadline) {
      const inbox = await tmm.fetchInbox(jar);
      if (inbox.count !== lastCount) {
        log(`inbox count: ${inbox.count}`);
        lastCount = inbox.count;
      }
      if (inbox.count > 0) {
        const emails = await tmm.fetchMessagesAfter(jar, 0);
        for (const em of emails) {
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('RAW JSON:', JSON.stringify(em, null, 2));
          const text = tmm.emailToText(em);
          console.log('FLAT TEXT:', text.slice(0, 600));
          console.log('matches freemodel:', tmm.emailMatchesFrom(em, 'freemodel'));
          console.log('OTP:', tmm.extractOtp6(text));
          console.log('link:', tmm.extractMagicLink(text));
        }
      }
      await sleep(3000);
    }
    log('timeout');
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    if (jar) jar.dispose();
    if (browser) await browser.close().catch(() => {});
  }
})();
