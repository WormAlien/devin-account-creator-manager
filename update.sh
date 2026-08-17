#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Умное обновление: git pull + install.sh в авто-режиме (без вопросов).
#  Запуск в git-bash:  bash update.sh      (или двойной клик по UPDATE.bat)
#  Безопасно запускать сколько угодно раз — ставится только недостающее.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"

b() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
err() { printf '\033[31m  ✗ %s\033[0m\n' "$*"; }

b "══ Обновление $(basename "$(pwd)") ══"
echo "Папка: $(pwd)"
echo "Было:  $(git log --oneline -1 2>/dev/null || echo 'не git-репа?')"

# Обновление кода. Локальное состояние дашборда (маппинг тиров, активный бэкенд)
# трекается в git, поэтому наивный pull падает «local changes would be overwritten».
# tools/git-pull-safe.js сохраняет такие файлы, тянет код и возвращает их назад —
# та же логика, что у кнопки обновления в дашборде.
PULL_RC=0
if command -v node >/dev/null 2>&1; then
  node tools/git-pull-safe.js || PULL_RC=$?
else
  warn "node не найден — обновляюсь по-старому (через stash)"
  PULL_RC=99
fi

if [ "$PULL_RC" -ne 0 ]; then
  [ "$PULL_RC" -eq 3 ] && warn "мешают локальные правки кода — прячу их в git stash (вернуть: git stash pop)"
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    git stash push -m "update.sh auto-stash $(date +%F_%T)" >/dev/null
  fi
  if ! git pull --ff-only 2>&1; then
    warn "быстрый pull не прошёл — забираю master принудительно (локальные коммиты уйдут в сторону)"
    git fetch origin && git reset --hard origin/master || { err "git pull не удался — нужен интернет/доступ к GitHub"; read -r -p "Enter для выхода..." _; exit 1; }
  fi
fi
ok "Стало: $(git log --oneline -1)"

echo
b "── Запускаю install.sh в авто-режиме (без вопросов) ──"
AUTO=1 bash install.sh
RC=$?

echo
if [ $RC -eq 0 ]; then
  b "══ Обновление завершено ══"
else
  err "install.sh вышел с ошибкой ($RC) — пришли скрин этого окна"
fi
read -r -p "Enter для выхода..." _
