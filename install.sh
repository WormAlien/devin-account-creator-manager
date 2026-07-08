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

if [ -d "vibe-code-account-creator-manager/.git" ]; then
  err "похоже, репо склонировано внутрь самого себя: $(pwd)/vibe-code-account-creator-manager"
  warn "Остановись и перенеси/удали внешний дубль до создания venv, иначе Python запомнит старые пути."
  exit 1
fi

if [ -f tools/tg-venv/pyvenv.cfg ]; then
  VENV_HOME=$(grep -E '^home = ' tools/tg-venv/pyvenv.cfg | sed 's/^home = //')
  VENV_EXE=$(grep -E '^executable = ' tools/tg-venv/pyvenv.cfg | sed 's/^executable = //')
  if [ -n "$VENV_HOME" ] && [ ! -e "$VENV_HOME" ]; then
    warn "tools/tg-venv ссылается на несуществующий Python: $VENV_HOME"
    warn "Если папку переносили — удали tools/tg-venv и пересоздай через установщик."
  elif [ -n "$VENV_EXE" ] && [ ! -e "$VENV_EXE" ]; then
    warn "tools/tg-venv ссылается на несуществующий Python: $VENV_EXE"
    warn "Если папку переносили — удали tools/tg-venv и пересоздай через установщик."
  fi
fi

choose_python() {
  local cmd ver best=""
  for cmd in py python python3; do
    have "$cmd" || continue
    if [ "$cmd" = "py" ]; then
      if py -3.11 -c 'import sys' >/dev/null 2>&1; then echo "py -3.11"; return 0; fi
      if py -3.12 -c 'import sys' >/dev/null 2>&1; then best="py -3.12"; fi
    else
      ver=$($cmd -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)
      [ "$ver" = "3.11" ] && { echo "$cmd"; return 0; }
      [ "$ver" = "3.12" ] && best="$cmd"
      [ -z "$best" ] && [ -n "$ver" ] && best="$cmd"
    fi
  done
  [ -n "$best" ] && echo "$best"
}

python_version() {
  "$@" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null
}

has_cpp_build_tools() {
  [ -d "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC" ] || \
    [ -d "/c/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC" ]
}

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
  cp claude-settings.example.json "$CLAUDE_DIR/settings.json" && ok "settings.json создан"
fi

# Ключ Aerolink: settings.json берёт его через apiKeyHelper (cat al-active-key.txt).
# Без этого файла Claude Code получит пустой ключ и упадёт. Дашборд потом сам его перезапишет.
if [ -f "$CLAUDE_DIR/al-active-key.txt" ]; then
  warn "al-active-key.txt уже есть — не трогаю."
elif ask "Вписать Aerolink API-ключ сейчас? (без него Claude Code не заведётся)" Y; then
  AK=$(prompt "Aerolink API-ключ")
  if [ -n "$AK" ]; then
    printf '%s' "$AK" > "$CLAUDE_DIR/al-active-key.txt" && ok "ключ записан в ~/.claude/al-active-key.txt"
  else
    warn "ключ пустой — впиши позже через дашборд (вкладка ключей → Активировать)."
  fi
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
  PY=$(choose_python)
  if [ -z "$PY" ]; then
    err "python не найден — пропускаю. Лучше поставить Python 3.11: winget install -e --id Python.Python.3.11"
  else
    PYVER=$(python_version "$PY")
    ok "Python $PYVER → $PY"
    if [ "$PYVER" = "3.12" ]; then
      warn "Python 3.12 часто ломает tgcrypto/opentele без сборки. Надёжнее: winget install -e --id Python.Python.3.11"
    fi

    if ask "  Camoufox (TokenRouter автореги)?" Y; then
      $PY -m pip install --upgrade pip
      $PY -m pip install camoufox==0.4.11 requests playwright==1.61.0 && $PY -m camoufox fetch && ok "camoufox готов"
    fi

    # grok-launcher: FastAPI-сервис на :8765 для SuperGrok Sessions.
    # Поднимается transparent-proxy.js автоматически, но зависимости надо один раз поставить.
    if ask "  grok-launcher (SuperGrok Sessions — headless-квоты + Chrome-launcher)?" Y; then
      $PY -m pip install -r grok-launcher/requirements.txt && ok "grok-launcher готов"
    fi

    if ask "  venv для ✈ Открыть TG (opentele)?" Y; then
      SKIP_TG_VENV=0
      if [ "$PYVER" = "3.12" ] && ! has_cpp_build_tools; then
        warn "Для tgcrypto на Python 3.12 нужны Visual C++ Build Tools. Поставить можно так:"
        warn "winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override \"--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended\""
        if ! ask "  Продолжить попытку установки venv на Python 3.12?" N; then
          warn "Пропускаю tg-venv. Поставь Python 3.11 или Build Tools и запусти install.sh снова."
          SKIP_TG_VENV=1
        fi
      fi

      if [ "$SKIP_TG_VENV" = "0" ]; then
        rm -rf tools/tg-venv
        $PY -m venv tools/tg-venv && \
          tools/tg-venv/Scripts/python -m pip install --upgrade pip && \
          tools/tg-venv/Scripts/pip install -r tools/tg-venv-requirements.txt && \
          tools/tg-venv/Scripts/python -c 'import opentele; import tgcrypto' && \
          ok "tg-venv готов"
        if [ $? -ne 0 ]; then
          err "tg-venv не собрался. Чаще всего помогает Python 3.11: winget install -e --id Python.Python.3.11"
        fi
        warn "Для ✈ Открыть ещё нужен портативный Telegram в tools/telegram-portable/Telegram/Telegram.exe"
      fi
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
