// freemodel/config.js
//
// Конфиг для freemodel autoreger.

module.exports = {
    // ── Реф-ссылки ─────────────────────────────────────────────
    // Стартовый инвайт (пирамида начинается с него).
    // Каждый зарегистрированный аккаунт даёт свою реф-ссылку,
    // следующая итерация будет регаться по ней.
    INITIAL_INVITE: 'FRE-1cc87478',
    SIGNUP_URL_TPL: 'https://freemodel.dev/invite/{CODE}',
    DASHBOARD_URL: 'https://freemodel.dev/dashboard',

    // ── Количество ─────────────────────────────────────────────
    ACCOUNTS_COUNT: 5,      // 0 = ∞
    DELAY_BETWEEN_ACCOUNTS_MS: 8000,

    // ── Telegram ───────────────────────────────────────────────
    // Автоматически привязывать свободный TG-аккаунт из tg_pool.json
    // после успешной регистрации и создавать API-ключ.
    // Если не сработало — используй bind-tg-to-session.js для ручного выбора сессии и TG.
    AUTO_BIND_TELEGRAM: true,

    // ── Браузер ────────────────────────────────────────────────
    HEADLESS: false,        // визуально надёжнее на старте
    VIEWPORT: { width: 1280, height: 800 },
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    LOCALE: 'en-US',

    // ── Прокси ─────────────────────────────────────────────────
    // строка формата http://user:pass@host:port или null
    PROXY: null,

    // ── Email ─────────────────────────────────────────────────
    EMAIL_POLL_MS: 5000,
    EMAIL_WAIT_MAX_MS: 50 * 1000,
    // tmailor.com ротирует домены (hetzez.com и др.). Пустой массив = любой домен.
    // Если FreeModel начнёт банить конкретный домен — добавьте сюда только рабочие.
    EMAIL_ALLOWED_DOMAINS: [],

    // Telegram API creds (public Telegram Desktop fallback).
    // Используются gramjs для логина по auth_key из tg_pool.json.
    TG_API_ID: 2040,
    TG_API_HASH: 'b18441a1ff607e10a989891a5462e627',

    // Отправитель в письме от freemodel (для matcher'а)
    EMAIL_FROM_HINT: 'freemodel',
    // Ключевые слова, по которым ищем "верификационное" письмо
    EMAIL_SUBJECT_HINTS: ['verify', 'verification', 'sign in', 'login', 'confirm', 'magic'],

    // ── Хранилище ─────────────────────────────────────────────
    ACCOUNTS_DIR: 'freemodel/accounts',
    KEYS_FILE: 'freemodel/keys.txt',
    LOG_FILE: 'freemodel/logs/run.log',
};
