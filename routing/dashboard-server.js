// Dashboard v4 — auto-routing visualization.
// Smart-router-v2 routes by `model` in body. No mode switching needed.
// This dashboard:
//   - Shows backends status (notion / omniroute / smart-router)
//   - Shows model map: which model goes to which backend
//   - "Pin Claude Code to 8200" — one-time settings.json patch
//   - Legacy /api/apply preserved for backwards compat (use-*.bat)

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LISTEN_PORT   = 8300;
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HTML_PATH     = path.join(__dirname, 'dashboard.html');

const NOTION = { host: '127.0.0.1', port: 8190,  label: 'notion-manager' };
const OMNI   = { host: '127.0.0.1', port: 20128, label: 'OmniRoute' };
const ROUTER = { host: '127.0.0.1', port: 8200,  label: 'smart-router-v2' };

const API_KEY = process.env.ROUTER_API_KEY || 'sk-local-dev-key';

// Same routing rules as smart-router-v2 — keep in sync!
function pickBackend(model) {
    if (!model) return 'omniroute';
    const m = model.toLowerCase();
    if (m === 'combowombo')                   return 'omniroute';
    if (m.startsWith('cc/'))                  return 'omniroute';
    if (m.startsWith('claude/'))              return 'omniroute';
    if (m.startsWith('claude-'))              return 'omniroute';
    if (m.startsWith('ac-freemodel'))         return 'omniroute';
    if (m.startsWith('anthropic-compatible')) return 'omniroute';
    if (m.startsWith('combo'))                return 'omniroute';
    if (/^opus-\d/.test(m))           return 'notion';
    if (/^sonnet-\d/.test(m))         return 'notion';
    if (/^haiku-\d/.test(m))          return 'notion';
    if (/^gpt-5\./.test(m))           return 'notion';
    if (/^gemini-\d/.test(m))         return 'notion';
    if (/^deepseek/.test(m))          return 'notion';
    if (/^kimi/.test(m))              return 'notion';
    if (/^minimax/.test(m))           return 'notion';
    return 'omniroute';
}

// ---- helpers --------------------------------------------------------------
function readJson(p, def = {}) {
    try {
        let raw = fs.readFileSync(p, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        return JSON.parse(raw);
    } catch { return def; }
}
function writeJson(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function ping(backend, pathStr = '/v1/models') {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = http.request({
            host: backend.host, port: backend.port, path: pathStr, method: 'GET',
            headers: { authorization: 'Bearer ' + API_KEY },
            timeout: 3000,
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                let models = [];
                try { models = (JSON.parse(body).data || []).map(m => m.id); } catch {}
                resolve({ up: res.statusCode === 200, status: res.statusCode, latencyMs: Date.now() - start, models });
            });
        });
        req.on('error',   () => resolve({ up: false, status: 0, latencyMs: 0, models: [] }));
        req.on('timeout', () => { req.destroy(); resolve({ up: false, status: 0, latencyMs: 3000, models: [] }); });
        req.end();
    });
}

function detectClaudeMode(settings) {
    const url = settings?.env?.ANTHROPIC_BASE_URL || '';
    if (url.includes(':20128')) return 'omniroute-direct';
    if (url.includes(':8190'))  return 'notion-direct';
    if (url.includes(':8200'))  return 'smart-router';
    return 'unknown';
}

// ---- API handlers ---------------------------------------------------------
async function apiState(req, res) {
    const settings = readJson(SETTINGS_PATH, {});
    const [omni, notion, router] = await Promise.all([ping(OMNI), ping(NOTION), ping(ROUTER)]);

    // Build model map: each model from each backend with where it routes
    const modelMap = [];
    const seen = new Set();
    for (const id of (notion.models || [])) {
        if (seen.has(id)) continue;
        seen.add(id);
        modelMap.push({ id, owner: 'notion-manager', routesTo: pickBackend(id) });
    }
    for (const id of (omni.models || [])) {
        if (seen.has(id)) continue;
        seen.add(id);
        modelMap.push({ id, owner: 'omniroute', routesTo: pickBackend(id) });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        settings: {
            baseUrl:           settings.env?.ANTHROPIC_BASE_URL || '',
            apiKeyTail:        (settings.env?.ANTHROPIC_API_KEY ? '***' + settings.env.ANTHROPIC_API_KEY.slice(-6) : ''),
            anthropicModel:    settings.env?.ANTHROPIC_MODEL || null,
            anthropicFastModel:settings.env?.ANTHROPIC_SMALL_FAST_MODEL || null,
            topLevelModel:     settings.model || null,
        },
        backends: {
            omniroute: { ...OMNI, ...omni },
            notion:    { ...NOTION, ...notion },
            router:    { ...ROUTER, ...router },
        },
        claudeMode: detectClaudeMode(settings),
        modelMap,
    }));
}

const PRESETS = {
    notion: {
        env: { ANTHROPIC_BASE_URL: 'http://localhost:8190', ANTHROPIC_API_KEY: API_KEY },
        topLevelModel: null,
    },
    omniroute: {
        env: { ANTHROPIC_BASE_URL: 'http://localhost:20128/v1', ANTHROPIC_API_KEY: API_KEY },
        topLevelModel: 'ComboWombo',
    },
    smart: {
        env: { ANTHROPIC_BASE_URL: 'http://localhost:8200', ANTHROPIC_API_KEY: API_KEY },
        topLevelModel: null,
    },
};

async function apiApply(req, res, body) {
    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid json' })); return; }
    const mode = payload.mode;
    if (!PRESETS[mode]) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'unknown mode: ' + mode })); return; }
    const preset = PRESETS[mode];
    const settings = readJson(SETTINGS_PATH, {});
    settings.env = { ...preset.env };
    if (preset.topLevelModel === null) {
        if (settings.model !== undefined) delete settings.model;
    } else {
        settings.model = preset.topLevelModel;
    }
    writeJson(SETTINGS_PATH, settings);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode, applied: preset, note: 'Restart Claude Code to apply.' }));
}

async function apiPinCc(req, res) {
    const preset = PRESETS.smart;
    const settings = readJson(SETTINGS_PATH, {});
    settings.env = { ...preset.env };
    if (settings.model !== undefined) delete settings.model;
    writeJson(SETTINGS_PATH, settings);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ok: true,
        note: 'Claude Code pinned to http://localhost:8200. Restart Claude Code ONCE. After that, /model picker switches between backends instantly.',
    }));
}

http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        try {
            const html = fs.readFileSync(HTML_PATH);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            res.writeHead(500); res.end('Cannot read ' + HTML_PATH + ': ' + e.message);
        }
        return;
    }

    if (req.url === '/api/state' && req.method === 'GET') return apiState(req, res);

    if (req.method === 'POST') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (req.url === '/api/apply')  return apiApply(req, res, body);
            if (req.url === '/api/pin-cc') return apiPinCc(req, res);
            res.writeHead(404); res.end('not found');
        });
        return;
    }

    res.writeHead(404);
    res.end('not found');
}).listen(LISTEN_PORT, () => {
    console.log('Dashboard v4: http://localhost:' + LISTEN_PORT);
    console.log('  routing is automatic by model — no mode switching');
    console.log('  POST /api/pin-cc -> set BASE_URL=8200 (one-time)');
    console.log('  POST /api/apply {mode} -> legacy direct switching');
});
