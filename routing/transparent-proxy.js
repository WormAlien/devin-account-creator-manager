// Switcher panel for Claude Code's settings.json.
//
// Why not a request proxy: CC's auth handshake doesn't tolerate header-swapping
// mid-flight ("Not logged in" errors). The clean way is to flip BASE_URL + KEY
// in settings.json so CC talks to the chosen backend directly (as upstream
// author of notion-abuz_ai documents).
//
// Each click writes settings.json (with timestamped .bak) and tells the user to
// restart Claude Code.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---- Load routing/.env (gitignored real keys) ------------------------------
// Tiny inline parser — no dotenv dep required.
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

// OmniRoute creds read LIVE from process.env — POST /__switch/api/env updates them
// without restarting the proxy. Never freeze into a startup const.
function omniBase() { return (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128').replace(/\/+$/, ''); }
function omniKey()  { return process.env.OMNIROUTE_API_KEY || 'sk-local-dev-key'; }
// AgentRouter: тоже LIVE из process.env, ключ лежит в routing/.env (gitignored).
function agentRouterBase() { return (process.env.AGENTROUTER_BASE_URL || 'https://agentrouter.org').replace(/\/+$/, ''); }
function agentRouterKey()  { return process.env.AGENTROUTER_API_KEY || 'sk-local-dev-key'; }
const NOTION_KEY    = process.env.NOTION_API_KEY    || 'sk-local-dev-key';

const ENV_FILE = path.join(__dirname, '.env');
function readEnvFile() {
    const out = {};
    try {
        for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
            if (line.trimStart().startsWith('#')) continue;
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch {}
    return out;
}
// Upsert keys into routing/.env (keep other lines/comments) + apply live to process.env.
function upsertEnvFile(updates) {
    let lines = [];
    try { lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/); } catch {}
    for (const [k, v] of Object.entries(updates)) {
        const re = new RegExp('^\\s*' + k + '\\s*=');
        const i = lines.findIndex(l => re.test(l) && !l.trimStart().startsWith('#'));
        if (i >= 0) lines[i] = `${k}=${v}`;
        else lines.push(`${k}=${v}`);
        process.env[k] = v;
    }
    fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
}

// Порт дашборда. Env-оверрайд нужен для проверки копии репо в другом каталоге
// (тест переносимости путей) — рабочий запуск как раньше на :8200.
const LISTEN_PORT = Number(process.env.SWITCHER_PORT || 8200);
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const SETTINGS_BACKUP_DIR = path.join(os.homedir(), '.claude', 'settings-backups');
const BACKUP_NAME_RE = /^settings-[0-9A-Za-z._-]+\.json$/;
function listSettingsBackups() {
    try {
        return fs.readdirSync(SETTINGS_BACKUP_DIR)
            .filter(n => BACKUP_NAME_RE.test(n))
            .map(n => { const st = fs.statSync(path.join(SETTINGS_BACKUP_DIR, n)); return { name: n, size: st.size, mtime: st.mtimeMs }; })
            .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
}
function makeSettingsBackup(prefix = 'settings') {
    if (!fs.existsSync(SETTINGS_FILE)) throw new Error('settings.json не найден');
    fs.mkdirSync(SETTINGS_BACKUP_DIR, { recursive: true });
    const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.copyFileSync(SETTINGS_FILE, path.join(SETTINGS_BACKUP_DIR, name));
    return name;
}
const STATE_FILE = path.join(__dirname, 'proxy-target.json');
const TOKENROUTER_ACCOUNTS = path.join(__dirname, 'tokenrouter', 'accounts.json');

// Список трекаемых в git файлов, которые дашборд перезаписывает сам (маппинг тиров,
// активный бэкенд, claude→gpt), живёт в tools/git-pull-safe.js — там же логика
// «безопасного pull», общая с update.sh/fix.sh.

// For /__switch/api/whoami — look up OmniRoute provider_connections by id prefix.
const OMNI_DB = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const SQLITE_EXE = process.env.SQLITE3
    || [
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe'),
        path.join(os.homedir(), 'bin', 'sqlite3.exe'),
    ].find(p => fs.existsSync(p))
    || path.join(os.homedir(), 'bin', 'sqlite3.exe');

// Порт keepalive-прокси AgentRouter нужен уже здесь, в BACKENDS, а канонические
// AR_*-константы объявлены ниже (~5150) — держим один литерал с перекрёстной ссылкой.
// При смене порта править оба места (ниже стоит ассерт на расхождение).
const AR_KEEPALIVE_URL_EARLY = 'http://localhost:20133';

const BACKENDS = {
    agentrouter: {
        label: 'AgentRouter (opus-5 1M)',
        // База — локальный keepalive :20133, а НЕ голый agentrouter.org: у gpt-моделей
        // /v1/messages сломан, нужен конвертер за keepalive (см. arTargetFor). Голый
        // домен здесь ранее тихо разламывал весь AR-путь, если кто-то дёргал
        // POST /__switch/api/switch {target:'agentrouter'} в обход вкладки.
        base_url: AR_KEEPALIVE_URL_EARLY,
        api_key: agentRouterKey(),
        // model: undefined = не трогать. Источник правды — ar-active-model.txt
        // (handleArSetModel/handleArActivate), иначе клик по чипу gpt-5.6-sol
        // затирался бы жёстко прописанным claude-opus-5[1m].
        clear_helper: true,
    },
    omniroute: {
        label: 'FreeModel (OmniRoute)',
        base_url: 'http://localhost:20128/v1',
        api_key: omniKey(),
        model: 'ComboWombo',
        // Main backend: full tools, long contexts, vision.
    },
    notion: {
        label: 'Notion (cheap)',
        base_url: 'http://localhost:8190',
        api_key: NOTION_KEY,
        model: 'opus-4.8',
        // Cheap backend: short tasks without heavy tools.
    },
    freemodel_rotator: {
        label: 'FreeModel Rotator',
        base_url: 'https://cc.freemodel.dev',
        api_key: '__rotator__',     // resolved dynamically from rotator API
        model: 'opus[1m]',
        // Direct cc.freemodel.dev — key managed by freemodel-rotator.js
    },
    fm_openai: {
        label: 'FreeModel OpenAI (gpt)',
        base_url: 'http://localhost:20130',
        api_key: 'dummy',           // real key proxy reads from fm-active-key.txt
        model: null,
        clear_helper: true,         // else currentTarget() would misdetect as apihelper
        // Anthropic→OpenAI прокси (freemodel-openai-proxy.js) → cc.freemodel.dev/v1
        // chat/completions. Маппинг claude-* → gpt-* в fm-openai-config.json.
    },
    vyce_openai: {
        label: 'VyceAI (OpenAI)',
        base_url: 'http://localhost:20131',
        api_key: 'dummy',           // real key proxy reads from vyceai/keys.txt
        model: null,
        clear_helper: true,
        // Anthropic→OpenAI прокси (vyceai-openai-proxy.js) → vyceai.com/v1
        // chat/completions. Маппинг claude-* → vyce-модели в vyceai/config.js.
    },
    tabi: {
        label: 'Tabi Token',
        base_url: 'http://localhost:20155',
        api_key: 'dummy',           // real key keepalive reads from tabi-active-key.txt
        model: null,
        clear_helper: true,
        // SSE keepalive-прокси (keepalive-proxy.js :20155) → tabitoken.com (БЕЗ /v1).
        // Активация через handleTbActivate (пишет ANTHROPIC_AUTH_TOKEN='dummy'),
        // ключ живёт в tabi-active-key.txt и инжектится прокси на каждый запрос.
    },
    gorouter: {
        label: 'GoRouter',
        base_url: 'http://localhost:20156',
        api_key: 'dummy',           // real key keepalive reads from gorouter-active-key.txt
        model: null,
        clear_helper: true,
        // SSE keepalive-прокси (keepalive-proxy.js :20156) → gorouter.app (БЕЗ /v1).
        // Активация через handleGoActivate (пишет ANTHROPIC_AUTH_TOKEN='dummy'),
        // ключ живёт в gorouter-active-key.txt и инжектится прокси на каждый запрос.
    },
    xpeach: {
        label: 'XPeach',
        base_url: 'http://localhost:20157',
        api_key: 'dummy',           // real key keepalive reads from xpeach-active-key.txt
        model: null,
        clear_helper: true,
        // SSE keepalive-прокси (keepalive-proxy.js :20157) → xpeach.codes (БЕЗ /v1).
        // Активация через handleXpActivate (пишет ANTHROPIC_AUTH_TOKEN='dummy'),
        // ключ живёт в xpeach-active-key.txt и инжектится прокси на каждый запрос.
        // claude-* ходят нативно: в каталоге они помечены anthropic+openai.
    },
};

const LOG_BUFFER = [];
const LOG_BUFFER_MAX = 2000;

function logLine(s) {
    const t = new Date().toISOString().substring(11, 23);
    const line = `[${t}] ${s}`;
    console.log(line);
    LOG_BUFFER.push(line);
    if (LOG_BUFFER.length > LOG_BUFFER_MAX) LOG_BUFFER.shift();
}

function readSettings() {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    // settings.json starts with UTF-8 BOM in some editors вЂ” strip it
    return JSON.parse(raw.replace(/^п»ї/, ''));
}

// Единственное место, где решается судьба суффикса [1m]. Claude Code без него
// считает окно 200k и режет историю втрое раньше. Правило держим здесь, а не в
// 24 обработчиках: каждый чинил свой путь из двадцати, симптом возвращался.
// Контекст 1M — свойство ID модели, а не апстрима; прокси суффикс срезают
// перед форвардом (keepalive-proxy.js:369), поэтому шлюзу он не мешает.
const CC_DEFAULT_MODEL = 'claude-opus-5[1m]';
function normalizeCcModel(m) {
    const s = String(m || '').trim();
    if (!s) return s;
    return /^claude-(opus|sonnet)-/.test(s) && !s.includes('[') ? `${s}[1m]` : s;
}

// ---- Отсутствие модели = 200k, поэтому пустой `model` тоже чиним здесь -------
// `delete settings.model` в activate-обработчиках (их 14) задумывался как
// защитный сброс: имя модели от прошлого шлюза может отсутствовать в каталоге
// нового → 400/404 на каждом запросе. Пусть окно меньше, зато работает.
//
// Защита оказалась ложной по двум причинам, обе замерены 2026-08-21:
//   1. Живую сессию она не спасает физически. Модель резолвится ОДИН раз на
//      старте (`--model` → settings.json → дефолт), в транскрипте её нет.
//      Поэтому прыжок ar → go по 🔑 внутри сессии бесшовен — CC едет на том,
//      что разрешил при запуске. Сброс срабатывает только при следующем старте.
//   2. Опасность снята ниже по стеку. keepalive-proxy срезает суффикс окна и
//      переписывает модель по тир-карте `<prefix>-modelmap.json`
//      (`tierTargetFor`, TIER_RE ловит `opus` в `claude-opus-5`), а в ответе
//      возвращает запрошенное имя (MODEL_ECHO). Точное имя в settings.model в
//      каталоге шлюза быть НЕ обязано: у agentrouter `claude-opus-5` в каталоге
//      нет, а `ar-active-model.txt` = `claude-opus-5` и работает.
// Итого сброс — чистый минус: не защищает то, что и без него живёт, и роняет
// окно при следующем запуске. Комментарии «вслепую пинить нельзя» писались до
// появления тир-карт.
//
// Порядок резолва (от точного к общему):
//   1. `~/.claude/<prefix>-active-model.txt` — модель, выбранную человеком на
//      вкладке этого шлюза; она заведомо из его каталога.
//   2. CC_DEFAULT_MODEL — только если тир-карта шлюза умеет `opus`, т.е. имя
//      будет переписано на внутреннее. Карта читается с диска, а не хардкодится:
//      её правят на вкладке провайдера, и пин обязан ходить за ней.
//   3. Иначе оставляем пусто и пишем в лог. Вслепую пинить нельзя: без карты
//      имя уедет на шлюз как есть (xpeach-modelmap.json пустой) → 503.
const CC_MODEL_PREFIX = {
    agentrouter: 'ar',
    gorouter: 'gorouter',
    tabi: 'tabi',
    xpeach: 'xpeach',
    ourtoken: 'ot',
    cun: 'cun',
    conduit: 'cdt',
};
function ccModelMapHasOpus(prefix) {
    if (!prefix) return false;
    try {
        const raw = fs.readFileSync(path.join(__dirname, `${prefix}-modelmap.json`), 'utf8');
        const mm = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return !!String(mm.opus || '').trim();
    } catch { return false; }
}
function resolveCcModel(obj) {
    let backend;
    // Второй writeSettings подряд: base уже наш, провайдера знает active-backend.json.
    if (isFrontdoorBase((obj.env && obj.env.ANTHROPIC_BASE_URL) || '')) {
        const st = readActiveBackend();
        backend = (st && st.backend) || null;
    } else {
        backend = backendFromSettingsObj(obj);
    }
    // Официальный Claude: апстрим анпропиковский, claude-opus-5 там есть по определению.
    if (backend === 'official') return CC_DEFAULT_MODEL;
    const prefix = CC_MODEL_PREFIX[backend] || null;
    if (prefix) {
        try {
            const m = fs.readFileSync(path.join(os.homedir(), '.claude', `${prefix}-active-model.txt`), 'utf8').trim();
            if (m) return m;
        } catch { /* файла нет — идём дальше */ }
    }
    if (ccModelMapHasOpus(prefix)) return CC_DEFAULT_MODEL;
    logLine(`model: ${backend || '?'} — модели нет ни в <prefix>-active-model.txt, ни тир-карты opus → settings.model оставлен пустым, Claude Code поедет на 200k`);
    return '';
}

// ---- Окно контекста для моделей, которых Claude Code не знает ---------------
// У gpt-моделей суффикс [1m] не работает (в CC это перечисление, и на gpt-путь он
// вообще не доедет: keepalive уводит isGptLike() на конвертер ДО среза суффикса).
// Поэтому окно задаём env-переменной CLAUDE_CODE_MAX_CONTEXT_TOKENS: CC берёт из неё
// свою веру → и автокомпакт, и знаменатель `⧉ N/M` в статуслайне становятся правдой.
// Статуслайн НЕ трогаем: врать в баре поверх чужой веры уже пробовали (таблица
// `real_max`) — получалось 16% при реальной занятости 90%, потому что компактит CC
// по своему числу, а не по нарисованному.
const MODEL_WINDOWS_FILE = path.join(__dirname, 'model-windows.json');
let MODEL_WINDOWS_CACHE = { mtime: 0, map: {} };
function modelWindows() {
    try {
        const st = fs.statSync(MODEL_WINDOWS_FILE);
        if (st.mtimeMs !== MODEL_WINDOWS_CACHE.mtime) {
            const raw = fs.readFileSync(MODEL_WINDOWS_FILE, 'utf8');
            const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            MODEL_WINDOWS_CACHE = { mtime: st.mtimeMs, map: doc.windows || {} };
        }
    } catch { /* нет файла — просто не переопределяем окно */ }
    return MODEL_WINDOWS_CACHE.map;
}

// Сколько токенов заявить Claude Code для этой модели. null = не заявлять
// (claude-* и всё незнакомое: у CC своя таблица, а врать наугад хуже, чем молчать).
function ccContextTokensFor(model) {
    const m = String(model || '').trim();
    if (!m || /^claude-/.test(m)) return null;
    const bare = m.replace(/\s*\[[^\]]*\]\s*$/, '');   // на случай чужого суффикса
    const n = modelWindows()[bare];
    return Number.isFinite(n) && n > 0 ? n : null;
}

function writeSettings(obj) {
    // Чокпоинт суффикса: сюда сходятся ВСЕ записи settings.json (см. tools/check-1m.js —
    // он валит сборку, если кто-то опять пишет файл напрямую). ANTHROPIC_MODEL правим
    // тоже: cun/conduit пишут его рядом с top-level model, расхождение = 200k.
    if (typeof obj.model === 'string') obj.model = normalizeCcModel(obj.model);
    // Пустая/снесённая модель — тоже даунгрейд до 200k, лечим тут же (см. resolveCcModel).
    if (typeof obj.model !== 'string' || !obj.model.trim()) {
        const fb = normalizeCcModel(resolveCcModel(obj));
        if (fb) obj.model = fb; else delete obj.model;
    }
    if (obj.env && typeof obj.env.ANTHROPIC_MODEL === 'string') {
        obj.env.ANTHROPIC_MODEL = normalizeCcModel(obj.env.ANTHROPIC_MODEL);
    }
    // Окно для незнакомых CC моделей — сюда же, чтобы не расползлось по хендлерам.
    // Ключ обязательно СНИМАЕМ, когда модель антропиковская: залипшие 1050000 на
    // claude-opus-5 (реально 1M) — это переполнение контекста на апстриме.
    const ctxTokens = ccContextTokensFor(obj.model);
    if (ctxTokens) {
        obj.env = obj.env || {};
        obj.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctxTokens);
    } else if (obj.env) {
        delete obj.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    }
    // Front-door: перевести base URL на :20100 и записать active-backend.json.
    // Стоит здесь, а не в хендлерах, по той же причине, что и нормализация модели —
    // записей в settings.json много, а правило должно быть одно.
    applyFrontdoor(obj);
    // timestamped backup before every write
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = SETTINGS_FILE + '.bak-' + stamp;
    fs.copyFileSync(SETTINGS_FILE, bakPath);
    // атомарно: tmp + rename, чтобы Claude Code не прочитал полфайла
    const tmpPath = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 4) + '\n', 'utf8');
    fs.renameSync(tmpPath, SETTINGS_FILE);
    logLine(`settings.json written, backup at ${path.basename(bakPath)}`);
}

// ---- OAuth-сессия официального Claude (после `claude` → /login) ------------
// Токен лежит в credential store: macOS — Keychain, Windows/Linux —
// ~/.claude/.credentials.json. Email/подписка — в ~/.claude.json → oauthAccount.
// Истёкший accessToken ≠ разлогин: CC сам обновит его по refreshToken.
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
function oauthStatus() {
    let raw;
    try {
        raw = process.platform === 'darwin'
            ? execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' }).trim()
            : fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    } catch { return { loggedIn: false }; }
    try {
        const o = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw).claudeAiOauth;
        if (!o || !o.accessToken) return { loggedIn: false };
        let email = null;
        try { email = (readClaudeJson().oauthAccount || {}).emailAddress || null; } catch {}
        return {
            loggedIn: true,
            email,
            subscriptionType: o.subscriptionType || null,
            expiresAt: o.expiresAt || null,
        };
    } catch { return { loggedIn: false }; }
}

// ~/.claude.json — здесь живут MCP-серверы (mcpServers global + projects[*].mcpServers).
const CLAUDE_JSON_FILE = path.join(os.homedir(), '.claude.json');
function readClaudeJson() {
    const raw = fs.readFileSync(CLAUDE_JSON_FILE, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}
function writeClaudeJson(obj) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = CLAUDE_JSON_FILE + '.bak-' + stamp;
    fs.copyFileSync(CLAUDE_JSON_FILE, bakPath);
    fs.writeFileSync(CLAUDE_JSON_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    logLine(`.claude.json written, backup at ${path.basename(bakPath)}`);
}

// apiKeyHelper-команда для key-файла. НЕ "cat ~/...": Claude Code запускает
// helper через системный шелл, где может не быть cat в PATH, HOME для ~,
// а кириллица в имени юзера ломает путь. node есть у всех (без него дашборд
// не работает), os.homedir() отдаёт путь в юникоде, .trim() режет CRLF.
function keyHelperCmd(keyFile) {
    return 'node -e "process.stdout.write(require(\'fs\').readFileSync('
        + 'require(\'os\').homedir()+\'/.claude/' + keyFile + '\',\'utf8\').trim())"';
}

// ---- Front-door :20100 — фиксированный вход Claude Code ----------------------
// `env` из settings.json Claude Code читает ОДИН раз, при старте процесса. Пока
// свич провайдера менял ANTHROPIC_BASE_URL, каждое переключение требовало новой
// сессии CC — а в Orca одновременно живёт несколько pty с `claude`, и перезапускать
// их все на каждый свич нельзя. Поэтому base URL фиксируется на локальном
// frontdoor-proxy.js, а выбор бэкенда переезжает в ~/.claude/active-backend.json.
//
// Чокпоинт ОДИН — writeSettings(): 15+ обработчиков активации по-прежнему пишут
// свой base URL / apiKeyHelper, а applyFrontdoor() превращает это в состояние
// front-door. Так новый режим не размазан по хендлерам (см. docs/HANDOFF-frontdoor.md).
const FRONTDOOR_CONFIG_FILE = process.env.FRONTDOOR_CONFIG || path.join(__dirname, 'frontdoor.json');
const ACTIVE_BACKEND_FILE = path.join(os.homedir(), '.claude', 'active-backend.json');
// Ключ для удалённого шлюза, который обработчик записал литералом (единственный
// такой путь — freemodel_rotator). Front-door читает ключи только из файлов, поэтому
// литерал переезжает сюда, а не в состояние: секретам в active-backend.json не место.
const FD_INLINE_KEY_FILE = path.join(os.homedir(), '.claude', 'fd-active-key.txt');
const FD_DEFAULT_PORT = 20100;
let FD_CFG_CACHE = { mtime: 0, cfg: { enabled: false, port: FD_DEFAULT_PORT } };

function frontdoorConfig() {
    try {
        const st = fs.statSync(FRONTDOOR_CONFIG_FILE);
        if (st.mtimeMs !== FD_CFG_CACHE.mtime) {
            const raw = fs.readFileSync(FRONTDOOR_CONFIG_FILE, 'utf8');
            const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
            FD_CFG_CACHE = {
                mtime: st.mtimeMs,
                cfg: { enabled: !!doc.enabled, port: Number(doc.port) || FD_DEFAULT_PORT },
            };
        }
    } catch { /* нет файла — режим выключен, всё работает по-старому */ }
    return FD_CFG_CACHE.cfg;
}
function frontdoorPort() { return frontdoorConfig().port; }
function frontdoorUrl() { return `http://127.0.0.1:${frontdoorPort()}`; }

// «Claude Code реально смотрит в front-door» — проверяем и localhost, и 127.0.0.1.
function isFrontdoorBase(url) {
    const p = frontdoorPort();
    return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${p}(/|$)`, 'i').test(String(url || ''));
}
function isLocalBase(url) {
    return /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:|\/|$)/i.test(String(url || ''));
}

function readActiveBackend() {
    try {
        const raw = fs.readFileSync(ACTIVE_BACKEND_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch { return null; }
}
function writeActiveBackend(state) {
    const tmp = ACTIVE_BACKEND_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, ACTIVE_BACKEND_FILE);   // атомарно: прокси читает файл на каждый запрос
}

// Имя key-файла из apiKeyHelper-команды (`…/.claude/cdt-active-key.txt`).
function helperKeyFile(helper) {
    const m = String(helper || '').match(/([A-Za-z0-9_-]+-active-key\.txt)/);
    return m ? m[1] : null;
}

// Что записать в active-backend.json для объекта settings, который СОБИРАЕТСЯ
// записать обработчик. Ничего не изобретаем: апстрим — ровно тот base URL, который
// он выставил, ключ — ровно тот файл, который он повесил в apiKeyHelper.
// null = вмешиваться нельзя (официальный Claude, пустой/непонятный конфиг).
function frontdoorStateFrom(obj) {
    const env = (obj && obj.env) || {};
    const base = String(env.ANTHROPIC_BASE_URL || '').trim();
    if (!base) return null;                       // official / Bedrock / Vertex — не наше дело
    const backend = backendFromSettingsObj(obj);
    if (backend === 'official' || String(backend).startsWith('error')) return null;
    let keyFile = null;
    let modelmap = null;
    if (!isLocalBase(base)) {
        // Удалённый шлюз: ключ инжектит сам front-door. Локальным ключ не нужен —
        // его ставит keepalive/конвертер (keepalive-proxy.js:771), и второй раз
        // перебивать его нельзя.
        keyFile = helperKeyFile(obj.apiKeyHelper);
        if (!keyFile) {
            // Оба поля перебираем: AUTH_TOKEN может остаться заглушкой 'dummy' от
            // предыдущего бэкенда, пока реальный ключ лежит в ANTHROPIC_API_KEY.
            const literal = [env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY]
                .map(v => String(v || '').trim())
                .find(v => v && v !== 'dummy');
            if (literal) {
                fs.writeFileSync(FD_INLINE_KEY_FILE, literal, 'utf8');
                keyFile = path.basename(FD_INLINE_KEY_FILE);
            }
        }
        // Карта тиров по тому же префиксу, что и key-файл: cdt-active-key.txt →
        // cdt-modelmap.json. Файла может не быть — front-door тогда только срежет
        // суффикс окна и напишет об этом в лог (шлюзы без claude-* в каталоге).
        const prefix = keyFile && keyFile !== path.basename(FD_INLINE_KEY_FILE)
            ? keyFile.replace(/-active-key\.txt$/, '') : null;
        if (prefix) modelmap = `${prefix}-modelmap.json`;
    }
    return { backend, upstream: base, keyFile, modelmap, updatedAt: Date.now() };
}

// Вызывается ИЗ writeSettings(), до записи файла.
function applyFrontdoor(obj) {
    if (!frontdoorConfig().enabled) return;
    const env = obj.env || (obj.env = {});
    const base = String(env.ANTHROPIC_BASE_URL || '');
    // Уже наш адрес: обработчик писал не про бэкенд (модель, тоггл, пресет), либо это
    // второй writeSettings подряд (handleSettingsApply). Состояние НЕ трогаем —
    // иначе второй проход затрёт активный бэкенд «фронтдором».
    if (isFrontdoorBase(base)) return;
    const state = frontdoorStateFrom(obj);
    if (!state) return;                 // official и прочее — оставляем как есть
    writeActiveBackend(state);
    env.ANTHROPIC_BASE_URL = frontdoorUrl();
    env.ANTHROPIC_AUTH_TOKEN = 'dummy';    // реальный ключ ставят front-door/keepalive
    delete obj.apiKeyHelper;               // ключ больше не нужен Claude Code
    delete env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
    delete env.ANTHROPIC_API_KEY;
    logLine(`front-door: ${state.backend} → ${state.upstream}${state.keyFile ? ' (ключ ' + state.keyFile + ')' : ''}`);
}

// Figure out which backend/config matches the URL/key currently in settings.json.
// apiKeyHelper → ApiHelper (FreeModel direct), direct API key → backend by URL.
// Работает на ОБЪЕКТЕ, а не на файле: тот же вывод нужен front-door'у до записи,
// чтобы понять, какой бэкенд имел в виду обработчик (см. applyFrontdoor).
function backendFromSettingsObj(s) {
    try {
        const url = (s.env && s.env.ANTHROPIC_BASE_URL) || '';
        const helper = s.apiKeyHelper || '';
        if (helper.includes('fm-active-key.txt') || helper.includes('freemodel')) {
            return 'apihelper';
        }
        if (helper.includes('al-active-key.txt')) {
            return 'aerolink';
        }
        if (helper.includes('cun-active-key.txt')) {
            return 'cun';
        }
        if (helper.includes('cdt-active-key.txt')) {
            return 'conduit';
        }
        if (helper.includes('sr-active-key.txt')) {
            return 'svrtr';
        }
        if (helper.includes('hc-active-key.txt')) {
            return 'helpcoder';
        }
        if (helper.includes('ev-active-key.txt')) {
            return 'evomap';
        }
        if (helper.includes('ot-active-key.txt')) {
            return 'ourtoken';
        }
        if (helper.includes('custom-active-key.txt')) {
            return 'custom';
        }
        if (helper.includes('om-active-key.txt')) {
            return 'omniroute';
        }
        if (helper.includes('vyceai-active-key.txt')) {
            return 'vyce_openai';
        }
        if (helper.includes('ar-active-key.txt')) {
            return 'agentrouter';
        }
        // ourtoken использует ANTHROPIC_AUTH_TOKEN (без helper) → детектим по base_url
        if (url === 'https://api.ourtoken.ai' || url.startsWith('https://api.ourtoken.ai')) {
            return 'ourtoken';
        }
        // cun.ai — Anthropic-совместимый, детект по base_url (если helper сбросили)
        if (url.includes('cun.ai')) {
            return 'cun';
        }
        // Локальные прокси AgentRouter: keepalive :20133 (claude-* модели) и
        // конвертер :20132 (gpt-*) стоят ПЕРЕД agentrouter.org — при активации
        // ключа base_url пишется именно на них. Иначе статус показывал 'unknown'.
        const u = url.toLowerCase();
        if (u === 'http://localhost:20132' || u === 'http://127.0.0.1:20132'
            || u === 'http://localhost:20133' || u === 'http://127.0.0.1:20133') {
            return 'agentrouter';
        }
        for (const [name, b] of Object.entries(BACKENDS)) {
            if (url === b.base_url) return name;
        }
        // Официальный Claude: ничего провайдерского не выставлено (пустые строки
        // CC трактует как «не задано») → работает OAuth-подписка из /login.
        const env = s.env || {};
        if (!url && !helper && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY
            && !env.CLAUDE_CODE_USE_BEDROCK && !env.CLAUDE_CODE_USE_VERTEX && !env.CLAUDE_CODE_USE_FOUNDRY) {
            return 'official';
        }
        return 'unknown';
    } catch (e) {
        return 'error: ' + e.message;
    }
}

function currentTarget() {
    let s;
    try { s = readSettings(); } catch (e) { return 'error: ' + e.message; }
    // Front-door: пока base URL реально смотрит в :20100, источник правды —
    // active-backend.json, а не settings.json (там всегда один и тот же адрес).
    // Условие «реально смотрит» важно: с выключённым тумблером или на официальном
    // Claude состояние может быть протухшим, и врать нельзя.
    if (isFrontdoorBase((s.env && s.env.ANTHROPIC_BASE_URL) || '')) {
        const st = readActiveBackend();
        return (st && st.backend) || 'frontdoor';
    }
    return backendFromSettingsObj(s);
}


// Persisted state (informational; settings.json is the source of truth)
function saveState(target) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ target }, null, 2), 'utf8'); }
    catch (e) { logLine(`state file write failed: ${e.message}`); }
}

async function applyTarget(target) {
    const backend = BACKENDS[target];
    if (!backend) throw new Error('Unknown target: ' + target);

    const settings = readSettings();
    settings.env = settings.env || {};
    settings.env.ANTHROPIC_BASE_URL = backend.base_url;

    let apiKey = backend.api_key;
    // agentrouter: ключ читаем LIVE — литерал BACKENDS фиксируется на старте,
    // а POST /__switch/api/env меняет process.env без рестарта прокси.
    if (target === 'agentrouter') apiKey = agentRouterKey();
    // For freemodel_rotator, fetch active key from rotator API
    if (target === 'freemodel_rotator') {
        try {
            apiKey = await new Promise((resolve, reject) => {
                const rotReq = http.request({
                    hostname: '127.0.0.1', port: 20126, path: '/__fmrot/api/active-key',
                    method: 'GET', timeout: 3000,
                }, (rotRes) => {
                    let b = '';
                    rotRes.on('data', c => b += c);
                    rotRes.on('end', () => {
                        try {
                            const data = JSON.parse(b);
                            if (data.apiKey) { resolve(data.apiKey); logLine(`rotator key: ${data.email} → ${data.apiKeyMask}`); }
                            else reject(new Error('No active key in rotator'));
                        } catch { reject(new Error('Invalid rotator response')); }
                    });
                });
                rotReq.on('error', (e) => reject(e));
                rotReq.end();
            });
        } catch (e) {
            logLine(`rotator key fetch failed: ${e.message}`);
            apiKey = '';
        }
    }

    settings.env.ANTHROPIC_API_KEY = apiKey;
    clearOtEnv(settings);   // убрать ourtoken AUTH_TOKEN/маппинги, иначе перебьют API_KEY
    // fm_openai: helper с fm-active-key.txt надо убрать, иначе currentTarget()
    // детектит apihelper, а Claude Code шлёт ключ мимо прокси
    if (backend.clear_helper) settings.apiKeyHelper = '';
    // model: строка → задать; null → удалить (бэкенд не знает чужую модель —
    // иначе ComboWombo от OmniRoute залипает на FreeModel/Aerolink/Conduit);
    // undefined → не трогать.
    if (backend.model === null) delete settings.model;
    else if (backend.model) settings.model = backend.model;
    writeSettings(settings);
    saveState(target);
    logLine(`switched to ${target} (${backend.label})`);
}

// Settings presets: GET current, POST apply a merged JSON patch.
function handleSettingsCurrent(res) {
    try {
        const s = readSettings();
        return jsonRes(res, 200, { settings: s });
    } catch (e) {
        return jsonRes(res, 500, { error: e.message });
    }
}

async function handleSettingsApply(req, res) {
    try {
        const { settings: patch } = await readJsonBody(req);
        if (!patch || typeof patch !== 'object') return jsonRes(res, 400, { error: 'settings object required' });
        const current = readSettings();
        // Shallow merge top-level fields; for env, merge one level deeper.
        const next = { ...current };
        for (const [k, v] of Object.entries(patch)) {
            if (k === 'env' && typeof v === 'object') {
                next.env = { ...current.env };
                for (const [ek, ev] of Object.entries(v)) {
                    if (ev === null) delete next.env[ek];   // null = drop key (e.g. clear shadowing ANTHROPIC_API_KEY)
                    else next.env[ek] = ev;
                }
            } else if (v === null) {
                delete next[k];   // top-level null = drop field (e.g. clear stuck `model`)
            } else {
                next[k] = v;
            }
        }
        writeSettings(next);
        // AgentRouter: пресет не знает ключ — подставляем активный из ar-active-key.txt,
        // а helper убираем (WAF agentrouter пускает только AUTH_TOKEN-путь).
        // Ловим и голый домен, и локальные прокси :20133/:20132 — пресет указывает
        // keepalive, а не домен (у gpt /v1/messages сломан, нужен конвертер).
        const applyBase = (next.env && next.env.ANTHROPIC_BASE_URL) || '';
        const isArBase = applyBase.startsWith(AR_BASE_URL)
            || /^https?:\/\/(localhost|127\.0\.0\.1):(20133|20132)\b/.test(applyBase);
        if (isArBase) {
            next.env = next.env || {};
            delete next.apiKeyHelper;
            delete next.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete next.env.ANTHROPIC_API_KEY;
            let activeKey = '';
            try { activeKey = fs.readFileSync(AR_ACTIVE_KEY_FILE, 'utf8').trim(); } catch {}
            // Заглушка: ключ инжектят прокси :20133/:20132 из ar-active-key.txt.
            if (activeKey) next.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            else delete next.env.ANTHROPIC_AUTH_TOKEN;
            writeSettings(next);
        }
        return jsonRes(res, 200, { ok: true, current: currentTarget() });
    } catch (e) {
        return jsonRes(res, 400, { error: e.message });
    }
}

function jsonRes(res, code, body) {
    if (res.writableEnded) return;
    // Заголовки могли уйти раньше — это keepalive длинного батча (см. jsonKeepalive).
    // Код ответа тогда уже не сменить, поэтому ошибку несёт поле error в теле; фронт
    // проверяет его наравне с res.ok.
    if (res.headersSent) { res.end(JSON.stringify(body)); return; }
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

// ---- Keepalive для длинных батч-роутов ------------------------------------
// «💳 Балансы всех» и «🔗 Профили» считают минутами (запросы к хосту сериализованы
// шлюзом частоты: 2.5с на agentrouter, и до 15с на каждый неотвечающий fetch) и до
// самого конца не отдают ни байта. Такое молчание рвут веб-антивирусы с MITM на
// localhost, расширения и корп-прокси: в браузере это `TypeError: Failed to fetch`,
// хотя расчёт на сервере прошёл нормально и уже лёг на диск (батч мержит каждую
// тройку сразу). Поймано у пользователя на другой машине, где кроме текста
// уведомления диагностики не было вообще.
//
// Лечение: если работа тянется дольше KEEPALIVE_AFTER_MS, отдаём заголовки и капаем
// по пробелу — соединение живое. Ведущие пробелы легальны в JSON, `res.json()` и
// `JSON.parse` их игнорируют, поэтому разбор на фронте не меняется.
//
// Капаем ЛЕНИВО намеренно: ранние отказы (модуль не загрузился, файл не читается)
// успевают отдать честный 500 и код ответа сохраняется. Позднюю ошибку видно только
// по полю error в теле — из-за этого guard `data.error` в дашборде обязателен.
const KEEPALIVE_AFTER_MS = 4000;
const KEEPALIVE_EVERY_MS = 5000;

function jsonKeepalive(res) {
    let arm = null, drip = null;
    const stop = () => {
        if (arm) { clearTimeout(arm); arm = null; }
        if (drip) { clearInterval(drip); drip = null; }
    };
    arm = setTimeout(() => {
        arm = null;
        if (res.writableEnded || res.headersSent) return;
        try { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); }
        catch { return; }
        drip = setInterval(() => {
            if (res.writableEnded) return stop();
            try { res.write(' '); } catch { stop(); }
        }, KEEPALIVE_EVERY_MS);
        if (drip.unref) drip.unref();
    }, KEEPALIVE_AFTER_MS);
    if (arm.unref) arm.unref();
    res.on('close', stop);
    return stop;
}

// ---- Keepalive-мост (хедж-конфиг :20133/:20155/:20156) ---------------------
// Дашборд ходит только через /__switch/api/... — кидаем запрос в keepalive-прокси
// (GET /__state, POST /__config). Порт передаём параметром — один мост
// обслуживает все keepalive-инстансы (AgentRouter, Tabi, GoRouter).
function keepaliveFetch(method, path, body, port) {
    return new Promise((resolve) => {
        const p = Number(port);
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port: p,
            method,
            path,
            headers: data ? {
                'content-type': 'application/json; charset=utf-8',
                'content-length': Buffer.byteLength(data),
            } : {},
            timeout: 3000,
        }, (up) => {
            const chunks = [];
            up.on('data', (c) => chunks.push(c));
            up.on('end', () => {
                let obj = null;
                try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {}
                resolve({ ok: true, status: up.statusCode, data: obj });
            });
            up.on('error', () => resolve({ ok: false, status: 0, data: null }));
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, status: 0, data: null }); });
        req.on('error', () => resolve({ ok: false, status: 0, data: null }));
        if (data) req.write(data);
        req.end();
    });
}

// Фабрика хендлеров моста для конкретного keepalive-инстанса (по порту).
function makeKeepaliveHandlers(port) {
    // GET .../keepalive/state → { cfg, upstream, port, idle_ms, stats }.
    async function handleState(req, res) {
        const r = await keepaliveFetch('GET', '/__state', null, port);
        if (!r.ok || !r.data) return jsonRes(res, 502, { error: 'keepalive :' + port + ' не отвечает' });
        return jsonRes(res, 200, r.data);
    }

    // POST .../keepalive/config { hedgeMs?, maxHedges?, maxAttempts?, preCommitMs? } → патчим на лету.
    async function handleConfig(req, res) {
        let b = '';
        req.on('data', (c) => b += c);
        req.on('end', async () => {
            try {
                const patch = JSON.parse(b || '{}');
                const KNOBS = ['hedgeMs', 'maxHedges', 'maxAttempts', 'preCommitMs'];
                if (!KNOBS.some(k => k in patch))
                    return jsonRes(res, 400, { error: 'ожидался { ' + KNOBS.join('?, ') + '? }' });
                const r = await keepaliveFetch('POST', '/__config', patch, port);
                if (!r.ok || !r.data) return jsonRes(res, 502, { error: 'keepalive :' + port + ' не отвечает' });
                logLine(`keepalive config :${port} -> ${JSON.stringify(patch)}`);
                return jsonRes(res, 200, r.data);
            } catch (e) { return jsonRes(res, 400, { error: e.message }); }
        });
        req.on('error', () => jsonRes(res, 400, { error: 'read error' }));
    }

    return { state: handleState, config: handleConfig };
}

// Инстансы моста: AgentRouter :20133, Tabi :20155, GoRouter :20156, XPeach :20157.
const keepaliveAr = makeKeepaliveHandlers(Number(process.env.AR_KEEPALIVE_PORT || 20133));
const keepaliveTb = makeKeepaliveHandlers(Number(process.env.TB_KEEPALIVE_PORT || 20155));
const keepaliveGo = makeKeepaliveHandlers(Number(process.env.GO_KEEPALIVE_PORT || 20156));
const keepaliveXp = makeKeepaliveHandlers(Number(process.env.XP_KEEPALIVE_PORT || 20157));


// ---- /__switch/api/whoami --------------------------------------------------
// Body: { input: "<paste from OmniRoute log>" }
// Pulls all hex/dash chunks of length >= 8, looks each up in
// provider_connections by id prefix, returns matches.

function extractIdCandidates(input) {
    if (!input) return [];
    // Match hex sequences possibly separated by dashes, length >= 8.
    const matches = String(input).match(/[0-9a-f]{8}(?:-?[0-9a-f]+)*/gi) || [];
    const cleaned = new Set();
    for (const raw of matches) {
        // Take first 8 hex chars as prefix
        const hex = raw.replace(/-/g, '');
        if (hex.length >= 8) cleaned.add(hex.substring(0, 8).toLowerCase());
    }
    return Array.from(cleaned);
}

function querySqlite(sql) {
    if (!fs.existsSync(SQLITE_EXE)) {
        throw new Error(`sqlite3 not found at ${SQLITE_EXE} (set SQLITE3 env var)`);
    }
    if (!fs.existsSync(OMNI_DB)) {
        throw new Error(`OmniRoute db not found at ${OMNI_DB}`);
    }
    // Read-only copy of WAL-mode DB so live OmniRoute isn't blocked
    const tmp = path.join(os.tmpdir(), 'omni_whoami_proxy.sqlite');
    fs.copyFileSync(OMNI_DB, tmp);
    for (const ext of ['-wal', '-shm']) {
        try { fs.copyFileSync(OMNI_DB + ext, tmp + ext); } catch {}
    }
    const out = execFileSync(SQLITE_EXE, [tmp, '-json', sql], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
    });
    return out ? JSON.parse(out) : [];
}

function lookupAccounts(prefixes) {
    if (!prefixes.length) return [];
    const orClauses = prefixes.map(p => `id LIKE '${p.replace(/'/g, '')}%'`).join(' OR ');
    const sql = `SELECT id, provider, auth_type, name, email, is_active, test_status,
                        error_code, last_error, rate_limited_until, last_used_at, created_at
                 FROM provider_connections
                 WHERE ${orClauses};`;
    return querySqlite(sql);
}

function listAllAccounts() {
    const sql = `SELECT id, provider, auth_type, name, email, is_active, test_status,
                        error_code, rate_limited_until, last_used_at, created_at
                 FROM provider_connections
                 ORDER BY is_active DESC, datetime(coalesce(last_used_at, created_at)) DESC;`;
    return querySqlite(sql);
}

function handleWhoami(req, res) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        try {
            const { input } = JSON.parse(body || '{}');
            const prefixes = extractIdCandidates(input);
            const matches = lookupAccounts(prefixes);
            jsonRes(res, 200, { prefixes, matches });
        } catch (e) {
            jsonRes(res, 400, { error: e.message });
        }
    });
}

function handleAccounts(res) {
    try {
        jsonRes(res, 200, { accounts: dashApi.listOmniAccountsWithQuotas() });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// ---- Notion / FreeModel sessions + OmniRoute toggle ----------------------
// All real work lives in internal/dashboard-api.js so the CLI menu and this
// HTTP server stay in sync.
const dashApi = require('../internal/dashboard-api');
const freemodelManager = require('../internal/freemodel-manager');

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        // Копим Buffer'ы и декодируем разом: `body += chunk` резал многобайтовый
        // UTF-8 на границе чанка и превращал кириллицу в U+FFFD.
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

// ───── FreeModel авто-подмена мёртвого аккаунта ($0 → следующий) ───────
// В режиме API Helper claude code на каждый запрос читает ключ из
// ~/.claude/fm-active-key.txt (TTL=0). Значит подмена = переписать этот файл
// ключом другого аккаунта. Перезапуск не нужен.
//
// Логика намеренно тупая и предсказуемая (в отличие от прежнего
// балансировщика «наименее использованный»): пока у активного есть деньги —
// не трогаем его вообще. Как только баланс = $0.00 (акк мёртв, см.
// fmIsZeroBalance) — берём СЛЕДУЮЩИЙ по списку аккаунт с деньгами, по кругу.
// Порядок списка = порядок дашборда (getFreemodelSessions: date desc).
const FM_ACTIVE_KEY_FILE   = path.join(os.homedir(), '.claude', 'fm-active-key.txt');
const FM_AUTOROTATE_FILE   = path.join(__dirname, '..', 'logs', '.freemodel_autorotate.json');

const fmAuto = {
    enabled: false,
    intervalMs: 120000,   // как часто проверяем баланс активного
    // TTL кэша для КАНДИДАТОВ при поиске замены. Активный не по нему — см.
    // fmActiveTtl(): иначе при интервале меньше TTL тик крутил бы таймер
    // вхолостую, ничего не обновляя (баг: «просто таймер хуячит»).
    quotaTtlMs: 5 * 60 * 1000,
    maxProbes: 3,         // сколько кандидатов максимум проверяем браузером за тик
    activeName: null,
    lastSwitch: 0,
    lastTickAt: 0,
    nextTickAt: 0,
    ticking: false,
    timer: null,
    wakeAt: 0,            // «раньше этого момента ничего не изменится» (весь пул остывает)
    recent: [],           // [{ts, from, to, email, reason, balance}]
};

function fmReadKeyFromInfo(s) {
    try {
        const f = path.join(s.path, 'account_info.txt');
        if (fs.existsSync(f)) {
            const m = fs.readFileSync(f, 'utf-8').match(/^API Key:\s*((?:fe[_-]|sk-)[A-Za-z0-9_-]{20,})/m);
            if (m) return m[1];
        }
    } catch {}
    return null;
}
// Пригодные кандидаты: статус ✅, не banned вручную, есть валидный ключ.
// Порядок сохраняем как в списке — по нему и ищем «следующего соседа».
// Авто-баненых ($0) не выкидываем: они остаются в списке как позиции, но
// hasMoney=false, так что кандидатами не станут, пока баланс не капнет.
//
// «Перезарядка» (cooling): у аккаунта выжрано 5h/7d-окно, платить сейчас нечем,
// но известно когда отпустит. Такой аккаунт НЕ мёртв — просто пропускаем его в
// очереди кандидатов и просыпаемся к его cooldownUntil.
async function fmGetUsable() {
    const sessions = await dashApi.listFreemodelSessions({ withQuotas: 'cache' });
    const out = [];
    for (const s of sessions) {
        const m = s.meta || {};
        if (s.status !== '✅' || (m.banned && !m.autoBanned)) continue;
        const key = m.apiKey || fmReadKeyFromInfo(s);
        if (!key) continue;
        const state = s.quota?.state;
        const cooling = dashApi.fmIsCooling(m) || state === 'cooldown';
        out.push({
            name: s.name,
            email: s.email || s.name,
            key,
            balance: s.quota?.available || '',
            zero: dashApi.fmIsZeroBalance(s.quota),   // прямо сейчас платить нечем
            // Годен ли кандидат: по новому state, с фолбэком на старый предикат
            // для кеша, снятого до появления state.
            hasMoney: state ? state === 'ok' : dashApi.fmHasMoney(s.quota),
            cooling,
            coolReason: m.coolReason || s.quota?.coolReason || '',
            cooldownUntil: m.cooldownUntil || s.quota?.cooldownUntil || '',
            quotaAt: s.quota?.updatedAt || 0,         // для TTL-проверки свежести кэша
        });
    }
    return out;
}
// "через 3ч 12м" — для логов и для причины свича.
function fmFmtEta(until) {
    const t = typeof until === 'number' ? until : Date.parse(until);
    const ms = t - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return 'сейчас';
    const m = Math.round(ms / 60000);
    if (m < 60) return `через ${m}м`;
    return `через ${Math.floor(m / 60)}ч ${m % 60}м`;
}
// Человеческая причина, почему с аккаунта надо уйти прямо сейчас. Уход нужен в
// любом случае (платить нечем), но перезарядка — временная, и это должно быть
// видно в логе, иначе выглядит как смерть аккаунта.
function fmZeroReason(q) {
    if (q?.state === 'cooldown') {
        const w = q.coolReason || '5h';
        return q.cooldownUntil
            ? `перезарядка окна ${w} (${fmFmtEta(q.cooldownUntil)})`
            : `перезарядка окна ${w}`;
    }
    return 'баланс $0.00';
}
// Ближайший момент, когда хоть один остывающий аккаунт снова станет пригоден.
// null — остывающих нет или ни у кого не распарсился дедлайн.
function fmNearestCooldown(list) {
    let best = null;
    for (const s of list) {
        if (!s.cooling || !s.cooldownUntil) continue;
        const t = Date.parse(s.cooldownUntil);
        if (!Number.isFinite(t) || t <= Date.now()) continue;
        if (best === null || t < best) best = t;
    }
    return best;
}
// Кэш квоты протух? (нет данных или старше TTL)
function fmStale(entry, ttlMs) {
    return !entry || !entry.quotaAt || (Date.now() - entry.quotaAt) > ttlMs;
}
// TTL для АКТИВНОГО аккаунта: чуть меньше интервала тика, чтобы каждый тик
// реально перечитывал баланс, а не упирался в «ещё свежий» кэш. Раньше здесь
// стоял общий TTL 5 мин: при интервале 30-60с большинство тиков не делали
// ничего. Рефреш теперь идёт по JSON-API (~1.5с), а не через браузер (~38с),
// так что экономить на нём больше незачем.
function fmActiveTtl() {
    return Math.max(15000, fmAuto.intervalMs - 5000);
}
// Кто реально активен по версии Claude Code: владелец ключа из fm-active-key.txt.
// Это источник правды — на него и должен смотреть ротатор, иначе мониторит чужой акк.
function fmActiveFromFile(usable) {
    try {
        const key = fs.readFileSync(FM_ACTIVE_KEY_FILE, 'utf-8').trim();
        if (!key) return null;
        return usable.find(s => s.key === key) || null;
    } catch { return null; }
}
// Соседи по кругу: список кандидатов, начиная со следующего за idx.
// idx = -1 (активного в списке нет) → просто весь список с начала.
function fmNeighborsAfter(list, idx) {
    if (idx < 0) return list.slice();
    return list.slice(idx + 1).concat(list.slice(0, idx));
}

function fmWriteActiveKey(key) {
    try {
        fs.writeFileSync(FM_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        return true;
    } catch (e) {
        logLine(`fm auto: write key failed: ${e.message}`);
        return false;
    }
}
// Гарантируем helper-режим в settings.json (как кнопка «Активировать» с mode=helper).
function fmEnsureHelperMode() {
    try {
        const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
        const raw = fs.readFileSync(settingsFile, 'utf-8');
        const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const want = keyHelperCmd('fm-active-key.txt');
        const already = settings.apiKeyHelper === want
            && settings.env?.ANTHROPIC_BASE_URL === 'https://cc.freemodel.dev'
            && !settings.env?.ANTHROPIC_API_KEY;
        if (already) return { changed: false };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(settingsFile, settingsFile + '.bak-fmauto-' + stamp);
        settings.env = settings.env || {};
        settings.env.ANTHROPIC_BASE_URL = 'https://cc.freemodel.dev';
        settings.apiKeyHelper = want;
        settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
        delete settings.env.ANTHROPIC_API_KEY;  // direct key would shadow the helper
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
        logLine('fm auto: settings.json → API Helper mode');
        return { changed: true };
    } catch (e) {
        return { changed: false, error: e.message };
    }
}

async function fmAutoTick() {
    if (fmAuto.ticking) return;
    // Тумблер выключен — не трогаем активный ключ ни при каких условиях. Балансовый
    // ноль не всегда значит непригодность (кредиты могут ещё отработать), поэтому
    // решение остаётся за юзером. Проверка нужна и здесь, а не только в fmAutoKick:
    // тик, запущенный до выключения, иначе доработал бы и переключил аккаунт.
    if (!fmAuto.enabled) return;
    fmAuto.ticking = true;
    fmAuto.lastTickAt = Date.now();
    fmAuto.wakeAt = 0;    // ставится заново, только если снова упрёмся в перезарядку
    const cwd = process.cwd();
    try {
        process.chdir(path.join(__dirname, '..'));

        let usable = await fmGetUsable();
        if (!usable.length) { logLine('fm auto: нет пригодных аккаунтов'); return; }

        // (A) РЕКОНСИЛЯЦИЯ: активный = владелец ключа из fm-active-key.txt (источник
        // правды). Без этого persist-activeName расходится с реальностью, и мы
        // сторожим чужой простаивающий аккаунт, не видя нуля на рабочем.
        const fileActive = fmActiveFromFile(usable);
        if (fileActive && fileActive.name !== fmAuto.activeName) {
            logLine(`fm auto: реконсиляция активного → ${fileActive.email} (из fm-active-key.txt)`);
            fmAuto.activeName = fileActive.name;
            fmAutoSavePersist();
        }

        // (B) Рефреш ТОЛЬКО активного, каждый тик (TTL привязан к интервалу).
        // Стоит ~1.5с через JSON-API, браузер не поднимается.
        let activeIdx = usable.findIndex(s => s.name === fmAuto.activeName);
        if (activeIdx >= 0 && fmStale(usable[activeIdx], fmActiveTtl())) {
            try { await dashApi.refreshOneFreemodelQuota(usable[activeIdx].name); } catch {}
            usable = await fmGetUsable();
            activeIdx = usable.findIndex(s => s.name === fmAuto.activeName);
        }
        const active = activeIdx >= 0 ? usable[activeIdx] : null;

        // (C) Активный жив (на балансе есть деньги) — ничего не делаем. Это главное
        // отличие от прежней ротации: пока акк платит, его не дёргаем.
        if (active && !active.zero) return;

        const reason = !active ? 'no-active' : (active.cooling ? 'cooldown' : 'dead');
        if (active) {
            const why = active.cooling
                ? `окно ${active.coolReason || '5h'} выжрано${active.cooldownUntil ? `, нальётся ${fmFmtEta(active.cooldownUntil)}` : ''}`
                : 'платить нечем';
            logLine(`fm auto: у ${active.email} ${active.balance || '$0.00'} — ${why}, ищу замену`);
        }

        // (D) Ищем СЛЕДУЮЩЕГО по списку с деньгами (по кругу от активного).
        // По кэшу — чтобы не сканировать пул; кандидата подтверждаем браузером
        // перед свичем (кэш мог протухнуть и обещать деньги, которых уже нет).
        const queue = fmNeighborsAfter(usable, activeIdx).filter(s => s.hasMoney && !s.cooling);
        if (!queue.length) {
            // Весь пул на перезарядке — это НЕ повод кого-то хоронить. Говорим когда
            // отпустит и просыпаемся к этому моменту, а не через фиксированный тик.
            const eta = fmNearestCooldown(usable);
            if (eta) {
                logLine(`fm auto: весь пул на перезарядке — ближайший освободится ${fmFmtEta(eta)}`);
                fmAutoWakeAt(eta);
            } else {
                logLine('fm auto: свободных аккаунтов с балансом нет — остаёмся на месте');
            }
            return;
        }

        let probes = 0;
        for (const cand of queue) {
            if (fmStale(cand, fmAuto.quotaTtlMs)) {
                if (probes >= fmAuto.maxProbes) {
                    logLine(`fm auto: лимит проверок (${fmAuto.maxProbes}) за тик — дожму на следующем`);
                    break;
                }
                probes++;
                try { await dashApi.refreshOneFreemodelQuota(cand.name); } catch {}
                const fresh = (await fmGetUsable()).find(s => s.name === cand.name);
                if (!fresh || !fresh.hasMoney) {
                    logLine(`fm auto: кандидат ${cand.email} тоже пустой (${fresh?.balance || '—'}) — следующий`);
                    continue;
                }
                cand.balance = fresh.balance;
                cand.key = fresh.key;
            }
            // Между началом тика и этой строкой был сетевой запрос — тумблер мог
            // успеть выключиться. Перепроверяем перед самой записью ключа.
            if (!fmAuto.enabled) { logLine('fm auto: выключен по ходу тика — подмену отменяю'); return; }
            if (!fmWriteActiveKey(cand.key)) break;
            const from = fmAuto.activeName;
            fmAuto.activeName = cand.name;
            fmAuto.lastSwitch = Date.now();
            fmAuto.recent.unshift({ ts: Date.now(), from, to: cand.name, email: cand.email, reason, balance: cand.balance });
            fmAuto.recent = fmAuto.recent.slice(0, 20);
            fmAutoSavePersist();
            logLine(`fm auto: ${reason} → ${cand.email} (${cand.balance})`);
            return;
        }
    } catch (e) {
        logLine(`fm auto tick error: ${e.message}`);
    } finally {
        try { process.chdir(cwd); } catch {}
        fmAuto.ticking = false;
    }
}

// Тик просит проснуться не раньше указанного момента (весь пул остывает —
// дёргать freemodel каждые 2 минуты бессмысленно). Расписание это учтёт.
function fmAutoWakeAt(ts) {
    fmAuto.wakeAt = ts || 0;
}
// Пауза до следующего тика: обычный интервал, но если известно что раньше
// определённого момента ничего не изменится — спим до него. Потолок 15 минут,
// чтобы ручной рефреш или новый аккаунт подхватились без перезапуска ротатора.
const FM_WAKE_CAP_MS = 15 * 60 * 1000;
function fmNextDelay() {
    const base = fmAuto.intervalMs;
    if (!fmAuto.wakeAt) return base;
    const left = fmAuto.wakeAt - Date.now();
    if (!(left > base)) { fmAuto.wakeAt = 0; return base; }
    return Math.min(left, FM_WAKE_CAP_MS);
}
function fmAutoSchedule() {
    if (fmAuto.timer) clearTimeout(fmAuto.timer);
    const delay = fmNextDelay();
    fmAuto.nextTickAt = Date.now() + delay;
    fmAuto.timer = setTimeout(async () => {
        await fmAutoTick();
        if (fmAuto.enabled) fmAutoSchedule();
    }, delay);
}
function fmAutoStart(opts = {}) {
    if (typeof opts.intervalMs === 'number' && opts.intervalMs >= 30000) fmAuto.intervalMs = opts.intervalMs;
    const helper = fmEnsureHelperMode();
    fmAuto.enabled = true;
    fmAutoSavePersist();
    // Немедленный тик, затем расписание.
    fmAutoTick().finally(() => { if (fmAuto.enabled) fmAutoSchedule(); });
    return { helper };
}
function fmAutoStop() {
    fmAuto.enabled = false;
    if (fmAuto.timer) { clearTimeout(fmAuto.timer); fmAuto.timer = null; }
    fmAuto.nextTickAt = 0;
    fmAutoSavePersist();
}
// Внеочередной тик: аккаунт выбыл (бан вручную или нулевой баланс) — подменяем
// сразу, не дожидаясь таймера. Иначе Claude Code до следующего тика продолжает
// ходить с ключом мёртвого аккаунта. Не await — вызывающему ответ не ждать.
function fmAutoKick(name, why) {
    if (!fmAuto.enabled || name !== fmAuto.activeName) return;
    logLine(`fm auto: активный ${name} выбыл (${why}) — внеочередная подмена`);
    fmAutoTick().catch(e => logLine(`fm auto kick error: ${e.message}`));
}
function fmAutoStatus() {
    return {
        enabled: fmAuto.enabled,
        intervalMs: fmAuto.intervalMs,
        activeName: fmAuto.activeName,
        lastSwitch: fmAuto.lastSwitch,
        lastTickAt: fmAuto.lastTickAt,
        nextTickAt: fmAuto.nextTickAt,
        ticking: fmAuto.ticking,
        recent: fmAuto.recent,
    };
}
function fmAutoSavePersist() {
    try {
        const dir = path.dirname(FM_AUTOROTATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(FM_AUTOROTATE_FILE, JSON.stringify({
            enabled: fmAuto.enabled, intervalMs: fmAuto.intervalMs, activeName: fmAuto.activeName,
        }, null, 2), 'utf-8');
    } catch {}
}
function fmAutoLoadPersist() {
    try {
        if (fs.existsSync(FM_AUTOROTATE_FILE)) {
            const j = JSON.parse(fs.readFileSync(FM_AUTOROTATE_FILE, 'utf-8'));
            // Старый файл ротатора мог хранить интервал 90с/15с — поднимаем до
            // минимума новой схемы (проверка баланса дешёвая, но не бесплатная).
            if (typeof j.intervalMs === 'number' && j.intervalMs >= 30000) fmAuto.intervalMs = j.intervalMs;
            if (j.activeName) fmAuto.activeName = j.activeName;
            return !!j.enabled;
        }
    } catch {}
    return false;
}

function handleNotionSessions(res) {
    try {
        // Resolve relative to project root (we live in routing/, sessions in ../manual_sessions)
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            jsonRes(res, 200, { sessions: dashApi.listNotionSessions() });
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleFreemodelSessions(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const refresh = url.searchParams.get('refresh') === '1';
    const withQuotas = refresh ? 'refresh' : 'cache';
    try {
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const sessions = await dashApi.listFreemodelSessions({ withQuotas });
            jsonRes(res, 200, { sessions, refreshed: refresh });
            // Массовый рефреш мог обнулить активного (выжранное окно или пустой
            // кошелёк) — тогда подменяем сразу, не дожидаясь тика.
            if (refresh) {
                const act = sessions.find(s => s.name === fmAuto.activeName);
                if (act && dashApi.fmIsZeroBalance(act.quota)) fmAutoKick(act.name, fmZeroReason(act.quota));
            }
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// Read freemodel referral chain: keys.txt + .last_invite + config.INITIAL_INVITE.
function handleFreemodelInvites(req, res) {
    try {
        const root = path.join(__dirname, '..');
        const keysFile = path.join(root, 'freemodel', 'keys.txt');
        const lastFile = path.join(root, 'freemodel', '.last_invite');
        const configFile = path.join(root, 'freemodel', 'config.js');

        const chain = [];
        if (fs.existsSync(keysFile)) {
            const raw = fs.readFileSync(keysFile, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim()) continue;
                const parts = line.split('|');
                const email = parts[0] || '';
                const code = parts[2] || '';
                if (/^FRE-[A-Za-z0-9]+$/.test(code)) {
                    chain.push({ email, code });
                }
            }
        }

        let last = null;
        if (fs.existsSync(lastFile)) {
            const v = fs.readFileSync(lastFile, 'utf8').trim();
            if (/^FRE-[A-Za-z0-9]+$/.test(v)) last = v;
        }

        let initial = null;
        try {
            // Clear require-cache so edits to config.js show up live.
            delete require.cache[require.resolve(configFile)];
            const cfg = require(configFile);
            if (/^FRE-[A-Za-z0-9]+$/.test(cfg.INITIAL_INVITE || '')) initial = cfg.INITIAL_INVITE;
        } catch {}

        jsonRes(res, 200, { last, initial, chain: chain.reverse() });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleFreemodelSetInvite(req, res) {
    try {
        const body = await readJsonBody(req);
        const code = (body.code || '').trim();
        if (!/^FRE-[A-Za-z0-9]+$/.test(code)) {
            return jsonRes(res, 400, { error: 'invalid code (expected FRE-xxx)' });
        }
        const lastFile = path.join(__dirname, '..', 'freemodel', '.last_invite');
        fs.writeFileSync(lastFile, code + '\n', 'utf8');
        jsonRes(res, 200, { ok: true, code });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// GET email-backend: текущий выбор (timeweb | tmailor) для autoreger.
function handleFreemodelGetEmailBackend(req, res) {
    try {
        jsonRes(res, 200, { ok: true, backend: dashApi.getEmailBackend() });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// POST email-backend { backend: 'timeweb' | 'tmailor' } → persist в файл.
async function handleFreemodelSetEmailBackend(req, res) {
    try {
        const body = await readJsonBody(req);
        const backend = (body.backend || '').trim();
        const r = dashApi.setEmailBackend(backend);
        logLine(`freemodel email backend → ${backend}`);
        jsonRes(res, 200, r);
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// GET email-domain: текущий домен регистрации + список доступных.
// Заодно отдаём apiBase для кнопки "скопировать export-блок" — он личный
// (может быть RDP-хост), поэтому живёт в freemodel/.env, а не в коде дашборда.
function handleFreemodelGetEmailDomain(req, res) {
    try {
        jsonRes(res, 200, {
            ok: true,
            ...dashApi.listEmailDomains(),
            apiBase: process.env.FM_API_BASE || 'http://localhost:20130/v1',
        });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// POST email-domain { domain } → persist. timeweb-imap-client берёт при старте.
async function handleFreemodelSetEmailDomain(req, res) {
    try {
        const body = await readJsonBody(req);
        const domain = (body.domain || '').trim();
        const r = dashApi.setEmailDomain(domain);
        logLine(`freemodel email domain → ${domain}`);
        jsonRes(res, 200, r);
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleDevinSessions(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const refresh = url.searchParams.get('refresh') === '1';
    const withQuotas = refresh ? 'refresh' : 'cache';
    try {
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const sessions = await dashApi.listDevinSessions({ withQuotas });
            jsonRes(res, 200, { sessions, refreshed: refresh });
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleOmniToggle(req, res) {
    try {
        const { id, active } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'missing id' });
        const row = dashApi.toggleOmniAccount(id, !!active);
        logLine(`omni toggle: ${id.substring(0,8)} -> ${active ? 'active' : 'inactive'}`);
        jsonRes(res, 200, { ok: true, account: row });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleSessionOpen(req, res) {
    try {
        const { kind, name } = await readJsonBody(req);
        if (!kind || !name) return jsonRes(res, 400, { error: 'missing kind/name' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const result = await dashApi.openSessionInBrowser(kind, name);
            logLine(`session open: ${kind}/${name}`);
            jsonRes(res, 200, result);
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleSessionRefreshQuota(req, res) {
    try {
        const { kind, name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'missing name' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            let q;
            if (kind === 'devin') {
                q = await dashApi.refreshOneDevinQuota(name);
            } else {
                q = await dashApi.refreshOneFreemodelQuota(name);
            }
            logLine(`refresh quota: ${kind || 'freemodel'}/${name}`);
            jsonRes(res, 200, { ok: true, name, quota: q });
            // Рефреш увидел $0 → платить нечем (перезарядка окна или пустой
            // кошелёк). Подменяем сразу, а не через тик: иначе Claude Code
            // продолжает бить в аккаунт, который сейчас не отвечает деньгами.
            if (kind !== 'devin' && dashApi.fmIsZeroBalance(q)) fmAutoKick(name, fmZeroReason(q));
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleSessionDelete(req, res) {
    try {
        const { kind, name } = await readJsonBody(req);
        if (!kind || !name) return jsonRes(res, 400, { error: 'missing kind/name' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const result = dashApi.deleteSession(kind, name);
            logLine(`session delete: ${kind}/${name}`);
            jsonRes(res, 200, result);
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleGrokBuild(req, res) {
    try {
        const { name, userCode } = await readJsonBody(req);
        const safe = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
        if (!safe) return jsonRes(res, 400, { error: 'name required' });
        if (!userCode) return jsonRes(res, 400, { error: 'userCode required' });
        const grokDir = grokCookiesDir();
        const cookieFile = path.join(grokDir, `${safe}.json`);
        if (!fs.existsSync(cookieFile)) {
            return jsonRes(res, 404, { error: `session not found: ${safe}` });
        }
        const { spawn } = require('child_process');
        const script = path.join(__dirname, '..', 'grok-launcher', 'camoufox_device.py');
        const child = spawn(process.env.PYTHON || 'python', [script, String(userCode).trim(), safe], {
            cwd: path.dirname(script),
            detached: true,
            stdio: 'ignore',
            env: process.env,
        });
        child.unref();
        logLine(`grok build: запущен camoufox_device для ${safe} (pid ${child.pid})`);
        jsonRes(res, 200, { ok: true, pid: child.pid, name: safe });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Default CLI home (~/.grok) — сюда дашборд подставляет auth.json активного профиля.
// Профили сессий: ~/.grok-<name>/auth.json (после device-auth).
const GROK_DEFAULT_HOME = path.join(os.homedir(), '.grok');
const GROK_ACTIVE_PTR = path.join(GROK_DEFAULT_HOME, 'dashboard-active-session.json');

function grokSanitizeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

function grokProfileHome(name) {
  const safe = grokSanitizeName(name);
  return safe ? path.join(os.homedir(), `.grok-${safe}`) : '';
}

function grokProfileAuthPath(name) {
  const home = grokProfileHome(name);
  return home ? path.join(home, 'auth.json') : '';
}

/** Первый entry из auth.json → identity (email, user_id, expires_at, …). */
function parseGrokAuthIdentity(authObj) {
  if (!authObj || typeof authObj !== 'object') return null;
  const keys = Object.keys(authObj);
  if (!keys.length) return null;
  const entry = authObj[keys[0]] || {};
  return {
    email: entry.email || null,
    userId: entry.user_id || null,
    firstName: entry.first_name || null,
    expiresAt: entry.expires_at || null,
    hasRefresh: !!entry.refresh_token,
    entryKey: keys[0],
  };
}

function readGrokAuthFile(authPath) {
  try {
    if (!authPath || !fs.existsSync(authPath)) return null;
    const stat = fs.statSync(authPath);
    if (stat.size < 20) return null;
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const identity = parseGrokAuthIdentity(auth);
    if (!identity) return null;
    return { auth, identity, mtime: stat.mtime.toISOString(), path: authPath };
  } catch {
    return null;
  }
}

function getDefaultGrokActive() {
  const def = readGrokAuthFile(path.join(GROK_DEFAULT_HOME, 'auth.json'));
  let ptr = null;
  try { ptr = JSON.parse(fs.readFileSync(GROK_ACTIVE_PTR, 'utf8')); } catch {}
  // При helper-mode identity берём из профиля-pointer, если default auth ещё пуст/старый.
  let ptrIdentity = null;
  if (ptr?.name) {
    const p = readGrokAuthFile(grokProfileAuthPath(ptr.name));
    ptrIdentity = p?.identity || null;
  }
  const mode = ptr?.mode === 'helper' ? 'helper' : (ptr?.mode === 'copy' ? 'copy' : (ptr?.name ? 'copy' : null));
  return {
    name: ptr?.name || null,
    mode,
    activatedAt: ptr?.activatedAt || null,
    email: def?.identity?.email || ptrIdentity?.email || ptr?.email || null,
    userId: def?.identity?.userId || ptrIdentity?.userId || ptr?.userId || null,
    firstName: def?.identity?.firstName || ptrIdentity?.firstName || null,
    expiresAt: def?.identity?.expiresAt || ptrIdentity?.expiresAt || null,
    hasAuth: !!def || !!ptrIdentity,
    authMtime: def?.mtime || null,
    helperConfigured: isGrokAuthProviderConfigured(),
    helperPath: grokAuthHelperPath(),
  };
}

/** Абсолютный путь к auth-helper.js (для config.toml). */
function grokAuthHelperPath() {
  return path.resolve(__dirname, '..', 'grok-launcher', 'auth-helper.js');
}

function isGrokAuthProviderConfigured() {
  try {
    const cfg = fs.readFileSync(path.join(GROK_DEFAULT_HOME, 'config.toml'), 'utf8');
    const helper = grokAuthHelperPath().replace(/\\/g, '/');
    const base = path.basename(helper);
    return /auth_provider_command\s*=/.test(cfg) && (cfg.includes(base) || cfg.includes('auth-helper'));
  } catch {
    return false;
  }
}

/**
 * Прописать [auth] auth_provider_command в ~/.grok/config.toml (как apiKeyHelper у Claude).
 * Не трогает остальные секции. Бэкап config.toml.bak-dashboard-auth.
 */
function ensureGrokAuthProviderInConfig() {
  const configPath = path.join(GROK_DEFAULT_HOME, 'config.toml');
  const helperJs = grokAuthHelperPath().replace(/\\/g, '/');
  // Без вложенных кавычек (путь репы без пробелов) — проще для sh -c / TOML
  const cmd = `node ${helperJs}`;
  const label = 'Dashboard';

  fs.mkdirSync(GROK_DEFAULT_HOME, { recursive: true });
  let raw = '';
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { raw = ''; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (raw && !raw.includes('auth-helper')) {
    try {
      fs.copyFileSync(configPath, configPath + '.bak-dashboard-auth-' + stamp);
    } catch (e) {
      logLine(`grok helper config backup failed: ${e.message}`);
    }
  }

  const authBlock =
    `[auth]\n` +
    `auth_provider_command = ${JSON.stringify(cmd)}\n` +
    `auth_provider_label = ${JSON.stringify(label)}\n`;

  if (/^\[auth\]/m.test(raw) || /\n\[auth\]/m.test(raw)) {
    // Заменить/дополнить секцию [auth]
    let replaced = false;
    raw = raw.replace(/(\[auth\][^\[]*)/m, (section) => {
      replaced = true;
      let s = section;
      if (/auth_provider_command\s*=/.test(s)) {
        s = s.replace(/auth_provider_command\s*=\s*.+/m, `auth_provider_command = ${JSON.stringify(cmd)}`);
      } else {
        s = s.replace(/\[auth\]\s*\n?/, `[auth]\nauth_provider_command = ${JSON.stringify(cmd)}\n`);
      }
      if (/auth_provider_label\s*=/.test(s)) {
        s = s.replace(/auth_provider_label\s*=\s*.+/m, `auth_provider_label = ${JSON.stringify(label)}`);
      } else {
        s = s.replace(
          /auth_provider_command\s*=\s*.+/m,
          (line) => `${line}\nauth_provider_label = ${JSON.stringify(label)}`
        );
      }
      // секция должна заканчиваться переводом строки
      if (!s.endsWith('\n')) s += '\n';
      return s;
    });
    if (!replaced) raw = raw.trimEnd() + '\n\n' + authBlock;
  } else {
    raw = (raw ? raw.trimEnd() + '\n\n' : '') + authBlock;
  }

  fs.writeFileSync(configPath, raw.endsWith('\n') ? raw : raw + '\n', 'utf8');
  logLine(`grok helper: config.toml auth_provider_command → ${cmd}`);
  return { configPath, command: cmd, label };
}

/**
 * mode:
 *   'copy'   — как раньше: скопировать ~/.grok-<name>/auth.json → ~/.grok/auth.json
 *   'helper' — pointer + auth_provider_command (аналог FreeModel apiKeyHelper);
 *              auth.json бэкапится и убирается, чтобы grok заново взял токен у helper
 */
function activateGrokSession(name, opts = {}) {
  const mode = opts.mode === 'helper' ? 'helper' : 'copy';
  const safe = grokSanitizeName(name);
  if (!safe) throw new Error('name required');
  const src = grokProfileAuthPath(safe);
  const dstDir = GROK_DEFAULT_HOME;
  const dst = path.join(dstDir, 'auth.json');
  if (!fs.existsSync(src)) {
    throw new Error(`нет auth.json у профиля ${safe} — сначала device-auth (Open Terminal + Approve code)`);
  }
  const srcData = readGrokAuthFile(src);
  if (!srcData) throw new Error(`auth.json профиля ${safe} пустой или битый`);

  fs.mkdirSync(dstDir, { recursive: true });

  const ptr = {
    name: safe,
    mode,
    email: srcData.identity.email,
    userId: srcData.identity.userId,
    activatedAt: Date.now(),
  };
  fs.writeFileSync(GROK_ACTIVE_PTR, JSON.stringify(ptr, null, 2), 'utf8');

  if (mode === 'copy') {
    if (fs.existsSync(dst)) {
      try {
        fs.copyFileSync(dst, path.join(dstDir, 'auth.json.bak-dashboard'));
      } catch (e) {
        logLine(`grok activate(copy): backup failed: ${e.message}`);
      }
    }
    fs.copyFileSync(src, dst);
    logLine(`grok activate(copy): ${safe} → ${dst} (${srcData.identity.email || 'no-email'})`);
    return {
      ok: true,
      mode: 'copy',
      name: safe,
      email: srcData.identity.email,
      userId: srcData.identity.userId,
      firstName: srcData.identity.firstName,
      expiresAt: srcData.identity.expiresAt,
      hasRefresh: srcData.identity.hasRefresh,
      dst,
      message: 'COPY: auth.json → ~/.grok. Перезапусти grok.',
    };
  }

  // helper mode
  const cfg = ensureGrokAuthProviderInConfig();
  if (fs.existsSync(dst)) {
    try {
      fs.copyFileSync(dst, path.join(dstDir, 'auth.json.bak-dashboard-helper'));
      fs.unlinkSync(dst);
    } catch (e) {
      logLine(`grok activate(helper): clear auth failed: ${e.message}`);
    }
  }
  // lock-файл мешает иногда — не критично
  try { fs.unlinkSync(path.join(dstDir, 'auth.json.lock')); } catch {}

  logLine(`grok activate(helper): ${safe} ptr only · ${srcData.identity.email || 'no-email'}`);
  return {
    ok: true,
    mode: 'helper',
    name: safe,
    email: srcData.identity.email,
    userId: srcData.identity.userId,
    firstName: srcData.identity.firstName,
    expiresAt: srcData.identity.expiresAt,
    hasRefresh: srcData.identity.hasRefresh,
    ptr: GROK_ACTIVE_PTR,
    helperCommand: cfg.command,
    configPath: cfg.configPath,
    message:
      'HELPER: pointer + auth_provider_command. auth.json сброшен — перезапусти grok, он возьмёт токен у helper.',
  };
}

/** weeklyUsedPct из meta; null если нет данных. */
function grokMetaUsedPct(meta) {
  const q = meta?.quota;
  if (!q) return null;
  if (typeof q.credits?.weeklyUsedPct === 'number') return q.credits.weeklyUsedPct;
  const r = q.rateLimits;
  if (r && r.totalQueries > 0) {
    return ((r.totalQueries - r.remainingQueries) / r.totalQueries) * 100;
  }
  // квота есть, weekly ещё не заполнилось → считаем 0
  if (q.plan || q.credits) return 0;
  return null;
}

/**
 * Выбрать профиль с максимальным остатком квоты среди authorized + не cooldown.
 * Если bestOnlyWithQuota и у всех нет meta — ошибка с подсказкой refresh.
 */
function pickBestGrokSession(opts = {}) {
  const grokDir = grokCookiesDir();
  let files = [];
  try {
    files = fs.readdirSync(grokDir).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
  } catch {
    files = [];
  }
  const now = Date.now();
  const candidates = [];
  for (const f of files) {
    const safe = f.replace(/\.json$/, '');
    const authPath = grokProfileAuthPath(safe);
    const authData = readGrokAuthFile(authPath);
    if (!authData) continue;
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(grokDir, `${safe}.meta.json`), 'utf8')) || {};
    } catch {}
    if (meta.cooldownUntil && Number(meta.cooldownUntil) > now) continue;
    const used = grokMetaUsedPct(meta);
    candidates.push({
      name: safe,
      used: used == null ? 50 : used, // без квоты — середина, не приоритет
      usedKnown: used != null,
      email: authData.identity.email,
    });
  }
  if (!candidates.length) {
    throw new Error('нет authorized профилей (нужен auth.json в ~/.grok-<name>)');
  }
  // Сначала с известной квотой и минимальным used; при равенстве — известная квота важнее.
  candidates.sort((a, b) => {
    if (a.usedKnown !== b.usedKnown) return a.usedKnown ? -1 : 1;
    if (a.used !== b.used) return a.used - b.used;
    return a.name.localeCompare(b.name);
  });
  const best = candidates[0];
  if (opts.requireFree && best.used >= 99) {
    throw new Error(`все authorized аккаунты на ~100% (лучший: ${best.name} · ${Math.round(best.used)}%)`);
  }
  return best;
}

function getGrokTerminalStatus(name) {
  const safe = grokSanitizeName(name);
  if (!safe) return { status: 'error', message: 'invalid name' };

  // Map dashboard name (e.g. "1") to GROK_HOME profile dir .grok-1
  const home = grokProfileHome(safe);
  const authFile = path.join(home, 'auth.json');
  const active = getDefaultGrokActive();

  if (!fs.existsSync(authFile)) {
    return {
      status: 'not_authorized',
      message: 'Not authorized',
      home: home,
      hasAuth: false,
      isActive: false,
    };
  }

  try {
    const stat = fs.statSync(authFile);
    if (stat.size < 20) {
      return { status: 'not_authorized', message: 'Empty auth', home, hasAuth: false, isActive: false };
    }
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    const identity = parseGrokAuthIdentity(auth);
    const hasToken = !!identity;
    // Активный = pointer дашборда (helper/copy) или совпадение identity с ~/.grok/auth.json.
    let isActive = false;
    if (active.name === safe) {
      isActive = true;
    } else if (hasToken && active.hasAuth) {
      if (active.userId && identity.userId && active.userId === identity.userId) isActive = true;
      else if (active.email && identity.email && active.email === identity.email) isActive = true;
    }
    return {
      status: hasToken ? 'authorized' : 'not_authorized',
      message: hasToken ? 'Authorized' : 'No token',
      home: home,
      hasAuth: hasToken,
      lastModified: stat.mtime.toISOString(),
      email: identity?.email || null,
      userId: identity?.userId || null,
      isActive,
    };
  } catch (e) {
    return { status: 'error', message: e.message, home, isActive: false };
  }
}

async function handleGrokActivate(req, res) {
  try {
    const body = await readJsonBody(req);
    let name = body?.name;
    let picked = null;
    // mode: 'copy' (default) | 'helper'
    const mode = body?.mode === 'helper' ? 'helper' : 'copy';
    if (body?.best || name === 'best' || name === '__best__') {
      picked = pickBestGrokSession({ requireFree: !!body?.requireFree });
      name = picked.name;
    }
    if (!name) return jsonRes(res, 400, { error: 'name required (или best:true)' });
    const result = activateGrokSession(name, { mode });
    const active = getDefaultGrokActive();
    jsonRes(res, 200, { ...result, picked, active });
  } catch (e) {
    jsonRes(res, 400, { error: e.message });
  }
}

async function handleGrokActive(req, res) {
  try {
    jsonRes(res, 200, { active: getDefaultGrokActive() });
  } catch (e) {
    jsonRes(res, 500, { error: e.message });
  }
}

function grokFindChrome() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// POST /__switch/api/grok/launch-chrome {port, profile}
// Spawn the grok session Chrome from the NODE side. A chrome.exe spawned from a
// python child on this machine dies silently (CDP never binds), so launcher.py
// delegates the actual spawn here (proven: node spawn brings Chrome up fine).
async function handleGrokLaunchChrome(req, res) {
  try {
    const body = await readJsonBody(req);
    const port = parseInt(body?.port, 10);
    const profile = body?.profile;
    if (!port || !profile) return jsonRes(res, 400, { ok: false, error: 'port and profile required' });
    if (!fs.existsSync(profile)) return jsonRes(res, 400, { ok: false, error: 'profile dir not found: ' + profile });
    const chromePath = grokFindChrome();
    if (!chromePath) return jsonRes(res, 500, { ok: false, error: 'Chrome not found' });
    const { spawn } = require('child_process');
    const child = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    logLine(`grok chrome spawn: :${port} profile=${profile} pid=${child.pid}`);
    child.on('exit', (code, sig) => logLine(`grok chrome exit: pid=${child.pid} code=${code} sig=${sig}`));
    child.on('error', (err) => logLine(`grok chrome spawn error: ${err.message}`));
    // Node-side CDP probe so the launcher knows immediately whether the browser came up.
    const started = Date.now();
    let cdp = false;
    while (Date.now() - started < 5000) {
      if (child.exitCode !== null) break;
      try {
        const probe = await new Promise((resolve) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 600 }, (res) => {
            res.resume(); res.on('end', resolve);
          });
          req.on('error', () => resolve());
          req.on('timeout', () => { req.destroy(); resolve(); });
        });
        if (probe) { cdp = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 350));
    }
    logLine(`grok chrome cdp probe: :${port} cdp=${cdp} elapsed=${Date.now() - started}ms exitCode=${child.exitCode}`);
    jsonRes(res, 200, { ok: true, pid: child.pid, cdp, profile });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: e.message });
  }
}

const GROK_LAUNCH_SAMESITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax', null: 'Lax' };

function grokHttpGet(port, pathname, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function grokWsCall(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  const result = await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', onMsg); resolve(m); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('ws timeout: ' + method)); }, 8000);
  });
  return result;
}

// POST /__switch/api/grok/launch {name} | {cookies:[...]}
// Полный запуск grok-сессии в node: спавн изолированного Chrome (node->chrome
// живёт, python->chrome умирает на этой машине), CDP, инжект кук (из файла
// grokCookiesDir/<name>.json либо из body.cookies), переход на grok.com.
// Дашборд зовёт его вместо launcher.py (python).
async function handleGrokLaunch(req, res) {
  try {
    const body = await readJsonBody(req);
    let cookies = body?.cookies;
    let label = body?.name || 'pasted';
    if (!Array.isArray(cookies)) {
      const safe = grokSanitizeName(label);
      const cookieFile = path.join(grokCookiesDir(), `${safe}.json`);
      if (!fs.existsSync(cookieFile)) return jsonRes(res, 404, { ok: false, error: `cookie file not found: ${safe}.json` });
      try {
        cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
      } catch {
        return jsonRes(res, 400, { ok: false, error: `cookie file unreadable: ${safe}.json` });
      }
      label = safe;
    }
    if (!Array.isArray(cookies) || !cookies.length) return jsonRes(res, 400, { ok: false, error: 'no cookies provided' });

    const chromePath = grokFindChrome();
    if (!chromePath) return jsonRes(res, 500, { ok: false, error: 'Chrome not found' });
    const port = 9300 + Math.floor(Math.random() * 100);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-session-'));

    const child = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    logLine(`grok launch: spawn :${port} profile=${profile} pid=${child.pid}`);

    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 400));
      try {
        const raw = await grokHttpGet(port, '/json', 1500);
        const pages = JSON.parse(raw);
        const page = pages.find(p => p.type === 'page' && (p.url || '').startsWith('about:'))
          || pages.find(p => p.type === 'page');
        if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
      } catch {}
    }
    if (!wsUrl) throw new Error(`Chrome CDP not available on port ${port} (profile=${profile})`);

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws open failed')); });

    await grokWsCall(ws, 'Network.enable');
    let okCount = 0;
    for (const c of cookies) {
      const params = {
        name: c.name, value: c.value || '',
        domain: c.domain || '.grok.com', path: c.path || '/',
        secure: !!c.secure, httpOnly: !!c.httpOnly,
      };
      if (c.expirationDate) params.expires = c.expirationDate;
      const ss = GROK_LAUNCH_SAMESITE[c.sameSite]
        || (c.sameSite === 'no_restriction' || c.sameSite === 'None' ? 'None' : 'Lax');
      if (ss) params.sameSite = ss;
      const r = await grokWsCall(ws, 'Network.setCookie', params);
      if (r.result && r.result.success) okCount++;
    }
    await grokWsCall(ws, 'Page.navigate', { url: 'https://grok.com/' });
    logLine(`grok launch: ${label} ok cookies=${okCount}/${cookies.length} port=${port}`);
    jsonRes(res, 200, { ok: true, port, profile, cookies: okCount, message: `Chrome opened: ${label} (${okCount}/${cookies.length} cookies)` });
  } catch (e) {
    logLine(`grok launch error: ${e.message}`);
    jsonRes(res, 500, { ok: false, error: e.message });
  }
}

async function handleGrokTerminalStatus(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const name = url.searchParams.get('name');
  const status = getGrokTerminalStatus(name);
  jsonRes(res, 200, { name, ...status });
}

async function handleGrokLaunchTerminal(req, res) {
    try {
        const { name } = await readJsonBody(req);
        const safe = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
        if (!safe) return jsonRes(res, 400, { error: 'name required' });

        const home = path.join(os.homedir(), `.grok-${safe}`);
        // Direct command with proper double quotes so $env expands.
        // User can cd to project dir first if needed.
        const psCommand = `$env:GROK_HOME = '${home.replace(/\\/g, '\\\\')}'; & "$env:USERPROFILE\\.grok\\bin\\grok.exe"`;

        const { spawn } = require('child_process');
        const child = spawn('cmd', ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', psCommand], {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd(),
        });
        child.unref();

        logLine(`grok terminal: launched for ${safe} (pid ${child.pid})`);
        jsonRes(res, 200, { ok: true, pid: child.pid, name: safe });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleGrokStartAuth(req, res) {
    try {
        const { name } = await readJsonBody(req);
        const safe = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
        if (!safe) return jsonRes(res, 400, { error: 'name required' });

        const home = path.join(os.homedir(), `.grok-${safe}`);
        // Direct command. Double quotes around the $env path so PowerShell expands it.
        // The terminal will show the device code right away.
        const psCommand = `$env:GROK_HOME = '${home.replace(/\\/g, '\\\\')}'; & "$env:USERPROFILE\\.grok\\bin\\grok.exe" login --device-auth`;

        const { spawn } = require('child_process');
        // Open a new PowerShell window and run the device login command.
        const child = spawn('cmd', ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', psCommand], {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd(),
        });
        child.unref();

        logLine(`grok start-auth: opened terminal for ${safe} with login --device-auth (pid ${child.pid})`);
        jsonRes(res, 200, { ok: true, pid: child.pid, name: safe, message: 'Terminal opened with login --device-auth. Copy the user_code from the terminal and use "Approve code" in the dashboard for this cookie session.' });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

function handleNotionCards(res) {
    try {
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try { jsonRes(res, 200, dashApi.getNotionCards()); }
        finally { process.chdir(cwd); }
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleNotionCardSelect(req, res) {
    try {
        const { index } = await readJsonBody(req);
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const result = dashApi.setNotionCardIndex(index);
            logLine(`notion card -> index=${index}`);
            jsonRes(res, 200, result);
        } finally { process.chdir(cwd); }
    } catch (e) { jsonRes(res, 400, { error: e.message }); }
}

// ---- /__switch/api/tg/* — пул Telegram-аккаунтов для freemodel-автореги -----
//
// Хранилище: freemodel/tg_pool.json. UI вкладка "Telegram" в proxy-dashboard.html.

const tgPool = require('../freemodel/lib/tg-pool');
const tgSessionParser = require('../freemodel/lib/tg-session-parser');
const fmTgBind = require('../freemodel/lib/fm-tg-bind');
const tgHealth = require('../freemodel/lib/tg-health');

// На каких сервисах зареган каждый ТГ — собираем из существующих источников
// истины (без отдельного кэша). Возвращает Map<phone, {freemodel,conduit}>.
//   freemodel: usedBy в пуле похож на email, ИЛИ phone есть в freemodel-мете как tgPhone.
//   conduit:   phone в conduit/.tg_used.json.
function tgServicesMap(poolArr) {
    const map = {};
    const set = (phone, svc) => { (map[phone] = map[phone] || {})[svc] = true; };

    // FreeModel — поле usedBy в пуле ставит ТОЛЬКО FreeModel-логика (email,
    // путь freemodel\accounts\…, или "bound-elsewhere"=уже привязан к другому
    // FM-аккаунту). Любой непустой usedBy ⇒ ТГ зареган/использован на FreeModel.
    for (const e of poolArr) {
        if (e.usedBy && String(e.usedBy).trim()) set(String(e.phone), 'freemodel');
    }
    // FreeModel — по мете (tgPhone — реальный номер, не "вручную"/"connected")
    try {
        const meta = dashApi.loadFreemodelMeta();
        for (const v of Object.values(meta)) {
            const ph = String(v.tgPhone || '');
            if (/^\+?\d{6,}$/.test(ph)) set(ph.replace(/^\+/, ''), 'freemodel');
        }
    } catch {}
    // Conduit — по .tg_used.json
    try {
        const used = require('../conduit/conduit_autoreger').loadTgUsed();
        for (const ph of used) set(String(ph), 'conduit');
    } catch {}
    // AnyModel — по своему .tg_used.json
    try {
        const used = require('../anymodel/lib/tg-usage').loadUsed();
        for (const ph of used) set(String(ph), 'anymodel');
    } catch {}
    // Svrtr — по своему .tg_used.json
    try {
        const svrtrUsedFile = path.join(__dirname, '..', 'svrtr', '.tg_used.json');
        if (fs.existsSync(svrtrUsedFile)) {
            const used = JSON.parse(fs.readFileSync(svrtrUsedFile, 'utf8'));
            for (const ph of used) set(String(ph), 'svrtr');
        }
    } catch {}
    return map;
}

// Годность ТГ для каждого сервиса — правила СКОПИРОВАНЫ ИЗ САМИХ ПИКЕРОВ, иначе
// цифры во вкладке разойдутся с тем, что реально возьмёт автореж:
//   fm  — tgPool.reserve()            : status==='free' && !dead
//   cdt — conduit_autoreger.pickTg()  : status!=='banned' && !в conduit/.tg_used
//   sr  — svrtr_autoreger.pickTg()    : status!=='banned' && !в svrtr/.tg_used
//   am  — anymodel/lib/tg-usage.pick(): status!=='banned' && !dead && !в anymodel/.tg_used
// `svc` — запись из tgServicesMap (её conduit/anymodel/svrtr читаются ровно из тех
// же .tg_used.json, что и пикеры), `dead` — из health-кэша. Файлы уже прочитаны
// вызывающим один раз на запрос, здесь только арифметика.
//
// NB: cdt и sr намеренно НЕ отсеивают dead — их пикеры этого не делают. Показываем
// как есть (годен + бейдж 🔴 dead), а не как хотелось бы.
function tgFreeFor(entry, svc, dead) {
    const notBanned = entry.status !== 'banned';
    return {
        fm:  entry.status === 'free' && !dead,
        cdt: notBanned && !svc.conduit,
        sr:  notBanned && !svc.svrtr,
        am:  notBanned && !dead && !svc.anymodel,
    };
}

function handleTgList(res) {
    try {
        const arr = tgPool.list();
        const health = tgHealth.loadCache();
        const svc = tgServicesMap(arr);
        const freeForTotals = { fm: 0, cdt: 0, sr: 0, am: 0 };
        const healthTotals = { alive: 0, dead: 0, error: 0, unchecked: 0 };
        // Маскируем auth_key для UI — полный ключ из дашборда никогда не отдаём.
        const safe = arr.map(e => {
            const mySvc = svc[String(e.phone)] || {};
            const h = health[e.phone] || null;
            const freeFor = tgFreeFor(e, mySvc, h && h.status === 'dead');
            for (const k of Object.keys(freeForTotals)) if (freeFor[k]) freeForTotals[k]++;
            healthTotals[h ? (h.status in healthTotals ? h.status : 'error') : 'unchecked']++;
            return {
                phone: e.phone,
                dc_id: e.dc_id,
                user_id: e.user_id,
                auth_key_mask: tgPool.maskAuthKey(e.auth_key_hex),
                status: e.status,
                source: e.source || (e.isPlaceholderPhone ? 'hex' : 'session'),
                addedAt: e.addedAt,
                usedBy: e.usedBy || null,
                usedAt: e.usedAt || null,
                banReason: e.banReason || null,
                isPlaceholderPhone: !!e.isPlaceholderPhone,
                health: h,
                services: mySvc,   // { freemodel?:true, conduit?:true } — им живёт renderTgPool в 4 вкладках
                // Короткие ключи в пару к freeFor — для вкладки-менеджера.
                usedOn: { fm: !!mySvc.freemodel, cdt: !!mySvc.conduit, sr: !!mySvc.svrtr, am: !!mySvc.anymodel },
                freeFor,
            };
        });
        jsonRes(res, 200, {
            entries: safe,
            stats: { ...tgPool.stats(), freeFor: freeForTotals, health: healthTotals },
        });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// Фоновый прогон health-чека. Состояние живёт в памяти процесса: рестарт прокси его
// теряет, но health-кэш пишется инкрементально после каждого аккаунта — проверенное
// не пропадает. Зачем фон: прогон последовательный (одно подключение с твоего IP за
// раз, чтобы не выглядеть массовым логином), ~2-6 c на аккаунт → сотни аккаунтов это
// десятки минут в висящем HTTP-запросе без обратной связи.
let tgHealthJob = {
    running: false, scope: null, total: 0, done: 0,
    alive: 0, dead: 0, error: 0,
    currentPhone: null, startedAt: null, finishedAt: null,
};

// scope 'unchecked' = не-banned, которых ещё нет в health-кэше (дешёвый догон);
// 'all' = все не-banned, включая уже известных dead (полная перепроверка).
function tgHealthTargets(scope) {
    const cache = tgHealth.loadCache();
    return tgPool.list().filter(e =>
        e.status !== 'banned' && (scope === 'all' || !(String(e.phone) in cache))
    );
}

async function tgHealthRun(scope) {
    const targets = tgHealthTargets(scope);
    tgHealthJob = {
        running: true, scope, total: targets.length, done: 0,
        alive: 0, dead: 0, error: 0,
        currentPhone: null, startedAt: new Date().toISOString(), finishedAt: null,
    };
    logLine(`tg health: старт (${scope}) — ${targets.length} шт., последовательно`);
    try {
        for (const e of targets) {
            tgHealthJob.currentPhone = String(e.phone);
            let r;
            // checkOne сам не бросает, но страховка обязательна: этот промис никто
            // не ждёт — unhandledRejection уронил бы весь прокси.
            try { r = await tgHealth.checkOne(e, msg => logLine(msg)); }
            catch (err) {
                r = { status: 'error', error: String((err && err.message) || err).slice(0, 140), checkedAt: new Date().toISOString() };
            }
            // Кэш пишем сами — checkOne его не трогает (это делают checkAll/checkPhone).
            // Инкрементально: обрыв на середине не теряет уже проверенное.
            try {
                const cache = tgHealth.loadCache();
                cache[e.phone] = r;
                tgHealth.saveCache(cache);
            } catch {}
            tgHealthJob.done++;
            if (r.status === 'alive') tgHealthJob.alive++;
            else if (r.status === 'dead') tgHealthJob.dead++;
            else tgHealthJob.error++;
        }
    } finally {
        tgHealthJob.running = false;
        tgHealthJob.currentPhone = null;
        tgHealthJob.finishedAt = new Date().toISOString();
        logLine(`tg health: готово (${scope}) alive=${tgHealthJob.alive} dead=${tgHealthJob.dead} error=${tgHealthJob.error}`);
    }
}

// Безбанный health-чек: connect+getMe по каждому не-banned, результат в кэш.
async function handleTgHealthCheck(req, res) {
    try {
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        if (body && body.phone) {
            // Тот же ключ в двух коннектах = AUTH_KEY_DUPLICATED, и фон бы записал
            // в кэш свой результат поверх. Пока идёт прогон — одиночный чек не пускаем.
            if (tgHealthJob.running) {
                return jsonRes(res, 409, { error: `идёт массовый чек (${tgHealthJob.done}/${tgHealthJob.total})`, job: tgHealthJob });
            }
            const r = await tgHealth.checkPhone(body.phone, msg => logLine(msg));
            logLine(`tg health: ${body.phone} → ${r.status}`);
            return jsonRes(res, 200, { ok: true, phone: body.phone, ...r });
        }
        // Со scope — фоновый прогон, прогресс через GET /tg/health-progress.
        if (body && body.scope) {
            const scope = body.scope === 'all' ? 'all' : 'unchecked';
            if (tgHealthJob.running) {
                return jsonRes(res, 409, { error: `уже идёт (${tgHealthJob.done}/${tgHealthJob.total})`, job: tgHealthJob });
            }
            const total = tgHealthTargets(scope).length;
            if (!total) return jsonRes(res, 200, { ok: true, started: false, scope, total: 0 });
            tgHealthRun(scope).catch(e => logLine(`tg health: прогон упал: ${e.message}`));
            return jsonRes(res, 200, { ok: true, started: true, scope, total });
        }
        // Без scope — старый блокирующий путь: им живут блоки пула в 4 вкладках.
        if (tgHealthJob.running) {
            return jsonRes(res, 409, { error: `уже идёт (${tgHealthJob.done}/${tgHealthJob.total})`, job: tgHealthJob });
        }
        logLine('tg health: проверка всех не-banned (connect+getMe)…');
        const summary = await tgHealth.checkAll(msg => logLine(msg));
        logLine(`tg health: alive=${summary.alive} dead=${summary.dead} error=${summary.error}`);
        jsonRes(res, 200, { ok: true, ...summary });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// Прогресс фонового прогона + сколько осталось непроверенных (для подписей кнопок).
function handleTgHealthProgress(res) {
    try {
        jsonRes(res, 200, {
            ok: true,
            job: tgHealthJob,
            pending: { unchecked: tgHealthTargets('unchecked').length, all: tgHealthTargets('all').length },
        });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

async function handleTgAddHex(req, res) {
    try {
        const body = await readJsonBody(req);
        const { phone, dc_id, user_id, auth_key_hex } = body || {};
        const entry = tgPool.addHex({ phone, dc_id, user_id, auth_key_hex });
        logLine(`tg pool: + ${entry.phone} dc=${entry.dc_id}`);
        jsonRes(res, 200, { ok: true, phone: entry.phone });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Bulk import: текст со списком в свободном формате (phone|hex:dc / hex:dc / ...).
async function handleTgAddBulk(req, res) {
    try {
        const { text } = await readJsonBody(req);
        if (!text || typeof text !== 'string') return jsonRes(res, 400, { error: 'нет text' });
        const parsed = tgPool.parseBulk(text);
        const result = tgPool.addBulk(parsed.entries);
        logLine(`tg pool: bulk +${result.added.length} parseErr=${parsed.errors.length} dupes=${parsed.duplicates.length}`);
        jsonRes(res, 200, {
            ok: true,
            added: result.added,
            errors: [...parsed.errors, ...result.errors],
            duplicates: parsed.duplicates,
        });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Принимает .session-файл как base64 в JSON-теле (UI читает FileReader → base64).
async function handleTgAddSession(req, res) {
    try {
        const body = await readJsonBody(req);
        const { phone, base64 } = body || {};
        if (!phone) return jsonRes(res, 400, { error: 'phone обязателен' });
        if (!base64) return jsonRes(res, 400, { error: 'нет файла (base64)' });

        const buf = Buffer.from(base64, 'base64');
        const parsed = tgSessionParser.parseSessionBuffer(buf, phone);

        if (!parsed.user_id) {
            // user_id в .session может отсутствовать — это не критично для логина.
            // Но pool хочет user_id строго. Кладём заглушку, если совсем пусто.
            parsed.user_id = body.user_id || '0';
        }

        const entry = tgPool.addHex({
            phone,
            dc_id: parsed.dc_id,
            user_id: parsed.user_id,
            auth_key_hex: parsed.auth_key_hex,
            source: 'session',
        });
        logLine(`tg pool: + ${entry.phone} dc=${entry.dc_id} (.session)`);
        jsonRes(res, 200, { ok: true, phone: entry.phone, dc_id: entry.dc_id, user_id: entry.user_id });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleTgDelete(req, res) {
    try {
        const { phone } = await readJsonBody(req);
        if (!phone) return jsonRes(res, 400, { error: 'phone обязателен' });
        const ok = tgPool.remove(phone);
        if (!ok) return jsonRes(res, 404, { error: 'не найден' });
        // Чистим health-запись, иначе перезалив под тем же phone покажет старый dead.
        try { tgHealth.forgetPhone(phone); } catch {}
        logLine(`tg pool: − ${phone}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleTgMarkFree(req, res) {
    try {
        const { phone } = await readJsonBody(req);
        if (!phone) return jsonRes(res, 400, { error: 'phone обязателен' });
        const e = tgPool.markFree(phone);
        if (!e) return jsonRes(res, 404, { error: 'не найден' });
        logLine(`tg pool: ${phone} → free`);
        jsonRes(res, 200, { ok: true });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleTgRename(req, res) {
    try {
        const { phone, newPhone } = await readJsonBody(req);
        if (!phone || !newPhone) return jsonRes(res, 400, { error: 'phone и newPhone обязательны' });
        const e = tgPool.rename(phone, newPhone);
        logLine(`tg pool: rename ${phone} → ${e.phone}`);
        jsonRes(res, 200, { ok: true, phone: e.phone });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Открыть TG-сессию в отдельном портативном Telegram Desktop.
// auth_key_hex+dc_id -> tdata через tools/tg-open.py (venv py3.12 + opentele),
// затем launch Telegram.exe -workdir. Первый раз идёт в сеть (~5-10с),
// дальше tdata переиспользуется. AyuGram пользователя не трогаем.
const { spawn } = require('child_process');
// Путь до интерпретатора venv платформозависим: Scripts/python.exe на Windows,
// bin/python на macOS. Резолвер спрашиваем НА КАЖДЫЙ запрос, а не один раз при
// загрузке модуля: venv мог появиться после старта дашборда (UPDATE.bat), и
// закешированный «не найден» держался бы до рестарта прокси.
//
// require в try: если обновление приехало не целиком и файла нет, дашборд НЕ
// должен падать на загрузке целиком из-за одной кнопки ✈ — откатываемся на
// виндовый layout, ломается только эта кнопка.
let tgVenvPython;
try {
    tgVenvPython = require('../tools/tg-venv-python.js');
} catch (e) {
    tgVenvPython = () => path.join(__dirname, '..', 'tools', 'tg-venv', 'Scripts', 'python.exe');
}
const TG_OPEN_PY = path.join(__dirname, '..', 'tools', 'tg-open.py');

async function handleTgOpen(req, res) {
    try {
        const { phone } = await readJsonBody(req);
        if (!phone) return jsonRes(res, 400, { error: 'phone обязателен' });
        const TG_VENV_PY = tgVenvPython();
        if (!fs.existsSync(TG_VENV_PY)) {
            return jsonRes(res, 500, { error: `нет ${TG_VENV_PY} — venv не создан. Запусти UPDATE.bat в папке репо (git pull + установка), потом обнови страницу` });
        }
        logLine(`tg open: ${phone} → конвертация + запуск`);
        const child = spawn(TG_VENV_PY, [TG_OPEN_PY, String(phone)], {
            cwd: path.join(__dirname, '..'),
            windowsHide: true,
        });
        let err = '';
        child.stderr.on('data', d => { err += d.toString(); });
        const code = await new Promise((resolve) => {
            const t = setTimeout(() => { try { child.kill(); } catch {} resolve(-1); }, 90_000);
            child.on('close', c => { clearTimeout(t); resolve(c); });
            child.on('error', e => { clearTimeout(t); err += e.message; resolve(-1); });
        });
        if (code !== 0) {
            const last = err.trim().split('\n').pop() || 'неизвестная ошибка';
            logLine(`tg open: ${phone} FAIL (${code}): ${last}`);
            return jsonRes(res, 500, { error: last });
        }
        logLine(`tg open: ${phone} → запущен`);
        jsonRes(res, 200, { ok: true });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// ---- /__switch/api/freemodel/ban: пометить freemodel-аккаунт как banned 💀 ----
async function handleFreemodelBan(req, res) {
    try {
        const { name, banned } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const m = dashApi.setFreemodelBanned(name, !!banned);
        logLine(`freemodel ban: ${name} → ${banned ? '💀' : 'unban'}`);
        if (banned) fmAutoKick(name, 'ручной бан');
        jsonRes(res, 200, { ok: true, meta: m });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Ручное переключение TG-привязки. Принимает { name, tgPhone } —
// tgPhone=null/'' = отвязать, явный номер = привязать.
async function handleFreemodelSetTg(req, res) {
    try {
        const { name, tgPhone } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const cleanPhone = tgPhone ? String(tgPhone).replace(/^\+/, '').replace(/\s+/g, '') : null;
        if (cleanPhone && !/^(?:\d{6,18}|tg_[0-9a-f]+|manual)$/.test(cleanPhone)) {
            return jsonRes(res, 400, { error: 'bad phone' });
        }
        const m = dashApi.setFreemodelTgPhone(name, cleanPhone);
        logLine(`freemodel tg: ${name} → ${cleanPhone || 'unlinked'}`);
        jsonRes(res, 200, { ok: true, meta: m });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

// Автоматическая привязка Telegram из пула к FreeModel-сессии.
// Берёт свободный TG-аккаунт (или указанный phone), шлёт /start <token> боту,
// ждёт verified и создаёт API-ключ.
async function handleFreemodelBindTelegram(req, res) {
    try {
        const { name, phone, headless } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        let result;
        try {
            const sessions = freemodelManager.getFreemodelSessions();
            const session = sessions.find(s => s.name === name);
            if (!session) {
                process.chdir(cwd);
                return jsonRes(res, 404, { error: 'session not found' });
            }
            logLine(`freemodel bind-telegram: ${name} ${phone ? 'phone=' + phone : 'auto'}`);
            result = await fmTgBind.bindTelegram(session.path, phone, {
                headless: headless !== false,
                log: (msg) => logLine(msg),
            });
        } finally {
            process.chdir(cwd);
        }
        if (!result.ok) {
            logLine(`freemodel bind-telegram failed: ${result.error}`);
            return jsonRes(res, 500, { ok: false, error: result.error, tgPhone: result.tgPhone });
        }
        logLine(`freemodel bind-telegram ok: ${name} tg=${result.tgPhone} key=${result.apiKey ? '***' + result.apiKey.slice(-6) : 'none'}`);
        // Trial credit ($8) даётся именно за бинд TG, но freemodel рендерит его
        // лениво: скрапер, пришедший слишком рано, видит пустую страницу и
        // возвращает null — тогда refreshOneFreemodelQuota НИЧЕГО не пишет в кеш
        // и карточка остаётся пустой до ручного 🔄. Поэтому не одна попытка,
        // а несколько с нарастающей паузой, пока не увидим деньги.
        let quota = null;
        const cwd2 = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            for (const waitMs of [4000, 7000]) {
                await new Promise(r => setTimeout(r, waitMs));
                try {
                    quota = await dashApi.refreshOneFreemodelQuota(name);
                } catch (e) {
                    logLine(`freemodel bind-telegram quota refresh failed: ${e.message}`);
                    break;
                }
                if (quota && (quota.available || quota.trialCredit)) break;
                logLine(`freemodel bind-telegram quota: ${name} ещё пусто — повтор`);
            }
            logLine(`freemodel bind-telegram quota: ${name} avail=${quota?.available || '?'} trial=${quota?.trialCredit || '—'}`);
        } finally {
            process.chdir(cwd2);
        }
        jsonRes(res, 200, { ok: true, tgPhone: result.tgPhone, apiKey: result.apiKey, quota });
    } catch (e) {
        logLine(`freemodel bind-telegram error: ${e.message}`);
        jsonRes(res, 500, { ok: false, error: e.message });
    }
}

// Ручное добавление FreeModel-аккаунта: имя + API-ключ, без браузерной сессии.
// Создаёт v3-папку freemodel/accounts/manual_<ts>_ok_<имя> со stub session.json
// (пустой storageState — квоты Playwright не спарсит, ключ работает как обычно)
// и сразу помечает TG как привязанный вручную (tgPhone='manual').
async function handleFreemodelAddManual(req, res) {
    try {
        const { name, apiKey } = await readJsonBody(req);
        const label = String(name || '').trim();
        const key = String(apiKey || '').trim();
        if (!label) return jsonRes(res, 400, { error: 'имя обязательно' });
        if (!/^(?:fe[_-]|sk-)[A-Za-z0-9_-]{20,}$/.test(key)) {
            return jsonRes(res, 400, { error: 'формат ключа: fe_... или sk-...' });
        }
        const slug = label.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 40) || 'manual';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dirName = `manual_${ts}_ok_${slug}`;
        const dir = path.join(__dirname, '..', 'freemodel', 'accounts', dirName);
        if (fs.existsSync(dir)) return jsonRes(res, 409, { error: 'уже существует: ' + dirName });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'session.json'),
            JSON.stringify({ cookies: [], origins: [] }, null, 2), 'utf-8');
        fs.writeFileSync(path.join(dir, 'account_info.txt'), [
            `Email: ${label}`,
            `API Key: ${key}`,
            'Status: ✅ OK (manual)',
            'Backend: manual',
            `Created: ${new Date().toISOString()}`,
            '',
        ].join('\n'), 'utf-8');
        dashApi.setFreemodelApiKey(dirName, key);
        dashApi.setFreemodelTgPhone(dirName, 'manual');
        logLine(`freemodel add-manual: ${label} → ${dirName} (key ***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, name: dirName });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// Ручное проставление API-ключа (например, юзер скопировал руками).
async function handleFreemodelSetKey(req, res) {
    try {
        const { name, apiKey } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const key = apiKey ? String(apiKey).trim() : null;
        if (key && !/^(?:fe[_-]|sk-)[A-Za-z0-9_-]{20,}$/.test(key)) {
            return jsonRes(res, 400, { error: 'формат ключа: fe_... или sk-...' });
        }
        const m = dashApi.setFreemodelApiKey(name, key);
        logLine(`freemodel key: ${name} → ${key ? '***' + key.slice(-6) : 'cleared'}`);
        jsonRes(res, 200, { ok: true, meta: m });
    } catch (e) {
        jsonRes(res, 400, { error: e.message });
    }
}

async function handleFreemodelActivate(req, res) {
    try {
        const { name, mode } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name required' });
        const helperMode = mode === 'helper';
        const keyFile = path.join(os.homedir(), '.claude', 'fm-active-key.txt');
        const meta = dashApi.loadFreemodelMeta();
        let apiKey = meta[name]?.apiKey;
        if (!apiKey) {
            const fm = require('../internal/freemodel-manager');
            const cwd = process.cwd();
            process.chdir(path.join(__dirname, '..'));
            try {
                const s = fm.getFreemodelSessions().find(x => x.name === name);
                if (s) {
                    const infoFile = path.join(s.path, 'account_info.txt');
                    if (fs.existsSync(infoFile)) {
                        const m = fs.readFileSync(infoFile, 'utf-8').match(/^API Key:\s*((?:fe[_-]|sk-)[A-Za-z0-9_-]{20,})/m);
                        if (m) apiKey = m[1];
                    }
                }
            } finally { process.chdir(cwd); }
        }
        if (!apiKey) return jsonRes(res, 400, { error: 'no API key found' });
        fs.writeFileSync(keyFile, apiKey, { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
            const raw = fs.readFileSync(settingsFile, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const bakPath = settingsFile + '.bak-fm-' + stamp;
            fs.copyFileSync(settingsFile, bakPath);
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = 'https://cc.freemodel.dev';
            // Чужая залипшая model (ComboWombo от OmniRoute) на FreeModel не работает.
            // Раньше её просто удаляли — и CC брал свой встроенный дефолт
            // (claude-opus-5 БЕЗ суффикса) → окно 200k вместо 1M, ранний
            // автокомпакт и «200k» в статус-баре. Поэтому не удаляем, а ставим
            // явный дефолт с [1m]. Свою claude-* оставляем, дотягивая суффикс.
            const fmModel = String(settings.model || '');
            if (!/^claude-(opus|sonnet)-/.test(fmModel)) settings.model = 'claude-opus-5[1m]';
            else if (!fmModel.includes('[')) settings.model = fmModel + '[1m]';
            clearOtEnv(settings);    // убрать ourtoken AUTH_TOKEN/маппинги, иначе перебьют freemodel
            if (helperMode) {
                settings.apiKeyHelper = keyHelperCmd('fm-active-key.txt');
                settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
                delete settings.env.ANTHROPIC_API_KEY;   // helper drives auth; direct key would shadow it
            } else {
                settings.apiKeyHelper = '';
                settings.env.ANTHROPIC_API_KEY = apiKey;
            }
            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
            settingsOk = true;
            logLine(`fm activate: wrote ${helperMode ? 'apiKeyHelper' : 'direct key'} to settings.json`);
        } catch (e) {
            logLine(`fm activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`fm activate: ${name} → ${apiKey.substring(0, 8)}...`);
        jsonRes(res, 200, { ok: true, name, mode: helperMode ? 'helper' : 'direct', mask: apiKey.substring(0, 8) + '...' + apiKey.slice(-6), settingsUpdated: settingsOk });
    } catch (e) {
        jsonRes(res, 500, { error: e.message });
    }
}

// Доступные модели FreeModel с активным ключом (fm-active-key.txt). Кеш 5 мин.
// Два upstream под одним ключом: cc.freemodel.dev — claude-модели (anthropic),
// api.freemodel.dev — gpt-модели (openai, ходить через fm_openai прокси :20130).
// Опрашиваем оба параллельно, каждой модели ставим source: 'claude' | 'openai'.
const FM_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

async function fetchFmModelsFrom(host, apiKey, source) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const resp = await fetch(`https://${host}/v1/models`, {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!resp.ok) return { models: [], note: `${host}: HTTP ${resp.status}` };
        const data = await resp.json();
        return {
            models: (data.data || []).map(m => ({
                id: m.id,
                owned_by: m.owned_by,
                supported_endpoint_types: m.supported_endpoint_types || [],
                source,
            })),
            note: null,
        };
    } catch (e) {
        return { models: [], note: `${host}: ${e.message}` };
    } finally {
        clearTimeout(timeout);
    }
}

async function handleFreemodelModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const force = url.searchParams.get('force') === '1';

        if (FM_MODELS_CACHE.data && Date.now() - FM_MODELS_CACHE.ts < FM_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: FM_MODELS_CACHE.data, cached: true });
        }

        let apiKey = '';
        try { apiKey = fs.readFileSync(FM_ACTIVE_KEY_FILE, 'utf-8').trim(); } catch {}
        if (!apiKey) return jsonRes(res, 200, { ok: true, models: [], note: 'нет активного ключа (fm-active-key.txt)' });

        const [cc, oa] = await Promise.all([
            fetchFmModelsFrom('cc.freemodel.dev', apiKey, 'claude'),
            fetchFmModelsFrom('api.freemodel.dev', apiKey, 'openai'),
        ]);
        const models = [...cc.models, ...oa.models];
        const notes = [cc.note, oa.note].filter(Boolean).join('; ');

        if (!models.length) return jsonRes(res, 200, { ok: true, models: [], note: notes || 'пусто' });

        FM_MODELS_CACHE.data = models;
        FM_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false, note: notes || undefined });
    } catch (e) {
        if (FM_MODELS_CACHE.data) {
            jsonRes(res, 200, { ok: true, models: FM_MODELS_CACHE.data, cached: true, note: e.message });
        } else {
            jsonRes(res, 200, { ok: true, models: [], note: e.message });
        }
    }
}

async function handleFreemodelExtractKey(req, res) {
    try {
        const { name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const cwd = process.cwd();
        process.chdir(path.join(__dirname, '..'));
        try {
            const result = await dashApi.extractFreemodelApiKey(name);
            if (result.ok) {
                logLine(`freemodel extract-key: ${name} → ${result.apiKey ? result.apiKey.substring(0, 12) + '...' : 'none'} (${result.source})`);
            } else {
                logLine(`freemodel extract-key: ${name} → FAIL: ${result.error}`);
            }
            jsonRes(res, result.ok ? 200 : 400, result);
        } finally {
            process.chdir(cwd);
        }
    } catch (e) {
        jsonRes(res, 500, { ok: false, error: e.message });
    }
}

async function handleLaunch(req, res) {
    try {
        const body = await readJsonBody(req);
        const { kind, args } = body || {};
        if (!kind) return jsonRes(res, 400, { error: 'missing kind' });
        const result = dashApi.launchScript(kind, Array.isArray(args) ? args : []);
        logLine(`launch: ${kind}${result.args && result.args.length > 1 ? ' args=' + result.args.slice(1).join(' ') : ''}`);
        jsonRes(res, 200, result);
    } catch (e) { jsonRes(res, 400, { error: e.message }); }
}

async function handleLaunchBat(req, res) {
    try {
        const { bat } = await readJsonBody(req);
        if (!bat) return jsonRes(res, 400, { error: 'missing bat' });
        const result = dashApi.launchBatFile(bat);
        logLine(`launch bat: ${bat}`);
        jsonRes(res, 200, result);
    } catch (e) { jsonRes(res, 400, { error: e.message }); }
}

// ───── Aerolink (al) — ручной пул email+ключ, активация через API Helper ─────
const AL_SESSIONS_FILE = path.join(__dirname, 'al-sessions.json');
const AL_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'al-active-key.txt');
const AL_BASE_URL = 'https://capi.aerolink.lat';

function alLoad() {
    try {
        const raw = fs.readFileSync(AL_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function alSave(arr) {
    fs.writeFileSync(AL_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

// Пинг ключа: GET /v1/me → 401 = DEAD, иначе LIVE.
async function alProbe(apiKey) {
    try {
        const r = await fetch(`${AL_BASE_URL}/v1/me`, {
            method: 'GET',
            headers: { 'x-api-key': apiKey },
            signal: AbortSignal.timeout(12000),
        });
        return r.status === 401 ? 'dead' : 'live';
    } catch { return 'unknown'; }
}

async function handleAlSessions(req, res) {
    try {
        const probe = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('probe') === '1';
        const sessions = alLoad();
        if (probe) {
            await Promise.all(sessions.map(async s => { s.status = await alProbe(s.api_key); }));
        }
        jsonRes(res, 200, { sessions });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleAlAdd(req, res) {
    try {
        const { email, api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const mail = String(email || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'email и api_key обязательны' });
        const sessions = alLoad();
        if (sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        sessions.push({ email: mail, api_key: key, active: false });
        alSave(sessions);
        logLine(`aerolink add: ${mail} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleAlDelete(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const sessions = alLoad().filter(s => s.api_key !== key);
        alSave(sessions);
        logLine(`aerolink delete: ***${key.slice(-6)}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Клик по ключу → активный: пишем ключ в al-active-key.txt + apiKeyHelper в settings.json.
async function handleAlActivate(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        const sessions = alLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(AL_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        alSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-al');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = AL_BASE_URL + '/';
            settings.apiKeyHelper = keyHelperCmd('al-active-key.txt');
            delete settings.model;   // сбросить залипшую model (ComboWombo от OmniRoute)
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            delete settings.env.ANTHROPIC_API_KEY;   // helper рулит авторизацией
            clearOtEnv(settings);    // убрать ourtoken AUTH_TOKEN/маппинги
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`aerolink activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`aerolink activate: ${target.email} → ***${key.slice(-6)} (helper)`);
        await arProxySpawn();
                jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Evomap (ev) — ручной пул email+ключ (evomap.ai), активация через API Helper ─────
// По аналогии с Aerolink. Endpoint https://api.evomap.ai/v1 — OpenAI-совместимый, но
// Claude Code гоняем как обычно через ANTHROPIC_BASE_URL + apiKeyHelper. Ключи sk-evomap-*.
const EV_SESSIONS_FILE = path.join(__dirname, 'evomap-sessions.json');
const EV_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'ev-active-key.txt');
const EV_BASE_URL = 'https://api.evomap.ai/v1';

function evLoad() {
    try {
        const raw = fs.readFileSync(EV_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function evSave(arr) {
    fs.writeFileSync(EV_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

// Пинг ключа: GET /v1/models → 401 = DEAD, 200 = LIVE. /models публично доступен
// с валидным Bearer, отдаёт список моделей (evomap-claude-opus-4-7, evomap-gpt-5.5 …).
async function evProbe(apiKey) {
    try {
        const r = await fetch(`${EV_BASE_URL}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(12000),
        });
        return r.status === 401 ? 'dead' : (r.ok ? 'live' : 'unknown');
    } catch { return 'unknown'; }
}

async function handleEvSessions(req, res) {
    try {
        const probe = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('probe') === '1';
        const sessions = evLoad();
        if (probe) {
            await Promise.all(sessions.map(async s => { s.status = await evProbe(s.api_key); }));
        }
        jsonRes(res, 200, { sessions });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleEvAdd(req, res) {
    try {
        const { email, api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const mail = String(email || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'email и api_key обязательны' });
        const sessions = evLoad();
        if (sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        sessions.push({ email: mail, api_key: key, active: false });
        evSave(sessions);
        logLine(`evomap add: ${mail} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleEvDelete(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const sessions = evLoad().filter(s => s.api_key !== key);
        evSave(sessions);
        logLine(`evomap delete: ***${key.slice(-6)}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Клик по ключу → активный: пишем ключ в ev-active-key.txt + apiKeyHelper в settings.json.
async function handleEvActivate(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        const sessions = evLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(EV_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        evSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-ev');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = EV_BASE_URL;
            settings.apiKeyHelper = keyHelperCmd('ev-active-key.txt');
            delete settings.model;   // сбросить залипшую model (ComboWombo от OmniRoute)
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            delete settings.env.ANTHROPIC_API_KEY;   // helper рулит авторизацией
            clearOtEnv(settings);    // убрать ourtoken AUTH_TOKEN/маппинги
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`evomap activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`evomap activate: ${target.email} → ***${key.slice(-6)} (helper)`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Ourtoken (ot) — ручной пул email+ключ (ourtoken.ai), активация через API Helper ─────
// По аналогии с Aerolink/Evomap. Endpoint https://api.ourtoken.ai/v1 — OpenAI-совместимый.
// Ключи usTHAz8-* (формат — длинная base58-строка). Probe: GET /v1/models → 401 = DEAD.
const OT_SESSIONS_FILE = path.join(__dirname, 'ourtoken-sessions.json');
const OT_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'ot-active-key.txt');
const OT_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'ot-active-model.txt');
const OT_BASE_URL = 'https://api.ourtoken.ai/v1';

function otReadActiveModel() {
    try { return fs.readFileSync(OT_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// Ourtoken-специфика (AUTH_TOKEN + маппинги моделей) должна существовать ТОЛЬКО
// когда активен ourtoken. Любая другая активация обязана её вычистить —
// иначе ANTHROPIC_AUTH_TOKEN перебивает apiKeyHelper и ломает freemodel/aerolink/итд.
function clearOtEnv(settings) {
    if (!settings || !settings.env) return;
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
        'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME']) {
        delete settings.env[k];
    }
}
const OT_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

function otLoad() {
    try {
        const raw = fs.readFileSync(OT_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function otSave(arr) {
    fs.writeFileSync(OT_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

async function otProbe(apiKey) {
    try {
        const r = await fetch(`${OT_BASE_URL}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(12000),
        });
        return r.status === 401 ? 'dead' : (r.ok ? 'live' : 'unknown');
    } catch { return 'unknown'; }
}

async function handleOtSessions(req, res) {
    try {
        const probe = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('probe') === '1';
        const sessions = otLoad();
        if (probe) {
            // троттлинг: макс 3 одновременных, иначе ourtoken.ai дропает
            for (let i = 0; i < sessions.length; i += 3) {
                const batch = sessions.slice(i, i + 3);
                await Promise.all(batch.map(async s => { s.status = await otProbe(s.api_key); }));
            }
            otSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: otReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// GET /__switch/api/ot/ping?api_key=... → проверяет ОДИН ключ и сохраняет статус в sessions.json
async function handleOtPing(req, res) {
    try {
        const q = new URL(req.url, 'http://localhost');
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await otProbe(api_key);
        // сохраняем статус в sessions.json (кэш)
        const sessions = otLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; otSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сменить активную модель ourtoken (без смены ключа). Пишет ot-active-model.txt
// и settings.model, если ourtoken сейчас активный бэкенд.
async function handleOtSetModel(req, res) {
    try {
        const { model } = await readJsonBody(req);
        const m = String(model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        fs.writeFileSync(OT_ACTIVE_MODEL_FILE, m, { encoding: 'utf-8', flag: 'w' });

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            // применяем в settings только если ourtoken сейчас активный бэкенд
            const otUrl = (settings.env && settings.env.ANTHROPIC_BASE_URL || '').startsWith('https://api.ourtoken.ai');
            if (otUrl) {
                makeSettingsBackup('settings-ot-model');
                settings.env = settings.env || {};
                settings.env.ANTHROPIC_MODEL = m;
                settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = m;
                settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = m;
                settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = m;
                settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = m;
                settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m;
                settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = m;
                writeSettings(settings);
            }
            settingsOk = otUrl;
        } catch (e) {
            logLine(`ourtoken set-model: settings.json FAILED: ${e.message}`);
        }
        logLine(`ourtoken set-model: ${m} (settingsApplied=${settingsOk})`);
        jsonRes(res, 200, { ok: true, model: m, settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ot/to-omni { email, api_key } → добавляет ключ в OmniRoute
// Через OmniRoute HTTP Management API, без Docker/direct SQLite.
async function handleOtToOmni(req, res) {
    try {
        const { email, api_key } = await readJsonBody(req);
        const em = String(email || '').trim();
        const key = String(api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        if (!process.env.OMNIROUTE_API_KEY) {
            return jsonRes(res, 400, { error: 'OMNIROUTE_API_KEY manage не задан. Впиши его в Settings → OmniRoute или routing/.env' });
        }

        const script = path.join(__dirname, '..', 'ourtoken', 'add-to-omniroute.js');
        if (!fs.existsSync(script)) return jsonRes(res, 500, { error: 'add-to-omniroute.js не найден' });

        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [script, em || key.slice(-8), key], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        let out = '', err = '';
        child.stdout.on('data', d => out += d.toString());
        child.stderr.on('data', d => err += d.toString());

        const rc = await new Promise(r => child.on('close', r));
        if (rc !== 0) {
            logLine(`ot to-omni FAIL: ${err || out}`);
            return jsonRes(res, 500, { error: (err || out || 'exec failed').slice(0, 300) });
        }
        let data = {};
        try { data = JSON.parse(out.trim().split('\n').pop()); } catch {}
        logLine(`ot to-omni: ${em} → ${data.action || 'ok'}`);
        jsonRes(res, 200, { ok: true, action: data.action, id: data.id, email: em });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleOtAdd(req, res) {
    try {
        const { email, api_key, name } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const mail = String(email || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'email и api_key обязательны' });
        const sessions = otLoad();
        if (sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        sessions.push({ email: mail, name: String(name || '').trim() || mail.split('@')[0], api_key: key, active: false });
        otSave(sessions);
        logLine(`ourtoken add: ${mail} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleOtDelete(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const sessions = otLoad().filter(s => s.api_key !== key);
        otSave(sessions);
        logLine(`ourtoken delete: ***${key.slice(-6)}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleOtActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        const sessions = otLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        // Ourtoken импортирован в OmniRoute как provider — Claude Code ходит
        // через OmniRoute (localhost:20128), а не напрямую на api.ourtoken.ai.
        // Кликом здесь мы просто отмечаем выбранный ключ в пуле и переключаем
        // settings.json на OmniRoute (тот же конфиг, что и главный switcher).
        // Модель хранится для UI, но НЕ пишется в settings — иначе ComboWombo от
        // OmniRoute залипнет на claude-opus-* и уронит фолбэки.
        let model = body.model != null ? String(body.model).trim() : otReadActiveModel();
        if (model) fs.writeFileSync(OT_ACTIVE_MODEL_FILE, model, { encoding: 'utf-8', flag: 'w' });

        fs.writeFileSync(OT_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        otSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-ot');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = OM_BASE_URL;
            settings.env.ANTHROPIC_API_KEY = omniKey();
            delete settings.apiKeyHelper;
            delete settings.env.ANTHROPIC_AUTH_TOKEN;
            delete settings.env.ANTHROPIC_MODEL;
            delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
            delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
            delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
            delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
            delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
            delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.model;
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`ourtoken activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`ourtoken activate: ${target.email} → ***${key.slice(-6)} via OmniRoute${model ? ' (ui model=' + model + ')' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), model: model || null, settingsUpdated: settingsOk, via: 'omniroute' });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleOtModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (OT_MODELS_CACHE.data && Date.now() - OT_MODELS_CACHE.ts < OT_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: OT_MODELS_CACHE.data, cached: true });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(OT_BASE_URL + '/models', {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${api_key}` }
        });
        clearTimeout(timeout);

        if (!resp.ok) return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}` });

        const data = await resp.json();
        const models = (data.data || []).map(m => ({ id: m.id, owned_by: m.owned_by }));
        OT_MODELS_CACHE.data = models;
        OT_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (OT_MODELS_CACHE.data) {
            jsonRes(res, 200, { ok: true, models: OT_MODELS_CACHE.data, cached: true, note: e.message });
        } else {
            jsonRes(res, 200, { ok: true, models: [], note: e.message });
        }
    }
}

// ───── Custom (custom) — произвольные провайдеры (имя + baseUrl + пул ключей) ─────
// Универсальное хранилище: routing/custom-providers.json. Пинг/модели — GET {baseUrl}/models
// c Bearer-ключом (OpenAI-совместимый каталог). Активация — как Evomap/Ourtoken:
// apiKeyHelper читает ~/.claude/custom-active-key.txt на каждый запрос.
const CUSTOM_FILE = path.join(__dirname, 'custom-providers.json');
const CUSTOM_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'custom-active-key.txt');
const CUSTOM_ACTIVE_PROVIDER_FILE = path.join(os.homedir(), '.claude', 'custom-active-provider.json');
const CUSTOM_MODELS_CACHE = new Map(); // baseUrl -> { data, ts }
// Кеш моделей переживает рестарт дашборда: лежит на диске рядом с провайдерами.
// Свежий (<5 мин) отдаём из памяти; устаревший (<24 ч, напр. после рестарта)
// отдаём с пометкой stale, чтобы вкладка Custom не висла и не дёргала апстрим.
const CUSTOM_MODELS_CACHE_FILE = path.join(__dirname, 'custom-models-cache.json');
const CUSTOM_MODELS_FRESH_MS = 300_000;       // 5 мин — отдаём из памяти
const CUSTOM_MODELS_STALE_MS = 24 * 3600_000; // 24 ч — отдаём устаревшее без лишнего запроса
function customModelsCacheLoad() {
    try {
        const raw = fs.readFileSync(CUSTOM_MODELS_CACHE_FILE, 'utf8');
        const obj = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
                if (v && Array.isArray(v.data) && typeof v.ts === 'number') {
                    CUSTOM_MODELS_CACHE.set(k, { data: v.data, ts: v.ts });
                }
            }
        }
    } catch {}
}
function customModelsCacheSave() {
    try {
        const obj = {};
        for (const [k, v] of CUSTOM_MODELS_CACHE) obj[k] = { data: v.data, ts: v.ts };
        const tmp = CUSTOM_MODELS_CACHE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, CUSTOM_MODELS_CACHE_FILE);
    } catch {}
}
customModelsCacheLoad();
customSweepOrphanProxyConfigs();

const CUSTOM_PROXY_PORT_MIN = 20150;
const CUSTOM_PROXY_PORT_MAX = 20250;

function customLoad() {
    try {
        const raw = fs.readFileSync(CUSTOM_FILE, 'utf8');
        const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!data || !Array.isArray(data.providers)) return { providers: [] };
        return data;
    } catch { return { providers: [] }; }
}
function customSave(data) {
    fs.writeFileSync(CUSTOM_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function customFind(id) {
    const data = customLoad();
    const p = data.providers.find(x => x.id === id);
    return { data, provider: p || null };
}
function customReadActiveProvider() {
    try {
        const j = JSON.parse(fs.readFileSync(CUSTOM_ACTIVE_PROVIDER_FILE, 'utf8'));
        if (j && j.id && j.name && j.baseUrl) return j;
    } catch {}
    return null;
}

// Порты 20150–20250 под Anthropic→OpenAI прокси Custom-провайдеров.
// Провайдер с заполненным modelMap (opus/sonnet/haiku) не умеет Anthropic API
// напрямую → активация спавнит custom-openai-proxy.js и направляет CC на него.
function customProxyConfigFile(id) {
    return path.join(os.homedir(), '.claude', `custom-${id}-proxy.json`);
}
async function customFindFreePort() {
    const used = new Set();
    try {
        for (const p of customLoad().providers) if (p.proxyPort) used.add(p.proxyPort);
    } catch {}
    for (let port = CUSTOM_PROXY_PORT_MIN; port <= CUSTOM_PROXY_PORT_MAX; port++) {
        if (used.has(port)) continue;
        try {
            const net = require('net');
            const sock = net.createServer();
            const ok = await new Promise(resolve => {
                sock.once('error', () => resolve(false));
                sock.listen(port, '127.0.0.1', () => { sock.close(); resolve(true); });
            });
            if (ok) return port;
        } catch { return null; }
    }
    return null;
}
async function customSpawnProxy(provider) {
    try {
        const { spawn } = require('child_process');
        let port = provider.proxyPort;
        if (port) {
            // порт может держать старый/осиротевший прокси после рестарта стека — проверяем
            const free = await new Promise(resolve => {
                const net = require('net');
                const sock = net.createServer();
                sock.once('error', () => resolve(false));
                sock.listen(port, '127.0.0.1', () => { sock.close(); resolve(true); });
            });
            if (!free) port = null;
        }
        if (!port) port = await customFindFreePort();
        if (!port) return { ok: false, error: 'нет свободного порта 20150–20250' };
        const cfg = {
            port,
            upstream: provider.baseUrl,
            keyFile: CUSTOM_ACTIVE_KEY_FILE,
            modelMap: provider.modelMap || {},
            providerName: provider.name,
        };
        const cfgFile = customProxyConfigFile(provider.id);
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        const child = spawn(process.execPath, [path.join(__dirname, 'custom-openai-proxy.js'), cfgFile], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
        });
        child.unref();
        const { data } = customFind(provider.id);
        if (data) {
            const p = data.providers.find(x => x.id === provider.id);
            if (p) { p.proxyPort = port; p.proxyPid = child.pid; customSave(data); }
        }
        logLine(`custom proxy spawn: ${provider.name} :${port} (pid ${child.pid})`);
        return { ok: true, port, pid: child.pid };
    } catch (e) {
        logLine(`custom proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}
async function customKillProxy(provider) {
    let pid = provider && provider.proxyPid;
    const port = provider && provider.proxyPort;
    if (pid) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    // страховка: убить всё, что слушает proxyPort (ловит pid через netstat)
    if (port) {
        try {
            const { execFileSync } = require('child_process');
            const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
            for (const line of out.split(/\r?\n/)) {
                const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
                if (m) { try { execFileSync('taskkill', ['/F', '/PID', m[1]]); } catch {} }
            }
        } catch {}
    }
    try { fs.rmSync(customProxyConfigFile(provider.id), { force: true }); } catch {}
    logLine(`custom proxy kill: ${provider.name}${port ? ' :' + port : ''}`);
}

// Нужен ли конвертер: режим (mode) > протокол (скан) > эвристика по modelMap.
function customNeedProxy(provider) {
    if (provider.mode === 'direct') return false;
    if (provider.mode === 'proxy') return true;
    const proto = provider.protocol || 'unknown';
    if (proto === 'anthropic') return false;
    if (proto === 'openai' || proto === 'mapped') return true;
    const mm = provider.modelMap || {};
    return !!(mm.opus || mm.sonnet || mm.haiku);
}

// Переписать ANTHROPIC_BASE_URL в settings.json (apiKeyHelper не трогаем).
// При перенаправлении на локальный конвертер чистим и env-оверрайды моделей
// (могут остаться от прошлого direct-режима).
function customRepointSettings(url, reason) {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        makeSettingsBackup('settings-custom-' + reason);
        settings.env = settings.env || {};
        settings.env.ANTHROPIC_BASE_URL = url;
        if (String(url).startsWith('http://localhost:')) {
            for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_SMALL_FAST_MODEL']) delete settings.env[k];
            delete settings.model;
        }
        writeSettings(settings);
        return { ok: true };
    } catch (e) {
        logLine(`custom repoint settings (${reason}) FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Прямое подключение (mode=direct): CC сам добавляет /v1/messages к ANTHROPIC_BASE_URL,
// поэтому baseUrl чистим от /v1. Нестандартные имена моделей уходят в ANTHROPIC_DEFAULT_*_MODEL.
function customCleanBase(base) {
    return String(base || '').replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '');
}

// Мутирует settings.env под direct-режим; возвращает массив предупреждений.
function customApplyDirectEnv(settings, provider) {
    settings.env = settings.env || {};
    settings.env.ANTHROPIC_BASE_URL = customCleanBase(provider.baseUrl);
    const mm = provider.modelMap || {};
    const set = (k, v) => { if (v) settings.env[k] = v; else delete settings.env[k]; };
    set('ANTHROPIC_DEFAULT_OPUS_MODEL', mm.opus);
    set('ANTHROPIC_DEFAULT_SONNET_MODEL', mm.sonnet);
    set('ANTHROPIC_DEFAULT_HAIKU_MODEL', mm.haiku);
    set('ANTHROPIC_SMALL_FAST_MODEL', mm.haiku || mm.sonnet);
    for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_MODEL']) delete settings.env[k];
    delete settings.model;
    const warns = [];
    if (provider.protocol === 'openai') warns.push('у провайдера нет Anthropic-роута — прямое не сработает, переключи на прокси');
    else if ((provider.protocol === 'mapped' || !provider.protocol) && !(mm.opus || mm.sonnet || mm.haiku)) warns.push('стандартные имена CC провайдер отклоняет — заполни маппинг (уйдёт в ANTHROPIC_DEFAULT_*_MODEL)');
    return warns;
}

function customApplyDirect(provider) {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        makeSettingsBackup('settings-custom-direct');
        const warns = customApplyDirectEnv(settings, provider);
        writeSettings(settings);
        return { ok: true, warns };
    } catch (e) {
        logLine(`custom apply direct FAILED: ${e.message}`);
        return { ok: false, error: e.message, warns: [] };
    }
}

// Автоподсказка маппинга из каталога: первый claude-opus/sonnet/haiku id на тир.
function suggestClaudeMap(models) {
    const s = { opus: '', sonnet: '', haiku: '' };
    for (const m of (models || [])) {
        const id = String(m.id || '');
        const low = id.toLowerCase();
        if (!s.opus && /claude-?opus/.test(low)) s.opus = id;
        else if (!s.sonnet && /claude-?sonnet/.test(low)) s.sonnet = id;
        else if (!s.haiku && /claude-?haiku/.test(low)) s.haiku = id;
    }
    return s;
}

// Скан типа провайдера: есть ли Anthropic-роут POST /messages и принимает ли он
// стандартную модель Claude Code (claude-opus-5[1m]).
//   openai   — роута /messages нет (404/405) → только конвертер.
//   anthropic— роут есть и стандартную модель принимает → прямое подключение.
//   mapped   — роут есть, но стандартную модель отклоняет (claude-opus-5[1m]
//              отсутствует в каталоге) → нужен маппинг + конвертер.
async function customDetectProtocol(provider, apiKey) {
    const base = String(provider.baseUrl || '').replace(/\/+$/, '');
    const clean = base.replace(/\/v1$/, '').replace(/\/+$/, '');
    const candidates = [];
    if (!candidates.includes(base + '/messages')) candidates.push(base + '/messages');
    const v1 = clean + '/v1/messages';
    if (v1 !== base + '/messages' && !candidates.includes(v1)) candidates.push(v1);

    let models = [], modelsOk = false;
    try {
        const mresp = await fetch(base + '/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(8000),
        });
        if (mresp.ok) {
            const j = await mresp.json();
            models = (j.data || []).map(m => ({ id: m.id, owned_by: m.owned_by }));
            modelsOk = true;
        }
    } catch {}

    const probe = async (model) => {
        for (const url of candidates) {
            try {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
                    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
                    signal: AbortSignal.timeout(8000),
                });
                if (r.status === 404 || r.status === 405) continue; // роута нет → не Anthropic
                if ((r.status === 401 || r.status === 403) && !modelsOk) continue; // ключ невалиден вообще
                return { status: r.status, body: await r.text().catch(() => '') };
            } catch {}
        }
        return null;
    };

    // 1) есть ли вообще работоспособный Anthropic-роут (пробуем общеизвестную claude-модель)
    const baseProbe = await probe('claude-opus-4-8');
    if (!baseProbe) return { protocol: 'openai', models, modelsOk };
    // роут отвечает, но не 200 (503 model_not_found / "No available channel", 400, 429…) →
    // рабочего Anthropic-роута нет → фактически OpenAI (только конвертер).
    if (baseProbe.status !== 200) return { protocol: 'openai', models, modelsOk };

    // 2) принимает ли роут стандартную модель Claude Code
    const defProbe = await probe('claude-opus-5[1m]');
    if (defProbe && defProbe.status === 200) return { protocol: 'anthropic', models, modelsOk };
    const isModelError = defProbe && /model.{0,50}(not found|not_found|does not exist|unknown model|invalid model|not_found_error)/i.test(defProbe.body);
    // 403 на стандартной модели = доступ отклонён (нет такой модели/тира) → нужен маппинг на доступную
    if (defProbe && (isModelError || defProbe.status === 403)) return { protocol: 'mapped', models, modelsOk };
    // неоднозначно — считаем anthropic (прямое подключение, пользователь поправит)
    return { protocol: 'anthropic', models, modelsOk };
}

// Свип осиротевших конфигов конвертеров (~/.claude/custom-<id>-proxy.json) без провайдера.
function customSweepOrphanProxyConfigs() {
    try {
        const data = customLoad();
        const ids = new Set(data.providers.map(p => p.id));
        const dir = path.join(os.homedir(), '.claude');
        for (const f of fs.readdirSync(dir)) {
            const m = f.match(/^custom-(cp_\d+)-proxy\.json$/);
            if (m && !ids.has(m[1])) {
                try { fs.rmSync(path.join(dir, f), { force: true }); logLine(`custom sweep: removed orphan ${f}`); } catch {}
            }
        }
    } catch {}
}

// ── Health: проба всех сервисов (что запущено / что упало) ──────────────────
function summarizeStatus(data) {
    if (!data || typeof data !== 'object') return '';
    const parts = [];
    if (typeof data.usableCount === 'number' && typeof data.totalCount === 'number')
        parts.push(`${data.usableCount}/${data.totalCount} ключей`);
    if (data.activeKeyId) parts.push(`актив:${String(data.activeKeyId).slice(0, 12)}`);
    if (data.modelMap) parts.push(`opus→${data.modelMap.opus} · sonnet→${data.modelMap.sonnet} · haiku→${data.modelMap.haiku}`);
    if (data.mapping && typeof data.mapping === 'object')
        parts.push(`map:${Object.keys(data.mapping).length} моделей`);
    if (data.stats) parts.push(`req:${data.stats.requests ?? '?'} err:${data.stats.errors ?? '?'}`);
    if (data.provider) parts.push(data.provider);
    if (Array.isArray(data.models) && data.models.length) parts.push(`${data.models.length} моделей`);
    if (data.ok && !parts.length) parts.push('ok');
    return parts.slice(0, 4).join(' · ');
}

async function handleHealth(res) {
    // порт → [pid, …] всех слушателей разом (один netstat)
    const listening = new Map();
    try {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        for (const line of out.split(/\r?\n/)) {
            const m = line.match(/:(\d{4,5})\s+\S+\s+LISTENING\s+(\d+)/);
            if (m) {
                const p = +m[1];
                if (!listening.has(p)) listening.set(p, []);
                listening.get(p).push(m[2]);
            }
        }
    } catch {}

    const checks = [
        { name: 'Дашборд (switcher)', port: LISTEN_PORT, path: '/__switch/api/status' },
        { name: 'Front Door', port: frontdoorPort(), path: '/__frontdoor/api/status', frontdoor: true },
        { name: 'FreeModel ротатор',  port: 20126, path: '/__fmrot/api/status' },
        { name: 'FreeModel OpenAI',   port: 20130, path: '/__fmoai/api/status' },
        { name: 'VyceAI',             port: 20131, path: '/__vyceai/api/status' },
        { name: 'AgentRouter',        port: 20132, path: '/__agentrouter/api/status' },
        { name: 'Keepalive',          port: AR_KEEPALIVE_PORT, path: '/__keepalive/api/status', keepalive: true },
        { name: 'Keepalive GoRouter', port: Number(process.env.GO_KEEPALIVE_PORT || 20156), path: '/__keepalive/api/status', keepalive: true },
        { name: 'Keepalive Tabi',     port: Number(process.env.TB_KEEPALIVE_PORT || 20155), path: '/__keepalive/api/status', keepalive: true },
        { name: 'Keepalive XPeach',   port: Number(process.env.XP_KEEPALIVE_PORT || 20157), path: '/__keepalive/api/status', keepalive: true },
    ];
    const knownPorts = new Set(checks.map(c => c.port));

    // Custom-конвертеры из конфига (не забыть их, даже если порт не в диапазоне).
    //
    // Само-починка протухшей записи. proxyPort/proxyPid пишутся при спавне и снимаются
    // только на ЯВНЫХ путях: переключение провайдера, стоп, удаление. Если конвертер умер
    // сам — упал, попал под KILLPORT из restart-dashboard.bat, ребут машины — запись
    // остаётся, и Health навсегда рисует красное «упал» провайдеру, которым даже не
    // пользуются (жил месяцами: `:20150` BluesMinds с pid из прошлой загрузки).
    // Порт никто не слушает и провайдер не активен → это протухший конфиг, а не поломка:
    // чистим запись и строку не рисуем. У АКТИВНОГО провайдера мёртвый конвертер —
    // настоящая авария (в него смотрит Claude Code), там красное остаётся.
    {
        const cdata = customLoad();
        const activeId = (customReadActiveProvider() || {}).id || null;
        let healed = false;
        for (const p of (cdata.providers || [])) {
            if (!p.proxyPort) continue;
            if (!listening.has(p.proxyPort) && p.id !== activeId) {
                logLine(`health: протухшая запись конвертера ${p.name} (:${p.proxyPort}, pid ${p.proxyPid || '—'}) — порт не слушают, чищу`);
                p.proxyPort = null;
                p.proxyPid = null;
                healed = true;
                continue;
            }
            knownPorts.add(p.proxyPort);
            checks.push({ name: `Custom: ${p.name}`, port: p.proxyPort, path: '/__custom/api/status', custom: p });
        }
        if (healed) customSave(cdata);
    }
    // Осиротевшие конвертеры 20150–20250 (слушают, но не в конфиге) — полезно знать
    for (const port of listening.keys()) {
        if (port >= 20150 && port <= 20250 && !knownPorts.has(port))
            checks.push({ name: `Порт :${port} (осиротел)`, port, path: '/__custom/api/status', orphan: true });
    }

    const probe = async (c) => {
        const t0 = Date.now();
        let status = 'down', data = null;
        try {
            const r = await fetch(`http://127.0.0.1:${c.port}${c.path}`, { signal: AbortSignal.timeout(1500) });
            if (r.ok) {
                status = 'up';
                try { data = await r.json(); } catch {}
            }
        } catch {}
        const pids = listening.get(c.port) || [];
        return {
            name: c.name,
            port: c.port,
            pid: pids[0] || null,
            status,
            ms: Date.now() - t0,
            orphan: !!c.orphan,
            keepalive: !!c.keepalive,
            frontdoor: !!c.frontdoor,
            custom: c.custom ? { id: c.custom.id, modelMap: c.custom.modelMap } : undefined,
            detail: summarizeStatus(data),
        };
    };
    const services = await Promise.all(checks.map(probe));

    // OmniRoute (local :20128) — отдельная проба по ключу: 200 = жив+ключ ок,
    // 401 = сервер жив, но ключ невалиден, сеть упала = сервис лежит.
    {
        const t0 = Date.now();
        const om = { name: 'OmniRoute', port: 20128, pid: (listening.get(20128) || [null])[0], status: 'down', ms: 0, omni: true, warn: false, detail: 'порт 20128 не слушает' };
        if (listening.has(20128)) {
            try {
                let key = '';
                try { key = fs.readFileSync(OM_ACTIVE_KEY_FILE, 'utf8').trim(); } catch {}
                if (!key) key = omniKey();
                const r = await fetch('http://localhost:20128/v1/models', {
                    headers: { 'Authorization': `Bearer ${key}` },
                    signal: AbortSignal.timeout(2500),
                });
                om.ms = Date.now() - t0;
                om.status = 'up';
                if (r.status === 401) { om.warn = true; om.detail = 'сервер жив, ключ невалиден (401)'; }
                else if (r.ok) { om.detail = 'жив, ключ валиден'; }
                else { om.detail = `жив, http ${r.status}`; }
            } catch { om.status = 'down'; om.detail = 'порт слушает, но /v1/models не отвечает'; }
        }
        services.push(om);
    }

    services.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'down' ? -1 : 1; // упавшие сверху
        return a.port - b.port;
    });

    // Куда смотрит Claude Code сейчас
    let wired = { base: null, port: null, up: false, service: null, frontdoor: false, backend: null, effectivePort: null, effectiveService: null };
    try {
        const s = readSettings();
        const base = (s.env && s.env.ANTHROPIC_BASE_URL) || '';
        const pm = base.match(/:(\d+)/);
        wired.base = base;
        wired.port = pm ? +pm[1] : null;
        wired.up = wired.port ? listening.has(wired.port) : false;
        const svc = services.find(x => x.port === wired.port);
        wired.service = svc ? svc.name : null;
        // Front-door: settings.json всегда показывает :20100, а настоящий апстрим
        // лежит в active-backend.json. Без этого keepalive активного провайдера
        // числился бы «не запущен» (серым), даже если он реально упал.
        if (isFrontdoorBase(base)) {
            wired.frontdoor = true;
            const st = readActiveBackend();
            wired.backend = (st && st.backend) || null;
            const up = st && st.upstream ? String(st.upstream) : '';
            const upm = up.match(/^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]):(\d+)/i);
            wired.effectivePort = upm ? +upm[1] : null;      // удалённый шлюз — порта нет
            if (wired.effectivePort) {
                const esvc = services.find(x => x.port === wired.effectivePort);
                wired.effectiveService = esvc ? esvc.name : null;
            }
        }
    } catch {}

    // Обновления кода дашборда
    let git = { branch: null, behind: null, local: null, remote: null };
    try {
        const repo = path.join(__dirname, '..');
        const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
        const branch = g('rev-parse', '--abbrev-ref', 'HEAD');
        g('fetch', '--quiet', 'origin', branch);
        git = {
            branch,
            local: g('rev-parse', '--short', 'HEAD'),
            remote: g('rev-parse', '--short', `origin/${branch}`),
            behind: parseInt(g('rev-list', '--count', `HEAD..origin/${branch}`) || '0', 10),
        };
    } catch {}

    return jsonRes(res, 200, {
        services,
        wired,
        git,
        current: currentTarget(),
        uptime_s: Math.round(process.uptime()),
    });
}

// GET /__switch/api/custom/providers → список провайдеров + ключей + активный
async function handleCustomProviders(req, res) {
    try {
        const data = customLoad();
        jsonRes(res, 200, { providers: data.providers, active: customReadActiveProvider() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/provider { name, baseUrl } → создать провайдера
async function handleCustomProviderCreate(req, res) {
    try {
        const { name, baseUrl } = await readJsonBody(req);
        const n = String(name || '').trim();
        const b = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!n || !b) return jsonRes(res, 400, { error: 'name и baseUrl обязательны' });
        if (!/^https?:\/\//.test(b)) return jsonRes(res, 400, { error: 'baseUrl должен начинаться с http(s)://' });
        const data = customLoad();
        if (data.providers.some(p => p.baseUrl === b)) {
            return jsonRes(res, 400, { error: `провайдер с baseUrl ${b} уже есть (${data.providers.find(p => p.baseUrl === b).name})` });
        }
        const id = 'cp_' + Date.now();
        data.providers.push({ id, name: n, baseUrl: b, createdAt: new Date().toISOString(), keys: [], modelMap: {}, proxyPort: null, proxyPid: null });
        customSave(data);
        logLine(`custom provider add: ${n} (${b})`);
        jsonRes(res, 200, { ok: true, id });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/provider/update { id, name, baseUrl } → отредактировать провайдера
async function handleCustomProviderUpdate(req, res) {
    try {
        const { id, name, baseUrl } = await readJsonBody(req);
        const { data, provider } = customFind(String(id || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        const n = String(name || '').trim();
        const b = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!n || !b) return jsonRes(res, 400, { error: 'name и baseUrl обязательны' });
        if (!/^https?:\/\//.test(b)) return jsonRes(res, 400, { error: 'baseUrl должен начинаться с http(s)://' });
        if (data.providers.some(p => p.baseUrl === b && p.id !== provider.id)) {
            return jsonRes(res, 400, { error: `провайдер с baseUrl ${b} уже есть` });
        }
        const baseChanged = provider.baseUrl !== b;
        const oldBase = provider.baseUrl;
        provider.name = n;
        provider.baseUrl = b;
        customSave(data);
        if (baseChanged) {
            // кеш моделей привязан к старому baseUrl — он больше не валиден
            CUSTOM_MODELS_CACHE.delete(oldBase);
        }

        // если провайдер активен — синхронизируем активные файлы, прокси и settings.json
        const active = customReadActiveProvider();
        if (active && active.id === provider.id) {
            fs.writeFileSync(CUSTOM_ACTIVE_PROVIDER_FILE,
                JSON.stringify({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl }, null, 2) + '\n', 'utf-8');
            // под активным провайдером крутится прокси (modelMap) → перезапускаем с новым upstream
            if (provider.proxyPid) {
                await customKillProxy(provider);
                const r2 = await customSpawnProxy(provider);
                logLine(`custom provider update: proxy respawn ${r2.ok ? ': ' + r2.port : 'FAIL ' + (r2.error || '?')}`);
            }
            try {
                const fresh = customFind(provider.id).provider;
                const targetUrl = fresh && fresh.proxyPort ? `http://localhost:${fresh.proxyPort}` : b;
                const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
                const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
                settings.env = settings.env || {};
                if (String(settings.apiKeyHelper || '').includes('custom-active-key.txt')) {
                    makeSettingsBackup('settings-custom-update');
                    settings.env.ANTHROPIC_BASE_URL = targetUrl;
                    writeSettings(settings);
                }
            } catch (e) {
                logLine(`custom provider update: settings.json FAILED: ${e.message}`);
            }
        }
        logLine(`custom provider update: ${n} (${b})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/provider/delete { id } → удалить провайдера
async function handleCustomProviderDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const { data, provider } = customFind(String(id || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        await customKillProxy(provider);
        data.providers = data.providers.filter(p => p.id !== provider.id);
        customSave(data);
        const active = customReadActiveProvider();
        if (active && active.id === provider.id) {
            try { fs.rmSync(CUSTOM_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(CUSTOM_ACTIVE_PROVIDER_FILE, { force: true }); } catch {}
        }
        logLine(`custom provider delete: ${provider.name}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/key { providerId, apiKey } → добавить ключ
async function handleCustomKeyAdd(req, res) {
    try {
        const { providerId, apiKey } = await readJsonBody(req);
        const key = String(apiKey || '').trim();
        const { data, provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        if (!key) return jsonRes(res, 400, { error: 'apiKey обязателен' });
        if (provider.keys.some(k => k.apiKey === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        provider.keys.push({ apiKey: key, active: false, status: null, addedAt: new Date().toISOString() });
        customSave(data);
        logLine(`custom key add: ${provider.name} (***${key.slice(-6)})`);

        // авто-скан типа провайдера первым ключом + авто-подсказка маппинга
        let scan = null;
        if (provider.keys.length === 1) {
            scan = await customDetectProtocol(provider, key);
            if (scan.protocol) provider.protocol = scan.protocol;
            provider.scanTs = Date.now();
            const mm = provider.modelMap || {};
            if (!mm.opus && !mm.sonnet && !mm.haiku) {
                const sug = suggestClaudeMap(scan.models || []);
                if (sug.opus || sug.sonnet || sug.haiku) provider.modelMap = sug;
            }
            customSave(data);
            logLine(`custom key add: scan ${provider.name} → ${scan.protocol || 'unknown'}${scan.modelsOk ? `, ${scan.models.length} моделей` : ''}`);
        }
        jsonRes(res, 200, {
            ok: true,
            protocol: provider.protocol,
            scan: scan ? { protocol: scan.protocol, error: scan.error || null } : null,
            modelMap: provider.modelMap,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/key/delete { providerId, apiKey } → удалить ключ
async function handleCustomKeyDelete(req, res) {
    try {
        const { providerId, apiKey } = await readJsonBody(req);
        const key = String(apiKey || '').trim();
        const { data, provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        provider.keys = provider.keys.filter(k => k.apiKey !== key);
        customSave(data);
        let activeKey = '';
        try { activeKey = fs.readFileSync(CUSTOM_ACTIVE_KEY_FILE, 'utf8').trim(); } catch {}
        if (key === activeKey) {
            await customKillProxy(provider);
            try { fs.rmSync(CUSTOM_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(CUSTOM_ACTIVE_PROVIDER_FILE, { force: true }); } catch {}
        }
        logLine(`custom key delete: ${provider.name} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/key/update { providerId, oldApiKey, newApiKey } → заменить значение ключа
async function handleCustomKeyUpdate(req, res) {
    try {
        const { providerId, oldApiKey, newApiKey } = await readJsonBody(req);
        const oldK = String(oldApiKey || '').trim();
        const newK = String(newApiKey || '').trim();
        const { data, provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        const target = provider.keys.find(k => k.apiKey === oldK);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });
        if (!newK) return jsonRes(res, 400, { error: 'apiKey обязателен' });
        if (provider.keys.some(k => k.apiKey === newK)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        target.apiKey = newK;
        customSave(data);
        // если редактируется активный ключ — обновляем active-key файл (прокси читает его на каждый запрос)
        let activeKey = '';
        try { activeKey = fs.readFileSync(CUSTOM_ACTIVE_KEY_FILE, 'utf8').trim(); } catch {}
        if (oldK === activeKey) {
            fs.writeFileSync(CUSTOM_ACTIVE_KEY_FILE, newK, { encoding: 'utf-8', flag: 'w' });
            logLine(`custom key update: активный ключ перезаписан (***${newK.slice(-6)})`);
        }
        logLine(`custom key update: ${provider.name} (***${newK.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// GET /__switch/api/custom/ping?providerId=...&apiKey=... → проверить один ключ
async function handleCustomPing(req, res) {
    try {
        const q = new URL(req.url, 'http://localhost');
        const providerId = q.searchParams.get('providerId');
        const apiKey = q.searchParams.get('apiKey');
        const { data, provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        const status = await customProbe(provider, apiKey);
        const target = provider.keys.find(k => k.apiKey === apiKey);
        if (target) { target.status = status; customSave(data); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// GET /__switch/api/custom/models?providerId=...&apiKey=...&force=1 → список моделей по ключу
async function handleCustomModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const providerId = url.searchParams.get('providerId');
        const apiKey = url.searchParams.get('apiKey');
        const force = url.searchParams.get('force') === '1';
        const { provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        if (!apiKey) return jsonRes(res, 400, { error: 'apiKey required' });

        const now = Date.now();
        const cache = CUSTOM_MODELS_CACHE.get(provider.baseUrl);
        // свежий кеш — отдаём сразу, апстрим не дёргаем
        if (cache && Array.isArray(cache.data) && now - cache.ts < CUSTOM_MODELS_FRESH_MS && !force) {
            return jsonRes(res, 200, { ok: true, models: cache.data, cached: true, stale: false });
        }
        // устаревший кеш (или после рестарта) — отдаём с пометкой stale
        if (cache && Array.isArray(cache.data) && now - cache.ts < CUSTOM_MODELS_STALE_MS && !force) {
            return jsonRes(res, 200, { ok: true, models: cache.data, cached: true, stale: true });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const base = provider.baseUrl.replace(/\/+$/, '');
        const resp = await fetch(base + '/models', {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        clearTimeout(timeout);

        // апстрим упал — отдаём последний кеш
        if (!resp.ok) {
            if (cache && Array.isArray(cache.data)) {
                return jsonRes(res, 200, { ok: true, models: cache.data, cached: true, stale: true, note: `HTTP ${resp.status}` });
            }
            return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}` });
        }

        const data = await resp.json();
        const models = (data.data || []).map(m => ({ id: m.id, owned_by: m.owned_by }));
        CUSTOM_MODELS_CACHE.set(provider.baseUrl, { data: models, ts: now });
        customModelsCacheSave();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        const provider = customFind(String(new URL(req.url, 'http://localhost').searchParams.get('providerId') || '').trim()).provider;
        const cache = provider && CUSTOM_MODELS_CACHE.get(provider.baseUrl);
        if (cache && Array.isArray(cache.data)) {
            jsonRes(res, 200, { ok: true, models: cache.data, cached: true, stale: true, note: e.message });
        } else {
            jsonRes(res, 200, { ok: true, models: [], note: e.message });
        }
    }
}

// POST /__switch/api/custom/activate { providerId, apiKey } → сделать активным в settings.json
async function handleCustomActivate(req, res) {
    try {
        const { providerId, apiKey } = await readJsonBody(req);
        const key = String(apiKey || '').trim();
        const { data, provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        const target = provider.keys.find(k => k.apiKey === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        // при переключении custom-провайдера гасим конвертер предыдущего
        const prevActive = customReadActiveProvider();
        if (prevActive && prevActive.id !== provider.id) {
            const prev = customFind(prevActive.id).provider;
            if (prev && prev.proxyPid) {
                await customKillProxy(prev);
                prev.proxyPort = null;
                prev.proxyPid = null;
                customSave(data);
                logLine(`custom activate: killed previous converter ${prev.name}`);
            }
        }

        fs.writeFileSync(CUSTOM_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        fs.writeFileSync(CUSTOM_ACTIVE_PROVIDER_FILE,
            JSON.stringify({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl }, null, 2) + '\n', 'utf-8');
        provider.keys.forEach(k => { k.active = k.apiKey === key; });
        customSave(data);

        // Тип провайдера: режим (mode) > протокол (скан) > эвристика по modelMap.
        const needProxy = customNeedProxy(provider);
        let proxy = null;
        let directWarns = [];
        if (needProxy) {
            proxy = await customSpawnProxy(provider);
            if (!proxy.ok) return jsonRes(res, 400, { error: 'не удалось поднять прокси: ' + (proxy.error || '?') });
        }

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-custom');
            settings.env = settings.env || {};
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            settings.apiKeyHelper = keyHelperCmd('custom-active-key.txt');
            delete settings.env.ANTHROPIC_API_KEY;
            delete settings.env.ANTHROPIC_AUTH_TOKEN;
            if (needProxy) {
                settings.env.ANTHROPIC_BASE_URL = `http://localhost:${proxy.port}`;
                for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME']) delete settings.env[k];
                delete settings.model;
            } else {
                directWarns = customApplyDirectEnv(settings, provider);
            }
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`custom activate: settings.json FAILED: ${e.message}`);
            if (proxy && proxy.ok) await customKillProxy(provider);
        }
        logLine(`custom activate: ${provider.name} → ***${key.slice(-6)} (helper${proxy ? ', via proxy :' + proxy.port : ', direct'})`);
        jsonRes(res, 200, { ok: true, provider: provider.name, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, viaProxy: !!proxy, mode: needProxy ? 'proxy' : 'direct', warns: directWarns });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/modelmap { providerId, opus, sonnet, haiku } → сохранить маппинг claude-тиров
async function handleCustomModelMap(req, res) {
    try {
        const { providerId, opus, sonnet, haiku } = await readJsonBody(req);
        const { data, provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        provider.modelMap = {
            opus: String(opus || '').trim() || null,
            sonnet: String(sonnet || '').trim() || null,
            haiku: String(haiku || '').trim() || null,
        };
        customSave(data);
        logLine(`custom modelmap: ${provider.name} opus→${provider.modelMap.opus || '-'} sonnet→${provider.modelMap.sonnet || '-'} haiku→${provider.modelMap.haiku || '-'}`);

        // Сохранение маппинга само синхронизирует конвертер активного провайдера:
        // поднять, если его нет; перезапустить, если он уже есть; погасить, если маппинг очищен.
        const active = customReadActiveProvider();
        let action = 'saved', message = 'Маппинг сохранён. Активируй провайдера, чтобы применить.', port = null;
        if (active && active.id === provider.id) {
            const needProxy = customNeedProxy(provider);
            if (!needProxy) {
                // direct-режим: конвертер не нужен, маппинг уходит в ANTHROPIC_DEFAULT_*_MODEL
                if (provider.proxyPid) {
                    await customKillProxy(provider);
                    provider.proxyPort = null;
                    provider.proxyPid = null;
                    customSave(data);
                }
                const r = customApplyDirect(provider);
                if (r.ok) {
                    action = 'direct';
                    message = 'Прямое подключение: маппинг ушёл в ANTHROPIC_DEFAULT_*_MODEL. Перезапусти сессию Claude Code.'
                        + (r.warns.length ? ' ⚠ ' + r.warns.join('; ') : '');
                } else {
                    action = 'error';
                    message = 'Direct: settings.json не обновился: ' + (r.error || '?');
                }
            } else if (provider.proxyPid) {
                await customKillProxy(provider);
                const r2 = await customSpawnProxy(provider);
                if (r2.ok) {
                    port = r2.port;
                    const s = customRepointSettings(`http://localhost:${r2.port}`, 'modelmap-respawn');
                    action = 'restarted';
                    message = s.ok
                        ? `Конвертер перезапущен на :${r2.port} с новым маппингом. Перезапусти сессию Claude Code.`
                        : `Конвертер перезапущен на :${r2.port}, но settings.json не обновился: ${s.error}.`;
                } else {
                    action = 'error';
                    message = 'Не удалось перезапустить конвертер: ' + (r2.error || '?');
                }
            } else if (needProxy && !provider.proxyPid) {
                const r2 = await customSpawnProxy(provider);
                if (r2.ok) {
                    port = r2.port;
                    const s = customRepointSettings(`http://localhost:${r2.port}`, 'modelmap-spawn');
                    action = 'spawned';
                    message = s.ok
                        ? `Конвертер поднят на :${r2.port}, Claude Code перенаправлен на http://localhost:${r2.port}. Перезапусти сессию Claude Code.`
                        : `Конвертер поднят на :${r2.port}, но settings.json не обновился: ${s.error}.`;
                } else {
                    action = 'error';
                    message = 'Не удалось поднять конвертер: ' + (r2.error || '?');
                }
            } else if (!needProxy && provider.proxyPid) {
                await customKillProxy(provider);
                const s = customRepointSettings(provider.baseUrl, 'modelmap-kill');
                action = 'killed';
                message = s.ok
                    ? `Конвертер остановлен, подключение напрямую к ${provider.baseUrl}. Перезапусти сессию Claude Code.`
                    : `Конвертер остановлен, но settings.json не обновился: ${s.error}.`;
            } else {
                action = 'noop';
                message = needProxy
                    ? 'Маппинг сохранён. Конвертер уже готов.'
                    : 'Маппинг сохранён. Провайдер Anthropic-совместимый — прямое подключение, конвертер не нужен.';
            }
        }
        logLine(`custom modelmap action: ${action} | ${message}`);
        jsonRes(res, 200, { ok: true, modelMap: provider.modelMap, action, message, port });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/scan { providerId, apiKey } → повторный скан типа провайдера
async function handleCustomScan(req, res) {
    try {
        const { providerId, apiKey } = await readJsonBody(req);
        const { data, provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        const key = String(apiKey || '').trim()
            || (provider.keys.find(k => k.active) || {}).apiKey
            || (provider.keys[0] || {}).apiKey;
        if (!key) return jsonRes(res, 400, { error: 'нет ключа для сканирования — добавь ключ' });
        const scan = await customDetectProtocol(provider, key);
        provider.protocol = scan.protocol || provider.protocol || 'unknown';
        if (!provider.mode) provider.mode = scan.protocol === 'anthropic' ? 'direct' : 'proxy';
        provider.scanTs = Date.now();
        customSave(data);
        logLine(`custom scan: ${provider.name} → ${provider.protocol} (${scan.modelsOk ? scan.models.length + ' моделей' : 'модели недоступы'})`);
        jsonRes(res, 200, { ok: true, protocol: provider.protocol, mode: provider.mode, models: scan.models, modelsOk: scan.modelsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/custom/mode { providerId, mode } → переключить режим подключения (proxy|direct)
async function handleCustomMode(req, res) {
    try {
        const { providerId, mode } = await readJsonBody(req);
        const { data, provider } = customFind(String(providerId || '').trim());
        if (!provider) return jsonRes(res, 404, { error: 'провайдер не найден' });
        const m = String(mode || '').trim();
        if (m !== 'proxy' && m !== 'direct') return jsonRes(res, 400, { error: 'mode должен быть proxy или direct' });
        provider.mode = m;
        customSave(data);
        let action = 'saved', message = 'Режим сохранён. Активируй провайдера, чтобы применить.', warns = [];
        const active = customReadActiveProvider();
        if (active && active.id === provider.id) {
            const needProxy = customNeedProxy(provider);
            if (needProxy) {
                await customKillProxy(provider);
                provider.proxyPort = null;
                provider.proxyPid = null;
                customSave(data);
                const r = await customSpawnProxy(provider);
                if (r.ok) {
                    const s = customRepointSettings(`http://localhost:${r.port}`, 'mode-proxy');
                    action = 'proxy';
                    message = s.ok
                        ? `Режим «прокси»: конвертер поднят на :${r.port}. Перезапусти сессию Claude Code.`
                        : `Конвертер на :${r.port}, но settings.json не обновился: ${s.error}.`;
                } else {
                    action = 'error';
                    message = 'Не удалось поднять конвертер: ' + (r.error || '?');
                }
            } else {
                await customKillProxy(provider);
                provider.proxyPort = null;
                provider.proxyPid = null;
                customSave(data);
                const r = customApplyDirect(provider);
                warns = r.warns || [];
                action = 'direct';
                message = r.ok
                    ? `Режим «прямое»: подключение к ${customCleanBase(provider.baseUrl)}` + (warns.length ? ' ⚠ ' + warns.join('; ') : '') + '. Перезапусти сессию Claude Code.'
                    : 'Direct: settings.json не обновился: ' + (r.error || '?');
            }
        }
        logLine(`custom mode: ${provider.name} → ${m} (${action})`);
        jsonRes(res, 200, { ok: true, mode: provider.mode, action, message, warns });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function customProbe(provider, apiKey) {
    try {
        const base = String(provider.baseUrl || '').replace(/\/+$/, '');
        const r = await fetch(base + '/models', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(12000),
        });
        return r.status === 401 ? 'dead' : (r.ok ? 'live' : 'unknown');
    } catch { return 'unknown'; }
}

// POST /__switch/api/custom/deactivate → снять кастомного провайдера с активности
async function handleCustomDeactivate(req, res) {
    try {
        const active = customReadActiveProvider();
        if (active) {
            const { data: d2, provider } = customFind(active.id);
            if (provider) {
                await customKillProxy(provider);
                provider.proxyPort = null;
                provider.proxyPid = null;
                customSave(d2);
            }
        }
        try { fs.rmSync(CUSTOM_ACTIVE_KEY_FILE, { force: true }); } catch {}
        try { fs.rmSync(CUSTOM_ACTIVE_PROVIDER_FILE, { force: true }); } catch {}
        const data = customLoad();
        data.providers.forEach(p => (p.keys || []).forEach(k => { k.active = false; }));
        customSave(data);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            // только если кастомный провайдер действительно активен — не трогаем чужие настройки
            if (String(settings.apiKeyHelper || '').includes('custom-active-key.txt')) {
                makeSettingsBackup('settings-custom-deactivate');
                delete settings.apiKeyHelper;
                settings.env = settings.env || {};
                delete settings.env.ANTHROPIC_BASE_URL;
                delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
                for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_SMALL_FAST_MODEL']) delete settings.env[k];
                delete settings.model;
                writeSettings(settings);
                settingsOk = true;
            }
        } catch (e) {
            logLine(`custom deactivate: settings.json FAILED: ${e.message}`);
        }
        logLine(`custom deactivate (settingsUpdated=${settingsOk})`);
        jsonRes(res, 200, { ok: true, settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Cun (cun) — ручной пул ключей (cun.ai) ─────
// Docs: https://doc.cun.ai/zh/guide/clients/claude-code
// Claude Code: ANTHROPIC_BASE_URL=https://www.cun.ai (БЕЗ /v1) + ANTHROPIC_AUTH_TOKEN
// OpenAI-compat API (models/chat): https://www.cun.ai/v1
const CUN_SESSIONS_FILE = path.join(__dirname, 'cun-sessions.json');
const CUN_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'cun-active-key.txt');
const CUN_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'cun-active-model.txt');
const CUN_TIERS_FILE = path.join(os.homedir(), '.claude', 'cun-active-tiers.json');
const CUN_SITE_URL = 'https://www.cun.ai';       // Claude Code ANTHROPIC_BASE_URL
const CUN_API_URL = 'https://www.cun.ai/v1';    // OpenAI-compat /models
const CUN_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

// Алиасы Claude Code: /model opus|sonnet|haiku → разные тиры, НЕ одна и та же модель.
// Первый ID из списка, который есть в /v1/models, побеждает.
const CUN_TIER_PREFS = {
    opus: [
        'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
        'gpt-5.4-pro', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.4-high', 'gpt-5.2-xhigh',
        'gemini-3.1-pro-preview', 'kimi-k2.6', 'deepseek-v4-pro',
    ],
    sonnet: [
        'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929',
        'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'glm-5.2', 'MiniMax-M2.7',
        'qwen3.7-max', 'gemini-3-flash', 'kimi-k2.5',
    ],
    haiku: [
        'claude-haiku-4-5', 'deepseek-v4-flash', 'gemini-3.5-flash',
        'gemini-3.1-flash-lite', 'qwen3.5-flash', 'gpt-5-mini', 'gpt-5-nano',
        'gpt-4.1-mini', 'gpt-4o-mini',
    ],
};

function cunLoad() {
    try {
        const raw = fs.readFileSync(CUN_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function cunSave(arr) {
    fs.writeFileSync(CUN_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function cunReadActiveModel() {
    try { return fs.readFileSync(CUN_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function cunReadTiers() {
    try {
        const t = JSON.parse(fs.readFileSync(CUN_TIERS_FILE, 'utf8'));
        if (t && t.opus && t.sonnet && t.haiku) return t;
    } catch {}
    return null;
}
function cunWriteTiers(tiers) {
    try { fs.writeFileSync(CUN_TIERS_FILE, JSON.stringify(tiers, null, 2) + '\n', 'utf8'); }
    catch (e) { logLine(`cun tiers write failed: ${e.message}`); }
}

function cunPickFromPrefs(prefs, availableSet) {
    for (const id of prefs) {
        if (availableSet.has(id)) return id;
    }
    return null;
}

/** Собрать opus/sonnet/haiku из каталога Cun (разные модели). */
function cunResolveTiers(availableIds) {
    const set = new Set((availableIds || []).filter(Boolean));
    const saved = cunReadTiers();
    // если сохранённые тиры всё ещё в каталоге — оставить (ручной override через файл ок)
    if (saved && set.has(saved.opus) && set.has(saved.sonnet) && set.has(saved.haiku)) {
        return { ...saved, source: 'saved' };
    }
    let opus = cunPickFromPrefs(CUN_TIER_PREFS.opus, set);
    let sonnet = cunPickFromPrefs(CUN_TIER_PREFS.sonnet, set);
    let haiku = cunPickFromPrefs(CUN_TIER_PREFS.haiku, set);
    // fallbacks если каталог урезан
    const any = [...set];
    if (!opus) opus = sonnet || haiku || any[0] || 'claude-opus-4-8';
    if (!sonnet) sonnet = opus;
    if (!haiku) haiku = sonnet;
    // не даём всем трём совпасть, если есть хоть 2 разных id
    if (opus === sonnet && opus === haiku && any.length >= 2) {
        const other = any.find(id => id !== opus) || opus;
        haiku = other;
    }
    if (opus === sonnet && any.length >= 3) {
        const mid = any.find(id => id !== opus && id !== haiku);
        if (mid) sonnet = mid;
    }
    return { opus, sonnet, haiku, source: 'auto' };
}

async function cunFetchModelIds(apiKey) {
    if (CUN_MODELS_CACHE.data && Date.now() - CUN_MODELS_CACHE.ts < CUN_MODELS_CACHE.TTL) {
        return CUN_MODELS_CACHE.data.map(m => m.id);
    }
    try {
        const resp = await fetch(CUN_API_URL + '/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return (CUN_MODELS_CACHE.data || []).map(m => m.id);
        const data = await resp.json();
        const models = (data.data || []).map(m => ({
            id: m.id,
            owned_by: m.owned_by,
            supported_endpoint_types: m.supported_endpoint_types || [],
        }));
        CUN_MODELS_CACHE.data = models;
        CUN_MODELS_CACHE.ts = Date.now();
        return models.map(m => m.id);
    } catch {
        return (CUN_MODELS_CACHE.data || []).map(m => m.id);
    }
}

/**
 * Только активная модель → ANTHROPIC_MODEL (+ top-level model).
 * DEFAULT_OPUS/SONNET/HAIKU/*_NAME НЕ пишем: мусор в settings, юзер выбирает
 * конкретный id с дашборда. Тиры живут в cun-active-tiers.json для UI/быстрых кнопок.
 */
function cunApplyModelToSettings(settings, model, tiers) {
    const m = String(model || '').trim();
    settings.env = settings.env || {};
    // снести старые тир-маппинги, если остались от прошлых activate
    for (const k of [
        'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
        'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
        'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    ]) delete settings.env[k];
    if (m) {
        settings.model = m;
        settings.env.ANTHROPIC_MODEL = m;
    }
    if (tiers && tiers.opus && tiers.sonnet && tiers.haiku) {
        cunWriteTiers({ opus: tiers.opus, sonnet: tiers.sonnet, haiku: tiers.haiku });
    }
}

/** Конфиг Claude Code по доке Cun: site base + AUTH_TOKEN, без apiKeyHelper. */
function cunApplyGatewayToSettings(settings, apiKey) {
    settings.env = settings.env || {};
    clearOtEnv(settings);
    settings.env.ANTHROPIC_BASE_URL = CUN_SITE_URL;
    settings.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    delete settings.apiKeyHelper;
    delete settings.env.ANTHROPIC_API_KEY;
    delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
}

async function cunProbe(apiKey) {
    try {
        const r = await fetch(`${CUN_API_URL}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(12000),
        });
        return r.status === 401 ? 'dead' : (r.ok ? 'live' : 'unknown');
    } catch { return 'unknown'; }
}

async function handleCunSessions(req, res) {
    try {
        const probe = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('probe') === '1';
        const sessions = cunLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                const batch = sessions.slice(i, i + 3);
                await Promise.all(batch.map(async s => { s.status = await cunProbe(s.api_key); }));
            }
            cunSave(sessions);
        }
        const tiers = cunReadTiers();
        jsonRes(res, 200, {
            sessions,
            activeModel: cunReadActiveModel(),
            tiers,
            siteUrl: CUN_SITE_URL,
            apiUrl: CUN_API_URL,
            // «как API Helper», но для модели — source of truth = txt
            modelFile: CUN_ACTIVE_MODEL_FILE,
            keyFile: CUN_ACTIVE_KEY_FILE,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleCunPing(req, res) {
    try {
        const q = new URL(req.url, 'http://localhost');
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await cunProbe(api_key);
        const sessions = cunLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; cunSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleCunAdd(req, res) {
    try {
        const { email, api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const mail = String(email || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'email и api_key обязательны' });
        const sessions = cunLoad();
        if (sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        sessions.push({ email: mail, api_key: key, active: false });
        cunSave(sessions);
        logLine(`cun add: ${mail} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleCunDelete(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const sessions = cunLoad().filter(s => s.api_key !== key);
        cunSave(sessions);
        logLine(`cun delete: ***${key.slice(-6)}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Клик по ключу → settings: BASE_URL=https://www.cun.ai + ANTHROPIC_AUTH_TOKEN (дока Cun).
async function handleCunActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        const sessions = cunLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        const ids = await cunFetchModelIds(key);
        const tiers = cunResolveTiers(ids);
        let model = body.model != null ? String(body.model).trim() : cunReadActiveModel();
        // дефолт старта = mid-tier (sonnet), не opus
        if (!model) model = tiers.sonnet;
        if (model) fs.writeFileSync(CUN_ACTIVE_MODEL_FILE, model, { encoding: 'utf-8', flag: 'w' });

        fs.writeFileSync(CUN_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        cunSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-cun');
            cunApplyGatewayToSettings(settings, key);
            cunApplyModelToSettings(settings, model, tiers);
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`cun activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`cun activate: ${target.email} → ***${key.slice(-6)} model=${model} tiers opus=${tiers.opus} sonnet=${tiers.sonnet} haiku=${tiers.haiku}`);
        jsonRes(res, 200, {
            ok: true,
            email: target.email,
            mask: '***' + key.slice(-6),
            model: model || null,
            tiers,
            baseUrl: CUN_SITE_URL,
            settingsUpdated: settingsOk,
            via: 'auth_token',
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Выбор модели с дашборда (интерактив):
// 1) пишет ~/.claude/cun-active-model.txt  (как active-key у helper)
// 2) синкает settings: ANTHROPIC_MODEL + gateway AUTH_TOKEN
// Claude Code читает model при старте → после клика нужен рестарт (нет modelHelper).
async function handleCunSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        // model omit / empty / fromFile → взять из cun-active-model.txt
        let m = body.model != null ? String(body.model).trim() : '';
        if (!m || body.fromFile) m = cunReadActiveModel() || m;
        if (!m) return jsonRes(res, 400, { error: 'model обязателен (или заполни cun-active-model.txt)' });

        const sessions = cunLoad();
        const active = sessions.find(s => s.active)
            || sessions.find(s => s.status === 'live')
            || sessions[0];
        if (!active || !active.api_key) {
            return jsonRes(res, 400, { error: 'добавь ключ Cun (➕ Добавить), потом кликни модель' });
        }

        const ids = await cunFetchModelIds(active.api_key);
        const tiers = cunResolveTiers(ids);

        fs.writeFileSync(CUN_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === active.api_key; });
        cunSave(sessions);
        fs.writeFileSync(CUN_ACTIVE_KEY_FILE, active.api_key, { encoding: 'utf-8', flag: 'w' });

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-cun-model');
            cunApplyGatewayToSettings(settings, active.api_key);
            cunApplyModelToSettings(settings, m, tiers);
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`cun set-model: settings.json FAILED: ${e.message}`);
        }
        logLine(`cun set-model: ${m} tiers opus=${tiers.opus} sonnet=${tiers.sonnet} haiku=${tiers.haiku}`);
        jsonRes(res, 200, {
            ok: true,
            model: m,
            tiers,
            settingsUpdated: settingsOk,
            baseUrl: CUN_SITE_URL,
            modelFile: CUN_ACTIVE_MODEL_FILE,
            keyFile: CUN_ACTIVE_KEY_FILE,
            restartRequired: true,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleCunModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (CUN_MODELS_CACHE.data && Date.now() - CUN_MODELS_CACHE.ts < CUN_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: CUN_MODELS_CACHE.data, cached: true });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(CUN_API_URL + '/models', {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${api_key}` }
        });
        clearTimeout(timeout);

        if (!resp.ok) return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}` });

        const data = await resp.json();
        const models = (data.data || []).map(m => ({
            id: m.id,
            owned_by: m.owned_by,
            supported_endpoint_types: m.supported_endpoint_types || [],
        }));
        CUN_MODELS_CACHE.data = models;
        CUN_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (CUN_MODELS_CACHE.data) {
            jsonRes(res, 200, { ok: true, models: CUN_MODELS_CACHE.data, cached: true, note: e.message });
        } else {
            jsonRes(res, 200, { ok: true, models: [], note: e.message });
        }
    }
}

// ───── OmniRoute (om) — ручной пул ключей, активация через API Helper ─────
// По аналогии с Aerolink/Evomap. OmniRoute на localhost:20128/v1.
const OM_SESSIONS_FILE = path.join(__dirname, 'omniroute-sessions.json');
const OM_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'om-active-key.txt');
const OM_BASE_URL = 'http://localhost:20128/v1';

function omLoad() {
    try {
        const raw = fs.readFileSync(OM_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function omSave(arr) {
    fs.writeFileSync(OM_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

async function omProbe(apiKey) {
    try {
        const r = await fetch(`${OM_BASE_URL}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(12000),
        });
        return r.status === 401 ? 'dead' : (r.ok ? 'live' : 'unknown');
    } catch { return 'unknown'; }
}

async function handleOmSessions(req, res) {
    try {
        const probe = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('probe') === '1';
        const sessions = omLoad();
        if (probe) {
            await Promise.all(sessions.map(async s => { s.status = await omProbe(s.api_key); }));
        }
        jsonRes(res, 200, { sessions });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleOmAdd(req, res) {
    try {
        const { email, api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const mail = String(email || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'email и api_key обязательны' });
        const sessions = omLoad();
        if (sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        sessions.push({ email: mail, api_key: key, active: false });
        omSave(sessions);
        logLine(`omniroute add: ${mail} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleOmDelete(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const sessions = omLoad().filter(s => s.api_key !== key);
        omSave(sessions);
        logLine(`omniroute delete: ***${key.slice(-6)}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleOmActivate(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        const sessions = omLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(OM_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        omSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-om');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = OM_BASE_URL;
            settings.apiKeyHelper = keyHelperCmd('om-active-key.txt');
            delete settings.model;
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`omniroute activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`omniroute activate: ${target.email} → ***${key.slice(-6)} (helper)`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Video API (vid) — хранилище ключей видео-провайдеров (fal/Replicate/Veo/…) ─────
// Чисто хранилище: add/delete/list. Никакой активации в settings.json — эти ключи
// не для Claude, а под будущие авторегеры/пайплайны генерации видео.
const VIDEO_KEYS_FILE = path.join(__dirname, 'video-keys.json');

function vidLoad() {
    try {
        const raw = fs.readFileSync(VIDEO_KEYS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function vidSave(arr) {
    fs.writeFileSync(VIDEO_KEYS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function vidToday() {
    return new Date().toISOString().slice(0, 10);
}

async function handleVideoKeys(req, res) {
    try { jsonRes(res, 200, { keys: vidLoad() }); }
    catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleVideoAdd(req, res) {
    try {
        const { provider, label, api_key, note } = await readJsonBody(req);
        const prov = String(provider || '').trim().toLowerCase();
        const key = String(api_key || '').trim();
        if (!prov || !key) return jsonRes(res, 400, { error: 'provider и api_key обязательны' });
        const keys = vidLoad();
        if (keys.some(k => k.provider === prov && k.api_key === key))
            return jsonRes(res, 400, { error: 'такой ключ у этого провайдера уже есть' });
        keys.push({
            provider: prov,
            label: String(label || '').trim() || 'main',
            api_key: key,
            note: String(note || '').trim(),
            added: vidToday(),
        });
        vidSave(keys);
        logLine(`video add: ${prov}/${label || 'main'} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleVideoDelete(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const keys = vidLoad().filter(k => k.api_key !== key);
        vidSave(keys);
        logLine(`video delete: ***${key.slice(-6)}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Video trial-сайты — каталог + статусы (working/dead/?) ─────
// Seed-список зашит в код; пользовательские статусы/заметки в video-trials.json (gitignored).
const VIDEO_TRIALS_FILE = path.join(__dirname, 'video-trials.json');
const VIDEO_TRIALS_SEED = [
    { id: 'runway',      name: 'Runway',        url: 'https://runwayml.com',              kind: 'free credits',  note: 'Gen-4, стартовые кредиты' },
    { id: 'hailuo',      name: 'Hailuo / MiniMax', url: 'https://hailuoai.video',         kind: 'daily free',    note: 'ежедневные бесплатные генерации' },
    { id: 'kling',       name: 'Kling AI',      url: 'https://klingai.com',               kind: 'daily free',    note: 'дневные кредиты, мощный движок' },
    { id: 'pixverse',    name: 'PixVerse',      url: 'https://pixverse.ai',               kind: 'daily free',    note: 'дневные кредиты' },
    { id: 'seedance',    name: 'Seedance (ByteDance)', url: 'https://seed.bytedance.com', kind: 'free credits',  note: 'через fal/replicate тоже' },
    { id: 'pika',        name: 'Pika',          url: 'https://pika.art',                  kind: 'free credits',  note: 'стартовые кредиты' },
    { id: 'luma',        name: 'Luma Dream Machine', url: 'https://lumalabs.ai/dream-machine', kind: 'free tier', note: 'бесплатный тариф' },
    { id: 'fal',         name: 'fal.ai',        url: 'https://fal.ai',                    kind: 'aggregator',    note: 'API-агрегатор, $ кредиты' },
    { id: 'replicate',   name: 'Replicate',     url: 'https://replicate.com',             kind: 'aggregator',    note: 'API-агрегатор, $ кредиты' },
    { id: 'imagineart',  name: 'ImagineArt',    url: 'https://www.imagine.art',           kind: 'free tier',     note: 'free tier видео' },
    { id: 'pollo',       name: 'Pollo.ai',      url: 'https://pollo.ai',                  kind: 'free credits',  note: 'агрегатор моделей' },
    { id: 'krea',        name: 'Krea',          url: 'https://krea.ai',                   kind: 'free tier',     note: 'realtime + видео' },
    { id: 'higgsfield',  name: 'Higgsfield',    url: 'https://higgsfield.ai',             kind: 'free credits',  note: 'motion/камера' },
    { id: 'openart',     name: 'OpenArt',       url: 'https://openart.ai',                kind: 'free credits',  note: 'видео + картинки' },
    { id: 'wavespeed',   name: 'WaveSpeedAI',   url: 'https://wavespeed.ai',              kind: 'aggregator',    note: 'быстрый инференс API' },
    { id: 'genspark',    name: 'Genspark',      url: 'https://www.genspark.ai',           kind: 'free tier',     note: 'AI-агент, видео' },
    { id: 'leonardo',    name: 'Leonardo.ai',   url: 'https://leonardo.ai',               kind: 'daily free',    note: 'дневные токены, motion' },
];
function trialsLoad() { try { const raw = fs.readFileSync(VIDEO_TRIALS_FILE,'utf8'); const o = JSON.parse(raw.charCodeAt(0)===0xFEFF?raw.slice(1):raw); return (o && typeof o==='object') ? o : {}; } catch { return {}; } }
function trialsSave(o) { fs.writeFileSync(VIDEO_TRIALS_FILE, JSON.stringify(o,null,2)+'\n','utf8'); }

async function handleVideoTrials(req, res) {
    try {
        const st = trialsLoad();
        const list = VIDEO_TRIALS_SEED.map(t => ({ ...t, status: (st[t.id]?.status) || '?', userNote: (st[t.id]?.note) || '' }));
        jsonRes(res, 200, { trials: list });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}
async function handleVideoTrialStatus(req, res) {
    try {
        const { id, status, note } = await readJsonBody(req);
        const tid = String(id || '').trim();
        if (!tid) return jsonRes(res, 400, { error: 'id required' });
        const st = trialsLoad();
        st[tid] = { status: String(status || '?'), note: String(note || '') };
        trialsSave(st);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Image API (img) — хранилище ключей картинко-провайдеров (nanobanana/fal/replicate/imagen/…) ─────
// Зеркало Video API: чисто хранилище add/delete/list + менеджер аккаунтов (email+ключ).
// Никакой активации в settings.json — ключи под будущие обёртки/пайплайны генерации картинок.
const IMAGE_KEYS_FILE = path.join(__dirname, 'image-keys.json');

function imgLoad() {
    try {
        const raw = fs.readFileSync(IMAGE_KEYS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function imgSave(arr) {
    fs.writeFileSync(IMAGE_KEYS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

async function handleImageKeys(req, res) {
    try { jsonRes(res, 200, { keys: imgLoad() }); }
    catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleImageAdd(req, res) {
    try {
        const { provider, label, api_key, note } = await readJsonBody(req);
        const prov = String(provider || '').trim().toLowerCase();
        const key = String(api_key || '').trim();
        if (!prov || !key) return jsonRes(res, 400, { error: 'provider и api_key обязательны' });
        const keys = imgLoad();
        if (keys.some(k => k.provider === prov && k.api_key === key))
            return jsonRes(res, 400, { error: 'такой ключ у этого провайдера уже есть' });
        keys.push({
            provider: prov,
            label: String(label || '').trim() || 'main',
            api_key: key,
            note: String(note || '').trim(),
            added: vidToday(),
        });
        imgSave(keys);
        logLine(`image add: ${prov}/${label || 'main'} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleImageDelete(req, res) {
    try {
        const { api_key } = await readJsonBody(req);
        const key = String(api_key || '').trim();
        const keys = imgLoad().filter(k => k.api_key !== key);
        imgSave(keys);
        logLine(`image delete: ***${key.slice(-6)}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Image trial-сайты — каталог + статусы (working/dead/?) ─────
const IMAGE_TRIALS_FILE = path.join(__dirname, 'image-trials.json');
const IMAGE_TRIALS_SEED = [
    { id: 'nanobanana',  name: 'NanoBanana API', url: 'https://nanobananaapi.ai',          kind: 'free credits',  note: 'Gemini Nano Banana 2 / Pro, ~$0.02/img, free на старте' },
    { id: 'kie',         name: 'Kie.ai',         url: 'https://kie.ai/nano-banana-2',      kind: 'aggregator',    note: 'Nano Banana 2 / Pro дешевле Google' },
    { id: 'gemini',      name: 'Google AI Studio', url: 'https://aistudio.google.com',     kind: 'free tier',     note: 'Nano Banana / Imagen напрямую, free лимит' },
    { id: 'fal',         name: 'fal.ai',         url: 'https://fal.ai',                    kind: 'aggregator',    note: 'API-агрегатор, $ кредиты' },
    { id: 'replicate',   name: 'Replicate',      url: 'https://replicate.com',             kind: 'aggregator',    note: 'API-агрегатор, $ кредиты' },
    { id: 'leonardo',    name: 'Leonardo.ai',    url: 'https://leonardo.ai',               kind: 'daily free',    note: 'дневные токены' },
    { id: 'ideogram',    name: 'Ideogram',       url: 'https://ideogram.ai',               kind: 'daily free',    note: 'текст на картинках, дневные кредиты' },
    { id: 'flux',        name: 'FLUX (BFL)',     url: 'https://blackforestlabs.io',        kind: 'free credits',  note: 'FLUX.1, через fal/replicate тоже' },
    { id: 'openart',     name: 'OpenArt',        url: 'https://openart.ai',                kind: 'free credits',  note: 'картинки + видео' },
    { id: 'krea',        name: 'Krea',           url: 'https://krea.ai',                   kind: 'free tier',     note: 'realtime генерация' },
    { id: 'imagineart',  name: 'ImagineArt',     url: 'https://www.imagine.art',           kind: 'free tier',     note: 'free tier картинки' },
    { id: 'recraft',     name: 'Recraft',        url: 'https://recraft.ai',                kind: 'free credits',  note: 'вектор/растр, бренд-дизайн' },
];
function imgTrialsLoad() { try { const raw = fs.readFileSync(IMAGE_TRIALS_FILE,'utf8'); const o = JSON.parse(raw.charCodeAt(0)===0xFEFF?raw.slice(1):raw); return (o && typeof o==='object') ? o : {}; } catch { return {}; } }
function imgTrialsSave(o) { fs.writeFileSync(IMAGE_TRIALS_FILE, JSON.stringify(o,null,2)+'\n','utf8'); }

async function handleImageTrials(req, res) {
    try {
        const st = imgTrialsLoad();
        const list = IMAGE_TRIALS_SEED.map(t => ({ ...t, status: (st[t.id]?.status) || '?', userNote: (st[t.id]?.note) || '' }));
        jsonRes(res, 200, { trials: list });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}
async function handleImageTrialStatus(req, res) {
    try {
        const { id, status, note } = await readJsonBody(req);
        const tid = String(id || '').trim();
        if (!tid) return jsonRes(res, 400, { error: 'id required' });
        const st = imgTrialsLoad();
        st[tid] = { status: String(status || '?'), note: String(note || '') };
        imgTrialsSave(st);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── GitHub-аккаунты (gh) — хранилище купленных аккаунтов ─────
// Купленный аккаунт приходит строкой:
//   Логин:Пароль:2FA-секрет:Recovery codes:Ник
// 2FA-код считается ЛОКАЛЬНО в браузере (TOTP base32 + HMAC-SHA1), сайты не нужны.
// Пароль/секрет/коды НИКОГДА не логируем — только маскированный логин/ник.
const GH_ACCOUNTS_FILE = path.join(__dirname, 'github-accounts.json');

function ghLoad() {
    try {
        const raw = fs.readFileSync(GH_ACCOUNTS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function ghSave(arr) {
    fs.writeFileSync(GH_ACCOUNTS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function ghSanitize(acc) {
    // Отдаём аккаунты в дашборд как есть (пароль/секрет нужны для копирования и TOTP).
    // Маскируем только в логах, ниже.
    return acc;
}

async function handleGhKeys(req, res) {
    try { jsonRes(res, 200, { keys: ghLoad() }); }
    catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function ghNormalizeAccount(raw) {
    const login = String(raw.login || '').trim();
    const nickname = String(raw.nickname || '').trim();
    if (!login) throw new Error('логин обязателен');
    const acc = {
        id: 'gh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        login,
        password: String(raw.password ?? ''),
        totpSecret: String(raw.totpSecret || '').trim().toUpperCase(),
        apiToken: String(raw.apiToken || '').trim(),
        recoveryCodes: Array.isArray(raw.recoveryCodes)
            ? raw.recoveryCodes.map(c => String(c).trim()).filter(Boolean)
            : String(raw.recoveryCodes || '').split(/[,;\s]+/).map(c => c.trim()).filter(Boolean),
        nickname: nickname || login,
        status: ['live', 'cooldown', 'dead', 'error'].includes(raw.status) ? raw.status : 'live',
        note: String(raw.note || '').trim(),
        added: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
    return acc;
}

async function handleGhAdd(req, res) {
    try {
        const raw = await readJsonBody(req);
        const acc = ghNormalizeAccount(raw);
        const keys = ghLoad();
        if (keys.some(k => k.login === acc.login))
            return jsonRes(res, 400, { error: 'аккаунт с таким логином уже есть' });
        keys.push(acc);
        ghSave(keys);
        logLine(`github add: ${acc.login} (ник ${acc.nickname}, секрет ${acc.totpSecret ? 'есть' : 'нет'})`);
        jsonRes(res, 200, { ok: true, id: acc.id });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleGhImport(req, res) {
    try {
        const { accounts } = await readJsonBody(req);
        if (!Array.isArray(accounts) || !accounts.length)
            return jsonRes(res, 400, { error: 'accounts — пустой массив' });
        const keys = ghLoad();
        const existing = new Set(keys.map(k => k.login));
        let added = 0, skipped = 0, errors = [];
        for (const raw of accounts) {
            try {
                const acc = ghNormalizeAccount(raw);
                if (existing.has(acc.login)) { skipped++; continue; }
                keys.push(acc);
                existing.add(acc.login);
                added++;
            } catch (e) {
                const login = String(raw?.login || '?');
                errors.push({ login: login.slice(0, 12) + (login.length > 12 ? '…' : ''), error: e.message });
            }
        }
        ghSave(keys);
        logLine(`github import: +${added} (пропущено ${skipped}, ошибок ${errors.length})`);
        jsonRes(res, 200, { ok: true, added, skipped, errors });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleGhDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const keys = ghLoad();
        const target = keys.find(k => k.id === id);
        const next = keys.filter(k => k.id !== id);
        ghSave(next);
        logLine(`github delete: ${target ? target.login : id}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleGhUpdate(req, res) {
    try {
        const { id, ...patch } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const keys = ghLoad();
        const idx = keys.findIndex(k => k.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const cur = keys[idx];
        if (patch.login !== undefined) cur.login = String(patch.login).trim();
        if (patch.nickname !== undefined) cur.nickname = String(patch.nickname || cur.login).trim();
        if (patch.password !== undefined) cur.password = String(patch.password ?? '');
        if (patch.totpSecret !== undefined) cur.totpSecret = String(patch.totpSecret || '').trim().toUpperCase();
        if (patch.apiToken !== undefined) cur.apiToken = String(patch.apiToken || '').trim();
        if (patch.recoveryCodes !== undefined) {
            cur.recoveryCodes = Array.isArray(patch.recoveryCodes)
                ? patch.recoveryCodes.map(c => String(c).trim()).filter(Boolean)
                : String(patch.recoveryCodes || '').split(/[,;\s]+/).map(c => c.trim()).filter(Boolean);
        }
        if (patch.status !== undefined && ['live', 'cooldown', 'dead', 'error'].includes(patch.status)) cur.status = patch.status;
        if (patch.note !== undefined) cur.note = String(patch.note || '').trim();
        ghSave(keys);
        logLine(`github update: ${cur.login} (статус ${cur.status})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Честный ответ ручек session/open ────────────────────────────────────
//
// Все пять ручек (github, ar, go, tb, xp) спавнят видимый Chromium detached-процессом
// и отвечают `ok` сразу же. Если процесс умирал на старте — нет бинаря браузера под
// установленную версию playwright, профиль занят, пропал скрипт — дашборд всё равно
// рисовал зелёный тост «браузер аккаунта открыт», а окно не появлялось. Причина
// оставалась только в Server Logs, и снаружи это выглядело как «кнопка молча не работает».
//
// Поэтому даём процессу шанс умереть: не умер за SESSION_OPEN_PROBE_MS — считаем, что
// окно поднимается, и отвечаем ok как раньше. Умер — отвечаем ошибкой, дашборд покажет
// красный тост (обработка `data.error` во фронте уже есть, править её не нужно).
const SESSION_OPEN_PROBE_MS = 2000;

// Частые причины падения — с готовым рецептом вместо стектрейса playwright.
function describeSessionOpenFailure(stderr, code) {
    const text = String(stderr || '').trim();
    if (/Executable doesn'?t exist|playwright install/i.test(text)) {
        return 'Chromium для playwright не установлен: выполни в корне репо `npx playwright install chromium`';
    }
    if (/Cannot find module/i.test(text)) {
        return 'не хватает node-зависимостей: выполни в корне репо `npm install`';
    }
    if (/ProcessSingleton|SingletonLock|profile appears to be in use/i.test(text)) {
        return 'профиль занят другим Chromium: закрой окно этого аккаунта и попробуй снова';
    }
    const tail = text.split('\n').map(s => s.trim()).filter(Boolean).pop();
    return tail
        ? `браузер не открылся: ${tail.slice(0, 200)}`
        : `браузер не открылся (процесс вышел с кодом ${code})`;
}

// null — процесс жив (или вышел штатно), строка — текст ошибки для тоста.
function sessionOpenEarlyFailure(proc) {
    return new Promise(resolve => {
        let err = '';
        let timer = null;
        const onData = d => { err += String(d); };
        const finish = (result) => {
            if (timer) clearTimeout(timer);
            proc.removeListener('exit', onExit);
            proc.removeListener('error', onError);
            if (proc.stderr) proc.stderr.removeListener('data', onData);
            resolve(result);
        };
        // open-session.js держит браузер открытым и сам не выходит, так что выход в первые
        // секунды — это падение. Код 0 всё же не считаем ошибкой: ругаться не на что.
        const onExit = (code) => finish(code === 0 ? null : describeSessionOpenFailure(err, code));
        const onError = (e) => finish(`процесс браузера не запустился: ${e.message}`);
        if (proc.stderr) proc.stderr.on('data', onData);
        proc.once('exit', onExit);
        proc.once('error', onError);
        timer = setTimeout(() => finish(null), SESSION_OPEN_PROBE_MS);
    });
}

// Открыть GitHub в персональном профиле браузера на аккаунт (сохраняет сессию).
const ghLkPids = new Map();
function ghPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleGhOpen(req, res) {
    try {
        const { id } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const keys = ghLoad();
        const target = keys.find(k => k.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        // Профиль привязываем к СТАБИЛЬНОМУ id аккаунта: переименование не рвёт сессию.
        const label = 'acct_' + id;

        const prevPid = ghLkPids.get(label);
        if (ghPidAlive(prevPid)) {
            logLine(`github session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'github', 'open-session.js');
        const proc = spawn(process.execPath, [script, label], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`github session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`github session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`github session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => { ghLkPids.delete(label); logLine(`github session/open: ${label} — exited (code ${code}, sig ${sig})`); });
        proc.unref();
        ghLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            ghLkPids.delete(label);
            logLine(`github session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        logLine(`github session/open: ${label} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Заселение готовой GitHub-сессии в новый аккаунт New-API ─────
//
// Проблема: у каждого аккаунта вкладок ar/go/tb/xp свой персистентный профиль Chromium, и
// GitHub в свежем профиле логинится с нуля — логин + пароль + 2FA. При этом ровно эта
// GitHub-сессия обычно уже лежит в профиле другого провайдера: профили куками не делятся.
// Замер на 2026-08-19: 41 профиль с GitHub-сессией на 14 уникальных аккаунтов.
//
// Решение: снимаем GitHub-куки из профиля-источника (github/harvest-session.js →
// storageState, только github.com) и кладём в <provider>/sessions/<label>.json c маркером
// seed:'github'. open-session.js вливает их в свежий профиль и всё равно идёт на
// регистрацию по рефке — остаётся нажать «Continue with GitHub».
//
// Один GitHub на ДРУГОМ хосте = новый аккаунт панели; на ТОМ ЖЕ хосте = вход в уже
// существующий. Поэтому занятые хосты считаем и блокируем (ghSessionUsage).
function ghSessionLib() {
    try { return require('./lib/github-session'); }
    catch (e) { logLine(`github-session недоступен: ${e.message}`); return null; }
}

// Карты pid'ов открытых браузеров по тегу профиля. Собираем ЛЕНИВО: сами карты объявлены
// ниже в файле (arLkPids и компания), на верхнем уровне они бы попали в TDZ.
// Нужны, чтобы не харвестить профиль с открытым браузером: Chromium его не отдаст, а на
// закрытии ещё и перезапишет банку кук.
function ghLkPidsByTag() {
    return { github: ghLkPids, ar: arLkPids, go: goLkPids, tb: tbLkPids, xp: xpLkPids };
}

function ghAnyPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function ghProfileBusy(profile) {
    const map = ghLkPidsByTag()[profile.tag];
    return !!(map && ghAnyPidAlive(map.get(profile.label)));
}

// Сколько стоил скан и не откатился ли он на медленный путь. Раньше ошибка батча DPAPI
// глушилась в catch, скан молча возвращался к процессу PowerShell на профиль (27 с на 41
// папке), и в логе об этом не было НИ СЛОВА — искать приходилось наугад.
function ghLogScan(gsl, where) {
    const s = gsl.scanStats && gsl.scanStats();
    if (!s) return;
    logLine(`${where}: скан профилей ${s.ms}мс (из индекса ${s.fromIndex}, расшифровано ${s.decrypted}, с GitHub ${s.withGithub}/${s.profiles})`
        + (s.warmError ? ` ⚠️ DPAPI-батч упал: ${s.warmError}` : '')
        + (!s.warmError && s.warmFailed ? ` ⚠️ ключей не расшифровалось: ${s.warmFailed}` : ''));
}

// Пересобрать индекс профилей ОТДЕЛЬНЫМ процессом.
//
// Почему не в себе: расшифровка ключа профиля — это execFileSync('powershell'), синхронный
// вызов. Он блокирует событийный цикл, и на элевированном дашборде (restart-dashboard.bat
// поднимает его от администратора) однажды не вернулся совсем: :8200 слушал, соединения
// висли в CLOSE_WAIT, модалка «читаю профили…» стояла минутами, а в tasklist из обычной
// консоли ни node, ни powershell даже не видно. Теперь ждать нечего: скрипт пишет JSON,
// дашборд его читает.
let ghIndexBuild = { pid: null, startedAt: 0, lastOut: '' };

function ghIndexBuilding() {
    return !!(ghIndexBuild.pid && ghAnyPidAlive(ghIndexBuild.pid));
}

function ghRebuildIndex(reason) {
    if (ghIndexBuilding()) return { already: true, pid: ghIndexBuild.pid };
    const script = path.join(__dirname, 'gh-index-build.js');
    try {
        const proc = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        ghIndexBuild = { pid: proc.pid, startedAt: Date.now(), lastOut: '' };
        proc.stdout.on('data', d => { ghIndexBuild.lastOut = String(d).trim(); logLine(`gh-index [${reason}]: ${String(d).trim()}`); });
        proc.stderr.on('data', d => logLine(`gh-index ERR [${reason}]: ${String(d).trim()}`));
        proc.on('error', e => { logLine(`gh-index спавн не удался: ${e.message}`); ghIndexBuild.pid = null; });
        proc.on('exit', (code) => {
            logLine(`gh-index [${reason}]: готов за ${Date.now() - ghIndexBuild.startedAt}мс (код ${code})`);
            ghIndexBuild.pid = null;
        });
        proc.unref();
        logLine(`gh-index [${reason}]: собираю индекс профилей (pid ${proc.pid})`);
        return { started: true, pid: proc.pid };
    } catch (e) {
        logLine(`gh-index спавн не удался: ${e.message}`);
        return { error: e.message };
    }
}

// Индекс собираем при старте — чтобы к первому открытию модалки он уже лежал на диске.
function ghWarmIndexOnBoot() {
    setTimeout(() => {
        const gsl = ghSessionLib();
        if (!gsl) return;
        const info = gsl.indexInfo();
        const outdated = gsl.indexOutdatedDirs().length;   // только stat, без расшифровки
        if (!info.exists || outdated) ghRebuildIndex('старт');
        else logLine(`gh-index: индекс на месте (${info.count} профилей, всё свежее)`);
    }, 1500);   // не мешаем подъёму портов и первым health-чекам
}

// Что известно про GitHub-аккаунты применительно к одному хосту: где уже засвечены,
// есть ли снимок для заселения и откуда его брать. Сети не касается вообще.
function ghSessionUsage(host) {
    const gsl = ghSessionLib();
    if (!gsl) throw new Error('модуль github-session недоступен');
    const tag = gsl.hostToTag(host);
    if (!tag) throw new Error(`неизвестный хост: ${host}`);
    const index = gsl.indexByLogin();
    return { gsl, tag, index };
}

// Есть ли в пуле провайдера ЖИВАЯ запись под этим ником. Это прямое доказательство
// занятости, в отличие от куки в профиле: пул — то, что мы сами про себя знаем.
// Сверяем и по `ghId` (его пишет заселение), и по `email`/`name` — руками добавленные
// записи ghId не имеют. Разница принципиальна для UI: запись есть → регистрировать
// нечего, надо активировать существующую; записи нет, а профиль на диске лежит →
// вероятно занято, но владелец может знать лучше (регистрация тогда могла не пройти).
const GH_POOL_LOADERS = { ar: () => arLoad(), go: () => goLoad(), tb: () => tbLoad(), xp: () => xpLoad() };
function ghPoolEntryFor(tag, nick, ghId) {
    const load = GH_POOL_LOADERS[tag];
    if (!load) return null;
    const low = String(nick || '').toLowerCase();
    try {
        return load().find(s => (ghId && s.ghId === ghId)
            || String(s.email || '').toLowerCase() === low
            || String(s.name || '').toLowerCase() === low) || null;
    } catch { return null; }
}

// GET /__switch/api/gh/available?host=<host>
//
// Отвечает МГНОВЕННО: читает только готовый индекс с диска. Ни DPAPI, ни sqlite, ни сети.
// Сеть не трогаем ещё и потому, что живость сессии безопасно проверить можно лишь настоящим
// браузером (см. lib/github-session.js — сырая проба с выдуманным UA гасит сессию на стороне
// GitHub); вердикт выносит харвест в момент заселения.
//
// Индекса нет или он устарел → запускаем сборку отдельным процессом и говорим фронту
// building:true. Раньше сборка шла прямо здесь и вешала весь дашборд.
async function handleGhAvailable(req, res) {
    try {
        const host = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('host') || '';
        const { gsl, tag, index } = ghSessionUsage(host);

        const info = gsl.indexInfo();
        const outdated = gsl.indexOutdatedDirs().length;   // только stat по файлам кук
        let building = ghIndexBuilding();
        if ((!info.exists || outdated) && !building) {
            ghRebuildIndex(info.exists ? 'устарел' : 'нет индекса');
            building = true;
        }
        if (!info.exists) {
            // Совсем ничего нет — показывать нечего, но и висеть не будем.
            return jsonRes(res, 200, {
                ok: true, host, tag, accounts: [], building: true, indexed: 0,
                note: 'строю индекс профилей — обнови через пару секунд',
            });
        }

        const accounts = ghLoad().map(g => {
            const nick = String(g.nickname || g.login || '').trim();
            const entry = index.get(nick.toLowerCase());
            const sources = (entry ? entry.sources : []).filter(s => s.hasUserSession);
            const free = sources.filter(s => !ghProfileBusy(s));
            const cached = gsl.readCache(g.id);
            // Профили на ЭТОМ хосте, где найдена кука этого ника. Архивные (`_old_*`)
            // в `hosts` не попадают, но перечислить их полезно: по ним видно, что аккаунт
            // тут когда-то был, и понятно, почему предупреждение вообще появилось.
            const hereProfiles = (entry ? entry.sources : []).filter(s => s.tag === tag);
            const poolEntry = ghPoolEntryFor(tag, nick, g.id);
            return {
                id: g.id,
                nickname: nick,
                login: g.login || '',
                status: g.status || 'live',
                usedOn: entry ? [...entry.hosts] : [],
                usedHere: !!(entry && entry.hosts.has(tag)),
                // Запись в пуле — прямое доказательство занятости, кука в профиле лишь косвенное.
                inPool: !!poolEntry,
                poolStatus: poolEntry ? (poolEntry.status || 'unknown') : null,
                hereProfiles: hereProfiles.map(s => ({ label: s.label, archived: !!s.archived })),
                hasSession: !!(cached || sources.length),
                cached: !!cached,
                cacheStale: cached ? gsl.cacheStale(cached) : null,
                sessionFrom: sources.length ? `${sources[0].tag}/${sources[0].label}` : null,
                sessionAgeDays: sources.length
                    ? Math.round(gsl.freshnessMs(sources[0]) / 86400000) : null,
                allSourcesBusy: sources.length > 0 && free.length === 0,
            };
        });
        jsonRes(res, 200, {
            ok: true, host, tag, accounts,
            profilesScanned: index.size, indexed: info.count,
            indexAgeMs: info.ageMs, building, outdated,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Снять снимок GitHub-сессии в кеш github/sessions/<ghId>.json.
// Харвест сам проверяет живость настоящим браузером: код 3 = сессия мертва.
function ghHarvest(gsl, ghId, profile) {
    const out = gsl.cachePath(ghId);
    return new Promise(resolve => {
        const proc = spawn(process.execPath, [gsl.HARVEST_SCRIPT, profile.dir, out],
            { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', d => so += String(d));
        proc.stderr.on('data', d => se += String(d));
        proc.on('error', e => resolve({ code: 1, err: e.message }));
        proc.on('exit', code => resolve({ code, out: so, err: se }));
        // Запуск браузера + навигация: 30 с мало, минута с запасом.
        setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
    });
}

// POST /__switch/api/{ar,go,tb,xp}/add-github { ghId }
//
// Создаёт запись пула под готовым GitHub-аккаунтом и заселяет её профиль. Браузер здесь
// НЕ открываем: дашборд следом зовёт существующий /session/open, дублировать spawn незачем.
async function newapiAddGithub(req, res, { tag, host, prefix, load, save, sessionsDir }) {
    // Харвест — это запуск Chromium, десятки секунд молчания в сокете.
    const stopKeepalive = jsonKeepalive(res);
    try {
        const body = await readJsonBody(req);
        const ghId = String(body.ghId || '').trim();
        if (!ghId) return jsonRes(res, 400, { error: 'ghId обязателен' });
        // force — владелец видел предупреждение «этот GitHub тут уже засвечен» и настаивает.
        // Легитимных причин настаивать хватает: регистрация у провайдера была закрыта и
        // аккаунт не создался; аккаунт был удалён на стороне провайдера; запись из пула
        // снесли, а профиль на диске остался. Запрет без обхода загонял в тупик — ник
        // числился занятым навсегда, потому что кука в профиле никуда не девается.
        const force = !!body.force;

        const acct = ghLoad().find(g => g.id === ghId);
        if (!acct) return jsonRes(res, 404, { error: 'GitHub-аккаунт не найден в хранилище' });
        const nick = String(acct.nickname || acct.login || '').trim();
        if (!nick) return jsonRes(res, 400, { error: 'у GitHub-аккаунта нет ника' });
        if (acct.status === 'dead') {
            return jsonRes(res, 400, { error: `GitHub ${nick} помечен как dead — регистрировать под ним нечего` });
        }

        const { gsl, tag: hostTag, index } = ghSessionUsage(host);
        // Два уровня «занято», и путать их нельзя. Запись в пуле — факт: аккаунт у нас
        // уже есть, дубль не нужен, и обойти это force'ом бессмысленно (ниже всё равно
        // упрёмся в проверку дубля email). Кука в профиле — лишь косвенный признак.
        const poolEntry = ghPoolEntryFor(hostTag, nick, ghId);
        if (poolEntry) {
            return jsonRes(res, 409, {
                error: `под ${nick} запись в пуле уже есть (${poolEntry.status || 'unknown'})`
                    + ' — заводить вторую нечего: открой её кнопкой 🌐 и войди, а если аккаунт'
                    + ' у провайдера удалён, сначала удали запись из пула',
            });
        }
        if (gsl.usedOnHost(index, nick, hostTag) && !force) {
            const where = (index.get(nick.toLowerCase()) || { sources: [] }).sources
                .filter(s => s.tag === hostTag).map(s => s.label).join(', ');
            return jsonRes(res, 409, {
                canForce: true,
                error: `под ${nick} на этом хосте остался профиль браузера${where ? ` (${where})` : ''},`
                    + ' то есть аккаунт тут скорее всего уже создан — тогда вход откроет его,'
                    + ' а не заведёт новый. Если аккаунта нет (регистрация была закрыта, аккаунт'
                    + ' удалён) — повтори с подтверждением.',
            });
        }

        // Снимок: сначала кеш, иначе харвест из самого подходящего профиля-источника.
        let snap = gsl.readCache(ghId);
        let from = snap ? 'кеш' : null;
        if (snap && gsl.cacheStale(snap)) { snap = null; from = null; }   // старше TTL — перечитать
        if (!snap) {
            const entry = index.get(nick.toLowerCase());
            const sources = (entry ? entry.sources : []).filter(s => s.hasUserSession);
            if (!sources.length) {
                return jsonRes(res, 409, {
                    error: `живой GitHub-сессии для ${nick} на диске нет — открой его один раз во вкладке GitHub («Открыть GitHub») и залогинься`,
                });
            }
            const free = sources.filter(s => !ghProfileBusy(s));
            if (!free.length) {
                return jsonRes(res, 409, {
                    error: `все профили с сессией ${nick} заняты открытым браузером — закрой его и повтори`,
                });
            }
            // Пробуем по очереди: сессия в конкретном профиле может быть уже мёртвой,
            // а у того же аккаунта рядом лежит живая (профили логинились раздельно).
            const tried = [];
            for (const src of free) {
                const r = await ghHarvest(gsl, ghId, src);
                if (r.code === 0) { snap = gsl.readCache(ghId); from = `${src.tag}/${src.label}`; break; }
                tried.push(`${src.tag}/${src.label}: ${r.code === 3 ? 'сессия мертва' : r.code === 2 ? 'профиль занят' : (r.err || 'ошибка').trim().slice(0, 120)}`);
            }
            if (!snap) {
                logLine(`${tag} add-github: ${nick} — снимок не снялся (${tried.join(' | ')})`);
                return jsonRes(res, 409, {
                    error: `GitHub-сессия ${nick} не годится: ${tried.join('; ')}. Залогинься заново во вкладке GitHub.`,
                });
            }
        }

        // Запись пула. email = ник GitHub осознанно: резервная ветка сопоставления
        // профилей (newapiMapProfiles) сверяет `s.email || s.name` с githubLogin(cookies),
        // то есть с кукой dotcom_user — а это и есть ник. Связка заработает сама.
        const sessions = load();
        const dup = sessions.find(s => String(s.email || '').toLowerCase() === nick.toLowerCase());
        if (dup) return jsonRes(res, 409, { error: `запись с email ${nick} уже есть в пуле` });

        const id = prefix + Date.now() + '_' + sessions.length;
        const label = 'acct_' + id;
        sessions.push({
            id,
            email: nick,
            name: nick,
            api_key: makeNoKeyStub(),
            active: false,
            status: 'no_key',
            created: new Date().toISOString(),
            ghId,
            seededFrom: from,
        });
        save(sessions);

        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(path.join(sessionsDir, label + '.json'),
            JSON.stringify(gsl.seedPayload(snap, nick), null, 2) + '\n', 'utf8');

        logLine(`${tag} add-github: ${nick} → ${label} (сессия из ${from}, кук ${(snap.cookies || []).length}${force ? ', ПОВЕРХ предупреждения о засвете' : ''})`);
        jsonRes(res, 200, { ok: true, id, label, ghLogin: nick, from, cookieCount: (snap.cookies || []).length, forced: force });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

function handleArAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'agentrouter', host: 'agentrouter.org', prefix: 'ar_', load: arLoad, save: arSave, sessionsDir: AR_SESSIONS_DIR });
}
function handleGoAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'gorouter', host: 'gorouter.app', prefix: 'go_', load: goLoad, save: goSave, sessionsDir: GO_SESSIONS_DIR });
}
function handleTbAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'tabi', host: 'tabitoken.com', prefix: 'tb_', load: tbLoad, save: tbSave, sessionsDir: TB_SESSIONS_DIR });
}
function handleXpAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'xpeach', host: 'xpeach.codes', prefix: 'xp_', load: xpLoad, save: xpSave, sessionsDir: XP_SESSIONS_DIR });
}

// ───── Svrtr — пул ТГ-аккаунтов, активация через API Helper ─────
// api.svrtr.org — Anthropic-совместимый endpoint (x-api-key). Авторег через @svrtrbot.
// Активация = ключ в sr-active-key.txt + apiKeyHelper в settings.json.
const SR_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'sr-active-key.txt');
const SR_BASE_URL = 'https://api.svrtr.org';
const SR_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

async function handleSvrtrSessions(req, res) {
    try {
        const refresh = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('refresh') === '1';
        const sessions = await dashApi.listSvrtrSessions({ withQuotas: refresh ? 'refresh' : 'cache' });
        jsonRes(res, 200, { sessions, activeKey: dashApi.getActiveSvrtrKey() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleSvrtrRefreshQuota(req, res) {
    try {
        const { name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const quota = await dashApi.refreshOneSvrtrQuota(name);
        logLine(`svrtr refresh quota: ${name}`);
        jsonRes(res, 200, { ok: true, name, quota });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleSvrtrActiveKey(req, res) {
    const key = dashApi.getActiveSvrtrKey();
    jsonRes(res, 200, { key: key || null, mask: key ? key.slice(0, 12) + '…' + key.slice(-4) : null });
}

async function handleSvrtrActivate(req, res) {
    try {
        const { name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const extract = await dashApi.extractSvrtrApiKey(name);
        if (!extract.ok || !extract.apiKey) return jsonRes(res, 400, { error: extract.error || 'ключ не найден' });
        const key = extract.apiKey;

        fs.writeFileSync(SR_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        dashApi.setSvrtrApiKey(name, key);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-sr');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = SR_BASE_URL;
            settings.apiKeyHelper = keyHelperCmd('sr-active-key.txt');
            delete settings.model;
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`svrtr activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`svrtr activate: ${name} → ***${key.slice(-6)} (helper)`);
        jsonRes(res, 200, { ok: true, name, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleSvrtrAdd(req, res) {
    try {
        const { apiKey, username, tgPhone } = await readJsonBody(req);
        const key = String(apiKey || '').trim();
        if (!key || !/^sk-sr-/.test(key)) return jsonRes(res, 400, { error: 'apiKey обязателен и должен начинаться с sk-sr-' });
        const result = dashApi.addSvrtrKey({ apiKey: key, username: String(username || '').trim() || null, tgPhone: String(tgPhone || '').trim() || null });
        logLine(`svrtr add: ${result.ident} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, ...result });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleSvrtrAutoreg(req, res) {
    try {
        const body = await readJsonBody(req).catch(() => ({}));
        const count = Math.max(1, Math.min(50, parseInt(body.count, 10) || 1));
        const result = dashApi.launchScript('svrtr-create', [String(count)]);
        logLine(`svrtr autoreg launched: count=${count}`);
        jsonRes(res, 200, { ok: true, ...result });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleSvrtrModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (SR_MODELS_CACHE.data && Date.now() - SR_MODELS_CACHE.ts < SR_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: SR_MODELS_CACHE.data, cached: true });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(SR_BASE_URL + '/v1/models', {
            signal: controller.signal,
            headers: { 'x-api-key': api_key, 'Authorization': `Bearer ${api_key}` }
        });
        clearTimeout(timeout);

        const rawText = await resp.text();
        const textClean = rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText;
        logLine(`svrtr models: HTTP ${resp.status}, len=${textClean.length}, body=${textClean.slice(0, 200).replace(/\n/g, '\\n')}`);

        if (!resp.ok) return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}: ${textClean.slice(0, 120)}` });

        let data;
        try { data = JSON.parse(textClean); } catch (e) {
            return jsonRes(res, 200, { ok: true, models: [], note: `JSON parse error: ${e.message}` });
        }
        const list = Array.isArray(data) ? data : (data.data || data.models || []);
        const models = list.map(m => ({ id: m.id, owned_by: m.owned_by }));
        SR_MODELS_CACHE.data = models;
        SR_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (SR_MODELS_CACHE.data) {
            jsonRes(res, 200, { ok: true, models: SR_MODELS_CACHE.data, cached: true, note: e.message });
        } else {
            jsonRes(res, 200, { ok: true, models: [], note: e.message });
        }
    }
}

// ───── HelpCoder — New-API инстанс, авторег username+password, активация через API Helper ─────
// helpcoder.cc — OpenAI-совместимый endpoint (Bearer sk-...). Авторег чистым HTTP.
// Активация = записать ключ в hc-active-key.txt + apiKeyHelper в settings.json.
const HC_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'hc-active-key.txt');
const HC_BASE_URL = 'https://helpcoder.cc';
const HC_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

async function handleHelpcoderSessions(req, res) {
    try {
        const refresh = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('refresh') === '1';
        const sessions = await dashApi.listHelpcoderSessions({ withQuotas: refresh ? 'refresh' : 'cache' });
        jsonRes(res, 200, { sessions, activeKey: dashApi.getActiveHelpcoderKey() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleHelpcoderRefreshQuota(req, res) {
    try {
        const { name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const quota = await dashApi.refreshOneHelpcoderQuota(name);
        logLine(`helpcoder refresh quota: ${name}`);
        jsonRes(res, 200, { ok: true, name, quota });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleHelpcoderActiveKey(req, res) {
    const key = dashApi.getActiveHelpcoderKey();
    jsonRes(res, 200, { key: key || null, mask: key ? key.slice(0, 12) + '…' + key.slice(-4) : null });
}

async function handleHelpcoderActivate(req, res) {
    try {
        const { name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const extract = await dashApi.extractHelpcoderApiKey(name);
        if (!extract.ok || !extract.apiKey) return jsonRes(res, 400, { error: extract.error || 'ключ не найден' });
        const key = extract.apiKey;

        fs.writeFileSync(HC_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        dashApi.setHelpcoderApiKey(name, key);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-hc');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = HC_BASE_URL;
            settings.apiKeyHelper = keyHelperCmd('hc-active-key.txt');
            delete settings.model;
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`helpcoder activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`helpcoder activate: ${name} → ***${key.slice(-6)} (helper)`);
        jsonRes(res, 200, { ok: true, name, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleHelpcoderAdd(req, res) {
    try {
        const { apiKey, username } = await readJsonBody(req);
        const key = String(apiKey || '').trim();
        if (!key || !/^sk-/.test(key)) return jsonRes(res, 400, { error: 'apiKey обязателен и должен начинаться с sk-' });
        const result = dashApi.addHelpcoderKey({ apiKey: key, username: String(username || '').trim() || null });
        logLine(`helpcoder add: ${result.ident} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, ...result });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleHelpcoderAutoreg(req, res) {
    try {
        const body = await readJsonBody(req).catch(() => ({}));
        const count = Math.max(1, Math.min(50, parseInt(body.count, 10) || 1));
        const result = dashApi.launchScript('helpcoder-create', [String(count)]);
        logLine(`helpcoder autoreg launched: count=${count}`);
        jsonRes(res, 200, { ok: true, ...result });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleHelpcoderModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (HC_MODELS_CACHE.data && Date.now() - HC_MODELS_CACHE.ts < HC_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: HC_MODELS_CACHE.data, cached: true });
        }

        const hcApi = require('../helpcoder/lib/helpcoder-api');
        const r = await hcApi.getModels(api_key);

        if (!r.ok) return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${r.status}: ${(r.text || '').slice(0, 120)}` });

        const list = Array.isArray(r.json) ? r.json : (r.json.data || r.json.models || []);
        const models = list.map(m => ({ id: m.id, owned_by: m.owned_by }));
        HC_MODELS_CACHE.data = models;
        HC_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (HC_MODELS_CACHE.data) {
            jsonRes(res, 200, { ok: true, models: HC_MODELS_CACHE.data, cached: true, note: e.message });
        } else {
            jsonRes(res, 200, { ok: true, models: [], note: e.message });
        }
    }
}

// ───── Conduit (cdt) — пул ТГ-аккаунтов, активация через API Helper ─────
// conduit.ozdoev.net — Anthropic-совместимый endpoint. Квоты/баланс читает
// dashApi.listConduitSessions (cookie-fetch, не Playwright). Активация = записать
// ключ в cdt-active-key.txt + apiKeyHelper в settings.json (как Aerolink/FreeModel).
const CDT_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'cdt-active-key.txt');
const CDT_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'cdt-active-model.txt');
const CDT_BASE_URL = 'https://conduit.ozdoev.net/v1';
const CDT_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

function cdtReadActiveModel() {
    try { return fs.readFileSync(CDT_ACTIVE_MODEL_FILE, 'utf-8').trim(); } catch { return ''; }
}

async function handleConduitSessions(req, res) {
    try {
        const refresh = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('refresh') === '1';
        const sessions = await dashApi.listConduitSessions({ withQuotas: refresh ? 'refresh' : 'cache' });
        jsonRes(res, 200, { sessions, activeKey: dashApi.getActiveConduitKey() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleConduitRefreshQuota(req, res) {
    try {
        const { name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const quota = await dashApi.refreshOneConduitQuota(name);
        logLine(`conduit refresh quota: ${name}`);
        jsonRes(res, 200, { ok: true, name, quota });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleConduitActiveKey(req, res) {
    const key = dashApi.getActiveConduitKey();
    jsonRes(res, 200, { key: key || null, mask: key ? key.slice(0, 10) + '…' + key.slice(-4) : null });
}

// Клик по аккаунту → активный: достаём ключ (из меты/account_info/api), пишем в
// cdt-active-key.txt + apiKeyHelper в settings.json.
async function handleConduitActivate(req, res) {
    try {
        const { name } = await readJsonBody(req);
        if (!name) return jsonRes(res, 400, { error: 'name обязателен' });
        const extract = await dashApi.extractConduitApiKey(name);
        if (!extract.ok || !extract.apiKey) return jsonRes(res, 400, { error: extract.error || 'ключ не найден' });
        const key = extract.apiKey;

        fs.writeFileSync(CDT_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        dashApi.setConduitApiKey(name, key);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-cdt');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = CDT_BASE_URL;
            settings.apiKeyHelper = keyHelperCmd('cdt-active-key.txt');
            // Была залипшая чужая model (ComboWombo от OmniRoute) → её сносим, но если
            // у conduit выбрана своя (cdt-active-model.txt) — ставим её: delete = дефолт
            // Claude Code без [1m] = окно 200k. Суффикс дотянет writeSettings().
            const cdtCurModel = cdtReadActiveModel() || '';
            if (cdtCurModel) settings.model = cdtCurModel;
            else delete settings.model;
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            delete settings.env.ANTHROPIC_API_KEY;   // helper рулит авторизацией
            clearOtEnv(settings);    // убрать ourtoken AUTH_TOKEN/маппинги
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`conduit activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`conduit activate: ${name} → ***${key.slice(-6)} (helper)`);
        jsonRes(res, 200, { ok: true, name, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleConduitAdd(req, res) {
    try {
        const { apiKey, username, tgPhone } = await readJsonBody(req);
        const key = String(apiKey || '').trim();
        if (!key || !/^sk-cdt-/.test(key)) return jsonRes(res, 400, { error: 'apiKey обязателен и должен начинаться с sk-cdt-' });
        const result = dashApi.addConduitKey({ apiKey: key, username: String(username || '').trim() || null, tgPhone: String(tgPhone || '').trim() || null });
        logLine(`conduit add: ${result.ident} (***${key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, ...result });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleConduitAutoreg(req, res) {
    try {
        const body = await readJsonBody(req).catch(() => ({}));
        const count = Math.max(1, Math.min(50, parseInt(body.count, 10) || 1));
        const args = [String(count)];
        if (body.ref && /^ref_[A-Za-z0-9]+$/.test(String(body.ref))) args.push(String(body.ref));
        const result = dashApi.launchScript('conduit-create', args);
        logLine(`conduit autoreg launched: count=${count}${body.ref ? ' ref=' + body.ref : ''}`);
        jsonRes(res, 200, { ok: true, ...result });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ---- AnyModel handlers ----
function handleAmodelAccounts(res) {
    try {
        const accounts = dashApi.listAmodelAccounts();
        jsonRes(res, 200, { ok: true, accounts });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сколько ТГ из общего пула ещё доступно именно AnyModel.
function handleAmodelTgStats(res) {
    try {
        jsonRes(res, 200, { ok: true, ...require('../anymodel/lib/tg-usage').stats() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleAmodelLaunch(req, res) {
    try {
        const body = await readJsonBody(req).catch(() => ({}));
        const count = Math.max(1, Math.min(20, parseInt(body.count, 10) || 1));
        const result = dashApi.launchAmodelAutoreger(count);
        logLine(`anymodel autoreg launched: count=${count}`);
        jsonRes(res, 200, { ok: true, ...result });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleConduitModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (CDT_MODELS_CACHE.data && Date.now() - CDT_MODELS_CACHE.ts < CDT_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: CDT_MODELS_CACHE.data, cached: true });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(CDT_BASE_URL + '/models', {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${api_key}` }
        });
        clearTimeout(timeout);

        const rawText = await resp.text();
        const text = rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText;
        logLine(`conduit models: HTTP ${resp.status}, len=${text.length}, body=${text.slice(0, 150).replace(/\n/g, '\\n')}`);
        if (!resp.ok) {
            return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}: ${text.slice(0, 120)}` });
        }
        let data;
        try { data = JSON.parse(text); } catch (parseErr) {
            logLine(`conduit models JSON.parse FAILED: ${parseErr.message}, body[0..60]=${text.slice(0, 60)}`);
            return jsonRes(res, 200, { ok: true, models: [], note: 'non-JSON: ' + text.slice(0, 120) });
        }
        const models = (data.data || []).map(m => ({
            id: m.id,
            owned_by: m.owned_by,
            supported_endpoint_types: m.supported_endpoint_types || [],
        }));
        CDT_MODELS_CACHE.data = models;
        CDT_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (CDT_MODELS_CACHE.data) {
            jsonRes(res, 200, { ok: true, models: CDT_MODELS_CACHE.data, cached: true, note: e.message });
        } else {
            jsonRes(res, 200, { ok: true, models: [], note: e.message });
        }
    }
}

// Выбор модели Conduit с дашборда: пишет cdt-active-model.txt + settings.json model.
async function handleConduitSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        let m = body.model != null ? String(body.model).trim() : '';
        if (!m || body.fromFile) m = cdtReadActiveModel() || m;
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });

        fs.writeFileSync(CDT_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-cdt-model');
            settings.model = m;
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`conduit set-model: settings.json FAILED: ${e.message}`);
        }
        logLine(`conduit set-model: ${m}`);
        jsonRes(res, 200, { ok: true, model: m, settingsUpdated: settingsOk, modelFile: CDT_ACTIVE_MODEL_FILE });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Аккаунт без ключа (AgentRouter / GoRouter / Tabi) ─────────────────────
// У всех трёх регистрация ручная через GitHub, и ключ появляется ТОЛЬКО после неё.
// Поэтому аккаунт можно создать заранее (email известен, ключа нет): вместо ключа
// пишем уникальную заглушку `no-key-…`. Уникальность обязательна — api_key служит
// идентификатором в кликах активации/баланса, а `add` отбивает дубли по нему.
// Настоящий ключ у всех трёх (NewAPI) — 'sk-' + 48 символов.
// Заглушка → статус 'no_key', 🌐 ведёт на регистрацию по рефке, а не в консоль.
function isRealKey(k) { return /^sk-/.test(String(k || '').trim()); }
function makeNoKeyStub() {
    return 'no-key-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ───── AgentRouter (ar) — ручной пул ключей (agentrouter.org), активация через API Helper ─────
// Дроп-ин для Claude Code: ANTHROPIC_BASE_URL=https://agentrouter.org (БЕЗ /v1), ключ sk-….
// WAF отбивает запросы, которые не выглядят как Claude Code: все probe/models обязаны
// нести CC-заголовки (user-agent claude-cli/, anthropic-version/beta, x-app). cs
const AR_SESSIONS_FILE = path.join(__dirname, 'agentrouter-sessions.json');
const AR_MODELMAP_FILE = path.join(__dirname, 'ar-modelmap.json');
const AR_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'ar-active-key.txt');
const AR_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'ar-active-model.txt');
const AR_BASE_URL = 'https://agentrouter.org';
// Баланс ключа берётся точно из /api/user/self (см. newapiBalance). Константы ниже —
// только для последнего резерва «угадать грант», когда у аккаунта нет ни куки, ни
// вписанного вручную баланса.
const AR_GRANT_STEP = 25;
const AR_DEFAULT_GRANT = 175;
// Чек-ин +$25 раз в сутки: настройки границы лежат в отдельном файле, читаются по
// запросу (правка применяется без рестарта прокси, как ar-modelmap.json).
// Порог детекта ниже 25: сравниваем цифры, снятые в разные моменты, и между ними
// мог утечь расход — точное равенство здесь недостижимо.
const AR_CHECKIN_FILE = path.join(__dirname, 'ar-checkin.json');
const AR_CHECKIN_MIN_USD = 20;
// Сколько браузеров чек-ина разрешено держать открытыми одновременно (см. предохранитель
// в handleArSessionOpen): залп по всему пулу ловит рейт-лимит шлюза.
const AR_CHECKIN_MAX_BROWSERS = 3;
const AR_CHECKIN_DEFAULTS = { resetHhmmMsk: '20:30', bonusUsd: 25 };
const AR_PROXY_PORT = 20132;
const AR_PROXY_URL = `http://localhost:${AR_PROXY_PORT}`;
// SSE keepalive proxy (friend's sse-keepalive-proxy, v1tusha) — стоит перед
// agentrouter.org для claude-* моделей: шлюз не шлёт `event: ping` во время
// длинных thinking-пауз, watchdog Claude Code (~20с без байт) рвёт поток и
// ретраит до бесконечности. Прокси вставляет `: keepalive` и ретраит 401/403/429/5xx.
const AR_KEEPALIVE_PORT = 20133;
const AR_KEEPALIVE_URL = `http://localhost:${AR_KEEPALIVE_PORT}`;
const KEEPALIVE_PROXY_FILE = 'keepalive-proxy.js';

// Ранний литерал в BACKENDS (~строка 100) обязан совпадать с каноническим URL:
// падаем на старте, а не молча уводим трафик на мёртвый порт.
if (AR_KEEPALIVE_URL_EARLY !== AR_KEEPALIVE_URL) {
    throw new Error(`AR keepalive URL расходится: BACKENDS=${AR_KEEPALIVE_URL_EARLY} vs ${AR_KEEPALIVE_URL}`);
}

// ????????? agentrouter-proxy.js (:) ???? ???? ???????? ? ???????? ??? Claude Code:
// claude-* ? pass-through ? agentrouter /v1/messages, gpt-* ? ??????????? ? OpenAI /v1/chat/completions.
async function arProxySpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(AR_PROXY_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, 'agentrouter-proxy.js')], {
            detached: true, stdio: 'ignore', env: process.env,
        });
        child.unref();
        logLine(`agentrouter proxy spawn: :${AR_PROXY_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`agentrouter proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// SSE keepalive proxy: копия sse-keepalive-proxy (v1tusha). Слушает :20133 и
// форвардит всё в agentrouter.org, вставляя `: keepalive` при тишине > IDLE_MS
// и ретраи 401/403/429/5xx. Спавнится как и agentrouter-proxy, только для полного
// pass-through agentrouter-моделей (claude-*).
// Front-door :20100 — единый вход Claude Code. Спавним на boot ВСЕГДА, даже с
// выключенным тумблером: включение режима не должно требовать рестарта дашборда,
// а лежащий прокси = мгновенная потеря всех сессий CC после флипа.
const FRONTDOOR_PROXY_FILE = 'frontdoor-proxy.js';
async function frontdoorSpawn() {
    const port = frontdoorPort();
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(port, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, FRONTDOOR_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(port),
                LOG_FILE: path.join(__dirname, 'frontdoor-proxy.log'),
            },
        });
        child.unref();
        logLine(`front-door spawn: :${port} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`front-door spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

async function arKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(AR_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(AR_KEEPALIVE_PORT),
                // Литерал '10000' тут был четвёртой копией дефолта пре-коммита: смени
                // его в keepalive-proxy.js — и спавн из дашборда всё равно навязал бы
                // старое число. Переменную ставим ТОЛЬКО если её задали снаружи.
                ...(process.env.AR_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.AR_PRE_COMMIT_MS } : {}),
            },
        });
        child.unref();
        logLine(`keepalive proxy spawn: :${AR_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

const AR_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };
const AR_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function arLoad() {
    try {
        const raw = fs.readFileSync(AR_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        // Разовый перенос ручных grantManual/bonus/referral в анкер (см. newapiMigrateAnchors).
        if (newapiMigrateAnchors(arr)) { try { arSave(arr); } catch {} }
        return arr;
    } catch { return []; }
}
function arSave(arr) {
    fs.writeFileSync(AR_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

// Мерж-запись для обновлений баланса/статуса. Раньше каждый хендлер делал
// arLoad() → правка → arSave(ВЕСЬ файл). Пока «💳 Балансы всех» идёт ~10 секунд,
// параллельный пойк от статусбара перезаписывал файл снимком, снятым ДО батча —
// свежие цифры терялись, и в баре баланс откатывался назад. Здесь перечитываем
// диск и накладываем только переданные объекты по api_key.
// ВНИМАНИЕ: Object.assign не удаляет поля — для удаления ключей/полей
// (delete, сброс анкера) по-прежнему нужен arSave() целиком.
// Исключение — список ниже: это метки, которые успешный чек СНИМАЕТ. Без явного
// удаления однажды записанный balanceError выживал на диске и гейдж вечно показывал
// «⚠ ошибка чека» при живом ключе и свежем балансе.
const BALANCE_CLEARABLE = ['balanceError', 'selfError', 'granted'];
function arSaveMerge(changed) {
    const list = Array.isArray(changed) ? changed : [changed];
    const disk = arLoad();
    const byKey = new Map(disk.map(s => [s.api_key, s]));
    for (const upd of list) {
        if (!upd || !upd.api_key) continue;
        const cur = byKey.get(upd.api_key);
        if (cur) {
            Object.assign(cur, upd);
            for (const k of BALANCE_CLEARABLE) if (!(k in upd)) delete cur[k];
        }
        else disk.push(upd);
    }
    arSave(disk);
}
function arReadActiveModel() {
    try { return fs.readFileSync(AR_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// Пинг ключа: GET /v1/models с CC-заголовками → 200 = LIVE, 401/403 = DEAD.
async function arProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';   // заглушка вместо ключа — пинговать нечего
    try {
        const r = await fetch(`${AR_BASE_URL}/v1/models`, {
            method: 'GET',
            headers: { ...AR_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// ─────────── Точный баланс аккаунта New-API: общее для AgentRouter/GoRouter/Tabi ───────────
//
// Все три — инстансы New-API, и раньше у каждого была своя копия расчёта «угадать
// грант и вычесть потраченное». Угадывание врало: пользователь подгонял грант руками
// под цифру из ЛК, подгонка разъезжалась с первой же тратой и в UI висели минусы.
//
// Порядок источников (первый сработавший побеждает):
//   1. self   — GET /api/user/self куками профиля Chromium → ТОЧНЫЙ остаток аккаунта.
//   2. anchor — вписанный руками баланс, убывающий по расходу (для аккаунтов без куки).
//   3. guess  — старое угадывание по шагу гранта. Последний резерв, помечается как прикидка.
//
// usage-эндпоинт зовём ВСЕГДА, даже когда self сработал: он определяет живость
// КЛЮЧА (401/403 = ключ мёртв), а self говорит только про аккаунт. Для продажи
// ключа важно именно первое. Заодно даёт легаси-расход для анкера.
// Важно: total_usage — расход ТОКЕНА, не аккаунта (при пересоздании токена занижен),
// поэтому при успехе self расход берём из used_quota.
const NEWAPI_PROFILE_DIRS = {
    'agentrouter.org': path.join(__dirname, '..', 'agentrouter', 'profiles'),
    'gorouter.app':    path.join(__dirname, '..', 'gorouter', 'profiles'),
    'tabitoken.com':   path.join(__dirname, '..', 'tabi', 'profiles'),
    'xpeach.codes':    path.join(__dirname, '..', 'xpeach', 'profiles'),
};

function newapiLib() {
    try { return require('./lib/newapi-account'); }
    catch (e) { logLine(`newapi-account недоступен: ${e.message}`); return null; }
}

// Путь к профилю аккаунта. Метку профиля храним в записи пула (поле profile),
// её проставляет сопоставление (handle*MapProfiles).
function newapiProfileDir(host, profileLabel) {
    const base = NEWAPI_PROFILE_DIRS[host];
    if (!base || !profileLabel) return null;
    const dir = path.join(base, String(profileLabel).replace(/[\\/]/g, ''));
    try { return fs.existsSync(dir) ? dir : null; } catch { return null; }
}

// Профиль записи: сначала сопоставленная метка, потом ДЕТЕРМИНИРОВАННАЯ `acct_<id>`.
// Зачем второе: метку `profile` ставит только сопоставление (кнопка «🔗 Профили»), а
// саму папку профиля создаёт кнопка «🌐 ЛК» под именем 'acct_' + id ТОЙ ЖЕ записи
// (см. handle*SessionOpen). На свежей машине — обновился, залогинил все ЛК, про кнопку
// сопоставления не знает — точный баланс молча деградировал в «~ прикидку» с причиной
// «профиль не сопоставлен». Связка по id локальная, бесплатная и не может подцепить
// чужой аккаунт: имя папки выведено из id самой записи. Найденная метка сохраняется в
// запись при первом успешном чеке (profileUsed → newapiApplyBalance).
function newapiResolveProfile(host, target) {
    const mapped = newapiProfileDir(host, target && target.profile);
    if (mapped) return { dir: mapped, label: target.profile };
    const byId = target && target.id ? 'acct_' + target.id : null;
    const dir = byId ? newapiProfileDir(host, byId) : null;
    return dir ? { dir, label: byId, viaId: true } : { dir: null, label: null };
}

// Когда ЛК профиля последний раз открывали. Нужно кешу точного баланса: чек-ин и
// пополнение поднимают `quota`, НЕ меняя `used_quota`, поэтому «расход не сдвинулся»
// перестало быть признаком «остаток тот же». Поймано живьём на agentrouter: после
// чек-ина на +$25 дашборд ещё 15 минут показывал прежние $175 с бейджем «точный»,
// а сервер уже отдавал $200 — и вписанные вручную $200 этой же стряпнёй перебивались.
const NEWAPI_LK_OPENED = new Map();   // label → ts
function newapiLkVisited(label) {
    if (label) NEWAPI_LK_OPENED.set(String(label), Date.now());
}
function newapiLkOpenedAt(label) {
    return NEWAPI_LK_OPENED.get(String(label || '')) || 0;
}

// Открыт ли прямо сейчас браузер этого профиля. Профили заводит и открывает только
// *SessionOpen-хендлер, поэтому карты pid'ов — достоверный ответ; ключ карты и есть
// метка профиля (label = 'acct_' + id). Нужно перед записью в БД куки: Chromium
// держит куки в памяти и на выходе перезапишет файл своим состоянием.
function newapiLkBusy(profileLabel) {
    const label = String(profileLabel || '');
    if (!label) return false;
    for (const [pids, alive] of [[arLkPids, arPidAlive], [goLkPids, goPidAlive], [tbLkPids, tbPidAlive]]) {
        try { if (alive(pids.get(label))) return true; } catch {}
    }
    return false;
}

// Слить ротированные куки из jar в профиль Chromium. Зачем: refresh-кука на jwt-инстансах
// одноразовая — наш чек баланса её гасит и новое значение кладёт в jar, а профиль остаётся
// со старым. При ручном открытии ЛК браузер шёл refresh'ем по погашенной куке и получал
// разлогин (замерено: у 9 из 10 tabi-аккаунтов значения в профиле и в jar расходились).
// Зовём перед открытием ЛК и после успешного точного чека. Провал не критичен: jar всё
// равно остаётся источником правды для наших собственных запросов.
function newapiSyncProfile(host, profileLabel, why) {
    try {
        const lib = newapiLib();
        if (!lib || !lib.syncJarToProfile) return;
        const dir = newapiProfileDir(host, profileLabel);
        if (!dir) return;
        if (newapiLkBusy(profileLabel)) {
            logLine(`куки → профиль ${profileLabel}: пропуск, браузер открыт`);
            return;
        }
        const r = lib.syncJarToProfile(host, dir);
        if (r && r.written && r.written.length) {
            logLine(`куки → профиль ${profileLabel} (${why}): ${r.written.join(', ')}`);
        }
        if (r && r.skipped && r.skipped.length) {
            // Браузер ротировал куку позже нас — его версия живая, наша погашена.
            logLine(`куки → профиль ${profileLabel}: ${r.skipped.join(', ')} свежее в профиле, наши сняты из jar`);
        }
        if (r && !r.ok && !r.empty) {
            logLine(`куки → профиль ${profileLabel}: ${r.busy ? 'БД занята' : r.error}`);
        }
    } catch (e) { logLine(`куки → профиль ${profileLabel}: ${e.message}`); }
}

const round2 = v => Math.round(Number(v) * 100) / 100;

// Чистка легаси-полей старой схемы (grant/grantManual/bonus/referral). Анкер из них
// НЕ делаем: он был бы выведен из того же сломанного угадывания, а потом подставлялся
// бы вместо точной цифры каждый раз, когда self споткнулся о рейт-лимит — именно так
// Tabi показывала −$4.37 там, где в аккаунте лежало $6.63. Пусть лучше запись честно
// висит «~ прикидка» и просит вписать баланс. Анкер бывает только вписанный руками.
// Идемпотентно: после чистки полей повторно не сработает.
function newapiMigrateAnchors(sessions) {
    let changed = false;
    for (const s of sessions || []) {
        if (!s || typeof s !== 'object') continue;
        for (const k of ['grant', 'grantSource', 'grantManual']) if (k in s) { delete s[k]; changed = true; }
        for (const k of ['bonus', 'referral']) if (k in s) { delete s[k]; changed = true; }
        // Анкеры, созданные прошлой версией миграции, тоже убираем — они из угадывания.
        if (s.anchorFrom === 'migrated') {
            delete s.balanceAnchor; delete s.anchorSpent; delete s.anchoredAt; delete s.anchorFrom;
            changed = true;
        }
    }
    return changed;
}

// Общий расчёт. target — запись пула (нужен api_key; profile/anchor опциональны).
// guessGrant(spent) — легаси-угадывание провайдера, вызывается только как резерв.
// force — не переиспользовать сохранённую точную цифру (явный клик пользователя).
async function newapiBalance({ target, host, ccHeaders, usageUrl, subUrl, guessGrant, force = false }) {
    const apiKey = target && target.api_key;
    if (!isRealKey(apiKey)) return { status: 'no_key', error: 'ключа ещё нет' };
    const lib = newapiLib();
    // Все запросы к хосту — через шлюз частоты модуля. Иначе billing-вызовы летят
    // мимо очереди (пачка идёт чанками по 3), и Aliyun WAF у agentrouter.org
    // начинает отдавать JS-заглушку с кодом 200 вместо JSON к середине прогона.
    const gated = fn => (lib && lib.hostGate) ? lib.hostGate(host, fn) : fn();

    // ── 1. usage: живость ключа + легаси-расход ──
    const day = ms => new Date(ms).toISOString().slice(0, 10);
    const end = day(Date.now());
    const start = day(Date.now() - 400 * 864e5);   // 400 дней назад
    let usageRes;
    try {
        usageRes = await gated(() => fetch(`${usageUrl}?start_date=${start}&end_date=${end}`, {
            method: 'GET',
            headers: { ...ccHeaders, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        }));
    } catch (e) {
        return { status: 'unknown', error: e.message };
    }
    if (usageRes.status === 401 || usageRes.status === 403) return { status: 'dead' };
    if (usageRes.status !== 200) return { status: 'unknown', error: `usage HTTP ${usageRes.status}` };

    let usageSpent;
    try {
        const data = await usageRes.json();
        usageSpent = Math.round((Number(data.total_usage) || 0)) / 100;   // центы → доллары
    } catch (e) {
        return { status: 'unknown', error: `usage parse: ${e.message}` };
    }

    // ── 2. self: точный остаток аккаунта ──
    // Экономия запросов. Если предыдущий self прошёл недавно и с тех пор ничего не
    // изменилось — берём сохранённое значение и на шлюз не идём. Без этого повторное
    // нажатие «Балансы всех» шлёт по запросу на каждый аккаунт, Aliyun WAF у agentrouter
    // и rate-limit у tabitoken включают защиту, и точные цифры деградируют до прикидок.
    //
    // «Ничего не изменилось» = расход тот же И в ЛК с тех пор не заходили. Второе
    // обязательно: чек-ин/пополнение поднимает quota при нулевом расходе, и без этой
    // проверки кеш 20 минут врал на величину бонуса (ловил $175 против живых $200).
    // Явный клик по цифре приходит с force — он всегда спрашивает сервер.
    const SELF_REUSE_MS = 20 * 60_000;
    const prof = newapiResolveProfile(host, target);
    const selfAt = target.selfCheckedAt ? new Date(target.selfCheckedAt).getTime() : 0;
    // Кеш точной цифры лежит в ОТДЕЛЬНОМ поле selfBalance, а не в target.balance: у
    // аккаунта с анкером в balance стоит вписанное руками, и опираться на него нельзя.
    // Фолбэк на target.balance — для записей, снятых до появления поля, иначе первый
    // чек каждой из них зря пошёл бы на шлюз.
    const cachedSelf = typeof target.selfBalance === 'number' ? target.selfBalance
        : (target.balanceSource === 'self' && typeof target.balance === 'number' ? target.balance : null);
    let self = null;
    if (!force && selfAt && cachedSelf != null
        && Number(target.usageSpentAtSelf) === usageSpent
        && newapiLkOpenedAt(prof.label) < selfAt
        && Date.now() - selfAt < SELF_REUSE_MS) {
        self = {
            reused: true,
            balance: cachedSelf,
            spent: target.balanceSource === 'self' && typeof target.spent === 'number' ? target.spent : usageSpent,
            granted: target.grantedSelf != null ? target.grantedSelf : target.granted,
            newApiUserId: target.newApiUserId,
            newApiUsername: target.newApiUsername,
            selfCheckedAt: target.selfCheckedAt,
        };
    }
    const profileDir = prof.dir;
    let selfError = null;
    if (!self && lib && (profileDir || target.accessToken)) {
        try {
            const me = await lib.accountSelf({
                host,
                profileDir,
                accessToken: target.accessToken || null,
                userId: target.newApiUserId || null,
            });
            if (me.ok && me.balance != null) {
                // Точный чек мог ротировать одноразовую refresh-куку. Сразу отдаём новое
                // значение профилю, пока браузер закрыт, — чтобы следующее открытие ЛК
                // не наткнулось на погашенную сессию и не разлогинилось.
                if (prof.label) newapiSyncProfile(host, prof.label, 'после чека');
                self = {
                    balance: me.balance,
                    spent: me.spent != null ? me.spent : usageSpent,
                    granted: me.granted,
                    newApiUserId: me.userId,
                    newApiUsername: me.username,
                    profileUsed: prof.label,
                    selfCheckedAt: new Date().toISOString(),
                };
            } else {
                selfError = me.error || 'self не ответил';
            }
        } catch (e) { selfError = e.message; }
    } else if (!self && lib && !profileDir) {
        selfError = target.profile
            ? 'профиль не найден на диске'
            : 'профиля аккаунта нет — открой ЛК кнопкой 🌐 и войди, тогда баланс станет точным';
    }

    // ── 3. anchor: вписанная руками цифра как ПОПРАВКА к точной ──
    // Владелец вписывает баланс тогда, когда видит ЛК своими глазами и цифра шлюза его
    // не устроила (у gorouter /api/user/self отдаёт квоту, расходящуюся с кошельком в
    // ЛК). Показываем именно вписанное: self его не перебивает — до 20.08 перебивал, и
    // вписывание выглядело нерабочим.
    //
    // Но self ВСЁ РАВНО опрашивается (выше), и это главное. Раньше анкер возвращался
    // ДО него: цифра умела только убывать на расход, а детект чек-ина смотрит на рост
    // выдачи в точной цифре — значит у анкерного аккаунта не срабатывал никогда, 🎁
    // горел вечно и +$25 приходилось вписывать руками (поймано на lankymapping и wa,
    // 2026-08-20). Итого: balance = вписанное + прирост выдачи с сайта − прирост расхода.
    let anchorDrained = null;
    const anchor = Number(target.balanceAnchor);
    if (isFinite(anchor) && anchor > 0 && target.anchorSpent != null) {
        const drawn = Math.max(0, round2(usageSpent - Number(target.anchorSpent)));
        // Пополнение или бонус после вписывания: шлюз поднял выдачу — ту же сумму
        // прибавляем к вписанному, иначе владельцу пришлось бы вписывать заново после
        // каждого чек-ина. База — выдача шлюза на момент вписывания; у записей, сделанных
        // до этого фикса, её нет: прироста тогда нет, а базу проставит первый успешный
        // self (см. newapiApplyBalance), и со следующего пополнения всё сойдётся.
        const baseGranted = Number(target.anchorGrantedSelf);
        const nowGranted = self ? Number(self.granted) : NaN;
        const topUp = (isFinite(baseGranted) && isFinite(nowGranted) && nowGranted > baseGranted)
            ? round2(nowGranted - baseGranted) : 0;
        const left = round2(anchor + topUp - drawn);
        // Ушло в ноль или минус — привязка устарела (расход обогнал вписанное).
        // Отдавать её как факт нельзя: показываем self, потом прикидку, и UI просит вписать заново.
        if (left > 0) {
            return {
                status: 'live',
                balanceSource: 'anchor',
                balance: left,
                spent: usageSpent,
                usageSpent,
                granted: null,
                anchorTopUp: topUp,
                self,           // точная цифра нужна для детекта чек-ина, даже когда показываем анкер
                selfError,
            };
        }
        anchorDrained = 'вписанный баланс исчерпан расходом — впиши заново';
    }

    // ── 4. точная цифра, когда анкера нет (или он исчерпан) ──
    if (self) {
        return {
            status: 'live',
            balanceSource: 'self',
            reused: !!self.reused,
            balance: self.balance,
            spent: self.spent,
            usageSpent,
            granted: self.granted,
            newApiUserId: self.newApiUserId,
            newApiUsername: self.newApiUsername,
            profileUsed: self.profileUsed,
            selfCheckedAt: self.selfCheckedAt,
            self,
        };
    }

    // Анкер исчерпан расходом — причина едет в UI, чтобы было понятно, почему прикидка.
    if (anchorDrained) selfError = selfError || anchorDrained;

    // ── 5. guess: старое угадывание, последний резерв ──
    const grant = guessGrant(usageSpent);
    const bonus = Number(target.bonus) > 0 ? Number(target.bonus) : 0;
    const referral = Number(target.referral) > 0 ? Number(target.referral) : 0;
    const legacyGrant = Number(target.grantManual) > 0 ? Number(target.grantManual) : grant;
    let accessUntil = null;
    if (subUrl) {
        try {
            const subRes = await gated(() => fetch(subUrl, {
                method: 'GET',
                headers: { ...ccHeaders, 'Authorization': `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(15000),
            }));
            if (subRes.status === 200) {
                const sub = await subRes.json();
                accessUntil = sub.access_until && sub.access_until > 0 ? sub.access_until : null;
            }
        } catch { /* срок доступа не критичен */ }
    }
    return {
        status: 'live',
        balanceSource: 'guess',
        balance: round2(legacyGrant + bonus + referral - usageSpent),
        spent: usageSpent,
        usageSpent,
        granted: round2(legacyGrant + bonus + referral),
        accessUntil,
        selfError,
    };
}

// Баланс ключа AgentRouter. Точный — из /api/user/self; резервы см. newapiBalance.
// opts.force — не брать сохранённую цифру, спросить сервис (явный клик пользователя).
async function arBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'agentrouter.org',
        ccHeaders: AR_CC_HEADERS,
        usageUrl: `${AR_BASE_URL}/dashboard/billing/usage`,
        subUrl: `${AR_BASE_URL}/v1/dashboard/billing/subscription`,
        guessGrant: spent => Math.max(AR_DEFAULT_GRANT, Math.ceil(spent / AR_GRANT_STEP) * AR_GRANT_STEP),
        force: !!opts.force,
    });
}

async function handleArSessions(req, res) {
    // probe/balance-батчи идут минутами и до конца молчат — держим соединение живым.
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = arLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await arProbe(s.api_key); }));
            }
            arSaveMerge(sessions);   // мерж: пинг статусов не должен затирать параллельный чек баланса
        }
        if (balance) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => arApplyBalance(s, await arBalance(s))));
                // Мержим каждую порцию сразу: батч идёт ~10с, и если сохранять только
                // в конце, всё это время бар видит старые цифры (а при обрыве — теряет их).
                arSaveMerge(sessions.slice(i, i + 3));
            }
            // Отмечаем ключи как только что проверенные — чтобы автотик и ленивые
            // триггеры не пошли следом дублировать свежий батч.
            for (const s of sessions) AR_BALANCE_LAST.set(s.api_key, Date.now());
        }
        // Конфиг чек-ина отдаём вместе с пулом: фронту он нужен для расчёта таймера
        // ещё на boot (счётчик 🎁N в сайдваре), а второй запрос там был бы лишним.
        jsonRes(res, 200, { sessions, activeModel: arReadActiveModel(), checkin: arReadCheckinCfg() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

// Пишем результат newapiBalance в объект сессии (персистентный кеш — переживает F5 и рестарт).
// Общее для AgentRouter/GoRouter/Tabi.
// balanceAnchor/anchorSpent НЕ трогаем — это ручная настройка пользователя.
// balanceCheckedAt ставим ВСЕГДА, а не только при live: раньше при таймауте billing
// (а он медленный, 1-2с) штамп оставался старым → статусбар считал кеш протухшим и
// дёргал обновление на КАЖДОМ рендере строки, т.е. на каждом промпте. Теперь неудача
// тоже отмечена — бар подождёт до следующего порога, а ошибку видно в balanceError.
// Чек-ин: opts.checkin включает детект «+$25 налили» (только AgentRouter, см. ниже).
function newapiApplyBalance(target, bal, opts) {
    if (!target || !bal) return bal;
    // Аккаунт без ключа — это не ошибка чека: balanceError бы зажёг «⚠ ошибка чека»
    // в гейдже пула. Просто помечаем статус и уходим, штамп проверки не ставим.
    if (bal.status === 'no_key') { target.status = 'no_key'; delete target.balanceError; return bal; }
    target.status = bal.status;
    target.balanceCheckedAt = new Date().toISOString();
    // Чек-ин +$25 виден по РОСТУ выдачи: granted = остаток + расход, и он растёт
    // только когда шлюз налил денег (сам чек-ин поднимает quota, не двигая
    // used_quota — см. комментарий к newapiLkVisited). Сравнение строго self↔self:
    // прикидка guess это ceil(spent/25)*25, она сама прыгает на 25 при переходе
    // расхода через порог и дала бы ложное «уже забрал»; анкер — цифра из головы
    // пользователя. Реф-бонус +$100 или реальное пополнение тоже отметятся как
    // чек-ин: ошибка в безопасную сторону (таймер скажет «ждать», а не «иди зря»),
    // и в тот заход владелец всё равно был в ЛК.
    //
    // Базу сравнения держим в ОТДЕЛЬНОМ поле grantedSelf, а не в target.granted.
    // Почему: любой неточный чек между двумя точными (пауза WAF, истёкшая кука)
    // перезаписывает balanceSource на guess и стирает granted — и рост уже не с чем
    // сравнить. Именно так пропал забранный бонус faithfulpho: $300 → пауза шлюза →
    // $325, а базы к этому моменту не осталось. grantedSelf обновляется ТОЛЬКО
    // успешным self и переживает любые откаты на прикидку.
    // Точная цифра приходит либо самим ответом (balanceSource: 'self'), либо вложенной
    // в анкерный ответ полем `self`: у аккаунта с вписанным балансом показываем вписанное,
    // но детект чек-ина обязан смотреть на выдачу ШЛЮЗА. Пока эта ветка требовала
    // balanceSource === 'self', у анкерных записей 🎁 не гасло никогда.
    const seen = (bal.self && bal.self.granted != null) ? bal.self
        : (bal.balanceSource === 'self' ? bal : null);
    if (opts && opts.checkin && bal.status === 'live' && seen) {
        const nextGranted = Number(seen.granted);
        const prevGranted = Number(
            target.grantedSelf != null ? target.grantedSelf
                : (target.balanceSource === 'self' ? target.granted : NaN),
        );
        if (isFinite(prevGranted) && isFinite(nextGranted) && nextGranted - prevGranted >= AR_CHECKIN_MIN_USD) {
            target.checkinAt = new Date().toISOString();
            target.checkinFrom = 'self';
            logLine(`agentrouter чек-ин: ***${String(target.api_key || '').slice(-6)} выдача $${prevGranted.toFixed(2)} → $${nextGranted.toFixed(2)}`);
        }
        if (isFinite(nextGranted)) target.grantedSelf = nextGranted;
    }
    if (bal.status === 'live') {
        target.spent = bal.spent;
        target.balance = bal.balance;
        target.balanceSource = bal.balanceSource;
        if (bal.granted != null) target.granted = bal.granted; else delete target.granted;
        if (bal.accessUntil != null) target.accessUntil = bal.accessUntil;
        if (bal.newApiUserId) target.newApiUserId = bal.newApiUserId;
        if (bal.newApiUsername) target.newApiUsername = bal.newApiUsername;
        // Профиль, которым чек реально прошёл. Записываем, чтобы связка, найденная по
        // `acct_<id>` (см. newapiResolveProfile), закрепилась в пуле и её было видно в UI —
        // иначе она заново выводилась бы на каждом чеке и выглядела как «не сопоставлено».
        if (bal.profileUsed && target.profile !== bal.profileUsed) target.profile = bal.profileUsed;
        // Отметка последнего успешного self и расход на тот момент — по ним решается,
        // можно ли переиспользовать точную цифру вместо нового запроса (см. SELF_REUSE_MS).
        // Ведём её и когда показываем анкер: self к тому моменту уже опрошен, и без
        // отметки каждый чек анкерного аккаунта зря бил бы по шлюзу.
        if (seen) {
            target.selfCheckedAt = seen.selfCheckedAt || new Date().toISOString();
            if (bal.usageSpent != null) target.usageSpentAtSelf = bal.usageSpent;
            if (typeof seen.balance === 'number') target.selfBalance = seen.balance;
            if (seen.newApiUserId) target.newApiUserId = seen.newApiUserId;
            if (seen.newApiUsername) target.newApiUsername = seen.newApiUsername;
            if (seen.profileUsed && target.profile !== seen.profileUsed) target.profile = seen.profileUsed;
            // База для прироста выдачи у анкерных записей. Проставляется здесь для тех,
            // что вписаны до появления поля: цифра при этом не прыгает (прирост с этого
            // момента = 0), а следующий чек-ин уже прибавится к вписанному сам.
            if (target.balanceAnchor != null && target.anchorGrantedSelf == null && seen.granted != null) {
                target.anchorGrantedSelf = Number(seen.granted);
            }
        }
        // Почему точный баланс недоступен — видно в UI подсказкой, чтобы было понятно,
        // что починить (сопоставить профиль / переоткрыть ЛК).
        if (seen) delete target.selfError;
        else if (bal.selfError) target.selfError = bal.selfError;
        delete target.balanceError;
    } else {
        // Цифры оставляем прошлые (лучше устаревшие, чем нули), но помечаем причину.
        target.balanceError = bal.error || bal.status;
    }
    return bal;
}

// Детект чек-ина включён только здесь: у GoRouter чек-ина нет вообще, у XPeach
// шлюз сам отдаёт checkin_enabled: false.
function arApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { checkin: true }); }

// GET /__switch/api/ar/ping?api_key=… → probe одного ключа и сохраняет статус.
async function handleArPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await arProbe(api_key);
        const sessions = arLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; arSaveMerge(target); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── Обновление баланса: один в полёте на ключ + автотик по активному ключу ──
// Проблема, которую это решает: statusline при протухшем кеше делал
// fire-and-forget `curl -m 0.5 … &` и сразу завершался. Фоновый curl оставался
// сиротой в группе умирающего процесса — на Windows его сносило часто ДО того,
// как запрос уходил. Итог: `balanceCheckedAt` не двигался часами, а бар при этом
// пытался обновиться на каждом промпте (никогда не успевая).
// Теперь долгую работу делает ЭТОТ процесс — он живой и запрос доводит.
const AR_BALANCE_INFLIGHT = new Map();     // api_key → Promise (дедуп параллельных)
const AR_BALANCE_MIN_GAP_MS = 60_000;      // не чаще раза в минуту на ключ: billing медленный и это реальные деньги
const AR_BALANCE_LAST = new Map();         // api_key → ts последней ПОПЫТКИ (не только успешной)

// Считает баланс и мержит в сессию. Параллельные вызовы по одному ключу
// переиспользуют один промис — в billing уйдёт ровно один запрос.
function arBalanceOnce(apiKey, force = false) {
    const running = AR_BALANCE_INFLIGHT.get(apiKey);
    // Форсированный чек НЕ подхватывает уже летящий мягкий: тот мог вернуть цифру из
    // кеша, а пользователь кликнул именно затем, чтобы увидеть свежую.
    if (running && (!force || running.force)) return running.p;
    const p = (async () => {
        const target = arLoad().find(s => s.api_key === apiKey);
        const bal = await arBalance(target || { api_key: apiKey }, { force });
        if (target) {
            arApplyBalance(target, bal);
            arSaveMerge(target);   // мерж, а не перезапись файла: не затираем параллельный батч
        }
        return bal;
    })();
    AR_BALANCE_INFLIGHT.set(apiKey, { p, force });
    AR_BALANCE_LAST.set(apiKey, Date.now());
    p.catch(() => {}).finally(() => {
        if (AR_BALANCE_INFLIGHT.get(apiKey) && AR_BALANCE_INFLIGHT.get(apiKey).p === p) AR_BALANCE_INFLIGHT.delete(apiKey);
    });
    return p;
}

// Не чаще AR_BALANCE_MIN_GAP_MS и не параллельно — для автотика и ленивых триггеров.
function arBalanceMaybe(apiKey) {
    if (!apiKey) return;
    if (AR_BALANCE_INFLIGHT.has(apiKey)) return;
    const last = AR_BALANCE_LAST.get(apiKey) || 0;
    if (Date.now() - last < AR_BALANCE_MIN_GAP_MS) return;
    arBalanceOnce(apiKey).catch(e => logLine(`agentrouter balance tick: ${e.message}`));
}

// Автотик: пока agentrouter активен, сам обновляем баланс активного ключа.
// Статусбару больше не нужно ничего инициировать — он только читает кеш, поэтому
// цифра в баре перестаёт зависеть от того, выжил ли его фоновый curl.
const AR_BALANCE_TICK_MS = 120_000;
setInterval(() => {
    let key = '';
    try { key = fs.readFileSync(AR_ACTIVE_KEY_FILE, 'utf8').trim(); } catch { return; }
    if (!key.startsWith('sk-')) return;
    // Тикаем только когда провайдер реально выбран — иначе зря дёргаем биллинг.
    let base = '';
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        base = (JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw).env || {}).ANTHROPIC_BASE_URL || '';
    } catch { return; }
    const isAr = base.startsWith(AR_BASE_URL)
        || /^https?:\/\/(localhost|127\.0\.0\.1):(20133|20132)\b/.test(base);
    if (!isAr) return;
    arBalanceMaybe(key);
}, AR_BALANCE_TICK_MS).unref?.();

// Гвард для nudge-режима остальных провайдеров (GoRouter/Tabi): один пересчёт
// на ключ в полёте. У AgentRouter своя, более полная машинерия выше
// (AR_BALANCE_INFLIGHT + троттлинг + автотик) — это лёгкий аналог для тех,
// у кого автотика нет.
const BALANCE_NUDGE_INFLIGHT = new Set();
function nudgeBalanceOnce(tag, worker) {
    if (BALANCE_NUDGE_INFLIGHT.has(tag)) return false;
    BALANCE_NUDGE_INFLIGHT.add(tag);
    Promise.resolve().then(worker)
        .catch(e => logLine(`balance nudge ${tag}: ${e.message}`))
        .finally(() => BALANCE_NUDGE_INFLIGHT.delete(tag));
    return true;
}

// GET /__switch/api/ar/balance?api_key=… → считает баланс и пишет в сессию (кеш).
// Единственный писатель баланса: статусбар и дашборд ходят сюда, дедуп через
// arBalanceOnce гарантирует, что параллельные вызовы по одному ключу шлют
// в billing ОДИН запрос, а не пачку.
// &nudge=1 → отвечаем СРАЗУ и считаем в фоне. Для статусбара это принципиально:
// он живёт ~50мс и его фоновый curl умирает вместе с ним, поэтому ответ должен
// прийти мгновенно, а долгую работу делает этот процесс (он не умрёт).
async function handleArBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        if (q.searchParams.get('nudge') === '1') {
            const queued = !AR_BALANCE_INFLIGHT.has(api_key)
                && Date.now() - (AR_BALANCE_LAST.get(api_key) || 0) >= AR_BALANCE_MIN_GAP_MS;
            arBalanceMaybe(api_key);
            return jsonRes(res, 200, { ok: true, queued });
        }
        // Явный запрос цифры (клик по балансу в дашборде) — только со свежим self.
        const bal = await arBalanceOnce(api_key, true);
        // Метку чек-ина отдаём вместе с балансом: фронт патчит запись точечно (не
        // перезагружая весь пул), и без этих полей колонка 🎁 обновлялась бы только
        // после F5 — именно так и выглядело со стороны.
        const cur = arLoad().find(s => s.api_key === api_key);
        jsonRes(res, 200, { ...bal, checkinAt: cur && cur.checkinAt || null, checkinFrom: cur && cur.checkinFrom || null });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/{ar,go,tb}/set-balance { api_key, balance }
//
// Одна кнопка вместо трёх ручек. Раньше пользователь правил «изначальную выдачу»,
// докидывал +$25 за чек-ин и +$100 за рефку, подгоняя итог под цифру из ЛК —
// подгонка разъезжалась с первой же тратой и в UI появлялись минусы. Теперь он
// вписывает то, что реально видит, а мы запоминаем это ВМЕСТЕ с текущим расходом:
//
//   balanceAnchor = вписанное,  anchorSpent = расход на тот момент
//   дальше balance = balanceAnchor − (расход − anchorSpent)   → убывает сам
//
// balance = null|'' → сброс анкера. Если у аккаунта есть куки, точный баланс из
// /api/user/self всё равно приоритетнее — об этом сообщаем в ответе.
async function newapiSetBalance(req, res, { tag, load, save, balanceFn, applyFn, checkin }) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        const raw = body.balance;
        const val = (raw === null || raw === '' || raw === undefined) ? null : Number(raw);
        if (val !== null && !(isFinite(val) && val >= 0)) {
            return jsonRes(res, 400, { error: 'баланс должен быть числом ≥ 0 или пустым (сброс)' });
        }
        const sessions = load();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        // Проверочный чек: он и живость ключа даёт, и текущий расход для привязки.
        // force обязателен: пользователь вписывает то, что ВИДИТ в ЛК прямо сейчас, а
        // сохранённая цифра могла быть снята до чек-ина — именно так вписанные $200
        // перебивались кешированными $175 с бейджем «точный».
        // Падение чека НЕ должно ронять вписывание: пользователь назвал число, сохранить
        // его обязаны в любом случае. Раньше сетевой обрыв отдавал наверх
        // `error: 'fetch failed'`, фронт считал это провалом — хотя анкер уже был записан.
        const probe = await balanceFn(target, { force: true });
        const probeOk = probe && probe.status === 'live';
        const basis = (probe && probe.usageSpent != null) ? probe.usageSpent : (Number(target.spent) || 0);
        // Точная цифра из проверочного чека: у аккаунта с уже вписанным балансом она
        // приезжает вложенной (показываем-то анкер), у остальных — самим ответом.
        const probeSelf = (probe && probe.self && probe.self.granted != null) ? probe.self
            : (probe && probe.balanceSource === 'self' ? probe : null);

        if (val === null) {
            delete target.balanceAnchor; delete target.anchorSpent;
            delete target.anchoredAt; delete target.anchorFrom;
            delete target.anchorGrantedSelf;
        } else {
            // Второй (и для аккаунтов без профиля — единственный) способ узнать про
            // чек-ин: владелец вписывает то, что ВИДИТ в ЛК. Полная выдача = остаток +
            // расход; если она подскочила на бонус, значит деньги налили. Прикидку
            // (guess) за прежнюю выдачу не берём — она вычислена из расхода, а не с сайта.
            if (checkin) {
                const prevTotal = target.balanceSource === 'self'
                    ? Number(target.granted)
                    : Number(target.balanceAnchor) + Number(target.anchorSpent);
                const nextTotal = val + basis;
                if (isFinite(prevTotal) && nextTotal - prevTotal >= AR_CHECKIN_MIN_USD) {
                    target.checkinAt = new Date().toISOString();
                    target.checkinFrom = 'anchor';
                    logLine(`${tag} чек-ин: ***${key.slice(-6)} вписанная выдача $${prevTotal.toFixed(2)} → $${nextTotal.toFixed(2)}`);
                }
            }
            target.balanceAnchor = round2(val);
            target.anchorSpent = basis;
            target.anchoredAt = new Date().toISOString();
            target.anchorFrom = 'manual';
            // База прироста: выдача ШЛЮЗА на этот момент. Дальше её рост (чек-ин,
            // пополнение) прибавляется к вписанному сам — вписывать заново после каждого
            // бонуса не нужно. Если self не ответил, базу СНОСИМ: оставленная от прошлого
            // вписывания дала бы двойной учёт уже прибавленного.
            if (probeSelf && probeSelf.granted != null) target.anchorGrantedSelf = Number(probeSelf.granted);
            else delete target.anchorGrantedSelf;
        }

        let bal;
        if (val === null) {
            // Сброс — единственный случай, где нужен повторный расчёт: probe считался
            // ДО удаления анкера и всё ещё показывал его.
            bal = await balanceFn(target, { force: true });
        } else {
            // Показываем ВПИСАННОЕ, даже если точный self отвечает: он опрашивается, но
            // анкер не перебивает (см. newapiBalance). Раньше ответ подменялся на probe,
            // и в таблице цифра тут же возвращалась к прежней — выглядело как
            // «вписывание не работает». Статус мёртвого ключа не подменяем, но и
            // ошибку чека не тащим в ответ — сохранение состоялось.
            // `self` прокидываем внутрь, чтобы applyFn обновил кеш точной цифры и базу
            // чек-ина: без этого следующий чек снова пошёл бы на шлюз.
            bal = {
                status: (probe && probe.status === 'dead') ? 'dead' : 'live',
                balanceSource: 'anchor',
                balance: round2(val),
                spent: basis,
                usageSpent: basis,
                granted: null,
                self: probeSelf,
            };
        }
        applyFn(target, bal);
        save(sessions);   // целиком: delete полей мержем (Object.assign) не выражается
        logLine(`${tag} set-balance: ***${key.slice(-6)} → ${val === null ? 'сброс анкера' : '$' + val}${probeOk ? '' : ' (чек не ответил)'}`);
        // Расхождение с цифрой шлюза берём из probeSelf, а не из probe.balanceSource:
        // при перевписывании поверх анкера ответ приходит анкерным, а точная цифра — внутри.
        const selfSaw = (val !== null && probeOk && probeSelf && probeSelf.balance != null
            && round2(probeSelf.balance) !== round2(val))
            ? round2(probeSelf.balance) : null;
        const note = (val !== null && !probeOk)
            ? `баланс $${round2(val)} сохранён; расход перепроверить не удалось (${(probe && probe.error) || 'шлюз не ответил'})`
            : selfSaw !== null
                ? `вписано $${round2(val)} — этим перекрыт точный баланс шлюза ($${selfSaw}). Пустое поле вернёт точный`
                : undefined;
        jsonRes(res, 200, { ok: true, ...bal, error: undefined, note });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleArSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'agentrouter', load: arLoad, save: arSave, balanceFn: arBalance, applyFn: arApplyBalance, checkin: true });
}

// POST /__switch/api/{ar,go,tb}/map-profiles
//
// Связывает записи пула с браузерными профилями — без этой связки точный баланс
// недоступен, потому что /api/user/self авторизуется куками аккаунта, а не ключом.
//
// Сверяем по САМОМУ КЛЮЧУ, а не по github-логину. Логин ненадёжен: у GoRouter поля
// email в пуле оказались скопированы из AgentRouter, так что совпадение логина не
// значит, что ключ записи принадлежит этому аккаунту. GET /api/token/ отдаёт ключ
// замаскированным (sk-78xp******), поэтому полный раскрываем POST /api/token/<id>/key.
// Логин остаётся только резервом для записей, чей ключ не нашёлся ни в одном аккаунте.
//
// Отдельно возвращаем «бесхозные» профили — аккаунты, живые на диске, но
// отсутствующие в пуле (у GoRouter их четыре).
async function newapiMapProfiles(req, res, { tag, host, load, save }) {
    // Сопоставление ходит в сеть по каждому профилю — тоже долгий молчащий запрос.
    const stopKeepalive = jsonKeepalive(res);
    try {
        const lib = newapiLib();
        if (!lib) return jsonRes(res, 500, { error: 'модуль newapi-account недоступен' });
        const base = NEWAPI_PROFILE_DIRS[host];
        let labels;
        try {
            labels = fs.readdirSync(base).filter(d => {
                try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
            });
        } catch (e) { return jsonRes(res, 500, { error: `профили не читаются: ${e.message}` }); }

        const sessions = load();

        // ── шаг 1 (локально): у каких профилей вообще есть авторизация для этого хоста ──
        const candidates = [];
        for (const label of labels) {
            const dir = path.join(base, label);
            const cookies = lib.readProfileCookies(dir);
            const own = cookies.filter(c => c.host === host || c.host.endsWith('.' + host));
            const sess = own.find(c => c.name === 'session');
            const hasAuth = !!sess || own.some(c => c.name === 'new_api_refresh');
            if (!hasAuth) continue;
            candidates.push({
                label, dir,
                github: lib.githubLogin(cookies),
                userId: sess ? lib.sessionUserId(sess.value) : null,
            });
        }

        // ── шаг 2 (сеть): ключи каждого аккаунта. По 2 профиля за раз — это реальные
        // запросы к сервису, гнать все сразу незачем. ──
        const keyOwner = new Map();   // полный ключ → кандидат
        for (let i = 0; i < candidates.length; i += 2) {
            await Promise.all(candidates.slice(i, i + 2).map(async c => {
                try {
                    const r = await lib.listAccountKeys({ host, profileDir: c.dir, userId: c.userId });
                    c.keysOk = r.ok;
                    c.keyError = r.ok ? null : r.error;
                    for (const k of r.keys || []) if (k.key) keyOwner.set(k.key, c);
                    // Список ключей на jwt-инстансах тоже идёт через refresh, а значит
                    // тоже гасит одноразовую куку в профиле. Возвращаем ротированное
                    // значение обратно, иначе сопоставление профилей разлогинивало ЛК.
                    newapiSyncProfile(host, path.basename(c.dir), 'после сопоставления');
                } catch (e) { c.keysOk = false; c.keyError = e.message; }
            }));
        }

        // ── шаг 3: раскладываем по записям ──
        const claimed = new Set();
        const mapped = [];
        const unmatched = [];
        for (const s of sessions) {
            if (!isRealKey(s.api_key)) continue;
            const owner = keyOwner.get(s.api_key);
            if (owner) {
                s.profile = owner.label;
                if (owner.userId) s.newApiUserId = owner.userId;
                claimed.add(owner.label);
                mapped.push({ account: s.email || s.name, profile: owner.label, via: 'ключ' });
                continue;
            }
            // Резерв: github-логин. Помечаем в записи, что связка неточная.
            const login = String(s.email || s.name || '').trim().toLowerCase();
            const byLogin = login ? candidates.find(c => String(c.github || '').toLowerCase() === login && !claimed.has(c.label)) : null;
            if (byLogin) {
                s.profile = byLogin.label;
                if (byLogin.userId) s.newApiUserId = byLogin.userId;
                s.profileMatch = 'github';
                claimed.add(byLogin.label);
                mapped.push({ account: s.email || s.name, profile: byLogin.label, via: 'github-логин (неточно)' });
            } else {
                delete s.profile; delete s.newApiUserId; delete s.profileMatch;
                unmatched.push({ account: s.email || s.name, key: '***' + String(s.api_key).slice(-6) });
            }
        }
        // Точная связка снимает пометку неточности.
        for (const s of sessions) if (s.profile && keyOwner.has(s.api_key)) delete s.profileMatch;

        const orphans = candidates
            .filter(c => !claimed.has(c.label))
            .map(c => ({ profile: c.label, github: c.github, keysOk: c.keysOk !== false, error: c.keyError || undefined }));

        save(sessions);   // целиком: связка удаляет поля, мержем это не выражается
        logLine(`${tag} map-profiles: сопоставлено ${mapped.length}/${sessions.length}, бесхозных профилей ${orphans.length}`);
        jsonRes(res, 200, {
            ok: true,
            total: sessions.length,
            mappedCount: mapped.length,
            mapped, unmatched, orphans,
            profilesWithAuth: candidates.length,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

function handleArMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'agentrouter', host: 'agentrouter.org', load: arLoad, save: arSave });
}
function handleGoMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'gorouter', host: 'gorouter.app', load: goLoad, save: goSave });
}
function handleTbMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'tabi', host: 'tabitoken.com', load: tbLoad, save: tbSave });
}
function handleXpMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'xpeach', host: 'xpeach.codes', load: xpLoad, save: xpSave });
}

// POST /__switch/api/ar/set-github { api_key, ghId } → привязать/сменить/отвязать GitHub-аккаунт
// (метка-организация, никакой автоматики). ghId может быть:
//   'personal' — личный GitHub владельца (вне хранилища github-accounts.json);
//   'gh_<…>'   — id из хранилища (валидируем по ghLoad());
//   null/''    — снять метку.
async function handleArSetGithub(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        const ghId = (body.ghId === null || body.ghId === undefined || body.ghId === '') ? null : String(body.ghId).trim();
        const sessions = arLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });
        if (ghId && ghId !== 'personal') {
            const exists = ghLoad().some(g => g.id === ghId);
            if (!exists) return jsonRes(res, 400, { error: 'gh-аккаунт не найден в хранилище' });
        }
        target.ghId = ghId;
        arSave(sessions);
        logLine(`agentrouter set-github: ***${key.slice(-6)} → ${ghId === null ? 'отвязан' : ghId === 'personal' ? 'личный' : 'gh:' + ghId}`);
        jsonRes(res, 200, { ok: true, ghId: target.ghId });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ar/session/open { id } → открыть консоль agentrouter под GitHub-сессией
// этого аккаунта (для чек-ина +$25). Спавним agentrouter/open-session.js <label> отдельным
// detached-процессом (видимый Chromium). Первый раз сессии нет → скрипт ждёт ручного GitHub-логина
// и автосохраняет её; дальше открывает с сохранённой. Dedup: не плодим второй браузер на тот же label.
const arLkPids = new Map(); // label → pid последнего живого open-session процесса
function arPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}
async function handleArSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = arLoad();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const target = sessions[idx];
        // Профиль браузера привязываем к СТАБИЛЬНОМУ id аккаунта (как в gorouter), а не к
        // api_key/name/email: смена ключа и переименование не рвут сохранённый профиль.
        const label = 'acct_' + id;
        const dispName = String(target.name || target.email || label);

        // Уже открыт браузер для этого label — не плодим второй.
        const prevPid = arLkPids.get(label);
        if (arPidAlive(prevPid)) {
            logLine(`agentrouter session/open: ${dispName} label=${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'agentrouter', 'open-session.js');
        // Режим приходит с фронта: 🎁 «забрать» просит checkin (браузер разлогинится
        // сам, встанет на странице входа и закроется после входа). Остальное — по ключу.
        const wantCheckin = String(body.mode || '') === 'checkin' && isRealKey(target.api_key);
        // Предохранитель от залпа. Пользователь нажал 🎁 на всех 11 аккаунтах разом:
        // одиннадцать браузеров плюс одиннадцать чеков баланса — и Aliyun WAF у
        // agentrouter включил защиту, из-за чего ТОЧНЫЙ баланс всего пула на 10 минут
        // выродился в прикидку (см. coolDownHost в newapi-account.js). Чек-ин по своей
        // природе последовательный: зашёл, вошёл, забрал, закрылось.
        if (wantCheckin) {
            const alive = [...arLkPids.entries()].filter(([, pid]) => arPidAlive(pid));
            if (alive.length >= AR_CHECKIN_MAX_BROWSERS) {
                return jsonRes(res, 429, {
                    error: `уже открыто ${alive.length} браузеров чек-ина — доведи их до конца (войди через GitHub, окно закроется само), потом бери следующий. Залпом по всему пулу шлюз ловит рейт-лимит и точный баланс на 10 минут пропадает.`,
                });
            }
        }
        // Перед запуском отдаём профилю ротированные куки: иначе браузер пойдёт со
        // значением, которое наш чек баланса уже погасил, и разлогинится.
        // Для чек-ина — пропускаем: заливать куки, которые ветка checkin тут же
        // удалит, бессмысленно.
        if (!wantCheckin) newapiSyncProfile('agentrouter.org', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию по рефке; есть — сразу на баланс/пополнение.
        const mode = wantCheckin ? 'checkin' : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`agentrouter session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`agentrouter session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`agentrouter session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => { arLkPids.delete(label); logLine(`agentrouter session/open: ${label} — exited (code ${code}, sig ${sig})`); });
        proc.unref();
        arLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            arLkPids.delete(label);
            logLine(`agentrouter session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        // Отметка визита: в ЛК могли сделать чек-ин, и сохранённая точная цифра
        // перестаёт быть годной, даже если расход не сдвинулся (см. newapiLkVisited).
        newapiLkVisited(label);
        logLine(`agentrouter session/open: ${dispName} label=${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleArAdd(req, res) {
    try {
        const { email, api_key, name } = await readJsonBody(req);
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        // Вместо ключа — уникальная заглушка, дубли проверяем только у настоящих ключей.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = arLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'ar_' + Date.now() + '_' + sessions.length;
        sessions.push({
            id,
            email: mail,
            name: String(name || '').trim() || mail.split('@')[0],
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
        });
        arSave(sessions);
        logLine(`agentrouter add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, id, noKey });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleArDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = arLoad();
        const target = sessions.find(s => s.id === idKey);
        arSave(sessions.filter(s => s.id !== idKey));
        if (target && target.active) {
            try { fs.rmSync(AR_ACTIVE_KEY_FILE, { force: true }); } catch {}
        }
        logLine(`agentrouter delete: ${target ? (target.email || '?') : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── Share-код: перенос метаданных аккаунта (общее для agentrouter/gorouter/tabi) ──
// Раньше в код попадали только email/name/api_key + сессия, поэтому у получателя
// аккаунт появлялся «пустым»: выдачу (grant), бонус, потраченное и баланс нужно
// было задавать заново руками. Переносим весь блок цифр как есть — это свойства
// самого аккаунта у провайдера, они одинаковы у обеих сторон.
//
// `v` намеренно остаётся 1: meta — аддитивное поле. Старый дашборд его просто
// игнорирует, поэтому новые коды импортируются и старой версией тоже, а старые
// коды (без meta) — новой. Обновляться синхронно с другом не нужно.
//
// profile и accessToken НЕ переносим: первый — метка локальной папки профиля
// (у получателя её нет), второй — живой доступ к аккаунту, ему в коде не место.
// Старые grant/grantManual/bonus/referral остаются в списке ради приёма кодов из
// прошлых версий — на загрузке их свернёт newapiMigrateAnchors.
const SHARE_META_FIELDS = [
    'status', 'spent', 'balance', 'balanceSource', 'granted',
    'balanceAnchor', 'anchorSpent', 'anchoredAt', 'anchorFrom',
    'newApiUserId', 'newApiUsername', 'selfCheckedAt', 'usageSpentAtSelf',
    'accessUntil', 'balanceCheckedAt', 'created',
    'grant', 'grantManual', 'grantSource', 'bonus', 'referral',
];

function sharePickMeta(acct) {
    const meta = {};
    for (const k of SHARE_META_FIELDS) {
        if (acct && acct[k] !== undefined) meta[k] = acct[k];
    }
    return meta;
}

// Накладываем meta на новую запись. Белый список обязателен: чужой share-код не
// должен уметь проставить active/id/api_key/ghId или дописать произвольные поля.
function shareApplyMeta(rec, meta) {
    if (!meta || typeof meta !== 'object') return rec;
    for (const k of SHARE_META_FIELDS) {
        const v = meta[k];
        if (v === undefined) continue;
        if (v !== null && typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') continue;
        rec[k] = v;
    }
    return rec;
}

// ── AgentRouter: share/import (механика из gorouter, аккаунт идентифицируем по id) ──
// Формат: base64url(JSON { v:1, provider:'agentrouter', email, name, api_key,
// meta:{grant,bonus,spent,balance,status,…}, session:{cookies,origins} }).
// storageState из agentrouter/profiles/acct_<id>/,
// label совпадает с handleArSessionOpen (acct_ + id).
const AR_SHARE_SCRIPT = path.join(__dirname, '..', 'agentrouter', 'share-session.js');
const AR_SESSIONS_DIR = path.join(__dirname, '..', 'agentrouter', 'sessions');

function arB64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function arB64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// POST /__switch/api/ar/share { id } → снять storageState профиля и собрать строку.
async function handleArShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = arLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = arLkPids.get(label);
        if (arPidAlive(prevPid)) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        const stateFile = path.join(AR_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [AR_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code2, sig) => resolve({ code: code2, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`agentrouter share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;

        const payload = {
            v: 1,
            provider: 'agentrouter',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = arB64UrlEncode(JSON.stringify(payload));
        logLine(`agentrouter share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ar/import { share } → разобрать строку и добавить аккаунт.
async function handleArImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(arB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'agentrouter' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не agentrouter-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = arLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'ar_' + Date.now() + '_' + sessions.length;
        const label = 'acct_' + id;
        // Цифры (выдача/бонус/потрачено/баланс/статус) приезжают в payload.meta —
        // аккаунт появляется у получателя ровно таким же, как у автора кода.
        const rec = shareApplyMeta({
            id,
            email: mail,
            name: String(payload.name || '').trim() || mail.split('@')[0],
            api_key: key,
            active: false,
            status: 'unknown',
            created: new Date().toISOString(),
            shared: true,
            importedAt: new Date().toISOString(),
        }, payload.meta);
        sessions.push(rec);
        arSave(sessions);

        try {
            fs.mkdirSync(AR_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(AR_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`agentrouter import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`agentrouter import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''}${typeof rec.balance === 'number' ? ', balance $' + rec.balance : ''})`);
        jsonRes(res, 200, {
            ok: true,
            id,
            email: mail,
            hasSession: session.cookies.length > 0 || session.origins.length > 0,
            balance: typeof rec.balance === 'number' ? rec.balance : null,
            grant: typeof rec.grant === 'number' ? rec.grant : null,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── AgentRouter: rename / set-key (механика из gorouter, аккаунт по стабильному id) ──
// Профиль браузера привязан к id (acct_<id>), а не к api_key — поэтому смена ключа
// и переименование НЕ рвут сохранённую GitHub-сессию.

// POST /__switch/api/ar/rename { id, email?, name? } → переименовать аккаунт.
async function handleArRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = arLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (body.name !== undefined && body.name !== null) {
            const n = String(body.name).trim();
            if (!n) return jsonRes(res, 400, { error: 'name не может быть пустым' });
            target.name = n;
        }
        if (body.email !== undefined && body.email !== null) {
            const e = String(body.email).trim();
            if (!e) return jsonRes(res, 400, { error: 'email не может быть пустым' });
            target.email = e;
        }
        arSave(sessions);
        logLine(`agentrouter rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ar/key { id, api_key } → сменить/вписать API-ключ аккаунта
// (ключ берётся в консоли agentrouter). Профиль привязан к id — сессия НЕ теряется.
// Если аккаунт был активным — обновляем активный ключ (прокси читает файл на каждый запрос).
async function handleArSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = arLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (sessions.some(s => s.api_key === newKey && s.id !== id)) {
            return jsonRes(res, 400, { error: 'такой ключ уже занят другим аккаунтом' });
        }
        const wasActive = !!target.active;
        target.api_key = newKey;
        // Был аккаунт-заглушка, вписали настоящий ключ → снимаем 'no_key', пусть
        // следующий пинг/баланс поставит реальный статус.
        if (target.status === 'no_key' && isRealKey(newKey)) target.status = 'unknown';
        if (wasActive) {
            fs.writeFileSync(AR_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        }
        arSave(sessions);
        logLine(`agentrouter set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Старый label до миграции на id: ar_ + sha1(api_key)[0:8].
function arLegacyLabelForKey(key) {
    return 'ar_' + crypto.createHash('sha1').update(String(key || '')).digest('hex').slice(0, 8);
}

// Одноразовая миграция существующих аккаунтов на стабильный id (модель gorouter):
// 1) выдаём id аккаунтам без него; 2) переименовываем папки профилей и session-файлы
// из старого формата ar_<sha1(api_key)> в acct_<id>, чтобы сохранённые сессии не осиротели.
// Вызывается при старте сервера. Повторно ничего не делает (все id уже стоят).
function arMigrateIds() {
    try {
        const sessions = arLoad();
        const dir = path.join(__dirname, '..', 'agentrouter', 'profiles');
        let changed = false, moved = 0;
        sessions.forEach((s, i) => {
            if (s.id) return;
            const id = 'ar_' + Date.now() + '_' + i;
            s.id = id;
            changed = true;
            const oldLabel = arLegacyLabelForKey(s.api_key);
            const newLabel = 'acct_' + id;
            const oldDir = path.join(dir, oldLabel);
            const newDir = path.join(dir, newLabel);
            if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
                try { fs.renameSync(oldDir, newDir); moved++; }
                catch (e) { logLine(`agentrouter migrate: не смогли переименовать ${oldLabel} → ${newLabel}: ${e.message}`); }
            }
            const oldState = path.join(AR_SESSIONS_DIR, oldLabel + '.json');
            const newState = path.join(AR_SESSIONS_DIR, newLabel + '.json');
            if (fs.existsSync(oldState) && !fs.existsSync(newState)) {
                try { fs.renameSync(oldState, newState); moved++; } catch {}
            }
        });
        if (changed) {
            arSave(sessions);
            logLine(`agentrouter migrate: выдал id ${sessions.filter(s => s.id).length} аккаунтам, переименовано профилей/сессий: ${moved}`);
        }
    } catch (e) {
        logLine(`agentrouter migrate failed: ${e.message}`);
    }
}

// Прямой режим: ВСЁ идёт в SSE keepalive прокси :20133 — он вставляет `: keepalive`
// при длинных thinking-паузах, ретраит транзиентные ошибки и хеджирует.
// claude-* он форвардит в agentrouter.org 1-в-1, а gpt-* сам переправляет в :20132
// (Anthropic→OpenAI конвертер: у agentrouter gpt живёт только на OpenAI-эндпоинте).
// Раньше gpt ходил на :20132 напрямую — а там НЕТ ретраев и нет keepalive-пингов,
// поэтому транзиентная 5xx/429 всплывала в Claude Code жёсткой ошибкой, а длинная
// пауза на reasoning рвала стрим по watchdog'у. Двойной хоп проверен: стрим
// gpt-5.6-sol через :20133 отдаёт корректный Anthropic-SSE (2026-08-16).
// Аргумент model больше не влияет на выбор базы (раньше влиял) — оставлен, чтобы
// call-site'ы читались как «куда идёт эта модель», и на случай новых развилок.
function arTargetFor(model) {
    return { base: AR_KEEPALIVE_URL, needProxy: true, keepalive: true };
}

// Модель для settings.json. Окно контекста — свойство ID модели, а не апстрима: без
// суффикса [1m] Claude Code считает окно 200k и режет историю втрое раньше (та же
// грабля, что в FreeModel-ветке на :2093). agentrouter отдаёт claude-* с 1M, поэтому
// дотягиваем суффикс; gpt-* не трогаем — у них своё окно.
function arSettingsModel(model) {
    const m = String(model || '').trim();
    return /^claude-(opus|sonnet)-/.test(m) && !m.includes('[') ? `${m}[1m]` : m;
}

// Поднимаем ОБА прокси независимо от модели: keepalive (:20133) стоит спереди, а
// конвертер (:20132) нужен не только для gpt-основной модели — по ar-modelmap.json
// туда же уходят haiku-вызовы сабагентов (дефолт haiku → gpt-5.6-sol), т.е. он
// требуется даже когда основная модель claude-*. Спавн идемпотентен: занятый порт → no-op.
async function arSpawnBoth() {
    await arKeepaliveSpawn();
    await arProxySpawn();
}

// Клик по ключу → активный: пишем ключ в ar-active-key.txt — оба прокси (:20133/:20132)
// читают его на каждый запрос, поэтому смена активного ключа работает на лету без рестарта Claude Code.
async function handleArActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        // Заглушка вместо ключа: активировать нечего — иначе она уедет в ar-active-key.txt
        // и положит активный бэкенд Claude Code.
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — зарегистрируйся (🌐) и вставь ключ кнопкой 🔑' });
        const sessions = arLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(AR_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        arSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-ar');
            settings.env = settings.env || {};
            // Источник правды по модели — ar-active-model.txt. settings.model сюда НЕ
            // подмешиваем: там может лежать модель чужого провайдера (ComboWombo от
            // OmniRoute), которой у agentrouter нет.
            const curModel = arReadActiveModel() || '';
            const arTarget = arTargetFor(curModel);
            settings.env.ANTHROPIC_BASE_URL = arTarget.base;
            delete settings.apiKeyHelper;   // agentrouter-WAF не пускает helper-путь
            // НЕ удаляем модель: активация ключа не должна сбрасывать выбор с чипа
            // моделей (был баг — клик по ключу после клика по gpt-5.6-sol возвращал CC
            // на дефолт). Если активной модели нет — сбрасываем залипшую чужую, как раньше.
            if (curModel) settings.model = arSettingsModel(curModel);
            else delete settings.model;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;   // токен рулит авторизацией
            clearOtEnv(settings);    // снести AUTH_TOKEN/маппинги от other пулов — потом ставим свой
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';   // заглушка: реальный ключ прокси берут из ar-active-key.txt на каждый запрос
            writeSettings(settings);
            settingsOk = true;
            await arSpawnBoth();
        } catch (e) {
            logLine(`agentrouter activate: settings.json FAILED: ${e.message}`);
        }
        logLine(`agentrouter activate: ${target.email} → ***${key.slice(-6)} (token, base ${arTargetFor(arReadActiveModel() || '').base})`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу (каталог общий, WAF не пустит без ключа).
async function handleArModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (AR_MODELS_CACHE.data && Date.now() - AR_MODELS_CACHE.ts < AR_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: AR_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${AR_BASE_URL}/v1/models`, {
            signal: controller.signal,
            headers: { ...AR_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
        });
        clearTimeout(timeout);
        if (!resp.ok) {
            return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}` });
        }
        const data = await resp.json();
        const models = (data.data || []).map(m => ({
            id: m.id,
            owned_by: m.owned_by,
            supported_endpoint_types: m.supported_endpoint_types || [],
        }));
        AR_MODELS_CACHE.data = models;
        AR_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (AR_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: AR_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

// Сменить активную модель: пишет ar-active-model.txt + settings.model.
// Это и есть «один клик» по чипу модели: полностью настраивает Claude Code под
// agentrouter (модель, base, токен, оба прокси). ar-modelmap.json НЕ трогает —
// маппинг тиров правится руками в блоке ниже на вкладке.
async function handleArSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        const settingsModel = arSettingsModel(m);
        fs.writeFileSync(AR_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        let activeKey = '';
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-ar-model');
            const target = arTargetFor(m);
            settings.model = settingsModel;
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = target.base;
            delete settings.apiKeyHelper;   // agentrouter-WAF не пускает helper-путь
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            try { activeKey = fs.readFileSync(AR_ACTIVE_KEY_FILE, 'utf8').trim(); } catch {}
            // Заглушка, а не литерал: реальный ключ прокси читают из ar-active-key.txt
            // на каждый запрос (keepalive-proxy.js:771), поэтому смена аккаунта не
            // требует новой сессии CC. Литерал здесь был единственным местом, где
            // ar вёл себя иначе, чем go/tb/xp, и ломал бесшовность.
            if (activeKey) settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            else delete settings.env.ANTHROPIC_AUTH_TOKEN;
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`agentrouter set-model: settings.json FAILED: ${e.message}`);
        }
        const target = arTargetFor(m);
        await arSpawnBoth();
        logLine(`agentrouter set-model: ${m} (base ${target.base}${activeKey ? '' : ', БЕЗ активного ключа'})`);
        // warn: без ключа конфиг записан, но первый же запрос упадёт 401 — на свежей
        // установке это главная причина «нажал и не работает». Дашборд это показывает.
        jsonRes(res, 200, {
            ok: true, model: m, settingsModel, settingsUpdated: settingsOk,
            modelFile: AR_ACTIVE_MODEL_FILE, base: target.base, needRestart: true,
            warn: activeKey ? undefined : 'нет активного ключа — кликни по ключу в списке ниже, иначе будет 401',
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Маппинг claude-тиров → модели agentrouter (как в GoRouter/Custom). Живёт в
// routing/ar-modelmap.json, читается прокси :20132 и keepalive :20133 по mtime
// на каждый запрос — правка применяется БЕЗ рестарта прокси.
function arReadModelMap() {
    try {
        const raw = fs.readFileSync(AR_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    } catch { return {}; }
}

// GET /__switch/api/ar/modelmap → текущий маппинг; POST {opus, sonnet, haiku} → сохранить.
async function handleArModelMap(req, res) {
    try {
        if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const mm = {
                opus: String(body.opus || '').trim() || '',
                sonnet: String(body.sonnet || '').trim() || '',
                haiku: String(body.haiku || '').trim() || '',
            };
            fs.writeFileSync(AR_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
            logLine(`agentrouter modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
            return jsonRes(res, 200, { ok: true, modelMap: mm });
        }
        jsonRes(res, 200, { ok: true, modelMap: arReadModelMap() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Чек-ин +$25: конфиг суточной границы ─────────────────────────────
// Шлюз наливает +$25 на аккаунт раз в сутки, но только если владелец зайдёт в ЛК,
// разлогинится и войдёт заново через GitHub. Сброс — не скользящие 24ч от момента
// забора, а суточная граница (забрал вечером → следующий заход возможен уже утром;
// именно поэтому днём после утреннего чек-ина деньги не капали, а на следующее утро
// капали). Время границы настраивается: 20:30 МСК — наблюдение владельца, не факт
// из документации шлюза.
function arReadCheckinCfg() {
    try {
        const raw = fs.readFileSync(AR_CHECKIN_FILE, 'utf8');
        const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        return {
            resetHhmmMsk: /^\d{1,2}:\d{2}$/.test(String(j.resetHhmmMsk || '')) ? String(j.resetHhmmMsk) : AR_CHECKIN_DEFAULTS.resetHhmmMsk,
            bonusUsd: Number(j.bonusUsd) > 0 ? Number(j.bonusUsd) : AR_CHECKIN_DEFAULTS.bonusUsd,
        };
    } catch { return { ...AR_CHECKIN_DEFAULTS }; }
}

// GET /__switch/api/ar/checkin-config → конфиг; POST {resetHhmmMsk, bonusUsd} → сохранить.
async function handleArCheckinConfig(req, res) {
    try {
        if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const hhmm = String(body.resetHhmmMsk || '').trim();
            if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return jsonRes(res, 400, { error: 'время границы в формате ЧЧ:ММ' });
            const [H, M] = hhmm.split(':').map(Number);
            if (!(H >= 0 && H <= 23 && M >= 0 && M <= 59)) return jsonRes(res, 400, { error: 'некорректное время границы' });
            const bonus = body.bonusUsd === undefined ? AR_CHECKIN_DEFAULTS.bonusUsd : Number(body.bonusUsd);
            if (!(isFinite(bonus) && bonus > 0)) return jsonRes(res, 400, { error: 'бонус должен быть числом больше 0' });
            const cfg = { resetHhmmMsk: `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`, bonusUsd: round2(bonus) };
            fs.writeFileSync(AR_CHECKIN_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
            logLine(`agentrouter checkin-config: граница ${cfg.resetHhmmMsk} МСК, бонус $${cfg.bonusUsd}`);
            return jsonRes(res, 200, { ok: true, checkin: cfg });
        }
        jsonRes(res, 200, { ok: true, checkin: arReadCheckinCfg() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ar/checkin-mark { id, on } → поставить/снять отметку «бонус забран».
//
// Зачем ручная отметка, если бэкенд умеет детектить сам. Детект видит ТОЛЬКО рост выдачи
// между двумя точными чеками, и есть случаи, когда роста не увидеть в принципе:
//   • бонус налился, пока точной цифры не было вовсе (пауза WAF, кука ЛК истекла, у записи
//     стоял анкер и глушил self — так пропали отметки у lankymapping и wa 2026-08-20);
//   • владелец забрал бонус вне дашборда, а первый чек после этого уже застал новую выдачу
//     как «исходную» — сравнивать не с чем;
//   • шлюз перестал наливать этому аккаунту, и 🎁 будет гореть вечно, вводя в заблуждение.
// Восстановить пропущенный рост нечем — цифра уже новая. Поэтому владельцу нужен способ
// сказать «забрал», иначе колонка врёт, а врущая колонка хуже отсутствующей.
//
// `on: false` снимает отметку (ошибочно нажал / бонус не дали). Штамп ставим ТЕКУЩИМ
// временем, а не началом окна: важно лишь, что он внутри текущего окна.
async function handleArCheckinMark(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const on = body.on === undefined ? true : !!body.on;
        const sessions = arLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (on) {
            target.checkinAt = new Date().toISOString();
            target.checkinFrom = 'manual';
        } else {
            delete target.checkinAt; delete target.checkinFrom;
        }
        // Мержем, а не пишем целиком: параллельный батч «💳 Балансы всех» держит в памяти
        // свою копию пула. checkinAt/checkinFrom нет в BALANCE_CLEARABLE, поэтому отметка
        // переживает и его сохранение.
        arSaveMerge(target);
        logLine(`agentrouter чек-ин: ${target.name || target.email || id} — отметка ${on ? 'поставлена' : 'снята'} вручную`);
        jsonRes(res, 200, { ok: true, checkinAt: target.checkinAt || null, checkinFrom: target.checkinFrom || null });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── GoRouter — автономная вкладка (NewAPI, GitHub-вход) ─────────────
// Свой пул ключей (gorouter-sessions.json), свой активный ключ/модель.
// Активация БЕЗ локального прокси: gorouter.app сам Anthropic-совместимый,
// пишем ANTHROPIC_BASE_URL = https://gorouter.app/v1 напрямую + токен.
// GitHub-вход: gorouter/open-session.js (как agentrouter, но без чек-ина $25).
const GO_SESSIONS_FILE = path.join(__dirname, 'gorouter-sessions.json');
const GO_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'gorouter-active-key.txt');
const GO_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'gorouter-active-model.txt');
const GO_BASE_URL = 'https://gorouter.app/v1';
// SSE keepalive proxy для gorouter (как у tabi :20155): форвардит напрямую в
// gorouter.app, режет [1m]-суффиксы и держит SSE-паузы thinking-моделей.
// UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages к корню (см. keepalive-proxy.js:427).
const GO_UPSTREAM = 'https://gorouter.app';
const GO_KEEPALIVE_PORT = 20156;
const GO_KEEPALIVE_URL = `http://localhost:${GO_KEEPALIVE_PORT}`;
const GO_MODELMAP_FILE = path.join(__dirname, 'gorouter-modelmap.json');
// Резерв «угадать грант» (см. newapiBalance): база $70, а не $175 как у agentrouter.
const GO_GRANT_STEP = 25;
const GO_DEFAULT_GRANT = 70;
const GO_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

const GO_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function goLoad() {
    try {
        const raw = fs.readFileSync(GO_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        // id-миграция: старые аккаунты жили только по api_key. Присваиваем стабильный id
        // (email может повторяться, ключ может меняться). Дублируем id — не трогаем, первый побеждает.
        let changed = false;
        const seen = new Set();
        arr.forEach((s, i) => {
            if (!s.id || seen.has(s.id)) {
                const base = 'go_' + Date.now() + '_' + i;
                s.id = base + '_' + Math.random().toString(36).slice(2, 6);
                changed = true;
            }
            seen.add(s.id);
        });
        // Разовый перенос ручных grantManual/bonus/referral в анкер (см. newapiMigrateAnchors).
        if (newapiMigrateAnchors(arr)) changed = true;
        if (changed) {
            try { goSave(arr); } catch {}
        }
        return arr;
    } catch { return []; }
}
function goSave(arr) {
    fs.writeFileSync(GO_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function goReadActiveModel() {
    try { return fs.readFileSync(GO_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function goReadActiveKey() {
    try { return fs.readFileSync(GO_ACTIVE_KEY_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// SSE keepalive proxy для gorouter: второй экземпляр keepalive-proxy.js на :20156.
// KEY_FILE/MODELMAP_FILE параметризованы env'ом, чтобы не пересекаться с agentrouter
// :20133 и tabi :20155. UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages.
async function goKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(GO_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(GO_KEEPALIVE_PORT),
                UPSTREAM: GO_UPSTREAM,
                KEY_FILE: GO_ACTIVE_KEY_FILE,
                MODELMAP_FILE: GO_MODELMAP_FILE,
                ...(process.env.GO_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.GO_PRE_COMMIT_MS } : {}),
            },
        });
        child.unref();
        logLine(`gorouter keepalive proxy spawn: :${GO_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`gorouter keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Пинг ключа: GET /v1/models с CC-заголовками → 200 = LIVE, 401/403 = DEAD.
async function goProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';   // заглушка вместо ключа — пинговать нечего
    try {
        const r = await fetch(`${GO_BASE_URL}/models`, {
            method: 'GET',
            headers: { ...GO_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// Баланс: usage endpoint на КОРНЕ gorouter.app (не /v1). Точный остаток — из
// /api/user/self куками профиля; резервы (анкер, угадывание) см. newapiBalance.
async function goBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'gorouter.app',
        ccHeaders: GO_CC_HEADERS,
        usageUrl: 'https://gorouter.app/dashboard/billing/usage',
        subUrl: null,
        guessGrant: spent => Math.max(GO_DEFAULT_GRANT, Math.ceil(spent / GO_GRANT_STEP) * GO_GRANT_STEP),
        force: !!opts.force,
    });
}

function goApplyBalance(target, bal) { return newapiApplyBalance(target, bal); }

async function handleGoSessions(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = goLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await goProbe(s.api_key); }));
            }
            goSave(sessions);
        }
        if (balance) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => goApplyBalance(s, await goBalance(s))));
            }
            goSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: goReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleGoPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await goProbe(api_key);
        const sessions = goLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; goSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleGoBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const recalc = async (force = false) => {
            const sessions = goLoad();
            const target = sessions.find(s => s.api_key === api_key);
            const bal = await goBalance(target || { api_key }, { force });
            if (target) { goApplyBalance(target, bal); goSave(sessions); }
            return bal;
        };
        // nudge=1: отвечаем мгновенно, считаем в своём процессе. Статусбар живёт ~50мс,
        // его фоновый curl не доживает до ответа медленного billing-эндпоинта.
        if (q.searchParams.get('nudge') === '1') {
            const queued = nudgeBalanceOnce('go:' + api_key, recalc);
            return jsonRes(res, 200, { ok: true, queued });
        }
        // Клик по цифре — force: кеш мог быть снят до чек-ина на сайте.
        jsonRes(res, 200, await recalc(true));
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleGoSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'gorouter', load: goLoad, save: goSave, balanceFn: goBalance, applyFn: goApplyBalance });
}

const goLkPids = new Map();
function goPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleGoSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = goLoad();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const target = sessions[idx];
        // Профиль браузера привязываем к СТАБИЛЬНОМУ id аккаунта, а не к name/email:
        // переименование аккаунта не должно рвать привязку к сохранённому профилю.
        const label = 'acct_' + id;

        const prevPid = goLkPids.get(label);
        if (goPidAlive(prevPid)) {
            logLine(`gorouter session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'gorouter', 'open-session.js');
        // Ротированные куки — в профиль, иначе браузер стартует с погашенной сессией.
        newapiSyncProfile('gorouter.app', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию по рефке; есть — сразу на баланс.
        // `mode` из тела перебивает это правило: у безключевой записи, заселённой поверх
        // предупреждения о засвете, аккаунт у провайдера скорее всего УЖЕ есть, и рефка
        // ему не нужна — нужен вход. Регистрация вместо входа там отвечает «аккаунт уже
        // создан», и выглядит это как поломка дашборда (разбор 2026-08-21).
        const wantMode = String(body.mode || '').trim();
        const mode = (wantMode === 'console' || wantMode === 'register') ? wantMode
            : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`gorouter session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`gorouter session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`gorouter session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => { goLkPids.delete(label); logLine(`gorouter session/open: ${label} — exited (code ${code}, sig ${sig})`); });
        proc.unref();
        goLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            goLkPids.delete(label);
            logLine(`gorouter session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        newapiLkVisited(label);   // в ЛК могли пополнить/чекнуться — кеш точной цифры снят
        logLine(`gorouter session/open: ${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── GoRouter: share/import (передать аккаунт другу и принять чужой) ────────
// Формат: base64url(JSON { v:1, provider:'gorouter', email, name, api_key,
// meta:{grant,bonus,spent,balance,status,…}, session:{cookies,origins} }).
// «Живая» часть (GitHub + gorouter) — storageState
// из gorouter/profiles/acct_<id>/, снимается headless-скриптом share-session.js.

const GO_SHARE_SCRIPT = path.join(__dirname, '..', 'gorouter', 'share-session.js');
const GO_SESSIONS_DIR = path.join(__dirname, '..', 'gorouter', 'sessions');

function goB64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function goB64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// POST /__switch/api/go/share { id } → снять storageState профиля и собрать строку.
async function handleGoShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = goLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = goLkPids.get(label);
        if (goPidAlive(prevPid)) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        // Гоняем headless-снимок профиля (короткий, до 30 сек).
        const stateFile = path.join(GO_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [GO_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code, sig) => resolve({ code, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`gorouter share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;

        const payload = {
            v: 1,
            provider: 'gorouter',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = goB64UrlEncode(JSON.stringify(payload));
        logLine(`gorouter share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/go/import { share } → разобрать строку и добавить аккаунт.
async function handleGoImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(goB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'gorouter' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не gorouter-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = goLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'go_' + Date.now() + '_' + sessions.length;
        const label = 'acct_' + id;
        // Цифры (выдача/бонус/потрачено/баланс/статус) приезжают в payload.meta —
        // аккаунт появляется у получателя ровно таким же, как у автора кода.
        const rec = shareApplyMeta({
            id,
            email: mail,
            name: String(payload.name || '').trim() || mail.split('@')[0],
            api_key: key,
            active: false,
            status: 'unknown',
            created: new Date().toISOString(),
            shared: true,
            importedAt: new Date().toISOString(),
        }, payload.meta);
        sessions.push(rec);
        goSave(sessions);

        // «Живую» сессию кладём туда, где её подхватит open-session.js при первом открытии.
        try {
            fs.mkdirSync(GO_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(GO_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`gorouter import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`gorouter import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''}${typeof rec.balance === 'number' ? ', balance $' + rec.balance : ''})`);
        jsonRes(res, 200, {
            ok: true,
            id,
            email: mail,
            hasSession: session.cookies.length > 0 || session.origins.length > 0,
            balance: typeof rec.balance === 'number' ? rec.balance : null,
            grant: typeof rec.grant === 'number' ? rec.grant : null,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleGoAdd(req, res) {
    try {
        const { email, api_key, name } = await readJsonBody(req);
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = goLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'go_' + Date.now() + '_' + sessions.length;
        sessions.push({
            id,
            email: mail,
            name: String(name || '').trim() || mail.split('@')[0],
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
        });
        goSave(sessions);
        logLine(`gorouter add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, id, noKey });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сменить/вписать API-ключ у существующего аккаунта (после того, как ключ взят
// в консоли gorouter). Аккаунт остаётся тем же — id и браузерный профиль не трогаем.
async function handleGoSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = goLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (sessions.some(s => s.api_key === newKey && s.id !== id)) {
            return jsonRes(res, 400, { error: 'такой ключ уже занят другим аккаунтом' });
        }
        const wasActive = !!target.active;
        target.api_key = newKey;
        // Был аккаунт-заглушка, вписали настоящий ключ → снимаем 'no_key'.
        if (target.status === 'no_key' && isRealKey(newKey)) target.status = 'unknown';
        if (wasActive) {
            fs.writeFileSync(GO_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        }
        goSave(sessions);
        logLine(`gorouter set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Переименовать аккаунт (подпись) — меняем name и/или email. id и профиль браузера
// не трогаем, поэтому привязка профиля/сессии сохраняется.
async function handleGoRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = goLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (body.name !== undefined && body.name !== null) {
            const n = String(body.name).trim();
            if (!n) return jsonRes(res, 400, { error: 'name не может быть пустым' });
            target.name = n;
        }
        if (body.email !== undefined && body.email !== null) {
            const e = String(body.email).trim();
            if (!e) return jsonRes(res, 400, { error: 'email не может быть пустым' });
            target.email = e;
        }
        goSave(sessions);
        logLine(`gorouter rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleGoDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = goLoad();
        const target = sessions.find(s => s.id === idKey);
        goSave(sessions.filter(s => s.id !== idKey));
        if (target && target.api_key === goReadActiveKey()) {
            try { fs.rmSync(GO_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(GO_ACTIVE_MODEL_FILE, { force: true }); } catch {}
        }
        logLine(`gorouter delete: ${target ? target.email : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация БЕЗ прокси: пишем baseUrl gorouter.app/v1 напрямую + токен.
async function handleGoActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        // Заглушка вместо ключа: активировать нечего (иначе уедет в gorouter-active-key.txt).
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — зарегистрируйся (🌐) и вставь ключ кнопкой 🔑' });
        const sessions = goLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(GO_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        goSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-go');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = GO_KEEPALIVE_URL;   // keepalive :20156 → gorouter.app напрямую
            delete settings.apiKeyHelper;
            // Модель НЕ удаляем, если есть выбранная: delete = дефолт Claude Code, а он
            // без [1m] → окно 200k. Источник правды — gorouter-active-model.txt (образец —
            // handleArActivate). Суффикс дотянет writeSettings(). Если модель не выбрана,
            // пинить claude-opus-5 нельзя: в каталоге шлюза её может не быть.
            const goCurModel = goReadActiveModel() || '';
            if (goCurModel) settings.model = goCurModel;
            else { delete settings.model; logLine('gorouter activate: активной модели нет → settings.model снят, Claude Code поедет на 200k'); }
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';   // реальный ключ берёт keepalive из gorouter-active-key.txt
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`gorouter activate: settings.json FAILED: ${e.message}`);
        }
        await goKeepaliveSpawn();
        logLine(`gorouter activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${GO_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, viaProxy: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу.
async function handleGoModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (GO_MODELS_CACHE.data && Date.now() - GO_MODELS_CACHE.ts < GO_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: GO_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${GO_BASE_URL}/models`, {
            signal: controller.signal,
            headers: { ...GO_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
        });
        clearTimeout(timeout);
        if (!resp.ok) {
            return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}` });
        }
        const data = await resp.json();
        const models = (data.data || []).map(m => ({
            id: m.id,
            owned_by: m.owned_by,
            supported_endpoint_types: m.supported_endpoint_types || [],
        }));
        GO_MODELS_CACHE.data = models;
        GO_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (GO_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: GO_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

// Сменить активную модель: пишет gorouter-active-model.txt + settings.model (+ env модели).
async function handleGoSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        const settingsModel = /^claude-(opus|sonnet)-/.test(m) && !m.includes('[') ? `${m}[1m]` : m;
        fs.writeFileSync(GO_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-go-model');
            const mm = (body.modelMap || {});
            settings.model = mm[m] || settingsModel;
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = GO_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`gorouter set-model: settings.json FAILED: ${e.message}`);
        }
        await goKeepaliveSpawn();
        logLine(`gorouter set-model: ${m} (base ${GO_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: GO_ACTIVE_MODEL_FILE, base: GO_KEEPALIVE_URL, needRestart: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Настраиваемый маппинг claude-тиров → gorouter-модели (как в Custom). Живёт в сессиях.
async function handleGoModelMap(req, res) {
    try {
        const body = await readJsonBody(req);
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
        fs.writeFileSync(GO_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
        logLine(`gorouter modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
        jsonRes(res, 200, { ok: true, modelMap: mm });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function goReadModelMap() {
    try {
        const raw = fs.readFileSync(GO_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch { return {}; }
}

// ───── Tabi (tb) — автономная вкладка (NewAPI, GitHub-вход) ────────────
// tabitoken.com: Anthropic-совместимый шлюз (прямой /v1/messages жив), но модели
// -thinking → длинные паузы → watchdog CC рвёт поток. Поэтому активация как у
// AgentRouter: claude-* через SSE keepalive-прокси на :20155 (вставляет `: keepalive`
// и ретраит 401/403/429/5xx), форвардит в https://tabitoken.com. Свой пул ключей
// (tabi-sessions.json), свой активный ключ/модель, свой modelmap (tabi-modelmap.json).
// GitHub-вход: tabi/open-session.js + share/import как у gorouter (🔗/📥).
const TB_SESSIONS_FILE = path.join(__dirname, 'tabi-sessions.json');
const TB_MODELMAP_FILE = path.join(__dirname, 'tabi-modelmap.json');
const TB_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'tabi-active-key.txt');
const TB_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'tabi-active-model.txt');
const TB_BASE_URL = 'https://tabitoken.com';   // БЕЗ /v1 (usage на корне, как AR/GO)
// Резерв «угадать грант» (см. newapiBalance): база $100, шаг $20.
const TB_GRANT_STEP = 20;
const TB_DEFAULT_GRANT = 100;
const TB_KEEPALIVE_PORT = 20155;
const TB_KEEPALIVE_URL = `http://localhost:${TB_KEEPALIVE_PORT}`;
const TB_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

const TB_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function tbLoad() {
    try {
        const raw = fs.readFileSync(TB_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        // id-миграция (как gorouter): стабильный id нужен для share/import/rename/setKey.
        let changed = false;
        const seen = new Set();
        arr.forEach((s, i) => {
            if (!s.id || seen.has(s.id)) {
                const base = 'tb_' + Date.now() + '_' + i;
                s.id = base + '_' + Math.random().toString(36).slice(2, 6);
                changed = true;
            }
            seen.add(s.id);
        });
        // Разовый перенос ручных grantManual/bonus/referral в анкер (см. newapiMigrateAnchors).
        if (newapiMigrateAnchors(arr)) changed = true;
        if (changed) {
            try { tbSave(arr); } catch {}
        }
        return arr;
    } catch { return []; }
}
function tbSave(arr) {
    fs.writeFileSync(TB_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function tbReadActiveModel() {
    try { return fs.readFileSync(TB_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function tbReadActiveKey() {
    try { return fs.readFileSync(TB_ACTIVE_KEY_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// SSE keepalive proxy для tabitoken: второй экземпляр keepalive-proxy.js на :20155.
// KEY_FILE/MODELMAP_FILE параметризованы env'ом, чтобы не пересекаться с agentrouter :20133.
async function tbKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(TB_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(TB_KEEPALIVE_PORT),
                UPSTREAM: TB_BASE_URL,
                KEY_FILE: TB_ACTIVE_KEY_FILE,
                MODELMAP_FILE: TB_MODELMAP_FILE,
                ...(process.env.TB_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.TB_PRE_COMMIT_MS } : {}),
            },
        });
        child.unref();
        logLine(`tabi keepalive proxy spawn: :${TB_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`tabi keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// ───── Самопочинка статуслайна ──────────────────────────────────────────────
// Статус-бар обязан работать «из коробки» при ЛЮБОМ способе запуска. Указатель
// ~/.claude/autoreger-root.txt и шим ~/.claude/autoreger-statusline.sh пишут
// restart-dashboard.sh/.bat — но START.bat и запуск `node routing/transparent-proxy.js`
// руками их обходят, и после переноса папки шим смотрел в старый корень.
// Поэтому дашборд делает это сам, на каждом старте:
//   1. указатель на свой корень (LF — cmd `echo` писал CRLF, и путь с хвостовым
//      \r не находился: статус-бар исчезал, внизу оставалась только подсказка
//      «← for agents», из-за чего казалось, что мешает именно она);
//   2. свежая копия шима (в репо он может обновиться);
//   3. settings.json: если там путь ПРЯМО в репо (старая схема) или файл по
//      указанному пути не существует — переводим на шим.
// Чужой statusLine (не наш) не трогаем.
function healStatuslinePath() {
    const claudeDir = path.join(os.homedir(), '.claude');
    const repoRoot = path.join(__dirname, '..');
    const shimSrc = path.join(__dirname, 'statusline-shim.sh');
    const shimDst = path.join(claudeDir, 'autoreger-statusline.sh');
    try {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, 'autoreger-root.txt'),
            repoRoot.replace(/\\/g, '/').replace(/\/+$/, '') + '\n', 'utf8');
        if (fs.existsSync(shimSrc)) {
            fs.copyFileSync(shimSrc, shimDst);
            try { fs.chmodSync(shimDst, 0o755); } catch { }
        }
    } catch (e) {
        logLine(`statusline pointer skip: ${e.message}`);
    }
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return null;
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const s = JSON.parse(raw);
        const cmd = s.statusLine && typeof s.statusLine.command === 'string' ? s.statusLine.command : '';
        if (!cmd) return null;
        if (!/statusline-autoreger\.sh|autoreger-statusline\.sh/i.test(cmd)) return null;  // чужой — не наше дело
        // Путь внутри команды: `bash "<path>"` либо просто <path>.
        const m = cmd.match(/"([^"]+)"|(\S+\.sh)/);
        const cur = m ? (m[1] || m[2]) : '';
        const curOk = cur && fs.existsSync(cur.replace(/\//g, path.sep));
        const wanted = `bash "${shimDst.replace(/\\/g, '/')}"`;
        if (cmd === wanted) return null;
        // Прямой путь в репо, который ЖИВ и указывает на наш же скрипт — тоже
        // переводим на шим: он переживёт следующий перенос папки.
        if (curOk && /autoreger-statusline\.sh/i.test(cur)) return null;
        try { makeSettingsBackup('statusline-heal'); } catch { }
        s.statusLine = { type: 'command', command: wanted };
        writeSettings(s);
        return { from: cmd, to: wanted };
    } catch (e) {
        logLine(`statusline heal skip: ${e.message}`);
        return null;
    }
}

// ───── Рестарт keepalive-инстанса (:20133 AR / :20155 Tabi / :20156 GoRouter / :20157 XPeach) ─────
// Все три xxKeepaliveSpawn() поднимают процесс ТОЛЬКО если порт свободен, а
// автоперезапуска нет — после правки keepalive-proxy.js новый код подхватывается
// лишь пересозданием процесса. Раньше это делали таскиллом руками: порт оставался
// пустым, и все сессии CC/happy получали ConnectionRefused (settings.json смотрит
// ровно в один из этих портов). Поэтому убийство и подъём — одной операцией,
// с ожиданием освобождения порта и живого /__keepalive/api/status.
function killPortListeners(port) {
    let killed = 0;
    try {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        for (const line of out.split(/\r?\n/)) {
            const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
            if (m) { try { execFileSync('taskkill', ['/F', '/PID', m[1]]); killed += 1; } catch { } }
        }
    } catch { }
    return killed;
}

function portIsFree(port) {
    const net = require('net');
    return new Promise(resolve => {
        const sock = net.createServer();
        sock.once('error', () => resolve(false));
        sock.listen(port, '127.0.0.1', () => { sock.close(); resolve(true); });
    });
}

const napMs = (ms) => new Promise(r => setTimeout(r, ms));

// Порт → как его поднять. Один список на кнопку «перезапустить» в Health и на
// boot-респавн активного бэкенда, чтобы новый keepalive не забыли ни там, ни там.
function keepaliveInstances() {
    return {
        [AR_KEEPALIVE_PORT]: { name: 'AgentRouter', spawn: arKeepaliveSpawn },
        [TB_KEEPALIVE_PORT]: { name: 'Tabi', spawn: tbKeepaliveSpawn },
        [GO_KEEPALIVE_PORT]: { name: 'GoRouter', spawn: goKeepaliveSpawn },
        [XP_KEEPALIVE_PORT]: { name: 'XPeach', spawn: xpKeepaliveSpawn },
        // Front-door — не keepalive, но чинится ровно так же, а кнопка нужна тем
        // более: пока он лежит, у Claude Code нет бэкенда вообще.
        [frontdoorPort()]: { name: 'Front Door', spawn: frontdoorSpawn, statusPath: '/__frontdoor/api/status' },
    };
}

async function keepaliveRestart(port) {
    const instances = keepaliveInstances();
    const inst = instances[port];
    if (!inst) {
        return { ok: false, error: `:${port} — не keepalive-инстанс (можно ${Object.keys(instances).join(', ')})` };
    }
    const statusPath = inst.statusPath || '/__keepalive/api/status';
    const killed = killPortListeners(port);
    // Порт освобождается не мгновенно — иначе spawn увидит занятый порт и молча выйдет.
    for (let i = 0; i < 20; i += 1) {
        if (await portIsFree(port)) break;
        await napMs(100);
    }
    const sp = await inst.spawn();
    if (!sp.ok) return { ok: false, error: sp.error || 'spawn failed', killed };
    for (let i = 0; i < 40; i += 1) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}${statusPath}`, { signal: AbortSignal.timeout(700) });
            if (r.ok) {
                const status = await r.json().catch(() => null);
                logLine(`keepalive restart: ${inst.name} :${port} поднят (убито ${killed}, pid ${sp.pid || '?'})`);
                return { ok: true, name: inst.name, port, killed, pid: sp.pid || null, status };
            }
        } catch { }
        await napMs(250);
    }
    logLine(`keepalive restart: ${inst.name} :${port} НЕ ответил после спавна`);
    return { ok: false, error: `спавн прошёл, но :${port} не ответил за 10с`, killed, pid: sp.pid || null };
}

// Boot-респавн keepalive АКТИВНОГО бэкенда.
//
// Каждый keepalive — отдельный detached-процесс, он умирает вместе с прошлым
// запуском дашборда. На boot мы поднимали только agentrouter :20133 и front-door
// :20100, поэтому активный gorouter/tabi/xpeach оставался без апстрима: front-door
// жив, состояние читается, а порт пустой — и каждый запрос Claude Code получает 502
// до тех пор, пока юзер не догадается нажать «перезапустить» в Health или
// переактивировать провайдера. Поймано 2026-08-20: после рестарта дашборда активный
// gorouter :20156 не поднялся, CC ловил `502 front-door → gorouter: EACCES` десятками.
//
// Порт берём оттуда, куда реально смотрит Claude Code: с включённым front-door это
// upstream из active-backend.json, иначе — ANTHROPIC_BASE_URL из settings.json.
// Удалённый шлюз (домен вместо loopback) и чужие порты (конвертеры, omniroute)
// пропускаем: поднимать нечего или не наше дело.
const LOOPBACK_PORT_RE = /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]):(\d+)/i;

async function bootSpawnActiveBackend() {
    let base = '';
    try { base = (readSettings().env || {}).ANTHROPIC_BASE_URL || ''; } catch { return; }
    let target = base;
    if (isFrontdoorBase(base)) {
        const st = readActiveBackend();
        target = (st && st.upstream) ? String(st.upstream) : '';
    }
    const m = target.match(LOOPBACK_PORT_RE);
    if (!m) return;                                   // удалённый шлюз или официальный Claude
    const port = Number(m[1]);
    if (port === frontdoorPort()) return;             // его спавнит frontdoorSpawn()
    const inst = keepaliveInstances()[port];
    if (!inst) return;                                // конвертеры/omniroute живут своей жизнью
    const r = await inst.spawn();
    if (!r.ok) logLine(`boot: keepalive активного бэкенда ${inst.name} :${port} НЕ поднялся: ${r.error || '?'}`);
    else if (r.already) logLine(`boot: keepalive активного бэкенда ${inst.name} :${port} уже слушает`);
    else logLine(`boot: поднял keepalive активного бэкенда ${inst.name} :${port} (pid ${r.pid || '?'})`);
    return r;
}

// Пинг ключа: GET /v1/models с CC-заголовками → 200 = LIVE, 401/403 = DEAD.
async function tbProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';   // заглушка вместо ключа — пинговать нечего
    try {
        const r = await fetch(`${TB_BASE_URL}/v1/models`, {
            method: 'GET',
            headers: { ...TB_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// Баланс ключа: usage на КОРНЕ tabitoken.com (не /v1). Точный остаток — из
// /api/user/self (tabitoken это rc.23, там сперва обмен refresh-куки на JWT);
// резервы (анкер, угадывание) см. newapiBalance.
async function tbBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'tabitoken.com',
        ccHeaders: TB_CC_HEADERS,
        usageUrl: `${TB_BASE_URL}/dashboard/billing/usage`,
        subUrl: `${TB_BASE_URL}/v1/dashboard/billing/subscription`,
        guessGrant: spent => Math.max(TB_DEFAULT_GRANT, Math.ceil(spent / TB_GRANT_STEP) * TB_GRANT_STEP),
        force: !!opts.force,
    });
}

function tbApplyBalance(target, bal) { return newapiApplyBalance(target, bal); }

async function handleTbSessions(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = tbLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await tbProbe(s.api_key); }));
            }
            tbSave(sessions);
        }
        if (balance) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => tbApplyBalance(s, await tbBalance(s))));
            }
            tbSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: tbReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleTbPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await tbProbe(api_key);
        const sessions = tbLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; tbSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTbBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const recalc = async (force = false) => {
            const sessions = tbLoad();
            const target = sessions.find(s => s.api_key === api_key);
            const bal = await tbBalance(target || { api_key }, { force });
            if (target) { tbApplyBalance(target, bal); tbSave(sessions); }
            return bal;
        };
        // nudge=1: мгновенный ответ, пересчёт в своём процессе (см. handleGoBalance).
        if (q.searchParams.get('nudge') === '1') {
            const queued = nudgeBalanceOnce('tb:' + api_key, recalc);
            return jsonRes(res, 200, { ok: true, queued });
        }
        jsonRes(res, 200, await recalc(true));   // клик по цифре — только свежий self
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleTbSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'tabi', load: tbLoad, save: tbSave, balanceFn: tbBalance, applyFn: tbApplyBalance });
}

const tbLkPids = new Map();
function tbPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleTbSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tbLoad();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const target = sessions[idx];
        const label = 'acct_' + id;

        const prevPid = tbLkPids.get(label);
        if (tbPidAlive(prevPid)) {
            logLine(`tabi session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'tabi', 'open-session.js');
        // tabitoken — jwt-инстанс, refresh-кука одноразовая: без этой синхронизации
        // браузер уходит на refresh с погашенным значением и разлогинивается.
        newapiSyncProfile('tabitoken.com', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию по рефке; есть — сразу на баланс.
        // `mode` из тела перебивает это правило: у безключевой записи, заселённой поверх
        // предупреждения о засвете, аккаунт у провайдера скорее всего УЖЕ есть, и рефка
        // ему не нужна — нужен вход. Регистрация вместо входа там отвечает «аккаунт уже
        // создан», и выглядит это как поломка дашборда (разбор 2026-08-21).
        const wantMode = String(body.mode || '').trim();
        const mode = (wantMode === 'console' || wantMode === 'register') ? wantMode
            : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`tabi session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`tabi session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`tabi session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => { tbLkPids.delete(label); logLine(`tabi session/open: ${label} — exited (code ${code}, sig ${sig})`); });
        proc.unref();
        tbLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            tbLkPids.delete(label);
            logLine(`tabi session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        newapiLkVisited(label);   // в ЛК могли пополнить/чекнуться — кеш точной цифры снят
        logLine(`tabi session/open: ${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTbAdd(req, res) {
    try {
        const { email, api_key, name } = await readJsonBody(req);
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = tbLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'tb_' + Date.now() + '_' + sessions.length;
        sessions.push({
            id,
            email: mail,
            name: String(name || '').trim() || mail.split('@')[0],
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
        });
        tbSave(sessions);
        logLine(`tabi add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, id, noKey });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTbDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tbLoad();
        const target = sessions.find(s => s.id === idKey);
        tbSave(sessions.filter(s => s.id !== idKey));
        if (target && target.api_key === tbReadActiveKey()) {
            try { fs.rmSync(TB_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(TB_ACTIVE_MODEL_FILE, { force: true }); } catch {}
        }
        logLine(`tabi delete: ${target ? target.email : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация через SSE keepalive-прокси :20155 (как agentrouter claude-*): пишем ключ
// в tabi-active-key.txt, прокси инжектит его на каждый запрос. В settings.json —
// заглушка AUTH_TOKEN='dummy'.
async function handleTbActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        // Заглушка вместо ключа: активировать нечего (иначе уедет в tabi-active-key.txt).
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — зарегистрируйся (🌐) и вставь ключ кнопкой 🔑' });
        const sessions = tbLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(TB_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        tbSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-tabi');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = TB_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            // Как в handleGoActivate: delete = дефолт CC = 200k. Источник правды —
            // tabi-active-model.txt, суффикс [1m] дотянет writeSettings().
            const tbCurModel = tbReadActiveModel() || '';
            if (tbCurModel) settings.model = tbCurModel;
            else { delete settings.model; logLine('tabi activate: активной модели нет → settings.model снят, Claude Code поедет на 200k'); }
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';   // реальный ключ берёт keepalive из tabi-active-key.txt
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`tabi activate: settings.json FAILED: ${e.message}`);
        }
        await tbKeepaliveSpawn();
        logLine(`tabi activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${TB_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу.
async function handleTbModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (TB_MODELS_CACHE.data && Date.now() - TB_MODELS_CACHE.ts < TB_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: TB_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${TB_BASE_URL}/v1/models`, {
            signal: controller.signal,
            headers: { ...TB_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
        });
        clearTimeout(timeout);
        if (!resp.ok) {
            return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}` });
        }
        const data = await resp.json();
        const models = (data.data || []).map(m => ({
            id: m.id,
            owned_by: m.owned_by,
            supported_endpoint_types: m.supported_endpoint_types || [],
        }));
        TB_MODELS_CACHE.data = models;
        TB_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (TB_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: TB_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

// Сменить активную модель: пишет tabi-active-model.txt + settings.model. Прокси :20155
// читает активный ключ по mtime, modelmap — свой tabi-modelmap.json. [1m] дотягиваем
// для claude-opus/sonnet (окно контекста — свойство ID, а не апстрима).
async function handleTbSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        const settingsModel = /^claude-(opus|sonnet)-/.test(m) && !m.includes('[') ? `${m}[1m]` : m;
        fs.writeFileSync(TB_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-tabi-model');
            settings.model = settingsModel;
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = TB_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`tabi set-model: settings.json FAILED: ${e.message}`);
        }
        await tbKeepaliveSpawn();
        logLine(`tabi set-model: ${m} (base ${TB_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: TB_ACTIVE_MODEL_FILE, base: TB_KEEPALIVE_URL, needRestart: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function tbReadModelMap() {
    try {
        const raw = fs.readFileSync(TB_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    } catch { return {}; }
}

// GET/POST /__switch/api/tb/modelmap → маппинг claude-тиров → tabi-модели
// (читается keepalive-прокси :20155 по mtime — правка без рестарта).
async function handleTbModelMap(req, res) {
    try {
        if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const mm = {
                opus: String(body.opus || '').trim() || '',
                sonnet: String(body.sonnet || '').trim() || '',
                haiku: String(body.haiku || '').trim() || '',
            };
            fs.writeFileSync(TB_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
            logLine(`tabi modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
            return jsonRes(res, 200, { ok: true, modelMap: mm });
        }
        jsonRes(res, 200, { ok: true, modelMap: tbReadModelMap() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сменить/вписать API-ключ у существующего аккаунта (как gorouter set-key).
async function handleTbSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = tbLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (sessions.some(s => s.api_key === newKey && s.id !== id)) {
            return jsonRes(res, 400, { error: 'такой ключ уже занят другим аккаунтом' });
        }
        const wasActive = !!target.active;
        target.api_key = newKey;
        // Был аккаунт-заглушка, вписали настоящий ключ → снимаем 'no_key'.
        if (target.status === 'no_key' && isRealKey(newKey)) target.status = 'unknown';
        if (wasActive) {
            fs.writeFileSync(TB_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        }
        tbSave(sessions);
        logLine(`tabi set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTbRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tbLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (body.name !== undefined && body.name !== null) {
            const n = String(body.name).trim();
            if (!n) return jsonRes(res, 400, { error: 'name не может быть пустым' });
            target.name = n;
        }
        if (body.email !== undefined && body.email !== null) {
            const e = String(body.email).trim();
            if (!e) return jsonRes(res, 400, { error: 'email не может быть пустым' });
            target.email = e;
        }
        tbSave(sessions);
        logLine(`tabi rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── Tabi: share/import (передать аккаунт другу и принять чужой) ──────────
// Формат тот же, что у gorouter: base64url(JSON { v:1, provider:'tabi', email, name,
// api_key, meta:{grant,bonus,spent,balance,status,…}, session:{cookies,origins} }).
// storageState из tabi/profiles/acct_<id>/.
const TB_SHARE_SCRIPT = path.join(__dirname, '..', 'tabi', 'share-session.js');
const TB_SESSIONS_DIR = path.join(__dirname, '..', 'tabi', 'sessions');

function tbB64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function tbB64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// POST /__switch/api/tb/share { id } → снять storageState профиля и собрать строку.
async function handleTbShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tbLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = tbLkPids.get(label);
        if (tbPidAlive(prevPid)) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        const stateFile = path.join(TB_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [TB_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code2, sig) => resolve({ code: code2, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`tabi share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;

        const payload = {
            v: 1,
            provider: 'tabi',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = tbB64UrlEncode(JSON.stringify(payload));
        logLine(`tabi share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/tb/import { share } → разобрать строку и добавить аккаунт.
async function handleTbImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(tbB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'tabi' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не tabi-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = tbLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'tb_' + Date.now() + '_' + sessions.length;
        const label = 'acct_' + id;
        // Цифры (выдача/бонус/потрачено/баланс/статус) приезжают в payload.meta —
        // аккаунт появляется у получателя ровно таким же, как у автора кода.
        const rec = shareApplyMeta({
            id,
            email: mail,
            name: String(payload.name || '').trim() || mail.split('@')[0],
            api_key: key,
            active: false,
            status: 'unknown',
            created: new Date().toISOString(),
            shared: true,
            importedAt: new Date().toISOString(),
        }, payload.meta);
        sessions.push(rec);
        tbSave(sessions);

        try {
            fs.mkdirSync(TB_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(TB_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`tabi import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`tabi import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''}${typeof rec.balance === 'number' ? ', balance $' + rec.balance : ''})`);
        jsonRes(res, 200, {
            ok: true,
            id,
            email: mail,
            hasSession: session.cookies.length > 0 || session.origins.length > 0,
            balance: typeof rec.balance === 'number' ? rec.balance : null,
            grant: typeof rec.grant === 'number' ? rec.grant : null,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── XPeach (xp) — автономная вкладка (NewAPI, GitHub-вход) ────────────
// xpeach.codes («🍑 Code» / XPeachCode) — New-API той же ветки, что tabitoken.com:
// кука `new_api_refresh` на пути /api/user/auth, обмен на JWT (HOST_AUTH='jwt').
// Anthropic-эндпоинт живой: 8 claude-моделей каталога помечены
// supported_endpoint_types:[anthropic,openai] и /v1/messages отвечает 200 —
// значит claude-* форвардятся keepalive'ом напрямую, конвертер :20132 не нужен.
// Свой пул ключей (xpeach-sessions.json), свой активный ключ/модель, свой
// modelmap (xpeach-modelmap.json). GitHub-вход: xpeach/open-session.js + share/import.
//
// ⚠ Валюта шлюза — 🍑 (`custom_currency_symbol`), но `custom_currency_exchange_rate`
// = 1 и `quota_per_unit` = 500000, то есть арифметика newapiBalance() ровно та же,
// что у ar/go/tb — отличается ТОЛЬКО символ в UI. Чек-ина нет (checkin_enabled=false).
const XP_SESSIONS_FILE = path.join(__dirname, 'xpeach-sessions.json');
const XP_MODELMAP_FILE = path.join(__dirname, 'xpeach-modelmap.json');
const XP_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'xpeach-active-key.txt');
const XP_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'xpeach-active-model.txt');
const XP_BASE_URL = 'https://xpeach.codes';   // БЕЗ /v1 (usage на корне, как AR/GO/TB)
// Резерв «угадать грант» (см. newapiBalance): выдача нового аккаунта 10 🍑.
const XP_GRANT_STEP = 10;
const XP_DEFAULT_GRANT = 10;
const XP_KEEPALIVE_PORT = 20157;
const XP_KEEPALIVE_URL = `http://localhost:${XP_KEEPALIVE_PORT}`;
const XP_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

const XP_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function xpLoad() {
    try {
        const raw = fs.readFileSync(XP_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        // id-миграция (как tabi/gorouter): стабильный id нужен для share/import/rename/setKey.
        let changed = false;
        const seen = new Set();
        arr.forEach((s, i) => {
            if (!s.id || seen.has(s.id)) {
                const base = 'xp_' + Date.now() + '_' + i;
                s.id = base + '_' + Math.random().toString(36).slice(2, 6);
                changed = true;
            }
            seen.add(s.id);
        });
        if (newapiMigrateAnchors(arr)) changed = true;
        if (changed) {
            try { xpSave(arr); } catch {}
        }
        return arr;
    } catch { return []; }
}
function xpSave(arr) {
    fs.writeFileSync(XP_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function xpReadActiveModel() {
    try { return fs.readFileSync(XP_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function xpReadActiveKey() {
    try { return fs.readFileSync(XP_ACTIVE_KEY_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// SSE keepalive proxy для xpeach: четвёртый экземпляр keepalive-proxy.js на :20157.
// KEY_FILE/MODELMAP_FILE параметризованы env'ом, чтобы не пересекаться с чужими инстансами.
async function xpKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(XP_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(XP_KEEPALIVE_PORT),
                UPSTREAM: XP_BASE_URL,
                KEY_FILE: XP_ACTIVE_KEY_FILE,
                MODELMAP_FILE: XP_MODELMAP_FILE,
                ...(process.env.XP_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.XP_PRE_COMMIT_MS } : {}),
            },
        });
        child.unref();
        logLine(`xpeach keepalive proxy spawn: :${XP_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`xpeach keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Пинг ключа: GET /v1/models с CC-заголовками → 200 = LIVE, 401/403 = DEAD.
async function xpProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';   // заглушка вместо ключа — пинговать нечего
    try {
        const r = await fetch(`${XP_BASE_URL}/v1/models`, {
            method: 'GET',
            headers: { ...XP_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// Баланс ключа: usage на КОРНЕ xpeach.codes (не /v1). Точный остаток — через
// обмен refresh-куки на JWT (jwt-инстанс, как tabitoken); резервы (анкер,
// угадывание) см. newapiBalance.
async function xpBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'xpeach.codes',
        ccHeaders: XP_CC_HEADERS,
        usageUrl: `${XP_BASE_URL}/dashboard/billing/usage`,
        subUrl: `${XP_BASE_URL}/v1/dashboard/billing/subscription`,
        guessGrant: spent => Math.max(XP_DEFAULT_GRANT, Math.ceil(spent / XP_GRANT_STEP) * XP_GRANT_STEP),
        force: !!opts.force,
    });
}

function xpApplyBalance(target, bal) { return newapiApplyBalance(target, bal); }

async function handleXpSessions(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = xpLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await xpProbe(s.api_key); }));
            }
            xpSave(sessions);
        }
        if (balance) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => xpApplyBalance(s, await xpBalance(s))));
            }
            xpSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: xpReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleXpPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await xpProbe(api_key);
        const sessions = xpLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; xpSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleXpBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const recalc = async (force = false) => {
            const sessions = xpLoad();
            const target = sessions.find(s => s.api_key === api_key);
            const bal = await xpBalance(target || { api_key }, { force });
            if (target) { xpApplyBalance(target, bal); xpSave(sessions); }
            return bal;
        };
        // nudge=1: мгновенный ответ, пересчёт в своём процессе (см. handleGoBalance).
        if (q.searchParams.get('nudge') === '1') {
            const queued = nudgeBalanceOnce('xp:' + api_key, recalc);
            return jsonRes(res, 200, { ok: true, queued });
        }
        jsonRes(res, 200, await recalc(true));   // клик по цифре — только свежий self
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleXpSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'xpeach', load: xpLoad, save: xpSave, balanceFn: xpBalance, applyFn: xpApplyBalance });
}

const xpLkPids = new Map();
function xpPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleXpSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = xpLoad();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const target = sessions[idx];
        const label = 'acct_' + id;

        const prevPid = xpLkPids.get(label);
        if (xpPidAlive(prevPid)) {
            logLine(`xpeach session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'xpeach', 'open-session.js');
        // xpeach — jwt-инстанс, refresh-кука одноразовая: без этой синхронизации
        // браузер уходит на refresh с погашенным значением и разлогинивается.
        newapiSyncProfile('xpeach.codes', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию по рефке; есть — сразу на баланс.
        // `mode` из тела перебивает это правило: у безключевой записи, заселённой поверх
        // предупреждения о засвете, аккаунт у провайдера скорее всего УЖЕ есть, и рефка
        // ему не нужна — нужен вход. Регистрация вместо входа там отвечает «аккаунт уже
        // создан», и выглядит это как поломка дашборда (разбор 2026-08-21).
        const wantMode = String(body.mode || '').trim();
        const mode = (wantMode === 'console' || wantMode === 'register') ? wantMode
            : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`xpeach session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`xpeach session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`xpeach session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => { xpLkPids.delete(label); logLine(`xpeach session/open: ${label} — exited (code ${code}, sig ${sig})`); });
        proc.unref();
        xpLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            xpLkPids.delete(label);
            logLine(`xpeach session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        newapiLkVisited(label);   // в ЛК могли пополнить — кеш точной цифры снят
        logLine(`xpeach session/open: ${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleXpAdd(req, res) {
    try {
        const { email, api_key, name } = await readJsonBody(req);
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = xpLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'xp_' + Date.now() + '_' + sessions.length;
        sessions.push({
            id,
            email: mail,
            name: String(name || '').trim() || mail.split('@')[0],
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
        });
        xpSave(sessions);
        logLine(`xpeach add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, id, noKey });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleXpDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = xpLoad();
        const target = sessions.find(s => s.id === idKey);
        xpSave(sessions.filter(s => s.id !== idKey));
        if (target && target.api_key === xpReadActiveKey()) {
            try { fs.rmSync(XP_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(XP_ACTIVE_MODEL_FILE, { force: true }); } catch {}
        }
        logLine(`xpeach delete: ${target ? target.email : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация через SSE keepalive-прокси :20157 (как tabi): пишем ключ в
// xpeach-active-key.txt, прокси инжектит его на каждый запрос. В settings.json —
// заглушка AUTH_TOKEN='dummy'.
async function handleXpActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        // Заглушка вместо ключа: активировать нечего (иначе уедет в xpeach-active-key.txt).
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — зарегистрируйся (🌐) и вставь ключ кнопкой 🔑' });
        const sessions = xpLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(XP_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        xpSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-xpeach');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = XP_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            // Как в handleTbActivate: delete = дефолт CC = 200k. Источник правды —
            // xpeach-active-model.txt, суффикс [1m] дотянет writeSettings().
            const xpCurModel = xpReadActiveModel() || '';
            if (xpCurModel) settings.model = xpCurModel;
            else { delete settings.model; logLine('xpeach activate: активной модели нет → settings.model снят, Claude Code поедет на 200k'); }
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';   // реальный ключ берёт keepalive из xpeach-active-key.txt
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`xpeach activate: settings.json FAILED: ${e.message}`);
        }
        await xpKeepaliveSpawn();
        logLine(`xpeach activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${XP_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу.
async function handleXpModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (XP_MODELS_CACHE.data && Date.now() - XP_MODELS_CACHE.ts < XP_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: XP_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${XP_BASE_URL}/v1/models`, {
            signal: controller.signal,
            headers: { ...XP_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
        });
        clearTimeout(timeout);
        if (!resp.ok) {
            return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}` });
        }
        const data = await resp.json();
        const models = (data.data || []).map(m => ({
            id: m.id,
            owned_by: m.owned_by,
            supported_endpoint_types: m.supported_endpoint_types || [],
        }));
        XP_MODELS_CACHE.data = models;
        XP_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (XP_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: XP_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

// Сменить активную модель: пишет xpeach-active-model.txt + settings.model. Прокси
// :20157 читает активный ключ по mtime, modelmap — свой xpeach-modelmap.json.
// [1m] дотягиваем для claude-opus/sonnet (окно контекста — свойство ID, а не апстрима).
async function handleXpSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        const settingsModel = /^claude-(opus|sonnet)-/.test(m) && !m.includes('[') ? `${m}[1m]` : m;
        fs.writeFileSync(XP_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-xpeach-model');
            settings.model = settingsModel;
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = XP_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`xpeach set-model: settings.json FAILED: ${e.message}`);
        }
        await xpKeepaliveSpawn();
        logLine(`xpeach set-model: ${m} (base ${XP_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: XP_ACTIVE_MODEL_FILE, base: XP_KEEPALIVE_URL, needRestart: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function xpReadModelMap() {
    try {
        const raw = fs.readFileSync(XP_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    } catch { return {}; }
}

// GET/POST /__switch/api/xp/modelmap → маппинг claude-тиров → xpeach-модели
// (читается keepalive-прокси :20157 по mtime — правка без рестарта).
async function handleXpModelMap(req, res) {
    try {
        if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const mm = {
                opus: String(body.opus || '').trim() || '',
                sonnet: String(body.sonnet || '').trim() || '',
                haiku: String(body.haiku || '').trim() || '',
            };
            fs.writeFileSync(XP_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
            logLine(`xpeach modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
            return jsonRes(res, 200, { ok: true, modelMap: mm });
        }
        jsonRes(res, 200, { ok: true, modelMap: xpReadModelMap() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сменить/вписать API-ключ у существующего аккаунта (как tabi set-key).
async function handleXpSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = xpLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (sessions.some(s => s.api_key === newKey && s.id !== id)) {
            return jsonRes(res, 400, { error: 'такой ключ уже занят другим аккаунтом' });
        }
        const wasActive = !!target.active;
        target.api_key = newKey;
        // Был аккаунт-заглушка, вписали настоящий ключ → снимаем 'no_key'.
        if (target.status === 'no_key' && isRealKey(newKey)) target.status = 'unknown';
        if (wasActive) {
            fs.writeFileSync(XP_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        }
        xpSave(sessions);
        logLine(`xpeach set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleXpRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = xpLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (body.name !== undefined && body.name !== null) {
            const n = String(body.name).trim();
            if (!n) return jsonRes(res, 400, { error: 'name не может быть пустым' });
            target.name = n;
        }
        if (body.email !== undefined && body.email !== null) {
            const e = String(body.email).trim();
            if (!e) return jsonRes(res, 400, { error: 'email не может быть пустым' });
            target.email = e;
        }
        xpSave(sessions);
        logLine(`xpeach rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── XPeach: share/import (передать аккаунт другу и принять чужой) ──────────
// Формат тот же, что у tabi/gorouter: base64url(JSON { v:1, provider:'xpeach',
// email, name, api_key, meta:{…}, session:{cookies,origins} }).
// storageState из xpeach/profiles/acct_<id>/.
const XP_SHARE_SCRIPT = path.join(__dirname, '..', 'xpeach', 'share-session.js');
const XP_SESSIONS_DIR = path.join(__dirname, '..', 'xpeach', 'sessions');

function xpB64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function xpB64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// POST /__switch/api/xp/share { id } → снять storageState профиля и собрать строку.
async function handleXpShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = xpLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = xpLkPids.get(label);
        if (xpPidAlive(prevPid)) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        const stateFile = path.join(XP_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [XP_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code2, sig) => resolve({ code: code2, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`xpeach share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;

        const payload = {
            v: 1,
            provider: 'xpeach',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = xpB64UrlEncode(JSON.stringify(payload));
        logLine(`xpeach share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/xp/import { share } → разобрать строку и добавить аккаунт.
async function handleXpImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(xpB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'xpeach' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не xpeach-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = xpLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'xp_' + Date.now() + '_' + sessions.length;
        const label = 'acct_' + id;
        // Цифры (выдача/потрачено/баланс/статус) приезжают в payload.meta —
        // аккаунт появляется у получателя ровно таким же, как у автора кода.
        const rec = shareApplyMeta({
            id,
            email: mail,
            name: String(payload.name || '').trim() || mail.split('@')[0],
            api_key: key,
            active: false,
            status: 'unknown',
            created: new Date().toISOString(),
            shared: true,
            importedAt: new Date().toISOString(),
        }, payload.meta);
        sessions.push(rec);
        xpSave(sessions);

        try {
            fs.mkdirSync(XP_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(XP_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`xpeach import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`xpeach import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''}${typeof rec.balance === 'number' ? ', balance ' + rec.balance : ''})`);
        jsonRes(res, 200, {
            ok: true,
            id,
            email: mail,
            hasSession: session.cookies.length > 0 || session.origins.length > 0,
            balance: typeof rec.balance === 'number' ? rec.balance : null,
            grant: typeof rec.grant === 'number' ? rec.grant : null,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── VyceAI — ключи + прокси :20131 ────────────────────────────────
// Ключи живут в vyceai/keys.json: [{ name, key }]. Имя задаёт пользователь и
// оно не зависит от порядка в файле — раньше был плоский keys.txt, имя бралось
// из позиции (key-1, key-2...), поэтому активация перетасовывала список и
// ключи visually "переименовывались".
const _vyceaiRoot = path.join(__dirname, '..');
const VYCEAI_KEYS_FILE = path.join(_vyceaiRoot, 'vyceai', 'keys.json');
const VYCEAI_LEGACY_KEYS_FILE = path.join(_vyceaiRoot, 'vyceai', 'keys.txt');
const VYCEAI_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'vyceai-active-key.txt');

function readVyceaiKeys() {
    try {
        const raw = fs.readFileSync(VYCEAI_KEYS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (Array.isArray(arr)) {
            return arr.filter(e => e && typeof e.key === 'string' && e.key.startsWith('sk-'))
                      .map((e, i) => ({ name: e.name || `key-${i + 1}`, key: e.key }));
        }
    } catch (e) {
        if (e.code !== 'ENOENT') logLine(`vyceai read keys: ${e.message}`);
    }
    // Миграция со старого плоского keys.txt — имена назначаем по позиции один раз.
    try {
        const legacy = fs.readFileSync(VYCEAI_LEGACY_KEYS_FILE, 'utf8')
            .split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('sk-'))
            .map((key, i) => ({ name: `key-${i + 1}`, key }));
        if (legacy.length) {
            writeVyceaiKeys(legacy);
            logLine(`vyceai: migrated ${legacy.length} keys from keys.txt → keys.json`);
        }
        return legacy;
    } catch { return []; }
}

function writeVyceaiKeys(keys) {
    try {
        fs.mkdirSync(path.dirname(VYCEAI_KEYS_FILE), { recursive: true });
        fs.writeFileSync(VYCEAI_KEYS_FILE, JSON.stringify(keys, null, 2) + '\n', 'utf8');
        return true;
    } catch (e) { logLine(`vyceai write keys: ${e.message}`); return false; }
}

function readVyceaiActiveKey() {
    try { return fs.readFileSync(VYCEAI_ACTIVE_KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

function writeVyceaiActiveKey(key) {
    try {
        fs.mkdirSync(path.dirname(VYCEAI_ACTIVE_KEY_FILE), { recursive: true });
        fs.writeFileSync(VYCEAI_ACTIVE_KEY_FILE, key, 'utf8');
        return true;
    } catch (e) { logLine(`vyceai write active key: ${e.message}`); return false; }
}

async function handleVyceaiStatus(req, res) {
    const keys = readVyceaiKeys();
    try {
        const upstream = await fetch('http://localhost:20131/__vyceai/api/status', {
            signal: AbortSignal.timeout(3000),
        });
        if (upstream.ok) {
            const sd = await upstream.json();
            return jsonRes(res, 200, { ...sd, keys: keys.length });
        }
    } catch {}
    jsonRes(res, 200, { ok: false, keys: keys.length });
}

async function handleVyceaiModels(req, res) {
    try {
        const upstream = await fetch('http://localhost:20131/v1/models', {
            headers: { 'Authorization': 'Bearer ' + (readVyceaiActiveKey() || readVyceaiKeys()[0]?.key || '') },
            signal: AbortSignal.timeout(8000),
        });
        if (!upstream.ok) return jsonRes(res, upstream.status, { error: 'upstream ' + upstream.status });
        const data = await upstream.json();
        const models = (data.data || []).map(m => m.id || m).sort();
        jsonRes(res, 200, { models });
    } catch (e) { jsonRes(res, 502, { error: e.message }); }
}

function handleVyceaiKeys(req, res) {
    const keys = readVyceaiKeys();
    const activeKey = readVyceaiActiveKey();
    jsonRes(res, 200, {
        keys: keys.map(k => ({
            name: k.name,
            key: k.key,
            status: k.key === activeKey ? 'active' : 'ready',
        })),
        activeKey,
    });
}

async function handleVyceaiAddKey(req, res) {
    try {
        const { name, key } = await readJsonBody(req);
        if (!key || !key.startsWith('sk-')) return jsonRes(res, 400, { error: 'key must start with sk-' });
        const keys = readVyceaiKeys();
        if (keys.some(k => k.key === key)) return jsonRes(res, 409, { error: 'Ключ уже добавлен (' + key.substring(0, 12) + '...)' });
        const label = (name || '').trim() || `key-${keys.length + 1}`;
        keys.push({ name: label, key });
        writeVyceaiKeys(keys);
        logLine(`vyceai: added key ${label} (${key.substring(0, 12)}...)`);
        jsonRes(res, 200, { ok: true, count: keys.length });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleVyceaiDeleteKey(req, res) {
    try {
        const { key } = await readJsonBody(req);
        if (!key) return jsonRes(res, 400, { error: 'key required' });
        let keys = readVyceaiKeys();
        const before = keys.length;
        keys = keys.filter(k => k.key !== key);
        if (keys.length === before) return jsonRes(res, 404, { error: 'key not found' });
        writeVyceaiKeys(keys);
        // Если удалили активный — сбросить active-key
        if (key === readVyceaiActiveKey()) {
            writeVyceaiActiveKey(keys[0]?.key || '');
        }
        logLine(`vyceai: deleted key ${key.substring(0, 16)}...`);
        jsonRes(res, 200, { ok: true, count: keys.length });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация ключа: пишем в active-key.txt (прокси :20131 читает его)
// + прокидываем в settings.json (как Aerolink/FreeModel):
//   ANTHROPIC_BASE_URL → localhost:20131 (наш прокси)
//   apiKeyHelper → читает vyceai-active-key.txt
//   TTL=0 (перечитывает на каждый запрос)
// Порядок в keys.json НЕ меняем — иначе поедут имена в таблице.
async function handleVyceaiActivate(req, res) {
    try {
        const { key } = await readJsonBody(req);
        if (!key) return jsonRes(res, 400, { error: 'key required' });
        const keys = readVyceaiKeys();
        const entry = keys.find(k => k.key === key);
        if (!entry) return jsonRes(res, 404, { error: 'key not found in pool' });
        writeVyceaiActiveKey(key);

        // Прокидываем в settings.json — как Aerolink/FreeModel
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-vyceai');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = BACKENDS.vyce_openai.base_url;
            settings.apiKeyHelper = keyHelperCmd('vyceai-active-key.txt');
            settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
            delete settings.model;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`vyceai activate: settings.json FAILED: ${e.message}`);
        }

        logLine(`vyceai activate: ${entry.name} (${key.substring(0, 12)}...) → active (pool: ${keys.length}, settings: ${settingsOk})`);
        jsonRes(res, 200, {
            ok: true,
            name: entry.name,
            key: key.substring(0, 8) + '...' + key.slice(-4),
            count: keys.length,
            settingsUpdated: settingsOk,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── Front-door: состояние и тумблер для вкладки «Настройки» ───────────────────
async function handleFrontdoorState(res) {
    try {
        const cfg = frontdoorConfig();
        let live = null;
        try {
            const r = await fetch(`http://127.0.0.1:${cfg.port}/__frontdoor/api/status`, { signal: AbortSignal.timeout(1200) });
            if (r.ok) live = await r.json();
        } catch { /* прокси лежит — так и покажем */ }
        let wiredToFrontdoor = false;
        try { wiredToFrontdoor = isFrontdoorBase((readSettings().env || {}).ANTHROPIC_BASE_URL || ''); } catch {}
        return jsonRes(res, 200, {
            enabled: cfg.enabled, port: cfg.port, url: frontdoorUrl(),
            wired: wiredToFrontdoor, state: readActiveBackend(), live,
            state_file: ACTIVE_BACKEND_FILE,
        });
    } catch (e) { return jsonRes(res, 500, { error: e.message }); }
}

// Тумблер режима. settings.json тут НЕ трогаем: адрес переедет при следующей
// активации провайдера — так и включение, и откат остаются одним кликом по ключу,
// а не гонкой двух правок файла.
async function handleFrontdoorToggle(req, res) {
    try {
        const body = await readJsonBody(req);
        const cfg = frontdoorConfig();
        const enabled = body.enabled === undefined ? !cfg.enabled : !!body.enabled;
        const port = Number(body.port) || cfg.port;
        // Мержим в существующий документ, а не перезаписываем: в файле лежит ещё и
        // пояснение для человека (`_note`), терять его при каждом клике незачем.
        let doc = {};
        try {
            const raw = fs.readFileSync(FRONTDOOR_CONFIG_FILE, 'utf8');
            doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        } catch { /* нет файла — создадим */ }
        doc.enabled = enabled;
        doc.port = port;
        fs.writeFileSync(FRONTDOOR_CONFIG_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        FD_CFG_CACHE.mtime = 0;                     // перечитать конфиг немедленно
        if (enabled) await frontdoorSpawn();        // включили — прокси обязан быть живым
        logLine(`front-door: тумблер ${enabled ? 'ON' : 'OFF'} (порт ${port})`);
        return jsonRes(res, 200, { ok: true, enabled, port, current: currentTarget() });
    } catch (e) { return jsonRes(res, 500, { error: e.message }); }
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__switch/api/status') {
        return jsonRes(res, 200, {
            current: currentTarget(),
            backends: Object.fromEntries(
                Object.entries(BACKENDS).map(([k, v]) => [k, { label: v.label, base_url: v.base_url }])
            ),
            oauth: oauthStatus(),
            settings_file: SETTINGS_FILE,
        });
    }

    // ── Front-door :20100 — состояние / тумблер / рестарт ─────────────────────
    if (req.method === 'GET' && req.url === '/__switch/api/frontdoor') {
        return handleFrontdoorState(res);
    }
    if (req.method === 'POST' && req.url === '/__switch/api/frontdoor/toggle') {
        return handleFrontdoorToggle(req, res);
    }
    if (req.method === 'POST' && req.url === '/__switch/api/frontdoor/restart') {
        return keepaliveRestart(frontdoorPort())
            .then(r => jsonRes(res, r.ok ? 200 : 500, r))
            .catch(e => jsonRes(res, 500, { error: e.message }));
    }

    // ── Health: что запущено / что упало ──────────────────────────────────────
    if (req.method === 'GET' && req.url === '/__switch/api/health') {
        return handleHealth(res);
    }

    // POST /__switch/api/health/kill { port } → убить всё, что слушает порт.
    // Безопасно: работает только с портами, которых нет среди служебных и
    // зарегистрированных custom-провайдеров (иначе можно случайно погасить ядро).
    if (req.method === 'POST' && req.url === '/__switch/api/health/kill') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { port } = JSON.parse(body || '{}');
                const p = Number(port);
                if (!p || !Number.isInteger(p) || p < 1024 || p > 65535)
                    return jsonRes(res, 400, { error: 'port required' });
                const protected = new Set([
                    LISTEN_PORT, 20126, 20130, 20131, 20132, AR_KEEPALIVE_PORT,
                    frontdoorPort(),   // убить front-door = оставить Claude Code без бэкенда
                    ...(customLoad().providers || []).map(x => x.proxyPort).filter(Boolean),
                ]);
                if (protected.has(p))
                    return jsonRes(res, 400, { error: `:${p} — конфигурируемый сервис, не дам убить` });
                const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
                let killed = 0;
                for (const line of out.split(/\r?\n/)) {
                    const m = line.match(new RegExp(`:${p}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
                    if (m) { try { execFileSync('taskkill', ['/F', '/PID', m[1]]); killed++; } catch {} }
                }
                logLine(`health kill: killed ${killed} listener(s) on :${p}`);
                jsonRes(res, 200, { ok: true, killed, port: p });
            } catch (e) { jsonRes(res, 400, { error: e.message }); }
        });
        return;
    }

    if (req.method === 'GET' && req.url.startsWith('/__switch/api/logs')) {
        const limit = parseInt(new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('limit') || '200', 10);
        return jsonRes(res, 200, { lines: LOG_BUFFER.slice(-Math.max(1, limit)) });
    }

    // Прокси (отдельные процессы) шлют сюда свои лог-строки батчами, чтобы они
    // попадали во вкладку "Server Logs" дашборда. Приходит JSON { name, lines }.
    if (req.method === 'POST' && req.url === '/__switch/api/logs/ingest') {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => {
            try {
                const { name, lines } = JSON.parse(b);
                if (!Array.isArray(lines) || !lines.length) return jsonRes(res, 400, { error: 'lines required' });
                for (const ln of lines) logLine(`[${name || 'proxy'}] ${ln}`);
                jsonRes(res, 200, { ok: true, received: lines.length });
            } catch (e) { jsonRes(res, 400, { error: e.message }); }
        });
        return;
    }

    // Проверка обновлений кода дашборда: git fetch + сколько коммитов отстаём от origin.
    if (req.method === 'GET' && req.url === '/__switch/api/dashboard/update-check') {
        try {
            const repo = path.join(__dirname, '..');
            const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
            const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
            git('fetch', '--quiet', 'origin', branch);
            const behind = parseInt(git('rev-list', '--count', `HEAD..origin/${branch}`) || '0', 10);
            const local = git('rev-parse', '--short', 'HEAD');
            const remote = git('rev-parse', '--short', `origin/${branch}`);
            return jsonRes(res, 200, { branch, behind, local, remote, upToDate: behind === 0 });
        } catch (e) { return jsonRes(res, 500, { error: e.message }); }
    }

    // POST /__switch/api/keepalive/restart {port} — пересоздать keepalive-инстанс
    // (:20133/:20155/:20156) одной операцией: kill по порту → spawn с env этого
    // инстанса → ждём /__keepalive/api/status. Так подхватывается новый код прокси.
    if (req.method === 'POST' && req.url === '/__switch/api/keepalive/restart') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { port } = JSON.parse(body || '{}');
                const r = await keepaliveRestart(Number(port));
                jsonRes(res, r.ok ? 200 : 500, r);
            } catch (e) { jsonRes(res, 400, { error: e.message }); }
        });
        return;
    }

    // Подтянуть свежий код дашборда (git pull --ff-only). Требует ручного рестарта прокси.
    // Логика «безопасного pull» (сохранить локальное состояние → checkout → pull →
    // вписать назад) живёт в tools/git-pull-safe.js — её же зовут update.sh/fix.sh.
    if (req.method === 'POST' && req.url === '/__switch/api/dashboard/update-pull') {
        try {
            const { pullSafe } = require('../tools/git-pull-safe');
            const r = pullSafe();
            if (!r.ok && r.blocking.length) {
                return jsonRes(res, 409, {
                    error: 'Обновлению мешают локальные правки в коде:\n  ' + r.blocking.join('\n  ')
                        + '\n\nОткати их (git checkout -- <файл>) или сохрани (git stash) и нажми обновление снова.',
                    dirty: r.blocking,
                });
            }
            if (!r.ok) return jsonRes(res, 500, { error: r.error || 'git pull failed' });
            if (r.preserved.length) logLine(`dashboard git pull: локальные настройки возвращены (${r.preserved.join(', ')})`);
            logLine(`dashboard git pull:\n${r.output}`);
            return jsonRes(res, 200, { ok: true, output: r.output, preserved: r.preserved, restart_required: true });
        } catch (e) {
            return jsonRes(res, 500, { error: (e.message || 'git pull failed').toString() });
        }
    }

    if (req.method === 'POST' && req.url === '/__switch/api/switch') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { target } = JSON.parse(body);
                if (!BACKENDS[target]) return jsonRes(res, 400, { error: 'Invalid target' });
                await applyTarget(target);
                jsonRes(res, 200, { ok: true, target, restart_required: true });
            } catch (e) {
                jsonRes(res, 400, { error: e.message });
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/__switch/api/settings/current') {
        return handleSettingsCurrent(res);
    }

    // Чистый рабочий шаблон для кнопки «Сбросить»: claude-settings.example.json
    // с перенесённым активным ключом/URL из текущего settings.json (чтобы сброс
    // не сбил бэкенд друга). НИЧЕГО не пишет — только отдаёт JSON в редактор.
    if (req.method === 'GET' && req.url === '/__switch/api/settings/clean-template') {
        try {
            const tplPath = path.join(__dirname, '..', 'claude-settings.example.json');
            const raw = fs.readFileSync(tplPath, 'utf8');
            const tpl = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            // подставить живой ключ/URL из текущего конфига, если он есть
            try {
                const cur = readSettings();
                if (cur.apiKeyHelper) tpl.apiKeyHelper = cur.apiKeyHelper;
                if (cur.env && cur.env.ANTHROPIC_BASE_URL) {
                    tpl.env = tpl.env || {};
                    tpl.env.ANTHROPIC_BASE_URL = cur.env.ANTHROPIC_BASE_URL;
                }
            } catch {}
            return jsonRes(res, 200, { settings: tpl });
        } catch (e) { return jsonRes(res, 500, { error: e.message }); }
    }

    if (req.method === 'POST' && req.url === '/__switch/api/settings/apply') {
        return handleSettingsApply(req, res);
    }

    // Дефолтная команда statusline для тоггла в дашборде — абсолютный путь
    // до statusline-autoreger.sh на ЭТОЙ машине (у друга диск/папка другие).
    if (req.method === 'GET' && req.url === '/__switch/api/statusline/default') {
        const sl = path.join(__dirname, 'statusline-autoreger.sh').replace(/\\/g, '/');
        return jsonRes(res, 200, { statusLine: { type: 'command', command: `bash "${sl}"` } });
    }

    // Полная перезапись settings.json (ручной JSON-редактор). Бэкап перед записью.
    if (req.method === 'POST' && req.url === '/__switch/api/settings/save') {
        (async () => {
            try {
                const { settings } = await readJsonBody(req);
                if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
                    return jsonRes(res, 400, { error: 'settings должен быть JSON-объектом' });
                }
                const bak = makeSettingsBackup('settings-preedit');
                writeSettings(settings);
                logLine(`settings.json saved manually (prev → ${bak})`);
                return jsonRes(res, 200, { ok: true, previous: bak, current: currentTarget() });
            } catch (e) { return jsonRes(res, 400, { error: e.message }); }
        })();
        return;
    }

    // MCP-серверы Claude Code из ~/.claude.json: глобальные (mcpServers) +
    // проектные (projects[*].mcpServers). У Claude Code нет флага "выключен" —
    // тоггл перекладывает конфиг в наш стэш-ключ _disabledMcpServers (Claude
    // Code его игнорирует) и обратно. Бэкап ~/.claude.json перед каждой записью.
    if (req.method === 'GET' && req.url === '/__switch/api/mcp/list') {
        try {
            const cj = readClaudeJson();
            const servers = [];
            const push = (scope, obj, enabled) => {
                for (const [name, cfg] of Object.entries(obj || {})) {
                    servers.push({
                        name, scope, enabled,
                        type: cfg.type || 'stdio',
                        command: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '),
                    });
                }
            };
            push('global', cj.mcpServers, true);
            push('global', cj._disabledMcpServers, false);
            for (const [proj, pv] of Object.entries(cj.projects || {})) {
                push(proj, pv.mcpServers, true);
                push(proj, pv._disabledMcpServers, false);
            }
            servers.sort((a, b) => (a.scope + a.name).localeCompare(b.scope + b.name));
            return jsonRes(res, 200, { file: CLAUDE_JSON_FILE, servers });
        } catch (e) { return jsonRes(res, 500, { error: e.message }); }
    }
    if (req.method === 'POST' && req.url === '/__switch/api/mcp/toggle') {
        (async () => {
            try {
                const { name, scope, enable } = await readJsonBody(req);
                if (!name || !scope) return jsonRes(res, 400, { error: 'name и scope обязательны' });
                const cj = readClaudeJson();
                const holder = scope === 'global' ? cj : (cj.projects || {})[scope];
                if (!holder) return jsonRes(res, 404, { error: `scope не найден: ${scope}` });
                const from = enable ? '_disabledMcpServers' : 'mcpServers';
                const to = enable ? 'mcpServers' : '_disabledMcpServers';
                if (!holder[from] || !(name in holder[from])) {
                    return jsonRes(res, 404, { error: `${name} не найден в ${from}` });
                }
                holder[to] = holder[to] || {};
                holder[to][name] = holder[from][name];
                delete holder[from][name];
                if (!Object.keys(holder[from]).length && from === '_disabledMcpServers') delete holder[from];
                writeClaudeJson(cj);
                logLine(`mcp ${enable ? 'enabled' : 'disabled'}: ${name} (${scope})`);
                return jsonRes(res, 200, { ok: true });
            } catch (e) { return jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }

    // Список плагинов Claude Code: установленные (plugins/installed_plugins.json)
    // ∪ включённые (settings.enabledPlugins). Тоггл делается через /settings/apply.
    if (req.method === 'GET' && req.url === '/__switch/api/plugins/list') {
        try {
            const enabled = (readSettings().enabledPlugins) || {};
            let installed = {};
            try { installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; }
            catch {}
            const ids = [...new Set([...Object.keys(installed), ...Object.keys(enabled)])].sort();
            const plugins = ids.map(id => ({ id, enabled: enabled[id] === true, installed: id in installed }));
            return jsonRes(res, 200, { plugins });
        } catch (e) { return jsonRes(res, 500, { error: e.message }); }
    }

    if (req.method === 'GET' && req.url === '/__switch/api/settings/backups') {
        return jsonRes(res, 200, { dir: SETTINGS_BACKUP_DIR, backups: listSettingsBackups() });
    }
    if (req.method === 'POST' && req.url === '/__switch/api/settings/backup') {
        (async () => {
            try { const name = makeSettingsBackup(); logLine(`settings backup: ${name}`); return jsonRes(res, 200, { ok: true, name }); }
            catch (e) { return jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }
    if (req.method === 'POST' && req.url === '/__switch/api/settings/restore') {
        (async () => {
            try {
                const { name } = await readJsonBody(req);
                const base = path.basename(String(name || ''));
                if (!BACKUP_NAME_RE.test(base)) return jsonRes(res, 400, { error: 'bad backup name' });
                const src = path.join(SETTINGS_BACKUP_DIR, base);
                if (!fs.existsSync(src)) return jsonRes(res, 404, { error: 'backup not found' });
                const raw = fs.readFileSync(src, 'utf8');
                let parsed;
                try { parsed = JSON.parse(raw.replace(/^﻿/, '')); } catch { return jsonRes(res, 400, { error: 'backup не валидный JSON' }); }
                const prev = makeSettingsBackup('settings-prerestore');
                // Восстановление — единственная запись мимо чокпоинта: пишем сырой текст,
                // чтобы вернуть ровно то, что было. Но окно контекста в «то, что было»
                // входить не должно: бэкап мог быть снят в момент, когда activate снёс
                // model, и восстановление молча вернуло бы 200k. Поэтому если чокпоинт
                // тронул бы модель — идём через него, иначе оставляем текст как есть.
                const fixed = Object.assign({}, parsed);
                fixed.model = normalizeCcModel(typeof fixed.model === 'string' && fixed.model.trim()
                    ? fixed.model : resolveCcModel(fixed));
                if (fixed.model && fixed.model !== parsed.model) {
                    writeSettings(fixed);
                    logLine(`settings restored from ${base} + модель дотянута до ${fixed.model} (prev → ${prev})`);
                } else {
                    fs.writeFileSync(SETTINGS_FILE, raw, 'utf8');
                    logLine(`settings restored from ${base} (prev → ${prev})`);
                }
                return jsonRes(res, 200, { ok: true, restored: base, previous: prev });
            } catch (e) { return jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }
    if (req.method === 'POST' && req.url === '/__switch/api/settings/backup-delete') {
        (async () => {
            try {
                const { name } = await readJsonBody(req);
                const base = path.basename(String(name || ''));
                if (!BACKUP_NAME_RE.test(base)) return jsonRes(res, 400, { error: 'bad backup name' });
                const f = path.join(SETTINGS_BACKUP_DIR, base);
                if (fs.existsSync(f)) fs.unlinkSync(f);
                return jsonRes(res, 200, { ok: true, deleted: base });
            } catch (e) { return jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }

    // OmniRoute creds (URL + manage key) for tokenrouter import — routing/.env, live.
    if (req.url === '/__switch/api/env') {
        if (req.method === 'GET') {
            const e = readEnvFile();
            return jsonRes(res, 200, {
                OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL || e.OMNIROUTE_BASE_URL || 'http://localhost:20128',
                OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY || e.OMNIROUTE_API_KEY || '',
            });
        }
        if (req.method === 'POST') {
            (async () => {
                try {
                    const body = await readJsonBody(req);
                    const updates = {};
                    if (typeof body.OMNIROUTE_BASE_URL === 'string') {
                        const u = body.OMNIROUTE_BASE_URL.trim().replace(/\/+$/, '');
                        if (!/^https?:\/\/.+/.test(u)) return jsonRes(res, 400, { error: 'URL должен начинаться с http:// или https://' });
                        updates.OMNIROUTE_BASE_URL = u;
                    }
                    if (typeof body.OMNIROUTE_API_KEY === 'string') {
                        const k = body.OMNIROUTE_API_KEY.trim();
                        if (!k) return jsonRes(res, 400, { error: 'OMNIROUTE_API_KEY пустой' });
                        updates.OMNIROUTE_API_KEY = k;
                    }
                    if (!Object.keys(updates).length) return jsonRes(res, 400, { error: 'нечего сохранять' });
                    upsertEnvFile(updates);
                    logLine(`env updated: ${Object.keys(updates).join(', ')}`);
                    return jsonRes(res, 200, { ok: true, applied: Object.keys(updates) });
                } catch (e) {
                    return jsonRes(res, 500, { error: e.message });
                }
            })();
            return;
        }
    }

    if (req.method === 'POST' && req.url === '/__switch/api/whoami') {
        return handleWhoami(req, res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/accounts') {
        return handleAccounts(res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/notion/sessions') {
        return handleNotionSessions(res);
    }

    if (req.method === 'GET' && req.url.startsWith('/__switch/api/freemodel/sessions')) {
        return handleFreemodelSessions(req, res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/freemodel/invites') {
        return handleFreemodelInvites(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/set-invite') {
        return handleFreemodelSetInvite(req, res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/freemodel/email-backend') {
        return handleFreemodelGetEmailBackend(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/email-backend') {
        return handleFreemodelSetEmailBackend(req, res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/freemodel/email-domain') {
        return handleFreemodelGetEmailDomain(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/email-domain') {
        return handleFreemodelSetEmailDomain(req, res);
    }

    if (req.method === 'GET' && req.url.startsWith('/__switch/api/devin/sessions')) {
        return handleDevinSessions(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/accounts/toggle') {
        return handleOmniToggle(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/session/open') {
        return handleSessionOpen(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/session/refresh-quota') {
        return handleSessionRefreshQuota(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/session/delete') {
        return handleSessionDelete(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/grok-build') {
        return handleGrokBuild(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/grok/launch-terminal') {
        return handleGrokLaunchTerminal(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/grok/start-auth') {
        return handleGrokStartAuth(req, res);
    }

    // Подставить auth.json профиля в ~/.grok (default CLI) — после restart grok = этот аккаунт
    if (req.method === 'POST' && req.url === '/__switch/api/grok/activate') {
        return handleGrokActivate(req, res);
    }
    if (req.method === 'POST' && req.url === '/__switch/api/grok/launch-chrome') {
        return handleGrokLaunchChrome(req, res);
    }
    if (req.method === 'POST' && req.url === '/__switch/api/grok/launch') {
        return handleGrokLaunch(req, res);
    }
    if (req.method === 'GET' && req.url === '/__switch/api/grok/active') {
        return handleGrokActive(req, res);
    }

    if (req.method === 'GET' && req.url.startsWith('/__switch/api/grok/terminal-status')) {
        return handleGrokTerminalStatus(req, res);
    }

    if (req.method === 'GET' && req.url === '/__switch/api/notion/cards') {
        return handleNotionCards(res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/notion/card-select') {
        return handleNotionCardSelect(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/launch') {
        return handleLaunch(req, res);
    }

    if (req.method === 'POST' && req.url === '/__switch/api/launch-bat') {
        return handleLaunchBat(req, res);
    }

    // ---- TG pool routes ----
    if (req.method === 'GET'  && req.url === '/__switch/api/tg/list')        return handleTgList(res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/add-hex')     return handleTgAddHex(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/add-bulk')    return handleTgAddBulk(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/add-session') return handleTgAddSession(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/delete')      return handleTgDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/mark-free')   return handleTgMarkFree(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/rename')      return handleTgRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/open')        return handleTgOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tg/health-check') return handleTgHealthCheck(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/tg/health-progress') return handleTgHealthProgress(res);

    // ---- AnyModel accounts ----
    if (req.method === 'GET'  && req.url === '/__switch/api/anymodel/accounts') return handleAmodelAccounts(res);
    if (req.method === 'GET'  && req.url === '/__switch/api/anymodel/tg-stats') return handleAmodelTgStats(res);
    if (req.method === 'POST' && req.url === '/__switch/api/anymodel/launch')  return handleAmodelLaunch(req, res);

    // ---- FreeModel ban/unban marker ----
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/ban')      return handleFreemodelBan(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/set-tg')   return handleFreemodelSetTg(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/bind-telegram') return handleFreemodelBindTelegram(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/set-key')      return handleFreemodelSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/add-manual')   return handleFreemodelAddManual(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/extract-key')  return handleFreemodelExtractKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/activate')     return handleFreemodelActivate(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/freemodel/models')) return handleFreemodelModels(req, res);

    // ---- VyceAI — ключи + прокси :20131 ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/vyceai/status'))   return handleVyceaiStatus(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/vyceai/models'))  return handleVyceaiModels(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/vyceai/keys'))     return handleVyceaiKeys(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/vyceai/add-key')         return handleVyceaiAddKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/vyceai/delete-key')      return handleVyceaiDeleteKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/vyceai/activate')        return handleVyceaiActivate(req, res);

    // ---- Aerolink (al) — ручной пул, активация через API Helper ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/al/sessions')) return handleAlSessions(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/al/add')       return handleAlAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/al/delete')    return handleAlDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/al/activate')  return handleAlActivate(req, res);

    // ---- Cun (cun) — пул cun.ai: AUTH_TOKEN + BASE_URL без /v1 (doc.cun.ai) ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/cun/sessions')) return handleCunSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/cun/ping'))     return handleCunPing(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/cun/add')       return handleCunAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/cun/delete')    return handleCunDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/cun/activate')  return handleCunActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/cun/set-model') return handleCunSetModel(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/cun/models')) return handleCunModels(req, res);

    // ---- Evomap (ev) — ручной пул, активация через API Helper (api.evomap.ai/v1) ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ev/sessions')) return handleEvSessions(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ev/add')       return handleEvAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ev/delete')    return handleEvDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ev/activate')  return handleEvActivate(req, res);

    // ---- Ourtoken (ot) — ручной пул, активация через API Helper (api.ourtoken.ai/v1) ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ot/sessions')) return handleOtSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ot/ping'))     return handleOtPing(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ot/add')       return handleOtAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ot/delete')    return handleOtDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ot/activate')  return handleOtActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ot/set-model') return handleOtSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ot/to-omni')   return handleOtToOmni(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ot/models')) return handleOtModels(req, res);

    // ---- AgentRouter (ar) — ручной пул ключей (agentrouter.org), API Helper ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ar/sessions')) return handleArSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ar/ping'))     return handleArPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ar/balance'))  return handleArBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/add')       return handleArAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/delete')    return handleArDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/activate')  return handleArActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/set-model') return handleArSetModel(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/ar/modelmap') return handleArModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/modelmap') return handleArModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/set-balance') return handleArSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/map-profiles') return handleArMapProfiles(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/set-github') return handleArSetGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/session/open') return handleArSessionOpen(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ar/models')) return handleArModels(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/ar/active-model') return jsonRes(res, 200, { model: arReadActiveModel() || null });
    if (req.method === 'POST' && req.url === '/__switch/api/ar/share')    return handleArShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/import')   return handleArImport(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/rename')   return handleArRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/key')      return handleArSetKey(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/ar/checkin-config') return handleArCheckinConfig(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/checkin-config') return handleArCheckinConfig(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/checkin-mark')   return handleArCheckinMark(req, res);

    // Keepalive-мост (хедж-конфиг :20133/:20155/:20156/:20157) — реальное время без рестарта.
    if (req.method === 'GET'  && req.url === '/__switch/api/keepalive/state')  return keepaliveAr.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/keepalive/config') return keepaliveAr.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/tb/keepalive/state')  return keepaliveTb.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/keepalive/config') return keepaliveTb.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/go/keepalive/state')  return keepaliveGo.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/keepalive/config') return keepaliveGo.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/xp/keepalive/state')  return keepaliveXp.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/keepalive/config') return keepaliveXp.config(req, res);

    // ---- GoRouter (go) — автономная вкладка, прямой baseUrl без прокси ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/go/sessions')) return handleGoSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/go/ping'))     return handleGoPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/go/balance'))  return handleGoBalance(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/go/models'))   return handleGoModels(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/go/active-model') return jsonRes(res, 200, { model: goReadActiveModel() || null });
    if (req.method === 'GET'  && req.url === '/__switch/api/go/modelmap') return jsonRes(res, 200, { ok: true, modelMap: goReadModelMap() });
    if (req.method === 'POST' && req.url === '/__switch/api/go/add')       return handleGoAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/key')       return handleGoSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/rename')    return handleGoRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/delete')    return handleGoDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/activate')  return handleGoActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/set-model') return handleGoSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/set-balance') return handleGoSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/map-profiles') return handleGoMapProfiles(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/modelmap')  return handleGoModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/session/open') return handleGoSessionOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/share')    return handleGoShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/import')   return handleGoImport(req, res);

    // ---- Tabi (tb) — автономная вкладка, keepalive :20155 → tabitoken.com ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/tb/sessions')) return handleTbSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/tb/ping'))     return handleTbPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/tb/balance'))  return handleTbBalance(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/tb/models'))   return handleTbModels(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/tb/active-model') return jsonRes(res, 200, { model: tbReadActiveModel() || null });
    if (req.method === 'GET'  && req.url === '/__switch/api/tb/modelmap') return jsonRes(res, 200, { ok: true, modelMap: tbReadModelMap() });
    if (req.method === 'POST' && req.url === '/__switch/api/tb/add')       return handleTbAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/key')       return handleTbSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/rename')    return handleTbRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/delete')    return handleTbDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/activate')  return handleTbActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/set-model') return handleTbSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/set-balance') return handleTbSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/map-profiles') return handleTbMapProfiles(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/modelmap')  return handleTbModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/session/open') return handleTbSessionOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/share')    return handleTbShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/import')   return handleTbImport(req, res);

    // ---- XPeach (xp) — автономная вкладка, keepalive :20157 → xpeach.codes ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/xp/sessions')) return handleXpSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/xp/ping'))     return handleXpPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/xp/balance'))  return handleXpBalance(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/xp/models'))   return handleXpModels(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/xp/active-model') return jsonRes(res, 200, { model: xpReadActiveModel() || null });
    if (req.method === 'GET'  && req.url === '/__switch/api/xp/modelmap') return jsonRes(res, 200, { ok: true, modelMap: xpReadModelMap() });
    if (req.method === 'POST' && req.url === '/__switch/api/xp/add')       return handleXpAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/key')       return handleXpSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/rename')    return handleXpRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/delete')    return handleXpDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/activate')  return handleXpActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/set-model') return handleXpSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/set-balance') return handleXpSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/map-profiles') return handleXpMapProfiles(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/modelmap')  return handleXpModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/session/open') return handleXpSessionOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/share')    return handleXpShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/import')   return handleXpImport(req, res);

    // ---- OmniRoute (om) — ручной пул, активация через API Helper ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/om/sessions')) return handleOmSessions(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/om/add')       return handleOmAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/om/delete')    return handleOmDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/om/activate')  return handleOmActivate(req, res);

    // ---- Video API (vid) — хранилище ключей видео-провайдеров ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/video/keys')) return handleVideoKeys(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/video/add')          return handleVideoAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/video/delete')       return handleVideoDelete(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/video/trials')) return handleVideoTrials(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/video/trial-status')  return handleVideoTrialStatus(req, res);

    // ---- Image API (img) — хранилище ключей картинко-провайдеров ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/image/keys')) return handleImageKeys(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/image/add')          return handleImageAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/image/delete')       return handleImageDelete(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/image/trials')) return handleImageTrials(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/image/trial-status')  return handleImageTrialStatus(req, res);

    // ---- GitHub-аккаунты (gh) — хранилище купленных аккаунтов + TOTP в браузере ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/gh/keys'))    return handleGhKeys(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/gh/add')             return handleGhAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/gh/import')          return handleGhImport(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/gh/delete')          return handleGhDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/gh/update')          return handleGhUpdate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/gh/open')            return handleGhOpen(req, res);
    // Заселение готовой GitHub-сессии в новый аккаунт New-API-вкладок (ar/go/tb/xp).
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/gh/available')) return handleGhAvailable(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/add-github')       return handleArAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/add-github')       return handleGoAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/add-github')       return handleTbAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/add-github')       return handleXpAddGithub(req, res);

    // ---- Svrtr — пул ТГ-аккаунтов, активация через API Helper ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/svrtr/sessions'))    return handleSvrtrSessions(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/svrtr/active-key')          return handleSvrtrActiveKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/svrtr/refresh-quota')       return handleSvrtrRefreshQuota(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/svrtr/activate')            return handleSvrtrActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/svrtr/autoreg')             return handleSvrtrAutoreg(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/svrtr/add')                 return handleSvrtrAdd(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/svrtr/models'))       return handleSvrtrModels(req, res);

    // ---- HelpCoder — авторег username+password, активация через API Helper ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/helpcoder/sessions'))    return handleHelpcoderSessions(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/helpcoder/active-key')          return handleHelpcoderActiveKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/helpcoder/refresh-quota')       return handleHelpcoderRefreshQuota(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/helpcoder/activate')            return handleHelpcoderActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/helpcoder/autoreg')             return handleHelpcoderAutoreg(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/helpcoder/add')                 return handleHelpcoderAdd(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/helpcoder/models'))       return handleHelpcoderModels(req, res);

    // ---- Conduit (cdt) — пул ТГ-аккаунтов, активация через API Helper ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/conduit/sessions'))  return handleConduitSessions(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/conduit/active-key')          return handleConduitActiveKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/conduit/refresh-quota')       return handleConduitRefreshQuota(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/conduit/activate')            return handleConduitActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/conduit/autoreg')             return handleConduitAutoreg(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/conduit/add')                 return handleConduitAdd(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/conduit/models'))       return handleConduitModels(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/conduit/set-model')          return handleConduitSetModel(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/conduit/active-model')       return jsonRes(res, 200, { model: cdtReadActiveModel() || null });

    // ---- Custom providers (произвольные провайдеры: имя + baseUrl + ключи) ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/custom/providers'))       return handleCustomProviders(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/provider')                return handleCustomProviderCreate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/provider/update')          return handleCustomProviderUpdate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/provider/delete')          return handleCustomProviderDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/key')                      return handleCustomKeyAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/key/update')               return handleCustomKeyUpdate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/key/delete')               return handleCustomKeyDelete(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/custom/ping'))             return handleCustomPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/custom/models'))           return handleCustomModels(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/modelmap')                 return handleCustomModelMap(req, res);
if (req.method === 'POST' && req.url === '/__switch/api/custom/scan')                   return handleCustomScan(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/mode')                   return handleCustomMode(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/activate')               return handleCustomActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/custom/deactivate')               return handleCustomDeactivate(req, res);

    // ---- FreeModel авто-подмена мёртвого аккаунта ($0 → следующий) ----
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/auto/start') {
        (async () => {
            try {
                const body = await readJsonBody(req).catch(() => ({}));
                const r = fmAutoStart(body || {});
                jsonRes(res, 200, { ok: true, ...fmAutoStatus(), helperChanged: r.helper?.changed, helperError: r.helper?.error });
            } catch (e) { jsonRes(res, 500, { error: e.message }); }
        })();
        return;
    }
    if (req.method === 'POST' && req.url === '/__switch/api/freemodel/auto/stop') {
        fmAutoStop();
        return jsonRes(res, 200, { ok: true, ...fmAutoStatus() });
    }
    if (req.method === 'GET' && req.url === '/__switch/api/freemodel/auto/status') {
        return jsonRes(res, 200, fmAutoStatus());
    }

    if (req.method === 'GET' && req.url === '/__switch/api/freemodel/active-key') {
        (async () => {
            try {
                const cwd = process.cwd();
                process.chdir(path.join(__dirname, '..'));
                let activeKey, activeName = null;
                try {
                    activeKey = dashApi.getActiveFreemodelKey();
                    if (activeKey) {
                        const sessions = await dashApi.listFreemodelSessions({ withQuotas: false });
                        const match = sessions.find(s => s.meta?.apiKey === activeKey || (() => {
                            try {
                                const infoFile = path.join(s.path, 'account_info.txt');
                                if (fs.existsSync(infoFile)) {
                                    const m = fs.readFileSync(infoFile, 'utf-8').match(/^API Key:\s*((?:fe[_-]|sk-)[A-Za-z0-9_-]{20,})/m);
                                    return m && m[1] === activeKey;
                                }
                            } catch {}
                            return false;
                        })());
                        if (match) activeName = match.name;
                    }
                } finally { process.chdir(cwd); }
                jsonRes(res, 200, { activeKey: activeKey ? activeKey.slice(0, 12) + '...' + activeKey.slice(-6) : null, activeName });
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    // ---- TokenRouter routes ----
    if (req.method === 'GET' && req.url === '/__switch/api/tokenrouter/omniroute-connections') {
        (async () => {
            try {
                const response = await fetch(`${omniBase()}/api/providers`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${omniKey()}` },
                });
                if (!response.ok) throw new Error(`providers ${response.status}`);
                const data = await response.json();
                const list = data.connections || [];
                const connections = list.filter(p =>
                    p.provider === 'openai-compatible-chat-8f2ae822-58f2-49b4-b212-393f686b00c5'
                ).map(p => ({
                    id: p.id,
                    name: p.name,
                    email: p.email,
                }));
                logLine(`tokenrouter omniroute connections: ${connections.length}`);
                jsonRes(res, 200, { connections });
            } catch (e) {
                logLine(`tokenrouter omniroute connections failed: ${e.message}`);
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'GET' && req.url === '/__switch/api/tokenrouter/accounts') {
        try {
            if (!fs.existsSync(TOKENROUTER_ACCOUNTS)) {
                return jsonRes(res, 200, { accounts: [] });
            }
            const accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
            const safe = accounts.map(a => ({
                email: a.email,
                password: a.password,
                apiKey: a.apiKey,
                apiKeyMask: a.apiKey ? '…' + a.apiKey.slice(-8) : null,
                apiKeyName: a.apiKeyName,
                createdAt: a.createdAt,
            }));
            jsonRes(res, 200, { accounts: safe });
        } catch (e) {
            jsonRes(res, 500, { error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/delete') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });
                if (!fs.existsSync(TOKENROUTER_ACCOUNTS))
                    return jsonRes(res, 404, { error: 'no accounts file' });
                let accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
                const before = accounts.length;
                accounts = accounts.filter(a => a.email !== email);
                fs.writeFileSync(TOKENROUTER_ACCOUNTS, JSON.stringify(accounts, null, 2), 'utf8');
                logLine(`tokenrouter: deleted ${email} (${before} -> ${accounts.length})`);
                jsonRes(res, 200, { ok: true, remaining: accounts.length });
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/add') {
        (async () => {
            try {
                const { email, apiKey } = await readJsonBody(req);
                if (!email || !apiKey) return jsonRes(res, 400, { error: 'email + apiKey required' });
                if (!/^sk-[A-Za-z0-9]{20,}$/.test(apiKey)) return jsonRes(res, 400, { error: 'bad key format' });

                let accounts = [];
                if (fs.existsSync(TOKENROUTER_ACCOUNTS)) {
                    accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
                }
                const existing = accounts.find(a => a.email === email);
                if (existing) {
                    existing.apiKey = apiKey;
                    existing.apiKeyName = existing.apiKeyName || 'manual';
                } else {
                    accounts.push({
                        email, apiKey, apiKeyName: 'manual',
                        createdAt: new Date().toISOString().substring(0, 19) + 'Z',
                        cookies: [],
                    });
                }
                fs.writeFileSync(TOKENROUTER_ACCOUNTS, JSON.stringify(accounts, null, 2), 'utf8');
                logLine(`tokenrouter: manual add ${email} (total: ${accounts.length})`);
                jsonRes(res, 200, { ok: true, total: accounts.length });
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/open') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });
                const result = dashApi.openTokenrouterSession(email);
                logLine(`tokenrouter open: ${email} → ${result.ok ? 'OK' : result.error}`);
                jsonRes(res, result.ok ? 200 : 400, result);
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'GET' && req.url === '/__switch/api/tokenrouter/health-cache') {
        try {
            const TR_HEALTH = path.join(__dirname, '..', 'logs', '.tokenrouter_health.json');
            const cache = fs.existsSync(TR_HEALTH) ? JSON.parse(fs.readFileSync(TR_HEALTH, 'utf-8')) : {};
            jsonRes(res, 200, cache);
        } catch (e) {
            jsonRes(res, 200, {});
        }
        return;
    }

    if (req.method === 'GET' && req.url === '/__switch/api/tokenrouter/usage-cache') {
        try {
            const TR_USAGE = path.join(__dirname, '..', 'logs', '.tokenrouter_usage.json');
            const usage = fs.existsSync(TR_USAGE) ? JSON.parse(fs.readFileSync(TR_USAGE, 'utf-8')) : {};
            jsonRes(res, 200, usage);
        } catch (e) {
            jsonRes(res, 200, {});
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/refresh-usage') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });
                if (!fs.existsSync(TOKENROUTER_ACCOUNTS))
                    return jsonRes(res, 404, { error: 'no accounts file' });
                const accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
                const acc = accounts.find(a => a.email === email);
                if (!acc || !acc.apiKey) return jsonRes(res, 404, { error: 'account or key not found' });
                const result = await dashApi.checkTokenrouterUsage(acc.apiKey, email);
                logLine(`tokenrouter usage: ${email} → $${(result.todayCost || 0).toFixed(4)} / $1.00`);
                jsonRes(res, 200, result);
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/check-key') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });
                if (!fs.existsSync(TOKENROUTER_ACCOUNTS))
                    return jsonRes(res, 404, { error: 'no accounts file' });
                const accounts = JSON.parse(fs.readFileSync(TOKENROUTER_ACCOUNTS, 'utf8'));
                const acc = accounts.find(a => a.email === email);
                if (!acc || !acc.apiKey) return jsonRes(res, 404, { error: 'account or key not found' });
                const result = await dashApi.checkTokenrouterKey(acc.apiKey, email);
                logLine(`tokenrouter check: ${email} → ${result.ok ? 'OK' : 'DEAD (' + result.status + ')'}`);
                jsonRes(res, 200, result);
            } catch (e) {
                jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/import-to-omniroute') {
        (async () => {
            try {
                const { email, apiKey } = await readJsonBody(req);
                if (!email || !apiKey) return jsonRes(res, 400, { error: 'email and apiKey required' });
                const stdout = execFileSync('node', [path.join(__dirname, 'tokenrouter', 'omniroute-api-client.js'), email, apiKey], {
                    encoding: 'utf8',
                    maxBuffer: 1024 * 1024,
                    timeout: 60000,
                    env: process.env,
                });
                const lines = stdout.trim().split(/\r?\n/);
                let summary = null;
                try { summary = JSON.parse(lines[lines.length - 1]); } catch {}
                logLine(`tokenrouter import to omniroute: ${email} → ${summary?.ok ? 'OK' : (summary?.error || 'done')}`);
                jsonRes(res, 200, { ok: true, output: stdout, summary });
            } catch (e) {
                logLine(`tokenrouter import to omniroute failed: ${e.message}`);
                jsonRes(res, 500, { error: e.message || 'import failed' });
            }
        })();
        return;
    }

    if (req.method === 'POST' && req.url === '/__switch/api/tokenrouter/delete-from-omniroute') {
        (async () => {
            try {
                const { email } = await readJsonBody(req);
                if (!email) return jsonRes(res, 400, { error: 'email required' });

                const response = await fetch(`${omniBase()}/api/providers`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${omniKey()}` },
                });
                if (!response.ok) throw new Error(`providers ${response.status}`);
                const data = await response.json();
                const list = data.connections || [];
                const match = list.find(p =>
                    p.provider === 'openai-compatible-chat-8f2ae822-58f2-49b4-b212-393f686b00c5' &&
                    (p.name === email || p.email === email)
                );
                if (!match) {
                    logLine(`tokenrouter delete from omniroute: ${email} not found`);
                    return jsonRes(res, 200, { ok: true, deleted: false, reason: 'not found' });
                }
                const del = await fetch(`${omniBase()}/api/providers/${match.id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${omniKey()}` },
                });
                if (!del.ok) throw new Error(`delete ${del.status}`);
                logLine(`tokenrouter delete from omniroute: ${match.id.substring(0, 8)} (${email})`);
                return jsonRes(res, 200, { ok: true, deleted: true, id: match.id });
            } catch (e) {
                logLine(`tokenrouter delete from omniroute failed: ${e.message}`);
                return jsonRes(res, 500, { error: e.message });
            }
        })();
        return;
    }

    // ---- Freemodel Rotator proxy ----
    if (req.method === 'GET' && req.url === '/__switch/api/rotator/status') {
        const rotOpts = { hostname: '127.0.0.1', port: 20126, path: '/__fmrot/api/status', method: 'GET', timeout: 3000 };
        const rotReq = http.request(rotOpts, (rotRes) => {
            let b = '';
            rotRes.on('data', c => b += c);
            rotRes.on('end', () => {
                try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(b); }
                catch { jsonRes(res, 200, {}); }
            });
        });
        rotReq.on('error', () => jsonRes(res, 200, { error: 'rotator not running', keys: [], totalRequests: 0, activeCount: 0, totalCount: 0 }));
        rotReq.end();
        return;
    }

    // ---- Freemodel Rotator generic proxy (avoids CORS) ----
    if (req.method === 'POST' && req.url === '/__switch/api/rotator/proxy') {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => {
            try {
                const { path: rotPath, method: rotMethod, body: rotBody } = JSON.parse(b);
                const bodyStr = rotBody ? JSON.stringify(rotBody) : '';
                const rotOpts = {
                    hostname: '127.0.0.1', port: 20126,
                    path: rotPath || '/__fmrot/api/status',
                    method: rotMethod || 'GET',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
                    timeout: 15000,
                };
                const rotReq = http.request(rotOpts, (rotRes) => {
                    let rb = '';
                    rotRes.on('data', c => rb += c);
                    rotRes.on('end', () => {
                        try { res.writeHead(rotRes.statusCode, { 'Content-Type': 'application/json' }); res.end(rb); }
                        catch { jsonRes(res, 500, { error: 'proxy error' }); }
                    });
                });
                rotReq.on('error', () => jsonRes(res, 502, { error: 'rotator not running' }));
                if (bodyStr) rotReq.write(bodyStr);
                rotReq.end();
            } catch (e) { jsonRes(res, 400, { error: e.message }); }
        });
        return;
    }

    // Статус launcher.py для UI. GET = отчёт, POST = принудительный рестарт.
    if (req.url === '/__switch/api/grok/health') {
        if (req.method === 'GET') {
            return (async () => {
                const alive = await grokLauncherIsAlive();
                if (alive && grokLauncherState !== 'running') grokLauncherState = 'running';
                jsonRes(res, 200, {
                    state: grokLauncherState,
                    alive,
                    port: GROK_LAUNCHER_PORT,
                    path: GROK_LAUNCHER_PATH,
                    exists: fs.existsSync(GROK_LAUNCHER_PATH),
                    lastErr: grokLauncherLastErr || '',
                });
            })();
        }
        if (req.method === 'POST') {
            return (async () => {
                grokLauncherStop();
                await new Promise(r => setTimeout(r, 300));
                await grokLauncherStart();
                jsonRes(res, 200, { ok: true, state: grokLauncherState });
            })();
        }
        return jsonRes(res, 405, { error: 'method not allowed' });
    }

    // ---- Grok cookie sessions on disk (backing store for dashboard tab) ------
    if (req.url.startsWith('/__switch/api/grok/sessions')) {
        // Куки живут в grok-launcher/cookies в самой репе. Fallback на legacy-путь,
        // если новый пуст и старый существует (не терять сохранённые сессии
        // Anatol/basavaraj/malGtok1 у пользователя после апгрейда).
        const grokDir = grokCookiesDir();
        const sanitize = (name) => String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
        const ensureDir = () => { try { fs.mkdirSync(grokDir, { recursive: true }); } catch {} };
        // Мета (cooldown и прочее) отдельным файлом рядом с cookies:
        //   1acc.json      — сами куки
        //   1acc.meta.json — { cooldownUntil: 1720000000000, ... }
        // Это позволяет не трогать формат кук и не смешивать данные.
        const metaPathFor = (safe) => path.join(grokDir, `${safe}.meta.json`);
        const loadMeta = (safe) => {
            try { return JSON.parse(fs.readFileSync(metaPathFor(safe), 'utf8')) || {}; } catch { return {}; }
        };
        const saveMeta = (safe, meta) => {
            ensureDir();
            const cleaned = {};
            for (const [k, v] of Object.entries(meta || {})) {
                if (v !== null && v !== undefined) cleaned[k] = v;
            }
            if (!Object.keys(cleaned).length) {
                try { fs.unlinkSync(metaPathFor(safe)); } catch {}
            } else {
                fs.writeFileSync(metaPathFor(safe), JSON.stringify(cleaned, null, 2));
            }
        };
        const listSessions = () => {
            ensureDir();
            let files = [];
            try { files = fs.readdirSync(grokDir).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json')); } catch { return []; }
            return files.map(f => {
                const full = path.join(grokDir, f);
                const safe = f.replace(/\.json$/, '');
                try {
                    const stat = fs.statSync(full);
                    const cookies = JSON.parse(fs.readFileSync(full, 'utf8'));
                    const termStatus = getGrokTerminalStatus(safe);
                    return {
                        name: safe,
                        cookies,
                        savedAt: stat.mtime.toISOString(),
                        cookieCount: Array.isArray(cookies) ? cookies.length : Object.keys(cookies || {}).length,
                        meta: loadMeta(safe),
                        terminalStatus: termStatus
                    };
                } catch (e) {
                    return { name: safe, error: e.message };
                }
            });
        };

        if (req.method === 'GET' && req.url === '/__switch/api/grok/sessions') {
            return jsonRes(res, 200, {
                sessions: listSessions(),
                active: getDefaultGrokActive(),
            });
        }

        if (req.method === 'POST' && req.url === '/__switch/api/grok/sessions') {
            let b = '';
            req.on('data', c => b += c);
            req.on('end', () => {
                try {
                    const { name, cookies } = JSON.parse(b);
                    const safe = sanitize(name);
                    if (!safe) return jsonRes(res, 400, { error: 'name required' });
                    if (!cookies) return jsonRes(res, 400, { error: 'cookies required' });
                    ensureDir();
                    fs.writeFileSync(path.join(grokDir, `${safe}.json`), JSON.stringify(cookies, null, 2));
                    return jsonRes(res, 200, { ok: true, name: safe, sessions: listSessions() });
                } catch (e) { return jsonRes(res, 400, { error: e.message }); }
            });
            return;
        }

        // POST /__switch/api/grok/sessions/<name>/meta
        //   body: { cooldownHours: 4 }  → cooldownUntil = now + 4h
        //   body: { cooldownUntil: null } → снять cooldown
        //   body: { cooldownUntil: <ms> } → задать явное время
        //   body: { note: "reason..." } → произвольная заметка
        // Мета сохраняется рядом (<name>.meta.json). Файл с куками не трогается.
        const metaMatch = req.url.match(/^\/__switch\/api\/grok\/sessions\/([^/]+)\/meta$/);
        if (req.method === 'POST' && metaMatch) {
            const safe = sanitize(decodeURIComponent(metaMatch[1]));
            if (!safe) return jsonRes(res, 400, { error: 'name required' });
            let b = '';
            req.on('data', c => b += c);
            req.on('end', () => {
                try {
                    const patch = JSON.parse(b || '{}');
                    const cur = loadMeta(safe);
                    if ('cooldownHours' in patch) {
                        const h = Number(patch.cooldownHours);
                        if (!isFinite(h) || h < 0) return jsonRes(res, 400, { error: 'bad cooldownHours' });
                        cur.cooldownUntil = h > 0 ? Date.now() + h * 3600 * 1000 : null;
                        cur.cooldownHours = h > 0 ? h : null;
                        cur.cooldownStartedAt = h > 0 ? Date.now() : null;
                    } else if ('cooldownUntil' in patch) {
                        cur.cooldownUntil = patch.cooldownUntil === null ? null : Number(patch.cooldownUntil);
                        if (patch.cooldownUntil === null) { cur.cooldownStartedAt = null; cur.cooldownHours = null; }
                    }
                    if ('note' in patch) cur.note = patch.note ? String(patch.note).slice(0, 500) : null;
                    saveMeta(safe, cur);
                    return jsonRes(res, 200, { ok: true, name: safe, meta: cur, sessions: listSessions() });
                } catch (e) { return jsonRes(res, 400, { error: e.message }); }
            });
            return;
        }

        // POST /__switch/api/grok/sessions/<name>/refresh-quota
        // Дёргает launcher :8765/quota с куками сессии, сохраняет ответ в мету
        // под ключом `quota`. Возвращает свежий { sessions } чтобы UI сразу
        // перерисовался. Синхронно ждём завершения probe (~10-15с).
        const quotaMatch = req.url.match(/^\/__switch\/api\/grok\/sessions\/([^/]+)\/refresh-quota$/);
        if (req.method === 'POST' && quotaMatch) {
            const safe = sanitize(decodeURIComponent(quotaMatch[1]));
            if (!safe) return jsonRes(res, 400, { error: 'name required' });
            const cookiesPath = path.join(grokDir, `${safe}.json`);
            if (!fs.existsSync(cookiesPath)) return jsonRes(res, 404, { error: 'session not found' });
            let cookies;
            try {
                cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
            } catch (e) {
                return jsonRes(res, 500, { error: 'bad cookies file: ' + e.message });
            }
            // POST на launcher — если не отвечает, возвращаем ошибку с подсказкой.
            const body = JSON.stringify({ cookies });
            const opts = {
                host: '127.0.0.1', port: GROK_LAUNCHER_PORT,
                path: '/quota', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: 60000,
            };
            const proxyReq = http.request(opts, (proxyRes) => {
                let chunks = '';
                proxyRes.setEncoding('utf8');
                proxyRes.on('data', (c) => chunks += c);
                proxyRes.on('end', () => {
                    try {
                        const data = JSON.parse(chunks || '{}');
                        if (proxyRes.statusCode >= 400 || data.detail) {
                            return jsonRes(res, proxyRes.statusCode || 500, { error: data.detail || 'quota probe failed', raw: data });
                        }
                        const cur = loadMeta(safe);
                        cur.quota = data;
                        cur.quotaFetchedAt = Date.now();
                        saveMeta(safe, cur);
                        return jsonRes(res, 200, { ok: true, quota: data, sessions: listSessions() });
                    } catch (e) {
                        return jsonRes(res, 500, { error: 'bad launcher response: ' + e.message });
                    }
                });
            });
            proxyReq.on('error', (e) => jsonRes(res, 502, {
                error: `launcher unreachable: ${e.message} — проверь что python launcher.py запущен`,
            }));
            proxyReq.on('timeout', () => { proxyReq.destroy(); jsonRes(res, 504, { error: 'quota probe timeout (60s)' }); });
            proxyReq.write(body);
            proxyReq.end();
            return;
        }

        if (req.method === 'DELETE' && req.url.startsWith('/__switch/api/grok/sessions/')) {
            const safe = sanitize(decodeURIComponent(req.url.split('/').pop()));
            if (!safe) return jsonRes(res, 400, { error: 'name required' });
            const full = path.join(grokDir, `${safe}.json`);
            try { fs.unlinkSync(full); } catch (e) { if (e.code !== 'ENOENT') return jsonRes(res, 500, { error: e.message }); }
            // Мету тоже сносим — сессии больше нет.
            try { fs.unlinkSync(metaPathFor(safe)); } catch {}
            return jsonRes(res, 200, { ok: true, sessions: listSessions() });
        }

        return jsonRes(res, 405, { error: 'method not allowed' });
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/__switch' || req.url === '/__switch/')) {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'proxy-dashboard.html'), 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
              'Pragma': 'no-cache',
              'Expires': '0',
            });
            return res.end(html);
        } catch (e) {
            res.writeHead(500); return res.end('Dashboard not found: ' + e.message);
        }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. UI: /__switch  API: /__switch/api/{status,switch}');
});

// ---- Grok Cookie Launcher supervisor -----------------------------------------
// launcher.py (grok-launcher/launcher.py в репе) слушает :8765 и инжектит
// куки через CDP в новый изолированный Chrome. Дашборд бьёт напрямую в
// http://localhost:8765/launch, поэтому если процесс не запущен — UI показывает
// "Connection failed: NetworkError". Раньше нужно было руками запускать python
// launcher.py; теперь этот блок делает это сам при старте transparent-proxy.
const GROK_LAUNCHER_PATH_REPO = path.join(__dirname, '..', 'grok-launcher', 'launcher.py');
// Legacy: старая локация до переноса launcher.py в репу. Если репный файл
// отсутствует, а legacy есть — используем его, чтобы не сломать существующие установки.
const GROK_LAUNCHER_PATH_LEGACY = 'D:\\WORMALIENAIGIGANT\\app\\grok-cookie-mcp\\launcher.py';
const GROK_LAUNCHER_PATH = fs.existsSync(GROK_LAUNCHER_PATH_REPO)
    ? GROK_LAUNCHER_PATH_REPO
    : GROK_LAUNCHER_PATH_LEGACY;
const GROK_LAUNCHER_PORT = 8765;

// Резолвер папки cookies. Всегда возвращает репный путь. При первом старте,
// если репная папка пуста, а legacy `D:\WORMALIENAIGIGANT\app\grok-cookie-mcp\cookies`
// не пустая — одноразово копируем оттуда всё (авто-миграция). Ничего не удаляем.
// Учитывает env GROK_COOKIE_DIR для явного override.
function grokCookiesDir() {
    if (process.env.GROK_COOKIE_DIR) return process.env.GROK_COOKIE_DIR;
    const repoDir = path.join(__dirname, '..', 'grok-launcher', 'cookies');
    const legacyDir = 'D:\\WORMALIENAIGIGANT\\app\\grok-cookie-mcp\\cookies';
    try { fs.mkdirSync(repoDir, { recursive: true }); } catch {}
    const listJson = (d) => { try { return fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch { return []; } };
    const repoFiles = listJson(repoDir);
    if (repoFiles.length === 0) {
        const legacyFiles = listJson(legacyDir);
        if (legacyFiles.length) {
            let n = 0;
            for (const f of legacyFiles) {
                try { fs.copyFileSync(path.join(legacyDir, f), path.join(repoDir, f)); n++; } catch {}
            }
            if (n) console.log(`  Grok cookies: авто-миграция ${n} файлов из ${legacyDir} → ${repoDir}`);
        }
    }
    return repoDir;
}
let grokLauncherProc = null;
let grokLauncherState = 'idle'; // idle | starting | running | failed | disabled
let grokLauncherLastErr = '';   // последние ~800 байт stderr — для UI-диагностики

async function grokLauncherIsAlive() {
    return new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1', port: GROK_LAUNCHER_PORT, path: '/', method: 'GET', timeout: 800,
        }, (r) => { r.resume(); resolve(r.statusCode ? true : false); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

async function grokLauncherStart() {
    if (!fs.existsSync(GROK_LAUNCHER_PATH)) {
        grokLauncherState = 'disabled';
        console.log(`  Grok launcher: ${GROK_LAUNCHER_PATH} не найден — пропуск`);
        return;
    }
    if (await grokLauncherIsAlive()) {
        grokLauncherState = 'running';
        console.log(`  Grok launcher: уже слушает :${GROK_LAUNCHER_PORT} — не трогаю`);
        return;
    }
    grokLauncherState = 'starting';
    const cwd = path.dirname(GROK_LAUNCHER_PATH);
    // detached, не унаследовать stdio, чтобы supervisor не блокировал прокси при
    // рестарте лаунчера и чтобы Ctrl+C по прокси не убивал Chrome через него.
    const proc = spawn(process.env.PYTHON || 'python', [GROK_LAUNCHER_PATH], {
        cwd,
        env: {
            ...process.env,
            PORT: String(GROK_LAUNCHER_PORT),
            // Чтобы launcher просил switcher самостоятельно спавнить grok-Chrome
            // (python->chrome умирает, node->chrome работает).
            SWITCHER_BASE: `http://localhost:${LISTEN_PORT}`,
            // Явно указываем launcher-у ту же папку cookies, что читает proxy
            // (важно если сработал legacy-fallback).
            GROK_COOKIE_DIR: grokCookiesDir(),
        },
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    grokLauncherProc = proc;
    grokLauncherLastErr = '';
    // ВАЖНО: 'error' обязателен. Без него ENOENT/EACCES от spawn крашит весь
    // процесс proxy как unhandled EventEmitter error — дашборд молча падает,
    // пользователь видит "NetworkError" на всех endpoint'ах.
    proc.on('error', (err) => {
        const msg = `[grok-launcher] spawn error: ${err.code || ''} ${err.message}\n`;
        process.stderr.write(msg);
        grokLauncherLastErr = (grokLauncherLastErr + msg).slice(-800);
        grokLauncherState = 'failed';
    });
    try { proc.stdout.on('data', (b) => process.stdout.write(`[grok-launcher] ${b}`)); } catch {}
    try {
        proc.stderr.on('data', (b) => {
            process.stderr.write(`[grok-launcher!] ${b}`);
            grokLauncherLastErr = (grokLauncherLastErr + b.toString()).slice(-800);
        });
    } catch {}
    proc.on('exit', (code) => {
        console.log(`  Grok launcher exited: code=${code}`);
        grokLauncherProc = null;
        grokLauncherState = code === 0 ? 'idle' : 'failed';
    });
    // Poll до 10с; если поднялся — running, иначе failed (но процесс оставляем — может ещё догрузится).
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await grokLauncherIsAlive()) {
            grokLauncherState = 'running';
            console.log(`  Grok launcher: OK на http://localhost:${GROK_LAUNCHER_PORT}/`);
            return;
        }
    }
    grokLauncherState = 'failed';
    console.log(`  Grok launcher: НЕ поднялся за 10с (проверь python + fastapi/uvicorn)`);
}

// Аккуратно валим лаунчер при остановке прокси, иначе останется висеть на :8765.
function grokLauncherStop() {
    if (grokLauncherProc && !grokLauncherProc.killed) {
        try { grokLauncherProc.kill(); } catch {}
    }
}
process.on('SIGINT',  () => { grokLauncherStop(); process.exit(0); });
process.on('SIGTERM', () => { grokLauncherStop(); process.exit(0); });
process.on('SIGBREAK', () => { grokLauncherStop(); process.exit(0); });
process.on('exit',    () => { grokLauncherStop(); });

// Ловим любую утекшую ошибку — иначе процесс тихо помрёт, а UI начнёт возвращать
// NetworkError на всех запросах. Логируем громко и продолжаем работать.
process.on('uncaughtException', (err) => {
    console.error('[proxy] uncaughtException:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (err) => {
    console.error('[proxy] unhandledRejection:', err && (err.stack || err.message || err));
});

server.listen(LISTEN_PORT, () => {
    console.log(`Switcher panel on http://localhost:${LISTEN_PORT}/`);
    console.log(`  edits ${SETTINGS_FILE}`);
    console.log(`  current target: ${currentTarget()}`);
    console.log(`  backends: ${Object.keys(BACKENDS).join(', ')}`);

    // Громко про нативный модуль: без собранного better-sqlite3 куки профилей не
    // читаются вообще, и точный баланс AR/GO/TB молча превращается в «~ прикидку».
    // На свежей машине это самая частая причина, а по UI она раньше не читалась.
    try {
        const nlib = newapiLib();
        const be = nlib && nlib.cookieBackendReady ? nlib.cookieBackendReady() : null;
        if (be && !be.ok) {
            console.log(`  ⚠ better-sqlite3 не собран (${be.error})`);
            console.log(`    → точный баланс AgentRouter/GoRouter/Tabi работать НЕ будет: npm rebuild better-sqlite3`);
        }
    } catch {}

    // Индекс GitHub-сессий по профилям — греем в фоне, чтобы модалка «🐙 Взять готовый
    // GitHub» не платила за первый скан (см. ghWarmIndexOnBoot).
    ghWarmIndexOnBoot();

    // Папку репо могли перенести — статуслайн в settings.json прописан абсолютным
    // путём, поправляем ссылку на свою копию скрипта (см. healStatuslinePath).
    {
        const healed = healStatuslinePath();
        if (healed) {
            console.log(`  statusline: путь поправлен на ${path.join(__dirname, 'statusline-autoreger.sh')}`);
            logLine(`statusline heal: ${healed.from} → ${healed.to}`);
        }
    }

    // Одноразовая миграция agentrouter-аккаунтов на стабильный id (модель gorouter):
    // выдаём id и переименовываем старые профили ar_<sha1> → acct_<id>, чтобы не потерять сессии.
    try { arMigrateIds(); } catch (e) { console.log(`  ar-migrate skip: ${e.message}`); }

    // Одноразовая очистка health-кэша от phone'ов, которых уже нет в пуле —
    // иначе кэш растёт бесконтрольно и путает UI после массовых переимпортов.
    try {
        const orphans = tgHealth.pruneOrphans();
        if (orphans) console.log(`  tg-health: очистил ${orphans} осиротевших записей`);
    } catch (e) { console.log(`  tg-health prune skip: ${e.message}`); }

    // Возобновляем авто-подмену FreeModel, если она была включена до рестарта.
    if (fmAutoLoadPersist()) {
        console.log('  FreeModel auto-failover ($0): resuming (was enabled)');
        fmAutoStart();
    }

    // Автостарт Grok launcher — чтобы UI-вкладка «Grok Cookie Sessions» работала
    // сразу после запуска дашборда, без ручного `python launcher.py`.
    grokLauncherStart().catch(e => console.log('  Grok launcher start error:', e.message));

    // AgentRouter-прокси (:20132) и keepalive-прокси (:20133) для claude-*/gpt-* через agentrouter.
    arProxySpawn().then(r => {
        if (!r.ok) console.log('  ar proxy spawn error:', r.error || '?');
        else if (!r.already) console.log('  ar proxy spawned');
    }).catch(e => console.log('  ar proxy spawn error:', e.message));
    arKeepaliveSpawn().then(r => {
        if (!r.ok) console.log('  keepalive proxy spawn error:', r.error || '?');
        else if (!r.already) console.log('  keepalive proxy spawned');
    }).catch(e => console.log('  keepalive proxy spawn error:', e.message));

    // Front-door (:20100) — единый вход Claude Code. Поднимаем всегда: с включённым
    // тумблером это единственный бэкенд CC, а с выключенным просто ждёт наготове,
    // чтобы включение не требовало рестарта дашборда.
    frontdoorSpawn().then(r => {
        if (!r.ok) console.log('  front-door spawn error:', r.error || '?');
        else if (!r.already) console.log(`  front-door spawned on :${frontdoorPort()}`);
        if (frontdoorConfig().enabled) console.log(`  front-door: ВКЛЮЧЁН, активный бэкенд ${currentTarget()}`);
    }).catch(e => console.log('  front-door spawn error:', e.message));

    // Keepalive активного бэкенда: он тоже умер вместе с прошлым дашбордом, а на boot
    // поднимался только agentrouter — активный gorouter/tabi/xpeach оставлял CC без
    // апстрима и с непрозрачным 502 на каждый запрос.
    bootSpawnActiveBackend().then(r => {
        if (r && !r.ok) console.log('  active backend keepalive spawn error:', r.error || '?');
        else if (r && !r.already) console.log('  active backend keepalive spawned');
    }).catch(e => console.log('  active backend keepalive spawn error:', e.message));
});

