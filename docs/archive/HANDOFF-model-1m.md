# HANDOFF: модель без `[1m]` (окно 200k вместо 1M)

Дата: 2026-08-17. Собрано измерениями, не догадками. Читать целиком до первой правки.

> **Статус на 2026-08-21: закрыто.** Шаги 1, 3 и 5 сделаны, шаг 2 не нужен (прямая запись
> осталась одна — разрешённое восстановление из бэкапа, и она тоже прогоняется через
> нормализацию), шаг 4 неприменим: `claude` из репо не запускается ниоткуда
> (`grep -rn "claude --model\|claude --resume"` по `*.bat/*.sh/*.js` — пусто), вешать флаг
> не на что. Разбор ниже оставлен как история вопроса; актуальное правило — в комментарии
> у `resolveCcModel()` в `routing/transparent-proxy.js`.
>
> Ключевое, чего не знал автор этого документа: **защитный сброс модели был ложной
> защитой.** Он (а) не влияет на живую сессию вообще — модель резолвится один раз на
> старте, поэтому прыжки между аккаунтами по 🔑 бесшовны; (б) страхует от опасности,
> которую снимает keepalive-прокси: тир-карта `<prefix>-modelmap.json` переписывает
> `claude-opus-5` на внутреннее имя шлюза, так что точное имя в каталоге быть не обязано.
> Поэтому «вслепую пинить нельзя» из шага 3 верно только для шлюза с ПУСТОЙ тир-картой
> (сейчас такой один — xpeach), а не для всех.

## Симптом

Периодически (после `claude --resume`, после переключения бэкенда в дашборде, в новых сессиях)
Claude Code стартует на `claude-opus-5` **без** суффикса `[1m]` → считает окно 200k и режет
историю втрое раньше. Пользователь много раз просил «модели с `[1m]` где доступно», правки
делались, симптом возвращается.

## Почему возвращается (корень)

**У записи модели в `~/.claude/settings.json` нет единой точки входа.** В
`routing/transparent-proxy.js` есть аккуратный `writeSettings()` (строка 201: бэкап + atomic
rename), но им пользуются **5 мест**, а мимо него settings.json пишут **27 прямых вызовов**
`fs.writeFileSync(SETTINGS_FILE, …)`. Суффикс `[1m]` дотягивают только **4** места из 24, где
модель вообще присваивается.

Поэтому любая правка «добавил `[1m]` вот здесь» лечит один путь из двадцати с лишним. Следующий
агент правит другой путь. Симптом бессмертен, пока нет чокпоинта.

## Факты, на которые опираться (проверено)

1. **Источник модели один** — `~/.claude/settings.json` → `"model"`. Пер-сессионной модели в
   транскрипте **нет**: в `.jsonl` сессии лежат строки `mode`, `permission-mode`, `ai-title`, а
   `model` не хранится. Значит `--resume` разрешает модель на старте по цепочке
   `--model` → `settings.json` → дефолт приложения.
2. **Дефолт приложения — без `[1m]`.** Если ключа `model` в settings.json нет, окно 200k.
   Поэтому `delete settings.model` = молчаливый даунгрейд до 200k.
3. **`[1m]` — метка Claude Code, не API-модель.** У Opus 5 / Sonnet 5 / Opus 4.6–4.8 контекст 1M
   штатно, без бета-заголовка; прокси (`keepalive-proxy.js`, `agentrouter-proxy.js`) суффикс
   **режут** перед форвардом. Следствие: в транскрипте `message.model` **всегда**
   `claude-opus-5` — по нему нельзя понять, 1M сессия или нет.
4. **Как реально проверить, шла ли сессия на 1M:** `~/.claude.json` →
   `projects["<cwd>"].lastModelUsage` — ключ там либо `claude-opus-5[1m]`, либо `claude-opus-5`.

## Карта всех мест (замерено, строки на 2026-08-17)

`settings.model` присваивается/удаляется в 24 местах `routing/transparent-proxy.js`:

| Строка | Функция | Что делает | `[1m]`? |
|---|---|---|---|
| 390–391 | `applyTarget` | пишет/удаляет `backend.model` из таблицы бэкендов как есть | ❌ нет нормализации |
| 2311–2312 | `handleFreemodelActivate` | дотягивает суффикс | ✅ |
| 2531 | `handleAlActivate` | `delete` | ❌ → 200k |
| 2636 | `handleEvActivate` | `delete` | ❌ → 200k |
| 2868 | `handleOtActivate` | `delete` | ❌ → 200k |
| 3092 | `customRepointSettings` | `delete` | ❌ → 200k |
| 3119 | `customApplyDirectEnv` | `delete` | ❌ → 200k |
| 3682 | `handleCustomActivate` | `delete` | ❌ → 200k |
| 3891 | `handleCustomDeactivate` | `delete` | ❌ → 200k |
| 4036 | `cunApplyModelToSettings` | `settings.model = m` | ❌ сырое `m` |
| 4356 | `handleOmActivate` | `delete` | ❌ (тут осознанно: ComboWombo) |
| 4776 | `handleSvrtrActivate` | `delete` | ❌ → 200k |
| 4903 | `handleHelpcoderActivate` | `delete` | ❌ → 200k |
| 5025 | `handleConduitActivate` | `delete` | ❌ → 200k |
| 5149 | `handleConduitSetModel` | `settings.model = m` | ❌ сырое `m` |
| 6046–6047 | `handleArActivate` | `arSettingsModel(curModel)`, иначе `delete` | ✅ / ❌ |
| 6117 | `handleArSetModel` | `settingsModel` | ✅ |
| 6735 | `handleGoActivate` | `delete` | ❌ → 200k |
| 6801 | `handleGoSetModel` | `mm[m] \|\| settingsModel` | ✅ |
| 7322 | `handleTbActivate` | `delete` | ❌ → 200k |
| 7389 | `handleTbSetModel` | `settingsModel` | ✅ |
| 7762 | `handleVyceaiActivate` | `delete` | ❌ → 200k |

**Ключевая пара, объясняющая «то есть, то нет»:** `handleGoActivate` / `handleTbActivate`
**удаляют** модель, а `handleGoSetModel` / `handleTbSetModel` её **возвращают с `[1m]`**. Любая
сессия, запущенная между «активировал аккаунт» и «кликнул чип модели», едет на 200k.

Плюс таблица бэкендов (строки ~112–150): `notion: 'opus-4.8'` (без `[1m]`),
`freemodel_rotator: 'opus[1m]'` (ок), `omniroute: 'ComboWombo'` (виртуальная, суффикс не
применим), `fm_openai: null` (= delete), `agentrouter: undefined` (не трогать — источник правды
`ar-active-model.txt`).

## Что делать (порядок важен)

### Шаг 1. Чокпоинт (это и есть фикс, остальное — добивание)

В `routing/transparent-proxy.js` рядом с `writeSettings()`:

```js
// Единственное место, где решается судьба суффикса [1m]. Claude Code без него
// считает окно 200k. Держать правило здесь, а не в 24 обработчиках.
const CC_DEFAULT_MODEL = 'claude-opus-5[1m]';
function normalizeCcModel(m) {
    const s = String(m || '');
    if (!s) return s;
    return /^claude-(opus|sonnet)-/.test(s) && !s.includes('[') ? `${s}[1m]` : s;
}
```

и внутри `writeSettings(obj)` — **до** записи на диск:

```js
if (typeof obj.model === 'string') obj.model = normalizeCcModel(obj.model);
```

### Шаг 2. Загнать 27 прямых записей в `writeSettings()`

```bash
grep -n "fs.writeFileSync(SETTINGS_FILE" routing/transparent-proxy.js
```

Каждую заменить на `writeSettings(settings)` (у трёх строк переменная называется иначе — `s`,
`next`, `raw`; строку 8060 с `raw` **не трогать**: там пишется сырой текст восстановления из
бэкапа, JSON.stringify его сломает). Побочный бонус: все записи получат бэкап и atomic rename,
которых сейчас нет у 27 путей.

### Шаг 3. Разобрать `delete settings.model`

Удаление модели — это переход на дефолт Claude Code, то есть на 200k. Правило по провайдерам:

- **Есть `<provider>-active-model.txt`** (ar, go, tb, freemodel) → вместо `delete` писать
  активную модель через `normalizeCcModel()`. Готовый образец — `handleArActivate` (6046).
  Начинать с `handleGoActivate` (6735) и `handleTbActivate` (7322): там уже есть
  `<p>-active-model.txt` и modelmap, просто активация их игнорирует.
- **Виртуальная модель шлюза** (omniroute `ComboWombo`, aerolink, evomap, custom, ourtoken,
  svrtr, helpcoder, conduit, vyceai) → **сначала проверить каталог шлюза**. Если в нём есть
  `claude-opus-*`/`claude-sonnet-*` — пинить его с `[1m]`. Если нет — `delete` корректен, и 200k
  там неизбежен; это надо **записать в `ARCHITECTURE.md`**, а не молча оставлять.
- ⚠️ **Не пинить `claude-opus-5` вслепую.** У agentrouter в каталоге на 2026-08-16 всего 3
  модели и `claude-opus-5` среди них нет (`claude-opus-4-8` и др.) — глобальный пин положит
  запросы. Пинить только то, что шлюз реально отдаёт.

### Шаг 4. Пояс поверх кода

Флаг сильнее файла: `claude --resume --model "claude-opus-5[1m]"`. Вписать `--model
"claude-opus-5[1m]"` в `START.bat` и в любой другой запуск `claude` из репо — тогда даже
затёртый settings.json не уронит окно.

### Шаг 5. Регресс-тест, чтобы не вернулось

Скрипт (например `tools/check-1m.js`), который:
1. читает `~/.claude/settings.json` → падает, если `model` отсутствует или matches
   `/^claude-(opus|sonnet)-/` без `[`;
2. грепает `routing/transparent-proxy.js` на `fs.writeFileSync(SETTINGS_FILE` → падает, если
   найдено что-то кроме разрешённой строки восстановления;
3. дёргает по разу каждый `activate`-роут на тестовой копии settings и проверяет инвариант.

Инвариант одной строкой: **после любой операции дашборда `settings.model` — непустая строка, и
если она `claude-(opus|sonnet)-*`, в ней есть `[1m]`.**

## Как проверять руками

```bash
# что стоит сейчас
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.claude/settings.json','utf8')).model)"
# на чём реально ехала последняя сессия (ключ покажет [1m] или его отсутствие)
node -e "const j=require(process.env.USERPROFILE+'/.claude.json');const k=Object.keys(j.projects).find(x=>/Autoreger_Clean$/i.test(x));console.log(Object.keys(j.projects[k].lastModelUsage||{}))"
```

Не проверять по транскрипту: `message.model` там всегда без суффикса (см. факт 3).

## Грабли для следующего агента

- Правка «добавил `[1m]` в конкретный хендлер» — **не** решение. Их 24, путей записи 27.
- `keepalive-proxy.js` и `agentrouter-proxy.js` суффикс режут — это правильно, их не трогать.
- Статуслайн (`routing/statusline-autoreger.sh:54`) показывает `model.id` от Claude Code: если в
  нём нет `[1m]`, значит сессия реально 200k. Это самый быстрый индикатор для глаза.
- `settings.json` содержит токены — не логировать целиком.
