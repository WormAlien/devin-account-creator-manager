// tabi/open-session.js
//
// Открывает консоль tabitoken.com в видимом Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ
// на аккаунт (полный профиль на диск: куки, localStorage, сессия GitHub).
//
// Сценарий:
//   1. В дашборде нажимаешь 🌐 «Открыть браузер» на карточке аккаунта.
//   2. Открывается Chromium с профилем tabi/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается РЕГИСТРАЦИЯ по рефке владельца.
//      Ключ уже вписан → открывается страница баланса (wallet).
//   4. Профиль сохраняется автоматически — при следующих открытиях tabitoken
//      уже залогинен.
//
// Использование:
//   node tabi/open-session.js <label> [register|console|auto]
//     label — имя профиля (папка tabi/profiles/<label>/)
//     режим — register: регистрация по рефке (у аккаунта ещё нет sk-ключа),
//             console:  страница баланса (ключ уже есть),
//             auto (по умолчанию): чистый профиль = register, иначе console.
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания GitHub-логина (первый вход).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Рефка владельца: аккаунт без ключа регистрируем ТОЛЬКО по ней (реф-бонус +$20).
const REGISTER_URL = 'https://tabitoken.com/sign-up?aff=cUG3';
// Ключ уже вписан → сразу баланс, а не логин.
const CONSOLE_URL = 'https://tabitoken.com/wallet';
// Корень нужен для прогрева перед регистрацией (см. openRegisterViaRef).
const ROOT_URL = 'https://tabitoken.com/';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной GitHub-логин

// Если рядом лежит <label>.json (импортированный чужой share-код) — применяем
// его как storageState: cookies + localStorage. Тогда GitHub/tabitoken сразу залогинены.
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const ss = JSON.parse(raw);
    if (!ss || typeof ss !== 'object') return null;
    return {
      cookies: Array.isArray(ss.cookies) ? ss.cookies : [],
      origins: Array.isArray(ss.origins) ? ss.origins : [],
    };
  } catch { return null; }
}

async function applyImportedSession(context, session) {
  if (!session) return false;
  let applied = false;
  if (session.cookies && session.cookies.length) {
    try {
      await context.addCookies(session.cookies);
      applied = true;
    } catch (e) {
      console.log(`⚠️ часть cookies не применилась: ${e.message}`);
    }
  }
  // localStorage: вставляем addInitScript до goto, чтобы каждый origin получил свои ключи.
  const lsOrigins = (session.origins || []).filter(o => o.localStorage && o.localStorage.length);
  for (const o of lsOrigins) {
    try {
      await context.addInitScript(
        (entries) => { for (const { name, value } of entries) { try { localStorage.setItem(name, value); } catch {} } },
        o.localStorage.map(({ name, value }) => ({ name, value })),
      );
      applied = true;
    } catch { /* origin может быть невалидным — пропускаем */ }
  }
  return applied;
}

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

// Первый GitHub-вход с реф-ссылки регулярно заканчивался ошибкой сайта
// «failed to get user information», и лечилось это руками: вставить реф-ссылку
// заново и обновить страницу. Автоматизируем ровно этот обход.
const AUTH_ERROR_RE = /failed to get user info|无法获取用户信息|не удалось получить (данные|информацию)/i;

async function pageHasAuthError(page) {
  try {
    return AUTH_ERROR_RE.test(await page.evaluate(() => document.body ? document.body.innerText : ''));
  } catch { return false; }
}

// Реф-код сайт хранит в localStorage (ключ `aff`) и переживает уход на другие
// страницы — проверено пробником. Поэтому сначала заходим по реф-ссылке (сажаем
// код в профиль), потом прогреваем корень (SPA поднимается, /api/status и
// cf_clearance оседают), и только потом показываем страницу регистрации.
async function openRegisterViaRef(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const aff = await page.evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } }).catch(() => null);
  console.log(aff ? `🤝 реф-код сохранён в профиль: aff=${aff}` : '⚠️  реф-код не осел в localStorage — регистрация может не зачесться');

  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
}

// После GitHub-логина: обновляем страницу, и если сайт всё-таки ответил
// «failed to get user information» — заходим по реф-ссылке снова (реф-код уже в
// localStorage, кредит не теряется). Два прохода: ошибка транзиентная.
async function settleAfterLogin(page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
    if (!(await pageHasAuthError(page))) return true;
    console.log(`⚠️  сайт ответил «failed to get user information» — повтор ${attempt}/2 по реф-ссылке…`);
    await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return !(await pageHasAuthError(page));
}

// Ждём, пока URL уйдёт со страниц входа/регистрации И появится кука — это значит
// GitHub-вход прошёл и мы внутри tabitoken (консоль/дашборд). Тогда профиль уже
// сохранён Chromium'ом. /sign-up тоже в списке: на нём куки (csrf и прочее) есть
// сразу, иначе «вход выполнен» печаталось бы через полторы секунды после старта.
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    const cookies = await context.cookies().catch(() => []);
    const leftAuth = !/\/sign-in|\/sign-up/.test(url);
    if (leftAuth && hasSessionCookie(cookies)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const imported = loadImportedSession();

  console.log(`🚀 Запускаю Chromium (видимый режим)…`);
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен GitHub-логин)' : 'уже есть (сохранённый)'}`);

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  // Импортированная чужая сессия: подкладываем cookies/localStorage до навигации.
  let appliedSession = false;
  if (fresh && imported) {
    appliedSession = await applyImportedSession(context, imported);
  }

  // Импортированный share-код — аккаунт друга уже зарегистрирован, рефка ему не нужна.
  const wantRegister = appliedSession ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;                                   // 'auto': чистый профиль = регистрация
  console.log(`🎯 ${wantRegister ? `регистрация по рефке: ${REGISTER_URL}` : `баланс: ${CONSOLE_URL}`}`);

  try {
    if (appliedSession) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      console.log('✅ Импортированная сессия применена (GitHub/tabitoken уже залогинены).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await new Promise(() => {}); // держим открытым, закрытие — вручную
      return;
    }

    // Регистрация: ждём логина и добиваем «failed to get user information» ВСЕГДА,
    // а не только на чистом профиле. Первая попытка могла упасть именно так —
    // тогда профиль уже не чистый, а аккаунт всё ещё без ключа.
    if (wantRegister) {
      await openRegisterViaRef(page);
      console.log('⚠️  Регистрация по рефке. Зарегайся через GitHub на открывшейся странице,');
      console.log('   затем возьми ключ в консоли tabitoken и вставь его кнопкой 🔑 в дашборде.');

      const ok = await waitForLogin(page, context);
      if (!ok) {
        console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
        process.exit(2);
      }
      const settled = await settleAfterLogin(page);
      console.log(settled
        ? '✅ Вход выполнен, профиль сохранён на диск. Забирай ключ и вставляй кнопкой 🔑.'
        : '⚠️  Вход прошёл, но сайт всё ещё отдаёт «failed to get user information» — обнови страницу вручную (F5).');
      console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
      await new Promise(() => {});
      return;
    }

    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });

    if (!fresh) {
      console.log('✅ Профиль восстановлен (GitHub/tabitoken уже залогинены, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await new Promise(() => {}); // держим открытым, закрытие — вручную
      return;
    }

    console.log('⚠️  Первый вход. Залогинься в GitHub (кнопка «Продолжить с GitHub»),');
    console.log('   затем возьми ключ в консоли tabitoken и вставь его кнопкой 🔑 в дашборде.');

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
