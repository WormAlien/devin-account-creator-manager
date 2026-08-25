#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  HUB.command — двойной клик на Mac. Всё в одном меню: запуск, остановка,
#  перезапуск, обновление, диагностика (hub.js).
#
#  Двойной клик по .command — не то же самое, что запуск из терминала:
#    * файл приезжает с карантином macOS → снимаем xattr (иначе «неизвестный
#      разработчик» вместо запуска);
#    * exec-бит теряется на копиях репо, приехавших как 100644 → chmod;
#    * PATH у GUI-процесса МИНИМАЛЬНЫЙ: ни /opt/homebrew/bin, ни /usr/local/bin,
#      ни nvm. Поэтому node ищем сами — «node: command not found» при живом
#      node в терминале сбивает с толку сильнее всего.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
xattr -cr . 2>/dev/null
chmod +x "$0" hub.js 2>/dev/null

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo
  echo "  Node.js не найден."
  echo
  echo "  Поставь и запусти файл снова:"
  echo "      brew install node"
  echo
  read -r -p "  Enter, чтобы закрыть окно... " _
  exit 1
fi

"$NODE" hub.js "$@"
RC=$?

# Окно Terminal при двойном клике закрывается вместе с выводом, поэтому при
# ошибке просим Enter. При чистом выходе через меню пауза не нужна и мешает.
if [ "$RC" != "0" ]; then
  echo
  echo "  Хаб вышел с кодом $RC."
  read -r -p "  Enter, чтобы закрыть окно... " _
fi
exit $RC
