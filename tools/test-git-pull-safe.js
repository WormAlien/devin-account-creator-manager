// Проверка tools/git-pull-safe.js в песочнице: грязный modelmap не должен ломать
// pull, а выбор юзера обязан выжить; грязный код обязан остановить обновление.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullsafe-'));
const origin = path.join(root, 'origin.git'), seed = path.join(root, 'seed'), work = path.join(root, 'work');
const run = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) process.exitCode = 1; };

execFileSync('git', ['init', '--bare', '-b', 'master', origin]);
execFileSync('git', ['clone', origin, seed]);
run(seed, 'config', 'user.email', 't@t'); run(seed, 'config', 'user.name', 't');
fs.mkdirSync(path.join(seed, 'routing')); fs.mkdirSync(path.join(seed, 'tools'));
fs.writeFileSync(path.join(seed, 'routing/ar-modelmap.json'), '{"opus":"repo-default"}\n');
fs.writeFileSync(path.join(seed, 'code.js'), 'v1\n');
fs.copyFileSync(path.join(__dirname, 'git-pull-safe.js'), path.join(seed, 'tools/git-pull-safe.js'));
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'init'); run(seed, 'push', 'origin', 'master');

execFileSync('git', ['clone', origin, work]);
run(work, 'config', 'user.email', 't@t'); run(work, 'config', 'user.name', 't');

// апстрим ушёл вперёд и менял тот же modelmap (худший случай)
fs.writeFileSync(path.join(seed, 'code.js'), 'v2\n');
fs.writeFileSync(path.join(seed, 'routing/ar-modelmap.json'), '{"opus":"repo-new"}\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up'); run(seed, 'push', 'origin', 'master');

// юзер поменял тир в UI
fs.writeFileSync(path.join(work, 'routing/ar-modelmap.json'), '{"opus":"USER-CHOICE"}\n');

// A: CLI обновляется и сохраняет настройки
const cli = (cwd, ...extra) => {
  try {
    const out = execFileSync(process.execPath, ['tools/git-pull-safe.js', ...extra], { cwd, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
};
const a = cli(work);
ok('A: CLI вышел 0', a.code === 0);
ok('A: код обновился', fs.readFileSync(path.join(work, 'code.js'), 'utf8').trim() === 'v2');
ok('A: выбор юзера сохранён', fs.readFileSync(path.join(work, 'routing/ar-modelmap.json'), 'utf8').includes('USER-CHOICE'));
ok('A: сказал про сохранённые настройки', /ar-modelmap\.json/.test(a.out));

// B: грязный код → код выхода 3, ничего не тронуто
fs.writeFileSync(path.join(seed, 'code.js'), 'v3\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up2'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'code.js'), 'LOCAL HACK\n');
const b = cli(work);
ok('B: код выхода 3', b.code === 3);
ok('B: назвал мешающий файл', /code\.js/.test(b.out));
ok('B: правки юзера целы', fs.readFileSync(path.join(work, 'code.js'), 'utf8').includes('LOCAL HACK'));

// C: модуль возвращает структуру (как зовёт дашборд)
fs.writeFileSync(path.join(work, 'code.js'), 'v2\n');   // убрали помеху
run(work, 'checkout', '--', 'code.js');
const mod = require(path.join(work, 'tools/git-pull-safe.js'));
const r = mod.pullSafe();
ok('C: pullSafe().ok', r.ok === true);
ok('C: preserved — массив', Array.isArray(r.preserved));
ok('C: LOCAL_STATE_FILES экспортирован', mod.LOCAL_STATE_FILES.includes('routing/ar-modelmap.json'));

// D: НИ ОДНА трекаемая тир-карта не осталась без защиты.
// Проверяем против настоящего репо, а не против списка в коде: список и был
// источником бага — `routing/xpeach-modelmap.json` трекался и писался из UI, но в
// перечислении его забыли, и обновление у второго пользователя встало насмерть
// (21.08). Заводя нового провайдера, эту проверку уронит именно забытая карта.
const real = require(path.resolve(__dirname, 'git-pull-safe.js'));
const tracked = run(path.resolve(__dirname, '..'), 'ls-files', 'routing/*-modelmap.json')
    .split('\n').map(s => s.trim()).filter(Boolean);
ok('D: тир-карты в репо нашлись', tracked.length >= 4);
const unprotected = tracked.filter(f => !real.isStateFile(f));
ok(`D: все ${tracked.length} тир-карт защищены${unprotected.length ? ' — ДЫРКА: ' + unprotected.join(', ') : ''}`,
   unprotected.length === 0);
// И обратное: настоящий код файлом состояния не считается, иначе pull молча
// откатывал бы правки в коде вместо того, чтобы о них сказать.
ok('D: код не считается состоянием', real.isStateFile('routing/transparent-proxy.js') === false);

// E: --stash — правки кода НЕ блокируют обновление, а прячутся и возвращаются.
// Это режим, который жмёт кнопка в дашборде после подтверждения. До 21.08 умный
// путь был только в update.sh, и человек с правками кода застревал на кнопке.
fs.writeFileSync(path.join(seed, 'code.js'), 'v4\n');
fs.writeFileSync(path.join(seed, 'routing/ar-modelmap.json'), '{"opus":"repo-v4"}\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up4'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'code.js'), 'LOCAL HACK 2\n');            // правка кода
fs.writeFileSync(path.join(work, 'routing/ar-modelmap.json'), '{"opus":"USER-2"}\n'); // и настройка

const e = cli(work, '--stash');
ok('E: --stash вышел 0', e.code === 0);
ok('E: код обновился', fs.readFileSync(path.join(work, 'code.js'), 'utf8').trim() === 'v4');
ok('E: выбор юзера сохранён', fs.readFileSync(path.join(work, 'routing/ar-modelmap.json'), 'utf8').includes('USER-2'));
ok('E: сказал про stash', /stash/i.test(e.out) && /code\.js/.test(e.out));
// Правки кода не потеряны — они В СТЭШЕ. Проверяем именно наличие и содержимое, а
// НЕ то, что `git stash pop` применится чисто: если апстрим менял тот же файл, pop
// честно даёт конфликт (проверено здесь живьём — code.js разошёлся v2→v4). Поэтому
// и в UI обещаем «лежит в стэше», а не «вернётся одной командой без вопросов».
const stashList = run(work, 'stash', 'list');
ok('E: запись в stash есть', /git-pull-safe auto-stash/.test(stashList));
ok('E: в стэше именно правка кода', /LOCAL HACK 2/.test(run(work, 'stash', 'show', '-p', 'stash@{0}')));
// Стэш НЕ трогаем: pop мог бы оставить дерево в конфликте и сломать проверку E-контроль.
// И контроль, что тест не зелёный по случайности: БЕЗ --stash тот же расклад обязан
// упереться в код выхода 3, иначе E ничего не проверяет.
fs.writeFileSync(path.join(seed, 'code.js'), 'v5\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up5'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'code.js'), 'LOCAL HACK 3\n');
const noStash = cli(work);
ok('E: без --stash тот же расклад даёт код 3', noStash.code === 3);
ok('E: без --stash правки на месте', fs.readFileSync(path.join(work, 'code.js'), 'utf8').includes('LOCAL HACK 3'));
run(work, 'checkout', '--', 'code.js');   // убрали помеху от E

// F: апстрим завёл ФАЙЛ, которого у нас нет в git, а у человека он уже лежит.
// `git diff --name-only HEAD` неотслеживаемое не видит вообще, поэтому раньше
// dirty был пуст, blocking пуст, и наружу уходило сырое «The following untracked
// working tree files would be overwritten by merge». Два подслучая:
//   F1 — это тир-карта: настройка, её надо сберечь молча (как трекаемую);
//   F2 — это чей-то файл: помеха, называем и прячем в stash по подтверждению.
fs.writeFileSync(path.join(seed, 'routing/newprov-modelmap.json'), '{"opus":"repo-newprov"}\n');
fs.writeFileSync(path.join(seed, 'extra.js'), 'upstream extra\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up6'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'routing/newprov-modelmap.json'), '{"opus":"USER-NEWPROV"}\n'); // F1
fs.writeFileSync(path.join(work, 'extra.js'), 'MY OWN EXTRA\n');                                 // F2

const f1 = cli(work);
ok('F: без --stash код выхода 3', f1.code === 3);
ok('F: назвал неотслеживаемую помеху', /extra\.js/.test(f1.out));
ok('F: пометил, что файл новый', /новый файл/.test(f1.out));
ok('F: не тронул чужой файл', fs.readFileSync(path.join(work, 'extra.js'), 'utf8').includes('MY OWN EXTRA'));
ok('F: тир-карту юзера не выбросил', fs.readFileSync(path.join(work, 'routing/newprov-modelmap.json'), 'utf8').includes('USER-NEWPROV'));

const f2 = cli(work, '--stash');
ok('F: --stash вышел 0', f2.code === 0);
ok('F: untracked тир-карта юзера сохранена',
   fs.readFileSync(path.join(work, 'routing/newprov-modelmap.json'), 'utf8').includes('USER-NEWPROV'));
// `git stash show -p` неотслеживаемое НЕ показывает (оно лежит в третьем родителе
// стэш-коммита) — смотреть надо с --include-untracked, иначе проверка врёт «пусто».
ok('F: untracked чужой файл в стэше',
   /MY OWN EXTRA/.test(run(work, 'stash', 'show', '-p', '--include-untracked', 'stash@{0}')));
ok('F: апстримная версия файла на месте', fs.readFileSync(path.join(work, 'extra.js'), 'utf8').includes('upstream extra'));

// G: свои коммиты, разошедшиеся с master. `--ff-only` даёт «Not possible to
// fast-forward», а regex про «local changes» его не ловил — уходил сырой текст.
// Требуем: понятное объяснение, счёт своих коммитов, команда, и НИ ОДИН свой
// коммит не потерян (auto-reset здесь запрещён).
fs.writeFileSync(path.join(seed, 'code.js'), 'v6\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up7'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'mine.js'), 'my own commit\n');
run(work, 'add', '-A'); run(work, 'commit', '-m', 'my local commit');
const head = run(work, 'rev-parse', 'HEAD').trim();

const g = cli(work, '--stash');   // даже в «умном» режиме не имеет права ресетить
// Код 4, а не 1: по нему update.sh/fix.sh обязаны НЕ доезжать до
// `reset --hard origin/master` — он выбросил бы ровно эти коммиты.
ok('G: код выхода 4 (diverged)', g.code === 4);
ok('G: объяснил расхождение', /История разошлась/.test(g.out));
ok('G: посчитал свои коммиты', /у тебя 1 своих коммит/.test(g.out));
ok('G: подсказал команду', /git pull --rebase/.test(g.out));
ok('G: свой коммит на месте', run(work, 'rev-parse', 'HEAD').trim() === head);
ok('G: свой файл цел', fs.existsSync(path.join(work, 'mine.js')));
ok('G: diverged в структуре ответа', require(path.join(work, 'tools/git-pull-safe.js')).pullSafe().diverged === true);

// H: батники. update.sh/fix.sh при неудачном pull имели последнее средство
// `git fetch && git reset --hard origin/master` — на разошедшейся истории это
// молча уничтожало незапушенные коммиты (в update.sh даже с бодрой строчкой
// «локальные коммиты уйдут в сторону»). Проверяем на живом расхождении из G, что
// оба скрипта коммит НЕ теряют. Гоняем только блок обновления кода: остальное
// (kill портов, install.sh) в песочнице не нужно и небезопасно.
const shell = fs.existsSync('/usr/bin/bash') ? '/usr/bin/bash' : 'bash';
function updateBlock(file, upto) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const from = src.indexOf('PULL_RC=0'), cut = src.indexOf(upto);
  if (from < 0 || cut < 0 || cut < from) {
    throw new Error(`${file}: не нашёл блок обновления кода — тест устарел вместе со скриптом`);
  }
  // Шапку скриптов (cd в свою папку, цвета, kill портов) не берём: в песочнице она
  // увела бы git не туда. Только ветка PULL_RC + заглушки логгеров и read.
  return 'b(){ echo "$@"; }; ok(){ echo "$@"; }; warn(){ echo "$@"; }; err(){ echo "$@"; }; '
       + 'step(){ echo "$@"; }; read(){ :; };\n' + src.slice(from, cut);
}
function runBlock(file, upto, stdin) {
  const script = path.join(root, `block-${file}.sh`);
  fs.writeFileSync(script, updateBlock(file, upto));
  try {
    return { code: 0, out: execFileSync(shell, [script], { cwd: work, encoding: 'utf8', input: stdin || '\n' }) };
  } catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
// В песочнице шапка скриптов (cd в свою папку) не нужна — вырезаем всё до блока
// обновления и подсовываем заглушки; интересует ровно ветка PULL_RC.
const up = runBlock('update.sh', 'ok "Стало:', 'y\n');
ok('H: update.sh не выбросил свой коммит', run(work, 'rev-parse', 'HEAD').trim() === head);
ok('H: update.sh сказал про расхождение', /свои коммиты/.test(up.out));
// Проверяем не «не упоминал reset» (скрипт как раз ПЕЧАТАЕТ эту команду подсказкой
// человеку), а что грубая ветка не выполнялась.
ok('H: update.sh не пошёл в принудительный master', !/забираю master принудительно/.test(up.out));
const fx = runBlock('fix.sh', 'ok "стало:');
ok('H: fix.sh не выбросил свой коммит', run(work, 'rev-parse', 'HEAD').trim() === head);
ok('H: fix.sh сказал про расхождение', /разошлись с master/.test(fx.out));
ok('H: mine.js цел после обоих', fs.readFileSync(path.join(work, 'mine.js'), 'utf8').includes('my own commit'));

// ── I / J: файл, грязный ТОЛЬКО переводами строк ─────────────────────────────
// Расклад с живого репо (Windows, core.autocrlf=true, `*.json text`): дашборд
// перезаписывает тир-карту из Node — `JSON.stringify + '\n'`, то есть LF, — а git
// ждёт в рабочей копии CRLF. Содержимое при этом совпадает с HEAD байт в байт после
// нормализации, поэтому `git diff --name-only HEAD` ПУСТ, а `git pull` встаёт на
// «local changes would be overwritten». Тупик: откатывать нечего, обновиться нельзя,
// а починка доезжает только тем самым обновлением.
// I — старый мир (`*.json text`): pullSafe обязан вывезти.
// J — с `eol=lf` на файлы состояния грязь не возникает вообще.
function sandbox(name, attributes) {
  const o = path.join(root, `${name}.git`), s = path.join(root, `${name}-seed`), w = path.join(root, `${name}-work`);
  execFileSync('git', ['init', '--bare', '-b', 'master', o]);
  execFileSync('git', ['clone', o, s]);
  run(s, 'config', 'user.email', 't@t'); run(s, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(s, 'routing')); fs.mkdirSync(path.join(s, 'tools'));
  fs.writeFileSync(path.join(s, '.gitattributes'), attributes);
  fs.writeFileSync(path.join(s, 'routing/ar-modelmap.json'), '{\n  "opus": "repo-default"\n}\n');
  fs.writeFileSync(path.join(s, 'code.js'), 'v1\n');
  fs.copyFileSync(path.join(__dirname, 'git-pull-safe.js'), path.join(s, 'tools/git-pull-safe.js'));
  run(s, 'add', '-A'); run(s, 'commit', '-m', 'init'); run(s, 'push', 'origin', 'master');
  // Клонируем ИМЕННО с autocrlf=true — это и есть настройка живого репо на Windows,
  // без неё расхождение не возникает и тест ничего не проверяет.
  execFileSync('git', ['clone', '-c', 'core.autocrlf=true', o, w]);
  run(w, 'config', 'user.email', 't@t'); run(w, 'config', 'user.name', 't');
  // Апстрим ушёл вперёд и тронул ТОТ ЖЕ json: без этого git на грязный по eol файл
  // не жалуется вовсе (проверено) — pull проходит и случай не воспроизводится.
  fs.writeFileSync(path.join(s, 'code.js'), 'v2\n');
  fs.writeFileSync(path.join(s, 'routing/ar-modelmap.json'), '{\n  "opus": "repo-new"\n}\n');
  run(s, 'add', '-A'); run(s, 'commit', '-m', 'up'); run(s, 'push', 'origin', 'master');
  return { seed: s, work: w, map: path.join(w, 'routing/ar-modelmap.json') };
}

const i = sandbox('eol', '*.json text\n');
ok('I: git отдал рабочую копию с CRLF', fs.readFileSync(i.map, 'utf8').includes('\r\n'));
// «Дашборд» переписал файл: значение то же, переводы строк — LF.
fs.writeFileSync(i.map, '{\n  "opus": "repo-default"\n}\n');
// Контроль, что тест воспроизводит именно слепое пятно, а не обычную грязь: старый
// детект файл НЕ видит, новый — видит. Уберут union из dirtyFiles() — упадёт I ниже.
ok('I: старый детект (diff HEAD) файл НЕ видит', run(i.work, 'diff', '--name-only', 'HEAD').trim() === '');
ok('I: diff-files его видит', /ar-modelmap\.json/.test(run(i.work, 'diff-files', '--name-only')));
let plainPull = 0;
try { run(i.work, 'pull', '--ff-only'); } catch (e) { plainPull = e.status; }
ok('I: обычный git pull встаёт насмерть', plainPull !== 0);
const iRes = cli(i.work);
ok('I: pullSafe вывез (код 0)', iRes.code === 0);
ok('I: код обновился', fs.readFileSync(path.join(i.work, 'code.js'), 'utf8').trim() === 'v2');
ok('I: значение юзера сохранено', /repo-default/.test(fs.readFileSync(i.map, 'utf8')));
ok('I: сказал про сохранённые настройки', /ar-modelmap\.json/.test(iRes.out));

const j = sandbox('eollf', '*.json text\nrouting/*-modelmap.json text eol=lf\n');
ok('J: с eol=lf рабочая копия сразу LF', !fs.readFileSync(j.map, 'utf8').includes('\r\n'));
fs.writeFileSync(j.map, '{\n  "opus": "repo-default"\n}\n');   // тот же Node-writer
ok('J: файл не стал грязным', run(j.work, 'status', '--porcelain').trim() === '');
let plainPullJ = 0;
try { run(j.work, 'pull', '--ff-only'); } catch (e) { plainPullJ = e.status; }
ok('J: обычный git pull из консоли проходит', plainPullJ === 0);

// K: правило eol=lf стоит на КАЖДОМ файле состояния настоящего репо. Проверяем
// против самого git'а (`check-attr`), а не против текста .gitattributes: строчку
// там забыть так же легко, как забыли `xpeach-modelmap.json` в перечислении.
const repoRoot = path.resolve(__dirname, '..');
const stateFiles = run(repoRoot, 'ls-files', 'routing/*.json')
    .split('\n').map(s => s.trim()).filter(f => f && real.isStateFile(f));
ok('K: файлы состояния в репо нашлись', stateFiles.length >= 5);
const noLf = stateFiles.filter(f => !/eol: lf/.test(run(repoRoot, 'check-attr', 'eol', '--', f)));
ok(`K: у всех ${stateFiles.length} стоит eol=lf${noLf.length ? ' — ДЫРКА: ' + noLf.join(', ') : ''}`,
   noLf.length === 0);

fs.rmSync(root, { recursive: true, force: true });
