// freemodel/lib/timeweb-imap-client.js
//
// Замена CamoufoxTmailor. Тот же интерфейс, но backend — свой домен с catch-all
// у почтового хостера: любой адрес *@ВАШ-ДОМЕН падает в один ящик-ридер,
// который читаем по IMAP.
//
// Настройка — freemodel/.env (gitignored, шаблон в freemodel/.env.example):
//   TW_IMAP_HOST / TW_IMAP_PORT / TW_IMAP_USER / TW_IMAP_PASS  — ящик-ридер
//   TW_MAIL_DOMAIN                                             — домен регистраций
// Без этих значений backend не стартует (внятная ошибка в start()).
//
// API (совместим с CamoufoxTmailor):
//   const client = new TimewebImap({ log: console.log });
//   await client.start();
//   const { email, accesstoken } = await client.create();
//   const { email, accesstoken } = await client.regenerate();
//   const { code, link } = await client.waitOtp({ timeout: 120, poll: 5, fromHint: "freemodel" });
//   await client.stop();
//
// Т.к. все адреса приходят в один ящик, письма СТРОГО фильтруются по
// получателю (To / Delivered-To / X-Original-To == текущий сгенерённый адрес)
// и по времени (INTERNALDATE не раньше момента create()/regenerate()).

const tls = require("tls");
const fs = require("fs");
const path = require("path");

// ── freemodel/.env (gitignored) ────────────────────────────────────
// Крошечный парсер, как в routing/transparent-proxy.js — без зависимости
// от dotenv. Уже выставленные переменные окружения имеют приоритет.
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trimStart().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv(path.join(__dirname, "..", ".env"));

// Ящик-ридер (куда catch-all сваливает все письма) — один на все домены.
// Никаких дефолтов: секретов в коде быть не должно, отсутствие → ошибка в start().
const HOST = process.env.TW_IMAP_HOST || "";
const PORT = parseInt(process.env.TW_IMAP_PORT || "993", 10);
const USER = process.env.TW_IMAP_USER || "";
const PASS = process.env.TW_IMAP_PASS || "";

// Домен, на котором генерируются адреса для регистрации. Все домены через
// catch-all сваливаются в один ящик-ридер (USER выше). Переключается в дашборде
// (файл freemodel/.email_domain) или через env TW_MAIL_DOMAIN.
const EMAIL_DOMAIN_FILE = path.join(__dirname, "..", ".email_domain");
function getMailDomain() {
  if (process.env.TW_MAIL_DOMAIN) return process.env.TW_MAIL_DOMAIN;
  try {
    const v = fs.readFileSync(EMAIL_DOMAIN_FILE, "utf8").trim();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return v;
  } catch {}
  return "";
}
const MAIL_DOMAIN = getMailDomain();

// Понятная диагностика вместо загадочного "IMAP LOGIN failed" / "user@".
function assertConfigured() {
  const miss = [];
  if (!HOST) miss.push("TW_IMAP_HOST");
  if (!USER) miss.push("TW_IMAP_USER");
  if (!PASS) miss.push("TW_IMAP_PASS");
  if (!MAIL_DOMAIN) miss.push("TW_MAIL_DOMAIN (или freemodel/.email_domain)");
  if (miss.length) {
    throw new Error(
      "timeweb-imap не настроен: нет " + miss.join(", ") +
      ". Скопируй freemodel/.env.example → freemodel/.env и заполни " +
      "(или переключи backend на 'tmailor' в дашборде)."
    );
  }
}

// ── Генерация случайного локального адреса ─────────────────────────
function randLocal() {
  // ВАЖНО: только буквы, без цифр. Иначе цифры из локальной части адреса
  // (он встречается в заголовках To/Delivered-To/Received) матчатся регуляркой
  // раньше настоящего 6-значного OTP-кода → "invalid code".
  const adj = ["cool", "fast", "blue", "neo", "sky", "red", "sun", "max", "pro", "zen", "lux", "orb", "ray", "fox", "kit"];
  const noun = ["cat", "dog", "bird", "wolf", "star", "moon", "leaf", "wave", "rock", "fire", "wind", "gold", "iron", "mint", "sage"];
  const abc = "abcdefghijklmnopqrstuvwxyz";
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = noun[Math.floor(Math.random() * noun.length)];
  let tail = "";
  for (let i = 0; i < 6; i++) tail += abc[Math.floor(Math.random() * abc.length)];
  return `${a}${n}${tail}`;
}

// ── Одноразовая IMAP-сессия: выполняет callback(send) и закрывается ──
// send(cmd) -> Promise<{ok, lines[]}> где lines — untagged (* ...) ответы.
function imapSession(fn, { timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: HOST, port: PORT, servername: HOST, rejectUnauthorized: false });
    let buf = "";
    let tagN = 0;
    let greeted = false;
    let current = null; // { tag, untagged:[], resolve }
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; try { sock.destroy(); } catch {} reject(new Error("IMAP session timeout")); } }, timeout);

    function send(cmd) {
      return new Promise((res) => {
        const tag = "t" + (++tagN);
        current = { tag, untagged: [], resolve: res };
        sock.write(tag + " " + cmd + "\r\n");
      });
    }

    async function startFn() {
      try {
        const r = await fn(send);
        try { await send("LOGOUT"); } catch {}
        if (!done) { done = true; clearTimeout(to); sock.end(); resolve(r); }
      } catch (e) {
        if (!done) { done = true; clearTimeout(to); try { sock.destroy(); } catch {} reject(e); }
      }
    }

    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);

        // Приветствие сервера "* OK ... ready" — запускаем fn один раз.
        if (!greeted) {
          if (/^\* /.test(line)) { greeted = true; startFn(); }
          continue;
        }

        if (current == null) continue;
        if (line.startsWith(current.tag + " ")) {
          const ok = /^\S+\s+OK/i.test(line);
          const res = current;
          current = null;
          res.resolve({ ok, tagged: line, untagged: res.untagged });
        } else {
          current.untagged.push(line);
        }
      }
    });

    sock.on("error", (e) => { if (!done) { done = true; clearTimeout(to); reject(e); } });
  });
}

function q(s) { return '"' + String(s).replace(/(["\\])/g, "\\$1") + '"'; }

// ── Парс OTP из текста письма ──────────────────────────────────────
// freemodel кладёт код в Subject: "Your FreeModel code: 576632" и дублирует
// в теле. Заголовки (Return-Path/Delivered-To/Received/To) содержат сам адрес
// получателя, чей локальный part может включать цифры — их нужно игнорировать.
function extractCode(raw, target) {
  if (!raw) return null;

  // 1) Приоритет — тема письма.
  const subj = (raw.match(/^subject:.*$/im) || [""])[0];
  const subjCode = subj.match(/code[:\s]*?(?<!\d)(\d{6})(?!\d)/i) || subj.match(/(?<!\d)(\d{6})(?!\d)/);
  if (subjCode) return subjCode[1];

  // 2) Тело письма — исключаем строки заголовков и строки с адресом получателя.
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (/^(return-path|delivered-to|received|from|to|cc|bcc|message-id|dkim|x-|date|mime|content|subject|reply-to|sender):/i.test(line)) continue;
    if (target && line.toLowerCase().includes(target.toLowerCase())) continue;
    const m = line.match(/(?<!\d)(\d{6})(?!\d)/);
    if (m) return m[1];
  }
  return null;
}
function extractLink(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

class TimewebImap {
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.email = null;
    this.sinceTs = 0; // время генерации адреса (мс) — письма раньше игнорим
    this.startedAt = 0;
  }

  async start() {
    assertConfigured();
    // Проверка соединения/логина.
    await imapSession(async (send) => {
      const login = await send(`LOGIN ${q(USER)} ${q(PASS)}`);
      if (!login.ok) throw new Error("IMAP LOGIN failed: " + login.tagged);
      return true;
    });
    this.startedAt = Date.now();
    this.log("[timeweb-imap] IMAP OK (" + USER + ")");
  }

  _newAddress() {
    this.email = randLocal() + "@" + MAIL_DOMAIN;
    this.sinceTs = Date.now() - 15000; // -15с запас на рассинхрон часов
    return { email: this.email, accesstoken: this.email };
  }

  async create() {
    const r = this._newAddress();
    this.log("[timeweb-imap] новый адрес: " + r.email);
    return r;
  }

  async regenerate() {
    const r = this._newAddress();
    this.log("[timeweb-imap] regenerate: " + r.email);
    return r;
  }

  // Один проход по ящику: ищем свежее письмо на this.email от fromHint с кодом.
  async _pollOnce(fromHint) {
    const target = this.email;
    return imapSession(async (send) => {
      const login = await send(`LOGIN ${q(USER)} ${q(PASS)}`);
      if (!login.ok) throw new Error("LOGIN failed");
      const sel = await send("SELECT INBOX");
      if (!sel.ok) throw new Error("SELECT failed");

      // Ищем по получателю. TO ищет в заголовке To; catch-all письма обычно
      // имеют правильный To. Добавляем UNSEEN чтобы не перечитывать старьё.
      const search = await send(`UID SEARCH TO ${q(target)}`);
      let uids = [];
      for (const l of search.untagged) {
        const m = l.match(/^\* SEARCH(.*)$/i);
        if (m) uids = m[1].trim().split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
      }
      if (!uids.length) return null;

      // Берём последние UID (самые свежие) — до 5 штук.
      uids = uids.slice(-5).reverse();
      for (const uid of uids) {
        const fetch = await send(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[])`);
        if (!fetch.ok) continue;
        const raw = fetch.untagged.join("\r\n");
        // INTERNALDATE фильтр
        const idm = raw.match(/INTERNALDATE\s+"([^"]+)"/i);
        if (idm) {
          const t = Date.parse(idm[1].replace(/(\d{2})-(\w{3})-(\d{4})/, "$1 $2 $3"));
          if (!isNaN(t) && t < this.sinceTs) continue;
        }
        // Проверяем получателя ещё раз внутри тела (To / Delivered-To / X-Original-To)
        const toOk = new RegExp("(to|delivered-to|x-original-to):[^\\n]*" + target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(raw);
        if (!toOk) continue;
        // fromHint
        if (fromHint) {
          const fromLine = (raw.match(/^from:.*/im) || [""])[0].toLowerCase();
          if (fromLine && !fromLine.includes(fromHint.toLowerCase()) &&
              !raw.toLowerCase().includes(fromHint.toLowerCase())) {
            // мягкая проверка: fromHint должен встречаться хоть где-то
            continue;
          }
        }
        const code = extractCode(raw, target);
        const link = extractLink(raw);
        if (code || link) {
          // Удаляем письмо после чтения: не перечитаем, ящик не пухнет.
          try {
            await send(`UID STORE ${uid} +FLAGS (\\Deleted)`);
            await send("EXPUNGE");
          } catch {}
          return { code, link, uid };
        }
      }
      return null;
    });
  }

  async waitOtp(opts = {}) {
    const timeout = (opts.timeout || 120) * 1000;
    const poll = (opts.poll || 5) * 1000;
    const fromHint = opts.fromHint || "freemodel";
    const deadline = Date.now() + timeout;
    this.log(`[timeweb-imap] жду OTP на ${this.email} (fromHint=${fromHint}, ${Math.round(timeout / 1000)}с)`);
    while (Date.now() < deadline) {
      try {
        const got = await this._pollOnce(fromHint);
        if (got && (got.code || got.link)) {
          this.log(`[timeweb-imap] найдено: code=${got.code || "-"} link=${got.link ? "yes" : "-"}`);
          return { ok: true, code: got.code || null, link: got.link || null };
        }
      } catch (e) {
        this.log("[timeweb-imap] poll err: " + e.message);
      }
      await new Promise((r) => setTimeout(r, poll));
    }
    return { ok: false, code: null, link: null };
  }

  async stop() {
    // Ничего постоянного не держим — сессии одноразовые.
    this.email = null;
  }
}

module.exports = { TimewebImap, extractCode, extractLink };
