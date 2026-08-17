// gorouter/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта (полный профиль
// на диск: история, куки, localStorage, сессии GitHub + gorouter).
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт (email, ключ можно оставить пустым), жмёшь
//      🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем gorouter/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается РЕГИСТРАЦИЯ по рефке владельца.
//      Ключ уже вписан → открывается страница баланса (wallet).
//   4. В консоли gorouter возьми API-ключ и вставь его в аккаунт кнопкой 🔑
//      на дашборде (или впиши сразу при добавлении).
//   5. Профиль сохраняется автоматически — при следующих открытиях GitHub и
//      gorouter уже залогинены.
//
// Использование:
//   node gorouter/open-session.js <label> [register|console|auto]
//     label — имя профиля (папка gorouter/profiles/<label>/)
//     режим — register: регистрация по рефке (у аккаунта ещё нет sk-ключа),
//             console:  страница баланса (ключ уже есть),
//             auto (по умолчанию): чистый профиль = register, иначе console.
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания GitHub-логина (первый вход).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Рефка владельца: аккаунт без ключа регистрируем ТОЛЬКО по ней (реф-бонус +$5).
const REGISTER_URL = 'https://gorouter.app/sign-up?aff=dzj0';
// Ключ уже вписан → сразу баланс, а не логин.
const CONSOLE_URL = 'https://gorouter.app/wallet';
// Корень нужен для прогрева перед регистрацией (см. openRegisterViaRef).
const ROOT_URL = 'https://gorouter.app/';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной GitHub-логин

// Если рядом лежит <label>.json (импортированный чужой share-код) — применяем
// его как storageState: cookies + localStorage. Тогда GitHub/gorouter сразу залогинены.
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

// Chromium кеширует и 404-ответы. Если на `/assets/index-<hash>.js` однажды прилетел
// 404 (деплой сайта / затык WAF), он оседает в кеше профиля — и SPA больше не
// поднимается НИКОГДА: на каждом открытии белый экран, хотя куки и логин живые
// (поймано на ar-аккаунтах 2026-08-17, у gorouter/tabi тот же NewAPI-фронт).
// Кеш профиля чистить вслепую нельзя, поэтому ходим мимо HTTP-кеша: сессия и
// localStorage остаются на месте. Вешаем и на новые вкладки — GitHub-OAuth
// умеет открываться попапом.
async function disableHttpCache(context, page) {
  const apply = async (p) => {
    try {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch { /* без кеш-бага страница живёт и так — не роняем открытие */ }
  };
  context.on('page', p => { apply(p); });
  await apply(page);
}

// Белый экран должен быть виден в Server Logs, а не только глазами пользователя.
async function reportRender(page) {
  const ok = await page.waitForFunction(
    () => { const r = document.getElementById('root'); return !!r && r.innerHTML.length > 200; },
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  console.log(ok
    ? '✅ страница отрисовалась'
    : '⚠️  белый экран: SPA не поднялась — жми F5, в DevTools ищи 404 на /assets/*.js');
}

// Ответы gorouter (NewAPI) на неудачный GitHub-вход. Раньше скрипт знал только
// «failed to get user information» и на всё остальное молча ждал логин 10 минут —
// пользователь видел «дроч» вместо ответа сайта (2026-08-17).
const SITE_ERRORS = [
  {
    code: 'no_register',
    terminal: true,           // ждать дальше бессмысленно — аккаунт не создать
    // `\w` в JS — только ASCII, поэтому русские варианты классом [а-яё], а не \w.
    re: /new (user )?registration (is )?(disabled|closed)|registration (is )?disabled by (the )?admin|(clos|disabl)\w* new (user )?registration|管理员关闭了新用户注册|регистрац[а-яё]* (нов[а-яё]* [а-яё]* )?(закрыт|отключен)|закрыл[а-яё]* регистрацию/i,
    msg: '❌ gorouter закрыл регистрацию новых аккаунтов (ответ сайта) — этот аккаунт создать нельзя.',
  },
  {
    code: 'git_token',
    re: /failed to fetch git token|failed to (get|fetch) (github )?(access )?token|无法获取 ?GitHub ?(访问)?令牌/i,
    msg: '⚠️  сайт не обменял GitHub-code на токен («failed to fetch git token»): одноразовый code уже потрачен. F5 не лечит — жми «Продолжить с GitHub» заново.',
  },
  {
    code: 'state',
    re: /state parameter is empty or mismatched|state 参数/i,
    msg: '⚠️  OAuth-state не совпал (страницу дёрнули посреди входа) — начни вход заново кнопкой «Продолжить с GitHub».',
  },
  {
    code: 'user_info',
    re: /failed to get user info|无法获取用户信息|не удалось получить (данные|информацию)/i,
    msg: '⚠️  сайт ответил «failed to get user information» — лечится обновлением страницы.',
  },
];

// Что сайт написал на странице прямо сейчас (тосты NewAPI рисуются в DOM).
async function siteError(page) {
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch { return null; }
  return SITE_ERRORS.find(e => e.re.test(text)) || null;
}

// Колбэк GitHub-а: `code` одноразовый, повторный заход/F5 по этому URL сайт
// встречает уже потраченным кодом и отвечает «failed to fetch git token».
const OAUTH_CALLBACK_RE = /\/oauth\/(github|oidc)|[?&]code=/i;

// Реф-код сайт хранит в localStorage (ключ `aff`) и переживает уход на другие
// страницы — проверено пробником. Поэтому сначала заходим по реф-ссылке (сажаем
// код в профиль), потом прогреваем корень (SPA поднимается, /api/status и
// cf_clearance оседают), и только потом показываем страницу регистрации.
async function openRegisterViaRef(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const aff = await page.evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } }).catch(() => null);
  console.log(aff ? `🤝 реф-код сохранён в профиль: aff=${aff}` : '⚠️  реф-код не осел в localStorage — регистрация может не зачесться');

  // Если сайт сам уехал на GitHub-вход (сессия GitHub в профиле уже есть — страница
  // регистрации продолжает вход без нажатий), прогрев корня НЕ делаем: второй goto
  // рвёт OAuth-state, и сайт потом отвечает «State parameter is empty or mismatched»
  // либо «failed to fetch git token». Это и была видимая «дрочь» при клике 🌐.
  if (/github\.com/i.test(page.url())) {
    console.log('↪️  сайт сам ушёл на GitHub-вход — не перебиваем редирект');
    return;
  }

  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (/github\.com/i.test(page.url())) {
    console.log('↪️  сайт сам ушёл на GitHub-вход — не перебиваем редирект');
    return;
  }
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
}

// После GitHub-логина добиваем ошибки сайта. Главное правило: на колбэке OAuth
// (`/oauth/github?code=…`) НИКАКИХ reload — это второй расход одноразового кода,
// ровно из-за него вылезает «failed to fetch git token». С колбэка уходим на
// кошелёк: сессия уже в куках, страница поднимется заново.
async function settleAfterLogin(page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (OAUTH_CALLBACK_RE.test(page.url())) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await page.waitForTimeout(2000);

    const err = await siteError(page);
    if (!err) return true;
    console.log(err.msg);
    if (err.terminal) return false;
    // Реф-код уже в localStorage — заход по рефке кредит не теряет.
    console.log(`   повтор ${attempt}/2 по реф-ссылке…`);
    await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return !(await siteError(page));
}

// Ждём, пока URL уйдёт со страниц входа/регистрации И появится кука — это значит
// GitHub-вход прошёл и мы внутри gorouter (консоль/дашборд). Тогда профиль уже
// сохранён Chromium'ом. /sign-up тоже в списке: на нём куки (csrf и прочее) есть
// сразу, иначе «вход выполнен» печаталось бы через полторы секунды после старта.
// Попутно читаем ответ сайта: «регистрация закрыта» — выходим сразу, а не висим
// 10 минут; про потраченный code и сбитый state пишем по одному разу.
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const seen = new Set();
  while (Date.now() < deadline) {
    const url = page.url();
    const cookies = await context.cookies().catch(() => []);
    const leftAuth = !/\/sign-in|\/sign-up/.test(url);
    if (leftAuth && hasSessionCookie(cookies)) return { ok: true };

    const err = await siteError(page);
    if (err && !seen.has(err.code)) {
      seen.add(err.code);
      console.log(err.msg);
      if (err.terminal) return { ok: false, err };
    }
    await page.waitForTimeout(1500);
  }
  return { ok: false };
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
  await disableHttpCache(context, page);

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
      await reportRender(page);
      console.log('✅ Импортированная сессия применена (GitHub/gorouter уже залогинены).');
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
      console.log('   затем возьми ключ в консоли gorouter и вставь его кнопкой 🔑 в дашборде.');

      const res = await waitForLogin(page, context);
      if (!res.ok) {
        if (res.err && res.err.code === 'no_register') {
          console.error('❌ Регистрация на gorouter закрыта администратором — новый аккаунт не создать.');
          console.error('   Браузер оставляю открытым: ответ сайта видно на странице.');
          await new Promise(() => {});
          return;
        }
        console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
        process.exit(2);
      }
      const settled = await settleAfterLogin(page);
      console.log(settled
        ? '✅ Вход выполнен, профиль сохранён на диск. Забирай ключ и вставляй кнопкой 🔑.'
        : '⚠️  Вход прошёл, но сайт всё ещё отдаёт ошибку (см. строку выше) — дальше руками.');
      console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
      await new Promise(() => {});
      return;
    }

    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });

    if (!fresh) {
      await reportRender(page);
      console.log('✅ Профиль восстановлен (GitHub/gorouter уже залогинены, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await new Promise(() => {}); // держим открытым, закрытие — вручную
      return;
    }

    console.log('⚠️  Первый вход. Залогинься в GitHub (кнопка «Продолжить с GitHub»),');
    console.log('   затем возьми ключ в консоли gorouter и вставь его кнопкой 🔑 в дашборде.');

    const res = await waitForLogin(page, context);
    if (!res.ok) {
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