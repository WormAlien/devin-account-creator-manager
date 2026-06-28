// conduit/record_conduit.js
//
// Открывает conduit.ozdoev.net в ВИДИМОМ браузере с ПЕРСИСТЕНТНЫМ профилем
// (user-data-dir), поэтому Telegram-логин переживает перезапуск скрипта.
//
// Управление — двумя способами:
//   • stdin (если запущен в обычном терминале):  s / d / q  + Enter
//   • trigger-файл  conduit/accounts/<ident>/_cmd.txt  (пишем туда s|d|q) —
//     удобно когда скрипт запущен в фоне и stdin недоступен.
//
//   s → сохранить сессию (storageState) + вытащить sk-cdt- ключ, баланс/план
//   d → дамп HTML+скрин+текст (отладка)
//   q → выход
//
// Запуск:
//   node conduit/record_conduit.js            # ident = conduit_<ts>
//   node conduit/record_conduit.js myname     # ident = myname

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const api = require('./lib/conduit-api');

const BASE_URL = 'https://conduit.ozdoev.net';
const CABINET_URL = `${BASE_URL}/#cabinet`;

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

const ident = (process.argv[2] || `conduit_${ts()}`).replace(/[^A-Za-z0-9_-]/g, '_');
const ACCOUNT_DIR = path.join(__dirname, 'accounts', ident);
const PROFILE_DIR = path.join(ACCOUNT_DIR, '_profile');   // персистентный профиль браузера
const SESSION_FILE = path.join(ACCOUNT_DIR, 'session.json');
const INFO_FILE = path.join(ACCOUNT_DIR, 'account_info.txt');
const DUMP_DIR = path.join(ACCOUNT_DIR, '_dumps');
const CMD_FILE = path.join(ACCOUNT_DIR, '_cmd.txt');

let context = null;   // persistent context (он же browser)
let page = null;
let dumpIdx = 0;
let busy = false;

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

async function dumpNow() {
  if (!page) return;
  ensureDir(DUMP_DIR);
  const idx = String(dumpIdx++).padStart(3, '0');
  try {
    fs.writeFileSync(path.join(DUMP_DIR, `snap_${idx}.html`), await page.content(), 'utf-8');
    await page.screenshot({ path: path.join(DUMP_DIR, `snap_${idx}.png`), fullPage: true });
    const text = await page.locator('body').innerText().catch(() => '(error)');
    fs.writeFileSync(path.join(DUMP_DIR, `snap_${idx}.txt`), text, 'utf-8');
    console.log(`  [dump ${idx}] ${page.url()}`);
  } catch (e) {
    console.error(`  [dump ${idx}] ошибка: ${e.message}`);
  }
}

async function saveSession() {
  if (!context || !page) return;
  ensureDir(ACCOUNT_DIR);
  try {
    if (!/#cabinet/.test(page.url())) {
      await page.goto(CABINET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await context.storageState({ path: SESSION_FILE });
    console.log(`\n✅ сессия сохранена → ${SESSION_FILE}`);

    // Данные берём из /api/me (cookie-fetch), а не скрейпом DOM — там полный ключ.
    const r = await api.getMe(SESSION_FILE);
    const s = r.ok ? api.summarize(r.me) : {};
    const lines = [
      `Ident: ${ident}`,
      `Saved: ${new Date().toISOString()}`,
      `Username: ${s.username || '(?)'}`,
      `Plan: ${s.plan || '(?)'}`,
      `Balance: ${s.balance != null ? '$' + s.balance : '(?)'}`,
      `API Key: ${s.apiKey || '(нет — сессия не залогинена?)'}`,
      `Base URL: ${s.baseUrl || api.API_BASE}`,
      `Referral: ${s.refLink || '(?)'}`,
    ];
    fs.writeFileSync(INFO_FILE, lines.join('\n') + '\n', 'utf-8');
    console.log(lines.join('\n'));
    if (!r.ok) console.log(`\n⚠ /api/me не ответил (${r.status||r.error}) — залогинься в кабинете и снова s.`);
  } catch (e) {
    console.error('save error: ' + e.message);
  }
}

async function handleCmd(raw) {
  const cmd = String(raw || '').trim().toLowerCase();
  if (!cmd || busy) return;
  busy = true;
  try {
    if (cmd === 's') await saveSession();
    else if (cmd === 'd') await dumpNow();
    else if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
      console.log('\nЗавершаю...');
      try { await context.close(); } catch {}
      process.exit(0);
    } else {
      console.log('  s=сохранить  d=дамп  q=выход');
    }
  } finally {
    busy = false;
  }
}

// Watcher trigger-файла: содержимое (s|d|q) → команда, потом файл очищается.
function watchCmdFile() {
  try { fs.writeFileSync(CMD_FILE, '', 'utf-8'); } catch {}
  fs.watchFile(CMD_FILE, { interval: 700 }, () => {
    let v = '';
    try { v = fs.readFileSync(CMD_FILE, 'utf-8'); } catch { return; }
    if (v.trim()) {
      try { fs.writeFileSync(CMD_FILE, '', 'utf-8'); } catch {}
      handleCmd(v);
    }
  });
}

async function main() {
  ensureDir(ACCOUNT_DIR);
  console.log(`Аккаунт → ${ACCOUNT_DIR}`);
  console.log(`Профиль (персистентный) → ${PROFILE_DIR}`);
  console.log(`Trigger-файл → ${CMD_FILE}  (echo s > этот файл)`);
  console.log(`Открываю ${BASE_URL} ...\n`);

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
  });
  page = context.pages()[0] || await context.newPage();
  await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => {
    console.error('goto warn: ' + e.message);
  });

  console.log('— Залогинься через Telegram, дойди до кабинета (#cabinet).');
  console.log('  Команды: s=сохранить  d=дамп  q=выход (stdin или trigger-файл).\n');

  watchCmdFile();

  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => handleCmd(chunk));

  context.on('close', () => {
    console.log('\nБраузер закрыт.');
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
