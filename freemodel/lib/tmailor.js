// freemodel/lib/tmailor.js
//
// Playwright-based клиент для tmailor.com.
//
// Почему Playwright, а не curl/fetch:
//   - tmailor.com/api защищён Cloudflare Turnstile; чистый Node fetch получает 403 challenge.
//   - Внутри реального браузера, который прошёл challenge, fetch к /api работает с теми же cookies.
//   - Поэтому открываем tmailor.com в Playwright, ждём генерации адреса и далее
//     вызываем API прямо из page.evaluate().
//
// API (найдено в JS сайта):
//   POST /api { action: "newemail", curentToken: "" } -> { msg:"ok", email, accesstoken, ... }
//   POST /api { action: "listinbox", listToken: { [email]: accesstoken } } -> { msg:"ok", data: { [email]: { code, dead, data: { [emailId]: { id, email_id, sender_name, sender_email, subject, receive_time, ... } } } } }
//   POST /api { action: "read", accesstoken, email_code, email_token } -> { msg:"ok", data: { subject, sender_name, sender_email, receive_time, body, url_body } }
//
// Зависимости: playwright.

const BASE_URL = "https://tmailor.com";
const API_URL = "https://tmailor.com/api";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function _flattenStrings(obj, acc = []) {
  if (obj == null) return acc;
  if (typeof obj === "string") { acc.push(obj); return acc; }
  if (typeof obj === "number" || typeof obj === "boolean") return acc;
  if (Array.isArray(obj)) {
    for (const v of obj) _flattenStrings(v, acc);
    return acc;
  }
  if (typeof obj === "object") {
    for (const v of Object.values(obj)) _flattenStrings(v, acc);
  }
  return acc;
}

function _stripHtml(s) {
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function emailToText(email) {
  const parts = _flattenStrings(email);
  return _stripHtml(parts.join(" \n "));
}

function emailMatchesFrom(email, fromHint) {
  if (!fromHint) return true;
  return emailToText(email).toLowerCase().includes(fromHint.toLowerCase());
}

function extractOtp6(text) {
  if (!text) return null;
  const matches = text.match(/(?<!\d)\d{6}(?!\d)/g) || [];
  const candidates = [];
  for (const m of matches) {
    const n = parseInt(m, 10);
    if (n < 100000) continue;
    if (m.startsWith("20") && n >= 200000 && n <= 209999) continue;
    candidates.push(m);
  }
  if (!candidates.length) return null;
  const kw = /(?:code|verification|otp|verify|пин|код)/i;
  for (const c of candidates) {
    const idx = text.indexOf(c);
    if (idx < 0) continue;
    const window = text.substring(Math.max(0, idx - 80), idx + 86);
    if (kw.test(window)) return c;
  }
  return candidates[0];
}

function extractMagicLink(text) {
  if (!text) return null;
  const re = /https?:\/\/(?:www\.)?freemodel\.dev\/[^\s"'<>]+/i;
  const m = text.match(re);
  return m ? m[0] : null;
}

// Создаём новый Playwright context, открываем tmailor.com и ждём, пока
// сайт сам сгенерирует адрес. Возвращаем context (его надо закрыть позже),
// page, email и accesstoken.
async function createEmail(browser, opts = {}) {
  const contextOpts = {
    userAgent: opts.userAgent || UA,
    viewport: opts.viewport || { width: 1280, height: 720 },
    locale: opts.locale || "en-US",
  };
  if (opts.proxy) contextOpts.proxy = opts.proxy;
  const context = await browser.newContext(contextOpts);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();

  // Заходим на tmailor.com. Сайт сам вызовет newemail и запишет адрес в window.currentEmail.
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Ждём появления адреса. Иногда требуется прохождение Turnstile — даём 45 сек.
  await page.waitForFunction(
    () => {
      const current = window.currentEmail;
      return current && typeof current.email === "string" && current.email.includes("@") && typeof current.accesstoken === "string";
    },
    { timeout: 45000 },
  );

  const creds = await page.evaluate(() => ({
    email: window.currentEmail.email,
    accesstoken: window.currentEmail.accesstoken,
  }));

  return {
    address: creds.email,
    accesstoken: creds.accesstoken,
    page,
    context,
  };
}

// Перегенерировать адрес в уже открытом tmailor-контексте через API.
// Быстрее, чем открывать новый context, и позволяет перебирать домены.
async function regenerateEmail(context, page) {
  const result = await page.evaluate(
    async ({ apiUrl }) => {
      const currentToken = (window.currentEmail && window.currentEmail.accesstoken) || "";
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "newemail",
          curentToken: currentToken,
        }),
      });
      return res.json();
    },
    { apiUrl: API_URL },
  );

  if (result && result.msg === "ok" && result.email && result.accesstoken) {
    return { address: result.email, accesstoken: result.accesstoken };
  }
  throw new Error(`tmailor regenerate failed: ${result?.msg || "unknown"}`);
}

// Запросить список писем через API изнутри страницы.
async function fetchInbox(page, address, accesstoken) {
  return page.evaluate(
    async ({ address, accesstoken, apiUrl }) => {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "listinbox",
          listToken: { [address]: accesstoken },
        }),
      });
      return res.json();
    },
    { address, accesstoken, apiUrl: API_URL },
  );
}

// Запросить тело письма через API изнутри страницы.
async function fetchEmailBody(page, address, accesstoken, emailId, emailToken) {
  return page.evaluate(
    async ({ address, accesstoken, emailId, emailToken, apiUrl }) => {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "read",
          accesstoken,
          email_code: emailId,
          email_token: emailToken,
        }),
      });
      return res.json();
    },
    { address, accesstoken, emailId, emailToken, apiUrl: API_URL },
  );
}

// Главная функция — ждёт письмо с OTP от fromHint.
async function waitForOtp(page, accesstoken, address, {
  fromHint = "freemodel",
  timeoutMs = 60000,
  pollMs = 4000,
  log = () => {},
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const seenIds = new Set();

  while (Date.now() < deadline) {
    let result;
    try {
      result = await fetchInbox(page, address, accesstoken);
    } catch (e) {
      log(`[tmailor] inbox error: ${e.message}`);
      await sleep(pollMs);
      continue;
    }

    if (!result || result.msg !== "ok") {
      log(`[tmailor] inbox API msg=${result?.msg || "no-result"}`);
      await sleep(pollMs);
      continue;
    }

    const emailData = result.data?.[address];
    if (!emailData || emailData.dead) {
      await sleep(pollMs);
      continue;
    }

    const emails = emailData.data || {};
    const newEmails = Object.entries(emails).filter(([id]) => !seenIds.has(id));

    if (newEmails.length) {
      log(`[tmailor] inbox: ${Object.keys(emails).length} писем, ${newEmails.length} новых`);
    }

    for (const [id, em] of newEmails) {
      seenIds.add(id);
      log(`[tmailor] new email: subject="${em.subject || ""}" from=${em.sender_email || ""}`);

      // Пытаемся получить тело письма. Если не получится — парсим metadata.
      let body = null;
      try {
        const readResult = await fetchEmailBody(page, address, accesstoken, id, em.email_id);
        if (readResult && readResult.msg === "ok" && readResult.data) {
          body = readResult.data;
        }
      } catch (e) {
        log(`[tmailor] read body error: ${e.message}`);
      }

      const text = emailToText(body || em);
      const matchedFrom = emailMatchesFrom(body || em, fromHint);
      const code = extractOtp6(text);
      const link = extractMagicLink(text);

      log(`[tmailor] text=${text.slice(0, 80).replace(/\n/g, " ")} code=${code || "-"} link=${link ? "yes" : "no"}`);

      if (matchedFrom && (code || link)) {
        return { code, link, raw: body || em };
      }
      if (!matchedFrom && code) {
        log(`[tmailor] fallback: берём код из не-matching письма`);
        return { code, link, raw: body || em };
      }
    }

    await sleep(pollMs);
  }

  return null;
}

module.exports = {
  createEmail,
  regenerateEmail,
  fetchInbox,
  waitForOtp,
  emailToText,
  extractOtp6,
  extractMagicLink,
};
