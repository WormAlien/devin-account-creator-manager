// vyceai-openai-proxy.js — Anthropic → OpenAI прокси для VyceAI
//
// Claude Code шлёт Anthropic-формат (/v1/messages),
// прокси конвертирует в OpenAI chat/completions и отправляет на
// https://vyceai.com/v1 — OpenAI-совместимый endpoint VyceAI.
//
// Слушает :20131. Ключ берётся (по приоритету):
//   1. из заголовка клиента (x-api-key / Authorization: Bearer) — его пишет
//      transparent-proxy в settings.json при переключении на vyce_openai;
//   2. из ~/.claude/vyceai-active-key.txt (что активировано в дашборде);
//   3. первый ключ из vyceai/keys.json (или legacy keys.txt);
//   4. из env OPENAI_API_KEY.
//
// Маппинг моделей (claude-* → vyce-*) — vyceai/config.js:
//   opus → claude-sonnet-5, sonnet → claude-sonnet-4-6, haiku → claude-haiku-4-5
// Не-claude модели (gpt-*, o1-*) проходят как есть.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const LISTEN_PORT = 20131;
const UPSTREAM_BASE = 'https://vyceai.com/v1';
const KEYS_FILE = path.join(__dirname, '..', 'vyceai', 'keys.json');
const LEGACY_KEYS_FILE = path.join(__dirname, '..', 'vyceai', 'keys.txt');
const ACTIVE_KEY_FILE = path.join(require('os').homedir(), '.claude', 'vyceai-active-key.txt');
const VYCE_CONFIG_FILE = path.join(__dirname, '..', 'vyceai', 'config.js');
const MAX_TOKENS_LIMIT = 64000;
const MIN_TOKENS_LIMIT = 1024;
const REQUEST_TIMEOUT_MS = 600000;

const upstream = new URL(UPSTREAM_BASE);

// ══════════════════════ CONFIG (model mapping) ══════════════════════

const DEFAULT_MODEL_MAP = {
    'opus': 'claude-sonnet-5',
    'sonnet': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5',
};

const configCache = { data: null, mtime: 0 };

function getConfig() {
    try {
        const st = fs.statSync(VYCE_CONFIG_FILE);
        if (st.mtimeMs !== configCache.mtime) {
            const raw = require(VYCE_CONFIG_FILE);
            configCache.data = {
                MODEL_MAP: raw.MODEL_MAP || DEFAULT_MODEL_MAP,
                MAX_TOKENS_LIMIT: raw.MAX_TOKENS_LIMIT || MAX_TOKENS_LIMIT,
            };
            configCache.mtime = st.mtimeMs;
            const map = configCache.data.MODEL_MAP;
            logLine(`config reloaded: opus→${map.opus} sonnet→${map.sonnet} haiku→${map.haiku}`);
        }
    } catch { /* нет файла — дефолты */ }
    if (!configCache.data) configCache.data = { MODEL_MAP: DEFAULT_MODEL_MAP, MAX_TOKENS_LIMIT };
    return configCache.data;
}

function mapModel(claudeModel) {
    const cfg = getConfig();
    const m = String(claudeModel || '').toLowerCase();
    if (m.includes('opus')) return cfg.MODEL_MAP.opus;
    if (m.includes('sonnet')) return cfg.MODEL_MAP.sonnet;
    if (m.includes('haiku')) return cfg.MODEL_MAP.haiku;
    return claudeModel; // gpt-*, o1-* и прочие — как есть
}

// ══════════════════════ KEY RESOLUTION ══════════════════════

function resolveKey(req) {
    const auth = req.headers['authorization'] || '';
    const fromHeader = req.headers['x-api-key'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (fromHeader && fromHeader.trim() && fromHeader !== 'dummy') return fromHeader.trim();

    // Активный ключ из дашборда — не зависит от порядка в keys.json.
    try {
        const active = fs.readFileSync(ACTIVE_KEY_FILE, 'utf8').trim();
        if (active.startsWith('sk-')) return active;
    } catch {}

    // vyceai/keys.json — первый ключ в пуле
    try {
        const arr = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
        const first = (Array.isArray(arr) ? arr : []).find(e => e && typeof e.key === 'string' && e.key.startsWith('sk-'));
        if (first) return first.key;
    } catch {}

    // legacy плоский keys.txt
    try {
        const lines = fs.readFileSync(LEGACY_KEYS_FILE, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const k = line.trim();
            if (k && k.startsWith('sk-')) return k;
        }
    } catch {}

    return process.env.OPENAI_API_KEY || '';
}

// ══════════════════════ ANTHROPIC → OPENAI ══════════════════════

function systemToText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
    }
    return '';
}

function contentPartsFromClaude(blocks) {
    const parts = [];
    for (const b of blocks) {
        if (b.type === 'text') {
            parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image' && b.source && b.source.type === 'base64') {
            parts.push({
                type: 'image_url',
                image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
            });
        }
    }
    return parts;
}

function toolResultToText(block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c.map(p => (p && p.type === 'text') ? p.text : (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
    }
    if (c == null) return '';
    return JSON.stringify(c);
}

function convertClaudeToOpenAI(claudeReq) {
    const messages = [];
    const cfg = getConfig();

    const sys = systemToText(claudeReq.system);
    if (sys) messages.push({ role: 'system', content: sys });

    for (const msg of claudeReq.messages || []) {
        const content = msg.content;

        if (typeof content === 'string') {
            messages.push({ role: msg.role, content });
            continue;
        }
        if (!Array.isArray(content)) continue;

        if (msg.role === 'user') {
            const toolResults = content.filter(b => b.type === 'tool_result');
            for (const tr of toolResults) {
                messages.push({
                    role: 'tool',
                    tool_call_id: tr.tool_use_id,
                    content: toolResultToText(tr) || '(empty)',
                });
            }
            const rest = content.filter(b => b.type === 'text' || b.type === 'image');
            if (rest.length) {
                const parts = contentPartsFromClaude(rest);
                const onlyText = parts.every(p => p.type === 'text');
                messages.push({
                    role: 'user',
                    content: onlyText ? parts.map(p => p.text).join('\n') : parts,
                });
            }
        } else if (msg.role === 'assistant') {
            const texts = content.filter(b => b.type === 'text').map(b => b.text);
            const toolUses = content.filter(b => b.type === 'tool_use');
            const out = { role: 'assistant' };
            out.content = texts.length ? texts.join('\n') : null;
            if (toolUses.length) {
                out.tool_calls = toolUses.map(tu => ({
                    id: tu.id,
                    type: 'function',
                    function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
                }));
            }
            if (out.content !== null || out.tool_calls) messages.push(out);
        }
    }

    const openaiReq = {
        model: mapModel(claudeReq.model),
        messages,
        max_tokens: Math.max(MIN_TOKENS_LIMIT, Math.min(claudeReq.max_tokens || MIN_TOKENS_LIMIT, cfg.MAX_TOKENS_LIMIT)),
        stream: !!claudeReq.stream,
    };
    if (claudeReq.stream) openaiReq.stream_options = { include_usage: true };
    if (claudeReq.temperature !== undefined) openaiReq.temperature = claudeReq.temperature;
    if (claudeReq.top_p !== undefined) openaiReq.top_p = claudeReq.top_p;
    if (claudeReq.stop_sequences && claudeReq.stop_sequences.length) openaiReq.stop = claudeReq.stop_sequences;

    if (claudeReq.tools && claudeReq.tools.length) {
        openaiReq.tools = claudeReq.tools
            .filter(t => t && t.name)
            .map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description || '',
                    parameters: t.input_schema || { type: 'object', properties: {} },
                },
            }));
    }
    if (claudeReq.tool_choice) {
        const tc = claudeReq.tool_choice;
        if (tc.type === 'auto') openaiReq.tool_choice = 'auto';
        else if (tc.type === 'any') openaiReq.tool_choice = 'required';
        else if (tc.type === 'tool' && tc.name) openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    }

    return openaiReq;
}

// ══════════════════════ OPENAI → ANTHROPIC (non-stream) ══════════════════════

function mapStopReason(finishReason) {
    switch (finishReason) {
        case 'length': return 'max_tokens';
        case 'tool_calls': case 'function_call': return 'tool_use';
        case 'stop': default: return 'end_turn';
    }
}

function convertOpenAIToClaude(openaiResp, claudeReq) {
    const choice = (openaiResp.choices && openaiResp.choices[0]) || {};
    const msg = choice.message || {};
    const content = [];

    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const tc of msg.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    if (!content.length) content.push({ type: 'text', text: '' });

    return {
        id: openaiResp.id ? openaiResp.id.replace(/^chatcmpl/, 'msg') : `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: claudeReq.model,
        content,
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: (openaiResp.usage && openaiResp.usage.prompt_tokens) || 0,
            output_tokens: (openaiResp.usage && openaiResp.usage.completion_tokens) || 0,
        },
    };
}

// ══════════════════════ UPSTREAM CALL ══════════════════════

function upstreamRequest(pathSuffix, apiKey, body, onResponse, onError) {
    const bodyStr = body ? JSON.stringify(body) : null;
    const isHttps = upstream.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
        hostname: upstream.hostname,
        port: upstream.port || (isHttps ? 443 : 80),
        path: upstream.pathname.replace(/\/$/, '') + pathSuffix,
        method: body ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
        timeout: REQUEST_TIMEOUT_MS,
    }, onResponse);
    req.on('error', onError);
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
    return req;
}

// ══════════════════════ STREAMING: OpenAI SSE → Claude SSE ══════════════════════

function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function handleStreaming(clientRes, upstreamRes, claudeReq) {
    clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sseWrite(clientRes, 'message_start', {
        type: 'message_start',
        message: {
            id: msgId, type: 'message', role: 'assistant', model: claudeReq.model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
    });
    sseWrite(clientRes, 'ping', { type: 'ping' });

    let nextBlockIndex = 0;
    let textBlockIndex = null;
    const toolBlocks = new Map();
    let finishReason = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    let buffer = '';

    function ensureTextBlock() {
        if (textBlockIndex !== null) return textBlockIndex;
        textBlockIndex = nextBlockIndex++;
        sseWrite(clientRes, 'content_block_start', {
            type: 'content_block_start', index: textBlockIndex,
            content_block: { type: 'text', text: '' },
        });
        return textBlockIndex;
    }

    function closeTextBlock() {
        if (textBlockIndex === null) return;
        sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
        textBlockIndex = null;
    }

    function processChunk(chunk) {
        const choice = (chunk.choices && chunk.choices[0]) || null;
        if (chunk.usage) {
            usage = {
                input_tokens: chunk.usage.prompt_tokens || 0,
                output_tokens: chunk.usage.completion_tokens || 0,
            };
        }
        if (!choice) return;
        const delta = choice.delta || {};

        if (delta.content) {
            const idx = ensureTextBlock();
            sseWrite(clientRes, 'content_block_delta', {
                type: 'content_block_delta', index: idx,
                delta: { type: 'text_delta', text: delta.content },
            });
        }

        for (const tc of delta.tool_calls || []) {
            const oi = tc.index || 0;
            let tb = toolBlocks.get(oi);
            if (!tb) {
                closeTextBlock();
                tb = {
                    claudeIndex: nextBlockIndex++,
                    id: tc.id || `toolu_${Date.now()}_${oi}`,
                    name: (tc.function && tc.function.name) || '',
                    started: false,
                };
                toolBlocks.set(oi, tb);
            }
            if (tc.id) tb.id = tc.id;
            if (tc.function && tc.function.name) tb.name = tc.function.name;
            if (!tb.started && tb.name) {
                sseWrite(clientRes, 'content_block_start', {
                    type: 'content_block_start', index: tb.claudeIndex,
                    content_block: { type: 'tool_use', id: tb.id, name: tb.name, input: {} },
                });
                tb.started = true;
            }
            if (tb.started && tc.function && tc.function.arguments) {
                sseWrite(clientRes, 'content_block_delta', {
                    type: 'content_block_delta', index: tb.claudeIndex,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                });
            }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    function finish() {
        closeTextBlock();
        for (const tb of toolBlocks.values()) {
            if (tb.started) sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
        }
        sseWrite(clientRes, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
            usage: { output_tokens: usage.output_tokens },
        });
        sseWrite(clientRes, 'message_stop', { type: 'message_stop' });
        clientRes.end();
    }

    upstreamRes.on('data', (data) => {
        buffer += data.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try { processChunk(JSON.parse(payload)); } catch {}
        }
    });
    upstreamRes.on('end', finish);
    upstreamRes.on('error', () => {
        try {
            sseWrite(clientRes, 'error', { type: 'error', error: { type: 'api_error', message: 'upstream stream error' } });
            clientRes.end();
        } catch {}
    });
}

// ══════════════════════ HANDLERS ══════════════════════

const stats = { requests: 0, streamed: 0, errors: 0, lastModel: '', started: new Date().toISOString() };

function claudeError(res, code, message, errType) {
    stats.errors++;
    writeJSON(res, code, { type: 'error', error: { type: errType || 'api_error', message } });
}

function handleMessages(req, res, body) {
    let claudeReq;
    try { claudeReq = JSON.parse(body); }
    catch (e) { return claudeError(res, 400, 'invalid JSON: ' + e.message, 'invalid_request_error'); }

    const apiKey = resolveKey(req);
    if (!apiKey) return claudeError(res, 401, 'Нет ключа VyceAI', 'authentication_error');

    let openaiReq;
    try { openaiReq = convertClaudeToOpenAI(claudeReq); }
    catch (e) { return claudeError(res, 400, 'convert failed: ' + e.message, 'invalid_request_error'); }

    stats.requests++;
    stats.lastModel = `${claudeReq.model} → ${openaiReq.model}`;
    logLine(`/v1/messages ${claudeReq.model} → ${openaiReq.model} stream=${!!claudeReq.stream} msgs=${openaiReq.messages.length} tools=${(openaiReq.tools || []).length}`);

    const upReq = upstreamRequest('/chat/completions', apiKey, openaiReq, (upRes) => {
        if (upRes.statusCode !== 200) {
            let errBody = '';
            upRes.on('data', c => errBody += c);
            upRes.on('end', () => {
                let message = errBody.slice(0, 500);
                try { message = JSON.parse(errBody).error?.message || message; } catch {}
                logLine(`upstream ${upRes.statusCode}: ${message.slice(0, 200)}`);
                const errType = upRes.statusCode === 401 ? 'authentication_error'
                    : upRes.statusCode === 429 ? 'rate_limit_error'
                    : upRes.statusCode >= 500 ? 'api_error' : 'invalid_request_error';
                claudeError(res, upRes.statusCode, message, errType);
            });
            return;
        }
        if (claudeReq.stream) {
            stats.streamed++;
            handleStreaming(res, upRes, claudeReq);
        } else {
            let b = '';
            upRes.on('data', c => b += c);
            upRes.on('end', () => {
                try {
                    writeJSON(res, 200, convertOpenAIToClaude(JSON.parse(b), claudeReq));
                } catch (e) {
                    claudeError(res, 502, 'bad upstream response: ' + e.message);
                }
            });
        }
    }, (err) => {
        logLine(`upstream error: ${err.message}`);
        claudeError(res, 502, 'upstream: ' + err.message);
    });

    res.on('close', () => { if (!res.writableEnded) upReq.destroy(); });
}

function handleCountTokens(res, body) {
    try {
        const r = JSON.parse(body);
        let chars = systemToText(r.system).length;
        for (const m of r.messages || []) {
            if (typeof m.content === 'string') chars += m.content.length;
            else if (Array.isArray(m.content)) {
                for (const b of m.content) chars += (b.text || '').length + (b.type === 'tool_use' ? JSON.stringify(b.input || {}).length : 0);
            }
        }
        writeJSON(res, 200, { input_tokens: Math.max(1, Math.ceil(chars / 4)) });
    } catch (e) {
        claudeError(res, 400, e.message, 'invalid_request_error');
    }
}

function handleModels(req, res) {
    const apiKey = resolveKey(req);
    upstreamRequest('/models', apiKey, null, (upRes) => {
        let b = '';
        upRes.on('data', c => b += c);
        upRes.on('end', () => {
            res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(b);
        });
    }, (err) => claudeError(res, 502, 'upstream: ' + err.message));
}

// ══════════════════════ HELPERS / SERVER ══════════════════════

function writeJSON(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization',
    });
    res.end(JSON.stringify(obj));
}

const { createLogger } = require('./proxy-logger.js');
const { logLine } = createLogger('vyce');

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization',
        });
        return res.end();
    }

    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && (url === '/health' || url === '/__vyceai/api/status')) {
        return writeJSON(res, 200, {
            ok: true, upstream: UPSTREAM_BASE, port: LISTEN_PORT,
            mapping: getConfig().MODEL_MAP, stats,
            keySource: 'header → vyceai-active-key.txt → vyceai/keys.json → env OPENAI_API_KEY',
        });
    }
    if (req.method === 'GET' && url === '/v1/models') return handleModels(req, res);

    if (req.method === 'POST') {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => {
            if (url === '/v1/messages') return handleMessages(req, res, b);
            if (url === '/v1/messages/count_tokens') return handleCountTokens(res, b);
            claudeError(res, 404, 'unknown endpoint: ' + url, 'not_found_error');
        });
        return;
    }

    claudeError(res, 404, 'not found', 'not_found_error');
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
    const cfg = getConfig();
    const map = cfg.MODEL_MAP;
    console.log(`[VyceAI OpenAI Proxy] :${LISTEN_PORT} → ${UPSTREAM_BASE}`);
    console.log(`  mapping: opus→${map.opus}, sonnet→${map.sonnet}, haiku→${map.haiku}`);
    console.log(`  key: client header → vyceai-active-key.txt → vyceai/keys.json → env OPENAI_API_KEY`);
    console.log(`  status: http://localhost:${LISTEN_PORT}/__vyceai/api/status`);
});
