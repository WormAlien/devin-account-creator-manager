#!/usr/bin/env node
// Включить статус-лайн Autoreger в ~/.claude/settings.json.
//
// Ставит НЕ прямой путь к репо, а шим в ~/.claude/autoreger-statusline.sh.
// Зачем: settings.json требует команду с конкретным путём, и если писать туда
// путь до репо, то любой перенос/переименование папки проекта молча ломает
// статус-бар. Шим лежит в домашней папке (она не двигается) и читает актуальный
// корень репо из ~/.claude/autoreger-root.txt, который обновляет
// restart-dashboard при каждом старте дашборда. Копировать сам
// statusline-autoreger.sh в ~/.claude нельзя — копия окаменеет, репа обновится,
// а CC будет гонять древний файл.
//
// Чужой statusLine (не наш) не трогаем без --force.
// Ключи не печатаются, перед записью делается бэкап.
// Запуск:  node tools/enable-statusline.js [--force]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = path.join(ROOT, 'routing', 'statusline-shim.sh');
const worker = path.join(ROOT, 'routing', 'statusline-autoreger.sh');
for (const f of [source, worker]) {
    if (!fs.existsSync(f)) {
        console.error(`✗ не найден ${f} — запускай из папки репозитория (сначала git pull)`);
        process.exit(1);
    }
}

const claudeDir = path.join(os.homedir(), '.claude');
fs.mkdirSync(claudeDir, { recursive: true });

// 1. Файл-указатель на корень репо. Прямые слэши — их понимают и git-bash, и WSL.
const rootFile = path.join(claudeDir, 'autoreger-root.txt');
fs.writeFileSync(rootFile, ROOT.split('\\').join('/') + '\n', 'utf8');

// 2. Шим рядом с ним. Копируем всегда: файл крошечный, а в репо он может
// обновиться (и тогда старая копия должна уехать).
const shim = path.join(claudeDir, 'autoreger-statusline.sh');
fs.copyFileSync(source, shim);
try { fs.chmodSync(shim, 0o755); } catch {}

// 3. settings.json
const cmd = `bash "${shim.split('\\').join('/')}"`;
const settingsPath = path.join(claudeDir, 'settings.json');
let json = {};
if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
        json = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch (e) {
        console.error(`✗ ${settingsPath} не читается как JSON: ${e.message}`);
        console.error('  ничего не перезаписываю — поправь файл вручную.');
        process.exit(1);
    }
    fs.writeFileSync(path.join(claudeDir, 'settings.backup.json'), raw);
} else {
    console.log('  settings.json не было — создаю');
}

const cur = (json.statusLine && json.statusLine.command) || '';
const ours = /autoreger-statusline\.sh|statusline-autoreger\.sh/.test(cur);
if (cur && !ours && !process.argv.includes('--force')) {
    console.log('! в settings.json свой statusLine — не трогаю');
    console.log(`  сейчас: ${cur.slice(0, 100)}`);
    console.log('  перебить: node tools/enable-statusline.js --force');
    process.exit(0);
}

console.log(`  корень репо: ${ROOT}`);
console.log(`  указатель:   ${rootFile}`);

if (cur === cmd) {
    console.log('✓ статус-лайн уже включён через шим — путь переживёт перенос папки');
    process.exit(0);
}

json.statusLine = { type: 'command', command: cmd };
fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2) + '\n', 'utf8');

console.log(cur ? '✓ статус-лайн переведён на шим (был прямой путь к репо)' : '✓ статус-лайн включён');
console.log(`  ${cmd}`);
console.log('\nПерезапусти Claude Code — снизу появится:');
console.log('  agentrouter/opus │ $37.54 │ ⧉ 139k/1M');
