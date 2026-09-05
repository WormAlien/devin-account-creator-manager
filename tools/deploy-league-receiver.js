#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  deploy-league-receiver.js — выкат приёмника «Лиги» на ноду и откат назад.
//
//  Порядок шагов, и на первом непонятном ответе скрипт ОСТАНАВЛИВАЕТСЯ:
//    1. локальный файл: синтаксис (node --check), md5, размер, переводы строк;
//    2. с ноды читается живой юнит, из него вытаскивается DATA — каталог данных;
//    3. проба раскладки данных на ноде и сверка её с выкатываемым кодом: приёмник без
//       групп на групповые данные — ОТКАЗ до первого изменения (иначе чат пустеет молча);
//    4. все три правила league-chat-tmpfiles.conf сверяются со своими каталогами;
//    5. бэкап прежнего файла со штампом времени + сверка md5 бэкапа;
//    6. копия во временное имя → сверка md5 с локальным → только потом mv;
//    7. tmpfiles-рецепт в /etc/tmpfiles.d/ + сверка md5;
//    8. systemd-tmpfiles-clean.timer: тикает или нет — говорится прямо;
//    9. с --migrate: переход данных на групповую раскладку (league-migrate.js);
//   10. daemon-reload + restart, ожидание is-active и GET /health на ноде;
//   11. хвост журнала и готовая команда отката.
//
//  --dry-run НЕ ОТКРЫВАЕТ СОЕДИНЕНИЕ ВООБЩЕ. Печатает план и локальные факты;
//  шаги, которым нужны данные с ноды, помечены. Так «сухой прогон» безопасен и
//  когда ноды нет под рукой, и когда её трогать нельзя.
//
//  --rollback возвращает последний бэкап (или --backup=<имя>), предварительно
//  сняв бэкап того, что лежит сейчас: откат тоже обязан быть обратимым.
//
//  Зависимостей ноль. Нужны только ssh и scp в PATH.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ARGV = process.argv.slice(2);
const has = n => ARGV.includes('--' + n);
const opt = (n, d) => {
  const p = `--${n}=`;
  const hit = ARGV.find(a => a.startsWith(p));
  return hit === undefined ? d : hit.slice(p.length);
};

const ROOT = path.join(__dirname, '..');
const DRY = has('dry-run');
const ROLLBACK = has('rollback');

// Дефолты — швейцарская нода (та же, что алиас `ch` в ~/.ssh/config).
const C = {
  host: opt('host', '185.114.117.145'),
  port: opt('port', '333'),
  user: opt('user', 'root'),
  key: opt('key', path.join(os.homedir(), '.ssh', 'xgate2')),
  alias: opt('alias', ''),                   // --alias=ch → ssh ch, без -i/-p
  remote: opt('remote', '/opt/league/league-receiver.js'),
  data: opt('data', '/opt/league/data'),     // сверяется с живым юнитом
  backups: opt('backups', '/opt/league/backup'),
  unit: opt('unit', 'league-receiver'),
  healthPort: opt('health-port', '8420'),
  confName: opt('conf-name', 'league-chat.conf'),
  src: opt('src', path.join(ROOT, 'routing', 'league-receiver.js')),
  conf: opt('conf', ''),
  backup: opt('backup', ''),
};
if (has('help') || has('h')) {
  console.log(`выкат приёмника лиги на ноду

  node tools/deploy-league-receiver.js [--dry-run] [--rollback] [опции]

  --dry-run            напечатать план и не делать ничего (соединения не будет)
  --rollback           вернуть последний бэкап (или --backup=<имя файла>)
  --migrate            ПЛЮС перевести данные в групповую раскладку (см. ниже)
  --rollback-data      при откате вернуть и раскладку данных
  --list-backups       показать бэкапы на ноде и выйти
  --skip-conf          не трогать /etc/tmpfiles.d/${C.confName}
  --patch-conf         поправить путь внутри рецепта под фактический DATA ноды
  --no-restart         скопировать, но не перезапускать сервис
  --force-layout       подавить отказ по несовпадению кода и раскладки данных

  --host=${C.host}   --port=${C.port}   --user=${C.user}
  --key=<путь к ключу>          по умолчанию ~/.ssh/xgate2
  --alias=ch                    ходить через алиас ssh вместо host/port/key
  --remote=${C.remote}
  --data=${C.data}          каталог данных (сверяется с юнитом)
  --backups=${C.backups}
  --unit=${C.unit}   --health-port=${C.healthPort}
  --src=<локальный league-receiver.js>
  --conf=<локальный league-chat-tmpfiles.conf>

  Пути на ноде — абсолютные. Из git-bash запускать с MSYS_NO_PATHCONV=1,
  иначе bash перепишет /opt/... в D:/git/opt/... и скрипт остановится.

  --migrate: переход данных на групповую раскладку. Отдельным флагом намеренно —
  выкат кода и перевод данных это разные решения, и второе необратимо дороже.
  Порядок внутри шага: сухой прогон перехода на ноде (читает, ничего не меняет) →
  systemctl stop (пока сервис жив, он пишет в старый журнал) → снимок и перенос →
  дальше обычный рестарт этим же скриптом. Каталог данных берётся ИЗ ЮНИТА.
  Переезжают: журнал, счётчик, надгробия и ВСЕ ТРИ каталога вложений (att, voice,
  files — у них разные сроки хранения, поэтому они и разные).
  Сам переход делает tools/league-migrate.js; его регресс — tools/check-league-migrate.js.`);
  process.exit(0);
}

// ── Печать ───────────────────────────────────────────────────────────────────
let stepNo = 0;
const step = m => console.log(`\n[${++stepNo}] ${m}`);
const say = m => console.log('    ' + m);
const okk = m => console.log('    ✅ ' + m);
const warn = m => console.log('    ⚠️  ' + m);
function stop(msg) {
  console.log('\n⛔ ' + msg);
  console.log('   Дальше этого шага нода не менялась. Разбирайся и запускай снова.');
  process.exit(1);
}

// Пути на ноде и имя юнита подставляются в команду для удалённого shell. Проверка
// не косметическая: под git-bash MSYS переписывает аргументы, похожие на пути
// (`/opt/league` → `D:/git/opt/league`), и без этой проверки скрипт бы бодро
// скопировал файл в никуда. Заодно закрывает подстановку чего угодно в команду.
const PATH_RE = /^\/[A-Za-z0-9._\-/]+$/;
const NAME_RE = /^[A-Za-z0-9._@-]+$/;
for (const [k, v] of [['remote', C.remote], ['data', C.data], ['backups', C.backups]]) {
  if (!PATH_RE.test(v)) {
    stop(`--${k}=${v} — это не абсолютный путь на ноде.`
      + ' Если запускал из git-bash, добавь MSYS_NO_PATHCONV=1.');
  }
}
for (const [k, v] of [['unit', C.unit], ['conf-name', C.confName], ['port', C.port],
  ['health-port', C.healthPort], ['user', C.user]]) {
  if (!NAME_RE.test(v)) stop(`--${k}=${v} — недопустимое значение`);
}
if (C.backup && !NAME_RE.test(C.backup)) stop(`--backup=${C.backup} — только имя файла, без путей`);
// ── ssh / scp ────────────────────────────────────────────────────────────────
// BatchMode=yes обязателен: без него ssh на незнакомом host key или на ключе с
// парольной фразой уходит в интерактивный вопрос, а скрипт запускают неглядя —
// он бы висел молча. Пусть лучше падает с внятной ошибкой.
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
const target = () => (C.alias ? [C.alias] : ['-i', C.key, '-p', String(C.port), `${C.user}@${C.host}`]);
const scpTarget = () => (C.alias ? [] : ['-i', C.key, '-P', String(C.port)]);
const scpHost = p => (C.alias ? `${C.alias}:${p}` : `${C.user}@${C.host}:${p}`);
const where = () => (C.alias ? `ssh ${C.alias}` : `ssh -i ${C.key} -p ${C.port} ${C.user}@${C.host}`);

// Возвращает { code, out, err } и НИЧЕГО не решает сам: где нулевой код обязателен,
// решает вызывающий (`run`), а где ненулевой осмысленен — смотрит сам (is-active,
// md5sum отсутствующего файла, is-enabled у static-таймера).
function sshRaw(cmd) {
  const r = spawnSync('ssh', [...SSH_OPTS, ...target(), cmd],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.error) {
    if (r.error.code === 'ENOENT') stop('в PATH нет ssh — поставь OpenSSH client или запусти из git-bash');
    stop(`ssh не запустился: ${r.error.message}`);
  }
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function run(label, cmd) {
  const r = sshRaw(cmd);
  if (r.code !== 0) {
    stop(`${label}: ssh вернул код ${r.code}\n   команда: ${cmd}\n   stdout: ${r.out.trim()}\n   stderr: ${r.err.trim()}`);
  }
  return r.out;
}
function scpUp(localFile, remotePath) {
  const r = spawnSync('scp', [...SSH_OPTS, ...scpTarget(), localFile, scpHost(remotePath)],
    { encoding: 'utf8', windowsHide: true });
  if (r.error) stop(`scp не запустился: ${r.error.message}`);
  if (r.status !== 0) {
    stop(`копирование ${path.basename(localFile)} → ${remotePath} не прошло (код ${r.status})`
      + `\n   stderr: ${String(r.stderr || '').trim()}`);
  }
}

// ── Локальные факты ──────────────────────────────────────────────────────────
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
function localFacts(file, whatFor) {
  if (!fs.existsSync(file)) stop(`нет локального файла ${whatFor}: ${file}`);
  const buf = fs.readFileSync(file);
  let crlf = 0, lone = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { if (i > 0 && buf[i - 1] === 13) crlf++; else lone++; }
  }
  return { file, buf, md5: md5(buf), size: buf.length, crlf, lone };
}
// Рецепт tmpfiles ищем там, где его могли положить: рядом с приёмником, в configs/
// или в корне. Своей копии этот скрипт не завозит намеренно — два файла с одной
// строкой чистки однажды разъедутся, и никто не поймёт, какой из них поставлен.
function findConf() {
  if (C.conf) return fs.existsSync(C.conf) ? C.conf : null;
  for (const p of [path.join(ROOT, 'routing', 'league-chat-tmpfiles.conf'),
    path.join(ROOT, 'configs', 'league-chat-tmpfiles.conf'),
    path.join(ROOT, 'league-chat-tmpfiles.conf')]) if (fs.existsSync(p)) return p;
  return null;
}
// ── Рецепт чистки: ТРИ правила, а не одно ────────────────────────────────────
// Каталогов вложений три, и у каждого свой срок хранения: картинки 30 суток,
// голосовые 7, произвольные файлы 30. Разные сроки — единственная причина, по
// которой каталоги разные (tmpfiles умеет срок только на путь целиком).
// 🔴 Пока здесь сверялось ПЕРВОЕ совпадение, разъехавшийся путь у звука или файлов
// не заметил бы никто: чистка отчитывалась бы об успехе, удаляя ноль файлов. Ровно
// на этом в проекте уже сидели месяцами.
const ATT_DIRS = ['att', 'voice', 'files'];
// Все правила рецепта, а не первое. Строка вида `e /opt/league/data/voice - - - m:7d`;
// всё остальное в файле — комментарии.
function confRules(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([a-zA-Z])\+?\s+(\/[^\s]+)\s*(.*)$/.exec(line);
    if (m) out.push({ type: m[1], path: m[2].replace(/\/+$/, ''), rest: m[3].trim() });
  }
  return out;
}
// Вердикт по рецепту относительно ЖИВОГО каталога данных. Ничего не решает сам:
// решает вызывающий — так эту функцию можно проверить тестом, не поднимая ssh.
//   missing — каталог есть, а правила на него нет: он будет расти вечно;
//   foreign — правило чистит путь ВНЕ каталога данных: гладит пустоту;
//   extra   — путь внутри данных, но не наш: не наше дело, но сказать надо.
function confVerdict(text, DATA) {
  const data = String(DATA).replace(/\/+$/, '');
  const want = ATT_DIRS.map(d => `${data}/${d}`);
  const rules = confRules(text);
  const paths = rules.map(r => r.path);
  return {
    rules,
    want,
    missing: want.filter(w => !paths.includes(w)),
    foreign: rules.filter(r => r.path !== data && !r.path.startsWith(data + '/')),
    extra: rules.filter(r => r.path.startsWith(data + '/') && !want.includes(r.path)),
    ok: want.every(w => paths.includes(w)) && !rules.some(r => r.path !== data && !r.path.startsWith(data + '/')),
  };
}
// Правка путей под фактический DATA — тоже по ВСЕМ правилам. Чинит только
// расхождение каталога; отсутствующее правило дописать нечем, и врать об этом нельзя.
function confPatch(text, DATA) {
  const data = String(DATA).replace(/\/+$/, '');
  let out = String(text);
  const done = [];
  for (const r of confRules(out)) {
    const base = r.path.split('/').pop();
    if (!ATT_DIRS.includes(base)) continue;
    const want = `${data}/${base}`;
    if (r.path === want) continue;
    out = out.split(r.path).join(want);
    done.push(`${r.path} → ${want}`);
  }
  return { text: out, done };
}
function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, err: String(r.stderr || '').trim().split('\n').slice(0, 4).join('\n') };
}
// ── Порядок выката: код и раскладка данных обязаны совпадать ──────────────────
// Приёмник, знающий про группы, и данные в групповой раскладке — это ДВЕ половины
// одного целого, и любая половина без второй ломает чат МОЛЧА.
//
// 🔴 Опасная половина — «данные групповые, приёмник плоский». Цепочка: журнала на
// прежнем месте нет → восстановление счётчика даёт последний номер 0 → новые
// сообщения получают 1, 2, 3 → они НИЖЕ курсоров всех клиентов, а выдача отдаёт
// только «номер больше курсора» → у всех пустой чат, и ни одной ошибки нигде.
// Поэтому здесь отказ, а не предупреждение: догадка дороже остановки.
//
// Обратная половина — «приёмник групповой, данные плоские» — это ШТАТНЫЙ промежуточный
// шаг, а не тревога: групповой приёмник обязан подниматься и на прежней раскладке (это
// условие его выката), поэтому чат продолжает работать как раньше. Порядок такой и
// задуман: сначала код на прежних данных, потом перевод отдельной командой. Вердикт
// остаётся предупреждением — как напоминание, что перевод ещё не сделан.
// 🪤 Если однажды групповой приёмник ПЕРЕСТАНЕТ читать прежнюю раскладку, это условие
// нарушено, и здесь должен появиться отказ. Проверка на это живёт в
// `tools/check-league-migrate.js` и включается сама, как только приёмник узнает про группы.
const SRC_KNOWS_GROUPS = /members\.json|tombs\.json|groups\.json/;
function layoutVerdict(srcText, layout, wantMigrate) {
  const knows = SRC_KNOWS_GROUPS.test(String(srcText));
  if (!knows && (layout.group || wantMigrate)) {
    return { level: 'stop', knows, why: layout.group
      ? 'данные на ноде уже в групповой раскладке, а выкатываемый приёмник про группы не знает'
      : '--migrate переведёт данные, а выкатываемый приёмник про группы не знает' };
  }
  if (knows && !layout.group && !wantMigrate) {
    return { level: 'warn', knows,
      why: 'приёмник знает про группы, а данные ещё в прежней раскладке — это ожидаемый'
        + ' промежуточный шаг, чат не пустеет; перевод данных идёт отдельной командой' };
  }
  return { level: 'ok', knows, why: knows
    ? 'приёмник знает про группы, данные тоже групповые'
    : 'и приёмник, и данные в прежней раскладке' };
}

const TMP_JS = C.remote + '.new';
const CONF_DEST = `/etc/tmpfiles.d/${C.confName}`;

// ── Сухой прогон: только план, ни одного соединения ──────────────────────────
function dryRun() {
  const js = localFacts(C.src, 'приёмника');
  const conf = findConf();
  const confFacts = conf ? localFacts(conf, 'рецепта tmpfiles') : null;
  const data = C.data.replace(/\/+$/, '');
  const verdict = confFacts ? confVerdict(confFacts.buf.toString('utf8'), data) : null;
  const chk = nodeCheck(C.src);

  console.log('СУХОЙ ПРОГОН. Ни одного соединения с нодой не открыто, ничего не изменено.\n');
  console.log(`цель:        ${where()}`);
  console.log(`приёмник:    ${C.src}`);
  console.log(`             md5 ${js.md5}, ${js.size} Б, переводы строк: CRLF ${js.crlf} / LF ${js.lone}`);
  console.log(`             node --check: ${chk.ok ? 'синтаксис в порядке' : 'СИНТАКСИС СЛОМАН'}`);
  if (!chk.ok) console.log('             ' + chk.err.replace(/\n/g, '\n             '));
  console.log(`             про группы ${SRC_KNOWS_GROUPS.test(js.buf.toString('utf8')) ? 'знает' : 'НЕ знает'}`
    + ' (по упоминанию members.json / groups.json / tombs.json)');
  console.log(`рецепт:      ${conf || '— не найден, шаг 6 будет пропущен'}`);
  if (verdict) {
    console.log(`             md5 ${confFacts.md5}, правил ${verdict.rules.length}`);
    for (const r of verdict.rules) {
      const mark = verdict.want.includes(r.path) ? '✅' : (verdict.foreign.includes(r) ? '⛔' : '· ');
      console.log(`             ${mark} ${r.type} ${r.path} ${r.rest}`);
    }
  }
  console.log(`ожидаемые каталоги вложений: ${ATT_DIRS.map(d => `${data}/${d}`).join(', ')}`);
  if (has('migrate')) {
    const m = localFacts(path.join(__dirname, 'league-migrate.js'), 'скрипта перехода');
    const mc = nodeCheck(path.join(__dirname, 'league-migrate.js'));
    console.log(`переход:     ${path.join(__dirname, 'league-migrate.js')}`);
    console.log(`             md5 ${m.md5}, ${m.size} Б, node --check: ${mc.ok ? 'в порядке' : 'СЛОМАН'}`);
    console.log('             регресс перехода: node tools/check-league-migrate.js');
  }
  if (verdict && verdict.missing.length) {
    console.log('\n⚠️  В рецепте НЕТ правила на ' + verdict.missing.join(', ') + '.');
    console.log('    Этот каталог не будет чиститься никогда. На живом прогоне — остановка.');
  }
  if (verdict && verdict.foreign.length) {
    console.log('\n⚠️  Правило чистит путь ВНЕ каталога данных: '
      + verdict.foreign.map(r => r.path).join(', '));
    console.log('    На живом прогоне скрипт возьмёт DATA из юнита и остановится,');
    console.log('    если расхождение подтвердится. Обойти осознанно: --patch-conf.');
  }
  if (js.crlf > 0) {
    console.log('\n⚠️  В файле CRLF. Для `node file.js` это безразлично, но если юнит');
    console.log('    зовёт файл напрямую по shebang — `\\r` в первой строке его убьёт.');
  }
  console.log(`\nчто будет сделано на ноде (${ROLLBACK ? 'ОТКАТ' : 'выкат'}):`);
  const lines = ROLLBACK ? [
    `ls -1t ${C.backups}/  — выбрать ${C.backup || 'самый свежий'} бэкап`,
    `node --check <бэкап>  — не возвращать заведомо битый файл`,
    `cp -p ${C.remote} ${C.backups}/<штамп>.pre-rollback.bak  — откат обратим`,
    `cp <бэкап> ${TMP_JS} && md5sum  — сверка с md5 бэкапа`,
    `mv ${TMP_JS} ${C.remote} && chmod <прежний режим>`,
    has('rollback-data') ? `(--rollback-data) stop; league-migrate.js <DATA> --rollback; снимок не удаляется`
      : `(без --rollback-data) раскладка данных остаётся групповой`,
    `systemctl restart ${C.unit}; is-active; GET /health`,
  ] : [
    `systemctl cat ${C.unit}  — вытащить DATA и ExecStart (нужны данные ноды)`,
    'проба раскладки данных: members.json / chat.ndjson / chat/*.ndjson  — и сверка её'
      + ' с тем, знает ли выкатываемый приёмник про группы (иначе отказ ДО копирования)',
    `stat -c %a ${C.remote}; md5sum ${C.remote}  — режим и md5 прежнего файла`,
    `mkdir -p ${C.backups}; cp -p ${C.remote} ${C.backups}/league-receiver.js.<штамп>.bak; md5sum`,
    `scp ${path.basename(C.src)} → ${TMP_JS}; md5sum должен дать ${js.md5}`,
    `mv ${TMP_JS} ${C.remote}; chmod <прежний режим>`,
    has('skip-conf') ? `(--skip-conf) рецепт tmpfiles не трогаем`
      : `scp рецепт → /tmp/${C.confName}; install -m 0644 → ${CONF_DEST}; md5sum`,
    `systemctl is-enabled/is-active systemd-tmpfiles-clean.timer  — тикает ли чистка`,
    has('migrate')
      ? `scp tools/league-migrate.js → ${MIGRATE_REMOTE}; сухой прогон; systemctl stop ${C.unit};`
        + ' снимок + перенос журнала в chat/<gid>.ndjson, вложений в att/<gid>/, voice/<gid>/ и'
        + ' files/<gid>/, надгробий в chat/<gid>.tombs.json, снос slice-owners/drops'
      : `(без --migrate) данные не трогаем; шаг только скажет, в какой они раскладке`,
    has('no-restart') ? `(--no-restart) сервис не перезапускаем`
      : `systemctl daemon-reload; systemctl restart ${C.unit}; is-active; /health на 127.0.0.1:${C.healthPort}`,
    `journalctl -u ${C.unit} -n 20 --no-pager  — хвост журнала`,
  ];
  lines.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
  console.log('\nЖивой прогон — та же команда без --dry-run.');
  process.exit(0);
}
// ── Живые шаги ───────────────────────────────────────────────────────────────
// Синхронная пауза без зависимостей и без спавна процессов: весь скрипт линейный,
// и async ради двух ожиданий развёл бы обработку ошибок на два стиля.
const sleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function remoteMd5(p) {
  const r = sshRaw(`md5sum ${p} 2>/dev/null || true`);
  const m = /^([a-f0-9]{32})\s/.exec(r.out.trim());
  return m ? m[1] : null;
}
// DATA берём из ЖИВОГО юнита, а не из параметра: параметр — это то, что мы думаем,
// а юнит — то, как оно есть. Именно на этой развилке рецепт tmpfiles чистит не тот
// каталог и «работает», ничего не удаляя.
function unitFacts() {
  const out = run('чтение юнита', `systemctl cat ${C.unit}`);
  const exec = (/^ExecStart=(.*)$/m.exec(out) || [])[1] || '';
  let data = (/^Environment=.*?\bDATA=("?)([^\s"']+)\1/m.exec(out) || [])[2] || '';
  if (!data) {
    // Второй способ: DATA — третий аргумент запуска (`node receiver.js <порт> <каталог>`).
    const args = exec.trim().split(/\s+/).filter(Boolean);
    const after = args.slice(args.findIndex(a => a.endsWith('.js')) + 1);
    data = after.find(a => a.startsWith('/')) || '';
  }
  return { exec, data: data.replace(/\/+$/, ''), raw: out };
}
// В какой раскладке данные на ноде. Одна проба, только чтение, три факта:
//   members.json     — личность участника заведена (переход был);
//   chat.ndjson      — журнал ещё на прежнем, плоском месте;
//   chat/<gid>.ndjson — журнал уже в группе.
// Две последние строки не исключают друг друга: половинное состояние бывает после
// оборванного перехода, и вид «группа» здесь важнее — данные уже тронуты.
function layoutProbe(DATA) {
  const out = sshRaw(`test -f ${DATA}/members.json && echo MEMBERS; test -f ${DATA}/chat.ndjson && echo FLAT;`
    + ` ls ${DATA}/chat/*.ndjson >/dev/null 2>&1 && echo GROUPCHAT; true`).out;
  const members = /MEMBERS/.test(out), flat = /FLAT/.test(out), groupChat = /GROUPCHAT/.test(out);
  return { members, flat, groupChat, group: members || groupChat };
}
function healthOnce() {
  const url = `https://127.0.0.1:${C.healthPort}/health`;
  // curl есть почти всегда, но «почти» здесь мало: если его нет, спрашиваем тем же
  // node, которым работает сам приёмник. Сертификат самоподписанный, поэтому
  // проверку на ЛОКАЛЬНОМ запросе отключаем осознанно — снаружи её делает пин.
  const viaCurl = `curl -ksS --max-time 10 -o /dev/tty -w %{http_code} ${url}`;
  let r = sshRaw(`command -v curl >/dev/null 2>&1 && ${viaCurl.replace('-o /dev/tty', '')} && echo '' || echo NOCURL`);
  if (/NOCURL/.test(r.out)) {
    r = sshRaw(`node -e 'const h=require("https");h.get({host:"127.0.0.1",port:${C.healthPort},`
      + `path:"/health",rejectUnauthorized:false},r=>{let d="";r.on("data",c=>d+=c);`
      + `r.on("end",()=>{console.log(r.statusCode+" "+d);process.exit(r.statusCode===200?0:1)})})`
      + `.on("error",e=>{console.error(e.message);process.exit(1)})'`);
    return { ok: r.code === 0, text: (r.out + r.err).trim() };
  }
  const body = r.out.trim();
  return { ok: /"ok"\s*:\s*true/.test(body) || /\b200\s*$/.test(body), text: body };
}
function restartAndAccept() {
  run('daemon-reload', 'systemctl daemon-reload');
  okk('systemctl daemon-reload прошёл');
  const r = sshRaw(`systemctl restart ${C.unit} 2>&1`);
  if (r.code !== 0) {
    console.log(sshRaw(`journalctl -u ${C.unit} -n 30 --no-pager`).out);
    stop(`restart ${C.unit} не прошёл (код ${r.code}): ${(r.out + r.err).trim()}`);
  }
  let state = '';
  for (let i = 0; i < 15; i++) {
    state = sshRaw(`systemctl is-active ${C.unit}`).out.trim();
    if (state === 'active' || state === 'failed') break;
    sleep(1000);
  }
  if (state !== 'active') {
    console.log(sshRaw(`journalctl -u ${C.unit} -n 30 --no-pager`).out);
    stop(`сервис после рестарта в состоянии «${state}», а не active`);
  }
  okk(`${C.unit} активен`);
  let h = { ok: false, text: '' };
  for (let i = 0; i < 10 && !h.ok; i++) {
    h = healthOnce();
    if (!h.ok) sleep(1000);
  }
  if (!h.ok) stop(`сервис активен, но /health не отвечает как надо: ${h.text || '(пусто)'}`);
  okk(`/health отвечает: ${h.text.slice(0, 200)}`);
}
function listBackups() {
  const r = sshRaw(`ls -1t ${C.backups}/ 2>/dev/null || true`);
  return r.out.split('\n').map(s => s.trim()).filter(s => s && NAME_RE.test(s));
}

// ── Выкат ────────────────────────────────────────────────────────────────────
function deploy() {
  const js = localFacts(C.src, 'приёмника');

  step('локальный файл');
  const chk = nodeCheck(C.src);
  if (!chk.ok) stop(`node --check не прошёл, на ноду такое не поедет:\n${chk.err}`);
  okk(`${C.src}`);
  okk(`md5 ${js.md5}, ${js.size} Б, синтаксис в порядке`);
  if (js.crlf > 0) warn(`в файле CRLF (${js.crlf} строк) — для \`node file.js\` безразлично,`
    + ' но shebang с \\r сломал бы прямой запуск');

  step('юнит на ноде');
  const u = unitFacts();
  say(`ExecStart: ${u.exec || '(не нашёл)'}`);
  if (!u.data) {
    warn(`в юните не нашёл DATA — беру из параметра: ${C.data}`);
  } else if (u.data !== C.data.replace(/\/+$/, '')) {
    stop(`каталог данных в юните (${u.data}) не совпадает с --data (${C.data}).`
      + '\n   Это ровно тот случай, когда чистка вложений гладит пустоту.'
      + `\n   Либо запусти с --data=${u.data}, либо разберись, почему они разъехались.`);
  } else {
    okk(`DATA=${u.data} — совпадает с ожидаемым`);
  }
  const DATA = u.data || C.data.replace(/\/+$/, '');
  // DATA приехал с ноды и дальше подставляется в удалённые команды — проверяем его
  // так же, как параметры: путь из чужого вывода это всё-таки чужой вывод.
  if (!PATH_RE.test(DATA)) stop(`каталог данных из юнита («${DATA}») не похож на абсолютный путь`);

  // Раскладку данных узнаём ОДНОЙ пробой и до первого изменения на ноде: и отказ по
  // обратному порядку выката, и отложенная приёмка чистки опираются на этот факт.
  step('раскладка данных и порядок выката');
  const layout = layoutProbe(DATA);
  say(`на ноде: ${layout.group ? 'групповая раскладка' : 'прежняя раскладка'}`
    + ` (members.json ${layout.members ? 'есть' : 'нет'},`
    + ` chat.ndjson ${layout.flat ? 'есть' : 'нет'},`
    + ` chat/<gid>.ndjson ${layout.groupChat ? 'есть' : 'нет'})`);
  const v = layoutVerdict(js.buf.toString('utf8'), layout, has('migrate'));
  if (v.level === 'stop' && has('force-layout')) {
    warn(`--force-layout: ${v.why}. Отказ подавлен вручную.`);
    say('Если чат окажется пуст у всех — причина здесь, и она была названа.');
  } else if (v.level === 'stop') {
    stop(`${v.why}.`
      + '\n   Так чат ломается МОЛЧА, без единой ошибки: журнала на прежнем месте нет,'
      + '\n   счётчик восстанавливается с нуля, новые сообщения получают номера 1, 2, 3 —'
      + '\n   а это НИЖЕ курсоров всех клиентов, и выдача отдаёт только «номер больше'
      + '\n   курсора». Итог: у всех пустой чат, и никто ничего не получает.'
      + '\n   Выходы: выкатить приёмник, знающий про группы;'
      + `\n   либо вернуть данные — node tools/deploy-league-receiver.js --rollback --rollback-data;`
      + '\n   либо, если признак «знает про группы» здесь врёт, --force-layout.'
      + '\n   Ничего на ноде ещё не менялось.');
  } else if (v.level === 'warn') {
    warn(`${v.why}.`);
    say('Так и задумано: групповой приёмник обязан читать и прежнюю раскладку, поэтому чат');
    say('продолжает работать как раньше. Перевод данных — отдельным шагом, когда будешь готов:');
    say('этот же скрипт с --migrate (он остановит сервис, снимет снимок и перенесёт).');
  } else {
    okk(v.why);
  }

  step('прежний файл');
  const oldMd5 = remoteMd5(C.remote);
  const mode = (sshRaw(`stat -c %a ${C.remote} 2>/dev/null || echo 644`).out.trim().match(/^\d{3,4}$/) || ['644'])[0];
  if (!oldMd5) {
    warn(`на ноде ещё нет ${C.remote} — бэкапить нечего, это первый выкат`);
  } else if (oldMd5 === js.md5) {
    okk(`md5 совпадает с локальным (${oldMd5}) — файл уже такой`);
    say('копирование всё равно выполним: оно идемпотентно, а рестарт нужен для ручек чата');
  } else {
    okk(`md5 на ноде ${oldMd5}, режим ${mode}`);
  }

  step('бэкап');
  if (!oldMd5) {
    say('пропущен: бэкапить нечего');
  } else {
    const stamp = run('штамп времени', 'date -u +%Y%m%d-%H%M%SZ').trim();
    if (!/^\d{8}-\d{6}Z$/.test(stamp)) stop(`нода вернула непонятный штамп времени: «${stamp}»`);
    const bak = `${C.backups}/league-receiver.js.${stamp}.bak`;
    run('создание каталога бэкапов', `mkdir -p ${C.backups}`);
    run('копия прежнего файла', `cp -p ${C.remote} ${bak}`);
    const bakMd5 = remoteMd5(bak);
    if (bakMd5 !== oldMd5) stop(`бэкап лёг с другим md5 (${bakMd5} вместо ${oldMd5}) — дальше не идём`);
    okk(`${bak} (md5 сошёлся)`);
  }

  step('копирование нового файла');
  // Сначала во временное имя: сорванный scp тогда портит времянку, а не живой файл.
  scpUp(C.src, TMP_JS);
  const newMd5 = remoteMd5(TMP_JS);
  if (newMd5 !== js.md5) {
    sshRaw(`rm -f ${TMP_JS}`);
    stop(`после копирования md5 не сошёлся: на ноде ${newMd5}, локально ${js.md5}.`
      + ' Времянка удалена, живой файл не тронут.');
  }
  okk(`md5 на ноде совпал с локальным: ${newMd5}`);
  run('подстановка файла', `mv ${TMP_JS} ${C.remote} && chmod ${mode} ${C.remote}`);
  const finalMd5 = remoteMd5(C.remote);
  if (finalMd5 !== js.md5) stop(`после mv md5 стал ${finalMd5} — так не бывает, разбирайся руками`);
  okk(`${C.remote} обновлён, режим ${mode} сохранён`);
  return { DATA, layout, oldMd5, newMd5: js.md5 };
}
// ── Рецепт чистки вложений ───────────────────────────────────────────────────
function installConf(DATA, layout) {
  step(`рецепт чистки → ${CONF_DEST}`);
  if (has('skip-conf')) { say('пропущено по --skip-conf'); return; }
  const src = findConf();
  if (!src) {
    warn('league-chat-tmpfiles.conf не найден ни в routing/, ни в configs/, ни в корне.');
    say(`Вложения чистить будет некому: ${ATT_DIRS.join(', ')} растут без предела.`);
    say('Появится файл — прогнать этот скрипт снова (или указать --conf=<путь>).');
    return;
  }
  const facts = localFacts(src, 'рецепта tmpfiles');
  let text = facts.buf.toString('utf8');
  let v = confVerdict(text, DATA);
  if (!v.rules.length) stop(`в ${src} не нашёл ни одной строки правила (вида «e /путь - - - 30d») — ставить нечего`);
  // Сначала лечим то, что лечится правкой пути, и только потом судим о полноте:
  // иначе `--patch-conf` спотыкался бы об отсутствие правила, которое сам и не дописывает.
  if (v.foreign.length || v.missing.length) {
    if (has('patch-conf')) {
      const p = confPatch(text, DATA);
      if (p.done.length) {
        text = p.text;
        v = confVerdict(text, DATA);
        warn(`--patch-conf: в устанавливаемой копии ${p.done.join('; ')}`);
        say('локальный файл рецепта НЕ меняется — правка живёт только в копии на ноде');
      }
    }
  }
  if (v.foreign.length) {
    stop(`правила чистят пути ВНЕ каталога данных ${DATA}:\n   `
      + v.foreign.map(r => `${r.type} ${r.path} ${r.rest}`).join('\n   ')
      + '\n   Так чистка будет «работать», не удаляя ничего.'
      + '\n   Либо поправь строки в рецепте, либо поставь исправленную копию: --patch-conf');
  }
  if (v.missing.length) {
    stop(`в рецепте нет правила на ${v.missing.join(', ')}.`
      + '\n   Приёмник пишет вложения во все три каталога, и у каждого свой срок:'
      + '\n   att 30 суток, voice 7, files 30. Каталог без правила растёт вечно, молча.'
      + '\n   Допиши строки в рецепт (`e <путь> - - - m:30d`) — или выкатывай без чистки: --skip-conf');
  }
  for (const r of v.rules.filter(r => v.want.includes(r.path))) okk(`правило сверено: ${r.type} ${r.path} ${r.rest}`);
  if (v.extra.length) say(`прочие правила внутри данных (не наши каталоги): ${v.extra.map(r => r.path).join(', ')}`);
  // Пишем то, что реально поедет, во временный файл: так md5 сверяется с байтами,
  // которые ушли, а не с исходником, который мог быть подправлен выше.
  const tmpLocal = path.join(os.tmpdir(), `league-chat-${process.pid}.conf`);
  fs.writeFileSync(tmpLocal, text);
  const wantMd5 = md5(fs.readFileSync(tmpLocal));
  const tmpRemote = `/tmp/${C.confName}`;
  scpUp(tmpLocal, tmpRemote);
  run('установка рецепта', `install -m 0644 ${tmpRemote} ${CONF_DEST} && rm -f ${tmpRemote}`);
  const gotMd5 = remoteMd5(CONF_DEST);
  fs.rmSync(tmpLocal, { force: true });
  if (gotMd5 !== wantMd5) stop(`рецепт лёг с md5 ${gotMd5} вместо ${wantMd5}`);
  okk(`${CONF_DEST} установлен, md5 ${gotMd5}`);
  // Информационно: показать, что чистка вообще видит правило. Ненулевой код здесь
  // ничего не значит — у systemd < 256 нет --dry-run, и это не повод останавливаться.
  const dry = sshRaw(`systemd-tmpfiles --clean --dry-run ${CONF_DEST} 2>&1 | head -20`);
  if (dry.out.trim()) say('systemd-tmpfiles --clean --dry-run: ' + dry.out.trim().replace(/\n/g, '\n    '));
  // 🪤 Совпадение путей — это ещё НЕ работающая чистка. В групповой раскладке файлы
  // лежат на уровень глубже правила (`att/<gid>/838.webp`), и подтвердить, что чистка
  // туда заходит, прямо сейчас нечем: `--clean --dry-run` перечисляет только то, что
  // УЖЕ состарилось, а после перехода стареть нечему. Поэтому здесь не «сошлось», а
  // названная отложенная приёмка.
  if ((layout && layout.group) || has('migrate')) {
    warn('пути правил сверены, но чистка НЕ подтверждена: файлы лежат на уровень глубже');
    say(`  ${ATT_DIRS.map(d => `${DATA}/${d}/<gid>/`).join('  ')}`);
    say('  приёмка отложена до того, как вложениям станет больше срока. Тогда проверить:');
    say(`  systemd-tmpfiles --clean --dry-run ${CONF_DEST}`);
    say('  в выводе обязан быть путь ВНУТРИ подкаталога группы; нет — добавить в рецепт');
    say('  правила с шаблоном: att/*, voice/*, files/*');
  }
}

// ── Переход данных на групповую раскладку ────────────────────────────────────
// Отдельный шаг и отдельный флаг: выкат кода обратим бэкапом и рестартом, а перевод
// данных — только снимком. Смешивать их в одну команду по умолчанию значит однажды
// перевести данные, собираясь всего лишь обновить код.
const MIGRATE_SRC = path.join(__dirname, 'league-migrate.js');
const MIGRATE_REMOTE = '/tmp/league-migrate.js';
function pushMigrateTool() {
  const facts = localFacts(MIGRATE_SRC, 'скрипта перехода');
  const chk = nodeCheck(MIGRATE_SRC);
  if (!chk.ok) stop(`node --check не прошёл у ${MIGRATE_SRC}:\n${chk.err}`);
  scpUp(MIGRATE_SRC, MIGRATE_REMOTE);
  const got = remoteMd5(MIGRATE_REMOTE);
  if (got !== facts.md5) {
    sshRaw(`rm -f ${MIGRATE_REMOTE}`);
    stop(`скрипт перехода доехал с md5 ${got} вместо ${facts.md5} — данные не тронуты`);
  }
  okk(`${MIGRATE_REMOTE} (md5 ${got})`);
  return MIGRATE_REMOTE;
}
function migrateData(DATA, layout) {
  step('переход данных на групповую раскладку');
  if (!has('migrate')) {
    // Без флага — только сказать правду о том, что лежит на ноде. Факт уже добыт
    // пробой раскладки на шаге выката: второй раз спрашивать ноду незачем.
    if (layout.group) okk('данные уже в групповой раскладке (members.json / chat/<gid>.ndjson)');
    else if (layout.flat) {
      say('данные в ПРЕЖНЕЙ раскладке: chat.ndjson, chat-seq, att|voice|files/<seq>.<ext>');
      say('перевести — этот же скрипт с --migrate (он остановит сервис, снимет снимок и перенесёт)');
    } else say('ни chat.ndjson, ни members.json — переписки на ноде ещё не было');
    return;
  }
  if (has('no-restart')) {
    stop('--migrate вместе с --no-restart не имеет смысла: данные переехали бы под'
      + '\n   работающим ПРЕЖНИМ кодом, и чат выглядел бы потерянным.'
      + '\n   Переход всегда идёт со рестартом.');
  }
  if (!PATH_RE.test(DATA)) stop(`каталог данных «${DATA}» не похож на абсолютный путь — переход не начат`);
  say(`каталог данных из юнита: ${DATA}`);
  pushMigrateTool();

  // 1. Сухой прогон ДО остановки сервиса: если переход откажется (два среза, нет
  //    секрета, журнал в двух местах), сервис не должен из-за этого лежать.
  say('сухой прогон перехода на ноде (ничего не меняется):');
  const dry = sshRaw(`node ${MIGRATE_REMOTE} ${DATA} --dry-run 2>&1`);
  console.log(dry.out.trim().replace(/^/gm, '    │ '));
  if (dry.code !== 0) {
    sshRaw(`rm -f ${MIGRATE_REMOTE}`);
    stop(`переход отказался ещё на сухом прогоне (код ${dry.code}). Сервис не остановлен, данные не тронуты.`);
  }
  // 2. Остановка. Пока приёмник жив, он пишет в старый журнал: сообщение, пришедшее
  //    в момент переноса, ушло бы в файл, которого уже нет.
  const stopped = sshRaw(`systemctl stop ${C.unit} 2>&1`);
  if (stopped.code !== 0) stop(`не смог остановить ${C.unit}: ${(stopped.out + stopped.err).trim()}`);
  okk(`${C.unit} остановлен — на время переноса писателя нет`);
  // 3. Сам переход.
  const mig = sshRaw(`node ${MIGRATE_REMOTE} ${DATA} 2>&1`);
  console.log(mig.out.trim().replace(/^/gm, '    │ '));
  const okLine = /MIGRATE-OK gid=([a-f0-9]{32})/.exec(mig.out);
  if (mig.code !== 0 || !okLine) {
    stop(`переход не завершился (код ${mig.code}).`
      + `\n   Сервис СЕЙЧАС ОСТАНОВЛЕН. Поднять прежний код: systemctl start ${C.unit}`
      + `\n   Обратный ход данных: node ${MIGRATE_REMOTE} ${DATA} --rollback`
      + '\n   Снимок и манифест названы в выводе выше.');
  }
  sshRaw(`rm -f ${MIGRATE_REMOTE}`);
  okk(`переход сделан, группа-основание ${okLine[1]}`);
  say('этот идентификатор печатается один раз — он уезжает в конфиг участников');
  // Правило чистки указывает на КАТАЛОГ (`e /opt/league/data/att - - - 30d`), а внутри
  // него теперь лежит подкаталог группы. Проверить это прямо сейчас нечем: `--clean
  // --dry-run` перечисляет только то, что УЖЕ состарилось, а после перехода не
  // состарилось ничего — предупреждение было бы ложной тревогой. Поэтому не проверка,
  // а названная приёмка: она обязана случиться до того, как диск начнёт расти.
  warn('вложения теперь лежат на уровень глубже: att/<gid>/, voice/<gid>/, files/<gid>/.');
  say('Чистка обязана заходить в подкаталог. Приёмка (когда файлам будет больше срока):');
  say(`  systemd-tmpfiles --clean --dry-run ${CONF_DEST}  — путь ВНУТРИ подкаталога должен быть перечислен`);
  say('  не перечислен — добавить в рецепт строку с шаблоном (att/*, voice/*, files/*)');
}
function rollbackData(DATA) {
  step('обратный ход данных');
  if (!PATH_RE.test(DATA)) stop(`каталог данных «${DATA}» не похож на абсолютный путь`);
  pushMigrateTool();
  const stopped = sshRaw(`systemctl stop ${C.unit} 2>&1`);
  if (stopped.code !== 0) stop(`не смог остановить ${C.unit}: ${(stopped.out + stopped.err).trim()}`);
  okk(`${C.unit} остановлен`);
  const r = sshRaw(`node ${MIGRATE_REMOTE} ${DATA} --rollback 2>&1`);
  console.log(r.out.trim().replace(/^/gm, '    │ '));
  if (r.code !== 0) {
    stop(`обратный ход данных не прошёл (код ${r.code}). Сервис остановлен,`
      + ` поднять: systemctl start ${C.unit}`);
  }
  sshRaw(`rm -f ${MIGRATE_REMOTE}`);
  okk('раскладка данных вернулась к прежней; снимок на месте, он не удаляется');
}

function checkTimer() {
  step('таймер чистки systemd-tmpfiles-clean.timer');
  const en = sshRaw('systemctl is-enabled systemd-tmpfiles-clean.timer').out.trim();
  const act = sshRaw('systemctl is-active systemd-tmpfiles-clean.timer').out.trim();
  say(`is-enabled: ${en || '(пусто)'} · is-active: ${act || '(пусто)'}`);
  // `static` — нормальное состояние для этого таймера: у него нет [Install], его
  // тянет timers.target. Поэтому решает is-active, а не is-enabled.
  if (act === 'active') {
    okk('чистка тикает (штатно раз в сутки)');
    const nx = sshRaw('systemctl list-timers systemd-tmpfiles-clean.timer --no-pager 2>/dev/null | head -3').out.trim();
    if (nx) say(nx.replace(/\n/g, '\n    '));
  } else {
    warn('ТАЙМЕР НЕ ТИКАЕТ — вложения не будут удаляться никогда.');
    say('Включить (это решение владельца, скрипт сам не включает):');
    say('  systemctl enable --now systemd-tmpfiles-clean.timer');
    if (en === 'masked') say('Сначала снять маску: systemctl unmask systemd-tmpfiles-clean.timer');
  }
}
// ── Откат ────────────────────────────────────────────────────────────────────
function rollback() {
  step('бэкапы на ноде');
  const list = listBackups();
  if (!list.length) stop(`в ${C.backups} нет ни одного бэкапа — откатывать не к чему`);
  list.slice(0, 8).forEach((b, i) => say(`${i === 0 ? '→' : ' '} ${b}`));
  const pick = C.backup || list[0];
  if (!list.includes(pick)) stop(`бэкапа ${pick} в ${C.backups} нет`);
  const bak = `${C.backups}/${pick}`;
  okk(`возвращаем ${pick}`);

  step('проверка бэкапа');
  const chk = sshRaw(`node --check ${bak} 2>&1`);
  if (chk.code !== 0) stop(`бэкап не проходит node --check, возвращать его нельзя:\n   ${(chk.out + chk.err).trim()}`);
  const bakMd5 = remoteMd5(bak);
  if (!bakMd5) stop(`не смог посчитать md5 ${bak}`);
  okk(`синтаксис в порядке, md5 ${bakMd5}`);

  step('бэкап текущего файла (откат тоже обратим)');
  const curMd5 = remoteMd5(C.remote);
  if (curMd5 === bakMd5) { warn('текущий файл и бэкап побайтово совпадают — откатывать нечего'); }
  const mode = (sshRaw(`stat -c %a ${C.remote} 2>/dev/null || echo 644`).out.trim().match(/^\d{3,4}$/) || ['644'])[0];
  if (curMd5) {
    const stamp = run('штамп времени', 'date -u +%Y%m%d-%H%M%SZ').trim();
    const pre = `${C.backups}/league-receiver.js.${stamp}.pre-rollback.bak`;
    run('копия текущего', `mkdir -p ${C.backups} && cp -p ${C.remote} ${pre}`);
    if (remoteMd5(pre) !== curMd5) stop('копия текущего файла легла с другим md5 — останавливаюсь');
    okk(`${pre}`);
  } else {
    say('текущего файла нет, копировать нечего');
  }

  step('возврат');
  run('копия бэкапа', `cp ${bak} ${TMP_JS}`);
  const t = remoteMd5(TMP_JS);
  if (t !== bakMd5) { sshRaw(`rm -f ${TMP_JS}`); stop(`времянка получилась с md5 ${t} вместо ${bakMd5}`); }
  run('подстановка', `mv ${TMP_JS} ${C.remote} && chmod ${mode} ${C.remote}`);
  const fin = remoteMd5(C.remote);
  if (fin !== bakMd5) stop(`после mv md5 стал ${fin}, ожидался ${bakMd5}`);
  okk(`${C.remote} = ${pick}`);

  if (has('rollback-data')) {
    if (has('no-restart')) {
      stop('--rollback-data вместе с --no-restart оставит сервис остановленным.'
        + ' Обратный ход данных всегда идёт со рестартом.');
    }
    rollbackData(unitFacts().data || C.data.replace(/\/+$/, ''));
  }
  if (has('no-restart')) { step('рестарт'); say('пропущен по --no-restart'); }
  else { step('рестарт и приёмка'); restartAndAccept(); }
  console.log(`\n✅ Откат сделан: ${curMd5 || '(нечего было)'} → ${bakMd5}`);
  console.log(`   Вернуться к выкату: node tools/deploy-league-receiver.js`);
}

// ── main ─────────────────────────────────────────────────────────────────────
// Под `require.main === module` весь живой ход: так вердикты рецепта и порядка
// выката проверяются регрессом (`tools/check-league-migrate.js`) как обычные
// функции, без ssh и без ноды. Требование к самому файлу одно — не открывать
// соединений при загрузке; его и держим.
function main() {
if (DRY) dryRun();

if (has('list-backups')) {
  const list = listBackups();
  console.log(list.length ? list.join('\n') : `в ${C.backups} бэкапов нет`);
  process.exit(0);
}

console.log(`выкат приёмника лиги · цель ${where()}`);
if (ROLLBACK) {
  rollback();
} else {
  const { DATA, layout, oldMd5, newMd5 } = deploy();
  installConf(DATA, layout);
  checkTimer();
  migrateData(DATA, layout);
  if (has('no-restart')) {
    step('рестарт');
    warn('пропущен по --no-restart — на ноде живёт ПРЕЖНИЙ код, ручек чата в нём нет');
  } else {
    step('рестарт и приёмка');
    restartAndAccept();
    step('хвост журнала');
    console.log(sshRaw(`journalctl -u ${C.unit} -n 20 --no-pager`).out.trim());
  }
  console.log('\n✅ Выкат сделан.');
  console.log(`   было md5 ${oldMd5 || '(файла не было)'} → стало ${newMd5}`);
  if (has('migrate')) {
    console.log('   Данные переведены в групповую раскладку; снимок и манифест названы выше.');
    console.log('   Обратный ход данных: node tools/deploy-league-receiver.js --rollback --rollback-data');
  }
  console.log('   Сквозная проверка снаружи: node tools/check-league-chat-e2e.js');
  console.log('   Откат: node tools/deploy-league-receiver.js --rollback');
}
}

if (require.main === module) main();
// Наружу — только чистые вердикты: их и проверяет регресс. Ничего, что ходит по ssh,
// здесь быть не должно.
module.exports = { confRules, confVerdict, confPatch, layoutVerdict, ATT_DIRS, SRC_KNOWS_GROUPS };
