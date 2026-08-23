// agentrouter/open-session.js
//
// Открывает консоль agentrouter.org в видимом Chromium с ПЕРСОНАЛЬНЫМ ПРОФИЛЕМ
// на аккаунт (полный профиль на диск: куки, localStorage, сессия GitHub).
//
// Сценарий:
//   1. В дашборде нажимаешь 🌐 «Открыть браузер» на карточке аккаунта.
//   2. Открывается Chromium с профилем agentrouter/profiles/<label>/ (на аккаунт).
//   3. Ключа у аккаунта ещё нет → открывается РЕГИСТРАЦИЯ по рефке владельца.
//      Ключ уже вписан → открывается страница баланса/пополнения.
//   4. Профиль сохраняется автоматически — при следующих открытиях agentrouter
//      уже залогинен (можно сразу жать чек-ин +$25).
//
// Если рядом лежит <label>.json (импортированный чужой share-код) — применяем его
// как storageState (cookies + localStorage), тогда GitHub/agentrouter сразу залогинены.
//
// Использование:
//   node agentrouter/open-session.js <label> [register|console|auto|checkin|autocheckin]
//     label — имя профиля (папка agentrouter/profiles/<label>/)
//     режим — register:    регистрация по рефке (у аккаунта ещё нет sk-ключа),
//             console:     страница баланса/пополнения (ключ уже есть),
//             checkin:     разлогин + страница входа (забрать суточные +$25 руками),
//             autocheckin: то же, но вход через GitHub скрипт делает САМ и закрывается,
//             auto (по умолчанию): чистый профиль = register, иначе console.
//
// Коды возврата: 0 = готово (оба чек-ин-режима печатают маркер AUTOCHECKIN_RESULT {...}),
//   2 = таймаут ожидания GitHub-логина, 3 = GitHub-сессия в профиле мертва (нужен
//   ручной вход, пароль и 2FA автоматика не вводит), 4 = не нашёл, чем начать
//   GitHub-вход, 5 = шлюз отверг OAuth (state/код), 1 = прочая ошибка.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Рефка владельца: аккаунт без ключа регистрируем ТОЛЬКО по ней (реф-бонус +$100).
// Реф-ссылка — из routing/lib/ref-codes.js, а не литералом: код владельца лежит
// дефолтом в routing/ref-codes.default.json, пользователь вписывает свой через 💩 в
// «Настройках» дашборда (routing/ref-codes.json, он в .gitignore). Одна точка на весь
// репозиторий: раньше код был в десяти местах, и забытое = потерянный реф-кредит.
const REGISTER_URL = require("../routing/lib/ref-codes.js").url("agentrouter");
// Ключ уже вписан → сразу баланс/пополнение, а не корень сайта.
const CONSOLE_URL = 'https://agentrouter.org/console/topup';
// Корень нужен для прогрева перед регистрацией (см. openRegisterViaRef).
const ROOT_URL = 'https://agentrouter.org/';
// Чек-ин +$25 капает раз в сутки только после ПОВТОРНОГО входа через GitHub, поэтому
// режим checkin гасит сессию и ставит браузер на страницу входа.
const LOGIN_URL = 'https://agentrouter.org/login';
// Роут разлогина у New-API не задокументирован. С 2026-08-22 он не основной путь, а
// фолбэк: сначала выходим через меню профиля в шапке (см. uiLogout), как это делает
// человек. Прямой заход сюда навигацией оставлен на случай, если шапка переедет.
const LOGOUT_URL = 'https://agentrouter.org/api/user/logout';
// Пункт «выйти» в дропдауне аватара. UI сайта китайский (退出), но пул языков держим
// шире: шлюз уже менял локаль страницы входа, и селектор по одному языку — мина.
const LOGOUT_MENU_RE = /退出|登出|注销|logout|log ?out|sign ?out|выйти|выход/i;
const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной GitHub-логин
// Автоподарку человек не нужен: клик, редиректы GitHub-а и колбэк укладываются
// в считанные секунды. Полторы минуты — с запасом на медленный WAF.
const AUTO_LOGIN_TIMEOUT_MS = 90 * 1000;

const labelArg = process.argv[2];
const label = (labelArg || `ar_${Date.now()}`).replace(/[^\w-]/g, '_');
const mode = String(process.argv[3] || 'auto'); // register | console | auto | checkin | autocheckin
const profileDir = path.join(PROFILES_DIR, label);

// Ручной вход в GitHub, сделанный человеком в открытом окне, тоже должен попасть в копию
// сессии — до 2026-08-22 копия снималась один раз, при открытии, и ручной вход терялся.
const ghCapture = require('../routing/lib/gh-live-capture.js').makeCapture({
  label,
  moduleDir: __dirname,
  poolFile: path.join(__dirname, '..', 'routing', 'agentrouter-sessions.json'),
});

// Если рядом лежит <label>.json — применяем его как storageState: cookies + localStorage.
// Два разных источника такого файла, и различать их обязательно:
//   share-код друга      → аккаунт agentrouter уже создан, GitHub/agentrouter сразу залогинены;
//   seed:'github'        → только GitHub-куки, аккаунта agentrouter ещё НЕТ (см. seededGithub).
function loadImportedSession() {
  try {
    const p = path.join(SESSIONS_DIR, label + '.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const ss = JSON.parse(raw);
    if (!ss || typeof ss !== 'object') return null;
    return {
      // seed:'github' — в файле ТОЛЬКО GitHub-куки, аккаунта провайдера ещё нет: файл
      // положил дашборд по кнопке «взять готовый GitHub». Отличать обязательно, иначе
      // ветка ниже примет его за готовый аккаунт друга, уведёт на страницу баланса и
      // пропустит регистрацию по рефке — реф-кредит потеряется.
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

// Кука ЛК СВОЕГО домена = мы действительно внутри. Раньше проверялась любая кука
// контекста, и это давало ложный позитив: после заселения GitHub-сессии в профиле
// сразу лежит `user_session` от github.com — waitForLogin возвращал true мгновенно и
// печатал «Вход выполнен», хотя на сайт мы не вошли. Поймано 2026-08-21 на tabitoken:
// скрипт отрапортовал успех, а в профиле от сайта осел только `cf_clearance`.
// Cloudflare-куки в зачёт не идут — они появляются до всякого входа. И отдельно:
// `new_api_refresh` (jwt-инстансы tabi/xpeach) под старый regexp не подходил ВООБЩЕ,
// то есть у половины провайдеров проверка держалась на чужих куках целиком.
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

// Chromium кеширует и 404-ответы. Если на `/assets/index-<hash>.js` однажды прилетел
// 404 (деплой сайта / затык WAF), он оседает в кеше профиля — и SPA больше не
// поднимается НИКОГДА: на каждом открытии белый экран, хотя куки и логин живые
// (поймано на двух ar-аккаунтах, 2026-08-17). Кеш профиля чистить нельзя вслепую,
// поэтому ходим мимо HTTP-кеша: сессия и localStorage остаются на месте.
// Вешаем и на новые вкладки — GitHub-OAuth умеет открываться попапом.
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
  const readAff = () => page
    .evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } })
    .catch(() => null);

  // Happy path — ОДНА навигация. Код оседает с первого захода, и прыжки
  // рефка → корень → рефка пользователь видел как метание страницы; они же
  // рвали OAuth-state, если сайт успевал уехать на GitHub-вход сам.
  const aff = await readAff();
  if (aff) {
    console.log(`🤝 реф-код сохранён в профиль: aff=${aff}`);
    return;
  }

  console.log('⚠️  реф-код не осел с первого раза — прогреваю корень и захожу заново');
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
  await page.waitForTimeout(1500);
  const aff2 = await readAff();
  console.log(aff2
    ? `🤝 реф-код сохранён в профиль со второй попытки: aff=${aff2}`
    : '⚠️  реф-код так и не осел в localStorage — регистрация может не зачесться');
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

// Ждём, пока GitHub-вход пройден и появился auth-cookie на agentrouter.org —
// значит мы внутри консоли. Профиль в этот момент уже сохраняется Chromium'ом на диск.
// Страницу регистрации/логина в зачёт не берём: на ней куки (csrf и прочее) есть сразу,
// иначе «вход выполнен» печаталось бы через полторы секунды после старта.
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    const cookies = await context.cookies('https://agentrouter.org').catch(() => []);
    const leftAuth = !/\/register|\/login|\/sign-in|\/sign-up/.test(url);
    if (url.includes('agentrouter.org') && leftAuth && hasSessionCookie(cookies)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

// ───── Автоподарок: вход через GitHub без человека ────────────────────────
// Разведка живой страницы (2026-08-22, Playwright + бандл assets/index-*.js):
//
//   async function v7(clientId, mode = "login") {          // обработчик кнопки
//     const state = await b7(mode);                         // GET /api/oauth/state?aff=…&mode=login
//     state && (localStorage.setItem("oauth_mode", mode),
//       window.open(`https://github.com/login/oauth/authorize?client_id=${clientId}&state=${state}&scope=user:email`))
//   }
//
// Отсюда три вывода, на которых держится вся ветка autocheckin:
//   1. Кнопка входа — <button> с подписью «使用 GitHub 继续» (UI сайта китайский) и
//      иконкой .semi-icon-github_logo. Селектор по тексту «Continue with GitHub»
//      не сработал бы никогда; в подвале сидят ещё две ссылки на github.com —
//      берём только BUTTON.
//   2. Клик открывает ПОПАП: GitHub-вход и колбэк /oauth/github?code=… уезжают
//      туда, исходная вкладка остаётся на /login. window.opener сайт не трогает.
//      Поэтому ждать успех по page.url() исходной вкладки нельзя (см. ниже).
//   3. Колбэк идёт в /api/oauth/github?code=…&state=…&mode=login, и в ответе
//      шлюз САМ сообщает, налил ли суточный бонус: data.checked_in. Это честнее
//      любого угадывания по росту выдачи — его и отдаём в дашборд.
const OAUTH_API_RE = /\/api\/oauth\/github/i;

// Тело ответа читаем через перехват, а не в обработчике 'response': к моменту, когда
// resp.json() доберётся до тела, SPA уже уводит страницу на /console/token, тело
// выбрасывается и мы молча остаёмся без checked_in (так и было в первом прогоне).
// route.fetch() буферизует ответ у нас, fulfill отдаёт его странице — одноразовый
// `code` при этом расходуется РОВНО один раз.
function watchOauthResult(context) {
  const out = { seen: false, success: null, checkedIn: null, message: '', userId: null };
  context.route(OAUTH_API_RE, async (route) => {
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      try {
        const j = JSON.parse(body);
        out.seen = true;
        out.success = !!j.success;
        out.message = String(j.message || '');
        out.checkedIn = !!(j.data && j.data.checked_in);
        // id пользователя нужен для заголовка New-Api-User: в localStorage его пишет
        // колбэк-компонент, а мы к тому моменту уже закрываем попап — своя копия надёжнее.
        out.userId = (j.data && j.data.id) || null;
        // 🪤 quota/used_quota в колбэке ЕСТЬ, но они ОБНУЛЕНЫ. Проверено живым прогоном
        // 2026-08-22 на аккаунте с $175: `checked_in: true` приехало верное, а
        // `quota: 0, used_quota: 0`. То есть шлюз отдаёт на входе урезанный объект
        // пользователя (в списке полей при этом видны и password, и access_token —
        // дело не в санитайзе целиком, обнулена именно квота).
        // Поэтому балансом из колбэка пользоваться НЕЛЬЗЯ: он выглядит как настоящая
        // цифра, а записал бы в пул $0 — с вышибанием активного аккаунта
        // (moneyKickOnZero) и сломанным детектом чек-ина (granted стал бы нулём).
        // Из колбэка берём только два факта: зачтён ли бонус и id пользователя.
        if (j.data) console.log(`🧾 колбэк отдал поля: ${Object.keys(j.data).join(',')}`);
        console.log(out.success
          ? `🔑 шлюз принял GitHub-вход${out.checkedIn ? ', суточный чек-ин зачтён' : ' — чек-ин НЕ зачтён (окно ещё не сменилось)'}`
          : `⚠️  шлюз отверг вход: ${out.message || 'без причины'}`);
      } catch { /* не json (заглушка WAF) — решит /api/user/self */ }
      await route.fulfill({ response: resp, body });
    } catch (e) {
      // Перехват не должен ломать вход: не смогли прочитать — пропускаем как есть.
      console.log(`⚠️  ответ колбэка прочитать не удалось (${e.message})`);
      await route.continue().catch(() => {});
    }
  }).catch(() => {});
  return out;
}

// GitHub-стена: логин, пароль, 2FA, подтверждение устройства. Сюда попадаем, когда
// сессия в профиле мертва. `login/oauth/…` в стену НЕ входит — это нормальный шаг
// OAuth, поэтому negative lookahead обязателен.
const GH_AUTH_WALL_RE = /github\.com\/(login(?!\/oauth)|session\b|sessions\/)/i;

// Фолбэк на случай, если кнопки на странице нет или попап не открылся: собираем тот
// же authorize-URL руками. client_id читаем из живого /api/status (хардкодить нельзя —
// шлюз может пересоздать OAuth-приложение), `aff` подставляем как сайт, иначе
// регистрация нового аккаунта потеряла бы реф-кредит.
async function buildAuthorizeUrl(page) {
  try {
    return await page.evaluate(async () => {
      const get = async (u) => (await fetch(u, { credentials: 'include' })).json();
      const st = await get('/api/status');
      const cid = st && st.data && st.data.github_client_id;
      if (!cid) return null;
      let q = '/api/oauth/state?mode=login';
      const aff = localStorage.getItem('aff');
      if (aff) q += '&aff=' + encodeURIComponent(aff);
      const s = await get(q);
      const state = s && s.success && s.data;
      if (!state) return null;
      localStorage.setItem('oauth_mode', 'login');
      return `https://github.com/login/oauth/authorize?client_id=${cid}&state=${state}&scope=user:email`;
    });
  } catch (e) {
    console.log(`⚠️  authorize-URL собрать не удалось: ${e.message}`);
    return null;
  }
}

// Шлюз встречает модалкой «系统公告» (14 объявлений) поверх формы входа. Playwright
// честно ждал, пока она уйдёт: клик по кнопке GitHub упирался в .semi-modal-wrap,
// перебирал попытки и в итоге уходил в фолбэк (поймано на третьем прогоне 2026-08-22).
// Гасим сами: Escape, если не помог — крестик.
async function dismissModals(page) {
  for (let i = 0; i < 3; i++) {
    const wrap = page.locator('.semi-modal-wrap').first();
    if (!(await wrap.isVisible().catch(() => false))) return;
    if (i === 0) console.log('🪧 закрываю модалку объявлений — она перекрывает кнопку входа');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
    if (!(await wrap.isVisible().catch(() => false))) return;
    const x = page.locator('.semi-modal-close').first();
    if (await x.count().catch(() => 0)) await x.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
  }
}

// Возвращает страницу, на которой пойдёт GitHub-часть (попап или та же вкладка),
// либо null — значит начать вход нечем.
async function clickGithubLogin(context, page) {
  await dismissModals(page);
  const byIcon = page.locator('button:has(.semi-icon-github_logo)').first();
  const byText = page.locator('button').filter({ hasText: /github/i }).first();
  let target = null;
  // Ждать обязательно: reportRender возвращается, как только #root не пуст, а кнопки
  // сторонних входов SPA дорисовывает позже — в первом прогоне их «не было».
  for (const cand of [byIcon, byText]) {
    const ok = await cand.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    if (ok) { target = cand; break; }
  }

  if (target) {
    const popupP = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await target.click({ timeout: 5000 }).catch(e => console.log(`⚠️  клик по кнопке GitHub не прошёл: ${e.message}`));
    const popup = await popupP;
    if (popup) {
      console.log('🪟 попап GitHub-входа открылся');
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      return popup;
    }
    console.log('⚠️  попап не появился — собираю authorize-URL сам');
  } else {
    console.log('⚠️  кнопки входа через GitHub на странице нет — собираю authorize-URL сам');
  }

  const url = await buildAuthorizeUrl(page);
  if (!url) return null;
  console.log('↪️  иду на GitHub authorize в этой же вкладке');
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  return page;
}

// Проводим попап через GitHub-часть. Возвращаем, чем всё кончилось: dead — сессия
// мертва (дальше идти некуда), authorized — нажали согласие на доступ приложению,
// callback — GitHub уже вернул на шлюз, closed — попап закрылся сам (это норма:
// SPA колбэка могла успеть отработать).
async function passGithubGate(gh) {
  for (let i = 0; i < 25; i++) {
    if (gh.isClosed()) return 'closed';
    const url = gh.url();
    if (/agentrouter\.org/i.test(url)) return 'callback';
    if (GH_AUTH_WALL_RE.test(url)) return 'dead';
    if (/github\.com\/login\/oauth\/authorize/i.test(url)) {
      const btn = gh.locator('button[name="authorize"]').first();
      const n = await btn.count().catch(() => 0);
      if (n > 0) {
        console.log('🔓 GitHub просит подтвердить доступ приложению — жму Authorize (один раз)');
        await btn.click({ timeout: 5000 }).catch(e => console.log(`⚠️  Authorize не нажался: ${e.message}`));
        return 'authorized';
      }
    }
    await gh.waitForTimeout(700).catch(() => {});
  }
  return 'unknown';
}

// Успех входа определяем ПО ОТВЕТУ ШЛЮЗА на колбэк, а не по наличию куки. Ловушка,
// стоившая первого прогона (2026-08-22): `/api/oauth/state` сам ставит куку с именем
// `session` (в ней сервер держит state OAuth), она проходит по hasSessionCookie — и
// «вход выполнен» печаталось ДО того, как GitHub вообще вернулся. Скрипт тут же уводил
// вкладку на консоль и обрывал летящий запрос колбэка: сессия так и не создавалась,
// точный баланс потом отвечал «сессия профиля недействительна (HTTP 401)».
//
// Запасной признак — прямой вопрос /api/user/self. Одной куки ему НЕ достаточно:
// New-API требует ещё заголовок `New-Api-User` с id пользователя (тем же способом
// ходит наш точный чек, см. newapi-account.js). id лежит в localStorage['user'],
// который колбэк-компонент пишет после успешного входа — а localStorage у попапа и
// исходной вкладки общий, домен один.
async function siteSelfOk(page, userId = null) {
  if (page.isClosed()) return null;
  return await page.evaluate(async (uidArg) => {
    try {
      let uid = uidArg;
      if (!uid) { try { uid = (JSON.parse(localStorage.getItem('user') || 'null') || {}).id; } catch {} }
      if (!uid) return null;
      const r = await fetch('/api/user/self', { credentials: 'include', headers: { 'New-Api-User': String(uid) } });
      const j = await r.json();
      if (!j || !j.success || !j.data) return null;
      // Отдаём СЫРЫЕ поля шлюза: их же читает дашборд с диска (selfToBalance в
      // newapi-account.js), и делить на quota_per_unit тут нельзя — множитель живёт
      // в /api/status и у разных инстансов New-API отличается.
      return { quota: j.data.quota, used: j.data.used_quota, id: j.data.id, username: j.data.username };
    } catch { return null; }
  }, userId).catch(() => null);
}

// Объект пользователя, который SPA кладёт в localStorage после входа. Ноль запросов к
// шлюзу: читаем то, что страница уже получила. Имена полей печатаем — состав шлюз меняет.
async function readStoredUser(page) {
  if (page.isClosed()) return null;
  return await page.evaluate(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      if (!u || typeof u !== 'object') return null;
      return { keys: Object.keys(u), quota: u.quota, used: u.used_quota, id: u.id, username: u.username };
    } catch { return null; }
  }).catch(() => null);
}

// ───── Точный остаток: перехват вместо своего запроса ─────────────────────
// Страница на кошельке сама ходит в /api/user/self — это и есть цифра, которую видит
// глаз. Перехватываем ЕЁ ответ: своего запроса к шлюзу не добавляется вообще, а WAF тут
// ни при чём (запрос всё равно был бы). route.fetch() буферизует тело у нас, fulfill
// отдаёт его странице — приём тот же, что с колбэком OAuth.
const SELF_API_RE = /\/api\/user\/self/i;

// 🪤 Перехват копит ответы за ВСЮ жизнь браузера, а в режиме чек-ина первый из них
// приезжает ДО подарка: uiLogout заходит на страницу кошелька ещё залогиненным, и
// кабинет честно спрашивает /api/user/self со старым остатком. Дальше вход, подарок —
// и если пост-логиновый ответ окажется заглушкой WAF или придёт со старой цифрой,
// `out.last` так и останется предподарочным. Дашборд ставит эту цифру как точную
// (arAutoCheckinFinish), то есть подарок «не считается» ровно так, как жалуется владелец.
// Поэтому у перехвата есть reset(): предподарочные ответы забываются, и снимок берётся
// только из того, что приехало ПОСЛЕ входа.
function watchSelfResponses(context) {
  const out = {
    last: null, seen: 0, stubs: 0,
    reset() { this.last = null; this.seen = 0; this.stubs = 0; },
  };
  context.route(SELF_API_RE, async (route) => {
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      out.seen++;
      try {
        const j = JSON.parse(body);
        const d = j && j.data;
        if (j && j.success && d && typeof d.quota === 'number') {
          out.last = { quota: d.quota, used: Number(d.used_quota) || 0, id: d.id != null ? d.id : null, username: d.username || null };
        }
      } catch {
        // HTTP 200 + HTML — заглушка Aliyun WAF. Ровно на ней падает и наш чек с диска:
        // «WAF-заглушка (слишком часто), пауза 10 мин» в newapi-account.js.
        out.stubs++;
      }
      await route.fulfill({ response: resp, body });
    } catch (e) {
      await route.continue().catch(() => {});
    }
  }).catch(() => {});
  return out;
}

// Снимок годен, только если в нём есть ЧЕМ распорядиться. Нули отбиваем: именно так
// выглядел обнулённый ответ колбэка, и он бы записал в пул $0 (см. watchOauthResult).
function selfSnapshotUsable(s) {
  return !!s && typeof s.quota === 'number' && isFinite(s.quota)
    && (s.quota > 0 || Number(s.used) > 0);
}

// Цифра «до подарка». Шлюз наливает бонус на `quota`, не двигая `used_quota`, поэтому
// сравнение по остатку тут законно: подарок обязан поднять quota выше предподарочной.
// Считаем устаревшим и РАВЕНСТВО: именно так выглядит кабинет, который надо обновить.
function selfIsPreGift(s, baseline, expectGrowth) {
  return !!(expectGrowth && baseline && s && Number(s.quota) <= Number(baseline.quota));
}

// Обновление страницы после подарка — не косметика, а единственный способ увидеть новую
// цифру: кабинет спрашивает /api/user/self один раз на загрузку, а колбэк OAuth квоту
// отдаёт обнулённой (см. watchOauthResult). Руками владелец жмёт F5 — здесь то же самое.
// Перезагружаем, пока не приедет ответ со ВЫРОСШЕЙ квотой, но не больше трёх раз: шлюз
// за Aliyun WAF на залп отвечает заглушкой, и лишние круги дороже неточной цифры.
const GIFT_RELOAD_ATTEMPTS = 3;
const GIFT_SELF_WAIT_MS = 12000;

async function reloadForFreshSelf(page, selfWatch, baseline, expectGrowth) {
  if (!selfWatch) return;
  const show = s => `$${(s.quota / 500000).toFixed(2)}`;
  for (let attempt = 1; attempt <= (expectGrowth ? GIFT_RELOAD_ATTEMPTS : 1); attempt++) {
    selfWatch.reset();
    // На URL колбэка перезагружаться нельзя — `code` одноразовый (см. OAUTH_CALLBACK_RE),
    // поэтому туда уходим навигацией на кошелёк.
    if (/agentrouter\.org\/console/i.test(page.url())) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    else await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

    const deadline = Date.now() + GIFT_SELF_WAIT_MS;
    while (Date.now() < deadline) {
      const s = selfWatch.last;
      if (selfSnapshotUsable(s) && !selfIsPreGift(s, baseline, expectGrowth)) {
        console.log(`🔄 после обновления страницы кабинет отдал ${show(s)}`
          + (baseline ? ` (было ${show(baseline)})` : '') + ` — круг ${attempt}`);
        return;
      }
      await page.waitForTimeout(500).catch(() => {});
    }
    const s = selfWatch.last;
    if (s && selfIsPreGift(s, baseline, expectGrowth)) {
      console.log(`⏳ кабинет всё ещё показывает предподарочные ${show(s)} — обновляю ещё раз (${attempt}/${GIFT_RELOAD_ATTEMPTS})`);
    } else if (!s) {
      console.log(`⏳ годного /api/user/self после обновления не дождался (${attempt}/${expectGrowth ? GIFT_RELOAD_ATTEMPTS : 1})`);
    } else {
      return;
    }
  }
}

// Точный остаток БЕЗ повторного обращения к шлюзу нашим клиентом. Источники по порядку:
//
//   1. перехваченный ответ САМОЙ страницы (watchSelfResponses) — ноль лишних запросов;
//   2. localStorage['user'] — то же, но разобранное SPA; работает и в ручном режиме;
//   3. свой fetch из страницы — последний резерв. Это запрос БРАУЗЕРА, а не нашего
//      клиента: клиентской паузы coolDownHost на нём нет, но заглушку WAF он поймать
//      может (проверено живьём 2026-08-22 — кабинет с живой сессией показывал $0.00).
//
// Снимок уезжает в маркер AUTOCHECKIN_RESULT: дашборд ставит цифру как есть, вместо того
// чтобы после закрытия окна идти за ней второй раз через куки профиля с диска.
// Делитель 500000 здесь только для ЛОГА — в маркер уходит сырая quota, а на доллары её
// переводит бэкенд по quota_per_unit своего инстанса (см. newapi-account.js).
//
// `baseline` + `expectGrowth` отбивают предподарочную цифру во ВСЕХ трёх источниках:
// localStorage кабинет заполняет из той же загрузки страницы, что и перехват, поэтому
// без проверки фолбэк вернул бы ровно ту цифру, которую мы только что отвергли.
async function captureSelfSnapshot(page, oauth, selfWatch, baseline = null, expectGrowth = false) {
  const show = s => `$${(s.quota / 500000).toFixed(2)} (потрачено $${((s.used || 0) / 500000).toFixed(2)})`;
  const stale = s => selfIsPreGift(s, baseline, expectGrowth);

  if (selfWatch) {
    console.log(`🛰️  запросов /api/user/self через страницу: ${selfWatch.seen}`
      + (selfWatch.stubs ? `, из них заглушек WAF: ${selfWatch.stubs}` : '')
      + (selfWatch.last ? '' : ' — годного ответа среди них нет'));
  }
  if (selfWatch && selfSnapshotUsable(selfWatch.last) && !stale(selfWatch.last)) {
    console.log(`💰 на счету ${show(selfWatch.last)} — перехвачено у самой страницы, лишних запросов ноль`);
    return { ...selfWatch.last, from: 'page-self' };
  }

  const ls = await readStoredUser(page);
  if (ls) console.log(`🗃️  localStorage['user'] отдал поля: ${ls.keys.join(',')}`);
  if (selfSnapshotUsable(ls) && !stale(ls)) {
    console.log(`💰 на счету ${show(ls)} — цифра из localStorage страницы, лишних запросов ноль`);
    return { quota: ls.quota, used: ls.used || 0, id: ls.id, username: ls.username, from: 'localStorage' };
  }

  const self = await siteSelfOk(page, (oauth && oauth.userId) || (ls && ls.id) || null);
  if (selfSnapshotUsable(self) && !stale(self)) {
    console.log(`💰 на счету ${show(self)} — цифра своим запросом из страницы`);
    return { ...self, from: 'self-fetch' };
  }
  // Отдать предподарочную цифру как точную нельзя: дашборд пометит чек-ин забранным и
  // покажет остаток БЕЗ подарка (arAutoCheckinFinish ставит marker.self как есть).
  // Пусть лучше он посчитает сам — там подарок доедет со следующим чеком баланса.
  const anyStale = [selfWatch && selfWatch.last, ls, self].find(s => selfSnapshotUsable(s) && stale(s));
  if (anyStale) {
    console.log(`⚠️  все источники отдают предподарочные ${show(anyStale)} — цифру НЕ отправляю,`
      + ' иначе дашборд запишет остаток без подарка. Баланс он пересчитает сам.');
    return null;
  }
  console.log('⚠️  годной цифры со страницы нет (перехват / localStorage / свой запрос) —'
    + ' дашборд посчитает баланс сам, как раньше');
  return null;
}

async function waitForSiteSession(context, page, timeoutMs, oauth, pollMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (oauth && oauth.seen && oauth.success === false) return { ok: false, rejected: true, message: oauth.message };
    // Ответ колбэка — самое надёжное: его нам отдал сам шлюз.
    if (oauth && oauth.seen && oauth.success === true) return { ok: true };
    // Дешёвый предфильтр: пока на домене нет ни одной сессионной куки, спрашивать
    // /api/user/self незачем. Шлюз за Aliyun WAF — лишний трафик тут наказуем
    // (залп чек-инов уже гасил точный баланс всему пулу на 10 минут).
    const cookies = await context.cookies('https://agentrouter.org').catch(() => []);
    if (hasSessionCookie(cookies) && await siteSelfOk(page)) return { ok: true };
    await page.waitForTimeout(pollMs).catch(() => {});
  }
  return { ok: false, rejected: false };
}

// ───── Резервная копия GitHub-сессии профиля ─────────────────────────────
// GitHub-куки — самое дорогое, что есть в профиле: вход обратно должен стоить один клик
// «Continue with GitHub», а у авторегов пароля и 2FA под рукой может не быть вообще.
// Поэтому перед КАЖДЫМ разлогином снимаем копию на диск. Копия нужна не только от нашего
// кода: GitHub сам гасит сессию, если тем же аккаунтом вошли в другом месте (и тем более
// если по нему стучались сырыми запросами) — тогда следующий чек-ин восстановит её отсюда.
// В файле лежат сессионные секреты — каталог в .gitignore, значения в лог не пишем.
const GH_BACKUP_DIR = path.join(__dirname, 'gh-sessions');

function ghBackupPath(lbl) {
  return path.join(GH_BACKUP_DIR, lbl + '.json');
}

function isGithubCookie(c) {
  const d = String(c.domain || '').replace(/^\./, '');
  return d === 'github.com' || d.endsWith('.github.com');
}

// Сохраняем только куки с ненулевым сроком: сессионные (expires ≤ 0) всё равно умирают
// вместе с браузером, и восстанавливать их бессмысленно.
function saveGhBackup(lbl, cookies) {
  const keep = cookies.filter(c => isGithubCookie(c) && c.expires > 0);
  if (!keep.length) return 0;
  try {
    fs.mkdirSync(GH_BACKUP_DIR, { recursive: true });
    fs.writeFileSync(ghBackupPath(lbl), JSON.stringify({ savedAt: new Date().toISOString(), cookies: keep }, null, 2) + '\n', 'utf8');
    return keep.length;
  } catch (e) {
    console.log(`⚠️  копию GitHub-сессии сохранить не удалось: ${e.message}`);
    return 0;
  }
}

// Только не истёкшие: просроченную куку Chromium примет и молча выбросит, а в логе
// это выглядело бы как «восстановил», хотя вход всё равно попросит пароль.
function loadGhBackup(lbl) {
  try {
    const j = JSON.parse(fs.readFileSync(ghBackupPath(lbl), 'utf8'));
    const now = Date.now() / 1000;
    return { savedAt: j.savedAt, cookies: (j.cookies || []).filter(c => c.expires > now) };
  } catch { return null; }
}

// Копия свежей GitHub-сессии после успешного входа/открытия ЛК. Именно этот снимок
// потом вернёт чек-ин, если GitHub погасит сессию сам. Пустую копию не пишем — иначе
// один заход с уже мёртвым GitHub затёр бы годную.
async function backupGhAfterLogin(context) {
  const gh = await context.cookies('https://github.com').catch(() => []);
  const n = saveGhBackup(label, gh);
  if (n) console.log(`🐙 копия GitHub-сессии обновлена (${n} кук) — чек-ин сможет её вернуть`);
}

// Сразу после входа сайт любит отдать «未登录或登录已过期» / «failed to get user info» —
// это транзиентное: SPA поднялась на данных погашенной сессии. Лечится тем же, чем при
// регистрации, — перезагрузкой. Два прохода, потом просто говорим правду.
const CHECKIN_STALE_RE = /未登录|登录已过期|not logged in|failed to get user info/i;
// Колбэк GitHub-а: `code` одноразовый, повторный заход по этому URL сайт встречает
// уже потраченным кодом и отвечает «failed to fetch git token». Приём из
// gorouter/open-session.js: с колбэка не перезагружаемся, а уходим на консоль.
const OAUTH_CALLBACK_RE = /\/oauth\/(github|oidc)|[?&]code=/i;

async function settleAfterCheckin(page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (!CHECKIN_STALE_RE.test(txt) && !AUTH_ERROR_RE.test(txt)) return true;
    console.log(`⚠️  сайт показывает «сессия истекла» — обновляю страницу (${attempt}/2)…`);
    if (OAUTH_CALLBACK_RE.test(page.url())) await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1800);
  }
  const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const bad = CHECKIN_STALE_RE.test(txt) || AUTH_ERROR_RE.test(txt);
  if (bad) console.log('⚠️  сообщение осталось — вход всё равно прошёл (кука есть), баланс проверится с диска.');
  return !bad;
}

// Тихий вариант reportRender: дождаться, что SPA нарисовалась. Нужен там, где белый
// экран не диагноз, а просто «ещё рано искать элемент». Ждать обязательно: HTTP-кеш у нас
// выключен намеренно (см. disableHttpCache), бандл и /api/user/self тянутся заново на
// каждом запуске, и шапки с аватаром в первые секунды в DOM нет вообще — на этом первый
// прогон UI-выхода и сорвался в фолбэк.
async function waitSpaReady(page, ms) {
  return page.waitForFunction(
    () => { const r = document.getElementById('root'); return !!r && r.innerHTML.length > 200; },
    { timeout: ms },
  ).then(() => true).catch(() => false);
}

// Подписка на ответ роута разлогина. Вешать ДО клика: сайт зовёт его сам, и другого
// надёжного признака выхода у нас нет (см. uiLogout — куку сервер не отзывает).
function watchLogoutAck(page) {
  const out = { seen: false, ok: false };
  const onResp = async (r) => {
    if (out.seen || !/\/api\/user\/logout/i.test(r.url())) return;
    out.seen = true;
    try {
      const j = JSON.parse(await r.text());
      out.ok = !!j.success;
    } catch { out.ok = r.status() === 200; }
  };
  page.on('response', onResp);
  return { out, off: () => page.off('response', onResp) };
}

// Убрать куки СВОЕГО домена через CDP. После UI-выхода они уже мертвы на сервере, но на
// диске остаются — а точный баланс дашборд читает по кукам профиля и принял бы мёртвую
// `session` за живую сессию (тот же ложный позитив, что с `user_session` у GitHub).
// Ровно перечисленные имена, чужих домены не касаемся — почему не clearCookies, см. apiLogout.
async function purgeSiteCookies(context, page) {
  const ck = await context.cookies('https://agentrouter.org').catch(() => []);
  if (!ck.length) return 0;
  let n = 0;
  try {
    const cdp = await context.newCDPSession(page);
    for (const k of ck) {
      await cdp.send('Network.deleteCookies', { name: k.name, domain: k.domain, path: k.path || '/' });
      n++;
    }
    await cdp.detach().catch(() => {});
  } catch { /* не вышло — не беда, сессия и так погашена сервером */ }
  return n;
}

// Выход через меню профиля — основной путь с 2026-08-22 (просьба владельца).
// Раньше скрипт сразу удалял куки домена, и в окне это выглядело так: белая страница
// JSON-роута, потом сайт с руганью «не авторизован», и только потом форма входа. Клик по
// аватару делает то же самое руками сайта: сессию гасит его собственный обработчик, на
// /login SPA уезжает клиентским роутом (бандл заново не грузится), лишнего экрана с
// ошибкой не появляется вообще. GitHub-кук этот путь не касается совсем.
//
// Селекторы сняты с живой страницы 2026-08-22 (профиль acct_ar_1787282231931_14):
// аватар в шапке — единственный .semi-avatar внутри <button> (semi-avatar-extra-small,
// буква логина); дропдаун — .semi-dropdown-content с четырьмя <li>: 个人设置 / API令牌 /
// 钱包 / 退出. Ищем по тексту, а не по позиции: порядок пунктов шлюз уже менял.
//
// ⚠️ ПРИЗНАК УСПЕХА — ОТВЕТ РОУТА, А НЕ ПРОПАЖА КУКИ. Замерено там же: сайт зовёт
// GET /api/user/logout, получает {"success":true}, чистит localStorage.user и уезжает на
// /login — но `Set-Cookie` в ответе НЕТ, и `session` остаётся в браузере (значение то же,
// на сервере уже мёртвое). Первый прогон ждал пропажи куки, не дождался и honestly ушёл
// в фолбэк с удалением кук, хотя выход прошёл. Мёртвую куку убираем сами, но уже после —
// не как способ разлогина, а чтобы не оставлять на диске ложный признак живой сессии.
async function uiLogout(context, page) {
  await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const before = await context.cookies('https://agentrouter.org').catch(() => []);
  if (!hasSessionCookie(before)) {
    console.log('🚪 сессии сайта в профиле и не было — выходить не из чего');
    return true;
  }
  await dismissModals(page);
  await waitSpaReady(page, 25000);
  await dismissModals(page);

  const avatar = page.locator('button:has(.semi-avatar)').first();
  const shown = await avatar.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  if (!shown) {
    console.log(`⚠️  аватара в шапке не нашёл (url=${page.url()}, кнопок с аватаром ${await page.locator('button:has(.semi-avatar)').count().catch(() => '?')})`);
    return false;
  }

  const ack = watchLogoutAck(page);
  try {
    await avatar.click({ timeout: 5000 }).catch(e => console.log(`⚠️  клик по аватару не прошёл: ${e.message}`));
    const item = page.locator('.semi-dropdown-content li, .semi-dropdown-item').filter({ hasText: LOGOUT_MENU_RE }).first();
    const hasItem = await item.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
    if (!hasItem) { console.log('⚠️  в меню профиля нет пункта выхода'); return false; }
    await item.click({ timeout: 5000 }).catch(e => console.log(`⚠️  клик по «выйти» не прошёл: ${e.message}`));

    const until = Date.now() + 8000;
    while (!ack.out.seen && Date.now() < until) await page.waitForTimeout(200);
  } finally {
    ack.off();
  }

  if (!ack.out.ok) {
    console.log(ack.out.seen ? '⚠️  шлюз не подтвердил выход' : '⚠️  сайт так и не позвал роут разлогина');
    return false;
  }
  const purged = await purgeSiteCookies(context, page);
  console.log(`🚪 вышел через меню профиля — шлюз подтвердил${purged ? `, мёртвых кук убрано ${purged}` : ''}; GitHub-куки не тронуты`);
  return true;
}

// Фолбэк: погасить сессию, не считаясь с версткой сайта. Раньше это был основной путь.
//
// Порядок важен: сначала best-effort logout на сервере (пока куки ещё живые), потом
// удаляем куки домена — это и есть гарантия разлогина, не зависящая от роутов сайта.
//
// ⚠️ ПОЧЕМУ CDP, А НЕ context.clearCookies({domain}) — ловушка, стоившая GitHub-сессии
// (2026-08-20, аккаунт lankymapping). Фильтр в Playwright реализован как «снести ВЕСЬ
// cookie-store и переставить обратно то, что не подошло под фильтр». В ПАМЯТИ всё
// правильно (лог честно печатал «GitHub 4/4 на месте»), но удаление ложится в SQLite
// профиля сразу, а переставленные куки — лениво. Пользователь закрывает окно браузера
// (или процесс убивают) до флаша — и GitHub-кук на диске больше НЕТ.
// Замерено на чистых профилях: clearCookies-фильтр → GitHub 0/3 на диске,
// Network.deleteCookies → GitHub 3/3. CDP удаляет ровно названные записи и чужих
// не касается вообще, поэтому терять нечего.
// localStorage не трогаем: там реф-код `aff`, к сессии он не относится.
async function apiLogout(context, page, ghBefore) {
  await page.goto(LOGOUT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(800);

  const total = (await context.cookies('https://agentrouter.org').catch(() => [])).length;
  const deleted = await purgeSiteCookies(context, page);
  if (total && !deleted) {
    // Последний резерв — НЕ clearCookies(): он снёс бы GitHub (см. выше). Лучше
    // оставить пользователя разлогиниться руками, чем потерять вход одним кликом.
    console.log('⚠️  удалить куки через CDP не удалось — GitHub трогать не буду.');
    console.log('   Разлогинься на странице сам: аватар в шапке → 退出.');
  }
  const arLeft = (await context.cookies('https://agentrouter.org').catch(() => [])).length;
  console.log(`🚪 куки agentrouter.org: удалено ${deleted}/${total}, осталось ${arLeft}${arLeft === 0 ? ' — сессия погашена' : ' (разлогинься вручную)'}`);
  await restoreGithubIfLost(context, ghBefore);
}

// Чек-ин +$25: гасим сессию agentrouter и ставим браузер на страницу входа.
// Сначала по-человечески (меню профиля), и только если шапка не поддалась — грубым
// путём через удаление кук.
async function doCheckinLogout(context, page) {
  const ghBefore = (await context.cookies('https://github.com').catch(() => []));
  const saved = saveGhBackup(label, ghBefore);
  console.log(`🐙 GitHub-сессия: ${ghBefore.length} кук в профиле${saved ? `, копия сохранена (${saved} долгоживущих)` : ', сохранять нечего'}`);

  if (!(await uiLogout(context, page))) {
    console.log('↪️  выход через меню не вышел — гашу сессию удалением кук');
    await apiLogout(context, page, ghBefore);
  }

  // После клиентского роута мы, скорее всего, уже на /login — тогда навигация лишняя
  // и стоит секунду загрузки бандла заново.
  if (!/\/login\b/.test(page.url())) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await reportRender(page);
}

// Страховка: сверяем GitHub-куки по ИМЕНАМ (а не по количеству — так видно, что именно
// пропало) и возвращаем недостающие. Сначала из снимка «до», потом из копии на диске:
// второй случай — когда GitHub погасил сессию сам, ещё до нашего разлогина.
async function restoreGithubIfLost(context, ghBefore) {
  const after = await context.cookies('https://github.com').catch(() => []);
  const have = new Set(after.map(c => c.name));
  let missing = ghBefore.filter(c => !have.has(c.name));

  if (!missing.length) {
    const bk = loadGhBackup(label);
    if (!after.length && bk && bk.cookies.length) {
      console.log(`🐙 GitHub-кук в профиле нет — восстанавливаю из копии от ${bk.savedAt}`);
      missing = bk.cookies;
    } else {
      console.log(`🐙 GitHub-куки: ${after.length}/${ghBefore.length} на месте — вход одним кликом`);
      return;
    }
  } else {
    console.log(`⚠️  пропали GitHub-куки: ${missing.map(c => c.name).join(', ')} — возвращаю`);
  }

  try {
    await context.addCookies(missing);
    const fixed = await context.cookies('https://github.com').catch(() => []);
    const ok = fixed.some(c => c.name === 'user_session');
    console.log(`🐙 GitHub-куки возвращены в открытый браузер: ${fixed.length}${ok ? ' (user_session на месте — вход одним кликом)' : ' — ⚠️ user_session нет, вход попросит пароль/2FA'}`);
    // Возврат — это ВСТАВКА, а Chromium пишет вставки в SQLite лениво: закроешь окно
    // сразу — на диске их может не оказаться. Это не страшно, потому что источник
    // истины — копия на диске: следующий чек-ин восстановит заново из неё же.
    console.log('   (копия остаётся на диске — если закроешь окно слишком быстро, следующий чек-ин вернёт её снова)');
  } catch (e) {
    console.log(`⚠️  вернуть GitHub-куки не удалось (${e.message}) — войди в GitHub вручную, копия лежит в ${ghBackupPath(label)}`);
  }
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

  // Чек-ин идёт раньше всего остального: импортированные куки и рефка тут не при чём,
  // задача ровно одна — разлогинить и войти заново. `autocheckin` отличается тем, что
  // вход жмёт скрипт, а не человек.
  if (mode === 'checkin' || mode === 'autocheckin') {
    const auto = mode === 'autocheckin';
    // Подписку на ответ колбэка вешаем ДО клика и на КОНТЕКСТ, а не на страницу:
    // колбэк уедет в попап, которого сейчас ещё нет.
    const oauth = auto ? watchOauthResult(context) : null;
    // Перехват self — тоже до навигации и в обоих режимах: страница кошелька запросит
    // остаток сама, и это единственный способ узнать цифру, ничего не спрашивая заново.
    const selfWatch = watchSelfResponses(context);
    try {
      console.log(auto
        ? '⚡ Автоподарок: гашу сессию и вхожу через GitHub сам.'
        : '🎁 Чек-ин +$25: гашу сессию и открываю вход.');
      await doCheckinLogout(context, page);
      // Цифра «до подарка»: uiLogout заходил на кошелёк ещё залогиненным, и кабинет там
      // спросил /api/user/self сам. Она нужна не как результат, а как ЭТАЛОН — по ней
      // видно, обновился ли кабинет после подарка. Сразу забываем перехваченное: с этого
      // момента годным считается только то, что приедет после входа.
      const baseline = selfSnapshotUsable(selfWatch.last) ? { ...selfWatch.last } : null;
      if (baseline) console.log(`📌 до подарка на счету $${(baseline.quota / 500000).toFixed(2)} — эталон для проверки обновления`);
      else console.log('📌 предподарочную цифру снять не удалось — проверять рост будет нечем');
      selfWatch.reset();

      if (auto) {
        // Живость GitHub-сессии смотрим ПО КУКАМ ПРОФИЛЯ. Сырой пробник на github.com
        // запрещён: фейковый UA GitHub считает угоном и гасит сессию (три штуки уже
        // так потеряли, см. routing/lib/github-session.js).
        const gh = await context.cookies('https://github.com').catch(() => []);
        if (!gh.some(c => c.name === 'user_session' && c.value)) {
          console.error('❌ GitHub-сессия в профиле мертва (нет user_session).');
          console.error('   Пароль и 2FA автоматика не вводит: возьми 🐙 «готовый GitHub» заново или войди руками кнопкой 🎁.');
          await context.close().catch(() => {});
          process.exit(3);
        }

        const target = await clickGithubLogin(context, page);
        if (!target) {
          console.error('❌ Не нашёл, чем начать GitHub-вход: кнопки нет, authorize-URL не собрался.');
          console.error('   Похоже, шлюз переделал страницу входа. Добери бонус кнопкой 🎁 — там вход жмёт человек.');
          await context.close().catch(() => {});
          process.exit(4);
        }

        const gate = await passGithubGate(target);
        if (gate === 'dead') {
          console.error('❌ GitHub попросил пароль/2FA — сессия в профиле уже не годится.');
          console.error('   Возьми 🐙 «готовый GitHub» заново или войди руками кнопкой 🎁.');
          await context.close().catch(() => {});
          process.exit(3);
        }
        console.log(`🔄 GitHub-часть: ${gate}`);

        const res = await waitForSiteSession(context, page, AUTO_LOGIN_TIMEOUT_MS, oauth, 2000);
        if (!res.ok && res.rejected) {
          console.error(`❌ Шлюз отверг OAuth: ${res.message || 'без причины'}. Бонус не забран.`);
          await context.close().catch(() => {});
          process.exit(5);
        }
        if (!res.ok) {
          console.error('❌ Вход не подтвердился за 90 с. Бонус не забран — попробуй ещё раз или добери кнопкой 🎁.');
          await context.close().catch(() => {});
          process.exit(2);
        }

        // Попап больше не нужен, а на его URL лежит одноразовый code — трогать его
        // навигацией нельзя, только закрыть.
        if (target !== page && !target.isClosed()) await target.close().catch(() => {});
        await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      } else {
        console.log('   Жми «Continue with GitHub» — GitHub-сессия в профиле осталась, пароль и 2FA не нужны.');

        // Ждём, пока пользователь войдёт обратно. Дальше — САМИ закрываем браузер, и это
        // не косметика: Chromium пишет НОВЫЕ куки в SQLite профиля лениво, а точный баланс
        // читается именно с диска (см. newapi-account.js). Пока окно открыто, свежей куки
        // на диске нет — и чек честно откатывался на прикидку с «в профиле нет куки».
        // Корректное закрытие гарантирует флаш, поэтому после входа окно больше не нужно:
        // за ним пришли ровно за одним кликом.
        // Ждём по куке контекста, а не по URL этой вкладки: сайт уводит GitHub-вход в
        // попап, и вкладка так и остаётся на /login — проверка по URL давала бы ложный
        // таймаут «не дождался входа» при фактически забранном бонусе.
        const res = await waitForSiteSession(context, page, LOGIN_TIMEOUT_MS, null);
        if (!res.ok) {
          console.error('❌ Не дождался входа (10 мин). Закрываю — бонус не забран, зайди ещё раз.');
          await context.close().catch(() => {});
          process.exit(2);
        }
      }
      await settleAfterCheckin(page);
      // Подарок налит, а кабинет об этом ещё не знает: /api/user/self он спрашивает один
      // раз на загрузку страницы, и цифра в окне меняется только после F5 (жалоба
      // владельца 2026-08-23). Делаем этот F5 сами — иначе в маркер уехал бы остаток БЕЗ
      // подарка, и дашборд поставил бы его как точный.
      //
      // Роста требуем только когда его обещал САМ шлюз (`checked_in: true` в колбэке):
      // при `false` (окно ещё не сменилось) остаток законно равен предподарочному, и
      // ждать роста значило бы выбросить верную цифру.
      const expectGrowth = !!(auto && oauth && oauth.seen && oauth.checkedIn === true);
      await reloadForFreshSelf(page, selfWatch, baseline, expectGrowth);
      // Точную цифру снимаем ЗДЕСЬ, пока браузер жив и стоит на балансе: /api/user/self
      // отвечает сессии САМОЙ страницы. Это тот же ответ, за которым дашборд после
      // закрытия окна лез бы во второй раз — расшифровывая куки профиля с диска и
      // стучась к шлюзу за Aliyun WAF (именно этот запрос ловит рейт-лимит и роняет
      // точный баланс всего пула на 10 минут). Снимок уезжает в маркер, дашборд ставит
      // цифру как есть; не снялся — старый путь остаётся фолбэком.
      const selfSnap = await captureSelfSnapshot(page, auto ? oauth : null, selfWatch, baseline, expectGrowth);
      await backupGhAfterLogin(context);
      console.log('✅ Вход выполнен. Закрываю браузер, чтобы куки легли на диск —');
      console.log('   без этого следующий чек баланса не найдёт в профиле живой сессии.');
      await context.close().catch(() => {});
      // Маркер печатают ОБА режима: цифра, снятая со страницы, одинаково избавляет
      // дашборд от повторного чека, кто бы ни жал кнопку входа — скрипт или человек.
      // checkedIn = слово ШЛЮЗА про суточный бонус (только auto, в ручном режиме
      // колбэк не перехватываем); null — решает бэкенд по росту выдачи, как раньше.
      console.log(`AUTOCHECKIN_RESULT ${JSON.stringify({
        checkedIn: auto && oauth && oauth.seen ? !!oauth.checkedIn : null,
        message: (auto && oauth && oauth.message) || '',
        self: selfSnap,
      })}`);
      console.log(selfSnap
        ? '🎁 Готово. Баланс снят со страницы — дашборд поставит цифру и 📦 сам, жать 💰 не нужно.'
        : '🎁 Готово, но цифру со страницы снять не удалось — дашборд пересчитает баланс сам, как раньше.');
      process.exit(0);
    } catch (e) {
      await context.close().catch(() => {});
      throw e;
    }
  }

  // Импортированная чужая сессия: подкладываем cookies/localStorage до навигации.
  let appliedSession = false;
  if (fresh && imported) {
    appliedSession = await applyImportedSession(context, imported);
  }

  // Заселение готового GitHub — аккаунта у провайдера ещё нет, рефка НУЖНА.
  const seededGithub = appliedSession && imported && imported.seed === 'github';
  if (seededGithub) {
    console.log(`🐙 GitHub-сессия заселена${imported.ghLogin ? ` (${imported.ghLogin})` : ''} — пароль и 2FA не понадобятся, жми «Continue with GitHub».`);
  }

  // Импортированный share-код — аккаунт друга уже зарегистрирован, рефка ему не нужна.
  const wantRegister = (appliedSession && !seededGithub) ? false
    : mode === 'register' ? true
    : mode === 'console' ? false
    : fresh;                                   // 'auto': чистый профиль = регистрация
  console.log(`🎯 ${wantRegister ? `регистрация по рефке: ${REGISTER_URL}` : `баланс: ${CONSOLE_URL}`}`);

  try {
    if (appliedSession && !seededGithub) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
      await reportRender(page);
      console.log('✅ Импортированная сессия применена (GitHub/agentrouter уже залогинены).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    // Регистрация: ждём логина и добиваем «failed to get user information» ВСЕГДА,
    // а не только на чистом профиле. Первая попытка могла упасть именно так —
    // тогда профиль уже не чистый, а аккаунт всё ещё без ключа.
    if (wantRegister) {
      await openRegisterViaRef(page);
      console.log('⚠️  Регистрация по рефке. Зарегайся через GitHub на открывшейся странице,');
      console.log('   потом возьми ключ в консоли и вставь его кнопкой 🔑 в дашборде.');

      const ok = await waitForLogin(page, context);
      if (!ok) {
        console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
        process.exit(2);
      }
      const settled = await settleAfterLogin(page);
      await backupGhAfterLogin(context);
      console.log(settled
        ? '✅ Вход выполнен, профиль сохранён на диск. Забирай ключ и вставляй кнопкой 🔑.'
        : '⚠️  Вход прошёл, но сайт всё ещё отдаёт «failed to get user information» — обнови страницу вручную (F5).');
      console.log('   Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context);
      return;
    }

    // Вход, а не регистрация. Но у СВЕЖЕГО/заселённого профиля аккаунта у провайдера
    // может ещё не быть — тогда сайт создаст его прямо на GitHub-входе, и БЕЗ реф-кода.
    // Ровно так у друга ушёл наш реф-кредит на tabitoken (2026-08-21): кнопка «вход»
    // повела на кошелёк, сайт зарегистрировал с нуля, `aff` в localStorage не было.
    // Поэтому сначала сажаем реф-код (он живёт в localStorage и переживает переходы),
    // и только потом идём на кошелёк: аккаунт есть — код просто не пригодится, аккаунта
    // нет — регистрация зачтётся по рефке. Если сайт сам увёл на GitHub-вход,
    // CONSOLE_URL не перебиваем: это порвало бы OAuth-state.
    // Условие не «свежий профиль», а «сессии ЛК нет». Разница поймана в тот же день:
    // у записи без ключа профиль после первого неудачного захода уже НЕ свежий, а
    // аккаунта у провайдера по-прежнему нет — второй клик снова уводил на кошелёк без
    // реф-кода, и рефка терялась ровно так же. Живому аккаунту (кука ЛК на месте) лишний
    // заход по реф-ссылке не делаем.
    const siteCookies = await context.cookies().catch(() => []);
    let loggedInEarly = false;
    if (fresh || !hasSessionCookie(siteCookies)) {
      await openRegisterViaRef(page);
      if (/github\.com/i.test(page.url())) {
        console.log('↪️  сайт сам ушёл на GitHub-вход — жди входа, реф-код уже в профиле');
        const okRef = await waitForLogin(page, context);
        if (!okRef) { console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.'); process.exit(2); }
        loggedInEarly = true;
      }
    }
    if (!/github\.com/i.test(page.url())) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    }

    if (!fresh) {
      await reportRender(page);
      await backupGhAfterLogin(context);
      console.log('✅ Профиль восстановлен (agentrouter уже залогинен, если заходил раньше).');
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await ghCapture.holdOpen(context); // держим открытым, закрытие — вручную
      return;
    }

    if (!loggedInEarly) console.log('⚠️  Первый вход. Залогинься через GitHub в открывшемся браузере.');
    console.log('   Профиль сохранится автоматически.');

    const ok = await waitForLogin(page, context);
    if (!ok) {
      console.error('❌ Таймаут ожидания GitHub-логина (10 мин). Закрываю.');
      process.exit(2);
    }

    await backupGhAfterLogin(context);
    console.log('✅ Вход выполнен, профиль сохранён на диск. Браузер остаётся открытым — закрой когда закончишь (Ctrl+C).');
    await ghCapture.holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});