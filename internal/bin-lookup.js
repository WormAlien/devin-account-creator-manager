/**
 * BIN Lookup & Validator v2.2
 *
 * Легальный инструмент для проверки BIN-ов через публичные API.
 * Показывает: банк, страну, тип карты (credit/debit/prepaid), бренд.
 *
 * Новое в v2.2:
 *   - Результаты поиска BIN сохраняются в output/Данные/found_bins.txt
 *   - Сгенерированные карты сохраняются в output/Данные/generated_cards.txt
 *   - --gen-cards — сгенерировать тестовые карты из BIN (Luhn + авто-длина/CVC/дата)
 *
 * Запуск:
 *   node internal/bin-lookup.js                    — интерактивный режим
 *   node internal/bin-lookup.js 451234             — проверить один BIN
 *   node internal/bin-lookup.js 451234,515462      — проверить несколько BIN
 *   node internal/bin-lookup.js --filter credit    — показать только credit BIN-ы
 *   node internal/bin-lookup.js --country US       — показать только BIN-ы страны US
 *   node internal/bin-lookup.js --generate 10      — сгенерировать 10 случайных BIN-ов и проверить
 *   node internal/bin-lookup.js --gen-cards 5      — сгенерировать 5 карт из BIN конфига
 *   node internal/bin-lookup.js --gen-cards 3 --bin 451012  — 3 карты из конкретного BIN
 *   node internal/bin-lookup.js --sync             — обновить кеш для BIN из config.js
 *   node internal/bin-lookup.js --sync-all         — обновить ВСЮ базу через API (долго!)
 *   node internal/bin-lookup.js --cache-stats      — статистика кеша
 *   node internal/bin-lookup.js --cache-clear       — очистить кеш
 *
 * Автор: @qlevis (Telegram)
 * Спасибо за вдохновение: @abuz_ai (Telegram)
 */

const fs = require('fs');
const path = require('path');

// Сохраняем оригинальные функции консоли
const _log = console.log.bind(console);
const _info = console.info.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
const _debug = console.debug.bind(console);

// Подавляем вывод библиотек
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;
console.debug = noop;

// Восстанавливаем для нашего вывода
console.log = _log;
console.info = _info;
console.warn = _warn;
console.error = _error;
console.debug = _debug;

// ═══════════════════════════════════════════════════════
//   ЦВЕТА
// ═══════════════════════════════════════════════════════
const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const C = '\x1b[36m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const RS = '\x1b[0m';

// ═══════════════════════════════════════════════════════
//   КЕШ BIN-ОВ
// ═══════════════════════════════════════════════════════

const CACHE_FILE = path.join(__dirname, '..', 'output', 'Данные', 'bin_cache.json');

/**
 * Загрузить кеш с диска
 * @returns {Object} { bins: { '451012': { bin, brand, type, country, bank, ... } }, updated: ISO }
 */
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        }
    } catch (e) {
        console.log(`  ${Y}⚠️ Ошибка чтения кеша: ${e.message}${RS}`);
    }
    return { bins: {}, updated: null };
}

/**
 * Сохранить кеш на диск
 * @param {Object} cache
 */
function saveCache(cache) {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cache.updated = new Date().toISOString();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (e) {
        console.log(`  ${R}✘ Ошибка сохранения кеша: ${e.message}${RS}`);
    }
}

/**
 * Добавить BIN в кеш
 * @param {Object} cache
 * @param {Object} binInfo - { bin, brand, type, country, bank, category, prepaid, ... }
 */
function addToCache(cache, binInfo) {
    if (!binInfo || !binInfo.bin) return;
    cache.bins[binInfo.bin] = {
        bin: binInfo.bin,
        brand: binInfo.brand || 'UNKNOWN',
        type: binInfo.type || 'unknown',
        country: binInfo.country || '??',
        countryName: binInfo.countryName || '',
        bank: binInfo.bank || 'Unknown',
        category: binInfo.category || 'standard',
        prepaid: binInfo.prepaid || false,
        cachedAt: new Date().toISOString(),
        source: binInfo.source || 'api',
    };
}

/**
 * Найти BIN в кеше
 * @param {Object} cache
 * @param {string} bin
 * @returns {Object|null}
 */
function getFromCache(cache, bin) {
    return cache.bins[bin] || null;
}

// ═══════════════════════════════════════════════════════
//   ВСТРОЕННАЯ БАЗА BIN-ОВ (публичная информация)
// ═══════════════════════════════════════════════════════

const BIN_DATABASE = [
    // === VISA CREDIT — США ===
    { bin: '451012', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '451013', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '451014', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '451015', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '451016', brand: 'VISA', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '453201', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '453202', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '453203', brand: 'VISA', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '453214', brand: 'VISA', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '453215', brand: 'VISA', type: 'credit', country: 'US', bank: 'Discover', category: 'standard' },
    { bin: '453216', brand: 'VISA', type: 'credit', country: 'US', bank: 'US Bank', category: 'standard' },
    { bin: '453217', brand: 'VISA', type: 'credit', country: 'US', bank: 'PNC Bank', category: 'standard' },
    { bin: '453218', brand: 'VISA', type: 'credit', country: 'US', bank: 'TD Bank', category: 'standard' },
    { bin: '453219', brand: 'VISA', type: 'credit', country: 'US', bank: 'SunTrust', category: 'standard' },
    { bin: '453220', brand: 'VISA', type: 'credit', country: 'US', bank: 'BB&T', category: 'standard' },
    { bin: '453221', brand: 'VISA', type: 'credit', country: 'US', bank: 'American Express', category: 'premium' },
    { bin: '453222', brand: 'VISA', type: 'credit', country: 'US', bank: 'HSBC US', category: 'standard' },
    { bin: '455689', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '455690', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '455691', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '455692', brand: 'VISA', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '455693', brand: 'VISA', type: 'credit', country: 'US', bank: 'US Bank', category: 'standard' },
    { bin: '455694', brand: 'VISA', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '455695', brand: 'VISA', type: 'credit', country: 'US', bank: 'PNC Bank', category: 'standard' },
    { bin: '471321', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '471322', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '471323', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '471621', brand: 'VISA', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '471622', brand: 'VISA', type: 'credit', country: 'US', bank: 'US Bank', category: 'standard' },
    { bin: '471623', brand: 'VISA', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '491610', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '491611', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '491612', brand: 'VISA', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '491613', brand: 'VISA', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '492910', brand: 'VISA', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '492911', brand: 'VISA', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '492912', brand: 'VISA', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },

    // === MASTERCARD CREDIT — США ===
    { bin: '515462', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '515463', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '515464', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '515465', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '515466', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '521234', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '521235', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '521236', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '521237', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '528090', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '528091', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '528092', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '528093', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '530125', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '530126', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'US Bank', category: 'standard' },
    { bin: '530127', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'PNC Bank', category: 'standard' },
    { bin: '530128', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '530129', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'TD Bank', category: 'standard' },
    { bin: '530130', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'SunTrust', category: 'standard' },
    { bin: '540101', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '540102', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '540103', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '540104', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '540105', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '540106', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'US Bank', category: 'standard' },
    { bin: '540107', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'PNC Bank', category: 'standard' },
    { bin: '540108', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'HSBC US', category: 'standard' },
    { bin: '540109', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Barclays US', category: 'standard' },
    { bin: '542018', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '542019', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '542020', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '542021', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '542022', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '542023', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'US Bank', category: 'standard' },
    { bin: '542024', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'PNC Bank', category: 'standard' },
    { bin: '549184', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '549185', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '549186', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '549187', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '552100', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'JPMorgan Chase', category: 'premium' },
    { bin: '552101', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Bank of America', category: 'premium' },
    { bin: '552102', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Citibank', category: 'premium' },
    { bin: '552103', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Wells Fargo', category: 'premium' },
    { bin: '552104', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'Capital One', category: 'premium' },
    { bin: '552105', brand: 'MASTERCARD', type: 'credit', country: 'US', bank: 'US Bank', category: 'standard' },

    // === VISA CREDIT — Великобритания ===
    { bin: '492181', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '492182', brand: 'VISA', type: 'credit', country: 'GB', bank: 'HSBC UK', category: 'premium' },
    { bin: '492183', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Lloyds', category: 'premium' },
    { bin: '492960', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '492961', brand: 'VISA', type: 'credit', country: 'GB', bank: 'HSBC UK', category: 'premium' },
    { bin: '492962', brand: 'VISA', type: 'credit', country: 'GB', bank: 'NatWest', category: 'standard' },
    { bin: '492963', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Santander UK', category: 'standard' },
    { bin: '455696', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '455697', brand: 'VISA', type: 'credit', country: 'GB', bank: 'HSBC UK', category: 'premium' },
    { bin: '455698', brand: 'VISA', type: 'credit', country: 'GB', bank: 'Lloyds', category: 'premium' },

    // === MASTERCARD CREDIT — Великобритания ===
    { bin: '522125', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '522126', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'HSBC UK', category: 'premium' },
    { bin: '522127', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'Lloyds', category: 'premium' },
    { bin: '530135', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'Barclays', category: 'premium' },
    { bin: '530136', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'HSBC UK', category: 'premium' },
    { bin: '530137', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'NatWest', category: 'standard' },
    { bin: '530138', brand: 'MASTERCARD', type: 'credit', country: 'GB', bank: 'Santander UK', category: 'standard' },

    // === VISA CREDIT — Германия ===
    { bin: '492964', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '492965', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Commerzbank', category: 'premium' },
    { bin: '492966', brand: 'VISA', type: 'credit', country: 'DE', bank: 'DKB', category: 'standard' },
    { bin: '492967', brand: 'VISA', type: 'credit', country: 'DE', bank: 'ING Germany', category: 'standard' },
    { bin: '455699', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '455700', brand: 'VISA', type: 'credit', country: 'DE', bank: 'Commerzbank', category: 'premium' },
    { bin: '471624', brand: 'VISA', type: 'credit', country: 'DE', bank: 'DKB', category: 'standard' },
    { bin: '471625', brand: 'VISA', type: 'credit', country: 'DE', bank: 'ING Germany', category: 'standard' },

    // === MASTERCARD CREDIT — Германия ===
    { bin: '530139', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '530140', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Commerzbank', category: 'premium' },
    { bin: '530141', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'DKB', category: 'standard' },
    { bin: '530142', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'ING Germany', category: 'standard' },
    { bin: '540110', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Deutsche Bank', category: 'premium' },
    { bin: '540111', brand: 'MASTERCARD', type: 'credit', country: 'DE', bank: 'Commerzbank', category: 'premium' },

    // === VISA CREDIT — Канада ===
    { bin: '451017', brand: 'VISA', type: 'credit', country: 'CA', bank: 'RBC', category: 'premium' },
    { bin: '451018', brand: 'VISA', type: 'credit', country: 'CA', bank: 'TD Canada', category: 'premium' },
    { bin: '451019', brand: 'VISA', type: 'credit', country: 'CA', bank: 'Scotiabank', category: 'premium' },
    { bin: '453223', brand: 'VISA', type: 'credit', country: 'CA', bank: 'CIBC', category: 'standard' },
    { bin: '453224', brand: 'VISA', type: 'credit', country: 'CA', bank: 'BMO', category: 'standard' },

    // === MASTERCARD CREDIT — Канада ===
    { bin: '540112', brand: 'MASTERCARD', type: 'credit', country: 'CA', bank: 'RBC', category: 'premium' },
    { bin: '540113', brand: 'MASTERCARD', type: 'credit', country: 'CA', bank: 'TD Canada', category: 'premium' },
    { bin: '540114', brand: 'MASTERCARD', type: 'credit', country: 'CA', bank: 'Scotiabank', category: 'premium' },
    { bin: '540115', brand: 'MASTERCARD', type: 'credit', country: 'CA', bank: 'CIBC', category: 'standard' },
    { bin: '540116', brand: 'MASTERCARD', type: 'credit', country: 'CA', bank: 'BMO', category: 'standard' },

    // === VISA CREDIT — Франция ===
    { bin: '492968', brand: 'VISA', type: 'credit', country: 'FR', bank: 'BNP Paribas', category: 'premium' },
    { bin: '492969', brand: 'VISA', type: 'credit', country: 'FR', bank: 'Societe Generale', category: 'premium' },
    { bin: '492970', brand: 'VISA', type: 'credit', country: 'FR', bank: 'Credit Agricole', category: 'standard' },
    { bin: '455701', brand: 'VISA', type: 'credit', country: 'FR', bank: 'BNP Paribas', category: 'premium' },
    { bin: '455702', brand: 'VISA', type: 'credit', country: 'FR', bank: 'Societe Generale', category: 'premium' },

    // === VISA CREDIT — Нидерланды ===
    { bin: '492972', brand: 'VISA', type: 'credit', country: 'NL', bank: 'ABN AMRO', category: 'premium' },
    { bin: '492971', brand: 'VISA', type: 'credit', country: 'NL', bank: 'ING Netherlands', category: 'standard' },

    // === VISA CREDIT — Австралия ===
    { bin: '492973', brand: 'VISA', type: 'credit', country: 'AU', bank: 'Commonwealth Bank', category: 'premium' },
    { bin: '492974', brand: 'VISA', type: 'credit', country: 'AU', bank: 'Westpac', category: 'premium' },
    { bin: '492975', brand: 'VISA', type: 'credit', country: 'AU', bank: 'ANZ', category: 'premium' },

    // === MASTERCARD CREDIT — Австралия ===
    { bin: '540117', brand: 'MASTERCARD', type: 'credit', country: 'AU', bank: 'Commonwealth Bank', category: 'premium' },
    { bin: '540118', brand: 'MASTERCARD', type: 'credit', country: 'AU', bank: 'Westpac', category: 'premium' },
    { bin: '540119', brand: 'MASTERCARD', type: 'credit', country: 'AU', bank: 'ANZ', category: 'premium' },

    // === VISA CREDIT — Швеция ===
    { bin: '492977', brand: 'VISA', type: 'credit', country: 'SE', bank: 'Nordea', category: 'premium' },
    { bin: '492976', brand: 'VISA', type: 'credit', country: 'SE', bank: 'Swedbank', category: 'standard' },

    // === VISA CREDIT — Финляндия ===
    { bin: '492978', brand: 'VISA', type: 'credit', country: 'FI', bank: 'Nordea Finland', category: 'premium' },
    { bin: '492979', brand: 'VISA', type: 'credit', country: 'FI', bank: 'OP Financial', category: 'standard' },

    // === VISA CREDIT — Испания ===
    { bin: '492980', brand: 'VISA', type: 'credit', country: 'ES', bank: 'Santander', category: 'premium' },
    { bin: '492981', brand: 'VISA', type: 'credit', country: 'ES', bank: 'BBVA', category: 'premium' },

    // === VISA CREDIT — Италия ===
    { bin: '492982', brand: 'VISA', type: 'credit', country: 'IT', bank: 'Intesa Sanpaolo', category: 'premium' },
    { bin: '492983', brand: 'VISA', type: 'credit', country: 'IT', bank: 'UniCredit', category: 'premium' },

    // === VISA CREDIT — Япония ===
    { bin: '492984', brand: 'VISA', type: 'credit', country: 'JP', bank: 'Mizuho', category: 'premium' },
    { bin: '492985', brand: 'VISA', type: 'credit', country: 'JP', bank: 'SMBC', category: 'premium' },
    { bin: '492986', brand: 'VISA', type: 'credit', country: 'JP', bank: 'MUFG', category: 'premium' },
];

// ═══════════════════════════════════════════════════════
//   BIN LOOKUP API (с кешем!)
// ═══════════════════════════════════════════════════════

const globalCache = loadCache();

/**
 * Онлайн-проверка BIN через binlist.net
 * @param {string} bin - 6 цифр
 * @returns {Promise<Object|null>}
 */
async function lookupBinOnline(bin) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`https://lookup.binlist.net/${bin}`, {
            signal: controller.signal,
            headers: { 'Accept-Version': '3' }
        });
        clearTimeout(timeout);

        if (res.status === 429) {
            console.log(`  ${Y}⚠️ Rate limit (429) — пауза 60 сек...${RS}`);
            await new Promise(r => setTimeout(r, 60000));
            return null; // caller должен retry
        }
        if (!res.ok) {
            console.log(`  ${R}✘ HTTP ${res.status}${RS}`);
            return null;
        }

        const data = await res.json();
        return {
            bin,
            brand: data.scheme?.toUpperCase() || 'UNKNOWN',
            type: data.type || 'unknown',
            country: data.country?.alpha2 || '??',
            countryName: data.country?.name || 'Unknown',
            bank: data.bank?.name || 'Unknown',
            category: data.type === 'credit' ? 'premium' : (data.type === 'debit' ? 'standard' : 'prepaid'),
            prepaid: data.prepaid || false,
            source: 'api',
        };
    } catch (e) {
        if (e.name === 'AbortError') {
            console.log(`  ${R}✘ Таймаут${RS}`);
        } else {
            console.log(`  ${R}✘ ${e.message}${RS}`);
        }
        return null;
    }
}

/**
 * Поиск BIN: кеш → локальная база → онлайн
 * @param {string} bin
 * @param {boolean} useOnline
 * @param {boolean} updateCache - сохранить результат в кеш
 * @returns {Promise<Object|null>}
 */
async function lookupBin(bin, useOnline = true, updateCache = true) {
    // 1. Кеш
    const cached = getFromCache(globalCache, bin);
    if (cached) {
        const age = Date.now() - new Date(cached.cachedAt).getTime();
        const ageDays = Math.round(age / 86400000);
        console.log(`  ${G}✔${RS} BIN ${bin}: ${cached.brand} ${cached.type} | ${cached.country} | ${cached.bank} (кеш, ${ageDays}д назад)`);
        return cached;
    }

    // 2. Локальная база
    const local = BIN_DATABASE.find(b => b.bin === bin);
    if (local) {
        console.log(`  ${G}✔${RS} BIN ${bin}: ${local.brand} ${local.type} | ${local.country} | ${local.bank} | ${local.category} (база)`);
        if (updateCache) {
            addToCache(globalCache, { ...local, source: 'builtin' });
            saveCache(globalCache);
        }
        return local;
    }

    // 3. Онлайн
    if (useOnline) {
        console.log(`  ${C}⏳${RS} BIN ${bin}: ищем онлайн...`);
        const online = await lookupBinOnline(bin);
        if (online) {
            const typeIcon = online.type === 'credit' ? '💳' : (online.type === 'debit' ? '🏦' : '🎫');
            console.log(`  ${G}✔${RS} BIN ${bin}: ${online.brand} ${typeIcon} ${online.type} | ${online.country} (${online.countryName}) | ${online.bank}${online.prepaid ? ' (PREPAID!)' : ''}`);
            if (updateCache) {
                addToCache(globalCache, online);
                saveCache(globalCache);
            }
            return online;
        }
    }

    console.log(`  ${R}✘${RS} BIN ${bin}: не найден`);
    return null;
}

// ═══════════════════════════════════════════════════════
//   ФИЛЬТРАЦИЯ И ГЕНЕРАЦИЯ
// ═══════════════════════════════════════════════════════

function filterBins(filters = {}) {
    // Объединяем: кеш + встроенная база (без дублей)
    const allBins = [...Object.values(globalCache.bins)];
    for (const b of BIN_DATABASE) {
        if (!globalCache.bins[b.bin]) allBins.push(b);
    }

    let results = allBins;

    if (filters.type) results = results.filter(b => b.type === filters.type);
    if (filters.country) results = results.filter(b => b.country === filters.country.toUpperCase());
    if (filters.brand) results = results.filter(b => b.brand === filters.brand.toUpperCase());
    if (filters.category) results = results.filter(b => b.category === filters.category);
    if (filters.excludePrepaid) results = results.filter(b => b.type !== 'prepaid' && !b.prepaid);

    return results;
}

function generateRandomBins(count, brand = null) {
    const prefixes = { VISA: ['4'], MASTERCARD: ['51', '52', '53', '54', '55'] };
    const bins = new Set();
    const allPrefixes = brand ? prefixes[brand] : [...prefixes.VISA, ...prefixes.MASTERCARD];
    while (bins.size < count) {
        const prefix = allPrefixes[Math.floor(Math.random() * allPrefixes.length)];
        let bin = prefix;
        while (bin.length < 6) bin += Math.floor(Math.random() * 10);
        bins.add(bin);
    }
    return [...bins];
}

// ═══════════════════════════════════════════════════════
//   ВЫВОД
// ═══════════════════════════════════════════════════════

function printBinTable(bins) {
    if (bins.length === 0) {
        console.log(`\n${R}Нет BIN-ов по заданным критериям${RS}`);
        return;
    }

    console.log(`\n${B}════════════════════════════════════════════════════════════════════════════${RS}`);
    console.log(`  ${B}Найдено: ${bins.length} BIN-ов${RS}`);
    console.log(`${B}════════════════════════════════════════════════════════════════════════════${RS}\n`);

    const byCountry = {};
    for (const b of bins) {
        if (!byCountry[b.country]) byCountry[b.country] = [];
        byCountry[b.country].push(b);
    }

    for (const [country, countryBins] of Object.entries(byCountry)) {
        console.log(`  ${B}${country}${RS} (${countryBins.length} шт.)`);
        const credit = countryBins.filter(b => b.type === 'credit');
        const debit = countryBins.filter(b => b.type === 'debit');
        const prepaid = countryBins.filter(b => b.type === 'prepaid' || b.prepaid);

        if (credit.length > 0) {
            console.log(`    ${G}💳 Credit (${credit.length}):${RS}`);
            for (const b of credit) {
                const cat = b.category === 'premium' ? `${Y}★${RS}` : ' ';
                const src = b.source === 'api' ? `${D}[API]${RS}` : (b.source === 'builtin' ? `${D}[base]${RS}` : '');
                console.log(`      ${cat} ${b.bin} — ${b.brand} — ${b.bank} ${src}`);
            }
        }
        if (debit.length > 0) {
            console.log(`    ${C}🏦 Debit (${debit.length}):${RS}`);
            for (const b of debit) console.log(`      ${b.bin} — ${b.brand} — ${b.bank}`);
        }
        if (prepaid.length > 0) {
            console.log(`    ${D}🎫 Prepaid (${prepaid.length}):${RS}`);
            for (const b of prepaid) console.log(`      ${b.bin} — ${b.brand} — ${b.bank}`);
        }
        console.log('');
    }

    const creditBins = bins.filter(b => b.type === 'credit');
    if (creditBins.length > 0) {
        const binList = creditBins.map(b => `'${b.bin}'`).join(', ');
        console.log(`${B}════════════════════════════════════════════════════════════════════════════${RS}`);
        console.log(`  ${G}📋 Для вставки в config.js (только credit):${RS}\n`);
        console.log(`  BINS: [${binList}]`);

        const outputDir = path.join(__dirname, '..', 'output', 'Данные');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'found_bins.txt');
        const fileContent = [
            `# Найденные BIN-ы — ${new Date().toISOString()}`,
            `# Формат: BIN | бренд | тип | страна | банк | категория`,
            '',
            ...creditBins.map(b => `${b.bin} | ${b.brand} | ${b.type} | ${b.country} | ${b.bank} | ${b.category || 'standard'}`),
            '',
            `# Для config.js (только credit):`,
            `BINS: [${binList}]`,
            '',
        ].join('\n');
        fs.appendFileSync(outputPath, fileContent + '\n', 'utf-8');
        console.log(`  ${G}💾 BIN-ы сохранены: output/Данные/found_bins.txt${RS}`);
        console.log(`${B}════════════════════════════════════════════════════════════════════════════${RS}`);
    }
}

// ═══════════════════════════════════════════════════════
//   SYNC — ОБНОВЛЕНИЕ КЕША ЧЕРЕЗ API
// ═══════════════════════════════════════════════════════

/**
 * Синхронизация BIN-ов из конфига через API
 */
async function syncFromConfig() {
    let configBins = [];
    try {
        const configPath = path.join(__dirname, '..', 'config.js');
        if (fs.existsSync(configPath)) {
            const cfg = require(configPath);
            configBins = Array.isArray(cfg.BINS) ? cfg.BINS : (cfg.BINS ? [cfg.BINS] : []);
        }
    } catch { }

    if (configBins.length === 0) {
        // Пробуем known_bins.json
        try {
            const knownPath = path.join(__dirname, '..', 'output', 'Данные', 'known_bins.json');
            if (fs.existsSync(knownPath)) {
                const known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
                configBins = [...(known.known_good || []), ...(known.known_bad || [])];
            }
        } catch { }
    }

    if (configBins.length === 0) {
        console.log(`${R}Нет BIN-ов для синхронизации. Укажите BINS в config.js${RS}`);
        return;
    }

    console.log(`\n${B}Синхронизация ${configBins.length} BIN-ов через API...${RS}\n`);

    let updated = 0;
    let cached = 0;
    let failed = 0;

    for (const bin of configBins) {
        const bin6 = String(bin).slice(0, 6);

        // Пропускаем если уже в кеше и свежий (< 7 дней)
        const existing = getFromCache(globalCache, bin6);
        if (existing) {
            const age = Date.now() - new Date(existing.cachedAt).getTime();
            if (age < 7 * 86400000) { // 7 дней
                console.log(`  ${D}○ ${bin6} — уже в кеше (${existing.brand} ${existing.type}, ${existing.country})${RS}`);
                cached++;
                continue;
            }
        }

        const info = await lookupBinOnline(bin6);
        if (info) {
            addToCache(globalCache, info);
            console.log(`  ${G}✔ ${bin6}: ${info.brand} ${info.type} | ${info.country} | ${info.bank}${RS}`);
            updated++;
        } else {
            console.log(`  ${R}✘ ${bin6}: не найден${RS}`);
            failed++;
        }

        // Пауза между запросами (binlist.net = ~10 req/мин)
        await new Promise(r => setTimeout(r, 7000)); // 7 сек = ~8.5 req/мин
    }

    saveCache(globalCache);

    console.log(`\n${B}════════════════════════════════════════${RS}`);
    console.log(`  ${G}Обновлено: ${updated}${RS}`);
    console.log(`  ${C}Из кеша: ${cached}${RS}`);
    console.log(`  ${R}Не найдено: ${failed}${RS}`);
    console.log(`  Кеш: ${Object.keys(globalCache.bins).length} BIN-ов`);
    console.log(`${B}════════════════════════════════════════${RS}`);
}

/**
 * Полная синхронизация всей встроенной базы через API
 */
async function syncAll() {
    const allBins = BIN_DATABASE.map(b => b.bin);
    console.log(`\n${B}Полная синхронизация ${allBins.length} BIN-ов через API...${RS}`);
    console.log(`${Y}⚠️ Это займёт ~${Math.round(allBins.length * 7 / 60)} минут (rate limit binlist.net)${RS}\n`);

    let updated = 0;
    let cached = 0;
    let failed = 0;

    for (let i = 0; i < allBins.length; i++) {
        const bin = allBins[i];

        // Пропускаем если свежий в кеше
        const existing = getFromCache(globalCache, bin);
        if (existing) {
            const age = Date.now() - new Date(existing.cachedAt).getTime();
            if (age < 30 * 86400000) { // 30 дней для sync-all
                console.log(`  ${D}[${i + 1}/${allBins.length}] ○ ${bin} — кеш OK${RS}`);
                cached++;
                continue;
            }
        }

        console.log(`  ${C}[${i + 1}/${allBins.length}]${RS} ${bin}: запрашиваем...`);
        const info = await lookupBinOnline(bin);
        if (info) {
            addToCache(globalCache, info);
            console.log(`  ${G}  ✔ ${info.brand} ${info.type} | ${info.country} | ${info.bank}${RS}`);
            updated++;
        } else {
            console.log(`  ${R}  ✘ не найден${RS}`);
            failed++;
        }

        await new Promise(r => setTimeout(r, 7000));

        // Сохраняем промежуточно каждые 20 BIN
        if ((i + 1) % 20 === 0) {
            saveCache(globalCache);
            console.log(`  ${D}  [промежуточное сохранение: ${Object.keys(globalCache.bins).length} в кеше]${RS}`);
        }
    }

    saveCache(globalCache);

    console.log(`\n${B}════════════════════════════════════════${RS}`);
    console.log(`  ${G}Обновлено: ${updated}${RS}`);
    console.log(`  ${C}Из кеша: ${cached}${RS}`);
    console.log(`  ${R}Не найдено: ${failed}${RS}`);
    console.log(`  Кеш: ${Object.keys(globalCache.bins).length} BIN-ов`);
    console.log(`${B}════════════════════════════════════════${RS}`);
}

/**
 * Статистика кеша
 */
function showCacheStats() {
    const bins = Object.values(globalCache.bins);
    if (bins.length === 0) {
        console.log(`\n${Y}Кеш пуст. Запустите --sync для заполнения.${RS}`);
        return;
    }

    console.log(`\n${B}════════════════════════════════════════${RS}`);
    console.log(`  ${B}КАШ BIN-ОВ${RS}`);
    console.log(`${B}════════════════════════════════════════${RS}\n`);
    console.log(`  Всего: ${bins.length} BIN-ов`);
    console.log(`  Обновлён: ${globalCache.updated || 'N/A'}`);

    const byType = {};
    const byCountry = {};
    const bySource = {};
    for (const b of bins) {
        byType[b.type] = (byType[b.type] || 0) + 1;
        byCountry[b.country] = (byCountry[b.country] || 0) + 1;
        bySource[b.source || 'unknown'] = (bySource[b.source || 'unknown'] || 0) + 1;
    }

    console.log(`\n  По типу:`);
    for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
        const icon = type === 'credit' ? '💳' : (type === 'debit' ? '🏦' : '🎫');
        console.log(`    ${icon} ${type}: ${count}`);
    }

    console.log(`\n  По стране:`);
    for (const [country, count] of Object.entries(byCountry).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${country}: ${count}`);
    }

    console.log(`\n  По источнику:`);
    for (const [source, count] of Object.entries(bySource)) {
        console.log(`    ${source}: ${count}`);
    }

    console.log(`${B}════════════════════════════════════════${RS}`);
}

// ═══════════════════════════════════════════════════════
//   ГЕНЕРАЦИЯ КАРТ
// ═══════════════════════════════════════════════════════

/**
 * Определить длину карты по BIN
 */
function detectCardLength(bin) {
    const first1 = bin.slice(0, 1);
    const first2 = bin.slice(0, 2);
    const first4 = bin.slice(0, 4);
    if (first2 === '34' || first2 === '37') return 15;
    if (first2 === '36' || first2 === '38') return 14;
    if (first2 === '35' && first4 >= '3528' && first4 <= '3589') return 16;
    if (['51', '52', '53', '54', '55'].includes(first2)) return 16;
    const first4num = parseInt(first4, 10);
    if (first4num >= 2221 && first4num <= 2720) return 16;
    if (first1 === '4') return 16;
    return 16;
}

/**
 * Определить бренд карты по BIN
 */
function detectCardBrand(bin) {
    const first1 = bin.slice(0, 1);
    const first2 = bin.slice(0, 2);
    const first4 = bin.slice(0, 4);
    if (first2 === '34' || first2 === '37') return 'AMEX';
    if (first2 === '36' || first2 === '38') return 'DINERS';
    if (first2 === '35' && first4 >= '3528' && first4 <= '3589') return 'JCB';
    if (['51', '52', '53', '54', '55'].includes(first2)) return 'MASTERCARD';
    const first4num = parseInt(first4, 10);
    if (first4num >= 2221 && first4num <= 2720) return 'MASTERCARD';
    if (first1 === '4') return 'VISA';
    return 'UNKNOWN';
}

/**
 * Luhn-генерация карты из BIN
 */
function generateLuhnCard(bin) {
    const cardLength = detectCardLength(bin);
    const neededRandom = cardLength - bin.length - 1;
    let randomPart = '';
    for (let i = 0; i < neededRandom; i++) randomPart += Math.floor(Math.random() * 10);
    const prefix = bin + randomPart;
    let sum = 0;
    for (let i = 0; i < prefix.length; i++) {
        let n = parseInt(prefix[i], 10);
        if ((prefix.length - i + 1) % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
        sum += n;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return prefix + checkDigit;
}

/**
 * Валидация Luhn
 */
function validateLuhn(cardNumber) {
    let sum = 0, alternate = false;
    for (let i = cardNumber.length - 1; i >= 0; i--) {
        let n = parseInt(cardNumber[i], 10);
        if (alternate) { n *= 2; if (n > 9) n -= 9; }
        sum += n;
        alternate = !alternate;
    }
    return sum % 10 === 0;
}

/**
 * Генерация CVC по бренду
 */
function generateCVC(bin) {
    const brand = detectCardBrand(bin);
    const length = brand === 'AMEX' ? 4 : 3;
    let cvc = '';
    for (let i = 0; i < length; i++) cvc += Math.floor(Math.random() * 10);
    return cvc;
}

/**
 * Генерация даты (текущий месяц + 1-3 года)
 */
function generateExpDate() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const futureYear = now.getFullYear() + 1 + Math.floor(Math.random() * 3);
    const yy = String(futureYear % 100).padStart(2, '0');
    return `${month}/${yy}`;
}

/**
 * Генерация тестовых карт из BIN
 * @param {string[]} bins - список BIN
 * @param {number} countPerBin - карт на каждый BIN
 */
function generateCards(bins, countPerBin) {
    console.log(`\n${B}════════════════════════════════════════════════════════════════════════════${RS}`);
    console.log(`  ${B}Генерация ${countPerBin} карт на каждый из ${bins.length} BIN-ов${RS}`);
    console.log(`${B}════════════════════════════════════════════════════════════════════════════${RS}\n`);

    const fileLines = [];
    fileLines.push(`# Сгенерированные карты — ${new Date().toISOString()}`);
    fileLines.push(`# Формат: номер | срок | cvc | BIN | бренд | тип | страна`);
    fileLines.push('');

    for (const bin of bins) {
        const brand = detectCardBrand(bin);
        const cardLen = detectCardLength(bin);
        const info = lookupBinLocal(bin) || getFromCache(globalCache, bin);
        const typeLabel = info ? info.type : 'unknown';
        const bankLabel = info ? info.bank : 'Unknown';
        const countryLabel = info ? info.country : '??';

        console.log(`  ${B}${bin}${RS} — ${brand} ${typeLabel} | ${countryLabel} | ${bankLabel} (длина: ${cardLen} цифр)`);

        for (let i = 0; i < countPerBin; i++) {
            const card = generateLuhnCard(bin);
            const cvc = generateCVC(bin);
            const exp = generateExpDate();
            const luhnOk = validateLuhn(card);
            const status = luhnOk ? `${G}✔ Luhn OK${RS}` : `${R}✘ Luhn FAIL${RS}`;
            console.log(`    ${card} | ${exp} | ${cvc} | ${status}`);
            if (luhnOk) {
                fileLines.push(`${card} | ${exp} | ${cvc} | ${bin} | ${brand} | ${typeLabel} | ${countryLabel}`);
            }
        }
        console.log('');
    }

    const outputDir = path.join(__dirname, '..', 'output', 'Данные');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'generated_cards.txt');
    fs.appendFileSync(outputPath, fileLines.join('\n') + '\n', 'utf-8');

    console.log(`${B}════════════════════════════════════════════════════════════════════════════${RS}`);
    console.log(`  ${Y}⚠️ Все карты проходят Luhn, но НЕ гарантируют реальную авторизацию${RS}`);
    console.log(`  ${Y}   Stripe проверяет: Luhn → структура → реальный счёт → AVS → CVC${RS}`);
    console.log(`${B}════════════════════════════════════════════════════════════════════════════${RS}`);
    console.log(`  ${G}💾 Карты сохранены: output/Данные/generated_cards.txt${RS}`);
}

/** @private Быстрый lookup в локальной базе */
function lookupBinLocal(bin) {
    return BIN_DATABASE.find(b => b.bin === bin) || null;
}

// ═══════════════════════════════════════════════════════
//   CLI
// ═══════════════════════════════════════════════════════

function printHelp() {
    console.log(`
${B}BIN Lookup & Validator v2.2${RS}

${B}Использование:${RS}
  node internal/bin-lookup.js                         Интерактивный режим
  node internal/bin-lookup.js 451234                  Проверить один BIN
  node internal/bin-lookup.js 451234,515462           Проверить несколько BIN
  node internal/bin-lookup.js --filter credit         Показать только credit BIN-ы
  node internal/bin-lookup.js --country US            Показать только BIN-ы США
  node internal/bin-lookup.js --country DE --filter credit   Credit BIN-ы Германии
  node internal/bin-lookup.js --generate 10           Сгенерировать 10 случайных BIN-ов
  node internal/bin-lookup.js --generate 20 --brand visa      20 случайных VISA BIN-ов
  node internal/bin-lookup.js --sync                  Обновить кеш для BIN из config.js
  node internal/bin-lookup.js --sync-all              Обновить ВСЮ базу через API (долго!)
  node internal/bin-lookup.js --cache-stats           Статистика кеша
  node internal/bin-lookup.js --cache-clear            Очистить кеш
  node internal/bin-lookup.js --help                  Эта справка

${B}Фильтры:${RS}
  --filter credit|debit|prepaid    Тип карты
  --country US|GB|DE|...          Страна (ISO-код)
  --brand visa|mastercard         Бренд карты
  --category premium|standard     Категория
  --exclude-prepaid               Исключить prepaid

${B}Кеш:${RS}
  Все результаты API-запросов кешируются в output/Данные/bin_cache.json
  При повторном запросе — берётся из кеша (мгновенно, без сети)
  Кеш автоматически используется autoreger.js при валидации BIN

${B}Советы:${RS}
  • Для подписок лучше всего подходят ${G}credit${RS} BIN-ы
  • ${R}prepaid${RS} BIN-ы редко проходят на Stripe
  • ${Y}premium${RS} = крупные банки, выше шанс успеха
  • Запускайте --sync регулярно для обновления данных
`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }
    if (args.includes('--cache-stats')) { showCacheStats(); return; }
    if (args.includes('--cache-clear')) {
        saveCache({ bins: {}, updated: null });
        console.log(`${G}Кеш очищен${RS}`);
        return;
    }
    if (args.includes('--sync-all')) { await syncAll(); return; }
    if (args.includes('--sync')) { await syncFromConfig(); return; }

    let binsToCheck = [];
    let filterType = null;
    let filterCountry = null;
    let filterBrand = null;
    let filterCategory = null;
    let excludePrepaid = false;
    let generateCount = 0;
    let genCardsCount = 0;
    let genCardsBin = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--filter' && args[i + 1]) { filterType = args[i + 1].toLowerCase(); i++; }
        else if (args[i] === '--country' && args[i + 1]) { filterCountry = args[i + 1].toUpperCase(); i++; }
        else if (args[i] === '--brand' && args[i + 1]) { filterBrand = args[i + 1].toUpperCase(); i++; }
        else if (args[i] === '--category' && args[i + 1]) { filterCategory = args[i + 1].toLowerCase(); i++; }
        else if (args[i] === '--exclude-prepaid') { excludePrepaid = true; }
        else if (args[i] === '--generate' && args[i + 1]) { generateCount = parseInt(args[i + 1], 10) || 0; i++; }
        else if (args[i] === '--gen-cards' && args[i + 1]) { genCardsCount = parseInt(args[i + 1], 10) || 5; i++; }
        else if (args[i] === '--bin' && args[i + 1]) { genCardsBin = args[i + 1]; i++; }
        else if (!args[i].startsWith('--')) {
            binsToCheck = args[i].split(',').map(b => b.trim()).filter(Boolean);
        }
    }

    // Режим: Генерация карт
    if (genCardsCount > 0) {
        let bins = [];
        if (genCardsBin) {
            bins = [genCardsBin];
        } else {
            try {
                const cfg = require(path.join(__dirname, '..', 'config.js'));
                bins = Array.isArray(cfg.BINS) ? cfg.BINS : (cfg.BINS ? [cfg.BINS] : []);
            } catch { }
            if (bins.length === 0) {
                // Берём из known_bins.json
                try {
                    const known = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'output', 'Данные', 'known_bins.json'), 'utf-8'));
                    bins = [...(known.known_good || [])];
                } catch { }
            }
            if (bins.length === 0) {
                console.log(`${R}Нет BIN-ов. Укажите --bin XXXXXX или BINS в config.js${RS}`);
                return;
            }
        }
        generateCards(bins, genCardsCount);
        return;
    }

    console.log(`\n${B}${G}╔══════════════════════════════════════════════════╗${RS}`);
    console.log(`${B}${G}║${RS}  ${B}BIN LOOKUP & VALIDATOR v2.2${RS}                   ${B}${G}║${RS}`);
    console.log(`${B}${G}║${RS}  ${D}Кеш: ${Object.keys(globalCache.bins).length} BIN-ов${RS}                              ${B}${G}║${RS}`);
    console.log(`${B}${G}╚══════════════════════════════════════════════════╝${RS}`);

    // Режим 1: Фильтрация из базы + кеш
    if (filterType || filterCountry || filterBrand || filterCategory || excludePrepaid) {
        console.log(`\n${C}Фильтрация (кеш + встроенная база)...${RS}`);
        const results = filterBins({ type: filterType, country: filterCountry, brand: filterBrand, category: filterCategory, excludePrepaid });
        printBinTable(results);
        return;
    }

    // Режим 2: Генерация случайных BIN-ов
    if (generateCount > 0) {
        console.log(`\n${C}Генерация ${generateCount} случайных BIN-ов...${RS}`);
        const generated = generateRandomBins(generateCount, filterBrand);
        console.log(`\n${B}Проверка сгенерированных BIN-ов:${RS}\n`);
        const results = [];
        for (const bin of generated) {
            const info = await lookupBin(bin, true);
            if (info) results.push(info);
            await new Promise(r => setTimeout(r, 7000));
        }
        if (results.length > 0) printBinTable(results);
        else console.log(`\n${R}Ни один BIN не найден в базе${RS}`);
        return;
    }

    // Режим 3: Проверка конкретных BIN-ов
    if (binsToCheck.length > 0) {
        console.log(`\n${B}Проверка ${binsToCheck.length} BIN-ов:${RS}\n`);
        const results = [];
        for (const bin of binsToCheck) {
            if (!/^\d{6,12}$/.test(bin)) {
                console.log(`  ${R}✘${RS} "${bin}" — не BIN (нужно 6-12 цифр)`);
                continue;
            }
            const info = await lookupBin(bin.slice(0, 6), true);
            if (info) results.push(info);
            // Пауза только если не было кеша
            if (!getFromCache(globalCache, bin.slice(0, 6)) && !BIN_DATABASE.find(b => b.bin === bin.slice(0, 6))) {
                await new Promise(r => setTimeout(r, 7000));
            }
        }
        if (results.length > 0) printBinTable(results);
        return;
    }

    // Режим 4: Интерактивный
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q) => new Promise(resolve => rl.question(q, resolve));

    console.log(`\n${B}Выберите режим:${RS}`);
    console.log(`  1. Показать все credit BIN-ы (кеш + база)`);
    console.log(`  2. Показать BIN-ы по стране`);
    console.log(`  3. Проверить конкретный BIN`);
    console.log(`  4. Сгенерировать случайные BIN-ы`);
    console.log(`  5. Показать лучшие BIN-ы для подписок (credit, premium) ★`);
    console.log(`  6. Обновить кеш (--sync)`);
    console.log(`\n  ${D}Результаты сохраняются: output/Данные/found_bins.txt${RS}`);
    console.log(`  ${D}Карты сохраняются: output/Данные/generated_cards.txt${RS}`);

    const mode = await question(`\n${C}Режим (1-6): ${RS}`);

    if (mode === '1') {
        const results = filterBins({ type: 'credit' });
        printBinTable(results);
    } else if (mode === '2') {
        const country = await question(`${C}Страна (US, GB, DE, FR, CA, AU, NL, SE, FI, ES, IT, JP): ${RS}`);
        const results = filterBins({ country: country.trim().toUpperCase() });
        printBinTable(results);
    } else if (mode === '3') {
        const binInput = await question(`${C}BIN (6 цифр): ${RS}`);
        const bin = binInput.trim().slice(0, 6);
        if (/^\d{6}$/.test(bin)) await lookupBin(bin, true);
        else console.log(`${R}Нужно ровно 6 цифр${RS}`);
    } else if (mode === '4') {
        const countInput = await question(`${C}Количество: ${RS}`);
        const count = parseInt(countInput, 10) || 10;
        const generated = generateRandomBins(count);
        console.log(`\n${B}Проверка ${count} BIN-ов:${RS}\n`);
        const results = [];
        for (const bin of generated) {
            const info = await lookupBin(bin, true);
            if (info) results.push(info);
            await new Promise(r => setTimeout(r, 7000));
        }
        if (results.length > 0) printBinTable(results);
    } else if (mode === '5') {
        const results = filterBins({ type: 'credit', category: 'premium' });
        printBinTable(results);
    } else if (mode === '6') {
        await syncFromConfig();
    }

    rl.close();
}

main().catch(e => console.error(`${R}Ошибка: ${e.message}${RS}`));
