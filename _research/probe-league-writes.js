#!/usr/bin/env node
'use strict';
// Временная проба ПОД МОЮ ПРАВКУ (агент, 05.09): то, чего нет ни в одном чужом тесте —
// ручка снятия лица, ограда источника на записях и потолки тела. Ничего живого не
// трогает: свой каталог в tmp, свой порт, приёмник в конфиге заведомо мёртвый (порт 1).
// Файл удаляется сразу после прогона.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROUTING = path.join(__dirname, '..', 'routing');
// Файл в CRLF — вырезаем по нормализованной копии, иначе `\n}\n` не находится вовсе.
const SRC = fs.readFileSync(path.join(ROUTING, 'transparent-proxy.js'), 'utf8').replace(/\r\n/g, '\n');

// Настоящий readJsonBody из файла — именно его потолки и проверяются.
const rjFrom = SRC.indexOf('function readJsonBody(req, maxBytes) {');
const rjTo = SRC.indexOf('\n}\n', rjFrom) + 3;
if (rjFrom < 0 || rjTo < 3) { console.error('не нашёл readJsonBody'); process.exit(1); }
// eslint-disable-next-line no-new-func
const readJsonBody = new Function(`${SRC.slice(rjFrom, rjTo)}\nreturn readJsonBody;`)();

const from = SRC.indexOf('const HUB_IDENTITY_FILE');
const to = SRC.indexOf('async function handleFinanceHistory');
const block = SRC.slice(from, to);

function jsonRes(res, code, body) {
  if (res.writableEnded) return;
  if (res.headersSent) { res.end(JSON.stringify(body)); return; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
const LOGS = [];
const EXPORTS = ['handleLeagueAvatar', 'handleLeagueAvatarDelete', 'handleLeagueNick',
  'handleLeagueChatPost', 'handleLeagueChatDelete', 'leaguePeers', 'hubIdentity',
  'leagueWriteGuard'].join(', ');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'league-write-probe-'));
// eslint-disable-next-line no-new-func
const hub = new Function(
  'fs', 'path', 'os', 'crypto', 'execFileSync', 'http', 'https', '__dirname', 'logLine', 'round2',
  'jsonRes', 'readJsonBody', 'TOKEN_USAGE_FILE', 'FINANCE_HISTORY_FILE', 'LISTEN_PORT',
  'ghLoad', 'arLoad', 'goLoad', 'tbLoad', 'xpLoad', 'jwLoad', 'skLoad', 'tsLoad', 'kkLoad',
  `${block}\nreturn { ${EXPORTS} };`
)(
  fs, path, os, crypto, execFileSync, http, https, TMP,
  m => LOGS.push(String(m)), v => Math.round(v * 100) / 100, jsonRes, readJsonBody,
  path.join(TMP, 'token-usage.jsonl'), path.join(TMP, 'finance-history.jsonl'), 8200,
  () => [], () => [], () => [], () => [], () => [], () => [], () => [], () => [], () => []
);

const srv = http.createServer((req, res) => {
  if (req.method === 'DELETE' && req.url.startsWith('/__switch/api/league/chat')) return hub.handleLeagueChatDelete(req, res);
  if (req.method === 'POST' && req.url === '/__switch/api/league/chat') return hub.handleLeagueChatPost(req, res);
  if (req.method === 'POST' && req.url === '/__switch/api/league/avatar') return hub.handleLeagueAvatar(req, res);
  if (req.method === 'DELETE' && req.url === '/__switch/api/league/avatar') return hub.handleLeagueAvatarDelete(req, res);
  if (req.method === 'POST' && req.url === '/__switch/api/league/nick') return hub.handleLeagueNick(req, res);
  jsonRes(res, 404, { error: 'нет ручки' });
});

let ok = 0, bad = 0;
const check = (n, c, got) => {
  if (c) { ok++; console.log(`  OK  ${n}`); }
  else { bad++; console.log(`  BAD ${n}${got === undefined ? '' : ' — ' + JSON.stringify(got).slice(0, 160)}`); }
};
const mkWebp = n => {
  const b = Buffer.alloc(Math.max(16, n), 0x61);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'latin1'); b.write('VP8 ', 12, 'latin1');
  return b;
};
const AVP = 'data:image/webp;base64,';
const idFile = path.join(TMP, 'hub-identity.json');

// Запрос сырым http: нужны произвольные заголовки, включая Sec-Fetch-*.
function call(port, method, p, body, headers) {
  return new Promise(resolve => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (data !== null && h['content-type'] === undefined && h['Content-Type'] === undefined) h['content-type'] = 'application/json';
    if (data !== null) h['content-length'] = Buffer.byteLength(data);
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: h, timeout: 20000 }, res => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        const text = Buffer.concat(ch).toString('utf8');
        let j = null; try { j = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, j, text });
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('таймаут')));
    rq.on('error', e => resolve({ status: 0, err: e.message }));
    if (data !== null) rq.write(data);
    rq.end();
  });
}

async function main() {
  const P = await new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  fs.writeFileSync(path.join(TMP, 'league-config.json'),
    JSON.stringify({ enabled: true, url: 'http://127.0.0.1:1', key: 'k'.repeat(16), everyMin: 10 }));

  console.log('\n1. ручка снятия лица (DELETE /league/avatar):');
  // Личность заводим первым делом: на пустом каталоге её ещё нет, а `handleLeagueAvatar`
  // сам installId не создаёт (он и не должен — это делает hubIdentity при чтении).
  const seed = hub.hubIdentity();
  let x = await call(P, 'POST', '/__switch/api/league/avatar', { b64: mkWebp(9000).toString('base64') });
  check('лицо поставлено', x.status === 200 && x.j && x.j.ok === true && x.j.bytes === 9000, x.j);
  check('в файле личности лежит полный data-URL',
    String(JSON.parse(fs.readFileSync(idFile, 'utf8')).avatar || '').startsWith(AVP));
  const before = JSON.parse(fs.readFileSync(idFile, 'utf8'));
  x = await call(P, 'DELETE', '/__switch/api/league/avatar');
  check('DELETE отвечает 200 {ok:true} — контракт кнопки', x.status === 200 && x.j && x.j.ok === true, x.j);
  const after = JSON.parse(fs.readFileSync(idFile, 'utf8'));
  check('поле avatar УДАЛЕНО, а не опустело', !('avatar' in after), Object.keys(after));
  check('installId и ник рядом не тронуты',
    after.installId === seed.installId && after.nick === seed.nick
      && before.installId === seed.installId, { after, before: before.installId, seed: seed.installId });
  check('срез больше лица не отдаёт', hub.hubIdentity().avatar === null);
  x = await call(P, 'DELETE', '/__switch/api/league/avatar');
  check('повторное снятие идемпотентно: ok:true и had:false',
    x.status === 200 && x.j.ok === true && x.j.had === false, x.j);

  console.log('\n2. атомарность записи личности:');
  const seen = [];
  const fsSpy = new Proxy(fs, { get(t, k) {
    if (k === 'writeFileSync') return (p, ...a) => { seen.push('write:' + path.basename(String(p))); return t.writeFileSync(p, ...a); };
    if (k === 'renameSync') return (a, b) => { seen.push('rename:' + path.basename(String(a)) + '→' + path.basename(String(b))); return t.renameSync(a, b); };
    return t[k];
  } });
  // eslint-disable-next-line no-new-func
  const hub2 = new Function(
    'fs', 'path', 'os', 'crypto', 'execFileSync', 'http', 'https', '__dirname', 'logLine', 'round2',
    'jsonRes', 'readJsonBody', 'TOKEN_USAGE_FILE', 'FINANCE_HISTORY_FILE', 'LISTEN_PORT',
    'ghLoad', 'arLoad', 'goLoad', 'tbLoad', 'xpLoad', 'jwLoad', 'skLoad', 'tsLoad', 'kkLoad',
    `${block}\nreturn { hubIdentityWrite };`
  )(
    fsSpy, path, os, crypto, execFileSync, http, https, TMP,
    m => LOGS.push(String(m)), v => v, jsonRes, readJsonBody,
    path.join(TMP, 'token-usage.jsonl'), path.join(TMP, 'finance-history.jsonl'), 8200,
    () => [], () => [], () => [], () => [], () => [], () => [], () => [], () => [], () => []
  );
  hub2.hubIdentityWrite({ nick: 'проба' });
  check('запись идёт во временный файл и переименованием',
    seen.length === 2 && seen[0] === 'write:hub-identity.json.tmp'
      && seen[1] === 'rename:hub-identity.json.tmp→hub-identity.json', seen);
  check('после переименования .tmp не остаётся', !fs.existsSync(idFile + '.tmp'));
  check('ник записан', JSON.parse(fs.readFileSync(idFile, 'utf8')).nick === 'проба');

  console.log('\n3. потолок тела (413):');
  x = await call(P, 'POST', '/__switch/api/league/nick', { nick: 'w'.repeat(70 * 1024) });
  check('ник: тело 70 КБ → 413', x.status === 413 && /64 КБ/.test((x.j || {}).error || ''), x.j);
  x = await call(P, 'POST', '/__switch/api/league/avatar', { b64: mkWebp(70 * 1024).toString('base64') });
  check('аватарка: тело сверх 64 КБ → 413, а не 400 после буферизации',
    x.status === 413, { st: x.status, j: x.j });
  x = await call(P, 'POST', '/__switch/api/league/chat', { text: 'x', att: 'A'.repeat(3.5 * 1024 * 1024) });
  check('чат: тело 3.5 МБ → 413 (потолок как MAX_CHAT_BODY приёмника)',
    x.status === 413 && /3072 КБ|3 МБ|3072/.test((x.j || {}).error || ''), { st: x.status, j: x.j });
  x = await call(P, 'POST', '/__switch/api/league/chat', { text: 'обычное сообщение' });
  check('нормальное сообщение потолком не задето (ушло к мёртвому приёмнику → 502)',
    x.status === 502, { st: x.status, j: x.j });
  x = await call(P, 'POST', '/__switch/api/league/nick', { nick: 'коротко' });
  check('короткий ник по-прежнему сохраняется', x.status === 200 && x.j.nick === 'коротко', x.j);

  console.log('\n4. ограда источника на записях:');
  const CT = { 'content-type': 'application/json' };
  for (const site of ['cross-site', 'same-site', 'none']) {
    x = await call(P, 'POST', '/__switch/api/league/nick', { nick: 'чужой' }, { ...CT, 'sec-fetch-site': site });
    check(`Sec-Fetch-Site: ${site} → 403`, x.status === 403, { st: x.status, j: x.j });
  }
  x = await call(P, 'POST', '/__switch/api/league/nick', { nick: 'свой1' }, { ...CT, 'sec-fetch-site': 'same-origin' });
  check('Sec-Fetch-Site: same-origin → пропущен', x.status === 200 && x.j.nick === 'свой1', x.j);
  x = await call(P, 'POST', '/__switch/api/league/nick', { nick: 'свой2' }, { ...CT, 'sec-fetch-site': 'SAME-ORIGIN' });
  check('регистр заголовка не важен', x.status === 200, { st: x.status, j: x.j });
  x = await call(P, 'DELETE', '/__switch/api/league/avatar', undefined, { 'sec-fetch-site': 'cross-site' });
  check('снятие лица с чужого сайта → 403', x.status === 403, { st: x.status, j: x.j });
  x = await call(P, 'DELETE', '/__switch/api/league/chat?mine=1', undefined, { 'sec-fetch-site': 'cross-site' });
  check('массовое удаление с чужого сайта → 403 (до приёмника не дошло)',
    x.status === 403, { st: x.status, j: x.j });
  x = await call(P, 'POST', '/__switch/api/league/avatar', { b64: mkWebp(2000).toString('base64') },
    { ...CT, origin: 'http://evil.example', host: `127.0.0.1:${P}` });
  check('чужой Origin без Sec-Fetch-* → 403 (старый браузер)', x.status === 403, { st: x.status, j: x.j });
  x = await call(P, 'POST', '/__switch/api/league/avatar', { b64: mkWebp(2000).toString('base64') },
    { ...CT, origin: `http://127.0.0.1:${P}` });
  check('свой Origin (host:port совпал) → пропущен', x.status === 200, { st: x.status, j: x.j });
  x = await call(P, 'POST', '/__switch/api/league/nick', JSON.stringify({ nick: 'простой' }),
    { 'content-type': 'text/plain;charset=UTF-8' });
  check('простой тип содержимого с телом → 415 (это и есть путь без предполёта)',
    x.status === 415, { st: x.status, j: x.j });
  x = await call(P, 'POST', '/__switch/api/league/nick', { nick: 'сЗарядом' },
    { 'content-type': 'application/json; charset=utf-8' });
  check('application/json с параметрами принят', x.status === 200, { st: x.status, j: x.j });

  console.log('\n5. Node-клиенты не сломаны (заголовков браузера нет вовсе):');
  x = await call(P, 'DELETE', '/__switch/api/league/avatar');
  check('DELETE без Content-Type и без Sec-Fetch-* проходит', x.status === 200, { st: x.status, j: x.j });
  x = await call(P, 'POST', '/__switch/api/league/avatar', {});
  check('POST аватарки пустым телом → 400 «нет картинки», как ждёт check-after-restart',
    x.status === 400 && /нет картинки/.test((x.j || {}).error || ''), x.j);
  const sync = (() => {
    const out = { code: 0, sync: false };
    const res = { writableEnded: false, headersSent: false, setHeader() {},
      writeHead(c) { out.code = c; this.headersSent = true; },
      end() { this.writableEnded = true; } };
    hub.handleLeagueChatDelete({ url: '/__switch/api/league/chat?mine=1', method: 'DELETE', headers: {} }, res)
      .catch(() => {});
    out.sync = res.writableEnded;
    return out;
  })();
  check('handleLeagueChatDelete с headers:{} не отвечает синхронно — как ждёт check-journal-tail',
    sync.code === 0 && sync.sync === false, sync);

  console.log('\n6. аватарка соседа перепроверяется сервером:');
  const good = AVP + mkWebp(4000).toString('base64');
  fs.writeFileSync(path.join(TMP, 'league-peers.json'), JSON.stringify({
    updated: '2026-09-05T00:00:00.000Z',
    peers: [
      { installId: 'a'.repeat(16), nick: 'good', avatar: good },
      { installId: 'b'.repeat(16), nick: 'png', avatar: AVP + Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(64)).toString('base64') },
      { installId: 'c'.repeat(16), nick: 'html', avatar: 'data:text/html,<script>alert(1)</script>' },
      { installId: 'd'.repeat(16), nick: 'quote', avatar: AVP + '"><img src=x onerror=alert(1)>' },
      { installId: 'e'.repeat(16), nick: 'huge', avatar: AVP + 'A'.repeat(200000) },
      { installId: 'f'.repeat(16), nick: 'none' },
    ],
  }));
  const pr = hub.leaguePeers();
  const by = n => pr.peers.find(p => p.nick === n);
  check('годная аватарка соседа осталась как есть', by('good').avatar === good);
  check('png под видом webp обнулён', by('png').avatar === null);
  check('data:text/html обнулён', by('html').avatar === null);
  check('строка с кавычкой и тегом обнулена', by('quote').avatar === null);
  check('раздутая строка обнулена без декодирования всего', by('huge').avatar === null);
  check('сосед без лица получает null, а не undefined', by('none').avatar === null);
  check('соседи не потеряны и порядок сохранён', pr.peers.length === 6 && pr.updated);

  srv.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log(`\nитог пробы: ${ok} прошло, ${bad} упало`);
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
