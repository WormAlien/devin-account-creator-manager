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

// OmniRoute creds read LIVE from process.env — POST /__switch/api/env updates them
// without restarting the proxy. Never freeze into a startup const.
function omniBase() { return (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128').replace(/\/+$/, ''); }
function omniKey()  { return process.env.OMNIROUTE_API_KEY || 'sk-local-dev-key'; }
const NOTION_KEY    = process.env.NOTION_API_KEY    || 'sk-local-dev-key';

const ENV_FILE = path.join(__dirname, '.env');
function readEnvFile() {
    const out = {};
    try {
        for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
            if (line.trimStart().startsWith('#')) continue;
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch {}
    return out;
}
// Upsert keys into routing/.env (keep other lines/comments) + apply live to process.env.
function upsertEnvFile(updates) {
    let lines = [];
    try { lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/); } catch {}
    for (const [k, v] of Object.entries(updates)) {
        const re = new RegExp('^\\s*' + k + '\\s*=');
        const i = lines.findIndex(l => re.test(l) && !l.trimStart().startsWith('#'));
        if (i >= 0) lines[i] = `${k}=${v}`;
        else lines.push(`${k}=${v}`);
        process.env[k] = v;
    }
    fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
}

const LISTEN_PORT = 8200;
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const SETTINGS_BACKUP_DIR = path.join(os.homedir(), '.claude', 'settings-backups');
const BACKUP_NAME_RE = /^settings-[0-9A-Za-z._-]+\.json$/;
function listSettingsBackups() {
    try {
        return fs.readdirSync(SETTINGS_BACKUP_DIR)
            .filter(n => BACKUP_NAME_RE.test(n))
            .map(n => { const st = fs.statSync(path.join(SETTINGS_BACKUP_DIR, n)); return { name: n, size: st.size, mtime: st.mtimeMs }; })
            .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
}
function makeSettingsBackup(prefix = 'settings') {
    if (!fs.existsSync(SETTINGS_FILE)) throw new Error('settings.json не найден');
    fs.mkdirSync(SETTINGS_BACKUP_DIR, { recursive: true });
    const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.copyFileSync(SETTINGS_FILE, path.join(SETTINGS_BACKUP_DIR, name));
    return name;
}
const STATE_FILE = path.join(__dirname, 'proxy-target.json');
const TOKENROUTER_ACCOUNTS = path.join(__dirname, 'tokenrouter', 'accounts.json');

// For /__switch/api/whoami — look up OmniRoute provider_connections by id prefix.
const OMNI_DB = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const SQLITE_EXE = process.env.SQLITE3
    || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe');

const BACKENDS = {
    omniroute: {
        label: 'FreeModel (OmniRoute)',
        base_url: 'http://localhost:20128/v1',
        api_key: omniKey(),
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
    freemodel_rotator: {
        label: 'FreeModel Rotator',
        base_url: 'https://cc.freemodel.dev',
        api_key: '__rotator__',     // resolved dynamically from rotator API
        model: 'opus[1m]',
        // Direct cc.freemodel.dev — key managed by freemodel-rotator.js
    },
};

const LOG_BUFFER = [];
const LOG_BUFFER_MAX = 500;

function logLine(s) {
    const t = new Date().toISOString().substring(11, 23);
    const line = `[${t}] ${s}`;
    console.log(line);
    LOG_BUFFER.push(line);
    if (LOG_BUFFER.length > LOG_BUFFER_MAX) LOG_BUFFER.shift();
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

// Figure out which backend/config matches the URL/key currently in settings.json.
// apiKeyHelper → ApiHelper (FreeModel direct), direct API key → backend by URL.
function currentTarget() {
    try {
        const s = readSettings();
        const url = (s.env && s.env.ANTHROPIC_BASE_URL) || '';
        const helper = s.apiKeyHelper || '';
        if (helper.includes('fm-active-key.txt') || helper.includes('freemodel')) {
            return 'apihelper';
        }
        if (helper.includes('al-active-key.txt')) {
            return 'aerolink';
        }
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

async function applyTarget(target) {
    const backend = BACKENDS[target];
    if (!backend) throw new Error('Unknown target: ' + target);

    const settings = readSettings();
    settings.env = settings.env || {};
    settings.env.ANTHROPIC_BASE_URL = backend.base_url;

    let apiKey = backend.api_key;
    // For freemodel_rotator, fetch active key from rotator API
    if (target === 'freemodel_rotator') {
        try {
            apiKey = await new Promise((resolve, reject) => {
                const rotReq = http.request({
                    hostname: '127.0.0.1', port: 20126, path: '/__fmrot/api/active-key',
                    method: 'GET', timeout: 3000,
                }, (rotRes) => {
                    let b = '';
                    rotRes.on('data', c => b += c);
                    rotRes.on('end', () => {
                        try {
                            const data = JSON.parse(b);
                            if (data.apiKey) { resolve(data.apiKey); logLine(`rotator key: ${data.email} → ${data.apiKeyMask}`); }
                            else reject(new Error('No active key in rotator'));
                        } catch { reject(new Error('Invalid rotator response')); }
                    });
                });
                rotReq.on('error', (e) => reject(e));
                rotReq.end();
            });
        } catch (e) {
            logLine(`rotator key fetch failed: ${e.message}`);
            apiKey = '';
        }
    }

    settings.env.ANTHROPIC_API_KEY = apiKey;
    if (backend.model) settings.model = backend.model;
    writeSettings(settings);
    saveState(target);
    logLine(`switched to ${target} (${backend.label})`);
}

// Settings presets: GET current, POST apply a merged JSON patch.
function handleSettingsCurrent(res) {
    try {
        const s = readSettings();
        return jsonRes(res, 200, { settings: s });
    } catch (e) {
        return jsonRes(res, 500, { error: e.message });
    }
}

async function handleSettingsApply(req, res) {
    try {
        const { settings: patch } = await readJsonBody(req);
        if (!patch || typeof patch !== 'object') return jsonRes(res, 400, { error: 'settings object required' });
        const current = readSettings();
        // Shallow merge top-level fields; for env, merge one level deeper.
        const next = { ...current };
        for (const [k, v] of Object.entries(patch)) {
            if (k === 'env' && typeof v === 'object') {
                next.env = { ...current.env };
                for (const [ek, ev] of Object.entries(v)) {
                    if (ev === null) delete next.env[ek];   // null = drop key (e.g. clear shadowing ANTHROPIC_API_KEY)
                    else next.env[ek] = ev;
                }
            } else {
                next[k] = v;
            }
        }
        writeSettings(next);
        return jsonRes(res, 200, { ok: true, current: currentTarget() });
    } catch (e) {
        return jsonRes(res, 400, { error: e.message });
    }
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
const freemodelManager = require('../internal/freemodel-manager');

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

// ───── FreeModel auto-rotation (API Helper load balancer) ─────────────
// В режиме API Helper claude code на каждый запрос читает ключ из
// ~/.claude/fm-active-key.txt (TTL=0). Значит ротация = переписывать этот
// файл лучшим (наименее использованным) ключом. Перезапуск не нужен.
// Цель: равномерно размазать нагрузку по всем аккаунтам с самого начала
// (0%/1%), а не выкачивать один до потолка.
const FM_ACTIVE_KEY_FILE   = path.join(os.homedir(), '.claude', 'fm-active-key.txt');
const FM_AUTOROTATE_FILE   = path.join(__dirname, '..', 'logs', '.freemodel_autorotate.json');

const fmAuto = {
    enabled: false,
    intervalMs: 90000,    // как часто переоцениваем
    ceiling: 0.70,        // жёсткий потолок used%: при достижении уступаем место
    hysteresis: 0.10,     // свич только если кандидат свободнее текущего на >10%
    quotaTtlMs: 5 * 60 * 1000, // не рефрешим квоту аккаунта чаще, чем раз в TTL (энергоэффективность)
    activeName: null,
    lastSwitch: 0,
    lastTickAt: 0,
    nextTickAt: 0,
    ticking: false,
    timer: null,
    recent: [],           // [{ts, from, to, email, reason, used}]
};

function fmParseDollars(s) {
    if (s == null) return null;
    const m = String(s).match(/[\d.,]+/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(',', ''));
    return isFinite(n) ? n : null;
}
// used% = среднее использования по окнам 5h и 7d (0..1). null если нет данных.
function fmUsedFraction(q) {
    if (!q) return null;
    const u5 = fmParseDollars(q.h5), m5 = fmParseDollars(q.h5max);
    const u7 = fmParseDollars(q.d7), m7 = fmParseDollars(q.d7max);
    const parts = [];
    if (u5 != null && m5 && m5 > 0) parts.push(u5 / m5);
    if (u7 != null && m7 && m7 > 0) parts.push(u7 / m7);
    if (!parts.length) return null;
    return parts.reduce((a, b) => a + b, 0) / parts.length;
}
function fmReadKeyFromInfo(s) {
    try {
        const f = path.join(s.path, 'account_info.txt');
        if (fs.existsSync(f)) {
            const m = fs.readFileSync(f, 'utf-8').match(/^API Key:\s*((?:fe[_-]|sk-)[A-Za-z0-9_-]{20,})/m);
            if (m) return m[1];
        }
    } catch {}
    return null;
}
// Пригодные кандидаты: статус ✅, не banned, есть валидный ключ.
async function fmGetUsable() {
    const sessions = await dashApi.listFreemodelSessions({ withQuotas: 'cache' });
    const out = [];
    for (const s of sessions) {
        if (s.status !== '✅' || s.meta?.banned) continue;
        const key = s.meta?.apiKey || fmReadKeyFromInfo(s);
        if (!key) continue;
        out.push({
            name: s.name,
            email: s.email || s.name,
            key,
            used: fmUsedFraction(s.quota),
            quotaAt: s.quota?.updatedAt || 0,   // для TTL-проверки свежести кэша
        });
    }
    return out;
}
// Кэш квоты протух? (нет данных или старше TTL)
function fmStale(entry, ttlMs) {
    return !entry || !entry.quotaAt || (Date.now() - entry.quotaAt) > ttlMs;
}
// Кто реально активен по версии Claude Code: владелец ключа из fm-active-key.txt.
// Это источник правды — на него и должен смотреть ротатор, иначе мониторит чужой акк.
function fmActiveFromFile(usable) {
    try {
        const key = fs.readFileSync(FM_ACTIVE_KEY_FILE, 'utf-8').trim();
        if (!key) return null;
        return usable.find(s => s.key === key) || null;
    } catch { return null; }
}
// Для сортировки неизвестную квоту трактуем как 0 (свежий аккаунт = полный запас),
// чтобы новые аккаунты пробовались первыми, а затем рефрешились.
const fmUsedSort = s => (s.used == null ? 0 : s.used);

function fmWriteActiveKey(key) {
    try {
        fs.writeFileSync(FM_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        return true;
    } catch (e) {
        logLine(`fm auto: write key failed: ${e.message}`);
        return false;
    }
}
// Гарантируем helper-режим в settings.json (как кнопка «Активировать» с mode=helper).
function fmEnsureHelperMode() {
    try {
        const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
        const raw = fs.readFileSync(settingsFile, 'utf-8');
        const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const want = 'cat ~/.claude/fm-active-key.txt';
        const already = settings.apiKeyHelper === want
            && settings.env?.ANTHROPIC_BASE_URL === 'https://cc.freemodel.dev'
            && !settings.env?.ANTHROPIC_API_KEY;
        if (already) return { changed: false };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(settingsFile, settingsFile + '.bak-fmauto-' + stamp);
        settings.env = settings.env || {};
        settings.env.ANTHROPIC_BASE_URL = 'https://cc.freemodel.dev';
        settings.apiKeyHelper = want;
        settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
        delete settings.env.ANTHROPIC_API_KEY;  // direct key would shadow the helper
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
        logLine('fm auto: settings.json → API Helper mode');
        return { changed: true };
    } catch (e) {
        return { changed: false, error: e.message };
    }
}

async function fmAutoTick() {
    if (fmAuto.ticking) return;
    fmAuto.ticking = true;
    fmAuto.lastTickAt = Date.now();
    const cwd = process.cwd();
    try {
        process.chdir(path.join(__dirname, '..'));

        let usable = await fmGetUsable();
        if (!usable.length) { logLine('fm auto: нет пригодных аккаунтов'); return; }

        // (A) РЕКОНСИЛЯЦИЯ: активный = владелец ключа из fm-active-key.txt (источник
        // правды). Без этого persist-activeName расходится с реальностью, и ротатор
        // мониторит чужой простаивающий аккаунт, не видя нагрузку на рабочем.
        const fileActive = fmActiveFromFile(usable);
        if (fileActive && fileActive.name !== fmAuto.activeName) {
            logLine(`fm auto: реконсиляция активного → ${fileActive.email} (из fm-active-key.txt)`);
            fmAuto.activeName = fileActive.name;
            fmAutoSavePersist();
        }

        // (B) Рефреш ТОЛЬКО активного и только если кэш протух (энергоэффективно —
        // один Chrome максимум за тик, обычно ноль).
        let active = usable.find(s => s.name === fmAuto.activeName) || null;
        if (active && fmStale(active, fmAuto.quotaTtlMs)) {
            try { await dashApi.refreshOneFreemodelQuota(active.name); } catch {}
            usable = await fmGetUsable();
            active = usable.find(s => s.name === fmAuto.activeName) || null;
        }

        // (C) Решение о свиче. Кандидатов ранжируем по КЭШУ (без массового скана).
        usable.sort((a, b) => fmUsedSort(a) - fmUsedSort(b));
        let target = null, reason = '';
        if (!active) {
            target = usable[0]; reason = 'no-active';            // активного нет — берём наименее использованного
        } else if (fmUsedSort(active) >= fmAuto.ceiling) {
            target = usable.find(s => s.name !== active.name) || null;  // упёрся в потолок — лучший кандидат
            reason = 'ceiling';
        }

        if (target) {
            // Перед свичем рефрешим ТОЛЬКО кандидата — подтверждаем, что он реально
            // свободен (и не дохлый), не сканируя весь пул.
            try { await dashApi.refreshOneFreemodelQuota(target.name); } catch {}
            const fresh = (await fmGetUsable()).find(s => s.name === target.name) || target;
            if (active && fmUsedSort(fresh) >= fmAuto.ceiling) {
                logLine(`fm auto: кандидат ${fresh.email} тоже у потолка (${Math.round(fmUsedSort(fresh)*100)}%) — свич отменён`);
            } else if (fmWriteActiveKey(fresh.key)) {
                const from = fmAuto.activeName;
                fmAuto.activeName = fresh.name;
                fmAuto.lastSwitch = Date.now();
                const usedPct = Math.round(fmUsedSort(fresh) * 100);
                fmAuto.recent.unshift({ ts: Date.now(), from, to: fresh.name, email: fresh.email, reason, used: usedPct });
                fmAuto.recent = fmAuto.recent.slice(0, 20);
                fmAutoSavePersist();
                logLine(`fm auto: ${reason} → ${fresh.email} (${usedPct}% used)`);
            }
        }
    } catch (e) {
        logLine(`fm auto tick error: ${e.message}`);
    } finally {
        try { process.chdir(cwd); } catch {}
        fmAuto.ticking = false;
    }
}

function fmAutoSchedule() {
    if (fmAuto.timer) clearTimeout(fmAuto.timer);
    fmAuto.nextTickAt = Date.now() + fmAuto.intervalMs;
    fmAuto.timer = setTimeout(async () => {
        await fmAutoTick();
        if (fmAuto.enabled) fmAutoSchedule();
    }, fmAuto.intervalMs);
}
function fmAutoStart(opts = {}) {
    if (typeof opts.intervalMs === 'number' && opts.intervalMs >= 15000) fmAuto.intervalMs = opts.intervalMs;
    if (typeof opts.ceiling === 'number' && opts.ceiling > 0 && opts.ceiling <= 1) fmAuto.ceiling = opts.ceiling;
    if (typeof opts.hysteresis === 'number' && opts.hysteresis >= 0 && opts.hysteresis < 0.5) fmAuto.hysteresis = opts.hysteresis;
    const helper = fmEnsureHelperMode();
    fmAuto.enabled = true;
    fmAutoSavePersist();
    // Немедленный тик, затем расписание.
    fmAutoTick().finally(() => { if (fmAuto.enabled) fmAutoSchedule(); });
    return { helper };
}
function fmAutoStop() {
    fmAuto.enabled = false;
    if (fmAuto.timer) { clearTimeout(fmAuto.timer); fmAuto.timer = null; }
    fmAuto.nextTickAt = 0;
    fmAutoSavePersist();
}
function fmAutoStatus() {
    return {
        enabled: fmAuto.enabled,
        intervalMs: fmAuto.intervalMs,
        ceiling: fmAuto.ceiling,
        hysteresis: fmAuto.hysteresis,
        activeName: fmAuto.activeName,
        lastSwitch: fmAuto.lastSwitch,
        lastTickAt: fmAuto.lastTickAt,
        nextTickAt: fmAuto.nextTickAt,
        ticking: fmAuto.ticking,
        recent: fmAuto.recent,
    };
}
function fmAutoSavePersist() {
    try {
        const dir = path.dirname(FM_AUTOROTATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(FM_AUTOROTATE_FILE, JSON.stringify({
            enabled: fmAuto.enabled, intervalMs: fmAuto.intervalMs,
            ceiling: fmAuto.ceiling, hysteresis: fmAuto.hysteresis, activeName: fmAuto.activeName,
        }, null, 2), 'utf-8');
    } catch {}
}
function fmAutoLoadPersist() {
    try {
        if (fs.existsSync(FM_AUTOROTATE_FILE)) {
            const j = JSON.parse(fs.readFileSync(FM_AUTOROTATE_FILE, 'utf-8'));
            if (typeof j.intervalMs === 'number') fmAuto.intervalMs = j.intervalMs;
            if (typeof j.ceiling === 'number') fmAuto.ceiling = j.ceiling;
            if (typeof j.hysteresis === 'number') fmAuto.hysteresis = j.hysteresis;
            if (j.activeName) fmAuto.activeName = j.activeName;
            return !!j.enabled;
        }
    } catch {}
    return false;
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

// Read freemodel referral chain: keys.txt + .last_invite + config.INITIAL_INVITE.
function handleFreemodelInvites(req, res) {
    try {
        const root = path.join(__dirname, '..');
        const keysFile = path.join(root, 'freemodel', 'keys.txt');
        const lastFile = path.join(root, 'freemodel', '.last_invite');
        const configFile = path.join(root, 'freemodel', 'config.js');

        const chain = [];
        if (fs.existsSync(keysFile)) {
            const raw = fs.readFileSync(keysFile, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim()) continue;
                const parts = line.split('|');
                const email = parts[0] || '';
                const code = parts[2] || '';
                if (/^FRE-[A-Za-z0-9]+$/.test(code)) {
                    chain.push({ email, code });
                }
            }
        }

        let last = null;
        if (fs.existsSync(lastFile)) {
            const v = fs.readFileSync(lastFile, 'utf8').trim();
            if (/^FRE-[A-Za-z0-9]+$/.test(v)) last = v;
        }

        let initial = null;
        try {
            // Clear require-cache so edits to config.js show up live.
            delete require.cache[require.resolve(configFile)];
            const cfg = require(configFile);
            if (/^FRE-[A-Za-z0-9]+$/.test(cfg.INITIAL_INVITE || '')) initial = cfg.INITIAL_INVITE;
        } catch {}

        jsonRes(res, 200, { last, initial, chain: chain.reverse() });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleFreemodelSetInvite(req, res) {
    try {
        const body = await readJsonBody(req);
        const code = (body.code || '').trim();
        if (!/^FRE-[A-Za-z0-9]+$/.test(code)) {
            return jsonRes(res, 400, { error: 'invalid code (expected FRE-xxx)' });
        }
        const lastFile = path.join(__dirname, '..', 'freemodel', '.last_invite');
        fs.writeFileSync(lastFile, code + '\n', 'utf8');
        jsonRes(res, 200, { ok: true, code });
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

// ---- /__switch/api/tg/* — пул Telegram-аккаунтов для freemodel-автореги -----
//
// Хранилище: freemodel/tg_pool.json. UI вкладка "Telegram" в proxy-dashboard.html.

const tgPool = require('../freemodel/lib/tg-pool');
const tgSessionParser = require('../freemodel/lib/tg-session-parser');
const fmTgBind = require('../freemodel/lib/fm-tg-bind');
const tgHealth = require('../freemodel/lib/tg-health');

function handleTgList(res) {
    try {
        const arr = tgPool.list();
        const health = tgHealth.loadCache();
        // Маскируем auth_key для UI — полный ключ из дашборда никогда не отдаём.
        const safe = arr.map(e => ({
            phone: e.phone,
            dc_id: e.dc_id,
            user_id: e.user_id,
            auth_key_mask: tgPool.maskAuthKey(e.auth_key_hex),
            status: e.status,
            source: e.source || (e.isPlaceholderPhone ? 'hex' : 'session'),
            addedAt: e.addedAt,
            usedBy: e.usedBy || null,
            usedAt: e.usedAt || null,
            banReason: e.banReason || null,
            isPlaceholderPhone: !!e.isPlaceholderPhone,
            health: health[e.phone] || null,
        }));
        jsonRes(res, 200, { entries: safe, stats: tgPool.stats() });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// Безбанный health-чек: connect+getMe по каждому не-banned, результат в кэш.
async function handleTgHealthCheck(req, res) {
    try {
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        if (body && body.phone) {
            const r = await tgHealth.checkPhone(body.phone, msg => logLine(msg));
            logLine(`tg health: ${body.phone} → ${r.status}`);
            return jsonRes(res, 200, { ok: true, phone: body.phone, ...r });
        }
        logLine('tg health: проверка всех не-banned (connect+getMe)…');
        const summary = await tgHealth.checkAll(msg => logLine(msg));
        logLine(`tg health: alive=${summary.alive} dead=${summary.dead} error=${summary.error}`);
        jsonRes(res, 200, { ok: true, ...summary });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleTgAddHex(req, res) {
    try {
        const body = await readJsonBody(req);
        const { phone, dc_id, user_id, auth_key_hex } = body || {};
        const entry = tgPool.addHex({ phone, dc_id, user_id, auth_key_hex });
        logLine(`tg pool: + ${entry.phone} dc=${entry.dc_id}`);
        jsonRes(res, 200, { ok: true, phone: entry.phone });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Bulk import: текст со списком в свободном формате (phone|hex:dc / hex:dc / ...).
async function handleTgAddBulk(req, res) {
    try {
        const { text } = await readJsonBody(req);
        if (!text || typeof text !== 'string') return jsonRes(res, 400, { error: 'нет text' });
        const parsed = tgPool.parseBulk(text);
        const result = tgPool.addBulk(parsed.entries);
        logLine(`tg pool: bulk +${result.added.length} parseErr=${parsed.errors.length} dupes=${parsed.duplicates.length}`);
        jsonRes(res, 200, {
            ok: true,
            added: result.added,
            errors: [...parsed.errors, ...result.errors],
            duplicates: parsed.duplicates,
        });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Принимает .session-файл как base64 в JSON-теле (UI читает FileReader → base64).
async function handleTgAddSession(req, res) {
    try {
        const body = await readJsonBody(req);
        const { phone, base64 } = body || {};
        if (!phone) return jsonRes(res, 400, { error: 'phone обязателен' });
        if (!base64) return jsonRes(res, 400, { error: 'нет файла (base64)' });

        const buf = Buffer.from(base64, 'base64');
        const parsed = tgSessionParser.parseSessionBuffer(buf, phone);

        if (!parsed.user_id) {
            // user_id в .session может отсутствовать — это не критично для логина.
            // Но pool хочет user_id строго. Кладём заглушку, если совсем пусто.
            parsed.user_id = body.user_id || '0';
        }

        const entry = tgPool.addHex({
            phone,
            dc_id: parsed.dc_id,
            user_id: parsed.user_id,
            auth_key_hex: parsed.auth_key_hex,
            source: 'session',
        });
        logLine(`tg pool: + ${entry.phone} dc=${entry.dc_id} (.session)`);
        jsonRes(res, 200, { ok: true, phone: entry.phone, dc_id: entry.dc_id, user_id: entry.user_id });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleTgDelete(req, res) {
    try {
        const { phone } = await readJsonBody(req);
        if (!phone) return jsonRes(res, 400, { error: 'phone обязателен' });
        const ok = tgPool.remove(phone);
        if (!ok) return jsonRes(res, 404, { error: 'не найден' });
        logLine(`tg pool: − ${phone}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleTgMarkFree(req, res) {
    try {
        const { phone } = await readJsonBody(req);
        if (!phone) return jsonRes(res, 400, { error: 'phone обязателен' });
        const e = tgPool.markFree(phone);
        if (!e) return jsonRes(res, 404, { error: 'не найден' });
        logLine(`tg pool: ${phone} → free`);
        jsonRes(res, 200, { ok: true });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleTgRename(req, res) {
    try {
        const { phone, newPhone } = await readJsonBody(req);
        if (!phone || !newPhone) return jsonRes(res, 400, { error: 'phone и newPhone обязательны' });
        const e = tgPool.rename(phone, newPhone);
        logLine(`tg pool: rename ${phone} → ${e.phone}`);
        jsonRes(res, 200, { ok: true, phone: e.phone });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Открыть TG-сессию в отдельном портативном Telegram Desktop.
// auth_key_hex+dc_id -> tdata через tools/tg-open.py (venv py3.12 + opentele),
// затем launch Telegram.exe -workdir. Первый раз идёт в сеть (~5-10с),
// дальше tdata переиспользуется. AyuGram пользователя не трогаем.
const { spawn } = require('child_process');
const TG_VENV_PY = path.join(__dirname, '..', 'tools', 'tg-venv', 'Scripts', 'python.exe');
const TG_OPEN_PY = path.join(__dirname, '..', 'tools', 'tg-open.py');

async function handleTgOpen(req, res) {
    try {
        const { phone } = await readJsonBody(req);
        if (!phone) return jsonRes(res, 400, { error: 'phone обязателен' });
        if (!fs.existsSync(TG_VENV_PY)) {
            return jsonRes(res, 500, { error: 'нет tools/tg-venv — venv не создан' });
        }
        logLine(`tg open: ${phone} → конвертация + запуск`);
        const child = spawn(TG_VENV_PY, [TG_OPEN_PY, String(phone)], {
            cwd: path.join(__dirname, '..'),
            windowsHide: true,
        });
        let err = '';
        child.stderr.on('data', d => { err += d.toString(); });
        const code = await new Promise((resolve) => {
            const t = setTimeout(() => { try { child.kill(); } catch {} resolve(-1); }, 90_000);
            child.on('close', c => { clearTimeout(t); resolve(c); });
            child.on('error', e => { clearTimeout(t); err += e.message; resolve(-1); });
        });
        if (code !== 0) {
            const last = err.trim().split('\n').pop() || 'неизвестная ошибка';
            logLine(`tg open: ${phone} FAIL (${code}): ${last}`);
            return jsonRes(res, 500, { error: last });
        }
        logLine(`tg open: ${phone} → запущен`);
        jsonRes(res, 200, { ok: true });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// ---- /__switch/api/freemodel/ban: пометить freemodel-аккаунт как banned 💀 ----
async function handleFreemodelBan(req, res) {
    try {
        const { name, banned } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const m = dashApi.setFreemodelBanned(name, !!banned);
        logLine(`freemodel ban: ${name} → ${banned ? '💀' : 'unban'}`);
        jsonRes(res, 200, { ok: true, meta: m });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Ручное переключение TG-привязки. Принимает { name, tgPhone } —
// tgPhone=null/'' = отвязать, явный номер = привязать.
async function handleFreemodelSetTg(req, res) {
    try {
        const { name, tgPhone } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const cleanPhone = tgPhone ? String(tgPhone).replace(/^\+/, '').replace(/\s+/g, '') : null;
        if (cleanPhone && !/^(?:\d{6,18}|tg_[0-9a-f]+)$/.test(cleanPhone)) {
            return jsonRes(res, 400, { error: 'bad phone' });
        }
        const m = dashApi.setFreemodelTgPhone(name, cleanPhone);
        logLine(`freemodel tg: ${name} → ${cleanPhone || 'unlinked'}`);
        jsonRes(res, 200, { ok: true, meta: m });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Автоматическая привязка Telegram из пула к FreeModel-сессии.
// Берёт свободный TG-аккаунт (или указанный phone), шлёт /start <token> боту,
// ждёт verified и создаёт API-ключ.
async function handleFreemodelBindTelegram(req, res) {
    try {
        const { name, phone, headless } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        let result;
        try {
            const sessions = freemodelManager.getFreemodelSessions();
            const session = sessions.find(s => s.name === name);
            if (!session) {
                process.chdir(cwd);
                return jsonRes(res, 404, { error: 'session not found' });
            }
            logLine(`freemodel bind-telegram: ${name} ${phone ? 'phone=' + phone : 'auto'}`);
            result = await fmTgBind.bindTelegram(session.path, phone, {
                headless: headless !== false,
                log: (msg) => logLine(msg),
            });
        } finally {
            process.chdir(cwd);
        }
        if (!result.ok) {
            logLine(`freemodel bind-telegram failed: ${result.error}`);
            return jsonRes(res, 500, { ok: false, error: result.error, tgPhone: result.tgPhone });
        }
        logLine(`freemodel bind-telegram ok: ${name} tg=${result.tgPhone} key=${result.apiKey ? '***' + result.apiKey.slice(-6) : 'none'}`);
        jsonRes(res, 200, { ok: true, tgPhone: result.tgPhone, apiKey: result.apiKey });
    } catch (e) {
        logLine(`freemodel bind-telegram error: ${e.message}`);
        jsonRes(res, 500, { ok: false, error: e.message });
    }
}

// Ручное проставление API-ключа (например, юзер скопировал руками).
async function handleFreemodelSetKey(req, res) {
    try {
        const { name, apiKey } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const key = apiKey ? String(apiKey).trim() : null;
        if (key && !/^(?:fe[_-]|sk-)[A-Za-z0-9_-]{20,}$/.test(key)) {
            return jsonRes(res, 400, { error: 'формат ключа: fe_... или sk-...' });
        }
        const m = dashApi.setFreemodelApiKey(name, key);
        logLine(`freemodel key: ${name} → ${key ? '***' + key.slice(-6) : 'cleared'}`);
        jsonRes(res, 200, { ok: true, meta: m });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleFreemodelActivate(req, res) {
    try {
        const { name, mode } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name required' });
        const helperMode = mode === 'helper';
        const keyFile = path.join(os.homedir(), '.claude', 'fm-active-key.txt');
        const meta = dashApi.loadFreemodelMeta();
        let apiKey = meta[name]?.apiKey;
        if (!apiKey) {
            const fm = require('../internal/freemodel-manager');
            const cwd = process.cwd();
            process.chdir(path.join(__dirname, '..'));
            try {
                const s = fm.getFreemodelSessions().find(x => x.name === name);
                if (s) {
                    const infoFile = path.join(s.path, 'account_info.txt');
                    if (fs.existsSync(infoFile)) {
                        const m = fs.readFileSync(infoFile, 'utf-8').match(/^API Key:\s*((?:fe[_-]|sk-)[A-Za-z0-9_-]{20,})/m);
                        if (m) apiKey = m[1];
                    }
                }
            } finally { process.chdir(cwd); }
        }
        if (!apiKey) return jsonRes(res, 400, { error: 'no API key found' });
        fs.writeFileSync(keyFile, apiKey, { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
            const raw = fs.readFileSync(settingsFile, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const bakPath = settingsFile + '.bak-fm-' + stamp;
            fs.copyFileSync(settingsFile, bakPath);
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = 'https://cc.freemodel.dev';
            if (helperMode) {
                settings.apiKeyHelper = 'cat ~/.claude/fm-active-key.txt';
                settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
                delete settings.env.ANTHROPIC_API_KEY;   // helper drives auth; direct key would shadow it
            } else {
                settings.apiKeyHelper = '';
                settings.env.ANTHROPIC_API_KEY = apiKey;
            }
            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
            settingsOk = true;
            logLine(`fm activate: wrote ${helperMode ? 'apiKeyHelper' : 'direct key'} to settings.json`);
        } catch (e) {
            logLine(`fm activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`fm activate: ${name} → ${apiKey.substring(0, 8)}...`);
        jsonRes(res, 200, { ok: true, name, mode: helperMode ? 'helper' : 'direct', mask: apiKey.substring(0, 8) + '...' + apiKey.slice(-6), settingsUpdated: settingsOk });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleFreemodelExtractKey(req, res) {
    try {
        const { name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const result = await dashApi.extractFreemodelApiKey(name);
            if (result.ok) {
                logLine(`freemodel extract-key: ${name} → ${result.apiKey ? result.apiKey.substring(0, 12) + '...' : 'none'} (${result.source})`);
            } else {
                logLine(`freemodel extract-key: ${name} → FAIL: ${result.error}`);
            }
            jsonRes(res, result.ok ? 200 : 400, result);
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 500, { ok: false, error: e.message });
    }
}

async function handleLaunch(req, res) {
    try {
        const body = await readJsonBody(req);
        const { kind, args } = body || {};
        if (!kind) return jsonRes(res, 400, { error: 'missing kind' });
        const result = dashApi.launchScript(kind, Array.isArray(args) ? args : []);
        logLine(`launch: ${kind}${result.args && result.args.length > 1 ? ' args=' + result.args.slice(1).join(' ') : ''}`);
        jsonRes(res, 200, result);
    } catch (e) { jsonRes(res, 400, { error: e.message }); }
}

async function handleLaunchBat(req, res) {
    try {
        const { bat } = await readJsonBody(req);
        if (!bat) return jsonRes(res, 400, { error: 'missing bat' });
        const result = dashApi.launchBatFile(bat);
        logLine(`launch bat: ${bat}`);
        jsonRes(res, 200, result);
    } catch (e) { jsonRes(res, 400, { error: e.message }); }
}

// ───── Aerolink (al) — ручной пул email+ключ, активация через API Helper ─────
const AL_SESSIONS_FILE = path.join(__dirname, 'al-sessions.json');
const AL_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'al-active-key.txt');
const AL_BASE_URL = 'https://capi.aerolink.lat';

function alLoad() {
    try {
        const raw = fs.readFileSync(AL_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function alSave(arr) {
    fs.writeFileSync(AL_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

// Пинг ключа: GET /v1/me → 401 = DEAD, иначе LIVE.
async function alProbe(apiKey) {
    try {
        const r = await fetch(`${AL_BASE_URL}/v1/me`, {
            method: 'GET',
            headers: { 'x-api-key': apiKey },
            signal: AbortSignal.timeout(12000),
        });
        return r.status === 401 ? 'dead' : 'live';
    } catch { return 'unknown'; }
}

async function handleAlSessions(req, res) {
    try {
        const probe = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('probe') === '1';
        const sessions = alLoad();
        if (probe) {
            await Promise.all(sessions.map(async s => { s.status = await alProbe(s.api_key); }));
        }
        jsonRes(res, 200, { sessions });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleAlAdd(req, res) {
    try {
        const { email, api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const mail = String(email || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'email и api_key обязательны' });
        const sessions = alLoad();
        if (sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        sessions.push({ email: mail, api_key: key, active: false });
        alSave(sessions);
        logLine(`aerolink add: ${mail} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleAlDelete(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const sessions = alLoad().filter(s => s.api_key !== key);
        alSave(sessions);
        logLine(`aerolink delete: ***${key.slice(-6)}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Клик по ключу → активный: пишем ключ в al-active-key.txt + apiKeyHelper в settings.json.
async function handleAlActivate(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        const sessions = alLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(AL_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        alSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-al');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = AL_BASE_URL + '/';
            settings.apiKeyHelper = 'cat ~/.claude/al-active-key.txt';
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            delete settings.env.ANTHROPIC_API_KEY;   // helper рулит авторизацией
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
            settingsOk = true;
        } catch (e) {
            logLine(`aerolink activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`aerolink activate: ${target.email} → ***${key.slice(-6)} (helper)`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
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

    if (req.method === 'GET' && req.url.startsWith('/__switch/api/logs')) {
        const limit = parseInt(new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('limit') || '200', 10);
        return jsonRes(res, 200, { lines: LOG_BUFFER.slice(-Math.max(1, limit)) });
    }

    if (req.method === 'POST' && req.url === '/__switch/api/switch') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { target } = JSON.parse(body);
                if (!BACKENDS[target]) return jsonRes(res, 400, { error: 'Invalid target' });
                await applyTarget(target);
                jsonRes(res, 200, { ok: true, target, restart_required: true });
            } catch (e) {
                jsonRes(res, 400, { error: e.message });
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/__switch/api/settings/current') {
        return handleSettingsCurrent(res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/settings/apply') {
        return handleSettingsApply(req, res);
    }

    // Полная перезапись settings.json (ручной JSON-редактор). Бэкап перед записью.
    if (req.method === 'POST' && req.url === '/__switch/api/settings/save') {
        (async () => {
            try {
                const { settings } = await readJsonBody(req);
                if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
                    return jsonRes(res, 400, { error: 'settings должен быть JSON-объектом' });
                }
                const bak = makeSettingsBackup('settings-preedit');
                writeSettings(settings);
                logLine(`settings.json saved manually (prev → ${bak})`);
                return jsonRes(res, 200, { ok: true, previous: bak, current: currentTarget() });
            } catch (e) { return jsonRes(res, 400, { error: e.message }); }
        })();
        return;
    }

    // Список плагинов Claude Code: установленные (plugins/installed_plugins.json)
    // ∪ включённые (settings.enabledPlugins). Тоггл делается через /settings/apply.
    if (req.method === 'GET' && req.url === '/__switch/api/plugins/list') {
        try {
            const enabled = (readSettings().enabledPlugins) || {};
            let installed = {};
            try { installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; }
            catch {}
            const ids = [...new Set([...Object.keys(installed), ...Object.keys(enabled)])].sort();
            const plugins = ids.map(id => ({ id, enabled: enabled[id] === true, installed: id in installed }));
            return jsonRes(res, 200, { plugins });
        } catch (e) { return jsonRes(res, 500, { error: e.message }); }
    }

    if (req.method === 'GET' && req.url === '/__switch/api/settings/backups') {
        return jsonRes(res, 200, { dir: SETTINGS_BACKUP_DIR, backups: listSettingsBackups() });
    }
    if (req.method === 'POST' && req.url === '/__switch/api/settings/backup') {
        (async () => {
            try { const name = makeSettingsBackup(); logLine(`settings backup: ${name}`); return jsonRes(res, 200, { ok: true, name }); }
            catch (e) { return jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }
    if (req.method === 'POST' && req.url === '/__switch/api/settings/restore') {
        (async () => {
            try {
                const { name } = await readJsonBody(req);
                const base = path.basename(String(name || ''));
                if (!BACKUP_NAME_RE.test(base)) return jsonRes(res, 400, { error: 'bad backup name' });
                const src = path.join(SETTINGS_BACKUP_DIR, base);
                if (!fs.existsSync(src)) return jsonRes(res, 404, { error: 'backup not found' });
                const raw = fs.readFileSync(src, 'utf8');
                try { JSON.parse(raw.replace(/^﻿/, '')); } catch { return jsonRes(res, 400, { error: 'backup не валидный JSON' }); }
                const prev = makeSettingsBackup('settings-prerestore');
                fs.writeFileSync(SETTINGS_FILE, raw, 'utf8');
                logLine(`settings restored from ${base} (prev → ${prev})`);
                return jsonRes(res, 200, { ok: true, restored: base, previous: prev });
            } catch (e) { return jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }
    if (req.method === 'POST' && req.url === '/__switch/api/settings/backup-delete') {
        (async () => {
            try {
                const { name } = await readJsonBody(req);
                const base = path.basename(String(name || ''));
                if (!BACKUP_NAME_RE.test(base)) return jsonRes(res, 400, { error: 'bad backup name' });
                const f = path.join(SETTINGS_BACKUP_DIR, base);
                if (fs.existsSync(f)) fs.unlinkSync(f);
                return jsonRes(res, 200, { ok: true, deleted: base });
            } catch (e) { return jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }

    // OmniRoute creds (URL + manage key) for tokenrouter import — routing/.env, live.
    if (req.url === '/__switch/api/env') {
        if (req.method === 'GET') {
            const e = readEnvFile();
            return jsonRes(res, 200, {
                OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL || e.OMNIROUTE_BASE_URL || 'http://localhost:20128',
                OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY || e.OMNIROUTE_API_KEY || '',
            });
        }
        if (req.method === 'POST') {
            (async () => {
                try {
                    const body = await readJsonBody(req);
                    const updates = {};
                    if (typeof body.OMNIROUTE_BASE_URL === 'string') {
                        const u = body.OMNIROUTE_BASE_URL.trim().replace(/\/+$/, '');
                        if (!/^https?:\/\/.+/.test(u)) return jsonRes(res, 400, { error: 'URL должен начинаться с http:// или https://' });
                        updates.OMNIROUTE_BASE_URL = u;
                    }
                    if (typeof body.OMNIROUTE_API_KEY === 'string') {
                        const k = body.OMNIROUTE_API_KEY.trim();
                        if (!k) return jsonRes(res, 400, { error: 'OMNIROUTE_API_KEY пустой' });
                        updates.OMNIROUTE_API_KEY = k;
                    }
                    if (!Object.keys(updates).length) return jsonRes(res, 400, { error: 'нечего сохранять' });
                    upsertEnvFile(updates);
                    logLine(`env updated: ${Object.keys(updates).join(', ')}`);
                    return jsonRes(res, 200, { ok: true, applied: Object.keys(updates) });
                } catch (e) {
                    return jsonRes(res, 500, { error: e.message });
                }
            })();
            return;
        }
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

    if (req.method === 'GET' && req.url === '/__switch/api/freemodel/invites') {
        return handleFreemodelInvites(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/set-invite') {
        return handleFreemodelSetInvite(req, res);
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

    if (req.method === 'POST' && req.url === '/__switch/api/launch-bat') {
        return handleLaunchBat(req, res);
    }

    // ---- TG pool routes ----
    if (req.method === 'GET'  && req.url === '/__switch/api/tg/list')        return handleTgList(res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/add-hex')     return handleTgAddHex(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/add-bulk')    return handleTgAddBulk(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/add-session') return handleTgAddSession(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/delete')      return handleTgDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/mark-free')   return handleTgMarkFree(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/rename')      return handleTgRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/open')        return handleTgOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/health-check') return handleTgHealthCheck(req, res);

    // ---- FreeModel ban/unban marker ----
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/ban')      return handleFreemodelBan(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/set-tg')   return handleFreemodelSetTg(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/bind-telegram') return handleFreemodelBindTelegram(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/set-key')      return handleFreemodelSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/extract-key')  return handleFreemodelExtractKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/activate')     return handleFreemodelActivate(req, res);

    // ---- Aerolink (al) — ручной пул, активация через API Helper ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/al/sessions')) return handleAlSessions(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/al/add')       return handleAlAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/al/delete')    return handleAlDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/al/activate')  return handleAlActivate(req, res);

    // ---- FreeModel auto-rotation (API Helper load balancer) ----
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/auto/start') {
        (async () => {
            try {
                const body = await readJsonBody(req).catch(() => ({}));
                const r = fmAutoStart(body || {});
                jsonRes(res, 200, { ok: true, ...fmAutoStatus(), helperChanged: r.helper?.changed, helperError: r.helper?.error });
            } catch (e) { jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/auto/stop') {
        fmAutoStop();
        return jsonRes(res, 200, { ok: true, ...fmAutoStatus() });
    }
    if (req.method === 'GET' && req.url === '/__switch/api/freemodel/auto/status') {
        return jsonRes(res, 200, fmAutoStatus());
    }

    if (req.method === 'GET' && req.url === '/__switch/api/freemodel/active-key') {
        (async () => {
            try {
                const cwd = process.cwd();
                process.chdir(path.join(__dirname, '..'));
                let activeKey, activeName = null;
                try {
                    activeKey = dashApi.getActiveFreemodelKey();
                    if (activeKey) {
                        const sessions = await dashApi.listFreemodelSessions({ withQuotas: false });
                        const match = sessions.find(s => s.meta?.apiKey === activeKey || (() => {
                            try {
                                const infoFile = path.join(s.path, 'account_info.txt');
                                if (fs.existsSync(infoFile)) {
                                    const m = fs.readFileSync(infoFile, 'utf-8').match(/^API Key:\s*((?:fe[_-]|sk-)[A-Za-z0-9_-]{20,})/m);
                                    return m && m[1] === activeKey;
                                }
                            } catch {}
                            return false;
                        })());
                        if (match) activeName = match.name;
                    }
                } finally { process.chdir(cwd); }
                jsonRes(res, 200, { activeKey: activeKey ? activeKey.slice(0, 12) + '...' + activeKey.slice(-6) : null, activeName });
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    // ---- TokenRouter routes ----
    if (req.method === 'GET' && req.url === '/__switch/api/tokenrouter/omniroute-connections') {
        (async () => {
            try {
                const response = await fetch(`${omniBase()}/api/providers`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${omniKey()}` },
                });
                if (!response.ok) throw new Error(`providers ${response.status}`);
                const data = await response.json();
                const list = data.connections || [];
                const connections = list.filter(p =>
                    p.provider === 'openai-compatible-chat-8f2ae822-58f2-49b4-b212-393f686b00c5'
                ).map(p => ({
                    id: p.id,
                    name: p.name,
                    email: p.email,
                }));
                logLine(`tokenrouter omniroute connections: ${connections.length}`);
                jsonRes(res, 200, { connections });
            } catch (e) {
                logLine(`tokenrouter omniroute connections failed: ${e.message}`);
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'GET' && req.url === '/__switch/api/tokenrouter/accounts') {
        try {
            if (!fs.existsSync(TOKENROUTER_ACCOUNTS)) {
                return jsonRes(res, 200, { accounts: [] });
            }
            const accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
            const safe = accounts.map(a => ({
                email: a.email,
                password: a.password,
                apiKey: a.apiKey,
                apiKeyMask: a.apiKey ? '…' + a.apiKey.slice(-8) : null,
                apiKeyName: a.apiKeyName,
                createdAt: a.createdAt,
            }));
            jsonRes(res, 200, { accounts: safe });
        } catch (e) {
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/delete') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });
                if (!fs.existsSync(TOKENROUTER_ACCOUNTS))
                    return jsonRes(res, 404, { error: 'no accounts file' });
                let accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
                const before = accounts.length;
                accounts = accounts.filter(a => a.email !== email);
                fs.writeFileSync(TOKENROUTER_ACCOUNTS, JSON.stringify(accounts, null, 2), 'utf8');
                logLine(`tokenrouter: deleted ${email} (${before} -> ${accounts.length})`);
                jsonRes(res, 200, { ok: true, remaining: accounts.length });
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/add') {
        (async () => {
            try {
                const { email, apiKey } = await readJsonBody(req);
                if (!email || !apiKey) return jsonRes(res, 400, { error: 'email + apiKey required' });
                if (!/^sk-[A-Za-z0-9]{20,}$/.test(apiKey)) return jsonRes(res, 400, { error: 'bad key format' });

                let accounts = [];
                if (fs.existsSync(TOKENROUTER_ACCOUNTS)) {
                    accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
                }
                const existing = accounts.find(a => a.email === email);
                if (existing) {
                    existing.apiKey = apiKey;
                    existing.apiKeyName = existing.apiKeyName || 'manual';
                } else {
                    accounts.push({
                        email, apiKey, apiKeyName: 'manual',
                        createdAt: new Date().toISOString().substring(0, 19) + 'Z',
                        cookies: [],
                    });
                }
                fs.writeFileSync(TOKENROUTER_ACCOUNTS, JSON.stringify(accounts, null, 2), 'utf8');
                logLine(`tokenrouter: manual add ${email} (total: ${accounts.length})`);
                jsonRes(res, 200, { ok: true, total: accounts.length });
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/open') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });
                const result = dashApi.openTokenrouterSession(email);
                logLine(`tokenrouter open: ${email} → ${result.ok ? 'OK' : result.error}`);
                jsonRes(res, result.ok ? 200 : 400, result);
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'GET' && req.url === '/__switch/api/tokenrouter/health-cache') {
        try {
            const TR_HEALTH = path.join(__dirname, '..', 'logs', '.tokenrouter_health.json');
            const cache = fs.existsSync(TR_HEALTH) ? JSON.parse(fs.readFileSync(TR_HEALTH, 'utf-8')) : {};
            jsonRes(res, 200, cache);
        } catch (e) {
            jsonRes(res, 200, {});
        }
        return;
    }

    if (req.method === 'GET' && req.url === '/__switch/api/tokenrouter/usage-cache') {
        try {
            const TR_USAGE = path.join(__dirname, '..', 'logs', '.tokenrouter_usage.json');
            const usage = fs.existsSync(TR_USAGE) ? JSON.parse(fs.readFileSync(TR_USAGE, 'utf-8')) : {};
            jsonRes(res, 200, usage);
        } catch (e) {
            jsonRes(res, 200, {});
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/refresh-usage') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });
                if (!fs.existsSync(TOKENROUTER_ACCOUNTS))
                    return jsonRes(res, 404, { error: 'no accounts file' });
                const accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
                const acc = accounts.find(a => a.email === email);
                if (!acc || !acc.apiKey) return jsonRes(res, 404, { error: 'account or key not found' });
                const result = await dashApi.checkTokenrouterUsage(acc.apiKey, email);
                logLine(`tokenrouter usage: ${email} → $${(result.todayCost || 0).toFixed(4)} / $1.00`);
                jsonRes(res, 200, result);
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/check-key') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });
                if (!fs.existsSync(TOKENROUTER_ACCOUNTS))
                    return jsonRes(res, 404, { error: 'no accounts file' });
                const accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
                const acc = accounts.find(a => a.email === email);
                if (!acc || !acc.apiKey) return jsonRes(res, 404, { error: 'account or key not found' });
                const result = await dashApi.checkTokenrouterKey(acc.apiKey, email);
                logLine(`tokenrouter check: ${email} → ${result.ok ? 'OK' : 'DEAD (' + result.status + ')'}`);
                jsonRes(res, 200, result);
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/import-to-omniroute') {
        (async () => {
            try {
                const { email, apiKey } = await readJsonBody(req);
                if (!email || !apiKey) return jsonRes(res, 400, { error: 'email and apiKey required' });
                const stdout = execFileSync('node', [path.join(__dirname, 'tokenrouter', 'omniroute-api-client.js'), email, apiKey], {
                    encoding: 'utf8',
                    maxBuffer: 1024 * 1024,
                    timeout: 60000,
                    env: process.env,
                });
                const lines = stdout.trim().split(/\r?\n/);
                let summary = null;
                try { summary = JSON.parse(lines[lines.length - 1]); } catch {}
                logLine(`tokenrouter import to omniroute: ${email} → ${summary?.ok ? 'OK' : (summary?.error || 'done')}`);
                jsonRes(res, 200, { ok: true, output: stdout, summary });
            } catch (e) {
                logLine(`tokenrouter import to omniroute failed: ${e.message}`);
                jsonRes(res, 500, { error: e.message || 'import failed' });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/delete-from-omniroute') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });

                const response = await fetch(`${omniBase()}/api/providers`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${omniKey()}` },
                });
                if (!response.ok) throw new Error(`providers ${response.status}`);
                const data = await response.json();
                const list = data.connections || [];
                const match = list.find(p =>
                    p.provider === 'openai-compatible-chat-8f2ae822-58f2-49b4-b212-393f686b00c5' &&
                    (p.name === email || p.email === email)
                );
                if (!match) {
                    logLine(`tokenrouter delete from omniroute: ${email} not found`);
                    return jsonRes(res, 200, { ok: true, deleted: false, reason: 'not found' });
                }
                const del = await fetch(`${omniBase()}/api/providers/${match.id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${omniKey()}` },
                });
                if (!del.ok) throw new Error(`delete ${del.status}`);
                logLine(`tokenrouter delete from omniroute: ${match.id.substring(0, 8)} (${email})`);
                return jsonRes(res, 200, { ok: true, deleted: true, id: match.id });
            } catch (e) {
                logLine(`tokenrouter delete from omniroute failed: ${e.message}`);
                return jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    // ---- Freemodel Rotator proxy ----
    if (req.method === 'GET' && req.url === '/__switch/api/rotator/status') {
        const rotOpts = { hostname: '127.0.0.1', port: 20126, path: '/__fmrot/api/status', method: 'GET', timeout: 3000 };
        const rotReq = http.request(rotOpts, (rotRes) => {
            let b = '';
            rotRes.on('data', c => b += c);
            rotRes.on('end', () => {
                try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(b); }
                catch { jsonRes(res, 200, {}); }
            });
        });
        rotReq.on('error', () => jsonRes(res, 200, { error: 'rotator not running', keys: [], totalRequests: 0, activeCount: 0, totalCount: 0 }));
        rotReq.end();
        return;
    }

    // ---- Freemodel Rotator generic proxy (avoids CORS) ----
    if (req.method === 'POST' && req.url === '/__switch/api/rotator/proxy') {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => {
            try {
                const { path: rotPath, method: rotMethod, body: rotBody } = JSON.parse(b);
                const bodyStr = rotBody ? JSON.stringify(rotBody) : '';
                const rotOpts = {
                    hostname: '127.0.0.1', port: 20126,
                    path: rotPath || '/__fmrot/api/status',
                    method: rotMethod || 'GET',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
                    timeout: 15000,
                };
                const rotReq = http.request(rotOpts, (rotRes) => {
                    let rb = '';
                    rotRes.on('data', c => rb += c);
                    rotRes.on('end', () => {
                        try { res.writeHead(rotRes.statusCode, { 'Content-Type': 'application/json' }); res.end(rb); }
                        catch { jsonRes(res, 500, { error: 'proxy error' }); }
                    });
                });
                rotReq.on('error', () => jsonRes(res, 502, { error: 'rotator not running' }));
                if (bodyStr) rotReq.write(bodyStr);
                rotReq.end();
            } catch (e) { jsonRes(res, 400, { error: e.message }); }
        });
        return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/__switch' || req.url === '/__switch/')) {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'proxy-dashboard.html'), 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
              'Pragma': 'no-cache',
              'Expires': '0',
            });
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

    // Возобновляем авто-ротацию FreeModel, если она была включена до рестарта.
    if (fmAutoLoadPersist()) {
        console.log('  FreeModel auto-rotation: resuming (was enabled)');
        fmAutoStart();
    }
});

