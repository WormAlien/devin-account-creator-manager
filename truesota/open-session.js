// truesota/open-session.js
//
// Открывает видимый Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ аккаунта TrueSOTA
// (профиль на диск: история, куки, localStorage, сессии GitHub + панели).
//
// Структурно это копия seekai/open-session.js, но панель ДРУГАЯ, и два отличия
// принципиальны — на них держится весь вход:
//
//   1. 🪤 Сессия НЕ в куке. `true-sota.com` — открытый sub2api (Go+Vue), он держит
//      JWT в **localStorage** (`auth_token` + `refresh_token` + `token_expires_at`).
//      Проверка «мы внутри» по куке ЛК, как у New-API, здесь не сработает НИКОГДА:
//      от панели в профиль оседает только `cf_clearance`, и скрипт честно ждал бы
//      GitHub-логин все 10 минут уже ПОСЛЕ успешного входа. Поэтому waitForLogin
//      смотрит localStorage, а кука осталась лишь вторым, необязательным признаком.
//   2. Роуты панели свои: вход `/login`, регистрация `/register`, ключи `/keys`.
//      Реф-код — тот же ключ localStorage `aff` (Vue кладёт туда `?aff=` из query
//      и оттуда же берёт его в `complete-registration` полем `aff_code`).
//
// Сценарий:
//   1. В дашборде добавляешь аккаунт (email, ключ можно оставить пустым), жмёшь
//      🌐 «Открыть браузер».
//   2. Открывается Chromium с профилем truesota/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается РЕГИСТРАЦИЯ (по рефке, если код задан).
//      Ключ уже вписан → открывается страница ключей.
//   4. Вошёл через GitHub → ЗАКРОЙ окно и нажми на вкладке 🔑➕ «Завести ключ»:
//      дашборд сам снимет токен панели с профиля и создаст ключ через её API.
//      Руками ключ тоже можно — кнопкой 🔑, как у остальных вкладок.
//
// Использование:
//   node truesota/open-session.js <label> [register|console|auto]
//
// Код возврата 0 = профиль открыт, 2 = таймаут ожидания GitHub-логина (первый вход).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Реф-ссылка — из routing/lib/ref-codes.js, литерала здесь быть не должно (одна точка
// на весь репозиторий, иначе забытый код = молча потерянный реф-кредит). У TrueSOTA
// дефолтного кода владельца НЕТ, поэтому url() пока отдаёт корень сайта, а не `?aff=`.
const REGISTER_URL = require('../routing/lib/ref-codes.js').url('truesota') === 'https://true-sota.com/'
  ? 'https://true-sota.com/register'
  : require('../routing/lib/ref-codes.js').url('truesota');
// Страница ключей: именно там аккаунт берёт `sk-ts-…`, и там же видно квоту.
const CONSOLE_URL = 'https://true-sota.com/keys';
const ROOT_URL = 'https://true-sota.com/';
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto
const profileDir = path.join(PROFILES_DIR, label);

// Ручной вход в GitHub, сделанный человеком в открытом окне, тоже должен попасть в
// копию сессии — модуль общий с остальными вкладками.
const ghCapture = require('../routing/lib/gh-live-capture.js').makeCapture({
  label,
  moduleDir: __dirname,
  poolFile: path.join(__dirname, '..', 'routing', 'truesota-sessions.json'),
});

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной GitHub-логин

// Если рядом лежит <label>.json — применяем его как storageState: cookies + localStorage.
// Два разных источника такого файла, и различать их обязательно:
//   share-код друга      → аккаунт TrueSOTA уже создан, GitHub/панель сразу залогинены;
//   seed:'github'        → только GitHub-куки, аккаунта на шлюзе ещё НЕТ.
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const ss = JSON.parse(raw);
    if (!ss || typeof ss !== 'object') return null;
    return {
      seed: ss.seed === 'github' ? 'github' : null,
      ghLogin: typeof ss.ghLogin === 'string' ? ss.ghLogin : null,
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
  // localStorage: addInitScript до goto, чтобы каждый origin получил свои ключи.
  // Для TrueSOTA это НЕ мелочь, а сам вход: JWT панели живёт именно здесь.
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

function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
}

// «Мы внутри» = в localStorage панели лежит `auth_token`. Это главное отличие от
// New-API-вкладок: там признаком была кука ЛК, здесь куки от панели вообще нет —
// только `cf_clearance`, который появляется ДО всякого входа и дал бы ложный
// позитив ровно того сорта, что ловили на tabitoken 21.08.
async function panelLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      try { return !!localStorage.getItem('auth_token'); } catch { return false; }
    });
  } catch { return false; }
}

// Chromium кеширует и 404-ответы: однажды прилетевший 404 на `/assets/index-*.js`
// оседает в кеше профиля, и SPA больше не поднимается никогда (белый экран при живых
// куках). Ходим мимо HTTP-кеша, сессия и localStorage при этом остаются.
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
// 🪤 Корень монтирования у sub2api — `#app` (Vue), а не `#root` (React у New-API).
async function reportRender(page) {
  const ok = await page.waitForFunction(
    () => {
      const r = document.getElementById('app') || document.getElementById('root');
      return !!r && r.innerHTML.length > 200;
    },
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  console.log(ok
    ? '✅ страница отрисовалась'
    : '⚠️  белый экран: SPA не поднялась — жми F5, в DevTools ищи 404 на /assets/*.js');
}

// Предполётная проверка панели вместо угадывания текстов ошибок. sub2api отдаёт свою
// конфигурацию открыто (`GET /api/v1/settings/public`), поэтому «регистрация закрыта»
// и «GitHub-входа нет» мы УЗНАЁМ, а не вылавливаем регэкспом из тоста. Так же видно
// капчу и белый список почтовых домнов — из-за него обычная регистрация почтой
// возможна только на gmail/qq/foxmail/linux.do и т.п., и это причина ходить гитхабом.
async function preflight() {
  try {
    const r = await fetch('https://true-sota.com/api/v1/settings/public', {
      signal: AbortSignal.timeout(15000),
      headers: { 'Accept': 'application/json' },
    });
    if (r.status !== 200) return { ok: false, error: `settings/public HTTP ${r.status}` };
    const j = await r.json();
    const d = (j && j.data) || {};
    return {
      ok: true,
      registration: d.registration_enabled !== false,
      github: d.github_oauth_enabled === true,
      turnstile: d.turnstile_enabled === true,
      emailVerify: d.email_verify_enabled === true,
      site: d.site_name || 'TrueSOTA',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Ответы панели на неудачный OAuth. Терминальным считаем только то, что заведомо не
// лечится повтором; остальное — предупреждение, потому что ложное срабатывание тут
// дороже пропущенного (оно рубит живую регистрацию).
const SITE_ERRORS = [
  {
    code: 'state',
    re: /state (parameter )?(is )?(empty|invalid|mismatch)|invalid (oauth )?state|state 参数/i,
    msg: '⚠️  OAuth-state не совпал (страницу дёрнули посреди входа) — начни вход заново кнопкой GitHub.',
  },
  {
    code: 'code_spent',
    re: /(bad_verification_code|code (is )?(already )?(used|expired)|failed to (exchange|fetch).{0,20}(code|token))/i,
    msg: '⚠️  одноразовый GitHub-code уже потрачен: F5 на колбэке не лечит — жми вход через GitHub заново.',
  },
  {
    code: 'oauth_off',
    terminal: true,
    re: /(github )?oauth (login )?(is )?(disabled|not enabled)|oauth 未启用/i,
    msg: '❌ панель отключила вход через GitHub — этим путём аккаунт не создать.',
  },
];

async function siteError(page) {
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch { return null; }
  return SITE_ERRORS.find(e => e.re.test(text)) || null;
}

// Колбэк GitHub-а: `code` одноразовый, повторный заход по этому URL панель встречает
// потраченным кодом.
const OAUTH_CALLBACK_RE = /\/auth\/(oauth\/)?(github\/)?callback|[?&]code=/i;

// Реф-код панель хранит в localStorage под ключом `aff` (тот же, что у New-API), и
// одного захода по реф-ссылке достаточно. Happy path = ОДНА навигация: прыжки
// рефка → корень → рефка пользователь видит как «дрочь», и они же рвут OAuth-state.
async function openRegisterViaRef(page) {
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const readAff = () => page
    .evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } })
    .catch(() => null);

  const aff = await readAff();
  if (aff) {
    console.log(`🤝 реф-код сохранён в профиль: aff=${aff}`);
    return;
  }
  // Без кода в ссылке это норма, а не сбой: у TrueSOTA дефолтной рефки владельца нет.
  if (!/[?&]aff=/.test(REGISTER_URL)) {
    console.log('ℹ️  реф-код для TrueSOTA не задан — регистрация идёт без рефки.');
    console.log('   Свой код (после создания первого аккаунта) вписывается в дашборде: Настройки → 💩.');
    return;
  }

  console.log('⚠️  реф-код не осел с первого раза — прогреваю корень и захожу заново');
  if (/github\.com/i.test(page.url())) {
    console.log('↪️  панель сама ушла на GitHub-вход — не перебиваем редирект');
    return;
  }
  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (/github\.com/i.test(page.url())) {
    console.log('↪️  панель сама ушла на GitHub-вход — не перебиваем редирект');
    return;
  }
  await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const aff2 = await readAff();
  console.log(aff2
    ? `🤝 реф-код сохранён в профиль со второй попытки: aff=${aff2}`
    : '⚠️  реф-код так и не осел в localStorage — регистрация может не зачесться');
}

// Ждём, пока в localStorage появится `auth_token`. Дополнительно смотрим ответы
// панели: терминальную ошибку печатаем один раз и выходим, а не висим 10 минут.
async function waitForLogin(page) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const seen = new Set();
  while (Date.now() < deadline) {
    if (await panelLoggedIn(page)) return { ok: true };
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

// После входа уводим с колбэка на страницу ключей: reload на колбэке — второй расход
// одноразового кода, ровно из-за него панель отвечает про потраченный code.
async function settleAfterLogin(page) {
  if (OAUTH_CALLBACK_RE.test(page.url())) {
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForTimeout(1500);
  const err = await siteError(page);
  if (err) { console.log(err.msg); return false; }
  return true;
}

async function main() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  const imported = loadImportedSession();

  console.log('🚀 Запускаю Chromium (видимый режим)…');
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен GitHub-логин)' : 'уже есть (сохранённый)'}`);

  const pre = await preflight();
  if (pre.ok) {
    console.log(`🛰️  панель ${pre.site}: регистрация ${pre.registration ? 'открыта' : 'ЗАКРЫТА'},`
      + ` GitHub-вход ${pre.github ? 'есть' : 'ВЫКЛЮЧЕН'}`
      + `${pre.turnstile ? ', капча Turnstile включена' : ''}`
      + `${pre.emailVerify ? ', почта требует подтверждения' : ''}`);
    if (!pre.github) {
      console.log('   ⚠️  без GitHub-входа остаётся только регистрация почтой: домен из белого списка + код на почту + капча.');
    }
  } else {
    console.log(`⚠️  предполётную конфигурацию панели не прочитал (${pre.error}) — работаю как обычно`);
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await disableHttpCache(context, page);

  let appliedSession = false;
  if (fresh && imported) appliedSession = await applyImportedSession(context, imported);

  const seededGithub = appliedSession && imported && imported.seed === 'github';
  if (seededGithub) {
    console.log(`🐙 GitHub-сессия заселена${imported.ghLogin ? ` (${imported.ghLogin})` : ''} — пароль и 2FA не понадобятся, жми вход через GitHub.`);
  }

  const wantRegister = (appliedSession && !seededGithub) ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;
  console.log(`🎯 ${wantRegister ? `регистрация: ${REGISTER_URL}` : `ключи аккаунта: ${CONSOLE_URL}`}`);

  try {
    // Импортированный share-код — аккаунт уже есть, рефка не нужна, сразу на ключи.
    if (appliedSession && !seededGithub) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      console.log(await panelLoggedIn(page)
        ? '✅ Импортированная сессия применена (панель залогинена).'
        : '⚠️  Сессию применили, но токена панели в ней нет — войди через GitHub в открытом окне.');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    // Заход по реф-ссылке нужен и в режиме «вход», если аккаунта на шлюзе ещё нет:
    // панель создаст его прямо на GitHub-входе, и БЕЗ реф-кода. Условие — «токена
    // панели нет», а не «профиль свежий»: после неудачной попытки профиль уже не
    // свежий, а аккаунта по-прежнему нет (эти грабли ловили на tabitoken 21.08).
    if (wantRegister || fresh || !(await panelLoggedIn(page))) {
      await openRegisterViaRef(page);
      if (!wantRegister) {
        console.log('ℹ️  аккаунта на шлюзе может ещё не быть — зашёл через регистрацию, чтобы рефка не потерялась');
      }
    }
    if (!wantRegister && !/github\.com/i.test(page.url()) && await panelLoggedIn(page)) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      console.log('✅ Профиль восстановлен (панель залогинена).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    console.log('⚠️  Войди через GitHub на открывшейся странице.');
    console.log('   Потом ЗАКРОЙ это окно и нажми на вкладке TrueSOTA кнопку 🔑➕ «Завести ключ» —');
    console.log('   дашборд снимет токен панели с профиля и создаст ключ сам (пока окно открыто, профиль заперт).');

    const res = await waitForLogin(page);
    if (!res.ok) {
      if (res.err && res.err.terminal) {
        console.error('❌ Панель отказала терминально (см. строку выше). Браузер оставляю открытым.');
        await ghCapture.holdOpen(context);
        return;
      }
      console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
      process.exit(2);
    }
    const settled = await settleAfterLogin(page);
    console.log(settled
      ? '✅ Вход выполнен, профиль сохранён на диск. Закрывай окно и жми 🔑➕ на вкладке.'
      : '⚠️  Вход прошёл, но панель отдаёт ошибку (см. строку выше) — дальше руками.');
    console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
    await ghCapture.holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
