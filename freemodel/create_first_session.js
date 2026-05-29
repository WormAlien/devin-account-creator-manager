// freemodel/create_first_session.js
//
// Пошаговое создание ОДНОЙ сессии freemodel + экспорт в менеджер сессий (manual_sessions/).
//
// Что делает:
//   1. Создаёт guerrillamail-инбокс, печатает адрес КРУПНО
//   2. Открывает видимый браузер на invite-странице freemodel
//   3. Ты сам вводишь email и жмёшь продолжить (как ты и просил — ввод вручную)
//   4. Скрипт в фоне опрашивает guerrillamail. Как придёт письмо — печатает magic-link
//      и сам открывает его в новой вкладке → ты залогинен
//   5. Жмёшь Enter в терминале → сессия сохраняется в manual_sessions/<...>/ так,
//      чтобы её увидел menu.js (session.json + session_info.txt + restore_session.js)
//
// Запуск:
//   node freemodel/create_first_session.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('./config');
const { GuerrillaInbox } = require('./lib/guerrillamail');

const SESSIONS_DIR = path.join(__dirname, '..', 'manual_sessions'); // корень репо

function prompt(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(res => rl.question(q, a => { rl.close(); res(a); }));
}

function mskTimestamp() {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return msk.toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-05-28T14-30-12
}

function stripHtml(s) {
    return (s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractMagicLink(body) {
    if (!body) return null;
    const patterns = [
        /https?:\/\/(?:www\.)?freemodel\.dev\/[^\s"'<>]*(?:verify|confirm|magic|login|signin|callback|token)[^\s"'<>]*/i,
        /https?:\/\/(?:www\.)?freemodel\.dev\/[^\s"'<>]+/i,
    ];
    for (const re of patterns) {
        const m = body.match(re);
        if (m) return m[0].replace(/&amp;/g, '&');
    }
    return null;
}

async function main() {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    // CLI: можно задать локальную часть (до @) или полный email
    //   node freemodel/create_first_session.js              → случайный
    //   node freemodel/create_first_session.js asdasdsa     → asdasdsa@guerrillamail.com
    //   node freemodel/create_first_session.js foo@bar.com  → использовать как есть (без проверки в guerrilla)
    const arg = (process.argv[2] || '').trim();
    let localPartArg = null;
    let externalEmail = null;
    if (arg.includes('@')) {
        externalEmail = arg;
    } else if (arg) {
        localPartArg = arg.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    }

    // 1. Почта
    console.log('[1/5] Создаю guerrillamail-инбокс...');
    const inbox = new GuerrillaInbox();
    let email;
    if (externalEmail) {
        // Внешний email — не дёргаем guerrilla API, просто используем строку.
        // Письма читать не будем — magic-link придётся открыть руками.
        email = externalEmail;
        console.log(`     ℹ️  Внешний email — авто-опрос почты ОТКЛЮЧЁН.`);
    } else {
        await inbox.create();
        if (localPartArg) {
            email = await inbox.setUser(localPartArg);
        } else {
            email = inbox.emailAddr;
        }
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  📧 EMAIL:  ${email}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  👉 Скопируй и вставь его в форму регистрации freemodel.');
    console.log('');

    // 2. Браузер
    console.log('[2/5] Открываю браузер на invite-странице...');
    const signupUrl = config.SIGNUP_URL_TPL.replace('{CODE}', config.INITIAL_INVITE);
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
    await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log(`     ✅ Открыто: ${signupUrl}`);
    console.log('');
    console.log('[3/5] 👉 Введи email выше в форму и нажми "продолжить" в БРАУЗЕРЕ.');
    console.log('     Я тем временем слежу за входящими...');
    console.log('');

    // 4. Фоновый опрос почты (только если используем guerrilla)
    let magicLink = null;
    let polling = !externalEmail;
    if (externalEmail) {
        console.log('     ⚠️ Опрос почты пропущен — открой magic-link из письма вручную.');
    }
    (async () => {
        if (externalEmail) return;
        const matcher = ({ from, subject }) => {
            const f = (from || '').toLowerCase();
            const s = (subject || '').toLowerCase();
            if (f.includes(config.EMAIL_FROM_HINT)) return true;
            return config.EMAIL_SUBJECT_HINTS.some(h => s.includes(h));
        };
        while (polling && !magicLink) {
            try {
                const list = await inbox.checkNew();
                for (const m of list) {
                    console.log(`\n     📬 письмо: от=${m.mail_from} тема="${m.mail_subject}"`);
                    if (!matcher({ from: m.mail_from, subject: m.mail_subject })) continue;
                    const full = await inbox.fetchEmail(m.mail_id);
                    const body = full.mail_body || '';
                    const link = extractMagicLink(body) || extractMagicLink(stripHtml(body));
                    if (link) {
                        magicLink = link;
                        console.log('');
                        console.log('═══════════════════════════════════════════════════════════');
                        console.log(`  🔗 MAGIC-LINK: ${link}`);
                        console.log('═══════════════════════════════════════════════════════════');
                        console.log('     Открываю его в новой вкладке — ты залогинишься.');
                        try {
                            const p2 = await context.newPage();
                            await p2.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
                        } catch (e) {
                            console.log(`     ⚠️ не смог авто-открыть: ${e.message}. Открой ссылку вручную.`);
                        }
                    } else {
                        console.log('     ⚠️ ссылка в письме не найдена. Тело (начало):');
                        console.log('     ' + stripHtml(body).slice(0, 400));
                    }
                }
            } catch (e) {
                // тихо, просто ретраим
            }
            await new Promise(r => setTimeout(r, config.EMAIL_POLL_MS));
        }
    })();

    // 5. Ждём подтверждения от пользователя
    console.log('[4/5] Когда увидишь Dashboard (залогинен) — вернись сюда и нажми Enter.');
    await prompt('     Enter после успешного входа: ');
    polling = false;

    const currentUrl = page.url();
    console.log(`     📍 Текущий URL основной вкладки: ${currentUrl}`);

    // Экспорт в manual_sessions/ (формат menu.js)
    console.log('[5/5] Сохраняю сессию в менеджер...');
    const localPart = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const orgName = `user-${localPart}`;
    const sessionName = `${mskTimestamp()}-success_${orgName}`;
    const sessionDir = path.join(SESSIONS_DIR, sessionName);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionJson = path.join(sessionDir, 'session.json');
    await context.storageState({ path: sessionJson });

    // restore_session.js на freemodel dashboard
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

    // session_info.txt (menu.js читает Email/Org/Статус)
    fs.writeFileSync(path.join(sessionDir, 'session_info.txt'), `URL: ${config.DASHBOARD_URL}
Время сохранения: ${new Date(Date.now() + 3 * 60 * 60 * 1000).toLocaleString('ru-RU')}
Email: ${email}
Org: ${orgName}
Статус: ✅ FreeModel сессия
Magic-link: ${magicLink || '(вход вручную)'}
`);

    const stat = fs.statSync(sessionJson);
    console.log('');
    console.log(`     ✅ Сохранено: ${sessionDir}`);
    console.log(`     📊 session.json: ${stat.size} байт`);
    console.log('');
    console.log('Теперь открой menu.js → Менеджер сессий и проверь, что запись появилась.');
    console.log('Браузер оставляю открытым. Закрой вручную или Ctrl+C.');

    await new Promise(() => {}); // не закрываемся сами
}

main().catch(err => {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
});
