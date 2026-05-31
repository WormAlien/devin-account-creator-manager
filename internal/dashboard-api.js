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

// withQuotas behavior:
//   'cache'   — return cached quotas only (instant, no Playwright)
//   'refresh' — refresh via Playwright in parallel, update cache, return new values
//   false     — no quota info at all (fastest, list only)
async function listFreemodelSessions({ withQuotas = 'cache', concurrency = 3 } = {}) {
    const { getFreemodelSessions, checkFreemodelQuota } = freemodelMod();
    const sessions = getFreemodelSessions();
    if (withQuotas === false) return sessions.map(s => ({ ...s, quota: null }));

    const cache = loadFreemodelQuotaCache();

    if (withQuotas === 'cache') {
        return sessions.map(s => ({ ...s, quota: cache[s.name] || null }));
    }

    // refresh
    const out = sessions.map(s => ({ ...s, quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, sessions.length) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= sessions.length) return;
            try {
                const q = await checkFreemodelQuota(sessions[i]);
                if (q) {
                    out[i].quota = { ...q, updatedAt: Date.now() };
                    cache[sessions[i].name] = out[i].quota;
                }
            } catch { /* keep cached value */ }
        }
    });
    await Promise.all(workers);
    saveFreemodelQuotaCache(cache);
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
        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext({ storageState: path.join(dir, 'session.json') });
        const page = await context.newPage();
        await page.goto('https://www.notion.so/', { waitUntil: 'domcontentloaded' }).catch(() => {});
        return { ok: true, kind, name, url: 'https://www.notion.so/' };
    }
    if (kind === 'freemodel') {
        const dir = path.join(PROJECT_ROOT, 'manual_sessions', name);
        if (!fs.existsSync(dir)) throw new Error(`freemodel session not found: ${name}`);
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext({ storageState: path.join(dir, 'session.json') });
        const page = await context.newPage();
        await page.goto('https://claude.ai/dashboard/usage', { waitUntil: 'domcontentloaded' }).catch(() => {});
        return { ok: true, kind, name, url: 'https://claude.ai/dashboard/usage' };
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
        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext({ storageState: path.join(session.path, 'session.json') });
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
        dir = path.join(PROJECT_ROOT, 'manual_sessions', name);
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

function launchScript(kind) {
    const node = process.execPath; // current Node binary
    const TARGETS = {
        'menu':            { title: 'Autoreger Menu',         args: [path.join(PROJECT_ROOT, 'menu.js')] },
        'devin-autoreg':   { title: 'Devin Autoreger',        args: [path.join(PROJECT_ROOT, 'autoreger.js')] },
        'freemodel-create':{ title: 'FreeModel: New Session', args: [path.join(PROJECT_ROOT, 'freemodel', 'create_first_session.js')] },
        'notion-create':   { title: 'Notion: New Account',    args: [path.join(PROJECT_ROOT, 'notion', 'notion_workflow.js')] },
    };
    const t = TARGETS[kind];
    if (!t) throw new Error(`unknown launch kind: ${kind}`);

    if (process.platform === 'win32') {
        // cmd /c start "" cmd /k "node <script>"
        //   "" — empty window title placeholder (start treats first quoted arg as title)
        //   /k — keep the window open after the script exits so user sees output
        spawn('cmd.exe', ['/c', 'start', t.title, 'cmd.exe', '/k', node, ...t.args], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
        }).unref();
    } else {
        // Non-Windows fallback: just spawn detached
        spawn(node, t.args, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, kind, args: t.args };
}

module.exports = {
    listNotionSessions,
    listFreemodelSessions,
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
    sqliteJson,
};


