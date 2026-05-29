// freemodel/restore_existing.js
//
// Восстановить существующий FreeModel-аккаунт в менеджер.
// Используется когда аккаунт уже создан, но папки в manual_sessions/ нет.
//
// Что делает:
//   1. Спрашивает email и (опц.) InviteUsed
//   2. Открывает чистый Playwright-браузер на freemodel.dev/login
//   3. Ты сам логинишься (вводишь email → получаешь код → вводишь код)
//   4. Жмёшь Enter в терминале
//   5. Скрипт проверяет dashboard → грабит RefCode → сохраняет в manual_sessions/
//
// Запуск:
//   node freemodel/restore_existing.js asdasdsa@guerrillamail.com
//   node freemodel/restore_existing.js asdasdsa@guerrillamail.com FRE-96db9162

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const config = require('./config');

const SESSIONS_DIR = path.resolve(__dirname, '..', 'manual_sessions');
const REF_CODE_RE = /FRE-[a-f0-9]{8}\b/i;

function mskTimestamp() {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return msk.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function prompt(q) {
    return new Promise(res => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, a => { rl.close(); res(a); });
    });
}

async function grabRefCode(context) {
    const urls = [
        `${config.DASHBOARD_URL}/refer`,
        `${config.DASHBOARD_URL}/invite`,
        `${config.DASHBOARD_URL}/referrals`,
    ];
    const page = await context.newPage();
    try {
        for (const u of urls) {
            try {
                await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await page.waitForTimeout(1500);
                if (/\/(login|signin)/i.test(page.url())) return null;
                const text = await page.locator('body').innerText().catch(() => '');
                const m = text.match(REF_CODE_RE);
                if (m) return m[0];
                const hrefs = await page.locator('a[href*="/invite/"]').all();
                for (const a of hrefs) {
                    const href = await a.getAttribute('href').catch(() => '');
                    const hm = (href || '').match(REF_CODE_RE);
                    if (hm) return hm[0];
                }
            } catch {}
        }
    } finally {
        try { await page.close(); } catch {}
    }
    return null;
}

async function isLoggedIn(context) {
    for (const p of context.pages()) {
        const u = p.url();
        if (/freemodel\.dev\/dashboard/.test(u) && !/\/(login|signin)/.test(u)) return true;
    }
    const page = await context.newPage();
    try {
        await page.goto(config.DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        const u = page.url();
        return /freemodel\.dev\/dashboard/.test(u) && !/\/(login|signin|invite)/i.test(u);
    } catch { return false; }
    finally { try { await page.close(); } catch {} }
}

async function main() {
    const email = (process.argv[2] || '').trim() || await prompt('Email аккаунта: ');
    const inviteUsed = (process.argv[3] || '').trim() || await prompt('Какой InviteUsed (Enter = пропустить): ');

    if (!email.includes('@')) {
        console.log('❌ Email невалидный');
        process.exit(1);
    }

    console.log('');
    console.log(`📧 Email:        ${email}`);
    console.log(`🔗 InviteUsed:   ${inviteUsed || '(не указан)'}`);
    console.log('');
    console.log('Открываю браузер на freemodel.dev/login ...');

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
        viewport: config.VIEWPORT,
        userAgent: config.USER_AGENT,
        locale: config.LOCALE,
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    const page = await context.newPage();
    await page.goto('https://freemodel.dev/login', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

    console.log('');
    console.log('👉 Залогинься в браузере (email → код из почты).');
    console.log('   Почта guerrillamail: https://www.guerrillamail.com (логин = ' + email.split('@')[0] + ')');
    console.log('');
    await prompt('   Нажми Enter КОГДА увидишь Dashboard: ');

    console.log('Проверяю что ты залогинен...');
    const ok = await isLoggedIn(context);
    if (!ok) {
        console.log('❌ Dashboard не виден. Сессия НЕ сохранена.');
        await browser.close().catch(() => {});
        process.exit(1);
    }
    console.log('✅ Залогинен');

    console.log('Извлекаю RefCode...');
    const refCode = await grabRefCode(context);
    if (refCode) console.log(`🔗 RefCode: ${refCode}`);
    else console.log('⚠️ RefCode не найден');

    // Сохраняем
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const localPart = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const orgName = `user-${localPart}`;
    const sessionName = `${mskTimestamp()}-success_${orgName}`;
    const sessionDir = path.join(SESSIONS_DIR, sessionName);
    fs.mkdirSync(sessionDir, { recursive: true });

    await context.storageState({ path: path.join(sessionDir, 'session.json') });

    fs.writeFileSync(path.join(sessionDir, 'restore_session.js'), `const { chromium } = require('playwright');
const path = require('path');
(async () => {
    console.log('🚀 Восстанавливаю сессию: ${sessionName}');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: path.join(__dirname, 'session.json') });
    const page = await context.newPage();
    await page.goto('${config.DASHBOARD_URL}', { waitUntil: 'domcontentloaded' });
    console.log('✅ Браузер открыт с сессией! Закрой вручную.');
})();
`);

    fs.writeFileSync(path.join(sessionDir, 'session_info.txt'), `URL: ${config.DASHBOARD_URL}
Время сохранения: ${new Date(Date.now() + 3 * 60 * 60 * 1000).toLocaleString('ru-RU')}
Email: ${email}
Org: ${orgName}
Статус: ✅ FreeModel сессия
InviteUsed: ${inviteUsed || ''}
RefCode: ${refCode || ''}
Restored: yes
`);

    console.log('');
    console.log(`✅ Сохранено: ${sessionDir}`);
    console.log('Браузер оставляю открытым — закрой сам.');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
