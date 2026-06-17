// freemodel/lib/tg-client.js
//
// Тонкая обёртка над gramjs для логина по готовому auth_key (без SMS).
//
// Кейс: магазин даёт `dc_id + auth_key (hex)`. Нам не нужны phone_code_hash,
// twofa, ничего. Создаём gramjs клиент, кладём auth_key в нужный DC, говорим
// "ты уже залогинен" — дальше отправляем боту /start и читаем входящие.
//
// Зависимость: npm i telegram  (gramjs, pure JS, ~3 MB).

const config = require('../config');

let _telegram = null;
function tg() {
    if (!_telegram) {
        try {
            _telegram = require('telegram');
        } catch (e) {
            throw new Error(
                'не установлен пакет "telegram" (gramjs). Запусти: npm i telegram'
            );
        }
    }
    return _telegram;
}

// Prod DC адреса. gramjs обычно знает их сам, но при логине по голому auth_key
// без bootstrap-конфига иногда не находит — задаём явно.
const DC_IPS = {
    1: { ip: '149.154.175.50',  port: 443 },  // Майами
    2: { ip: '149.154.167.51',  port: 443 },  // Амстердам
    3: { ip: '149.154.175.100', port: 443 },  // Майами (backup)
    4: { ip: '149.154.167.91',  port: 443 },  // Амстердам (backup)
    5: { ip: '91.108.56.130',   port: 443 },  // Сингапур
};

// Создаёт TelegramClient уже залогиненный по auth_key.
// entry: { phone, dc_id, user_id, auth_key_hex }
async function createClient(entry, { logger = () => {} } = {}) {
    const { TelegramClient } = tg();
    const { StringSession } = tg().sessions;
    const { AuthKey } = require('telegram/crypto/AuthKey');

    const apiId = Number(config.TG_API_ID);
    const apiHash = String(config.TG_API_HASH);
    if (!apiId || !apiHash) {
        throw new Error('TG_API_ID / TG_API_HASH не заданы в freemodel/config.js');
    }

    const dc = DC_IPS[entry.dc_id];
    if (!dc) throw new Error(`неизвестный dc_id: ${entry.dc_id}`);

    // Пустая StringSession + ручная установка auth_key. gramjs допускает это
    // через session.setAuthKey + session.setDC после создания клиента.
    const session = new StringSession('');
    const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 3,
        retryDelay: 1000,
        useWSS: false,
        autoReconnect: true,
        baseLogger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    // Кладём auth_key + DC ДО connect().
    const authKey = new AuthKey();
    await authKey.setKey(Buffer.from(entry.auth_key_hex, 'hex'));
    session.setDC(entry.dc_id, dc.ip, dc.port);
    session.setAuthKey(authKey);
    if (entry.user_id) {
        session.setUserId?.(BigInt(entry.user_id));
    }

    logger(`[tg] connect dc${entry.dc_id} ${dc.ip}:${dc.port} as ${entry.phone}`);
    await client.connect();

    // Проверяем что мы действительно залогинены.
    const me = await client.getMe().catch((e) => {
        throw new Error(`getMe упал: ${e.message}`);
    });
    logger(`[tg] me: id=${me.id} username=@${me.username || '-'} phone=${me.phone || '-'}`);
    return { client, me };
}

// Отсылает `/start <token>` боту (для magic-link флоу freemodel-стиля,
// когда привязка подтверждается на стороне сервера а не вводом кода).
// Возвращает { sent: true, reply } или null если бот не ответил.
async function sendStartWithToken(client, botUsername, token, { timeoutMs = 30_000, logger = () => {} } = {}) {
    const target = botUsername.startsWith('@') ? botUsername.slice(1) : botUsername;
    logger(`[tg] resolve bot @${target}`);
    const entity = await client.getEntity(target);

    let firstReply = null;
    let resolver;
    const waitPromise = new Promise((res) => { resolver = res; });

    const handler = (event) => {
        try {
            const m = event.message;
            if (!m || !m.peerId) return;
            const fromId = m.peerId.userId?.toString?.();
            if (fromId !== entity.id.toString()) return;
            if (firstReply) return;
            firstReply = m.message || '(пусто)';
            resolver({ sent: true, reply: firstReply });
        } catch (e) {
            logger(`[tg] handler err: ${e.message}`);
        }
    };

    const { NewMessage } = require('telegram/events');
    const filter = new NewMessage({ incoming: true });
    client.addEventHandler(handler, filter);

    try {
        const msg = token ? `/start ${token}` : '/start';
        logger(`[tg] ${msg} → @${target}`);
        await client.sendMessage(entity, { message: msg });

        // Не валим если ответа нет — freemodel может молча кивнуть серверу
        // и не отвечать пользователю в чате.
        const got = await Promise.race([
            waitPromise,
            new Promise((res) => setTimeout(() => res({ sent: true, reply: null }), timeoutMs)),
        ]);
        return got;
    } finally {
        try { client.removeEventHandler(handler, filter); } catch {}
    }
}

// Отсылает /start боту и ждёт первое входящее сообщение от него с цифрами.
// Возвращает { code, raw } или null если не получилось.
async function getCodeFromBot(client, botUsername, { timeoutMs = 60_000, codeRegex = /\b(\d{5,7})\b/, logger = () => {} } = {}) {
    const { Api } = tg();

    const target = botUsername.startsWith('@') ? botUsername.slice(1) : botUsername;
    logger(`[tg] resolve bot @${target}`);
    const entity = await client.getEntity(target);

    // Сначала подпишемся на новые сообщения, потом отправим /start —
    // чтобы не пропустить мгновенный ответ.
    let resolved = null;
    let resolver;
    const waitPromise = new Promise((res) => { resolver = res; });

    const handler = (event) => {
        try {
            const m = event.message;
            if (!m || !m.peerId) return;
            const fromId = m.peerId.userId?.toString?.();
            if (fromId !== entity.id.toString()) return;
            const text = m.message || '';
            const cm = text.match(codeRegex);
            if (cm) {
                resolved = { code: cm[1], raw: text };
                resolver(resolved);
            }
        } catch (e) {
            logger(`[tg] handler err: ${e.message}`);
        }
    };

    const { NewMessage } = require('telegram/events');
    const filter = new NewMessage({ incoming: true });
    client.addEventHandler(handler, filter);

    try {
        logger(`[tg] /start → @${target}`);
        await client.sendMessage(entity, { message: '/start' });

        const got = await Promise.race([
            waitPromise,
            new Promise((res) => setTimeout(() => res(null), timeoutMs)),
        ]);
        return got;
    } finally {
        try { client.removeEventHandler(handler, filter); } catch {}
    }
}

async function disconnect(client) {
    try { await client.disconnect(); } catch {}
    try { await client.destroy(); } catch {}
}

module.exports = {
    DC_IPS,
    createClient,
    sendStartWithToken,
    getCodeFromBot,
    disconnect,
};
