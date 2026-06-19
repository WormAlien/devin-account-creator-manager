// freemodel/freemodel_autoreger_v3.js
//
// v5: tmailor.com через Camoufox (Firefox stealth + JSON-lines Python демон).
//
// Отличия от v4:
//   - Вместо Playwright Chromium для почты используется Camoufox-процесс
//     (freemodel/lib/camoufox_tmailor.py), который проходит Cloudflare Turnstile
//     на tmailor.com и вызывает /api изнутри браузера.
//   - Node.js общается с Python-процессом через stdin/stdout JSON-lines.
//   - FreeModel-аккаунт всё ещё регистрируется обычным Playwright Chromium.
//
// Использование:
//   node freemodel/freemodel_autoreger_v3.js           # config.ACCOUNTS_COUNT
//   node freemodel/freemodel_autoreger_v3.js 3         # сколько аккаунтов
//   node freemodel/freemodel_autoreger_v3.js 3 FRE-x   # override стартового инвайта

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { CamoufoxTmailor } = require("./lib/camoufox-tmailor-client");
const fmTgBind = require("./lib/fm-tg-bind");
const tgPool = require("./lib/tg-pool");
const dashApi = require("../internal/dashboard-api");

// Постоянный блок-лист email-доменов, которые FreeModel отверг по signup-лимиту.
// Растёт во время работы и переживает рестарты — следующие реги не тратят на них
// время. Хардкод DEAD_EMAIL_DOMAINS — для тех, что вообще не доставляют письмо.
const EMAIL_BLOCKLIST_FILE = path.join(__dirname, ".email_blocklist.json");
function loadEmailBlocklist() {
  try { return JSON.parse(fs.readFileSync(EMAIL_BLOCKLIST_FILE, "utf8")) || []; }
  catch { return []; }
}
function addEmailBlocklist(domain) {
  if (!domain) return;
  const list = loadEmailBlocklist();
  if (list.includes(domain)) return;
  list.push(domain);
  try { fs.writeFileSync(EMAIL_BLOCKLIST_FILE, JSON.stringify(list, null, 2) + "\n", "utf8"); } catch {}
}

// Persist реф-цепочку между запусками.
const LAST_INVITE_FILE = path.join(__dirname, ".last_invite");
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadLastInvite() {
  try {
    if (fs.existsSync(LAST_INVITE_FILE)) {
      const v = fs.readFileSync(LAST_INVITE_FILE, "utf8").trim();
      if (/^FRE-[A-Za-z0-9]+$/.test(v)) return v;
    }
  } catch (e) {
    log(`[цепочка] ⚠️ не смог прочитать .last_invite: ${e.message}`);
  }
  return null;
}

function saveLastInvite(code) {
  if (!code || !/^FRE-/.test(code)) return;
  try {
    fs.writeFileSync(LAST_INVITE_FILE, code + "\n", "utf8");
  } catch (e) {
    log(`[цепочка] ⚠️ не смог записать .last_invite (${code}): ${e.message}`);
  }
}

// ─── СЕЛЕКТОРЫ freemodel.dev ──────────────────────────────────
const SELECTORS = {
  emailInput: 'input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="email" i]',
  submitSignup:
    'button:has-text("Send Verification Code"), button:has-text("Send code"), button:has-text("Verify"), button:has-text("Sign up"), button:has-text("Continue"), button:has-text("Регистрация"), button[type="submit"]',
  apiKeysLink: 'a[href*="api-keys"], a[href*="keys"], text=API Keys',
  createKeyBtn: 'button:has-text("Create"), button:has-text("New key"), button:has-text("Создать")',
  refLinkHint: 'a[href*="/invite/"], input[value*="/invite/"], text=/FRE-[A-Za-z0-9]+/',
};

// ─── УТИЛИТЫ ──────────────────────────────────────────────────
function ts() {
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return msk.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const dir = path.dirname(config.LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(config.LOG_FILE, line + "\n");
  } catch {}
}

function parseProxy(s) {
  if (!s) return null;
  const m = s.match(/^https?:\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
  if (!m) return null;
  const p = { server: `http://${m[3]}:${m[4]}` };
  if (m[1] && m[2]) {
    p.username = m[1];
    p.password = m[2];
  }
  return p;
}

function extractInviteCode(text) {
  if (!text) return null;
  const m = text.match(/FRE-[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

// ─── ЭКСПОРТ АККАУНТА ───────────────────────────────────────────
function exportAccount({ index, email, apiKey, inviteCode, sessionFile, cookies, success }) {
  if (!fs.existsSync(config.ACCOUNTS_DIR)) fs.mkdirSync(config.ACCOUNTS_DIR, { recursive: true });

  const label = success ? "ok" : "err";
  const ident = email.split("@")[0].replace(/[^\w-]/g, "_");
  const dir = path.join(config.ACCOUNTS_DIR, `${index}_${ts()}_${label}_${ident}`);
  fs.mkdirSync(dir, { recursive: true });

  if (sessionFile && fs.existsSync(sessionFile)) {
    fs.copyFileSync(sessionFile, path.join(dir, "session.json"));
  }

  if (Array.isArray(cookies)) {
    const fmt = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      hostOnly: !c.domain.startsWith("."),
      path: c.path || "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite === "None" ? "no_restriction" : (c.sameSite || "lax").toLowerCase(),
      session: c.expires === -1,
      expirationDate: c.expires === -1 ? undefined : c.expires,
      storeId: "0",
    }));
    fs.writeFileSync(path.join(dir, "cookies.json"), JSON.stringify(fmt, null, 2));
  }

  fs.writeFileSync(
    path.join(dir, "restore_session.js"),
    `const { chromium } = require('playwright');
const path = require('path');
(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: path.join(__dirname, 'session.json') });
    const page = await context.newPage();
    await page.goto('${config.DASHBOARD_URL}', { waitUntil: 'domcontentloaded' });
    console.log('✅ Сессия восстановлена. Закрой браузер вручную.');
})();
`,
  );

  const info = `Index: ${index}
Email: ${email}
API Key: ${apiKey || "(создаётся вручную после привязки Telegram)"}
Invite Code (мой реф): ${inviteCode || "(не получен)"}
Status: ${success ? "✅ OK" : "❌ ERROR"}
Backend: tmailor (v4)
Created: ${new Date().toISOString()}
`;
  fs.writeFileSync(path.join(dir, "account_info.txt"), info);

  log(`[экспорт] 📦 ${dir}`);
  return dir;
}

function appendKeysFile(email, apiKey, inviteCode) {
  const line = `${email}|${apiKey || ""}|${inviteCode || ""}\n`;
  fs.appendFileSync(config.KEYS_FILE, line);
}

// ─── ШАГИ ───────────────────────────────────────────────────────
async function fillSignupForm(page, email) {
  log(`[форма] ввожу email: ${email}`);

  let emailLoc = null;
  for (const frame of page.frames()) {
    try {
      const loc = frame.locator(SELECTORS.emailInput).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        emailLoc = { frame, loc };
        break;
      }
    } catch {}
  }
  if (!emailLoc) throw new Error("поле email не найдено");

  const { loc } = emailLoc;

  // Реальный пользовательский ввод — Playwright fill посылает события, которые React/Vue ловят.
  await loc.click({ timeout: 5000 });
  await loc.fill(email);
  await page.waitForTimeout(300);

  const actual = await loc.inputValue().catch(() => "");
  log(`[форма] значение после fill: '${actual}'`);
  if (!actual.includes("@")) {
    await loc.fill("");
    await loc.pressSequentially(email, { delay: 50 });
  }

  await page.waitForTimeout(500);

  let submitted = false;
  // Кликаем кнопку сабмита через Playwright (человеческий клик мышью).
  for (const frame of page.frames()) {
    try {
      const btn = frame.locator(SELECTORS.submitSignup).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        const text = (await btn.textContent().catch(() => "")).trim().slice(0, 60);
        log(`[форма] кликаю кнопку: ${text}`);
        await btn.click({ timeout: 5000 });
        submitted = true;
        break;
      }
    } catch {}
  }
  if (!submitted) {
    log("[форма] кнопка не найдена, жму Enter");
    await loc.press("Enter");
  }

  await page.waitForTimeout(1500);
  log(`[форма] URL после сабмита: ${page.url()}`);
  const bodyErr = await page.locator("body").innerText().catch(() => "");
  const errMatch = bodyErr.match(/(error|invalid|used|expired|limit|banned|cannot|try again|failed|wrong|required)/i);
  if (errMatch) {
    log(`[форма] ⚠️ возможная ошибка на странице: ${errMatch[0]}`);
  }
}

// 6 single-char <input maxLength=1>, либо 1 общий, либо fallback на keyboard.type
async function fillOtpAndContinue(page, code) {
  log(`[OTP] ввожу код ${code}`);

  const inputs = page.locator(
    'input[maxlength="1"], input[autocomplete="one-time-code"], input[inputmode="numeric"]',
  );
  const n = await inputs.count();

  if (n >= 6) {
    for (let i = 0; i < 6; i++) {
      await inputs
        .nth(i)
        .fill(code[i])
        .catch(async () => {
          await inputs.nth(i).focus();
          await page.keyboard.press(code[i]);
        });
      await page.waitForTimeout(80);
    }
  } else if (n === 1) {
    await inputs.first().fill(code);
  } else {
    const first = page.locator("input").first();
    await first.click();
    await page.keyboard.type(code, { delay: 80 });
  }

  await page.waitForTimeout(500);

  const before = page.url();
  try {
    await page.waitForURL((u) => u !== before, { timeout: 4000 });
    log("[OTP] авто-сабмит сработал");
  } catch {
    const verify = page
      .locator(
        'button:has-text("Verify"), button:has-text("Continue"), button:has-text("Confirm"), button[type="submit"]',
      )
      .first();
    if ((await verify.count()) > 0) {
      await verify.click({ timeout: 5000 }).catch(() => {});
      log("[OTP] нажал Verify");
    }
  }

  await page.waitForTimeout(4500);
  for (let i = 0; i < 6; i++) {
    const u = page.url();
    if (
      u.includes("/dashboard") ||
      u.includes("/app") ||
      u.includes("/account") ||
      u.includes("/welcome")
    )
      break;
    await page.waitForTimeout(2000);
  }
  log(`[OTP] URL после verify: ${page.url()}`);
  return page;
}

// Welcome-модалка после первого входа на /dashboard перехватывает клики
// (`<div class="modal-backdrop">` блокирует pointer events).
// Закрываем чем угодно: Escape, видимая кнопка "Got it/Close/Skip/Continue",
// клик по самому backdrop'у.
async function dismissDashboardModal(page) {
  log("[модалка] пробую закрыть welcome/onboarding popup");
  // 1. Escape — самое мягкое
  try {
    await page.keyboard.press("Escape");
  } catch {}
  await page.waitForTimeout(400);

  // 2. Видимые кнопки закрытия
  const closeSelectors = [
    'button:has-text("Got it")',
    'button:has-text("Close")',
    'button:has-text("Skip")',
    'button:has-text("Continue")',
    'button:has-text("Dismiss")',
    'button:has-text("Done")',
    'button[aria-label="Close"]',
    "button.close, button.btn-close",
    '[class*="modal"] button:has-text("OK")',
  ];
  for (const sel of closeSelectors) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click({ timeout: 2000 });
        log(`[модалка]   ✓ нажал ${sel}`);
        await page.waitForTimeout(600);
        break;
      }
    } catch {}
  }

  // 3. Если backdrop ещё висит — клик мимо контента (по самому backdrop)
  try {
    const backdrop = page.locator('.modal-backdrop, [class*="backdrop"]').first();
    if ((await backdrop.count()) > 0 && (await backdrop.isVisible())) {
      await backdrop.click({ timeout: 2000, position: { x: 5, y: 5 } });
      log("[модалка]   ✓ клик по backdrop");
      await page.waitForTimeout(600);
    }
  } catch {}

  // Ещё раз Escape на всякий случай
  try {
    await page.keyboard.press("Escape");
  } catch {}
  await page.waitForTimeout(300);
}

// API-ключ для v3 НЕ создаём автоматически — этим занимается пользователь
// руками после привязки Telegram. Функция оставлена на случай если нужно
// будет вернуть автоматизацию.
async function createApiKey(page) {
  log("[ключ] перехожу к API Keys");
  const urls = [
    `${config.DASHBOARD_URL}/api-keys`,
    `${config.DASHBOARD_URL}/keys`,
    `${config.DASHBOARD_URL}/settings/api-keys`,
    config.DASHBOARD_URL,
  ];
  for (const u of urls) {
    try {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2000);
      const has = await page.locator(SELECTORS.createKeyBtn).first().count();
      if (has > 0) break;
    } catch {}
  }

  try {
    await page.locator(SELECTORS.createKeyBtn).first().click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  } catch (e) {
    log(`[ключ] ⚠️ Create не нажалась: ${e.message}`);
  }

  try {
    const confirm = page
      .locator('button:has-text("Create"), button:has-text("Confirm"), button[type="submit"]')
      .first();
    if ((await confirm.count()) > 0 && (await confirm.isVisible())) {
      await confirm.click({ timeout: 4000 });
      await page.waitForTimeout(2500);
    }
  } catch {}

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  const m = bodyText.match(/fe[_-][A-Za-z0-9_-]{20,}/);
  if (m) {
    log(`[ключ] 🔑 ${m[0]}`);
    return m[0];
  }

  const inputs = await page.locator("input, textarea, code").all();
  for (const inp of inputs) {
    try {
      const v = (await inp.inputValue().catch(() => "")) || (await inp.innerText().catch(() => ""));
      const mm = v.match(/fe[_-][A-Za-z0-9_-]{20,}/);
      if (mm) {
        log(`[ключ] 🔑 ${mm[0]}`);
        return mm[0];
      }
    } catch {}
  }

  log("[ключ] ❌ не найден в DOM");
  return null;
}

async function grabReferralCode(page) {
  log("[реф] ищу свою реф-ссылку");
  const urls = [
    `${config.DASHBOARD_URL}/refer`,
    `${config.DASHBOARD_URL}/invite`,
    `${config.DASHBOARD_URL}/referrals`,
    config.DASHBOARD_URL,
  ];
  for (const u of urls) {
    try {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(10000);
      const text = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const code = extractInviteCode(text);
      if (code) {
        log(`[реф] 🔗 ${code}`);
        return code;
      }
      const hrefs = await page.locator('a[href*="/invite/"]').all();
      for (const a of hrefs) {
        const href = await a.getAttribute("href").catch(() => "");
        const c = extractInviteCode(href);
        if (c) {
          log(`[реф] 🔗 ${c}`);
          return c;
        }
      }
    } catch {}
  }
  log("[реф] ⚠️ реф-код не найден");
  return null;
}

// ─── ОДИН АККАУНТ ───────────────────────────────────────────────
async function registerOne(index, inviteCode) {
  log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log(`[#${index}] инвайт: ${inviteCode}`);

  const launchOpts = {
    headless: config.HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  const proxy = parseProxy(config.PROXY);
  if (proxy) launchOpts.proxy = proxy;

  let apiKey = null,
    refCode = null,
    success = false,
    cookies = [];
  let browser, context, page;
  let email = null;
  let accesstoken = null;
  let tmailorClient = null;
  let sessionFile = path.join(config.ACCOUNTS_DIR, `_tmp_session_${index}.json`);
  let boundTgPhone = null;
  let bindFailedPhone = null;

  try {
    const MAX_EMAIL_RETRIES = 15;
    const otpWaitMs = config.EMAIL_WAIT_MAX_MS || 90000;
    let otpCode = null;

    // Браузер для FreeModel и отдельный context для tmailor (разделяем cookies).
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      viewport: config.VIEWPORT,
      userAgent: config.USER_AGENT,
      locale: config.LOCALE,
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Стартуем Camoufox-демон для tmailor.
    try {
      tmailorClient = new CamoufoxTmailor({ headless: config.HEADLESS !== false, log });
      await tmailorClient.start();
      const initialMailbox = await tmailorClient.create();
      email = initialMailbox.email;
      accesstoken = initialMailbox.accesstoken;
    } catch (e) {
      throw new Error(`tmailor (Camoufox) не отвечает: ${e.message}`);
    }

    // Домены, на которые FreeModel молча НЕ доставляет OTP (форма принимается,
    // письмо не приходит → 5 мин впустую). Сидим блок-лист сразу, чтобы переген
    // уходил мимо. Расширяется через config.EMAIL_BLOCKED_DOMAINS.
    const DEAD_EMAIL_DOMAINS = ['mailcom.cc'];
    const rejectedDomains = new Set([
      ...DEAD_EMAIL_DOMAINS,
      ...(config.EMAIL_BLOCKED_DOMAINS || []),
      ...loadEmailBlocklist(),
    ]);
    const allowedDomains = config.EMAIL_ALLOWED_DOMAINS || [];

    for (let attempt = 0; attempt < MAX_EMAIL_RETRIES; attempt++) {
      // Перегенерируем адрес, если это не первая попытка.
      if (attempt > 0) {
        try {
          const newEmail = await tmailorClient.regenerate();
          email = newEmail.email;
          accesstoken = newEmail.accesstoken;
        } catch (e) {
          log(`[#${index}] tmailor regenerate error: ${e.message}, жду 5с...`);
          await sleep(5000);
          continue;
        }
      }

      // Фильтр домена с перегенерацией внутри попытки.
      let domainOk = false;
      let domainRegenAttempts = 0;
      while (!domainOk && domainRegenAttempts < 15) {
        const domain = email.split("@")[1];
        const whitelisted = !allowedDomains.length || allowedDomains.includes(domain);
        if (whitelisted && !rejectedDomains.has(domain)) {
          domainOk = true;
          break;
        }
        if (!whitelisted) {
          log(`[#${index}] домен @${domain} не в whitelist, переген`);
        } else {
          log(`[#${index}] домен @${domain} уже отклонялся FreeModel, переген`);
        }
        domainRegenAttempts++;
        try {
          const newEmail = await tmailorClient.regenerate();
          email = newEmail.email;
          accesstoken = newEmail.accesstoken;
        } catch (e) {
          log(`[#${index}] tmailor regenerate error: ${e.message}, жду 5с...`);
          await sleep(5000);
          break;
        }
      }

      if (!domainOk) {
        log(`[#${index}] ⚠️ не удалось получить подходящий email, следующая попытка`);
        continue;
      }

      const domain = email.split("@")[1];
      log(`[#${index}] email (попытка ${attempt + 1}): ${email}  [backend=tmailor]`);

      page = await context.newPage();
      const signupUrl = config.SIGNUP_URL_TPL.replace("{CODE}", inviteCode);
      log(`[#${index}] открываю ${signupUrl}`);
      await page.goto(signupUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);

      // Ловим ответ send-otp: там часто приходит "Your email domain has reached its signup limit"
      let sendOtpError = null;
      const onResponse = async (res) => {
        const url = res.url();
        if (!url.includes("/api/auth/send-otp")) return;
        try {
          const body = await res.text();
          if (body.includes("signup limit") || body.includes("domain has reached")) {
            sendOtpError = body;
          }
        } catch {}
      };
      page.on("response", onResponse);

      await fillSignupForm(page, email);
      await page.waitForTimeout(3500);

      page.off("response", onResponse);

      // Bann / reject detector
      const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const lower = bodyText.toLowerCase();
      const banPatterns = [
        "banned",
        "suspended",
        "blocked",
        "not allowed",
        "cannot create",
        "cannot sign up",
        "invalid email",
        "something went wrong",
        "try again",
        "signup limit",
        "domain has reached",
      ];
      const banHit = banPatterns.find((p) => lower.includes(p));
      if (banHit || sendOtpError) {
        const reason = sendOtpError ? `send-otp: ${sendOtpError}` : banHit;
        log(`[#${index}] ❌ email отклонён (${reason}), беру новую почту`);
        rejectedDomains.add(domain);
        // Лимит на домен — это надолго: пишем в постоянный блок-лист, чтобы
        // следующие реги (и прогоны) даже не пробовали этот домен.
        if (/signup limit|domain has reached|reach\w*\s+\w*\s*limit/i.test(reason)) {
          addEmailBlocklist(domain);
          log(`[#${index}] 🚫 @${domain} → постоянный blacklist (signup limit)`);
        }
        await page.close().catch(() => {});
        page = null;
        continue;
      }

      // Жду OTP — через Camoufox tmailor.
      log(`[#${index}] жду OTP (макс ${Math.round(otpWaitMs / 1000)}с)...`);
      const got = await tmailorClient.waitOtp({
        fromHint: config.EMAIL_FROM_HINT || "freemodel",
        timeout: Math.round(otpWaitMs / 1000),
        poll: Math.round((config.EMAIL_POLL_MS || 4000) / 1000),
      });

      if (got && got.code) {
        otpCode = got.code;
        log(`[#${index}] 🔢 OTP: ${otpCode}`);
        break;
      }

      log(
        `[#${index}] ⚠️ OTP не пришёл за ${Math.round(otpWaitMs / 1000)}с, новый email (${attempt + 2}/${MAX_EMAIL_RETRIES})`,
      );
      await page.close().catch(() => {});
      page = null;
    }

    if (!otpCode) {
      throw new Error(`OTP не получен после ${MAX_EMAIL_RETRIES} попыток`);
    }

    const dashPage = await fillOtpAndContinue(page, otpCode);

    const url = dashPage.url();
    if (!/\/(dashboard|app|account|welcome)/.test(url)) {
      log(`[#${index}] ⚠️ после verify URL: ${url}`);
    }

    await context.storageState({ path: sessionFile });
    cookies = (await context.cookies()).filter((c) => c.domain.includes("freemodel"));

    // Закрываем welcome-popup чтобы добраться до /refer
    await dismissDashboardModal(dashPage);

    // API-ключ автоматом не создаём — пользователь сделает руками
    // после привязки Telegram. v3: success = получили реф-код.
    refCode = await grabReferralCode(dashPage);

    await context.storageState({ path: sessionFile });
    success = !!refCode;

    // Автопривязка Telegram из пула + автосоздание API-ключа.
    if (success && config.AUTO_BIND_TELEGRAM !== false) {
      try {
        log(`[#${index}] привязываю Telegram из пула...`);
        // fm-tg-bind ожидает папку с файлом session.json.
        const bindSessionDir = path.join(path.dirname(sessionFile), `_tmp_bind_${index}`);
        if (!fs.existsSync(bindSessionDir)) fs.mkdirSync(bindSessionDir, { recursive: true });
        fs.copyFileSync(sessionFile, path.join(bindSessionDir, "session.json"));
        const bindRes = await fmTgBind.bindTelegram(bindSessionDir, null, {
          headless: config.HEADLESS !== false,
          log: (m) => log(m),
        });
        if (bindRes.ok) {
          boundTgPhone = bindRes.tgPhone || null;
          if (bindRes.apiKey) {
            apiKey = bindRes.apiKey;
            log(`[#${index}] 🔑 API-ключ: ${apiKey.slice(0, 16)}...`);
          } else {
            log(`[#${index}] ⚠️ TG привязан, но API-ключ не получен`);
          }
        } else {
          bindFailedPhone = bindRes.tgPhone || null;
          log(`[#${index}] ⚠️ TG не привязан: ${bindRes.error}`);
        }
      } catch (e) {
        log(`[#${index}] ⚠️ ошибка TG bind: ${e.message}`);
      }
    }
  } catch (e) {
    log(`[#${index}] ❌ ${e.message}`);
    try {
      const shot = path.join(config.ACCOUNTS_DIR, `_error_${index}_${ts()}.png`);
      if (page) {
        await page.screenshot({ path: shot });
        log(`[#${index}] 📸 ${shot}`);
      }
    } catch {}
    try {
      if (context) await context.storageState({ path: sessionFile });
    } catch {}
    try {
      if (context)
        cookies = (await context.cookies()).filter((c) => c.domain.includes("freemodel"));
    } catch {}
  } finally {
    if (email) {
      const exportedDir = exportAccount({ index, email, apiKey, inviteCode: refCode, sessionFile, cookies, success });
      // Финализация TG: bind делался во временной папке _tmp_bind_N, поэтому
      // markUsed/setTgPhone вешаем на реальное имя аккаунта (папка exportAccount),
      // уже зная email. Без этого номер залипает reserved, а карточка — без TG.
      if (boundTgPhone) {
        try {
          const sessionName = path.basename(exportedDir);
          tgPool.markUsed(boundTgPhone, email);
          dashApi.setFreemodelTgPhone(sessionName, boundTgPhone);
          if (apiKey) dashApi.setFreemodelApiKey(sessionName, apiKey);
          log(`[#${index}] 📱 TG +${boundTgPhone} → used (${email}), привязка проставлена в дашборде`);
        } catch (e) {
          log(`[#${index}] ⚠️ финализация TG не удалась: ${e.message}`);
        }
      }
      if (refCode) {
        appendKeysFile(email, apiKey, refCode);
      } else {
        log(`[keys] ⏭ строку в keys.txt не пишу (реф-код не получен) — папка акка осталась для дебага`);
      }
    }
    // Номер зарезервировали, но bind упал — вернём в пул (иначе залипает reserved).
    if (bindFailedPhone) {
      try {
        const e = tgPool.list().find(x => x.phone === String(bindFailedPhone));
        if (e && e.status === 'reserved') {
          tgPool.markFree(bindFailedPhone);
          log(`[#${index}] ♻ TG +${bindFailedPhone} возвращён в пул (free)`);
        }
      } catch {}
    }
    if (fs.existsSync(sessionFile)) {
      try {
        fs.unlinkSync(sessionFile);
      } catch {}
    }
    const bindSessionDir = path.join(path.dirname(sessionFile), `_tmp_bind_${index}`);
    if (fs.existsSync(bindSessionDir)) {
      try {
        fs.rmSync(bindSessionDir, { recursive: true, force: true });
      } catch {}
    }
    if (tmailorClient) await tmailorClient.stop().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return { success, refCode, email, apiKey };
}

// ─── ОСНОВНОЙ ЦИКЛ ──────────────────────────────────────────────
(async () => {
  const count = Number(process.argv[2]) || config.ACCOUNTS_COUNT || 1;

  const cliInvite = process.argv.find((a) => /^FRE-[A-Za-z0-9]+$/.test(a));
  const lastInvite = loadLastInvite();
  let currentInvite = cliInvite || lastInvite || config.INITIAL_INVITE;

  log("════════════════════════════════════════");
  log(`  FREEMODEL AUTOREG v5 (tmailor + Camoufox) — ${count} акк(а)`);
  log(
    `  Старт инвайт: ${currentInvite}` +
      (cliInvite
        ? "  (CLI arg)"
        : lastInvite
          ? "  (из .last_invite)"
          : "  (config.INITIAL_INVITE)"),
  );
  log(`  Прокси: ${config.PROXY || "(нет)"}`);
  log("════════════════════════════════════════");

  let ok = 0,
    fail = 0;

  let stop = false;
  process.on("SIGINT", () => {
    log("\n[!] Ctrl+C — остановка после текущего акка");
    stop = true;
  });

  for (let i = 1; i <= count; i++) {
    if (stop) break;
    try {
      const r = await registerOne(i, currentInvite);
      if (r.success) ok++;
      else fail++;
      if (r.refCode) {
        currentInvite = r.refCode;
        saveLastInvite(r.refCode);
        log(`[цепочка] следующий инвайт: ${currentInvite}  (сохранён в .last_invite)`);
      } else {
        log(`[цепочка] ⚠️ реф-код не получили, остаёмся на ${currentInvite}`);
      }
    } catch (e) {
      fail++;
      log(`[#${i}] фатально: ${e.message}`);
    }
    if (i < count && !stop) {
      log(`⏳ пауза ${config.DELAY_BETWEEN_ACCOUNTS_MS / 1000}с...`);
      await new Promise((r) => setTimeout(r, config.DELAY_BETWEEN_ACCOUNTS_MS));
    }
  }

  log("\n════════════════════════════════════════");
  log(`  ИТОГ: ✅ ${ok} | ❌ ${fail}`);
  log(`  Ключи: ${config.KEYS_FILE}`);
  log(`  Аккаунты: ${config.ACCOUNTS_DIR}`);
  log(`  Последний реф: ${currentInvite}  (.last_invite)`);
  log("════════════════════════════════════════");
})().catch((e) => {
  log(`💥 ${e.message}`);
  process.exit(1);
});
