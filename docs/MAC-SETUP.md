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
| `install-mac.sh` | Bootstrap (git → clone → перезапуск из клона) + установщик: Homebrew → node/git → `npm install` → Playwright chromium → Claude Code → конфиги → запуск |
| `DASHBOARD.command` | Двойной клик для запуска (снимает карантин `xattr`) |

## Быстрый старт

Одной строкой в Терминале на голом маке (нет ни git, ни репо):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/WormAlien/vibe-code-account-creator-manager/master/install-mac.sh)"
```

Bootstrap-блок в начале `install-mac.sh` ставит Command Line Tools (в них git),
клонирует репо в текущую папку и через `exec` перезапускает себя изнутри клона —
дальше идёт обычная установка. Путь клона переопределяется `VCACM_DIR`:

```bash
VCACM_DIR="$HOME/Documents/VibeCode" /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/WormAlien/vibe-code-account-creator-manager/master/install-mac.sh)"
```

Заданная папка становится корнем репо (без вложенной `vibe-code-account-creator-manager`
внутри), промежуточные каталоги создаст git. Папка должна отсутствовать или быть
пустой — иначе `git clone` откажется. `Documents` писать латиницей, хотя Finder
показывает «Документы».

Проверено на чистом MacBook: одна вставка, дальше Enter. Реагировать надо в трёх местах:

1. окно **«Установить инструменты разработчика»** → Установить, подождать 5–10 минут,
   вернуться в Терминал и нажать **Enter** — скрипт ждёт именно этого;
2. **пароль от мака** — просит установщик Homebrew (`sudo`), вводится слепо;
3. **доступ к папке «Документы»** (если ставишь туда) → OK. Нажал «Запретить» —
   *Системные настройки → Конфиденциальность и безопасность → Файлы и папки → Терминал*.

**Почему `bash -c "$(curl …)"`, а не `curl … | bash`:** при пайпе stdin занят
телом скрипта, и интерактивные `read` (ожидание Command Line Tools, «запустить
дашборд?») читают не ответ юзера, а остаток скрипта. Через `-c` stdin остаётся
терминалом. Ровно так же ставит себя Homebrew.

Две грабли голой системы, из-за которых наивный bootstrap не работал:
`command -v git` **врёт** (в `/usr/bin/git` лежит shim от CLT: без них он только
открывает диалог установки и падает) — поэтому проверяем `xcode-select -p`.
И установщик Homebrew **не кладёт brew в PATH**: на Apple Silicon это
`/opt/homebrew/bin`, которого в дефолтном PATH нет, так что `brew install node`
не нашёлся бы, а поставленный node потерялся бы для `DASHBOARD.command`.
`brew_shellenv()` подхватывает его в сессию и дописывает в `~/.zprofile`.

Если git уже есть и хочется вручную:

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
- проверка баланса — точная, куками профиля Chromium. **Ключ куки на macOS берётся
  иначе, чем на Windows** (Keychain «Chromium Safe Storage» + PBKDF2-SHA1/1003 и
  AES-128-CBC вместо Local State/DPAPI + AES-256-GCM) — ветка `darwin` в
  `routing/lib/newapi-account.js`. Пока её не было, точный баланс молча падал в
  «~ прикидку». Диагностика: `node tools/mac-cookie-probe.js`,
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