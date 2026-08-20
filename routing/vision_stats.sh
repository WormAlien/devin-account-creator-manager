#!/bin/bash
# Vision stability test: 10x small + 10x big, direct notion-manager :8190
# Loads NOTION_API_KEY from routing/.env (gitignored).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; . "$SCRIPT_DIR/.env"; set +a; fi
KEY="${NOTION_API_KEY:?NOTION_API_KEY not set; copy routing/.env.example to .env}"
URL="http://localhost:8190/v1/messages"
LOG=/tmp/vision_stats.log

echo "=== Vision stats: 10x small (30KB) + 10x big (202KB) — direct notion-manager :8190 ===" | tee "$LOG"
echo "Started: $(date)" | tee -a "$LOG"

run_one() {
    local label=$1
    local payload=$2
    local timeout=$3
    local idx=$4
    local out=/tmp/r_${label}_${idx}.out
    local t
    t=$(curl -s -o "$out" -w "%{http_code}|%{time_total}s" --max-time "$timeout" \
        -X POST "$URL" \
        -H "Content-Type: application/json" \
        -H "x-api-key: $KEY" \
        -H "anthropic-version: 2023-06-01" \
        --data-binary "@$payload")
    local snippet
    snippet=$(head -c 200 "$out" | tr -d '\n' | cut -c1-150)
    echo "${label} #${idx}  ${t}  ${snippet}" | tee -a "$LOG"
}

for i in $(seq 1 10); do
    run_one small /tmp/notion-vision-small.json 180 "$i"
done

for i in $(seq 1 10); do
    run_one big /tmp/notion-vision.json 240 "$i"
done

echo "" | tee -a "$LOG"
echo "=== SUMMARY ===" | tee -a "$LOG"
ok_s=$(grep -c "^small.*|200|"  "$LOG")
ok_b=$(grep -c "^big.*|200|"    "$LOG")
fail_s=$(grep "^small " "$LOG" | grep -vc "|200|")
fail_b=$(grep "^big "   "$LOG" | grep -vc "|200|")
echo "small:  ${ok_s}/10 OK, ${fail_s} failed" | tee -a "$LOG"
echo "big:    ${ok_b}/10 OK, ${fail_b} failed" | tee -a "$LOG"
echo "Done:   $(date)" | tee -a "$LOG"
