// freemodel/lib/tg-pool.js
//
// JSON-pool готовых Telegram-аккаунтов для freemodel-автореги.
// Источник аккаунтов — магазин (отдаёт HEX auth_key + dc_id + user_id).
// Один аккаунт = одна привязка к freemodel, после использования status=used.
//
// Запись в файле:
// {
//   "phone":        "13678875285",         // как на сайте магазина
//   "dc_id":        1,                     // 1..5
//   "user_id":      "8681576074",
//   "auth_key_hex": "2b58f8...06c",        // 256 байт = 512 hex символов
//   "status":       "free" | "used" | "banned",
//   "addedAt":      "2026-06-13T...Z",
//   "usedBy":       null | "<email>",      // freemodel-email который этот TG привязал
//   "usedAt":       null | "..."
// }

const fs = require('fs');
const path = require('path');

const POOL_FILE = path.join(__dirname, '..', 'tg_pool.json');

function load() {
    if (!fs.existsSync(POOL_FILE)) return [];
    try {
        const raw = fs.readFileSync(POOL_FILE, 'utf8');
        if (!raw.trim()) return [];
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(`tg_pool.json повреждён: ${e.message}`);
    }
}

function save(arr) {
    fs.writeFileSync(POOL_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

function normalizeHex(s) {
    return String(s || '').replace(/\s+/g, '').replace(/^0x/i, '').toLowerCase();
}

function validateEntry(e) {
    // phone: может быть как обычным числом, так и плейсхолдером `tg_<hex>` для
    // случая когда магазин дал только hex:dc без номера. Плейсхолдер
    // используется как уникальный ID до тех пор, пока пользователь не подставит
    // настоящий phone через rename().
    const phoneStr = String(e.phone || '');
    const isPlaceholder = /^tg_[0-9a-f]{4,}$/.test(phoneStr);
    if (!phoneStr || (!isPlaceholder && !/^\+?\d{6,18}$/.test(phoneStr))) {
        throw new Error(`bad phone: ${e.phone}`);
    }
    if (!Number.isInteger(e.dc_id) || e.dc_id < 1 || e.dc_id > 5) throw new Error(`bad dc_id: ${e.dc_id}`);
    if (e.user_id == null || !/^\d{1,20}$/.test(String(e.user_id))) throw new Error(`bad user_id: ${e.user_id}`);
    const hex = normalizeHex(e.auth_key_hex);
    if (!/^[0-9a-f]+$/.test(hex)) throw new Error('auth_key_hex: не hex');
    if (hex.length !== 512) throw new Error(`auth_key_hex длиной ${hex.length}, ожидаю 512`);
    return {
        ...e,
        phone: isPlaceholder ? phoneStr : phoneStr.replace(/^\+/, ''),
        auth_key_hex: hex,
        user_id: String(e.user_id),
        isPlaceholderPhone: isPlaceholder || undefined,
    };
}

// ── Публичный API ─────────────────────────────────────────────

function list() {
    return load();
}

function addHex({ phone, dc_id, user_id, auth_key_hex, source }) {
    const entry = validateEntry({
        phone, dc_id: Number(dc_id), user_id, auth_key_hex,
        source: source || 'hex',   // 'session' = из .session (Pyrogram/Telethon), 'hex' = ручной импорт
        status: 'free',
        addedAt: new Date().toISOString(),
        usedBy: null,
        usedAt: null,
    });
    const arr = load();
    if (arr.some(e => e.phone === entry.phone)) {
        throw new Error(`phone ${entry.phone} уже в пуле`);
    }
    arr.push(entry);
    save(arr);
    return entry;
}

// Резервация (мягкая): помечаем "reserved" чтобы параллельные процессы не взяли тот же.
// Финализация — markUsed/markBanned/markFree.
function reserve(usedBy) {
    const arr = load();
    // Берём самый старый free (FIFO).
    const idx = arr.findIndex(e => e.status === 'free');
    if (idx === -1) return null;
    arr[idx].status = 'reserved';
    arr[idx].usedBy = usedBy || null;
    arr[idx].usedAt = new Date().toISOString();
    save(arr);
    return arr[idx];
}

function markUsed(phone, usedBy) {
    const arr = load();
    const e = arr.find(x => x.phone === String(phone));
    if (!e) return null;
    e.status = 'used';
    if (usedBy) e.usedBy = usedBy;
    if (!e.usedAt) e.usedAt = new Date().toISOString();
    save(arr);
    return e;
}

// Сохранена для обратной совместимости (резервация + сразу used).
function take(usedBy) {
    const r = reserve(usedBy);
    if (!r) return null;
    return markUsed(r.phone, usedBy);
}

function markBanned(phone, reason) {
    const arr = load();
    const e = arr.find(x => x.phone === String(phone));
    if (!e) return null;
    e.status = 'banned';
    e.banReason = reason || null;
    e.bannedAt = new Date().toISOString();
    save(arr);
    return e;
}

function markFree(phone) {
    const arr = load();
    const e = arr.find(x => x.phone === String(phone));
    if (!e) return null;
    e.status = 'free';
    e.usedBy = null;
    e.usedAt = null;
    delete e.banReason;
    delete e.bannedAt;
    save(arr);
    return e;
}

function remove(phone) {
    const arr = load();
    const i = arr.findIndex(x => x.phone === String(phone));
    if (i === -1) return false;
    arr.splice(i, 1);
    save(arr);
    return true;
}

// Переименовать запись (обычно: tg_<hex> → реальный номер).
function rename(oldPhone, newPhone) {
    const arr = load();
    const e = arr.find(x => x.phone === String(oldPhone));
    if (!e) throw new Error(`не найден: ${oldPhone}`);
    const normalized = String(newPhone).replace(/^\+/, '').replace(/\s+/g, '');
    if (!/^\d{6,18}$/.test(normalized)) throw new Error(`bad phone: ${newPhone}`);
    if (arr.some(x => x.phone === normalized && x !== e)) {
        throw new Error(`phone ${normalized} уже занят`);
    }
    e.phone = normalized;
    delete e.isPlaceholderPhone;
    save(arr);
    return e;
}

// Маскированный auth_key для UI: 2b58…1306c
function maskAuthKey(hex) {
    const h = normalizeHex(hex);
    if (h.length < 12) return h;
    return h.slice(0, 6) + '…' + h.slice(-5);
}

function stats() {
    const arr = load();
    return {
        total:    arr.length,
        free:     arr.filter(e => e.status === 'free').length,
        reserved: arr.filter(e => e.status === 'reserved').length,
        used:     arr.filter(e => e.status === 'used').length,
        banned:   arr.filter(e => e.status === 'banned').length,
    };
}

// Pre-pass: склеить hex-блоки, разорванные переносами строк / пробелами.
// Браузер при вставке длинного hex (512 символов) часто переносит его на
// 2-3 визуальные строки. Это убивает построчный парсер. Поэтому проходим по
// тексту и схлопываем пробелы/переносы внутри длинных hex-серий (≥200 hex-
// символов после схлопывания — заведомо auth_key, обычный токен короче).
//
// Регекс жадно глотает максимальный рейн (hex|whitespace), начинающийся и
// заканчивающийся на hex. Не-hex и не-whitespace (`:`, `|`, `+`, любая буква
// кроме a-f) обрывают рейн — значит соседние записи не сливаются между собой.
function preprocessBulk(text) {
    // Склеиваем пробелы/табы ВНУТРИ строки, но НЕ переносы строк: dc-цифра (1–5 —
    // валидный hex) иначе приклеивается через \n к следующему ключу и весь батч
    // схлопывается в одну строку. \n = разделитель аккаунтов.
    return String(text || '').replace(/[0-9a-fA-F][0-9a-fA-F \t]*[0-9a-fA-F]/g, (m) => {
        const stripped = m.replace(/[ \t]+/g, '');
        return stripped.length >= 200 ? stripped : m;
    });
}

// Парсер свободного формата. Принимает многострочный текст, отдаёт
// { entries: [...], errors: [{line, raw, error}] }. Распознаёт:
//   phone|hex:dc
//   hex:dc
//   phone hex dc
//   phone hex dc user_id
//   phone\thex\tdc[\tuser_id]
// Эвристика: hex = единственный токен длиной 512, dc = 1..5, phone = самое
// длинное число (>=7 цифр), user_id = другое число.
function parseBulk(text) {
    const out = { entries: [], errors: [], duplicates: [] };
    const existing = new Set(load().map(e => e.phone));
    const linesSeen = new Set();
    let lineNo = 0;

    const cleaned = preprocessBulk(text);
    for (const raw of cleaned.split(/\r?\n/)) {
        lineNo++;
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;

        try {
            // Разбиваем на токены по пробелу, табу, |, ; — но НЕ по ':'
            // (двоеточие используется только в hex:dc).
            const tokens = line.split(/[\s|;,]+/).filter(Boolean);

            // Найти hex (с опциональным :dc на конце).
            let hex = null, dcFromHex = null;
            for (let i = 0; i < tokens.length; i++) {
                const m = tokens[i].match(/^([0-9a-fA-F]{512})(?::(\d{1,2}))?$/);
                if (m) {
                    hex = m[1].toLowerCase();
                    if (m[2]) dcFromHex = Number(m[2]);
                    tokens.splice(i, 1);
                    break;
                }
            }
            if (!hex) throw new Error('не нашёл 512-hex auth_key');

            // Остальные токены: числа. Самое длинное — phone, отдельная цифра 1-5 — dc,
            // другие цифры (если есть) — user_id.
            const nums = tokens.filter(t => /^\+?\d+$/.test(t)).map(t => t.replace(/^\+/, ''));
            let dc = dcFromHex;
            let phone = null;
            let userId = null;

            // 1-значный токен в диапазоне 1..5 — это dc.
            for (let i = 0; i < nums.length; i++) {
                if (!dc && nums[i].length === 1 && Number(nums[i]) >= 1 && Number(nums[i]) <= 5) {
                    dc = Number(nums[i]);
                    nums.splice(i, 1);
                    break;
                }
            }
            // Из оставшихся — самое длинное это phone (≥7 цифр).
            nums.sort((a, b) => b.length - a.length);
            for (const n of nums) {
                if (!phone && n.length >= 7 && n.length <= 18) { phone = n; continue; }
                if (!userId && n.length >= 4) { userId = n; }
            }

            if (!dc) throw new Error('не нашёл DC ID (число 1–5)');
            // Если phone нет — генерим плейсхолдер из первых 8 символов hex.
            // Пользователь сможет переименовать через rename() с UI.
            if (!phone) phone = 'tg_' + hex.slice(0, 8);

            if (existing.has(phone) || linesSeen.has(phone)) {
                out.duplicates.push({ line: lineNo, phone });
                continue;
            }
            linesSeen.add(phone);

            out.entries.push({
                phone,
                dc_id: dc,
                user_id: userId || '0',
                auth_key_hex: hex,
            });
        } catch (e) {
            out.errors.push({ line: lineNo, raw: line.slice(0, 80), error: e.message });
        }
    }
    return out;
}

// Применить распарсенный батч. Возвращает {added, errors}.
function addBulk(entries) {
    const out = { added: [], errors: [] };
    for (const e of entries) {
        try {
            addHex(e);
            out.added.push(e.phone);
        } catch (err) {
            out.errors.push({ phone: e.phone, error: err.message });
        }
    }
    return out;
}

module.exports = {
    POOL_FILE,
    list,
    stats,
    addHex,
    take,
    reserve,
    markUsed,
    markBanned,
    markFree,
    remove,
    rename,
    maskAuthKey,
    normalizeHex,
    parseBulk,
    addBulk,
};
