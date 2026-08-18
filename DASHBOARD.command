#!/bin/bash
# Двойной клик на Mac: поднимает дашборд и открывает UI в браузере.
# Первый запуск снимает карантин macOS (xattr) — если это не сработало,
# выполни один раз в Terminal:  xattr -cr /путь/к/папке
cd "$(dirname "$0")" || exit 1
xattr -cr . 2>/dev/null
bash routing/restart-dashboard.sh