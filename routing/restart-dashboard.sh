#!/usr/bin/env bash
# macOS/Linux аналог routing/restart-dashboard.bat.
#
# Поднимает:
#   :20126 FM-ротатор           routing/freemodel-rotator.js
#   :20130 FM-OpenAI-прокси     routing/freemodel-openai-proxy.js
#   :20131 VyceAI-прокси        routing/vyceai-openai-proxy.js
#   :8200  Дашборд              routing/transparent-proxy.js
#         (он сам boot-спавнит AR-конвертер :20132 и keepalive :20133;
#          keepalive GoRouter :20156 / Tabi :20155 поднимаются при активации)
#
# Ничего в существующем коде не меняет: для Windows-юзеров restart-dashboard.bat
# работает как раньше. Здесь мы лишь подсовываем shim-ы (netstat/taskkill/...),
# чтобы Windows-вызовы в проде работали на macOS, и стартуем те же node-скрипты.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/routing" || { echo "! нельзя зайти в routing/"; exit 1; }

# Shim-ы в начало PATH: transparent-proxy и дочерние процессы найдут их раньше системных
SHIM_DIR="$ROOT/mac-support/shims"
# node зовёт их через execFile напрямую — нужен exec-bit (git с Windows его не хранит)
chmod +x "$SHIM_DIR"/* 2>/dev/null
export PATH="$SHIM_DIR:$PATH"

# sqlite3 на macOS встроен в систему — говорим коду, где его искать
if [ -x /usr/bin/sqlite3 ]; then
  export SQLITE3=/usr/bin/sqlite3
fi

PORT_NAMES="8200:dashboard 20126:FM-rotator 20130:FM-OpenAI 20131:VyceAI 20132:AR-converter 20133:AR-keepalive 20155:Tabi-keepalive 20156:GoRouter-keepalive"

kill_port() {
  local port="$1" name="$2" pids tries=0
  pids="$(lsof -ti ":$port" 2>/dev/null)"
  if [ -z "$pids" ]; then
    echo "  :$port ($name) свободен"
    return 0
  fi
  echo "  :$port ($name) — останавливаю PID: $(echo "$pids" | tr '\n' ' ')"
  # SIGTERM сначала, потом ждём, потом SIGKILL
  kill $pids 2>/dev/null
  sleep 1
  pids="$(lsof -ti ":$port" 2>/dev/null)"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null
  fi
  while [ -n "$(lsof -ti ":$port" 2>/dev/null)" ] && [ "$tries" -lt 8 ]; do
    tries=$((tries + 1))
    sleep 1
  done
  if [ -n "$(lsof -ti ":$port" 2>/dev/null)" ]; then
    echo "  !!! порт :$port не освободился (кто-то другой держит?)"
  fi
}

echo "== Останавливаю порты =="
for pn in $PORT_NAMES; do
  kill_port "${pn%%:*}" "${pn##*:}"
done

echo
echo "== Старт FM-ротатора :20126 =="
nohup node freemodel-rotator.js >> dashboard.out.log 2>&1 &
sleep 2

echo "== Старт FM-OpenAI-прокси :20130 =="
nohup node freemodel-openai-proxy.js >> dashboard.out.log 2>&1 &
sleep 2

echo "== Старт VyceAI-прокси :20131 =="
nohup node vyceai-openai-proxy.js >> dashboard.out.log 2>&1 &
sleep 2

echo "== Старт дашборда :8200 (transparent-proxy.js) =="
nohup node transparent-proxy.js >> dashboard.out.log 2>&1 &

# Ждём статус дашборда (до 8с)
RETRY=0
while [ "$RETRY" -lt 8 ]; do
  if curl -s --max-time 2 http://localhost:8200/__switch/api/status >/dev/null 2>&1; then
    break
  fi
  RETRY=$((RETRY + 1))
  sleep 1
done

echo
echo "  Дашборд:  http://localhost:8200/__switch"
echo "  Статус:   http://localhost:8200/__switch/api/status"
echo

# Открыть браузер (macOS — `open`, Linux — xdg-open)
if command -v open >/dev/null 2>&1; then
  open http://localhost:8200/__switch
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open http://localhost:8200/__switch 2>/dev/null &
fi

# В интерактивном терминале держим окно открытым, как это делает .bat
if [ -t 0 ]; then
  read -r -p "Нажми Enter, чтобы закрыть окно... " _
fi

exit 0
