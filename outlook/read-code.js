// outlook/read-code.js
//
// Читает код подтверждения из САМОГО СВЕЖЕГО письма ящика Outlook — без окна, на том же
// профиле Chromium, который завёл outlook/open-session.js.
//
// Зачем через браузер, а не IMAP: `outlook.office365.com:993` отвечает
// `AUTH=XOAUTH2 LOGINDISABLED` (живая проба 31.08) — базовую авторизацию Microsoft
// выключил, пароль ящика к IMAP не подходит. Единственный вход — залогиненная сессия.
//
// Использование: node outlook/read-code.js acct_<id>
//
// В stdout РОВНО ОДНА строка JSON и больше ничего — её целиком парсит дашборд:
//   {"ok":true,"code":"123456","from":"…","subject":"…","at":"…","link":"https://…"}
//   {"ok":false,"error":"session_expired"}
// Вся отладка идёт в stderr. `code` — единственное несущее поле; `from`/`subject`/`at`
// собираются из вёрстки OWA и нужны для строки в логе, поэтому при неудачном разборе они
// пустые, а не повод вернуть ok:false.
//
// Коды возврата: 0 — код найден, 1 — ошибка (нет такого label, нет профиля почты, код не
//                нашёлся), 2 — таймаут 60 с, 3 — сессия погасла (session_expired): дашборду
//                это значит «скажи человеку открыть ящик и войти», а не «кода нет».

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const pool = require('../routing/lib/outlook-pool.js');

const MAIL_URL = 'https://outlook.live.com/mail/0/';
// Студенческие ящики пула (`kind: 'student'`) — арендаторы M365, их Microsoft держит на
// других хостах. Считаем почтой любой из них, иначе на школьном ящике вернём session_expired
// при полностью живой сессии.
const MAIL_URL_RE = /^https?:\/\/(outlook\.(live|office|office365)\.com|outlook\.cloud\.microsoft)\/mail/i;
const LOGIN_URL_RE = /^https?:\/\/([^/]*\.)?(login\.(live|microsoftonline|microsoft)\.com|account\.live\.com|signup\.live\.com)\//i;
const LANDING_URL_RE = /^https?:\/\/([^/]*\.)?(outlook\.(live|com)|outlook\.office\.com|microsoft\.com)/i;

const TIMEOUT_MS = 60 * 1000;
const MAX_ROWS = 3;          // сколько верхних писем осмотреть, если в первом кода нет

// Строки списка писем. Только роли ARIA и служебные атрибуты: язык интерфейса купленного
// ящика заранее неизвестен, на подписи вида «Список сообщений» опираться нельзя.
const ROW_SELECTORS = [
  'div[role="listbox"] div[role="option"]',
  'div[role="option"][data-convid]',
  'div[role="option"]',
  '[data-convid]',
];
// Пустой ящик — тоже «мы внутри»: список есть, писем нет.
const LIST_SELECTORS = [...ROW_SELECTORS, '[data-app-section="MessageList"]', '#MailList', 'div[role="listbox"]'];
const PANE_SELECTORS = ['#ReadingPaneContainer', '[data-app-section="ConversationContainer"]', '[role="document"]', '[role="main"]'];
// Признак «показывают вход». Только id и name полей: на новой странице Microsoft (Fluent v2,
// замер 31.08) это `#usernameEntry` / `#passwordEntry`, на легаси — `loginfmt` / `passwd`.
// Кнопку `primaryButton` в этот список брать нельзя: она встречается и в диалогах самой почты.
const LOGIN_FORM_SELECTORS = ['#usernameEntry', '#passwordEntry', 'input[name="loginfmt"]', 'input[name="passwd"]', '#i0116', '#i0118'];

const labelArg = String(process.argv[2] || '').trim();
const label = labelArg.replace(/[^\w-]/g, '_');
const accountId = label.replace(/^acct_/, '');
const profileDir = path.join(pool.PROFILES_DIR, label);

const dbg = (...a) => console.error('[outlook/read-code]', ...a);

// Единственная точка записи в stdout. Флаг нужен не для красоты: сторож таймаута и обычный
// путь могут сойтись на одной миллисекунде, а две строки JSON дашборд уже не разберёт.
let emitted = false;
function emit(obj) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let ctx = null;
async function bail(obj, code) {
  emit(obj);
  // Закрываем браузер сами: process.exit оставил бы chromium сиротой, а профиль — залоченным.
  try { if (ctx) await Promise.race([ctx.close(), new Promise(r => setTimeout(r, 1500))]); } catch { /* уже мёртв */ }
  process.exit(code);
}

// ── извлечение кода ───────────────────────────────────────────────────────────
// Образец — freemodel/lib/timeweb-imap-client.js § extractCode, вместе с его граблей:
// цифры из АДРЕСА получателя матчатся раньше кода (в OWA адрес ящика виден и в шапке
// письма, и в подписи «Кому:»), поэтому строки с адресом выбрасываются целиком. Заодно
// выброшены строки-заголовки: в текст тела иногда попадает служебная шапка письма.
const CODE_RE = /(?<!\d)(\d{6})(?!\d)/;
const HEADER_LINE_RE = /^(return-path|delivered-to|received|from|to|cc|bcc|message-id|dkim|x-|date|mime|content|reply-to|sender|кому|от|дата|тема)\s*:/i;
// «код: 123456» на нескольких языках — приоритетнее любого другого шестизначного числа
// (в футере письма бывают номера договоров и телефонов).
const CODE_NEAR_RE = /(code|c[oó]digo|codice|kod|код|passcode|otp|pin)[^\d]{0,24}(?<!\d)(\d{6})(?!\d)/i;

function usefulLines(text, target) {
  const t = String(target || '').toLowerCase();
  return String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !HEADER_LINE_RE.test(l) && !(t && l.toLowerCase().includes(t)));
}

function codeFrom(text, target) {
  const lines = usefulLines(text, target);
  if (!lines.length) return null;
  const near = lines.join('\n').match(CODE_NEAR_RE);
  if (near) return near[2];
  for (const l of lines) {
    const m = l.match(CODE_RE);
    if (m) return m[1];
  }
  return null;
}

// Magic-link. Ссылок в письме десятки (юридический футер, «управление подпиской»,
// картинки-трекеры), поэтому сначала ищем действие по ключевым словам, а «первую попавшуюся»
// берём только из того, что осталось после отсева шумных доменов.
const LINK_ACTION_RE = /(verify|confirm|activate|magic|signin|sign-in|login|token|approve|reset|onetime|otp)/i;
const LINK_NOISE_RE = /(aka\.ms\/|privacy|unsubscribe|policies|support\.microsoft|go\.microsoft|\.png|\.gif|\.jpg)/i;
function pickLink(urls, text) {
  const all = (urls || []).filter(u => /^https?:\/\//i.test(u));
  const fromText = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
  const pool_ = [...all, ...fromText];
  return pool_.find(u => LINK_ACTION_RE.test(u) && !LINK_NOISE_RE.test(u))
    || pool_.find(u => !LINK_NOISE_RE.test(u))
    || null;
}

// ── состояние страницы ────────────────────────────────────────────────────────
async function anyVisibleCount(page, selectors) {
  for (const sel of selectors) {
    const n = await page.locator(sel).first().count().catch(() => 0);
    if (n) return sel;
  }
  return null;
}

// Ждём конечное состояние, а не первый goto: Microsoft гоняет между outlook.live.com и
// login.live.com несколько раз, и «редирект на вход» в первую секунду ещё ничего не значит.
// Решение принимаем только когда на экране список писем ЛИБО форма входа.
async function waitState(page, deadline) {
  let last = '';
  let landingSince = 0;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== last) { last = url; landingSince = 0; dbg('url:', url.replace(/[?#].*$/, '')); }
    if (MAIL_URL_RE.test(url)) {
      const hit = await anyVisibleCount(page, LIST_SELECTORS);
      if (hit) return { state: 'mail', via: hit };
    }
    // Форму входа считаем признаком погасшей сессии на ЛЮБОМ хосте: Microsoft показывает её
    // и на login.live.com, и внутри outlook.live.com.
    if (await anyVisibleCount(page, LOGIN_FORM_SELECTORS)) return { state: 'login' };
    if (LOGIN_URL_RE.test(url)) return { state: 'login' };
    // 🪤 Третий исход: незалогиненного Microsoft уводит не на форму, а на витрину
    // (`outlook.live.com/owa/?nlp=1`, `outlook.com/`). Без этой ветки дашборд получил бы
    // «таймаут» там, где на самом деле «войди в ящик». Держим 10 с, чтобы не спутать с
    // промежуточным редиректом.
    if (LANDING_URL_RE.test(url) && !MAIL_URL_RE.test(url)) {
      if (!landingSince) landingSince = Date.now();
      else if (Date.now() - landingSince > 10000) return { state: 'login' };
    }
    await page.waitForTimeout(1000).catch(() => {});
  }
  return { state: 'timeout' };
}

// ── чтение письма ─────────────────────────────────────────────────────────────
// Список строк писем: берём первый селектор, который что-то нашёл. Порядок в DOM = порядок
// в списке, поэтому «самое свежее» это nth(0) при сортировке по умолчанию (новые сверху).
async function messageRows(page) {
  for (const sel of ROW_SELECTORS) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    if (n) return { loc, n: Math.min(n, MAX_ROWS), sel };
  }
  return null;
}

async function rowText(loc, i) {
  const row = loc.nth(i);
  const aria = await row.getAttribute('aria-label').catch(() => null);
  const text = await row.innerText({ timeout: 5000 }).catch(() => '');
  return { aria: aria || '', text: text || '' };
}

// from/subject/at — из строки списка. Точной разметки у OWA нет: порядок узлов меняется от
// сборки к сборке, а aria-label собран из тех же кусков через запятую. Поэтому это разбор
// «на глаз» с пустой строкой в качестве ответа по умолчанию — несущее поле только `code`.
const TIME_RE = /\b(\d{1,2}:\d{2}(:\d{2})?\s?([AP]M)?|\d{1,2}[./]\d{1,2}([./]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i;
function describeRow({ aria, text }) {
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const meaty = lines.filter(l => !TIME_RE.test(l) || l.length > 24);
  const at = (String(aria).match(TIME_RE) || lines.map(l => l.match(TIME_RE)).find(Boolean) || [''])[0];
  return { from: meaty[0] || '', subject: meaty[1] || '', at: at || '' };
}

// Тело письма: открываем строку и читаем панель чтения. Клик помечает письмо прочитанным —
// это осознанно: код одноразовый, второй раз его читать незачем, а «прочитано» человеку
// показывает, что дашборд письмо уже забрал.
async function openMessage(page, loc, i) {
  try { await loc.nth(i).click({ timeout: 8000 }); } catch (e) { dbg('клик по письму не прошёл:', e.message.split('\n')[0]); return null; }
  for (const sel of PANE_SELECTORS) {
    const pane = page.locator(sel).first();
    if (!(await pane.count().catch(() => 0))) continue;
    const text = await pane.innerText({ timeout: 8000 }).catch(() => '');
    const links = await pane.locator('a[href^="http"]').evaluateAll(els => els.map(a => a.href)).catch(() => []);
    if (text || links.length) return { text, links, sel };
  }
  dbg('панель чтения не нашлась ни одним селектором');
  return null;
}

// ── запуск ────────────────────────────────────────────────────────────────────
// Ошибку «не тот label» отдаём таким же JSON, как всё остальное: дашборд парсит stdout
// целиком, и стектрейс в этом месте выглядел бы для него как «сервис сломался».
function resolveAccount() {
  const arr = pool.load();
  if (!labelArg) return null;
  return arr.find(a => pool.profileLabel(a.id) === label) || null;
}

// Headless-Chromium честно пишет `HeadlessChrome` в User-Agent, а Microsoft на такую
// сессию отвечает иначе. Подменяем через CDP, а не опцией launch: подставляем СВОЙ же UA с
// вырезанным словом, поэтому версия браузера всегда совпадает с настоящей. Тем же вызовом
// отключаем HTTP-кеш профиля — 404 на бандле OWA, осевший в кеше, иначе даёт белый экран
// навсегда, и код «не находится» при живой сессии.
async function prepare(page) {
  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (/Headless/i.test(ua)) {
      await cdp.send('Network.setUserAgentOverride', { userAgent: ua.replace(/HeadlessChrome/gi, 'Chrome') });
      dbg('UA без Headless выставлен');
    }
  } catch (e) { dbg('подготовка страницы частично не прошла:', e.message.split('\n')[0]); }
}

async function main() {
  const rec = resolveAccount();
  if (!rec) {
    dbg(labelArg ? `в пуле нет ящика с label "${label}" (${pool.FILE})` : 'label не передан: node outlook/read-code.js acct_<id>');
    await bail({ ok: false, error: labelArg ? `unknown_label: ${label}` : 'no_label' }, 1);
  }
  if (!fs.existsSync(profileDir)) {
    dbg(`профиля нет: ${profileDir} — ящик ни разу не открывали`);
    await bail({ ok: false, error: 'session_expired' }, 3);   // лечится тем же: открыть ящик и войти
  }

  const deadline = Date.now() + TIMEOUT_MS - 5000;   // 5 с резерва на закрытие браузера
  dbg(`ящик ${rec.email || accountId}, профиль ${profileDir}`);

  try {
    // 🪤 Профиль может быть открыт видимым окном open-session.js. Замер 31.08 на
    // Playwright 1.60: второй persistent-контекст на том же каталоге поднимается без
    // ошибки блокировки, то есть читать код при открытом окне можно. Если Chromium всё же
    // откажется стартовать — это не «кода нет», а отдельная причина, её и печатаем.
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    await bail({ ok: false, error: `launch_failed: ${e.message.split('\n')[0]}` }, 1);
  }

  const page = ctx.pages()[0] || await ctx.newPage();
  await prepare(page);
  await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch(e => dbg('первая навигация оборвалась (редирект Microsoft — это штатно):', e.message.split('\n')[0]));

  const st = await waitState(page, deadline);
  if (st.state === 'login') {
    dbg('сессия погасла: Microsoft показывает вход');
    await bail({ ok: false, error: 'session_expired' }, 3);
  }
  if (st.state !== 'mail') {
    dbg(`почта не открылась за ${Math.round(TIMEOUT_MS / 1000)} с, последний адрес: ${page.url()}`);
    await bail({ ok: false, error: 'timeout' }, 2);
  }
  dbg('список писем на экране, селектор:', st.via);

  const rows = await messageRows(page);
  if (!rows) {
    dbg('список открылся, но строк писем в нём нет — пустой ящик или папка ещё грузится');
    await bail({ ok: false, error: 'no_messages' }, 1);
  }

  // Адрес самого ящика — «мимо» при поиске кода: его цифры матчатся раньше настоящих.
  const target = String(rec.email || process.env.OL_EMAIL || '').trim();
  const first = await rowText(rows.loc, 0);
  const meta = describeRow(first);

  // Порядок ровно такой: тема → превью строки → тело письма.
  let code = codeFrom(meta.subject, target) || codeFrom(`${first.aria}\n${first.text}`, target);
  let link = null;

  const opened = await openMessage(page, rows.loc, 0);
  if (opened) {
    // Печатаем, ЧЕМ прочитали тело: `[role="main"]` — последний рубеж, в него попадает и
    // список писем, то есть код мог прийти из соседнего письма. По этой строке в stderr
    // такой случай видно, а не приходится гадать.
    dbg('панель чтения:', opened.sel, `(${(opened.text || '').length} символов, ссылок ${opened.links.length})`);
    link = pickLink(opened.links, opened.text);
    if (!code) code = codeFrom(opened.text, target);
  }

  // Кода в самом свежем письме может не быть (сверху лежит реклама Microsoft, которая
  // приходит в тот же момент). Смотрим ещё две строки — по превью, без открытия.
  for (let i = 1; i < rows.n && !code; i++) {
    const r = await rowText(rows.loc, i);
    const c = codeFrom(`${r.aria}\n${r.text}`, target);
    if (c) {
      code = c;
      Object.assign(meta, describeRow(r));
      dbg(`код нашёлся в письме #${i + 1}, а не в самом свежем`);
    }
  }

  if (!code) {
    dbg('шестизначного кода нет ни в теме, ни в теле, ни в двух письмах ниже');
    dbg('верхнее письмо:', `${meta.from} | ${meta.subject} | ${meta.at}`);
    await bail({ ok: false, error: 'no_code' }, 1);
  }

  emit({ ok: true, code, from: meta.from, subject: meta.subject, at: meta.at, link });
  try { await Promise.race([ctx.close(), new Promise(r => setTimeout(r, 3000))]); } catch { /* всё равно выходим */ }
  process.exit(0);
}

// Сторож общего таймаута: 60 с считаются от старта процесса, а не от навигации — зависнуть
// может и запуск браузера, а дашборд ждёт одну строку JSON в любом случае.
// Запуск под `require.main`, чтобы разбор кода и ссылок можно было проверить из теста, не
// поднимая браузер (`require('./read-code.js').codeFrom(...)`).
if (require.main === module) {
  const watchdog = setTimeout(() => {
    dbg('сторож: 60 с вышли');
    bail({ ok: false, error: 'timeout' }, 2);
  }, TIMEOUT_MS);
  watchdog.unref?.();

  main().catch(async (err) => {
    dbg('исключение:', err.stack || err.message);
    await bail({ ok: false, error: String(err.message || err).split('\n')[0] }, 1);
  });
}

module.exports = { codeFrom, usefulLines, pickLink, describeRow };
