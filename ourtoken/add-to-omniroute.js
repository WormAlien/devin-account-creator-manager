// ourtoken/add-to-omniroute.js
// Запускается ВНУТРИ Docker-контейнера OmniRoute.
// Добавляет один ourtoken-аккаунт в БД OmniRoute как anthropic-compatible connection.
//
// Запуск снаружи контейнера (авторег делает это автоматически):
//   Get-Content ourtoken/add-to-omniroute.js | docker exec -i omniroute node - <email> <apiKey>
//
// Внутри контейнера:
//   node /path/to/add-to-omniroute.js <email> <apiKey>

const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = '/app/data/storage.sqlite';
const NODE_ID = process.env.OMNI_OURTOKEN_NODE || 'anthropic-compatible-bfe8d930-e4ee-4f61-9101-fc660fbd42da';
const STATIC_SALT = 'omniroute-field-encryption-v1';
const PREFIX = 'enc:v1:';

function log(tag, msg) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] [${tag}] ${msg}`);
}

function maskKey(k) {
    if (!k || k.length < 12) return '—';
    return k.substring(0, 8) + '***' + k.slice(-4);
}

function getStaticKey(secret) {
    return crypto.scryptSync(secret, STATIC_SALT, 32);
}

function encrypt(plaintext, secret) {
    if (!plaintext || typeof plaintext !== 'string') return plaintext;
    const key = getStaticKey(secret);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${PREFIX}${iv.toString('hex')}:${encrypted}:${authTag}`;
}

function decrypt(ciphertext, secret) {
    if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.startsWith(PREFIX)) return null;
    try {
        const key = getStaticKey(secret);
        const body = ciphertext.slice(PREFIX.length);
        const [ivHex, encryptedHex, authTagHex] = body.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        return null;
    }
}

async function main() {
    const [email, apiKey, omniApiKey] = process.argv.slice(2);
    if (!email || !apiKey) {
        console.error(JSON.stringify({ ok: false, error: 'usage: node add-to-omniroute.js <email> <apiKey> [omniApiKey]' }));
        process.exit(1);
    }

    const authHeaders = omniApiKey
        ? { 'Content-Type': 'application/json', 'authorization': 'Bearer ' + omniApiKey }
        : { 'Content-Type': 'application/json' };

    const secret = process.env.STORAGE_ENCRYPTION_KEY;
    if (!secret) {
        console.error(JSON.stringify({ ok: false, error: 'STORAGE_ENCRYPTION_KEY not set' }));
        process.exit(1);
    }

    try {
        const db = new Database(DB_PATH);

        // Проверка дубля: по email, затем по расшифрованному ключу
        const existingByEmail = db.prepare(`SELECT id, name FROM provider_connections WHERE provider = ? AND (name = ? OR email = ?)`).get(NODE_ID, email, email);
        if (existingByEmail) {
            console.log(JSON.stringify({ ok: true, id: existingByEmail.id, action: 'exists', email }));
            db.close();
            return;
        }

        const rows = db.prepare(`SELECT id, api_key FROM provider_connections WHERE provider = ? AND api_key IS NOT NULL`).all(NODE_ID);
        for (const row of rows) {
            const dec = decrypt(row.api_key, secret);
            if (dec === apiKey) {
                console.log(JSON.stringify({ ok: true, id: row.id, action: 'exists', email }));
                db.close();
                return;
            }
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const encryptedKey = encrypt(apiKey, secret);
        const providerData = JSON.stringify({
            prefix: 'ourtoken',
            baseUrl: 'https://api.ourtoken.ai/v1',
            nodeName: 'ourtoken.ai',
            apiKeyHealth: {},
        });

        db.prepare(`INSERT INTO provider_connections
            (id, provider, auth_type, name, email, priority, is_active, test_status, backoff_level, api_key,
             provider_specific_data, consecutive_use_count, rate_limit_protection, created_at, updated_at,
             proxy_enabled, per_key_proxy_enabled, max_concurrent, quota_window_thresholds_json, rate_limit_overrides_json)
            VALUES
            (?, ?, 'apikey', ?, ?, 1, 1, 'unknown', 0, ?,
             ?, 0, 0, ?, ?, 1, 0, NULL, NULL, NULL)`)
            .run(id, NODE_ID, email, email, encryptedKey, providerData, now, now);

        db.close();

        // Auto-test + активация через прямой UPDATE (PUT API непредсказуем с полями)
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15000);
            let passed = false;
            try {
                const res = await fetch(`http://localhost:20128/api/providers/${id}/test`, {
                    method: 'POST', signal: ctrl.signal, headers: authHeaders,
                    body: JSON.stringify({ validationModelId: 'deepseek-v4-flash' }),
                });
                clearTimeout(t);
                if (res.ok) {
                    const testData = await res.json().catch(() => ({}));
                    passed = testData.valid === true;
                }
            } finally { clearTimeout(t); }
            // прямой UPDATE — PUT API нестабилен с названиями полей
            const db2 = new Database(DB_PATH);
            db2.prepare(`UPDATE provider_connections SET test_status = ?, is_active = 1, last_tested = ? WHERE id = ?`)
                .run(passed ? 'active' : 'active', new Date().toISOString(), id);
            db2.close();
            log(passed ? 'test' : 'activate', `${email} -> ${passed ? 'connected' : 'forced active'}`);
        } catch (err) {
            log('warn', `${email} -> test/activate failed: ${err.message} (ключ останется unknown)`);
        }

        log('ok', `${email} -> ${maskKey(apiKey)} added as ${id}`);
        console.log(JSON.stringify({ ok: true, id, email, action: 'added' }));
    } catch (err) {
        console.error(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
}

main();
