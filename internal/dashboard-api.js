// Pure async helpers for the :8200 dashboard. No readline, no TUI, no spinners
// — just data in / data out. Both the CLI menu and the HTTP endpoints in
// transparent-proxy.js use these.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

let _freemodel = null;
function freemodelMod() {
    if (!_freemodel) _freemodel = require('./freemodel-manager');
    return _freemodel;
}

let _notion = null;
function notionMod() {
    if (!_notion) _notion = require('./notion-manager');
    return _notion;
}

let _devin = null;
function devinMod() {
    if (!_devin) _devin = require('./devin-manager');
    return _devin;
}

const OMNI_DB = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const SQLITE_EXE = process.env.SQLITE3
    || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe');

function sqliteJson(sql) {
    if (!fs.existsSync(SQLITE_EXE)) {
        throw new Error(`sqlite3 not found at ${SQLITE_EXE} (set SQLITE3 env var)`);
    }
    if (!fs.existsSync(OMNI_DB)) {
        throw new Error(`OmniRoute db not found at ${OMNI_DB}`);
    }
    const out = execFileSync(SQLITE_EXE, [OMNI_DB, '-json', sql], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
    });
    return out ? JSON.parse(out) : [];
}

function sqliteExec(sql) {
    if (!fs.existsSync(SQLITE_EXE)) {
        throw new Error(`sqlite3 not found at ${SQLITE_EXE}`);
    }
    execFileSync(SQLITE_EXE, [OMNI_DB, sql], { encoding: 'utf8' });
}

// ───── OmniRoute accounts + latest quota snapshots ────────────────
function listOmniAccountsWithQuotas() {
    const accounts = sqliteJson(`
        SELECT id, provider, auth_type, name, email, is_active, test_status,
               error_code, last_error, rate_limited_until, last_used_at, created_at
        FROM provider_connections
        ORDER BY is_active DESC, datetime(coalesce(last_used_at, created_at)) DESC;
    `);
    if (!accounts.length) return [];
    // Latest snapshot per (connection_id, window_key)
    const snapshots = sqliteJson(`
        SELECT q.connection_id, q.window_key, q.remaining_percentage, q.next_reset_at, q.is_exhausted
        FROM quota_snapshots q
        JOIN (
            SELECT connection_id, window_key, MAX(created_at) AS mx
            FROM quota_snapshots
            GROUP BY connection_id, window_key
        ) latest
          ON q.connection_id = latest.connection_id
         AND q.window_key    = latest.window_key
         AND q.created_at    = latest.mx;
    `);
    const byConn = {};
    for (const s of snapshots) {
        if (!byConn[s.connection_id]) byConn[s.connection_id] = {};
        byConn[s.connection_id][s.window_key] = {
            remaining: s.remaining_percentage,
            resetAt:   s.next_reset_at,
            exhausted: !!s.is_exhausted,
        };
    }
    for (const a of accounts) a.quotas = byConn[a.id] || {};
    return accounts;
}

// ───── Notion sessions (read-only) ──────────────────────────────────
// No quota cache exists for Notion sessions (notion/sessions/) — quotas
// live behind notion-manager's HTTP dashboard which needs auth. Plan/status
// from local session.json info is what we surface here.
function listNotionSessions() {
    return notionMod().getNotionSessions();
}

// ───── FreeModel sessions + cached quotas ──────────────────────────
// Persists to logs/.freemodel_quota_cache.json (separate from the legacy
// menu.js cache which uses an older format). Survives switcher restarts.
const PROJECT_ROOT = path.join(__dirname, '..');
const FREEMODEL_QUOTA_CACHE = path.join(PROJECT_ROOT, 'logs', '.freemodel_quota_cache.json');

function loadFreemodelQuotaCache() {
    try {
        if (fs.existsSync(FREEMODEL_QUOTA_CACHE)) {
            return JSON.parse(fs.readFileSync(FREEMODEL_QUOTA_CACHE, 'utf-8')) || {};
        }
    } catch {}
    return {};
}

function saveFreemodelQuotaCache(cache) {
    try {
        fs.mkdirSync(path.dirname(FREEMODEL_QUOTA_CACHE), { recursive: true });
        fs.writeFileSync(FREEMODEL_QUOTA_CACHE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {}
}

// ───── FreeModel meta (banned-маркер + связь с TG-пулом) ──────────
// Хранится отдельно от quota-кэша чтобы рефреш квот не затирал маркеры.
// Ключ — session.name (имя папки v3 или manual_sessions/...).
const FREEMODEL_META_FILE = path.join(PROJECT_ROOT, 'logs', '.freemodel_meta.json');

function loadFreemodelMeta() {
    try {
        if (fs.existsSync(FREEMODEL_META_FILE)) {
            return JSON.parse(fs.readFileSync(FREEMODEL_META_FILE, 'utf-8')) || {};
        }
    } catch {}
    return {};
}

function saveFreemodelMeta(meta) {
    try {
        fs.mkdirSync(path.dirname(FREEMODEL_META_FILE), { recursive: true });
        fs.writeFileSync(FREEMODEL_META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {}
}

function setFreemodelBanned(name, banned) {
    const meta = loadFreemodelMeta();
    meta[name] = meta[name] || {};
    if (banned) {
        meta[name].banned = true;
        meta[name].bannedAt = new Date().toISOString();
    } else {
        delete meta[name].banned;
        delete meta[name].bannedAt;
    }
    saveFreemodelMeta(meta);
    return meta[name];
}

// Привязать TG-phone к freemodel-аккаунту (вызывается из автореги после
// успешной привязки бота — для UI-карточки).
function setFreemodelTgPhone(name, tgPhone) {
    const meta = loadFreemodelMeta();
    meta[name] = meta[name] || {};
    if (tgPhone) {
        meta[name].tgPhone = String(tgPhone);
        meta[name].tgLinkedAt = new Date().toISOString();
    } else {
        delete meta[name].tgPhone;
        delete meta[name].tgLinkedAt;
    }
    saveFreemodelMeta(meta);
    return meta[name];
}

function setFreemodelApiKey(name, apiKey) {
    const meta = loadFreemodelMeta();
    meta[name] = meta[name] || {};
    if (apiKey) meta[name].apiKey = String(apiKey);
    else delete meta[name].apiKey;
    saveFreemodelMeta(meta);
    return meta[name];
}

async function extractFreemodelApiKey(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getFreemodelSessions, extractFreemodelApiKey: extractKey } = freemodelMod();
    const session = getFreemodelSessions().find(s => s.name === name);
    if (!session) throw new Error(`session not found: ${name}`);
    return await extractKey(session);
}

// withQuotas behavior:
//   'cache'   — return cached quotas only (instant, no Playwright)
//   'refresh' — refresh via Playwright in parallel, update cache, return new values
//   false     — no quota info at all (fastest, list only)
async function listFreemodelSessions({ withQuotas = 'cache', concurrency = 3 } = {}) {
    const { getFreemodelSessions, checkFreemodelQuota } = freemodelMod();
    const sessions = getFreemodelSessions();
    const meta = loadFreemodelMeta();
    // Подхватываем apiKey из freemodel/accounts/<dir>/account_info.txt
    // и кладём в meta — UI получает всё из одного места.
    for (const s of sessions) {
        if (!meta[s.name]?.apiKey) {
            try {
                const infoFile = path.join(s.path, 'account_info.txt');
                if (fs.existsSync(infoFile)) {
                    const raw = fs.readFileSync(infoFile, 'utf-8');
                    const km = raw.match(/^API Key:\s*((?:fe[_-]|sk-)[A-Za-z0-9_-]{20,})/m);
                    if (km) {
                        meta[s.name] = meta[s.name] || {};
                        meta[s.name].apiKey = km[1];
                    }
                }
            } catch {}
        }
    }
    const withMeta = (s, extra) => ({ ...s, ...extra, meta: meta[s.name] || {} });
    if (withQuotas === false) return sessions.map(s => withMeta(s, { quota: null }));

    const cache = loadFreemodelQuotaCache();

    if (withQuotas === 'cache') {
        return sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));
    }

    // refresh — skip banned and error sessions
    const eligible = sessions.filter(s => {
        const m = meta[s.name] || {};
        return s.status === '✅' && !m.banned;
    });
    if (eligible.length === 0) return sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));

    const out = sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, eligible.length) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= eligible.length) return;
            try {
                const q = await checkFreemodelQuota(eligible[i]);
                if (q) {
                    const origIdx = sessions.indexOf(eligible[i]);
                    if (origIdx >= 0) out[origIdx].quota = { ...q, updatedAt: Date.now() };
                    cache[eligible[i].name] = out[origIdx >= 0 ? origIdx : i].quota;
                    // TG-привязка — локальная мета (ставится при bind) авторитетна.
                    // Скан freemodel.dev может ДОБАВИТь номер, если локально пусто,
                    // но НИКОГДА не удаляет: tgBound===false на ненадёжном скане раньше
                    // стирал привязки (оставался осиротевший tgLinkedAt).
                    if (q.tgBound === true) {
                        meta[eligible[i].name] = meta[eligible[i].name] || {};
                        if (!meta[eligible[i].name].tgPhone) {
                            meta[eligible[i].name].tgPhone = q.tgPhone || 'connected';
                        }
                    }
                }
            } catch { /* keep cached value */ }
        }
    });
    await Promise.all(workers);
    saveFreemodelQuotaCache(cache);
    saveFreemodelMeta(meta);
    return out;
}

// ───── Devin sessions + cached quotas ──────────────────────────────
// Reuses logs/.quota_cache.json (menu.js writes here when refreshing
// Devin quotas — fields: daily, weekly, resetsIn, plan, updatedAt).
const DEVIN_QUOTA_CACHE = path.join(PROJECT_ROOT, 'logs', '.quota_cache.json');

function loadDevinQuotaCache() {
    try {
        if (fs.existsSync(DEVIN_QUOTA_CACHE)) {
            return JSON.parse(fs.readFileSync(DEVIN_QUOTA_CACHE, 'utf-8')) || {};
        }
    } catch {}
    return {};
}

function saveDevinQuotaCache(cache) {
    try {
        fs.mkdirSync(path.dirname(DEVIN_QUOTA_CACHE), { recursive: true });
        fs.writeFileSync(DEVIN_QUOTA_CACHE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {}
}

async function listDevinSessions({ withQuotas = 'cache', concurrency = 3 } = {}) {
    const { getDevinSessions, checkDevinQuota } = devinMod();
    const sessions = getDevinSessions();
    if (withQuotas === false) return sessions.map(s => ({ ...s, quota: null }));

    const cache = loadDevinQuotaCache();

    if (withQuotas === 'cache') {
        return sessions.map(s => ({ ...s, quota: cache[s.name] || null }));
    }

    const out = sessions.map(s => ({ ...s, quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, sessions.length) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= sessions.length) return;
            try {
                const q = await checkDevinQuota(sessions[i]);
                if (q) {
                    out[i].quota = { ...q, updatedAt: Date.now() };
                    cache[sessions[i].name] = out[i].quota;
                }
            } catch {}
        }
    });
    await Promise.all(workers);
    saveDevinQuotaCache(cache);
    return out;
}

async function refreshOneDevinQuota(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getDevinSessions, checkDevinQuota } = devinMod();
    const session = getDevinSessions().find(s => s.name === name);
    if (!session) throw new Error(`devin session not found: ${name}`);
    const q = await checkDevinQuota(session);
    const cache = loadDevinQuotaCache();
    if (q) {
        cache[name] = { ...q, updatedAt: Date.now() };
        saveDevinQuotaCache(cache);
    }
    return cache[name] || null;
}
function toggleOmniAccount(id, active) {
    if (!/^[0-9a-fA-F-]{8,}$/.test(String(id))) {
        throw new Error('bad id format (expected hex UUID or 8+ char prefix)');
    }
    let fullId = id;
    if (id.length < 36) {
        const matches = sqliteJson(
            `SELECT id FROM provider_connections WHERE id LIKE '${id}%';`
        );
        if (matches.length === 0) throw new Error(`no account matching prefix '${id}'`);
        if (matches.length > 1) {
            throw new Error(`prefix '${id}' is ambiguous (${matches.length} matches: ` +
                matches.map(m => m.id.substring(0,12)).join(', ') + ')');
        }
        fullId = matches[0].id;
    }
    const flag = active ? 1 : 0;
    const ts = new Date().toISOString();
    const extra = active
        ? `, error_code = NULL, last_error = NULL, last_error_at = NULL,
             rate_limited_until = NULL, backoff_level = 0, test_status = 'active'`
        : '';
    const sql = `UPDATE provider_connections
                 SET is_active = ${flag},
                     updated_at = '${ts}'${extra}
                 WHERE id = '${fullId}';`;
    sqliteExec(sql);
    const rows = sqliteJson(`SELECT id, name, email, is_active, test_status, error_code, last_error
                              FROM provider_connections WHERE id = '${fullId}';`);
    if (!rows.length) throw new Error(`no account with id=${fullId}`);
    return rows[0];
}

// ───── Per-session actions (Notion / FreeModel) ───────────────────
async function openSessionInBrowser(kind, name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    if (kind === 'notion') {
        const dir = path.join(PROJECT_ROOT, 'notion', 'sessions', name);
        if (!fs.existsSync(dir)) throw new Error(`notion session not found: ${name}`);
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
        const context = await browser.newContext({ storageState: path.join(dir, 'session.json'), viewport: null });
        const page = await context.newPage();
        await page.goto('https://www.notion.so/', { waitUntil: 'domcontentloaded' }).catch(() => {});
        return { ok: true, kind, name, url: 'https://www.notion.so/' };
    }
    if (kind === 'freemodel') {
        const session = freemodelMod().getFreemodelSessions().find(s => s.name === name);
        if (!session) throw new Error(`freemodel session not found: ${name}`);
        const dir = session.path;
        if (!fs.existsSync(dir)) throw new Error(`freemodel session dir gone: ${dir}`);
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
        const context = await browser.newContext({
            storageState: path.join(dir, 'session.json'),
            viewport: null,  // заполнять окно (--start-maximized), не фикс 1280×720
            // Форсим английский UI: иначе ru-системные акки откроются на русском
            locale: 'en-US',
            extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
        });
        const page = await context.newPage();
        await page.goto('https://freemodel.dev/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
        return { ok: true, kind, name, url: 'https://freemodel.dev/dashboard/usage' };
    }
    if (kind === 'conduit') {
        const account = conduitMod().getConduitAccounts().find(s => s.name === name);
        if (!account) throw new Error(`conduit account not found: ${name}`);
        if (!account.sessionFile || !fs.existsSync(account.sessionFile)) throw new Error(`conduit session.json gone (key-only акк?): ${name}`);
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
        const context = await browser.newContext({ storageState: account.sessionFile, viewport: null });
        const page = await context.newPage();
        await page.goto('https://conduit.ozdoev.net/#cabinet', { waitUntil: 'domcontentloaded' }).catch(() => {});
        return { ok: true, kind, name, url: 'https://conduit.ozdoev.net/#cabinet' };
    }
    if (kind === 'devin') {
        const session = devinMod().getDevinSessions().find(s => s.name === name);
        if (!session) throw new Error(`devin session not found: ${name}`);
        if (!fs.existsSync(session.path)) throw new Error(`devin session dir gone: ${session.path}`);
        const orgName = session.orgName && session.orgName !== 'Неизвестно' ? session.orgName : null;
        const url = orgName
            ? `https://app.devin.ai/org/${orgName}/settings/usage`
            : 'https://app.devin.ai/';
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
        const context = await browser.newContext({ storageState: path.join(session.path, 'session.json'), viewport: null });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        return { ok: true, kind, name, url };
    }
    throw new Error(`unknown kind: ${kind}`);
}

async function refreshOneFreemodelQuota(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getFreemodelSessions, checkFreemodelQuota } = freemodelMod();
    const session = getFreemodelSessions().find(s => s.name === name);
    if (!session) throw new Error(`session not found: ${name}`);
    const q = await checkFreemodelQuota(session);
    const cache = loadFreemodelQuotaCache();
    if (q) {
        cache[name] = { ...q, updatedAt: Date.now() };
        saveFreemodelQuotaCache(cache);
    }
    return cache[name] || null;
}

function deleteSession(kind, name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    let dir;
    if (kind === 'notion') {
        dir = path.join(PROJECT_ROOT, 'notion', 'sessions', name);
    } else if (kind === 'freemodel') {
        const s = freemodelMod().getFreemodelSessions().find(x => x.name === name);
        if (!s) throw new Error(`freemodel session not found: ${name}`);
        dir = s.path;
    } else if (kind === 'devin') {
        // Devin sessions live across three roots — find by getDevinSessions
        const s = devinMod().getDevinSessions().find(x => x.name === name);
        if (!s) throw new Error(`devin session not found: ${name}`);
        dir = s.path;
    } else {
        throw new Error(`unknown kind: ${kind}`);
    }
    if (!fs.existsSync(dir)) throw new Error(`session dir not found: ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });

    // Clean up quota cache entries
    if (kind === 'freemodel') {
        const cache = loadFreemodelQuotaCache();
        if (cache[name]) { delete cache[name]; saveFreemodelQuotaCache(cache); }
    } else if (kind === 'devin') {
        const cache = loadDevinQuotaCache();
        if (cache[name]) { delete cache[name]; saveDevinQuotaCache(cache); }
    }
    return { ok: true, kind, name };
}

// ───── Notion card presets (config.js editing) ─────────────────────
// notion/config.js exports a plain JS object via module.exports. We mutate
// only two fields: CARD_PRESETS array (read-only here) and CARD_PRESET_INDEX.
// String-replace for CARD_PRESET_INDEX (regex), require() for parse.
const NOTION_CONFIG = path.join(PROJECT_ROOT, 'notion', 'config.js');

function getNotionCards() {
    if (!fs.existsSync(NOTION_CONFIG)) {
        throw new Error('notion/config.js not found');
    }
    // Bust require cache so on-disk changes (from this same dashboard) are picked up.
    delete require.cache[require.resolve(NOTION_CONFIG)];
    const cfg = require(NOTION_CONFIG);
    return {
        presets:      Array.isArray(cfg.CARD_PRESETS) ? cfg.CARD_PRESETS : [],
        currentIndex: cfg.CARD_PRESET_INDEX,
    };
}

function setNotionCardIndex(value) {
    // value is either an integer >= 0 or the string 'rotate'
    let serialised;
    if (value === 'rotate') {
        serialised = `'rotate'`;
    } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new Error('index must be a non-negative integer or "rotate"');
        serialised = String(n);
    }
    let txt = fs.readFileSync(NOTION_CONFIG, 'utf8');
    const before = txt;
    txt = txt.replace(
        /(CARD_PRESET_INDEX\s*:\s*)('rotate'|"rotate"|\d+)(\s*,?)/,
        (_, k, _v, tail) => `${k}${serialised}${tail}`
    );
    if (txt === before) throw new Error('CARD_PRESET_INDEX not found in notion/config.js');
    fs.writeFileSync(NOTION_CONFIG, txt, 'utf8');
    delete require.cache[require.resolve(NOTION_CONFIG)];
    return getNotionCards();
}

// ───── Launch scripts in detached terminal windows ─────────────────
// Each "kind" maps to one launch command. We use Windows `cmd /c start` to
// pop a new console window — the user does the interactive menu/Playwright
// session there, the dashboard process stays clean.
const { spawn } = require('child_process');

function launchBatFile(batName) {
    const batPath = path.join(PROJECT_ROOT, 'routing', batName);
    if (!fs.existsSync(batPath)) throw new Error(`bat not found: ${batName}`);
    if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', batName.replace(/\.bat$/i, ''), 'cmd.exe', '/k', batPath], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
        }).unref();
    } else {
        spawn('bash', [batPath], { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, bat: batName };
}

function launchScript(kind, extraArgs = []) {
    const node = process.execPath; // current Node binary
    const TARGETS = {
        'menu':            { title: 'Autoreger Menu',         args: [path.join(PROJECT_ROOT, 'menu.js')] },
        'devin-autoreg':   { title: 'Devin Autoreger',        args: [path.join(PROJECT_ROOT, 'autoreger.js')] },
        // FreeModel: 10minutemail-based mass register (v3 — v2/emailnator deprecated)
        'freemodel-create':{ title: 'FreeModel Autoreg v3',   args: [path.join(PROJECT_ROOT, 'freemodel', 'freemodel_autoreger_v3.js')] },
        // FreeModel: single manual login (legacy, for restoring sessions)
        'freemodel-login': { title: 'FreeModel: Manual Login',args: [path.join(PROJECT_ROOT, 'freemodel', 'create_first_session.js')] },
        'notion-create':   { title: 'Notion: New Account',    args: [path.join(PROJECT_ROOT, 'notion', 'notion_workflow.js')] },
        // Conduit: автореги из ТГ (gramjs device-code) + ручное сохранение сессии
        'conduit-create':  { title: 'Conduit Autoreg',        args: [path.join(PROJECT_ROOT, 'conduit', 'conduit_autoreger.js')] },
        'conduit-login':   { title: 'Conduit: Save Session',  args: [path.join(PROJECT_ROOT, 'conduit', 'record_conduit.js')] },
        'tokenrouter-create': { title: 'TokenRouter Autoreg', cmd: 'python', args: [path.join(PROJECT_ROOT, 'routing', 'tokenrouter', 'camoufox_autoreg.py')] },
    };
    const t = TARGETS[kind];
    if (!t) throw new Error(`unknown launch kind: ${kind}`);

    // Safety: позитивный целочисленный count / FRE-инвайт только, выкидываем мусор
    const safeExtra = (Array.isArray(extraArgs) ? extraArgs : [])
        .map(a => String(a))
        .filter(a => /^(\d{1,3}|FRE-[A-Za-z0-9]+|ref_[A-Za-z0-9]+)$/.test(a))
        .slice(0, 4);

    const finalArgs = [...t.args, ...safeExtra];

    const exe = t.cmd || node;
    if (process.platform === 'win32') {
        // cmd /c start "" cmd /k "<exe> <script> [args...]"
        spawn('cmd.exe', ['/c', 'start', t.title, 'cmd.exe', '/k', exe, ...finalArgs], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
        }).unref();
    } else {
        spawn(exe, finalArgs, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, kind, args: finalArgs };
}

const TR_HEALTH_CACHE = path.join(PROJECT_ROOT, 'logs', '.tokenrouter_health.json');

function loadTrHealthCache() {
    try { return fs.existsSync(TR_HEALTH_CACHE) ? JSON.parse(fs.readFileSync(TR_HEALTH_CACHE, 'utf-8')) : {}; }
    catch { return {}; }
}
function saveTrHealthCache(cache) {
    try { fs.writeFileSync(TR_HEALTH_CACHE, JSON.stringify(cache, null, 2), 'utf-8'); } catch {}
}

function getCachedTrHealth(email) {
    const cache = loadTrHealthCache();
    return cache[email] || null;
}

const TR_USAGE_CACHE = path.join(PROJECT_ROOT, 'logs', '.tokenrouter_usage.json');
const TR_DAILY_BUDGET = 1.0; // $1 в сутки по словам пользователя

function loadTrUsageCache() {
    try { return fs.existsSync(TR_USAGE_CACHE) ? JSON.parse(fs.readFileSync(TR_USAGE_CACHE, 'utf-8')) : {}; }
    catch { return {}; }
}
function saveTrUsageCache(cache) {
    try { fs.writeFileSync(TR_USAGE_CACHE, JSON.stringify(cache, null, 2), 'utf-8'); } catch {}
}

function getCachedTrUsage(email) {
    return loadTrUsageCache()[email] || null;
}

const FM_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'fm-active-key.txt');

function getActiveFreemodelKey() {
    try {
        if (fs.existsSync(FM_ACTIVE_KEY_FILE)) {
            return fs.readFileSync(FM_ACTIVE_KEY_FILE, 'utf-8').trim();
        }
    } catch {}
    return null;
}

async function checkTokenrouterUsage(apiKey, email) {
    const https = require('https');
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'tokenrouter.me', port: 443, method: 'GET', path: '/v1/usage',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let result;
                try {
                    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
                    const j = JSON.parse(data);
                    const today = j?.usage?.today || {};
                    const todayCost = parseFloat(today.actual_cost || today.cost || 0);
                    const totalCost = parseFloat(j?.usage?.total?.actual_cost || j?.usage?.total?.cost || 0);
                    const remaining = Math.max(0, TR_DAILY_BUDGET - todayCost);
                    result = {
                        ok: true,
                        isValid: !!j.isValid,
                        mode: j.mode || '-',
                        planName: j.planName || '-',
                        unit: j.unit || 'USD',
                        todayCost,
                        totalCost,
                        dailyBudget: TR_DAILY_BUDGET,
                        remaining,
                        requests: today.requests || 0,
                    };
                } catch (e) {
                    result = { ok: false, error: e.message };
                }
                if (email) {
                    const cache = loadTrUsageCache();
                    cache[email] = { ...result, checkedAt: Date.now() };
                    saveTrUsageCache(cache);
                }
                resolve(result);
            });
        });
        req.on('error', (err) => {
            const result = { ok: false, error: err.message };
            if (email) {
                const cache = loadTrUsageCache();
                cache[email] = { ...result, checkedAt: Date.now() };
                saveTrUsageCache(cache);
            }
            resolve(result);
        });
        req.on('timeout', () => {
            req.destroy();
            const result = { ok: false, error: 'timeout' };
            if (email) {
                const cache = loadTrUsageCache();
                cache[email] = { ...result, checkedAt: Date.now() };
                saveTrUsageCache(cache);
            }
            resolve(result);
        });
        req.end();
    });
}

async function checkTokenrouterKey(apiKey, email) {
    const https = require('https');
    const checkBody = JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
    });

    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'tokenrouter.me', port: 443, method: 'POST', path: '/v1/messages',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'anthropic-version': '2023-06-01',
            },
            timeout: 15000,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve({ ok: true, status: 200 });
                    return;
                }
                let errMsg = `HTTP ${res.statusCode}`;
                let alive = false;
                try {
                    const j = JSON.parse(data);
                    if (j?.error?.message) {
                        errMsg = j.error.message;
                        // "group does not allow" = key valid, plan restricted
                        if (/group|plan|allow|dispatch/i.test(errMsg) && !/invalid|unauthorized|denied|key/i.test(errMsg)) {
                            alive = true;
                        }
                    } else if (j?.error?.type) {
                        errMsg = j.error.type;
                    }
                } catch {}
                let result;
                if (res.statusCode === 401) {
                    result = { ok: false, status: 401, error: 'ключ отклонён (expired/dead)' };
                } else if (alive) {
                    result = { ok: true, status: res.statusCode, note: errMsg.substring(0, 100) };
                } else {
                    result = { ok: false, status: res.statusCode, error: errMsg.substring(0, 150) };
                }
                if (email) {
                    const cache = loadTrHealthCache();
                    cache[email] = { ...result, checkedAt: Date.now() };
                    saveTrHealthCache(cache);
                }
                resolve(result);
            });
        });
        req.on('error', (err) => {
            const result = { ok: false, status: 0, error: err.code === 'ENOTFOUND' ? 'tokenrouter.me недоступен' : err.message };
            if (email) {
                const cache = loadTrHealthCache();
                cache[email] = { ...result, checkedAt: Date.now() };
                saveTrHealthCache(cache);
            }
            resolve(result);
        });
        req.on('timeout', () => {
            req.destroy();
            const result = { ok: false, status: 0, error: 'timeout' };
            if (email) {
                const cache = loadTrHealthCache();
                cache[email] = { ...result, checkedAt: Date.now() };
                saveTrHealthCache(cache);
            }
            resolve(result);
        });
        req.write(checkBody);
        req.end();
    });
}

function openTokenrouterSession(email) {
    const path = require('path');
    const { spawn } = require('child_process');
    // Открываем в Camoufox (как регали), не в Playwright-chromium: тот же
    // движок/фингерпринт, плюс авто-логин сохранёнными кредами в --open режиме
    // (session.json не годится — токен протухает, формат не storageState).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) {
        return { ok: false, error: 'bad email' };
    }
    const script = path.join(PROJECT_ROOT, 'routing', 'tokenrouter', 'camoufox_autoreg.py');
    const args = [script, '--open', email];
    if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', `TokenRouter ${email}`, 'cmd.exe', '/k', 'python', ...args], {
            cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', windowsHide: false,
        }).unref();
    } else {
        spawn('python', args, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
}

// ───── Conduit sessions + cached quotas/balance ────────────────────
// Conduit (conduit.ozdoev.net) — Anthropic-совместимый endpoint, ключи sk-cdt-.
// В отличие от FreeModel, квоты читаются дешёвым cookie-fetch (conduit-manager),
// не Playwright → refresh быстрый, concurrency выше.
let _conduit = null;
function conduitMod() {
    if (!_conduit) _conduit = require('../conduit/lib/conduit-manager');
    return _conduit;
}

const CONDUIT_QUOTA_CACHE = path.join(PROJECT_ROOT, 'logs', '.conduit_quota_cache.json');
const CONDUIT_META_FILE   = path.join(PROJECT_ROOT, 'logs', '.conduit_meta.json');

function loadConduitQuotaCache() {
    try { if (fs.existsSync(CONDUIT_QUOTA_CACHE)) return JSON.parse(fs.readFileSync(CONDUIT_QUOTA_CACHE, 'utf-8')) || {}; } catch {}
    return {};
}
function saveConduitQuotaCache(cache) {
    try { fs.mkdirSync(path.dirname(CONDUIT_QUOTA_CACHE), { recursive: true }); fs.writeFileSync(CONDUIT_QUOTA_CACHE, JSON.stringify(cache, null, 2), 'utf-8'); } catch {}
}
function loadConduitMeta() {
    try { if (fs.existsSync(CONDUIT_META_FILE)) return JSON.parse(fs.readFileSync(CONDUIT_META_FILE, 'utf-8')) || {}; } catch {}
    return {};
}
function saveConduitMeta(meta) {
    try { fs.mkdirSync(path.dirname(CONDUIT_META_FILE), { recursive: true }); fs.writeFileSync(CONDUIT_META_FILE, JSON.stringify(meta, null, 2), 'utf-8'); } catch {}
}

function setConduitBanned(name, banned) {
    const meta = loadConduitMeta();
    meta[name] = meta[name] || {};
    if (banned) { meta[name].banned = true; meta[name].bannedAt = new Date().toISOString(); }
    else { delete meta[name].banned; delete meta[name].bannedAt; }
    saveConduitMeta(meta);
    return meta[name];
}
function setConduitApiKey(name, apiKey) {
    const meta = loadConduitMeta();
    meta[name] = meta[name] || {};
    if (apiKey) meta[name].apiKey = String(apiKey); else delete meta[name].apiKey;
    saveConduitMeta(meta);
    return meta[name];
}

// withQuotas: 'cache' (мгновенно) | 'refresh' (fetch, обновить кеш) | false (только список)
async function listConduitSessions({ withQuotas = 'cache', concurrency = 6 } = {}) {
    const { getConduitAccounts, checkConduitQuota } = conduitMod();
    const sessions = getConduitAccounts();
    const meta = loadConduitMeta();
    const withMeta = (s, extra) => ({ ...s, ...extra, meta: meta[s.name] || {} });
    if (withQuotas === false) return sessions.map(s => withMeta(s, { quota: null }));

    const cache = loadConduitQuotaCache();
    if (withQuotas === 'cache') return sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));

    // refresh — пропускаем banned
    const eligible = sessions.filter(s => !(meta[s.name] || {}).banned);
    const out = sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, eligible.length || 1) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= eligible.length) return;
            try {
                const q = await checkConduitQuota(eligible[i]);
                if (q) {
                    const origIdx = sessions.indexOf(eligible[i]);
                    const val = { ...q, updatedAt: Date.now() };
                    if (origIdx >= 0) out[origIdx].quota = val;
                    cache[eligible[i].name] = val;
                    // мёртвую сессию помечаем в мете (UI покажет 💀)
                    if (q.dead) setConduitBanned(eligible[i].name, true);
                    else if (q.apiKey) { meta[eligible[i].name] = meta[eligible[i].name] || {}; meta[eligible[i].name].apiKey = q.apiKey; }
                }
            } catch { /* keep cached */ }
        }
    });
    await Promise.all(workers);
    saveConduitQuotaCache(cache);
    saveConduitMeta(meta);
    return out;
}

async function refreshOneConduitQuota(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getConduitAccounts, checkConduitQuota } = conduitMod();
    const account = getConduitAccounts().find(s => s.name === name);
    if (!account) throw new Error(`conduit account not found: ${name}`);
    const q = await checkConduitQuota(account);
    const cache = loadConduitQuotaCache();
    if (q) { cache[name] = { ...q, updatedAt: Date.now() }; saveConduitQuotaCache(cache); }
    return cache[name] || null;
}

async function extractConduitApiKey(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getConduitAccounts, extractConduitApiKey: extractKey } = conduitMod();
    const account = getConduitAccounts().find(s => s.name === name);
    if (!account) throw new Error(`conduit account not found: ${name}`);
    return await extractKey(account);
}

const CDT_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'cdt-active-key.txt');
function getActiveConduitKey() {
    try { if (fs.existsSync(CDT_ACTIVE_KEY_FILE)) return fs.readFileSync(CDT_ACTIVE_KEY_FILE, 'utf-8').trim(); } catch {}
    return null;
}

module.exports = {
    listNotionSessions,
    listFreemodelSessions,
    listConduitSessions,
    refreshOneConduitQuota,
    extractConduitApiKey,
    setConduitBanned,
    setConduitApiKey,
    getActiveConduitKey,
    loadConduitMeta,
    listDevinSessions,
    listOmniAccountsWithQuotas,
    toggleOmniAccount,
    openSessionInBrowser,
    refreshOneFreemodelQuota,
    refreshOneDevinQuota,
    deleteSession,
    getNotionCards,
    setNotionCardIndex,
    launchScript,
    launchBatFile,
    sqliteJson,
    setFreemodelBanned,
    setFreemodelTgPhone,
    setFreemodelApiKey,
    extractFreemodelApiKey,
    checkTokenrouterKey,
    checkTokenrouterUsage,
    getCachedTrUsage,
    getActiveFreemodelKey,
    openTokenrouterSession,
    loadFreemodelMeta,
};


