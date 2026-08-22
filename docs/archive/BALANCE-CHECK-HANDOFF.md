# ХЕНДОФФ: чек баланса AgentRouter в дашборде

> **⚠️ ИСПОЛНЕНО И УСТАРЕЛО (2026-08-18).** План ниже реализован, но потом заменён:
> угадывание гранта убрано, остаток берётся **точно** из `GET /api/user/self` куками
> аккаунта. Строка 31 этой таблицы угадала правильный эндпоинт — оказалось, что он и есть
> решение, а не «опционально». Актуальное описание — `ARCHITECTURE.md`, раздел
> «Баланс ключа (продажа на FunPay)»; код — `routing/lib/newapi-account.js` +
> `newapiBalance()` в `routing/transparent-proxy.js`. Файл оставлен как история решения.

**Для:** Claude Opus (любая модель с глубокой обработкой кода)
**Дата:** 2026-08-13
**Проект:** `C:\Users\WormAlien\Desktop\Autoreger_Clean`
**Статус:** план готов, код не писан. Делать тебе.

---

## Цель

Во вкладке **AgentRouter** дашборда (:8200) показать для каждого ключа **остаток в долларах**, считая разницу **выдача − потрачено**. Прямого баланса по API-ключу сервис не отдаёт — только потраченное. Выдачу угадываем по шагу $25.

## Контекст бизнеса (важно для UI-текстов)

Пользователь продаёт ключи AgentRouter на FunPay. Схема:
- Аккаунты регаются через GitHub (за это капают кредиты: старт **$175**, затем порциями по **$25** за отметку на сайте, рефка +$100)
- Ключ из аккаунта продаётся отдельно (~$175 баланса за ~400-450₽)
- Чекер баланса нужен, чтобы **проверить ключ перед продажей**: живой ли, сколько осталось, не перетрачен ли
- Важно: агент **НЕ должен** делать ничего для обхода правил сервиса — только читать публичные эндпоинты своим ключом

## API-эндпоинты Agent Router (реверс из kirillabernathee.github.io/apikeyscheck)

Всё — `fetch` с Node 18+ (уже используется в transparent-proxy.js). Base: `https://agentrouter.org`.

| Эндпоинт | Auth | Что даёт |
|---|---|---|
| `GET /api/status` | нет | `quota_per_unit` = 500000 (единиц квоты за $1) |
| `GET /v1/dashboard/billing/subscription` | `Bearer sk-…` | `hard_limit_usd` (у безлимитных = **100000000 — sentinel-заглушка**, не баланс!), `system_hard_limit_usd`, `access_until` |
| `GET /dashboard/billing/usage?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` | `Bearer sk-…` | `total_usage` — **в центах** (делить на 100), за 400 дней назад → сегодня |
| `GET /api/user/self` | голый access token (без Bearer) | `quota` (остаток) + `used_quota` (потрачено) в единицах квоты — **точная выдача**, но нужен токен консоли (владельца, покупателю не давать) |

**Логика расчёта (проверена на живом ключе `sk-K88k…JveY`):**
- spent = `total_usage / 100` → было **$88.56**
- grant (угадываем): `max(175, ceil(spent/25)*25)` → $175
- balance = grant − spent → **$86.44**
- НЕ брать `hard_limit_usd` как баланс — там sentinel 100M у безлимитных

## Реализация

### 1. Backend: `routing/transparent-proxy.js`

Рядом с `arProbe` (строка ~4400) добавить:

```js
const AR_QUOTA_PER_UNIT = 500000; // уточняется из /api/status при первом чеке
const AR_GRANT_STEP = 25;
const AR_DEFAULT_GRANT = 175;
const AR_SENTINEL_USD = 1000000; // всё выше = заглушка, не баланс

async function arBalance(apiKey) {
  // 1. GET /dashboard/billing/usage (400 дней → сегодня), Bearer
  //    spent = total_usage / 100
  // 2. (опц.) GET /api/status → qpu
  // 3. grant = max(175, ceil(spent/25)*25)
  // 4. balance = grant - spent
  // 5. (опц.) GET /v1/dashboard/billing/subscription → access_until, isSaneLimit
  // return { spent, grant, balance, accessUntil, source: 'auto'|'account', error? }
}
```

- Добавить handler `handleArBalance(req, res)` — `GET /__switch/api/ar/balance?api_key=…` (по аналогии с `handleArPing`, строка 4428)
- Зарегистрировать роут рядом со строкой 5242 (`/__switch/api/ar/ping`)
- Таймаут запросов: `AbortSignal.timeout(15000)`, как в `arProbe`
- На 401/403 → `{ status: 'dead' }` — ключ дохлый, баланс не считаем
- На 200, но `total_usage` = 0 → баланс = grant = $175 (свежий, ничего не тратил)

### 2. Frontend: `routing/proxy-dashboard.html`

Вкладка AgentRouter (строка ~1454), секция `ar-list`:

- В таблицу ключей (`renderAr()`, строка ~4480) добавить **колонку «Баланс»** между Status и Actions
- Кнопка `💰` (или текст «чек») для каждого ключа → `fetch('/__switch/api/ar/balance?api_key=…')`
- Отображение: `$86.44` зелёным если > 30% от grant, янтарным если 10-30%, красным если < 10% или dead
- Тултип/подпись: `выдано $175 · потрачено $88.56`
- При `status === 'dead'` — показывать `🔴` вместо баланса

Опционально (если останется время):
- Кнопка «💳 балансы всех» в шапке вкладки → прогон `handleArSessions` + `arBalance` по всем ключам параллельно (чанками по 3, как в `handleArSessions`)
- Кэш в `state.arBalance = { api_key: {...} }`, авто-запрос после probe

### 3. Вики (после реализации)

Обновить `D:\WORMALIENAIGIGANT\wiki\entities\ABUSE HUB.md` (обычными файловыми правками — `Edit`/`Write`; MCP obsidian убраны 2026-08-19):
- Добавить порт/функцию balance-check в таблицу сервисов
- `wiki/log.md` — запись `## [2026-08-13] feat | …`
- `wiki/meta/Debug Reference.md` — если будут грабли (sentinel-лимит, центы total_usage)

## Проверка

1. `node -e` скриптом с реальным ключом: `arBalance` должен вернуть `{ spent: 88.56, grant: 175, balance: 86.44 }`
2. Дашборд: открыть вкладку AgentRouter → чек ключа → виден баланс
3. До/после: `routing/restart-dashboard.bat`, UI подхватывается по F5 (HTML отдаётся per-request), бэк-роут — рестарт прокси

## Грабли (уже найдены, не наступай)

- `total_usage` — **центы**, дели на 100
- `hard_limit_usd` = 100M — sentinel, НЕ баланс. Проверять `isSaneLimit(v): v > 0 && v < 1e6`
- `access_until` может быть `0` — обрабатывать как «нет срока»
- Поле в дашборде можно вообще не заполнять вручную — grant угадывается по шагу $25
- Access token консоли НЕ запрашивать у пользователя дашборда (покупатель не должен его знать) — только внутренний, если вообще понадобится