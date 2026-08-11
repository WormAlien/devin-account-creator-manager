/**
 * anymodel/anymodel_autoreger.js
 * Авторега anymodel.org — email (emailnator) + Turnstile (Camoufox) + OTP + Telegram.
 *
 * Использование:
 *   node anymodel_autoreger.js --tg-pool ../tg-sessions/pool.json --limit 5
 */
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { CamoufoxAmodel } = require("./lib/camoufox-anymodel-client");
const { CamoufoxEmailnator } = require("../freemodel/lib/camoufox-emailnator-client");
const tgClient = require("../freemodel/lib/tg-client");
const tgPool = require("../freemodel/lib/tg-pool");
const tgUsage = require("./lib/tg-usage");
const { Api } = require("telegram");

const PASSWORD = "Pqmfksk123!";
const TG_BOT = "ai_anymodel_bot";
const TG_CHANNEL = "ai_anymodel";
const TG_CHAT = "vibecoding_anymodel";
const BAN_RE = /AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|deactivated|USER_BANNED|FROZEN/i;

const EXTRACT_KEY_JS = `(() => {
  const inputs = document.querySelectorAll('input[readonly], input[type="text"]');
  for (const inp of inputs) {
    if (inp.value && (inp.value.startsWith('sk-') || inp.value.length > 20)) return inp.value;
  }
  const m = document.body.innerText.match(/sk-[a-zA-Z0-9_-]{20,}/);
  return m ? m[0] : '';
})()`;

const ACCOUNTS_DIR = path.join(__dirname, "accounts");
const LOGS_DIR = path.join(__dirname, "logs");

fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  const line = `[${t}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOGS_DIR, "autoreger.log"), line + "\n");
}

async function promptUser(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg + "\n> ", () => {
      rl.close();
      resolve();
    });
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 1, tgPoolPath: null, proxy: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (args[i] === "--tg-pool") opts.tgPoolPath = args[++i];
    else if (args[i] === "--proxy") opts.proxy = args[++i];
    // Позиционный счётчик: дашборд запускает `node anymodel_autoreger.js 5`
    // (launchScript пропускает только целые числа, флаги отфильтровываются).
    else if (/^\d+$/.test(args[i])) opts.limit = parseInt(args[i], 10);
  }
  opts.limit = Math.max(1, opts.limit || 1);
  return opts;
}

function generateEmail() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const name = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${name}@gmail.com`;
}

// Профиль Camoufox привязан к pid и умирает вместе с процессом — сессию надо
// снять до stop(), иначе зарегистрированный аккаунт останется без доступа.
async function saveSession(camoufox, index) {
  const dir = path.join(ACCOUNTS_DIR, `session_${index}`);
  try {
    const r = await camoufox.saveSession(dir);
    if (r.ok) log(`#${index} сессия сохранена: ${r.count} cookies → ${dir}`);
    else log(`#${index} ⚠ сессия НЕ сохранена: ${r.error}`);
    return r.ok;
  } catch (e) {
    log(`#${index} ⚠ сессия НЕ сохранена: ${e.message}`);
    return false;
  }
}

async function createAccount({ index, proxy, tgPoolPath }) {
  log(`=== Account #${index} ===`);

  // --- Step 1: Get email from emailnator ---
  // anymodel режет одноразовые домены (tmailor выдаёт adn3t.com и подобные),
  // а emailnator даёт алиасы на gmail/googlemail — их сайт принимает.
  log(`#${index} [1/5] Получаю email через emailnator...`);
  const mailer = new CamoufoxEmailnator({ proxy, headless: false, log: (m) => log(`  [emailnator] ${m}`) });
  await mailer.start();

  let email;
  try {
    const res = await mailer.create();
    email = res && res.email;
    if (!email) throw new Error(res && res.error ? res.error : "emailnator create failed");
    log(`#${index} email: ${email}`);
  } catch (e) {
    log(`#${index} emailnator err: ${e.message}`);
    await mailer.stop();
    return null;
  }

  // --- Step 2: Register on anymodel.org ---
  log(`#${index} [2/5] Регистрируюсь на anymodel.org...`);
  let camoufox = new CamoufoxAmodel({ proxy, logger: (m) => log(`  [camoufox] ${m}`) });
  await camoufox.start();

  let regResult;
  // Retry если адрес уже занят — emailnator выдаёт новый через create().
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      regResult = await camoufox.register(email, PASSWORD);
      log(`#${index} register result (attempt ${attempt}): ${JSON.stringify(regResult)}`);

      if (regResult.ok) break;

      const err = (regResult.error || "").toLowerCase();
      if (err.includes("already registered") || err.includes("уже зарегистрирован")) {
        log(`#${index} email уже занят — беру новый у emailnator...`);
        try {
          const r = await mailer.create();
          email = r && r.email;
          if (!email) throw new Error("emailnator вернул пустой email");
          log(`#${index} новый email: ${email}`);
        } catch (mailErr) {
          log(`#${index} emailnator err: ${mailErr.message}`);
          await camoufox.stop();
          await mailer.stop();
          return null;
        }
        // Перезапускаем браузер anymodel — старый уже показал форму с ошибкой
        await camoufox.stop();
        camoufox = new CamoufoxAmodel({ proxy, logger: (m) => log(`  [camoufox] ${m}`) });
        await camoufox.start();
        continue;
      }
      // VPN/IP-блок — просим юзера сменить IP и пробуем снова.
      if (err.includes("couldn't complete") || err.includes("vpn") || err.includes("network")) {
        log(`#${index} IP/VPN блок: ${regResult.error.slice(0, 120)}`);
        log(`#${index} ⚠ Смени VPN/IP и нажми Enter чтобы продолжить...`);
        await promptUser(">>> Смени VPN/IP и нажми Enter <<<");
        log(`#${index} IP сменён — перезапускаю браузер...`);
        await camoufox.stop();
        camoufox = new CamoufoxAmodel({ proxy, logger: (m) => log(`  [camoufox] ${m}`) });
        await camoufox.start();
        attempt--; // не тратить слот — VPN-ретрай не считается
        continue;
      }

      log(`#${index} registration failed: ${regResult.error}`);
      await camoufox.stop();
      await mailer.stop();
      return null;
    } catch (e) {
      log(`#${index} register err: ${e.message}`);
      await camoufox.stop();
      await mailer.stop();
      return null;
    }
  }

  if (!regResult || !regResult.ok) {
    log(`#${index} registration failed after retries`);
    await camoufox.stop();
    await mailer.stop();
    return null;
  }

  // --- Step 3: Wait for OTP ---
  log(`#${index} [3/5] Жду OTP на ${email}...`);
  let otpCode;
  try {
    // fromHint — camelCase; письмо от anymodel ищем по отправителю.
    const otpRes = await mailer.waitOtp({ timeout: 300, poll: 8, fromHint: "anymodel" });
    log(`#${index} OTP result: ${JSON.stringify(otpRes)}`);
    otpCode = otpRes && otpRes.code;
    if (!otpCode) {
      log(`#${index} OTP timeout`);
      await saveSession(camoufox, index);
      await camoufox.stop();
      await mailer.stop();
      return null;
    }
    log(`#${index} OTP: ${otpCode}`);
  } catch (e) {
    log(`#${index} OTP err: ${e.message}`);
    await saveSession(camoufox, index);
    await camoufox.stop();
    await mailer.stop();
    return null;
  }

  await mailer.stop();

  // --- Step 4: Enter OTP ---
  log(`#${index} [4/5] Ввожу OTP...`);
  let otpResult;
  try {
    otpResult = await camoufox.enterOtp(otpCode);
    log(`#${index} OTP enter result: ${JSON.stringify(otpResult)}`);
  } catch (e) {
    log(`#${index} enter OTP err: ${e.message}`);
    await saveSession(camoufox, index);
    await camoufox.stop();
    return null;
  }

  // --- Step 5: Telegram verification ---
  log(`#${index} [5/5] Telegram верификация...`);

  let apiKey = null;
  let tgPhone = null;

  const candidates = tgUsage.available();
  log(`#${index} ТГ доступно: ${candidates.length} (${JSON.stringify(tgUsage.stats())})`);

  for (const entry of candidates) {
    let client = null;
    try {
      log(`#${index} ТГ +${entry.phone} — подписка на канал и чат...`);
      client = (await tgClient.createClient(entry, { logger: (m) => log(`  [tg] ${m}`) })).client;

      for (const ch of [TG_CHANNEL, TG_CHAT]) {
        try {
          await client.invoke(new Api.channels.JoinChannel({ channel: ch }));
          log(`#${index} вступил в @${ch}`);
        } catch (e) {
          // "уже подписан" — нормально, но мёртвый ключ вылезет здесь же.
          if (BAN_RE.test(e.message)) throw e;
          log(`#${index} join @${ch}: ${e.message}`);
        }
      }

      // Сайт связывает аккаунт с ТГ через t.me/<bot>?start=<token> — токен
      // надо снять со страницы и отправить боту, иначе бонус уйдёт в никуда.
      const linkRes = await camoufox.evaluate(`(() => {
        const re = /(?:https?:\\/\\/)?(?:t\\.me|telegram\\.me)\\/([A-Za-z0-9_]{4,32})\\?start=([A-Za-z0-9_\\-=.]+)/i;
        for (const a of document.querySelectorAll('a[href]')) {
          const m = (a.getAttribute('href') || '').match(re);
          if (m) return m[1] + '|' + m[2];
        }
        const m = (document.body.innerText || '').match(re);
        return m ? m[1] + '|' + m[2] : '';
      })()`);

      if (!linkRes.ok || !linkRes.result) {
        // Каналы уже подписаны этим ТГ — он засветился, второй раз его брать
        // незачем, поэтому помечаем used даже без привязки.
        log(`#${index} ⚠ magic link не найден на странице — пропускаю привязку`);
        tgUsage.markUsed(entry.phone);
        tgPhone = entry.phone;
        await tgClient.disconnect(client);
        client = null;
        break;
      }

      const [bot, token] = String(linkRes.result).split("|");
      log(`#${index} magic link: @${bot} start=${token.slice(0, 12)}…`);
      await tgClient.sendStartWithToken(client, bot || TG_BOT, token, {
        timeoutMs: 20_000,
        logger: (m) => log(`  ${m}`),
      });

      await new Promise((r) => setTimeout(r, 5000));

      const keyRes = await camoufox.evaluate(EXTRACT_KEY_JS);
      if (keyRes.ok && keyRes.result) {
        apiKey = keyRes.result;
        log(`#${index} API key: ${apiKey.slice(0, 20)}...`);
      }

      tgPhone = entry.phone;
      tgUsage.markUsed(entry.phone);
      await tgClient.disconnect(client);
      client = null;
      break;

    } catch (e) {
      if (client) await tgClient.disconnect(client).catch(() => {});
      log(`#${index} ТГ +${entry.phone} err: ${e.message}`);
      if (BAN_RE.test(e.message)) {
        // Мёртвый ТГ мёртв на всех сервисах — помечаем глобально.
        tgPool.markBanned(entry.phone, e.message);
        log(`#${index} ТГ +${entry.phone} забанен → следующий`);
      } else {
        // Сетевой сбой/FLOOD_WAIT — аккаунт живой и в AnyModel не засветился.
        // Помечать used нельзя: так живые ТГ выбывают из пула, не зарегавшись.
        log(`#${index} ⚠ ${e.message} → следующий ТГ (номер остаётся свободным)`);
      }
    }
  }

  if (!apiKey) {
    const keyRes = await camoufox.evaluate(EXTRACT_KEY_JS);
    if (keyRes.ok && keyRes.result) {
      apiKey = keyRes.result;
      log(`#${index} API key (без ТГ): ${apiKey.slice(0, 20)}...`);
    }
  }

  const sessionSaved = await saveSession(camoufox, index);
  await camoufox.stop();

  // Save account
  const account = {
    email,
    password: PASSWORD,
    api_key: apiKey || "",
    tg_phone: tgPhone || "",
    session_saved: sessionSaved,
    session_dir: sessionSaved ? `session_${index}` : null,
    created_at: new Date().toISOString(),
    status: apiKey ? "ok" : "no_api_key",
  };

  const accountFile = path.join(ACCOUNTS_DIR, `account_${index}.json`);
  fs.writeFileSync(accountFile, JSON.stringify(account, null, 2));
  log(`#${index} saved → ${accountFile}`);

  return account;
}

async function main() {
  const opts = parseArgs();
  log(`Авторега anymodel.org | limit=${opts.limit} | proxy=${opts.proxy || "none"}`);

  const results = [];
  for (let i = 0; i < opts.limit; i++) {
    try {
      const account = await createAccount({
        index: i + 1,
        proxy: opts.proxy,
        tgPoolPath: opts.tgPoolPath,
      });
      results.push(account);
    } catch (e) {
      log(`#${i + 1} FATAL: ${e.message}`);
      results.push(null);
    }

    // Pause between accounts
    if (i < opts.limit - 1) {
      const pause = 5 + Math.random() * 10;
      log(`Pause ${pause.toFixed(1)}s...`);
      await new Promise((r) => setTimeout(r, pause * 1000));
    }
  }

  const ok = results.filter(Boolean);
  const fail = results.filter((r) => !r);
  log(`\n=== ИТОГО: ${ok.length} OK / ${fail.length} FAIL из ${opts.limit} ===`);

  // Summary
  for (const acc of ok) {
    log(`  ✅ ${acc.email} | key=${acc.api_key ? acc.api_key.slice(0, 20) + "..." : "N/A"} | tg=${acc.tg_phone || "N/A"}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
