#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  league-migrate.js — перевод КАТАЛОГА ДАННЫХ приёмника лиги на групповую
//  раскладку. Запускается ТАМ, ГДЕ ЛЕЖАТ ДАННЫЕ (на ноде), сети не касается,
//  зависимостей ноль.
//
//      node league-migrate.js <каталог данных> [--dry-run] [--rollback]
//
//  Что делает, по шагам (каждый идемпотентен, порядок значим):
//    1. СНИМОК. Журнал чата копируется в `chat-<штамп>.bak.ndjson` — тем же
//       именем, каким его пишет `chatBackup()` в приёмнике, чтобы удержание
//       пяти снимков накрыло и этот случай. Мелкие файлы состояния (счётчик,
//       надгробия, slice-owners, slice-drops) копируются в `migrate-<штамп>/`
//       вместе с манифестом: без него обратный ход был бы догадками. Снимок
//       СВЕРЯЕТСЯ по md5 сразу после записи; не сошёлся — не идём дальше.
//    2. ГРУППА-ОСНОВАНИЕ. `chat.ndjson` → `chat/<gid>.ndjson`,
//       `chat-seq` → `chat/<gid>.seq`. БЕЗ ПЕРЕНУМЕРАЦИИ: номер сообщения
//       входит в имя файла вложения, перенумеровав, мы отрываем каждую старую
//       картинку от её строки.
//    3. ВЛОЖЕНИЯ. Их ТРИ каталога с разным сроком хранения: `att/` картинки (30
//       суток), `voice/` звук (7), `files/` произвольные файлы (30). Каждый переезжает
//       в свою группу: `att/<seq>.<ext>` → `att/<gid>/<seq>.<ext>`, и так же voice и
//       files. Имя файла не меняется, байты сверяются после переноса у каждого.
//    4. НАДГРОБИЯ. `chat-gone.json` → `chat/<gid>.tombs.json`. Форма согласована с
//       приёмником: `{ v: 2, gseq, cut, tombs: [{ seq, at, why, gseq }] }`, и 🔴 `gseq`
//       с `cut` переносятся КАК ЕСТЬ — курсор ниже запомненного клиентами означает
//       для всех сразу «перечитай хвост», то есть переход выглядел бы как общий сбой.
//       Голый массив первой версии читается запасным путём. Источник НЕ удаляется.
//    5. СОЛЬ АДРЕСА. `addr-salt` заводится отдельным файлом: единого секрета в
//       процессе больше не будет, а `addrTag` солился именно им.
//    6. МУСОР ПРЕЖНЕЙ СОЛИ. `slice-owners.json` и `slice-drops.json` сносятся —
//       в них только хеши адресов под старой солью и счётчики отказов.
//       Пользовательских данных нет, копии лежат в снимке.
//    7. ЛИЧНОСТЬ. `members.json`, `groups.json`, `invites.json`. `installId`
//       берётся из `slices/` и НИКОГДА не генерируется: на нём висит весь
//       накопленный рейтинг.
//
//  --dry-run    напечатать план и не тронуть ни один байт
//  --rollback   вернуть прежнюю раскладку по манифесту последнего снимка
//  --gid=       взять готовый идентификатор группы (32 hex) вместо случайного
//  --install-id= если в slices/ не один файл, назвать явно
//  --title=     название группы-основания (по умолчанию «Общий»)
//  --snapshot=  какой снимок использовать при --rollback
//
//  Коды выхода: 0 — сделано или уже сделано, 1 — не сделано и причина названа.
//  Секрет и его хеш не печатаются нигде: в вывод идёт только маска.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARGV = process.argv.slice(2);
const has = n => ARGV.includes('--' + n);
const opt = (n, d) => {
  const p = `--${n}=`;
  const hit = ARGV.find(a => a.startsWith(p));
  return hit === undefined ? d : hit.slice(p.length);
};
const DRY = has('dry-run');
const ROLLBACK = has('rollback');
const DATA = (ARGV.find(a => !a.startsWith('--')) || '').replace(/[/\\]+$/, '');

let stepNo = 0;
const step = m => console.log(`\n[${++stepNo}] ${m}`);
const say = m => console.log('    ' + m);
const okk = m => console.log('    ✅ ' + m);
const warn = m => console.log('    ⚠️  ' + m);
function stop(msg) {
  console.log('\n⛔ ' + msg);
  console.log('   Дальше этого шага каталог данных не менялся.');
  process.exit(1);
}
if (has('help') || has('h') || !DATA) {
  console.log(`перевод каталога данных лиги на групповую раскладку

  node tools/league-migrate.js <каталог данных> [--dry-run] [--rollback]

  --dry-run       напечатать план, не менять ничего
  --rollback      вернуть прежнюю раскладку по манифесту снимка
  --gid=<32 hex>  идентификатор группы-основания (по умолчанию случайный)
  --install-id=   если в slices/ не один файл
  --title=        название группы (по умолчанию «Общий»)
  --snapshot=     migrate-<штамп> для --rollback (по умолчанию последний)

  Каталог данных — тот, что стоит в живом юните ноды (Environment=DATA=…),
  а не тот, который кажется правильным.`);
  process.exit(has('help') || has('h') ? 0 : 1);
}

// ── Раскладка: прежняя и новая ───────────────────────────────────────────────
const P = {
  secret: path.join(DATA, 'secret'),
  slices: path.join(DATA, 'slices'),
  chatOld: path.join(DATA, 'chat.ndjson'),
  seqOld: path.join(DATA, 'chat-seq'),
  goneOld: path.join(DATA, 'chat-gone.json'),
  owners: path.join(DATA, 'slice-owners.json'),
  drops: path.join(DATA, 'slice-drops.json'),
  att: path.join(DATA, 'att'),
  // Вложения лежат в ТРЁХ каталогах, и не для порядка: у них разный срок хранения
  // (30 суток картинки, 7 звук, 30 файлы), а tmpfiles умеет срок только на путь
  // целиком. Переезжать в группу они обязаны все три — иначе после перехода часть
  // сообщений останется без своих байтов, и заметить это будет неоткуда.
  voice: path.join(DATA, 'voice'),
  files: path.join(DATA, 'files'),
  chatDir: path.join(DATA, 'chat'),
  members: path.join(DATA, 'members.json'),
  groups: path.join(DATA, 'groups.json'),
  invites: path.join(DATA, 'invites.json'),
  salt: path.join(DATA, 'addr-salt'),
};
// Каталоги вложений в одном списке: любой обход по одному из них — это готовая
// дырка «voice не переехал, а никто не сказал».
const ATT_DIRS = ['att', 'voice', 'files'];
// Имя файла вложения на диске — `<номер>.<расширение>`, и расширение НЕ ограничено
// картинками и звуком: произвольный файл лежит под номером с любым расширением из
// `[a-z0-9]{1,8}` (так его проверяет `attExtOk` приёмника), а исходное имя живёт полем
// записи журнала. Маска шире прежней намеренно: список webp|webm|ogg|m4a|mp3|wav
// оставил бы `files/841.pdf` лежать на месте молча.
const ATT_RE = /^(\d{1,15})\.([a-z0-9]{1,8})$/;
const GID_RE = /^[a-f0-9]{32}$/;

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
const md5file = f => { try { return md5(fs.readFileSync(f)); } catch { return null; } };
const exists = f => fs.existsSync(f);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// Пишем через tmp+rename, как приёмник пишет журнал и срезы: оборванная запись
// не имеет права оставить на диске полуфайл, который потом прочитают как правду.
function writeAtomic(file, text, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
const mask = s => (s ? s.slice(0, 6) + '…(' + s.length + ')' : '(пусто)');
const attList = dir => { try { return fs.readdirSync(dir).filter(f => ATT_RE.test(f)); } catch { return []; } };
// Что ещё лежит в прежней раскладке — по всем трём каталогам сразу.
const attLeft = () => ATT_DIRS.map(k => [k, attList(P[k])]).filter(([, v]) => v.length);
const attLeftCount = () => attLeft().reduce((n, [, v]) => n + v.length, 0);
// Куда попадает вложение — решает расширение, ровно как `attFile` в приёмнике:
// картинка в `att/`, звук в `voice/`, всё остальное в `files/`. Таблица повторена
// здесь намеренно (скрипт без зависимостей), и она же — единственное место, где
// эта развилка живёт: разъедется с приёмником — разъедется в одной строке.
const ATT_HOME = { webp: 'att', webm: 'voice', ogg: 'voice', m4a: 'voice', mp3: 'voice', wav: 'voice' };
const attHome = ext => ATT_HOME[ext] || 'files';
const attExtOk = e => typeof e === 'string' && /^[a-z0-9]{1,8}$/.test(e);
// ── Разбор журнала ───────────────────────────────────────────────────────────
// Читаем не ради изменения, а ради проверки: набор номеров до и после переноса
// обязан совпасть. Битые строки считаем отдельно и НЕ выбрасываем — журнал
// переезжает байт в байт, а не пересобирается: пересборка это и есть тихая
// потеря того, чего мы не поняли.
function scanJournal(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { return null; }
  const seqs = [], atts = [];
  let bad = 0;
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { bad++; continue; }
    if (!r || !Number.isInteger(r.seq)) { bad++; continue; }
    seqs.push(r.seq);
    // Ожидаемый путь вложения — «каталог/номер.расширение». Каталог считается по
    // расширению, а не по полю записи: на диске файл лежит именно там.
    if (r.att) {
      const ext = attExtOk(r.att.ext) ? r.att.ext : 'webp';
      atts.push(attHome(ext) + '/' + r.seq + '.' + ext);
    }
  }
  return { bytes: raw.length, md5: md5(raw), seqs, atts, bad,
    first: seqs.length ? Math.min(...seqs) : 0, last: seqs.length ? Math.max(...seqs) : 0 };
}

// ── Где мы сейчас ────────────────────────────────────────────────────────────
// Идентификатор группы НЕ придумывается заново на каждом запуске: иначе второй
// прогон завёл бы вторую группу и раздвоил историю. Порядок поиска — от самого
// надёжного к самому дешёвому: реестр групп → уже перенесённый журнал → --gid →
// случайные 16 байт.
function detectGid() {
  const g = readJson(P.groups, null);
  if (g && typeof g === 'object') {
    const ids = Object.keys(g).filter(k => GID_RE.test(k));
    if (ids.length) return { gid: ids[0], from: 'groups.json' };
  }
  try {
    const f = fs.readdirSync(P.chatDir).map(x => (/^([a-f0-9]{32})\.ndjson$/.exec(x) || [])[1]).filter(Boolean);
    if (f.length === 1) return { gid: f[0], from: 'уже перенесённый журнал' };
    if (f.length > 1) stop(`в ${P.chatDir} журналов несколько (${f.length}) — какая из них основание, скрипт решать не станет.`
      + ' Назови явно: --gid=<32 hex>');
  } catch { /* каталога ещё нет — это норма */ }
  const want = opt('gid', '');
  if (want) {
    if (!GID_RE.test(want)) stop(`--gid=${want} — нужно ровно 32 символа [a-f0-9]`);
    return { gid: want, from: '--gid' };
  }
  return { gid: crypto.randomBytes(16).toString('hex'), from: 'сгенерирован' };
}
// installId берётся из среза и НИКОГДА не генерируется: на нём висит весь
// накопленный рейтинг, а новый — это новая строка в рейтинге и разрыв истории.
function detectInstall() {
  const want = opt('install-id', '');
  if (want) {
    if (!/^[a-f0-9]{16,64}$/.test(want)) stop(`--install-id=${want} — не похоже на installId (16–64 hex)`);
    return { installId: want, nick: (readJson(path.join(P.slices, want + '.json'), {}) || {}).nick || '', from: '--install-id' };
  }
  let files = [];
  try { files = fs.readdirSync(P.slices).filter(f => /^[a-f0-9]{16,64}\.json$/.test(f)); } catch { /* нет каталога */ }
  if (!files.length) {
    stop(`в ${P.slices} нет ни одного среза — брать installId неоткуда, а придумывать его нельзя:`
      + '\n   на нём висит весь накопленный рейтинг.'
      + '\n   Переход запускать после первого среза либо назвать явно: --install-id=<...>');
  }
  if (files.length > 1) {
    stop(`в ${P.slices} срезов ${files.length}, а установка владельца должна быть одна.`
      + `\n   Скрипт не станет угадывать, чей рейтинг непрерывен. Назови явно: --install-id=<...>`
      + `\n   Есть: ${files.map(f => f.replace(/\.json$/, '')).join(', ')}`);
  }
  const id = files[0].replace(/\.json$/, '');
  return { installId: id, nick: (readJson(path.join(P.slices, files[0]), {}) || {}).nick || '', from: 'slices/' };
}
// ─── ФОРМА ФАЙЛОВ ЛИЧНОСТИ — единственное место, где она задана ──────────────
// Поля взяты дословно из дизайна «Лига — друзья, группы и приглашения»:
//   { memberId, tokenHash, installId, nick, groups, status, createdAt, invitedBy }
// Оба реестра — КАРТЫ по идентификатору (поиск по хешу токена идёт перебором
// карты участников; групп у нас единицы). Приёмник обязан читать ровно это; если
// он выберет другую форму, править надо здесь, и это три строки.
function mkMember(memberId, tokenHash, installId, nick, gid, at) {
  return { memberId, tokenHash, installId, nick, groups: [gid],
    status: 'active', createdAt: at, invitedBy: null };
}
function mkGroup(gid, title, memberId, at) {
  return { gid, title, createdBy: memberId, createdAt: at, members: [memberId] };
}
// ─── НАДГРОБИЯ: форма согласована с приёмником ───────────────────────────────
// Приёмник пишет и читает объект:
//   { v: 2, gseq, cut, tombs: [ { seq, at: ISO-строка, why, gseq } ] }
// где `gseq` — монотонный курсор надгробий, а `cut` — самый большой `gseq`, который
// УЖЕ ЗАБЫТ (истёк или вытеснен потолком): ниже него полноту приёмник не обещает и
// отвечает клиенту `cold`.
//
// 🔴 `gseq` и `cut` переносятся КАК ЕСТЬ. Перенумеровать их заново — это тихая
// поломка у ВСЕХ участников сразу: клиенты помнят свой `gseq`, и серверный курсор
// ниже запомненного означает для каждого из них «перечитай хвост». Переход выглядел
// бы как массовый сбой, причём в момент, когда все считают, что он прошёл успешно.
// Поэтому здесь нет ни одного `++`: номера только читаются.
//
// Запасной путь — файл ПЕРВОЙ версии: голый массив `{ seq, at: миллисекунды, why }`
// без `gseq` вообще. Тогда номера приходится назначить (иначе приёмник отбросит
// такие записи: он требует целый `gseq`), и это безопасно ровно потому, что в первой
// версии курсора не существовало и запомнить его клиентам было нечем.
function mkTombs(raw) {
  const isObj = raw && typeof raw === 'object' && !Array.isArray(raw);
  // Ключ `gone` читает и приёмник — так файл назывался в первой правке.
  const list = Array.isArray(raw) ? raw
    : (isObj && Array.isArray(raw.tombs) ? raw.tombs
      : (isObj && Array.isArray(raw.gone) ? raw.gone : []));
  const at = t => {
    // ISO-строка — основной вид; число миллисекунд — вид первой версии. Обратно
    // всегда отдаём строку: приёмник фильтрует записи по `Date.parse(at)`, и число
    // эту проверку не проходит, то есть надгробие пропало бы молча.
    const ms = typeof t === 'number' ? t : Date.parse(t);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const kept = [], dropped = [];
  for (const t of list) {
    const iso = t && at(t.at);
    if (!t || !Number.isInteger(t.seq) || !iso) { dropped.push(t); continue; }
    kept.push({ seq: t.seq, at: iso, why: t.why || 'one',
      gseq: Number.isInteger(t.gseq) ? t.gseq : null });
  }
  // Записи без своего номера бывают только в файле первой версии (или в наполовину
  // переписанном). Нумеруем их ВЫШЕ всего известного — вверх безопасно, вниз нет.
  let top = Math.max(Number(isObj ? raw.gseq : 0) || 0, ...kept.map(t => t.gseq || 0), 0);
  let numbered = 0;
  for (const t of kept) if (t.gseq === null) { t.gseq = ++top; numbered++; }
  kept.sort((a, b) => a.gseq - b.gseq);
  // В файл уезжают ТОЛЬКО четыре поля контракта. Диагностика — отдельным объектом:
  // лишние ключи в файле надгробий однажды прочитают как часть формы.
  return {
    out: {
      v: 2,
      gseq: Math.max(Number(isObj ? raw.gseq : 0) || 0, top, 0),
      cut: Math.max(Number(isObj ? raw.cut : 0) || 0, 0),
      tombs: kept,
    },
    from: Array.isArray(raw) ? 'массив первой версии' : (isObj && raw.v === 2 ? 'v2' : 'объект без версии'),
    numbered, dropped: dropped.length, src: list.length,
  };
}

// ── Что осталось сделать ─────────────────────────────────────────────────────
// Не один флаг «сделано», а список незакрытых дел: оборванный посередине прогон
// оставляет половину, и её надо ДОДЕЛАТЬ, а не принять за чужую работу. Пустой
// список — единственное условие, при котором мы не делаем даже снимка: именно это
// и означает «повторный запуск ничего не меняет».
function pending(gid) {
  const t = [];
  if (exists(P.chatOld)) t.push('журнал');
  if (exists(P.seqOld)) t.push('счётчик номеров');
  if (attLeftCount()) {
    t.push('вложения (' + attLeft().map(([k, v]) => `${k}: ${v.length}`).join(', ') + ')');
  }
  if (exists(P.goneOld) && !exists(path.join(P.chatDir, gid + '.tombs.json'))) t.push('надгробия');
  if (!exists(P.salt)) t.push('соль адреса');
  if (exists(P.owners) || exists(P.drops)) t.push('снос файлов прежней соли');
  if (!exists(P.members)) t.push('members.json');
  if (!exists(P.groups)) t.push('groups.json');
  if (!exists(P.invites)) t.push('invites.json');
  return t;
}
// ── Шаг 1: снимок ────────────────────────────────────────────────────────────
// Две части, и обе нужны. Журнал уходит в `chat-<штамп>.bak.ndjson` — то же имя,
// что пишет `chatBackup()` приёмника, значит удержание пяти снимков накроет и наш.
// Мелкие файлы состояния — в `migrate-<штамп>/` вместе с манифестом: без манифеста
// обратный ход превращается в догадки о том, где что лежало.
// Вложения НЕ копируются: это мегабайты, а переезд каждого файла — переименование,
// то есть обратимо само. В манифесте лежит их список, этого хватает.
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
function snapshot(info) {
  const dir = path.join(DATA, 'migrate-' + STAMP);
  fs.mkdirSync(dir, { recursive: true });
  let bak = null;
  // Копируем журнал ОТТУДА, ГДЕ ОН СЕЙЧАС: на доделывании оборванного прогона он уже
  // лежит в группе, и снимок обязан получиться всё равно — иначе у самого рискованного
  // прогона (продолжаем начатое чужой рукой) страховки бы не было.
  if (info.journalFile && exists(info.journalFile) && info.journal.bytes) {
    bak = 'chat-' + STAMP + '.bak.ndjson';
    const raw = fs.readFileSync(info.journalFile);
    fs.writeFileSync(path.join(DATA, bak), raw);
    // Снимок обязан быть ПРОВЕРЯЕМЫМ, а не просто записанным: сверяем сразу и
    // останавливаемся до первого изменения, если байты не те.
    const got = md5file(path.join(DATA, bak));
    if (got !== info.journal.md5) {
      stop(`снимок журнала лёг с md5 ${got} вместо ${info.journal.md5} — переход не начат`);
    }
    okk(`${bak} — ${raw.length} Б из ${path.basename(info.journalFile)}, md5 сошёлся`);
  } else if (info.journalFile && exists(info.journalFile)) {
    say('журнал пустой — копировать нечего');
  } else {
    warn('журнала нет вовсе: переписки не было, снимать нечего');
  }
  const copied = [];
  for (const f of [P.seqOld, P.goneOld, P.owners, P.drops]) {
    if (!exists(f)) continue;
    const name = path.basename(f);
    fs.copyFileSync(f, path.join(dir, name));
    if (md5file(path.join(dir, name)) !== md5file(f)) stop(`копия ${name} в снимке не сошлась по md5`);
    copied.push(name);
  }
  if (copied.length) okk(`в снимок скопированы: ${copied.join(', ')}`);
  const manifest = {
    tool: 'league-migrate.js', at: new Date().toISOString(), data: DATA,
    gid: info.gid, memberId: info.memberId, installId: info.installId,
    journal: info.journal, journalFrom: path.basename(info.journalFile || ''),
    snapshotJournal: bak, copied,
    seq: info.seqValue, att: info.atts, removes: ['slice-owners.json', 'slice-drops.json'],
  };
  writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  okk(`манифест: ${path.join(dir, 'manifest.json')}`);
  return { dir, bak };
}
// ── Шаг 2: журнал и счётчик в группу ─────────────────────────────────────────
// Перенос — ПЕРЕИМЕНОВАНИЕ, а не пересборка. Пересобрать журнал построчно значит
// потерять то, чего мы не разобрали, и молча перенумеровать то, что разобрали.
// Номер сообщения — это имя файла вложения, и он неприкосновенен.
function moveJournal(gid, info) {
  fs.mkdirSync(P.chatDir, { recursive: true });
  const dst = path.join(P.chatDir, gid + '.ndjson');
  if (exists(P.chatOld)) {
    if (exists(dst)) {
      stop(`и ${P.chatOld}, и ${dst} существуют одновременно.`
        + '\n   Это не тот случай, который скрипт имеет право решить: склеивать два журнала'
        + '\n   он не станет (номера столкнутся). Разберись руками, что из них живое.');
    }
    fs.renameSync(P.chatOld, dst);
    const after = scanJournal(dst);
    if (!after || after.md5 !== info.journal.md5) {
      stop(`после переноса md5 журнала ${after && after.md5} вместо ${info.journal.md5}`);
    }
    // Набор номеров сверяется отдельно от байтов: байты могли совпасть и при
    // ошибке в разборе, а нам нужно утверждение именно про номера.
    const same = after.seqs.length === info.journal.seqs.length
      && after.seqs.every((s, i) => s === info.journal.seqs[i]);
    if (!same) stop('набор номеров после переноса не совпал с прежним — перенумерация запрещена');
    okk(`${path.basename(dst)}: ${after.seqs.length} сообщений, номера ${after.first}…${after.last} — те же`);
  } else if (exists(dst)) {
    okk(`журнал уже в группе: ${path.basename(dst)}`);
  } else {
    say('переписки нет вовсе — группа начнётся с пустого журнала');
  }
  // Счётчик. Если файла нет, но журнал есть — пишем максимум номера: ровно так
  // восстанавливает счётчик сам приёмник (seqInit), и выдать номер второй раз
  // нельзя. Откат счётчика прячет новые сообщения навсегда, поэтому берём максимум
  // из всех известных значений, а не «что нашлось».
  const seqDst = path.join(P.chatDir, gid + '.seq');
  const fromOld = exists(P.seqOld) ? parseInt(String(fs.readFileSync(P.seqOld, 'utf8')).trim(), 10) || 0 : 0;
  const fromNew = exists(seqDst) ? parseInt(String(fs.readFileSync(seqDst, 'utf8')).trim(), 10) || 0 : 0;
  const value = Math.max(fromOld, fromNew, info.journal ? info.journal.last : 0, 0);
  if (value > 0 || exists(P.seqOld)) {
    writeAtomic(seqDst, String(value) + '\n');
    okk(`${path.basename(seqDst)} = ${value}${fromOld && value !== fromOld ? ` (в chat-seq было ${fromOld})` : ''}`);
  }
  if (exists(P.seqOld)) { fs.rmSync(P.seqOld); say('прежний chat-seq убран (копия в снимке)'); }
  return value;
}

// ── Шаг 3: вложения ──────────────────────────────────────────────────────────
// Три каталога, а не один: `att/` картинки, `voice/` звук, `files/` произвольные
// файлы — у них разный срок хранения, поэтому они и разведены. Имя файла не
// меняется, меняется только каталог: `att/838.webp` → `att/<gid>/838.webp`.
// Байты сверяются ПОСЛЕ переноса у каждого файла: переименование в пределах одной
// файловой системы не портит содержимое, но «не портит по определению» — это ровно
// то допущение, из-за которого потери и остаются незамеченными.
// Всё, что не подходит под маску «число.расширение», остаётся на месте и попадает в
// отчёт: угадывать, чьё это, скрипт не должен.
function moveAtt(gid) {
  const res = { moved: 0, clash: [], left: [], byDir: {} };
  for (const key of ATT_DIRS) {
    const root = P[key];
    if (!exists(root)) { res.byDir[key] = 0; continue; }
    const dir = path.join(root, gid);
    fs.mkdirSync(dir, { recursive: true });
    const mine = attList(root);
    let moved = 0;
    const clash = [];
    for (const f of mine) {
      const src = path.join(root, f), dst = path.join(dir, f);
      const before = md5file(src);
      if (exists(dst)) {
        // Такой файл уже переехал в прошлый прогон. Совпали байты — просто убираем
        // дубль; разошлись — не трогаем ничего и говорим, потому что это единственный
        // случай, когда выбор между двумя файлами делает человек.
        if (md5file(dst) === before) { fs.rmSync(src); continue; }
        clash.push(key + '/' + f);
        continue;
      }
      fs.renameSync(src, dst);
      if (md5file(dst) !== before) {
        stop(`после переноса ${key}/${f} байты не те (${md5file(dst)} вместо ${before}).`
          + '\n   Дальше не идём: снимок и манифест на месте, обратный ход — --rollback');
      }
      moved++;
    }
    const left = fs.readdirSync(root)
      .filter(f => f !== gid && !clash.includes(key + '/' + f) && fs.statSync(path.join(root, f)).isFile())
      .map(f => key + '/' + f);
    res.moved += moved;
    res.byDir[key] = moved;
    res.clash.push(...clash);
    res.left.push(...left);
  }
  if (res.moved) {
    okk(`вложений перенесено: ${res.moved} (`
      + ATT_DIRS.map(k => `${k}/${gid.slice(0, 8)}…: ${res.byDir[k] || 0}`).join(', ') + '), байты сверены');
  } else say('вложений к переносу не было');
  if (res.clash.length) warn(`не перенесены (в группе уже лежит ДРУГОЙ файл с тем же именем): ${res.clash.join(', ')}`);
  if (res.left.length) warn(`остались файлы не нашего вида: ${res.left.slice(0, 10).join(', ')}`);
  return res;
}
// ── Шаг 4: надгробия ─────────────────────────────────────────────────────────
// Прежний файл остаётся на диске нетронутым. Это не забывчивость: пока источник цел,
// надгробия можно пересобрать, а без них снятое сообщение висит у соседей до
// перезагрузки страницы. Лишний файл в каталоге этого точно дешевле.
function moveTombs(gid) {
  const dst = path.join(P.chatDir, gid + '.tombs.json');
  if (exists(dst)) { okk(`надгробия уже в группе: ${path.basename(dst)}`); return null; }
  if (!exists(P.goneOld)) { say('надгробий не было'); return null; }
  const t = mkTombs(readJson(P.goneOld, []));
  fs.mkdirSync(P.chatDir, { recursive: true });
  writeAtomic(dst, JSON.stringify(t.out) + '\n');
  okk(`${path.basename(dst)}: надгробий ${t.out.tombs.length} из ${t.src}`
    + ` (${t.from}), gseq=${t.out.gseq} и cut=${t.out.cut} перенесены как есть`);
  // Молчать здесь нельзя ни в одном из двух случаев: и «файл был, а надгробий ноль»,
  // и «часть записей не разобрана» — это потеря, о которой узнают через неделю.
  if (t.src && !t.out.tombs.length) {
    warn('в файле были записи, а перенеслось НОЛЬ надгробий — разбери форму файла до рестарта приёмника');
  }
  if (t.dropped) warn(`не разобрано записей: ${t.dropped} (нет номера или времени)`);
  if (t.numbered) say(`номера назначены ${t.numbered} записям без своего gseq (файл первой версии)`);
  say(`прежний ${path.basename(P.goneOld)} оставлен на месте — пересобрать будет из чего`);
  return t;
}

// ── Шаг 5: соль адреса ───────────────────────────────────────────────────────
// Адрес участника хранится хешем, и солью служил ОБЩИЙ СЕКРЕТ. Единого секрета в
// процессе больше не будет, значит соль обязана стать своей и ни от кого не
// зависеть. Заодно уходит исходная причина: гигиена адресов перестаёт быть
// привязанной к ротации доступа.
function makeSalt() {
  if (exists(P.salt)) { okk(`соль адреса уже есть: ${path.basename(P.salt)}`); return; }
  writeAtomic(P.salt, crypto.randomBytes(32).toString('hex') + '\n', 0o600);
  okk(`${path.basename(P.salt)} создан (32 случайных байта, права на владельца)`);
}

// ── Шаг 6: мусор прежней соли ────────────────────────────────────────────────
// Пересолить нечем — там только хеши. Пользовательских данных нет: хеш адреса и
// счётчик отказов. Копии уже лежат в снимке, поэтому это не потеря, а снос
// заведомого мусора. Отдельным шагом, а не побочным эффектом: молчаливое удаление
// файла, от которого зависит серия просадок, — ровно то, о чём потом никто не
// вспомнит.
function dropStale() {
  let n = 0;
  for (const f of [P.owners, P.drops]) {
    if (!exists(f)) { say(`${path.basename(f)} — нет, сносить нечего`); continue; }
    fs.rmSync(f);
    okk(`${path.basename(f)} снесён (соль сменилась, содержимое стало ложью)`);
    n++;
  }
  if (n) say('серия просадок и признак «тот же адрес» начнутся заново — для одной установки это ничего');
  return n;
}

// ── Шаг 7: личность ──────────────────────────────────────────────────────────
// Общий секрет становится ЛИЧНЫМ токеном владельца: на диске лежит только его
// sha256, сам секрет не печатается и не меняется — на машине владельца не правится
// ни один файл. Это то самое окно, которое закроется в день, когда ключ уедет
// первому из пяти.
function makeIdentity(gid, installId, nick, memberId) {
  const at = new Date().toISOString();
  let secret = '';
  try { secret = fs.readFileSync(P.secret, 'utf8').trim(); } catch { /* нет файла */ }
  if (!secret) {
    stop(`нет ${P.secret} — токен владельца выводить не из чего.`
      + '\n   Приёмник создаёт этот файл при первом старте; каталог данных точно тот?');
  }
  const tokenHash = crypto.createHash('sha256').update(secret).digest('hex');
  if (!exists(P.members)) {
    writeAtomic(P.members, JSON.stringify({ [memberId]: mkMember(memberId, tokenHash, installId, nick, gid, at) }, null, 2) + '\n', 0o600);
    okk(`members.json: участник ${memberId}, installId ${installId}, ник ${nick || '(пусто)'}`);
    say(`токен участника = прежний общий секрет (${mask(secret)}), на диске только его sha256`);
    say('🔴 больше этот секрет никому не давать: теперь это личный токен владельца');
  } else {
    const m = readJson(P.members, {});
    const rec = m[memberId] || Object.values(m)[0] || {};
    okk(`members.json уже есть: участников ${Object.keys(m).length}, installId ${rec.installId || '(нет)'}`);
    if (rec.installId && rec.installId !== installId) {
      warn(`в записи стоит installId ${rec.installId}, а в slices/ — ${installId}. Не трогаю: привязку меняет только человек`);
    }
  }
  if (!exists(P.groups)) {
    writeAtomic(P.groups, JSON.stringify({ [gid]: mkGroup(gid, opt('title', 'Общий'), memberId, at) }, null, 2) + '\n');
    okk(`groups.json: группа-основание ${gid}, создатель ${memberId}`);
  } else {
    okk(`groups.json уже есть: групп ${Object.keys(readJson(P.groups, {})).length}`);
  }
  if (!exists(P.invites)) {
    writeAtomic(P.invites, '{}\n', 0o600);
    okk('invites.json: пустой (входов в группу пока не выдано)');
  } else {
    okk('invites.json уже есть');
  }
}
// ── Обратный ход ─────────────────────────────────────────────────────────────
// Возвращает прежнюю раскладку по манифесту снимка. Что важно понимать про откат
// данных: он возвращает МЕСТА файлов, а не время. Сообщения, пришедшие уже в новую
// раскладку, уедут назад вместе с журналом — это правильно, они не мусор. Сам
// снимок откат НЕ удаляет: единственное доказательство прежнего состояния мы не
// трогаем никогда.
function snapshots() {
  try {
    return fs.readdirSync(DATA).filter(f => /^migrate-/.test(f)
      && exists(path.join(DATA, f, 'manifest.json'))).sort();
  } catch { return []; }
}
function rollback() {
  step('снимок, из которого возвращаемся');
  const list = snapshots();
  if (!list.length) stop(`в ${DATA} нет ни одного снимка migrate-*/manifest.json — возвращаться не к чему`);
  list.slice(-5).forEach((s, i, a) => say(`${i === a.length - 1 ? '→' : ' '} ${s}`));
  const pick = opt('snapshot', list[list.length - 1]);
  if (!list.includes(pick)) stop(`снимка ${pick} нет`);
  const dir = path.join(DATA, pick);
  const man = readJson(path.join(dir, 'manifest.json'), null);
  if (!man || !GID_RE.test(String(man.gid))) stop(`манифест в ${pick} не читается или в нём нет gid`);
  okk(`${pick}: gid ${man.gid}, сообщений ${man.journal ? man.journal.seqs.length : 0}`);
  const gid = man.gid;
  const jSrc = path.join(P.chatDir, gid + '.ndjson');
  const seqSrc = path.join(P.chatDir, gid + '.seq');
  const attSrc = ATT_DIRS.map(k => `${k}/${gid.slice(0, 8)}…`).join(', ');

  if (DRY) {
    step('план отката (ничего не меняется)');
    say(`${jSrc} → ${P.chatOld}`);
    say(`${seqSrc} → ${P.seqOld}`);
    say(`${attSrc} → каждое обратно в свой каталог (att/, voice/, files/)`);
    say(`из снимка вернутся: ${(man.copied || []).join(', ') || '(ничего)'}`);
    say(`будут убраны: members.json, groups.json, invites.json, addr-salt, ${gid.slice(0, 8)}….tombs.json`);
    process.exit(0);
  }

  step('журнал и счётчик');
  if (exists(jSrc)) {
    if (exists(P.chatOld)) stop(`${P.chatOld} уже существует — откат не станет его перезаписывать. Разберись руками`);
    const now = scanJournal(jSrc);
    fs.renameSync(jSrc, P.chatOld);
    okk(`${path.basename(jSrc)} → chat.ndjson (${now.seqs.length} сообщений)`);
    if (man.journal && now.md5 !== man.journal.md5) {
      warn('журнал изменился после перехода — значит в новой раскладке уже писали.');
      say('Эти сообщения вернулись назад вместе с журналом, формат записи не менялся.');
    }
  } else { say('журнала в группе нет — переносить нечего'); }
  if (exists(seqSrc)) { fs.renameSync(seqSrc, P.seqOld); okk('счётчик → chat-seq'); }
  else if (man.seq) { writeAtomic(P.seqOld, String(man.seq) + '\n'); okk(`chat-seq восстановлен из манифеста (${man.seq})`); }

  step('вложения');
  let back = 0;
  const keep = [];
  for (const key of ATT_DIRS) {
    const src = path.join(P[key], gid);
    if (!exists(src)) continue;
    for (const f of attList(src)) {
      const dst = path.join(P[key], f);
      if (exists(dst)) { keep.push(key + '/' + f); continue; }
      fs.renameSync(path.join(src, f), dst);
      back++;
    }
    // Пустой каталог группы убираем, непустой оставляем как есть: молча удалять то,
    // чего не понял, откат не должен.
    try { if (!fs.readdirSync(src).length) fs.rmdirSync(src); } catch { /* не пусто — и ладно */ }
  }
  okk(`возвращено в att/, voice/ и files/: ${back}`);
  if (keep.length) warn(`оставлены в группе (снаружи уже есть файл с таким именем): ${keep.join(', ')}`);

  step('файлы прежней соли');
  for (const name of (man.copied || [])) {
    if (name === 'chat-seq' && exists(P.seqOld)) continue;
    const src = path.join(dir, name), dst = path.join(DATA, name);
    if (!exists(src)) continue;
    if (exists(dst)) { say(`${name} на месте, из снимка не беру`); continue; }
    fs.copyFileSync(src, dst);
    okk(`${name} восстановлен из снимка`);
  }

  step('новые файлы убираются');
  for (const f of [P.members, P.groups, P.invites, P.salt, path.join(P.chatDir, gid + '.tombs.json')]) {
    if (!exists(f)) continue;
    fs.rmSync(f);
    okk(`убран ${path.basename(f)}`);
  }
  try { if (!fs.readdirSync(P.chatDir).length) fs.rmdirSync(P.chatDir); } catch { /* не пусто */ }
  console.log(`\n✅ Откат сделан. Снимок ${pick} НЕ удалён — он и есть доказательство прежнего состояния.`);
  console.log('   Прежний приёмник поднимется на этой раскладке как раньше.');
  console.log(`   Повторить переход: node league-migrate.js ${DATA}`);
  process.exit(0);
}
// ── main ─────────────────────────────────────────────────────────────────────
try {
  if (!fs.statSync(DATA).isDirectory()) throw new Error('не каталог');
} catch {
  stop(`${DATA} — не каталог данных приёмника (или его нет). Путь брать из живого юнита ноды.`);
}
console.log(`переход данных лиги на групповую раскладку · ${DATA}`);
if (ROLLBACK) rollback();

const { gid, from: gidFrom } = detectGid();
const { installId, nick, from: idFrom } = detectInstall();
// memberId один раз и навсегда: он лежит в members.json, и на повторном прогоне
// берётся оттуда. Сгенерировать второй — это второй участник на один токен.
const haveMembers = readJson(P.members, null);
const memberId = (haveMembers && Object.keys(haveMembers).find(k => /^[a-f0-9]{16}$/.test(k)))
  || crypto.randomBytes(8).toString('hex');
// Журнал сканируем там, где он сейчас: до переноса — старый путь, после
// оборванного прогона — уже перенесённый. Иначе доделывание считало бы, что
// сообщений не было.
const journalFile = exists(P.chatOld) ? P.chatOld : path.join(P.chatDir, gid + '.ndjson');
const journal = scanJournal(journalFile)
  || { bytes: 0, md5: null, seqs: [], atts: [], bad: 0, first: 0, last: 0 };
const todo = pending(gid);

step('состояние');
say(`группа-основание: ${gid} (${gidFrom})`);
say(`установка: ${installId} (${idFrom}), ник «${nick || '(нет)'}»`);
say(`участник: ${memberId}${haveMembers ? ' (из members.json)' : ' (новый)'}`);
say(`журнал: ${journal.seqs.length} сообщений, номера ${journal.first}…${journal.last},`
  + ` вложений в записях ${journal.atts.length}${journal.bad ? `, нечитаемых строк ${journal.bad}` : ''}`);
say(`вложений файлами в прежней раскладке: ${attLeftCount() || 'нет'}`
  + (attLeftCount() ? ` (${attLeft().map(([k, v]) => `${k}: ${v.length}`).join(', ')})` : ''));
if (!todo.length) {
  okk('переход уже сделан целиком — не делаю ничего, включая снимок');
  const inGroup = ATT_DIRS.reduce((n, k) => n + attList(path.join(P[k], gid)).length, 0);
  console.log(`\nMIGRATE-OK gid=${gid} messages=${journal.seqs.length} att=${inGroup} noop=1`);
  process.exit(0);
}
say(`осталось сделать: ${todo.join(', ')}`);
// Столкновение двух журналов проверяем ДО снимка, а не в момент переноса: иначе
// отказ оставлял бы за собой каталог снимка, а сообщение «каталог не менялся»
// становилось бы неправдой.
if (exists(P.chatOld) && exists(path.join(P.chatDir, gid + '.ndjson'))) {
  stop(`журнал есть и в chat.ndjson, и в chat/${gid}.ndjson.`
    + '\n   Склеивать два журнала скрипт не станет — номера столкнутся, а имя файла'
    + '\n   вложения это и есть номер. Разберись руками, который из них живой.');
}

if (DRY) {
  step('план (ни один байт не тронут)');
  // Случайный gid в сухом прогоне — пример, и это надо сказать: живой прогон
  // сгенерирует свой, и два разных идентификатора в выводе выката иначе читаются
  // как расхождение.
  if (gidFrom === 'сгенерирован') say('идентификатор группы ниже — пример: живой прогон возьмёт свой случайный');
  [`снимок: chat-${STAMP}.bak.ndjson + migrate-${STAMP}/ (счётчик, надгробия, slice-owners, slice-drops, манифест)`,
    `chat.ndjson → chat/${gid}.ndjson  (номера не меняются)`,
    `chat-seq → chat/${gid}.seq`,
    ...ATT_DIRS.map(k => `${k}/<seq>.<ext> → ${k}/${gid}/<seq>.<ext>  (${attList(P[k]).length} файлов)`),
    `chat-gone.json → chat/${gid}.tombs.json  (источник остаётся, gseq и cut как есть)`,
    'addr-salt — 32 случайных байта, отдельным файлом',
    'slice-owners.json, slice-drops.json — снести (соль сменилась)',
    `members.json / groups.json / invites.json — участник ${memberId}, он же создатель группы`,
  ].forEach((l, i) => console.log(`    ${i + 1}. ${l}`));
  console.log('\nЖивой прогон — та же команда без --dry-run.');
  process.exit(0);
}

step('снимок перед всем остальным');
const snap = snapshot({ gid, memberId, installId, journal, journalFile,
  atts: Object.fromEntries(ATT_DIRS.map(k => [k, attList(P[k])])), seqValue:
    exists(P.seqOld) ? String(fs.readFileSync(P.seqOld, 'utf8')).trim() : null });
const snapDir = snap.dir;

step('журнал и счётчик в группу-основание');
const seqValue = moveJournal(gid, { journal });

step('вложения');
const att = moveAtt(gid);

step('надгробия');
moveTombs(gid);

step('соль адреса');
makeSalt();

step('файлы прежней соли');
dropStale();

step('личность и группа');
makeIdentity(gid, installId, nick, memberId);

step('проверка после перехода');
const after = scanJournal(path.join(P.chatDir, gid + '.ndjson'))
  || { seqs: [], md5: null, atts: [] };
const sameSeqs = after.seqs.length === journal.seqs.length
  && after.seqs.every((s, i) => s === journal.seqs[i]);
// Ожидаемый путь вложения уже несёт свой каталог (`voice/841.webm`), поэтому проверка
// одна на все три и врать при появлении нового каталога ей нечем.
const lost = after.atts.filter(f => !exists(path.join(DATA, f.split('/')[0], gid, f.split('/')[1])));
// Надгробия сверяем с ИСТОЧНИКОМ, а не с тем, что сами же написали: утверждение здесь —
// «курсоры не перенумерованы», и проверить его можно только сравнением с прежним файлом.
const goneSrc = exists(P.goneOld) ? mkTombs(readJson(P.goneOld, [])) : null;
const goneNew = readJson(path.join(P.chatDir, gid + '.tombs.json'), null);
const goneOk = !goneSrc || (goneNew && goneNew.gseq === goneSrc.out.gseq
  && goneNew.cut === goneSrc.out.cut && goneNew.tombs.length === goneSrc.out.tombs.length);
const checks = [
  ['номера сообщений не изменились', sameSeqs],
  ['байты журнала не изменились', !journal.md5 || after.md5 === journal.md5],
  [`вложения на месте (${after.atts.length - lost.length}/${after.atts.length})`, !lost.length],
  ['в att/, voice/ и files/ не осталось файлов прежней раскладки', !attLeftCount()],
  [`курсоры надгробий не перенумерованы (gseq=${goneNew ? goneNew.gseq : '—'},`
    + ` cut=${goneNew ? goneNew.cut : '—'})`, goneOk],
  ['slice-owners.json и slice-drops.json убраны', !exists(P.owners) && !exists(P.drops)],
  ['соль адреса лежит своим файлом', exists(P.salt)],
  ['реестры участников и групп на месте', exists(P.members) && exists(P.groups) && exists(P.invites)],
  ['снимок существует', exists(path.join(snapDir, 'manifest.json'))],
];
let bad = 0;
for (const [name, cond] of checks) { if (cond) okk(name); else { warn('НЕ ' + name); bad++; } }
if (lost.length) say(`нет файлов: ${lost.slice(0, 10).join(', ')}`);
if (bad) {
  console.log(`\n⛔ Переход прошёл не целиком: ${bad} проверок не сошлось.`);
  console.log(`   Обратный ход: node league-migrate.js ${DATA} --rollback --snapshot=${path.basename(snapDir)}`);
  process.exit(1);
}
console.log('\n✅ Переход сделан.');
console.log(`   Группа-основание: ${gid}`);
console.log('   Этот идентификатор печатается один раз — он уезжает в конфиг участников.');
console.log(`   Снимок: ${path.basename(snapDir)}${snap.bak ? ` (+ ${snap.bak})` : ' (журнала не было, копировать было нечего)'}`);
console.log(`   Обратный ход: node league-migrate.js ${DATA} --rollback`);
console.log(`\nMIGRATE-OK gid=${gid} messages=${after.seqs.length} att=${att.moved}`
  + ` tombs=${goneNew ? goneNew.tombs.length : 0} gseq=${goneNew ? goneNew.gseq : 0} seq=${seqValue}`);
