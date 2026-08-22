// justwoker/share-session.js
//
// Снимает «живую» сессию аккаунта JustWoker (cookies GitHub + justwoker + localStorage)
// в Playwright storageState-формате и сохраняет в justwoker/sessions/<label>.json.
//
// Использование:
//   node justwoker/share-session.js <label>
//     label — имя профиля (папка justwoker/profiles/<label>/)
//
// Профиль открывается в headless на ~5 сек (даём приложениям пораздавать куки),
// снимается storageState, профиль закрывается. Если профиль занят открытым
// браузером — Playwright кидает ошибку, ловим и выходим с понятным сообщением.
//
// Код возврата: 0 = снимок сохранён, 2 = профиль занят, 1 = ошибка.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, 'profiles');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

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

  // headless:false невозможно при занятом профиле; headless:true тоже упадёт,
  // если другой процесс держит профиль — это и есть наша проверка занятости.
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    if (/profile|lock|in use|already open|Cannot find module|Target page/i.test(String(e.message))) {
      const busy = /lock|in use|already open|profile/i.test(String(e.message));
      if (busy) {
        console.error(`❌ Профиль занят: ${e.message}`);
        console.error('    Похоже, браузер аккаунта открыт. Закрой его (Ctrl+C в его окне) и попробуй снова.');
        process.exit(2);
      }
    }
    throw e;
  }

  try {
    // Даём сайтам время пораздавать/освежить куки в профиле.
    await new Promise(r => setTimeout(r, SNAP_DELAY_MS));
    const state = await context.storageState();
    fs.writeFileSync(outFile, JSON.stringify(state, null, 2), 'utf8');
    const cookieCount = (state.cookies || []).length;
    const originCount = (state.origins || []).length;
    console.log(`✅ Сессия сохранена: ${outFile}`);
    console.log(`   cookies: ${cookieCount}, origins: ${originCount}`);
    process.exit(cookieCount > 0 || originCount > 0 ? 0 : 3);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});