// One-shot probe: open freemodel signup, submit a fake gmail, screenshot
// the resulting page. Tells us if the next step is OTP input or "check email".
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('./config');

(async () => {
    const inviteUrl = config.SIGNUP_URL_TPL.replace('{CODE}', config.INITIAL_INVITE);
    console.log('probe →', inviteUrl);

    const browser = await chromium.launch({ headless: false });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    const shotsDir = path.join(__dirname, 'probe_shots');
    fs.mkdirSync(shotsDir, { recursive: true });
    const ts = Date.now();

    try {
        await page.goto(inviteUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(shotsDir, `1_initial_${ts}.png`), fullPage: true });
        console.log('screenshot 1: initial form');

        // Probe the form
        const fakeEmail = 'probe.test.acc.999@gmail.com';
        const emailField = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
        await emailField.fill(fakeEmail);
        console.log('filled email:', fakeEmail);

        await page.screenshot({ path: path.join(shotsDir, `2_after_fill_${ts}.png`), fullPage: true });

        const submitBtn = page.locator('button:has-text("Sign up"), button:has-text("Continue"), button[type="submit"]').first();
        await submitBtn.click();
        console.log('submitted');

        await page.waitForTimeout(5000);
        await page.screenshot({ path: path.join(shotsDir, `3_after_submit_${ts}.png`), fullPage: true });

        // What does the page show now?
        const text = await page.locator('body').innerText().catch(() => '');
        const html = await page.content();

        const ind = {
            hasOtpInput:        !!await page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="6"], input[name*="code" i], input[name*="otp" i]').count(),
            hasCheckEmailMsg:   /check (?:your )?email|sent you|sent a|verification (?:email|link)|magic link/i.test(text),
            hasCodeInput:       /(?:enter|введи).{0,20}code/i.test(text) || /\bcode\b.*\binput\b/i.test(html),
            hasContinueBtn:     !!await page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Confirm")').count(),
            urlNow:             page.url(),
            firstHeadingsText:  (await page.locator('h1, h2, h3').allInnerTexts().catch(() => [])).slice(0, 3),
            inputs:             await page.locator('input').evaluateAll(els =>
                els.map(el => ({
                    type: el.type, name: el.name, placeholder: el.placeholder,
                    autocomplete: el.autocomplete, maxLength: el.maxLength,
                }))
            ),
            buttons:            (await page.locator('button').allInnerTexts().catch(() => [])).slice(0, 8),
        };

        console.log('\n=== STATE AFTER SUBMIT ===');
        console.log(JSON.stringify(ind, null, 2));

        const verdict = ind.hasOtpInput
            ? '🟡 FreeModel сейчас просит OTP-КОД (6-значный) — magic-link мёртв'
            : ind.hasCheckEmailMsg
                ? '🟢 FreeModel шлёт magic-link на почту (старая схема жива)'
                : '❓ непонятный ответ — проверь скриншоты в freemodel/probe_shots/';
        console.log('\n' + verdict);

        // Keep browser open 10s so you can eyeball
        await page.waitForTimeout(10000);
    } catch (e) {
        console.error('probe failed:', e.message);
        await page.screenshot({ path: path.join(shotsDir, `error_${ts}.png`), fullPage: true }).catch(() => {});
    } finally {
        await browser.close();
    }
})();
