#!/usr/bin/env bash
# Шим статус-лайна: живёт в ~/.claude/, а работу делает скрипт из репо.
#
# Зачем прослойка. В settings.json Claude Code нужна КОМАНДА с конкретным путём.
# Если писать туда путь до репо, то стоит перенести или переименовать папку
# проекта — и статус-бар отваливается молча (CC зовёт несуществующий файл).
# Копировать сам statusline-autoreger.sh в ~/.claude тоже нельзя: копия
# окаменеет, репа обновится, а CC будет гонять древний файл.
#
# Поэтому: в settings.json прописан путь к ЭТОМУ шиму (он в домашней папке и не
# двигается), а шим читает актуальный корень репо из ~/.claude/autoreger-root.txt.
# Файл-указатель обновляет restart-dashboard.sh/.bat при каждом старте дашборда —
# значит после переноса папки достаточно запустить дашборд из нового места,
# руками ничего править не надо.
#
# stdin (payload от CC) проходит сквозь exec без изменений.
set -u

# Домашняя папка. `bash` в PATH может быть WSL-шным ($HOME=/home/user), а .claude
# лежит в профиле Windows — тогда указателя по $HOME нет. Ищем и там, и там.
prof="$HOME"
if [ ! -f "$prof/.claude/autoreger-root.txt" ]; then
    up="$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')"
    if [ -n "$up" ]; then
        if command -v wslpath >/dev/null 2>&1; then prof="$(wslpath -u "$up")"
        elif command -v cygpath >/dev/null 2>&1; then prof="$(cygpath -u "$up")"
        fi
    fi
fi

root_file="$prof/.claude/autoreger-root.txt"
root=""
[ -f "$root_file" ] && IFS= read -r root < "$root_file" 2>/dev/null
# CR обязателен к срезу: restart-dashboard.bat пишет указатель через cmd `echo`,
# то есть в CRLF. С хвостовым \r путь становится "C:/repo\r/routing/…", файла по
# нему нет, и шим молча выходил — статус-бар исчезал после каждого старта
# дашборда на Windows (внизу оставалась только подсказка «← for agents»).
root="${root%$'\r'}"
root="${root%/}"

target="$root/routing/statusline-autoreger.sh"
if [ -n "$root" ] && [ -f "$target" ]; then
    exec bash "$target"
fi

# Корень неизвестен или папку унесли. Молчим: непустой вывод CC покажет прямо в
# статус-баре, а сыпать туда ошибкой на каждый рендер хуже, чем пустая строка.
# Подсказку оставляем в самом файле-указателе, чтобы её было где прочитать.
exit 0
