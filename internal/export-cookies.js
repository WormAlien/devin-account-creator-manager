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
    const outputPath = path.join(dir, 'cookies_for_import.json');
    
    fs.writeFileSync(outputPath, JSON.stringify(cookieEditorFormat, null, 2));
    
    console.log(`✅ Экспортировано ${cookieEditorFormat.length} cookies`);
    console.log(`📁 Файл: ${outputPath}`);
    console.log('');
    console.log('Инструкция:');
    console.log('1. Установи расширение "Cookie Editor" в Chrome');
    console.log('2. Зайди на https://app.devin.ai');
    console.log('3. Открой Cookie Editor → Import → выбери cookies_for_import.json');
    console.log('4. Обнови страницу (F5)');
    
    return outputPath;
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
