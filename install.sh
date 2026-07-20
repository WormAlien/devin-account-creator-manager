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

# Авто-режим (AUTO=1, используется update.sh): все вопросы получают дефолт,
# ничего не спрашиваем — установка идёт по «умным» проверкам идемпотентно.
AUTO=${AUTO:-0}

# Да/нет вопрос. ask "Текст?" Y  → дефолт да;  ask "Текст?" N → дефолт нет
ask() {
  local q="$1" def="${2:-Y}" hint ans
  if [ "$AUTO" = "1" ]; then
    if [ "$def" = "Y" ]; then printf '  %s → авто: да\n' "$q"; return 0
    else printf '  %s → авто: нет\n' "$q"; return 1; fi
  fi
  [ "$def" = "Y" ] && hint="[Д/н]" || hint="[д/Н]"
  read -r -p "$q $hint " ans
  ans="${ans:-$def}"
  case "$ans" in y|Y|д|Д|yes|да) return 0 ;; *) return 1 ;; esac
}

# Запрос значения с дефолтом. val=$(prompt "Текст" "дефолт")
prompt() {
  local q="$1" def="${2:-}" ans
  if [ "$AUTO" = "1" ]; then echo "$def"; return 0; fi
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

# Python 3.11 — целевая версия для tg-venv (tgcrypto без компиляции).
# Ставится через winget, а без winget — напрямую с python.org.
PY311_EXE="$LOCALAPPDATA/Programs/Python/Python311/python.exe"
install_python311() {
  if [ -f "$PY311_EXE" ]; then return 0; fi
  if have winget; then
    winget install -e --id Python.Python.3.11
  else
    warn "winget нет — качаю Python 3.11.9 с python.org (~25 МБ)"
    local exe="${TEMP:-/tmp}/python-3.11.9-amd64.exe"
    curl -fL -o "$exe" https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe || return 1
    warn "Ставлю (окно прогресса появится и само закроется)..."
    MSYS_NO_PATHCONV=1 "$exe" /passive InstallAllUsers=0 PrependPath=1 Include_test=0
  fi
  [ -f "$PY311_EXE" ]
}

[ "$AUTO" = "1" ] || clear
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

# ── 0.5 Git: identity + вход в GitHub ───────────────────────────────────────
# Без user.name/user.email git pull с merge-коммитом падает («Committer identity
# unknown»). Настраиваем интерактивно, дефолты — из имени пользователя Windows.
step "0.5 Git identity + GitHub"
GIT_NAME=$(git config --global user.name 2>/dev/null || true)
GIT_EMAIL=$(git config --global user.email 2>/dev/null || true)
if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
  ok "git user: $GIT_NAME <$GIT_EMAIL>"
else
  warn "git identity не настроен — git pull/commit будут падать"
  WINUSER="${USERNAME:-$(whoami 2>/dev/null | sed 's/.*\\\\//')}"
  GIT_NAME=$(prompt "  Имя для git" "${GIT_NAME:-$WINUSER}")
  GIT_EMAIL=$(prompt "  Email для git (любой)" "${GIT_EMAIL:-${WINUSER}@local}")
  git config --global user.name "$GIT_NAME"
  git config --global user.email "$GIT_EMAIL"
  ok "git user: $GIT_NAME <$GIT_EMAIL>"
fi
# pull = merge (без вопросов про rebase на каждом pull)
git config --global pull.rebase false 2>/dev/null || true
# Логин в GitHub: Git Credential Manager (идёт в комплекте Git for Windows)
# сам откроет браузер с OAuth-логином при первом обращении, ничего вводить
# руками не нужно. Просто убеждаемся, что helper включён.
if ! git config --global credential.helper >/dev/null 2>&1; then
  git config --global credential.helper manager
  ok "credential.helper=manager — при первом push/private-pull откроется браузер с логином GitHub"
else
  ok "credential.helper: $(git config --global credential.helper)"
fi

# ── 0.6 sqlite3.exe ─────────────────────────────────────────────────────────
# Нужен дашборду (OmniRoute-вкладка) и парсеру .session для TG-пула
# (freemodel/lib/tg-session-parser.js). Ищется в WinGet Links, в ~/bin
# (setup-sqlite3.bat) либо через env SQLITE3. Без него закидывание .session
# падает невнятной ошибкой.
step "0.6 sqlite3 (TG-пул + OmniRoute)"
SQLITE_LINK="$LOCALAPPDATA/Microsoft/WinGet/Links/sqlite3.exe"
SQLITE_HOMEBIN="$HOME/bin/sqlite3.exe"
if [ -n "${SQLITE3:-}" ] && [ -f "$SQLITE3" ]; then
  ok "sqlite3: $SQLITE3 (env SQLITE3)"
elif [ -f "$SQLITE_LINK" ]; then
  ok "sqlite3: $SQLITE_LINK"
elif [ -f "$SQLITE_HOMEBIN" ]; then
  ok "sqlite3: $SQLITE_HOMEBIN"
elif have winget && ask "sqlite3.exe не найден — поставить через winget? (нужен TG-пулу)" Y; then
  winget install -e --id SQLite.SQLite
  [ -f "$SQLITE_LINK" ] && ok "sqlite3 установлен" || warn "sqlite3 не появился в $SQLITE_LINK — проверь winget и перезапусти git-bash"
else
  warn "winget нет — качаю sqlite-tools с sqlite.org в ~/bin"
  SQLITE_TMP="$(mktemp -d)"
  if curl -fL -o "$SQLITE_TMP/sqlite-tools.zip" https://sqlite.org/2026/sqlite-tools-win-x64-3530300.zip \
     && (cd "$SQLITE_TMP" && unzip -o -q sqlite-tools.zip); then
    mkdir -p "$HOME/bin"
    find "$SQLITE_TMP" -name sqlite3.exe -exec cp {} "$HOME/bin/" \;
    [ -f "$SQLITE_HOMEBIN" ] && ok "sqlite3: $SQLITE_HOMEBIN" \
      || warn "sqlite3.exe не встал — без него не работают: закидывание .session в TG-пул, вкладка OmniRoute"
  else
    warn "скачать не вышло — без sqlite3 не работают: закидывание .session в TG-пул, вкладка OmniRoute"
  fi
  rm -rf "$SQLITE_TMP"
fi

# ── 0.7 cat в системном PATH (критично для apiKeyHelper) ────────────────────
# Claude Code запускает apiKeyHelper ("cat ~/.claude/xx-active-key.txt") через
# системный шелл, НЕ через git-bash. Если Git ставился с дефолтной опцией PATH,
# unix-тулзов (cat, sh) в системном PATH нет → helper молча отдаёт пустой ключ
# → "Authentication failed" / вечные ретраи. Фикс: докинуть Git\usr\bin в КОНЕЦ
# user-PATH (в конец — чтобы не перекрыть виндовые find/sort).
step "0.7 cat для apiKeyHelper"
if cmd //c "cat --version" >/dev/null 2>&1; then
  ok "cat доступен из системного шелла"
else
  GIT_USR_BIN=""
  for d in "/c/Program Files/Git/usr/bin" "/c/Program Files (x86)/Git/usr/bin"; do
    [ -f "$d/cat.exe" ] && { GIT_USR_BIN="$d"; break; }
  done
  if [ -z "$GIT_USR_BIN" ] && have git; then
    GIT_USR_BIN="$(dirname "$(command -v git)")/../usr/bin"
    [ -f "$GIT_USR_BIN/cat.exe" ] || GIT_USR_BIN=""
  fi
  if [ -n "$GIT_USR_BIN" ]; then
    WIN_PATH=$(cd "$GIT_USR_BIN" && pwd -W | sed 's|/|\\|g')
    warn "cat не виден из cmd — Claude Code не сможет прочитать ключ через apiKeyHelper."
    if ask "Добавить $WIN_PATH в конец user-PATH?" Y; then
      powershell -NoProfile -Command \
        "\$p=[Environment]::GetEnvironmentVariable('Path','User'); if(\$p -notlike '*Git\usr\bin*'){[Environment]::SetEnvironmentVariable('Path', \$p.TrimEnd(';')+';$WIN_PATH','User')}" \
        && ok "добавлено в user-PATH: $WIN_PATH"
      warn "PATH обновится в НОВЫХ процессах — перезапусти терминал и Claude Code после установки."
    else
      err "без cat в PATH режимы apihelper/aerolink/conduit работать НЕ будут (Authentication failed)"
    fi
  else
    err "не нашёл Git\\usr\\bin с cat.exe — переустанови Git for Windows (git-scm.com)"
  fi
fi

# ── 1. Node-зависимости ─────────────────────────────────────────────────────
step "1. Node-зависимости (npm install)"
npm install || { err "npm install упал"; exit 1; }
ok "deps установлены"
# Браузеры Node-плейрайта (НЕ то же, что Camoufox из шага 7 — там отдельный
# Python-стек). chromium — квоты FreeModel; chromium-headless-shell — извлечение
# ключей из дашборда (без него "Извлекаю ключ через Playwright" падает).
# Ставить строго из папки репы: npx берёт версию playwright из node_modules,
# и браузер качается под неё. Повторный запуск ничего не перекачивает.
PW_MARKER=$(node -e "try{console.log(require('playwright-core/package.json').version)}catch(e){console.log('')}" 2>/dev/null)
if ask "Поставить браузеры Playwright: chromium + headless-shell (FreeModel-квоты, извлечение ключей)?" Y; then
  npx playwright install chromium chromium-headless-shell \
    && ok "браузеры playwright установлены (playwright ${PW_MARKER:-?})" \
    || { warn "chromium-headless-shell не поддерживается этой версией — ставлю только chromium"; \
         npx playwright install chromium && ok "chromium установлен"; }
fi

# ── 2. Claude Code 2.1.153 ──────────────────────────────────────────────────
step "2. Claude Code (нужна РОВНО 2.1.153 — новее ломает apiKeyHelper)"
CUR=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ "$CUR" = "2.1.153" ]; then
  ok "уже 2.1.153"
elif ask "Текущая: ${CUR:-нет}. Поставить 2.1.153?" Y; then
  npm config delete prefix 2>/dev/null
  npm uninstall -g @anthropic-ai/claude-code 2>/dev/null
  npm install -g @anthropic-ai/claude-code@2.1.153 && ok "Claude Code 2.1.153"
  # npm с allow-scripts не запускает postinstall (node install.cjs) без
  # одобрения — из-за этого claude может не завестись или тормозить на
  # первом старте. approve-scripts есть не во всех npm — ошибку глотаем.
  npm approve-scripts @anthropic-ai/claude-code >/dev/null 2>&1 || true
  # Проверяем результат тут же, а не у друга через неделю.
  NEWVER=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ "$NEWVER" = "2.1.153" ]; then
    ok "claude --version → $NEWVER"
  else
    warn "claude не отвечает после установки (got: ${NEWVER:-ничего})."
    warn "В PowerShell npm может блокироваться политикой (PSSecurityException) — лечится:"
    warn "  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force"
    warn "Затем перезапусти терминал и повтори: npm install -g @anthropic-ai/claude-code@2.1.153"
  fi
fi

# ── 3. Базовый ~/.claude/settings.json ──────────────────────────────────────
step "3. ~/.claude/settings.json"
CLAUDE_DIR="$HOME/.claude"; mkdir -p "$CLAUDE_DIR"
if [ -f "$CLAUDE_DIR/settings.json" ]; then
  warn "settings.json уже есть — не трогаю (переключатель сам его правит)."
elif ask "Создать из шаблона claude-settings.example.json?" Y; then
  cp claude-settings.example.json "$CLAUDE_DIR/settings.json" && ok "settings.json создан"
fi

# Ключ бэкенда: settings.json берёт его через apiKeyHelper (cat <какой-то>-active-key.txt).
# Без этого файла Claude Code получит пустой ключ и упадёт с "Authentication failed".
# Смотрим, на какой файл ссылается apiKeyHelper в settings.json, и спрашиваем именно тот ключ.
KEY_FILE=$(grep -o '[a-z]*-active-key\.txt' "$CLAUDE_DIR/settings.json" 2>/dev/null | head -1)
[ -z "$KEY_FILE" ] && KEY_FILE="al-active-key.txt"
case "$KEY_FILE" in
  fm-*) KEY_NAME="FreeModel" ;;
  al-*) KEY_NAME="Aerolink" ;;
  cdt-*) KEY_NAME="Conduit" ;;
  ev-*) KEY_NAME="EvoMap" ;;
  ot-*) KEY_NAME="OurToken" ;;
  *) KEY_NAME="$KEY_FILE" ;;
esac
if [ -s "$CLAUDE_DIR/$KEY_FILE" ]; then
  warn "$KEY_FILE уже есть и непустой — не трогаю."
elif ask "Вписать $KEY_NAME API-ключ сейчас? (без него Claude Code не заведётся)" Y; then
  AK=$(prompt "$KEY_NAME API-ключ")
  if [ -n "$AK" ]; then
    printf '%s' "$AK" > "$CLAUDE_DIR/$KEY_FILE" && ok "ключ записан в ~/.claude/$KEY_FILE"
  else
    warn "ключ пустой — впиши позже через дашборд (вкладка ключей → Активировать)."
  fi
fi

# Статуслайн: [provider] provider/model + шкала остатка квоты (как в дашборде).
# settings.json указывает на скрипт ПРЯМО в репо — обновления приезжают с git pull.
if grep -q '"statusLine"' "$CLAUDE_DIR/settings.json" 2>/dev/null; then
  warn "statusLine уже настроен в settings.json — не трогаю."
elif [ -f "$CLAUDE_DIR/settings.json" ] && ask "Подключить статуслайн Claude Code (провайдер/модель + квота)?" Y; then
  REPO_W="$(pwd -W 2>/dev/null || pwd)"
  node -e '
    const fs = require("fs");
    const [p, repo] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const fwd = repo.split("\\").join("/");
    j.statusLine = { type: "command", command: `bash "${fwd}/routing/statusline-autoreger.sh"` };
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  ' "$CLAUDE_DIR/settings.json" "$REPO_W" && ok "statusLine подключён (routing/statusline-autoreger.sh)"
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
# Идемпотентно: каждый блок сначала чекает "уже стоит?" и не переустанавливает.
step "7. Опц. зависимости: TokenRouter (Camoufox) + ✈ Открыть TG"

# tg-venv живой? (главный источник "нет tools/tg-venv" в дашборде)
tg_venv_ok() {
  [ -f tools/tg-venv/Scripts/python.exe ] && \
    tools/tg-venv/Scripts/python -c 'import opentele, tgcrypto' >/dev/null 2>&1
}

if tg_venv_ok; then TG_VENV_STATE="уже готов"; else TG_VENV_STATE="НЕ создан — нужен для ✈ Открыть TG"; fi
if ask "Проверить/поставить Python-зависимости (Camoufox + opentele venv)? [tg-venv: $TG_VENV_STATE]" Y; then
  PY=$(choose_python)
  # Питона нет вообще (или только в LOCALAPPDATA без PATH) — ставим 3.11 сами
  # и берём по прямому пути, не полагаясь на PATH текущей сессии.
  if [ -z "$PY" ] && [ -f "$PY311_EXE" ]; then
    PY="$PY311_EXE"
  fi
  if [ -z "$PY" ]; then
    warn "python не найден вообще — без него не работают Camoufox-автореги и ✈ Открыть TG"
    if ask "  Поставить Python 3.11 автоматически?" Y; then
      if install_python311; then
        PY="$PY311_EXE"
        ok "Python 3.11 установлен: $PY311_EXE"
      else
        err "Python 3.11 не установился — пропускаю Python-шаги. Поставь вручную: https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
      fi
    else
      err "python не найден — пропускаю Python-шаги."
    fi
  fi
  if [ -n "$PY" ]; then
    # PY бывает двусловным ("py -3.11") или путём с пробелами
    # ("C:\Users\Happy Creator\...\python.exe") — py_run обслуживает оба.
    py_run() { if [ -f "$PY" ]; then "$PY" "$@"; else $PY "$@"; fi; }
    PYVER=$(py_run -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)
    ok "Python $PYVER → $PY"
    if [ "$PYVER" = "3.12" ]; then
      warn "Python 3.12 часто ломает tgcrypto/opentele без сборки. Надёжнее: winget install -e --id Python.Python.3.11"
    fi

    # Camoufox: пропускаем, если уже стоит рабочая пара camoufox + playwright 1.60.0
    PW_VER=$(py_run -c 'import importlib.metadata as m; print(m.version("playwright"))' 2>/dev/null)
    if py_run -c 'import camoufox' >/dev/null 2>&1 && [ "$PW_VER" = "1.60.0" ]; then
      ok "camoufox уже стоит (playwright $PW_VER) — пропускаю"
    elif ask "  Camoufox (TokenRouter автореги)?" Y; then
      py_run -m pip install --upgrade pip
      # playwright строго 1.60.0: в 1.61 Firefox-клиент шлёт viewport.isMobile,
      # которого juggler Camoufox (FF152) не знает → Browser.setDefaultViewport
      # падает на старте и вся авторега умирает (проверено на чистой установке).
      py_run -m pip install camoufox==0.4.11 requests playwright==1.60.0 && py_run -m camoufox fetch && ok "camoufox готов"
    fi

    # grok-launcher: FastAPI-сервис на :8765 для SuperGrok Sessions.
    # Поднимается transparent-proxy.js автоматически, но зависимости надо один раз поставить.
    if py_run -c 'import fastapi, uvicorn, websockets, httpx' >/dev/null 2>&1; then
      ok "grok-launcher deps уже стоят — пропускаю"
    elif ask "  grok-launcher (SuperGrok Sessions — headless-квоты + Chrome-launcher)?" Y; then
      py_run -m pip install -r grok-launcher/requirements.txt && ok "grok-launcher готов"
    fi

    if tg_venv_ok; then
      ok "tg-venv уже готов (opentele+tgcrypto импортируются) — пропускаю"
    elif ask "  venv для ✈ Открыть TG (opentele)?" Y; then
      # tgcrypto ставится колесом только на Python 3.11; на 3.12+ без Build Tools
      # сборка падает. Поэтому: нет 3.11 → ставим его сами (winget или python.org)
      # и берём по прямому пути — в PATH текущей сессии он всё равно не попадёт.
      # tg_py: обёртка, т.к. PY бывает двусловным ("py -3.11"), а PY311_EXE —
      # путём с пробелами (C:\Users\Happy Creator\...).
      TG_PY_EXE=""
      tg_py() { if [ -n "$TG_PY_EXE" ]; then "$TG_PY_EXE" "$@"; else py_run "$@"; fi; }
      if [ "$PYVER" != "3.11" ]; then
        if [ -f "$PY311_EXE" ]; then
          TG_PY_EXE="$PY311_EXE"
          ok "для tg-venv беру Python 3.11: $PY311_EXE"
        elif [ "$PYVER" = "3.12" ] && has_cpp_build_tools; then
          warn "Python 3.12 + Build Tools — пробую собрать tgcrypto из исходников"
        elif ask "  Python 3.11 не найден — поставить автоматически? (надёжный путь для tg-venv)" Y; then
          if install_python311; then
            TG_PY_EXE="$PY311_EXE"
            ok "Python 3.11 установлен: $PY311_EXE"
          else
            err "Python 3.11 не встал — пробую на Python $PYVER (может упасть на tgcrypto)"
          fi
        fi
      fi

      rm -rf tools/tg-venv
      TG_VENV_LOG="${TEMP:-/tmp}/tg-venv-install.log"
      if tg_py -m venv tools/tg-venv && \
         tools/tg-venv/Scripts/python -m pip install --upgrade pip >"$TG_VENV_LOG" 2>&1 && \
         tools/tg-venv/Scripts/pip install -r tools/tg-venv-requirements.txt >>"$TG_VENV_LOG" 2>&1 && \
         tools/tg-venv/Scripts/python -c 'import opentele; import tgcrypto' 2>>"$TG_VENV_LOG"; then
        ok "tg-venv готов"
      else
        err "tg-venv не собрался. Последние строки лога:"
        tail -15 "$TG_VENV_LOG" 2>/dev/null | sed 's/^/    /'
        err "Полный лог: $TG_VENV_LOG"
        err "Обычно лечится Python 3.11 — перезапусти install.sh и согласись на его установку."
      fi
    fi

    if tg_venv_ok && [ ! -f tools/telegram-portable/Telegram/Telegram.exe ]; then
      if ask "  Портативного Telegram нет — скачать с telegram.org (~70 МБ)? (нужен для ✈ Открыть)" Y; then
        TG_ZIP="${TEMP:-/tmp}/tportable.zip"
        # официальная ссылка-редирект на свежий tportable-x64.*.zip; распаковывается в Telegram/Telegram.exe
        if curl -fL -o "$TG_ZIP" https://telegram.org/dl/desktop/win64_portable && \
           mkdir -p tools/telegram-portable && \
           unzip -o -q "$TG_ZIP" -d tools/telegram-portable && \
           [ -f tools/telegram-portable/Telegram/Telegram.exe ]; then
          ok "портативный Telegram установлен (tools/telegram-portable/Telegram)"
          rm -f "$TG_ZIP"
        else
          err "не скачался/не распаковался — положи вручную: зип с https://desktop.telegram.org (Portable) → tools/telegram-portable/"
        fi
      else
        warn "Для ✈ Открыть ещё нужен портативный Telegram в tools/telegram-portable/Telegram/Telegram.exe"
      fi
    fi
  fi
fi

# ── Финал: sanity-check авторизации Claude Code ─────────────────────────────
step "Проверка авторизации Claude Code"
KEY_FILE=$(grep -o '[a-z]*-active-key\.txt' "$CLAUDE_DIR/settings.json" 2>/dev/null | head -1)
if [ -n "$KEY_FILE" ]; then
  if [ ! -s "$CLAUDE_DIR/$KEY_FILE" ]; then
    err "~/.claude/$KEY_FILE пустой или отсутствует — Claude Code скажет 'Authentication failed'."
    err "Фикс: printf '%s' \"sk-ТВОЙ-КЛЮЧ\" > ~/.claude/$KEY_FILE  (перезапуск CC не нужен)"
  else
    BASE_URL=$(grep -o '"ANTHROPIC_BASE_URL"[^,]*' "$CLAUDE_DIR/settings.json" | grep -o 'https\?://[^"]*' | head -1)
    if [ -n "$BASE_URL" ] && command -v curl >/dev/null 2>&1; then
      HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL%/}/v1/models" \
        -H "x-api-key: $(cat "$CLAUDE_DIR/$KEY_FILE")" 2>/dev/null)
      case "$HTTP" in
        200) ok "ключ живой: $BASE_URL → 200" ;;
        401|403) err "бэкенд $BASE_URL отверг ключ ($HTTP) — ключ дохлый, активируй другой через дашборд" ;;
        *) warn "бэкенд $BASE_URL ответил '$HTTP' — не смог проверить ключ (сеть/VPN?)" ;;
      esac
    else
      ok "ключ на месте: ~/.claude/$KEY_FILE"
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

# При запуске двойным кликом из проводника окно закрылось бы сразу — держим.
# В AUTO-режиме (update.sh) паузу делает сам update.sh.
[ "$AUTO" = "1" ] || read -r -p "Enter для выхода..." _
