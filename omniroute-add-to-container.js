// omniroute-add-to-container.js
// Добавляет tokenrouter-аккаунт в БД OmniRoute внутри Docker-контейнера.
// Использование:
//   node omniroute-add-to-container.js <email> <apiKey> [providerNodeId]
//
// Нужен путь к БД и STORAGE_ENCRYPTION_KEY.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.OMNI_DB || 'C:\\Users\\WormAlien\\AppData\\Local\\Temp\\opencode\\omniroute-storage.sqlite';
const SQLITE_EXE = process.env.SQLITE3 || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe');
const STORAGE_KEY = process.env.STORAGE_ENCRYPTION_KEY;
const NODE_ID = process.env.OMNI_PROVIDER_NODE || 'openai-compatible-chat-8f2ae822-58f2-49b4-b212-393f686b00c5';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const PREFIX = 'enc:v1:';
const STATIC_SALT = 'omniroute-field-encryption-v1';

function logLine(s) {
    const t = new Date().toISOString().substring(11, 23);
    console.log(`[${t}] ${s}`);
}

function uuid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function escapeSql(s) { return (s || '').replace(/'/g, "''"); }
function maskKey(k) { return k ? (k.substring(0, 8) + '***' + k.slice(-4)) : '—'; }

function getStaticKey(secret) {
    return crypto.scryptSync(secret, STATIC_SALT, KEY_LENGTH);
}

function encrypt(plaintext, secret) {
    if (!plaintext || typeof plaintext !== 'string') return plaintext;
    const key = getStaticKey(secret);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${PREFIX}${iv.toString('hex')}:${encrypted}:${authTag}`;
}

function decrypt(ciphertext, secret) {
    if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.startsWith(PREFIX)) return ciphertext;
    const key = getStaticKey(secret);
    const body = ciphertext.slice(PREFIX.length);
    const [ivHex, encryptedHex, authTagHex] = body.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function sqliteExec(sql) {
    if (!fs.existsSync(SQLITE_EXE)) throw new Error('sqlite3.exe not found');
    if (!fs.existsSync(DB_PATH)) throw new Error('DB not found: ' + DB_PATH);
    return execFileSync(SQLITE_EXE, [DB_PATH, '-json', sql], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

function main() {
    const [email, apiKey] = process.argv.slice(2);
    if (!email || !apiKey) {
        console.error('Usage: node omniroute-add-to-container.js <email> <apiKey> [providerNodeId]');
        process.exit(1);
    }
    if (!STORAGE_KEY) {
        console.error('STORAGE_ENCRYPTION_KEY env var required');
        process.exit(1);
    }

    logLine(`Adding ${email} -> ${maskKey(apiKey)} to node ${NODE_ID}`);

    // Test decrypt on existing row to verify key
    const testRows = JSON.parse(sqliteExec(`SELECT api_key FROM provider_connections WHERE provider = '${NODE_ID}' LIMIT 1;`) || '[]');
    if (testRows.length > 0 && testRows[0].api_key) {
        const decrypted = decrypt(testRows[0].api_key, STORAGE_KEY);
        logLine(`Encryption key test: ${decrypted ? 'OK' : 'FAILED'}`);
        if (!decrypted) {
            console.error('Failed to decrypt existing key; wrong STORAGE_ENCRYPTION_KEY?');
            process.exit(1);
        }
    }

    // Check for duplicate
    const prefix = escapeSql(apiKey.substring(0, 16));
    const dup = JSON.parse(sqliteExec(`SELECT id FROM provider_connections WHERE provider = '${NODE_ID}' AND api_key LIKE '${prefix}%';`) || '[]');
    if (dup.length > 0) {
        logLine(`Already exists: ${dup[0].id}`);
        return;
    }

    const id = uuid();
    const now = nowIso();
    const name = escapeSql(email);
    const emailEsc = escapeSql(email);
    const encryptedKey = escapeSql(encrypt(apiKey, STORAGE_KEY));
    const providerData = escapeSql(JSON.stringify({
        prefix: 'tokenrouter',
        apiType: 'chat',
        baseUrl: 'https://tokenrouter.me/v1',
        nodeName: 'tokenrouter.me',
        apiKeyHealth: {},
    }));

    sqliteExec(`INSERT INTO provider_connections
      (id, provider, auth_type, name, email, priority, is_active, test_status, backoff_level, api_key,
       provider_specific_data, consecutive_use_count, rate_limit_protection, created_at, updated_at,
       proxy_enabled, per_key_proxy_enabled, max_concurrent, quota_window_thresholds_json, rate_limit_overrides_json)
      VALUES
      ('${id}', '${NODE_ID}', 'apikey', '${name}', '${emailEsc}', 1, 1, 'unknown', 0, '${encryptedKey}',
       '${providerData}', 0, 0, '${now}', '${now}', 1, 0, NULL, NULL, NULL);`);

    logLine(`Added connection ${id}`);
}

main();
