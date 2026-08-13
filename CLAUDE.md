# Autoreger_Clean — Agent Instructions

## Что это
Vibe-Code Account Creator Manager: автореги бесплатных Claude-аккаунтов + переключение LLM-бэкенда Claude Code. Каноничный код-документ проекта — `ARCHITECTURE.md`.

## ⚠️ «Обнови вики» = ОБСИДИАН, не только ARCHITECTURE.md

Когда пользователь говорит **«обнови вики»** — это значит обновить **Obsidian vault** `D:\WORMALIENAIGIGANT\wiki` (главный второй мозг владельца). `ARCHITECTURE.md` — только проектная копия, он вторичен.

**Какие страницы обновлять (MCP-инструментами `obsidian-rag` / `obsidian-vault`):**
- `wiki/log.md` — запись о проделанной работе (format: `## [YYYY-MM-DD] {type} | Title`, новые сверху)
- `wiki/entities/Autoreger Clean.md` — порты, модули, статусы, новые фичи
- `wiki/meta/Known Issues.md` — известные проблемы (удалять при решении)
- `wiki/meta/Debug Reference.md` — найденные/пофикшенные баги
- `wiki/overview.md` — если изменился статус системы

**Правила Obsidian-вики:** frontmatter YAML обязателен, wikilinks `[[Note Name]]`, «обновляй, не дублируй». Полный schema — в `D:\WORMALIENAIGIGANT\CLAUDE.md`.

**Важно:** MCP-серверы obsidian зарегистрированы глобально (`~/.claude.json`) — они доступны из этой папки. Правь вики только через MCP, не через прямой read/write.

## Конвенции проекта
- Ключи/токены в `routing/*-keys.json` и `~/.claude/settings.json` — не логировать целиком
- Рестарт дашборда: `routing/restart-dashboard.bat`
- Изменения код-документации → `ARCHITECTURE.md` + параллельно в Obsidian (см. выше)