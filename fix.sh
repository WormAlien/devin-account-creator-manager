#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  fix.sh — одна кнопка: обновить код, добить недостающее, перезапустить дашборд.
#  Запуск: двойной клик FIX.bat (или bash fix.sh). Безопасно гонять повторно.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"

b() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
err() { printf '\033[31m  ✗ %s\033[0m\n' "$*"; }
step() { printf '\n\033[36m── %s\033[0m\n' "$*"; }

b "══ FIX: $(pwd) ══"

# ── 1. Прибить старый дашборд (иначе после починки крутится старый процесс) ──
step "1. Останавливаю дашборд (если запущен)"
for port in 8200 20126; do
  PIDS=$(netstat -ano 2>/dev/null | grep -E "LISTENING" | grep ":$port " | awk '{print $5}' | sort -u)
  for pid in $PIDS; do
    taskkill //F //PID "$pid" >/dev/null 2>&1 && ok "убит процесс на :$port (pid $pid)"
  done
done

# ── 2. Свежий код ────────────────────────────────────────────────────────────
step "2. Обновляю код"
echo "  было: $(git log --oneline -1 2>/dev/null)"
# Локальное состояние дашборда трекается в git (маппинг тиров, активный бэкенд),
# поэтому наивный pull падает «local changes would be overwritten» — см.
# tools/git-pull-safe.js (та же логика, что у кнопки обновления в дашборде).
PULL_RC=0
if command -v node >/dev/null 2>&1; then
  # --stash: правки в коде не блокируют починку, а уходят в стэш (обратимо, скрипт
  # печатает, чем вернуть). Тот же режим, что у кнопки в дашборде и у update.sh —
  # иначе fix.sh спотыкался о код 3 и доезжал до грубого reset ниже.
  node tools/git-pull-safe.js --stash >/dev/null || PULL_RC=$?
else
  PULL_RC=99
fi
# Код 4 = свои коммиты разошлись с master. `reset --hard` ниже выбросил бы именно их,
# а fix.sh вопросов не задаёт — значит просто не обновляемся и говорим об этом.
if [ "$PULL_RC" -eq 4 ]; then
  warn "код не обновлён: свои коммиты разошлись с master — разрулить: git pull --rebase"
  PULL_RC=0
fi
if [ "$PULL_RC" -ne 0 ]; then
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    warn "локальные правки → git stash (вернуть: git stash pop)"
    git stash push -m "fix.sh auto-stash $(date +%F_%T)" >/dev/null
  fi
  if ! git pull --ff-only >/dev/null 2>&1; then
    # Свои коммиты не выбрасываем даже здесь: reset --hard уничтожает незапушенное
    # безвозвратно, а fix.sh запускают вслепую («починить всё»).
    MINE=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
    if [ "${MINE:-0}" -gt 0 ]; then
      warn "pull не прошёл, у тебя $MINE своих коммит(ов) — reset их бы выбросил, не делаю (git pull --rebase)"
    else
      warn "простой pull не прошёл — принудительно беру origin/master"
      git fetch origin && git reset --hard origin/master >/dev/null || err "git не смог обновиться (нет интернета?)"
    fi
  fi
fi
ok "стало: $(git log --oneline -1)"

# ── 3. Доустановить всё недостающее (авто-режим, без вопросов) ───────────────
# Установщик свой на каждую ОС — почему именно так, см. развилку в update.sh.
step "3. Установка недостающего (AUTO)"
INSTALLER=install.sh
[ "$(uname -s)" = "Darwin" ] && INSTALLER=install-mac.sh
AUTO=1 bash "$INSTALLER"
RC=$?
[ $RC -eq 0 ] && ok "$INSTALLER прошёл" || err "$INSTALLER упал с кодом $RC — скрин этого окна!"

# ── 4. Контрольные проверки ──────────────────────────────────────────────────
step "4. Итоговая проверка"
FAIL=0
# Путь до интерпретатора venv платформозависим (Scripts/python.exe против
# bin/python) — берём из резолвера tools/tg-venv-python.js, а не хардкодом.
TGPY="$(node tools/tg-venv-python.js 2>/dev/null)"
if [ -n "$TGPY" ] && [ -f "$TGPY" ] && "$TGPY" -c 'import opentele, tgcrypto' >/dev/null 2>&1; then
  ok "tg-venv: живой (✈ Открыть TG будет работать)"
else
  err "tg-venv: НЕ собрался — скрин шага 3 выше, там причина"; FAIL=1
fi
SQ3="${SQLITE3:-}"
[ -z "$SQ3" ] && for c in "$LOCALAPPDATA/Microsoft/WinGet/Links/sqlite3.exe" "$HOME/bin/sqlite3.exe"; do [ -f "$c" ] && SQ3="$c" && break; done
if [ -n "$SQ3" ]; then ok "sqlite3: $SQ3"; else err "sqlite3.exe не найден"; FAIL=1; fi
if [ -f tools/telegram-portable/Telegram/Telegram.exe ]; then
  ok "портативный Telegram: на месте"
else
  warn "портативного Telegram нет (tools/telegram-portable/Telegram/Telegram.exe) — ✈ Открыть попросит его позже"
fi

# ── 5. Поднять дашборд заново ────────────────────────────────────────────────
step "5. Запускаю дашборд"
( cd routing && start "ABUSE HUB" cmd //c restart-dashboard.bat ) 2>/dev/null \
  || ./routing/restart-dashboard.bat
ok "дашборд стартует — открой http://localhost:8200/__switch и обнови страницу"

echo
if [ $FAIL -eq 0 ]; then b "══ ВСЁ ПОЧИНЕНО ══"; else b "══ ЕСТЬ ПРОБЛЕМЫ — смотри ✗ выше, шли скрин ══"; fi
read -r -p "Enter для выхода..." _
