# Концепт: фиксированный вход `:20100` (front-door proxy)

> **Статус: РЕАЛИЗОВАНО.** Front-door живёт в `routing/frontdoor-proxy.js`, слушает
> `127.0.0.1:20100` и с коммита `4bb05b5` работает **режимом по умолчанию** — один адрес
> на все клиенты. Актуальное описание — `ARCHITECTURE.md` → таблица сервисов и раздел
> «Front Door»; тумблер в «Настройках» дашборда (`routing/frontdoor.json`).
>
> Этот файл оставлен как **запись замысла**: зачем вообще понадобился фиксированный вход,
> какие были альтернативы и какой контракт обязан соблюдать прокси (заголовки клиента
> релеятся без изменений, ретраев нет, слушает только loopback). `frontdoor-proxy.js:12`
> ссылается сюда именно за контрактом. Что описано ниже как «надо сделать» — **уже
> сделано**, за фактическим положением дел идти в `ARCHITECTURE.md`, а не сюда.
>
> Написано 2026-08-20 как ТЗ, помечено реализованным 2026-08-21.

Читать вместе с `ARCHITECTURE.md` (разделы «Backends», «Статуслайн», «Health»).

## Зачем

Сейчас при переключении провайдера дашборд меняет `ANTHROPIC_BASE_URL` в
`~/.claude/settings.json`. `env` читается Claude Code **при старте процесса**, поэтому
смена провайдера требует новой сессии CC. Три следствия:

1. Переключение провайдера не бесшовно (смена ключа внутри провайдера — уже бесшовна, см. ниже).
2. **Claude Code Desktop в схему не входит вообще.** Дословно из доков Anthropic
   (`code.claude.com/docs/en/llm-gateway-connect`): «The desktop app reads gateway routing from
   its third-party inference configuration, **not** from `ANTHROPIC_BASE_URL` or `settings.json`».
   Настраивается только руками: Help → Troubleshooting → Enable Developer Mode →
   Developer → Configure Third-Party Inference → base URL. Пока адрес меняется при каждом
   свиче, вбивать его туда бессмысленно.
3. Авто-ротация FreeModel не видит реальных 429: трафик helper-режимов идёт напрямую на
   `cc.freemodel.dev`, минуя наши прокси (ограничение записано в `ARCHITECTURE.md`).

Лечение: `ANTHROPIC_BASE_URL` перестаёт меняться. Он навсегда указывает на локальный
front-door, а выбор бэкенда переезжает внутрь него и делается по файлу состояния.

## Что уже есть (проверено в коде, не выдумано)

| Факт | Где |
|---|---|
| Ключ ar/go/tb/xp подставляет **прокси**, а не CC: читает `KEY_FILE` и ставит `authorization: Bearer` + `x-api-key` | `routing/keepalive-proxy.js:771-774` |
| Активация go/tb/xp пишет в settings `ANTHROPIC_AUTH_TOKEN = 'dummy'` — реальный ключ берётся из файла | `transparent-proxy.js:7643`, `:8144`, `:8740` |
| Заголовки клиента релеятся без изменений (важно для WAF agentrouter) | `keepalive-proxy.js:30` |
| Маппинги моделей и `fm-openai-config.json` перечитываются по mtime — без рестарта | `ARCHITECTURE.md`, разделы ar/go/tb/xp |

Вывод: **смена аккаунта внутри провайдера бесшовна уже сейчас**, включая ar/go/tb/xp
(в `ARCHITECTURE.md` это описано как «ключ литералом» — текст устарел, надо поправить).
Не бесшовна только смена провайдера.

⚠️ У agentrouter две ветки активации: `transparent-proxy.js:7024` пишет `'dummy'`,
`:7098` — литерал `activeKey`. **Первым делом выяснить, какая срабатывает**, и свести к
dummy-варианту. Если у ar останется литерал, он будет единственным не-бесшовным
провайдером и в новой схеме тоже.

## Схема

```
settings.json  (пишется ОДИН раз, дальше не трогается):
    ANTHROPIC_BASE_URL   = http://127.0.0.1:20100
    ANTHROPIC_AUTH_TOKEN = dummy
    apiKeyHelper         — удаляется (ключ инжектит front-door)

~/.claude/active-backend.json   ← единственный источник правды о активном бэкенде
    { "backend": "tabi", "updatedAt": 1755... }

routing/frontdoor-proxy.js  :20100
    на каждый запрос: читает active-backend.json по mtime → выбирает upstream:

    backend        upstream                                 ключ
    ─────────────  ───────────────────────────────────────  ────────────────────────
    agentrouter    127.0.0.1:20133 (keepalive)               ставит keepalive сам
    tabi           127.0.0.1:20155 (keepalive)               ставит keepalive сам
    gorouter       127.0.0.1:20156 (keepalive)               ставит keepalive сам
    xpeach         127.0.0.1:20157 (keepalive)               ставит keepalive сам
    justwoker      127.0.0.1:20158 (keepalive)               ставит keepalive сам
    omniroute      127.0.0.1:20128/v1                        —
    fm_openai      127.0.0.1:20130                           прокси сам из fm-active-key.txt
    vyce_openai    127.0.0.1:20131                           прокси сам из vyceai/keys.txt
    custom         127.0.0.1:<proxyPort>                     прокси сам
    apihelper      cc.freemodel.dev                          front-door: fm-active-key.txt
    aerolink       capi.aerolink.lat                         front-door: al-active-key.txt
    evomap         api.evomap.ai/v1                          front-door: ev-active-key.txt
    ourtoken       api.ourtoken.ai/v1                        front-door: ot-active-key.txt
    conduit        conduit.ozdoev.net/v1                     front-door: cdt-active-key.txt
    svrtr          api.svrtr.org                             front-door: sr-active-key.txt
    helpcoder      helpcoder.cc                              front-door: hc-active-key.txt
```

Для локальных апстримов front-door — тонкий реверс-прокси: **ключ не трогает**, его уже
ставит keepalive/конвертер. Для удалённых (бывшие helper-режимы) — читает
`<p>-active-key.txt` на каждый запрос и ставит оба заголовка (`Authorization: Bearer` +
`x-api-key`), как это делает `keepalive-proxy.js:771-774`.

## Контракт front-door

**Обязан:**

- релеить заголовки клиента **без изменений** (WAF agentrouter пускает только запросы с
  `user-agent: claude-cli/…`; свой UA не подставлять никогда);
- читать состояние по mtime, без кеша дольше одного запроса — иначе теряется смысл;
- форвардить `/v1/messages/count_tokens` в апстрим, а **не** отвечать самому: локальную
  оценку уже отдаёт keepalive;
- пропускать пробник валидации модели CC (`stream=false msgs=2 tools=0`, летит на `/model`)
  как обычный запрос — это не ошибка;
- при отсутствии/битом `active-backend.json` отвечать `503` с внятным телом, а **не**
  падать и не уходить на дефолтный бэкенд молча.

**Не должен:**

- резать `[1m]` (это делает keepalive), подменять модель (это modelmap), конвертить
  Anthropic→OpenAI (это `:20130/20131/20132`). Front-door только выбирает, куда форвардить;
- ретраить. Ретраи живут в keepalive, дублирование сожжёт платные запросы;
- логировать `authorization` / ключи.

## Что меняется в дашборде

1. **Источник правды о режиме.** Сейчас `currentTarget` вычисляется по `settings.json`
   (`transparent-proxy.js` ~377-399: по имени файла в `apiKeyHelper`, иначе по base URL).
   В новой схеме base URL всегда `:20100`, а helper'а нет → **детект ослепнет**.
   Заменить на чтение `active-backend.json`. Это главный пункт рефакторинга, всё остальное
   мелочи.
2. `writeSettings()` перестаёт писать `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` /
   `apiKeyHelper` при свиче. Он остаётся чокпоинтом для `model` / `[1m]` /
   `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — эта часть не меняется, `tools/check-1m.js` должен
   продолжать проходить.
3. Активация провайдера = записать `<p>-active-key.txt` + `active-backend.json`. Всё.
4. Статуслайн (`routing/statusline-autoreger.sh`): фолбэк при недоступном `:8200` тоже
   смотрит на `apiKeyHelper`/`ANTHROPIC_BASE_URL` → переписать на `active-backend.json`.
   Порядок правил: `:20100` не попадает в catch-all `*localhost:2015[0-9]*` → `custom`,
   но своё правило добавить надо.
5. Health: `wired.port` становится `20100`. Правило `isIdle()` не меняется — лежащие
   keepalive по-прежнему «не запущен», красным горит только реально проводной порт.

## Модель: что бесшовно, что нет

- `/model` **в сессии работает** — включая выбор `[1m]`-варианта. Front-door тут ни при чём.
- `<p>-modelmap.json` перебивает выбор CC и применяется по mtime → фактическая модель
  шлюза меняется на лету уже сейчас.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — env, читается на старте, **за `/model` не следует**.
  Залипшее `1050000` при уходе на `claude-*` = переполнение контекста на апстриме.

Правило, которое из этого следует: **держать `settings.model` на `claude-*`, а gpt-модели
доставать тир-маппингом**, как уже сделано для haiku сабагентов. Тогда
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` не нужен вообще и рассинхрон невозможен. Пин gpt-модели в
`settings.model` — только осознанно и с новой сессией.

## Порядок внедрения

1. Разобраться с ar (`:7024` vs `:7098`), свести к dummy. Проверка: активировать ar,
   посмотреть `settings.json` — там должен быть `dummy`.
2. Написать `routing/frontdoor-proxy.js` + `selftest`-режим по образцу
   `keepalive-proxy.js selftest` (стоит до `server.listen`, порт не занимает).
   Покрыть: выбор апстрима по каждому backend, инжект ключа только для удалённых,
   отсутствие ретраев, `503` при битом состоянии.
3. Boot-спавн front-door в `start-switcher.bat` (как `:20133`) **и** `:20100` в KILLPORT —
   в отличие от `:2015x` его убивать безопасно, потому что он респавнится на старте.
4. Перевести детект `currentTarget` на `active-backend.json`.
5. Свич: писать состояние вместо base URL. Держать обратную совместимость на один релиз —
   если `active-backend.json` нет, читать по-старому из `settings.json`.
6. Статуслайн: фолбэк + правило `:20100`.
7. Живая проверка: `claude` → `/status` (base URL = `:20100`) → свич провайдера в дашборде
   **без перезапуска CC** → следующий запрос уходит на новый шлюз. Это и есть приёмка.
8. Claude Code Desktop: Developer → Configure Third-Party Inference → `http://127.0.0.1:20100`.
   Помнить: с активным gateway Desktop работает только локально — SSH-сессии, облачные
   окружения и Remote Control отваливаются (это по докам, не наш баг). Если пишет
   `Gateway was unreachable` — front-door лежал на старте приложения.

## Грабли, известные заранее

- **Единая точка отказа.** Лёг `:20100` — лёг Claude Code целиком. Поэтому boot-спавн +
  кнопка рестарта в Health обязательны до перевода `settings.json` на новый адрес.
- **Бэкап `settings.json` перед первой записью** новой схемы (`settings-backups/` уже есть).
  Аварийный откат — вернуть старый `env`-блок из бэкапа, front-door при этом можно не гасить.
- **helper-режимы теперь идут через прокси.** Плюс: ротатор FreeModel наконец увидит реальные
  429. Минус: появляется новый участок, где можно испортить заголовки — см. контракт.
  Отдельно проверить conduit/svrtr (Anthropic-совместимые, ключи `sk-cdt-`/`sk-sr-v1-`).
- **Убрав `apiKeyHelper`, мы убираем и его грабли** (node-вариант вместо `cat`, кириллица в
  пути, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=0`). Соответствующие места в `install.sh` и
  шаблоне settings можно чистить — но только после того как схема заживёт.
- **Гейт `GPT_PROXY_ENABLED`** в keepalive смотрит на `UPSTREAM` своего инстанса. Front-door
  форвардит в keepalive нужного провайдера, поэтому гейт остаётся на месте. Не пытаться
  уводить gpt в `:20132` из front-door — сожжёт баланс AgentRouter чужим ключом.
- **Не забыть `ARCHITECTURE.md`**: раздел «Backends» (ключ ar/go/tb/xp живёт в файле, а не
  литералом), новый порт `:20100` в таблицу сервисов, `active-backend.json` как источник
  правды.

## Orca — где она тут

Orca (`stablyai/orca`, релизы `orca-macos-x64.dmg` / `orca-macos-arm64.dmg` /
`orca-windows-setup.exe`) — GUI-оркестратор, который гоняет CLI-агентов в pty-терминалах
(её CLI: `orca terminal create --worktree … --command`, `orca terminal send --text`,
`orca terminal wait --for tui-idle`). Для нашей схемы это **обычный терминал**: `claude`
внутри неё сам читает `~/.claude/settings.json` при старте. Правок в дашборде не требует
ни до, ни после front-door.

Проверить при установке — одна вещь: у Orca есть свой аккаунт-свитчер (для Codex hot-swap
задокументирован, про Claude сказано только «See Claude and Codex usage and rate-limit
resets»). Не подсовывает ли он свой OAuth поверх нашего роутинга. Проверка: открыть
терминал в Orca → `claude` → `/status` → должен показывать наш base URL и источник креда.
Если показывает claude.ai-логин — искать, где Orca задаёт env агенту, и выключать.
