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
    EMAIL_WAIT_MAX_MS: 5 * 60 * 1000,

    // Отправитель в письме от freemodel (для matcher'а)
    EMAIL_FROM_HINT: 'freemodel',
    // Ключевые слова, по которым ищем "верификационное" письмо
    EMAIL_SUBJECT_HINTS: ['verify', 'verification', 'sign in', 'login', 'confirm', 'magic'],

    // ── Хранилище ─────────────────────────────────────────────
    ACCOUNTS_DIR: 'freemodel/accounts',
    KEYS_FILE: 'freemodel/keys.txt',
    LOG_FILE: 'freemodel/logs/run.log',
};
