#!/usr/bin/env node
'use strict';
/**
 * check-league-chat.js — регресс на чат и аватарку «Лиги» со стороны ХАБА.
 *
 * Зачем файл существует. Браузер не умеет пиннинг сертификата, поэтому во вкладке нет
 * ни одного запроса к приёмнику: она ходит только на свой localhost, а наружу достаёт
 * хаб. Значит все правила — кто подписывает сообщение, что считается картинкой, из
 * чего собирается путь вложения — живут в transparent-proxy.js, и проверять их надо
 * здесь, а не глазами во вкладке.
 *
 * Что проверяется по существу:
 *   1. ПОДПИСЬ. `installId` и `nick` из тела браузера игнорируются полностью — иначе
 *      любая открытая страница напишет в лигу под чужим именем с нашей машины.
 *   2. КАРТИНКА. webp определяется по байтам (`RIFF....WEBP`), а не по mime из
 *      data-URL: mime пишет отправитель. Размер — до 20 КБ после декодирования.
 *   3. ПУТЬ ВЛОЖЕНИЯ собирается из ЧИСЛА. `att/../../secret.webp` не должен доехать
 *      до приёмника ни в каком виде.
 *   4. КОНВЕРТ. Приёмник режет тело среза на 64 КБ, а лицо едет внутри среза —
 *      значит размер с максимальной аватаркой обязан быть измерен, а не оценён.
 *   5. СЕКРЕТ приёмника не появляется ни в одном ответе браузеру и ни в одной строке
 *      лога.
 *   6. УДАЛЕНИЕ (05.09). `installId` ставит хаб и здесь: удалить чужое, назвавшись
 *      автором, нельзя — 403 остаётся 403, даже если браузер прислал чужой id в строке
 *      запроса. Своё уходит без оговорок, чужое только с `force=1`, вложение — вместе
 *      с сообщением.
 *   7. ВКЛАДКА как файл: разметка и логика удаления проверяются статикой по
 *      proxy-dashboard.html (браузера здесь нет), плюс `node --check` на каждом
 *      inline-блоке страницы — в этом файле уже падал JS из-за двух DOMContentLoaded.
 *
 * Как: текст блока лиги вырезается из transparent-proxy.js и исполняется в песочнице,
 * ручки поднимаются мини-сервером на свободном порту, а на другом конце работает
 * НАСТОЯЩИЙ league-receiver.js со своим временным каталогом. Живой :8200 не трогается
 * и не перезапускается, живой приёмник на ноде — тоже.
 *
 * Запуск: node tools/check-league-chat.js       (exit 1 = чат сломан)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROUTING = path.join(__dirname, '..', 'routing');
// Источник хаба — параметром окружения. Нужно ровно для МУТАЦИЙ: проверка «убери заголовок
// attachment — тест покраснеет» иначе требовала бы правки живого transparent-proxy.js, с
// которым одновременно работают другие агенты. С `LEAGUE_SRC` мутация делается на копии в
// temp, а живой файл не трогается вообще.
const SRC_FILE = process.env.LEAGUE_SRC || path.join(ROUTING, 'transparent-proxy.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const RECEIVER = path.join(ROUTING, 'league-receiver.js');

const from = SRC.indexOf('const HUB_IDENTITY_FILE');
const to = SRC.indexOf('async function handleFinanceHistory');
if (from < 0 || to < 0 || to < from) {
  console.error('не нашёл блок лиги в transparent-proxy.js');
  process.exit(1);
}
const block = SRC.slice(from, to);

let ok = 0, bad = 0;
const check = (name, cond, got) => {
  if (cond) { ok++; console.log(`  ✅ ${name}`); }
  else { bad++; console.log(`  ❌ ${name}${got === undefined ? '' : ` — получено ${JSON.stringify(got)}`}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KB = v => (v / 1024).toFixed(1) + ' КБ';

// Валидный контейнер webp нужной длины. Настоящий кодировщик тут не нужен: хаб
// картинку не декодирует, он смотрит ровно на магию и на длину.
const mkWebp = n => {
  const b = Buffer.alloc(Math.max(16, n), 0x61);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  return b;
};
const AVATAR_PREFIX = 'data:image/webp;base64,';
// Голосовое и произвольный файл — теми же байтами, какими их видит приёмник: он решает тип
// по СИГНАТУРЕ, а не по имени и не по mime. webm от MediaRecorder начинается с EBML.
const mkWebm = n => {
  const b = Buffer.alloc(Math.max(64, n), 0x33);
  b[0] = 0x1A; b[1] = 0x45; b[2] = 0xDF; b[3] = 0xA3;
  return b;
};
// Файл БЕЗ сигнатуры: ни один формат из белого списка так не начинается, значит это
// «произвольный файл» — и его единственный законный путь наружу это скачивание.
const mkFile = (head, n) => Buffer.concat([Buffer.from(head, 'utf8'),
  Buffer.alloc(Math.max(0, (n || 400) - Buffer.byteLength(head)), 0x20)]);

// Копии настоящих помощников хаба: песочница получает их параметрами, и подделка
// здесь исказила бы проверку. Оба списаны с transparent-proxy.js один в один.
function jsonRes(res, code, body) {
  if (res.writableEnded) return;
  if (res.headersSent) { res.end(JSON.stringify(body)); return; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const LOGS = [];
const loadFrom = f => {
  try {
    const raw = fs.readFileSync(path.join(ROUTING, f), 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return Array.isArray(j) ? j : (j.sessions || j.accounts || []);
  } catch { return []; }
};
const EXPORTS = ['handleLeagueChatGet', 'handleLeagueChatPost', 'handleLeagueChatDelete',
  'handleLeagueAtt', 'handleLeagueAvatar', 'handleLeagueNick', 'leagueSelf', 'hubIdentity',
  'hubIdentityWrite', 'leagueImgParse', 'leagueConfig', 'leagueSync', 'isWebp',
  // Вложение: санитайзеры и сигнатуры проверяются НАПРЯМУЮ, а не только сквозняком. Через
  // сеть их видно лишь по последствиям, а тут важны сами правила — что вырезано из имени,
  // какая длительность считается правдоподобной, какие байты опознаны.
  'leagueAttName', 'leagueAttDur', 'leagueAttSniff', 'leagueAttExtOk', 'leagueAttDisp',
  'leagueAttDispName', 'leagueAttBytes', 'LEAGUE_ATT_MIME'].join(', ');

// Песочница: свой `__dirname` (значит свои hub-identity.json / league-config.json) и
// НАСТОЯЩИЕ журналы на чтение — иначе размер среза будет игрушечным.
// `LISTEN_PORT` приходит параметром: он объявлен в transparent-proxy.js ВЫШЕ вырезаемого
// блока (строка 74), а handleLeagueChatDelete им пользуется как базой для разбора URL.
// Без него ручка удаления падала бы в песочнице ReferenceError'ом — на живом хабе всё
// на месте, здесь подставляем то же число 8200.
function mkHub(dir, fsImpl) {
  return new Function(
    'fs', 'path', 'os', 'crypto', 'execFileSync', 'http', 'https', '__dirname', 'logLine', 'round2',
    'jsonRes', 'readJsonBody', 'TOKEN_USAGE_FILE', 'FINANCE_HISTORY_FILE', 'LISTEN_PORT',
    'ghLoad', 'arLoad', 'goLoad', 'tbLoad', 'xpLoad', 'jwLoad', 'skLoad', 'tsLoad', 'kkLoad',
    `${block}\nreturn { ${EXPORTS} };`
  )(
    fsImpl, path, os, crypto, execFileSync, http, https, dir,
    m => LOGS.push(String(m)), v => Math.round(v * 100) / 100, jsonRes, readJsonBody,
    path.join(ROUTING, 'token-usage.jsonl'), path.join(ROUTING, 'finance-history.jsonl'), 8200,
    () => loadFrom('github-accounts.json'), () => loadFrom('agentrouter-sessions.json'),
    () => loadFrom('gorouter-sessions.json'), () => loadFrom('tabi-sessions.json'),
    () => loadFrom('xpeach-sessions.json'), () => loadFrom('justwoker-sessions.json'),
    () => loadFrom('seekai-sessions.json'), () => loadFrom('truesota-sessions.json'),
    () => loadFrom('kktoken-sessions.json')
  );
}
// Мини-сервер с ТЕМИ ЖЕ строками маршрутизации, что в transparent-proxy.js (их наличие и
// порядок проверяется отдельно, ниже по тексту). Поднимать сам хаб нельзя: он занял бы
// :8200 и порвал живые сессии.
function mkServer(hub) {
  return http.createServer((req, res) => {
    if (req.method === 'DELETE' && req.url.startsWith('/__switch/api/league/chat')) return hub.handleLeagueChatDelete(req, res);
    if (req.method === 'GET' && req.url.startsWith('/__switch/api/league/chat/att/')) return hub.handleLeagueAtt(req, res);
    if (req.method === 'GET' && req.url.startsWith('/__switch/api/league/chat')) return hub.handleLeagueChatGet(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/league/chat') return hub.handleLeagueChatPost(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/league/avatar') return hub.handleLeagueAvatar(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/league/nick') return hub.handleLeagueNick(req, res);
    jsonRes(res, 404, { error: 'нет такой ручки' });
  });
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function main() {
  const TMP = path.join(os.tmpdir(), 'league-chat-test-' + Date.now());
  const DATA = path.join(TMP, 'recv-data');
  const HUBDIR = path.join(TMP, 'hub');
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(HUBDIR, { recursive: true });

  // ── Настоящий приёмник на свободном порту, по HTTP: пин проверяется на TLS, а
  // здесь проверяется контракт чата. Живой приёмник на ноде не задет.
  // 🪤 Порт спрашиваем у ОПЕРАЦИОННОЙ СИСТЕМЫ, а не берём случайным числом из 8300–8899:
  // в этом диапазоне на машине живут свои сервисы (8390, 8398, 8399, 8765, 8791 — замер
  // 05.09), и один промах из сотни давал прогон, где КРАСНЫ ВСЕ сетевые проверки — тест
  // разговаривал с чужим сервисом, ответившим 200 на `/health`. Выглядит это как «сломано
  // всё», а причина в одном числе.
  const freePort = () => new Promise(r => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const RPORT = await freePort();
  const child = spawn(process.execPath, [RECEIVER, String(RPORT), DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  let rout = '';
  child.stdout.on('data', d => { rout += d; });
  child.stderr.on('data', d => { rout += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(100);
    // Не «кто-то ответил 200», а именно НАШ приёмник: `installs` отдаёт только он.
    try {
      const h = await fetch(`http://127.0.0.1:${RPORT}/health`);
      const j = h.ok ? await h.json() : null;
      up = !!(j && j.ok === true && typeof j.installs === 'number');
    } catch { /* поднимается */ }
  }
  if (!up) { console.log('приёмник не поднялся:\n' + rout); child.kill(); process.exit(1); }
  const SECRET = fs.readFileSync(path.join(DATA, 'secret'), 'utf8').trim();

  // ── Заглушка для патологий: приёмник, который отвечает не тем, чем должен.
  // Настоящим кодом такие ответы не воспроизвести, а вкладка обязана их пережить.
  let stubMode = 'html';
  const stubHits = [];
  const stub = http.createServer((req, res) => {
    stubHits.push(`${req.method} ${req.url}`);
    if (stubMode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>я не json</h1>'); }
    if (stubMode === 'boom') { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('internal'); }
    if (stubMode === 'fakeimg') {
      // Сосед прислал html, приёмник записал его как вложение: отдавать это со
      // своего origin как картинку нельзя.
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      return res.end('<script>alert(1)</script>');
    }
    if (stubMode === 'feed') {
      // Приёмник ПРЕЖНЕЙ сборки: про надгробия не знает, отвечает без `gseq`, `firstSeq`,
      // `cold` и `gone`. Такой ответ обязан проходить через хаб как есть — новых полей он
      // досочинять не имеет права, иначе вкладка поверит, что «ничего не пропало».
      const since = Number(new URL(req.url, 'http://stub.local').searchParams.get('since')) || 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ seq: since, messages: [] }));
    }
    res.writeHead(404); res.end('{}');
  });
  const SPORT = await listen(stub);

  const cfgFile = path.join(HUBDIR, 'league-config.json');
  const idFile = path.join(HUBDIR, 'hub-identity.json');
  const useReceiver = () => fs.writeFileSync(cfgFile,
    JSON.stringify({ enabled: true, url: `http://127.0.0.1:${RPORT}`, key: SECRET, everyMin: 10 }));
  const useStub = () => fs.writeFileSync(cfgFile,
    JSON.stringify({ enabled: true, url: `http://127.0.0.1:${SPORT}`, key: SECRET, everyMin: 10 }));
  useReceiver();

  const hub = mkHub(HUBDIR, fs);
  const srv = mkServer(hub);
  const HPORT = await listen(srv);
  const HUB = `http://127.0.0.1:${HPORT}/__switch/api/league`;
  const me = hub.hubIdentity();
  console.log(`\nприёмник :${RPORT}, заглушка :${SPORT}, ручки хаба :${HPORT}`);
  console.log(`личность песочницы: ${me.nick} / ${me.installId}`);
  const jget = async (u, o) => { const r = await fetch(u, o); let j = null; try { j = await r.json(); } catch {} return { r, j }; };
  const send = body => jget(`${HUB}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // ── Маршруты. Ручка вложения — подпуть `/chat`, а `/chat` — подпуть `/league`,
  // который ловит startsWith'ом всё остальное. Порядок строк здесь и есть работающий
  // код: переставь — и вложение начнёт отвечать срезом, причём молча.
  console.log('\nмаршруты в transparent-proxy.js:');
  const R = {
    att: SRC.indexOf("req.url.startsWith('/__switch/api/league/chat/att/')"),
    // Ищем именно GET-ветку чата: 05.09 рядом появилась DELETE с тем же префиксом,
    // и поиск по одному префиксу стал находить её, а не то, что проверяется. Порядок
    // важен только внутри одного метода: GET вложения обязан стоять раньше GET чата,
    // иначе `startsWith` съест `/chat/att/…`. DELETE тут ничего не перехватывает.
    get: SRC.indexOf("req.method === 'GET'  && req.url.startsWith('/__switch/api/league/chat')"),
    del: SRC.indexOf("req.method === 'DELETE' && req.url.startsWith('/__switch/api/league/chat')"),
    post: SRC.indexOf("req.url === '/__switch/api/league/chat'"),
    ava: SRC.indexOf("req.url === '/__switch/api/league/avatar'"),
    all: SRC.indexOf("req.url.startsWith('/__switch/api/league')) return handleLeague("),
  };
  check('все ручки зарегистрированы', Object.values(R).every(v => v > 0), R);
  check('вложение проверяется РАНЬШЕ чата (в пределах GET)', R.att > 0 && R.att < R.get, { att: R.att, getChat: R.get });
  check('чат проверяется РАНЬШЕ общей ручки лиги', R.get > 0 && R.get < R.all, { chat: R.get, league: R.all });

  console.log('\nчтение чата:');
  fs.rmSync(cfgFile);
  let x = await jget(`${HUB}/chat?since=0`);
  check('приёмник не настроен — код 200, а не ошибка', x.r.status === 200, x.r.status);
  check('отдан пустой список и seq 0',
    Array.isArray(x.j.messages) && x.j.messages.length === 0 && x.j.seq === 0, x.j);
  check('сказано, чего именно не хватает',
    x.j.receiver && x.j.receiver.configured === false && /league-config/.test(x.j.receiver.note || ''),
    x.j.receiver);
  useReceiver();
  x = await jget(`${HUB}/chat?since=0`);
  check('с настроенным приёмником отдан его ответ (seq + messages)',
    x.r.status === 200 && Array.isArray(x.j.messages) && typeof x.j.seq === 'number', x.j);
  // 🔴 Утверждение ПЕРЕВЁРНУТО 05.09 вместе с приватностью по группам. Раньше здесь стояло
  // «на чтении есть CORS (вкладку смотрят и из черновика)» — послабление под превью по
  // `file://`, принятое владельцем осознанно. С приватным по группам чатом два утверждения —
  // «чужие переписки не видит никто» и «любой открытый сайт читает мой чат через мой же хаб»
  // — вместе не живут, и выбран первый. Цена названа честно: превью чата из черновика
  // перестало работать. Wildcard остался на общем обзоре лиги (витрина рейтинга), и это
  // проверяется отдельно ниже.
  check('на чтении чата wildcard-CORS СНЯТ (переписка приватна по группам)',
    x.r.headers.get('access-control-allow-origin') === null,
    x.r.headers.get('access-control-allow-origin'));

  // ── Второй курсор ─────────────────────────────────────────────────────────
  // 🔴 `since` умеет только «новее чем», то есть про СНЯТОЕ сообщение он не скажет никогда.
  // Пропажу приёмник перечисляет надгробиями новее клиентского `gseq`, а когда перечислить
  // не может — признаётся полем `cold`. Хаб на этом пути прокси: курсор наружу числом, ответ
  // внутрь как есть. До 05.09 он выбрасывал `gseq` из запроса, и вкладка о пропаже узнать не
  // могла в принципе.
  console.log('\nчтение: второй курсор gseq и новые поля ответа:');
  x = await jget(`${HUB}/chat?since=0&gseq=0`);
  check('ответ приёмника отдан целиком: gseq, firstSeq, cold, gone',
    x.r.status === 200 && typeof x.j.gseq === 'number' && typeof x.j.firstSeq === 'number'
      && typeof x.j.cold === 'boolean' && Array.isArray(x.j.gone), x.j);
  x = await jget(`${HUB}/chat?since=0&gseq=999999`);
  check('курсор выше приёмникового возвращается признанием cold, а не тишиной',
    x.j.cold === true && /курсор/.test(String(x.j.coldWhy || '')), x.j);
  useStub(); stubMode = 'feed'; stubHits.length = 0;
  x = await jget(`${HUB}/chat?since=41&gseq=7`);
  check('оба курсора ушли к приёмнику числами и в одной строке запроса',
    stubHits[0] === 'GET /chat?since=41&gseq=7', stubHits);
  check('ответ прежней сборки (без новых полей) проходит как есть — хаб их НЕ досочиняет',
    x.r.status === 200 && x.j.seq === 41 && !('gseq' in x.j) && !('gone' in x.j)
      && !('cold' in x.j), x.j);
  stubHits.length = 0;
  await jget(`${HUB}/chat?since=abc&gseq=${encodeURIComponent('../../secret')}`);
  check('мусор в курсорах пересобран в нули: строка из браузера в путь не попадает',
    stubHits[0] === 'GET /chat?since=0&gseq=0', stubHits);
  useReceiver(); stubMode = 'html';

  console.log('\nотправка: подпись ставит хаб, а не браузер:');
  const TXT = 'привет из регресса ' + Date.now();
  x = await send({ installId: 'f'.repeat(16), nick: 'ЗЛОдей', text: TXT });
  check('сообщение принято приёмником', x.r.status === 200 && x.j.ok === true && Number.isInteger(x.j.seq), x.j);
  const feed = (await jget(`${HUB}/chat?since=0`)).j;
  const m0 = (feed.messages || []).find(m => m.text === TXT);
  check('в чате installId ХАБА, а не из тела браузера',
    !!m0 && m0.installId === me.installId, m0 && m0.installId);
  check('в чате ник ХАБА, а не «ЗЛОдей» из тела браузера',
    !!m0 && m0.nick === me.nick, m0 && m0.nick);
  check('на записи CORS нет — писать может только свой origin',
    x.r.headers.get('access-control-allow-origin') === null,
    x.r.headers.get('access-control-allow-origin'));
  x = await send({ text: '   ' });
  check('пустое сообщение без картинки отвергнуто хабом', x.r.status === 400, x.j);
  x = await send({ text: 'я'.repeat(2001) });
  check('текст длиннее 2000 отвергнут хабом', x.r.status === 400 && /2000/.test(x.j.error || ''), x.j);
  // Сырой запрос, а не fetch: `fetch` нормализует `..` в пути ещё до отправки, и
  // проверка обхода каталога через него невозможна в принципе. Второй параметр — свои
  // заголовки: без них не проверить условный запрос (`If-None-Match` → 304).
  const raw = (p, hdrs) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: HPORT, path: p, method: 'GET',
      headers: hdrs || {} }, s => {
      const ch = [];
      s.on('data', c => ch.push(c));
      s.on('end', () => resolve({ status: s.statusCode, headers: s.headers, buf: Buffer.concat(ch) }));
    });
    rq.on('error', reject);
    rq.end();
  });

  console.log('\nвложение:');
  const img = mkWebp(3000);
  x = await send({ text: 'с картинкой', att: img.toString('base64') });
  const seqA = x.j && x.j.seq;
  check('вложение голой строкой base64 принято', x.r.status === 200 && Number.isInteger(seqA), x.j);
  x = await send({ text: 'и объектом', att: { b64: img.toString('base64') } });
  check('вложение в форме { b64 } принято тоже', x.r.status === 200, x.j);
  x = await send({ att: img.toString('base64') });
  check('картинка без подписи — законное сообщение', x.r.status === 200, x.j);
  x = await send({ text: 'битая', att: Buffer.from('<html>вот тебе картинка</html>').toString('base64') });
  // 🔴 Здесь стояло «не-webp во вложении отвергнут хабом», и это была ГЛАВНАЯ поломка хаба, а
  // не защита: проверку сигнатуры webp проходило только изображение, то есть голосовое (webm)
  // и любой файл получали 400 у хаба и до приёмника не доезжали ВООБЩЕ. Новое правило: тип
  // решают байты, и решает их приёмник — неопознанное становится произвольным файлом и уезжает
  // только на скачивание. Хаб же обязан не выдумывать за него отказ.
  const seqRaw = x.j && x.j.seq;
  check('байты без сигнатуры приняты и стали ФАЙЛОМ (проверка «только webp» была багом)',
    x.r.status === 200 && Number.isInteger(seqRaw), x.j);
  const mRaw = ((await jget(`${HUB}/chat?since=0`)).j.messages || []).find(m => m.seq === seqRaw);
  check('приёмник записал их файлом: kind=file, octet-stream, а не картинкой',
    !!(mRaw && mRaw.att && mRaw.att.kind === 'file'
      && mRaw.att.mime === 'application/octet-stream'), mRaw && mRaw.att);
  x = await send({ text: 'огромная', att: mkWebp(3 * 1024 * 1024).toString('base64') });
  check('вложение больше потолка приёмника отвергнуто хабом', x.r.status === 400, x.j);
  x = await send({ text: 'не base64', att: '!!!!' });
  check('мусор вместо base64 отвергнут хабом внятным 400',
    x.r.status === 400 && /base64/.test((x.j || {}).error || ''), x.j);

  const got = await raw(`/__switch/api/league/chat/att/${seqA}.webp`);
  check('вложение отдано с Content-Type image/webp',
    got.status === 200 && got.headers['content-type'] === 'image/webp',
    { st: got.status, ct: got.headers['content-type'] });
  // 🔴 Здесь стояло `public, max-age=86400`, и сутки кеша означали, что картинка СНЯТОГО
  // сообщения открывается из дискового кеша браузера ещё сутки: удаление выглядит сделанным, а
  // байты доступны. Приёмник по этой же причине отвечает `no-store`. В браузер `no-store`
  // ставить нельзя — он запрещает хранить, значит условный запрос не родится и `ETag` станет
  // мёртвым весом. `no-cache` = хранить можно, отдавать только после проверки.
  check('Cache-Control — no-cache: из кеша без проверки не отдаётся',
    got.headers['cache-control'] === 'no-cache', got.headers['cache-control']);
  check('ETag приёмника проброшен (иначе повторное чтение тянет файл заново)',
    /^"\d+-\d+"$/.test(String(got.headers.etag || '')), got.headers.etag);
  check('у картинки нет Content-Disposition: её рисуют, а не скачивают',
    got.headers['content-disposition'] === undefined, got.headers['content-disposition']);
  check('nosniff на чужих байтах', got.headers['x-content-type-options'] === 'nosniff');
  check('байты доехали без порчи (бинарь не через строку)',
    got.buf.equals(img), { sent: img.length, got: got.buf.length });
  const mA = ((await jget(`${HUB}/chat?since=0`)).j.messages || []).find(m => m.seq === seqA);
  check('в выдаче у сообщения есть ссылка на вложение',
    !!(mA && mA.att && mA.att.url === `/chat/att/${seqA}.webp`), mA && mA.att);

  // ── Голосовое и файл: `dur` и `name` обязаны ДОЕХАТЬ ──────────────────────
  // 🔴 Самое дорогое в этом файле. `dur` — единственный источник длительности голосового
  // (webm от MediaRecorder её в заголовке не несёт, и плеер до конца воспроизведения честно
  // показывает бесконечность), `name` — единственный источник имени файла (из байтов оно не
  // выводится). До 05.09 хаб пересобирал вложение как `{ b64 }`, и оба поля терялись НА НЁМ:
  // вкладка их отправляла, приёмник умел принять, а до него они не доезжали.
  // Проверяем сквозняком через настоящий приёмник: видно и что поле уехало, и что уехало в
  // том виде, который он понимает.
  console.log('\nголосовое и файл сквозь хаб (dur и name):');
  const voiceBuf = mkWebm(9000);
  x = await send({ text: 'голосом',
    att: { mime: 'audio/webm', b64: voiceBuf.toString('base64'), dur: 34 } });
  const seqV = x.j && x.j.seq;
  check('голосовое принято хабом (прежде здесь был 400 «это не webp»)',
    x.r.status === 200 && Number.isInteger(seqV), x.j);
  const inFeed = async s => ((await jget(`${HUB}/chat?since=0`)).j.messages || []).find(m => m.seq === s);
  let mV = await inFeed(seqV);
  check('приёмник опознал звук по СИГНАТУРЕ: kind=audio, ext=webm, mime audio/webm',
    !!(mV && mV.att && mV.att.kind === 'audio' && mV.att.ext === 'webm'
      && mV.att.mime === 'audio/webm'), mV && mV.att);
  check('длительность доехала и вернулась в ленте (dur=34)',
    !!(mV && mV.att && mV.att.dur === 34), mV && mV.att);
  const NAME = 'отчёт по абузу.md';
  const fileBuf = mkFile('# отчёт\nвсё плохо\n', 900);
  x = await send({ text: 'файлом',
    att: { mime: 'text/markdown', b64: fileBuf.toString('base64'), name: NAME } });
  const seqF = x.j && x.j.seq;
  check('произвольный файл принят хабом', x.r.status === 200 && Number.isInteger(seqF), x.j);
  let mF = await inFeed(seqF);
  check('имя доехало целиком: кириллица и пробелы на месте',
    !!(mF && mF.att && mF.att.name === NAME), mF && mF.att);
  check('расширение выведено из ИМЕНИ, а не из заявленного типа: ext=md, kind=file',
    !!(mF && mF.att && mF.att.ext === 'md' && mF.att.kind === 'file'), mF && mF.att);
  // Негодные поля отбрасываются, а сообщение доставляется: потерять текст из-за кривого
  // имени хуже, чем потерять имя.
  x = await send({ text: 'дурная длительность',
    att: { b64: mkWebm(4000).toString('base64'), dur: 9999 } });
  const mD = await inFeed(x.j && x.j.seq);
  check('длительность вне предела отброшена, а сообщение прошло',
    x.r.status === 200 && !!mD && !mD.att.dur, { st: x.r.status, att: mD && mD.att });
  // 🪤 U+202E (RLO) собирается кодом, а не пишется в строку: в исходнике он невидим, и
  // проверка читалась бы глазами неправильно. Этим символом подменяют ВИДИМОЕ имя файла —
  // на экране `secret.exe.png`, на диске `secretgnp.exe`.
  const RLO = String.fromCharCode(0x202E);
  const EVIL = '../../secret' + RLO + 'gnp.exe";rm=1';
  x = await send({ text: 'дурное имя',
    att: { b64: mkFile('plain text ', 500).toString('base64'), name: EVIL } });
  const mE = await inFeed(x.j && x.j.seq);
  check('сообщение с дурным именем всё равно доставлено (текст важнее имени)',
    x.r.status === 200, x.j);
  check('в имени не осталось разделителей пути, кавычки и символа направления письма',
    !!(mE && mE.att && typeof mE.att.name === 'string'
      && !/[\\/";]/.test(mE.att.name) && !mE.att.name.includes(RLO)), mE && mE.att);

  // ── Отдача: у каждой ветки свои заголовки ─────────────────────────────────
  // 🔴 Правило одно: тип по СИГНАТУРЕ и только там, где байты проверены; всё прочее уезжает
  // байтами на скачивание. `nosniff` заменой `attachment` не является — при заявленном
  // HTML или XML вычисленный тип равен заявленному и алгоритм останавливается, а блокировка
  // по `nosniff` касается только скриптов и стилей.
  console.log('\nотдача вложения: заголовки по каждой ветке:');
  const gotV = await raw(`/__switch/api/league/chat/att/${seqV}.webm`);
  check('голосовое отдано своим типом audio/webm и байт в байт',
    gotV.status === 200 && gotV.headers['content-type'] === 'audio/webm'
      && gotV.buf.equals(voiceBuf), { st: gotV.status, ct: gotV.headers['content-type'] });
  check('у проверенного медиа нет Content-Disposition: его играют, а не скачивают',
    gotV.headers['content-disposition'] === undefined, gotV.headers['content-disposition']);
  const gotF = await raw(`/__switch/api/league/chat/att/${seqF}.md`);
  const dispF = String(gotF.headers['content-disposition'] || '');
  check('произвольный файл отдан ТОЛЬКО байтами: octet-stream + attachment',
    gotF.status === 200 && gotF.headers['content-type'] === 'application/octet-stream'
      && /^attachment;/.test(dispF), { st: gotF.status, ct: gotF.headers['content-type'], cd: dispF });
  check('имя файла двумя полями: ASCII-запасное и filename* процентным кодированием',
    /filename="[ -~]+"/.test(dispF)
      && dispF.includes("filename*=UTF-8''" + encodeURIComponent(NAME)), dispF);
  check('значение заголовка целиком в ASCII (иначе Node бросает ERR_INVALID_CHAR)',
    [...dispF].every(ch => ch.codePointAt(0) > 31 && ch.codePointAt(0) < 127), dispF);
  check('nosniff стоит и на файле — второй линией, а не заменой attachment',
    gotF.headers['x-content-type-options'] === 'nosniff');
  check('байты файла доехали без порчи', gotF.buf.equals(fileBuf),
    { sent: fileBuf.length, got: gotF.buf.length });
  // Без 304 повторное прослушивание голосового тянет файл заново через Швейцарию: приёмник
  // считает `ETag` как `"<номер>-<размер>"`, и потерять этот код на хабе — значит платить
  // полной перекачкой за каждое нажатие «играть».
  const cond = await raw(`/__switch/api/league/chat/att/${seqV}.webm`,
    { 'If-None-Match': String(gotV.headers.etag || '') });
  check('условный запрос доехал до приёмника и вернулся 304 без тела',
    cond.status === 304 && cond.buf.length === 0, { st: cond.status, len: cond.buf.length });
  check('на 304 отпечаток тот же, а кеш по-прежнему с проверкой',
    cond.headers.etag === gotV.headers.etag && cond.headers['cache-control'] === 'no-cache',
    { etag: cond.headers.etag, cc: cond.headers['cache-control'] });
  const wrongExt = await raw(`/__switch/api/league/chat/att/${seqF}.webp`);
  check('тот же номер с чужим расширением — 404, а не чей-то другой файл',
    wrongExt.status === 404, wrongExt.status);

  // ── Удаление ──────────────────────────────────────────────────────────────
  // Идёт ДО проверки антифлуда: та выбирает минутную квоту установки (20 сообщений), и
  // после неё приёмник перестал бы принимать новые пробы от нашего installId.
  //
  // Про «права» здесь ничего не проверяется, потому что прав нет: ключ у лиги один на
  // всех, и с ним можно удалить что угодно. Проверяется ровно то, что заявлено — своё
  // без оговорок, чужое только с `force=1`, и подпись ставит ХАБ: чужое нельзя удалить,
  // прислав чужой installId из браузера.
  console.log('\nудаление сообщений:');
  const del = (p, o) => jget(`${HUB}${p}`, { ...(o || {}), method: 'DELETE' });
  const feedSeqs = async () => ((await jget(`${HUB}/chat?since=0`)).j.messages || []).map(m => m.seq);
  // Сообщение «соседа»: пишем прямо в приёмник под чужим installId — через хаб такого не
  // отправить в принципе, он подставляет свой. Ключ у теста есть, у браузера его нет.
  const ALIEN = 'd'.repeat(16);
  const alienSay = async text => {
    const r = await fetch(`http://127.0.0.1:${RPORT}/chat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-League-Key': SECRET },
      body: JSON.stringify({ installId: ALIEN, nick: 'сосед', text }) });
    return (await r.json()).seq;
  };
  x = await send({ text: 'своё, на удаление' });
  const dMine1 = x.j && x.j.seq;
  x = await del(`/chat/${dMine1}`);
  check('своё сообщение удаляется без оговорок',
    x.r.status === 200 && x.j.ok === true && x.j.removed === 1, x.j);
  check('удалённого нет в ленте', !(await feedSeqs()).includes(dMine1), dMine1);
  // Надгробие — единственный способ узнать о ПРОПАЖЕ: курсор `since` про снятое молчит.
  // Проверяем именно через хаб: он их не считает и не пересобирает, но обязан не потерять.
  const feedGone = (await jget(`${HUB}/chat?since=0&gseq=0`)).j;
  check('надгробие удалённого доехало через хаб вместе с курсором gseq',
    Array.isArray(feedGone.gone) && feedGone.gone.some(g => g && g.seq === dMine1)
      && feedGone.gseq > 0, { gone: feedGone.gone, gseq: feedGone.gseq });
  x = await del(`/chat/${dMine1}`);
  check('повторное удаление — 404 приёмника, а не наш 500',
    x.r.status === 404 && !x.j.not_found, { st: x.r.status, j: x.j });

  const dAlien = await alienSay('чужое, руками в приёмник');
  x = await del(`/chat/${dAlien}`);
  check('чужое без force отвергнуто кодом 403',
    x.r.status === 403 && /force/.test((x.j || {}).error || ''), { st: x.r.status, j: x.j });
  // Главная проверка ручки: браузер прислал installId автора, чтобы выдать себя за него.
  // Хаб обязан его игнорировать — иначе «своё» не значит ничего.
  x = await del(`/chat/${dAlien}?installId=${ALIEN}`);
  check('чужой installId из строки запроса не делает сообщение своим (снова 403)',
    x.r.status === 403, { st: x.r.status, j: x.j });
  check('после отказов чужое сообщение на месте', (await feedSeqs()).includes(dAlien), dAlien);
  x = await del(`/chat/${dAlien}?force=1`);
  check('чужое с force=1 удаляется', x.r.status === 200 && x.j.removed === 1, x.j);
  check('и его больше нет в ленте', !(await feedSeqs()).includes(dAlien), dAlien);

  // Вложение уходит вместе со строкой: файл без сообщения не нужен никому, а место
  // занимает. Проверяем через ХАБ — тем же путём, которым его видит вкладка.
  x = await send({ text: 'со вложением, на удаление', att: mkWebp(2500).toString('base64') });
  const dAtt = x.j && x.j.seq;
  const attBefore = await raw(`/__switch/api/league/chat/att/${dAtt}.webp`);
  x = await del(`/chat/${dAtt}`);
  const attAfter = await raw(`/__switch/api/league/chat/att/${dAtt}.webp`);
  check('вложение было отдано до удаления', attBefore.status === 200, attBefore.status);
  check('после удаления сообщения вложение не отдаётся',
    x.r.status === 200 && attAfter.status === 404, { del: x.r.status, att: attAfter.status });

  console.log('\nудаление всех своих:');
  await send({ text: 'моё 1' });
  await send({ text: 'моё 2' });
  const sAlien = await alienSay('а это остаётся');
  x = await del('/chat?mine=1');
  check('все свои удалены одним запросом', x.r.status === 200 && x.j.removed >= 2, x.j);
  const leftSeqs = await feedSeqs();
  check('чужое при этом НЕ тронуто (installId подставил хаб, а не браузер)',
    leftSeqs.includes(sAlien), { left: leftSeqs, alien: sAlien });
  const mineLeft = ((await jget(`${HUB}/chat?since=0`)).j.messages || [])
    .filter(m => m.installId === me.installId);
  check('своих в журнале не осталось ни одного', mineLeft.length === 0, mineLeft.length);
  x = await del('/chat?all=1');
  check('all=1 вычищает журнал целиком', x.r.status === 200 && x.j.left === 0, x.j);
  check('лента после чистки пуста', (await feedSeqs()).length === 0);
  // Приёмника нет в конфиге — удаление обязано отвечать внятно, а не падать 500.
  fs.rmSync(cfgFile);
  x = await del('/chat?mine=1');
  check('без league-config.json удаление отвечает «не настроен», а не пятисоткой',
    x.r.status === 200 && x.j.ok === false && x.j.receiver
      && x.j.receiver.configured === false, { st: x.r.status, j: x.j });
  useReceiver();

  console.log('\nпуть вложения: число плюс расширение из белого списка, и ничего больше:');
  useStub(); stubMode = 'html'; stubHits.length = 0;
  // «%D9%A7» — арабо-индийская семёрка в процентной записи: `\d` в JS её не считает
  // цифрой, а вот сырой байт в путь запроса не положить, узел ругается сам.
  const badNum = ['7abc', '-1', '1.5', '1e3', '.', '0x10', '%D9%A7', '0', 'nan'];
  let allBad = true;
  for (const s of badNum) {
    const g = await raw(`/__switch/api/league/chat/att/${s}.webp`);
    let why = '';
    try { why = String(JSON.parse(g.buf.toString('utf8')).error || ''); } catch { /* не JSON */ }
    // Форму пути обязан называть КАЖДЫЙ отказ, а не только первый: на подстроку `chat/att` в
    // тексте ошибки стоит приёмочная проверка живого хаба (tools/check-after-restart.js, проба
    // `att/nan.webp`), и без неё «маршрута нет в процессе» перестаёт отличаться от «номер не
    // разобрался». Тот файл чужой — ломать его отсюда нельзя.
    if (g.status !== 400 || !/chat\/att/.test(why)) {
      allBad = false; console.log(`    ↳ пропущено «${s}» → ${g.status} ${why}`);
    }
  }
  check('нечисловой номер отвергнут кодом 400, и отказ называет форму пути', allBad);
  // 🔴 До 05.09 в путь к приёмнику шло ТОЛЬКО число, и это само по себе было защитой: обход
  // каталога был невозможен по построению. Теперь туда идёт ещё и расширение — значит оно и
  // есть новая поверхность, и каждый способ выйти из каталога проверяется ФАКТИЧЕСКИ, а не
  // рассуждением о регулярке. Имени файла в запросе нет вовсе: на диске приёмника файл лежит
  // под номером сообщения, а имя приезжает отдельным полем ленты.
  const traverse = [
    ['точки вместо номера', '/__switch/api/league/chat/att/../../secret'],
    ['точки с расширением', '/__switch/api/league/chat/att/../../../secret.webp'],
    ['хвост после годного имени', '/__switch/api/league/chat/att/1.webp/../../x'],
    ['процентный слэш вместо номера', '/__switch/api/league/chat/att/%2e%2e%2f%2e%2e%2fsecret.webp'],
    ['процентный слэш в расширении', '/__switch/api/league/chat/att/1.webp%2f..%2f..%2fx'],
    ['обратные слэши в расширении', '/__switch/api/league/chat/att/1.webp\\..\\..\\x'],
    ['обратные слэши вместо номера', '/__switch/api/league/chat/att/..\\..\\secret.webp'],
    ['путь Windows в расширении', '/__switch/api/league/chat/att/1.c:%5cwindows%5cwin.ini'],
    ['нулевой байт в расширении', '/__switch/api/league/chat/att/1.webp%00.md'],
  ];
  const escaped = [];
  for (const [why, p] of traverse) {
    // Узел может отказаться отправить такой путь сам — это тоже «не прошло», но считаем
    // отдельно: молча приравнивать отказ клиента к защите сервера нельзя.
    let st = 'узел не отправил';
    try { st = (await raw(p)).status; } catch { /* ERR_UNESCAPED_CHARACTERS и родня */ }
    if (st !== 400 && st !== 'узел не отправил') escaped.push(`${why} → ${st}`);
  }
  check(`ни одна из ${traverse.length} попыток обхода каталога не прошла (все 400)`,
    !escaped.length, escaped);
  check('и ни одна не доехала до приёмника', stubHits.length === 0, stubHits);
  // Чужое расширение — больше НЕ повод отказать: `.md`, `.zip`, `.png` это законный
  // произвольный файл, и запрет на них был той самой поломкой, из-за которой файлы не ходили
  // через хаб вообще. Но наружу такое уезжает только скачиванием — заглушка отвечает html-ом,
  // и он обязан приехать байтами, а не документом.
  stubHits.length = 0;
  const alien = await raw('/__switch/api/league/chat/att/9.png?name=../../x&mime=text/html');
  check('расширение вне списка сигнатур доезжает до приёмника (файл — законное вложение)',
    stubHits.length === 1, stubHits);
  check('в путь к приёмнику ушли ТОЛЬКО номер и расширение: ни имени, ни заявленного типа',
    stubHits[0] === 'GET /chat/att/9.png', stubHits);
  check('чужой html из ответа приёмника отдан скачиванием, а не документом',
    alien.status === 200 && alien.headers['content-type'] === 'application/octet-stream'
      && /^attachment; filename="9\.png"/.test(String(alien.headers['content-disposition'] || '')),
    { st: alien.status, ct: alien.headers['content-type'], cd: alien.headers['content-disposition'] });
  check('на чужих байтах кеш тоже с проверкой, а суточного max-age больше нет',
    alien.headers['cache-control'] === 'no-cache', alien.headers['cache-control']);
  console.log('\nприёмник отвечает не тем, чем должен:');
  stubMode = 'html';
  x = await jget(`${HUB}/chat?since=0`);
  check('не-JSON в ответе → 502 с внятным текстом',
    x.r.status === 502 && /не JSON/.test((x.j || {}).error || ''), { st: x.r.status, j: x.j });
  stubMode = 'boom';
  x = await jget(`${HUB}/chat?since=0`);
  check('пятисотка приёмника → 502, а не молчаливый 500 от нас',
    x.r.status === 502 && /502|500/.test(String((x.j || {}).receiverStatus || x.r.status)),
    { st: x.r.status, j: x.j });
  stubMode = 'fakeimg';
  const fake = await raw('/__switch/api/league/chat/att/5.webp');
  check('приёмник отдал не webp → 502, и чужой html наружу не уходит',
    fake.status === 502 && !fake.buf.toString('latin1').includes('<script'),
    { st: fake.status, body: fake.buf.toString('latin1').slice(0, 40) });
  const fakeAudio = await raw('/__switch/api/league/chat/att/5.webm');
  check('заявленный звук с неподтверждёнными байтами — тоже 502, а не «сыграй это»',
    fakeAudio.status === 502 && !fakeAudio.buf.toString('latin1').includes('<script'),
    { st: fakeAudio.status });
  // Тот же ответ заглушки, но расширение непроверяемое: заявленный ею `image/webp` хаб не
  // читает вовсе — тип он ставит сам, и для файла это только octet-stream.
  const fakeFile = await raw('/__switch/api/league/chat/att/5.md');
  check('заявленный приёмником image/webp на файле не читается: octet-stream + attachment',
    fakeFile.status === 200 && fakeFile.headers['content-type'] === 'application/octet-stream'
      && /^attachment;/.test(String(fakeFile.headers['content-disposition'] || '')),
    { st: fakeFile.status, ct: fakeFile.headers['content-type'],
      cd: fakeFile.headers['content-disposition'] });

  console.log('\nотказ приёмника доезжает как есть:');
  useReceiver();
  let last = null;
  for (let i = 0; i < 30; i++) {
    last = await send({ text: `флуд ${i}` });
    if (last.r.status !== 200) break;
  }
  check('антифлуд приёмника отдан своим кодом 429, а не обёрнут в 502',
    last.r.status === 429 && /минуту/.test((last.j || {}).error || ''),
    { st: last.r.status, j: last.j });

  console.log('\nаватарка:');
  const ava = url => jget(`${HUB}/avatar`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ b64: url }) });
  x = await ava(Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(64)).toString('base64'));
  check('png отвергнут: смотрим на байты, а не на mime',
    x.r.status === 400 && /webp/.test((x.j || {}).error || ''), x.j);
  x = await ava('data:image/webp;base64,' + Buffer.from('это вообще не картинка').toString('base64'));
  check('честный префикс data:image/webp не спасает мусор', x.r.status === 400, x.j);
  x = await ava(mkWebp(30 * 1024).toString('base64'));
  check('30 КБ отсечены до декодирования', x.r.status === 400 && /КБ/.test((x.j || {}).error || ''), x.j);
  x = await ava(mkWebp(20 * 1024 + 1).toString('base64'));
  check('20 КБ + 1 байт отвергнуты по декодированному размеру', x.r.status === 400, x.j);
  x = await ava('');
  check('пустое тело отвергнуто', x.r.status === 400, x.j);
  x = await ava(mkWebp(15000).toString('base64'));
  check('15 КБ приняты', x.r.status === 200 && x.j.ok === true && x.j.bytes === 15000, x.j);
  check('на аватарке, укладывающейся в предел приёмника, предупреждения нет', !x.j.warn, x.j.warn);
  x = await ava(mkWebp(20 * 1024).toString('base64'));
  check('ровно 20 КБ приняты и посчитаны', x.r.status === 200 && x.j.bytes === 20480, x.j);
  // Раньше здесь проверялось предупреждение «соседям не уедет»: приёмник мерил
  // длину строки data-URL, а хаб — декодированные байты, и 20 КБ молча выбрасывались.
  // 05.09 приёмник переведён на байты тем же потолком, единица стала одна — значит
  // предупреждения быть НЕ должно, и его отсутствие теперь и есть правильный ответ.
  check('предупреждения нет: границы сошлись, обе в байтах', !x.j.warn, x.j.warn);
  const idDoc = JSON.parse(fs.readFileSync(idFile, 'utf8'));
  check('в hub-identity.json лежит полный data-URL',
    typeof idDoc.avatar === 'string' && idDoc.avatar.startsWith(AVATAR_PREFIX), (idDoc.avatar || '').slice(0, 30));
  check('installId и ник рядом не потеряны',
    idDoc.installId === me.installId && idDoc.nick === me.nick, idDoc);
  console.log('\nлицо в срезе:');
  let slice = hub.leagueSelf();
  check('срез отдаёт аватарку из hub-identity.json',
    typeof slice.avatar === 'string' && slice.avatar.startsWith(AVATAR_PREFIX),
    (slice.avatar || '').slice(0, 30));
  x = await jget(`${HUB}/nick`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nick: 'переименован' }) });
  check('ник сменился', x.r.status === 200 && x.j.nick === 'переименован', x.j);
  check('смена ника НЕ затёрла лицо (писали слиянием, а не тремя полями)',
    (JSON.parse(fs.readFileSync(idFile, 'utf8')).avatar || '').startsWith(AVATAR_PREFIX));
  const keep = JSON.parse(fs.readFileSync(idFile, 'utf8'));
  fs.writeFileSync(idFile, JSON.stringify({ ...keep, avatar: 'мусор руками' }));
  check('мусор в поле avatar в срез не попадает', hub.leagueSelf().avatar === null);
  fs.writeFileSync(idFile, JSON.stringify({ ...keep,
    avatar: AVATAR_PREFIX + Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(64)).toString('base64') }));
  check('png под видом webp в срез не попадает', hub.leagueSelf().avatar === null);
  fs.writeFileSync(idFile, JSON.stringify(keep));

  // ── Конверт: приёмник режет тело среза на 64 КБ, а лицо едет внутри среза.
  // Мерим на НАСТОЯЩЕМ срезе (реальный __dirname, реальные журналы), запись при этом
  // запрещена — иначе замер трогал бы живой hub-identity.json.
  console.log('\nконверт 64 КБ:');
  const blocked = [];
  const fsRO = new Proxy(fs, { get(t, k) {
    if (k === 'writeFileSync' || k === 'appendFileSync' || k === 'renameSync') return p => blocked.push(path.basename(String(p)));
    return t[k];
  } });
  const real = mkHub(ROUTING, fsRO);
  const realSlice = real.leagueSelf();
  const bare = JSON.stringify(realSlice).length;
  const maxUrl = AVATAR_PREFIX + mkWebp(20 * 1024).toString('base64');
  const full = JSON.stringify({ ...realSlice, avatar: maxUrl }).length;
  const fits15 = JSON.stringify({ ...realSlice, avatar: AVATAR_PREFIX + mkWebp(15000).toString('base64') }).length;
  console.log(`  срез без лица ${KB(bare)} · с аватаркой 15 КБ ${KB(fits15)} · с максимальной (20 КБ) ${KB(full)}`);
  console.log(`  запас до 64 КБ: ${KB(65536 - full)} (аватарка занимает ${KB(maxUrl.length)} строкой)`);
  check('срез с максимальной аватаркой укладывается в 64 КБ', full < 65536, full);
  check('замер ничего не записал на диск', blocked.length === 0, blocked);
  check('живой срез отдаёт поле avatar', 'avatar' in realSlice, Object.keys(realSlice).slice(0, 6));

  // ── Сквозной обмен: доезжает ли лицо до соседей. Одна установка — один срез в
  // минуту, поэтому пробы идут под разными installId.
  console.log('\nлицо доезжает до соседей (настоящий приёмник):');
  const putId = (id, nick, bytes) => fs.writeFileSync(idFile, JSON.stringify({ installId: id, nick,
    avatar: AVATAR_PREFIX + mkWebp(bytes).toString('base64') }));
  putId('a'.repeat(16), 'probe15k', 15000);
  const s1 = await hub.leagueSync();
  putId('b'.repeat(16), 'probe20k', 20 * 1024);
  const s2 = await hub.leagueSync();
  check('оба обмена прошли', s1.ok === true && s2.ok === true, { s1, s2 });
  const pr = await (await fetch(`http://127.0.0.1:${RPORT}/peers?installId=${'c'.repeat(16)}`,
    { headers: { 'X-League-Key': SECRET } })).json();
  const p15 = (pr.peers || []).find(p => p.nick === 'probe15k');
  const p20 = (pr.peers || []).find(p => p.nick === 'probe20k');
  check('аватарка 15 КБ доехала до соседей',
    !!(p15 && typeof p15.avatar === 'string' && p15.avatar.startsWith(AVATAR_PREFIX)),
    p15 && (p15.avatar || '').length);
  // 05.09 приёмник переведён на измерение ДЕКОДИРОВАННЫХ байт тем же потолком 20 КБ,
  // что и хаб. До этого он мерил длину строки data-URL, и аватарка на 20 КБ байт
  // (27 331 символ) молча выбрасывалась из среза: у себя видна, у соседей нет.
  // Теперь единица одна на оба конца, и правильный ответ — что лицо ДОЕХАЛО.
  check('аватарка ровно 20 КБ доехала до соседей: границы в одной единице',
    !!(p20 && typeof p20.avatar === 'string' && p20.avatar.startsWith(AVATAR_PREFIX)),
    p20 && (p20.avatar || '').length);
  console.log('\nсекрет приёмника:');
  const texts = [];
  useReceiver();
  texts.push(await (await fetch(`${HUB}/chat?since=0`)).text());
  texts.push(await (await fetch(`${HUB}/chat`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'после флуда' }) })).text());
  texts.push(await (await fetch(`${HUB}/chat?mine=1`, { method: 'DELETE' })).text());
  useStub(); stubMode = 'boom';
  texts.push(await (await fetch(`${HUB}/chat?since=0`)).text());
  texts.push(await (await fetch(`${HUB}/chat/1?force=1`, { method: 'DELETE' })).text());
  fs.rmSync(cfgFile);
  texts.push(await (await fetch(`${HUB}/chat?since=0`)).text());
  texts.push(JSON.stringify(hub.leagueSelf()));
  check('секрета нет ни в одном ответе браузеру', texts.every(t => !t.includes(SECRET)));
  check('секрета нет и в строках лога', LOGS.every(l => !l.includes(SECRET)), LOGS.slice(0, 4));
  check('в ответах нет и адреса с ключом в строке запроса',
    texts.every(t => !/X-League-Key/i.test(t)));

  // ── Санитайзеры вложения напрямую ─────────────────────────────────────────
  // Сквозняком видно только последствия, а тут важны сами правила: что вырезается из имени,
  // какая длительность считается правдоподобной, какие байты опознаны и что попадает в путь.
  // Каждое из этих правил — единственная преграда для одного конкретного способа навредить,
  // поэтому проверяется поштучно, а не «в целом работает».
  console.log('\nсанитайзер имени, длительности и сигнатур (напрямую, без сети):');
  const N = hub.leagueAttName;
  const CTL = String.fromCharCode(0) + String.fromCharCode(31) + String.fromCharCode(127);
  check('управляющие символы вырезаны (они рвут заголовок и уезжают в лог ноды)',
    N('до' + CTL + 'после.md') === 'допосле.md', N('до' + CTL + 'после.md'));
  check('символ направления письма вырезан: видимое имя не подменить',
    N('счёт' + RLO + 'gpj.exe') === 'счётgpj.exe', N('счёт' + RLO + 'gpj.exe'));
  check('разделители пути заменены — обход каталога прямым текстом не проходит',
    N('../../secret/passwd') === '.._.._secret_passwd', N('../../secret/passwd'));
  check('кавычка и точка с запятой не выйдут из рамки Content-Disposition',
    N('a";b;c.md') === 'a__b_c.md', N('a";b;c.md'));
  check('одни точки — это не имя, а пустая строка (поле просто не уедет)',
    N('..') === '' && N('.') === '' && N('....') === '' && N('   ') === '',
    [N('..'), N('.'), N('....')]);
  check('хвостовая точка снята: Windows её съедает молча',
    N('report.md.') === 'report.md', N('report.md.'));
  check('зарезервированные имена Windows получают подчёрк (в этом проекте nul уже ломал git)',
    N('nul.md') === '_nul.md' && N('COM1') === '_COM1' && N('con') === '_con',
    [N('nul.md'), N('COM1'), N('con')]);
  const longName = N('я'.repeat(200) + '.webm');
  check('потолок 120 символов режет ОСНОВУ, расширение остаётся',
    longName.length === 120 && longName.endsWith('.webm'), longName.length);
  check('не строка — пустая строка, а не исключение',
    N(null) === '' && N(42) === '' && N({}) === '' && N(undefined) === '');
  const D = hub.leagueAttDur;
  check('длительность: годное берём, негодное отбрасываем (плеер дослушает сам)',
    D(34) === 34 && D('34') === 34 && D(120) === 120 && D(34.6) === 35 && D(0) === null
      && D(-5) === null && D(121) === null && D(1e9) === null && D('вечность') === null
      && D(undefined) === null && D(Infinity) === null,
    [D(34), D('34'), D(120), D(34.6), D(0), D(121)]);
  const S = hub.leagueAttSniff;
  const wav = mkWebp(64); wav.write('WAVE', 8, 'latin1');
  check('сигнатуры: webp и webm опознаны, html и строка — нет',
    S(mkWebp(64)) === 'webp' && S(mkWebm(64)) === 'webm'
      && S(mkFile('<html><body>', 300)) === null && S('строка') === null && S(null) === null,
    [S(mkWebp(64)), S(mkWebm(64)), S(mkFile('<html>', 300))]);
  check('wav не путается с webp, хотя оба начинаются на RIFF (различает слово на 8-м байте)',
    S(wav) === 'wav', S(wav));
  const E = hub.leagueAttExtOk;
  check('белый список расширений: только a-z0-9 и до восьми символов',
    E('webp') && E('md') && E('a1b2c3d4') && !E('a1b2c3d4e') && !E('WEBP') && !E('..')
      && !E('web/p') && !E('web.p') && !E('web\\p') && !E('%2e') && !E('') && !E(null),
    [E('webp'), E('WEBP'), E('web.p'), E('%2e')]);
  const P = hub.leagueAttDisp;
  const dCyr = P('отчёт по абузу.md');
  check('в заголовке два поля имени, и первое — attachment, а не inline',
    /^attachment; filename="[ -~]+"; filename\*=UTF-8''/.test(dCyr) && !/inline/.test(dCyr), dCyr);
  check('настоящее имя уехало в filename* процентным кодированием',
    dCyr.includes(encodeURIComponent('отчёт по абузу.md')), dCyr);
  check('значение целиком в ASCII: выше U+00FF Node бросает ERR_INVALID_CHAR',
    [...dCyr].every(ch => ch.codePointAt(0) > 31 && ch.codePointAt(0) < 127), dCyr);
  const dApo = P("it's mine (2).md");
  const star = dApo.split("UTF-8''")[1] || '';
  check("апостроф и скобки докодированы: апостроф ломает рамку кодировка'язык'значение",
    /%27/.test(star) && /%28/.test(star) && /%29/.test(star) && !/['()]/.test(star), dApo);
  check('пустое и негодное имя не оставляют заголовок без имени вовсе',
    /filename="file\.bin"/.test(P('')) && /filename="file\.bin"/.test(P('..')),
    [P(''), P('..')]);
  const DN = hub.leagueAttDispName;
  check('имя вынимается из filename* приёмника (там настоящее, в ASCII-поле огрубление)',
    DN({ 'content-disposition': 'attachment; filename="_.md"; filename*=UTF-8\'\''
      + encodeURIComponent('отчёт.md') }, 'x') === 'отчёт.md',
    DN({ 'content-disposition': 'attachment; filename="_.md"; filename*=UTF-8\'\''
      + encodeURIComponent('отчёт.md') }, 'x'));
  check('нет filename* — берётся ASCII-поле',
    DN({ 'content-disposition': 'attachment; filename="report.md"' }, 'x') === 'report.md');
  check('битое процентное кодирование не роняет ручку — идёт запасное имя',
    DN({ 'content-disposition': "attachment; filename*=UTF-8''%zz" }, '7.bin') === '7.bin');
  check('символ направления письма из ЧУЖОГО заголовка в папку загрузок не доезжает',
    !DN({ 'content-disposition': "attachment; filename*=UTF-8''%E2%80%AEcod.exe" }, 'x')
      .includes(RLO),
    DN({ 'content-disposition': "attachment; filename*=UTF-8''%E2%80%AEcod.exe" }, 'x'));
  check('заголовка нет вовсе — запасное имя из номера и расширения',
    DN({}, '5.bin') === '5.bin' && DN(null, '5.bin') === '5.bin');
  const B = hub.leagueAttBytes;
  check('байты: годное посчитано, пустое и мусор отбиты внятным текстом',
    B(mkWebp(3000).toString('base64')).bytes === 3000 && /base64/.test(B('!!!!').error || '')
      && /b64/.test(B('').error || '') && /больше/.test(B(mkWebp(3e6).toString('base64')).error || ''),
    [B(mkWebp(3000).toString('base64')).bytes, B('!!!!').error, B('').error]);
  check('решений о типе байтов тут НЕ принимается: html — законное вложение (файл)',
    !B(mkFile('<html>', 500).toString('base64')).error,
    B(mkFile('<html>', 500).toString('base64')).error);
  // Два списка форматов на одну границу обязаны совпадать: хаб решает по сигнатуре, ЧЕМ
  // отдать, приёмник — под каким расширением хранить. Разъедутся — и голосовое нового формата
  // уедет скачиванием вместо плеера. Это деградация, не дыра, но искать её будут долго:
  // «в коде же всё есть». Поэтому сверяем таблицы, а не верим комментариям.
  const RECV = fs.readFileSync(RECEIVER, 'utf8');
  const kindAt = RECV.indexOf('const ATT_KIND = {');
  const recTable = {};
  for (const mm of RECV.slice(kindAt, RECV.indexOf('};', kindAt))
    .matchAll(/(\w+): \{ kind: '\w+', mime: '([^']+)' \}/g)) recTable[mm[1]] = mm[2];
  const normTable = o => JSON.stringify(Object.entries(o).sort());
  check('таблица типов хаба совпадает с ATT_KIND приёмника (шесть форматов, те же mime)',
    Object.keys(recTable).length === 6
      && normTable(recTable) === normTable(hub.LEAGUE_ATT_MIME),
    { приёмник: recTable, хаб: hub.LEAGUE_ATT_MIME });

  // ── Вкладка как файл ──────────────────────────────────────────────────────
  // Браузера здесь нет, поэтому клиент проверяется статикой по самому файлу: есть ли
  // кнопка в строке, уходит ли номер сообщения в путь ЧИСЛОМ, не отправляется ли
  // installId из браузера, спрашивается ли подтверждение на чужое. Плюс главное —
  // `node --check` на КАЖДОМ inline-блоке: страница в этом файле уже падала целиком из-за
  // двух DOMContentLoaded в разных блоках, а такую поломку глазами не видно.
  console.log('\nвкладка «Лига» (статикой по proxy-dashboard.html):');
  const HTML = fs.readFileSync(path.join(ROUTING, 'proxy-dashboard.html'), 'utf8');
  const lgCss = HTML.slice(HTML.indexOf('LEAGUE-TAB:BEGIN'), HTML.indexOf('LEAGUE-TAB:END'));
  const fnBody = (from, to) => {
    const i = HTML.indexOf(from), j = HTML.indexOf(to, i + 1);
    return i < 0 || j < 0 ? '' : HTML.slice(i, j);
  };
  const cssRule = sel => {
    const i = lgCss.indexOf(sel);
    return i < 0 ? '' : lgCss.slice(i, lgCss.indexOf('}', i) + 1);
  };
  const HEX = /#[0-9a-fA-F]{3,8}\b/;

  check('в строке ленты есть кнопка удаления (.lgdel) с data-seq и aria-label',
    /class="lgdel"/.test(HTML) && /data-seq="\$\{seq\}"/.test(HTML)
      && /aria-label="Удалить /.test(HTML));
  check('номер сообщения уходит в путь ЧИСЛОМ, а не строкой из разметки',
    /const seq = Number\(m\.seq\) \|\| 0;/.test(HTML)
      && /Number\(btn\.getAttribute\('data-seq'\)\)/.test(HTML));
  // Ключевое правило ручки: installId подставляет хаб. Если он появится в адресе запроса
  // из браузера, можно будет удалить чужое, назвавшись автором.
  check('installId в адресах league/chat из браузера не подставляется',
    !/league\/chat[^\s'"`]*installId/.test(HTML));
  const delOne = fnBody('async function lgChatDelOne', 'async function lgChatDelMine');
  check('удаление чужого: сначала confirm, потом force=1',
    delOne.includes('confirm(') && /force=1/.test(delOne)
      && delOne.indexOf('confirm(') < delOne.indexOf('force=1'), delOne.length);
  // 🔴 Текст подтверждения и это утверждение переписаны ОДНОЙ правкой с приходом личности.
  // Раньше проверялось, что в диалоге стоят слова «ключ у лиги один на всех» и «ограда от
  // промаха». Оба стали ложью: право на чужое теперь ЕСТЬ (у автора и у создателя группы),
  // то есть подтверждение перестало быть только оградой от промаха. Зелёный тест на прежние
  // формулировки охранял бы вранье, поэтому проверяется новое — и проверяется, что старого
  // в диалоге не осталось.
  check('чужое подтверждение говорит правду про то, КТО вправе снести чужое',
    /Право на чужое решает приёмник/.test(delOne)
      && /снести чужое может автор или создатель группы/.test(delOne)
      && /на одном ключе на всех, снести может любой её участник/.test(delOne)
      && /осознанность, а не разрешение/.test(delOne));
  check('прежние формулировки про «один ключ на всех» и «ограду от промаха» убраны',
    !/ключ у лиги один на всех/i.test(delOne) && !/ограда от промаха/.test(delOne)
      && !/журнал общий/.test(delOne));
  check('подтверждение называет, ОТКУДА удаляет: группу либо общий чат',
    /lgChatWhere\(\)/.test(delOne));
  // ⚠️ Здесь стояла проверка «локально строку не вырезаем — лента перечитывается», и она
  // закрепляла поведение, которого больше нет. Перечитывание было ЕДИНСТВЕННЫМ способом
  // узнать о пропаже: курсор `since` умеет только «новее чем». С приходом надгробий
  // (`gone`) пропажа приезжает сама, и восемь страниц по 200 за каждый крестик стали
  // платой без покупки. Новое правило и проверяется: снятие ПО НОМЕРУ, без reload.
  check('своё удаление снимает строку локально по номеру, без перечитывания ленты',
    /lgChatDrop\(\[seq\]\)/.test(delOne) && !/lgChatReload\(/.test(delOne)
      && !/splice\(/.test(delOne), delOne.length);
  const drop = fnBody('function lgChatDrop', '// Надгробия из ответа');
  check('снятие идёт по НОМЕРУ (Set + filter), а не по индексу массива',
    /new Set\(/.test(drop) && /\.msgs\.filter\(/.test(drop) && !/splice\(/.test(drop), drop);
  // Номер уникален только ВНУТРИ группы, поэтому снимать надо в её записи: снятие в чужой
  // лентой не заметно, а сообщение остаётся висеть навсегда.
  check('снятие идёт в записи ГРУППЫ, а не в одной общей ленте',
    /function lgChatDrop\(seqs, gid\)/.test(drop) && /lgG\(gid\)/.test(drop), drop);
  check('снятие НЕ трогает курсор чтения: пропажа старого — не «непрочитанное»',
    !/LGC\.seq/.test(drop), drop);
  const reload = fnBody('async function lgChatReload', '// Крестик в строке');
  check('перечитывание сбрасывает курсор и память страницы',
    /LGC\.seq = 0/.test(reload) && /LGC\.msgs = \[\]/.test(reload));
  const delMine = fnBody('async function lgChatDelMine', '// ── Картинка в полный размер');
  check('«убрать мои» спрашивает подтверждение и бьёт в ?mine=1',
    delMine.includes('confirm(') && /chat\?mine=1/.test(delMine));
  check('контрол «убрать мои» есть в оболочке и подписан для скринридера',
    /id="lg-cdelmine"/.test(HTML) && /aria-label="Удалить все свои сообщения/.test(HTML));
  const why = fnBody('function lgChatDelWhy', 'async function lgChatDelReq');
  check('коды отказа разобраны словами: 403 / 401 / 404 / приёмник молчит',
    /403/.test(why) && /нужно подтверждение/.test(why) && /401/.test(why)
      && /ключ лиги не принят/.test(why) && /404/.test(why) && /уже удалено/.test(why)
      && /приёмник не отвечает/.test(why));
  check('404 хаба (роута нет) отличается от 404 приёмника по not_found',
    /j\.not_found/.test(why));
  check('отказ живёт строкой в вёрстке, а не только тостом',
    /id="lg-cerr"/.test(HTML) && /function lgChatErrPaint/.test(HTML)
      && /role="status"/.test(HTML));
  // Две разные вещи, и обе обязательны: скрытая opacity кнопка обязана ПРОЯВИТЬСЯ на
  // фокусе (иначе Tab уводит в невидимое) и обязана иметь видимую обводку.
  check('кнопка удаления достижима с клавиатуры и видна в фокусе',
    /\.lgdel:focus-visible\{opacity:1\}/.test(lgCss)
      && /#leagueTab \.lgdel:focus-visible\{outline:2px solid var\(--lg-azure\)/.test(lgCss));
  check('без наведения (тач) крестик всё равно видно',
    /@media \(hover:none\)\{#leagueTab \.lgdel/.test(lgCss));
  check('место под крестик занято всегда — лента не перевёрстывается на hover',
    /grid-template-columns:32px minmax\(0,1fr\) 22px/.test(lgCss));
  check('новые правила без своих hex: цвет только токенами темы',
    !HEX.test(cssRule('#leagueTab .lgdel{')) && !HEX.test(cssRule('#leagueTab .lgcerr{')),
    { del: cssRule('#leagueTab .lgdel{'), err: cssRule('#leagueTab .lgcerr{') });
  check('смешивание в oklab, не в oklch (в oklch крутится оттенок)',
    /color-mix\(in oklab/.test(lgCss) && !/color-mix\(in oklch/.test(lgCss));
  check('движение уважает prefers-reduced-motion', /prefers-reduced-motion/.test(lgCss));

  // ── Группы во вкладке: где стоит переключатель и как видно «где я» ──────────
  // 🔴 Место переключателя — не вкус. Рейтинг над чатом ОБЩИЙ, и селектор рядом с ним
  // читался бы как фильтр по рейтингу, то есть врал бы про то, что рейтинг делится.
  console.log('\nгруппы во вкладке (статикой по proxy-dashboard.html):');
  const chead = HTML.slice(HTML.indexOf('<div class="lgchead">'),
    HTML.indexOf('<div id="lg-gapbox">'));
  const tbFrom = HTML.indexOf('<span class="lgcap">метрика</span>');
  const topbar = HTML.slice(tbFrom, HTML.indexOf('<header>', tbFrom + 1));
  // Строки-комментарии выбрасываем: в них НАЗВАНА отвергнутая формулировка («а НЕ „тебя
  // исключили“»), и проверка «этих слов в интерфейсе нет» иначе краснела бы на объяснении
  // того, почему их там нет.
  const noCom = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('переключатель групп стоит в шапке ПАНЕЛИ ЧАТА',
    /id="lg-gbar"/.test(chead), chead.slice(0, 120));
  check('и его НЕТ в верхней панели вкладки, рядом с метрикой и окном',
    !/lg-gbar/.test(topbar) && /lg-segM/.test(topbar));
  // Два признака «где я сейчас»: нажатый сегмент и имя группы в заголовке. Одного мало —
  // на части из 22 тем разница нажатого сегмента это пара процентов светлоты.
  const bar = fnBody('function lgChatBar', '// ── Приглашения ─');
  check('имя группы попадает в ЗАГОЛОВОК панели — второй признак «где я»',
    /id="lg-ctitle"/.test(chead) && /'Чат · ' \+ t/.test(bar), bar.slice(0, 200));
  check('нажатый сегмент помечен aria-pressed, а не только цветом',
    /aria-pressed="\$\{it\.gid === LGC\.gid\}"/.test(bar));
  check('до трёх групп — сегменты тем же .lgseg, своего вида управления не завелось',
    /LGC_SEG_MAX/.test(bar) && /class="lgseg"/.test(bar)
      && /const LGC_SEG_MAX = 3;/.test(HTML));
  check('от четырёх — выпадающий список, иначе сегменты переносятся',
    /<select id="lg-gsel"/.test(bar) && /aria-label="Группа чата"/.test(bar));
  check('одна группа — переключателя нет вовсе: выбор из одного не показывают',
    /list\.length < 2/.test(bar) && /host\.hidden = true/.test(bar));
  check('у каждой группы свой счётчик непрочитанного в переключателе',
    /class="lgun"/.test(bar) && /lgG\(gid\)\.unread/.test(bar));
  // Три пустых состояния. Проверяется, что тексты РАЗНЫЕ и что у мёртвой группы нет
  // кнопки «проверить сейчас»: проверять там нечего, приёмник уже ответил.
  const empty = fnBody('function lgChatEmptyHtml', 'function lgChatSndBtn');
  check('состояние «групп не настроено» приглашает вступить, а не сообщает об ошибке',
    /Чат живёт в группах, а ты пока ни в одной/.test(empty)
      && /Рейтинг выше — общий/.test(empty) && /lgJoinHtml\(\)/.test(empty));
  check('состояние «группы больше нет» формулировано так, а не «тебя исключили»',
    /Этой группы больше нет/.test(empty) && !/тебя исключили/.test(noCom(empty))
      && /исключение работает только вперёд/.test(empty));
  check('у мёртвой группы НЕТ кнопки «проверить сейчас» — проверять нечего',
    !/lg-cretry/.test(empty) && /lg-cretry/.test(fnBody('function lgChatGapHtml',
      'function lgChatState')));
  check('пустые состояния — не красное и не янтарное: это законное состояние',
    !HEX.test(cssRule('#leagueTab .lgnone{'))
      && !/rose|amber/.test(cssRule('#leagueTab .lgnone{')),
    cssRule('#leagueTab .lgnone{'));
  check('без группы писать некуда: composer и «убрать мои» выключены тем же выключателем',
    /const noWhere = !lgChatLive\(\) \|\| lgG\(\)\.gone;/.test(HTML)
      && /'lg-mic', 'lg-cdelmine'\]/.test(HTML));
  check('«пригласить друга» выключена, пока группы нет: молчащая кнопка читается как поломка',
    /const okInv = LGC_GID_RE\.test\(LGC\.gid\) && !lgG\(\)\.gone;/.test(HTML)
      && /inv\.disabled = off \|\| !okInv;/.test(HTML));
  check('перевод данных под открытой страницей замечается сам: 400 → перечитать /me',
    /if \(r\.status === 400\) lgChatMeMaybe\(\);/.test(HTML)
      && /const LGC_ME_MS = 30000;/.test(HTML));
  check('выбранная группа помнится между перезагрузками страницы',
    /localStorage\.setItem\(LGC_GID_KEY, k\)/.test(HTML)
      && /localStorage\.getItem\(LGC_GID_KEY\)/.test(HTML));
  check('состояние панели различает «ручек нет», «группы нет» и «групп нет»',
    /'ручек чата ещё нет'/.test(HTML) && /'группы больше нет'/.test(HTML)
      && /'групп пока нет'/.test(HTML));
  // 🪤 Внутри коробки состояний живёт поле «вставь приглашение», а лента перерисовывается на
  // каждое пришедшее сообщение. Без сравнения разметки набранная строка и фокус исчезали бы
  // на середине вставки — и выглядело бы это как «поле само чистится».
  check('коробка состояний не переписывается впустую — набранное приглашение выживает',
    /if \(gapBox && gapBox\.innerHTML !== gapNew\) gapBox\.innerHTML = gapNew;/.test(HTML));
  // Приглашение. Свойства не косметические: строка одноразовая и является входом в чат.
  const inv = HTML.slice(HTML.indexOf('// ── Приглашения ─'), HTML.indexOf('// ── Вложения ─'));
  check('«пригласить друга» есть в шапке и подписана для скринридера',
    /id="lg-cinv"/.test(chead) && /aria-label="Пригласить друга/.test(chead));
  check('приглашение выдаётся POST-ом в свою группу, а право проверяет приёмник',
    /fetch\('\/__switch\/api\/league\/invite', \{ method: 'POST'/.test(inv)
      && /groups: \[gid\]/.test(inv));
  check('строка не уходит ни в console, ни в title, ни в адрес запроса',
    !/console\./.test(inv) && !/title="\$\{[^}]*(blob|code)/.test(inv)
      && !/invite\/\$\{[^}]*code/.test(inv));
  check('строка кладётся в разметку через lgEsc и стирается вместе с ней',
    /<code class="lgblob">\$\{lgEsc\(line\)\}<\/code>/.test(inv)
      && /LGC\.inv = null; lgInvPaint\(\)/.test(inv));
  check('копирование берёт строку из состояния, а не из дерева, и через clipboard',
    /navigator\.clipboard\.writeText\(line\)/.test(inv)
      && /LGC\.inv \? \(LGC\.inv\.blob \|\| LGC\.inv\.code\) : ''/.test(inv));
  check('в подтверждении копирования самой строки НЕТ (тост попадает на скриншот)',
    !/toast\([^)]*line/.test(inv));
  check('список своих непогашенных приглашений есть и даёт погасить',
    /GET \/invite|fetch\('\/__switch\/api\/league\/invite'\)/.test(inv)
      && /method: 'DELETE'/.test(inv) && /data-invrm=/.test(inv));
  check('«вступить» и поле приглашения доступны с клавиатуры и подписаны',
    /id="lg-joinb"/.test(inv) && /aria-label="Строка приглашения от участника лиги"/.test(inv)
      && /#leagueTab #lg-joinv:focus-visible/.test(lgCss));
  check('новые правила групп и приглашений без своих hex',
    !HEX.test(cssRule('#leagueTab .lgun{')) && !HEX.test(cssRule('#leagueTab .lgsel{'))
      && !HEX.test(cssRule('#leagueTab .lginv{')) && !HEX.test(cssRule('#leagueTab .lgblob{')),
    { un: cssRule('#leagueTab .lgun{'), inv: cssRule('#leagueTab .lginv{') });
  check('длинная строка приглашения не растянет панель (перенос по любому символу)',
    /overflow-wrap:anywhere/.test(cssRule('#leagueTab .lgblob{')),
    cssRule('#leagueTab .lgblob{'));
  // Отправка и удаление обязаны называть «где». Иначе приёмник отвечает 400, а в наследуемом
  // режиме — пишет не туда.
  const sendFn = fnBody('async function lgChatSend', '// ── Удаление ─');
  check('отправка называет группу и телом, и строкой запроса',
    /body\.gid = gid/.test(sendFn) && /chat\$\{gid \? '\?gid=' \+ gid : ''\}/.test(sendFn));
  check('«убрать мои» бьёт в свою группу, а не в журнал вообще',
    /chat\?mine=1\$\{gid \? '&gid=' \+ gid : ''\}/.test(HTML));
  check('в наследуемом режиме группы в запросе НЕТ — сегодняшний контракт цел',
    /LGC_GID_RE\.test\(LGC\.gid\) \? LGC\.gid : ''/.test(sendFn));

  console.log('\nаватарка во вкладке:');
  const avPick = fnBody('async function lgAvPick', 'function lgAvSheet');
  check('сжатие идёт в браузере: canvas → webp, квадрат, предел 20 КБ',
    /lgFit\(im, \{ max: 160, limit: LG_AV_LIMIT, square: true \}\)/.test(avPick)
      && /const LG_AV_LIMIT = 20 \* 1024;/.test(HTML));
  check('выбор файла НЕ отправляет сразу — сначала превью',
    !avPick.includes('fetch(') && /lgAvSheet\(/.test(avPick));
  check('превью — диалог с тремя решениями и подписью для скринридера',
    /id="lg-avbox"/.test(HTML) && /aria-modal="true"/.test(HTML)
      && /id="lg-avok"/.test(HTML) && /id="lg-avother"/.test(HTML) && /id="lg-avno"/.test(HTML));
  check('Escape закрывает превью тем же слушателем, что просмотр вложения',
    /if \(e\.key !== 'Escape'\) return;[\s\S]{0,120}lgAvSheetClose\(\)/.test(HTML));
  check('отправка подтверждённой аватарки идёт в существующую ручку POST /league/avatar',
    /fetch\('\/__switch\/api\/league\/avatar', \{ method: 'POST'/.test(HTML));
  const avClear = fnBody('async function lgAvClear', 'const LG_SHELL');
  check('снятие лица: спрашивает подтверждение',
    avClear.includes('confirm(') && /Снять аватарку\?/.test(avClear));
  // Ручки снятия у хаба сейчас нет (POST /avatar требует годный webp, а DELETE-роута для
  // аватарки в transparent-proxy.js не зарегистрировано). Кнопка обязана в этом случае
  // сказать правду и подсказать ручной путь, а не отрапортовать «готово».
  check('снятие лица честно объясняет отказ, если ручки нет',
    /not_found/.test(avClear) && /hub-identity\.json/.test(avClear));
  check('кнопка «снять лицо» показывается только когда лицо есть',
    /lgAvOk\(me\.avatar\) \? `<button class="lgtgl" id="lg-avrm"/.test(HTML));

  // ── Голосовое ─────────────────────────────────────────────────────────────
  // Числа здесь не «настройки», а замеры (разбор — _research/voice-findings.md), поэтому
  // проверяются именно они, а не наличие слова «голосовое». Любое из них, потерянное при
  // правке, стоит либо пятикратного расхода трафика, либо гигабайтов лишнего чтения.
  console.log('\nголосовое во вкладке (статикой по proxy-dashboard.html):');
  const voice = HTML.slice(HTML.indexOf('// ── Голосовое: запись ─'),
    HTML.indexOf('// ── Отправка ─'));
  check('кнопка микрофона есть, подписана и переключается состоянием',
    /id="lg-mic"/.test(HTML) && /aria-label="Записать голосовое сообщение"/.test(HTML)
      && /#leagueTab \.lgmic\.on\{/.test(lgCss));
  check('битрейт задан ЯВНО и равен 24 кбит/с (без него браузер уедет на 128)',
    /const LGC_VOICE_BPS = 24000;/.test(HTML)
      && /audioBitsPerSecond: LGC_VOICE_BPS/.test(voice), voice.length);
  // Список форматов проверяется по САМОЙ КОНСТАНТЕ, а не по тексту блока: про
  // `mp4a.40.2` в блоке есть комментарий, почему его там нет, — и он не должен считаться
  // за использование. На Windows этот путь уходит в Media Foundation, где меньше
  // 96 кбит/с не бывает вовсе, и минута речи весит 720 КБ вместо 180.
  const mimeLine = (HTML.match(/const LGC_VOICE_MIMES = \[[^\]]*\]/) || [''])[0];
  check('формат — webm/opus первым, моно; mp4a.40.2 в списке нет',
    /^const LGC_VOICE_MIMES = \['audio\/webm;codecs=opus'/.test(mimeLine)
      && !/mp4a/.test(mimeLine) && /channelCount: 1/.test(voice), mimeLine);
  check('жёсткий стоп на 120 секундах и предел 512 КБ',
    /const LGC_VOICE_MS = 120000;/.test(HTML)
      && /const LGC_VOICE_BYTES = 512 \* 1024;/.test(HTML)
      && /LGC_VOICE_MS\) \{ lgVoiceStop\('time'\)/.test(voice)
      && /LGC_VOICE_BYTES \* 0\.9\) lgVoiceStop\('big'\)/.test(voice));
  check('видимый обратный отсчёт: полоса записи, время и остаток',
    /id="lg-rec"/.test(HTML) && /id="lg-rectm"/.test(HTML)
      && /осталось \$\{lgSecs/.test(voice));
  // Секунды считаются РАЗНОСТЬЮ ЧАСОВ. В скрытой вкладке таймеры троттлятся до раза в
  // минуту, а кадры не тикают вовсе — счётчик того или другого отстал бы от записи.
  check('секунды — разность времени, а не число тиков или кадров',
    /Date\.now\(\) - r\.at/.test(voice) && !/requestAnimationFrame/.test(voice));
  // 🔴 Самое дорогое из всего блока: плеер без preload="none" тянет файл на КАЖДОЙ
  // перерисовке ленты. Проверяем не «где-то есть», а что таких плееров в файле нет ни
  // одного: считаем настоящие теги (те, у которых есть `src`), упоминания в комментариях
  // за плееры не считаются. Плюс отдельно — что никто не поставил preload другим значением.
  const players = (HTML.match(/<audio[^>]*>/g) || []).filter(t => /\bsrc=/.test(t));
  check(`preload="none" у ВСЕХ плееров страницы (их ${players.length})`,
    players.length >= 2 && players.every(t => /preload="none"/.test(t))
      && !/<audio[^>]*preload="(metadata|auto)"/.test(HTML), players);
  check('индикатор записи гаснет остановкой ДОРОЖЕК потока, а не рекордера',
    /getTracks\(\)\) t\.stop\(\)/.test(voice) && /lgVoiceFree\(r\)/.test(voice));
  check('записанное НЕ отправляется сразу — ложится в чип-превью',
    !/fetch\(/.test(voice) && /lgChatAttPut\(\{ kind: 'audio'/.test(voice));
  check('длительность считается сама и уходит в теле сообщения',
    /body\.att\.dur = a\.dur/.test(HTML) && /dur: secs/.test(voice));
  check('длительность видна ТЕКСТОМ в строке ленты (webm её в заголовке не несёт)',
    /голосовое · ' \+ \(dur \? lgSecs\(dur\)/.test(HTML) && /class="lgvm"/.test(HTML));
  check('отказ микрофона различает адрес: localhost можно, http по сети — нет',
    /isSecureContext/.test(voice) && /localhost/.test(voice)
      && /NotAllowedError/.test(voice) && /NotFoundError/.test(voice)
      && /NotReadableError/.test(voice));
  check('одно сообщение — одно вложение: звук занимает то же место, что картинка',
    /function lgChatAttPut/.test(HTML) && (HTML.match(/body\.att = \{/g) || []).length === 1);
  // ── Плеер: почему свой, а не `controls` ───────────────────────────────────
  // При `preload="none"` длительности до первого нажатия НЕ ЗНАЕТ НИКТО, поэтому нативная
  // полоса ползёт по неизвестному итогу, а её «0:00» — неправда. Значит прогресс считается
  // от длительности ИЗ ТЕЛА сообщения, и порядок источников тут — предмет проверки.
  const player = HTML.slice(HTML.indexOf('// ── Голосовое: проигрывание ─'),
    HTML.indexOf('// ── Голосовое: запись ─'));
  check('плеер свой: у элемента нет controls, органы управления — кнопки с подписями',
    !/<audio class="lgva"[^>]*controls/.test(HTML) && /data-vplay=/.test(HTML)
      && /aria-label="\$\{lab\} — нажми, чтобы проиграть"/.test(HTML)
      && /#leagueTab \.lgva\{display:none\}/.test(lgCss));
  check('прогресс считается от длительности ИЗ ТЕЛА, audio.duration — только замена',
    /data-dur="\$\{dur\}"/.test(HTML) && /const body = Number\(box\.getAttribute\('data-dur'\)\)/.test(player)
      && /const dur = body \|\| own;/.test(player)
      && player.indexOf('data-dur') < player.indexOf('a.duration'), player.length);
  // Первое нажатие тянет файл с ноды. Без видимого признака тишина читается как поломка.
  check('у первого нажатия есть видимый признак «грузится»',
    /lgVoiceMark\(box, 'load'\);\n  const p = a\.play\(\)/.test(player)
      && /st === 'load' \? '…'/.test(player) && /'waiting'/.test(HTML));
  check('скорость переключается, и 0.75 идёт сразу за обычной (замедление нужнее)',
    /const LGC_VOICE_RATES = \[1, 0\.75, 1\.5\];/.test(HTML)
      && /a\.playbackRate = next;/.test(player) && /data-vspeed=/.test(HTML));
  check('у голосового есть скачивание с внятной подписью',
    /aria-label="Скачать \$\{lab\}"/.test(HTML) && /download="\$\{lgEsc\(name\)\}"/.test(HTML));
  check('медиа-события слушаются в фазе перехвата, одним набором на всю ленту',
    /for \(const ev of \['timeupdate', 'durationchange', 'playing', 'waiting', 'pause', 'ended', 'error'\]\)/.test(HTML)
      && /feed\.addEventListener\(ev, lgVoiceEv, true\);/.test(HTML));
  // ── Запрос микрофона: два конца, которые молчат ─────────────────────────────
  // По спеке человек НЕ обязан отвечать: шторку закрыли крестиком — промис не разрешится
  // и не отклонится никогда. А заблокированный источник Chrome вообще больше не спрашивает.
  check('ожидание ответа на запрос микрофона ограничено потолком',
    /const LGC_MIC_WAIT_MS = 60000;/.test(HTML) && /Promise\.race\(\[ask,/.test(voice)
      && /LgNoAnswer/.test(voice) && /не дождался ответа/.test(voice));
  check('опоздавший поток гасится: индикатор записи без записи — недопустим',
    /Promise\.resolve\(ask\)\.then\(s => \{ for \(const t of s\.getTracks\(\)\) t\.stop\(\); \}/.test(voice));
  check('состояние разрешения спрашивается ДО запроса, и «заблокировано» сказано словами',
    /async function lgMicState/.test(voice) && /permissions\.query\(\{ name: 'microphone' \}\)/.test(voice)
      && /await lgMicState\(\) === 'denied'/.test(voice) && /адресной строке/.test(voice));
  check('вторая шторка поверх первой не открывается (LGC.asking)',
    /LGC\.rec \|\| LGC\.sending \|\| LGC\.asking/.test(voice) && /asking: false/.test(HTML)
      && /b\.disabled = LGC\.asking;/.test(voice));
  // Три адреса одного дашборда — три разных разрешения. «Я же разрешал» звучит при первом
  // переключении, поэтому каждый отказ называет текущий адрес.
  check('в отказах назван адрес: разрешение привязано к источнику целиком',
    /const lgVoiceOrigin = \(\)/.test(voice) && /location\.origin/.test(voice)
      && /lgVoiceOrigin\(\)/.test(voice));
  check('«не тот адрес» и «отказано» — разные тексты',
    /isSecureContext/.test(voice) && /localhost защищённым считается/.test(voice)
      && /заблокирован для этого адреса/.test(voice));
  // Ограда по байтам живёт ТОЛЬКО при заданной нарезке: без аргумента у start данные
  // приходят одним куском в конце, и сравнивать во время записи будет нечего.
  check('рекордер запущен с нарезкой — иначе ограда по байтам мёртвый код',
    /mr\.start\(1000\)/.test(voice));
  // ── Произвольный файл ─────────────────────────────────────────────────────
  // 🔴 Главное правило проверяется первым: содержимое чужого файла НЕ отрисовывается.
  // Дашборд открыт на том же origin, где ручки управления денежными шлюзами, а файл
  // приезжает с чужой машины — отрисованный markdown с картинкой или ссылкой (svg тем
  // более) исполнил бы свой скрипт здесь, с доступом ко всему.
  console.log('\nпроизвольный файл во вкладке:');
  const fileSet = fnBody('async function lgChatFileSet', '// ── Предпросмотр текстового');
  const txt = fnBody('async function lgChatTxt', '// ── Голосовое: запись ─');
  const attHtml = fnBody('function lgAttHtml', 'function lgChatRow');
  check('выбор файла — тот же путь, что у картинки, но без фильтра по типу',
    /lgPickFile\('\*\/\*'\)/.test(HTML) && /function lgPickFile\(accept = 'image\/\*'\)/.test(HTML));
  check('картинку жмём, всё остальное уходит КАК ЕСТЬ (без распознавания)',
    /return lgChatFileSet\(file\)/.test(HTML) && !/lgFit\(/.test(fileSet));
  check('в строке файла: имя, вес и скачивание',
    /class="lgfile"/.test(attHtml) && /class="nm"/.test(attHtml)
      && /class="sz"/.test(attHtml) && /download="/.test(attHtml));
  // Имя пришло от другого человека и уходит В АТРИБУТ. Один непроэкранированный вывод —
  // и это XSS на origin денежных ручек; в этом проекте такое уже было.
  check('имя файла экранируется ВЕЗДЕ: и в тексте, и в атрибуте download, и в title',
    /download="\$\{lgEsc\(name\)\}"/.test(attHtml)
      && /<span class="nm" title="\$\{lgEsc\(name\)\}">\$\{lgEsc\(name\)\}<\/span>/.test(attHtml)
      && !/download="\$\{name\}"/.test(attHtml));
  check('скачивание отдаёт исходное имя и подписано для скринридера',
    /aria-label="Скачать файл \$\{lgEsc\(name\)\}/.test(attHtml)
      && /href="\$\{url\}" download=/.test(attHtml));
  // Путь собирается из ЧИСЛА и своего расширения; группа — только из проверенных 32 hex.
  // Обе формы обязательны: с группой (после перехода) и без неё (до него).
  check('путь вложения собирается из ЧИСЛА seq и своего расширения, не из чужой строки',
    /chat\/att\/\$\{gid \? gid \+ '\/' : ''\}\$\{Number\(m\.seq\) \|\| 0\}\.\$\{lgAttExt\(m\)\}/.test(HTML)
      && /\/\^\[a-z0-9\]\{1,8\}\$\/\.test\(s\)/.test(HTML)
      && /const LGC_MIME_EXT = new Map\(/.test(HTML));
  // Отрисовки содержимого нет ни в одном виде: ни markdown-движка, ни html из файла, ни
  // svg картинкой. Картинкой рисуется ТОЛЬКО ветка kind === 'image' (webp по сигнатуре).
  check('содержимое файла НЕ отрисовывается: ни markdown, ни html, ни svg картинкой',
    !/marked|markdown-it|showdown|DOMPurify/i.test(HTML)
      && !/innerHTML\s*=\s*[^;]*await/.test(HTML)
      && (attHtml.match(/<img/g) || []).length === 1
      && /if \(kind === 'image'\)/.test(attHtml));
  check('предпросмотр текста кладётся textContent в <pre>, а не разметкой',
    /box\.textContent = cut\.join/.test(txt) && !/innerHTML/.test(txt)
      && /class="lgtxt"/.test(attHtml));
  check('предпросмотр ограничен по строкам и по длине строки',
    /const LGC_TXT_LINES = 40;/.test(HTML) && /const LGC_TXT_COLS = 200;/.test(HTML)
      && /slice\(0, LGC_TXT_LINES\)/.test(txt) && /slice\(0, LGC_TXT_COLS\)/.test(txt));
  // Порядок операций, а не только пределы: минифицированный json — это весь файл ОДНОЙ
  // строкой. «Первые 40 строк» от него дают ту же строку на мегабайт, а деление раньше
  // обрезки на таком файле сначала строит массив на сотни тысяч элементов.
  check('в предпросмотре сначала режутся БАЙТЫ, потом делится на строки',
    /slice\(0, LGC_TXT_LINES \* LGC_TXT_COLS \* 4\)/.test(txt)
      && txt.indexOf('slice(0, LGC_TXT_LINES * LGC_TXT_COLS * 4)') < txt.indexOf(".split(/"), txt.length);
  // Класс Cf — невидимые форматирующие, среди них символы направления письма. Ими
  // подменяют ВИДИМОЕ содержимое строки: выглядит одним, означает другое. Вырезаются и в
  // имени файла, и в предпросмотре — обе поверхности человек читает глазами.
  check('символы направления письма (класс Cf) вырезаются и в имени, и в предпросмотре',
    /\\p\{Cf\}\/gu/.test(HTML) && (HTML.match(/\\p\{Cf\}\/gu/g) || []).length >= 2
      && /\\p\{Cf\}\/gu/.test(txt), (HTML.match(/\\p\{Cf\}\/gu/g) || []).length);
  check('в разметке файла нет blob:-адресов — скачивание прямой ссылкой на ручку',
    !/createObjectURL/.test(attHtml) && /href="\$\{url\}"/.test(attHtml));
  // Провенанс: файл-скилл это инструкции, которые потом может прочитать агент, а кто его
  // прислал — забывается за сутки. Анализа содержимого и карантина нет намеренно, но
  // сказать об этом человеку — обязательно. И пути «сохранить в скиллы» в интерфейсе быть
  // не должно: он положил бы присланное туда, где агенты читают без вопросов.
  check('рядом с карточкой файла сказано, что содержимое не проверялось',
    /содержимое не проверялось/.test(attHtml)
      && !/>сохранить[^<]*скилл/i.test(HTML) && !/skills[\\/]/i.test(attHtml));
  check('предпросмотр раскрывается только нажатием и только у текстовых расширений',
    /\[data-txt\]/.test(HTML) && /LGC_EXT_TEXT\.includes\(ext\)/.test(attHtml)
      && /hidden><\/pre>/.test(attHtml));
  check('предел веса файла есть и он назван человеку в отказе',
    /const LGC_FILE_BYTES = 512 \* 1024;/.test(HTML)
      && /файл больше \$\{lgKb\(LGC_FILE_BYTES\)\}/.test(fileSet));
  check('длинное имя режется стилями, а не ломает сетку ленты',
    /#leagueTab \.lgfile \.nm\{[^}]*text-overflow:ellipsis/.test(lgCss));
  check('новые правила файла и голосового — без своих hex',
    !HEX.test(cssRule('#leagueTab .lgfile{')) && !HEX.test(cssRule('#leagueTab .lgrec{'))
      && !HEX.test(cssRule('#leagueTab .lgvm{')) && !HEX.test(cssRule('#leagueTab .lgtxt{')),
    { file: cssRule('#leagueTab .lgfile{'), rec: cssRule('#leagueTab .lgrec{') });
  // Общее правило вкладки гасит только transition-duration — анимацию точки оно не видит.
  check('пульсация точки записи гаснет при prefers-reduced-motion',
    /@keyframes lgrecpulse/.test(lgCss)
      && /@media \(prefers-reduced-motion:reduce\)\{#leagueTab \.lgrec \.dot\{animation:none\}\}/.test(lgCss));
  // ── Лента живьём ──────────────────────────────────────────────────────────
  // Не регуляркой, а ЗАПУСКОМ настоящего кода вкладки. «В файле есть слово gone» ничего
  // не говорит о том, снимается ли правильная строка, не откатывается ли курсор чтения и
  // не зацикливается ли перечитывание. Блок от `const LGC` до `function lgChatStart`
  // самодостаточен: браузерное окружение нужно ему несколькими именами, они подставляются
  // заглушками, а `localStorage` внутри уже обёрнут в try/catch самой вкладкой.
  console.log('\nлента живьём (настоящие lgChatTake / lgChatDrop / lgChatFetch):');
  const cliFrom = HTML.indexOf('const LGC = {');
  const cliTo = HTML.indexOf('function lgChatStart(');
  const cliSrc = (cliFrom > 0 && cliTo > cliFrom) ? HTML.slice(cliFrom, cliTo) : '';
  // Приглашения живут за границей этого блока (они DOM'ные), но опираются на тот же `LGC`
  // и `lgG`. Клеим оба куска в одну песочницу: иначе пришлось бы подделывать состояние
  // групп, то есть проверять подделку вместо кода.
  const invSrc = HTML.slice(HTML.indexOf('// ── Приглашения ─'),
    HTML.indexOf('// ── Вложения ─'));
  // Крошечный поддельный DOM: узел с `innerHTML` и `hidden` — ровно то, чем пользуются
  // lgInvPaint и lgChatBar. Разметку потом читаем строкой, как её прочитал бы браузер.
  const mkEl = () => ({ innerHTML: '', hidden: false, textContent: '',
    querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {},
    getAttribute: () => null, setAttribute: () => {}, classList: { toggle: () => {} } });
  const mkCli = (fetchImpl, opt) => {
    const o = opt || {};
    const calls = [];
    const logs = [];
    const els = {};
    const el = id => (els[id] || (els[id] = mkEl()));
    // Именно те узлы, которые нужны проверяемым функциям. Всё прочее — null, как в
    // браузере до открытия «Лиги»: этот путь вкладка обязана переживать.
    for (const id of o.dom || []) el(id);
    const doc = {
      visibilityState: o.visible ? 'visible' : 'hidden',
      querySelector: () => o.tabOpen ? { classList: { contains: () => true } } : null,
      getElementById: id => els[id] || null,
    };
    const api = new Function('window', 'document', 'addEventListener', 'fetch', 'console',
      'navigator', 'lgEsc', 'lgChatPaint', 'lgChatState', 'lgChatReload', 'lgChatBadge',
      'lgChatBar', 'LG', 'toast',
      `${cliSrc}\n${o.invites ? invSrc : ''}\nreturn { LGC, lgG, lgChatTake, lgChatDrop,`
      + ' lgChatGone, lgChatFetch, lgChatApply, lgChatUrl, lgChatGids, lgChatLive,'
      + ' lgChatSeenNow, lgChatSeen, lgChatGroupPick, lgGroupsSet, lgGroupTitle, lgChatWhere,'
      + (o.invites ? ' lgInvCreate, lgInvPaint, lgInvList, lgInvWhy, lgJoinHtml, lgInvRevoke,' : '')
      + ' lgChatMe, lgGroupLoad };'
    )(
      {}, doc, () => {}, fetchImpl,
      // `console` и `toast` — параметрами, чтобы поймать утечку строки приглашения в любой
      // из двух журналов: и в консоль браузера, и в тост на экране.
      { log: (...a) => logs.push(['log', ...a]), warn: (...a) => logs.push(['warn', ...a]),
        error: (...a) => logs.push(['error', ...a]), info: (...a) => logs.push(['info', ...a]) },
      { clipboard: { writeText: async v => { logs.push(['clip', v]); } } },
      s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      () => calls.push('paint'), () => calls.push('state'),
      async () => calls.push('reload'), () => calls.push('badge'),
      () => calls.push('bar'),
      o.LG || { data: { me: { installId: 'a'.repeat(16) } } },
      (...a) => logs.push(['toast', ...a])
    );
    api.calls = calls;
    api.logs = logs;
    api.els = els;
    return api;
  };
  let cli = null, cliErr = '';
  try { cli = mkCli(async () => ({ ok: false, status: 0, json: async () => null })); }
  catch (e) { cliErr = e.message; }
  check('блок ленты вырезается и исполняется вне браузера', !!cli, cliErr);
  if (cli) {
    const C = cli.LGC;
    const seqs = () => C.msgs.map(m => m.seq).join(',');
    const say = n => ({ seq: n, installId: 'b'.repeat(16), nick: 'сосед',
      text: 'проба ' + n, recvAt: new Date().toISOString() });
    let t = cli.lgChatTake({ seq: 3, messages: [say(1), say(2), say(3)] });
    check('порция принята: три сообщения, курсор 3',
      t.got === 3 && C.seq === 3 && seqs() === '1,2,3', { t, seq: C.seq, in: seqs() });
    // Ответ старой сборки приёмника: новых полей нет вообще — и ничего не должно меняться.
    t = cli.lgChatTake({ seq: 3, messages: [] });
    check('ответ БЕЗ новых полей ничего не ломает и не просит перерисовки',
      t.got === 0 && t.changed === false && seqs() === '1,2,3', t);
    t = cli.lgChatTake({ seq: 3, messages: [], gone: [2], gseq: 7 });
    check('gone числом снимает ИМЕННО этот номер, а курсор чтения не откатывается',
      t.changed === true && seqs() === '1,3' && C.seq === 3, { t, in: seqs(), seq: C.seq });
    check('курсор надгробий поднялся полем ответа', C.gseq === 7, C.gseq);
    t = cli.lgChatTake({ seq: 3, messages: [], gone: [{ seq: 3, at: 'x', gseq: 9 }] });
    check('gone объектом { seq, at, gseq } понимается тоже, gseq берётся из записи',
      t.changed === true && seqs() === '1' && C.gseq === 9, { in: seqs(), gseq: C.gseq });
    t = cli.lgChatTake({ seq: 3, messages: [], gone: [3, 2], gseq: 9 });
    check('повтор надгробий безвреден: список идемпотентен, перерисовки нет',
      t.changed === false && seqs() === '1', { t, in: seqs() });
    // Обрезка журнала: приёмник вытеснил низ кольцом, надгробий на это не будет.
    cli.lgChatTake({ seq: 11, messages: [say(10), say(11)] });
    t = cli.lgChatTake({ seq: 11, messages: [], firstSeq: 11 });
    check('firstSeq выбрасывает у себя всё ниже дна журнала',
      t.changed === true && seqs() === '11' && C.firstSeq === 11, { in: seqs(), first: C.firstSeq });
    // «Перечислить пропавшее не могу»: буфер выбрасывается целиком, курсоры на ноль.
    t = cli.lgChatTake({ seq: 11, messages: [say(12)], cold: true, coldWhy: 'дно журнала' });
    check('cold выбрасывает буфер и сбрасывает курсоры, просит дочитать хвост',
      t.cold === true && t.changed === true && C.msgs.length === 0 && C.seq === 0
        && C.gseq === 0 && C.first === true && /дно журнала/.test(C.cold),
      { t, msgs: C.msgs.length, seq: C.seq, gseq: C.gseq, why: C.cold });
    // Второй cold подряд слушать нельзя: это вечный цикл перезагрузок ленты.
    t = cli.lgChatTake({ seq: 0, messages: [], cold: true });
    check('второй cold подряд игнорируется — порогом против цикла перезагрузок',
      t.cold === false && t.changed === false, t);
    // Живой приёмник называет это поле `resync` (и `resyncWhy`) — та же ветка.
    C.coldAt = 0;
    t = cli.lgChatTake({ seq: 0, messages: [say(20)], resync: true, resyncWhy: 'старая сборка' });
    check('признак `resync` от живого приёмника понимается как cold',
      t.cold === true && C.msgs.length === 0 && /старая сборка/.test(C.cold), { t, why: C.cold });
    // Снятие по номеру — отдельно от протокола: чем зовут, тем и должно резать.
    C.msgs = [say(5), say(6), say(7)];
    const off = cli.lgChatDrop([6, 6, 0, 'мусор']);
    check('lgChatDrop снимает по номеру, мусор в списке игнорирует',
      off === 1 && C.msgs.map(m => m.seq).join(',') === '5,7', { off, in: C.msgs.map(m => m.seq) });
    // Оба курсора в запросе. Приёмник прежней сборки лишний параметр просто не заметит.
    const urls = [];
    const cli2 = mkCli(async u => { urls.push(String(u));
      return { ok: true, status: 200, json: async () => ({ seq: 0, messages: [] }) }; });
    cli2.LGC.seq = 41; cli2.LGC.gseq = 7;
    await cli2.lgChatFetch();
    check('в запрос уходят ОБА курсора: since и gseq',
      /[?&]since=41(&|$)/.test(urls[0] || '') && /[?&]gseq=7(&|$)/.test(urls[0] || ''), urls[0]);
    check('пустой ответ ленту НЕ перерисовывает (300 строк одним innerHTML)',
      !cli2.calls.includes('paint') && cli2.calls.includes('state'), cli2.calls);
    const cli3 = mkCli(async () => ({ ok: true, status: 200,
      json: async () => ({ seq: 1, messages: [{ seq: 1, installId: 'b'.repeat(16),
        nick: 'сосед', text: 'первое', recvAt: new Date().toISOString() }] }) }));
    await cli3.lgChatFetch();
    check('появившееся сообщение ленту перерисовывает',
      cli3.calls.includes('paint'), cli3.calls);
    const cli4 = mkCli(async () => ({ ok: true, status: 200,
      json: async () => ({ seq: 5, messages: [], cold: true }) }));
    cli4.LGC.seq = 5;
    await cli4.lgChatFetch();
    check('на cold опрос уходит в дочитывание хвоста (reload), а не рисует пустое',
      cli4.calls.includes('reload'), cli4.calls);
  }

  // ── Группы живьём: две формы чтения, курсоры и счётчики на группу ──────────
  // 🔴 Проверяется ЗАПУСКОМ, а не регуляркой, потому что ломается здесь не наличие слова
  // «gid», а раскладка состояния: один общий курсор на несколько групп молча прячет
  // историю и надгробия, а единая отметка «прочитано» стирает «в другой группе написали».
  // Оба отказа выглядят как «всё работает».
  console.log('\nгруппы живьём: две формы чтения, курсоры и непрочитанное на группу:');
  const GA = 'a1'.repeat(16), GB = 'b2'.repeat(16), GC = 'c3'.repeat(16);
  const say = (n, who) => ({ seq: n, installId: (who || 'b').repeat(16), nick: 'сосед',
    text: 'проба ' + n, recvAt: new Date().toISOString() });
  const grpBody = (msgs, extra) => ({ seq: msgs.length ? msgs[msgs.length - 1].seq : 0,
    gseq: 0, firstSeq: 0, cold: false, more: false, messages: msgs, gone: [], ...(extra || {}) });
  {
    // Наследуемая форма: групп нет, приёмник про личность не отвечал — запрос обязан быть
    // ровно тем, что работает сегодня. Это и есть «не сломать вкладку, которая в бою».
    const urls = [];
    const g0 = mkCli(async u => { urls.push(String(u));
      return { ok: true, status: 200, json: async () => ({ seq: 0, messages: [] }) }; });
    g0.LGC.seq = 12; g0.LGC.gseq = 3;
    await g0.lgChatFetch();
    check('без групп запрос прежней формы: since и gseq, без cur и без tail',
      /[?&]since=12(&|$)/.test(urls[0]) && /[?&]gseq=3(&|$)/.test(urls[0])
        && !/cur=/.test(urls[0]) && !/tail=/.test(urls[0]), urls[0]);
    check('без групп переключателя нет, писать есть куда',
      g0.lgChatGids().length === 0 && g0.lgChatLive() === true && g0.LGC.list.length === 0);
    check('наследуемый режим не выдумывает имя группы',
      g0.lgGroupTitle() === '' && /общего чата/.test(g0.lgChatWhere()), g0.lgChatWhere());
  }
  {
    const urls = [];
    const g = mkCli(async u => { urls.push(String(u));
      return { ok: true, status: 200, json: async () => ({ updated: 'x',
        groups: { [GA]: grpBody([say(1), say(2)]), [GB]: grpBody([say(7)]) }, unknown: [] }) }; });
    g.lgGroupsSet([{ gid: GA, title: 'Друзья' }, { gid: GB, title: 'Работа' }]);
    check('список групп нормализуется, активной становится первая',
      g.LGC.list.length === 2 && g.LGC.gid === GA, { n: g.LGC.list.length, gid: g.LGC.gid });
    check('мусор в списке групп отброшен: в путь запроса он не попадёт',
      (g.lgGroupsSet([{ gid: GA, title: 'Друзья' }, { gid: 'ZZ' }, { gid: GA },
        'нет', { gid: GB, title: 'Работа' }]), g.LGC.list.length === 2), g.LGC.list);
    await g.lgChatFetch();
    check('на ДВЕ группы уходит ОДИН запрос с картой курсоров',
      urls.length === 1 && /[?&]cur=/.test(urls[0]), urls);
    check('в карте курсоров активная группа первой, форма gid:seq:gseq',
      new RegExp(`cur=${GA}:0:0,${GB}:0:0`).test(urls[0]), urls[0]);
    check('свежая группа просит хвост (tail=1), а не восемь страниц со дна',
      /[?&]tail=1(&|$)/.test(urls[0]), urls[0]);
    check('сообщения разложены по своим группам, номера не смешались',
      g.lgG(GA).msgs.map(m => m.seq).join(',') === '1,2'
        && g.lgG(GB).msgs.map(m => m.seq).join(',') === '7',
      { a: g.lgG(GA).msgs.map(m => m.seq), b: g.lgG(GB).msgs.map(m => m.seq) });
    check('курсор у каждой группы свой',
      g.lgG(GA).seq === 2 && g.lgG(GB).seq === 7, { a: g.lgG(GA).seq, b: g.lgG(GB).seq });
    check('каждое сообщение помечено своей группой — из этого собирается адрес вложения',
      g.lgG(GA).msgs.every(m => m.gid === GA) && g.lgG(GB).msgs[0].gid === GB);
    // Живые курсоры хвоста больше не просят: приёмник отдаёт его только при since=0, но
    // лишний параметр в запросе означал бы, что клиент не понимает, что уже прочитал.
    urls.length = 0;
    await g.lgChatFetch();
    check('со живыми курсорами tail=1 больше не отправляется',
      !/tail=/.test(urls[0] || '') && new RegExp(`cur=${GA}:2:0,${GB}:7:0`).test(urls[0]),
      urls[0]);
    // ⚠️ Главное свойство переключения: курсоров оно НЕ трогает.
    const before = JSON.stringify([g.lgG(GA).seq, g.lgG(GB).seq]);
    g.lgChatGroupPick(GB);
    check('переключение группы меняет только «что нарисовано», курсоры целы',
      g.LGC.gid === GB && JSON.stringify([g.lgG(GA).seq, g.lgG(GB).seq]) === before, before);
    check('после переключения LGC.msgs и LGC.seq показывают НОВУЮ группу',
      g.LGC.seq === 7 && g.LGC.msgs.length === 1, { seq: g.LGC.seq, n: g.LGC.msgs.length });
    check('имя активной группы известно — второй признак «где я сейчас»',
      g.lgGroupTitle() === 'Работа' && /Работа/.test(g.lgChatWhere()), g.lgChatWhere());
  }
  {
    // Надгробия и обрезка — по группе. Снять номер 2 в A не имеет права тронуть номер 2 в B.
    const g = mkCli(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    g.lgGroupsSet([{ gid: GA }, { gid: GB }]);
    g.lgChatApply({ groups: { [GA]: grpBody([say(1), say(2), say(3)]),
      [GB]: grpBody([say(1), say(2)]) } });
    g.lgChatApply({ groups: { [GA]: grpBody([], { gone: [2], gseq: 5 }) } });
    check('надгробие снимает номер ТОЛЬКО в своей группе',
      g.lgG(GA).msgs.map(m => m.seq).join(',') === '1,3'
        && g.lgG(GB).msgs.map(m => m.seq).join(',') === '1,2',
      { a: g.lgG(GA).msgs.map(m => m.seq), b: g.lgG(GB).msgs.map(m => m.seq) });
    check('курсор надгробий поднялся у своей группы и не тронул чужую',
      g.lgG(GA).gseq === 5 && g.lgG(GB).gseq === 0, { a: g.lgG(GA).gseq, b: g.lgG(GB).gseq });
    g.lgChatApply({ groups: { [GB]: grpBody([], { firstSeq: 2 }) } });
    check('firstSeq режет дно своей группы, у соседней всё на месте',
      g.lgG(GB).msgs.map(m => m.seq).join(',') === '2'
        && g.lgG(GA).msgs.map(m => m.seq).join(',') === '1,3');
    // `cold` в НЕАКТИВНОЙ группе не тащит перечитывание активной: её буфер уже сброшен, и
    // следующий тик доберёт хвост тем же одним запросом.
    const t = g.lgChatApply({ groups: { [GB]: grpBody([], { cold: true, coldWhy: 'дно' }) } });
    check('cold в чужой группе сбрасывает ЕЁ буфер и не просит reload активной',
      t.cold === false && g.lgG(GB).msgs.length === 0 && g.lgG(GB).seq === 0
        && g.lgG(GA).msgs.length === 2, { t, b: g.lgG(GB).msgs.length });
  }
  {
    // Непрочитанное. Вкладка ОТКРЫТА и стоит на A: в A непрочитанного быть не может, в B —
    // обязано появиться, иначе «друг написал» теряется молча.
    const g = mkCli(async () => ({ ok: true, status: 200, json: async () => ({}) }),
      { visible: true, tabOpen: true });
    g.lgGroupsSet([{ gid: GA }, { gid: GB }]);
    g.lgChatApply({ groups: { [GA]: grpBody([say(1)]), [GB]: grpBody([say(1)]) } });
    g.lgChatApply({ groups: { [GA]: grpBody([say(2)]), [GB]: grpBody([say(2)]) } });
    check('видно ровно одну ленту: непрочитанное растёт только в НЕактивной группе',
      g.lgG(GA).unread === 0 && g.lgG(GB).unread === 1,
      { a: g.lgG(GA).unread, b: g.lgG(GB).unread });
    check('lgChatSeenNow различает группы, а не только видимость документа',
      g.lgChatSeenNow(GA) === true && g.lgChatSeenNow(GB) === false);
    // Третья группа: первую порцию она получает как ИСТОРИЮ (без бейджа), непрочитанное
    // начинается со второй — иначе первое открытие группы отзвучило бы всю её переписку.
    g.lgGroupsSet([{ gid: GA }, { gid: GB }, { gid: GC }]);
    g.lgChatApply({ groups: { [GC]: grpBody([say(1)]) } });
    check('первая порция новой группы — история: бейджа на неё нет',
      g.lgG(GC).unread === 0, g.lgG(GC).unread);
    g.lgChatApply({ groups: { [GC]: grpBody([say(2)]) } });
    check('бейдж навигации один и СУММИРУЕТ по всем группам',
      g.LGC.unread === g.lgG(GB).unread + g.lgG(GC).unread && g.LGC.unread === 2,
      { sum: g.LGC.unread, b: g.lgG(GB).unread, c: g.lgG(GC).unread });
    g.lgChatGroupPick(GB);
    check('переключился в B — гаснет ТОЛЬКО B, «в C написали» остаётся',
      g.lgG(GB).unread === 0 && g.lgG(GC).unread === 1 && g.LGC.unread === 1,
      { b: g.lgG(GB).unread, c: g.lgG(GC).unread, sum: g.LGC.unread });
    // Сеттера у LGC.unread нет НАМЕРЕННО: единая отметка «прочитано» и есть та ошибка, от
    // которой всё это заведено, — гасить можно только на группу (lgChatSeen).
    const d = Object.getOwnPropertyDescriptor(g.LGC, 'unread');
    check('у LGC.unread нет сеттера: погасить всё одним присвоением нельзя',
      !!d && typeof d.get === 'function' && d.set === undefined,
      d && { get: typeof d.get, set: typeof d.set });
    // Звук — один сигнал на тик, а не на группу.
    const g2 = mkCli(async () => ({ ok: true, status: 200, json: async () => ({ updated: 'x',
      groups: { [GA]: grpBody([say(1)]), [GB]: grpBody([say(1)]), [GC]: grpBody([say(1)]) },
      unknown: [] }) }));
    g2.lgGroupsSet([{ gid: GA }, { gid: GB }, { gid: GC }]);
    await g2.lgChatFetch();                       // первая порция — история, без звука
    const beeps = () => g2.logs.filter(l => l[0] === 'beep').length;
    g2.lgChatApply({ groups: { [GA]: grpBody([say(2)]), [GB]: grpBody([say(2)]) } });
    const t = g2.lgChatApply({ groups: { [GA]: grpBody([say(3)]), [GB]: grpBody([say(3)]) } });
    check('признак «звенеть» один на весь ответ, а не на каждую группу',
      t.beep === true && beeps() === 0, { t, beeps: beeps() });
  }
  {
    // Три пустых состояния. Проверяется РАЗЛИЧИМОСТЬ: они ведут к разным действиям.
    const g = mkCli(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    check('приёмник про личность не отвечал → чат живёт по-старому',
      g.LGC.ident === null && g.lgChatLive() === true);
    g.LGC.ident = true; g.lgGroupsSet([]);
    check('ответил, а групп ноль → «писать некуда», но это НЕ ошибка',
      g.lgChatLive() === false && g.LGC.gid === '' && !g.LGC.gap);
    g.lgGroupsSet([{ gid: GA, title: 'Друзья' }]);
    const un = g.lgChatApply({ groups: {}, unknown: [GA] });
    check('unknown от приёмника помечает группу мёртвой, а лента остаётся у себя',
      g.lgG(GA).gone === true && un.changed === true, { gone: g.lgG(GA).gone, un });
    check('мёртвую группу больше не спрашиваем — место в странице не тратится',
      g.lgChatGids().length === 0, g.lgChatGids());
    // Форма `?gid=`: не член получает 200 с пометкой, а не 401 — это отказ по праву.
    const g2 = mkCli(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    g2.LGC.ident = true; g2.lgGroupsSet([{ gid: GB }]);
    const nm = g2.lgChatApply({ gid: GB, seq: 0, messages: [], notMember: true,
      why: 'ты не в этой группе' });
    check('notMember в ответе на ?gid= читается как «этой группы больше нет»',
      g2.lgG(GB).gone === true && nm.ok === true && nm.changed === true, nm);
    // Возврат к жизни: приёмник снова знает группу (переложили конфиг, вернули в состав).
    g2.lgChatApply({ groups: { [GB]: grpBody([say(1)]) } });
    check('группа вернулась — метка снята сама, без перезагрузки страницы',
      g2.lgG(GB).gone === false && g2.lgG(GB).msgs.length === 1);
  }
  {
    // Групп больше, чем берёт приёмник (16): резать обязан клиент, и активную не терять.
    const urls = [];
    const g = mkCli(async u => { urls.push(String(u));
      return { ok: true, status: 200, json: async () => ({ groups: {}, unknown: [] }) }; });
    const many = [];
    for (let i = 0; i < 20; i++) many.push({ gid: i.toString(16).padStart(2, '0').repeat(16) });
    g.lgGroupsSet(many);
    g.lgChatGroupPick(many[19].gid);
    await g.lgChatFetch();
    // Из адресов берём именно опрос ленты: переключение группы попутно тянет её состав
    // (лица), и это отдельный запрос вне тика — счётчик опроса он не трогает.
    const chatUrl = urls.filter(u => /\/chat\?/.test(u))[0] || '';
    const list = (/cur=([^&]*)/.exec(chatUrl) || ['', ''])[1].split(',');
    check('в cur= уходит не больше 16 групп — иначе приёмник отвечает 400 на ВСЁ',
      list.length === 16, list.length);
    check('активная группа в срез попала первой, а не выпала из него',
      list[0] === `${many[19].gid}:0:0`, list[0]);
    check('состав группы тянется ВНЕ тика: опрос ленты по-прежнему один',
      urls.filter(u => /\/chat\?/.test(u)).length === 1 && g.LGC.reqs === 1,
      { chat: urls.filter(u => /\/chat\?/.test(u)).length, reqs: g.LGC.reqs });
  }
  {
    // Плоский ответ в режиме групп (приёмник прежней сборки, хаб уже новый) обязан лечь в
    // АКТИВНУЮ запись, а не потеряться: это ровно то состояние, в котором сейчас живёт нода
    // до `--migrate`.
    const g = mkCli(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    g.lgGroupsSet([{ gid: GA }]);
    const t = g.lgChatApply({ seq: 4, messages: [say(4)] });
    check('плоский ответ в режиме групп ложится в активную группу, а не пропадает',
      t.ok === true && g.lgG(GA).msgs.length === 1 && g.lgG(GA).seq === 4,
      { t, n: g.lgG(GA).msgs.length });
    check('ответ не той формы (ни groups, ни messages) — это «ручка ответила не тем»',
      g.lgChatApply({ ok: true }).ok === false);
  }
  {
    // Ручка «своя запись» решает РЕЖИМ, и три её исхода различаются. Ошибка здесь стоит
    // либо «чат не отвечает» на живом приёмнике, либо приглашения вступить у того, кто в
    // группе уже состоит.
    const g = mkCli(async u => {
      if (/\/league\/me$/.test(String(u))) {
        return { ok: true, status: 200, json: async () => ({ ok: true, memberId: 'm0',
          groups: [{ gid: GA, title: 'Друзья' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ groups: {}, unknown: [] }) };
    });
    check('ручка /me ответила — режим групп, список взят из неё',
      await g.lgChatMe() === true && g.LGC.ident === true && g.LGC.gid === GA,
      { ident: g.LGC.ident, gid: g.LGC.gid });
    const g2 = mkCli(async () => ({ ok: false, status: 404,
      json: async () => ({ not_found: true }) }));
    check('ручки /me нет — это НЕ «групп нет», а наследуемый режим: чат работает как сегодня',
      await g2.lgChatMe() === false && g2.LGC.ident === false
        && g2.lgChatLive() === true, { ident: g2.LGC.ident, live: g2.lgChatLive() });
    // 🔴 Замер на живом :8200 (сборка хаба без этой ручки): маршрут общего обзора лиги ловит
    // запрос ПРЕФИКСОМ, поэтому `GET /league/me` отвечает 200 и телом `{ me, peers, receiver }`.
    // Поверив коду 200, вкладка решила бы «личность есть, групп ноль» и погасила бы поле
    // ввода поверх РАБОТАЮЩЕГО чата. Признак настоящего /me — memberId и массив groups.
    const g4 = mkCli(async () => ({ ok: true, status: 200, json: async () => ({
      me: { nick: 'WormAlien', installId: '0123456789abcdef' }, peers: [],
      receiver: { configured: true } }) }));
    check('общий обзор лиги, прилетевший на /me по префиксу, за личность НЕ принимается',
      await g4.lgChatMe() === false && g4.LGC.ident === false
        && g4.lgChatLive() === true && g4.LGC.list.length === 0,
      { ident: g4.LGC.ident, live: g4.lgChatLive(), n: g4.LGC.list.length });
    const g3 = mkCli(async () => { throw new Error('сеть'); });
    g3.LGC.ident = true; g3.lgGroupsSet([{ gid: GA }]);
    check('запрос /me не ушёл — прежнее знание сохраняется, режим не переключается',
      await g3.lgChatMe() === true && g3.LGC.ident === true && g3.LGC.list.length === 1);
    // ── Сегодняшний :8200 целиком, как он отвечает СЕЙЧАС ──
    // Тела списаны с живого хаба (замер 05.09): `/me` уходит в общий обзор по префиксу, а
    // `/chat` отдаёт плоскую ленту с надгробиями. Вкладка обязана работать как работает, до
    // единой отметки: перевод данных ещё не выполнен, и это её рабочий режим, а не крайний
    // случай.
    const seen = [];
    const live = mkCli(async u => {
      seen.push(String(u));
      if (/\/league\/me$/.test(String(u))) {
        return { ok: true, status: 200, json: async () => ({
          me: { nick: 'WormAlien', installId: '0123456789abcdef' }, peers: [],
          receiver: { configured: true } }) };
      }
      return { ok: true, status: 200, json: async () => ({ seq: 9, gseq: 10, firstSeq: 9,
        cold: false, more: false,
        messages: [{ seq: 9, installId: '0123456789abcdef', nick: 'WormAlien',
          text: 'salam', recvAt: '2026-09-05T16:28:58.389Z' }],
        gone: [{ seq: 5, at: 'x', gseq: 1 }, { seq: 6, at: 'x', gseq: 2 }] }) };
    });
    await live.lgChatMe();
    await live.lgChatFetch();
    const chatAsk = seen.filter(u => /\/chat\?/.test(u))[0] || '';
    check('живой хаб сегодня: запрос остаётся плоским, лента наполняется, разрыва нет',
      /since=0&gseq=0$/.test(chatAsk) && !live.LGC.gap && live.LGC.msgs.length === 1
        && live.LGC.seq === 9 && live.LGC.gseq === 10,
      { url: chatAsk, gap: live.LGC.gap, n: live.LGC.msgs.length });
    check('живой хаб сегодня: писать есть куда, переключателя групп не появилось',
      live.lgChatLive() === true && !live.lgG().gone && live.LGC.list.length === 0
        && live.lgChatGids().length === 0);
    check('живой хаб сегодня: надгробия применяются, курсор чтения не откатывается',
      live.LGC.msgs.map(m => m.seq).join(',') === '9' && live.LGC.seq === 9);
    check('живой хаб сегодня: адрес вложения остаётся плоским (gid к сообщению не приписан)',
      live.LGC.msgs[0].gid === undefined, live.LGC.msgs[0].gid);
  }
  {
    // Приглашение. Свойство, которое здесь охраняется, — НЕ «кнопка есть», а «строка не
    // утекла»: ни в консоль, ни в тост, ни в разметку после закрытия.
    const BLOB = 'xgl1_' + 'Zm9vYmFyc2VjcmV0'.repeat(4);
    const g = mkCli(async (u, o) => {
      if (String(u).endsWith('/invite') && o && o.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ok: true, blob: BLOB,
          code: 'СЕКРЕТНЫЙКОД', id: 'f'.repeat(64), maxUses: 1,
          expires: new Date(Date.now() + 86400000).toISOString() }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, invites: [
        { id: 'f'.repeat(64), expires: new Date(Date.now() + 3600000).toISOString(),
          uses: 0, maxUses: 1, enabled: true, expired: false }] }) };
    }, { invites: true, dom: ['lg-invbox'] });
    g.LGC.ident = true;
    g.lgGroupsSet([{ gid: GA, title: 'Друзья' }]);
    await g.lgInvCreate();
    await g.lgInvList();                 // список — отдельный запрос, ждём его явно
    const html1 = g.els['lg-invbox'].innerHTML;
    check('строка приглашения показана — один раз и в разметке чата',
      html1.includes(BLOB) && /показана один раз/.test(html1), html1.slice(0, 120));
    check('рядом сказано честно: сутки, одноразовое, передавать в личку',
      /живёт сутки/.test(html1) && /одноразовое/.test(html1)
        && /не в общий чат и не в репозиторий/.test(html1));
    check('сказано и то, что приглашающий отдаёт: недавнюю переписку группы',
      /недавнюю переписку группы/.test(html1));
    check('есть кнопка копирования и кнопка «убрать»',
      /id="lg-invcopy"/.test(html1) && /id="lg-invhide"/.test(html1));
    // 🔴 Ни один журнал не должен содержать ни блоб, ни голый код.
    const leaked = g.logs.filter(l => l[0] !== 'clip')
      .filter(l => JSON.stringify(l).includes(BLOB) || JSON.stringify(l).includes('СЕКРЕТНЫЙКОД'));
    check('строка приглашения не попала ни в console, ни в toast', leaked.length === 0, leaked);
    // Копирование берёт строку из состояния и никуда её больше не пишет.
    g.LGC.inv = null;
    g.lgInvPaint();
    const html2 = g.els['lg-invbox'].innerHTML;
    check('после «убрать» строки в разметке НЕ остаётся',
      !html2.includes(BLOB) && !html2.includes('СЕКРЕТНЫЙКОД'), html2.slice(0, 160));
    check('список своих непогашенных остаётся и даёт погасить',
      /data-invrm="f{64}"/.test(html2) && /погасить/.test(html2), html2.slice(0, 200));
    // Ручки ещё нет в сборке хаба — отказ обязан это назвать, а не сказать «готово».
    const g2 = mkCli(async () => ({ ok: false, status: 404,
      json: async () => ({ not_found: true }) }), { invites: true, dom: ['lg-invbox'] });
    g2.LGC.ident = true;
    g2.lgGroupsSet([{ gid: GA }]);
    await g2.lgInvCreate();
    check('нет ручки приглашений — сказано «нужен рестарт», а не «выдано»',
      !g2.LGC.inv && /нужен рестарт/.test(g2.LGC.invErr), g2.LGC.invErr);
    check('поле «вставь приглашение» подписано и просит именно строку xgl1_',
      /id="lg-joinv"/.test(g2.lgJoinHtml()) && /aria-label="Строка приглашения/.test(g2.lgJoinHtml())
        && /xgl1_/.test(g2.lgJoinHtml()));
  }

  // ── Склейка доски по rid ──────────────────────────────────────────────────
  // 🔴 `installId` из публичной выдачи исчез. Вкладка, продолжающая искать «себя» и лица по
  // нему, не падает — она молча рисует доску без лиц и без «это ты». Поэтому проверяется
  // запуском настоящих lgRows/lgLabels/lgFace, а не наличием слова `rid` в файле.
  console.log('\nсклейка доски по rid (настоящие lgRows / lgLabels / lgFace):');
  let brd = null, brdErr = '';
  try {
    const brdSrc = HTML.slice(HTML.indexOf('// ── Склейка доски'),
      HTML.indexOf('// Ряды соседей выравниваем ПО КЛЮЧАМ'));
    brd = new Function('LG', 'LGC', 'lgTotal',
      `${brdSrc}\nreturn { lgRows, lgLabels, lgFace, lgNm };`);
  } catch (e) { brdErr = e.message; }
  check('блок склейки доски вырезается и исполняется вне браузера', !!brd, brdErr);
  if (brd) {
    const AV = 'data:image/webp;base64,AAAA';
    const LGst = { data: { me: { installId: 'a'.repeat(16), nick: 'WormAlien', avatar: AV,
      tot: { tokW: 9 } },
      peers: [{ rid: 'd1d1d1d1', nick: 'Друг', tot: { tokW: 5 } },
        { rid: 'e2e2e2e2', nick: 'WormAlien', tot: { tokW: 3 } }] } };
    // Состав группы — единственный источник лиц: в публичной выдаче их больше нет.
    const LGCst = { g: { [GA]: { mem: { byRid: { d1d1d1d1: { avatar: AV, ver: '1.2.3',
      installId: 'b'.repeat(16), nick: 'Друг' } }, byId: {} } } } };
    const api = brd(LGst, LGCst, p => Number((p.tot || {}).tokW) || 0);
    const rows = api.lgRows();
    check('строки собраны и своя помечена без installId в чужих строках',
      rows.length === 3 && rows[0].isMe === 1
        && rows.slice(1).every(p => p.installId === undefined),
      rows.map(p => [p.nick, !!p.isMe]));
    const friend = rows.find(p => p.rid === 'd1d1d1d1');
    check('лицо и версия сборки взяты из состава группы по rid',
      friend.avatar === AV && friend.ver === '1.2.3', { av: !!friend.avatar, ver: friend.ver });
    // 🪤 Совпадение ников: без суффикса выдать себя за друга НА ДОСКЕ бесплатно.
    const twin = rows.find(p => p.rid === 'e2e2e2e2');
    check('при совпадении ников к нику дописан различающий хвост rid',
      twin.label === 'WormAlien · e2e2' && twin.dup === true, twin.label);
    check('своя строка тоже помечена — иначе непонятно, какая из двух ты',
      rows[0].label === 'WormAlien · aaaa', rows[0].label);
    check('нестолкнувшийся ник остаётся как есть, без хеша в подписи',
      friend.label === 'Друг' && friend.dup === false, friend.label);
    check('подпись берётся из label, а инициалы кружка — из ника',
      api.lgNm(twin) === 'WormAlien · e2e2' && api.lgNm({ nick: 'X' }) === 'X');
    // Ответ ручки мутировать нельзя: из него считается всё остальное на вкладке.
    check('строки — КОПИИ: ответ ручки не испорчен подписью и лицом',
      LGst.data.peers[0].label === undefined && LGst.data.peers[0].avatar === undefined);
    // Наследуемый ответ (с installId и лицом прямо в срезе) обязан работать как раньше.
    const LG2 = { data: { me: { installId: 'a'.repeat(16), nick: 'Я', tot: { tokW: 9 } },
      peers: [{ installId: 'c'.repeat(16), nick: 'Старый', avatar: AV, tot: { tokW: 1 } }] } };
    const rows2 = brd(LG2, { g: {} }, p => Number((p.tot || {}).tokW) || 0).lgRows();
    check('наследуемая выдача с installId и лицом в срезе рисуется как раньше',
      rows2[1].avatar === AV && rows2[1].label === 'Старый');
    // Свой `rid` в срезе не приезжает (соль знает только приёмник), зато он лежит в составе
    // группы рядом с нашим `installId`. Без этого шага суффикс своей строки считался бы от
    // `installId`, то есть у друзей я помечен одним хвостом, а у себя другим.
    const LG3 = { data: { me: { installId: 'a'.repeat(16), nick: 'Двойник', tot: { tokW: 9 } },
      peers: [{ rid: 'fedc9876', nick: 'Двойник', tot: { tokW: 1 } }] } };
    const rows3 = brd(LG3, { g: { [GA]: { mem: { byRid: {},
      byId: { ['a'.repeat(16)]: { rid: 'abcd1234' } } } } } },
      p => Number((p.tot || {}).tokW) || 0).lgRows();
    check('свой rid берётся из состава группы — хвост совпадает с тем, что видят друзья',
      rows3[0].rid === 'abcd1234' && rows3[0].label === 'Двойник · abcd', rows3[0].label);
    // 🪤 Ники и хеши приезжают с чужих машин и становятся КЛЮЧАМИ карт. Ключ `__proto__` на
    // обычном объекте меняет не запись, а прототип карты — и подсчёт совпадений начинает
    // возвращать что попало. Карты заведены без прототипа, это и проверяется.
    const LG4 = { data: { me: { installId: 'a'.repeat(16), nick: '__proto__', tot: { tokW: 9 } },
      peers: [{ rid: 'a9a9a9a9', nick: '__proto__', tot: { tokW: 1 } },
        { rid: 'b8b8b8b8', nick: 'Обычный', tot: { tokW: 0 } }] } };
    const rows4 = brd(LG4, { g: {} }, p => Number((p.tot || {}).tokW) || 0).lgRows();
    check('ник «__proto__» считается как обычная строка, а не ломает подсчёт совпадений',
      rows4[0].dup === true && rows4[1].dup === true
        && rows4[2].dup === false && /__proto__ · /.test(rows4[1].label),
      rows4.map(p => [p.label, p.dup]));
  }

  // ── Разметка вложения живьём ───────────────────────────────────────────────
  // Тот же приём, что с лентой: исполняем НАСТОЯЩИЙ lgAttHtml с НАСТОЯЩИМ lgEsc из файла.
  // Регулярка «в файле есть lgEsc» не поймала бы главного: доезжает ли до разметки та
  // форма ответа, которую реально отдаёт приёмник, и что происходит с кавычкой в имени.
  console.log('\nразметка вложения живьём (настоящий lgAttHtml с настоящим lgEsc):');
  let att = null, attErr = '';
  try {
    const escSrc = HTML.slice(HTML.indexOf('const lgEsc = s =>'), HTML.indexOf('const lgLab = '));
    const kbSrc = (HTML.match(/const lgKb = [^\n]*\n/) || [''])[0];
    const attSrc = HTML.slice(HTML.indexOf('// ── Вложение в строке ленты ─'),
      HTML.indexOf('function lgChatRow('));
    att = new Function(`${escSrc}${kbSrc}${attSrc}`
      + '\nreturn { lgAttHtml, lgAttExt, lgAttKind, lgChatAtt };')();
  } catch (e) { attErr = e.message; }
  check('блок вложения вырезается и исполняется вне браузера', !!att, attErr);
  if (att) {
    // Ровно та форма, которую отдаёт handleChatFeed настоящего приёмника: поля `ext` в
    // ней НЕТ, есть `url`, `kind` и `mime`. Клиент, читающий только `ext`, покажет
    // голосовое битой картинкой — и увидят это люди, а не тест.
    const hVoice = att.lgAttHtml({ seq: 5, att: { url: '/chat/att/5.webm', bytes: 93000,
      kind: 'audio', mime: 'audio/webm', dur: 34 } }, 'сосед');
    check('голосовое из НАСТОЯЩЕЙ выдачи приёмника рисуется плеером, а не картинкой',
      /<audio/.test(hVoice) && /preload="none"/.test(hVoice) && !/<img/.test(hVoice)
        && /att\/5\.webm/.test(hVoice), hVoice.slice(0, 160));
    check('длительность стоит текстом (0:34), а не отдана плееру',
      /0:34/.test(hVoice) && /lgvm/.test(hVoice));
    const hImg = att.lgAttHtml({ seq: 6, att: { url: '/chat/att/6.webp', bytes: 3000,
      kind: 'image', mime: 'image/webp' } }, 'сосед');
    check('картинка по-прежнему картинка (ветка не сломана новыми видами)',
      /<img class="lgshot"/.test(hImg) && !/<audio/.test(hImg) && /att\/6\.webp/.test(hImg));
    // Имя пришло от другого человека. В этом проекте XSS через чужое значение в разметке
    // уже был, поэтому проверяется не «есть lgEsc», а что кавычка не вышла из атрибута.
    const evil = 'скилл" onload="alert(1)>.md';
    const hFile = att.lgAttHtml({ seq: 7, att: { url: '/chat/att/7.md', bytes: 1200,
      kind: 'file', mime: 'application/octet-stream', name: evil } }, 'сосед');
    check('имя файла с кавычкой не выходит из атрибута download',
      /download="скилл&quot; onload=&quot;alert\(1\)&gt;\.md"/.test(hFile)
        && !/onload="alert/.test(hFile), hFile.slice(0, 240));
    check('файл — это скачивание: ни картинки, ни плеера, ни отрисованного содержимого',
      !/<img/.test(hFile) && !/<audio/.test(hFile) && /download=/.test(hFile)
        && /<pre class="lgtxt"[^>]*hidden><\/pre>/.test(hFile));
    check('у текстового расширения есть кнопка предпросмотра, у прочих её нет',
      /data-txt="7"/.test(hFile)
        && !/data-txt=/.test(att.lgAttHtml({ seq: 8, att: { url: '/chat/att/8.zip',
          bytes: 10, kind: 'file', mime: 'application/octet-stream', name: 'a.zip' } }, 'x')));
    // Чужой `url` в src не попадает НИКОГДА: путь собирается из номера и расширения.
    const hEvil = att.lgAttHtml({ seq: 9, att: { url: 'https://evil.example/x.webp" onerror="alert(1)',
      bytes: 10, kind: 'image', mime: 'image/webp' } }, 'сосед');
    check('чужой адрес вложения в src не попадает — путь собран из номера',
      /src="\/__switch\/api\/league\/chat\/att\/9\.webp"/.test(hEvil)
        && !/evil\.example/.test(hEvil) && !/onerror/.test(hEvil), hEvil.slice(0, 200));
    check('расширение из мусорного поля ext не уезжает в путь',
      att.lgAttExt({ att: { ext: '../../secret', url: '/chat/att/9.webp' } }) === 'webp',
      att.lgAttExt({ att: { ext: '../../secret', url: '/chat/att/9.webp' } }));
    check('mime «constructor» не превращается в расширение (Map, а не объект)',
      att.lgAttExt({ att: { mime: 'constructor', url: '/chat/att/9.md' } }) === 'md',
      att.lgAttExt({ att: { mime: 'constructor', url: '/chat/att/9.md' } }));
    // ── Адрес вложения: с группой и без ──
    // 🔴 Приёмник перевёл вложения в `att/<gid>/<seq>.<ext>`. Клиент, продолжающий собирать
    // плоский путь, делает 404 из КАЖДОЙ картинки — и это тот отказ, который выглядит как
    // «у меня всё сломалось», а не как «поменялся адрес». Плоская форма обязана продолжать
    // работать: перевод данных ещё не выполнен, и сегодня журнал именно плоский.
    const GG = 'a1'.repeat(16);
    check('без группы адрес прежний, плоский — сегодняшняя лента не ломается',
      att.lgChatAtt({ seq: 12, att: { bytes: 1, ext: 'webp' } })
        === '/__switch/api/league/chat/att/12.webp',
      att.lgChatAtt({ seq: 12, att: { bytes: 1, ext: 'webp' } }));
    check('с группой в адрес входит она — иначе после перехода каждая картинка 404',
      att.lgChatAtt({ seq: 12, gid: GG, att: { bytes: 1, ext: 'webp' } })
        === `/__switch/api/league/chat/att/${GG}/12.webp`,
      att.lgChatAtt({ seq: 12, gid: GG, att: { bytes: 1, ext: 'webp' } }));
    check('негодная группа в путь не попадает — собирается плоский адрес',
      att.lgChatAtt({ seq: 12, gid: '../../secret', att: { bytes: 1, ext: 'webp' } })
        === '/__switch/api/league/chat/att/12.webp'
        && att.lgChatAtt({ seq: 12, gid: 'ZZ'.repeat(16), att: { bytes: 1, ext: 'webp' } })
        === '/__switch/api/league/chat/att/12.webp');
    // Готовый адрес хаба берём только по белому списку, и он знает обе формы.
    const okFlat = `/__switch/api/league/chat/att/3.webp`;
    const okGrp = `/__switch/api/league/chat/att/${GG}/3.webp`;
    check('белый список адресов пропускает обе формы: с группой и без',
      att.lgChatAtt({ seq: 3, att: { bytes: 1, url: okFlat } }) === okFlat
        && att.lgChatAtt({ seq: 3, att: { bytes: 1, url: okGrp } }) === okGrp);
    check('адрес приёмника (без префикса хаба) в src не уезжает — путь пересобирается',
      att.lgChatAtt({ seq: 3, gid: GG, att: { bytes: 1, ext: 'webp',
        url: `/chat/att/${GG}/3.webp` } }) === okGrp);
    const hGrp = att.lgAttHtml({ seq: 4, gid: GG, att: { url: `/chat/att/${GG}/4.webp`,
      bytes: 3000, kind: 'image', mime: 'image/webp' } }, 'сосед');
    check('в разметке картинки стоит адрес с группой',
      new RegExp(`src="/__switch/api/league/chat/att/${GG}/4\\.webp"`).test(hGrp),
      hGrp.slice(0, 160));
  }

  // ── Запись живьём ─────────────────────────────────────────────────────────
  // Здесь исполняется НАСТОЯЩИЙ блок записи с поддельными MediaRecorder и getUserMedia.
  // Регулярка «в файле есть стоп по байтам» ничего не доказывает: ограда живёт только при
  // заданной нарезке, а «промис не разрешился никогда» вообще не выражается текстом.
  console.log('\nзапись живьём (настоящий lgVoiceStart с поддельным рекордером):');
  const constSrc = HTML.slice(HTML.indexOf('// ── Голосовое. Числа не выбираются'),
    HTML.indexOf('const LGC_MUTE_KEY'));
  const voiceSrc = HTML.slice(HTML.indexOf('// ── Голосовое: проигрывание ─'),
    HTML.indexOf('// ── Отправка ─'));
  // Заглушка DOM: полоса записи и кнопка микрофона зовутся по id, содержимое неважно.
  const stubEl = () => ({ hidden: false, textContent: '', className: '', title: '', disabled: false,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, querySelector: () => null, closest: () => null });
  class FakeMR {
    constructor(stream, opts) { this.stream = stream; this.opts = opts; this.chunks = 0; FakeMR.last = this; }
    static isTypeSupported() { return true; }
    start(ms) { this.timeslice = ms; this.started = true; }
    stop() { this.stopped = (this.stopped || 0) + 1; if (this.onstop) this.onstop(); }
    feed(bytes) { this.chunks++; this.ondataavailable({ data: new Blob(['x'.repeat(bytes)]) }); }
  }
  const mkVoice = nav => {
    const log = { errs: [], toasts: [], att: null };
    const api = new Function('LGC', 'document', 'navigator', 'window', 'location',
      'MediaRecorder', 'Blob', 'URL', 'toast', 'lgChatErr', 'lgB64', 'lgChatAttPut',
      'lgKb', 'lgSecs', 'setTimeout', 'setInterval', 'clearInterval',
      `${constSrc}${voiceSrc}`
      + '\nreturn { lgVoiceStart, lgVoiceStop, lgVoiceCancel, lgVoiceMime, lgVoiceNoMic, LGC };')(
      { rec: null, sending: false, asking: false, gap: null, att: null },
      { getElementById: stubEl, querySelector: () => null },
      nav, { isSecureContext: true, MediaRecorder: FakeMR }, { origin: 'http://localhost:8200', port: '8200' },
      FakeMR, Blob, { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      (t) => log.toasts.push(String(t)), (t) => log.errs.push(String(t)),
      async () => 'AAA', a => { log.att = a; }, n => n + ' Б', n => String(n),
      // Таймер потолка ожидания срабатывает СРАЗУ: иначе тест ждал бы минуту.
      fn => { fn(); return 1; }, () => 2, () => {}
    );
    api.log = log;
    return api;
  };
  const track = { stop() { this.stopped = true; } };
  const okNav = { mediaDevices: { getUserMedia: async c => { okNav.want = c; return { getTracks: () => [track] }; } } };
  const v = mkVoice(okNav);
  await v.lgVoiceStart();
  check('рекордер создан с явным битрейтом 24000, webm/opus и МОНО',
    !!FakeMR.last && FakeMR.last.opts.audioBitsPerSecond === 24000
      && FakeMR.last.opts.mimeType === 'audio/webm;codecs=opus'
      && (okNav.want || {}).audio.channelCount === 1,
    { opts: FakeMR.last && FakeMR.last.opts, want: okNav.want });
  check('нарезка задана (start(1000)) — значит вес известен ПО ХОДУ записи',
    FakeMR.last.timeslice === 1000, FakeMR.last.timeslice);
  // Кормим куски по 3 КБ (реальный размер при 24 кбит/с) и смотрим, остановится ли запись
  // САМА, не дожидаясь таймера, и уцелеет ли записанное.
  let fed = 0;
  for (let i = 0; i < 400 && !FakeMR.last.stopped; i++) { FakeMR.last.feed(3000); fed++; }
  await new Promise(r => setImmediate(r));
  check('ограда по байтам ЖИВАЯ: запись остановилась сама, не по таймеру',
    FakeMR.last.stopped >= 1 && fed > 100 && fed < 200, { fed, stopped: FakeMR.last.stopped });
  check('записанное уцелело и легло в превью: 90 % — это запас, а не потеря',
    !!v.log.att && v.log.att.kind === 'audio' && v.log.att.bytes <= 512 * 1024
      && v.log.att.bytes > 400 * 1024 && v.log.att.dur >= 1,
    v.log.att && { kind: v.log.att.kind, bytes: v.log.att.bytes, dur: v.log.att.dur });
  check('дорожки потока погашены — индикатор записи в браузере не остался горящим',
    track.stopped === true);
  // 🔴 Шторку закрыли крестиком: промис не разрешится и не отклонится НИКОГДА.
  let late = null;
  const deafNav = { mediaDevices: { getUserMedia: () => new Promise(ok => { late = ok; }) } };
  const v2 = mkVoice(deafNav);
  await v2.lgVoiceStart();
  check('молчание в ответ на запрос микрофона не вешает кнопку — есть потолок ожидания',
    v2.log.errs.length === 1 && /не дождался ответа/.test(v2.log.errs[0])
      && v2.LGC.asking === false && v2.LGC.rec === null, v2.log.errs);
  check('в тексте про молчание сказано, что крестик — это не «нет», и назван адрес',
    /не «нет»/.test(v2.log.errs[0] || '') && /localhost:8200/.test(v2.log.errs[0] || ''));
  const lateTrack = { stop() { this.stopped = true; } };
  if (late) late({ getTracks: () => [lateTrack] });
  await new Promise(r => setImmediate(r));
  check('опоздавший поток погашен: разрешение пришло после отказа ждать',
    lateTrack.stopped === true, lateTrack);
  // Заблокированный источник: шторки не будет вообще, и спрашивать её бессмысленно.
  let asked = 0;
  const denyNav = { permissions: { query: async () => ({ state: 'denied' }) },
    mediaDevices: { getUserMedia: () => { asked++; return new Promise(() => {}); } } };
  const v3 = mkVoice(denyNav);
  await v3.lgVoiceStart();
  check('при заблокированном микрофоне шторка не запрашивается вовсе',
    asked === 0 && v3.log.errs.length === 1 && /адресной строке/.test(v3.log.errs[0]),
    { asked, errs: v3.log.errs });

  console.log('\nсинтаксис страницы (node --check по каждому inline-блоку):');
  const blocksDir = path.join(TMP, 'blocks');
  fs.mkdirSync(blocksDir, { recursive: true });
  let blocks = 0, broken = [];
  const reScript = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  for (let m2; (m2 = reScript.exec(HTML)) !== null;) {
    if (/\bsrc=/.test(m2[1] || '')) continue;   // внешний файл, тела здесь нет
    blocks++;
    const at = HTML.slice(0, m2.index).split('\n').length;
    const f = path.join(blocksDir, `b${blocks}.js`);
    fs.writeFileSync(f, m2[2]);
    try { execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { broken.push(`строка ${at}: ${String(e.stderr || '').split('\n').slice(0, 3).join(' ')}`); }
  }
  check(`все ${blocks} inline-блока страницы разбираются как JS`, blocks > 0 && !broken.length, broken);
  // Второй DOMContentLoaded в этом файле уже ломал инициализацию: исключение в одном
  // обработчике съедало соседний. Новые обработчики вешаются в существующий поток.
  const dcl = (HTML.match(/addEventListener\('DOMContentLoaded'/g) || []).length;
  check('обработчиков DOMContentLoaded по-прежнему два, третий не завёлся', dcl === 2, dcl);

  srv.close(); stub.close(); child.kill();
  // Свои временные каталоги — можно удалять напрямую: правило про корзину о чужих данных.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\nитог: ${ok} прошло, ${bad} упало`);
  // Пауза перед выходом: libuv на Windows иначе падает ассертом на закрытии хендла
  // убитого ребёнка уже ПОСЛЕ итога — выглядит как провал теста, хотя это не он.
  await sleep(150);
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });





