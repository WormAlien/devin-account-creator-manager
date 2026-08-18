#!/usr/bin/env bash
# Установщик дашборда на macOS. Аналог install.sh (Windows/git-bash) для Mac.
#
# Ни одной строки существующего кода не трогает: только ставит зависимости,
# копирует *.example → рабочие конфиги и поднимает дашборд через restart-dashboard.sh.
#
# Запуск:  bash install-mac.sh
set -u
cd "$(dirname "$0")"

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
if ! have brew; then
  step "Homebrew"
  warn "Homebrew не найден — ставлю (понадобится пароль sudo)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || exit 1
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
step "Claude Code"
if have claude; then
  ok "claude уже стоит: $(claude --version 2>/dev/null || echo '?')"
else
  npm install -g @anthropic-ai/claude-code && ok "Claude Code установлен"
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

# 8. Права + карантин macOS
step "Права и карантин macOS"
chmod +x mac-support/shims/* routing/*.sh DASHBOARD.command 2>/dev/null
xattr -cr . 2>/dev/null && ok "карантин снят"
ok "shim-ы и скрипты — executable"

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

exit 0