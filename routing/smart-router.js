// Smart router with FALLBACK CHAINS
// Reads router-config.json:
//   {
//     "modelBackends": {
//       "opus-4.8": [ "notion",
//                     { "backend": "omniroute", "asModel": "ac-freemodel1/claude-opus-4-7" } ]
//     },
//     "defaultBackend": "notion"
//   }
//
// Each chain step is tried in order. Fallback triggers on:
//   - Connection error (ECONNREFUSED, etc.)
//   - HTTP 5xx response
//   - Socket inactivity > FIRST_BYTE_TIMEOUT_MS
// Once a backend starts streaming (status < 500), it commits.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const NOTION = { host: '127.0.0.1', port: 8190, label: 'notion-manager' };
const OMNI   = { host: '127.0.0.1', port: 20128, label: 'OmniRoute' };
const BACKENDS = { notion: NOTION, omniroute: OMNI };

const LISTEN_PORT  = 8200;
const CONFIG_PATH  = path.join(__dirname, 'router-config.json');
const FIRST_BYTE_TIMEOUT_MS = 90000;  // notion-manager can take 30-90s rotating accounts

let routerConfig = { modelBackends: {}, defaultBackend: 'notion' };

function logLine(s) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] ${s}`);
}

function loadConfig() {
    try {
        let raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        routerConfig = JSON.parse(raw);
        const n = Object.keys(routerConfig.modelBackends).length;
        logLine(`config loaded: ${n} model rules, default=${routerConfig.defaultBackend}`);
    } catch (e) {
        logLine(`config load FAIL (using last good): ${e.message}`);
    }
}
loadConfig();
fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => loadConfig());

// Normalize Claude Code's canonical model names ("claude-opus-4-8") to our
// short aliases ("opus-4.8") so router-config lookups hit. Claude Code's
// /model picker writes the canonical form; without this normalization the
// router falls through to default and OmniRoute returns 400 "no credentials".
function normalizeModelName(model) {
    if (!model) return model;
    let m = model.trim();
    // Strip leading "claude-" prefix
    m = m.replace(/^claude-/, '');
    // Convert "opus-4-8" -> "opus-4.8" (last "-" before digit becomes ".")
    // Only for our known families
    m = m.replace(/^(opus|sonnet|haiku)-(\d+)-(\d+)/, '$1-$2.$3');
    m = m.replace(/^gpt-(\d+)-(\d+)/, 'gpt-$1.$2');
    return m;
}

// Normalize an entry into a chain of {backend, asModel?} steps.
function getChain(model) {
    const norm = normalizeModelName(model);
    const entry = routerConfig.modelBackends[norm] !== undefined
        ? routerConfig.modelBackends[norm]
        : routerConfig.modelBackends[model];
    const fallback = [{ backend: routerConfig.defaultBackend }];
    if (entry === undefined) return fallback;
    if (typeof entry === 'string') return [{ backend: entry }];
    if (Array.isArray(entry)) {
        return entry
            .map(e => typeof e === 'string' ? { backend: e } : e)
            .filter(e => e && BACKENDS[e.backend]);
    }
    return fallback;
}

// ----- /v1/models merger ---------------------------------------------------
async function fetchModels(backend) {
    return new Promise((resolve) => {
        const req = http.request({
            host: backend.host, port: backend.port, path: '/v1/models', method: 'GET',
            headers: { authorization: 'Bearer ' + (process.env.ROUTER_API_KEY || 'sk-local-dev-key') },
            timeout: 3000,
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body).data || []); }
                catch { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.end();
    });
}

async function handleModels(res) {
    const [omni, notion] = await Promise.all([fetchModels(OMNI), fetchModels(NOTION)]);
    const seen = new Set();
    const merged = [];
    for (const m of omni) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        merged.push({ ...m, owned_by: 'omniroute' });
    }
    for (const m of notion) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        merged.push({ ...m, owned_by: 'notion-manager' });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: merged }));
    logLine(`/v1/models  ${omni.length}+${notion.length} -> ${merged.length}`);
}

// ----- single backend attempt ---------------------------------------------
// Returns: 'success' (response committed to client), 'fail' (try next), 'fatal' (give up)
function attemptBackend(step, clientReq, clientRes, body) {
    return new Promise((resolve) => {
        const backend = BACKENDS[step.backend];
        if (!backend) return resolve('fail');

        // Rewrite model field in body:
        //   - asModel set -> use that
        //   - otherwise normalize "claude-opus-4-8" -> "opus-4.8" so notion-manager
        //     and OmniRoute see a model name they recognize.
        // IMPORTANT: Skip rewriting for notion backend — notion-manager bypass is
        // sensitive to exact request format; any JSON re-serialization breaks it.
        // ALSO: Skip if body is large (>100KB, likely contains images) — JSON.stringify
        // corrupts base64 or changes format, breaking vision requests.
        let sendBody = body;
        const LARGE_BODY_THRESHOLD = 100 * 1024; // 100KB
        if (step.backend !== 'notion' && body && body.length > 0 && body.length < LARGE_BODY_THRESHOLD) {
            try {
                const parsed = JSON.parse(body.toString());
                const before = parsed.model;
                if (step.asModel) {
                    parsed.model = step.asModel;
                } else if (before) {
                    parsed.model = normalizeModelName(before);
                }
                if (parsed.model !== before) {
                    sendBody = Buffer.from(JSON.stringify(parsed));
                }
            } catch (_) { /* keep original */ }
        }

        const headers = { ...clientReq.headers, host: `${backend.host}:${backend.port}` };
        if (sendBody !== body) headers['content-length'] = Buffer.byteLength(sendBody);

        const proxyReq = http.request({
            host: backend.host,
            port: backend.port,
            method: clientReq.method,
            path: clientReq.url,
            headers,
            timeout: FIRST_BYTE_TIMEOUT_MS,
        }, (proxyRes) => {
            // Decide based on status code
            if (proxyRes.statusCode >= 500) {
                logLine(`  ${backend.label}: ${proxyRes.statusCode} -> fallback`);
                proxyRes.resume();  // drain
                return resolve('fail');
            }
            // Commit: pipe response to client
            const startTime = Date.now();
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(clientRes);
            proxyRes.on('end', () => {
                logLine(`  ${backend.label}: ${proxyRes.statusCode} OK in ${Date.now() - startTime}ms`);
                resolve('success');
            });
            proxyRes.on('error', () => resolve('success'));  // already committed
        });

        proxyReq.on('error', (err) => {
            logLine(`  ${backend.label}: ${err.code || err.message} -> fallback`);
            resolve('fail');
        });
        proxyReq.on('timeout', () => {
            logLine(`  ${backend.label}: timeout -> fallback`);
            proxyReq.destroy();
            resolve('fail');
        });

        if (sendBody && sendBody.length) proxyReq.write(sendBody);
        proxyReq.end();
    });
}

async function proxyChain(chain, clientReq, clientRes, body, modelName) {
    for (let i = 0; i < chain.length; i++) {
        const step = chain[i];
        const backend = BACKENDS[step.backend];
        const asLabel = step.asModel ? ` as ${step.asModel}` : '';
        logLine(`  attempt ${i + 1}/${chain.length}: ${backend?.label || step.backend}${asLabel}`);
        const result = await attemptBackend(step, clientReq, clientRes, body);
        if (result === 'success') return;
    }
    // All steps failed
    if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({
            error: { message: `router: all backends failed for model ${modelName || '?'}` }
        }));
    }
}

// ----- server --------------------------------------------------------------
http.createServer((clientReq, clientRes) => {
    if (clientReq.method === 'GET' && clientReq.url.startsWith('/v1/models')) {
        handleModels(clientRes);
        return;
    }

    const chunks = [];
    clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', () => {
        const body = Buffer.concat(chunks);
        let model = null;
        try {
            if (body.length > 0 && (clientReq.headers['content-type'] || '').includes('json')) {
                model = JSON.parse(body.toString()).model;
            }
        } catch (_) {}

        const chain = getChain(model);
        const chainStr = chain.map(s => s.backend + (s.asModel ? `(${s.asModel})` : '')).join(' -> ');
        logLine(`${clientReq.method} ${clientReq.url}  model=${model || '?'}  chain=[${chainStr}]`);
        proxyChain(chain, clientReq, clientRes, body, model);
    });
    clientReq.on('error', (err) => logLine(`client err: ${err.message}`));
}).listen(LISTEN_PORT, () => {
    console.log(`Smart router on http://localhost:${LISTEN_PORT}`);
    console.log(`  config: ${CONFIG_PATH} (hot-reload on change)`);
    console.log(`  notion-manager: ${NOTION.host}:${NOTION.port}`);
    console.log(`  OmniRoute:      ${OMNI.host}:${OMNI.port}`);
});
