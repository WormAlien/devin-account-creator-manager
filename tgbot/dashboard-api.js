// tgbot/dashboard-api.js
//
// Тонкий HTTP-клиент к дашборду авторегера (:8200, routing/transparent-proxy.js).
// Бот НЕ дублирует логику переключения — он дёргает уже существующие эндпоинты
// /__switch/api/*. Активация ключа любого пула пишет *-active-key.txt + apiKeyHelper
// в settings.json (TTL=0 → claude едет на лету, без перезапуска).
//
// Все функции бросают при не-2xx, чтобы bot.js показал ошибку пользователю.

const BASE = (process.env.DASHBOARD_URL || 'http://localhost:8200').replace(/\/+$/, '');

async function req(method, path, body) {
  const url = `${BASE}/__switch/api${path}`;
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(url, opts);
  } catch (e) {
    throw new Error(`дашборд :8200 недоступен (${e.code || e.message}). Запущен ли restart-dashboard.bat?`);
  }
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// --- Статус / переключение пресетов --------------------------------------

// { current, backends: {name:{label,base_url}}, settings_file }
const status = () => req('GET', '/status');

// target ∈ ключи BACKENDS (omniroute | freemodel | notion). Пишет settings.json.
const switchBackend = (target) => req('POST', '/switch', { target });

// --- Активация ключа конкретного пула (это и есть «функционал apiKeyHelper») -

const freemodelSessions = () => req('GET', '/freemodel/sessions');
const freemodelActivate = (name) => req('POST', '/freemodel/activate', { name, mode: 'helper' });
const freemodelActiveKey = () => req('GET', '/freemodel/active-key');
// Форс-рефреш квоты одного FreeModel-аккаунта (запускает headless-Chrome → медленно).
const freemodelRefreshQuota = (name) => req('POST', '/session/refresh-quota', { name });

const alSessions = () => req('GET', '/al/sessions');
const alActivate = (api_key) => req('POST', '/al/activate', { api_key });

const evSessions = () => req('GET', '/ev/sessions');
const evActivate = (api_key) => req('POST', '/ev/activate', { api_key });

const omSessions = () => req('GET', '/om/sessions');
const omActivate = (api_key) => req('POST', '/om/activate', { api_key });

const otSessions = () => req('GET', '/ot/sessions');
const otActivate = (api_key) => req('POST', '/ot/activate', { api_key });

const conduitSessions = () => req('GET', '/conduit/sessions');
const conduitActivate = (name) => req('POST', '/conduit/activate', { name });
const conduitActiveKey = () => req('GET', '/conduit/active-key');
const conduitRefreshQuota = (name) => req('POST', '/conduit/refresh-quota', { name });

// --- Авто-ротация FreeModel (балансировщик наименее-использованного) -------

const autoStart = () => req('POST', '/freemodel/auto/start');
const autoStop = () => req('POST', '/freemodel/auto/stop');
const autoStatus = () => req('GET', '/freemodel/auto/status');

module.exports = {
  BASE,
  status, switchBackend,
  freemodelSessions, freemodelActivate, freemodelActiveKey, freemodelRefreshQuota,
  alSessions, alActivate,
  evSessions, evActivate,
  omSessions, omActivate,
  otSessions, otActivate,
  conduitSessions, conduitActivate, conduitActiveKey, conduitRefreshQuota,
  autoStart, autoStop, autoStatus,
};
