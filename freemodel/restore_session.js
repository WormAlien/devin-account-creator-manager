// freemodel/restore_session.js
//
// Открывает freemodel.dev/dashboard с сохранённой сессией.
// Использование:
//   node freemodel/restore_session.js <label>
//   node freemodel/restore_session.js                  # покажет список доступных сессий

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DASHBOARD_URL = 'https://freemodel.dev/dashboard';

async function main() {
    const label = process.argv[2];

    if (!fs.existsSync(SESSIONS_DIR)) {
        console.error(`❌ Папка сессий не найдена: ${SESSIONS_DIR}`);
        process.exit(1);
    }

    const available = fs.readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));

    if (!label) {
        console.log('📂 Доступные сессии:');
        if (available.length === 0) {
            console.log('   (нет сохранённых сессий — запусти login_and_save_session.js)');
        } else {
            available.forEach(s => console.log(`   - ${s}`));
        }
        console.log('\nИспользование: node freemodel/restore_session.js <label>');
        process.exit(0);
    }

    const sessionPath = path.join(SESSIONS_DIR, `${label}.json`);
    if (!fs.existsSync(sessionPath)) {
        console.error(`❌ Сессия не найдена: ${sessionPath}`);
        console.error(`   Доступные: ${available.join(', ') || '(пусто)'}`);
        process.exit(1);
    }

    console.log(`🚀 Восстанавливаю сессию: ${label}`);
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        storageState: sessionPath,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'ru-RU',
    });
    const page = await context.newPage();

    console.log(`📂 Открываю ${DASHBOARD_URL}`);
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });

    console.log('✅ Браузер открыт с сессией. Закрой вручную когда закончишь.');
}

main().catch(err => {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
});
