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
| `20133`| **AgentRouter keepalive** | `routing/keepalive-proxy.js` | **Единая точка входа для agentrouter** (и `claude-*`, и `gpt-*`): держит SSE-паузы thinking-моделей, ретраит транзиентные ошибки, хеджирует. `claude-*` форвардит в agentrouter.org 1-в-1, `gpt-*` переправляет в конвертер `:20132`. Режет `[1m]`-суффиксы, count_tokens отвечает локальной оценкой. Отказы content-filter (`sensitive words`/`content-blocked`) классифицированы как **постоянные** — не ретраятся. `PORT=20133`, `KEY_FILE=ar-active-key.txt`, `MODELMAP_FILE=ar-modelmap.json`. |
| `20132`| **AgentRouter Proxy** (конвертер) | `routing/agentrouter-proxy.js` | Anthropic→OpenAI конвертер для `gpt-*` (`/v1/chat/completions`); `claude-*` — pass-through в `/v1/messages`. Стоит **за** keepalive `:20133`, напрямую из CC больше не адресуется. `wafSanitize`/`WAF_PHRASES` нейтрализуют фразы из блок-листа шлюза на сериализованном теле (иначе `/model gpt-*` падает `500 sensitive words detected`), а `IMAGE_B64_RE` вырезает base64-образы (иначе запросы с картинками в сессии падают `400 content-blocked`). Cyrillic-bypass **отключён** флагом `CYR_BYPASS_ENABLED=false`. **Маппинг claude-тиров** (`ar-modelmap.json`) применяется на каждый запрос по mtime — БЕЗ рестарта. Ключ из `~/.claude/ar-active-key.txt`, CC-заголовки собирает сам. Самопроверка: `node routing/agentrouter-proxy.js selftest`. Отказ content-filter'а (`500 sensitive words` / `400 content-blocked`) кладёт **тело, реально ушедшее на шлюз**, в `%TEMP%\arpx-blocked-*.json` (последние 10) и пишет путь в лог; `node routing/agentrouter-proxy.js wafbisect <дамп> [--max N]` двоичным сужением сводит дамп к минимальной блокирующей подстроке. |
| `20155`| **Tabi Token keepalive** | `routing/keepalive-proxy.js` | SSE keepalive для tabitoken.com. `PORT=20155`, `KEY_FILE=tabi-active-key.txt`, `MODELMAP_FILE=tabi-modelmap.json`. gpt-модели остаются на своём шлюзе: конвертер `:20132` — агентроутеровский (см. `GPT_PROXY_ENABLED`). |
| `20156`| **GoRouter keepalive** | `routing/keepalive-proxy.js` | SSE keepalive для gorouter.app. `PORT=20156`, `KEY_FILE=gorouter-active-key.txt`, `MODELMAP_FILE=gorouter-modelmap.json`. gpt — там же, на своём шлюзе. |
| `20157`| **XPeach keepalive** | `routing/keepalive-proxy.js` | SSE keepalive для xpeach.codes. `PORT=20157`, `KEY_FILE=xpeach-active-key.txt`, `MODELMAP_FILE=xpeach-modelmap.json`. claude-модели каталога помечены `anthropic+openai` → форвардятся нативно, конвертер не нужен. |
| `20128`| **OmniRoute**           | внешний docker-контейнер       | Главный backend (`/v1`), модель `ComboWombo`. БД `~/.omniroute/storage.sqlite`. |
| `8190` | **Notion manager** (архив) | `notion/`                   | Дешёвый backend. Сейчас в архиве. |
| —      | **Telegram-пульт**      | `tgbot/bot.js`                 | Не слушает порт. Long-poll к Telegram. Управляет дашбордом :8200 по HTTP + живая claude-сессия. |

Запуск: `routing/start-switcher.bat` (поднимает :20126 + :20130 + :8200, открывает UI).
Рестарт: `routing/restart-dashboard.bat` (убивает все три, перезапускает).
ТГ-бот: `npm run tgbot` (нужен `tgbot/.env`, см. `tgbot/README.md`).

## Obsidian RAG on-demand (D:\WORMALIENAIGIGANT) + свипер зомби-браузеров

Стек (Ollama + Docker Desktop + контейнер `obsidian-rag` :8082) не живёт в фоне —
поднимается **по требованию** при первом поиске и сам гасится после 15 мин простоя.

| Что | Где | Поведение |
|---|---|---|
| Подъём | `D:\WORMALIENAIGIGANT\app\rag-on.bat` | Идемпотентно: Ollama → модель `snowflake-arctic-embed2` → Docker → `docker compose --profile app up -d obsidian-rag` → ждёт `/status`. Heartbeat в `app\.rag-idle.txt` пишется **сразу после старта контейнера**, до ожидания `/status` (холодный старт после реиндекса vault может превысить таймаут). |
| Гашение | `D:\WORMALIENAIGIGANT\app\rag-off.bat` | Стоп контейнера + kill Ollama. Docker Desktop гасится **только если нет других контейнеров** (OmniRoute в Docker — НЕ трогаем). Удаляет heartbeat. |
| Idle-стоп | `D:\WORMALIENAIGIGANT\scripts\rag-idle-stop.ps1` | Task Scheduler «Autoreger RAG idle-stop», каждые 5 мин: `:8082` жив, heartbeat старше 15 мин (или отсутствует) → rag-off. |
| Env | `OLLAMA_KEEP_ALIVE=2m` (User) | Модель выгружается из RAM через 2 мин после последнего запроса. |
| Авто-подъём из поиска | `D:\WORMALIENAIGIGANT\scripts\wiki_patch.py` `cmd_search` | `:8082` лежит → сам запускает `rag-on.bat` → повторный `/status` → `# index: N chunks`. В конце `hb.touch()` heartbeat. |
| Свипер зомби | `routing/cleanup-reg-procs.ps1` | Убивает `chrome/camoufox` с маркером `ms-playwright\|github\\profiles\|agentrouter\\sessions\|camoufox\\Cache`, если родитель мёртв или = `explorer.exe`. Живые LK-сессии — skip. Вызывается из `start-switcher.bat` при каждом старте дашборда. |
| Команда `/wiki` | `C:\Users\WormAlien\.config\opencode\command\wiki.md` | Глобальная для opencode; RAG поднимает через `search`. Видна в TUI после рестарта opencode. |

Живой цикл проверен 2026-08-13: rag-on → `/status` (4433 chunks) → `search` авто-подъём с хитами → idle-стоп (heartbeat состарен на 20 мин) → rag-off. Детали и оставшиеся пункты — `docs/RAG-ONDEMAND-HANDOFF.md`.

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
- **agentrouter** (прямой режим) — `ANTHROPIC_BASE_URL=http://localhost:20133` (SSE keepalive,
  форвард в agentrouter.org БЕЗ `/v1`), ключ пишется **литералом** в `ANTHROPIC_AUTH_TOKEN`
  (не apiKeyHelper — WAF agentrouter не пускает helper-путь). `apiKeyHelper` удаляется,
  модель из `~/.claude/ar-active-model.txt`. Роутинг: и `claude-*`, и `gpt-*` идут в
  `:20133`, который сам переправляет gpt в конвертер `:20132`. Пул:
  `routing/agentrouter-sessions.json`.
- **gorouter** (прямой режим) — `ANTHROPIC_BASE_URL=http://localhost:20156` (SSE keepalive,
  форвард в gorouter.app), ключ литералом в `ANTHROPIC_AUTH_TOKEN` из `gorouter-active-key.txt`,
  модель из `~/.claude/gorouter-active-model.txt` + `gorouter-modelmap.json`. Пул:
  `routing/gorouter-sessions.json`.
- **tabi** (прямой режим) — `ANTHROPIC_BASE_URL=http://localhost:20155` (SSE keepalive,
  форвард в tabitoken.com), ключ литералом в `ANTHROPIC_AUTH_TOKEN` из `tabi-active-key.txt`,
  модель из `~/.claude/tabi-active-model.txt` + `tabi-modelmap.json`. Пул:
  `routing/tabi-sessions.json`.
- **xpeach** (прямой режим) — `ANTHROPIC_BASE_URL=http://localhost:20157` (SSE keepalive,
  форвард в xpeach.codes), ключ литералом в `ANTHROPIC_AUTH_TOKEN` из `xpeach-active-key.txt`,
  модель из `~/.claude/xpeach-active-model.txt` + `xpeach-modelmap.json`. Пул:
  `routing/xpeach-sessions.json`. Валюта шлюза — 🍑 (курс к единице квоты как у $).
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

> ⚠️ Версию Claude Code фиксировать НЕ надо. Пин `2.1.153` + `DISABLE_AUTOUPDATER=1`/
> `autoUpdates:false` был основан на неверном выводе «новее ломает `apiKeyHelper`» —
> ротация ключей на лету работает на всех версиях. Из установщика и шаблона убраны.
> Для `apiKeyHelper`-режимов важно только `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=0`
> (иначе CC кэширует ключ и смена на вкладке не подхватывается).

### Окно контекста: инвариант `[1m]` (иначе 200k)

**Инвариант:** после любой операции дашборда `settings.model` — непустая строка, и если
она `claude-(opus|sonnet)-*`, в ней есть `[1m]`. Без суффикса Claude Code считает окно
200k и режет историю втрое раньше; `[1m]` — метка CC, не API-модель, прокси её срезают
перед форвардом (`keepalive-proxy.js`), поэтому шлюзу она не мешает.

**Чокпоинт — `writeSettings()`** (`transparent-proxy.js`). Все записи `settings.json` идут
через него, и он же нормализует `model` и `env.ANTHROPIC_MODEL` через `normalizeCcModel()`.
Отдельные хендлеры суффикс больше не дотягивают — это была причина бессмертного симптома:
записей в файл было 24, а суффикс добавляли 4 места, каждый агент чинил свой путь.
Единственная разрешённая прямая запись — восстановление сырого текста из бэкапа
(`fs.writeFileSync(SETTINGS_FILE, raw, 'utf8')`, там строка, а не объект).

**`delete settings.model` = переход на дефолт Claude Code, то есть на 200k.** Поэтому
активация ключа модель больше не сбрасывает там, где есть свой источник правды:

| Провайдер | Источник модели при активации |
|---|---|
| agentrouter / gorouter / tabi / xpeach / conduit | `<p>-active-model.txt` → в `settings.model` (суффикс дотянет `writeSettings`) |
| freemodel | своя модель, иначе явный дефолт `claude-opus-5[1m]` |

Остальные (aerolink, evomap, ourtoken, custom, svrtr, helpcoder, vyceai, omniroute) шлют
запросы через виртуальную модель шлюза (`ComboWombo` у OmniRoute) либо держат в каталоге
только `gpt-*` — им `delete` корректен, и **Claude Code считает окно по своему дефолту**
(реальное окно шлюза при этом может быть больше — см. ниже). Пинить модель вслепую нельзя:
сначала смотреть каталог шлюза, иначе глобальный пин положит запросы. У agentrouter
на 2026-08-18 в каталоге три модели — `claude-opus-4-8`, `claude-opus-5` (обе
`supported_endpoint_types: [anthropic, openai]`) и `gpt-5.6-sol` (только `openai`, поэтому
идёт через конвертер `:20132`).

**У gpt-моделей `[1m]` не работает — но окно у них известно и переопределяемо.** Суффикс
`[1m]` — перечисление внутри Claude Code (в бинаре он есть только на `opus|sonnet|fable|opusplan`
и `claude-opus-4-6…5` / `claude-sonnet-4-5…5`), к `gpt-5.6-sol` неприменим. Больше того,
`gpt-5.6-sol[1m]` **сломает запрос**: в `keepalive-proxy.js` ветка `isGptLike()` уходит на
конвертер **до** среза суффикса, а `agentrouter-proxy.js` его не режет — апстрим получит имя
модели вместе с `[1m]`.

Настоящее окно смотреть не у шлюза (ни `/v1/models`, ни `/api/pricing` длину контекста не
содержат), а в каталоге провайдера. `gpt-5.6-sol` — это публичная **OpenAI GPT-5.6 Sol:
контекст 1 050 000, выход 128k** (каталог OpenRouter `/api/v1/models`, 2026-08-18; всё
семейство 5.6 — Luna/Terra/Sol ±`-pro` — одинаково 1.05M/128k, а gpt-5.1/5.2/5.3-codex —
400k). То есть окно там **больше**, чем у claude-opus-5, а CC про модель не знает и режет
историю по своему дефолту.

Рычаг: **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** в `settings.json` → `env`. Его выставляет тот же
`writeSettings()`, что нормализует суффикс — по таблице `routing/model-windows.json`
(`модель → окно`, 59 записей, залита из каталога OpenRouter `/api/v1/models`, перечитывается
по mtime). Логика в `ccContextTokensFor()`:

- модель есть в таблице (`gpt-5.6-sol` → `1050000`) → ключ пишется, CC считает по нему, и
  знаменатель `⧉ N/M` в статуслайне становится правдой **сам**, без правок скрипта;
- модель `claude-*` → ключ **снимается**. Это обязательно: залипшие `1050000` на
  `claude-opus-5` (у которого реально 1M) — это переполнение контекста на апстриме;
- модели нет в таблице → ключ не пишется. Врать наугад хуже, чем молчать: CC хотя бы
  компактит консервативно.

Статуслайн при этом не трогаем принципиально. Врать в баре поверх чужой веры здесь уже
пробовали таблицей `real_max` — получалось «16% при реальной занятости 90%», потому что
автокомпакт CC идёт по своему числу, а не по нарисованному. Поэтому правится источник.

⚠️ Семантика `CLAUDE_CODE_MAX_CONTEXT_TOKENS` взята из имени и окружения в бинаре CC (переменная
лежит в кластере компакта, рядом с `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `DISABLE_AUTO_COMPACT`) — документации на неё нет. Финальная
проверка: перезапустить CC на gpt-модели и посмотреть знаменатель `⧉ N/M`.

**Регресс-тест:** `node tools/check-1m.js` — падает, если в живом `settings.json` модель без
суффикса, если кто-то пишет `settings.json` напрямую, если из `writeSettings()` убрали
нормализацию, или если `normalizeCcModel()` перестал держать таблицу кейсов.

**Проверять руками — не по транскрипту** (`message.model` там всегда без суффикса, прокси
режут): реальное окно последней сессии видно в `~/.claude.json` →
`projects["<cwd>"].lastModelUsage` (ключ либо `claude-opus-5[1m]`, либо `claude-opus-5`),
и в статуслайне (`model.id` от самого Claude Code). Подробный разбор — `docs/HANDOFF-model-1m.md`.

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
| **AgentRouter** | активна | ручной пул ключей agentrouter.org, пинг `/v1/models` с CC-заголовками (live/dead), **баланс ключа** (выдача − потрачено, кеш в sessions.json), **🌐 ЛК** (open-session.js: нет ключа → регистрация по рефке `?aff=`, есть ключ → `/console/topup`, чек-ин +$25), **аккаунт без ключа** (`status: no_key`), выбор модели → `ar-active-model.txt` + `settings.model`; claude-* напрямую, gpt-* через прокси :20132, **маппинг claude-тиров** (`ar-modelmap.json`, применяется прокси по mtime) | `/api/ar/{sessions,ping,balance,set-grant,session/open,add,delete,models,activate,set-model,modelmap}` |
| **GoRouter** | активна   | ручной пул ключей gorouter.app, GitHub-вход в консоль, **🌐 ЛК** (нет ключа → рефка `?aff=`, есть → `/wallet`), **аккаунт без ключа** (`status: no_key`), баланс (`grant + bonus − spent`, чек-ин «+5» шагом $5), маппинг моделей, **активация через SSE keepalive :20156** (keepalive-proxy.js → gorouter.app, срез `[1m]`, count_tokens fallback) | `/api/go/{sessions,ping,balance,set-grant,add-bonus,session/open,add,set-key,rename,delete,activate,set-model,modelmap,models}` |
| **Tabi Token** | активна  | ручной пул ключей tabitoken.com, GitHub-вход в консоль, **🌐 ЛК** (нет ключа → рефка `?aff=`, есть → `/wallet`), **аккаунт без ключа** (`status: no_key`), баланс (`grant + bonus − spent`, дефолт $100, реф-бонус $20), маппинг моделей, **активация через SSE keepalive :20155** (keepalive-proxy.js → tabitoken.com, срез `[1m]`, count_tokens fallback) | `/api/tb/{sessions,ping,balance,set-grant,session/open,add,set-key,rename,delete,activate,set-model,modelmap,models}` |
| **XPeach** | активна    | ручной пул ключей xpeach.codes («🍑 Code», New-API ветки tabitoken → `HOST_AUTH='jwt'`), GitHub-вход в консоль, **🌐 ЛК** (нет ключа → рефка `?aff=0lre`, есть → `/console/topup`), **аккаунт без ключа** (`status: no_key`), **точный баланс** из `/api/user/auth/refresh` (валюта 🍑, курс к единице квоты как у $), маппинг моделей, **активация через SSE keepalive :20157**. Каталог 32 модели: 8 claude `anthropic+openai` (ходят нативно) + grok/gpt-5.x/картинки/видео — они `openai`-only и помечены бейджем. Чек-ина нет (`checkin_enabled=false`) | `/api/xp/{sessions,ping,balance,set-balance,map-profiles,session/open,add,key,rename,delete,activate,set-model,modelmap,models,share,import}` |
| **GitHub аккаунты** | активна | хранилище купленных аккаунтов (логин/пароль/2FA-секрет/recovery/ник), **TOTP считается локально в браузере** (base32+HMAC-SHA1, RFC 6238, 30с+countdown), карточки-сетка, профиль браузера на аккаунт (сохраняет GitHub-сессию), статусы live/cooldown/dead вручную | `/api/gh/{keys,add,import,delete,update,open}` |
| **Telegram аккаунты** | активна | менеджер общего ТГ-пула `freemodel/tg_pool.json`: **вся таблица целиком** (в отличие от блока «Telegram pool», свёрнутого до 3 строк), поиск (номер/ключ/кем занят), фильтры (статус, health, «свободен для сервиса»), сортировка, открытие в портативном Telegram Desktop, **переименование плейсхолдеров** `tg_xxxx` (роут `rename` до этого был без UI), **health-чек фоновый** (scope `unchecked`/`all` + прогресс, вместо блокирующего запроса на десятки минут), **колонки годности по сервисам** FM/CDT/SR/AM | `/api/tg/{list,add-bulk,add-session,delete,mark-free,rename,open,health-check,health-progress}` |
| **HelpCoder** | активна   | аккаунты helpcoder.cc (New-API, OpenAI-совместимый), квоты через cookie-`/api/user/self`, авторег username+password (без email/капчи), активация через API Helper | `/api/helpcoder/{sessions,active-key,refresh-quota,activate,add,autoreg,models}` |
| **Video API** | активна   | хранилище ключей видео-провайдеров (CRUD), триал-каталог | `/api/video/*` |
| **Картинки API** | активна | менеджер аккаунтов картинко-провайдеров (NanoBanana/fal/Replicate/Imagen…), email-метка + ключ, триал-каталог | `/api/image/*` |
| **Плагины / MCP** | активна | слева плагины Claude Code (тоггл `enabledPlugins`, ★ рекомендованные), справа MCP-серверы из `~/.claude.json` | `/api/plugins/list`, `/api/settings/apply`, `/api/mcp/list`, `/api/mcp/toggle` |
| **Настройки** | активна   | обновление дашборда, OmniRoute env, JSON-редактор `settings.json` + бэкапы, **тоггл статус-бара CC** и **автокомпакта** | `/api/settings/*`, `/api/env`, `/api/statusline/default`, `/api/dashboard/update-*` |
| **TokenRouter** | архив («Чтим память») | аккаунты, usage, health   | `/api/tokenrouter/*` |
| **Devin**     | архив     | сессии + квоты (daily/weekly %)     | `/api/session/*` |
| **Notion**    | архив     | сессии + карты                      | `/api/notion/*` |

### Сайдбар: счётчики и бейдж Health заполняются на старте

`nav-count-*` исторически ставился **только внутри load-функции своей вкладки**, а та
висела на ленивой загрузке в `showTab()`. Итог: после рестарта дашборда весь сайдбар
стоял в `—`, пока по вкладкам не прокликаешь руками; то же с бейджем Health
(`loadHealth()` звался лишь при открытой вкладке).

Лечится `bootNavCounts()` в блоке INIT (`proxy-dashboard.html`) — один проход на boot:
`loadArSessionsLight` / `loadGoSessionsLight` / `loadTbSessionsLight` /
`loadXpSessionsLight` / `loadGhKeys` / `loadTgPool` / `loadCustomProviders` /
`loadPlugins`, каждый в своём `try` (падение одного не глотает остальные), плюс
`loadHealth()`.

⚠️ Здесь можно вызывать **только то, что читает локальный JSON**. У ar/go/tb/xp взяты
именно `*SessionsLight`: полные `loadXxSessions()` тянут ещё `loadXxModels()`, а это
запрос к шлюзу — он попал бы под рейт-лимит WAF на **каждом** открытии дашборда.
`?probe=1` / `?balance=1` по той же причине не передаются. `state.loaded.*`
намеренно НЕ трогается: первый заход на вкладку по-прежнему делает полную загрузку.

### Health: «не запущен» ≠ «упал»

Keepalive-инстансы `:20155` / `:20156` / `:20157` спавнятся **только при активации
своего провайдера** (boot-спавнится один `:20133`). Лежащий keepalive — нормальное
состояние покоя, поэтому красное «упал» на нём было ложной тревогой: при полностью
здоровой системе Health показывал три красные строки и бейдж `5↓`.

`isIdle(s)` в `renderHealth()` = `s.keepalive && status !== 'up' && s.port !== wired.port`
→ серый бейдж «не запущен» + подсказка «поднимется при активации провайдера», и такие
строки **не считаются** в бейдж сайдбара. Красным остаётся порт, в который реально
смотрит Claude Code (`wired.port`): если лёг он — это настоящая поломка.

Custom-конвертеры под правило НЕ попадают сознательно: у них `proxyPort` в
`custom-providers.json` выставлен только на время активации, поэтому «порт в конфиге
есть, процесса нет» — это протухшее состояние, а не покой, и его надо видеть.

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

## ТГ-пул — кто кого возьмёт (`status: used` ≠ «занят навсегда»)

Пул `freemodel/tg_pool.json` общий, но **`status` в нём — маркер только FreeModel**.
Остальные сервисы ведут свои `.tg_used.json` и `used` в пуле игнорируют, поэтому один ТГ
законно регается на несколько сервисов. На 2026-08-18 в пуле 300 записей: `free 2`,
`used 158`, `banned 140` — но кандидатов у Conduit 156, у Svrtr 150, у AnyModel 116.
`banned` — **единственный глобальный** статус (мёртвый ТГ мёртв везде).

| Сервис | Что реально возьмёт пикер | Где |
|---|---|---|
| FreeModel | `status === 'free' && !dead` | `tgPool.reserve()` — `freemodel/lib/tg-pool.js` |
| Conduit | `status !== 'banned' && !в conduit/.tg_used.json` | `pickTg()` — `conduit/conduit_autoreger.js` |
| Svrtr | `status !== 'banned' && !в svrtr/.tg_used.json` | `pickTg()` — `svrtr/svrtr_autoreger.js` |
| AnyModel | `status !== 'banned' && !dead && !в anymodel/.tg_used.json` | `pick()` — `anymodel/lib/tg-usage.js` |

`dead` — по `freemodel/.tg_health_cache.json` (`tgPool.isDead`). **Conduit и Svrtr его не
смотрят** — их пикер отдаст отозванный ключ; вкладка Telegram показывает это как есть
(годен + бейдж 🔴 dead), а не как хотелось бы.

Эти же правила продублированы в `tgFreeFor()` (`transparent-proxy.js`) — она считает поля
`freeFor`/`usedOn` записи и `stats.freeFor` для `/api/tg/list`. **Меняешь пикер — меняй и
её**, иначе цифры во вкладке разойдутся с реальностью. Проверка расхождения:

```bash
curl -s localhost:8200/__switch/api/tg/list | node -e "…stats.freeFor…"
node -e "console.log(require('./svrtr/svrtr_autoreger').svrtrAvail())"      # == freeFor.sr
node -e "console.log(require('./conduit/conduit_autoreger').conduitAvail())" # == freeFor.cdt
node -e "console.log(require('./anymodel/lib/tg-usage').stats().available)"  # == freeFor.am
node -e "console.log(require('./freemodel/lib/tg-pool').stats().usable)"     # == freeFor.fm
```

**Health-чек** (`freemodel/lib/tg-health.js`) — read-only connect+getMe, безбанный,
**последовательный** (одно подключение с твоего IP за раз, ~2-6 c на аккаунт). Массовый
прогон поэтому фоновый: `POST /api/tg/health-check {scope}` стартует и сразу отвечает,
состояние в памяти прокси (`tgHealthJob`), опрос — `GET /api/tg/health-progress`.
`scope:'unchecked'` = только те, кого нет в health-кэше; `'all'` = все не-banned.
Кэш пишется после **каждого** аккаунта, так что рестарт прокси на середине = стоп-кран
без потери проверенного. Пока прогон идёт, одиночный чек и повторный старт отдают `409`
(тот же ключ в двух коннектах = `AUTH_KEY_DUPLICATED`). **Отмены нет** — только рестарт
дашборда. Запрос **без** `scope` — старый блокирующий `checkAll`, им живут блоки пула в
4 вкладках.

**Грабля UI:** `paintTgLists()` затирает **все** контейнеры с классом `.tg-list` разметкой
свёрнутого блока (он один на FreeModel/Conduit/Svrtr/AnyModel). Таблица вкладки Telegram
живёт в `#tgm-list` **без** этого класса и рисуется своей `renderTgManager()`; данные общие
— `state.tg`, наполняется `loadTgPool()`, которая в конце дёргает оба рендера. Новый
контейнер пула вешать на `.tg-list` — да; новую независимую таблицу — нет.

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
- **Маршрутизация моделей** (`arTargetFor`): **всё** идёт в keepalive `:20133`, и claude-*,
  и gpt-*. Keepalive форвардит `claude-*` в `agentrouter.org` 1-в-1, а `gpt-*` сам
  переправляет в конвертер `:20132` (у agentrouter gpt живёт только на OpenAI-эндпоинте).
  Раньше gpt шёл на `:20132` напрямую — там нет ни ретраев, ни keepalive-пингов, поэтому
  транзиентная 5xx всплывала жёсткой ошибкой, а длинная reasoning-пауза рвала стрим по
  watchdog'у Claude Code. Оба прокси поднимаются вместе (`arSpawnBoth`): конвертер нужен
  даже при claude-основной модели, т.к. туда уходят haiku-вызовы сабагентов по маппингу.
- **Маппинг claude-тиров** (`routing/ar-modelmap.json`, `{opus, sonnet, haiku}`): правится
  на вкладке AgentRouter (`GET/POST /__switch/api/ar/modelmap`). Прокси `:20132` и keepalive
  `:20133` перечитывают файл по mtime на каждый запрос — правка применяется **без рестарта**.
  Модель запроса (в т.ч. `claude-haiku-4-5` от Explore-агента) матчится по тиру → подменяется
  на целевую модель agentrouter; gpt-цель уходит через OpenAI-конвертер, claude-цель — pass-through.
  У agentrouter своих haiku-моделей нет, поэтому тир haiku закрывает сабагентов. Клик по
  чипу модели маппинг **не трогает** — это ручная настройка.
- **Конвертер `:20132` — только для agentrouter-инстанса** (`GPT_PROXY_ENABLED` в
  `keepalive-proxy.js`): он ходит на `agentrouter.org` ключом из `ar-active-key.txt`,
  поэтому уводить туда gpt с инстанса `:20155`/`:20156` нельзя — это молча жгло бы баланс
  AgentRouter чужим ключом и ловило его content-filter, пока в UI выбран другой шлюз.
  Гейт смотрит на `UPSTREAM` своего инстанса; перебить — `GPT_PROXY_FORCE=1`. Под гейтом
  же fallback `haiku→HAIKU_TO_MODEL` и gpt-цель тир-маппинга: без конвертера модель уходит
  на свой шлюз как есть. Состояние гейта пишется в лог при старте (`gpt-конвертер: …`).
- **Каталог у agentrouter маленький** (на 2026-08-16 — 3 модели): `claude-opus-4-8`,
  `claude-opus-5` (anthropic+openai) и `gpt-5.6-sol` (**только** openai). Модели с
  `supported_endpoint_types` без `anthropic` помечены на вкладке бейджем `openai` —
  они идут только через конвертер.

### Два разных фильтра: WAF (по заголовкам) и content-filter (по фразам)

Их легко спутать — ошибки разные и лечатся по-разному.

**1. WAF — смотрит на заголовки.** Пускает только запросы, похожие на Claude Code.
Ключевой признак — `user-agent`: `claude-cli/…` → 200, `curl/8.0` → `401 unauthorized
client detected` (проверено 2026-08-16, при прочих равных заголовках). `agentrouter-proxy.js`
собирает `CC_HEADERS` с нуля, `keepalive-proxy.js` форвардит клиентские и добивает
отсутствующие из `CC_FALLBACK_HEADERS` (`user-agent`/`anthropic-version`/`x-app`;
`anthropic-beta` намеренно НЕ ставим — инстансы `:20155`/`:20156` ходят на другие шлюзы).

**2. Content-filter — смотрит на текст.** На OpenAI-эндпоинте `/v1/chat/completions`
шлюз режет **точные подстроки** из своего блок-листа. Замеры (2026-08-16, дополнено
2026-08-17 — ≈40 проб `max_tokens=1`):

| текст в system / user / tool_result | итог |
|---|---|
| `You are a helpful assistant.` | ⛔ 500 sensitive words |
| `x-anthropic-billing-header:` | ⛔ 500 sensitive words |
| `You are a helpful assistant` (без точки) | ✅ 200 |
| `You are a helpful AI assistant.` | ✅ 200 |
| `Act as a helpful assistant.` / `helpful assistant.` | ✅ 200 |
| та же фраза в `description` тула | ✅ 200 (не сканируется) |
| та же фраза на claude-модели (Anthropic-passthrough) | ✅ 200 |
| `As an AI`, `api key`, `reminder`, `language model`, `AI model`, `<system>`, `You are Cursor.`, `You are ChatGPT.` | ⛔ 400 content-blocked, но **только в коротком теле** — внутри реалистичного промпта 200 |

Из этого: блок-лист 500 — регистронезависимая подстрока, режется в **любом** контексте и
только на gpt-пути. Список 400 срабатывает лишь на маленьких телах, реальный трафик CC им
не рвётся, поэтому в `WAF_PHRASES` он **не берётся**. Маскировка под `codex_cli_rs`
(как в гуляющем по гайдам python-прокси) на content-filter **не влияет** — та же фраза
даёт 500 и с `claude-cli`, и с `codex_cli_rs`; это фильтр по тексту, а не WAF.

Два практических эффекта, оба лечит `WAF_PHRASES`:

- **пробник валидации модели у Claude Code** (в логе прокси `stream=false msgs=2 tools=0`)
  шлёт generic-фразу `You are a helpful assistant.` как system — `/model gpt-5.6-sol`
  падал `500` детерминированно (12/12), хотя обычный чат работал;
- **CC 2.1.220** вписывает ПЕРВОЙ строкой системного промпта телеметрию
  `x-anthropic-billing-header: cc_version=…; cc_entrypoint=cli;`, а её имя лежит в
  блок-листе — с этим апдейтом 500 стал ловить **каждый** запрос CC на gpt-пути, даже
  «qq». Строка для модели бессмысленна, поэтому вырезается целиком.

Лечение — `WAF_PHRASES` + `wafSanitize()` в `agentrouter-proxy.js`: правка делается
**один раз на сериализованном теле** перед отправкой (единственная точка, которую нельзя
обойти — мультимодальная ветка конвертера отдаёт `parts` сырыми, а
`tool_calls[].function.arguments` вообще мимо текстовых хелперов). Замена семантически
нейтральная (`+ AI` / вырезание телеметрии), срабатывание пишется в лог
(`waf sanitize: N hit(s)`) и в `stats.sanitized` — молча менять текст запроса нельзя.
Таблицу держим **узкой**: только фразы, проверенные пробой, с датой; не эвристика.

**Base64-изображения — новый класс 400 (2026-08-18, главный реальный блокер).**
В отличие от «списка 400», который рвётся только на коротких телах, классификатор
режет **любой** base64-образ детерминированно, в любом контексте: даже
`/9j/4AAQSkZJRg==` (16 симв.) → `400 content-blocked`, `iVBOR…` → 400, а
`[image omitted]` → 200. С тулами-картинками (скриншоты, дампы экрана) сессия
накапливает образы в tool_result, body разрастается (в одном 12МБ-запросе 31 JPEG +
11 PNG = 7.5МБ из 7.7МБ корпуса) — и падает **каждый** запрос на gpt-пути. Проверка
на реальном корпусе: RAW дамп → 400, вырезка base64 → 200. Это та самая причина,
почему «waf sanitize: 1 hit(s)» в логе не спасал — ловились фразы, а тело резал шлюз.

Лечится в `wafSanitize` одним проходом `IMAGE_B64_RE`:
- `data:image/…;base64,…` (image_url от конвертера) → **валидная 1x1 PNG** — НЕ текст:
  апстрим декодирует base64 в image_url и на `[image omitted]` падает
  `500 failed to decode base64` (проверено живым пробником);
- сырые блобы магиков `/9j/`, `iVBOR`, `R0lGOD`, `UklGR`, `Qk0`, `Qk1`, `PHN2Zy`
  (в tool_result после `JSON.stringify` блока image) → `[image omitted]`.

Срабатывание пишется в лог (`waf sanitize: N base64-образ(а) → …`) и в `stats.sanitized`.
Живым пробником подтверждены оба пути: user-image → 200, tool_result-блоб → 200.
`wafbisect` по дампу дважды сходился к `(2160,` — это **артефакт**: `textCorpus()`
не извлекает image-блоки, поэтому реальный блокер (base64) выпадал из корпуса, а
сужение упиралось в случайные длинные строки рядом.

**Как найти следующую фразу, а не гадать.** Отказ content-filter'а кладёт тело, реально
ушедшее на шлюз, в `%TEMP%\arpx-blocked-*.json` (счётчики `blocked`/`lastBlockedDump` в
статусе `:20132`) — до этого логи конвертера жили только в RAM-буфере дашборда и умирали
с его рестартом. Дальше `node routing/agentrouter-proxy.js wafbisect <дамп> [--max N]`
сужает дамп двоично (строки → слова → срез краёв) до минимальной блокирующей подстроки:
живой 97к-запрос свёлся к 27 символам за 14 проб. Пробы дешёвые (`max_tokens=1`,
заблокированные вообще бесплатны), бюджет ограничен `--max` (по умолчанию 30).

В `keepalive-proxy.js` такой отказ классифицирован как **постоянный**
(`RETRY_NO_CONTENT = /sensitive words|content-blocked/i`): ответ детерминирован, ретраи
только жгли платные запросы (раньше проваливалось в fallback `status >= 500`).

**Cyrillic-bypass (историческое, отключено).** Раньше латиница резалась
`500 sensitive words detected`, и обходили заменой `c`→`с`. С 2026-08-15 наоборот: WAF
детектит кириллические хомоглифы → `400 content-blocked`, чистую латиницу пропускает.
Поэтому `cyrEncode`/`cyrDecode` остались, но **отключены** флагом
`CYR_BYPASS_ENABLED = false`. Если снова начнёт резать латиницу целиком — поднять флаг.

### Самопроверки прокси

`node routing/agentrouter-proxy.js selftest` и `node routing/keepalive-proxy.js selftest` —
оба стоят до `server.listen` и выходят через `process.exit(0)`, порт не занимают, поэтому
безопасны при поднятых рабочих прокси. Покрывают `wafSanitize` (в т.ч. мультимодальную
ветку и вырезание телеметрии CC), роутинг gpt→конвертер в **обеих** ветках гейта
(`GPT_PROXY_ENABLED` — `let`, прогон переключает его сам, поэтому результат не зависит от
`UPSTREAM` инстанса), классификатор ретраев и ручки хеджа. `wafbisect` порт тоже не
занимает — `server.listen` в этом режиме не поднимается.

### Статус прокси

- Спавн: `arProxySpawn()` — проверяет свободу `:20132`, поднимает
  `agentrouter-proxy.js` detached (stdio: ignore). Уже запущен → `{already:true}`.
- Статус/статистика: `GET http://localhost:20132/__agentrouter/api/status`
  (`stats: requests/streamed/errors/lastModel`). Логи в консоли процесса
  (при ручном запуске — в `%TEMP%\arpx_foreground*.log`).
- В `start-switcher.bat` / `restart-dashboard.bat` порт `:20132` в списке KILLPORT.

### Баланс ключа (продажа на FunPay)

Точный остаток берётся из **аккаунтного** эндпоинта New-API, а не выводится из ключа.
Общий модуль на все четыре вкладки (ar/go/tb/xp) — `routing/lib/newapi-account.js`, общий
расчёт — `newapiBalance()` в `transparent-proxy.js` (одна реализация вместо четырёх копий).

**Три источника, первый сработавший побеждает** (поле `balanceSource` в записи):

| источник | бейдж | откуда |
|---|---|---|
| `self` | ⚡ точный | `GET /api/user/self` → `quota` (остаток) и `used_quota` (расход) в единицах квоты; USD = `quota / quota_per_unit` (500000, из `/api/status`) |
| `anchor` | ✏️ вручную | вписанный из ЛК баланс + расход на момент вписывания: `balance = balanceAnchor − (spent − anchorSpent)`, дальше убывает сам |
| `guess` | ~ прикидка | последний резерв: `max(база, ceil(spent/шаг)*шаг) − spent`. База 175 / 70 / 100 |

- `usage`-эндпоинт (`/dashboard/billing/usage`, `total_usage` **в центах**) зовётся всегда:
  он определяет живость **ключа** (401/403 = мёртв), а `self` говорит только про аккаунт —
  для продажи важно первое. Внимание: `total_usage` — расход **токена**, а не аккаунта, и при
  пересоздании токена занижен, поэтому при успехе `self` расход берётся из `used_quota`.
- **Авторизация аккаунтная, не ключевая**, и различается по версиям New-API:
  `agentrouter.org` / `gorouter.app` (classic) — cookie `session` + заголовок `New-Api-User: <id>`,
  причём **id читается локально из самой куки** (gorilla/sessions подписывает, но не шифрует);
  `tabitoken.com` (rc.23) и `xpeach.codes` — `POST /api/user/auth/refresh` с кукой
  `new_api_refresh` → JWT. Схема на хост — `HOST_AUTH` в `newapi-account.js`.
- **Куки берутся прямо из профилей Chromium** (`<provider>/profiles/<label>`), без запуска
  браузера: схема `v10`, ключ в `Local State` под DPAPI (раскрывается через PowerShell
  `ProtectedData.Unprotect`), сама БД читается копией через `better-sqlite3`.
- **Свой cookie-jar** `routing/newapi-jar.json` (gitignored): refresh-кука у tabitoken
  **одноразовая** — сервер отдаёт новое значение в `set-cookie`, а в живую БД профиля
  (браузер открыт) писать нельзя. Jar же кеширует access-токен (~15 мин), чтобы повторный
  чек не жёг refresh. Пишется **перечитыванием диска по одному ключу**: пачка идёт по 3
  аккаунта, и запись снимка целиком затирала чужие свежие куки (та же грабля, что лечит `arSaveMerge`).
- **Обратная запись куки в профиль** (`writeProfileCookies` / `syncJarToProfile`, зовётся из
  `newapiSyncProfile`). Зачем: сам jar породил вторую беду — профиль оставался со значением,
  которое наш чек уже погасил, и при открытии ЛК браузер шёл refresh'ем по мёртвой куке →
  401 → **разлогин** (замерено: у 9 из 10 tabi-профилей значения расходились). Поэтому
  ротированная кука уезжает обратно в БД профиля — перед открытием ЛК, после точного чека
  и после сопоставления профилей. Тонкости:
  - Плейнтекст перед шифрованием обязан начинаться с **32 байт SHA-256 от `host_key`**
    (у сборок Chrome 130+), иначе браузер молча выбросит куку. Хеш считается от host_key
    **той самой строки** — у части куки он с ведущей точкой.
  - Писать только когда браузер профиля **закрыт**: Chromium держит куки в памяти и на выходе
    перезапишет файл своим состоянием. Проверка — по картам pid'ов открытых ЛК
    (`newapiLkBusy`), вторая линия — `busy_timeout` и отказ по `SQLITE_BUSY`.
  - Ротация **двусторонняя**: если ты сам входил в ЛК, последним куку ротировал браузер, и
    в jar лежит мёртвое значение. Поэтому сравниваем `last_update_utc` куки с `cookiesAt`
    записи jar: чья свежее — той и верим (`effectiveCookieHeader`), а свою погашенную из jar
    снимаем. Без этого «лечение» разлогинивало бы живые сессии.
- **Связка записи с профилем** — `profile` + `newApiUserId`, ставит `POST /api/{ar,go,tb}/map-profiles`
  (`newapiMapProfiles`, кнопка «🔗 Профили»). Сверка **по самому ключу**, не по github-логину:
  у GoRouter поля `email` оказались скопированы из AgentRouter. `GET /api/token/` отдаёт ключ
  по-разному — agentrouter полным (без префикса `sk-`), gorouter/tabi замаскированным
  (`sk-78xp******`), для второго случая полный раскрывается `POST /api/token/<id>/key`.
  Ответ роута также возвращает **бесхозные профили** — живые аккаунты, которых нет в пуле.
- **Резерв связки без сопоставления** (`newapiResolveProfile`, 2026-08-18): если метки `profile`
  нет, берётся детерминированная `acct_<id>` — папку профиля создаёт кнопка «🌐 ЛК» ровно под
  этим именем. Локально, без сети, подцепить чужой аккаунт не может (имя выведено из id самой
  записи). Зачем: на свежей машине (обновился, ЛК налогинил, про кнопку сопоставления не знает)
  точный баланс молча деградировал в «~ прикидку» с причиной «профиль не сопоставлен». Найденная
  метка закрепляется в пуле при первом успешном чеке (`profileUsed` → `newapiApplyBalance`).
- **Защита от рейт-лимитов.** У agentrouter перед API стоит Aliyun WAF: при частых запросах он
  отдаёт JS-заглушку **с кодом 200 вместо JSON**, у tabitoken `/auth/refresh` отвечает 429.
  Поэтому: запросы к хосту идут через шлюз частоты (`hostGate`, пауза 900мс, у agentrouter 2500мс),
  первый же отказ включает **остывание хоста на 10 минут** (остальные аккаунты пачки мгновенно
  уходят в резерв), а **ретраев нет сознательно** — они только продлевают блокировку.
  Плюс переиспользование: если прошлый `self` был < 20 мин назад и расход не сдвинулся,
  точная цифра берётся из кеша (`selfCheckedAt` / `usageSpentAtSelf`) и на шлюз не идём.
- **Кеш точной цифры и его инвалидация** (2026-08-18). «Расход не сдвинулся» перестало быть
  признаком «остаток тот же»: чек-ин и пополнение поднимают `quota`, не меняя `used_quota`.
  Ловилось живьём — после чек-ина на +$25 дашборд 15 минут показывал прежние `$175` с бейджем
  ⚡ точный, тогда как `/api/user/self` отдавал `$200`, и вписанные вручную `$200` этой же
  стряпнёй перебивались. Поэтому кеш снимается двумя путями:
  - `force` — явный клик по цифре (`GET /api/{ar,go,tb}/balance` без `nudge=1`) и любой
    `set-balance`: пользователь сравнивает с ЛК прямо сейчас. Тик статусбара (`nudge=1`)
    и батч «Балансы всех» остаются на кеше — это защита от WAF, а не экономия ради экономии;
  - **отметка визита в ЛК** (`newapiLkVisited` / `newapiLkOpenedAt`): открытие ЛК записывает
    метку профиля, и `self`-кеш, снятый раньше визита, больше не переиспользуется.
  `arBalanceOnce` хранит в карте in-flight не промис, а `{p, force}` — форсированный чек не
  подхватывает уже летящий мягкий, иначе клик снова вернул бы цифру из кеша.
- **Keepalive длинных батчей** (`jsonKeepalive`, 2026-08-18). «Балансы всех» и «🔗 Профили»
  считают минутами (шлюз частоты сериализует запросы, а неотвечающий хост съедает по 15с на
  fetch) и до конца молчат. Такое молчание рвут веб-антивирусы с MITM на localhost, расширения
  и корп-прокси — в браузере это `TypeError: Failed to fetch`, хотя расчёт шёл нормально и уже
  лёг на диск. Лечение: спустя 4с отдаём заголовки и капаем по пробелу каждые 5с (ведущие
  пробелы легальны в JSON, разбор на фронте не меняется). Капаем **лениво**, чтобы ранние отказы
  сохранили честный код 500; поздняя ошибка уходит с кодом 200 и полем `error` — поэтому в
  дашборде обязателен guard `if (!res.ok || data.error)`. `jsonRes` терпит уже начатый ответ.
- Кеш — прямо в `{agentrouter,gorouter,tabi}-sessions.json`: `spent/balance/balanceSource/granted/
  balanceAnchor/anchorSpent/selfCheckedAt/balanceCheckedAt`. `balanceCheckedAt` штампуется при
  **любом** исходе (иначе статусбар долбит обновление на каждом промпте), причина недоступности
  точной цифры — в `selfError`.
- **Вписать баланс**: `POST /api/{ar,go,tb}/set-balance {api_key, balance}` → `newapiSetBalance`.
  `balance = null` сбрасывает привязку. Заменило собой `set-grant` / `add-bonus` / `add-referral`:
  три ручки (выдача + «+25» чек-ин + «+100» рефка) описывали одно число, требовали проклика
  после каждой траты и разъезжались до минусов (`−$7.40` у GoRouter). Старые поля
  `grantManual/bonus/referral/grant/grantSource` при загрузке просто **удаляются**
  (`newapiMigrateAnchors`), в анкер НЕ сворачиваются: анкер из них был бы выведен из того же
  сломанного угадывания и подставлялся бы вместо точной цифры при каждом рейт-лимите —
  именно так Tabi показывала `−$4.37` там, где в аккаунте лежало `$6.63`. Анкер бывает только
  вписанный руками, а если расход его обогнал (остаток ≤ 0) — запись честно уходит в «прикидку».
- UI: `newapiBalanceCell()` (одна на три вкладки) — сумма + бейдж источника + кнопка «✏️ вписать».
  Пороги цвета **абсолютные** (≥$20 emerald, ≥$5 amber, ниже crimson): при точном балансе гранта
  нет и брать долю не от чего. Отрицательное показывается как `$0.00` с подсказкой «привязка
  устарела». Статусбар (`gauge_from_balance_cache`) знаменатель шкалы берёт как
  `granted` → `balanceAnchor` → легаси `grant+bonus+referral`.
- **Причина «нет точной цифры» — читаемая, без доступа к машине** (2026-08-18). `cookieFailReason`
  в `newapi-account.js` различает: не собран `better-sqlite3` (нативный модуль, на свежей машине
  самая частая причина → `npm rebuild better-sqlite3`), нет БД куки в профиле, не расшифровался
  DPAPI-ключ, куки хоста в профиле нет. Текст уезжает в `selfError` → подсказку бейджа `~`.
  Плюс: прокси при старте громко пишет строку про несобранный модуль (`cookieBackendReady`),
  а тост батча называет самую частую причину (`balanceBatchToast`) — раньше он рапортовал
  «посчитано N» и причина не читалась ниоткуда.

### Кнопка «🌐 ЛК» — рефка для новых, баланс для рабочих (общее для ar/go/tb)

- `POST /api/{ar,go,tb}/session/open {id}` → `handle{Ar,Go,Tb}SessionOpen`: спавнит
  `<provider>/open-session.js <label> <mode>` detached + `unref()`, видимый Chromium
  с **персональным профилем** `<provider>/profiles/<label>/` (`label = acct_<id>` —
  стабильный, смена ключа и переименование не рвут профиль).
  `launchPersistentContext` сам пишет куки+localStorage+GitHub-OAuth на диск.
- **`mode` считает сервер по ключу аккаунта** (`isRealKey()` — настоящий ключ у всех
  трёх NewAPI-провайдеров это `sk-` + 48):
  - ключа нет (заглушка `no-key-…`) → `register` → **реф-ссылка владельца**:
    `agentrouter.org/register?aff=oUm3`, `gorouter.app/sign-up?aff=dzj0`,
    `tabitoken.com/sign-up?aff=cUG3`;
  - ключ есть → `console` → страница баланса: `agentrouter.org/console/topup`
    (там же чек-ин +$25), `gorouter.app/wallet`, `tabitoken.com/wallet`.
  - `mode` уходит в ответ (`{mode}`) и в `logLine` — дашборд по нему выбирает тост,
    в Server Logs видно `session/open: … mode=register|console`.
  - При запуске скрипта руками режим по умолчанию `auto`: чистый профиль = `register`.
    Импортированный share-код всегда `console` — аккаунт друга уже зарегистрирован.
- **Реф-ссылки захардкожены в двух местах** (править парой): `REGISTER_URL` в
  `<provider>/open-session.js` и `href` в шапке/футере вкладки `proxy-dashboard.html`
  (заголовки вкладок ведут на регистрацию по рефке, а не на корень сайта — чтобы
  новый пользователь дашборда регистрировался по рефке владельца).
- **Порядок навигации при регистрации** (`openRegisterViaRef`, переписан 2026-08-18): на
  happy path — **одна** навигация по реф-ссылке. Реф-код все три сайта (NewAPI) держат в
  `localStorage.aff` и сажают его с первого захода (проверено в логе: `aff=dzj0` через 4с
  после старта), а страница регистрации на чистом профиле рисуется без прогрева корня.
  Прежняя схема «рефка → корень → рефка» давала ~11 секунд метания страницы, которое
  пользователь видел как «дрочь», и рвала OAuth-state, если сайт сам уезжал на GitHub-вход.
  Корень прогревается **только** если код с первого раза не осел, и заход прерывается,
  как только URL ушёл на `github.com` (`↪️ сайт сам ушёл на GitHub-вход`). Лог: `🤝 реф-код
  сохранён в профиль: aff=…` (или `…со второй попытки`).
- **После GitHub-логина — `settleAfterLogin()`**: сайт часто отвечает
  «failed to get user information», и лечится это обновлением страницы. Скрипт сам делает
  `reload`, проверяет текст ошибки на странице и до двух раз перезаходит по реф-ссылке.
  Если ошибка осталась — честно пишет «обнови страницу вручную (F5)», а не рапортует успех.
  Ветка `register` ждёт логина **независимо от свежести профиля**: упавшая первая попытка
  оставляет профиль непустым, а аккаунт — всё ещё без ключа.
- Dedup: `{ar,go,tb}LkPids` (label → pid), повторный клик при живом pid → `{already:true}`,
  второй браузер не плодится.
- **HTTP-кеш профиля выключен (`disableHttpCache`, 2026-08-17)** — иначе один-единственный
  404 на бандл SPA (`/assets/index-<hash>.js`, деплой сайта или затык WAF) оседает в кеше
  профиля навсегда: браузер открывается, логин и куки живые, а страница **белая** на каждом
  открытии (поймано на `lovingfairy`/`lankymapping`; с `Network.setCacheDisabled` тот же
  профиль отрисовал баланс сразу). Ставится через CDP на первую вкладку и на все новые
  (`context.on('page')`), профиль/сессию не трогает. Чистить `Default/Cache` руками не надо.
- **`reportRender(page)`** после захода в консоль пишет в Server Logs
  `✅ страница отрисовалась` либо `⚠️ белый экран: SPA не поднялась` — белый экран больше
  не выглядит как «успешно открыл». Проверка: `#root` набрал >200 символов за 15с.
- **GoRouter, регистрация: ответ сайта вместо «дрочи» (2026-08-17)** — `gorouter/open-session.js`
  разбирает, что сайт написал на странице (`SITE_ERRORS` + `siteError()`), а не ждёт молча:
  - `failed to fetch git token` — GitHub-код одноразовый, а `settleAfterLogin()` делал `reload`
    **на колбэке** `/oauth/github?code=…` и тратил его второй раз. Теперь на колбэке
    (`OAUTH_CALLBACK_RE`) вместо F5 уход на `CONSOLE_URL`; в логе — «code уже потрачен,
    жми "Продолжить с GitHub" заново».
  - `State parameter is empty or mismatched` (сайт отдаёт 403 на `/api/oauth/github`, проверено) —
    состояние OAuth рвали лишние навигации: `openRegisterViaRef()` больше **не перебивает**
    редирект, если страница сама уехала на `github.com`.
  - **Регистрация закрыта** (`new registration disabled by administrator` / `管理员关闭了新用户注册` /
    русская локаль) — `terminal: true`: скрипт печатает «❌ регистрация закрыта администратором»
    и не висит 10 минут в `waitForLogin`, браузер оставляет открытым с ответом сайта.
    `waitForLogin()` теперь возвращает `{ok, err}`.
- `stdio: 'pipe'` + ретрансляция stdout/stderr скрипта в `logLine()` — ошибки видны в Server Logs.

### Аккаунт без ключа (`status: no_key`) — общее для ar/go/tb

Регистрация у всех трёх ручная через GitHub, и ключ появляется только после неё.
Поэтому `POST /api/{ar,go,tb}/add` принимает **пустой `api_key`**: вместо ключа кладём
уникальную заглушку `makeNoKeyStub()` = `no-key-<base36>` (уникальность обязательна —
`api_key` служит идентификатором в кликах активации/баланса, а `add` отбивает дубли).
Ответ `{ok, id, noKey}`; дашборд при `noKey` сразу открывает 🌐 → регистрацию по рефке.

- `add` → `status: 'no_key'`; `set-key` с настоящим `sk-…` снимает `no_key` → `unknown`.
- Guard'ы в одном месте на провайдера: `{ar,go,tb}Probe()` → `'no_key'`,
  `{ar,go,tb}Balance()` → `{status:'no_key'}`. Это закрывает сразу батчи
  `?probe=1`/`?balance=1`, `ping`, `balance`, `set-grant`, `add-bonus`, `add-referral` —
  иначе заглушка летела в `/v1/models`, получала 401 и красила свежий аккаунт в 🔴 DEAD.
- `{ar,go,tb}ApplyBalance()` при `no_key` не ставит `balanceError` и `balanceCheckedAt`:
  иначе гейдж пула зажигал «⚠ ошибка чека».
- `activate` на безключевом аккаунте → 400 (иначе заглушка уехала бы в
  `~/.claude/{ar,gorouter,tabi}-active-key.txt` и положила активный бэкенд).
- UI (`renderAr/renderGo/renderTb/renderXp`): вместо кнопки-ключа плашка «🔑 получи API-ключ
  после регистрации», статус `⚪ нет ключа`, баланс `—`, кнопки 📋/🤝/🩺 скрыты
  (остаются 🔑 ✏️ 🌐 🗑 🔗). Клиентский `isRealKey()` — зеркало серверного.
  Старые заглушки, вписанные руками (`"1"`, `"2"`, `"3"`), под правило попадают
  автоматически — миграция данных не нужна.
  Плашка — **`noKeyCell(onclick)`**, кликабельна целиком и вызывает то же, что кнопка 🔑
  (`{ar,go,tb,xp}SetKey`): у безключевого аккаунта это единственное осмысленное действие,
  а тянуться мышью через всю строку к иконке 6×6 px незачем. Одна функция на 4 вкладки;
  была константа `NO_KEY_CELL` без обработчика.

---

## GoRouter (go) — GitHub-вход, SSE keepalive :20156

Пул в `routing/gorouter-sessions.json`. Активация/работа — через **SSE keepalive `:20156`**
(второй экземпляр `keepalive-proxy.js`, форвард в `https://gorouter.app`, режет `[1m]`-суффиксы,
count_tokens fallback, держит SSE-паузы thinking-моделей). Ключ пишется литералом в
`ANTHROPIC_AUTH_TOKEN`, модель из `~/.claude/gorouter-active-model.txt`.

- **GitHub-вход в консоль** — `gorouter/open-session.js` (персональный профиль
  `gorouter/profiles/<label>/`), там же чек-ин бонуса. Ключа нет → открывается
  регистрация по рефке `gorouter.app/sign-up?aff=dzj0`, есть → `gorouter.app/wallet`
  (см. «Кнопка 🌐 ЛК» и «Аккаунт без ключа» в разделе AgentRouter).
- **Баланс** — `balance = grant + bonus − spent`. Сервис отдаёт только `total_usage` (центы).
  База выдачи `GO_DEFAULT_GRANT = 70`, шаг бонуса `GO_BONUS_STEP = 5` (кнопка «+5»),
  ручная выдача `grantManual` (✏️). Кеш: `spent/grant/bonus/balance/balanceCheckedAt` прямо
  в `gorouter-sessions.json` (`goBalance()` / `goApplyBalance()`).
- **Маппинг claude-тиров** — `routing/gorouter-modelmap.json`, применяется keepalive по mtime.
- **Share / import** — `gorouter/share-session.js` (🔗) / импорт из буфера (📥).
  Код = `base64url(JSON { v:1, provider, email, name, api_key, meta, session })`, где
  `meta` — цифры аккаунта (`grant/grantManual/grantSource/bonus/spent/balance/status/
  accessUntil/balanceCheckedAt/created/referral`), поэтому у получателя аккаунт появляется
  с той же выдачей и балансом, а не пустым. Белый список `SHARE_META_FIELDS` в
  `transparent-proxy.js` (общий для ar/go/tb): `active/id/api_key/ghId` из чужого кода
  не применяются. `v` остаётся `1` — поле аддитивное, старые дашборды его игнорируют.
  Клиент всегда показывает код в окне `#share-code-modal` (авто-копия ненадёжна: код
  приходит через ~7 с после клика, user gesture к тому моменту истёк).

---

## Tabi Token (tb) — GitHub-вход, SSE keepalive :20155

Пул в `routing/tabi-sessions.json`. Активация/работа — через **SSE keepalive `:20155`**
(как gorouter, форвард в `https://tabitoken.com`, БЕЗ `/v1` на корне usage). Ключ литералом
в `ANTHROPIC_AUTH_TOKEN`, модель из `~/.claude/tabi-active-model.txt`.

- **GitHub-вход в консоль** — `tabi/open-session.js` (профиль `tabi/profiles/<label>/`).
  Ключа нет → регистрация по рефке `tabitoken.com/sign-up?aff=cUG3`, есть →
  `tabitoken.com/wallet` (см. «Кнопка 🌐 ЛК» и «Аккаунт без ключа» у AgentRouter).
- **Баланс** — `balance = grant + bonus − spent`. Дефолт выдачи `TB_DEFAULT_GRANT = 100`,
  реф-бонус `TB_BONUS_STEP = 20` за приведённого, ручная выдача `grantManual` (✏️).
  Кеш в `tabi-sessions.json` (`tbBalance()` / `tbApplyBalance()`).
- **Маппинг claude-тиров** — `routing/tabi-modelmap.json`, применяется keepalive по mtime.
- **Share / import** — как у gorouter.

---

## XPeach (xp) — New-API «🍑 Code», SSE keepalive :20157

Пул в `routing/xpeach-sessions.json`. Активация/работа — через **SSE keepalive `:20157`**
(четвёртый экземпляр `keepalive-proxy.js`, форвард в `https://xpeach.codes`, БЕЗ `/v1`).
Ключ литералом в `ANTHROPIC_AUTH_TOKEN`, модель из `~/.claude/xpeach-active-model.txt`.

Разведка живыми пробами 2026-08-18 (`/api/status`, `/v1/models`, `/v1/messages`,
`/api/user/auth/refresh`) — вкладка сделана **клоном Tabi**, потому что все ключевые
свойства совпали:

| Свойство | Значение | Следствие |
|---|---|---|
| Схема New-API | кука `new_api_refresh` на пути `/api/user/auth` → JWT | `HOST_AUTH['xpeach.codes']='jwt'`, как tabitoken rc.23 |
| Anthropic-эндпоинт | `/v1/messages` → **200** (haiku ответил) | keepalive форвардит claude-* нативно, конвертер `:20132` не нужен |
| `quota_per_unit` | 500000 (стандарт) | арифметика `newapiBalance()` без правок |
| Валюта | `custom_currency_symbol: 🍑`, `custom_currency_exchange_rate: 1` | цифра та же, что была бы в $ — меняется **только символ** |
| Живость ключа | `/dashboard/billing/usage` на корне → `total_usage` (центы) | как у ar/go/tb |
| Чек-ин | `checkin_enabled: false` | кнопки «+$25» нет |
| Вход | GitHub OAuth + passkey + Google + email/пароль (`email_verification`, turnstile) | `xpeach/open-session.js` идёт GitHub-путём |

- **Валюта 🍑 в UI** — `newapiBalanceCell(s, kJ, prov, sym)` получил четвёртый
  необязательный параметр (дефолт `'$'`), вкладка передаёт `XP_SYM = '🍑'`. Форк общей
  ячейки ради символа делать не стали: курс к единице квоты тот же, врать долларом —
  единственное, чего нельзя. В «Общий запас» цифры складываются без пересчёта.
- **GitHub-вход в консоль** — `xpeach/open-session.js` (профиль `xpeach/profiles/<label>/`).
  Ключа нет → регистрация по рефке `xpeach.codes/sign-up?aff=0lre`, есть →
  `xpeach.codes/console/topup` (см. «Кнопка 🌐 ЛК» и «Аккаунт без ключа» у AgentRouter).
  Маршруты взяты из бандла SPA (`/static/js/index.<hash>.js`), не угаданы: там же
  `/console/token` — страница, где берётся сам ключ.
- **Каталог 32 модели.** 8 claude (`claude-fable-5`, `opus-4-6/4-7/4-8/5`, `sonnet-4-6/5`,
  `haiku-4-5-20251001`) помечены `anthropic+openai` — ходят через keepalive. Остальные
  (grok-*, gpt-5.x, `gpt-image-*`, `grok-imagine-video`) — `openai`-only, на вкладке
  помечены бейджем `openai`: keepalive их не отдаст. Владелец каталога — китайский
  реселлер (`owned_by: Claude｜Max 号池`).
- **Резерв «угадать грант»** — `XP_DEFAULT_GRANT = 10`, `XP_GRANT_STEP = 10` (выдача
  нового аккаунта 10 🍑). Работает только когда точная цифра недоступна.
- **Маппинг claude-тиров** — `routing/xpeach-modelmap.json`, применяется keepalive по mtime.
  **Дефолт — «как есть» (все три тира пустые)**, и это принципиально: клон Tabi унёс с собой
  и его маппинг (`opus → claude-opus-5`), из-за чего вкладка молча подменяла выбранную в
  списке модель на ту, которой на шлюзе нет канала. Пустое значение → `tierTargetFor()`
  отдаёт `null` → наверх уходит ровно выбранная модель. Ставить цель — только осознанно:
  маппинг **перебивает** выбор модели, а не дополняет его.
- ⚠️ **`claude-opus-5` на xpeach.codes нерабочая.** Каталог её показывает, канала под неё в
  группе `Claude｜Max 号池` нет: сперва `403 {"type":"bad_response_status_code","message":
  "Insufficient account balance"}`, после того как New-API отключил канал за hard-ошибку —
  `500 分组 Claude｜Max 号池 下模型 claude-opus-5 的可用渠道不存在` (живые пробы 2026-08-19, 2/2).
  **`Insufficient account balance` — это счёт РЕСЕЛЛЕРА внутри канала, а не наши 🍑**: та же
  проверка при живом ключе даёт `gpt-5.4-mini` → 200, `/dashboard/billing/usage` →
  `total_usage: 0`. Живые claude-модели, TTFB 3–5 с: `opus-4-8`, `opus-4-7`, `opus-4-6`,
  `sonnet-5`, `fable-5`, `haiku-4-5-20251001`; `sonnet-4-6` висел >90 с. Разовый таймаут на
  40 с — холодный канал, а не смерть (с `-m 90` те же модели отдают 200).
  На вкладке битые модели перечислены в `XP_DEAD_MODELS` (`proxy-dashboard.html`): бейдж
  `💀 нет канала` в списке моделей и в селектах маппинга + `confirm()` при попытке применить.
  Побочное: 403 с текстом `balance` не попадает в `RETRY_NO` прокси (там `billing|quota`),
  поэтому мёртвый канал ретраится `maxAttempts` раз — ~3.5 с пустой молотилки на запрос.
- **Share / import** — как у tabi/gorouter (`provider: 'xpeach'` в payload).
- ⚠️ **`:20157` НЕ в списке KILLPORT** у `start-switcher.bat` / `restart-dashboard.bat` —
  ровно как `:20155`/`:20156`. Автоспавна у них нет (boot-спавнится только `:20133`),
  поэтому убийство порта оставило бы активный бэкенд без слушателя. Рестарт — кнопкой
  в Health или `keepalive-restart.ps1 -Port 20157`.
- ⚠️ **В статуслайне правило `:20157` стоит ДО catch-all Custom-конвертеров**
  (`*localhost:2015[0-9]*` → `custom`), иначе xpeach определялся бы как Custom.

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

Скрипт-cтрока cнизу CLI: `provider/model │ $217.33~ │ ⧉ 139k/1M`.
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
- **Квота для `agentrouter` / `tabi` / `gorouter`** — одна функция
  `gauge_from_balance_cache()` в скрипте: читает блок активного ключа
  (`~/.claude/{ar,tabi,gorouter}-active-key.txt`) из
  `{agentrouter,tabi,gorouter}-sessions.json`, `$ = balance` (дашборд уже посчитал
  grant+bonus−spent). Lazy-refresh при протухании >90с: fire-and-forget
  `GET /__switch/api/{ar,tb,go}/balance?api_key=…`.
- **Денежный блок** — доcтупная cумма активного аккаунта. `~` означает уcтаревший
  кеш; `⏳` c оcтавшимcя временем означает cooldown FreeModel.
- **Контекcтное окно** (`⧉ 139k/1M`) — из stdin-payload Claude Code
  (`total_input_tokens`/`context_window_size`, CC ≥2.1.132). Токены показываютcя
  вмеcто cломанного `0%`. Еcли gateway не передал input usage (ноль при ненулевом
  `context_window_size`), statusline выводит `⧉ ?`, а не ложное `0/<окно>`.
  Еcли токены отcутcтвуют, но Claude Code дал ненулевой процент, иcпользуетcя
  fallback `⧉ N%`. `⚠` означает, что FreeModel получил урезанное до 200k окно без `[1m]`.
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
`.freemodel_quota_cache.json` → **данные дашборда обновляютcя автоматичеcки**
(тот же файл). Пока cвежие данные не пришли — cумма приглушаетcя и помечаетcя `~`.

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

## GitHub аккаунты (🐙) — карточки с локальным TOTP

Хранилище **купленных** GitHub-аккаунтов. Вставка строкой
`Логин:Пароль:2FA-секрет:Recovery codes:Ник` (импорт пакетом или один вручную).

- Данные: `routing/github-accounts.json` (gitignored, пример `github-accounts.example.json`).
  Поле аккаунта: `{id, login, password, totpSecret, recoveryCodes[], nickname, status, note, added}`.
- Роуты: `/__switch/api/gh/{keys,add,import,delete,update,open}`. Хендлеры `handleGh*` +
  `ghLoad/ghSave` в `transparent-proxy.js`. Пароль/секрет/коды **никогда не логируются**.
- **TOTP — локально в браузере** (`ghComputeTotp` в `proxy-dashboard.html`):
  base32-декод + `crypto.subtle` HMAC-SHA1, 6 цифр, период 30с (RFC 6238).
  Никаких сайтов двухфакторки. Кеш на окно (`ghTotpCache`), тик 1с перерисовывает
  countdown-бар (teal → amber <10s → crimson <3s) и подменяет код на перевале окна.
  Проверено против 2fa.online — коды совпали (секрет — стандартный base32 TOTP).
- **Парсер строки** устойчив к `:` внутри пароля: последние 3 части справа =
  ник / recovery (`,` или пробелы) / 2FA-секрет, остаток между логином и секретом —
  пароль. Ошибка → crimson-блок с указанием поля, пароль/секрет в диагностику не выводятся.
- **Статус** — ручной (меню карточки: live/cooldown/dead), авто `error` при битом
  секрете. Авто-проверки живости GitHub нет (безопасного способа нет).
- **Профиль браузера на аккаунт:** «Открыть GitHub» → `POST /api/gh/open {id}` спавнит
  `github/open-session.js <label>` (`label = acct_<id>`, стабильный — переименование не
  рвёт сессию), персистентный профиль `github/profiles/acct_<id>/`. Dedup по pid
  (`ghLkPids`), второй клик при живом браузере → `{already:true}`. Профили gitignored.

### Заселение готовой GitHub-сессии в новый аккаунт New-API (ar/go/tb/xp)

Кнопка **«🐙 Взять готовый GitHub»** в форме `➕ Добавить` всех четырёх New-API-вкладок:
аккаунт создаётся сразу, а его профиль браузера получает уже живую GitHub-сессию —
логин/пароль/2FA вводить не нужно, остаётся нажать «Continue with GitHub».

**Зачем.** У каждого аккаунта свой персистентный профиль Chromium, а профили куками не
делятся: в свежей папке github.com «не видели», поэтому GitHub требует полный вход. При
этом нужная сессия почти всегда уже лежит в профиле другого провайдера. Замер
2026-08-19: **41 профиль с GitHub-сессией на 14 уникальных аккаунтов**
(`presentkid`/`impeccableso`/`exhaustedar` — по 5 папок каждый, 1.87 ГБ).

**Поток.** Переиспользует проверенную механику share-кодов, не изобретая новую:

```
профиль-источник (любой из */profiles/*)
   │  github/harvest-session.js <profileDir> <out>   headless storageState, ТОЛЬКО github.com
   ▼
github/sessions/<ghId>.json          кеш снимка, TTL 7 суток (gitignored)
   │  POST /api/{ar,go,tb,xp}/add-github {ghId}      newapiAddGithub
   ▼
<provider>/sessions/acct_<id>.json   { seed:'github', ghLogin, cookies, origins }
   │  <provider>/open-session.js → applyImportedSession → context.addCookies
   ▼
<provider>/profiles/acct_<id>/       свежий профиль, GitHub уже залогинен
```

- Роуты: `GET /api/gh/available?host=<host>` (список с пометками) +
  `POST /api/{ar,go,tb,xp}/add-github`. Общий хендлер `newapiAddGithub` + 4 обёртки, как у
  `newapiMapProfiles`. Модуль индекса — `routing/lib/github-session.js`, сборщик —
  `routing/gh-index-build.js` (отдельный процесс, см. грабли 6).
- Дашборд: одна модалка `#gh-seed-modal` на все вкладки (`newapiSeedPick(prov)` →
  `newapiSeedLoad()` → `newapiAddGithub(ghId)`), провайдер помнится в `ghSeedProv`. Браузер
  после создания открывает существующий `/session/open` — spawn-логика не дублируется.
- `email` записи = **ник GitHub** осознанно: резервная ветка `newapiMapProfiles` сверяет
  `s.email || s.name` с `githubLogin(cookies)` (кука `dotcom_user`, а это и есть ник), так
  что связка профиль↔запись проставляется сама.
- **Связки «аккаунт ↔ профиль» нигде не хранится**, она вычисляется: ник из
  `github-accounts.json` сверяется с кукой `dotcom_user` внутри каждого профиля. Имена папок
  (`acct_ar_…`) в сопоставлении не участвуют, поэтому переименование и перенос ничего не
  рвут. Плата за это — единственная хрупкость: если `nickname` расходится с настоящим
  юзернеймом GitHub, в списке будет «сессии на диске нет», хотя она есть.
- Ручная кнопка «Сохранить» в той же форме **никакого GitHub не подключает** — вписать ник
  в поле email недостаточно, заселение делает только кнопка 🐙 (ловились на этом).

**Грабли:**

1. **Фильтр `github.com` в снимке — обязателен, не косметика.** Профиль-источник почти
   всегда чей-то провайдерский, и его `session`/`new_api_refresh` в снимке не нужны: в
   лучшем случае утекут в чужой профиль, в худшем — если источник с ТОГО ЖЕ хоста —
   залогинят в **уже существующий** аккаунт вместо создания нового.
2. **Маркер `seed:'github'` в файле сессии.** Без него `open-session.js` принимает файл за
   share-код друга («аккаунт уже зарегистрирован»), уходит на `CONSOLE_URL` и **пропускает
   регистрацию по рефке** — реф-кредит теряется. Поле аддитивное: старые коды друзей без
   `seed` работают как раньше.
3. **Один GitHub на том же хосте = вход в старый аккаунт**, а не новый. Занятость считаем
   по куке `dotcom_user` в `<host>/profiles/*` (не по `ghId` — он есть только у AR), такие
   пункты в списке заблокированы. Метка самоподдерживающаяся: заселённый профиль сам
   попадает в следующий скан — но **с задержкой**: Chromium держит банку кук в памяти и
   пишет её на диск только при закрытии, поэтому сразу после заселения `usedHere` ещё
   `false`. Вторая линия защиты на этот зазор — проверка дубля по `email` (= нику GitHub)
   в самом `newapiAddGithub`, она срабатывает мгновенно.
4. **Живость GitHub-сессии проверять ТОЛЬКО настоящим браузером.** Сырой `https.request` с
   самодельным `User-Agent` GitHub считает угоном и гасит сессию: 2026-08-19 так были убиты
   `impeccableso`/`serpentinesep`/`lankymapping` (сначала 200, через 25 минут 302 → `/login`),
   а не тронутые пробой `faithfulpho`/`presentkid` остались живы. Поэтому проверки в
   `lib/github-session.js` нет вообще, а вердикт выносит `harvest-session.js` навигацией на
   `/settings/profile` — он всё равно открывает профиль ради снимка. Код выхода 3 = мертва.
   Балансовый чекер New-API куки сырым запросом шлёт спокойно: там авторизация к UA не
   привязана, запрет касается именно github.com.
5. Дублирование профилей (одна сессия в 3–5 папках) оказалось не только мусором, но и
   резервом: у всех трёх убитых аккаунтов живая сессия нашлась в другом профиле, и
   `newapiAddGithub` перебирает источники по очереди именно поэтому.
6. **Скан профилей стоит DPAPI, поэтому его НЕТ в пути запроса.** `profileAesKey` поднимает
   процесс PowerShell на КАЖДЫЙ профиль, и вызов **синхронный** — он блокирует событийный
   цикл, то есть дашборд не отвечает НИ НА ЧТО, пока идёт скан. На 48 профилях это 30
   секунд; на элевированном процессе (`restart-dashboard.bat` поднимает дашборд от
   администратора) он однажды не вернулся вообще: `:8200` слушал, соединения копились в
   `CLOSE_WAIT`, `/api/logs` тоже молчал, а в `tasklist` из обычной консоли ни node, ни его
   powershell даже не видны. Поэтому:
   - индекс строит **отдельный процесс** `routing/gh-index-build.js`
     (`ghRebuildIndex()` спавнит его detached, `--force` — перечитать всё);
   - дашборд только читает JSON: `indexInfo()` / `profilesFromIndex()` /
     `indexOutdatedDirs()` (последняя — чистый `stat`, без расшифровки). **3 мс.**
     `indexByLogin()` по умолчанию берёт индекс с диска, а не свежий скан;
   - индекса нет → `/api/gh/available` отдаёт `building:true` и **не ждёт**; модалка
     показывает «строю индекс профилей» и переспрашивает раз в 1.2 с (до 12 раз);
   - `ghWarmIndexOnBoot()` запускает сборку через 1.5 с после старта.
   Кеш индекса — `github/sessions/_profile-index.json`, годность по **mtime файла
   `Default/Network/Cookies`**: DPAPI платится один раз в жизни профиля.
   Замеры: сборка с нуля **734 мс**, повторная **6 мс**, ответ эндпоинта **8–92 мс**.
7. **`-args` не работает с `powershell -Command`** (только с `-File`). Ловушка стоила
   получаса: `$args[0]` оказывался пуст, `ReadAllLines('')` падал, `warmAesKeys` молча
   откатывался на процесс-на-профиль — 30 с вместо 0.7 с, и в логе ни слова. Теперь путь к
   файлу блобов вклеен в саму команду (кавычки удвоены), а ошибка батча **не глушится**:
   `gh-index` пишет в Server Logs `⚠️ DPAPI-батч упал: …`. Мораль общая: молчаливый откат на
   медленный путь неотличим от зависания.

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

## Перенос папки репо (можно куда угодно)

Внутри репо абсолютных путей нет: все скрипты считают корень от своего файла
(`__dirname` / `Path(__file__)` / `%~dp0` / `$PSScriptRoot`), `tgbot` берёт корень
от себя (`DEFAULT_CWD` пустой = корень репо, битое значение игнорируется),
`freemodel/lib` и `internal/*` подключаются относительными require. Порты не
зависят от пути.

Снаружи репо остаются ссылки, которые переезд ломает:

| Что | Где | Кто чинит |
|---|---|---|
| `statusLine.command` → `routing/statusline-autoreger.sh` | `~/.claude/settings.json` | дашборд сам при старте (`healStatuslinePath`, бэкап в `settings-backups/`) |
| ключ проекта + `githubRepoPaths` | `~/.claude.json` | `tools/fix-paths-after-move.ps1` |
| история сессий и **память агента** (`memory/`) | `~/.claude/projects/<слаг-пути>/` | тот же скрипт (переименовывает каталог; слаг = путь, где всё не-буквенно-цифровое → `-`) |
| `DEFAULT_CWD` | `tgbot/.env` | тот же скрипт (обнуляет) |
| `tools/tg-venv` | venv помнит место создания | тот же скрипт (проверяет импорты, при поломке пересобирает по `tools/tg-venv-requirements.txt`) |

Порядок: погасить сервисы (папку держат cwd процессов — дашборд `:8200`,
конвертеры `:20126/20130/20131/20132`, keepalive `:20133/20155/20156`; последний
обслуживает Claude Code, поэтому переносить из обычного терминала, а не из-под CC)
→ переместить папку → `powershell -NoProfile -ExecutionPolicy Bypass -File
tools\fix-paths-after-move.ps1` (есть `-DryRun` и `-OldPath`) →
`routing\restart-dashboard.bat`.

Мелочь про длину пути: самые глубокие файлы — профили браузера в
`freemodel/lib/camoufox_*_profile_*` (одноразовые, gitignored, вместе дают
десятки ГБ). Перед переносом их проще снести — и MAX_PATH не упрётся, и копирование
станет быстрым.

## macOS: обёртка-совместимость (ноль правок Windows-кода)

Дашборд рассчитан на Windows, но весь функционал (ключи ar/go/tb, балансы,
добавление аккаунтов, ЛК-браузеры) работает и на Mac друга через **обёртку**:
дополнительные файлы в репо, существующий код не тронут.

**Почему это работает.** Весь Windows-код в дашборде сводится к:
`netstat -ano` + `taskkill /F /PID` (в try/catch, парсинг по regex
`:PORT\s+\S+\s+LISTENING\s+(\d+)` — transparent-proxy.js ~3487/3295/7573,
keepalive-spawn.js:23) + `sqlite3` + `python` + `curl.exe`/`clip.exe`.
Обёртка подменяет их **shim-ами в PATH** и env `SQLITE3=/usr/bin/sqlite3` —
код начинает работать на macOS без единой правки.

| Файл | Роль |
|---|---|
| `mac-support/shims/netstat` | эмитит Windows-формат из `lsof -nP -iTCP -sTCP:LISTEN` (BSD sed, без gawk) |
| `mac-support/shims/taskkill` | `/F /PID N` → `kill -9 N`, `/F /IM x` → `pkill -9 -x x` |
| `mac-support/shims/curl.exe`, `clip.exe`, `python`, `python.exe` | прокладки на curl/pbcopy/python3 |
| `routing/restart-dashboard.sh` | аналог `restart-dashboard.bat`: чистит 8 портов через `lsof -ti`, `PATH`+`SQLITE3`, старт fm-rot :20126 / fm-oa :20130 / vyce :20131 / transparent-proxy :8200, poll статуса, `open` UI |
| `install-mac.sh` | bootstrap (git → clone → `exec` себя из клона) → Xcode CLT → Homebrew → node/git → `npm install` → `npx playwright install chromium` → `npm i -g @anthropic-ai/claude-code` → копирует `*.example` → `chmod +x` + `xattr -cr` |
| `DASHBOARD.command` | двойной клик: `xattr -cr .` + `bash routing/restart-dashboard.sh` |
| `docs/MAC-SETUP.md` | инструкция для друга |

Установка одной строкой на голом маке (она же в README) — симметрично `install.ps1`:
`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/WormAlien/vibe-code-account-creator-manager/master/install-mac.sh)"`

Bootstrap-блок в начале скрипта: если рядом нет `package.json` и
`routing/restart-dashboard.sh` — значит запущено вне репо, ставим CLT (в них git),
`git clone` в `$PWD` (или `VCACM_DIR`), `exec bash <clone>/install-mac.sh`.
Путь скрипта берётся из `${BASH_SOURCE[0]:-$0}`: при `bash -c` он пуст, `$0` = `bash`,
`dirname` даёт `.` → cwd → уходим в bootstrap; при `bash install-mac.sh` — папка репо.

**Только `bash -c "$(curl …)"`, не `curl … | bash`:** при пайпе stdin занят телом
скрипта, и `read` (ожидание CLT, «запустить дашборд?») читает остаток скрипта
вместо ответа юзера. Так же бутстрапится Homebrew.

Нюансы:
- git с Windows **не хранит exec-bit** → `chmod +x` ставит `install-mac.sh`, а
  `restart-dashboard.sh` самовосстанавливает права на shim-ы при каждом запуске
  (node зовёт их через `execFile` напрямую, без шелла).
- Балансы AR/GO/TB — чистый HTTP через `keepalive-proxy.js`, там Windows-вызовов
  нет; OAuth Keychain macOS уже обработан кодом (transparent-proxy.js ~282-283).
- `better-sqlite3`/`node-pty` собираются на Mac автоматически (нужен Xcode CLT);
  `better-sqlite3` нужен для точного баланса (lazy require в newapi-account.js).
- Автореги (Camoufox/rebrowser/Telegram) — вне охвата обёртки, для сценария
  «свои аккаунты» не нужны.
- `.gitattributes`: `mac-support/shims/*` и `*.command` — строго `eol=lf`.
- **Две грабли чистого мака** (обе пофикшены, но не проверены на живом Darwin):
  `command -v git` **врёт** — `/usr/bin/git` есть всегда, но без CLT это shim,
  который лишь открывает диалог «установить инструменты разработчика» и падает.
  Годность git → `xcode-select -p`, не наличие файла. И установщик Homebrew
  **не кладёт brew в PATH**: на Apple Silicon это `/opt/homebrew/bin`, которого в
  дефолтном PATH нет → `brew install node` упал бы с `command not found`, а
  поставленный node не нашёлся бы потом в `DASHBOARD.command`. Функция
  `brew_shellenv()` делает `eval "$(brew shellenv)"` в сессию **и** дописывает
  строку в `~/.zprofile` (двойной клик `.command` → login-shell zsh → подхватит).

- **Точный баланс на macOS — своя схема куки** (замер на живом маке 2026-08-20,
  Chrome for Testing 148, Intel: 11/11 куки в 6 профилях). БД лежит в
  `Default/Cookies`, **не** в `Default/Network/Cookies` — путь проверяется по
  обоим (`cookieDbPath`). Ключ: `PBKDF2-SHA1('mock_password', 'saltysalt', 1003, 16)`,
  значение: `'v10'` + **AES-128-CBC**, IV = 16 пробелов, PKCS#7 (на Windows —
  DPAPI + AES-256-GCM). Пароль именно `mock_password`: Playwright стартует
  Chromium с `--use-mock-keychain`, и `MockAppleKeychain` отдаёт эту константу —
  ни `peanuts` (Linux-схема), ни Keychain-запись «Chromium Safe Storage» (на маке
  есть, но от другого браузера) не подходят. К Keychain код лезет только если
  дешёвые кандидаты не сработали: `security find-generic-password` поднимает
  диалог пароля в КАЖДОМ процессе (пробник + дашборд + keepalive'ы = 8 окон).
  Диагностика — `node tools/mac-cookie-probe.js` (перебирает матрицу
  пароль × итерации × шифр и печатает форму данных).
- **`git config core.fileMode false` обязателен на маке.** Права не едут с
  Windows (всё 100644), мы их доставляем `chmod`'ом — git видит 644→755 как
  локальную правку и `git pull` встаёт с «your local changes would be
  overwritten». Ставится в bootstrap после clone и при обычном запуске из репо.
- **`npm install -g` на маке падает с EACCES**, если npm-префикс системный
  (`/usr/local` — Homebrew на Intel): `claude` не ставится, юзер получает
  `command not found`. Установщик переносит префикс в `~/.npm-global` и
  дописывает PATH в `~/.zprofile`.

- **Статус-лайн не хранит путь к репо.** В `settings.json` прописан шим
  `~/.claude/autoreger-statusline.sh` (эталон — `routing/statusline-shim.sh`), а он
  читает актуальный корень из `~/.claude/autoreger-root.txt`. Указатель и копию
  шима перезаписывают `restart-dashboard.sh` и `restart-dashboard.bat` при каждом
  старте, поэтому перенос/переименование папки проекта лечится сам: остановил →
  перенёс → запустил из нового места. Прямой путь в `settings.json` ломался молча,
  а копия самого `statusline-autoreger.sh` в `~/.claude` окаменевала (репа
  обновляется, CC гоняет древний файл) — шим решает обе проблемы сразу. Если
  указатель битый, шим выходит с пустым выводом: непустой CC покажет прямо в баре,
  и ошибка на каждый рендер хуже пустой строки.
- **`routing/stop-dashboard.sh`** — на маке всё стартует через `nohup … &` и живёт
  в фоне, закрытие окна Terminal процессы не убивает (на Windows окно видимое и
  закрывается вместе с ними). Гасит те же 8 портов, что поднимает рестарт.
- **Статус-лайн: три GNU-зависимости, которых на маке нет.** `timeout 2 cat` для
  чтения payload от CC (timeout из coreutils) — подстановка молча давала пустую
  строку, `model_id` становился `unknown`, контекстное окно не рисовалось вообще;
  заменено на bash-native `read -r -d '' -t 2` (0 форков, работает и в bash 3.2).
  `date -d <ISO> +%s` — GNU-синтаксис, у BSD `-d` это флаг летнего времени →
  возраст кеша баланса и остаток cooldown не считались; `date +%s%3N` BSD не
  умеет и оставляет `%3N` в строке → арифметика возраста ломалась молча. Обе
  подменены на `_iso_epoch()` / `_now_ms()` с BSD-ветками.
- **Статус-лайн был выключен по умолчанию:** в `claude-settings.example.json`
  секции `statusLine` нет, а существующий `settings.json` установщики не
  перезаписывают. `install.sh` (Windows) подключает его своим `sl_node`,
  `install-mac.sh` — через `tools/enable-statusline.js`. Обе пишут ОДНУ и ту же
  команду `bash "<repo>/routing/statusline-autoreger.sh"`; WSL-обёртка с payload
  через `env STATUSLINE_PAYLOAD` включается только когда `bash` в PATH реально
  WSL-овский (проверка по `WSL_DISTRO_NAME`/`uname -r`, а не по платформе).
- **Пауза «Нажми Enter» только по флагу `DASHBOARD_WAIT_ENTER=1`.** Раньше стояло
  `[ -t 0 ]`, и `read` съедал следующую строку вставленного в терминал блока
  команд — на маке из-за этого молча не запускался пробник баланса. Флаг ставит
  `DASHBOARD.command` (там окно Terminal закрывается вместе с выводом).
- **Пробники для мака** (значения куки не печатают): `tools/mac-balance-probe.js
  [ar|go|tb|xp]` — весь путь точного баланса по шагам (профиль → ключ → куки →
  ответ сервера, с временем); `tools/mac-cookie-probe.js` — подбор ключа куки,
  матрица пароль × итерации × шифр плюс форма данных (по кратности длины 16
  видно, блочный ли шифр).

## Чек-лист: добавляем новый модуль

1. **Бэкенд:** хендлеры в `transparent-proxy.js` (роуты `/__switch/api/<module>/*`),
   при необходимости — логика в `internal/dashboard-api.js`.
2. **Сайдбар:** кнопка `<button class="nav-btn" data-tab="<module>">` в `<nav>`
   (`proxy-dashboard.html`, ~строка 106). Активные модули — в основном списке,
   архивные — в блоке «Чтим память».
3. **⚠ Whitelist видимости:** добавить имя в `DEFAULT_TABS_VISIBLE`
   (`proxy-dashboard.html`, ~строка 12576). Без этого `applyTabsConfig()` ставит
   кнопке класс `hidden` — вкладка есть в DOM, но в сайдбаре её не видно, и
   выглядит это как «вкладка не добавилась».
4. **Вкладка:** `<div data-tab-content="<module>">…</div>` в `<main>`.
5. **Загрузка:** ветка в `showTab()` (ленивая загрузка при первом открытии).
6. **Счётчик:** `#nav-count-<module>` + обновление в load-функции.
7. **Шкала (опц.):** если у модуля есть квота — переиспользовать `renderEnergyGauge`.
8. **Обнови этот файл.**

Для нового NewAPI-провайдера по образцу ar/go/tb/xp список длиннее — см. раздел
«XPeach (xp)»: там же перечислены грабли (whitelist сайдбара, порядок правил в
статуслайне относительно catch-all Custom, отсутствие `:2015x` в KILLPORT).
