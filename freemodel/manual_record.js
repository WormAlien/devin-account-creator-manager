// freemodel/manual_record.js
//
// Ручной прогон регистрации FreeModel + 10minutemail с записью трафика.
// 10minutemail API лучше делать curl (Cloudflare в браузере Playwright блокирует
// fetch, хотя обычный Chrome у пользователя проходит).
//
// Скрипт:
//   1. Через curl получает адрес 10minutemail и cookie.
//   2. Открывает браузер с двумя вкладками: 10minutemail (с cookie) и FreeModel invite.
//   3. Поллит почту через curl и выводит raw JSON письма + OTP/link.
//   4. Логирует freemodel API запросы/ответы.
//
// Запуск:
//   node freemodel/manual_record.js [FRE-XXXX]

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const tmm = require('./lib/10minutemail');

const config = require('./config');

const INVITE = process.argv[2] || (() => {
  const f = path.join(__dirname, '.last_invite');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return config.INITIAL_INVITE;
})();

const SIGNUP_URL = config.SIGNUP_URL_TPL.replace('{CODE}', INVITE);

function log(tag, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}] ${msg}`);
}

(async () => {
  // 1. Получаем почту через curl (работает в отличие от Playwright fetch)
  let jar;
  let address;
  try {
    const emailData = await tmm.createEmail();
    jar = emailData.jar;
    address = emailData.address;
  } catch (e) {
    log('ERR', `не удалось создать 10minutemail: ${e.message}`);
    process.exit(1);
  }

  log('MAIL', `address = ${address}`);
  fs.writeFileSync(path.join(__dirname, 'manual_email.txt'), `${address}\n`, 'utf8');

  // 2. Парсим cookie из curl-jar, чтобы вставить в браузер
  let cookies = [];
  try {
    const jarText = fs.readFileSync(jar.jarPath, 'utf8');
    cookies = jarText.split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => {
        const parts = l.split('\t');
        if (parts.length < 7) return null;
        const [domain, flag, path, secure, expiration, name, value] = parts;
        return {
          name,
          value,
          domain: domain.startsWith('.') ? domain : domain,
          path,
          secure: secure === 'TRUE',
          httpOnly: true,
        };
      }).filter(Boolean);
  } catch (e) {
    log('WARN', `не удалось распарсить cookie: ${e.message}`);
  }

  // 3. Браузер
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  if (cookies.length) {
    try { await context.addCookies(cookies); } catch (e) { log('WARN', `addCookies: ${e.message}`); }
  }

  // Вкладка 1: 10minutemail (с уже установленной сессией)
  const mailPage = await context.newPage();
  await mailPage.goto('https://10minutemail.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await mailPage.waitForTimeout(2000);
  log('MAIL', 'вкладка 10minutemail открыта');

  // Вкладка 2: FreeModel invite
  const fmPage = await context.newPage();
  await fmPage.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('FM', `opened ${SIGNUP_URL}`);

  // Логируем freemodel API
  for (const page of [mailPage, fmPage]) {
    page.on('request', req => {
      const url = req.url();
      if (url.includes('freemodel')) {
        log('NET', `${req.method()} ${url.slice(0, 120)}`);
      }
    });
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('freemodel.dev/api/')) {
        try {
          const body = await res.text();
          log('NET', `<<< ${url} ${body.slice(0, 400)}`);
        } catch {}
      }
    });
  }

  // 4. Поллинг писем через curl (не через браузер, чтобы не ловить Cloudflare)
  let lastCount = 0;
  const seen = new Set();
  const pollInterval = setInterval(async () => {
    try {
      const inbox = await tmm.fetchInbox(jar);
      if (inbox.count !== lastCount) {
        log('MAIL', `inbox count changed: ${inbox.count}`);
        lastCount = inbox.count;
      }
      if (inbox.count > 0) {
        const emails = await tmm.fetchMessagesAfter(jar, 0);
        for (const em of (Array.isArray(emails) ? emails : [])) {
          const key = JSON.stringify(em);
          if (seen.has(key)) continue;
          seen.add(key);
          const text = tmm.emailToText(em);
          const code = tmm.extractOtp6(text);
          const link = tmm.extractMagicLink(text);
          log('MAIL', '━━━━━━━━━━━━━━━━━━━━━━━━━━');
          log('MAIL', `raw: ${JSON.stringify(em).slice(0, 600)}`);
          log('MAIL', `text: ${text.slice(0, 300)}`);
          log('MAIL', `OTP: ${code || '—'}`);
          log('MAIL', `link: ${link || '—'}`);
        }
      }
    } catch (e) {
      // silently ignore during manual interaction
    }
  }, 4000);

  log('INFO', 'Браузер открыт. Действуй вручную. Ctrl+C в терминале — закрыть.');

  process.stdin.resume();
  process.on('SIGINT', async () => {
    log('INFO', 'закрываю браузер...');
    clearInterval(pollInterval);
    try { jar.dispose(); } catch {}
    await browser.close();
    process.exit(0);
  });
})();
