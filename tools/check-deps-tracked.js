#!/usr/bin/env node
//
// check-deps-tracked.js — ловит класс поломки «запушенный код требует файл, которого
// в репо нет».
//
// Как это выстрелило 2026-08-21: `transparent-proxy.js` и `keepalive-proxy.js` уехали
// в master с `require('./latency-store.js')`, а сам модуль лежал untracked. Локально
// всё работало (файл на диске есть), у второго пользователя `UPDATE.bat` + рестарт =
// `MODULE_NOT_FOUND` на старте `:8200`, то есть мёртвый дашборд. `git status` такое не
// подсвечивает: untracked-файл выглядит как «мой мусор», а не как «чужая зависимость».
//
// Проверяем два пути, которыми код тянет соседние файлы:
//   1. require('./x') в отслеживаемых .js — падение на СТАРТЕ процесса;
//   2. spawn/fork/execFile('…/x.js') — падение в РАНТАЙМЕ, когда нажали кнопку.
//
// Ошибка = файл на диске ЕСТЬ, в индексе git его НЕТ, и .gitignore его НЕ упоминает.
// Все три условия важны. Просто «нет в git» — не баг: `config.js` и `notion/config.js`
// намеренно в .gitignore, рядом лежат `.example`-версии, их создаёт установщик. Баг —
// когда файл забыли: не отслеживается и не игнорируется, то есть про него никто не решал.
// Отсутствие файла на диске вообще — третья категория (опциональные require), заметкой.
//
// Запуск: node tools/check-deps-tracked.js   (exit 1 = не пушить)
// Автоматом: .githooks/pre-push (включается `git config core.hooksPath .githooks`)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const rel = p => path.relative(REPO, p).split(path.sep).join('/');

function git(args) {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const tracked = new Set(git(['ls-files']).split('\n').map(s => s.trim()).filter(Boolean));
const SELF = rel(__filename);
const jsFiles = [...tracked].filter(f => f.endsWith('.js')
    && !f.startsWith('node_modules/')
    && f !== SELF);   // в этом файле require'ы живут в комментариях как примеры

// Комментарии выкидываем: закомментированный require — не зависимость. `//` рубим
// только когда перед ним не двоеточие и не кавычка, иначе под нож уходят URL'ы.
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// Резолв как у Node: сначала как есть, потом +.js, потом /index.js.
function resolveLocal(fromFile, spec) {
    const base = path.resolve(REPO, path.dirname(fromFile), spec);
    for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    return null;
}

const errors = [];   // на диске есть, в git нет, в .gitignore нет → сломает всех, кроме автора
const ignored = [];  // на диске есть, но намеренно в .gitignore (генерится установщиком)
const notes = [];    // не найдено вообще → возможно опциональный require

// Отложенная проверка .gitignore: один вызов git на всю пачку вместо вызова на файл.
const suspects = [];
function suspect(rec) { suspects.push(rec); }

const RE_REQUIRE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const RE_SPAWNISH = /\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g;
const RE_JS_LITERAL = /['"]([\w.@/-]+\.js)['"]/g;

for (const file of jsFiles) {
    const src = stripComments(fs.readFileSync(path.join(REPO, file), 'utf8'));

    for (const m of src.matchAll(RE_REQUIRE)) {
        const abs = resolveLocal(file, m[1]);
        if (!abs) { notes.push({ file, spec: m[1], kind: 'require' }); continue; }
        if (!tracked.has(rel(abs))) suspect({ file, spec: m[1], target: rel(abs), kind: 'require' });
    }

    // spawn-подобные вызовы часто многострочные, поэтому смотрим окно после вызова.
    for (const call of src.matchAll(RE_SPAWNISH)) {
        const window = src.slice(call.index, call.index + 400);
        for (const lit of window.matchAll(RE_JS_LITERAL)) {
            const name = lit[1];
            // Кандидаты: рядом с файлом и от корня репо — так пишут оба стиля
            // (path.join(__dirname, 'x.js') и 'routing/x.js').
            const cands = [
                path.resolve(REPO, path.dirname(file), name),
                path.resolve(REPO, name),
            ];
            const abs = cands.find(c => fs.existsSync(c) && fs.statSync(c).isFile());
            if (!abs) continue;   // не наш файл (модуль из node_modules, путь из env и т.п.)
            const r = rel(abs);
            if (r.startsWith('node_modules/')) continue;
            if (!tracked.has(r) && !suspects.some(e => e.file === file && e.target === r)) {
                suspect({ file, spec: name, target: r, kind: 'spawn' });
            }
        }
    }
}

// Кто из подозреваемых лежит в .gitignore — тот законный: файл генерится или содержит
// секреты, и его отсутствие лечится установщиком, а не коммитом. `check-ignore --stdin`
// отдаёт только совпавшие пути, поэтому один вызов на всю пачку.
if (suspects.length) {
    const uniqTargets = [...new Set(suspects.map(s => s.target))];
    let matched = new Set();
    try {
        const out = execFileSync('git', ['check-ignore', '--stdin'],
            { cwd: REPO, encoding: 'utf8', input: uniqTargets.join('\n') });
        matched = new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
    } catch (e) {
        // exit 1 = совпадений нет вовсе; любой другой код — реальная ошибка git.
        if (e.status !== 1) throw e;
    }
    for (const s of suspects) (matched.has(s.target) ? ignored : errors).push(s);
}

const scanned = jsFiles.length;
if (!errors.length) {
    console.log(`OK: ${scanned} отслеживаемых .js — все локальные require и spawn ведут в репо.`);
    if (ignored.length) {
        const list = [...new Set(ignored.map(i => i.target))];
        console.log(`Намеренно вне репо (в .gitignore, создаёт установщик): ${list.join(', ')}`);
    }
    if (notes.length) {
        console.log(`\nЗаметка: ${notes.length} require не резолвятся на диске (возможно, опциональные):`);
        for (const n of notes.slice(0, 10)) console.log(`  ${n.file} → ${n.spec}`);
    }
    process.exit(0);
}

console.error(`ПРОВАЛ: ${errors.length} зависимост(ей) есть на диске, но НЕТ ни в git, ни в .gitignore.`);
console.error('У всех, кто склонирует или обновится, это MODULE_NOT_FOUND — у автора всё зелено.\n');
for (const e of errors) {
    const how = e.kind === 'require' ? 'require на старте процесса' : 'spawn в рантайме';
    console.error(`  ${e.file}\n      ${how}: '${e.spec}' → ${e.target}  ← вне репо`);
}
const uniq = [...new Set(errors.map(e => e.target))];
console.error(`\nПочинить: git add ${uniq.join(' ')}`);
console.error('Если файл НЕ должен быть в репо — убрать зависимость или добавить его в .gitignore');
console.error('и явный фолбэк в коде (try/catch вокруг require).');
process.exit(1);
