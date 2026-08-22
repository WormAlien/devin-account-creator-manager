# Хендофф: on-demand RAG/Ollama/Docker + свипер зомби-браузеров

> ## ⛔ УСТАРЕЛО — стек снят 2026-08-17, документ историческй
>
> Локальный RAG по вики удалён как оверинжиниринг: контейнер `obsidian-rag` :8082, `rag-on.bat`,
> `rag-off.bat`, `rag-idle-stop.ps1`, задача планировщика «Autoreger RAG idle-stop», тома Chroma —
> **ничего из этого больше нет на диске**. По ~350 заметкам обычный `Grep` быстрее и точнее, а
> холодный старт стоил 55 с. MCP-серверы `obsidian`/`obsidian-vault` убраны 2026-08-19.
>
> **Как сейчас:** поиск по вики — `Grep` по `D:\WORMALIENAIGIGANT\wiki`, правки — `Edit`/`Write`
> файлами. Ничего поднимать и гасить не нужно. Не выполнять инструкции ниже.
>
> Живым из этого документа остался только **свипер зомби-браузеров**
> (`routing/cleanup-reg-procs.ps1`, вызывается из `start-switcher.bat`).

**Цель:** Obsidian RAG (`D:\WORMALIENAIGIGANT`) должен **не** жить в фоне и не жрать RAM/CPU, когда не нужен. Стек (Ollama + Docker Desktop + контейнер `obsidian-rag`) поднимается **по требованию** при первом поиске, и сам гасится после простоя. Плюс — уборка зомби-браузеров, которые оставляют автореги.

**Порядок работы:** эта работа **почти доделана** — файлы созданы и зарегистрированы. Тебе осталось **проверить вживую** и **закрыть оставшиеся пункты** ниже. НЕ переделывай готовое.

---

## Уже готово (НЕ переделывать)

### 1. Подъём по требованию — `D:\WORMALIENAIGIGANT\app\rag-on.bat`
Идемпотентный, стартует недостающее звено по очереди:
1. Ollama (`ollama app.exe`) — ждёт `:11434`;
2. Модель `snowflake-arctic-embed2` — тянет, если нет (`ollama pull`);
3. Docker Desktop — ждёт `docker info` до 90с;
4. контейнер: `docker compose --profile app up -d obsidian-rag` (в `app\docker-compose.yml`, сервис с profile `app`, порт `8082:8080`, `OLLAMA_HOST=http://host.docker.internal:11434`);
5. ждёт `http://127.0.0.1:8082/status` до 60с;
6. пишет heartbeat `app\.rag-idle.txt` — чтобы idle-стоппер не убил RAG прямо во время работы.

### 2. Гашение по требованию — `D:\WORMALIENAIGIGANT\app\rag-off.bat`
- `docker compose --profile app stop obsidian-rag`;
- убивает Ollama (`Get-Process 'ollama','ollama app' | Stop-Process -Force`);
- Docker Desktop гасится **только если нет других контейнеров** (`docker ps -q` пуст) — **OmniRoute (в Docker) НЕ трогаем**;
- удаляет heartbeat.

### 3. Авто-стоп по простою — `D:\WORMALIENAIGIGANT\scripts\rag-idle-stop.ps1`
- Если `:8082` жив, а heartbeat старше **15 минут** (или файла нет) → запускает `rag-off.bat`.
- Зарегистрирована **Task Scheduler**: `schtasks /query /tn "Autoreger RAG idle-stop"` → задача **Ready**, каждые 5 минут, ExecutionTimeLimit 2 мин. Триггер — powershell `-File scripts\rag-idle-stop.ps1`.

### 4. `OLLAMA_KEEP_ALIVE=2m` (User env, `setx`)
Уже выставлен — модель выгружается из RAM через 2 мин после последнего запроса. Проверка: `[Environment]::GetEnvironmentVariable('OLLAMA_KEEP_ALIVE','User')` → `2m`.

### 5. `wiki_patch.py` — `cmd_search` сам поднимает RAG
`D:\WORMALIENAIGIGANT\scripts\wiki_patch.py`, функция `cmd_search` (стр. ~248):
- `:8082/status` недоступен → запускает `app\rag-on.bat` через `subprocess.run(["cmd","/c",rag_on], timeout=300)` → повторный запрос статуса;
- если RAG так и не поднялся → `error: RAG still unreachable after rag-on (…) — use `simple` instead` (юзеру не врать про пустой индекс);
- в конце `hb.touch()` heartbeat (`app\.rag-idle.txt`), потом print `# index: N chunks, last indexed …` перед хитами.
- Работает и на авто-старт, и на «я сам запустил rag-on» — идемпотентно.

### 6. Свипер зомби-браузеров — `routing\cleanup-reg-procs.ps1`
- Ищет `chrome.exe`/`camoufox.exe`, чей CommandLine содержит маркер `ms-playwright|github\\profiles|agentrouter\\sessions|camoufox\\Cache` (это ТОЛЬКО наши рег-браузеры, реальный Chrome юзера не матчится);
- убивает `taskkill /F /T /PID`, если родитель мёртв **или** родитель = `explorer.exe` (осиротел после смерти рег-скрипта);
- живой родитель (активная LK-сессия) — **skip**, не трогаем;
- `-Force` = убивать и живые;
- вывод: `kill …` / `skip …` / `No orphan browser zombies found. Clean slate.`
- **Подключён в `routing\start-switcher.bat`** (стр. ~9): `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cleanup-reg-procs.ps1"` — прогоняется при каждом старте дашборда.

### 7. Глобальная команда `/wiki` (opencode)
`C:\Users\WormAlien\.config\opencode\command\wiki.md` — «запиши вики из любой папки». Появляется в TUI только после **рестарта opencode**. Правит вики через MCP/`wiki_patch.py`, RAG поднимает через `search` (см. п.5).

---

## Осталось (сделать/проверить)

> Статус: **живой цикл проверен 2026-08-13** (см. ниже «Проверено вживую»). Пункты 1–5 закрыты.

1. ~~**Вживую прогнать цикл on-demand**~~ — ✅ сделано 2026-08-13.
2. ~~**Проверить idle-стоп**~~ — ✅ сделано 2026-08-13.
3. ~~**Свипер**~~ — ✅ сухой прогон 2026-08-13.
4. ~~**ARCHITECTURE.md**~~ — ✅ секция «Obsidian RAG on-demand + свипер зомби-браузеров» добавлена.
5. ~~**Obsidian-вики**~~ — ✅ `wiki/log.md` (запись `## [2026-08-13] done | On-demand RAG + свипер зомби — живой цикл проверен`) и `wiki/entities/ABUSE HUB.md` (секция «Obsidian RAG on-demand + свипер зомби-браузеров»). Правки через `wiki_patch.py` (top/append), MCP-обвязка не использовалась.
6. **Уведомить юзера:** `/wiki` появится в opencode TUI после рестарта. **НЕ закрыт.**

## Проверено вживую (2026-08-13)

- `rag-on.bat`: поднял Ollama → модель → Docker → контейнер, `RAG is UP`, `/status` = `{"doc_count":4433,...}`.
- `wiki_patch.py search "idle stop Ollama Docker"`: RAG лежал → сам поднял стек через `rag-on.bat` → `# index: 4433 chunks` → 5 хитов.
- Idle-стоп: heartbeat состарен на 20 мин → `rag-idle-stop.ps1` → `RAG idle 20,0 min -> stopping` → `rag-off.bat` → контейнер stop, Ollama убит, heartbeat удалён; Docker Desktop **оставлен** (n8n/OmniRoute крутятся).
- Свипер: убил 3 осиротевших `camoufox.exe`, все живые LK-сессии пропущены.
- **Найден и пофикшен баг `rag-on.bat`:** heartbeat писался только ПОСЛЕ успешного ожидания `/status` (60с), а холодный старт после реиндекса vault дольше → бат падал, heartbeat отсутствовал → idle-stop гасил поднимающийся контейнер. Фикс: heartbeat пишется сразу после `docker compose up`, таймаут `/status` 60с → 180с.

---

## Файлы (полный список)

| Файл | Что |
|---|---|
| `D:\WORMALIENAIGIGANT\app\rag-on.bat` | подъём стека по требованию + heartbeat |
| `D:\WORMALIENAIGIGANT\app\rag-off.bat` | гашение (контейнер + Ollama, Docker осторожно) |
| `D:\WORMALIENAIGIGANT\scripts\rag-idle-stop.ps1` | авто-стоп после 15 мин простоя |
| Task Scheduler «Autoreger RAG idle-stop» | запускает idle-stop каждые 5 мин |
| `D:\WORMALIENAIGIGANT\scripts\wiki_patch.py` | `cmd_search` авто-подъём RAG + heartbeat |
| `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\cleanup-reg-procs.ps1` | убийца зомби-браузеров |
| `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\start-switcher.bat` | вызов свипера при старте |
| `C:\Users\WormAlien\.config\opencode\command\wiki.md` | глобальная команда `/wiki` |
| `~/.claude/settings.json` / env | `OLLAMA_KEEP_ALIVE=2m` (User) |

## Нюансы

- PowerShell 5.1 выводит кириллицу mojibake — файлы читать read-тулом, не консолью.
- `Invoke-WebRequest` в PS 5.1 не дружит с self-signed — для проверки API использовать `curl.exe`.
- В `wiki_patch.py` строки с em-dash `—` — правки только точным совпадением (не дефисом).
- Параллельные сессии/агенты тоже пишут в эти файлы — перед правкой перечитывать, после — не затирать чужое.
