/**
 * Devin AI Autoreger v5.0
 *
 * Архитектура:
 *   1. Утилиты (fetchWithTimeout, Luhn, getDelay, sleep, normalizeMailProvider, sanitizeFilePart)
 *   2. Logger — консоль + файл + JSONL + LOG_LEVEL
 *   3. BinManager — ротация, статистика, cooldown, analytics
 *   4. ProxyManager — список и ротация прокси (IPv6 support)
 *   5. MailProvider — абстракция почты (mail.tm / temp.coda.ink)
 *   6. Browser automation — humanType, stealth, screenshots, HTML dump
 *   7. Export — cookies, localStorage, инструкция
 *   8. registerAccount — основной поток (structured result: {success, category, retryable})
 *   9. Main loop — smart retry, progress, graceful shutdown
 *  10. Doctor mode — полная диагностика компонентов
 *
 * Изменения v5.0:
 *   - Структура output/: Аккаунты/, Ошибки/, Логи/, Данные/, Архив/
 *   - Оптимизированные тайминги (быстрее, но без триггера детекции)
 *   - CLI аргументы: --config, --count, --doctor, --dry-run
 *   - Прогресс [N/M], цветной статус-бар
 *   - Auto-retry для mail.tm на 429
 *   - Очистка сессионных файлов при запуске
 *   - Убраны хардкод BIN/API-ключи
 *   - Упрощён sleep(), улучшены сообщения об ошибках
 *   - Санитизация путей в инструкции экспорта
 *   - Приоритет конфига: --config → AUTOREGER_RUNTIME_CONFIG → config.js
 *   - normalizeMailProvider() — единая функция для алиасов
 *   - sanitizeFilePart() — защита от невалидных имён папок
 *   - Structured result: {success, category, retryable} вместо boolean
 *   - Smart retry: PAYMENT_ERROR не ретраится, BROWSER/MAIL/TIMEOUT — ретраится
 *   - BIN cooldown: пауза для BIN после 3+ fail подряд
 *   - LOG_LEVEL: quiet/normal/debug
 *   - JSONL structured log (events.jsonl)
 *   - Doctor mode (--doctor): диагностика всех компонентов
 *   - Dry-run mode (--dry-run): пройти до оплаты без реального платежа
 *   - HTML dump при ошибке (SAVE_HTML_ON_ERROR)
 *   - SAVE_PASSWORDS_IN_LOG: опция скрыть пароль в accounts.txt
 *   - MAX_ACCOUNTS_AGE_DAYS: авто-очистка старых аккаунтов
 *   - API-ключ сохраняется только в os.tmpdir(), auto-cleanup при выходе
 *   - Proxy parser: поддержка IPv6 ([2001:db8::1]:port)
 *   - healthCheck: любой HTTP < 500 = API reachable
 *   - mail.tm detail-fetch: проверка msgRes.ok перед .json()
 *   - Summary: пароль и API-ключ маскируются
 *   - selectFromList: guard на empty items + resize handler
 *   - Preset manager: сохранение/загрузка конфиг-пресетов
 *   - package-lock.json включён в bat, npm ci --omit=dev
 *   - Bat: version-based dependency refresh + real Chromium check
 *
 * Автор: @qlevis (Telegram)
 * Спасибо за вдохновение: @abuz_ai (Telegram)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;
console.debug = noop;

// ==================== CLI АРГУМЕНТЫ ====================

/** Парсинг CLI аргументов */
function parseCliArgs() {
    const args = process.argv.slice(2);
    const result = { configPath: null, countOverride: null, doctor: false, dryRun: false, validateBins: null, fingerprintRotation: null, billingRotation: null };

    for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
            result.configPath = args[i + 1];
            i++;
        } else if ((args[i] === '--count' || args[i] === '-n') && args[i + 1]) {
            const n = parseInt(args[i + 1], 10);
            if (n > 0) result.countOverride = n;
            else console.warn(`[!] --count: "${args[i + 1]}" — должно быть > 0`);
            i++;
        } else if (args[i] === '--doctor' || args[i] === '-d') {
            result.doctor = true;
        } else if (args[i] === '--dry-run') {
            result.dryRun = true;
        } else if (args[i] === '--validate-bins') {
            result.validateBins = true;
        } else if (args[i] === '--no-validate-bins') {
            result.validateBins = false;
        } else if (args[i] === '--fingerprint-rotation') {
            result.fingerprintRotation = true;
        } else if (args[i] === '--no-fingerprint-rotation') {
            result.fingerprintRotation = false;
        } else if (args[i] === '--billing-rotation') {
            result.billingRotation = true;
        } else if (args[i] === '--no-billing-rotation') {
            result.billingRotation = false;
        } else if (args[i] === '--help' || args[i] === '-h') {
            console.log('Devin AI Autoreger v5.0 — CLI аргументы:');
            console.log('  --config, -c <path>           Путь к пользовательскому конфиг-файлу');
            console.log('  --count, -n <N>               Переопределить ACCOUNTS_COUNT');
            console.log('  --doctor, -d                  Проверить все компоненты и выйти');
            console.log('  --dry-run                     Пройти до оплаты без реального платежа');
            console.log('  --validate-bins               Проверить BIN-ы перед запуском');
            console.log('  --no-validate-bins            Пропустить проверку BIN-ов');
            console.log('  --fingerprint-rotation        Ротация GPU/viewport на каждый аккаунт');
            console.log('  --no-fingerprint-rotation     Отключить ротацию fingerprint');
            console.log('  --billing-rotation            Ротация timezone/locale по стране биллинга');
            console.log('  --no-billing-rotation         Отключить ротацию биллинга');
            console.log('  --version, -v                 Показать версию');
            console.log('  --help, -h                    Эта справка');
            process.exit(0);
        } else if (args[i] === '--version' || args[i] === '-v') {
            try {
                const pkg = require('../package.json');
                console.log(`Devin AI Autoreger v${pkg.version}`);
            } catch {
                console.log('Devin AI Autoreger v5.0');
            }
            process.exit(0);
        }
    }

    return result;
}

const cliArgs = parseCliArgs();

// ==================== ЗАГРУЗКА КОНФИГА ====================

// Приоритет:
//   1. --config <path> (CLI)
//   2. AUTOREGER_RUNTIME_CONFIG (env var → JSON файл, обычно из start.js)
//   3. config.js
let config;

if (cliArgs.configPath) {
    try {
        const resolvedPath = path.resolve(cliArgs.configPath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`Конфиг-файл не найден: ${resolvedPath}`);
        }
        if (resolvedPath.endsWith('.json')) {
            config = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
        } else {
            config = require(resolvedPath);
        }
    } catch (e) {
        console.error(`[!] ОШИБКА загрузки --config: ${e.message}`);
        process.exit(1);
    }
} else if (process.env.AUTOREGER_RUNTIME_CONFIG) {
    try {
        const runtimePath = path.resolve(process.env.AUTOREGER_RUNTIME_CONFIG);
        config = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    } catch (e) {
        console.error(`[!] ОШИБКА загрузки AUTOREGER_RUNTIME_CONFIG: ${e.message}`);
        process.exit(1);
    }
} else {
    try {
        config = require('../config');
    } catch (e) {
        console.error('[!] Не найден config.js. Запустите: node start.js');
        process.exit(1);
    }
}

if (cliArgs.countOverride !== null) {
    config.ACCOUNTS_COUNT = cliArgs.countOverride;
}

if (cliArgs.fingerprintRotation !== null) {
    config.FINGERPRINT_ROTATION = cliArgs.fingerprintRotation;
}

if (cliArgs.billingRotation !== null) {
    config.BILLING_ROTATION = cliArgs.billingRotation;
}

// ==================== СТАНДАРТНЫЕ ПУТИ OUTPUT ====================

config.READY_DIR        = Object.prototype.hasOwnProperty.call(config, 'READY_DIR') ? config.READY_DIR : 'output/Аккаунты';
config.ERROR_DIR        = Object.prototype.hasOwnProperty.call(config, 'ERROR_DIR') ? config.ERROR_DIR : 'output/Ошибки';
config.ARCHIVE_DIR      = Object.prototype.hasOwnProperty.call(config, 'ARCHIVE_DIR') ? config.ARCHIVE_DIR : 'output/Архив';
config.LOG_FILE         = Object.prototype.hasOwnProperty.call(config, 'LOG_FILE') ? config.LOG_FILE : 'output/Логи/autoreger.log';
config.ACCOUNTS_FILE    = Object.prototype.hasOwnProperty.call(config, 'ACCOUNTS_FILE') ? config.ACCOUNTS_FILE : 'output/Данные/accounts.txt';
config.KNOWN_BINS_FILE  = Object.prototype.hasOwnProperty.call(config, 'KNOWN_BINS_FILE') ? config.KNOWN_BINS_FILE : 'output/Данные/known_bins.json';
config.TIMING_PROFILE_FILE = Object.prototype.hasOwnProperty.call(config, 'TIMING_PROFILE_FILE') ? config.TIMING_PROFILE_FILE : 'output/Данные/timing_profile.json';

config.MAIL_API_DOMAINS  = config.MAIL_API_DOMAINS  ?? 'https://api.mail.tm/domains';
config.MAIL_API_ACCOUNTS = config.MAIL_API_ACCOUNTS ?? 'https://api.mail.tm/accounts';
config.MAIL_API_TOKEN    = config.MAIL_API_TOKEN    ?? 'https://api.mail.tm/token';
config.MAIL_API_MESSAGES = config.MAIL_API_MESSAGES ?? 'https://api.mail.tm/messages';
config.CODA_API_BASE     = config.CODA_API_BASE     ?? 'https://temp.coda.ink/v1';

config.BIN_MAX_RETRIES          = config.BIN_MAX_RETRIES          ?? 10;
config.MAIL_RETRY_COUNT         = config.MAIL_RETRY_COUNT         ?? 3;
config.MAIL_RETRY_DELAY         = config.MAIL_RETRY_DELAY         ?? 3000;
config.MAIL_TIMEOUT             = config.MAIL_TIMEOUT             ?? 30000;
config.HCAPTCHA_MAX_ATTEMPTS    = config.HCAPTCHA_MAX_ATTEMPTS    ?? 15;
config.HCAPTCHA_CHECK_INTERVAL  = config.HCAPTCHA_CHECK_INTERVAL  ?? 2000;
config.WEBHOOK_TIMEOUT          = config.WEBHOOK_TIMEOUT          ?? 10000;
config.RETRY_ON_CRASH_MAX       = config.RETRY_ON_CRASH_MAX       ?? 1;
config.CARD_LENGTH              = config.CARD_LENGTH              ?? 'auto';
config.EXP_DATE                 = config.EXP_DATE                 ?? 'auto';
config.CVC_CODE                 = config.CVC_CODE                 ?? 'auto';
config.FINGERPRINT_ROTATION     = config.FINGERPRINT_ROTATION     ?? true;
config.BILLING_ROTATION         = config.BILLING_ROTATION         ?? true;
config.CONCURRENT_ACCOUNTS      = config.CONCURRENT_ACCOUNTS      ?? 1;
config.VALIDATE_BINS            = config.VALIDATE_BINS            ?? true;
config.VALIDATE_BINS_ONLINE     = config.VALIDATE_BINS_ONLINE     ?? true;
config.AUTO_TIMING              = config.AUTO_TIMING              ?? true;

const BIN_CACHE_FILE = path.resolve(path.join(__dirname, '..', 'output', 'Данные', 'bin_cache.json'));

// ==================== 1. УТИЛИТЫ ====================

/** Глобальный флаг graceful shutdown */
let shutdownRequested = false;

/** Глобальная статистика сессии */
const stats = {
    startTime: null,
    totalAttempts: 0,
    successCount: 0,
    failCount: 0,
    totalTimeSuccess: 0,
    totalTimeFail: 0,
};

/**
 * Генерация случайной строки заданной длины.
 * @param {number} len - длина строки
 * @returns {string} строка из [a-z0-9]
 */
const randomString = (len) => {
    let s = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
};

/** Случайная задержка в диапазоне [min, max) */
const randomDelay = (min, max) => min + Math.random() * (max - min);

/** Ограничить число диапазоном */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Нормализовать тайминг в массив [min, max] */
function normalizeDelayRange(value, fallback = [0, 0]) {
    if (Array.isArray(value) && value.length >= 2) return [Number(value[0]) || fallback[0], Number(value[1]) || fallback[1]];
    const n = Number(value);
    if (Number.isFinite(n)) return [n, n];
    return fallback;
}

/**
 * Получить задержку из конфига.
 * Число → фиксированная, [min, max] → случайная в диапазоне.
 * @param {number|number[]} delayConfig
 * @returns {number}
 */
function getDelay(delayConfig) {
    if (Array.isArray(delayConfig)) return randomDelay(delayConfig[0], delayConfig[1]);
    return delayConfig;
}

/**
 * Promise-based sleep с проверкой shutdownRequested.
 * Упрощённая версия: только setInterval, без двойного таймера.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(r => {
    if (shutdownRequested) return r();
    if (ms <= 0) return r();
    const start = Date.now();
    const interval = ms > 10000 ? 500 : 200;
    const check = setInterval(() => {
        if (shutdownRequested || Date.now() - start >= ms) {
            clearInterval(check);
            r();
        }
    }, interval);
});

/**
 * fetch с таймаутом через AbortController.
 * Если сервер не ответил за timeoutMs — бросает Error.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<Response>}
 */
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

/**
 * Генерация номера карты по алгоритму Луна.
 * Умная генерация: автоматически определяет бренд по BIN и подбирает правильную длину.
 * @param {string} basePrefix - BIN (6-12 цифр)
 * @param {number} [cardLength] - длина карты (13-19, по умолчанию из config ИЛИ по бренду)
 * @returns {string} полный номер карты
 * @throws {Error} если BIN невалиден или слишком длинный
 */
function generateLuhnCard(basePrefix, cardLength) {
    if (!/^\d+$/.test(basePrefix)) {
        throw new Error(`BIN "${basePrefix}" must be all digits`);
    }

    if (!cardLength || cardLength === 'auto') {
        cardLength = detectCardLength(basePrefix) || 16;
    }
    if (cardLength < 13 || cardLength > 19) {
        throw new Error(`CARD_LENGTH must be 13-19, got ${cardLength}`);
    }

    const neededRandom = cardLength - basePrefix.length - 1;
    if (neededRandom < 0) {
        throw new Error(`BIN "${basePrefix}" too long for ${cardLength}-digit card`);
    }

    let randomPart = '';
    for (let i = 0; i < neededRandom; i++) {
        randomPart += Math.floor(Math.random() * 10);
    }
    const prefix = basePrefix + randomPart;

    let sum = 0;
    for (let i = 0; i < prefix.length; i++) {
        let n = parseInt(prefix[i], 10);
        if ((prefix.length - i + 1) % 2 === 0) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
    }

    const checkDigit = (10 - (sum % 10)) % 10;
    const card = prefix + checkDigit;

    if (!validateLuhn(card)) {
        throw new Error(`Luhn validation failed for generated card ${card}`);
    }

    return card;
}

/**
 * Определить длину карты по BIN (IIN-диапазоны).
 * VISA: 13, 16 (чаще 16)
 * MASTERCARD: 16
 * AMEX: 15 (префикс 34, 37)
 * DISCOVER: 16
 * DINERS: 14 (префикс 36, 38)
 * JCB: 16 (префикс 3528-3589)
 * @param {string} bin
 * @returns {number|null} длина карты или null
 */
function detectCardLength(bin) {
    const first1 = bin.slice(0, 1);
    const first2 = bin.slice(0, 2);
    const first4 = bin.slice(0, 4);
    const first6 = parseInt(bin.slice(0, 6), 10);

    if (first2 === '34' || first2 === '37') return 15;

    if (first2 === '36' || first2 === '38') return 14;

    if (first2 === '35' && first4 >= '3528' && first4 <= '3589') return 16;

    if (['51', '52', '53', '54', '55'].includes(first2)) return 16;
    const first4num = parseInt(first4, 10);
    if (first4num >= 2221 && first4num <= 2720) return 16;

    if (first1 === '4') return 16;

    if (first4 === '6011') return 16;
    if (first2 === '64' && first4 >= '6440' && first4 <= '6499') return 16;
    if (first6 >= 622126 && first6 <= 622925) return 16;

    return 16;
}

/**
 * Определить бренд карты по BIN.
 * @param {string} bin
 * @returns {string} 'VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'DINERS', 'JCB', 'UNKNOWN'
 */
function detectCardBrand(bin) {
    const first1 = bin.slice(0, 1);
    const first2 = bin.slice(0, 2);
    const first4 = bin.slice(0, 4);
    const first6 = parseInt(bin.slice(0, 6), 10);

    if (first2 === '34' || first2 === '37') return 'AMEX';
    if (first2 === '36' || first2 === '38') return 'DINERS';
    if (first2 === '35' && first4 >= '3528' && first4 <= '3589') return 'JCB';
    if (['51', '52', '53', '54', '55'].includes(first2)) return 'MASTERCARD';
    const first4num = parseInt(first4, 10);
    if (first4num >= 2221 && first4num <= 2720) return 'MASTERCARD';
    if (first1 === '4') return 'VISA';
    if (first4 === '6011' || (first2 === '64' && first4 >= '6440' && first4 <= '6499') || (first6 >= 622126 && first6 <= 622925)) return 'DISCOVER';

    return 'UNKNOWN';
}

/**
 * Генерация валидного CVC по бренду карты.
 * VISA/MC/JCB/Discover = 3 цифры, AMEX = 4 цифры
 * @param {string} bin
 * @returns {string} CVC-код
 */
function generateCVC(bin) {
    const brand = detectCardBrand(bin);
    const length = brand === 'AMEX' ? 4 : 3;
    let cvc = '';
    for (let i = 0; i < length; i++) cvc += Math.floor(Math.random() * 10);
    return cvc;
}

/**
 * Генерация валидной даты истечения карты.
 * Текущий месяц + 1-3 года вперёд (карта должна быть "активной").
 * @returns {string} MM/YY
 */
function generateExpDate() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const futureYear = now.getFullYear() + 1 + Math.floor(Math.random() * 3);
    const yy = String(futureYear % 100).padStart(2, '0');
    return `${month}/${yy}`;
}

/**
 * Проверка номера карты по алгоритму Луна.
 * @param {string} cardNumber
 * @returns {boolean}
 */
function validateLuhn(cardNumber) {
    let sum = 0;
    let alternate = false;
    for (let i = cardNumber.length - 1; i >= 0; i--) {
        let n = parseInt(cardNumber[i], 10);
        if (alternate) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
        alternate = !alternate;
    }
    return sum % 10 === 0;
}

/**
 * Парсинг строки прокси в объект для Playwright.
 * Поддерживаемые форматы:
 *   http://ip:port
 *   http://user:pass@ip:port
 *   https://user:pass@ip:port
 *   socks5://user:pass@ip:port
 *   ip:port                          (→ http://)
 *   user:pass@ip:port               (→ http://)
 * @param {string|null} proxyStr
 * @returns {{server: string, username?: string, password?: string}|null}
 */
function parseProxy(proxyStr) {
    if (!proxyStr) return null;
    const str = proxyStr.trim();

    let match = str.match(/^(https?|socks5):\/\/(?:([^:]+):([^@]+)@)?(?:\[([0-9a-fA-F:]+)\]|([^:]+)):(\d+)$/);
    if (match) {
        const host = match[4] || match[5];
        const proxy = { server: `${match[1]}://${host}:${match[6]}` };
        if (match[2] && match[3]) {
            proxy.username = decodeURIComponent(match[2]);
            proxy.password = decodeURIComponent(match[3]);
        }
        return proxy;
    }

    match = str.match(/^(?:([^:]+):([^@]+)@)?(?:\[([0-9a-fA-F:]+)\]|([^:]+)):(\d+)$/);
    if (match) {
        const host = match[3] || match[4];
        const proxy = { server: `http://${host}:${match[5]}` };
        if (match[1] && match[2]) {
            proxy.username = decodeURIComponent(match[1]);
            proxy.password = decodeURIComponent(match[2]);
        }
        return proxy;
    }

    try {
        if (/^https?:\/\//.test(str) || /^socks5:\/\//.test(str)) {
            const url = new URL(str);
            const proxy = { server: `${url.protocol}//${url.hostname}:${url.port}` };
            if (url.username) {
                proxy.username = decodeURIComponent(url.username);
                proxy.password = decodeURIComponent(url.password);
            }
            return proxy;
        }
    } catch { }

    log.warn(`[Прокси] ⚠️ Не удалось распарсить: ${proxyStr}`);
    return null;
}

/**
 * Нормализация имени почтового провайдера.
 * Единая функция для всех мест: createMailProvider, validateConfig, healthCheck.
 * Поддерживаемые алиасы: 'coda', 'coda.ink', 'temp.coda.ink' → 'coda'
 *                     'mailtm', 'mail.tm' → 'mailtm'
 * @param {string} value
 * @returns {'coda'|'mailtm'}
 */
function normalizeMailProvider(value) {
    const v = (value || 'mailtm').toLowerCase().trim();
    if (['coda', 'coda.ink', 'temp.coda.ink'].includes(v)) return 'coda';
    if (['mailtm', 'mail.tm'].includes(v)) return 'mailtm';
    return 'mailtm';
}

/**
 * Санитизация части имени файла/папки — удаление запрещённых символов Windows.
 * @param {string} s
 * @returns {string}
 */
function sanitizeFilePart(s) {
    return String(s)
        .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

/**
 * Генерация имени папки для экспорта аккаунта.
 * Формат: "2026-05-16 02-58-33 Pro user-orgname"
 * @param {string} baseDir
 * @param {string} label - "Pro" или "Error"
 * @param {string} orgName
 * @returns {string} полный путь к папке
 */
function makeFolderName(baseDir, label, orgName) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const unique = randomString(4);

    return path.join(baseDir, `${dateStr} ${timeStr} ${label} ${sanitizeFilePart(orgName)} ${unique}`);
}

/**
 * Классификация ошибки по категории для статистики и вебхуков.
 * @param {Error} error
 * @returns {string} категория (MAIL_ERROR, BROWSER_ERROR, PAYMENT_ERROR, etc.)
 */
function categorizeError(error) {
    const msg = (error.message || '').toLowerCase();

    if (msg.includes('checkout не загрузился') || msg.includes('stripe не загрузился'))
        return 'TIMEOUT_ERROR';

    if (msg.includes('кнопка триала') || msg.includes('кнопка оплаты') || msg.includes('поле не найдено'))
        return 'BROWSER_ERROR';

    if (msg.includes('timeout') || msg.includes('навигаци') || msg.includes('navigation') || msg.includes('fetch timeout'))
        return 'TIMEOUT_ERROR';

    if (msg.includes('captcha') || msg.includes('hcaptcha') || msg.includes('капча'))
        return 'CAPTCHA_ERROR';

    if (msg.includes('declined') || msg.includes('insufficient') || msg.includes('payment_failed') || msg.includes('карта') || msg.includes('оплат'))
        return 'PAYMENT_ERROR';

    if (msg.includes('browser') || msg.includes('launch') || msg.includes('target page') || msg.includes('context or browser'))
        return 'BROWSER_ERROR';

    if (msg.includes('mail.tm') || msg.includes('coda') || msg.includes('otp') || msg.includes('почт') || msg.includes('rate limit'))
        return 'MAIL_ERROR';

    return 'UNKNOWN_ERROR';
}

/**
 * Улучшенное сообщение об ошибке с подсказкой.
 * @param {Error} error
 * @returns {string} сообщение с подсказкой
 */
function enhancedErrorMessage(error) {
    const msg = error.message || '';
    const cat = categorizeError(error);

    const hints = {
        'PAYMENT_ERROR': ' — попробуйте другой BIN или проверьте прокси',
        'CAPTCHA_ERROR': ' — проверьте настройки hCaptcha или используйте решатель',
        'MAIL_ERROR': ' — проверьте доступность почтового API или смените провайдера',
        'BROWSER_ERROR': ' — проверьте установку Chromium: npx playwright install chromium',
        'TIMEOUT_ERROR': ' — проверьте интернет-соединение или увеличьте таймауты в конфиге',
    };

    return msg + (hints[cat] || '');
}

// ==================== СОЗДАНИЕ СТРУКТУРЫ ПАПОК ====================

/**
 * Создание структуры output/ директорий и очистка старых сессионных файлов.
 */
function ensureOutputDirs() {
    const safeDirname = (p) => p ? path.dirname(p) : null;
    const dirs = [
        config.READY_DIR,
        config.ERROR_DIR,
        config.ARCHIVE_DIR,
        safeDirname(config.LOG_FILE),
        safeDirname(config.ACCOUNTS_FILE),
        safeDirname(config.KNOWN_BINS_FILE),
        safeDirname(config.TIMING_PROFILE_FILE),
    ];

    for (const dir of dirs) {
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const readmePath = path.join('output', 'ЧИТАЙ_МЕНЯ.txt');
    if (!fs.existsSync(readmePath)) {
        try {
            fs.writeFileSync(readmePath, [
                '════════════════════════════════════════════════════════════',
                '  ГДЕ ЧТО ЛЕЖИТ',
                '════════════════════════════════════════════════════════════',
                '',
                '  Аккаунты/    ← Успешные аккаунты (cookies, инструкция входа)',
                '  Ошибки/      ← Неудачные попытки (скриншоты, HTML-дампы)',
                '  Логи/        ← Логи запуска (autoreger.log, events.jsonl)',
                '  Данные/      ← Список аккаунтов (accounts.txt), статистика BIN',
                '  Архив/       ← Старые данные',
                '',
                '  ЧТОБЫ ВОЙТИ В АККАУНТ:',
                '  1. Откройте папку Аккаунты/ → папку нужного аккаунта',
                '  2. Откройте файл Инструкция_входа.txt — там всё по шагам',
                '',
                '════════════════════════════════════════════════════════════',
            ].join('\n'), 'utf-8');
        } catch { }
    }

    try {
        const cwdFiles = fs.readdirSync('.');
        let cleaned = 0;
        for (const file of cwdFiles) {
            if (/^devin_session_.*\.json$/.test(file)) {
                try {
                    fs.unlinkSync(file);
                    cleaned++;
                } catch { }
            }
        }
        if (cleaned > 0) {
            console.log(`[🧹] Удалено ${cleaned} старых сессионных файлов`);
        }
    } catch { }

    const maxAgeDays = config.MAX_ACCOUNTS_AGE_DAYS || 0;
    if (maxAgeDays > 0) {
        const now = Date.now();
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        for (const dir of [config.READY_DIR, config.ERROR_DIR]) {
            if (!dir || !fs.existsSync(dir)) continue;
            try {
                const entries = fs.readdirSync(dir);
                let removed = 0;
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry);
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.isDirectory() && (now - stat.mtimeMs) > maxAgeMs) {
                            fs.rmSync(fullPath, { recursive: true, force: true });
                            removed++;
                        }
                    } catch { }
                }
                if (removed > 0) {
                    console.log(`[🧹] Удалено ${removed} старых папок из ${dir} (> ${maxAgeDays} дней)`);
                }
            } catch { }
        }
    }
}

// ==================== 2. ЛОГГЕР ====================

/**
 * Двойной логгер: вывод в консоль + запись в файл.
 * Автоматически очищает ANSI-коды для файла.
 */
class Logger {
    /**
     * @param {string|null} logFile - путь к файлу логов или null (только консоль)
     */
    constructor(logFile) {
        this.logFile = logFile ? path.resolve(logFile) : null;
        this.fileEnabled = false;
        this.level = 'quiet';
        this.jsonlFile = null;
    }

    /** @private Запись в файл с таймстемпом */
    _toFile(level, msg) { }

    /** @private Запись в JSONL structured log */
    _toJsonl(event, data) { }

    info(msg)    { }
    warn(msg)    { }
    error(msg)   { }
    success(msg) { }
    debug(msg)   { }

    /** Событие аккаунта — пишет в JSONL */
    accountEvent(event, data) {
        this._toJsonl(event, data);
    }

    /** Точка прогресса — пишет в stdout и в файл */
    dot() { }
}

ensureOutputDirs();

const log = new Logger(config.LOG_FILE);

class TimingOptimizer {
    constructor(profileFile) {
        this.profileFile = profileFile ? path.resolve(profileFile) : null;
        this.enabled = config.AUTO_TIMING !== false;
        this.baseConfig = {
            DELAY_OTP_WAIT: config.DELAY_OTP_WAIT,
            DELAY_OTP_POLL: config.DELAY_OTP_POLL,
            DELAY_AFTER_CODE_INPUT: config.DELAY_AFTER_CODE_INPUT,
            DELAY_PAYMENT_WAIT: config.DELAY_PAYMENT_WAIT,
            DELAY_BEFORE_TRIAL_CLICK: config.DELAY_BEFORE_TRIAL_CLICK,
            DELAY_BETWEEN_ACTIONS: config.DELAY_BETWEEN_ACTIONS,
            DELAY_TYPING: config.DELAY_TYPING,
            PAUSE_BETWEEN_ACCOUNTS: config.PAUSE_BETWEEN_ACCOUNTS,
        };
        this.profile = this._createEmptyProfile();
        this.applied = [];
        this.reasons = [];
        this.confidence = 'none';
        this._load();
    }

    _createEmptyProfile() {
        return {
            schemaVersion: 2,
            updated: null,
            runs: {
                success: 0,
                fail: 0,
                dryRun: 0,
                avgSuccessMs: 0,
                avgFailMs: 0,
                avgDryRunMs: 0,
                lastDurationMs: 0,
                lastOutcome: null,
            },
            otp: {
                mailtm: { count: 0, avgMs: 0, maxMs: 0, lastMs: 0, recentMs: [] },
                coda: { count: 0, avgMs: 0, maxMs: 0, lastMs: 0, recentMs: [] }
            },
            categories: {},
            streaks: { currentType: null, currentCount: 0, bestSuccess: 0, bestFail: 0 },
            recommendations: {},
            lastApplied: { confidence: 'none', reasons: [], changes: [] }
        };
    }

    _avg(prev, count, value) {
        return Math.round(((prev * (count - 1)) + value) / count);
    }

    _recent(values, nextValue, limit = 5) {
        const list = Array.isArray(values) ? [...values] : [];
        list.push(nextValue);
        return list.slice(-limit);
    }

    _recentAvg(values, fallback = 0) {
        if (!Array.isArray(values) || values.length === 0) return fallback;
        return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    }

    _rate(part, total) {
        return total > 0 ? part / total : 0;
    }

    _sameRange(a, b) {
        return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
    }

    _setNumber(key, value, applied, label) {
        if (value !== undefined && value !== null && value !== config[key]) {
            config[key] = value;
            applied.push(`${label}=${value}ms`);
        }
    }

    _setRange(key, value, applied, label) {
        if (Array.isArray(value) && !this._sameRange(config[key], value)) {
            config[key] = value;
            applied.push(`${label}=${value[0]}-${value[1]}ms`);
        }
    }

    _load() {
        try {
            if (!this.profileFile || !fs.existsSync(this.profileFile)) return;
            const parsed = JSON.parse(fs.readFileSync(this.profileFile, 'utf-8'));
            const empty = this._createEmptyProfile();
            this.profile = {
                ...empty,
                ...parsed,
                runs: { ...empty.runs, ...(parsed.runs || {}) },
                otp: {
                    mailtm: { ...empty.otp.mailtm, ...(parsed.otp?.mailtm || {}) },
                    coda: { ...empty.otp.coda, ...(parsed.otp?.coda || {}) }
                },
                categories: { ...(parsed.categories || {}) },
                streaks: { ...empty.streaks, ...(parsed.streaks || {}) },
                recommendations: { ...(parsed.recommendations || {}) },
                lastApplied: { ...empty.lastApplied, ...(parsed.lastApplied || {}) }
            };
        } catch (e) {
            log.warn(`[Timing] ⚠️ Не удалось загрузить профиль таймингов: ${e.message}`);
        }
    }

    _save() {
        try {
            if (!this.profileFile) return;
            const dir = path.dirname(this.profileFile);
            if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            this.profile.updated = new Date().toISOString();
            fs.writeFileSync(this.profileFile, JSON.stringify(this.profile, null, 2), 'utf-8');
        } catch (e) {
            log.warn(`[Timing] ⚠️ Не удалось сохранить профиль таймингов: ${e.message}`);
        }
    }

    applyToConfig() {
        if (!this.enabled) return;
        const provider = normalizeMailProvider(config.MAIL_PROVIDER);
        const otpStats = this.profile.otp[provider] || this._createEmptyProfile().otp.mailtm;
        const runs = this.profile.runs;
        const categories = this.profile.categories || {};
        const applied = [];
        const reasons = [];
        const baseTrial = normalizeDelayRange(this.baseConfig.DELAY_BEFORE_TRIAL_CLICK, [3000, 5000]);
        const baseAction = normalizeDelayRange(this.baseConfig.DELAY_BETWEEN_ACTIONS, [200, 500]);
        const basePause = normalizeDelayRange(this.baseConfig.PAUSE_BETWEEN_ACCOUNTS, [2000, 5000]);
        const baseTyping = normalizeDelayRange(this.baseConfig.DELAY_TYPING, [40, 100]);
        const evaluatedRuns = (runs.success || 0) + (runs.fail || 0);
        const totalRuns = evaluatedRuns + (runs.dryRun || 0);
        const failRate = this._rate(runs.fail || 0, evaluatedRuns);
        const mailRate = this._rate(categories.MAIL_ERROR || 0, evaluatedRuns);
        const timeoutRate = this._rate(categories.TIMEOUT_ERROR || 0, evaluatedRuns);
        const browserRate = this._rate(categories.BROWSER_ERROR || 0, evaluatedRuns);
        const captchaRate = this._rate(categories.CAPTCHA_ERROR || 0, evaluatedRuns);
        const paymentRate = this._rate(categories.PAYMENT_ERROR || 0, evaluatedRuns);
        const otpRecentAvg = this._recentAvg(otpStats.recentMs, otpStats.avgMs || 0);

        this.confidence = totalRuns >= 10 ? 'high' : (totalRuns >= 5 ? 'medium' : (totalRuns >= 2 ? 'low' : 'none'));

        let nextOtpWait = this.baseConfig.DELAY_OTP_WAIT || 60000;
        let nextOtpPoll = this.baseConfig.DELAY_OTP_POLL || 3000;
        let nextAfterOtp = this.baseConfig.DELAY_AFTER_CODE_INPUT || 5000;
        let nextPaymentWait = this.baseConfig.DELAY_PAYMENT_WAIT || 75000;
        let nextTrial = [...baseTrial];
        let nextAction = [...baseAction];
        let nextPause = [...basePause];
        let nextTyping = [...baseTyping];

        if (otpStats.count >= 2 && (otpStats.avgMs > 0 || otpStats.maxMs > 0)) {
            const otpMax = Math.max(otpStats.maxMs || 0, otpRecentAvg || 0, otpStats.avgMs || 0);
            nextOtpWait = clamp(Math.round(Math.max(
                nextOtpWait,
                (otpRecentAvg || otpStats.avgMs || 0) * 2.4,
                otpMax * 1.45
            )), 30000, 180000);
            nextOtpPoll = otpRecentAvg <= 12000 ? 2000 : (otpRecentAvg <= 25000 ? 3000 : (otpRecentAvg <= 45000 ? 4000 : 5000));
            reasons.push(`почта:${provider}`);
        }

        const conservativeMode = evaluatedRuns >= 3 && (
            failRate >= 0.45 ||
            mailRate >= 0.25 ||
            timeoutRate >= 0.2 ||
            browserRate >= 0.2 ||
            captchaRate >= 0.15
        );
        const stableFastMode = evaluatedRuns >= 6 &&
            (runs.success || 0) >= 5 &&
            failRate <= 0.15 &&
            mailRate <= 0.1 &&
            timeoutRate <= 0.1 &&
            browserRate <= 0.1 &&
            captchaRate <= 0.05;

        if (conservativeMode) {
            nextTrial = [clamp(baseTrial[0] + 750, 2500, 8000), clamp(baseTrial[1] + 1250, 3500, 10000)];
            nextAction = [clamp(baseAction[0] + 75, 150, 800), clamp(baseAction[1] + 150, 250, 1200)];
            nextPause = [clamp(basePause[0] + 1000, 1000, 9000), clamp(basePause[1] + 1500, 2000, 14000)];
            nextTyping = [clamp(baseTyping[0] + 10, 30, 160), clamp(baseTyping[1] + 25, 60, 240)];
            nextAfterOtp = clamp(nextAfterOtp + 1000, 3000, 12000);
            nextPaymentWait = clamp(nextPaymentWait + 15000, 60000, 150000);
            reasons.push('консервативный режим');
        } else if (stableFastMode) {
            nextTrial = [clamp(baseTrial[0] - 250, 2000, 8000), clamp(baseTrial[1] - 500, 3000, 10000)];
            nextAction = [clamp(baseAction[0] - 25, 100, 800), clamp(baseAction[1] - 50, 150, 1200)];
            nextPause = [clamp(basePause[0] - 500, 1000, 9000), clamp(basePause[1] - 500, 1500, 14000)];
            nextTyping = [clamp(baseTyping[0] - 5, 20, 160), clamp(baseTyping[1] - 10, 40, 240)];
            nextAfterOtp = clamp(nextAfterOtp - 500, 2500, 12000);
            reasons.push('стабильные успешные запуски');
        }

        if (mailRate >= 0.25 || timeoutRate >= 0.2) {
            nextOtpWait = clamp(nextOtpWait + 15000, 30000, 180000);
            nextOtpPoll = Math.max(nextOtpPoll, 4000);
            nextAfterOtp = clamp(nextAfterOtp + 500, 3000, 12000);
            reasons.push('медленные OTP/таймауты');
        }

        if (browserRate >= 0.2 || captchaRate >= 0.15) {
            nextAction = [clamp(nextAction[0] + 25, 100, 800), clamp(nextAction[1] + 50, 150, 1200)];
            nextTyping = [clamp(nextTyping[0] + 5, 20, 160), clamp(nextTyping[1] + 10, 40, 240)];
            reasons.push('браузер/captcha');
        }

        if (paymentRate >= 0.35 && !conservativeMode) {
            nextTrial = [clamp(nextTrial[0] + 250, 2000, 8000), clamp(nextTrial[1] + 500, 3000, 10000)];
            nextAfterOtp = clamp(nextAfterOtp + 500, 2500, 12000);
            reasons.push('частые ошибки оплаты');
        }

        this._setNumber('DELAY_OTP_WAIT', nextOtpWait, applied, 'OTP wait');
        this._setNumber('DELAY_OTP_POLL', nextOtpPoll, applied, 'OTP poll');
        this._setNumber('DELAY_AFTER_CODE_INPUT', nextAfterOtp, applied, 'afterOTP');
        this._setNumber('DELAY_PAYMENT_WAIT', nextPaymentWait, applied, 'paymentWait');
        this._setRange('DELAY_BEFORE_TRIAL_CLICK', nextTrial, applied, 'trial');
        this._setRange('DELAY_BETWEEN_ACTIONS', nextAction, applied, 'actions');
        this._setRange('PAUSE_BETWEEN_ACCOUNTS', nextPause, applied, 'between');
        this._setRange('DELAY_TYPING', nextTyping, applied, 'typing');

        this.profile.recommendations = {
            DELAY_OTP_WAIT: config.DELAY_OTP_WAIT,
            DELAY_OTP_POLL: config.DELAY_OTP_POLL,
            DELAY_AFTER_CODE_INPUT: config.DELAY_AFTER_CODE_INPUT,
            DELAY_PAYMENT_WAIT: config.DELAY_PAYMENT_WAIT,
            DELAY_BEFORE_TRIAL_CLICK: config.DELAY_BEFORE_TRIAL_CLICK,
            DELAY_BETWEEN_ACTIONS: config.DELAY_BETWEEN_ACTIONS,
            DELAY_TYPING: config.DELAY_TYPING,
            PAUSE_BETWEEN_ACCOUNTS: config.PAUSE_BETWEEN_ACCOUNTS
        };

        this.applied = applied;
        this.reasons = [...new Set(reasons)];
        this.profile.lastApplied = {
            confidence: this.confidence,
            reasons: this.reasons,
            changes: applied
        };
        this._save();
        if (applied.length > 0) {
            const reasonText = this.reasons.length > 0 ? ` | причины: ${this.reasons.join(', ')}` : '';
            log.info(`[Timing] ⚙️ Авто-тайминги применены (${this.confidence}): ${applied.join(', ')}${reasonText}`);
        } else {
            const reasonText = this.reasons.length > 0 ? ` Профиль учтён: ${this.reasons.join(', ')}.` : '';
            log.info(`[Timing] ⚙️ Авто-тайминги: оставили базовые значения (${this.confidence}).${reasonText}`);
        }
    }

    recordOtpWait(providerName, ms) {
        if (!this.enabled || !ms || ms <= 0) return;
        const provider = normalizeMailProvider(providerName);
        if (!this.profile.otp[provider]) this.profile.otp[provider] = { count: 0, avgMs: 0, maxMs: 0, lastMs: 0, recentMs: [] };
        const nextCount = (this.profile.otp[provider].count || 0) + 1;
        this.profile.otp[provider].count = nextCount;
        this.profile.otp[provider].avgMs = this._avg(this.profile.otp[provider].avgMs || 0, nextCount, ms);
        this.profile.otp[provider].maxMs = Math.max(this.profile.otp[provider].maxMs || 0, ms);
        this.profile.otp[provider].lastMs = ms;
        this.profile.otp[provider].recentMs = this._recent(this.profile.otp[provider].recentMs, ms);
        this._save();
    }

    recordAccount(success, durationMs, category = null) {
        if (!this.enabled || !durationMs || durationMs <= 0) return;
        if (category === 'DRY_RUN') {
            this.profile.runs.dryRun++;
            this.profile.runs.avgDryRunMs = this._avg(this.profile.runs.avgDryRunMs || 0, this.profile.runs.dryRun, durationMs);
        } else if (success) {
            this.profile.runs.success++;
            this.profile.runs.avgSuccessMs = this._avg(this.profile.runs.avgSuccessMs || 0, this.profile.runs.success, durationMs);
        } else {
            this.profile.runs.fail++;
            this.profile.runs.avgFailMs = this._avg(this.profile.runs.avgFailMs || 0, this.profile.runs.fail, durationMs);
        }
        const outcome = category === 'DRY_RUN' ? 'DRY_RUN' : (success ? 'SUCCESS' : (category || 'FAIL'));
        this.profile.runs.lastDurationMs = durationMs;
        this.profile.runs.lastOutcome = outcome;
        this.profile.categories[outcome] = (this.profile.categories[outcome] || 0) + 1;
        if (this.profile.streaks.currentType === outcome) {
            this.profile.streaks.currentCount++;
        } else {
            this.profile.streaks.currentType = outcome;
            this.profile.streaks.currentCount = 1;
        }
        if (outcome === 'SUCCESS') {
            this.profile.streaks.bestSuccess = Math.max(this.profile.streaks.bestSuccess || 0, this.profile.streaks.currentCount);
        } else if (outcome !== 'DRY_RUN') {
            this.profile.streaks.bestFail = Math.max(this.profile.streaks.bestFail || 0, this.profile.streaks.currentCount);
        }
        this._save();
    }
}

const timingOptimizer = new TimingOptimizer(config.TIMING_PROFILE_FILE);
timingOptimizer.applyToConfig();

// ==================== 3. BIN-МЕНЕДЖЕР ====================

/**
 * Дефолтные BIN-ы для авто-подбора (credit, проходят на Stripe).
 * Используются когда config.BINS пуст — скрипт сам подбирает рабочий BIN.
 */
const DEFAULT_BINS = [
    '429544',
    '453221',
    '491630',
    '448534',
    '426428',
    '531086',
    '544422',
    '546924',
    '222178',
    '524199',
];

/**
 * Управление BIN-ами: ротация, статистика, приоритизация рабочих.
 * Сохраняет known_bins.json между запусками.
 */
class BinManager {
    constructor() {
        let bins = Array.isArray(config.BINS) ? [...config.BINS] : (config.BINS ? [config.BINS] : []);
        if (bins.length === 0 || bins.every(b => !b)) {
            bins = [...DEFAULT_BINS];
            log.info(`[BIN] 🔄 BIN-ы не указаны — используем авто-подбор (${bins.length} BIN-ов)`);
        }
        this.bins = bins;
        this.knownGood = [];
        this.knownBad = [];
        this.binStats = {};
        this.binFailStreak = {};
        this.knownBinsFile = config.KNOWN_BINS_FILE || 'output/Данные/known_bins.json';
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
            log.warn(`[BIN] ⚠️ Не удалось загрузить ${this.knownBinsFile}: ${e.message}`);
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
            log.warn(`[BIN] ⚠️ Не удалось сохранить ${this.knownBinsFile}: ${e.message}`);
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
            log.warn('[BIN] ⚠️ Все BIN-ы на cooldown — сбрасываем');
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
            log.warn(`[BIN] ⏳ BIN ${bin} на cooldown ${cooldownMs / 1000}с (${consecutiveFails} fail подряд)`);
        }

        this._save();
    }

    /** Проверить, не на cooldown ли BIN */
    isOnCooldown(bin) {
        if (!this.binCooldownUntil[bin]) return false;
        if (Date.now() >= this.binCooldownUntil[bin]) {
            delete this.binCooldownUntil[bin];
            return false;
        }
        return true;
    }

    /** Получить success rate для BIN */
    getSuccessRate(bin) {
        const s = this.binStats[bin];
        if (!s || (s.success + s.fail) === 0) return null;
        return ((s.success / (s.success + s.fail)) * 100).toFixed(1);
    }

    /** Строка статистики для вывода */
    getStatsLine() {
        return `✅${this.knownGood.length} хороших | ❌${this.knownBad.length} плохих`;
    }

    /**
     * Валидация BIN-ов через публичный API (binlist.net) + локальную базу.
     * Проверяет тип карты (credit/debit/prepaid), страну, банк.
     * Сопоставляет страну BIN с биллинг-профилями — несовпадение = повышенный риск declined.
     * Prepaid BIN-ы автоматически исключаются из valid.
     * @param {boolean} useOnline - использовать онлайн-проверку (по умолчанию true)
     * @returns {Promise<{valid: string[], warnings: string[], info: Array, recommended: string[]}>}
     */
    async validateBins(useOnline = true) {
        const valid = [];
        const warnings = [];
        const info = [];
        const recommended = [];

        const billingCountries = (config.BILLING_PROFILES || []).map(p => p.country?.toUpperCase()).filter(Boolean);
        const hasBillingMatch = billingCountries.length > 0;

        log.info('\n[BIN] ═══ Проверка BIN-ов перед запуском ═══');
        if (hasBillingMatch) {
            log.info(`[BIN] Страны биллинга: ${billingCountries.join(', ')}`);
        }

        for (const bin of this.bins) {
            const bin6 = String(bin).slice(0, 6);
            if (!/^\d{6,8}$/.test(bin6)) {
                warnings.push(`BIN "${bin}" — неверный формат (нужно 6-8 цифр)`);
                log.warn(`[BIN] ⚠️ "${bin}" — неверный формат`);
                continue;
            }

            let binInfo = this._lookupLocal(bin6);

            if (binInfo) {
                log.info(`[BIN] ✔ ${bin6}: ${binInfo.brand} ${binInfo.type} | ${binInfo.country} | ${binInfo.bank} | ${binInfo.category}`);
            } else if (useOnline) {
                log.info(`[BIN] ⏳ ${bin6}: ищем онлайн...`);
                binInfo = await this._lookupOnline(bin6);

                if (binInfo) {
                    const typeIcon = binInfo.type === 'credit' ? '💳' : (binInfo.type === 'debit' ? '🏦' : '🎫');
                    log.info(`[BIN] ✔ ${bin6}: ${binInfo.brand} ${typeIcon} ${binInfo.type} | ${binInfo.country} | ${binInfo.bank}`);
                } else {
                    log.warn(`[BIN] ⚠️ ${bin6}: не найден в базе — неизвестный BIN`);
                    warnings.push(`BIN "${bin6}" — не найден в базе`);
                }

                await new Promise(r => setTimeout(r, 600));
            }

            if (binInfo) {
                info.push(binInfo);

                const countryMatch = hasBillingMatch && billingCountries.includes(binInfo.country);
                const countryMismatch = hasBillingMatch && !countryMatch;

                if (binInfo.type === 'prepaid' || binInfo.prepaid) {
                    warnings.push(`BIN "${bin6}" — PREPAID (${binInfo.country}), почти наверняка будет declined на Stripe`);
                    log.warn(`[BIN] ⚠️ ${bin6} — PREPAID! Почти наверняка будет declined`);
                } else if (binInfo.type === 'debit') {
                    warnings.push(`BIN "${bin6}" — DEBIT (${binInfo.country}), может не пройти для подписок`);
                    log.warn(`[BIN] ⚠️ ${bin6} — DEBIT, может не пройти для подписок`);
                    valid.push(bin);
                } else if (binInfo.type === 'credit') {
                    valid.push(bin);
                    if (binInfo.category === 'premium') {
                        log.success(`[BIN] ★ ${bin6} — CREDIT PREMIUM (${binInfo.country}, ${binInfo.bank})`);
                    } else {
                        log.info(`[BIN] ✓ ${bin6} — CREDIT (${binInfo.country}, ${binInfo.bank})`);
                    }

                    if (countryMatch) {
                        recommended.push(bin);
                        if (binInfo.category === 'premium') {
                            log.success(`[BIN] 🏆 ${bin6} — ИДЕАЛЬНЫЙ: credit premium + страна совпадает (${binInfo.country})`);
                        } else {
                            log.success(`[BIN] ✅ ${bin6} — ХОРОШИЙ: credit + страна совпадает (${binInfo.country})`);
                        }
                    }
                } else {
                    valid.push(bin);
                    log.info(`[BIN] ? ${bin6} — тип неизвестен, берём на свой страх и риск`);
                }

                if (countryMismatch && binInfo.type !== 'prepaid') {
                    warnings.push(`BIN "${bin6}" — страна ${binInfo.country} НЕ совпадает с биллингом (${billingCountries.join('/')}). Stripe может повысить скоринг мошенничества.`);
                    log.warn(`[BIN] ⚠️ ${bin6} — страна ${binInfo.country} ≠ биллинг ${billingCountries.join('/')}. Повышенный риск declined!`);
                }
            } else {
                valid.push(bin);
            }
        }

        log.info(`\n[BIN] ═══ Итог проверки ═══`);
        log.info(`[BIN] BIN-ов в конфиге: ${this.bins.length}`);
        log.info(`[BIN] Найдено в базе: ${info.length}`);
        log.info(`[BIN] Предупреждений: ${warnings.length}`);

        const creditCount = info.filter(i => i.type === 'credit').length;
        const debitCount = info.filter(i => i.type === 'debit').length;
        const prepaidCount = info.filter(i => i.type === 'prepaid' || i.prepaid).length;

        if (creditCount > 0) log.success(`[BIN] 💳 Credit: ${creditCount} — лучший выбор для подписок`);
        if (debitCount > 0)  log.warn(`[BIN] 🏦 Debit: ${debitCount} — могут не пройти`);
        if (prepaidCount > 0) log.error(`[BIN] 🎫 Prepaid: ${prepaidCount} — почти точно не пройдут!`);

        if (recommended.length > 0) {
            log.success(`[BIN] 🏆 Рекомендуемые (credit + страна биллинга): ${recommended.join(', ')}`);
        } else if (hasBillingMatch && creditCount > 0) {
            log.warn(`[BIN] ⚠️ Есть credit BIN-ы, но НИ ОДИН не совпадает по стране с биллингом (${billingCountries.join('/')})`);
            log.info(`[BIN] 💡 Совет: используйте BIN страны ${billingCountries.join('/')} для лучшего результата`);
            log.info(`[BIN] 💡 Запустите: node internal/bin-lookup.js --filter credit --country ${billingCountries[0]}`);
        }

        if (prepaidCount > 0 && creditCount === 0 && debitCount === 0) {
            log.error(`[BIN] ❌ Все BIN-ы — prepaid! Регистрация почти наверняка не сработает.`);
            log.info(`[BIN] 💡 Запустите "node internal/bin-lookup.js --filter credit" для поиска credit BIN-ов`);
        }

        return { valid, warnings, info, recommended };
    }

    /** @private Локальный lookup — кеш → встроенная база */
    _lookupLocal(bin) {
        // 1. Кеш (из bin-lookup.js --sync)
        const cached = BinManager._getFromCache(bin);
        if (cached) return cached;

        // 2. Встроенная база
        const DB = BinManager.LOCAL_BIN_DB;
        return DB.find(b => b.bin === bin) || null;
    }

    /** @private Прочитать BIN из кеш-файла */
    static _getFromCache(bin) {
        try {
            if (!BinManager._cacheData) {
                if (fs.existsSync(BIN_CACHE_FILE)) {
                    BinManager._cacheData = JSON.parse(fs.readFileSync(BIN_CACHE_FILE, 'utf-8'));
                } else {
                    BinManager._cacheData = { bins: {} };
                }
            }
            return BinManager._cacheData.bins[bin] || null;
        } catch {
            return null;
        }
    }

    /** @private Онлайн lookup через binlist.net (с сохранением в кеш) */
    async _lookupOnline(bin) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(`https://lookup.binlist.net/${bin}`, {
                signal: controller.signal,
                headers: { 'Accept-Version': '3' }
            });
            clearTimeout(timeout);

            if (res.status === 429) return null;
            if (!res.ok) return null;

            const data = await res.json();
            const result = {
                bin,
                brand: data.scheme?.toUpperCase() || 'UNKNOWN',
                type: data.type || 'unknown',
                country: data.country?.alpha2 || '??',
                countryName: data.country?.name || '',
                bank: data.bank?.name || 'Unknown',
                category: data.type === 'credit' ? 'premium' : (data.type === 'debit' ? 'standard' : 'prepaid'),
                prepaid: data.prepaid || false,
                source: 'api',
            };

            BinManager._saveToCache(bin, result);

            return result;
        } catch {
            return null;
        }
    }

    /** @private Сохранить BIN в кеш-файл */
    static _saveToCache(bin, info) {
        try {
            if (!BinManager._cacheData) BinManager._getFromCache('__init__');
            if (!BinManager._cacheData) BinManager._cacheData = { bins: {} };

            BinManager._cacheData.bins[bin] = {
                bin: info.bin,
                brand: info.brand || 'UNKNOWN',
                type: info.type || 'unknown',
                country: info.country || '??',
                countryName: info.countryName || '',
                bank: info.bank || 'Unknown',
                category: info.category || 'standard',
                prepaid: info.prepaid || false,
                cachedAt: new Date().toISOString(),
                source: info.source || 'api',
            };

            const dir = path.dirname(BIN_CACHE_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            BinManager._cacheData.updated = new Date().toISOString();
            fs.writeFileSync(BIN_CACHE_FILE, JSON.stringify(BinManager._cacheData, null, 2), 'utf-8');
        } catch { /* не критично */ }
    }
}

/**
 * @static Локальная BIN-база (публичная информация).
 * Используется для быстрой проверки без обращения к API.
 */
BinManager.LOCAL_BIN_DB = [
    { bin: '451012', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '451013', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '451014', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '451015', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '451016', brand: 'VISA', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '453201', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '453202', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '453203', brand: 'VISA', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '453214', brand: 'VISA', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '455689', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '455690', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '455691', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '455692', brand: 'VISA', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '471321', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '471322', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '471621', brand: 'VISA', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '491610', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '491611', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '492910', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '492911', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '515462', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '515463', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '515464', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '515465', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '521234', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '528090', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '530125', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '540101', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '540102', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '540103', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '542018', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '549184', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '552100', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '492181', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '492960', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '455696', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '522125', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '492964', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '455699', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '530139', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '451017', brand: 'VISA', type: 'credit', country: 'CA', bank: 'RBC', category: 'premium' },
    { bin: '540112', brand: 'MASTERCARD', type: 'credit', country: 'CA', bank: 'RBC', category: 'premium' },
    { bin: '492968', brand: 'VISA', type: 'credit', country: 'FR', bank: 'BNP Paribas', category: 'premium' },
    { bin: '492973', brand: 'VISA', type: 'credit', country: 'AU', bank: 'Commonwealth Bank', category: 'premium' },
    { bin: '540117', brand: 'MASTERCARD', type: 'credit', country: 'AU', bank: 'Commonwealth Bank', category: 'premium' },
    { bin: '492972', brand: 'VISA', type: 'credit', country: 'NL', bank: 'ABN AMRO', category: 'premium' },
    { bin: '492977', brand: 'VISA', type: 'credit', country: 'SE', bank: 'Nordea', category: 'premium' },
    { bin: '492978', brand: 'VISA', type: 'credit', country: 'FI', bank: 'Nordea Finland', category: 'premium' },
];

const binManager = new BinManager();

// ==================== 4. ПРОКСИ-МЕНЕДЖЕР ====================

/**
 * Управление прокси: загрузка из файла/конфига, ротация.
 */
class ProxyManager {
    constructor() {
        this.proxies = [];
        this.currentIndex = 0;

        if (config.PROXY_LIST && fs.existsSync(config.PROXY_LIST)) {
            const lines = fs.readFileSync(config.PROXY_LIST, 'utf-8')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#'));
            for (const line of lines) {
                const p = parseProxy(line);
                if (p) this.proxies.push(p);
            }
        }

        if (this.proxies.length === 0 && config.PROXY) {
            const p = parseProxy(config.PROXY);
            if (p) this.proxies = [p];
        }
    }

    /**
     * Получить следующий прокси.
     * @returns {{server: string, username?: string, password?: string}|null}
     */
    getNext() {
        if (this.proxies.length === 0) return null;
        if (!config.PROXY_ROTATION) return this.proxies[0];
        const proxy = this.proxies[this.currentIndex % this.proxies.length];
        this.currentIndex++;
        return proxy;
    }
    get count() { return this.proxies.length; }
}

const proxyManager = new ProxyManager();

// ==================== 4.5 БИЛЛИНГ-МЕНЕДЖЕР ====================

/**
 * Управление профилями биллинга: ротация стран/адресов.
 * Поддерживает как новый формат (BILLING_PROFILES), так и старый (BILLING_COUNTRY и т.д.)
 */
class BillingManager {
    constructor() {
        this.currentIndex = 0;

        if (Array.isArray(config.BILLING_PROFILES) && config.BILLING_PROFILES.length > 0) {
            this.profiles = config.BILLING_PROFILES;
        } else {
            this.profiles = [{
                country: config.BILLING_COUNTRY || 'US',
                address: config.BILLING_ADDRESS || '350 5th Ave',
                city: config.BILLING_CITY || 'New York',
                zip: config.BILLING_ZIP || '10118',
            }];
        }
    }

    /**
     * Получить следующий профиль биллинга.
     * @returns {{country: string, address: string, city: string, zip: string}}
     */
    getNext() {
        if (this.profiles.length === 0) return { country: 'US', address: '350 5th Ave', city: 'New York', zip: '10118' };
        const profile = this.profiles[this.currentIndex % this.profiles.length];
        this.currentIndex++;
        return profile;
    }

    get count() { return this.profiles.length; }
}

const billingManager = new BillingManager();

// ==================== 4.6 МАППИНГ СТРАНА → TIMEZONE/LOCALE ====================

/**
 * Маппинг страны биллинга на timezone и locale.
 * Используется при BILLING_ROTATION=true для автоматической подстройки.
 */
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

/**
 * Получить timezone/locale для страны биллинга.
 * @param {string} country — ISO-код страны (US, DE, ...)
 * @returns {{timezone: string, locale: string}}
 */
function getTzLocaleForCountry(country) {
    return COUNTRY_TZ_LOCALE[country?.toUpperCase()] || { timezone: 'America/New_York', locale: 'en-US' };
}

// ==================== 5. ПОЧТОВЫЕ ПРОВАЙДЕРЫ ====================

/**
 * @typedef {Object} MailResult
 * @property {string} email - адрес ящика
 * @property {string} token - токен для доступа к письмам
 * @property {string} login - имя для файла сессии
 * @property {Function|null} cleanup - async функция удаления ящика (опционально)
 */

/**
 * Общий интерфейс почтового провайдера.
 * Методы: createEmail() → MailResult, waitForOtp(token, address) → string|null
 */

// ---------- MailTmProvider ----------

class MailTmProvider {
    constructor() {
        this.name = 'mail.tm';
    }

    /** @returns {Promise<MailResult>} */
    async createEmail() {
        let lastError = null;
        const retries = config.MAIL_RETRY_COUNT || 3;

        let attempt = 0;
        while (attempt < retries) {
            attempt++;
            try {
                log.info(`[Почта/mail.tm] Подключаемся (попытка ${attempt}/${retries})...`);

                const domainsRes = await fetchWithTimeout(config.MAIL_API_DOMAINS, {}, config.MAIL_TIMEOUT || 30000);
                if (!domainsRes.ok) {
                    if (domainsRes.status === 429) {
                        const retryAfter = domainsRes.headers.get('Retry-After');
                        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 15000;
                        log.warn(`[Почта/mail.tm] ⚠️ Rate limit (429), ждём ${waitMs / 1000}с...`);
                        await sleep(waitMs);
                        attempt--;
                        continue;
                    }
                    throw new Error(`mail.tm domains: HTTP ${domainsRes.status}`);
                }
                const domainsData = await domainsRes.json();
                if (!domainsData['hydra:member']?.length) throw new Error('mail.tm: нет доступных доменов');
                const domain = domainsData['hydra:member'][0].domain;

                const username = 'user_' + randomString(8);
                const emailPassword = 'pass_' + randomString(10);
                const email = `${username}@${domain}`;

                log.info(`[Почта/mail.tm] Создаем ящик: ${email}`);
                const accountRes = await fetchWithTimeout(config.MAIL_API_ACCOUNTS, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address: email, password: emailPassword })
                }, config.MAIL_TIMEOUT || 30000);
                if (!accountRes.ok) {
                    if (accountRes.status === 429) {
                        const retryAfter = accountRes.headers.get('Retry-After');
                        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 15000;
                        log.warn(`[Почта/mail.tm] ⚠️ Rate limit при создании (429), ждём ${waitMs / 1000}с...`);
                        await sleep(waitMs);
                        attempt--;
                        continue;
                    }
                    throw new Error(`mail.tm create account: HTTP ${accountRes.status}`);
                }

                const tokenRes = await fetchWithTimeout(config.MAIL_API_TOKEN, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address: email, password: emailPassword })
                }, config.MAIL_TIMEOUT || 30000);
                if (!tokenRes.ok) throw new Error(`mail.tm token: HTTP ${tokenRes.status}`);
                const tokenData = await tokenRes.json();
                if (!tokenData.token) throw new Error('mail.tm: токен не получен');

                log.success('[Почта/mail.tm] ✅ Ящик готов к приему писем');
                return { email, token: tokenData.token, login: username, cleanup: null };

            } catch (e) {
                lastError = e;
                log.warn(`[Почта/mail.tm] ⚠️ Попытка ${attempt} не удалась: ${e.message}`);
                if (attempt < retries) await sleep(config.MAIL_RETRY_DELAY || 3000);
            }
        }

        throw new Error(`mail.tm: не удалось создать почту за ${retries} попыток: ${lastError?.message}`);
    }

    /**
     * Ожидание OTP-кода из почты.
     * @param {string} token - токен доступа к ящику
     * @param {string} _address - адрес ящика (не используется mail.tm, для совместимости интерфейса)
     * @returns {Promise<string|null>} код или null
     */
    async waitForOtp(token, _address) {
        const pollInterval = config.DELAY_OTP_POLL || 3000;
        const maxAttempts = Math.floor((config.DELAY_OTP_WAIT || 75000) / pollInterval);
        const waitStart = Date.now();
        log.info(`[Почта/mail.tm] Ждём OTP-код (каждые ${pollInterval / 1000}с, ${maxAttempts} попыток)...`);

        const keywords = config.OTP_EMAIL_KEYWORDS || ['devin', 'verification', 'confirm', 'otp', 'code'];
        const contextRegex = _buildOtpContextRegex();
        const fallbackRegex = _buildOtpFallbackRegex();

        for (let i = 0; i < maxAttempts; i++) {
            if (shutdownRequested) return null;

            try {
                const res = await fetchWithTimeout(config.MAIL_API_MESSAGES, {
                    headers: { Authorization: `Bearer ${token}` }
                }, config.MAIL_TIMEOUT || 30000);

                if (!res.ok) {
                    if (res.status === 429) {
                        log.warn(`[Почта/mail.tm] ⚠️ Rate limit (429) при чтении, ждём...`);
                        await sleep(10000);
                        continue;
                    }
                    log.warn(`[Почта/mail.tm] ⚠️ HTTP ${res.status}`);
                } else {
                    const data = await res.json();
                    const messages = data['hydra:member'];

                    if (messages && messages.length > 0) {
                        const targetMsg = messages.find(m =>
                            (m.from?.address && keywords.some(kw => m.from.address.toLowerCase().includes(kw))) ||
                            (m.subject && keywords.some(kw => m.subject.toLowerCase().includes(kw)))
                        ) || messages[0];

                        log.success(`[Почта/mail.tm] ✅ Письмо! (от: ${targetMsg.from?.address || '?'}, тема: ${targetMsg.subject || '—'})`);

                        const msgRes = await fetchWithTimeout(`${config.MAIL_API_MESSAGES}/${targetMsg.id}`, {
                            headers: { Authorization: `Bearer ${token}` }
                        }, config.MAIL_TIMEOUT || 30000);

                        if (!msgRes.ok) {
                            if (msgRes.status === 429) {
                                log.warn('[Почта/mail.tm] ⚠️ Rate limit при чтении письма, ждём...');
                                await sleep(10000);
                                continue;
                            }
                            if (msgRes.status === 404) {
                                log.warn('[Почта/mail.tm] ⚠️ Письмо не найдено (404), возможно удалено');
                                continue;
                            }
                            log.warn(`[Почта/mail.tm] ⚠️ Ошибка чтения письма: HTTP ${msgRes.status}`);
                            continue;
                        }
                        const msgData = await msgRes.json();

                        const code = extractOtpFromText(msgData.text, msgData.html, contextRegex, fallbackRegex);
                        if (code) {
                            timingOptimizer.recordOtpWait('mailtm', Date.now() - waitStart);
                            return code;
                        }
                        log.warn('[Почта/mail.tm] ⚠️ Код не найден в тексте письма');
                        continue;
                    }
                }
            } catch (e) {
                log.warn(`[Почта/mail.tm] ⚠️ Ошибка: ${e.message}`);
            }

            if (i < maxAttempts - 1) {
                await sleep(pollInterval);
                log.dot();
            }
        }

        log.warn('\n[Почта/mail.tm] ❌ Письмо не пришло за отведённое время');
        return null;
    }
}

// ---------- CodaMailProvider (temp.coda.ink) ----------

class CodaMailProvider {
    constructor() {
        this.name = 'temp.coda.ink';
        this.apiBase = config.CODA_API_BASE || 'https://temp.coda.ink/v1';
        this.apiKey = config.CODA_API_KEY;
        this.provider = config.CODA_PROVIDER || 'tempmail';
        this.doCleanup = config.CODA_CLEANUP !== false;
    }

    /** @private Заголовки с авторизацией */
    _headers(token) {
        return { Authorization: `Bearer ${token || this.apiKey}`, 'Content-Type': 'application/json' };
    }

    /** @returns {Promise<MailResult>} */
    async createEmail() {
        let lastError = null;
        const retries = config.MAIL_RETRY_COUNT || 3;

        let attempt = 0;
        while (attempt < retries) {
            attempt++;
            try {
                log.info(`[Почта/coda] Создаём адрес (попытка ${attempt}/${retries}, provider: ${this.provider})...`);

                const body = this.provider ? { provider: this.provider } : {};

                const res = await fetchWithTimeout(`${this.apiBase}/address`, {
                    method: 'POST',
                    headers: this._headers(),
                    body: JSON.stringify(body),
                }, config.MAIL_TIMEOUT || 30000);

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    const errMsg = errData.error || `HTTP ${res.status}`;
                    if (res.status === 429) {
                        const retryAfter = res.headers.get('Retry-After');
                        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 20000;
                        log.warn(`[Почта/coda] ⚠️ Rate limit, ждём ${waitMs / 1000}с...`);
                        await sleep(waitMs);
                        attempt--;
                        continue;
                    }
                    throw new Error(`coda create: ${errMsg}`);
                }

                const json = await res.json();
                if (!json.success || !json.data) throw new Error(`coda: неожиданный ответ`);

                const { address, token } = json.data;
                if (!address || !token) throw new Error('coda: не получен адрес или токен');

                const login = address.split('@')[0];
                log.success(`[Почта/coda] ✅ Адрес создан: ${address}`);

                const capturedAddress = address;
                const capturedToken = token;
                const capturedApiBase = this.apiBase;
                const capturedHeaders = this._headers.bind(this);

                return {
                    email: address,
                    token: token,
                    login: login,
                    cleanup: this.doCleanup ? async () => {
                        try {
                            log.info(`[Почта/coda] 🧹 Удаляем адрес ${capturedAddress}...`);
                            const delRes = await fetchWithTimeout(
                                `${capturedApiBase}/address/${encodeURIComponent(capturedAddress)}`,
                                { method: 'DELETE', headers: capturedHeaders(capturedToken) },
                                config.MAIL_TIMEOUT || 30000
                            );
                            if (delRes.ok) log.success('[Почта/coda] ✅ Адрес удалён');
                            else log.warn(`[Почта/coda] ⚠️ Не удалось удалить: HTTP ${delRes.status}`);
                        } catch (e) {
                            log.warn(`[Почта/coda] ⚠️ Ошибка удаления: ${e.message}`);
                        }
                    } : null,
                };

            } catch (e) {
                lastError = e;
                log.warn(`[Почта/coda] ⚠️ Попытка ${attempt} не удалась: ${e.message}`);
                if (attempt < retries) await sleep(config.MAIL_RETRY_DELAY || 3000);
            }
        }

        throw new Error(`coda: не удалось создать почту за ${retries} попыток: ${lastError?.message}`);
    }

    /**
     * Ожидание OTP-кода через temp.coda.ink API.
     * @param {string} token - адресный токен (tm_at_...)
     * @param {string} address - email адрес
     * @returns {Promise<string|null>}
     */
    async waitForOtp(token, address) {
        const pollInterval = config.DELAY_OTP_POLL || 3000;
        const maxAttempts = Math.floor((config.DELAY_OTP_WAIT || 75000) / pollInterval);
        const waitStart = Date.now();
        log.info(`[Почта/coda] Ждём OTP-код (каждые ${pollInterval / 1000}с, ${maxAttempts} попыток)...`);

        const keywords = config.OTP_EMAIL_KEYWORDS || ['devin', 'verification', 'confirm', 'otp', 'code'];
        const contextRegex = _buildOtpContextRegex();
        const fallbackRegex = _buildOtpFallbackRegex();

        for (let i = 0; i < maxAttempts; i++) {
            if (shutdownRequested) return null;

            try {
                const listRes = await fetchWithTimeout(
                    `${this.apiBase}/address/${encodeURIComponent(address)}/emails`,
                    { headers: this._headers(token) },
                    config.MAIL_TIMEOUT || 30000
                );

                if (!listRes.ok) { log.warn(`[Почта/coda] ⚠️ HTTP ${listRes.status}`); }
                else {
                    const listData = await listRes.json();
                    const emails = listData.data;

                    if (emails && emails.length > 0) {
                        const targetEmail = emails.find(e =>
                            (e.from_address && keywords.some(kw => e.from_address.toLowerCase().includes(kw))) ||
                            (e.subject && keywords.some(kw => e.subject.toLowerCase().includes(kw)))
                        ) || emails[0];

                        log.success(`[Почта/coda] ✅ Письмо! (от: ${targetEmail.from_address || '?'}, тема: ${targetEmail.subject || '—'})`);

                        const msgRes = await fetchWithTimeout(
                            `${this.apiBase}/email/${targetEmail.id}`,
                            { headers: this._headers(token) },
                            config.MAIL_TIMEOUT || 30000
                        );
                        if (!msgRes.ok) {
                            log.warn(`[Почта/coda] ⚠️ Ошибка чтения письма: HTTP ${msgRes.status}`);
                            continue;
                        }
                        const msgData = await msgRes.json();

                        if (!msgData.success || !msgData.data) {
                            log.warn('[Почта/coda] ⚠️ Не удалось прочитать письмо');
                            continue;
                        }

                        const code = extractOtpFromText(msgData.data.body_text, msgData.data.body_html, contextRegex, fallbackRegex);
                        if (code) {
                            timingOptimizer.recordOtpWait('coda', Date.now() - waitStart);
                            return code;
                        }
                        log.warn('[Почта/coda] ⚠️ Код не найден в тексте письма');
                        continue;
                    }
                }
            } catch (e) {
                log.warn(`[Почта/coda] ⚠️ Ошибка: ${e.message}`);
            }

            if (i < maxAttempts - 1) {
                await sleep(pollInterval);
                log.dot();
            }
        }

        log.warn('\n[Почта/coda] ❌ Письмо не пришло за отведённое время');
        return null;
    }
}

// ---------- Общие утилиты для OTP ----------

/** @private Построить regex для контекстного поиска OTP */
function _buildOtpContextRegex() {
    try {
        return new RegExp(config.OTP_CONTEXT_REGEX || '(?:code|код|verify|verification|otp|pin)[^\\d]{0,30}(\\d{6})', 'i');
    } catch (e) {
        throw new Error(`Невалидный OTP_CONTEXT_REGEX "${config.OTP_CONTEXT_REGEX}": ${e.message}`);
    }
}

/** @private Построить regex для fallback поиска OTP */
function _buildOtpFallbackRegex() {
    try {
        return new RegExp(config.OTP_FALLBACK_REGEX || '\\b\\d{6}\\b');
    } catch (e) {
        throw new Error(`Невалидный OTP_FALLBACK_REGEX "${config.OTP_FALLBACK_REGEX}": ${e.message}`);
    }
}

/**
 * Извлечение OTP-кода из текста/HTML письма.
 * Приоритет: context match в text → fallback в text → context в HTML → fallback в HTML
 * @param {string} text - plain text письма
 * @param {string} html - HTML письма
 * @param {RegExp} contextRegex - regex с capture group для кода рядом с ключевыми словами
 * @param {RegExp} fallbackRegex - regex для простого поиска N-значного кода
 * @returns {string|null} код или null
 */
function extractOtpFromText(text, html, contextRegex, fallbackRegex) {
    const textStr = typeof text === 'string'
        ? text
        : (text == null ? '' : JSON.stringify(text));
    const htmlStr = Array.isArray(html)
        ? html.join('\n')
        : (typeof html === 'string' ? html : (html == null ? '' : JSON.stringify(html)));

    const contextMatch = textStr.match(contextRegex);
    if (contextMatch) {
        log.success(`[Почта] 🎉 Код извлечён (context): ${contextMatch[1]}`);
        return contextMatch[1];
    }

    const fallbackMatch = textStr.match(fallbackRegex);
    if (fallbackMatch) {
        log.success(`[Почта] 🎉 Код извлечён (fallback): ${fallbackMatch[0]}`);
        return fallbackMatch[0];
    }

    if (htmlStr) {
        const htmlContext = htmlStr.match(contextRegex);
        if (htmlContext) {
            log.success(`[Почта] 🎉 Код извлечён (HTML context): ${htmlContext[1]}`);
            return htmlContext[1];
        }
        const htmlFallback = htmlStr.match(fallbackRegex);
        if (htmlFallback) {
            log.success(`[Почта] 🎉 Код извлечён (HTML fallback): ${htmlFallback[0]}`);
            return htmlFallback[0];
        }
    }

    return null;
}

/**
 * Фабрика почтового провайдера по конфигу.
 * @returns {MailTmProvider|CodaMailProvider}
 * @throws {Error} если конфигурация некорректна
 */
function createMailProvider(providerName) {
    const provider = normalizeMailProvider(providerName || config.MAIL_PROVIDER);
    switch (provider) {
        case 'coda':
            if (!config.CODA_API_KEY) {
                throw new Error('MAIL_PROVIDER=coda, но CODA_API_KEY не указан — задайте в конфиге или через переменную окружения');
            }
            return new CodaMailProvider();
        case 'mailtm':
        default:
            return new MailTmProvider();
    }
}

/**
 * MailManager — обёртка над почтовыми провайдерами с авто-переключением.
 * Если основной провайдер падает N раз подряд — переключается на запасной.
 * Отслеживает health-score и восстанавливает основной после cooldown.
 */
class MailManager {
    constructor() {
        this.primaryName = normalizeMailProvider(config.MAIL_PROVIDER);
        this.fallbackEnabled = config.MAIL_FALLBACK !== false;
        this.failThreshold = config.MAIL_FALLBACK_THRESHOLD || 3;
        this.cooldownMs = config.MAIL_FALLBACK_COOLDOWN_MS || 300000;

        this.providers = {};
        this.currentName = this.primaryName;
        this.failCounts = {};
        this.cooldownUntil = {};
        this.switchLog = [];

        this.providers[this.primaryName] = this._tryCreate(this.primaryName);

        this.fallbackName = this.primaryName === 'coda' ? 'mailtm' : 'coda';
        if (this.fallbackEnabled && this.fallbackName === 'coda' && config.CODA_API_KEY) {
            this.providers[this.fallbackName] = this._tryCreate(this.fallbackName);
        } else if (this.fallbackEnabled && this.fallbackName === 'mailtm') {
            this.providers[this.fallbackName] = this._tryCreate(this.fallbackName);
        }

        this.failCounts[this.primaryName] = 0;
        this.failCounts[this.fallbackName] = 0;
    }

    _tryCreate(name) {
        try {
            return createMailProvider(name);
        } catch {
            return null;
        }
    }

    get name() {
        const p = this.providers[this.currentName];
        return p ? p.name : this.currentName;
    }

    get activeProvider() {
        return this.providers[this.currentName];
    }

    /** Проверить, можно ли использовать провайдера (не на cooldown ли) */
    _isAvailable(name) {
        if (!this.providers[name]) return false;
        const until = this.cooldownUntil[name];
        if (!until) return true;
        if (Date.now() >= until) {
            delete this.cooldownUntil[name];
            return true;
        }
        return false;
    }

    /** Выбрать лучшего доступного провайдера */
    _pickProvider() {
        if (this._isAvailable(this.primaryName)) {
            if (this.currentName !== this.primaryName) {
                log.info(`[Почта] 🔄 Возвращаемся к основному провайдеру: ${this.primaryName}`);
                this.currentName = this.primaryName;
            }
            return this.providers[this.primaryName];
        }
        if (this.fallbackEnabled && this._isAvailable(this.fallbackName)) {
            if (this.currentName !== this.fallbackName) {
                const reason = this.providers[this.primaryName] ? 'на cooldown' : 'недоступен';
                log.warn(`[Почта] ⚠️ Основной провайдер ${this.primaryName} ${reason} — переключаемся на ${this.fallbackName}`);
                this.currentName = this.fallbackName;
                this.switchLog.push({ from: this.primaryName, to: this.fallbackName, at: new Date().toISOString() });
            }
            return this.providers[this.fallbackName];
        }
        log.warn(`[Почта] ⚠️ Оба провайдера недоступны — пробуем основного`);
        this.currentName = this.primaryName;
        return this.providers[this.primaryName];
    }

    /** Записать успех — сбрасываем счётчик ошибок */
    recordSuccess() {
        this.failCounts[this.currentName] = 0;
    }

    /** Записать ошибку — увеличиваем счётчик, при достижении порога ставим на cooldown */
    recordFailure() {
        this.failCounts[this.currentName] = (this.failCounts[this.currentName] || 0) + 1;
        const count = this.failCounts[this.currentName];
        log.warn(`[Почта] ⚠️ Провайдер ${this.currentName}: ${count}/${this.failThreshold} ошибок подряд`);

        if (count >= this.failThreshold) {
            this.cooldownUntil[this.currentName] = Date.now() + this.cooldownMs;
            log.warn(`[Почта] ⛔ Провайдер ${this.currentName} поставлен на cooldown ${this.cooldownMs / 1000}с (${count} ошибок подряд)`);
            this.failCounts[this.currentName] = 0;
        }
    }

    /** Есть ли запасной провайдер */
    get hasFallback() {
        return this.fallbackEnabled && !!this.providers[this.fallbackName];
    }

    /** Информация о состоянии для doctor/summary */
    getStatusInfo() {
        const info = [];
        for (const [name, provider] of Object.entries(this.providers)) {
            if (!provider) continue;
            const isPrimary = name === this.primaryName;
            const isActive = name === this.currentName;
            const onCooldown = !!this.cooldownUntil[name] && Date.now() < this.cooldownUntil[name];
            const fails = this.failCounts[name] || 0;
            info.push({ name, isPrimary, isActive, onCooldown, fails });
        }
        return info;
    }

    /** Создать email через текущего провайдера */
    async createEmail() {
        const provider = this._pickProvider();
        if (!provider) throw new Error(`Нет доступного почтового провайдера`);
        return provider.createEmail();
    }

    /** Дождаться OTP через текущего провайдера */
    async waitForOtp(token, address) {
        const provider = this.activeProvider || this._pickProvider();
        if (!provider) return null;
        return provider.waitForOtp(token, address);
    }
}

let mailProvider;
let mailManager;
try {
    mailManager = new MailManager();
    mailProvider = mailManager.activeProvider || mailManager._pickProvider();
} catch (e) {
    mailProvider = null;
    mailManager = null;
    process._mailProviderError = e;
}

// ==================== 6. ВАЛИДАЦИЯ CONFIG ====================

function validateConfig() {
    const bins = Array.isArray(config.BINS) ? config.BINS : (config.BINS ? [config.BINS] : []);
    if (bins.length > 0 && !bins.every(b => !b)) {
        for (const bin of bins) {
            if (!bin) continue;
            if (!/^\d{6,12}$/.test(bin)) {
                throw new Error(`BIN "${bin}" — должен быть 6-12 цифр`);
            }
            const cardLength = config.CARD_LENGTH === 'auto'
                ? (detectCardLength(bin) || 16)
                : Number(config.CARD_LENGTH ?? 16);
            if (!Number.isInteger(cardLength) || cardLength < 13 || cardLength > 19) {
                throw new Error(`CARD_LENGTH "${config.CARD_LENGTH}" — должно быть 13-19 или "auto"`);
            }
            const needed = cardLength - bin.length - 1;
            if (needed < 0) {
                throw new Error(`BIN "${bin}" слишком длинный для ${cardLength}-значной карты`);
            }
        }
    }

    const expMatch = config.EXP_DATE.match(/^(\d{2})\/(\d{2})$|^auto$|^$/);
    if (!expMatch) {
        throw new Error(`EXP_DATE "${config.EXP_DATE}" — формат MM/YY, "auto" или пусто`);
    }
    if (config.EXP_DATE !== 'auto' && config.EXP_DATE !== '') {
        const month = parseInt(config.EXP_DATE.match(/^(\d{2})/)[1], 10);
        if (month < 1 || month > 12) {
            throw new Error(`EXP_DATE месяц — должен быть 01-12`);
        }
    }

    if (config.CVC_CODE !== 'auto' && config.CVC_CODE !== '' && !/^\d{3,4}$/.test(config.CVC_CODE)) {
        throw new Error(`CVC_CODE "${config.CVC_CODE}" — 3-4 цифры, "auto" или пусто`);
    }

    if (!config.ACCOUNT_PASSWORD || config.ACCOUNT_PASSWORD.length < 4) {
        throw new Error('ACCOUNT_PASSWORD — минимум 4 символа');
    }

    if (config.PROXY) {
        if (!parseProxy(config.PROXY)) {
            throw new Error(`PROXY "${config.PROXY}" — формат: http://user:pass@ip:port`);
        }
    }

    if (config.PROXY_LIST && !fs.existsSync(config.PROXY_LIST)) {
        throw new Error(`PROXY_LIST файл "${config.PROXY_LIST}" не найден`);
    }

    const providerName = normalizeMailProvider(config.MAIL_PROVIDER);
    if (providerName === 'coda' && !config.CODA_API_KEY) {
        if (mailManager && mailManager.hasFallback) {
            log.warn('[Config] ⚠️ CODA_API_KEY не указан, но fallback на mail.tm доступен — продолжаем');
        } else {
            throw new Error('MAIL_PROVIDER=coda, но CODA_API_KEY не указан — задайте в конфиге или включите MAIL_FALLBACK');
        }
    }

    if (config.MAIL_FALLBACK !== false && config.MAIL_FALLBACK_THRESHOLD !== undefined) {
        const t = Number(config.MAIL_FALLBACK_THRESHOLD);
        if (!Number.isInteger(t) || t < 1 || t > 20) {
            throw new Error('MAIL_FALLBACK_THRESHOLD — целое число от 1 до 20');
        }
    }
    if (config.MAIL_FALLBACK_COOLDOWN_MS !== undefined) {
        const c = Number(config.MAIL_FALLBACK_COOLDOWN_MS);
        if (!Number.isInteger(c) || c < 10000 || c > 3600000) {
            throw new Error('MAIL_FALLBACK_COOLDOWN_MS — целое число от 10000 до 3600000 (10с–1ч)');
        }
    }

    for (const dir of [config.READY_DIR, config.ERROR_DIR]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    log.success('[✓] Config прошёл валидацию');
}

/** Проверка доступности почтового API перед запуском (read-only) */
async function healthCheck() {
    log.info('[Health] Проверяем доступность почтового API...');
    const results = {};

    const primaryName = normalizeMailProvider(config.MAIL_PROVIDER);
    results[primaryName] = await _checkProviderHealth(primaryName);

    if (mailManager && mailManager.hasFallback) {
        results[mailManager.fallbackName] = await _checkProviderHealth(mailManager.fallbackName);
    }

    const anyOk = Object.values(results).some(v => v);
    if (!anyOk) {
        log.warn('[Health] ⚠️ Ни один почтовый API недоступен!');
    }
    return anyOk;
}

async function _checkProviderHealth(providerName) {
    try {
        const name = normalizeMailProvider(providerName);
        if (name === 'coda') {
            if (!config.CODA_API_KEY) {
                log.warn(`[Health] ⚠️ Coda: нет API-ключа`);
                return false;
            }
            const res = await fetchWithTimeout(`${config.CODA_API_BASE}/address`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${config.CODA_API_KEY}` },
            }, 15000);
            if (res.status < 500) {
                log.success(`[Health] ✅ Coda API доступен (HTTP ${res.status})`);
                return true;
            }
            log.warn(`[Health] ⚠️ Coda API вернул ${res.status}`);
            return false;
        } else {
            const res = await fetchWithTimeout(config.MAIL_API_DOMAINS, {}, 15000);
            if (res.status < 500) {
                log.success(`[Health] ✅ mail.tm API доступен (HTTP ${res.status})`);
                return true;
            }
            log.warn(`[Health] ⚠️ mail.tm вернул ${res.status}`);
            return false;
        }
    } catch (e) {
        log.warn(`[Health] ⚠️ ${normalizeMailProvider(providerName)} API недоступен: ${e.message}`);
        return false;
    }
}

// ==================== 7. BROWSER AUTOMATION ====================

/**
 * Человекоподобный ввод текста в поле.
 * Ищет поле по CSS-селектору во всех фреймах, очищает, вводит посимвольно.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector - CSS-селектор
 * @param {string} value - значение для ввода
 * @param {string} fieldName - название поля для логов
 * @param {Object} [options]
 * @param {boolean} [options.clearFirst=true] - очистить поле перед вводом
 * @param {boolean} [options.pressEnter=false] - нажать Enter после ввода
 * @returns {Promise<boolean>} true если поле найдено и заполнено
 */
async function humanType(page, selector, value, fieldName, options = {}) {
    const { clearFirst = true, pressEnter = false } = options;
    const delayConfig = config.DELAY_TYPING || [40, 100];
    const isRange = Array.isArray(delayConfig);

    for (let retry = 0; retry < 10; retry++) {
        if (shutdownRequested) return false;

        for (const frame of page.frames()) {
            try {
                const loc = frame.locator(selector).first();
                if (await loc.count() > 0 && await loc.isVisible()) {
                    await loc.click();
                    await page.waitForTimeout(300 + randomDelay(0, 400));

                    if (clearFirst) {
                        try {
                            await loc.fill('');
                        } catch {
                            try {
                                await loc.click({ clickCount: 3 });
                                await page.keyboard.press('Backspace');
                            } catch { }
                        }
                        await page.waitForTimeout(100);
                    }

                    if (isRange) {
                        for (const ch of value) {
                            await loc.pressSequentially(ch, { delay: getDelay(delayConfig) });
                        }
                    } else {
                        await loc.pressSequentially(value, { delay: delayConfig });
                    }

                    if (pressEnter) {
                        await page.waitForTimeout(200 + randomDelay(0, 300));
                        await page.keyboard.press('Enter');
                    }

                    log.info(`  ✅ ${fieldName}`);
                    return true;
                }
            } catch { }
        }
        await page.waitForTimeout(500);
    }
    log.warn(`  ❌ ${fieldName} — поле не найдено`);
    return false;
}

/** Пауза между действиями — имитация человека */
async function humanPause(page) {
    await page.waitForTimeout(getDelay(config.DELAY_BETWEEN_ACTIONS || [200, 500]));
}

/** Сохранить скриншот страницы */
async function saveScreenshot(page, dirPath, label) {
    if (!config.SCREENSHOT_ON_ERROR) return;
    try {
        const p = path.join(dirPath, `${label}_screenshot.png`);
        await page.screenshot({ path: p, fullPage: true });
        log.info(`[Скриншот] 📸 Сохранён: ${p}`);
    } catch (e) {
        log.warn(`[Скриншот] ⚠️ Не удалось: ${e.message}`);
    }
}

/** Сохранить сессию Playwright в файл */
async function saveSession(context, sessionFile) {
    try {
        await context.storageState({ path: sessionFile });
        return true;
    } catch (e) {
        log.warn(`[Сессия] ⚠️ Не удалось сохранить: ${e.message}`);
        return false;
    }
}

/** Отправить вебхук-уведомление */
async function sendWebhook(payload) {
    if (!config.WEBHOOK_URL) return;
    try {
        await fetchWithTimeout(config.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() })
        }, config.WEBHOOK_TIMEOUT || 10000);
        log.info('[Webhook] ✅ Уведомление отправлено');
    } catch (e) {
        log.warn(`[Webhook] ⚠️ Ошибка: ${e.message}`);
    }
}

/**
 * Получить stealth-скрипт для page.addInitScript.
 * Поддерживает ротацию fingerprint: каждый вызов — новый случайный набор.
 * @param {'none'|'basic'|'advanced'} level
 * @param {number} [accountIndex] — индекс аккаунта для ротации
 * @returns {Function|null}
 */
function getStealthScript(level, accountIndex, localeOverride) {
    if (level === 'none') return null;

    const basic = () => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    };

    const webglVendor = config.WEBGL_VENDOR || 'Google Inc. (NVIDIA)';
    const webglRenderer = config.WEBGL_RENDERER || 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)';

    let fpVendor = webglVendor;
    let fpRenderer = webglRenderer;
    let fpViewport = config.VIEWPORT || { width: 1920, height: 1080 };
    const fpLocale = localeOverride || config.LOCALE || 'en-US';
    const languageList = [fpLocale, fpLocale.split('-')[0]].filter((v, i, arr) => v && arr.indexOf(v) === i);

    if (config.FINGERPRINT_ROTATION && accountIndex !== undefined) {
        const fpSet = getRandomFingerprint(accountIndex);
        fpVendor = fpSet.webglVendor;
        fpRenderer = fpSet.webglRenderer;
        fpViewport = fpSet.viewport;
    }

    const advanced = () => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        const pluginArray = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer',
              description: 'Portable Document Format', length: 1,
              0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }
            },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
              description: '', length: 1,
              0: { type: 'application/pdf', suffixes: 'pdf', description: '' }
            },
            { name: 'Native Client', filename: 'internal-nacl-plugin',
              description: '', length: 2,
              0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
              1: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' }
            }
        ];
        pluginArray.length = 3;
        Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });
        Object.defineProperty(navigator, 'languages', { get: () => languageList });

        if (!window.chrome) window.chrome = {};
        window.chrome.runtime = {
            connect: function() {}, sendMessage: function() {},
            PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
            PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' }
        };

        const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters)
        );

        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return fpVendor;
            if (param === 37446) return fpRenderer;
            return getParameter.call(this, param);
        };

        if (!navigator.connection) {
            Object.defineProperty(navigator, 'connection', {
                get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false })
            });
        }
    };

    if (level === 'basic') return basic;
    return advanced;
}

/**
 * База fingerprint-ов для ротации.
 * Каждый набор = уникальный GPU + viewport.
 */
const FINGERPRINT_PROFILES = [
    { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)', viewport: { width: 1920, height: 1080 } },
    { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER, OpenGL 4.5)', viewport: { width: 1920, height: 1080 } },
    { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060, OpenGL 4.5)', viewport: { width: 2560, height: 1440 } },
    { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)', viewport: { width: 1920, height: 1080 } },
    { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070, OpenGL 4.5)', viewport: { width: 2560, height: 1440 } },
    { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080, OpenGL 4.5)', viewport: { width: 2560, height: 1440 } },
    { webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.5)', viewport: { width: 1920, height: 1080 } },
    { webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon RX 5700 XT, OpenGL 4.5)', viewport: { width: 2560, height: 1440 } },
    { webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT, OpenGL 4.5)', viewport: { width: 1920, height: 1080 } },
    { webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)', viewport: { width: 1920, height: 1080 } },
    { webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.5)', viewport: { width: 1536, height: 864 } },
    { webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) HD Graphics 620, OpenGL 4.5)', viewport: { width: 1366, height: 768 } },
    { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1070, OpenGL 4.5)', viewport: { width: 1920, height: 1080 } },
    { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti, OpenGL 4.5)', viewport: { width: 2560, height: 1440 } },
    { webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6800 XT, OpenGL 4.5)', viewport: { width: 3840, height: 2160 } },
];

/**
 * Получить случайный fingerprint по индексу аккаунта.
 * @param {number} accountIndex
 * @returns {Object} { webglVendor, webglRenderer, viewport }
 */
function getRandomFingerprint(accountIndex) {
    return FINGERPRINT_PROFILES[accountIndex % FINGERPRINT_PROFILES.length];
}

// ==================== 8. ЭКСПОРТ СЕССИИ ====================

/**
 * Санитизация пути — удаление информации о системе пользователя.
 * Заменяет абсолютные пути на относительные, убирает имя пользователя.
 * @param {string} text
 * @returns {string}
 */
function sanitizePath(text) {
    if (!text) return text;
    return text
        .replace(/[A-Z]:\\Users\\[^\\]+\\/gi, '~/')
        .replace(/\/home\/[^/]+\//g, '~/')
        .replace(/\/Users\/[^/]+\//g, '~/');
}

/**
 * Экспорт аккаунта: cookies.json, localstorage.js, session.json, инструкция.
 * @param {string} sessionFile - путь к файлу сессии Playwright
 * @param {string} email
 * @param {string} password
 * @param {string} orgName
 * @param {string} cardUsed
 * @param {boolean|string} success
 * @param {import('playwright').Page} [page]
 * @returns {string} путь к папке экспорта
 */
async function exportAccount(sessionFile, email, password, orgName, cardUsed, success, page) {
    const mode = success === 'dry_run' ? 'dry_run' : (success ? 'success' : 'error');
    const label = mode === 'success' ? 'Pro' : (mode === 'dry_run' ? 'DryRun' : 'Error');
    const baseDir = mode === 'success' ? config.READY_DIR : (mode === 'dry_run' ? config.ARCHIVE_DIR : config.ERROR_DIR);
    const accountDir = makeFolderName(baseDir, label, orgName);
    if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });

    if (mode === 'error' && page) {
        await saveScreenshot(page, accountDir, 'error');
    }

    let sessionData;
    let sessionFileContent;
    try {
        sessionFileContent = fs.readFileSync(sessionFile, 'utf-8');
        sessionData = JSON.parse(sessionFileContent);
    } catch (e) {
        log.warn(`[Экспорт] ⚠️ Не удалось прочитать session: ${e.message}`);
        fs.writeFileSync(path.join(accountDir, 'error.txt'), `Session file error: ${e.message}`, 'utf-8');
        try { fs.unlinkSync(sessionFile); } catch { }
        return accountDir;
    }

    // ---- cookies.json ----
    const devinCookies = (Array.isArray(sessionData.cookies) ? sessionData.cookies : [])
        .filter(c => c.domain && c.domain.includes('devin.ai'));
    const cookieFormat = devinCookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain,
        hostOnly: !c.domain.startsWith('.'), path: c.path || '/',
        secure: c.secure || false, httpOnly: c.httpOnly || false,
        sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite || 'lax').toLowerCase(),
        session: c.expires === -1, expirationDate: c.expires === -1 ? undefined : c.expires,
        storeId: '0'
    }));
    fs.writeFileSync(path.join(accountDir, 'cookies.json'), JSON.stringify(cookieFormat, null, 2), 'utf-8');

    // ---- localstorage.js ----
    let consoleScript = '// Вставь это в консоль браузера на странице app.devin.ai\n// (F12 → Console → вставить → Enter)\n\n';

    const devinOrigin = sessionData.origins?.find(o => o.origin === 'https://app.devin.ai');
    if (devinOrigin && Array.isArray(devinOrigin.localStorage) && devinOrigin.localStorage.length > 0) {
        const importantKeys = ['auth1_session', 'known-org-ids', 'last-internal-org', 'migrated-to-unscoped'];
        const items = devinOrigin.localStorage.filter(item =>
            importantKeys.some(key => item.name.includes(key))
        );

        for (const item of items) {
            const escapedKey = JSON.stringify(item.name);
            const escapedValue = JSON.stringify(item.value);
            consoleScript += `localStorage.setItem(${escapedKey}, ${escapedValue});\n`;
        }
    }
    consoleScript += '\n';
    fs.writeFileSync(path.join(accountDir, 'localstorage.js'), consoleScript, 'utf-8');

    // ---- session.json ----
    fs.writeFileSync(path.join(accountDir, 'session.json'), sessionFileContent, 'utf-8');

    // ---- Инструкция_входа.txt (только для успешных) ----
    if (mode === 'success') {
        const maskedCard = cardUsed.length > 4
            ? '****' + cardUsed.slice(-4)
            : cardUsed;

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
            `  Карта:    ${maskedCard}`,
            '',
            '  ⚠️ Вход через логин/пароль НЕ работает — используйте сессию ниже!',
            '',
            '════════════════════════════════════════',
            '  ЧТО В ЭТОЙ ПАПКЕ?',
            '════════════════════════════════════════',
            '',
            '  📄 Инструкция_входа.txt  — этот файл',
            '  📄 cookies.json          — куки для Cookie-Editor',
            '  📄 localstorage.js       — скрипт для localStorage через консоль',
            '  📄 session.json          — полная сессия Playwright',
            '',
            '════════════════════════════════════════',
            '  ШАГ 1: ВСТАВКА COOKIES',
            '════════════════════════════════════════',
            '',
            '  1. Установите Cookie-Editor:',
            '     https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm',
            '  2. Откройте https://app.devin.ai',
            '  3. Нажмите иконку Cookie-Editor → Delete All',
            '  4. Import → вставьте содержимое cookies.json → Import',
            '',
            '════════════════════════════════════════',
            '  ШАГ 2: ВСТАВКА LOCALSTORAGE',
            '════════════════════════════════════════',
            '',
            '  1. На странице https://app.devin.ai нажмите F12',
            '  2. Console → вставьте содержимое localstorage.js → Enter',
            '  3. Должны увидеть: "✅ localStorage установлен!"',
            '',
            '════════════════════════════════════════',
            '  ШАГ 3: ПЕРЕЗАГРУЗКА',
            '════════════════════════════════════════',
            '',
            '  Нажмите F5 — вы вошли в Devin AI Pro Trial!',
            '',
            '════════════════════════════════════════',
            '  ВОЗМОЖНЫЕ ПРОБЛЕМЫ',
            '════════════════════════════════════════',
            '',
            '  ❌ Не работает? → Удалите старые куки, вставьте localStorage ПОСЛЕ cookies',
            '  ❌ Сессия истекла? → Зарегистрируйте новый аккаунт скриптом',
        ].join('\n');

        const sanitizedInstructions = sanitizePath(instructions);
        fs.writeFileSync(path.join(accountDir, 'Инструкция_входа.txt'), sanitizedInstructions, 'utf-8');
    }

    try { fs.unlinkSync(sessionFile); } catch { }

    log.success(`[Экспорт] 📦 Сохранено: ${sanitizePath(accountDir)}`);
    return accountDir;
}

// ==================== 9. ЦВЕТНОЙ СТАТУС-БАР ====================

/**
 * Вывод цветного статус-бара с живой статистикой.
 * @param {number} current - текущий номер аккаунта (0-based)
 * @param {number} total - общее количество (Infinity если бесконечно)
 */
function printStatusBar(current, total) {
    const isInf = total === Infinity || !isFinite(total);
    const current1 = current + 1;
    const totalStr = isInf ? '∞' : total;
    const pct = isInf ? '' : ` (${((current1 / total) * 100).toFixed(0)}%)`;

    const elapsed = Math.round((Date.now() - stats.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    const successRate = (stats.successCount + stats.failCount) > 0
        ? ((stats.successCount / (stats.successCount + stats.failCount)) * 100).toFixed(0)
        : '—';

    const GREEN = '\x1b[32m';
    const RED = '\x1b[31m';
    const YELLOW = '\x1b[33m';
    const CYAN = '\x1b[36m';
    const BOLD = '\x1b[1m';
    const RESET = '\x1b[0m';

    const bar = [
        `${BOLD}${CYAN}[${current1}/${totalStr}]${pct}${RESET}`,
        `${GREEN}✅${stats.successCount}${RESET}`,
        `${RED}❌${stats.failCount}${RESET}`,
        `${YELLOW}⏱${mins}м${secs}с${RESET}`,
        `📊${successRate}%`,
        `${binManager.getStatsLine()}`,
    ].join(' │ ');

    log.info(`\n${bar}`);
}

// ==================== 10. ОСНОВНОЙ СКРИПТ ====================

/**
 * @typedef {Object} AccountResult
 * @property {boolean} success - true если аккаунт успешно создан с Pro Trial
 * @property {string} category - категория результата: 'SUCCESS' | 'PAYMENT_ERROR' | 'BROWSER_ERROR' | 'MAIL_ERROR' | 'CAPTCHA_ERROR' | 'TIMEOUT_ERROR' | 'UNKNOWN_ERROR'
 * @property {boolean} retryable - true если имеет смысл повторить попытку
 */

/**
 * Регистрация одного аккаунта Devin AI.
 * @param {number} accountIndex - порядковый номер (для ротации BIN/прокси)
 * @param {number} totalCount - общее количество аккаунтов (для прогресса)
 * @returns {Promise<AccountResult>} результат с категорией и retryable-флагом
 */
async function registerAccount(accountIndex, totalCount) {
    const accountStart = Date.now();
    const bin = binManager.getNext(accountIndex);
    const billing = billingManager.getNext();
    let activeLocale = config.LOCALE || 'en-US';

    const totalDisplay = totalCount === Infinity ? '∞' : totalCount;
    const pctDisplay = totalCount === Infinity ? '' : ` (${(((accountIndex + 1) / totalCount) * 100).toFixed(0)}%)`;
    log.info(`\n${'═'.repeat(50)}`);
    log.info(`  🔄 [${accountIndex + 1}/${totalDisplay}]${pctDisplay} Регистрация аккаунта...`);
    log.info(`${'═'.repeat(50)}`);

    let mailResult;
    try {
        mailResult = await (mailManager || mailProvider).createEmail();
    } catch (e) {
        log.error(`[Почта] ❌ Не удалось создать email: ${enhancedErrorMessage(e)}`);
        if (mailManager) mailManager.recordFailure();
        const elapsed = Date.now() - accountStart;
        stats.failCount++;
        stats.totalTimeFail += elapsed;
        timingOptimizer.recordAccount(false, elapsed, 'MAIL_ERROR');
        return { success: false, category: 'MAIL_ERROR', retryable: true };
    }
    const email = mailResult.email;
    const mailToken = mailResult.token;
    const login = mailResult.login;
    const mailCleanup = mailResult.cleanup || null;
    let mailCleanupDone = false;
    const password = config.ACCOUNT_PASSWORD;
    const sessionFile = path.join(os.tmpdir(), `devin_session_${login}.json`);
    const runMailCleanupOnce = async () => {
        if (!mailCleanup || mailCleanupDone) return;
        mailCleanupDone = true;
        await mailCleanup();
    };

    log.info(`[Браузер] Запускаем Chromium (BIN: ${bin})...`);

    const launchOptions = {
        headless: config.HEADLESS,
        args: [
            '--disable-blink-features=AutomationControlled',
            ...(config.BROWSER_ARGS || [])
        ]
    };

    const proxyConfig = proxyManager.getNext();
    if (proxyConfig) {
        launchOptions.proxy = proxyConfig;
        log.success(`[Прокси] ✅ Подключен: ${proxyConfig.server}`);
    } else {
        log.info('[Прокси] Без прокси — прямой запуск');
    }

    let browser;
    let context;
    try {
        browser = await chromium.launch(launchOptions);
    } catch (e) {
        log.error(`[Браузер] ❌ Не удалось запустить: ${e.message} — проверьте установку Chromium: npx playwright install chromium`);
        const elapsed = Date.now() - accountStart;
        stats.failCount++;
        stats.totalTimeFail += elapsed;
        timingOptimizer.recordAccount(false, elapsed, 'BROWSER_ERROR');
        try { await runMailCleanupOnce(); } catch { }
        return { success: false, category: 'BROWSER_ERROR', retryable: true };
    }

    let page;
    try {
        const fp = config.FINGERPRINT_ROTATION ? getRandomFingerprint(accountIndex) : null;
        const viewport = fp ? fp.viewport : (config.VIEWPORT || { width: 1920, height: 1080 });

        const tzLocale = config.BILLING_ROTATION ? getTzLocaleForCountry(billing.country) : null;
        const timezoneId = tzLocale ? tzLocale.timezone : (config.TIMEZONE || 'America/New_York');
        const locale = tzLocale ? tzLocale.locale : (config.LOCALE || 'en-US');
        activeLocale = locale;
        const screen = fp ? fp.viewport : (config.SCREEN || viewport);

        const contextOptions = {
            timezoneId,
            locale,
            viewport,
            screen,
        };
        if (config.USER_AGENT) {
            contextOptions.userAgent = config.USER_AGENT;
        }

        context = await browser.newContext(contextOptions);
        page = await context.newPage();

        if (config.BILLING_ROTATION && tzLocale) {
            log.info(`[Браузер] 🌍 Ротация биллинга: ${billing.country} → TZ=${timezoneId}, locale=${locale}`);
        }
        if (config.FINGERPRINT_ROTATION && fp) {
            log.info(`[Браузер] 🖥️ Ротация FP: ${viewport.width}x${viewport.height}, ${fp.webglRenderer.match(/(?:GeForce|Radeon|UHD|Iris|HD) .+?(?=,)/)?.[0] || 'rotated'}`);
        }
    } catch (e) {
        log.error(`[Браузер] ❌ Не удалось создать контекст/страницу: ${e.message}`);
        const elapsed = Date.now() - accountStart;
        stats.failCount++;
        stats.totalTimeFail += elapsed;
        timingOptimizer.recordAccount(false, elapsed, 'BROWSER_ERROR');
        try { await browser.close(); } catch { }
        try { await runMailCleanupOnce(); } catch { }
        return { success: false, category: 'BROWSER_ERROR', retryable: true };
    }

    if (config.STEALTH_ENABLED) {
        const stealthScript = getStealthScript(config.STEALTH_LEVEL || 'advanced', accountIndex, activeLocale);
        if (stealthScript) {
            await page.addInitScript(stealthScript);
            const fpInfo = config.FINGERPRINT_ROTATION
                ? ` | FP: ${FINGERPRINT_PROFILES[accountIndex % FINGERPRINT_PROFILES.length].webglRenderer.match(/(?:GeForce|Radeon|UHD|Iris|HD) .+?(?=,)/)?.[0] || 'rotated'}`
                : '';
            log.info(`[Stealth] ✅ Уровень: ${config.STEALTH_LEVEL || 'advanced'}${fpInfo}`);
        }
    }

    let orgName = login.replace(/_/g, '-');
    let cardUsed = '';
    let paymentConfirmed = false;
    /** BIN который реально использовался для оплаты (может отличаться от начального при ротации) */
    let actualBin = bin;

    try {
        // ════════════════════════════════════════════
        //   РЕГИСТРАЦИЯ
        // ════════════════════════════════════════════

        log.info('[Браузер] Переходим на страницу регистрации...');
        await page.goto('https://app.devin.ai/auth/signup', { waitUntil: 'domcontentloaded', timeout: 120000 });

                await page.waitForTimeout(1000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);

        log.info('[Браузер] Вводим Email...');
        await humanType(page, "input[placeholder='Email address'], input[type='email'], input[name='email']", email, 'Email', { clearFirst: false });
        await humanPause(page);

        log.info('[Браузер] Нажимаем Sign up...');
        await page.click('button:has-text("Sign up")');
        await humanPause(page);

        // ════════════════════════════════════════════
        //   OTP-КОД
        // ════════════════════════════════════════════

        const code = await (mailManager || mailProvider).waitForOtp(mailToken, email);
        if (!code) {
            throw new Error('Не получили OTP-код — проверьте доступность почтового API');
        }

        log.info('[Браузер] Вводим код...');
        await page.waitForTimeout(2000);
        const otpFilled = await humanType(page,
            'input[autocomplete="one-time-code"], input[name="code"], input[type="text"][maxlength="6"], input[inputmode="numeric"]',
            code, 'OTP-код', { clearFirst: false }
        );
        if (!otpFilled) {
            await page.locator('input').first().fill(code);
            log.info('  ✅ OTP-код (fallback: первый input)');
        }

        try {
            await page.click('button:has-text("Continue")', { timeout: 3000 });
        } catch {
            log.info('[Браузер] Continue не найден — код отправился автоматически');
        }

        await page.waitForTimeout(getDelay(config.DELAY_AFTER_CODE_INPUT || 5000));

        log.info(`[Браузер] 💾 Сохраняем сессию: ${sessionFile}`);
        await saveSession(context, sessionFile);

        // ════════════════════════════════════════════
        //   ОПРЕДЕЛЯЕМ ORG
        // ════════════════════════════════════════════

        const orgMatch = page.url().match(/\/org\/([^\/]+)/);
        if (orgMatch) orgName = orgMatch[1];
        log.info(`[Браузер] Организация: ${orgName}`);

        // ════════════════════════════════════════════
        //   ОПЛАТА С РОТАЦИЕЙ BIN
        // ════════════════════════════════════════════

        if (cliArgs.dryRun) {
            log.success('[Dry-run] ✅ Дошли до оплаты без реального платежа — dry-run завершён');
            paymentConfirmed = false;
            await saveSession(context, sessionFile);
            if (fs.existsSync(sessionFile)) {
                await exportAccount(sessionFile, email, password, orgName, cardUsed || 'dry-run', 'dry_run', page);
            }
            const elapsed = Date.now() - accountStart;
            stats.successCount++;
            stats.totalTimeSuccess += elapsed;
            timingOptimizer.recordAccount(true, elapsed, 'DRY_RUN');
            log.accountEvent('account_dry_run', { email, org: orgName, bin: actualBin, durationSec: Math.round(elapsed / 1000) });
            return { success: true, category: 'DRY_RUN', retryable: false };
        }

        const maxBinRetries = config.BIN_ROTATION_ON_DECLINED ? (config.BIN_MAX_RETRIES || 10) : 1;

        for (let binAttempt = 0; binAttempt < maxBinRetries; binAttempt++) {
            if (shutdownRequested) break;

            actualBin = binManager.getNext(accountIndex + binAttempt);
            cardUsed = generateLuhnCard(actualBin);
            const maskedCardUsed = '****' + cardUsed.slice(-4);
            log.info(`[Браузер] Попытка оплаты ${binAttempt + 1}/${maxBinRetries} (BIN: ${actualBin}, карта: ${maskedCardUsed})`);

            // ---- Переход к тарифам → trial → Stripe (каждый раз чистый вход) ----
            log.info(`[Браузер] Переходим к тарифам (org: ${orgName})...`);
            await page.goto(`https://app.devin.ai/org/${orgName}/plans`, { waitUntil: 'domcontentloaded', timeout: 120000 });

            try {
                await page.waitForSelector('button', { timeout: 30000 });
                await page.waitForTimeout(5000);
            } catch {
                log.warn('[Браузер] Кнопки не появились, ждём ещё...');
                await page.waitForTimeout(10000);
            }

            // ---- Ищем кнопку триала ----
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

                if (trialBtns.length > 0) return { ok: false, count: trialBtns.length };
                return { ok: false, count: 0 };
            });

            if (trialBtn && trialBtn.ok) {
                log.success(`[Браузер] ✅ Найдена кнопка: "${trialBtn.text}"`);
                await page.waitForTimeout(getDelay(config.DELAY_BEFORE_TRIAL_CLICK || [3000, 5000]));
                try {
                    await page.mouse.move(trialBtn.x, trialBtn.y, { steps: 25 });
                    await page.waitForTimeout(1000 + randomDelay(0, 1000));
                    await page.mouse.click(trialBtn.x, trialBtn.y);
                } catch {
                    log.warn('[Браузер] Клик мышью не удался — кликаем через JS');
                    await page.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button'));
                        const tb = btns.filter(b => /start free trial/i.test(b.innerText));
                        if (tb.length > 0) tb[tb.length - 1].click();
                    });
                }
                log.success('[Браузер] ✅ Триал нажат!');
            } else {
                log.warn(`[Браузер] ⚠️ Кнопка $20 не найдена (найдено: ${trialBtn?.count || 0})`);
                const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
                if (/current plan|active/i.test(bodyText)) {
                    log.success('[Браузер] ✅ Триал уже активен!');
                    paymentConfirmed = true;
                    break;
                }
                throw new Error('Кнопка триала за $20 не найдена — попробуйте другой BIN или проверьте прокси');
            }

            // ---- STRIPE CHECKOUT ----
            log.info('[Браузер] Ждём загрузку Stripe...');
            try {
                await page.waitForURL(/checkout\.stripe\.com/, { timeout: config.DELAY_PAYMENT_WAIT || 75000 });
                log.success('[Браузер] ✅ Stripe загружен!');
            } catch {
                log.warn('[Браузер] ⚠️ Stripe не загрузился за отведённое время');
                if (binAttempt < maxBinRetries - 1) { log.info('[Браузер] Пробуем следующий BIN...'); continue; }
                throw new Error('Stripe checkout не загрузился — проверьте интернет или прокси');
            }

            await page.waitForTimeout(2000);
            try { await page.waitForSelector('input[value="card"]', { timeout: 60000 }); } catch { }
            await page.waitForTimeout(2000);

            try {
                for (const cb of await page.locator('input[type="checkbox"]').all()) {
                    if (await cb.isChecked()) await cb.uncheck({ force: true });
                }
            } catch { }
            await page.waitForTimeout(500);

            log.info('[Браузер] Выбираем "Карта"...');
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
            await page.waitForTimeout(2000);

            // ---- ВВОД ДАННЫХ КАРТЫ ----
            log.info(`[Браузер] Вводим данные карты (${maskedCardUsed})...`);
            const cardNumberOk = await humanType(page, '#cardNumber, #Field-numberInput, input[autocomplete="cc-number"], input[name="cardNumber"], input[name="cardnumber"]', cardUsed, 'Номер карты');
            if (!cardNumberOk) throw new Error('Поле не найдено: номер карты');
            await page.waitForTimeout(randomDelay(1000, 2500));

            const expDate = (config.EXP_DATE === 'auto' || config.EXP_DATE === '') ? generateExpDate() : config.EXP_DATE;
            const expOk = await humanType(page, '#cardExpiry, #Field-expiryInput, input[autocomplete="cc-exp"], input[name="cardExpiry"], input[name="exp-date"]', expDate, 'Срок действия');
            if (!expOk) throw new Error('Поле не найдено: срок действия карты');
            await page.waitForTimeout(randomDelay(800, 2000));

            const cvcCode = (config.CVC_CODE === 'auto' || config.CVC_CODE === '') ? generateCVC(actualBin) : config.CVC_CODE;
            const cvcOk = await humanType(page, '#cardCvc, #Field-cvcInput, input[autocomplete="cc-csc"], input[name="cardCvc"], input[name="cvc"]', cvcCode, 'CVC');
            if (!cvcOk) throw new Error('Поле не найдено: CVC');
            await page.waitForTimeout(randomDelay(1000, 2500));

            const billingNameOk = await humanType(page, '#billingName, #Field-nameInput, input[autocomplete="name"], input[name="billingName"]', config.BILLING_NAME, 'Имя владельца');
            if (!billingNameOk) throw new Error('Поле не найдено: имя владельца');
            await page.waitForTimeout(randomDelay(1500, 3500));

            log.info(`[Браузер] Страна → ${billing.country}...`);
            try {
                await page.locator('#billingCountry, select[name="billingCountry"], select[autocomplete="country"]').first().selectOption(billing.country, { timeout: 3000 });
                await page.waitForTimeout(randomDelay(1500, 2500));
            } catch { }

            log.info('[Браузер] Заполняем адрес...');
            try { await page.locator('text=/Enter address manually/i').first().click({ timeout: 2000 }); } catch { }
            await page.waitForTimeout(randomDelay(500, 1000));

            const addressOk = await humanType(page, '#billingAddressLine1, #Field-addressLine1Input, input[autocomplete="address-line1"], input[name="billingAddressLine1"]', billing.address, 'Адрес');
            if (!addressOk) throw new Error('Поле не найдено: адрес');
            await page.waitForTimeout(800);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(randomDelay(1000, 2000));

            const cityOk = await humanType(page, '#billingLocality, #Field-localityInput, input[autocomplete="address-level2"], input[name="billingLocality"]', billing.city, 'Город');
            if (!cityOk) throw new Error('Поле не найдено: город');
            await page.waitForTimeout(randomDelay(800, 1800));

            const zipOk = await humanType(page, '#billingPostalCode, #Field-postalCodeInput, input[autocomplete="postal-code"], input[name="billingPostalCode"]', billing.zip, 'Индекс');
            if (!zipOk) throw new Error('Поле не найдено: индекс');
            await page.waitForTimeout(randomDelay(1500, 2500));

            log.info('[Браузер] Настраиваем чекбоксы...');
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
            log.info('[Браузер] Нажимаем "Начать пробное использование"...');
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
                log.success('[Браузер] ✅ Кнопка нажата!');
            } else {
                throw new Error('Кнопка оплаты Stripe не найдена');
            }

            // ---- hCAPTCHA ----
            if (config.HCAPTCHA_ENABLED) {
                log.info('[Браузер] Ждём капчу...');
                await page.waitForTimeout(3000);
                let captchaSolved = false;
                const hcAttempts = config.HCAPTCHA_MAX_ATTEMPTS || 15;
                const hcInterval = config.HCAPTCHA_CHECK_INTERVAL || 2000;

                for (let i = 0; i < hcAttempts; i++) {
                    if (shutdownRequested) break;

                    for (const frame of page.frames()) {
                        const url = frame.url();
                        if (url.includes('hcaptcha') && url.includes('checkbox') && !url.includes('invisible')) {
                            try {
                                await frame.locator('#checkbox').click({ timeout: 3000 });
                                log.success('[Браузер] ✅ Капча решена!');
                                captchaSolved = true;
                            } catch { }
                        }
                    }
                    if (captchaSolved) break;

                    if (!page.url().includes('checkout.stripe.com')) {
                        log.success('[Браузер] 🎉 Оплата прошла без капчи!');
                        break;
                    }
                    await page.waitForTimeout(hcInterval);
                }

                if (captchaSolved) {
                    log.info('[Браузер] Ждём обработку платежа...');
                    await page.waitForTimeout(5000);
                }
            }

            // ---- ОЖИДАНИЕ ПОДТВЕРЖДЕНИЯ ----
            const paymentWaitMs = config.DELAY_PAYMENT_WAIT || 75000;
            log.info(`[Браузер] Ожидаем подтверждение (до ${paymentWaitMs / 1000} сек)...`);
            const deadline = Date.now() + paymentWaitMs;
            let cardDeclined = false;

            while (Date.now() < deadline) {
                if (shutdownRequested) break;
                await page.waitForTimeout(3000);

                const curUrl = page.url();
                if (!curUrl.includes('checkout.stripe.com')) {
                    log.success('[Браузер] 🎉 Оплата подтверждена!');
                    paymentConfirmed = true;
                    break;
                }

                try {
                    const bodyText = await page.locator('body').innerText({ timeout: 1000 });
                    if (/declined|insufficient|не принята|отклонена/i.test(bodyText)) {
                        const errorText = await page.evaluate(() => {
                            const alerts = document.querySelectorAll('[role="alert"], .Error, .FieldError, .Banner--error, [class*="error"], [class*="Error"]');
                            return Array.from(alerts).map(el => el.innerText.trim()).filter(t => t.length > 0 && t.length < 200).join(' | ') || 'Текст ошибки не найден';
                        });
                        log.warn(`[Браузер] ❌ Карта отклонена: ${errorText}`);
                        cardDeclined = true;
                        break;
                    }
                } catch { }

                log.dot();
            }

            if (paymentConfirmed) {
                binManager.markGood(actualBin);
                break;
            }

            if (cardDeclined) {
                binManager.markBad(actualBin);
                if (binAttempt < maxBinRetries - 1 && config.BIN_ROTATION_ON_DECLINED) {
                    log.info(`[Браузер] 🔄 Пробуем следующий BIN (${binAttempt + 2}/${maxBinRetries})...`);
                    continue;
                } else {
                    log.warn('[Браузер] ❌ Все BIN-ы отклонены — попробуйте другие BIN-ы или проверьте прокси');
                    break;
                }
            }

            if (!paymentConfirmed && !cardDeclined) {
                log.warn('[Браузер] ⚠️ Таймаут ожидания оплаты — платёж может ещё обрабатываться, не ретраим');
                break;
            }
        }

        // ════════════════════════════════════════════
        //   ВЕРИФИКАЦИЯ ТРИАЛА
        // ════════════════════════════════════════════

        if (paymentConfirmed) {
            log.info('[Проверка] Ждём редирект...');
            await page.waitForTimeout(5000);

            log.info('[Проверка] Проверяем статус плана...');
            await page.goto(`https://app.devin.ai/org/${orgName}/plans`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(5000);

            const isTrialActive = await page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return text.includes('current plan') || !/start free trial/i.test(text);
            });

            if (!isTrialActive) {
                log.warn('[Проверка] ❌ План не обновился!');
                paymentConfirmed = false;
            } else {
                log.success('[Проверка] ✅ Триал верифицирован!');
            }
        }

        // ════════════════════════════════════════════
        //   СОХРАНЕНИЕ
        // ════════════════════════════════════════════

        const status = paymentConfirmed ? '✅ READY' : '⚠️ error';

        await saveSession(context, sessionFile);
        if (fs.existsSync(sessionFile)) {
            await exportAccount(sessionFile, email, password, orgName, cardUsed, paymentConfirmed, page);
        }

        const savePasswords = config.SAVE_PASSWORDS_IN_LOG !== false;
        const accountsLine = savePasswords
            ? `${email}:${password} | org: ${orgName} | card: ****${cardUsed.slice(-4)} | ${status}`
            : `${email} | org: ${orgName} | card: ****${cardUsed.slice(-4)} | ${status}`;
        fs.appendFileSync(config.ACCOUNTS_FILE, accountsLine + '\n', 'utf-8');

        log.success(`\n✅ Аккаунт #${accountIndex + 1} — Статус: ${status}`);

        const elapsed = Date.now() - accountStart;
        if (paymentConfirmed) {
            stats.successCount++;
            stats.totalTimeSuccess += elapsed;
        } else {
            stats.failCount++;
            stats.totalTimeFail += elapsed;
        }
        await sendWebhook({
            email, org: orgName, card: cardUsed.length > 4 ? '****' + cardUsed.slice(-4) : cardUsed,
            success: paymentConfirmed,
            error: paymentConfirmed ? null : 'payment_failed',
            category: paymentConfirmed ? 'SUCCESS' : 'PAYMENT_ERROR',
            bin: actualBin,
            durationSec: Math.round(elapsed / 1000),
        });

        if (paymentConfirmed) {
            log.accountEvent('account_success', { email, org: orgName, bin: actualBin, durationSec: Math.round(elapsed / 1000) });
            timingOptimizer.recordAccount(true, elapsed, 'SUCCESS');
            if (mailManager) mailManager.recordSuccess();
            return { success: true, category: 'SUCCESS', retryable: false };
        } else {
            log.accountEvent('account_fail', { email, org: orgName, bin: actualBin, category: 'PAYMENT_ERROR' });
            timingOptimizer.recordAccount(false, elapsed, 'PAYMENT_ERROR');
            return { success: false, category: 'PAYMENT_ERROR', retryable: false };
        }

    } catch (error) {
        log.error(`\n[Ошибка]: ${enhancedErrorMessage(error)}`);

        try {
            log.info(`[Браузер] URL: ${page.url()}`);

            if (config.SAVE_HTML_ON_ERROR !== false) {
                const errorDir = makeFolderName(config.ERROR_DIR, 'Debug', orgName);
                if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });
                const htmlContent = await page.content().catch(() => '');
                if (htmlContent) {
                    fs.writeFileSync(path.join(errorDir, 'page_dump.html'), htmlContent, 'utf-8');
                    log.info(`[Артефакт] 📄 HTML dump: ${sanitizePath(errorDir)}/page_dump.html`);
                }
            }
        } catch { }

        const errorCategory = categorizeError(error);
        log.warn(`[Браузер] Категория ошибки: ${errorCategory}`);

        if (mailManager && errorCategory === 'MAIL_ERROR') {
            mailManager.recordFailure();
        }

        try {
            await saveSession(context, sessionFile);
            if (fs.existsSync(sessionFile)) {
                await exportAccount(sessionFile, email, password, orgName, cardUsed || 'N/A', false, page);
            }
        } catch (e) {
            log.warn(`[Экспорт] ⚠️ Не удалось экспортировать при ошибке: ${e.message}`);
            try { fs.unlinkSync(sessionFile); } catch { }
        }

        const savePasswords = config.SAVE_PASSWORDS_IN_LOG !== false;
        const errorLine = savePasswords
            ? `${email}:${password} | org: ${orgName} | card: ****${(cardUsed || 'N/A').slice(-4)} | ❌ CRASH: ${error.message.slice(0, 80)}`
            : `${email} | org: ${orgName} | card: ****${(cardUsed || 'N/A').slice(-4)} | ❌ CRASH: ${error.message.slice(0, 80)}`;
        fs.appendFileSync(config.ACCOUNTS_FILE, errorLine + '\n', 'utf-8');

        const elapsed = Date.now() - accountStart;
        stats.failCount++;
        stats.totalTimeFail += elapsed;
        if (errorCategory === 'PAYMENT_ERROR') {
            binManager.binStats[actualBin] = binManager.binStats[actualBin] || { success: 0, fail: 0 };
            binManager.binStats[actualBin].fail++;
        }
        timingOptimizer.recordAccount(false, elapsed, errorCategory);

        await sendWebhook({
            email, org: orgName, card: (cardUsed && cardUsed.length > 4) ? '****' + cardUsed.slice(-4) : (cardUsed || 'N/A'),
            success: false,
            error: error.message.slice(0, 200),
            category: errorCategory,
            bin: actualBin,
            durationSec: Math.round((Date.now() - accountStart) / 1000),
        });

        const retryableCategories = ['BROWSER_ERROR', 'TIMEOUT_ERROR', 'MAIL_ERROR', 'CAPTCHA_ERROR'];
        log.accountEvent('account_error', { email, org: orgName, bin: actualBin, category: errorCategory, error: error.message.slice(0, 200) });
        return {
            success: false,
            category: errorCategory,
            retryable: retryableCategories.includes(errorCategory),
        };
    } finally {
        if (mailCleanup && !mailCleanupDone) {
            try { await runMailCleanupOnce(); } catch (e) {
                log.warn(`[Почта] ⚠️ Ошибка очистки: ${e.message}`);
            }
        }
        try { await context.close(); } catch { }
        try { await browser.close(); } catch { }
    }
}

// ==================== 11. СТАТИСТИКА ====================

function printStats() {
    const elapsed = Math.round((Date.now() - stats.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const total = stats.successCount + stats.failCount;

    const GREEN = '\x1b[32m';
    const RED = '\x1b[31m';
    const CYAN = '\x1b[36m';
    const YELLOW = '\x1b[33m';
    const BOLD = '\x1b[1m';
    const RESET = '\x1b[0m';

    log.info('\n════════════════════════════════════════');
    log.info(`  ${BOLD}${CYAN}📊 СТАТИСТИКА${RESET}`);
    log.info('════════════════════════════════════════');
    log.info(`  Время работы: ${mins}м ${secs}с`);
    log.info(`  Попыток: ${stats.totalAttempts}`);
    log.info(`  ${GREEN}Успешных: ${stats.successCount}${RESET}`);
    log.info(`  ${RED}Неудачных: ${stats.failCount}${RESET}`);
    if (total > 0) log.info(`  Успешность: ${((stats.successCount / total) * 100).toFixed(1)}%`);
    if (stats.successCount > 0) log.info(`  Ср. время (успех): ${Math.round(stats.totalTimeSuccess / stats.successCount / 1000)}с`);
    if (stats.failCount > 0) log.info(`  Ср. время (ошибка): ${Math.round(stats.totalTimeFail / stats.failCount / 1000)}с`);

    log.info(`\n  ${BOLD}${CYAN}💳 BIN-ОТЧЁТ${RESET}`);
    log.info(`  ${binManager.getStatsLine()}`);

    const goodBins = [];
    const badBins = [];
    const unknownBins = [];

    for (const [bin, s] of Object.entries(binManager.binStats)) {
        const rate = binManager.getSuccessRate(bin);
        const info = binManager._lookupLocal(bin);
        const entry = { bin, success: s.success, fail: s.fail, rate, info };
        if (s.success > 0 && s.success >= s.fail) goodBins.push(entry);
        else if (s.fail > 0 && s.success === 0) badBins.push(entry);
        else unknownBins.push(entry);
    }

    if (goodBins.length > 0) {
        log.info(`\n  ${GREEN}${BOLD}✅ Рабочие BIN (рекомендуются):${RESET}`);
        for (const b of goodBins) {
            const bank = b.info ? ` (${b.info.bank}, ${b.info.country})` : '';
            log.info(`    ${GREEN}${b.bin}${RESET} — ✅${b.success} ❌${b.fail} (${b.rate}% success)${bank}`);
        }
    }

    if (badBins.length > 0) {
        log.info(`\n  ${RED}${BOLD}❌ Нерабочие BIN (не использовать):${RESET}`);
        for (const b of badBins) {
            const bank = b.info ? ` (${b.info.bank}, ${b.info.country})` : '';
            const reason = b.info?.type === 'prepaid' || b.info?.prepaid ? ' [PREPAID — не пройдут на Stripe]' : '';
            log.info(`    ${RED}${b.bin}${RESET} — ✅${b.success} ❌${b.fail} (${b.rate}% success)${bank}${reason}`);
        }
    }

    if (unknownBins.length > 0) {
        log.info(`\n  ${YELLOW}${BOLD}⚠️ BIN с неоднозначным результатом:${RESET}`);
        for (const b of unknownBins) {
            const bank = b.info ? ` (${b.info.bank}, ${b.info.country})` : '';
            log.info(`    ${YELLOW}${b.bin}${RESET} — ✅${b.success} ❌${b.fail} (${b.rate}% success)${bank}`);
        }
    }

    if (goodBins.length > 0) {
        const recommendedBins = goodBins.map(b => b.bin);
        log.info(`\n  ${GREEN}${BOLD}📋 Для следующего запуска (config.js):${RESET}`);
        log.info(`    BINS: ['${recommendedBins.join("', '")}']`);
    } else if (badBins.length > 0 && goodBins.length === 0) {
        const billingCountries = (config.BILLING_PROFILES || []).map(p => p.country?.toUpperCase()).filter(Boolean);
        const countryHint = billingCountries.length > 0 ? ` --country ${billingCountries[0]}` : '';
        log.info(`\n  ${RED}${BOLD}💡 Ни один BIN не сработал. Попробуйте:${RESET}`);
        log.info(`    node internal/bin-lookup.js --filter credit${countryHint}`);
    }

    log.info('════════════════════════════════════════');
}

// ==================== 12. DOCTOR MODE ====================

/**
 * Полная диагностика всех компонентов.
 * Проверяет: Node.js, Playwright, Chromium, почтовый API, прокси, DNS, output-папки.
 * @returns {Promise<boolean>} true если все проверки пройдены
 */
async function doctorMode() {
    const GREEN = '\x1b[32m';
    const RED = '\x1b[31m';
    const YELLOW = '\x1b[33m';
    const BOLD = '\x1b[1m';
    const RESET = '\x1b[0m';

    let allOk = true;

    console.log(`\n${BOLD}════════════════════════════════════════${RESET}`);
    console.log(`  ${BOLD}DOCTOR MODE — Диагностика компонентов${RESET}`);
    console.log(`${BOLD}════════════════════════════════════════${RESET}\n`);

    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    if (major >= 18) {
        console.log(`  ${GREEN}✔${RESET} Node.js: ${process.version}`);
    } else {
        console.log(`  ${RED}✘${RESET} Node.js: ${process.version} — нужна версия 18+`);
        allOk = false;
    }

    let pwOk = false;
    try {
        require.resolve('playwright');
        pwOk = true;
        console.log(`  ${GREEN}✔${RESET} Playwright: пакет установлен`);
    } catch {
        console.log(`  ${RED}✘${RESET} Playwright: пакет НЕ установлен — npm install playwright`);
        allOk = false;
    }

    if (pwOk) {
        try {
            const pw = require('playwright');
            const chromiumPath = pw.chromium.executablePath();
            if (chromiumPath && fs.existsSync(chromiumPath)) {
                console.log(`  ${GREEN}✔${RESET} Chromium: ${chromiumPath}`);
            } else {
                console.log(`  ${RED}✘${RESET} Chromium: бинарник не найден — npx playwright install chromium`);
                allOk = false;
            }
        } catch (e) {
            console.log(`  ${YELLOW}⚠${RESET} Chromium: не удалось проверить — ${e.message}`);
            allOk = false;
        }
    }

    console.log(`\n  ${BOLD}Почта:${RESET}`);
    const primaryName = normalizeMailProvider(config.MAIL_PROVIDER);
    const primaryOk = await _checkProviderHealth(primaryName);
    const hasFallback = mailManager && mailManager.hasFallback;
    const fallbackOk = hasFallback ? await _checkProviderHealth(mailManager.fallbackName) : false;

    if (primaryOk) {
        console.log(`  ${GREEN}✔${RESET} ${primaryName}: API доступен`);
    } else if (hasFallback && fallbackOk) {
        console.log(`  ${YELLOW}⚠${RESET} ${primaryName}: API недоступен, но fallback работает`);
    } else {
        console.log(`  ${RED}✘${RESET} ${primaryName}: API недоступен`);
        allOk = false;
    }

    if (hasFallback) {
        if (fallbackOk) {
            console.log(`  ${GREEN}✔${RESET} ${mailManager.fallbackName} (fallback): API доступен`);
        } else {
            console.log(`  ${YELLOW}⚠${RESET} ${mailManager.fallbackName} (fallback): API недоступен`);
        }
        console.log(`  ${GREEN}✔${RESET} Fallback: ВКЛ (порог: ${mailManager.failThreshold}, cooldown: ${mailManager.cooldownMs / 1000}с)`);
    } else {
        console.log(`  ${YELLOW}—${RESET} Fallback: ВЫКЛ (только ${primaryName})`);
    }

    if (mailManager) {
        const statusInfo = mailManager.getStatusInfo();
        for (const s of statusInfo) {
            const tag = s.isActive ? '→ активен' : (s.onCooldown ? '⏳ cooldown' : 'готов');
            console.log(`     ${s.name}: ${tag} (ошибок подряд: ${s.fails})`);
        }
        if (mailManager.switchLog.length > 0) {
            const last = mailManager.switchLog[mailManager.switchLog.length - 1];
            console.log(`     Последнее переключение: ${last.from} → ${last.to} (${last.at})`);
        }
    }

    try {
        await fetchWithTimeout('https://app.devin.ai', { method: 'HEAD' }, 10000);
        console.log(`  ${GREEN}✔${RESET} DNS/Сеть: app.devin.ai доступен`);
    } catch (e) {
        console.log(`  ${YELLOW}⚠${RESET} DNS/Сеть: app.devin.ai — ${e.message}`);
    }

    if (config.PROXY) {
        const proxyObj = parseProxy(config.PROXY);
        if (proxyObj) {
            console.log(`  ${GREEN}✔${RESET} Прокси: ${proxyObj.server} (формат OK)`);
                        try {
                const proxyBrowser = await require('playwright').chromium.launch({
                    headless: true, proxy: proxyObj, args: ['--disable-blink-features=AutomationControlled']
                });
                const proxyPage = await proxyBrowser.newPage();
                await proxyPage.goto('https://httpbin.org/ip', { timeout: 15000 });
                const ipText = await proxyPage.locator('body').innerText({ timeout: 5000 }).catch(() => 'N/A');
                await proxyBrowser.close();
                console.log(`  ${GREEN}✔${RESET} Прокси работает: IP через прокси — ${ipText.slice(0, 60)}`);
            } catch (e) {
                console.log(`  ${RED}✘${RESET} Прокси: не работает — ${e.message}`);
                allOk = false;
            }
        } else {
            console.log(`  ${RED}✘${RESET} Прокси: не удалось распарсить "${config.PROXY}"`);
            allOk = false;
        }
    } else {
        console.log(`  ${YELLOW}—${RESET} Прокси: не настроен (прямой запуск)`);
    }

    const dirs = [config.READY_DIR, config.ERROR_DIR, path.dirname(config.LOG_FILE || ''), path.dirname(config.ACCOUNTS_FILE || '')];
    let dirsOk = true;
    for (const dir of dirs) {
        if (dir && !fs.existsSync(dir)) {
            try { fs.mkdirSync(dir, { recursive: true }); } catch { dirsOk = false; }
        }
    }
    if (dirsOk) {
        console.log(`  ${GREEN}✔${RESET} Output-папки: доступны для записи`);
    } else {
        console.log(`  ${RED}✘${RESET} Output-папки: ошибка создания`);
        allOk = false;
    }

    if (config.AUTO_TIMING) {
        const timingFile = config.TIMING_PROFILE_FILE || 'output/Данные/timing_profile.json';
        if (fs.existsSync(timingFile)) {
            const observedRuns = (timingOptimizer.profile.runs.success || 0) + (timingOptimizer.profile.runs.fail || 0) + (timingOptimizer.profile.runs.dryRun || 0);
            const reasonsText = timingOptimizer.profile.lastApplied?.reasons?.length ? `, причины: ${timingOptimizer.profile.lastApplied.reasons.join(', ')}` : '';
            console.log(`  ${GREEN}✔${RESET} Авто-тайминги: профиль найден (${timingFile}, запусков: ${observedRuns}, confidence: ${timingOptimizer.profile.lastApplied?.confidence || timingOptimizer.confidence || 'none'}${reasonsText})`);
        } else {
            console.log(`  ${YELLOW}—${RESET} Авто-тайминги: профиль ещё не накоплен (${timingFile})`);
        }
    } else {
        console.log(`  ${YELLOW}—${RESET} Авто-тайминги: отключены`);
    }

    try {
        validateConfig();
        console.log(`  ${GREEN}✔${RESET} Конфиг: прошёл валидацию`);
    } catch (e) {
        console.log(`  ${RED}✘${RESET} Конфиг: ${e.message}`);
        allOk = false;
    }

    if (Array.isArray(config.BINS) && config.BINS.length > 0) {
        console.log(`\n  ${BOLD}Проверка BIN-ов:${RESET}`);
        const binResult = await binManager.validateBins(true);
        const creditCount = binResult.info.filter(i => i.type === 'credit').length;
        const prepaidCount = binResult.info.filter(i => i.type === 'prepaid' || i.prepaid).length;

        if (creditCount > 0) {
            console.log(`  ${GREEN}✔${RESET} BIN: ${creditCount} credit — подойдут для подписок`);
        }
        if (prepaidCount > 0) {
            console.log(`  ${RED}✘${RESET} BIN: ${prepaidCount} prepaid — НЕ пройдут на Stripe`);
            allOk = false;
        }
        if (binResult.info.length === 0) {
            console.log(`  ${YELLOW}⚠${RESET} BIN: ни один не найден в базе — неизвестный тип`);
        }
    } else {
        console.log(`  ${GREEN}✔${RESET} BIN: авто-подбор (${binManager.bins.length} BIN-ов из DEFAULT_BINS)`);
    }

    console.log(`\n  ${BOLD}Ротация:${RESET}`);
    if (config.FINGERPRINT_ROTATION) {
        console.log(`  ${GREEN}✔${RESET} Fingerprint: ротация ВКЛ (${FINGERPRINT_PROFILES.length} профилей GPU+viewport)`);
    } else {
        console.log(`  ${YELLOW}—${RESET} Fingerprint: ротация ВЫКЛ (фиксированный GPU/viewport)`);
    }
    if (config.BILLING_ROTATION) {
        const countries = (config.BILLING_PROFILES || []).map(p => p.country?.toUpperCase()).filter(Boolean);
        const uniqueCountries = [...new Set(countries)];
        console.log(`  ${GREEN}✔${RESET} Биллинг: ротация ВКЛ (${uniqueCountries.length} стран: ${uniqueCountries.join(', ') || 'N/A'}) → timezone/locale автоматически`);
    } else {
        console.log(`  ${YELLOW}—${RESET} Биллинг: ротация ВЫКЛ (фиксированные TZ=${config.TIMEZONE}, locale=${config.LOCALE})`);
    }
    if (config.CONCURRENT_ACCOUNTS > 1) {
        console.log(`  ${GREEN}✔${RESET} Параллельность: ${config.CONCURRENT_ACCOUNTS} браузеров одновременно`);
    } else {
        console.log(`  ${YELLOW}—${RESET} Параллельность: последовательный режим (CONCURRENT_ACCOUNTS=1)`);
    }

    console.log(`\n${BOLD}════════════════════════════════════════${RESET}`);
    if (allOk) {
        console.log(`  ${GREEN}${BOLD}✅ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ${RESET}`);
    } else {
        console.log(`  ${RED}${BOLD}❌ ЕСТЬ ПРОБЛЕМЫ — ИСПРАВЬТЕ ПЕРЕД ЗАПУСКОМ${RESET}`);
    }
    console.log(`${BOLD}════════════════════════════════════════${RESET}\n`);

    return allOk;
}

// ==================== 13. ЗАПУСК ====================

(async () => {
    if (cliArgs.doctor) {
        const ok = await doctorMode();
        process.exitCode = ok ? 0 : 1;
        return;
    }

    if (process._mailProviderError) {
        log.error(`[!] ОШИБКА: ${process._mailProviderError.message}`);
        process.exit(1);
    }

    try {
        validateConfig();
    } catch (e) {
        log.error(`[!] ОШИБКА КОНФИГА: ${e.message}`);
        process.exit(1);
    }

    const apiOk = await healthCheck();
    if (!apiOk) {
        log.warn('[!] Почтовый API недоступен — продолжаем на свой риск...');
    }

    const shouldValidateBins = cliArgs.validateBins !== null ? cliArgs.validateBins : (config.VALIDATE_BINS !== false);
    if (shouldValidateBins) {
        const binResult = await binManager.validateBins(config.VALIDATE_BINS_ONLINE !== false);
        if (binResult.warnings.length > 0) {
            log.warn(`\n[BIN] ⚠️ Предупреждения:`);
            for (const w of binResult.warnings) log.warn(`  - ${w}`);

            const allPrepaid = binResult.info.length > 0 && binResult.info.every(i => i.type === 'prepaid' || i.prepaid);
            if (allPrepaid) {
                log.error(`[BIN] ❌ Все BIN-ы — prepaid! Регистрация почти наверняка не сработает.`);
                log.info(`[BIN] 💡 Запустите "node internal/bin-lookup.js --filter credit" для поиска рабочих BIN-ов`);
                log.info(`[BIN] 💡 Или установите VALIDATE_BINS: false в config.js чтобы пропустить проверку`);
            }
        }

        if (binResult.recommended.length > 0) {
            const recommendedSet = new Set(binResult.recommended);
            const others = binManager.bins.filter(b => !recommendedSet.has(b));
            binManager.bins = [...binResult.recommended, ...others];
            log.success(`[BIN] 🏆 Рекомендуемые BIN поставлены первыми: ${binResult.recommended.join(', ')}`);
        }
    }

    stats.startTime = Date.now();
    const count = config.ACCOUNTS_COUNT === 0 ? Infinity : config.ACCOUNTS_COUNT;

    const GREEN = '\x1b[32m';
    const RED = '\x1b[31m';
    const YELLOW = '\x1b[33m';
    const CYAN = '\x1b[36m';
    const BOLD = '\x1b[1m';
    const RESET = '\x1b[0m';

    log.info('════════════════════════════════════════');
    log.info(`  ${BOLD}DEVIN AI AUTOREGER v5.0${RESET}`);
    log.info('════════════════════════════════════════');
    log.info(`  Почта: ${mailManager ? mailManager.name : (mailProvider ? mailProvider.name : '?')} (${normalizeMailProvider(config.MAIL_PROVIDER)})${mailManager && mailManager.hasFallback ? ` + fallback: ${mailManager.fallbackName}` : ''}`);
    if (normalizeMailProvider(config.MAIL_PROVIDER) === 'coda') {
        log.info(`  Coda provider: ${config.CODA_PROVIDER || 'tempmail'}, cleanup: ${config.CODA_CLEANUP !== false ? 'вкл' : 'выкл'}`);
    }
    if (mailManager && mailManager.hasFallback) {
        log.info(`  Fallback: ${GREEN}вкл${RESET} (порог: ${mailManager.failThreshold} ошибок, cooldown: ${mailManager.cooldownMs / 1000}с)`);
    }
    log.info(`  BIN: ${Array.isArray(config.BINS) ? config.BINS.join(', ') : config.BINS}`);
    log.info(`  BIN ротация: ${config.BIN_ROTATION_ON_DECLINED ? 'вкл' : 'выкл'} (макс. ${config.BIN_MAX_RETRIES || 10})`);
    log.info(`  Прокси: ${proxyManager.count > 0 ? `${proxyManager.count} шт. (ротация: ${config.PROXY_ROTATION ? 'вкл' : 'выкл'})` : 'без прокси'}`);
    log.info(`  Биллинг: ${billingManager.count} профилей (${billingManager.profiles.map(p => p.country).join(', ')})`);
    log.info(`  Количество: ${config.ACCOUNTS_COUNT === 0 ? '∞ (Ctrl+C)' : config.ACCOUNTS_COUNT}${cliArgs.countOverride ? ' (переопределено --count)' : ''}`);
    log.info(`  Headless: ${config.HEADLESS}`);
    log.info(`  Viewport: ${JSON.stringify(config.VIEWPORT || { width: 1920, height: 1080 })}`);
    log.info(`  Stealth: ${config.STEALTH_ENABLED ? config.STEALTH_LEVEL : 'выкл'}`);
    log.info(`  Fingerprint ротация: ${config.FINGERPRINT_ROTATION ? `${GREEN}вкл${RESET} (${FINGERPRINT_PROFILES.length} профилей)` : `${YELLOW}выкл${RESET}`}`);
    log.info(`  Биллинг ротация: ${config.BILLING_ROTATION ? `${GREEN}вкл${RESET} (TZ/locale по стране)` : `${YELLOW}выкл${RESET} (TZ=${config.TIMEZONE}, locale=${config.LOCALE})`}`);
    log.info(`  Авто-тайминги: ${config.AUTO_TIMING ? `${GREEN}вкл${RESET} [${timingOptimizer.confidence}]${timingOptimizer.applied.length > 0 ? ` (${timingOptimizer.applied.join(', ')})` : ' (базовые/по профилю)'}${timingOptimizer.reasons.length > 0 ? ` | причины: ${timingOptimizer.reasons.join(', ')}` : ''}` : `${YELLOW}выкл${RESET}`}`);
    log.info(`  Параллельность: ${config.CONCURRENT_ACCOUNTS > 1 ? `${GREEN}${config.CONCURRENT_ACCOUNTS} браузеров${RESET}` : 'последовательно'}`);
    log.info(`  Лог-файл: ${config.LOG_FILE || 'выкл'}`);
    log.info(`  Скриншоты при ошибке: ${config.SCREENSHOT_ON_ERROR ? 'вкл' : 'выкл'}`);
    log.info(`  Вебхук: ${config.WEBHOOK_URL || 'выкл'}`);
    log.info(`  Retry при краше: ${config.RETRY_ON_CRASH ? `вкл (макс. ${config.RETRY_ON_CRASH_MAX})` : 'выкл'}`);
    log.info(`  ${GREEN}Output: ${config.READY_DIR}${RESET}`);
    log.info(`  ${RED}Errors: ${config.ERROR_DIR}${RESET}`);
    log.info(`  ${CYAN}Logs: ${config.LOG_FILE}${RESET}`);
    log.info(`  ${YELLOW}Data: ${config.ACCOUNTS_FILE}, ${config.KNOWN_BINS_FILE}${RESET}`);
    log.info('════════════════════════════════════════\n');

    if (config.GRACEFUL_SHUTDOWN !== false) {
        process.on('SIGINT', () => {
            if (shutdownRequested) {
                log.warn('\n[!] Двойной Ctrl+C — принудительное завершение');
                process.exit(1);
            }
            log.warn('\n[!] Ctrl+C — завершаем текущий аккаунт и останавливаем...');
            shutdownRequested = true;
        });

        process.on('SIGTERM', () => {
            log.warn('\n[!] SIGTERM — завершаем текущий аккаунт и останавливаем...');
            shutdownRequested = true;
        });
    }

    process.on('unhandledRejection', (reason) => {
        log.error(`[!] unhandledRejection: ${reason}`);
    });

    // ── Параллельный или последовательный запуск ──
    const concurrency = config.CONCURRENT_ACCOUNTS || 1;
    const effectiveCount = count === Infinity ? count : Math.min(count, 10000);

    if (concurrency > 1) {
        log.info(`  ${BOLD}${CYAN}⚡ Параллельный режим: ${concurrency} аккаунтов одновременно${RESET}\n`);

        const running = new Set();
        let pendingLaunches = 0;
        let nextTask = 0;

        const launchTask = () => {
            if (nextTask >= effectiveCount || shutdownRequested) return;
            const i = nextTask++;
            stats.totalAttempts++;

            const taskPromise = (async () => {
                try {
                    let result = await registerAccount(i, effectiveCount);

                    if (!result.success && result.retryable && config.RETRY_ON_CRASH) {
                        for (let retry = 0; retry < (config.RETRY_ON_CRASH_MAX || 1); retry++) {
                            if (shutdownRequested) break;
                            stats.totalAttempts++;
                            log.info(`[🔄] Повторная попытка #${retry + 1} для аккаунта #${i + 1} (${result.category})...`);
                            result = await registerAccount(i, effectiveCount);
                            if (result.success) break;
                        }
                    }

                    printStatusBar(i, effectiveCount);
                } catch (e) {
                    log.error(`[!] Аккаунт #${i + 1}: необработанная ошибка — ${e.message}`);
                    stats.failCount++;
                }
            })();

            running.add(taskPromise);
            taskPromise.finally(() => {
                running.delete(taskPromise);
                if (nextTask < effectiveCount && !shutdownRequested) {
                    pendingLaunches++;
                    setTimeout(() => {
                        try {
                            launchTask();
                        } finally {
                            pendingLaunches--;
                        }
                    }, getDelay(config.PAUSE_BETWEEN_ACCOUNTS || [1000, 3000]));
                }
            });
        };

        for (let c = 0; c < Math.min(concurrency, effectiveCount); c++) {
            launchTask();
        }

        await new Promise((resolve) => {
            const checkDone = setInterval(() => {
                if ((running.size === 0 && pendingLaunches === 0) || shutdownRequested) {
                    clearInterval(checkDone);
                    resolve();
                }
            }, 1000);
        });

    } else {
        // ── Последовательный режим (как раньше) ──
        for (let i = 0; i < effectiveCount; i++) {
            if (shutdownRequested) {
                log.warn('[!] Остановка по запросу пользователя');
                break;
            }

            stats.totalAttempts++;
            let result = await registerAccount(i, effectiveCount);

                        if (!result.success && result.retryable && config.RETRY_ON_CRASH) {
                for (let retry = 0; retry < (config.RETRY_ON_CRASH_MAX || 1); retry++) {
                    if (shutdownRequested) break;
                    stats.totalAttempts++;
                    log.info(`[🔄] Повторная попытка #${retry + 1} для аккаунта #${i + 1} (${result.category})...`);
                    result = await registerAccount(i, effectiveCount);
                    if (result.success) break;
                }
            }

            printStatusBar(i, effectiveCount);

            if (i < effectiveCount - 1 && !shutdownRequested) {
                const pause = getDelay(config.PAUSE_BETWEEN_ACCOUNTS || [2000, 5000]);
                log.info(`⏳ Пауза ${Math.round(pause / 1000)} сек перед следующим аккаунтом...\n`);
                await sleep(pause);
            }
        }
    }

    printStats();

    log.info('\n════════════════════════════════════════');
    log.info(`  ${BOLD}ФИНАЛ:${RESET} ${GREEN}✅ ${stats.successCount}${RESET} | ${RED}❌ ${stats.failCount}${RESET}`);
    log.info('════════════════════════════════════════');

    if (stats.successCount > 0) {
        const resultDir = cliArgs.dryRun ? config.ARCHIVE_DIR : config.READY_DIR;
        const resultLabel = cliArgs.dryRun ? '📦 Dry-run архив' : '📁 Результаты';
        log.info(`\n  ${GREEN}${resultLabel}:${RESET} ${resultDir}`);
        if (!cliArgs.dryRun) {
            log.info(`  ${GREEN}📋 Список аккаунтов:${RESET} ${config.ACCOUNTS_FILE}`);
        }
    }
    if (stats.failCount > 0) {
        log.info(`  ${RED}❌ Ошибки:${RESET} ${config.ERROR_DIR}`);
    }
    log.info(`  ${YELLOW}📝 Лог:${RESET} ${config.LOG_FILE || 'только консоль'}`);
})();
