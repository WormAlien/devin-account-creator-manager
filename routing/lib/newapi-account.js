// routing/lib/newapi-account.js
//
// Точный баланс аккаунта New-API: agentrouter.org, gorouter.app, tabitoken.com,
// xpeach.codes.
//
// Зачем: по API-ключу сервис отдаёт только потраченное (/dashboard/billing/usage,
// причём это расход ТОКЕНА, а не аккаунта). Остаток приходилось угадывать от
// «гранта», и цифра в дашборде разъезжалась вплоть до минусов. Аккаунтный
// эндпоинт /api/user/self отдаёт остаток точно:
//
//   GET /api/user/self → { quota, used_quota }   в единицах квоты
//   USD = quota / quota_per_unit                 (quota_per_unit = 500000, из /api/status)
//
// Авторизация там аккаунтная, не ключевая, и различается по версиям New-API:
//
//   classic (agentrouter.org, gorouter.app rc.21)
//     Cookie: session=…  +  заголовок New-Api-User: <id>
//     id лежит В САМОЙ куке: gorilla/sessions её подписывает, но не шифрует
//     (см. sessionUserId).
//
//   jwt (tabitoken.com rc.23, xpeach.codes)
//     POST /api/user/auth/refresh с Cookie: new_api_refresh=… → { access_token }
//     дальше Authorization: Bearer <access_token>
//     У xpeach.codes ответ refresh сразу несёт user{quota,used_quota} — отдельный
//     /api/user/self не нужен (та же ветка, что tabitoken).
//
// Куки берём НАПРЯМУЮ из персистентных Chromium-профилей (<provider>/profiles/<label>),
// без запуска браузера: схема шифрования у них v10 (не app-bound v20), ключ лежит
// в Local State под DPAPI. Прецедент «куки → API вместо скрейпа Playwright» —
// internal/freemodel-manager.js:fmApiQuota. Форма клиента — как helpcoder/lib/helpcoder-api.js
// (helpcoder.cc это тоже New-API, и там уже ровно этот набор функций).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// better-sqlite3 — нативный модуль, и на свежей машине он может не собраться (нет
// prebuild под её версию Node, отвалился node-gyp, установка шла с --ignore-scripts).
// Раньше это выглядело как «в профиле нет куки»: точный баланс молча деградировал в
// прикидку, а причина не читалась ниоткуда — у пользователя на другой машине из всей
// диагностики был только текст уведомления. Теперь ошибку загрузки помним и называем.
let SQLITE_ERROR = null;
function sqliteModule() {
    try { return require('better-sqlite3'); }
    catch (e) { SQLITE_ERROR = (e && (e.message || String(e))) || 'не загружается'; return null; }
}

// Готовность бэкенда куки — для громкой строки в логе прокси при старте.
function cookieBackendReady() {
    return sqliteModule() ? { ok: true } : { ok: false, error: String(SQLITE_ERROR).split('\n')[0].slice(0, 120) };
}

// Где у профиля БД куки. Путь менялся: до Chromium 96 это Default/Cookies, потом
// Default/Network/Cookies. Проверяем оба и отдаём существующий — иначе на сборке с
// другим layout'ом мы молча решаем «куки нет» и роняем точный баланс в прикидку.
// Возвращает null, если нет ни одного.
const COOKIE_DB_RELS = [
    ['Default', 'Network', 'Cookies'],
    ['Default', 'Cookies'],
];
function cookieDbPath(profileDir) {
    for (const rel of COOKIE_DB_RELS) {
        const p = path.join(profileDir, ...rel);
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null;
}

// Почему у профиля не нашлось куки — текст прямо в UI, без обращения к машине владельца.
// Дёшево: модуль в require-кеше, AES-ключ профиля кеширован на процесс.
function cookieFailReason(profileDir, host) {
    if (!sqliteModule()) {
        return `better-sqlite3 не собран → npm rebuild better-sqlite3 (${String(SQLITE_ERROR).split('\n')[0].slice(0, 70)})`;
    }
    try {
        if (!cookieDbPath(profileDir)) {
            return 'в профиле нет БД куки — открой ЛК (🌐) и войди в аккаунт';
        }
    } catch {}
    if (!profileAesKey(profileDir)) {
        return IS_MAC
            ? (MAC_KEY_ERROR
                ? `подбор ключа куки упал: ${String(MAC_KEY_ERROR).slice(0, 90)}`
                : 'ключ профиля не подобрался (mock keychain / Keychain «Chromium Safe Storage»)')
            : 'ключ профиля не расшифровался (Local State / DPAPI)';
    }
    return `в профиле нет куки для ${host} — сессия не сохранилась, войди в ЛК заново`;
}

const QUOTA_PER_UNIT_DEFAULT = 500000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

// Схема авторизации по хосту. jwt — только у инстансов, где cookie `session`
// заменена на short-lived JWT + httpOnly refresh-куку.
const HOST_AUTH = {
    'agentrouter.org': 'classic',
    'gorouter.app': 'classic',
    'tabitoken.com': 'jwt',
    // xpeach.codes — та же ветка New-API, что tabitoken: кука new_api_refresh на
    // пути /api/user/auth, обмен на JWT. Проверено живым refresh 2026-08-18.
    'xpeach.codes': 'jwt',
};

function authKind(host) {
    return HOST_AUTH[host] || 'classic';
}

// ───────────────────── свой cookie-jar поверх профиля ─────────────────────
//
// Зачем он нужен: на jwt-инстансах refresh-кука ОДНОРАЗОВАЯ — сервер отдаёт новое
// значение в set-cookie при каждом обмене. Кука в профиле Chromium после первого же
// нашего запроса становится недействительной, а в живую БД профиля (браузер открыт)
// писать нельзя. Поэтому держим свой оверлей: значения из jar приоритетнее профильных,
// а после каждого ответа мержим set-cookie обратно.
// Сюда же кешируем access-токен, чтобы не жечь refresh на каждый чек.
//
// Но jar сам по себе создавал вторую беду: браузерный профиль оставался со старым
// значением, и при ручном открытии ЛК Chromium шёл refresh'ем по уже погашенной куке →
// 401 → разлогин. Поэтому есть writeProfileCookies/syncJarToProfile: когда браузер этого
// профиля закрыт, ротированное значение уезжает в профиль, и jar с профилем сходятся.

const JAR_FILE = path.join(__dirname, '..', 'newapi-jar.json');

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

function jarKey(host, profileDir) {
    return `${host}|${profileDir ? path.basename(profileDir) : '-'}`;
}

function extractSetCookie(res) {
    try { if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie(); } catch {}
    const h = res.headers.get('set-cookie');
    return h ? [h] : [];
}

// Мерж set-cookie в jar. Сброс (max-age=0 / дата в прошлом) удаляет запись,
// иначе бы мы вечно таскали протухшее значение поверх живого профильного.
function mergeSetCookie(jar, key, setCookieList) {
    if (!setCookieList || !setCookieList.length) return false;
    const entry = jar[key] || (jar[key] = { cookies: {} });
    if (!entry.cookies) entry.cookies = {};
    let changed = false;
    for (const sc of setCookieList) {
        const m = /^([^=;]+)=([^;]*)/.exec(sc);
        if (!m) continue;
        const name = m[1].trim(), value = m[2];
        const cleared = /max-age\s*=\s*0/i.test(sc) || /expires\s*=\s*thu,\s*01\s*jan\s*1970/i.test(sc) || value === '';
        if (cleared) { if (name in entry.cookies) { delete entry.cookies[name]; changed = true; } continue; }
        if (entry.cookies[name] !== value) { entry.cookies[name] = value; changed = true; }
    }
    // cookiesAt — время именно КУКОВОЙ ротации. Отдельно от updatedAt, потому что тот
    // бампается ещё и при кеше access-токена, а нам нужно честно сравнивать давность
    // с last_update_utc из профиля (см. effectiveCookieHeader / syncJarToProfile).
    if (changed) { entry.updatedAt = new Date().toISOString(); entry.cookiesAt = entry.updatedAt; }
    return changed;
}

// Когда jar последний раз получал куку от сервера (мс epoch).
function jarCookiesAt(entry) {
    if (!entry) return 0;
    const t = Date.parse(entry.cookiesAt || entry.updatedAt || '');
    return isFinite(t) ? t : 0;
}

// Итоговый Cookie-заголовок: профиль как база, jar сверху — но с оглядкой на давность.
// Ротация двусторонняя: куку обновляем и мы (через refresh), и сам браузер, когда
// ты сидишь в ЛК. Если слепо класть jar поверх профиля, то после ручного входа в ЛК
// мы бы ходили нашим УЖЕ ПОГАШЕННЫМ значением и снова всё ломали. Поэтому сравниваем
// last_update_utc куки в профиле с updatedAt записи jar: чья ротация свежее, той и верим.
function effectiveCookieHeader(host, profileDir, jar) {
    const base = new Map();   // name → { value, at }
    if (profileDir) {
        for (const c of readProfileCookies(profileDir)) {
            if (c.host === host || c.host.endsWith('.' + host)) {
                base.set(c.name, { value: c.value, at: c.lastUpdate || 0 });
            }
        }
    }
    const entry = jar[jarKey(host, profileDir)];
    const jarAt = jarCookiesAt(entry);
    if (entry && entry.cookies) {
        for (const [k, v] of Object.entries(entry.cookies)) {
            const prof = base.get(k);
            if (prof && prof.at && jarAt && prof.at > jarAt) continue;   // браузер новее — не мешаем
            base.set(k, { value: v, at: jarAt });
        }
    }
    return [...base.entries()].map(([k, v]) => `${k}=${v.value}`).join('; ');
}

// access_expires_at приходит по-разному (сек / мс / ISO) — нормализуем в мс.
function toMillis(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    const t = Date.parse(v);
    return isFinite(t) ? t : 0;
}

// ─────────────────────────── куки из профиля Chromium ───────────────────────────

// Ключ AES-256 профиля: Local State → os_crypt.encrypted_key (base64, префикс
// 'DPAPI') → DPAPI-раскрытие. Нативного модуля не нужно — зовём PowerShell.
// Вызов дорогой (~300мс), поэтому кешируем на процесс: ключ профиля не меняется.
const AES_KEY_CACHE = new Map();   // profileDir → Buffer | null

// DPAPI-блоб ключа профиля из Local State. null — профиля/ключа нет.
function readAesBlob(profileDir) {
    try {
        const raw = fs.readFileSync(path.join(profileDir, 'Local State'), 'utf8');
        const ls = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const enc = ls.os_crypt && ls.os_crypt.encrypted_key;
        return enc ? Buffer.from(enc, 'base64').slice(5) : null;   // снять префикс 'DPAPI'
    } catch { return null; }
}

function aesKeyFromBase64(out) {
    const buf = Buffer.from(String(out || '').trim(), 'base64');
    return buf.length === 32 ? buf : null;
}

// Расшифровать ключи СРАЗУ У МНОГИХ профилей одним процессом PowerShell.
//
// Зачем: profileAesKey поднимает по процессу на профиль, ~650 мс каждый. Пока это был
// один-два профиля на чек баланса, никто не замечал; скан всех папок ради индекса
// GitHub-сессий (lib/github-session.js) упёрся в 41 профиль = 27 СЕКУНД молчания в
// модалке. Один запуск на всех — около секунды.
//
// Блобы передаём файлом, а не аргументом: 41 блоб это уже ~16 КБ командной строки, а её
// лимит в Windows 32767 символов — на сотне профилей команда просто не собралась бы.
//
// Путь к файлу вклеиваем В САМУ КОМАНДУ, и это не лень:
//   • `-args <path>` НЕ РАБОТАЕТ с `-Command` (только с `-File`) — powershell ругается
//     «-args не распознано», $args[0] пуст, ReadAllLines('') падает. Батч при этом молча
//     откатывался на процесс-на-профиль: 48 профилей = 30 секунд вместо 0.7.
//   • `env: {...process.env, NAC_BLOBS}` работает, но переписывать окружение дочернему
//     процессу на элевированном дашборде оказалось себе дороже.
// Кавычки в пути удваиваем — в PowerShell внутри '...' это escape для одинарной.
// Строк на выходе ровно столько же, сколько на входе: пустая = не расшифровалось.
//
// ВНИМАНИЕ: вызов СИНХРОННЫЙ и блокирует событийный цикл. Из обработчика HTTP-запроса его
// звать нельзя — дашборд перестанет отвечать на всё. Единственное штатное место —
// routing/gh-index-build.js, отдельный процесс.
function warmAesKeys(profileDirs) {
    // На macOS батчить нечего: пароль один на систему (Keychain), дорогого
    // процесса-на-профиль нет — есть только проба кандидата по БД профиля.
    if (IS_MAC) {
        let warmed = 0, failed = 0;
        for (const dir of profileDirs || []) {
            if (AES_KEY_CACHE.has(dir)) continue;
            if (profileAesKey(dir)) warmed++; else failed++;
        }
        return { warmed, failed };
    }
    const pending = [];
    for (const dir of profileDirs || []) {
        if (AES_KEY_CACHE.has(dir)) continue;
        const blob = readAesBlob(dir);
        if (!blob) { AES_KEY_CACHE.set(dir, null); continue; }
        pending.push({ dir, blob });
    }
    if (!pending.length) return { warmed: 0, failed: 0 };

    const listFile = path.join(os.tmpdir(), `nac_keys_${process.pid}_${pending.length}.txt`);
    try {
        fs.writeFileSync(listFile, pending.map(p => p.blob.toString('base64')).join('\n'), 'utf8');
        const psPath = listFile.replace(/'/g, "''");
        const ps = 'Add-Type -AssemblyName System.Security;'
            + `foreach($l in [IO.File]::ReadAllLines('${psPath}')){`
            + 'if(-not $l){ \'\'; continue }'
            + 'try{ [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect('
            + '[Convert]::FromBase64String($l),$null,\'CurrentUser\')) }catch{ \'\' } }';
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
            encoding: 'utf8', timeout: 60000, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],   // stdin закрыт: PowerShell не должен его ждать
        }).split(/\r?\n/);
        let warmed = 0, failed = 0;
        pending.forEach((p, i) => {
            const key = aesKeyFromBase64(out[i]);
            AES_KEY_CACHE.set(p.dir, key);
            if (key) warmed++; else failed++;
        });
        return { warmed, failed };
    } catch (e) {
        // Батч не задался — НЕ кешируем null, пусть profileAesKey добьёт по одному.
        return { warmed: 0, failed: pending.length, error: e.message };
    } finally {
        try { fs.unlinkSync(listFile); } catch {}
    }
}

// ───────────────────── macOS: другой ключ и другой шифр ─────────────────────
//
// На Windows ключ лежит в Local State под DPAPI, а значение — AES-256-GCM.
// На macOS всё иначе, поэтому Windows-ветка там не деградирует, а просто не
// работает: profileAesKey возвращал null → readProfileCookies отдавал [] →
// accountSelf не авторизовался → точный баланс молча превращался в «~ прикидку»
// (замер на чистом MacBook 2026-08-20: 6 профилей, ключ не расшифровался ни в одном).
//
// Схема macOS (OSCrypt):
//   пароль — Keychain, generic-password сервиса «Chromium Safe Storage»
//            (у Chrome — «Chrome Safe Storage»). Playwright, запущенный с
//            --use-mock-keychain, вместо Keychain берёт константу 'peanuts',
//            поэтому кандидатов несколько и рабочий выбирается по факту.
//   ключ   — PBKDF2-SHA1(пароль, 'saltysalt', 1003 итераций, 16 байт).
//   значение — 'v10' + AES-128-CBC, IV = 16 пробелов, PKCS#7. Нонса нет,
//            тега нет: короче GCM-формата, поэтому длину проверяем отдельно.
const IS_MAC = process.platform === 'darwin';
const MAC_SALT = 'saltysalt';
const MAC_ITER = 1003;
const MAC_IV = Buffer.alloc(16, 0x20);   // ровно 16 пробелов
let MAC_KEY_ERROR = null;                // последняя внутренняя ошибка подбора ключа

// Плейнтекст у Chromium 130+ префиксован 32 байтами SHA-256(host_key) — тем же,
// что и на Windows (это уровень OSCrypt, не платформы). Срезаем по той же
// эвристике «начало не похоже на текст».
function macStripPrefix(out) {
    if (out.length > 32 && /[\x00-\x08\x0e-\x1f]/.test(out.toString('latin1').slice(0, 32))) return out.slice(32);
    return out;
}

function macDecryptCookie(enc, key) {
    try {
        if (!Buffer.isBuffer(enc) || enc.length < 3 + 16) return null;
        if (enc.slice(0, 3).toString('latin1') !== 'v10') return null;
        const d = crypto.createDecipheriv('aes-128-cbc', key, MAC_IV);
        d.setAutoPadding(false);            // padding снимаем сами: Chromium иногда пишет свой
        let out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
        const pad = out[out.length - 1];
        if (pad >= 1 && pad <= 16 && pad <= out.length) out = out.slice(0, out.length - pad);
        out = macStripPrefix(out);
        const s = out.toString('utf8');
        // Куки — печатный ASCII. Проверка отсеивает «расшифровку» неверным ключом:
        // CBC без тега аутентичности молча отдаёт мусор вместо ошибки.
        return /^[\x20-\x7e]*$/.test(s) && s.length ? s : null;
    } catch { return null; }
}

function macEncryptCookie(value, key, hostKey) {
    const c = crypto.createCipheriv('aes-128-cbc', key, MAC_IV);
    const prefix = crypto.createHash('sha256').update(String(hostKey)).digest();
    const body = Buffer.concat([c.update(Buffer.concat([prefix, Buffer.from(String(value), 'utf8')])), c.final()]);
    return Buffer.concat([Buffer.from('v10', 'latin1'), body]);
}

function macKeyFromPassword(pw) {
    return crypto.pbkdf2Sync(String(pw), MAC_SALT, MAC_ITER, 16, 'sha1');
}

// Кандидаты ключей в порядке ДЕШЕВИЗНЫ, а не вероятности.
//
// `security find-generic-password` на каждый процесс поднимает системный диалог
// «введите пароль» — на живом маке это восемь окон за один прогон (пробник +
// дашборд + keepalive'ы, у каждого свой процесс и свой кеш). Поэтому сперва
// пробуем то, что не стоит ничего, и к Keychain лезем только если не подошло.
//
// Рабочий вариант (замер на живом маке 2026-08-20, Chrome for Testing 148, Intel:
// 11/11 куки в 6 профилях): пароль 'mock_password'. Playwright запускает Chromium
// с --use-mock-keychain, а MockAppleKeychain отдаёт именно эту константу — не
// 'peanuts' (то Linux-схема) и не Keychain-запись «Chromium Safe Storage»,
// которая на маке есть, но принадлежит другому браузеру и не подходит.
function macCheapCandidates() {
    return [
        { label: "'mock_password' (--use-mock-keychain)", key: macKeyFromPassword('mock_password') },
        { label: "'peanuts' (Linux-схема)", key: macKeyFromPassword('peanuts') },
        { label: 'пустой пароль', key: macKeyFromPassword('') },
    ];
}

let MAC_KEYCHAIN = null;
function macKeychainCandidates() {
    if (MAC_KEYCHAIN) return MAC_KEYCHAIN;
    const out = [];
    for (const svc of ['Chromium Safe Storage', 'Chrome Safe Storage']) {
        try {
            const pw = execFileSync('security', ['find-generic-password', '-w', '-s', svc, '-a', svc.split(' ')[0]], {
                encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            if (pw) out.push({ label: svc, key: macKeyFromPassword(pw) });
        } catch {}
    }
    MAC_KEYCHAIN = out;
    return out;
}

// Сырые encrypted_value из БД профиля — только чтобы выбрать рабочий кандидат.
// Отдельно от readProfileCookies, потому что та сама зовёт profileAesKey.
function macSampleEncrypted(profileDir, limit = 6) {
    const src = cookieDbPath(profileDir);
    if (!src) return [];
    const Database = sqliteModule();
    if (!Database) return [];
    const tmp = path.join(os.tmpdir(), `nac_probe_${process.pid}_${Math.random().toString(36).slice(2)}.db`);
    const copied = [tmp];
    try {
        fs.copyFileSync(src, tmp);
        for (const suf of ['-wal', '-shm']) {
            if (fs.existsSync(src + suf)) { fs.copyFileSync(src + suf, tmp + suf); copied.push(tmp + suf); }
        }
        const db = new Database(tmp, { readonly: true });
        try {
            return db.prepare('SELECT encrypted_value FROM cookies LIMIT ?').all(limit)
                .map(r => r.encrypted_value)
                .filter(v => Buffer.isBuffer(v) && v.length > 3);
        } finally { db.close(); }
    } catch { return []; }
    finally { for (const f of copied) { try { fs.unlinkSync(f); } catch {} } }
}

// Рабочий ключ профиля на macOS: тот кандидат, которым реально расшифровалась
// хотя бы одна кука. Сначала дешёвые (без диалога пароля), и только если ни один
// не подошёл — Keychain. Если БД пустая/отсутствует — отдаём первый дешёвый
// кандидат, чтобы причину сформулировал cookieFailReason («нет БД куки»), а не
// «ключ не подобрался».
function macProfileKey(profileDir) {
    const cheap = macCheapCandidates();
    const sample = macSampleEncrypted(profileDir);
    if (!sample.length) return cheap[0] ? cheap[0].key : null;
    for (const c of cheap) {
        if (sample.some(enc => macDecryptCookie(enc, c.key) !== null)) return c.key;
    }
    for (const c of macKeychainCandidates()) {
        if (sample.some(enc => macDecryptCookie(enc, c.key) !== null)) return c.key;
    }
    return null;
}

function profileAesKey(profileDir) {
    if (AES_KEY_CACHE.has(profileDir)) return AES_KEY_CACHE.get(profileDir);
    let key = null;
    if (IS_MAC) {
        // Ошибку НЕ глотаем молча: раньше здесь стоял пустой catch, и опечатка в
        // имени функции (macKeyCandidates → macCheapCandidates после рефакторинга)
        // выглядела в UI как «ключ профиля не подобрался». Час диагностики на маке.
        try { key = macProfileKey(profileDir); }
        catch (e) { MAC_KEY_ERROR = (e && e.message) || String(e); key = null; }
        AES_KEY_CACHE.set(profileDir, key);
        return key;
    }
    try {
        const blob = readAesBlob(profileDir);
        if (blob) {
            const ps = 'Add-Type -AssemblyName System.Security;'
                + `$b=[Convert]::FromBase64String('${blob.toString('base64')}');`
                + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
            const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
                encoding: 'utf8', timeout: 20000, windowsHide: true,
            }).trim();
            key = aesKeyFromBase64(out);
        }
    } catch { key = null; }
    AES_KEY_CACHE.set(profileDir, key);
    return key;
}

// v10/v11: 'v10' + 12б nonce + ciphertext + 16б GCM-tag.
// У сборок начиная с Chrome 130-х плейнтекст префиксован 32 байтами хеша домена —
// срезаем, если начало не похоже на текст.
function decryptCookieValue(enc, key) {
    if (IS_MAC) return macDecryptCookie(enc, key);
    try {
        if (!Buffer.isBuffer(enc) || enc.length < 32) return null;
        const tag = enc.slice(0, 3).toString('latin1');
        if (tag !== 'v10' && tag !== 'v11') return null;
        const iv = enc.slice(3, 15);
        const gcmTag = enc.slice(enc.length - 16);
        const ct = enc.slice(15, enc.length - 16);
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(gcmTag);
        let out = Buffer.concat([d.update(ct), d.final()]);
        if (out.length > 32 && /[\x00-\x08\x0e-\x1f]/.test(out.toString('latin1').slice(0, 32))) {
            out = out.slice(32);
        }
        return out.toString('utf8');
    } catch { return null; }
}

// Зеркало decryptCookieValue: собираем ровно тот формат, который Chromium ждёт при
// чтении, включая 32-байтный префикс SHA-256 от host_key (проверено на живом профиле:
// у всех записей плейнтекст начинается именно им). Без префикса браузер сочтёт куку
// испорченной и молча её выбросит.
function encryptCookieValue(value, key, hostKey) {
    if (IS_MAC) return macEncryptCookie(value, key, hostKey);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const prefix = crypto.createHash('sha256').update(String(hostKey)).digest();
    const body = Buffer.concat([
        c.update(Buffer.concat([prefix, Buffer.from(String(value), 'utf8')])),
        c.final(),
    ]);
    return Buffer.concat([Buffer.from('v10', 'latin1'), iv, body, c.getAuthTag()]);
}

// Время Chromium — микросекунды от 1601-01-01.
const CHROME_EPOCH_OFFSET_MS = 11644473600000;
const chromeTimeToMs = utc => Math.round(Number(utc) / 1000) - CHROME_EPOCH_OFFSET_MS;
const msToChromeTime = ms => (Number(ms) + CHROME_EPOCH_OFFSET_MS) * 1000;

// Читаем Default/Network/Cookies. Работаем по КОПИИ: живой браузер держит файл,
// а readonly-открытие оригинала всё равно требует создать -wal/-shm рядом.
// Возвращаем [{ host, name, value, lastUpdate }]; host без ведущей точки,
// lastUpdate — мс epoch (по нему решаем, чья ротация свежее, см. effectiveCookieHeader).
function readProfileCookies(profileDir) {
    const src = cookieDbPath(profileDir);
    if (!src) return [];
    const key = profileAesKey(profileDir);
    if (!key) return [];
    const tmp = path.join(os.tmpdir(), `nac_${process.pid}_${Math.random().toString(36).slice(2)}.db`);
    const copied = [tmp];
    try {
        fs.copyFileSync(src, tmp);
        for (const suf of ['-wal', '-shm']) {
            if (fs.existsSync(src + suf)) { fs.copyFileSync(src + suf, tmp + suf); copied.push(tmp + suf); }
        }
        let Database = sqliteModule();
        if (!Database) return [];   // модуль есть в package.json, но не падаем если не собран
        const db = new Database(tmp, { readonly: true });
        let rows;
        try {
            rows = db.prepare('SELECT host_key, name, encrypted_value, last_update_utc FROM cookies').all();
        } finally { db.close(); }
        const out = [];
        for (const r of rows) {
            const value = decryptCookieValue(r.encrypted_value, key);
            if (value) out.push({
                host: String(r.host_key || '').replace(/^\./, ''),
                name: r.name,
                value,
                lastUpdate: r.last_update_utc ? chromeTimeToMs(r.last_update_utc) : 0,
            });
        }
        return out;
    } catch {
        return [];
    } finally {
        for (const f of copied) { try { fs.unlinkSync(f); } catch {} }
    }
}

// Записать куки обратно в профиль. Нужно потому, что refresh-кука одноразовая: наш
// чек баланса её ротирует, профиль остаётся со старой, и при ручном открытии ЛК
// браузер разлогинивается (проверено: у 9 из 10 tabi-аккаунтов значения расходились).
//
// ВАЖНО: звать только когда браузер этого профиля ЗАКРЫТ. Chromium держит куки в
// памяти и на выходе пишет своё — наша правка потерялась бы, а при неудачном стыке
// могла бы и БД покорёжить. Проверку «браузер жив» делает вызывающая сторона: у неё
// есть карты pid'ов открытых ЛК. Здесь только вторая линия — busy_timeout и отказ
// по SQLITE_BUSY.
//
// Только UPDATE существующих строк: вставка потребовала бы выдумывать десяток
// NOT NULL-полей Chromium, а нам нужен ровно случай «строка есть, значение устарело».
// → { ok, written: [names], missing: [names], busy, error }
function writeProfileCookies(profileDir, host, cookies) {
    const names = Object.keys(cookies || {});
    if (!names.length) return { ok: true, written: [], missing: [] };
    const src = cookieDbPath(profileDir);
    if (!fs.existsSync(src)) return { ok: false, error: 'в профиле нет БД куки' };
    const key = profileAesKey(profileDir);
    if (!key) return { ok: false, error: 'нет AES-ключа профиля' };
    const Database = sqliteModule();
    if (!Database) return { ok: false, error: cookieFailReason(profileDir, host) };
    let db = null;
    try {
        db = new Database(src);
        db.pragma('busy_timeout = 2000');
        const sel = db.prepare(
            'SELECT rowid, host_key, name FROM cookies WHERE name = ? AND (host_key = ? OR host_key = ?)'
        );
        const upd = db.prepare(
            'UPDATE cookies SET value = \'\', encrypted_value = ?, last_update_utc = ?, last_access_utc = ? WHERE rowid = ?'
        );
        const written = [], missing = [];
        const now = msToChromeTime(Date.now());
        db.transaction(() => {
            for (const name of names) {
                const row = sel.get(name, host, '.' + host);
                if (!row) { missing.push(name); continue; }
                // Префикс считаем от host_key ИМЕННО этой строки: у части куки он
                // с ведущей точкой, и хеш от другого варианта браузер не примет.
                upd.run(encryptCookieValue(cookies[name], key, row.host_key), now, now, row.rowid);
                written.push(name);
            }
        })();
        return { ok: true, written, missing };
    } catch (e) {
        const busy = /SQLITE_BUSY|database is locked/i.test(e.message || '');
        return { ok: false, busy, error: e.message };
    } finally {
        if (db) { try { db.close(); } catch {} }
    }
}

// Слить куки хоста из jar в профиль — чтобы браузер стартовал со свежим значением,
// а не с тем, что мы уже погасили своим refresh'ем.
//
// Ротация ДВУСТОРОННЯЯ, и это главная тонкость: если ты сам входил в ЛК, то куку
// последним ротировал браузер, и в jar лежит уже мёртвое значение. Записать его в
// профиль — значит своими руками разлогинить живую сессию. Поэтому пишем только те
// куки, чья версия в jar новее профильной (сравнение по cookiesAt vs last_update_utc).
function syncJarToProfile(host, profileDir, jar = null) {
    if (!profileDir) return { ok: false, error: 'нет профиля' };
    const j = jar || loadJar();
    const entry = j[jarKey(host, profileDir)];
    if (!entry || !entry.cookies || !Object.keys(entry.cookies).length) {
        return { ok: true, written: [], missing: [], empty: true };
    }
    const jarAt = jarCookiesAt(entry);
    const profile = new Map();
    for (const c of readProfileCookies(profileDir)) {
        if (c.host === host || c.host.endsWith('.' + host)) profile.set(c.name, c);
    }
    const fresh = {}, skipped = [];
    for (const [name, value] of Object.entries(entry.cookies)) {
        const prof = profile.get(name);
        if (prof && prof.value === value) continue;                       // уже совпадает
        if (prof && jarAt && prof.lastUpdate > jarAt) { skipped.push(name); continue; }
        fresh[name] = value;
    }
    if (!Object.keys(fresh).length) {
        dropStaleJarCookies(host, profileDir, skipped);
        return { ok: true, written: [], missing: [], skipped, empty: !skipped.length };
    }
    const r = writeProfileCookies(profileDir, host, fresh);
    dropStaleJarCookies(host, profileDir, skipped);
    return { ...r, skipped };
}

// Выкинуть из jar куки, которые браузер успел ротировать после нас: они гарантированно
// погашены сервером, и таскать их дальше — только путать себя (effectiveCookieHeader их
// и так игнорирует по давности, но пусть мусор не накапливается). Перечитываем диск и
// правим только свой ключ — пачка балансов идёт параллельно, снимок целиком писать нельзя.
function dropStaleJarCookies(host, profileDir, names) {
    if (!names || !names.length) return;
    const k = jarKey(host, profileDir);
    const j = loadJar();
    const e = j[k];
    if (!e || !e.cookies) return;
    let changed = false;
    for (const n of names) if (n in e.cookies) { delete e.cookies[n]; changed = true; }
    if (changed) { e.updatedAt = new Date().toISOString(); saveJar(j); }
}

function cookieHeaderFor(cookies, host) {
    return cookies
        .filter(c => c.host === host || c.host.endsWith('.' + host))
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
}

// GitHub-логин аккаунта из того же профиля — ключ связки профиля с записью пула
// (в *-sessions.json он лежит в поле email/name).
function githubLogin(cookies) {
    const c = cookies.find(x => x.name === 'dotcom_user');
    return c ? c.value : null;
}

// ───────────────────── user id из подписанной gob-сессии ─────────────────────

// gorilla/sessions с одним hash-ключом (без block-ключа) НЕ шифрует значение,
// только подписывает. Формат: base64( "<unix-ts>|" + base64(gob) + "|" + mac ).
// В gob-мапе ищем маркер `id\x03int`, за ним идут: тип (0x04), длина значения,
// delta-маркер (0x00) и сам gob-uint в zigzag-кодировке.
// Откалибровано на аккаунте с известным id (gorouter 26737 и agentrouter 410630).
function gobUintAt(buf, p) {
    const first = buf[p];
    if (first === undefined) return null;
    if (first < 0x80) return first;
    const n = 0x100 - first;
    if (n > 8 || p + n >= buf.length) return null;
    let u = 0;
    for (let i = 1; i <= n; i++) u = u * 256 + buf[p + i];
    return u;
}

function zigzag(u) {
    return (u & 1) ? ~(u >>> 1) : (u >>> 1);
}

function sessionUserId(sessionCookieValue) {
    try {
        const outer = Buffer.from(sessionCookieValue, 'base64').toString('latin1').split('|');
        if (outer.length < 2) return null;
        const buf = Buffer.from(outer[1], 'base64');
        const at = buf.indexOf(Buffer.from('id\x03int', 'latin1'));
        if (at < 0) return null;
        // Штатная раскладка — значение на +9 от маркера. Если структура иная,
        // пробуем соседние смещения и берём первое правдоподобное значение.
        const offsets = (buf[at + 6] === 0x04 && buf[at + 8] === 0x00) ? [9] : [9, 8, 7, 10, 11];
        for (const off of offsets) {
            const u = gobUintAt(buf, at + off);
            if (u == null) continue;
            const id = zigzag(u);
            if (id > 0 && id < 1e9) return id;
        }
        return null;
    } catch { return null; }
}

// Резерв: у agentrouter username — литерально `github_<id>`, из него id тоже виден.
function userIdFromUsername(username) {
    const m = /^github_(\d{1,9})$/.exec(String(username || ''));
    return m ? Number(m[1]) : null;
}

// ──────────────────────────────── HTTP ────────────────────────────────

// Шлюз частоты на хост. Зачем: у agentrouter.org перед API стоит Aliyun WAF, и при
// частых запросах он отдаёт JS-заглушку с кодом 200 ВМЕСТО JSON (проверено: первые
// 7 аккаунтов пачки прошли, следующие два получили заглушку). tabitoken на
// /api/user/auth/refresh в тех же условиях отвечает 429. Поэтому запросы к одному
// хосту идут строго по очереди с паузой — балансы всё равно считаются в фоне,
// и лишняя секунда на аккаунт заметно дешевле, чем потеря точной цифры.
const HOST_GATE = new Map();       // host → хвост цепочки
const HOST_MIN_GAP_MS = 900;
// agentrouter.org сидит за самым злым WAF: на 900мс он всё равно начинал отдавать
// заглушку к середине пачки из 11 аккаунтов. Пачка балансов — фоновая операция,
// лишние секунды дешевле потерянной точной цифры.
const HOST_GAP_OVERRIDE = { 'agentrouter.org': 2500 };

function hostGate(host, fn) {
    const gap = HOST_GAP_OVERRIDE[host] || HOST_MIN_GAP_MS;
    const prev = HOST_GATE.get(host) || Promise.resolve();
    const run = async () => {
        try { return await fn(); }
        finally { await new Promise(r => setTimeout(r, gap)); }
    };
    // Ошибка предыдущего звена не должна рвать очередь — глотаем её на стыке.
    const next = prev.then(run, run);
    HOST_GATE.set(host, next.then(() => {}, () => {}));
    return next;
}

// WAF отвечает HTML с кодом 200. Без этой проверки такой ответ выглядел бы как
// «200, но без данных» и причина была бы неочевидна.
function wafBlocked(res, text) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) return true;
    return typeof text === 'string' && /^\s*<(!doctype|html)/i.test(text);
}

// Остывание после отказа по частоте. Aliyun WAF у agentrouter.org, поймав нас на
// частых запросах, начинает отбивать ВСЁ — и повторы только продлевают блокировку
// (проверено: с ретраями пачка из 11 аккаунтов шла 109 секунд и не дала ни одной
// точной цифры). Поэтому первый же отказ выключает точный путь для хоста на 10
// минут: остальные аккаунты пачки мгновенно уходят в резерв (анкер), а сервис мы
// не долбим. Ретраев здесь сознательно нет — они делают только хуже.
const HOST_COOLDOWN = new Map();   // host → timestamp, до которого не ходим
const COOLDOWN_MS = 10 * 60_000;

function hostCoolingDown(host) {
    const until = HOST_COOLDOWN.get(host) || 0;
    return until > Date.now() ? Math.round((until - Date.now()) / 1000) : 0;
}

function coolDownHost(host) {
    HOST_COOLDOWN.set(host, Date.now() + COOLDOWN_MS);
}

async function apiFetch(host, pathQuery, { method = 'GET', body = null, cookie = '', userId = null, bearer = null, timeoutMs = TIMEOUT_MS, jar = null, jarK = null } = {}) {
    const headers = {
        'accept': 'application/json',
        'user-agent': UA,
        'referer': `https://${host}/console`,
    };
    if (cookie) headers['cookie'] = cookie;
    if (userId) headers['new-api-user'] = String(userId);
    if (bearer) headers['authorization'] = `Bearer ${bearer}`;
    if (body != null) headers['content-type'] = 'application/json';
    return hostGate(host, async () => {
        const res = await fetch(`https://${host}${pathQuery}`, {
            method,
            headers,
            body: body != null ? JSON.stringify(body) : undefined,
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
        });
        // Ротируемые куки (refresh-токен на jwt-инстансах) сохраняем сразу: пропустим —
        // и следующий запрос пойдёт с уже погашенным значением.
        // Пишем ЧЕРЕЗ ПЕРЕЧИТЫВАНИЕ диска и только свой ключ. Пачка балансов идёт по
        // 3 аккаунта параллельно, у каждого свой снимок jar — при записи снимка целиком
        // последний писатель затирал чужие свежие куки, и аккаунты «теряли» сессию
        // на ровном месте (та же грабля, что лечит arSaveMerge для пулов).
        const setCookie = extractSetCookie(res);
        if (jarK && setCookie.length) {
            const fresh = loadJar();
            if (mergeSetCookie(fresh, jarK, setCookie)) saveJar(fresh);
            if (jar) mergeSetCookie(jar, jarK, setCookie);   // и в свой снимок, для этого же вызова
        }
        let json = null, text = null;
        try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch {}
        const waf = wafBlocked(res, text);
        return { status: res.status, ok: res.ok, json, text, waf };
    });
}

// quota_per_unit хоста. Публичный эндпоинт, без авторизации; кешируем на процесс.
const QPU_CACHE = new Map();   // host → number
async function quotaPerUnit(host) {
    if (QPU_CACHE.has(host)) return QPU_CACHE.get(host);
    let v = QUOTA_PER_UNIT_DEFAULT;
    try {
        const r = await apiFetch(host, '/api/status', { timeoutMs: 10000 });
        const d = r.json && (r.json.data || r.json);
        const q = Number(d && d.quota_per_unit);
        if (q > 0) v = q;
    } catch {}
    QPU_CACHE.set(host, v);
    return v;
}

function quotaToUsd(quota, qpu) {
    if (quota == null || !isFinite(quota)) return null;
    return Math.round((Number(quota) / (qpu || QUOTA_PER_UNIT_DEFAULT)) * 100) / 100;
}

// ─────────────────────────── access-токен (jwt-хосты) ───────────────────────────

// POST /api/user/auth/refresh с refresh-кукой → { access_token, user }.
// Путь найден в публичном бандле консоли tabitoken.com. Кука одноразовая:
// новое значение приходит в set-cookie и уезжает в jar внутри apiFetch.
// Ответ уже содержит user с quota и used_quota — отдельный /api/user/self не нужен.
async function refreshAccessToken(host, cookie, jar = null, jarK = null) {
    const r = await apiFetch(host, '/api/user/auth/refresh', { method: 'POST', body: {}, cookie, jar, jarK });
    if (r.waf || r.status === 429) {
        coolDownHost(host);
        return { ok: false, status: r.status, error: r.waf ? 'WAF-заглушка (слишком часто)' : 'слишком часто (429)' };
    }
    if (r.status !== 200 || !r.json || r.json.success === false) {
        return { ok: false, status: r.status, error: (r.json && r.json.message) || `HTTP ${r.status}` };
    }
    const d = r.json.data || {};
    const token = d.access_token || d.token || d.accessToken || null;
    if (!token) return { ok: false, status: r.status, error: 'в ответе refresh нет access_token' };
    return { ok: true, token, user: d.user || null, expiresAt: toMillis(d.access_expires_at) };
}

// ──────────────────────────── точный баланс ────────────────────────────

function selfToBalance(me, qpu) {
    const quota = Number(me.quota);
    const used = Number(me.used_quota);
    const balance = quotaToUsd(quota, qpu);
    const spent = quotaToUsd(used, qpu);
    return {
        ok: true,
        source: 'self',
        userId: me.id != null ? Number(me.id) : null,
        username: me.username || null,
        quota, usedQuota: used,
        balance,
        spent,
        // «Выдано всего» = остаток + расход. Реальная сумма, а не угаданный грант.
        granted: (balance != null && spent != null) ? Math.round((balance + spent) * 100) / 100 : null,
    };
}

// Главная функция. Даём ей хост и путь профиля (или готовый accessToken) —
// получаем точный остаток. Ни один провал не кидает: возвращаем { ok:false, error },
// вызывающая сторона откатывается на свой прежний расчёт.
//
// { host, profileDir, accessToken, userId } → { ok, source, balance, spent, granted, userId, username }
async function accountSelf(opts) {
  try {
    return await accountSelfInner(opts);
  } catch (e) {
    // Сетевые обрывы отдаём результатом: вызывающая сторона откатится на анкер,
    // а не потеряет весь расчёт баланса из-за одного таймаута.
    return { ok: false, error: (e.cause && e.cause.code) || e.message };
  }
}

async function accountSelfInner({ host, profileDir, accessToken = null, userId = null }) {
    if (!host) return { ok: false, error: 'host обязателен' };
    const kind = authKind(host);
    const cooling = hostCoolingDown(host);
    if (cooling) return { ok: false, error: `шлюз отбивает по частоте, пауза ещё ${cooling}с` };
    const qpu = await quotaPerUnit(host);
    const jar = loadJar();
    const jarK = jarKey(host, profileDir);
    const entry = jar[jarK] || {};

    // 1. Готовый access-токен (переданный или закешированный в jar). Ни куки,
    // ни профиля не нужно. classic-инстансы принимают его в Authorization ГОЛЫМ
    // (без схемы), jwt-инстансы — как Bearer.
    const cachedFresh = entry.access && (!entry.accessExpiresAt || entry.accessExpiresAt - Date.now() > 30_000);
    const token = accessToken || (cachedFresh ? entry.access : null);
    if (token) {
        try {
            const r = kind === 'jwt'
                ? await apiFetch(host, '/api/user/self', { bearer: token, jar, jarK })
                : await apiFetchRawAuth(host, '/api/user/self', token);
            if (r.status === 200 && r.json && r.json.data) return selfToBalance(r.json.data, qpu);
        } catch { /* токен протух — ниже пробуем куки профиля */ }
    }

    if (!profileDir || !fs.existsSync(profileDir)) {
        return { ok: false, error: 'нет профиля с куками' };
    }
    const cookie = effectiveCookieHeader(host, profileDir, jar);
    if (!cookie) return { ok: false, error: cookieFailReason(profileDir, host) };

    if (kind === 'jwt') {
        const rt = await refreshAccessToken(host, cookie, jar, jarK);
        if (!rt.ok) {
            const expired = rt.status === 401 || rt.status === 403;
            return {
                ok: false, stale: expired,
                error: expired ? 'сессия профиля истекла — открой ЛК аккаунта, чтобы обновить' : `refresh: ${rt.error}`,
            };
        }
        // Кешируем access-токен, чтобы следующий чек не жёг одноразовую refresh-куку.
        const j = loadJar();
        const e = j[jarK] || (j[jarK] = {});
        e.access = rt.token;
        e.accessExpiresAt = rt.expiresAt || 0;
        e.updatedAt = new Date().toISOString();
        saveJar(j);
        // Ответ refresh уже содержит quota и used_quota — второй запрос не нужен.
        if (rt.user && rt.user.quota != null && rt.user.used_quota != null) {
            return selfToBalance(rt.user, qpu);
        }
        const r = await apiFetch(host, '/api/user/self', { bearer: rt.token });
        if (r.status === 200 && r.json && r.json.data) return selfToBalance(r.json.data, qpu);
        if (rt.user && rt.user.quota != null) return selfToBalance(rt.user, qpu);
        return { ok: false, error: `self: HTTP ${r.status}` };
    }

    // classic: нужен New-Api-User — берём id из подписанной сессионной куки.
    const cookies = readProfileCookies(profileDir);
    const sess = cookies.find(c => (c.host === host || c.host.endsWith('.' + host)) && c.name === 'session');
    const uid = userId || (sess ? sessionUserId(sess.value) : null);
    if (!uid) return { ok: false, error: 'не удалось определить New-Api-User id' };
    const r = await apiFetch(host, '/api/user/self', { cookie, userId: uid, jar, jarK });
    if (r.status === 200 && r.json && r.json.data) return selfToBalance(r.json.data, qpu);
    if (r.waf || r.status === 429) {
        coolDownHost(host);
        return { ok: false, error: r.waf ? 'WAF-заглушка (слишком часто), пауза 10 мин' : 'слишком часто (429), пауза 10 мин' };
    }
    if (r.status === 401 || r.status === 403) {
        return { ok: false, error: `сессия профиля недействительна (HTTP ${r.status})`, stale: true };
    }
    return { ok: false, error: `self: HTTP ${r.status}` };
}

// classic-инстансы New-API принимают access-токен в Authorization БЕЗ схемы Bearer.
async function apiFetchRawAuth(host, pathQuery, token) {
    const res = await fetch(`https://${host}${pathQuery}`, {
        method: 'GET',
        headers: {
            'accept': 'application/json',
            'user-agent': UA,
            'referer': `https://${host}/console`,
            'authorization': token,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json = null, text = null;
    try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, ok: res.ok, json, text };
}

// Выпуск долгоживущего access-токена аккаунта (classic-инстансы: GET /api/user/token).
// ВНИМАНИЕ: перезатирает прежний access-токен аккаунта. Провал мягкий — вызывающая
// сторона просто продолжает ходить куками.
async function mintAccessToken({ host, profileDir, userId = null }) {
    try {
        if (authKind(host) === 'jwt') return { ok: false, error: 'jwt-инстанс: access-токен берётся через refresh' };
        const cookies = readProfileCookies(profileDir);
        const cookie = cookieHeaderFor(cookies, host);
        if (!cookie) return { ok: false, error: 'нет куки' };
        const sess = cookies.find(c => (c.host === host || c.host.endsWith('.' + host)) && c.name === 'session');
        const uid = userId || (sess ? sessionUserId(sess.value) : null);
        if (!uid) return { ok: false, error: 'нет user id' };
        const r = await apiFetch(host, '/api/user/token', { cookie, userId: uid });
        const tok = r.json && (r.json.data || r.json.message);
        if (r.status === 200 && typeof tok === 'string' && tok.length >= 16) return { ok: true, token: tok };
        return { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
}

// ──────────────────── ключи аккаунта (для связки профиль ↔ запись) ────────────────────

// GET /api/token/ отдаёт ключ ЗАМАСКИРОВАННЫМ (sk-78xp******), поэтому полный
// ключ раскрываем отдельным POST /api/token/<id>/key — как getTokenKey
// в helpcoder/lib/helpcoder-api.js. Нужно только для сопоставления, не для баланса.
async function listAccountKeys({ host, profileDir, userId = null, reveal = true }) {
  try {
    return await listAccountKeysInner({ host, profileDir, userId, reveal });
  } catch (e) {
    // Сетевые обрывы к шлюзу — обычное дело; наверх отдаём как результат, а не как
    // исключение, иначе сопоставление профилей падает целиком из-за одного аккаунта.
    return { ok: false, error: (e.cause && e.cause.code) || e.message, keys: [] };
  }
}

async function listAccountKeysInner({ host, profileDir, userId, reveal }) {
    const kind = authKind(host);
    const jar = loadJar();
    const jarK = jarKey(host, profileDir);
    const cookie = effectiveCookieHeader(host, profileDir, jar);
    if (!cookie) return { ok: false, error: cookieFailReason(profileDir, host), keys: [] };

    let auth;
    if (kind === 'jwt') {
        const entry = jar[jarK] || {};
        const cachedFresh = entry.access && (!entry.accessExpiresAt || entry.accessExpiresAt - Date.now() > 30_000);
        let token = cachedFresh ? entry.access : null;
        if (!token) {
            const rt = await refreshAccessToken(host, cookie, jar, jarK);
            if (!rt.ok) return { ok: false, error: `refresh: ${rt.error}`, keys: [] };
            token = rt.token;
            const j = loadJar();
            const e = j[jarK] || (j[jarK] = {});
            e.access = token; e.accessExpiresAt = rt.expiresAt || 0; e.updatedAt = new Date().toISOString();
            saveJar(j);
        }
        auth = { bearer: token };
    } else {
        const cookies = readProfileCookies(profileDir);
        const sess = cookies.find(c => (c.host === host || c.host.endsWith('.' + host)) && c.name === 'session');
        const uid = userId || (sess ? sessionUserId(sess.value) : null);
        if (!uid) return { ok: false, error: 'нет user id', keys: [] };
        auth = { cookie, userId: uid };
    }

    const r = await apiFetch(host, '/api/token/?p=0&size=50', auth);
    if (r.status !== 200 || !r.json) return { ok: false, error: `token list HTTP ${r.status}`, keys: [] };
    const d = r.json.data || {};
    const items = Array.isArray(d) ? d : (d.items || d.records || []);
    const keys = [];
    for (const it of items) {
        // Инстансы ведут себя по-разному: agentrouter отдаёт в поле key ПОЛНЫЙ ключ
        // (только без префикса sk-), gorouter — замаскированный вида sk-78xp******.
        // Раскрывающий POST есть не везде, поэтому дёргаем его лишь когда реально
        // видим звёздочки, иначе зря шлём запрос (и получаем пустоту).
        const raw = it.key ? String(it.key) : '';
        const masked = !raw || raw.includes('*');
        let full = null;
        if (raw && !masked) {
            full = raw.startsWith('sk-') ? raw : 'sk-' + raw;
        } else if (reveal) {
            try {
                const rr = await apiFetch(host, `/api/token/${encodeURIComponent(it.id)}/key`, { method: 'POST', ...auth });
                const k = rr.json && rr.json.data && (rr.json.data.key || rr.json.data);
                if (k && typeof k === 'string') full = k.startsWith('sk-') ? k : 'sk-' + k;
            } catch {}
        }
        keys.push({ id: it.id, name: it.name, key: full, masked: masked ? raw : null });
    }
    return { ok: true, keys };
}

module.exports = {
    QUOTA_PER_UNIT_DEFAULT, HOST_AUTH, authKind,
    profileAesKey, warmAesKeys, readProfileCookies, cookieHeaderFor, githubLogin,
    cookieBackendReady, cookieFailReason,
    writeProfileCookies, syncJarToProfile,
    sessionUserId, userIdFromUsername,
    quotaPerUnit, quotaToUsd, hostGate,
    loadJar, saveJar, jarKey, effectiveCookieHeader,
    accountSelf, refreshAccessToken, mintAccessToken, listAccountKeys,
};
