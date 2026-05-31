# Vibe-Code Account Creator Manager

> Полный тулкит для управления Devin · Notion · FreeModel аккаунтами +
> локальный роутер бэкендов для Claude Code (OmniRoute ↔ notion-manager).

<p align="center">
  <img src="https://img.shields.io/badge/Node-18%2B-43853d?style=flat-square&logo=node.js&logoColor=white">
  <img src="https://img.shields.io/badge/Playwright-Chromium-2EAD33?style=flat-square&logo=playwright&logoColor=white">
  <img src="https://img.shields.io/badge/Tailwind-v4-38bdf8?style=flat-square&logo=tailwindcss&logoColor=white">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
</p>

---

## 📦 Что внутри

Три независимых саб-системы под одной крышей:

| Саб-система | Что делает | Где живёт |
|---|---|---|
| 🤖 **Devin** — автореги | Создаёт Pro-аккаунты devin.ai с картой/прокси/локалью | `autoreger.js`, `internal/`, `menu.js` |
| 📝 **Notion** — автореги | Создаёт Notion-аккаунты, привязывает карту, фиксит trial | `notion/`, `notion_workflow.js` |
| 🆓 **FreeModel** — сессии | Менеджит сессии freemodel.dev (Claude через клуб) | `freemodel/`, `manual_sessions/` |
| 🔀 **Routing dashboard** | Web-UI на `:8200` — переключатель backend для Claude Code + менеджер всех 3х систем | `routing/`, `internal/dashboard-api.js` |

---

## 🚀 Быстрый старт

```bash
# 1. Зависимости
npm install
npx playwright install chromium

# 2. Конфиг
cp routing/.env.example routing/.env
# → заполни OMNIROUTE_API_KEY и NOTION_API_KEY

# 3. Запуск дашборда
routing\restart-dashboard.bat     # Windows: один клик
# или: node routing/transparent-proxy.js

# → откроется http://localhost:8200/__switch
```

```bash
# Альтернатива — классическое TUI меню
node menu.js
```

---

## 🖥 Routing dashboard

Открой `http://localhost:8200/__switch` — четыре вкладки в сайдбаре:

### 🔀 Switcher
Переключает Claude Code между двумя бэкендами одним кликом:

```
┌─────────────────────────────────────────┐
│  Active backend                          │
│  ● FreeModel (OmniRoute)                 │ ← пульсирующая точка
│  http://localhost:20128/v1               │
└─────────────────────────────────────────┘

┌──────────────────┐  ┌──────────────────┐
│ 🟢 FreeModel  ✓  │  │ 🔵 Notion        │
│ tools/vision/big │  │ cheap, без tools │
│ OmniRoute :20128 │  │ notion-mgr :8190 │
└──────────────────┘  └──────────────────┘
```

Клик переписывает `~/.claude/settings.json` (с `.bak-<timestamp>` бэкапом) — после нужно **перезапустить Claude Code**.

**Whoami** — вставляешь ID из лога OmniRoute (`anthropic-compatible-...:fd48f370-...`), показывает кто это (email/name/status) из локальной БД OmniRoute.

### 🤖 Devin / 🆓 FreeModel / 📝 Notion

Список сессий с **прогресс-барами квот** (цвет по порогам: 🟢 <40% · 🟡 40–70% · 🔴 >70%), фильтром, сортировкой и **действиями на каждой строке**:

| Кнопка | Что |
|---|---|
| 🌐 | открыть в headed Chrome (Notion.so / app.devin.ai/settings/usage / claude.ai/usage) |
| 🔄 | обновить квоту через headless Playwright (~1–3s) |
| ➕ | создать новую сессию (запускает `node ...` в новом окне cmd) |
| 🗑 | удалить папку сессии + кеш |

**Сортировка** — дата ↑/↓ · статус · план Pro→Free · квота (меньше/больше использовано) · доступно $ · свежесть кеша · email.

### 💳 Card picker (Notion)

3 карты-пресета (`CARD_PRESETS` из `notion/config.js`) + опция «🔄 Ротация». Клик — обновляется `CARD_PRESET_INDEX` через regex-replace в `notion/config.js`, без рестарта.

---

## 🏗 Архитектура роутинга

```
                  ┌─────────────────────────┐
                  │   Claude Code (CC)      │
                  │   settings.json env:    │
                  │   ANTHROPIC_BASE_URL    │
                  └───────────┬─────────────┘
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
        ┌─────────────────┐     ┌──────────────────┐
        │  OmniRoute      │     │  notion-manager  │
        │  :20128/v1      │     │  :8190           │
        │  Pro/Max OAuth  │     │  Notion bypass   │
        │  + FreeModel    │     │                  │
        │    pool         │     │                  │
        └─────────────────┘     └──────────────────┘

         ▲                                ▲
         │                                │
         │  переключение через            │
         │  ┌──────────────────────────┐  │
         └──┤  Switcher :8200          ├──┘
            │  (transparent-proxy.js)  │
            │  редактит settings.json  │
            └──────────────────────────┘
```

**Важно:** CC принимает в `settings.json` **только** ключ `sk-local-dev-key` (внутренний bypass-токен OmniRoute) — любой другой даёт «Not logged in · Please run /login». Реальные API-ключи живут в `routing/.env` (gitignored), их подставляет роутер.

---

## 📜 Скрипты

### Главное меню
```bash
node menu.js               # Полное интерактивное TUI меню
```

### Devin
```bash
node autoreger.js          # Прямой запуск создания аккаунтов
node internal/bin-lookup.js  # BIN-генератор (148 BIN, 12 стран)
```

### Notion
```bash
node notion/notion_workflow.js     # Создать Notion-аккаунт (с картой)
```

### FreeModel
```bash
node freemodel/create_first_session.js   # Логин + сохранение сессии
node freemodel/login_and_save_session.js # Альтернативный вход
node freemodel/restore_session.js        # Восстановить из cookies
```

### Routing
```bash
routing\restart-dashboard.bat            # Перезапуск :8200 (Windows)
routing\PANIC-restore-omniroute.bat      # Откат settings.json на OmniRoute
node routing/transparent-proxy.js        # Switcher вручную
node routing/smart-router-v3.js          # Auto-router :8201 (экспериментальный)
```

---

## ⚙ Конфигурация

| Файл | Что настраивает |
|---|---|
| `config.js` | Devin: BINs · proxy · billing · headless · sound · timing |
| `notion/config.js` | Notion: CARD_PRESETS · CARD_PRESET_INDEX · proxy · viewport |
| `freemodel/config.js` | FreeModel: URLs · паттерны email · таймауты |
| `routing/.env` | **Секреты** (gitignored): `OMNIROUTE_API_KEY`, `NOTION_API_KEY` |
| `~/.claude/settings.json` | Активный backend (Switcher редактирует) |

---

## 🗂 Структура

```
.
├── routing/                  # 🆕 Web-дашборд + локальные роутеры
│   ├── transparent-proxy.js  # Switcher на :8200 + HTTP API дашборда
│   ├── proxy-dashboard.html  # Tailwind v4 UI (OKLCH палитра, Geist)
│   ├── smart-router-v3.js    # Авто-роутер :8201 (по telu запроса)
│   ├── restart-dashboard.bat # One-click рестарт
│   ├── PANIC-restore-omni…   # Откат settings.json
│   ├── .env                  # 🔒 gitignored — реальные ключи
│   └── .env.example          # template
│
├── internal/
│   ├── dashboard-api.js      # Чистая прослойка CLI ↔ HTTP
│   ├── devin-manager.js      # Devin сессии (manual + ready + errors)
│   ├── freemodel-manager.js  # FreeModel сессии + квоты
│   ├── notion-manager.js     # Notion сессии
│   ├── autoreger.js          # Логика создания Devin-аккаунтов
│   └── bin-lookup.js         # БД BIN + Luhn генератор
│
├── notion/                   # Notion autoreg
│   ├── notion_workflow.js
│   ├── config.js             # CARD_PRESETS, CARD_PRESET_INDEX
│   └── sessions/             # 🔒 gitignored
│
├── freemodel/                # FreeModel
│   ├── create_first_session.js
│   ├── freemodel_autoreger.js
│   └── sessions/             # 🔒 gitignored
│
├── manual_sessions/          # 🔒 Devin + FreeModel сессии
├── ready_to_sell/            # 🔒 Готовые Pro-сессии Devin
├── errors/                   # 🔒 Не-успешные попытки
│
├── menu.js                   # 1600-строчное TUI меню (всё-в-одном)
├── autoreger.js              # Главный entry point Devin
├── start.js                  # Альтернативный entry с CLI-аргументами
└── config.js                 # Корневой конфиг (Devin)
```

🔒 = в `.gitignore`, не в репозитории.

---

## 🔧 Troubleshooting

### CC говорит «Not logged in · Please run /login»
Ты подставил в `settings.json` **реальный** ключ вместо `sk-local-dev-key`.
CC принимает только эту литералку. Откати:
```bash
routing\PANIC-restore-omniroute.bat
```

### Дашборд не открывается / `:8200` занят
```bash
routing\restart-dashboard.bat
# Скрипт сам убивает старый процесс и поднимает новый
```

### Кнопка ➕ «Создать сессию» не открывает окно
Скрипт спавнится через `cmd /c start`. На Windows-сервере без интерактивной сессии окна не будет — запускай вручную через `node menu.js`.

### Квоты в кеше устарели
Кнопка **🔄 Квоты ~30s** в каждой вкладке Accounts перепрогоняет все сессии через headless Chrome и обновляет кеш.

### Whoami ничего не находит
Скрипт парсит **8-символьные hex-префиксы** из любого текста. Проверь что в строке есть хотя бы один UUID-фрагмент. Если есть — нет такого аккаунта в `~/.omniroute/storage.sqlite`.

---

## 🛡 Безопасность

- Все реальные API-ключи — в `routing/.env` (gitignored)
- `settings.json` бэкапится перед каждым изменением (`*.bak-<timestamp>`)
- Сессии (`manual_sessions/`, `ready_to_sell/`, `notion/sessions/`, `freemodel/sessions/`) — gitignored
- Скриншоты ошибок (`*.png`) — gitignored

Перед коммитом полезно прогнать:
```bash
git diff --cached | grep -E "sk-[a-z]{2,}-[a-f0-9]+" || echo "OK: no keys in staged diff"
```

---

## 🤝 Community

Сделано благодаря помощи и активности сообщества.

Присоединяйся: **https://t.me/abuz_ai**

---

## ⚖ Disclaimer

Этот инструмент только для образовательных целей. Используй ответственно и в рамках Terms of Service соответствующих сервисов (Devin.ai, Notion, FreeModel, Anthropic).

## 📄 License

MIT
