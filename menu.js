const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { freemodelSessionsMenu } = require('./internal/freemodel-manager');
const { createFreemodelSession } = require('./internal/freemodel-creator');
const { notionSessionsMenu } = require('./internal/notion-manager');

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

// ─── Загрузка routing/.env в process.env ─────────────────────────────────────
function loadEnvFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const text = fs.readFileSync(filePath, 'utf-8');
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.substring(0, eq).trim();
            const val = trimmed.substring(eq + 1).trim().replace(/^["']|["']$/g, '');
            if (key && process.env[key] === undefined) process.env[key] = val;
        }
    } catch {}
}
loadEnvFile(path.join(__dirname, 'routing', '.env'));

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
    replaceField('AUTO_ADD_TOKENROUTER_TO_OMNIROUTE', config.AUTO_ADD_TOKENROUTER_TO_OMNIROUTE);
    
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
        { label: `🗂️   Менеджер сессий Devin`, value: 'sessions' },
        { label: `➕  Добавить аккаунт Devin`, value: 'devin-add' },
        { label: `🆓  FreeModel сессии`, value: 'freemodel-sessions' },
        { label: `➕  Создать аккаунт FreeModel (вручную, 1 шт)`, value: 'freemodel-create' },
        { label: `🤖  FreeModel autoreg v3 (10minutemail, пирамида)`, value: 'freemodel-autoreg-v3' },
        { label: `🗂️   Notion сессии     [${notionSessionsCount()}]`, value: 'notion-sessions' },
        { label: `📝  Notion         [${notionStatusLine()}]`, value: 'notion-create' },
        { label: `🔑  TokenRouter autoreg [OmniRoute: ${config.AUTO_ADD_TOKENROUTER_TO_OMNIROUTE ? 'вкл' : 'выкл'}]`, value: 'tokenrouter-autoreg' },
        { label: '──────────────────────────────', value: null, disabled: true },
        { label: '✖️   Выход', value: 'exit' },
    ]);

    switch (action) {
        case 'sessions': await sessionsMenu(); break;
        case 'devin-add': await devinAddMenu(); break;
        case 'freemodel-sessions': await freemodelSessionsMenu({ clearScreen, setKeypressListener, rawList }); break;
        case 'freemodel-create': await createFreemodelSession({ clearScreen, setKeypressListener, rawList, rawInput }); break;
        case 'freemodel-autoreg-v3': await freemodelAutoregV3({ clearScreen, setKeypressListener, rawInput }); break;
        case 'notion-sessions': await notionSessionsMenu({ clearScreen, setKeypressListener, rawList, rawInput }); break;
        case 'notion-create': await notionCreateMenu(); break;
        case 'tokenrouter-autoreg': await tokenrouterAutoregMenu(); break;
        case 'exit':
            clearScreen();
            process.exit(0);
            break;
    }
    } // while(true)
}

// ─── Devin: Добавить аккаунт (подменю) ─────────────────────────────────────
async function devinAddMenu() {
    clearScreen();

    // Отображение текущих настроек
    const bins = Array.isArray(config.BINS) ? config.BINS : (config.BINS ? [config.BINS] : []);
    const hasBins = bins.length > 0 && bins.some(b => b);

    let cardDisplay;
    if (!hasBins) {
        cardDisplay = 'Авто (из базы)';
    } else {
        const b = bins[0];
        if (b.length === 16) {
            cardDisplay = `${b.slice(0,4)}…${b.slice(-4)}`;
        } else {
            cardDisplay = `BIN ${b}`;
        }
    }

    const expDisplay = config.EXP_DATE === 'auto' ? 'авто' : config.EXP_DATE;
    const cvcDisplay = config.CVC_CODE === 'auto' ? 'авто' : config.CVC_CODE;
    const proxyDisplay = config.PROXY ? 'Вкл' : 'Выкл';
    const billingCountry = config.BILLING_PROFILES?.[0]?.country || 'US';
    const localeDisplay = config.BILLING_ROTATION ? `Авто (${billingCountry})` : `${config.TIMEZONE}`;

    const action = await rawList('➕  Добавить аккаунт Devin', [
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
        { label: '← Назад', value: 'back' },
    ]);

    switch (action) {
        case 'card':     await cardMenu(); await devinAddMenu(); break;
        case 'proxy':    await proxyMenu(); await devinAddMenu(); break;
        case 'locale':   await localeMenu(); await devinAddMenu(); break;
        case 'accounts': await accountsMenu(); await devinAddMenu(); break;
        case 'browser':  await browserMenu(); await devinAddMenu(); break;
        case 'manual':   await manualMenu(); await devinAddMenu(); break;
        case 'sound':    await soundMenu(); await devinAddMenu(); break;
        case 'run':
            saveConfig();
            console.log('\n🚀 Запуск autoreger...\n');
            console.log('💡 Нажмите Ctrl+C для остановки и возврата в меню\n');
            {
                const sessionsBefore = new Set(getSessions().map(s => s.name));
                process.removeListener('SIGINT', menuSigintHandler);
                const noopSigint = () => {};
                process.on('SIGINT', noopSigint);

                await new Promise(resolve => {
                    const child = spawn(process.execPath, ['autoreger.js'], { stdio: 'inherit' });
                    child.on('close', resolve);
                });

                process.removeListener('SIGINT', noopSigint);
                process.on('SIGINT', menuSigintHandler);

                if (process.stdin.isTTY && process.stdin.setRawMode) {
                    try { process.stdin.setRawMode(false); } catch (_) {}
                }
                try { process.stdin.pause(); } catch (_) {}
                clearScreen();

                const sessionsAfter = getSessions();
                const newSessions = sessionsAfter.filter(s => !sessionsBefore.has(s.name));

                if (newSessions.length > 0) {
                    console.log(`\n✅  Создано новых сессий: ${newSessions.length}\n`);
                    newSessions.forEach(s => {
                        console.log(`  ${s.status}  ${s.orgName}  ${s.email}`);
                    });
                } else {
                    console.log('\n⚠️  Новых сессий не обнаружено\n');
                }

                console.log('\n  Нажмите любую клавишу для возврата...');
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
            }
            await devinAddMenu();
            break;
        case 'back':
            return;
    }
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
    let browser = null;
    try {
        const sessionFile = path.join(session.path, 'session.json');
        if (!fs.existsSync(sessionFile)) return null;

        // Строим URL usage из orgName
        const orgName = session.orgName;
        const usageUrl = `https://app.devin.ai/org/${orgName}/settings/usage`;

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState: sessionFile });
        const page = await context.newPage();
        await page.goto(usageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // Ждём пока появится "Current plan" И ("Daily quota" или "Weekly quota") — до 12 сек
        await page.waitForFunction(
            () => {
                const text = document.body?.innerText || '';
                const hasQuota = text.includes('Daily quota') || text.includes('Weekly quota');
                const hasPlan = text.includes('Current plan');
                return hasQuota && hasPlan;
            },
            { timeout: 12000 }
        ).catch(() => {});
        // Небольшая пауза для рендера React-компонентов
        await page.waitForTimeout(300);

        const data = await page.evaluate(() => {
            const result = {};
            const bodyText = document.body?.innerText || '';
            
            // Определяем план по структуре страницы:
            // "Current plan\nPro\nTrial..." или "Current plan\nFree\n..."
            let plan = 'free';
            
            // Ищем паттерн "Current plan" и следующую строку
            const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
            for (let i = 0; i < lines.length - 1; i++) {
                if (lines[i] === 'Current plan' || lines[i].includes('Current plan')) {
                    const nextLine = lines[i + 1].toLowerCase();
                    if (nextLine === 'pro' || nextLine.startsWith('pro') || 
                        nextLine === 'teams' || nextLine.startsWith('teams')) {
                        plan = 'paid';
                        break;
                    } else if (nextLine === 'free' || nextLine.startsWith('free')) {
                        plan = 'free';
                        break;
                    }
                }
            }
            
            // Дополнительно: если есть "Trial" — это Pro Trial
            if (plan === 'free' && bodyText.includes('Trial')) {
                plan = 'paid';
            }
            
            // Если есть "Manage billing" — скорее всего платный
            if (plan === 'free' && bodyText.includes('Manage billing')) {
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
        browser = null;

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
    } finally {
        // Гарантируем закрытие браузера даже при ошибке
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
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
        // Пропускаем FreeModel-сессии — у них свой менеджер
        try {
            const infoPath = path.join(itemPath, 'session_info.txt');
            if (fs.existsSync(infoPath)) {
                const info = fs.readFileSync(infoPath, 'utf-8');
                if (/^URL:.*freemodel\.dev/im.test(info)) return;
            }
        } catch {}
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

function renderSessions(sessions, row, quotaMap, quotaLoading, focus = 'list', actionIdx = 0, loadingSet = new Set()) {
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
            const isLoading = loadingSet.has(s.name);
            if (isLoading) {
                // Показываем загрузку для конкретной сессии
                extra = `\x1b[2m⏳ загрузка…\x1b[0m`;
            } else if (q) {
                // Сокращаем "0% used" → "0%" и убираем длинные суффиксы — компактно
                const shortD = (q.daily || '').replace(/\s*used$/, '');
                const shortW = (q.weekly || '').replace(/\s*used$/, '');
                const used = q.daily !== '0% used' || q.weekly !== '0% used';
                const qc = used ? '\x1b[33m' : '\x1b[32m';
                const planLabel = q.plan === 'paid' ? '\x1b[35m[Pro]\x1b[0m' : '\x1b[2m[Free]\x1b[0m';
                extra = `${planLabel} ${qc}D:${shortD} W:${shortW}\x1b[0m`;
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

    // Debounced rerender — не чаще чем раз в 100мс (для фоновых обновлений)
    let rerenderTimeout = null;
    let lastRenderTime = 0;
    const rerenderNow = () => renderSessions(sessions, row, quotaMap, quotaLoading, focus, actionIdx, loadingSet);
    const rerender = (immediate = false) => {
        const now = Date.now();
        if (immediate || now - lastRenderTime > 100) {
            // Немедленный рендер (для навигации)
            if (rerenderTimeout) { clearTimeout(rerenderTimeout); rerenderTimeout = null; }
            lastRenderTime = now;
            rerenderNow();
        } else {
            // Отложенный рендер (для фоновых обновлений квот)
            if (!rerenderTimeout) {
                rerenderTimeout = setTimeout(() => {
                    rerenderTimeout = null;
                    lastRenderTime = Date.now();
                    rerenderNow();
                }, 100);
            }
        }
    };

    // Сохранить квоту в map + в файл
    const setQuota = (name, q) => {
        quotaMap[name] = { ...q, updatedAt: Date.now() };
        saveQuotaCache(quotaMap);
    };

    // Загрузка всех квот — полностью в фоне, меню не блокируется
    // Ограничиваем параллельные запросы (макс 2 браузера одновременно)
    const loadAllQuotas = () => {
        loadingSet.clear(); // Очищаем на случай предыдущих незавершённых
        quotaLoading = true; rerender();
        const list = sessions.filter(s => s.status === '✅');
        let done = 0;
        let idx = 0;
        const MAX_CONCURRENT = 2;
        if (list.length === 0) { quotaLoading = false; rerender(); return; }

        const processNext = () => {
            while (loadingSet.size < MAX_CONCURRENT && idx < list.length) {
                const s = list[idx++];
                loadingSet.add(s.name);
                checkQuota(s).then(q => {
                    if (q) setQuota(s.name, q);
                    loadingSet.delete(s.name);
                    done++;
                    rerender();
                    if (done === list.length) { quotaLoading = false; rerender(); }
                    else processNext();
                }).catch(() => {
                    loadingSet.delete(s.name);
                    done++;
                    rerender();
                    if (done === list.length) { quotaLoading = false; rerender(); }
                    else processNext();
                });
            }
        };
        processNext();
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
                    rerender(true);
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
                    rerender(true);
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
                    rerender(true);
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

            // ── Навигация (immediate rerender для отзывчивости) ───────
            if (key.name === 'up') {
                if (focus === 'list') {
                    row = (row - 1 + sessions.length) % sessions.length;
                    actionIdx = 0; // сбрасываем позицию в actions при смене строки
                } else {
                    const actions = getActionsForSession(sessions[row]);
                    do { actionIdx = (actionIdx - 1 + actions.length) % actions.length; }
                    while (actions[actionIdx] && actions[actionIdx].separator);
                }
                rerender(true);
            } else if (key.name === 'down') {
                if (focus === 'list') {
                    row = (row + 1) % sessions.length;
                    actionIdx = 0;
                } else {
                    const actions = getActionsForSession(sessions[row]);
                    do { actionIdx = (actionIdx + 1) % actions.length; }
                    while (actions[actionIdx] && actions[actionIdx].separator);
                }
                rerender(true);
            } else if (key.name === 'right') {
                if (focus === 'list') {
                    focus = 'actions';
                    actionIdx = 0;
                    rerender(true);
                }
            } else if (key.name === 'left') {
                if (focus === 'actions') {
                    focus = 'list';
                    rerender(true);
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
                    rerender(true);
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

// Краткое описание текущей карты Notion для главного меню
function notionStatusLine() {
    try {
        const nc = loadNotionConfig();
        const presets = nc.CARD_PRESETS || [];
        if (!presets.length) return 'нет карт';
        const idx = Number.isInteger(nc.CARD_PRESET_INDEX) ? nc.CARD_PRESET_INDEX : 0;
        const p = presets[Math.min(idx, presets.length - 1)];
        const label = p.label || `${p.number.slice(0, 4)}…${p.number.slice(-4)}`;
        return `${label} × ${nc.ACCOUNTS_COUNT}`;
    } catch {
        return 'config error';
    }
}

// Количество сохранённых Notion-сессий — для счётчика в главном меню
function notionSessionsCount() {
    try {
        const dir = path.join(__dirname, 'notion', 'sessions');
        if (!fs.existsSync(dir)) return '0';
        const items = fs.readdirSync(dir).filter(item => {
            const p = path.join(dir, item);
            try {
                return fs.statSync(p).isDirectory()
                    && fs.existsSync(path.join(p, 'session.json'));
            } catch { return false; }
        });
        return String(items.length);
    } catch {
        return '?';
    }
}

// ─── Notion: подменю ────────────────────────────────────────────────────────
//
// Хранит свой собственный notionConfig в памяти, синкает с notion/config.js
// тем же приёмом регекс-замены, что и основной saveConfig().

const NOTION_CONFIG_PATH = path.join(__dirname, 'notion', 'config.js');

function loadNotionConfig() {
    // require() кэшится — сбрасываем чтобы прочитать актуальное состояние с диска
    delete require.cache[require.resolve(NOTION_CONFIG_PATH)];
    return require(NOTION_CONFIG_PATH);
}

function saveNotionField(fieldName, newValue) {
    let content = fs.readFileSync(NOTION_CONFIG_PATH, 'utf-8');
    const before = content;

    // число
    content = content.replace(
        new RegExp(`(\\n[ \\t]+${fieldName}:\\s*)\\d+(,?)`),
        (_m, prefix, comma) => `${prefix}${newValue}${comma}`
    );
    if (content !== before) { fs.writeFileSync(NOTION_CONFIG_PATH, content); return true; }

    // строка в кавычках
    content = content.replace(
        new RegExp(`(\\n[ \\t]+${fieldName}:\\s*)'[^']*'(,?)`),
        (_m, prefix, comma) => `${prefix}${newValue}${comma}`
    );
    if (content !== before) { fs.writeFileSync(NOTION_CONFIG_PATH, content); return true; }

    return false;
}

// Сохранить массив CARD_PRESETS в notion/config.js
function saveNotionCardPresets(presets) {
    let content = fs.readFileSync(NOTION_CONFIG_PATH, 'utf-8');
    const formatted = JSON.stringify(presets, null, 4)
        .replace(/^/gm, '    ')  // отступ 4 пробела
        .trim();

    // Заменяем CARD_PRESETS: [...],  (многострочный массив)
    const re = /(\n\s+CARD_PRESETS:\s*)\[[\s\S]*?\n\s+\](,?)/;
    if (re.test(content)) {
        content = content.replace(re, (_m, prefix, comma) => `${prefix}${formatted}${comma}`);
        fs.writeFileSync(NOTION_CONFIG_PATH, content);
        return true;
    }
    return false;
}

async function freemodelAutoregV3({ clearScreen, rawInput }) {
    clearScreen();

    const LAST_INVITE_FILE = path.join(__dirname, 'freemodel', '.last_invite');
    let lastInvite = null;
    try {
        if (fs.existsSync(LAST_INVITE_FILE)) {
            const v = fs.readFileSync(LAST_INVITE_FILE, 'utf-8').trim();
            if (/^FRE-[A-Za-z0-9]+$/.test(v)) lastInvite = v;
        }
    } catch {}

    delete require.cache[require.resolve('./freemodel/config.js')];
    const fmConfig = require('./freemodel/config.js');
    const initial = fmConfig.INITIAL_INVITE;
    const startInvite = lastInvite || initial;

    console.log('🤖  FreeModel AutoReg v3 (10minutemail + OTP)\n');
    console.log(`   Старт инвайт:  ${startInvite}`);
    if (lastInvite && lastInvite !== initial) {
        console.log('                  ↑ из freemodel/.last_invite (предыдущий запуск)');
    } else {
        console.log('                  ↑ из freemodel/config.js  (INITIAL_INVITE)');
    }
    console.log(`   Прокси:        ${fmConfig.PROXY || '(нет)'}`);
    console.log('');

    const countStr = await rawInput('Сколько аккаунтов создать? (Enter = 1) > ');
    const count = Math.max(1, parseInt(countStr, 10) || 1);

    console.log(`\n▶️   Запускаю: node freemodel/freemodel_autoreger_v3.js ${count}`);
    console.log('     Ctrl+C — стоп после текущего акка.\n');

    process.removeListener('SIGINT', menuSigintHandler);
    const noopSigint = () => {};
    process.on('SIGINT', noopSigint);

    await new Promise(resolve => {
        const child = spawn(process.execPath, ['freemodel/freemodel_autoreger_v3.js', String(count)], { stdio: 'inherit' });
        child.on('close', resolve);
    });

    process.removeListener('SIGINT', noopSigint);
    process.on('SIGINT', menuSigintHandler);

    if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch {}
    }
    try { process.stdin.pause(); } catch {}

    let finalInvite = lastInvite;
    try {
        if (fs.existsSync(LAST_INVITE_FILE)) {
            finalInvite = fs.readFileSync(LAST_INVITE_FILE, 'utf-8').trim();
        }
    } catch {}
    if (finalInvite && finalInvite !== startInvite) {
        console.log(`\n💾  Новый последний реф: ${finalInvite}`);
        console.log('    Сохранён в freemodel/.last_invite — следующий запуск стартует с него.');
    }

    console.log('\nНажмите любую клавишу для возврата...');
    await new Promise(resolve => {
        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            try { process.stdin.setRawMode(true); } catch {}
        }
        process.stdin.once('keypress', () => {
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch {}
            }
            process.stdin.pause();
            resolve();
        });
    });
}

// ─── TokenRouter autoreg ──────────────────────────────────────────────────────
async function tokenrouterAutoregMenu() {
    clearScreen();

    const accountsFile = path.join(__dirname, 'routing', 'tokenrouter', 'accounts.json');
    let existingCount = 0;
    try {
        if (fs.existsSync(accountsFile)) {
            const data = JSON.parse(fs.readFileSync(accountsFile, 'utf-8'));
            if (Array.isArray(data)) existingCount = data.length;
        }
    } catch {}

    const action = await rawList('🔑  TokenRouter autoreg', [
        { label: `Авто-добавление в OmniRoute: ${config.AUTO_ADD_TOKENROUTER_TO_OMNIROUTE ? 'ВКЛ' : 'ВЫКЛ'}`, value: 'toggle' },
        { label: `Аккаунтов в базе: ${existingCount}`, value: null, disabled: true },
        { label: '──────────────────────────────', value: null, disabled: true },
        { label: '▶️  Запустить регистрацию', value: 'run' },
        { label: '⬆️  Импортировать существующие аккаунты в OmniRoute', value: 'import' },
        { label: '← Назад', value: 'back' },
    ]);

    switch (action) {
        case 'toggle':
            config.AUTO_ADD_TOKENROUTER_TO_OMNIROUTE = !config.AUTO_ADD_TOKENROUTER_TO_OMNIROUTE;
            saveConfig();
            return tokenrouterAutoregMenu();
        case 'run':
            return tokenrouterRunMenu();
        case 'import':
            return tokenrouterImportMenu();
        case 'back':
        default:
            return;
    }
}

async function tokenrouterImportMenu() {
    clearScreen();
    console.log('⬆️  Импорт TokenRouter в OmniRoute...\n');
    console.log('   Запуск: node routing/tokenrouter/omniroute-api-client.js\n');

    process.removeListener('SIGINT', menuSigintHandler);
    const noopSigint = () => {};
    process.on('SIGINT', noopSigint);

    await new Promise(resolve => {
        const child = spawn(
            process.execPath,
            [path.join(__dirname, 'routing', 'tokenrouter', 'omniroute-api-client.js')],
            { stdio: 'inherit', env: { ...process.env } }
        );
        child.on('close', resolve);
    });

    process.removeListener('SIGINT', noopSigint);
    process.on('SIGINT', menuSigintHandler);

    if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch {}
    }
    try { process.stdin.pause(); } catch {}
    clearScreen();

    console.log('\n  Импорт завершён');
    console.log('\n  Нажмите любую клавишу для возврата...');
    await new Promise(resolve => {
        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            try { process.stdin.setRawMode(true); } catch {}
        }
        process.stdin.once('keypress', () => {
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch {}
            }
            process.stdin.pause();
            resolve();
        });
    });
}

async function tokenrouterRunMenu() {
    clearScreen();
    const countStr = await rawInput('Сколько аккаунтов создать? (Enter = 1)', '1');
    const count = Math.max(1, parseInt(countStr, 10) || 1);

    clearScreen();
    console.log('🔑  Запуск TokenRouter autoreg...\n');
    console.log(`   Авто-добавление в OmniRoute: ${config.AUTO_ADD_TOKENROUTER_TO_OMNIROUTE ? 'ВКЛ' : 'ВЫКЛ'}`);
    console.log(`   Аккаунтов: ${count}`);
    console.log('\n   Ctrl+C — остановка\n');

    process.removeListener('SIGINT', menuSigintHandler);
    const noopSigint = () => {};
    process.on('SIGINT', noopSigint);

    await new Promise(resolve => {
        const child = spawn(
            'python',
            [path.join(__dirname, 'routing', 'tokenrouter', 'camoufox_autoreg.py'), String(count)],
            {
                stdio: 'inherit',
                env: {
                    ...process.env,
                    AUTO_ADD_TOKENROUTER_TO_OMNIROUTE: config.AUTO_ADD_TOKENROUTER_TO_OMNIROUTE ? '1' : '0',
                },
            }
        );
        child.on('close', resolve);
    });

    process.removeListener('SIGINT', noopSigint);
    process.on('SIGINT', menuSigintHandler);

    if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch {}
    }
    try { process.stdin.pause(); } catch {}
    clearScreen();

    console.log('\n  TokenRouter autoreg завершён');
    console.log('\n  Нажмите любую клавишу для возврата...');
    await new Promise(resolve => {
        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            try { process.stdin.setRawMode(true); } catch {}
        }
        process.stdin.once('keypress', () => {
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch {}
            }
            process.stdin.pause();
            resolve();
        });
    });
}

async function notionCreateMenu() {
    while (true) {
        const notionConfig = loadNotionConfig();
        const presets = notionConfig.CARD_PRESETS || [];
        const idx = Number.isInteger(notionConfig.CARD_PRESET_INDEX) ? notionConfig.CARD_PRESET_INDEX : 0;
        const current = presets[Math.min(idx, presets.length - 1)];
        const cardLabel = current
            ? (current.label || `${current.number.slice(0, 4)}…${current.number.slice(-4)}`)
            : '⚠️ нет пресетов';
        const billing = current && current.billing;
        const billLabel = billing
            ? `${billing.city || '?'}, ${billing.country || '?'}`
            : '—';

        const action = await rawList('📝  NOTION AUTOREG', [
            { label: `💳  Карта:       ${cardLabel}`, value: 'card' },
            { label: `🏳️   Биллинг:     ${billLabel}`, value: null, disabled: true },
            { label: `👥  Аккаунтов:   ${notionConfig.ACCOUNTS_COUNT}`, value: 'count' },
            { label: '──────────────────────────────', value: null, disabled: true },
            { label: '▶️   Запустить регистрацию', value: 'run' },
            { label: '← Назад', value: null },
        ]);

        if (action === null) return;

        if (action === 'card') {
            await notionCardMenu(presets, idx);
        } else if (action === 'count') {
            await notionCountMenu(notionConfig.ACCOUNTS_COUNT);
        } else if (action === 'run') {
            if (!current) {
                clearScreen();
                console.log('❌  Нет ни одного пресета карты — нечем оплачивать.');
                console.log('    Добавьте карту в notion/config.js → CARD_PRESETS.');
                await new Promise(r => setTimeout(r, 2500));
                continue;
            }
            await notionRun();
        }
    }
}

// Выбор / добавление / удаление пресета карты
async function notionCardMenu(presets, currentIdx) {
    const items = presets.map((p, i) => {
        const tick = i === currentIdx ? '  ✓' : '';
        const label = p.label || `${p.number.slice(0, 4)}…${p.number.slice(-4)}`;
        const city = p.billing && p.billing.city ? ` — ${p.billing.city}, ${p.billing.country}` : '';
        return { label: `${label}${city}${tick}`, value: { action: 'select', idx: i } };
    });

    items.push({ label: '──────────────────────────────', value: null, disabled: true });
    items.push({ label: '➕  Добавить новую карту', value: { action: 'add' } });

    if (presets.length > 0) {
        items.push({ label: '🗑️   Удалить карту', value: { action: 'delete' } });
    }

    items.push({ label: '← Назад', value: null });

    const choice = await rawList('💳  Карты Notion', items);
    if (choice === null) return;

    if (choice.action === 'select') {
        const ok = saveNotionField('CARD_PRESET_INDEX', String(choice.idx));
        clearScreen();
        if (ok) {
            const p = presets[choice.idx];
            console.log(`✅  Карта выбрана: ${p.label || p.number}`);
            if (p.bin_info) console.log(`    ${p.bin_info}`);
            if (p.billing) {
                console.log(`    Биллинг: ${p.billing.name}, ${p.billing.address}`);
                console.log(`             ${p.billing.city}, ${p.billing.state || ''} ${p.billing.zip}, ${p.billing.country}`);
            }
        } else {
            console.log('⚠️  Не удалось записать CARD_PRESET_INDEX');
        }
        await new Promise(r => setTimeout(r, 2000));
    } else if (choice.action === 'add') {
        await notionAddCardMenu(presets);
    } else if (choice.action === 'delete') {
        await notionDeleteCardMenu(presets);
    }
}

// Определить страну по BIN через публичный API
async function lookupBin(bin) {
    try {
        const res = await fetch(`https://lookup.binlist.net/${bin}`, {
            headers: { 'Accept-Version': '3' }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return {
            country: (data.country && data.country.alpha2) || null,
            countryName: (data.country && data.country.name) || null,
            brand: data.brand || data.scheme || null,
            type: data.type || null,
        };
    } catch (e) {
        return null;
    }
}

// Добавление новой карты
async function notionAddCardMenu(presets) {
    clearScreen();
    console.log('➕  Добавление новой карты\n');

    const number = (await rawInput('💳  Номер карты (16 цифр)')).trim();
    if (!/^\d{13,19}$/.test(number)) {
        console.log('  ❌  Неверный номер. Отмена.\n');
        await new Promise(r => setTimeout(r, 1500));
        return;
    }

    const exp = (await rawInput('📅  Срок (MM/YY, например 12/30)')).trim();
    if (!/^\d{2}\/\d{2}$/.test(exp)) {
        console.log('  ❌  Неверный формат срока. Отмена.\n');
        await new Promise(r => setTimeout(r, 1500));
        return;
    }

    const cvc = (await rawInput('🔒  CVC (3-4 цифры)')).trim();
    if (!/^\d{3,4}$/.test(cvc)) {
        console.log('  ❌  Неверный CVC. Отмена.\n');
        await new Promise(r => setTimeout(r, 1500));
        return;
    }

    // Определяем страну по BIN автоматически
    console.log('\n🔍  Определяю страну по BIN...');
    const binInfo = await lookupBin(number.slice(0, 6));

    let country, brand;
    if (binInfo && binInfo.country) {
        country = binInfo.country;
        brand = binInfo.brand;
        console.log(`✅  Определено: ${binInfo.countryName} (${country}) · ${brand || '?'} ${binInfo.type || ''}`);

        // Подтверждение или ручной ввод
        const confirm = (await rawInput(`\n   Использовать страну ${country}? (Enter = да, или введи свой ISO код)`, country)).trim().toUpperCase();
        country = confirm || country;
    } else {
        console.log('⚠️  Не удалось определить — введите вручную');
        country = ((await rawInput('🌍  Страна (ISO код, US/CN/GB/DE...)', 'US')).trim() || 'US').toUpperCase();
    }

    console.log('\n📍  Биллинг адрес:\n');

    // Дефолты по стране
    const defaults = {
        US: { name: 'John Doe', address: '123 Main Street', city: 'New York', state: 'NY', zip: '10001', phone: '+12015551234' },
        GB: { name: 'James Smith', address: '10 Downing Street', city: 'London', state: '', zip: 'SW1A 2AA', phone: '+442079460000' },
        DE: { name: 'Hans Müller', address: 'Hauptstraße 1', city: 'Berlin', state: '', zip: '10115', phone: '+4930123456' },
        CN: { name: 'Li Wei', address: 'No. 123 Nanjing Road', city: 'Shanghai', state: 'Shanghai', zip: '200001', phone: '+8613800138000' },
        FR: { name: 'Pierre Dubois', address: '1 Rue de Rivoli', city: 'Paris', state: '', zip: '75001', phone: '+33142601234' },
        CA: { name: 'John MacDonald', address: '123 Bay Street', city: 'Toronto', state: 'ON', zip: 'M5J 2N8', phone: '+14165551234' },
        JP: { name: 'Yuki Tanaka', address: '1-1 Chiyoda', city: 'Tokyo', state: '', zip: '100-0001', phone: '+81312345678' },
    };
    const def = defaults[country] || defaults.US;

    const name = (await rawInput('👤  Имя на карте', def.name)).trim() || def.name;
    const address = (await rawInput('🏠  Адрес', def.address)).trim() || def.address;
    const city = (await rawInput('🏙️   Город', def.city)).trim() || def.city;
    const state = (await rawInput('🗺️   Штат/Регион (опционально)', def.state || '')).trim();
    const zip = (await rawInput('📮  ZIP / Индекс', def.zip)).trim() || def.zip;
    const phone = (await rawInput('📞  Телефон (опционально)', def.phone || '')).trim();

    const flagMap = { US: '🇺🇸', GB: '🇬🇧', DE: '🇩🇪', FR: '🇫🇷', CN: '🇨🇳', JP: '🇯🇵', CA: '🇨🇦', AU: '🇦🇺', RU: '🇷🇺', UA: '🇺🇦', NL: '🇳🇱', ES: '🇪🇸', IT: '🇮🇹', SE: '🇸🇪', FI: '🇫🇮' };
    const flag = flagMap[country] || '💳';

    const newPreset = {
        label: `${flag} ${brand || 'Card'} · ${number.slice(0, 4)}…${number.slice(-4)}`,
        number,
        exp,
        cvc,
        bin_info: `${country} ${brand || 'card'} (BIN ${number.slice(0, 6)})`,
        billing: {
            name,
            address,
            city,
            ...(state ? { state } : {}),
            zip,
            country,
            ...(phone ? { phone } : {}),
        },
    };

    const updated = [...presets, newPreset];
    const ok = saveNotionCardPresets(updated);

    clearScreen();
    if (ok) {
        console.log(`✅  Карта добавлена: ${newPreset.label}`);
        console.log(`    Всего пресетов: ${updated.length}`);
    } else {
        console.log('⚠️  Не удалось сохранить пресет');
    }
    await new Promise(r => setTimeout(r, 2000));
}

// Удаление карты
async function notionDeleteCardMenu(presets) {
    if (presets.length === 0) {
        clearScreen();
        console.log('📭 Нет карт для удаления');
        await new Promise(r => setTimeout(r, 1500));
        return;
    }

    const items = presets.map((p, i) => {
        const label = p.label || `${p.number.slice(0, 4)}…${p.number.slice(-4)}`;
        const city = p.billing && p.billing.city ? ` — ${p.billing.city}, ${p.billing.country}` : '';
        return { label: `${label}${city}`, value: i };
    });
    items.push({ label: '──────────────────────────────', value: null, disabled: true });
    items.push({ label: '← Отмена', value: null });

    const choice = await rawList('🗑️   Какую карту удалить?', items);
    if (choice === null) return;

    const removed = presets[choice];
    const updated = presets.filter((_, i) => i !== choice);
    const ok = saveNotionCardPresets(updated);

    clearScreen();
    if (ok) {
        console.log(`✅  Удалена: ${removed.label || removed.number}`);
        // Сбрасываем индекс на 0 если удалили текущий
        saveNotionField('CARD_PRESET_INDEX', '0');
    } else {
        console.log('⚠️  Не удалось удалить пресет');
    }
    await new Promise(r => setTimeout(r, 2000));
}

async function notionCountMenu(currentCount) {
    clearScreen();
    while (true) {
        const ans = await rawInput('👥  Сколько аккаунтов Notion создать? (1-50)', String(currentCount));
        if (!/^\d+$/.test(ans) || parseInt(ans) < 1 || parseInt(ans) > 50) {
            console.log('  ❌  Введите число от 1 до 50\n');
            continue;
        }
        const ok = saveNotionField('ACCOUNTS_COUNT', String(parseInt(ans)));
        if (ok) console.log(`✅  ACCOUNTS_COUNT = ${ans}`);
        else    console.log('⚠️  Не удалось записать');
        await new Promise(r => setTimeout(r, 700));
        return;
    }
}

// Запуск notion_workflow.js как дочерний процесс
async function notionRun() {
    clearScreen();
    console.log('🚀 Запуск Notion Workflow...\n');
    console.log('💡 Ctrl+C — остановка и возврат в меню\n');

    process.removeListener('SIGINT', menuSigintHandler);
    const noopSigint = () => {};
    process.on('SIGINT', noopSigint);

    await new Promise(resolve => {
        const child = spawn(
            process.execPath,
            [path.join(__dirname, 'notion', 'notion_workflow.js')],
            {
                stdio: 'inherit',
                cwd: path.join(__dirname, 'notion'),
            }
        );
        child.on('close', resolve);
    });

    process.removeListener('SIGINT', noopSigint);
    process.on('SIGINT', menuSigintHandler);

    if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch (_) {}
    }
    try { process.stdin.pause(); } catch (_) {}
    clearScreen();

    console.log('\n  ✅ Notion Workflow завершён');
    console.log('\n  Нажмите любую клавишу для возврата...');

    // Переинициализируем readline после дочернего процесса
    const readline = require('readline');
    readline.emitKeypressEvents(process.stdin);

    await new Promise(resolve => {
        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            try { process.stdin.setRawMode(true); } catch (_) {}
        }
        const onKey = () => {
            process.stdin.removeListener('keypress', onKey);
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch (_) {}
            }
            process.stdin.pause();
            resolve();
        };
        process.stdin.on('keypress', onKey);
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
