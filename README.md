<div align="center">

# Vibe-Code Account Creator Manager

Локальная control-plane для автореги аккаунтов (`FreeModel` · `TokenRouter`) и переключения backend'а Claude Code между **FreeModel**, **OmniRoute** и **TokenRouter** — одним кликом из веб-дашборда.

<br>

![Dashboard](docs/dashboard.png)

<sub>Backend Switch · <code>localhost:8200/__switch</code> — менеджер FreeModel-сессий с пулом Telegram-привязок и квотами</sub>

<br>

</div>

## Установка

```bash
# 1. Node-зависимости + браузер для Playwright (FreeModel)
npm install
npx playwright install chromium

# 2. Python + Camoufox — только для вкладки TokenRouter (Firefox + patched Juggler)
pip install camoufox requests
python -m camoufox fetch          # скачивает браузер один раз

# 3. Секреты
cp routing/.env.example routing/.env
#   OMNIROUTE_API_KEY — впиши сюда или задай позже через дашборд → Настройки

# 4. Запуск дашборда (поднимает freemodel-rotator :20126 + switcher :8200)
routing\restart-dashboard.bat     # Windows — один клик, сам убивает старый процесс
# или вручную:
#   node routing/freemodel-rotator.js
#   node routing/transparent-proxy.js

# 5. Открой http://localhost:8200/__switch
```

> [!NOTE]
> Python/Camoufox нужен **только** для TokenRouter. FreeModel работает на Playwright (Chromium).

Альтернатива — классическое TUI-меню: `node menu.js`

## Что это

Автореги под одной крышей + веб-дашборд, который переключает backend Claude Code и менеджит все сессии:

<div align="center">

| Саб-система | Что делает | Файлы |
| :--- | :--- | :--- |
| **FreeModel** | Аккаунты `freemodel.dev` (Claude через клуб) + пул Telegram для привязки + ротация ключей | `freemodel/` · `internal/freemodel-manager.js` · `routing/freemodel-rotator.js` |
| **TokenRouter** | Аккаунты `tokenrouter.me` через Camoufox-автореги; трекинг баланса / health / usage | `routing/tokenrouter/` · `camoufox_autoreg.py` |
| **Backend Switch** | Web-UI на `:8200` — переключатель backend + менеджер всех сессий | `routing/transparent-proxy.js` · `routing/proxy-dashboard.html` |

</div>

## Дашборд

`http://localhost:8200/__switch`. Сайдбар: **Switcher · FreeModel · TokenRouter · Настройки** (+ Whoami).

### Switcher

Переключает Claude Code между бэкендами одним кликом — переписывает `~/.claude/settings.json` (с `.bak-<timestamp>` бэкапом). После — **перезапустить Claude Code**.

<div align="center">

| | Backend | Когда |
| :---: | :--- | :--- |
| 🟢 | **FreeModel** — `cc.freemodel.dev` (через ротатор `FREEMODEL_ROTATOR` на `:20126`) | основной — пул ключей, авто-ротация |
| 🔀 | **OmniRoute** — `localhost:20128/v1` | Pro/Max OAuth + локальный пул |

</div>

> [!IMPORTANT]
> Реальные API-ключи живут в `routing/.env` (gitignored); роутер подменяет их на лету, а CC получает только литеральный токен. Если в `settings.json` попал не тот ключ → `Not logged in · Please run /login` → откат `routing\PANIC-restore-omniroute.bat`.

**Whoami** — вставляешь ID из лога OmniRoute (`anthropic-compatible-...:fd48f370-...`), скрипт находит email / name / status в локальной БД.

### FreeModel

Менеджер сессий `freemodel.dev` с квотами и пулом Telegram-привязок.

- **Активный API в Claude Code** — какой ключ сейчас в `settings.json`.
- **Telegram pool** — готовые TG-аккаунты (`phone|auth_key_hex:dc`) для привязки к новым freemodel-аккаунтам. Расходуются по порядку: `free → used → banned`. Импорт списком или `.session`.
- **Сессии** — таблица с таймером, доступным `$`, окнами 5h/7d и квотой. **➕ Создать v3** реги пачкой, **🔄 Квоты ~30s** перепрогон через headless Chrome.

**Цвет квоты:** 🟢 < 40% · 🟡 40–70% · 🔴 > 70%

### TokenRouter

![TokenRouter](docs/tokenrouter.png)

Аккаунты `tokenrouter.me`, зарегистрированные через Camoufox (`routing/tokenrouter/camoufox_autoreg.py`). Данные — `routing/tokenrouter/accounts.json` (gitignored).

<div align="center">

| Колонка | Что |
| :--- | :--- |
| **Health** | 🟢 LIVE / ❌ ERR — живой ли ключ |
| **Daily usage** | прогресс-бар расхода против дневного лимита (`$1`/день) |
| **Timer** | когда обнулится дневной лимит |

</div>

Кнопки: **➕ Создать аккаунт** (Camoufox-реги), **🔍 Проверить все**, **💰 Обновить балансы**, **✏ Вручную** (импорт готового). На каждой строке — **⬆ Импорт** ключа в OmniRoute / **🗑 Из OmniRoute** (по manage-API из «Настроек»).

### Настройки

![Настройки](docs/settings.png)

- **OmniRoute — импорт TokenRouter** — `OMNIROUTE_BASE_URL` + manage-ключ, по которому кнопки ⬆ Импорт добавляют email+ключ TokenRouter в OmniRoute. Пишется в `routing/.env`, применяется сразу без рестарта.
- **Бэкапы `settings.json`** — создать / ↩ восстановить / 🗑 удалить конфиг Claude Code (`~/.claude/settings-backups/`). При восстановлении текущий сохраняется автоматически.

## Архитектура

Claude Code читает `~/.claude/settings.json`, берёт оттуда `ANTHROPIC_BASE_URL` + ключ и шлёт запросы в выбранный бэкенд: **FreeModel** через ротатор на `:20126` → `cc.freemodel.dev`, либо **OmniRoute** на `:20128/v1`. **Switcher** на `:8200` (`transparent-proxy.js`) переписывает `settings.json` одним кликом и кладёт `.bak-<timestamp>` рядом. Реальные ключи — в `routing/.env` (gitignored); CC получает только литералку, которую роутер подменяет.

<div align="center">

![Architecture](docs/architecture.svg)

<sub>🟢 FreeModel · 🔵 OmniRoute · 🟣 локальная control-plane (Switcher + .env)</sub>

</div>

## OpenCode

OmniRoute — обычный OpenAI-совместимый endpoint, поэтому в него можно ходить не только из Claude Code, но и из [OpenCode](https://opencode.ai). Добавь провайдер в `opencode.json` (рядом с проектом или в `~/.config/opencode/`) — ключ тот же `OMNIROUTE_API_KEY`, что и в `routing/.env`. Бонус: разные агенты роутятся на разные модели через один OmniRoute (`review` → DeepSeek, `architect` → Qwen).

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
        "tokenrouter/deepseek-v4-flash":    { "name": "DeepSeek V4 Flash" },
        "tokenrouter/glm-5p1":              { "name": "GLM 5.1" },
        "tokenrouter/glm-5p1-fast":         { "name": "GLM 5.1 Fast" },
        "tokenrouter/gpt-oss-120b":         { "name": "GPT-OSS 120B" },
        "tokenrouter/kimi-k2p5":            { "name": "Kimi K2.5" },
        "tokenrouter/kimi-k2p6":            { "name": "Kimi K2.6" },
        "tokenrouter/kimi-k2p7-code":       { "name": "Kimi K2.7 Code" },
        "tokenrouter/kimi-k2p7-code-fast":  { "name": "Kimi K2.7 Code Fast" },
        "tokenrouter/minimax-m2p7":         { "name": "MiniMax M2.7" },
        "tokenrouter/minimax-m3":           { "name": "MiniMax M3" },
        "tokenrouter/qwen3p6-plus":         { "name": "Qwen 3.6 Plus" },
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
    },
    "architect": {
      "description": "План перед кодом",
      "model": "omniroute/tokenrouter/qwen3p7-plus",
      "prompt": "You are a software architect. Output a numbered implementation checklist.",
      "tools": { "write": false, "edit": false }
    }
  }
}
```
</details>

## Скрипты

<details>
<summary><b>FreeModel</b></summary>

```bash
node freemodel/freemodel_autoreger_v3.js          # автореги
node freemodel/freemodel_autoreger_v3.js 5        # 5 подряд
node freemodel/freemodel_autoreger_v3.js 5 FRE-x  # override стартового инвайта
```
</details>

<details>
<summary><b>TokenRouter</b></summary>

```bash
python routing/tokenrouter/camoufox_autoreg.py        # 1 аккаунт
python routing/tokenrouter/camoufox_autoreg.py 5      # 5 подряд
```
</details>

<details>
<summary><b>Routing</b></summary>

```bash
routing\restart-dashboard.bat            # рестарт rotator :20126 + switcher :8200
routing\PANIC-restore-omniroute.bat      # откат settings.json на OmniRoute
node routing/transparent-proxy.js        # switcher вручную
```
</details>

## Конфигурация

<div align="center">

| Файл | Что |
| :--- | :--- |
| `freemodel/config.js` | FreeModel — URLs, паттерны email, таймауты |
| `routing/.env` | **Секреты** (gitignored) — `OMNIROUTE_API_KEY` |
| `~/.claude/settings.json` | Активный backend (Switcher редактирует) |

</div>

## Структура

<div align="center">

| Папка / файл | Что |
| :--- | :--- |
| `routing/transparent-proxy.js` | Switcher :8200 + HTTP API дашборда |
| `routing/proxy-dashboard.html` | UI (Tailwind) |
| `routing/freemodel-rotator.js` | Ротатор FreeModel-ключей :20126 |
| `routing/tokenrouter/camoufox_autoreg.py` | TokenRouter автореги (Camoufox) |
| `routing/restart-dashboard.bat` | One-click рестарт rotator + switcher |
| `routing/PANIC-restore-omniroute.bat` | Откат `settings.json` на OmniRoute |
| `routing/.env` | _gitignored_ — реальные ключи |
| `internal/dashboard-api.js` | Прослойка CLI ↔ HTTP |
| `internal/freemodel-manager.js` | FreeModel-сессии + квоты + TG-пул |
| `freemodel/` · `routing/tokenrouter/` | Auto-reg скрипты |
| `manual_sessions/` · `ready_to_sell/` · `errors/` | _gitignored_ — сессии и ошибки |
| `menu.js` | TUI-меню (всё-в-одном) |

</div>

## Troubleshooting

<table>
<tr><th align="left">Симптом</th><th align="left">Причина / фикс</th></tr>
<tr>
  <td>CC говорит <code>Not logged in · Please run /login</code></td>
  <td>В <code>settings.json</code> попал не тот ключ →&nbsp; <code>routing\PANIC-restore-omniroute.bat</code></td>
</tr>
<tr>
  <td>Дашборд не открывается / <code>:8200</code> занят</td>
  <td><code>routing\restart-dashboard.bat</code> — сам убивает старый процесс на :8200 (и legacy :8300)</td>
</tr>
<tr>
  <td>TokenRouter «Создать аккаунт» падает</td>
  <td>Нет Camoufox: <code>pip install camoufox requests</code> + <code>python -m camoufox fetch</code></td>
</tr>
<tr>
  <td>Кнопка ➕ «Создать сессию» не открывает окно</td>
  <td>Скрипт через <code>cmd /c start</code>. Сервер без интерактивной сессии → запускай через <code>node menu.js</code></td>
</tr>
<tr>
  <td>Квоты в кеше устарели</td>
  <td>Кнопка <b>🔄 Квоты ~30s</b> в табе — перепрогон через headless Chrome</td>
</tr>
</table>

## Безопасность

- Реальные API-ключи — в `routing/.env` (gitignored)
- `settings.json` бэкапится перед каждым изменением (`*.bak-<timestamp>`)
- Приватные данные gitignored: `manual_sessions/` · `ready_to_sell/` · `freemodel/sessions/` · `freemodel/tg_pool.json` · `routing/tokenrouter/accounts.json` · Camoufox-профили · скриншоты (`*.png`)

Перед коммитом полезно:
```bash
git diff --cached | grep -E "sk-[a-z]{2,}-[a-f0-9]+|auth_key_hex" || echo "OK: no keys in staged diff"
```

## Disclaimer

Образовательные цели. Используй в рамках ToS соответствующих сервисов (FreeModel, TokenRouter, Anthropic).

## License

MIT
