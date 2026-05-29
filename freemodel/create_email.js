// freemodel/create_email.js
//
// Создаёт одну временную Gmail-почту через emailnator.com и ждёт письмо.
// Использование:
//   node freemodel/create_email.js
//
// Шаги:
//   1. Открывается видимый браузер, заходит на emailnator.com
//   2. Получает Gmail-адрес с точками
//   3. Печатает email в терминал — копируешь и вставляешь куда надо
//   4. Каждые 10 секунд проверяет inbox
//   5. Когда приходит письмо — извлекает 4-8 значный код и печатает
//
// Не уходит сам — крутится пока не нажмёшь Ctrl+C или код не найдётся.

const { chromium } = require('playwright');

const POLL_INTERVAL_MS = 10000;
const MAX_WAIT_MIN = 15;

async function createEmail(page) {
    console.log('[Почта] Открываю emailnator.com...');
    await page.goto('https://www.emailnator.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });

    try { await page.click('button:has-text("Consent")', { timeout: 4000 }); } catch {}
    await page.waitForTimeout(1500);

    let email = '';
    for (let i = 0; i < 6; i++) {
        try {
            email = await page.locator('input').first().inputValue();
            if (email && email.includes('@gmail.com')) break;
        } catch {}
        await page.waitForTimeout(1000);
    }

    if (!email || !email.includes('@gmail.com')) {
        throw new Error('Не удалось получить email от emailnator');
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  📧 EMAIL: ${email}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('💡 Скопируй этот email и используй для регистрации.');
    console.log('');

    return email;
}

async function pollInbox(page, email) {
    const maxAttempts = Math.floor((MAX_WAIT_MIN * 60 * 1000) / POLL_INTERVAL_MS);
    console.log(`[Почта] Проверяю inbox каждые ${POLL_INTERVAL_MS / 1000}с (${MAX_WAIT_MIN} мин макс)...`);

    await page.goto(`https://www.emailnator.com/mailbox#${email}`, { timeout: 30000, waitUntil: 'domcontentloaded' });
    try { await page.click('button:has-text("Consent")', { timeout: 3000 }); } catch {}
    await page.waitForTimeout(2000);

    let lastBodyLen = 0;

    for (let i = 0; i < maxAttempts; i++) {
        try {
            // Кнопка "Refresh" если есть, либо reload
            try {
                const refreshBtn = page.locator('button:has-text("Refresh"), button:has-text("Обновить")').first();
                if (await refreshBtn.count() > 0) {
                    await refreshBtn.click({ timeout: 2000 });
                } else {
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    try { await page.click('button:has-text("Consent")', { timeout: 1500 }); } catch {}
                }
            } catch {
                await page.reload({ waitUntil: 'domcontentloaded' });
            }
            await page.waitForTimeout(2500);

            const text = await page.locator('body').innerText().catch(() => '');

            if (text.length > lastBodyLen + 50) {
                lastBodyLen = text.length;
                console.log(`\n[Почта] 📬 inbox обновился (${text.length} символов)`);

                // Список ссылок-писем (обычно <a> с темой). Кликаем первое не-системное.
                const messageLocators = page.locator('a, [role="link"], li.message, div.message');
                const count = Math.min(await messageLocators.count(), 10);

                for (let j = 0; j < count; j++) {
                    try {
                        const ml = messageLocators.nth(j);
                        const t = (await ml.innerText().catch(() => '')).toLowerCase();
                        if (!t || t.length < 5) continue;
                        if (t.includes('emailnator') || t.includes('refresh') || t.includes('consent')) continue;

                        await ml.click({ timeout: 2000 }).catch(() => {});
                        await page.waitForTimeout(1500);
                        break;
                    } catch {}
                }

                const messageText = await page.locator('body').innerText().catch(() => '');

                // Ищем коды разной длины (приоритет 6, потом 8/5/4)
                const patterns = [
                    /(?:code|код|verify|verification|otp|pin)[^\d]{0,40}(\d{4,8})/i,
                    /\b(\d{6})\b/,
                    /\b(\d{8})\b/,
                    /\b(\d{5})\b/,
                    /\b(\d{4})\b/,
                ];

                for (const re of patterns) {
                    const m = messageText.match(re);
                    if (m) {
                        console.log('');
                        console.log('═══════════════════════════════════════════════════════════');
                        console.log(`  🎉 КОД: ${m[1]}`);
                        console.log('═══════════════════════════════════════════════════════════');
                        console.log('');
                        console.log(`📧 Email: ${email}`);
                        console.log(`🔢 Код:   ${m[1]}`);
                        console.log('');
                        return m[1];
                    }
                }
            }
        } catch (e) {
            console.log(`[Почта] ⚠️  ${e.message}`);
        }

        process.stdout.write('.');
        await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    console.log('\n[Почта] ❌ Письмо не пришло за ' + MAX_WAIT_MIN + ' мин');
    return null;
}

async function main() {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
        const email = await createEmail(page);
        const code = await pollInbox(page, email);

        if (code) {
            console.log('✅ Готово. Можешь закрыть браузер.');
        } else {
            console.log('⚠️  Код не пришёл. Проверь inbox в браузере вручную.');
        }

        console.log('Браузер останется открытым. Закрой вручную когда не нужен.');
        await new Promise(() => {});
    } catch (e) {
        console.error('❌ Ошибка:', e.message);
        await browser.close();
        process.exit(1);
    }
}

main();
