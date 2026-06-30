# tgbot — ТГ-пульт авторегера

Управляй Claude Code и переключай бэкенды/ключи прямо из Telegram, когда не у компа.

## Что умеет
- **Живая claude-сессия** — пишешь текст, claude выполняет в выбранной папке
  (`claude -p --continue --output-format json`, полный доступ). Контекст держится
  между сообщениями.
- **Переключение бэкендов** как на дашборде `:8200` — кнопками: omniroute / freemodel /
  пулы FreeModel·Aerolink·Conduit, авто-ротация FM.
- **apiKeyHelper «на лету»** — переключение пишет `*-active-key.txt` + `settings.json`
  (TTL=0), следующий запрос claude едет на новом ключе без перезапуска.

## Установка
```bash
cd C:/Users/WormAlien/Desktop/Autoreger_Clean
npm install                       # подтянет telegraf + dotenv
cp tgbot/.env.example tgbot/.env  # затем впиши BOT_TOKEN и ALLOWED_USERS
```
1. Токен — у @BotFather (`/newbot`).
2. Свой ID — у @userinfobot → в `ALLOWED_USERS`.
3. Дашборд должен быть запущен: `routing\restart-dashboard.bat`.

## Запуск
```bash
node tgbot/bot.js
```

## Команды
| Команда | Действие |
|---|---|
| `/status` | активный бэкенд |
| `/backends` | кнопки переключения бэкенда/пула |
| `/cd <path>` | сменить рабочую папку (только `Autoreger_Clean` и `D:\WORMALIENAIGIGANT`) |
| `/pwd` | текущая папка |
| `/new` | новый разговор claude (сброс `--continue`) |
| `/stop` | прервать текущий запрос |
| `<текст>` | → в claude |

## Безопасность
Бот выполняет произвольный код через `claude --dangerously-skip-permissions`.
Единственная защита — `ALLOWED_USERS` (whitelist по Telegram ID). Не пускай чужих,
держи `.env` вне git.

## Как это связано с дашбордом
Бот — тонкий HTTP-клиент к `:8200` (`routing/transparent-proxy.js`). Логику ротации
не дублирует. Переключение в ТГ и в браузере эквивалентны.
