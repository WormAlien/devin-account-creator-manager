#!/usr/bin/env node
// Включить статус-лайн Autoreger в ~/.claude/settings.json.
//
// Зачем отдельный скрипт: в claude-settings.example.json секции statusLine нет, а
// установщик копирует шаблон только если settings.json ещё не существует. У всех,
// кто уже поставился, статус-лайн выключен, и включать надо в СУЩЕСТВУЮЩЕМ файле,
// не потеряв ключи и остальные настройки.
//
// Путь к скрипту берётся от текущего репо, поэтому работает из любой папки
// установки — и на маке, и на Windows.
//
// Ключи не печатаются, перед записью делается бэкап.
// Запуск:  node tools/enable-statusline.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const script = path.resolve(__dirname, '..', 'routing', 'statusline-autoreger.sh');
if (!fs.existsSync(script)) {
    console.error(`✗ не найден ${script} — запускай из папки репозитория (сначала git pull)`);
    process.exit(1);
}

// Путь всегда с прямыми слэшами: обратные в JSON пришлось бы экранировать, а
// битый settings.json роняет Claude Code целиком.
const unix = script.split('\\').join('/');

// Обёртка нужна РОВНО в одном случае: когда `bash` в PATH — это WSL-овский
// C:\Windows\System32\bash.exe. Он не открывает пути вида C:/…, их надо
// конвертировать wslpath, а ещё wslpath/cmd.exe по пути съедают stdin-пайп, из-за
// чего payload от CC теряется и модель показывается как «unknown» — поэтому
// payload уезжает через env STATUSLINE_PAYLOAD.
// Для git-bash на Windows и для macOS/Linux обёртка вредна: install.sh ставит там
// простую команду, и два установщика писали бы в settings.json разное.
function bashIsWsl() {
    if (process.platform !== 'win32') return false;
    try {
        const out = execFileSync('bash', ['-c', 'printf "%s|%s" "${WSL_DISTRO_NAME:-}" "$(uname -r)"'], {
            encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const [distro, kernel] = out.split('|');
        return !!distro || /microsoft|wsl/i.test(kernel || '');
    } catch { return false; }
}

const cmd = bashIsWsl()
    ? "bash -c 'pl=\"$(cat 2>/dev/null)\"; "
        + `s="${unix}"; `
        + 'if command -v wslpath >/dev/null 2>&1; then s=$(wslpath -u "$s"); '
        + 'elif command -v cygpath >/dev/null 2>&1; then s=$(cygpath -u "$s"); fi; '
        + 'exec env STATUSLINE_PAYLOAD="$pl" bash "$s"\''
    : `bash "${unix}"`;

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
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
    const backup = path.join(os.homedir(), '.claude', 'settings.backup.json');
    fs.writeFileSync(backup, raw);
    console.log(`  бэкап: ${backup}`);
} else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    console.log('  settings.json не было — создаю');
}

const before = json.statusLine && json.statusLine.command;
if (before === cmd) {
    console.log('✓ статус-лайн уже включён, путь верный — менять нечего');
    process.exit(0);
}

json.statusLine = { type: 'command', command: cmd };
fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2) + '\n', 'utf8');

console.log(before ? '✓ путь статус-лайна обновлён' : '✓ статус-лайн включён');
console.log(`  ${cmd}`);
console.log('\nПерезапусти Claude Code (выйди и запусти claude заново) — снизу появится:');
console.log('  agentrouter/opus │ $37.54 │ ⧉ 139k/1M');
