#!/usr/bin/env bash
# Autoreger statusline: [provider] provider/model  $ ▰▰▰▰▱▱▱▱ 70% $217.33
set -u

# ROOT = корень репо (скрипт лежит в <repo>/routing/)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUTING="$ROOT/routing"
LOGS="$ROOT/logs"
SETTINGS="$HOME/.claude/settings.json"

# ---- stdin from Claude Code: model info -----------------------------------
payload="$(cat 2>/dev/null || true)"
# отладка: `touch logs/.statusline-debug` → сырой payload от CC копится в .jsonl
[ -f "$LOGS/.statusline-debug" ] && printf '%s\n' "$payload" >> "$LOGS/.statusline-debug.jsonl"
model_id="$(printf '%s' "$payload" | sed -n 's/.*"model"[[:space:]]*:[[:space:]]*{[^}]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -z "$model_id" ] && model_id="$(printf '%s' "$payload" | sed -n 's/.*"display_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -z "$model_id" ] && model_id="unknown"

# context window: used_percentage приходит готовым (CC ≥2.1.132)
ctx_pct="$(printf '%s' "$payload" | sed -n 's/.*"used_percentage"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -n1)"
ctx_tok="$(printf '%s' "$payload" | sed -n 's/.*"total_input_tokens"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -n1)"
ctx_max="$(printf '%s' "$payload" | sed -n 's/.*"context_window_size"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -n1)"

# ---- active provider: prefer live dashboard /__switch/api/status ----------
raw_target=""
status_json="$(curl -s --max-time 1 http://localhost:8200/__switch/api/status 2>/dev/null || true)"
if [ -n "$status_json" ]; then
    raw_target="$(printf '%s' "$status_json" | sed -n 's/.*"current"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
if [ -z "$raw_target" ]; then
    helper="$(sed -n 's/.*"apiKeyHelper"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SETTINGS" 2>/dev/null | head -n1)"
    base_url="$(sed -n 's/.*"ANTHROPIC_BASE_URL"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SETTINGS" 2>/dev/null | head -n1)"
    case "$helper" in
        *fm-active-key.txt*|*freemodel*) raw_target="apihelper" ;;
        *al-active-key.txt*)             raw_target="aerolink" ;;
        *cdt-active-key.txt*)            raw_target="conduit" ;;
        *ev-active-key.txt*)             raw_target="evomap" ;;
        *ot-active-key.txt*)             raw_target="ourtoken" ;;
        *om-active-key.txt*)             raw_target="omniroute" ;;
        *vyceai-active-key.txt*)         raw_target="vyce_openai" ;;
        *ar-active-key.txt*)             raw_target="agentrouter" ;;
    esac
    if [ -z "$raw_target" ]; then
        case "$base_url" in
            https://api.ourtoken.ai*) raw_target="ourtoken" ;;
            *localhost:20128*)        raw_target="omniroute" ;;
            *localhost:20131*)        raw_target="vyce_openai" ;;
            *localhost:20132*)        raw_target="agentrouter" ;;

            *localhost:8190*)         raw_target="notion" ;;
            *agentrouter.org*)        raw_target="agentrouter" ;;
            *cc.freemodel.dev*)       raw_target="apihelper" ;;
        esac
    fi
fi

# LABELS mirror proxy-dashboard.html:1261 (lowercased for /model format)
# [transport] stays as raw target (apihelper, omniroute, ...) — that's the switcher slot.
# provider/model uses the label — that's what routes to real credentials.
transport="${raw_target:-unknown}"
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
active_name=""

if [ "$provider" = "freemodel" ] && [ -f "$LOGS/.freemodel_quota_cache.json" ] && [ -f "$LOGS/.freemodel_meta.json" ]; then
    active_key="$(cat "$HOME/.claude/fm-active-key.txt" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$active_key" ]; then
        # найти dir аккаунта в meta по apiKey
        active_name="$(awk -v key="$active_key" '
            BEGIN { RS="}"; name=""; found_ok=""; found_any="" }
            {
                if (match($0, /"[^"]+"[[:space:]]*:[[:space:]]*\{/)) {
                    n=substr($0,RSTART,RLENGTH); gsub(/["{:[:space:]]/,"",n); name=n
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
            $0 ~ "\""n"\"[[:space:]]*:[[:space:]]*\\{" { flag=1 }
            flag { print }
            flag && /^[[:space:]]*\}/ { exit }
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
                    cool_ts="$(date -d "$cool_until" +%s 2>/dev/null || echo 0)"
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
            now_ms="$(date +%s%3N 2>/dev/null || echo 0)"
            [ "$upd" -gt 0 ] && stale_age_s=$(( (now_ms - upd) / 1000 ))
            [ "$stale_age_s" -lt 0 ] && stale_age_s=0

            # lazy refresh: асинхронный дёрг рефреша (пишет в общий кэш).
            # Порог 30с, а не 180: рефреш идёт по JSON-API (~1.5с), браузер не
            # поднимается, поэтому держать три минуты устаревшую цифру незачем.
            if [ "$stale_age_s" -gt 30 ]; then
                stale=1
                (curl -s -m 0.5 -X POST -H 'content-type: application/json' \
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
    avail_sum="$(printf '%d.00' "$live")"
    [ "$total" -gt 0 ] && pct=$(( live * 100 / total ))
fi

# ---- render ----------------------------------------------------------------
bars=10
[ "$pct" -gt 100 ] && pct=100
[ "$pct" -lt 0 ] && pct=0
filled=$(( pct * bars / 100 ))
empty=$(( bars - filled ))

if   [ "$pct" -ge 60 ]; then bar_col=$'\033[38;5;42m'
elif [ "$pct" -ge 30 ]; then bar_col=$'\033[38;5;220m'
else                         bar_col=$'\033[38;5;203m'
fi

RESET=$'\033[0m'
DIM=$'\033[2m'
BR_PROV=$'\033[38;5;110m'
MODEL_COL=$'\033[38;5;180m'
SEP=$'\033[38;5;240m'
LABEL=$'\033[38;5;245m'
MONEY=$'\033[38;5;42m'

fill_str=""; i=0
while [ "$i" -lt "$filled" ]; do fill_str="${fill_str}▰"; i=$((i+1)); done
empty_str=""; i=0
while [ "$i" -lt "$empty" ]; do empty_str="${empty_str}▱"; i=$((i+1)); done

printf '%s[%s]%s %s%s/%s%s' \
    "$BR_PROV" "$transport" "$RESET" \
    "$MODEL_COL" "$provider" "$model_id" "$RESET"

if [ "$have_gauge" = "1" ]; then
    # если данные stale — приглушаем цвет шкалы и цифр
    if [ "$stale" = "1" ]; then
        bar_col="$DIM"
        pct_col="$DIM"
        money_col="$DIM"
    else
        pct_col="$LABEL"
        money_col="$MONEY"
    fi

    printf ' %s│%s %s$%s %s%s%s%s%s %s%d%%%s %s$%s%s' \
        "$SEP" "$RESET" \
        "$LABEL" "$RESET" \
        "$bar_col" "$fill_str" "$DIM" "$empty_str" "$RESET" \
        "$pct_col" "$pct" "$RESET" \
        "$money_col" "$avail_sum" "$RESET"

    # ⏳ перезарядка: окно выжрано, аккаунт живой и ждёт налива
    if [ -n "$cool_str" ]; then
        printf ' %s⏳%s%s' $'\033[38;5;220m' "$cool_str" "$RESET"
    fi

    # маркер возраста для freemodel если >60с (stale уже подсвечен цветом)
    if [ "$stale" = "1" ] && [ "$stale_age_s" -gt 0 ]; then
        if   [ "$stale_age_s" -lt 60 ];   then age_str="${stale_age_s}s"
        elif [ "$stale_age_s" -lt 3600 ]; then age_str="$((stale_age_s/60))m"
        else                                   age_str="$((stale_age_s/3600))h"
        fi
        printf ' %s(%s)%s' "$DIM" "$age_str" "$RESET"
    fi
fi

# ---- context window gauge: ⧉ ▰▰▱▱▱ 42% -------------------------------------
# заполнение = занято; цвет от занятости: <50% зелёный, <80% жёлтый, дальше красный

# Показываем ЦИФРЫ CC, не бэкенда: даже если бэкенд принимает больше
# (freemodel — 1M по пробе ctx-probe.sh 2026-07-19), сам Claude Code
# предупреждает и автокомпактит по своему context_window_size (~200k).
# Оверрайд на real_max давал ложные 16% при реальных 90% занятости.

if [ -n "$ctx_pct" ]; then
    [ "$ctx_pct" -gt 100 ] && ctx_pct=100
    ctx_bars=5
    ctx_filled=$(( (ctx_pct * ctx_bars + 50) / 100 ))
    [ "$ctx_filled" -gt "$ctx_bars" ] && ctx_filled=$ctx_bars
    ctx_empty=$(( ctx_bars - ctx_filled ))

    if   [ "$ctx_pct" -lt 50 ]; then ctx_col=$'\033[38;5;42m'
    elif [ "$ctx_pct" -lt 80 ]; then ctx_col=$'\033[38;5;220m'
    else                             ctx_col=$'\033[38;5;203m'
    fi

    ctx_fill=""; i=0
    while [ "$i" -lt "$ctx_filled" ]; do ctx_fill="${ctx_fill}▰"; i=$((i+1)); done
    ctx_emp=""; i=0
    while [ "$i" -lt "$ctx_empty" ]; do ctx_emp="${ctx_emp}▱"; i=$((i+1)); done

    # человекочитаемые токены: 105k/1M — при окне 1M процент почти не двигается
    ctx_tok_str=""
    if [ -n "$ctx_tok" ] && [ -n "$ctx_max" ] && [ "$ctx_max" -gt 0 ]; then
        if [ "$ctx_tok" -ge 1000000 ]; then tok_h="$(awk -v t="$ctx_tok" 'BEGIN{printf "%.1fM", t/1000000}')"
        elif [ "$ctx_tok" -ge 1000 ];  then tok_h="$((ctx_tok/1000))k"
        else                                tok_h="$ctx_tok"
        fi
        if [ "$ctx_max" -ge 1000000 ]; then max_h="$((ctx_max/1000000))M"
        else                                max_h="$((ctx_max/1000))k"
        fi
        ctx_tok_str="$tok_h/$max_h"

        # Бэкенд даёт 1M, а CC считает 200k → в id модели потерялся суффикс [1m].
        # Цифры НЕ подменяем (CC автокомпактит по своему числу, оверрайд давал
        # ложные 16% при реальных 90%) — только помечаем, что окно урезано зря.
        ctx_warn=""
        if [ "$provider" = "freemodel" ] && [ "$ctx_max" -lt 1000000 ]; then
            case "$model_id" in
                *"[1m]"*) ;;            # суффикс на месте — окно урезал не он
                *) ctx_warn="⚠" ;;
            esac
        fi
    fi

    printf ' %s│%s %s⧉%s %s%s%s%s%s %s%d%%%s' \
        "$SEP" "$RESET" \
        "$LABEL" "$RESET" \
        "$ctx_col" "$ctx_fill" "$DIM" "$ctx_emp" "$RESET" \
        "$LABEL" "$ctx_pct" "$RESET"
    [ -n "$ctx_tok_str" ] && printf ' %s%s%s' "$DIM" "$ctx_tok_str" "$RESET"
    # ⚠ = окно урезано до 200k из-за модели без [1m]; лечится /model <id>[1m]
    [ -n "$ctx_warn" ] && printf '%s%s%s' $'\033[38;5;220m' "$ctx_warn" "$RESET"
fi
