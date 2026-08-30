// routing/lib/github-session.js
//
// Индекс живых GitHub-сессий, разложенных по профилям Chromium всех модулей.
//
// Зачем: у каждого аккаунта New-API свой персистентный профиль браузера, и GitHub в нём
// логинится с нуля — логин + пароль + 2FA. При этом ровно эта GitHub-сессия обычно уже
// лежит в профиле другого провайдера: профили куками не делятся, вот и весь механизм.
// Замер на 2026-08-19: 42 профиля на диске, 14 уникальных GitHub-аккаунтов, 1.87 ГБ;
// presentkid/impeccableso/exhaustedar залогинены в пяти профилях каждый.
//
// Что делает модуль: находит, где лежит сессия нужного GitHub-аккаунта, проверяет что она
// ещё жива, и кеширует снимок в github/sessions/<ghId>.json — оттуда его вливают в свежий
// профиль нового аккаунта (см. <provider>/open-session.js → applyImportedSession).
//
// Куки читаем из профилей НАПРЯМУЮ (newapi-account.readProfileCookies), браузер не
// запускаем — этого хватает, чтобы узнать ЧЕЙ профиль и жива ли сессия. Но атрибуты кук
// (path/secure/httpOnly/sameSite/expires) оттуда не приходят, а среди семи GitHub-кук есть
// __Host-user_session_same_site, и её __Host--префикс требует Secure + Path=/ + host-only.
// Синтезировать это вслепую нельзя, поэтому САМ СНИМОК для заселения делает Playwright
// (github/harvest-session.js → context.storageState()), а мы его только кешируем.

const fs = require('fs');
const path = require('path');

const nac = require('./newapi-account.js');

const ROOT = path.join(__dirname, '..', '..');

// Где вообще живут профили Chromium с GitHub-сессиями. tag совпадает с префиксом
// вкладки дашборда, host — тот же ключ, что в NEWAPI_PROFILE_DIRS/HOST_AUTH.
// У github/profiles хоста нет: это хранилище самих GitHub-аккаунтов, не провайдер.
const PROFILE_ROOTS = [
    { tag: 'github', dir: path.join(ROOT, 'github', 'profiles'), host: null },
    { tag: 'ar', dir: path.join(ROOT, 'agentrouter', 'profiles'), host: 'agentrouter.org' },
    { tag: 'go', dir: path.join(ROOT, 'gorouter', 'profiles'), host: 'gorouter.app' },
    { tag: 'tb', dir: path.join(ROOT, 'tabi', 'profiles'), host: 'tabitoken.com' },
    { tag: 'xp', dir: path.join(ROOT, 'xpeach', 'profiles'), host: 'xpeach.codes' },
    // 🪤 У JustWoker хост с поддоменом (`api.justwoker.icu`): панель и API живут на одном
    // адресе, `justwoker.icu` не резолвится. Строка обязана совпадать с NEWAPI_PROFILE_DIRS
    // и HOST_AUTH буквально, иначе hostToTag вернёт null и профиль выпадет из индекса.
    { tag: 'jw', dir: path.join(ROOT, 'justwoker', 'profiles'), host: 'api.justwoker.icu' },
    // TrueSOTA (2026-08-25). Хост без поддомена: панель и шлюз на одном `true-sota.com`.
    // 🪤 Панель тут НЕ New-API (это sub2api), но в этом индексе панель ни при чём — он
    // про GitHub-куки в профилях, а они одинаковы у любого провайдера. Без строки
    // hostToTag('true-sota.com') вернул бы null, и заселение GitHub отвечало бы
    // «неизвестный хост» (ровно так и осталось у seekai, которого здесь нет).
    { tag: 'ts', dir: path.join(ROOT, 'truesota', 'profiles'), host: 'true-sota.com' },
    // KKtoken (2026-08-31), по образцу go: New API, хост без поддомена — панель и шлюз
    // оба на `kktoken.cc`. Без строки hostToTag('kktoken.cc') вернул бы null, и заселение
    // GitHub-сессии отвечало бы «неизвестный хост».
    { tag: 'kk', dir: path.join(ROOT, 'kktoken', 'profiles'), host: 'kktoken.cc' },
];

const SESSIONS_DIR = path.join(ROOT, 'github', 'sessions');
const HARVEST_SCRIPT = path.join(ROOT, 'github', 'harvest-session.js');

// Через сколько кешированный снимок считаем устаревшим. GitHub-сессия — скользящая,
// живёт около двух недель; семь суток дают запас и не заставляют харвестить на каждый чих.
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

function tagToHost(tag) {
    const r = PROFILE_ROOTS.find(x => x.tag === tag);
    return r ? r.host : null;
}
function hostToTag(host) {
    const r = PROFILE_ROOTS.find(x => x.host === host);
    return r ? r.tag : null;
}

// ───────────────────────── скан профилей ─────────────────────────

// Все профили, в которых есть GitHub-логин. lastUpdate — когда GitHub последний раз
// ротировал куку в этом профиле: по нему выбираем самый свежий источник.
// hasUserSession отделяет реально залогиненный профиль от того, где остались только
// _octo/_device_id после захода на github.com без входа.
//
// Три уровня защиты от «модалка молчит полминуты»:
//   1. ИНДЕКС НА ДИСКЕ. Расшифровка одной банки кук требует DPAPI (процесс PowerShell,
//      ~650 мс) + чтение sqlite. На 41 профиле это 27 секунд, и платить их при каждом
//      старте дашборда незачем: профиль меняется только когда ты в нём сидел. Держим
//      _profile-index.json и сверяем по mtime файла Cookies — совпал, значит запись годна.
//   2. БАТЧ. Профили, которые всё-таки надо расшифровать, греем одним вызовом PowerShell
//      (nac.warmAesKeys), а не по процессу на каждый.
//   3. КЕШ В ПАМЯТИ на 60 с (scanProfilesCached) — на повторные открытия модалки.
const INDEX_FILE = path.join(SESSIONS_DIR, '_profile-index.json');
const INDEX_VERSION = 1;

// Статистика последнего скана — чтобы вызывающая сторона написала её в лог. Молча
// проглоченный откат на медленный путь один раз уже стоил получаса разбирательств.
let lastScanStats = null;
function scanStats() { return lastScanStats; }

function cookiesMtime(dir) {
    try { return fs.statSync(path.join(dir, 'Default', 'Network', 'Cookies')).mtimeMs; }
    catch { return 0; }
}

function loadIndex() {
    try {
        const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
        return (j && j.version === INDEX_VERSION && j.entries) ? j.entries : {};
    } catch { return {}; }
}

function saveIndex(entries) {
    try {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(INDEX_FILE, JSON.stringify({ version: INDEX_VERSION, entries }, null, 1) + '\n', 'utf8');
    } catch { /* индекс — ускоритель, без него всё работает, просто медленнее */ }
}

// Архивный профиль — тот, что уведён в сторону при пересоздании (`_old_<label>_<ts>`).
// Он остаётся годным ИСТОЧНИКОМ GitHub-сессии (кука в нём живая), но «занятости хоста»
// уже не означает: аккаунт провайдера, к которому он относился, мог быть удалён.
// Иначе один раз использованный GitHub числился бы занятым навсегда.
function isArchivedLabel(label) {
    return /^_old_/.test(String(label || ''));
}

function scanProfiles() {
    const t0 = Date.now();
    const cached = loadIndex();
    const next = {};
    const flat = [];
    for (const root of PROFILE_ROOTS) {
        let labels;
        try {
            labels = fs.readdirSync(root.dir).filter(d => {
                try { return fs.statSync(path.join(root.dir, d)).isDirectory(); } catch { return false; }
            });
        } catch { continue; }   // папки может не быть — это нормально
        for (const label of labels) {
            const dir = path.join(root.dir, label);
            flat.push({ root, label, dir, mtime: cookiesMtime(dir) });
        }
    }

    // Кого можно взять из индекса, а кого придётся расшифровывать.
    const stale = flat.filter(p => {
        const e = cached[p.dir];
        return !(e && e.mtime === p.mtime && p.mtime !== 0);
    });

    let warm = null;
    if (stale.length) {
        try { warm = nac.warmAesKeys(stale.map(p => p.dir)); }
        catch (e) { warm = { warmed: 0, failed: stale.length, error: e.message }; }
    }

    const out = [];
    for (const p of flat) {
        const e = cached[p.dir];
        let rec;
        if (e && e.mtime === p.mtime && p.mtime !== 0) {
            rec = e;                                   // из индекса: ни DPAPI, ни sqlite
        } else {
            const cookies = nac.readProfileCookies(p.dir);
            const own = cookies.filter(c => c.host === 'github.com' || c.host.endsWith('.github.com'));
            rec = {
                mtime: p.mtime,
                login: nac.githubLogin(cookies),
                hasUserSession: own.some(c => c.name === 'user_session' && c.value),
                lastUpdate: own.reduce((m, c) => Math.max(m, c.lastUpdate || 0), 0),
            };
        }
        next[p.dir] = rec;
        if (!rec.login) continue;
        out.push({
            tag: p.root.tag, host: p.root.host, label: p.label, dir: p.dir,
            login: rec.login, hasUserSession: rec.hasUserSession, lastUpdate: rec.lastUpdate,
            archived: isArchivedLabel(p.label),
        });
    }

    saveIndex(next);
    lastScanStats = {
        ms: Date.now() - t0,
        profiles: flat.length,
        fromIndex: flat.length - stale.length,
        decrypted: stale.length,
        withGithub: out.length,
        warmError: warm && warm.error ? warm.error : null,
        warmFailed: warm ? warm.failed : 0,
    };
    return out;
}

// Скан читает 40+ банок кук и стоит около секунды даже с прогретыми ключами, а модалку
// открывают подряд (посмотрел список → выбрал → бэкенд снова строит индекс). Держим
// короткий кеш: профили меняются, когда ты руками открываешь ЛК, — раз в минуту перечитать
// достаточно, а «занято/свободно» после заселения всё равно подхватывается не сразу
// (Chromium пишет банку кук только на закрытии).
const SCAN_TTL_MS = 60_000;
let scanCache = { at: 0, data: null };

function scanProfilesCached() {
    if (scanCache.data && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.data;
    const data = scanProfiles();
    scanCache = { at: Date.now(), data };
    return data;
}

function invalidateScan() { scanCache = { at: 0, data: null }; }

function dropIndex() {
    scanCache = { at: 0, data: null };
    try { fs.unlinkSync(INDEX_FILE); } catch {}
}

// ─────────── чтение индекса БЕЗ расшифровки (единственный путь для дашборда) ───────────
//
// Дашборд обязан отвечать быстро и не имеет права звать DPAPI: `execFileSync('powershell')`
// синхронный, он блокирует событийный цикл целиком, а на элевированном процессе однажды
// вообще не вернулся — :8200 слушал, но не отвечал ни на один запрос. Поэтому здесь только
// чтение JSON. Собирает его отдельный процесс: routing/gh-index-build.js.

function indexInfo() {
    try {
        const st = fs.statSync(INDEX_FILE);
        const entries = loadIndex();
        const n = Object.keys(entries).length;
        return { exists: n > 0, count: n, ageMs: Date.now() - st.mtimeMs };
    } catch { return { exists: false, count: 0, ageMs: Infinity }; }
}

// Путь профиля → { tag, host, label }. Индекс хранит абсолютные пути, а корни мы знаем.
function rootOf(dir) {
    for (const root of PROFILE_ROOTS) {
        if (dir.toLowerCase().startsWith(root.dir.toLowerCase() + path.sep)) {
            return { tag: root.tag, host: root.host, label: path.basename(dir) };
        }
    }
    return null;
}

// Тот же формат, что у scanProfiles(), но собранный из готового индекса.
// Профили, чья папка исчезла с диска, пропускаем — запись в индексе могла устареть.
function profilesFromIndex() {
    const out = [];
    for (const [dir, rec] of Object.entries(loadIndex())) {
        if (!rec || !rec.login) continue;
        const r = rootOf(dir);
        if (!r) continue;
        if (!fs.existsSync(dir)) continue;
        out.push({
            tag: r.tag, host: r.host, label: r.label, dir,
            login: rec.login,
            hasUserSession: !!rec.hasUserSession,
            lastUpdate: rec.lastUpdate || 0,
            archived: isArchivedLabel(r.label),
        });
    }
    return out;
}

// Свежесть индекса относительно диска: у каких профилей mtime банки кук разошёлся с
// записью. Не расшифровывает ничего — только stat. Нужно, чтобы дашборд мог сказать
// «индекс устарел, перестраиваю», не платя за DPAPI.
function indexOutdatedDirs() {
    const entries = loadIndex();
    const outdated = [];
    for (const root of PROFILE_ROOTS) {
        let labels;
        try {
            labels = fs.readdirSync(root.dir).filter(d => {
                try { return fs.statSync(path.join(root.dir, d)).isDirectory(); } catch { return false; }
            });
        } catch { continue; }
        for (const label of labels) {
            const dir = path.join(root.dir, label);
            const e = entries[dir];
            const m = cookiesMtime(dir);
            if (!e || e.mtime !== m || m === 0) outdated.push(dir);
        }
    }
    return outdated;
}

// login → { login, sources[], hosts:Set<tag> }. sources отсортированы так, как их стоит
// пробовать для харвеста: сначала github/profiles (каноничное хранилище GitHub-аккаунтов,
// его не жаль трогать), потом по свежести куки.
//
// По умолчанию берём ГОТОВЫЙ индекс с диска (profilesFromIndex), а не свежий скан: скан
// зовёт DPAPI, а этой функцией пользуется дашборд, которому блокировать поток нельзя.
// Собственный скан передаёт profiles явно — так делает gh-index-build.js.
function indexByLogin(profiles = null) {
    const map = new Map();
    for (const p of (profiles || profilesFromIndex())) {
        const key = p.login.toLowerCase();
        if (!map.has(key)) map.set(key, { login: p.login, sources: [], hosts: new Set() });
        const e = map.get(key);
        e.sources.push(p);
        // `hosts` = основание блокировать повторную регистрацию, поэтому архивные профили
        // (`_old_*`) в него НЕ идут: как источник куки они годны, а как доказательство
        // «аккаунт на хосте уже есть» — нет. Профиль пересоздают именно тогда, когда
        // аккаунта больше нет либо в него надо войти заново.
        if (!p.archived) e.hosts.add(p.tag);
    }
    for (const e of map.values()) {
        e.sources.sort((a, b) =>
            (a.tag === 'github' ? -1 : 0) - (b.tag === 'github' ? -1 : 0) ||
            (b.lastUpdate - a.lastUpdate));
    }
    return map;
}

// Занят ли этот GitHub на этом хосте. Считаем ПО КУКАМ ПРОФИЛЕЙ, а не по полю ghId:
// ghId есть только у AgentRouter, а профиль с dotcom_user появляется на всех пяти.
// Побочный плюс — метка самоподдерживающаяся: заселили новый профиль, и он сам попал
// в скан следующего вызова.
//
// Важно, почему это вообще проверяется: один GitHub на ДРУГОМ хосте = новый аккаунт
// панели, а на ТОМ ЖЕ хосте = вход в аккаунт, который уже есть. Второе выглядит как
// «регистрация не сработала», хотя всё честно.
//
// ⚠️ Признак КОСВЕННЫЙ, и это его слабое место. Профиль на диске переживает удаление
// записи из пула, а сама регистрация могла не состояться (у провайдера была закрыта) —
// тогда кука в профиле есть, аккаунта нет, и «занято» врёт. Обратный промах тоже
// возможен: аккаунт у провайдера жив, а GitHub-кука в его профиле выветрилась
// (`login: null`) — и «занято» молчит. Поэтому вызывающая сторона обязана трактовать
// ответ как предупреждение, которое можно перебить (см. `force` в newapiAddGithub),
// а не как запрет, и дополнять его проверкой по записям пула.
function usedOnHost(index, login, tag) {
    const e = index.get(String(login || '').toLowerCase());
    return !!(e && e.hosts.has(tag));
}

// ───────────────────────── живость: только через браузер ─────────────────────────

// Проверки живости здесь НЕТ, и это осознанно.
//
// Первая версия модуля дёргала GET https://github.com/settings/profile сырым
// https.request'ом с самодельным `user-agent: 'Mozilla/5.0'`. Проверенные так три сессии
// (impeccableso, serpentinesep, lankymapping) сначала ответили 200, а через ~25 минут
// начали отдавать 302 → /login: GitHub счёл несовпадение UA угоном и погасил их. Два
// аккаунта, которых проба не касалась (faithfulpho, presentkid), остались живы — это и
// доказало причину. Инструмент диагностики уничтожал то, что диагностировал.
//
// Поэтому единственная допустимая проба — навигация настоящим браузером, и она живёт в
// github/harvest-session.js: тот всё равно открывает профиль ради снимка, так что проверка
// достаётся бесплатно, а UA там браузерный. Наружу выставляем только «есть ли кука и
// насколько она свежая» — этого достаточно, чтобы показать пикер, а вердикт о живости
// выносит харвест в момент заселения.
//
// (Балансовый чекер New-API в newapi-account.js шлёт куки сырым запросом и проблемы не
// имеет: у New-API авторизация к UA не привязана. Запрет касается именно github.com.)

// Насколько свежа GitHub-кука профиля. Не «жива», а именно «свежа» — врать в названии
// нельзя, точный ответ даёт только браузер.
function freshnessMs(profile) {
    return profile && profile.lastUpdate ? Date.now() - profile.lastUpdate : Infinity;
}

// ───────────────────────── кеш снимков ─────────────────────────

function cachePath(ghId) {
    return path.join(SESSIONS_DIR, String(ghId).replace(/[^\w-]/g, '_') + '.json');
}

function readCache(ghId) {
    try {
        const snap = JSON.parse(fs.readFileSync(cachePath(ghId), 'utf8'));
        if (!snap || !Array.isArray(snap.cookies) || !snap.cookies.length) return null;
        return snap;
    } catch { return null; }
}

function cacheAgeMs(snap) {
    const t = snap && snap.harvestedAt ? Date.parse(snap.harvestedAt) : NaN;
    return Number.isFinite(t) ? Date.now() - t : Infinity;
}

function cacheStale(snap) {
    return cacheAgeMs(snap) > CACHE_TTL_MS;
}

function writeCache(ghId, snap) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(cachePath(ghId), JSON.stringify(snap, null, 2) + '\n', 'utf8');
    return cachePath(ghId);
}

// Что вливаем в профиль нового аккаунта. Маркер seed:'github' обязателен: без него
// open-session.js примет сессию за «аккаунт друга уже зарегистрирован», уйдёт на
// страницу баланса и пропустит регистрацию по рефке — реф-кредит потеряется.
function seedPayload(snap, ghLogin) {
    return {
        seed: 'github',
        ghLogin: ghLogin || (snap && snap.ghLogin) || null,
        seededAt: new Date().toISOString(),
        cookies: (snap && snap.cookies) || [],
        origins: (snap && snap.origins) || [],
    };
}

module.exports = {
    PROFILE_ROOTS, SESSIONS_DIR, HARVEST_SCRIPT, CACHE_TTL_MS, INDEX_FILE,
    tagToHost, hostToTag,
    scanProfiles, scanProfilesCached, invalidateScan, scanStats, dropIndex,
    indexInfo, profilesFromIndex, indexOutdatedDirs,
    indexByLogin, usedOnHost, freshnessMs,
    cachePath, readCache, writeCache, cacheAgeMs, cacheStale,
    seedPayload,
};
