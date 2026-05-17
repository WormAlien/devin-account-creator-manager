const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SESSIONS_DIR = 'manual_sessions';

// Перехватываем выход — не даём Playwright убивать браузеры
const _exit = process.exit.bind(process);
process.exit = (code) => {
    process.removeAllListeners('exit');
    _exit(code);
};
// Playwright вешает обработчики на эти сигналы при каждом launch()
// Переопределяем их так чтобы они не трогали браузеры
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
    process.on(sig, () => {
        process.removeAllListeners('exit');
        try { process.stdin.setRawMode(false); } catch(e) {}
        _exit(0);
    });
});

// ─── Загрузка сессий ────────────────────────────────────────────────────────
function getSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        return [];
    }

    const sessions = [];
    for (const item of fs.readdirSync(SESSIONS_DIR)) {
        const itemPath = path.join(SESSIONS_DIR, item);
        const sessionFile = path.join(itemPath, 'session.json');
        const infoFile = path.join(itemPath, 'session_info.txt');

        if (!fs.statSync(itemPath).isDirectory() || !fs.existsSync(sessionFile)) continue;

        let info = { name: item, path: itemPath, orgName: 'Неизвестно', email: 'Неизвестно', date: 'Неизвестно', status: '✅' };

        const userMatch = item.match(/user-([a-z0-9]+)/);
        const orgMatch  = item.match(/org-([a-f0-9]+)/);
        const dateMatch = item.match(/(\d{4}-\d{2}-\d{2})/);

        if (userMatch) info.orgName = `user-${userMatch[1]}`;
        if (orgMatch)  info.orgName = `org-${orgMatch[1]}`;
        if (dateMatch) info.date = dateMatch[1];

        if (fs.existsSync(infoFile)) {
            try {
                for (const line of fs.readFileSync(infoFile, 'utf-8').split('\n')) {
                    if (line.includes('Email:'))  info.email   = line.split(':')[1]?.trim() || info.email;
                    if (line.includes('Org:'))    info.orgName = line.split(':')[1]?.trim() || info.orgName;
                    if (line.includes('Статус:')) info.status  = line.split(':')[1]?.trim() || info.status;
                }
            } catch (e) {}
        }

        if (item.includes('success'))    info.status = '✅';
        else if (item.includes('error')) info.status = '❌';

        sessions.push(info);
    }

    return sessions.sort((a, b) => b.name.localeCompare(a.name));
}

// ─── Отрисовка меню ─────────────────────────────────────────────────────────
function render(sessions, selectedRow, selectedCol) {
    console.clear();
    console.log('  ⚡ Менеджер сессий\n');
    console.log('  ↑↓ — навигация   →← — удалить   Enter — открыть   Esc — выход\n');

    sessions.forEach((s, i) => {
        const isRow = i === selectedRow;
        const cursor = isRow ? '❯' : ' ';

        const email = s.email !== 'Неизвестно' ? s.email : '';
        const info  = [s.orgName, email, s.date].filter(Boolean).join('  ');
        const label = `${s.status}  ${info}`;

        // Кнопка удалить справа — выделена если курсор на ней
        const delBtn = (isRow && selectedCol === 1)
            ? '\x1b[41m\x1b[37m [ удалить ] \x1b[0m'
            : '\x1b[2m [ удалить ] \x1b[0m';

        // Паддинг между текстом и кнопкой
        const padLen = Math.max(1, 60 - label.length);
        const pad = ' '.repeat(padLen);

        if (isRow && selectedCol === 0) {
            console.log(`  ${cursor} \x1b[36m${label}\x1b[0m${pad}${delBtn}`);
        } else {
            console.log(`  ${cursor} ${label}${pad}${delBtn}`);
        }
    });

    console.log('\n  ─────────────────────────────────────────');
    console.log('  Esc / Q — выход');
}

// ─── Открыть сессию ──────────────────────────────────────────────────────────
async function openSession(session) {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: path.join(session.path, 'session.json') });
    const page    = await context.newPage();

    await page.goto('https://app.devin.ai', { waitUntil: 'domcontentloaded' });
}

// ─── Подтверждение удаления ──────────────────────────────────────────────────
function confirmDelete(session) {
    return new Promise(resolve => {
        console.clear();
        process.stdout.write(`\n  🗑️  Удалить "${session.orgName}"?\n\n  [ Y — да ]   [ N — отмена ]\n\n  > `);

        const onKey = (str, key) => {
            if (key.name === 'y') {
                process.stdin.removeListener('keypress', onKey);
                process.stdin.setRawMode(false);
                try { fs.rmSync(session.path, { recursive: true, force: true }); } catch (e) {}
                console.log('\n✅ Удалено\n');
                resolve(true);
            } else if (key.name === 'n' || key.name === 'escape') {
                process.stdin.removeListener('keypress', onKey);
                process.stdin.setRawMode(false);
                resolve(false);
            }
        };

        process.stdin.setRawMode(true);
        process.stdin.on('keypress', onKey);
    });
}

// ─── Главное меню (raw mode) ─────────────────────────────────────────────────
async function mainMenu() {
    let sessions = getSessions();

    if (sessions.length === 0) {
        console.log('\n📭 Нет сохранённых сессий\n');
        process.exit(0);
    }

    let row = 0;
    let col = 0; // 0 = сессия, 1 = кнопка удалить

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    render(sessions, row, col);

    return new Promise(resolve => {
        const onKey = async (str, key) => {
            if (!key) return;

            if (key.name === 'up') {
                row = (row - 1 + sessions.length) % sessions.length;
                col = 0;
                render(sessions, row, col);

            } else if (key.name === 'down') {
                row = (row + 1) % sessions.length;
                col = 0;
                render(sessions, row, col);

            } else if (key.name === 'right') {
                col = 1;
                render(sessions, row, col);

            } else if (key.name === 'left') {
                col = 0;
                render(sessions, row, col);

            } else if (key.name === 'return') {
                process.stdin.removeListener('keypress', onKey);
                process.stdin.setRawMode(false);

                if (col === 1) {
                    // Удалить
                    const deleted = await confirmDelete(sessions[row]);
                    if (deleted) {
                        sessions = getSessions();
                        if (sessions.length === 0) { process.exit(0); }
                        row = Math.min(row, sessions.length - 1);
                    }
                } else {
                    // Открыть
                    await openSession(sessions[row]);
                }

                // Возврат в меню — сохраняем позицию курсора
                readline.emitKeypressEvents(process.stdin);
                process.stdin.setRawMode(true);
                render(sessions, row, col);
                process.stdin.on('keypress', onKey);

            } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
                process.stdin.removeListener('keypress', onKey);
                process.stdin.setRawMode(false);
                console.clear();
                process.exit(0);
            }
        };

        process.stdin.on('keypress', onKey);
    });
}

mainMenu().catch(err => {
    if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch (e) {}
    }
    if (err?.message?.includes('force closed') || err?.isTtyError) process.exit(0);
    if (err) console.error(err);
    process.exit(0);
});
