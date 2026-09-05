'use strict';
/**
 * Мутационная проверка приёмника лиги: ломаем ОДНУ несущую строку в КОПИИ
 * routing/league-receiver.js и смотрим, покраснеет ли регресс. Живой файл не трогается —
 * тесту источник подсовывается через LEAGUE_RECEIVER_SRC.
 *
 * Смысл не «покрытие», а «проверка проверяет». Каждая мутация здесь — это правдоподобная
 * небрежность: забыл проверку членства, взял installId из тела, закешировал реестр
 * навсегда, пропустил «использовано» у многоразового кода. Если после такой правки регресс
 * остаётся зелёным — он охраняет не то, что заявляет.
 *
 *   node _research/receiver-groups-mutate.js [номер|подстрока]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'routing', 'league-receiver.js');
const TEST = path.join(ROOT, 'tools', 'check-league-receiver.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-mut-'));
const src = fs.readFileSync(SRC, 'utf8');
const pick = process.argv[2] || '';

const MUTANTS = [
  ['личность среза берётся из ТЕЛА, а не из записи',
    "    let installId = String(me.installId || '');",
    "    let installId = String(s.installId || me.installId || '');"],
  ['автор сообщения берётся из ТЕЛА, а не из записи',
    "        installId = String(me.installId || '');\n        nick = nickClean(me.nick) || 'mem-' + String(me.memberId || '0000').slice(0, 4);",
    "        installId = idOk(m.installId) ? m.installId : String(me.installId || '');\n        nick = nickClean(m.nick) || nickClean(me.nick) || 'mem-x';"],
  ['право приглашать не проверяется по записи поручителя',
    "        if (!GID_RE.test(String(g))) return json(res, 400, { error: 'gid — 32 символа [a-f0-9]' });\n        if (!inGroup(me, g)) return json(res, 403, { error: 'ты не в этой группе' });",
    "        if (!GID_RE.test(String(g))) return json(res, 400, { error: 'gid — 32 символа [a-f0-9]' });"],
  ['порядок проверок приглашения: погашение проверяется ПОСЛЕ срока',
    "    if (inv.enabled === false) return { code: 410, error: 'приглашение погашено' };",
    "    if (inv.enabled === false && Date.parse(inv.expires) > now) return { code: 410, error: 'приглашение погашено' };"],
  ['пустой срок приглашения читается как «никогда не истекает»',
    '    if (!Number.isFinite(exp)) {', '    if (false) {'],
  ['многоразовое приглашение пропускает проверку «уже использовано»',
    '    if (uses >= maxUses) {', '    if (!multi && uses >= maxUses) {'],
  ['токен нового участника — это сам код приглашения',
    "        token = crypto.randomBytes(24).toString('base64url');", '        token = code;'],
  ['реестр участников кешируется навсегда (отзыв только после рестарта)',
    "    const key = st.mtimeMs + ':' + st.size;\n    const hit = stateCache.get(file);",
    "    const key = 'навсегда';\n    const hit = stateCache.get(file);"],
  ['битый members.json роняет режим в наследуемый вместо 503',
    "        val = { state: 'broken', why: e.message };", "        val = { state: 'none' };"],
  ['в публичную выдачу вернулись installId, лицо, версия и коммит',
    "const PEER_PUBLIC = ['nick', 'recvAt', 'keys', 'tok', 'sp', 'tu', 'act', 'acc', 'tot'];",
    "const PEER_PUBLIC = ['nick', 'recvAt', 'keys', 'tok', 'sp', 'tu', 'act', 'acc', 'tot',\n    'installId', 'avatar', 'ver', 'sha', 'tzOffsetMin'];"],
  ['членство на чтении ленты не проверяется',
    '        if (!inGroup(me, gidOne)) {', '        if (false) {'],
  ['членство на отдаче вложения не проверяется',
    "    if (me && !inGroup(me, gid)) return json(res, 403, { error: 'ты не в этой группе' });", ''],
  ['группа не попадает в путь вложения (номера сталкиваются)',
    '        dirs: { image: path.join(ATT_DIR, gid), audio: path.join(VOICE_DIR, gid),\n            file: path.join(FILE_DIR, gid) } };',
    '        dirs: { image: ATT_DIR, audio: VOICE_DIR, file: FILE_DIR } };'],
  ['счётчик номеров общий на приёмник, а не на группу',
    "    return { gid, log: path.join(CHAT_DIR, gid + '.ndjson'), seq: path.join(CHAT_DIR, gid + '.seq'),",
    '    return { gid, log: path.join(CHAT_DIR, gid + \'.ndjson\'), seq: SEQ_FILE,'],
  ['снести журнал группы целиком может любой её член',
    '        if (all && !isCreator(me, gid)) {', '        if (false) {'],
  ['исключить из группы может любой её член',
    '    if (!self && !isCreator(me, gid)) {', '    if (false) {'],
  ['присланный installId снова становится ЦЕЛЬЮ удаления',
    '        doomed = list.filter(x => x.installId === me.installId);',
    '        doomed = list.filter(x => x.installId === (who || me.installId));'],
  ['перед чисткой сообщений исключённого не снимается снимок журнала',
    '            chatBackup(c);\n            const kill = new Set(doomed.map(x => x.seq));\n            if (chatWriteAll(c, list.filter(x => !kill.has(x.seq)))) {',
    '            const kill = new Set(doomed.map(x => x.seq));\n            if (chatWriteAll(c, list.filter(x => !kill.has(x.seq)))) {'],
  ['соль ключа строки рейтинга снова берётся из секрета, а не из файла',
    "const ridOf = id => sha256(addrSalt() + '|rid|' + String(id)).slice(0, 16);",
    "const ridOf = id => sha256(SECRET + '|rid|' + String(id)).slice(0, 16);"],
  ['чтение без gid молча отдаёт группу по умолчанию',
    "    const curRaw = u.searchParams.get('cur');\n    const gidOne = String(u.searchParams.get('gid') || '');\n    if (curRaw === null && !gidOne) {",
    "    const curRaw = u.searchParams.get('cur');\n    let gidOne = String(u.searchParams.get('gid') || '');\n    if (curRaw === null && !gidOne) gidOne = (Array.isArray(me.groups) ? me.groups[0] : '') || '';\n    if (false) {"],
];

const run = file => {
  try {
    return execFileSync(process.execPath, [TEST], { env: { ...process.env, LEAGUE_RECEIVER_SRC: file },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
};
const tail = out => {
  const m = /итог: (\d+) прошло, (\d+) упало/.exec(out);
  const reds = (out.match(/ {2}❌ [^\n]*/g) || []).map(s => s.replace(/^ {2}❌ /, '').split(' — ')[0]);
  return { ok: m ? Number(m[1]) : -1, bad: m ? Number(m[2]) : -1, reds };
};

const base = tail(run(SRC));
console.log(`база: ${base.ok} прошло, ${base.bad} упало`);
let caught = 0, missed = 0, skipped = 0;
const rows = [];
MUTANTS.forEach(([why, from, to], i) => {
  if (pick && !String(i + 1).includes(pick) && !why.includes(pick)) return;
  if (!src.includes(from)) {
    console.log(`\n[${i + 1}] ${why}\n    ⛔ ЯКОРЬ НЕ НАЙДЕН — мутация не применена`);
    skipped++;
    rows.push([why, 'якорь не найден', '—']);
    return;
  }
  const f = path.join(DIR, `mut-${i + 1}.js`);
  fs.writeFileSync(f, src.replace(from, to));
  const r = tail(run(f));
  // Упавший прогон (нет строки «итог») — тоже «поймано»: регресс не остался зелёным. Но
  // помечаем отдельно: падение харнесса и красная проверка — разные сигналы.
  const died = r.ok < 0;
  const verdict = died ? 'поймано (регресс упал)' : (r.bad > 0 ? 'поймано' : 'ПРОПУЩЕНО');
  if (died || r.bad > 0) caught++; else missed++;
  console.log(`\n[${i + 1}] ${why}\n    ${died ? 'прогон оборвался' : `${r.ok} прошло, ${r.bad} упало`} — ${verdict}`);
  for (const t of r.reds.slice(0, 5)) console.log('       ❌ ' + t);
  if (r.reds.length > 5) console.log(`       … и ещё ${r.reds.length - 5}`);
  rows.push([why, verdict, r.reds[0] || '—']);
});
console.log(`\nитого мутаций: ${caught} поймано, ${missed} пропущено, ${skipped} без якоря`);
console.log('\n| мутация | итог | первая покрасневшая проверка |');
console.log('|---|---|---|');
for (const [why, v, red] of rows) console.log(`| ${why} | ${v} | ${red} |`);
fs.rmSync(DIR, { recursive: true, force: true });
