// Smart Router v3 (rebuilt) — per-request auto-routing.
//
// Listens on :8201. The key insight (from the OmniRoute log analysis):
//
//   - OmniRoute is fine with passthrough — CC sends sk-local-dev-key + its own
//     headers/body, OmniRoute resolves model "ComboWombo" via its own combo.
//     Our router forwards headers/body byte-for-byte; OmniRoute doesn't care
//     about source PID. The old smart-router.js logs confirm 200 OK responses.
//
//   - Notion uses a DIFFERENT api key (sk-bb58...) and expects Anthropic-format
//     model names (opus-4.8 etc.). For Notion-bound requests we swap the auth
//     headers under Notion's own key, but keep body untouched (Notion bypass
//     is byte-sensitive — we only rewrite "model" if the original was
//     something Notion won't recognize).
//
// Routing heuristic (first match wins):
//   1) tools: [...] non-empty               -> OmniRoute (Notion struggles with tools)
//   2) "type":"image" / "document"          -> OmniRoute (Notion S3 upload flaky)
//   3) body > 50 KB                         -> OmniRoute (Notion small-context)
//   4) explicit Notion-flavored model name  -> Notion
//   5) default / unknown                    -> Notion (cheap fallback)
//
// On Notion 5xx -> one transparent fallback retry to OmniRoute.

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ---- Load routing/.env (gitignored real keys) ------------------------------
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

const LISTEN_PORT = 8201;

const OMNI = {
    host: '127.0.0.1',
    port: 20128,
    label: 'OmniRoute',
    // CC sends sk-local-dev-key (won't accept any other in settings.json — see
    // routing-setup.md). OmniRoute rejects sk-local-dev-key from non-CC callers
    // (raw curl gets AUTH_002). So router swaps to a real OmniRoute-issued key.
    api_key: process.env.OMNIROUTE_API_KEY || 'sk-local-dev-key',
};
const NOTION = {
    host: '127.0.0.1',
    port: 8190,
    label: 'notion-manager',
    api_key: process.env.NOTION_API_KEY || 'sk-local-dev-key',
    default_model: 'opus-4.8',
};

const BIG_BODY_BYTES = 50 * 1024;

function logLine(s) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] ${s}`);
}

// ---------- body inspection (regex only — never JSON.parse) ----------

function peekModel(buf) {
    if (!buf || !buf.length) return null;
    const s = buf.toString('utf8');
    const m = s.match(/"model"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
}

function hasNonEmptyTools(buf) {
    if (!buf || !buf.length) return false;
    const s = buf.toString('utf8');
    const m = s.match(/"tools"\s*:\s*\[([\s\S]*?)\]/);
    if (!m) return false;
    return /\{/.test(m[1]);
}

function hasMedia(buf) {
    if (!buf || !buf.length) return null;
    const s = buf.toString('utf8');
    if (/"type"\s*:\s*"image"/.test(s))    return 'image';
    if (/"type"\s*:\s*"document"/.test(s)) return 'document';
    return null;
}

// ---------- routing decision ----------

function pickRoute(body) {
    const model = peekModel(body);
    const size  = body ? body.length : 0;

    if (hasNonEmptyTools(body)) {
        return { backend: OMNI, reason: 'tools' };
    }
    const media = hasMedia(body);
    if (media) {
        return { backend: OMNI, reason: media };
    }
    if (size > BIG_BODY_BYTES) {
        return { backend: OMNI, reason: `big:${size}b` };
    }

    // Explicit OmniRoute-flavored names
    if (model) {
        const m = model.toLowerCase();
        if (m === 'combowombo' || m.startsWith('combo') ||
            m.startsWith('claude-') || m.startsWith('cc/') || m.startsWith('claude/')) {
            return { backend: OMNI, reason: `model=${model}` };
        }
    }

    // Default: simple / short -> Notion (cheap)
    return {
        backend: NOTION,
        reason: model ? `simple:model=${model}` : 'simple:default',
        rewriteTo: (model && /^opus|^sonnet|^haiku|^gpt|^gemini|^deepseek|^kimi|^minimax/i.test(model))
            ? null
            : NOTION.default_model,
    };
}

// ---------- rewrite only model field (regex, exact-bytes everywhere else) ----------

function rewriteModel(buf, newName) {
    if (!buf || !buf.length) {
        return Buffer.from(JSON.stringify({ model: newName }), 'utf8');
    }
    const s = buf.toString('utf8');
    if (/"model"\s*:\s*"[^"]+"/.test(s)) {
        return Buffer.from(s.replace(/"model"\s*:\s*"[^"]+"/, `"model":"${newName}"`), 'utf8');
    }
    const idx = s.indexOf('{');
    if (idx < 0) return buf;
    return Buffer.from(s.slice(0, idx + 1) + `"model":"${newName}",` + s.slice(idx + 1), 'utf8');
}

// ---------- header handling ----------

// Both backends need their own real API key — CC's sk-local-dev-key only works
// from inside CC itself (some PID/handshake check). Router translates.
function buildHeaders(clientHeaders, backend, bodyLen) {
    const out = {};
    for (const [k, v] of Object.entries(clientHeaders)) {
        const lk = k.toLowerCase();
        if (lk === 'host' || lk === 'content-length' ||
            lk === 'authorization' || lk === 'x-api-key') continue;
        out[k] = v;
    }
    out['host']          = `${backend.host}:${backend.port}`;
    out['authorization'] = 'Bearer ' + backend.api_key;
    out['x-api-key']     = backend.api_key;
    if (bodyLen) out['content-length'] = String(bodyLen);
    return out;
}

// ---------- /v1/models pseudo-list ----------

const EXPOSED_MODELS = [
    { id: 'Auto', object: 'model', created: 0, owned_by: 'smart-router-v3',
      display_name: 'Auto (Notion for simple, OmniRoute for tools/vision)' },
];

function handleModels(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: EXPOSED_MODELS }));
    logLine(`/v1/models -> static`);
}

// ---------- forward with one Notion->Omni fallback ----------

function forward(backend, clientReq, clientRes, body, routeReason, allowFallback) {
    const headers = buildHeaders(clientReq.headers, backend, body.length);
    logLine(`${clientReq.method} ${clientReq.url} [${routeReason}] -> ${backend.label}`);

    const proxyReq = http.request({
        host:    backend.host,
        port:    backend.port,
        method:  clientReq.method,
        path:    clientReq.url,
        headers,
    }, (proxyRes) => {
        const code = proxyRes.statusCode;
        if (allowFallback && backend === NOTION && code >= 500 && !clientRes.headersSent) {
            logLine(`  ${backend.label} ${code} -> fallback to ${OMNI.label}`);
            proxyRes.resume();
            return forward(OMNI, clientReq, clientRes, body, `${routeReason}+fallback`, false);
        }
        try {
            clientRes.writeHead(code, proxyRes.headers);
        } catch (e) {
            logLine(`  writeHead err: ${e.code || e.message}`);
            try { proxyRes.destroy(); } catch {}
            return;
        }
        proxyRes.on('error', (e) => {
            logLine(`  upstream stream err: ${e.code || e.message}`);
            try { clientRes.end(); } catch {}
        });
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
        logLine(`  ${backend.label} req err: ${err.code || err.message}`);
        if (allowFallback && backend === NOTION && !clientRes.headersSent) {
            return forward(OMNI, clientReq, clientRes, body, `${routeReason}+fallback-err`, false);
        }
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({
                error: { message: `smart-router-v3: ${backend.label} failed: ${err.code || err.message}` }
            }));
        }
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
}

// ---------- server ----------

http.createServer((clientReq, clientRes) => {
    if (clientReq.method === 'GET' && clientReq.url.startsWith('/v1/models')) {
        return handleModels(clientRes);
    }

    const chunks = [];
    clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', () => {
        let body = Buffer.concat(chunks);
        const route = pickRoute(body);
        let reason = route.reason;
        if (route.rewriteTo) {
            body = rewriteModel(body, route.rewriteTo);
            reason += `→${route.rewriteTo}`;
        }
        forward(route.backend, clientReq, clientRes, body, reason,
                /*allowFallback=*/ route.backend === NOTION);
    });
    clientReq.on('error', (err) => logLine(`client req err: ${err.message}`));
}).listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`smart-router-v3 on http://localhost:${LISTEN_PORT}`);
    console.log(`  notion :${NOTION.port}   omni :${OMNI.port}`);
    console.log(`  rules: tools|media|big|claude-* -> ${OMNI.label} (headers passthrough)`);
    console.log(`         else                      -> ${NOTION.label} (headers rewritten with notion key)`);
});
