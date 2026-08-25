#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Установщик ABUSE HUB для Windows (git-bash).
#  Аналог install-mac.sh для мака: один линейный проход, минимум вопросов.
#
#  Запуск:  bash install.sh              (спросит 3 вещи)
#           AUTO=1 bash install.sh       (без вопросов — так зовут update.sh/fix.sh)
#
#  Ключи и токены здесь НЕ спрашиваются: их вписывают в дашборде (вкладка ключей
#  → Активировать). В терминале секрет остаётся в скроллбэке и в истории.
#  Тяжёлый Python-стек (Camoufox, tg-venv), sqlite3, Docker и .env ТГ-бота —
#  в install-deps.sh, он вызывается в конце.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"

# Установщик разбит на три файла (2026-08-20), и update.sh зовёт именно этот.
# Если pull приехал не целиком, `. ./install-lib.sh` дал бы каскад «ask: command
# not found» вместо внятной причины — проверяем до первого использования.
for _f in install-lib.sh install-deps.sh; do
  [ -f "$_f" ] || {
    printf '\033[31m  ✗ нет %s — код приехал не целиком.\033[0m\n' "$_f"
    printf '\033[33m    Починить: git pull  (или двойной клик UPDATE.bat), потом запустить снова.\033[0m\n'
    exit 1
  }
done
. ./install-lib.sh

# Имя папки клона сменилось на hub-cc (2026-08-21), но у старых установок
# вложенный дубль называется по-прежнему — проверяем оба имени.
for _nested in hub-cc vibe-code-account-creator-manager; do
  if [ -d "$_nested/.git" ]; then
    err "похоже, репо склонировано внутрь самого себя: $(pwd)/$_nested"
    warn "Остановись и перенеси/удали внешний дубль до создания venv, иначе Python запомнит старые пути."
    exit 1
  fi
done

[ "$AUTO" = "1" ] || clear
b "════════════════════════════════════════════════════════"
b "  ABUSE HUB"
b "  Установка для Windows (git-bash)"
b "════════════════════════════════════════════════════════"

# ── 1. node / npm / git ─────────────────────────────────────────────────────
step "1. Системные зависимости"
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

# ── 2. Git identity + вход в GitHub ─────────────────────────────────────────
# Без user.name/user.email git pull с merge-коммитом падает («Committer identity
# unknown»). Настраиваем интерактивно, дефолты — из имени пользователя Windows.
step "2. Git identity + GitHub"
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

# ── 3. cat в системном PATH (критично для apiKeyHelper) ─────────────────────
# Claude Code запускает apiKeyHelper ("cat ~/.claude/xx-active-key.txt") через
# системный шелл, НЕ через git-bash. Если Git ставился с дефолтной опцией PATH,
# unix-тулзов (cat, sh) в системном PATH нет → helper молча отдаёт пустой ключ
# → "Authentication failed" / вечные ретраи. Фикс: докинуть Git\usr\bin в КОНЕЦ
# user-PATH (в конец — чтобы не перекрыть виндовые find/sort).
#
# Не спрашиваем: правка аддитивная (дописать одну папку в хвост user-PATH), а
# отказ означает мёртвые режимы apihelper/aerolink/conduit с невнятной ошибкой
# авторизации, в которой никто не догадается винить PATH.
step "3. cat для apiKeyHelper"
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
    powershell -NoProfile -Command \
      "\$p=[Environment]::GetEnvironmentVariable('Path','User'); if(\$p -notlike '*Git\usr\bin*'){[Environment]::SetEnvironmentVariable('Path', \$p.TrimEnd(';')+';$WIN_PATH','User')}" \
      && ok "добавлено в user-PATH: $WIN_PATH"
    warn "PATH обновится в НОВЫХ процессах — перезапусти терминал и Claude Code после установки."
  else
    err "не нашёл Git\\usr\\bin с cat.exe — переустанови Git for Windows (git-scm.com)"
  fi
fi

# ── 4. npm install ──────────────────────────────────────────────────────────
step "4. Node-зависимости (npm install)"
npm install || { err "npm install упал"; exit 1; }
ok "deps установлены"

# ── 5. Браузеры Playwright ──────────────────────────────────────────────────
# НЕ то же, что Camoufox из install-deps.sh — там отдельный Python-стек.
# chromium — квоты FreeModel и ЛК аккаунтов; chromium-headless-shell —
# извлечение ключей (без него "Извлекаю ключ через Playwright" падает).
# Ставить строго из папки репы: npx берёт версию playwright из node_modules,
# и браузер качается под неё. Повторный запуск ничего не перекачивает.
step "5. Playwright: chromium + headless-shell"
PW_MARKER=$(node -e "try{console.log(require('playwright-core/package.json').version)}catch(e){console.log('')}" 2>/dev/null)
npx playwright install chromium chromium-headless-shell \
  && ok "браузеры playwright установлены (playwright ${PW_MARKER:-?})" \
  || { warn "chromium-headless-shell не поддерживается этой версией — ставлю только chromium"; \
       npx playwright install chromium && ok "chromium установлен"; }

# ── 6. Claude Code ──────────────────────────────────────────────────────────
# Раньше здесь был жёсткий пин 2.1.153 с npm uninstall: считалось, что версии новее
# ломают apiKeyHelper. Это не подтвердилось — ротация ключей на лету работает на всех
# версиях, а UPDATE.bat при этом каждый раз откатывал свежий Claude Code.
# Теперь стоящую версию НЕ трогаем, ставим только если claude вообще нет.
# Если зачем-то нужна конкретная — CLAUDE_CODE_VERSION=2.1.153 bash install.sh
step "6. Claude Code"
CUR=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
WANT="${CLAUDE_CODE_VERSION:-}"
if [ -n "$CUR" ] && { [ -z "$WANT" ] || [ "$CUR" = "$WANT" ]; }; then
  ok "уже стоит $CUR — не трогаю (CC обновляется сам)"
else
  npm config delete prefix 2>/dev/null
  npm install -g "@anthropic-ai/claude-code${WANT:+@$WANT}" && ok "Claude Code установлен"
  # npm с allow-scripts не запускает postinstall (node install.cjs) без
  # одобрения — из-за этого claude может не завестись или тормозить на
  # первом старте. approve-scripts есть не во всех npm — ошибку глотаем.
  npm approve-scripts @anthropic-ai/claude-code >/dev/null 2>&1 || true
  # Проверяем результат тут же, а не у друга через неделю.
  NEWVER=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -n "$NEWVER" ]; then
    ok "claude --version → $NEWVER"
  else
    warn "claude не отвечает после установки."
    warn "В PowerShell npm может блокироваться политикой (PSSecurityException) — лечится:"
    warn "  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force"
    warn "Затем перезапусти терминал и повтори: npm install -g @anthropic-ai/claude-code"
  fi
fi

# ── 7. ~/.claude/settings.json + статуслайн ─────────────────────────────────
step "7. Настройки Claude Code"
CLAUDE_DIR="$HOME/.claude"; mkdir -p "$CLAUDE_DIR"
if [ -f "$CLAUDE_DIR/settings.json" ]; then
  warn "settings.json уже есть — не трогаю (переключатель сам его правит)."
else
  cp docs/claude-settings.example.json "$CLAUDE_DIR/settings.json" && ok "settings.json создан из шаблона"
fi

# Статуслайн: [provider] provider/model + шкала остатка квоты (как в дашборде).
# Раньше в settings.json писался ПРЯМОЙ путь до routing/statusline-autoreger.sh, и
# перенос/переименование папки проекта молча ломал статус-бар. Теперь туда идёт
# шим из ~/.claude/, а он читает актуальный корень репо из
# ~/.claude/autoreger-root.txt (его обновляет restart-dashboard при каждом старте).
# Логика одна для Windows и macOS — tools/enable-statusline.js; он же не трогает
# чужой statusLine без --force.
#
# Вывод НЕ глушим: причина отказа («в settings.json свой statusLine»,
# «settings.json не читается как JSON») иначе теряется, и чинить нечего.
if sl_out="$(node tools/enable-statusline.js 2>&1)"; then
  ok "статуслайн подключён через шим (переживает перенос папки)"
else
  warn "статуслайн подключить не удалось — вручную: node tools/enable-statusline.js"
fi
printf '%s\n' "$sl_out" | sed 's/^/    /'

# ── 8. Локальные конфиги из *.example ───────────────────────────────────────
step "8. Локальные конфиги (gitignored)"
copy_if_absent routing/.env.example             routing/.env
copy_if_absent routing/al-sessions.example.json routing/al-sessions.json
copy_if_absent routing/video-keys.example.json  routing/video-keys.json
copy_if_absent routing/image-keys.example.json  routing/image-keys.json
copy_if_absent tgbot/.env.example               tgbot/.env

# ── 9. Доп. зависимости ─────────────────────────────────────────────────────
# AUTO=1 (update.sh:45, fix.sh:52) — гоняем всегда: внутри каждый блок сам чекает
# «уже стоит?», а дефолты вопросов там прежние (Python Y, sqlite3 Y, Docker N,
# ТГ-бот N), поэтому поведение обновления не меняется ни на шаг.
step "9. Доп. зависимости (Camoufox-автореги, ✈ Открыть TG, sqlite3, OmniRoute)"
if [ "$AUTO" = "1" ] || ask "Проверить/поставить их сейчас?" Y; then
  AUTO="$AUTO" bash install-deps.sh
else
  echo "  Позже: bash install-deps.sh"
fi

# ── 10. Запуск ──────────────────────────────────────────────────────────────
step "Готово ✓"
b "Дашборд:  http://localhost:8200/__switch"
if ask "Запустить дашборд сейчас (rotator :20126 + switcher :8200)?" Y; then
  ( cd routing && start "ABUSE HUB" cmd //c restart-dashboard.bat ) 2>/dev/null \
    || ./routing/restart-dashboard.bat
  ok "дашборд поднимается — UI откроется в браузере"
fi

# ── Шпаргалка ───────────────────────────────────────────────────────────────
# Печатаем в конце: выше уже прокрутилось много вывода, а «куда вписать ключ» и
# «как обновиться» — первые вопросы после установки.
cat <<EOF

$(b "── Шпаргалка ──────────────────────────────────────")
  Запуск       двойной клик START.bat  ·  routing/restart-dashboard.bat
  Дашборд      http://localhost:8200/__switch
  Обновление   двойной клик UPDATE.bat  (git pull + доустановка)
  Диагностика  двойной клик DOCTOR.bat  → отчёт в doctor-report.txt
  Починить всё двойной клик FIX.bat
  Откат ключа  routing/PANIC-restore-omniroute.bat

  API-ключ бэкенда вписывается В ДАШБОРДЕ: вкладка нужного провайдера →
  ключ → Активировать. Установщик специально его не спрашивает.

  Перенос папки: остановить дашборд → перенести → запустить из нового места.
  Если что-то отвалилось после переноса: powershell tools/fix-paths-after-move.ps1

EOF

# При запуске двойным кликом из проводника окно закрылось бы сразу — держим.
# В AUTO-режиме (update.sh) паузу делает сам update.sh.
[ "$AUTO" = "1" ] || read -r -p "Enter для выхода..." _
