#!/usr/bin/env node
// Починить всё, что могло отвязаться после переноса или переименования папки.
// Работает одинаково на Windows и macOS, безопасно запускать повторно.
//
// Что вообще привязано к пути:
//   1. статус-лайн Claude Code — указатель ~/.claude/autoreger-root.txt + шим;
//   2. exec-bit у DASHBOARD.command и routing/*.sh на macOS (git с включённым
//      core.fileMode=false о разнице режимов молчит);
//   3. tools/tg-venv — Python-venv запоминает АБСОЛЮТНЫЙ путь при создании и
//      после переноса ломается; пересоздать можно только установщиком, поэтому
//      здесь только предупреждаем (venv нужен для Camoufox/ТГ на Windows).
//
// Обычно вызывать не нужно: пункты 1-2 делает restart-dashboard при каждом
// старте. Это ручная кнопка на случай «перенёс и что-то не так».
//
// Запуск:  node tools/relocate.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const claudeDir = path.join(os.homedir(), '.claude');
const ok = s => console.log(`  \x1b[32m+\x1b[0m ${s}`);
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`);

console.log(`\n\x1b[1m== relocate ==\x1b[0m\n  корень репо: ${ROOT}\n`);

// 1. Статус-лайн (указатель + шим + settings.json) — вся логика в одном месте.
try {
    execFileSync(process.execPath, [path.join(__dirname, 'enable-statusline.js')], { stdio: 'inherit' });
} catch {
    warn('статус-лайн привязать не удалось — запусти вручную: node tools/enable-statusline.js');
}

// 2. Права на исполнение (только не-Windows: там понятия exec-bit нет).
if (process.platform !== 'win32') {
    const targets = [
        path.join(ROOT, 'DASHBOARD.command'),
        path.join(ROOT, 'install-mac.sh'),
        ...globFiles(path.join(ROOT, 'routing'), /\.sh$/),
        ...globFiles(path.join(ROOT, 'mac-support', 'shims'), /./),
    ];
    let fixed = 0;
    for (const f of targets) {
        try { fs.chmodSync(f, 0o755); fixed++; } catch {}
    }
    ok(`права на исполнение: ${fixed} файлов`);

    // Карантин: после копирования папки через Finder/архив он может вернуться, и
    // тогда DASHBOARD.command молча не запускается двойным кликом.
    try { execFileSync('xattr', ['-cr', ROOT], { timeout: 30000, stdio: 'ignore' }); ok('карантин macOS снят'); } catch {}
}

// 3. git core.fileMode: без него chmod выше выглядит для git как локальная правка,
// и следующий `git pull` встаёт с «your local changes would be overwritten».
if (fs.existsSync(path.join(ROOT, '.git'))) {
    try {
        execFileSync('git', ['-C', ROOT, 'config', 'core.fileMode', 'false'], { timeout: 15000, stdio: 'ignore' });
        ok('git core.fileMode=false (chmod не мешает git pull)');
    } catch {}
}

// 4. Python-venv: путь внутри pyvenv.cfg абсолютный, после переноса не работает.
const cfg = path.join(ROOT, 'tools', 'tg-venv', 'pyvenv.cfg');
if (fs.existsSync(cfg)) {
    let stale = false;
    try {
        const txt = fs.readFileSync(cfg, 'utf8');
        const m = /^command\s*=.*?-m venv (.+)$/m.exec(txt);
        if (m) stale = path.resolve(m[1].trim()) !== path.join(ROOT, 'tools', 'tg-venv');
    } catch {}
    if (stale) {
        warn('tools/tg-venv создан для СТАРОГО пути и работать не будет (нужен только');
        warn('  для Camoufox/ТГ на Windows). Пересоздать: удали tools/tg-venv и запусти install-deps.sh');
    } else {
        ok('tools/tg-venv — путь совпадает');
    }
}

console.log('\n  Дальше: рестарт дашборда и перезапуск claude.');
console.log(process.platform === 'win32'
    ? '    routing\\restart-dashboard.bat'
    : '    bash routing/restart-dashboard.sh');
console.log('');

function globFiles(dir, re) {
    try { return fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f)); }
    catch { return []; }
}
