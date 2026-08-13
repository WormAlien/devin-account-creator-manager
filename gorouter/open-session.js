// gorouter/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта (полный профиль
// на диск: история, куки, localStorage, сессии GitHub + gorouter).
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт (email + ключ), жмёшь 🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем gorouter/profiles/<label>/ (на аккаунт).
//   3. Залогинься в GitHub (в этом же окне), потом зайди на gorouter.app.
//   4. В консоли gorouter возьми API-ключ и вставь его в аккаунт кнопкой 🔑
//      на дашборде (или впиши сразу при добавлении).
//   5. Профиль сохраняется автоматически — при следующих открытиях GitHub и
//      gorouter уже залогинены.
//
// Использование:
//   node gorouter/open-session.js <label>
//     label — имя профиля (папка gorouter/profiles/<label>/)
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания GitHub-логина (первый вход).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SIGN_IN_URL = 'https://gorouter.app/sign-in';
const TWO_FA_URL = 'https://2fa.online/';
const PROFILES_DIR = path.join(__dirname, 'profiles');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const profileDir = path.join(PROFILES_DIR, label);

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной GitHub-логин

// Первый ли запуск профиля: нет файла Default/Preferences → чистый профиль, ждём логин.
function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
}

function hasSessionCookie(cookies) {
  return cookies.some(c => /session|token|access|auth/i.test(c.name) && c.value);
}

// Ждём, пока URL уйдёт со /sign-in И появится кука — это значит GitHub-вход прошёл
// и мы внутри gorouter (консоль/дашборд). Тогда профиль уже сохранён Chromium'ом.
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    const cookies = await context.cookies().catch(() => []);
    const leftSignIn = !url.includes('/sign-in');
    if (leftSignIn && hasSessionCookie(cookies)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();

  console.log(`🚀 Запускаю Chromium (видимый режим)…`);
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен GitHub-логин)' : 'уже есть (сохранённый)'}`);

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(SIGN_IN_URL, { waitUntil: 'domcontentloaded' });
    // Вторая вкладка — 2fa.online (код подтверждения для GitHub-логина).
    const page2 = await context.newPage();
    await page2.goto(TWO_FA_URL, { waitUntil: 'domcontentloaded' });

    if (!fresh) {
      console.log('✅ Профиль восстановлен (GitHub/gorouter уже залогинены, если заходил раньше).');
      console.log('   Браузер открыт (gorouter + 2fa.online) — закрой когда закончишь (Ctrl+C).');
      await new Promise(() => {}); // держим открытым, закрытие — вручную
      return;
    }

    console.log('⚠️  Первый вход. Залогинься в GitHub (кнопка «Продолжить с GitHub»),');
    console.log('   затем зайди на gorouter.app — профиль сохранится автоматически.');

    const ok = await waitForLogin(page, context);
    if (!ok) {
      console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
      process.exit(2);
    }

    console.log('✅ Вход выполнен, профиль сохранён на диск. Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});