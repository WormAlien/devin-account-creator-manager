/**
 * Devin AI Autoreger — Интерактивный лаунчер v5.0
 *
 * Запуск:  node start.js
 *
 * Интерактивная настройка с управлением стрелками.
 * API-ключ НЕ встроен — пользователь вводит его сам.
 *
 * Автор: @qlevis (Telegram)
 * Спасибо за вдохновение: @abuz_ai (Telegram)
 */

const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const defaultConfig = require('./config');

const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;
console.debug = noop;

// ═══════════════════════════════════════════════════════
//   ЦВЕТА ТЕРМИНАЛА
// ═══════════════════════════════════════════════════════
const G = '\x1b[32m';   // зелёный — успех
const R = '\x1b[31m';   // красный — ошибка
const Y = '\x1b[33m';   // жёлтый — предупреждение
const C = '\x1b[36m';   // голубой — вопросы
const B = '\x1b[1m';    // жирный — заголовки
const D = '\x1b[2m';    // тусклый — подсказки
const RS = '\x1b[0m';   // сброс

// ═══════════════════════════════════════════════════════
//   УТИЛИТЫ ДЛЯ ВОПРОСОВ
// ═══════════════════════════════════════════════════════

let rl = null;

function normalizeMailProvider(name) {
    const v = String(name || '').trim().toLowerCase();
    if (['coda', 'coda.ink', 'temp.coda.ink'].includes(v)) return 'coda';
    if (['mailtm', 'mail.tm'].includes(v)) return 'mailtm';
    return v;
}

function getRL() {
    if (rl) rl.close();
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl;
}

function closeRL() {
    if (rl) { rl.close(); rl = null; }
}

function ask(question, defaultVal) {
    const interface_ = getRL();
    return new Promise(resolve => {
        const def = defaultVal !== undefined && defaultVal !== '' ? ` [${defaultVal}]` : '';
        interface_.question(`${C}${question}${def}: ${RS}`, answer => {
            resolve(answer.trim() || (defaultVal !== undefined ? String(defaultVal) : ''));
        });
    });
}

function askYesNo(question, defaultVal = true) {
    return new Promise(async resolve => {
        while (true) {
            const hint = defaultVal ? 'Enter=Да, н=Нет' : 'Enter=Нет, д=Да';
            const answer = String(await ask(`${question} (${hint})`, '')).trim().toLowerCase();
            if (!answer) return resolve(defaultVal);
            if (['y', 'yes', 'д', 'да'].includes(answer)) return resolve(true);
            if (['n', 'no', 'н', 'нет'].includes(answer)) return resolve(false);
            console.log(`${Y}Введите: да/д/y или нет/н/n${RS}`);
        }
    });
}

// ═══════════════════════════════════════════════════════
//   ВЫБОР СТРЕЛКАМИ — без npm-пакетов
// ═══════════════════════════════════════════════════════

function selectFromList(question, items, defaultIdx = 0) {
    if (!items || items.length === 0) {
        return Promise.reject(new Error('selectFromList: пустой список элементов'));
    }

    return new Promise(resolve => {
        // Закрываем readline перед переходом в raw-режим
        closeRL();

        let selected = Math.min(defaultIdx, items.length - 1);
        if (selected < 0) selected = 0;

        const getMaxLabelLen = () => (process.stdout.columns ? process.stdout.columns - 4 : 80);
        const formatLabel = (label) => {
            const maxLen = getMaxLabelLen();
            return label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;
        };

        const render = () => {
            // Сдвигаем курсор вверх на количество строк и перерисовываем
            process.stdout.write('\x1b[' + items.length + 'A\x1b[J');
            items.forEach((item, i) => {
                const prefix = i === selected ? '\x1b[32m❯ ' : '  ';
                const style  = i === selected ? B : D;
                process.stdout.write(`${prefix}${style}${formatLabel(item.label)}\x1b[0m\n`);
            });
        };

        console.log(`\n${C}${question}${RS}`);
        items.forEach((item, i) => {
            const prefix = i === selected ? '\x1b[32m❯ ' : '  ';
            const style  = i === selected ? B : D;
            process.stdout.write(`${prefix}${style}${formatLabel(item.label)}\x1b[0m\n`);
        });

        // Переключаем stdin в raw-режим для отслеживания стрелок
        const wasRaw = process.stdin.isRaw;
        if (!wasRaw) process.stdin.setRawMode(true);
        process.stdin.resume();

        const cleanup = () => {
            if (!wasRaw) process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.removeListener('resize', render);
        };

        process.stdout.on('resize', render);

        const onData = (buf) => {
            const s = buf.toString();
            if (s === '\x1b[A' || s === '\x1bOA') {       // Стрелка вверх
                selected = (selected - 1 + items.length) % items.length;
                render();
            } else if (s === '\x1b[B' || s === '\x1bOB') { // Стрелка вниз
                selected = (selected + 1) % items.length;
                render();
            } else if (s === '\x1b[5~' || s === '\x1b[5;2~') { // Page Up
                selected = Math.max(0, selected - 5);
                render();
            } else if (s === '\x1b[6~' || s === '\x1b[6;2~') { // Page Down
                selected = Math.min(items.length - 1, selected + 5);
                render();
            } else if (s === '\x1b[H' || s === '\x1b[1~') { // Home
                selected = 0;
                render();
            } else if (s === '\x1b[F' || s === '\x1b[4~') { // End
                selected = items.length - 1;
                render();
            } else if (s === '\r' || s === '\n') {         // Enter
                process.stdin.removeListener('data', onData);
                cleanup();
                process.stdout.write('\n');
                resolve(items[selected].value);
            } else if (s === '\x03') {                     // Ctrl+C
                process.stdin.removeListener('data', onData);
                cleanup();
                console.log(`\n${Y}Отменено пользователем.${RS}`);
                process.exit(0);
            }
        };
        process.stdin.on('data', onData);
    });
}

// ═══════════════════════════════════════════════════════
//   ЗАГОЛОВОК СЕКЦИИ
// ═══════════════════════════════════════════════════════

function sectionHeader(title) {
    console.log(`\n${B}${G}┌─────────────────────────────────────────┐${RS}`);
    console.log(`${B}${G}│${RS} ${B}${title.padEnd(39)}${RS} ${B}${G}│${RS}`);
    console.log(`${B}${G}└─────────────────────────────────────────┘${RS}`);
}

// ═══════════════════════════════════════════════════════
//   ПРОВЕРКА ЗАВИСИМОСТЕЙ
// ═══════════════════════════════════════════════════════

async function checkDependencies() {
    console.log(`\n${B}Проверка зависимостей...${RS}\n`);

    // Node.js
    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    if (major < 18) {
        console.log(`${R}✘ Node.js ${process.version} — нужна версия 18+. Скачайте: https://nodejs.org/${RS}`);
        process.exit(1);
    }
    console.log(`${G}✔ Node.js ${process.version}${RS}`);

    // npm install
    if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
        console.log(`${Y}⏳ Устанавливаем зависимости (npm install)...${RS}`);
        try {
            execSync('npm install', { stdio: 'inherit', cwd: __dirname });
            console.log(`${G}✔ Зависимости установлены${RS}`);
        } catch {
            console.log(`${R}✘ Не удалось установить зависимости. Запустите вручную: npm install${RS}`);
            process.exit(1);
        }
    } else {
        console.log(`${G}✔ Зависимости (node_modules) на месте${RS}`);
    }

    // Playwright + Chromium
    const pwPath = path.join(__dirname, 'node_modules', 'playwright');
    if (fs.existsSync(pwPath)) {
        console.log(`${G}✔ Playwright пакет установлен${RS}`);

        // Проверяем реальный бинарник Chromium, а не только npm-пакет
        try {
            const pw = require('playwright');
            const chromiumPath = pw.chromium.executablePath();
            if (chromiumPath && fs.existsSync(chromiumPath)) {
                console.log(`${G}✔ Chromium бинарник: ${chromiumPath}${RS}`);
            } else {
                console.log(`${Y}⚠️ Playwright установлен, но Chromium бинарник не найден!${RS}`);
                console.log(`${Y}⏳ Устанавливаем Chromium...${RS}`);
                try {
                    execSync('npx playwright install chromium', { stdio: 'inherit', cwd: __dirname });
                    console.log(`${G}✔ Chromium установлен${RS}`);
                } catch {
                    console.log(`${R}✘ Ошибка установки Chromium. Запустите вручную:${RS}`);
                    console.log(`${R}  npx playwright install chromium${RS}`);
                    process.exit(1);
                }
            }
        } catch (e) {
            console.log(`${Y}⚠️ Не удалось проверить Chromium: ${e.message}${RS}`);
            console.log(`${Y}⏳ Устанавливаем Chromium на всякий случай...${RS}`);
            try {
                execSync('npx playwright install chromium', { stdio: 'inherit', cwd: __dirname });
                console.log(`${G}✔ Chromium установлен${RS}`);
            } catch {
                console.log(`${R}✘ Ошибка установки Chromium. Запустите вручную:${RS}`);
                console.log(`${R}  npx playwright install chromium${RS}`);
                process.exit(1);
            }
        }
    } else {
        console.log(`${Y}⏳ Playwright не найден — устанавливаем...${RS}`);
        try {
            execSync('npm install playwright', { stdio: 'inherit', cwd: __dirname });
            execSync('npx playwright install chromium', { stdio: 'inherit', cwd: __dirname });
            console.log(`${G}✔ Playwright + Chromium установлены${RS}`);
        } catch {
            console.log(`${R}✘ Ошибка установки. Запустите вручную:${RS}`);
            console.log(`${R}  npm install && npx playwright install chromium${RS}`);
            process.exit(1);
        }
    }

    // Папки
    for (const dir of ['output/Аккаунты', 'output/Ошибки', 'output/Логи', 'output/Данные', 'output/Архив']) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    console.log(`${G}✔ Рабочие папки готовы${RS}`);
}

// ═══════════════════════════════════════════════════════
//   PRESET MANAGER
// ═══════════════════════════════════════════════════════

const PRESETS_DIR = path.join(__dirname, 'presets');

function ensurePresetsDir() {
    if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });
}

function listPresets() {
    ensurePresetsDir();
    try {
        return fs.readdirSync(PRESETS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    } catch { return []; }
}

function savePreset(name, cfg) {
    ensurePresetsDir();
    const safeName = String(name || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
    // Убираем секреты из пресета
    const safeCfg = { ...cfg };
    if (safeCfg.CODA_API_KEY) safeCfg.CODA_API_KEY = '';
    fs.writeFileSync(path.join(PRESETS_DIR, `${safeName}.json`), JSON.stringify(safeCfg, null, 2), 'utf-8');
    console.log(`${G}✔ Пресет "${safeName}" сохранён${RS}`);
}

function loadPreset(name) {
    const p = path.join(PRESETS_DIR, `${name}.json`);
    if (!fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
        console.log(`${R}✘ Пресет "${name}" повреждён: ${e.message}${RS}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
//   СПИСОК СТРАН
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//   ВСТРОЕННАЯ BIN-БАЗА (для подсказок в start.js)
// ═══════════════════════════════════════════════════════

const BIN_SUGGEST_DB = [
    // VISA Credit — US
    { bin: '451012', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '451013', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '451014', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '451015', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
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
    // MASTERCARD Credit — US
    { bin: '515462', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '515463', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '515464', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '521234', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '528090', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '530125', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '540101', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '540102', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '540103', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '542018', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '549184', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '552100', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    // VISA Credit — GB
    { bin: '492181', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '492960', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '455696', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    // MASTERCARD Credit — GB
    { bin: '522125', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '530135', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    // VISA Credit — DE
    { bin: '492964', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '492965', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Commerzbank', category: 'premium' },
    { bin: '455699', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '455700', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Commerzbank', category: 'premium' },
    // MASTERCARD Credit — DE
    { bin: '530139', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '530140', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Commerzbank', category: 'premium' },
    { bin: '540110', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '540111', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Commerzbank', category: 'premium' },
    // VISA Credit — FI
    { bin: '492978', brand: 'VISA', type: 'credit', country: 'FI', bank: 'Nordea Finland', category: 'premium' },
    { bin: '492979', brand: 'VISA', type: 'credit', country: 'FI', bank: 'OP Financial', category: 'standard' },
    // VISA Credit — FR
    { bin: '492968', brand: 'VISA', type: 'credit', country: 'FR', bank: 'BNP Paribas', category: 'premium' },
    { bin: '492969', brand: 'VISA', type: 'credit', country: 'FR', bank: 'Societe Generale', category: 'premium' },
    // VISA Credit — ES
    { bin: '492980', brand: 'VISA', type: 'credit', country: 'ES', bank: 'Santander', category: 'premium' },
    { bin: '492981', brand: 'VISA', type: 'credit', country: 'ES', bank: 'BBVA', category: 'premium' },
    // VISA Credit — NL
    { bin: '492972', brand: 'VISA', type: 'credit', country: 'NL', bank: 'ABN AMRO', category: 'premium' },
    // VISA Credit — SE
    { bin: '492977', brand: 'VISA', type: 'credit', country: 'SE', bank: 'Nordea', category: 'premium' },
    // VISA Credit — CA
    { bin: '451017', brand: 'VISA', type: 'credit', country: 'CA', bank: 'RBC', category: 'premium' },
    { bin: '451018', brand: 'VISA', type: 'credit', country: 'CA', bank: 'TD Canada', category: 'premium' },
    // MASTERCARD Credit — CA
    { bin: '540112', brand: 'MASTERCARD', type: 'credit', country: 'CA', bank: 'RBC', category: 'premium' },
    { bin: '540113', brand: 'MASTERCARD', type: 'credit', country: 'CA', bank: 'TD Canada', category: 'premium' },
    // VISA Credit — AU
    { bin: '492973', brand: 'VISA', type: 'credit', country: 'AU', bank: 'Commonwealth Bank', category: 'premium' },
    // MASTERCARD Credit — AU
    { bin: '540117', brand: 'MASTERCARD', type: 'credit', country: 'AU', bank: 'Commonwealth Bank', category: 'premium' },
    // VISA Credit — IT
    { bin: '492982', brand: 'VISA', type: 'credit', country: 'IT', bank: 'Intesa Sanpaolo', category: 'premium' },
    { bin: '492983', brand: 'VISA', type: 'credit', country: 'IT', bank: 'UniCredit', category: 'premium' },
    // VISA Credit — JP
    { bin: '492984', brand: 'VISA', type: 'credit', country: 'JP', bank: 'Mizuho', category: 'premium' },
    { bin: '492985', brand: 'VISA', type: 'credit', country: 'JP', bank: 'SMBC', category: 'premium' },
];

/**
 * Подобрать credit BIN-ы для страны
 * @param {string} country - ISO-код страны (US, GB, DE, ...)
 * @returns {Array<{bin, brand, bank, category}>}
 */
function suggestBinsForCountry(country) {
    const c = country.toUpperCase();
    return BIN_SUGGEST_DB
        .filter(b => b.country === c && b.type === 'credit')
        .sort((a, b) => {
            // Premium — первыми
            if (a.category === 'premium' && b.category !== 'premium') return -1;
            if (a.category !== 'premium' && b.category === 'premium') return 1;
            return 0;
        });
}

/**
 * Проверить, совпадает ли страна BIN с биллингом
 * Возвращает BIN-ы, которые НЕ совпадают по стране
 * @param {string[]} bins
 * @param {string} billingCountry
 * @returns {string[]}
 */
function checkBinCountryMismatch(bins, billingCountry) {
    const c = billingCountry.toUpperCase();
    const mismatched = [];
    for (const bin of bins) {
        const bin6 = String(bin).slice(0, 6);
        const info = BIN_SUGGEST_DB.find(b => b.bin === bin6);
        if (info && info.country !== c) {
            mismatched.push(bin);
        }
        // Если не нашли в базе — не можем проверить, не считаем несовпадением
    }
    return mismatched;
}

const COUNTRIES = [
    { value: { country: 'US', address: '350 5th Ave',          city: 'New York',     zip: '10118'   }, label: '🇺🇸  США (New York)'          },
    { value: { country: 'GB', address: '10 Downing St',        city: 'London',        zip: 'SW1A 2AA'}, label: '🇬🇧  Великобритания (London)' },
    { value: { country: 'DE', address: 'Unter den Linden 1',   city: 'Berlin',        zip: '10117'   }, label: '🇩🇪  Германия (Berlin)'       },
    { value: { country: 'FI', address: 'Kivihaantie 16',       city: 'Vaasa',         zip: '65300'   }, label: '🇫🇮  Финляндия (Vaasa)'      },
    { value: { country: 'FR', address: '5 Rue de la Paix',     city: 'Paris',         zip: '75002'   }, label: '🇫🇷  Франция (Paris)'        },
    { value: { country: 'ES', address: 'Calle Gran Via 1',     city: 'Madrid',        zip: '28013'   }, label: '🇪🇸  Испания (Madrid)'       },
    { value: { country: 'NL', address: 'Dam 1',                city: 'Amsterdam',     zip: '1012 JS' }, label: '🇳🇱  Нидерланды (Amsterdam)'  },
    { value: { country: 'SE', address: 'Drottninggatan 1',     city: 'Stockholm',     zip: '111 21'  }, label: '🇸🇪  Швеция (Stockholm)'     },
    { value: { country: 'CA', address: '100 Queen St',         city: 'Ottawa',        zip: 'K1A 0A1' }, label: '🇨🇦  Канада (Ottawa)'        },
    { value: { country: 'AU', address: '1 Macquarie St',       city: 'Sydney',        zip: '2000'    }, label: '🇦🇺  Австралия (Sydney)'     },
    { value: { country: 'IT', address: 'Via del Corso 1',      city: 'Roma',          zip: '00186'   }, label: '🇮🇹  Италия (Roma)'          },
    { value: { country: 'JP', address: '1-1 Chiyoda',          city: 'Tokyo',         zip: '100-0001'}, label: '🇯🇵  Япония (Tokyo)'         },
    { value: { country: 'PT', address: 'Rua Augusta 1',        city: 'Lisboa',        zip: '1100-053'}, label: '🇵🇹  Португалия (Lisboa)'    },
    { value: { country: 'IE', address: '1 Grafton St',         city: 'Dublin',        zip: 'D02'     }, label: '🇮🇪  Ирландия (Dublin)'      },
    { value: { country: 'DK', address: '1 Nyhavn',             city: 'København',     zip: '1051'    }, label: '🇩🇰  Дания (København)'      },
    { value: { country: 'NO', address: 'Karl Johans gate 1',   city: 'Oslo',          zip: '0154'    }, label: '🇳🇴  Норвегия (Oslo)'        },
    { value: { country: 'AT', address: 'Stephansplatz 1',      city: 'Wien',          zip: '1010'    }, label: '🇦🇹  Австрия (Wien)'         },
    { value: { country: 'BE', address: 'Grand Place 1',        city: 'Bruxelles',     zip: '1000'    }, label: '🇧🇪  Бельгия (Bruxelles)'    },
    { value: { country: 'CH', address: 'Bahnhofstrasse 1',     city: 'Zürich',        zip: '8001'    }, label: '🇨🇭  Швейцария (Zürich)'     },
    { value: { country: 'CZ', address: 'Vaclavske namesti 1',  city: 'Praha',         zip: '11000'   }, label: '🇨🇿  Чехия (Praha)'          },
];

// ═══════════════════════════════════════════════════════
//   ИНТЕРАКТИВНАЯ НАСТРОЙКА
// ═══════════════════════════════════════════════════════

async function interactiveSetup() {
    console.log(`\n${B}${G}╔══════════════════════════════════════════════════╗${RS}`);
    console.log(`${B}${G}║${RS}  ${B}DEVIN AI AUTOREGER v5.0 — НАСТРОЙКА${RS}             ${B}${G}║${RS}`);
    console.log(`${B}${G}╚══════════════════════════════════════════════════╝${RS}`);
    console.log(`${D}  Управление: ↑↓ — выбор, Enter — подтвердить${RS}`);

    // ── 0. Пресет ──────────────────────────────────────
    const existingPresets = listPresets();
    if (existingPresets.length > 0) {
        const usePreset = await askYesNo(`Найдено ${existingPresets.length} пресетов. Загрузить пресет?`, false);
        if (usePreset) {
            const presetChoice = await selectFromList(
                'Выберите пресет:',
                existingPresets.map(p => ({ value: p, label: p })),
                0
            );
            const presetCfg = loadPreset(presetChoice);
            if (presetCfg) {
                console.log(`${G}✔ Пресет "${presetChoice}" загружен${RS}`);
                // Дополняем недостающие поля из интерактива
                const cfg = { ...defaultConfig, ...presetCfg };
                cfg.CARD_LENGTH = cfg.CARD_LENGTH || 'auto';
                cfg.EXP_DATE = cfg.EXP_DATE || 'auto';
                cfg.CVC_CODE = cfg.CVC_CODE || 'auto';
                cfg.FINGERPRINT_ROTATION = cfg.FINGERPRINT_ROTATION ?? true;
                cfg.BILLING_ROTATION = cfg.BILLING_ROTATION ?? true;
                cfg.CONCURRENT_ACCOUNTS = cfg.CONCURRENT_ACCOUNTS ?? 1;
                cfg.VALIDATE_BINS = cfg.VALIDATE_BINS ?? true;
                cfg.VALIDATE_BINS_ONLINE = cfg.VALIDATE_BINS_ONLINE ?? true;

                if (!cfg.BINS || cfg.BINS.length === 0) {
                    sectionHeader('BIN (пресет без BIN-ов)');
                    const binsRaw = await ask('Введите BIN-ы через запятую', '');
                    cfg.BINS = binsRaw.split(',').map(b => b.trim()).filter(Boolean);
                }

                if (!cfg.CVC_CODE) {
                    cfg.CVC_CODE = await ask('CVC-код (3–4 цифры или "auto")', 'auto');
                }

                if (!cfg.EXP_DATE) {
                    cfg.EXP_DATE = await ask('Срок действия (ММ/ГГ или "auto")', 'auto');
                }

                if (normalizeMailProvider(cfg.MAIL_PROVIDER) === 'coda' && !cfg.CODA_API_KEY) {
                    cfg.MAIL_PROVIDER = 'coda';
                    cfg.CODA_API_KEY = await ask('API-ключ temp.coda.ink (Enter = использовать fallback на mail.tm)', '');
                    if (!cfg.CODA_API_KEY) {
                        console.log(`${Y}⚠ API-ключ не указан — будет использоваться fallback на mail.tm${RS}`);
                    }
                }

                if (!cfg.ACCOUNT_PASSWORD) {
                    cfg.ACCOUNT_PASSWORD = await ask('Пароль для аккаунтов', 'StrongPassword_2026!');
                }

                return cfg;
            }
        }
    }

    const cfg = {};

    // ── 1. BIN ──────────────────────────────────────────
    sectionHeader('1 / 10   BIN (первые цифры карты)');
    console.log(`  ${C}💡 Совет: credit BIN-ы проходят лучше, prepaid — почти не работают${RS}`);
    console.log(`  ${C}   Подобрать BIN под страну: node internal/bin-lookup.js --filter credit --country US${RS}`);
    console.log('');
    const binsRaw = await ask('Введите BIN-ы через запятую (6–12 цифр каждый)', '');
    cfg.BINS = binsRaw.split(',').map(b => b.trim()).filter(Boolean);
    cfg.BIN_MAX_RETRIES = parseInt(await ask('Сколько попыток BIN при declined карте?', String(defaultConfig.BIN_MAX_RETRIES ?? 10)), 10);
    cfg.BIN_ROTATION_ON_DECLINED = await askYesNo('Ротировать BIN при declined?', true);

    // ── 2. Карта ────────────────────────────────────────
    sectionHeader('2 / 10   Данные карты');
    console.log(`  ${C}💡 Совет: напишите "auto" — скрипт сам подберёт срок и CVC по BIN${RS}`);
    console.log(`  ${C}   "auto" = генерируется валидная дата и правильный CVC автоматически${RS}`);
    console.log('');
    cfg.CARD_LENGTH = 'auto';
    cfg.EXP_DATE = await ask('Срок действия (ММ/ГГ или "auto")', 'auto');
    cfg.CVC_CODE = await ask('CVC-код (3-4 цифры или "auto")', 'auto');

    // ── 3. Почта ────────────────────────────────────────
    sectionHeader('3 / 10   Почтовый провайдер');
    const mailProvider = await selectFromList(
        'Выберите провайдер временной почты:',
        [
            { value: 'coda',   label: 'temp.coda.ink (рекомендуется) — быстрее, выше лимиты, нужен API-ключ' },
            { value: 'mailtm', label: 'mail.tm (бесплатно) — бесплатно, без ключа, медленнее' },
        ],
        0
    );
    cfg.MAIL_PROVIDER = mailProvider;

    if (mailProvider === 'coda') {
        console.log(`\n${Y}Для temp.coda.ink нужен API-ключ.${RS}`);
        console.log(`${D}Получить ключ: https://temp.coda.ink${RS}`);
        cfg.CODA_API_KEY = await ask('Введите API-ключ temp.coda.ink (Enter = fallback на mail.tm)', '');
        if (!cfg.CODA_API_KEY) {
            console.log(`${Y}⚠ API-ключ не указан — при недоступности coda будет использоваться fallback на mail.tm${RS}`);
        }
        cfg.CODA_API_BASE     = 'https://temp.coda.ink/v1';
        cfg.CODA_PROVIDER     = 'tempmail';
        cfg.CODA_CLEANUP      = true;
    } else {
        cfg.CODA_API_KEY      = null;
        cfg.CODA_API_BASE     = null;
        cfg.CODA_PROVIDER     = null;
        cfg.CODA_CLEANUP      = false;
    }

    cfg.MAIL_API_DOMAINS   = 'https://api.mail.tm/domains';
    cfg.MAIL_API_ACCOUNTS  = 'https://api.mail.tm/accounts';
    cfg.MAIL_API_TOKEN     = 'https://api.mail.tm/token';
    cfg.MAIL_API_MESSAGES  = 'https://api.mail.tm/messages';
    cfg.MAIL_RETRY_COUNT   = 3;
    cfg.MAIL_RETRY_DELAY   = 3000;
    cfg.MAIL_TIMEOUT       = 30000;

    // ── 4. Прокси ───────────────────────────────────────
    sectionHeader('4 / 10   Прокси');
    const useProxy = await askYesNo('Использовать прокси?', false);
    if (useProxy) {
        const proxyInput = await ask('Прокси (формат: ip:port  или  user:pass@ip:port  или  http://...)', '');
        cfg.PROXY = proxyInput || null;

        const proxyListPath = await ask('Файл со списком прокси (путь или Enter — нет)', '');
        cfg.PROXY_LIST = proxyListPath || null;
        cfg.PROXY_ROTATION = await askYesNo('Ротация прокси между аккаунтами?', false);
    } else {
        cfg.PROXY = null;
        cfg.PROXY_LIST = null;
        cfg.PROXY_ROTATION = false;
    }

    // ── 5. Страна / биллинг ─────────────────────────────
    sectionHeader('5 / 10   Страна и биллинг');
    const countryChoice = await selectFromList(
        'Выберите страну для Stripe (↑↓ — выбор, Enter — подтвердить):',
        COUNTRIES,
        0
    );
    cfg.BILLING_PROFILES = [countryChoice];
    cfg.BILLING_NAME = await ask('Имя владельца карты', 'John Doe');

    // Предлагаем BIN под выбранную страну (если BIN не введены или не совпадают)
    const selectedCountry = countryChoice.country; // e.g. 'US'
    if (cfg.BINS.length === 0) {
        console.log(`\n  ${Y}⚠️ BIN-ы не указаны. Рекомендуем credit BIN страны ${selectedCountry}.${RS}`);
        const suggestBins = await askYesNo(`Подобрать BIN-ы для ${selectedCountry} из базы?`, true);
        if (suggestBins) {
            const suggested = suggestBinsForCountry(selectedCountry);
            if (suggested.length > 0) {
                console.log(`  ${G}Найдено ${suggested.length} credit BIN-ов для ${selectedCountry}:${RS}`);
                for (const b of suggested.slice(0, 10)) {
                    console.log(`    ★ ${b.bin} — ${b.brand} — ${b.bank}`);
                }
                if (suggested.length > 10) console.log(`    ... и ещё ${suggested.length - 10}`);
                const useSuggested = await askYesNo('Использовать эти BIN-ы?', true);
                if (useSuggested) {
                    cfg.BINS = suggested.map(b => b.bin);
                    console.log(`  ${G}✔ Установлено ${cfg.BINS.length} BIN-ов${RS}`);
                }
            } else {
                console.log(`  ${R}Нет BIN-ов для ${selectedCountry} в базе${RS}`);
            }
        }
    } else {
        const mismatchBins = checkBinCountryMismatch(cfg.BINS, selectedCountry);
        if (mismatchBins.length > 0) {
            console.log(`\n  ${Y}⚠️ Внимание: некоторые BIN-ы могут не совпадать по стране с биллингом (${selectedCountry}).${RS}`);
            console.log(`  ${Y}   Stripe может отклонить карту, если страна BIN ≠ страна биллинга.${RS}`);
            const suggestBins = await askYesNo(`Подобрать BIN-ы для ${selectedCountry}?`, false);
            if (suggestBins) {
                const suggested = suggestBinsForCountry(selectedCountry);
                if (suggested.length > 0) {
                    console.log(`  ${G}Найдено ${suggested.length} credit BIN-ов для ${selectedCountry}:${RS}`);
                    for (const b of suggested.slice(0, 10)) {
                        console.log(`    ★ ${b.bin} — ${b.brand} — ${b.bank}`);
                    }
                    const useSuggested = await askYesNo('Добавить эти BIN-ы к текущим?', true);
                    if (useSuggested) {
                        cfg.BINS = [...new Set([...suggested.map(b => b.bin), ...cfg.BINS])];
                        console.log(`  ${G}✔ Теперь ${cfg.BINS.length} BIN-ов${RS}`);
                    }
                }
            }
        }
    }

    // ── 6. Аккаунт ──────────────────────────────────────
    sectionHeader('6 / 10   Настройки аккаунта');
    cfg.ACCOUNT_PASSWORD = await ask('Пароль для аккаунтов', 'StrongPassword_2026!');
    const countRaw = await ask('Сколько аккаунтов создать? (0 = бесконечно, Ctrl+C — стоп)', '0');
    cfg.ACCOUNTS_COUNT = parseInt(countRaw, 10) || 0;
    cfg.RETRY_ON_CRASH = await askYesNo('Повторять при краше аккаунта?', false);
    cfg.RETRY_ON_CRASH_MAX = 1;

    // ── 7. Браузер ──────────────────────────────────────
    sectionHeader('7 / 10   Настройки браузера');
    const headlessChoice = await selectFromList(
        'Режим отображения браузера:',
        [
            { value: false, label: 'Видимый режим — окно браузера видно на экране' },
            { value: true,  label: 'Headless режим — браузер работает в фоне, без окна' },
        ],
        0
    );
    cfg.HEADLESS = headlessChoice;
    cfg.TIMEZONE    = 'Europe/Berlin';
    cfg.LOCALE      = 'de-DE';
    cfg.USER_AGENT  = null;
    cfg.VIEWPORT    = { width: 1920, height: 1080 };
    cfg.SCREEN      = { width: 1920, height: 1080 };
    cfg.BROWSER_ARGS = [];

    // ── 8. Маскировка ───────────────────────────────────
    sectionHeader('8 / 10   Маскировка (stealth)');
    cfg.STEALTH_ENABLED = await askYesNo('Включить маскировку автоматизации (stealth)?', true);
    cfg.STEALTH_LEVEL   = 'advanced';
    cfg.WEBGL_VENDOR    = 'Google Inc. (NVIDIA)';
    cfg.WEBGL_RENDERER  = 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)';

    // ── 9. Ротация ──────────────────────────────────────
    sectionHeader('9 / 10   Ротация fingerprint и биллинга');
    console.log(`  ${C}💡 Ротация = каждый аккаунт выглядит как другой пользователь${RS}`);
    console.log(`  ${C}   Fingerprint: меняет GPU, разрешение экрана — сайты видят разные "компьютеры"${RS}`);
    console.log(`  ${C}   Биллинг: меняет timezone и язык браузера под страну карты${RS}`);
    console.log('');
    cfg.FINGERPRINT_ROTATION = await askYesNo('Ротация fingerprint (GPU + viewport на каждый аккаунт)?', true);
    cfg.BILLING_ROTATION = await askYesNo('Ротация биллинга (timezone + locale под страну)?', true);

    // ── 10. Параллельность ──────────────────────────────
    sectionHeader('10 / 10   Параллельные аккаунты');
    console.log(`  ${C}💡 Несколько браузеров одновременно = быстрее регистрация${RS}`);
    console.log(`  ${C}   Внимание: каждый браузер жрёт ~200 МБ RAM. 5 браузеров = ~1 ГБ${RS}`);
    console.log('');
    const concurrentRaw = await ask('Сколько браузеров одновременно? (1 = последовательно)', '1');
    cfg.CONCURRENT_ACCOUNTS = Math.max(1, parseInt(concurrentRaw, 10) || 1);

    // BIN валидация
    cfg.VALIDATE_BINS = true;
    cfg.VALIDATE_BINS_ONLINE = true;

    // ── Тайминги (оптимизированы для скорости) ──────────
    cfg.DELAY_BEFORE_TRIAL_CLICK  = [3000, 5000];
    cfg.DELAY_AFTER_CODE_INPUT    = 5000;
    cfg.DELAY_PAYMENT_WAIT        = 75000;
    cfg.DELAY_OTP_WAIT            = 60000;
    cfg.DELAY_OTP_POLL            = 3000;
    cfg.PAUSE_BETWEEN_ACCOUNTS    = [2000, 5000];
    cfg.DELAY_TYPING              = [40, 100];
    cfg.DELAY_BETWEEN_ACTIONS    = [200, 500];
    cfg.AUTO_TIMING               = await askYesNo('Авто-подбор таймингов по прошлым запускам?', true);
    cfg.TIMING_PROFILE_FILE       = 'output/Данные/timing_profile.json';

    // ── Капча ───────────────────────────────────────────
    cfg.HCAPTCHA_ENABLED         = true;
    cfg.HCAPTCHA_MAX_ATTEMPTS    = 15;
    cfg.HCAPTCHA_CHECK_INTERVAL  = 2000;

    // ── Вывод ───────────────────────────────────────────
    cfg.ACCOUNTS_FILE         = 'output/Данные/accounts.txt';
    cfg.READY_DIR             = 'output/Аккаунты';
    cfg.ERROR_DIR             = 'output/Ошибки';
    cfg.ARCHIVE_DIR           = 'output/Архив';
    cfg.LOG_FILE              = 'output/Логи/autoreger.log';
    cfg.SCREENSHOT_ON_ERROR   = true;
    cfg.KNOWN_BINS_FILE       = 'output/Данные/known_bins.json';

    // ── Вебхук ──────────────────────────────────────────
    cfg.WEBHOOK_URL     = null;
    cfg.WEBHOOK_TIMEOUT = 10000;

    // ── Расширенные ─────────────────────────────────────
    cfg.OTP_EMAIL_KEYWORDS   = ['devin', 'verification', 'confirm', 'otp', 'code'];
    cfg.OTP_CONTEXT_REGEX    = '(?:code|код|verify|verification|otp|pin)[^\\d]{0,30}(\\d{6})';
    cfg.OTP_FALLBACK_REGEX   = '\\b\\d{6}\\b';
    cfg.GRACEFUL_SHUTDOWN   = true;

    return cfg;
}

// ═══════════════════════════════════════════════════════
//   СВОДНАЯ ТАБЛИЦА ПЕРЕД ЗАПУСКОМ
// ═══════════════════════════════════════════════════════

function showSummary(cfg) {
    const w = 52;
    const line = '─'.repeat(w);
    const dline = '═'.repeat(w);

    function row(label, value) {
        const maxValLen = w - 4 - label.length - 1;
        const trimmed = value.length > maxValLen ? value.slice(0, maxValLen - 1) + '…' : value;
        const pad = w - 4 - label.length - trimmed.length;
        return `│ ${label}${' '.repeat(Math.max(pad, 1))}${trimmed} │`;
    }

    console.log(`\n${B}${G}╔${dline}╗${RS}`);
    console.log(`${B}${G}║${RS}  ${B}СВОДКА КОНФИГУРАЦИИ${RS}                        ${B}${G}║${RS}`);
    console.log(`${B}${G}╠${line}╣${RS}`);

    // BIN
    console.log(`${B}${G}║${RS}  ${B}BIN и карта${RS}                                ${B}${G}║${RS}`);
    console.log(`${B}${G}${row('BIN-ы:', cfg.BINS.join(', '))}${RS}`);
    console.log(`${B}${G}${row('Срок карты:', cfg.EXP_DATE)}${RS}`);
    console.log(`${B}${G}${row('CVC:', cfg.CVC_CODE)}${RS}`);
    console.log(`${B}${G}╠${line}╣${RS}`);

    // Почта
    console.log(`${B}${G}║${RS}  ${B}Почта${RS}                                       ${B}${G}║${RS}`);
    const mailLabel = normalizeMailProvider(cfg.MAIL_PROVIDER) === 'coda'
        ? `temp.coda.ink (ключ: ${cfg.CODA_API_KEY ? '****' + cfg.CODA_API_KEY.slice(-4) : 'не указан'})`
        : 'mail.tm (бесплатно)';
    console.log(`${B}${G}${row('Провайдер:', mailLabel)}${RS}`);
    console.log(`${B}${G}╠${line}╣${RS}`);

    // Прокси
    console.log(`${B}${G}║${RS}  ${B}Прокси${RS}                                      ${B}${G}║${RS}`);
    const proxyLabel = cfg.PROXY ? cfg.PROXY : 'без прокси';
    console.log(`${B}${G}${row('Прокси:', proxyLabel)}${RS}`);
    if (cfg.PROXY_LIST) console.log(`${B}${G}${row('Список:', cfg.PROXY_LIST)}${RS}`);
    console.log(`${B}${G}╠${line}╣${RS}`);

    // Страна
    console.log(`${B}${G}║${RS}  ${B}Биллинг${RS}                                     ${B}${G}║${RS}`);
    const bp = cfg.BILLING_PROFILES[0];
    const countryItem = COUNTRIES.find(c => c.value.country === bp.country);
    const countryLabel = countryItem ? countryItem.label : bp.country;
    console.log(`${B}${G}${row('Страна:', countryLabel)}${RS}`);
    console.log(`${B}${G}${row('Имя:', cfg.BILLING_NAME)}${RS}`);
    console.log(`${B}${G}╠${line}╣${RS}`);

    // Аккаунт
    console.log(`${B}${G}║${RS}  ${B}Аккаунт${RS}                                     ${B}${G}║${RS}`);
    const countLabel = cfg.ACCOUNTS_COUNT === 0 ? '∞ (Ctrl+C — стоп)' : String(cfg.ACCOUNTS_COUNT);
    console.log(`${B}${G}${row('Количество:', countLabel)}${RS}`);
    console.log(`${B}${G}${row('Пароль:', '********' + ' (' + cfg.ACCOUNT_PASSWORD.length + ' символов)')}${RS}`);
    console.log(`${B}${G}${row('Повтор при краше:', cfg.RETRY_ON_CRASH ? 'да' : 'нет')}${RS}`);
    console.log(`${B}${G}╠${line}╣${RS}`);

    // Браузер
    console.log(`${B}${G}║${RS}  ${B}Браузер и маскировка${RS}                        ${B}${G}║${RS}`);
    console.log(`${B}${G}${row('Headless:', cfg.HEADLESS ? 'да (в фоне)' : 'нет (видно окно)')}${RS}`);
    console.log(`${B}${G}${row('Stealth:', cfg.STEALTH_ENABLED ? 'вкл' : 'выкл')}${RS}`);
    console.log(`${B}${G}${row('Fingerprint ротация:', cfg.FINGERPRINT_ROTATION ? 'вкл (разные GPU/viewport)' : 'выкл')}${RS}`);
    console.log(`${B}${G}${row('Биллинг ротация:', cfg.BILLING_ROTATION ? 'вкл (TZ/locale по стране)' : 'выкл')}${RS}`);
    console.log(`${B}${G}${row('Авто-тайминги:', cfg.AUTO_TIMING ? 'вкл (по статистике прошлых запусков)' : 'выкл')}${RS}`);
    console.log(`${B}${G}${row('Параллельность:', cfg.CONCURRENT_ACCOUNTS > 1 ? cfg.CONCURRENT_ACCOUNTS + ' браузеров' : 'последовательно')}${RS}`);
    console.log(`${B}${G}╚${dline}╝${RS}`);
}

// ═══════════════════════════════════════════════════════
//   ЗАПУСК
// ═══════════════════════════════════════════════════════

(async () => {
    await checkDependencies();

    const userConfig = await interactiveSetup();

    const errors = [];
    for (const b of userConfig.BINS) {
        if (!/^\d{6,12}$/.test(b)) errors.push(`BIN "${b}" — должен быть 6-12 цифр`);
    }
    if (!userConfig.CVC_CODE || (!/^\d{3,4}$/.test(userConfig.CVC_CODE) && userConfig.CVC_CODE !== 'auto')) {
        errors.push('CVC-код — 3 или 4 цифры, или "auto"');
    }
    if (!userConfig.EXP_DATE || (!/^\d{2}\/\d{2}$/.test(userConfig.EXP_DATE) && userConfig.EXP_DATE !== 'auto')) {
        errors.push('Срок карты — формат ММ/ГГ, или "auto"');
    } else if (userConfig.EXP_DATE !== 'auto') {
        const [mm] = userConfig.EXP_DATE.split('/').map(Number);
        if (mm < 1 || mm > 12) errors.push(`Месяц "${mm}" — должен быть 01-12`);
    }
    if (!userConfig.ACCOUNT_PASSWORD || userConfig.ACCOUNT_PASSWORD.length < 4) errors.push('Пароль — минимум 4 символа');

    if (errors.length > 0) {
        console.log(`\n${R}╔══════════════════════════════════════════════════╗${RS}`);
        console.log(`${R}║  ОШИБКИ В НАСТРОЙКАХ:${RS}`);
        errors.forEach(e => console.log(`${R}║  ✘ ${e}${RS}`));
        console.log(`${R}╚══════════════════════════════════════════════════╝${RS}`);
        console.log(`${Y}Запустите снова и исправьте: node start.js${RS}`);
        closeRL();
        process.exit(1);
    }

    showSummary(userConfig);

    const confirmed = await askYesNo('\nВсё верно? Запускаем?', true);
    if (!confirmed) {
        console.log(`${Y}Отменено. Запустите снова: node start.js${RS}`);
        closeRL();
        process.exit(0);
    }

    const saveAsPreset = await askYesNo('Сохранить настройки как пресет для повторного запуска?', false);
    if (saveAsPreset) {
        const presetName = await ask('Имя пресета', 'default');
        savePreset(presetName, userConfig);
    }

    closeRL();

    // 5. Записать конфиг во ВРЕМЕННЫЙ файл (не в корень проекта!)
    // Используем os.tmpdir() + случайное имя — секреты не остаются в папке проекта
    const tmpDir = os.tmpdir();
    const tmpId = crypto.randomBytes(8).toString('hex');
    const tmpConfigPath = path.join(tmpDir, `autoreger_runtime_${tmpId}.json`);
    fs.writeFileSync(tmpConfigPath, JSON.stringify(userConfig, null, 2), 'utf-8');
    process.env.AUTOREGER_RUNTIME_CONFIG = tmpConfigPath;

    const cleanupTemp = () => {
        try { if (fs.existsSync(tmpConfigPath)) fs.unlinkSync(tmpConfigPath); } catch { }
    };
    process.on('exit', cleanupTemp);
    process.on('SIGINT', () => { cleanupTemp(); process.exit(0); });
    process.on('SIGTERM', () => { cleanupTemp(); process.exit(0); });
    process.on('uncaughtException', (err) => {
        console.error(`${R}[!] uncaughtException: ${err.message}${RS}`);
        cleanupTemp();
        process.exit(1);
    });

    // 6. Запуск autoreger — конфиг загружается через AUTOREGER_RUNTIME_CONFIG env var
    // Больше НЕ нужен _config_loader.js и monkey-patch Module._resolveFilename
    console.log(`\n${G}🚀 Запускаем autoreger...${RS}\n`);
    require('./internal/autoreger.js');
})();
