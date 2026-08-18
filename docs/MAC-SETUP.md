# Дашборд на macOS (обёртка, без правок кода)

Дашборд рассчитан на Windows, но на Mac работает через **обёртку-совместимость**:
новые файлы в репо подменяют Windows-команды (`netstat`/`taskkill`/`sqlite3`/...)
shim-скриптами, а запуск идёт через `.sh`-аналог `restart-dashboard.bat`.
Существующий код не меняется — Windows-юзеры работают как раньше, код пишется
на Windows и приезжает на Mac обычным `git pull`.

## Что нового в репо

| Файл | Роль |
| --- | --- |
| `mac-support/shims/*` | Выполняемые обёртки: `netstat` (эмитит Windows-формат из `lsof`), `taskkill` (`/F /PID N` → `kill -9 N`), `curl.exe`, `clip.exe`, `python`/`python.exe` |
| `routing/restart-dashboard.sh` | Аналог `.bat`: чистит порты через `lsof`, поднимает ротатор/прокси/дашборд, открывает UI |
| `install-mac.sh` | Установщик: Homebrew → node/git → `npm install` → Playwright chromium → Claude Code → конфиги → запуск |
| `DASHBOARD.command` | Двойной клик для запуска (снимает карантин `xattr`) |

## Быстрый старт

```bash
git clone https://github.com/WormAlien/vibe-code-account-creator-manager.git
cd vibe-code-account-creator-manager
bash install-mac.sh
```

Дальше запуск в любой момент:
- двойной клик на `DASHBOARD.command`, или
- `bash routing/restart-dashboard.sh`

Дашборд: <http://localhost:8200/__switch>

## Что работает

- добавление аккаунтов в пулы (AgentRouter / GoRouter / Tabi Token / GitHub …),
- активация ключа → настройка `~/.claude/settings.json` одним кликом,
- проверка баланса (чистый HTTP через keepalive-прокси, Windows-кода там нет),
- открытие ЛК в браузере (Playwright chromium),
- официальный Claude по OAuth (код уже умеет читать macOS Keychain).

## Ограничения / примечания

- Нужны: **Node.js ≥ 18**, git, Claude Code; Playwright chromium — для браузеров ЛК.
- `node-pty`/`better-sqlite3` собираются автоматически — нужен **Xcode Command Line
  Tools** (`xcode-select --install`), установщик ставит их сам.
- Автореги аккаунтов (Camoufox/rebrowser) и Telegram-пульт — вне охвата этой
  обёртки; они Windows-специфичны и для сценария «свои аккаунты» не нужны.
- Если код дашборда на Windows обновился — на Mac просто сделай
  `git pull` (или кнопка «Обновить» в самом дашборде) и перезапусти `DASHBOARD.command`.

## Windows-юзеры

Ничего не меняется: все `.bat`/`.ps1`/`.js` остаются прежними, обёртка — только
дополнительные файлы (`mac-support/`, `install-mac.sh`, `DASHBOARD.command`,
`routing/restart-dashboard.sh`).