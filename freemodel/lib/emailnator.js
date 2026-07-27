// freemodel/lib/emailnator.js
//
// Модульная обёртка над emailnator.com для получения Gmail-алиаса и OTP.
// Принимает готовый Playwright page — можно reuse тот же browser context.
//
// API:
//   const { createEmail, pollInbox } = require('../freemodel/lib/emailnator');
//   const email = await createEmail(page);
//   const code  = await pollInbox(page, email, { fromHint: 'cun', timeout: 120 });

const POLL_INTERVAL_MS = 8000;
const MAX_WAIT_MIN = 15;

async function createEmail(page) {
  console.log('[emailnator] Открываю emailnator.com...');
  await page.goto('https://www.emailnator.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });

  try { await page.click('button:has-text("Consent")', { timeout: 4000 }); } catch {}
  await page.waitForTimeout(1500);

  let email = '';
  for (let i = 0; i < 6; i++) {
    try {
      email = await page.locator('input').first().inputValue();
      if (email && email.includes('@gmail.com')) break;
    } catch {}
    await page.waitForTimeout(1000);
  }

  if (!email || !email.includes('@gmail.com')) {
    throw new Error('Не удалось получить email от emailnator');
  }

  console.log(`[emailnator] Gmail alias: ${email}`);
  return email;
}

async function pollInbox(page, email, opts = {}) {
  const timeoutMin = opts.timeout || MAX_WAIT_MIN;
  const fromHint = opts.fromHint || '';
  const maxAttempts = Math.floor((timeoutMin * 60 * 1000) / POLL_INTERVAL_MS);

  console.log(`[emailnator] Проверяю inbox ${email} каждые ${POLL_INTERVAL_MS / 1000}с (${timeoutMin} мин макс)...`);
  await page.goto(`https://www.emailnator.com/mailbox#${email}`, { timeout: 30000, waitUntil: 'domcontentloaded' });
  try { await page.click('button:has-text("Consent")', { timeout: 3000 }); } catch {}
  await page.waitForTimeout(2000);

  let lastBodyLen = 0;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      try {
        const refreshBtn = page.locator('button:has-text("Refresh"), button:has-text("Обновить")').first();
        if (await refreshBtn.count() > 0) {
          await refreshBtn.click({ timeout: 2000 });
        } else {
          await page.reload({ waitUntil: 'domcontentloaded' });
          try { await page.click('button:has-text("Consent")', { timeout: 1500 }); } catch {}
        }
      } catch {
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
      await page.waitForTimeout(2500);

      const text = await page.locator('body').innerText().catch(() => '');

      if (text.length > lastBodyLen + 50) {
        lastBodyLen = text.length;
        console.log(`[emailnator] 📬 inbox обновился (${text.length} символов)`);

        const messageLocators = page.locator('a, [role="link"], li.message, div.message');
        const count = Math.min(await messageLocators.count(), 10);

        for (let j = 0; j < count; j++) {
          try {
            const ml = messageLocators.nth(j);
            const t = (await ml.innerText().catch(() => '')).toLowerCase();
            if (!t || t.length < 5) continue;
            if (t.includes('emailnator') || t.includes('refresh') || t.includes('consent')) continue;

            await ml.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1500);
            break;
          } catch {}
        }

        const messageText = await page.locator('body').innerText().catch(() => '');

        if (fromHint && !messageText.toLowerCase().includes(fromHint.toLowerCase())) {
          // письмо есть, но не от нужного отправителя — продолжаем ждать
        } else {
          const patterns = [
            /(?:code|код|verify|verification|otp|pin)[^\d]{0,40}(\d{4,8})/i,
            /\b(\d{6})\b/,
            /\b(\d{8})\b/,
            /\b(\d{5})\b/,
            /\b(\d{4})\b/,
          ];

          for (const re of patterns) {
            const m = messageText.match(re);
            if (m) {
              console.log(`[emailnator] 🎉 КОД: ${m[1]}`);
              return m[1];
            }
          }
        }
      }
    } catch (e) {
      console.log(`[emailnator] ⚠️  ${e.message}`);
    }

    process.stdout.write('.');
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  console.log('\n[emailnator] ❌ Письмо не пришло за ' + timeoutMin + ' мин');
  return null;
}

module.exports = { createEmail, pollInbox };
