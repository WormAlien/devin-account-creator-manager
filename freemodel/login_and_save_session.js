// freemodel/login_and_save_session.js
//
// Открывает freemodel.dev в видимом браузере, ждёт пока ты залогинишься
// (через Telegram, SMS, или как угодно), и по нажатию Enter в терминале
// сохраняет сессию (cookies + localStorage) в freemodel/sessions/<label>.json
//
// Использование:
//   node freemodel/login_and_save_session.js
//   node freemodel/login_and_save_session.js my_label
//
// Восстановление:
//   node freemodel/restore_session.js my_label

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FREEMODEL_URL = 'https://freemodel.dev/invite/FRE-db15a867';
const DASHBOARD_URL = 'https://freemodel.dev/dashboard';
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const labelArg = process.argv[2];
const label = (labelArg || `session_${Date.now()}`).replace(/[^\w-]/g, '_');

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main() {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    console.log('🚀 Запускаю Chromium (видимый режим)...');
    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'ru-RU',
    });
    const page = await context.newPage();

    console.log(`📂 Открываю ${FREEMODEL_URL}`);
    await page.goto(FREEMODEL_URL, { waitUntil: 'domcontentloaded' });

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  👉 Войди в браузере как тебе удобно (Telegram / SMS / etc.)');
    console.log('  👉 Дойди до Dashboard / API Keys чтобы убедиться что залогинен');
    console.log('  👉 Когда готов — вернись СЮДА и нажми Enter');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');

    await prompt('Жми Enter после успешного логина: ');

    // Проверим что мы реально залогинены — текущий URL не должен быть на /login или /invite
    const currentUrl = page.url();
    console.log(`📍 Текущий URL: ${currentUrl}`);

    const sessionPath = path.join(SESSIONS_DIR, `${label}.json`);
    await context.storageState({ path: sessionPath });

    console.log('');
    console.log(`✅ Сессия сохранена: ${sessionPath}`);
    console.log(`💡 Восстановить: node freemodel/restore_session.js ${label}`);

    const stat = fs.statSync(sessionPath);
    console.log(`📊 Размер: ${stat.size} байт`);

    const goDashboard = await prompt('Открыть Dashboard для проверки? (y/N): ');
    if (goDashboard.trim().toLowerCase() === 'y') {
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
        console.log('✅ Dashboard открыт. Нажми Enter чтобы закрыть браузер.');
        await prompt('');
    }

    await browser.close();
    console.log('🏁 Готово.');
}

main().catch(err => {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
});
