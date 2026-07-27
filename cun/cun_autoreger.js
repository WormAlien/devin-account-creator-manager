const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { CamoufoxEmailnator } = require("../freemodel/lib/camoufox-emailnator-client");

const HEADLESS = false;
const CUN_SIGNUP_URL = "https://www.cun.ai/sign-up";
const CUN_DASHBOARD_URL = "https://www.cun.ai/dashboard";
const SESSIONS_FILE = path.join(__dirname, "cun-sessions.json");
const ACCOUNTS_DIR = path.join(__dirname, "accounts");
const LOG_FILE = path.join(__dirname, "logs", "run.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch { return []; }
}
function saveSessions(arr) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2) + "\n", "utf8");
}

function randomString(len, chars = "abcdefghijklmnopqrstuvwxyz0123456789") {
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randomPassword() {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const special = "!@#$%^&*";
  return (
    upper[Math.floor(Math.random() * upper.length)] +
    lower[Math.floor(Math.random() * lower.length)] +
    digits[Math.floor(Math.random() * digits.length)] +
    special[Math.floor(Math.random() * special.length)] +
    randomString(8, lower + digits + upper)
  );
}

async function waitConsole(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function registerOne(inviteCode) {
  const ts = Date.now();
  const recordDir = path.join(ACCOUNTS_DIR, `_recording_${ts}`);
  fs.mkdirSync(recordDir, { recursive: true });
  const recordLog = path.join(recordDir, "record.jsonl");
  const shotDir = path.join(recordDir, "shots");
  fs.mkdirSync(shotDir, { recursive: true });

  function rec(kind, payload) {
    const entry = JSON.stringify({ t: Date.now(), kind, payload }, null, 2);
    fs.appendFileSync(recordLog, entry + "\n");
  }

  log("=== Cun.ai registration ===");

  // ── Email (Camoufox emailnator) ──
  log("[email] starting Camoufox emailnator...");
  const emailClient = new CamoufoxEmailnator({ headless: HEADLESS !== false, log });
  await emailClient.start();
  const mailbox = await emailClient.create();
  const email = mailbox.email;
  log(`[email] ${email}`);

  // ── Browser (cun.ai) ──
  const browser = await chromium.launch({ headless: HEADLESS, args: ["--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.__REC_CLICKS = [];
    document.addEventListener("click", e => {
      const el = e.target;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
      const data = {
        time: Date.now(),
        x: e.clientX,
        y: e.clientY,
        tag: el.tagName,
        id: el.id,
        class: el.className,
        text: (el.textContent || "").trim().slice(0, 100),
        href: el.href || null,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      };
      window.__REC_CLICKS.push(data);
      if (typeof window.__recClickHook === "function") window.__recClickHook(data);
    }, true);
  });

  const page = await context.newPage();

  page.on("pageerror", e => rec("pageerror", { msg: e.message }));
  page.on("console", msg => rec("console", { type: msg.type(), text: msg.text() }));
  page.on("response", async res => {
    const url = res.url();
    if (url.includes("cun.ai")) {
      try {
        const body = await res.text().catch(() => "<unreadable>");
        rec("response", { url, status: res.status(), body: body.slice(0, 1000) });
      } catch {}
    }
  });

  await page.exposeFunction("__recClickHook", data => rec("click", data));

  log(`[browser] opening ${CUN_SIGNUP_URL}`);
  await page.goto(CUN_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);

  await page.screenshot({ path: path.join(shotDir, "01_initial.png") });
  rec("dom", { url: page.url(), title: await page.title().catch(() => "") });

  const username = email.split("@")[0].replace(/[^a-z0-9]/g, "") + randomString(4);
  const password = randomPassword();

  log(`[form] username: ${username}`);
  await page.locator('input[placeholder*="username" i], input[name="username"]').first().fill(username);
  await sleep(200);
  await page.screenshot({ path: path.join(shotDir, "02_username.png") });

  log(`[form] password: ${password.slice(0,4)}...`);
  const pwInputs = await page.locator('input[type="password"]').all();
  if (pwInputs.length >= 2) {
    await pwInputs[0].fill(password);
    await sleep(200);
    await pwInputs[1].fill(password);
    await sleep(200);
  }
  await page.screenshot({ path: path.join(shotDir, "03_password.png") });

  log(`[form] email: ${email}`);
  await page.locator('input[type="email"], input[placeholder*="email" i]').first().fill(email);
  await sleep(200);
  await page.screenshot({ path: path.join(shotDir, "04_email.png") });

  if (inviteCode) {
    const inviteInput = page.locator('input[placeholder*="invite" i], input[name="invite"]').first();
    if (await inviteInput.count() > 0) {
      await inviteInput.fill(inviteCode);
      log(`[form] invite: ${inviteCode}`);
    }
  }

  log("\n========================================");
  log("  1. Check the agreement checkbox");
  log("  2. Solve captcha if shown");
  log("  3. Click 'Send Code' on the page");
  log("  4. Then press ENTER here to continue");
  log("========================================\n");

  await page.screenshot({ path: path.join(shotDir, "05_ready_for_manual.png") });

  await waitConsole("Press ENTER after you clicked 'Send Code'... ");

  await page.screenshot({ path: path.join(shotDir, "06_after_manual.png") });
  rec("dom_after_manual", { url: page.url(), clicks: await page.evaluate("() => window.__REC_CLICKS") });

  // ── Wait OTP via Camoufox emailnator ──
  log("[otp] polling emailnator inbox...");
  const got = await emailClient.waitOtp({ fromHint: "cun", timeout: 120, poll: 8 });
  if (!got || !got.code) {
    log("[otp] timeout — no code received");
    await browser.close();
    await emailClient.stop();
    return null;
  }
  log(`[otp] code: ${got.code}`);

  // Fill OTP
  const otpInput = page.locator('input[placeholder*="code" i], input[name="verificationCode"]').first();
  if (await otpInput.count() > 0) {
    await otpInput.fill(got.code);
    await sleep(300);
  }
  await page.screenshot({ path: path.join(shotDir, "07_otp_filled.png") });

  // Click Create Account
  const createBtn = page.locator('button:has-text("Create"), button:has-text("Account"), button[type="submit"]').first();
  if (await createBtn.count() > 0 && await createBtn.isVisible()) {
    await createBtn.click();
    log("[form] clicked Create Account");
  }

  await sleep(3000);
  const url = page.url();
  log(`[form] URL after submit: ${url}`);
  await page.screenshot({ path: path.join(shotDir, "08_after_submit.png") });

  // ── Save session ──
  if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  const ident = `${username}_${Date.now()}`;
  const dir = path.join(ACCOUNTS_DIR, ident);
  fs.mkdirSync(dir, { recursive: true });

  const sessionFile = path.join(dir, "session.json");
  await context.storageState({ path: sessionFile });

  const info = `Username: ${username}
Email: ${email}
Password: ${password}
Invite: ${inviteCode || ""}
URL: ${url}
Created: ${new Date().toISOString()}
`;
  fs.writeFileSync(path.join(dir, "info.txt"), info, "utf8");
  log(`[save] account dir: ${dir}`);

  const recDest = path.join(dir, "recording");
  fs.renameSync(recordDir, recDest);

  const sessions = loadSessions();
  sessions.push({ email, username, password, invite: inviteCode || null, dir, created: new Date().toISOString() });
  saveSessions(sessions);

  await browser.close();
  await emailClient.stop();

  log("=== Done ===");
  return { username, email, password, dir };
}

(async () => {
  const inviteCode = process.argv[2] || null;
  try {
    await registerOne(inviteCode);
  } catch (e) {
    log(`FATAL: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
})();
