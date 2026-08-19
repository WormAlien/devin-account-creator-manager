// github/harvest-session.js
//
// Снимает GitHub-сессию из ЛЮБОГО профиля Chromium в формате Playwright storageState
// и пишет её в указанный файл.
//
// Отличие от <provider>/share-session.js: тот умеет только свой профиль по label
// (tabi/profiles/<label>), а сессия нужного GitHub-аккаунта может лежать в профиле
// любого модуля — поэтому здесь принимаем путь целиком.
//
// Использование:
//   node github/harvest-session.js <profileDir> <outFile>
//
// Зачем через Playwright, а не чтением БД профиля: атрибуты кук
// (path/secure/httpOnly/sameSite/expires) в storageState приходят от самого Chromium.
// Синтезировать их нельзя — среди семи GitHub-кук есть __Host-user_session_same_site,
// а __Host--префикс требует Secure + Path=/ + host-only, и Chromium отвергнет куку,
// собранную неправильно.
//
// Профиль открывается headless. Если он занят открытым браузером — Playwright падает,
// ловим и выходим с понятным кодом (заодно это и есть проверка занятости).
//
// Живость сессии проверяем ЗДЕСЬ ЖЕ, навигацией на /settings/profile, и это единственное
// допустимое место для такой проверки. Сырым https.request с самодельным User-Agent
// ходить нельзя: 2026-08-19 три сессии (impeccableso, serpentinesep, lankymapping) после
// такой «проверки» получили от GitHub 302 → /login, то есть были погашены как угон, а два
// аккаунта, которых проба не касалась, остались живы. Здесь UA настоящий, браузерный —
// GitHub видит обычный визит. Плюс запуск профиля всё равно нужен для снимка, так что
// проверка ничего не стоит.
//
// Коды возврата: 0 = снимок сохранён, 2 = профиль занят, 3 = живой GitHub-сессии нет.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const profileDir = process.argv[2];
const outFile = process.argv[3];

if (!profileDir || !outFile) {
  console.error('❌ Использование: node github/harvest-session.js <profileDir> <outFile>');
  process.exit(1);
}
if (!fs.existsSync(profileDir)) {
  console.error(`❌ Профиля нет на диске: ${profileDir}`);
  process.exit(1);
}

const SNAP_DELAY_MS = Number(process.env.SNAP_DELAY_MS || 2000);
// Страница настроек требует авторизации: анонима она уводит на /login. Дешёвый и точный
// индикатор «сессия ещё жива», и в отличие от корня github.com не отдаёт 200 всем подряд.
const CHECK_URL = 'https://github.com/settings/profile';

// Фильтр на github.com — ОБЯЗАТЕЛЕН, не косметика.
//
// Профиль-источник почти всегда принадлежит какому-то провайдеру, и его собственные
// куки (session / new_api_refresh) в снимке не нужны: в лучшем случае они утекут в
// чужой профиль, в худшем — если источник с ТОГО ЖЕ хоста, куда заселяем, — залогинят
// нас в УЖЕ СУЩЕСТВУЮЩИЙ аккаунт вместо создания нового.
function isGithubDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'github.com' || d.endsWith('.github.com');
}
function isGithubOrigin(origin) {
  try { return isGithubDomain(new URL(origin).hostname); } catch { return false; }
}

async function main() {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  console.log(`📸 Снимаю GitHub-сессию из профиля: ${profileDir}`);

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    const msg = String(e.message || '');
    if (/lock|in use|already open|profile/i.test(msg)) {
      console.error(`❌ Профиль занят: ${msg}`);
      console.error('    Похоже, браузер этого профиля открыт. Закрой его и попробуй снова.');
      process.exit(2);
    }
    throw e;
  }

  try {
    const page = context.pages()[0] || await context.newPage();

    // Сначала живость, потом снимок: мёртвую сессию кешировать нельзя — заселим ею
    // профиль, браузер откроется и снова попросит пароль, а причина будет не видна.
    await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded' }).catch(e => {
      console.log(`⚠️  навигация не задалась: ${e.message}`);
    });
    const alive = !/\/login/.test(page.url());
    const pageLogin = await page.evaluate(() => {
      const m = document.querySelector('meta[name="user-login"]');
      if (m && m.content) return m.content;
      const el = document.querySelector('[data-login]');
      return el ? el.getAttribute('data-login') : null;
    }).catch(() => null);

    if (!alive) {
      console.error('❌ Сессия мертва: GitHub увёл на страницу входа.');
      console.error('    Залогинься в этом аккаунте один раз через вкладку GitHub («Открыть GitHub»).');
      process.exit(3);
    }
    console.log(`🔓 сессия жива${pageLogin ? ` (${pageLogin})` : ''}`);

    // Даём Chromium'у досинхронизировать банку кук после навигации.
    await new Promise(r => setTimeout(r, SNAP_DELAY_MS));
    const state = await context.storageState();

    const cookies = (state.cookies || []).filter(c => isGithubDomain(c.domain));
    const origins = (state.origins || []).filter(o => isGithubOrigin(o.origin));

    const login = pageLogin || (cookies.find(c => c.name === 'dotcom_user') || {}).value || null;
    const hasUserSession = cookies.some(c => c.name === 'user_session' && c.value);

    const dropped = (state.cookies || []).length - cookies.length;
    console.log(`   github-кук: ${cookies.length} (отброшено чужих: ${dropped}), origins: ${origins.length}`);
    console.log(`   логин: ${login || '—'} · user_session: ${hasUserSession ? 'есть' : 'НЕТ'}`);

    if (!hasUserSession) {
      console.error('❌ В профиле нет куки user_session — заселять нечем.');
      process.exit(3);
    }

    fs.writeFileSync(outFile, JSON.stringify({
      seed: 'github',
      ghLogin: login,
      harvestedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      source: profileDir,
      cookies, origins,
    }, null, 2) + '\n', 'utf8');

    console.log(`✅ Снимок сохранён: ${outFile}`);
    process.exit(0);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
