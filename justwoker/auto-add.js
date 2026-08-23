// justwoker/auto-add.js
//
// Заводит аккаунт JustWoker БЕЗ ЧЕЛОВЕКА: вход через готовую GitHub-сессию и снятие
// API-ключа. То, что раньше было двумя ручными шагами — клик «Продолжить с GitHub» в
// открытом браузере и копирование ключа со страницы `/keys` в дашборд кнопкой 🔑.
//
// Сценарий снят рекордером с живого прохода (2026-08-22, tools/rec-newapi-flow.js,
// трейс logs/rec-_rec-2026-08-22T11-02-48.jsonl) — не угадан по бандлу:
//
//   1. /sign-up?aff=<code> → клик по <button> с подписью «Продолжить с GitHub».
//   2. Панель гасит прежнюю сессию (POST /api/user/auth/logout) и берёт state:
//      POST /api/oauth/state {"provider":"github","intent":"login","aff":"<code>"}.
//   3. Переход на github.com/login/oauth/authorize В ТОЙ ЖЕ ВКЛАДКЕ.
//      🪤 Здесь JustWoker расходится с AgentRouter: у того вход уезжает в ПОПАП
//      (agentrouter/open-session.js:388), и ожидание попапа тут повисло бы навсегда.
//   4. Первый заход требует согласия: button[name="authorize"] «Authorize justdoanywork».
//      Второй и дальше GitHub редиректит молча.
//   5. Колбэк GET /api/oauth/github?code=&state= — и В ЕГО ОТВЕТЕ УЖЕ ЛЕЖИТ КЛЮЧ:
//      { data: { sk, access_token, user: { id, aff_code, inviter_id, … } } }.
//
// Отсюда главное упрощение: страницу `/keys` открывать НЕ НАДО, и `listAccountKeys()`
// (routing/lib/newapi-account.js:1031, два запроса + раскрытие маски) в этом пути не
// участвует — он остаётся фолбэком на случай, если колбэк ключа не отдаст (вход в
// УЖЕ существующий аккаунт живым прогоном не проверен, см. ниже).
//
// Пароль и 2FA скрипт НЕ ВВОДИТ. Нужна живая GitHub-сессия: снимок
// github/sessions/<ghId>.json, который снял харвест из профиля другого провайдера.
//
// 🪤 Панель пускает только GitHub старше года (`github_minimum_account_age_days: 365`).
// Замер 2026-08-22 по публичному api.github.com: из 36 аккаунтов менеджера проходят 25.
// Возраст проверяем ДО открытия браузера — иначе жжём OAuth-заход в отказ.
//
// Использование:
//   node justwoker/auto-add.js <label> <ghIdOrNick> [affCode] [--headed]
//     label      — папка профиля justwoker/profiles/<label>/ (обычно acct_<id> из пула)
//     ghIdOrNick — id записи менеджера (gh_…) или ник GitHub; снимок ищется по обоим
//     affCode    — реф-код в ссылку; по умолчанию JW_AFF_CODE
//
// Код возврата: 0 — аккаунт заведён и ключ снят; 2 — вход не подтвердился;
//   3 — GitHub-сессия мертва (нужен пароль/2FA); 4 — кнопку входа не нашли;
//   5 — панель отвергла OAuth; 6 — вошли, но ключ снять не удалось;
//   7 — GitHub моложе 365 дней (панель откажет).
//
// Последняя строка stdout при успехе: JW_AUTOADD_RESULT {json} — её разбирает дашборд.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Реф-код владельца. Захардкожен намеренно, как в open-session.js:41 — из аргументов
// он берётся только для замеров: забытый параметр = молча потерянный кредит.
// Реф-код владельца. Больше не литерал: источник — routing/lib/ref-codes.js, где дефолт
// лежит в ref-codes.default.json (в репозитории), а пользователь вписывает свой через 💩
// в «Настройках» дашборда. Из аргументов код берётся только для замеров.
// 🪤 Литерал оставлен последним резервом намеренно: если файла дефолтов не окажется,
// авто-заведение обязано идти по рефке, а не молча без неё.
const JW_AFF_CODE = require('../routing/lib/ref-codes.js').code('justwoker') || 'IFYf';

const HOST = 'api.justwoker.icu';
const ROOT_URL = `https://${HOST}/`;
const CONSOLE_URL = `https://${HOST}/dashboard/overview`;

const GH_SESSIONS_DIR = path.join(ROOT, 'github', 'sessions');

// Сколько ждём подтверждения входа. Ручной ветке в open-session.js дано 10 минут на
// человека; тут людей нет, а GitHub-редирект и колбэк укладываются в секунды.
const AUTO_LOGIN_TIMEOUT_MS = 90 * 1000;
// Минимальный возраст GitHub, который принимает панель.
const MIN_GH_AGE_DAYS = 365;

const argv = process.argv.slice(2).filter(a => a !== '--headed');
const HEADED = process.argv.includes('--headed');
const label = String(argv[0] || '').replace(/[^\w-]/g, '_');
const ghArg = String(argv[1] || '').trim();
const affCode = String(argv[2] || JW_AFF_CODE).trim();

if (!label || !ghArg) {
  console.error('использование: node justwoker/auto-add.js <label> <ghIdOrNick> [affCode] [--headed]');
  process.exit(1);
}

const profileDir = path.join(ROOT, 'justwoker', 'profiles', label);
const REGISTER_URL = `https://${HOST}/sign-up?aff=${encodeURIComponent(affCode)}`;

// Свой файловый лог. Строки скрипта и так видны в Server Logs дашборда (он пайпит
// stdout через logLine), но тот буфер — 200 строк на весь дашборд, а один прогон даёт
// 37: через минуту работы от прогона не остаётся ничего, и headless-проход потом не
// разобрать. Поэтому пишем ещё и в файл.
// 🪤 stdout не трогаем и не глушим: дашборд парсит из него последнюю строку
// `JW_AUTOADD_RESULT {json}`. Файл — дополнение, а не замена.
// Провал записи в лог не должен ронять прогон, поэтому всё в try/catch.
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = process.env.JW_AUTOADD_LOG || path.join(LOG_DIR, 'justwoker-autoadd.log');
function logFile(s) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const t = new Date().toISOString().replace('T', ' ').slice(0, 23);
        fs.appendFileSync(LOG_FILE, `[${t}] [${label}] ${s}\n`, 'utf8');
    } catch { /* лог не важнее прогона */ }
}
function log(s) { console.log(s); logFile(s); }
function fail(code, ...lines) {
  for (const l of lines) { console.error(l); logFile(`✗ ${l}`); }
  logFile(`── выход с кодом ${code} ──`);
  process.exitCode = code;
}
logFile(`── старт: gh=${ghArg} aff=${affCode} headed=${process.argv.includes('--headed')} профиль=${profileDir} ──`);

// ───────────────────────── снимок GitHub-сессии ─────────────────────────
// Формат — storageState, который положил дашборд (`gsl.seedPayload`) или харвест.
// Разбор один в один с open-session.js:69-112, чтобы браузер стартовал в том же
// состоянии, что по кнопке 🌐.
function findGhSnapshot(arg) {
  const direct = path.join(GH_SESSIONS_DIR, arg + '.json');
  if (fs.existsSync(direct)) return { file: direct, ghId: arg };
  let names;
  try { names = fs.readdirSync(GH_SESSIONS_DIR); } catch { return null; }
  for (const f of names) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(GH_SESSIONS_DIR, f), 'utf8'));
      if (String(j.ghLogin || '').toLowerCase() === arg.toLowerCase()) {
        return { file: path.join(GH_SESSIONS_DIR, f), ghId: f.replace(/\.json$/, '') };
      }
    } catch { /* битый снимок пропускаем: рядом лежат годные */ }
  }
  return null;
}

// Возраст аккаунта — публичным API GitHub, БЕЗ кук снимка. Ходить на github.com под
// сессией ради проверки нельзя: фейковый заход GitHub считает угоном и гасит сессию
// (три уже так потеряли — routing/lib/github-session.js). Публичная ручка про сессию
// ничего не знает и ничему не вредит.
async function ghAgeDays(nick) {
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(nick)}`,
      { headers: { 'user-agent': 'jw-auto-add' } });
    if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    if (!j || !j.created_at) return { ok: false, error: 'нет created_at' };
    return { ok: true, days: Math.floor((Date.now() - new Date(j.created_at)) / 86400000), created: j.created_at.slice(0, 10) };
  } catch (e) {
    // Сеть до GitHub не поднялась — это не повод отказывать: гейт проверит сама панель.
    return { ok: false, error: e.message };
  }
}

async function seedGithub(context, snapFile) {
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const cookies = Array.isArray(snap.cookies) ? snap.cookies : [];
  if (!cookies.length) return { ok: false, error: 'в снимке нет кук' };
  try { await context.addCookies(cookies); }
  catch (e) { log(`⚠️  часть кук не применилась: ${e.message}`); }
  for (const o of (snap.origins || []).filter(o => o.localStorage && o.localStorage.length)) {
    try {
      await context.addInitScript(
        (entries) => { for (const { name, value } of entries) { try { localStorage.setItem(name, value); } catch {} } },
        o.localStorage.map(({ name, value }) => ({ name, value })),
      );
    } catch { /* невалидный origin */ }
  }
  // Живость — ПО КУКЕ профиля, пробник запрещён (см. ghAgeDays выше).
  const alive = cookies.some(c => c.name === 'user_session' && c.value);
  return { ok: true, alive, ghLogin: snap.ghLogin || null, count: cookies.length };
}

// ───────────────────────── перехват колбэка OAuth ─────────────────────────
// Тело читаем через route.fetch(), а не в обработчике 'response': к моменту, когда
// resp.json() доберётся до тела, SPA уже уводит страницу на /dashboard/overview, тело
// выбрасывается — и ключ теряется молча. route.fetch() буферизует ответ у нас,
// fulfill отдаёт его странице, одноразовый `code` расходуется РОВНО один раз.
// Проверено этим же приёмом у AgentRouter (agentrouter/open-session.js:285).
const OAUTH_API_RE = /\/api\/oauth\/github/i;

function watchOauthResult(context) {
  const out = {
    seen: false, success: null, message: '',
    sk: null, accessToken: null, user: null,
  };
  context.route(OAUTH_API_RE, async (route) => {
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      try {
        const j = JSON.parse(body);
        const d = j.data || {};
        out.seen = true;
        out.success = !!j.success;
        out.message = String(j.message || '');
        // Ключ панель отдаёт БЕЗ префикса sk- в поле `sk` (замер: "leWf4nFz…", 48 симв.).
        // Пул хранит ключи с префиксом, поэтому нормализуем здесь, а не у вызывающего.
        if (typeof d.sk === 'string' && d.sk.length >= 16) {
          out.sk = d.sk.startsWith('sk-') ? d.sk : 'sk-' + d.sk;
        }
        if (typeof d.access_token === 'string') out.accessToken = d.access_token;
        if (d.user && typeof d.user === 'object') {
          const u = d.user;
          out.user = {
            id: u.id ?? null,
            displayName: u.display_name || null,
            githubId: u.github_id || null,
            group: u.group || null,
            // Ради этих двух полей и стоит перехват: `inviter_id: 0` = реф-кредит НЕ
            // привязался, и снаружи это никак больше не увидеть.
            affCode: u.aff_code || null,
            inviterId: u.inviter_id ?? null,
            // 🪤 quota в колбэке обнулена (проверено у AgentRouter на аккаунте с $175):
            // как баланс пользоваться нельзя, в пул уехал бы $0.
          };
        }
        log(out.success
          ? `🔑 панель приняла GitHub-вход${out.sk ? ' и отдала ключ прямо в колбэке' : ' (ключа в колбэке нет — сниму со страницы)'}`
          : `⚠️  панель отвергла вход: ${out.message || 'без причины'}`);
      } catch { /* не json (заглушка WAF) — решит ожидание ниже */ }
      await route.fulfill({ response: resp, body });
    } catch (e) {
      log(`⚠️  ответ колбэка прочитать не удалось (${e.message})`);
      await route.continue().catch(() => {});
    }
  }).catch(() => {});
  return out;
}

// Панель сама продлевает сессию: `POST /api/user/auth/refresh` на неавторизованной
// странице отвечает 401, а в уже залогиненном профиле — 200 с новым access-токеном.
// Ловим его, потому что это ЕДИНСТВЕННЫЙ способ прочитать ключ в профиле, где вход
// уже есть: DPAPI-расшифровка кук с диска на этой машине из неэлевированной консоли
// падает («ключ профиля не расшифровался»), а вход заново там невозможен — панель
// редиректит на консоль, и кнопки GitHub на странице нет вовсе.
function watchRefresh(context) {
  const out = { token: null };
  context.on('response', async (resp) => {
    try {
      if (!/\/api\/user\/auth\/refresh/.test(resp.url()) || resp.status() !== 200) return;
      const j = await resp.json().catch(() => null);
      const t = j && j.data && j.data.access_token;
      if (typeof t === 'string' && t.length > 16) out.token = t;
    } catch { /* диагностика не должна ронять прогон */ }
  });
  return out;
}

// ───────────────────────── клик по входу через GitHub ─────────────────────────
// Берём только BUTTON: в подвале панели сидят ссылки на github.com, и `a[href*=github]`
// увёл бы на профиль проекта вместо входа. Текст в UI русский («Продолжить с GitHub»),
// но фильтр по /github/i переживает и смену локали, и правку формулировки.
async function clickGithubLogin(page, seen = () => false) {
  const byText = page.locator('button').filter({ hasText: /github/i }).first();
  const byIcon = page.locator('button:has(svg)').filter({ hasText: /github/i }).first();
  let target = null;
  for (const cand of [byText, byIcon]) {
    // Ждать обязательно: SPA дорисовывает кнопки сторонних входов позже готовности #root.
    const ok = await cand.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (ok) { target = cand; break; }
  }
  if (!target) return false;

  // Клик может «не увести никуда» по двум противоположным причинам, и путать их нельзя:
  //   • панель отказала на `POST /api/oauth/state` (рейт-лимит 429 по IP — поймано
  //     2026-08-22 на четвёртой регистрации за десять минут): редиректа не будет вовсе;
  //   • всё УЖЕ прошло: согласие приложению давалось раньше, GitHub отредиректил молча,
  //     и к моменту проверки вкладка стоит на `/dashboard/overview`. Ждать тут
  //     github.com — ждать прошлое, и вторая попытка клика жмёт кнопку, которой на
  //     странице консоли нет («locator.click: Timeout»).
  // Поэтому ждём ЛЮБОЙ из трёх исходов, а не только уход на github.com.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await target.click({ timeout: 5000 }).catch(e => log(`⚠️  клик не прошёл: ${e.message}`));
    const moved = await Promise.race([
      page.waitForURL(/github\.com\/login\/oauth\/authorize/i, { timeout: 20000 }).then(() => 'github'),
      page.waitForURL(u => JW_DONE_RE.test(new URL(String(u)).pathname), { timeout: 20000 }).then(() => 'done'),
      // Колбэк мог быть перехвачен раньше, чем SPA сменила URL.
      (async () => { for (let i = 0; i < 40; i++) { if (seen()) return 'callback'; await page.waitForTimeout(500); } return null; })(),
    ]).catch(() => null);
    if (moved) { log(`   ▸ после клика: ${moved}`); return true; }
    if (attempt === 1) log('⚠️  после клика вкладка осталась на панели — жму второй раз');
  }
  return true;
}

// GitHub попросит логин/2FA только если сессия мертва — по этим URL и опознаём.
// 🪤 Негативный lookahead `login(?!\/oauth)` обязателен: сам authorize-URL живёт на
// `github.com/login/oauth/authorize`, и без него КАЖДЫЙ здоровый вход опознавался как
// «сессия мертва» (наступил на это здесь же, хотя у AgentRouter лекарство уже стояло —
// agentrouter/open-session.js:327).
const GH_AUTH_WALL_RE = /github\.com\/(login(?!\/oauth)|session\b|sessions\/)/i;
// Куда панель приводит ПОСЛЕ GitHub: сам колбэк и всё, что за ним. Список конечных
// путей нужен именно потому, что хост панели совпадает с хостом страницы регистрации.
const JW_DONE_RE = /\/(oauth\/github|dashboard|console|keys|wallet)/i;

// Проводим вкладку через GitHub-часть. У JustWoker всё идёт В ТОЙ ЖЕ вкладке, попапа
// нет (замер трейсом) — поэтому смотрим на URL страницы, а не ждём событие 'page'.
async function passGithubGate(page) {
  let last = '';
  for (let i = 0; i < 60; i++) {
    if (page.isClosed()) return 'closed';
    const url = page.url();
    if (url !== last) { log(`   ↪️  ${url.slice(0, 120)}`); last = url; }
    if (GH_AUTH_WALL_RE.test(url)) return 'dead';
    if (/github\.com\/login\/oauth\/authorize/i.test(url)) {
      // 🪤 На странице согласия ДВЕ кнопки с name="authorize": «Cancel» (value=0) и
      // «Authorize» (value=1). Селектор `button[name=authorize]` матчит обе, и `.first()`
      // жмёт ОТМЕНУ — панель отвечает «The user has denied your application access»,
      // что выглядит как отказ по возрасту аккаунта. Проверено живым прогоном
      // 2026-08-22; в трейсе ручного прохода нажата вторая кнопка и в теле POST
      // уехало `authorize=1`. Поэтому value=1 обязателен.
      const btn = page.locator('button[name="authorize"][value="1"]').first();
      if (await btn.count().catch(() => 0)) {
        log('🔓 GitHub просит подтвердить доступ приложению — жму Authorize (один раз на аккаунт)');
        await btn.click({ timeout: 5000 }).catch(e => log(`⚠️  Authorize не нажался: ${e.message}`));
        return 'authorized';
      }
      // Кнопки нет — согласие этому аккаунту уже давали, GitHub редиректит сам. Ждём.
    }
    // 🪤 Проверка «мы на хосте панели» ОБЯЗАНА требовать конечный путь: на хосте мы
    // стоим и до клика (`/sign-up`), поэтому первая же итерация возвращала 'callback',
    // не дав входу начаться — вход «не подтверждался» за 90 с при целом сценарии.
    if (url.includes(HOST) && JW_DONE_RE.test(url)) return 'callback';
    await page.waitForTimeout(700).catch(() => {});
  }
  return 'unknown';
}

// Успех определяем ПО ОТВЕТУ ПАНЕЛИ на колбэк, а не по наличию куки: `/api/oauth/state`
// сам ставит куку `session` (в ней сервер держит state OAuth), и проверка по кукам
// печатала бы «вход выполнен» до того, как GitHub вообще вернулся.
async function waitForCallback(oauth, timeoutMs, page = null) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (oauth.seen) return oauth.success ? { ok: true } : { ok: false, rejected: true, message: oauth.message };
    // Пишем, куда уехала вкладка, пока ждём. Без этого таймаут — глухая стена: не
    // видно, стоим мы на челлендже Cloudflare, на ошибке панели или колбэк уже прошёл
    // мимо перехвата.
    if (page && !page.isClosed()) {
      const u = page.url();
      if (u !== last) { log(`   ⏳ ${u.slice(0, 140)}`); last = u; }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (page && !page.isClosed()) {
    const txt = await page.locator('body').innerText().then(t => t.replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
    if (txt) log(`   📄 на странице: ${txt}`);
  }
  return { ok: false, timeout: true };
}

// Фолбэк, если ключа в колбэке не было. Тот же путь, которым ключ берёт дашборд
// (routing/lib/newapi-account.js:1031): список токенов + раскрытие маски. Ходим
// Bearer'ом из колбэка — он уже на руках, куки с диска расшифровывать не нужно.
async function fetchKeyByToken(page, accessToken) {
  if (!accessToken) return null;
  return await page.evaluate(async (tok) => {
    const h = { Authorization: 'Bearer ' + tok, Accept: 'application/json' };
    const list = await fetch('/api/token/?p=1&size=20', { headers: h }).then(r => r.json()).catch(() => null);
    const items = (list && list.data && (list.data.items || list.data)) || [];
    if (!items.length) return null;
    const it = items[0];
    const raw = String(it.key || '');
    if (raw && !raw.includes('*')) return { id: it.id, key: raw, name: it.name || null };
    const rev = await fetch(`/api/token/${encodeURIComponent(it.id)}/key`, { method: 'POST', headers: h })
      .then(r => r.json()).catch(() => null);
    const k = rev && rev.data && (rev.data.key || rev.data);
    return typeof k === 'string' ? { id: it.id, key: k, name: it.name || null } : null;
  }, accessToken).catch(e => { log(`⚠️  фолбэк снятия ключа не сработал: ${e.message}`); return null; });
}

// Access-токен для уже залогиненного профиля. Перехват на лету — гонка: страница
// успевает сходить за refresh до того, как мы поставили слушателя, и токена нет.
// Поэтому если не перехватили — просим сами, куками профиля. Ответ тот же.
async function ensureToken(page, refresh) {
  if (refresh.token) return refresh.token;
  const t = await page.evaluate(async () => {
    const r = await fetch('/api/user/auth/refresh', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}', credentials: 'include',
    }).then(r => r.json()).catch(() => null);
    return (r && r.data && r.data.access_token) || null;
  }).catch(() => null);
  if (t) refresh.token = t;
  return t;
}

// Карточка пользователя по Bearer. Нужна ровно для аудита реф-кредита: в колбэке
// `inviter_id` приезжает сам, а у уже залогиненного профиля колбэка нет.
async function fetchSelf(page, accessToken) {
  if (!accessToken) return null;
  return await page.evaluate(async (tok) => {
    const r = await fetch('/api/user/self', { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } })
      .then(r => r.json()).catch(() => null);
    return (r && r.data) || null;
  }, accessToken).catch(() => null);
}

// ───────────────────────────────── прогон ─────────────────────────────────
async function main() {
  const found = findGhSnapshot(ghArg);
  if (!found) {
    return fail(3, `❌ снимка GitHub «${ghArg}» в ${GH_SESSIONS_DIR} нет.`,
      '   Пароль и 2FA автоматика не вводит: открой аккаунт во вкладке GitHub и залогинься,',
      '   либо возьми его кнопкой 🐙 — дашборд снимет снимок сам.');
  }
  const snapNick = (() => {
    try { return JSON.parse(fs.readFileSync(found.file, 'utf8')).ghLogin || null; } catch { return null; }
  })();
  const nick = snapNick || ghArg;

  // Возраст — ДО браузера. Иначе жжём OAuth-заход в гарантированный отказ, а вместе с
  // ним и согласие приложению на GitHub-аккаунте.
  const age = await ghAgeDays(nick);
  if (age.ok) {
    log(`🎂 GitHub ${nick}: ${age.days} дн. (создан ${age.created})`);
    if (age.days < MIN_GH_AGE_DAYS) {
      return fail(7, `❌ панель требует GitHub старше ${MIN_GH_AGE_DAYS} дней (github_minimum_account_age_days), а ${nick} — ${age.days}.`,
        '   Это не поломка скрипта: свежие аккаунты JustWoker отвергает на своей стороне.');
    }
  } else {
    log(`⚠️  возраст ${nick} не проверился (${age.error}) — иду вслепую, гейт проверит панель`);
  }

  fs.mkdirSync(path.dirname(profileDir), { recursive: true });
  // 🪤 Свежесть НЕЛЬЗЯ определять по `Default/Preferences`, как это делают headed-скрипты
  // (open-session.js:115, github/open-session.js:66): headless-Chromium этот файл не
  // пишет вообще, и профиль вечно считался бы чистым — снимок вливался бы поверх живой
  // сессии при каждом прогоне. Банка кук есть в обоих режимах.
  const fresh = !fs.existsSync(path.join(profileDir, 'Default', 'Network', 'Cookies'));
  log(`🚀 профиль ${profileDir} · ${fresh ? 'чистый' : 'уже есть'}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    // headless по умолчанию: ручку зовёт дашборд, и мигающее окно тут только мешает.
    // --headed оставлен для разбора, когда что-то пошло не так.
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let result = null;
  try {
    // Снимок вливаем ТОЛЬКО в чистый профиль — тот же гейт, что в open-session.js:334.
    // В непустом лежит своя сессия, и она свежее: `user_session` GitHub ротирует
    // постоянно, а снимок в кеше живёт до 7 суток. Вливание старого поверх нового
    // разлогинило бы аккаунт.
    if (fresh) {
      const seeded = await seedGithub(context, found.file);
      if (!seeded.ok) {
        await context.close().catch(() => {});
        return fail(3, `❌ снимок ${found.ghId} не годится: ${seeded.error}`);
      }
      log(`🐙 заселён GitHub ${nick} (${found.ghId}): кук ${seeded.count}`
        + (seeded.alive ? ' — user_session на месте' : ' — ⚠️ user_session нет'));
      if (!seeded.alive) {
        await context.close().catch(() => {});
        return fail(3, '❌ в снимке нет живой куки user_session — GitHub попросит пароль и 2FA.',
          '   Залогинься этим аккаунтом во вкладке GitHub заново.');
      }
    }

    // Подписку вешаем ДО навигации: колбэк придёт сразу после редиректа GitHub.
    const oauth = watchOauthResult(context);
    const refresh = watchRefresh(context);

    // ── Опыт с реф-кредитом (JW_INTENT_REGISTER=1) ──────────────────────────
    // Замер 2026-08-22: `aff` доезжает до бэкенда в теле `POST /api/oauth/state`, но
    // пользователь возвращается с `inviter_id: 0` — и с кодом владельца (IFYf), и с
    // заведомо существующим кодом другого нашего же аккаунта (AUpX, user 8448). То
    // есть дело не в коде. Единственное подозрительное поле — `intent:"login"`: SPA
    // на странице РЕГИСТРАЦИИ отправляет «вход», потому что GitHub-OAuth создаёт
    // аккаунт сам, а привязку инвайтера new-api исторически делает на пути
    // пароля-регистрации, который тут выключен (`password_register_enabled: false`).
    // Флаг переписывает intent на register, чтобы проверить это НЕ жгя отдельный
    // GitHub: опыт складывается в очередное настоящее заведение.
    if (process.env.JW_INTENT_REGISTER === '1') {
      await context.route(/\/api\/oauth\/state/i, async (route) => {
        try {
          const req = route.request();
          let data = req.postData() || '';
          try {
            const j = JSON.parse(data);
            j.intent = 'register';
            data = JSON.stringify(j);
            log(`🧪 опыт: intent переписан на "register" (${data})`);
          } catch { /* не json — отдаём как есть */ }
          await route.continue({ postData: data });
        } catch { await route.continue().catch(() => {}); }
      }).catch(() => {});
    }

    // Ошибки панели — в лог. Без этого «клик ничего не сделал» выглядит как сломанный
    // селектор, хотя на деле бэкенд отказал ещё на выдаче OAuth-state.
    // Отдельно ловим 429: панель throttl'ит `/api/user/auth/*` по IP, и на четвёртой
    // регистрации за десять минут клик просто перестаёт что-либо делать (замер
    // 2026-08-22). Без этого признака симптом неотличим от съехавшего селектора.
    const throttled = { seen: false, at: 0 };
    context.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (!u.includes(HOST) || !/\/api\//.test(u) || resp.ok()) return;
        if (resp.status() === 429) { throttled.seen = true; throttled.at = Date.now(); }
        // refresh на неавторизованной странице отвечает 401 всегда — это норма, не шум.
        if (/\/api\/user\/auth\/refresh/.test(u) && resp.status() === 401) return;
        const body = await resp.text().then(t => t.slice(0, 200)).catch(() => '');
        log(`⚠️  панель: ${resp.request().method()} ${resp.status()} ${u.replace(`https://${HOST}`, '')} ${body}`);
      } catch { /* диагностика не должна ронять прогон */ }
    });

    const page = context.pages()[0] || await context.newPage();
    log(`🎯 регистрация по рефке: ${REGISTER_URL}`);
    await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' });

    // Реф-код SPA берёт из query и кладёт в localStorage (бандл index.*.js: useEffect →
    // localStorage.setItem("aff", …)), а оттуда он уезжает в тело /api/oauth/state.
    // 🪤 Читать сразу после goto НЕЛЬЗЯ — эффект ещё не смонтирован, и проверка врёт
    // «код не осел» при доехавшем коде (ровно этим врёт open-session.js:257).
    const affSeen = await page.waitForFunction(
      () => { try { return localStorage.getItem('aff') || null; } catch { return null; } },
      null, { timeout: 10000 },
    ).then(h => h.jsonValue()).catch(() => null);
    log(affSeen === affCode
      ? `🤝 реф-код осел в профиле: aff=${affSeen}`
      : `⚠️  в localStorage aff=${affSeen === null ? 'нет' : affSeen}, ожидался ${affCode}`);

    // Профиль может быть УЖЕ залогинен: панель уводит с `/sign-up` на консоль, кнопки
    // GitHub на странице нет, и без этой ветки скрипт объявлял «панель переделала вход»
    // на полностью здоровом аккаунте. Тогда заводить нечего — надо только снять ключ.
    const already = await page.waitForFunction(
      () => /\/(dashboard|console|keys|wallet)/.test(location.pathname) || null,
      null, { timeout: 4000 },
    ).then(() => true).catch(() => !!refresh.token);
    if (already) {
      log('ℹ️  в профиле уже есть вход — аккаунт заводить не нужно, снимаю ключ');
      const tok = await ensureToken(page, refresh);
      const t = await fetchKeyByToken(page, tok);
      const key = t && t.key ? (t.key.startsWith('sk-') ? t.key : 'sk-' + t.key) : null;
      const self = await fetchSelf(page, tok);
      await context.close().catch(() => {});
      const r = {
        ok: !!key, label, ghId: found.ghId, ghLogin: nick,
        key, keyFrom: key ? 'уже был вход · /api/token' : null,
        userId: self ? self.id : null,
        affCode: self ? self.aff_code || null : null,
        inviterId: self ? self.inviter_id ?? null : null,
        affSent: affCode, affInStorage: affSeen,
        ghAgeDays: age.ok ? age.days : null, already: true,
      };
      if (!key) log('⚠️  ключ снять не удалось: access-токен не перехвачен или список токенов пуст');
      else log(`✅ ключ снят у существующего аккаунта${r.userId ? ` (user ${r.userId})` : ''}`);
      console.log(`JW_AUTOADD_RESULT ${JSON.stringify(r)}`);
      if (!key) process.exitCode = 6;
      return;
    }

    if (!await clickGithubLogin(page, () => oauth.seen)) {
      await context.close().catch(() => {});
      return fail(4, '❌ кнопки входа через GitHub на странице нет — панель переделала вход.',
        '   Открой аккаунт кнопкой 🌐 и войди руками, а сценарий пересними рекордером.');
    }
    log('🖱 нажал «Продолжить с GitHub»');

    const gate = await passGithubGate(page);
    if (gate === 'dead') {
      await context.close().catch(() => {});
      return fail(3, '❌ GitHub попросил пароль или 2FA — сессия в снимке уже не годится.',
        '   Залогинься этим аккаунтом во вкладке GitHub заново и повтори.');
    }
    log(`🔄 GitHub-часть: ${gate}`);

    const res = await waitForCallback(oauth, AUTO_LOGIN_TIMEOUT_MS, page);
    if (res.rejected) {
      await context.close().catch(() => {});
      return fail(5, `❌ панель отвергла OAuth: ${res.message || 'без причины'}.`,
        '   Частая причина — возраст GitHub меньше года либо закрытая регистрация.');
    }
    if (!res.ok) {
      await context.close().catch(() => {});
      // Рейт-лимит — самая частая причина, и путать её с поломкой нельзя: аккаунт цел,
      // GitHub цел, надо просто подождать. Отдельный код, чтобы дашборд не помечал
      // запись сломанной и не жёг второй GitHub.
      if (throttled.seen) {
        return fail(8, '❌ панель включила рейт-лимит (HTTP 429 на /api/user/auth/*) — аккаунт не заведён.',
          '   Ничего не сломано: подожди и повтори тем же GitHub, запись в пуле и снимок сессии целы.',
          '   Замер 2026-08-22: лимит ловится примерно на четвёртой регистрации за десять минут с одного IP.');
      }
      return fail(2, `❌ вход не подтвердился за ${Math.round(AUTO_LOGIN_TIMEOUT_MS / 1000)} с — аккаунт не заведён.`);
    }

    // Ключ обычно уже на руках из колбэка; иначе — фолбэк по Bearer со страницы панели.
    let key = oauth.sk;
    let keyFrom = key ? 'колбэк' : null;
    if (!key) {
      await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const t = await fetchKeyByToken(page, oauth.accessToken);
      if (t && t.key) {
        key = t.key.startsWith('sk-') ? t.key : 'sk-' + t.key;
        keyFrom = `/api/token/${t.id}/key`;
      }
    }

    const u = oauth.user || {};
    result = {
      ok: !!key, label, ghId: found.ghId, ghLogin: nick,
      key: key || null, keyFrom,
      userId: u.id ?? null, affCode: u.affCode ?? null, inviterId: u.inviterId ?? null,
      // Что именно просили привязать — чтобы расхождение с inviterId было видно в логе.
      affSent: affCode, affInStorage: affSeen,
      ghAgeDays: age.ok ? age.days : null,
    };

    if (!key) {
      log('⚠️  вошли, но ключ снять не удалось ни из колбэка, ни со страницы.');
    } else {
      log(`✅ аккаунт заведён: user ${u.id}, ключ снят (${keyFrom})`);
    }
    // Реф-кредит: `inviter_id: 0` означает, что панель код проигнорировала. Молчать
    // об этом нельзя — снаружи потеря кредита ничем не видна.
    log(u.inviterId ? `🤝 реф-кредит привязан: inviter_id=${u.inviterId}`
      : `⚠️  РЕФ-КРЕДИТ НЕ ПРИВЯЗАН: inviter_id=${u.inviterId} при отправленном aff=${affCode}`);

    // Закрываем САМИ, и это не косметика: Chromium пишет новые куки в SQLite профиля
    // лениво, а дашборд читает баланс именно с диска. Пока окно открыто, свежей куки
    // на диске нет — и точный баланс откатывался бы на прикидку.
    await context.close().catch(() => {});
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }

  console.log(`JW_AUTOADD_RESULT ${JSON.stringify(result)}`);
  if (!result.ok) process.exitCode = 6;
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
