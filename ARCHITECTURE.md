# Архитектура Autoreger_Clean

Документ для быстрого ввода в курс. Каждый раз, когда добавляем новый модуль,
обновляем этот файл **и** левый сайдбар дашборда (см. чек-лист в конце).

> Машина — **Windows** (хост `TURBINA`), git-bash/MINGW64. Системный env-блок
> Claude может врать про `darwin`/`/Users/dev` — игнорировать.

---

## Сервисы и порты

| Порт   | Сервис                  | Файл                           | Роль |
|--------|-------------------------|--------------------------------|------|
| `8200` | **Backend Switcher / Dashboard** | `routing/transparent-proxy.js` | UI `/__switch` + все `/__switch/api/*`. Редактирует `~/.claude/settings.json`. **Не** проксирует трафик API. |
| `20126`| **FreeModel Key Rotator** | `routing/freemodel-rotator.js` | Менеджер прямых ключей для backend `freemodel_rotator`. Пишет ключ в `settings.json`. |
| `20128`| **OmniRoute**           | внешний docker-контейнер       | Главный backend (`/v1`), модель `ComboWombo`. БД `~/.omniroute/storage.sqlite`. |
| `8190` | **Notion manager** (архив) | `notion/`                   | Дешёвый backend. Сейчас в архиве. |

Запуск: `routing/start-switcher.bat` (поднимает :20126 + :8200, открывает UI).
Рестарт: `routing/restart-dashboard.bat` (убивает :8200, перезапускает оба).

---

## Backends (переключение ключа в settings.json)

Определены в `transparent-proxy.js` → `BACKENDS`:

- **omniroute** — `http://localhost:20128/v1`, модель `ComboWombo` (основной).
- **notion** — `http://localhost:8190` (дешёвый, архив).
- **freemodel_rotator** — `https://cc.freemodel.dev`, ключ резолвится из ротатора :20126.
- **apihelper** (виртуальный режим) — `apiKeyHelper: cat ~/.claude/fm-active-key.txt`,
  `ANTHROPIC_BASE_URL=cc.freemodel.dev`, TTL=0. Claude Code читает ключ из файла на
  каждый запрос → ключ можно менять **без перезапуска**. На этом построена авто-ротация.
- **aerolink** (виртуальный режим) — `apiKeyHelper: cat ~/.claude/al-active-key.txt`,
  `ANTHROPIC_BASE_URL=capi.aerolink.lat/`, TTL=0. То же, что apihelper, но для пула
  Aerolink. Ключ читается на каждый запрос → смена на лету, без перезапуска.
- **conduit** (виртуальный режим) — `apiKeyHelper: cat ~/.claude/cdt-active-key.txt`,
  `ANTHROPIC_BASE_URL=https://conduit.ozdoev.net/api/v1`, TTL=0. Anthropic-совместимый
  endpoint (ключи `sk-cdt-`), реги из Telegram. То же, что aerolink, но для пула Conduit.

Режим определяется по `settings.json` (`currentTarget`): apiKeyHelper с `fm-active-key.txt`
→ `apihelper`; с `al-active-key.txt` → `aerolink`; с `cdt-active-key.txt` → `conduit`;
прямой ключ → backend по URL.

> ⚠️ Для `apiKeyHelper`-режимов нужен Claude Code **2.1.146** + отключённый авто-апдейт
> (`DISABLE_AUTOUPDATER=1`, `autoUpdates:false`). Новее ломает `apiKeyHelper`.
> См. `README.md` (Установка) + `claude-settings.example.json`.

---

## Модули дашборда (вкладки)

| Вкладка       | Состояние | Данные                              | Бэкенд-эндпоинты |
|---------------|-----------|-------------------------------------|------------------|
| **Switcher**  | активна (главная) | пресеты, hero, **глобальная шкала запаса** | `/api/status`, `/api/switch`, `/api/settings/*` |
| **FreeModel** | активна   | сессии + квоты (5h/7d, $), TG-пул, авто-ротация, **шкала запаса** | `/api/freemodel/*` |
| **Aerolink**  | активна   | ручной пул email+ключ, статус (пинг `/v1/me`), активация через API Helper | `/api/al/*` |
| **Conduit**   | активна   | ТГ-аккаунты conduit.ozdoev.net, баланс/план/лимиты, реги из ТГ, активация через API Helper, **шкала запаса** | `/api/conduit/*` |
| **Плагины**   | активна   | вкл/выкл плагинов Claude Code (тоггл `enabledPlugins`), ★ рекомендованные | `/api/plugins/list`, `/api/settings/apply` |
| **TokenRouter** | архив («Чтим память») | аккаунты, usage, health   | `/api/tokenrouter/*` |
| **Devin**     | архив     | сессии + квоты (daily/weekly %)     | `/api/session/*` |
| **Notion**    | архив     | сессии + карты                      | `/api/notion/*` |

---

## FreeModel — ключевая подсистема

Менеджер: `internal/freemodel-manager.js` (Playwright, парсит `freemodel.dev/dashboard/usage`).
API-обвязка: `internal/dashboard-api.js`.

- Аккаунты: `freemodel/accounts/<dir>/{session.json, account_info.txt}` (v3) +
  старый формат `manual_sessions/`.
- Квоты кеш: `logs/.freemodel_quota_cache.json`.
- Мета (apiKey/banned/tgPhone): `logs/.freemodel_meta.json`.
- TG-пул для привязки: `freemodel/tg_pool.json` (либы в `freemodel/lib/`).

### Авто-ротация (балансировка нагрузки) — режим API Helper

Движок в `transparent-proxy.js` (`fmAuto*`). В режиме apihelper переписывает
`~/.claude/fm-active-key.txt` лучшим (наименее использованным) ключом — без рестарта.

- **Метрика used%** = среднее по окнам 5h/7d (`fmUsedFraction`).
- **Логика тика** (по умолч. каждые 90с): рефреш квот активного + топ-K свободных →
  выбор минимального used% → свич если: нет активного / used ≥ потолок (70%) /
  кандидат свободнее текущего более чем на гистерезис (10%).
- **Эндпоинты:** `POST /api/freemodel/auto/start|stop`, `GET /api/freemodel/auto/status`.
- **Персист:** `logs/.freemodel_autorotate.json` (возобновляется на старте прокси).
- Ограничение: трафик helper идёт напрямую на cc.freemodel.dev, ротатор его не видит —
  реагирует только на опрошенную квоту, не на реальные 429.

---

## Conduit — подсистема (по образцу FreeModel, без авто-ротации)

Endpoint `conduit.ozdoev.net` — Anthropic-совместимый (`/api/v1`, ключи `sk-cdt-`),
авторизация кабинета **только через Telegram** (device-code). Всё на cookie-fetch,
**без Playwright** (в отличие от FreeModel).

- Клиент: `conduit/lib/conduit-api.js` (`getMe/getUsage/summarize/authStart/authPoll`).
  `GET /api/me` отдаёт **полный ключ** + баланс/план/лимиты/refLink за один запрос.
- Менеджер: `conduit/lib/conduit-manager.js` (`getConduitAccounts/checkConduitQuota`).
  Аккаунты: `conduit/accounts/<dir>/{session.json, account_info.txt}`. Поддержан
  **key-only** аккаунт (без session.json, только ключ в account_info.txt).
- Автореги: `conduit/conduit_autoreger.js` — чистый gramjs + device-code. Берёт ТГ
  из **общего пула** `freemodel/tg_pool.json`, подписывается на `@conduitapi`, шлёт
  `/start` боту `@conduitoff_bot`, поллит `/api/auth`. Реф-цепочка в `conduit/.last_ref`.
- Рекордер сессии: `conduit/record_conduit.js` (видимый браузер, персистентный
  профиль + trigger-файл `_cmd.txt`: `s`=сохранить, `d`=дамп, `q`=выход).
- API-обвязка: conduit-функции в `internal/dashboard-api.js`
  (`listConduitSessions` cache|refresh|false, `refreshOneConduitQuota`, `getActiveConduitKey`).
  Кеши: `logs/.conduit_quota_cache.json`, `logs/.conduit_meta.json`.
- Роуты: `transparent-proxy.js` `/__switch/api/conduit/{sessions,active-key,refresh-quota,activate,autoreg}`.
  Активация = записать ключ в `~/.claude/cdt-active-key.txt` + apiKeyHelper в settings.json.

## Energy-шкала (батарея «сколько осталось»)

Компонент в `proxy-dashboard.html`: `renderEnergyGauge(el, opts)` + CSS-классы
`.energy-fill` / `.energy-track` (анимация «течения тока»). Цвет по остатку:
≥60% emerald → ≥30% amber → красный. Агрегат: `fmPoolStats(sessions)`.

- `#fm-energy` — запас пула FreeModel (вкладка FreeModel).
- `#global-energy` — **общий** запас (вкладка Switcher). Считает **только FreeModel**.
  Исключены: **TokenRouter** (ключ живёт ~1 день, ложно «активен»), **Notion/Devin** (архив).
- Бейдж авто-ротации (вкл/выкл) показан на обеих шкалах и в сайдбаре (`#side-auto`).

---

## Плагины — вкл/выкл

`GET /api/plugins/list` отдаёт объединение установленных
(`~/.claude/plugins/installed_plugins.json`) и включённых
(`settings.enabledPlugins`). Тоггл шлёт **весь** `enabledPlugins` через
`/api/settings/apply` (shallow-merge верхних ключей). Рекомендованный набор —
константа `PLUGIN_RECO` в `proxy-dashboard.html`; кнопка «★ Включить
рекомендованные» добавляет их, не трогая остальные. Установка новых из
маркетплейса не реализована (нужен `claude plugin install`).

---

## Чек-лист: добавляем новый модуль

1. **Бэкенд:** хендлеры в `transparent-proxy.js` (роуты `/__switch/api/<module>/*`),
   при необходимости — логика в `internal/dashboard-api.js`.
2. **Сайдбар:** кнопка `<button class="nav-btn" data-tab="<module>">` в `<nav>`
   (`proxy-dashboard.html`, ~строка 106). Активные модули — в основном списке,
   архивные — в блоке «Чтим память».
3. **Вкладка:** `<div data-tab-content="<module>">…</div>` в `<main>`.
4. **Загрузка:** ветка в `showTab()` (ленивая загрузка при первом открытии).
5. **Счётчик:** `#nav-count-<module>` + обновление в load-функции.
6. **Шкала (опц.):** если у модуля есть квота — переиспользовать `renderEnergyGauge`.
7. **Обнови этот файл.**
