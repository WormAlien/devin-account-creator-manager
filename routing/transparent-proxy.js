// Switcher panel for Claude Code's settings.json.
//
// Why not a request proxy: CC's auth handshake doesn't tolerate header-swapping
// mid-flight ("Not logged in" errors). The clean way is to flip BASE_URL + KEY
// in settings.json so CC talks to the chosen backend directly (as upstream
// author of notion-abuz_ai documents).
//
// Each click writes settings.json (with timestamped .bak) and tells the user to
// restart Claude Code.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ---- Load routing/.env (gitignored real keys) ------------------------------
// Tiny inline parser — no dotenv dep required.
function loadEnv(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m || line.trimStart().startsWith('#')) continue;
            if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch {}
}
loadEnv(path.join(__dirname, '.env'));

const OMNIROUTE_KEY = process.env.OMNIROUTE_API_KEY || 'sk-local-dev-key';
const NOTION_KEY    = process.env.NOTION_API_KEY    || 'sk-local-dev-key';

const LISTEN_PORT = 8200;
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const STATE_FILE = path.join(__dirname, 'proxy-target.json');

// For /__switch/api/whoami — look up OmniRoute provider_connections by id prefix.
const OMNI_DB = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const SQLITE_EXE = process.env.SQLITE3
    || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe');

const BACKENDS = {
    omniroute: {
        label: 'FreeModel (OmniRoute)',
        base_url: 'http://localhost:20128/v1',
        api_key: OMNIROUTE_KEY,
        model: 'ComboWombo',
        // Main backend: full tools, long contexts, vision.
    },
    notion: {
        label: 'Notion (cheap)',
        base_url: 'http://localhost:8190',
        api_key: NOTION_KEY,
        model: 'opus-4.8',
        // Cheap backend: short tasks without heavy tools.
    },
};

function logLine(s) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] ${s}`);
}

function readSettings() {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    // settings.json starts with UTF-8 BOM in some editors вЂ” strip it
    return JSON.parse(raw.replace(/^п»ї/, ''));
}

function writeSettings(obj) {
    // timestamped backup before every write
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = SETTINGS_FILE + '.bak-' + stamp;
    fs.copyFileSync(SETTINGS_FILE, bakPath);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 4) + '\n', 'utf8');
    logLine(`settings.json written, backup at ${path.basename(bakPath)}`);
}

// Figure out which backend matches the URL/key currently in settings.json
function currentTarget() {
    try {
        const s = readSettings();
        const url = (s.env && s.env.ANTHROPIC_BASE_URL) || '';
        for (const [name, b] of Object.entries(BACKENDS)) {
            if (url === b.base_url) return name;
        }
        return 'unknown';
    } catch (e) {
        return 'error: ' + e.message;
    }
}

// Persisted state (informational; settings.json is the source of truth)
function saveState(target) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ target }, null, 2), 'utf8'); }
    catch (e) { logLine(`state file write failed: ${e.message}`); }
}

function applyTarget(target) {
    const backend = BACKENDS[target];
    if (!backend) throw new Error('Unknown target: ' + target);

    const settings = readSettings();
    settings.env = settings.env || {};
    settings.env.ANTHROPIC_BASE_URL = backend.base_url;
    settings.env.ANTHROPIC_API_KEY = backend.api_key;
    if (backend.model) settings.model = backend.model;
    writeSettings(settings);
    saveState(target);
    logLine(`switched to ${target} (${backend.label})`);
}

function jsonRes(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

// ---- /__switch/api/whoami --------------------------------------------------
// Body: { input: "<paste from OmniRoute log>" }
// Pulls all hex/dash chunks of length >= 8, looks each up in
// provider_connections by id prefix, returns matches.

function extractIdCandidates(input) {
    if (!input) return [];
    // Match hex sequences possibly separated by dashes, length >= 8.
    const matches = String(input).match(/[0-9a-f]{8}(?:-?[0-9a-f]+)*/gi) || [];
    const cleaned = new Set();
    for (const raw of matches) {
        // Take first 8 hex chars as prefix
        const hex = raw.replace(/-/g, '');
        if (hex.length >= 8) cleaned.add(hex.substring(0, 8).toLowerCase());
    }
    return Array.from(cleaned);
}

function querySqlite(sql) {
    if (!fs.existsSync(SQLITE_EXE)) {
        throw new Error(`sqlite3 not found at ${SQLITE_EXE} (set SQLITE3 env var)`);
    }
    if (!fs.existsSync(OMNI_DB)) {
        throw new Error(`OmniRoute db not found at ${OMNI_DB}`);
    }
    // Read-only copy of WAL-mode DB so live OmniRoute isn't blocked
    const tmp = path.join(os.tmpdir(), 'omni_whoami_proxy.sqlite');
    fs.copyFileSync(OMNI_DB, tmp);
    for (const ext of ['-wal', '-shm']) {
        try { fs.copyFileSync(OMNI_DB + ext, tmp + ext); } catch {}
    }
    const out = execFileSync(SQLITE_EXE, [tmp, '-json', sql], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
    });
    return out ? JSON.parse(out) : [];
}

function lookupAccounts(prefixes) {
    if (!prefixes.length) return [];
    const orClauses = prefixes.map(p => `id LIKE '${p.replace(/'/g, '')}%'`).join(' OR ');
    const sql = `SELECT id, provider, auth_type, name, email, is_active, test_status,
                        error_code, last_error, rate_limited_until, last_used_at, created_at
                 FROM provider_connections
                 WHERE ${orClauses};`;
    return querySqlite(sql);
}

function listAllAccounts() {
    const sql = `SELECT id, provider, auth_type, name, email, is_active, test_status,
                        error_code, rate_limited_until, last_used_at, created_at
                 FROM provider_connections
                 ORDER BY is_active DESC, datetime(coalesce(last_used_at, created_at)) DESC;`;
    return querySqlite(sql);
}

function handleWhoami(req, res) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        try {
            const { input } = JSON.parse(body || '{}');
            const prefixes = extractIdCandidates(input);
            const matches = lookupAccounts(prefixes);
            jsonRes(res, 200, { prefixes, matches });
        } catch (e) {
            jsonRes(res, 400, { error: e.message });
        }
    });
}

function handleAccounts(res) {
    try {
        jsonRes(res, 200, { accounts: dashApi.listOmniAccountsWithQuotas() });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// ---- Notion / FreeModel sessions + OmniRoute toggle ----------------------
// All real work lives in internal/dashboard-api.js so the CLI menu and this
// HTTP server stay in sync.
const dashApi = require('../internal/dashboard-api');

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

function handleNotionSessions(res) {
    try {
        // Resolve relative to project root (we live in routing/, sessions in ../manual_sessions)
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            jsonRes(res, 200, { sessions: dashApi.listNotionSessions() });
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleFreemodelSessions(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const refresh = url.searchParams.get('refresh') === '1';
    const withQuotas = refresh ? 'refresh' : 'cache';
    try {
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const sessions = await dashApi.listFreemodelSessions({ withQuotas });
            jsonRes(res, 200, { sessions, refreshed: refresh });
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleDevinSessions(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const refresh = url.searchParams.get('refresh') === '1';
    const withQuotas = refresh ? 'refresh' : 'cache';
    try {
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const sessions = await dashApi.listDevinSessions({ withQuotas });
            jsonRes(res, 200, { sessions, refreshed: refresh });
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleOmniToggle(req, res) {
    try {
        const { id, active } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'missing id' });
        const row = dashApi.toggleOmniAccount(id, !!active);
        logLine(`omni toggle: ${id.substring(0,8)} -> ${active ? 'active' : 'inactive'}`);
        jsonRes(res, 200, { ok: true, account: row });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleSessionOpen(req, res) {
    try {
        const { kind, name } = await readJsonBody(req);
        if (!kind || !name) return jsonRes(res, 400, { error: 'missing kind/name' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const result = await dashApi.openSessionInBrowser(kind, name);
            logLine(`session open: ${kind}/${name}`);
            jsonRes(res, 200, result);
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleSessionRefreshQuota(req, res) {
    try {
        const { kind, name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'missing name' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            let q;
            if (kind === 'devin') {
                q = await dashApi.refreshOneDevinQuota(name);
            } else {
                q = await dashApi.refreshOneFreemodelQuota(name);
            }
            logLine(`refresh quota: ${kind || 'freemodel'}/${name}`);
            jsonRes(res, 200, { ok: true, name, quota: q });
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleSessionDelete(req, res) {
    try {
        const { kind, name } = await readJsonBody(req);
        if (!kind || !name) return jsonRes(res, 400, { error: 'missing kind/name' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const result = dashApi.deleteSession(kind, name);
            logLine(`session delete: ${kind}/${name}`);
            jsonRes(res, 200, result);
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

function handleNotionCards(res) {
    try {
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try { jsonRes(res, 200, dashApi.getNotionCards()); }
        finally { process.chdir(cwd); }
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleNotionCardSelect(req, res) {
    try {
        const { index } = await readJsonBody(req);
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const result = dashApi.setNotionCardIndex(index);
            logLine(`notion card -> index=${index}`);
            jsonRes(res, 200, result);
        } finally { process.chdir(cwd); }
    } catch (e) { jsonRes(res, 400, { error: e.message }); }
}

async function handleLaunch(req, res) {
    try {
        const { kind } = await readJsonBody(req);
        if (!kind) return jsonRes(res, 400, { error: 'missing kind' });
        const result = dashApi.launchScript(kind);
        logLine(`launch: ${kind}`);
        jsonRes(res, 200, result);
    } catch (e) { jsonRes(res, 400, { error: e.message }); }
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__switch/api/status') {
        return jsonRes(res, 200, {
            current: currentTarget(),
            backends: Object.fromEntries(
                Object.entries(BACKENDS).map(([k, v]) => [k, { label: v.label, base_url: v.base_url }])
            ),
            settings_file: SETTINGS_FILE,
        });
    }

    if (req.method === 'POST' && req.url === '/__switch/api/switch') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { target } = JSON.parse(body);
                if (!BACKENDS[target]) return jsonRes(res, 400, { error: 'Invalid target' });
                applyTarget(target);
                jsonRes(res, 200, { ok: true, target, restart_required: true });
            } catch (e) {
                jsonRes(res, 400, { error: e.message });
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/whoami') {
        return handleWhoami(req, res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/accounts') {
        return handleAccounts(res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/notion/sessions') {
        return handleNotionSessions(res);
    }

    if (req.method === 'GET' && req.url.startsWith('/__switch/api/freemodel/sessions')) {
        return handleFreemodelSessions(req, res);
    }

    if (req.method === 'GET' && req.url.startsWith('/__switch/api/devin/sessions')) {
        return handleDevinSessions(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/accounts/toggle') {
        return handleOmniToggle(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/session/open') {
        return handleSessionOpen(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/session/refresh-quota') {
        return handleSessionRefreshQuota(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/session/delete') {
        return handleSessionDelete(req, res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/notion/cards') {
        return handleNotionCards(res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/notion/card-select') {
        return handleNotionCardSelect(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/launch') {
        return handleLaunch(req, res);
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/__switch' || req.url === '/__switch/')) {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'proxy-dashboard.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        } catch (e) {
            res.writeHead(500); return res.end('Dashboard not found: ' + e.message);
        }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. UI: /__switch  API: /__switch/api/{status,switch}');
});

server.listen(LISTEN_PORT, () => {
    console.log(`Switcher panel on http://localhost:${LISTEN_PORT}/`);
    console.log(`  edits ${SETTINGS_FILE}`);
    console.log(`  current target: ${currentTarget()}`);
    console.log(`  backends: ${Object.keys(BACKENDS).join(', ')}`);
});

