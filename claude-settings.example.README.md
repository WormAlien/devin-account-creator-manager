# claude-settings.example.json — пояснения

Пример рабочего `~/.claude/settings.json` (НЕ `.claude/settings.json` внутри проекта!).
Скопируй `claude-settings.example.json` в `~/.claude/settings.json` и поправь под себя.

Switcher на `:8200` правит только `apiKeyHelper` + `env.ANTHROPIC_BASE_URL` +
`env.ANTHROPIC_API_KEY` — всё остальное (TTL=0, отключённый авто-апдейт, модель)
должно уже стоять в файле, иначе FreeModel/Aerolink API Helper не заведётся.

## Ловушки (почему поля стоят именно так)

- **`CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "0"`** — `0` = читать ключ из `apiKeyHelper`
  на КАЖДОМ запросе. Без этого ротация ключей на лету не работает.

- **`DISABLE_AUTOUPDATER: "1"` + `autoUpdates: false`** — Claude Code обязан
  остаться на `2.1.179`, новее ломает `apiKeyHelper`. Обе строки выключают
  авто-обновление. НЕ возвращай `autoUpdatesChannel: "latest"` — оно перетянет
  на свежую версию.

- **`model`** — поправь под свой бэкенд. Для Aerolink/Notion-цепочек — алиас,
  который есть в `model_map` / OmniRoute. См. `routing/ROUTING.md`.

> Пояснения держим здесь, а не внутри JSON: поля вида `_README` / `_pitfall_*` —
> это фейковые ключи (JSON не поддерживает комментарии). Claude Code их игнорирует,
> но они мусорят конфиг и путают дашборд-редактор.
