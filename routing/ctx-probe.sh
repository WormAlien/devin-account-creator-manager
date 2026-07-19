#!/usr/bin/env bash
# Проба реального окна контекста бэкенда (не веры Claude Code).
# Шлём prompt заданного размера с max_tokens=1:
#   прошло       -> окно >= размера пробы
#   отбило       -> в ошибке точный лимит: "prompt is too long: X > Y maximum"
# usage: ctx-probe.sh [base_url] [key] [model] [ktok]
#   ctx-probe.sh https://cc.freemodel.dev "" claude-opus-4-6 210   # 200k или больше?
#   ctx-probe.sh https://cc.freemodel.dev "" claude-opus-4-6 550   # найти потолок до 1M
# Результат вносить в таблицу real_max в statusline-autoreger.sh.
set -u
BASE="${1:-https://cc.freemodel.dev}"
KEY="${2:-}"
[ -z "$KEY" ] && KEY="$(cat ~/.claude/fm-active-key.txt 2>/dev/null | tr -d '[:space:]')"
MODEL="${3:-claude-opus-4-6}"
NTOK="${4:-210}"

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

python3 - "$MODEL" "$NTOK" "$BODY" << 'PYEOF'
import json, sys
model, ntok, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
filler = ("lorem ipsum dolor sit amet " * 40 + "\n") * (ntok * 1000 // 270)
body = {"model": model, "max_tokens": 1,
        "messages": [{"role": "user", "content": filler + "\nSay hi."}]}
with open(out, "w") as f:
    json.dump(body, f)
PYEOF

echo "== $BASE  model=$MODEL  ~${NTOK}k tok =="
curl -s -m 120 -X POST "$BASE/v1/messages" \
    -H "content-type: application/json" \
    -H "x-api-key: $KEY" \
    -H "anthropic-version: 2023-06-01" \
    --data @"$BODY" | head -c 1500
echo
