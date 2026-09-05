// outlook/open-session.js
//
// Открывает видимый Chromium с профилем КОНКРЕТНОГО ящика Outlook и доводит человека до
// входа в веб-почту (https://outlook.live.com/mail/0/). Как только почта открылась —
// снимает storageState в outlook/sessions/<id>.json, ставит `sessionAt` в пуле и оставляет
// окно жить: закрывает его человек.
//
// Зачем ящику браузер, если у него есть пароль: живая проба 31.08 —
// `outlook.office365.com:993` отвечает `AUTH=XOAUTH2 LOGINDISABLED`, базовой авторизации у
// Microsoft больше нет. IMAP по паролю невозможен, письмо с кодом читается только из
// залогиненной сессии (разбор — routing/lib/outlook-pool.js). Пароль здесь — не доступ к
// почте, а то, чем человек один раз входит в профиль; дальше живёт кука.
//
// Сценарий:
//   1. В дашборде на карточке ящика жмёшь «Открыть ящик».
//   2. Открывается Chromium с профилем outlook/profiles/acct_<id>/ (на ящик).
//   3. Скрипт подставляет OL_EMAIL, жмёт «Далее», подставляет OL_PASS — и ОСТАНАВЛИВАЕТСЯ.
//      Сабмит пароля не жмём осознанно: у Microsoft на этом шаге бывает капча,
//      «Проверьте, это вы?», код на резервную почту и «Остаться в системе?». Человек
//      проходит это быстрее, чем автоматика успевает распознать, что именно спросили.
//   4. Профиль пишется на диск сам (launchPersistentContext) — на следующих открытиях
//      почта поднимается без пароля.
//
// Использование:
//   OL_EMAIL=… OL_PASS=… node outlook/open-session.js acct_<id>
//   Креды ТОЛЬКО переменными среды: argv видно в диспетчере задач. Если переменных нет —
//   берём пару из самой записи пула (это тот же файл, новых секретов не появляется).
//
// Коды возврата: 0 — окно открылось и было закрыто штатно, 1 — ошибка,
//                2 — таймаут ожидания входа (10 мин), 3 — label не найден в пуле.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const pool = require('../routing/lib/outlook-pool.js');

// Личная почта живёт на outlook.live.com. Студенческие ящики из пула (`kind: 'student'`,
// домены *.edu) — это арендаторы M365, и Microsoft уводит их на outlook.office.com или
// outlook.cloud.microsoft. Поэтому «мы внутри» проверяется шаблоном хостов, а не строкой:
// иначе на школьном ящике скрипт висел бы десять минут на открытой почте.
const MAIL_URL = 'https://outlook.live.com/mail/0/';
const MAIL_URL_RE = /^https?:\/\/(outlook\.(live|office|office365)\.com|outlook\.cloud\.microsoft)\/mail/i;
// Витрина, куда Microsoft уводит НЕзалогиненного (замер 31.08: с чистого профиля
// `outlook.live.com/mail/0/` кончается на `microsoft.com/…/outlook/email-and-calendar-…`).
// Формы входа там нет — только кнопка «Войти», поэтому это отдельный третий исход.
const LANDING_URL_RE = /^https?:\/\/([^/]*\.)?(microsoft\.com|outlook\.com|outlook\.live\.com\/(owa|$))/i;
const LOGIN_PROBE_URL = 'https://login.live.com/';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на ручной догон капчи/кода

// Признак «список писем на экране». Всё по ролям ARIA и служебным атрибутам, ни одного
// текста: язык интерфейса у купленного ящика какой угодно, и подпись «Список сообщений»
// на румынском не совпадёт. `div[role="listbox"]` в конце — пустой ящик: писем нет, но
// список есть, и это тоже «мы внутри».
const MAIL_LIST_SELECTORS = [
  'div[role="listbox"] div[role="option"]',
  'div[role="option"][data-convid]',
  '[data-convid]',
  '[data-app-section="MessageList"]',
  '#MailList',
  'div[role="listbox"]',
];

// Форма входа Microsoft ПЕРЕПИСАНА (Fluent v2) — замер живой страницы login.live.com
// 31.08.2026: поле адреса это `#usernameEntry` (`type=email`, `autocomplete="username
// webauthn"`), кнопка — `[data-testid="primaryButton"]` с текстом Next, а старых
// `loginfmt` / `#i0116` / `#idSIButton9` на странице НЕТ ВООБЩЕ (count=0). Старые селекторы
// оставлены в хвосте: часть арендаторов и часть путей до сих пор отдают легаси-страницу.
// 🪤 Проверка видимости обязательна из-за легаси-варианта: там поля обеих страниц лежат в
// DOM одновременно, и пароль «подставился» бы в скрытое поле страницы адреса. На новой
// странице в DOM ровно один input, но проверка от этого не мешает.
// 🪤 Кнопка «Далее» и кнопка «Вход» — ОДИН И ТОТ ЖЕ селектор `primaryButton`. Поэтому
// клик делается ровно один раз, сразу после адреса: второй клик по тому же селектору
// отправил бы пароль, а этого делать нельзя (капча и «Проверьте, это вы?» — за человеком).
const EMAIL_SELECTORS = ['#usernameEntry', 'input[name="loginfmt"]', 'input[type="email"]', 'input[autocomplete~="username"]', '#i0116'];
const NEXT_SELECTORS = ['[data-testid="primaryButton"]', '#idSIButton9', 'button[type="submit"]', 'input[type="submit"]'];
// Страницу пароля живьём без настоящего аккаунта не увидеть, поэтому селекторы сверены по
// бандлу самой формы (31.08): `passwordEntry`, `primaryButton` и `current-password` в нём
// есть, `i0118` и `idSIButton9` — нет ни в одном из четырёх скриптов. Легаси-варианты стоят
// последними именно поэтому: это уже не «второй живой путь», а страховка.
const PASS_SELECTORS = ['#passwordEntry', 'input[autocomplete="current-password"]', 'input[name="passwd"]', 'input[type="password"]', '#i0118'];

const labelArg = String(process.argv[2] || '').trim();
const label = labelArg.replace(/[^\w-]/g, '_');
// id ящика — это label без префикса: outlook/sessions/<id>.json, запись пула по id.
const accountId = label.replace(/^acct_/, '');
const profileDir = path.join(pool.PROFILES_DIR, label);

// Окно живёт до закрытия человеком: обещание резолвится только на событии контекста.
function holdOpen(context) {
  return new Promise((resolve) => { context.on('close', resolve); });
}

function isFreshProfile() {
  try { return !fs.existsSync(path.join(profileDir, 'Default', 'Preferences')); } catch { return true; }
}

// Первый видимый локатор из списка кандидатов или null. Ошибки навигации глотаем: страница
// Microsoft переезжает между хостами прямо под руками, и `isVisible` на такой странице
// падает «Execution context was destroyed» — это не поломка, а повод посмотреть ещё раз.
async function visible(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 500 })) return loc;
    } catch { /* следующий кандидат */ }
  }
  return null;
}

// Chromium кеширует и 404-ответы: если на `/…/bootstrap.js` OWA однажды прилетел 404
// (деплой Microsoft, затык прокси), он оседает в кеше профиля — и почта больше не
// поднимается НИКОГДА, белый экран при живых куках (поймано на New-API-фронтах 17.08,
// движок кеша тот же). Кеш профиля чистить вслепую нельзя — ходим мимо него.
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

// «Мы внутри» = адрес почтовый И на экране список писем. Одного URL мало: `mail/0/` держится
// в адресной строке и в момент, когда SPA только поднимается, а редирект на вход Microsoft
// делает уже из скрипта — по одному URL скрипт рапортовал бы успех на пустой оболочке.
async function insideMailbox(page) {
  try {
    if (!MAIL_URL_RE.test(page.url())) return false;
    for (const sel of MAIL_LIST_SELECTORS) {
      if (await page.locator(sel).first().count().catch(() => 0)) return true;
    }
  } catch { /* страница переезжает — посмотрим на следующем круге */ }
  return false;
}

// Предполётная проверка: жив ли вход Microsoft с этой машины. Ответ не блокирует открытие,
// но в Server Logs видно разницу между «Microsoft не отвечает» и «человек не дошёл до конца».
async function preflight() {
  try {
    const r = await fetch(LOGIN_PROBE_URL, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
    return { ok: true, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Снимок сессии — резервная копия на случай, если профиль занят или переехал: читает код
// (outlook/read-code.js) сам профиль, а не этот файл. Снимаем один раз, сразу после входа:
// перехватить закрытие окна нельзя — контекста в этот момент уже нет.
async function snapshotSession(context) {
  fs.mkdirSync(pool.SESSIONS_DIR, { recursive: true });
  const p = path.join(pool.SESSIONS_DIR, accountId + '.json');
  await context.storageState({ path: p });
  return p;
}

// sessionAt ставим ПЕРЕЧИТАННЫМ пулом: пока окно открыто, дашборд мог поменять статус или
// добавить ящик, а save() пишет массив целиком — держать в памяти старую копию значит
// затирать чужие правки.
function markSession() {
  const arr = pool.load();
  const rec = arr.find(a => String(a.id) === accountId);
  if (!rec) return false;
  rec.sessionAt = new Date().toISOString();
  pool.save(arr);
  return true;
}

// Запись пула по label. Отсутствие записи — не стектрейс, а внятная строка: скрипт зовут и
// руками, и опечатка в label не должна выглядеть падением Playwright.
function resolveAccount() {
  const arr = pool.load();
  if (!labelArg) {
    console.error('❌ Не передан label ящика. Использование: node outlook/open-session.js acct_<id>');
    if (arr.length) console.error(`   Есть в пуле: ${arr.slice(0, 8).map(a => pool.profileLabel(a.id)).join(', ')}`);
    process.exit(3);
  }
  const rec = arr.find(a => pool.profileLabel(a.id) === label);
  if (!rec) {
    console.error(`❌ Ящик с label "${label}" в пуле не найден (${pool.FILE}).`);
    if (!arr.length) console.error('   Пул пуст: заведи ящик в дашборде (вкладка Outlook), потом открывай.');
    else console.error(`   Есть в пуле: ${arr.slice(0, 8).map(a => pool.profileLabel(a.id)).join(', ')}${arr.length > 8 ? ` … и ещё ${arr.length - 8}` : ''}`);
    process.exit(3);
  }
  return rec;
}

// Креды: сначала переменные среды (так их передаёт дашборд), иначе — пара из записи пула.
function credentials(rec) {
  const envEmail = String(process.env.OL_EMAIL || '').trim();
  const envPass = String(process.env.OL_PASS || '');
  if (envEmail || envPass) {
    return { email: envEmail || String(rec.email || '').trim(), pass: envPass, src: 'переменные среды' };
  }
  return { email: String(rec.email || '').trim(), pass: String(rec.password || ''), src: 'запись пула' };
}

// 🪤 Microsoft уводит на login.live.com и обратно несколько раз (consumer-редирект, KMSI
// «Остаться в системе?», у школьных ящиков ещё и login.microsoftonline.com). Поэтому форму
// заполняем НЕ после первого `goto`, а из того же цикла, который ждёт конечное состояние:
// поле появилось — подставили, страница переехала — ждём дальше. Каждое поле заполняем один
// раз: если Microsoft снова показал адрес, значит он ему не понравился, и повторная
// подстановка того же значения только затрёт то, что правит человек.
async function waitForMailbox(page, creds) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let filledEmail = false, filledPass = false, lastStage = '';
  let landingSince = 0, landingSaid = false;
  while (Date.now() < deadline) {
    if (await insideMailbox(page)) return { ok: true, prefilled: filledEmail || filledPass };

    const stage = page.url().replace(/[?#].*$/, '');
    if (stage !== lastStage) { lastStage = stage; landingSince = 0; console.log(`   … ${stage}`); }

    // 🪤 Третий исход помимо почты и формы: витрина Microsoft без единого поля ввода.
    // Молча ждать тут десять минут нельзя — человек не поймёт, чего от него хотят.
    if (!landingSaid && LANDING_URL_RE.test(stage) && !MAIL_URL_RE.test(stage)) {
      if (!landingSince) landingSince = Date.now();
      else if (Date.now() - landingSince > 15000) {
        landingSaid = true;
        console.log('⚠️  Microsoft показывает витрину Outlook, а не почту: сессии в профиле нет.');
        console.log('   Нажми в окне «Войти» / «Sign in» — как дойдёшь до формы, подставлю креды сам.');
      }
    }

    if (!filledEmail && creds.email) {
      const field = await visible(page, EMAIL_SELECTORS);
      if (field) {
        try {
          await field.fill(creds.email);
          const next = await visible(page, NEXT_SELECTORS);
          if (next) await next.click({ timeout: 5000 });
          else await field.press('Enter');   // кнопку не нашли — отправляем поле Enter'ом
          filledEmail = true;
          console.log(`🔐 Адрес подставлен (${creds.src}) и нажато «Далее».`);
        } catch (e) { console.log(`ℹ️  адрес подставить не удалось (${e.message.split('\n')[0]}) — введи руками.`); filledEmail = true; }
      }
    }

    if (!filledPass && creds.pass) {
      const field = await visible(page, PASS_SELECTORS);
      if (field) {
        try {
          await field.fill(creds.pass);
          filledPass = true;
          console.log('🔐 Пароль подставлен. Кнопку входа НЕ нажимаю: дальше Microsoft может');
          console.log('   спросить капчу, «Проверьте, это вы?» или код на резервную почту — допройди сам.');
        } catch (e) { console.log(`ℹ️  пароль подставить не удалось (${e.message.split('\n')[0]}) — введи руками.`); filledPass = true; }
      }
    }

    await page.waitForTimeout(1500).catch(() => {});
  }
  return { ok: false, prefilled: filledEmail || filledPass };
}

async function main() {
  const rec = resolveAccount();          // выходит с кодом 3, если label не тот
  const creds = credentials(rec);
  fs.mkdirSync(pool.PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();

  console.log('🚀 Запускаю Chromium (видимый режим)…');
  console.log(`📬 ящик: ${rec.email || '(адреса в записи нет)'} · ${rec.kind || 'personal'} · id=${accountId}`);
  console.log(`📂 профиль ящика: ${profileDir} · ${fresh ? 'чистый (нужен вход)' : 'уже есть (сохранённый)'}`);
  if (!creds.email && !creds.pass) {
    console.log('⚠️  Ни OL_EMAIL/OL_PASS, ни пары в записи пула — форму заполняешь руками.');
  } else if (!creds.pass) {
    console.log('ℹ️  Пароля нет — подставлю только адрес.');
  }

  const pre = await preflight();
  console.log(pre.ok
    ? `🛰️  login.live.com отвечает HTTP ${pre.status}`
    : `⚠️  login.live.com не ответил (${pre.error}) — окно всё равно открою, но вход может не пройти`);

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  await disableHttpCache(context, page);

  try {
    console.log(`🎯 ${MAIL_URL}`);
    // Первая навигация может не дойти именно потому, что Microsoft редиректит на вход
    // прямо в процессе: это штатно, конечное состояние ловит waitForMailbox.
    await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded' })
      .catch(e => console.log(`ℹ️  первая навигация оборвалась редиректом (${e.message.split('\n')[0]}) — жду конечное состояние`));

    const res = await waitForMailbox(page, creds);
    if (!res.ok) {
      console.error('❌ Таймаут ожидания входа (10 мин): список писем так и не появился.');
      console.error(`   Последний адрес: ${page.url()}`);
      console.error('   Если Microsoft просил код на резервную почту или капчу — открой ящик заново и допройди.');
      process.exit(2);
    }

    console.log(res.prefilled
      ? '✅ Почта открылась — вход прошёл, профиль сохранён на диск.'
      : '✅ Профиль восстановлен: почта открылась без входа, в форму не лазил.');

    try {
      const p = await snapshotSession(context);
      console.log(`💾 снимок сессии: ${p}`);
    } catch (e) {
      console.log(`⚠️  снимок сессии не снялся (${e.message.split('\n')[0]}) — read-code читает сам профиль, это не блокер`);
    }
    console.log(markSession()
      ? '🕒 sessionAt в пуле обновлён.'
      : '⚠️  запись пула исчезла, пока открывалось окно — sessionAt не обновил.');

    console.log('   Окно оставляю открытым — закрой его сам, когда закончишь.');
    await holdOpen(context);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
