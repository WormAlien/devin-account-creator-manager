#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  league-join.js — подключить ЭТУ установку хаба к лиге и доказать, что дошло.
//
//  Зачем файл существует. Настройки лиги — один файл (`routing/league-config.json`),
//  и написать его руками нетрудно. Трудно другое: ПРОВЕРИТЬ, что подключение живое.
//  На этом стенде все привычные способы проверки врут, и врут молча:
//    · проба порта через туннель ВСЕГДА успешна — локальный TUN сам отвечает на
//      рукопожатие. Замер: закрытый 12345 «подключился» за 8 мс так же, как рабочий
//      8420. Доказывает только HTTP-код от приёмника;
//    · `ping` не доказывает ничего и на CH-ноде может быть закрыт;
//    · `curl -k` доезжает, но проверку сертификата при этом ВЫКЛЮЧАЕТ — то есть
//      «проверка» проходит и через чужой сервер, которому вы отдали секрет;
//    · путь к приёмнику идёт через туннель, чей выход — та же швейцарская нода.
//      Когда падает туннель, симптомы выглядят как смерть приёмника (EACCES на
//      исходящее, SSH не идёт, /health таймаутит). Поэтому здесь есть КОНТРОЛЬ:
//      посторонний HTTPS. Лёг и он — виноват туннель, а не нода.
//
//  Что делает: пишет валидный конфиг (не затирая существующий без --force), затем
//  ходит на приёмник ровно так, как ходит хаб — по IP, без SNI, с проверкой
//  отпечатка сертификата на каждом свежем рукопожатии. Секрет не печатается никогда
//  и в аргументах может не появляться вовсе (--key-file / LEAGUE_KEY).
//
//  Ничего на приёмнике не меняет: только GET /health (без ключа) и GET /peers (с
//  ключом). Свой срез не отправляет — это сделает сам хаб на следующем тике.
//
//  Запуск:
//    node tools/league-join.js --url=https://<ip>:8420 --pin=<sha256> --key-file=key.txt
//    node tools/league-join.js --check-only          (ничего не писать, только проверить)
//    node tools/league-join.js --help
//
//  Коды выхода: 0 — настроено и приёмник ответил; 1 — не настроено или не доказано.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ARGV = process.argv.slice(2);
const has = n => ARGV.includes('--' + n);
const opt = (n, d) => {
  const p = `--${n}=`;
  const hit = ARGV.find(a => a.startsWith(p));
  return hit === undefined ? d : hit.slice(p.length);
};
const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = opt('out', path.join(ROOT, 'routing', 'league-config.json'));
const IDENTITY_FILE = path.join(ROOT, 'routing', 'hub-identity.json');

if (has('help') || has('h')) {
  console.log(`подключить хаб к лиге и проверить, что приёмник отвечает

  node tools/league-join.js --url=<адрес> --pin=<отпечаток> --key-file=<файл>

  --url=https://<ip>:8420   адрес приёмника (даёт владелец)
  --pin=<sha256>            отпечаток сертификата, для https обязателен
  --key=<секрет>            общий секрет; лучше не так — попадёт в историю оболочки
  --key-file=<файл>         взять секрет из файла (первая строка)
  LEAGUE_KEY=<секрет>       или из переменной окружения
  --ip=<адрес>              соединяться по этому адресу, если в url имя, а не цифры
  --every=10                как часто обмениваться, минут (пол хаба — 2)
  --out=<путь>              писать не в routing/league-config.json, а сюда
  --force                   перезаписать существующий конфиг
  --dry-run                 ничего не писать, показать, что записалось бы
  --check-only              не писать вообще, проверить уже лежащий конфиг
  --no-check                записать и не проверять (сеть не трогается)
  --control=<url>           контрольный запрос, по умолчанию cloudflare trace
  --timeout=20              таймаут одного запроса, секунд

  Секрет не печатается ни в одном режиме — только его длина.`);
  process.exit(0);
}

let bad = 0;
const fail = m => { console.log(`  ⛔ ${m}`); bad++; };
const okLine = m => console.log(`  ✅ ${m}`);
const note = m => console.log(`  ·  ${m}`);
const norm = v => String(v || '').replace(/[^A-Fa-f0-9]/g, '').toUpperCase();

// ── Что уже лежит ────────────────────────────────────────────────────────────
function readConfig(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {}; }
  catch { return { __broken: true }; }
}
const existing = readConfig(CONFIG_FILE);

// ── Секрет: три источника, ни один не печатается ─────────────────────────────
// Порядок именно такой: явный аргумент бьёт файл, файл бьёт окружение, и только в
// режиме проверки берётся то, что уже лежит в конфиге.
function resolveKey() {
  const direct = opt('key', '');
  if (direct) return { key: direct, from: '--key (виден в истории оболочки!)' };
  const kf = opt('key-file', '');
  if (kf) {
    let raw;
    try { raw = fs.readFileSync(kf, 'utf8'); } catch { return { err: `не читается ${kf}` }; }
    const k = raw.split(/\r?\n/)[0].trim();
    return k ? { key: k, from: `--key-file=${kf}` } : { err: `${kf} пустой` };
  }
  if (process.env.LEAGUE_KEY) return { key: process.env.LEAGUE_KEY.trim(), from: 'LEAGUE_KEY' };
  if (existing && existing.key) return { key: String(existing.key), from: 'уже лежащий конфиг' };
  return { err: 'секрета нет: дай --key-file=<файл>, LEAGUE_KEY или --key=' };
}

const CHECK_ONLY = has('check-only');
const DRY = has('dry-run');
const kr = resolveKey();
const URL_BASE = String(opt('url', (existing && existing.url) || '')).replace(/\/+$/, '');
const PIN = norm(opt('pin', (existing && existing.pin) || ''));
const IP = String(opt('ip', (existing && existing.ip) || ''));
const EVERY = Number(opt('every', (existing && existing.everyMin) || 10)) || 10;
const TIMEOUT_MS = Math.max(3, Number(opt('timeout', 20)) || 20) * 1000;
const CONTROL = opt('control', 'https://cloudflare.com/cdn-cgi/trace');

console.log('\nЛига: подключение установки\n');
if (existing && existing.__broken) fail(`${CONFIG_FILE} лежит, но это не JSON — починить или снести`);
if (!/^https?:\/\//i.test(URL_BASE)) fail('нужен --url=http(s)://адрес:порт');
if (kr.err) fail(kr.err);
const IS_TLS = /^https:/i.test(URL_BASE);
// Без пина на https идти нельзя: сертификат приёмника самоподписанный, и хаб
// отключает проверку CA ТОЛЬКО когда есть отпечаток (`if (cfg.pin)` в leagueReq).
// Пустой пин = доверие любому центру = доверие любому, кто нас перехватил.
if (IS_TLS && PIN.length !== 64) {
  fail(PIN ? `отпечаток не похож на sha256: ${PIN.length} hex-символов вместо 64`
    : 'для https нужен --pin=<sha256 сертификата>, иначе секрет уедет кому угодно');
}
if (bad) { console.log('\nитог: не настроено\n'); process.exit(1); }
const KEY = kr.key;
note(`приёмник: ${URL_BASE}${IP ? ` (соединение по ${IP})` : ''}`);
note(`секрет: ${KEY.length} симв., источник — ${kr.from}`);
note(`отпечаток: ${IS_TLS ? PIN.slice(0, 16) + '…' : 'не нужен, адрес по http'}`);

// ── Запись конфига ───────────────────────────────────────────────────────────
// Атомарно и без резервной копии. Копия соблазнительна, но `league-config.json.bak`
// в .gitignore не значится (там перечислен ровно `routing/league-config.json`), то
// есть второй файл с секретом сразу попал бы в `git status` и однажды — в коммит.
// Прежний адрес печатаем, прежний секрет не показываем: он и так у владельца.
function writeConfig() {
  const doc = { enabled: true, url: URL_BASE };
  if (IP) doc.ip = IP;
  if (PIN) doc.pin = PIN;
  doc.key = KEY;
  doc.everyMin = EVERY;
  if (DRY) return { mode: 'dry', shown: JSON.stringify({ ...doc, key: `<${KEY.length} симв.>` }, null, 2) };
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  return { mode: 'written' };
}

console.log('');
if (CHECK_ONLY) {
  if (!existing) { fail(`нечего проверять: ${CONFIG_FILE} нет`); }
  else okLine(`проверяю уже лежащий ${path.basename(CONFIG_FILE)}, ничего не пишу`);
  if (existing && existing.enabled === false) {
    note('в конфиге `enabled: false` — хаб обмениваться не будет, даже если проверка пройдёт');
  }
} else if (existing && !existing.__broken && !has('force') && !DRY) {
  fail(`${CONFIG_FILE} уже есть (url: ${existing.url || '—'})`);
  console.log('     перезаписать — тем же вызовом с --force; посмотреть без записи — --check-only');
} else {
  const r = writeConfig();
  if (r.mode === 'written') okLine(`конфиг записан: ${CONFIG_FILE}`);
  else {
    okLine('--dry-run: файл не тронут, записалось бы вот это');
    console.log(r.shown.split('\n').map(l => '     ' + l).join('\n'));
  }
}
if (bad) { console.log('\nитог: не настроено\n'); process.exit(1); }

// ── Личность установки ───────────────────────────────────────────────────────
// Свой installId не создаём: его сделает хаб при первом обращении к лиге, и второй
// генератор этого поля означал бы вторую строку в рейтинге. Нет файла — берём
// заведомо тестовый id, /peers от этого не меняется.
let ME = crypto.createHash('sha1').update('league-join-probe').digest('hex').slice(0, 16);
let MY_NICK = '';
try {
  const h = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  if (h && h.installId) { ME = String(h.installId); MY_NICK = String(h.nick || ''); }
} catch { /* хаб ещё не заводил личность — не беда */ }

// ── Транспорт: тот же, что у хаба ────────────────────────────────────────────
// Не `fetch`: нужны соединение по IP, пустой SNI и СВЕЖЕЕ рукопожатие на каждый
// запрос. Последнее — условие работы пина, а не оптимизация наоборот: на
// возобновлённой TLS-сессии сервер сертификат не присылает, и сверять нечего.
// Отпечаток сверяется в `secureConnect`, то есть ДО отправки первого байта —
// иначе секрет уедет чужому серверу раньше, чем мы поймём, что он чужой.
let pinChecked = 0, pinFailed = false;
function req(pathname, { key, timeoutMs } = {}) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const u = new URL(pathname.startsWith('http') ? pathname : URL_BASE + pathname);
    const tls = u.protocol === 'https:';
    const lib = tls ? https : http;
    const headers = {};
    if (key) headers['X-League-Key'] = key;
    const own = pathname.startsWith('http');           // контроль идёт по обычным правилам
    const opts = {
      host: (own ? '' : IP) || u.hostname,
      port: u.port || (tls ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', headers,
      timeout: timeoutMs || TIMEOUT_MS,
    };
    if (tls) {
      opts.agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
      if (PIN && !own) { opts.rejectUnauthorized = false; opts.servername = undefined; }
    }
    const r = lib.request(opts, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0,
        body: Buffer.concat(parts).toString('utf8') }));
    });
    if (tls && PIN && !own) {
      r.on('socket', s => s.on('secureConnect', () => {
        let got = '';
        try { got = s.getPeerCertificate().fingerprint256 || ''; } catch { /* нет сертификата */ }
        if (norm(got) !== PIN) {
          pinFailed = true;
          r.destroy(new Error(got
            ? `отпечаток не совпал: ${got.slice(0, 23)}…`
            : 'сертификат не предъявлен (возобновлённая TLS-сессия?)'));
        } else pinChecked++;
      }));
    }
    r.on('timeout', () => r.destroy(new Error(`таймаут ${Math.round((timeoutMs || TIMEOUT_MS) / 1000)} с`)));
    r.on('error', e => reject(Object.assign(e, { ms: Date.now() - t0 })));
    r.end();
  });
}
const jsonOf = r => { try { return JSON.parse(r.body); } catch { return null; } };

// ── Проверка ─────────────────────────────────────────────────────────────────
(async () => {
  if (has('no-check')) {
    console.log('\n--no-check: сеть не трогаю. Обмен начнётся сам на следующем тике хаба.');
    console.log(`Убедиться: http://127.0.0.1:8200/__switch/api/league → receiver.last.ok\n`);
    process.exit(0);
  }
  console.log('\nконтроль (посторонний HTTPS — жив ли путь наружу вообще):');
  let controlOk = false;
  try {
    const c = await req(CONTROL, { timeoutMs: Math.min(TIMEOUT_MS, 15000) });
    controlOk = c.status >= 200 && c.status < 400;
    (controlOk ? okLine : note)(`${CONTROL} → ${c.status} за ${c.ms} мс`);
  } catch (e) {
    note(`${CONTROL} не ответил: ${e.message}`);
  }
  if (!controlOk) {
    console.log('     контроль не прошёл. Сам по себе это не приговор приёмнику —');
    console.log('     но если молчит и он, виноват путь наружу, а не нода');
  }

  console.log('\nприёмник:');
  let health = null;
  try {
    // /health — единственная ручка без ключа. Ответ на неё и есть доказательство,
    // что приёмник жив: ни ping, ни «порт открыт» этого не доказывают.
    const h = await req('/health', {});
    health = jsonOf(h);
    if (h.status === 200 && health && health.ok) {
      okLine(`/health → 200 за ${h.ms} мс, установок сдаёт срезы: ${health.installs}`
        + (health.last ? `, последний ${health.last}` : ''));
    } else fail(`/health → ${h.status}: ${String(h.body).slice(0, 120)}`);
  } catch (e) {
    fail(`/health не ответил: ${e.message}`);
    console.log(controlOk
      ? '     контроль прошёл, значит путь наружу есть — дело в приёмнике или адресе'
      : '     контроль тоже лёг — виноват туннель или сеть, приёмник тут не при чём');
  }
  if (health) {
    try {
      const p = await req(`/peers?installId=${encodeURIComponent(ME)}`, { key: KEY });
      if (p.status === 200) {
        const d = jsonOf(p) || {};
        okLine(`/peers → 200 за ${p.ms} мс: секрет принят, соседей видно ${(d.peers || []).length}`);
      } else if (p.status === 401) {
        fail('/peers → 401: приёмник не принял секрет — он не тот или обрезан при копировании');
      } else fail(`/peers → ${p.status}: ${String(p.body).slice(0, 120)}`);
    } catch (e) { fail(`/peers не ответил: ${e.message}`); }
  }
  if (IS_TLS) {
    // Два запроса — два рукопожатия. Если пин сверился не на всех, значит агент
    // где-то переиспользовал сессию, и проверка отпечатка была пустой.
    const want = health ? 2 : 1;
    if (pinFailed) {
      note('рукопожатие оборвано на несовпавшем отпечатке — сверь `pin` с владельцем;'
        + ' сертификат приёмника могли перевыпустить');
    } else if (pinChecked >= want) okLine(`отпечаток сверен на всех ${pinChecked} рукопожатиях`);
    else fail(`отпечаток сверен ${pinChecked} раз из ${want} — сессия переиспользована?`);
  }

  if (!bad) {
    console.log('\nдальше:');
    if (MY_NICK) note(`ник этой установки — «${MY_NICK}», сменить: вкладка «Лига», карандаш у ника`);
    else note('ника ещё нет: хаб возьмёт `git config user.name` при первом обмене — проверь, что там не настоящее имя');
    note(`обмен начнётся сам, до ${Math.max(2, EVERY)} мин, рестарт хаба не нужен`);
    note('не ждать: curl -X POST http://127.0.0.1:8200/__switch/api/league/sync');
    note('видно тут: http://127.0.0.1:8200/__switch/api/league → receiver.last.ok = true');
  }

  console.log(bad ? '\nитог: подключение НЕ доказано\n' : '\nитог: приёмник отвечает, секрет принят\n');
  process.exit(bad ? 1 : 0);
})();
