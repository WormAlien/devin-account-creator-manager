# Статус-бар Claude Code не виден — что делать

Симптом: внизу CC только подсказка (`bypass permissions on … · ← for agents`), а
строки `provider/model │ $217.33 │ ⧉ 139k/1M` нет. Ошибок нигде. Подсказка тут ни
при чём — она просто остаётся единственным, что рисуется, когда бар пуст.

## Починка одной командой

Из корня репо:

```bash
git pull
node tools/enable-statusline.js
```

Потом перезапустить Claude Code (конфиг читается на старте).

Скрипт: обновляет `~/.claude/autoreger-root.txt` на текущий корень репо, кладёт
свежий шим в `~/.claude/autoreger-statusline.sh` и прописывает в
`~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "bash \"/Users/<user>/.claude/autoreger-statusline.sh\"" }
```

Бэкап конфига — `~/.claude/settings.backup.json`. Чужой statusLine не трогается
без `--force`.

То же самое делает сам дашборд при каждом старте (`healStatuslinePath`), так что
обычно достаточно просто запустить дашборд из актуальной папки.

## Если не помогло — диагностика

```bash
bash doctor.sh   # или двойной клик DOCTOR.bat
```

Раздел **10** отчёта (`doctor-report.txt`) печатает: что стоит в
`statusLine.command`, существует ли этот файл, куда смотрит указатель на корень
репо, лежит ли там воркер, и живой прогон бара с тестовым payload. Если прогон
пустой — присылай раздел 10 целиком.

Быстрая проверка без CC:

```bash
echo '{"model":{"id":"claude-opus-5"},"context_window":{"total_input_tokens":5000,"context_window_size":200000}}' \
  | bash "$HOME/.claude/autoreger-statusline.sh"
```

## Почему ломалось (закрыто 2026-08-20)

- в `settings.json` был **прямой путь к репо** — перенос/переименование папки
  убивали бар молча; теперь там шим в домашней папке, а корень репо читается из
  `~/.claude/autoreger-root.txt`;
- **пробел в пути** (`.../VibeCode/ABUSE HUB/...`) — незакавыченный путь резался
  по пробелу и указывал в другое место;
- **CRLF в указателе** (его писал `restart-dashboard.bat` через cmd `echo`) —
  путь с хвостовым `\r` не находился; шим теперь срезает `\r` сам;
- **запуск в обход `restart-dashboard`** (`START.bat`, `node routing/transparent-proxy.js`)
  не обновлял указатель — теперь его пишет сам дашборд;
- **macOS:** `timeout`, `date -d`, `date +%s%3N` и awk-классы `[[:space:]]` —
  GNU/новые-awk-зависимости, которых в BSD-окружении нет; ломались молча (модель
  `unknown`, пропавшая шкала баланса, никогда не появлявшийся бейдж `🎁N`).
  Все заменены на портируемые варианты — на маке обязательно `git pull`.

Отладка мусора в баре: `touch logs/.statusline-debug` в корне репо — сырой
payload от CC начнёт копиться в `logs/.statusline-debug.jsonl`.
