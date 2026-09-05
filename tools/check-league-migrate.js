#!/usr/bin/env node
'use strict';
/**
 * check-league-migrate.js — регресс на переход данных лиги в групповую раскладку.
 *
 * Зачем: переход трогает переписку живых людей и накопленный рейтинг, и все три
 * его способа сломаться тихие. Перенумеровал сообщения — каждая старая картинка
 * отвязалась от своей строки (номер входит в имя файла). Прогнал дважды — история
 * удвоилась или снимок затёрся. Сгенерировал installId заново — рейтинг начался с
 * нуля, а прежняя строка ещё 36 часов висит рядом. Ни одно из этих трёх не даёт
 * ошибки в выводе, поэтому проверяется не «скрипт отработал», а состояние диска
 * ДО и ПОСЛЕ, побайтово.
 *
 * Как: собирает в песочнице копию настоящей раскладки (журнал с вложениями трёх видов,
 * срез, счётчик, надгробия, slice-owners/drops, старые снимки), гоняет по ней настоящий
 * league-migrate.js отдельным процессом и сверяет диск. Ни ноды, ни сети, ни живых
 * данных. Плюс два вердикта выката (`deploy-league-receiver.js`) — сверка всех трёх
 * правил чистки и запрет обратного порядка выката: они охраняют тот же переход и
 * ломаются так же тихо, поэтому проверяются здесь же, прямым вызовом функций.
 *
 * Запуск: node tools/check-league-migrate.js            (exit 1 = переход дырявый)
 *         node tools/check-league-migrate.js --mutants  (+ таблица мутаций)
 *         MIGRATE_JS=<путь> / DEPLOY_JS=<путь>          (проверить мутанта)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const MIGRATE = process.env.MIGRATE_JS || path.join(__dirname, 'league-migrate.js');
// Выкат проверяется как модуль: его вердикты (рецепт чистки, порядок выката) — чистые
// функции, и мутировать их надо отдельно от скрипта перехода.
const DEPLOY = process.env.DEPLOY_JS || path.join(__dirname, 'deploy-league-receiver.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'league-migrate-test-'));
const QUIET = !!(process.env.MIGRATE_JS || process.env.DEPLOY_JS);   // прогон мутанта
// Уборка на ВЫХОДЕ, а не строкой в конце: на испорченном скрипте (прогон мутации)
// проверка вылетает исключением посреди файла, и последняя строка не выполняется —
// так в temp накапливались десятки каталогов. Свои временные файлы удаляются
// напрямую: правило про корзину — про чужие данные.
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* уже нет */ } });

let ok = 0, bad = 0;
const check = (name, cond, got) => {
  if (cond) { ok++; if (!QUIET) console.log(`  ✅ ${name}`); }
  else { bad++; console.log(`  ❌ ${name}${got === undefined ? '' : ` — получено ${JSON.stringify(got)}`}`); }
};
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const md5file = f => { try { return md5(fs.readFileSync(f)); } catch { return null; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const run = (data, ...args) => {
  const r = spawnSync(process.execPath, [MIGRATE, data, ...args],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
};
// Отпечаток всего каталога: путь + md5 каждого файла. Утверждение «второй прогон
// ничего не изменил» иначе проверяется глазами по трём файлам, а менять он может
// любой — включая снимки, которых стало два.
function digest(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...digest(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/') + ' ' + md5file(p));
  }
  return out;
}
// ── Песочница: копия настоящей раскладки ─────────────────────────────────────
// Номера начинаются НЕ с единицы (838): журнал на ноде обрезан до 1000, и первый
// его номер давно не первый. Перенумерация на 1…N прошла бы любую проверку «столько
// же сообщений» и провалила бы вот эту.
const INSTALL = 'ab12cd34ef567890';
const NICK = 'WormAlien';
const SEQS = [838, 839, 841, 844, 845];
// Вложения ТРЁХ видов и, значит, в трёх каталогах: картинка в `att/`, звук в `voice/`,
// произвольный файл в `files/`. Раскладка по расширению — та же таблица, что у
// приёмника; у файла в записи журнала живёт ещё и исходное имя (на диске он под номером).
const WITH_ATT = { 838: 'webp', 841: 'webm', 844: 'pdf', 845: 'webp' };
const ATT_HOME = { webp: 'att', webm: 'voice', ogg: 'voice', m4a: 'voice', mp3: 'voice', wav: 'voice' };
const home = ext => ATT_HOME[ext] || 'files';
const FILE_NAME = 'смета за август.pdf';
// 🪤 Секрет уезжает АРГУМЕНТОМ командной строки в дочерний `node`, а `base64url`
// разрешает символ `-`. Секрет, случайно начавшийся с дефиса, читался как ключ
// запуска: `bad option: -aSqq04…`, и прогон падал примерно раз из трёх — на чужой
// работе, потому что искать причину шли в правку, а не в харнесс. Hex такого
// символа не содержит вовсе, и это дешевле, чем экранировать на каждом вызове.
const SECRET = crypto.randomBytes(24).toString('hex');
// Время фиксируем ОДИН раз: иначе две песочницы отличались бы миллисекундами в
// `recvAt`, и сверять байты журнала между прогонами стало бы нельзя.
const T0 = Date.parse('2026-09-05T12:00:00.000Z');
const JOURNAL = SEQS.map(seq => {
  const rec = { seq, installId: INSTALL, nick: NICK, text: 'сообщение ' + seq,
    recvAt: new Date(T0 - (900 - seq) * 60000).toISOString() };
  const ext = WITH_ATT[seq];
  if (ext) {
    rec.att = { ext, bytes: 40 + seq };
    if (home(ext) === 'files') rec.att.name = FILE_NAME;
    if (home(ext) === 'voice') rec.att.dur = 12;
  }
  return JSON.stringify(rec);
}).join('\n') + '\n';
const JOURNAL_MD5 = md5(Buffer.from(JOURNAL, 'utf8'));
// Байты вложения у каждого свои: перепутанные местами файлы иначе неотличимы.
const attBytes = seq => Buffer.from('att-' + seq + '-'.repeat(seq % 7) + WITH_ATT[seq]);
// Надгробия в той форме, которую пишет приёмник: объект с `v`, курсором `gseq` и
// `cut` — самым большим уже забытым номером. Числа НЕ круглые и НЕ равны количеству
// записей: перенумерация «1…N» иначе прошла бы незаметно.
const TOMBS_V2 = { v: 2, gseq: 42, cut: 7, tombs: [
  { seq: 840, at: new Date(T0 - 7200e3).toISOString(), gseq: 40, why: 'one' },
  { seq: 842, at: new Date(T0 - 3600e3).toISOString(), gseq: 41, why: 'mine' },
  { seq: 843, at: new Date(T0 - 3600e3).toISOString(), gseq: 42, why: 'mine' },
] };
let made = 0;
function mkData(gone = TOMBS_V2) {
  const D = path.join(ROOT, 'data-' + (++made));
  fs.mkdirSync(path.join(D, 'slices'), { recursive: true });
  for (const d of ['att', 'voice', 'files']) fs.mkdirSync(path.join(D, d), { recursive: true });
  fs.writeFileSync(path.join(D, 'secret'), SECRET + '\n');
  fs.writeFileSync(path.join(D, 'slices', INSTALL + '.json'), JSON.stringify({
    installId: INSTALL, nick: NICK, recvAt: new Date(T0).toISOString(), ver: '2.0.0',
    tot: { tokA: 1.8e10, promptsAll: 17923, spentAll: 20293, bought: 32, reg: 142 },
  }));
  fs.writeFileSync(path.join(D, 'chat.ndjson'), JOURNAL);
  for (const seq of Object.keys(WITH_ATT)) {
    const ext = WITH_ATT[seq];
    fs.writeFileSync(path.join(D, home(ext), seq + '.' + ext), attBytes(Number(seq)));
  }
  fs.writeFileSync(path.join(D, 'chat-seq'), '845\n');
  fs.writeFileSync(path.join(D, 'chat-gone.json'), JSON.stringify(gone));
  fs.writeFileSync(path.join(D, 'slice-owners.json'), JSON.stringify({ [INSTALL]: 'deadbeefdeadbeef' }));
  fs.writeFileSync(path.join(D, 'slice-drops.json'), JSON.stringify({ [INSTALL]: { n: 3, at: T0 } }));
  // Старые снимки массовых удалений: их удержание (пять) переход ломать не должен.
  fs.writeFileSync(path.join(D, 'chat-2026-09-01T10-00-00-000.bak.ndjson'), 'old snapshot 1\n');
  fs.writeFileSync(path.join(D, 'chat-2026-09-02T10-00-00-000.bak.ndjson'), 'old snapshot 2\n');
  return D;
}
const gidOf = out => (/MIGRATE-OK gid=([a-f0-9]{32})/.exec(out) || [])[1] || '';
const SLICE_MD5 = (() => { const D = mkData(); const m = md5file(path.join(D, 'slices', INSTALL + '.json'));
  fs.rmSync(D, { recursive: true, force: true }); return m; })();
// ── 1. Сухой прогон ничего не меняет ─────────────────────────────────────────
if (!QUIET) console.log('\nсухой прогон:');
{
  const D = mkData();
  const before = digest(D).join('\n');
  const r = run(D, '--dry-run');
  check('сухой прогон выходит с нулём', r.code === 0, r.code);
  check('сухой прогон не изменил ни одного байта', digest(D).join('\n') === before);
  check('в плане назван перенос журнала в группу', /chat\.ndjson → chat\/[a-f0-9]{32}\.ndjson/.test(r.out));
  check('в плане назван снос файлов прежней соли', /slice-owners\.json, slice-drops\.json — снести/.test(r.out));
}

// ── 2. Основной прогон ───────────────────────────────────────────────────────
if (!QUIET) console.log('\nпереход:');
const D1 = mkData();
const R1 = run(D1);
const GID = gidOf(R1.out);
check('переход выходит с нулём', R1.code === 0, R1.code + ':' + R1.out.slice(-400));
check('идентификатор группы — 32 hex и напечатан', /^[a-f0-9]{32}$/.test(GID), GID);

const J = path.join(D1, 'chat', GID + '.ndjson');
if (!QUIET) console.log('\nжурнал переехал без перенумерации:');
check('журнал лежит в chat/<gid>.ndjson', fs.existsSync(J));
check('байты журнала не изменились', md5file(J) === JOURNAL_MD5, md5file(J));
const seqsAfter = fs.existsSync(J)
  ? fs.readFileSync(J, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).seq) : [];
check('номера сообщений те же и в том же порядке',
  seqsAfter.join(',') === SEQS.join(','), seqsAfter);
check('первый номер не стал единицей (перенумерации нет)', seqsAfter[0] === 838, seqsAfter[0]);
check('прежнего chat.ndjson больше нет', !fs.existsSync(path.join(D1, 'chat.ndjson')));
check('счётчик номеров переехал со своим значением',
  String(fs.readFileSync(path.join(D1, 'chat', GID + '.seq'), 'utf8')).trim() === '845');
check('прежнего chat-seq больше нет', !fs.existsSync(path.join(D1, 'chat-seq')));

if (!QUIET) console.log('\nвложения нашлись после переноса (все три каталога):');
for (const seq of Object.keys(WITH_ATT)) {
  const ext = WITH_ATT[seq], dir = home(ext);
  const p = path.join(D1, dir, GID, seq + '.' + ext);
  check(`${dir}/<gid>/${seq}.${ext} на месте и байты те же`,
    md5file(p) === md5(attBytes(Number(seq))), md5file(p));
}
for (const dir of ['att', 'voice', 'files']) {
  check(`в ${dir}/ не осталось файлов прежней раскладки`,
    !fs.readdirSync(path.join(D1, dir)).some(f => /^\d+\./.test(f)),
    fs.readdirSync(path.join(D1, dir)));
}
check('каждое вложение из журнала имеет файл в своём каталоге',
  seqsAfter.filter(s => WITH_ATT[s])
    .every(s => fs.existsSync(path.join(D1, home(WITH_ATT[s]), GID, s + '.' + WITH_ATT[s]))));
check('исходное имя файла осталось в записи журнала (на диске он под номером)',
  fs.readFileSync(J, 'utf8').includes(FILE_NAME)
  && !fs.readdirSync(path.join(D1, 'files', GID)).some(f => f.includes('смета')),
  fs.readdirSync(path.join(D1, 'files', GID)));
if (!QUIET) console.log('\nличность: installId прежний, рейтинг непрерывен:');
const members = readJson(path.join(D1, 'members.json')) || {};
const mid = Object.keys(members)[0] || '';
const me = members[mid] || {};
check('members.json заведён с одним участником', Object.keys(members).length === 1, Object.keys(members));
check('installId ВЗЯТ прежний, а не сгенерирован', me.installId === INSTALL, me.installId);
check('ник взят из среза', me.nick === NICK, me.nick);
check('токеном стал прежний общий секрет (лежит хешем)',
  me.tokenHash === crypto.createHash('sha256').update(SECRET).digest('hex'), me.tokenHash);
check('участник числится в группе-основании', Array.isArray(me.groups) && me.groups[0] === GID, me.groups);
check('запись живая (status active)', me.status === 'active', me.status);
const groups = readJson(path.join(D1, 'groups.json')) || {};
check('groups.json знает группу-основание', !!groups[GID], Object.keys(groups));
check('создатель группы — этот же участник', groups[GID] && groups[GID].createdBy === mid, groups[GID]);
check('invites.json создан пустым', JSON.stringify(readJson(path.join(D1, 'invites.json'))) === '{}');
check('файл среза не тронут (имя и байты те же)',
  md5file(path.join(D1, 'slices', INSTALL + '.json')) === SLICE_MD5,
  md5file(path.join(D1, 'slices', INSTALL + '.json')));
check('секрет в вывод не попал', !R1.out.includes(SECRET));
check('хеш токена в вывод не попал', !R1.out.includes(me.tokenHash || 'x'));

if (!QUIET) console.log('\nсоль адреса и мусор прежней соли:');
const salt = fs.existsSync(path.join(D1, 'addr-salt'))
  ? String(fs.readFileSync(path.join(D1, 'addr-salt'), 'utf8')).trim() : '';
check('addr-salt заведён отдельным файлом', /^[a-f0-9]{64}$/.test(salt), salt.slice(0, 12));
check('соль не равна секрету', salt !== SECRET);
check('slice-owners.json снесён', !fs.existsSync(path.join(D1, 'slice-owners.json')));
check('slice-drops.json снесён', !fs.existsSync(path.join(D1, 'slice-drops.json')));

if (!QUIET) console.log('\nснимок перед переходом:');
const snapDir = fs.readdirSync(D1).filter(f => /^migrate-/.test(f));
const baks = fs.readdirSync(D1).filter(f => /^chat-.+\.bak\.ndjson$/.test(f));
check('снимок журнала лежит именем chatBackup (chat-<штамп>.bak.ndjson)', baks.length === 3, baks);
check('в снимке журнала те же байты, что были',
  baks.map(f => md5file(path.join(D1, f))).includes(JOURNAL_MD5));
check('прежние снимки массовых удалений не тронуты',
  baks.filter(f => /^chat-2026-09-0[12]/.test(f)).length === 2, baks);
check('каталог снимка состояния один', snapDir.length === 1, snapDir);
const man = snapDir.length ? readJson(path.join(D1, snapDir[0], 'manifest.json')) : null;
check('манифест читается и знает gid, installId и номера',
  !!man && man.gid === GID && man.installId === INSTALL && man.journal.seqs.join(',') === SEQS.join(','), man && man.gid);
check('в снимке лежат копии файлов прежней соли',
  ['slice-owners.json', 'slice-drops.json', 'chat-seq', 'chat-gone.json']
    .every(f => fs.existsSync(path.join(D1, snapDir[0] || 'x', f))));

if (!QUIET) console.log('\nнадгробия: курсоры перенесены как есть:');
const tombs = readJson(path.join(D1, 'chat', GID + '.tombs.json'));
check('надгробия переехали в группу', !!tombs && tombs.tombs.length === 3, tombs && tombs.tombs.length);
check('форма файла — v2, как у приёмника', !!tombs && tombs.v === 2, tombs && tombs.v);
// Главное утверждение всей этой части: курсор НЕ перенумерован. Серверный `gseq`
// ниже запомненного клиентами = «перечитай хвост» у всех сразу, то есть переход
// выглядит как массовый сбой в момент, когда все считают его успешным.
check('gseq перенесён как есть (42, а не число записей)', !!tombs && tombs.gseq === 42, tombs && tombs.gseq);
check('cut перенесён как есть (7)', !!tombs && tombs.cut === 7, tombs && tombs.cut);
check('номера надгробий не перенумерованы',
  !!tombs && tombs.tombs.map(t => t.gseq).join(',') === '40,41,42', tombs && tombs.tombs.map(t => t.gseq));
check('номера снятых сообщений сохранены',
  !!tombs && tombs.tombs.map(t => t.seq).join(',') === '840,842,843', tombs && tombs.tombs.map(t => t.seq));
check('причина удаления сохранена',
  !!tombs && tombs.tombs.map(t => t.why).join(',') === 'one,mine,mine', tombs && tombs.tombs.map(t => t.why));
// Приёмник фильтрует записи по `Date.parse(at)`: время не строкой = надгробие
// молча выброшено на первом же чтении.
check('время — ISO-строка, разбираемая приёмником',
  !!tombs && tombs.tombs.every(t => typeof t.at === 'string' && Number.isFinite(Date.parse(t.at))),
  tombs && tombs.tombs.map(t => t.at));
check('в файл не уехала диагностика (только v, gseq, cut, tombs)',
  !!tombs && Object.keys(tombs).sort().join(',') === 'cut,gseq,tombs,v', tombs && Object.keys(tombs));
check('источник chat-gone.json оставлен на месте', fs.existsSync(path.join(D1, 'chat-gone.json')));
check('счёт надгробий назван в итоговой строке', /tombs=3 gseq=42/.test(R1.out));

// Файл ПЕРВОЙ версии: голый массив, время числом, номеров нет вовсе.
{
  const D = mkData([
    { seq: 840, at: T0 - 7200e3, why: 'one' },
    { seq: 842, at: T0 - 3600e3, why: 'mine' },
  ]);
  const r = run(D);
  const t = readJson(path.join(D, 'chat', gidOf(r.out) + '.tombs.json'));
  check('массив первой версии прочитан запасным путём', !!t && t.tombs.length === 2, t && t.tombs.length);
  check('время из миллисекунд стало ISO-строкой',
    !!t && t.tombs.every(x => typeof x.at === 'string' && Number.isFinite(Date.parse(x.at))),
    t && t.tombs.map(x => x.at));
  check('записям без своего gseq номера назначены (иначе приёмник их отбросит)',
    !!t && t.tombs.every(x => Number.isInteger(x.gseq) && x.gseq > 0) && t.gseq === 2,
    t && t.tombs.map(x => x.gseq));
  check('cut у файла первой версии — ноль, а не выдуманное число', !!t && t.cut === 0, t && t.cut);
  check('сказано, что читали файл первой версии', /первой версии/.test(r.out));
}
// Ключ `gone` — так файл назывался в первой правке; приёмник читает и его.
{
  const D = mkData({ gone: [{ seq: 900, at: new Date(T0).toISOString(), gseq: 17, why: 'all' }], gseq: 17, cut: 3 });
  const r = run(D);
  const t = readJson(path.join(D, 'chat', gidOf(r.out) + '.tombs.json'));
  check('объект с ключом gone прочитан, курсоры сохранены',
    !!t && t.tombs.length === 1 && t.gseq === 17 && t.cut === 3, t);
}
// ── 3. Идемпотентность ───────────────────────────────────────────────────────
// Проверяется не «второй прогон не упал», а отпечаток ВСЕГО каталога: удвоенный
// журнал, второй снимок, вторая группа и второй участник — всё это ловится здесь
// и только здесь.
if (!QUIET) console.log('\nповторный прогон ничего не меняет:');
const after1 = digest(D1).join('\n');
const R2 = run(D1);
const after2 = digest(D1).join('\n');
check('второй прогон выходит с нулём', R2.code === 0, R2.code);
check('второй прогон сказал, что делать нечего', /noop=1/.test(R2.out));
check('состояние каталога побитово то же, что после одного прогона', after1 === after2,
  after1.split('\n').filter(l => !after2.includes(l)).slice(0, 5));
check('второго снимка не появилось', fs.readdirSync(D1).filter(f => /^migrate-/.test(f)).length === 1);
check('журнал не удвоился', md5file(J) === JOURNAL_MD5);
const R3 = run(D1);
check('третий прогон тоже ничего не меняет', R3.code === 0 && digest(D1).join('\n') === after1);
check('gid между прогонами не сменился', gidOf(R2.out) === GID, gidOf(R2.out));
check('участник между прогонами не сменился',
  Object.keys(readJson(path.join(D1, 'members.json')) || {})[0] === mid);

// ── 4. Обратный ход ──────────────────────────────────────────────────────────
if (!QUIET) console.log('\nобратный ход:');
{
  const D = mkData();
  const before = digest(D).join('\n');
  const r1 = run(D);
  const gid = gidOf(r1.out);
  const rb = run(D, '--rollback');
  check('откат выходит с нулём', rb.code === 0, rb.code + ':' + rb.out.slice(-300));
  check('журнал вернулся на прежнее место байт в байт',
    md5file(path.join(D, 'chat.ndjson')) === JOURNAL_MD5, md5file(path.join(D, 'chat.ndjson')));
  check('счётчик вернулся', String(fs.readFileSync(path.join(D, 'chat-seq'), 'utf8')).trim() === '845');
  check('вложения вернулись каждое в свой каталог', Object.keys(WITH_ATT)
    .every(s => md5file(path.join(D, home(WITH_ATT[s]), s + '.' + WITH_ATT[s])) === md5(attBytes(Number(s)))));
  check('каталоги группы в att/, voice/ и files/ убраны (они опустели)',
    !['att', 'voice', 'files'].some(d => fs.existsSync(path.join(D, d, gid))));
  check('файлы прежней соли восстановлены из снимка',
    fs.existsSync(path.join(D, 'slice-owners.json')) && fs.existsSync(path.join(D, 'slice-drops.json')));
  check('новые файлы убраны', !['members.json', 'groups.json', 'invites.json', 'addr-salt']
    .some(f => fs.existsSync(path.join(D, f))));
  check('надгробия группы убраны, источник цел',
    !fs.existsSync(path.join(D, 'chat', gid + '.tombs.json')) && fs.existsSync(path.join(D, 'chat-gone.json')));
  check('снимок откат НЕ удалил', fs.readdirSync(D).filter(f => /^migrate-/.test(f)).length === 1);
  // Прежнее состояние плюс снимок — это и есть «вернулись»: снимок остаётся
  // намеренно, поэтому из отпечатка вычитаем ровно его две части, взяв имена из
  // манифеста, а не по дате (дата прогона меняется каждый день).
  const sdir = fs.readdirSync(D).find(f => /^migrate-/.test(f)) || 'x';
  const sman = readJson(path.join(D, sdir, 'manifest.json')) || {};
  const mine = l => l.startsWith(sdir + '/') || l.startsWith((sman.snapshotJournal || 'нет') + ' ');
  const now = digest(D).filter(l => !mine(l)).join('\n');
  check('всё прежнее на месте (кроме снимка, он остаётся намеренно)', now === before,
    now.split('\n').filter(l => !before.includes(l)).slice(0, 5));
  const r2 = run(D);
  check('после отката переход проходит снова', r2.code === 0 && /^[a-f0-9]{32}$/.test(gidOf(r2.out)), r2.code);
  check('после отката журнал снова в группе', md5file(path.join(D, 'chat', gidOf(r2.out) + '.ndjson')) === JOURNAL_MD5);
}
// ── 5. Оборванный посередине прогон ──────────────────────────────────────────
// Так это и выглядит в жизни: журнал уже переехал, одно вложение ещё нет, реестров
// нет. Доделывание обязано взять ТОТ ЖЕ gid — новый завёл бы вторую группу и оторвал
// историю от вложений.
if (!QUIET) console.log('\nдоделывание после обрыва:');
{
  const D = mkData();
  const gid = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  fs.mkdirSync(path.join(D, 'chat'), { recursive: true });
  fs.renameSync(path.join(D, 'chat.ndjson'), path.join(D, 'chat', gid + '.ndjson'));
  // Половина вложений уже переехала, звук и файл — ещё нет.
  fs.mkdirSync(path.join(D, 'att', gid), { recursive: true });
  fs.renameSync(path.join(D, 'att', '838.webp'), path.join(D, 'att', gid, '838.webp'));
  const r = run(D);
  check('доделывание выходит с нулём', r.code === 0, r.code + ':' + r.out.slice(-300));
  check('gid взят из уже перенесённого журнала, а не новый', gidOf(r.out) === gid, gidOf(r.out));
  check('журнал не тронут повторно', md5file(path.join(D, 'chat', gid + '.ndjson')) === JOURNAL_MD5);
  check('оставшиеся вложения доехали, включая звук и файл', Object.keys(WITH_ATT)
    .every(s => md5file(path.join(D, home(WITH_ATT[s]), gid, s + '.' + WITH_ATT[s])) === md5(attBytes(Number(s)))));
  check('реестры дописаны', !!readJson(path.join(D, 'members.json')) && !!readJson(path.join(D, 'groups.json')));
  check('второй журнал не появился', fs.readdirSync(path.join(D, 'chat')).filter(f => /\.ndjson$/.test(f)).length === 1,
    fs.readdirSync(path.join(D, 'chat')));
  const d1 = digest(D).join('\n');
  run(D);
  check('после доделывания повторный прогон снова пустой', digest(D).join('\n') === d1);
}

// ── 6. Отказы: чего скрипт делать не станет ──────────────────────────────────
if (!QUIET) console.log('\nотказы:');
{
  const D = mkData();
  fs.rmSync(path.join(D, 'slices', INSTALL + '.json'));
  const r = run(D);
  check('без среза installId не придумывается — отказ', r.code === 1, r.code);
  check('в отказе названа причина (рейтинг висит на installId)', /придумывать его нельзя/.test(r.out));
  check('после отказа каталог не тронут', !fs.existsSync(path.join(D, 'members.json'))
    && fs.existsSync(path.join(D, 'chat.ndjson')));
}
{
  const D = mkData();
  fs.writeFileSync(path.join(D, 'slices', 'ff'.repeat(8) + '.json'), JSON.stringify({ installId: 'ff'.repeat(8) }));
  const r = run(D);
  check('два среза без --install-id — отказ, а не угадывание', r.code === 1, r.code);
  const r2 = run(D, '--install-id=' + INSTALL);
  check('с явным --install-id проходит', r2.code === 0, r2.code);
  check('взят названный installId',
    (readJson(path.join(D, 'members.json')) || {})[Object.keys(readJson(path.join(D, 'members.json')))[0]].installId === INSTALL);
}
{
  const D = mkData();
  fs.rmSync(path.join(D, 'secret'));
  const r = run(D);
  check('без файла secret — отказ (токен выводить не из чего)', r.code === 1, r.code);
}
{
  const D = mkData();
  fs.mkdirSync(path.join(D, 'chat'), { recursive: true });
  fs.writeFileSync(path.join(D, 'chat', 'b'.repeat(32) + '.ndjson'), JOURNAL);
  const r = run(D);
  check('журнал и в старом, и в новом месте — отказ, склейки не будет', r.code === 1, r.code);
  check('прежний журнал при этом на месте', md5file(path.join(D, 'chat.ndjson')) === JOURNAL_MD5);
  check('на отказе снимок не заводится', !fs.readdirSync(D).some(f => /^migrate-/.test(f)));
}
{
  const r = run(path.join(ROOT, 'нет-такого-каталога'));
  check('несуществующий каталог данных — отказ', r.code === 1, r.code);
}
// ── 7. Нода, где чата не было вовсе ──────────────────────────────────────────
// Это не выдуманный случай: приёмник создаёт `secret` при первом старте, а журнал
// появляется только с первым сообщением. Переход обязан пройти и здесь, а не упасть
// на чтении файла, которого нет.
if (!QUIET) console.log('\nпереписки не было:');
{
  const D = mkData();
  for (const f of ['chat.ndjson', 'chat-seq', 'chat-gone.json']) fs.rmSync(path.join(D, f));
  for (const s of Object.keys(WITH_ATT)) fs.rmSync(path.join(D, home(WITH_ATT[s]), s + '.' + WITH_ATT[s]));
  const r = run(D);
  check('переход проходит и на пустом чате', r.code === 0, r.code + ':' + r.out.slice(-300));
  check('участник и группа всё равно заведены',
    !!readJson(path.join(D, 'members.json')) && !!readJson(path.join(D, 'groups.json')));
  check('снимка журнала нет — и об этом сказано прямо', /копировать было нечего|снимать нечего/.test(r.out));
  const d1 = digest(D).join('\n');
  const r2 = run(D);
  check('повторный прогон и здесь ничего не меняет', digest(D).join('\n') === d1 && /noop=1/.test(r2.out));
}

// ── 8. Выкат: сверка рецепта чистки и порядок выката ─────────────────────────
// Обе проверки — чистые функции выката, поэтому проверяются прямо, без ssh. Обе
// охраняют один и тот же класс поломки: «всё сошлось» при том, что не сошлось ничего.
if (!QUIET) console.log('\nвыкат: рецепт чистки сверяется по ВСЕМ трём правилам:');
const dep = require(DEPLOY);
const DATA = '/opt/league/data';
const RECIPE = ['e /opt/league/data/att - - - 30d', 'e /opt/league/data/voice - - - m:7d',
  'e /opt/league/data/files - - - m:30d'].join('\n') + '\n';
{
  check('разобраны все три правила, а не первое', dep.confRules(RECIPE).length === 3,
    dep.confRules(RECIPE).map(r => r.path));
  const v = dep.confVerdict(RECIPE, DATA);
  check('полный рецепт признан сошедшимся', v.ok && !v.missing.length && !v.foreign.length, v.missing);
  // Ровно то, что жило месяцами: правило на звук потерялось, а первое совпадает —
  // и чистка «работает», удаляя ноль файлов.
  const noVoice = RECIPE.split('\n').filter(l => !l.includes('/voice')).join('\n');
  const v2 = dep.confVerdict(noVoice, DATA);
  check('пропавшее правило на voice/ найдено', v2.missing.join(',') === `${DATA}/voice`, v2.missing);
  check('рецепт без voice/ не признан сошедшимся', !v2.ok);
  const noFiles = RECIPE.split('\n').filter(l => !l.includes('/files')).join('\n');
  check('пропавшее правило на files/ найдено',
    dep.confVerdict(noFiles, DATA).missing.join(',') === `${DATA}/files`);
  // Разъехался путь НЕ у первого правила: раньше это не проверялось вообще.
  const badVoice = RECIPE.replace('/opt/league/data/voice', '/opt/league/voice');
  const v3 = dep.confVerdict(badVoice, DATA);
  check('путь вне каталога данных найден даже во втором правиле',
    v3.foreign.length === 1 && v3.foreign[0].path === '/opt/league/voice', v3.foreign.map(r => r.path));
  check('рецепт с чужим путём не признан сошедшимся', !v3.ok);
  const p = dep.confPatch(RECIPE, '/srv/league');
  check('--patch-conf правит все три пути, а не один', p.done.length === 3, p.done);
  check('после правки вердикт сходится с новым каталогом', dep.confVerdict(p.text, '/srv/league').ok);
  check('правило на каталог вне данных не выдаётся за наше',
    dep.confVerdict('e /var/tmp/att - - - 30d\n', DATA).foreign.length === 1);
  check('в живом рецепте репозитория все три правила на месте',
    dep.confVerdict(fs.readFileSync(path.join(__dirname, '..', 'routing', 'league-chat-tmpfiles.conf'), 'utf8'),
      DATA).ok);
}

if (!QUIET) console.log('\nвыкат: плоский приёмник на групповые данные = отказ:');
{
  const FLAT_SRC = 'const CHAT_FILE = path.join(DATA, "chat.ndjson"); const ATT_DIR = "att";';
  const GROUP_SRC = FLAT_SRC + ' const MEMBERS = path.join(DATA, "members.json");';
  const GROUP = { group: true, flat: false, groupChat: true, members: true };
  const OLD = { group: false, flat: true, groupChat: false, members: false };
  // Главный случай: данные уже групповые, код плоский. Молчаливая поломка у ВСЕХ:
  // счётчик восстанавливается с нуля, новые номера 1,2,3 ниже курсоров клиентов,
  // выдача отдаёт только «больше курсора» — пустой чат без единой ошибки.
  check('групповые данные + плоский приёмник = stop',
    dep.layoutVerdict(FLAT_SRC, GROUP, false).level === 'stop',
    dep.layoutVerdict(FLAT_SRC, GROUP, false));
  check('в причине названа раскладка, а не «что-то не так»',
    /групповой раскладке/.test(dep.layoutVerdict(FLAT_SRC, GROUP, false).why));
  check('--migrate с плоским приёмником = stop (перевёл бы данные под него же)',
    dep.layoutVerdict(FLAT_SRC, OLD, true).level === 'stop');
  // Обратный порядок шумит сам (приёмник поднимется с пустым чатом) — ему хватает
  // предупреждения, тем более что бутстрап у приёмника может быть свой.
  // Обратный порядок — ШТАТНЫЙ промежуточный шаг: групповой приёмник обязан читать и
  // прежнюю раскладку, поэтому чат не пустеет. Предупреждение остаётся напоминанием,
  // что перевод не сделан, но текст не должен читаться как авария в момент выката.
  check('групповой приёмник + прежние данные = warn', dep.layoutVerdict(GROUP_SRC, OLD, false).level === 'warn');
  check('в тексте сказано, что это ожидаемый шаг и чат не пустеет',
    /ожидаемый/.test(dep.layoutVerdict(GROUP_SRC, OLD, false).why)
    && /не пустеет/.test(dep.layoutVerdict(GROUP_SRC, OLD, false).why),
    dep.layoutVerdict(GROUP_SRC, OLD, false).why);
  check('в тексте назван следующий шаг — перевод данных отдельной командой',
    /перевод данных/.test(dep.layoutVerdict(GROUP_SRC, OLD, false).why));
  check('групповой приёмник + групповые данные = ok', dep.layoutVerdict(GROUP_SRC, GROUP, false).level === 'ok');
  check('плоский приёмник + прежние данные = ok (сегодняшняя норма)',
    dep.layoutVerdict(FLAT_SRC, OLD, false).level === 'ok');
  check('групповой приёмник + --migrate + прежние данные = ok (это и есть правильный порядок)',
    dep.layoutVerdict(GROUP_SRC, OLD, true).level === 'ok');
  check('признак «знает про группы» ловит и tombs.json, и groups.json',
    dep.SRC_KNOWS_GROUPS.test('chat/<gid>.tombs.json') && dep.SRC_KNOWS_GROUPS.test('groups.json')
    && !dep.SRC_KNOWS_GROUPS.test(FLAT_SRC));
  // Половинное состояние после оборванного перехода — тоже «группа»: данные тронуты.
  check('половинная раскладка (журнал в группе, members.json ещё нет) считается групповой',
    dep.layoutVerdict(FLAT_SRC, { group: true, flat: true, groupChat: true, members: false }, false).level === 'stop');
}

// ── 9. Условие совместимости: групповой приёмник обязан читать ПРЕЖНЮЮ раскладку ──
// От этого условия зависит текст вердикта выше. Пока приёмник плоский, проверять нечего —
// и об этом говорится прямо, а не молчаливым «зелёно». Как только приёмник узнает про
// группы, проверка включается сама и поднимает НАСТОЯЩИЙ приёмник на прежней раскладке.
// Утверждается ровно то, что обещано владельцу: процесс встаёт и данные не портит. Форму
// запроса чата не закрепляем — она по дизайну меняется (старый `GET /chat?since=0` обязан
// начать отвечать 400), и тест не должен запрещать эту правку.
if (!QUIET) {
  console.log('\nсовместимость: приёмник на прежней раскладке:');
  const RECV = process.env.RECEIVER_JS || path.join(__dirname, '..', 'routing', 'league-receiver.js');
  const src = fs.existsSync(RECV) ? fs.readFileSync(RECV, 'utf8') : '';
  if (!dep.SRC_KNOWS_GROUPS.test(src)) {
    check('приёмник ещё плоский — совместимость проверять не на чем (включится сама)', true);
  } else {
    const D = mkData();
    const before = md5file(path.join(D, 'chat.ndjson'));
    const port = 8300 + Math.floor(Math.random() * 600);
    // Вывод приёмника пишем В ФАЙЛ, а не в поток: весь этот тест синхронный, и пока он
    // ждёт пробу, обработчики `on('data')` физически не могут сработать — журнал остался
    // бы пустым, а причина падения невидимой.
    const logFile = path.join(D, 'receiver.log');
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [RECV, String(port), D],
      { stdio: ['ignore', fd, fd], windowsHide: true });
    // Пробу делает отдельный процесс: весь этот тест синхронный, а ждать поднятия надо.
    const probe = spawnSync(process.execPath, ['-e', `
      const p = ${port};
      (async () => {
        for (let i = 0; i < 80; i++) {
          await new Promise(r => setTimeout(r, 100));
          try {
            const h = await fetch('http://127.0.0.1:' + p + '/health');
            if (!h.ok) continue;
            const body = await h.text();
            let chat = '';
            try {
              const c = await fetch('http://127.0.0.1:' + p + '/chat?since=0',
                { headers: { 'X-League-Key': process.argv[1] } });
              chat = c.status + ' ' + (await c.text()).slice(0, 200);
            } catch (e) { chat = 'ошибка: ' + e.message; }
            console.log('UP ' + body.slice(0, 200) + '\\nCHAT ' + chat);
            process.exit(0);
          } catch { /* ещё не поднялся */ }
        }
        console.log('DOWN');
        process.exit(1);
      })();`, String(fs.readFileSync(path.join(D, 'secret'), 'utf8')).trim()],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    child.kill();
    fs.closeSync(fd);
    // Пауза перед продолжением: без неё libuv на Windows роняет ассерт на закрытии
    // хендла убитого ребёнка — выглядит как провал теста, хотя это не он.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    const out = String(probe.stdout || '');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('приёмник ПОДНЯЛСЯ на прежней раскладке (это условие его выката)',
      /^UP /m.test(out), (out + '\n' + log + String(probe.stderr || '')).slice(0, 500));
    check('прежний журнал не тронут при старте', md5file(path.join(D, 'chat.ndjson')) === before);
    check('в журнале приёмника нет ошибки старта', !/Error|throw|ошибка при старте/.test(log), log.slice(0, 300));
    console.log('    ответ на старую форму запроса чата: '
      + (/^CHAT (.*)$/m.exec(out) || [, '(нет)'])[1]);
  }
}

// ── 10. Мутации: убери правку — тест обязан покраснеть ───────────────────────
// Проверка, которая не падает от порчи проверяемого кода, охраняет не код, а сама
// себя. Каждая мутация — это ровно та небрежность, из-за которой переход и делается
// скриптом, а не руками.
const MUTANTS = [
  ['перенумеровать сообщения с единицы',
    'fs.renameSync(P.chatOld, dst);',
    'fs.writeFileSync(dst, fs.readFileSync(P.chatOld, "utf8").split("\\n").filter(Boolean)'
    + '.map((l, i) => JSON.stringify({ ...JSON.parse(l), seq: i + 1 })).join("\\n") + "\\n");'
    + ' fs.rmSync(P.chatOld);'],
  ['не переносить вложения вообще', 'for (const key of ATT_DIRS) {', 'for (const key of []) {'],
  // Ровно тот дефект, из-за которого правка и понадобилась: знали про `att/`, а звук
  // и файлы лежат в своих каталогах.
  ['не переносить voice/', "const ATT_DIRS = ['att', 'voice', 'files'];", "const ATT_DIRS = ['att', 'files'];"],
  ['сгенерировать installId заново',
    "  const id = files[0].replace(/\\.json$/, '');",
    "  const id = crypto.randomBytes(8).toString('hex');"],
  ['не делать снимок журнала',
    "fs.writeFileSync(path.join(DATA, bak), raw);",
    "fs.writeFileSync(path.join(DATA, bak), Buffer.alloc(0));"],
  ['оставить slice-owners и slice-drops', '    fs.rmSync(f);\n    okk(`${path.basename(f)} снесён', '    okk(`${path.basename(f)} снесён'],
  ['не заводить соль адреса', "writeAtomic(P.salt, crypto.randomBytes(32).toString('hex') + '\\n', 0o600);", ''],
  // gid ищется в двух местах (реестр групп и уже перенесённый журнал) — это
  // осознанное дублирование, поэтому мутация обязана снять оба сразу: убрав одно,
  // поведение не меняется, и «зелёный тест» тут говорит правду.
  ['новый gid на каждом прогоне',
    '  const g = readJson(P.groups, null);',
    "  return { gid: crypto.randomBytes(16).toString('hex'), from: 'мутация' };\n"
    + '  const g = readJson(P.groups, null);'],
  ['потерять значение счётчика номеров',
    'const value = Math.max(fromOld, fromNew, info.journal ? info.journal.last : 0, 0);',
    'const value = 1;'],
  ['не гасить прежний журнал (второй прогон удвоит)',
    'fs.renameSync(P.chatOld, dst);', 'fs.copyFileSync(P.chatOld, dst);'],
  // Тихая поломка у всех сразу: курсор ниже запомненного клиентами = «перечитай хвост».
  ['перенумеровать надгробия заново (gseq и cut с нуля)',
    '      gseq: Math.max(Number(isObj ? raw.gseq : 0) || 0, top, 0),\n'
    + '      cut: Math.max(Number(isObj ? raw.cut : 0) || 0, 0),',
    '      gseq: kept.length,\n      cut: 0,'],
  ['оставить время надгробия числом (приёмник молча отбросит)',
    '    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;',
    '    return Number.isFinite(ms) ? t.at : null;'],
  // Мутации выката. Четвёртое поле — какой файл портить.
  ['выкат: сверять только первое правило чистки',
    "    if (m) out.push({ type: m[1], path: m[2].replace(/\\/+$/, ''), rest: m[3].trim() });",
    "    if (m && !out.length) out.push({ type: m[1], path: m[2].replace(/\\/+$/, ''), rest: m[3].trim() });",
    'deploy'],
  ['выкат: плоский приёмник на групповые данные — только предупреждение',
    "    return { level: 'stop', knows, why: layout.group",
    "    return { level: 'warn', knows, why: layout.group",
    'deploy'],
];
if (process.argv.includes('--mutants')) {
  console.log('\nмутации (ожидается ❌ у каждой):');
  const SRC = { migrate: fs.readFileSync(MIGRATE, 'utf8'), deploy: fs.readFileSync(DEPLOY, 'utf8') };
  const ENV = { migrate: 'MIGRATE_JS', deploy: 'DEPLOY_JS' };
  const rows = [];
  for (const [name, from, to, target = 'migrate'] of MUTANTS) {
    const src = SRC[target];
    if (!src.includes(from)) { rows.push([name, 'НЕ НАЙДЕНО', '—']); continue; }
    const f = path.join(ROOT, `mutant-${rows.length}-${target}.js`);
    fs.writeFileSync(f, src.replace(from, to));
    const r = spawnSync(process.execPath, [__filename],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, [ENV[target]]: f } });
    const failed = (String(r.stdout || '').match(/❌/g) || []).length;
    rows.push([name, r.status === 0 ? 'ЗЕЛЁНЫЙ — плохо' : 'покраснел', String(failed)]);
  }
  const w = Math.max(...rows.map(r => r[0].length));
  console.log('\n| ' + 'что сломано'.padEnd(w) + ' | тест           | ❌ |');
  console.log('|-' + '-'.repeat(w) + '-|----------------|----|');
  for (const [n, s, c] of rows) console.log(`| ${n.padEnd(w)} | ${s.padEnd(14)} | ${c.padStart(2)} |`);
  const holes = rows.filter(r => r[1] !== 'покраснел');
  console.log(holes.length ? `\n⛔ мутаций не поймано: ${holes.length}` : '\n✅ каждая мутация поймана');
  process.exit(holes.length ? 1 : 0);
}

console.log(`\nитог: ${ok} прошло, ${bad} упало`);
process.exit(bad ? 1 : 0);
