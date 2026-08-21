# ABUSE HUB (Autoreger_Clean) — Agent Instructions

## Что это
ABUSE HUB (GitHub-репо `WormAlien/hub-cc`, локальная папка `Autoreger_Clean`): автореги бесплатных Claude-аккаунтов + переключение LLM-бэкенда Claude Code. Каноничный код-документ проекта — `ARCHITECTURE.md`.

## ⚠️ «Обнови вики» = ОБСИДИАН, не только ARCHITECTURE.md

Когда пользователь говорит **«обнови вики»** — это значит обновить **Obsidian vault** `D:\WORMALIENAIGIGANT\wiki` (главный второй мозг владельца). `ARCHITECTURE.md` — только проектная копия, он вторичен.

**Какие страницы обновлять (обычными файловыми правками — `Read` / `Edit` / `Write` / `Grep`):**
- `wiki/log.md` — запись о проделанной работе (format: `## [YYYY-MM-DD] {type} | Title`, новые сверху)
- `wiki/entities/Autoreger Clean.md` — порты, модули, статусы, новые фичи
- `wiki/meta/Known Issues.md` — известные проблемы (удалять при решении)
- `wiki/meta/Debug Reference.md` — найденные/пофикшенные баги
- `wiki/overview.md` — если изменился статус системы

**Правила Obsidian-вики:** frontmatter YAML обязателен, wikilinks `[[Note Name]]`, «обновляй, не дублируй». Полный schema — в `D:\WORMALIENAIGIGANT\CLAUDE.md`.

**Важно:** вики — это обычные файлы на диске, правь их напрямую (`Edit` для точечных правок, `Write` для новых заметок, `Grep` для поиска). MCP-серверы `obsidian` / `obsidian-vault` **убраны 2026-08-19** и возвращать их не нужно: их patch-движок молча резал строки (офсеты в LF, срез по CRLF). Не спрашивать про включение MCP.

## Конвенции проекта
- Ключи/токены в `routing/*-keys.json` и `~/.claude/settings.json` — не логировать целиком
- Рестарт дашборда: `routing/restart-dashboard.bat`
- Изменения код-документации → `ARCHITECTURE.md` + параллельно в Obsidian (см. выше)