// notion/notion_workflow.js
//
// Автоматизированная регистрация Notion аккаунтов на основе записанного флоу
// Использует emailnator для почты, данные карты из config.js
//
// Использование: node notion/notion_workflow.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const LOGS_DIR = path.join(__dirname, 'logs');
const ERROR_LOG = path.join(LOGS_DIR, 'errors.log');
const FULL_LOG = path.join(LOGS_DIR, 'workflow.log');

// ==================== ЛОГИРОВАНИЕ ====================

if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function timestamp() {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return msk.toISOString().replace('T', ' ').slice(0, 19);
}

function logToFile(file, message) {
    try {
        fs.appendFileSync(file, `[${timestamp()}] ${message}\n`);
    } catch (e) {
        // Игнорируем ошибки логирования
    }
}

// Перехватываем console.log/error для записи в файл
const origLog = console.log;
const origError = console.error;

console.log = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    logToFile(FULL_LOG, msg);
    origLog(...args);
};

console.error = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    logToFile(FULL_LOG, `ERROR: ${msg}`);
    logToFile(ERROR_LOG, msg);
    origError(...args);
};

function logError(context, error, extra = {}) {
    const msg = [
        `=== ERROR: ${context} ===`,
        `Message: ${error.message || error}`,
        `Stack: ${error.stack || 'no stack'}`,
        Object.keys(extra).length ? `Extra: ${JSON.stringify(extra, null, 2)}` : '',
        '='.repeat(50)
    ].filter(Boolean).join('\n');

    logToFile(ERROR_LOG, msg);
    logToFile(FULL_LOG, msg);
}

// Глобальный обработчик необработанных ошибок
process.on('uncaughtException', (err) => {
    logError('uncaughtException', err);
    origError('\n💥 UNCAUGHT EXCEPTION:', err);
    origError(`📝 Лог: ${ERROR_LOG}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
    origError('\n💥 UNHANDLED REJECTION:', reason);
    origError(`📝 Лог: ${ERROR_LOG}`);
});

console.log(`[Лог] Файлы логов:`);
console.log(`[Лог]   Полный: ${FULL_LOG}`);
console.log(`[Лог]   Ошибки: ${ERROR_LOG}`);

// ==================== EMAILNATOR ====================

/**
 * Создать временную почту через emailnator.com.
 * Возвращает Gmail-адрес с точками, который принимает Notion.
 */
async function createEmailnatorEmail() {
    console.log('[Почта] Создаём email через emailnator.com...');

    let browser;
    try {
        console.log('[Почта]   1/4: запуск Chromium (headless)...');
        browser = await chromium.launch({ headless: true });
    } catch (e) {
        console.log(`[Почта] ❌ chromium.launch упал: ${e.message}`);
        throw e;
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('[Почта]   2/4: открываем https://www.emailnator.com/');
        await page.goto('https://www.emailnator.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Закрываем consent popup
        try {
            await page.click('button:has-text("Consent")', { timeout: 5000 });
            console.log('[Почта]   ✓ Consent popup закрыт');
        } catch (e) {
            console.log('[Почта]   - Consent popup не появился');
        }

        await page.waitForTimeout(2000);

        console.log('[Почта]   3/4: настраиваю .Gmail (dotted) режим...');

        // Сначала снимаем чекбоксы +Gmail и GoogleMail если они отмечены
        for (const lbl of ['+Gmail', 'GoogleMail']) {
            try {
                const cb = page.locator(`label:has-text("${lbl}") input[type="checkbox"], input[type="checkbox"][value*="${lbl.replace('+', '')}"]`).first();
                if (await cb.count() > 0 && await cb.isChecked().catch(() => false)) {
                    await cb.click({ timeout: 1000 });
                    console.log(`[Почта]     ✗ Снял "${lbl}"`);
                }
            } catch { }
        }

        // Включаем .Gmail если выключен
        try {
            const cb = page.locator(`label:has-text(".Gmail") input[type="checkbox"], input[type="checkbox"][value*="dotGmail" i]`).first();
            if (await cb.count() > 0 && !(await cb.isChecked().catch(() => true))) {
                await cb.click({ timeout: 2000 });
                console.log('[Почта]     ✓ Включил ".Gmail"');
            } else {
                console.log('[Почта]     ✓ ".Gmail" уже включен');
            }
        } catch {
            try {
                await page.click('label:has-text(".Gmail")', { timeout: 2000 });
                console.log('[Почта]     ✓ Кликнул label ".Gmail"');
            } catch {
                console.log('[Почта]     ⚠️ Не нашёл чекбокс .Gmail');
            }
        }

        await page.waitForTimeout(1000);

        // Жмём "Generate New" — и при необходимости перегенерируем, если получили +alias
        let email = '';
        const MAX_GEN_ATTEMPTS = 7;
        for (let gen = 0; gen < MAX_GEN_ATTEMPTS; gen++) {
            // Возврат на главную перед каждой попыткой (кроме первой)
            if (gen > 0) {
                await page.goto('https://www.emailnator.com/', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
                await page.waitForTimeout(2000);

                // Перенастраиваем .Gmail
                try {
                    const cb = page.locator(`label:has-text(".Gmail") input[type="checkbox"], input[type="checkbox"][value*="dotGmail" i]`).first();
                    if (await cb.count() > 0 && !(await cb.isChecked().catch(() => true))) {
                        await cb.click({ timeout: 2000 });
                    }
                } catch {}

                for (const lbl of ['+Gmail', 'GoogleMail']) {
                    try {
                        const cb = page.locator(`label:has-text("${lbl}") input[type="checkbox"]`).first();
                        if (await cb.count() > 0 && await cb.isChecked().catch(() => false)) {
                            await cb.click({ timeout: 1000 });
                        }
                    } catch {}
                }
                await page.waitForTimeout(1000);
            }

            try {
                await page.click('button:has-text("Generate"), button:has-text("Go")', { timeout: 5000 });
                console.log(`[Почта]     ✓ Нажал Generate (попытка ${gen + 1}/${MAX_GEN_ATTEMPTS})`);
            } catch {
                console.log(`[Почта]     ⚠️ Не нашёл Generate (попытка ${gen + 1})`);
                continue;
            }
            await page.waitForTimeout(2500);

            const url = page.url();
            const m = url.match(/#([\w.+-]+@(?:gmail|googlemail)\.com)/i);
            if (m) {
                const got = m[1];
                console.log(`[Почта]     URL email: ${got}`);
                if (got.includes('+')) {
                    console.log('[Почта]     ⚠️ Получили +alias, генерю заново...');
                    continue;
                }
                email = got;
                break;
            }
        }

        if (!email) {
            const dumpPath = path.join(__dirname, 'emailnator_debug.png');
            await page.screenshot({ path: dumpPath, fullPage: true }).catch(() => {});
            console.log(`[Почта] 📸 Скриншот: ${dumpPath}`);
            throw new Error('Не удалось получить dotted Gmail-адрес от emailnator');
        }

        if (/@googlemail\.com$/i.test(email)) {
            email = email.replace(/@googlemail\.com$/i, '@gmail.com');
        }

        console.log(`[Почта]   4/4: ✅ Email получен: ${email}`);
        await browser.close();

        return email;
    } catch (e) {
        await browser.close().catch(() => { });
        throw e;
    }
}

async function waitForOtpCode(email) {
    return waitForOtpCodeWithTimeout(email, config.DELAY_OTP_WAIT);
}

async function waitForOtpCodeWithTimeout(email, timeoutMs) {
    console.log(`[OTP] Ждём код для ${email} (макс ${Math.round(timeoutMs/1000)} сек)...`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    const pollInterval = 3000;

    try {
        while (Date.now() < deadline) {
            await page.goto(`https://www.emailnator.com/mailbox#${email}`, { timeout: 30000 });

            try {
                await page.click('button:has-text("Consent")', { timeout: 2000 });
            } catch (e) { }

            await page.waitForTimeout(3000);

            const text = await page.locator('body').innerText();

            if (text.includes('Notion') || text.includes('signup code') || text.includes('verification')) {
                console.log('\n[OTP] ✅ Письмо от Notion найдено!');

                try {
                    await page.click('text=Notion');
                    await page.waitForTimeout(2000);

                    const messageText = await page.locator('body').innerText();
                    const codeMatch = messageText.match(/\b(\d{6})\b/);
                    if (codeMatch) {
                        console.log(`[OTP] 🎉 Код извлечён: ${codeMatch[1]}`);
                        await browser.close();
                        return codeMatch[1];
                    }
                } catch (e) {
                    console.log(`\n[OTP] ⚠️ Ошибка при чтении письма: ${e.message}`);
                }
            }

            process.stdout.write('.');
            await page.waitForTimeout(pollInterval);
        }

        console.log(`\n[OTP] ⏰ Таймаут (${Math.round(timeoutMs/1000)}с) - код не пришёл`);
        await browser.close();
        return null;
    } catch (e) {
        await browser.close().catch(() => {});
        throw e;
    }
}

// ==================== РЕГИСТРАЦИЯ ====================

async function registerAccount(accountIndex) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  АККАУНТ #${accountIndex + 1}`);
    console.log('═'.repeat(60));

    let email, browser, context, preset, sessionDir;

    try {
        // 1. Создаём почту
        email = await createEmailnatorEmail();

        // 2. Берём пресет карты
        const presets = config.CARD_PRESETS || [];
        const idx = Number.isInteger(config.CARD_PRESET_INDEX) ? config.CARD_PRESET_INDEX : accountIndex % presets.length;
        preset = presets[Math.min(idx, presets.length - 1)];

        if (!preset) {
            throw new Error('Нет пресетов карт в config.js');
        }

        const billing = preset.billing || {};

        console.log(`[Карта] ${preset.label || preset.number.slice(0, 4) + '…' + preset.number.slice(-4)}`);

        // 3. Запускаем браузер
        console.log('[Браузер] Запуск...');
        browser = await chromium.launch({
            headless: config.HEADLESS,
            args: ['--disable-blink-features=AutomationControlled'],
        });

        context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            locale: config.LOCALE || 'en-US',
            ...(config.PROXY ? { proxy: { server: config.PROXY } } : {}),
        });

        if (config.STEALTH_ENABLED) {
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        }

        const page = await context.newPage();

        // 4. Signup page
        console.log('[Signup] Открываю страницу...');
        await page.goto('https://www.notion.so/signup', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        // 5-6. Ввод email + ожидание OTP с ретраем при таймауте
        const MAX_EMAIL_RETRIES = 5;
        let otpCode = null;
        let currentEmail = email;

        for (let emailAttempt = 0; emailAttempt < MAX_EMAIL_RETRIES; emailAttempt++) {
            // Ввод email
            console.log(`[Signup] Ввожу email: ${currentEmail}`);
            await page.getByRole('textbox', { name: 'Work email' }).fill(currentEmail);
            await page.waitForTimeout(1000);
            await page.getByRole('button', { name: 'Continue' }).click();
            await page.waitForTimeout(3000);

            // Проверка на забаненный email (расширенная)
            const bodyText = await page.locator('body').innerText().catch(() => '');
            const lowerText = bodyText.toLowerCase();
            const banPatterns = [
                'banned',
                'account has been banned',
                'this account has been',
                'account was banned',
                'suspended',
                'blocked',
                'not allowed',
                'cannot create',
                'cannot sign up',
                'oops, something went wrong',
                'something went wrong',
                'could not reach the email',
                'try again with a different email',
            ];
            const banMatch = banPatterns.find(p => lowerText.includes(p));
            if (banMatch) {
                console.log(`[Email] ❌ Email отклонён! (найдено: "${banMatch}")`);
                await browser.close();
                return { success: false, banned: true, email: currentEmail };
            }

            // Ждём OTP с таймаутом 40 секунд
            console.log(`[OTP] Жду код для ${currentEmail} (макс 40 сек)...`);
            otpCode = await waitForOtpCodeWithTimeout(currentEmail, 40000);

            if (otpCode) {
                email = currentEmail; // обновляем email на успешный
                break;
            }

            // OTP не пришёл - создаём новую почту
            if (emailAttempt < MAX_EMAIL_RETRIES - 1) {
                console.log(`[OTP] ⚠️ Код не пришёл за минуту. Беру новую почту (попытка ${emailAttempt + 2}/${MAX_EMAIL_RETRIES})...`);

                try {
                    currentEmail = await createEmailnatorEmail();
                } catch (e) {
                    console.log(`[Почта] ❌ Не удалось создать новую почту: ${e.message}`);
                    throw new Error('OTP код не получен и не удалось создать новую почту');
                }

                // Возвращаемся на signup и очищаем поле email
                console.log('[Signup] Возвращаюсь на страницу регистрации...');
                await page.goto('https://www.notion.so/signup', { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForTimeout(2000);
            }
        }

        if (!otpCode) {
            throw new Error(`OTP код не получен после ${MAX_EMAIL_RETRIES} попыток`);
        }

        // 7. Вводим OTP
        console.log('[OTP] Ввожу код...');
        await page.getByRole('textbox', { name: 'Verification code' }).fill(otpCode);
        await page.waitForTimeout(1000);
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.waitForTimeout(3000);

        // 7.1. Сохраняем сессию после успешного email подтверждения
        console.log('[Сессия] Сохраняю промежуточную сессию...');
        const emailPart = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');

        if (!fs.existsSync(SESSIONS_DIR)) {
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        }

        sessionDir = path.join(SESSIONS_DIR, emailPart);
        if (fs.existsSync(sessionDir)) {
            sessionDir = path.join(SESSIONS_DIR, `${emailPart}-${Date.now()}`);
        }

        fs.mkdirSync(sessionDir, { recursive: true });
        await context.storageState({ path: path.join(sessionDir, 'session.json') });

        // Извлекаем и сохраняем token_v2
        try {
            const storageState = await context.storageState();
            const tokenCookie = (storageState.cookies || []).find(c => c.name === 'token_v2');
            if (tokenCookie) {
                fs.writeFileSync(path.join(sessionDir, 'token_v2.txt'), tokenCookie.value);
                console.log(`[Сессия] 🔑 Token: ${tokenCookie.value.slice(0, 20)}...${tokenCookie.value.slice(-10)}`);
            }
        } catch (e) {
            console.log(`[Сессия] ⚠️ Не удалось извлечь token_v2: ${e.message}`);
        }

        const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
        fs.writeFileSync(path.join(sessionDir, 'session_info.txt'), `URL: https://www.notion.so/
Время сохранения: ${now.toLocaleString('ru-RU')}
Email: ${email}
Status: in-progress
Created: ${now.toISOString()}
`);

        console.log('[Сессия] ✅ Промежуточная сессия сохранена');
        await page.waitForTimeout(500);

        // 8. Онбординг - Continue
        console.log('[Онбординг] Прохожу шаги...');
        try {
            await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5000 });
            await page.waitForTimeout(1500);
        } catch (e) {}

        // 9. OK button
        try {
            await page.getByRole('button', { name: 'OK' }).click({ timeout: 5000 });
            await page.waitForTimeout(1500);
        } catch (e) {}

        // 10. "For work" выбор
        try {
            await page.getByRole('button', { name: 'For work' }).click({ timeout: 5000 });
            await page.waitForTimeout(1500);
        } catch (e) {}

        // 11. Continue после выбора
        try {
            await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5000 });
            await page.waitForTimeout(1500);
        } catch (e) {}

        // 12. Ещё один Continue
        try {
            await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5000 });
            await page.waitForTimeout(1500);
        } catch (e) {}

        // 12.1. Логика: сначала ищем "Try free for 30 days", если её нет — ищем окно со Skip и жмём Back
        console.log('[Онбординг] Ищу "Try free for 30 days" или окно Skip...');

        let trialFound = false;
        // Сначала пробуем найти кнопку Try free
        try {
            const trialBtn = page.getByRole('button', { name: 'Try free for 30 days' });
            if (await trialBtn.count() > 0) {
                console.log('[Онбординг] ✓ Нашёл "Try free for 30 days" — иду к оплате');
                trialFound = true;
            }
        } catch (e) {}

        // Если Try free нет — значит появилось окно онбординга, жмём Back
        if (!trialFound) {
            console.log('[Онбординг] Try free не найден, ищу окно онбординга...');
            const backButtons = ['Back', 'Назад', '← Back'];
            let wentBack = false;
            for (const btnName of backButtons) {
                try {
                    await page.getByRole('button', { name: btnName, exact: false }).click({ timeout: 3000 });
                    console.log(`[Онбординг] ✓ Нажал "${btnName}"`);
                    await page.waitForTimeout(2000);
                    wentBack = true;
                    break;
                } catch (e) {}
            }

            if (!wentBack) {
                console.log('[Онбординг] ⚠️ Не нашёл Back, пробую Continue...');
                try {
                    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 });
                    await page.waitForTimeout(1500);
                } catch (e) {}
            }
        }

        // 13. "Try free for 30 days"
        console.log('[Биллинг] Открываю форму оплаты...');
        await page.getByRole('button', { name: 'Try free for 30 days' }).click();
        await page.waitForTimeout(3000);

        // 14. Заполняем Name
        console.log('[Биллинг] Заполняю данные...');
        await page.getByRole('textbox', { name: 'Name', exact: true }).fill(billing.name || 'Michael Johnson');
        await page.waitForTimeout(1000);

        // 15. Заполняем карту в Stripe iframe
        console.log('[Stripe] Заполняю карту...');

        // Ждём появления iframe
        await page.waitForTimeout(3000);

        // Находим iframe по pattern имени (меняется каждый раз)
        const cardFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first();

        // Card number
        await cardFrame.getByRole('textbox', { name: 'Card number' }).fill(preset.number);
        await page.waitForTimeout(800);

        // Expiration (формат MM / YY)
        const expParts = preset.exp.split('/');
        const expFormatted = `${expParts[0].trim()} / ${expParts[1].trim()}`;
        await cardFrame.getByRole('textbox', { name: 'Expiration date MM / YY' }).fill(expFormatted);
        await page.waitForTimeout(800);

        // CVC
        await cardFrame.getByRole('textbox', { name: 'Security code' }).fill(preset.cvc);
        await page.waitForTimeout(800);

        // Country
        await cardFrame.getByLabel('Country', { exact: true }).selectOption(billing.country || 'CN');
        await page.waitForTimeout(1000);

        // 16. Чекбокс согласия
        console.log('[Биллинг] Принимаю условия...');
        await page.getByRole('checkbox', { name: 'At the end of your trial' }).check();
        await page.waitForTimeout(1000);

        // 17. Start trial
        console.log('[Биллинг] Запускаю trial...');
        await page.getByRole('button', { name: 'Start Notion Business trial' }).click();
        await page.waitForTimeout(5000);

        // 18. Проверяем успех
        console.log('[Проверка] Жду подтверждения...');
        await page.waitForTimeout(10000);

        const url = page.url();
        if (url.includes('/signup') || url.includes('/login')) {
            throw new Error('Остались на странице signup/login - возможно ошибка оплаты');
        }

        console.log('[Успех] ✅ Регистрация завершена!');

        // 19. Парсим статус подписки
        console.log('[Подписка] Проверяю статус...');
        let subscriptionStatus = 'unknown';
        let planType = 'unknown';

        try {
            // Пробуем зайти на страницу настроек биллинга
            await page.goto('https://www.notion.so/settings/billing', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(3000);

            const billingText = await page.locator('body').innerText().catch(() => '');

            // Проверяем статус
            if (billingText.includes('Business trial') || billingText.includes('Trial')) {
                subscriptionStatus = 'trial';
                planType = 'Business';
            } else if (billingText.includes('Business plan') || billingText.includes('Business')) {
                subscriptionStatus = 'paid';
                planType = 'Business';
            } else if (billingText.includes('Plus plan') || billingText.includes('Plus')) {
                subscriptionStatus = 'paid';
                planType = 'Plus';
            } else if (billingText.includes('Free plan') || billingText.includes('Free')) {
                subscriptionStatus = 'free';
                planType = 'Free';
            }

            // Проверяем есть ли привязанная карта
            if (billingText.includes('ending in') || billingText.includes('****')) {
                subscriptionStatus = subscriptionStatus === 'trial' ? 'trial-card-added' : 'paid';
            }

            console.log(`[Подписка] Статус: ${subscriptionStatus}, План: ${planType}`);
        } catch (e) {
            console.log(`[Подписка] ⚠️ Не удалось определить статус: ${e.message}`);
        }

        // 20. Обновляем session_info.txt с финальным статусом
        fs.writeFileSync(path.join(sessionDir, 'session_info.txt'), `URL: https://www.notion.so/
Время сохранения: ${now.toLocaleString('ru-RU')}
Email: ${email}
Status: ${subscriptionStatus}
PlanType: ${planType}
Created: ${now.toISOString()}
CompletedAt: ${new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()}
Card: ${preset.number.slice(0, 4)}…${preset.number.slice(-4)}
`);

        console.log(`[Сохранено] ${sessionDir}`);

        if (!config.KEEP_BROWSER_OPEN) {
            await browser.close();
        }

        return { success: true, email, sessionDir };

    } catch (e) {
        console.log(`\n❌ Ошибка: ${e.message}`);

        // Детальное логирование ошибки
        let currentUrl = 'unknown';
        let pageTitle = 'unknown';
        let pageText = '';

        if (context) {
            try {
                const page = context.pages()[0];
                if (page) {
                    currentUrl = page.url();
                    pageTitle = await page.title().catch(() => 'unknown');
                    pageText = await page.locator('body').innerText().catch(() => '');
                    pageText = pageText.slice(0, 500);
                }
            } catch {}
        }

        logError('registerAccount', e, {
            email,
            accountIndex,
            url: currentUrl,
            title: pageTitle,
            pageTextPreview: pageText,
            preset: preset ? preset.label : 'unknown'
        });

        if (config.SCREENSHOT_ON_ERROR && context) {
            try {
                const page = context.pages()[0];
                if (page) {
                    const screenshotPath = path.join(__dirname, `error_${Date.now()}.png`);
                    await page.screenshot({ path: screenshotPath, fullPage: true });
                    console.log(`📸 Скриншот: ${screenshotPath}`);
                    logToFile(ERROR_LOG, `Screenshot: ${screenshotPath}`);
                }
            } catch (screenshotErr) {
                logError('screenshot', screenshotErr);
            }
        }

        console.log(`📝 Подробный лог: ${ERROR_LOG}`);

        // Закрываем браузер если сессия не была сохранена
        if (browser) {
            const sessionSaved = sessionDir && fs.existsSync(path.join(sessionDir, 'session.json'));
            if (!sessionSaved) {
                console.log('🚫 Сессия не сохранена - закрываю браузер');
                await browser.close().catch(() => {});
            } else if (!config.MANUAL_MODE) {
                await browser.close().catch(() => {});
            } else {
                console.log('💡 Сессия сохранена - оставляю браузер открытым (MANUAL_MODE)');
            }
        }

        return { success: false, email, error: e.message };
    }
}

// ==================== ГЛАВНАЯ ====================

(async () => {
    console.clear();
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  NOTION WORKFLOW - Автоматическая регистрация');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Количество: ${config.ACCOUNTS_COUNT}`);
    console.log(`  Headless: ${config.HEADLESS}`);
    console.log(`  Manual Mode: ${config.MANUAL_MODE}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    const count = config.ACCOUNTS_COUNT || 1;
    let successCount = 0;
    let failCount = 0;
    let bannedCount = 0;

    for (let i = 0; i < count; i++) {
        // Ретраим при забаненном email
        let attempt = 0;
        const MAX_BAN_RETRIES = 5;
        let result = { success: false, banned: false };

        while (attempt < MAX_BAN_RETRIES) {
            result = await registerAccount(i);

            if (!result.banned) break;

            bannedCount++;
            attempt++;
            console.log(`\n[!] 🚫 Email забанен (попытка ${attempt}/${MAX_BAN_RETRIES}). Беру новый email...\n`);
            await new Promise(r => setTimeout(r, 2000));
        }

        if (result.success) {
            successCount++;
        } else {
            failCount++;
        }

        console.log(`\n📊 Итого: ✅ ${successCount} | ❌ ${failCount} | 🚫 банов: ${bannedCount}`);

        if (i < count - 1) {
            console.log('⏳ Пауза 5 сек...\n');
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  ФИНАЛ: ✅ ${successCount} | ❌ ${failCount} | 🚫 банов: ${bannedCount}`);
    console.log('═══════════════════════════════════════════════════════════\n');
})();
