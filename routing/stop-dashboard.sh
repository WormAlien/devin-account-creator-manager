#!/usr/bin/env bash
# Остановить дашборд и все его прокси (macOS/Linux).
#
# Зачем отдельным скриптом: на маке всё поднимается через nohup … & и живёт в
# фоне — закрыть окно Terminal недостаточно, процессы остаются (на Windows там
# видимое окно, и оно закрывается вместе с ними). Без этого юзер думает, что
# дашборд остановлен, а :8200 продолжает отвечать из старой папки.
#
# Порты те же, что поднимает restart-dashboard.sh.
# Запуск:  bash routing/stop-dashboard.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_NAMES="8200:dashboard 20126:FM-rotator 20130:FM-OpenAI 20131:VyceAI 20132:AR-converter 20133:AR-keepalive 20155:Tabi-keepalive 20156:GoRouter-keepalive"

kill_port() {
  local port="$1" name="$2" pids tries=0
  pids="$(lsof -ti ":$port" 2>/dev/null)"
  if [ -z "$pids" ]; then
    echo "  :$port ($name) уже свободен"
    return 0
  fi
  echo "  :$port ($name) — останавливаю PID: $(echo "$pids" | tr '\n' ' ')"
  kill $pids 2>/dev/null
  sleep 1
  pids="$(lsof -ti ":$port" 2>/dev/null)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  while [ -n "$(lsof -ti ":$port" 2>/dev/null)" ] && [ "$tries" -lt 8 ]; do
    tries=$((tries + 1))
    sleep 1
  done
  [ -n "$(lsof -ti ":$port" 2>/dev/null)" ] && echo "  !!! :$port не освободился (держит кто-то ещё?)"
  return 0
}

echo "== Останавливаю дашборд =="
for pn in $PORT_NAMES; do
  kill_port "${pn%%:*}" "${pn##*:}"
done

echo
echo "  Готово. Запустить снова: bash routing/restart-dashboard.sh"
echo "  (или двойной клик на DASHBOARD.command)"
exit 0
