#!/usr/bin/env node
/**
 * Экспорт сессии в формат Cookie Editor (Chrome расширение)
 * 
 * Использование:
 *   node internal/export-cookies.js <путь к session.json>
 *   node internal/export-cookies.js manual_sessions/2026-05-16T12-02-00-success_user-xxx/session.json
 * 
 * Результат: создаст файл cookies_for_import.json рядом с session.json
 */

const fs = require('fs');
const path = require('path');

function convertToCookieEditor(sessionPath) {
    if (!fs.existsSync(sessionPath)) {
        console.error(`❌ Файл не найден: ${sessionPath}`);
        process.exit(1);
    }

    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    
    if (!session.cookies || !Array.isArray(session.cookies)) {
        console.error('❌ Файл не содержит cookies');
        process.exit(1);
    }

    // Cookie Editor формат - просто массив cookies
    // sameSite должен быть: lax, strict, no_restriction, unspecified (lowercase!)
    const sameSiteMap = {
        'Lax': 'lax',
        'Strict': 'strict',
        'None': 'no_restriction',
        'lax': 'lax',
        'strict': 'strict',
        'none': 'no_restriction'
    };

    const cookieEditorFormat = session.cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        expirationDate: cookie.expires > 0 ? cookie.expires : undefined,
        httpOnly: cookie.httpOnly || false,
        secure: cookie.secure || false,
        sameSite: sameSiteMap[cookie.sameSite] || 'lax'
    }));

    // Сохраняем рядом с оригиналом
    const dir = path.dirname(sessionPath);
    const cookiesPath = path.join(dir, 'cookies_for_import.json');
    
    fs.writeFileSync(cookiesPath, JSON.stringify(cookieEditorFormat, null, 2));
    
    console.log(`✅ Экспортировано ${cookieEditorFormat.length} cookies`);
    console.log(`📁 Cookies: ${cookiesPath}`);

    // Экспортируем localStorage (критично для авторизации!)
    if (session.origins && session.origins.length > 0) {
        const devinOrigin = session.origins.find(o => o.origin.includes('devin.ai'));
        if (devinOrigin && devinOrigin.localStorage && devinOrigin.localStorage.length > 0) {
            // Генерируем JS-код для вставки в консоль
            const localStorageItems = devinOrigin.localStorage;
            
            let jsCode = '// Вставь этот код в консоль браузера (F12 → Console) на сайте app.devin.ai\n';
            jsCode += '// Затем обнови страницу (F5)\n\n';
            
            for (const item of localStorageItems) {
                const escapedValue = item.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                jsCode += `localStorage.setItem('${item.name}', '${escapedValue}');\n`;
            }
            
            jsCode += '\nconsole.log("✅ localStorage установлен! Обнови страницу (F5)");\n';

            const localStoragePath = path.join(dir, 'localStorage_inject.js');
            fs.writeFileSync(localStoragePath, jsCode);
            
            console.log(`✅ Экспортировано ${localStorageItems.length} localStorage items`);
            console.log(`📁 LocalStorage: ${localStoragePath}`);

            // Создаём HTML файл для автоматической установки всего
            const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Импорт сессии Devin.ai</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .btn { background: #4CAF50; color: white; padding: 15px 30px; border: none; cursor: pointer; font-size: 16px; border-radius: 5px; margin: 10px 0; }
        .btn:hover { background: #45a049; }
        .btn:disabled { background: #ccc; cursor: not-allowed; }
        .status { margin: 20px 0; padding: 15px; border-radius: 5px; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        .info { background: #d1ecf1; color: #0c5460; }
        pre { background: #f4f4f4; padding: 10px; overflow-x: auto; font-size: 12px; }
    </style>
</head>
<body>
    <h1>🔐 Импорт сессии Devin.ai</h1>
    
    <div class="info status">
        <strong>Инструкция:</strong><br>
        1. Нажми кнопку ниже<br>
        2. Разреши всплывающее окно (если спросит)<br>
        3. Готово — ты залогинен!
    </div>

    <button class="btn" onclick="importSession()">🚀 Импортировать сессию</button>
    
    <div id="status"></div>

    <script>
        const cookies = ${JSON.stringify(cookieEditorFormat)};
        
        const localStorageData = ${JSON.stringify(localStorageItems.reduce((acc, item) => { acc[item.name] = item.value; return acc; }, {}))};

        async function importSession() {
            const statusDiv = document.getElementById('status');
            
            try {
                // Открываем app.devin.ai
                statusDiv.innerHTML = '<div class="status info">Открываем app.devin.ai...</div>';
                
                const win = window.open('https://app.devin.ai', '_blank');
                
                if (!win) {
                    statusDiv.innerHTML = '<div class="status error">❌ Разреши всплывающие окна и попробуй снова!</div>';
                    return;
                }

                // Ждём загрузки
                await new Promise(r => setTimeout(r, 3000));
                
                // Инжектим localStorage
                try {
                    const script = \`
                        ${localStorageItems.map(item => {
                            const escapedValue = item.value.replace(/\\/g, '\\\\\\\\').replace(/'/g, "\\\\'").replace(/`/g, '\\\\`');
                            return `localStorage.setItem('${item.name}', '${escapedValue}');`;
                        }).join('\\n')}
                        console.log('✅ localStorage установлен');
                    \`;
                    win.eval(script);
                } catch(e) {
                    console.log('localStorage inject error (expected due to CORS):', e);
                }

                statusDiv.innerHTML = \`
                    <div class="status success">
                        <strong>✅ Окно открыто!</strong><br><br>
                        Теперь в открывшемся окне:<br>
                        1. Нажми F12 → Console<br>
                        2. Вставь этот код и нажми Enter:<br>
                    </div>
                    <pre>${jsCode.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                    <div class="status info">
                        3. Затем импортируй куки через Cookie Editor<br>
                        4. Обнови страницу (F5)
                    </div>
                \`;

            } catch(e) {
                statusDiv.innerHTML = '<div class="status error">❌ Ошибка: ' + e.message + '</div>';
            }
        }
    </script>
</body>
</html>`;

            const htmlPath = path.join(dir, 'import_session.html');
            fs.writeFileSync(htmlPath, htmlContent);
            console.log(`📁 HTML: ${htmlPath}`);

            // Создаём Tampermonkey userscript
            const userscript = `// ==UserScript==
// @name         Devin.ai Session Import
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Автоматический импорт сессии Devin.ai
// @match        https://app.devin.ai/*
// @match        https://devin.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    
    // Проверяем, не импортирована ли уже сессия
    if (localStorage.getItem('auth1_session')) {
        console.log('✅ Сессия уже установлена');
        return;
    }

    console.log('🔐 Импортируем сессию Devin.ai...');

${localStorageItems.map(item => {
    const escapedValue = item.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `    localStorage.setItem('${item.name}', '${escapedValue}');`;
}).join('\n')}

    console.log('✅ localStorage установлен!');
    
    // Показываем уведомление
    setTimeout(() => {
        alert('✅ Сессия импортирована!\\n\\nТеперь:\\n1. Удали этот скрипт из Tampermonkey\\n2. Импортируй куки через Cookie Editor\\n3. Обнови страницу (F5)');
    }, 1000);
})();
`;

            const userscriptPath = path.join(dir, 'devin_session.user.js');
            fs.writeFileSync(userscriptPath, userscript);
            console.log(`📁 Tampermonkey: ${userscriptPath}`);

            // Создаём скрипт для "Custom JavaScript for Websites 2"
            // Это расширение просто выполняет JS код на сайте - без заголовков
            const customJsCode = `// Скрипт для расширения "Custom JavaScript for Websites 2"
// Сайт: app.devin.ai

${localStorageItems.map(item => {
    const escapedValue = item.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `localStorage.setItem('${item.name}', '${escapedValue}');`;
}).join('\n')}

console.log('✅ Сессия Devin.ai установлена! Обнови страницу (F5)');
`;

            const customJsPath = path.join(dir, 'custom_js_websites.js');
            fs.writeFileSync(customJsPath, customJsCode);
            console.log(`📁 Custom JS for Websites: ${customJsPath}`);
        }
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('  ИНСТРУКЦИЯ ДЛЯ ИМПОРТА СЕССИИ');
    console.log('═══════════════════════════════════════════════');
    console.log('');
    console.log('1. Открой https://app.devin.ai в Chrome');
    console.log('2. Нажми F12 → вкладка Console');
    console.log('3. Скопируй содержимое localStorage_inject.js и вставь в консоль');
    console.log('4. Нажми Enter');
    console.log('5. Установи расширение "Cookie Editor"');
    console.log('6. Cookie Editor → Import → выбери cookies_for_import.json');
    console.log('7. Обнови страницу (F5)');
    console.log('');
    console.log('═══════════════════════════════════════════════');
    
    return cookiesPath;
}

// Интерактивный режим - выбор сессии
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
        .reverse(); // Новые сверху

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

    rl.question('\nВведи номер сессии: ', (answer) => {
        rl.close();
        const idx = parseInt(answer) - 1;
        
        if (idx < 0 || idx >= sessions.length) {
            console.error('❌ Неверный номер');
            process.exit(1);
        }

        const sessionPath = path.join(sessionsDir, sessions[idx], 'session.json');
        convertToCookieEditor(sessionPath);
    });
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
    interactiveMode();
} else {
    convertToCookieEditor(args[0]);
}
