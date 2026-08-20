#!/usr/bin/env bash
# Установщик дашборда на macOS. Аналог install.sh (Windows/git-bash) для Mac.
#
# Ни одной строки существующего кода не трогает: только ставит зависимости,
# копирует *.example → рабочие конфиги и поднимает дашборд через restart-dashboard.sh.
#
# Запуск:  bash install-mac.sh   (изнутри репо)
#          или одной строкой на голом маке — см. блок Bootstrap ниже.
set -u

# Где лежит сам скрипт. При запуске одной строкой файла на диске нет:
# BASH_SOURCE пуст, $0 = "bash" → dirname даёт ".", то есть текущую папку,
# и проверка в Bootstrap уводит в клонирование репо.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || SELF_DIR="$PWD"

b()   { printf '\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m  ! %s\033[0m\n' "$*"; }
err() { printf '\033[31m  ✗ %s\033[0m\n' "$*"; }
step(){ printf '\n\033[36m── %s\033[0m\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }

b "══════════════════════════════════════════════"
b "  Vibe-Code Account Creator Manager"
b "  Установка для macOS"
b "══════════════════════════════════════════════"

# 0. Bootstrap — установка одной строкой на голом маке, где нет ни git, ни репо:
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/WormAlien/vibe-code-account-creator-manager/master/install-mac.sh)"
#
# Именно `bash -c "$(curl …)"`, а НЕ `curl … | bash`: при пайпе stdin занят самим
# скриптом, и все интерактивные `read` ниже (Xcode CLT, «запустить дашборд?»)
# читают мусор вместо ответа юзера. Через -c stdin остаётся терминалом.
# Аналог install.ps1 для Windows: ставим git → клонируем → перезапускаем себя из клона.
REPO_URL="https://github.com/WormAlien/vibe-code-account-creator-manager.git"
REPO_NAME="vibe-code-account-creator-manager"

if [ ! -f "$SELF_DIR/package.json" ] || [ ! -f "$SELF_DIR/routing/restart-dashboard.sh" ]; then
  step "Bootstrap: репо рядом нет — качаю"

  # На чистом маке `command -v git` ВРЁТ: /usr/bin/git существует всегда, но это
  # shim от Command Line Tools — при вызове он лишь открывает диалог «установить
  # инструменты разработчика» и возвращает ошибку. Поэтому годность git проверяем
  # через xcode-select -p (сами CLT), а не по наличию файла.
  if ! xcode-select -p >/dev/null 2>&1; then
    warn "Command Line Tools не стоят (в них git) — ставлю. Откроется окно, дождись конца."
    xcode-select --install >/dev/null 2>&1 || true
    echo "  Когда установка закончится — нажми Enter..."
    read -r _
    xcode-select -p >/dev/null 2>&1 || { err "CLT не установились. Поставь вручную (xcode-select --install) и запусти снова."; exit 1; }
  fi
  git --version >/dev/null 2>&1 || { err "git не работает даже после CLT. Проверь: git --version"; exit 1; }
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"

  # Куда клонировать: рядом с текущей папкой, как install.ps1. Переопределяется VCACM_DIR=…
  DEST="${VCACM_DIR:-$PWD/$REPO_NAME}"
  if [ -f "$DEST/$REPO_NAME/package.json" ]; then
    err "двойная вложенность: $DEST/$REPO_NAME — убери внешний дубль до установки."
    exit 1
  fi
  if [ -d "$DEST/.git" ]; then
    ok "репо уже склонировано → $DEST"
  else
    git clone "$REPO_URL" "$DEST" || { err "git clone не удался — проверь вывод выше."; exit 1; }
    ok "склонировано → $DEST"
  fi

  chmod +x "$DEST/install-mac.sh" 2>/dev/null
  # Права на файлы git с Windows не хранит (всё приезжает как 100644), а на маке мы
  # их доставляем сами — chmod'ом здесь и в restart-dashboard.sh для shim-ов. Для git
  # это выглядит как локальная правка, и следующий `git pull` встаёт с «your local
  # changes would be overwritten» (поймано живьём: обновление не приезжало, а юзер
  # думал, что код свежий). core.fileMode=false отключает слежку за exec-битом.
  git -C "$DEST" config core.fileMode false 2>/dev/null
  exec bash "$DEST/install-mac.sh"
fi

cd "$SELF_DIR" || { err "не могу перейти в $SELF_DIR"; exit 1; }

# То же для случая, когда репо клонировали руками, а не через bootstrap.
if [ "$(uname)" = "Darwin" ] && [ -d .git ] && [ "$(git config core.fileMode 2>/dev/null)" != "false" ]; then
  git config core.fileMode false 2>/dev/null && ok "git core.fileMode=false (иначе chmod ломает git pull)"
fi

# 1. Xcode Command Line Tools — нужны для сборки нативных модулей (better-sqlite3)
if [ "$(uname)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  step "Xcode Command Line Tools"
  warn "Ставим Command Line Tools. Откроется окно — дождись завершения установки."
  xcode-select --install >/dev/null 2>&1 || true
  echo "  Когда установка закончится — нажми Enter..."
  read -r _
  xcode-select -p >/dev/null 2>&1 || { err "CLT не установились. Прервано."; exit 1; }
fi

# 2. Homebrew
#
# Установщик Homebrew НЕ добавляет brew в PATH — ни в текущей сессии, ни навсегда.
# На Apple Silicon он кладёт всё в /opt/homebrew (не в /usr/local), которого в
# дефолтном PATH нет, поэтому следующий шаг падал бы с `brew: command not found`,
# а поставленный им node не нашёлся бы потом ни в DASHBOARD.command, ни в
# restart-dashboard.sh. Поэтому: подхватываем brew shellenv в эту сессию и
# дописываем его в ~/.zprofile (zsh — дефолтный шелл macOS с Catalina).
brew_shellenv() {
  local p
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$p" ]; then
      eval "$("$p" shellenv)" 2>/dev/null
      if ! grep -qs "$p shellenv" "$HOME/.zprofile" 2>/dev/null; then
        printf '\neval "$(%s shellenv)"\n' "$p" >> "$HOME/.zprofile"
        ok "brew прописан в ~/.zprofile (иначе node потеряется после перезапуска терминала)"
      fi
      return 0
    fi
  done
  return 1
}

if ! have brew; then
  step "Homebrew"
  warn "Homebrew не найден — ставлю (понадобится пароль sudo)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || exit 1
  brew_shellenv || { err "brew поставился, но не нашёлся в /opt/homebrew и /usr/local. Открой новый терминал и запусти установщик снова."; exit 1; }
  ok "brew $(brew --version 2>/dev/null | head -1)"
else
  brew_shellenv >/dev/null 2>&1 || true
fi

# 3. node / npm / git
step "node / npm / git"
if ! have node || ! have npm || ! have git; then
  brew install node git
fi
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node.js >= 18 обязателен (у тебя $NODE_MAJOR). Обновляю..."
  brew upgrade node
fi
ok "node $(node -v 2>/dev/null || echo '?') · npm $(npm -v 2>/dev/null || echo '?')"

# 4. npm install
step "npm install"
if [ -d node_modules ]; then
  warn "node_modules уже есть — пропускаю. При проблемах: rm -rf node_modules && npm install"
else
  npm install || { err "npm install упал — проверь вывод выше."; exit 1; }
fi
ok "нативные модули собираются автоматически (Xcode CLT уже стоит)"

# 5. Playwright chromium — браузеры для ЛК аккаунтов (AgentRouter/GoRouter/Tabi/GitHub)
step "Playwright chromium"
if node -e "const p=require('playwright');process.exit(require('fs').existsSync(p.chromium.executablePath())?0:1)" 2>/dev/null; then
  ok "chromium уже установлен"
else
  npx playwright install chromium && ok "chromium готов"
fi

# 6. Claude Code
#
# `npm install -g` на маке падает с EACCES, когда npm-префикс — системный
# /usr/local (так стоит Homebrew на Intel и любой node из pkg-установщика):
# /usr/local/lib/node_modules принадлежит root. Раньше эта ошибка глоталась
# (стояло `npm i -g … && ok`), установщик рапортовал успех, а юзер потом получал
# `zsh: command not found: claude` — ровно это и случилось на живом маке.
#
# Лечим без sudo: свой префикс в ~/.npm-global + PATH в ~/.zprofile. Так глобальные
# пакеты ставятся в домашнюю папку, права root не нужны, и claude виден и в новых
# терминалах, и в DASHBOARD.command (двойной клик → login-shell zsh).
step "Claude Code"
if have claude; then
  ok "claude уже стоит: $(claude --version 2>/dev/null || echo '?')"
else
  if ! npm install -g @anthropic-ai/claude-code 2>/dev/null; then
    warn "нет прав на глобальную папку npm ($(npm prefix -g 2>/dev/null)) — переношу её в ~/.npm-global"
    npm config set prefix "$HOME/.npm-global"
    mkdir -p "$HOME/.npm-global/bin"
    export PATH="$HOME/.npm-global/bin:$PATH"
    if ! grep -qs '.npm-global/bin' "$HOME/.zprofile" 2>/dev/null; then
      printf '\nexport PATH="$HOME/.npm-global/bin:$PATH"\n' >> "$HOME/.zprofile"
      ok "~/.npm-global/bin прописан в ~/.zprofile"
    fi
    npm install -g @anthropic-ai/claude-code || warn "не установился — поставь вручную: npm install -g @anthropic-ai/claude-code"
  fi
  if have claude; then ok "Claude Code установлен: $(claude --version 2>/dev/null || echo '?')"
  else warn "claude всё ещё не виден в PATH — открой НОВЫЙ терминал и проверь: claude --version"; fi
fi

# 7. Конфиги из *.example (существующие не перезаписываем)
step "Локальные конфиги"
mkdir -p "$HOME/.claude"
copy_example() {
  local src="$1" dst="$2"
  if [ -f "$dst" ]; then
    warn "пропускаю: уже есть $dst"
  elif [ -f "$src" ]; then
    cp "$src" "$dst" && ok "$src → $dst"
  else
    warn "нет шаблона $src — пропускаю"
  fi
}
copy_example claude-settings.example.json "$HOME/.claude/settings.json"
copy_example routing/.env.example routing/.env
copy_example routing/al-sessions.example.json routing/al-sessions.json
copy_example routing/video-keys.example.json routing/video-keys.json
copy_example routing/image-keys.example.json routing/image-keys.json
copy_example tgbot/.env.example tgbot/.env

# Статус-лайн: в шаблоне settings.json секции statusLine нет, а существующий файл
# мы не перезаписываем — поэтому включаем отдельно, дописывая ровно эту секцию.
# Иначе бар внизу CC просто выключен, и юзер об этом не догадывается.
# Вывод НЕ глушим: раньше стояло >/dev/null, и причина отказа («в settings.json
# свой statusLine», «settings.json не читается как JSON») терялась — оставался
# только общий warn, по которому чинить нечего.
if sl_out="$(node tools/enable-statusline.js 2>&1)"; then
  ok "статус-лайн включён (провайдер/модель · баланс · контекст)"
  printf '%s\n' "$sl_out" | sed 's/^/    /'
else
  warn "статус-лайн включить не удалось — вручную: node tools/enable-statusline.js"
  printf '%s\n' "$sl_out" | sed 's/^/    /'
fi

# 8. Права + карантин macOS
step "Права и карантин macOS"
# exec-bit теперь хранится в индексе git (100755), но старые клоны приехали как
# 100644, а core.fileMode=false заставляет git молчать о разнице — поэтому ставим
# сами. Без этого двойной клик по DASHBOARD.command падает с «нет прав доступа»,
# а node не может позвать shim-ы через execFile.
chmod +x mac-support/shims/* routing/*.sh DASHBOARD.command install-mac.sh 2>/dev/null
ok "shim-ы и скрипты — executable"
# Карантин (com.apple.quarantine) вешается на всё, что скачано: .command тогда не
# запускается двойным кликом вообще, без внятной ошибки.
xattr -cr . 2>/dev/null && ok "карантин снят"

# 9. Запуск
step "Запуск дашборда"
b "  Дашборд: http://localhost:8200/__switch"
if [ -t 0 ]; then
  read -r -p "Запустить дашборд сейчас? [Y/n] " ans
  case "${ans:-Y}" in
    y|Y|д|Д|yes|да) bash routing/restart-dashboard.sh ;;
    *) echo "  Запусти позже: bash routing/restart-dashboard.sh (или двойной клик на DASHBOARD.command)" ;;
  esac
else
  bash routing/restart-dashboard.sh
fi

# 10. Памятка. Печатаем в конце, потому что выше уже прокрутилось много вывода, а
# «как остановить» и «можно ли переносить папку» — первые два вопроса на маке.
cat <<EOF

$(b "── Шпаргалка ──────────────────────────────────────")
  Запуск     двойной клик DASHBOARD.command  ·  bash routing/restart-dashboard.sh
  Стоп       bash routing/stop-dashboard.sh
             (на маке дашборд живёт в фоне — закрыть Terminal НЕ достаточно)
  Дашборд    http://localhost:8200/__switch

  Перенос или переименование папки: стоп → перенести → запустить из нового места.
  Больше ничего, путь нигде не прописан. Если в пути есть пробелы — в терминале
  бери его в кавычки: cd "/путь/с пробелом/VibeCode"

  Обновление   git pull  (потом рестарт дашборда)
  Диагностика  node tools/mac-balance-probe.js ar   — точный баланс по шагам
               node tools/enable-statusline.js      — вернуть статус-бар в CC

EOF

exit 0