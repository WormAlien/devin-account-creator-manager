// custom-openai-proxy.js — generic Anthropic → OpenAI прокси для Custom-провайдеров
//
// Claude Code шлёт Anthropic-формат (/v1/messages), прокси конвертирует в OpenAI
// chat/completions и отправляет на baseUrl провайдера (OpenAI-совместимый).
// Используется, когда провайдер НЕ говорит по Anthropic API (например bluesminds).
//
// Конфиг — JSON-файл, путь передаётся аргументом argv[2] (пишет transparent-proxy.js):
//   {
//     "port": 20150,
//     "upstream": "https://api.bluesminds.com/v1",
//     "keyFile": "C:\\...\\custom-active-key.txt",
//     "modelMap": { "opus": "z-ai/glm-5.2", "sonnet": "...", "haiku": "..." },
//     "providerName": "BluesMinds"
//   }
// Пустой map-элемент = передавать claude-имя модели как есть.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = process.argv[2];
const DEFAULT_KEY_FILE = path.join(os.homedir(), '.claude', 'custom-active-key.txt');
const MAX_TOKENS_LIMIT = 64000;
const MIN_TOKENS_LIMIT = 1024;
const REQUEST_TIMEOUT_MS = 600000;

let config = null;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
    console.error('[custom proxy] НЕ МОГУ ПРОЧИТАТЬ КОНФИГ:', e.message);
    process.exit(1);
}

const LISTEN_PORT = config.port || 20150;
const UPSTREAM_BASE = String(config.upstream || '').replace(/\/+$/, '');
const ACTIVE_KEY_FILE = config.keyFile || DEFAULT_KEY_FILE;
const MODEL_MAP = config.modelMap || {};
const PROVIDER_NAME = config.providerName || 'Custom';

const upstream = new URL(UPSTREAM_BASE);

function mapModel(claudeModel) {
    const m = String(claudeModel || '').toLowerCase();
    if (m.includes('opus')) return MODEL_MAP.opus || claudeModel;
    if (m.includes('sonnet')) return MODEL_MAP.sonnet || claudeModel;
    if (m.includes('haiku')) return MODEL_MAP.haiku || claudeModel;
    return claudeModel; // прочие — как есть
}

function resolveKey(req) {
    const auth = req.headers['authorization'] || '';
    const fromHeader = req.headers['x-api-key'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (fromHeader && fromHeader.trim() && fromHeader !== 'dummy') return fromHeader.trim();
    try {
        const active = fs.readFileSync(ACTIVE_KEY_FILE, 'utf8').trim();
        if (active) return active;
    } catch {}
    return process.env.OPENAI_API_KEY || '';
}

// ══════════ ANTHROPIC → OPENAI ══════════

function systemToText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
    return '';
}

function contentPartsFromClaude(blocks) {
    const parts = [];
    for (const b of blocks) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source && b.source.type === 'base64') {
            parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        }
    }
    return parts;
}

function toolResultToText(block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => (p && p.type === 'text') ? p.text : (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
    if (c == null) return '';
    return JSON.stringify(c);
}

function convertClaudeToOpenAI(claudeReq) {
    const messages = [];
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
                messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toolResultToText(tr) || '(empty)' });
            }
            const rest = content.filter(b => b.type === 'text' || b.type === 'image');
            if (rest.length) {
                const parts = contentPartsFromClaude(rest);
                const onlyText = parts.every(p => p.type === 'text');
                messages.push({ role: 'user', content: onlyText ? parts.map(p => p.text).join('\n') : parts });
            }
        } else if (msg.role === 'assistant') {
            const texts = content.filter(b => b.type === 'text').map(b => b.text);
            const toolUses = content.filter(b => b.type === 'tool_use');
            const out = { role: 'assistant' };
            out.content = texts.length ? texts.join('\n') : null;
            if (toolUses.length) {
                out.tool_calls = toolUses.map(tu => ({ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }));
            }
            if (out.content !== null || out.tool_calls) messages.push(out);
        }
    }

    const openaiReq = {
        model: mapModel(claudeReq.model),
        messages,
        max_tokens: Math.max(MIN_TOKENS_LIMIT, Math.min(claudeReq.max_tokens || MIN_TOKENS_LIMIT, MAX_TOKENS_LIMIT)),
        stream: !!claudeReq.stream,
    };
    if (claudeReq.stream) openaiReq.stream_options = { include_usage: true };
    if (claudeReq.temperature !== undefined) openaiReq.temperature = claudeReq.temperature;
    if (claudeReq.top_p !== undefined) openaiReq.top_p = claudeReq.top_p;
    if (claudeReq.stop_sequences && claudeReq.stop_sequences.length) openaiReq.stop = claudeReq.stop_sequences;

    if (claudeReq.tools && claudeReq.tools.length) {
        openaiReq.tools = claudeReq.tools.filter(t => t && t.name).map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
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

// ══════════ OPENAI → ANTHROPIC (non-stream) ══════════

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

// ══════════ UPSTREAM CALL ══════════

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

// ══════════ STREAMING ══════════

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
        message: { id: msgId, type: 'message', role: 'assistant', model: claudeReq.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
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
        sseWrite(clientRes, 'content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
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
            usage = { input_tokens: chunk.usage.prompt_tokens || 0, output_tokens: chunk.usage.completion_tokens || 0 };
        }
        if (!choice) return;
        const delta = choice.delta || {};
        if (delta.content) {
            const idx = ensureTextBlock();
            sseWrite(clientRes, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: delta.content } });
        }
        for (const tc of delta.tool_calls || []) {
            const oi = tc.index || 0;
            let tb = toolBlocks.get(oi);
            if (!tb) {
                closeTextBlock();
                tb = { claudeIndex: nextBlockIndex++, id: tc.id || `toolu_${Date.now()}_${oi}`, name: (tc.function && tc.function.name) || '', started: false };
                toolBlocks.set(oi, tb);
            }
            if (tc.id) tb.id = tc.id;
            if (tc.function && tc.function.name) tb.name = tc.function.name;
            if (!tb.started && tb.name) {
                sseWrite(clientRes, 'content_block_start', { type: 'content_block_start', index: tb.claudeIndex, content_block: { type: 'tool_use', id: tb.id, name: tb.name, input: {} } });
                tb.started = true;
            }
            if (tb.started && tc.function && tc.function.arguments) {
                sseWrite(clientRes, 'content_block_delta', { type: 'content_block_delta', index: tb.claudeIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
            }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    function finish() {
        closeTextBlock();
        for (const tb of toolBlocks.values()) {
            if (tb.started) sseWrite(clientRes, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
        }
        sseWrite(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
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

// ══════════ HANDLERS ══════════

const stats = { requests: 0, streamed: 0, errors: 0, lastModel: '', started: new Date().toISOString() };

function writeJSON(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization',
    });
    res.end(JSON.stringify(obj));
}
function claudeError(res, code, message, errType) {
    stats.errors++;
    writeJSON(res, code, { type: 'error', error: { type: errType || 'api_error', message } });
}
const { createLogger } = require('./proxy-logger.js');
const { logLine } = createLogger('custom-oa');

function handleMessages(req, res, body) {
    let claudeReq;
    try { claudeReq = JSON.parse(body); }
    catch (e) { return claudeError(res, 400, 'invalid JSON: ' + e.message, 'invalid_request_error'); }

    const apiKey = resolveKey(req);
    if (!apiKey) return claudeError(res, 401, 'Нет ключа ' + PROVIDER_NAME, 'authentication_error');

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
                try { writeJSON(res, 200, convertOpenAIToClaude(JSON.parse(b), claudeReq)); }
                catch (e) { claudeError(res, 502, 'bad upstream response: ' + e.message); }
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

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization' });
        return res.end();
    }
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (url === '/health' || url === '/__custom/api/status')) {
        return writeJSON(res, 200, { ok: true, provider: PROVIDER_NAME, upstream: UPSTREAM_BASE, port: LISTEN_PORT, modelMap: MODEL_MAP, stats, keyFile: ACTIVE_KEY_FILE });
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
    logLine(`[Custom OpenAI Proxy] ${PROVIDER_NAME} :${LISTEN_PORT} → ${UPSTREAM_BASE}`);
    logLine(`  mapping: opus→${MODEL_MAP.opus || '(pass-through)'}, sonnet→${MODEL_MAP.sonnet || '(pass-through)'}, haiku→${MODEL_MAP.haiku || '(pass-through)'}`);
    logLine(`  key: client header → ${ACTIVE_KEY_FILE}`);
    logLine(`  status: http://localhost:${LISTEN_PORT}/__custom/api/status`);
});
