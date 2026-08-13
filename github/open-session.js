// github/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ на аккаунт GitHub
// (полный профиль на диск: куки, localStorage, сессия GitHub).
//
// Сценарий:
//   1. В дашборде нажимаешь «Открыть GitHub» на карточке аккаунта.
//   2. Открывается Chromium с профилем github/profiles/<label>/ (на аккаунт).
//   3. Если залогинен раньше — GitHub уже входит. Если нет — вводи логин,
//      пароль и 2FA-код с карточки (TOTP в дашборде).
//   4. Профиль сохраняется автоматически — при следующих открытиях GitHub
//      уже залогинен.
//
// Использование:
//   node github/open-session.js <label>
//     label — идентификатор аккаунта (папка github/profiles/<label>/)
//
// Код возврата 0 = открыт, 1 = ошибка.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const GITHUB_LOGIN_URL = 'https://github.com/login';
const PROFILES_DIR = path.join(__dirname, 'profiles');

const labelArg = process.argv[2];
const label = (labelArg || `gh_${Date.now()}`).replace(/[^\w-]/g, '_');
const profileDir = path.join(PROFILES_DIR, label);

function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
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
    await page.goto(GITHUB_LOGIN_URL, { waitUntil: 'domcontentloaded' });

    if (!fresh) {
      console.log('✅ Профиль восстановлен (GitHub уже залогинен, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await new Promise(() => {}); // держим открытым, закрытие — вручную
      return;
    }

    console.log('⚠️  Первый вход. Введи логин, пароль и 2FA-код (код — в дашборде).');
    console.log('   Профиль сохранится автоматически.');
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
