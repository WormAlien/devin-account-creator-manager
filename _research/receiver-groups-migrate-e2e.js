'use strict';
/**
 * Сквозная проверка КОНТРАКТА «переход → новый приёмник», локально и без сети.
 * Зачем отдельно от регресса: регресс готовит групповую раскладку САМ (эмулирует переход),
 * а здесь её делает настоящий `tools/league-migrate.js`. Расхождение форм файлов между
 * скриптом перехода и приёмником — самая тихая из возможных поломок: чат просто окажется
 * пустым, а ошибок не будет нигде.
 *
 * Порядок: старый (плоский) каталог → сообщения с тремя видами вложений и надгробием →
 * league-migrate.js → новый приёмник на переведённых данных → всё на месте.
 */
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RECV = path.join(ROOT, 'routing', 'league-receiver.js');
const MIGRATE = path.join(ROOT, 'tools', 'league-migrate.js');
const PORT = 8000 + Math.floor(Math.random() * 900);
const DATA = path.join(os.tmpdir(), 'league-mig-e2e-' + Date.now());
const B = `http://127.0.0.1:${PORT}`;
let ok = 0, bad = 0;
const check = (n, c, got) => {
  if (c) { ok++; console.log('  ✅ ' + n); }
  else { bad++; console.log(`  ❌ ${n}${got === undefined ? '' : ' — получено ' + JSON.stringify(got)}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mkWebp = (n = 64) => {
  const h = Buffer.alloc(12);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(n - 8, 4); h.write('WEBP', 8, 'latin1');
  return Buffer.concat([h, Buffer.alloc(Math.max(n - 12, 4), 0x77)]);
};
const mkWebm = (n = 4096) => Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.alloc(n - 4, 0x33)]);

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let out = '';
  let child = null;
  const up = async () => {
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      try { if ((await fetch(`${B}/health`)).ok) return true; } catch { /* ждём */ }
    }
    return false;
  };
  const start = async () => {
    child = spawn(process.execPath, [RECV, String(PORT), DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    return up();
  };
  const stop = async () => {
    if (child) child.kill();
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      try { await fetch(`${B}/health`); } catch { break; }
    }
  };
  if (!await start()) { console.log('приёмник не поднялся:\n' + out); process.exit(1); }
  const SEC = fs.readFileSync(path.join(DATA, 'secret'), 'utf8').trim();
  const q = async (m, p, body, key) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key !== null) headers['X-League-Key'] = key === undefined ? SEC : key;
    const r = await fetch(B + p, { method: m, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let j = null;
    try { j = await r.json(); } catch { /* байты */ }
    return { st: r.status, j: j || {} };
  };
  const bytes = async p => {
    const r = await fetch(B + p, { headers: { 'X-League-Key': SEC } });
    return { st: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  };
  const ME = 'ab'.repeat(8);

  console.log('\nстарая плоская раскладка: наполняем как в бою:');
  const sl = await q('POST', '/slice', { installId: ME, nick: 'worm', ver: '2.0.0',
    keys: { d7: ['2026-08-30'] }, tok: { d7: [1] }, act: { d7: [1] },
    tot: { tokW: 5e9, tokA: 1e10, promptsAll: 17000, spentAll: 18000, bought: 32, reg: 142 } });
  check('срез принят по общему ключу', sl.st === 200, sl.j);
  const img = mkWebp(2200), voice = mkWebm(5000), file = Buffer.from('# скилл\n');
  const m1 = await q('POST', '/chat', { installId: ME, nick: 'worm', text: 'первое' });
  const m2 = await q('POST', '/chat', { installId: ME, nick: 'worm', text: 'с картинкой', att: { b64: img.toString('base64') } });
  const m3 = await q('POST', '/chat', { installId: ME, nick: 'worm', text: 'с голосом', att: { b64: voice.toString('base64') } });
  const m4 = await q('POST', '/chat', { installId: ME, nick: 'worm', text: 'с файлом', att: { b64: file.toString('base64'), name: 'skill.md' } });
  const m5 = await q('POST', '/chat', { installId: ME, nick: 'worm', text: 'это удалим' });
  const del = await q('DELETE', `/chat/${m5.j.seq}?installId=${ME}`);
  const before = await q('GET', '/chat?since=0&gseq=0');
  check('в плоском журнале четыре сообщения и одно надгробие',
    [m1, m2, m3, m4].every(x => x.st === 200) && del.st === 200
    && (before.j.messages || []).length === 4 && (before.j.gone || []).length === 1,
    { сообщений: (before.j.messages || []).length, надгробий: (before.j.gone || []).length });
  const gseqBefore = before.j.gseq, seqs = (before.j.messages || []).map(x => x.seq);
  await stop();

  console.log('\nпереход настоящим tools/league-migrate.js:');
  let mig = '';
  try {
    mig = execFileSync(process.execPath, [MIGRATE, DATA], { encoding: 'utf8' });
  } catch (e) { mig = String(e.stdout || '') + String(e.stderr || ''); }
  const gid = (/MIGRATE-OK gid=([a-f0-9]{32})/.exec(mig) || [])[1];
  check('переход отчитался MIGRATE-OK и назвал группу-основание', !!gid, mig.slice(-400));
  check('файлы личности созданы скриптом перехода',
    ['members.json', 'groups.json', 'invites.json', 'addr-salt'].every(f => fs.existsSync(path.join(DATA, f))));
  check('журнал, счётчик и надгробия переехали в группу',
    !!gid && fs.existsSync(path.join(DATA, 'chat', gid + '.ndjson'))
    && fs.existsSync(path.join(DATA, 'chat', gid + '.seq'))
    && fs.existsSync(path.join(DATA, 'chat', gid + '.tombs.json')));
  check('вложения переехали в подкаталоги группы',
    !!gid && fs.existsSync(path.join(DATA, 'att', gid, m2.j.seq + '.webp'))
    && fs.existsSync(path.join(DATA, 'voice', gid, m3.j.seq + '.webm'))
    && fs.existsSync(path.join(DATA, 'files', gid, m4.j.seq + '.md')));

  console.log('\nновый приёмник на переведённых данных:');
  if (!await start()) { console.log('приёмник не поднялся после перехода:\n' + out); process.exit(1); }
  const me = await q('GET', '/me');
  check('прежний общий секрет принят как ЛИЧНЫЙ токен владельца: у него та же установка',
    me.st === 200 && me.j.installId === ME && (me.j.groups[0] || {}).gid === gid, me.j);
  const feed = await q('GET', `/chat?gid=${gid}&since=0&gseq=0`);
  check('переписка на месте и с ТЕМИ ЖЕ номерами: перенумерации не было',
    JSON.stringify((feed.j.messages || []).map(x => x.seq)) === JSON.stringify(seqs),
    { было: seqs, стало: (feed.j.messages || []).map(x => x.seq) });
  check('курсор надгробий перенесён как есть: клиенты не уехали в холодное перечитывание',
    feed.j.gseq === gseqBefore && feed.j.cold === false
    && (feed.j.gone || []).some(g => g.seq === m5.j.seq),
    { было: gseqBefore, стало: feed.j.gseq, cold: feed.j.cold });
  const rowImg = (feed.j.messages || []).find(x => x.seq === m2.j.seq) || {};
  check('ссылка на вложение теперь несёт группу',
    rowImg.att && rowImg.att.url === `/chat/att/${gid}/${m2.j.seq}.webp`, rowImg.att);
  const gotImg = await bytes(`/chat/att/${gid}/${m2.j.seq}.webp`);
  const gotVoice = await bytes(`/chat/att/${gid}/${m3.j.seq}.webm`);
  const gotFile = await bytes(`/chat/att/${gid}/${m4.j.seq}.md`);
  check('все три вида вложений отдаются байт-в-байт после переезда',
    gotImg.buf.equals(img) && gotVoice.buf.equals(voice) && gotFile.buf.equals(file),
    { img: gotImg.st, voice: gotVoice.st, file: gotFile.st });
  const next = await q('POST', '/chat', { gid, text: 'после перехода' });
  check('номер продолжился от перенесённого счётчика, а не начался заново',
    next.j.seq === m5.j.seq + 1, { стало: next.j.seq, былоМакс: m5.j.seq });
  const pub = await q('GET', '/peers', undefined, null);
  check('рейтинг стал публичным и без installId, лица и версии сборки',
    pub.st === 200 && (pub.j.peers || []).length === 1
    && !('installId' in (pub.j.peers[0] || {})) && !JSON.stringify(pub.j).includes(ME), pub.j.peers);
  const inv = await q('POST', '/invite', {});
  check('приглашения работают на переведённом каталоге: invites.json от перехода читается',
    inv.st === 200 && !!inv.j.code, inv.j);
  const join = await q('POST', '/join', { code: inv.j.code }, null);
  check('размен создаёт участника и токен делает приёмник', join.st === 200 && !!join.j.token, join.j);

  console.log('\nобратный ход: --rollback и СТАРЫЙ контракт снова работает:');
  await stop();
  let rb = '';
  try { rb = execFileSync(process.execPath, [MIGRATE, DATA, '--rollback'], { encoding: 'utf8' }); }
  catch (e) { rb = String(e.stdout || '') + String(e.stderr || ''); }
  check('откат отчитался и вернул плоскую раскладку',
    /Откат сделан/.test(rb) && fs.existsSync(path.join(DATA, 'chat.ndjson'))
    && !fs.existsSync(path.join(DATA, 'members.json')), rb.slice(-300));
  if (!await start()) { console.log('приёмник не поднялся после откката:\n' + out); process.exit(1); }
  const backFeed = await q('GET', '/chat?since=0&gseq=0');
  check('тот же приёмник снова работает по общему ключу на плоской раскладке',
    backFeed.st === 200 && (backFeed.j.messages || []).length >= 4, (backFeed.j.messages || []).length);
  check('и ручки личности снова отвечают ПРИЧИНОЙ, а не «нет такой ручки»',
    (await q('GET', '/me')).st === 409);

  await stop();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ладно */ }
  console.log(`\nитог: ${ok} прошло, ${bad} упало`);
  await sleep(150);
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
