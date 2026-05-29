// internal/notion-manager.js
//
// Менеджер сессий Notion. Сканирует notion/sessions/<account>/.
// Каждая папка содержит: session.json, session_info.txt, и возможно скриншоты.
// Без проверки квот — у Notion нет аналога /usage.
//
// Действия: Открыть в браузере, Удалить.
//
// Экспортирует: notionSessionsMenu(helpers)
//   helpers = { clearScreen, setKeypressListener, rawList }

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { spawn } = require('child_process');

const SESSIONS_DIR = path.join(__dirname, '..', 'notion', 'sessions');

// ─── Извлечение token_v2 ────────────────────────────────────────
function extractTokenV2(session) {
    // Сначала проверяем кэш
    const cacheFile = path.join(session.path, 'token_v2.txt');
    if (fs.existsSync(cacheFile)) {
        try {
            const cached = fs.readFileSync(cacheFile, 'utf-8').trim();
            if (cached) return cached;
        } catch {}
    }

    // Если в кэше нет - извлекаем из session.json
    try {
        const sessionFile = path.join(session.path, 'session.json');
        if (!fs.existsSync(sessionFile)) return null;

        const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
        const cookies = data.cookies || [];

        const tokenCookie = cookies.find(c => c.name === 'token_v2');
        if (!tokenCookie) return null;

        const token = tokenCookie.value;

        // Сохраняем в кэш
        try {
            fs.writeFileSync(cacheFile, token);
        } catch {}

        return token;
    } catch (e) {
        return null;
    }
}

// Копирование в буфер обмена (Windows)
function copyToClipboard(text) {
    return new Promise((resolve, reject) => {
        const proc = spawn('clip.exe', [], { stdio: ['pipe', 'ignore', 'ignore'] });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`clip exited with code ${code}`));
        });
        proc.stdin.write(text);
        proc.stdin.end();
    });
}

// ─── Сессии ──────────────────────────────────────────────────────
function readInfo(itemPath) {
    const info = { url: '', email: '', status: '', planType: '', completedAt: '', bannedAt: '', createdAt: '' };
    const f = path.join(itemPath, 'session_info.txt');
    if (!fs.existsSync(f)) return info;
    try {
        for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
            const c = line.indexOf(':');
            if (c < 0) continue;
            const k = line.slice(0, c).trim().toLowerCase();
            const v = line.slice(c + 1).trim();
            if (k === 'url') info.url = v;
            else if (k === 'email') info.email = v;
            else if (k === 'status') info.status = v;
            else if (k === 'plantype') info.planType = v;
            else if (k === 'completedat') info.completedAt = v;
            else if (k === 'bannedat')    info.bannedAt = v;
            else if (k === 'created')     info.createdAt = v;
        }
    } catch {}
    return info;
}

function getNotionSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const list = [];
    for (const item of fs.readdirSync(SESSIONS_DIR)) {
        const p = path.join(SESSIONS_DIR, item);
        try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
        const sessionFile = path.join(p, 'session.json');
        if (!fs.existsSync(sessionFile)) continue;
        const info = readInfo(p);
        list.push({
            name:     item,
            path:     p,
            email:    info.email || item,
            status:   info.status || 'unknown',
            planType: info.planType || 'unknown',
            date:     (info.completedAt || info.bannedAt || info.createdAt || '').slice(0, 16).replace('T', ' '),
        });
    }
    return list.sort((a, b) => b.date.localeCompare(a.date));
}

// ─── Иконки статусов ─────────────────────────────────────────────
function statusIcon(status) {
    if (status === 'banned') return '\x1b[31m🚫\x1b[0m';
    if (status === 'trial-card-added') return '\x1b[32m💳\x1b[0m';
    if (status === 'trial') return '\x1b[33m🆓\x1b[0m';
    if (status === 'paid') return '\x1b[32m💰\x1b[0m';
    if (status === 'free') return '\x1b[2m📦\x1b[0m';
    if (status === 'in-progress') return '\x1b[2m⏳\x1b[0m';
    return '\x1b[32m✅\x1b[0m';
}

function statusLabel(status, planType) {
    if (status === 'trial-card-added') return `Trial+Card (${planType})`;
    if (status === 'trial') return `Trial (${planType})`;
    if (status === 'paid') return `Paid (${planType})`;
    if (status === 'free') return 'Free';
    if (status === 'in-progress') return 'In Progress';
    return status;
}

// ─── Действия ────────────────────────────────────────────────────
async function openInBrowser(session) {
    const sessionFile = path.join(session.path, 'session.json');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: sessionFile });
    const page = await context.newPage();
    await page.goto('https://www.notion.so/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    // Браузер живёт пока пользователь не закроет вручную
}

function deleteSession(session) {
    try {
        fs.rmSync(session.path, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.log(`❌ Не удалось удалить: ${e.message}`);
        return false;
    }
}

// ─── Привязка карты ─────────────────────────────────────────────────────────
async function attachCard(session) {
    const sessionFile = path.join(session.path, 'session.json');

    // Загружаем конфиг Notion для данных карты
    const notionConfigPath = path.join(__dirname, '..', 'notion', 'config.js');
    delete require.cache[require.resolve(notionConfigPath)];
    const notionConfig = require(notionConfigPath);

    const presets = notionConfig.CARD_PRESETS || [];
    const idx = Number.isInteger(notionConfig.CARD_PRESET_INDEX) ? notionConfig.CARD_PRESET_INDEX : 0;
    const preset = presets[Math.min(idx, presets.length - 1)];

    if (!preset) {
        throw new Error('Нет пресетов карт в notion/config.js');
    }

    const billing = preset.billing || {};

    console.log(`  💳 Карта: ${preset.label || preset.number.slice(0, 4) + '…' + preset.number.slice(-4)}`);
    console.log(`  🚀 Открываю браузер...\n`);

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: sessionFile });
    const page = await context.newPage();

    try {
        // Идём на страницу биллинга
        await page.goto('https://www.notion.so/settings/billing', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        console.log(`  💳 Ищу кнопку добавления карты...\n`);

        // Ищем кнопку "Add payment method" или "Try free for 30 days"
        try {
            await page.getByRole('button', { name: 'Try free for 30 days' }).click({ timeout: 5000 });
        } catch {
            await page.getByRole('button', { name: 'Add payment method' }).click({ timeout: 5000 });
        }

        await page.waitForTimeout(3000);

        // Заполняем Name
        console.log(`  📝 Заполняю данные...\n`);
        await page.getByRole('textbox', { name: 'Name', exact: true }).fill(billing.name || 'Li Wei');
        await page.waitForTimeout(1000);

        // Заполняем карту в Stripe iframe
        console.log(`  💳 Заполняю карту...\n`);
        await page.waitForTimeout(2000);

        const cardFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first();

        await cardFrame.getByRole('textbox', { name: 'Card number' }).fill(preset.number);
        await page.waitForTimeout(800);

        const expParts = preset.exp.split('/');
        const expFormatted = `${expParts[0].trim()} / ${expParts[1].trim()}`;
        await cardFrame.getByRole('textbox', { name: 'Expiration date MM / YY' }).fill(expFormatted);
        await page.waitForTimeout(800);

        await cardFrame.getByRole('textbox', { name: 'Security code' }).fill(preset.cvc);
        await page.waitForTimeout(800);

        await cardFrame.getByLabel('Country', { exact: true }).selectOption(billing.country || 'CN');
        await page.waitForTimeout(1000);

        // Чекбокс согласия
        console.log(`  ✅ Принимаю условия...\n`);
        await page.getByRole('checkbox', { name: 'At the end of your trial' }).check();
        await page.waitForTimeout(1000);

        // Start trial
        console.log(`  🚀 Запускаю trial...\n`);
        await page.getByRole('button', { name: 'Start Notion Business trial' }).click();
        await page.waitForTimeout(10000);

        // Проверяем успех
        const url = page.url();
        if (url.includes('/billing') || url.includes('/settings')) {
            console.log(`  ✅ Карта привязана!\n`);

            // Обновляем session_info.txt
            const infoPath = path.join(session.path, 'session_info.txt');
            let infoContent = fs.readFileSync(infoPath, 'utf-8');
            infoContent = infoContent.replace(/Status: .*/,  'Status: trial-card-added');
            infoContent += `\nCardAttachedAt: ${new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()}`;
            fs.writeFileSync(infoPath, infoContent);
        } else {
            console.log(`  ⚠️  Не уверен что карта привязана. Проверь вручную.\n`);
        }

        console.log(`  💡 Браузер остаётся открытым - закрой вручную\n`);

    } catch (e) {
        console.log(`  ❌ Ошибка: ${e.message}\n`);
        throw e;
    }
}

// ─── Рендер ──────────────────────────────────────────────────────
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const visW = s => [...stripAnsi(s)].reduce((n, ch) => n + (ch.codePointAt(0) >= 0x1F000 ? 2 : 1), 0);
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - visW(s)));

function renderList(sessions, row, focus, actionIdx, clearScreen) {
    const COL_EMAIL = 36;
    const COL_DATE = 18;
    const COL_STATUS = 30;

    const lines = [];
    lines.push(`  📝 Notion — Менеджер сессий  \x1b[2m(${sessions.length} аккаунт${sessions.length === 1 ? '' : 'ов'})\x1b[0m`);
    lines.push('');
    lines.push('  \x1b[2m↑↓ — навигация   →← — действия   Enter — выполнить   Esc — назад\x1b[0m');
    lines.push('');
    lines.push(`  \x1b[2m  ${'#'.padStart(2)}     ${padTo('Email', COL_EMAIL)}  ${padTo('Дата', COL_DATE)}  Статус\x1b[0m`);
    lines.push(`  \x1b[2m  ${'─'.repeat(COL_EMAIL + COL_DATE + COL_STATUS + 10)}\x1b[0m`);

    sessions.forEach((s, i) => {
        const isRow = i === row;
        const cur = isRow && focus === 'list' ? '\x1b[36m❯\x1b[0m' : ' ';
        const num = String(i + 1).padStart(2);
        const icon = statusIcon(s.status);
        const emailRaw = s.email || '—';
        const emailWrapped = isRow && focus === 'list' ? `\x1b[1m\x1b[36m${emailRaw}\x1b[0m` : emailRaw;
        const dateRaw = s.date || '—';
        const statusText = statusLabel(s.status, s.planType);

        // Кнопки действий справа
        const actions = getActionsForSession(s);
        const actionButtons = actions.map((a, idx) => {
            if (a.separator) return a.label;
            const isSelected = isRow && focus === 'actions' && idx === actionIdx;
            return isSelected ? `\x1b[41m\x1b[37m ${a.label} \x1b[0m` : `\x1b[2m ${a.label} \x1b[0m`;
        }).join('  ');

        lines.push(`  ${cur} \x1b[2m${num}.\x1b[0m  ${icon}  ${padTo(emailWrapped, COL_EMAIL)}  \x1b[2m${padTo(dateRaw, COL_DATE)}\x1b[0m  \x1b[2m${statusText}\x1b[0m    ${actionButtons}`);
    });

    clearScreen();
    process.stdout.write(lines.join('\n') + '\n');
}

function getActionsForSession(session) {
    const actions = [
        { label: '🌐 Открыть', id: 'open' },
        { label: '🔑 Token', id: 'copy-token' },
    ];

    if (session.status === 'in-progress' || session.status === 'free') {
        actions.push({ label: '💳 Карта', id: 'attach-card' });
    }

    actions.push({ label: '🗑️ Удалить', id: 'delete' });

    return actions;
}

// ─── Главное ────────────────────────────────────────────────────
async function notionSessionsMenu({ clearScreen, setKeypressListener, rawList }) {
    let sessions = getNotionSessions();

    if (sessions.length === 0) {
        clearScreen();
        console.log('\n  📭 Нет сохранённых Notion-сессий\n');
        console.log('  💡 Создайте аккаунт через "📝 Notion" в главном меню\n');
        await new Promise(r => setTimeout(r, 2500));
        return;
    }

    let row = 0;
    let focus = 'list';      // 'list' | 'actions'
    let actionIdx = 0;

    process.stdin.resume();
    if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(true); } catch {}
    }
    renderList(sessions, row, focus, actionIdx, clearScreen);

    return new Promise(resolve => {
        const exit = () => {
            setKeypressListener(null);
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch {}
            }
            process.stdin.pause();
            resolve();
        };

        const executeAction = async (actionId) => {
            const session = sessions[row];
            setKeypressListener(null);
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(false); } catch {}
            }

            switch (actionId) {
                case 'open':
                    clearScreen();
                    console.log(`\n  🚀 Открываю Notion с сессией ${session.email}...\n`);
                    try {
                        await openInBrowser(session);
                    } catch (e) {
                        console.log(`  ❌ Ошибка: ${e.message}\n`);
                        await new Promise(r => setTimeout(r, 2000));
                    }
                    break;

                case 'attach-card':
                    clearScreen();
                    console.log(`\n  💳 Привязываю карту к ${session.email}...\n`);
                    try {
                        await attachCard(session);
                        sessions = getNotionSessions();
                        row = Math.min(row, sessions.length - 1);
                    } catch (e) {
                        console.log(`  ❌ Ошибка: ${e.message}\n`);
                        await new Promise(r => setTimeout(r, 2000));
                    }
                    break;

                case 'copy-token':
                    clearScreen();
                    console.log(`\n  🔑 Извлекаю token_v2 для ${session.email}...\n`);
                    {
                        const token = extractTokenV2(session);
                        if (!token) {
                            console.log('  ❌ token_v2 не найден в сессии\n');
                        } else {
                            console.log(`  📋 Token: ${token.slice(0, 20)}...${token.slice(-10)}`);
                            console.log(`  📏 Длина: ${token.length} символов\n`);
                            try {
                                await copyToClipboard(token);
                                console.log('  ✅ Скопировано в буфер обмена!\n');
                            } catch (e) {
                                console.log(`  ⚠️ Не удалось скопировать: ${e.message}`);
                                console.log(`  📝 Полный токен:\n  ${token}\n`);
                            }
                        }
                        await new Promise(r => setTimeout(r, 2500));
                    }
                    break;

                case 'delete':
                    clearScreen();
                    console.log(`\n  🗑️  Удаляю ${session.email}...\n`);
                    if (deleteSession(session)) {
                        console.log('  ✅ Удалено\n');
                        sessions = getNotionSessions();
                        if (sessions.length === 0) { exit(); return; }
                        row = Math.min(row, sessions.length - 1);
                    }
                    await new Promise(r => setTimeout(r, 1000));
                    break;
            }

            focus = 'list';
            actionIdx = 0;
            process.stdin.resume();
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                try { process.stdin.setRawMode(true); } catch {}
            }
            renderList(sessions, row, focus, actionIdx, clearScreen);
            setKeypressListener(onKey);
        };

        const onKey = async (str, key) => {
            if (!key) return;

            if (key.name === 'up') {
                if (focus === 'list') {
                    row = (row - 1 + sessions.length) % sessions.length;
                    actionIdx = 0;
                } else {
                    const actions = getActionsForSession(sessions[row]);
                    actionIdx = (actionIdx - 1 + actions.length) % actions.length;
                }
                renderList(sessions, row, focus, actionIdx, clearScreen);
            } else if (key.name === 'down') {
                if (focus === 'list') {
                    row = (row + 1) % sessions.length;
                    actionIdx = 0;
                } else {
                    const actions = getActionsForSession(sessions[row]);
                    actionIdx = (actionIdx + 1) % actions.length;
                }
                renderList(sessions, row, focus, actionIdx, clearScreen);
            } else if (key.name === 'right') {
                if (focus === 'list') {
                    focus = 'actions';
                    actionIdx = 0;
                    renderList(sessions, row, focus, actionIdx, clearScreen);
                }
            } else if (key.name === 'left') {
                if (focus === 'actions') {
                    focus = 'list';
                    renderList(sessions, row, focus, actionIdx, clearScreen);
                }
            } else if (key.name === 'return') {
                if (focus === 'list') {
                    // Enter на списке → открыть браузер
                    await executeAction('open');
                } else {
                    // Enter на действии → выполнить
                    const actions = getActionsForSession(sessions[row]);
                    await executeAction(actions[actionIdx].id);
                }
            } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                exit();
            }
        };

        setKeypressListener(onKey);
    });
}

module.exports = { notionSessionsMenu };
