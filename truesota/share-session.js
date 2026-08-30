// truesota/share-session.js
//
// Снимает «живую» сессию аккаунта TrueSOTA в Playwright storageState-формате
// (cookies GitHub + localStorage панели) в truesota/sessions/<label>.json.
//
// Использование:
//   node truesota/share-session.js <label>
//     label — имя профиля (папка truesota/profiles/<label>/)
//
// 🪤 Отличие от seekai/share-session.js — ОДНА НАВИГАЦИЯ, и она обязательна.
// У New-API сессия жила в куке, и снимок пустого контекста её забирал. У sub2api
// (`true-sota.com`) вход держится на JWT в **localStorage** (`auth_token`,
// `refresh_token`), а `storageState()` отдаёт localStorage только тех origin'ов,
// которые в этом контексте открывались. Без goto снимок уносит куки GitHub и
// НИ ОДНОГО токена панели — то есть у получателя аккаунт «есть», а войти нельзя.
//
// Код возврата: 0 = снимок сохранён, 2 = профиль занят, 3 = снимок пустой, 1 = ошибка.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const ROOT_URL = 'https://true-sota.com/';

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');
const profileDir = path.join(PROFILES_DIR, label);
const outFile = path.join(SESSIONS_DIR, label + '.json');

const SNAP_DELAY_MS = Number(process.env.SNAP_DELAY_MS || 5000);

function isFreshProfile() {
  try {
    const prefs = path.join(profileDir, 'Default', 'Preferences');
    return !fs.existsSync(prefs);
  } catch { return true; }
}

async function main() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const fresh = isFreshProfile();

  console.log(`📸 Снимаю сессию профиля: ${profileDir}`);
  if (fresh) {
    console.log('⚠️  Профиль ещё не создан (браузер аккаунта ни разу не открывался).');
    console.log('    Снимок будет пустым — получателю придётся залогиниться самому.');
  }

  // headless:true тоже падает, если профиль держит другой процесс — это и есть
  // наша проверка занятости.
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    const msg = String(e.message);
    if (/lock|in use|already open|profile|ProcessSingleton/i.test(msg)) {
      console.error(`❌ Профиль занят: ${msg}`);
      console.error('    Похоже, браузер аккаунта открыт. Закрой его (Ctrl+C в его окне) и попробуй снова.');
      process.exit(2);
    }
    throw e;
  }

  try {
    // Открываем панель: без этого localStorage с JWT в снимок не попадёт (см. шапку).
    const page = context.pages()[0] || await context.newPage();
    await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => {
      console.log(`⚠️  панель не открылась (${e.message.split('\n')[0]}) — снимаю что есть`);
    });
    await new Promise(r => setTimeout(r, SNAP_DELAY_MS));
    const state = await context.storageState();
    fs.writeFileSync(outFile, JSON.stringify(state, null, 2), 'utf8');
    const cookieCount = (state.cookies || []).length;
    const originCount = (state.origins || []).length;
    // Токен панели в снимке — отдельная строка: именно он решает, войдёт получатель
    // или нет, и его отсутствие обязано быть видно в логах дашборда, а не «cookies 42».
    const panel = (state.origins || []).find(o => /true-sota\.com$/i.test(String(o.origin || '').replace(/^https?:\/\//, '')));
    const hasToken = !!(panel && (panel.localStorage || []).some(e => e.name === 'auth_token' && e.value));
    console.log(`✅ Сессия сохранена: ${outFile}`);
    console.log(`   cookies: ${cookieCount}, origins: ${originCount}, токен панели: ${hasToken ? 'есть' : 'НЕТ'}`);
    process.exit(cookieCount > 0 || originCount > 0 ? 0 : 3);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
