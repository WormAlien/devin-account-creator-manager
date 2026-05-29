// freemodel/import_cookies.js
//
// Импортировать сессию freemodel из cookies-JSON (формат Cookie-Editor)
// + опционально localStorage JSON (из copy(JSON.stringify(...localStorage...))).
//
// Запуск:
//   node freemodel/import_cookies.js <cookies.json> <email> [InviteUsed] [localStorage.json]
//
// Примеры:
//   node freemodel/import_cookies.js c1.json foo@guerrillamail.com
//   node freemodel/import_cookies.js c1.json foo@guerrillamail.com FRE-96db9162 ls1.json

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

const SESSIONS_DIR = path.resolve(__dirname, '..', 'manual_sessions');
const REF_CODE_RE = /FRE-[a-f0-9]{8}\b/i;

function mskTimestamp() {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return msk.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Cookie-Editor → Playwright формат
function convertCookies(raw) {
    return raw.map(c => {
        const out = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
        };
        // sameSite: 'strict' / 'lax' / 'no_restriction' / 'unspecified' → 'Strict' / 'Lax' / 'None'
        const ss = (c.sameSite || 'lax').toLowerCase();
        if (ss === 'no_restriction' || ss === 'none') out.sameSite = 'None';
        else if (ss === 'strict') out.sameSite = 'Strict';
        else out.sameSite = 'Lax';

        if (c.session || !c.expirationDate) out.expires = -1;
        else out.expires = Math.floor(c.expirationDate);
        return out;
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

async function isLoggedIn(page) {
    await page.goto(config.DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    const u = page.url();
    return /freemodel\.dev\/dashboard/.test(u) && !/\/(login|signin|invite)/i.test(u);
}

async function main() {
    const cookiesPath = process.argv[2];
    const email = process.argv[3];
    const inviteUsed = process.argv[4] || '';
    const localStoragePath = process.argv[5] || '';

    if (!cookiesPath || !email) {
        console.log('Использование: node freemodel/import_cookies.js <cookies.json> <email> [InviteUsed] [localStorage.json]');
        process.exit(1);
    }
    if (!fs.existsSync(cookiesPath)) {
        console.log(`❌ Файл не найден: ${cookiesPath}`);
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
    if (!Array.isArray(raw)) {
        console.log('❌ JSON с cookies должен быть массивом');
        process.exit(1);
    }

    const cookies = convertCookies(raw);
    console.log(`📦 Импортирую ${cookies.length} cookies для ${email}`);

    // localStorage
    let lsEntries = null;
    if (localStoragePath) {
        if (!fs.existsSync(localStoragePath)) {
            console.log(`⚠️ localStorage файл не найден: ${localStoragePath}, продолжаю без него`);
        } else {
            try {
                const lsObj = JSON.parse(fs.readFileSync(localStoragePath, 'utf-8'));
                lsEntries = Object.entries(lsObj).map(([name, value]) => ({ name, value: String(value) }));
                console.log(`📦 + ${lsEntries.length} ключей localStorage`);
            } catch (e) {
                console.log(`⚠️ localStorage JSON невалидный: ${e.message}`);
            }
        }
    }

    const storageState = {
        cookies,
        origins: lsEntries ? [{ origin: 'https://freemodel.dev', localStorage: lsEntries }] : [],
    };

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
        storageState,
        viewport: config.VIEWPORT,
        userAgent: config.USER_AGENT,
        locale: config.LOCALE,
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    console.log('🔎 Проверяю что cookies валидны (открываю dashboard)...');
    const ok = await isLoggedIn(page);
    if (!ok) {
        console.log(`❌ Cookies невалидны — редирект на login (${page.url()})`);
        console.log('   Возможно сессия истекла или забыли скопировать главную куку из freemodel.dev.');
        await browser.close().catch(() => {});
        process.exit(1);
    }
    console.log('✅ Залогинен');

    console.log('🔍 Извлекаю RefCode...');
    const refCode = await grabRefCode(context);
    if (refCode) console.log(`🔗 RefCode: ${refCode}`);
    else console.log('⚠️ RefCode не найден');

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
InviteUsed: ${inviteUsed}
RefCode: ${refCode || ''}
Imported: yes (from cookies.json)
`);

    console.log('');
    console.log(`✅ Сохранено: ${sessionDir}`);
    console.log('Браузер оставляю открытым.');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
