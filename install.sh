#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Интерактивный установщик Vibe-Code Account Creator Manager
#  Запуск в git-bash:   bash install.sh
#  Спрашивает что ставить, собирает секреты, поднимает дашборд.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"

# --- цвета / хелперы --------------------------------------------------------
b() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
err() { printf '\033[31m  ✗ %s\033[0m\n' "$*"; }
step() { printf '\n\033[36m── %s\033[0m\n' "$*"; }

# Да/нет вопрос. ask "Текст?" Y  → дефолт да;  ask "Текст?" N → дефолт нет
ask() {
  local q="$1" def="${2:-Y}" hint ans
  [ "$def" = "Y" ] && hint="[Д/н]" || hint="[д/Н]"
  read -r -p "$q $hint " ans
  ans="${ans:-$def}"
  case "$ans" in y|Y|д|Д|yes|да) return 0 ;; *) return 1 ;; esac
}

# Запрос значения с дефолтом. val=$(prompt "Текст" "дефолт")
prompt() {
  local q="$1" def="${2:-}" ans
  if [ -n "$def" ]; then read -r -p "$q [$def]: " ans; echo "${ans:-$def}";
  else read -r -p "$q: " ans; echo "$ans"; fi
}

# Установить KEY=VALUE в env-файле (заменить строку или добавить)
set_env() {
  local file="$1" key="$2" value="$3"
  [ -f "$file" ] || return 1
  if grep -qE "^${key}=" "$file"; then
    # экранируем спецсимволы для sed-replacement
    local esc; esc=$(printf '%s' "$value" | sed -e 's/[\/&|]/\\&/g')
    sed -i "s|^${key}=.*|${key}=${esc}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

clear
b "════════════════════════════════════════════════════════"
b "  Vibe-Code Account Creator Manager — установщик"
b "════════════════════════════════════════════════════════"
echo "Windows / git-bash. Отвечай Enter = дефолт в скобках."

# ── 0. Проверка системных зависимостей ──────────────────────────────────────
step "0. Системные зависимости"
MISSING=""
for c in node npm git; do
  if have "$c"; then ok "$c $( "$c" --version 2>/dev/null | head -1)"; else err "$c не найден"; MISSING="$MISSING $c"; fi
done
if [ -n "$MISSING" ]; then
  warn "Не хватает:$MISSING"
  if have winget && ask "Поставить через winget?" Y; then
    [[ "$MISSING" == *node* || "$MISSING" == *npm* ]] && winget install -e --id OpenJS.NodeJS.LTS
    [[ "$MISSING" == *git* ]] && winget install -e --id Git.Git
    warn "Перезапусти git-bash после установки и запусти install.sh снова."
    exit 1
  else
    err "Поставь Node.js (nodejs.org) и Git (git-scm.com) и запусти снова."
    exit 1
  fi
fi

# ── 1. Node-зависимости ─────────────────────────────────────────────────────
step "1. Node-зависимости (npm install)"
npm install || { err "npm install упал"; exit 1; }
ok "deps установлены"
if ask "Поставить Chromium для Playwright (нужен FreeModel-квотам/регистрациям)?" Y; then
  npx playwright install chromium && ok "chromium установлен"
fi

# ── 2. Claude Code 2.1.179 ──────────────────────────────────────────────────
step "2. Claude Code (нужна РОВНО 2.1.179 — новее ломает apiKeyHelper)"
CUR=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ "$CUR" = "2.1.179" ]; then
  ok "уже 2.1.179"
elif ask "Текущая: ${CUR:-нет}. Поставить 2.1.179?" Y; then
  npm config delete prefix 2>/dev/null
  npm uninstall -g @anthropic-ai/claude-code 2>/dev/null
  npm install -g @anthropic-ai/claude-code@2.1.179 && ok "Claude Code 2.1.179"
fi

# ── 3. Базовый ~/.claude/settings.json ──────────────────────────────────────
step "3. ~/.claude/settings.json"
CLAUDE_DIR="$HOME/.claude"; mkdir -p "$CLAUDE_DIR"
if [ -f "$CLAUDE_DIR/settings.json" ]; then
  warn "settings.json уже есть — не трогаю (переключатель сам его правит)."
elif ask "Создать из шаблона claude-settings.example.json?" Y; then
  cp claude-settings.example.json "$CLAUDE_DIR/settings.json" && ok "settings.json создан (поправь model под себя)"
fi

# ── 4. Локальные конфиги + секреты ──────────────────────────────────────────
step "4. Локальные конфиги (из *.example, gitignored)"
copy_if_absent() { [ -f "$2" ] && warn "$2 уже есть" || { cp "$1" "$2" && ok "создан $2"; }; }
copy_if_absent routing/.env.example             routing/.env
copy_if_absent routing/al-sessions.example.json routing/al-sessions.json
copy_if_absent routing/video-keys.example.json  routing/video-keys.json
copy_if_absent routing/image-keys.example.json  routing/image-keys.json

if ask "Вписать OMNIROUTE_API_KEY сейчас? (можно позже в дашборде)" N; then
  K=$(prompt "OMNIROUTE_API_KEY (scope manage)")
  [ -n "$K" ] && set_env routing/.env OMNIROUTE_API_KEY "$K" && ok "ключ записан в routing/.env"
fi

# ── 5. OmniRoute (Docker) ───────────────────────────────────────────────────
step "5. OmniRoute backend (Docker, :20128) — опционально"
if ask "Поднять OmniRoute в Docker?" N; then
  if ! have docker; then
    err "docker не найден. Поставь Docker Desktop и запусти снова."
  elif docker ps -a --format '{{.Names}}' | grep -qx omniroute; then
    warn "контейнер omniroute уже есть — пропускаю."
  else
    MSYS_NO_PATHCONV=1 docker run -d --name omniroute \
      -p 20128:20128 -v omniroute-data:/app/data --restart unless-stopped \
      -e PORT=20128 -e HOSTNAME=0.0.0.0 \
      ghcr.io/diegosouzapw/omniroute:latest && ok "omniroute запущен"
    sleep 3
    curl -s -o /dev/null -w '  HTTP %{http_code} на /v1/models\n' http://localhost:20128/v1/models 2>/dev/null
  fi
fi

# ── 6. Telegram-бот (пульт) ─────────────────────────────────────────────────
step "6. Telegram-бот (пульт управления с телефона) — опционально"
SETUP_TG=0
if ask "Настроить ТГ-бота?" N; then
  SETUP_TG=1
  copy_if_absent tgbot/.env.example tgbot/.env
  echo "  Токен — у @BotFather (/newbot). Свой ID — у @userinfobot."
  TOK=$(prompt "BOT_TOKEN")
  USR=$(prompt "ALLOWED_USERS (Telegram ID, через запятую)")
  [ -n "$TOK" ] && set_env tgbot/.env BOT_TOKEN "$TOK"
  [ -n "$USR" ] && set_env tgbot/.env ALLOWED_USERS "$USR"
  CWD=$(prompt "DEFAULT_CWD (рабочая папка claude)" "$(pwd -W 2>/dev/null || pwd)")
  [ -n "$CWD" ] && set_env tgbot/.env DEFAULT_CWD "$CWD"
  ok "tgbot/.env заполнен"
fi

# ── 7. Опциональные зависимости (Python) ────────────────────────────────────
step "7. Опц. зависимости: TokenRouter (Camoufox) + ✈ Открыть TG"
if ask "Поставить Python-зависимости (Camoufox + opentele venv)?" N; then
  if ! have python && ! have python3; then
    err "python не найден — пропускаю."
  else
    PY=$(have python && echo python || echo python3)
    if ask "  Camoufox (TokenRouter автореги)?" Y; then
      pip install camoufox requests && "$PY" -m camoufox fetch && ok "camoufox готов"
    fi
    if ask "  venv для ✈ Открыть TG (opentele)?" Y; then
      "$PY" -m venv tools/tg-venv && tools/tg-venv/Scripts/pip install -r tools/tg-venv-requirements.txt && ok "tg-venv готов"
      warn "Для ✈ Открыть ещё нужен портативный Telegram в tools/telegram-portable/Telegram/Telegram.exe"
    fi
  fi
fi

# ── Финал: запуск ───────────────────────────────────────────────────────────
step "Готово ✓"
b "Дашборд:  http://localhost:8200/__switch"
echo "Откат при поломке ключа:  routing/PANIC-restore-omniroute.bat"
echo
if ask "Запустить дашборд сейчас (rotator :20126 + switcher :8200)?" Y; then
  ( cd routing && start "Backend Switcher" cmd //c restart-dashboard.bat ) 2>/dev/null \
    || ./routing/restart-dashboard.bat
  ok "дашборд поднимается — UI откроется в браузере"
fi
if [ "$SETUP_TG" = "1" ] && ask "Запустить ТГ-бота сейчас?" N; then
  npm run tgbot
fi

echo
b "Всё. Управляй из браузера или /backends в Telegram."
