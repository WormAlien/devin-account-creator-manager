# claude-settings.example.json — пояснения

Пример рабочего `~/.claude/settings.json` (НЕ `.claude/settings.json` внутри проекта!).
Скопируй `claude-settings.example.json` в `~/.claude/settings.json` и поправь под себя.

Switcher на `:8200` правит только `apiKeyHelper` + `env.ANTHROPIC_BASE_URL` +
`env.ANTHROPIC_API_KEY` — всё остальное (TTL=0, отключённый авто-апдейт, модель)
должно уже стоять в файле, иначе FreeModel/Aerolink API Helper не заведётся.

## Ловушки (почему поля стоят именно так)

- **`CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "0"`** — `0` = читать ключ из `apiKeyHelper`
  на КАЖДОМ запросе. Без этого ротация ключей на лету не работает.

- **Версию Claude Code фиксировать не надо.** Раньше в шаблоне стояли
  `DISABLE_AUTOUPDATER: "1"` + `autoUpdates: false` — считалось, что версии новее
  `2.1.153` ломают `apiKeyHelper`. Это не подтвердилось: ротация ключей на лету
  работает на всех версиях. Обе строки убраны, авто-обновление CC не мешает.

- **`model`** — поправь под свой бэкенд. Для Aerolink/Notion-цепочек — алиас,
  который есть в `model_map` / OmniRoute. См. `routing/ROUTING.md`.

> Пояснения держим здесь, а не внутри JSON: поля вида `_README` / `_pitfall_*` —
> это фейковые ключи (JSON не поддерживает комментарии). Claude Code их игнорирует,
> но они мусорят конфиг и путают дашборд-редактор.
