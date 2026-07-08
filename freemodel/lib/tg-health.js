// freemodel/lib/tg-health.js
//
// Безбанный health-check TG-пула: коннект по auth_key + getMe() — read-only,
// без сообщений/вступлений → анти-спам Telegram не триггерит. Результат
// кэшируется в freemodel/.tg_health_cache.json; UI читает кэш, чек по кнопке.

const fs = require('fs');
const path = require('path');
const tgPool = require('./tg-pool');
const tgClient = require('./tg-client');

const CACHE = path.join(__dirname, '..', '.tg_health_cache.json');
const DEAD_RE = /SESSION_REVOKED|AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|USER_DEACTIVATED|deactivated|not authorized|не авторизован/i;

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
    fs.writeFileSync(CACHE, JSON.stringify(c, null, 2) + '\n', 'utf8');
}

// dead = ключ отозван/аккаунт удалён; error = сеть/таймаут (ключ может быть жив).
function classify(errMsg) {
    return DEAD_RE.test(String(errMsg || '')) ? 'dead' : 'error';
}

// Один аккаунт → { status: alive|dead|error, ... , checkedAt }.
async function checkOne(entry, logger = () => {}) {
    let out;
    let client = null;
    try {
        const created = await tgClient.createClient(entry, { logger });
        client = created.client;
        out = { status: 'alive', username: created.me.username || null, userId: String(created.me.id) };
    } catch (e) {
        out = { status: classify(e && e.message), error: String((e && e.message) || e).slice(0, 140) };
    } finally {
        // Всегда закрываем соединение — иначе висит в фоне, ест ресурсы и
        // при следующем чеке даёт AUTH_KEY_DUPLICATED (тот же ключ активен).
        if (client) { try { await tgClient.disconnect(client); } catch {} }
    }
    out.checkedAt = new Date().toISOString();
    return out;
}

// Все не-banned по очереди. ponytail: sequential = одно подключение с твоего IP
// за раз (gentle, не похоже на массовый логин); добавить малую concurrency,
// если пул разрастётся и минута ожидания начнёт мешать.
async function checkAll(logger = () => {}) {
    const cache = loadCache();
    const entries = tgPool.list().filter(e => e.status !== 'banned');
    let alive = 0, dead = 0, error = 0;
    for (const e of entries) {
        const r = await checkOne(e, logger);
        cache[e.phone] = r;
        saveCache(cache);                 // инкрементально — не терять при обрыве
        r.status === 'alive' ? alive++ : r.status === 'dead' ? dead++ : error++;
    }
    return { checked: entries.length, alive, dead, error };
}

// Один аккаунт по phone → пишет его в кэш, возвращает результат.
async function checkPhone(phone, logger = () => {}) {
    const entry = tgPool.list().find(e => String(e.phone) === String(phone));
    if (!entry) throw new Error(`phone ${phone} не в пуле`);
    const cache = loadCache();
    const r = await checkOne(entry, logger);
    cache[entry.phone] = r;
    saveCache(cache);
    return r;
}

// Удаление записи из кэша (вызывать когда номер снят из пула — иначе
// перезалитый под тем же phone аккаунт покажет старый dead до нового чека).
function forgetPhone(phone) {
    const c = loadCache();
    if (!(String(phone) in c)) return false;
    delete c[String(phone)];
    saveCache(c);
    return true;
}

// Убирает записи для phone'ов, которых нет в текущем пуле. Полезно вызывать
// после массовых удалений/переимпорта.
function pruneOrphans() {
    const c = loadCache();
    const alive = new Set(tgPool.list().map(e => String(e.phone)));
    let removed = 0;
    for (const phone of Object.keys(c)) {
        if (!alive.has(phone)) { delete c[phone]; removed++; }
    }
    if (removed) saveCache(c);
    return removed;
}

module.exports = { loadCache, saveCache, checkOne, checkPhone, checkAll, classify, forgetPhone, pruneOrphans, CACHE };

// Офлайн-самопроверка классификатора: node freemodel/lib/tg-health.js
if (require.main === module) {
    const assert = require('assert');
    assert.strictEqual(classify('rpc error AUTH_KEY_UNREGISTERED'), 'dead');
    assert.strictEqual(classify('getMe упал: USER_DEACTIVATED'), 'dead');
    assert.strictEqual(classify('TIMEOUT connection failed'), 'error');
    assert.strictEqual(classify(''), 'error');
    console.log('tg-health classify: OK');
}
