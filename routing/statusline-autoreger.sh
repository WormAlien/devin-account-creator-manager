#!/usr/bin/env bash
# Autoreger statusline: provider/model │ $217.33~ │ ⧉ 139k/1M
set -u

# ---- stdin from Claude Code: model info -----------------------------------
# Первично берём payload из env STATUSLINE_PAYLOAD (кладёт его wrapper-команда
# из settings.json ДО запуска скрипта — надёжнее, чем гонять пайп через
# wslpath/cygpath, которые могут украсть stdin). Если env нет — читаем stdin,
# но ПЕРВЫМ делом, до любых subprocess-ов: WSL-интероп cmd.exe жрёт stdin-пайп,
# и потом cat не получает ничего → model_id "unknown" и мерцающий статус.
# timeout на cat: без payload в env и с открытым-но-пустым stdin cat блокируется
# НАВСЕГДА → CC убивает statusline по своему таймауту → бар пропадает целиком
# (и контекст, и баланс). 2с — потолок, обычно env есть и cat не вызывается.
#
# ВАЖНО: `timeout` — из GNU coreutils, на macOS его НЕТ. Раньше здесь стоял
# `timeout 2 cat`, и на маке подстановка молча давала пустую строку: model_id
# становился «unknown», а контекстное окно не показывалось вообще (поймано на
# живом маке 2026-08-20). Поэтому читаем bash-native `read -t` — без внешних
# утилит и без форка, работает и в git-bash, и в bash 3.2 из macOS.
payload="${STATUSLINE_PAYLOAD:-}"
if [ -z "$payload" ]; then
    IFS= read -r -d '' -t 2 payload 2>/dev/null || true
    payload="${payload:-}"
fi

# ---- дата: GNU и BSD расходятся, а на маке date только BSD ------------------
# `date -d <ISO>` — GNU-синтаксис; у BSD -d это флаг летнего времени, и разбор
# ISO падает. `date +%s%3N` (миллисекунды) BSD тоже не умеет — оставляет «%3N»
# в строке, из-за чего арифметика возраста кеша ломалась молча.
_iso_epoch() {   # ISO8601 → epoch, 0 если не разобрали
    local iso="$1" s
    s="$(date -d "$iso" +%s 2>/dev/null)" && [ -n "$s" ] && { printf '%s' "$s"; return 0; }
    iso="${iso%%.*}"; iso="${iso%Z}"; iso="${iso%%+*}"
    date -j -u -f '%Y-%m-%dT%H:%M:%S' "$iso" +%s 2>/dev/null || echo 0
}
_now_ms() {      # epoch в миллисекундах; на BSD добиваем нулями до секунды
    local s
    s="$(date +%s%3N 2>/dev/null)"
    case "$s" in
        ''|*[!0-9]*) printf '%s000' "$(date +%s)" ;;
        *)           printf '%s' "$s" ;;
    esac
}

# ROOT = корень репо (скрипт лежит в <repo>/routing/). ${BASH_SOURCE%/*} вместо
# $(dirname) — без форка.
_self="${BASH_SOURCE[0]}"
_dir="${_self%/*}"
ROOT="$(cd "$_dir/.." && pwd)"
ROUTING="$ROOT/routing"
LOGS="$ROOT/logs"

# отладка: `touch logs/.statusline-debug` → сырой payload от CC копится в .jsonl
[ -f "$LOGS/.statusline-debug" ] && printf '%s\n' "$payload" >> "$LOGS/.statusline-debug.jsonl"

# ---- home пользователя (WSL/MSYS-совместимо) ------------------------------
# `bash` в PATH у нас WSL-шный: $HOME=/home/wormalien, а .claude лежит в
# C:\Users\WormAlien. Если настроек по $HOME нет — берём Windows-профиль
# через cmd.exe %USERPROFILE% и конвертируем wslpath/cygpath.
if [ -f "$HOME/.claude/settings.json" ]; then
    PROF="$HOME"
else
    up="$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')"
    if [ -n "$up" ]; then
        if command -v wslpath >/dev/null 2>&1; then PROF="$(wslpath -u "$up")"
        elif command -v cygpath >/dev/null 2>&1; then PROF="$(cygpath -u "$up")"
        else PROF="$HOME"
        fi
    else
        PROF="$HOME"
    fi
fi
SETTINGS="$PROF/.claude/settings.json"

# curl, который достаёт localhost Windows-хоста и из WSL, и из git-bash:
# curl.exe (Windows-native) работает в обоих, plain curl в WSL2 туда не ходит.
if command -v curl.exe >/dev/null 2>&1; then CURL_BIN="curl.exe"; else CURL_BIN="curl"; fi

# ---- payload → поля (bash-native regex, БЕЗ форков) ------------------------
# Раньше это были 6 вызовов sed|head. Каждый форк на Windows ~30-60мс, statusline
# зовётся часто и с таймаутом → скрипт должен быть быстрым. =~ читает всё in-proc.
model_id=""
if [[ "$payload" =~ \"model\"[^}]*\"id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    model_id="${BASH_REMATCH[1]}"
elif [[ "$payload" =~ \"display_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    model_id="${BASH_REMATCH[1]}"
fi
[ -z "$model_id" ] && model_id="unknown"

# context window: used_percentage приходит готовым (CC ≥2.1.132)
ctx_pct=""; [[ "$payload" =~ \"used_percentage\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && ctx_pct="${BASH_REMATCH[1]}"
ctx_tok=""; [[ "$payload" =~ \"total_input_tokens\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && ctx_tok="${BASH_REMATCH[1]}"
ctx_max=""; [[ "$payload" =~ \"context_window_size\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && ctx_max="${BASH_REMATCH[1]}"

# ---- active provider: из settings.json (bash-native, БЕЗ сети) ------------
# Раньше тут был блокирующий `curl :8200` в КАЖДОМ вызове statusline — сеть в
# горячем пути. Провайдер однозначно определяется по apiKeyHelper/ANTHROPIC_BASE_URL
# в settings.json, читаем файл целиком в память и парсим =~ (0 форков, 0 сети).
raw_target=""
settings_raw=""
[ -f "$SETTINGS" ] && settings_raw="$(<"$SETTINGS")"
helper=""; [[ "$settings_raw" =~ \"apiKeyHelper\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && helper="${BASH_REMATCH[1]}"
base_url=""; [[ "$settings_raw" =~ \"ANTHROPIC_BASE_URL\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && base_url="${BASH_REMATCH[1]}"
case "$helper" in
    *fm-active-key.txt*|*freemodel*) raw_target="apihelper" ;;
    *al-active-key.txt*)             raw_target="aerolink" ;;
    *cdt-active-key.txt*)            raw_target="conduit" ;;
    *ev-active-key.txt*)             raw_target="evomap" ;;
    *ot-active-key.txt*)             raw_target="ourtoken" ;;
    *om-active-key.txt*)             raw_target="omniroute" ;;
    *vyceai-active-key.txt*)         raw_target="vyce_openai" ;;
    *ar-active-key.txt*)             raw_target="agentrouter" ;;
    *tabi-active-key.txt*)           raw_target="tabi" ;;
    *gorouter-active-key.txt*)       raw_target="gorouter" ;;
    *xpeach-active-key.txt*)         raw_target="xpeach" ;;
    *custom-active-key.txt*)         raw_target="custom" ;;
esac
if [ -z "$raw_target" ]; then
    case "$base_url" in
        https://api.ourtoken.ai*) raw_target="ourtoken" ;;
        *localhost:20128*)        raw_target="omniroute" ;;
        *localhost:20131*)        raw_target="vyce_openai" ;;
        *localhost:20132*|*localhost:20133*)  raw_target="agentrouter" ;;
        *127.0.0.1:20132*|*127.0.0.1:20133*)  raw_target="agentrouter" ;;
        *localhost:20155*)        raw_target="tabi" ;;
        *localhost:20156*)        raw_target="gorouter" ;;
        *127.0.0.1:20155*)        raw_target="tabi" ;;
        *127.0.0.1:20156*)        raw_target="gorouter" ;;
        # :20157 обязан стоять ДО catch-all Custom-конвертеров ниже (2015[0-9]),
        # иначе xpeach определялся бы как custom.
        *localhost:20157*)        raw_target="xpeach" ;;
        *127.0.0.1:20157*)        raw_target="xpeach" ;;
        *tabitoken.com*)          raw_target="tabi" ;;
        *gorouter.app*)           raw_target="gorouter" ;;
        *xpeach.codes*)           raw_target="xpeach" ;;
        *localhost:8190*)         raw_target="notion" ;;
        *agentrouter.org*)        raw_target="agentrouter" ;;
        *cc.freemodel.dev*)       raw_target="apihelper" ;;
        # Custom OpenAI Proxy (Anthropic→OpenAI конвертер) — порты 20150–20250
        *localhost:2015[0-9]*|*localhost:201[6-9][0-9]*|*localhost:202[0-5][0-9]*)  raw_target="custom" ;;
    esac
fi

# LABELS mirror proxy-dashboard.html:1261 (lowercased for /model format)
case "$raw_target" in
    apihelper|freemodel_rotator) provider="freemodel" ;;
    omniroute)                   provider="omniroute" ;;
    agentrouter)                 provider="agentrouter" ;;
    notion)                      provider="notion" ;;
    aerolink)                    provider="aerolink" ;;
    evomap)                      provider="evomap" ;;
    ourtoken)                    provider="ourtoken" ;;
    conduit)                     provider="conduit" ;;
    vyce_openai)                 provider="vyceai" ;;
    tabi)                        provider="tabi" ;;
    gorouter)                    provider="gorouter" ;;
    xpeach)                      provider="xpeach" ;;
    custom)                      provider="Custom🧪" ;;
    "")                          provider="unknown" ;;
    *)                           provider="$raw_target" ;;
esac

# ---- balance/quota gauge (mirrors dashboard) -------------------------------
pct=0
avail_sum=0
have_gauge=0
cool_str=""     # непустая = аккаунт на перезарядке, тут остаток времени

parse_dollars_sum() {  # print sum of "$X.XX" values in file
    grep -oE '"available"[[:space:]]*:[[:space:]]*"\$[0-9]+\.[0-9]+"' "$1" 2>/dev/null \
        | grep -oE '[0-9]+\.[0-9]+' \
        | awk '{s+=$1} END { printf "%.2f", (s+0) }'
}

stale_age_s=0
stale=0
balance_age_s=-1   # возраст цифры баланса в секундах; -1 = провайдер без кеша баланса
balance_err=""     # непустая = последняя проверка баланса не удалась (таймаут/dead)
active_name=""

# Общий gauge для провайдеров с кешем баланса в <sessions_file> (agentrouter/tabi/gorouter/xpeach):
# дашборд держит там balance/granted/balanceCheckedAt активного ключа. Читаем блок активного
# ключа bash-native (0 форков), avail_sum = balance как есть (дашборд уже посчитал точную
# цифру из /api/user/self либо вывел из вписанного анкера), pct = balance/granted. Ленивый
# рефреш через GET /__switch/api/<endpoint_path>?api_key=… если кеш протух (> <stale_s>).
gauge_from_balance_cache() {
    local sessions_file="$1" active_key_file="$2" endpoint_path="$3" stale_threshold="$4"
    local key raw after before head_obj tail_obj block bal granted anchor grant bonus referral chk bal_i grant_i chk_ts now_s
    have_gauge=0

    key=""; read -r key < "$active_key_file" 2>/dev/null || true
    key="${key//[$' \t\r\n']/}"
    [ -n "$key" ] || return 0

    # весь файл в память, вырезаем объект активного ключа между соседними {…}
    raw="$(<"$sessions_file")"
    [[ "$raw" == *"$key"* ]] || return 0
    after="${raw#*"$key"}"        # хвост от ключа
    before="${raw%%"$key"*}"      # голова до ключа
    head_obj="${before##*\{}"     # от последней { перед ключом
    tail_obj="${after%%\}*}"      # до первой } после ключа
    block="{$head_obj$key$tail_obj}"
    [ -n "$block" ] || return 0

    have_gauge=1
    bal=0;   [[ "$block" =~ \"balance\"[[:space:]]*:[[:space:]]*(-?[0-9]+(\.[0-9]+)?) ]] && bal="${BASH_REMATCH[1]}"
    chk="";  [[ "$block" =~ \"balanceCheckedAt\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && chk="${BASH_REMATCH[1]}"
    # balanceError пишет сервер, когда billing не ответил — цифра не просто стара, а под вопросом
    balance_err=""; [[ "$block" =~ \"balanceError\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && balance_err="${BASH_REMATCH[1]}"
    # Знаменатель шкалы. Приоритет тот же, что у сервера при расчёте balance:
    #   granted       — точная сумма выданного (остаток+расход) из /api/user/self
    #   balanceAnchor — вписанный руками баланс, если точного нет
    #   grant+bonus+referral — легаси-поля старых записей (до перехода на анкер)
    # Знаменатель обязан быть тем же, из которого посчитан balance, иначе шкала
    # уезжает за 100% и перестаёт двигаться.
    granted=0;  [[ "$block" =~ \"granted\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && granted="${BASH_REMATCH[1]}"
    anchor=0;   [[ "$block" =~ \"balanceAnchor\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && anchor="${BASH_REMATCH[1]}"
    grant=0;    [[ "$block" =~ \"grant\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && grant="${BASH_REMATCH[1]}"
    bonus=0;    [[ "$block" =~ \"bonus\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && bonus="${BASH_REMATCH[1]}"
    referral=0; [[ "$block" =~ \"referral\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && referral="${BASH_REMATCH[1]}"
    [[ "$bal" == -* ]] && bal=0
    avail_sum="$bal"
    bal_i="${bal%.*}"
    if [ "${granted%.*}" -gt 0 ] 2>/dev/null; then
        grant_i="${granted%.*}"
    elif [ "${anchor%.*}" -gt 0 ] 2>/dev/null; then
        grant_i="${anchor%.*}"
    else
        grant_i=$(( ${grant%.*} + ${bonus%.*} + ${referral%.*} ))
    fi
    if [ "${grant_i:-0}" -gt 0 ] 2>/dev/null; then pct=$(( bal_i * 100 / grant_i )); else pct=0; fi

    # свежесть по balanceCheckedAt (ISO). balance_age_s наружу — рендер строки
    # показывает возраст цифры, чтобы было видно, обновляется квота или залипла.
    if [ -n "$chk" ]; then
        chk_ts="$(_iso_epoch "$chk")"
        now_s="$(date +%s)"
        [ "$chk_ts" -gt 0 ] && stale_age_s=$(( now_s - chk_ts ))
        [ "$stale_age_s" -lt 0 ] && stale_age_s=0
    else
        # штампа нет вообще — цифра неизвестного возраста, считаем протухшей
        stale_age_s=$(( stale_threshold + 1 ))
    fi
    balance_age_s="$stale_age_s"
    if [ "$stale_age_s" -gt "$stale_threshold" ]; then
        stale=1
        # Только ПИНАЕМ дашборд: `nudge=1` отвечает мгновенно и считает баланс в
        # своём процессе. Раньше здесь висел `curl -m 0.5 … &`, который должен был
        # дождаться медленного (1-2с) billing-эндпоинта — но statusline завершается
        # через ~50мс, и сиротский фоновый curl на Windows сносило вместе с группой
        # процессов, часто ДО отправки запроса. Итог: balanceCheckedAt не двигался
        # часами, а пинок уходил на каждом промпте. Дедуп и троттлинг — на сервере.
        ("$CURL_BIN" -s -m 1 "http://localhost:8200/__switch/api/$endpoint_path?api_key=$key&nudge=1" >/dev/null 2>&1 &) >/dev/null 2>&1
    fi
}

if [ "$provider" = "freemodel" ] && [ -f "$LOGS/.freemodel_quota_cache.json" ] && [ -f "$LOGS/.freemodel_meta.json" ]; then
    active_key="$(cat "$PROF/.claude/fm-active-key.txt" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$active_key" ]; then
        # найти dir аккаунта в meta по apiKey
        # `[ \t]` вместо `[[:space:]]`: awk на маке — BWK, и POSIX-классы он понял
        # только в сборке 2020 года (Ventura+). На более старых macOS класс
        # трактуется как набор литералов, имя аккаунта не находилось и шкала
        # баланса FreeModel просто не выводилась — без единого сообщения.
        active_name="$(awk -v key="$active_key" '
            BEGIN { RS="}"; name=""; found_ok=""; found_any="" }
            {
                if (match($0, /"[^"]+"[ \t]*:[ \t]*\{/)) {
                    n=substr($0,RSTART,RLENGTH); gsub(/["{: \t]/,"",n); name=n
                }
                if (index($0, key) > 0) {
                    found_any=name
                    if (index(name, "_ok_") > 0) found_ok=name
                }
            }
            END { print (found_ok != "" ? found_ok : found_any) }
        ' "$LOGS/.freemodel_meta.json")"
    fi

    if [ -n "$active_name" ]; then
        # вырезаем блок конкретного аккаунта и парсим h5/h5max/updatedAt
        block="$(awk -v n="$active_name" '
            $0 ~ "\""n"\"[ \t]*:[ \t]*\\{" { flag=1 }
            flag { print }
            flag && /^[ \t]*\}/ { exit }
        ' "$LOGS/.freemodel_quota_cache.json")"
        if [ -n "$block" ]; then
            have_gauge=1
            h5="$(printf '%s' "$block"  | grep -oE '"h5"[^0-9]*\$[0-9]+\.[0-9]+'    | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
            h5m="$(printf '%s' "$block" | grep -oE '"h5max"[^0-9]*\$[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
            upd="$(printf '%s' "$block" | grep -oE '"updatedAt"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -n1)"
            # Баланс ("AVAILABLE NOW") = min(деньги, остаток 5h-окна) — источник
            # правды. Окно без денег непригодно, поэтому остаток режем балансом.
            av="$(printf '%s' "$block"  | grep -oE '"available"[^0-9]*\$[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
            [ -z "$h5" ]  && h5=0
            [ -z "$h5m" ] && h5m=0
            [ -z "$upd" ] && upd=0
            [ -z "$av" ]  && av=-1     # -1 = баланс не спарсился, идём по окну

            # Перезарядка: $0.00 при живом окне — это не смерть аккаунта, а ожидание
            # налива. Показываем сколько ждать, иначе шкала в нуле выглядит как «всё».
            fm_state="$(printf '%s' "$block" | grep -oE '"state"[[:space:]]*:[[:space:]]*"[a-z]+"' | grep -oE '(ok|cooldown|dead)' | head -n1)"
            cool_until="$(printf '%s' "$block" | grep -oE '"cooldownUntil"[[:space:]]*:[[:space:]]*"[^"]+"' | sed 's/.*"\([^"]*\)"$/\1/' | head -n1)"
            if [ "$fm_state" = "cooldown" ]; then
                cool_str="?"
                if [ -n "$cool_until" ]; then
                    cool_ts="$(_iso_epoch "$cool_until")"
                    now_s="$(date +%s)"
                    if [ "$cool_ts" -gt "$now_s" ]; then
                        cool_left=$(( cool_ts - now_s ))
                        if [ "$cool_left" -lt 3600 ]; then cool_str="$((cool_left/60))м"
                        else cool_str="$((cool_left/3600))ч$(( (cool_left%3600)/60 ))м"
                        fi
                    else
                        cool_str="вот-вот"
                    fi
                fi
            fi

            avail_sum="$(awk -v u="$h5" -v m="$h5m" -v a="$av" 'BEGIN { r=m-u; if (r<0) r=0; if (a>=0 && a<r) r=a; printf "%.2f", r }')"
            pct="$(awk -v u="$h5" -v m="$h5m" -v a="$av" 'BEGIN { r=m-u; if (r<0) r=0; if (a>=0 && a<r) r=a; if (m>0) printf "%d",(r/m)*100; else print (a==0 ? "0" : "100") }')"

            # свежесть по updatedAt (ms)
            now_ms="$(_now_ms)"
            [ "$upd" -gt 0 ] && stale_age_s=$(( (now_ms - upd) / 1000 ))
            [ "$stale_age_s" -lt 0 ] && stale_age_s=0
            balance_age_s="$stale_age_s"   # возраст цифры → в рендер (см. age_mark)

            # lazy refresh: асинхронный дёрг рефреша (пишет в общий кэш).
            # Порог 30с, а не 180: рефреш идёт по JSON-API (~1.5с), браузер не
            # поднимается, поэтому держать три минуты устаревшую цифру незачем.
            if [ "$stale_age_s" -gt 30 ]; then
                stale=1
                ("$CURL_BIN" -s -m 0.5 -X POST -H 'content-type: application/json' \
                    --data "{\"kind\":\"freemodel\",\"name\":\"$active_name\"}" \
                    http://localhost:8200/__switch/api/session/refresh-quota >/dev/null 2>&1 &) >/dev/null 2>&1
            fi
        fi
    fi
elif [ "$provider" = "ourtoken" ] && [ -f "$ROUTING/ourtoken-sessions.json" ]; then
    # ourtoken: $1 за LIVE ключ (правило из дашборда), % = live/total
    have_gauge=1
    total="$(grep -c '"api_key"' "$ROUTING/ourtoken-sessions.json" 2>/dev/null | head -n1 | tr -cd 0-9)"
    live="$(grep -c '"status"[[:space:]]*:[[:space:]]*"live"' "$ROUTING/ourtoken-sessions.json" 2>/dev/null | head -n1 | tr -cd 0-9)"
    [ -z "$total" ] && total=0
    [ -z "$live" ] && live=0
elif [ "$provider" = "agentrouter" ] && [ -f "$ROUTING/agentrouter-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/agentrouter-sessions.json" "$PROF/.claude/ar-active-key.txt" "ar/balance" 90
elif [ "$provider" = "tabi" ] && [ -f "$ROUTING/tabi-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/tabi-sessions.json" "$PROF/.claude/tabi-active-key.txt" "tb/balance" 90
elif [ "$provider" = "gorouter" ] && [ -f "$ROUTING/gorouter-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/gorouter-sessions.json" "$PROF/.claude/gorouter-active-key.txt" "go/balance" 90
elif [ "$provider" = "xpeach" ] && [ -f "$ROUTING/xpeach-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/xpeach-sessions.json" "$PROF/.claude/xpeach-active-key.txt" "xp/balance" 90
fi

# ---- render ----------------------------------------------------------------
RESET=$'\033[0m'
DIM=$'\033[2m'
MODEL_COL=$'\033[38;5;180m'
SEP=$'\033[38;5;240m'
MONEY=$'\033[38;5;42m'

printf '%s%s/%s%s' "$MODEL_COL" "$provider" "$model_id" "$RESET"

if [ "$have_gauge" = "1" ]; then
    # Возраст цифры показываем текстом: раньше был только тусклый `~`, по которому
    # нельзя было понять «обновляется, просто чуть отстало» или «залипло часы назад».
    # Свежее порога — цвет денег без пометки; протухло — тускло + возраст (2м/3ч/5д).
    age_mark=""
    if [ "$stale" = "1" ]; then
        money_col="$DIM"
        if [ "${balance_age_s:--1}" -ge 0 ] 2>/dev/null; then
            if   [ "$balance_age_s" -lt 3600 ];  then age_mark="~$(( balance_age_s / 60 ))м"
            elif [ "$balance_age_s" -lt 86400 ]; then age_mark="~$(( balance_age_s / 3600 ))ч"
            else                                      age_mark="~$(( balance_age_s / 86400 ))д"
            fi
        else
            age_mark="~"
        fi
        # ошибка последней проверки (таймаут billing / dead-ключ) — цифра не просто стара
        [ -n "$balance_err" ] && age_mark="$age_mark⚠"
    else
        money_col="$MONEY"
    fi

    printf ' %s│%s %s$%s%s%s' \
        "$SEP" "$RESET" \
        "$money_col" "$avail_sum" "$age_mark" "$RESET"

    # ⏳ перезарядка: окно выжрано, аккаунт живой и ждёт налива
    if [ -n "$cool_str" ]; then
        printf ' %s⏳%s%s' $'\033[38;5;220m' "$cool_str" "$RESET"
    fi
fi

# ---- context window: ⧉ 139k/1M --------------------------------------------
# Точные токены показываем вмеcто округлённого used_percentage.
ctx_warn=""
if [ -n "$ctx_max" ] && [ "$provider" = "freemodel" ] && [ "$ctx_max" -lt 1000000 ]; then
    case "$model_id" in
        *"[1m]"*) ;;
        *) ctx_warn="⚠" ;;
    esac
fi

if [ -n "$ctx_tok" ] && [ "$ctx_tok" -gt 0 ] && [ -n "$ctx_max" ] && [ "$ctx_max" -gt 0 ]; then
    format_tokens() {
        local tokens="$1" out_var="$2" formatted
        if [ "$tokens" -ge 1000000 ]; then formatted="$((tokens / 1000000))M"
        elif [ "$tokens" -ge 1000 ]; then formatted="$((tokens / 1000))k"
        else formatted="$tokens"
        fi
        printf -v "$out_var" '%s' "$formatted"
    }

    format_tokens "$ctx_tok" ctx_tok_h
    format_tokens "$ctx_max" ctx_max_h
    printf ' %s│%s %s⧉ %s/%s%s' \
        "$SEP" "$RESET" \
        "$DIM" "$ctx_tok_h" "$ctx_max_h" "$RESET"
else
    # Старые/неполные payload: процент пригоден только еcли Claude Code его поcчитал.
    if [ -n "$ctx_pct" ] && [ "$ctx_pct" -gt 0 ]; then
        [ "$ctx_pct" -gt 100 ] && ctx_pct=100
        printf ' %s│%s %s⧉ %d%%%s' \
            "$SEP" "$RESET" \
            "$DIM" "$ctx_pct" "$RESET"
    elif [ -n "$ctx_max" ] && [ "$ctx_max" -gt 0 ]; then
        # Нулевой usage от gateway не означает пуcтую живую cеccию.
        printf ' %s│%s %s⧉ ?%s' "$SEP" "$RESET" "$DIM" "$RESET"
    fi
fi
[ -n "$ctx_warn" ] && printf '%s%s%s' $'\033[38;5;220m' "$ctx_warn" "$RESET"

# ---- AgentRouter: сколько аккаунтов готовы забрать +$25 --------------------
# Считаем ВСЕГДА, а не только когда активен agentrouter: бонус лежит на всём пуле, и
# знать про него надо, даже сидя на FreeModel. Сброс — суточная граница (по умолчанию
# 08:30 МСК = 05:30 UTC, МСК это UTC+3 без переходов на летнее время).
# Оценка приблизительная: аккаунт, который забрал и потом умер, занижает счёт на 1.
# Точную цифру считает дашборд — здесь важна не арифметика, а «пора идти».
ar_ready=0
if [ -f "$ROUTING/agentrouter-sessions.json" ]; then
    ar_hh=8; ar_mm=30
    if [ -f "$ROUTING/ar-checkin.json" ]; then
        ar_hhmm="$(grep -oE '"resetHhmmMsk"[[:space:]]*:[[:space:]]*"[0-9]{1,2}:[0-9]{2}"' "$ROUTING/ar-checkin.json" 2>/dev/null | grep -oE '[0-9]{1,2}:[0-9]{2}' | head -n1)"
        if [ -n "$ar_hhmm" ]; then
            ar_hh="${ar_hhmm%%:*}"; ar_mm="${ar_hhmm##*:}"
            ar_hh=$((10#$ar_hh)); ar_mm=$((10#$ar_mm))
        fi
    fi
    # Границу считаем секундами от начала UTC-суток: `date -d "…-1:30"` ломается,
    # когда граница раньше 03:00 и час уходит в минус.
    # Начало UTC-суток берём АРИФМЕТИКОЙ, а не `date -d`: GNU-синтаксиса на маке
    # нет, подстановка молча давала 0 и весь блок 🎁 пропускался (поймано в
    # аудите 2026-08-20 — на маке напоминание про +$25 не появлялось никогда).
    ar_now="$(date -u +%s)"
    ar_day=$(( ar_now - ar_now % 86400 ))
    ar_b=$(( ar_day + (ar_hh - 3) * 3600 + ar_mm * 60 ))
    [ "$ar_b" -gt "$ar_now" ] && ar_b=$(( ar_b - 86400 ))
    # BSD: `-r <epoch>`, GNU: `-d @<epoch>` — порядок именно такой, на маке
    # первый же вариант срабатывает и второй не зовётся.
    ar_biso="$(date -u -r "$ar_b" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d "@$ar_b" +%Y-%m-%dT%H:%M:%S 2>/dev/null)"
    # Пустая граница сравнивалась бы с любой датой как «уже забрал» и гасила 🎁.
    if [ -n "$ar_biso" ]; then
        # checkinAt пишется toISOString() → UTC фиксированной ширины, поэтому
        # лексикографическое сравнение строк здесь и есть хронологическое.
        ar_got="$(grep -oE '"checkinAt"[[:space:]]*:[[:space:]]*"[0-9]{4}-[0-9]{2}-[0-9]{2}T[^"]+"' "$ROUTING/agentrouter-sessions.json" 2>/dev/null \
            | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[^"]+' \
            | awk -v b="$ar_biso" '$1 >= b { n++ } END { print n+0 }')"
        ar_live="$(grep -c '"status"[[:space:]]*:[[:space:]]*"live"' "$ROUTING/agentrouter-sessions.json" 2>/dev/null | tr -cd 0-9)"
        [ -z "$ar_live" ] && ar_live=0
        [ -z "$ar_got" ] && ar_got=0
        ar_ready=$(( ar_live - ar_got ))
        [ "$ar_ready" -lt 0 ] && ar_ready=0
    fi
fi
[ "$ar_ready" -gt 0 ] && printf ' %s🎁%d%s' $'\033[38;5;214m' "$ar_ready" "$RESET"

# statusline вcегда уcпешен: поcледняя уcловная команда при пуcтом значении
# может дать exit 1, а Claude Code может cчеcть ненулевой код cбоем.
exit 0
