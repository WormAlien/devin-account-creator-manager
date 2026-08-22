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
//   node github/open-session.js <label> [targetUrl] [seedFile]
//     label     — идентификатор аккаунта (папка github/profiles/<label>/)
//     targetUrl — куда идти вместо страницы логина; только https://github.com/…
//                 Так работает кнопка ⭐ в менеджере гитхабов: она ведёт сразу на
//                 репозиторий, где остаётся нажать Star.
//     seedFile  — снимок storageState (github/sessions/<ghId>.json): вливаем в ЧИСТЫЙ
//                 профиль, чтобы аккаунт был залогинен без пароля и 2FA.
//
// Зачем seedFile. Персональных профилей на диске почти нет — один на 36 аккаунтов
// менеджера, — а живые куки есть: их снял харвест из профилей шлюзов
// (github/harvest-session.js → github/sessions/<ghId>.json, 9–14 github.com-кук).
// Без вливания ⭐ приводила бы на страницу логина, то есть ни к чему.
//
// 🪤 Снимок вливает ТОЛЬКО тот, кто позвал: решение «нужна ли этому профилю сессия»
// принимает дашборд (ghProfileNeedsSession — по индексу профилей, есть ли в профиле живая
// GitHub-кука), и seedFile он передаёт лишь тогда. Свой гейт «профиль пустой» тут стоял и
// был снят 2026-08-22: пустоту он определял по наличию `Default/Preferences`, а Chromium
// создаёт этот файл при первом же запуске независимо от входа — то есть для профиля,
// открытого один раз без успешного логина, снимок не вливался уже никогда.
// Вливать поверх ЖИВОЙ сессии нельзя (в кеше снимок живёт до 7 суток, а `_gh_sess`
// GitHub ротирует постоянно), поэтому звать скрипт с seedFile по залогиненному профилю —
// ошибка вызывающей стороны.
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

// Целевой URL приходит аргументом, поэтому проверяем его здесь тоже: скрипт зовут и
// руками. Пускаем только https на github.com — в аргументе Chromium любая другая схема
// (file:, chrome:) означает «открой локальный файл в залогиненном профиле».
function validTarget(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('-')) throw new Error(`целевой URL похож на флаг: ${s}`);
  let u;
  try { u = new URL(s); } catch { throw new Error(`целевой URL не разбирается: ${s}`); }
  if (u.protocol !== 'https:') throw new Error(`целевой URL не https: ${s}`);
  if (u.hostname.toLowerCase() !== 'github.com') throw new Error(`целевой URL не на github.com: ${u.hostname}`);
  return u.toString();
}

const seedFile = String(process.argv[4] || '').trim();

function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
}

// Снимок в формате storageState: { cookies, origins }. Форма и разбор — как у
// провайдерских копий (agentrouter/open-session.js:76-94), чтобы файл читался одинаково.
function loadSeed() {
  if (!seedFile) return null;
  try {
    const ss = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    if (!ss || typeof ss !== 'object') return null;
    const cookies = Array.isArray(ss.cookies) ? ss.cookies : [];
    if (!cookies.length) return null;
    return { ghLogin: typeof ss.ghLogin === 'string' ? ss.ghLogin : null, cookies, origins: Array.isArray(ss.origins) ? ss.origins : [] };
  } catch (e) {
    console.log(`⚠️ снимок сессии не прочитался (${e.message}) — открою как обычно`);
    return null;
  }
}

// 🪤 addCookies — «всё или ничего»: одна кука без domain/path роняет ВЕСЬ вызов, и в
// контексте не остаётся ни одной (проверено живым playwright). Поэтому успех кук и успех
// localStorage считаем раздельно: раньше флаг перетирался циклом localStorage, и скрипт
// печатал «влил 12 кук» ровно там, где не влил ни одной — а окно открывалось анонимным.
async function applySeed(context, seed) {
  const out = { cookies: false, storages: 0 };
  if (!seed) return out;
  try {
    await context.addCookies(seed.cookies);
    out.cookies = true;
  } catch (e) {
    console.log(`❌ cookies НЕ применились целиком (addCookies — всё или ничего): ${e.message}`);
    console.log('   страница откроется анонимной: снимок битый, пересними сессию');
  }
  for (const o of (seed.origins || []).filter(x => x.localStorage && x.localStorage.length)) {
    try {
      await context.addInitScript(
        (entries) => { for (const { name, value } of entries) { try { localStorage.setItem(name, value); } catch {} } },
        o.localStorage.map(({ name, value }) => ({ name, value })),
      );
      out.storages++;
    } catch { /* origin может быть невалидным — пропускаем */ }
  }
  return out;
}

// Кто мы на самом деле. 🪤 У анонимной страницы GitHub тег meta[name="user-login"]
// ПРИСУТСТВУЕТ, но с пустым content — проверять надо непустое значение, иначе
// «залогинен» врёт всегда (замерено 2026-08-22 на негативном контроле).
async function whoAmI(page) {
  try {
    const v = await page.getAttribute('meta[name="user-login"]', 'content');
    return v && v.trim() ? v.trim() : null;
  } catch { return null; }
}

// Состояние звезды. 🪤 Кнопка приезжает react-партиалом через 170–300 мс ПОСЛЕ
// domcontentloaded: на DCL в DOM нет ни одной формы /star и ни одной кнопки «Star»,
// так что «звезды нет» соврало бы. Ждём селектор.
async function reportStar(page) {
  try {
    const el = await page.waitForSelector('[data-testid="star-button"]', { timeout: 15000 });
    const aria = (await el.getAttribute('aria-label')) || '';
    if (/^Unstar/i.test(aria)) console.log(`⭐ звезда УЖЕ поставлена этим аккаунтом (${aria})`);
    else if (/^Star/i.test(aria)) console.log(`⭐ звезда ещё не поставлена — нажми кнопку Star (${aria})`);
    else console.log(`⭐ кнопка найдена, состояние неясно: "${aria}"`);
  } catch {
    console.log('⚠️ кнопка звезды не появилась за 15 с — страница не догрузилась или мы не на репозитории');
  }
}

async function main() {
  // Проверяем URL внутри main, а не на верхнем уровне: иначе отказ вылетает стектрейсом
  // до всякого catch, и в Server Logs дашборда вместо одной внятной строки едет простыня.
  const targetUrl = validTarget(process.argv[3]);
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const fresh = isFreshProfile();
  // Вливать или нет — решил вызывающий (он видит индекс профилей и знает, есть ли в этом
  // профиле живая GitHub-кука). Здесь просто применяем то, что дали.
  const seed = loadSeed();

  console.log(`🚀 Запускаю Chromium (видимый режим)…`);
  console.log(`📂 профиль аккаунта: ${profileDir} · ${fresh ? 'чистый (нужен GitHub-логин)' : 'уже есть (сохранённый)'}`);

  // launchPersistentContext держит профиль открытым и пишет на диск всё сам.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Куки — ДО первой навигации, иначе GitHub успеет отдать страницу логина.
  const seeded = await applySeed(context, seed);
  if (seed && seeded.cookies) {
    console.log(`🍪 влил снимок сессии: ${seed.cookies.length} кук${seed.ghLogin ? `, ник ${seed.ghLogin}` : ''}`
      + (seeded.storages ? `, localStorage с ${seeded.storages} origin` : ''));
  }

  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(targetUrl || GITHUB_LOGIN_URL, { waitUntil: 'domcontentloaded' });

    if (targetUrl) {
      const who = await whoAmI(page);
      console.log(who
        ? `✅ залогинен как ${who} · ${page.url()}`
        : `⚠️ НЕ залогинен (страница отдалась анонимной) · ${page.url()} — сессия аккаунта погасла, войди руками`);
      if (who) await reportStar(page);
      console.log('   Браузер открыт — закрой когда закончишь (Ctrl+C).');
      await new Promise(() => {});
      return;
    }

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
