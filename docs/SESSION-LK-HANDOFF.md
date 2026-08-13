# Хендофф: Кнопка «ЛК» (вход в сессию агентроутера) на аккаунте

**Цель:** По кнопке на аккаунте в дашборде открывать консоль `agentrouter.org` под **сохранённой GitHub-сессией** этого аккаунта — чтобы заходить в ЛК и получать чек-ин **+$25**.

**Порядок работы:** сначала доделай первый хендофф (`BALANCE-CHECK-HANDOFF.md`, баланс уже почти готов). Эта задача — отдельная, файлы не пересекаются, но backend и frontend одни и те же — правь аккуратно.

---

## Уже готово (НЕ переделывать)

- **`agentrouter/open-session.js <label>`** — открывает консоль agentrouter в видимом Chromium:
  - сессии `agentrouter/sessions/<label>.json` нет → ждёт ручного GitHub-логина, **автосохраняет** сессию как только URL дойдёт до `/console` и появится сессионная cookie (без Enter);
  - сессия есть → открывает с ней;
  - `--reuse` = только открыть, не пересохранять;
  - после логина браузер остаётся открытым (чек-ин жмёт пользователь сам);
  - exit 0 = успех, 2 = таймаут логина (5 мин).
- **`agentrouter/login_and_save_session.js`** / **`restore_session.js`** — ручной вариант (по паттерну freemodel), для запуска вручную.

---

## Что сделать

### 1. Backend (`routing/transparent-proxy.js`, рядом с `handleArBalance` ~4522)

Добавить роут `POST /__switch/api/ar/session/open`, body `{ api_key }`:

1. Найти сессию в `agentrouter-sessions.json` по `api_key`.
2. `label` = sanitized `name`/`email` аккаунта (`[^\w-] → _`). Если поле пустое — `ar_<порядковый номер>`.
3. **Spawn** скрипта, detached, независимо от дашборда:
   ```js
   const { spawn } = require('child_process');
   const proc = spawn(process.execPath, [path.join(__dirname, '..', 'agentrouter', 'open-session.js'), label], {
     detached: true, stdio: 'ignore',
   });
   proc.unref();
   ```
4. Вернуть `{ ok: true, label }`.
5. Не логировать `api_key` целиком (только хвост `***xxxxxx`).
6. Дубликат-спавн: хранить `arLkPids` map label → pid, при повторном клике не спавнить второй раз, если pid ещё жив.

Зарегистрировать роут рядом со строкой ~5336 (`/__switch/api/ar/session/open`).

### 2. Frontend (`routing/proxy-dashboard.html`, `renderAr` ~4480)

В Actions каждой строки аккаунта добавить кнопку:
```js
${actBtn(`arOpenLk(${kJ})`, 'Открыть ЛК (GitHub-сессия, чек-ин +$25)', '🌐', 'violet')}
```
Функция:
```js
async function arOpenLk(api_key) {
  const res = await fetch('/__switch/api/ar/session/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key }),
  });
  const data = await res.json();
  toast(data.ok ? '🌐 Браузер открыт (чек-ин +$25)' : (data.error || 'ошибка'), data.ok ? 'ok' : 'warn');
}
```

### 3. Проверка

- Клик «🌐» на аккаунте → открывается видимый Chromium с консолью agentrouter.
- Первый раз (нет сессии) → логин через GitHub → сессия автосохраняется → чек-ин.
- Повторный клик → браузер открывается с уже сохранённой сессией.
- Backend-роут — рестарт через `routing/restart-dashboard.bat`; UI подхватывается по F5.

---

## Грабли

- `child_process.spawn` с `detached: true` + `proc.unref()` — иначе процесс умрёт вместе с дашбордом или будет держать его живым.
- Путь к скрипту — абсолютный (`path.join(__dirname, '..', 'agentrouter', 'open-session.js')`), не относительный.
- Не использовать `login_and_save_session.js` в спавне — он ждёт Enter в терминале, из дашборда Enter не нажать. Только `open-session.js` (автосохранение по URL).
- `process.execPath` — это `node`, скрипт использует Playwright из корневых `node_modules` проекта — путь к скрипту должен быть внутри проекта.