// Smart Router v3 — auto-routing by model name in request body.
//
// Listens on 8200. Reads `model` field from request body via regex (NO JSON.parse),
// routes to the backend that owns that model, sends the EXACT same bytes through.
//
// Why no JSON.parse: Notion bypass is sensitive to exact byte format.
// Reading model with regex preserves the original bytes.
//
// Routing rules:
//   - opus-4.X / sonnet-4.X / haiku-4.X / gpt-5.X / gemini-X / deepseek-X
//     / kimi-X / minimax-X -> NOTION
//   - ComboWombo / cc/* / claude/* / claude-* / ac-freemodel*/* / anthropic-compatible* -> OMNIROUTE
//   - GET /v1/models -> merge from both backends
//   - everything else -> default to OmniRoute (safer)

const http = require('http');

const LISTEN_PORT = 8200;
const NOTION = { host: '127.0.0.1', port: 8190,  label: 'notion-manager' };
const OMNI   = { host: '127.0.0.1', port: 20128, label: 'OmniRoute' };

const FIRST_BYTE_TIMEOUT_MS = 120000;
const API_KEY = process.env.ROUTER_API_KEY || 'sk-local-dev-key';
const API_KEY_HEADER_VAL = 'Bearer ' + API_KEY;

function logLine(s) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] ${s}`);
}

// Models cache for /v1/models merging
let cachedModels = null;
let cachedModelsAt = 0;
const MODELS_CACHE_TTL = 30000;

function fetchModels(backend) {
    return new Promise((resolve) => {
        const req = http.request({
            host: backend.host, port: backend.port, path: '/v1/models', method: 'GET',
            headers: { authorization: API_KEY_HEADER_VAL },
            timeout: 5000,
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body).data || []); }
                catch { resolve([]); }
            });
        });
        req.on('error',   () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.end();
    });
}

async function buildMergedModels() {
    if (cachedModels && Date.now() - cachedModelsAt < MODELS_CACHE_TTL) return cachedModels;
    const [omni, notion] = await Promise.all([fetchModels(OMNI), fetchModels(NOTION)]);
    const seen = new Set();
    const merged = [];
    for (const m of notion) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        merged.push({ ...m, owned_by: 'notion-manager' });
    }
    for (const m of omni) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        merged.push({ ...m, owned_by: 'omniroute' });
    }
    cachedModels = merged;
    cachedModelsAt = Date.now();
    return merged;
}

function pickBackend(model) {
    if (!model) return OMNI;
    const m = model.toLowerCase();

    if (m === 'combowombo')                   return OMNI;
    if (m.startsWith('cc/'))                  return OMNI;
    if (m.startsWith('claude/'))              return OMNI;
    if (m.startsWith('claude-'))              return OMNI;
    if (m.startsWith('ac-freemodel'))         return OMNI;
    if (m.startsWith('anthropic-compatible')) return OMNI;
    if (m.startsWith('combo'))                return OMNI;

    if (/^opus-\d/.test(m))           return NOTION;
    if (/^sonnet-\d/.test(m))         return NOTION;
    if (/^haiku-\d/.test(m))          return NOTION;
    if (/^gpt-5\./.test(m))           return NOTION;
    if (/^gemini-\d/.test(m))         return NOTION;
    if (/^deepseek/.test(m))          return NOTION;
    if (/^kimi/.test(m))              return NOTION;
    if (/^minimax/.test(m))           return NOTION;

    return OMNI;
}

function peekModel(buf) {
    if (!buf || !buf.length) return null;
    const s = buf.toString('utf8');
    const m = s.match(/"model"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
}

async function handleModels(res) {
    const merged = await buildMergedModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: merged }));
    logLine(`/v1/models -> merged ${merged.length}`);
}

http.createServer((clientReq, clientRes) => {
    if (clientReq.method === 'GET' && clientReq.url.startsWith('/v1/models')) {
        return handleModels(clientRes);
    }

    // Buffer entire body, then forward verbatim. JSON.parse is NEVER called on it.
    const chunks = [];
    clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', () => {
        const body = Buffer.concat(chunks);
        const model = peekModel(body);
        const backend = pickBackend(model);

        const headers = { ...clientReq.headers };
        headers.host = `${backend.host}:${backend.port}`;
        if (body.length) headers['content-length'] = body.length;

        const proxyReq = http.request({
            host: backend.host,
            port: backend.port,
            method: clientReq.method,
            path:   clientReq.url,
            headers,
            timeout: FIRST_BYTE_TIMEOUT_MS,
        }, (proxyRes) => {
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(clientRes);
        });

        proxyReq.on('error', (err) => {
            logLine(`${backend.label}: ${err.code || err.message}`);
            if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'Content-Type': 'application/json' });
                clientRes.end(JSON.stringify({
                    error: { message: `smart-router: ${backend.label} -> ${err.message}` }
                }));
            }
        });
        proxyReq.on('timeout', () => {
            logLine(`${backend.label}: timeout ${FIRST_BYTE_TIMEOUT_MS}ms`);
            proxyReq.destroy();
            if (!clientRes.headersSent) {
                clientRes.writeHead(504, { 'Content-Type': 'application/json' });
                clientRes.end(JSON.stringify({
                    error: { message: `smart-router: ${backend.label} timeout` }
                }));
            }
        });

        logLine(`${clientReq.method} ${clientReq.url} model=${model || '?'} -> ${backend.label}`);

        if (body.length) proxyReq.write(body);  // <-- byte-for-byte the same Buffer we received
        proxyReq.end();
    });

    clientReq.on('error', (err) => logLine(`client req err: ${err.message}`));
}).listen(LISTEN_PORT, () => {
    console.log(`Smart Router v3 (auto-routing by model) on http://localhost:${LISTEN_PORT}`);
    console.log(`  rules:`);
    console.log(`    opus-/sonnet-/haiku-/gpt-5./gemini-/deepseek/kimi/minimax -> notion-manager`);
    console.log(`    ComboWombo/cc-//claude-/ac-freemodel/anthropic-compatible -> OmniRoute`);
    console.log(`    GET /v1/models -> merged from both`);
});
