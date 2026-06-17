// record_fm.js — открывает FreeModel-сессию в видимом браузере и делает
// дампы HTML + скриншоты каждые N секунд (или по нажатию Enter в консоли).
//
// Запуск: node freemodel/record_fm.js "manual_sessions/.../ИМЯ" [/api-keys]
//
// Дампы сохраняются в recordings/fm-YYYYMMDD-HHMMSS/

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const [, , sessionDir, pagePath] = process.argv;
if (!sessionDir) {
  console.error('Использование: node freemodel/record_fm.js <путь к сессии> [путь на сайте]');
  process.exit(1);
}

const SESSION_FILE = path.join(sessionDir, 'session.json');
if (!fs.existsSync(SESSION_FILE)) {
  console.error(`session.json не найден в ${sessionDir}`);
  process.exit(1);
}

const TARGET = pagePath || '/dashboard/api-keys';
const BASE_URL = 'https://freemodel.dev';
const OUT_DIR = path.join('recordings', `fm-${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}`);

const EN_OPTS = {
  locale: 'en-US',
  extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
};

let snapshotIdx = 0;
let page = null;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function dumpNow() {
  if (!page) return;
  const idx = String(snapshotIdx++).padStart(3, '0');
  try {
    // HTML дамп
    const html = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, `snap_${idx}_page.html`), html, 'utf-8');

    // Скриншот
    await page.screenshot({ path: path.join(OUT_DIR, `snap_${idx}_page.png`), fullPage: true });

    // Текстовый дамп body.innerText для быстрого просмотра
    const text = await page.locator('body').innerText().catch(() => '(error)');
    fs.writeFileSync(path.join(OUT_DIR, `snap_${idx}_text.txt`), text, 'utf-8');

    // URL на момент дампа
    fs.writeFileSync(path.join(OUT_DIR, `snap_${idx}_url.txt`), page.url(), 'utf-8');

    console.log(`[${idx}] дамп сохранён — ${page.url()}`);
  } catch (e) {
    console.error(`[${idx}] ошибка дампа: ${e.message}`);
  }
}

async function main() {
  ensureDir(OUT_DIR);
  console.log(`Дампы → ${OUT_DIR}\n`);

  // Сохраняем инфо о сессии
  const info = { session: sessionDir, target: TARGET, base: BASE_URL, started: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT_DIR, '_info.json'), JSON.stringify(info, null, 2), 'utf-8');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: SESSION_FILE, ...EN_OPTS });
  page = await context.newPage();

  // Авто-дамп каждые 5 секунд
  const autoInterval = setInterval(dumpNow, 5000);

  await page.goto(BASE_URL + TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`Открыто: ${BASE_URL}${TARGET}\n`);
  await dumpNow();

  console.log('— Записываю. Дамп каждые 5 сек.');
  console.log('  Нажми Enter в этой консоли для ручного дампа.');
  console.log('  Набери "q" + Enter для выхода.\n');

  // Ручной дамп по Enter, выход по "q"
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    const line = chunk.trim().toLowerCase();
    if (line === 'q' || line === 'quit' || line === 'exit') {
      clearInterval(autoInterval);
      await dumpNow();
      console.log('\nЗавершаю...');
      await browser.close();
      console.log(`Дампы сохранены в ${OUT_DIR}`);
      process.exit(0);
    } else {
      await dumpNow();
      console.log('  (Enter — ещё дамп, q — выход)');
    }
  });

  // Если браузер закрыли вручную
  browser.on('disconnected', () => {
    clearInterval(autoInterval);
    console.log('\nБраузер закрыт.');
    console.log(`Дампы сохранены в ${OUT_DIR}`);
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
