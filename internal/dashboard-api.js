// Pure async helpers for the :8200 dashboard. No readline, no TUI, no spinners
// — just data in / data out. Both the CLI menu and the HTTP endpoints in
// transparent-proxy.js use these.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

let _freemodel = null;
function freemodelMod() {
    if (!_freemodel) _freemodel = require('./freemodel-manager');
    return _freemodel;
}

let _notion = null;
function notionMod() {
    if (!_notion) _notion = require('./notion-manager');
    return _notion;
}

let _devin = null;
function devinMod() {
    if (!_devin) _devin = require('./devin-manager');
    return _devin;
}

const OMNI_DB = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const SQLITE_EXE = process.env.SQLITE3
    || [
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe'),
        path.join(os.homedir(), 'bin', 'sqlite3.exe'),
    ].find(p => fs.existsSync(p))
    || path.join(os.homedir(), 'bin', 'sqlite3.exe');

function sqliteJson(sql) {
    if (!fs.existsSync(SQLITE_EXE)) {
        throw new Error(`sqlite3 not found at ${SQLITE_EXE} (set SQLITE3 env var)`);
    }
    if (!fs.existsSync(OMNI_DB)) {
        throw new Error(`OmniRoute db not found at ${OMNI_DB}`);
    }
    const out = execFileSync(SQLITE_EXE, [OMNI_DB, '-json', sql], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
    });
    return out ? JSON.parse(out) : [];
}

function sqliteExec(sql) {
    if (!fs.existsSync(SQLITE_EXE)) {
        throw new Error(`sqlite3 not found at ${SQLITE_EXE}`);
    }
    execFileSync(SQLITE_EXE, [OMNI_DB, sql], { encoding: 'utf8' });
}

// ───── OmniRoute accounts + latest quota snapshots ────────────────
function listOmniAccountsWithQuotas() {
    const accounts = sqliteJson(`
        SELECT id, provider, auth_type, name, email, is_active, test_status,
               error_code, last_error, rate_limited_until, last_used_at, created_at
        FROM provider_connections
        ORDER BY is_active DESC, datetime(coalesce(last_used_at, created_at)) DESC;
    `);
    if (!accounts.length) return [];
    // Latest snapshot per (connection_id, window_key)
    const snapshots = sqliteJson(`
        SELECT q.connection_id, q.window_key, q.remaining_percentage, q.next_reset_at, q.is_exhausted
        FROM quota_snapshots q
        JOIN (
            SELECT connection_id, window_key, MAX(created_at) AS mx
            FROM quota_snapshots
            GROUP BY connection_id, window_key
        ) latest
          ON q.connection_id = latest.connection_id
         AND q.window_key    = latest.window_key
         AND q.created_at    = latest.mx;
    `);
    const byConn = {};
    for (const s of snapshots) {
        if (!byConn[s.connection_id]) byConn[s.connection_id] = {};
        byConn[s.connection_id][s.window_key] = {
            remaining: s.remaining_percentage,
            resetAt:   s.next_reset_at,
            exhausted: !!s.is_exhausted,
        };
    }
    for (const a of accounts) a.quotas = byConn[a.id] || {};
    return accounts;
}

// ───── Notion sessions (read-only) ──────────────────────────────────
// No quota cache exists for Notion sessions (notion/sessions/) — quotas
// live behind notion-manager's HTTP dashboard which needs auth. Plan/status
// from local session.json info is what we surface here.
function listNotionSessions() {
    return notionMod().getNotionSessions();
}

// ───── FreeModel sessions + cached quotas ──────────────────────────
// Persists to logs/.freemodel_quota_cache.json (separate from the legacy
// menu.js cache which uses an older format). Survives switcher restarts.
const PROJECT_ROOT = path.join(__dirname, '..');
const FREEMODEL_QUOTA_CACHE = path.join(PROJECT_ROOT, 'logs', '.freemodel_quota_cache.json');

// ── freemodel/.env (gitignored: IMAP-креды, личные домены) ──────────────
// Тот же крошечный парсер, что в routing/transparent-proxy.js. Уже выставленные
// переменные окружения имеют приоритет над файлом.
(function loadFreemodelEnv() {
    try {
        const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'freemodel', '.env'), 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            if (line.trimStart().startsWith('#')) continue;
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m) continue;
            if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch {}
})();

// Атомарная запись JSON: temp в той же папке + rename. Без этого читатели ловят
// недописанный файл — statusline парсит .freemodel_quota_cache.json грепом на
// каждую отрисовку, а он под 80КБ, и попасть в середину writeFileSync реально.
function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);   // на Windows тоже перезаписывает (MOVEFILE_REPLACE_EXISTING)
}

function loadFreemodelQuotaCache() {
    try {
        if (fs.existsSync(FREEMODEL_QUOTA_CACHE)) {
            return JSON.parse(fs.readFileSync(FREEMODEL_QUOTA_CACHE, 'utf-8')) || {};
        }
    } catch {}
    return {};
}

function saveFreemodelQuotaCache(cache) {
    try {
        writeJsonAtomic(FREEMODEL_QUOTA_CACHE, cache);
    } catch {}
}

// Точечная запись: перечитать файл и обновить ТОЛЬКО свои ключи. Обязательна для
// всего, что писалось после await — иначе снапшот, снятый до долгого запроса,
// затирает чужие записи, доехавшие в это время. Проверять несколько квот подряд
// раньше означало терять часть результатов.
function patchFreemodelQuotaCache(entries) {
    const cache = loadFreemodelQuotaCache();
    Object.assign(cache, entries);
    saveFreemodelQuotaCache(cache);
    return cache;
}

// ───── FreeModel meta (banned-маркер + связь с TG-пулом) ──────────
// Хранится отдельно от quota-кэша чтобы рефреш квот не затирал маркеры.
// Ключ — session.name (имя папки v3 или manual_sessions/...).
const FREEMODEL_META_FILE = path.join(PROJECT_ROOT, 'logs', '.freemodel_meta.json');

function loadFreemodelMeta() {
    try {
        if (fs.existsSync(FREEMODEL_META_FILE)) {
            return JSON.parse(fs.readFileSync(FREEMODEL_META_FILE, 'utf-8')) || {};
        }
    } catch {}
    return {};
}

function saveFreemodelMeta(meta) {
    try {
        writeJsonAtomic(FREEMODEL_META_FILE, meta);
    } catch {}
}

// Обновить мету одного аккаунта, не затирая параллельные правки соседей:
// перечитываем файл, применяем мутатор к своей записи, пишем. Возвращаем запись.
function patchFreemodelMeta(name, mutate) {
    const meta = loadFreemodelMeta();
    const changed = mutate(meta);
    if (changed) saveFreemodelMeta(meta);
    return meta[name] || {};
}

function setFreemodelBanned(name, banned) {
    const meta = loadFreemodelMeta();
    meta[name] = meta[name] || {};
    if (banned) {
        meta[name].banned = true;
        meta[name].bannedAt = new Date().toISOString();
        // Ручной бан перебивает авто: снимаем autoBanned, иначе первый же скрап
        // с деньгами вернул бы аккаунт, который юзер похоронил намеренно.
        delete meta[name].autoBanned;
        delete meta[name].bannedReason;
    } else {
        delete meta[name].banned;
        delete meta[name].bannedAt;
        delete meta[name].autoBanned;
        delete meta[name].bannedReason;
    }
    saveFreemodelMeta(meta);
    return meta[name];
}

// Авто-бан по нулевому балансу. freemodel иногда выдаёт разовые $5, а иногда
// аккаунт капает по 5h-окну — поэтому авто-бан помечается отдельным флагом
// autoBanned и снимается сам, как только скрап увидит деньги. Ручной 💀
// (banned без autoBanned) вечен: авто-возврат его не трогает.
//
// Безопасность предиката: available — это распарсенная строка вида "$0.00".
// checkFreemodelQuota инициализирует поле пустой строкой и возвращает null,
// если не подтянулось вообще ничего, поэтому "$0.00" означает именно
// прочитанный с сайта ноль, а не сорванный скрап. Пустое/отсутствующее
// значение НЕ считаем нулём — иначе неудачный парс выкосил бы живые акки.
const FM_ZERO_BALANCE = /^\$0(?:[.,]0+)?$/;

function fmIsZeroBalance(quota) {
    const raw = String(quota?.available ?? '').trim();
    return raw !== '' && FM_ZERO_BALANCE.test(raw);
}

function fmHasMoney(quota) {
    const raw = String(quota?.available ?? '').trim();
    return raw !== '' && !FM_ZERO_BALANCE.test(raw);
}

// Аккаунт на перезарядке считается остывшим, если дедлайн прошёл. Дедлайна может
// не быть (скрап не смог распарсить "Sun 8:29 AM") — тогда ждём следующего
// рефреша, а не держим аккаунт в морозилке вечно.
function fmIsCooling(m) {
    if (!m?.cooldownUntil) return false;
    const t = Date.parse(m.cooldownUntil);
    return Number.isFinite(t) && t > Date.now();
}

// Мёртвым признаём только после двух подтверждений, разнесённых больше чем на
// одно 5h-окно (+запас). Одиночный ответ «нет окон и нет денег» бывает у гонки
// рендера и у сорванного скрапа — раньше именно он хоронил живые аккаунты.
const FM_DEAD_CONFIRM_MS = 6 * 60 * 60 * 1000;

// Свести свежую квоту с метками состояния. Мутирует переданный meta-объект,
// возвращает true если что-то изменилось (чтобы вызывающий знал про save).
//
// Ключевое: 'cooldown' НЕ банит. При активном 5h-окне available == остаток окна,
// поэтому "$0.00" означает «окно выжрано, нальётся в cooldownUntil», а не смерть
// аккаунта. Старая логика (бан по любому $0.00) выкашивала пул на ровном месте.
function syncFmAccountState(meta, name, quota) {
    const m = meta[name] || (meta[name] = {});
    const before = JSON.stringify(m);
    const state = quota?.state;

    if (state === 'cooldown') {
        m.cooldownUntil = quota.cooldownUntil || '';
        m.coolReason = quota.coolReason || '';
        delete m.deadStrikes;
        delete m.deadSince;
        // Самолечение: аккаунт, похороненный старой логикой, оживает при первом
        // же рефреше, который показал живое окно. Ручной 💀 не трогаем.
        if (m.autoBanned) {
            delete m.banned; delete m.autoBanned; delete m.bannedAt; delete m.bannedReason;
        }
    } else if (state === 'ok') {
        delete m.cooldownUntil;
        delete m.coolReason;
        delete m.deadStrikes;
        delete m.deadSince;
        if (m.autoBanned) {
            delete m.banned; delete m.autoBanned; delete m.bannedAt; delete m.bannedReason;
        }
    } else if (state === 'dead') {
        delete m.cooldownUntil;
        delete m.coolReason;
        m.deadStrikes = (m.deadStrikes || 0) + 1;
        if (!m.deadSince) m.deadSince = new Date().toISOString();
        // JSON-API — источник авторитетный: там прямо видно subscription.status
        // и creditCents, гадать не о чем. Подписки нет и кошелёк пуст → аккаунт
        // исчерпан прямо сейчас, ждать второго подтверждения бессмысленно.
        // Двухфазность оставлена скрапу и случаю «подписка активна, но лимитов
        // не нашли» — там ноль может быть артефактом, а не приговором.
        const certain = quota.src === 'api' && quota.subActive === false;
        const enough = certain || (m.deadStrikes >= 2 &&
            (Date.now() - Date.parse(m.deadSince)) >= FM_DEAD_CONFIRM_MS);
        // Аккаунт без привязанного TG НИКОГДА не помечаем исчерпанным: trial-кредит
        // выдаётся именно за бинд, поэтому до привязки $0 и отсутствие окон — это
        // нормальное состояние недорегистрированного аккаунта, а не приговор.
        // Иначе свежие акки прятались бы из списка ещё до того, как их довели.
        const noTg = !m.tgPhone;
        if (enough && !noTg && !m.banned) {
            m.banned = true;           // флаг общий с ручным 💀 — по нему фильтры и ротатор
            m.autoBanned = true;       // но это НЕ бан: аккаунт цел, просто кончились кредиты
            m.bannedAt = new Date().toISOString();
            m.bannedReason = 'exhausted';
        }
    }
    // state отсутствует (старый кеш, скрап без окон) — не знаем, не трогаем.

    return JSON.stringify(m) !== before;
}

// Старое имя оставлено: его зовут внешние точки (ротатор, ручной рефреш).
const syncFmAutoBan = syncFmAccountState;

// Привязать TG-phone к freemodel-аккаунту (вызывается из автореги после
// успешной привязки бота — для UI-карточки).
function setFreemodelTgPhone(name, tgPhone) {
    const meta = loadFreemodelMeta();
    meta[name] = meta[name] || {};
    if (tgPhone) {
        meta[name].tgPhone = String(tgPhone);
        meta[name].tgLinkedAt = new Date().toISOString();
    } else {
        delete meta[name].tgPhone;
        delete meta[name].tgLinkedAt;
    }
    saveFreemodelMeta(meta);
    return meta[name];
}

function setFreemodelApiKey(name, apiKey) {
    const meta = loadFreemodelMeta();
    meta[name] = meta[name] || {};
    if (apiKey) meta[name].apiKey = String(apiKey);
    else delete meta[name].apiKey;
    saveFreemodelMeta(meta);
    return meta[name];
}

async function extractFreemodelApiKey(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getFreemodelSessions, extractFreemodelApiKey: extractKey } = freemodelMod();
    const session = getFreemodelSessions().find(s => s.name === name);
    if (!session) throw new Error(`session not found: ${name}`);
    return await extractKey(session);
}

// «Липкий» мерж свежего скрапа с кешем: freemodel.dev рендерит план/renews/окна
// через React с задержкой (окна 5h/7d — отдельный fetch, ~2с позже остального).
// При неудачном wait поля приходят пустыми и раньше затирали валидный кеш —
// UI сваливался на trial/реф-бонус fallback и ломал полосу пула.
//
// state/cooldownUntil липкими НЕ делаем сознательно: протухший «на перезарядке»
// держал бы аккаунт вне ротации после того, как окно уже налилось.
function mergeStickyFmQuota(prev, q) {
    const merged = { ...q };
    if (!merged.plan && prev.plan) merged.plan = prev.plan;
    if (!merged.renews && prev.renews) merged.renews = prev.renews;
    if (!merged.tgPhone && prev.tgPhone) merged.tgPhone = prev.tgPhone;
    // Окна тянем из кеша только когда источник — скрап (гонка рендера). У JSON-API
    // пустые окна означают именно «окон нет», и подмена кешем нарисовала бы
    // фантомный запас у аккаунта, который на самом деле слетел с плана.
    if (merged.state) return merged;
    if (!merged.h5 && merged.h5pct == null && prev.h5) {
        merged.h5 = prev.h5; merged.h5max = prev.h5max;
        merged.h5resets = prev.h5resets; merged.h5pct = prev.h5pct;
    }
    if (!merged.d7 && merged.d7pct == null && prev.d7) {
        merged.d7 = prev.d7; merged.d7max = prev.d7max;
        merged.d7resets = prev.d7resets; merged.d7pct = prev.d7pct;
    }
    return merged;
}

// withQuotas behavior:
//   'cache'   — return cached quotas only (instant, no network)
//   'refresh' — refresh via freemodel JSON-API in parallel, update cache
//   false     — no quota info at all (fastest, list only)
// concurrency 3: рефреш ходит обычным fetch (~1.5с/акк) вместо браузера, но
// параллельность НЕ поднимаем. 2026-08-02 прогон пула в 12 потоков с одного IP
// совпал со слётом акка с Pro на free/canceled — залпом по freemodel не ходим.
async function listFreemodelSessions({ withQuotas = 'cache', concurrency = 3 } = {}) {
    const { getFreemodelSessions, checkFreemodelQuota } = freemodelMod();
    const sessions = getFreemodelSessions();
    const meta = loadFreemodelMeta();
    // Подхватываем apiKey из freemodel/accounts/<dir>/account_info.txt
    // и кладём в meta — UI получает всё из одного места.
    for (const s of sessions) {
        if (!meta[s.name]?.apiKey) {
            try {
                const infoFile = path.join(s.path, 'account_info.txt');
                if (fs.existsSync(infoFile)) {
                    const raw = fs.readFileSync(infoFile, 'utf-8');
                    const km = raw.match(/^API Key:\s*((?:fe[_-]|sk-)[A-Za-z0-9_-]{20,})/m);
                    if (km) {
                        meta[s.name] = meta[s.name] || {};
                        meta[s.name].apiKey = km[1];
                    }
                }
            } catch {}
        }
    }
    const withMeta = (s, extra) => ({ ...s, ...extra, meta: meta[s.name] || {} });
    if (withQuotas === false) return sessions.map(s => withMeta(s, { quota: null }));

    const cache = loadFreemodelQuotaCache();

    if (withQuotas === 'cache') {
        return sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));
    }

    // refresh — skip banned/error, всё остальное молотим. Юзер нажал кнопку —
    // значит хочет пересканировать (даже если только что скринил). Если нужен
    // «дешёвый» refresh — используй withQuotas:'cache' или отдельный endpoint.
    // manual-аккаунты (имя+ключ, stub session.json) пропускаем — браузерной
    // сессии нет, Playwright упрётся в логин-страницу.
    // Авто-баненых (нулевой баланс) сканируем — они кандидаты на возврат, если
    // 5h-окно капнуло денег. Исключается только ручной 💀: он вечен.
    const eligible = sessions.filter(s => {
        const m = meta[s.name] || {};
        const manualBan = m.banned && !m.autoBanned;
        return s.status === '✅' && !manualBan && s.backend !== 'manual';
    });
    if (eligible.length === 0) return sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));

    const out = sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, eligible.length) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= eligible.length) return;
            try {
                const q = await checkFreemodelQuota(eligible[i]);
                if (q) {
                    const origIdx = sessions.indexOf(eligible[i]);
                    // Сохраняем "липкие" поля из старого кэша, если новый скрап их не увидел.
                    // freemodel.dev рендерит план/renews через React с задержкой — при неудачном
                    // wait план приходит пустым, и раньше это стирало кэшированный "Pro"/"Free"
                    // на UI, оставляя прочерк. Мержим: пусто в q → берём из cache.
                    const prev = cache[eligible[i].name] || {};
                    const merged = mergeStickyFmQuota(prev, q);
                    if (origIdx >= 0) out[origIdx].quota = { ...merged, updatedAt: Date.now() };
                    cache[eligible[i].name] = out[origIdx >= 0 ? origIdx : i].quota;
                    // Мету правим точечно и сразу, а не копим снапшот до конца скана:
                    // иначе ручной 💀, поставленный посреди прогона пула, затирался
                    // устаревшей записью в финальном сохранении.
                    const nm = eligible[i].name;
                    const metaEntry = patchFreemodelMeta(nm, mm => {
                        let ch = syncFmAccountState(mm, nm, merged);
                        // TG-привязка — локальная мета (ставится при bind) авторитетна.
                        // Скан freemodel.dev может ДОБАВИТЬ номер, если локально пусто,
                        // но НИКОГДА не удаляет: tgBound===false на ненадёжном скане
                        // раньше стирал привязки (оставался осиротевший tgLinkedAt).
                        if (q.tgBound === true) {
                            mm[nm] = mm[nm] || {};
                            if (!mm[nm].tgPhone) { mm[nm].tgPhone = q.tgPhone || 'connected'; ch = true; }
                        }
                        return ch;
                    });
                    if (origIdx >= 0) out[origIdx].meta = { ...(out[origIdx].meta || {}), ...metaEntry };
                }
            } catch { /* keep cached value */ }
        }
    });
    await Promise.all(workers);
    // Пишем ТОЛЬКО отсканированные ключи в свежеперечитанный файл. Снапшот `cache`
    // снят до скана — за это время (десятки секунд на пул) одиночный 🔄 или ленивый
    // рефреш статуслайна успевают записаться, и запись снапшотом их сносила.
    const touched = {};
    for (const s of eligible) if (cache[s.name]) touched[s.name] = cache[s.name];
    patchFreemodelQuotaCache(touched);
    // Мета уже записана точечно внутри воркеров — финального сохранения нет
    // намеренно, оно бы вернуло устаревший снапшот.
    return out;
}

// ───── Devin sessions + cached quotas ──────────────────────────────
// Reuses logs/.quota_cache.json (menu.js writes here when refreshing
// Devin quotas — fields: daily, weekly, resetsIn, plan, updatedAt).
const DEVIN_QUOTA_CACHE = path.join(PROJECT_ROOT, 'logs', '.quota_cache.json');

function loadDevinQuotaCache() {
    try {
        if (fs.existsSync(DEVIN_QUOTA_CACHE)) {
            return JSON.parse(fs.readFileSync(DEVIN_QUOTA_CACHE, 'utf-8')) || {};
        }
    } catch {}
    return {};
}

function saveDevinQuotaCache(cache) {
    try {
        fs.mkdirSync(path.dirname(DEVIN_QUOTA_CACHE), { recursive: true });
        fs.writeFileSync(DEVIN_QUOTA_CACHE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {}
}

async function listDevinSessions({ withQuotas = 'cache', concurrency = 3 } = {}) {
    const { getDevinSessions, checkDevinQuota } = devinMod();
    const sessions = getDevinSessions();
    if (withQuotas === false) return sessions.map(s => ({ ...s, quota: null }));

    const cache = loadDevinQuotaCache();

    if (withQuotas === 'cache') {
        return sessions.map(s => ({ ...s, quota: cache[s.name] || null }));
    }

    const out = sessions.map(s => ({ ...s, quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, sessions.length) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= sessions.length) return;
            try {
                const q = await checkDevinQuota(sessions[i]);
                if (q) {
                    out[i].quota = { ...q, updatedAt: Date.now() };
                    cache[sessions[i].name] = out[i].quota;
                }
            } catch {}
        }
    });
    await Promise.all(workers);
    saveDevinQuotaCache(cache);
    return out;
}

async function refreshOneDevinQuota(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getDevinSessions, checkDevinQuota } = devinMod();
    const session = getDevinSessions().find(s => s.name === name);
    if (!session) throw new Error(`devin session not found: ${name}`);
    const q = await checkDevinQuota(session);
    const cache = loadDevinQuotaCache();
    if (q) {
        cache[name] = { ...q, updatedAt: Date.now() };
        saveDevinQuotaCache(cache);
    }
    return cache[name] || null;
}
function toggleOmniAccount(id, active) {
    if (!/^[0-9a-fA-F-]{8,}$/.test(String(id))) {
        throw new Error('bad id format (expected hex UUID or 8+ char prefix)');
    }
    let fullId = id;
    if (id.length < 36) {
        const matches = sqliteJson(
            `SELECT id FROM provider_connections WHERE id LIKE '${id}%';`
        );
        if (matches.length === 0) throw new Error(`no account matching prefix '${id}'`);
        if (matches.length > 1) {
            throw new Error(`prefix '${id}' is ambiguous (${matches.length} matches: ` +
                matches.map(m => m.id.substring(0,12)).join(', ') + ')');
        }
        fullId = matches[0].id;
    }
    const flag = active ? 1 : 0;
    const ts = new Date().toISOString();
    const extra = active
        ? `, error_code = NULL, last_error = NULL, last_error_at = NULL,
             rate_limited_until = NULL, backoff_level = 0, test_status = 'active'`
        : '';
    const sql = `UPDATE provider_connections
                 SET is_active = ${flag},
                     updated_at = '${ts}'${extra}
                 WHERE id = '${fullId}';`;
    sqliteExec(sql);
    const rows = sqliteJson(`SELECT id, name, email, is_active, test_status, error_code, last_error
                              FROM provider_connections WHERE id = '${fullId}';`);
    if (!rows.length) throw new Error(`no account with id=${fullId}`);
    return rows[0];
}

// ───── Per-session actions (Notion / FreeModel / Conduit / Devin) ─────
// Dedup: до этого каждый клик на "Открыть в Chrome" запускал новый
// Playwright-chromium (5-10 процессов). 15 кликов = 100+ chrome-процессов,
// забивалась RAM. Теперь повторный клик фокусирует существующее окно.
const openedBrowsers = new Map();  // key `${kind}:${name}` -> { browser, page }

async function _openOrFocusSession({ kind, name, storageState, gotoUrl, replyUrl, contextOpts = {} }) {
    const key = `${kind}:${name}`;
    const existing = openedBrowsers.get(key);
    if (existing && existing.browser.isConnected()) {
        try {
            await existing.page.bringToFront();
            return { ok: true, kind, name, url: replyUrl || gotoUrl, focused: true };
        } catch {
            openedBrowsers.delete(key);
            try { await existing.browser.close(); } catch {}
        }
    }
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
    const context = await browser.newContext({ storageState, viewport: null, ...contextOpts });
    const page = await context.newPage();
    openedBrowsers.set(key, { browser, page });
    browser.on('disconnected', () => {
        if (openedBrowsers.get(key)?.browser === browser) openedBrowsers.delete(key);
    });
    await page.goto(gotoUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    return { ok: true, kind, name, url: replyUrl || gotoUrl };
}

async function openSessionInBrowser(kind, name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    if (kind === 'notion') {
        const dir = path.join(PROJECT_ROOT, 'notion', 'sessions', name);
        if (!fs.existsSync(dir)) throw new Error(`notion session not found: ${name}`);
        return _openOrFocusSession({
            kind, name,
            storageState: path.join(dir, 'session.json'),
            gotoUrl: 'https://www.notion.so/',
        });
    }
    if (kind === 'freemodel') {
        const session = freemodelMod().getFreemodelSessions().find(s => s.name === name);
        if (!session) throw new Error(`freemodel session not found: ${name}`);
        if (!fs.existsSync(session.path)) throw new Error(`freemodel session dir gone: ${session.path}`);
        return _openOrFocusSession({
            kind, name,
            storageState: path.join(session.path, 'session.json'),
            gotoUrl: 'https://freemodel.dev/dashboard',
            replyUrl: 'https://freemodel.dev/dashboard/usage',
            contextOpts: {
                // Форсим английский UI: иначе ru-системные акки откроются на русском
                locale: 'en-US',
                extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
            },
        });
    }
    if (kind === 'conduit') {
        const account = conduitMod().getConduitAccounts().find(s => s.name === name);
        if (!account) throw new Error(`conduit account not found: ${name}`);
        if (!account.sessionFile || !fs.existsSync(account.sessionFile)) throw new Error(`conduit session.json gone (key-only акк?): ${name}`);
        return _openOrFocusSession({
            kind, name,
            storageState: account.sessionFile,
            gotoUrl: 'https://conduit.ozdoev.net/#cabinet',
        });
    }
    if (kind === 'svrtr') {
        const account = svrtrMod().getSvrtrAccounts().find(s => s.name === name);
        if (!account) throw new Error(`svrtr account not found: ${name}`);
        if (!account.sessionFile || !fs.existsSync(account.sessionFile)) throw new Error(`svrtr session.json gone: ${name}`);
        return _openOrFocusSession({
            kind, name,
            storageState: account.sessionFile,
            gotoUrl: 'https://svrtr.org/profile',
        });
    }
    if (kind === 'helpcoder') {
        const account = helpcoderMod().getHelpcoderAccounts().find(s => s.name === name);
        if (!account) throw new Error(`helpcoder account not found: ${name}`);
        if (!account.sessionFile || !fs.existsSync(account.sessionFile)) throw new Error(`helpcoder session.json gone: ${name}`);
        return _openOrFocusSession({
            kind, name,
            storageState: account.sessionFile,
            gotoUrl: 'https://helpcoder.cc/token',
        });
    }
    if (kind === 'devin') {
        const session = devinMod().getDevinSessions().find(s => s.name === name);
        if (!session) throw new Error(`devin session not found: ${name}`);
        if (!fs.existsSync(session.path)) throw new Error(`devin session dir gone: ${session.path}`);
        const orgName = session.orgName && session.orgName !== 'Неизвестно' ? session.orgName : null;
        const url = orgName
            ? `https://app.devin.ai/org/${orgName}/settings/usage`
            : 'https://app.devin.ai/';
        return _openOrFocusSession({
            kind, name,
            storageState: path.join(session.path, 'session.json'),
            gotoUrl: url,
        });
    }
    if (kind === 'anymodel') {
        const accounts = listAmodelAccounts();
        const account = accounts.find(a => a.email === name);
        if (!account) throw new Error(`anymodel account not found: ${name}`);
        if (!account.session_dir) throw new Error(`anymodel account has no saved session`);
        const sessionFile = path.join(AMODEL_ACCOUNTS_DIR, account.session_dir, 'session.json');
        if (!fs.existsSync(sessionFile)) throw new Error(`anymodel session.json not found: ${sessionFile}`);
        return _openOrFocusSession({
            kind, name,
            storageState: sessionFile,
            gotoUrl: 'https://anymodel.org/app',
        });
    }
    throw new Error(`unknown kind: ${kind}`);
}

async function refreshOneFreemodelQuota(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getFreemodelSessions, checkFreemodelQuota } = freemodelMod();
    const session = getFreemodelSessions().find(s => s.name === name);
    if (!session) throw new Error(`session not found: ${name}`);
    // manual-аккаунт: браузерной сессии нет, Playwright упрётся в логин.
    // Ставим updatedAt, чтобы авто-ротация не считала кэш вечно протухшим
    // и не дёргала этот no-op каждый тик.
    if (session.backend === 'manual') {
        const prev = loadFreemodelQuotaCache()[name] || {};
        const entry = { ...prev, updatedAt: Date.now() };
        patchFreemodelQuotaCache({ [name]: entry });
        return entry;
    }
    const q = await checkFreemodelQuota(session);
    // Кеш читаем ТОЛЬКО здесь, после await. Снапшот, снятый до запроса, за это
    // время устаревает: параллельный рефреш соседа успевает записаться, и запись
    // из старого снапшота его сносит. Именно так терялись квоты, когда несколько
    // аккаунтов проверялись подряд.
    if (!q) return loadFreemodelQuotaCache()[name] || null;

    const prev = loadFreemodelQuotaCache()[name] || {};
    const entry = { ...mergeStickyFmQuota(prev, q), updatedAt: Date.now() };
    patchFreemodelQuotaCache({ [name]: entry });
    // Точечный рефреш — основной путь возврата из авто-бана: юзер жмёт 🔄
    // на строке и аккаунт всплывает, если окно налилось или появились деньги.
    patchFreemodelMeta(name, meta => syncFmAccountState(meta, name, entry));
    return entry;
}

function deleteSession(kind, name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    let dir;
    if (kind === 'notion') {
        dir = path.join(PROJECT_ROOT, 'notion', 'sessions', name);
    } else if (kind === 'freemodel') {
        const s = freemodelMod().getFreemodelSessions().find(x => x.name === name);
        if (!s) throw new Error(`freemodel session not found: ${name}`);
        dir = s.path;
    } else if (kind === 'devin') {
        // Devin sessions live across three roots — find by getDevinSessions
        const s = devinMod().getDevinSessions().find(x => x.name === name);
        if (!s) throw new Error(`devin session not found: ${name}`);
        dir = s.path;
    } else {
        throw new Error(`unknown kind: ${kind}`);
    }
    if (!fs.existsSync(dir)) throw new Error(`session dir not found: ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });

    // Clean up quota cache entries
    if (kind === 'freemodel') {
        const cache = loadFreemodelQuotaCache();
        if (cache[name]) { delete cache[name]; saveFreemodelQuotaCache(cache); }
    } else if (kind === 'devin') {
        const cache = loadDevinQuotaCache();
        if (cache[name]) { delete cache[name]; saveDevinQuotaCache(cache); }
    }
    return { ok: true, kind, name };
}

// ───── Notion card presets (config.js editing) ─────────────────────
// notion/config.js exports a plain JS object via module.exports. We mutate
// only two fields: CARD_PRESETS array (read-only here) and CARD_PRESET_INDEX.
// String-replace for CARD_PRESET_INDEX (regex), require() for parse.
const NOTION_CONFIG = path.join(PROJECT_ROOT, 'notion', 'config.js');

function getNotionCards() {
    if (!fs.existsSync(NOTION_CONFIG)) {
        throw new Error('notion/config.js not found');
    }
    // Bust require cache so on-disk changes (from this same dashboard) are picked up.
    delete require.cache[require.resolve(NOTION_CONFIG)];
    const cfg = require(NOTION_CONFIG);
    return {
        presets:      Array.isArray(cfg.CARD_PRESETS) ? cfg.CARD_PRESETS : [],
        currentIndex: cfg.CARD_PRESET_INDEX,
    };
}

function setNotionCardIndex(value) {
    // value is either an integer >= 0 or the string 'rotate'
    let serialised;
    if (value === 'rotate') {
        serialised = `'rotate'`;
    } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new Error('index must be a non-negative integer or "rotate"');
        serialised = String(n);
    }
    let txt = fs.readFileSync(NOTION_CONFIG, 'utf8');
    const before = txt;
    txt = txt.replace(
        /(CARD_PRESET_INDEX\s*:\s*)('rotate'|"rotate"|\d+)(\s*,?)/,
        (_, k, _v, tail) => `${k}${serialised}${tail}`
    );
    if (txt === before) throw new Error('CARD_PRESET_INDEX not found in notion/config.js');
    fs.writeFileSync(NOTION_CONFIG, txt, 'utf8');
    delete require.cache[require.resolve(NOTION_CONFIG)];
    return getNotionCards();
}

// ───── Launch scripts in detached terminal windows ─────────────────
// Each "kind" maps to one launch command. We use Windows `cmd /c start` to
// pop a new console window — the user does the interactive menu/Playwright
// session there, the dashboard process stays clean.
const { spawn } = require('child_process');

// Скрипты жизненного цикла с 2026-08-24 — тонкие форвардеры в hub.js, и звать
// через них незачем: на маке этот путь был просто СЛОМАН (`bash` по .bat, то есть
// cmd-синтаксис в bash — кнопка «перезапустить» не работала там вообще), а на
// Windows добавлял лишнее звено. Имена оставлены: на них показывает UI и чужие
// ярлыки. Всё, что не в этой таблице, идёт прежним путём.
const LIFECYCLE_VERBS = {
    'restart-dashboard.bat': 'restart',
    'start-switcher.bat': 'restart',
    'start-proxy.bat': 'start',
    'stop-dashboard.sh': 'stop',
};

function launchBatFile(batName) {
    const verb = LIFECYCLE_VERBS[String(batName).toLowerCase()];
    if (verb) return launchHub(verb);

    const batPath = path.join(PROJECT_ROOT, 'routing', batName);
    // 🪤 На маке .bat запускать нечем: cmd.exe там нет, а `bash file.bat` — это не
    // запуск, а попытка шелла исполнить cmd-скрипт. Ровно так оно и работало: скрипт
    // падал отсоединённо в stdio:'ignore', то есть в никуда, API отвечал {ok:true}
    // (спавн отсоединённого процесса «успешен» всегда), а фронт рисовал зелёное
    // «▶ restart-dashboard.bat запущен». Человек верил, что перезапустил дашборд, и
    // оставался на старом процессе — с новым HTML (он читается с диска) и старыми
    // роутами в памяти. Отсюда «Unexpected token 'N', "Not found."» на маке 24.08.
    // Теперь берём одноимённый .sh, а если его нет — отказываем словами.
    let runPath = batPath;
    if (process.platform !== 'win32' && /\.bat$/i.test(batName)) {
        const sh = batPath.replace(/\.bat$/i, '.sh');
        if (!fs.existsSync(sh)) {
            throw new Error(`на этой системе нечем запустить ${batName} — нет ${path.basename(sh)}`);
        }
        runPath = sh;
    }
    if (!fs.existsSync(runPath)) throw new Error(`bat not found: ${batName}`);
    if (process.platform === 'win32') {
        // `/c`, а НЕ `/k`. С `/k` cmd оставалась жить после скрипта: бат при нехватке
        // прав поднимает элевированную копию и делает `exit /b` — тот завершает
        // скрипт, но не консоль, и окно-запускалка висело в промпте навсегда. По
        // одному на каждый клик «перезапустить» — они копились десятками.
        spawn('cmd.exe', ['/c', 'start', `"${batName.replace(/\.bat$/i, '')}"`, 'cmd.exe', '/c', runPath], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
        }).unref();
    } else {
        // Вывод в лог, а не в /dev/null: отсоединённый процесс больше никому не
        // сообщит, почему он не поднялся (см. ловушку выше).
        const log = fs.openSync(path.join(PROJECT_ROOT, 'logs', 'hub', 'launch.log'), 'a');
        spawn('bash', [runPath], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log] }).unref();
    }
    return { ok: true, bat: batName };
}

// Отсоединённый запуск операции хаба. На Windows — в своём окне консоли, чтобы
// человек видел ход и причину отказа (HUB.bat при ненулевом коде держит окно). На
// маке окна нет: вывод идёт в logs/hub/launch.log (у самих сервисов по файлу).
//
// 🪤 Отсоединение обязательно: перезапуск убивает и ЭТОТ дашборд, то есть родителя.
// Привязанный ребёнок умер бы вместе с ним на середине — порты погашены, обратно
// никто не поднял.
function launchHub(verb) {
    // Явная проверка вместо молчаливого detached-спавна в пустоту: отсоединённый
    // процесс не сообщит об ошибке никому, и «нажал перезапустить, ничего не
    // произошло» осталось бы без причины в логах.
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'hub.js'))) {
        throw new Error('hub.js не найден — обнови репо (в нём живёт вся механика запуска)');
    }
    if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '"ABUSE HUB"', 'cmd.exe', '/c',
            path.join(PROJECT_ROOT, 'HUB.bat'), verb, '--no-open'], {
            cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', windowsHide: false,
        }).unref();
    } else {
        fs.mkdirSync(path.join(PROJECT_ROOT, 'logs', 'hub'), { recursive: true });
        const log = fs.openSync(path.join(PROJECT_ROOT, 'logs', 'hub', 'launch.log'), 'a');
        spawn(process.execPath, [path.join(PROJECT_ROOT, 'hub.js'), verb, '--no-open'], {
            cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log],
        }).unref();
    }
    return { ok: true, hub: verb };
}

// ── Email backend для FreeModel autoreger (timeweb | tmailor) ─────────
// Persist в freemodel/.email_backend; autoreger читает его при старте.
const EMAIL_BACKEND_FILE = path.join(PROJECT_ROOT, 'freemodel', '.email_backend');
const EMAIL_BACKENDS = ['timeweb', 'tmailor'];

function getEmailBackend() {
    try {
        const v = fs.readFileSync(EMAIL_BACKEND_FILE, 'utf8').trim();
        if (EMAIL_BACKENDS.includes(v)) return v;
    } catch {}
    return 'timeweb'; // дефолт = config.EMAIL_BACKEND
}

function setEmailBackend(backend) {
    if (!EMAIL_BACKENDS.includes(backend)) {
        throw new Error(`unknown email backend: ${backend} (allowed: ${EMAIL_BACKENDS.join(', ')})`);
    }
    fs.writeFileSync(EMAIL_BACKEND_FILE, backend, 'utf8');
    return { ok: true, backend };
}

// ── Домен регистрации для timeweb-backend ─────────────────────────────
// Persist в freemodel/.email_domain; timeweb-imap-client читает при старте.
// Все домены через catch-all льют в один ящик-ридер (см. freemodel/.env.example).
// Список для дропдауна — из env FM_EMAIL_DOMAINS (через запятую), т.к. домены
// личные и в репо им не место.
const EMAIL_DOMAIN_FILE = path.join(PROJECT_ROOT, 'freemodel', '.email_domain');
const EMAIL_DOMAINS = String(process.env.FM_EMAIL_DOMAINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

function getEmailDomain() {
    try {
        const v = fs.readFileSync(EMAIL_DOMAIN_FILE, 'utf8').trim();
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return v;
    } catch {}
    return process.env.TW_MAIL_DOMAIN || EMAIL_DOMAINS[0] || '';
}

function setEmailDomain(domain) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(domain || ''))) {
        throw new Error(`invalid domain: ${domain}`);
    }
    fs.writeFileSync(EMAIL_DOMAIN_FILE, String(domain).trim(), 'utf8');
    return { ok: true, domain: String(domain).trim() };
}

function listEmailDomains() {
    const cur = getEmailDomain();
    // cur может быть пустым, если freemodel/.env не заполнен — не пихаем "" в дропдаун.
    const set = new Set([...EMAIL_DOMAINS, cur].filter(Boolean));
    return { current: cur, domains: [...set] };
}

function launchScript(kind, extraArgs = []) {
    const node = process.execPath; // current Node binary
    const TARGETS = {
        'menu':            { title: 'Autoreger Menu',         args: [path.join(PROJECT_ROOT, 'internal', 'menu.js')] },
        // 'devin-autoreg' снят 2026-08-24: autoreger.js не существует ни на диске,
        // ни в git — Devin свёрнут давно, а кнопка осталась и падала «cannot find
        // module». Заодно уехал в корзину его осиротевший корневой config.js.
        // FreeModel: 10minutemail-based mass register (v3 — v2/emailnator deprecated)
        'freemodel-create':{ title: 'FreeModel Autoreg v3',   args: [path.join(PROJECT_ROOT, 'freemodel', 'freemodel_autoreger_v3.js')] },
        // FreeModel: single manual login (legacy, for restoring sessions)
        'freemodel-login': { title: 'FreeModel: Manual Login',args: [path.join(PROJECT_ROOT, 'freemodel', 'create_first_session.js')] },
        'notion-create':   { title: 'Notion: New Account',    args: [path.join(PROJECT_ROOT, 'notion', 'notion_workflow.js')] },
        // Conduit: автореги из ТГ (gramjs device-code) + ручное сохранение сессии
        'conduit-create':  { title: 'Conduit Autoreg',        args: [path.join(PROJECT_ROOT, 'conduit', 'conduit_autoreger.js')] },
        'conduit-login':   { title: 'Conduit: Save Session',  args: [path.join(PROJECT_ROOT, 'conduit', 'record_conduit.js')] },
        'tokenrouter-create': { title: 'TokenRouter Autoreg', cmd: 'python', args: [path.join(PROJECT_ROOT, 'routing', 'tokenrouter', 'camoufox_autoreg.py')] },
        'ourtoken-create':   { title: 'Ourtoken Autoreg',     cmd: 'python', args: [path.join(PROJECT_ROOT, 'ourtoken', 'camoufox_autoreg.py')] },
        'anymodel-create':   { title: 'AnyModel Autoreg',     args: [path.join(PROJECT_ROOT, 'anymodel', 'anymodel_autoreger.js')] },
        'svrtr-create':      { title: 'Svrtr Autoreg',        args: [path.join(PROJECT_ROOT, 'svrtr', 'svrtr_autoreger.js')] },
        'helpcoder-create':  { title: 'HelpCoder Autoreg',    args: [path.join(PROJECT_ROOT, 'helpcoder', 'helpcoder_autoreg.js')] },
    };
    const t = TARGETS[kind];
    if (!t) throw new Error(`unknown launch kind: ${kind}`);

    // Safety: позитивный целочисленный count / FRE-инвайт только, выкидываем мусор
    const safeExtra = (Array.isArray(extraArgs) ? extraArgs : [])
        .map(a => String(a))
        .filter(a => /^(\d{1,3}|FRE-[A-Za-z0-9]+|ref_[A-Za-z0-9]+)$/.test(a))
        .slice(0, 4);

    const finalArgs = [...t.args, ...safeExtra];

    const exe = t.cmd || node;
    if (process.platform === 'win32') {
        // cmd /c start "" cmd /k "<exe> <script> [args...]"
        spawn('cmd.exe', ['/c', 'start', t.title, 'cmd.exe', '/k', exe, ...finalArgs], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
        }).unref();
    } else {
        spawn(exe, finalArgs, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, kind, args: finalArgs };
}

const TR_HEALTH_CACHE = path.join(PROJECT_ROOT, 'logs', '.tokenrouter_health.json');

function loadTrHealthCache() {
    try { return fs.existsSync(TR_HEALTH_CACHE) ? JSON.parse(fs.readFileSync(TR_HEALTH_CACHE, 'utf-8')) : {}; }
    catch { return {}; }
}
function saveTrHealthCache(cache) {
    try { fs.writeFileSync(TR_HEALTH_CACHE, JSON.stringify(cache, null, 2), 'utf-8'); } catch {}
}

function getCachedTrHealth(email) {
    const cache = loadTrHealthCache();
    return cache[email] || null;
}

const TR_USAGE_CACHE = path.join(PROJECT_ROOT, 'logs', '.tokenrouter_usage.json');
const TR_DAILY_BUDGET = 1.0; // $1 в сутки по словам пользователя

function loadTrUsageCache() {
    try { return fs.existsSync(TR_USAGE_CACHE) ? JSON.parse(fs.readFileSync(TR_USAGE_CACHE, 'utf-8')) : {}; }
    catch { return {}; }
}
function saveTrUsageCache(cache) {
    try { fs.writeFileSync(TR_USAGE_CACHE, JSON.stringify(cache, null, 2), 'utf-8'); } catch {}
}

function getCachedTrUsage(email) {
    return loadTrUsageCache()[email] || null;
}

const FM_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'fm-active-key.txt');

function getActiveFreemodelKey() {
    try {
        if (fs.existsSync(FM_ACTIVE_KEY_FILE)) {
            return fs.readFileSync(FM_ACTIVE_KEY_FILE, 'utf-8').trim();
        }
    } catch {}
    return null;
}

async function checkTokenrouterUsage(apiKey, email) {
    const https = require('https');
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'tokenrouter.me', port: 443, method: 'GET', path: '/v1/usage',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let result;
                try {
                    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
                    const j = JSON.parse(data);
                    const today = j?.usage?.today || {};
                    const todayCost = parseFloat(today.actual_cost || today.cost || 0);
                    const totalCost = parseFloat(j?.usage?.total?.actual_cost || j?.usage?.total?.cost || 0);
                    const remaining = Math.max(0, TR_DAILY_BUDGET - todayCost);
                    result = {
                        ok: true,
                        isValid: !!j.isValid,
                        mode: j.mode || '-',
                        planName: j.planName || '-',
                        unit: j.unit || 'USD',
                        todayCost,
                        totalCost,
                        dailyBudget: TR_DAILY_BUDGET,
                        remaining,
                        requests: today.requests || 0,
                    };
                } catch (e) {
                    result = { ok: false, error: e.message };
                }
                if (email) {
                    const cache = loadTrUsageCache();
                    cache[email] = { ...result, checkedAt: Date.now() };
                    saveTrUsageCache(cache);
                }
                resolve(result);
            });
        });
        req.on('error', (err) => {
            const result = { ok: false, error: err.message };
            if (email) {
                const cache = loadTrUsageCache();
                cache[email] = { ...result, checkedAt: Date.now() };
                saveTrUsageCache(cache);
            }
            resolve(result);
        });
        req.on('timeout', () => {
            req.destroy();
            const result = { ok: false, error: 'timeout' };
            if (email) {
                const cache = loadTrUsageCache();
                cache[email] = { ...result, checkedAt: Date.now() };
                saveTrUsageCache(cache);
            }
            resolve(result);
        });
        req.end();
    });
}

async function checkTokenrouterKey(apiKey, email) {
    const https = require('https');
    const checkBody = JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
    });

    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'tokenrouter.me', port: 443, method: 'POST', path: '/v1/messages',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'anthropic-version': '2023-06-01',
            },
            timeout: 15000,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve({ ok: true, status: 200 });
                    return;
                }
                let errMsg = `HTTP ${res.statusCode}`;
                let alive = false;
                try {
                    const j = JSON.parse(data);
                    if (j?.error?.message) {
                        errMsg = j.error.message;
                        // "group does not allow" = key valid, plan restricted
                        if (/group|plan|allow|dispatch/i.test(errMsg) && !/invalid|unauthorized|denied|key/i.test(errMsg)) {
                            alive = true;
                        }
                    } else if (j?.error?.type) {
                        errMsg = j.error.type;
                    }
                } catch {}
                let result;
                if (res.statusCode === 401) {
                    result = { ok: false, status: 401, error: 'ключ отклонён (expired/dead)' };
                } else if (alive) {
                    result = { ok: true, status: res.statusCode, note: errMsg.substring(0, 100) };
                } else {
                    result = { ok: false, status: res.statusCode, error: errMsg.substring(0, 150) };
                }
                if (email) {
                    const cache = loadTrHealthCache();
                    cache[email] = { ...result, checkedAt: Date.now() };
                    saveTrHealthCache(cache);
                }
                resolve(result);
            });
        });
        req.on('error', (err) => {
            const result = { ok: false, status: 0, error: err.code === 'ENOTFOUND' ? 'tokenrouter.me недоступен' : err.message };
            if (email) {
                const cache = loadTrHealthCache();
                cache[email] = { ...result, checkedAt: Date.now() };
                saveTrHealthCache(cache);
            }
            resolve(result);
        });
        req.on('timeout', () => {
            req.destroy();
            const result = { ok: false, status: 0, error: 'timeout' };
            if (email) {
                const cache = loadTrHealthCache();
                cache[email] = { ...result, checkedAt: Date.now() };
                saveTrHealthCache(cache);
            }
            resolve(result);
        });
        req.write(checkBody);
        req.end();
    });
}

function openTokenrouterSession(email) {
    const path = require('path');
    const { spawn } = require('child_process');
    // Открываем в Camoufox (как регали), не в Playwright-chromium: тот же
    // движок/фингерпринт, плюс авто-логин сохранёнными кредами в --open режиме
    // (session.json не годится — токен протухает, формат не storageState).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) {
        return { ok: false, error: 'bad email' };
    }
    const script = path.join(PROJECT_ROOT, 'routing', 'tokenrouter', 'camoufox_autoreg.py');
    const args = [script, '--open', email];
    if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', `TokenRouter ${email}`, 'cmd.exe', '/k', 'python', ...args], {
            cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', windowsHide: false,
        }).unref();
    } else {
        spawn('python', args, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
}

// ───── Conduit sessions + cached quotas/balance ────────────────────
// Conduit (conduit.ozdoev.net) — Anthropic-совместимый endpoint, ключи sk-cdt-.
// В отличие от FreeModel, квоты читаются дешёвым cookie-fetch (conduit-manager),
// не Playwright → refresh быстрый, concurrency выше.
let _conduit = null;
function conduitMod() {
    if (!_conduit) _conduit = require('../conduit/lib/conduit-manager');
    return _conduit;
}

const CONDUIT_QUOTA_CACHE = path.join(PROJECT_ROOT, 'logs', '.conduit_quota_cache.json');
const CONDUIT_META_FILE   = path.join(PROJECT_ROOT, 'logs', '.conduit_meta.json');

function loadConduitQuotaCache() {
    try { if (fs.existsSync(CONDUIT_QUOTA_CACHE)) return JSON.parse(fs.readFileSync(CONDUIT_QUOTA_CACHE, 'utf-8')) || {}; } catch {}
    return {};
}
function saveConduitQuotaCache(cache) {
    try { fs.mkdirSync(path.dirname(CONDUIT_QUOTA_CACHE), { recursive: true }); fs.writeFileSync(CONDUIT_QUOTA_CACHE, JSON.stringify(cache, null, 2), 'utf-8'); } catch {}
}
function loadConduitMeta() {
    try { if (fs.existsSync(CONDUIT_META_FILE)) return JSON.parse(fs.readFileSync(CONDUIT_META_FILE, 'utf-8')) || {}; } catch {}
    return {};
}
function saveConduitMeta(meta) {
    try { fs.mkdirSync(path.dirname(CONDUIT_META_FILE), { recursive: true }); fs.writeFileSync(CONDUIT_META_FILE, JSON.stringify(meta, null, 2), 'utf-8'); } catch {}
}

function setConduitBanned(name, banned) {
    const meta = loadConduitMeta();
    meta[name] = meta[name] || {};
    if (banned) { meta[name].banned = true; meta[name].bannedAt = new Date().toISOString(); }
    else { delete meta[name].banned; delete meta[name].bannedAt; }
    saveConduitMeta(meta);
    return meta[name];
}
function setConduitApiKey(name, apiKey) {
    const meta = loadConduitMeta();
    meta[name] = meta[name] || {};
    if (apiKey) meta[name].apiKey = String(apiKey); else delete meta[name].apiKey;
    saveConduitMeta(meta);
    return meta[name];
}

// withQuotas: 'cache' (мгновенно) | 'refresh' (fetch, обновить кеш) | false (только список)
async function listConduitSessions({ withQuotas = 'cache', concurrency = 6 } = {}) {
    const { getConduitAccounts, checkConduitQuota } = conduitMod();
    const sessions = getConduitAccounts();
    const meta = loadConduitMeta();
    const withMeta = (s, extra) => ({ ...s, ...extra, meta: meta[s.name] || {} });
    if (withQuotas === false) return sessions.map(s => withMeta(s, { quota: null }));

    const cache = loadConduitQuotaCache();
    if (withQuotas === 'cache') return sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));

    // refresh — пропускаем banned
    const eligible = sessions.filter(s => !(meta[s.name] || {}).banned);
    const out = sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, eligible.length || 1) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= eligible.length) return;
            try {
                const q = await checkConduitQuota(eligible[i]);
                if (q) {
                    const origIdx = sessions.indexOf(eligible[i]);
                    const val = { ...q, updatedAt: Date.now() };
                    if (origIdx >= 0) out[origIdx].quota = val;
                    cache[eligible[i].name] = val;
                    // мёртвую сессию помечаем в мете (UI покажет 💀)
                    if (q.dead) setConduitBanned(eligible[i].name, true);
                    else if (q.apiKey) { meta[eligible[i].name] = meta[eligible[i].name] || {}; meta[eligible[i].name].apiKey = q.apiKey; }
                }
            } catch { /* keep cached */ }
        }
    });
    await Promise.all(workers);
    saveConduitQuotaCache(cache);
    saveConduitMeta(meta);
    return out;
}

async function refreshOneConduitQuota(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getConduitAccounts, checkConduitQuota } = conduitMod();
    const account = getConduitAccounts().find(s => s.name === name);
    if (!account) throw new Error(`conduit account not found: ${name}`);
    const q = await checkConduitQuota(account);
    const cache = loadConduitQuotaCache();
    if (q) { cache[name] = { ...q, updatedAt: Date.now() }; saveConduitQuotaCache(cache); }
    return cache[name] || null;
}

async function extractConduitApiKey(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getConduitAccounts, extractConduitApiKey: extractKey } = conduitMod();
    const account = getConduitAccounts().find(s => s.name === name);
    if (!account) throw new Error(`conduit account not found: ${name}`);
    return await extractKey(account);
}

// Добавить key-only аккаунт Conduit вручную (без сессии, без ТГ).
// Создаёт папку вида manual_<ts>_<mask> с account_info.txt (API Key + username).
function addConduitKey({ apiKey, username, tgPhone }) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = (username || 'manual').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^@/, '');
    const dirName = `manual_${ts}_${safeName}`;
    const dir = path.join(conduitMod().ACCOUNTS_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
        `Ident: ${safeName}`,
        `Saved: ${new Date().toISOString()}`,
        `Username: ${username || '(?)'}`,
        `Plan: (?)`,
        `Balance: (?)`,
        `API Key: ${apiKey}`,
        `Base URL: https://conduit.ozdoev.net/v1`,
        `Referral: (?)`,
        tgPhone ? `TG Phone: ${tgPhone}` : '',
    ].filter(Boolean);
    fs.writeFileSync(path.join(dir, 'account_info.txt'), lines.join('\n') + '\n', 'utf8');
    // Записываем в мету, чтобы activate сразу работал (ключ есть в meta.apiKey).
    const meta = loadConduitMeta();
    meta[dirName] = meta[dirName] || {};
    meta[dirName].apiKey = apiKey;
    saveConduitMeta(meta);
    return { ok: true, ident: safeName, name: dirName, dir };
}

const CDT_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'cdt-active-key.txt');
function getActiveConduitKey() {
    try { if (fs.existsSync(CDT_ACTIVE_KEY_FILE)) return fs.readFileSync(CDT_ACTIVE_KEY_FILE, 'utf-8').trim(); } catch {}
    return null;
}

// ───── Svrtr sessions + cached quotas ────────────────────────────────
let _svrtr = null;
function svrtrMod() {
    if (!_svrtr) _svrtr = require('../svrtr/lib/svrtr-manager');
    return _svrtr;
}

const SVRTR_QUOTA_CACHE = path.join(PROJECT_ROOT, 'logs', '.svrtr_quota_cache.json');
const SVRTR_META_FILE   = path.join(PROJECT_ROOT, 'logs', '.svrtr_meta.json');

function loadSvrtrQuotaCache() {
    try { if (fs.existsSync(SVRTR_QUOTA_CACHE)) return JSON.parse(fs.readFileSync(SVRTR_QUOTA_CACHE, 'utf-8')) || {}; } catch {}
    return {};
}
function saveSvrtrQuotaCache(cache) {
    try { fs.mkdirSync(path.dirname(SVRTR_QUOTA_CACHE), { recursive: true }); fs.writeFileSync(SVRTR_QUOTA_CACHE, JSON.stringify(cache, null, 2), 'utf-8'); } catch {}
}
function loadSvrtrMeta() {
    try { if (fs.existsSync(SVRTR_META_FILE)) return JSON.parse(fs.readFileSync(SVRTR_META_FILE, 'utf-8')) || {}; } catch {}
    return {};
}
function saveSvrtrMeta(meta) {
    try { fs.mkdirSync(path.dirname(SVRTR_META_FILE), { recursive: true }); fs.writeFileSync(SVRTR_META_FILE, JSON.stringify(meta, null, 2), 'utf-8'); } catch {}
}
function setSvrtrBanned(name, banned) {
    const meta = loadSvrtrMeta();
    meta[name] = meta[name] || {};
    if (banned) { meta[name].banned = true; meta[name].bannedAt = new Date().toISOString(); }
    else { delete meta[name].banned; delete meta[name].bannedAt; }
    saveSvrtrMeta(meta);
    return meta[name];
}
function setSvrtrApiKey(name, apiKey) {
    const meta = loadSvrtrMeta();
    meta[name] = meta[name] || {};
    if (apiKey) meta[name].apiKey = String(apiKey); else delete meta[name].apiKey;
    saveSvrtrMeta(meta);
    return meta[name];
}

async function listSvrtrSessions({ withQuotas = 'cache', concurrency = 6 } = {}) {
    const { getSvrtrAccounts, checkSvrtrQuota } = svrtrMod();
    const sessions = getSvrtrAccounts();
    const meta = loadSvrtrMeta();
    const withMeta = (s, extra) => ({ ...s, ...extra, meta: meta[s.name] || {} });
    if (withQuotas === false) return sessions.map(s => withMeta(s, { quota: null }));

    const cache = loadSvrtrQuotaCache();
    if (withQuotas === 'cache') return sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));

    const eligible = sessions.filter(s => !(meta[s.name] || {}).banned);
    const out = sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, eligible.length || 1) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= eligible.length) return;
            try {
                const q = await checkSvrtrQuota(eligible[i]);
                if (q) {
                    const origIdx = sessions.indexOf(eligible[i]);
                    const val = { ...q, updatedAt: Date.now() };
                    if (origIdx >= 0) out[origIdx].quota = val;
                    cache[eligible[i].name] = val;
                    if (q.dead) setSvrtrBanned(eligible[i].name, true);
                    else if (q.apiKey) { meta[eligible[i].name] = meta[eligible[i].name] || {}; meta[eligible[i].name].apiKey = q.apiKey; }
                }
            } catch { /* keep cached */ }
        }
    });
    await Promise.all(workers);
    saveSvrtrQuotaCache(cache);
    saveSvrtrMeta(meta);
    return out;
}

async function refreshOneSvrtrQuota(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getSvrtrAccounts, checkSvrtrQuota } = svrtrMod();
    const account = getSvrtrAccounts().find(s => s.name === name);
    if (!account) throw new Error(`svrtr account not found: ${name}`);
    const q = await checkSvrtrQuota(account);
    const cache = loadSvrtrQuotaCache();
    if (q) { cache[name] = { ...q, updatedAt: Date.now() }; saveSvrtrQuotaCache(cache); }
    return cache[name] || null;
}

async function extractSvrtrApiKey(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getSvrtrAccounts, extractSvrtrApiKey: extractKey } = svrtrMod();
    const account = getSvrtrAccounts().find(s => s.name === name);
    if (!account) throw new Error(`svrtr account not found: ${name}`);
    return await extractKey(account);
}

function addSvrtrKey({ apiKey, username, tgPhone }) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = (username || 'manual').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^@/, '');
    const dirName = `manual_${ts}_${safeName}`;
    const dir = path.join(svrtrMod().ACCOUNTS_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
        `Ident: ${safeName}`,
        `Saved: ${new Date().toISOString()}`,
        `Username: ${username || '(?)'}`,
        `API Key: ${apiKey}`,
        `Base URL: https://api.svrtr.org`,
        tgPhone ? `TG Phone: ${tgPhone}` : '',
    ].filter(Boolean);
    fs.writeFileSync(path.join(dir, 'account_info.txt'), lines.join('\n') + '\n', 'utf8');
    const meta = loadSvrtrMeta();
    meta[dirName] = meta[dirName] || {};
    meta[dirName].apiKey = apiKey;
    saveSvrtrMeta(meta);
    return { ok: true, ident: safeName, name: dirName, dir };
}

const SR_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'sr-active-key.txt');
function getActiveSvrtrKey() {
    try { if (fs.existsSync(SR_ACTIVE_KEY_FILE)) return fs.readFileSync(SR_ACTIVE_KEY_FILE, 'utf-8').trim(); } catch {}
    return null;
}

// ───── HelpCoder sessions + cached quotas ────────────────────────────
let _helpcoder = null;
function helpcoderMod() {
    if (!_helpcoder) _helpcoder = require('../helpcoder/lib/helpcoder-manager');
    return _helpcoder;
}

const HC_QUOTA_CACHE = path.join(PROJECT_ROOT, 'logs', '.helpcoder_quota_cache.json');
const HC_META_FILE   = path.join(PROJECT_ROOT, 'logs', '.helpcoder_meta.json');

function loadHelpcoderQuotaCache() {
    try { if (fs.existsSync(HC_QUOTA_CACHE)) return JSON.parse(fs.readFileSync(HC_QUOTA_CACHE, 'utf-8')) || {}; } catch {}
    return {};
}
function saveHelpcoderQuotaCache(cache) {
    try { fs.mkdirSync(path.dirname(HC_QUOTA_CACHE), { recursive: true }); fs.writeFileSync(HC_QUOTA_CACHE, JSON.stringify(cache, null, 2), 'utf-8'); } catch {}
}
function loadHelpcoderMeta() {
    try { if (fs.existsSync(HC_META_FILE)) return JSON.parse(fs.readFileSync(HC_META_FILE, 'utf-8')) || {}; } catch {}
    return {};
}
function saveHelpcoderMeta(meta) {
    try { fs.mkdirSync(path.dirname(HC_META_FILE), { recursive: true }); fs.writeFileSync(HC_META_FILE, JSON.stringify(meta, null, 2), 'utf-8'); } catch {}
}
function setHelpcoderBanned(name, banned) {
    const meta = loadHelpcoderMeta();
    meta[name] = meta[name] || {};
    if (banned) { meta[name].banned = true; meta[name].bannedAt = new Date().toISOString(); }
    else { delete meta[name].banned; delete meta[name].bannedAt; }
    saveHelpcoderMeta(meta);
    return meta[name];
}
function setHelpcoderApiKey(name, apiKey) {
    const meta = loadHelpcoderMeta();
    meta[name] = meta[name] || {};
    if (apiKey) meta[name].apiKey = String(apiKey); else delete meta[name].apiKey;
    saveHelpcoderMeta(meta);
    return meta[name];
}

async function listHelpcoderSessions({ withQuotas = 'cache', concurrency = 6 } = {}) {
    const { getHelpcoderAccounts, checkHelpcoderQuota } = helpcoderMod();
    const sessions = getHelpcoderAccounts();
    const meta = loadHelpcoderMeta();
    const withMeta = (s, extra) => ({ ...s, ...extra, meta: meta[s.name] || {} });
    if (withQuotas === false) return sessions.map(s => withMeta(s, { quota: null }));

    const cache = loadHelpcoderQuotaCache();
    if (withQuotas === 'cache') return sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));

    const eligible = sessions.filter(s => !(meta[s.name] || {}).banned);
    const out = sessions.map(s => withMeta(s, { quota: cache[s.name] || null }));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, eligible.length || 1) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= eligible.length) return;
            try {
                const q = await checkHelpcoderQuota(eligible[i]);
                if (q) {
                    const origIdx = sessions.indexOf(eligible[i]);
                    const val = { ...q, updatedAt: Date.now() };
                    if (origIdx >= 0) out[origIdx].quota = val;
                    cache[eligible[i].name] = val;
                    if (q.dead) setHelpcoderBanned(eligible[i].name, true);
                    else if (q.apiKey) { meta[eligible[i].name] = meta[eligible[i].name] || {}; meta[eligible[i].name].apiKey = q.apiKey; }
                }
            } catch { /* keep cached */ }
        }
    });
    await Promise.all(workers);
    saveHelpcoderQuotaCache(cache);
    saveHelpcoderMeta(meta);
    return out;
}

async function refreshOneHelpcoderQuota(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getHelpcoderAccounts, checkHelpcoderQuota } = helpcoderMod();
    const account = getHelpcoderAccounts().find(s => s.name === name);
    if (!account) throw new Error(`helpcoder account not found: ${name}`);
    const q = await checkHelpcoderQuota(account);
    const cache = loadHelpcoderQuotaCache();
    if (q) { cache[name] = { ...q, updatedAt: Date.now() }; saveHelpcoderQuotaCache(cache); }
    return cache[name] || null;
}

async function extractHelpcoderApiKey(name) {
    if (!name || /[\\/]/.test(name)) throw new Error('bad session name');
    const { getHelpcoderAccounts, extractHelpcoderApiKey: extractKey } = helpcoderMod();
    const account = getHelpcoderAccounts().find(s => s.name === name);
    if (!account) throw new Error(`helpcoder account not found: ${name}`);
    return await extractKey(account);
}

function addHelpcoderKey({ apiKey, username }) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = (username || 'manual').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^@/, '');
    const dirName = `manual_${ts}_${safeName}`;
    const dir = path.join(helpcoderMod().ACCOUNTS_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
        `Ident: ${safeName}`,
        `Saved: ${new Date().toISOString()}`,
        `Username: ${username || '(?)'}`,
        `API Key: ${apiKey}`,
        `Base URL: https://helpcoder.cc`,
    ].filter(Boolean);
    fs.writeFileSync(path.join(dir, 'account_info.txt'), lines.join('\n') + '\n', 'utf8');
    const meta = loadHelpcoderMeta();
    meta[dirName] = meta[dirName] || {};
    meta[dirName].apiKey = apiKey;
    saveHelpcoderMeta(meta);
    return { ok: true, ident: safeName, name: dirName, dir };
}

const HC_ACTIVE_KEY_FILE = path.join(os.homedir(), '.claude', 'hc-active-key.txt');
function getActiveHelpcoderKey() {
    try { if (fs.existsSync(HC_ACTIVE_KEY_FILE)) return fs.readFileSync(HC_ACTIVE_KEY_FILE, 'utf-8').trim(); } catch {}
    return null;
}

module.exports = {
    listNotionSessions,
    listFreemodelSessions,
    listConduitSessions,
    refreshOneConduitQuota,
    extractConduitApiKey,
    addConduitKey,
    setConduitBanned,
    setConduitApiKey,
    getActiveConduitKey,
    loadConduitMeta,
    listDevinSessions,
    listOmniAccountsWithQuotas,
    toggleOmniAccount,
    openSessionInBrowser,
    refreshOneFreemodelQuota,
    fmIsZeroBalance,
    fmHasMoney,
    fmIsCooling,
    syncFmAutoBan,
    syncFmAccountState,
    refreshOneDevinQuota,
    deleteSession,
    getNotionCards,
    setNotionCardIndex,
    launchScript,
    getEmailBackend,
    setEmailBackend,
    getEmailDomain,
    setEmailDomain,
    listEmailDomains,
    launchBatFile,
    sqliteJson,
    setFreemodelBanned,
    setFreemodelTgPhone,
    setFreemodelApiKey,
    extractFreemodelApiKey,
    checkTokenrouterKey,
    checkTokenrouterUsage,
    getCachedTrUsage,
    getActiveFreemodelKey,
    openTokenrouterSession,
    loadFreemodelMeta,
    listAmodelAccounts,
    launchAmodelAutoreger,
    listSvrtrSessions,
    refreshOneSvrtrQuota,
    extractSvrtrApiKey,
    addSvrtrKey,
    setSvrtrBanned,
    setSvrtrApiKey,
    getActiveSvrtrKey,
    loadSvrtrMeta,
    listHelpcoderSessions,
    refreshOneHelpcoderQuota,
    extractHelpcoderApiKey,
    addHelpcoderKey,
    setHelpcoderBanned,
    setHelpcoderApiKey,
    getActiveHelpcoderKey,
    loadHelpcoderMeta,
};

// ───── AnyModel accounts ──────────────────────────────────────
// anymodel/accounts/account_*.json — результат anymodel_autoreger.js
const AMODEL_ACCOUNTS_DIR = path.join(PROJECT_ROOT, 'anymodel', 'accounts');

function listAmodelAccounts() {
    try {
        if (!fs.existsSync(AMODEL_ACCOUNTS_DIR)) return [];
        const files = fs.readdirSync(AMODEL_ACCOUNTS_DIR).filter(f => /^account_\d+\.json$/.test(f));
        return files.map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(AMODEL_ACCOUNTS_DIR, f), 'utf-8')); }
            catch { return null; }
        }).filter(Boolean).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    } catch { return []; }
}

function launchAmodelAutoreger(count) {
    return launchScript('anymodel-create', [String(count)]);
}


