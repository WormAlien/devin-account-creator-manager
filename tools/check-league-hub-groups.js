#!/usr/bin/env node
'use strict';
/**
 * check-league-hub-groups.js — регресс на ХАБ со стороны групп, личности и приглашений.
 *
 * Зачем файл существует. Приёмник лиги научился личности, группам и приватному чату по
 * группам, но раскладка данных на ноде ещё НЕ переведена (`members.json` там нет), поэтому
 * он поднят в наследуемом режиме и работает как раньше. Хаб обязан уметь ОБА контракта
 * одновременно: пока перевод не выполнен — старые формы, после него — новые, и переключение
 * не должно требовать правки хаба вообще. Проверить это глазами нельзя: половина ошибок тут
 * выглядит как «ничего не изменилось» (запрос ушёл без группы, приёмник ответил по-старому),
 * а вторая половина — как дыра, которую видно только по тексту URL, ушедшего наружу.
 *
 * Что проверяется по существу:
 *   1. АДРЕС ВЛОЖЕНИЯ. `/chat/att/<gid>/<seq>.<ext>` и наследуемый `/chat/att/<seq>.<ext>`.
 *      В путь к приёмнику попадают ТОЛЬКО `gid` из 32 hex, результат `Number(seq)` и
 *      расширение из белого списка [a-z0-9]{1,8}. Каждая попытка обхода каталога проверяется
 *      фактически — по тому, что ушло в сеть, а не рассуждением о регулярке.
 *   2. ЧТЕНИЕ. Две формы: `?gid=` и `?cur=<gid>:<seq>:<gseq>[,…]`, плюс `tail=1` и `before=`.
 *      Курсоры и карта ПЕРЕСОБИРАЮТСЯ из разобранных чисел, строка из браузера в запрос не
 *      попадает. Ответ приёмника хаб не пересобирает и новых полей не досочиняет.
 *   3. УДАЛЕНИЕ. Группа проброшена во всех трёх ветвях, `installId` ставит хаб, `force=1`
 *      доезжает. Отсутствие группы — не свой 400, а проброс: в наследуемом режиме это
 *      единственная законная форма.
 *   4. НОВЫЕ РУЧКИ. `/me`, `/peers`, `/invite`, `/join`, `/group/*` — метод и путь наружу,
 *      охрана источника на каждой записи, пределы тела, белый список полей.
 *   5. СТРОКА ПРИГЛАШЕНИЯ собирается ХАБОМ (`xgl1_…` из `url` и `pin` конфига) и разбирается
 *      настоящим приёмником — это проверяется сквозняком, а не сравнением строк.
 *   6. СЕКРЕТЫ. Ни ключ приёмника, ни код приглашения, ни блоб, ни отпечаток не попадают в
 *      лог; в ответ браузеру уезжает только то, что человек передаёт другу.
 *   7. CORS. Wildcard снят с `/chat` и `/chat/att/*` и остался на общем обзоре лиги.
 *
 * Как: текст лигового блока вырезается из transparent-proxy.js и исполняется в песочнице,
 * ручки поднимаются мини-сервером с ТЕМИ ЖЕ строками маршрутизации, а на другом конце
 * работают ДВА настоящих league-receiver.js — один на прежней раскладке, второй на
 * переведённой (свой временный каталог, свои `members.json` и `groups.json`). Плюс
 * заглушка, которая только записывает, что именно у неё спросили. Живой :8200 не трогается
 * и не перезапускается, живой приёмник на ноде — тоже, `--migrate` не запускается.
 *
 * Запуск: node tools/check-league-hub-groups.js       (exit 1 = хаб сломан)
 *         HUBGROUPS_MUTANT=1 — прогон без раздела мутаций (так его зовёт сам себя родитель)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROUTING = path.join(__dirname, '..', 'routing');
// Источник хаба — параметром окружения, как в check-league-chat.js. Нужно ровно для МУТАЦИЙ:
// «ослабь предикат — тест обязан покраснеть» иначе требовало бы правки живого
// transparent-proxy.js, с которым одновременно работают другие агенты.
const SRC_FILE = process.env.LEAGUE_SRC || path.join(ROUTING, 'transparent-proxy.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const RECEIVER = path.join(ROUTING, 'league-receiver.js');
const MUTANT = process.env.HUBGROUPS_MUTANT === '1';

const from = SRC.indexOf('const HUB_IDENTITY_FILE');
const to = SRC.indexOf('async function handleFinanceHistory');
if (from < 0 || to < 0 || to < from) {
  console.error('не нашёл блок лиги в transparent-proxy.js');
  process.exit(1);
}
const block = SRC.slice(from, to);

let ok = 0, bad = 0;
const failed = [];
const check = (name, cond, got) => {
  if (cond) { ok++; console.log(`  ✅ ${name}`); }
  else {
    bad++; failed.push(name);
    console.log(`  ❌ ${name}${got === undefined ? '' : ` — получено ${JSON.stringify(got)}`}`);
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Валидный контейнер webp нужной длины: хаб картинку не декодирует, он смотрит ровно на
// магию и на длину, а приёмник — на ту же сигнатуру.
const mkWebp = n => {
  const b = Buffer.alloc(Math.max(16, n), 0x61);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  return b;
};
// Файл БЕЗ сигнатуры: ни один формат белого списка так не начинается, значит это
// «произвольный файл», и его единственный законный путь наружу — скачивание.
const mkFile = (head, n) => Buffer.concat([Buffer.from(head, 'utf8'),
  Buffer.alloc(Math.max(0, (n || 400) - Buffer.byteLength(head)), 0x20)]);

// Копии настоящих помощников хаба: песочница получает их параметрами, подделка здесь
// исказила бы проверку. Списаны с transparent-proxy.js один в один.
function jsonRes(res, code, body) {
  if (res.writableEnded) return;
  if (res.headersSent) { res.end(JSON.stringify(body)); return; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
// 🔴 Настоящий `readJsonBody` с пределом: без него не проверить ни 413, ни то, что предел
// стоит ДО разбора. Логика та же, что в хабе (заявленная длина + фактический счёт).
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const max = Number(maxBytes) > 0 ? Number(maxBytes) : 0;
    const chunks = [];
    let size = 0, done = false;
    const tooBig = () => { const e = new Error(`тело больше ${Math.round(max / 1024)} КБ`); e.httpStatus = 413; return e; };
    const declared = Number((req.headers || {})['content-length']);
    if (max && Number.isFinite(declared) && declared > max) { done = true; return reject(tooBig()); }
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (max && size > max) { done = true; return reject(tooBig()); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
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
  'handleLeagueAtt', 'handleLeague', 'leagueApiRoute', 'leagueConfig', 'hubIdentity',
  'leaguePeers', 'LEAGUE_PEERS_FILE', 'LEAGUE_API_BASE',
  // Предикаты и сборщики — НАПРЯМУЮ, а не только сквозняком: через сеть видно лишь
  // последствия, а здесь важны сами правила.
  'leagueGidOk', 'leagueAttPath', 'leagueAttExtOk', 'leagueInviteBlob', 'leagueBlobHint',
  'leagueBodyPick', 'leagueJoinReady'].join(', ');

// Песочница: свой `__dirname` (значит свои hub-identity.json / league-config.json) и
// НАСТОЯЩИЕ журналы на чтение. `LISTEN_PORT` объявлен в transparent-proxy.js ВЫШЕ вырезаемого
// блока, а удаление им пользуется как базой разбора URL — подставляем то же число 8200.
function mkHub(dir) {
  return new Function(
    'fs', 'path', 'os', 'crypto', 'execFileSync', 'http', 'https', '__dirname', 'logLine', 'round2',
    'jsonRes', 'readJsonBody', 'TOKEN_USAGE_FILE', 'FINANCE_HISTORY_FILE', 'LISTEN_PORT',
    'ghLoad', 'arLoad', 'goLoad', 'tbLoad', 'xpLoad', 'jwLoad', 'skLoad', 'tsLoad', 'kkLoad',
    `${block}\nreturn { ${EXPORTS} };`
  )(
    fs, path, os, crypto, execFileSync, http, https, dir,
    m => LOGS.push(String(m)), v => Math.round(v * 100) / 100, jsonRes, readJsonBody,
    path.join(ROUTING, 'token-usage.jsonl'), path.join(ROUTING, 'finance-history.jsonl'), 8200,
    () => loadFrom('github-accounts.json'), () => loadFrom('agentrouter-sessions.json'),
    () => loadFrom('gorouter-sessions.json'), () => loadFrom('tabi-sessions.json'),
    () => loadFrom('xpeach-sessions.json'), () => loadFrom('justwoker-sessions.json'),
    () => loadFrom('seekai-sessions.json'), () => loadFrom('truesota-sessions.json'),
    () => loadFrom('kktoken-sessions.json')
  );
}
// 🔴 Мини-сервер повторяет строки маршрутизации хаба ДОСЛОВНО и в том же порядке. Порядок
// здесь и есть работающий код: вложение — подпуть `/chat`, `/chat` — подпуть `/league`,
// ручки личности стоят между чатом и общим обзором. Переставь — и `GET /league/me` начнёт
// отвечать срезом, причём молча. Наличие и порядок этих строк в живом файле проверяется
// отдельно, ниже по тексту.
function mkServer(hub) {
  return http.createServer((req, res) => {
    if (req.method === 'DELETE' && req.url.startsWith('/__switch/api/league/chat')) return hub.handleLeagueChatDelete(req, res);
    if (req.method === 'GET' && req.url.startsWith('/__switch/api/league/chat/att/')) return hub.handleLeagueAtt(req, res);
    if (req.method === 'GET' && req.url.startsWith('/__switch/api/league/chat')) return hub.handleLeagueChatGet(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/league/chat') return hub.handleLeagueChatPost(req, res);
    if (req.url.startsWith(hub.LEAGUE_API_BASE + '/') && hub.leagueApiRoute(req, res)) return;
    if (req.method === 'GET' && req.url.startsWith('/__switch/api/league')) return hub.handleLeague(req, res);
    jsonRes(res, 404, { error: 'нет такой ручки' });
  });
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
// 🪤 Порт спрашиваем у ОПЕРАЦИОННОЙ СИСТЕМЫ, а не берём случайным числом: на машине живут
// свои сервисы, и один промах давал бы прогон, где красны все сетевые проверки, потому что
// тест разговаривал с чужим процессом, ответившим 200 на `/health`.
const freePort = () => new Promise(r => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});
// Настоящий приёмник на свободном порту по HTTP: пин проверяется на TLS, а здесь проверяется
// контракт. Живой приёмник на ноде не задет.
async function startReceiver(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [RECEIVER, String(port), dataDir],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      const j = h.ok ? await h.json() : null;
      // Не «кто-то ответил 200», а именно НАШ приёмник: `installs` отдаёт только он.
      if (j && j.ok === true && typeof j.installs === 'number') return { port, child, log: () => out };
    } catch { /* поднимается */ }
  }
  child.kill();
  throw new Error('приёмник не поднялся:\n' + out);
}

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const G1 = 'a'.repeat(31) + '1';          // своя группа, я её создатель
const G2 = 'b'.repeat(31) + '2';          // вторая своя
const G3 = 'c'.repeat(31) + '3';          // чужая: меня в ней нет
const MID = '1234567890abcdef';           // 16 hex — форма memberId
const MID2 = 'fedcba0987654321';
const INVID = 'd'.repeat(64);             // 64 hex — форма id приглашения (sha256 кода)

async function main() {
  const TMP = path.join(os.tmpdir(), 'league-hubgroups-' + Date.now());
  const LEGACY = path.join(TMP, 'recv-legacy');
  const IDENT = path.join(TMP, 'recv-ident');
  const HUBDIR = path.join(TMP, 'hub');
  for (const d of [LEGACY, IDENT, HUBDIR]) fs.mkdirSync(d, { recursive: true });

  // Заглушка: приёмник, который ТОЛЬКО записывает, что у него спросили. Нужна для главного —
  // проверить текст ушедшего наружу запроса. Через настоящий приёмник его не видно: он
  // отвечает по существу, а нам важно, что именно доехало до пути и строки запроса.
  const hits = [];
  let stubStatus = 200, stubBody = { ok: true }, stubRaw = null, stubHead = null;
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hits.push({ m: req.method, u: req.url, body: Buffer.concat(chunks).toString('utf8'),
        key: String(req.headers['x-league-key'] || '') });
      if (stubRaw) { res.writeHead(stubStatus, stubHead || { 'Content-Type': 'application/octet-stream' }); return res.end(stubRaw); }
      res.writeHead(stubStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stubBody));
    });
  });
  const SPORT = await listen(stub);
  const last = () => hits[hits.length - 1] || { m: '', u: '', body: '', key: '' };

  const legacy = await startReceiver(LEGACY);
  const SECRET = fs.readFileSync(path.join(LEGACY, 'secret'), 'utf8').trim();
  const cfgFile = path.join(HUBDIR, 'league-config.json');
  const PIN = 'AB:CD:' + 'EF:'.repeat(20) + '12';   // форма из конфига: hex с двоеточиями
  const cfg = (o) => fs.writeFileSync(cfgFile, JSON.stringify({
    enabled: true, url: `http://127.0.0.1:${legacy.port}`, key: SECRET, everyMin: 10, ...o }));
  cfg();
  const hub = mkHub(HUBDIR);
  const srv = mkServer(hub);
  const HPORT = await listen(srv);
  const HUB = `http://127.0.0.1:${HPORT}/__switch/api/league`;
  const me = hub.hubIdentity();

  // Переведённая раскладка: `members.json` + `groups.json` ровно той формы, которую создаёт
  // `tools/league-migrate.js`. Токен — свой, ключом хаба он станет через конфиг.
  const TOKEN = 'tkn_' + crypto.randomBytes(18).toString('hex');
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(IDENT, 'members.json'), JSON.stringify({
    [MID]: { memberId: MID, tokenHash: sha256(TOKEN), installId: me.installId, nick: me.nick,
      groups: [G1, G2], status: 'active', createdAt: at },
    [MID2]: { memberId: MID2, tokenHash: sha256('другой токен'), installId: 'f'.repeat(16),
      nick: 'сосед', groups: [G3], status: 'active', createdAt: at },
  }, null, 2));
  fs.writeFileSync(path.join(IDENT, 'groups.json'), JSON.stringify({
    [G1]: { gid: G1, title: 'Свои', createdBy: MID, createdAt: at, members: [MID] },
    [G2]: { gid: G2, title: 'Вторая', createdBy: MID, createdAt: at, members: [MID] },
    [G3]: { gid: G3, title: 'Чужая', createdBy: MID2, createdAt: at, members: [MID2] },
  }, null, 2));
  const ident = await startReceiver(IDENT);

  const useLegacy = () => cfg();
  const useIdent = () => cfg({ url: `http://127.0.0.1:${ident.port}`, key: TOKEN, pin: PIN });
  const useStub = (o) => cfg({ url: `http://127.0.0.1:${SPORT}`, ...o });

  console.log(`\nприёмник наследуемый :${legacy.port}, переведённый :${ident.port},`
    + ` заглушка :${SPORT}, ручки хаба :${HPORT}`);
  console.log(`личность песочницы: ${me.nick} / ${me.installId}, участник ${MID}`);

  const jget = async (u, o) => {
    const r = await fetch(u, o); let j = null;
    try { j = await r.json(); } catch { /* не JSON */ }
    return { r, j, st: r.status };
  };
  const jbody = (u, m, body, hdrs) => jget(u, { method: m,
    headers: { 'Content-Type': 'application/json', ...(hdrs || {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  // Сырой запрос, а не fetch: `fetch` нормализует `..` в пути ещё до отправки, и проверка
  // обхода каталога через него невозможна в принципе.
  const raw = (p, hdrs) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: HPORT, path: p, method: 'GET',
      headers: hdrs || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  const rawErr = r => { try { return String(JSON.parse(r.buf.toString('utf8')).error || ''); } catch { return ''; } };
  console.log('\nмаршруты в transparent-proxy.js:');
  const R = {
    delChat: SRC.indexOf("req.method === 'DELETE' && req.url.startsWith('/__switch/api/league/chat')"),
    att: SRC.indexOf("req.url.startsWith('/__switch/api/league/chat/att/')"),
    getChat: SRC.indexOf("req.method === 'GET'  && req.url.startsWith('/__switch/api/league/chat')"),
    api: SRC.indexOf("leagueApiRoute(req, res)) return;"),
    all: SRC.indexOf("req.url.startsWith('/__switch/api/league')) return handleLeague("),
  };
  check('ручки личности и групп зарегистрированы одной строкой', R.api > 0, R);
  check('вложение проверяется РАНЬШЕ чата (в пределах GET)', R.att > 0 && R.att < R.getChat, R);
  check('ручки личности стоят ПОСЛЕ чата: `/chat` тоже начинается с `/league/`',
    R.api > R.getChat && R.api > R.delChat, R);
  check('ручки личности стоят ДО общего обзора: иначе `GET /league/me` ответит срезом',
    R.api < R.all, R);

  // ── 1. Адрес вложения ─────────────────────────────────────────────────────
  console.log('\nвложение: путь собирается из группы, числа и расширения — и больше ни из чего:');
  check('leagueAttPath: наследуемая форма без группы',
    hub.leagueAttPath('', 5, 'webp') === '/chat/att/5.webp', hub.leagueAttPath('', 5, 'webp'));
  check('leagueAttPath: форма с группой',
    hub.leagueAttPath(G1, 5, 'webp') === `/chat/att/${G1}/5.webp`, hub.leagueAttPath(G1, 5, 'webp'));
  check('leagueAttPath: номер приводится ЧИСЛОМ, а не подставляется строкой',
    hub.leagueAttPath(G1, '7', 'webp') === `/chat/att/${G1}/7.webp`);
  check('leagueGidOk: только 32 строчных hex',
    hub.leagueGidOk(G1) && !hub.leagueGidOk(G1.toUpperCase()) && !hub.leagueGidOk(G1.slice(1))
      && !hub.leagueGidOk(G1 + 'a') && !hub.leagueGidOk('../' + G1.slice(3))
      && !hub.leagueGidOk(null) && !hub.leagueGidOk(''));

  useStub(); hits.length = 0;
  stubStatus = 200; stubRaw = mkWebp(600); stubHead = { 'Content-Type': 'image/webp' };
  let g = await raw('/__switch/api/league/chat/att/5.webp');
  check('плоский адрес доезжает до приёмника как был (наследуемая раскладка)',
    hits.length === 1 && last().u === '/chat/att/5.webp', hits.map(h => h.u));
  check('и отдаётся картинкой по СИГНАТУРЕ, а не по заголовку приёмника',
    g.status === 200 && g.headers['content-type'] === 'image/webp', g.status);
  hits.length = 0;
  g = await raw(`/__switch/api/league/chat/att/${G1}/5.webp`);
  check('адрес с группой доезжает целиком: группа, номер, расширение',
    hits.length === 1 && last().u === `/chat/att/${G1}/5.webp`, hits.map(h => h.u));
  check('картинка из группы отдана картинкой', g.status === 200
    && g.headers['content-type'] === 'image/webp', g.status);
  hits.length = 0;
  g = await raw(`/__switch/api/league/chat/att/${G1}/9.png?name=../../x&mime=text/html`);
  check('в путь ушли ТОЛЬКО группа, номер и расширение: ни имени, ни заявленного типа',
    hits.length === 1 && last().u === `/chat/att/${G1}/9.png`, hits.map(h => h.u));
  check('чужие байты из группы уезжают скачиванием, а не документом',
    g.status === 200 && g.headers['content-type'] === 'application/octet-stream'
      && /^attachment; filename="9\.png"/.test(String(g.headers['content-disposition'] || '')),
    { ct: g.headers['content-type'], cd: g.headers['content-disposition'] });
  check('кеш вложения из группы — с проверкой, суточного max-age нет',
    g.headers['cache-control'] === 'no-cache', g.headers['cache-control']);
  // 🔴 Каждая попытка обхода каталога проверяется ФАКТИЧЕСКИ: код 400 И пустой список того,
  // что ушло наружу. Второе важнее первого — 400 после запроса к приёмнику защитой не был бы.
  console.log('\nобход каталога в адресе вложения: 400 и ни одного запроса наружу:');
  hits.length = 0;
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
    // Новая поверхность 05.09 — сегмент группы. Всё, что не 32 строчных hex, обязано
    // получить 400 ДО сети: иначе в путь приёмника уедет чужая строка.
    ['точки вместо группы', `/__switch/api/league/chat/att/../1.webp`],
    ['точки в группе с расширением', '/__switch/api/league/chat/att/%2e%2e/1.webp'],
    ['процентный слэш в группе', '/__switch/api/league/chat/att/%2e%2e%2f%2e%2e/1.webp'],
    ['обратные слэши в группе', '/__switch/api/league/chat/att/..\\..\\/1.webp'],
    ['нулевой байт в группе', `/__switch/api/league/chat/att/${G1.slice(0, 30)}%00/1.webp`],
    ['группа короче 32', `/__switch/api/league/chat/att/${G1.slice(1)}/1.webp`],
    ['группа длиннее 32', `/__switch/api/league/chat/att/${G1}a/1.webp`],
    ['группа ЗАГЛАВНЫМИ hex', `/__switch/api/league/chat/att/${G1.toUpperCase()}/1.webp`],
    ['группа не hex', `/__switch/api/league/chat/att/${'z'.repeat(32)}/1.webp`],
    ['пустая группа', '/__switch/api/league/chat/att//1.webp'],
    ['две группы подряд', `/__switch/api/league/chat/att/${G1}/${G2}/1.webp`],
    ['точки ПОСЛЕ годной группы', `/__switch/api/league/chat/att/${G1}/../secret.webp`],
    ['нечисловой номер внутри группы', `/__switch/api/league/chat/att/${G1}/nan.webp`],
    ['номер ноль внутри группы', `/__switch/api/league/chat/att/${G1}/0.webp`],
    ['расширение с точкой внутри группы', `/__switch/api/league/chat/att/${G1}/1.we.bp`],
    ['расширение длиннее восьми', `/__switch/api/league/chat/att/${G1}/1.abcdefghi`],
  ];
  const escaped = [], mute = [];
  for (const [why, p] of traverse) {
    // Узел может отказаться отправить такой путь сам — это тоже «не прошло», но считаем
    // отдельно: молча приравнивать отказ клиента к защите сервера нельзя.
    let st = 'узел не отправил', err = '';
    try { const r = await raw(p); st = r.status; err = rawErr(r); } catch { /* ERR_UNESCAPED_CHARACTERS и родня */ }
    if (st !== 400 && st !== 'узел не отправил') escaped.push(`${why} → ${st}`);
    // Форму пути обязан называть КАЖДЫЙ отказ, а не только первый: иначе «маршрут не доехал»
    // и «номер не разобрался» становятся неотличимы. Та же подстрока проверяется приёмкой
    // живого хаба (tools/check-after-restart.js) — файл чужой, ломать его отсюда нельзя.
    if (st === 400 && !/chat\/att/.test(err)) mute.push(`${why} → «${err}»`);
  }
  check(`ни одна из ${traverse.length} попыток обхода каталога не прошла (все 400)`,
    !escaped.length, escaped);
  check('и ни одна не доехала до приёмника', hits.length === 0, hits.map(h => h.u));
  check('каждый отказ называет форму пути (в тексте есть chat/att)', !mute.length, mute);
  // Переведённая раскладка, сквозняк: картинка в группу и обратно через настоящий приёмник.
  console.log('\nвложение сквозняком через переведённый приёмник:');
  useIdent(); stubRaw = null; stubHead = null;
  const IMG = mkWebp(2400).toString('base64');
  let x = await jbody(`${HUB}/chat`, 'POST', { gid: G1, text: 'с картинкой', att: IMG });
  check('сообщение с картинкой принято в группу', x.st === 200 && x.j.ok === true
    && x.j.gid === G1 && Number.isInteger(x.j.seq), x.j);
  const seqImg = x.j && x.j.seq;
  let feed = (await jget(`${HUB}/chat?gid=${G1}&since=0&gseq=0`)).j;
  const mImg = (feed.messages || []).find(m => m.seq === seqImg);
  check('приёмник отдал адрес вложения ВМЕСТЕ с группой',
    !!(mImg && mImg.att && mImg.att.url === `/chat/att/${G1}/${seqImg}.webp`), mImg && mImg.att);
  g = await raw(`/__switch/api/league/chat/att/${G1}/${seqImg}.webp`);
  check('вложение из своей группы отдано байтами и своим типом',
    g.status === 200 && g.headers['content-type'] === 'image/webp' && g.buf.length === 2400,
    { st: g.status, ct: g.headers['content-type'], len: g.buf.length });
  check('отпечаток приёмника проброшен наружу как ETag', /^"\d+-\d+"$/.test(String(g.headers.etag || '')),
    g.headers.etag);
  const cond = await raw(`/__switch/api/league/chat/att/${G1}/${seqImg}.webp`,
    { 'If-None-Match': g.headers.etag });
  check('условный запрос доезжает внутрь и возвращается 304, а не 502',
    cond.status === 304 && cond.buf.length === 0, cond.status);
  // 🔴 Отказ приёмника доезжает своим кодом. Это и есть «не дублируй его проверку, но и не
  // глотай его отказ»: 400 про плоский адрес, 403 про чужую группу и 404 про отсутствующий
  // файл — три разные беды, и вкладка обязана их различать.
  g = await raw(`/__switch/api/league/chat/att/${seqImg}.webp`);
  check('плоский адрес на переведённой раскладке — 400 ПРИЁМНИКА, а не наш 502',
    g.status === 400 && /групп/i.test(rawErr(g)), { st: g.status, err: rawErr(g) });
  g = await raw(`/__switch/api/league/chat/att/${G3}/1.webp`);
  check('чужая группа — 403 приёмника, а не 502 и не тихая картинка',
    g.status === 403 && /групп/i.test(rawErr(g)), { st: g.status, err: rawErr(g) });
  g = await raw(`/__switch/api/league/chat/att/${G1}/999999.webp`);
  check('нет такого вложения — 404 приёмника', g.status === 404, g.status);
  // Членство хаб НЕ дублирует: своей проверки «в группе ли я» у него нет и быть не должно —
  // список групп живёт в записи участника у приёмника, а у хаба его нет вовсе. Проверяется
  // фактом: запрос в чужую группу ОБЯЗАН уйти наружу, а отказ — приехать оттуда.
  useStub(); hits.length = 0; stubStatus = 403;
  stubBody = { error: 'ты не в этой группе' }; stubRaw = null;
  g = await raw(`/__switch/api/league/chat/att/${G3}/1.webp`);
  check('запрос в чужую группу уходит к приёмнику (решение о членстве не хабово)',
    hits.length === 1 && last().u === `/chat/att/${G3}/1.webp`, hits.map(h => h.u));
  check('и его 403 доезжает до браузера кодом 403, а не 502',
    g.status === 403 && /групп/.test(rawErr(g)), { st: g.status, err: rawErr(g) });
  stubStatus = 500; stubBody = { error: 'внутри всё сломалось' };
  g = await raw(`/__switch/api/league/chat/att/${G1}/1.webp`);
  check('а вот пятисотка приёмника — это наш 502: разница между «отказал» и «сломался»',
    g.status === 502, g.status);
  stubStatus = 200;
  // ── 2. Чтение чата ────────────────────────────────────────────────────────
  console.log('\nчтение: адресат обязателен, а курсоры пересобираются числами:');
  useStub(); stubStatus = 200; stubBody = { seq: 0, messages: [] }; hits.length = 0;
  await jget(`${HUB}/chat?since=41&gseq=7`);
  check('наследуемая форма ушла БЕЗ группы и в одной строке запроса — совместимость цела',
    last().u === '/chat?since=41&gseq=7', hits.map(h => h.u));
  await jget(`${HUB}/chat?gid=${G1}&since=41&gseq=7`);
  check('форма с группой: gid, since, gseq одной строкой',
    last().u === `/chat?gid=${G1}&since=41&gseq=7`, last().u);
  await jget(`${HUB}/chat?gid=${G1}&since=abc&gseq=${encodeURIComponent('../../secret')}`);
  check('мусор в курсорах пересобран в нули, а группа осталась группой',
    last().u === `/chat?gid=${G1}&since=0&gseq=0`, last().u);
  await jget(`${HUB}/chat?gid=${G1}&since=0&gseq=0&tail=1`);
  check('tail=1 доезжает', last().u === `/chat?gid=${G1}&since=0&gseq=0&tail=1`, last().u);
  await jget(`${HUB}/chat?gid=${G1}&since=0&gseq=0&tail=0`);
  check('tail=0 признаком не считается и наружу не уходит',
    last().u === `/chat?gid=${G1}&since=0&gseq=0`, last().u);
  await jget(`${HUB}/chat?gid=${G1}&before=97&tail=1`);
  check('before= уходит числом', last().u === `/chat?gid=${G1}&since=0&gseq=0&tail=1&before=97`, last().u);
  await jget(`${HUB}/chat?gid=${G1}&before=${encodeURIComponent('9;drop')}`);
  check('мусор в before= превращается в отсутствие параметра, а не в строку',
    last().u === `/chat?gid=${G1}&since=0&gseq=0`, last().u);
  hits.length = 0;
  x = await jget(`${HUB}/chat?gid=${G1.toUpperCase()}&since=0`);
  check('группа ЗАГЛАВНЫМИ — свой 400 хаба, до сети', x.st === 400 && hits.length === 0,
    { st: x.st, hits: hits.length });
  x = await jget(`${HUB}/chat?gid=${G1.slice(1)}`);
  check('группа короче 32 — 400 и приёмник не позван', x.st === 400 && hits.length === 0, x.j);
  x = await jget(`${HUB}/chat?gid=${encodeURIComponent('../../secret')}`);
  check('обход каталога в gid= до приёмника не доезжает', x.st === 400 && hits.length === 0, x.j);
  x = await jget(`${HUB}/chat?gid=`);
  check('пустой gid= — 400: «есть параметр, но он не группа» это не «нет параметра»',
    x.st === 400 && hits.length === 0, x.j);

  console.log('\nчтение одним запросом по всем группам (cur=):');
  stubBody = { updated: 'сейчас', groups: {}, unknown: [] }; hits.length = 0;
  await jget(`${HUB}/chat?cur=${G1}:41:7,${G2}:0:0`);
  check('карта курсоров пересобрана и ушла целиком',
    last().u === `/chat?cur=${G1}:41:7,${G2}:0:0`, last().u);
  await jget(`${HUB}/chat?cur=${G1}:0041:0007`);
  check('числа в карте нормализованы: ведущие нули не уезжают наружу',
    last().u === `/chat?cur=${G1}:41:7`, last().u);
  await jget(`${HUB}/chat?cur=${G1}:1:2&tail=1&before=5`);
  check('tail и before работают и в этой форме',
    last().u === `/chat?cur=${G1}:1:2&tail=1&before=5`, last().u);
  await jget(`${HUB}/chat?cur=${G1}:1:2&since=99&gseq=99`);
  check('since/gseq в форме cur= наружу НЕ уезжают: курсоры внутри карты',
    last().u === `/chat?cur=${G1}:1:2`, last().u);
  hits.length = 0;
  const badCur = [
    ['без двоеточий', G1],
    ['одно двоеточие', `${G1}:5`],
    ['группа не hex', `${'z'.repeat(32)}:1:1`],
    ['группа ЗАГЛАВНЫМИ', `${G1.toUpperCase()}:1:1`],
    ['группа короче 32', `${G1.slice(1)}:1:1`],
    ['отрицательный курсор', `${G1}:-1:0`],
    ['курсор не число', `${G1}:abc:0`],
    ['курсор длиннее 15 цифр', `${G1}:1234567890123456:0`],
    ['лишнее поле', `${G1}:1:2:3`],
    ['обход каталога вместо группы', '../../secret:1:1'],
    ['пустая карта', ''],
    ['только запятые', ',,,'],
    ['вторая запись битая', `${G1}:1:1,${G2}:x:1`],
  ];
  const curBad = [];
  for (const [why, v] of badCur) {
    const r = await jget(`${HUB}/chat?cur=${encodeURIComponent(v)}`);
    if (r.st !== 400) curBad.push(`${why} → ${r.st}`);
  }
  check(`все ${badCur.length} кривых карт курсоров получили 400`, !curBad.length, curBad);
  check('и ни одна не доехала до приёмника: молчаливой обрезки нет', hits.length === 0,
    hits.map(h => h.u));
  // Присланное в текст ошибки не возвращаем: ответ вкладка кладёт в разметку.
  x = await jget(`${HUB}/chat?cur=${encodeURIComponent('<img src=x onerror=alert(1)>:1:1')}`);
  check('в тексте отказа нет присланной строки', x.st === 400
    && !/onerror/.test(JSON.stringify(x.j)), x.j);

  // Сквозняк: обе формы против настоящего переведённого приёмника.
  console.log('\nчтение сквозняком через переведённый приёмник:');
  useIdent();
  x = await jget(`${HUB}/chat?gid=${G1}&since=0&gseq=0`);
  check('форма с группой: ответ приёмника с новыми полями отдан целиком',
    x.st === 200 && x.j.gid === G1 && typeof x.j.gseq === 'number'
      && typeof x.j.firstSeq === 'number' && typeof x.j.cold === 'boolean'
      && typeof x.j.more === 'boolean' && Array.isArray(x.j.gone), x.j && Object.keys(x.j));
  x = await jget(`${HUB}/chat?gid=${G3}&since=0`);
  check('чужая группа — 200 и явный notMember, а не 403 и не пустота без пояснения',
    x.st === 200 && x.j.notMember === true && x.j.messages.length === 0, x.j);
  x = await jget(`${HUB}/chat?cur=${G1}:0:0,${G2}:0:0,${G3}:0:0`);
  check('форма cur=: ответ формы {updated, groups, unknown}',
    x.st === 200 && typeof x.j.updated === 'string' && x.j.groups
      && typeof x.j.groups === 'object' && Array.isArray(x.j.unknown), x.j && Object.keys(x.j));
  check('свои группы в groups, чужая в unknown — хаб ничего не пересобирал',
    !!(x.j.groups[G1] && x.j.groups[G2]) && !x.j.groups[G3]
      && x.j.unknown.length === 1 && x.j.unknown[0] === G3,
    { keys: Object.keys(x.j.groups || {}), unknown: x.j.unknown });
  x = await jget(`${HUB}/chat?since=0&gseq=0`);
  check('без адресата на переведённой раскладке — 400 ПРИЁМНИКА (хаб дефолта не придумывает)',
    x.st === 400 && /gid|cur/.test(String((x.j || {}).error || '')), x.j);
  // ── 3. Удаление в пределах группы ─────────────────────────────────────────
  console.log('\nудаление: группа проброшена во всех трёх ветвях, installId ставит хаб:');
  useStub(); stubBody = { ok: true, removed: 1 }; hits.length = 0;
  const del = u => jget(`${HUB}${u}`, { method: 'DELETE' });
  await del(`/chat?gid=${G1}&mine=1`);
  check('«все свои» уходит с группой, своим installId и явным mine=1',
    last().u === `/chat?installId=${me.installId}&mine=1&gid=${G1}`, last().u);
  await del(`/chat?gid=${G1}&all=1`);
  check('«журнал группы целиком» уходит с all=1 и группой',
    last().u === `/chat?all=1&gid=${G1}`, last().u);
  await del(`/chat/12?gid=${G1}`);
  check('одно сообщение: номер в пути, группа и installId в запросе',
    last().u === `/chat/12?installId=${me.installId}&gid=${G1}`, last().u);
  await del(`/chat/12?gid=${G1}&force=1`);
  check('force=1 доезжает до приёмника (чужое сносится только с ним)',
    last().u === `/chat/12?installId=${me.installId}&gid=${G1}&force=1`, last().u);
  await del(`/chat?gid=${G1}&mine=1&installId=${'9'.repeat(16)}`);
  check('присланный installId игнорируется: подпись ставит ХАБ',
    last().u === `/chat?installId=${me.installId}&mine=1&gid=${G1}`, last().u);
  hits.length = 0;
  x = await del(`/chat?gid=${G1.toUpperCase()}&mine=1`);
  check('кривая группа в удалении — 400 и приёмник не позван',
    x.st === 400 && hits.length === 0, { st: x.st, hits: hits.length });
  x = await del(`/chat?gid=${encodeURIComponent('../../x')}&all=1`);
  check('обход каталога в gid= на удалении не доезжает', x.st === 400 && hits.length === 0, x.j);
  // 🪤 Совместимость: без группы запрос ОБЯЗАН уйти наружу. Свой 400 здесь сломал бы живую
  // кнопку «убрать мои» на непереведённой раскладке — единственную, которая там есть.
  hits.length = 0;
  await del('/chat?mine=1');
  check('без группы «все свои» уходит к приёмнику как раньше (совместимость)',
    last().u === `/chat?installId=${me.installId}&mine=1`, last().u);
  await del('/chat?all=1');
  check('без группы «весь журнал» уходит как раньше', last().u === '/chat?all=1', last().u);
  await del('/chat/12');
  check('без группы одно сообщение уходит как раньше',
    last().u === `/chat/12?installId=${me.installId}`, last().u);
  // Ветки-400 разбора пути остались на месте: их подробно меряет check-journal-tail.js,
  // здесь — только то, что группа их не расшатала.
  hits.length = 0;
  for (const [why, u] of [['хвостовой слэш', `/chat/5/?gid=${G1}`], ['не цифры', `/chat/abc?gid=${G1}`],
    ['без признака', `/chat?gid=${G1}`], ['mine=0', `/chat?gid=${G1}&mine=0`]]) {
    const r = await del(u);
    check(`${why} → 400 и приёмник не позван`, r.st === 400, { st: r.st });
  }
  check('ни один неразобранный путь не уехал наружу', hits.length === 0, hits.map(h => h.u));
  // Сквозняк: удаление действительно бьёт по СВОЕЙ группе и не задевает соседнюю.
  console.log('\nудаление сквозняком: границей служит группа:');
  useIdent();
  await jbody(`${HUB}/chat`, 'POST', { gid: G1, text: 'первое в G1' });
  await jbody(`${HUB}/chat`, 'POST', { gid: G2, text: 'единственное в G2' });
  const cnt = async gid => ((await jget(`${HUB}/chat?gid=${gid}&since=0`)).j.messages || []).length;
  const g2Before = await cnt(G2);
  x = await del(`/chat?gid=${G1}&mine=1`);
  check('«убрать мои» в G1 сработало и назвало группу', x.st === 200 && x.j.ok === true
    && x.j.removed > 0 && x.j.gid === G1, x.j);
  check('в G1 после этого пусто', (await cnt(G1)) === 0);
  check('в G2 не тронуто ничего: журнал у групп раздельный',
    (await cnt(G2)) === g2Before && g2Before > 0, { was: g2Before, now: await cnt(G2) });
  x = await del(`/chat?gid=${G3}&mine=1`);
  check('удаление в чужой группе — 403 приёмника, а не тихий успех', x.st === 403, x.j);
  x = await del('/chat?mine=1');
  check('без группы на переведённой раскладке — 400 приёмника', x.st === 400
    && /gid/.test(String((x.j || {}).error || '')), x.j);

  // ── 4. Новые ручки: метод и путь наружу ───────────────────────────────────
  console.log('\nручки личности, групп и приглашений: что уходит к приёмнику:');
  useStub(); stubBody = { ok: true }; hits.length = 0;
  const cases = [
    ['GET  /me', () => jget(`${HUB}/me`), 'GET', '/me'],
    ['DELETE /me', () => jget(`${HUB}/me`, { method: 'DELETE' }), 'DELETE', '/me'],
    ['GET  /peers', () => jget(`${HUB}/peers`), 'GET', '/peers'],
    ['GET  /invite', () => jget(`${HUB}/invite`), 'GET', '/invite'],
    ['POST /invite', () => jbody(`${HUB}/invite`, 'POST', { groups: [G1], ttlHours: 24, uses: 1 }),
      'POST', '/invite'],
    ['DELETE /invite/<id>', () => jget(`${HUB}/invite/${INVID}`, { method: 'DELETE' }),
      'DELETE', `/invite/${INVID}`],
    ['POST /join', () => jbody(`${HUB}/join`, 'POST', { code: 'кодик' }), 'POST', '/join'],
    ['POST /group', () => jbody(`${HUB}/group`, 'POST', { title: 'Новая' }), 'POST', '/group'],
    ['GET  /group/<gid>', () => jget(`${HUB}/group/${G1}`), 'GET', `/group/${G1}`],
    ['POST /group/<gid>/member', () => jbody(`${HUB}/group/${G1}/member`, 'POST', { memberId: MID2 }),
      'POST', `/group/${G1}/member`],
    ['DELETE /group/<gid>/member/<mid>', () => jget(`${HUB}/group/${G1}/member/${MID2}`,
      { method: 'DELETE' }), 'DELETE', `/group/${G1}/member/${MID2}`],
    ['DELETE …/member/<mid>?purge=1', () => jget(`${HUB}/group/${G1}/member/${MID2}?purge=1`,
      { method: 'DELETE' }), 'DELETE', `/group/${G1}/member/${MID2}?purge=1`],
  ];
  for (const [name, call, m, u] of cases) {
    hits.length = 0;
    const r = await call();
    check(`${name} → ${m} ${u}`, hits.length === 1 && last().m === m && last().u === u,
      { st: r.st, got: hits.map(h => `${h.m} ${h.u}`) });
  }
  check('ключ приёмника ушёл заголовком на всех ручках, а не в пути или теле',
    hits.length > 0 && last().key.length > 0 && !/x-league-key|tkn_/i.test(last().u + last().body),
    { u: last().u });
  console.log('\nформа идентификаторов в пути: 400 до сети:');
  hits.length = 0;
  const badPaths = [
    ['группа не hex в /group', `/group/${'z'.repeat(32)}`, 'GET'],
    ['группа ЗАГЛАВНЫМИ в /group', `/group/${G1.toUpperCase()}`, 'GET'],
    ['обход каталога вместо группы', `/group/${encodeURIComponent('../../secret')}`, 'GET'],
    ['группа короче 32 при добавлении', `/group/${G1.slice(1)}/member`, 'POST'],
    ['участник не 16 hex', `/group/${G1}/member/${MID2.slice(1)}`, 'DELETE'],
    ['участник ЗАГЛАВНЫМИ', `/group/${G1}/member/${MID2.toUpperCase()}`, 'DELETE'],
    ['обход каталога вместо участника', `/group/${G1}/member/${encodeURIComponent('../..')}`, 'DELETE'],
    ['приглашение короче 64', `/invite/${INVID.slice(1)}`, 'DELETE'],
    ['приглашение не hex', `/invite/${'w'.repeat(64)}`, 'DELETE'],
  ];
  for (const [why, u, m] of badPaths) {
    const r = m === 'POST' ? await jbody(`${HUB}${u}`, 'POST', {}) : await jget(`${HUB}${u}`, { method: m });
    check(`${why} → 400`, r.st === 400, { st: r.st, j: r.j });
  }
  check('ни один кривой идентификатор не уехал к приёмнику', hits.length === 0, hits.map(h => h.u));
  // Метод не к тому пути — 405, а не тихий провал мимо всей лиговой таблицы.
  for (const [why, u, m] of [['POST /me', '/me', 'POST'], ['GET /join', '/join', 'GET'],
    ['DELETE /peers', '/peers', 'DELETE'], ['GET /group (создание)', '/group', 'GET'],
    ['POST /group/<gid>', `/group/${G1}`, 'POST'],
    ['GET /group/<gid>/member', `/group/${G1}/member`, 'GET'],
    ['GET /invite/<id>', `/invite/${INVID}`, 'GET']]) {
    const r = m === 'POST' ? await jbody(`${HUB}${u}`, 'POST', {}) : await jget(`${HUB}${u}`, { method: m });
    check(`${why} → 405`, r.st === 405, { st: r.st, j: r.j });
  }
  // Общий обзор лиги при этом остался живым: он ловит `startsWith` по любому GET, и одна
  // лишняя строка в таблице выше могла бы его перехватить.
  x = await jget(`${HUB}`);
  check('общий обзор лиги отвечает срезом, а не 404 от новой таблицы',
    x.st === 200 && !!x.j && !!x.j.me && Array.isArray(x.j.peers), x.st);

  console.log('\nохрана источника на записи: браузер чужого сайта не пишет, Node пишет:');
  hits.length = 0;
  const writes = [['POST /invite', '/invite', 'POST'], ['DELETE /invite/<id>', `/invite/${INVID}`, 'DELETE'],
    ['POST /join', '/join', 'POST'], ['POST /group', '/group', 'POST'],
    ['POST /group/<gid>/member', `/group/${G1}/member`, 'POST'],
    ['DELETE /group/<gid>/member/<mid>', `/group/${G1}/member/${MID2}`, 'DELETE'],
    ['DELETE /me', '/me', 'DELETE']];
  const alien = [], own = [], plain = [];
  for (const [why, u, m] of writes) {
    // Чужой origin: `Sec-Fetch-Site` ставит браузер, из страницы его не подделать.
    let r = await jbody(`${HUB}${u}`, m, m === 'POST' ? { code: 'x', title: 'x', memberId: MID2 } : undefined,
      { 'Sec-Fetch-Site': 'cross-site' });
    if (r.st !== 403) alien.push(`${why} → ${r.st}`);
    // Свой origin — проходит.
    r = await jbody(`${HUB}${u}`, m, m === 'POST' ? { code: 'x', title: 'x', memberId: MID2 } : undefined,
      { 'Sec-Fetch-Site': 'same-origin' });
    if (r.st === 403) own.push(`${why} → ${r.st}`);
  }
  check(`все ${writes.length} записей отбивают чужой Sec-Fetch-Site кодом 403`, !alien.length, alien);
  check('и пропускают same-origin', !own.length, own);
  // 🔴 Главная оговорка ограды: наши Node-скрипты `Sec-Fetch-*` не отправляют ВООБЩЕ, и
  // ломать их этой правкой нельзя. Проверяется тем же способом, каким они и ходят — голым
  // http.request без единого браузерного заголовка.
  const nodeCall = (m, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: HPORT, path: p, method: m,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
    res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ st: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  for (const [why, u, m] of writes) {
    const r = await nodeCall(m, `/__switch/api/league${u}`,
      m === 'POST' ? { code: 'x', title: 'x', memberId: MID2 } : undefined);
    if (r.st === 403 || r.st === 415) plain.push(`${why} → ${r.st}`);
  }
  check('Node-клиент без Sec-Fetch-* и без Origin проходит на всех записях', !plain.length, plain);
  // Тело есть, а тип не JSON — 415: «простым» межсайтовым запросом такой тип быть не может,
  // поэтому требование безопасно ровно там, где тело есть.
  const ctBad = await new Promise((resolve, reject) => {
    const data = '{"title":"x"}';
    const req = http.request({ host: '127.0.0.1', port: HPORT, path: '/__switch/api/league/group',
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'Content-Length': data.length } },
    res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(data); req.end();
  });
  check('тело записи не как application/json — 415', ctBad === 415, ctBad);
  // Предел тела — тот же, что у приёмника (64 КБ на мелкие записи).
  hits.length = 0;
  x = await jbody(`${HUB}/group`, 'POST', { title: 'я'.repeat(70 * 1024) });
  check('тело больше 64 КБ — 413 и приёмник не позван', x.st === 413 && hits.length === 0,
    { st: x.st, hits: hits.length });
  x = await jbody(`${HUB}/group`, 'POST', 'не объект, а строка');
  check('тело не JSON-объект переживается без пятисотки', x.st < 500, x.st);
  // Белый список полей: лишнее в тело приёмника не уезжает.
  hits.length = 0;
  await jbody(`${HUB}/group`, 'POST', { title: 'Своя', createdBy: 'подмена', members: ['я'] });
  check('в тело приёмника уехал только title: лишние поля отброшены',
    last().body === JSON.stringify({ title: 'Своя' }), last().body);
  await jbody(`${HUB}/invite`, 'POST', { groups: [G1], uses: 3, ttlHours: 2, by: 'подмена' });
  check('у приглашения проброшены groups, ttlHours, uses — и ничего больше',
    JSON.parse(last().body || '{}').by === undefined
      && JSON.parse(last().body || '{}').uses === 3, last().body);
  await jbody(`${HUB}/group/${G1}/member`, 'POST', { memberId: MID2, status: 'active' });
  check('у добавления в группу проброшен только memberId',
    last().body === JSON.stringify({ memberId: MID2 }), last().body);
  check('leagueBodyPick не выдумывает отсутствующих полей',
    JSON.stringify(hub.leagueBodyPick({ a: 1 }, ['a', 'b'])) === '{"a":1}'
      && JSON.stringify(hub.leagueBodyPick(null, ['a'])) === '{}');
  console.log('\nразмен приглашения: ключа у свежей установки ещё нет:');
  check('leagueJoinReady требует адрес, но НЕ ключ',
    hub.leagueJoinReady({ enabled: true, url: 'http://x' }) === true
      && hub.leagueJoinReady({ enabled: true, url: '' }) === false
      && hub.leagueJoinReady({ enabled: false, url: 'http://x' }) === false);
  useStub({ key: '' }); hits.length = 0;
  x = await jbody(`${HUB}/join`, 'POST', { invite: 'xgl1_' + 'A'.repeat(20) });
  check('без ключа в конфиге размен всё равно уходит наружу',
    x.st === 200 && hits.length === 1 && last().u === '/join', { st: x.st, hits: hits.map(h => h.u) });
  hits.length = 0;
  x = await jget(`${HUB}/me`);
  check('а остальные ручки без ключа честно отвечают 503, а не молча идут в сеть',
    x.st === 503 && hits.length === 0, { st: x.st, hits: hits.length });
  x = await jbody(`${HUB}/join`, 'POST', { note: 'ни кода, ни приглашения' });
  check('размен без code и без invite — свой 400', x.st === 400, x.j);
  useStub(); hits.length = 0;
  fs.rmSync(cfgFile);
  for (const [why, u, m] of [['GET /me', '/me', 'GET'], ['GET /peers', '/peers', 'GET'],
    ['POST /group', '/group', 'POST'], ['POST /join', '/join', 'POST']]) {
    const r = m === 'POST' ? await jbody(`${HUB}${u}`, 'POST', { code: 'x', title: 'x' })
      : await jget(`${HUB}${u}`);
    check(`${why} без league-config.json → 503 с внятным текстом`,
      r.st === 503 && /league-config/.test(String((r.j || {}).error || '')), { st: r.st, j: r.j });
  }
  check('и ни один такой запрос не ушёл в сеть', hits.length === 0, hits.length);

  // ── 5. Строку приглашения собирает ХАБ ────────────────────────────────────
  console.log('\nстрока приглашения xgl1_: собирает хаб из url и pin своего конфига:');
  const decode = b => { try { return JSON.parse(Buffer.from(String(b).slice(5), 'base64url').toString('utf8')); } catch { return null; } };
  const blob1 = hub.leagueInviteBlob({ url: 'https://1.2.3.4:8420/', pin: PIN }, 'кодик');
  const d1 = decode(blob1);
  check('блоб начинается с xgl1_ и разбирается как base64url JSON',
    /^xgl1_[A-Za-z0-9_-]+$/.test(blob1) && !!d1, blob1 && blob1.slice(0, 12));
  check('внутри версия, адрес, отпечаток и код',
    d1 && d1.v === 1 && d1.u === 'https://1.2.3.4:8420' && d1.c === 'кодик' && typeof d1.p === 'string', d1);
  check('хвостовой слэш адреса срезан (иначе у друга получится //chat)',
    d1 && !/\/$/.test(d1.u), d1 && d1.u);
  check('отпечаток канонизирован: hex заглавными, без двоеточий',
    d1 && d1.p === PIN.replace(/[^A-Fa-f0-9]/g, '').toUpperCase() && !/:/.test(d1.p), d1 && d1.p);
  const noPin = decode(hub.leagueInviteBlob({ url: 'http://1.2.3.4:8420' }, 'к'));
  check('без отпечатка поля p просто нет (HTTP-приёмник — законный случай)',
    noPin && noPin.p === undefined && noPin.u === 'http://1.2.3.4:8420', noPin);
  check('без адреса блоба нет вовсе: собирать нечего',
    hub.leagueInviteBlob({ pin: PIN }, 'к') === '' && hub.leagueInviteBlob({ url: 'http://x' }, '') === '');
  check('локальный адрес назван оговоркой, а не выдан за рабочую строку',
    /локальн/.test(hub.leagueBlobHint('http://127.0.0.1:8420'))
      && /локальн/.test(hub.leagueBlobHint('http://192.168.1.5:8420'))
      && hub.leagueBlobHint('https://203.0.113.10:8420') === '',
    hub.leagueBlobHint('http://127.0.0.1:8420'));
  // Ответ приёмника + наш блоб. Заглушка отдаёт свой блоб намеренно: чей победит — вопрос
  // не вкуса, у хаба адрес и отпечаток проверены живым рукопожатием.
  useStub({ pin: PIN });
  stubStatus = 200;
  stubBody = { ok: true, id: INVID, code: 'КОД-ОТ-ПРИЁМНИКА', expires: '2026-09-06T00:00:00.000Z',
    groups: [G1], maxUses: 1, blob: 'xgl1_ЧУЖОЙ', note: 'код показан ОДИН раз' };
  x = await jbody(`${HUB}/invite`, 'POST', { groups: [G1] });
  check('к ответу приёмника добавлен готовый блоб', x.st === 200 && /^xgl1_/.test(String(x.j.blob || '')),
    x.j && x.j.blob);
  check('в блобе именно выданный код', (decode(x.j.blob) || {}).c === 'КОД-ОТ-ПРИЁМНИКА',
    decode(x.j.blob));
  check('блоб хаба ЗАМЕНИЛ приёмниковый (у нас адрес и пин проверены рукопожатием)',
    x.j.blob !== 'xgl1_ЧУЖОЙ', x.j.blob);
  check('остальные поля приёмника не пересобраны: id, expires, groups, note на месте',
    x.j.id === INVID && x.j.expires === stubBody.expires && x.j.maxUses === 1
      && Array.isArray(x.j.groups) && /ОДИН раз/.test(String(x.j.note || '')), x.j);
  check('локальный адрес приёмника даёт оговорку прямо в ответе',
    /локальн/.test(String(x.j.blobNote || '')), x.j.blobNote);
  // Отказ приёмника уезжает как есть: строку подключения собирать не из чего.
  stubStatus = 403; stubBody = { error: 'приглашать можно только в свою группу' };
  x = await jbody(`${HUB}/invite`, 'POST', {});
  check('отказ в выдаче доезжает своим кодом и без блоба',
    x.st === 403 && !x.j.blob && /свою группу/.test(String(x.j.error || '')), { st: x.st, j: x.j });
  stubStatus = 200; stubBody = { ok: true, id: INVID, expires: null };
  x = await jbody(`${HUB}/invite`, 'POST', {});
  check('ответ без кода (такого быть не должно) проходит без блоба и без пятисотки',
    x.st === 200 && !x.j.blob, x.j);

  // Сквозняк: наш блоб обязан разбираться НАСТОЯЩИМ приёмником. Это и есть доказательство
  // формата — не сравнение строк, а размен.
  console.log('\nсквозняк приглашения: выдал хаб, разменял приёмник:');
  useIdent();
  x = await jbody(`${HUB}/invite`, 'POST', { groups: [G1], uses: 2, ttlHours: 1 });
  check('приёмник выдал приглашение, хаб приложил строку подключения',
    x.st === 200 && typeof x.j.code === 'string' && /^xgl1_/.test(String(x.j.blob || '')),
    { st: x.st, hasCode: !!(x.j || {}).code, blob: (x.j || {}).blob && 'есть' });
  const inviteBlob = x.j && x.j.blob;
  const inviteId = x.j && x.j.id;
  // Сам код запоминаем ровно для одного — чтобы ниже доказать, что он НИГДЕ не всплыл.
  const INVCODE = x.j && x.j.code;
  const dInv = decode(inviteBlob) || {};
  check('в строке адрес и отпечаток из конфига хаба, а не из окружения приёмника',
    dInv.u === `http://127.0.0.1:${ident.port}` && dInv.p === PIN.replace(/[^A-Fa-f0-9]/g, '').toUpperCase(),
    { u: dInv.u, hasPin: !!dInv.p });
  x = await jbody(`${HUB}/join`, 'POST', { invite: inviteBlob });
  // Приёмник нашёл приглашение, значит он ВЫНУЛ код из нашей строки и сошёлся хешем — другого
  // способа найти запись у него нет (на диске лежит только sha256). Токен при этом не
  // переиздаётся: звонящий уже участник, и переиздание превратило бы вход в потерю доступа.
  check('приёмник разобрал НАШУ строку и разменял приглашение',
    x.st === 200 && x.j.ok === true && x.j.memberId === MID
      && Array.isArray(x.j.groups) && x.j.groups.includes(G1), x.j);
  check('уже существующему участнику новый токен не выдан',
    x.st === 200 && x.j.token === undefined, Object.keys(x.j || {}));
  x = await jbody(`${HUB}/join`, 'POST', { invite: inviteBlob });
  check('повтор той же строки — признание replay, лишнее использование не сожжено',
    x.st === 200 && x.j.replay === true, x.j);
  x = await jbody(`${HUB}/join`, 'POST', { invite: 'не приглашение вовсе' });
  check('чужая строка вместо приглашения — 400 приёмника, а не пятисотка', x.st === 400, x.j);
  x = await jget(`${HUB}/invite`);
  check('выданное видно в списке приглашений, но КОДА там нет',
    x.st === 200 && Array.isArray(x.j.invites)
      && x.j.invites.some(i => i.id === inviteId && i.maxUses === 2)
      && !/"code"/.test(JSON.stringify(x.j)), x.j && x.j.invites);
  x = await jget(`${HUB}/invite/${inviteId}`, { method: 'DELETE' });
  check('погашение проходит по id (sha256 кода), а не по коду', x.st === 200 && x.j.enabled === false, x.j);
  // ── 6. Секретов в выводе нет ──────────────────────────────────────────────
  console.log('\nсекреты: ни ключа, ни кода, ни блоба, ни отпечатка в логах:');
  const logAll = LOGS.join('\n');
  check('токен участника (он же ключ приёмника) не мелькнул ни в одной строке лога',
    !logAll.includes(TOKEN) && !logAll.includes(SECRET), LOGS.filter(l => l.includes(TOKEN)));
  check('код приглашения в лог не попал: он существует открытым текстом ровно один раз',
    !!INVCODE && !logAll.includes(INVCODE) && !/КОД-ОТ-ПРИЁМНИКА/.test(logAll),
    LOGS.filter(l => l.includes(String(INVCODE))));
  check('готовая строка xgl1_ в лог не попала (она содержит код целиком)',
    !/xgl1_/.test(logAll), LOGS.filter(l => /xgl1_/.test(l)));
  check('отпечаток сертификата в лог не попал', !logAll.includes(PIN)
    && !logAll.includes(PIN.replace(/[^A-Fa-f0-9]/g, '').toUpperCase()));
  check('но событие выдачи в логе ЕСТЬ — по хешу приглашения',
    LOGS.some(l => /приглашение выдано/.test(l) && /id [a-f0-9]{8},/.test(l)),
    LOGS.filter(l => /приглашение/.test(l)));
  check('и событие размена тоже, без самого приглашения',
    LOGS.some(l => /размен приглашения/.test(l) && !/xgl1_/.test(l)),
    LOGS.filter(l => /размен/.test(l)));
  // Ключ не должен появляться и в ответах браузеру. Проверяем на всех читающих ручках.
  const bodies = [];
  for (const u of ['', '/me', '/peers', '/invite', `/group/${G1}`, `/chat?gid=${G1}&since=0`]) {
    const r = await fetch(`${HUB}${u}`);
    bodies.push(await r.text());
  }
  const allBodies = bodies.join('\n');
  check('ни в одном ответе браузеру нет ключа приёмника',
    !allBodies.includes(TOKEN) && !allBodies.includes(SECRET));
  check('и нет отпечатка сертификата: браузеру он не нужен',
    !allBodies.includes(PIN) && !allBodies.includes(PIN.replace(/[^A-Fa-f0-9]/g, '').toUpperCase()));

  // ── 7. Рейтинг: склейка по rid, восстанавливать её нельзя ─────────────────
  console.log('\nрейтинг: строки склеиваются по rid, installId в публичной выдаче нет:');
  fs.writeFileSync(hub.LEAGUE_PEERS_FILE, JSON.stringify({ updated: 'сейчас', peers: [
    { rid: 'a1b2c3d4e5f60718', nick: 'сосед-1', tot: { tokW: 5 } },
    { rid: 'b1b2c3d4e5f60718', nick: 'сосед-2', tot: { tokW: 3 }, avatar: 'мусор' },
    { installId: '0'.repeat(16), nick: 'наследуемый сосед', tot: { tokW: 1 } },
    { nick: 'без ключа склейки вообще' },
  ] }));
  const pr = hub.leaguePeers();
  check('строки БЕЗ installId, но с rid, доезжают до вкладки — иначе рейтинг опустеет молча',
    pr.peers.length === 3 && pr.peers.filter(p => p.rid).length === 2, pr.peers.map(p => p.nick));
  check('наследуемая строка с installId тоже жива (совместимость)',
    pr.peers.some(p => p.installId === '0'.repeat(16)));
  check('строка без rid и без installId отброшена: склеить её не с чем',
    !pr.peers.some(p => /без ключа/.test(String(p.nick))));
  check('хаб НЕ восстанавливает installId по rid',
    pr.peers.filter(p => p.rid).every(p => p.installId === undefined), pr.peers);
  check('негодная аватарка соседа обнулена, а не подставлена в src',
    pr.peers.every(p => p.avatar === null || p.avatar === undefined
      || /^data:image\/webp;base64,/.test(p.avatar)), pr.peers.map(p => p.avatar));
  useIdent();
  x = await jget(`${HUB}/group/${G1}`);
  check('состав группы приезжает членам: memberId, rid, installId, ник',
    x.st === 200 && Array.isArray(x.j.members) && x.j.members.length === 1
      && x.j.members[0].memberId === MID && !!x.j.members[0].rid, x.j && x.j.members);
  x = await jget(`${HUB}/group/${G3}`);
  check('состав ЧУЖОЙ группы — 403 приёмника, а не пустой список', x.st === 403, x.j);
  // ── 8. CORS: снят с переписки, остался на витрине ─────────────────────────
  console.log('\nCORS: wildcard только на общем обзоре лиги:');
  const cors = async (u, o) => (await fetch(`${HUB}${u}`, o)).headers.get('access-control-allow-origin');
  check('на общем обзоре лиги wildcard ОСТАЛСЯ (превью вкладки, витрина рейтинга)',
    (await cors('')) === '*', await cors(''));
  check('на чтении чата wildcard СНЯТ', (await cors(`/chat?gid=${G1}&since=0`)) === null,
    await cors(`/chat?gid=${G1}&since=0`));
  const attCors = (await raw(`/__switch/api/league/chat/att/${G1}/${seqImg}.webp`))
    .headers['access-control-allow-origin'];
  check('на отдаче вложения wildcard СНЯТ', attCors === undefined, attCors);
  const newCors = [];
  for (const u of ['/me', '/peers', '/invite', `/group/${G1}`]) {
    if ((await cors(u)) !== null) newCors.push(u);
  }
  check('на новых ручках CORS не появился', !newCors.length, newCors);
  check('в тексте transparent-proxy.js осталась РОВНО одна wildcard-строка лиги',
    (block.match(/Access-Control-Allow-Origin', '\*'/g) || []).length === 1,
    (block.match(/Access-Control-Allow-Origin', '\*'/g) || []).length);

  // ── 9. Режим совместимости: пока members.json нет, всё как раньше ──────────
  console.log('\nсовместимость: непереведённая раскладка работает по-старому:');
  useLegacy();
  x = await jbody(`${HUB}/chat`, 'POST', { text: 'старый контракт ' + Date.now() });
  check('сообщение без группы принимается', x.st === 200 && x.j.ok === true, x.j);
  const legacySeq = x.j && x.j.seq;
  x = await jget(`${HUB}/chat?since=0&gseq=0`);
  check('чтение без группы отдаёт ленту, а не 400',
    x.st === 200 && Array.isArray(x.j.messages) && x.j.messages.length > 0, x.st);
  x = await jbody(`${HUB}/chat`, 'POST', { text: 'с картинкой', att: IMG });
  const flatSeq = x.j && x.j.seq;
  g = await raw(`/__switch/api/league/chat/att/${flatSeq}.webp`);
  check('плоский адрес вложения работает', g.status === 200
    && g.headers['content-type'] === 'image/webp', g.status);
  x = await del(`/chat/${legacySeq}`);
  check('удаление одного сообщения без группы работает', x.st === 200 && x.j.removed === 1, x.j);
  x = await del('/chat?mine=1');
  check('«убрать мои» без группы работает', x.st === 200 && x.j.ok === true, x.j);
  x = await jget(`${HUB}/me`);
  check('ручка личности на непереведённой раскладке — 409 приёмника с объяснением, а не 404',
    x.st === 409 && /переведён/.test(String((x.j || {}).error || '')), { st: x.st, j: x.j });
  x = await jget(`${HUB}/peers`);
  check('витрина рейтинга работает и на старой раскладке', x.st === 200 && Array.isArray(x.j.peers), x.st);
  x = await jbody(`${HUB}/chat`, 'POST', { gid: G1, text: 'группа на старой раскладке' });
  check('сообщение С группой на старой раскладке приёмник принимает (gid он игнорирует)',
    x.st === 200, x.j);
  // ── 10. Мутации: проверка обязана ЛОВИТЬ снятую границу ───────────────────
  // 🔴 Зелёный тест доказывает только то, что он проходит. Что он ЛОВИТ — доказывается
  // мутацией: ослабляем ровно одну границу в копии transparent-proxy.js (живой файл не
  // трогается вовсе, источник подставляется через LEAGUE_SRC) и требуем, чтобы прогон упал.
  // Мутация, которую тест не заметил, означает, что проверки границы у него нет.
  if (!MUTANT) {
    console.log('\nмутации: снятая граница обязана уронить этот же прогон:');
    const MUTS = [
      ['белый список расширений вложения',
        "const leagueAttExtOk = e => typeof e === 'string' && /^[a-z0-9]{1,8}$/.test(e);",
        "const leagueAttExtOk = e => typeof e === 'string' && /^[^?]{1,64}$/.test(e);"],
      ['проверка группы в пути вложения',
        'if (gid && !leagueGidOk(gid)) {',
        'if (false) {'],
      ['охрана источника на записях',
        'function leagueWriteGuard(req, res) {',
        'function leagueWriteGuard(req, res) { return true; // eslint-disable-line'],
    ];
    for (const [why, find, repl] of MUTS) {
      const n = SRC.split(find).length - 1;
      if (n !== 1) { check(`мутация «${why}»: якорь найден ровно один раз`, false, n); continue; }
      const f = path.join(TMP, 'mutant-' + Buffer.from(why).toString('hex').slice(0, 10) + '.js');
      fs.writeFileSync(f, SRC.replace(find, repl));
      const r = spawnSync(process.execPath, [__filename],
        { env: { ...process.env, LEAGUE_SRC: f, HUBGROUPS_MUTANT: '1' }, encoding: 'utf8',
          timeout: 300_000 });
      const out = String(r.stdout || '') + String(r.stderr || '');
      const reds = (out.match(/^ {2}❌ .+$/gm) || []).map(s => s.replace(/^ {2}❌ /, ''));
      check(`мутация «${why}» поймана (прогон упал)`, r.status === 1,
        { status: r.status, reds: reds.slice(0, 4) });
      if (reds.length) console.log(`      ↳ покраснело: ${reds.slice(0, 3).join(' | ')}`);
      try { fs.rmSync(f); } catch {}
    }
  }

  // Свои временные файлы и свои процессы — убираем сами (правило про корзину — про чужие
  // данные). Живой :8200 и живой приёмник на ноде при этом не задеты ни разу.
  legacy.child.kill(); ident.child.kill();
  await new Promise(r => srv.close(r));
  await new Promise(r => stub.close(r));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\nитог: ${ok} прошло, ${bad} упало`);
  if (bad) console.log('упало:\n  · ' + failed.join('\n  · '));
  process.exit(bad ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });



