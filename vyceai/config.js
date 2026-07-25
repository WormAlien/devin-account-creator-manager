// vyceai/config.js
//
// Конфиг для VyceAI провайдера.

module.exports = {
    // ── Базовый URL ─────────────────────────────────────────────
    BASE_URL: 'https://vyceai.com/v1',

    // ── Дашборд ─────────────────────────────────────────────────
    DASHBOARD_URL: 'https://vyceai.com/dashboard-v2',

    // ── Прокси ─────────────────────────────────────────────────
    PROXY_PORT: 20131,

    // ── Auth ────────────────────────────────────────────────────
    AUTH_HEADER: 'Authorization',
    AUTH_PREFIX: 'Bearer ',

    // ── Модели (14 шт., из /v1/models) ────────────────────────
    MODELS: [
        'auto',
        'claude-fable-5',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
        'mimo-v2.5-pro',
        'minimax-m3',
        'deepseek-v4-flash',
        'glm-5.2',
        'gemini-3.1-flash-lite',
        'gemini-3.6-flash',
        'gpt-5.6-sol',
        'nemotron-ultra-550b',
        'nemotron-vision',
    ],

    // ── Маппинг Claude моделей → VyceAI модели ────────────────
    MODEL_MAP: {
        'opus':  'claude-sonnet-5',      // claude-*opus* → claude-sonnet-5
        'sonnet': 'claude-sonnet-4-6',   // claude-*sonnet* → claude-sonnet-4-6
        'haiku':  'claude-haiku-4-5',    // claude-*haiku* → claude-haiku-4-5
    },

    // ── Лимиты ─────────────────────────────────────────────────
    MAX_TOKENS_LIMIT: 64000,
    MIN_TOKENS_LIMIT: 1024,
    REQUEST_TIMEOUT_MS: 600000,
};
