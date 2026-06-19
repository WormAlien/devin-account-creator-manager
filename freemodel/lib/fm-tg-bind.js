// freemodel/lib/fm-tg-bind.js
//
// Привязка Telegram-аккаунта из пула к FreeModel-сессии.
// Алгоритм (портировано из legacy-autoregers/test-fm-full-tg-bind.js):
//   1. Открыть https://freemodel.dev/dashboard с сохранённой сессией.
//   2. Кликнуть "Verify now" / "Bind Telegram" (JS click, чтобы модалка не ловила backdrop).
//   3. Извлечь magic link t.me/<bot>?start=<token>.
//   4. Через gramjs-клиент из tg-client отправить боту /start <token>.
//   5. Подождать, пока FreeModel покажет verified / telegram connected.
//   6. Создать API-ключ (через internal/freemodel-manager.js extractFreemodelApiKey).
//
// Возвращает { ok, apiKey, tgPhone, usedEntry } или { ok:false, error }.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const tgPool = require('./tg-pool');
const tgClient = require('./tg-client');
const dashApi = require('../../internal/dashboard-api');

const DASHBOARD_URL = 'https://freemodel.dev/dashboard';
const MAGIC_RE = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\?start=([A-Za-z0-9_\-=.]+)/i;

const EN_CONTEXT_OPTS = {
  locale: 'en-US',
  extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(logger, msg) { logger(`[fm-tg] ${msg}`); }

// Извлечь magic link из страницы.
async function extractMagicLink(page) {
  return page.evaluate(() => {
    const re = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\?start=([A-Za-z0-9_\-=.]+)/i;
    for (const a of document.querySelectorAll('a[href], [data-href], [data-url]')) {
      for (const attr of ['href', 'data-href', 'data-url']) {
        const v = a.getAttribute && a.getAttribute(attr);
        if (!v) continue;
        const m = v.match(re);
        if (m) return { bot: m[1], token: m[2], raw: v };
      }
    }
    const m = (document.body?.innerText || '').match(re);
    if (m) return { bot: m[1], token: m[2] };
    return null;
  });
}

async function bindTelegram(sessionDir, phone, opts = {}) {
  const logger = opts.log || (() => {});
  const headless = opts.headless !== false;
  const skipApiKey = opts.skipApiKey === true;
  const timeoutMs = opts.timeoutMs || 120000;

  const sessionFile = path.join(sessionDir, 'session.json');
  if (!fs.existsSync(sessionFile)) {
    return { ok: false, error: 'session.json not found' };
  }

  let browser = null;
  let tg = null;
  let entry = null;
  let tgPhone = null;
  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      storageState: sessionFile,
      ...EN_CONTEXT_OPTS,
    });
    const page = await context.newPage();

    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {
      log(logger, 'goto warn: ' + e.message);
    });
    await sleep(3000);

    // Если сразу не видно "Bind Telegram" — открываем модалку через "Verify now".
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (!/Bind Telegram/i.test(bodyText)) {
      log(logger, 'Opening verification modal via JS click...');
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) { if (/Verify now/i.test(b.textContent)) { b.click(); return; } }
      });
      await sleep(2000);
    }

    // JS click по "Bind Telegram".
    log(logger, 'Clicking Bind Telegram via JS...');
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button, a');
      for (const b of btns) { if (/Bind Telegram/i.test(b.textContent)) { b.click(); return; } }
    });
    await sleep(3500);

    const magicLink = await extractMagicLink(page);
    if (!magicLink) {
      throw new Error('Magic link not found');
    }
    log(logger, `magic link: bot=${magicLink.bot} token=${magicLink.token.slice(0, 20)}...`);

    // Перебираем TG из пула. Токен привязки тут принадлежит FreeModel-аккаунту,
    // поэтому его можно слать с разных TG. Если бот отвечает "already bound to a
    // different account" — этот TG уже занят на стороне FreeModel (в пуле мог
    // числиться free): помечаем used и берём следующий свободный.
    const maxTries = phone ? 1 : 6;
    let verified = false;
    for (let tryNo = 0; tryNo < maxTries && !verified; tryNo++) {
      entry = phone
        ? tgPool.list().find(e => e.phone === String(phone).replace(/^\+/, ''))
        : tgPool.reserve(sessionDir);
      if (!entry) {
        throw new Error(phone ? `TG ${phone} not found` : 'No free TG account in pool');
      }
      if (phone) tgPool.markUsed(entry.phone, sessionDir);
      tgPhone = entry.phone;
      log(logger, `reserved TG +${tgPhone} (попытка ${tryNo + 1}/${maxTries})`);

      const created = await tgClient.createClient(entry, { logger });
      tg = created.client;
      const sent = await tgClient.sendStartWithToken(tg, magicLink.bot, magicLink.token, {
        timeoutMs: 15000,
        logger,
      });
      const reply = sent?.reply || '';
      log(logger, 'Sent /start to bot, reply: ' + (reply || '(none)'));

      // TG уже привязан к другому FreeModel-аккаунту → used, берём следующий.
      if (/already bound to a different account|already (?:bound|linked)/i.test(reply)) {
        log(logger, `TG +${tgPhone} уже привязан к другому аккаунту → used, беру следующий`);
        tgPool.markUsed(tgPhone, 'bound-elsewhere');
        await tgClient.disconnect(tg).catch(() => {});
        tg = null;
        const skipped = tgPhone;
        entry = null; tgPhone = null;
        if (phone) return { ok: false, error: 'TG already bound to a different account', tgPhone: skipped };
        continue;
      }

      // Ждём подтверждения на странице.
      log(logger, 'Waiting for verification...');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(3000);
        const txt = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
        const curUrl = page.url();
        if (/verified|подтвержден|telegram connected|successful|success|complete/i.test(txt)) {
          verified = true;
          break;
        }
        if (!/(waiting for telegram|bind telegram|verify your account)/i.test(txt)) {
          verified = true;
          break;
        }
        log(logger, `poll url=${curUrl} text=${txt.slice(0, 100).replace(/\n/g, ' ')}`);
      }
      if (!verified) {
        // не already-bound, но и не подтвердилось — этот TG не сработал, выходим.
        await tgClient.disconnect(tg).catch(() => {});
        tg = null;
        throw new Error('Verification timeout');
      }
    }
    if (!verified) throw new Error('Не нашёл свободный непривязанный TG в пуле (все already bound?)');
    log(logger, 'Verification confirmed!');

    await context.storageState({ path: sessionFile });
    await tgClient.disconnect(tg);
    tg = null;
    await browser.close();
    browser = null;

    // Обновляем метаданные.
    const sessionName = path.basename(sessionDir);
    dashApi.setFreemodelTgPhone(sessionName, tgPhone);

    let apiKey = null;
    if (!skipApiKey) {
      try {
        const { extractFreemodelApiKey } = require('../../internal/freemodel-manager');
        const session = { name: sessionName, path: sessionDir };
        const keyRes = await extractFreemodelApiKey(session);
        if (keyRes.ok) {
          apiKey = keyRes.apiKey;
          log(logger, `API key: ${apiKey.slice(0, 12)}...`);
          dashApi.setFreemodelApiKey(sessionName, apiKey);
        } else {
          log(logger, `API key extraction: ${keyRes.error}`);
        }
      } catch (e) {
        log(logger, `API key extraction failed: ${e.message} — продолжаем без ключа`);
      }
    }

    return { ok: true, apiKey, tgPhone, usedEntry: entry };
  } catch (e) {
    log(logger, 'ERROR: ' + e.message);
    const msg = e.message || '';
    if (/SESSION_REVOKED|AUTH_KEY_UNREGISTERED|USER_DEACTIVATED| deactivated/i.test(msg)) {
      tgPool.markBanned(tgPhone, msg);
      log(logger, `TG +${tgPhone} marked as banned`);
    }
    try { if (tg) await tgClient.disconnect(tg); } catch {}
    try { if (browser) await browser.close(); } catch {}
    return { ok: false, error: e.message, tgPhone };
  }
}

module.exports = { bindTelegram };
