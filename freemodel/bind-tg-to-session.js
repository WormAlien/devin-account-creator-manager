// freemodel/bind-tg-to-session.js
//
// Привязать выбранный TG-аккаунт из пула к существующей FreeModel-сессии.
// Использование:
//   node freemodel/bind-tg-to-session.js                          # интерактивный выбор
//   node freemodel/bind-tg-to-session.js <session-dir> <phone>     # прямой вызов
//
// Пример:
//   node freemodel/bind-tg-to-session.js freemodel/accounts/1_2026-06-17T23-24-08_ok_m9i8vkqo 240718298

const path = require("path");
const fs = require("fs");
const tgPool = require("./lib/tg-pool");
const fmTgBind = require("./lib/fm-tg-bind");

function log(msg) { console.log(`[bind-tg] ${msg}`); }

function listSessionDirs() {
  const base = path.join(__dirname, "accounts");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, "session.json")))
    .map((d) => path.join(base, d.name));
}

function pickSessionDir() {
  const dirs = listSessionDirs();
  if (!dirs.length) {
    console.error("Нет папок с session.json в freemodel/accounts/");
    process.exit(1);
  }
  console.log("\nДоступные сессии FreeModel:");
  dirs.forEach((dir, i) => {
    const infoFile = path.join(dir, "account_info.txt");
    let extra = "";
    if (fs.existsSync(infoFile)) {
      const txt = fs.readFileSync(infoFile, "utf8");
      const email = txt.match(/Email:\s*(.+)/)?.[1]?.trim() || "";
      const key = txt.match(/API Key:\s*(.+)/)?.[1]?.trim() || "";
      extra = `  | ${email}${key && key !== '(создаётся вручную после привязки Telegram)' ? ` | key=${key.slice(0, 16)}...` : ""}`;
    }
    console.log(`  ${i + 1}) ${path.basename(dir)}${extra}`);
  });
  const idx = Number(process.argv[2]) || 0;
  if (idx >= 1 && idx <= dirs.length) return dirs[idx - 1];
  return dirs[0];
}

function pickPhone() {
  const pool = tgPool.list();
  const available = pool.filter((e) => e.status === "free" || e.status === "reserved");
  if (!available.length) {
    console.error("Нет свободных TG-аккаунтов в tg_pool.json");
    process.exit(1);
  }
  console.log("\nДоступные TG-аккаунты:");
  available.forEach((e, i) => {
    const status = e.status === "reserved" ? " (reserved)" : "";
    console.log(`  ${i + 1}) +${e.phone}${status}`);
  });
  const idx = Number(process.argv[3]) || 0;
  if (idx >= 1 && idx <= available.length) return available[idx - 1].phone;
  return available[0].phone;
}

(async () => {
  const sessionDir = process.argv[2] ? path.resolve(process.argv[2]) : pickSessionDir();
  const sessionFile = path.join(sessionDir, "session.json");
  if (!fs.existsSync(sessionFile)) {
    console.error(`session.json не найден: ${sessionFile}`);
    process.exit(1);
  }
  log(`сессия: ${sessionDir}`);

  const phone = process.argv[3] ? String(process.argv[3]) : pickPhone();
  log(`TG: +${phone}`);

  const result = await fmTgBind.bindTelegram(sessionDir, phone, {
    headless: false,
    log: (m) => log(m),
    timeoutMs: 120000,
  });

  if (result.ok) {
    log(`✅ привязан: +${result.tgPhone}`);
    if (result.apiKey) {
      log(`🔑 API key: ${result.apiKey.slice(0, 16)}...`);
    } else {
      log("⚠️ API key не получен — нужно создать вручную через dashboard");
    }
  } else {
    log(`❌ ошибка: ${result.error}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
