#!/usr/bin/env node
/**
 * Экспорт сессии для Mac (через Python + Playwright)
 * 
 * Создаёт папку с файлами для запуска на Mac:
 * - session.json (Playwright storageState)
 * - restore_session.py (Python скрипт)
 * - RUN_ME.command (двойной клик на Mac для запуска)
 * 
 * Использование:
 *   node internal/export-for-mac.js <путь к папке сессии>
 *   node internal/export-for-mac.js manual_sessions/2026-05-17T19-35-58-success_user-xxx
 */

const fs = require('fs');
const path = require('path');

async function exportForMac(sessionDir) {
    const sessionFile = path.join(sessionDir, 'session.json');
    
    if (!fs.existsSync(sessionFile)) {
        console.error(`❌ Файл не найден: ${sessionFile}`);
        process.exit(1);
    }

    const sessionName = path.basename(sessionDir);
    
    // Создаём папку для экспорта
    const exportDir = path.join(sessionDir, 'mac_import');
    if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
    }

    // 1. Копируем session.json
    fs.copyFileSync(sessionFile, path.join(exportDir, 'session.json'));
    console.log(`✅ Session: ${path.join(exportDir, 'session.json')}`);

    // 2. Python скрипт для восстановления сессии
    const pythonScript = `#!/usr/bin/env python3
"""
Восстановление сессии Devin.ai через Playwright
Сессия: ${sessionName}

Запуск:
  python3 restore_session.py

Или двойной клик на RUN_ME.command
"""

import os
import sys

def main():
    print("🚀 Восстанавливаем сессию: ${sessionName}")
    print()
    
    # Проверяем/устанавливаем playwright
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("📦 Устанавливаем playwright...")
        os.system(f"{sys.executable} -m pip install playwright")
        print("📦 Устанавливаем браузеры...")
        os.system(f"{sys.executable} -m playwright install chromium")
        print()
        from playwright.sync_api import sync_playwright
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    session_path = os.path.join(script_dir, "session.json")
    
    if not os.path.exists(session_path):
        print(f"❌ Файл не найден: {session_path}")
        sys.exit(1)
    
    print(f"📂 Загружаем сессию из: {session_path}")
    print()
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(storage_state=session_path)
        page = context.new_page()
        
        print("🌐 Открываем https://app.devin.ai/settings/preferences...")
        page.goto("https://app.devin.ai/settings/preferences", wait_until="domcontentloaded")
        
        print()
        print("✅ Браузер открыт с сессией!")
        print("💡 Закрой браузер вручную когда закончишь")
        print()
        
        # Ждём пока пользователь закроет браузер
        try:
            page.wait_for_event("close", timeout=0)
        except:
            pass
        
        try:
            context.close()
            browser.close()
        except:
            pass

if __name__ == "__main__":
    main()
`;

    const pythonPath = path.join(exportDir, 'restore_session.py');
    fs.writeFileSync(pythonPath, pythonScript);
    console.log(`✅ Python: ${pythonPath}`);

    // 3. Создаём SETUP_CLICK.command - один раз запустить чтобы снять блокировку
    // и создать рабочий RUN.command
    const setupScript = `#!/bin/bash
# Первый запуск - снимает блокировку и создаёт ярлык
cd "$(dirname "$0")"

echo "🔧 Настройка запуска сессии..."
echo ""

# Снимаем карантин со всех файлов
xattr -cr .

# Делаем скрипты исполняемыми  
chmod +x restore_session.py 2>/dev/null
chmod +x RUN.command 2>/dev/null

# Создаём рабочий RUN.command
cat > RUN.command << 'SCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
python3 restore_session.py
SCRIPT

chmod +x RUN.command

echo "✅ Готово!"
echo ""
echo "Теперь можешь запускать двойным кликом на RUN.command"
echo ""
read -p "Нажми Enter чтобы запустить сессию сейчас..."

python3 restore_session.py
`;
    const setupPath = path.join(exportDir, 'SETUP_CLICK.command');
    fs.writeFileSync(setupPath, setupScript);
    try { fs.chmodSync(setupPath, '755'); } catch (e) {}
    console.log(`✅ Setup: ${setupPath}`);
    
    // 4. Создаём HTML с инструкцией для первого запуска
    const htmlLauncher = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Запуск сессии Devin.ai</title>
    <style>
        body { 
            font-family: -apple-system, sans-serif; 
            max-width: 700px;
            margin: 0 auto;
            padding: 40px 20px;
            background: #1a1a2e;
            color: #fff;
            line-height: 1.6;
        }
        h1 { color: #00d9ff; text-align: center; }
        h2 { color: #ff6b6b; margin-top: 30px; }
        .step {
            background: #16213e;
            padding: 20px;
            border-radius: 10px;
            margin: 15px 0;
            border-left: 4px solid #00d9ff;
        }
        .cmd { 
            background: #0d1117; 
            padding: 15px; 
            border-radius: 8px; 
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 13px;
            margin: 10px 0;
            cursor: pointer;
            border: 1px solid #30363d;
            word-break: break-all;
        }
        .cmd:hover { border-color: #00d9ff; }
        .btn {
            background: #00d9ff;
            color: #1a1a2e;
            border: none;
            padding: 12px 24px;
            font-size: 15px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            margin: 5px;
        }
        .btn:hover { background: #00b8d4; }
        .copied { 
            color: #4ade80; 
            margin-left: 10px;
            opacity: 0; 
            transition: opacity 0.3s;
            display: inline-block;
        }
        .copied.show { opacity: 1; }
        .note { color: #888; font-size: 14px; }
        kbd {
            background: #333;
            padding: 3px 8px;
            border-radius: 4px;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <h1>🚀 Запуск сессии Devin.ai</h1>
    <p class="note" style="text-align: center;">Сессия: ${sessionName}</p>

    <h2>Первый раз (один раз)</h2>
    <div class="step">
        <p>1. Открой <strong>Terminal</strong> (<kbd>Cmd</kbd>+<kbd>Space</kbd> → "Terminal")</p>
        <p>2. Скопируй и вставь эту команду:</p>
        <div class="cmd" id="cmd1" onclick="copy('cmd1')">xattr -cr ~/Downloads/mac_import && chmod +x ~/Downloads/mac_import/*.py</div>
        <button class="btn" onclick="copy('cmd1')">📋 Скопировать</button>
        <span class="copied" id="copied1">✓ Скопировано!</span>
        <p class="note">Это снимет блокировку macOS с файлов (нужно один раз)</p>
    </div>

    <h2>Запуск сессии</h2>
    <div class="step">
        <p>Вставь в Terminal:</p>
        <div class="cmd" id="cmd2" onclick="copy('cmd2')">cd ~/Downloads/mac_import && python3 restore_session.py</div>
        <button class="btn" onclick="copy('cmd2')">📋 Скопировать</button>
        <span class="copied" id="copied2">✓ Скопировано!</span>
    </div>

    <h2>Или одной командой</h2>
    <div class="step">
        <div class="cmd" id="cmd3" onclick="copy('cmd3')">cd ~/Downloads/mac_import && xattr -cr . && python3 restore_session.py</div>
        <button class="btn" onclick="copy('cmd3')">📋 Скопировать</button>
        <span class="copied" id="copied3">✓ Скопировано!</span>
    </div>

    <p class="note" style="margin-top: 30px;">
        <strong>Папка не в Downloads?</strong> Замени <code>~/Downloads/mac_import</code> на путь к папке.<br>
        Можно перетащить папку в Terminal чтобы вставить путь.
    </p>

    <script>
        function copy(id) {
            const text = document.getElementById(id).textContent;
            navigator.clipboard.writeText(text);
            const copied = document.getElementById('copied' + id.slice(-1));
            copied.classList.add('show');
            setTimeout(() => copied.classList.remove('show'), 2000);
        }
    </script>
</body>
</html>`;
    const htmlPath = path.join(exportDir, 'OPEN_ME.html');
    fs.writeFileSync(htmlPath, htmlLauncher);
    console.log(`✅ HTML Launcher: ${htmlPath}`);

    // 6. README
    const readme = `# Импорт сессии Devin.ai на Mac

Сессия: ${sessionName}

## Быстрый старт

### Способ 1: Через HTML (самый простой)
1. Двойной клик на \`OPEN_ME.html\`
2. Нажми "Скопировать команду"
3. Открой Terminal (Cmd+Space → "Terminal")
4. Вставь команду (Cmd+V) и нажми Enter

### Способ 2: Через Terminal напрямую
\`\`\`bash
cd путь/к/этой/папке
python3 restore_session.py
\`\`\`

### Способ 3: AppleScript
1. Двойной клик на \`RUN_ME.applescript\`
2. В Script Editor нажми кнопку ▶️ (Run)

## Файлы

- \`session.json\` — данные сессии (cookies + localStorage)
- \`restore_session.py\` — Python скрипт
- \`OPEN_ME.html\` — открой и скопируй команду
- \`RUN_ME.applescript\` — запуск через Script Editor
`;

    const readmePath = path.join(exportDir, 'README.md');
    fs.writeFileSync(readmePath, readme);
    console.log(`✅ README: ${readmePath}`);

    // 7. Копируем session_info.txt если есть
    const infoFile = path.join(sessionDir, 'session_info.txt');
    if (fs.existsSync(infoFile)) {
        fs.copyFileSync(infoFile, path.join(exportDir, 'session_info.txt'));
        console.log(`✅ Info: ${path.join(exportDir, 'session_info.txt')}`);
    }

    // 8. Создаём ZIP архив через PowerShell (Windows) или zip (Unix)
    const zipName = `${sessionName}_mac.zip`;
    const zipPath = path.join(sessionDir, zipName);
    
    // Удаляем старый архив если есть
    if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
    }
    
    const { execSync } = require('child_process');
    const isWindows = process.platform === 'win32';
    
    try {
        if (isWindows) {
            // PowerShell Compress-Archive
            const cmd = `powershell -Command "Compress-Archive -Path '${exportDir}\\*' -DestinationPath '${zipPath}' -Force"`;
            execSync(cmd, { stdio: 'pipe' });
        } else {
            // Unix zip
            execSync(`cd "${sessionDir}" && zip -r "${zipName}" mac_import`, { stdio: 'pipe' });
        }
        
        const zipSize = (fs.statSync(zipPath).size / 1024).toFixed(1);
        console.log(`✅ ZIP: ${zipPath} (${zipSize} KB)`);
    } catch (e) {
        console.log(`⚠️  Не удалось создать ZIP: ${e.message}`);
        console.log(`   Папка: ${exportDir}`);
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  ГОТОВО! Архив для отправки на Mac:');
    console.log(`  ${zipPath}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('  На Mac:');
    console.log('  1. Распакуй архив');
    console.log('  2. Двойной клик на OPEN_ME.html');
    console.log('  3. Скопируй команду и вставь в Terminal');
    console.log('');
    console.log('  Или напрямую в Terminal:');
    console.log('  cd путь/к/mac_import && python3 restore_session.py');
    console.log('');

    return { exportDir, zipPath };
}

// Интерактивный режим
async function interactiveMode() {
    const readline = require('readline');
    const sessionsDir = 'manual_sessions';
    
    if (!fs.existsSync(sessionsDir)) {
        console.error('❌ Папка manual_sessions не найдена');
        process.exit(1);
    }

    const sessions = fs.readdirSync(sessionsDir)
        .filter(dir => fs.existsSync(path.join(sessionsDir, dir, 'session.json')))
        .sort()
        .reverse();

    if (sessions.length === 0) {
        console.error('❌ Нет сохранённых сессий');
        process.exit(1);
    }

    console.log('🗂️  Доступные сессии:\n');
    sessions.forEach((s, i) => {
        const isSuccess = s.includes('success');
        const icon = isSuccess ? '✅' : '❌';
        console.log(`  ${i + 1}. ${icon} ${s}`);
    });

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('\nВведи номер сессии для экспорта на Mac: ', async (answer) => {
        rl.close();
        const idx = parseInt(answer) - 1;
        
        if (idx < 0 || idx >= sessions.length) {
            console.error('❌ Неверный номер');
            process.exit(1);
        }

        const sessionDir = path.join(sessionsDir, sessions[idx]);
        await exportForMac(sessionDir);
    });
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
    interactiveMode();
} else {
    exportForMac(args[0]).catch(console.error);
}

module.exports = { exportForMac };
