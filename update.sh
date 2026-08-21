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
# tools/git-pull-safe.js сохраняет такие файлы, тянет код и возвращает их назад.
# `--stash` добавляет второй шаг: правки в КОДЕ не блокируют обновление, а уходят
# в git stash (обратимо, скрипт печатает, чем вернуть).
#
# Это ровно то же, что делает кнопка «Обновить дашборд» в UI после подтверждения:
# одна реализация на обоих вызывающих. Раньше умный путь был только здесь, и
# человек с правками кода застревал на кнопке, не понимая, что батник его вылечит.
PULL_RC=0
if command -v node >/dev/null 2>&1; then
  node tools/git-pull-safe.js --stash || PULL_RC=$?
else
  warn "node не найден — обновляюсь по-старому (через stash)"
  PULL_RC=99
fi

# Код 4 = история разошлась: у человека свои коммиты, fast-forward невозможен.
# Ниже лежит `reset --hard origin/master`, который выбросил бы ровно их. Раньше
# сюда доезжали именно так: батник печатал строчку про «локальные коммиты уйдут в
# сторону» и молча их терял. Своя работа дороже свежего кода — останавливаемся и
# отдаём решение человеку (git-pull-safe уже напечатал, чем разрулить).
if [ "$PULL_RC" -eq 4 ]; then
  warn "код не обновлён: у тебя свои коммиты, разошедшиеся с master"
  echo "  Разрулить самому:  git pull --rebase    (посмотреть своё:  git log --oneline @{u}..HEAD)"
  echo "  Насильно взять master И ВЫБРОСИТЬ свои коммиты:  git fetch origin && git reset --hard origin/master"
  echo
  read -r -p "Продолжить установку на СТАРОМ коде? [Y/n] " _ans
  case "$_ans" in
    [Nn]*) err "остановился, ничего не тронул"; read -r -p "Enter для выхода..." _; exit 1 ;;
  esac
  PULL_RC=0   # дальше по скрипту: не пытаться «починить» pull грубой силой
fi

if [ "$PULL_RC" -ne 0 ]; then
  # Сюда попадаем, если git-pull-safe не справился (нет сети, конфликт, не репо)
  # или node вообще нет. Последнее средство: забрать master принудительно.
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    git stash push -m "update.sh auto-stash $(date +%F_%T)" >/dev/null
  fi
  if ! git pull --ff-only 2>&1; then
    # Страховка для пути «node нет» (там кода 4 не будет вообще) и для случая, когда
    # расхождение вылезло уже на этом pull'е: считаем свои коммиты и НЕ ресетим, если
    # они есть. `reset --hard` уничтожает незапушенное безвозвратно — это не то, что
    # батник имеет право сделать сам.
    MINE=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
    if [ "${MINE:-0}" -gt 0 ]; then
      err "pull не прошёл, и у тебя $MINE своих коммит(ов) — принудительный reset их бы выбросил, не делаю"
      echo "  Разрулить:  git pull --rebase"
    else
      warn "быстрый pull не прошёл — забираю master принудительно (своих коммитов нет, терять нечего)"
      git fetch origin && git reset --hard origin/master || { err "git pull не удался — нужен интернет/доступ к GitHub"; read -r -p "Enter для выхода..." _; exit 1; }
    fi
  fi
fi
ok "Стало: $(git log --oneline -1)"

echo
# Установщики НЕ взаимозаменяемы: install.sh — Windows/git-bash (правит user-PATH,
# ищет Git\usr\bin с cat.exe, рассчитывает на Git Credential Manager),
# install-mac.sh — macOS (Xcode CLT, Homebrew, brew shellenv). Без развилки
# обновление на маке тянуло код и разваливалось в чужом установщике: код уже новый,
# а человек видит ошибку про Git for Windows и решает, что обновление не прошло.
INSTALLER=install.sh
[ "$(uname -s)" = "Darwin" ] && INSTALLER=install-mac.sh
b "── Запускаю $INSTALLER в авто-режиме (без вопросов) ──"
AUTO=1 bash "$INSTALLER"
RC=$?

echo
if [ $RC -eq 0 ]; then
  b "══ Обновление завершено ══"
else
  err "$INSTALLER вышел с ошибкой ($RC) — пришли скрин этого окна"
fi
read -r -p "Enter для выхода..." _
