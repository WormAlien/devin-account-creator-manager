// Smart Router SIMPLE — pure routing by model name. No fallbacks, no overrides.
//
// Listens on 8200. Reads `model` field from request body via regex (NO JSON.parse),
// routes to the backend that owns that model, sends the EXACT same bytes through.
//
// Why no JSON.parse: Notion bypass is sensitive to exact byte format.
// Reading model with regex preserves the original bytes.
//
// Routing rules (SIMPLIFIED — no vision-override, no cross-backend fallback):
//   - ComboWombo / cc/* / claude/* / claude-* / ac-freemodel*/* / anthropic-compatible*
//     -> OMNIROUTE
//   - opus-X / sonnet-X / haiku-X / gpt-5.X / gemini-X / deepseek / kimi / minimax
//     -> NOTION
//   - no model field (Claude Code default) -> NOTION
//   - everything else -> NOTION (default)
//
// If the chosen backend fails, the request fails. No automatic fallback.

const http = require('http');

const LISTEN_PORT = 8200;
const NOTION = { host: '127.0.0.1', port: 8190,  label: 'notion-manager' };
const OMNI   = { host: '127.0.0.1', port: 20128, label: 'OmniRoute' };

const API_KEY = process.env.ROUTER_API_KEY || 'sk-local-dev-key';
const API_KEY_HEADER_VAL = 'Bearer ' + API_KEY;

function logLine(s) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] ${s}`);
}

// /v1/models exposes only two pseudo-models so Claude Code's /model picker
// shows a clean two-option list. The actual upstream model is whatever the
// backend's default is (notion-manager: config.proxy.default_model,
// OmniRoute: ComboWombo's underlying model).
const EXPOSED_MODELS = [
    {
        id: 'Notion',
        object: 'model',
        created: 0,
        owned_by: 'notion-manager',
        display_name: 'Notion (opus-4.8 via notion-manager)',
    },
    {
        id: 'ComboWombo',
        object: 'model',
        created: 0,
        owned_by: 'omniroute',
        display_name: 'ComboWombo (via OmniRoute)',
    },
];

async function buildMergedModels() {
    return EXPOSED_MODELS;
}

// Default upstream model name for the "Notion" pseudo-model.
// notion-manager picks an account/model from its pool based on this id.
const NOTION_DEFAULT_MODEL = 'opus-4.8';

// Picks backend + optional model rewrite.
// Returns { backend, rewriteTo: string|null }.
// rewriteTo !== null means the body's "model":"..." should be replaced before forwarding.
function pickRoute(model) {
    // Default (no model in body) -> Notion with default model
    if (!model) return { backend: NOTION, rewriteTo: NOTION_DEFAULT_MODEL };

    const m = model.toLowerCase();

    // Pseudo-model "Notion" -> notion-manager, rewrite to its default upstream model
    if (m === 'notion') return { backend: NOTION, rewriteTo: NOTION_DEFAULT_MODEL };

    // Pseudo-model "ComboWombo" / Claude-Code-native names -> OmniRoute as ComboWombo
    if (m === 'combowombo')                   return { backend: OMNI, rewriteTo: 'ComboWombo' };
    if (m.startsWith('combo'))                return { backend: OMNI, rewriteTo: 'ComboWombo' };
    if (m.startsWith('cc/'))                  return { backend: OMNI, rewriteTo: null };
    if (m.startsWith('claude/'))              return { backend: OMNI, rewriteTo: null };
    if (m.startsWith('claude-'))              return { backend: OMNI, rewriteTo: 'ComboWombo' };
    if (m.startsWith('ac-freemodel'))         return { backend: OMNI, rewriteTo: null };
    if (m.startsWith('anthropic-compatible')) return { backend: OMNI, rewriteTo: null };

    // Explicit Notion upstream names — forward as-is to Notion
    if (/^opus-\d/.test(m))           return { backend: NOTION, rewriteTo: null };
    if (/^sonnet-\d/.test(m))         return { backend: NOTION, rewriteTo: null };
    if (/^haiku-\d/.test(m))          return { backend: NOTION, rewriteTo: null };
    if (/^gpt-5\./.test(m))           return { backend: NOTION, rewriteTo: null };
    if (/^gemini-\d/.test(m))         return { backend: NOTION, rewriteTo: null };
    if (/^deepseek/.test(m))          return { backend: NOTION, rewriteTo: null };
    if (/^kimi/.test(m))              return { backend: NOTION, rewriteTo: null };
    if (/^minimax/.test(m))           return { backend: NOTION, rewriteTo: null };

    // Unknown model -> Notion with default
    return { backend: NOTION, rewriteTo: NOTION_DEFAULT_MODEL };
}

// Rewrite body's "model":"..." (regex, no JSON.parse — preserves exact bytes).
// If no "model" field is present, INSERT it at the start of the JSON object.
function rewriteModel(buf, newName) {
    if (!buf || !buf.length) {
        return Buffer.from(JSON.stringify({ model: newName }), 'utf8');
    }
    const s = buf.toString('utf8');
    if (/"model"\s*:\s*"[^"]+"/.test(s)) {
        return Buffer.from(s.replace(/"model"\s*:\s*"[^"]+"/, `"model":"${newName}"`), 'utf8');
    }
    // No model field — insert after the opening "{"
    const idx = s.indexOf('{');
    if (idx < 0) return buf; // not JSON, leave alone
    return Buffer.from(s.slice(0, idx + 1) + `"model":"${newName}",` + s.slice(idx + 1), 'utf8');
}

function peekModel(buf) {
    if (!buf || !buf.length) return null;
    const s = buf.toString('utf8');
    const m = s.match(/"model"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
}

// Detect image / document content blocks in the body.
// Notion-manager's S3 upload path is flaky (~70% success under VPN), so we
// route any request carrying an image or PDF to OmniRoute, which uses the
// upstream provider's native vision and has no S3 dependency.
function hasUnsupportedContent(buf) {
    if (!buf || !buf.length) return null;
    const s = buf.toString('utf8');
    if (/"type"\s*:\s*"image"/.test(s))    return 'image';
    if (/"type"\s*:\s*"document"/.test(s)) return 'document';
    return null;
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

    // Buffer entire body, then forward verbatim (or with a single model rewrite).
    // JSON.parse is NEVER called on the body.
    const chunks = [];
    clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', () => {
        let body = Buffer.concat(chunks);
        const model = peekModel(body);
        const { backend, rewriteTo } = pickRoute(model);

        let routeReason = `model=${model || '∅'}`;
        if (rewriteTo) {
            body = rewriteModel(body, rewriteTo);
            routeReason += `→${rewriteTo}`;
        }

        forwardRequest(backend, clientReq, clientRes, body, routeReason);
    });

    clientReq.on('error', (err) => logLine(`client req err: ${err.message}`));
}).listen(LISTEN_PORT, () => {
    console.log(`Smart Router SIMPLE (no cross-backend fallback) on http://localhost:${LISTEN_PORT}`);
    console.log(`  exposed /v1/models: Notion, ComboWombo`);
    console.log(`  rules:`);
    console.log(`    model=Notion / (none) / opus-/sonnet-/etc.       -> notion-manager`);
    console.log(`    model=ComboWombo / claude-* / combo*             -> OmniRoute as ComboWombo`);
    console.log(`  NO vision-override, NO cross-backend fallback`);
});

// Plain forward — request fails if backend fails. No retries, no failover.
function forwardRequest(backend, clientReq, clientRes, body, routeReason) {
    const headers = { ...clientReq.headers };
    headers.host = `${backend.host}:${backend.port}`;
    if (body.length) headers['content-length'] = body.length;

    logLine(`${clientReq.method} ${clientReq.url} ${routeReason} -> ${backend.label}`);

    const proxyReq = http.request({
        host: backend.host,
        port: backend.port,
        method: clientReq.method,
        path:   clientReq.url,
        headers,
    }, (proxyRes) => {
        try {
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        } catch (e) {
            logLine(`  ${backend.label}: writeHead failed: ${e.code || e.message}`);
            try { proxyRes.destroy(); } catch {}
            return;
        }
        proxyRes.on('error', (e) => {
            logLine(`  ${backend.label}: upstream stream error: ${e.code || e.message}`);
            try { clientRes.end(); } catch {}
        });
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
        logLine(`  ${backend.label}: ${err.code || err.message}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({
                error: { message: `smart-router: ${backend.label} failed: ${err.code || err.message}` }
            }));
        }
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
}
