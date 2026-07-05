// ourtoken/add-to-omniroute.js
// Добавляет ourtoken-аккаунт в OmniRoute через HTTP Management API.
//
// Требует routing/.env или env:
//   OMNIROUTE_API_KEY  — ключ со scope manage
//   OMNIROUTE_BASE_URL — http://localhost:20128 по умолчанию
//
// Запуск: node ourtoken/add-to-omniroute.js <email> <apiKey>

const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;
const ENV_FILE = path.join(BASE_DIR, '..', 'routing', '.env');
const OURTOKEN_BASE_URL = 'https://api.ourtoken.ai/v1';
const DEFAULT_NODE_ID = 'anthropic-compatible-bfe8d930-e4ee-4f61-9101-fc660fbd42da';

function loadEnvFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const text = fs.readFileSync(filePath, 'utf-8');
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.substring(0, eq).trim();
            const val = trimmed.substring(eq + 1).trim().replace(/^["']|["']$/g, '');
            if (key && process.env[key] === undefined) process.env[key] = val;
        }
    } catch {}
}
loadEnvFile(ENV_FILE);

const OMNI_BASE_URL = (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128').replace(/\/$/, '');
const OMNI_API_KEY = process.env.OMNIROUTE_API_KEY || '';
const OURTOKEN_NODE = process.env.OMNI_OURTOKEN_NODE || DEFAULT_NODE_ID;

function log(tag, msg) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] [${tag}] ${msg}`);
}

function maskKey(k) {
    if (!k || k.length < 12) return '—';
    return k.substring(0, 8) + '***' + k.slice(-4);
}

async function apiRequest(method, endpoint, payload) {
    const url = new URL(endpoint, OMNI_BASE_URL);
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OMNI_API_KEY}`,
    };
    const body = payload ? JSON.stringify(payload) : undefined;
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, data, text };
}

function nodeMatchesOurtoken(n) {
    const name = String(n.name || n.nodeName || n.id || '').toLowerCase();
    const base = String(n.baseUrl || n.base_url || n.apiBaseUrl || '').replace(/\/$/, '');
    return n.id === OURTOKEN_NODE || name.includes('ourtoken') || base === OURTOKEN_BASE_URL;
}

async function findOurtokenNode() {
    const res = await apiRequest('GET', '/api/provider-nodes');
    if (!res.ok) {
        throw new Error(`failed to list provider nodes: ${res.status} ${res.text.substring(0, 200)}`);
    }
    const nodes = res.data?.nodes || [];
    return nodes.find(n => n.id === OURTOKEN_NODE) || nodes.find(nodeMatchesOurtoken) || { id: OURTOKEN_NODE };
}

async function listExistingConnections() {
    const res = await apiRequest('GET', '/api/providers');
    if (!res.ok) {
        throw new Error(`failed to list providers: ${res.status} ${res.text.substring(0, 200)}`);
    }
    return res.data?.connections || [];
}

async function testProvider(id) {
    const res = await apiRequest('POST', `/api/providers/${id}/test`, {
        validationModelId: process.env.OMNI_OURTOKEN_TEST_MODEL || 'claude-sonnet-4-6',
    });
    return res.ok && res.data?.valid === true;
}

async function forceActivateProvider(id) {
    const res = await apiRequest('PUT', `/api/providers/${id}`, {
        testStatus: 'active',
        lastError: null,
        lastErrorAt: null,
        lastErrorType: null,
        lastErrorSource: null,
        errorCode: null,
        lastTested: new Date().toISOString(),
    });
    if (!res.ok) throw new Error(`activate failed: ${res.status} ${res.text.substring(0, 200)}`);
}

async function activateCreatedConnection(c) {
    let valid = false;
    try {
        valid = await testProvider(c.id);
    } catch {}
    log('test', `${c.name || c.id} -> ${valid ? 'active' : 'test failed'}`);
    if (!valid) {
        try {
            await forceActivateProvider(c.id);
            log('activate', `${c.name || c.id} -> forced active`);
        } catch (err) {
            log('warn', `${c.name || c.id} -> force activate failed: ${err.message}`);
        }
    }
}

async function main() {
    const [emailArg, apiKey] = process.argv.slice(2);
    const email = String(emailArg || '').trim();
    if (!email || !apiKey) {
        console.error(JSON.stringify({ ok: false, error: 'usage: node add-to-omniroute.js <email> <apiKey>' }));
        process.exit(1);
    }
    if (!OMNI_API_KEY) {
        console.error(JSON.stringify({ ok: false, error: 'OMNIROUTE_API_KEY with manage scope is required in routing/.env' }));
        process.exit(1);
    }

    const node = await findOurtokenNode();
    const existing = await listExistingConnections();
    const already = existing.find(c =>
        c.provider === node.id && (c.email === email || c.name === email || c.apiKey?.startsWith(apiKey.substring(0, 8)))
    );
    if (already) {
        log('exists', `${email} already in OmniRoute as ${already.id}`);
        console.log(JSON.stringify({ ok: true, id: already.id, action: 'exists', email }));
        return;
    }

    const res = await apiRequest('POST', '/api/providers/bulk', {
        provider: node.id,
        entries: [{ name: email, apiKey }],
        priority: 1,
        validateKeys: false,
    });
    if (!res.ok) {
        throw new Error(`bulk add failed: ${res.status} ${res.text.substring(0, 300)}`);
    }

    const created = res.data?.created || [];
    const errors = res.data?.errors || [];
    if (errors.length) {
        throw new Error(`add failed: ${errors.map(e => e.message || JSON.stringify(e)).join('; ')}`);
    }
    const connection = created[0];
    if (!connection?.id) {
        throw new Error('OmniRoute did not return created connection id');
    }

    log('added', `${email} -> ${maskKey(apiKey)} as ${connection.id}`);
    await activateCreatedConnection(connection);
    console.log(JSON.stringify({ ok: true, id: connection.id, email, action: 'added' }));
}

main().catch(err => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
});
