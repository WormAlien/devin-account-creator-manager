// hcnsec/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта (полный профиль на
// диск: история, куки, localStorage, сессия hcnsec).
//
// Панель — тот же New API, что у GoRouter/KKtoken, поэтому механизм взят у
// gorouter/open-session.js без изменений: реф-код в localStorage, кука ЛК, отключённый
// HTTP-кеш, отчёт о белом экране. Отличаются адреса — и путь входа.
//
// 🪤 Главное отличие: у hcnsec НЕТ входа через GitHub. Замер `/api/status` 2026-08-31:
// github_oauth=false, oidc_enabled=false, linuxdo_oauth=false, telegram_oauth=false,
// wechat_login=false. Живой путь один — email + пароль (password_login_enabled=true),
// на регистрации ещё и код на почту (email_verification=true). Поэтому вся машинерия
// GitHub-OAuth из исходника ВЫРЕЗАНА, а не оставлена мёртвой: ждать кнопку, которой
// нет, значит висеть десять минут и соврать в лог «таймаут GitHub-логина». По той же
// причине выкинут gh-live-capture и папка `gh-sessions/` — снимать нечего.
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт (email, ключ можно оставить пустым), жмёшь
//      🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем hcnsec/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается форма РЕГИСТРАЦИИ (реф-ссылки у шлюза
//      нет, см. REGISTER_URL). Ключ уже вписан → открывается страница баланса (wallet).
//   4. Регистрируешься руками: email + пароль + код с почты. Затем в ЛК HCNsec
//      возьми API-ключ и вставь его в аккаунт кнопкой 🔑 на дашборде.
//   5. Профиль сохраняется автоматически — при следующих открытиях hcnsec уже
//      залогинен.
//
// Использование:
//   node hcnsec/open-session.js <label> [register|console|auto]
//     label — имя профиля (папка hcnsec/profiles/<label>/)
//     режим — register: форма регистрации (у аккаунта ещё нет sk-ключа),
//             console:  страница баланса (ключ уже есть),
//             auto (по умолчанию): чистый профиль = register, иначе console.
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания входа (первый вход).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Реф-ссылка — из routing/lib/ref-codes.js, а не литералом: код владельца лежит дефолтом
// в routing/ref-codes.default.json, пользователь вписывает свой через 💩 в «Настройках»
// (routing/ref-codes.json, он в .gitignore). Одна точка на весь репозиторий.
// 🪤 Код появился ПОСЛЕ заведения вкладки: 31.08 вкладку собрали с литеральной ссылкой и
// записью «рефки у этого шлюза нет», а владелец потом принёс свою из кабинета. Панель —
// New API, значит машинерия gorouter'а подходит целиком: код живёт в localStorage `aff`,
// одного захода по ссылке мало, нужна проверка, что он осел (см. openRegisterViaRef).
// Ветки «сайт уехал на GitHub-вход» из исходника ВЫРЕЗАНЫ: github_oauth=false, уезжать
// некуда, и мёртвая проверка только путала бы чтение логов.
const REGISTER_URL = require('../routing/lib/ref-codes.js').url('hcnsec');
// Ключ уже вписан → сразу баланс, а не логин. Роут именно `/wallet` (в бандле панели
// он объявлен как `/_authenticated/wallet/`), как и у gorouter.
const CONSOLE_URL = 'https://api.hcnsec.cn/wallet';
// Корень — источник SITE_HOST для проверки куки ЛК (см. hasSessionCookie).
const ROOT_URL = 'https://api.hcnsec.cn/';
// Публичная конфигурация панели — на ней держится предполётная проверка.
const STATUS_URL = 'https://api.hcnsec.cn/api/status';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной вход почтой

// Окно живёт до Ctrl+C: обещание резолвится только на закрытии контекста. У gorouter
// эту роль играл gh-live-capture.holdOpen() — он попутно вычитывал GitHub-куки; здесь
// вычитывать нечего, поэтому держим окно своими четырьмя строками, а не тянем модуль,
// который на этом шлюзе не имеет смысла.
function holdOpen(context) {
  return new Promise((resolve) => { context.on('close', resolve); });
}

// Если рядом лежит <label>.json — применяем его как storageState: cookies + localStorage.
// Источник у файла один: share-код друга (аккаунт hcnsec уже создан, панель залогинена).
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const ss = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!ss || typeof ss !== 'object') return null;
    // seed:'github' — в файле ТОЛЬКО GitHub-куки, его положил дашборд кнопкой «взять
    // готовый GitHub». Для hcnsec он бесполезен (входа через GitHub нет), но и молча
    // применить его нельзя: ветка ниже приняла бы файл за готовый аккаунт друга и увела
    // на кошелёк аккаунта, которого не существует, — вместо формы регистрации.
    if (ss.seed === 'github') return { ghSeedOnly: true };
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

// Кука ЛК СВОЕГО домена = мы действительно внутри. Проверять «любую куку контекста»
// нельзя: Cloudflare-куки появляются до всякого входа (поймано 2026-08-21 на tabitoken —
// скрипт рапортовал успех, а от сайта в профиле осел только `cf_clearance`).
// `new_api_refresh` (jwt-сборки New API, к ним же относится hcnsec) обязан подходить
// под шаблон — иначе проверка держится на чужих куках целиком.
const SITE_HOST = new URL(ROOT_URL).hostname.toLowerCase();
const CF_COOKIE_RE = /^(cf_clearance|__cf_bm|_cfuvid|cf_chl)/i;
const SITE_SESSION_RE = /session|token|access|auth|refresh|new_api/i;
function hasSessionCookie(cookies) {
  return cookies.some(c => {
    const d = String(c.domain || c.host || '').replace(/^\./, '').toLowerCase();
    if (d !== SITE_HOST && !d.endsWith('.' + SITE_HOST)) return false;
    return !CF_COOKIE_RE.test(c.name) && SITE_SESSION_RE.test(c.name) && !!c.value;
  });
}

// Chromium кеширует и 404-ответы. Если на `/static/js/index-<hash>.js` однажды прилетел
// 404 (деплой панели / затык WAF), он оседает в кеше профиля — и SPA больше не
// поднимается НИКОГДА: на каждом открытии белый экран, хотя куки и логин живые
// (поймано на ar-аккаунтах 2026-08-17, у hcnsec тот же New-API-фронт). Кеш профиля
// чистить вслепую нельзя, поэтому ходим мимо HTTP-кеша: сессия и localStorage на месте.
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
    : '⚠️  белый экран: SPA не поднялась — жми F5, в DevTools ищи 404 на /static/js/*.js');
}

// Предполётная проверка панели вместо угадывания текстов ошибок: New API отдаёт свою
// конфигурацию открыто (`GET /api/status`), поэтому «регистрация закрыта», «вход паролем
// выключен» и «нужен код с почты» мы УЗНАЁМ, а не вылавливаем регэкспом из тоста.
// Здесь это не роскошь, а замена вырезанного GitHub-пути: он был вторым способом войти,
// теперь способ один, и знать заранее, открыт ли он, дороже стоит.
async function preflight() {
  try {
    const r = await fetch(STATUS_URL, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' },
    });
    if (r.status !== 200) return { ok: false, error: `api/status HTTP ${r.status}` };
    const d = ((await r.json()) || {}).data || {};
    return {
      ok: true,
      registration: d.register_enabled !== false && d.password_register_enabled !== false,
      passwordLogin: d.password_login_enabled !== false,
      emailVerify: d.email_verification === true,
      turnstile: d.turnstile_check === true,
      site: d.system_name || 'HCNsec',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Ответ панели, на котором ждать дальше бессмысленно. Осталась ОДНА запись: всё
// остальное в исходнике было про обмен GitHub-кода (потраченный `code`, сбитый
// OAuth-state, «failed to get user information») — на шлюзе без GitHub-входа эти
// регэкспы не могут совпасть никогда, и держать их значило бы врать читателю кода.
const SITE_ERRORS = [
  {
    code: 'no_register',
    terminal: true,
    // `\w` в JS — только ASCII, поэтому русские варианты классом [а-яё], а не \w.
    re: /new (user )?registration (is )?(disabled|closed)|registration (is )?disabled by (the )?admin|(clos|disabl)\w* new (user )?registration|管理员关闭了新用户注册|регистрац[а-яё]* (нов[а-яё]* [а-яё]* )?(закрыт|отключен)|закрыл[а-яё]* регистрацию/i,
    msg: '❌ hcnsec закрыл регистрацию новых аккаунтов (ответ панели) — этот аккаунт создать нельзя.',
  },
];

// Что панель написала на странице прямо сейчас (тосты New API рисуются в DOM).
async function siteError(page) {
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch { return null; }
  return SITE_ERRORS.find(e => e.re.test(text)) || null;
}

// Реф-код панель хранит в localStorage (ключ `aff`), но кода у нас нет — см. REGISTER_URL.
// Поэтому «открыть регистрацию» это ровно одна навигация на форму, без прогрева корня и
// без проверки, осел ли `aff`: проверять нечего.
// Реф-код панель хранит в localStorage (ключ `aff`), и одного захода по реф-ссылке мало:
// на свежем профиле он иногда не оседает с первого раза. Проверяем и, если пусто, греем
// корень и заходим снова — ровно как у gorouter, минус ветки про GitHub-редирект.
async function openRegister(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const readAff = () => page
    .evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } })
    .catch(() => null);

  const aff = await readAff();
  if (aff) {
    console.log(`🤝 реф-код сохранён в профиль: aff=${aff}`);
    return;                       // страница регистрации уже открыта — больше не трогаем
  }

  console.log('⚠️  реф-код не осел с первого раза — прогреваю корень и захожу заново');
  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const aff2 = await readAff();
  console.log(aff2
    ? `🤝 реф-код сохранён в профиль со второй попытки: aff=${aff2}`
    : '⚠️  реф-код так и не осел в localStorage — регистрация может не зачесться');
}

// Ждём, пока URL уйдёт со страниц входа/регистрации И появится кука ЛК — это значит вход
// почтой прошёл и мы внутри панели. Тогда профиль уже сохранён Chromium'ом. Страницы
// подтверждения (`/otp`) и сброса пароля тоже считаются «ещё не внутри»: на них куки
// (csrf и прочее) есть сразу, иначе «вход выполнен» печаталось бы через полторы секунды
// после старта. Попутно читаем ответ панели: «регистрация закрыта» — выходим сразу, а не
// висим десять минут.
const AUTH_PAGE_RE = /\/sign-in|\/sign-up|\/register|\/otp|\/forgot-password|\/reset/;
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const seen = new Set();
  while (Date.now() < deadline) {
    const cookies = await context.cookies().catch(() => []);
    if (!AUTH_PAGE_RE.test(page.url()) && hasSessionCookie(cookies)) return { ok: true };

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

// Подставляем креды в форму входа. Пароль приезжает ПЕРЕМЕННОЙ СРЕДЫ (`HN_LK_PASS`), а не
// аргументом: argv видно в диспетчере задач. Сабмит НЕ нажимаем — у панели включён код на
// почту (`email_verification=true`), и человек всё равно нужен; наша работа — не заставлять
// его вспоминать пароль от девятого шлюза. Форма — SPA, поэтому ждём поля, а не загрузку.
async function prefillLogin(page) {
  const email = String(process.env.HN_LK_EMAIL || '').trim();
  const pass = String(process.env.HN_LK_PASS || '');
  if (!email && !pass) return false;
  try {
    const emailSel = 'input[name="username"], input[name="email"], input[type="email"], input[id*="username" i], input[id*="email" i]';
    const passSel = 'input[name="password"], input[type="password"]';
    await page.waitForSelector(passSel, { timeout: 20000 });
    if (email) {
      const e = page.locator(emailSel).first();
      if (await e.count()) { await e.fill(email); }
    }
    if (pass) {
      const p = page.locator(passSel).first();
      if (await p.count()) { await p.fill(pass); }
    }
    console.log(`🔐 Логин подставлен из записи дашборда${pass ? ' (email и пароль)' : ' (только email — пароля в записи нет)'}.`);
    console.log('   Кнопку входа нажми сам: панель может спросить код с почты.');
    return true;
  } catch (e) {
    // Не нашли форму — это не поломка: возможно, панель уже пустила внутрь.
    console.log(`ℹ️  Поле пароля не найдено (${e.message.split('\n')[0]}) — вход руками.`);
    return false;
  }
}

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const imported = loadImportedSession();
  if (imported && imported.ghSeedOnly) {
    console.log('⚠️  Рядом лежит снимок ТОЛЬКО GitHub-сессии: для hcnsec он бесполезен —');
    console.log('   входа через GitHub у панели нет. Игнорирую файл, регистрируемся почтой.');
  }
  const shared = imported && !imported.ghSeedOnly ? imported : null;

  console.log('🚀 Запускаю Chromium (видимый режим)…');
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен вход почтой)' : 'уже есть (сохранённый)'}`);

  const pre = await preflight();
  if (!pre.ok) {
    console.log(`⚠️  предполётная проверка панели не удалась (${pre.error}) — открываю окно как есть.`);
  } else {
    console.log(`🛰️  ${pre.site}: регистрация ${pre.registration ? 'открыта' : 'ЗАКРЫТА'},`
      + ` вход паролем ${pre.passwordLogin ? 'есть' : 'ВЫКЛЮЧЕН'},`
      + ` код на почту ${pre.emailVerify ? 'нужен' : 'не нужен'},`
      + ` капча ${pre.turnstile ? 'есть' : 'нет'}`);
    if (!pre.registration) {
      console.log('   ❌ Новый аккаунт создать нельзя — панель закрыла регистрацию. Окно всё равно открою.');
    }
    if (!pre.passwordLogin) {
      console.log('   ❌ Вход паролем выключен, а других путей у hcnsec нет (GitHub/OIDC/Telegram отключены).');
    }
  }

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await disableHttpCache(context, page);

  // Импортированная чужая сессия: подкладываем cookies/localStorage до навигации.
  const appliedSession = (fresh && shared) ? await applyImportedSession(context, shared) : false;

  // Импортированный share-код — аккаунт друга уже зарегистрирован, регистрация ему не нужна.
  const wantRegister = appliedSession ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;                                   // 'auto': чистый профиль = регистрация
  console.log(`🎯 ${wantRegister ? `регистрация: ${REGISTER_URL}` : `баланс: ${CONSOLE_URL}`}`);

  try {
    if (appliedSession) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      console.log('✅ Импортированная сессия применена (hcnsec уже залогинен).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    if (wantRegister) {
      await openRegister(page);
      console.log('⚠️  Регистрация почтой: email + пароль + код с почты (GitHub-кнопки тут нет).');
      console.log('   Затем возьми ключ в ЛК HCNsec и вставь его кнопкой 🔑 в дашборде.');
      await prefillLogin(page);

      const res = await waitForLogin(page, context);
      if (!res.ok) {
        if (res.err && res.err.code === 'no_register') {
          console.error('❌ Регистрация на hcnsec закрыта администратором — новый аккаунт не создать.');
          console.error('   Браузер оставляю открытым: ответ панели видно на странице.');
          await holdOpen(context);
          return;
        }
        console.error('❌ Таймаут ожидания входа (10 мин). Закрываю.');
        process.exit(2);
      }
      await reportRender(page);
      console.log('✅ Вход выполнен, профиль сохранён на диск. Забирай ключ и вставляй кнопкой 🔑.');
      console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    // Вход, а не регистрация. У gorouter здесь стоял лишний заход по реф-ссылке: у
    // СВЕЖЕГО профиля аккаунта на шлюзе может ещё не быть, и панель зарегистрирует его
    // прямо на входе — без реф-кода (ровно так у друга ушёл наш реф-кредит на tabitoken
    // 2026-08-21). Здесь этого захода НЕТ, и терять нечего: реф-кода у hcnsec не
    // существует вовсе, а регистрация всё равно требует кода с почты — одним нажатием
    // «вход» она не случится.
    // Незалогиненного панель уведёт с кошелька на `/sign-in` сама — это и есть нужная
    // страница входа, перехватывать редирект незачем.
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });

    if (!fresh) {
      await reportRender(page);
      console.log('✅ Профиль восстановлен (hcnsec уже залогинен, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await holdOpen(context);
      return;
    }

    console.log('⚠️  Первый вход. Залогинься почтой (email + пароль) на открывшейся странице,');
    console.log('   затем возьми ключ в ЛК HCNsec и вставь его кнопкой 🔑 в дашборде.');
    await prefillLogin(page);

    const res = await waitForLogin(page, context);
    if (!res.ok) {
      console.error('❌ Таймаут ожидания входа (10 мин). Закрываю.');
      process.exit(2);
    }

    console.log('✅ Вход выполнен, профиль сохранён на диск. Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
    await holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
