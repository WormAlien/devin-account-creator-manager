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
| —      | **Telegram-пульт**      | `tgbot/bot.js`                 | Не слушает порт. Long-poll к Telegram. Управляет дашбордом :8200 по HTTP + живая claude-сессия. |

Запуск: `routing/start-switcher.bat` (поднимает :20126 + :8200, открывает UI).
Рестарт: `routing/restart-dashboard.bat` (убивает :8200, перезапускает оба).
ТГ-бот: `npm run tgbot` (нужен `tgbot/.env`, см. `tgbot/README.md`).

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
- **evomap** (виртуальный режим) — `apiKeyHelper: cat ~/.claude/ev-active-key.txt`,
  `ANTHROPIC_BASE_URL=api.evomap.ai/v1`, TTL=0. То же, что apihelper, но для пула
  Evomap. Ключ читается на каждый запрос → смена на лету, без перезапуска.
- **ourtoken** (виртуальный режим) — `apiKeyHelper: cat ~/.claude/ot-active-key.txt`,
  `ANTHROPIC_BASE_URL=api.ourtoken.ai/v1`, TTL=0. То же, что apihelper, но для пула
  Ourtoken. Ключ читается на каждый запрос → смена на лету, без перезапуска.
- **conduit** (виртуальный режим) — `apiKeyHelper: cat ~/.claude/cdt-active-key.txt`,
  `ANTHROPIC_BASE_URL=https://conduit.ozdoev.net/api/v1`, TTL=0. Anthropic-совместимый
  endpoint (ключи `sk-cdt-`), реги из Telegram. То же, что aerolink, но для пула Conduit.

Режим определяется по `settings.json` (`currentTarget`): apiKeyHelper с `fm-active-key.txt`
→ `apihelper`; с `al-active-key.txt` → `aerolink`; с `ev-active-key.txt` → `evomap`; с `ot-active-key.txt` → `ourtoken`; с `cdt-active-key.txt` → `conduit`;
прямой ключ → backend по URL.

> ⚠️ Для `apiKeyHelper`-режимов нужен Claude Code **2.1.179** + отключённый авто-апдейт
> (`DISABLE_AUTOUPDATER=1`, `autoUpdates:false`). Новее ломает `apiKeyHelper`.
> См. `README.md` (Установка) + `claude-settings.example.json`.

---

## Модули дашборда (вкладки)

| Вкладка       | Состояние | Данные                              | Бэкенд-эндпоинты |
|---------------|-----------|-------------------------------------|------------------|
| **Switcher**  | активна (главная) | пресеты, hero, **глобальная шкала запаса** | `/api/status`, `/api/switch`, `/api/settings/*` |
| **FreeModel** | активна   | сессии + квоты (5h/7d, $), TG-пул, авто-ротация, **шкала запаса** | `/api/freemodel/*` |
| **Aerolink**  | активна   | ручной пул email+ключ, статус (пинг `/v1/me`), активация через API Helper | `/api/al/*` |
| **Evomap**    | активна   | ручной пул email+ключ (evomap.ai), статус (пинг `/v1/models`), активация через API Helper | `/api/ev/*` |
| **Ourtoken**  | активна   | ручной пул email+ключ (ourtoken.ai), статус (пинг `/v1/models`), активация через API Helper | `/api/ot/*` |
| **Conduit**   | активна   | ТГ-аккаунты conduit.ozdoev.net, баланс/план/лимиты, реги из ТГ, активация через API Helper, **шкала запаса** | `/api/conduit/*` |
| **Video API** | активна   | хранилище ключей видео-провайдеров (CRUD), триал-каталог | `/api/video/*` |
| **Картинки API** | активна | менеджер аккаунтов картинко-провайдеров (NanoBanana/fal/Replicate/Imagen…), email-метка + ключ, триал-каталог | `/api/image/*` |
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
  **Пул общий** с Conduit (один ТГ можно регать на оба сервиса) — см. секцию Conduit.

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
  `/start` боту `@conduitoff_bot`, поллит `/api/auth`. Авто-перебор ТГ при бане.
  **Реф-цепочка ПАРАМИ 2+2:** пары изолированы (первый в паре — чистый без рефа,
  второй — по рефу первого; следующая пара заново) → бан одной пары не тянет всю
  цепочку. Без персиста (`.last_ref` нет).
- **Кросс-сервис:** один ТГ можно регать и на FreeModel, и на Conduit. Conduit ведёт
  свой `conduit/.tg_used.json` (`pickTg`/`markTgUsed`), общий `tgPool.status` (это
  маркер FreeModel) **не трогает**. `banned` — единственный глобальный статус.
- Рекордер сессии: `conduit/record_conduit.js` (видимый браузер, персистентный
  профиль + trigger-файл `_cmd.txt`: `s`=сохранить, `d`=дамп, `q`=выход).
- API-обвязка: conduit-функции в `internal/dashboard-api.js`
  (`listConduitSessions` cache|refresh|false, `refreshOneConduitQuota`,
  `getActiveConduitKey`, ветка `conduit` в `openSessionInBrowser`).
  Кеши: `logs/.conduit_quota_cache.json`, `logs/.conduit_meta.json`.
- Роуты: `transparent-proxy.js` `/__switch/api/conduit/{sessions,active-key,refresh-quota,activate,autoreg}`.
  Активация = записать ключ в `~/.claude/cdt-active-key.txt` + apiKeyHelper в settings.json.
- **Колонка «Сервисы» в ТГ-дашборде** (`tgServicesMap()` → `/api/tg/list` поле
  `services={freemodel?,conduit?}`): сводит из существующих источников без отдельного
  кэша. FreeModel = непустой `usedBy` в пуле ИЛИ `tgPhone` в `.freemodel_meta.json`;
  Conduit = phone в `.tg_used.json`. Бейджи 🆓 FM / 🚇 CDT (один ТГ может иметь оба).
- **Вкладка Conduit** (🚇): активация ключа, показ/копирование ключа (👁/📋),
  открыть в браузере (🌐, только для аккаунтов с session.json), пресет «Conduit ·
  API Helper» на главной. ТГ-пул — **зеркало** блока из FreeModel (общий пул:
  `renderTgPool` рисует во все `.tg-list`/`.tg-stats`).

## Energy-шкала (батарея «сколько осталось»)

Компонент в `proxy-dashboard.html`: `renderEnergyGauge(el, opts)` + CSS-классы
`.energy-fill` / `.energy-track` (анимация «течения тока»). Цвет по остатку:
≥60% emerald → ≥30% amber → красный. Агрегат: `fmPoolStats(sessions)`.

- `#fm-energy` — запас пула FreeModel (вкладка FreeModel).
- `#conduit-energy` — запас пула Conduit (вкладка Conduit). `usedFraction` = израсходовано
  от триал-кредита $500; ULTIMATE (безлимит) → 0 (полный бак).
- `#global-energy` — **общий** запас (вкладка Switcher). Считает **только FreeModel**.
  Исключены: **TokenRouter** (ключ живёт ~1 день, ложно «активен»), **Notion/Devin** (архив).
- Бейдж авто-ротации (вкл/выкл) показан на обеих шкалах и в сайдбаре (`#side-auto`).

---

## Video / Картинки API — хранилища ключей провайдеров

Два **близнецовых** модуля, чистый CRUD-стор ключей (никакой активации в
`settings.json` — ключи под будущие обёртки/пайплайны генерации).

- **Video API** (🎬): `routing/video-keys.json`, роуты `/api/video/{keys,add,delete,trials,trial-status}`,
  бэкенд `vidLoad/vidSave/handleVideo*` в `transparent-proxy.js`.
- **Картинки API** (🖼): `routing/image-keys.json`, роуты `/api/image/{keys,add,delete,trials,trial-status}`,
  бэкенд `imgLoad/imgSave/handleImage*`. Провайдеры: NanoBanana (nanobananaapi.ai),
  Kie.ai, Gemini/Imagen, fal, Replicate, Leonardo, Ideogram, FLUX, Recraft, other.

Каждый: фильтр-табы по провайдеру, add-форма (провайдер + email-метка + api_key +
заметка), маска ключа с 👁 показать / 📋 копировать, триал-каталог (seed-список
зашит в код, пользовательские статусы working/dead в `*-trials.json`, gitignored).
Реальные `*-keys.json` / `*-trials.json` — gitignored; закоммичены `*-keys.example.json`.

## Плагины — вкл/выкл

`GET /api/plugins/list` отдаёт объединение установленных
(`~/.claude/plugins/installed_plugins.json`) и включённых
(`settings.enabledPlugins`). Тоггл шлёт **весь** `enabledPlugins` через
`/api/settings/apply` (shallow-merge верхних ключей). Рекомендованный набор —
константа `PLUGIN_RECO` в `proxy-dashboard.html`; кнопка «★ Включить
рекомендованные» добавляет их, не трогая остальные. Установка новых из
маркетплейса не реализована (нужен `claude plugin install`).

---

## Telegram-пульт (`tgbot/`)

Удалёнка с телефона: переключать бэкенды/ключи как на дашборде + клодкодить.
Тонкий слой — логику ротации НЕ дублирует, дёргает `:8200` по HTTP.

- `tgbot/bot.js` — telegraf, long-poll. **Whitelist** по `ALLOWED_USERS` (Telegram ID)
  обязателен: бот выполняет произвольный код. Команды: `/status`, `/backends`
  (inline-кнопки свича), `/cd`, `/pwd`, `/new`, `/stop`; свободный текст → claude.
- `tgbot/dashboard-api.js` — fetch-обёртки к `/__switch/api/{status,switch,
  freemodel/*,al/*,conduit/*,freemodel/auto/*}`. Кнопки пула активируют «лучший»
  ключ (fm — через авто-ротатор, al/cdt — первый из `*/sessions`).
- `tgbot/claude-session.js` — headless `claude -p <текст> --output-format json
  --dangerously-skip-permissions [--continue]` в выбранном cwd. Контекст между
  сообщениями держит сам claude через `--continue`; `--output-format json` даёт
  чистый `{result, total_cost_usd, is_error}` без TUI-мусора (поэтому node-pty НЕ
  нужен). cwd ограничен `ALLOWED_ROOTS` (Autoreger_Clean + D:\WORMALIENAIGIGANT).
- **apiKeyHelper-связь:** бот не трогает ключи — `claude` сам читает активный
  `*-active-key.txt` из settings.json на каждый запрос (TTL=0). Свич бэкенда в ТГ
  → следующий запрос claude едет на новом ключе без перезапуска.
- Секрет `tgbot/.env` (BOT_TOKEN, ALLOWED_USERS) — gitignored. Шаблон `.env.example`
  закоммичен. Запуск: `npm run tgbot`.

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
