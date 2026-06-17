// internal/freemodel-manager.js
//
// Менеджер сессий FreeModel — отдельный, рядом с Devin-менеджером.
// Сканирует manual_sessions/ и берёт только те папки, чей session_info.txt
// содержит URL freemodel.dev. Открывает /dashboard/usage, парсит баланс
// и лимиты (5h / 7d).
//
// Экспортирует: freemodelSessionsMenu(helpers)
//   helpers = { clearScreen, setKeypressListener, rawList }

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SESSIONS_DIR = 'manual_sessions';
const V3_ACCOUNTS_DIR = path.join('freemodel', 'accounts');
const QUOTA_CACHE_FILE = 'logs/.freemodel_quota_cache.json';
const USAGE_URL = 'https://freemodel.dev/dashboard/usage';

// ─── Кэш квот ────────────────────────────────────────────────────
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
        const dir = path.dirname(QUOTA_CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {}
}

// ─── Сессии ──────────────────────────────────────────────────────
function readSessionInfo(itemPath) {
    const info = { url: '', email: '', org: '', status: '' };
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
            else if (k === 'org') info.org = v;
            else if (k === 'статус' || k === 'status') info.status = v;
        }
    } catch {}
    return info;
}

function isFreemodelSession(itemPath) {
    const info = readSessionInfo(itemPath);
    return info.url.includes('freemodel.dev');
}

// v3-формат: freemodel/accounts/<idx>_<ts>_ok_<ident>/{session.json, cookies.json, account_info.txt}
function readV3AccountInfo(itemPath) {
    const info = { email: '', invite: '', status: '', apiKey: '' };
    const f = path.join(itemPath, 'account_info.txt');
    if (!fs.existsSync(f)) return info;
    try {
        for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
            const c = line.indexOf(':');
            if (c < 0) continue;
            const k = line.slice(0, c).trim().toLowerCase();
            const v = line.slice(c + 1).trim();
            if (k === 'email') info.email = v;
            else if (k.startsWith('invite code')) info.invite = v;
            else if (k === 'status') info.status = v;
            else if (k === 'api key') info.apiKey = v;
        }
    } catch {}
    return info;
}

function parseV3Account(item, itemPath) {
    const sessionFile = path.join(itemPath, 'session.json');
    if (!fs.existsSync(sessionFile)) return null;
    const info = readV3AccountInfo(itemPath);

    const dtFull = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const okMark = /_ok_/.test(item) || /✅/.test(info.status);

    return {
        name: item,
        path: itemPath,
        orgName: '—',
        email: info.email || '—',
        date: dtFull ? `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}` : '—',
        status: okMark ? '✅' : '❌',
        backend: 'v3',
    };
}

function parseSession(item, itemPath) {
    const sessionFile = path.join(itemPath, 'session.json');
    if (!fs.existsSync(sessionFile)) return null;
    const info = readSessionInfo(itemPath);

    const userMatch = item.match(/user-([a-z0-9]+)/);
    const dtFull = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);

    return {
        name: item,
        path: itemPath,
        orgName: info.org || (userMatch ? `user-${userMatch[1]}` : '—'),
        email: info.email || '—',
        date: dtFull ? `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}` : '—',
        status: item.includes('error') ? '❌' : '✅',
    };
}

function getFreemodelSessions() {
    const list = [];

    // 1. Старый формат: manual_sessions/<name>/session_info.txt с "URL: freemodel.dev..."
    if (!fs.existsSync(SESSIONS_DIR)) {
        try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    }
    if (fs.existsSync(SESSIONS_DIR)) {
        for (const item of fs.readdirSync(SESSIONS_DIR)) {
            const p = path.join(SESSIONS_DIR, item);
            try {
                if (!fs.statSync(p).isDirectory()) continue;
            } catch { continue; }
            if (!isFreemodelSession(p)) continue;
            const s = parseSession(item, p);
            if (s) list.push(s);
        }
    }

    // 2. v3-формат: freemodel/accounts/<dir>/account_info.txt + session.json
    if (fs.existsSync(V3_ACCOUNTS_DIR)) {
        for (const item of fs.readdirSync(V3_ACCOUNTS_DIR)) {
            // Пропускаем служебные временные файлы автореги.
            if (item.startsWith('_tmp_') || item.startsWith('_error_')) continue;
            const p = path.join(V3_ACCOUNTS_DIR, item);
            try {
                if (!fs.statSync(p).isDirectory()) continue;
            } catch { continue; }
            const s = parseV3Account(item, p);
            if (s) list.push(s);
        }
    }

    return list.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
}

// Форсим английский UI: freemodel определяет язык по Accept-Language/navigator.language.
// Без этого новые v3-аккаунты, регистрировавшиеся под русским системным locale,
// открываются на русском, и парсер "AVAILABLE NOW" / "5-Hour window" ничего не находит.
const EN_CONTEXT_OPTS = {
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
};

// ─── Парсинг /dashboard/usage ────────────────────────────────────
async function checkFreemodelQuota(session) {
    let browser = null;
    try {
        const sessionFile = path.join(session.path, 'session.json');
        if (!fs.existsSync(sessionFile)) return null;
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState: sessionFile, ...EN_CONTEXT_OPTS });
        const page = await context.newPage();
        await page.goto(USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Ждём пока появится "AVAILABLE NOW" (заголовок блока)
        await page.waitForFunction(
            () => /AVAILABLE NOW/i.test(document.body?.innerText || ''),
            { timeout: 15000 }
        ).catch(() => {});

        // Ждём пока числа реально подгрузятся (а не "$0.00" placeholder).
        // Считаем готовым, когда AVAILABLE NOW > 0 ИЛИ оба окна (5h, 7d) уже не нулевые.
        await page.waitForFunction(() => {
            const text = (document.body?.innerText || '');
            const availMatch = text.match(/AVAILABLE NOW[\s\S]{0,80}?\$([\d.,]+)/i);
            if (availMatch && parseFloat(availMatch[1].replace(',', '')) > 0) return true;
            // если у юзера реально 0 — должны увидеть лимиты в окнах
            const w5 = text.match(/5-Hour window[\s\S]{0,120}?\$[\d.,]+\s*\/\s*\$([\d.,]+)/i);
            const w7 = text.match(/7-Day window[\s\S]{0,120}?\$[\d.,]+\s*\/\s*\$([\d.,]+)/i);
            return !!(w5 && w7 && parseFloat(w5[1]) > 0 && parseFloat(w7[1]) > 0);
        }, { timeout: 8000 }).catch(() => {});

        // Дополнительный буфер на ре-рендер React-state
        await page.waitForTimeout(1800);

        const data = await page.evaluate(() => {
            const text = (document.body?.innerText || '').replace(/\r/g, '');
            const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

            const out = { available: '', plan: '', bonus: '', h5: '', h5max: '', h5resets: '', h5pct: null, d7: '', d7max: '', d7resets: '', d7pct: null };

            // "AVAILABLE NOW" → следующая строка с $X.XX (в правой колонке), либо в одной из ближайших строк
            const availIdx = lines.findIndex(l => /^AVAILABLE NOW$/i.test(l));
            if (availIdx >= 0) {
                for (let i = availIdx + 1; i < Math.min(lines.length, availIdx + 6); i++) {
                    const m = lines[i].match(/^\$[\d.,]+$/);
                    if (m) { out.available = m[0]; break; }
                }
            }
            // "Plan (this week) $X.XX · Bonus credits $Y.YY"
            const planLine = lines.find(l => /Plan\s*\(this week\)/i.test(l));
            if (planLine) {
                const mp = planLine.match(/Plan\s*\(this week\)\s*\$?([\d.,]+)/i);
                const mb = planLine.match(/Bonus credits\s*\$?([\d.,]+)/i);
                if (mp) out.plan = `$${mp[1]}`;
                if (mb) out.bonus = `$${mb[1]}`;
            }
            // "5-Hour window" → "Resets in 3h 7m", "$0.13 / $10.00", "1% used"
            // Also handles percentage-only displays
            const findWindow = (label) => {
                // Skip fake "X-Hour window $0.00" lines in the AVAILABLE section
                let i = -1;
                for (let k = 0; k < lines.length; k++) {
                    const l = lines[k].toLowerCase();
                    if (l.startsWith(label.toLowerCase()) && !/\$/.test(l)) {
                        i = k; break;
                    }
                }
                if (i < 0) return null;
                let used = '', max = '', resets = '', pct = '';
                for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
                    const ln = lines[j];
                    // Stop if we hit the next section header
                    if (/^(7-Day|AVAILABLE|Plan|API|Usage|Logs|Billing)/i.test(ln)) break;
                    let m = ln.match(/^Resets\s+(.+)$/i);
                    if (m) { resets = m[1].trim(); continue; }
                    m = ln.match(/^\$?([\d.,]+)\s*\/\s*\$?([\d.,]+)$/);
                    if (m) { used = `$${m[1]}`; max = `$${m[2]}`; break; }
                    m = ln.match(/([\d.]+)\s*%\s*(?:used)?/i);
                    if (m && !used) { pct = parseFloat(m[1]); }
                }
                return { used, max, resets, pct };
            };
            const w5 = findWindow('5-Hour window');
            const w7 = findWindow('7-Day window');
            if (w5) { out.h5 = w5.used; out.h5max = w5.max; out.h5resets = w5.resets; out.h5pct = w5.pct || null; }
            if (w7) { out.d7 = w7.used; out.d7max = w7.max; out.d7resets = w7.resets; out.d7pct = w7.pct || null; }
            return out;
        });

        await browser.close();
        browser = null;

        if (!data.available && !data.h5 && !data.d7) return null;
        return data;
    } catch (e) {
        return null;
    } finally {
        if (browser) { try { await browser.close(); } catch {} }
    }
}

// ─── Извлечение API ключа ───────────────────────────────────────
// Открывает сессию, переходит на /dashboard/keys, создаёт новый ключ
// (маскирован в таблице), извлекает полный ключ из модалки успеха,
// сохраняет в account_info.txt и logs/.freemodel_meta.json.
const KEY_RE = /(?:fe[_-]|sk-)[A-Za-z0-9_-]{20,}/;
const KEY_PAGE_URL = 'https://freemodel.dev/dashboard/keys';

async function extractFreemodelApiKey(session) {
    let browser = null;
    try {
        const sessionFile = path.join(session.path, 'session.json');
        if (!fs.existsSync(sessionFile)) return { ok: false, error: 'session.json not found' };

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState: sessionFile, ...EN_CONTEXT_OPTS });
        const page = await context.newPage();

        await page.goto(KEY_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);

        // Проверяем лимит ключей (X / 5)
        const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        const limitMatch = bodyText.match(/(\d+)\s*\/\s*5/);
        if (limitMatch && parseInt(limitMatch[1], 10) >= 5) {
            await browser.close();
            return { ok: false, error: 'key limit reached (5/5)' };
        }

        // Ищем уже существующий ключ в account_info.txt (v3) или meta
        const infoFile = path.join(session.path, 'account_info.txt');
        if (fs.existsSync(infoFile)) {
            const infoText = fs.readFileSync(infoFile, 'utf-8');
            const m = infoText.match(KEY_RE);
            if (m) {
                await browser.close();
                return { ok: true, apiKey: m[0], source: 'account_info.txt' };
            }
        }

        // Dismiss any overlay that blocks clicks
        try {
            // Try clicking any visible button in the overlay
            const anyBtn = page.locator(".modal-backdrop button, .fixed.inset-0 button").first();
            if (await anyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await anyBtn.click({ timeout: 3000 });
                await page.waitForTimeout(800);
            }
        } catch {}
        try { await page.keyboard.press("Escape"); await page.waitForTimeout(400); } catch {}
        // Nuclear option: remove modal-backdrop via JS if still present
        try {
            await page.evaluate(() => {
                document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
            });
            await page.waitForTimeout(300);
        } catch {}

        // Click "Create key" — try JS click first, fallback to Playwright click
        let modalOpened = false;
        for (const method of ['js', 'playwright', 'force']) {
            try {
                if (method === 'js') {
                    await page.evaluate(() => {
                        const btns = document.querySelectorAll('button');
                        for (const b of btns) {
                            if (b.textContent.includes('Create key')) { b.click(); return; }
                        }
                    });
                } else if (method === 'playwright') {
                    await page.locator('button').filter({ hasText: 'Create key' }).first().click({ timeout: 5000 });
                } else if (method === 'force') {
                    await page.locator('button').filter({ hasText: 'Create key' }).first().click({ force: true, timeout: 5000 });
                }
                await page.waitForTimeout(1500);
                // Check if modal opened
                const modalInput = page.locator('#newKeyName, .modal-input');
                if (await modalInput.isVisible({ timeout: 2000 }).catch(() => false)) {
                    modalOpened = true;
                    break;
                }
            } catch { continue; }
        }

        if (!modalOpened) {
            throw new Error('could not open Create key modal');
        }

        // Заполняем имя ключа в модалке
        const nameInput = page.locator('#newKeyName, .modal-input');
        await nameInput.waitFor({ state: 'visible', timeout: 8000 });
        const keyName = `autoreg-${Date.now().toString(36)}`;
        await nameInput.fill(keyName);
        await page.waitForTimeout(400);

        // Submit — JS click for reliability
        await page.evaluate(() => {
            const modals = document.querySelectorAll('.modal, [role="dialog"]');
            for (const m of modals) {
                const btn = m.querySelector('button[type="submit"], button.dbtn-primary');
                if (btn) { btn.click(); return; }
            }
        });
        await page.waitForTimeout(2500);

        // Ждём успешную модалку с ключом
        const secretVal = page.locator('.secret-val');
        try {
            await secretVal.waitFor({ state: 'visible', timeout: 15000 });
        } catch {
            // Fallback: scan entire body for key text
            const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
            const m = bodyText.match(KEY_RE);
            if (m) {
                const apiKey = m[0];
                try { await page.keyboard.press("Escape"); } catch {}
                await browser.close(); browser = null;
                // Сохраняем
                try {
                    let infoText = '';
                    if (fs.existsSync(infoFile)) { infoText = fs.readFileSync(infoFile, 'utf-8'); }
                    if (/^API Key:/m.test(infoText)) { infoText = infoText.replace(/^API Key:.*$/m, 'API Key: ' + apiKey); }
                    else { infoText = infoText.trimEnd() + '\nAPI Key: ' + apiKey + '\n'; }
                    fs.writeFileSync(infoFile, infoText, 'utf-8');
                } catch {}
                return { ok: true, apiKey, source: 'body_scan' };
            }
            throw new Error('.secret-val not found and no key in body');
        }
        const apiKey = (await secretVal.innerText()).trim();

        // Закрываем модалку
        try {
            const doneBtn = page.locator('.modal-backdrop .dbtn-primary').filter({ hasText: 'Done' });
            await doneBtn.click({ timeout: 3000 });
        } catch {}

        await page.waitForTimeout(500);
        await browser.close();
        browser = null;

        if (!KEY_RE.test(apiKey)) {
            return { ok: false, error: `unexpected key format: ${apiKey.substring(0, 16)}...` };
        }

        // Сохраняем в account_info.txt
        try {
            let infoText = '';
            if (fs.existsSync(infoFile)) {
                infoText = fs.readFileSync(infoFile, 'utf-8');
            }
            if (/^API Key:/m.test(infoText)) {
                infoText = infoText.replace(/^API Key:.*$/m, 'API Key: ' + apiKey);
            } else {
                infoText = infoText.trimEnd() + '\nAPI Key: ' + apiKey + '\n';
            }
            fs.writeFileSync(infoFile, infoText, 'utf-8');
        } catch {}

        // Сохраняем в logs/.freemodel_meta.json
        const META_FILE = path.join('logs', '.freemodel_meta.json');
        try {
            const meta = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {};
            meta[session.name] = meta[session.name] || {};
            meta[session.name].apiKey = String(apiKey);
            fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
        } catch {}

        return { ok: true, apiKey, source: 'created' };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        if (browser) { try { await browser.close(); } catch {} }
    }
}

// ─── Рендер ──────────────────────────────────────────────────────
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const visW = s => [...stripAnsi(s)].reduce((n, ch) => n + (ch.codePointAt(0) >= 0x1F000 ? 2 : 1), 0);
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - visW(s)));

function renderList(sessions, row, quotaMap, loadingSet, focus, actionIdx, clearScreen) {
    const COL_EMAIL = 32;
    const COL_DATE = 16;

    const lines = [];
    lines.push(`  🆓 FreeModel — Менеджер сессий  \x1b[2m(${sessions.length} аккаунт${sessions.length === 1 ? '' : 'ов'})\x1b[0m`);
    lines.push('');
    const hint = focus === 'list'
        ? '\x1b[2m↑↓ сессия   → действия   Enter открыть /usage   Esc назад\x1b[0m'
        : '\x1b[2m↑↓ действие  ← список   Enter выполнить   Esc к списку\x1b[0m';
    lines.push(`  ${hint}`);
    lines.push('');
    lines.push(`  \x1b[2m  ${'#'.padStart(2)}  ${padTo('Email', COL_EMAIL)}  ${padTo('Дата', COL_DATE)}  Доступно   5h          7d\x1b[0m`);
    lines.push(`  \x1b[2m  ${'─'.repeat(COL_EMAIL + COL_DATE + 40)}\x1b[0m`);

    sessions.forEach((s, i) => {
        const isRow = i === row;
        const cursor = (isRow && focus === 'list') ? '\x1b[36m❯\x1b[0m' : (isRow ? '\x1b[2m›\x1b[0m' : ' ');
        const num = String(i + 1).padStart(2);
        const icon = s.status === '✅' ? '\x1b[32m✅\x1b[0m' : '\x1b[31m❌\x1b[0m';
        const emailWrap = isRow ? `\x1b[1m\x1b[36m${s.email}\x1b[0m` : s.email;
        const emailCol = padTo(emailWrap, COL_EMAIL);
        const dateCol = `\x1b[2m${padTo(s.date, COL_DATE)}\x1b[0m`;

        let extra = '';
        const q = quotaMap[s.name];
        if (loadingSet.has(s.name)) {
            extra = `\x1b[2m⏳ загрузка…\x1b[0m`;
        } else if (q) {
            const avail = q.available ? `\x1b[32m${q.available.padStart(7)}\x1b[0m` : '\x1b[2m   —   \x1b[0m';
            const h5 = q.h5 ? `${q.h5}/${q.h5max || '?'}` : '—';
            const d7 = q.d7 ? `${q.d7}/${q.d7max || '?'}` : '—';
            extra = `${avail}  \x1b[33m${padTo(h5, 10)}\x1b[0m  \x1b[36m${d7}\x1b[0m`;
        }

        lines.push(`  ${cursor} \x1b[2m${num}.\x1b[0m ${icon}  ${emailCol}${dateCol}  ${extra}`);
    });

    // Действия
    lines.push('');
    lines.push(`  \x1b[2m─────────────────────────────────────────────────────────\x1b[0m`);
    lines.push('');
    const actions = [
        { id: 'open',        label: '➜ Открыть /dashboard/usage в браузере' },
        { id: 'refresh',     label: '↻ Обновить квоту' },
        { id: 'refresh-all', label: '↻ Обновить все квоты' },
        { id: 'extract-key', label: '🔑 Извлечь API ключ' },
        { id: 'delete',      label: '✗ Удалить сессию' },
        { id: 'back',        label: '← Назад в меню' },
    ];
    actions.forEach((a, i) => {
        const isSel = focus === 'actions' && actionIdx === i;
        const cur = isSel ? '\x1b[36m❯\x1b[0m' : ' ';
        const text = isSel ? `\x1b[1m\x1b[36m${a.label}\x1b[0m` : (focus === 'actions' ? a.label : `\x1b[2m${a.label}\x1b[0m`);
        lines.push(`  ${cur} ${text}`);
    });

    // Детали выбранной сессии
    const s = sessions[row];
    if (s) {
        const q = quotaMap[s.name];
        lines.push('');
        lines.push(`  \x1b[2m─── Детали ───\x1b[0m`);
        lines.push(`  \x1b[2mEmail:\x1b[0m  ${s.email}`);
        lines.push(`  \x1b[2mПапка:\x1b[0m  ${s.path}`);
        if (q) {
            lines.push(`  \x1b[2mДоступно:\x1b[0m  ${q.available}   \x1b[2m(plan ${q.plan} · bonus ${q.bonus})\x1b[0m`);
            if (q.h5) lines.push(`  \x1b[2m5h окно:\x1b[0m   ${q.h5} / ${q.h5max}    \x1b[2m${q.h5resets}\x1b[0m`);
            if (q.d7) lines.push(`  \x1b[2m7d окно:\x1b[0m   ${q.d7} / ${q.d7max}    \x1b[2m${q.d7resets}\x1b[0m`);
        } else {
            lines.push(`  \x1b[2mКвота:\x1b[0m   не загружена  \x1b[2m(нажми "Обновить")\x1b[0m`);
        }
    }

    clearScreen();
    process.stdout.write(lines.join('\n'));
    return lines.length;
}

// ─── Главная функция ────────────────────────────────────────────
async function freemodelSessionsMenu({ clearScreen, setKeypressListener }) {
    let sessions = getFreemodelSessions();
    if (sessions.length === 0) {
        clearScreen();
        console.log('\n📭 Нет FreeModel-сессий в manual_sessions/');
        console.log('   Создай через: node freemodel/create_first_session.js\n');
        console.log('   Нажми любую клавишу для возврата...');
        await new Promise(r => {
            process.stdin.resume();
            if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(true); } catch {}
            process.stdin.once('keypress', () => {
                if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(false); } catch {}
                process.stdin.pause();
                r();
            });
        });
        return;
    }

    const quotaMap = loadQuotaCache();
    Object.keys(quotaMap).forEach(k => { if (!sessions.find(s => s.name === k)) delete quotaMap[k]; });
    saveQuotaCache(quotaMap);

    let row = 0, focus = 'list', actionIdx = 0;
    const loadingSet = new Set();

    let rerenderT = null;
    const doRender = () => renderList(sessions, row, quotaMap, loadingSet, focus, actionIdx, clearScreen);
    const rerender = (immediate = false) => {
        if (immediate) { if (rerenderT) clearTimeout(rerenderT); rerenderT = null; doRender(); }
        else if (!rerenderT) { rerenderT = setTimeout(() => { rerenderT = null; doRender(); }, 100); }
    };

    const setQuota = (name, q) => { quotaMap[name] = { ...q, updatedAt: Date.now() }; saveQuotaCache(quotaMap); };

    const loadOne = (s) => {
        if (s.status !== '✅') return;
        loadingSet.add(s.name); rerender(true);
        checkFreemodelQuota(s).then(q => {
            if (q) setQuota(s.name, q);
        }).catch(() => {}).finally(() => {
            loadingSet.delete(s.name);
            rerender();
        });
    };

    const loadAll = () => {
        const list = sessions.filter(s => s.status === '✅');
        if (list.length === 0) return;
        const MAX = 2;
        let idx = 0;
        const next = () => {
            while (loadingSet.size < MAX && idx < list.length) {
                const s = list[idx++];
                loadingSet.add(s.name);
                checkFreemodelQuota(s).then(q => {
                    if (q) setQuota(s.name, q);
                }).catch(() => {}).finally(() => {
                    loadingSet.delete(s.name);
                    rerender();
                    if (idx < list.length) next();
                });
            }
        };
        next();
    };

    const ACTIONS = ['open', 'refresh', 'refresh-all', 'extract-key', 'delete', 'back'];

    const openBrowser = async (s) => {
        setKeypressListener(null);
        if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(false); } catch {}
        try {
            const browser = await chromium.launch({ headless: false });
            const context = await browser.newContext({ storageState: path.join(s.path, 'session.json'), ...EN_CONTEXT_OPTS });
            const page = await context.newPage();
            await page.goto(USAGE_URL, { waitUntil: 'domcontentloaded' });
            // браузер оставляем открытым, юзер закроет
            loadOne(s);
        } catch {}
        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(true); } catch {}
        rerender(true);
        setKeypressListener(onKey);
    };

    let resolveOuter;
    const exitMenu = () => {
        setKeypressListener(null);
        if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(false); } catch {}
        process.stdin.pause();
        resolveOuter();
    };

    const execAction = async (id) => {
        const s = sessions[row];
        switch (id) {
            case 'open':        if (s) await openBrowser(s); break;
            case 'refresh':     if (s) loadOne(s); break;
            case 'refresh-all': loadAll(); break;
            case 'extract-key': {
                if (!s) return;
                clearScreen();
                process.stdout.write('\n  🔑 Извлекаю API ключ...\n');
                const result = await extractFreemodelApiKey(s);
                if (result.ok) {
                    process.stdout.write(`  ✅ Ключ: ${result.apiKey}\n  Источник: ${result.source}\n`);
                } else {
                    process.stdout.write(`  ❌ Ошибка: ${result.error}\n`);
                }
                process.stdout.write('\n  Нажми любую клавишу для продолжения...');
                await new Promise(r => {
                    process.stdin.once('keypress', () => r());
                });
                rerender(true);
                break;
            }
            case 'delete': {
                if (!s) return;
                try { fs.rmSync(s.path, { recursive: true, force: true }); } catch {}
                sessions = getFreemodelSessions();
                if (sessions.length === 0) { exitMenu(); return; }
                row = Math.min(row, sessions.length - 1);
                focus = 'list';
                rerender(true);
                break;
            }
            case 'back': exitMenu(); break;
        }
    };

    const onKey = async (str, key) => {
        if (!key) return;
        if (key.name === 'up') {
            if (focus === 'list') row = (row - 1 + sessions.length) % sessions.length;
            else actionIdx = (actionIdx - 1 + ACTIONS.length) % ACTIONS.length;
            rerender(true);
        } else if (key.name === 'down') {
            if (focus === 'list') row = (row + 1) % sessions.length;
            else actionIdx = (actionIdx + 1) % ACTIONS.length;
            rerender(true);
        } else if (key.name === 'right') {
            focus = 'actions'; rerender(true);
        } else if (key.name === 'left') {
            focus = 'list'; rerender(true);
        } else if (key.name === 'return') {
            if (focus === 'list') await openBrowser(sessions[row]);
            else await execAction(ACTIONS[actionIdx]);
        } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            if (focus === 'actions') { focus = 'list'; rerender(true); }
            else exitMenu();
        }
    };

    process.stdin.resume();
    if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(true); } catch {}
    rerender(true);

    // Авто-загрузка квот при первом входе (только тех что без кэша)
    setTimeout(() => {
        const stale = sessions.filter(s => s.status === '✅' && !quotaMap[s.name]);
        if (stale.length) {
            stale.forEach(s => loadingSet.add(s.name));
            rerender();
            let i = 0;
            const next = () => {
                while (loadingSet.size <= 2 && i < stale.length) {
                    const s = stale[i++];
                    checkFreemodelQuota(s).then(q => { if (q) setQuota(s.name, q); })
                        .catch(() => {}).finally(() => { loadingSet.delete(s.name); rerender(); if (i < stale.length) next(); });
                }
            };
            next();
        }
    }, 200);

    return new Promise(res => { resolveOuter = res; setKeypressListener(onKey); });
}

module.exports = { freemodelSessionsMenu, getFreemodelSessions, checkFreemodelQuota, extractFreemodelApiKey };
