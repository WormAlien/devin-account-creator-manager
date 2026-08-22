# HANDOFF: дашборд :8200 падает спустя время после старта — 2026-08-22

## Симптом
`restart-dashboard.bat` поднимает стек, всё работает несколько минут, потом
`transparent-proxy.js` (:8200) умирает без окна (стартует через `start /MIN`,
окно закрывается вместе с процессом). Пользователь остаётся без дашборда.
Подтверждено сменой PID между проверками: 28332 → 3920 → 57088 → 57452.
Дети переживают родителя и копятся: frontdoor-proxy ×2, keepalive-proxy ×2
(порт :20100 при этом держит только один из них).

## Что НЕ причина (проверено)
- Синтаксис всех четырёх сервисов валиден (`node --check` ok).
- Бут нормальный: вручную слушает `0.0.0.0:8200` + `[::]:8200` за <6 c,
  в тесте прожил 40+ c без падения — краш именно рантаймный, отложенный.
- ~90 node-процессов в системе — это MCP-серверы (playwright, context7,
  chrome-devtools, remnawave), к дашборду отношения не имеют.
- Несколько свёрнутых node-окон при рестарте — НЕ баг: незакоммиченная
  правка в `routing/restart-dashboard.bat` заменила `start /B` → `start /MIN`
  для FM Rotator / FM OpenAI Proxy / Vyce Proxy (комментарий в батнике от
  2026-08-22 объясняет зачем). Косметика.

## Главный подозреваемый
Огромный незакоммиченный дифф (~13 файлов, +1996/−317):
`transparent-proxy.js` (+222: arSaveMerge с инвариантом активного ключа,
ветка selfSnapshot в newapiBalance), `keepalive-proxy.js`,
`routing/lib/gh-live-capture.js`, `agentrouter/open-session.js`
(watchSelfResponses), `tools/check-autorotate.js`. Последний коммит:
95e6c4b feat(dashboard): GitHub-колонка на всех шлюзах...
Вероятно unhandled exception/rejection на каком-то таймере или колбэке
через минуты после бута.

## Как ловить (следующий шаг)
```powershell
$err="$env:TEMP\opencode\tp-crash.err"
$p = Start-Process node -ArgumentList 'transparent-proxy.js' `
  -WorkingDirectory 'C:\Users\WormAlien\Desktop\Autoreger_Clean\routing' `
  -RedirectStandardError $err -RedirectStandardOutput "$env:TEMP\opencode\tp-crash.out" `
  -PassThru -WindowStyle Hidden
# поллить раз в минуту: $p.HasExited; когда упал — читать $err (там стек)
```
Если stderr пуст — смотреть Application Event Log (node.exe, Application Error /
WER) на момент смерти. План Б: `git stash` → проверить стабильность на
закоммиченном коде → распускать стеш по частям.

## Состояние на момент хендоффа
Живы: transparent-proxy PID 57452 (:8200), freemodel-rotator PID 33764 (:20126),
front-door PID 62312 (:20100), frontdoor-сирота PID 39508, keepalive ×2
(PID 41804, 39012). Порты 20130/20131 на момент проверки были свободны.
Логи: routing/frontdoor-proxy.log, routing/keepalive-proxy.log (свежие),
transparent-proxy в файл не пишет — только консоль минимизированного окна
и буфер LOG_BUFFER через API.

## Правило
Файлы пользователя удалять только в корзину
(`~/.claude/scripts/recycle.ps1`), не `rm -rf`.
