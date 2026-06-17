// freemodel/lib/tg-session-parser.js
//
// Извлечь dc_id + auth_key (hex) + user_id из .session-файла.
// Поддерживает два популярных формата SQLite:
//   - Telethon:  sessions(dc_id, server_address, port, auth_key, takeout_id)
//                user_id чаще в entities.id
//   - Pyrogram:  sessions(dc_id, test_mode, auth_key, date, user_id, is_bot)
//                user_id лежит прямо в sessions
//
// Используем системный sqlite3.exe, чтобы не тащить better-sqlite3.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SQLITE_EXE = process.env.SQLITE3
    || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe');

function runSqlite(dbPath, sql) {
    if (!fs.existsSync(SQLITE_EXE)) {
        throw new Error(`sqlite3 не найден: ${SQLITE_EXE} (set SQLITE3 env var)`);
    }
    const out = execFileSync(SQLITE_EXE, [dbPath, '-json', sql], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
    });
    return out ? JSON.parse(out) : [];
}

function tableColumns(dbPath, tableName) {
    try {
        const rows = runSqlite(dbPath, `PRAGMA table_info(${tableName});`);
        return rows.map(r => String(r.name).toLowerCase());
    } catch {
        return [];
    }
}

function hasTable(dbPath, tableName) {
    try {
        const rows = runSqlite(dbPath,
            `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}';`);
        return rows.length > 0;
    } catch {
        return false;
    }
}

// Парсит buffer (содержимое .session-файла) → { phone?, dc_id, user_id, auth_key_hex }.
function parseSessionBuffer(buf, fallbackPhone = null) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);

    const tmp = path.join(os.tmpdir(), `_tg_session_${process.pid}_${Date.now()}.session`);
    fs.writeFileSync(tmp, buf);
    try {
        if (!hasTable(tmp, 'sessions')) {
            throw new Error('в .session нет таблицы sessions');
        }

        const sessCols = tableColumns(tmp, 'sessions');
        const needCols = ['dc_id'];
        if (sessCols.includes('auth_key')) needCols.push('hex(auth_key) AS auth_key_hex');
        if (sessCols.includes('user_id')) needCols.push('user_id');

        const rows = runSqlite(tmp,
            `SELECT ${needCols.join(', ')} FROM sessions WHERE auth_key IS NOT NULL;`);
        if (!rows.length) throw new Error('в .session нет записей с auth_key');

        const sess = rows.find(r => r.auth_key_hex && r.auth_key_hex.length === 512) || rows[0];
        if (!sess.auth_key_hex || sess.auth_key_hex.length !== 512) {
            throw new Error(`auth_key неверной длины: ${sess.auth_key_hex && sess.auth_key_hex.length}`);
        }

        // user_id: сначала из sessions (Pyrogram), fallback на entities (Telethon).
        let userId = sess.user_id ? String(sess.user_id) : null;
        if (!userId && hasTable(tmp, 'entities')) {
            try {
                const ent = runSqlite(tmp,
                    "SELECT id FROM entities WHERE id > 0 ORDER BY id ASC LIMIT 1;");
                if (ent[0] && ent[0].id) userId = String(ent[0].id);
            } catch {
                // entities может отсутствовать или быть пустой
            }
        }

        // phone: попробуем вытащить из peers (Pyrogram), иначе fallback.
        let phone = fallbackPhone;
        if (!phone && hasTable(tmp, 'peers')) {
            try {
                const peerRows = runSqlite(tmp,
                    "SELECT phone_number FROM peers WHERE type = 1 AND phone_number IS NOT NULL LIMIT 1;");
                if (peerRows[0] && peerRows[0].phone_number) {
                    phone = String(peerRows[0].phone_number).replace(/^\+/, '');
                }
            } catch {}
        }

        return {
            phone,
            dc_id: Number(sess.dc_id),
            user_id: userId,
            auth_key_hex: String(sess.auth_key_hex).toLowerCase(),
        };
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

module.exports = { parseSessionBuffer };
