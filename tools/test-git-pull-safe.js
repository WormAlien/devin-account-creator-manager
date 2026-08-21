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
const cli = (cwd) => {
  try {
    const out = execFileSync(process.execPath, ['tools/git-pull-safe.js'], { cwd, encoding: 'utf8' });
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

fs.rmSync(root, { recursive: true, force: true });
