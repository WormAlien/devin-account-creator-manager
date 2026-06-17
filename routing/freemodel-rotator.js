// freemodel-rotator.js — FreeModel API key manager + settings.json writer
//
// Listens on :20126. Manages a pool of freemodel.dev API keys.
// One key is "active" — transparent-proxy picks it up when switching
// to the freemodel_rotator backend and writes it to ~/.claude/settings.json.
//
// Does NOT proxy API traffic. Claude Code connects to cc.freemodel.dev directly.
// The rotator just manages which key is in settings.json.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LISTEN_PORT = 20126;
const UPSTREAM_HOST = 'cc.freemodel.dev';
const KEY_PATTERN = /^(fe_oa_|fe_-|sk-)[A-Za-z0-9_-]{20,}$/;
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

const PROJECT_ROOT = path.join(__dirname, '..');
const ACCOUNTS_DIR = path.join(PROJECT_ROOT, 'freemodel', 'accounts');
const MANUAL_DIR = path.join(PROJECT_ROOT, 'manual_sessions');
const FREEMODEL_META_FILE = path.join(PROJECT_ROOT, 'logs', '.freemodel_meta.json');

// ══════════════════════ STATE ══════════════════════

const state = {
  keys: [],
  activeKeyId: null,
  totalActivations: 0,
};

// ══════════════════════ SETTINGS.JSON HELPERS ══════════════════════

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    logLine(`Failed to read settings.json: ${e.message}`);
    return null;
  }
}

function writeSettings(obj) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = SETTINGS_FILE + '.bak-fmrot-' + stamp;
    if (fs.existsSync(SETTINGS_FILE)) {
      fs.copyFileSync(SETTINGS_FILE, bakPath);
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 4) + '\n', 'utf8');
    return true;
  } catch (e) {
    logLine(`Failed to write settings.json: ${e.message}`);
    return false;
  }
}

function writeKeyToSettings(apiKey) {
  const settings = readSettings();
  if (!settings) return false;
  settings.env = settings.env || {};
  settings.env.ANTHROPIC_BASE_URL = 'https://cc.freemodel.dev';
  settings.env.ANTHROPIC_API_KEY = apiKey;
  return writeSettings(settings);
}

// ══════════════════════ KEY LOADING ══════════════════════

function loadMetaFile() {
  try {
    if (fs.existsSync(FREEMODEL_META_FILE)) {
      return JSON.parse(fs.readFileSync(FREEMODEL_META_FILE, 'utf-8')) || {};
    }
  } catch {}
  return {};
}

function saveMetaFile(meta) {
  try {
    const dir = path.dirname(FREEMODEL_META_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FREEMODEL_META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  } catch {}
}

function parseAccountInfo(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const info = { email: '', apiKey: '' };
    for (const line of raw.split('\n')) {
      const c = line.indexOf(':');
      if (c < 0) continue;
      const k = line.slice(0, c).trim().toLowerCase();
      const v = line.slice(c + 1).trim();
      if (k === 'email') info.email = v;
      else if (k === 'api key') info.apiKey = v;
    }
    return info;
  } catch {
    return { email: '', apiKey: '' };
  }
}

function loadKeys() {
  const meta = loadMetaFile();
  const candidates = [];

  if (fs.existsSync(ACCOUNTS_DIR)) {
    for (const entry of fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const infoFile = path.join(ACCOUNTS_DIR, entry.name, 'account_info.txt');
      if (!fs.existsSync(infoFile)) continue;
      const info = parseAccountInfo(infoFile);
      const name = entry.name;
      candidates.push({
        id: name,
        email: info.email || name,
        apiKey: info.apiKey || (meta[name] && meta[name].apiKey) || '',
        banned: !!(meta[name] && meta[name].banned),
        tgPhone: (meta[name] && meta[name].tgPhone) || null,
      });
    }
  }

  if (fs.existsSync(MANUAL_DIR)) {
    for (const entry of fs.readdirSync(MANUAL_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const infoFile = path.join(MANUAL_DIR, entry.name, 'session_info.txt');
      if (!fs.existsSync(infoFile)) continue;
      const info = parseAccountInfo(infoFile);
      const name = entry.name;
      candidates.push({
        id: name,
        email: info.email || name,
        apiKey: (meta[name] && meta[name].apiKey) || '',
        banned: !!(meta[name] && meta[name].banned),
        tgPhone: (meta[name] && meta[name].tgPhone) || null,
      });
    }
  }

  const oldMap = new Map(state.keys.map(k => [k.id, k]));
  const loaded = [];

  for (const c of candidates) {
    const old = oldMap.get(c.id);
    const valid = KEY_PATTERN.test(c.apiKey);
    loaded.push({
      id: c.id,
      email: c.email || c.id,
      apiKey: c.apiKey,
      banned: c.banned,
      tgPhone: c.tgPhone,
      status: valid ? (old && old.status === 'active' ? 'active' : 'ready') : (c.apiKey ? 'bad_format' : 'no_key'),
      activations: old ? old.activations : 0,
    });
  }

  loaded.sort((a, b) => {
    if (a.banned !== b.banned) return a.banned ? 1 : -1;
    if (a.status === 'active') return -1;
    if (b.status === 'active') return 1;
    return a.email.localeCompare(b.email);
  });
  state.keys = loaded;

  const active = loaded.filter(k => !k.banned && (k.status === 'active' || k.status === 'ready')).length;
  const banned = loaded.filter(k => k.banned).length;
  console.log(`[FM Rotator] ${loaded.length} keys (${active} usable, ${banned} banned, ${loaded.filter(k => k.status === 'no_key').length} no_key)`);
  console.log(`  Active key: ${state.activeKeyId ? state.keys.find(k => k.id === state.activeKeyId)?.email || 'none' : 'none'}`);
}

function writeKeyToAccountInfo(id, apiKey) {
  const infoFile = path.join(ACCOUNTS_DIR, id, 'account_info.txt');
  if (!fs.existsSync(infoFile)) {
    const dir = path.join(ACCOUNTS_DIR, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(infoFile, 'Email: \nAPI Key: ' + apiKey + '\nStatus: ok\n', 'utf-8');
    return true;
  }
  try {
    let raw = fs.readFileSync(infoFile, 'utf-8');
    if (/^API Key:/m.test(raw)) {
      raw = raw.replace(/^API Key:.*$/m, 'API Key: ' + apiKey);
    } else {
      raw = raw.trimEnd() + '\nAPI Key: ' + apiKey + '\n';
    }
    fs.writeFileSync(infoFile, raw, 'utf-8');
    return true;
  } catch (e) {
    console.log(`[FM Rotator] Failed to write key: ${e.message}`);
    return false;
  }
}

function setApiKey(id, apiKey) {
  const meta = loadMetaFile();
  meta[id] = meta[id] || {};
  meta[id].apiKey = apiKey;
  saveMetaFile(meta);

  writeKeyToAccountInfo(id, apiKey);

  const key = state.keys.find(k => k.id === id);
  if (key) {
    key.apiKey = apiKey;
    key.banned = meta[id].banned || false;
    const valid = KEY_PATTERN.test(apiKey);
    if (valid && (key.status === 'no_key' || key.status === 'bad_format')) key.status = 'ready';
    if (!valid) key.status = 'bad_format';
  }
  return true;
}

// ══════════════════════ ACTIVATION ══════════════════════

function activateKey(id) {
  const key = state.keys.find(k => k.id === id);
  if (!key) return { ok: false, error: 'Key not found' };
  if (key.banned) return { ok: false, error: 'Key is banned' };
  if (key.status === 'no_key' || !key.apiKey) return { ok: false, error: 'No API key set' };
  if (key.status === 'bad_format') return { ok: false, error: 'Bad key format' };

  // Mark as active in-memory ONLY — transparent-proxy writes to settings.json
  // when user explicitly switches to freemodel_rotator backend in Switcher tab.
  state.activeKeyId = key.id;
  key.status = 'active';
  key.activations = (key.activations || 0) + 1;
  state.totalActivations++;

  logLine(`activated (in-memory): ${key.email}`);
  return { ok: true, email: key.email, apiKeyMask: maskKey(key.apiKey) };
}

// ══════════════════════ CHECK KEY (ping) ══════════════════════

async function checkKey(key) {
  const checkBody = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: UPSTREAM_HOST, port: 443, method: 'POST', path: '/v1/messages',
      headers: {
        'Host': UPSTREAM_HOST, 'Content-Type': 'application/json',
        'x-api-key': key.apiKey, 'anthropic-version': '2023-06-01',
        'User-Agent': 'Anthropic/JS 0.45.0',
        'X-Stainless-Lang': 'js', 'X-Stainless-Package-Version': '0.45.0',
        'X-Stainless-OS': 'Windows', 'X-Stainless-Arch': 'x64',
        'X-Stainless-Runtime': 'node', 'X-Stainless-Runtime-Version': process.version,
        'X-Stainless-Retry-Count': '0',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data.substring(0, 300) }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(checkBody);
    req.end();
  });
}

// ══════════════════════ API HANDLERS ══════════════════════

function handleApiStatus(res) {
  const keysForUI = state.keys.map(k => ({
    id: k.id,
    email: k.email,
    apiKeyMask: k.apiKey ? maskKey(k.apiKey) : '—',
    status: k.status,
    banned: k.banned,
    tgPhone: k.tgPhone,
    activations: k.activations,
    isActive: k.id === state.activeKeyId,
  }));
  writeJSON(res, 200, {
    keys: keysForUI,
    activeKeyId: state.activeKeyId,
    totalActivations: state.totalActivations,
    usableCount: state.keys.filter(k => !k.banned && (k.status === 'active' || k.status === 'ready')).length,
    totalCount: state.keys.length,
    bannedCount: state.keys.filter(k => k.banned).length,
  });
}

function handleApiActivate(res, body) {
  try {
    const { id, email } = JSON.parse(body || '{}');
    let key;
    if (id) key = state.keys.find(k => k.id === id);
    else if (email) key = state.keys.find(k => k.email === email);
    if (!key) return writeJSON(res, 404, { error: 'Key not found' });
    const result = activateKey(key.id);
    writeJSON(res, result.ok ? 200 : 400, result);
  } catch (e) {
    writeJSON(res, 400, { error: e.message });
  }
}

function handleApiActiveKey(res) {
  if (!state.activeKeyId) return writeJSON(res, 200, { apiKey: null, email: null });
  const key = state.keys.find(k => k.id === state.activeKeyId);
  if (!key || !key.apiKey) return writeJSON(res, 200, { apiKey: null, email: null });
  writeJSON(res, 200, { apiKey: key.apiKey, email: key.email, apiKeyMask: maskKey(key.apiKey) });
}

async function handleApiCheckKey(res, body) {
  try {
    const { id, email } = JSON.parse(body || '{}');
    let key;
    if (id) key = state.keys.find(k => k.id === id);
    else if (email) key = state.keys.find(k => k.email === email);
    if (!key || !key.apiKey) return writeJSON(res, 404, { error: 'Key not found or no API key' });

    const result = await checkKey(key);
    writeJSON(res, 200, {
      email: key.email,
      apiKeyMask: maskKey(key.apiKey),
      ok: result.status === 200,
      status: result.status,
      error: result.status !== 200 ? result.body : null,
    });
  } catch (e) {
    writeJSON(res, 400, { error: e.message });
  }
}

function handleApiToggle(res, body) {
  try {
    const { id, email, active } = JSON.parse(body || '{}');
    let key;
    if (id) key = state.keys.find(k => k.id === id);
    else if (email) key = state.keys.find(k => k.email === email);
    if (!key) return writeJSON(res, 404, { error: 'Key not found' });

    if (active && key.status === 'ready') {
      activateKey(key.id);
    } else if (!active && key.status === 'active') {
      key.status = 'ready';
      if (state.activeKeyId === key.id) state.activeKeyId = null;
    }
    writeJSON(res, 200, { ok: true, email: key.email, status: key.status });
  } catch (e) {
    writeJSON(res, 400, { error: e.message });
  }
}

function handleApiSetKey(res, body) {
  try {
    const { id, email, apiKey } = JSON.parse(body || '{}');
    let key;
    if (id) key = state.keys.find(k => k.id === id);
    else if (email) key = state.keys.find(k => k.email === email);
    if (!key) return writeJSON(res, 404, { error: 'Account not found' });
    if (!apiKey || !apiKey.trim()) return writeJSON(res, 400, { error: 'apiKey required' });

    const ok = setApiKey(key.id, apiKey.trim());
    logLine(`set-key: ${key.email} → ${maskKey(apiKey.trim())}`);
    writeJSON(res, 200, { ok: true, email: key.email, apiKeyMask: maskKey(apiKey.trim()) });
  } catch (e) {
    writeJSON(res, 400, { error: e.message });
  }
}

function handleApiReload(res) {
  loadKeys();
  writeJSON(res, 200, { ok: true, count: state.keys.length });
}

// ══════════════════════ HELPERS ══════════════════════

function maskKey(apiKey) {
  if (!apiKey || apiKey.length < 12) return '—';
  return apiKey.substring(0, 8) + '***' + apiKey.slice(-4);
}

function writeJSON(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function logLine(s) {
  const t = new Date().toISOString().substring(11, 23);
  console.log(`[${t}] ${s}`);
}

// ══════════════════════ SERVER ══════════════════════

loadKeys();

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/__fmrot/api/status') return handleApiStatus(res);
  if (req.method === 'GET' && req.url === '/__fmrot/api/active-key') return handleApiActiveKey(res);

  if (req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      if (req.url === '/__fmrot/api/activate') handleApiActivate(res, b);
      else if (req.url === '/__fmrot/api/check-key') handleApiCheckKey(res, b);
      else if (req.url === '/__fmrot/api/toggle') handleApiToggle(res, b);
      else if (req.url === '/__fmrot/api/set-key') handleApiSetKey(res, b);
      else if (req.url === '/__fmrot/api/reload') handleApiReload(res);
      else writeJSON(res, 404, { error: 'Unknown endpoint' });
    });
    return;
  }

  writeJSON(res, 404, { error: 'Not found' });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[FM Rotator] :${LISTEN_PORT} — key manager mode`);
  console.log(`  ${state.keys.length} keys loaded, writes to ${SETTINGS_FILE}`);
  console.log(`  API: http://localhost:${LISTEN_PORT}/__fmrot/api/status`);
});
