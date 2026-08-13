// agentrouter/login_and_save_session.js
//
// Открывает консоль agentrouter.org в видимом браузере, ждёт пока ты залогинишься
// через GitHub (OAuth), и по нажатию Enter сохраняет сессию (cookies + localStorage)
// в agentrouter/sessions/<label>.json
//
// Зачем: вход в консоль = чек-ин (+$25) и доступ к ЛК. Сессию можно восстановить
// потом, чтобы заходить и получать +25 заново, не вводя GitHub-креды каждый раз.
//
// Использование:
//   node agentrouter/login_and_save_session.js
//   node agentrouter/login_and_save_session.js my_label
//
// Восстановление:
//   node agentrouter/restore_session.js my_label

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONSOLE_URL = 'https://agentrouter.org/';
const TOKEN_URL = 'https://agentrouter.org/console/token';
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

    console.log(`📂 Открываю ${CONSOLE_URL}`);
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  👉 Залогинься через GitHub (кнопка GitHub OAuth)');
    console.log('  👉 Дойди до консоли / токенов (URL не /login)');
    console.log('  👉 Когда готов — вернись СЮДА и нажми Enter');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');

    await prompt('Жми Enter после успешного логина: ');

    const currentUrl = page.url();
    console.log(`📍 Текущий URL: ${currentUrl}`);

    const sessionPath = path.join(SESSIONS_DIR, `${label}.json`);
    await context.storageState({ path: sessionPath });

    console.log('');
    console.log(`✅ Сессия сохранена: ${sessionPath}`);
    console.log(`💡 Восстановить: node agentrouter/restore_session.js ${label}`);
    console.log(`   (вход = чек-ин +$25)`);

    const stat = fs.statSync(sessionPath);
    console.log(`📊 Размер: ${stat.size} байт`);

    const goToken = await prompt('Открыть console/token для проверки? (y/N): ');
    if (goToken.trim().toLowerCase() === 'y') {
        await page.goto(TOKEN_URL, { waitUntil: 'domcontentloaded' });
        console.log('✅ Token page открыт. Нажми Enter чтобы закрыть браузер.');
        await prompt('');
    }

    await browser.close();
    console.log('🏁 Готово.');
}

main().catch(err => {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
});