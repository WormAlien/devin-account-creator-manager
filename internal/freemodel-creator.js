// internal/freemodel-creator.js
//
// Создание новой FreeModel-сессии — простой ручной флоу:
//   1. Один rawList — выбор инвайт-кода
//   2. Создаём guerrilla inbox, печатаем email крупно
//   3. Открываем браузер на invite-странице
//   4. Юзер сам всё делает: signup → ждёт письмо → копирует код/линк → логинится
//      (и опционально привязывает Telegram). Скрипт ПОЧТУ не парсит.
//   5. Юзер жмёт клавишу когда залогинен
//   6. Скрипт проверяет что мы реально на dashboard → грабит RefCode → сохраняет
//
// Экспорт: createFreemodelSession({ clearScreen, setKeypressListener, rawList, rawInput })

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const freemodelConfig = require('../freemodel/config');
const { GuerrillaInbox } = require('../freemodel/lib/guerrillamail');

const SESSIONS_DIR = path.resolve(__dirname, '..', 'manual_sessions');
// Реф-код freemodel: FRE- + 8 hex символов
const REF_CODE_RE = /FRE-[a-f0-9]{8}\b/i;
// Цифровой код подтверждения из письма freemodel (обычно 6 цифр)
const VERIFY_CODE_RE = /\b(\d{6})\b/;

function mskTimestamp() {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return msk.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function extractRefCode(text) {
    if (!text) return null;
    const m = text.match(REF_CODE_RE);
    return m ? m[0] : null;
}

function stripHtml(s) {
    return (s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Достаём 6-значный код подтверждения из тела письма
function extractVerifyCode(body) {
    if (!body) return null;
    const m = stripHtml(body).match(VERIFY_CODE_RE);
    return m ? m[1] : null;
}

function readSessionInfo(itemPath) {
    const out = { url: '', email: '', refCode: '', chainExclude: false };
    const f = path.join(itemPath, 'session_info.txt');
    if (!fs.existsSync(f)) return out;
    try {
        for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
            const c = line.indexOf(':');
            if (c < 0) continue;
            const k = line.slice(0, c).trim().toLowerCase();
            const v = line.slice(c + 1).trim();
            if (k === 'url') out.url = v;
            else if (k === 'email') out.email = v;
            else if (k === 'refcode' || k === 'ref code') out.refCode = v;
            else if (k === 'chainexclude' || k === 'chain exclude') out.chainExclude = /^(yes|true|1)$/i.test(v);
        }
    } catch {}
    return out;
}

function findLatestRefCode() {
    if (!fs.existsSync(SESSIONS_DIR)) return null;
    const items = fs.readdirSync(SESSIONS_DIR)
        .map(name => ({ name, p: path.join(SESSIONS_DIR, name) }))
        .filter(x => { try { return fs.statSync(x.p).isDirectory(); } catch { return false; } });

    const fm = items
        .map(x => ({ ...x, info: readSessionInfo(x.p) }))
        .filter(x => x.info.url.includes('freemodel.dev')
                  && REF_CODE_RE.test(x.info.refCode)
                  && !x.info.chainExclude)
        .sort((a, b) => b.name.localeCompare(a.name));

    return fm[0] ? { refCode: fm[0].info.refCode, fromEmail: fm[0].info.email } : null;
}

// Проверка что мы реально залогинены.
// Сначала смотрим на уже открытые вкладки — если хоть одна на /dashboard
// без редиректа на login, считаем что ок. Если нет — пробуем зайти сами.
async function isLoggedIn(context) {
    // 1. Сканим существующие страницы
    for (const p of context.pages()) {
        try {
            const u = p.url();
            if (/freemodel\.dev\/dashboard/.test(u) && !/\/(login|signin)/.test(u)) {
                return true;
            }
        } catch {}
    }

    // 2. Фолбэк — открываем новую вкладку и проверяем dashboard.
    // Делаем 2 попытки с паузой — иногда первая отдаёт login до пропагации куки.
    for (let attempt = 0; attempt < 2; attempt++) {
        const page = await context.newPage();
        try {
            await page.goto(freemodelConfig.DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(2500);
            const u = page.url();
            if (/freemodel\.dev\/dashboard/.test(u) && !/\/(login|signin|invite)/i.test(u)) {
                return true;
            }
        } catch {} finally {
            try { await page.close(); } catch {}
        }
        if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

async function grabMyRefCode(context) {
    const urls = [
        `${freemodelConfig.DASHBOARD_URL}/refer`,
        `${freemodelConfig.DASHBOARD_URL}/invite`,
        `${freemodelConfig.DASHBOARD_URL}/referrals`,
    ];
    const page = await context.newPage();
    try {
        for (const u of urls) {
            try {
                await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await page.waitForTimeout(1500);
                // Если редирект на login — мы не залогинены, дальше нет смысла
                if (/\/(login|signin)/i.test(page.url())) return null;
                const text = await page.locator('body').innerText().catch(() => '');
                const code = extractRefCode(text);
                if (code) return code;
                const hrefs = await page.locator('a[href*="/invite/"]').all();
                for (const a of hrefs) {
                    const href = await a.getAttribute('href').catch(() => '');
                    const c = extractRefCode(href);
                    if (c) return c;
                }
            } catch {}
        }
    } finally {
        try { await page.close(); } catch {}
    }
    return null;
}

function waitAnyKey(setKeypressListener, hint = '\x1b[2m(нажми любую клавишу)\x1b[0m') {
    return new Promise(resolve => {
        process.stdout.write(`\n  ${hint}\n`);
        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(true); } catch {}
        setKeypressListener((_str, key) => {
            setKeypressListener(null);
            if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(false); } catch {}
            try { process.stdin.pause(); } catch {}
            resolve(key);
        });
    });
}

async function createFreemodelSession({ clearScreen, setKeypressListener, rawList, rawInput }) {
    // ШАГ 1: выбор инвайта
    const chain = findLatestRefCode();

    clearScreen();
    const options = [];
    if (chain) {
        options.push({ label: `Реф-цепочка от прошлой сессии:`, value: null, disabled: true });
        options.push({ label: `  🔗 ${chain.refCode}   📧 ${chain.fromEmail || '—'}`, value: null, disabled: true });
        options.push({ label: ` `, value: null, disabled: true });
        options.push({ label: `✅  Регать по цепочке: ${chain.refCode}`, value: 'chain' });
    } else {
        options.push({ label: `Реф-цепочка пуста — нет сессий с RefCode`, value: null, disabled: true });
        options.push({ label: ` `, value: null, disabled: true });
    }
    options.push({ label: `🌱  Стартовый INITIAL_INVITE (${freemodelConfig.INITIAL_INVITE})`, value: 'initial' });
    options.push({ label: `🔢  Ввести свой FRE-код вручную`, value: 'manual' });
    options.push({ label: `←  Отмена`, value: 'cancel' });

    const choice = await rawList('🆓 Создание FreeModel-аккаунта', options);
    if (choice === 'cancel' || choice === null) { clearScreen(); return; }

    let inviteCode;
    if (choice === 'chain') inviteCode = chain.refCode;
    else if (choice === 'initial') inviteCode = freemodelConfig.INITIAL_INVITE;
    else {
        const v = (await rawInput('Введи FRE-код', freemodelConfig.INITIAL_INVITE)).trim();
        inviteCode = REF_CODE_RE.test(v) ? v : freemodelConfig.INITIAL_INVITE;
    }

    // ШАГ 2: процесс
    clearScreen();
    console.log('');
    console.log(`  🆓  Создание FreeModel-аккаунта`);
    console.log(`  ──────────────────────────────────`);
    console.log(`  🔗 Инвайт:  ${inviteCode}`);
    console.log('');
    console.log(`  [1/4]  Создаю guerrillamail-инбокс...`);

    const inbox = new GuerrillaInbox();
    await inbox.create();
    const email = inbox.emailAddr;

    console.log('');
    console.log('  ═══════════════════════════════════════════════════════════');
    console.log(`    📧 EMAIL:    \x1b[1m\x1b[36m${email}\x1b[0m`);
    console.log(`    🔗 INVITE:   ${inviteCode}`);
    console.log(`    📬 INBOX:    \x1b[2mhttps://www.guerrillamail.com (введи логин выше)\x1b[0m`);
    console.log('  ═══════════════════════════════════════════════════════════');
    console.log('');

    console.log(`  [2/4]  Открываю браузер на invite-странице...`);
    const signupUrl = freemodelConfig.SIGNUP_URL_TPL.replace('{CODE}', inviteCode);

    let browser, context;
    let sessionDir = null, myRefCode = null;
    let success = false;

    try {
        browser = await chromium.launch({
            headless: false,
            args: ['--disable-blink-features=AutomationControlled'],
        });
        context = await browser.newContext({
            viewport: freemodelConfig.VIEWPORT,
            userAgent: freemodelConfig.USER_AGENT,
            locale: freemodelConfig.LOCALE,
        });
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        const page = await context.newPage();
        await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log(`         ✅ Открыто: ${signupUrl}`);
        console.log('');
        console.log(`  [3/4]  👉 Вставь EMAIL выше в форму freemodel и нажми signup.`);
        console.log(`         Я в фоне слежу за письмом и сам напечатаю код когда придёт.`);
        console.log('');

        // Фоновый опрос почты — НЕ открываем линк автоматически, только печатаем
        let polling = true;
        let codePrinted = false;
        const pollPromise = (async () => {
            const matcher = ({ from, subject }) => {
                const f = (from || '').toLowerCase();
                const s = (subject || '').toLowerCase();
                if (f.includes(freemodelConfig.EMAIL_FROM_HINT)) return true;
                return freemodelConfig.EMAIL_SUBJECT_HINTS.some(h => s.includes(h));
            };
            while (polling) {
                try {
                    const list = await inbox.checkNew();
                    for (const m of list) {
                        if (!matcher({ from: m.mail_from, subject: m.mail_subject })) continue;
                        const full = await inbox.fetchEmail(m.mail_id);
                        const body = full.mail_body || '';
                        const code = extractVerifyCode(body);
                        if (code && !codePrinted) {
                            codePrinted = true;
                            console.log('');
                            console.log('  ═══════════════════════════════════════════════════════════');
                            console.log(`    📬 КОД из письма:  \x1b[1m\x1b[33m${code}\x1b[0m`);
                            console.log(`    📨 От:  ${m.mail_from}`);
                            console.log(`    📝 Тема:  ${m.mail_subject}`);
                            console.log('  ═══════════════════════════════════════════════════════════');
                            console.log('');
                        }
                    }
                } catch {}
                await new Promise(r => setTimeout(r, freemodelConfig.EMAIL_POLL_MS));
            }
        })();

        console.log(`         Когда залогинишься в Dashboard — нажми клавишу здесь.`);
        console.log(`         (опционально привяжи Telegram до этого)`);
        await waitAnyKey(setKeypressListener, '\x1b[2m(нажми любую клавишу когда залогинен в dashboard)\x1b[0m');
        polling = false;
        await pollPromise.catch(() => {});

        // ШАГ 4: проверка + грабим реф-код
        console.log('');
        console.log(`  [4/4]  Проверяю что ты залогинен...`);
        const loggedIn = await isLoggedIn(context);
        if (!loggedIn) {
            console.log(`         ❌ Не вижу dashboard — похоже, что вход не завершён.`);
            console.log(`         Сессия НЕ сохранена. Залогинься в браузере и попробуй ещё раз.`);
        } else {
            console.log(`         ✅ Залогинен в dashboard`);
            console.log(`         🔍 Извлекаю реф-код с /dashboard/refer...`);
            myRefCode = await grabMyRefCode(context);
            if (myRefCode) console.log(`         🔗 Твой RefCode:  \x1b[1m\x1b[32m${myRefCode}\x1b[0m`);
            else console.log(`         ⚠️  RefCode не найден — допиши в session_info.txt вручную`);

            // Сохраняем
            if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            const localPart = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
            const orgName = `user-${localPart}`;
            const sessionName = `${mskTimestamp()}-success_${orgName}`;
            sessionDir = path.join(SESSIONS_DIR, sessionName);
            fs.mkdirSync(sessionDir, { recursive: true });

            await context.storageState({ path: path.join(sessionDir, 'session.json') });

            fs.writeFileSync(path.join(sessionDir, 'restore_session.js'), `const { chromium } = require('playwright');
const path = require('path');
(async () => {
    console.log('🚀 Восстанавливаю сессию: ${sessionName}');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: path.join(__dirname, 'session.json') });
    const page = await context.newPage();
    await page.goto('${freemodelConfig.DASHBOARD_URL}', { waitUntil: 'domcontentloaded' });
    console.log('✅ Браузер открыт с сессией! Закрой вручную.');
})();
`);

            fs.writeFileSync(path.join(sessionDir, 'session_info.txt'), `URL: ${freemodelConfig.DASHBOARD_URL}
Время сохранения: ${new Date(Date.now() + 3 * 60 * 60 * 1000).toLocaleString('ru-RU')}
Email: ${email}
Org: ${orgName}
Статус: ✅ FreeModel сессия
InviteUsed: ${inviteCode}
RefCode: ${myRefCode || ''}
`);

            console.log('');
            console.log(`         ✅ Сохранено: ${sessionDir}`);
            if (myRefCode) console.log(`         ➜  Следующий аккаунт пойдёт по: \x1b[1m\x1b[32m${myRefCode}\x1b[0m`);
            success = true;
        }
    } catch (e) {
        console.log('');
        console.log(`  ❌ Ошибка: ${e.message}`);
    }
    // Браузер НЕ закрываем — закроешь сам. Storage уже сохранён в session.json.

    console.log('');
    console.log(`  ──────────────────────────────────`);
    console.log(`  ${success ? '✅ Готово' : '❌ Сессия не создана'}`);
    await waitAnyKey(setKeypressListener, '\x1b[2mнажми любую клавишу для возврата в меню\x1b[0m');
    clearScreen();
}

module.exports = { createFreemodelSession, findLatestRefCode };
