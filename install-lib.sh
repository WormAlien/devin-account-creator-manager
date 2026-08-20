#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Общие хелперы установщиков. Подключается через `. install-lib.sh`.
#  Пользуются: install.sh (база), install-deps.sh (тяжёлый стек).
#
#  Зачем отдельным файлом: логика ask() зависит от AUTO, а AUTO — контракт
#  update.sh и fix.sh («ни одного вопроса»). Две копии этой функции разъехались
#  бы молча, и обновление у друга начало бы залипать на приглашении ввода.
#
#  install-mac.sh СВОИ копии оставляет себе: он качается одним файлом через curl
#  в bootstrap-однострочнике, и `. install-lib.sh` сломал бы установку на маке,
#  где репо ещё нет на диске.
# ─────────────────────────────────────────────────────────────────────────────

# --- цвета / печать ---------------------------------------------------------
b() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
err() { printf '\033[31m  ✗ %s\033[0m\n' "$*"; }
step() { printf '\n\033[36m── %s\033[0m\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Авто-режим (AUTO=1, используется update.sh и fix.sh): все вопросы получают
# дефолт, ничего не спрашиваем — установка идёт по «умным» проверкам идемпотентно.
AUTO=${AUTO:-0}

# Да/нет вопрос. ask "Текст?" Y → дефолт да;  ask "Текст?" N → дефолт нет
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

# Скопировать шаблон, не затирая существующий рабочий конфиг.
copy_if_absent() { [ -f "$2" ] && warn "$2 уже есть" || { cp "$1" "$2" && ok "создан $2"; }; }
