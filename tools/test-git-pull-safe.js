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

fs.rmSync(root, { recursive: true, force: true });
