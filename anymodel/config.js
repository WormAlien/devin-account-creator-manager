// anymodel/config.js
//
// Конфиг для anymodel autoreger.

module.exports = {
    // ── Ссылки ─────────────────────────────────────────────
    REGISTER_URL: 'https://anymodel.org/app/register',
    DASHBOARD_URL: 'https://anymodel.org/app/dashboard',
    LOGIN_URL: 'https://anymodel.org/app/login',

    // ── Telegram ───────────────────────────────────────────
    // Бот anymodel для верификации
    TG_BOT: 'anyModelBot',
    TG_CHANNEL: 'anymodelAI',       // канал для подписки
    TG_CHAT: 'anymodel_chat',       // чат для вступления

    // ── Количество ─────────────────────────────────────────
    ACCOUNTS_COUNT: 5,              // 0 = ∞
    DELAY_BETWEEN_ACCOUNTS_MS: 8000,

    // ── Пароль ─────────────────────────────────────────────
    ACCOUNT_PASSWORD: 'Anymodel_2026!!!',

    // ── Браузер ────────────────────────────────────────────
    HEADLESS: false,
    VIEWPORT: { width: 1280, height: 800 },
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    LOCALE: 'ru-RU',

    // ── Прокси ─────────────────────────────────────────────
    PROXY: null,

    // ── Email (tmailor через Camoufox) ────────────────────
    EMAIL_BACKEND: 'tmailor',       // только tmailor (Turnstile на anymodel)
    EMAIL_POLL_MS: 5000,
    EMAIL_WAIT_MAX_MS: 120 * 1000,  // 2 мин на OTP

    // Telegram API creds (public Telegram Desktop fallback)
    TG_API_ID: 2040,
    TG_API_HASH: 'b18441a1ff607e10a989891a5462e627',

    // Отправитель в письме (для matcher'а)
    EMAIL_FROM_HINT: 'anymodel',

    // ── Хранилище ─────────────────────────────────────────
    ACCOUNTS_DIR: 'anymodel/accounts',
    LOG_FILE: 'anymodel/logs/run.log',
};
