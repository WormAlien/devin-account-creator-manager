// ourtoken/ourtoken_autoreg.js
//
// Auto-registration for ourtoken.ai — универсальный LLM API-прокси.
// Playwright (channel:chrome) + instanttempemail.com (без почты).
// Регит аккаунт, создаёт API-ключ, сохраняет в ourtoken-sessions.json.
//
// Usage: node ourtoken/ourtoken_autoreg.js [count]
//   count — количество аккаунтов (default 1)

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const ite = require('../freemodel/lib/instanttempemail');

const BASE_URL = 'https://ourtoken.ai';
const API_BASE = 'https://api.ourtoken.ai/v1';
const SESSIONS_FILE = path.join(__dirname, '..', 'routing', 'ourtoken-sessions.json');
const CHROME_PROFILE = path.join(__dirname, 'chrome-profile');

function log(tag, msg) {
  const t = new Date().toISOString().substring(11, 23);
  console.log(`[${t}] [${tag}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateName() {
  const prefixes = ['Alex', 'Sam', 'Jordan', 'Casey', 'Morgan', 'Riley', 'Avery', 'Quinn', 'Chen', 'Max',
    'Leo', 'Kai', 'Nico', 'Luca', 'Mia', 'Zoe', 'Luna', 'Nova', 'Eden', 'Skye'];
  return prefixes[Math.floor(Math.random() * prefixes.length)] +
    String(Math.floor(Math.random() * 9999));
}

function generatePassword(len = 20) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let pw = '';
  for (let i = 0; i < len; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw + 'aA1!';
}

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}

function saveSession(entry) {
  const all = loadSessions();
  all.push(entry);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8');
  log('save', `✓ сохранён: ${entry.email} (***${entry.api_key.slice(-6)})`);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ═══════════════════ MAIN ═════════════════════════════════════════════
async function registerOne(emailAddress, emailToken) {
  const name = generateName();
  const password = generatePassword();
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--window-size=1280,900'],
    });
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    await page.setDefaultTimeout(30000);

    // 1. Go to signup
    log('reg', `регистрация ${name} <${emailAddress}>`);
    await page.goto(`${BASE_URL}/login?mode=signup`, { waitUntil: 'load', timeout: 20000 });
    await sleep(3000);

    // 2. Fill signup form
    // Поля: Name, Email, Password (текстовые поля по accessible name)
    await page.fill('#signup-name', name);
    await page.fill('#signup-email', emailAddress);
    await page.fill('#signup-password', password);

    // 3. Submit — Turnstile вылезет сам
    await page.click('button[type="submit"]');
    log('reg', 'форма отправлена, жду Turnstile…');
    await sleep(3000);

    // 4. Ищем и кликаем Turnstile (может вылезти после submit)
    // Turnstile может быть в iframe или как оверлей на странице
    for (let attempt = 0; attempt < 15; attempt++) {
      const cur = page.url();
      if (!cur.includes('/login')) {
        log('reg', `редирект на ${cur}`);
        break;
      }
      // Ищем iframe с Turnstile и кликаем чекбокс
      const frames = page.frames();
      let clicked = false;
      for (const f of frames) {
        if (f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile')) {
          try {
            // Пробуем разные селекторы для галочки/кнопки
            for (const sel of ['#checkbox', '[role="checkbox"]', '.challenge-container button', 'button', '.frictionless-checkbox', '#cf-chl-widget-*']) {
              const el = f.locator(sel).first();
              if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
                await el.click();
                log('reg', `Turnstile кликнут: ${sel}`);
                clicked = true;
                break;
              }
            }
          } catch {}
        }
      }
      // Если в iframe ничего нет, пробуем кликнуть на сам iframe со страницы
      if (!clicked) {
        const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]');
        if (await turnstileIframe.isVisible().catch(() => false)) {
          await turnstileIframe.click({ position: { x: 150, y: 32 } });
          log('reg', 'клик по центру iframe Turnstile');
          clicked = true;
        }
      }
      if (clicked) {
        await sleep(1500);
        // Ещё раз проверяем URL — мог уйти
        if (!page.url().includes('/login')) break;
      }
      await sleep(2000);
    }

    // 5. Wait for dashboard (redirect from /login to /dashboard or /)
    log('reg', 'жду редирект на дашборд…');
    try {
      await page.waitForURL('**/dashboard**', { timeout: 25000 });
      log('reg', 'редирект на дашборд');
    } catch {
      const cur = page.url();
      log('reg', `текущий URL: ${cur}`);
      if (cur.includes('/login')) {
        const errText = await page.locator('text=error').or(page.locator('[class*="error"]')).first().textContent().catch(() => 'none');
        log('reg', `текст ошибки: ${errText}`);
        throw new Error('Turnstile не пройден или форма не отправилась');
      }
      log('reg', `успех — на странице ${cur}`);
    }
    await sleep(2000);
    log('reg', 'дашборд загружен');

    // 6. Navigate to API keys page
    await page.goto(`${BASE_URL}/api-keys`, { waitUntil: 'load', timeout: 20000 });
    await sleep(2000);

    // 6. Click "Create" button
    await page.click('button:has-text("Create")');
    await sleep(1500);

    // 7. Wait for dialog "API key created" and get the key
    let apiKey = null;
    try {
      const keyEl = page.locator('div[role="dialog"] >> text=/^[A-Za-z0-9_-]{40,}$/');
      await keyEl.first().waitFor({ timeout: 8000 });
      apiKey = await keyEl.first().textContent();
    } catch {
      // Fallback: find any long string in dialog
      const dialogText = await page.locator('div[role="dialog"]').textContent();
      const match = dialogText.match(/[A-Za-z0-9_-]{40,}/);
      if (match) apiKey = match[0];
    }

    if (!apiKey) {
      throw new Error('не удалось извлечь API ключ');
    }
    log('reg', `ключ получен: ***${apiKey.slice(-6)}`);

    // 8. Save account
    saveSession({
      email: emailAddress,
      name,
      api_key: apiKey,
      active: false,
      created: new Date().toISOString(),
    });

    // 9. Close dialog
    try {
      const doneBtn = page.locator('button:has-text("Done")');
      await doneBtn.click();
    } catch {}

    log('reg', '✓ регистрация завершена');
    return apiKey;

  } catch (e) {
    log('reg', `✗ ОШИБКА: ${e.message}`);
    throw e;
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ═══════════════════ CLI ═══════════════════════════════════════════════
async function main() {
  const count = Math.max(1, parseInt(process.argv[2], 10) || 1);
  log('main', `Запуск авторега ourtoken.ai: ${count} аккаунт(ов)`);

  let success = 0;
  for (let i = 0; i < count; i++) {
    log('main', `--- Аккаунт ${i + 1}/${count} ---`);
    try {
      const email = await ite.createEmail();
      log('main', `email: ${email.address} (token: ${email.token.slice(0, 8)}…)`);
      await registerOne(email.address, email.token);
      success++;
    } catch (e) {
      log('main', `пропускаю: ${e.message}`);
    }
    if (i < count - 1) await sleep(3000);
  }

  log('main', `Готово: ${success}/${count} успешно`);
  const sessions = loadSessions();
  log('main', `Всего аккаунтов: ${sessions.length}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { registerOne };
