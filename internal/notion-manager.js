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
const dashboard = require('./notion-dashboard');

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
    const info = { url: '', email: '', status: '', planType: '', completedAt: '', bannedAt: '', createdAt: '', card: '' };
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
            else if (k === 'card')        info.card = v;
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
            card:     info.card || '',
            date:     (info.completedAt || info.bannedAt || info.createdAt || '').slice(0, 16).replace('T', ' '),
        });
    }
    // Сначала готовые (по дате DESC), потом in-progress (по дате DESC) — отдельным блоком
    return list.sort((a, b) => {
        const aInProg = a.status === 'in-progress' ? 1 : 0;
        const bInProg = b.status === 'in-progress' ? 1 : 0;
        if (aInProg !== bInProg) return aInProg - bInProg;
        return b.date.localeCompare(a.date);
    });
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

    const finishedCount = sessions.filter(s => s.status !== 'in-progress').length;
    const inProgressCount = sessions.length - finishedCount;

    const lines = [];
    let header = `  📝 Notion — Менеджер сессий  \x1b[2m(${finishedCount} готовых`;
    if (inProgressCount > 0) header += ` · ${inProgressCount} в работе`;
    header += ')\x1b[0m';
    lines.push(header);
    lines.push('');
    lines.push('  \x1b[2m↑↓ — навигация   →← — действия   Enter — выполнить   B — все оплаченные в дашборд   Esc — назад\x1b[0m');
    lines.push('');
    lines.push(`  \x1b[2m  ${'#'.padStart(2)}     ${padTo('Email', COL_EMAIL)}  ${padTo('Дата', COL_DATE)}  Статус\x1b[0m`);
    lines.push(`  \x1b[2m  ${'─'.repeat(COL_EMAIL + COL_DATE + COL_STATUS + 10)}\x1b[0m`);

    let inProgressSeparatorShown = false;

    sessions.forEach((s, i) => {
        // Разделитель перед блоком "в работе"
        if (s.status === 'in-progress' && !inProgressSeparatorShown) {
            inProgressSeparatorShown = true;
            lines.push('');
            lines.push(`  \x1b[2m  ── ⏳ В работе (${inProgressCount}) — не отправляются в дашборд ─────────────\x1b[0m`);
        }

        const isRow = i === row;
        const cur = isRow && focus === 'list' ? '\x1b[36m❯\x1b[0m' : ' ';
        const num = String(i + 1).padStart(2);
        const icon = statusIcon(s.status);
        const dashMark = s.inDashboard ? '\x1b[32m📤\x1b[0m' : ' ';
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

        lines.push(`  ${cur} \x1b[2m${num}.\x1b[0m  ${icon} ${dashMark}  ${padTo(emailWrapped, COL_EMAIL)}  \x1b[2m${padTo(dateRaw, COL_DATE)}\x1b[0m  \x1b[2m${padTo(statusText, COL_STATUS)}\x1b[0m  ${actionButtons}`);
    });

    clearScreen();
    process.stdout.write(lines.join('\n') + '\n');
}

// "Оплаченный" = карта прикреплена (поле Card:) ИЛИ статус явно paid/trial-card-added.
// У старых сессий статус мог не записаться, но Card-строка надёжный маркер биллинга.
function isPaidSession(s) {
    if (s.status === 'paid' || s.status === 'trial-card-added') return true;
    if (s.card && s.card.trim()) return true;
    return false;
}

function getActionsForSession(session) {
    const actions = [
        { label: '🌐 Открыть', id: 'open' },
        { label: '🔑 Token', id: 'copy-token' },
    ];

    // Кнопка экспорта на любом готовом аккаунте (не в работе и не забанен)
    if (session.status !== 'in-progress' && session.status !== 'banned') {
        if (session.inDashboard) {
            actions.push({ label: '✅ В дашборде', id: 'noop-in-dashboard' });
        } else {
            actions.push({ label: '📤 В дашборд', id: 'to-dashboard' });
        }
    }

    if (session.status === 'in-progress' || session.status === 'free') {
        actions.push({ label: '💳 Карта', id: 'attach-card' });
    }

    actions.push({ label: '🗑️ Удалить', id: 'delete' });

    return actions;
}

async function bulkExportToDashboard(sessions, rawInput, clearScreen) {
    clearScreen();
    console.log('\n  📤 Батч-импорт оплаченных сессий в notion-abuz_ai\n');

    // Только оплаченные: paid + trial-card-added + любые с прикреплённой картой
    const paidSessions = sessions.filter(s => s.status !== 'in-progress' && s.status !== 'banned' && isPaidSession(s));
    const candidates = [];
    let noToken = 0;
    for (const s of paidSessions) {
        const token = extractTokenV2(s);
        if (!token) { noToken++; continue; }
        candidates.push({ session: s, token });
    }

    console.log(`  📊 Всего сессий: ${sessions.length}`);
    console.log(`  💰 С привязанной картой: ${paidSessions.length}`);
    if (noToken) console.log(`  ⚠️  Без token_v2: ${noToken}`);
    console.log('');

    if (candidates.length === 0) {
        console.log('  ❌ Нет оплаченных аккаунтов с токенами\n');
        await new Promise(r => setTimeout(r, 2500));
        return;
    }

    const cfg = await ensureDashboardAuth(rawInput);
    if (!cfg) {
        await new Promise(r => setTimeout(r, 2000));
        return;
    }

    // Получаем список уже добавленных аккаунтов для дедупликации
    process.stdout.write('  🔍 Получаю список аккаунтов в дашборде... ');
    let existingEmails = new Set();
    try {
        const list = await dashboard.listAccountEmails(cfg.url, _dashCookie);
        existingEmails = new Set(list);
        console.log(`✅ найдено ${existingEmails.size}\n`);
    } catch (e) {
        console.log(`⚠️ ${e.message}`);
        console.log('     Продолжаю без дедупликации\n');
    }

    // Фильтруем
    const toAdd = [];
    let skipped = 0;
    for (const c of candidates) {
        if (existingEmails.has((c.session.email || '').toLowerCase())) {
            c.session.inDashboard = true;
            skipped++;
        } else {
            toAdd.push(c);
        }
    }

    console.log(`  📤 К отправке: ${toAdd.length}`);
    console.log(`  ⏭️  Пропущено (уже в дашборде): ${skipped}\n`);

    if (toAdd.length === 0) {
        console.log('  ℹ️  Все оплаченные аккаунты уже в дашборде\n');
        await new Promise(r => setTimeout(r, 2500));
        return;
    }

    const confirm = (await rawInput(`  Подтверди отправку ${toAdd.length} аккаунтов (yes/no)`, 'yes')).trim().toLowerCase();
    if (confirm !== 'yes' && confirm !== 'y' && confirm !== 'да' && confirm !== '') {
        console.log('  ❌ Отменено\n');
        await new Promise(r => setTimeout(r, 1500));
        return;
    }

    console.log('');
    let ok = 0, fail = 0;
    for (let i = 0; i < toAdd.length; i++) {
        const { session, token } = toAdd[i];
        const num = String(i + 1).padStart(String(toAdd.length).length);
        process.stdout.write(`  [${num}/${toAdd.length}] ${(session.email || '?').padEnd(40)} `);
        try {
            const res = await dashboard.addAccount(cfg.url, _dashCookie, token);
            if (res.ok) {
                ok++;
                session.inDashboard = true;
                const plan = (res.account && res.account.plan_type) || '?';
                console.log(`✅ ${plan}`);
            } else {
                fail++;
                console.log(`❌ ${res.error}`);
            }
        } catch (e) {
            fail++;
            console.log(`❌ ${e.message}`);
        }
        // Небольшая пауза чтобы не дудосить
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\n  📊 Итого: ${ok} ✅   ${fail} ❌   ${skipped} ⏭️\n`);
    syncDashboardCacheFromSessions(sessions);
    console.log('  Нажми Enter для возврата...');
    await rawInput('', '');
}

// ─── Дашборд (notion-abuz_ai) ───────────────────────────────────
// Кэш в памяти на время одного запуска menu.js
let _dashCookie = null;
let _dashUrl = null;

async function ensureDashboardAuth(rawInput, force = false) {
    let cfg = dashboard.loadDashboardConfig();
    let needPrompt = force || !cfg || !cfg.url || !cfg.password;

    if (needPrompt) {
        console.log('\n  📤 Подключение к notion-abuz_ai дашборду\n');
        const defUrl = (cfg && cfg.url) || 'http://localhost:8190';
        const url = (await rawInput('  URL дашборда', defUrl)).trim() || defUrl;
        const password = (await rawInput('  Пароль дашборда', '')).trim();
        if (!password) {
            console.log('  ❌ Пароль не введён\n');
            return null;
        }
        cfg = { url: url.replace(/\/+$/, ''), password };
        dashboard.saveDashboardConfig(cfg);
    }

    if (_dashCookie && _dashUrl === cfg.url && !force) return cfg;

    process.stdout.write(`  🔐 Логин в ${cfg.url}... `);
    try {
        _dashCookie = await dashboard.login(cfg.url, cfg.password);
        _dashUrl = cfg.url;
        console.log('✅');
        return cfg;
    } catch (e) {
        console.log(`❌ ${e.message}\n`);
        // Сбрасываем пароль чтобы перезапросить
        return null;
    }
}

// Подгружает список аккаунтов из дашборда (если есть конфиг)
// и помечает sessions[].inDashboard. Сначала применяет локальный кэш
// (мгновенно), затем тихо обновляет из API. Не падает если дашборд недоступен.
async function enrichWithDashboardState(sessions) {
    // 1. Кэш — применяем сразу, без сети
    const cache = dashboard.loadDashboardCache();
    if (cache.emails.length) {
        const cachedSet = new Set(cache.emails);
        for (const s of sessions) {
            s.inDashboard = cachedSet.has((s.email || '').toLowerCase());
        }
    }

    // 2. API — обновляем кэш и состояние, если получится
    const cfg = dashboard.loadDashboardConfig();
    if (!cfg || !cfg.url || !cfg.password) return; // дашборд не настроен

    try {
        if (!_dashCookie || _dashUrl !== cfg.url) {
            _dashCookie = await dashboard.login(cfg.url, cfg.password);
            _dashUrl = cfg.url;
        }
        const emails = await dashboard.listAccountEmails(cfg.url, _dashCookie);
        const fresh = new Set(emails);
        for (const s of sessions) {
            s.inDashboard = fresh.has((s.email || '').toLowerCase());
        }
        dashboard.saveDashboardCache(emails);
    } catch {
        // Дашборд недоступен — оставляем то что было из кэша
    }
}

// Обновляет локальный кэш дашборда из текущего состояния sessions[].inDashboard.
// Используется после ручного/батч-добавления, чтобы при следующем запуске
// статус был доступен мгновенно из кэша.
function syncDashboardCacheFromSessions(sessions) {
    const cache = dashboard.loadDashboardCache();
    const set = new Set(cache.emails || []);
    for (const s of sessions) {
        const email = (s.email || '').toLowerCase();
        if (!email) continue;
        if (s.inDashboard) set.add(email);
    }
    dashboard.saveDashboardCache([...set]);
}

// ─── Главное ────────────────────────────────────────────────────
async function notionSessionsMenu({ clearScreen, setKeypressListener, rawList, rawInput }) {
    let sessions = getNotionSessions();

    if (sessions.length === 0) {
        clearScreen();
        console.log('\n  📭 Нет сохранённых Notion-сессий\n');
        console.log('  💡 Создайте аккаунт через "📝 Notion" в главном меню\n');
        await new Promise(r => setTimeout(r, 2500));
        return;
    }

    // Тихо подгружаем состояние из дашборда (если настроен)
    clearScreen();
    process.stdout.write('  🔄 Загрузка состояния...');
    await enrichWithDashboardState(sessions);

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

                case 'to-dashboard':
                    clearScreen();
                    if (session.status === 'in-progress' || session.status === 'banned') {
                        console.log(`\n  ❌ ${session.email} — статус "${session.status}", в дашборд не отправляется\n`);
                        await new Promise(r => setTimeout(r, 2000));
                        break;
                    }
                    console.log(`\n  📤 Отправка ${session.email} в дашборд...\n`);
                    {
                        const token = extractTokenV2(session);
                        if (!token) {
                            console.log('  ❌ token_v2 не найден в сессии\n');
                            await new Promise(r => setTimeout(r, 2000));
                            break;
                        }

                        const cfg = await ensureDashboardAuth(rawInput);
                        if (!cfg) {
                            await new Promise(r => setTimeout(r, 2000));
                            break;
                        }

                        process.stdout.write('  📨 Отправляю токен... ');
                        try {
                            const res = await dashboard.addAccount(cfg.url, _dashCookie, token);
                            if (res.ok) {
                                const a = res.account || {};
                                console.log('✅');
                                console.log(`     ${a.name || '?'} <${a.email || '?'}> · ${a.plan_type || '?'}\n`);
                                session.inDashboard = true;
                                syncDashboardCacheFromSessions(sessions);
                            } else {
                                console.log(`❌ ${res.error}\n`);
                            }
                        } catch (e) {
                            console.log(`❌ ${e.message}\n`);
                        }
                        await new Promise(r => setTimeout(r, 2500));
                    }
                    break;

                case 'noop-in-dashboard':
                    clearScreen();
                    console.log(`\n  ✅ ${session.email} уже в дашборде\n`);
                    await new Promise(r => setTimeout(r, 1500));
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
            } else if (key.sequence === 'b' || key.sequence === 'B' || key.sequence === 'и' || key.sequence === 'И') {
                // Bulk import всех в дашборд
                await bulkExportToDashboard(sessions, rawInput, clearScreen);
                renderList(sessions, row, focus, actionIdx, clearScreen);
            }
        };

        setKeypressListener(onKey);
    });
}

module.exports = { notionSessionsMenu };
