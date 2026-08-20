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
ls -d vibe-code-account-creator-manager 2>/dev/null && echo "!!! ВЛОЖЕННАЯ КОПИЯ РЕПЫ ВНУТРИ РЕПЫ !!!"
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
if [ -f tools/tg-venv/Scripts/python.exe ]; then
  echo "python.exe: ЕСТЬ"
  cat tools/tg-venv/pyvenv.cfg 2>/dev/null
  echo "import-тест:"
  tools/tg-venv/Scripts/python -c 'import opentele, tgcrypto; print("IMPORT OK")' 2>&1 | tail -5
else
  echo "python.exe: НЕТ (tools/tg-venv не создан или пустой)"
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
echo
echo "--- 9. Node ---"
node --version 2>&1; npm --version 2>&1
echo
echo "===== КОНЕЦ ====="
} > "$R" 2>&1

echo
echo "Отчёт готов: $(pwd -W 2>/dev/null || pwd)/$R"
echo "Открываю в блокноте — скопируй ВЕСЬ текст и пришли."
notepad "$R" 2>/dev/null || start notepad "$R" 2>/dev/null || cat "$R"
read -r -p "Enter для выхода..." _
