'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  dictation-fix.js — установка/выключение фикса диктовки Orca из хаба.
//
//  Что за фикс: Wispr Flow кладёт распознанный текст в буфер и синтезирует Ctrl+V,
//  а Orca отменяет вставку панели, потерявшей фокус (с 1.4.185 — молча). Фокус
//  уносит оверлей диктовки ВНУТРИ рендерера: на уровне окна активным остаётся
//  Orca.exe, поэтому вернуть фокус снаружи нельзя. Скрипт перехватывает Ctrl+V от
//  Wispr и ПЕЧАТАЕТ текст символами — набор отменить нельзя. Ручной Ctrl+V идёт
//  мимо: у него Ctrl физически зажат.
//
//  Скрипт (tools/clip-as-typing/clip-as-typing.ahk) НЕ трогаем: он прошёл семь
//  ревизий за ночь, четыре из них были нерабочими. Обёртки — сторож и его
//  vbs-шим — ГЕНЕРИРУЮТСЯ здесь под пути конкретной машины: в оригинале они
//  ссылались на D:\WORMALIENAIGIGANT\scripts, то есть работали у одного человека.
//
//  Только Windows: AutoHotkey на macOS не существует.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'tools', 'clip-as-typing', 'clip-as-typing.ahk');

// Рабочая папка — в профиле пользователя, а не в репо: репо публичный и его
// перезаписывает git pull, а тут лежит лог и живут пути автозагрузки.
const HOME_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'abuse-hub', 'clip-as-typing');
const AHK = path.join(HOME_DIR, 'clip-as-typing.ahk');
const GUARD_PS1 = path.join(HOME_DIR, 'guard.ps1');
const GUARD_VBS = path.join(HOME_DIR, 'guard.vbs');
const LOG = path.join(HOME_DIR, 'clip-as-typing.log');
const TASK = 'clip-as-typing guard';
const LNK_NAME = 'clip-as-typing.lnk';

const AHK_EXE = [
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey64.exe'),
];

function ahkPath() {
    return AHK_EXE.find(p => p && fs.existsSync(p)) || '';
}

// PowerShell зовём с -NoProfile: профиль пользователя может печатать баннеры и
// менять кодировку вывода, а мы этот вывод разбираем как JSON.
function ps(script) {
    return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 });
}

// ── Состояние ────────────────────────────────────────────────────────────────
// 🪤 Процесс ищем по КОМАНДНОЙ СТРОКЕ, а не по имени образа. На этой машине живёт
// второй AutoHotkey — индикатор раскладки в трее (lang-flag-tray.ahk), — и счёт
// по имени `AutoHotkey64.exe` считает его тоже. Убийство по имени однажды снесло
// именно его, и «сломался индикатор» искали отдельно.
function state() {
    const out = {
        windows: IS_WIN,
        ahk: ahkPath(),
        installed: fs.existsSync(AHK),
        pid: 0,
        startup: false,
        task: false,
        logTail: '',
        dir: HOME_DIR,
        runningFrom: '',
        managed: false,
    };
    if (!IS_WIN) return out;

    const r = ps(`
$ErrorActionPreference='SilentlyContinue'
$p = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'AutoHotkey%'" |
       Where-Object { $_.CommandLine -like '*clip-as-typing.ahk*' })
$startup = [Environment]::GetFolderPath('Startup')
[pscustomobject]@{
  pid     = if ($p.Count) { $p[0].ProcessId } else { 0 }
  cmd     = if ($p.Count) { $p[0].CommandLine } else { '' }
  startup = (Test-Path -LiteralPath (Join-Path $startup '${LNK_NAME}'))
} | ConvertTo-Json -Compress`);
    try {
        const j = JSON.parse(String(r.stdout || '{}'));
        out.pid = Number(j.pid) || 0;
        out.startup = !!j.startup;
        // Откуда именно запущен живой процесс. Важно: на машине владельца фикс уже
        // стоял руками из D:\WORMALIENAIGIGANT\scripts, и «процесс жив» вместе с
        // «скрипт не установлен» без этой строки читается как противоречие.
        const m = String(j.cmd || '').match(/"?([A-Za-z]:\\[^"]*clip-as-typing\.ahk)"?/);
        out.runningFrom = m ? m[1] : '';
        out.managed = !!out.runningFrom && path.resolve(out.runningFrom) === path.resolve(AHK);
    } catch { /* пусто — считаем, что ничего нет */ }

    // Задачу проверяем schtasks, а не Get-ScheduledTask: код возврата не зависит ни
    // от локали, ни от наличия модуля ScheduledTasks.
    out.task = spawnSync('schtasks', ['/Query', '/TN', TASK], { windowsHide: true, stdio: 'ignore' }).status === 0;

    try {
        out.logTail = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
    } catch { /* лога ещё нет */ }
    return out;
}

// ── Генерация обёрток ────────────────────────────────────────────────────────
// 🪤 Оба файла — строго ASCII. `.ps1` без BOM PowerShell 5.1 читает как ANSI и
// рушится на кириллице в комментариях; с BOM ломается путь `irm … | iex`. ASCII
// годится в обоих случаях, поэтому комментарии здесь по-английски.
function writeGuards() {
    const ahk = ahkPath();
    const q = s => s.replace(/'/g, "''");
    const ps1 = [
        '# Watchdog for clip-as-typing.ahk. Generated by ABUSE HUB - do not edit by hand.',
        '#',
        '# Starts the hotkey script only if it is NOT already running. Never touches a',
        '# healthy instance: AutoHotkey #SingleInstance Force would kill and replace it,',
        '# which is exactly the churn this guard exists to prevent.',
        '#',
        '# Matching is done on the command line, not the image name: another AutoHotkey',
        '# script (the tray keyboard-layout indicator) runs on this machine and counting',
        '# or killing by process name takes the wrong one down.',
        "$ErrorActionPreference = 'Stop'",
        `$ahk    = '${q(ahk)}'`,
        `$script = '${q(AHK)}'`,
        `$log    = '${q(LOG)}'`,
        "$stamp  = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')",
        'function Write-Line([string]$text) {',
        '    try { Add-Content -LiteralPath $log -Value "$stamp $text" -Encoding UTF8 } catch { }',
        '}',
        'if (-not (Test-Path -LiteralPath $ahk))    { Write-Line "guard: AutoHotkey missing"; exit 1 }',
        'if (-not (Test-Path -LiteralPath $script)) { Write-Line "guard: script missing";     exit 1 }',
        '$running = @(Get-CimInstance Win32_Process -Filter "Name LIKE \'AutoHotkey%\'" |',
        "    Where-Object { $_.CommandLine -like '*clip-as-typing.ahk*' })",
        'if ($running.Count -gt 0) { exit 0 }',
        'Write-Line "guard: not running, starting it"',
        'Start-Process -FilePath $ahk -ArgumentList "`"$script`""',
        'Start-Sleep -Seconds 2',
        '$after = @(Get-CimInstance Win32_Process -Filter "Name LIKE \'AutoHotkey%\'" |',
        "    Where-Object { $_.CommandLine -like '*clip-as-typing.ahk*' })",
        'if ($after.Count -gt 0) { Write-Line "guard: started, pid $($after[0].ProcessId)"; exit 0 }',
        'Write-Line "guard: start FAILED"',
        'exit 1',
        '',
    ].join('\r\n');

    // 🪤 Задачу планировщика вызываем через vbs-шим. Прямой powershell.exe мигает
    // консольным окном каждые 10 минут, и `-WindowStyle Hidden` от вспышки не спасает.
    const vbs = [
        "' Silent launcher for guard.ps1. Generated by ABUSE HUB.",
        "'",
        "' The scheduled task runs every 10 minutes. Calling powershell.exe directly",
        "' flashes a console window each time, even with -WindowStyle Hidden; WScript's",
        "' Run with intWindowStyle 0 does not.",
        'Set sh = CreateObject("WScript.Shell")',
        `sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""${GUARD_PS1}""", 0, False`,
        '',
    ].join('\r\n');

    fs.writeFileSync(GUARD_PS1, ps1, 'ascii');
    fs.writeFileSync(GUARD_VBS, vbs, 'ascii');
}

// ── Действия ─────────────────────────────────────────────────────────────────
// Каждое возвращает { ok, steps: [{what, ok, note}] } — хаб печатает шаги как есть,
// чтобы было видно, что именно сделано, а не «готово».
function install() {
    const steps = [];
    const add = (what, ok, note = '') => { steps.push({ what, ok, note }); return ok; };

    if (!IS_WIN) return { ok: false, steps: [{ what: 'Windows', ok: false, note: 'AutoHotkey есть только тут' }] };
    const ahk = ahkPath();
    // 🪤 AutoHotkey сами не ставим — требование владельца: сказать команду и выйти.
    if (!ahk) {
        return {
            ok: false,
            steps: [{ what: 'AutoHotkey v2', ok: false, note: 'нет — поставь: winget install AutoHotkey.AutoHotkey' }],
        };
    }
    add('AutoHotkey v2', true, ahk);

    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.copyFileSync(SRC, AHK);
        add('скрипт скопирован', true, AHK);
    } catch (e) {
        return { ok: false, steps: [...steps, { what: 'скопировать скрипт', ok: false, note: e.message }] };
    }

    try { writeGuards(); add('сторож и его шим сгенерированы', true, 'пути машины подставлены'); }
    catch (e) { add('сгенерировать сторожа', false, e.message); }

    // Ярлык автозагрузки — через WScript.Shell: это единственный способ сделать .lnk
    // без сторонних утилит.
    const lnk = ps(`
$sh = New-Object -ComObject WScript.Shell
$dst = Join-Path ([Environment]::GetFolderPath('Startup')) '${LNK_NAME}'
$s = $sh.CreateShortcut($dst)
$s.TargetPath = '${ahkPath().replace(/'/g, "''")}'
$s.Arguments = '"${AHK}"'
$s.WorkingDirectory = '${HOME_DIR}'
$s.Description = 'clip-as-typing: dictation paste fix for Orca terminals'
$s.Save()
Test-Path -LiteralPath $dst`);
    add('ярлык в автозагрузке', /True/i.test(String(lnk.stdout)), LNK_NAME);

    // Задача каждые 10 минут. /F — перезаписать, если уже есть: повторный «Установить»
    // не должен падать на существующей задаче.
    const task = spawnSync('schtasks', ['/Create', '/TN', TASK, '/TR', `wscript.exe //B "${GUARD_VBS}"`,
        '/SC', 'MINUTE', '/MO', '10', '/F'], { windowsHide: true, encoding: 'utf8' });
    add('задача планировщика каждые 10 мин', task.status === 0, TASK);

    // 🪤 Сначала проверяем, запущен ли: у скрипта #SingleInstance Force, и повторный
    // запуск убил бы живой экземпляр и поставил новый.
    const st = state();
    if (st.pid) add('процесс уже запущен', true, `pid ${st.pid}`);
    else {
        spawnSync('powershell', ['-NoProfile', '-Command',
            `Start-Process -FilePath '${ahk.replace(/'/g, "''")}' -ArgumentList '"${AHK}"'`],
            { windowsHide: true, stdio: 'ignore' });
        const after = state();
        add('процесс запущен', after.pid > 0, after.pid ? `pid ${after.pid}` : 'не поднялся — смотри лог');
    }
    return { ok: steps.every(s => s.ok), steps };
}

// Выключить: погасить процесс ПО PID, снять ярлык и задачу. Файлы остаются — их
// удаляет только «Удалить полностью».
function disable() {
    const steps = [];
    const add = (what, ok, note = '') => steps.push({ what, ok, note });
    if (!IS_WIN) return { ok: false, steps: [{ what: 'Windows', ok: false, note: '' }] };

    const st = state();
    if (st.pid) {
        // 🪤 Никогда `taskkill /IM AutoHotkey64.exe` — этим убивается индикатор
        // раскладки в трее, он тоже AutoHotkey. Строго по PID.
        const r = spawnSync('taskkill', ['/F', '/PID', String(st.pid)], { windowsHide: true });
        add('процесс погашен', r.status === 0, `pid ${st.pid}`);
    } else add('процесс', true, 'и не был запущен');

    const lnk = ps(`
$dst = Join-Path ([Environment]::GetFolderPath('Startup')) '${LNK_NAME}'
if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
-not (Test-Path -LiteralPath $dst)`);
    add('ярлык автозагрузки убран', /True/i.test(String(lnk.stdout)));

    if (st.task) {
        const r = spawnSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { windowsHide: true });
        add('задача планировщика удалена', r.status === 0);
    } else add('задача планировщика', true, 'и не была создана');

    return { ok: steps.every(s => s.ok), steps };
}

// Удалить полностью: всё из «Выключить» + файлы рабочей папки.
function remove() {
    const r = disable();
    const steps = [...r.steps];
    try {
        fs.rmSync(HOME_DIR, { recursive: true, force: true });
        steps.push({ what: 'файлы удалены', ok: !fs.existsSync(HOME_DIR), note: HOME_DIR });
    } catch (e) {
        steps.push({ what: 'удалить файлы', ok: false, note: e.message });
    }
    return { ok: steps.every(s => s.ok), steps };
}

module.exports = { state, install, disable, remove, HOME_DIR, LOG, TASK, ahkPath, IS_WIN };
