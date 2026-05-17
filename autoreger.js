const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ==================== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ====================

// BUG4 FIX: shutdownRequested на уровне модуля — доступен из waitForOtpCode
let shutdownRequested = false;

// ==================== УТИЛИТЫ ====================

const randomString = (len) => Math.random().toString(36).substring(2, 2 + len);
const randomDelay = (min, max) => min + Math.random() * (max - min);

// Функция для воспроизведения звука через PowerShell (Windows)
async function playSound(type = 'default') {
    if (!config.SOUND_NOTIFICATIONS) return;

    try {
        const { execSync } = require('child_process');
        let soundFile = '';

        switch (type) {
            case 'captcha':
                soundFile = 'C:\\Windows\\Media\\Windows Exclamation.wav'; // Звук предупреждения
                break;
            case 'captcha_solved':
                soundFile = 'C:\\Windows\\Media\\Windows Feed Discovered.wav'; // Звук решения капчи
                break;
            case 'payment_success':
                soundFile = 'C:\\Windows\\Media\\Windows Ringin.wav'; // Звук успешной оплаты
                break;
            case 'account_complete':
                soundFile = 'C:\\Windows\\Media\\Windows Notify.wav'; // Звук завершения аккаунта
                break;
            case 'error':
                soundFile = 'C:\\Windows\\Media\\Windows Error.wav'; // Звук ошибки
                break;
            case 'manual':
                soundFile = 'C:\\Windows\\Media\\Windows Hardware Fail.wav'; // Звук для ручного режима
                break;
            default:
                soundFile = 'C:\\Windows\\Media\\Windows Notify.wav';
        }

        // Используем PowerShell с Add-Type для загрузки System.Media
        execSync(`powershell -Command "Add-Type -AssemblyName System.Media; (New-Object System.Media.SoundPlayer '${soundFile}').PlaySync();"`, { stdio: 'ignore' });
    } catch (e) {
        console.log('[Звук] ⚠️ Ошибка воспроизведения:', e.message);
    }
}

// Функция для генерации скрипта сохранения сессии (для консоли браузера)
function generateSessionExportScript() {
    return `
// 📋 Скрипт для экспорта сессии из консоли браузера
// Вставьте в консоль (F12) на странице app.devin.ai

(async () => {
    const cookies = document.cookie;
    const storage = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        storage[key] = localStorage.getItem(key);
    }

    console.log('=== COOKIES ===');
    console.log(cookies);
    console.log('\\n=== LOCALSTORAGE ===');
    console.log(JSON.stringify(storage, null, 2));

    // Попытка скопировать в буфер
    try {
        const textToCopy = \`COOKIES:\\n\${cookies}\\n\\nLOCALSTORAGE:\\n\${JSON.stringify(storage, null, 2)}\`;
        await navigator.clipboard.writeText(textToCopy);
        console.log('✅ Скопировано в буфер обмена!');
    } catch (e) {
        console.log('❌ Не удалось скопировать автоматически - скопируйте вручную из консоли');
    }
})();
`;
}

// BUG3 FIX: fetch с таймаутом — если mail.tm зависнет, скрипт не повиснет навсегда
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return res;
    } catch (e) {
        clearTimeout(id);
        if (e.name === 'AbortError') throw new Error(`fetch timeout: ${url} (${timeoutMs}ms)`);
        throw e;
    }
}

function generateLuhnCard(basePrefix) {
    // Если передан полный номер карты (16 цифр), возвращаем как есть
    if (basePrefix.length === 16) {
        return basePrefix;
    }

    const neededRandom = 16 - basePrefix.length - 1;
    const randomPart = Math.floor(Math.pow(10, neededRandom) + Math.random() * Math.pow(10, neededRandom) * 9)
        .toString().slice(0, neededRandom);
    const prefix = basePrefix + randomPart;

    let sum = 0;
    let alternate = true;
    for (let i = prefix.length - 1; i >= 0; i--) {
        let n = parseInt(prefix[i]);
        if (alternate) {
            n *= 2;
            if (n > 9) n = (n % 10) + 1;
        }
        sum += n;
        alternate = !alternate;
    }

    return prefix + ((10 - (sum % 10)) % 10);
}

function getNextBin(index) {
    const bins = Array.isArray(config.BINS) ? config.BINS : [config.BINS];
    return bins[index % bins.length];
}

// ==================== АВТО-ГЕНЕРАЦИЯ ДАННЫХ КАРТЫ ====================

/**
 * Определить бренд карты по BIN
 * @param {string} bin - BIN (первые 6 цифр)
 * @returns {string} 'VISA', 'MASTERCARD', 'AMEX' или 'UNKNOWN'
 */
function getCardBrand(bin) {
    const prefix = String(bin).slice(0, 1);
    if (prefix === '4') return 'VISA';
    if (prefix === '5') return 'MASTERCARD';
    if (prefix === '3') return 'AMEX';
    return 'UNKNOWN';
}

/**
 * Сгенерировать срок действия карты
 * @param {string} expDate - 'auto' или 'ММ/ГГ'
 * @returns {string} срок в формате ММ/ГГ
 */
function generateExpDate(expDate) {
    if (expDate !== 'auto') return expDate;
    
    const now = new Date();
    const yearOffset = Math.floor(Math.random() * 3) + 1; // 1-3 года в будущее
    const expYear = (now.getFullYear() + yearOffset) % 100; // Последние 2 цифры
    const expMonth = Math.floor(Math.random() * 12) + 1; // 1-12
    
    return `${String(expMonth).padStart(2, '0')}/${String(expYear).padStart(2, '0')}`;
}

/**
 * Сгенерировать CVC-код
 * @param {string} cvcCode - 'auto' или число
 * @param {string} bin - BIN для определения бренда
 * @returns {string} CVC-код
 */
function generateCVC(cvcCode, bin) {
    if (cvcCode !== 'auto') return cvcCode;
    
    const brand = getCardBrand(bin);
    const length = brand === 'AMEX' ? 4 : 3; // AMEX = 4 цифры, остальные = 3
    
    let cvc = '';
    for (let i = 0; i < length; i++) {
        cvc += Math.floor(Math.random() * 10);
    }
    return cvc;
}

/**
 * Определить длину карты по BIN
 * @param {string} bin - BIN
 * @param {string} cardLength - 'auto' или число
 * @returns {number} длина карты
 */
function getCardLength(bin, cardLength) {
    if (cardLength !== 'auto') return cardLength;
    
    const brand = getCardBrand(bin);
    return brand === 'AMEX' ? 15 : 16; // AMEX = 15, остальные = 16
}

// ==================== BIN MANAGER (СТАТИСТИКА РАБОЧИХ/НЕРАБОЧИХ) ====================

/**
 * Управление BIN-ами: ротация, статистика, приоритизация рабочих.
 * Сохраняет known_bins.json между запусками.
 */
class BinManager {
    constructor() {
        let bins = Array.isArray(config.BINS) ? [...config.BINS] : (config.BINS ? [config.BINS] : []);
        if (bins.length === 0 || bins.every(b => !b)) {
            bins = [...DEFAULT_BINS];
            console.log(`[BIN] 🔄 BIN-ы не указаны — используем авто-подбор (${bins.length} BIN-ов)`);
        }
        this.bins = bins;
        this.knownGood = [];
        this.knownBad = [];
        this.binStats = {};
        this.binFailStreak = {};
        this.knownBinsFile = config.KNOWN_BINS_FILE || 'logs/known_bins.json';
        this.binCooldownUntil = {}; // { bin: timestamp }
        this._load();
    }

    /** @private Загрузка статистики из файла */
    _load() {
        try {
            if (fs.existsSync(this.knownBinsFile)) {
                const data = JSON.parse(fs.readFileSync(this.knownBinsFile, 'utf-8'));
                this.knownGood = data.known_good || [];
                this.knownBad = data.known_bad || [];
                this.binStats = data.stats || {};
                this.binFailStreak = data.fail_streak || {};
            }
        } catch (e) {
            console.log(`[BIN] ⚠️ Не удалось загрузить ${this.knownBinsFile}: ${e.message}`);
        }
    }

    /** @private Сохранение статистики в файл */
    _save() {
        try {
            const dir = path.dirname(this.knownBinsFile);
            if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const data = {
                known_good: this.knownGood,
                known_bad: this.knownBad,
                stats: this.binStats,
                fail_streak: this.binFailStreak,
                updated: new Date().toISOString()
            };
            fs.writeFileSync(this.knownBinsFile, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            console.log(`[BIN] ⚠️ Не удалось сохранить ${this.knownBinsFile}: ${e.message}`);
        }
    }

    /**
     * Получить BIN по индексу. Приоритет: known_good (только из текущего конфига) → config.bins.
     * @param {number} index
     * @returns {string} BIN
     */
    getNext(index) {
        const validKnownGood = this.knownGood.filter(b => this.bins.includes(b) && !this.isOnCooldown(b));
        const available = this.bins.filter(b => !this.isOnCooldown(b));
        const priority = [...new Set([...validKnownGood, ...available])];
        if (priority.length === 0) {
            console.log('[BIN] ⚠️ Все BIN-ы на cooldown — сбрасываем');
            this.binCooldownUntil = {};
            return this.bins[index % this.bins.length];
        }
        return priority[index % priority.length];
    }

    /** Отметить BIN как рабочий */
    markGood(bin) {
        if (!this.knownGood.includes(bin)) this.knownGood.push(bin);
        this.knownBad = this.knownBad.filter(b => b !== bin);
        this.binStats[bin] = this.binStats[bin] || { success: 0, fail: 0 };
        this.binStats[bin].success++;
        this.binFailStreak[bin] = 0;
        this._save();
        console.log(`[BIN] ✅ ${bin} отмечен как РАБОЧИЙ (успехов: ${this.binStats[bin].success})`);
    }

    /** Отметить BIN как нерабочий */
    markBad(bin) {
        if (!this.knownBad.includes(bin)) this.knownBad.push(bin);
        this.binStats[bin] = this.binStats[bin] || { success: 0, fail: 0 };
        this.binStats[bin].fail++;
        this.binFailStreak[bin] = (this.binFailStreak[bin] || 0) + 1;

        const consecutiveFails = this.binFailStreak[bin];
        if (consecutiveFails >= 3) {
            const cooldownMs = (config.BIN_COOLDOWN_MS ?? 600000);
            this.binCooldownUntil[bin] = Date.now() + cooldownMs;
            console.log(`[BIN] ⏳ BIN ${bin} на cooldown ${cooldownMs / 1000}с (${consecutiveFails} fail подряд)`);
        }

        this._save();
        console.log(`[BIN] ❌ ${bin} отмечен как НЕРАБОЧИЙ (неудач: ${this.binStats[bin].fail})`);
    }

    /** Проверить, не на cooldown ли BIN */
    isOnCooldown(bin) {
        const until = this.binCooldownUntil[bin];
        if (!until) return false;
        if (Date.now() >= until) {
            delete this.binCooldownUntil[bin];
            return false;
        }
        return true;
    }

    /** Получить статистику */
    getStats() {
        return {
            total: this.bins.length,
            known_good: this.knownGood.length,
            known_bad: this.knownBad.length,
            on_cooldown: Object.keys(this.binCooldownUntil).length,
            stats: this.binStats
        };
    }
}

// База BIN-ов для авто-подбора (если BINS пустой в config.js)
const DEFAULT_BINS = [
    // VISA Credit — US
    '451012', '451013', '451014', '451015', '453201', '453202', '453203',
    '455689', '455690', '455691', '471321', '471322', '491610', '492910',
    // MASTERCARD Credit — US
    '515462', '515463', '515464', '521234', '528090', '530125', '540101',
    '540102', '540103', '542018', '549184', '552100',
    // VISA Credit — GB
    '492181', '492960', '455696',
    // MASTERCARD Credit — GB
    '522125', '530135',
    // VISA Credit — DE
    '492964', '492965', '455699', '455700',
    // MASTERCARD Credit — DE
    '530139', '530140', '540110',
    // VISA Credit — CA
    '451017', '451018',
    // MASTERCARD Credit — CA
    '540112', '540113',
    // VISA Credit — FR
    '492968', '492969',
    // VISA Credit — NL
    '492972',
    // VISA Credit — AU
    '492973',
    // MASTERCARD Credit — AU
    '540117',
    // VISA Credit — SE
    '492977',
    // VISA Credit — FI
    '492978',
    // VISA Credit — ES
    '492980',
    // VISA Credit — IT
    '492982',
    // VISA Credit — JP
    '492984',
];

// Маппинг страны биллинга на timezone и locale
// Используется при BILLING_ROTATION=true
const COUNTRY_TZ_LOCALE = {
    US: { timezone: 'America/New_York', locale: 'en-US' },
    GB: { timezone: 'Europe/London', locale: 'en-GB' },
    DE: { timezone: 'Europe/Berlin', locale: 'de-DE' },
    FI: { timezone: 'Europe/Helsinki', locale: 'fi-FI' },
    FR: { timezone: 'Europe/Paris', locale: 'fr-FR' },
    ES: { timezone: 'Europe/Madrid', locale: 'es-ES' },
    IT: { timezone: 'Europe/Rome', locale: 'it-IT' },
    NL: { timezone: 'Europe/Amsterdam', locale: 'nl-NL' },
    SE: { timezone: 'Europe/Stockholm', locale: 'sv-SE' },
    CA: { timezone: 'America/Toronto', locale: 'en-CA' },
    AU: { timezone: 'Australia/Sydney', locale: 'en-AU' },
    JP: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
    BR: { timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
    MX: { timezone: 'America/Mexico_City', locale: 'es-MX' },
    IN: { timezone: 'Asia/Kolkata', locale: 'hi-IN' },
    KR: { timezone: 'Asia/Seoul', locale: 'ko-KR' },
    CH: { timezone: 'Europe/Zurich', locale: 'de-CH' },
    AT: { timezone: 'Europe/Vienna', locale: 'de-AT' },
    BE: { timezone: 'Europe/Brussels', locale: 'fr-BE' },
    PT: { timezone: 'Europe/Lisbon', locale: 'pt-PT' },
    PL: { timezone: 'Europe/Warsaw', locale: 'pl-PL' },
    CZ: { timezone: 'Europe/Prague', locale: 'cs-CZ' },
    NO: { timezone: 'Europe/Oslo', locale: 'nb-NO' },
    DK: { timezone: 'Europe/Copenhagen', locale: 'da-DK' },
    IE: { timezone: 'Europe/Dublin', locale: 'en-IE' },
};

function getTzLocaleForCountry(country) {
    return COUNTRY_TZ_LOCALE[country?.toUpperCase()] || { timezone: 'America/New_York', locale: 'en-US' };
}

function makeFolderName(baseDir, label, orgName) {
    const now = new Date();
    const Y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const D = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const existing = fs.existsSync(baseDir)
        ? fs.readdirSync(baseDir).filter(f => fs.statSync(path.join(baseDir, f)).isDirectory()).length
        : 0;
    const num = existing + 1;
    // NOTE: Windows запрещает ":" в именах папок → используем "-"
    // Формат: 1 2026-05-15 15-57 Pro user-orgname
    return path.join(baseDir, `${num} ${Y}-${M}-${D} ${h}-${m} ${label} ${orgName}`);
}

function parseProxy(proxyStr) {
    if (!proxyStr) return null;
    // Format: http://user:pass@ip:port or http://ip:port
    const match = proxyStr.match(/^https?:\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (!match) {
        console.log(`[Прокси] ⚠️ Не удалось распарсить: ${proxyStr}`);
        return null;
    }
    const proxy = { server: `http://${match[3]}:${match[4]}` };
    if (match[1] && match[2]) {
        proxy.username = match[1];
        proxy.password = match[2];
    }
    return proxy;
}

// ==================== ВАЛИДАЦИЯ CONFIG ====================

function validateConfig() {
    const bins = Array.isArray(config.BINS) ? config.BINS : [config.BINS];
    if (bins.length === 0 || bins.every(b => !b)) {
        console.error('[!] ОШИБКА: BINS пуст — укажите хотя бы один BIN в config.js');
        process.exit(1);
    }
    for (const bin of bins) {
        if (!/^\d{6,16}$/.test(bin)) {
            console.error(`[!] ОШИБКА: BIN "${bin}" некорректен — должен быть 6-16 цифр`);
            process.exit(1);
        }
    }
    if (config.EXP_DATE !== 'auto' && !/^\d{2}\/\d{2}$/.test(config.EXP_DATE)) {
        console.error(`[!] ОШИБКА: EXP_DATE "${config.EXP_DATE}" — формат должен быть MM/YY или 'auto'`);
        process.exit(1);
    }
    if (config.CVC_CODE !== 'auto' && !/^\d{3,4}$/.test(config.CVC_CODE)) {
        console.error(`[!] ОШИБКА: CVC_CODE "${config.CVC_CODE}" — должен быть 3-4 цифры или 'auto'`);
        process.exit(1);
    }
    if (config.PROXY) {
        const parsed = parseProxy(config.PROXY);
        if (!parsed) {
            console.error(`[!] ОШИБКА: PROXY "${config.PROXY}" — не удалось распарсить. Формат: http://user:pass@ip:port`);
            process.exit(1);
        }
    }
    console.log('[✓] Config прошёл валидацию');
}

// ==================== MAIL.TM ====================

async function createTempEmail() {
    console.log('[Почта] Подключаемся к mail.tm...');

    // mail.tm fetch с ретраями (HTTP 429 / 5xx / сетевые ошибки)
    const fetchWithRetry = async (url, init = {}, label = url, maxAttempts = 4) => {
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const res = await fetch(url, init);
                if (res.ok) return res;
                if (res.status === 429 || res.status >= 500) {
                    if (attempt === maxAttempts) throw new Error(`${label}: HTTP ${res.status}`);
                    // Уважаем Retry-After если есть, иначе экспоненциальный бэкофф (5/10/20с)
                    const ra = parseInt(res.headers.get('retry-after') || '', 10);
                    const wait = (Number.isFinite(ra) && ra > 0) ? ra * 1000 : 5000 * Math.pow(2, attempt - 1);
                    console.log(`[Почта] ⚠️  ${label}: HTTP ${res.status} (попытка ${attempt}/${maxAttempts}). Ждём ${Math.round(wait / 1000)}с...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                // Любой другой код — это не транзиентная ошибка, бросаем сразу
                throw new Error(`${label}: HTTP ${res.status}`);
            } catch (e) {
                lastErr = e;
                if (attempt === maxAttempts) throw e;
                // Сетевая ошибка fetch — тоже ретраим
                if (!/HTTP/.test(e.message)) {
                    console.log(`[Почта] ⚠️  ${label}: ${e.message} (попытка ${attempt}/${maxAttempts}). Ждём 5с...`);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }
                throw e;
            }
        }
        throw lastErr;
    };

    const domainsRes = await fetchWithRetry(config.MAIL_API_DOMAINS, {}, 'mail.tm domains');
    const domainsData = await domainsRes.json();
    if (!domainsData['hydra:member']?.length) throw new Error('mail.tm: нет доступных доменов');
    const domain = domainsData['hydra:member'][0].domain;

    const username = 'user_' + randomString(8);
    const emailPassword = 'pass_' + randomString(10);
    const email = `${username}@${domain}`;

    console.log(`[Почта] Создаем ящик: ${email}`);
    await fetchWithRetry(config.MAIL_API_ACCOUNTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: email, password: emailPassword })
    }, 'mail.tm create account');

    const tokenRes = await fetchWithRetry(config.MAIL_API_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: email, password: emailPassword })
    }, 'mail.tm token');
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error('mail.tm: токен не получен');

    console.log('[Почта] ✅ Ящик готов к приему писем');
    return { email, token: tokenData.token, login: username };
}

async function waitForOtpCode(token) {
    const maxAttempts = Math.floor(config.DELAY_OTP_WAIT / 5000);
    console.log(`[Почта] Ждём OTP-код (проверка каждые 5 сек, ${maxAttempts} попыток)...`);

    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 5000));

        const res = await fetch(config.MAIL_API_MESSAGES, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            console.log(`[Почта] ⚠️ HTTP ${res.status} при проверке писем`);
            continue;
        }
        const data = await res.json();
        const messages = data['hydra:member'];

        if (messages && messages.length > 0) {
            // BUG5 FIX: ищем письмо от Devin, не просто первое
            const devinMsg = messages.find(m =>
                (m.from?.address && m.from.address.toLowerCase().includes('devin')) ||
                (m.subject && /devin|verification|confirm|otp|code/i.test(m.subject))
            ) || messages[0];

            console.log(`[Почта] ✅ Письмо получено! (от: ${devinMsg.from?.address || 'unknown'}, тема: ${devinMsg.subject || '—'})`);

            const msgRes = await fetch(`${config.MAIL_API_MESSAGES}/${devinMsg.id}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const msgData = await msgRes.json();

            // BUG3 FIX: сначала ищем код рядом с ключевыми словами, потом fallback
            const contextMatch = msgData.text.match(/(?:code|код|verify|verification|otp|pin)[^\d]{0,30}(\d{6})/i);
            if (contextMatch) {
                console.log(`[Почта] 🎉 Код извлечён (context): ${contextMatch[1]}`);
                return contextMatch[1];
            }

            const fallbackMatch = msgData.text.match(/\b\d{6}\b/);
            if (fallbackMatch) {
                console.log(`[Почта] 🎉 Код извлечён (fallback): ${fallbackMatch[0]}`);
                return fallbackMatch[0];
            }

            // Попробуем HTML-версию если text не помог
            if (msgData.html) {
                const htmlMatch = msgData.html.match(/\b\d{6}\b/);
                if (htmlMatch) {
                    console.log(`[Почта] 🎉 Код извлечён (HTML): ${htmlMatch[0]}`);
                    return htmlMatch[0];
                }
            }

            console.log('[Почта] ⚠️ Код не найден в тексте письма');
            return null;
        }

        process.stdout.write('.');
    }

    console.log('\n[Почта] ❌ Письмо не пришло за отведённое время');
    return null;
}

// ==================== PLAYWRIGHT: ЧЕЛОВЕКОПОДОБНЫЙ ВВОД ====================

async function humanType(page, selector, value, fieldName) {
    for (let retry = 0; retry < 10; retry++) {
        for (const frame of page.frames()) {
            try {
                const loc = frame.locator(selector).first();
                if (await loc.count() > 0 && await loc.isVisible()) {
                    await loc.click();
                    await page.waitForTimeout(300 + randomDelay(0, 400));
                    await loc.pressSequentially(value, { delay: 80 + randomDelay(0, 80) });
                    console.log(`  ✅ ${fieldName}`);
                    return true;
                }
            } catch { }
        }
        await page.waitForTimeout(500);
    }
    console.log(`  ❌ ${fieldName} — поле не найдено`);
    return false;
}

// ==================== ЭКСПОРТ СЕССИИ ====================

function exportToSessionManager(sessionFile, orgName, email, success = true) {
    const manualSessionsDir = 'manual_sessions';
    if (!fs.existsSync(manualSessionsDir)) {
        fs.mkdirSync(manualSessionsDir, { recursive: true });
    }

    // Проверяем, есть ли уже сессия с таким orgName
    const existingSessions = fs.readdirSync(manualSessionsDir)
        .filter(dir => dir.includes(orgName));

    if (existingSessions.length > 0) {
        const existing = existingSessions[0];
        const existingIsError = existing.includes('error');
        const existingIsSuccess = existing.includes('success');
        
        // Если уже есть success сессия - не перезаписываем
        if (existingIsSuccess) {
            console.log(`[Менеджер сессий] ✅ Сессия "${orgName}" уже успешная: ${existing}`);
            return;
        }
        
        // Если есть error сессия и новая тоже error - пропускаем
        if (existingIsError && !success) {
            console.log(`[Менеджер сессий] ⚠️ Сессия "${orgName}" уже с ошибкой: ${existing}`);
            return;
        }
        
        // Если есть error сессия, но новая success - удаляем старую error
        if (existingIsError && success) {
            const oldPath = path.join(manualSessionsDir, existing);
            try {
                fs.rmSync(oldPath, { recursive: true, force: true });
                console.log(`[Менеджер сессий] 🔄 Удалена error-сессия: ${existing}`);
            } catch (e) {
                console.log(`[Менеджер сессий] ⚠️ Не удалось удалить старую сессию: ${e.message}`);
            }
        }
    }

    // Создаём понятное имя для сессии (success/error в имени = статус в менеджере)
    // Время по МСК (UTC+3)
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const timestamp = msk.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const label = success ? 'success' : 'error';
    const sessionName = `${timestamp}-${label}_${orgName}`;
    const sessionDir = path.join(manualSessionsDir, sessionName);

    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Копируем session.json
    const targetSessionFile = path.join(sessionDir, 'session.json');
    fs.copyFileSync(sessionFile, targetSessionFile);

    // Создаём restore_session.js
    const restoreScript = `const { chromium } = require('playwright');
const path = require('path');

async function restoreSession() {
    console.log('🚀 Восстанавливаем сессию: ${sessionName}');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        storageState: '${targetSessionFile}'
    });
    const page = await context.newPage();

    console.log('📂 Открытие https://app.devin.ai/settings/preferences...');
    await page.goto('https://app.devin.ai/settings/preferences', { waitUntil: 'domcontentloaded' });

    console.log('✅ Браузер открыт с сессией!');
    console.log('💡 Закройте браузер вручную когда закончите');
}

restoreSession().catch(console.error);
`;

    fs.writeFileSync(path.join(sessionDir, 'restore_session.js'), restoreScript);

    // Создаём session_info.txt
    const statusLabel = success ? '✅ Оплата прошла' : '❌ Оплата не прошла';
    const info = `URL: https://app.devin.ai/org/${orgName}
Время сохранения: ${new Date(Date.now() + 3 * 60 * 60 * 1000).toLocaleString('ru-RU')}
Email: ${email}
Org: ${orgName}
Статус: ${statusLabel}
Сессия: ${targetSessionFile}
`;
    fs.writeFileSync(path.join(sessionDir, 'session_info.txt'), info);

    const icon = success ? '✅' : '❌';
    console.log(`[Менеджер сессий] ${icon} Сессия добавлена: ${sessionName}`);
    console.log(`[Менеджер сессий] 📂 Открыть через менеджер сессий в меню`);
}

function exportAccount(sessionFile, email, password, orgName, cardUsed, success) {
    const label = success ? 'Pro' : 'Error';
    const baseDir = success ? config.READY_DIR : config.ERROR_DIR;
    const accountDir = makeFolderName(baseDir, label, orgName);

    // Проверяем, есть ли уже папка с таким orgName
    if (fs.existsSync(baseDir)) {
        const existingDirs = fs.readdirSync(baseDir)
            .filter(f => fs.statSync(path.join(baseDir, f)).isDirectory())
            .filter(f => f.includes(orgName));

        if (existingDirs.length > 0) {
            console.log(`[Экспорт] ⚠️ Аккаунт с orgName "${orgName}" уже существует в ${baseDir}: ${existingDirs[0]}`);
            console.log('[Экспорт] Пропускаем создание дубликата');
            return;
        }
    }

    if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });

    const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));

    // ---- cookies.json ----
    const devinCookies = sessionData.cookies.filter(c => c.domain.includes('devin.ai'));
    const cookieFormat = devinCookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain,
        hostOnly: !c.domain.startsWith('.'), path: c.path || '/',
        secure: c.secure || false, httpOnly: c.httpOnly || false,
        sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite || 'lax').toLowerCase(),
        session: c.expires === -1, expirationDate: c.expires === -1 ? undefined : c.expires,
        storeId: '0'
    }));
    fs.writeFileSync(path.join(accountDir, 'cookies.json'), JSON.stringify(cookieFormat, null, 2));

    // ---- localstorage.js ----
    let consoleScript = '// 📋 Вставь это в консоль браузера на странице app.devin.ai\n// (F12 → Console → вставить → Enter)\n\n';

    const devinOrigin = sessionData.origins?.find(o => o.origin === 'https://app.devin.ai');
    if (devinOrigin && devinOrigin.localStorage.length > 0) {
        const importantKeys = ['auth1_session', 'known-org-ids', 'last-internal-org', 'migrated-to-unscoped'];
        const items = devinOrigin.localStorage.filter(item =>
            importantKeys.some(key => item.name.includes(key))
        );

        for (const item of items) {
            // BUG4 FIX: JSON.stringify handles ALL special chars (\n, \r, \t, \, quotes)
            const escaped = JSON.stringify(item.value).slice(1, -1);
            consoleScript += `localStorage.setItem('${item.name}', '${escaped}');\n`;
        }
    }
    consoleScript += `\nconsole.log('✅ localStorage установлен! Перезагрузи страницу (F5)');\n`;
    fs.writeFileSync(path.join(accountDir, 'localstorage.js'), consoleScript);

    // ---- session.json ----
    fs.copyFileSync(sessionFile, path.join(accountDir, 'session.json'));

    // ---- Инструкция_входа.txt (только для успешных) ----
    if (success) {
        const instructions = [
            '🎉 АККАУНТ DEVIN AI — ИНСТРУКЦИЯ ПО ВХОДУ 🎉',
            '',
            '════════════════════════════════════════',
            '  ДАННЫЕ АККАУНТА',
            '════════════════════════════════════════',
            '',
            `  Email:    ${email}`,
            `  Пароль:   ${password}`,
            `  Организация: ${orgName}`,
            `  Карта:    ${cardUsed}`,
            '',
            '  ⚠️ Вход через логин/пароль НЕ работает — используйте сессию ниже!',
            '',
            '════════════════════════════════════════',
            '  ЧТО В ЭТОЙ ПАПКЕ?',
            '════════════════════════════════════════',
            '',
            '  📄 Инструкция_входа.txt  — этот файл (читайте его!)',
            '  📄 cookies.json          — куки для расширения Cookie-Editor',
            '  📄 localstorage.js       — скрипт для вставки localStorage через консоль',
            '  📄 session.json          — полная сессия Playwright (для продвинутых)',
            '',
            '════════════════════════════════════════',
            '  ШАГ 1: ВСТАВКА COOKIES',
            '════════════════════════════════════════',
            '',
            '  1. Установите расширение Cookie-Editor:',
            '     https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm',
            '',
            '  2. Откройте сайт: https://app.devin.ai',
            '',
            '  3. Нажмите на иконку Cookie-Editor в браузере',
            '',
            '  4. Нажмите кнопку Delete All (🗑️) — удалите все текущие куки',
            '',
            '  5. Нажмите кнопку Import (📥)',
            '',
            '  6. Откройте файл cookies.json из этой папки,',
            '     скопируйте ВСЁ содержимое и вставьте в поле импорта.',
            '     Нажмите Import.',
            '',
            '  ✅ Куки установлены!',
            '',
            '════════════════════════════════════════',
            '  ШАГ 2: ВСТАВКА LOCALSTORAGE',
            '════════════════════════════════════════',
            '',
            '  1. Прямо на странице https://app.devin.ai нажмите F12',
            '     (откроется панель разработчика)',
            '',
            '  2. Перейдите во вкладку Console (Консоль)',
            '',
            '  3. Откройте файл localstorage.js из этой папки',
            '',
            '  4. Скопируйте ВСЁ содержимое файла и вставьте в консоль.',
            '     Нажмите Enter.',
            '',
            '  ✅ Вы должны увидеть: "✅ localStorage установлен!"',
            '',
            '════════════════════════════════════════',
            '  ШАГ 3: ЗАВЕРШЕНИЕ',
            '════════════════════════════════════════',
            '',
            '  Перезагрузите страницу (клавиша F5 или Ctrl+R).',
            '',
            '  🎉 Вы успешно вошли в аккаунт Devin AI с подпиской Pro Trial!',
            '',
            '════════════════════════════════════════',
            '  ВОЗМОЖНЫЕ ПРОБЛЕМЫ',
            '════════════════════════════════════════',
            '',
            '  ❌ Не работает вход?',
            '     → Убедитесь, что сначала удалили старые куки (Delete All в Cookie-Editor)',
            '     → Убедитесь, что вставили localStorage ПОСЛЕ cookies',
            '     → Убедитесь, что вы на странице https://app.devin.ai (не на signup)',
            '',
            '  ❌ Сессия истекла?',
            '     → Сессия живёт ограниченное время. Если не работает —',
            '       нужно зарегистрировать новый аккаунт скриптом.',
        ].join('\n');

        fs.writeFileSync(path.join(accountDir, 'Инструкция_входа.txt'), instructions, 'utf-8');
    }

    console.log(`[Экспорт] 📦 Сохранено: ${accountDir}`);
}

// ==================== ОСНОВНОЙ СКРИПТ ====================

// page.goto с ретраями на сетевые ошибки (ERR_CONNECTION_CLOSED, ERR_ABORTED, ERR_TIMED_OUT и пр.)
// Cloudflare/анти-бот часто роняет TCP через 1-2 сек после открытия — ретрай помогает.
async function gotoWithRetry(page, url, opts = {}, maxAttempts = 3, retryDelayMs = 8000) {
    const RETRY_ON = /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_ABORTED|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_REFUSED|net::/;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await page.goto(url, opts);
            return; // успех
        } catch (e) {
            lastErr = e;
            const msg = e.message || '';
            if (!RETRY_ON.test(msg) || attempt === maxAttempts) throw e;
            console.log(`[Браузер] ⚠️  Попытка ${attempt}/${maxAttempts} упала (${msg.split('\n')[0]}). Ретрай через ${retryDelayMs / 1000}с...`);
            await page.waitForTimeout(retryDelayMs);
        }
    }
    throw lastErr;
}

async function registerAccount(accountIndex, binManager) {
    const bin = binManager.getNext(accountIndex);
    console.log(`[BIN] 🎯 Используем BIN: ${bin}`);
    
    // Авто-генерация данных карты
    const expDate = generateExpDate(config.EXP_DATE);
    const cvcCode = generateCVC(config.CVC_CODE, bin);
    const cardLength = getCardLength(bin, config.CARD_LENGTH);
    
    console.log(`[Карта] 📅 Срок: ${expDate} | CVC: ${cvcCode} | Длина: ${cardLength}`);
    
    const { email, token, login } = await createTempEmail();
    const password = config.ACCOUNT_PASSWORD;
    const sessionFile = `devin_session_${login}.json`;

    // Ротация биллинга: выбираем профиль по кругу
    let billingProfile = {
        country: config.BILLING_COUNTRY || 'US',
        address: config.BILLING_ADDRESS || '350 5th Ave',
        city: config.BILLING_CITY || 'New York',
        zip: config.BILLING_ZIP || '10118'
    };
    
    if (config.BILLING_PROFILES && config.BILLING_PROFILES.length > 0) {
        const profileIndex = accountIndex % config.BILLING_PROFILES.length;
        billingProfile = config.BILLING_PROFILES[profileIndex];
        console.log(`[Биллинг] 🌍 Профиль #${profileIndex + 1}: ${billingProfile.country}`);
    }

    console.log(`\n[Браузер] Запускаем Chromium (BIN: ${bin})...`);

    // Если MANUAL_MODE включен, используем headless=false для возможности ручного ввода
    // Если FORCE_HEADLESS_WITH_MANUAL=true, то используем headless даже с MANUAL_MODE
    const useHeadless = config.HEADLESS && (!config.MANUAL_MODE || config.FORCE_HEADLESS_WITH_MANUAL);

    // DEBUG: явно показываем что передаём в chromium.launch
    console.log(`[Браузер] DEBUG: HEADLESS=${config.HEADLESS}, MANUAL_MODE=${config.MANUAL_MODE}, FORCE_HEADLESS_WITH_MANUAL=${config.FORCE_HEADLESS_WITH_MANUAL} → launch headless=${useHeadless}`);

    const launchOptions = {
        headless: useHeadless,
        args: ['--disable-blink-features=AutomationControlled']
    };
    // В видимом режиме явно ставим стартовую позицию и размер окна — на случай если оно открывается за пределами экрана
    if (!useHeadless) {
        launchOptions.args.push('--window-position=100,100', '--window-size=1280,900', '--start-maximized');
    }

    if (config.MANUAL_MODE && config.HEADLESS && !config.FORCE_HEADLESS_WITH_MANUAL) {
        console.log('[Браузер] ⚠️ MANUAL_MODE включён — используем headless=false для ручного ввода');
    }

    if (config.MANUAL_MODE && config.HEADLESS && config.FORCE_HEADLESS_WITH_MANUAL) {
        console.log('[Браузер] ⚠️ MANUAL_MODE включён с FORCE_HEADLESS_WITH_MANUAL=true — ручной ввод невозможен!');
    }

    const proxyConfig = parseProxy(config.PROXY);
    if (proxyConfig) {
        launchOptions.proxy = proxyConfig;
        console.log(`[Прокси] ✅ Подключен: ${proxyConfig.server}`);
    } else {
        console.log('[Прокси] Без прокси — прямой запуск');
    }

    const browser = await chromium.launch(launchOptions);

    // Определяем timezone и locale
    const tzLocale = config.BILLING_ROTATION ? getTzLocaleForCountry(billingProfile.country) : null;
    const timezoneId = tzLocale ? tzLocale.timezone : (config.TIMEZONE || 'America/New_York');
    const locale = tzLocale ? tzLocale.locale : (config.LOCALE || 'en-US');
    
    if (config.BILLING_ROTATION) {
        console.log(`[Браузер] 🌍 Ротация: ${billingProfile.country} → TZ=${timezoneId}, locale=${locale}`);
    }

    const context = await browser.newContext({
        timezoneId,
        locale
    });
    const page = await context.newPage();

    // Stealth
    if (config.STEALTH_ENABLED) {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = { runtime: {}, loadTimes: function () { }, csi: function () { } };
            delete window.RTCPeerConnection;
            delete window.mozRTCPeerConnection;
            delete window.webkitRTCPeerConnection;
        });
    }

    let orgName = login.replace(/_/g, '-');
    let cardUsed = '';

    try {
        // ---- РЕГИСТРАЦИЯ ----
        console.log('[Браузер] Переходим на страницу регистрации...');
        await page.goto('https://app.devin.ai/auth/signup', { waitUntil: 'domcontentloaded', timeout: 120000 });

        await page.waitForTimeout(1000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(700);

        console.log('[Браузер] Вводим Email...');
        await page.fill("input[placeholder='Email address']", email);

        console.log('[Браузер] Нажимаем Sign up...');
        await page.click('button:has-text("Sign up")');

        // ---- OTP-КОД ----
        const code = await waitForOtpCode(token);
        if (!code) throw new Error('Не получили OTP-код');

        console.log('[Браузер] Вводим код...');
        await page.waitForTimeout(2500);
        await page.locator('input').first().fill(code);

        try {
            await page.click('button:has-text("Continue")', { timeout: 3000 });
        } catch {
            console.log('[Браузер] Continue не найден — код отправился автоматически');
        }

        await page.waitForTimeout(config.DELAY_AFTER_CODE_INPUT);

        console.log(`[Браузер] 💾 Сохраняем сессию: ${sessionFile}`);
        await context.storageState({ path: sessionFile });

        // ---- ОПРЕДЕЛЯЕМ ORG ----
        const orgMatch = page.url().match(/\/org\/([^\/]+)/);
        if (orgMatch) orgName = orgMatch[1];

        // ---- ТРИАЛ PRO ($20) ----
        console.log(`[Браузер] Переходим к тарифам (org: ${orgName})...`);
        await page.goto(`https://app.devin.ai/org/${orgName}/plans`, { waitUntil: 'domcontentloaded', timeout: 120000 });

        try {
            await page.waitForSelector('button', { timeout: 30000 });
            await page.waitForTimeout(3000);
        } catch {
            console.log('[Браузер] Кнопки не появились, ждём ещё...');
            await page.waitForTimeout(6000);
        }

        const trialBtn = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const trialBtns = buttons.filter(b => /start free trial/i.test(b.innerText));

            for (const btn of trialBtns) {
                let el = btn;
                for (let i = 0; i < 10 && el; i++) {
                    el = el.parentElement;
                    if (!el) break;
                    const text = el.innerText || '';
                    if (/\$20[^0-9]/.test(text) || /\$20$/.test(text) || /20\/mo/i.test(text)) {
                        btn.scrollIntoView({ block: 'center' });
                        const rect = btn.getBoundingClientRect();
                        return { ok: true, text: btn.innerText.trim().slice(0, 40), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                    }
                }
            }

            if (trialBtns.length > 0) {
                return { ok: false, count: trialBtns.length };
            }
            return { ok: false, count: 0 };
        });

        if (trialBtn && trialBtn.ok) {
            console.log(`[Браузер] ✅ Найдена кнопка: "${trialBtn.text}"`);
            const [delayMin, delayMax] = config.DELAY_BEFORE_TRIAL_CLICK;
            await page.waitForTimeout(randomDelay(delayMin, delayMax));
            try {
                await page.mouse.move(trialBtn.x, trialBtn.y, { steps: 25 });
                await page.waitForTimeout(1000 + randomDelay(0, 1000));
                await page.mouse.click(trialBtn.x, trialBtn.y);
            } catch {
                console.log('[Браузер] Клик мышью не удался — кликаем через JS');
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const tb = btns.filter(b => /start free trial/i.test(b.innerText));
                    if (tb.length > 0) tb[tb.length - 1].click();
                });
            }
            console.log('[Браузер] ✅ Триал нажат!');
        } else {
            console.log(`[Браузер] ⚠️ Кнопка $20 не найдена`);
            throw new Error('Кнопка триала за $20 не найдена');
        }

        // ---- STRIPE CHECKOUT ----
        console.log('[Браузер] Ждём загрузку Stripe...');
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 90000, waitUntil: 'domcontentloaded' });
        console.log('[Браузер] ✅ Stripe загружен!');

        try { await page.waitForSelector('input[value="card"]', { timeout: 60000 }); } catch { }
        await page.waitForTimeout(2500);

        try {
            for (const cb of await page.locator('input[type="checkbox"]').all()) {
                if (await cb.isChecked()) await cb.uncheck({ force: true });
            }
        } catch { }
        await page.waitForTimeout(500);

        // Кликаем "Карта"
        console.log('[Браузер] Выбираем "Карта"...');
        const cardRadio = await page.evaluate(() => {
            const radio = document.querySelector('input[value="card"]');
            if (!radio) return null;
            const target = radio.closest('label') || radio.parentElement;
            const rect = target.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        if (cardRadio) {
            await page.mouse.move(cardRadio.x, cardRadio.y, { steps: 10 });
            await page.waitForTimeout(500);
            await page.mouse.click(cardRadio.x, cardRadio.y);
        }
        await page.waitForTimeout(2500);

        // ---- ВВОД ДАННЫХ КАРТЫ ----
        cardUsed = generateLuhnCard(bin);
        console.log(`[Браузер] Карта: ${cardUsed} (BIN: ${bin})`);

        console.log('[Браузер] Вводим данные карты...');
        await humanType(page, '#cardNumber, #Field-numberInput, input[autocomplete="cc-number"], input[name="cardNumber"], input[name="cardnumber"]', cardUsed, 'Номер карты');
        await page.waitForTimeout(randomDelay(1000, 2500));

        await humanType(page, '#cardExpiry, #Field-expiryInput, input[autocomplete="cc-exp"], input[name="cardExpiry"], input[name="exp-date"]', expDate, 'Срок действия');
        await page.waitForTimeout(randomDelay(800, 2000));

        await humanType(page, '#cardCvc, #Field-cvcInput, input[autocomplete="cc-csc"], input[name="cardCvc"], input[name="cvc"]', cvcCode, 'CVC');
        await page.waitForTimeout(randomDelay(1000, 2500));

        await humanType(page, '#billingName, #Field-nameInput, input[autocomplete="name"], input[name="billingName"]', config.BILLING_NAME, 'Имя владельца');
        await page.waitForTimeout(randomDelay(1500, 3500));

        // Страна
        console.log(`[Браузер] Страна → ${billingProfile.country}...`);
        try {
            await page.locator('#billingCountry, select[name="billingCountry"], select[autocomplete="country"]').first().selectOption(billingProfile.country, { timeout: 3000 });
            await page.waitForTimeout(randomDelay(1500, 2500));
        } catch { }

        // Адрес
        console.log('[Браузер] Заполняем адрес...');
        try { await page.locator('text=/Enter address manually/i').first().click({ timeout: 2000 }); } catch { }
        await page.waitForTimeout(randomDelay(500, 1000));

        await humanType(page, '#billingAddressLine1, #Field-addressLine1Input, input[autocomplete="address-line1"], input[name="billingAddressLine1"]', billingProfile.address, 'Адрес');
        await page.waitForTimeout(1000);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(randomDelay(1000, 2000));

        await humanType(page, '#billingLocality, #Field-localityInput, input[autocomplete="address-level2"], input[name="billingLocality"]', billingProfile.city, 'Город');
        await page.waitForTimeout(randomDelay(800, 1800));

        await humanType(page, '#billingPostalCode, #Field-postalCodeInput, input[autocomplete="postal-code"], input[name="billingPostalCode"]', billingProfile.zip, 'Индекс');
        await page.waitForTimeout(randomDelay(1500, 2500));

        // Чекбоксы
        console.log('[Браузер] Настраиваем чекбоксы...');
        try {
            const firstCb = page.locator('input[type="checkbox"]').first();
            if (await firstCb.isChecked()) await firstCb.uncheck({ force: true });
        } catch { }

        try {
            await page.locator('text=/I agree/i').first().click({ timeout: 3000 });
        } catch {
            try { await page.locator('input[type="checkbox"]').last().check({ force: true }); } catch { }
        }

        await page.waitForTimeout(randomDelay(3000, 6000));

        // ---- ОТПРАВКА ОПЛАТЫ ----
        console.log('[Браузер] Нажимаем "Начать пробное использование"...');
        const submitBtn = await page.evaluate(() => {
            const btn = document.querySelector('button.SubmitButton') || document.querySelector('[data-testid="hosted-payment-submit-button"]');
            if (!btn) return null;
            btn.scrollIntoView({ block: 'center' });
            const rect = btn.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });

        if (submitBtn) {
            await page.mouse.move(submitBtn.x, submitBtn.y, { steps: 10 });
            await page.waitForTimeout(500);
            await page.mouse.click(submitBtn.x, submitBtn.y);
            console.log('[Браузер] ✅ Кнопка нажата!');
        }

        // ---- hCAPTCHA ----
        console.log('[Браузер] 🔐 Проверяем капчу...');
        await page.waitForTimeout(3000);
        let captchaSolved = false;
        let captchaWindowBrought = false;

        // Разворачивает окно браузера на передний план
        // 1) page.bringToFront() — поднимает таб
        // 2) CDP setWindowBounds — снимает minimized
        // 3) Windows: PowerShell + Win32 SetForegroundWindow с Alt-trick — вытягивает окно ПОВЕРХ всех
        const bringBrowserToFront = async () => {
            try { await page.bringToFront(); } catch {}
            try {
                const cdp = await browser.newBrowserCDPSession();
                const { windowId } = await cdp.send('Browser.getWindowForTarget');
                await cdp.send('Browser.setWindowBounds', {
                    windowId,
                    bounds: { windowState: 'normal' }
                });
                await cdp.detach();
            } catch { /* не критично */ }

            if (process.platform === 'win32') {
                try {
                    const browserPid = browser.process()?.pid;
                    if (!browserPid) return;
                    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int n);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$rootPid = ${browserPid}
function Get-Descendants($parentId) {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentId"
    $all = @()
    foreach ($c in $children) {
        $all += $c.ProcessId
        $all += Get-Descendants $c.ProcessId
    }
    return $all
}
$pids = @($rootPid) + (Get-Descendants $rootPid)
$proc = Get-Process | Where-Object { $pids -contains $_.Id -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($proc) {
    # Alt-trick для обхода ограничения SetForegroundWindow
    [Win]::keybd_event(0xA4, 0, 0, [UIntPtr]::Zero)
    [Win]::ShowWindowAsync($proc.MainWindowHandle, 9)
    [Win]::SetForegroundWindow($proc.MainWindowHandle)
    [Win]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero)
}
`;
                    // PowerShell -EncodedCommand требует UTF-16 LE base64
                    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
                    const { spawn } = require('child_process');
                    spawn('powershell.exe',
                        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
                        { detached: true, stdio: 'ignore', windowsHide: true }
                    ).unref();
                } catch { /* не критично */ }
            }
        };

        if (config.MANUAL_MODE && config.CAPTCHA_NOTIFICATIONS) {
            console.log('[Браузер] ⚠️ MANUAL_MODE: Если появится капча — решите её вручную в браузере!');
            console.log('[Браузер] 💡 Скрипт продолжится автоматически после решения капчи');
        }

        for (let i = 0; i < 15; i++) {
            for (const frame of page.frames()) {
                const url = frame.url();
                if (url.includes('hcaptcha') && url.includes('checkbox') && !url.includes('invisible')) {
                    // Капча обнаружена — разворачиваем окно один раз
                    if (!captchaWindowBrought) {
                        console.log('[Браузер] 🔐 Капча обнаружена — разворачиваем окно...');
                        captchaWindowBrought = true;
                        bringBrowserToFront();
                        await playSound('captcha');
                    }
                    try {
                        await frame.locator('#checkbox').click({ timeout: 3000 });
                        console.log('[Браузер] ✅ Капча решена автоматически!');
                        await playSound('captcha_solved'); // Звук решения капчи
                        captchaSolved = true;
                    } catch { }
                }
            }
            if (captchaSolved) break;

            if (!page.url().includes('checkout.stripe.com')) {
                console.log('[Браузер] 🎉 Оплата прошла без капчи!');
                break;
            }

            // Каждые 3 попытки показываем прогресс
            if (i > 0 && i % 3 === 0) {
                console.log(`[Браузер] 🔐 Капча: попытка ${i + 1}/15...`);
            }

            await page.waitForTimeout(2000);
        }

        if (captchaSolved) {
            console.log('[Браузер] Ждём обработку платежа...');
            await page.waitForTimeout(5000);
        } else {
            console.log('[Браузер] ⚠️ Капча не решена автоматически — продолжаем без решения');
            if (config.MANUAL_MODE && config.CAPTCHA_NOTIFICATIONS && !captchaWindowBrought) {
                console.log('[Браузер] 💡 MANUAL_MODE: Если капча появилась — решите её вручную сейчас!');
                // Звук уже сыграл при обнаружении капчи — не дублируем
            }
        }

        // ---- ОЖИДАНИЕ ПОДТВЕРЖДЕНИЯ ----
        console.log(`[Браузер] Ожидаем подтверждение (до ${config.DELAY_PAYMENT_WAIT / 1000} сек)...`);
        let paymentConfirmed = false;
        const deadline = Date.now() + config.DELAY_PAYMENT_WAIT;

        while (Date.now() < deadline) {
            await page.waitForTimeout(3000);
            const curUrl = page.url();

            if (!curUrl.includes('checkout.stripe.com')) {
                console.log(`[Браузер] 🎉 Оплата подтверждена!`);
                await playSound('payment_success'); // Звук успешной оплаты
                binManager.markGood(bin); // Отмечаем BIN как рабочий
                paymentConfirmed = true;
                // Сохраняем сессию сразу после оплаты — до любых дальнейших шагов
                // Защита от Ctrl+C: если скрипт прервут, сессия уже будет в менеджере со статусом success
                try {
                    await context.storageState({ path: sessionFile });
                    if (config.AUTO_ADD_TO_SESSION_MANAGER) {
                        exportToSessionManager(sessionFile, orgName, email, true);
                    }
                } catch (e) { /* не критично, сохранится снова в конце */ }
                break;
            }

            try {
                const bodyText = await page.locator('body').innerText({ timeout: 1000 });
                if (/declined|insufficient|не принята|отклонена/i.test(bodyText)) {
                    const errorText = await page.evaluate(() => {
                        const alerts = document.querySelectorAll('[role="alert"], .Error, .FieldError, .Banner--error, [class*="error"], [class*="Error"]');
                        return Array.from(alerts).map(el => el.innerText.trim()).filter(t => t.length > 0 && t.length < 200).join(' | ') || 'Текст ошибки не найден';
                    });
                    console.log(`[Браузер] ❌ Карта отклонена: ${errorText}`);
                    binManager.markBad(bin); // Отмечаем BIN как нерабочий
                    await playSound('error'); // Звук ошибки

                    // MANUAL_MODE: ждём ручного ввода вместо завершения
                    if (config.MANUAL_MODE) {
                        console.log('[Ручной режим] ⏸️ Ожидаем ручного ввода данных карты...');
                        console.log('[Ручной режим] 💡 Введите данные карты вручную и нажмите "Начать пробное использование"');
                        if (config.CAPTCHA_NOTIFICATIONS) {
                            console.log('[Ручной режим] 💡 Если появится капча — решите её вручную!');
                        }
                        console.log('[Ручной режим] 💡 Скрипт продолжится автоматически после успешной оплаты');
                        console.log('[Ручной режим] 💡 Нажмите Ctrl+C в терминале для принудительной остановки');
                        bringBrowserToFront(); // выводим окно поверх всех
                        await playSound('manual'); // Звук для ручного режима

                        // Ждём пока пользователь вручную завершит оплату или перейдёт с checkout.stripe.com
                        let manualPaymentSuccess = false;
                        const manualDeadline = Date.now() + (10 * 60 * 1000); // 10 минут на ручной ввод

                        while (Date.now() < manualDeadline) {
                            await page.waitForTimeout(2000);
                            const currentUrl = page.url();

                            // Если ушли с checkout.stripe.com - значит оплата прошла
                            if (!currentUrl.includes('checkout.stripe.com')) {
                                console.log('[Ручной режим] ✅ Оплата прошла вручную!');
                                binManager.markGood(bin); // Отмечаем BIN как рабочий
                                await playSound('payment_success'); // Звук успешной оплаты
                                manualPaymentSuccess = true;
                                paymentConfirmed = true;
                                break;
                            }

                            // Проверяем, нет ли ошибки на странице
                            try {
                                const manualBodyText = await page.locator('body').innerText({ timeout: 500 });
                                if (/declined|insufficient|не принята|отклонена/i.test(manualBodyText)) {
                                    console.log('[Ручной режим] ⚠️ Всё ещё ошибка - попробуйте другие данные карты');
                                }
                            } catch { }

                            process.stdout.write('.');
                        }

                        if (manualPaymentSuccess) {
                            console.log('\n[Ручной режим] 🎉 Продолжаем скрипт...');
                            break; // выходим из цикла ожидания, продолжаем скрипт
                        } else {
                            console.log('\n[Ручной режим] ⏰ Время ручного ввода истекло');
                            break;
                        }
                    } else {
                        break; // обычный режим - завершаем
                    }
                }
            } catch { }

            process.stdout.write('.');
        }

        // ---- ВЕРИФИКАЦИЯ ТРИАЛА ----
        if (paymentConfirmed) {
            console.log('[Проверка] Ждём редирект...');
            await page.waitForTimeout(3000);

            console.log('[Проверка] Проверяем статус плана...');
            await page.goto(`https://app.devin.ai/org/${orgName}/plans`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(3000);

            const isTrialActive = await page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return text.includes('current plan') || !/start free trial/i.test(text);
            });

            if (!isTrialActive) {
                console.log('[Проверка] ❌ План не обновился!');
                paymentConfirmed = false;
            } else {
                console.log('[Проверка] ✅ Триал верифицирован!');
            }
        }

        // ---- СОХРАНЕНИЕ ----
        const status = paymentConfirmed ? '✅ READY' : '⚠️ error';

        await context.storageState({ path: sessionFile });
        exportAccount(sessionFile, email, password, orgName, cardUsed, paymentConfirmed);

        // Добавляем в менеджер сессий если включено в config (и успех, и ошибка)
        if (config.AUTO_ADD_TO_SESSION_MANAGER) {
            exportToSessionManager(sessionFile, orgName, email, paymentConfirmed);
        }

        fs.appendFileSync(config.ACCOUNTS_FILE, `${email}:${password} | org: ${orgName} | card: ${cardUsed} | ${status}\n`);
        console.log(`\n✅ Аккаунт #${accountIndex + 1} — Статус: ${status}`);

        if (paymentConfirmed) {
            await playSound('account_complete'); // Звук завершения аккаунта
        }

        // Удаляем временный sessionFile после всех операций
        try { fs.unlinkSync(sessionFile); } catch { }

        return paymentConfirmed;

    } catch (error) {
        console.error(`\n[Ошибка]: ${error.message}`);
        try { console.log(`[Браузер] URL: ${page.url()}`); } catch { }

        // BUG1 FIX: пытаемся сохранить partial session даже при ошибке
        try {
            await context.storageState({ path: sessionFile });
            if (fs.existsSync(sessionFile)) {
                exportAccount(sessionFile, email, password, orgName, cardUsed || 'N/A', false);
                if (config.AUTO_ADD_TO_SESSION_MANAGER) {
                    exportToSessionManager(sessionFile, orgName, email, false);
                }
            }
        } catch (e) {
            console.log(`[Экспорт] ⚠️ Не удалось экспортировать при ошибке: ${e.message}`);
            // Удаляем sessionFile если он остался в корне
            try { fs.unlinkSync(sessionFile); } catch { }
        }

        fs.appendFileSync(config.ACCOUNTS_FILE, `${email}:${password} | org: ${orgName} | ❌ CRASH: ${error.message.slice(0, 80)}\n`);

        // В ручном режиме не закрываем браузер при ошибке
        if (config.MANUAL_MODE) {
            console.log('[Ручной режим] ⚠️ Браузер остаётся открытым для сохранения сессии');
            console.log('[Ручной режим] 💡 Сохраните сессию вручную через консоль (F12)');
            console.log('[Ручной режим] 💡 Нажмите Ctrl+C в терминале для закрытия');
            console.log('\n' + '='.repeat(60));
            console.log('📋 СКРИПТ ДЛЯ СОХРАНЕНИЯ СЕССИИ (вставьте в консоль браузера):');
            console.log('='.repeat(60));
            console.log(generateSessionExportScript());
            console.log('='.repeat(60));
            return false;
        }

        return false;
    }

    // Закрываем браузер только если не включён KEEP_BROWSER_OPEN
    if (!config.KEEP_BROWSER_OPEN) {
        await browser.close();
    } else {
        console.log('[Браузер] 🔓 Оставляем браузер открытым (KEEP_BROWSER_OPEN=true)');
        console.log('[Браузер] 💡 Закройте его вручную или нажмите Ctrl+C в терминале');
        console.log('\n' + '='.repeat(60));
        console.log('📋 СКРИПТ ДЛЯ СОХРАНЕНИЯ СЕССИИ (вставьте в консоль браузера):');
        console.log('='.repeat(60));
        console.log(generateSessionExportScript());
        console.log('='.repeat(60));
    }

    return true; // Успешное завершение регистрации
}

// ==================== ЗАПУСК ====================

(async () => {
    validateConfig();

    const count = config.ACCOUNTS_COUNT === 0 ? Infinity : config.ACCOUNTS_COUNT;
    let successCount = 0;
    let failCount = 0;

    console.log('════════════════════════════════════════');
    console.log('  DEVIN.AI AUTOREG');
    console.log('════════════════════════════════════════');
    console.log(`  BIN: ${Array.isArray(config.BINS) ? config.BINS.join(', ') : config.BINS}`);
    console.log(`  Прокси: ${config.PROXY || 'без прокси'}`);
    console.log(`  Количество: ${config.ACCOUNTS_COUNT === 0 ? '∞ (Ctrl+C для остановки)' : config.ACCOUNTS_COUNT}`);
    console.log(`  Headless: ${config.HEADLESS}`);
    console.log(`  Stealth: ${config.STEALTH_ENABLED ? 'вкл' : 'выкл'}`);
    console.log('════════════════════════════════════════\n');

    // ========================================
    // ФИНАЛЬНАЯ СТАДИЯ БАГ FIX - Ctrl+C
    // ========================================
    // ЗАКОММЕНТИРОВАНО: Обработчик SIGINT удалён, чтобы Ctrl+C корректно возвращал в меню
    // Авторегер теперь не перехватывает Ctrl+C - это обрабатывается меню через noop handler
    // Это финальное исправление проблемы с состоянием терминала после выхода из авторегера
    
    // // BUG9 FIX: graceful shutdown по Ctrl+C
    // let shutdownRequested = false;
    // process.on('SIGINT', () => {
    //     if (shutdownRequested) process.exit(1); // двойной Ctrl+C — принудительно
    //     console.log('\n[!] Ctrl+C — завершаем текущий аккаунт и останавливаем...');
    //     shutdownRequested = true;
    // });

    // Инициализация BinManager для статистики рабочих/нерабочих BIN-ов
    const binManager = new BinManager();
    console.log('[BIN] 📊 Статистика BIN-ов загружена');
    const stats = binManager.getStats();
    console.log(`[BIN]    Всего: ${stats.total} | ✅ Рабочих: ${stats.known_good} | ❌ Нерабочих: ${stats.known_bad} | ⏳ На cooldown: ${stats.on_cooldown}`);

    for (let i = 0; i < count; i++) {
        // // if (shutdownRequested) {
        // //     console.log('[!] Остановка по запросу пользователя');
        // //     break;
        // // }
        const result = await registerAccount(i, binManager);
        if (result) successCount++;
        else failCount++;

        console.log(`\n📊 Итого: ✅ ${successCount} успешных | ❌ ${failCount} неудачных`);

        // if (i < count - 1 && !shutdownRequested) {
        if (i < count - 1) {
            console.log('⏳ Пауза 5 сек перед следующим аккаунтом...\n');
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    console.log('\n════════════════════════════════════════');
    console.log(`  ФИНАЛ: ✅ ${successCount} | ❌ ${failCount}`);
    console.log('════════════════════════════════════════');
})();
