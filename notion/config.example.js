// =====================================================
//   НАСТРОЙКИ NOTION AUTOREG — ПРИМЕР КОНФИГА
// =====================================================
//
//   Скопируйте этот файл в config.js и заполните своими данными:
//   cp config.example.js config.js
//
// =====================================================

module.exports = {

    // ---- ПРЕСЕТЫ КАРТ ----
    // Добавьте свою карту со страной биллинга
    CARD_PRESETS: [
        {
            label:    '🇺🇸 Visa · 4111…1111',
            number:   '4111111111111111',  // Замените на свою карту
            exp:      '12/30',              // MM/YY
            cvc:      '123',
            bin_info: 'Описание карты',
            billing: {
                name:    'John Doe',
                address: '123 Main Street',
                city:    'New York',
                state:   'NY',
                zip:     '10001',
                country: 'US',
                phone:   '+12015551234',
            },
        },
    ],

    // 'rotate' = по кругу, число = всегда этот индекс
    CARD_PRESET_INDEX: 0,

    // ---- АККАУНТ ----
    ACCOUNT_PASSWORD: 'YourPassword_2026!!!',

    // ---- БРАУЗЕР ----
    HEADLESS: false,
    VIEWPORT: { width: 1920, height: 1080 },

    // ---- ПРОКСИ ----
    PROXY: null,

    // ---- STEALTH ----
    STEALTH_ENABLED: true,

    // ---- ТАЙМИНГИ (мс) ----
    DELAY_TYPING: [40, 100],
    DELAY_BETWEEN_ACTIONS: [500, 1500],
    DELAY_PAGE_LOAD: 3000,
    DELAY_OTP_POLL: 3000,
    DELAY_OTP_WAIT: 120000,
    DELAY_PAYMENT_WAIT: 90000,

    // ---- РУЧНОЙ РЕЖИМ ----
    MANUAL_MODE: true,

    // ---- ОСТАНОВКА ПОСЛЕ OTP ----
    STOP_AFTER_OTP: true,

    // ---- ВЫВОД ----
    ACCOUNTS_FILE: 'logs/notion_accounts.txt',
    READY_DIR: 'ready',
    ERROR_DIR: 'errors',
    LOG_FILE: 'logs/notion.log',
    LOG_LEVEL: 'normal',

    // ---- СКРИНШОТЫ ----
    SCREENSHOT_ON_ERROR: true,

    // ---- ЗВУКОВЫЕ УВЕДОМЛЕНИЯ ----
    SOUND_NOTIFICATIONS: true,

    // ---- КОЛИЧЕСТВО ----
    ACCOUNTS_COUNT: 1,

    // ---- НЕ ЗАКРЫВАТЬ БРАУЗЕР ПОСЛЕ УСПЕХА ----
    KEEP_BROWSER_OPEN: false,
};
