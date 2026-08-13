// agentrouter/open-session.js
//
// Открывает консоль agentrouter.org в видимом Chromium под сохранённую сессию.
// Если сессии ещё нет — ждёт ручного логина через GitHub и СОХРАНЯЕТ сессию
// автоматически (без Enter в терминале, как login_and_save_session.js).
// После логина браузер остаётся открытым — можно сразу нажать чек-ин (+$25).
//
// Детект логина: URL дошёл до /console/* И появилась сессионная cookie.
//
// Использование:
//   node agentrouter/open-session.js <label>
//     label — имя сессии (создаст sessions/<label>.json, если нет — залогинься сам)
//   node agentrouter/open-session.js <label> --reuse
//     не сохранять заново, только открыть с существующей сессией
//
// Код возврата 0 = логин/восстановление успешны, 2 = таймаут ожидания логина.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONSOLE_URL = 'https://agentrouter.org/';
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const reuse = process.argv.includes('--reuse');
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const sessionPath = path.join(SESSIONS_DIR, `${label}.json`);

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 минут на ручной GitHub-логин

function hasSessionCookie(cookies) {
  return cookies.some(c => /session|token|access/i.test(c.name) && c.value);
}

async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    const cookies = await context.cookies('https://agentrouter.org').catch(() => []);
    const inConsole = url.includes('/console');
    if (inConsole && hasSessionCookie(cookies)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const haveSession = fs.existsSync(sessionPath);

  console.log(`🚀 Запускаю Chromium (видимый режим)…`);
  console.log(`📂 label: ${label} · сессия: ${haveSession ? 'есть' : 'нет'}${reuse ? ' (reuse)' : ''}`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      ...(haveSession ? { storageState: sessionPath } : {}),
    });
    const page = await context.newPage();
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });

    if (haveSession && reuse) {
      console.log('✅ Сессия восстановлена. Браузер открыт — закрой когда закончишь.');
      await new Promise(() => {}); // держим открытым, закрытие — вручную (Ctrl+C)
      return;
    }

    if (!haveSession) {
      console.log('⚠️  Сессии нет — залогинься через GitHub в открывшемся браузере.');
      console.log('   Сессия сохранится АВТОМАТИЧЕСКИ, как только URL дойдёт до /console.');
    }

    const ok = await waitForLogin(page, context);
    if (!ok) {
      console.error('❌ Таймаут ожидания логина (5 мин). Закрываю.');
      process.exit(2);
    }

    await context.storageState({ path: sessionPath });
    console.log(`✅ Сессия сохранена: ${sessionPath}`);
    console.log('✅ Вход в консоль выполнен (чек-ин +$25 применится). Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
    await new Promise(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});