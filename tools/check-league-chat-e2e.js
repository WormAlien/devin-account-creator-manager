#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  check-league-chat-e2e.js — сквозная проверка чата «Лиги» против ЖИВОГО приёмника.
//
//  Чем отличается от `check-league-receiver.js`: тот поднимает приёмник у себя и
//  проверяет его отказы, а этот ходит на ноду ровно так, как ходит хаб — по IP, без
//  SNI, с проверкой отпечатка сертификата. То есть проверяется не код, а выкат:
//  доехал ли файл, поднялся ли сервис, работают ли ручки чата через реальный TLS.
//
//  Полный путь, который проходится: отправить сообщение → получить его по `since=`
//  → отправить с вложением webp → скачать вложение и сверить байты → упереться в
//  лимит и получить 429 → убедиться, что чужой ключ даёт 401.
//
//  Пока ручек чата на ноде нет — это НЕ ошибка, а ожидаемое состояние до выката:
//  скрипт говорит об этом словами и выходит кодом 0.
//
//  ⚠ Прогон ОСТАВЛЯЕТ в чате свои сообщения. Ручка удаления у приёмника появилась
//  05.09 (`DELETE /chat/<seq>`, `?installId=`, `?all=1`), так что убрать их есть чем —
//  но сам скрипт этого не делает: чат общий, и решение «что снести» не автоматическое.
//  Их немного и они помечены; в конце печатается, что осталось.
//  Чужого скрипт не трогает вообще. Проверка лимита стоит ~20 сообщений — если
//  нужен тихий прогон, есть --no-flood.
//
//  Запуск: node tools/check-league-chat-e2e.js        (exit 1 = чат сломан)
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

if (has('help') || has('h')) {
  console.log(`сквозная проверка чата лиги против живого приёмника

  node tools/check-league-chat-e2e.js [опции]

  --no-flood        не проверять лимит 429 (тихий прогон, ~2 сообщения вместо ~22)
  --burst=25        сколько сообщений подряд слать в поисках лимита
  --as-me           ходить под своей установкой из routing/hub-identity.json
                    (по умолчанию — под отдельной тестовой, чтобы не жечь свою квоту)
  --config=<путь>   вместо routing/league-config.json
  --url= --key= --pin=   переопределить адрес, секрет и отпечаток по отдельности
                    (например, чтобы прогнать против приёмника на 127.0.0.1)`);
  process.exit(0);
}
// ── Конфиг ───────────────────────────────────────────────────────────────────
const CONFIG_FILE = opt('config', path.join(ROOT, 'routing', 'league-config.json'));
function loadConfig() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {}; } catch { return {}; }
}
const cfgFile = loadConfig();
if (!cfgFile && !opt('url', '')) {
  console.log(`⛔ нет ${CONFIG_FILE} — лига на этой машине не настроена.`);
  console.log('   Проверять нечего: без секрета и отпечатка на приёмник не попасть.');
  console.log('   Либо положи конфиг, либо укажи --url= --key= (--pin= для https).');
  process.exit(1);
}
const cfg = cfgFile || {};
const URL_BASE = String(opt('url', cfg.url || '')).replace(/\/+$/, '');
const IS_TLS = /^https:/i.test(URL_BASE);
const KEY = String(opt('key', cfg.key || ''));
const PIN = String(opt('pin', cfg.pin || ''));
const IP = String(cfg.ip || '');
if (!URL_BASE || !KEY) {
  console.log('⛔ в конфиге нет url или key — идти некуда и нечем');
  process.exit(1);
}

// Личность. По умолчанию — отдельная тестовая, а не своя: лимит чата считается на
// установку, и прогон под своим id съел бы квоту живого хаба на минуту вперёд.
// installId обязан выглядеть как наш (16–64 hex), иначе приёмник отвергнет тело.
let ME = { installId: crypto.createHash('sha1').update('league-chat-e2e').digest('hex').slice(0, 16),
  nick: 'e2e-probe' };
if (has('as-me')) {
  try {
    const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'routing', 'hub-identity.json'), 'utf8'));
    if (h && h.installId) ME = { installId: h.installId, nick: h.nick || 'hub' };
  } catch { console.log('⚠️  --as-me: hub-identity.json не прочитался, иду под тестовой установкой'); }
}

let ok = 0, bad = 0;
const check = (name, cond, got) => {
  if (cond) { ok++; console.log(`  ✅ ${name}`); }
  else { bad++; console.log(`  ❌ ${name}${got === undefined ? '' : ` — получено ${JSON.stringify(got)}`}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Транспорт: тот же, что у хаба ────────────────────────────────────────────
// Не `fetch`, потому что нужны три вещи, которых у него нет: соединение по IP с
// проверкой по отпечатку вместо CA, отсутствие SNI и свежее рукопожатие на каждый
// запрос. Последнее не оптимизация наоборот, а условие работы пина: на возобновлённой
// TLS-сессии сервер не присылает сертификат заново, и сверять было бы нечего.
let pinChecked = 0, pinFailed = '';
function req(method, pathname, { body = null, key = KEY } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(URL_BASE + pathname);
    const tls = u.protocol === 'https:';
    const lib = tls ? https : http;
    // key === null → заголовок не отправляем вообще. Это не то же самое, что пустой
    // ключ: `/health` обязан отвечать именно БЕЗ заголовка, иначе дашборд не сможет
    // спросить «жив ли приёмник», не зная секрета.
    const headers = {};
    if (key !== null) headers['X-League-Key'] = key;
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const opts = { host: IP || u.hostname, port: u.port || (tls ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: 25000 };
    if (tls) {
      opts.agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
      // Node не отправляет IP как SNI по стандарту, поэтому `servername: undefined`
      // при адресе-цифрах = пустой SNI. Ровно это и нужно: happ-tun смотрит SNI и
      // уводит `*.xgate.online` мимо туннеля, а напрямую нода из РФ недостижима.
      if (PIN) { opts.rejectUnauthorized = false; opts.servername = undefined; }
      else { opts.servername = u.hostname; }
    }
    const r = lib.request(opts, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(parts) }));
    });
    if (tls && PIN) {
      r.on('socket', s => s.on('secureConnect', () => {
        let got = '';
        try { got = s.getPeerCertificate().fingerprint256 || ''; } catch { /* сертификата нет */ }
        const norm = v => String(v).replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
        if (norm(got) !== norm(PIN)) {
          pinFailed = got ? got.slice(0, 23) + '…' : '(сертификат не предъявлен)';
          r.destroy(new Error(`отпечаток приёмника не совпал: ${pinFailed}`));
        } else pinChecked++;
      }));
    }
    r.on('timeout', () => r.destroy(new Error('таймаут 25 с')));
    r.on('error', reject);
    if (body !== null) r.write(body);
    r.end();
  });
}
const jsonOf = r => { try { return JSON.parse(r.buf.toString('utf8')); } catch { return null; } };
// Настоящий webp 1×1, 34 байта: RIFF…WEBP…VP8L. Приёмник смотрит именно магию
// контейнера, а не заявленный mime, — значит и проверять надо настоящим файлом.
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const MARK = crypto.randomBytes(3).toString('hex');
const STAMP = new Date().toLocaleString('sv').slice(0, 19);
const BURST = Math.max(2, Number(opt('burst', '25')) || 25);
const left = [];   // что этот прогон оставил в чате

// Лимит из ЛОКАЛЬНОГО исходника — не для проверки, а для сверки: если нода
// принимает другое количество, значит на ней лежит другая сборка приёмника.
const declaredPerMin = (() => {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'routing', 'league-receiver.js'), 'utf8');
    return Number((/CHAT_PER_MIN\s*=\s*(\d+)/.exec(src) || [])[1]) || 0;
  } catch { return 0; }
})();

const post = body => req('POST', '/chat', { body: JSON.stringify(body) });
const msg = (text, att) => ({ installId: ME.installId, nick: ME.nick, text, ...(att ? { att } : {}) });

// Курсор до начала прогона. Заодно проверяется постраничная выдача: приёмник отдаёт
// не больше 200 за раз и возвращает seq ПОСЛЕДНЕГО отданного, а не самого свежего.
async function newestSeq() {
  let cur = 0, pages = 0;
  for (;;) {
    const r = await req('GET', `/chat?since=${cur}`);
    if (r.status !== 200) return { err: r };
    const j = jsonOf(r) || {};
    const list = Array.isArray(j.messages) ? j.messages : [];
    if (!list.length) return { seq: Math.max(cur, Number(j.seq) || 0), pages };
    cur = Number(list[list.length - 1].seq) || cur;
    if (++pages > 10) return { seq: cur, pages };
  }
}
async function feed(since) {
  const r = await req('GET', `/chat?since=${since}`);
  const j = jsonOf(r) || {};
  return { r, j, list: Array.isArray(j.messages) ? j.messages : [] };
}

async function main() {
  console.log(`приёмник ${URL_BASE}${IP ? ` (соединение по ${IP})` : ''}`);
  console.log(`ключ: ${KEY.length} символов, не печатается · пин: ${PIN ? PIN.slice(0, 11) + '…' : 'нет'}`);
  console.log(`установка: ${ME.installId.slice(0, 8)}… ник «${ME.nick}»`
    + (has('as-me') ? ' (СВОЯ, --as-me)' : ' (тестовая, своя квота не тратится)'));
  console.log(`метка прогона: #${MARK}`);

  console.log('\nдоступность:');
  let h;
  try {
    h = await req('GET', '/health', { key: null });
  } catch (e) {
    console.log(`  ❌ приёмник не отвечает: ${e.message}`);
    // Ошибка без кода — почти всегда наша собственная (кривой заголовок, кривой URL),
    // а не сеть. Не выдавать её за «нода лежит»: это отправило бы владельца на ноду
    // разбираться с тем, чего там нет.
    if (!e.code) {
      console.log('     Кода ошибки нет — похоже на дефект самой проверки, а не сети.');
      process.exit(1);
    }
    console.log('\nЧто это обычно значит, по убыванию частоты:');
    console.log('  · сервис лежит          → на ноде: systemctl status league-receiver');
    if (pinFailed) console.log(`  · сертификат сменился  → пин в конфиге не совпал (${pinFailed})`);
    console.log('  · с этой машины нет пути → из РФ нода видна только через VPN (happ-tun)');
    console.log('  · порт закрыт снаружи   → на ноде: ss -ltnp | grep 8420');
    process.exit(1);
  }
  const hj = jsonOf(h) || {};
  check('/health отвечает 200 и без заголовка с ключом', h.status === 200, h.status);
  check('в /health есть ok и число установок', hj.ok === true && Number.isInteger(hj.installs), hj);
  // Пин проверяем только там, где есть TLS. Пин при `http://` — не «лишняя строка в
  // конфиге», а дыра: секрет пойдёт открытым текстом, поэтому про это говорим вслух.
  if (PIN && IS_TLS) check('сертификат приёмника совпал с пином', pinChecked > 0, pinFailed || 'сверка не отработала');
  else if (!IS_TLS) console.log('  ⚠️  соединение по http: TLS и пин не участвуют, ключ идёт открытым текстом');

  console.log('\nручки чата:');
  const probe = await req('GET', '/chat?since=0');
  if (probe.status === 404) {
    console.log('  ⏳ ручек чата на приёмнике ЕЩЁ НЕТ (GET /chat → 404 «нет такой ручки»).');
    console.log('     Это ожидаемое состояние до выката, а не поломка.');
    console.log('     Сам приёмник жив: /health отвечает, установок ' + (hj.installs ?? '?') + '.');
    console.log('\n     Выкатить:  node tools/deploy-league-receiver.js --dry-run   (посмотреть план)');
    console.log('                node tools/deploy-league-receiver.js             (сделать)');
    console.log('     И прогнать эту проверку снова.');
    console.log(`\nитог: ${ok} прошло, ${bad} упало · чат не проверен, ждём выката`);
    process.exit(bad ? 1 : 0);
  }
  if (probe.status === 401) {
    console.log('  ❌ 401 на GET /chat: приёмник не принимает наш ключ.');
    console.log('     Секрет в league-config.json и /opt/league/data/secret разъехались.');
    process.exit(1);
  }
  check('GET /chat отвечает 200', probe.status === 200, { status: probe.status, body: probe.buf.toString('utf8').slice(0, 120) });
  if (probe.status !== 200) { console.log(`\nитог: ${ok} прошло, ${bad} упало`); process.exit(1); }
  const start = await newestSeq();
  if (start.err) { console.log('  ❌ не смог дочитать журнал до конца'); process.exit(1); }
  check('журнал дочитан до конца страницами', Number.isInteger(start.seq), start);
  console.log(`     курсор до прогона: seq ${start.seq} (страниц ${start.pages})`);
  console.log('\nсообщение туда и обратно:');
  const text = `[e2e] чат лиги · текст · ${STAMP} · #${MARK}`;
  const r1 = await post(msg(text));
  const j1 = jsonOf(r1) || {};
  if (r1.status === 429) {
    console.log('  ⏳ 429 на первом же сообщении: минутная квота этой установки уже израсходована.');
    console.log('     Похоже, проверку только что прогоняли. Подожди минуту и запусти снова.');
    console.log(`     Ответ приёмника: ${JSON.stringify(j1)}`);
    process.exit(1);
  }
  check('POST /chat принял сообщение', r1.status === 200 && j1.ok === true, { status: r1.status, body: j1 });
  check('в ответе есть seq, и он новее курсора', Number.isInteger(j1.seq) && j1.seq > start.seq,
    { seq: j1.seq, start: start.seq });
  if (!Number.isInteger(j1.seq)) { console.log(`\nитог: ${ok} прошло, ${bad} упало`); process.exit(1); }
  left.push(j1.seq);

  const f1 = await feed(start.seq);
  const mine = f1.list.find(m => m.seq === j1.seq);
  check('сообщение вернулось по since=', !!mine, f1.list.map(m => m.seq));
  if (mine) {
    check('текст доехал байт-в-байт', mine.text === text, mine.text);
    check('ник и установка — наши', mine.nick === ME.nick && mine.installId === ME.installId,
      { nick: mine.nick, installId: String(mine.installId).slice(0, 8) });
    // Время ставит приёмник: клиентскому в чате места нет ровно по той же причине,
    // по которой его вырезают из среза — иначе «только что» подделывается полем.
    const dt = Math.abs(Date.now() - Date.parse(mine.recvAt || 0));
    check('время сообщения серверное и свежее (± 3 мин)', dt < 180_000, mine.recvAt);
  }
  check('курсор в ответе равен seq последнего отданного',
    Number(f1.j.seq) === (f1.list.length ? f1.list[f1.list.length - 1].seq : start.seq),
    { cursor: f1.j.seq, last: f1.list.length ? f1.list[f1.list.length - 1].seq : null });
  // Выдача СТРОГО новее курсора: иначе опрос из дашборда каждые несколько секунд
  // возвращал бы одно и то же сообщение и рисовал его снова и снова.
  const f2 = await feed(j1.seq);
  check('since=<мой seq> моё сообщение больше не отдаёт', !f2.list.some(m => m.seq === j1.seq),
    f2.list.map(m => m.seq));
  check('в выдаче нет ничего старее курсора', f2.list.every(m => m.seq > j1.seq), f2.list.map(m => m.seq));

  console.log('\nвложение:');
  const textAtt = `[e2e] чат лиги · вложение · ${STAMP} · #${MARK}`;
  const r2 = await post(msg(textAtt, { b64: WEBP.toString('base64') }));
  const j2 = jsonOf(r2) || {};
  check('POST /chat принял сообщение с webp', r2.status === 200 && Number.isInteger(j2.seq),
    { status: r2.status, body: j2 });
  if (Number.isInteger(j2.seq)) left.push(j2.seq);
  const f3 = await feed(j1.seq);
  const withAtt = f3.list.find(m => m.seq === j2.seq);
  check('сообщение с вложением видно в выдаче', !!withAtt, f3.list.map(m => m.seq));
  if (withAtt) {
    check('ссылка на вложение собрана из seq',
      withAtt.att && withAtt.att.url === `/chat/att/${j2.seq}.webp`, withAtt.att);
    check('размер вложения в выдаче совпадает с отправленным',
      withAtt.att && withAtt.att.bytes === WEBP.length, withAtt.att);
  }
  const att = await req('GET', `/chat/att/${j2.seq}.webp`);
  check('вложение скачивается', att.status === 200, { status: att.status, body: att.buf.toString('utf8').slice(0, 80) });
  check('отдаётся как image/webp', String(att.headers['content-type'] || '').includes('image/webp'),
    att.headers['content-type']);
  check('байты вложения совпадают с отправленными',
    att.buf.length === WEBP.length && Buffer.compare(att.buf, WEBP) === 0,
    { got: att.buf.length, sent: WEBP.length, head: att.buf.toString('hex', 0, 12) });
  // Эти отказы не оставляют в чате ничего: приёмник проверяет форму тела ДО
  // того, как тратит минутную квоту и пишет файл. Поэтому они здесь бесплатны.
  console.log('\nотказы (в чате после них не остаётся ничего):');
  // 🪤 Прежде здесь стояло «вложение не-webp → 415». С 05.09 это неверно: вложением
  // может быть любой небольшой файл, и текст без сигнатуры принимается КАК ФАЙЛ.
  // 415 теперь означает другое и более узкое: расширение из белого списка проверяемых
  // видов, а байты ему не соответствуют — то есть файл пытается выдать себя за медиа.
  const fakeWebp = await post(msg('', {
    b64: Buffer.from('это не webp, а просто текст').toString('base64'),
    name: 'подделка.webp',
  }));
  check('файл, выдающий себя за webp, отвергнут с 415', fakeWebp.status === 415,
    { status: fakeWebp.status, body: jsonOf(fakeWebp) });
  const empty = await post(msg('    '));
  check('пустое сообщение отвергнуто с 400', empty.status === 400, { status: empty.status, body: jsonOf(empty) });
  const noAtt = await req('GET', '/chat/att/999999999.webp');
  check('несуществующее вложение — 404, а не пустой ответ', noAtt.status === 404,
    { status: noAtt.status, body: noAtt.buf.toString('utf8').slice(0, 60) });

  console.log('\nчужой ключ:');
  // Ключ той же длины, что настоящий: иначе проверялось бы только сравнение длин.
  const WRONG = crypto.randomBytes(Math.max(8, Math.ceil(KEY.length / 2))).toString('hex').slice(0, KEY.length);
  const w1 = await req('GET', '/chat?since=0', { key: WRONG });
  const w2 = await req('POST', '/chat', { body: JSON.stringify(msg('этого сообщения быть не должно')), key: WRONG });
  const w3 = await req('GET', `/chat/att/${j2.seq}.webp`, { key: WRONG });
  check('GET /chat с чужим ключом → 401', w1.status === 401, w1.status);
  check('POST /chat с чужим ключом → 401', w2.status === 401, w2.status);
  check('вложение с чужим ключом → 401', w3.status === 401, w3.status);
  check('чужой ключ ничего не записал', !(jsonOf(w2) || {}).seq, jsonOf(w2));

  if (has('no-flood')) {
    console.log('\nлимит: пропущен по --no-flood (429 не проверен)');
  } else {
    console.log(`\nлимит (шлём до ${BURST} сообщений подряд, пока не упрёмся):`);
    let accepted = 0, r429 = null;
    for (let i = 1; i <= BURST; i++) {
      const r = await post(msg(`[e2e] лимит ${i} · #${MARK}`));
      if (r.status === 200) { accepted++; const s = (jsonOf(r) || {}).seq; if (s) left.push(s); continue; }
      if (r.status === 429) { r429 = r; break; }
      check(`неожиданный ответ на ${i}-м сообщении`, false, { status: r.status, body: jsonOf(r) });
      break;
    }
    const total = accepted + 2;   // плюс текст и вложение выше — квота считается на установку
    check('лимит сработал и вернул 429', !!r429,
      `за ${BURST} сообщений отказа не было — либо лимита нет, либо он выше ${BURST}`);
    if (r429) {
      const j429 = jsonOf(r429) || {};
      check('в 429 сказано, сколько ждать', Number(j429.retryAfterMs) > 0, j429);
      console.log(`     принято ${total} сообщений с установки, затем 429: ${JSON.stringify(j429).slice(0, 90)}`);
      if (declaredPerMin) {
        check(`принято столько, сколько обещает исходник (${declaredPerMin}/мин)`, total === declaredPerMin, total);
        if (total !== declaredPerMin) {
          console.log(`     ⚠️  расхождение = на ноде ДРУГАЯ сборка приёмника, не та, что в routing/`);
        }
      }
    }
  }

  console.log('\nчто прогон оставил в чате:');
  if (!left.length) console.log('     ничего');
  else {
    console.log(`     сообщений: ${left.length}, от «${ME.nick}» (${ME.installId.slice(0, 8)}…),`
      + ` seq ${left[0]}…${left[left.length - 1]}`);
    console.log(`     все с меткой #${MARK}: «текст», «вложение»${has('no-flood') ? '' : ' и «лимит N»'}`);
    console.log('     убрать: DELETE /chat?installId=<свой> (снимет только свои), либо');
    console.log('     по одному DELETE /chat/<seq>. Чужого не тронуто.');
  }
  console.log(`\nитог: ${ok} прошло, ${bad} упало`);
  process.exit(bad ? 1 : 0);
}
main().catch(e => {
  console.error('\n⛔ прогон оборвался: ' + (e && e.message ? e.message : e));
  if (pinFailed) console.error('   отпечаток сертификата не совпал с пином: ' + pinFailed);
  console.error(`   в чате могло остаться ${left.length} тестовых сообщений`);
  process.exit(1);
});
