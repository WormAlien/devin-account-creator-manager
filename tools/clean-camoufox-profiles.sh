#!/usr/bin/env bash
# clean-camoufox-profiles.sh — убрать протёкшие профили Camoufox.
#
# Три скрипта создают профиль на КАЖДЫЙ запуск и никогда его не убирают:
#   freemodel/lib/camoufox_tmailor.py:18     camoufox_tmailor_profile_<PID>
#   freemodel/lib/camoufox_emailnator.py:15  camoufox_emailnator_profile_<PID>
#   anymodel/lib/camoufox_anymodel.py:23     camoufox_anymodel_profile_<PID>
# К 2026-08-21 накопилось 580 каталогов на 37.4 ГБ — это 82% веса всего репо.
#
# Скрипт удаляет только те профили, чей PID в системе уже не жив, поэтому его
# безопасно запускать при работающих авторегах. Живые профили провайдеров
# (tabi/profiles, gorouter/profiles, agentrouter/profiles, xpeach/profiles,
# github/profiles, tools/tg-profiles, routing/tokenrouter/chrome-profile)
# не подпадают под маску и не трогаются.
#
# Usage:
#   bash tools/clean-camoufox-profiles.sh --dry-run   # только показать
#   bash tools/clean-camoufox-profiles.sh             # удалить
set -u

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1

# Один дамп tasklist вместо 580 вызовов: PID'ы живых процессов в set.
# ВАЖНО: фильтр по имени образа обязателен. Windows переиспользует номера PID,
# и без фильтра 21 из 580 мёртвых профилей выглядели «живыми» только потому, что
# их номер успел занять посторонний процесс. Живым профиль делает не номер,
# а то, что этот номер принадлежит camoufox/firefox/python.
live=" $(MSYS_NO_PATHCONV=1 tasklist /FO CSV /NH 2>/dev/null \
        | awk -F'","' 'tolower($1) ~ /^"?(camoufox|firefox|python|pythonw)\.exe$/ {gsub(/"/,"",$2); print $2}' \
        | tr '\n' ' ') "

kept=0; killed=0; alive=0
for d in freemodel/lib/camoufox_tmailor_profile_* \
         freemodel/lib/camoufox_emailnator_profile_* \
         anymodel/lib/camoufox_anymodel_profile_*; do
    [ -d "$d" ] || continue
    pid="${d##*_}"
    # Двое воротец, и оба обязательны. Номер PID — необходимое условие, но не
    # достаточное: 2 из 580 мёртвых профилей (от 08.07 и 07.08) совпали с номерами
    # живых сторонних python.exe. Живой профиль обязан быть ещё и свежим по mtime.
    case "$live" in
        *" $pid "*)
            if [ -n "$(find "$d" -maxdepth 0 -mmin -120 2>/dev/null)" ]; then
                echo "жив, пропуск: $d (PID $pid, изменён < 2 ч назад)"; alive=$((alive+1)); continue
            fi
            ;;
    esac
    if [ "$DRY" = 1 ]; then
        kept=$((kept+1))
    else
        rm -rf "$d" && killed=$((killed+1))
        [ $((killed % 50)) -eq 0 ] && echo "$(date +%H:%M:%S)  удалено $killed"
    fi
done

echo
if [ "$DRY" = 1 ]; then
    echo "DRY RUN: под удаление $kept каталогов, живых профилей $alive"
else
    echo "Удалено каталогов: $killed, пропущено живых: $alive"
fi
