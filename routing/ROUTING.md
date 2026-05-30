# Routing Setup — Hot-reload без рестарта Claude Code

## ✅ ПРОВЕРЕННЫЕ РАБОЧИЕ КОНФИГИ (2026-05-31)

### Конфиг A: Чистый Notion (как у автора репо) — **ТУЛЫ РАБОТАЮТ**

Подтверждено: запрос "Что в этой папке?" → Claude Code вызвал Glob, прочитал структуру, ответил списком файлов. Никакого "I am Notion AI".

**Что должно быть:**

`C:\Users\WormAlien\.claude\settings.json` — только 2 переменных в `env`:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8190",
    "ANTHROPIC_API_KEY": "<YOUR_API_KEY>"
  }
}
```

**Критично:** НЕТ `ANTHROPIC_MODEL`, НЕТ `ANTHROPIC_SMALL_FAST_MODEL`, НЕТ top-level `"model"`. Эти три поля ломают bypass.

`C:\Users\WormAlien\Desktop\notion-abuz_ai\config.yaml`:
- `port: "8190"` (не дефолтные 3000)
- `api_key: "<YOUR_API_KEY>"`
- `proxy.disable_notion_prompt: true` ← КРИТИЧНО для убирания 27k system prompt
- `proxy.default_model: "opus-4.6"`
- остальное как в `example.config.yaml` автора

`notion-manager.exe` — оригинальный из git (`git checkout notion-manager.exe`), без моих правок tools.go.

Запуск: `use-notion-pure.bat` → перезапуск Claude Code.

### Конфиг B: OmniRoute (всегда работает, но без vision/identity bleed)

`settings.json`:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:20128/v1",
    "ANTHROPIC_API_KEY": "<YOUR_API_KEY>"
  },
  "model": "ComboWombo"
}
```

Запуск: `use-omniroute.bat` → перезапуск Claude Code.

## Что НЕ протестировано (нужно перепроверить на текущей чистой конфигурации)

- **Vision (картинки)** — старые тесты были на смешанном сетапе со старым smart-router и моими патчами в notion-manager. Сейчас всё откачено. Перетестить:
  - Vision напрямую через Notion (`use-notion-pure.bat` + картинка)
  - Vision напрямую через OmniRoute (`use-omniroute.bat` + картинка)
- **Длинные сессии Claude Code на Opus через Notion** — старые тесты были на патченной версии. На чистой версии автора может быть стабильнее. Перепроверить.
- **Smart-router** — был экспериментально сломанной версией с JSON.parse/stringify. Если будем использовать снова, нужно либо переписать в **streaming pipe** (без буферизации), либо использовать готовое решение типа `http-proxy` от npm.

## Архитектура (планируется)

```
Claude Code
    │
    │ ANTHROPIC_BASE_URL = http://localhost:8200   ← фиксирован НАВСЕГДА
    ▼
┌──────────────────────────────┐
│ smart-router  (8200)         │  Node.js, hot-reload router-config.json
│  └─ читает router-config.json│
│     при каждом запросе       │
└──────┬───────────────┬───────┘
       │               │
       │ если notion   │ если omniroute
       ▼               ▼
┌─────────────┐   ┌──────────────────┐
│ notion-     │   │ OmniRoute        │
│ manager     │   │ (20128)          │
│ (8190)      │   │  ComboWombo,     │
│  47 акков   │   │  ac-freemodel1   │
└─────────────┘   └──────────────────┘

           ▲
           │  POST /api/router-map
           │
┌──────────────────────┐
│ dashboard  (8300)    │  ← редактируем ТОЛЬКО здесь
│ http://localhost:8300│
└──────────────────────┘
```

## Главный принцип

**Claude Code НИКОГДА не меняет `ANTHROPIC_BASE_URL`.**
Он всегда смотрит на `http://localhost:8200` → smart-router решает куда уйдёт каждый запрос.

Это значит — **рестарт Claude Code не нужен при переключении бэкендов**. Меняешь
`router-config.json` через dashboard → smart-router подхватывает за ~1 секунду
(через `fs.watchFile`) → следующий запрос уже идёт по новой схеме.

## Что где живёт

| Сервис             | Порт   | Файл                                                    | Назначение                              |
|--------------------|--------|---------------------------------------------------------|-----------------------------------------|
| **smart-router**   | 8200   | `C:\Users\WormAlien\Desktop\smart-router.js`            | Маршрутизация по модели + fallback chain|
| **dashboard**      | 8300   | `C:\Users\WormAlien\Desktop\dashboard-server.js` + `dashboard.html` | UI для переключения                     |
| **notion-manager** | 8190   | `C:\Users\WormAlien\Desktop\notion-abuz_ai\notion-manager.exe` | Прокси Notion AI (47 акков)             |
| **OmniRoute**      | 20128  | (внешний)                                               | ComboWombo + ac-freemodel                |
| router-config      | —      | `C:\Users\WormAlien\Desktop\router-config.json`         | Карта model → backend chain             |
| Claude Code settings | —    | `C:\Users\WormAlien\.claude\settings.json`              | `ANTHROPIC_BASE_URL=http://localhost:8200` |

## router-config.json — формат

```json
{
  "modelBackends": {
    "opus-4.8":   ["notion", { "backend": "omniroute", "asModel": "ac-freemodel1/claude-opus-4-7" }],
    "ComboWombo": ["omniroute", { "backend": "notion", "asModel": "opus-4.6" }],
    "opus-4.6":   "notion",
    "haiku-4.5":  "notion"
  },
  "defaultBackend": "notion"
}
```

- **Строка** (`"notion"`) — один бэкенд, без fallback.
- **Массив** — chain. Попытка 1, при таймауте/ошибке → попытка 2.
- **Объект `{backend, asModel}`** — переслать в `backend`, подменив в теле запроса `model` на `asModel`.

Smart-router читает этот файл при каждом изменении (watch). **Никаких рестартов.**

## Как переключаться

### Через dashboard (нормальный путь)

1. Открыть http://localhost:8300
2. В секции **Model slots** выбрать Main / Fast
3. **Apply** → dashboard пишет в `router-config.json` → smart-router подхватывает
4. Следующий запрос Claude Code уже по новой схеме

### Через прямой edit (для скриптов)

Отредактировать `C:\Users\WormAlien\Desktop\router-config.json` любым способом —
smart-router увидит изменение и перечитает.

⚠️ **PowerShell ловушка:** `Out-File -Encoding utf8` пишет BOM. Smart-router
BOM съедает (`if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)`), но
лучше `Set-Content -Encoding ASCII` или редактировать в VS Code.

## Claude Code settings.json — что должно быть

### Вариант A: через smart-router (8200) — гибкое переключение

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8200",
    "ANTHROPIC_API_KEY":  "<YOUR_API_KEY>",
    "ANTHROPIC_MODEL":            "opus-4.8",
    "ANTHROPIC_SMALL_FAST_MODEL": "ComboWombo"
  },
  "model": "opus-4.8"
}
```

- `BASE_URL` = **всегда** 8200, **не меняем**.
- `ANTHROPIC_MODEL` / `model` — какую модель Claude Code просит у smart-router как «основную».
- `ANTHROPIC_SMALL_FAST_MODEL` — какую модель просит как «быструю» (заголовки, автодополнения).
- Менять модель внутри запущенного Claude Code — `/model <name>`. Без рестарта.

### Вариант B: напрямую в notion-manager (8190) — как у автора репо

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8190",
    "ANTHROPIC_API_KEY":  "<YOUR_API_KEY>",
    "ANTHROPIC_MODEL":            "opus-4.8",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku-4.5"
  },
  "model": "opus-4.8"
}
```

- Без smart-router — Claude Code → notion-manager напрямую.
- **Проверено работает** для tools (Bash/Read/Write/Edit/Glob/Grep).
- Ограничение: Opus 4.6/4.8 иногда палит bypass и отказывает («I am Notion AI») на длинных сессиях или сложных запросах. На коротких свежих запросах — стабильно.
- Для друга по WiFi: `ANTHROPIC_BASE_URL = http://<твой_локальный_IP>:8190`, API_KEY тот же.

## notion-manager — критичные настройки

Файл: `C:\Users\WormAlien\Desktop\notion-abuz_ai\config.yaml`

**Обязательно `proxy.disable_notion_prompt: true`** — снимает ~27k system prompt Notion AI,
без него ответы будут «I am Notion AI, I don't have tools» и файлы/код/картинки не работают.

```yaml
proxy:
    disable_notion_prompt: true   # КРИТИЧНО
    default_model: "opus-4.6"
    enable_web_search: true
```

`model_map` должен содержать алиасы которые роутер пробрасывает:
```yaml
model_map:
    opus-4.8: "avocado-froyo-medium"
    opus-4.6: "avocado-froyo-medium"
    ComboWombo: "avocado-froyo-medium"
    ...
```

При смене `config.yaml` — **notion-manager надо рестартить**, hot-reload его конфига нет.

## Типовые сценарии

### «Хочу Main = Notion (Opus 4.8), Fast = OmniRoute (ComboWombo)»
Dashboard → Main = `opus-4.8`, Fast = `ComboWombo` → Apply.
router-config:
```json
"opus-4.8":   ["notion", {"backend":"omniroute","asModel":"ac-freemodel1/claude-opus-4-7"}],
"ComboWombo": ["omniroute", {"backend":"notion","asModel":"opus-4.6"}]
```

### «Хочу всё на OmniRoute (Notion упал)»
Dashboard → Mode → **OmniRoute only**. Всё уходит в 20128.

### «Хочу всё на Notion»
Dashboard → Mode → **Notion only**.

### «Хочу заменить модель прямо в Claude Code»
В Claude Code: `/model opus-4.6` — без перезапуска. Smart-router увидит новую
модель в теле запроса и проложит по `router-config["opus-4.6"]`.

## Диагностика

- **smart-router лог:** `C:\Users\WormAlien\Desktop\smart-router.log` — каждая строка `model=X chain=[...]` + результат
- **notion-manager лог:** `C:\Users\WormAlien\Desktop\notion-abuz_ai\notion-manager.log.err`
- **dashboard:** http://localhost:8300 показывает живые статусы всех бэкендов
- **порты:** `Get-NetTCPConnection -State Listen | ? LocalPort -in 8190,8200,8300,20128`

### «Модель отвечает 'I am Notion AI'»
→ `disable_notion_prompt: true` отсутствует или notion-manager не перезапущен после правки config.yaml.

### «400 No credentials for provider: openai»
→ Кеш Claude Code, нужен рестарт **этой конкретной сессии** Claude Code (не системы).
Возникает при переключении модели на OpenAI-семейство без рестарта.

### «vendorBadRequest на всех аккаунтах»
→ Размер запроса > лимита Notion (обычно `messages > 500` + `tools > 20` + `attachments`).
Решение: `/compact` в Claude Code.

### «ECONNRESET / timeout от smart-router»
→ Проверить что 8200 жив: `Get-NetTCPConnection -State Listen | ? LocalPort -eq 8200`.
Если нет — поднять: `Start-Process node 'C:\Users\WormAlien\Desktop\smart-router.js'`.

## Бэкап / panic

- `PANIC-restore-omniroute.bat` — восстанавливает settings.json из бэкапа
  (`~/.claude/settings.omniroute-backup.json`), убивает smart-router и
  notion-manager. После него Claude Code тыкается напрямую в OmniRoute 20128.
- `use-*.bat` скрипты — оставлены **только** как aварийный бэкап. Нормальный путь — dashboard.
- `config.yaml.bak` рядом с `config.yaml` — последняя рабочая версия.

## Что НЕ делать

- ❌ Не менять `ANTHROPIC_BASE_URL` руками. Только если smart-router целиком сломан.
- ❌ Не редактировать `router-config.json` через PowerShell `Out-File -Encoding utf8`
  (BOM). VS Code / `Set-Content -Encoding ASCII` / dashboard.
- ❌ Не указывать в `modelBackends` модель, которой нет в `notion-manager`
  model_map (для notion-цепочек) или в OmniRoute (для omniroute-цепочек).
- ❌ Не перезапускать Claude Code «на всякий случай» — теряется контекст. Всё
  переключение делается на лету.
