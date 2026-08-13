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
| `20130`| **FreeModel OpenAI Proxy** | `routing/freemodel-openai-proxy.js` | Anthropic→OpenAI конвертер (аналог claude-code-proxy): `/v1/messages` → `api.freemodel.dev/v1/chat/completions` (gpt-5.5, gpt-5.6-*, codex). Ключ из `fm-active-key.txt`. Маппинг моделей — `routing/fm-openai-config.json`. |
| `20131`| **VyceAI OpenAI Proxy** | `routing/vyceai-openai-proxy.js` | Anthropic→OpenAI конвертер: `/v1/messages` → `vyceai.com/v1/chat/completions`. Ключ из `vyceai/keys.txt`. Маппинг моделей — `vyceai/config.js` (opus→claude-sonnet-5, sonnet→claude-sonnet-4-6, haiku→claude-haiku-4-5). |
| `20150-20250`| **Custom OpenAI Proxies** (динамически) | `routing/custom-openai-proxy.js` | Anthropic→OpenAI конвертер для Custom-провайдеров с заполненным `modelMap`. Спавнится на активацию (детached), конфиг `~/.claude/custom-<id>-proxy.json`, ключ из `~/.claude/custom-active-key.txt`. Убивается при деактивации/удалении. |
| `20132`| **AgentRouter Proxy** | `routing/agentrouter-proxy.js` | Фронтенд для agentrouter.org: `claude-*` → pass-through в `/v1/messages`, `gpt-*` → конвертер Anthropic→OpenAI `/v1/chat/completions` **с Cyrillic-bypass** (обход WAF «sensitive words detected»). Ключ из `~/.claude/ar-active-key.txt`, CC-заголовки от клиента. Спавнится автоматически при выборе gpt-модели. |
| `20128`| **OmniRoute**           | внешний docker-контейнер       | Главный backend (`/v1`), модель `ComboWombo`. БД `~/.omniroute/storage.sqlite`. |
| `8190` | **Notion manager** (архив) | `notion/`                   | Дешёвый backend. Сейчас в архиве. |
| —      | **Telegram-пульт**      | `tgbot/bot.js`                 | Не слушает порт. Long-poll к Telegram. Управляет дашбордом :8200 по HTTP + живая claude-сессия. |

Запуск: `routing/start-switcher.bat` (поднимает :20126 + :20130 + :8200, открывает UI).
Рестарт: `routing/restart-dashboard.bat` (убивает все три, перезапускает).
ТГ-бот: `npm run tgbot` (нужен `tgbot/.env`, см. `tgbot/README.md`).

---

## Backends (переключение ключа в settings.json)

Определены в `transparent-proxy.js` → `BACKENDS`:

- **omniroute** — `http://localhost:20128/v1`, модель `ComboWombo` (основной).
- **notion** — `http://localhost:8190` (дешёвый, архив).
- **freemodel_rotator** — `https://cc.freemodel.dev`, ключ резолвится из ротатора :20126.
- **fm_openai** — `http://localhost:20130` (freemodel-openai-proxy.js). Claude Code шлёт
  Anthropic-формат, прокси конвертит в OpenAI chat/completions на `api.freemodel.dev/v1`
  (там живут gpt-модели; `cc.freemodel.dev` — только claude). Ключ прокси читает сам из
  `fm-active-key.txt` (в settings.json пишется `dummy`). Маппинг claude-*→gpt-* правится
  в `routing/fm-openai-config.json` без рестарта (перечитывается по mtime).
- **vyce_openai** — `http://localhost:20131` (vyceai-openai-proxy.js). Claude Code шлёт
  Anthropic-формат, прокси конвертит в OpenAI chat/completions на `vyceai.com/v1`.
  Ключ прокси читает из `vyceai/keys.txt` (в settings.json пишется `dummy`).
  Маппинг claude-*→vyce-модели правится в `vyceai/config.js` без рестарта.
- **apihelper** (виртуальный режим) — `apiKeyHelper` читает `~/.claude/fm-active-key.txt`,
  `ANTHROPIC_BASE_URL=cc.freemodel.dev`, TTL=0. Claude Code читает ключ из файла на
  каждый запрос → ключ можно менять **без перезапуска**. На этом построена авто-ротация.
- **aerolink** (виртуальный режим) — `apiKeyHelper` читает `~/.claude/al-active-key.txt`,
  `ANTHROPIC_BASE_URL=capi.aerolink.lat/`, TTL=0. То же, что apihelper, но для пула
  Aerolink. Ключ читается на каждый запрос → смена на лету, без перезапуска.
- **evomap** (виртуальный режим) — `apiKeyHelper` читает `~/.claude/ev-active-key.txt`,
  `ANTHROPIC_BASE_URL=api.evomap.ai/v1`, TTL=0. То же, что apihelper, но для пула
  Evomap. Ключ читается на каждый запрос → смена на лету, без перезапуска.
- **ourtoken** (виртуальный режим) — `apiKeyHelper` читает `~/.claude/ot-active-key.txt`,
  `ANTHROPIC_BASE_URL=api.ourtoken.ai/v1`, TTL=0. То же, что apihelper, но для пула
  Ourtoken. Ключ читается на каждый запрос → смена на лету, без перезапуска.
- **conduit** (виртуальный режим) — `apiKeyHelper` читает `~/.claude/cdt-active-key.txt`,
  `ANTHROPIC_BASE_URL=https://conduit.ozdoev.net/v1`, TTL=0. Anthropic-совместимый
  endpoint (ключи `sk-cdt-`), реги из Telegram. То же, что aerolink, но для пула Conduit.
- **svrtr** (виртуальный режим) — `apiKeyHelper` читает `~/.claude/sr-active-key.txt`,
  `ANTHROPIC_BASE_URL=https://api.svrtr.org`, TTL=0. Anthropic-совместимый endpoint
  (ключи `sk-sr-v1-`), авторег через @svrtrbot (одна кнопка Login Start в боте).
  Файлы: `svrtr/lib/svrtr-api.js`, `svrtr/svrtr_autoreger.js`.
- **agentrouter** (прямой режим) — `ANTHROPIC_BASE_URL=https://agentrouter.org` (БЕЗ `/v1`),
  ключ пишется **литералом** в `ANTHROPIC_AUTH_TOKEN` (не apiKeyHelper — WAF agentrouter
  не пускает helper-путь). `apiKeyHelper` удаляется, модель из `~/.claude/ar-active-model.txt`.
  Роутинг моделей: `claude-*` → `agentrouter.org` напрямую, `gpt-*` → локальный прокси
  `http://localhost:20132` (нужна конвертация в OpenAI). Пул: `routing/agentrouter-sessions.json`.
- **helpcoder** (виртуальный режим) — `apiKeyHelper` читает `~/.claude/hc-active-key.txt`,
  `ANTHROPIC_BASE_URL=https://helpcoder.cc`, TTL=0. OpenAI-совместимый New-API инстанс
  (ключи `sk-`), понимает и Anthropic-формат `/v1/messages`. Все модели `gpt-*`
  (11 шт: gpt-5 … gpt-5.4, codex). WAF нет — Cyrillic-bypass не нужен. Авторег чистым
  HTTP: `helpcoder/helpcoder_autoreg.js` (новый акк = $200 виртуальных кредитов).
  Аккаунты: `helpcoder/accounts/<dir>/`. Файлы: `helpcoder/lib/helpcoder-api.js`,
  `helpcoder/lib/helpcoder-manager.js`.

**⚠ Формат apiKeyHelper — только node-вариант** (`keyHelperCmd()` в transparent-proxy.js):
`node -e "...readFileSync(os.homedir()+'/.claude/<xx>-active-key.txt'...).trim()"`.
НЕ `cat ~/...`: CC запускает helper через системный шелл, где cat может отсутствовать
в PATH (дефолтная установка Git for Windows), `~` не резолвится без HOME, кириллица в
имени юзера ломает путь. Симптом — бесконечные ретраи по таймауту (НЕ auth-ошибка):
cat без файла виснет на stdin. Выяснено на чистой установке 2026-07-19.

Режим определяется по `settings.json` (`currentTarget`): apiKeyHelper с `fm-active-key.txt`
→ `apihelper`; с `al-active-key.txt` → `aerolink`; с `ev-active-key.txt` → `evomap`; с `ot-active-key.txt` → `ourtoken`; с `cdt-active-key.txt` → `conduit`; с `hc-active-key.txt` → `helpcoder`;
прямой ключ → backend по URL (base agentrouter.org → `agentrouter`).

> ⚠️ Для `apiKeyHelper`-режимов нужен Claude Code **2.1.153** + отключённый авто-апдейт
> (`DISABLE_AUTOUPDATER=1`, `autoUpdates:false`). Новее ломает `apiKeyHelper`.
> См. `README.md` (Установка) + `claude-settings.example.json`.

---

## Модули дашборда (вкладки)

| Вкладка       | Состояние | Данные                              | Бэкенд-эндпоинты |
|---------------|-----------|-------------------------------------|------------------|
| **Switcher**  | активна (главная) | пресеты, hero, **глобальная шкала запаса** | `/api/status`, `/api/switch`, `/api/settings/*` |
| **FreeModel** | активна   | сессии + квоты (5h/7d, $), TG-пул, авто-ротация, **шкала запаса** | `/api/freemodel/*` |
| **VyceAI**    | активна   | статус прокси, список моделей | `/__vyceai/api/status`, `/v1/models` |
| **Aerolink**  | активна   | ручной пул email+ключ, статус (пинг `/v1/me`), активация через API Helper | `/api/al/*` |
| **Evomap**    | активна   | ручной пул email+ключ (evomap.ai), статус (пинг `/v1/models`), активация через API Helper | `/api/ev/*` |
| **Ourtoken**  | активна   | ручной пул email+ключ (ourtoken.ai), статус (пинг `/v1/models`), активация через API Helper | `/api/ot/*` |
| **Custom**    | активна   | произвольные провайдеры: имя + baseUrl + пул ключей (`routing/custom-providers.json`), пинг/модели по `{baseUrl}/models`, активация через API Helper (`~/.claude/custom-active-key.txt`). Если задан `modelMap` (opus/sonnet/haiku) — активация поднимает Anthropic→OpenAI конвертер (`custom-openai-proxy.js`) и направляет CC на `localhost:<port>` | `/api/custom/*` |
| **Conduit**   | активна   | ТГ-аккаунты conduit.ozdoev.net, баланс/план/лимиты, реги из ТГ, активация через API Helper, **шкала запаса** | `/api/conduit/*` |
| **Svrtr**     | активна   | ТГ-аккаунты svrtr.org (api.svrtr.org), кредиты, реги через @svrtrbot, активация через API Helper | `/api/svrtr/*` |
| **AgentRouter** | активна | ручной пул ключей agentrouter.org, пинг `/v1/models` с CC-заголовками (live/dead), **баланс ключа** (выдача − потрачено, кеш в sessions.json), **🌐 ЛК** (open-session.js для чек-ина +$25), выбор модели → `ar-active-model.txt` + `settings.model`; claude-* напрямую, gpt-* через прокси :20132 | `/api/ar/{sessions,ping,balance,set-grant,session/open,add,delete,models,activate,set-model}` |
| **HelpCoder** | активна   | аккаунты helpcoder.cc (New-API, OpenAI-совместимый), квоты через cookie-`/api/user/self`, авторег username+password (без email/капчи), активация через API Helper | `/api/helpcoder/{sessions,active-key,refresh-quota,activate,add,autoreg,models}` |
| **Video API** | активна   | хранилище ключей видео-провайдеров (CRUD), триал-каталог | `/api/video/*` |
| **Картинки API** | активна | менеджер аккаунтов картинко-провайдеров (NanoBanana/fal/Replicate/Imagen…), email-метка + ключ, триал-каталог | `/api/image/*` |
| **Плагины / MCP** | активна | слева плагины Claude Code (тоггл `enabledPlugins`, ★ рекомендованные), справа MCP-серверы из `~/.claude.json` | `/api/plugins/list`, `/api/settings/apply`, `/api/mcp/list`, `/api/mcp/toggle` |
| **Настройки** | активна   | обновление дашборда, OmniRoute env, JSON-редактор `settings.json` + бэкапы, **тоггл статус-бара CC** и **автокомпакта** | `/api/settings/*`, `/api/env`, `/api/statusline/default`, `/api/dashboard/update-*` |
| **TokenRouter** | архив («Чтим память») | аккаунты, usage, health   | `/api/tokenrouter/*` |
| **Devin**     | архив     | сессии + квоты (daily/weekly %)     | `/api/session/*` |
| **Notion**    | архив     | сессии + карты                      | `/api/notion/*` |

---

## FreeModel — ключевая подсистема

Менеджер: `internal/freemodel-manager.js` (Playwright, парсит `freemodel.dev/dashboard/usage`).
API-обвязка: `internal/dashboard-api.js`.

- Аккаунты: `freemodel/accounts/<dir>/{session.json, account_info.txt}` (v3) +
  старый формат `manual_sessions/`.
- Ручное добавление: `POST /api/freemodel/add-manual` (имя + API-ключ) — создаёт
  `freemodel/accounts/manual_<ts>_ok_<имя>/` со stub `session.json` (`Backend: manual`),
  TG сразу помечается `tgPhone='manual'`. Квоты не парсятся (нет браузерной сессии),
  refresh такие аккаунты пропускает; ключ участвует в активации и авто-ротации как обычный.
- Квоты кеш: `logs/.freemodel_quota_cache.json`.
- Мета (apiKey/banned/cooldownUntil/tgPhone): `logs/.freemodel_meta.json`.

### Состояние аккаунта: `ok` / `cooldown` / `dead`

Считается в `fmClassify()` (`internal/freemodel-manager.js`), кладётся в квоту полями
`state`, `coolReason`, `cooldownUntil` (+ машиночитаемые `h5resetAt`, `d7resetAt`,
`money`, `planId`, `subActive`).

**Главное, что надо знать про `available`:** при активном 5h-окне это НЕ деньги, а
остаток окна — `availCents = min(money + headroom, headroom)`, а так как `money ≥ 0`,
получается ровно `headroom`. Поэтому `"$0.00"` у аккаунта с окном означает
«окно выжрано, нальётся в `resetsAt`», а не «аккаунт мёртв».

| state | когда | что делаем |
|---|---|---|
| `ok` | есть headroom окна, либо окон нет но кошелёк не пуст | обычный кандидат ротации |
| `cooldown` | окно 5h или 7d выбрано целиком | пропускаем в ротации, **не** баним, показываем ⏳ и обратный отсчёт |
| `dead` | окон нет (подписка не `active`) **и** денег нет | помечаем 🪫 **исчерпан** (`bannedReason:'exhausted'`) — см. ниже про сроки |
| нет поля | старый кеш или скрап без окон | не трогаем вообще |

Скрап (`scrapeFreemodelQuota`) `dead` не ставит никогда: со страницы не видно
кошелёк отдельно от headroom. Дефолт — «сомневаешься, не хорони».

**Когда именно помечаем 🪫 исчерпан.** Решает поле `src` в квоте:
- `src:'api'` **и** `subActive === false` → сразу. В `/api/billing` прямо видно
  `subscription.status: canceled` и `creditCents: 0` — гадать не о чем.
- всё остальное (скрап; либо подписка активна, но лимитов в `plans[]` не нашли) →
  только со **2-го подтверждения ≥6ч спустя** (`deadStrikes` / `deadSince`).

**🪫 ≠ 💀.** Исчерпанный аккаунт не забанен: он целый, просто на нём кончились
кредиты. Флаг в мете общий (`banned`, по нему работают фильтры и ротатор), но
различает их `autoBanned` + `bannedReason`, и UI показывает их раздельно —
`🪫 исчерпан` (amber) против `💀` (crimson), и в счётчиках пула тоже отдельно.
Ручной 💀 (`banned` без `autoBanned`) вечен; 🪫 снимается сам, как только рефреш
увидел живое окно или деньги.
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
- **Перезарядка:** кандидаты с `cooling` пропускаются. Если остывает весь пул — тик
  не хоронит никого, а логирует ближайший `cooldownUntil` и спит до него
  (`fmAutoWakeAt`/`fmNextDelay`, потолок 15 мин, чтобы ручной рефреш подхватился).
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

---

## AgentRouter (ar) — WAF, Cyrillic-bypass, gpt через прокси

Пул в `routing/agentrouter-sessions.json` (`[{email, name, api_key, active, status}]`),
клик по ключу = активный. **Особенность agentrouter.org — WAF**, который пускает только
«настоящие» запросы Claude Code:

- Все probe/models обязаны нести CC-заголовки (`AR_CC_HEADERS`: `user-agent claude-cli/…`,
  `anthropic-version/beta`, `x-app: cli`) + `Authorization: Bearer <ключ>`. Без них — 401.
  Внутри самого Claude Code заголовки шлёт клиент, прокси их прокидывает как есть.
- **apiKeyHelper-путь WAF не пускает** — при активации `apiKeyHelper` удаляется,
  ключ пишется литералом в `ANTHROPIC_AUTH_TOKEN` (как в конфиге, который работает
  «как у друга»). `ANTHROPIC_API_KEY` чистится.
- **Маршрутизация моделей** (`arTargetFor`): `claude-*` → `agentrouter.org` напрямую
  (pass-through, работает как есть); `gpt-*` → локальный прокси `:20132`, т.к. gpt-модели
  у agentrouter живут на OpenAI-эндпоинте и нужна конвертация Anthropic→OpenAI.

### WAF «sensitive words detected» и Cyrillic-bypass

На OpenAI-эндпоинте WAF agentrouter **сканирует контент запроса** и режет его
ответом `500 sensitive words detected` (полное CC-тело: большой system + 91 тул —
падало всегда; минимальные запросы проходили). Обход (механика из lolz.team,
подтверждена на полном CC-запросе → 200):

- **В кодирование:** все английские `c` в *тексте* промпта (system, содержимое
  сообщений, tool-дескрипшены, tool_result) заменяются на кириллическую `с`
  (U+0441, визуально идентична) → сигнатуры WAF не матчатся.
- **Наружу не влияет:** имена тулзов, аргументы, JSON-структура и ключи полей
  НЕ трогаются (иначе сломается парсинг).
- **В декодирование:** на ответе `с`→`c` обратно в `delta.content`, имени тулза
  и `partial_json` аргументах — код приходит синтаксически корректным.

Реализовано в `routing/agentrouter-proxy.js` (`cyrEncode`/`cyrDecode`), только на
OpenAI-пути; claude pass-through bypass не использует (там WAF не триггерится).

### Статус прокси

- Спавн: `arProxySpawn()` — проверяет свободу `:20132`, поднимает
  `agentrouter-proxy.js` detached (stdio: ignore). Уже запущен → `{already:true}`.
- Статус/статистика: `GET http://localhost:20132/__agentrouter/api/status`
  (`stats: requests/streamed/errors/lastModel`). Логи в консоли процесса
  (при ручном запуске — в `%TEMP%\arpx_foreground*.log`).
- В `start-switcher.bat` / `restart-dashboard.bat` порт `:20132` в списке KILLPORT.

### Баланс ключа (продажа на FunPay)

Сервис **не отдаёт остаток** по ключу — только потраченное. Считаем `balance = grant − spent`:

- `spent` = `GET /dashboard/billing/usage?start_date=…&end_date=…` (400 дней назад → сегодня),
  поле `total_usage` **в центах** → делим на 100. CC-заголовки + `Bearer` (WAF), таймаут 15с.
- `grant` (изначальная выдача) — у разных аккаунтов разная (125 / 175 / личный больше):
  либо **задана вручную** (`grantManual` в сессии, роут `set-grant`), либо угадывается
  `max(175, ceil(spent/25)*25)`. `hard_limit_usd` (= sentinel 100M у безлимитных) **НЕ баланс**.
- Результат кешируется прямо в `agentrouter-sessions.json` (`spent/grant/balance/grantSource/
  balanceCheckedAt`) — переживает F5 и рестарт. `arBalance()` / `arApplyBalance()`.
- UI: колонка «Баланс» (цвет по доле остатка: >30% emerald, 10–30% amber, <10% crimson),
  Кнопка «✏️ из $175» под суммой = задать изначальную выдачу вручную (голубая = вписана
  руками, серая = дашборд угадал), «💳 Балансы всех» = пакетный прогон (чанки по 3).

### Кнопка «🌐 ЛК» (вход в сессию для чек-ина +$25)

- `POST /api/ar/session/open {api_key}` → `handleArSessionOpen`: спавнит
  `agentrouter/open-session.js <label>` (label = sanitized name/email) detached + `unref()`,
  видимый Chromium под сохранённой GitHub-сессией. Первый раз сессии нет → ждёт ручного
  GitHub-логина, автосохраняет в `agentrouter/sessions/<label>.json`; дальше — с ней.
- Dedup: `arLkPids` (label → pid), повторный клик при живом pid → `{already:true}`, второй
  браузер не плодится. **Только `open-session.js`** (не `login_and_save_session.js` — тот ждёт Enter).

---

## HelpCoder (hc) — New-API, авторег чистым HTTP

`helpcoder.cc` — **New-API инстанс, OpenAI-совместимый** (`/v1/chat/completions`,
Bearer `sk-…`), при этом понимает и Anthropic-формат `/v1/messages` (ответил
`503 model_not_found` на несуществующую модель → запрос прошёл). **WAF нет** —
полное CC-тело (53KB, 91 тул) доходит до сервера, Cyrillic-bypass не нужен.

- Модели (11): `gpt-5`, `gpt-5-codex`, `gpt-5-codex-mini`, `gpt-5.1`, `gpt-5.1-codex`,
  `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`,
  `gpt-5.4`.
- **Активация** — как остальные API Helper пулы: `~/.claude/hc-active-key.txt` +
  `apiKeyHelper` + `ANTHROPIC_BASE_URL=https://helpcoder.cc`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=0`.
- **Авторег** `helpcoder/helpcoder_autoreg.js [N]`: чистый HTTP без email/капчи —
  `POST /api/user/register?turnstile=` (пустой turnstile → новый акк), сессия cookie,
  `GET /api/user/self`, `POST /api/token/<id>/key` → ключ `sk-`. Новый акк = **$200**
  виртуальных кредитов (`quota 100 000 000`, `USD = quota / 500000`). Аккаунты —
  `helpcoder/accounts/<idx>_<ts>_ok_<username>/{session.json, account_info.txt}`.
- **Квоты** — cookie-fetch `GET /api/user/self` (`Cookie: session` + заголовок
  `New-Api-User: <id>`); 401/403 = мёртвый аккаунт. Кеш `logs/.helpcoder_quota_cache.json`.
- **Статус на 2026-08-12:** endpoint отвечает (`/v1/models` 200), но реальные вызовы
  моделей на всех аккаунтах дают `503 Service temporarily unavailable` / таймаут —
  upstream-каналы лежат/перегружены.

---

## Статуслайн Claude Code (`routing/statusline-autoreger.sh`)

Скрипт-строка снизу CLI: `[transport] provider/model │ $ ▰▰▰▰▱▱ 60% $9.26 │ ⧉ ▰▱▱▱▱ 11% 110k/1M`.
Лежит **в репо** (обновления приезжают с `git pull`), `install.sh` (шаг 3)
прописывает его в `~/.claude/settings.json` → `statusLine.command`.
`ROOT` определяет сам по своему расположению (`<repo>/routing/`).

- **Провайдер**: сначала пробует `GET :8200/__switch/api/status` (1с timeout), при
  недоступности — фолбэк по `apiKeyHelper`/`ANTHROPIC_BASE_URL` из `settings.json`.
- **Квота для `freemodel` = только активный аккаунт** (не сумма пула):
  ключ из `~/.claude/fm-active-key.txt` → dir через `.freemodel_meta.json`
  (`apiKey`) → блок в `.freemodel_quota_cache.json`. Метрика — 5h окно:
  `pct = (1 − h5/h5max)·100`, `$ = h5max − h5` (остаток до reset).
- **Квота для `ourtoken`** — `live/total` из `ourtoken-sessions.json`.
- **Контекстное окно** (`⧉ ▰▱▱▱▱ 11% 110k/1M`) — из stdin-payload Claude Code
  (`context_window.used_percentage` + `total_input_tokens`/`context_window_size`,
  CC ≥2.1.132). Цвет по занятости: <50% зелёный → <80% жёлтый → красный.
  Нет поля — шкала не рисуется. На 1M-окне процент ползёт медленно
  (1% = 10k токенов), поэтому рядом токены — по ним видно живое движение;
  ~105k на старте сессии = системный промпт + CLAUDE.md + memory, это норма.
- **Реальные окна vs вера CC**: CC ставит `context_window_size` по model id
  (opus без `[1m]` → 200k), а бэкенд может держать больше. В скрипте таблица
  `real_max` по провайдерам (freemodel → 1M, проба 2026-07-19: «prompt is too
  long: 1148091 > 1000000 maximum») — если окно CC расходится, процент
  пересчитывается локально из `total_input_tokens`. Проверка нового провайдера:
  `bash routing/ctx-probe.sh <base_url> <key> <model> 210` (прошло → ≥210k;
  отбило → точный лимит в ошибке), результат вносить в case.
- **Автокомпакт CC** считает от своей веры (200k) и на 1M-бэкендах срезает
  историю втрое раньше нужного → выключен (`autoCompactEnabled: false`),
  компакт вручную по шкале ⧉. Тоггл статус-бара и автокомпакта — вкладка
  «Настройки» дашборда (`/api/statusline/default` отдаёт команду с локальным
  путём, вкл/выкл — через `/api/settings/apply`, `null` = убрать ключ).

### Lazy refresh (пишет в общий кеш дашборда)

Если `updatedAt` активного > **180с** — статуслайн шлёт fire-and-forget
`POST /__switch/api/session/refresh-quota {kind:'freemodel', name:<dir>}` с
`-m 0.5 &` → `refreshOneFreemodelQuota` в `internal/dashboard-api.js` пишет в
`.freemodel_quota_cache.json` → **шкалы дашборда обновляются автоматически**
(тот же файл). Пока свежие данные не пришли — цифры рисуются `DIM` + возраст
`(10m)` в конце.

### AFK

Специальной AFK-паузы **нет и не нужно**: Claude Code рендерит статуслайн
только по событиям (сообщение, ответ, свич). Простаиваешь → скрипт не тикает
→ curl не летит. При возврате улетит один рефреш, следующий рендер уже свежий.
Единственный независимый фон — `fmAuto` auto-rotator (~90с), если включён.

---

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

## Плагины / MCP — вкл/выкл

`GET /api/plugins/list` отдаёт объединение установленных
(`~/.claude/plugins/installed_plugins.json`) и включённых
(`settings.enabledPlugins`). Тоггл шлёт **весь** `enabledPlugins` через
`/api/settings/apply` (shallow-merge верхних ключей). Рекомендованный набор —
константа `PLUGIN_RECO` в `proxy-dashboard.html`; кнопка «★ Включить
рекомендованные» добавляет их, не трогая остальные. Установка новых из
маркетплейса не реализована (нужен `claude plugin install`).

MCP-серверы (правая колонка): `GET /api/mcp/list` читает `~/.claude.json` —
глобальные `mcpServers` + проектные `projects[*].mcpServers`. У Claude Code нет
флага «выключен», поэтому `POST /api/mcp/toggle` перекладывает конфиг сервера
в стэш-ключ `_disabledMcpServers` (Claude Code его игнорирует) и обратно.
Перед каждой записью — timestamped-бэкап `~/.claude.json.bak-*`.

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

## VPS-режим («Экран VPS» для друга)

Опциональный режим: дашборд крутится на арендованной VPS, друг заходит через
HTTPS+пароль и видит рабочий стол VPS прямо во вкладке. Браузеры
(Chrome/Playwright/Camoufox) запускаются **headed** в desktop-сессии, не headless.

- **VPS:** Ubuntu 24.04, 2–4 CPU / 4–8 GB RAM. Графику ставим сами (XFCE +
  tigervnc-standalone + novnc), не берём «VPS с GUI» как услугу.
- **Порты:** наружу только `443` (дашборд) и `22` (по ключу, лучше allowlist).
  VNC/noVNC/internal API слушают `127.0.0.1`/docker net и наружу не светятся.
- **Reverse proxy:** один Caddy/Nginx терминирует HTTPS и проксирует:
  `/` → дашборд `:8200`, `/vnc` → noVNC (только после auth дашборда, не отдельным портом).
- **Auth:** вход на дашборд по паролю (basic-auth у reverse proxy ИЛИ своя
  сессия в `transparent-proxy.js`). noVNC отдельного пароля не имеет — закрыт
  за дашбордом. Админские `/__switch/api/*` наружу без auth не отдавать.
- **Вкладка «Экран VPS»:** `<div data-tab-content="vps">` с noVNC-клиентом
  (iframe на `/vnc/vnc.html?host=...&path=...` или JS-клиент в самой вкладке).
  Кнопки: «Открыть Chrome», «Открыть Camoufox», «Перезапустить экран», «Стоп браузеры».
- **Браузеры:** `headless:false`, запуск внутри XFCE-сессии VNC. Playwright
  `launch({headless:false})`, Camoufox — обычный headed. Для CLI-запуска ставим
  `DISPLAY=:1` (или через `xvfb-run`, если отдельная headless-сессия всё же нужна).
- **Секреты:** токены/ключи в `~/.claude/` на VPS; бэкап `freemodel/`,
  `conduit/accounts/`, `routing/*-keys.json` обязателен. VPS без бэкапа = потеря пула.

> Ponytail: вместо отдельного VNC-сервиса в дашборде можно проксировать `/vnc`
> прямо в Caddy и встроить iframe — меньше кода, чем тащить noVNC-клиент в HTML.
> Добавлять свой VNC-клиент в `proxy-dashboard.html` только если reverse-proxy
> вариант не заживёт.

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
