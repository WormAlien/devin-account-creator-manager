// routing/lib/truesota-account.js
//
// Аккаунт TrueSOTA (`true-sota.com`): токены панели, точная квота, API-ключи.
//
// 🪤 Панель — НЕ New-API. Это открытый **sub2api** (github.com/Wei-Shaw/sub2api,
// LGPL-3.0): Go+Vue шлюз, который раздаёт квоту подписок (Claude, Codex, Gemini,
// Grok, Antigravity) как API-ключи. Поэтому `routing/lib/newapi-account.js` тут не
// подходит ни одной функцией: у New-API `/api/status` + `/api/user/self` + кука
// `session`, у sub2api — `/api/v1/*`, JWT в **localStorage** и подписки вместо
// кошелька. Замер 2026-08-25: `GET /api/status` → 404, `GET /api/v1/keys` → 401
// `{"code":"UNAUTHORIZED"}`, `site_name: "TrueSOTA"` в `/api/v1/settings/public`.
//
// Что отсюда нужно вкладке:
//   • токен панели  — JWT живёт в localStorage (`auth_token` + `refresh_token`),
//                     а не в куке, поэтому читаем его из профиля Chromium и
//                     продлеваем через `POST /api/v1/auth/refresh`;
//   • точная квота  — `GET /api/v1/subscriptions/summary` (лимиты 5h/1d/7d/месяц в
//                     USD) и `GET /api/v1/keys` (quota/quota_used на КЛЮЧ);
//   • ключ          — `POST /api/v1/keys {name}` отдаёт полный ключ в `data.key`.
//
// Формы ответов сняты не с глаза, а с исходников панели (`internal/handler/
// api_key_handler.go`, `subscription_handler.go`, `handler/dto/types.go`,
// `server/routes/{auth,user}.go` на ревизии main от 2026-08-25) — поэтому поля
// названы точно, а не угаданы по одному живому ответу.

const fs = require('fs');
const path = require('path');

const HOST = 'true-sota.com';
const API = `https://${HOST}/api/v1`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

// Банка токенов: отдельный файл, а не `newapi-jar.json` — там куки New-API, схема
// другая, и мешать их в одном файле значит подложить грабли обоим.
// Ключ записи — label профиля (`acct_<id>`), как в newapi-jar.
const JAR_FILE = path.join(__dirname, '..', 'truesota-jar.json');

function loadJar() {
    try {
        const raw = fs.readFileSync(JAR_FILE, 'utf8');
        const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return (j && typeof j === 'object') ? j : {};
    } catch { return {}; }
}

function saveJar(jar) {
    try { fs.writeFileSync(JAR_FILE, JSON.stringify(jar, null, 2) + '\n', 'utf8'); } catch {}
}

// ───────────────────────────── HTTP-клиент панели ─────────────────────────────
//
// Ответы sub2api завёрнуты в конверт `{code, message, data}` (`response.Success`),
// причём `code: 0` = успех. Ошибки приходят строкой в `code` (`UNAUTHORIZED`,
// `API_KEY_REQUIRED`) — то есть тип поля меняется, и сравнивать нужно с нулём
// ЧИСЛОМ, иначе `code === 0` не сработает на строке и наоборот.
async function api(pathname, { token = null, method = 'GET', body = null } = {}) {
    const headers = { 'User-Agent': UA, 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
        res = await fetch(`${API}${pathname}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (e) {
        return { status: 0, json: null, error: e.message };
    }
    let json = null;
    try { json = await res.json(); } catch {}
    const envelope = json && typeof json === 'object' ? json : null;
    const ok = res.status === 200 && envelope && Number(envelope.code) === 0;
    return {
        status: res.status,
        json: envelope,
        data: envelope ? envelope.data : null,
        ok,
        error: ok ? null : (envelope && (envelope.message || envelope.code)) || `HTTP ${res.status}`,
    };
}

// Продление токена. Refresh одноразовый: ответ несёт НОВЫЙ `refresh_token`, и
// старый после обмена мёртв — поэтому пару сразу пишем в банку, иначе следующий
// чек пойдёт с погашенным токеном и аккаунт «разлогинится» сам.
async function refreshTokens(refresh) {
    if (!refresh) return { ok: false, error: 'нет refresh-токена' };
    const r = await api('/auth/refresh', { method: 'POST', body: { refresh_token: refresh } });
    if (!r.ok) return { ok: false, error: `refresh: ${r.error}` };
    const d = r.data || {};
    if (!d.access_token) return { ok: false, error: 'refresh без access_token' };
    return {
        ok: true,
        access: d.access_token,
        refresh: d.refresh_token || refresh,
        expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000,
    };
}

// ──────────────────── токены панели: снять с профиля и держать ────────────────────
//
// JWT sub2api лежит в **localStorage** профиля (`auth_token`, `refresh_token`,
// `token_expires_at`, `auth_user`), а не в куке. Прочитать localStorage из закрытого
// профиля так, как newapi-account читает куки (sqlite + DPAPI), нельзя: Chromium
// держит его в leveldb (`Default/Local Storage/leveldb`), и парсер leveldb ради двух
// строк — лишняя зависимость. Поэтому поднимаем ТОТ ЖЕ профиль headless на пару
// секунд и читаем localStorage штатно, страницей.
//
// 🪤 Профиль занят, если окно ЛК этого аккаунта открыто: Chromium держит его
// исключительно, и запуск падает. Это НЕ «токена нет» — текст ошибки обязан звать
// закрыть окно, иначе владелец идёт открывать ЛК ещё раз и держит замок дальше
// (ровно эта петля описана в newapi-account.js § cookieFailReason).
const HARVEST_TIMEOUT_MS = 45000;

async function harvestFromProfile(profileDir) {
    if (!profileDir) return { ok: false, error: 'у аккаунта нет браузерного профиля' };
    try { if (!fs.existsSync(profileDir)) return { ok: false, error: 'профиль не создан — открой ЛК (🌐) и войди' }; }
    catch {}
    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch (e) { return { ok: false, error: `playwright не загружается: ${e.message}` }; }

    let context = null;
    try {
        context = await chromium.launchPersistentContext(profileDir, {
            headless: true,
            args: ['--disable-blink-features=AutomationControlled'],
            timeout: HARVEST_TIMEOUT_MS,
        });
        const page = context.pages()[0] || await context.newPage();
        // Навигация нужна: localStorage привязан к origin, без документа его не прочитать.
        // `domcontentloaded` достаточно — SPA поднимать незачем, ключи уже на диске.
        await page.goto(`https://${HOST}/`, { waitUntil: 'domcontentloaded', timeout: HARVEST_TIMEOUT_MS });
        const ls = await page.evaluate(() => {
            const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
            return {
                access: get('auth_token'),
                refresh: get('refresh_token'),
                expiresAt: get('token_expires_at'),
                user: get('auth_user'),
            };
        });
        if (!ls || (!ls.access && !ls.refresh)) {
            return { ok: false, error: 'в профиле нет токена панели — открой ЛК (🌐) и войди через GitHub' };
        }
        let email = null, userId = null;
        try { const u = JSON.parse(ls.user || 'null'); if (u) { email = u.email || null; userId = u.id != null ? Number(u.id) : null; } } catch {}
        return {
            ok: true,
            access: ls.access || null,
            refresh: ls.refresh || null,
            // Штамп в localStorage — миллисекунды epoch (`Ae(expires_in)` в бандле).
            expiresAt: Number(ls.expiresAt) || 0,
            email, userId,
        };
    } catch (e) {
        const msg = String((e && e.message) || e);
        const locked = /ProcessSingleton|SingletonLock|being used by another|Failed to create a ProcessSingleton|EBUSY|EPERM/i.test(msg);
        return {
            ok: false,
            error: locked
                ? 'браузер этого аккаунта ОТКРЫТ — Chromium держит профиль, токен прочитать нельзя. Закрой окно ЛК, перечёт пойдёт сам'
                : `не смог снять токен с профиля: ${msg.split('\n')[0].slice(0, 140)}`,
        };
    } finally {
        if (context) await context.close().catch(() => {});
    }
}

// Живой токен для аккаунта. Порядок дешёвый → дорогой, и каждый шаг что-то кеширует:
//   1. банка: access ещё не истёк (с запасом 60 с) — сеть не нужна вообще;
//   2. банка: есть refresh — один POST /auth/refresh;
//   3. профиль: снимаем localStorage headless-запуском (2–3 с) и повторяем шаг 2.
// Шаг 3 отдельный, потому что refresh в банке может быть погашен (владелец зашёл в
// ЛК руками — панель ротировала пару, наша копия устарела).
const SKEW_MS = 60_000;

async function tokenFor(label, profileDir, { force = false } = {}) {
    const jar = loadJar();
    const entry = jar[label] || {};
    if (!force && entry.access && Number(entry.accessExpiresAt) - Date.now() > SKEW_MS) {
        return { ok: true, token: entry.access, from: 'jar' };
    }
    if (entry.refresh) {
        const rt = await refreshTokens(entry.refresh);
        if (rt.ok) {
            const j = loadJar();
            j[label] = { ...(j[label] || {}), access: rt.access, refresh: rt.refresh, accessExpiresAt: rt.expiresAt, updatedAt: new Date().toISOString() };
            saveJar(j);
            return { ok: true, token: rt.access, from: 'refresh' };
        }
    }
    const h = await harvestFromProfile(profileDir);
    if (!h.ok) return { ok: false, error: h.error };
    // Снятый access может быть ещё живым — тогда refresh не жжём.
    let access = h.access, refresh = h.refresh, expiresAt = h.expiresAt;
    if (!access || expiresAt - Date.now() <= SKEW_MS) {
        const rt = await refreshTokens(refresh);
        if (!rt.ok) return { ok: false, error: `${rt.error} (токен из профиля просрочен — войди в ЛК заново)` };
        access = rt.access; refresh = rt.refresh; expiresAt = rt.expiresAt;
    }
    const j = loadJar();
    j[label] = {
        ...(j[label] || {}),
        access, refresh, accessExpiresAt: expiresAt,
        email: h.email || (j[label] || {}).email || null,
        userId: h.userId != null ? h.userId : (j[label] || {}).userId,
        updatedAt: new Date().toISOString(),
        harvestedAt: new Date().toISOString(),
    };
    saveJar(j);
    return { ok: true, token: access, from: 'profile' };
}

// ─────────────────────────── вызовы панели (нужен JWT) ───────────────────────────

async function me(token) {
    const r = await api('/auth/me', { token });
    return r.ok ? { ok: true, user: r.data } : { ok: false, error: r.error };
}

// Список ключей аккаунта. `key` в списке панель отдаёт замаскированным
// (`maskApiKey` в бандле), поэтому для сопоставления с нашим активным ключом
// сравниваем ХВОСТЫ, а не строки целиком.
async function listKeys(token) {
    const r = await api('/keys', { token });
    if (!r.ok) return { ok: false, error: r.error, keys: [] };
    const d = r.data || {};
    const items = Array.isArray(d) ? d : (d.items || d.records || d.keys || []);
    return { ok: true, keys: items };
}

// Создание ключа: ответ несёт ПОЛНЫЙ ключ в `data.key` (dto.APIKey.Key) — второй
// раз его не покажут, поэтому вызывающий обязан сразу записать значение в пул.
// `name` обязателен (binding:"required"), остальное панель заполняет дефолтами.
async function createKey(token, name, opts = {}) {
    const body = { name: String(name || 'claude-code').slice(0, 64) };
    if (opts.groupId != null) body.group_id = Number(opts.groupId);
    if (opts.quota != null) body.quota = Number(opts.quota);
    if (opts.expiresInDays != null) body.expires_in_days = Number(opts.expiresInDays);
    const r = await api('/keys', { token, method: 'POST', body });
    if (!r.ok) return { ok: false, error: r.error };
    const d = r.data || {};
    if (!d.key) return { ok: false, error: 'панель не отдала значение ключа' };
    return { ok: true, key: d.key, id: d.id, name: d.name, quota: d.quota, groupId: d.group_id };
}

// Доступные группы (тарифы) — нужны, чтобы ключ создавался в группе с Claude,
// а не в дефолтной, если у аккаунта их несколько.
async function availableGroups(token) {
    const r = await api('/groups/available', { token });
    if (!r.ok) return { ok: false, error: r.error, groups: [] };
    const d = r.data || {};
    return { ok: true, groups: Array.isArray(d) ? d : (d.items || d.groups || []) };
}

// Подписки: лимиты и расход в USD по окнам 1d/7d/месяц.
// Поля — из dto.UserSubscription: {group_name, daily_used_usd, daily_limit_usd,
// weekly_*, monthly_*, expires_at, status}; конверт summary — {active_count,
// total_used_usd, subscriptions:[…]}.
async function subscriptionSummary(token) {
    const r = await api('/subscriptions/summary', { token });
    if (!r.ok) return { ok: false, error: r.error };
    const d = r.data || {};
    return {
        ok: true,
        activeCount: Number(d.active_count) || 0,
        totalUsedUsd: Number(d.total_used_usd) || 0,
        subscriptions: Array.isArray(d.subscriptions) ? d.subscriptions : [],
    };
}

// ───────────────────────────── живость ключа и квота ─────────────────────────────
//
// Живость проверяем САМИМ ключом, без токена панели: `GET /v1/models` без ключа
// отвечает 401 `API_KEY_REQUIRED`, с рабочим — 200 (замер 2026-08-25). Это
// единственная проверка, которая не зависит ни от профиля, ни от JWT, поэтому
// «ключ мёртв» мы говорим только по ней — иначе истёкший токен панели выглядел бы
// как сдохший ключ и вкладка вышибала бы живые ключи из ротации.
async function keyAlive(apiKey) {
    let res;
    try {
        res = await fetch(`https://${HOST}/v1/models`, {
            headers: { 'User-Agent': UA, 'x-api-key': apiKey, 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (e) { return { status: 'unknown', error: e.message }; }
    if (res.status === 200) return { status: 'live' };
    if (res.status === 401 || res.status === 403) return { status: 'dead' };
    return { status: 'unknown', error: `models HTTP ${res.status}` };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Самое узкое окно подписки: считаем остаток по каждому объявленному лимиту и
// берём минимум. Лимит 0 у sub2api = «без ограничения» (см. комментарии в
// CreateAPIKeyRequest), поэтому нули в расчёт не идут — иначе аккаунт без
// дневного лимита показывал бы остаток $0 и его бы вышибло из ротации.
function tightestWindow(sub) {
    const windows = [
        { window: '5h', limit: sub.rate_limit_5h, used: sub.usage_5h },
        { window: 'сутки', limit: sub.daily_limit_usd, used: sub.daily_used_usd },
        { window: 'неделя', limit: sub.weekly_limit_usd, used: sub.weekly_used_usd },
        { window: 'месяц', limit: sub.monthly_limit_usd, used: sub.monthly_used_usd },
    ];
    let best = null;
    for (const w of windows) {
        const limit = Number(w.limit) || 0;
        if (limit <= 0) continue;
        const used = Number(w.used) || 0;
        const left = round2(limit - used);
        if (!best || left < best.balance) best = { window: w.window, limit: round2(limit), used: round2(used), balance: left };
    }
    return best;
}

// Точная квота аккаунта. Формат возврата — тот же, что у newapiBalance, чтобы
// вкладка могла звать общий newapiApplyBalance без правок:
//   { status, balance, spent, balanceSource, granted, window?, quotaError? }
//
// Приоритет источников цифры:
//   1. КЛЮЧ (`/keys`, поля quota/quota_used) — если у самого ключа задан лимит,
//      он и есть потолок: подписка может разрешать больше, чем ключ.
//   2. ПОДПИСКА (`/subscriptions/summary`) — самое узкое окно с ненулевым лимитом.
//   3. только живость (`/v1/models`) — когда токена панели нет; цифру не выдумываем,
//      `balance: null`, а причина уезжает в quotaError и видна в UI.
async function balance({ target, label, profileDir, force = false }) {
    const apiKey = target && target.api_key;
    if (!apiKey || apiKey === 'dummy' || String(apiKey).length < 8) {
        return { status: 'no_key', error: 'ключа ещё нет' };
    }
    const alive = await keyAlive(apiKey);
    if (alive.status !== 'live') return alive;

    const t = await tokenFor(label, profileDir, { force });
    if (!t.ok) {
        return { status: 'live', balance: null, spent: null, balanceSource: 'probe', quotaError: t.error };
    }

    const tail = String(apiKey).slice(-6);
    const keys = await listKeys(t.token);
    const mine = (keys.keys || []).find(k => String(k.key || '').slice(-6) === tail);
    if (mine && Number(mine.quota) > 0) {
        const used = Number(mine.quota_used) || 0;
        return {
            status: 'live',
            balance: round2(Number(mine.quota) - used),
            spent: round2(used),
            granted: round2(Number(mine.quota)),
            balanceSource: 'key',
            keyId: mine.id,
            keyName: mine.name,
            window: 'ключ',
        };
    }

    const sum = await subscriptionSummary(t.token);
    if (!sum.ok) {
        return {
            status: 'live',
            balance: null,
            spent: mine ? round2(Number(mine.quota_used) || 0) : null,
            balanceSource: 'probe',
            quotaError: `подписки: ${sum.error}`,
        };
    }
    // Берём подписку самого узкого окна среди активных. `status` панель ставит
    // строкой ('active'/'expired'/…) — просроченные в расчёт не идут.
    let best = null;
    for (const sub of sum.subscriptions) {
        if (sub.status && String(sub.status).toLowerCase() !== 'active') continue;
        const w = tightestWindow(sub);
        if (w && (!best || w.balance < best.balance)) best = { ...w, groupName: sub.group_name || null, expiresAt: sub.expires_at || null };
    }
    if (!best) {
        // Подписка есть, но лимитов не объявлено — это законная конфигурация
        // («без ограничения»), а не ошибка. Показываем расход, остаток честно пустой.
        return {
            status: 'live',
            balance: null,
            spent: round2(sum.totalUsedUsd),
            balanceSource: 'subscription',
            granted: null,
            window: sum.activeCount ? 'без лимита' : 'нет подписки',
            quotaError: sum.activeCount ? null : 'у аккаунта нет активной подписки — квоты на Claude может не быть',
        };
    }
    return {
        status: 'live',
        balance: best.balance,
        spent: round2(best.used),
        granted: best.limit,
        balanceSource: 'subscription',
        window: best.window,
        groupName: best.groupName,
        accessUntil: best.expiresAt || undefined,
    };
}

module.exports = {
    HOST, API,
    api, refreshTokens, harvestFromProfile, tokenFor,
    me, listKeys, createKey, availableGroups, subscriptionSummary,
    keyAlive, balance, tightestWindow,
    loadJar, saveJar, JAR_FILE,
};
