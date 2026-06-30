<div align="center">

# Vibe-Code Account Creator Manager

Локальная control-plane: автореги бесплатных Claude-аккаунтов (`FreeModel` · `Conduit`) + переключение backend'а Claude Code между пулами (**FreeModel · OmniRoute · Aerolink · Conduit**) одним кликом из веб-дашборда, с авто-ротацией ключей **без перезапуска** Claude Code. Плюс ТГ-пульт для управления с телефона.

<br>

![Switcher](docs/dashboard.png)

<br>

</div>

## Что это

Всё под одной крышей: автореги + веб-дашборд на `:8200` (`routing/transparent-proxy.js`), который переписывает `~/.claude/settings.json` и менеджит все пулы ключей. Claude Code читает из `settings.json` `ANTHROPIC_BASE_URL` + ключ — переключение бэкенда = подмена этих полей.

Фишка: для пулов FreeModel / Aerolink / Conduit ключ кладётся в файл (`~/.claude/*-active-key.txt`), а `settings.json` через `apiKeyHelper` (TTL=0) читает его **на каждый запрос** → ключ можно менять на лету, **без перезапуска** Claude Code. На этом построена авто-ротация.

<div align="center">

| Модуль | Что делает |
| :--- | :--- |
| **Switcher** | Переключатель бэкенда + глобальная шкала запаса. Правит `settings.json` (с `.bak`). |
| **FreeModel** | Аккаунты `freemodel.dev` + пул Telegram для привязки + **авто-ротация** ключей. |
| **Aerolink** | Ручной пул `email + ключ` (`capi.aerolink.lat`), активация через API Helper. |
| **Conduit** | Аккаунты `conduit.ozdoev.net`, авторег **из Telegram** (device-code, без Playwright). |
| **Video / Картинки API** | Хранилища ключей видео- и картинко-провайдеров (CRUD + триал-каталог). |
| **Плагины** | Вкл/выкл плагинов Claude Code (тоггл `enabledPlugins`) + ★ рекомендованные. |
| **Telegram-пульт** (`tgbot/`) | Управление дашбордом и живая claude-сессия прямо из Telegram. |
| _Архив_ | TokenRouter · Notion · Devin — «чтим память», не развиваются. |

</div>

Подробная карта модулей, портов и внутренностей — в **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Сервисы и порты

| Порт | Сервис | Файл |
| :--- | :--- | :--- |
| `8200` | **Switcher / Dashboard** — UI `/__switch` + все `/__switch/api/*` | `routing/transparent-proxy.js` |
| `20126` | **FreeModel Key Rotator** | `routing/freemodel-rotator.js` |
| `20128` | **OmniRoute** (внешний Docker, опц.) — backend `/v1` | docker `ghcr.io/diegosouzapw/omniroute` |
| — | **Telegram-пульт** — long-poll, порт не слушает | `tgbot/bot.js` |

---

## Установка с нуля

Голый Windows, ничего не стоит. Открой **git-bash**, склонируй и запусти установщик — он спросит, что ставить (OmniRoute? ТГ-бот? Python-зависимости?), сам соберёт секреты (`BOT_TOKEN`, `ALLOWED_USERS`, `OMNIROUTE_API_KEY`) и поднимет дашборд.

```bash
git clone https://github.com/WormAlien/vibe-code-account-creator-manager.git
cd vibe-code-account-creator-manager
bash install.sh
```

Что делает `install.sh` (всё интерактивно, Enter = дефолт):

1. Проверяет `node`/`npm`/`git`, при нехватке предлагает поставить через `winget`.
2. `npm install` + (опц.) `npx playwright install chromium`.
3. Ставит **Claude Code ровно `2.1.179`** (новее ломает `apiKeyHelper`) — если стоит другая.
4. Создаёт `~/.claude/settings.json` из шаблона (если ещё нет).
5. Копирует локальные конфиги из `*.example` (`routing/.env`, `al-sessions`, `video-keys`, `image-keys`).
6. **OmniRoute** в Docker (по желанию) на `:20128`.
7. **ТГ-бот** (по желанию) — спросит токен и whitelist, запишет в `tgbot/.env`.
8. Python-зависимости (по желанию) — Camoufox + venv для ✈ Открыть TG.
9. Запускает дашборд.

**Дашборд:** <http://localhost:8200/__switch> · откат при поломке ключа: `routing/PANIC-restore-omniroute.bat`

> [!IMPORTANT]
> **Claude Code должен остаться на `2.1.179`.** На свежих версиях ломается `apiKeyHelper`-флоу (ротация ключей на лету). Установщик ставит правильную версию и шаблон `settings.json` с уже отключённым авто-апдейтом (`DISABLE_AUTOUPDATER=1`, `autoUpdates:false`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=0`). Не включай обратно `autoUpdatesChannel: "latest"` — перетянет на свежую версию.

<details>
<summary><b>Вручную, без установщика</b> — те же шаги командами (git-bash)</summary>

```bash
# 0. системные зависимости (winget)
winget install OpenJS.NodeJS.LTS          # Node.js LTS (>=18) + npm
winget install Git.Git                     # Git for Windows (git-bash)
winget install Docker.DockerDesktop        # только под backend OmniRoute
winget install Python.Python.3.12          # опц.: Conduit-автореги / ✈ Открыть TG

# 1. зависимости
npm install
npx playwright install chromium

# 2. Claude Code РОВНО 2.1.179
npm config delete prefix
npm uninstall -g @anthropic-ai/claude-code
npm install -g @anthropic-ai/claude-code@2.1.179

# 3. базовый settings.json (autoUpdates:false + DISABLE_AUTOUPDATER:1 ОБЯЗАТЕЛЬНЫ)
cp claude-settings.example.json ~/.claude/settings.json

# 4. локальные конфиги/секреты (gitignored)
cp routing/.env.example             routing/.env
cp routing/al-sessions.example.json routing/al-sessions.json
cp routing/video-keys.example.json  routing/video-keys.json
cp routing/image-keys.example.json  routing/image-keys.json
cp tgbot/.env.example               tgbot/.env   # впиши BOT_TOKEN + ALLOWED_USERS

# 5. OmniRoute (Docker) — нужен только под backend OmniRoute
MSYS_NO_PATHCONV=1 docker run -d --name omniroute \
  -p 20128:20128 -v omniroute-data:/app/data --restart unless-stopped \
  -e PORT=20128 -e HOSTNAME=0.0.0.0 ghcr.io/diegosouzapw/omniroute:latest

# 6. опц. Python-зависимости (✈ Открыть TG)
python3.12 -m venv tools/tg-venv
tools/tg-venv/Scripts/pip install -r tools/tg-venv-requirements.txt

# 7. запуск
routing/restart-dashboard.bat              # rotator :20126 + дашборд :8200 + откроет UI
npm run tgbot                              # опц.: ТГ-пульт
```
</details>

---

## Дашборд

`http://localhost:8200/__switch`. Сайдбар: **Switcher · FreeModel · Aerolink · Conduit · Video · Картинки · Плагины · Настройки** (+ архив «Чтим память»).

### Switcher

Переключает Claude Code между бэкендами одним кликом — переписывает `~/.claude/settings.json` (с `.bak-<timestamp>`). После прямого свича — **перезапустить Claude Code**; в режимах API Helper (FM/Aerolink/Conduit) перезапуск не нужен. Сверху — **глобальная шкала запаса** (считает FreeModel-пул).

### FreeModel

Менеджер сессий `freemodel.dev` с квотами (окна 5h/7d, `$`) и пулом Telegram-привязок.

- **Режим ключа** — бейдж 🔑 **Прямой ключ** (`env.ANTHROPIC_API_KEY`) или 🤝 **API Helper** (`apiKeyHelper` читает `~/.claude/fm-active-key.txt`). Тумблер на каждой сессии.
- **➕ Создать v3** — реги пачкой · **🔄 Квоты ~30s** — перепрогон через headless Chrome.
- **Авто-ротация** — держит активным наименее использованный ключ, переписывает `fm-active-key.txt` без перезапуска CC. Настройки: интервал (90с) + потолок used% (70%). Лог свитчей, состояние в `logs/.freemodel_autorotate.json` (переживает рестарт).

### Aerolink

Ручной пул `email + ключ` (`capi.aerolink.lat`). Пинг `/v1/me` → статус, активация через API Helper (`al-active-key.txt`). Данные — `routing/al-sessions.json` (gitignored).

### Conduit

Аккаунты `conduit.ozdoev.net` (Anthropic-совместимый, ключи `sk-cdt-`), авторизация кабинета **только через Telegram** (device-code, без Playwright).

- **Автореги из ТГ** — `conduit/conduit_autoreger.js` берёт ТГ из **общего пула** с FreeModel, подписывается на канал, поллит авторизацию. Реф-цепочка парами 2+2.
- Баланс/план/лимиты + **шкала запаса**, активация ключа через API Helper (`cdt-active-key.txt`).

### Telegram — пул сессий (общий для FreeModel и Conduit)

Готовые TG-аккаунты в дашборде: **импорт → хранение → привязка → ✈ открыть в Telegram Desktop**. Один аккаунт = `auth_key + dc_id`, номер опционален. Импорт списком (`phone|hex:dc`, `hex:dc`, …) или `.session`-файлом. **🩺 Health-чек** (`getMe()`, read-only). Один ТГ можно регать и на FreeModel, и на Conduit.

> ✈ Открыть требует `tools/tg-venv` + портативный Telegram — см. установщик (шаг 8) или ручной блок.

### Video / Картинки API

Два близнецовых модуля — чистый CRUD-стор ключей провайдеров (видео и картинок: NanoBanana, fal, Replicate, Imagen, …). Фильтр по провайдеру, маска ключа (👁/📋), триал-каталог. Файлы `routing/{video,image}-keys.json` (gitignored, есть `*.example`).

### Плагины

Вкл/выкл плагинов Claude Code — тоггл `enabledPlugins` через `/api/settings/apply`. Кнопка **★ Включить рекомендованные** добавляет курируемый набор, не трогая остальное.

### Настройки

- **OmniRoute** — `OMNIROUTE_BASE_URL` + `OMNIROUTE_API_KEY` (scope **manage**) → пишется в `routing/.env`, применяется сразу.
- **Бэкапы `settings.json`** — создать / ↩ восстановить / 🗑 удалить (`~/.claude/settings-backups/`).

---

## Telegram-пульт (`tgbot/`)

Удалёнка с телефона: переключать бэкенды/ключи как на дашборде + живая claude-сессия. Тонкий HTTP-клиент к `:8200`, логику ротации не дублирует.

- **Whitelist обязателен** (`ALLOWED_USERS` — Telegram ID): бот выполняет произвольный код через `claude --dangerously-skip-permissions`.
- Команды: `/status`, `/backends` (inline-свич), `/cd`, `/pwd`, `/new`, `/stop`; свободный текст → claude.
- Запуск: `npm run tgbot`. Подробности — [`tgbot/README.md`](tgbot/README.md).

---

## OpenCode

OmniRoute — обычный OpenAI-совместимый endpoint, в него можно ходить и из [OpenCode](https://opencode.ai). Добавь провайдер в `opencode.json` — ключ тот же `OMNIROUTE_API_KEY`, что и в `routing/.env`. Бонус: разные агенты → разные модели через один OmniRoute.

<details>
<summary><b>opencode.json</b> — провайдер OmniRoute + пример агентов</summary>

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "omniroute/tokenrouter/kimi-k2p7-code",
  "small_model": "omniroute/tokenrouter/deepseek-v4-flash",
  "provider": {
    "omniroute": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniRoute",
      "options": {
        "baseURL": "http://localhost:20128/v1",
        "apiKey": "<OMNIROUTE_API_KEY>",
        "timeout": 600000
      },
      "models": {
        "tokenrouter/deepseek-v4-pro":      { "name": "DeepSeek V4 Pro" },
        "tokenrouter/kimi-k2p7-code":       { "name": "Kimi K2.7 Code" },
        "tokenrouter/qwen3p7-plus":         { "name": "Qwen 3.7 Plus" }
      }
    }
  },
  "agent": {
    "review": {
      "description": "Баг-хантер",
      "model": "omniroute/tokenrouter/deepseek-v4-pro",
      "prompt": "You are a senior code reviewer. Find bugs, security issues, and bad patterns. Be concise.",
      "tools": { "write": false, "edit": false, "bash": false }
    }
  }
}
```
</details>

## Reference

<details>
<summary><b>Скрипты</b></summary>

```bash
# FreeModel автореги (N подряд, override стартового инвайта)
node freemodel/freemodel_autoreger_v3.js [N] [FRE-invite]

# Conduit автореги (из общего ТГ-пула)
node conduit/conduit_autoreger.js [N]

# Routing
routing/restart-dashboard.bat            # рестарт rotator :20126 + switcher :8200
routing/PANIC-restore-omniroute.bat      # откат settings.json на OmniRoute
node routing/transparent-proxy.js        # switcher вручную
```
</details>

<details>
<summary><b>Структура и конфиги</b></summary>

| Папка / файл | Что |
| :--- | :--- |
| `install.sh` | Интерактивный установщик с нуля |
| `routing/transparent-proxy.js` | Switcher :8200 + HTTP API дашборда |
| `routing/proxy-dashboard.html` | UI (Tailwind) |
| `routing/freemodel-rotator.js` | Ротатор FreeModel-ключей :20126 |
| `routing/{video,image}-keys.json` | Хранилища ключей провайдеров (gitignored, есть `*.example`) |
| `routing/al-sessions.json` | Пул Aerolink (gitignored, есть `*.example`) |
| `routing/.env` | **Секреты** (gitignored) — `OMNIROUTE_API_KEY` |
| `internal/dashboard-api.js` | Прослойка CLI ↔ HTTP (FreeModel + Conduit) |
| `internal/freemodel-manager.js` | FreeModel-сессии + квоты + TG-пул |
| `conduit/` | Conduit: клиент, менеджер, автореги, рекордер сессии |
| `freemodel/lib/tg-*.js` · `tools/tg-open.py` | Telegram: пул, парсер `.session`, привязка, health, открытие |
| `tgbot/` | Telegram-пульт (`bot.js` + `.env`) |
| `~/.claude/settings.json` | Активный backend (Switcher редактирует) |
| `manual_sessions/` · `ready_to_sell/` · `tools/{tg-venv,telegram-portable,tg-profiles}` | _gitignored_ |
| `menu.js` | TUI-меню (всё-в-одном) |

</details>

## Troubleshooting

<table>
<tr><th align="left">Симптом</th><th align="left">Причина / фикс</th></tr>
<tr>
  <td>CC говорит <code>Not logged in · Please run /login</code></td>
  <td>В <code>settings.json</code> попал не тот ключ →&nbsp; <code>routing/PANIC-restore-omniroute.bat</code></td>
</tr>
<tr>
  <td>Ключи не ротируются «на лету» / нужен релогин после свича</td>
  <td>Claude Code не <code>2.1.179</code> или включён авто-апдейт. Зафиксируй версию + <code>autoUpdates:false</code> (см. Установка)</td>
</tr>
<tr>
  <td>Дашборд не открывается / <code>:8200</code> занят</td>
  <td><code>routing/restart-dashboard.bat</code> — сам убивает старый процесс на :8200 (и legacy :8300)</td>
</tr>
<tr>
  <td>Квоты в кеше устарели</td>
  <td>Кнопка <b>🔄 Квоты ~30s</b> в табе — перепрогон через headless Chrome</td>
</tr>
<tr>
  <td><b>✈ Открыть</b> падает / <code>нет tools/tg-venv</code></td>
  <td>Не создан venv или нет бинаря Telegram — перезапусти <code>bash install.sh</code> (шаг 8). Проверка: <code>tools/tg-venv/Scripts/python.exe tools/tg-open.py &lt;phone&gt; --check</code></td>
</tr>
</table>

## Безопасность

- Реальные API-ключи — в `routing/.env` + `*-active-key.txt` (gitignored); роутер подменяет их на лету, CC получает только литеральный токен.
- `settings.json` бэкапится перед каждым изменением (`*.bak-<timestamp>`).
- Gitignored: `routing/.env` · `tgbot/.env` · `routing/{al-sessions,video-keys,image-keys}.json` · `manual_sessions/` · `ready_to_sell/` · `freemodel/{sessions,tg_pool.json}` · `conduit/accounts/` · `tools/{tg-venv,telegram-portable,tg-profiles}` · `*.png`.

Перед коммитом:

```bash
git diff --cached | grep -E "sk-[a-z]{2,}-[a-f0-9]+|auth_key_hex|fe_oa_|aero_live_" || echo "OK: no keys in staged diff"
```

## Disclaimer

Образовательные цели. Используй в рамках ToS соответствующих сервисов (FreeModel, Conduit, Aerolink, Anthropic).

## License

MIT
