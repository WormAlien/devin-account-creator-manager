// freemodel/import_paste.js
//
// Интерактивный импорт сессии freemodel — пастишь данные прямо в терминал.
//
// Запуск:
//   node freemodel/import_paste.js
//
// Что делает:
//   1. Спрашивает email
//   2. Спрашивает InviteUsed (можно пустым)
//   3. Просит вставить JSON localStorage (одной строкой), Enter
//   4. Просит вставить JSON cookies (многострочный), Enter на пустой строке = конец
//   5. Грузит браузер, проверяет dashboard, грабит RefCode, сохраняет

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

// Читать строку
function readLine(rl, prompt) {
    return new Promise(res => rl.question(prompt, ans => res(ans)));
}

// Читать многострочный ввод до пустой строки (или ;; на отдельной строке)
function readMultiline(prompt) {
    return new Promise(resolve => {
        process.stdout.write(prompt);
        const lines = [];
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        rl.on('line', l => {
            if (l.trim() === '' || l.trim() === ';;') {
                rl.close();
                return;
            }
            lines.push(l);
        });
        rl.on('close', () => resolve(lines.join('\n')));
    });
}

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
        const ss = (c.sameSite || 'lax').toString().toLowerCase();
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
    } finally { try { await page.close(); } catch {} }
    return null;
}

async function isLoggedIn(page) {
    await page.goto(config.DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    const u = page.url();
    return /freemodel\.dev\/dashboard/.test(u) && !/\/(login|signin|invite)/i.test(u);
}

async function main() {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Импорт FreeModel сессии (paste-режим)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Шаг 0: email
    const email = ((await readLine(rl, '  Email аккаунта: ')) || '').trim();
    if (!email || !email.includes('@')) {
        console.log('  ❌ Email невалидный');
        rl.close();
        process.exit(1);
    }

    // Шаг 0.5: invite (опционально)
    const inviteUsed = ((await readLine(rl, '  InviteUsed (Enter = пропустить): ')) || '').trim();

    console.log('');
    console.log('  ШАГ 1.  localStorage — одной строкой (из copy(JSON.stringify(...))).');
    console.log('          Вставь, нажми Enter. Пусто = пропустить.');
    console.log('');

    // Шаг 1: localStorage (одна строка)
    const lsRaw = (await readLine(rl, '  localStorage> ')).trim();
    rl.close();

    let lsEntries = null;
    if (lsRaw) {
        try {
            const lsObj = JSON.parse(lsRaw);
            lsEntries = Object.entries(lsObj).map(([name, value]) => ({ name, value: String(value) }));
            console.log(`  ✅ localStorage: ${lsEntries.length} ключей`);
        } catch (e) {
            console.log(`  ⚠️ localStorage невалидный JSON (${e.message}) — продолжаю без него`);
        }
    } else {
        console.log('  ⏭  localStorage пуст — продолжаю без него');
    }

    console.log('');
    console.log('  ШАГ 2.  cookies — JSON-массив из Cookie-Editor (многострочный).');
    console.log('          После последней строки нажми Enter на ПУСТОЙ строке.');
    console.log('');

    // Шаг 2: cookies (многострочный)
    const cookiesRaw = (await readMultiline('  cookies>\n')).trim();
    let cookiesArr;
    try {
        cookiesArr = JSON.parse(cookiesRaw);
        if (!Array.isArray(cookiesArr)) throw new Error('не массив');
    } catch (e) {
        console.log(`  ❌ cookies невалидный JSON: ${e.message}`);
        process.exit(1);
    }
    const cookies = convertCookies(cookiesArr);
    console.log(`  ✅ cookies: ${cookies.length}`);

    // Грузим в браузер
    console.log('');
    console.log('  🌐 Открываю браузер с сессией...');
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
    console.log('  🔎 Проверяю dashboard...');
    const ok = await isLoggedIn(page);
    if (!ok) {
        console.log(`  ❌ Не залогинен — редирект на ${page.url()}`);
        console.log('     Cookies истекли или не полные. Браузер оставляю — можешь посмотреть.');
        return;
    }
    console.log('  ✅ Залогинен');

    console.log('  🔍 Извлекаю RefCode...');
    const refCode = await grabRefCode(context);
    if (refCode) console.log(`  🔗 RefCode: ${refCode}`);
    else console.log('  ⚠️ RefCode не найден');

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
Imported: paste
`);

    console.log('');
    console.log(`  ✅ Сохранено: ${sessionDir}`);
    console.log('  Браузер оставляю открытым.');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
