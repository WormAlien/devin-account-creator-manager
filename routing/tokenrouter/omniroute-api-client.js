// routing/tokenrouter/omniroute-api-client.js
// Официальный API-клиент для добавления TokenRouter-аккаунтов в OmniRoute.
//
// Требует переменных окружения (или routing/.env):
//   OMNIROUTE_API_KEY      — ключ с scope "manage"
//   OMNIROUTE_BASE_URL     — http://localhost:20128 (по умолчанию)
//
// Использование:
//   node omniroute-api-client.js                    -- импортировать всё из accounts.json
//   node omniroute-api-client.js <email> <apiKey>   -- добавить один аккаунт
//
const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;
const ACCOUNTS_FILE = path.join(BASE_DIR, 'accounts.json');
const ENV_FILE = path.join(BASE_DIR, '..', '.env');

// Простой .env loader (переменные окружения имеют приоритет)
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
    } catch (e) {
        // ignore
    }
}
loadEnvFile(ENV_FILE);

const OMNI_BASE_URL = (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128').replace(/\/$/, '');
const OMNI_API_KEY = process.env.OMNIROUTE_API_KEY || '';
const TOKENROUTER_NODE = process.env.OMNI_PROVIDER_NODE || 'openai-compatible-chat-8f2ae822-58f2-49b4-b212-393f686b00c5';
const DRY_RUN = process.argv.includes('--dry-run');

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

async function findTokenrouterNode() {
    const res = await apiRequest('GET', '/api/provider-nodes');
    if (!res.ok) return null;
    const nodes = res.data?.nodes || [];
    return nodes.find(n => n.id === TOKENROUTER_NODE)
        || nodes.find(n => n.name === 'tokenrouter.me' || n.baseUrl === 'https://tokenrouter.me/v1' || n.base_url === 'https://tokenrouter.me/v1');
}

async function listExistingConnections() {
    const res = await apiRequest('GET', '/api/providers');
    if (!res.ok) {
        throw new Error(`failed to list providers: ${res.status} ${res.text.substring(0, 200)}`);
    }
    return res.data?.connections || [];
}

function accountName(acc) {
    return acc.email || acc.apiKeyName || 'unknown';
}

async function testProvider(id) {
    const res = await apiRequest('POST', `/api/providers/${id}/test`, {
        validationModelId: 'deepseek-v4-flash',
    });
    if (!res.ok) return false;
    return res.data?.valid === true;
}

async function forceActivateProvider(id) {
    const body = {
        testStatus: 'active',
        lastError: null,
        lastErrorAt: null,
        lastErrorType: null,
        lastErrorSource: null,
        errorCode: null,
        lastTested: new Date().toISOString(),
    };
    const res = await apiRequest('PUT', `/api/providers/${id}`, body);
    if (!res.ok) {
        throw new Error(`activate failed: ${res.status} ${res.text.substring(0, 200)}`);
    }
    return res.data;
}

async function activateCreatedConnection(c) {
    const name = c.name || c.id;
    let valid = false;
    try {
        valid = await testProvider(c.id);
    } catch (err) {
        // treat any test exception as a failure and force activation
    }

    log('test', `${name} -> ${valid ? 'active' : 'test failed'}`);

    if (!valid) {
        try {
            await forceActivateProvider(c.id);
        } catch (err) {
            log('err', `${name} -> force activate failed: ${err.message}`);
            return;
        }
    }

    log('activate', `${name} -> ${valid ? 'via test' : 'forced active'}`);
}

async function addAccountsToOmniRoute(accounts, { validateKeys = false } = {}) {
    if (!OMNI_API_KEY) {
        throw new Error('OMNIROUTE_API_KEY env var is required');
    }

    const node = await findTokenrouterNode();
    if (!node) {
        throw new Error('TokenRouter provider node not found in OmniRoute');
    }

    const existing = await listExistingConnections();
    const existingNames = new Set(existing.map(c => c.name).filter(Boolean));

    const entries = [];
    const skipped = [];
    for (const acc of accounts) {
        if (!acc.apiKey) {
            skipped.push({ account: acc, reason: 'no apiKey' });
            continue;
        }
        const name = accountName(acc);
        if (existingNames.has(name)) {
            skipped.push({ account: acc, reason: 'name already exists' });
            continue;
        }
        entries.push({ name, apiKey: acc.apiKey });
    }

    if (entries.length === 0) {
        return { added: 0, skipped: skipped.length, errors: 0, created: [] };
    }

    if (DRY_RUN) {
        for (const e of entries) log('dry', `${e.name} -> ${maskKey(e.apiKey)}`);
        return { added: entries.length, skipped: skipped.length, errors: 0, created: entries };
    }

    const res = await apiRequest('POST', '/api/providers/bulk', {
        provider: node.id,
        entries,
        priority: 1,
        validateKeys,
    });

    if (!res.ok) {
        throw new Error(`bulk add failed: ${res.status} ${res.text.substring(0, 300)}`);
    }

    const created = res.data?.created || [];
    const errors = res.data?.errors || [];

    for (const c of created) log('add', `${c.name || c.id} -> ${c.id}`);
    for (const e of errors) log('err', `${e.name}: ${e.message}`);

    for (const c of created) {
        await activateCreatedConnection(c);
    }

    return {
        added: created.length,
        skipped: skipped.length + (entries.length - created.length - errors.length),
        errors: errors.length,
        created,
    };
}

async function addAccountToOmniRoute(account, opts = {}) {
    return addAccountsToOmniRoute([account], opts);
}

async function importAllTokenrouterAccounts(opts = {}) {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
        throw new Error('accounts.json not found: ' + ACCOUNTS_FILE);
    }
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (!Array.isArray(accounts) || !accounts.length) {
        throw new Error('no accounts in accounts.json');
    }
    return addAccountsToOmniRoute(accounts, opts);
}

async function main() {
    const args = process.argv.slice(2).filter(a => a !== '--dry-run');

    if (args.length === 2) {
        const [email, apiKey] = args;
        const res = await addAccountToOmniRoute({ email, apiKey });
        log('done', `added: ${res.added}, skipped: ${res.skipped}, errors: ${res.errors}`);
        return;
    }

    if (args.length !== 0) {
        console.error('Usage: node omniroute-api-client.js [email] [apiKey] [--dry-run]');
        process.exit(1);
    }

    const res = await importAllTokenrouterAccounts();
    log('done', `added: ${res.added}, skipped: ${res.skipped}, errors: ${res.errors}`);
}

module.exports = {
    addAccountToOmniRoute,
    addAccountsToOmniRoute,
    importAllTokenrouterAccounts,
};

if (require.main === module) {
    main().catch(e => {
        console.error('Fatal:', e.message);
        process.exit(1);
    });
}
