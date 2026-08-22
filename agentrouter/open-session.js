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
// Коды возврата: 0 = готово (autocheckin печатает маркер AUTOCHECKIN_RESULT {...}),
//   2 = таймаут ожидания GitHub-логина, 3 = GitHub-сессия в профиле мертва (нужен
//   ручной вход, пароль и 2FA автоматика не вводит), 4 = не нашёл, чем начать
//   GitHub-вход, 5 = шлюз отверг OAuth (state/код), 1 = прочая ошибка.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Рефка владельца: аккаунт без ключа регистрируем ТОЛЬКО по ней (реф-бонус +$100).
const REGISTER_URL = 'https://agentrouter.org/register?aff=oUm3';
// Ключ уже вписан → сразу баланс/пополнение, а не корень сайта.
const CONSOLE_URL = 'https://agentrouter.org/console/topup';
// Корень нужен для прогрева перед регистрацией (см. openRegisterViaRef).
const ROOT_URL = 'https://agentrouter.org/';
// Чек-ин +$25 капает раз в сутки только после ПОВТОРНОГО входа через GitHub, поэтому
// режим checkin гасит сессию и ставит браузер на страницу входа.
const LOGIN_URL = 'https://agentrouter.org/login';
// Роут разлогина у New-API не задокументирован — пробуем best-effort, чтобы погасить
// сессию и на сервере. Результат не проверяем: куки профиля мы всё равно чистим сами.
const LOGOUT_URL = 'https://agentrouter.org/api/user/logout';
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
      return { quota: j.data.quota, used: j.data.used_quota };
    } catch { return null; }
  }, userId).catch(() => null);
}

// Цифру со счёта печатаем в лог: точный чек дашборда мог быть отложен паузой WAF, а
// глазами по логу сразу видно, налил шлюз бонус или нет. quota_per_unit = 500000.
async function reportSelfBalance(page, userId = null) {
  const self = await siteSelfOk(page, userId);
  if (!self || typeof self.quota !== 'number') return;
  console.log(`💰 на счету $${(self.quota / 500000).toFixed(2)} (потрачено $${((self.used || 0) / 500000).toFixed(2)})`);
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

// Чек-ин +$25: гасим сессию agentrouter и ставим браузер на страницу входа.
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
async function doCheckinLogout(context, page) {
  const ghBefore = (await context.cookies('https://github.com').catch(() => []));
  const saved = saveGhBackup(label, ghBefore);
  console.log(`🐙 GitHub-сессия: ${ghBefore.length} кук в профиле${saved ? `, копия сохранена (${saved} долгоживущих)` : ', сохранять нечего'}`);

  await page.goto(LOGOUT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(800);

  const arCookies = await context.cookies('https://agentrouter.org').catch(() => []);
  let deleted = 0;
  try {
    const cdp = await context.newCDPSession(page);
    for (const k of arCookies) {
      await cdp.send('Network.deleteCookies', { name: k.name, domain: k.domain, path: k.path || '/' });
      deleted++;
    }
    await cdp.detach().catch(() => {});
  } catch (e) {
    // Последний резерв — НЕ clearCookies(): он снёс бы GitHub (см. выше). Лучше
    // оставить пользователя разлогиниться руками, чем потерять вход одним кликом.
    console.log(`⚠️  удалить куки через CDP не удалось (${e.message})`);
    console.log('   GitHub трогать не буду — разлогинься на странице сам (меню профиля → Logout).');
  }

  const arLeft = (await context.cookies('https://agentrouter.org').catch(() => [])).length;
  console.log(`🚪 куки agentrouter.org: удалено ${deleted}/${arCookies.length}, осталось ${arLeft}${arLeft === 0 ? ' — сессия погашена' : ' (разлогинься вручную)'}`);
  await restoreGithubIfLost(context, ghBefore);

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
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
    try {
      console.log(auto
        ? '⚡ Автоподарок: гашу сессию и вхожу через GitHub сам.'
        : '🎁 Чек-ин +$25: гашу сессию и открываю вход.');
      await doCheckinLogout(context, page);

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
        await reportSelfBalance(page, oauth && oauth.userId);
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
      await backupGhAfterLogin(context);
      console.log('✅ Вход выполнен. Закрываю браузер, чтобы куки легли на диск —');
      console.log('   без этого точный баланс не читается и чек показал бы прикидку.');
      await context.close().catch(() => {});
      if (auto) {
        // Маркер для дашборда: checkedIn = слово ШЛЮЗА про суточный бонус, null —
        // ответ колбэка поймать не удалось (вход подтвердился кукой), тогда бэкенд
        // решает по росту выдачи, как раньше.
        console.log(`AUTOCHECKIN_RESULT ${JSON.stringify({
          checkedIn: oauth && oauth.seen ? !!oauth.checkedIn : null,
          message: (oauth && oauth.message) || '',
        })}`);
        console.log('⚡ Готово. Дашборд сам пересчитает баланс и переставит колонку 🎁.');
      } else {
        console.log('🎁 Готово. Жми 💰 в дашборде: увидишь +$25 и колонка станет 📦.');
      }
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