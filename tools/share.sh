#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  share.sh — прислать СВОЮ версию репы обратно: ветка + Pull Request.
#  Запуск: пункт «Поделиться» в HUB.bat / HUB.command, либо `node hub.js share`,
#  либо напрямую `bash tools/share.sh`.
#
#  Что делает: собирает твои правки в отдельную ветку и открывает PR в
#  WormAlien/hub-cc. Ничего не удаляет и не
#  перезаписывает — только коммитит то, что ты уже наменял.
#
#  Секреты НЕ уезжают: берём только уже отслеживаемые git-ом файлы, новые
#  добавляем поштучно и с проверкой .gitignore + стоп-листа (.env, ключи,
#  сессии, куки). Репа ПУБЛИЧНАЯ — что попало в PR, видно всем.
#
#  Переехал из корня в tools/ 2026-08-24. Отсюда `cd ..` — скрипт работает с
#  репо целиком, а не со своей папкой.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/.." || exit 1

UPSTREAM="WormAlien/hub-cc"

b()    { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
err()  { printf '\033[31m  ✗ %s\033[0m\n' "$*"; }
step() { printf '\n\033[36m── %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
ask() {  # ask "Текст?" Y|N
  local q="$1" def="${2:-Y}" hint ans
  [ "$def" = "Y" ] && hint="[Д/н]" || hint="[д/Н]"
  read -r -p "$q $hint " ans
  ans="${ans:-$def}"
  case "$ans" in y|Y|д|Д|yes|да) return 0 ;; *) return 1 ;; esac
}
finish() { echo; read -r -p "Enter для выхода..." _; exit "${1:-0}"; }

b "══ Прислать свою версию (ветка + Pull Request) ══"
have git || { err "git не найден — запускай из git-bash"; finish 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { err "это не git-репа: $(pwd)"; finish 1; }
echo "Папка: $(pwd)"
echo "HEAD:  $(git log --oneline -1 2>/dev/null)"

# ── 1. Стэши: update.sh прячет туда локальные правки перед каждым pull ───────
step "1. Заначки git stash (туда update.sh прячет твои правки)"
STASHES="$(git stash list 2>/dev/null)"
STASH_DIR=""
if [ -n "$STASHES" ]; then
  echo "$STASHES"
  warn "часть твоих правок может лежать ТОЛЬКО здесь — выгружаю их в патчи"
  STASH_DIR="$(pwd)/logs/share-stashes"
  mkdir -p "$STASH_DIR"
  i=0
  while [ "$i" -lt 20 ] && git rev-parse --verify -q "stash@{$i}" >/dev/null 2>&1; do
    git stash show -p "stash@{$i}" > "$STASH_DIR/stash-$i.patch" 2>/dev/null
    i=$((i+1))
  done
  ok "выгружено патчей: $i → logs/share-stashes/ (сами стэши не тронуты)"
  warn "патчи в PR не поедут (logs/ в .gitignore) — пришли их отдельно, если нужны"
else
  ok "стэшей нет"
fi

# ── 2. Что вообще менялось ──────────────────────────────────────────────────
step "2. Твои изменения"
CHANGED="$(git status --porcelain --untracked-files=no)"
if [ -n "$CHANGED" ]; then
  echo "$CHANGED"
  git add -u
  ok "отслеживаемые правки собраны"
else
  warn "правок в отслеживаемых файлах нет"
fi

# Новые файлы — поштучно, мимо .gitignore и стоп-листа секретов.
DENY='(^|/)\.env$|(^|/)config\.js$|keys?\.(txt|json)$|sessions?\.json$|tg_pool|credentials|active-key|cookies|\.pem$|\.pfx$'
NEW="$(git ls-files --others --exclude-standard)"
if [ -n "$NEW" ]; then
  echo
  b "Новые файлы (в git их ещё нет):"
  echo "$NEW" | while read -r f; do [ -n "$f" ] && echo "  $f"; done
  if ask "Добавить какие-то из них в PR? (буду спрашивать по одному)" N; then
    echo "$NEW" | while read -r f; do
      [ -n "$f" ] || continue
      if printf '%s' "$f" | grep -qiE "$DENY"; then
        warn "пропускаю (похоже на секрет): $f"
        continue
      fi
      ask "  добавить $f ?" N && git add -- "$f" && ok "добавлен $f"
    done
  fi
fi

git diff --cached --quiet 2>/dev/null && HAS_DIFF=0 || HAS_DIFF=1

# ── 3. Диагностика машины — в тело PR ───────────────────────────────────────
step "3. Диагностика (doctor.sh) в описание PR"
PR_BODY="$(pwd)/logs/share-pr-body.md"
mkdir -p logs
{
  echo "Версия с машины, где дашборд не завёлся. Собрано \`share.sh\`."
  echo
  echo "- ветка от: \`$(git log --oneline -1 2>/dev/null)\`"
  echo "- node: \`$(node --version 2>/dev/null || echo 'нет')\` · npm: \`$(npm --version 2>/dev/null || echo 'нет')\`"
  echo "- claude code: \`$(claude --version 2>/dev/null || echo 'нет в PATH')\`"
  echo
} > "$PR_BODY"
if ask "Приложить отчёт doctor.sh? (репа публичная — в путях видно имя твоего юзера)" Y; then
  bash tools/doctor.sh </dev/null >/dev/null 2>&1
  if [ -f logs/doctor-report.txt ]; then
    { echo '<details><summary>doctor-report.txt</summary>'; echo; echo '```'
      head -c 40000 logs/doctor-report.txt; echo; echo '```'; echo '</details>'; } >> "$PR_BODY"
    ok "отчёт вложен в описание PR"
  else
    warn "doctor.sh отчёт не создал — пропускаю"
  fi
fi

if [ "$HAS_DIFF" = "0" ]; then
  warn "коммитить нечего: код не менялся, дело в окружении"
  echo "  Пришли в ТГ: logs/share-pr-body.md (там doctor-отчёт) и, если есть, logs/share-stashes/"
  have explorer && explorer "$(cygpath -w "$(pwd)/logs" 2>/dev/null || pwd)" >/dev/null 2>&1
  finish 0
fi

# ── 4. Ветка + коммит ───────────────────────────────────────────────────────
step "4. Ветка и коммит"
WHO="$(git config user.name 2>/dev/null | tr -cd '[:alnum:]._-' | tr '[:upper:]' '[:lower:]')"
[ -z "$WHO" ] && WHO="$(hostname 2>/dev/null | tr -cd '[:alnum:]._-' | tr '[:upper:]' '[:lower:]')"
[ -z "$WHO" ] && WHO="friend"
BR="friend/$WHO-$(date +%m%d-%H%M)"
git checkout -b "$BR" >/dev/null 2>&1 || { err "не удалось создать ветку $BR"; finish 1; }
git commit -q -m "$WHO: версия репы с машины, где дашборд не завёлся

Собрано share.sh. Секреты (.env, ключи, сессии) не включены.
Диагностика машины — в описании PR." || { err "коммит не прошёл"; finish 1; }
ok "ветка $BR"

# ── 5. Push + PR ────────────────────────────────────────────────────────────
step "5. Отправка"
if git push -u origin "$BR" 2>&1 | tail -3; then
  ok "ветка улетела в origin"
  if have gh && gh auth status >/dev/null 2>&1; then
    gh pr create --repo "$UPSTREAM" --base master --head "$BR" \
      --title "$WHO: версия с машины, где дашборд не завёлся" --body-file "$PR_BODY" 2>&1 | tail -3
  else
    b "Открой ссылку и жми «Create pull request»:"
    echo "  https://github.com/$UPSTREAM/compare/$BR?expand=1"
    echo "  описание для PR — в logs/share-pr-body.md"
  fi
  finish 0
fi

warn "прямой push отклонён (нет прав на репу) — иду через форк"
if have gh && gh auth status >/dev/null 2>&1; then
  GH_USER="$(gh api user -q .login 2>/dev/null)"
  if [ -n "$GH_USER" ]; then
    gh repo fork "$UPSTREAM" --clone=false --remote=false >/dev/null 2>&1
    if git push -u "https://github.com/$GH_USER/$(basename "$UPSTREAM").git" "$BR" 2>&1 | tail -3; then
      gh pr create --repo "$UPSTREAM" --base master --head "$GH_USER:$BR" \
        --title "$WHO: версия с машины, где дашборд не завёлся" --body-file "$PR_BODY" 2>&1 | tail -3
      finish 0
    fi
  fi
  warn "через gh не вышло"
else
  warn "gh (GitHub CLI) не установлен — форк автоматом не сделать"
fi

# ── 6. Оффлайн-запасной путь: папка с патчами на рабочий стол ───────────────
step "6. Запасной путь — патчи файлами (прислать в ТГ)"
OUT="$HOME/Desktop/autoreger-share-$(date +%m%d-%H%M)"
mkdir -p "$OUT"
git format-patch origin/master..HEAD -o "$OUT" >/dev/null 2>&1 \
  || git format-patch -1 HEAD -o "$OUT" >/dev/null 2>&1 \
  || git diff origin/master..HEAD > "$OUT/changes.patch" 2>/dev/null
cp -f "$PR_BODY" "$OUT/" 2>/dev/null
[ -n "$STASH_DIR" ] && cp -f "$STASH_DIR"/*.patch "$OUT/" 2>/dev/null
ok "папка готова: $OUT"
echo "  Пришли её содержимое в Телеграм — накатим у себя (git am)."
have explorer && explorer "$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")" >/dev/null 2>&1
finish 0
