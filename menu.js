const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const SESSIONS_DIR = 'manual_sessions';
const QUOTA_CACHE_FILE = 'logs/.quota_cache.json';

// ─── Кэш квот в файле ───────────────────────────────────────────────────────
function loadQuotaCache() {
    try {
        if (fs.existsSync(QUOTA_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, 'utf-8')) || {};
        }
    } catch {}
    return {};
}

function saveQuotaCache(cache) {
    try {
        fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {}
}

// Загружаем текущий config
let config = require('./config.js');

// Функция для сохранения config
// Сохраняем только те поля, которые меню может изменить.
// Остальные поля остаются в config.js как есть (не перезаписываем весь файл).
function saveConfig() {
    // Читаем текущий config.js как текст
    const configPath = './config.js';
    let content = fs.readFileSync(configPath, 'utf-8');
    
    // Функция для замены значения поля в конфиге
    const replaceField = (fieldName, newValue) => {
        // Пробуем разные паттерны по очереди
        const oldContent = content;
        
        // Многострочный массив: BINS: [\n    "..."\n],
        // Ищем строку начинающуюся с пробелов (не комментарий с //)
        content = content.replace(
            new RegExp(`(\\n[ \\t]+${fieldName}:\\s*)\\[[\\s\\S]*?\\](,?)`),
            (match, prefix) => `${prefix}${newValue}${match.endsWith(',') ? ',' : ''}`
        );
        if (content !== oldContent) return true;
        
        // Строка: FIELD: 'value',
        content = content.replace(
            new RegExp(`(\\n[ \\t]+${fieldName}:\\s*)'[^']*'(,?)`),
            (match, prefix) => `${prefix}${newValue}${match.endsWith(',') ? ',' : ''}`
        );
        if (content !== oldContent) return true;
        
        // Число: FIELD: 123,
        content = content.replace(
            new RegExp(`(\\n[ \\t]+${fieldName}:\\s*)\\d+(,?)`),
            (match, prefix) => `${prefix}${newValue}${match.endsWith(',') ? ',' : ''}`
        );
        if (content !== oldContent) return true;
        
        // Boolean: FIELD: true/false,
        content = content.replace(
            new RegExp(`(\\n[ \\t]+${fieldName}:\\s*)(true|false)(,?)`),
            (match, prefix) => `${prefix}${newValue}${match.endsWith(',') ? ',' : ''}`
        );
        if (content !== oldContent) return true;
        
        return false;
    };
    
    // Обновляем только поля, которые меню может изменить
    // Карта
    replaceField('BINS', JSON.stringify(config.BINS));
    replaceField('BIN_MAX_RETRIES', config.BIN_MAX_RETRIES);
    replaceField('EXP_DATE', `'${config.EXP_DATE}'`);
    replaceField('CVC_CODE', `'${config.CVC_CODE}'`);
    
    // Прокси
    replaceField('PROXY', config.PROXY === null ? 'null' : `'${config.PROXY}'`);
    replaceField('PROXY_LIST', config.PROXY_LIST === null ? 'null' : `'${config.PROXY_LIST}'`);
    replaceField('PROXY_ROTATION', config.PROXY_ROTATION);
    
    // Локаль/Страна
    replaceField('BILLING_PROFILES', JSON.stringify(config.BILLING_PROFILES));
    replaceField('TIMEZONE', `'${config.TIMEZONE}'`);
    replaceField('LOCALE', `'${config.LOCALE}'`);
    replaceField('BILLING_ROTATION', config.BILLING_ROTATION);
    replaceField('FINGERPRINT_ROTATION', config.FINGERPRINT_ROTATION);
    
    // Остальное
    replaceField('ACCOUNTS_COUNT', config.ACCOUNTS_COUNT);
    replaceField('MANUAL_MODE', config.MANUAL_MODE);
    replaceField('SOUND_NOTIFICATIONS', config.SOUND_NOTIFICATIONS);
    replaceField('HEADLESS', config.HEADLESS);
    
    fs.writeFileSync(configPath, content);
    console.log('✅ Конфигурация сохранена в config.js');
}

// ─── Raw-mode утилиты ────────────────────────────────────────────────────────

// Очистка экрана: курсор в (0,0) + очистка вниз + очистка скроллбэка.
// Гарантирует что новый рендер всегда начинается с пустого экрана.
const clearScreen = () => {
    process.stdout.write('\x1b[H\x1b[2J\x1b[3J');
};

// Глобальный обработчик Ctrl+C — всегда снимает raw mode перед выходом
const menuSigintHandler = () => {
    if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch (_) {}
    }
    process.stdout.write('\n');
    process.exit(0);
};
process.on('SIGINT', menuSigintHandler);

// Запускаем keypress один раз
readline.emitKeypressEvents(process.stdin);
// Убираем лимит на слушателей (по умолчанию 10 — при вложенных меню копятся и тормозят)
process.stdin.setMaxListeners(0);

// Утилита: снять все keypress-слушатели и добавить один новый
// Используется вместо прямого .on() чтобы слушатели не копились
function setKeypressListener(fn) {
    process.stdin.removeAllListeners('keypress');
    if (fn) process.stdin.on('keypress', fn);
}

// Выбор из списка стрелками
function rawList(title, items) {
    return new Promise(resolve => {
        let idx = 0;
        let renderedLines = 0;

        const render = (first = false) => {
            const lines = [];
            lines.push(`  ${title}`, '');
            items.forEach((item, i) => {
                if (item.disabled) {
                    lines.push(`\x1b[2m  ─ ${item.label}\x1b[0m`);
                    return;
                }
                const cursor = i === idx ? '\x1b[36m❯\x1b[0m' : ' ';
                const text   = i === idx ? `\x1b[36m${item.label}\x1b[0m` : item.label;
                lines.push(`  ${cursor} ${text}`);
            });
            lines.push('', '  ↑↓ — навигация   Enter — выбор');

            if (first) {
                // Первый рендер — полная очистка экрана
                clearScreen();
                process.stdout.write(lines.join('\x1b[K\n') + '\x1b[K\n');
            } else {
                // Последующие — курсор вверх + перезапись + стираем остаток каждой строки
                process.stdout.write(`\x1b[${renderedLines}A`);
                process.stdout.write(lines.join('\x1b[K\n') + '\x1b[K\n');
            }
            renderedLines = lines.length;
        };

        const done = (val) => {
            setKeypressListener(null);
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch (_) {}
            }
            process.stdin.pause();
            resolve(val);
        };

        const nextIdx = (cur, dir) => {
            let i = (cur + dir + items.length) % items.length;
            while (items[i].disabled) i = (i + dir + items.length) % items.length;
            return i;
        };

        const onKey = (str, key) => {
            if (!key) return;
            if (key.name === 'up')        { idx = nextIdx(idx, -1); render(); }
            else if (key.name === 'down') { idx = nextIdx(idx, 1);  render(); }
            else if (key.name === 'return') {
                const val = items[idx].value;
                if (items[idx].disabled) return;
                done(val);
            } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                done(null);
            }
        };

        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            try { process.stdin.setRawMode(true); } catch (_) {}
        }
        render(true);
        setKeypressListener(onKey);
    });
}

// Ввод строки (обычный readline, без raw mode)
function rawInput(msg, defaultVal = '') {
    return new Promise(resolve => {
        // Выключаем raw mode перед readline
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            try { process.stdin.setRawMode(false); } catch (_) {}
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const display = defaultVal ? `${msg} [${defaultVal}]: ` : `${msg}: `;
        rl.question(display, ans => {
            rl.close();
            const trimmed = ans.trim();
            resolve(trimmed !== '' ? trimmed : defaultVal);
        });
    });
}

// ─── Главное меню ───────────────────────────────────────────────────────────
async function mainMenu() {
    while (true) {
    // Формируем понятное отображение карты
    const bins = Array.isArray(config.BINS) ? config.BINS : (config.BINS ? [config.BINS] : []);
    const hasBins = bins.length > 0 && bins.some(b => b);
    
    let cardDisplay;
    if (!hasBins) {
        cardDisplay = 'АВТО (из базы 48 BIN-ов)';
    } else if (bins.length === 1) {
        const b = bins[0];
        if (b.length === 16) {
            cardDisplay = `${b.slice(0,4)} **** **** ${b.slice(-4)}`;
        } else {
            cardDisplay = `BIN: ${b}`;
        }
    } else {
        cardDisplay = `${bins.length} BIN-ов (ротация)`;
    }
    
    const expDisplay = config.EXP_DATE === 'auto' ? 'авто' : config.EXP_DATE;
    const cvcDisplay = config.CVC_CODE === 'auto' ? 'авто' : config.CVC_CODE;
    
    // Прокси отображение
    let proxyDisplay;
    if (config.PROXY) {
        proxyDisplay = config.PROXY.length > 25 ? config.PROXY.slice(0, 22) + '...' : config.PROXY;
    } else if (config.PROXY_LIST) {
        proxyDisplay = `Файл: ${config.PROXY_LIST}`;
    } else {
        proxyDisplay = 'Нет';
    }
    
    // Локаль отображение
    const billingCountry = config.BILLING_PROFILES?.[0]?.country || 'US';
    const localeDisplay = config.BILLING_ROTATION ? `Авто (${billingCountry})` : `${config.TIMEZONE}`;
    
    const action = await rawList('⚙️  DEVIN.AI AUTOREG', [
        { label: `🗂️   Менеджер сессий`, value: 'sessions' },
        { label: '──────────────────────────────', value: null, disabled: true },
        { label: `💳  Карта: ${cardDisplay}`, value: 'card' },
        { label: `    ├─ Срок: ${expDisplay}  CVC: ${cvcDisplay}`, value: 'card', disabled: false },
        { label: `🌍  Прокси              [${proxyDisplay}]`, value: 'proxy' },
        { label: `🏳️   Локаль/Страна       [${localeDisplay}]`, value: 'locale' },
        { label: `👥  Аккаунтов           [${config.ACCOUNTS_COUNT === 0 ? '∞' : config.ACCOUNTS_COUNT}]`, value: 'accounts' },
        { label: `🌐  Браузер             [${config.HEADLESS ? 'Headless' : 'Видимый'}]`, value: 'browser' },
        { label: `🛠️   Ручной режим        [${config.MANUAL_MODE ? 'Вкл' : 'Выкл'}]`, value: 'manual' },
        { label: `🔔  Звук                [${config.SOUND_NOTIFICATIONS ? 'Вкл' : 'Выкл'}]`, value: 'sound' },
        { label: '──────────────────────────────', value: null, disabled: true },
        { label: '▶️   Сохранить и запустить', value: 'run' },
        { label: '✖️   Выход без сохранения', value: 'exit' },
    ]);

    switch (action) {
        case 'card':     await cardMenu();     break;
        case 'proxy':    await proxyMenu();    break;
        case 'locale':   await localeMenu();   break;
        case 'accounts': await accountsMenu(); break;
        case 'browser':  await browserMenu();  break;
        case 'manual':   await manualMenu();   break;
        case 'sound':    await soundMenu();    break;
        case 'sessions': await sessionsMenu(); break;
        case 'run':
            saveConfig();
            console.log('\n🚀 Запуск autoreger...\n');
            console.log('💡 Нажмите Ctrl+C для остановки и возврата в меню\n');
            {
                // Запоминаем сессии ДО запуска, чтобы потом найти новые
                const sessionsBefore = new Set(getSessions().map(s => s.name));
                // Снимаем наш SIGINT хендлер. Вместо него ставим noop — иначе Node по умолчанию
                // убьёт менеджер при Ctrl+C. С noop Ctrl+C получит только autoreger,
                // он завершится, а мы вернёмся в меню.
                process.removeListener('SIGINT', menuSigintHandler);
                const noopSigint = () => {};
                process.on('SIGINT', noopSigint);
                await new Promise(resolve => {
                    const child = spawn(process.execPath, ['autoreger.js'], { stdio: 'inherit' });
                    child.on('close', resolve);
                });
                process.removeListener('SIGINT', noopSigint);
                // Восстанавливаем хендлер после завершения autoreger
                process.on('SIGINT', menuSigintHandler);
                // Восстанавливаем состояние терминала после autoreger
                if (process.stdin.isTTY && process.stdin.setRawMode) {
                    try { process.stdin.setRawMode(false); } catch (_) {}
                }
                try { process.stdin.pause(); } catch (_) {}
                clearScreen();
                // Находим новые ✅ сессии и сразу грузим для них квоту (с планом pro/free) в кеш + на диск
                const newSessions = getSessions().filter(s => !sessionsBefore.has(s.name) && s.status === '✅');
                if (!global._quotaCache) global._quotaCache = loadQuotaCache();
                for (const s of newSessions) {
                    checkQuota(s).then(q => {
                        if (q) {
                            global._quotaCache[s.name] = { ...q, updatedAt: Date.now() };
                            saveQuotaCache(global._quotaCache);
                        }
                    }).catch(() => {});
                }
            }
            console.log('\n  Нажмите любую клавишу для возврата в меню...');
            await new Promise(resolve => {
                process.stdin.resume();
                if (process.stdin.isTTY && process.stdin.setRawMode) {
                    try { process.stdin.setRawMode(true); } catch (_) {}
                }
                process.stdin.once('keypress', () => {
                    if (process.stdin.isTTY && process.stdin.setRawMode) {
                        try { process.stdin.setRawMode(false); } catch (_) {}
                    }
                    process.stdin.pause();
                    resolve();
                });
            });
            break;
        case 'exit':
        case null:
            console.log('\n👋 Выход без сохранения\n');
            process.exit(0);
    }
    } // while(true)
}

// ─── Настройка карты (объединённое меню) ────────────────────────────────────
async function cardMenu() {
    // Показываем текущее состояние
    const bins = Array.isArray(config.BINS) ? config.BINS : (config.BINS ? [config.BINS] : []);
    const hasBins = bins.length > 0 && bins.some(b => b);
    
    let currentCard;
    if (!hasBins) {
        currentCard = '🔄 АВТО-РЕЖИМ: BIN из базы 48 шт, срок и CVC генерируются';
    } else {
        const b = bins[0];
        const expText = config.EXP_DATE === 'auto' ? 'авто' : config.EXP_DATE;
        const cvcText = config.CVC_CODE === 'auto' ? 'авто' : config.CVC_CODE;
        if (b.length === 16) {
            currentCard = `📝 РУЧНОЙ: ${b.slice(0,4)} **** **** ${b.slice(-4)} | ${expText} | CVC:${cvcText}`;
        } else {
            currentCard = `📝 BIN: ${b} | Срок: ${expText} | CVC: ${cvcText}`;
        }
    }
    
    const action = await rawList(`💳  Настройка карты\n\n  Сейчас: ${currentCard}\n`, [
        { label: '🔄  Авто-режим (BIN из базы, срок/CVC генерируются)', value: 'auto' },
        { label: '🔍  Выбрать BIN из базы (BIN-генератор)', value: 'lookup' },
        { label: '✏️   Ввести свой BIN (6-12 цифр)', value: 'bin' },
        { label: '💳  Ввести полный номер карты (16 цифр)', value: 'full' },
        { label: '──────────────────────────────', value: null, disabled: true },
        { label: `📅  Срок действия: ${config.EXP_DATE}`, value: 'exp' },
        { label: `🔒  CVC: ${config.CVC_CODE}`, value: 'cvc' },
        { label: `🔁  Макс. попыток BIN: ${config.BIN_MAX_RETRIES}`, value: 'retries' },
        { label: '──────────────────────────────', value: null, disabled: true },
        { label: '← Назад', value: null },
    ]);
    
    if (action === null) return;
    
    switch (action) {
        case 'auto':
            config.BINS = [];
            config.EXP_DATE = 'auto';
            config.CVC_CODE = 'auto';
            clearScreen();
            console.log('✅  Авто-режим включён');
            console.log('    BIN будет выбран из базы 48 рабочих BIN-ов');
            console.log('    Срок действия и CVC сгенерируются автоматически');
            await new Promise(r => setTimeout(r, 1500));
            break;
            
        case 'lookup':
            await binLookupMenu();
            break;
            
        case 'bin':
            await customBinMenu();
            break;
            
        case 'full':
            await fullCardMenu();
            break;
            
        case 'exp':
            await expDateMenu();
            break;
            
        case 'cvc':
            await cvcMenu();
            break;
            
        case 'retries':
            await retriesMenu();
            break;
    }
    // Возврат в главное меню (без рекурсии)
}

// Ввод полного номера карты (16 цифр)
async function fullCardMenu() {
    clearScreen();
    console.log('💳  Ввод полного номера карты\n');
    console.log('  Формат: 16 цифр без пробелов');
    console.log('  Пример: 4111111111111111\n');
    
    while (true) {
        const card = await rawInput('Номер карты (16 цифр)');
        if (card === '') return;
        if (!/^\d{16}$/.test(card)) {
            console.log('  ❌  Введите ровно 16 цифр\n');
            continue;
        }
        config.BINS = [card];
        console.log(`✅  Карта установлена: ${card.slice(0,4)} **** **** ${card.slice(-4)}`);
        
        // Спрашиваем срок и CVC
        const exp = await rawInput('Срок действия (ММ/ГГ) или Enter для авто', '');
        if (exp && /^\d{2}\/\d{2}$/.test(exp)) {
            config.EXP_DATE = exp;
        } else {
            config.EXP_DATE = 'auto';
        }
        
        const cvc = await rawInput('CVC (3-4 цифры) или Enter для авто', '');
        if (cvc && /^\d{3,4}$/.test(cvc)) {
            config.CVC_CODE = cvc;
        } else {
            config.CVC_CODE = 'auto';
        }
        
        console.log(`\n✅  Карта настроена:`);
        console.log(`    Номер: ${card.slice(0,4)} **** **** ${card.slice(-4)}`);
        console.log(`    Срок: ${config.EXP_DATE}`);
        console.log(`    CVC: ${config.CVC_CODE}`);
        await new Promise(r => setTimeout(r, 1500));
        return;
    }
}

// Старое меню binMenu оставляем для совместимости (не используется)
async function binMenu() {
    await cardMenu();
}

async function presetBinMenu() {
    const bin = await rawList('📋  Выберите BIN', [
        { label: 'Visa Classic         455605', value: '455605' },
        { label: 'Visa Gold            455655', value: '455655' },
        { label: 'Visa Platinum        455604', value: '455604' },
        { label: 'MasterCard Standard  515462', value: '515462' },
        { label: 'MasterCard Gold      542418', value: '542418' },
        { label: 'MasterCard Platinum  542432', value: '542432' },
        { label: 'Amex                 374245', value: '374245' },
        { label: 'Discover             601111', value: '601111' },
        { label: '← Назад', value: null },
    ]);
    if (!bin) return;
    config.BINS = [bin];
    clearScreen();
    console.log(`✅  BIN установлен: ${bin}`);
    await new Promise(r => setTimeout(r, 700));
}

async function customBinMenu() {
    clearScreen();
    while (true) {
        const bin = await rawInput('✏️  BIN (6-12 цифр) или полный номер карты (16 цифр)');
        if (bin === '') return; // пустой Enter без дефолта = назад
        if (!/^\d{6,16}$/.test(bin)) { console.log('  ❌  Введите от 6 до 16 цифр\n'); continue; }
        config.BINS = [bin];
        console.log(`✅  Установлен: ${bin}`);
        await new Promise(r => setTimeout(r, 700));
        return;
    }
}

async function expDateMenu() {
    clearScreen();
    let exp;
    do {
        exp = await rawInput('📅  Срок действия (ММ/ГГ или auto)', config.EXP_DATE);
        if (!exp) return;
        // Разрешаем 'auto' или формат ММ/ГГ
        if (exp !== 'auto' && !/^\d{2}\/\d{2}$/.test(exp)) { 
            console.log('  ❌  Формат: ММ/ГГ (например 04/27) или auto\n'); 
            exp = null; 
        }
    } while (!exp);
    config.EXP_DATE = exp;
    console.log(`✅  Срок установлен: ${exp}`);
    await new Promise(r => setTimeout(r, 700));
}

async function cvcMenu() {
    clearScreen();
    let cvc;
    do {
        cvc = await rawInput('🔒  CVC/CVV (3-4 цифры или auto)', String(config.CVC_CODE));
        if (!cvc) return;
        // Разрешаем 'auto' или 3-4 цифры
        if (cvc !== 'auto' && !/^\d{3,4}$/.test(cvc)) { 
            console.log('  ❌  Введите 3-4 цифры или auto\n'); 
            cvc = null; 
        }
    } while (!cvc);
    config.CVC_CODE = cvc;
    console.log(`✅  CVC установлен: ${cvc}`);
    await new Promise(r => setTimeout(r, 700));
}

async function retriesMenu() {
    clearScreen();
    let retries;
    do {
        retries = await rawInput('🔄  Макс. BIN-ов при declined (>=1)', String(config.BIN_MAX_RETRIES));
        if (!retries) return;
        if (!/^\d+$/.test(retries) || parseInt(retries) < 1) { console.log('  ❌  Введите число >= 1\n'); retries = null; }
    } while (!retries);
    config.BIN_MAX_RETRIES = parseInt(retries);
    console.log(`✅  Установлено: ${retries}`);
    await new Promise(r => setTimeout(r, 700));
}

// ─── Количество аккаунтов ───────────────────────────────────────────────────
async function accountsMenu() {
    clearScreen();
    while (true) {
        const count = await rawInput('👥  Сколько аккаунтов? (0 = бесконечно)', String(config.ACCOUNTS_COUNT));
        if (!/^\d+$/.test(count) || parseInt(count) < 0) {
            console.log('  ❌  Введите число >= 0\n');
            continue;
        }
        config.ACCOUNTS_COUNT = parseInt(count);
        console.log(`✅  Установлено: ${count}`);
        await new Promise(r => setTimeout(r, 700));
        return;
    }
}

// ─── Режим браузера ─────────────────────────────────────────────────────────
async function browserMenu() {
    const mode = await rawList('🌐  Режим браузера', [
        { label: `Headless — без GUI, быстрее${config.HEADLESS ? '  ✓' : ''}`, value: true },
        { label: `Видимый — можно наблюдать${!config.HEADLESS ? '  ✓' : ''}`, value: false },
        { label: '← Назад', value: null },
    ]);
    if (mode === null) return;
    config.HEADLESS = mode;
    clearScreen();
    console.log(`✅  Установлен: ${mode ? 'Headless' : 'Видимый'}`);
    await new Promise(r => setTimeout(r, 700));
}

// ─── Ручной режим ───────────────────────────────────────────────────────────
async function manualMenu() {
    const mode = await rawList('🛠️  Ручной режим', [
        { label: `Включить — ждать ввода карты при ошибке${config.MANUAL_MODE ? '  ✓' : ''}`, value: true },
        { label: `Выключить — завершить при ошибке${!config.MANUAL_MODE ? '  ✓' : ''}`, value: false },
        { label: '← Назад', value: null },
    ]);
    if (mode === null) return;
    config.MANUAL_MODE = mode;
    clearScreen();
    console.log(`✅  Ручной режим: ${mode ? 'включён' : 'выключен'}`);
    await new Promise(r => setTimeout(r, 700));
}

// ─── Звуковые уведомления ───────────────────────────────────────────────────
async function soundMenu() {
    const mode = await rawList('🔔  Звуковые уведомления', [
        { label: `Включить${config.SOUND_NOTIFICATIONS ? '  ✓' : ''}`, value: true },
        { label: `Выключить${!config.SOUND_NOTIFICATIONS ? '  ✓' : ''}`, value: false },
        { label: '← Назад', value: null },
    ]);
    if (mode === null) return;
    config.SOUND_NOTIFICATIONS = mode;
    clearScreen();
    console.log(`✅  Звуки: ${mode ? 'включены' : 'выключены'}`);
    await new Promise(r => setTimeout(r, 700));
}

// ─── Прокси ─────────────────────────────────────────────────────────────────
async function proxyMenu() {
    let currentProxy = 'Нет';
    if (config.PROXY) {
        currentProxy = config.PROXY;
    } else if (config.PROXY_LIST) {
        currentProxy = `Файл: ${config.PROXY_LIST}`;
    }
    
    const action = await rawList(`🌍  Настройка прокси\n\n  Сейчас: ${currentProxy}\n`, [
        { label: '❌  Без прокси', value: 'none' },
        { label: '✏️   Ввести прокси вручную', value: 'manual' },
        { label: '📄  Указать файл со списком прокси', value: 'file' },
        { label: `🔄  Ротация прокси: ${config.PROXY_ROTATION ? 'Вкл' : 'Выкл'}`, value: 'rotation' },
        { label: '← Назад', value: null },
    ]);
    
    if (action === null) return;
    
    switch (action) {
        case 'none':
            config.PROXY = null;
            config.PROXY_LIST = null;
            clearScreen();
            console.log('✅  Прокси отключен');
            await new Promise(r => setTimeout(r, 700));
            break;
            
        case 'manual':
            clearScreen();
            console.log('🌍  Ввод прокси\n');
            console.log('  Форматы:');
            console.log('    http://ip:port');
            console.log('    http://user:pass@ip:port');
            console.log('    socks5://ip:port\n');
            const proxy = await rawInput('Прокси');
            if (proxy) {
                config.PROXY = proxy;
                config.PROXY_LIST = null;
                console.log(`✅  Прокси установлен: ${proxy}`);
            }
            await new Promise(r => setTimeout(r, 700));
            break;
            
        case 'file':
            clearScreen();
            console.log('📄  Файл со списком прокси\n');
            console.log('  Формат файла: одна прокси на строку');
            console.log('  # — комментарий\n');
            const file = await rawInput('Путь к файлу', config.PROXY_LIST || '');
            if (file) {
                config.PROXY_LIST = file;
                config.PROXY = null;
                console.log(`✅  Файл прокси: ${file}`);
            }
            await new Promise(r => setTimeout(r, 700));
            break;
            
        case 'rotation':
            config.PROXY_ROTATION = !config.PROXY_ROTATION;
            clearScreen();
            console.log(`✅  Ротация прокси: ${config.PROXY_ROTATION ? 'включена' : 'выключена'}`);
            await new Promise(r => setTimeout(r, 700));
            break;
    }
    // Убрана рекурсия — возврат в главное меню
}

// ─── Локаль / Страна (25 стран) ─────────────────────────────────────────────
const COUNTRIES = [
    // Северная Америка
    { code: 'US', name: '🇺🇸 США', timezone: 'America/New_York', locale: 'en-US', address: '350 5th Ave', city: 'New York', zip: '10118' },
    { code: 'CA', name: '🇨🇦 Канада', timezone: 'America/Toronto', locale: 'en-CA', address: '100 Queen St', city: 'Ottawa', zip: 'K1A 0A1' },
    { code: 'MX', name: '🇲🇽 Мексика', timezone: 'America/Mexico_City', locale: 'es-MX', address: 'Av. Paseo de la Reforma 500', city: 'Ciudad de México', zip: '06600' },
    // Южная Америка
    { code: 'BR', name: '🇧🇷 Бразилия', timezone: 'America/Sao_Paulo', locale: 'pt-BR', address: 'Av. Paulista 1000', city: 'São Paulo', zip: '01310-100' },
    // Западная Европа
    { code: 'GB', name: '🇬🇧 Великобритания', timezone: 'Europe/London', locale: 'en-GB', address: '10 Downing St', city: 'London', zip: 'SW1A 2AA' },
    { code: 'IE', name: '🇮🇪 Ирландия', timezone: 'Europe/Dublin', locale: 'en-IE', address: "1 O'Connell St", city: 'Dublin', zip: 'D01 E9X0' },
    { code: 'DE', name: '🇩🇪 Германия', timezone: 'Europe/Berlin', locale: 'de-DE', address: 'Unter den Linden 1', city: 'Berlin', zip: '10117' },
    { code: 'AT', name: '🇦🇹 Австрия', timezone: 'Europe/Vienna', locale: 'de-AT', address: 'Stephansplatz 1', city: 'Wien', zip: '1010' },
    { code: 'CH', name: '🇨🇭 Швейцария', timezone: 'Europe/Zurich', locale: 'de-CH', address: 'Bahnhofstrasse 1', city: 'Zürich', zip: '8001' },
    { code: 'FR', name: '🇫🇷 Франция', timezone: 'Europe/Paris', locale: 'fr-FR', address: '5 Rue de la Paix', city: 'Paris', zip: '75002' },
    { code: 'BE', name: '🇧🇪 Бельгия', timezone: 'Europe/Brussels', locale: 'fr-BE', address: 'Grand Place 1', city: 'Bruxelles', zip: '1000' },
    { code: 'NL', name: '🇳🇱 Нидерланды', timezone: 'Europe/Amsterdam', locale: 'nl-NL', address: 'Dam 1', city: 'Amsterdam', zip: '1012 JS' },
    // Южная Европа
    { code: 'ES', name: '🇪🇸 Испания', timezone: 'Europe/Madrid', locale: 'es-ES', address: 'Calle Gran Vía 1', city: 'Madrid', zip: '28013' },
    { code: 'PT', name: '🇵🇹 Португалия', timezone: 'Europe/Lisbon', locale: 'pt-PT', address: 'Praça do Comércio 1', city: 'Lisboa', zip: '1100-148' },
    { code: 'IT', name: '🇮🇹 Италия', timezone: 'Europe/Rome', locale: 'it-IT', address: 'Via del Corso 1', city: 'Roma', zip: '00186' },
    // Северная Европа
    { code: 'SE', name: '🇸🇪 Швеция', timezone: 'Europe/Stockholm', locale: 'sv-SE', address: 'Drottninggatan 1', city: 'Stockholm', zip: '111 21' },
    { code: 'NO', name: '🇳🇴 Норвегия', timezone: 'Europe/Oslo', locale: 'nb-NO', address: 'Karl Johans gate 1', city: 'Oslo', zip: '0154' },
    { code: 'DK', name: '🇩🇰 Дания', timezone: 'Europe/Copenhagen', locale: 'da-DK', address: 'Strøget 1', city: 'København', zip: '1160' },
    { code: 'FI', name: '🇫🇮 Финляндия', timezone: 'Europe/Helsinki', locale: 'fi-FI', address: 'Kivihaantie 16', city: 'Vaasa', zip: '65300' },
    // Восточная Европа
    { code: 'PL', name: '🇵🇱 Польша', timezone: 'Europe/Warsaw', locale: 'pl-PL', address: 'ul. Marszałkowska 1', city: 'Warszawa', zip: '00-001' },
    { code: 'CZ', name: '🇨🇿 Чехия', timezone: 'Europe/Prague', locale: 'cs-CZ', address: 'Václavské náměstí 1', city: 'Praha', zip: '110 00' },
    // Азия
    { code: 'JP', name: '🇯🇵 Япония', timezone: 'Asia/Tokyo', locale: 'ja-JP', address: '1-1 Chiyoda', city: 'Tokyo', zip: '100-0001' },
    { code: 'KR', name: '🇰🇷 Южная Корея', timezone: 'Asia/Seoul', locale: 'ko-KR', address: 'Sejong-daero 110', city: 'Seoul', zip: '04524' },
    { code: 'IN', name: '🇮🇳 Индия', timezone: 'Asia/Kolkata', locale: 'hi-IN', address: 'Connaught Place 1', city: 'New Delhi', zip: '110001' },
    // Океания
    { code: 'AU', name: '🇦🇺 Австралия', timezone: 'Australia/Sydney', locale: 'en-AU', address: '1 Macquarie St', city: 'Sydney', zip: '2000' },
];

async function localeMenu() {
    const currentCountry = config.BILLING_PROFILES?.[0]?.country || 'US';
    const currentInfo = COUNTRIES.find(c => c.code === currentCountry) || COUNTRIES[0];
    
    // Просто выбор страны — всё остальное автоматически
    const country = await rawList(`🏳️  Страна для биллинга\n\n  Сейчас: ${currentInfo.name}\n  Timezone: ${currentInfo.timezone}\n  Адрес: ${currentInfo.city}\n`, [
        ...COUNTRIES.map(c => ({ 
            label: c.code === currentCountry ? `${c.name} ✓` : c.name, 
            value: c.code 
        })),
        { label: '← Назад', value: null },
    ]);
    
    if (country === null) return;
    
    const info = COUNTRIES.find(c => c.code === country);
    if (info) {
        config.BILLING_PROFILES = [{ country: info.code, address: info.address, city: info.city, zip: info.zip }];
        config.TIMEZONE = info.timezone;
        config.LOCALE = info.locale;
        clearScreen();
        console.log(`✅  Страна: ${info.name}`);
        console.log(`    Адрес: ${info.address}, ${info.city}, ${info.zip}`);
        console.log(`    Timezone: ${info.timezone}`);
        await new Promise(r => setTimeout(r, 1200));
    }
}

// ─── BIN-генератор ─────────────────────────────────────────────────────────────
async function binLookupMenu() {
    const { spawnSync } = require('child_process');
    
    const runBinLookup = (args = []) => {
        // Подготовка stdin для дочернего процесса
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            try { process.stdin.setRawMode(false); } catch (_) {}
        }
        setKeypressListener(null);
        process.stdin.pause();
        
        spawnSync(process.execPath, ['autoreger_data/internal/bin-lookup.js', ...args], { 
            stdio: 'inherit',
            cwd: __dirname
        });
        
        clearScreen();
    };
    
    while (true) {
        const mode = await rawList('🔍  BIN Lookup & Validator\n', [
            { label: '📋  Показать все Credit BIN-ы', value: '1' },
            { label: '🌍  Показать BIN-ы по стране', value: '2' },
            { label: '🔎  Проверить конкретный BIN', value: '3' },
            { label: '🎲  Сгенерировать случайные BIN-ы', value: '4' },
            { label: '⭐  Лучшие BIN-ы для подписок (credit, premium)', value: '5' },
            { label: '💳  Сгенерировать карты из BIN', value: '6' },
            { label: '🔄  Обновить кеш (sync)', value: '7' },
            { label: '← Назад', value: null },
        ]);
        
        if (mode === null) return;
        
        if (mode === '1') {
            runBinLookup(['--filter', 'credit']);
            console.log('\n  Нажмите любую клавишу для продолжения...');
            await waitForKey();
        } else if (mode === '2') {
            const country = await rawInput('Страна (US, GB, DE, FR, CA, AU, NL, SE, FI, ES, IT, JP)');
            if (country) {
                runBinLookup(['--country', country.trim().toUpperCase()]);
                console.log('\n  Нажмите любую клавишу для продолжения...');
                await waitForKey();
            }
        } else if (mode === '3') {
            const bin = await rawInput('BIN (6 цифр)');
            if (bin && /^\d{6,12}$/.test(bin.trim())) {
                runBinLookup([bin.trim()]);
                console.log('\n  Нажмите любую клавишу для продолжения...');
                await waitForKey();
            } else if (bin) {
                console.log('  ❌  Нужно 6-12 цифр');
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (mode === '4') {
            const count = await rawInput('Количество BIN-ов', '10');
            runBinLookup(['--generate', count || '10']);
            console.log('\n  Нажмите любую клавишу для продолжения...');
            await waitForKey();
        } else if (mode === '5') {
            runBinLookup(['--filter', 'credit', '--category', 'premium']);
            console.log('\n  Нажмите любую клавишу для продолжения...');
            await waitForKey();
        } else if (mode === '6') {
            const count = await rawInput('Количество карт', '5');
            const bin = await rawInput('BIN (оставьте пустым для авто)', '');
            const args = ['--gen-cards', count || '5'];
            if (bin && /^\d{6,12}$/.test(bin.trim())) {
                args.push('--bin', bin.trim());
            }
            runBinLookup(args);
            console.log('\n  Нажмите любую клавишу для продолжения...');
            await waitForKey();
        } else if (mode === '7') {
            runBinLookup(['--sync']);
            console.log('\n  Нажмите любую клавишу для продолжения...');
            await waitForKey();
        }
    }
}

// Ожидание нажатия любой клавиши
function waitForKey() {
    return new Promise(resolve => {
        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            try { process.stdin.setRawMode(true); } catch (_) {}
        }
        const onKey = () => {
            setKeypressListener(null);
            resolve();
        };
        setKeypressListener(onKey);
    });
}

// ─── Менеджер сессий (встроенный, Playwright живёт в этом процессе) ─────────

// Проверка квоты через Playwright (headless, тихо)
async function checkQuota(session) {
    try {
        const sessionFile = path.join(session.path, 'session.json');
        if (!fs.existsSync(sessionFile)) return null;

        // Строим URL usage из orgName
        const orgName = session.orgName;
        const usageUrl = `https://app.devin.ai/org/${orgName}/settings/usage`;

        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState: sessionFile });
        const page = await context.newPage();
        await page.goto(usageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // Ждём пока появится текст "Daily quota" или "Weekly quota" — до 10 сек
        await page.waitForFunction(
            () => document.body?.innerText?.includes('Daily quota') || document.body?.innerText?.includes('Weekly quota'),
            { timeout: 10000 }
        ).catch(() => {});

        const data = await page.evaluate(() => {
            const result = {};
            // Проверяем статус аккаунта (free/платный)
            const bodyText = document.body?.innerText || '';
            let plan = 'free';
            if (bodyText.includes('Pro') || bodyText.includes('pro') || bodyText.includes('Paid') || bodyText.includes('paid')) {
                plan = 'paid';
            }
            result.plan = plan;

            for (const el of document.querySelectorAll('*')) {
                const t = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                    ? el.textContent.trim() : '';
                if (t === 'Daily quota' || t === 'Weekly quota') {
                    const parts = el.parentElement?.parentElement?.innerText
                        ?.split('\n').map(s => s.trim()).filter(Boolean) || [];
                    // parts[1] = "0% used", parts[2] = "Resets in X hours"
                    result[t] = { used: parts[1] || '?', resets: parts[2] || '' };
                }
            }
            return result;
        });

        await browser.close();

        const daily  = data['Daily quota'];
        const weekly = data['Weekly quota'];
        if (!daily && !weekly) return null;

        return {
            daily:  daily  ? `${daily.used}`  : '?',
            weekly: weekly ? `${weekly.used}` : '?',
            resetsIn: daily?.resets || '',
            plan: data.plan || 'free',
        };
    } catch (e) {
        return null;
    }
}

function parseSessionDir(item, itemPath, source, defaultStatus) {
    const sessionFile = path.join(itemPath, 'session.json');
    if (!fs.existsSync(sessionFile)) return null;

    let s = { name: item, path: itemPath, source, orgName: 'Неизвестно', email: 'Неизвестно', date: 'Неизвестно', status: defaultStatus };

    const userMatch = item.match(/user-([a-z0-9]+)/);
    const orgMatch  = item.match(/org-([a-f0-9]+)/);

    // Форматы имён папок:
    // manual_sessions: 2026-05-16T12-09-41-success_user-XXX
    // errors/ready:    N YYYY-MM-DD HH-MM Label user-XXX
    const dtFull  = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const dtShort = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})[^-\d]/);
    const dtOld   = item.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/);
    const dtSpace = item.match(/(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})/);
    const dtOnly  = item.match(/(\d{4}-\d{2}-\d{2})/);

    if (userMatch) s.orgName = `user-${userMatch[1]}`;
    if (orgMatch)  s.orgName = `org-${orgMatch[1]}`;

    if (dtFull)        s.date = `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}`;
    else if (dtShort)  s.date = `${dtShort[1]} ${dtShort[2]}:${dtShort[3]}`;
    else if (dtOld)    s.date = `${dtOld[1]} ${dtOld[2]}:${dtOld[3]}`;
    else if (dtSpace)  s.date = `${dtSpace[1]} ${dtSpace[2]}:${dtSpace[3]}`;
    else if (dtOnly)   s.date = dtOnly[1];

    // Читаем session_info.txt если есть (только в manual_sessions)
    const infoFile = path.join(itemPath, 'session_info.txt');
    if (fs.existsSync(infoFile)) {
        try {
            for (const line of fs.readFileSync(infoFile, 'utf-8').split('\n')) {
                const afterColon = (l) => l.slice(l.indexOf(':') + 1).trim();
                if (line.startsWith('Email:'))  s.email   = afterColon(line) || s.email;
                if (line.startsWith('Org:'))    s.orgName = afterColon(line) || s.orgName;
                if (line.startsWith('Статус:')) s.status  = afterColon(line) || s.status;
            }
        } catch (e) {}
    }

    // Читаем email из Инструкция_входа.txt (папки errors/ready_to_sell)
    const instrFile = path.join(itemPath, 'Инструкция_входа.txt');
    if (fs.existsSync(instrFile)) {
        try {
            for (const line of fs.readFileSync(instrFile, 'utf-8').split('\n')) {
                if (line.trim().startsWith('Email:')) {
                    s.email = line.slice(line.indexOf(':') + 1).trim() || s.email;
                }
            }
        } catch (e) {}
    }

    // Финальный статус по имени папки (перекрывает всё)
    if (item.includes('success') || item.includes('Pro'))  s.status = '✅';
    else if (item.includes('error') || item.includes('Error')) s.status = '❌';

    return s;
}

function getSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); }
    const sessions = [];
    // Трекаем orgName чтобы не дублировать одни и те же аккаунты из разных папок
    // Приоритет: manual_sessions > ready_to_sell > errors
    // Если аккаунт уже есть как ✅ — ❌ дубль не добавляем
    const seenOrg = new Map(); // orgName -> index in sessions

    const addSession = (item, itemPath, source, defaultStatus) => {
        if (!fs.statSync(itemPath).isDirectory()) return;
        const s = parseSessionDir(item, itemPath, source, defaultStatus);
        if (!s) return;
        const existing = seenOrg.get(s.orgName);
        if (existing !== undefined) {
            // Уже есть — заменяем только если новый ✅, а старый ❌
            if (s.status === '✅' && sessions[existing].status === '❌') {
                sessions[existing] = s;
            }
            return;
        }
        seenOrg.set(s.orgName, sessions.length);
        sessions.push(s);
    };

    // 1. manual_sessions (основной источник)
    for (const item of fs.readdirSync(SESSIONS_DIR)) {
        addSession(item, path.join(SESSIONS_DIR, item), 'manual', '✅');
    }

    // 2. ready_to_sell/
    const readyDir = config.READY_DIR || 'ready_to_sell';
    if (fs.existsSync(readyDir)) {
        for (const item of fs.readdirSync(readyDir)) {
            addSession(item, path.join(readyDir, item), 'ready', '✅');
        }
    }

    // 3. errors/ — добавляем только тех, кого нет выше
    const errorsDir = 'errors';
    if (fs.existsSync(errorsDir)) {
        for (const item of fs.readdirSync(errorsDir)) {
            addSession(item, path.join(errorsDir, item), 'errors', '❌');
        }
    }

    return sessions.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
}

// ─── Менеджер сессий ────────────────────────────────────────────────────────
//
//  Управление:
//    ↑ ↓       — навигация (по списку или по панели действий)
//    → / ←     — переключить фокус: список ↔ панель действий
//    Enter     — выполнить действие (на списке: открыть браузер)
//    Esc       — назад из панели действий в список, либо выход из меню
//
let _sessionRenderedLines = 0;

// Действия для ✅ сессии (с подпиской)
// Используем BMP-символы (1-wide) — эмодзи рендерятся непредсказуемо в Windows Terminal
const ACTIONS_GOOD = [
    { id: 'open',      label: '➜ Открыть браузер' },
    { id: 'refresh',   label: '↻ Обновить квоту' },
    { id: 'mark-free', label: '▼ В ❌ (free)' },
    { id: 'delete',    label: '✗ Удалить' },
];

// Действия для ❌ сессии (без оплаты / ошибка)
const ACTIONS_BAD = [
    { id: 'open',     label: '➜ Открыть браузер' },
    { id: 'mark-sub', label: '▲ В ✅ (оплачено)' },
    { id: 'delete',   label: '✗ Удалить' },
];

// Глобальные действия (всегда внизу панели)
const ACTIONS_GLOBAL = [
    { id: 'refresh-all', label: '↻ Обновить все квоты' },
    { id: 'back',        label: '← Назад в меню' },
];

function getActionsForSession(session) {
    const own = session.status === '✅' ? ACTIONS_GOOD : ACTIONS_BAD;
    return [...own, { id: 'sep', label: null, separator: true }, ...ACTIONS_GLOBAL];
}

// Утилиты для табличного выравнивания
const stripAnsi = str => str.replace(/\x1b\[[0-9;]*m/g, '');
const visW = str => [...stripAnsi(str)].reduce((n, ch) => {
    const cp = ch.codePointAt(0);
    // emoji (U+1F000+) считаем за 2, остальное за 1
    return n + (cp >= 0x1F000 ? 2 : 1);
}, 0);
// Дополнить строку пробелами до нужной видимой ширины
const padTo = (str, w) => str + ' '.repeat(Math.max(0, w - visW(str)));

// Обрезать строку до видимой ширины maxW (с сохранением ANSI) и дополнить до maxW.
// Нужно чтобы строки НИКОГДА не превышали ширину колонки — иначе они уходят за разделитель.
function fitW(str, maxW) {
    if (maxW <= 0) return '';
    const cur = visW(str);
    if (cur === maxW) return str;
    if (cur < maxW) return str + ' '.repeat(maxW - cur);
    // Нужно обрезать: проходим по символам, считаем ширину, сохраняем ANSI-последовательности
    let result = '';
    let v = 0;
    let i = 0;
    let hasAnsi = false;
    while (i < str.length) {
        if (str[i] === '\x1b' && str[i + 1] === '[') {
            const end = str.indexOf('m', i);
            if (end !== -1) {
                result += str.slice(i, end + 1);
                i = end + 1;
                hasAnsi = true;
                continue;
            }
        }
        const cp = str.codePointAt(i);
        const charW = cp >= 0x1F000 ? 2 : 1;
        if (v + charW > maxW) break;
        const charLen = cp > 0xFFFF ? 2 : 1;
        result += str.slice(i, i + charLen);
        v += charW;
        i += charLen;
    }
    if (hasAnsi) result += '\x1b[0m';
    if (v < maxW) result += ' '.repeat(maxW - v);
    return result;
}

function renderSessions(sessions, row, quotaMap, quotaLoading, focus = 'list', actionIdx = 0, first = false) {
    // ВАЖНО: sessions ожидается уже отсортированным — сначала все ✅, потом все ❌.
    // row индексирует именно этот порядок (см. sortSessions в sessionsMenu).
    const good = sessions.filter(s => s.status === '✅');
    const bad  = sessions.filter(s => s.status === '❌');

    // ── Колонки таблицы ──────────────────────────────────────────────
    const COL_ORG   = 18;
    const COL_EMAIL = 28;
    const COL_DATE  = 16;

    const renderRow = (s, i, globalIdx) => {
        const isRow  = globalIdx === row;
        const showCursor = isRow && focus === 'list';
        const cursor = showCursor ? '\x1b[36m❯\x1b[0m' : (isRow ? '\x1b[2m›\x1b[0m' : ' ');
        const num    = String(i + 1).padStart(2);
        const icon   = s.status === '✅' ? '\x1b[32m✅\x1b[0m' : '\x1b[31m❌\x1b[0m';

        const orgRaw   = s.orgName !== 'Неизвестно' ? s.orgName : '—';
        const emailRaw = s.email   !== 'Неизвестно' ? s.email   : '—';
        const dateRaw  = s.date    !== 'Неизвестно' ? s.date    : '—';

        const orgWrapped = isRow ? `\x1b[1m\x1b[36m${orgRaw}\x1b[0m` : orgRaw;
        const orgCol     = padTo(orgWrapped, COL_ORG);
        const emailCol   = `\x1b[2m${padTo(emailRaw, COL_EMAIL)}\x1b[0m`;
        const dateCol    = `\x1b[2m${padTo(dateRaw,  COL_DATE)}\x1b[0m`;

        let extra = '';
        if (s.status === '✅') {
            const q = quotaMap[s.name];
            if (q) {
                // Сокращаем "0% used" → "0%" и убираем длинные суффиксы — компактно
                const shortD = (q.daily || '').replace(/\s*used$/, '');
                const shortW = (q.weekly || '').replace(/\s*used$/, '');
                const used = q.daily !== '0% used' || q.weekly !== '0% used';
                const qc = used ? '\x1b[33m' : '\x1b[32m';
                const planLabel = q.plan === 'paid' ? '\x1b[35m[Pro]\x1b[0m' : '\x1b[2m[Free]\x1b[0m';
                extra = `${planLabel} ${qc}D:${shortD} W:${shortW}\x1b[0m`;
            } else if (isRow && quotaLoading) {
                extra = `\x1b[2mзагрузка…\x1b[0m`;
            }
        }

        return `  ${cursor} \x1b[2m${num}.\x1b[0m ${icon}  ${orgCol}${emailCol}${dateCol}  ${extra}`;
    };

    // ── items: линейный список строк таблицы ────────────────────────
    const items = [];
    if (good.length > 0) {
        items.push({ text: '' });
        items.push({ text: `  \x1b[32m✅ С подпиской (${good.length})\x1b[0m` });
        items.push({ text: `  \x1b[2m  ${'#'.padStart(2)}  ${'Организация'.padEnd(COL_ORG)}  ${'Email'.padEnd(COL_EMAIL)}  ${'Дата'.padEnd(COL_DATE)}  План  Квота\x1b[0m` });
        items.push({ text: `  \x1b[2m  ${'─'.repeat(COL_ORG + COL_EMAIL + COL_DATE + 36)}\x1b[0m` });
        good.forEach((s, i) => items.push({ text: renderRow(s, i, i), isSession: true, globalIdx: i }));
    }
    if (bad.length > 0) {
        items.push({ text: '' });
        items.push({ text: `  \x1b[31m❌ Без оплаты / ошибка (${bad.length})\x1b[0m` });
        items.push({ text: `  \x1b[2m  ${'#'.padStart(2)}  ${'Организация'.padEnd(COL_ORG)}  ${'Email'.padEnd(COL_EMAIL)}  ${'Дата'.padEnd(COL_DATE)}\x1b[0m` });
        items.push({ text: `  \x1b[2m  ${'─'.repeat(COL_ORG + COL_EMAIL + COL_DATE + 14)}\x1b[0m` });
        bad.forEach((s, i) => items.push({ text: renderRow(s, i, good.length + i), isSession: true, globalIdx: good.length + i }));
    }

    // ── Viewport: фиксированная высота на основе размера терминала ──────
    const termRows = Math.max(15, process.stdout.rows || 30);
    const HEADER_LINES = 3;   // header + empty + hint
    const FOOTER_LINES = 2;   // empty + separator
    const RESERVE      = 2;
    const viewport = Math.max(10, termRows - HEADER_LINES - FOOTER_LINES - RESERVE);

    const activeItemIdx = items.findIndex(it => it.isSession && it.globalIdx === row);

    let scrollOffset = 0;
    if (items.length > viewport) {
        scrollOffset = Math.max(0, activeItemIdx - Math.floor(viewport / 2));
        scrollOffset = Math.min(scrollOffset, items.length - viewport);
    }
    const visible = items.slice(scrollOffset, scrollOffset + viewport);
    while (visible.length < viewport) visible.push({ text: '' });
    if (scrollOffset > 0) {
        visible[0] = { text: `  \x1b[2m▲ ещё ${scrollOffset} выше\x1b[0m` };
    }
    const hiddenBelow = items.length - (scrollOffset + viewport);
    if (hiddenBelow > 0) {
        visible[viewport - 1] = { text: `  \x1b[2m▼ ещё ${hiddenBelow} ниже\x1b[0m` };
    }

    // ── Правая панель: действия ─────────────────────────────────────
    const currentSession = sessions[row];
    const sessionActions = currentSession ? getActionsForSession(currentSession) : [];

    const rightLines = [];
    // выравниваем верх правой панели с верхом таблицы
    rightLines.push('');
    rightLines.push(focus === 'actions'
        ? `\x1b[1m\x1b[36m▌ Действия\x1b[0m`
        : `\x1b[2m▌ Действия\x1b[0m`);
    if (currentSession) {
        const status = currentSession.status === '✅' ? '\x1b[32m✅\x1b[0m' : '\x1b[31m❌\x1b[0m';
        rightLines.push(`  ${status} \x1b[2m${currentSession.orgName}\x1b[0m`);
    }
    rightLines.push('');

    sessionActions.forEach((action, i) => {
        if (action.separator) {
            rightLines.push(`  \x1b[2m──────────────\x1b[0m`);
            return;
        }
        const isSelected = focus === 'actions' && actionIdx === i;
        const cur = isSelected ? '\x1b[36m❯\x1b[0m' : ' ';
        const text = isSelected
            ? `\x1b[1m\x1b[36m${action.label}\x1b[0m`
            : (focus === 'actions' ? action.label : `\x1b[2m${action.label}\x1b[0m`);
        rightLines.push(`  ${cur} ${text}`);
    });

    // ── Сборка финального вывода ────────────────────────────────────
    const termCols = process.stdout.columns || 120;
    const RIGHT_PANEL_WIDTH = 28;
    // Левая колонка — оставшаяся ширина минус разделитель " │ " (3) минус правая колонка
    const LEFT_WIDTH = Math.max(50, termCols - RIGHT_PANEL_WIDTH - 4);
    const sepActive = focus === 'actions' ? '\x1b[36m' : '\x1b[2m';
    const sep = `${sepActive}│\x1b[0m`;

    const leftLines = [];
    leftLines.push(`  ⚡ Менеджер сессий`
        + `  \x1b[32m${good.length} с подпиской\x1b[0m`
        + `  \x1b[2m/\x1b[0m`
        + `  \x1b[31m${bad.length} без оплаты\x1b[0m`);
    leftLines.push('');
    const hint = focus === 'list'
        ? '\x1b[2m↑↓ сессия   → действия   Enter открыть   Esc назад\x1b[0m'
        : '\x1b[2m↑↓ действие  ← к списку   Enter выполнить   Esc к списку\x1b[0m';
    leftLines.push(`  ${hint}`);
    visible.forEach(it => leftLines.push(it.text));
    leftLines.push('');
    leftLines.push('  \x1b[2m─────────────────────────────────────────────────────────\x1b[0m');

    // Сливаем построчно. fitW гарантирует, что каждая левая строка ровно LEFT_WIDTH символов
    // (обрежет длинные строки таблицы → разделитель всегда стоит на одной и той же колонке,
    // ничего не переносится).
    // Разделитель │ рисуется только до последней значащей строки одной из колонок.
    const total = Math.max(leftLines.length, rightLines.length);
    // Индекс последней непустой строки в обеих колонках
    let lastMeaningful = -1;
    for (let i = total - 1; i >= 0; i--) {
        const l = leftLines[i] && leftLines[i].trim() ? leftLines[i] : '';
        const r = rightLines[i] && rightLines[i].trim() ? rightLines[i] : '';
        if (l || r) { lastMeaningful = i; break; }
    }

    const merged = [];
    for (let i = 0; i < total; i++) {
        const left = leftLines[i] !== undefined ? leftLines[i] : '';
        const right = rightLines[i] !== undefined ? rightLines[i] : '';
        const rightFit = fitW(right, RIGHT_PANEL_WIDTH);
        // После последней значащей строки разделитель не рисуем — нет смысла
        if (i > lastMeaningful) {
            merged.push(fitW(left, LEFT_WIDTH));
        } else {
            merged.push(fitW(left, LEFT_WIDTH) + ` ${sep} ` + rightFit);
        }
    }

    clearScreen();
    process.stdout.write(merged.join('\n'));
    _sessionRenderedLines = merged.length;
}

async function confirmDeleteRaw(session) {
    // Без подтверждения для теста
    try { fs.rmSync(session.path, { recursive: true, force: true }); } catch (e) {}
    return true;
}

// Перевести ❌ сессию в ✅ — переместить папку в manual_sessions/ с success-именем (без подтверждения для теста)
async function markAsSubscribedRaw(session) {
    if (session.status === '✅') return false;

    // Сформировать имя в стиле manual_sessions: YYYY-MM-DDThh-mm-ss-success_<orgName>
    let stamp;
    const m = (session.date || '').match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);
    if (m) stamp = `${m[1]}T${m[2]}-${m[3]}-00`;
    else   stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

    let target = path.join(SESSIONS_DIR, `${stamp}-success_${session.orgName}`);
    // Если такая папка уже существует — добавляем суффикс
    let n = 1;
    while (fs.existsSync(target)) {
        target = path.join(SESSIONS_DIR, `${stamp}-success_${session.orgName}_${n++}`);
    }

    try {
        if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.renameSync(session.path, target);
        return true;
    } catch (e) {
        // Если переименование не работает (разные диски и т.п.) — копируем + удаляем
        try {
            fs.cpSync(session.path, target, { recursive: true });
            fs.rmSync(session.path, { recursive: true, force: true });
            return true;
        } catch (err) {
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch (_) {}
            }
            clearScreen();
            console.log(`\n❌ Не удалось перенести сессию в manual_sessions/`);
            console.log(`Источник: ${session.path}`);
            console.log(`Цель:     ${target}`);
            console.log(`Ошибка rename: ${e.message}`);
            console.log(`Ошибка copy:   ${err.message}\n`);
            console.log('Нажмите любую клавишу...');
            await new Promise(r => process.stdin.once('data', r));
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(true); } catch (_) {}
            }
            return false;
        }
    }
}

// Перевести free-аккаунт в ❌ — переместить папку в errors/ (без подтверждения для теста)
async function markAsFreeRaw(session) {
    if (session.status !== '✅') return false;

    const errorsDir = 'errors';
    if (!fs.existsSync(errorsDir)) fs.mkdirSync(errorsDir, { recursive: true });

    // Сформировать имя для папки errors
    let stamp;
    const m = (session.date || '').match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);
    if (m) stamp = `${m[1]}_${m[2]}-${m[3]}`;
    else   stamp = new Date().toISOString().slice(0, 16).replace(/:/g, '-').replace('T', '_');

    let target = path.join(errorsDir, `1 ${stamp} Error ${session.orgName}`);
    // Если такая папка уже существует — добавляем суффикс
    let n = 1;
    while (fs.existsSync(target)) {
        target = path.join(errorsDir, `${n + 1} ${stamp} Error ${session.orgName}`);
        n++;
    }

    try {
        fs.renameSync(session.path, target);
        return true;
    } catch (e) {
        // Если переименование не работает — копируем + удаляем
        try {
            fs.cpSync(session.path, target, { recursive: true });
            fs.rmSync(session.path, { recursive: true, force: true });
            return true;
        } catch (err) {
            // Снимаем raw mode, чтобы пользователь увидел сообщение
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch (_) {}
            }
            clearScreen();
            console.log(`\n❌ Не удалось перенести сессию в errors/`);
            console.log(`Источник: ${session.path}`);
            console.log(`Цель:     ${target}`);
            console.log(`Ошибка rename: ${e.message}`);
            console.log(`Ошибка copy:   ${err.message}\n`);
            console.log('Возможные причины: папка открыта в проводнике, заблокирована браузером, нет прав.');
            console.log('\nНажмите любую клавишу...');
            await new Promise(r => process.stdin.once('data', r));
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(true); } catch (_) {}
            }
            return false;
        }
    }
}

async function sessionsMenu() {
    // Сортируем: ✅ → потом ❌. row индексирует именно этот порядок.
    const sortSessions = arr => [...arr].sort((a, b) => {
        if (a.status === b.status) return 0;
        return a.status === '✅' ? -1 : 1;
    });

    let sessions = sortSessions(getSessions());
    if (sessions.length === 0) {
        console.log('\n📭 Нет сохранённых сессий\n');
        await new Promise(r => setTimeout(r, 1500));
        return;
    }

    let row = 0;
    let focus = 'list';      // 'list' | 'actions'
    let actionIdx = 0;
    // Загружаем кэш с диска (либо из памяти если уже загружен)
    if (!global._quotaCache) global._quotaCache = loadQuotaCache();
    const quotaMap = global._quotaCache;
    // Чистим кэш от удалённых сессий
    const validNames = new Set(sessions.map(s => s.name));
    let cacheChanged = false;
    Object.keys(quotaMap).forEach(k => {
        if (!validNames.has(k)) { delete quotaMap[k]; cacheChanged = true; }
    });
    if (cacheChanged) saveQuotaCache(quotaMap);

    let quotaLoading = false;
    // Набор имён сессий, для которых сейчас идёт загрузка квоты
    const loadingSet = new Set();

    const rerender = () => renderSessions(sessions, row, quotaMap, quotaLoading, focus, actionIdx);

    // Сохранить квоту в map + в файл
    const setQuota = (name, q) => {
        quotaMap[name] = { ...q, updatedAt: Date.now() };
        saveQuotaCache(quotaMap);
    };

    // Загрузка всех квот — полностью в фоне, меню не блокируется
    const loadAllQuotas = () => {
        quotaLoading = true; rerender();
        const list = sessions.filter(s => s.status === '✅');
        let done = 0;
        if (list.length === 0) { quotaLoading = false; rerender(); return; }
        for (const s of list) {
            loadingSet.add(s.name);
            checkQuota(s).then(q => {
                if (q) setQuota(s.name, q);
                loadingSet.delete(s.name);
                done++;
                if (done === list.length) { quotaLoading = false; rerender(); }
                else if (done % 3 === 0) rerender(); // Перерисовываем каждые 3 завершенные
            }).catch(() => {
                loadingSet.delete(s.name);
                done++;
                if (done === list.length) { quotaLoading = false; rerender(); }
                else if (done % 3 === 0) rerender();
            });
        }
    };

    // Загрузка одной квоты — тоже в фоне
    const loadOneQuota = (session) => {
        loadingSet.add(session.name);
        quotaLoading = true; rerender();
        checkQuota(session).then(q => {
            if (q) setQuota(session.name, q);
            loadingSet.delete(session.name);
            if (loadingSet.size === 0) quotaLoading = false;
            rerender();
        }).catch(() => {
            loadingSet.delete(session.name);
            if (loadingSet.size === 0) quotaLoading = false;
            rerender();
        });
    };

    process.stdin.resume();
    if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(true); } catch (_) {}
    }
    rerender();

    return new Promise(resolve => {
        // Открыть браузер с выбранной сессией
        const openBrowser = async (s) => {
            setKeypressListener(null);
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch (_) {}
            }
            try {
                const browser = await chromium.launch({ headless: false });
                const context = await browser.newContext({ storageState: path.join(s.path, 'session.json') });
                const page = await context.newPage();
                await page.goto(`https://app.devin.ai/org/${s.orgName}/settings/usage`, { waitUntil: 'domcontentloaded' });
                if (s.status === '✅') loadOneQuota(s, true).catch(() => {});
            } catch (e) { /* не закрываем браузер */ }
            process.stdin.resume();
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(true); } catch (_) {}
            }
            rerender();
            setKeypressListener(onKey);
        };

        // Выполнить действие по id (из правой панели)
        const executeAction = async (id) => {
            const s = sessions[row];
            if (!s && id !== 'refresh-all' && id !== 'back') return;
            switch (id) {
                case 'open':
                    await openBrowser(s);
                    break;
                case 'refresh':
                    if (s.status === '✅') loadOneQuota(s);
                    break;
                case 'mark-free': {
                    if (s.status !== '✅') return;
                    const targetOrg = s.orgName;
                    const moved = await markAsFreeRaw(s);
                    if (moved) {
                        sessions = sortSessions(getSessions());
                        if (sessions.length === 0) { resolve(); return; }
                        const newIdx = sessions.findIndex(x => x.orgName === targetOrg && x.status === '❌');
                        row = newIdx >= 0 ? newIdx : Math.min(row, sessions.length - 1);
                        focus = 'list';
                        actionIdx = 0;
                    }
                    rerender();
                    break;
                }
                case 'mark-sub': {
                    if (s.status !== '❌') return;
                    const targetOrg = s.orgName;
                    const moved = await markAsSubscribedRaw(s);
                    if (moved) {
                        sessions = sortSessions(getSessions());
                        if (sessions.length === 0) { resolve(); return; }
                        const newIdx = sessions.findIndex(x => x.orgName === targetOrg && x.status === '✅');
                        row = newIdx >= 0 ? newIdx : Math.min(row, sessions.length - 1);
                        focus = 'list';
                        actionIdx = 0;
                    }
                    rerender();
                    break;
                }
                case 'delete': {
                    const deleted = await confirmDeleteRaw(s);
                    if (deleted) {
                        sessions = sortSessions(getSessions());
                        if (sessions.length === 0) { resolve(); return; }
                        row = Math.min(row, sessions.length - 1);
                        focus = 'list';
                        actionIdx = 0;
                    }
                    rerender();
                    break;
                }
                case 'refresh-all':
                    Object.keys(quotaMap).forEach(k => delete quotaMap[k]);
                    loadAllQuotas();
                    break;
                case 'back':
                    setKeypressListener(null);
                    if (process.stdin.isTTY && process.stdin.setRawMode) {
                        try { process.stdin.setRawMode(false); } catch (_) {}
                    }
                    process.stdin.pause();
                    resolve();
                    break;
            }
        };

        const onKey = async (str, key) => {
            if (!key) return;

            // ── Навигация ───────────────────────────────────────────
            if (key.name === 'up') {
                if (focus === 'list') {
                    row = (row - 1 + sessions.length) % sessions.length;
                    actionIdx = 0; // сбрасываем позицию в actions при смене строки
                } else {
                    const actions = getActionsForSession(sessions[row]);
                    do { actionIdx = (actionIdx - 1 + actions.length) % actions.length; }
                    while (actions[actionIdx] && actions[actionIdx].separator);
                }
                rerender();
            } else if (key.name === 'down') {
                if (focus === 'list') {
                    row = (row + 1) % sessions.length;
                    actionIdx = 0;
                } else {
                    const actions = getActionsForSession(sessions[row]);
                    do { actionIdx = (actionIdx + 1) % actions.length; }
                    while (actions[actionIdx] && actions[actionIdx].separator);
                }
                rerender();
            } else if (key.name === 'right') {
                if (focus === 'list') {
                    focus = 'actions';
                    actionIdx = 0;
                    rerender();
                }
            } else if (key.name === 'left') {
                if (focus === 'actions') {
                    focus = 'list';
                    rerender();
                }
            } else if (key.name === 'return') {
                if (focus === 'list') {
                    // Enter на списке → открыть браузер (быстрое действие)
                    await openBrowser(sessions[row]);
                } else {
                    const actions = getActionsForSession(sessions[row]);
                    const action = actions[actionIdx];
                    if (action && !action.separator) await executeAction(action.id);
                }
            } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                if (focus === 'actions') {
                    focus = 'list';
                    rerender();
                } else {
                    setKeypressListener(null);
                    if (process.stdin.isTTY && process.stdin.setRawMode) {
                        try { process.stdin.setRawMode(false); } catch (_) {}
                    }
                    process.stdin.pause();
                    resolve();
                }
            }
        };
        setKeypressListener(onKey);
    });
}

// ─── Запуск ─────────────────────────────────────────────────────────────────
mainMenu().catch(err => {
    if (err && err.isTtyError) {
        console.error('Ошибка: терминал не поддерживает интерактивный ввод');
    } else if (err && err.message && err.message.includes('force closed')) {
        process.exit(0);
    } else if (err) {
        console.error(err);
    }
    process.exit(0);
});
