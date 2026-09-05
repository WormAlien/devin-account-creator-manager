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
// Минутные бакеты времени ответа: тот же модуль пишет keepalive-proxy.js. Дашборд читает
// историю С ДИСКА, когда прокси провайдера не запущен — иначе график был бы только у
// активного бэкенда, а у остальных «не отвечает» при готовых данных в файле рядом.
const latencyStore = require('./latency-store.js');

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
    kktoken: {
        label: 'KKtoken',
        base_url: 'http://localhost:20161',
        api_key: 'dummy',           // real key keepalive reads from kktoken-active-key.txt
        model: null,
        clear_helper: true,
        // SSE keepalive-прокси (keepalive-proxy.js :20161) → kktoken.cc (БЕЗ /v1).
        // Активация через handleKkActivate (пишет ANTHROPIC_AUTH_TOKEN='dummy'),
        // ключ живёт в kktoken-active-key.txt и инжектится прокси на каждый запрос.
        // 🪤 Через keepalive обязательно: у kktoken каждый четвёртый ответ — пустой 403,
        // ретраи моста это гасят, прямой baseUrl отдал бы отказ Claude Code в лицо.
    },
    hcnsec: {
        label: 'HCNsec',
        base_url: 'http://localhost:20162',
        api_key: 'dummy',           // real key keepalive reads from hcnsec-active-key.txt
        model: null,
        clear_helper: true,
        // SSE keepalive-прокси (keepalive-proxy.js :20162) → api.hcnsec.cn (БЕЗ /v1).
        // Активация через handleHnActivate (пишет ANTHROPIC_AUTH_TOKEN='dummy'),
        // ключ живёт в hcnsec-active-key.txt и инжектится прокси на каждый запрос.
        // 🪤 Корень без /v1 обязателен: `/v1/v1/messages` → 404 `Invalid URL`, а
        // `/messages` без префикса отдаёт 200 с HTML — потеря даст мусор, не ошибку.
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
    justwoker: {
        label: 'JustWoker',
        base_url: 'http://localhost:20158',
        api_key: 'dummy',           // real key keepalive reads from justwoker-active-key.txt
        model: null,
        clear_helper: true,
        // SSE keepalive-прокси (keepalive-proxy.js :20158) → api.justwoker.icu (БЕЗ /v1).
        // Активация через handleJwActivate (пишет ANTHROPIC_AUTH_TOKEN='dummy'),
        // ключ живёт в justwoker-active-key.txt и инжектится прокси на каждый запрос.
        // 🪤 Корень без /v1 обязателен: `/v1/v1/messages` отдаёт 404 (замер 22.08).
    },
    seekai: {
        label: 'SeekAi',
        base_url: 'http://localhost:20159',
        api_key: 'dummy',           // real key keepalive reads from seekai-active-key.txt
        model: null,
        clear_helper: true,
        // SSE keepalive-прокси (keepalive-proxy.js :20159) → seekai.cc (БЕЗ /v1).
        // Активация через handleSkActivate (пишет ANTHROPIC_AUTH_TOKEN='dummy'),
        // ключ живёт в seekai-active-key.txt и инжектится прокси на каждый запрос.
        // 🪤 Корень без /v1 обязателен: `/v1/v1/messages` отдаёт 404 (замер 24.08).
    },
    truesota: {
        label: 'TrueSOTA',
        base_url: 'http://localhost:20160',
        api_key: 'dummy',           // real key keepalive reads from truesota-active-key.txt
        model: null,
        clear_helper: true,
        // SSE keepalive-прокси (keepalive-proxy.js :20160) → true-sota.com (БЕЗ /v1).
        // 🪤 ГЛАВНОЕ про этот шлюз: рабочих моделей ДВЕ — `claude-opus-5` и
        // `claude-opus-5-thinking`. Остальные 16 из каталога подменяют системный промпт
        // агента промптом Kiro (~4.1–6.9к токенов префикса) и на `system` не реагируют:
        // замер 25.08 на `system: "тебя зовут NAIL-7"` даёт «My name is Kiro», причём
        // даже когда та же инструкция уехала в сообщение пользователя. Поэтому тир-карта
        // truesota-modelmap.json — opus-only во ВСЕХ тирах, включая haiku.
    },
};

const LOG_BUFFER = [];
const LOG_BUFFER_MAX = 2000;

// Строки прокси приезжают через /logs/ingest с префиксом `[имя]` после метки времени —
// по нему вкладки лога и разделяют дашборд от SSE-прокси (см. обработчик /api/logs).
const INGEST_TAG_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[([\w.@-]+)\]/;
// Лог одного прогона автоподарка (RUN_LOG в agentrouter/open-session.js).
const CHECKIN_LOG_RE = /^ar-checkin-[\w.-]+\.log$/;

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
// glm-5.3 — единственная не-claude модель с окном 1M (04.09, владелец): без [1m]
// CC режет её до 200k так же, как опусы. Прочие glm-* и gpt-* не трогаем: у gpt
// окно доезжает через model-windows.json, а у старых glm оно не заявлено.
// Regex живёт ВНУТРИ функции: check-1m.js исполняет её в песочнице вырезкой.
function normalizeCcModel(m) {
    const s = String(m || '').trim();
    if (!s) return s;
    return /^(claude-(opus|sonnet)-|glm-5\.3(?:$|-))/.test(s) && !s.includes('[') ? `${s}[1m]` : s;
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
    justwoker: 'justwoker',
    seekai: 'seekai',
    truesota: 'truesota',
    kktoken: 'kktoken',
    hcnsec: 'hcnsec',
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

// ── История финансов ────────────────────────────────────────────────────────
// sessions.json хранит только снимок «здесь и сейчас»: spent, balance и штамп
// проверки. Прошлых значений не хранил никто, поэтому нарисовать расход по дням
// было физически нечем. Теперь каждый чек баланса, изменивший цифры, дописывает
// строку сюда — из этих дельт вкладка «Финансы» и собирает график.
// Формат: одна JSON-строка на событие, append-only, без перезаписи файла.
const FINANCE_HISTORY_FILE = path.join(__dirname, 'finance-history.jsonl');
const FINANCE_HISTORY_MAX_BYTES = 8 * 1024 * 1024;   // ~40k событий, дальше режем половину
// Настоящие токены пишет front-door :20100 (usage-tap.js) — через него идут ВСЕ
// харнессы. До 25.08 вкладка «Финансы» объём работы ОЦЕНИВАЛА, деля расход на
// зашитые $25 за 1M, и занижала его примерно в 12 раз: реальная ставка шлюзов
// ≈ $2.05 за 1M. Здесь этот журнал только читается.
const TOKEN_USAGE_FILE = path.join(__dirname, 'token-usage.jsonl');
function financeLog(entry) {
    try {
        fs.appendFileSync(FINANCE_HISTORY_FILE, JSON.stringify(entry) + '\n');
        // Обрезка: файл растёт вечно, а график смотрит максимум на месяц назад.
        // Режем по строкам, а не по байтам, чтобы не оставить обрубок строки.
        const st = fs.statSync(FINANCE_HISTORY_FILE);
        if (st.size > FINANCE_HISTORY_MAX_BYTES) {
            const lines = fs.readFileSync(FINANCE_HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
            fs.writeFileSync(FINANCE_HISTORY_FILE, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
        }
    } catch (e) { /* история — не критичный путь, чек баланса ронять нельзя */ }
}

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
// front-door. Так новый режим не размазан по хендлерам (см. docs/frontdoor-concept.md).
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

// Чем перезапускают дашборд — зависит от системы, и говорить это должен бэкенд:
// про платформу знает он, браузер — нет. Поэтому подсказка едет в теле ответа, а не
// зашита во фронт строкой «restart-dashboard.bat» (на маке такого файла нет).
function restartHint() {
    return process.platform === 'darwin'
        ? 'двойной клик по DASHBOARD.command (или bash routing/restart-dashboard.sh)'
        : 'routing/restart-dashboard.bat';
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

// ---- Keepalive-мост (хедж-конфиг :20133/:20155/:20156/:20157/:20158) -------
// Дашборд ходит только через /__switch/api/... — кидаем запрос в keepalive-прокси
// (GET /__state, POST /__config). Порт передаём параметром — один мост
// обслуживает все keepalive-инстансы (AgentRouter, Tabi, GoRouter, XPeach, JustWoker).
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
        // port в ошибке — не украшение: по нему панель предлагает поднять мёртвый
        // прокси, не зашивая номера портов в разметку (они настраиваются env'ом).
        if (!r.ok || !r.data) return jsonRes(res, 502, { error: 'keepalive :' + port + ' не отвечает', port });
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
                if (!r.ok || !r.data) return jsonRes(res, 502, { error: 'keepalive :' + port + ' не отвечает', port });
                logLine(`keepalive config :${port} -> ${JSON.stringify(patch)}`);
                return jsonRes(res, 200, r.data);
            } catch (e) { return jsonRes(res, 400, { error: e.message }); }
        });
        req.on('error', () => jsonRes(res, 400, { error: 'read error' }));
    }

    // GET .../keepalive/latency?window=<сек> → история времени ответа для графика.
    //
    // Прокси провайдера может быть НЕ ЗАПУЩЕН — это норма: keepalive поднимается под
    // активный бэкенд, остальные лежат. Но история за сутки при этом лежит в файле
    // рядом, и «график только у активного провайдера» — не то, чего от него ждут.
    // Поэтому: живой процесс → из памяти, иначе → с диска (`source: 'file'`).
    async function handleLatency(req, res) {
        const qi = req.url.indexOf('?');
        const win = qi >= 0 ? (new URLSearchParams(req.url.slice(qi + 1)).get('window') || '') : '';
        const apiPath = '/__latency' + (win ? '?window=' + encodeURIComponent(win) : '');
        const r = await keepaliveFetch('GET', apiPath, null, port);
        if (r.ok && r.status === 200 && r.data && Array.isArray(r.data.points)) {
            return jsonRes(res, 200, Object.assign({ source: 'live', port }, r.data));
        }
        // 404 = процесс поднят из кода без этой ручки (график добавлен 21.08); молчание =
        // не запущен вовсе. Оба случая читаются с диска одинаково, различие — только в
        // подписи для человека, поэтому его и передаём.
        const st = latencyStore.readFile(latencyStore.fileFor(port, __dirname));
        if (st && st.buckets.length) {
            const data = latencyStore.series(st.buckets, win, st);
            return jsonRes(res, 200, Object.assign({
                source: 'file', port,
                proxy_state: r.ok && r.status === 404 ? 'stale' : 'down',
            }, data));
        }
        if (r.ok && r.status === 404) {
            return jsonRes(res, 409, {
                error: 'прокси :' + port + ' запущен на старом коде — перезапусти его '
                    + '(Здоровье → 🔄 перезапустить), график появится сразу', port, stale: true,
            });
        }
        // Ни процесса, ни файла: провайдер ещё ни разу не работал с этой версией прокси.
        return jsonRes(res, 200, Object.assign({
            source: 'empty', port, proxy_state: 'down',
        }, latencyStore.series([], win, {})));
    }

    return { state: handleState, config: handleConfig, latency: handleLatency };
}

// Инстансы моста: AgentRouter :20133, Tabi :20155, GoRouter :20156, XPeach :20157,
// JustWoker :20158, SeekAi :20159, TrueSOTA :20160, KKtoken :20161, HCNsec :20162.
const keepaliveAr = makeKeepaliveHandlers(Number(process.env.AR_KEEPALIVE_PORT || 20133));
const keepaliveTb = makeKeepaliveHandlers(Number(process.env.TB_KEEPALIVE_PORT || 20155));
const keepaliveGo = makeKeepaliveHandlers(Number(process.env.GO_KEEPALIVE_PORT || 20156));
const keepaliveXp = makeKeepaliveHandlers(Number(process.env.XP_KEEPALIVE_PORT || 20157));
const keepaliveJw = makeKeepaliveHandlers(Number(process.env.JW_KEEPALIVE_PORT || 20158));
const keepaliveSk = makeKeepaliveHandlers(Number(process.env.SK_KEEPALIVE_PORT || 20159));
const keepaliveTs = makeKeepaliveHandlers(Number(process.env.TS_KEEPALIVE_PORT || 20160));
const keepaliveKk = makeKeepaliveHandlers(Number(process.env.KK_KEEPALIVE_PORT || 20161));
const keepaliveHn = makeKeepaliveHandlers(Number(process.env.HN_KEEPALIVE_PORT || 20162));


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
        { name: 'Keepalive JustWoker', port: Number(process.env.JW_KEEPALIVE_PORT || 20158), path: '/__keepalive/api/status', keepalive: true },
        { name: 'Keepalive SeekAi',   port: Number(process.env.SK_KEEPALIVE_PORT || 20159), path: '/__keepalive/api/status', keepalive: true },
        { name: 'Keepalive TrueSOTA', port: Number(process.env.TS_KEEPALIVE_PORT || 20160), path: '/__keepalive/api/status', keepalive: true },
        { name: 'Keepalive KKtoken',  port: Number(process.env.KK_KEEPALIVE_PORT || 20161), path: '/__keepalive/api/status', keepalive: true },
        { name: 'Keepalive HCNsec',   port: Number(process.env.HN_KEEPALIVE_PORT || 20162), path: '/__keepalive/api/status', keepalive: true },
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

// Плашки «где уже используется» едут вместе со списком аккаунтов, отдельного роута нет:
// один запрос = карточки и плашки физически не могут разойтись. ghUsageMap читает пять
// маленьких JSON-пулов, сети и профилей браузера не касается (см. ghUsageMap ниже).
async function handleGhKeys(req, res) {
    try { jsonRes(res, 200, { keys: ghLoad(), usage: ghUsageMap() }); }
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
        // Возраст «от рега»: месячные аккаунты AgentRouter не пропускает, поэтому
        // покупка помечается прямо при импорте. null = не указан (старые записи).
        regAge: ['month', 'year'].includes(raw.regAge) ? raw.regAge : null,
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
        if (patch.regAge !== undefined) cur.regAge = ['month', 'year'].includes(patch.regAge) ? patch.regAge : null;
        if (patch.note !== undefined) cur.note = String(patch.note || '').trim();
        ghSave(keys);
        logLine(`github update: ${cur.login} (статус ${cur.status}, возраст ${cur.regAge || 'не указан'})`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Честный ответ ручек session/open ────────────────────────────────────
//
// Все семь ручек (github, ar, go, tb, xp, jw, sk) спавнят видимый Chromium detached-процессом
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

// ───── ⭐ Кнопка звезды в менеджере: браузер под ГОТОВОЙ куки-сессией аккаунта ─────
//
// Что делает: открывает окно, уже залогиненное этим GitHub, прямо на странице
// репозитория владельца — остаётся нажать Star.
//
// Почему это НЕ «handleGhOpen с другим URL». Персональных профилей в github/profiles на
// диске ОДИН на 36 аккаунтов менеджера, то есть «чистый профиль → страница логина» здесь
// обычный случай, а не исключение. Живые куки при этом есть: 32 из 36 аккаунтов лежат
// снимком storageState в github/sessions/<ghId>.json (харвест снял их из профилей шлюзов).
// Поэтому здесь тот же каскад, что у заселения: кеш → харвест из свободного
// профиля-источника, а вливает снимок open-session.js через addCookies.
// Замер 2026-08-22 на трёх снимках (1.1 / 15.0 / 82.9 ч): снимок в чистом профиле даёт
// HTTP 200 без редиректа на /login, meta[name="user-login"] совпадает с ghLogin, кнопка
// Star на месте — механизм состоятелен.
//
// URL — КОНСТАНТА НА СЕРВЕРЕ и из тела запроса не принимается осознанно: :8200 слушает
// 0.0.0.0 без аутентификации, и «открой произвольную страницу в залогиненном GitHub
// владельца» — это чужая команда из локальной сети, а не гибкость.
const GH_STAR_REPO_URL = 'https://github.com/WormAlien/hub-cc';

function ghProfileDir(label) {
    return path.join(__dirname, '..', 'github', 'profiles', label);
}

// Нужен ли этому профилю снимок сессии.
//
// 🪤 Признак «профиль пустой» (нет `Default/Preferences`) для этого НЕ годится, хотя
// напрашивается: Chromium создаёт Preferences при ПЕРВОМ ЖЕ запуске — залогинились в нём
// или нет. На таком признаке ⭐ деградировала навсегда: стоило один раз открыть аккаунт
// кнопкой «Открыть GitHub» и не довести вход (2FA не прошла, окно закрыли) — и снимок
// больше не вливался никогда, а тост при этом уверял «сессия: профиль уже залогинен».
// Найдено ревью 2026-08-22 на живом `acct_gh_1786643427100_ecjje`: Preferences есть,
// а в индексе у него `login=null, hasUserSession=false`, то есть сессии нет.
//
// Поэтому спрашиваем то, что нужно на самом деле: есть ли в профиле ЖИВАЯ GitHub-сессия.
// Ответ уже собран индексом профилей — тем же, на котором стоит пикер «🐙 из менеджера».
// Индекса про профиль нет → считаем, что сессии нет: лишний раз влить снимок безопаснее,
// чем открыть анонимное окно и соврать в тосте.
function ghProfileNeedsSession(gsl, label) {
    const dir = ghProfileDir(label);
    if (!fs.existsSync(dir)) return true;
    try {
        const rec = gsl.profilesFromIndex().find(p => String(p.dir).toLowerCase() === dir.toLowerCase());
        return !rec || !rec.hasUserSession;
    } catch { return true; }
}

// Отдать URL УЖЕ ОТКРЫТОМУ браузеру этого профиля через ProcessSingleton: второй запуск
// того же бинаря с тем же --user-data-dir не поднимает второе окно, а передаёт вкладку
// живому инстансу и выходит. Замер 2026-08-22: код 0 за 146 мс, ctx.pages() 1→2, окно
// одно. Ждать процесс синхронно тут правильно: штатный выход 0 — норма, не падение.
//
// 🪤 Работает только пока профиль держит ГОЛОВНОЙ chrome.exe — а он у нас головной и есть
// (open-session.js запускается headless:false). С headless-хостом playwright поднимает
// другой бинарь (chrome-headless-shell.exe), ProcessSingleton у него нет, и такой спавн
// сажает на профиль ВТОРОЙ инстанс с видимым окном (замерено: 9 процессов). Поэтому этот
// путь применяется только здесь и только при живом pid.
function ghHandoffUrl(profileDir, url) {
    return new Promise(resolve => {
        let exe;
        try { exe = require('playwright').chromium.executablePath(); }
        catch (e) { return resolve({ ok: false, error: `playwright недоступен: ${e.message}` }); }
        const proc = spawn(exe, [`--user-data-dir=${profileDir}`, '--no-first-run', url],
            { detached: false, stdio: 'ignore' });
        const timer = setTimeout(() => {
            try { proc.kill(); } catch {}
            resolve({ ok: false, error: 'передача вкладки не завершилась за 8 с' });
        }, 8000);
        proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
        proc.on('exit', code => {
            clearTimeout(timer);
            resolve(code === 0 ? { ok: true } : { ok: false, error: `chrome вышел с кодом ${code}` });
        });
    });
}

// Один аккаунт — один харвест за раз. И ⭐, и пикер «🐙 из менеджера» зовут ghHarvest, а он
// пишет github/sessions/<ghId>.json обычным writeFileSync: два писателя одного файла дают
// порванный снимок. state.ghStarBusy на фронте от этого не спасает — он живёт в одной вкладке.
const ghHarvestInFlight = new Set();

// Общий бюджет на перебор источников. У популярных ников их до семи, каждый ghHarvest
// ограничен своими 60 с — без общего лимита один клик висел бы до семи минут, и всё это
// время кнопка в ⏳, а у fetch на фронте таймаута нет вообще.
const GH_STAR_HARVEST_BUDGET_MS = 120_000;

// Снимок сессии для аккаунта: кеш, иначе харвест из самого свежего СВОБОДНОГО профиля.
// Это тот же каскад, что в newapiAddGithub (там он вплетён в проверки пула и force,
// поэтому не выношу общим куском — риск сломать заселение шлюзов выше выгоды).
async function ghStarSnapshot(acct) {
    const gsl = ghSessionLib();
    if (!gsl) return { error: 'модуль github-session недоступен' };
    const nick = String(acct.nickname || acct.login || '').trim();
    if (!nick) return { error: 'у аккаунта нет ни ника, ни логина' };

    let snap = gsl.readCache(acct.id);
    if (snap && gsl.cacheStale(snap)) snap = null;           // старше TTL — перечитать
    if (snap) return { snap, path: gsl.cachePath(acct.id), from: 'кеш' };

    const entry = gsl.indexByLogin().get(nick.toLowerCase());
    const sources = (entry ? entry.sources : []).filter(s => s.hasUserSession);
    if (!sources.length) {
        // 🪤 Прежде чем сказать «сессии нет», проверь, есть ли вообще индекс профилей: его
        // собирает отдельный процесс, и на холодном :8200 (или после dropIndex) он пуст.
        // Совет «залогинься руками» на пустом индексе вреден дважды — он неверен, и он
        // создаёт профиль без сессии, которому потом нужен тот же самый снимок.
        const info = gsl.indexInfo();
        if (!info.exists) {
            ghRebuildIndex('нет индекса (⭐)');
            return { error: 'индекс профилей ещё не собран — он строится в фоне, повтори через пару секунд' };
        }
        if (ghIndexBuilding()) {
            return { error: 'индекс профилей перестраивается — повтори через пару секунд' };
        }
        return { error: `живой GitHub-сессии для ${nick} на диске нет — открой его один раз кнопкой «Открыть» и залогинься` };
    }
    const free = sources.filter(s => !ghProfileBusy(s));
    if (!free.length) {
        return { error: `все профили с сессией ${nick} заняты открытым браузером — закрой его и повтори` };
    }
    if (ghHarvestInFlight.has(acct.id)) {
        return { error: `снимок сессии ${nick} уже снимается другим запросом — подожди, это до минуты` };
    }
    // Пробуем по очереди: сессия в конкретном профиле может быть мёртвой, а у того же
    // аккаунта рядом лежит живая (профили логинились раздельно).
    const tried = [];
    ghHarvestInFlight.add(acct.id);
    try {
        const deadline = Date.now() + GH_STAR_HARVEST_BUDGET_MS;
        for (const src of free) {
            if (Date.now() > deadline) {
                tried.push(`дальше не пробовал: вышел бюджет ${Math.round(GH_STAR_HARVEST_BUDGET_MS / 1000)} с`);
                break;
            }
            const r = await ghHarvest(gsl, acct.id, src);
            if (r.code === 0) {
                const got = gsl.readCache(acct.id);
                if (got) return { snap: got, path: gsl.cachePath(acct.id), from: `${src.tag}/${src.label}` };
            }
            tried.push(`${src.tag}/${src.label}: ${r.code === 3 ? 'сессия мертва' : r.code === 2 ? 'профиль занят' : (r.err || 'ошибка').trim().slice(0, 120)}`);
        }
    } finally {
        ghHarvestInFlight.delete(acct.id);
    }
    return { error: `сессия ${nick} не годится: ${tried.join('; ')}. Залогинься заново кнопкой «Открыть».` };
}

// POST /__switch/api/gh/star { id } → окно с сессией аккаунта на странице репозитория.
async function handleGhStar(req, res) {
    // Харвест — это запуск Chromium, десятки секунд молчания в сокете.
    const stopKeepalive = jsonKeepalive(res);
    try {
        const { id } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const acct = ghLoad().find(k => k.id === id);
        if (!acct) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const nick = String(acct.nickname || acct.login || '').trim() || id;
        const label = 'acct_' + id;
        // Помеченный dead — это аккаунт, под которым уже нечего делать: то же условие
        // стоит в заселении (newapiAddGithub), и молчать про него здесь нечестно.
        if (acct.status === 'dead') {
            return jsonRes(res, 400, { error: `${nick} помечен как dead — сессии под ним нет, звезду ставить нечем` });
        }
        const gsl = ghSessionLib();
        if (!gsl) return jsonRes(res, 500, { error: 'модуль github-session недоступен' });

        // Браузер этого аккаунта уже поднят: второй Chromium на том же --user-data-dir —
        // это порча профиля (оба пишут Cookies и Preferences), поэтому open-session.js
        // заново не спавним, а отдаём вкладку живому окну.
        const prevPid = ghLkPids.get(label);
        if (ghPidAlive(prevPid)) {
            const h = await ghHandoffUrl(ghProfileDir(label), GH_STAR_REPO_URL);
            logLine(`gh star: ${nick} — браузер уже открыт (pid ${prevPid}), вкладка ${h.ok ? 'передана' : 'НЕ передана: ' + h.error}`);
            return jsonRes(res, 200, {
                ok: true, label, already: true, navigated: !!h.ok,
                url: GH_STAR_REPO_URL, ghLogin: nick,
                handoffError: h.ok ? undefined : h.error,
            });
        }

        // Снимок нужен профилю БЕЗ живой GitHub-сессии; в профиле, где она есть, своя
        // свежее кеша, и вливать поверх нельзя (`_gh_sess` ротируется, снимок живёт до
        // 7 суток) — объяснение и гейт в github/open-session.js.
        let seedPath = '';
        let from = 'сессия уже в профиле';
        let cookieCount = 0;
        if (ghProfileNeedsSession(gsl, label)) {
            const s = await ghStarSnapshot(acct);
            if (s.error) {
                logLine(`gh star: ${nick} — снимок не получен: ${s.error}`);
                return jsonRes(res, 409, { error: s.error });
            }
            seedPath = s.path;
            from = s.from;
            cookieCount = (s.snap.cookies || []).length;
        }

        // 🪤 Профиль может держать ОСИРОТЕВШЕЕ окно: браузеры спавнятся detached+unref и
        // переживают рестарт :8200, а карта ghLkPids живёт в памяти и после рестарта пуста.
        // Спавн на занятый профиль не падает за отведённые пробе 2 с (playwright ждёт
        // DevTools около 30 с), поэтому владелец получил бы «готово» без всякого окна.
        // Chromium на живом профиле держит в его каталоге `lockfile` — у закрытых профилей
        // его нет (проверено на acct_* и на профилях шлюзов), так что признак надёжный.
        if (fs.existsSync(path.join(ghProfileDir(label), 'lockfile'))) {
            logLine(`gh star: ${nick} — профиль занят (lockfile), pid в карте нет`);
            return jsonRes(res, 409, {
                error: `профиль ${nick} держит открытое окно браузера (скорее всего осталось от прошлого запуска дашборда) — закрой его и повтори`,
            });
        }

        const script = path.join(__dirname, '..', 'github', 'open-session.js');
        const proc = spawn(process.execPath, [script, label, GH_STAR_REPO_URL, seedPath], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`gh star [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`gh star ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`gh star spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => { ghLkPids.delete(label); logLine(`gh star: ${label} — exited (code ${code}, sig ${sig})`); });
        proc.unref();
        ghLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            ghLkPids.delete(label);
            logLine(`gh star FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        logLine(`gh star: ${nick} → ${GH_STAR_REPO_URL} (сессия: ${from}${cookieCount ? `, кук ${cookieCount}` : ''}, pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, url: GH_STAR_REPO_URL, ghLogin: nick, from, cookieCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

// ───── Заселение готовой GitHub-сессии в новый аккаунт New-API ─────
//
// Проблема: у каждого аккаунта вкладок ar/go/tb/xp/jw/sk свой персистентный профиль Chromium, и
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
    return { github: ghLkPids, ar: arLkPids, go: goLkPids, tb: tbLkPids, xp: xpLkPids, jw: jwLkPids, sk: skLkPids, ts: tsLkPids, kk: kkLkPids };
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
const GH_POOL_LOADERS = { ar: () => arLoad(), go: () => goLoad(), tb: () => tbLoad(), xp: () => xpLoad(), jw: () => jwLoad(), sk: () => skLoad(), ts: () => tsLoad(), kk: () => kkLoad() };
// Файлы пулов нужны отдельно от загрузчиков: по их mtime инвалидируется кеш usage-карты,
// и в них же дописывает ghId сверка привязок. Порядок ключей = порядок плашек на карточке.
const GH_POOL_FILES = { ar: () => AR_SESSIONS_FILE, go: () => GO_SESSIONS_FILE, tb: () => TB_SESSIONS_FILE, xp: () => XP_SESSIONS_FILE, jw: () => JW_SESSIONS_FILE, sk: () => SK_SESSIONS_FILE, ts: () => TS_SESSIONS_FILE, kk: () => KK_SESSIONS_FILE };
const GH_POOL_SAVERS = { ar: arr => arSave(arr), go: arr => goSave(arr), tb: arr => tbSave(arr), xp: arr => xpSave(arr), jw: arr => jwSave(arr), sk: arr => skSave(arr), ts: arr => tsSave(arr), kk: arr => kkSave(arr) };
const GH_POOL_LABELS = { ar: 'AgentRouter', go: 'GoRouter', tb: 'Tabi Token', xp: 'XPeach', jw: 'JustWoker', sk: 'SeekAi', ts: 'TrueSOTA', kk: 'KKtoken' };
// Правило сверки вынесено в предикат, потому что им пользуются двое: модалка заселения
// (одна находка по одному хосту) и плашки на вкладке GitHub (все находки по всем хостам).
// Разъедься они — вкладка показывала бы «свободен» там, где заселение отвечает 409.
function ghPoolMatch(s, nick, ghId) {
    const low = String(nick || '').toLowerCase();
    return !!((ghId && s.ghId === ghId)
        || (low && String(s.email || '').toLowerCase() === low)
        || (low && String(s.name || '').toLowerCase() === low));
}
function ghPoolEntryFor(tag, nick, ghId) {
    const load = GH_POOL_LOADERS[tag];
    if (!load) return null;
    try {
        return load().find(s => ghPoolMatch(s, nick, ghId)) || null;
    } catch { return null; }
}

// Найти GitHub-аккаунт под уже введённые email/ник. Тем же правилом, что ghPoolMatch,
// только с другой стороны: там запись пула ищут по нику GitHub, здесь GitHub — по записи.
// Нужно авто-привязке в /{ar,go,tb,xp}/add: владелец создаёт запись, вбивая email или ник
// из менеджера GitHub'ов, и связка обязана появиться сама, без отдельного действия.
function ghFindByIdentity(email, name) {
    const cands = [email, name].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
    if (!cands.length) return null;
    return ghLoad().find(g => {
        const nick = String(g.nickname || '').toLowerCase();
        const login = String(g.login || '').toLowerCase();
        return cands.some(c => c === nick || c === login);
    }) || null;
}

// Привязка GitHub к НОВОЙ записи пула. Две дороги, обе кончаются полем `ghId`:
//   1. `ghId` пришёл в теле — владелец выбрал аккаунт кнопкой «🐙 из менеджера»;
//   2. `ghId` не пришёл — ищем по введённым email/нику.
// Вторая и есть привычный путь: логин или email копируется из менеджера GitHub'ов в форму
// шлюза, и раньше на этом связка терялась — запись жила без `ghId`, плашка занятости не
// зажигалась, и тот же аккаунт уходил под второй заход. Возвращаем ещё и `how` — строкой
// в лог, чтобы было видно, привязка явная или досчитанная.
function ghLinkForNew(body, email, name) {
    const explicit = String((body && body.ghId) || '').trim();
    if (explicit === 'personal') return { ghId: 'personal', how: 'GitHub: личный (выбран)' };
    if (explicit) {
        const g = ghLoad().find(x => x.id === explicit);
        return g ? { ghId: g.id, how: `GitHub: ${g.nickname || g.login} (выбран)` } : { ghId: null, how: null };
    }
    const found = ghFindByIdentity(email, name);
    return found ? { ghId: found.id, how: `GitHub: ${found.nickname || found.login} (сам, по совпадению)` } : { ghId: null, how: null };
}

// Где каждый GitHub-аккаунт уже израсходован: { <ghId>: [{ tag, status, name, recordId }] }.
//
// Только записи пулов пяти NewAPI-шлюзов — по замеру 2026-08-22 логины и ники из
// github-accounts.json совпадают больше нигде (freemodel/tokenrouter/notion/anymodel/
// conduit — ноль совпадений), так что обходить их каталоги незачем.
//
// Куку в профиле («засвечен») здесь НЕ учитываем сознательно: на вкладке нужен факт
// «аккаунт израсходован», а профиль на диске переживает и удаление записи, и не
// состоявшуюся регистрацию. Это косвенный признак, его место — модалка заселения.
//
// Каждый пул грузим ровно раз и каждый — в своём try: битый или отсутствующий файл
// не должен обнулять плашки остальных шлюзов.
//
// Ручные отметки (`usedManual` в самом github-accounts.json) подмешиваются сюда же с
// `source:'manual'`: аккаунт бывает израсходован там, где записи в пуле нет и не будет.
function ghUsageMapFresh() {
    const accounts = ghLoad();
    const usage = {};
    const push = (id, row) => { (usage[id] = usage[id] || []).push(row); };
    for (const [tag, load] of Object.entries(GH_POOL_LOADERS)) {
        let pool;
        try { pool = load(); } catch { continue; }
        if (!Array.isArray(pool)) continue;
        for (const g of accounts) {
            const nick = String(g.nickname || g.login || '').trim();
            for (const s of pool) {
                if (!ghPoolMatch(s, nick, g.id)) continue;
                push(g.id, {
                    tag,
                    status: s.status || 'unknown',
                    name: s.name || s.email || '',
                    recordId: s.id || null,
                    source: s.ghId === g.id ? 'link' : 'match',   // link = ghId проставлен, match = сошлись по нику
                });
            }
        }
    }
    for (const g of accounts) {
        for (const m of (Array.isArray(g.usedManual) ? g.usedManual : [])) {
            const tag = typeof m === 'string' ? m : (m && m.tag);
            if (!GH_POOL_LOADERS[tag]) continue;
            // Ручная отметка на шлюзе, где запись уже нашлась, — не дубль плашки, а шум.
            if ((usage[g.id] || []).some(r => r.tag === tag)) continue;
            push(g.id, {
                tag, status: 'manual', name: (m && m.note) || '', recordId: null, source: 'manual',
            });
        }
    }
    return usage;
}

// Кеш: карта пересчитывается только когда изменился хоть один из пяти файлов.
// Считается она быстро, но зовут её на каждый /api/gh/keys, а вкладка перечитывает
// список после любого действия — незачем гонять 36×82 сверки на каждый чих.
let ghUsageCache = { map: null, stamp: '' };
function ghUsageStamp() {
    const parts = [GH_ACCOUNTS_FILE, ...Object.values(GH_POOL_FILES).map(f => f())];
    return parts.map(p => {
        try { const st = fs.statSync(p); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; }
    }).join('|');
}
function ghUsageMap() {
    const stamp = ghUsageStamp();
    if (ghUsageCache.map && ghUsageCache.stamp === stamp) return ghUsageCache.map;
    ghUsageCache = { map: ghUsageMapFresh(), stamp };
    return ghUsageCache.map;
}

// POST /__switch/api/gh/relink → дописать ghId в записи пулов, которые сошлись с GitHub
// только по нику/email.
//
// Зачем вообще: `ghId` пишет заселение и ручная привязка, а созданные руками записи его
// не имеют — связка держится на совпадении строк. Это работает, пока ник не поправили
// (а его правят: у покупок из 3 полей ник берётся из email и часто не совпадает с
// настоящим юзернеймом GitHub). Проставленный `ghId` переживает переименование.
//
// Перед первой записью файл пула копируется в `<имя>.relink.bak` — операция трогает
// живые пулы, и откат должен быть в один `copy`.
function ghBackfillPoolLinks() {
    const accounts = ghLoad();
    const filled = {}, skipped = {};
    for (const [tag, load] of Object.entries(GH_POOL_LOADERS)) {
        let pool;
        try { pool = load(); } catch { continue; }
        if (!Array.isArray(pool) || !pool.length) continue;
        let touched = 0, ambiguous = 0;
        for (const s of pool) {
            if (s.ghId) continue;                 // 'personal' и уже привязанные не трогаем
            const hits = accounts.filter(g => ghPoolMatch(s, String(g.nickname || g.login || '').trim(), null));
            // Два GitHub-аккаунта на одну запись — угадывать нельзя, это работа владельца.
            if (hits.length !== 1) { if (hits.length > 1) ambiguous++; continue; }
            s.ghId = hits[0].id;
            touched++;
        }
        if (touched) {
            const file = GH_POOL_FILES[tag]();
            try { fs.copyFileSync(file, file + '.relink.bak'); } catch (e) { logLine(`gh relink: бэкап ${tag} не удался — ${e.message}`); }
            GH_POOL_SAVERS[tag](pool);
        }
        if (touched) filled[tag] = touched;
        if (ambiguous) skipped[tag] = ambiguous;
    }
    const total = Object.values(filled).reduce((a, b) => a + b, 0);
    logLine(`gh relink: дописано ghId ${total || 'нет'}${total ? ` (${Object.entries(filled).map(([t, n]) => t + ':' + n).join(', ')})` : ''}`
        + (Object.keys(skipped).length ? ` · неоднозначных пропущено ${Object.entries(skipped).map(([t, n]) => t + ':' + n).join(', ')}` : ''));
    return { filled, skipped, total };
}

async function handleGhRelink(req, res) {
    try {
        const r = ghBackfillPoolLinks();
        ghUsageCache = { map: null, stamp: '' };   // пулы переписаны — карта устарела
        jsonRes(res, 200, { ok: true, ...r, usage: ghUsageMap() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/gh/mark { id, tag, on, note? } → ручная отметка занятости без записи
// в пуле. Нужна там, где аккаунт израсходован, а записи у нас нет и не появится: шлюз
// закрыл регистрацию, аккаунт удалён на их стороне, использован вне дашборда.
async function handleGhMark(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const tag = String(body.tag || '').trim();
        const on = !!body.on;
        if (!id || !GH_POOL_LOADERS[tag]) return jsonRes(res, 400, { error: 'нужны id и известный шлюз' });
        const arr = ghLoad();
        const g = arr.find(x => x.id === id);
        if (!g) return jsonRes(res, 404, { error: 'GitHub-аккаунт не найден' });
        const cur = (Array.isArray(g.usedManual) ? g.usedManual : [])
            .map(m => (typeof m === 'string' ? { tag: m } : m))
            .filter(m => m && m.tag && m.tag !== tag);
        if (on) cur.push({ tag, note: String(body.note || '').trim(), at: new Date().toISOString().slice(0, 10) });
        if (cur.length) g.usedManual = cur; else delete g.usedManual;
        ghSave(arr);
        logLine(`gh mark: ${g.nickname || g.login} ${on ? '→ занят на ' : '→ свободен на '}${GH_POOL_LABELS[tag]} (вручную)`);
        jsonRes(res, 200, { ok: true, usage: ghUsageMap() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
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
                regAge: g.regAge || null,
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
function handleKkAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'kktoken', host: 'kktoken.cc', prefix: 'kk_', load: kkLoad, save: kkSave, sessionsDir: KK_SESSIONS_DIR });
}
function handleTbAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'tabi', host: 'tabitoken.com', prefix: 'tb_', load: tbLoad, save: tbSave, sessionsDir: TB_SESSIONS_DIR });
}
function handleXpAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'xpeach', host: 'xpeach.codes', prefix: 'xp_', load: xpLoad, save: xpSave, sessionsDir: XP_SESSIONS_DIR });
}
function handleJwAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'justwoker', host: 'api.justwoker.icu', prefix: 'jw_', load: jwLoad, save: jwSave, sessionsDir: JW_SESSIONS_DIR });
}
function handleSkAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'seekai', host: 'seekai.cc', prefix: 'sk_', load: skLoad, save: skSave, sessionsDir: SK_SESSIONS_DIR });
}
// TrueSOTA: механика заселения GitHub от панели не зависит (это про куки github.com),
// поэтому общий обработчик подходит без правок — нужен лишь хост в PROFILE_ROOTS
// (routing/lib/github-session.js) и профили в truesota/profiles.
function handleTsAddGithub(req, res) {
    return newapiAddGithub(req, res, { tag: 'truesota', host: 'true-sota.com', prefix: 'ts_', load: tsLoad, save: tsSave, sessionsDir: TS_SESSIONS_DIR });
}

// ───── Outlook-ящики (ol) — пул купленных почт под регистрации ─────
//
// Зачем свой менеджер рядом с менеджером GitHub. Почта нужна там, где шлюз просит
// подтверждение кодом, а входа через GitHub у него нет. И живёт она иначе: у GitHub на
// руках логин+пароль+TOTP, и этого хватает навсегда, а у ящика пароль — разовый ключ к
// профилю браузера. Basic auth Microsoft выключил (живая проба 31.08:
// `outlook.office365.com:993` отдаёт `AUTH=XOAUTH2 LOGINDISABLED`), значит IMAP по паролю
// невозможен и письмо с кодом читается только из залогиненной сессии — отсюда профиль на
// ящик и снимок куки, а не пара логин-пароль в файле.
//
// Разбор пачки из магазина живёт в routing/lib/outlook-pool.js и вызывается ОТСЮДА, а не
// из браузера: у GitHub парсер продублирован во фронте, и правки в него приходится делать
// дважды. Здесь модуль один и проверяемый.
//
// 🔴 Пароль ящика наружу не уходит НИКОГДА: ни в /ol/list, ни в лог. В ответах только
// `hasPassword`, в логах — маскированный адрес, в дочерние скрипты креды уезжают
// переменными среды (см. handleOlOpen).
const olPool = require('./lib/outlook-pool');

const OL_OPEN_SCRIPT = path.join(__dirname, '..', 'outlook', 'open-session.js');
const OL_CODE_SCRIPT = path.join(__dirname, '..', 'outlook', 'read-code.js');
const OL_CODE_TIMEOUT_MS = 90_000;
// 30 дней — рубеж «снимок ещё похож на живой». Цифра из наблюдения, а не из документации
// Microsoft: refresh-кука outlook.com переживает месяц простоя, дальше вход просят заново.
// Нужна только для подписи в UI, решений на ней не строится.
const OL_SESSION_FRESH_MS = 30 * 86400000;

function olSessionFile(id) { return path.join(olPool.SESSIONS_DIR, String(id) + '.json'); }
function olProfileDir(id)  { return path.join(olPool.PROFILES_DIR, olPool.profileLabel(id)); }

// Снимок сессии — единственный дешёвый признак «в ящик уже входили». Берём stat, а не
// содержимое: storageState весит десятки килобайт, а нужна только дата.
function olSessionStat(id) {
    try { return fs.statSync(olSessionFile(id)); } catch { return null; }
}

// `ab***@outlook.com`. Маска нужна в логах (строки лога уезжают в скриншоты README) и в
// превью импорта — там показывается чужой чек до того, как владелец решил его завести.
function olMaskEmail(email) {
    const s = String(email || '').trim();
    const at = s.indexOf('@');
    if (at < 0) return (s.slice(0, 2) || '?') + '***';
    return s.slice(0, Math.min(2, at)) + '***' + s.slice(at);
}
// 🪤 Тексты ошибок парсера содержат адрес целиком (`у vasya@outlook.com нет пароля`), и без
// этой замены маска в превью не значит ничего: тот же адрес виден строкой ниже, в ошибках.
const OL_EMAIL_IN_TEXT_RE = /[^\s:;|]+@[^\s:;|]+\.[A-Za-z]{2,}/g;
function olMaskInText(s) { return String(s || '').replace(OL_EMAIL_IN_TEXT_RE, m => olMaskEmail(m)); }

// Публичная форма записи. Пароль не маскируем частично, как auth_key у ТГ: у hex-ключа
// первые шесть символов бесполезны, а у пароля это подсказка к подбору — убираем совсем.
function olSafe(e) {
    const st = olSessionStat(e.id);
    // 🪤 Снимок и профиль — РАЗНЫЕ вещи, и путать их нельзя. Код читает outlook/read-code.js
    // из ПАПКИ ПРОФИЛЯ, а снимок storageState — резервная копия, которая иногда не снимается
    // (окно закрыли раньше, storageState упал). Поэтому «в ящик входили» = профиль есть, а
    // `hasSession` — только про файл снимка.
    const hasProfile = fs.existsSync(olProfileDir(e.id));
    // Возраст считаем по снимку, а если его нет — по sessionAt, который ставит сам
    // open-session.js после входа. Иначе успешный вход без снимка выглядел бы как «никогда».
    const stampMs = st ? st.mtimeMs : (e.sessionAt ? Date.parse(e.sessionAt) : NaN);
    const ageMs = Number.isFinite(stampMs) ? Date.now() - stampMs : null;
    return {
        id: e.id,
        email: e.email || '',
        kind: olPool.KINDS.includes(e.kind) ? e.kind : 'personal',
        nickname: e.nickname || String(e.email || '').split('@')[0],
        status: olPool.STATUSES.includes(e.status) ? e.status : 'unknown',
        note: e.note || '',
        addedAt: e.addedAt || null,
        sessionAt: e.sessionAt || null,
        lastCheck: e.lastCheck || null,
        usedOn: Array.isArray(e.usedOn) ? e.usedOn : [],
        hasPassword: !!String(e.password || '').length,
        hasSession: !!st,
        hasProfile,
        // Это ВОЗРАСТ СНИМКА, а не «аккаунт жив» — см. блок health-чека ниже.
        sessionAgeDays: ageMs === null ? null : Math.floor(ageMs / 86400000),
        sessionFresh: ageMs === null ? null : ageMs < OL_SESSION_FRESH_MS,
        profile: olPool.profileLabel(e.id),
    };
}

function olStats(arr) {
    const s = { total: arr.length, live: 0, dead: 0, unknown: 0, locked: 0, student: 0 };
    for (const e of arr) {
        s[olPool.STATUSES.includes(e.status) ? e.status : 'unknown']++;
        if (e.kind === 'student') s.student++;
    }
    return s;
}

function olFind(arr, id) { return arr.findIndex(e => String(e.id) === String(id)); }

// Точечная правка одной записи на диске. Пул перечитываем ПЕРЕД правкой: между открытием
// окна и его закрытием владелец мог завести или удалить ящики, и запись всего массива из
// памяти обработчика откатила бы это молча.
function olPatch(id, fn) {
    const arr = olPool.load();
    const i = olFind(arr, id);
    if (i < 0) return null;
    fn(arr[i]);
    olPool.save(arr);
    return arr[i];
}

// id по схеме outlook/accounts.example.json: `ol_<ts>_<n>`, где n — номер внутри пачки.
// Занятые всё равно проверяем: два импорта в одну миллисекунду руками невозможны, но
// совпавший id дал бы двум ящикам ОДИН профиль браузера, то есть чужую куку в «своём».
function olNewEntry(src, ts, n, taken) {
    let id = `ol_${ts}_${n}`;
    while (taken.has(id)) id = `ol_${ts}_${++n}`;
    taken.add(id);
    const email = String(src.email || '').trim().toLowerCase();
    const kind = olPool.KINDS.includes(src.kind) ? src.kind
        : olPool.isStudentDomain(email) ? 'student' : 'personal';
    return {
        id,
        email,
        password: String(src.password ?? ''),
        kind,
        nickname: String(src.nickname || '').trim() || email.split('@')[0],
        status: 'unknown',
        note: String(src.note || '').trim(),
        addedAt: new Date().toISOString(),
        sessionAt: null,
        lastCheck: null,
        usedOn: [],
    };
}

// Живые окна по label профиля. Второе окно на тот же профиль Chromium не поднимется
// (ProcessSingleton), а снаружи это выглядит как «кнопка молча не работает» — образец
// ghLkPids/hnLkPids. Карта живёт в памяти процесса: рестарт прокси её теряет, и тогда
// повторный клик просто упрётся в занятый профиль с внятной ошибкой.
const olLkPids = new Map();
function olPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// GET /__switch/api/ol/list → весь пул + сводка. Единственный источник для вкладки:
// один запрос = карточки и цифры сводки физически не могут разойтись.
function handleOlList(res) {
    try {
        const arr = olPool.load();
        jsonRes(res, 200, { entries: arr.map(olSafe), stats: olStats(arr) });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ol/import { text, dryRun }
//
// dryRun — не удобство, а обязательный шаг: файл магазина это письмо-чек, и в нём лежат
// строки ДРУГИХ покупок (GitHub-аккаунты `почта:пароль:2FA`, gmail). Завести такую строку
// почтой значит получить профиль, в который не войти, и понять это только руками. Превью
// показывает, что парсер понял, ДО записи на диск.
async function handleOlImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const text = String(body.text || '');
        if (!text.trim()) return jsonRes(res, 400, { error: 'нет text' });
        const arr = olPool.load();
        const parsed = olPool.parseBulk(text, arr);

        if (body.dryRun) {
            return jsonRes(res, 200, {
                ok: true, dryRun: true,
                preview: parsed.entries.map(e => ({ email: olMaskEmail(e.email), kind: e.kind, note: e.note })),
                errors: parsed.errors.map(x => ({ line: x.line, error: olMaskInText(x.error) })),
                duplicates: parsed.duplicates.map(olMaskEmail),
                counts: {
                    entries: parsed.entries.length,
                    errors: parsed.errors.length,
                    duplicates: parsed.duplicates.length,
                },
            });
        }

        const ts = Date.now();
        const taken = new Set(arr.map(e => String(e.id)));
        const added = [];
        parsed.entries.forEach((src, i) => {
            const e = olNewEntry(src, ts, i, taken);
            arr.push(e);
            added.push({ id: e.id, email: olMaskEmail(e.email), kind: e.kind });
        });
        if (added.length) olPool.save(arr);
        logLine(`outlook import: +${added.length} (дублей ${parsed.duplicates.length}, ошибок ${parsed.errors.length})`);
        // Здесь адреса и ошибки НЕ маскируем, в отличие от превью: пачка уже заведена
        // владельцем, и чтобы починить кривую строку, надо видеть, какая именно кривая.
        jsonRes(res, 200, {
            ok: true,
            added: added.length,
            accounts: added,
            skipped: parsed.duplicates.length,
            duplicates: parsed.duplicates,
            errors: parsed.errors,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ol/add { email, password, kind?, note? } — одна запись руками.
async function handleOlAdd(req, res) {
    try {
        const body = await readJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password ?? '');
        if (!olPool.isEmail(email)) return jsonRes(res, 400, { error: 'адрес не похож на почту' });
        // Ящик без пароля бесполезен: в профиль браузера входить нечем, а кука появляется
        // только после входа. Лучше отказать здесь, чем завести карточку-пустышку.
        if (!password) return jsonRes(res, 400, { error: 'пароль обязателен — без него в профиль не войти' });
        const arr = olPool.load();
        if (arr.some(e => String(e.email || '').toLowerCase() === email))
            return jsonRes(res, 409, { error: 'такой ящик уже есть' });
        const e = olNewEntry(
            { email, password, kind: body.kind, note: body.note },
            Date.now(), arr.length, new Set(arr.map(x => String(x.id))),
        );
        arr.push(e);
        olPool.save(arr);
        logLine(`outlook add: ${olMaskEmail(email)} (${e.kind})`);
        jsonRes(res, 200, { ok: true, id: e.id, entry: olSafe(e) });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ol/rename { id, nickname }
async function handleOlRename(req, res) {
    try {
        const { id, nickname } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        // Пустой ник не запрещаем, а откатываем на локальную часть адреса: карточка без
        // подписи в списке неотличима от соседней.
        const e = olPatch(id, x => {
            x.nickname = String(nickname || '').trim() || String(x.email || '').split('@')[0];
        });
        if (!e) return jsonRes(res, 404, { error: 'ящик не найден' });
        logLine(`outlook rename: ${olMaskEmail(e.email)} → ${e.nickname}`);
        jsonRes(res, 200, { ok: true, entry: olSafe(e) });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ol/status { id, status } — ручной вердикт владельца.
// Автоматически статус НЕ меняет ничто: health-чек трогает только даты (см. ниже).
async function handleOlStatus(req, res) {
    try {
        const { id, status } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        if (!olPool.STATUSES.includes(status))
            return jsonRes(res, 400, { error: `status: одно из ${olPool.STATUSES.join(', ')}` });
        const e = olPatch(id, x => { x.status = status; });
        if (!e) return jsonRes(res, 404, { error: 'ящик не найден' });
        logLine(`outlook status: ${olMaskEmail(e.email)} → ${status}`);
        jsonRes(res, 200, { ok: true, entry: olSafe(e) });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ol/mark { id, tag, off? } — «ящик израсходован на этом шлюзе».
//
// Метка живёт В САМОЙ ЗАПИСИ (`usedOn: [{tag, at}]`), а не в отдельных файлах занятости.
// У ТГ она размазана по четырём чужим `.tg_used.json`, и цифры вкладки расходятся с тем,
// что реально возьмёт автореж, — здесь один файл и один источник истины.
async function handleOlMark(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const tag = String(body.tag || '').trim();
        if (!id || !tag) return jsonRes(res, 400, { error: 'нужны id и tag' });
        const e = olPatch(id, x => {
            const was = (Array.isArray(x.usedOn) ? x.usedOn : [])
                .map(m => (typeof m === 'string' ? { tag: m, at: null } : m))
                .filter(m => m && m.tag);
            const cur = was.filter(m => m.tag !== tag);
            // Повторная отметка тем же тегом дату НЕ обновляет: важен факт первого расхода,
            // а не последнего клика. `off` — откат ошибочной отметки, иначе промах мышью
            // лечился бы только удалением ящика вместе с профилем.
            if (!body.off) {
                const prev = was.find(m => m.tag === tag);
                cur.push({ tag, at: (prev && prev.at) || new Date().toISOString() });
            }
            x.usedOn = cur;
        });
        if (!e) return jsonRes(res, 404, { error: 'ящик не найден' });
        logLine(`outlook mark: ${olMaskEmail(e.email)} ${body.off ? '− снята метка ' : '→ занят на '}${tag}`);
        jsonRes(res, 200, { ok: true, entry: olSafe(e) });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ol/delete { id }
//
// 🪤 Удалять надо ТРИ вещи: запись, снимок сессии и папку профиля. Оставленный профиль —
// не мусор, а ловушка: перезалив того же ящика подхватит лежащую там куку, и «свой» ящик
// молча покажет чужую почту. Поэтому файлы сносим ПЕРВЫМИ, и если профиль не удалился,
// запись остаётся на месте — лучше видимая ошибка, чем осиротевший профиль.
async function handleOlDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const arr = olPool.load();
        const i = olFind(arr, id);
        if (i < 0) return jsonRes(res, 404, { error: 'ящик не найден' });
        const target = arr[i];
        const label = olPool.profileLabel(target.id);
        const pid = olLkPids.get(label);
        if (olPidAlive(pid))
            return jsonRes(res, 409, { error: `окно этого ящика открыто (pid ${pid}) — закрой его, иначе профиль на диске не удалится` });
        try {
            fs.rmSync(olProfileDir(target.id), { recursive: true, force: true });
        } catch (err) {
            // На Windows это EBUSY/EPERM от живого Chromium, которого нет в карте pid'ов
            // (например, остался после рестарта прокси). Ошибку отдаём как есть.
            return jsonRes(res, 409, {
                error: `профиль ${label} не удалился (${err.code || err.message}) — закрой браузер и повтори, запись оставил на месте`,
            });
        }
        try { fs.rmSync(olSessionFile(target.id), { force: true }); } catch {}
        arr.splice(i, 1);
        olPool.save(arr);
        olLkPids.delete(label);
        logLine(`outlook delete: ${olMaskEmail(target.email)} (профиль ${label} и снимок сессии удалены)`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Снимок появился или обновился, пока окно было открыто → переписываем `sessionAt` датой
// файла. Статус НЕ трогаем: вход руками мог кончиться капчей или блокировкой, и «снимок
// есть» не значит «ящик живой» — вердикт ставит владелец через /ol/status.
function olRefreshSessionAt(id) {
    try {
        const st = olSessionStat(id);
        if (!st) return;
        const at = new Date(st.mtimeMs).toISOString();
        const cur = olPool.load().find(e => String(e.id) === String(id));
        if (!cur || cur.sessionAt === at) return;   // ничего не менялось — не переписываем файл
        olPatch(id, x => { x.sessionAt = at; });
        logLine(`outlook: снимок сессии ${olPool.profileLabel(id)} обновлён (${at.slice(0, 16).replace('T', ' ')})`);
    } catch {}
}

// POST /__switch/api/ol/open { id } → видимое окно Chromium в профиле этого ящика.
//
// 🔴 Креды уезжают в скрипт ПЕРЕМЕННЫМИ СРЕДЫ, а не аргументами: argv виден в диспетчере
// задач любому, кто его откроет, — пароль там светиться не должен. Аргументом только label.
async function handleOlOpen(req, res) {
    try {
        const { id } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const arr = olPool.load();
        const i = olFind(arr, id);
        if (i < 0) return jsonRes(res, 404, { error: 'ящик не найден' });
        const target = arr[i];
        // Профиль привязан к СТАБИЛЬНОМУ id, а не к адресу: переименование не рвёт сессию.
        const label = olPool.profileLabel(target.id);

        const prevPid = olLkPids.get(label);
        if (olPidAlive(prevPid)) {
            logLine(`outlook open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }
        if (!fs.existsSync(OL_OPEN_SCRIPT))
            return jsonRes(res, 500, { error: `нет ${OL_OPEN_SCRIPT} — обнови репо (git pull) и обнови страницу` });

        const proc = spawn(process.execPath, [OL_OPEN_SCRIPT, label], {
            detached: true,
            stdio: 'pipe',
            env: { ...process.env, OL_EMAIL: String(target.email || ''), OL_PASS: String(target.password || '') },
        });
        // 🪤 Вывод ребёнка маскируем ЗДЕСЬ. Скрипт печатает полный адрес осознанно — его
        // запускают и руками из консоли, там маска мешала бы. Но в лог дашборда та же
        // строка уезжает сбоку от `olMaskEmail`, и адрес купленного ящика оказывается в
        // файле, который попадает в скриншоты README. Дырку нашёл регресс, а не человек.
        proc.stdout.on('data', d => logLine(`outlook open [${label}]: ${olMaskInText(String(d).trim())}`));
        proc.stderr.on('data', d => logLine(`outlook open ERR [${label}]: ${olMaskInText(String(d).trim())}`));
        proc.on('error', e => logLine(`outlook open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => {
            olLkPids.delete(label);
            logLine(`outlook open: ${label} — окно закрыто (code ${code}, sig ${sig})`);
            olRefreshSessionAt(target.id);
        });
        proc.unref();
        olLkPids.set(label, proc.pid);
        // Не умер за две секунды — считаем, что окно поднимается. Общий пробник ручек
        // session/open: без него дашборд рисовал зелёный тост на не открывшемся браузере.
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            olLkPids.delete(label);
            logLine(`outlook open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        logLine(`outlook open: ${olMaskEmail(target.email)} → ${label} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// 🪤 stdout читалки — не только её JSON: playwright и Chromium сыпят туда свои строки, и
// `JSON.parse` всего вывода падает на первой из них. Берём ПОСЛЕДНИЙ объект — скрипт печатает
// свой в самом конце.
function olParseCodeStdout(out) {
    const text = String(out || '');
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).reverse();
    for (const l of lines) {
        if (!l.startsWith('{') || !l.endsWith('}')) continue;
        try { const o = JSON.parse(l); if (o && typeof o === 'object') return o; } catch {}
    }
    // JSON мог приехать многострочным (pretty-print) — пробуем от последней `{` до конца.
    const at = text.lastIndexOf('{');
    if (at >= 0) { try { const o = JSON.parse(text.slice(at)); if (o && typeof o === 'object') return o; } catch {} }
    return null;
}

// POST /__switch/api/ol/code { id } → одноразовый код из последнего письма.
//
// Ответ читалки (`{ok, code, from, subject, at}`) отдаём КАК ЕСТЬ, не переупаковывая:
// разбор письма живёт в одном месте, и дашборд с будущей автоподстановкой видят одно и то же.
async function handleOlCode(req, res) {
    try {
        const { id } = await readJsonBody(req);
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const arr = olPool.load();
        const i = olFind(arr, id);
        if (i < 0) return jsonRes(res, 404, { error: 'ящик не найден' });
        const target = arr[i];
        const label = olPool.profileLabel(target.id);
        // Тот же профиль в двух Chromium'ах = ProcessSingleton, читалка упадёт на старте.
        // Открытое окно — не повод падать молча: код в нём и так виден.
        if (olPidAlive(olLkPids.get(label)))
            return jsonRes(res, 409, { ok: false, error: 'окно этого ящика открыто — код видно в нём, либо закрой окно и повтори' });
        if (!fs.existsSync(OL_CODE_SCRIPT))
            return jsonRes(res, 500, { ok: false, error: `нет ${OL_CODE_SCRIPT} — обнови репо (git pull)` });

        // Креды — снова средой, а не argv: читалке может понадобиться дологиниться.
        const proc = spawn(process.execPath, [OL_CODE_SCRIPT, label], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, OL_EMAIL: String(target.email || ''), OL_PASS: String(target.password || '') },
        });
        let so = '', se = '';
        proc.stdout.on('data', d => { so += String(d); });
        proc.stderr.on('data', d => { se += String(d); });
        const done = await new Promise(resolve => {
            const t = setTimeout(() => { try { proc.kill(); } catch {} resolve({ timeout: true }); }, OL_CODE_TIMEOUT_MS);
            proc.on('error', e => { clearTimeout(t); resolve({ spawnError: e.message }); });
            proc.on('close', code => { clearTimeout(t); resolve({ code }); });
        });
        if (done.timeout) {
            logLine(`outlook code: ${olMaskEmail(target.email)} — таймаут ${OL_CODE_TIMEOUT_MS / 1000} c`);
            // Код ответа 200 намеренно: HTTP-запрос прошёл нормально, не сложилось у читалки.
            // Фронт разбирает `ok:false` + `error`, как у остальных ручек этого файла.
            return jsonRes(res, 200, { ok: false, error: 'timeout' });
        }
        if (done.spawnError) return jsonRes(res, 500, { ok: false, error: done.spawnError });
        const parsed = olParseCodeStdout(so);
        if (!parsed) {
            const tail = (se || so).trim().split('\n').map(s => s.trim()).filter(Boolean).pop() || `код выхода ${done.code}`;
            logLine(`outlook code: ${olMaskEmail(target.email)} — ответ не разобран: ${olMaskInText(tail.slice(0, 160))}`);
            return jsonRes(res, 200, { ok: false, error: tail.slice(0, 300) });
        }
        // `lastCheck` ставим на любой ответ: заход состоялся, и дата обращения важна даже
        // когда письма не нашлось.
        olPatch(target.id, x => { x.lastCheck = new Date().toISOString(); });
        olRefreshSessionAt(target.id);
        logLine(`outlook code: ${olMaskEmail(target.email)} → ${parsed.ok ? 'код получен' : (parsed.error || 'кода нет')}`);
        jsonRes(res, 200, parsed);
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
}

// GET /__switch/api/ol/available?tag=hcnsec → первый годный ящик под регистрацию.
//
// Годен = статус не `dead` и нет метки этого тега. Внутри годных вперёд ставим те, в которые
// уже входили (есть профиль или снимок): ящик с чистым профилем требует ручного входа в
// окно, и автоподстановка на нём встанет насмерть, хотя рядом лежит готовый. Порядок пула
// внутри групп сохраняется — сортировка в V8 стабильная.
function handleOlAvailable(req, res) {
    try {
        const tag = String(new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams.get('tag') || '').trim();
        if (!tag) return jsonRes(res, 400, { error: 'нужен ?tag=<шлюз>' });
        const free = olPool.load()
            .filter(e => e.status !== 'dead'
                && !(Array.isArray(e.usedOn) ? e.usedOn : []).some(m => m && m.tag === tag))
            .map(olSafe);
        const ready = e => (e.hasProfile || e.hasSession) ? 1 : 0;
        const ranked = free.slice().sort((a, b) => ready(b) - ready(a));
        jsonRes(res, 200, {
            ok: true, tag,
            account: ranked[0] || null,
            free: free.length,
            ready: free.filter(ready).length,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── Health-чек ящиков: это ВОЗРАСТ СНИМКА, а не «аккаунт жив» ─────
//
// Настоящую проверку входом здесь не делаем сознательно: она требует поднять Chromium в
// профиле — это десятки секунд на ящик, видимое окно и лишний логин, который Microsoft
// считает подозрительным. Поэтому вердикт дешёвый и честно так и назван: есть ли снимок
// сессии и не старше ли он OL_SESSION_FRESH_MS. Слово `live` в статусе ставит только
// владелец руками (/ol/status), автоматика статуса не трогает.
//
// Фоновым джобом это сделано ради того же контракта с фронтом, что у ТГ (кнопка + прогресс),
// а не потому что stat'ы долгие: сотня ящиков считается за миллисекунды.
let olHealthJob = {
    running: false, scope: null, total: 0, done: 0,
    fresh: 0, stale: 0, missing: 0,
    currentEmail: null, startedAt: null, finishedAt: null,
};

// scope 'unchecked' = тех ещё не смотрели (`lastCheck` пуст) — дешёвый догон; 'all' = все.
function olHealthTargets(scope) {
    return olPool.load().filter(e => scope === 'all' || !e.lastCheck);
}

async function olHealthRun(scope) {
    const targets = olHealthTargets(scope);
    olHealthJob = {
        running: true, scope, total: targets.length, done: 0,
        fresh: 0, stale: 0, missing: 0,
        currentEmail: null, startedAt: new Date().toISOString(), finishedAt: null,
    };
    logLine(`outlook health: старт (${scope}) — ${targets.length} шт., смотрю возраст снимков`);
    try {
        for (const t of targets) {
            olHealthJob.currentEmail = olMaskEmail(t.email);
            const st = olSessionStat(t.id);
            // Тот же расчёт, что в olSafe: снимок, а при его отсутствии — дата входа из пула.
            const stampMs = st ? st.mtimeMs : (t.sessionAt ? Date.parse(t.sessionAt) : NaN);
            const ageMs = Number.isFinite(stampMs) ? Date.now() - stampMs : null;
            if (ageMs === null) olHealthJob.missing++;
            else if (ageMs < OL_SESSION_FRESH_MS) olHealthJob.fresh++;
            else olHealthJob.stale++;
            // Пишем инкрементально, запись за записью: обрыв на середине (рестарт прокси)
            // не теряет уже пройденное. Отдельного поля под вердикт в схеме НЕТ и не нужно —
            // он считается из sessionAt при чтении, а производное поле на диске гниёт молча.
            try {
                olPatch(t.id, x => {
                    x.lastCheck = new Date().toISOString();
                    x.sessionAt = st ? new Date(st.mtimeMs).toISOString() : null;
                });
            } catch {}
            olHealthJob.done++;
            // 🪤 Без уступки циклу событий весь прогон уходит в один тик, и GET
            // /ol/health-progress не отвечает до самого конца: прогресс прыгает с 0 на 100.
            await new Promise(r => setImmediate(r));
        }
    } finally {
        olHealthJob.running = false;
        olHealthJob.currentEmail = null;
        olHealthJob.finishedAt = new Date().toISOString();
        logLine(`outlook health: готово (${scope}) свежих=${olHealthJob.fresh} старых=${olHealthJob.stale} без снимка=${olHealthJob.missing}`);
    }
}

// POST /__switch/api/ol/health-check { scope: 'unchecked' | 'all' }
async function handleOlHealthCheck(req, res) {
    try {
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        if (olHealthJob.running)
            return jsonRes(res, 409, { error: `уже идёт (${olHealthJob.done}/${olHealthJob.total})`, job: olHealthJob });
        const scope = body && body.scope === 'all' ? 'all' : 'unchecked';
        const total = olHealthTargets(scope).length;
        if (!total) return jsonRes(res, 200, { ok: true, started: false, scope, total: 0 });
        // Промис никто не ждёт — catch обязателен: unhandledRejection уронил бы весь прокси.
        olHealthRun(scope).catch(e => logLine(`outlook health: прогон упал: ${e.message}`));
        jsonRes(res, 200, { ok: true, started: true, scope, total });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// GET /__switch/api/ol/health-progress → прогресс + сколько осталось (для подписей кнопок).
function handleOlHealthProgress(res) {
    try {
        jsonRes(res, 200, {
            ok: true,
            job: olHealthJob,
            pending: { unchecked: olHealthTargets('unchecked').length, all: olHealthTargets('all').length },
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
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
async function arProxySpawn(opts = {}) {
    try {
        // force = пересоздать безусловно (boot после обновления). Ждём, пока порт реально
        // освободится: он отпускается не мгновенно, а иначе проверка ниже прочитает его
        // как занятый, спавн молча выйдет — и конвертера не будет вообще.
        if (opts.force) {
            const killed = killPortListeners(AR_PROXY_PORT);
            for (let i = 0; i < 20 && killed; i += 1) {
                if (await portIsFree(AR_PROXY_PORT)) break;
                await napMs(100);
            }
        }
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
// Смерть detached-ребёнка со `stdio: 'ignore'` бесследна: в логе оставался бодрый
// «spawn: :20156 (pid N)», а порт был пустой, и причину искать было негде. Обработчик
// ловит и мгновенную смерть (EADDRINUSE, исключение при старте), и позднюю — вторая
// объясняет «прокси работал, а потом Claude Code начал ловить 502 на каждый запрос».
function watchChildExit(child, label, port) {
    child.on('exit', (code, sig) => logLine(
        `${label} :${port} pid ${child.pid} завершился (code ${code === null ? '—' : code}, sig ${sig || '—'})`));
}

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
        watchChildExit(child, 'front-door', port);
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
        watchChildExit(child, 'keepalive AgentRouter', AR_KEEPALIVE_PORT);
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
// 🪤 `active` через мерж НЕ пропускаем: это не поле баланса, а владение активным
// ключом, и правда о нём лежит в AR_ACTIVE_KEY_FILE (его прокси перечитывает на
// каждую попытку). Балансовый чек снимает снимок пула ДО запроса в биллинг, а тот
// идёт 1–2 с; если в это окно ротация или ручное переключение сменили активный
// аккаунт, Object.assign вернул бы на диск `active: true` уже ушедшего — и в файле
// оказывалось ДВА активных (пойман 22.08 владельцем на вкладке AgentRouter:
// previoussack $0.58 + greedybelieve $105, при том что файл ключа указывал на
// второго). Работа от этого не ломалась, но таблица показывала две зелёные метки,
// то есть ответ «на каком аккаунте мы сейчас» переставал быть однозначным.
// Из четырёх пулов мерж-запись есть только у AgentRouter — и порча нашлась только
// у него, у go/tb/xp по одному активному.
function arSaveMerge(changed) {
    const list = Array.isArray(changed) ? changed : [changed];
    const disk = arLoad();
    const byKey = new Map(disk.map(s => [s.api_key, s]));
    for (const upd of list) {
        if (!upd || !upd.api_key) continue;
        const cur = byKey.get(upd.api_key);
        if (cur) {
            const { active, ...rest } = upd;   // владение ключом мержем не переносим
            Object.assign(cur, rest);
            for (const k of BALANCE_CLEARABLE) if (!(k in upd)) delete cur[k];
        }
        else disk.push(Object.assign({}, upd, { active: false }));
    }
    // Инвариант «активен ровно один» восстанавливаем по файлу ключа. Это заодно
    // ЛЕЧИТ уже испорченные файлы — на первом же чеке баланса. Файла нет или он
    // пуст → не трогаем ничего: угадывать активного мы права не имеем.
    const activeKey = (() => { try { return fs.readFileSync(AR_ACTIVE_KEY_FILE, 'utf8').trim(); } catch { return ''; } })();
    if (activeKey) disk.forEach(s => { s.active = s.api_key === activeKey; });
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
    // 🪤 Ключ — ХОСТ ПАНЕЛИ, а не домен: у JustWoker панель и API живут на одном
    // `api.justwoker.icu`, поэтому поддомен здесь обязателен (justwoker.icu не резолвится).
    'api.justwoker.icu': path.join(__dirname, '..', 'justwoker', 'profiles'),
    // У SeekAi панель и API на одном `seekai.cc` — поддомена нет, ключ = сам домен.
    'seekai.cc':       path.join(__dirname, '..', 'seekai', 'profiles'),
    // TrueSOTA: панель и шлюз на одном `true-sota.com`. 🪤 Из всей newapi-механики этому
    // хосту подходит ТОЛЬКО сопоставление профилей по GitHub-логину (newapiMapProfiles):
    // квота и токен у sub2api читаются своим модулем (routing/lib/truesota-account.js),
    // а куки панели там нет вовсе — вход держится на localStorage.
    'true-sota.com':   path.join(__dirname, '..', 'truesota', 'profiles'),
    // KKtoken: панель и API на одном `kktoken.cc`, поддомена нет.
    'kktoken.cc':      path.join(__dirname, '..', 'kktoken', 'profiles'),
    // HCNsec: ключ — ХОСТ ПАНЕЛИ целиком, `api.hcnsec.cn`. GitHub-входа у шлюза нет,
    // но профиль и куки нужны: точный остаток даёт /api/user/self куками профиля.
    'api.hcnsec.cn':   path.join(__dirname, '..', 'hcnsec', 'profiles'),
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

// Расшифровать AES-ключи ВСЕХ профилей одним процессом PowerShell.
//
// Зачем это здесь, а не «когда понадобится». profileAesKey (lib/newapi-account.js)
// зовёт PowerShell СИНХРОННО — замер на этой машине: 0.8–1.3 с на профиль, — и делает
// это внутри HTTP-обработчика чека баланса. Кеш ключей живёт в памяти процесса, значит
// после каждого рестарта дашборда он пуст. Итог, поймано живьём 21.08: рестарт в
// 21:10:59, «Балансы всех» сразу после — событийный цикл заблокирован по секунде на
// каждый профиль, а уже улетевшие fetch'и висят со своим AbortSignal.timeout(15000) и
// в 21:11:52 отваливаются с «The operation was aborted due to timeout». Снаружи это
// читается как «checker сломался, хотя сайт открывается»: точная цифра деградирует
// в прикидку, потому что self не успел ответить до аборта.
//
// Батч расшифровывает всё одним процессом: 40 профилей — 982 мс против 40×966 мс
// по одному. Блокировка остаётся одна и короткая, и только на холодном кеше.
//
// Профили БЕЗ `Local State` пропускаем намеренно: warmAesKeys закеширует им null
// навсегда, а такая папка — это ЛК, который ещё ни разу не открывали; Chromium создаст
// файл позже, и ключ должен подобраться тогда, а не остаться мёртвым до рестарта.
let NEWAPI_KEYS_SCAN_AT = 0;
const NEWAPI_KEYS_SCAN_GAP_MS = 30_000;
function newapiWarmProfileKeys(reason, force = false) {
    const lib = newapiLib();
    if (!lib || !lib.warmAesKeys) return null;
    if (!force && Date.now() - NEWAPI_KEYS_SCAN_AT < NEWAPI_KEYS_SCAN_GAP_MS) return null;
    NEWAPI_KEYS_SCAN_AT = Date.now();
    const dirs = [];
    for (const base of Object.values(NEWAPI_PROFILE_DIRS)) {
        let names = [];
        try { names = fs.readdirSync(base); } catch { continue; }
        for (const n of names) {
            const dir = path.join(base, n);
            try { if (fs.existsSync(path.join(dir, 'Local State'))) dirs.push(dir); } catch {}
        }
    }
    if (!dirs.length) return null;
    const t = Date.now();
    const r = lib.warmAesKeys(dirs) || {};
    // Молчим, когда всё уже было в кеше: иначе лог засоряет каждый чек баланса.
    if (r.warmed || r.failed) {
        logLine(`newapi ключи профилей [${reason}]: ${r.warmed} расшифровано, ${r.failed} мимо, ${Date.now() - t}мс`
            + (r.error ? ` (батч упал: ${r.error})` : ''));
    }
    return r;
}

// Когда ЛК профиля последний раз открывали. Нужно кешу точного баланса: чек-ин и
// пополнение поднимают `quota`, НЕ меняя `used_quota`, поэтому «расход не сдвинулся»
// перестало быть признаком «остаток тот же». Поймано живьём на agentrouter: после
// чек-ина на +$25 дашборд ещё 15 минут показывал прежние $175 с бейджем «точный»,
// а сервер уже отдавал $200 — и вписанные вручную $200 этой же стряпнёй перебивались.
const NEWAPI_LK_OPENED = new Map();   // label → ts
// 🪤 Карта обязана переживать рестарт дашборда. Пока она жила только в памяти, страж
// слепнул ровно тогда, когда нужен: после перезапуска все визиты в ЛК забывались, ветвь
// 4а считала «в кабинет не заходили» и выдавала старую цифру как «точный». Поймано
// 29.08 на GoRouter: панель 1752.52, дашборд 1505.02 «точный», расход у обоих 427.31 —
// разница приехала бонусом мимо расхода, а рестарт в 01:14 стёр отметку о визите.
const NEWAPI_LK_FILE = path.join(__dirname, 'newapi-lk-opened.json');
try {
    const raw = JSON.parse(fs.readFileSync(NEWAPI_LK_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) if (Number(v) > 0) NEWAPI_LK_OPENED.set(String(k), Number(v));
} catch (e) { /* нет файла — первый запуск, отметок и не было */ }
function newapiLkVisited(label) {
    if (!label) return;
    NEWAPI_LK_OPENED.set(String(label), Date.now());
    // Пишем сразу и синхронно: событие редкое (открытие ЛК руками), а потеря отметки
    // стоит дороже — она возвращает ту самую ложную «точную» цифру.
    try { fs.writeFileSync(NEWAPI_LK_FILE, JSON.stringify(Object.fromEntries(NEWAPI_LK_OPENED)), 'utf8'); }
    catch (e) { logLine(`отметка визита в ЛК ${label}: не записалась (${e.message})`); }
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
    for (const [pids, alive] of [[arLkPids, arPidAlive], [goLkPids, goPidAlive], [tbLkPids, tbPidAlive], [jwLkPids, jwPidAlive]]) {
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
// selfSnapshot — сырые {quota, used, id, username}, снятые в живом браузере (чек-ин):
//   готовая точная цифра, за которой не надо идти к шлюзу второй раз. См. ветвь 2а.
async function newapiBalance({ target, host, ccHeaders, usageUrl, subUrl, guessGrant, force = false, selfSnapshot = null }) {
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
    // Дольше этого возраста цифра остаётся ЛУЧШИМ, что у нас есть (альтернативы — анкер и
    // прикидка, обе хуже), но называть её «точной» уже нельзя: наливка мимо расхода
    // накапливается молча. 29.08 так висела трёхдневная цифра GoRouter с бейджем «точный»
    // при разнице 247.50 — на экране она ничем не отличалась от снятой минуту назад.
    const SELF_EXACT_MAX_AGE_MS = 24 * 3600_000;
    const prof = newapiResolveProfile(host, target);
    const selfAt = target.selfCheckedAt ? new Date(target.selfCheckedAt).getTime() : 0;
    // Кеш точной цифры лежит в ОТДЕЛЬНОМ поле selfBalance, а не в target.balance: у
    // аккаунта с анкером в balance стоит вписанное руками, и опираться на него нельзя.
    // Фолбэк на target.balance — для записей, снятых до появления поля, иначе первый
    // чек каждой из них зря пошёл бы на шлюз.
    const cachedSelf = typeof target.selfBalance === 'number' ? target.selfBalance
        : (target.balanceSource === 'self' && typeof target.balance === 'number' ? target.balance : null);
    let self = null;
    if (!selfSnapshot && !force && selfAt && cachedSelf != null
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

    // ── 2а. снимок из живого браузера (чек-ин) ──
    // Цифру отдал тот же /api/user/self, но СЕССИИ САМОЙ СТРАНИЦЫ, пока окно было
    // открыто, — перехватом её собственного ответа (см. watchSelfResponses в
    // agentrouter/open-session.js). Поэтому второй раз спрашивать шлюз незачем: не нужны
    // ни ключи профилей, ни куки с диска, ни запрос за Aliyun WAF — а именно он ловит
    // рейт-лимит и роняет точный баланс всего пула на 10 минут.
    //
    // 🪤 Снимок ПРОВЕРЯЕМ, а не принимаем на слово. Ответ шлюза на колбэк GitHub-входа
    // тоже содержит quota/used_quota — и они ОБНУЛЕНЫ (живой прогон 2026-08-22 на
    // аккаунте с $175 вернул нули). Такая цифра выглядит настоящей, а записала бы в пул
    // $0: с вышибанием активного ключа (moneyKickOnZero) и сломанным детектом чек-ина
    // (granted стал бы нулём и больше никогда не «вырос» бы на $25). Отсюда два условия:
    // выдача не может быть НУЛЕВОЙ и не может УМЕНЬШИТЬСЯ — шлюз выданное не отбирает.
    if (!self && selfSnapshot && lib) {
        const qpu = await lib.quotaPerUnit(host);
        const balance = lib.quotaToUsd(Number(selfSnapshot.quota), qpu);
        const spent = lib.quotaToUsd(Number(selfSnapshot.used), qpu);
        const granted = (balance != null && spent != null) ? round2(balance + spent) : null;
        const prevGranted = Number(target.grantedSelf != null ? target.grantedSelf
            : (target.balanceSource === 'self' ? target.granted : NaN));
        const bad = !isFinite(granted) || granted <= 0 ? 'выдача в снимке нулевая'
            : (isFinite(prevGranted) && granted < prevGranted - 0.01)
                ? `выдача в снимке $${granted.toFixed(2)} МЕНЬШЕ известной $${prevGranted.toFixed(2)}`
                : null;
        if (bad) {
            logLine(`баланс ${host}: снимок из браузера отброшен — ${bad}; считаю обычным путём`);
        } else {
            self = {
                balance, spent, granted,
                newApiUserId: selfSnapshot.id != null ? Number(selfSnapshot.id) : (target.newApiUserId || null),
                newApiUsername: selfSnapshot.username || target.newApiUsername || null,
                profileUsed: prof.label,
                // Штамп — момент ПРИМЕНЕНИЯ, а не съёма: чек-ин зовёт newapiLkVisited
                // перед этим расчётом, и штамп из прошлого не дал бы переиспользовать
                // цифру (условие newapiLkOpenedAt < selfAt), то есть следующий чек всё
                // равно пошёл бы к шлюзу — ровно то, что мы тут и убираем.
                selfCheckedAt: new Date().toISOString(),
                fromBrowser: selfSnapshot.from || 'browser',
            };
            logLine(`баланс ${host}: цифра из браузера (${self.fromBrowser}) — $${balance.toFixed(2)},`
                + ` выдача $${granted.toFixed(2)}; запрос self не понадобился`);
        }
    }

    // 🪤 Браузер профиля ОТКРЫТ — точную цифру взять нечем, и попытка не просто пустая, а
    // вредная. Chromium держит БД куки исключительно (EBUSY на чтение) и свою актуальную
    // версию хранит в памяти, а refresh-кука на этих панелях одноразовая: открыв ЛК, браузер
    // её прокрутил, и наша копия в jar уже погашена. Запрос с ней приносит `401`, который
    // выглядит как «сессия профиля недействительна» — то есть как умерший вход, хотя вход
    // живой и виден владельцу на экране. Ровно на это 29.08 упёрся `WA git gorouter`: в
    // панели 1752.52, в дашборде 1505.02 с бейджем «точный».
    // Спрашиваем не файловый замок, а карту pid'ов (newapiLkBusy) — она отвечает про факт
    // «окно открыто», а не про симптом, и не зависит от того, успел ли Chromium сбросить
    // файл. Ветвь пропускаем, если вход держится на токене: ему куки профиля не нужны.
    // 🪤 Одной карты pid'ов мало: она в памяти процесса, и рестарт дашборда её обнуляет —
    // браузер, открытый ДО перезапуска, для неё не существует вовсе (проверено 29.08:
    // после рестарта в 17:4x `newapiLkBusy` вернул false при живом окне). Вторым признаком
    // берём файловый замок БД куки: Chromium держит её исключительно, пока окно открыто, и
    // этот признак не зависит ни от того, кто окно запустил, ни от нашего аптайма.
    const lkBusy = !target.accessToken && prof.label
        ? (newapiLkBusy(prof.label)
            || !!(profileDir && lib && lib.cookieDbLocked && lib.cookieDbLocked(profileDir)))
        : false;
    // Возраст кешированной цифры и вердикт «точной называть нельзя» — ОДИН на все ветви,
    // которые её отдают. 🪤 Сначала это лежало только в ветви 4а, и владелец 29.08 увидел
    // ровно последствие: открыл ЛК по совету, отметка визита запретила 4а, ответ пришёл из
    // ветви 4б — и тост опять сказал «точный, из кеша», потому что новых полей там не было.
    const cachedAgeMs = selfAt ? Math.max(0, Date.now() - selfAt) : 0;
    const cachedAgeTxt = cachedAgeMs >= 3600_000
        ? `${Math.round(cachedAgeMs / 3600_000)} ч назад`
        : `${Math.round(cachedAgeMs / 60_000)} мин назад`;
    const cachedStale = lkBusy || cachedAgeMs > SELF_EXACT_MAX_AGE_MS;
    if (!self && lkBusy) {
        selfError = 'браузер этого аккаунта ОТКРЫТ — Chromium запер куки, а нашу копию сессии он уже прокрутил.'
            + ' Закрой окно ЛК и повтори чек — цифра станет точной';
        logLine(`баланс ${host}: профиль ${prof.label} открыт в браузере — точный чек пропущен, чтобы не жечь сессию`);
    } else if (!self && lib && (profileDir || target.accessToken)) {
        // Ключи профилей — ДО первого сетевого запроса self. Здесь блокировка событийного
        // цикла безопасна (в воздухе ничего нет), а внутри accountSelf она обрывала бы
        // соседние fetch'и пачки по таймауту. Холодный кеш — один процесс на все профили,
        // тёплый — выход по гейту 30с, то есть бесплатно (см. newapiWarmProfileKeys).
        // Со снимком из браузера сюда не заходим вообще — расшифровывать нечего.
        newapiWarmProfileKeys('чек баланса');
        try {
            const me = await lib.accountSelf({
                host,
                profileDir,
                accessToken: target.accessToken || null,
                userId: target.newApiUserId || null,
                // Клик владельца по цифре пробивает паузу по частоте ОДНИМ запросом:
                // бан у WAF короткий, и к моменту клика он обычно уже снят. Автоматические
                // тики (force=false) паузу соблюдают — они её и вызывают.
                force,
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

    // ── 3. anchor: вписанная руками цифра как РЕЗЕРВ, когда точной нет ──
    // Анкер — это «баланс, который владелец увидел в ЛК своими глазами и вписал ✏️».
    // Дальше он живёт сам: убывает на расход и растёт на то, что шлюз налил после
    // вписывания. Смысл его один — не показывать выдуманную прикидку `ceil(spent/25)*25`
    // там, где точную цифру взять негде (нет куки профиля, шлюз за WAF, ЛК не открывали).
    //
    // ⚠️ ПОРЯДОК ИЗМЕНЁН 2026-08-24 по решению владельца: цифра САЙТА главнее вписанной.
    // До этого анкер возвращался ДО точной цифры и перекрывал её — на JustWoker `WA
    // justwoker` это дало $0.26 в дашборде при $604.38 в кабинете: анкер вписан 22.08,
    // когда на счету и было $0.26, потом шлюз налил, а прирост подхватить оказалось
    // нечем (сессия JustWoker в профиле умерла → `self` промахивался, `topUp` = 0).
    // Владелец: «пробует проверить баланс с сайта — за истину считать сайт; анкер нужен,
    // только когда сайт недоступен». Поэтому теперь анкер стоит ПОСЛЕ ветвей self и 4а.
    // Сам он никуда не удаляется: вписанное остаётся резервом на следующий промах.
    let anchorDrained = null;
    let anchorResult = null;
    const anchor = Number(target.balanceAnchor);
    if (isFinite(anchor) && anchor > 0 && target.anchorSpent != null) {
        const drawn = Math.max(0, round2(usageSpent - Number(target.anchorSpent)));
        // Пополнение или бонус после вписывания: шлюз поднял выдачу — ту же сумму
        // прибавляем к вписанному, иначе анкер вечно показывал бы предподарочный остаток.
        // База — выдача шлюза на момент вписывания; у записей, сделанных до этого фикса,
        // её нет: прироста тогда нет, а базу проставит первый успешный self.
        // «Сейчас» берём из свежего self, а если его нет — из последней известной цифры
        // шлюза: анкер теперь работает именно там, где свежего self не случилось.
        const baseGranted = Number(target.anchorGrantedSelf);
        const nowGranted = self && self.granted != null ? Number(self.granted)
            : (target.grantedSelf != null ? Number(target.grantedSelf) : NaN);
        const topUp = (isFinite(baseGranted) && isFinite(nowGranted) && nowGranted > baseGranted)
            ? round2(nowGranted - baseGranted) : 0;
        const left = round2(anchor + topUp - drawn);
        // Ушло в ноль или минус — привязка устарела (расход обогнал вписанное).
        // Отдавать её как факт нельзя: показываем прикидку, и UI просит вписать заново.
        if (left > 0) {
            anchorResult = {
                status: 'live',
                balanceSource: 'anchor',
                balance: left,
                spent: usageSpent,
                usageSpent,
                granted: null,
                anchorTopUp: topUp,
                self,           // точная цифра нужна для детекта чек-ина, даже когда показываем анкер
            };
        } else {
            anchorDrained = 'вписанный баланс исчерпан расходом — впиши заново';
        }
    }

    // ── 4. точная цифра: сайт главнее вписанного вручную ──
    if (self) {
        // Расхождение с анкером говорим вслух: владелец вписывал цифру осознанно, и то,
        // что теперь показывается другая, он должен видеть в логе, а не только в тултипе.
        if (anchorResult && Math.abs(anchorResult.balance - self.balance) >= 0.01) {
            logLine(`баланс ${host}: беру цифру сайта $${Number(self.balance).toFixed(2)}`
                + ` вместо вписанных вручную $${anchorResult.balance.toFixed(2)}`
                + ` (вписано ${target.anchoredAt || 'когда-то'}; ✏️ остаётся резервом на случай, когда сайт молчит)`);
        }
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

    // ── 4а. последний ответ шлюза, когда свежий не дался ──
    // self промахнулся (заглушка WAF, пауза по частоте, истёкшая кука), но у нас лежит
    // цифра, которую шлюз уже называл. Уменьшить остаток может ТОЛЬКО расход, а расход
    // мы измерили секунду назад тем же `usage`: не сдвинулся с того чека → цифра всё
    // ещё верна, и возраст тут ни при чём. TTL выше (`SELF_REUSE_MS`) решает «идти ли
    // к шлюзу», а не «помним ли мы его ответ» — это разные вопросы, и раньше они были
    // склеены в один: один промах self ронял аккаунт в прикидку `ceil(spent/25)*25`,
    // то есть в вымысел, при известной точной цифре в `selfBalance`. На 22.08 так
    // стояли три аккаунта пула, и у всех трёх прикидка случайно совпала — поэтому
    // потеря была не видна глазом.
    //
    // Единственное, чего эта ветвь не видит, — наливка мимо расхода (чек-ин в ЛК,
    // пополнение владельцем). Отсюда условие про визит в ЛК: заходили после чека —
    // цифра не годится. Ошибка в остатке возможна только в сторону ЗАНИЖЕНИЯ
    // (наливка увеличивает остаток), а занижение для решений про деньги безопасно:
    // ротация выберет другой аккаунт, а не потратит несуществующее.
    if (cachedSelf != null && selfAt
        && Number(target.usageSpentAtSelf) === usageSpent
        && newapiLkOpenedAt(prof.label) < selfAt) {
        const cachedGranted = target.grantedSelf != null ? Number(target.grantedSelf)
            : (typeof target.granted === 'number' ? Number(target.granted) : null);
        // Возраст цифры и признак «называть точной нельзя» считаются выше, одни на все
        // ветви кеша: раньше они жили только здесь, и ветвь 4б отдавала цифру без пометки.
        const ageTxt = cachedAgeTxt;
        const cached = {
            reused: true,
            balance: cachedSelf,
            spent: usageSpent,
            granted: cachedGranted,
            newApiUserId: target.newApiUserId,
            newApiUsername: target.newApiUsername,
            selfCheckedAt: target.selfCheckedAt,   // НЕ обновляем: иначе TTL перезапустится и к шлюзу мы больше не пойдём
        };
        logLine(`баланс ${host}: свежий self не дался (${selfError || 'без причины'}),`
            + ` расход не сдвинулся ($${usageSpent.toFixed(2)}) — держу цифру $${cachedSelf.toFixed(2)},`
            + ` снятую ${ageTxt}${cachedStale ? ' (устарела — показываю как неточную)' : ''}`);
        return {
            status: 'live',
            balanceSource: 'self',
            reused: true,
            selfCached: true,          // цифра точная, но не переспрошенная — UI помечает и объясняет
            // Отдельный флаг для UI и решений: «точная, но старая» — не то же самое, что
            // «точная». Источник не меняем (`self`), чтобы не задеть ротацию и сортировки.
            selfStale: cachedStale,
            selfAgeMs: cachedAgeMs,
            balance: cached.balance,
            spent: cached.spent,
            usageSpent,
            granted: cached.granted,
            newApiUserId: cached.newApiUserId,
            newApiUsername: cached.newApiUsername,
            selfCheckedAt: cached.selfCheckedAt,
            // Возраст ДОПИСЫВАЕМ к причине, а не заменяем её: «почему свежая не далась» и
            // «насколько стара показанная» — два разных факта, и человеку нужны оба.
            selfError: cachedStale
                ? `${selfError ? `${selfError}; ` : ''}показана цифра, снятая ${ageTxt}`
                : selfError,
            self: cached,
        };
    }

    // ── 4б. память шлюза против анкера И против прикидки: побеждает память ──
    // Строгая ветвь 4а сюда не пустила по одной из двух причин: сдвинулся расход или
    // после того чека заходили в ЛК. Обе означают «цифра могла устареть», но устареть
    // она может ТОЛЬКО В МИНУС: расход мы измерили секунду назад и вычитаем сами, а
    // наливка в ЛК остаток увеличивает.
    //
    // Альтернативы у неё две, и обе хуже:
    //   анкер — вписанное когда-то и убывающее на расход (случай `WA justwoker` 24.08:
    //     в записи лежала точная $604.38, а в таблице стоял анкер $0.26);
    //   прикидка `ceil(spent/25)*25` — выдумка, которая умеет ЗАВЫШАТЬ.
    //
    // 🪤 Разбор 25.08, из-за которого ветвь распространили и на случай «анкера нет».
    // Автоподарок на `lustrouscult` отработал идеально: браузер снял $225.00 (+$25),
    // маркер уехал, `grantedSelf` в записи стал 225. А в таблице встало **$175 (прикидка)**
    // с `selfError: WAF-заглушка (слишком часто), пауза 10 мин`: следующий автоматический
    // чек попал в рейт-лимит Aliyun, `self` промахнулся, визит в ЛК запретил ветвь 4а —
    // и точная цифра, которую мы ЗНАЕМ, была выброшена в пользу выдуманной. Прикидка ещё и
    // соврала в плюс: 175 против настоящих 225 — то есть решения о деньгах принимались бы
    // по числу, которого нет.
    // Понижать память анкером НЕ имеем права: анкер выше памятной бывает законно —
    // владелец видел кабинет позже нашего чека.
    if (cachedSelf != null && selfAt) {
        const spentAtSelf = Number(target.usageSpentAtSelf);
        const drawnSince = isFinite(spentAtSelf) ? Math.max(0, round2(usageSpent - spentAtSelf)) : 0;
        const left = round2(cachedSelf - drawnSince);
        const anchorShows = anchorResult ? anchorResult.balance : 0;
        if (left > 0 && left > anchorShows) {
            const when = target.selfCheckedAt ? new Date(target.selfCheckedAt).toLocaleString('ru-RU') : 'когда-то';
            logLine(`баланс ${host}: беру ПАМЯТНУЮ цифру шлюза $${left.toFixed(2)} (снята ${when}`
                + `${drawnSince ? `, минус расход $${drawnSince.toFixed(2)}` : ''}) вместо`
                + ` ${anchorResult ? `вписанных вручную $${anchorResult.balance.toFixed(2)}` : 'прикидки'}`
                + ` — занижение возможно, завышение нет (${selfError || 'свежая не далась'})`);
            return {
                status: 'live',
                balanceSource: 'self',
                reused: true,
                selfCached: true,
                // Эта ветвь работает ИМЕННО тогда, когда 4а отказала: сдвинулся расход или
                // заходили в ЛК. Второе — прямой признак, что деньги могли прийти мимо
                // расхода, то есть «точной» цифру называть тем более нельзя. Плюс она здесь
                // ещё и производная: из памятной вычтен расход с того чека.
                selfStale: true,
                selfAgeMs: cachedAgeMs,
                balance: left,
                spent: usageSpent,
                usageSpent,
                granted: target.grantedSelf != null ? Number(target.grantedSelf) : null,
                newApiUserId: target.newApiUserId,
                newApiUsername: target.newApiUsername,
                selfCheckedAt: target.selfCheckedAt,   // НЕ обновляем: TTL не должен перезапуститься
                selfError: `${selfError || 'свежую цифру взять не удалось'}; показана последняя, что называл шлюз`
                    + ` (снята ${cachedAgeTxt}${drawnSince ? `, минус расход $${drawnSince.toFixed(2)}` : ''})`,
                self: (anchorResult && anchorResult.self) || null,
            };
        }
    }

    // ── 4в. анкер: вписанное руками, когда цифры сайта нет ни свежей, ни памятной ──
    // Сюда доходим, только если self промахнулся И памятная цифра либо отсутствует, либо
    // меньше вписанного. Вписанное лучше прикидки: это цифра, которую владелец видел
    // своими глазами, уменьшенная на измеренный расход.
    if (anchorResult) {
        logLine(`баланс ${host}: цифры сайта нет (${selfError || 'без причины'}) —`
            + ` показываю вписанное вручную $${anchorResult.balance.toFixed(2)}`
            + (anchorResult.anchorTopUp > 0 ? ` (в том числе +$${anchorResult.anchorTopUp.toFixed(2)} налито после вписывания)` : ''));
        return { ...anchorResult, selfError };
    }

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
    // Отрицательного остатка на ключе не бывает: шлюз бы просто отказал. Значит
    // выдачу угадали мимо (у hcnsec так получалось −$2174) — и честный ответ
    // «неизвестно», а не минус, который потом складывается в шапку дашборда как
    // деньги. `granted: null` тоже обязателен: иначе шкала запаса делит на угаданное.
    const grantTotal = round2(legacyGrant + bonus + referral);
    const guessBalance = round2(grantTotal - usageSpent);
    if (!(grantTotal > 0) || guessBalance < 0) {
        return {
            status: 'live',
            balanceSource: 'unknown',
            balance: null,
            spent: usageSpent,
            usageSpent,
            granted: null,
            accessUntil,
            selfError,
        };
    }
    return {
        status: 'live',
        balanceSource: 'guess',
        balance: guessBalance,
        spent: usageSpent,
        usageSpent,
        granted: grantTotal,
        accessUntil,
        selfError,
    };
}

// Баланс ключа AgentRouter. Точный — из /api/user/self; резервы см. newapiBalance.
// opts.force — не брать сохранённую цифру, спросить сервис (явный клик пользователя).
// opts.selfSnapshot — готовая цифра, снятая в браузере при чек-ине (запрос self не нужен).
async function arBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'agentrouter.org',
        ccHeaders: AR_CC_HEADERS,
        usageUrl: `${AR_BASE_URL}/dashboard/billing/usage`,
        subUrl: `${AR_BASE_URL}/v1/dashboard/billing/subscription`,
        guessGrant: spent => Math.max(AR_DEFAULT_GRANT, Math.ceil(spent / AR_GRANT_STEP) * AR_GRANT_STEP),
        force: !!opts.force,
        selfSnapshot: opts.selfSnapshot || null,
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
        // Дельты считаем ДО записи новых цифр: расход за интервал — это прирост
        // spent, наливка — прирост granted (новый аккаунт, реф-бонус, чек-ин).
        const prevSpent = Number(target.spent), prevGrant = Number(target.granted);
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
        // что починить (сопоставить профиль / переоткрыть ЛК). У ветви 4а причина обязана
        // выжить: цифра точная, но не переспрошенная, и владелец должен знать почему.
        if (seen && !bal.selfCached) delete target.selfError;
        else if (bal.selfError) target.selfError = bal.selfError;
        if (bal.selfCached) target.selfCached = true; else delete target.selfCached;
        delete target.balanceError;
        // Пишем историю только когда цифры реально сдвинулись. Первый чек аккаунта
        // (prev === NaN) даёт дельту 0, а не весь накопленный расход: иначе в день
        // подключения пула на график прилетел бы фальшивый пик на всю историю.
        const dSpent = isFinite(prevSpent) && typeof bal.spent === 'number' ? bal.spent - prevSpent : 0;
        const dGrant = isFinite(prevGrant) && bal.granted != null ? Number(bal.granted) - prevGrant : 0;
        if (Math.abs(dSpent) > 0.0001 || Math.abs(dGrant) > 0.0001) {
            financeLog({
                t: new Date().toISOString(),
                p: (opts && opts.provider) || 'newapi',
                id: target.id || target.email || String(target.api_key || '').slice(-6),
                dSpent: Number(dSpent.toFixed(4)),
                dGrant: Number(dGrant.toFixed(4)),
                spent: typeof bal.spent === 'number' ? Number(bal.spent.toFixed(4)) : null,
                balance: typeof bal.balance === 'number' ? Number(bal.balance.toFixed(4)) : null,
                src: bal.balanceSource || null,
            });
        }
    } else {
        // Цифры оставляем прошлые (лучше устаревшие, чем нули), но помечаем причину.
        target.balanceError = bal.error || bal.status;
    }
    // Свежая цифра по активному ключу пришла нулевой — подменяем аккаунт сразу, не
    // дожидаясь, пока на нём споткнётся живой запрос Claude Code. Своих опросов
    // биллинга это не заводит: чек уже сделан, мы только смотрим на результат.
    // Гвард на выключенный тумблер и на неактивную запись — внутри moneyKickOnZero.
    if (opts && opts.provider) moneyKickOnZero(opts.provider, target);
    return bal;
}

// Детект чек-ина включён только здесь: у GoRouter чек-ина нет вообще, у XPeach
// шлюз сам отдаёт checkin_enabled: false. У JustWoker чек-ин ЕСТЬ
// (checkin_enabled: true), но выдаёт случайную сумму — «+N» на дельте баланса
// приняло бы за наливку любой возврат неизрасходованной квоты, поэтому детект там
// сознательно не включён (jwApplyBalance идёт без checkin).
function arApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { checkin: true, provider: 'agentrouter' }); }

// GET /__switch/api/finance/history?range=day|week|month
// Отдаёт бакеты для графика: расход (прирост spent) и наливка (прирост granted).
// Бакет — час для «дня», сутки для остальных. Плюс текущий снимок пулов, чтобы
// вкладка не дёргала пять ручек сессий ради двух сумм.
// ═══════════ ЛИГА: свой срез для рейтинга между установками хаба ════════════
// Одна ручка отдаёт всё, что рисует вкладка «Лига»: токены, деньги, активность и
// аккаунты в четырёх окнах. Ключей, почт, ссылок и текста промптов здесь НЕТ —
// только счётчики, поэтому этот же объект уедет на приёмник без вычищения.
const HUB_IDENTITY_FILE = path.join(__dirname, 'hub-identity.json');
const CC_STATS_CACHE_FILE = path.join(os.homedir(), '.claude', 'stats-cache.json');
const CC_HISTORY_FILE = path.join(os.homedir(), '.claude', 'history.jsonl');

// Ключи бакетов — по МЕСТНОМУ времени. В UTC сутки резались по Гринвичу: в MSK всё
// до 03:00 уезжало во «вчера», а часовой график был сдвинут на три часа.
const pad2 = v => String(v).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hourKey = d => `${dayKey(d)}T${pad2(d.getHours())}`;
const bucketKey = (d, hour) => (hour ? hourKey(d) : dayKey(d));

// Сетка последних n шагов, последний — текущий. Окно скользящее, а не календарное:
// «за сутки» это 24 часа назад от сейчас, иначе в 00:10 график пустой.
function timeKeys(n, hour) {
    const now = new Date(), keys = [], labs = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now);
        if (hour) d.setHours(d.getHours() - i); else d.setDate(d.getDate() - i);
        keys.push(bucketKey(d, hour));
        labs.push(hour ? pad2(d.getHours()) + ':00' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
    }
    return { keys, labs };
}

// Ник: пробелы в подчёркивания, буквы любого алфавита, 2…20 символов.
function leagueNickClean(v) {
    const t = String(v || '').trim().replace(/\s+/g, '_')
        .replace(/[^\p{L}\p{N}_.\-]/gu, '').slice(0, 20);
    return t.length >= 2 ? t : '';
}

// installId постоянный: переименование не должно заводить в рейтинге вторую строку.
// Ник по умолчанию — из `git config user.name`, как и договаривались.
function hubIdentity() {
    let doc = {};
    try {
        const raw = fs.readFileSync(HUB_IDENTITY_FILE, 'utf8');
        doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    } catch { /* первый запуск */ }
    let dirty = false;
    if (typeof doc.installId !== 'string' || doc.installId.length < 8) {
        doc.installId = crypto.randomBytes(8).toString('hex');
        dirty = true;
    }
    if (!leagueNickClean(doc.nick)) {
        let git = '';
        try {
            git = execFileSync('git', ['config', 'user.name'],
                { cwd: __dirname, encoding: 'utf8', timeout: 3000 }).trim();
        } catch { /* нет git или имя не задано — не беда */ }
        doc.nick = leagueNickClean(git) || ('hub-' + doc.installId.slice(0, 4));
        dirty = true;
    }
    if (dirty) {
        try { fs.writeFileSync(HUB_IDENTITY_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8'); }
        catch (e) { logLine(`league identity write: ${e.message}`); }
    }
    return { installId: doc.installId, nick: doc.nick, joined: doc.joined || null };
}
// Единственная реализация правил денежных дельт: знаковый расход, отлов сброса
// счётчика, дедуп наливки, отметка реконструкции. Ею считают и вкладка «Финансы»,
// и «Лига» — второй копии этих правил в проекте быть не должно, они уже расходились.
const GRANT_DEDUP_MS = 5000;
function financeAggregate(keys, hour) {
    const idx = new Map(keys.map((k, i) => [k, i]));
    const buckets = keys.map(k => ({ k, spend: 0, topup: 0, events: 0,
        resets: 0, dupTopup: 0, estSpend: 0, estTopup: 0,
        tin: 0, tout: 0, tcr: 0, tcw: 0, tcost: 0, treq: 0 }));
    let lines = 0, used = 0, bad = 0;
    const grantSeen = new Map();
    let raw = '';
    try { raw = fs.readFileSync(FINANCE_HISTORY_FILE, 'utf8'); } catch (e) { /* истории ещё нет */ }
    for (const ln of raw.split('\n')) {
        if (!ln) continue;
        lines++;
        let e; try { e = JSON.parse(ln); } catch (_) { bad++; continue; }
        const d = new Date(e.t);
        if (isNaN(d.getTime())) { bad++; continue; }
        const i = idx.get(bucketKey(d, hour));
        if (i == null) continue;                       // вне окна — молча мимо
        used++;
        const b = buckets[i];
        // Дельты берём ЗНАКОВЫМИ. Было `if (e.dSpent > 0)` — откат расхода (шлюз
        // пересчитал в минус) выпадал целиком, и месячная трата выходила завышенной
        // на 6.3%. Отдельно ловим СБРОС счётчика: сильный минус при почти нулевом
        // `spent` — это не откат, а новый цикл на ключе, вычитать его нельзя.
        const dS = Number(e.dSpent) || 0, dG = Number(e.dGrant) || 0;
        const isReset = dS < -1 && Math.abs(Number(e.spent) || 0) <= Math.abs(dS) * 0.02;
        if (isReset) b.resets++;
        else if (dS) b.spend += dS;
        if (dG) {
            // Одна наливка, записанная дважды за секунды (два чека подряд по одному
            // ключу), удваивала «пополнено» — на месяце это $908 лишних. Отсеянное не
            // выбрасываем, а копим в `dupTopup`, чтобы расхождение было видно.
            const gk = `${e.p}|${e.id}|${dG.toFixed(4)}`;
            const tMs = d.getTime();
            const prevMs = grantSeen.get(gk);
            if (prevMs && tMs - prevMs <= GRANT_DEDUP_MS) b.dupTopup += dG;
            else b.topup += dG;
            grantSeen.set(gk, tMs);
        }
        // `est: true` ставит finance-backfill.js — это реконструкция, не измерение.
        // Считаем отдельно, чтобы вкладка могла сказать, какая часть цифры досочинена.
        if (e.est) { b.estSpend += Math.max(0, dS); b.estTopup += Math.max(0, dG); }
        b.events++;
    }
    return { buckets, idx, lines, used, bad };
}
// Журнал front-door: один проход → суммы по часам и по дням. Токены = ВХОД+ВЫХОД;
// кеш (чтение/запись) копится отдельно и в метрику не мешается. Кеш нельзя внести
// в кривую «всё время»: по суткам его знает только сводка `modelUsage` целиком, а
// не по дням, и смена определения посреди окон соврала бы в главной цифре.
let TOKEN_JOURNAL_CACHE = { mtime: -1, day: new Map(), hour: new Map(),
    cday: new Map(), chour: new Map(), lines: 0, first: null };
function tokenJournalCounts() {
    let st; try { st = fs.statSync(TOKEN_USAGE_FILE); } catch { return TOKEN_JOURNAL_CACHE; }
    if (st.mtimeMs === TOKEN_JOURNAL_CACHE.mtime) return TOKEN_JOURNAL_CACHE;
    const day = new Map(), hour = new Map(), cday = new Map(), chour = new Map();
    let lines = 0, first = null;
    const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    try {
        for (const ln of fs.readFileSync(TOKEN_USAGE_FILE, 'utf8').split('\n')) {
            if (!ln) continue;
            let e; try { e = JSON.parse(ln); } catch (_) { continue; }
            const d = new Date(e.t);
            if (isNaN(d.getTime())) continue;
            lines++;
            if (!first) first = d;
            const dk = dayKey(d), hk = `${dk}T${pad2(d.getHours())}`;
            bump(day, dk, (Number(e.in) || 0) + (Number(e.out) || 0));
            bump(hour, hk, (Number(e.in) || 0) + (Number(e.out) || 0));
            bump(cday, dk, (Number(e.cr) || 0) + (Number(e.cw) || 0));
            bump(chour, hk, (Number(e.cr) || 0) + (Number(e.cw) || 0));
        }
    } catch (e) { /* журнала ещё нет — не ошибка */ }
    TOKEN_JOURNAL_CACHE = { mtime: st.mtimeMs, day, hour, cday, chour, lines, first };
    return TOKEN_JOURNAL_CACHE;
}

// Активность = промпты человека из ~/.claude/history.jsonl: одна строка на каждое
// нажатие Enter. Считаем ТОЛЬКО количество; текст промптов не читается и наружу не
// уезжает. Файл 6.4 МБ и растёт — кеш по mtime.
// Почему не `dailyActivity` из stats-cache: он считает все сообщения диалога
// (267 тыс. против 17.5 тыс. промптов) и отстаёт — на 05.09 последний день там 01.09.
let CC_PROMPTS_CACHE = { mtime: -1, day: new Map(), hour: new Map(), total: 0, first: null };
function ccPromptCounts() {
    let st; try { st = fs.statSync(CC_HISTORY_FILE); } catch { return CC_PROMPTS_CACHE; }
    if (st.mtimeMs === CC_PROMPTS_CACHE.mtime) return CC_PROMPTS_CACHE;
    const day = new Map(), hour = new Map();
    let total = 0, first = null;
    try {
        for (const ln of fs.readFileSync(CC_HISTORY_FILE, 'utf8').split('\n')) {
            if (!ln) continue;
            let e; try { e = JSON.parse(ln); } catch (_) { continue; }
            const d = new Date(Number(e.timestamp) || 0);
            if (isNaN(d.getTime()) || d.getFullYear() < 2024) continue;
            total++;
            if (!first) first = d;
            const dk = dayKey(d), hk = `${dk}T${pad2(d.getHours())}`;
            day.set(dk, (day.get(dk) || 0) + 1);
            hour.set(hk, (hour.get(hk) || 0) + 1);
        }
    } catch (e) { /* истории нет — активность просто нулевая */ }
    CC_PROMPTS_CACHE = { mtime: st.mtimeMs, day, hour, total, first };
    return CC_PROMPTS_CACHE;
}
// stats-cache самого Claude Code — единственный источник токенов ДО появления
// журнала хаба (тот живёт с 25.08). `tokensByModel` — это вход+выход, ровно та же
// величина, что мы считаем по журналу: окна сшиваются без подмены определения.
// Отличается только охват: stats-cache видит один Claude Code, журнал — все харнессы
// через front-door. Поэтому за дни, где есть журнал, берём журнал.
let CC_STATS_CACHE = { mtime: -1, day: new Map(), lastComputed: null, first: null };
function ccDailyTokens() {
    let st; try { st = fs.statSync(CC_STATS_CACHE_FILE); } catch { return CC_STATS_CACHE; }
    if (st.mtimeMs === CC_STATS_CACHE.mtime) return CC_STATS_CACHE;
    const day = new Map();
    let lastComputed = null, first = null;
    try {
        const raw = fs.readFileSync(CC_STATS_CACHE_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        lastComputed = doc.lastComputedDate || null;
        for (const rec of (doc.dailyModelTokens || [])) {
            if (!rec || !rec.date) continue;
            let sum = 0;
            for (const m in (rec.tokensByModel || {})) sum += Number(rec.tokensByModel[m]) || 0;
            day.set(rec.date, sum);
            if (!first) first = rec.date;
        }
    } catch (e) { /* нет файла или битый — обойдёмся журналом */ }
    CC_STATS_CACHE = { mtime: st.mtimeMs, day, lastComputed, first };
    return CC_STATS_CACHE;
}

// Стрик: сколько суток подряд был хотя бы один промпт. Если сегодня ещё не начинали,
// счёт ведём от вчера — иначе в 03:00 стрик обнулялся бы на ровном месте.
function ccStreak(dayMap) {
    const d = new Date();
    if (!dayMap.has(dayKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (dayMap.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
}

// Аккаунты — две разные вещи, и в одну сумму их не сводим: ЗАКУПЛЕНО это гитхабы,
// купленные с кредами (за них платили деньгами), ЗАРЕГАНО — ключи на шлюзах,
// которые авторег завёл через эти гитхабы (за них платили временем).
function leagueAccounts() {
    const byDay = new Map();
    const mark = ts => {
        const d = new Date(ts);
        if (isNaN(d.getTime()) || d.getFullYear() < 2024) return;
        const k = dayKey(d);
        byDay.set(k, (byDay.get(k) || 0) + 1);
    };
    let bought = 0, boughtCreds = 0;
    try {
        const gh = ghLoad();
        bought = gh.length;
        boughtCreds = gh.filter(a => a && (a.password || a.totpSecret)).length;
        for (const a of gh) mark(a && a.added);
    } catch (e) { /* нет файла — просто нули */ }
    let reg = 0;
    const perPool = {};
    for (const [tag, load] of [['agentrouter', arLoad], ['gorouter', goLoad], ['tabi', tbLoad],
        ['xpeach', xpLoad], ['justwoker', jwLoad], ['seekai', skLoad], ['truesota', tsLoad],
        ['kktoken', kkLoad]]) {
        try {
            const arr = load() || [];
            perPool[tag] = arr.length; reg += arr.length;
            for (const s of arr) mark(s && s.created);
        } catch (e) { /* пула нет */ }
    }
    // Кривая накопления — по настоящим датам заведения (`added` у гитхабов, `created`
    // у ключей), а не досочинённая: счётчик заведённых убывать не может, поэтому в дни
    // без закупок держим предыдущее значение. Считаем ОБА вида вместе, иначе кривая
    // упиралась бы в 32 при итоге 174 — как и было в первом прогоне.
    let run = 0;
    const cum = [...byDay.keys()].sort().map(k => { run += byDay.get(k); return [k, run]; });
    return { bought, boughtCreds, reg, perPool, cum, dated: run };
}
// Деньги на руках: сумма ПОЛОЖИТЕЛЬНЫХ остатков по живым ключам денежных шлюзов.
// Отрицательный остаток — промах угадывания выдачи, в сумму он не идёт: ровно это
// расхождение ($2192, 12.4%) заставляло шапку дашборда врать.
function leagueBalance() {
    let balance = 0, spent = 0, keys = 0, unknown = 0;
    for (const load of [arLoad, goLoad, tbLoad, xpLoad, jwLoad, skLoad, tsLoad, kkLoad]) {
        let arr = [];
        try { arr = load() || []; } catch (e) { continue; }
        for (const s of arr) {
            keys++;
            spent += Number(s.spent) || 0;
            if (s.status === 'dead' || s.status === 'no_key') continue;
            if (typeof s.balance !== 'number') continue;
            if (s.balance < 0) { unknown++; continue; }
            balance += s.balance;
        }
    }
    return { balance: round2(balance), spent: round2(spent), keys, unknown };
}

// Свой срез целиком. Метрики: токены (вход+выход), деньги (расход), активность
// (промпты), аккаунты (накопительно). Окна: скользящие сутки по часам, 7 и 30 дней
// по суткам, всё время по суткам.
function leagueSelf() {
    const id = hubIdentity();
    const tj = tokenJournalCounts(), pr = ccPromptCounts(), sc = ccDailyTokens();
    const acc = leagueAccounts(), money = leagueBalance();

    // «Всё время» — от самого раннего известного дня до СЕГОДНЯ. Ключи строим сами:
    // stats-cache посчитан до 01.09 и обрезал бы четверо последних суток.
    const firstDays = [sc.first, tj.first && dayKey(tj.first), pr.first && dayKey(pr.first)]
        .filter(Boolean).sort();
    const today = dayKey(new Date());
    const allKeys = [];
    if (firstDays.length) {
        const d = new Date(firstDays[0] + 'T12:00:00');
        for (let guard = 0; guard < 4000; guard++) {
            const k = dayKey(d);
            allKeys.push(k);
            if (k >= today) break;
            d.setDate(d.getDate() + 1);
        }
    } else allKeys.push(today);
    const allLabs = allKeys.map(k => k.slice(5));

    // Токены по дням: где есть журнал хаба — берём его (шире и свежее), раньше —
    // stats-cache. Первые сутки журнала неполные (он начался днём), поэтому граница
    // сдвинута на сутки вперёд, иначе 25.08 просел бы вдвое.
    const cut = tj.first ? dayKey(new Date(tj.first.getTime() + 864e5)) : null;
    const tokDay = new Map(sc.day);
    for (const [k, v] of tj.day) if (!cut || k >= cut) tokDay.set(k, v);

    const hKeys = timeKeys(24, true), k7 = timeKeys(7), k30 = timeKeys(30);
    const faDay = financeAggregate(allKeys, false);
    const faHour = financeAggregate(hKeys.keys, true);
    const spDay = new Map(faDay.buckets.map(b => [b.k, b.spend]));
    const topupDay = new Map(faDay.buckets.map(b => [b.k, b.topup]));
    const proj = (m, keys) => keys.map(k => Math.round((m.get(k) || 0)));
    const proj2 = (m, keys) => keys.map(k => round2(m.get(k) || 0));
    // Накопительный счётчик аккаунтов: в дни без закупок держит предыдущее значение.
    const accAt = keys => { const m = new Map(acc.cum); let last = 0;
        return keys.map(k => { if (m.has(k)) last = m.get(k); return last; }); };
    const sum = a => a.reduce((x, y) => x + y, 0);

    const tok = { h24: proj(tj.hour, hKeys.keys), d7: proj(tokDay, k7.keys),
        d30: proj(tokDay, k30.keys), all: proj(tokDay, allKeys) };
    const sp = { h24: proj2(new Map(faHour.buckets.map(b => [b.k, b.spend])), hKeys.keys),
        d7: proj2(spDay, k7.keys), d30: proj2(spDay, k30.keys), all: proj2(spDay, allKeys) };
    const act = { h24: proj(pr.hour, hKeys.keys), d7: proj(pr.day, k7.keys),
        d30: proj(pr.day, k30.keys), all: proj(pr.day, allKeys) };
    const accCurve = { h24: new Array(24).fill(acc.bought + acc.reg),
        d7: accAt(k7.keys), d30: accAt(k30.keys), all: accAt(allKeys) };

    const week = sum(act.d7);
    return {
        nick: id.nick, installId: id.installId, ver: hubBuild().ver, sha: hubBuild().sha,
        stamp: new Date().toISOString(), tzOffsetMin: -new Date().getTimezoneOffset(),
        // Ключи бакетов отдаём ЦЕЛИКОМ, а не подписями для оси: соседей надо
        // совмещать по времени, а не по индексу — у каждой установки своя дата
        // первого дня, и «всё время» у всех разной длины. Подпись клиент сделает сам.
        keys: { h24: hKeys.keys, d7: k7.keys, d30: k30.keys, all: allKeys },
        tok, sp, act, acc: accCurve,
        tot: {
            tokD: sum(tok.h24), tokW: sum(tok.d7), tokM: sum(tok.d30), tokA: sum(tok.all),
            spD: round2(sum(sp.h24)), spW: round2(sum(sp.d7)),
            spM: round2(sum(sp.d30)), spA: round2(sum(sp.all)),
            bal: money.balance, spentAll: money.spent,
            ppd: Math.round(week / 7), promptsAll: pr.total, streak: ccStreak(pr.day),
            bought: acc.bought, reg: acc.reg, keys: money.keys, accDated: acc.dated,
        },
        src: {
            journalFirst: tj.first ? dayKey(tj.first) : null, journalLines: tj.lines,
            statsCacheLast: sc.lastComputed, cutover: cut,
            financeLines: faDay.lines, balanceUnknownKeys: money.unknown,
            cacheTokD: sum(hKeys.keys.map(k => tj.chour.get(k) || 0)),
            cacheTokW: sum(k7.keys.map(k => tj.cday.get(k) || 0)),
            topupW: round2(sum(k7.keys.map(k => topupDay.get(k) || 0))),
            dupTopupW: round2(sum(faDay.buckets.filter(b => k7.keys.includes(b.k)).map(b => b.dupTopup))),
            boughtCreds: acc.boughtCreds, perPool: acc.perPool,
        },
    };
}
// Версия сборки хаба — чтобы в лиге было видно, кто сидит на старой. Считается один
// раз по требованию: `git rev-parse` на старте процесса не нужен никому.
let HUB_BUILD = null;
function hubBuild() {
    if (HUB_BUILD) return HUB_BUILD;
    let ver = null, sha = null;
    try { ver = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || null; } catch (e) {}
    try {
        sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'],
            { cwd: __dirname, encoding: 'utf8', timeout: 3000 }).trim();
    } catch (e) { /* не git-чекаут — сойдёт и без sha */ }
    HUB_BUILD = { ver, sha };
    return HUB_BUILD;
}

// Соседи по лиге. Приёмника пока нет — файл появится, когда поднимем его на Финке;
// до тех тех пор лига честно показывает одну строку и объясняет, чего не хватает.
// Формат файла: { updated: ISO, peers: [ <тот же объект, что отдаёт leagueSelf> ] }
const LEAGUE_PEERS_FILE = path.join(__dirname, 'league-peers.json');
function leaguePeers() {
    try {
        const raw = fs.readFileSync(LEAGUE_PEERS_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const peers = Array.isArray(doc) ? doc : (doc.peers || []);
        return { updated: (doc && doc.updated) || null, peers: peers.filter(p => p && p.installId) };
    } catch { return { updated: null, peers: [] }; }
}

// GET /__switch/api/league — свой срез + соседи (пока пусто) одним ответом.
async function handleLeague(req, res) {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const me = leagueSelf();
        const nb = leaguePeers();
        jsonRes(res, 200, { me, peers: nb.peers, peersUpdated: nb.updated,
            receiver: { configured: false, note: 'приёмник на Финке ещё не поднят' } });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/league/nick { nick } → сохраняет ник рядом с installId.
async function handleLeagueNick(req, res) {
    try {
        const body = await readJsonBody(req);
        const nick = leagueNickClean(body && body.nick);
        if (!nick) return jsonRes(res, 400, { error: 'ник — от 2 до 20 символов' });
        const cur = hubIdentity();
        const doc = { installId: cur.installId, nick, joined: cur.joined || new Date().toISOString() };
        fs.writeFileSync(HUB_IDENTITY_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        logLine(`league nick → ${nick}`);
        jsonRes(res, 200, { ok: true, nick, installId: doc.installId });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}
async function handleFinanceHistory(req, res) {
    try {
        // CORS нужен только пока вкладку смотрят из черновика по file:// — внутри
        // дашборда origin тот же. Отдаём агрегат, ключей и почты здесь нет.
        res.setHeader('Access-Control-Allow-Origin', '*');
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const range = q.get('range') || 'week';
        const conf = { day: { n: 24, hour: true }, week: { n: 7 }, month: { n: 30 } }[range]
            || { n: 7 };
        // Сетка бакетов и денежные дельты — общей функцией: правила знака, сброса
        // счётчика и дедупа наливки живут в одном месте, тем же считает «Лига».
        const { keys } = timeKeys(conf.n, !!conf.hour);
        const fa = financeAggregate(keys, !!conf.hour);
        const buckets = fa.buckets, idx = fa.idx;
        const parsed = fa.used, skipped = fa.bad, histLines = fa.lines;
        const keyOfTs = ts => { const d = new Date(ts); return isNaN(d.getTime()) ? null : bucketKey(d, !!conf.hour); };
        // Настоящие токены из журнала front-door. Читается тем же способом, что
        // finance-history: построчно, битые строки молча мимо. Файла может не быть
        // вовсе (front-door старой сборки) — тогда бакеты остаются с нулями, и
        // вкладка сама падает на прежнюю оценку по расходу.
        const tokens = { file: path.basename(TOKEN_USAGE_FILE), lines: 0, used: 0, bad: 0,
            harness: {}, model: {}, in: 0, out: 0, cr: 0, cw: 0, cost: 0, req: 0 };
        try {
            const tl = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8').split('\n');
            for (const ln of tl) {
                if (!ln) continue;
                tokens.lines++;
                let e; try { e = JSON.parse(ln); } catch (_) { tokens.bad++; continue; }
                const tk = keyOfTs(e.t);
                const i = tk == null ? null : idx.get(tk);
                if (i == null) continue;
                tokens.used++;
                const b = buckets[i];
                b.tin += Number(e.in) || 0;   b.tout += Number(e.out) || 0;
                b.tcr += Number(e.cr) || 0;   b.tcw += Number(e.cw) || 0;
                b.tcost += Number(e.cost) || 0; b.treq++;
                tokens.in += Number(e.in) || 0;   tokens.out += Number(e.out) || 0;
                tokens.cr += Number(e.cr) || 0;   tokens.cw += Number(e.cw) || 0;
                tokens.cost += Number(e.cost) || 0; tokens.req++;
                // Разрез по харнессу и модели: у владельца одновременно Claude Code,
                // opencode и разовые скрипты, и «кто сжёг» — половина вопроса.
                if (e.h) tokens.harness[e.h] = (tokens.harness[e.h] || 0) + ((Number(e.in) || 0) + (Number(e.out) || 0));
                if (e.m) tokens.model[e.m] = (tokens.model[e.m] || 0) + ((Number(e.in) || 0) + (Number(e.out) || 0));
            }
        } catch (e) { /* журнала ещё нет — не ошибка */ }
        // Текущие суммы по пулам — из тех же файлов, что читает сайдбар.
        const pools = {};
        const sum = (arr, f) => (arr || []).reduce((a, s) => a + (Number(s[f]) || 0), 0);
        const usable = arr => (arr || []).filter(s => s.status !== 'dead' && s.status !== 'no_key');
        try { const a = arLoad(); pools.agentrouter = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        try { const a = goLoad(); pools.gorouter    = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        try { const a = tbLoad(); pools.tabitoken   = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        try { const a = xpLoad(); pools.xpeach      = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        try { const a = jwLoad(); pools.justwoker   = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        try { const a = skLoad(); pools.seekai      = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        try { const a = tsLoad(); pools.truesota    = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        try { const a = kkLoad(); pools.kktoken     = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        try { const a = hnLoad(); pools.hcnsec      = { spent: sum(a, 'spent'), balance: sum(usable(a), 'balance'), keys: a.length }; } catch (e) {}
        const totals = Object.values(pools).reduce((a, p) => ({
            spent: a.spent + p.spent, balance: a.balance + p.balance, keys: a.keys + p.keys,
        }), { spent: 0, balance: 0, keys: 0 });
        jsonRes(res, 200, {
            range, hour: !!conf.hour, buckets, pools, totals, tokens,
            history: { file: path.basename(FINANCE_HISTORY_FILE), lines: histLines, used: parsed, bad: skipped },
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

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
function arBalanceOnce(apiKey, force = false, selfSnapshot = null) {
    const running = AR_BALANCE_INFLIGHT.get(apiKey);
    // Форсированный чек НЕ подхватывает уже летящий мягкий: тот мог вернуть цифру из
    // кеша, а пользователь кликнул именно затем, чтобы увидеть свежую.
    // Со снимком из браузера не подхватываем ВООБЩЕ: летящий чек считает по старому
    // пути, а у нас на руках цифра свежее любой его.
    if (running && !selfSnapshot && (!force || running.force)) return running.p;
    const p = (async () => {
        const target = arLoad().find(s => s.api_key === apiKey);
        const bal = await arBalance(target || { api_key: apiKey }, { force, selfSnapshot });
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

// Гвард для nudge-режима остальных провайдеров (GoRouter/Tabi/XPeach/JustWoker):
// один пересчёт на ключ в полёте. У AgentRouter своя, более полная машинерия выше
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
function handleKkMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'kktoken', host: 'kktoken.cc', load: kkLoad, save: kkSave });
}
function handleTbMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'tabi', host: 'tabitoken.com', load: tbLoad, save: tbSave });
}
function handleXpMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'xpeach', host: 'xpeach.codes', load: xpLoad, save: xpSave });
}
function handleJwMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'justwoker', host: 'api.justwoker.icu', load: jwLoad, save: jwSave });
}
function handleSkMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'seekai', host: 'seekai.cc', load: skLoad, save: skSave });
}
// hcnsec: сопоставление идёт ПЕРВЫМ путём общего обработчика — по API-ключу, вычитанному
// из панели куками профиля. GitHub-логин там только резерв, и его отсутствие у этого шлюза
// (github_oauth=false) сопоставление не ломает: профиль и ключ есть, а больше ничего не нужно.
function handleHnMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'hcnsec', host: 'api.hcnsec.cn', load: hnLoad, save: hnSave });
}
// Сопоставление профилей идёт по GitHub-логину из кук профиля, а не по панели —
// поэтому общий обработчик годится и для sub2api.
function handleTsMapProfiles(req, res) {
    return newapiMapProfiles(req, res, { tag: 'truesota', host: 'true-sota.com', load: tsLoad, save: tsSave });
}

// POST /__switch/api/{ar,go,tb,xp}/set-github { api_key, ghId } → привязать/сменить/отвязать
// GitHub-аккаунт (метка-организация, никакой автоматики). ghId может быть:
//   'personal' — личный GitHub владельца (вне хранилища github-accounts.json);
//   'gh_<…>'   — id из хранилища (валидируем по ghLoad());
//   null/''    — снять метку.
//
// Метка не декоративная: `ghPoolMatch` сверяет занятость и по ней, поэтому плашки
// «где уже используется» на вкладке GitHub загораются по всем четырём шлюзам. До
// 22.08 ручка была только у AgentRouter, и на go/tb/xp занятость определялась лишь
// совпадением ника с email/name записи — то есть у аккаунтов, названных иначе, не
// определялась вовсе.
// Ищем запись по `id`, но принимаем и `api_key`: кнопка 🐙 в таблицах шлюзов исторически
// передаёт ключ, а модалка «Где занят» на карточке GitHub знает только id записи (ключа
// у записи без ключа вообще нет — там заглушка `no-key-…`).
//
// `ghId: null` именно УДАЛЯЕТ поле, а не пишет null: `ghPoolMatch` проверяет `s.ghId`
// на истинность, но в JSON пустое поле — мусор, который потом читается как «привязка была».
async function newapiSetGithub(req, res, { tag, load, save }) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const key = String(body.api_key || '').trim();
        if (!id && !key) return jsonRes(res, 400, { error: 'нужен id записи или api_key' });
        const ghId = (body.ghId === null || body.ghId === undefined || body.ghId === '') ? null : String(body.ghId).trim();
        const sessions = load();
        const target = sessions.find(s => (id && s.id === id) || (key && s.api_key === key));
        if (!target) return jsonRes(res, 404, { error: 'запись не найдена' });
        if (ghId && ghId !== 'personal') {
            const exists = ghLoad().some(g => g.id === ghId);
            if (!exists) return jsonRes(res, 400, { error: 'gh-аккаунт не найден в хранилище' });
        }
        if (ghId === null) delete target.ghId; else target.ghId = ghId;
        save(sessions);
        logLine(`${tag} set-github: ${target.name || target.email || target.id} → ${ghId === null ? 'отвязан' : ghId === 'personal' ? 'личный' : 'gh:' + ghId}`);
        jsonRes(res, 200, { ok: true, ghId: target.ghId || null, usage: ghUsageMap() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleArSetGithub(req, res) {
    return newapiSetGithub(req, res, { tag: 'agentrouter', load: arLoad, save: arSave });
}
function handleGoSetGithub(req, res) {
    return newapiSetGithub(req, res, { tag: 'gorouter', load: goLoad, save: goSave });
}
function handleKkSetGithub(req, res) {
    return newapiSetGithub(req, res, { tag: 'kktoken', load: kkLoad, save: kkSave });
}
function handleTbSetGithub(req, res) {
    return newapiSetGithub(req, res, { tag: 'tabi', load: tbLoad, save: tbSave });
}
function handleXpSetGithub(req, res) {
    return newapiSetGithub(req, res, { tag: 'xpeach', load: xpLoad, save: xpSave });
}
function handleJwSetGithub(req, res) {
    return newapiSetGithub(req, res, { tag: 'justwoker', load: jwLoad, save: jwSave });
}
function handleSkSetGithub(req, res) {
    return newapiSetGithub(req, res, { tag: 'seekai', load: skLoad, save: skSave });
}
function handleTsSetGithub(req, res) {
    return newapiSetGithub(req, res, { tag: 'truesota', load: tsLoad, save: tsSave });
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

// ───── Автоподарок: состояние прогона для фронта ──────────────────────────
// POST отвечает сразу после спавна, а работа идёт 20–60 с (разлогин, GitHub-вход в
// попапе, закрытие браузера, точный баланс). Очередей и SSE в проекте нет — прогресс
// везде поллится, поэтому просто держим состояние в памяти процесса, как arLkPids.
const AR_AUTO_CHECKIN = new Map(); // label → { id, name, state, message, checkedIn, balance, checkinAt, checkinFrom, startedAt, finishedAt }
const AR_AUTO_CHECKIN_TTL_MS = 10 * 60 * 1000;
// Что означает код возврата agentrouter/open-session.js (см. его заголовок).
const AR_AUTO_CHECKIN_FAIL = {
    2: 'вход не подтвердился за 90 с — бонус не забран, попробуй ещё раз или добери кнопкой 🎁',
    3: 'GitHub-сессия аккаунта мертва: пароль и 2FA автоматика не вводит — возьми 🐙 «готовый GitHub» заново',
    4: 'шлюз переделал страницу входа: кнопку GitHub найти не удалось — добери бонус кнопкой 🎁',
    5: 'шлюз отверг OAuth (код/state) — бонус не забран',
};
// Ручной режим ждёт человека 10 минут, а не 90 с — текст про таймаут другой.
const AR_CHECKIN_FAIL_MANUAL = {
    2: 'вход в окне так и не случился (10 мин) — бонус не забран, открой ещё раз',
};

// Разбираем маркер, который скрипт печатает последней строкой: AUTOCHECKIN_RESULT {...}.
// `checkedIn` — слово САМОГО шлюза (data.checked_in в ответе /api/oauth/github), это
// честнее, чем ловить рост выдачи между двумя чеками.
function arParseAutoCheckinMarker(out) {
    const m = /AUTOCHECKIN_RESULT\s+(\{[^\n]*\})/.exec(String(out || ''));
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

// Хвост чек-ина: браузер закрылся → ставим точный баланс и отметку 🎁/📦. Цифру берём
// ИЗ СНИМКА, снятого в самом браузере (marker.self) — тогда к шлюзу за ней идти не надо
// и ждать флаша кук на диск тоже незачем. Снимка нет (не удалось перехватить) — старый
// путь: пауза на флаш + чтение куки профиля + запрос self.
// Исключения гасим здесь же: это обработчик 'exit', падение в нём уронило бы дашборд.
async function arAutoCheckinFinish(id, label, code, marker, auto = true) {
    const st = AR_AUTO_CHECKIN.get(label) || { id, label };
    st.finishedAt = new Date().toISOString();
    const tag = auto ? 'автоподарок' : 'чек-ин';
    try {
        if (code !== 0) {
            st.state = 'error';
            st.message = (auto ? AR_AUTO_CHECKIN_FAIL[code] : AR_CHECKIN_FAIL_MANUAL[code])
                || AR_AUTO_CHECKIN_FAIL[code] || `скрипт завершился с кодом ${code}`;
            logLine(`agentrouter ${tag} [${label}]: ${st.message}`);
            return;
        }
        // Снимок годен только с положительной квотой: обнулённый ответ шлюза записал бы
        // в пул $0 (см. ловушку в newapiBalance, ветвь 2а).
        const snap = marker && marker.self && Number(marker.self.quota) > 0 ? marker.self : null;
        // Chromium флашит куки в SQLite на закрытии, но запись в файл асинхронна: без
        // паузы точный баланс читал бы профиль на полсекунды раньше времени. Со снимком
        // читать нечего — паузу не платим.
        if (!snap) await new Promise(r => setTimeout(r, 2000));
        const sessions = arLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) { st.state = 'error'; st.message = 'аккаунт исчез из пула'; return; }

        // Отметку ставим по слову шлюза. checkedIn === false → бонуса не было (окно не
        // сменилось) — врать «забрано» нельзя. null (маркер не поймали или ручной режим)
        // → оставляем как есть: детект по росту выдачи в arApplyBalance мог поставить её сам.
        // Считаем ДО чека баланса: от этого зависит, годна ли сохранённая точная цифра.
        const checkedIn = marker && typeof marker.checkedIn === 'boolean' ? marker.checkedIn : null;

        // Визит в ЛК обесценивает сохранённую цифру только если там могли НАЛИТЬ: чек-ин
        // поднимает `quota`, не двигая `used_quota`, поэтому «расход не сдвинулся» перестаёт
        // означать «остаток тот же». Но шлюз сам сказал, наливал ли он: `checked_in: false`
        // → не наливал → сохранённая цифра по-прежнему верна, и обнулять её нечем.
        if (checkedIn !== false) newapiLkVisited(label);
        // force НЕ ставим намеренно. Он запрещает переиспользовать сохранённую точную цифру
        // и гонит запрос к шлюзу — а тот за Aliyun WAF отвечает заглушкой и взводит
        // `coolDownHost`, то есть один неудачный клик 🎁 ронял точный баланс ВСЕМУ пулу на
        // 10 минут. Свежесть здесь обеспечена без него: либо снимком из браузера, либо тем,
        // что расход не сдвинулся (ветвь 4а в newapiBalance). Форсировать имеет смысл только
        // по явному клику пользователя по цифре — там он и остался.
        const bal = await arBalanceOnce(target.api_key, false, snap).catch(e => ({ error: e.message }));

        if (checkedIn === true) {
            const fresh = arLoad();
            const t2 = fresh.find(s => s.id === id);
            if (t2) {
                t2.checkinAt = new Date().toISOString();
                t2.checkinFrom = 'auto';
                arSaveMerge(t2);
            }
        }
        st.state = 'done';
        st.checkedIn = checkedIn;
        st.balance = bal && typeof bal.balance === 'number' ? bal.balance : null;
        st.balanceFrom = (bal && bal.self && bal.self.fromBrowser) || null;
        const after = arLoad().find(s => s.id === id) || {};
        st.checkinAt = after.checkinAt || null;
        st.checkinFrom = after.checkinFrom || null;
        const where = st.balanceFrom ? ' (снято в браузере, без запроса к шлюзу)' : '';
        st.message = checkedIn === true ? `чек-ин отмечен, на счету $${(st.balance ?? 0).toFixed(2)}${where}`
            : checkedIn === false ? 'вошёл, но чек-ин не зачтён — суточное окно ещё не сменилось'
            : `вошёл, на счету $${(st.balance ?? 0).toFixed(2)}${where}`;
        logLine(`agentrouter ${tag} [${label}]: ${st.message}`);
    } catch (e) {
        st.state = 'error';
        st.message = e.message;
        logLine(`agentrouter ${tag} [${label}] ERR: ${e.message}`);
    } finally {
        AR_AUTO_CHECKIN.set(label, st);
    }
}

// GET /__switch/api/ar/checkin-status → прогоны чек-ина моложе 10 минут.
// Идущие прогоны по TTL НЕ выбрасываем: ручной режим ждёт человека до 10 минут, и
// запись успела бы исчезнуть прямо под наблюдателем.
function handleArCheckinStatus(req, res) {
    const now = Date.now();
    const runs = [];
    for (const [label, st] of AR_AUTO_CHECKIN) {
        const born = Date.parse(st.finishedAt || st.startedAt || 0) || 0;
        if (st.state !== 'running' && born && now - born > AR_AUTO_CHECKIN_TTL_MS) { AR_AUTO_CHECKIN.delete(label); continue; }
        runs.push({ label, ...st });
    }
    jsonRes(res, 200, { runs });
}
// ───── Очередь чек-инов: залп по кнопкам превращаем в конвейер ─────────────
// Владелец жмёт ⚡ на нескольких аккаунтах подряд — и раньше это был залп: три окна
// сразу, отказ 429 на четвёртом, а шлюз ловил нас на частоте и на минуты выключал
// точный баланс ВСЕМУ пулу. Теперь клики не отбиваются, а встают в очередь: один
// прогон за раз плюс пауза между стартами. Кнопка отвечает «в очереди, позиция N»,
// наблюдатель на фронте ждёт своей очереди как обычного прогона.
const AR_CHECKIN_QUEUE = [];
const AR_CHECKIN_GAP_MS = 25_000;   // пауза между прогонами: залп ловит рейт-лимит
let arCheckinLastStart = 0;
let arCheckinPumpTimer = null;

// Занято, если жив ХОТЬ ОДИН браузер ЛК: чек-ин по природе последовательный (зашёл,
// вошёл, забрал, закрылось), а обычный визит 🌐 тоже держит профиль и грузит шлюз.
function arCheckinBusy() {
    return [...arLkPids.values()].some(pid => arPidAlive(pid));
}

// Сколько ещё ждать до старта следующего: либо пока закроется текущее окно, либо
// остаток паузы после прошлого старта.
function arCheckinWaitMs() {
    if (arCheckinBusy()) return AR_CHECKIN_GAP_MS;
    const since = Date.now() - arCheckinLastStart;
    return since >= AR_CHECKIN_GAP_MS ? 0 : AR_CHECKIN_GAP_MS - since;
}

function arCheckinPump() {
    if (arCheckinPumpTimer) { clearTimeout(arCheckinPumpTimer); arCheckinPumpTimer = null; }
    if (!AR_CHECKIN_QUEUE.length) return;
    const wait = arCheckinWaitMs();
    if (wait > 0) {
        // Обновляем подписи в статусе, чтобы в тосте было видно, сколько ждать.
        AR_CHECKIN_QUEUE.forEach((job, i) => {
            const st = AR_AUTO_CHECKIN.get(job.label);
            if (st && st.state === 'queued') {
                st.position = i + 1;
                st.message = `в очереди ${i + 1}/${AR_CHECKIN_QUEUE.length} — старт примерно через ${Math.ceil((wait + i * AR_CHECKIN_GAP_MS) / 1000)}с`;
                AR_AUTO_CHECKIN.set(job.label, st);
            }
        });
        arCheckinPumpTimer = setTimeout(arCheckinPump, Math.min(wait, 5000));
        if (arCheckinPumpTimer.unref) arCheckinPumpTimer.unref();
        return;
    }
    const job = AR_CHECKIN_QUEUE.shift();
    logLine(`agentrouter чек-ин: беру из очереди ${job.dispName} (осталось ${AR_CHECKIN_QUEUE.length})`);
    try { arSpawnSession(job); } catch (e) {
        AR_AUTO_CHECKIN.set(job.label, { ...job, state: 'error', message: `запуск не удался: ${e.message}`, finishedAt: new Date().toISOString() });
        logLine(`agentrouter чек-ин: запуск ${job.dispName} не удался — ${e.message}`);
    }
    if (AR_CHECKIN_QUEUE.length) arCheckinPump();
}

// Спавн окна ЛК/чек-ина. Одна функция на прямой путь (🌐) и на очередь (🎁/⚡) —
// раньше это был кусок внутри обработчика, и очередь потребовала бы его копии.
function arSpawnSession({ id, label, dispName, mode, wantCheckin, wantAuto }) {
    const script = path.join(__dirname, '..', 'agentrouter', 'open-session.js');
    const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
    // Чек-ину stdout нужен не только для логов: в последней строке приезжает маркер
    // AUTOCHECKIN_RESULT — слово шлюза про суточный бонус и СНИМОК точного баланса,
    // снятый в самом браузере. Ловим его в ОБОИХ режимах чек-ина.
    let outTail = '';
    proc.stdout.on('data', d => {
        const s = String(d);
        if (wantCheckin) outTail = (outTail + s).slice(-4000);
        logLine(`agentrouter session/open [${label}]: ${s.trim()}`);
    });
    proc.stderr.on('data', d => logLine(`agentrouter session/open ERR [${label}]: ${String(d).trim()}`));
    proc.on('error', e => logLine(`agentrouter session/open spawn error: ${e.message}`));
    proc.on('exit', (code, sig) => {
        arLkPids.delete(label);
        logLine(`agentrouter session/open: ${label} — exited (code ${code}, sig ${sig})`);
        if (wantCheckin) arAutoCheckinFinish(id, label, code, arParseAutoCheckinMarker(outTail), wantAuto);
        // Обычный визит в ЛК (🌐): замок с куки снят, точный баланс стал читаемым.
        // Режимы чек-ина сюда не входят — у них свой хвост со снимком из браузера,
        // и второй чек тут же погнал бы к шлюзу лишний запрос за Aliyun WAF.
        else newapiRecheckAfterLk('ar', id);
        // Окно закрылось — можно брать следующего из очереди (с паузой, см. arCheckinWaitMs).
        arCheckinLastStart = Date.now();
        arCheckinPump();
    });
    proc.unref();
    arLkPids.set(label, proc.pid);
    arCheckinLastStart = Date.now();
    if (wantCheckin) {
        AR_AUTO_CHECKIN.set(label, {
            id, label, name: dispName, state: 'running',
            message: wantAuto ? 'разлогин и вход через GitHub…' : 'браузер открыт: жду входа через GitHub…',
            startedAt: new Date().toISOString(), finishedAt: null,
        });
    }
    return proc;
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
        // сам, встанет на странице входа и закроется после входа), ⚡ «автоподарок» —
        // autocheckin (там же скрипт сам жмёт вход через GitHub). Остальное — по ключу.
        const wantAuto = String(body.mode || '') === 'autocheckin' && isRealKey(target.api_key);
        const wantCheckin = wantAuto || (String(body.mode || '') === 'checkin' && isRealKey(target.api_key));
        // Предохранитель от залпа. Пользователь нажал 🎁 на всех 11 аккаунтах разом:
        // одиннадцать браузеров плюс одиннадцать чеков баланса — и Aliyun WAF у
        // agentrouter включил защиту, из-за чего ТОЧНЫЙ баланс всего пула на 10 минут
        // выродился в прикидку (см. coolDownHost в newapi-account.js). Чек-ин по своей
        // природе последовательный: зашёл, вошёл, забрал, закрылось.
        // Залп по кнопкам больше не отбивается 429-м, а встаёт в очередь (см. arCheckinPump).
        if (wantCheckin) {
            const runMode = wantAuto ? 'autocheckin' : 'checkin';
            const job = { id, label, dispName, mode: runMode, wantCheckin: true, wantAuto };
            const wait = arCheckinWaitMs();
            if (wait > 0 || AR_CHECKIN_QUEUE.length) {
                AR_CHECKIN_QUEUE.push(job);
                const pos = AR_CHECKIN_QUEUE.length;
                const etaSec = Math.ceil((wait + (pos - 1) * AR_CHECKIN_GAP_MS) / 1000);
                AR_AUTO_CHECKIN.set(label, {
                    id, label, name: dispName, state: 'queued', position: pos,
                    message: `в очереди ${pos} — старт примерно через ${etaSec}с`,
                    startedAt: new Date().toISOString(), finishedAt: null,
                });
                logLine(`agentrouter чек-ин: ${dispName} в очередь (позиция ${pos}, старт через ~${etaSec}с)`);
                arCheckinPump();
                return jsonRes(res, 200, { ok: true, label, queued: true, position: pos, etaSec, mode: runMode });
            }
            newapiLkVisited(label);
            const proc = arSpawnSession(job);
            logLine(`agentrouter session/open: ${dispName} label=${label} mode=${runMode} (pid ${proc.pid})`);
            return jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode: runMode });
        }
        // Перед запуском отдаём профилю ротированные куки: иначе браузер пойдёт со
        // значением, которое наш чек баланса уже погасил, и разлогинится.
        // Для чек-ина — пропускаем: заливать куки, которые ветка checkin тут же
        // удалит, бессмысленно.
        // Обычный визит в ЛК (🌐) или регистрация: ротированные куки — в профиль, иначе
        // браузер пойдёт со значением, которое наш чек баланса уже погасил, и разлогинится.
        newapiSyncProfile('agentrouter.org', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию по рефке; есть — сразу на баланс/пополнение.
        const mode = isRealKey(target.api_key) ? 'console' : 'register';
        const proc = arSpawnSession({ id, label, dispName, mode, wantCheckin: false, wantAuto: false });
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
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        // Вместо ключа — уникальная заглушка, дубли проверяем только у настоящих ключей.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = arLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'ar_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        const link = ghLinkForNew(body, mail, nick);
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
            ...(link.ghId ? { ghId: link.ghId } : {}),
        });
        arSave(sessions);
        logLine(`agentrouter add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`
            + (link.how ? ` · ${link.how}` : ''));
        jsonRes(res, 200, { ok: true, id, noKey, ghId: link.ghId || null });
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
    // Правило суффикса — одно на весь файл (см. normalizeCcModel), здесь только
    // делегируем: раньше была копия regex, и glm-5.3 кликом вкладки лишался [1m].
    return normalizeCcModel(model);
}

// Поднимаем ОБА прокси независимо от модели: keepalive (:20133) стоит спереди, а
// конвертер (:20132) нужен не только для gpt-основной модели — по ar-modelmap.json
// туда же уходят haiku-вызовы сабагентов (дефолт haiku → gpt-5.6-sol), т.е. он
// требуется даже когда основная модель claude-*. Спавн идемпотентен: занятый порт → no-op.
async function arSpawnBoth() {
    const ka = await keepaliveBring(AR_KEEPALIVE_PORT, { waitMs: 8000 });
    if (!ka.ok) logLine(`agentrouter activate: keepalive :${AR_KEEPALIVE_PORT} НЕ поднялся — ${ka.error || '?'}`);
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
        watchChildExit(child, 'keepalive GoRouter', GO_KEEPALIVE_PORT);
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

function goApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { provider: 'gorouter' }); }

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
        proc.on('exit', (code, sig) => {
            goLkPids.delete(label);
            logLine(`gorouter session/open: ${label} — exited (code ${code}, sig ${sig})`);
            // Замок с куки снят — точный баланс стал читаемым (см. newapiRecheckAfterLk).
            newapiRecheckAfterLk('go', id);
        });
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
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = goLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'go_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        const link = ghLinkForNew(body, mail, nick);
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
            ...(link.ghId ? { ghId: link.ghId } : {}),
        });
        goSave(sessions);
        logLine(`gorouter add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`
            + (link.how ? ` · ${link.how}` : ''));
        jsonRes(res, 200, { ok: true, id, noKey, ghId: link.ghId || null });
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
        // Ждём, что keepalive РЕАЛЬНО ответил. Раньше здесь был голый спавн: он
        // возвращал ok сразу и считал занятый зомби-порт живым прокси, поэтому
        // активация «успешно» завершалась на мёртвом :20156, а Claude Code получал 502
        // на каждый запрос, пока человек не нажмёт «перезапустить» в Health.
        const goKa = await keepaliveBring(GO_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!goKa.ok) logLine(`gorouter activate: keepalive :${GO_KEEPALIVE_PORT} НЕ поднялся — ${goKa.error || '?'}`);
        logLine(`gorouter activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${GO_KEEPALIVE_URL})`);
        jsonRes(res, 200, {
            ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, viaProxy: true,
            keepalive: { up: goKa.ok, port: GO_KEEPALIVE_PORT, error: goKa.ok ? null : (goKa.error || null) },
        });
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
        const goKaM = await keepaliveBring(GO_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!goKaM.ok) logLine(`gorouter set-model: keepalive :${GO_KEEPALIVE_PORT} НЕ поднялся — ${goKaM.error || '?'}`);
        logLine(`gorouter set-model: ${m} (base ${GO_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: GO_ACTIVE_MODEL_FILE, base: GO_KEEPALIVE_URL, needRestart: true, keepalive: { up: goKaM.ok, port: GO_KEEPALIVE_PORT, error: goKaM.ok ? null : (goKaM.error || null) } });
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

// ───── KKtoken — автономная вкладка (New API, GitHub-вход) ────────────────
// Восьмой шлюз, структурная копия вкладки GoRouter: `kktoken.cc` — тот же New API
// (проверено 2026-08-31: `x-oneapi-request-id` на каждом 200, `/api/status` отдаёт
// `system_name: "KKtoken AI"`, `version: v1.0.0-rc.25`, `quota_per_unit: 500000`).
// Апстрим — Amazon Kiro: в `usage` приходит `kiro_credits`, `cost = kiro_credits × 0.02`.
// Свой пул (kktoken-sessions.json), свой активный ключ/модель, свой keepalive :20161.
//
// Каталог токена — РОВНО четыре модели, все Opus: claude-opus-5, claude-opus-5-thinking,
// claude-opus-4-8, claude-opus-4-8-thinking. `claude-sonnet-5` и `gpt-5` отдают 403 в
// шести попытках из шести, их здесь физически нет → тир-карта opus-only во всех трёх
// тирах (kktoken-modelmap.json), пустой тир = «model not supported» без ретрая.
//
// ✅ Наш системный промпт шлюз ИСПОЛНЯЕТ (метка NAIL-7 вернулась, в роли CLI-агента
// зовёт тулзу) — в отличие от SeekAi и TrueSOTA, где промпт агента выбрасывался.
// Тулзы работают полностью: tool_use, round-trip с tool_result, два вызова в одном
// ходу, тулзы в стриме. 🪤 Кроме `tool_choice` — он молча выбрасывается.
// 🪤 `max_tokens` шлюз игнорирует: на 5 приходит 681 токен и `stop_reason: end_turn`.
const KK_SESSIONS_FILE = path.join(__dirname, 'kktoken-sessions.json');
const KK_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'kktoken-active-key.txt');
const KK_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'kktoken-active-model.txt');
const KK_BASE_URL = 'https://kktoken.cc/v1';
// SSE keepalive proxy для kktoken (как у tabi :20155): форвардит напрямую в
// kktoken.cc, режет [1m]-суффиксы и держит SSE-паузы thinking-моделей.
// 🪤 Здесь keepalive нужен не только за паузы: у kktoken КАЖДЫЙ ЧЕТВЁРТЫЙ
// `POST /v1/messages` отдаёт пустой 403 от кромки Cloudflare (замер 31.08: отказы на
// позициях 4/8/12/16/20 из 20, пауза 6 с не помогает, параллельно 2 из 8). Ретрай
// лечит это полностью — 12/12 с четырьмя лишними попытками, — а `shouldRetryStatus`
// в keepalive-proxy.js уже включает 403. Без keepalive каждый четвёртый запрос CC
// умирал бы в лицо.
// UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages к корню (см. keepalive-proxy.js:427).
const KK_UPSTREAM = 'https://kktoken.cc';
const KK_KEEPALIVE_PORT = 20161;
const KK_KEEPALIVE_URL = `http://localhost:${KK_KEEPALIVE_PORT}`;
const KK_MODELMAP_FILE = path.join(__dirname, 'kktoken-modelmap.json');
// Резерв «угадать грант» (см. newapiBalance). У kktoken гранта НЕТ: панель платная,
// бонуса при регистрации не заявлено, деньги вносит владелец. Поэтому резерв просто
// округляет расход вверх до $5 и честно светится бейджем `~` — врать про $70, как
// это делают шлюзы с грантом, здесь нельзя: авторотация предпочла бы такой аккаунт
// живому. Точная цифра приходит из /api/user/self куками профиля.
const KK_GRANT_STEP = 5;
const KK_DEFAULT_GRANT = 5;
const KK_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

const KK_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function kkLoad() {
    try {
        const raw = fs.readFileSync(KK_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        // id-миграция: старые аккаунты жили только по api_key. Присваиваем стабильный id
        // (email может повторяться, ключ может меняться). Дублируем id — не трогаем, первый побеждает.
        let changed = false;
        const seen = new Set();
        arr.forEach((s, i) => {
            if (!s.id || seen.has(s.id)) {
                const base = 'kk_' + Date.now() + '_' + i;
                s.id = base + '_' + Math.random().toString(36).slice(2, 6);
                changed = true;
            }
            seen.add(s.id);
        });
        // Разовый перенос ручных grantManual/bonus/referral в анкер (см. newapiMigrateAnchors).
        if (newapiMigrateAnchors(arr)) changed = true;
        if (changed) {
            try { kkSave(arr); } catch {}
        }
        return arr;
    } catch { return []; }
}
function kkSave(arr) {
    fs.writeFileSync(KK_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function kkReadActiveModel() {
    try { return fs.readFileSync(KK_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function kkReadActiveKey() {
    try { return fs.readFileSync(KK_ACTIVE_KEY_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// SSE keepalive proxy для kktoken: второй экземпляр keepalive-proxy.js на :20161.
// KEY_FILE/MODELMAP_FILE параметризованы env'ом, чтобы не пересекаться с agentrouter
// :20133 и tabi :20155. UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages.
async function kkKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(KK_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(KK_KEEPALIVE_PORT),
                UPSTREAM: KK_UPSTREAM,
                KEY_FILE: KK_ACTIVE_KEY_FILE,
                MODELMAP_FILE: KK_MODELMAP_FILE,
                ...(process.env.KK_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.KK_PRE_COMMIT_MS } : {}),
            },
        });
        watchChildExit(child, 'keepalive KKtoken', KK_KEEPALIVE_PORT);
        child.unref();
        logLine(`kktoken keepalive proxy spawn: :${KK_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`kktoken keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Пинг ключа: GET /v1/models с CC-заголовками → 200 = LIVE, 401/403 = DEAD.
// ✅ Проверено 31.08: пустой 403 kktoken на ЭТОТ путь не приходит — 16/16 отдали 200,
// а битый ключ 8/8 отдал честный 401. То есть живой ключ мёртвым здесь не пометим.
async function kkProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';   // заглушка вместо ключа — пинговать нечего
    try {
        const r = await fetch(`${KK_BASE_URL}/models`, {
            method: 'GET',
            headers: { ...KK_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// Баланс: usage endpoint у kktoken живёт ПОД /v1 (проверено 31.08:
// `GET /v1/dashboard/billing/usage` → `{"total_usage": 181.0114}`, центы), в отличие
// от gorouter, где он на корне. Это только РАСХОД — остатка ключом не отдают вовсе
// (`/api/user/self` с Bearer от sk → 401, `/v1/credits` → 404). Точная цифра — из
// /api/user/self куками профиля; резервы (анкер, угадывание) см. newapiBalance.
async function kkBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'kktoken.cc',
        ccHeaders: KK_CC_HEADERS,
        usageUrl: 'https://kktoken.cc/v1/dashboard/billing/usage',
        subUrl: null,
        guessGrant: spent => Math.max(KK_DEFAULT_GRANT, Math.ceil(spent / KK_GRANT_STEP) * KK_GRANT_STEP),
        force: !!opts.force,
    });
}

function kkApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { provider: 'kktoken' }); }

async function handleKkSessions(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = kkLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await kkProbe(s.api_key); }));
            }
            kkSave(sessions);
        }
        if (balance) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => kkApplyBalance(s, await kkBalance(s))));
            }
            kkSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: kkReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleKkPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await kkProbe(api_key);
        const sessions = kkLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; kkSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleKkBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const recalc = async (force = false) => {
            const sessions = kkLoad();
            const target = sessions.find(s => s.api_key === api_key);
            const bal = await kkBalance(target || { api_key }, { force });
            if (target) { kkApplyBalance(target, bal); kkSave(sessions); }
            return bal;
        };
        // nudge=1: отвечаем мгновенно, считаем в своём процессе. Статусбар живёт ~50мс,
        // его фоновый curl не доживает до ответа медленного billing-эндпоинта.
        if (q.searchParams.get('nudge') === '1') {
            const queued = nudgeBalanceOnce('kk:' + api_key, recalc);
            return jsonRes(res, 200, { ok: true, queued });
        }
        // Клик по цифре — force: кеш мог быть снят до чек-ина на сайте.
        jsonRes(res, 200, await recalc(true));
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleKkSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'kktoken', load: kkLoad, save: kkSave, balanceFn: kkBalance, applyFn: kkApplyBalance });
}

const kkLkPids = new Map();
function kkPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleKkSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = kkLoad();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const target = sessions[idx];
        // Профиль браузера привязываем к СТАБИЛЬНОМУ id аккаунта, а не к name/email:
        // переименование аккаунта не должно рвать привязку к сохранённому профилю.
        const label = 'acct_' + id;

        const prevPid = kkLkPids.get(label);
        if (kkPidAlive(prevPid)) {
            logLine(`kktoken session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'kktoken', 'open-session.js');
        // Ротированные куки — в профиль, иначе браузер стартует с погашенной сессией.
        newapiSyncProfile('kktoken.cc', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию по рефке; есть — сразу на баланс.
        // `mode` из тела перебивает это правило: у безключевой записи, заселённой поверх
        // предупреждения о засвете, аккаунт у провайдера скорее всего УЖЕ есть, и рефка
        // ему не нужна — нужен вход. Регистрация вместо входа там отвечает «аккаунт уже
        // создан», и выглядит это как поломка дашборда (разбор 2026-08-21).
        const wantMode = String(body.mode || '').trim();
        const mode = (wantMode === 'console' || wantMode === 'register') ? wantMode
            : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`kktoken session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`kktoken session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`kktoken session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => {
            kkLkPids.delete(label);
            logLine(`kktoken session/open: ${label} — exited (code ${code}, sig ${sig})`);
            // Замок с куки снят — точный баланс стал читаемым (см. newapiRecheckAfterLk).
            newapiRecheckAfterLk('kk', id);
        });
        proc.unref();
        kkLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            kkLkPids.delete(label);
            logLine(`kktoken session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        newapiLkVisited(label);   // в ЛК могли пополнить/чекнуться — кеш точной цифры снят
        logLine(`kktoken session/open: ${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── KKtoken: share/import (передать аккаунт другу и принять чужой) ────────
// Формат: base64url(JSON { v:1, provider:'kktoken', email, name, api_key,
// meta:{grant,bonus,spent,balance,status,…}, session:{cookies,origins} }).
// «Живая» часть (GitHub + kktoken) — storageState
// из kktoken/profiles/acct_<id>/, снимается headless-скриптом share-session.js.

const KK_SHARE_SCRIPT = path.join(__dirname, '..', 'kktoken', 'share-session.js');
const KK_SESSIONS_DIR = path.join(__dirname, '..', 'kktoken', 'sessions');

function kkB64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function kkB64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// POST /__switch/api/kk/share { id } → снять storageState профиля и собрать строку.
async function handleKkShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = kkLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = kkLkPids.get(label);
        if (kkPidAlive(prevPid)) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        // Гоняем headless-снимок профиля (короткий, до 30 сек).
        const stateFile = path.join(KK_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [KK_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code, sig) => resolve({ code, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`kktoken share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;

        const payload = {
            v: 1,
            provider: 'kktoken',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = kkB64UrlEncode(JSON.stringify(payload));
        logLine(`kktoken share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/kk/import { share } → разобрать строку и добавить аккаунт.
async function handleKkImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(kkB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'kktoken' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не kktoken-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = kkLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'kk_' + Date.now() + '_' + sessions.length;
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
        kkSave(sessions);

        // «Живую» сессию кладём туда, где её подхватит open-session.js при первом открытии.
        try {
            fs.mkdirSync(KK_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(KK_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`kktoken import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`kktoken import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''}${typeof rec.balance === 'number' ? ', balance $' + rec.balance : ''})`);
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

async function handleKkAdd(req, res) {
    try {
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = kkLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'kk_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        const link = ghLinkForNew(body, mail, nick);
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
            ...(link.ghId ? { ghId: link.ghId } : {}),
        });
        kkSave(sessions);
        logLine(`kktoken add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`
            + (link.how ? ` · ${link.how}` : ''));
        jsonRes(res, 200, { ok: true, id, noKey, ghId: link.ghId || null });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сменить/вписать API-ключ у существующего аккаунта (после того, как ключ взят
// в консоли kktoken). Аккаунт остаётся тем же — id и браузерный профиль не трогаем.
async function handleKkSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = kkLoad();
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
            fs.writeFileSync(KK_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        }
        kkSave(sessions);
        logLine(`kktoken set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Переименовать аккаунт (подпись) — меняем name и/или email. id и профиль браузера
// не трогаем, поэтому привязка профиля/сессии сохраняется.
async function handleKkRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = kkLoad();
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
        kkSave(sessions);
        logLine(`kktoken rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleKkDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = kkLoad();
        const target = sessions.find(s => s.id === idKey);
        kkSave(sessions.filter(s => s.id !== idKey));
        if (target && target.api_key === kkReadActiveKey()) {
            try { fs.rmSync(KK_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(KK_ACTIVE_MODEL_FILE, { force: true }); } catch {}
        }
        logLine(`kktoken delete: ${target ? target.email : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация ЧЕРЕЗ keepalive :20161, а не прямым baseUrl: шлюз Anthropic-совместим
// нативно, но каждый четвёртый его ответ — пустой 403, и без ретраев keepalive это
// доехало бы до Claude Code как отказ. `/v1` дописывает сам keepalive.
async function handleKkActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        // Заглушка вместо ключа: активировать нечего (иначе уедет в kktoken-active-key.txt).
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — зарегистрируйся (🌐) и вставь ключ кнопкой 🔑' });
        const sessions = kkLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(KK_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        kkSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-kk');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = KK_KEEPALIVE_URL;   // keepalive :20161 → kktoken.cc напрямую
            delete settings.apiKeyHelper;
            // Модель НЕ удаляем, если есть выбранная: delete = дефолт Claude Code, а он
            // без [1m] → окно 200k. Источник правды — kktoken-active-model.txt (образец —
            // handleArActivate). Суффикс дотянет writeSettings(). Если модель не выбрана,
            // пинить claude-opus-5 нельзя: в каталоге шлюза её может не быть.
            const kkCurModel = kkReadActiveModel() || '';
            if (kkCurModel) settings.model = kkCurModel;
            else { delete settings.model; logLine('kktoken activate: активной модели нет → settings.model снят, Claude Code поедет на 200k'); }
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';   // реальный ключ берёт keepalive из kktoken-active-key.txt
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`kktoken activate: settings.json FAILED: ${e.message}`);
        }
        // Ждём, что keepalive РЕАЛЬНО ответил. Раньше здесь был голый спавн: он
        // возвращал ok сразу и считал занятый зомби-порт живым прокси, поэтому
        // активация «успешно» завершалась на мёртвом :20161, а Claude Code получал 502
        // на каждый запрос, пока человек не нажмёт «перезапустить» в Health.
        const kkKa = await keepaliveBring(KK_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!kkKa.ok) logLine(`kktoken activate: keepalive :${KK_KEEPALIVE_PORT} НЕ поднялся — ${kkKa.error || '?'}`);
        logLine(`kktoken activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${KK_KEEPALIVE_URL})`);
        jsonRes(res, 200, {
            ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, viaProxy: true,
            keepalive: { up: kkKa.ok, port: KK_KEEPALIVE_PORT, error: kkKa.ok ? null : (kkKa.error || null) },
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу.
async function handleKkModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (KK_MODELS_CACHE.data && Date.now() - KK_MODELS_CACHE.ts < KK_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: KK_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${KK_BASE_URL}/models`, {
            signal: controller.signal,
            headers: { ...KK_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
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
        KK_MODELS_CACHE.data = models;
        KK_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (KK_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: KK_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

// Сменить активную модель: пишет kktoken-active-model.txt + settings.model (+ env модели).
async function handleKkSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        const settingsModel = /^claude-(opus|sonnet)-/.test(m) && !m.includes('[') ? `${m}[1m]` : m;
        fs.writeFileSync(KK_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-kk-model');
            const mm = (body.modelMap || {});
            settings.model = mm[m] || settingsModel;
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = KK_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`kktoken set-model: settings.json FAILED: ${e.message}`);
        }
        const kkKaM = await keepaliveBring(KK_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!kkKaM.ok) logLine(`kktoken set-model: keepalive :${KK_KEEPALIVE_PORT} НЕ поднялся — ${kkKaM.error || '?'}`);
        logLine(`kktoken set-model: ${m} (base ${KK_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: KK_ACTIVE_MODEL_FILE, base: KK_KEEPALIVE_URL, needRestart: true, keepalive: { up: kkKaM.ok, port: KK_KEEPALIVE_PORT, error: kkKaM.ok ? null : (kkKaM.error || null) } });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Настраиваемый маппинг claude-тиров → kktoken-модели (как в Custom). Живёт в сессиях.
// 🪤 Единственный писатель тир-карты — эта ручка. Файл руками не править.
async function handleKkModelMap(req, res) {
    try {
        const body = await readJsonBody(req);
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
        fs.writeFileSync(KK_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
        logLine(`kktoken modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
        jsonRes(res, 200, { ok: true, modelMap: mm });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function kkReadModelMap() {
    try {
        const raw = fs.readFileSync(KK_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch { return {}; }
}

// ───── HCNsec — автономная вкладка (New API, вход email+пароль) ────────────
// Девятый шлюз, структурная копия вкладки GoRouter: `api.hcnsec.cn` — тот же New API.
// Свой пул (hcnsec-sessions.json), свой активный ключ/модель, свой keepalive :20162.
//
// 🪤 GitHub-входа у шлюза НЕТ, и это единственное, чем копия отличается от эталона.
// Живая проба `GET https://api.hcnsec.cn/api/status`: `github_oauth=false`,
// `oidc_enabled=false`, `linuxdo_oauth=false`, `telegram_oauth=false`,
// `wechat_login=false`; включены только `password_login_enabled`,
// `email_verification`, `register_enabled`. Поэтому у вкладки НЕТ трёх ручек
// GoRouter — `map-profiles`, `set-github`, `add-github`, — а тега `hn` нет в
// GH_POOL_LOADERS/FILES/SAVERS/LABELS и в ghLkPidsByTag: заселять сюда готовую
// GitHub-сессию физически некуда, аккаунт создаётся почтой и паролем. Роутов 19 из 22.
//
// Профиль Chromium и куки при этом ЕСТЬ и обязательны: точный остаток даёт
// `GET /api/user/self` куками профиля (см. newapiBalance), поэтому `api.hcnsec.cn`
// стоит в NEWAPI_PROFILE_DIRS. Профиль резолвится по СТАБИЛЬНОМУ id аккаунта
// (`acct_<id>`, newapiResolveProfile) — сопоставление руками (map-profiles) не нужно.
// Путь авторизации (classic/jwt) newapi-account выбирает по содержимому профиля,
// таблицы хостов там больше нет (с 30.08), дополнять ничего не надо.
//
// 🪤 Гранта у шлюза нет и придумать его нечем: тариф токенный, деньги вносит владелец,
// бонуса при регистрации не заявлено. Поэтому HN_GRANT_STEP/HN_DEFAULT_GRANT НЕ
// существует, а guessGrant возвращает 0 — путь TrueSOTA. Прикидка вида «$70» здесь
// врала бы в пользу пустого аккаунта, и авторотация предпочла бы его живому.
//
// 🪤 Реф-кода у шлюза тоже нет: регистрации через нашу ссылку не было, и `hcnsec` в
// routing/lib/ref-codes.js не заводится — выдуманный код = молча потерянный реф.
const HN_SESSIONS_FILE = path.join(__dirname, 'hcnsec-sessions.json');
const HN_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'hcnsec-active-key.txt');
const HN_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'hcnsec-active-model.txt');
const HN_BASE_URL = 'https://api.hcnsec.cn/v1';
// SSE keepalive proxy для hcnsec (как у go :20156): форвардит напрямую в
// api.hcnsec.cn, режет [1m]-суффиксы, переписывает модель по тир-карте и держит
// SSE-паузы thinking-моделей.
// 🪤 UPSTREAM строго БЕЗ /v1 — keepalive сам добавляет /v1/messages к корню
// (см. keepalive-proxy.js:427). Проверено живьём: `POST /v1/v1/messages` → 404
// `Invalid URL`, а `POST /messages` БЕЗ префикса отдаёт 200 с HTML. То есть двойной
// /v1 виден сразу, а потеря /v1 даёт не ошибку, а мусор вместо ответа — поэтому
// корень здесь важнее, чем кажется. /v1 нужен ТОЛЬКО листингу моделей (HN_BASE_URL).
const HN_UPSTREAM = 'https://api.hcnsec.cn';
// Порт через env с дефолтом: спавн, Health и кнопка «перезапустить» обязаны читать
// одно значение, иначе подмена порта на время отладки расходится по трём местам.
const HN_KEEPALIVE_PORT = Number(process.env.HN_KEEPALIVE_PORT || 20162);
const HN_KEEPALIVE_URL = `http://localhost:${HN_KEEPALIVE_PORT}`;
const HN_MODELMAP_FILE = path.join(__dirname, 'hcnsec-modelmap.json');
// 🪤 HN_GRANT_STEP / HN_DEFAULT_GRANT здесь НЕТ намеренно (путь TrueSOTA): выдачи у
// шлюза не существует, прикидывать её нечем, а завышенная прикидка увела бы
// авторотацию на пустой аккаунт. Точная цифра приходит из /api/user/self куками
// профиля; вписанный руками баланс (анкер) остаётся вторым резервом.
const HN_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

const HN_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function hnLoad() {
    try {
        const raw = fs.readFileSync(HN_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        // id-миграция: старые аккаунты жили только по api_key. Присваиваем стабильный id
        // (email может повторяться, ключ может меняться). Дублируем id — не трогаем, первый побеждает.
        let changed = false;
        const seen = new Set();
        arr.forEach((s, i) => {
            if (!s.id || seen.has(s.id)) {
                const base = 'hn_' + Date.now() + '_' + i;
                s.id = base + '_' + Math.random().toString(36).slice(2, 6);
                changed = true;
            }
            seen.add(s.id);
        });
        // Разовый перенос ручных grantManual/bonus/referral в анкер (см. newapiMigrateAnchors).
        if (newapiMigrateAnchors(arr)) changed = true;
        if (changed) {
            try { hnSave(arr); } catch {}
        }
        return arr;
    } catch { return []; }
}
function hnSave(arr) {
    fs.writeFileSync(HN_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function hnReadActiveModel() {
    try { return fs.readFileSync(HN_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function hnReadActiveKey() {
    try { return fs.readFileSync(HN_ACTIVE_KEY_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// SSE keepalive proxy для hcnsec: девятый экземпляр keepalive-proxy.js, на :20162.
// KEY_FILE/MODELMAP_FILE параметризованы env'ом, чтобы не пересекаться с остальными
// восемью мостами. UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages.
async function hnKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(HN_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(HN_KEEPALIVE_PORT),
                UPSTREAM: HN_UPSTREAM,
                KEY_FILE: HN_ACTIVE_KEY_FILE,
                MODELMAP_FILE: HN_MODELMAP_FILE,
                ...(process.env.HN_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.HN_PRE_COMMIT_MS } : {}),
            },
        });
        watchChildExit(child, 'keepalive HCNsec', HN_KEEPALIVE_PORT);
        child.unref();
        logLine(`hcnsec keepalive proxy spawn: :${HN_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`hcnsec keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Пинг ключа: GET /v1/models с CC-заголовками → 200 = LIVE, 401/403 = DEAD.
// Листинг ходит С /v1 (HN_BASE_URL) — в отличие от запросов Claude Code, которым
// /v1 дописывает keepalive к корню.
async function hnProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';   // заглушка вместо ключа — пинговать нечего
    try {
        const r = await fetch(`${HN_BASE_URL}/models`, {
            method: 'GET',
            headers: { ...HN_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// Баланс — полный канон GoRouter, включая куки-сессию. usage-эндпоинт на КОРНЕ
// `api.hcnsec.cn` (как у gorouter, НЕ под /v1): он даёт легаси-расход и, главное,
// живость КЛЮЧА — 401/403 здесь означает «ключ мёртв». Точный остаток АККАУНТА
// приходит из `GET /api/user/self` куками профиля Chromium, поэтому `api.hcnsec.cn`
// обязан стоять в NEWAPI_PROFILE_DIRS — без записи self не пойдёт вовсе.
// 🪤 guessGrant = 0: гранта у шлюза нет (см. шапку блока), выдумывать нечего.
async function hnBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'api.hcnsec.cn',
        ccHeaders: HN_CC_HEADERS,
        usageUrl: 'https://api.hcnsec.cn/dashboard/billing/usage',
        subUrl: null,
        guessGrant: () => 0,
        force: !!opts.force,
    });
}

function hnApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { provider: 'hcnsec' }); }

async function handleHnSessions(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = hnLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await hnProbe(s.api_key); }));
            }
            hnSave(sessions);
        }
        if (balance) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => hnApplyBalance(s, await hnBalance(s))));
            }
            hnSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: hnReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleHnPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await hnProbe(api_key);
        const sessions = hnLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; hnSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleHnBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const recalc = async (force = false) => {
            const sessions = hnLoad();
            const target = sessions.find(s => s.api_key === api_key);
            const bal = await hnBalance(target || { api_key }, { force });
            if (target) { hnApplyBalance(target, bal); hnSave(sessions); }
            return bal;
        };
        // nudge=1: отвечаем мгновенно, считаем в своём процессе. Статусбар живёт ~50мс,
        // его фоновый curl не доживает до ответа медленного billing-эндпоинта.
        if (q.searchParams.get('nudge') === '1') {
            const queued = nudgeBalanceOnce('hn:' + api_key, recalc);
            return jsonRes(res, 200, { ok: true, queued });
        }
        // Клик по цифре — force: кеш мог быть снят до чек-ина на сайте.
        jsonRes(res, 200, await recalc(true));
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleHnSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'hcnsec', load: hnLoad, save: hnSave, balanceFn: hnBalance, applyFn: hnApplyBalance });
}

const hnLkPids = new Map();
function hnPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleHnSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = hnLoad();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const target = sessions[idx];
        // Профиль браузера привязываем к СТАБИЛЬНОМУ id аккаунта, а не к name/email:
        // переименование аккаунта не должно рвать привязку к сохранённому профилю.
        const label = 'acct_' + id;

        const prevPid = hnLkPids.get(label);
        if (hnPidAlive(prevPid)) {
            logLine(`hcnsec session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'hcnsec', 'open-session.js');
        // Ротированные куки — в профиль, иначе браузер стартует с погашенной сессией.
        newapiSyncProfile('api.hcnsec.cn', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию (реф-кода у шлюза нет, ссылка прямая);
        // есть — сразу на баланс.
        // `mode` из тела перебивает это правило: у безключевой записи, заселённой поверх
        // предупреждения о засвете, аккаунт у провайдера скорее всего УЖЕ есть, и рефка
        // ему не нужна — нужен вход. Регистрация вместо входа там отвечает «аккаунт уже
        // создан», и выглядит это как поломка дашборда (разбор 2026-08-21).
        const wantMode = String(body.mode || '').trim();
        const mode = (wantMode === 'console' || wantMode === 'register') ? wantMode
            : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`hcnsec session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`hcnsec session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`hcnsec session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => {
            hnLkPids.delete(label);
            logLine(`hcnsec session/open: ${label} — exited (code ${code}, sig ${sig})`);
            // Замок с куки снят — точный баланс стал читаемым (см. newapiRecheckAfterLk).
            newapiRecheckAfterLk('hn', id);
        });
        proc.unref();
        hnLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            hnLkPids.delete(label);
            logLine(`hcnsec session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        newapiLkVisited(label);   // в ЛК могли пополнить/чекнуться — кеш точной цифры снят
        logLine(`hcnsec session/open: ${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── HCNsec: share/import (передать аккаунт другу и принять чужой) ──────────
// Формат: base64url(JSON { v:1, provider:'hcnsec', email, name, api_key,
// meta:{grant,bonus,spent,balance,status,…}, session:{cookies,origins} }).
// «Живая» часть — storageState профиля панели из hcnsec/profiles/acct_<id>/
// (вход email+пароль, GitHub тут не участвует), снимает headless share-session.js.

const HN_SHARE_SCRIPT = path.join(__dirname, '..', 'hcnsec', 'share-session.js');
const HN_SESSIONS_DIR = path.join(__dirname, '..', 'hcnsec', 'sessions');

function hnB64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hnB64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// POST /__switch/api/hn/share { id } → снять storageState профиля и собрать строку.
async function handleHnShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = hnLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = hnLkPids.get(label);
        if (hnPidAlive(prevPid)) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        // Гоняем headless-снимок профиля (короткий, до 30 сек).
        const stateFile = path.join(HN_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [HN_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code, sig) => resolve({ code, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`hcnsec share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;

        const payload = {
            v: 1,
            provider: 'hcnsec',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = hnB64UrlEncode(JSON.stringify(payload));
        logLine(`hcnsec share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/hn/import { share } → разобрать строку и добавить аккаунт.
async function handleHnImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(hnB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'hcnsec' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не hcnsec-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = hnLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'hn_' + Date.now() + '_' + sessions.length;
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
        hnSave(sessions);

        // «Живую» сессию кладём туда, где её подхватит open-session.js при первом открытии.
        try {
            fs.mkdirSync(HN_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(HN_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`hcnsec import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`hcnsec import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''}${typeof rec.balance === 'number' ? ', balance $' + rec.balance : ''})`);
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

async function handleHnAdd(req, res) {
    try {
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = hnLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'hn_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        // 🪤 ghLinkForNew здесь НЕ зовём: GitHub-входа у шлюза нет, тега `hn` нет в
        // GH_POOL_*, и проставленный ghId никто бы не прочитал — только сбивал бы с толку.
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
        });
        hnSave(sessions);
        logLine(`hcnsec add: ${mail} (${noKey ? 'без ключа — регистрация почтой' : '***' + key.slice(-6)})`);
        jsonRes(res, 200, { ok: true, id, noKey });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сменить/вписать API-ключ у существующего аккаунта (после того, как ключ взят
// в консоли hcnsec). Аккаунт остаётся тем же — id и браузерный профиль не трогаем.
async function handleHnSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = hnLoad();
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
            fs.writeFileSync(HN_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        }
        hnSave(sessions);
        logLine(`hcnsec set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Переименовать аккаунт (подпись) — меняем name и/или email. id и профиль браузера
// не трогаем, поэтому привязка профиля/сессии сохраняется.
async function handleHnRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = hnLoad();
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
        hnSave(sessions);
        logLine(`hcnsec rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleHnDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = hnLoad();
        const target = sessions.find(s => s.id === idKey);
        hnSave(sessions.filter(s => s.id !== idKey));
        if (target && target.api_key === hnReadActiveKey()) {
            try { fs.rmSync(HN_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(HN_ACTIVE_MODEL_FILE, { force: true }); } catch {}
        }
        logLine(`hcnsec delete: ${target ? target.email : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация ЧЕРЕЗ keepalive :20162, а не прямым baseUrl (канон go/tb/xp/jw/sk/kk):
// мост срезает суффикс окна [1m], переписывает модель по тир-карте hcnsec-modelmap.json,
// держит SSE-паузы thinking-моделей и ретраит отказы. `/v1` дописывает сам keepalive.
async function handleHnActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        // Заглушка вместо ключа: активировать нечего (иначе уедет в hcnsec-active-key.txt).
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — зарегистрируйся (🌐) и вставь ключ кнопкой 🔑' });
        const sessions = hnLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(HN_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        hnSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-hn');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = HN_KEEPALIVE_URL;   // keepalive :20162 → api.hcnsec.cn напрямую
            delete settings.apiKeyHelper;
            // Модель НЕ удаляем, если есть выбранная: delete = дефолт Claude Code, а он
            // без [1m] → окно 200k. Источник правды — hcnsec-active-model.txt (образец —
            // handleArActivate). Суффикс дотянет writeSettings(). Если модель не выбрана,
            // пинить claude-opus-5 нельзя: в каталоге шлюза её может не быть.
            const hnCurModel = hnReadActiveModel() || '';
            if (hnCurModel) settings.model = hnCurModel;
            else { delete settings.model; logLine('hcnsec activate: активной модели нет → settings.model снят, Claude Code поедет на 200k'); }
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';   // реальный ключ берёт keepalive из hcnsec-active-key.txt
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`hcnsec activate: settings.json FAILED: ${e.message}`);
        }
        // Ждём, что keepalive РЕАЛЬНО ответил. Раньше здесь был голый спавн: он
        // возвращал ok сразу и считал занятый зомби-порт живым прокси, поэтому
        // активация «успешно» завершалась на мёртвом :20162, а Claude Code получал 502
        // на каждый запрос, пока человек не нажмёт «перезапустить» в Health.
        const hnKa = await keepaliveBring(HN_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!hnKa.ok) logLine(`hcnsec activate: keepalive :${HN_KEEPALIVE_PORT} НЕ поднялся — ${hnKa.error || '?'}`);
        logLine(`hcnsec activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${HN_KEEPALIVE_URL})`);
        jsonRes(res, 200, {
            ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, viaProxy: true,
            keepalive: { up: hnKa.ok, port: HN_KEEPALIVE_PORT, error: hnKa.ok ? null : (hnKa.error || null) },
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу.
async function handleHnModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (HN_MODELS_CACHE.data && Date.now() - HN_MODELS_CACHE.ts < HN_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: HN_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${HN_BASE_URL}/models`, {
            signal: controller.signal,
            headers: { ...HN_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
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
        HN_MODELS_CACHE.data = models;
        HN_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (HN_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: HN_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

// Сменить активную модель: пишет hcnsec-active-model.txt + settings.model (+ env модели).
async function handleHnSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        const settingsModel = /^claude-(opus|sonnet)-/.test(m) && !m.includes('[') ? `${m}[1m]` : m;
        fs.writeFileSync(HN_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-hn-model');
            const mm = (body.modelMap || {});
            settings.model = mm[m] || settingsModel;
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = HN_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`hcnsec set-model: settings.json FAILED: ${e.message}`);
        }
        const hnKaM = await keepaliveBring(HN_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!hnKaM.ok) logLine(`hcnsec set-model: keepalive :${HN_KEEPALIVE_PORT} НЕ поднялся — ${hnKaM.error || '?'}`);
        logLine(`hcnsec set-model: ${m} (base ${HN_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: HN_ACTIVE_MODEL_FILE, base: HN_KEEPALIVE_URL, needRestart: true, keepalive: { up: hnKaM.ok, port: HN_KEEPALIVE_PORT, error: hnKaM.ok ? null : (hnKaM.error || null) } });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Настраиваемый маппинг claude-тиров → hcnsec-модели (как в Custom). Живёт в сессиях.
// 🪤 Единственный писатель тир-карты — эта ручка. Файл руками не править.
async function handleHnModelMap(req, res) {
    try {
        const body = await readJsonBody(req);
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
        fs.writeFileSync(HN_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
        logLine(`hcnsec modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
        jsonRes(res, 200, { ok: true, modelMap: mm });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function hnReadModelMap() {
    try {
        const raw = fs.readFileSync(HN_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch { return {}; }
}

// ───── JustWoker — автономная вкладка (NewAPI, GitHub-вход) ─────────────
// Пятый шлюз, структурная копия вкладки GoRouter: `api.justwoker.icu` — тот же
// New API (проверено 2026-08-22: `x-oneapi-request-id`, `<title>New API</title>`,
// `system_name: "JustDoWork"`). Свой пул (justwoker-sessions.json), свой активный
// ключ/модель, свой keepalive :20158.
//
// Активация ЧЕРЕЗ keepalive :20158 (как у go/tb/xp), а не прямым baseUrl: шлюз
// Anthropic-совместим нативно (`POST /v1/messages` → 200, модели помечены
// `supported_endpoint_types: ["anthropic","openai"]`), но thinking-модели дают
// длинные SSE-паузы, и без keepalive watchdog Claude Code рвёт поток.
// 🪤 База для CC — корень БЕЗ /v1: `/v1/v1/messages` отдаёт 404 (замер 22.08).
// `/v1` нужен только листингу моделей — это и есть JW_BASE_URL.
//
// GitHub-вход: justwoker/open-session.js, реф-ссылка `?aff=IFYf` захардкожена там.
// 🪤 Регистрация жёстче остальных четырёх: панель отдаёт
// `github_minimum_account_age_days: 365` — GitHub-аккаунту должен быть год, свежие
// из менеджера сайт отвергнет. Чек-ин у панели включён (`checkin_enabled: true`),
// но он даёт СЛУЧАЙНУЮ сумму, поэтому кнопки «+N» тут нет — только ✏️ и точная
// цифра из `/api/user/self` куками профиля.
const JW_SESSIONS_FILE = path.join(__dirname, 'justwoker-sessions.json');
const JW_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'justwoker-active-key.txt');
const JW_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'justwoker-active-model.txt');
const JW_BASE_URL = 'https://api.justwoker.icu/v1';
// SSE keepalive proxy для justwoker (как у tabi :20155): форвардит напрямую в
// api.justwoker.icu, режет [1m]-суффиксы и держит SSE-паузы thinking-моделей.
// UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages к корню (см. keepalive-proxy.js:427).
const JW_UPSTREAM = 'https://api.justwoker.icu';
const JW_KEEPALIVE_PORT = 20158;
const JW_KEEPALIVE_URL = `http://localhost:${JW_KEEPALIVE_PORT}`;
const JW_MODELMAP_FILE = path.join(__dirname, 'justwoker-modelmap.json');
// Резерв «угадать грант» (см. newapiBalance). Выдача ИЗМЕРЕНА 2026-08-22 на двух
// свежих аккаунтах через `/api/user/self` (Bearer из `/api/user/auth/refresh` в
// контексте страницы — tools/jw-self-probe.js; API-ключ в self не пускает, 401):
//   lankymapping (user 8448): quota 46 346 687 → $92.69, used 0
//   greenpoor    (user 8494): quota 45 619 695 → $91.24, used 0
// Сходится с уже жившими в пуле `exhaustedar` $92.73 и `creamyevoluti` $96.23, то есть
// выдача около $91–96 и слегка разная у каждого аккаунта (у панели она случайная в
// диапазоне, как и суточный бонус).
// 🪤 До этого замера база была $10 — прикидка занижала баланс в девять раз, и свежий
// аккаунт с $92 выглядел почти пустым. Берём НИЖНЮЮ границу измеренного, а не среднее:
// на завышенном балансе авторотация выберет пустой аккаунт, а занижение стоит лишь
// лишнего переключения. Точную цифру всё равно ставит первый заход в 🌐 ЛК
// (balanceSource = 'self') или ✏️ руками.
const JW_GRANT_STEP = 5;
const JW_DEFAULT_GRANT = 90;
const JW_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

const JW_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function jwLoad() {
    try {
        const raw = fs.readFileSync(JW_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        // id-миграция: старые аккаунты жили только по api_key. Присваиваем стабильный id
        // (email может повторяться, ключ может меняться). Дублируем id — не трогаем, первый побеждает.
        let changed = false;
        const seen = new Set();
        arr.forEach((s, i) => {
            if (!s.id || seen.has(s.id)) {
                const base = 'jw_' + Date.now() + '_' + i;
                s.id = base + '_' + Math.random().toString(36).slice(2, 6);
                changed = true;
            }
            seen.add(s.id);
        });
        // Разовый перенос ручных grantManual/bonus/referral в анкер (см. newapiMigrateAnchors).
        if (newapiMigrateAnchors(arr)) changed = true;
        if (changed) {
            try { jwSave(arr); } catch {}
        }
        return arr;
    } catch { return []; }
}
function jwSave(arr) {
    fs.writeFileSync(JW_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function jwReadActiveModel() {
    try { return fs.readFileSync(JW_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function jwReadActiveKey() {
    try { return fs.readFileSync(JW_ACTIVE_KEY_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// SSE keepalive proxy для justwoker: второй экземпляр keepalive-proxy.js на :20158.
// KEY_FILE/MODELMAP_FILE параметризованы env'ом, чтобы не пересекаться с agentrouter
// :20133 и tabi :20155. UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages.
async function jwKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(JW_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(JW_KEEPALIVE_PORT),
                UPSTREAM: JW_UPSTREAM,
                KEY_FILE: JW_ACTIVE_KEY_FILE,
                MODELMAP_FILE: JW_MODELMAP_FILE,
                ...(process.env.JW_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.JW_PRE_COMMIT_MS } : {}),
            },
        });
        watchChildExit(child, 'keepalive JustWoker', JW_KEEPALIVE_PORT);
        child.unref();
        logLine(`justwoker keepalive proxy spawn: :${JW_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`justwoker keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Пинг ключа: GET /v1/models с CC-заголовками → 200 = LIVE, 401/403 = DEAD.
async function jwProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';   // заглушка вместо ключа — пинговать нечего
    try {
        const r = await fetch(`${JW_BASE_URL}/models`, {
            method: 'GET',
            headers: { ...JW_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// Баланс: usage endpoint на КОРНЕ api.justwoker.icu (не /v1). Точный остаток — из
// /api/user/self куками профиля; резервы (анкер, угадывание) см. newapiBalance.
async function jwBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'api.justwoker.icu',
        ccHeaders: JW_CC_HEADERS,
        usageUrl: 'https://api.justwoker.icu/dashboard/billing/usage',
        subUrl: null,
        guessGrant: spent => Math.max(JW_DEFAULT_GRANT, Math.ceil(spent / JW_GRANT_STEP) * JW_GRANT_STEP),
        force: !!opts.force,
    });
}

function jwApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { provider: 'justwoker' }); }

async function handleJwSessions(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = jwLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await jwProbe(s.api_key); }));
            }
            jwSave(sessions);
        }
        if (balance) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => jwApplyBalance(s, await jwBalance(s))));
            }
            jwSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: jwReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleJwPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await jwProbe(api_key);
        const sessions = jwLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; jwSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleJwBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const recalc = async (force = false) => {
            const sessions = jwLoad();
            const target = sessions.find(s => s.api_key === api_key);
            const bal = await jwBalance(target || { api_key }, { force });
            if (target) { jwApplyBalance(target, bal); jwSave(sessions); }
            return bal;
        };
        // nudge=1: отвечаем мгновенно, считаем в своём процессе. Статусбар живёт ~50мс,
        // его фоновый curl не доживает до ответа медленного billing-эндпоинта.
        if (q.searchParams.get('nudge') === '1') {
            const queued = nudgeBalanceOnce('jw:' + api_key, recalc);
            return jsonRes(res, 200, { ok: true, queued });
        }
        // Клик по цифре — force: кеш мог быть снят до чек-ина на сайте.
        jsonRes(res, 200, await recalc(true));
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleJwSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'justwoker', load: jwLoad, save: jwSave, balanceFn: jwBalance, applyFn: jwApplyBalance });
}

// Окно ЛК закрылось → Chromium снял замок с БД куки и дописал в неё свежую сессию.
// Ровно в этот момент точный баланс становится читаемым, поэтому пересчитываем сами,
// один раз и с `force`. Без этого владелец попадал в петлю: жмёт 💰, пока окно открыто,
// получает «в профиле нет куки», по совету открывает ЛК ещё раз — и держит замок дальше
// (разбор 24.08 на `WA justwoker`: в кабинете $604.38, в дашборде вписанные $0.26).
//
// Пауза: запись SQLite на закрытии асинхронна — тот же приём, что в arAutoCheckinFinish.
// `force` обязателен: визит в ЛК уже снял годность сохранённой цифры, а без force
// расчёт вернул бы её же (или анкер), не спросив шлюз.
const LK_RECHECK_DELAY_MS = 2500;
function newapiRecheckAfterLk(gwKey, id) {
    const gw = MONEY_GW[gwKey];
    if (!gw || !id) return;
    setTimeout(async () => {
        try {
            const sessions = gw.load();
            const target = sessions.find(s => s.id === id);
            if (!target || !isRealKey(target.api_key)) return;
            const bal = await gw.balanceFn(target, { force: true });
            gw.applyFn(target, bal);
            gw.save(sessions);
            const where = bal && bal.balanceSource === 'self' ? 'точная цифра шлюза'
                : bal && bal.balanceSource === 'anchor' ? 'вписанное вручную (шлюз молчит)'
                : 'прикидка';
            logLine(`${gw.tag} после закрытия ЛК: ${target.email || target.name || id} → `
                + `$${typeof bal.balance === 'number' ? bal.balance.toFixed(2) : '—'} (${where})`
                + `${bal && bal.selfError ? ` · ${bal.selfError}` : ''}`);
        } catch (e) {
            logLine(`${gw.tag} перечёт после закрытия ЛК не удался: ${e.message}`);
        }
    }, LK_RECHECK_DELAY_MS).unref?.();
}

const jwLkPids = new Map();
function jwPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleJwSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = jwLoad();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const target = sessions[idx];
        // Профиль браузера привязываем к СТАБИЛЬНОМУ id аккаунта, а не к name/email:
        // переименование аккаунта не должно рвать привязку к сохранённому профилю.
        const label = 'acct_' + id;

        const prevPid = jwLkPids.get(label);
        if (jwPidAlive(prevPid)) {
            logLine(`justwoker session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'justwoker', 'open-session.js');
        // Ротированные куки — в профиль, иначе браузер стартует с погашенной сессией.
        newapiSyncProfile('api.justwoker.icu', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию по рефке; есть — сразу на баланс.
        // `mode` из тела перебивает это правило: у безключевой записи, заселённой поверх
        // предупреждения о засвете, аккаунт у провайдера скорее всего УЖЕ есть, и рефка
        // ему не нужна — нужен вход. Регистрация вместо входа там отвечает «аккаунт уже
        // создан», и выглядит это как поломка дашборда (разбор 2026-08-21).
        const wantMode = String(body.mode || '').trim();
        const mode = (wantMode === 'console' || wantMode === 'register') ? wantMode
            : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`justwoker session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`justwoker session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`justwoker session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => {
            jwLkPids.delete(label);
            logLine(`justwoker session/open: ${label} — exited (code ${code}, sig ${sig})`);
            // Замок с куки снят — точный баланс стал читаемым (см. newapiRecheckAfterLk).
            newapiRecheckAfterLk('jw', id);
        });
        proc.unref();
        jwLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            jwLkPids.delete(label);
            logLine(`justwoker session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        newapiLkVisited(label);   // в ЛК могли пополнить/чекнуться — кеш точной цифры снят
        logLine(`justwoker session/open: ${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ───── JustWoker: завести аккаунт БЕЗ человека (⚡ авто-заведение) ──────────
//
// Что было: 🐙 создавала запись и снимок GitHub-сессии, дальше человек жал 🌐, в
// открытом браузере — «Продолжить с GitHub», потом шёл на /keys, копировал ключ и
// вставлял его кнопкой 🔑. Четыре ручных шага на аккаунт.
//
// Что стало: `justwoker/auto-add.js` проходит это сам и отдаёт ключ маркером
// JW_AUTOADD_RESULT. Ключ панель кладёт прямо в ответ OAuth-колбэка (`data.sk`), так
// что страницу /keys открывать не нужно вовсе — сценарий снят рекордером с живого
// прохода 2026-08-22, а не выведен из бандла.
//
// Работает ТОЛЬКО по записи с привязанным `ghId`: снимок GitHub-сессии — это всё, что
// заменяет пароль и 2FA, автоматика их не вводит.
const JW_AUTO_ADD = new Map(); // label → { id, name, state, message, key, userId, inviterId, … }
const JW_AUTO_ADD_TTL_MS = 10 * 60 * 1000;

// Что означает код возврата justwoker/auto-add.js (см. его заголовок).
const JW_AUTO_ADD_FAIL = {
    1: 'скрипт не запустился — смотри лог дашборда',
    2: 'вход не подтвердился за 90 с — аккаунт не заведён, повтори',
    3: 'GitHub-сессия мертва: пароль и 2FA автоматика не вводит — открой аккаунт во вкладке GitHub и залогинься заново',
    4: 'панель переделала страницу входа: кнопку GitHub найти не удалось — сценарий надо переснять рекордером',
    5: 'панель отвергла OAuth — чаще всего возраст GitHub меньше года или закрыта регистрация',
    6: 'вошли, но ключ снять не удалось — открой аккаунт кнопкой 🌐 и возьми ключ вручную',
    7: 'GitHub моложе 365 дней — панель такие не принимает (github_minimum_account_age_days)',
    8: 'панель включила рейт-лимит (429) — смени IP и повтори тем же GitHub, ничего не сломано',
    9: 'панель не ответила на колбэк OAuth — залип IP: смени адрес и жми Повтор, GitHub-согласие и снимок сессии целы',
    10: 'github.com не открылся — навигация оборвалась по сети, вход не начался. Проверь, что GitHub доступен с этой машины (или смени ноду — сменится маршрут), и повтори тем же GitHub, снимок сессии цел',
};

// Коды, которые лечатся сменой IP, а не разбором поломки: рейт-лимит по адресу (8),
// молчание панели на колбэке (9) и оборванная по сети навигация на github.com (10 —
// маршрут до GitHub флапал, другая нода = другой путь). По этому признаку дашборд
// поднимает плашку «смени IP и жми Повтор» вместо обычного красного тоста — иначе
// владелец жмёт ⚡ с того же адреса и жжёт следующий GitHub в тот же отказ.
const JW_AUTO_ADD_IP_CODES = new Set([8, 9, 10]);

function jwParseAutoAddMarker(out) {
    const m = /JW_AUTOADD_RESULT\s+(\{[^\n]*\})/.exec(String(out || ''));
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

// Хвост: скрипт закрылся → вписываем ключ в запись пула. Исключения гасим здесь же —
// это обработчик 'exit', падение в нём уронило бы дашборд.
function jwAutoAddFinish(id, label, code, marker) {
    const st = JW_AUTO_ADD.get(label) || { id, label };
    st.finishedAt = new Date().toISOString();
    st.exitCode = code;
    // id нужен клиенту для кнопки «Повтор»: карточка прогона живёт своей жизнью и строку
    // пула в этот момент могли перерисовать.
    if (!st.id) st.id = id;
    st.needIpChange = JW_AUTO_ADD_IP_CODES.has(code);
    try {
        if (code !== 0 || !marker || !marker.ok || !marker.key) {
            st.state = 'error';
            st.message = JW_AUTO_ADD_FAIL[code] || (marker && !marker.key
                ? 'аккаунт создан, но ключа в ответе не было'
                : `скрипт завершился с кодом ${code}`);
            logLine(`justwoker auto-add [${label}]: ${st.message}`);
            return;
        }
        const sessions = jwLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) { st.state = 'error'; st.message = 'запись пропала из пула'; return; }
        // Дубль ключа — признак того, что заведён НЕ новый аккаунт, а вход в уже
        // существующий. Молча перезаписывать нельзя: в пуле оказались бы две записи с
        // одним ключом, и ротация считала бы их разными деньгами.
        const dup = sessions.find(s => s.id !== id && s.api_key === marker.key);
        if (dup) {
            st.state = 'error';
            st.message = `такой ключ уже есть у записи «${dup.name || dup.email || dup.id}» — это вход в существующий аккаунт, а не новый`;
            logLine(`justwoker auto-add [${label}]: ${st.message}`);
            return;
        }
        target.api_key = marker.key;
        // status снимаем в 'unknown', а не в 'active': выдачу и остаток считает чек
        // баланса, и придумывать за него цифру нельзя (у AgentRouter обнулённая квота
        // из колбэка однажды записала бы в пул $0).
        target.status = 'unknown';
        if (marker.userId) target.jwUserId = marker.userId;
        // Реф-кредит: 0 = панель код проигнорировала. Пишем в запись, иначе потеря
        // кредита не видна нигде — ни в UI, ни при разборе задним числом.
        target.inviterId = marker.inviterId ?? null;
        if (marker.affCode) target.affCode = marker.affCode;
        target.autoAddedAt = new Date().toISOString();
        jwSave(sessions);
        st.state = 'done';
        st.key = marker.key;
        st.userId = marker.userId || null;
        st.inviterId = marker.inviterId ?? null;
        st.message = marker.inviterId
            ? `аккаунт заведён, ключ в пуле (реф-кредит привязан: inviter_id=${marker.inviterId})`
            : `аккаунт заведён, ключ в пуле — но РЕФ-КРЕДИТ НЕ ПРИВЯЗАН (inviter_id=${marker.inviterId}, отправляли aff=${marker.affSent})`;
        logLine(`justwoker auto-add [${label}]: ${st.message}`);
    } catch (e) {
        st.state = 'error';
        st.message = `хвост авто-заведения упал: ${e.message}`;
        logLine(`justwoker auto-add [${label}] ОШИБКА: ${e.message}`);
    } finally {
        JW_AUTO_ADD.set(label, st);
        setTimeout(() => JW_AUTO_ADD.delete(label), JW_AUTO_ADD_TTL_MS).unref?.();
    }
}

// Прогресс прогона построчно — для карточки на вкладке. До этого `state` отдавал только
// начальное и конечное сообщение, и между ними вкладка молчала все 17 секунд прохода:
// снаружи это читается как «лога нет вообще». Сам скрипт болтлив (37 строк), строки уже
// летят в Server Logs — но тот буфер на 200 строк общий, и один прогон вытесняет из него
// всё остальное за минуту.
// 🪤 Запись прогона может ещё НЕ существовать: обработчик stdout встаёт раньше, чем
// JW_AUTO_ADD.set ниже, и первые строки прилетают до него. Поэтому создаём на месте, а
// оба места, где запись перезаписывается целиком, обязаны сохранять `lines`.
const JW_AUTO_ADD_MAX_LINES = 80;
function jwAutoAddPush(label, id, chunk) {
    const st = JW_AUTO_ADD.get(label)
        || { id, label, state: 'running', startedAt: new Date().toISOString(), finishedAt: null };
    if (!Array.isArray(st.lines)) st.lines = [];
    for (const raw of String(chunk).split(/\r?\n/)) {
        const line = raw.trim();
        // Маркер результата машинный, его разбирает jwParseAutoAddMarker — человеку он
        // в карточке не нужен и занял бы всю ширину.
        if (!line || line.startsWith('JW_AUTOADD_RESULT')) continue;
        st.lines.push({ t: new Date().toISOString().slice(11, 19), s: line.slice(0, 300) });
        if (st.state === 'running') st.message = line.slice(0, 300);
    }
    if (st.lines.length > JW_AUTO_ADD_MAX_LINES) st.lines = st.lines.slice(-JW_AUTO_ADD_MAX_LINES);
    JW_AUTO_ADD.set(label, st);
}

// POST /__switch/api/jw/auto-add { id } → завести аккаунт по привязанному GitHub.
async function handleJwAutoAdd(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = jwLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (isRealKey(target.api_key)) {
            return jsonRes(res, 409, { error: 'у записи уже есть ключ — заводить нечего' });
        }
        const ghId = String(target.ghId || '').trim();
        if (!ghId || ghId === 'personal') {
            return jsonRes(res, 400, {
                error: 'к записи не привязан GitHub из хранилища — авто-заведение заменяет пароль и 2FA'
                    + ' именно снимком его сессии. Заведи запись кнопкой 🐙 или привяжи аккаунт кнопкой 🐙 на карточке',
            });
        }
        const acct = ghLoad().find(g => g.id === ghId);
        if (!acct) return jsonRes(res, 400, { error: 'привязанный GitHub-аккаунт не найден в хранилище' });

        const label = 'acct_' + id;
        const prevPid = jwLkPids.get(label);
        if (jwPidAlive(prevPid)) {
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'justwoker', 'auto-add.js');
        const proc = spawn(process.execPath, [script, label, ghId], { detached: true, stdio: 'pipe' });
        let outTail = '';
        proc.stdout.on('data', d => {
            const s = String(d);
            outTail = (outTail + s).slice(-4000);
            logLine(`justwoker auto-add [${label}]: ${s.trim()}`);
            jwAutoAddPush(label, id, s);
        });
        proc.stderr.on('data', d => logLine(`justwoker auto-add ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`justwoker auto-add spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => {
            jwLkPids.delete(label);
            logLine(`justwoker auto-add: ${label} — exited (code ${code}, sig ${sig})`);
            jwAutoAddFinish(id, label, code, jwParseAutoAddMarker(outTail));
        });
        proc.unref();
        jwLkPids.set(label, proc.pid);
        // Мержим, а не пишем целиком: строки stdout уже могли прилететь (обработчик выше
        // встаёт раньше этой строки), и перезапись потеряла бы начало прогона.
        const prevRun = JW_AUTO_ADD.get(label);
        JW_AUTO_ADD.set(label, {
            id, label, name: String(target.name || target.email || label),
            state: 'running', message: (prevRun && prevRun.message) || 'вхожу через GitHub и снимаю ключ…',
            lines: (prevRun && prevRun.lines) || [],
            startedAt: (prevRun && prevRun.startedAt) || new Date().toISOString(), finishedAt: null,
        });
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            jwLkPids.delete(label);
            const cur = JW_AUTO_ADD.get(label) || { id, label };
            cur.state = 'error'; cur.message = failed;
            cur.finishedAt = new Date().toISOString();
            JW_AUTO_ADD.set(label, cur);
            return jsonRes(res, 502, { error: failed });
        }
        logLine(`justwoker auto-add: ${target.name || id} ← GitHub ${acct.nickname || acct.login} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, ghLogin: acct.nickname || acct.login || null });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// GET /__switch/api/jw/auto-add/state → прогресс всех прогонов. Очередей и SSE в
// проекте нет, прогресс везде поллится — держим состояние в памяти, как AR_AUTO_CHECKIN.
function handleJwAutoAddState(req, res) {
    jsonRes(res, 200, { ok: true, runs: [...JW_AUTO_ADD.values()] });
}

// ── JustWoker: share/import (передать аккаунт другу и принять чужой) ────────
// Формат: base64url(JSON { v:1, provider:'justwoker', email, name, api_key,
// meta:{grant,bonus,spent,balance,status,…}, session:{cookies,origins} }).
// «Живая» часть (GitHub + justwoker) — storageState
// из justwoker/profiles/acct_<id>/, снимается headless-скриптом share-session.js.

const JW_SHARE_SCRIPT = path.join(__dirname, '..', 'justwoker', 'share-session.js');
const JW_SESSIONS_DIR = path.join(__dirname, '..', 'justwoker', 'sessions');

function jwB64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwB64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// POST /__switch/api/go/share { id } → снять storageState профиля и собрать строку.
async function handleJwShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = jwLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = jwLkPids.get(label);
        if (jwPidAlive(prevPid)) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        // Гоняем headless-снимок профиля (короткий, до 30 сек).
        const stateFile = path.join(JW_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [JW_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code, sig) => resolve({ code, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`justwoker share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;

        const payload = {
            v: 1,
            provider: 'justwoker',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = jwB64UrlEncode(JSON.stringify(payload));
        logLine(`justwoker share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/go/import { share } → разобрать строку и добавить аккаунт.
async function handleJwImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(jwB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'justwoker' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не justwoker-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = jwLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'jw_' + Date.now() + '_' + sessions.length;
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
        jwSave(sessions);

        // «Живую» сессию кладём туда, где её подхватит open-session.js при первом открытии.
        try {
            fs.mkdirSync(JW_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(JW_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`justwoker import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`justwoker import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''}${typeof rec.balance === 'number' ? ', balance $' + rec.balance : ''})`);
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

async function handleJwAdd(req, res) {
    try {
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = jwLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'jw_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        const link = ghLinkForNew(body, mail, nick);
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
            ...(link.ghId ? { ghId: link.ghId } : {}),
        });
        jwSave(sessions);
        logLine(`justwoker add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`
            + (link.how ? ` · ${link.how}` : ''));
        jsonRes(res, 200, { ok: true, id, noKey, ghId: link.ghId || null });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сменить/вписать API-ключ у существующего аккаунта (после того, как ключ взят
// в консоли justwoker). Аккаунт остаётся тем же — id и браузерный профиль не трогаем.
async function handleJwSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = jwLoad();
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
            fs.writeFileSync(JW_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        }
        jwSave(sessions);
        logLine(`justwoker set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Переименовать аккаунт (подпись) — меняем name и/или email. id и профиль браузера
// не трогаем, поэтому привязка профиля/сессии сохраняется.
async function handleJwRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = jwLoad();
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
        jwSave(sessions);
        logLine(`justwoker rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleJwDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = jwLoad();
        const target = sessions.find(s => s.id === idKey);
        jwSave(sessions.filter(s => s.id !== idKey));
        if (target && target.api_key === jwReadActiveKey()) {
            try { fs.rmSync(JW_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(JW_ACTIVE_MODEL_FILE, { force: true }); } catch {}
        }
        logLine(`justwoker delete: ${target ? target.email : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация ЧЕРЕЗ keepalive :20158 (не прямым baseUrl): в settings.json уезжает
// JW_KEEPALIVE_URL, а реальный ключ прокси подставляет сам из justwoker-active-key.txt.
async function handleJwActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        // Заглушка вместо ключа: активировать нечего (иначе уедет в justwoker-active-key.txt).
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — зарегистрируйся (🌐) и вставь ключ кнопкой 🔑' });
        const sessions = jwLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(JW_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        jwSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-justwoker');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = JW_KEEPALIVE_URL;   // keepalive :20158 → api.justwoker.icu напрямую
            delete settings.apiKeyHelper;
            // Модель НЕ удаляем, если есть выбранная: delete = дефолт Claude Code, а он
            // без [1m] → окно 200k. Источник правды — justwoker-active-model.txt (образец —
            // handleArActivate). Суффикс дотянет writeSettings(). Если модель не выбрана,
            // пинить claude-opus-5 нельзя: в каталоге шлюза её может не быть.
            const jwCurModel = jwReadActiveModel() || '';
            if (jwCurModel) settings.model = jwCurModel;
            else { delete settings.model; logLine('justwoker activate: активной модели нет → settings.model снят, Claude Code поедет на 200k'); }
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';   // реальный ключ берёт keepalive из justwoker-active-key.txt
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`justwoker activate: settings.json FAILED: ${e.message}`);
        }
        // Ждём, что keepalive РЕАЛЬНО ответил. Раньше здесь был голый спавн: он
        // возвращал ok сразу и считал занятый зомби-порт живым прокси, поэтому
        // активация «успешно» завершалась на мёртвом :20158, а Claude Code получал 502
        // на каждый запрос, пока человек не нажмёт «перезапустить» в Health.
        const jwKa = await keepaliveBring(JW_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!jwKa.ok) logLine(`justwoker activate: keepalive :${JW_KEEPALIVE_PORT} НЕ поднялся — ${jwKa.error || '?'}`);
        logLine(`justwoker activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${JW_KEEPALIVE_URL})`);
        jsonRes(res, 200, {
            ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, viaProxy: true,
            keepalive: { up: jwKa.ok, port: JW_KEEPALIVE_PORT, error: jwKa.ok ? null : (jwKa.error || null) },
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу.
async function handleJwModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (JW_MODELS_CACHE.data && Date.now() - JW_MODELS_CACHE.ts < JW_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: JW_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${JW_BASE_URL}/models`, {
            signal: controller.signal,
            headers: { ...JW_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
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
        JW_MODELS_CACHE.data = models;
        JW_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (JW_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: JW_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

// Сменить активную модель: пишет justwoker-active-model.txt + settings.model (+ env модели).
async function handleJwSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        const settingsModel = /^claude-(opus|sonnet)-/.test(m) && !m.includes('[') ? `${m}[1m]` : m;
        fs.writeFileSync(JW_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-justwoker-model');
            const mm = (body.modelMap || {});
            settings.model = mm[m] || settingsModel;
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = JW_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`justwoker set-model: settings.json FAILED: ${e.message}`);
        }
        const jwKaM = await keepaliveBring(JW_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!jwKaM.ok) logLine(`justwoker set-model: keepalive :${JW_KEEPALIVE_PORT} НЕ поднялся — ${jwKaM.error || '?'}`);
        logLine(`justwoker set-model: ${m} (base ${JW_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: JW_ACTIVE_MODEL_FILE, base: JW_KEEPALIVE_URL, needRestart: true, keepalive: { up: jwKaM.ok, port: JW_KEEPALIVE_PORT, error: jwKaM.ok ? null : (jwKaM.error || null) } });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Настраиваемый маппинг claude-тиров → justwoker-модели (как в Custom). Живёт в сессиях.
async function handleJwModelMap(req, res) {
    try {
        const body = await readJsonBody(req);
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
        fs.writeFileSync(JW_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
        logLine(`justwoker modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
        jsonRes(res, 200, { ok: true, modelMap: mm });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function jwReadModelMap() {
    try {
        const raw = fs.readFileSync(JW_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch { return {}; }
}

// ───── SeekAi (sk) — автономная вкладка (NewAPI, GitHub-вход) ─────────────
// Шестой шлюз, структурная копия вкладки GoRouter/JustWoker: `seekai.cc` — тот же
// New API (замер 2026-08-24: `system_name: "SeekAi"`, `docs_link` на docs.newapi.pro,
// `quota_per_unit: 500000`, `quota_display_type: "USD"`). Свой пул
// (seekai-sessions.json), свой активный ключ/модель, свой keepalive :20159.
//
// Активация ЧЕРЕЗ keepalive :20159 (как у go/tb/xp/jw), а не прямым baseUrl: шлюз
// Anthropic-совместим нативно (замер 24.08: `POST /v1/messages` на `claude-sonnet-5`
// → 200, claude-модели каталога помечены `supported_endpoint_types:
// ["anthropic","openai"]`), но thinking-модели дают длинные SSE-паузы, и без
// keepalive watchdog Claude Code рвёт поток.
// 🪤 База для CC — корень БЕЗ /v1: `POST /v1/v1/messages` отдаёт 404
// (`Invalid URL`, замер 24.08). `/v1` нужен только листингу моделей — это SK_BASE_URL.
//
// GitHub-вход: seekai/open-session.js, реф-ссылка приезжает из
// routing/lib/ref-codes.js (`seekai` → `?aff=prEx`), литерала в скрипте нет.
// Регистрация мягче, чем у JustWoker: `password_register_enabled: true` и
// `github_oauth: true` разом, ограничения по возрасту GitHub-аккаунта панель не
// заявляет. 🪤 Зато включён `turnstile_check: true` + `email_verification: true` —
// поэтому авто-заведения (⚡, как у jw) тут НЕТ намеренно: сценарий нужно снимать
// рекордером по живой панели, и капча может не пустить вообще.
// Чек-ин включён (`checkin_enabled: true`), но сумма у New-API случайная, поэтому
// кнопки «+N» нет — только ✏️ и точная цифра из `/api/user/self` куками профиля.
const SK_SESSIONS_FILE = path.join(__dirname, 'seekai-sessions.json');
const SK_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'seekai-active-key.txt');
const SK_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'seekai-active-model.txt');
const SK_BASE_URL = 'https://seekai.cc/v1';
// SSE keepalive proxy для seekai (как у tabi :20155): форвардит напрямую в
// seekai.cc, режет [1m]-суффиксы и держит SSE-паузы thinking-моделей.
// UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages к корню (см. keepalive-proxy.js:427).
const SK_UPSTREAM = 'https://seekai.cc';
const SK_KEEPALIVE_PORT = 20159;
const SK_KEEPALIVE_URL = `http://localhost:${SK_KEEPALIVE_PORT}`;
const SK_MODELMAP_FILE = path.join(__dirname, 'seekai-modelmap.json');
// Резерв «угадать грант» (см. newapiBalance). 🪤 Выдача у seekai НЕ ИЗМЕРЕНА: в
// `/api/user/self` API-ключ не пускает (401, как у JustWoker), а нужный Bearer живёт
// только в контексте страницы — значит цифра приедет с первым заходом в 🌐 ЛК
// (`balanceSource = 'self'`) либо будет вписана ✏️ руками. До этого работает прикидка,
// и она умышленно ЗАНИЖЕНА: на завышенном балансе авторотация выберет пустой аккаунт
// (это стоит денег и падений), а занижение стоит лишь лишнего переключения.
// Когда цифра станет известна — поднять SK_DEFAULT_GRANT до НИЖНЕЙ границы замера,
// как сделано у JustWoker ($90 при измеренных $91–96).
const SK_GRANT_STEP = 5;
const SK_DEFAULT_GRANT = 10;
const SK_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };

const SK_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function skLoad() {
    try {
        const raw = fs.readFileSync(SK_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        // id-миграция: старые аккаунты жили только по api_key. Присваиваем стабильный id
        // (email может повторяться, ключ может меняться). Дублируем id — не трогаем, первый побеждает.
        let changed = false;
        const seen = new Set();
        arr.forEach((s, i) => {
            if (!s.id || seen.has(s.id)) {
                const base = 'sk_' + Date.now() + '_' + i;
                s.id = base + '_' + Math.random().toString(36).slice(2, 6);
                changed = true;
            }
            seen.add(s.id);
        });
        // Разовый перенос ручных grantManual/bonus/referral в анкер (см. newapiMigrateAnchors).
        if (newapiMigrateAnchors(arr)) changed = true;
        if (changed) {
            try { skSave(arr); } catch {}
        }
        return arr;
    } catch { return []; }
}
function skSave(arr) {
    fs.writeFileSync(SK_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function skReadActiveModel() {
    try { return fs.readFileSync(SK_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function skReadActiveKey() {
    try { return fs.readFileSync(SK_ACTIVE_KEY_FILE, 'utf8').trim() || null; }
    catch { return null; }
}

// SSE keepalive proxy для seekai: второй экземпляр keepalive-proxy.js на :20159.
// KEY_FILE/MODELMAP_FILE параметризованы env'ом, чтобы не пересекаться с agentrouter
// :20133 и tabi :20155. UPSTREAM БЕЗ /v1 — keepalive сам добавляет /v1/messages.
async function skKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(SK_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(SK_KEEPALIVE_PORT),
                UPSTREAM: SK_UPSTREAM,
                KEY_FILE: SK_ACTIVE_KEY_FILE,
                MODELMAP_FILE: SK_MODELMAP_FILE,
                ...(process.env.SK_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.SK_PRE_COMMIT_MS } : {}),
            },
        });
        watchChildExit(child, 'keepalive SeekAi', SK_KEEPALIVE_PORT);
        child.unref();
        logLine(`seekai keepalive proxy spawn: :${SK_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`seekai keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Пинг ключа: GET /v1/models с CC-заголовками → 200 = LIVE, 401/403 = DEAD.
async function skProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';   // заглушка вместо ключа — пинговать нечего
    try {
        const r = await fetch(`${SK_BASE_URL}/models`, {
            method: 'GET',
            headers: { ...SK_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// Баланс: usage endpoint на КОРНЕ seekai.cc (не /v1). Точный остаток — из
// /api/user/self куками профиля; резервы (анкер, угадывание) см. newapiBalance.
async function skBalance(target, opts = {}) {
    return newapiBalance({
        target: typeof target === 'string' ? { api_key: target } : (target || {}),
        host: 'seekai.cc',
        ccHeaders: SK_CC_HEADERS,
        usageUrl: 'https://seekai.cc/dashboard/billing/usage',
        subUrl: null,
        guessGrant: spent => Math.max(SK_DEFAULT_GRANT, Math.ceil(spent / SK_GRANT_STEP) * SK_GRANT_STEP),
        force: !!opts.force,
    });
}

function skApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { provider: 'seekai' }); }

async function handleSkSessions(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = skLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await skProbe(s.api_key); }));
            }
            skSave(sessions);
        }
        if (balance) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => skApplyBalance(s, await skBalance(s))));
            }
            skSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: skReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleSkPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await skProbe(api_key);
        const sessions = skLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; skSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleSkBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const recalc = async (force = false) => {
            const sessions = skLoad();
            const target = sessions.find(s => s.api_key === api_key);
            const bal = await skBalance(target || { api_key }, { force });
            if (target) { skApplyBalance(target, bal); skSave(sessions); }
            return bal;
        };
        // nudge=1: отвечаем мгновенно, считаем в своём процессе. Статусбар живёт ~50мс,
        // его фоновый curl не доживает до ответа медленного billing-эндпоинта.
        if (q.searchParams.get('nudge') === '1') {
            const queued = nudgeBalanceOnce('sk:' + api_key, recalc);
            return jsonRes(res, 200, { ok: true, queued });
        }
        // Клик по цифре — force: кеш мог быть снят до чек-ина на сайте.
        jsonRes(res, 200, await recalc(true));
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleSkSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'seekai', load: skLoad, save: skSave, balanceFn: skBalance, applyFn: skApplyBalance });
}

// Окно ЛК закрылось → точный баланс стал читаемым: пересчёт делает общая
// newapiRecheckAfterLk('sk', id) из блока GoRouter, здесь только вызов на `exit`.

const skLkPids = new Map();
function skPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleSkSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = skLoad();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const target = sessions[idx];
        // Профиль браузера привязываем к СТАБИЛЬНОМУ id аккаунта, а не к name/email:
        // переименование аккаунта не должно рвать привязку к сохранённому профилю.
        const label = 'acct_' + id;

        const prevPid = skLkPids.get(label);
        if (skPidAlive(prevPid)) {
            logLine(`seekai session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        const script = path.join(__dirname, '..', 'seekai', 'open-session.js');
        // Ротированные куки — в профиль, иначе браузер стартует с погашенной сессией.
        newapiSyncProfile('seekai.cc', label, 'перед ЛК');
        // Ключа ещё нет → гоним на регистрацию по рефке; есть — сразу на баланс.
        // `mode` из тела перебивает это правило: у безключевой записи, заселённой поверх
        // предупреждения о засвете, аккаунт у провайдера скорее всего УЖЕ есть, и рефка
        // ему не нужна — нужен вход. Регистрация вместо входа там отвечает «аккаунт уже
        // создан», и выглядит это как поломка дашборда (разбор 2026-08-21).
        const wantMode = String(body.mode || '').trim();
        const mode = (wantMode === 'console' || wantMode === 'register') ? wantMode
            : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`seekai session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`seekai session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`seekai session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => {
            skLkPids.delete(label);
            logLine(`seekai session/open: ${label} — exited (code ${code}, sig ${sig})`);
            // Замок с куки снят — точный баланс стал читаемым (см. newapiRecheckAfterLk).
            newapiRecheckAfterLk('sk', id);
        });
        proc.unref();
        skLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            skLkPids.delete(label);
            logLine(`seekai session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        newapiLkVisited(label);   // в ЛК могли пополнить/чекнуться — кеш точной цифры снят
        logLine(`seekai session/open: ${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

const SK_SHARE_SCRIPT = path.join(__dirname, '..', 'seekai', 'share-session.js');
const SK_SESSIONS_DIR = path.join(__dirname, '..', 'seekai', 'sessions');

function skB64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function skB64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// POST /__switch/api/sk/share { id } → снять storageState профиля и собрать строку.
async function handleSkShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = skLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = skLkPids.get(label);
        if (skPidAlive(prevPid)) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        // Гоняем headless-снимок профиля (короткий, до 30 сек).
        const stateFile = path.join(SK_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [SK_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code, sig) => resolve({ code, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`seekai share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;

        const payload = {
            v: 1,
            provider: 'seekai',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = skB64UrlEncode(JSON.stringify(payload));
        logLine(`seekai share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/sk/import { share } → разобрать строку и добавить аккаунт.
async function handleSkImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(skB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'seekai' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не seekai-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = skLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'sk_' + Date.now() + '_' + sessions.length;
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
        skSave(sessions);

        // «Живую» сессию кладём туда, где её подхватит open-session.js при первом открытии.
        try {
            fs.mkdirSync(SK_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(SK_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`seekai import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`seekai import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''}${typeof rec.balance === 'number' ? ', balance $' + rec.balance : ''})`);
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

async function handleSkAdd(req, res) {
    try {
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = skLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'sk_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        const link = ghLinkForNew(body, mail, nick);
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
            ...(link.ghId ? { ghId: link.ghId } : {}),
        });
        skSave(sessions);
        logLine(`seekai add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`
            + (link.how ? ` · ${link.how}` : ''));
        jsonRes(res, 200, { ok: true, id, noKey, ghId: link.ghId || null });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Сменить/вписать API-ключ у существующего аккаунта (после того, как ключ взят
// в консоли seekai). Аккаунт остаётся тем же — id и браузерный профиль не трогаем.
async function handleSkSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = skLoad();
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
            fs.writeFileSync(SK_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        }
        skSave(sessions);
        logLine(`seekai set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Переименовать аккаунт (подпись) — меняем name и/или email. id и профиль браузера
// не трогаем, поэтому привязка профиля/сессии сохраняется.
async function handleSkRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = skLoad();
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
        skSave(sessions);
        logLine(`seekai rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleSkDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = skLoad();
        const target = sessions.find(s => s.id === idKey);
        skSave(sessions.filter(s => s.id !== idKey));
        if (target && target.api_key === skReadActiveKey()) {
            try { fs.rmSync(SK_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(SK_ACTIVE_MODEL_FILE, { force: true }); } catch {}
        }
        logLine(`seekai delete: ${target ? target.email : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация ЧЕРЕЗ keepalive :20159 (не прямым baseUrl): в settings.json уезжает
// SK_KEEPALIVE_URL, а реальный ключ прокси подставляет сам из seekai-active-key.txt.
async function handleSkActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        // Заглушка вместо ключа: активировать нечего (иначе уедет в seekai-active-key.txt).
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — зарегистрируйся (🌐) и вставь ключ кнопкой 🔑' });
        const sessions = skLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(SK_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        skSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-seekai');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = SK_KEEPALIVE_URL;   // keepalive :20159 → seekai.cc напрямую
            delete settings.apiKeyHelper;
            // Модель НЕ удаляем, если есть выбранная: delete = дефолт Claude Code, а он
            // без [1m] → окно 200k. Источник правды — seekai-active-model.txt (образец —
            // handleArActivate). Суффикс дотянет writeSettings(). Если модель не выбрана,
            // пинить claude-opus-5 нельзя: в каталоге шлюза её может не быть.
            const skCurModel = skReadActiveModel() || '';
            if (skCurModel) settings.model = skCurModel;
            else { delete settings.model; logLine('seekai activate: активной модели нет → settings.model снят, Claude Code поедет на 200k'); }
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';   // реальный ключ берёт keepalive из seekai-active-key.txt
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`seekai activate: settings.json FAILED: ${e.message}`);
        }
        // Ждём, что keepalive РЕАЛЬНО ответил. Раньше здесь был голый спавн: он
        // возвращал ok сразу и считал занятый зомби-порт живым прокси, поэтому
        // активация «успешно» завершалась на мёртвом :20159, а Claude Code получал 502
        // на каждый запрос, пока человек не нажмёт «перезапустить» в Health.
        const skKa = await keepaliveBring(SK_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!skKa.ok) logLine(`seekai activate: keepalive :${SK_KEEPALIVE_PORT} НЕ поднялся — ${skKa.error || '?'}`);
        logLine(`seekai activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${SK_KEEPALIVE_URL})`);
        jsonRes(res, 200, {
            ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, viaProxy: true,
            keepalive: { up: skKa.ok, port: SK_KEEPALIVE_PORT, error: skKa.ok ? null : (skKa.error || null) },
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу.
async function handleSkModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (SK_MODELS_CACHE.data && Date.now() - SK_MODELS_CACHE.ts < SK_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: SK_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${SK_BASE_URL}/models`, {
            signal: controller.signal,
            headers: { ...SK_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
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
        SK_MODELS_CACHE.data = models;
        SK_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (SK_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: SK_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

// Сменить активную модель: пишет seekai-active-model.txt + settings.model (+ env модели).
async function handleSkSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        const settingsModel = /^claude-(opus|sonnet)-/.test(m) && !m.includes('[') ? `${m}[1m]` : m;
        fs.writeFileSync(SK_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-seekai-model');
            const mm = (body.modelMap || {});
            settings.model = mm[m] || settingsModel;
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = SK_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`seekai set-model: settings.json FAILED: ${e.message}`);
        }
        const skKaM = await keepaliveBring(SK_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!skKaM.ok) logLine(`seekai set-model: keepalive :${SK_KEEPALIVE_PORT} НЕ поднялся — ${skKaM.error || '?'}`);
        logLine(`seekai set-model: ${m} (base ${SK_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: SK_ACTIVE_MODEL_FILE, base: SK_KEEPALIVE_URL, needRestart: true, keepalive: { up: skKaM.ok, port: SK_KEEPALIVE_PORT, error: skKaM.ok ? null : (skKaM.error || null) } });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Настраиваемый маппинг claude-тиров → seekai-модели (как в Custom). Живёт в сессиях.
async function handleSkModelMap(req, res) {
    try {
        const body = await readJsonBody(req);
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
        fs.writeFileSync(SK_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
        logLine(`seekai modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
        jsonRes(res, 200, { ok: true, modelMap: mm });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function skReadModelMap() {
    try {
        const raw = fs.readFileSync(SK_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch { return {}; }
}

// ───── TrueSOTA (ts) — автономная вкладка (sub2api, GitHub-вход) ───────────
// Седьмой шлюз. Структурно — копия вкладки GoRouter/SeekAi, но панель ДРУГАЯ, и это
// главное, что нужно помнить: `true-sota.com` работает на открытом **sub2api**
// (github.com/Wei-Shaw/sub2api, LGPL-3.0) — Go+Vue шлюз, раздающий квоту ПОДПИСОК
// (Claude, Codex, Gemini, Grok, Antigravity) как API-ключи. Замеры 2026-08-25:
//   • `GET /api/status` → 404, `/api/user/self` → 404 — вся New-API механика мимо;
//   • `GET /api/v1/settings/public` → `site_name: "TrueSOTA"`, `github_oauth_enabled: true`,
//     `registration_enabled: true`, `turnstile_enabled: true`, `invitation_code_enabled: false`;
//   • вход держится на JWT в localStorage (`auth_token`/`refresh_token`), НЕ на куке;
//   • ключи: `GET/POST /api/v1/keys`, квота: `GET /api/v1/subscriptions/summary`.
// Поэтому баланс и токены живут в своём модуле — routing/lib/truesota-account.js.
//
// 🪤 РАБОЧИХ МОДЕЛЕЙ ДВЕ: `claude-opus-5` и `claude-opus-5-thinking`. Остальные 16 из
// каталога — реселл Kiro: шлюз подставляет СВОЙ системный промпт (префикс 4.1–6.9к
// токенов) и наш `system` не исполняет. Замер: `system: "тебя зовут NAIL-7"` →
// «My name is Kiro» на sonnet-4-6/sonnet-5/opus-4-5/4-6/4-7/4-8/haiku-4-5, и то же
// самое когда инструкция уехала в сообщение пользователя. На opus-5 тот же запрос
// даёт «NAIL-7», работает `tools`/`tool_use` (id вида `toolu_bdrk_…` — канал через
// Bedrock). Отсюда тир-карта truesota-modelmap.json = opus-only во всех трёх тирах:
// пустой нижний тир роняет запрос без ретрая, а sonnet-тир выбросил бы промпт агента.
//
// Мульти-запрос (hedges) выключен, как у остальных форков: тариф подписочный, дубль
// стоит полный запрос и ускорения не даёт (FLAT_RATE_HOSTS в keepalive-proxy.js).
// Авто-заведения (⚡) НЕТ намеренно: на регистрации капча Turnstile, а почтовая
// регистрация ограничена белым списком доменов — путь один, GitHub-вход руками.
const TS_SESSIONS_FILE = path.join(__dirname, 'truesota-sessions.json');
const TS_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'truesota-active-key.txt');
const TS_ACTIVE_MODEL_FILE = path.join(os.homedir(), '.claude', 'truesota-active-model.txt');
// /v1 — только для листинга моделей. Для запросов keepalive сам добавляет /v1/messages
// к корню, поэтому UPSTREAM без /v1 (та же грабля, что у JustWoker и SeekAi).
const TS_BASE_URL = 'https://true-sota.com/v1';
const TS_UPSTREAM = 'https://true-sota.com';
const TS_KEEPALIVE_PORT = Number(process.env.TS_KEEPALIVE_PORT || 20160);
const TS_KEEPALIVE_URL = `http://localhost:${TS_KEEPALIVE_PORT}`;
const TS_MODELMAP_FILE = path.join(__dirname, 'truesota-modelmap.json');
const TS_MODELS_CACHE = { data: null, ts: 0, TTL: 300_000 };
const TS_SHARE_SCRIPT = path.join(__dirname, '..', 'truesota', 'share-session.js');
const TS_SESSIONS_DIR = path.join(__dirname, '..', 'truesota', 'sessions');

const TS_CC_HEADERS = {
    'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
};

function tsLib() {
    try { return require('./lib/truesota-account'); }
    catch (e) { logLine(`truesota-account недоступен: ${e.message}`); return null; }
}

function tsLoad() {
    try {
        const raw = fs.readFileSync(TS_SESSIONS_FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (!Array.isArray(arr)) return [];
        let changed = false;
        const seen = new Set();
        arr.forEach((s, i) => {
            if (!s.id || seen.has(s.id)) {
                s.id = 'ts_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 6);
                changed = true;
            }
            seen.add(s.id);
        });
        if (newapiMigrateAnchors(arr)) changed = true;
        if (changed) { try { tsSave(arr); } catch {} }
        return arr;
    } catch { return []; }
}
function tsSave(arr) {
    fs.writeFileSync(TS_SESSIONS_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}
function tsReadActiveModel() {
    try { return fs.readFileSync(TS_ACTIVE_MODEL_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function tsReadActiveKey() {
    try { return fs.readFileSync(TS_ACTIVE_KEY_FILE, 'utf8').trim() || null; }
    catch { return null; }
}
function tsReadModelMap() {
    try {
        const raw = fs.readFileSync(TS_MODELMAP_FILE, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch { return {}; }
}

// SSE keepalive proxy для truesota: седьмой экземпляр keepalive-proxy.js, :20160.
async function tsKeepaliveSpawn() {
    try {
        const net = require('net');
        const free = await new Promise(resolve => {
            const sock = net.createServer();
            sock.once('error', () => resolve(false));
            sock.listen(TS_KEEPALIVE_PORT, '127.0.0.1', () => { sock.close(); resolve(true); });
        });
        if (!free) return { ok: true, already: true };
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, KEEPALIVE_PROXY_FILE)], {
            detached: true, stdio: 'ignore', env: {
                ...process.env,
                PORT: String(TS_KEEPALIVE_PORT),
                UPSTREAM: TS_UPSTREAM,
                KEY_FILE: TS_ACTIVE_KEY_FILE,
                MODELMAP_FILE: TS_MODELMAP_FILE,
                ...(process.env.TS_PRE_COMMIT_MS ? { PRE_COMMIT_MS: process.env.TS_PRE_COMMIT_MS } : {}),
            },
        });
        watchChildExit(child, 'keepalive TrueSOTA', TS_KEEPALIVE_PORT);
        child.unref();
        logLine(`truesota keepalive proxy spawn: :${TS_KEEPALIVE_PORT} (pid ${child.pid})`);
        return { ok: true, pid: child.pid };
    } catch (e) {
        logLine(`truesota keepalive proxy spawn FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Пинг ключа: GET /v1/models → 200 = LIVE, 401/403 = DEAD.
async function tsProbe(apiKey) {
    if (!isRealKey(apiKey)) return 'no_key';
    try {
        const r = await fetch(`${TS_BASE_URL}/models`, {
            method: 'GET',
            headers: { ...TS_CC_HEADERS, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
        });
        if (r.status === 200) return 'live';
        if (r.status === 401 || r.status === 403) return 'dead';
        return 'unknown';
    } catch { return 'unknown'; }
}

// Баланс. Тут вкладка расходится с пятью New-API-шлюзами полностью: цифру считает
// routing/lib/truesota-account.js, а не newapiBalance. Приоритет — лимит самого ключа
// (`/keys`), потом самое узкое окно подписки (`/subscriptions/summary`); если токена
// панели нет, честно отдаём живость без цифры (balance: null) и причину в quotaError.
// «Угадать грант», как у New-API, тут не делаем осознанно: у подписочного тарифа
// выдумывать остаток нечем — прикидка от расхода врала бы в обе стороны.
async function tsBalance(target, opts = {}) {
    const rec = typeof target === 'string' ? { api_key: target } : (target || {});
    const lib = tsLib();
    if (!lib) return { status: 'unknown', error: 'модуль truesota-account не загружается' };
    const label = rec.id ? 'acct_' + rec.id : null;
    const profileDir = label ? path.join(__dirname, '..', 'truesota', 'profiles', label) : null;
    try {
        return await lib.balance({ target: rec, label: label || 'anon', profileDir, force: !!opts.force });
    } catch (e) {
        return { status: 'unknown', error: e.message };
    }
}

function tsApplyBalance(target, bal) {
    const out = newapiApplyBalance(target, bal, { provider: 'truesota' });
    // Причина отсутствия цифры и окно, по которому она считалась, нужны в UI — иначе
    // «$—» выглядит как поломка вкладки, хотя это «у аккаунта нет лимита» или
    // «браузер аккаунта открыт, токен не прочитать».
    if (bal && bal.quotaError) target.quotaError = bal.quotaError; else if (target) delete target.quotaError;
    if (bal && bal.window) target.quotaWindow = bal.window; else if (target) delete target.quotaWindow;
    if (bal && bal.groupName) target.groupName = bal.groupName;
    return out;
}

async function handleTsSessions(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const params = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const probe = params.get('probe') === '1';
        const balance = params.get('balance') === '1';
        const sessions = tsLoad();
        if (probe) {
            for (let i = 0; i < sessions.length; i += 3) {
                await Promise.all(sessions.slice(i, i + 3).map(async s => { s.status = await tsProbe(s.api_key); }));
            }
            tsSave(sessions);
        }
        if (balance) {
            // По ОДНОМУ, а не пачкой по три: чек может поднять headless-Chromium ради
            // токена панели, и три браузера разом на слабой машине — это минуты и своп.
            for (const s of sessions) tsApplyBalance(s, await tsBalance(s));
            tsSave(sessions);
        }
        jsonRes(res, 200, { sessions, activeModel: tsReadActiveModel() });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleTsPing(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const status = await tsProbe(api_key);
        const sessions = tsLoad();
        const target = sessions.find(s => s.api_key === api_key);
        if (target) { target.status = status; tsSave(sessions); }
        jsonRes(res, 200, { status });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTsBalance(req, res) {
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const api_key = q.searchParams.get('api_key');
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });
        const recalc = async (force = false) => {
            const sessions = tsLoad();
            const target = sessions.find(s => s.api_key === api_key);
            const bal = await tsBalance(target || { api_key }, { force });
            if (target) { tsApplyBalance(target, bal); tsSave(sessions); }
            return bal;
        };
        if (q.searchParams.get('nudge') === '1') {
            const queued = nudgeBalanceOnce('ts:' + api_key, recalc);
            return jsonRes(res, 200, { ok: true, queued });
        }
        jsonRes(res, 200, await recalc(true));
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

function handleTsSetBalance(req, res) {
    return newapiSetBalance(req, res, { tag: 'truesota', load: tsLoad, save: tsSave, balanceFn: tsBalance, applyFn: tsApplyBalance });
}

const tsLkPids = new Map();
function tsPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function handleTsSessionOpen(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tsLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        const prevPid = tsLkPids.get(label);
        if (tsPidAlive(prevPid)) {
            logLine(`truesota session/open: ${label} — уже открыт (pid ${prevPid})`);
            return jsonRes(res, 200, { ok: true, label, already: true, pid: prevPid });
        }

        // 🪤 newapiSyncProfile здесь НЕ звоним, в отличие от New-API-вкладок: ротировать
        // в профиль нечего — сессия панели живёт в localStorage самого профиля, а не в
        // нашей банке кук. Лишний вызов только путал бы лог.
        const script = path.join(__dirname, '..', 'truesota', 'open-session.js');
        const wantMode = String(body.mode || '').trim();
        const mode = (wantMode === 'console' || wantMode === 'register') ? wantMode
            : isRealKey(target.api_key) ? 'console' : 'register';
        const proc = spawn(process.execPath, [script, label, mode], { detached: true, stdio: 'pipe' });
        proc.stdout.on('data', d => logLine(`truesota session/open [${label}]: ${String(d).trim()}`));
        proc.stderr.on('data', d => logLine(`truesota session/open ERR [${label}]: ${String(d).trim()}`));
        proc.on('error', e => logLine(`truesota session/open spawn error: ${e.message}`));
        proc.on('exit', (code, sig) => {
            tsLkPids.delete(label);
            logLine(`truesota session/open: ${label} — exited (code ${code}, sig ${sig})`);
            // Окно закрылось → профиль отпущен, токен панели снова читается.
            newapiRecheckAfterLk('ts', id);
        });
        proc.unref();
        tsLkPids.set(label, proc.pid);
        const failed = await sessionOpenEarlyFailure(proc);
        if (failed) {
            tsLkPids.delete(label);
            logLine(`truesota session/open FAIL [${label}]: ${failed}`);
            return jsonRes(res, 502, { error: failed });
        }
        newapiLkVisited(label);
        logLine(`truesota session/open: ${label} mode=${mode} (pid ${proc.pid})`);
        jsonRes(res, 200, { ok: true, label, pid: proc.pid, mode });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// share/import: кодек тот же, что у SeekAi (skB64UrlEncode/Decode) — намеренно
// переиспользуем, а не копируем: это чистая base64url, и вторая копия только
// разъезжалась бы. Различает форматы поле `provider` внутри payload.
async function handleTsShare(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tsLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;

        if (tsPidAlive(tsLkPids.get(label))) {
            return jsonRes(res, 409, { error: 'Браузер аккаунта открыт. Закрой его (Ctrl+C) и попробуй ещё раз.' });
        }

        const stateFile = path.join(TS_SESSIONS_DIR, label + '.json');
        const code = await new Promise((resolve, reject) => {
            const proc = spawn(process.execPath, [TS_SHARE_SCRIPT, label], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            proc.stdout.on('data', d => out += String(d));
            proc.stderr.on('data', d => err += String(d));
            proc.on('error', reject);
            proc.on('exit', (code) => resolve({ code, out, err, stateFile }));
            setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
        });

        if (code.code !== 0 && code.code !== 3) {
            logLine(`truesota share [${label}] failed (code ${code.code}): ${code.err.trim() || code.out.trim()}`);
            return jsonRes(res, 502, { error: (code.err.trim() || code.out.trim() || 'снимок профиля не удался') });
        }

        let session = { cookies: [], origins: [] };
        try { session = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
        const cookieCount = (session.cookies || []).length;
        const originCount = (session.origins || []).length;
        // Токен панели — единственное, что реально переносит вход у sub2api. Считаем
        // его отдельно и говорим прямо: снимок без токена получателю бесполезен.
        const panelOrigin = (session.origins || []).find(o => /true-sota\.com$/i.test(String(o.origin || '').replace(/^https?:\/\//, '')));
        const hasToken = !!(panelOrigin && (panelOrigin.localStorage || []).some(e => e.name === 'auth_token' && e.value));

        const payload = {
            v: 1,
            provider: 'truesota',
            email: target.email || '',
            name: target.name || '',
            api_key: target.api_key || '',
            meta: sharePickMeta(target),
            session,
        };
        const share = skB64UrlEncode(JSON.stringify(payload));
        logLine(`truesota share [${label}]: ${target.email} (cookies ${cookieCount}, origins ${originCount}, токен ${hasToken ? 'есть' : 'НЕТ'}, len ${share.length})`);
        jsonRes(res, 200, { ok: true, share, hasSession: cookieCount > 0 || originCount > 0, cookieCount, originCount, hasToken });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTsImport(req, res) {
    try {
        const body = await readJsonBody(req);
        const share = String(body.share || '').trim();
        if (!share) return jsonRes(res, 400, { error: 'share обязателен' });
        let payload;
        try { payload = JSON.parse(skB64UrlDecode(share)); }
        catch { return jsonRes(res, 400, { error: 'строка не похожа на share-код (не JSON)' }); }
        if (payload.provider !== 'truesota' || payload.v !== 1) {
            return jsonRes(res, 400, { error: `не truesota-аккаунт (provider=${payload.provider}, v=${payload.v})` });
        }
        const mail = String(payload.email || '').trim();
        const key = String(payload.api_key || '').trim();
        if (!mail || !key) return jsonRes(res, 400, { error: 'в share-коде нет email/api_key' });
        const session = (payload.session && typeof payload.session === 'object')
            ? { cookies: payload.session.cookies || [], origins: payload.session.origins || [] }
            : { cookies: [], origins: [] };

        const sessions = tsLoad();
        const dupKey = sessions.find(s => s.api_key === key);
        const dupEmail = sessions.find(s => (s.email || '').toLowerCase() === mail.toLowerCase());
        if (dupKey) return jsonRes(res, 409, { error: `такой API-ключ уже есть (${dupKey.email || dupKey.name})` });
        if (dupEmail) return jsonRes(res, 409, { error: `такой email уже есть (${dupEmail.email})` });

        const id = 'ts_' + Date.now() + '_' + sessions.length;
        const label = 'acct_' + id;
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
        tsSave(sessions);

        try {
            fs.mkdirSync(TS_SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(path.join(TS_SESSIONS_DIR, label + '.json'), JSON.stringify(session, null, 2), 'utf8');
        } catch (e) { logLine(`truesota import: не смогли сохранить сессию ${label}: ${e.message}`); }

        logLine(`truesota import: ${mail} (***${key.slice(-6)}${session.cookies.length ? ', cookies ' + session.cookies.length : ''})`);
        jsonRes(res, 200, {
            ok: true, id, email: mail,
            hasSession: session.cookies.length > 0 || session.origins.length > 0,
            balance: typeof rec.balance === 'number' ? rec.balance : null,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTsAdd(req, res) {
    try {
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = tsLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'ts_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        const link = ghLinkForNew(body, mail, nick);
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
            ...(link.ghId ? { ghId: link.ghId } : {}),
        });
        tsSave(sessions);
        logLine(`truesota add: ${mail} (${noKey ? 'без ключа — вход через GitHub, потом 🔑➕' : '***' + key.slice(-6)})`
            + (link.how ? ` · ${link.how}` : ''));
        jsonRes(res, 200, { ok: true, id, noKey, ghId: link.ghId || null });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTsSetKey(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        const newKey = String(body.api_key || '').trim();
        if (!id || !newKey) return jsonRes(res, 400, { error: 'id и api_key обязательны' });
        const sessions = tsLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        if (sessions.some(s => s.api_key === newKey && s.id !== id)) {
            return jsonRes(res, 400, { error: 'такой ключ уже занят другим аккаунтом' });
        }
        const wasActive = !!target.active;
        target.api_key = newKey;
        if (target.status === 'no_key' && isRealKey(newKey)) target.status = 'unknown';
        if (wasActive) fs.writeFileSync(TS_ACTIVE_KEY_FILE, newKey, { encoding: 'utf-8', flag: 'w' });
        tsSave(sessions);
        logLine(`truesota set-key: ${target.email} → ***${newKey.slice(-6)}${wasActive ? ' (был активен, обновили активный ключ)' : ''}`);
        jsonRes(res, 200, { ok: true, email: target.email, wasActive });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// POST /__switch/api/ts/key-create { id, name?, activate? }
// 🔑➕ на вкладке: снять токен панели с профиля аккаунта → создать ключ её же API →
// вписать в пул. Это замена «зайди в ЛК, скопируй ключ, вставь кнопкой 🔑»: у sub2api
// ключ отдаётся в ответе `POST /api/v1/keys` полем `key` целиком, поэтому копировать
// глазами нечего. Ручной путь (🔑) при этом остался — он нужен, когда ключ уже создан.
//
// 🪤 Профиль обязан быть ЗАКРЫТ: пока окно ЛК живо, Chromium держит профиль, и снять
// localStorage нельзя. Поэтому проверяем pid до всякой работы и говорим это прямо,
// а не «токен не найден» — иначе владелец идёт открывать ЛК ещё раз и держит замок.
async function handleTsKeyCreate(req, res) {
    const stopKeepalive = jsonKeepalive(res);   // headless-запуск = десятки секунд молчания
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tsLoad();
        const target = sessions.find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;
        if (tsPidAlive(tsLkPids.get(label))) {
            return jsonRes(res, 409, { error: 'Браузер этого аккаунта открыт — закрой окно ЛК и повтори: пока оно живо, токен панели не прочитать.' });
        }
        const lib = tsLib();
        if (!lib) return jsonRes(res, 500, { error: 'модуль truesota-account не загружается' });

        const profileDir = path.join(__dirname, '..', 'truesota', 'profiles', label);
        const t = await lib.tokenFor(label, profileDir, { force: !!body.force });
        if (!t.ok) return jsonRes(res, 409, { error: t.error });

        const name = String(body.name || '').trim() || `claude-code ${new Date().toISOString().slice(0, 10)}`;
        const created = await lib.createKey(t.token, name);
        if (!created.ok) return jsonRes(res, 502, { error: `панель не создала ключ: ${created.error}` });

        if (sessions.some(s => s.api_key === created.key && s.id !== id)) {
            return jsonRes(res, 409, { error: 'панель отдала ключ, который уже есть в пуле у другой записи' });
        }
        target.api_key = created.key;
        target.status = 'unknown';
        target.keyId = created.id != null ? created.id : undefined;
        target.keyName = created.name || name;
        target.keyCreatedAt = new Date().toISOString();
        if (target.active) fs.writeFileSync(TS_ACTIVE_KEY_FILE, created.key, { encoding: 'utf-8', flag: 'w' });
        tsSave(sessions);
        logLine(`truesota key-create: ${target.email} → ***${created.key.slice(-6)} (id ${created.id}, токен из ${t.from})`);

        // Сразу считаем квоту: токен в руках, второй раз браузер поднимать не придётся.
        try {
            const bal = await tsBalance(target);
            const fresh = tsLoad();
            const again = fresh.find(s => s.id === id);
            if (again) { tsApplyBalance(again, bal); tsSave(fresh); }
        } catch {}

        jsonRes(res, 200, {
            ok: true, id, key: created.key, mask: '***' + created.key.slice(-6),
            keyId: created.id || null, name: created.name || name, tokenFrom: t.from,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

// GET /__switch/api/ts/token?id=… — диагностика входа: есть ли живой токен панели,
// откуда он взялся, что говорит `/auth/me`. Отдельная кнопка нужна потому, что у
// sub2api «аккаунт залогинен» и «ключ жив» — два независимых факта: ключ может
// работать, когда токен давно истёк, и наоборот.
async function handleTsToken(req, res) {
    const stopKeepalive = jsonKeepalive(res);
    try {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
        const id = String(q.searchParams.get('id') || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const target = tsLoad().find(s => s.id === id);
        if (!target) return jsonRes(res, 404, { error: 'аккаунт не найден' });
        const label = 'acct_' + id;
        if (tsPidAlive(tsLkPids.get(label))) {
            return jsonRes(res, 409, { error: 'браузер аккаунта открыт — профиль заперт, токен не прочитать' });
        }
        const lib = tsLib();
        if (!lib) return jsonRes(res, 500, { error: 'модуль truesota-account не загружается' });
        const profileDir = path.join(__dirname, '..', 'truesota', 'profiles', label);
        const t = await lib.tokenFor(label, profileDir, { force: q.searchParams.get('force') === '1' });
        if (!t.ok) return jsonRes(res, 200, { ok: false, error: t.error });
        const who = await lib.me(t.token);
        const subs = await lib.subscriptionSummary(t.token);
        const keys = await lib.listKeys(t.token);
        jsonRes(res, 200, {
            ok: true,
            from: t.from,
            user: who.ok ? { id: who.user && who.user.id, email: who.user && who.user.email, username: who.user && who.user.username } : null,
            userError: who.ok ? null : who.error,
            subscriptions: subs.ok ? { activeCount: subs.activeCount, totalUsedUsd: subs.totalUsedUsd, items: subs.subscriptions } : null,
            subscriptionsError: subs.ok ? null : subs.error,
            keys: keys.ok ? keys.keys.length : null,
            keysError: keys.ok ? null : keys.error,
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    finally { stopKeepalive(); }
}

async function handleTsRename(req, res) {
    try {
        const body = await readJsonBody(req);
        const id = String(body.id || '').trim();
        if (!id) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tsLoad();
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
        tsSave(sessions);
        logLine(`truesota rename: ${target.email} (${target.name})`);
        jsonRes(res, 200, { ok: true, email: target.email, name: target.name });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTsDelete(req, res) {
    try {
        const { id } = await readJsonBody(req);
        const idKey = String(id || '').trim();
        if (!idKey) return jsonRes(res, 400, { error: 'id обязателен' });
        const sessions = tsLoad();
        const target = sessions.find(s => s.id === idKey);
        tsSave(sessions.filter(s => s.id !== idKey));
        if (target && target.api_key === tsReadActiveKey()) {
            try { fs.rmSync(TS_ACTIVE_KEY_FILE, { force: true }); } catch {}
            try { fs.rmSync(TS_ACTIVE_MODEL_FILE, { force: true }); } catch {}
        }
        // Токены удалённой записи из банки тоже убираем: это живой доступ к аккаунту,
        // и держать его после удаления записи незачем.
        try {
            const lib = tsLib();
            if (lib) {
                const jar = lib.loadJar();
                if (jar['acct_' + idKey]) { delete jar['acct_' + idKey]; lib.saveJar(jar); }
            }
        } catch {}
        logLine(`truesota delete: ${target ? target.email : '?'}`);
        jsonRes(res, 200, { ok: true });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Активация ЧЕРЕЗ keepalive :20160: в settings.json уезжает TS_KEEPALIVE_URL, а
// реальный ключ прокси подставляет сам из truesota-active-key.txt.
async function handleTsActivate(req, res) {
    try {
        const body = await readJsonBody(req);
        const key = String(body.api_key || '').trim();
        if (!key) return jsonRes(res, 400, { error: 'api_key обязателен' });
        if (!isRealKey(key)) return jsonRes(res, 400, { error: 'у аккаунта ещё нет ключа — войди через GitHub (🌐), закрой окно и нажми 🔑➕' });
        const sessions = tsLoad();
        const target = sessions.find(s => s.api_key === key);
        if (!target) return jsonRes(res, 404, { error: 'ключ не найден' });

        fs.writeFileSync(TS_ACTIVE_KEY_FILE, key, { encoding: 'utf-8', flag: 'w' });
        sessions.forEach(s => { s.active = s.api_key === key; });
        tsSave(sessions);

        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-truesota');
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = TS_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            // Модель: источник правды — truesota-active-model.txt. Если не выбрана, пинить
            // нечего вслепую, НО у этого шлюза дефолт очевиден и безопасен — тир-карта
            // opus-only, а `claude-opus-5` единственная модель, которая не подменяет
            // системный промпт. Поэтому пустую модель заполняем ею, а не снимаем.
            const tsCurModel = tsReadActiveModel() || 'claude-opus-5';
            settings.model = normalizeCcModel(tsCurModel);
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`truesota activate: settings.json FAILED: ${e.message}`);
        }
        const tsKa = await keepaliveBring(TS_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!tsKa.ok) logLine(`truesota activate: keepalive :${TS_KEEPALIVE_PORT} НЕ поднялся — ${tsKa.error || '?'}`);
        logLine(`truesota activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${TS_KEEPALIVE_URL})`);
        jsonRes(res, 200, {
            ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, viaProxy: true,
            keepalive: { up: tsKa.ok, port: TS_KEEPALIVE_PORT, error: tsKa.ok ? null : (tsKa.error || null) },
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// Модели: кэш 5 минут, к любому живому ключу.
// 🪤 Каталог отдаёт 18 моделей, но пригодны ДВЕ (opus-5 и opus-5-thinking) — остальные
// подменяют системный промпт. Поэтому в ответе помечаем каждую модель полем
// `systemHonored`, и вкладка рисует непригодные приглушённо: список без метки
// выглядел бы как «выбирай что хочешь» и однажды увёл бы вкладку на sonnet.
const TS_SYSTEM_HONORED = new Set(['claude-opus-5', 'claude-opus-5-thinking']);
async function handleTsModels(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const api_key = url.searchParams.get('api_key');
        const force = url.searchParams.get('force') === '1';
        if (!api_key) return jsonRes(res, 400, { error: 'api_key required' });

        if (TS_MODELS_CACHE.data && Date.now() - TS_MODELS_CACHE.ts < TS_MODELS_CACHE.TTL && !force) {
            return jsonRes(res, 200, { ok: true, models: TS_MODELS_CACHE.data, cached: true });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`${TS_BASE_URL}/models`, {
            signal: controller.signal,
            headers: { ...TS_CC_HEADERS, 'Authorization': `Bearer ${api_key}` },
        });
        clearTimeout(timeout);
        if (!resp.ok) return jsonRes(res, 200, { ok: true, models: [], note: `HTTP ${resp.status}` });
        const data = await resp.json();
        const models = (data.data || []).map(m => ({
            id: m.id,
            owned_by: m.owned_by,
            display_name: m.display_name,
            systemHonored: TS_SYSTEM_HONORED.has(m.id),
        }));
        TS_MODELS_CACHE.data = models;
        TS_MODELS_CACHE.ts = Date.now();
        jsonRes(res, 200, { ok: true, models, cached: false });
    } catch (e) {
        if (TS_MODELS_CACHE.data) jsonRes(res, 200, { ok: true, models: TS_MODELS_CACHE.data, cached: true, note: e.message });
        else jsonRes(res, 200, { ok: true, models: [], note: e.message });
    }
}

async function handleTsSetModel(req, res) {
    try {
        const body = await readJsonBody(req);
        const m = String(body.model || '').trim();
        if (!m) return jsonRes(res, 400, { error: 'model обязателен' });
        // Предупреждение, а не запрет: выбор модели — решение владельца, но молча
        // ставить модель, которая выбрасывает системный промпт, нельзя.
        const warn = TS_SYSTEM_HONORED.has(m) ? null
            : `модель ${m} НЕ исполняет системный промпт (шлюз подставляет свой, Kiro) — для Claude Code годятся только ${[...TS_SYSTEM_HONORED].join(' и ')}`;
        if (warn) logLine(`truesota set-model: ⚠️ ${warn}`);
        fs.writeFileSync(TS_ACTIVE_MODEL_FILE, m + '\n', { encoding: 'utf-8', flag: 'w' });
        let settingsOk = false;
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            makeSettingsBackup('settings-truesota-model');
            const mm = (body.modelMap || {});
            settings.model = mm[m] || normalizeCcModel(m);
            settings.env = settings.env || {};
            settings.env.ANTHROPIC_BASE_URL = TS_KEEPALIVE_URL;
            delete settings.apiKeyHelper;
            delete settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS;
            delete settings.env.ANTHROPIC_API_KEY;
            clearOtEnv(settings);
            settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
            writeSettings(settings);
            settingsOk = true;
        } catch (e) {
            logLine(`truesota set-model: settings.json FAILED: ${e.message}`);
        }
        const tsKaM = await keepaliveBring(TS_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!tsKaM.ok) logLine(`truesota set-model: keepalive :${TS_KEEPALIVE_PORT} НЕ поднялся — ${tsKaM.error || '?'}`);
        logLine(`truesota set-model: ${m} (base ${TS_KEEPALIVE_URL})`);
        jsonRes(res, 200, {
            ok: true, model: m, settingsModel: normalizeCcModel(m), settingsUpdated: settingsOk,
            modelFile: TS_ACTIVE_MODEL_FILE, base: TS_KEEPALIVE_URL, needRestart: true, warn,
            keepalive: { up: tsKaM.ok, port: TS_KEEPALIVE_PORT, error: tsKaM.ok ? null : (tsKaM.error || null) },
        });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

async function handleTsModelMap(req, res) {
    try {
        const body = await readJsonBody(req);
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
        fs.writeFileSync(TS_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');
        const bad = ['opus', 'sonnet', 'haiku'].filter(t => mm[t] && !TS_SYSTEM_HONORED.has(mm[t]));
        if (bad.length) logLine(`truesota modelmap: ⚠️ тиры ${bad.join('/')} смотрят на модель, которая выбрасывает системный промпт`);
        if (['opus', 'sonnet', 'haiku'].some(t => !mm[t])) logLine('truesota modelmap: ⚠️ пустой тир — запрос этого тира упадёт без ретрая');
        logLine(`truesota modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
        jsonRes(res, 200, { ok: true, modelMap: mm, warnTiers: bad });
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
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
        watchChildExit(child, 'keepalive Tabi', TB_KEEPALIVE_PORT);
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

// ───── Подъём keepalive-инстанса (:20133 AR / :20155 Tabi / :20156 GoRouter / :20157 XPeach / :20158 JustWoker) ─────
// xxKeepaliveSpawn() поднимают процесс ТОЛЬКО если порт свободен, автоперезапуска нет
// (после правки keepalive-proxy.js новый код подхватывается лишь пересозданием
// процесса), и «занято» они читают как «уже работает». Раньше пересоздавали таскиллом
// руками: порт оставался пустым, и все сессии CC/happy получали ConnectionRefused —
// settings.json смотрит ровно в один из этих портов. Поэтому вся работа с портом идёт
// через keepaliveBring() ниже: HTTP-проба живости, снятие зомби, ожидание /status.
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
        [JW_KEEPALIVE_PORT]: { name: 'JustWoker', spawn: jwKeepaliveSpawn },
        [SK_KEEPALIVE_PORT]: { name: 'SeekAi', spawn: skKeepaliveSpawn },
        [TS_KEEPALIVE_PORT]: { name: 'TrueSOTA', spawn: tsKeepaliveSpawn },
        [KK_KEEPALIVE_PORT]: { name: 'KKtoken', spawn: kkKeepaliveSpawn },
        [HN_KEEPALIVE_PORT]: { name: 'HCNsec', spawn: hnKeepaliveSpawn },
        // Front-door — не keepalive, но чинится ровно так же, а кнопка нужна тем
        // более: пока он лежит, у Claude Code нет бэкенда вообще.
        [frontdoorPort()]: { name: 'Front Door', spawn: frontdoorSpawn, statusPath: '/__frontdoor/api/status' },
    };
}

// Живой ли кто-то на порту — спрашиваем ПО HTTP, а не по bind. Разница
// принципиальная: bind отвечает лишь «занято», а занять порт может и зомби —
// повисший или недобитый прошлый процесс. Возвращает тело /status или null.
async function probeStatus(port, statusPath) {
    try {
        const r = await fetch(`http://127.0.0.1:${port}${statusPath}`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return null;
        return await r.json().catch(() => ({}));
    } catch { return null; }
}

// Три попытки, а не одна: различить «мёртв» и «занят делом» по одному
// 1.5-секундному таймауту нельзя, а цена ошибки — убийство живого прокси под
// нагрузкой, то есть обрыв всех сессий Claude Code.
async function portAnswers(port, statusPath, tries = 3) {
    for (let i = 0; i < tries; i += 1) {
        const s = await probeStatus(port, statusPath);
        if (s) return s;
        if (i + 1 < tries) await napMs(300);
    }
    return null;
}

// ЕДИНСТВЕННАЯ дверь для «подними keepalive и убедись, что он живой».
//
// Почему одна: xxKeepaliveSpawn() спавнит только при свободном порте и возвращает
// ok сразу после spawn(), не дожидаясь, что порт ожил. По отдельности оба свойства
// разумны, вместе — дыра в два шага:
//   1. порт, занятый зомби, читается как `already: true` («уже работает»),
//   2. ребёнок, умерший на старте, — как успех со свежим pid в логе.
// Поймано 21.08 у второго пользователя: после обновления и добавления аккаунта
// GoRouter :20156 не отвечал, а и активация, и boot дашборда считали, что подняли.
// Помогла только кнопка «перезапустить» в Health — единственный путь, который
// СНАЧАЛА убивал держателя порта и потом ждал живого /status. Теперь так делают все.
//
// force = кнопка в Health: убить безусловно, даже живого. Нужно, чтобы подхватился
// новый код keepalive-proxy.js после обновления — сам он не перезагружается.
async function keepaliveBring(port, opts = {}) {
    const instances = keepaliveInstances();
    const inst = instances[port];
    if (!inst) {
        return { ok: false, error: `:${port} — не keepalive-инстанс (можно ${Object.keys(instances).join(', ')})` };
    }
    const statusPath = inst.statusPath || '/__keepalive/api/status';
    const waitMs = Number.isFinite(Number(opts.waitMs)) ? Number(opts.waitMs) : 10000;
    let killed = 0;

    if (opts.force) {
        killed = killPortListeners(port);
    } else {
        const alive = await portAnswers(port, statusPath);
        if (alive) return { ok: true, already: true, name: inst.name, port, status: alive };
        if (!(await portIsFree(port))) {
            // Порт занят, но /status молчит — это зомби, а не рабочий прокси.
            killed = killPortListeners(port);
            logLine(`keepalive ${inst.name} :${port}: порт занят, но /status молчит — снят зомби (убито ${killed})`);
        }
    }
    // Порт освобождается не мгновенно — иначе spawn увидит занятый порт и молча выйдет.
    for (let i = 0; i < 20 && killed; i += 1) {
        if (await portIsFree(port)) break;
        await napMs(100);
    }
    const sp = await inst.spawn();
    if (!sp.ok) return { ok: false, error: sp.error || 'spawn failed', killed, name: inst.name, port };

    const deadline = Date.now() + waitMs;
    for (;;) {
        const status = await portAnswers(port, statusPath, 1);
        if (status) {
            logLine(`keepalive ${inst.name} :${port} поднят (убито ${killed}, pid ${sp.pid || '?'})`);
            return { ok: true, name: inst.name, port, killed, pid: sp.pid || null, status };
        }
        if (Date.now() >= deadline) break;
        await napMs(250);
    }
    const secs = Math.round(waitMs / 1000);
    logLine(`keepalive ${inst.name} :${port} НЕ ответил за ${secs}с после спавна`);
    return { ok: false, error: `спавн прошёл, но :${port} не ответил за ${secs}с`, killed, pid: sp.pid || null, name: inst.name, port };
}

// Кнопка «🔄 перезапустить» в Health: пересоздать процесс безусловно.
const keepaliveRestart = (port) => keepaliveBring(port, { force: true });

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

// Порт, куда реально смотрит Claude Code: с включённым front-door это upstream из
// active-backend.json, иначе ANTHROPIC_BASE_URL. 0 = удалённый шлюз или официальный
// Claude. Вынесено отдельно, потому что то же число решает, кого на boot ПЕРЕСОЗДАТЬ,
// а кого просто снять.
function activeBackendPort() {
    let base = '';
    try { base = (readSettings().env || {}).ANTHROPIC_BASE_URL || ''; } catch { return 0; }
    let target = base;
    if (isFrontdoorBase(base)) {
        const st = readActiveBackend();
        target = (st && st.upstream) ? String(st.upstream) : '';
    }
    const m = target.match(LOOPBACK_PORT_RE);
    return m ? Number(m[1]) : 0;
}

async function bootSpawnActiveBackend() {
    const port = activeBackendPort();
    if (!port) return;                                // удалённый шлюз или официальный Claude
    if (port === frontdoorPort()) return;             // его спавнит frontdoorSpawn()
    const inst = keepaliveInstances()[port];
    if (!inst) return;                                // конвертеры/omniroute живут своей жизнью
    // force: рестарт дашборда обязан означать рестарт стека. Без force живой процесс
    // прошлого запуска читался как «уже поднято», оставался на СТАРОМ коде, и человек
    // после обновления добивал его руками — «нажимаю перезагрузить, а перезагружается
    // не всё» (21.08). Секунда простоя здесь и так есть: bat гасит front-door и :20133.
    const r = await keepaliveBring(port, { force: true });
    if (!r.ok) logLine(`boot: keepalive активного бэкенда ${inst.name} :${port} НЕ поднялся: ${r.error || '?'}`);
    else logLine(`boot: пересоздал keepalive активного бэкенда ${inst.name} :${port} (pid ${r.pid || '?'})`);
    return r;
}

// Снять детей ПРОШЛОГО запуска, которых на boot никто не поднимает обратно.
//
// Они не умирают вместе с дашбордом (detached) и остаются на старом коде: рестарт
// дашборда их не касался вовсе. Именно так `:20155`/`:20156` переживали обновление и
// не получали ни фиксов, ни новых ручек — снаружи это выглядит как «перезагрузил, а
// не помогло». Спавнить их обратно не нужно: активация провайдера поднимет свежий
// процесс сама, а лежащий порт неактивного провайдера — покой, не поломка.
async function bootSweepStaleChildren() {
    const active = activeBackendPort();
    const keep = new Set([AR_KEEPALIVE_PORT, frontdoorPort(), active]);   // эти пересоздаём отдельно
    const swept = [];
    for (const [p, inst] of Object.entries(keepaliveInstances())) {
        const port = Number(p);
        if (keep.has(port)) continue;
        if (await portIsFree(port)) continue;
        const killed = killPortListeners(port);
        if (killed) swept.push(`${inst.name} :${port}`);
    }
    // Конвертеры Custom-провайдеров (20150–20250) — тот же расклад, но АКТИВНЫЙ не
    // трогаем ни в каком случае: на boot его никто не поднимает обратно, и снять его
    // значило бы оставить Claude Code вообще без бэкенда.
    try {
        for (const prov of customLoad().providers) {
            const port = Number(prov.proxyPort);
            if (!port || port === active || keep.has(port)) continue;
            if (await portIsFree(port)) continue;
            const killed = killPortListeners(port);
            if (killed) swept.push(`конвертер ${prov.name || prov.id} :${port}`);
        }
    } catch (e) { logLine(`boot sweep: конвертеры пропущены — ${e.message}`); }
    if (swept.length) logLine(`boot: снял процессы прошлого запуска (обратно поднимет активация): ${swept.join(', ')}`);
    return swept;
}

// Активный бэкенд — конвертер Custom-провайдера. Его на boot не поднимал никто: он
// просто доживал с прошлого запуска, а значит и на старом коде. Пересоздаём, но строго
// НА ТОМ ЖЕ порту: `customSpawnProxy` при занятом порте молча выбирает другой, а на
// старый смотрят settings.json / active-backend.json — переезд оставил бы Claude Code
// без бэкенда. Поэтому сначала убиваем держателя и ждём, пока порт отпустят.
async function bootRecreateActiveCustomProxy() {
    const port = activeBackendPort();
    if (!port || keepaliveInstances()[port]) return null;   // не custom — не наша ветка
    let prov = null;
    try { prov = customLoad().providers.find(p => Number(p.proxyPort) === port) || null; } catch { }
    if (!prov) return null;                                 // чужой порт (omniroute и пр.)
    const killed = killPortListeners(port);
    for (let i = 0; i < 20 && killed; i += 1) {
        if (await portIsFree(port)) break;
        await napMs(100);
    }
    const r = await customSpawnProxy(prov);
    const label = prov.name || prov.id;
    if (!r.ok) logLine(`boot: конвертер активного провайдера ${label} :${port} НЕ поднялся: ${r.error || '?'}`);
    else if (Number(r.port) !== port) logLine(`boot: конвертер ${label} уехал :${port} → :${r.port} — порт не освободился, Claude Code смотрит в пустоту`);
    else logLine(`boot: пересоздал конвертер активного провайдера ${label} :${port} (pid ${r.pid || '?'})`);
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

function tbApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { provider: 'tabitoken' }); }

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
        proc.on('exit', (code, sig) => {
            tbLkPids.delete(label);
            logLine(`tabi session/open: ${label} — exited (code ${code}, sig ${sig})`);
            // Замок с куки снят — точный баланс стал читаемым (см. newapiRecheckAfterLk).
            newapiRecheckAfterLk('tb', id);
        });
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
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = tbLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'tb_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        const link = ghLinkForNew(body, mail, nick);
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
            ...(link.ghId ? { ghId: link.ghId } : {}),
        });
        tbSave(sessions);
        logLine(`tabi add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`
            + (link.how ? ` · ${link.how}` : ''));
        jsonRes(res, 200, { ok: true, id, noKey, ghId: link.ghId || null });
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
        const tbKa = await keepaliveBring(TB_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!tbKa.ok) logLine(`tabi activate: keepalive :${TB_KEEPALIVE_PORT} НЕ поднялся — ${tbKa.error || '?'}`);
        logLine(`tabi activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${TB_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, keepalive: { up: tbKa.ok, port: TB_KEEPALIVE_PORT, error: tbKa.ok ? null : (tbKa.error || null) } });
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
        const tbKaM = await keepaliveBring(TB_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!tbKaM.ok) logLine(`tabi set-model: keepalive :${TB_KEEPALIVE_PORT} НЕ поднялся — ${tbKaM.error || '?'}`);
        logLine(`tabi set-model: ${m} (base ${TB_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: TB_ACTIVE_MODEL_FILE, base: TB_KEEPALIVE_URL, needRestart: true, keepalive: { up: tbKaM.ok, port: TB_KEEPALIVE_PORT, error: tbKaM.ok ? null : (tbKaM.error || null) } });
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
        watchChildExit(child, 'keepalive XPeach', XP_KEEPALIVE_PORT);
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

function xpApplyBalance(target, bal) { return newapiApplyBalance(target, bal, { provider: 'xpeach' }); }

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
        proc.on('exit', (code, sig) => {
            xpLkPids.delete(label);
            logLine(`xpeach session/open: ${label} — exited (code ${code}, sig ${sig})`);
            // Замок с куки снят — точный баланс стал читаемым (см. newapiRecheckAfterLk).
            newapiRecheckAfterLk('xp', id);
        });
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
        const body = await readJsonBody(req);
        const { email, api_key, name } = body;
        const mail = String(email || '').trim();
        if (!mail) return jsonRes(res, 400, { error: 'email обязателен' });
        // Ключ можно не давать: свежий аккаунт получит его только после регистрации.
        const key = String(api_key || '').trim() || makeNoKeyStub();
        const noKey = !isRealKey(key);
        const sessions = xpLoad();
        if (!noKey && sessions.some(s => s.api_key === key)) return jsonRes(res, 400, { error: 'такой ключ уже есть' });
        const id = 'xp_' + Date.now() + '_' + sessions.length;
        const nick = String(name || '').trim() || mail.split('@')[0];
        const link = ghLinkForNew(body, mail, nick);
        sessions.push({
            id,
            email: mail,
            name: nick,
            api_key: key,
            active: false,
            status: noKey ? 'no_key' : 'unknown',
            created: new Date().toISOString(),
            ...(link.ghId ? { ghId: link.ghId } : {}),
        });
        xpSave(sessions);
        logLine(`xpeach add: ${mail} (${noKey ? 'без ключа — регистрация по рефке' : '***' + key.slice(-6)})`
            + (link.how ? ` · ${link.how}` : ''));
        jsonRes(res, 200, { ok: true, id, noKey, ghId: link.ghId || null });
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
        const xpKa = await keepaliveBring(XP_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!xpKa.ok) logLine(`xpeach activate: keepalive :${XP_KEEPALIVE_PORT} НЕ поднялся — ${xpKa.error || '?'}`);
        logLine(`xpeach activate: ${target.email} → ***${key.slice(-6)} (token dummy, base ${XP_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, email: target.email, mask: '***' + key.slice(-6), settingsUpdated: settingsOk, keepalive: { up: xpKa.ok, port: XP_KEEPALIVE_PORT, error: xpKa.ok ? null : (xpKa.error || null) } });
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
        const xpKaM = await keepaliveBring(XP_KEEPALIVE_PORT, { waitMs: 8000 });
        if (!xpKaM.ok) logLine(`xpeach set-model: keepalive :${XP_KEEPALIVE_PORT} НЕ поднялся — ${xpKaM.error || '?'}`);
        logLine(`xpeach set-model: ${m} (base ${XP_KEEPALIVE_URL})`);
        jsonRes(res, 200, { ok: true, model: m, settingsModel, settingsUpdated: settingsOk, modelFile: XP_ACTIVE_MODEL_FILE, base: XP_KEEPALIVE_URL, needRestart: true, keepalive: { up: xpKaM.ok, port: XP_KEEPALIVE_PORT, error: xpKaM.ok ? null : (xpKaM.error || null) } });
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

// ───── Авторотация денежных шлюзов: «нет баланса» → следующий аккаунт ─────
//
// Проблема. Шлюз отказывает по деньгам ПОСРЕДИ работы: `403 Insufficient account
// balance` или его китайский вариант `预扣费额度失败, 用户剩余额度: $0.309854,
// 需要预扣费额度: $0.800000` (New-API берёт предоплату под запрос). До этой ротации
// оба текста доезжали до Claude Code и роняли задачу — при том, что в пуле лежали
// живые деньги (замер 22.08: активный gorouter-аккаунт −$0.16, пул $2006 на 25 ключах).
//
// Решение. Активный ключ живёт в файле (`~/.claude/<prov>-active-key.txt`), и
// keepalive-proxy перечитывает его НА КАЖДУЮ попытку. Значит подмена аккаунта — это
// перезапись одного файла: ни прокси, ни Claude Code, ни терминалы Orca не
// перезапускаются. Ловит отказ сам прокси (он единственный видит тело ошибки) и
// зовёт сюда `POST /__switch/api/<p>/rotate`, после чего повторяет запрос.
//
// Почему решение здесь, а не в прокси: пулами, балансами и файлами активного ключа
// владеет дашборд. Второй писатель `<prov>-sessions.json` означал бы гонку с
// балансовыми батчами (ровно та, из-за которой появился `arSaveMerge`).
//
// Порога по балансу СОЗНАТЕЛЬНО нет (решение владельца 22.08): цифра в кеше
// обновляется раз в минуту-две и врёт чаще, чем помогает. Правда — это отказ шлюза.

// Один реестр на пять шлюзов. Добавление шестого = одна строка здесь; клиентский
// MONEY_PROVIDERS (proxy-dashboard.html) — зеркало по префиксу. Держать две
// разъезжающиеся карты уже пробовали, см. комментарий к MONEY_PROVIDERS.
// host — тем же значением keepalive-прокси узнаёт, в какой префикс ему звонить
// (GW_BY_HOST в keepalive-proxy.js), поэтому строки обязаны совпадать буквально.
const MONEY_GW = {
    ar: { tag: 'agentrouter', label: 'AgentRouter', host: 'agentrouter.org', keyFile: AR_ACTIVE_KEY_FILE, load: arLoad, save: arSave, balanceFn: arBalance, applyFn: arApplyBalance },
    go: { tag: 'gorouter',    label: 'GoRouter',    host: 'gorouter.app',   keyFile: GO_ACTIVE_KEY_FILE, load: goLoad, save: goSave, balanceFn: goBalance, applyFn: goApplyBalance },
    tb: { tag: 'tabi',        label: 'Tabi Token',  host: 'tabitoken.com',  keyFile: TB_ACTIVE_KEY_FILE, load: tbLoad, save: tbSave, balanceFn: tbBalance, applyFn: tbApplyBalance },
    xp: { tag: 'xpeach',      label: 'XPeach',      host: 'xpeach.codes',   keyFile: XP_ACTIVE_KEY_FILE, load: xpLoad, save: xpSave, balanceFn: xpBalance, applyFn: xpApplyBalance },
    // 🪤 host здесь — `api.justwoker.icu` целиком: у JustWoker API и панель на одном
    // поддомене, и ровно эту строку keepalive-proxy ищет в GW_BY_HOST по Host апстрима.
    jw: { tag: 'justwoker',   label: 'JustWoker',   host: 'api.justwoker.icu', keyFile: JW_ACTIVE_KEY_FILE, load: jwLoad, save: jwSave, balanceFn: jwBalance, applyFn: jwApplyBalance },
    sk: { tag: 'seekai',      label: 'SeekAi',      host: 'seekai.cc',      keyFile: SK_ACTIVE_KEY_FILE, load: skLoad, save: skSave, balanceFn: skBalance, applyFn: skApplyBalance },
    // 🪤 TrueSOTA — единственный в реестре НЕ New-API (это sub2api): баланс считает
    // routing/lib/truesota-account.js, а не newapiBalance. Для реестра это неважно —
    // ему нужны только load/save/balanceFn/applyFn одинаковой формы, — но помнить надо:
    // «почини как у остальных» тут не сработает.
    ts: { tag: 'truesota',    label: 'TrueSOTA',    host: 'true-sota.com',  keyFile: TS_ACTIVE_KEY_FILE, load: tsLoad, save: tsSave, balanceFn: tsBalance, applyFn: tsApplyBalance },
    // 🪤 У kktoken host — сам домен: панель и API на одном `kktoken.cc`. Эту же строку
    // keepalive-proxy ищет в GW_BY_HOST по Host апстрима, поэтому байт в байт.
    kk: { tag: 'kktoken',     label: 'KKtoken',     host: 'kktoken.cc',     keyFile: KK_ACTIVE_KEY_FILE, load: kkLoad, save: kkSave, balanceFn: kkBalance, applyFn: kkApplyBalance },
    // 🪤 У hcnsec host — ХОСТ ПАНЕЛИ целиком, `api.hcnsec.cn` (поддомен обязателен).
    // Эту же строку keepalive-proxy ищет в GW_BY_HOST по Host апстрима — байт в байт.
    hn: { tag: 'hcnsec',      label: 'HCNsec',      host: 'api.hcnsec.cn', keyFile: HN_ACTIVE_KEY_FILE, load: hnLoad, save: hnSave, balanceFn: hnBalance, applyFn: hnApplyBalance },
};

const MONEY_AUTO_FILE = path.join(__dirname, '..', 'logs', '.money_autorotate.json');
// Минимум, ниже которого аккаунт бесполезен даже как «самый маленький»: у New-API
// предоплата под запрос — в пойманной ошибке $0.80, у длинного запроса больше.
// Кандидат дешевле этого не берётся, пока в тексте отказа не сказано точное «нужно».
// 🪤 Поднято 1.0 → 2.0 (31.08, решение владельца: «$1 порог, и автопереключение иногда
// не срабатывает, надо хотя бы $2»). Причина не в самой планке, а в её запасе: при
// пороге $1 ротация уходила на аккаунт с $1.05, тот умирал на следующем же запросе —
// и человек видел не «переключилось», а «переключается и всё равно не работает».
// $2 при предоплате $0.80 даёт запас на два-три запроса, то есть подмена держится.
// Обратная сторона честная: аккаунты с $1–2 объявляются негодными раньше, чем
// доедены. На плоском тарифе (~50¢ за запрос) это 2–4 потерянных запроса на аккаунт;
// владелец выбрал устойчивость подмены, а не выскабливание огрызков.
const MONEY_MIN_BAL = 2.0;
// Сколько кандидатов проверяем живым чеком за одну ротацию. Чек ~1.5с, а на другом
// конце ждёт запрос Claude Code — обход всего пула превратился бы в таймаут.
const MONEY_MAX_PROBES = 3;
// Окно дедупа: Orca держит несколько сессий на одном ключе, и пять параллельных
// запросов ловят один и тот же отказ. Ротация от второго-пятого не нужна — им
// достаточно узнать, что ключ уже сменился.
const MONEY_DEDUP_MS = 10_000;

const moneyAuto = {};   // p → { rotating (Promise|null), lastAt, lastKey, recent[] }
// Тумблер авторотации — ОДИН на все пять шлюзов (2026-08-22, по замечанию владельца).
// Был по шлюзу, и смена провайдера читалась как «авторотация выключилась»: сидел на
// GoRouter с включённым тумблером, перешёл на Tabi — у того свой флаг, по умолчанию
// выключённый, и следующий отказ по деньгам снова прилетал в лицо. Смысл у настройки
// один на всех («не умирать на кончившемся аккаунте»), поэтому и хранилище одно.
// Что осталось по шлюзу — журнал подмен, мьютекс и дедуп: это состояние работы, а не выбор.
const moneyAutoShared = { enabled: false };
function moneyState(p) {
    if (!moneyAuto[p]) {
        const st = { rotating: null, lastAt: 0, lastKey: null, recent: [] };
        // `enabled` — не поле, а окно в общий тумблер: все места читают и пишут его как
        // раньше (`moneyState(p).enabled`), но хранится он в одном месте. Иначе пришлось
        // бы держать два источника правды и следить, чтобы они не разъехались.
        Object.defineProperty(st, 'enabled', {
            get: () => moneyAutoShared.enabled,
            set: (v) => { moneyAutoShared.enabled = !!v; },
            enumerable: true,
        });
        moneyAuto[p] = st;
    }
    return moneyAuto[p];
}
function moneySavePersist() {
    try {
        const dir = path.dirname(MONEY_AUTO_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(MONEY_AUTO_FILE, JSON.stringify({ enabled: !!moneyAutoShared.enabled }, null, 2) + '\n', 'utf-8');
    } catch (e) { logLine(`money auto persist: ${e.message}`); }
}
function moneyLoadPersist() {
    try {
        if (!fs.existsSync(MONEY_AUTO_FILE)) return;
        const j = JSON.parse(fs.readFileSync(MONEY_AUTO_FILE, 'utf-8'));
        // Новый формат — один флаг `{enabled}`. Старый — по шлюзу `{go:{enabled}}`, и
        // тогда «включён хоть у одного» = включён: иначе владелец, у которого тумблер
        // стоял на GoRouter, после этого обновления нашёл бы его выключенным.
        moneyAutoShared.enabled = typeof (j || {}).enabled === 'boolean'
            ? !!j.enabled
            : Object.keys(MONEY_GW).some(p => j && j[p] && j[p].enabled);
        if (moneyAutoShared.enabled) logLine('money auto: восстановлено включённым (тумблер общий на все шлюзы)');
    } catch (e) { logLine(`money auto restore: ${e.message}`); }
}

// Деньги на мёртвом/безключевом аккаунте — не деньги: забрать нельзя (тот же
// предикат, что balanceUsable во фронте). Кандидат обязан иметь настоящий ключ.
function moneyUsable(s) {
    return !!s && isRealKey(s.api_key) && typeof s.balance === 'number'
        && s.status !== 'dead' && s.status !== 'no_key' && !s.banned;
}
// Порядок кандидатов: «самый маленький, которому хватает» (доедаем огрызки, жирные
// аккаунты держим в резерве — решение владельца). need — сколько шлюз запросил
// предоплатой; планка = максимум из него и MONEY_MIN_BAL.
//
// 🪤 Хвост «остальные по убыванию как последний шанс» убран 31.08. Он выглядел страховкой
// от врущего кеша, а на деле был достижим ТОЛЬКО за лимитом живых проверок
// (MONEY_MAX_PROBES) — то есть ровно там, где цифру никто не подтверждал. Разбор на Tabi:
// в пуле 32 аккаунта по $0.59–0.77 при предоплате $0.80, три кандидата проверены живьём и
// отвергнуты, а четвёртым ротация молча взяла **$0.59** и получила тот же отказ; через пять
// ротаций он уехал клиенту (`用户剩余额度: ＄0.596928` в его тексте — этот самый аккаунт).
// Ставка на «кеш врёт в минус» без проверки — не страховка, а трата ротации и времени
// человека. Кеш трёх самых вероятных кандидатов и так обновляется живым чеком; если после
// этого не годится никто, честный ответ — `pool-dry`, чтобы владелец увидел «пополни».
function moneyRank(list, need) {
    const bar = Math.max(MONEY_MIN_BAL, Number(need) || 0);
    return list.filter(s => s.balance >= bar).sort((a, b) => a.balance - b.balance);
}

// Переключение активного аккаунта = ровно два действия, как в handleGoActivate:
// файл активного ключа + флаг active в пуле. settings.json / active-backend.json /
// модель / keepalive НЕ трогаем: шлюз тот же, база уже смотрит на его прокси, а
// <prov>-active-model.txt один на шлюз. Лишняя правка settings.json здесь означала
// бы бэкап и запись на каждый отказ по балансу.
function moneySwitchKey(p, sessions, key) {
    const gw = MONEY_GW[p];
    fs.writeFileSync(gw.keyFile, key, { encoding: 'utf-8', flag: 'w' });
    sessions.forEach(s => { s.active = s.api_key === key; });
    gw.save(sessions);
}

// Ротация. reason: 'out-of-balance' | 'dead' | 'zero-cache' | 'manual'.
// fromKey — ключ, на котором звонивший получил отказ (нужен для дедупа).
// needUsd — «需要预扣费额度» из текста ошибки, если шлюз его назвал.
// leftUsd — «用户剩余额度» оттуда же: бесплатное уточнение кеша баланса, точнее
// анкера и угадывания, и достаётся без запроса в биллинг.
async function moneyRotate(p, opts = {}) {
    const gw = MONEY_GW[p];
    if (!gw) return { ok: false, error: `unknown provider ${p}` };
    const st = moneyState(p);
    // Ротация уже идёт — ждём её и отвечаем её результатом. Иначе пять параллельных
    // отказов Orca прокрутят пять аккаунтов подряд и высадят пул за секунду.
    if (st.rotating) {
        try { return await st.rotating; } catch (e) { return { ok: false, error: e.message }; }
    }
    const cur = (() => { try { return fs.readFileSync(gw.keyFile, 'utf8').trim(); } catch { return ''; } })();
    // Только что ротировали, и ключ уже НЕ тот, на котором звонивший получил отказ:
    // ему достаточно повторить запрос.
    if (opts.fromKey && cur && cur !== opts.fromKey && Date.now() - st.lastAt < MONEY_DEDUP_MS) {
        return { ok: true, already: true, mask: '***' + cur.slice(-6) };
    }
    const run = (async () => {
        const sessions = gw.load();
        const from = sessions.find(s => s.api_key === (opts.fromKey || cur));
        // Метим ушедший аккаунт ДО поиска замены: иначе он же попадёт в кандидаты.
        if (from) {
            if (opts.reason === 'dead') from.status = 'dead';
            const left = Number(opts.leftUsd);
            if (Number.isFinite(left)) { from.balance = round2(left); from.balanceSource = 'gateway'; from.balanceCheckedAt = new Date().toISOString(); }
            else if (opts.reason === 'out-of-balance' && typeof from.balance === 'number' && from.balance > 0) from.balance = 0;
        }
        const need = Number(opts.needUsd) || 0;
        const queue = moneyRank(sessions.filter(s => moneyUsable(s) && s.api_key !== cur && s.api_key !== opts.fromKey), need);
        if (!queue.length) {
            gw.save(sessions);
            logLine(`money auto ${p}: замены нет — в пуле ни одного живого аккаунта с балансом`);
            return { ok: false, error: 'pool-dry' };
        }
        let probes = 0;
        for (const cand of queue) {
            // Кеш баланса бывает двухдневным (обновляется только активный ключ),
            // поэтому выбранного кандидата подтверждаем живой цифрой. Как fmAuto.
            if (probes < MONEY_MAX_PROBES) {
                probes++;
                try {
                    const bal = await gw.balanceFn(cand, { force: true });
                    gw.applyFn(cand, bal);
                } catch (e) { logLine(`money auto ${p}: чек ${cand.email || cand.name} не прошёл (${e.message}) — беру по кешу`); }
                if (!moneyUsable(cand) || cand.balance < Math.max(MONEY_MIN_BAL, need)) {
                    logLine(`money auto ${p}: ${cand.email || cand.name} на самом деле $${typeof cand.balance === 'number' ? cand.balance.toFixed(2) : '—'}${need ? ` (нужно $${need.toFixed(2)})` : ''} — следующий`);
                    continue;
                }
            }
            moneySwitchKey(p, sessions, cand.api_key);
            st.lastAt = Date.now();
            st.lastKey = cand.api_key;
            st.recent.unshift({
                ts: Date.now(), reason: opts.reason || 'manual',
                from: from ? (from.email || from.name || '') : '',
                to: cand.email || cand.name || '', balance: cand.balance,
                needUsd: need || null,
            });
            st.recent = st.recent.slice(0, 20);
            logLine(`money auto ${p}: ${opts.reason || 'manual'} → ${cand.email || cand.name} ($${cand.balance.toFixed(2)}, ***${cand.api_key.slice(-6)})${need ? `, шлюз просил $${need.toFixed(2)}` : ''}`);
            return { ok: true, email: cand.email || cand.name, mask: '***' + cand.api_key.slice(-6), balance: cand.balance };
        }
        gw.save(sessions);
        logLine(`money auto ${p}: проверено ${probes} кандидатов, ни у кого нет ${need ? `$${need.toFixed(2)}` : `$${MONEY_MIN_BAL.toFixed(2)}`}`);
        return { ok: false, error: 'pool-dry' };
    })();
    st.rotating = run;
    try { return await run; }
    finally { if (st.rotating === run) st.rotating = null; }
}

// Внеочередной кик по свежей цифре баланса. Зовётся из newapiApplyBalance: чек
// активного ключа и так идёт раз в минуту (nudge из дашборда и статусбар), поэтому
// новых запросов в биллинг это не добавляет — только реагирует на уже полученный
// ноль, не дожидаясь, пока на нём споткнётся живой запрос.
function moneyKickOnZero(providerTag, target) {
    try {
        const p = Object.keys(MONEY_GW).find(k => MONEY_GW[k].tag === providerTag);
        if (!p || !target || !target.active || !moneyState(p).enabled) return;
        if (!(typeof target.balance === 'number') || target.balance > 0) return;
        if (!isRealKey(target.api_key)) return;
        logLine(`money auto ${p}: у активного ${target.email || target.name} $${target.balance.toFixed(2)} по свежему чеку — подменяю не дожидаясь отказа`);
        moneyRotate(p, { reason: 'zero-cache', fromKey: target.api_key })
            .catch(e => logLine(`money auto ${p} kick: ${e.message}`));
    } catch (e) { logLine(`money auto kick: ${e.message}`); }
}

function moneyAutoStatus(p) {
    const st = moneyState(p);
    const gw = MONEY_GW[p];
    let active = null;
    try {
        const key = fs.readFileSync(gw.keyFile, 'utf8').trim();
        const rec = key ? gw.load().find(s => s.api_key === key) : null;
        if (rec) active = { email: rec.email || rec.name || '', balance: typeof rec.balance === 'number' ? rec.balance : null };
    } catch {}
    const pool = gw.load().filter(moneyUsable);
    return {
        provider: p, label: gw.label, enabled: st.enabled,
        // Признак «тумблер общий на все шлюзы». Нужен фронту, чтобы отличить этот
        // бэкенд от старого процесса :8200, где флаг был по шлюзу: HTML читается с
        // диска на каждый запрос и обновляется по F5, а бэкенд — только рестартом.
        // Без признака новый фронт в паре со старым бэкендом показывал бы «включено»
        // на шлюзе, где включено не было.
        shared: true,
        lastSwitch: st.lastAt, rotating: !!st.rotating,
        active, minBal: MONEY_MIN_BAL,
        poolReady: pool.filter(s => s.balance >= MONEY_MIN_BAL).length,
        poolBalance: round2(pool.reduce((a, s) => a + Math.max(0, s.balance), 0)),
        recent: st.recent,
    };
}

// POST /__switch/api/<p>/rotate — звонок keepalive-прокси, поймавшего отказ.
// Тумблер выключен → ротации нет, и звонивший обязан отдать ошибку клиенту:
// «нет баланса» иногда решается человеком (пополнить), а не подменой.
async function handleMoneyRotate(req, res, p) {
    try {
        const body = await readJsonBody(req).catch(() => ({}));
        const reason = String(body.reason || 'manual');
        if (reason !== 'manual' && !moneyState(p).enabled) {
            return jsonRes(res, 200, { ok: false, error: 'disabled' });
        }
        const r = await moneyRotate(p, {
            reason,
            fromKey: String(body.fromKey || '').trim() || null,
            needUsd: body.needUsd,
            leftUsd: body.leftUsd,
        });
        jsonRes(res, 200, r);
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
}
async function handleMoneyAuto(req, res, p, action) {
    try {
        // Тумблер общий: `start` на вкладке GoRouter включает авторотацию и для Tabi с
        // AgentRouter. Префикс в пути остался, потому что ответом уходит статус ЭТОГО
        // шлюза (пул, журнал, активный аккаунт) — а он по-прежнему свой у каждого.
        if (action === 'start') { moneyAutoShared.enabled = true;  moneySavePersist(); logLine(`money auto: ВКЛ (все шлюзы, включено с ${p})`); }
        if (action === 'stop')  { moneyAutoShared.enabled = false; moneySavePersist(); logLine(`money auto: выкл (все шлюзы, выключено с ${p})`); }
        jsonRes(res, 200, moneyAutoStatus(p));
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
        if (enabled) {
            // Не голый спавн: занятый зомби-порт он считал живым прокси, а включённый
            // тумблер с мёртвым :20100 = Claude Code вообще без бэкенда.
            const fd = await keepaliveBring(frontdoorPort(), { waitMs: 8000 });
            if (!fd.ok) logLine(`front-door: тумблер ON, но :${port} НЕ поднялся — ${fd.error || '?'}`);
        }
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
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const limit = parseInt(q.get('limit') || '200', 10);
        // `src` разделяет то, что раньше валилось в одну трубу: строки самого дашборда и
        // строки прокси, приходящие через /logs/ingest с префиксом `[имя]`. Keepalive
        // логирует КАЖДЫЙ ping, поэтому в общем кольце (400 строк) он за секунды съедал
        // всё остальное — разобрать прогон чек-ина было физически нечем (25.08).
        //   all (по умолчанию) — как раньше; dash — только дашборд; <имя> — только этот прокси.
        const src = String(q.get('src') || 'all');
        const tags = {};
        for (const l of LOG_BUFFER) {
            const m = INGEST_TAG_RE.exec(l);
            const k = m ? m[1] : 'dash';
            tags[k] = (tags[k] || 0) + 1;
        }
        const pick = src === 'all' ? LOG_BUFFER
            : src === 'dash' ? LOG_BUFFER.filter(l => !INGEST_TAG_RE.test(l))
            : LOG_BUFFER.filter(l => { const m = INGEST_TAG_RE.exec(l); return !!m && m[1] === src; });
        return jsonRes(res, 200, { lines: pick.slice(-Math.max(1, limit)), tags, src });
    }

    // Прогоны автоподарка/чек-ина: каждый пишет свой файл в logs/ (см. RUN_LOG в
    // agentrouter/open-session.js). Отдельная труба нужна именно потому, что общее кольцо
    // затапливает keepalive: файл переживает и это, и рестарт `:8200`.
    //   без параметров → список прогонов (новые сверху); ?file=<имя> → хвост строк.
    if (req.method === 'GET' && req.url.startsWith('/__switch/api/ar/checkin-logs')) {
        const q = new URL(req.url, `http://localhost:${LISTEN_PORT}`).searchParams;
        const dir = path.join(__dirname, '..', 'logs');
        const file = q.get('file');
        try {
            if (file) {
                // Только имя файла нужного вида — никаких путей: параметр приходит из
                // браузера, и `..\..\settings.json` тут был бы дырой на чтение чего угодно.
                if (!CHECKIN_LOG_RE.test(file)) return jsonRes(res, 400, { error: 'имя файла не похоже на лог прогона' });
                const p = path.join(dir, file);
                if (!fs.existsSync(p)) return jsonRes(res, 404, { error: 'файл не найден' });
                const limit = parseInt(q.get('limit') || '400', 10);
                const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
                return jsonRes(res, 200, { name: file, lines: lines.slice(-Math.max(1, limit)) });
            }
            const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
                .filter(n => CHECKIN_LOG_RE.test(n))
                .map(n => {
                    const st = fs.statSync(path.join(dir, n));
                    const m = /^ar-checkin-(.+)-(\d{4}-\d{2}-\d{2}T[\d-]+)\.log$/.exec(n);
                    return { name: n, label: m ? m[1] : n, at: st.mtimeMs, size: st.size };
                })
                .sort((a, b) => b.at - a.at)
                .slice(0, 30);
            return jsonRes(res, 200, { files });
        } catch (e) { return jsonRes(res, 500, { error: e.message }); }
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
    // (:20133/:20155/:20156/:20157/:20158) одной операцией: kill по порту → spawn с env
    // этого инстанса → ждём /__keepalive/api/status. Так подхватывается новый код прокси.
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
    //
    // {stash:true} в теле → правки кода не блокируют обновление, а уходят в git stash.
    // Раньше это умел только update.sh, и кнопка в дашборде оказывалась глупее батника:
    // отдавала сырую ошибку git и запирала человека (21.08). Второй заход делается
    // ТОЛЬКО по подтверждению из UI: спрятать чужие правки молча — сюрприз, пусть и
    // обратимый.
    if (req.method === 'POST' && req.url === '/__switch/api/dashboard/update-pull') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                let wantStash = false;
                try { wantStash = !!(JSON.parse(body || '{}').stash); } catch { }
                const { pullSafe } = require('../tools/git-pull-safe');
                const r = pullSafe({ stashBlocking: wantStash });
                if (!r.ok && r.blocking.length) {
                    return jsonRes(res, 409, {
                        error: 'Обновлению мешает локальное состояние рабочей копии:\n  ' + r.blocking.join('\n  '),
                        dirty: r.blocking,
                        untracked: r.untracked || [],   // из них — новые файлы, не в git
                        can_stash: true,   // UI покажет «спрятать в stash и обновить»
                    });
                }
                if (!r.ok) {
                    if (r.stashed && r.stashed.length) {
                        logLine(`dashboard git pull: pull не прошёл, но правки уже в stash (${r.stashed.join(', ')}) — вернуть: git stash pop`);
                    }
                    if (r.preserved && r.preserved.length) {
                        logLine(`dashboard git pull: pull не прошёл, локальные настройки возвращены на место (${r.preserved.join(', ')})`);
                    }
                    // Разошедшиеся истории кнопкой не лечатся (reset --hard выбросил бы
                    // собственные коммиты) — отдаём готовый текст «что случилось и чем
                    // разрулить» и НЕ предлагаем автопочинку.
                    return jsonRes(res, 500, {
                        error: r.error || 'git pull failed',
                        stashed: r.stashed || [], diverged: !!r.diverged,
                    });
                }
                if (r.preserved.length) logLine(`dashboard git pull: локальные настройки возвращены (${r.preserved.join(', ')})`);
                if (r.stashed && r.stashed.length) logLine(`dashboard git pull: правки кода спрятаны в git stash (${r.stashed.join(', ')}) — вернуть: git stash pop`);
                logLine(`dashboard git pull:\n${r.output}`);
                return jsonRes(res, 200, {
                    ok: true, output: r.output, preserved: r.preserved,
                    stashed: r.stashed || [], stashRef: r.stashRef || '',
                    restart_required: true,
                });
            } catch (e) {
                return jsonRes(res, 500, { error: (e.message || 'git pull failed').toString() });
            }
        });
        return;
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

    // ---- Реф-коды провайдеров (💩 в «Настройках») ----------------------------
    // Отдаём тремя слоями, а не одним значением: UI обязан различать «код владельца
    // из репозитория» и «свой вписанный», иначе пустое поле читалось бы как «рефки нет».
    if (req.method === 'GET' && req.url === '/__switch/api/settings/ref-codes') {
        try {
            const rc = require('./lib/ref-codes.js');
            const urls = {};
            for (const p of rc.PROVIDERS) urls[p] = rc.url(p);
            return jsonRes(res, 200, {
                ok: true,
                // Только живые шлюзы: XPeach легаси, настраивать рефку мёртвого
                // бессмысленно. Резолв (`urls`) при этом полный — его просит
                // xpeach/open-session.js.
                providers: rc.ACTIVE_PROVIDERS,
                shapes: rc.SHAPES,
                defaults: rc.defaults(),
                user: rc.user(),
                effective: rc.effective(),
                urls,
            });
        } catch (e) { return jsonRes(res, 500, { error: e.message }); }
    }
    // POST { <prov>: '<код>' | '' } — пустая строка снимает переопределение и
    // возвращает код владельца. Рестарт `:8200` не нужен: и скрипты, и этот роут
    // читают файл на каждый вызов.
    if (req.method === 'POST' && req.url === '/__switch/api/settings/ref-codes') {
        return (async () => {
            try {
                const rc = require('./lib/ref-codes.js');
                const body = await readJsonBody(req);
                const saved = rc.save(body || {});
                const urls = {};
                for (const p of rc.PROVIDERS) urls[p] = rc.url(p);
                logLine(`реф-коды: сохранено ${Object.keys(saved).length} своих (${Object.entries(saved).map(([k, v]) => k + '=' + v).join(', ') || 'ни одного — везде коды владельца'})`);
                jsonRes(res, 200, { ok: true, user: saved, effective: rc.effective(), urls });
            } catch (e) { jsonRes(res, 500, { error: e.message }); }
        })();
    }

    if (req.method === 'GET' && req.url === '/__switch/api/settings/current') {
        return handleSettingsCurrent(res);
    }

    // Чистый рабочий шаблон для кнопки «Сбросить»: claude-settings.example.json
    // с перенесённым активным ключом/URL из текущего settings.json (чтобы сброс
    // не сбил бэкенд друга). НИЧЕГО не пишет — только отдаёт JSON в редактор.
    if (req.method === 'GET' && req.url === '/__switch/api/settings/clean-template') {
        try {
            const tplPath = path.join(__dirname, '..', 'docs', 'claude-settings.example.json');
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
    if (req.method === 'POST' && req.url === '/__switch/api/go/set-github') return handleGoSetGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/set-github') return handleKkSetGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/set-github') return handleTbSetGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/set-github') return handleXpSetGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/set-github') return handleJwSetGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/set-github') return handleSkSetGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/set-github') return handleTsSetGithub(req, res);
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
    if (req.method === 'GET'  && req.url === '/__switch/api/ar/checkin-status') return handleArCheckinStatus(req, res);

    // История финансов для вкладки «Финансы»: расход и наливка по бакетам.
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/finance/history')) return handleFinanceHistory(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/league/nick')) return jsonRes(res, 405, { error: 'POST' });
    if (req.method === 'POST' && req.url === '/__switch/api/league/nick') return handleLeagueNick(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/league')) return handleLeague(req, res);

    // Keepalive-мост (хедж-конфиг :20133/:20155/:20156/:20157/:20158) — реальное время без рестарта.
    if (req.method === 'GET'  && req.url === '/__switch/api/keepalive/state')  return keepaliveAr.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/keepalive/config') return keepaliveAr.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/tb/keepalive/state')  return keepaliveTb.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/keepalive/config') return keepaliveTb.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/go/keepalive/state')  return keepaliveGo.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/keepalive/config') return keepaliveGo.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/kk/keepalive/state')  return keepaliveKk.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/keepalive/config') return keepaliveKk.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/hn/keepalive/state')  return keepaliveHn.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/keepalive/config') return keepaliveHn.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/xp/keepalive/state')  return keepaliveXp.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/keepalive/config') return keepaliveXp.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/jw/keepalive/state')  return keepaliveJw.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/keepalive/config') return keepaliveJw.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/sk/keepalive/state')  return keepaliveSk.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/keepalive/config') return keepaliveSk.config(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/ts/keepalive/state')  return keepaliveTs.state(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/keepalive/config') return keepaliveTs.config(req, res);
    // История времени ответа (график) — startsWith: у запроса есть ?window=<сек>.
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/keepalive/latency'))    return keepaliveAr.latency(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/tb/keepalive/latency')) return keepaliveTb.latency(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/go/keepalive/latency')) return keepaliveGo.latency(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/kk/keepalive/latency')) return keepaliveKk.latency(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/hn/keepalive/latency')) return keepaliveHn.latency(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/xp/keepalive/latency')) return keepaliveXp.latency(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/jw/keepalive/latency')) return keepaliveJw.latency(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/sk/keepalive/latency')) return keepaliveSk.latency(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ts/keepalive/latency')) return keepaliveTs.latency(req, res);

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
    // ── KKtoken (восьмая вкладка) — те же 22 роута, что у go ───────────────
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/kk/sessions')) return handleKkSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/kk/ping'))     return handleKkPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/kk/balance'))  return handleKkBalance(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/kk/models'))   return handleKkModels(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/kk/active-model') return jsonRes(res, 200, { model: kkReadActiveModel() || null });
    if (req.method === 'GET'  && req.url === '/__switch/api/kk/modelmap') return jsonRes(res, 200, { ok: true, modelMap: kkReadModelMap() });
    if (req.method === 'POST' && req.url === '/__switch/api/kk/add')       return handleKkAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/key')       return handleKkSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/rename')    return handleKkRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/delete')    return handleKkDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/activate')  return handleKkActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/set-model') return handleKkSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/set-balance') return handleKkSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/map-profiles') return handleKkMapProfiles(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/modelmap')  return handleKkModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/session/open') return handleKkSessionOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/share')    return handleKkShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/import')   return handleKkImport(req, res);
    // ── HCNsec (девятая вкладка) — 19 роутов из 22 у go: GitHub-входа у шлюза нет,
    // поэтому map-profiles / set-github / add-github здесь отсутствуют намеренно.
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/hn/sessions')) return handleHnSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/hn/ping'))     return handleHnPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/hn/balance'))  return handleHnBalance(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/hn/models'))   return handleHnModels(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/hn/active-model') return jsonRes(res, 200, { model: hnReadActiveModel() || null });
    if (req.method === 'GET'  && req.url === '/__switch/api/hn/modelmap') return jsonRes(res, 200, { ok: true, modelMap: hnReadModelMap() });
    if (req.method === 'POST' && req.url === '/__switch/api/hn/add')       return handleHnAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/key')       return handleHnSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/rename')    return handleHnRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/delete')    return handleHnDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/activate')  return handleHnActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/set-model') return handleHnSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/set-balance') return handleHnSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/modelmap')  return handleHnModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/session/open') return handleHnSessionOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/share')    return handleHnShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/hn/import')   return handleHnImport(req, res);
    // 🪤 map-profiles у hn ЕСТЬ, хотя GitHub-входа у панели нет: общий обработчик
    // сопоставляет запись с профилем по API-ключу из панели, а GitHub там лишь резерв.
    // Без этой строки регресс ловит «либо все четыре точки, либо ни одной»: хендлер,
    // функция во фронте и кнопка 🔗 существуют, а роута нет — кнопка молча даёт 404.
    if (req.method === 'POST' && req.url === '/__switch/api/hn/map-profiles') return handleHnMapProfiles(req, res);

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

    // ---- JustWoker (jw) — автономная вкладка, keepalive :20158 → api.justwoker.icu ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/jw/sessions')) return handleJwSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/jw/ping'))     return handleJwPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/jw/balance'))  return handleJwBalance(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/jw/models'))   return handleJwModels(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/jw/active-model') return jsonRes(res, 200, { model: jwReadActiveModel() || null });
    if (req.method === 'GET'  && req.url === '/__switch/api/jw/modelmap') return jsonRes(res, 200, { ok: true, modelMap: jwReadModelMap() });
    if (req.method === 'POST' && req.url === '/__switch/api/jw/add')       return handleJwAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/key')       return handleJwSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/rename')    return handleJwRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/delete')    return handleJwDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/activate')  return handleJwActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/set-model') return handleJwSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/set-balance') return handleJwSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/map-profiles') return handleJwMapProfiles(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/modelmap')  return handleJwModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/session/open') return handleJwSessionOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/share')    return handleJwShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/import')   return handleJwImport(req, res);

    // ---- SeekAi (sk) — автономная вкладка, keepalive :20159 → seekai.cc ----
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/sk/sessions')) return handleSkSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/sk/ping'))     return handleSkPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/sk/balance'))  return handleSkBalance(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/sk/models'))   return handleSkModels(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/sk/active-model') return jsonRes(res, 200, { model: skReadActiveModel() || null });
    if (req.method === 'GET'  && req.url === '/__switch/api/sk/modelmap') return jsonRes(res, 200, { ok: true, modelMap: skReadModelMap() });
    if (req.method === 'POST' && req.url === '/__switch/api/sk/add')       return handleSkAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/key')       return handleSkSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/rename')    return handleSkRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/delete')    return handleSkDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/activate')  return handleSkActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/set-model') return handleSkSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/set-balance') return handleSkSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/map-profiles') return handleSkMapProfiles(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/modelmap')  return handleSkModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/session/open') return handleSkSessionOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/share')    return handleSkShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/import')   return handleSkImport(req, res);

    // ---- TrueSOTA (ts) — автономная вкладка, keepalive :20160 → true-sota.com ----
    // Панель sub2api, поэтому две ручки, которых нет у New-API-вкладок:
    //   POST key-create — сама создаёт API-ключ через панель (токен снимается с профиля);
    //   GET  token      — диагностика входа: живой ли токен, что говорит /auth/me.
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ts/sessions')) return handleTsSessions(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ts/ping'))     return handleTsPing(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ts/balance'))  return handleTsBalance(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ts/models'))   return handleTsModels(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ts/token'))    return handleTsToken(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/ts/active-model') return jsonRes(res, 200, { model: tsReadActiveModel() || null });
    if (req.method === 'GET'  && req.url === '/__switch/api/ts/modelmap') return jsonRes(res, 200, { ok: true, modelMap: tsReadModelMap() });
    if (req.method === 'POST' && req.url === '/__switch/api/ts/add')        return handleTsAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/key')        return handleTsSetKey(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/key-create') return handleTsKeyCreate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/rename')     return handleTsRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/delete')     return handleTsDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/activate')   return handleTsActivate(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/set-model')  return handleTsSetModel(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/set-balance') return handleTsSetBalance(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/map-profiles') return handleTsMapProfiles(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/modelmap')   return handleTsModelMap(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/session/open') return handleTsSessionOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/share')      return handleTsShare(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/import')     return handleTsImport(req, res);

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
    if (req.method === 'POST' && req.url === '/__switch/api/gh/star')            return handleGhStar(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/gh/relink')          return handleGhRelink(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/gh/mark')            return handleGhMark(req, res);
    // Заселение готовой GitHub-сессии в новый аккаунт New-API-вкладок (ar/go/tb/xp/jw/sk).
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/gh/available')) return handleGhAvailable(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ar/add-github')       return handleArAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/go/add-github')       return handleGoAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/kk/add-github')       return handleKkAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/tb/add-github')       return handleTbAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/xp/add-github')       return handleXpAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/jw/add-github')       return handleJwAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/sk/add-github')       return handleSkAddGithub(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ts/add-github')       return handleTsAddGithub(req, res);
    // ⚡ Авто-заведение: то же, что 🐙 + 🌐 + 🔑, но без человека. Только у JustWoker —
    // сценарий снят рекордером именно с этой панели, у ar/go/tb вход уезжает в попап.
    if (req.method === 'POST' && req.url === '/__switch/api/jw/auto-add')          return handleJwAutoAdd(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/jw/auto-add/state')    return handleJwAutoAddState(req, res);

    // ---- Outlook-ящики (ol) — пул купленных почт под регистрации ----
    // Парсер пачки живёт на сервере (routing/lib/outlook-pool.js), во фронте его дубля нет.
    if (req.method === 'GET'  && req.url === '/__switch/api/ol/list')            return handleOlList(res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/import')          return handleOlImport(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/add')             return handleOlAdd(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/rename')          return handleOlRename(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/delete')          return handleOlDelete(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/status')          return handleOlStatus(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/mark')            return handleOlMark(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/open')            return handleOlOpen(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/code')            return handleOlCode(req, res);
    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/ol/available')) return handleOlAvailable(req, res);
    if (req.method === 'POST' && req.url === '/__switch/api/ol/health-check')    return handleOlHealthCheck(req, res);
    if (req.method === 'GET'  && req.url === '/__switch/api/ol/health-progress') return handleOlHealthProgress(res);

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

    // ---- Авторотация денежных шлюзов (ar/go/tb/xp/jw/sk): один набор роутов на все шесть ----
    // /rotate зовёт keepalive-прокси, поймавший отказ шлюза по деньгам; /auto/* — тумблер
    // в карточке ACTIVE. Разбор — блок «Авторотация денежных шлюзов» выше.
    {
        const m = /^\/__switch\/api\/(ar|go|tb|xp|jw|sk|ts|kk|hn)\/(rotate|auto\/status|auto\/start|auto\/stop)$/.exec(req.url || '');
        if (m) {
            const [, p, what] = m;
            if (what === 'rotate') {
                if (req.method !== 'POST') return jsonRes(res, 405, { error: 'POST only' });
                handleMoneyRotate(req, res, p);
                return;
            }
            const action = what.slice(5);   // 'status' | 'start' | 'stop'
            if (action === 'status' ? req.method !== 'GET' : req.method !== 'POST') {
                return jsonRes(res, 405, { error: action === 'status' ? 'GET only' : 'POST only' });
            }
            handleMoneyAuto(req, res, p, action);
            return;
        }
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

    // Роут не найден. Под /__switch/api/ отвечаем JSON, а не text/plain: в дашборде
    // ~290 вызовов делают `await res.json()` ДО проверки res.ok, и на текстовом теле
    // все они падают одинаково бесполезно — `Unexpected token 'N', "Not found."…`,
    // то есть жалобой на разбор ответа вместо «такого роута нет».
    //
    // Так это выглядело на маке 24.08. Кнопка «Обновить» тянет код, HTML читается с
    // диска на каждый запрос и с no-store (см. выше) — страница становится новой сразу,
    // без перезапуска. А роуты живут в памяти процесса, и он остаётся старым: новый
    // фронт позвал POST /__switch/api/ar/auto/start, которого в нём ещё нет. На Windows
    // это не всплывает — там рабочая копия и есть источник кода, щели не возникает.
    //
    // Раз причина в JSON, её видно в тосте, а не только в devtools. Сравнение mtime
    // файла со временем старта процесса делает утверждение доказательным: «код новее
    // процесса» — это факт, а не догадка.
    if ((req.url || '').startsWith('/__switch/api/')) {
        const bootedAt = new Date(Date.now() - process.uptime() * 1000);
        let codeAt = null, stale = false;
        try {
            codeAt = fs.statSync(__filename).mtime;
            stale = codeAt > bootedAt;
        } catch { }
        const hm = d => d.toTimeString().slice(0, 5);
        return jsonRes(res, 404, {
            error: `роут не найден: ${req.method} ${req.url}\n`
                + (stale
                    ? `Код на диске правлен в ${hm(codeAt)}, процесс поднят в ${hm(bootedAt)} — работает старый. `
                    : `Процесс поднят в ${hm(bootedAt)}. Если код обновляли позже — работает старый. `)
                + `Перезапустить: ${restartHint()}`,
            not_found: true, stale_process: stale,
        });
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
    console.log(`ABUSE HUB on http://localhost:${LISTEN_PORT}/__switch`);
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

    // AES-ключи профилей — тем же одним процессом, пока никто ничего не просил.
    // Первый чек баланса после рестарта иначе платит секунду на профиль ВНУТРИ
    // обработчика и роняет собственные запросы по таймауту (см. newapiWarmProfileKeys).
    setTimeout(() => {
        try { newapiWarmProfileKeys('старт', true); } catch (e) { logLine(`newapi ключи профилей: ${e.message}`); }
    }, 2500);

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

    // Тумблер авторотации денежных шлюзов — один на все пять. Таймера тут нет —
    // ротация реактивная, по отказу шлюза, поэтому «возобновить» = вспомнить флаг.
    moneyLoadPersist();
    if (moneyAutoShared.enabled) console.log(`  money auto-rotate: on (все шлюзы: ${Object.keys(MONEY_GW).join(', ')})`);

    // Автостарт Grok launcher — чтобы UI-вкладка «Grok Cookie Sessions» работала
    // сразу после запуска дашборда, без ручного `python launcher.py`.
    grokLauncherStart().catch(e => console.log('  Grok launcher start error:', e.message));

    // AgentRouter-прокси (:20132) и keepalive-прокси (:20133) для claude-*/gpt-* через agentrouter.
    // Конвертер тоже пересоздаём (force): он такой же detached-ребёнок прошлого запуска и
    // после обновления сидел бы на старом коде — bat его гасит, а START.bat и mac-путь нет.
    arProxySpawn({ force: true }).then(r => {
        if (!r.ok) console.log('  ar proxy spawn error:', r.error || '?');
        else console.log('  ar proxy recreated');
    }).catch(e => console.log('  ar proxy spawn error:', e.message));
    // Keepalive AR :20133, затем keepalive АКТИВНОГО бэкенда — строго последовательно.
    // Параллельно нельзя: если активен сам AgentRouter, обе ветки увидели бы мёртвый
    // порт свободным и спавнили дубль, второй процесс падал бы с EADDRINUSE.
    // Активный бэкенд поднимаем отдельно потому, что он тоже умер вместе с прошлым
    // дашбордом, а раньше на boot вставал только AR — и активный gorouter/tabi/xpeach
    // оставлял CC без апстрима с непрозрачным 502 на каждый запрос.
    //
    // SWITCHER_NO_BOOT_KEEPALIVE=1 — для песочниц (tools/check-frontdoor.js). Порты
    // keepalive захардкожены, своих у песочницы нет, а keepaliveBring теперь умеет
    // УБИВАТЬ не отвечающего держателя порта — то есть боевой keepalive владельца.
    if (process.env.SWITCHER_NO_BOOT_KEEPALIVE === '1') {
        console.log('  keepalive boot: пропущен (SWITCHER_NO_BOOT_KEEPALIVE=1)');
    } else {
        // force — рестарт дашборда = рестарт стека. Дети прошлого запуска живут своей
        // жизнью (detached) и на старом коде; без force они читались как «уже поднято»
        // и человек добивал их руками.
        keepaliveBring(AR_KEEPALIVE_PORT, { force: true }).then(r => {
            if (!r.ok) console.log('  keepalive proxy spawn error:', r.error || '?');
            else console.log('  keepalive proxy recreated');
            return bootSpawnActiveBackend();
        }).then(r => {
            if (r && !r.ok) console.log('  active backend keepalive spawn error:', r.error || '?');
            else if (r) console.log('  active backend keepalive recreated');
            return bootSweepStaleChildren();
        }).then(swept => {
            if (swept && swept.length) console.log(`  stale children swept: ${swept.join(', ')}`);
            return bootRecreateActiveCustomProxy();
        }).then(r => {
            if (r) console.log(r.ok ? `  active custom converter recreated on :${r.port}` : `  active custom converter error: ${r.error || '?'}`);
        }).catch(e => console.log('  keepalive boot error:', e.message));
    }

    // Front-door (:20100) — единый вход Claude Code. Поднимаем всегда: с включённым
    // тумблером это единственный бэкенд CC, а с выключенным просто ждёт наготове,
    // чтобы включение не требовало рестарта дашборда.
    keepaliveBring(frontdoorPort(), { force: true }).then(r => {
        if (!r.ok) console.log('  front-door spawn error:', r.error || '?');
        else console.log(`  front-door recreated on :${frontdoorPort()}`);
        if (frontdoorConfig().enabled) console.log(`  front-door: ВКЛЮЧЁН, активный бэкенд ${currentTarget()}`);
    }).catch(e => console.log('  front-door spawn error:', e.message));
});

