# grok-launcher

Headless-probe и Chrome-launcher для SuperGrok Sessions в дашборде.

- `launcher.py` — FastAPI на `:8765`. Использует Playwright/httpx+websockets для чтения квот, plan, identity.
- `cookies/` — Cookie-Editor JSON сессий (`<name>.json`) и мета (`<name>.meta.json`).

## Установка

```
pip install -r requirements.txt
```

Дальше `transparent-proxy.js` сам поднимает launcher при старте дашборда — вручную запускать не нужно.

## Ручной запуск (debug)

```
python launcher.py
```

Слушает `http://127.0.0.1:8765`. Endpoint-ы: `/launch`, `/quota`, `/health`.

## Env

- `PORT` — override порта (по умолчанию 8765)
- `GROK_COOKIE_DIR` — override папки cookies (по умолчанию `./cookies` рядом с launcher.py)
