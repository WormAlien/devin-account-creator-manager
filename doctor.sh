#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  doctor.sh — диагностика, НИЧЕГО не меняет. Пишет отчёт в doctor-report.txt
#  Запуск: двойной клик DOCTOR.bat (или bash doctor.sh). Отчёт прислать целиком.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"
R="doctor-report.txt"

{
echo "===== DOCTOR REPORT $(date +%F_%T) ====="
echo
echo "--- 1. Где мы ---"
echo "pwd: $(pwd)"
echo "pwd -W: $(pwd -W 2>/dev/null)"
echo
echo "--- 2. Git ---"
git log --oneline -3 2>&1
echo "status:"; git status --short 2>&1 | head -15
echo "remote: $(git remote get-url origin 2>&1)"
echo
echo "--- 3. Дубли репы на дисках (двойная вложенность?) ---"
ls -d hub-cc vibe-code-account-creator-manager 2>/dev/null && echo "!!! ВЛОЖЕННАЯ КОПИЯ РЕПЫ ВНУТРИ РЕПЫ !!!"
for d in /c /d; do
  find "$d" -maxdepth 3 -name "transparent-proxy.js" -path "*routing*" 2>/dev/null | head -5
done
echo
echo "--- 4. Python ---"
py -0 2>&1 || echo "py launcher нет"
python --version 2>&1 || echo "python в PATH нет"
ls "$LOCALAPPDATA/Programs/Python/" 2>/dev/null || echo "в LOCALAPPDATA питонов нет"
echo
echo "--- 5. tg-venv ---"
# Путь до интерпретатора внутри venv платформозависим: Scripts/python.exe на
# Windows, bin/python на macOS. Спрашиваем резолвер, а не хардкодим виндовый
# вариант — иначе на маке доктор врёт «venv не создан» при живом venv.
TGPY="$(node tools/tg-venv-python.js 2>/dev/null)"
if [ -n "$TGPY" ] && [ -f "$TGPY" ]; then
  echo "интерпретатор: ЕСТЬ ($TGPY)"
  cat tools/tg-venv/pyvenv.cfg 2>/dev/null
  echo "import-тест:"
  "$TGPY" -c 'import opentele, tgcrypto; print("IMPORT OK")' 2>&1 | tail -5
else
  echo "интерпретатор: НЕТ (tools/tg-venv не создан или пустой; ожидался ${TGPY:-?})"
  ls tools/ 2>/dev/null
fi
echo
echo "--- 6. Лог последней сборки venv ---"
tail -30 "${TEMP:-/tmp}/tg-venv-install.log" 2>/dev/null || echo "лога нет (сборка не запускалась?)"
echo
echo "--- 7. sqlite3 ---"
for c in "$LOCALAPPDATA/Microsoft/WinGet/Links/sqlite3.exe" "$HOME/bin/sqlite3.exe"; do
  [ -f "$c" ] && echo "ЕСТЬ: $c" || echo "нет: $c"
done
echo
echo "--- 8. Дашборд: кто слушает порты ---"
netstat -ano 2>/dev/null | grep -E "LISTENING" | grep -E ":(8200|20126|20128) " || echo "порты 8200/20126/20128 никто не слушает"
# Front-door :20100 — вход Claude Code по умолчанию. Если он лежит, а settings.json
# на него смотрит, CC не работает НИ с одним провайдером, и это первое, что надо видеть.
echo
echo "--- 8b. Front-door :20100 (вход Claude Code) ---"
FD_ST="$(curl -s --max-time 3 http://127.0.0.1:20100/__frontdoor/api/status 2>/dev/null)"
if [ -n "$FD_ST" ]; then
  echo "жив: $FD_ST"
else
  echo "НЕ ОТВЕЧАЕТ. Если в settings.json стоит http://127.0.0.1:20100 — Claude Code сейчас мёртв."
  echo "  Лечение: запустить дашборд (он поднимает :20100 сам) либо кнопка «🔄 поднять» в Health."
fi
[ -f "$HOME/.claude/active-backend.json" ] && echo "активный бэкенд: $(tr -d '\n' < "$HOME/.claude/active-backend.json")" \
  || echo "active-backend.json нет — дашборд ещё не выбирал провайдера (front-door будет отвечать 503)"
echo
echo "--- 9. Node ---"
node --version 2>&1; npm --version 2>&1
echo
echo "--- 10. Статус-лайн Claude Code ---"
# Самая частая жалоба: внизу CC видно только «← for agents», а строки
# provider/model │ $… │ ⧉ … нет. Причина всегда одна из двух: в settings.json
# путь к несуществующему файлу (перенесли/переименовали папку), либо указатель
# на корень репо записан с CRLF и путь не находится. Проверяем ровно это.
CLAUDE_HOME="$HOME"
[ -f "$CLAUDE_HOME/.claude/settings.json" ] || {
  up="$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')"
  [ -n "$up" ] && command -v cygpath >/dev/null 2>&1 && CLAUDE_HOME="$(cygpath -u "$up")"
}
SET_J="$CLAUDE_HOME/.claude/settings.json"
echo "settings.json: $SET_J"
if [ -f "$SET_J" ]; then
  # Парсим НОДОЙ, а не grep: в JSON путь лежит с экранированными кавычками
  # ("bash \"C:/…\""), grep обрывался на первой из них, а ещё в файле есть свои
  # "command" у хуков — можно было напечатать чужую строку.
  node -e '
    const fs=require("fs");
    let s={}; try{ s=JSON.parse(fs.readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,"")); }
    catch(e){ console.log("!!! settings.json не парсится: "+e.message); process.exit(0); }
    const cmd=(s.statusLine&&s.statusLine.command)||"";
    if(!cmd){ console.log("statusLine: НЕТ (выключен) → node tools/enable-statusline.js"); process.exit(0); }
    console.log("statusLine.command: "+cmd);
    const m=cmd.match(/"([^"]+)"|(\S+\.sh)/); const p=m?(m[1]||m[2]):"";
    if(!p){ console.log("  путь в команде не распознан — статус-лайн, похоже, чужой"); process.exit(0); }
    console.log("  файл команды: "+(fs.existsSync(p)?"ЕСТЬ":"!!! НЕТ → node tools/enable-statusline.js")+" ("+p+")");
  ' "$SET_J" 2>&1
else
  echo "!!! settings.json нет — Claude Code ещё не запускался?"
fi
PTR="$CLAUDE_HOME/.claude/autoreger-root.txt"
if [ -f "$PTR" ]; then
  echo -n "указатель на репо: "; cat "$PTR"
  grep -q $'\r' "$PTR" && echo "  (в файле CRLF — шим это переживает начиная с 2026-08-20, на старой копии статус-бар пропадал)"
  PTR_ROOT="$(head -n1 "$PTR" | tr -d '\r')"
  [ -f "$PTR_ROOT/routing/statusline-autoreger.sh" ] \
    && echo "  воркер по указателю: ЕСТЬ" \
    || echo "  воркер по указателю: !!! НЕТ — запусти дашборд из актуальной папки"
else
  echo "указатель $PTR: НЕТ → запусти дашборд (restart-dashboard) или node tools/enable-statusline.js"
fi
echo "живой прогон статус-лайна:"
echo '{"model":{"id":"doctor-test"},"context_window":{"total_input_tokens":1000,"context_window_size":200000}}' \
  | bash "$CLAUDE_HOME/.claude/autoreger-statusline.sh" 2>&1 | cat -v | tail -3
echo
echo "--- 11. Бэкенд и ключ Claude Code ---"
# Перенесено из install.sh (2026-08-20): установщику диагностика не нужна, а тут
# она к месту. Сам ключ НЕ печатаем — только имя файла и код ответа шлюза.
#
# Ключа может не быть вовсе: если ANTHROPIC_BASE_URL смотрит в локальный прокси
# (keepalive :20133 и т.п.), apiKeyHelper не нужен, ключ подставляет прокси.
# Поэтому бэкенд пингуем В ЛЮБОМ случае — «CC молчит» чаще всего означает
# «локальный прокси не поднят», а не «ключ дохлый».
BASE_URL=$(grep -o '"ANTHROPIC_BASE_URL"[^,]*' "$SET_J" 2>/dev/null | grep -o 'https\?://[^"]*' | head -1)
KEY_FILE=$(grep -o '[A-Za-z0-9_-]*active-key[A-Za-z0-9_.-]*' "$SET_J" 2>/dev/null | head -1)
echo "ANTHROPIC_BASE_URL: ${BASE_URL:-НЕТ (Claude Code пойдёт в облако Anthropic)}"
if [ -n "$KEY_FILE" ]; then
  if [ -s "$CLAUDE_HOME/.claude/$KEY_FILE" ]; then
    echo "файл ключа: ~/.claude/$KEY_FILE (непустой)"
  else
    echo "!!! ~/.claude/$KEY_FILE пустой или отсутствует — Claude Code скажет 'Authentication failed'"
    echo "    фикс: активировать ключ в дашборде (вкладка провайдера → Активировать)"
  fi
else
  echo "apiKeyHelper с *-active-key.txt в settings.json нет — ключ подставляет прокси"
fi
if [ -n "$BASE_URL" ] && command -v curl >/dev/null 2>&1; then
  KEY_HDR=""
  [ -n "$KEY_FILE" ] && [ -s "$CLAUDE_HOME/.claude/$KEY_FILE" ] \
    && KEY_HDR="$(cat "$CLAUDE_HOME/.claude/$KEY_FILE")"
  if [ -n "$KEY_HDR" ]; then
    HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL%/}/v1/models" \
      -H "x-api-key: $KEY_HDR" 2>/dev/null)
  else
    HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL%/}/v1/models" 2>/dev/null)
  fi
  case "$HTTP" in
    000|"") echo "!!! $BASE_URL НЕ ОТВЕЧАЕТ — прокси не поднят? запусти restart-dashboard" ;;
    401|403) echo "!!! $BASE_URL отверг ключ ($HTTP) — ключ дохлый, активируй другой в дашборде" ;;
    200) echo "бэкенд отвечает: $BASE_URL → 200" ;;
    502|503|504) echo "$BASE_URL жив, но АПСТРИМ не ответил ($HTTP) — шлюз лежит/ключ провайдера дохлый/VPN" ;;
    # 404/405 от локального прокси — норма: он проксирует /v1/messages, а не /v1/models.
    *) echo "бэкенд слушает: $BASE_URL → HTTP $HTTP (для локального прокси 404/405 — норма)" ;;
  esac
fi
echo
echo "===== КОНЕЦ ====="
} > "$R" 2>&1

echo
echo "Отчёт готов: $(pwd -W 2>/dev/null || pwd)/$R"
echo "Открываю в блокноте — скопируй ВЕСЬ текст и пришли."
notepad "$R" 2>/dev/null || start notepad "$R" 2>/dev/null || cat "$R"
read -r -p "Enter для выхода..." _
