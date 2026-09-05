# Холодная загрузка вкладок дашборда — ход работы

Владею только `routing/proxy-dashboard.html`. Чужие файлы (в т.ч. `tools/check-*.js`) не правлю.

## Базовый прогон ДО правок (всё зелёное)

| прогон | итог |
|---|---|
| `node tools/check-league-chat.js` | 100 прошло, 0 упало (внутри: 7 inline-блоков разбираются, DOMContentLoaded == 2) |
| `node tools/check-log-tabs.js` | зелёный |
| `node tools/check-provider-sort.js` | зелёный |
| `node tools/check-hub.js` | 119 пройдено, 0 провалено |

Замер ручек хаба `:8200` (curl, тела в /dev/null): plugins/list 1.3 мс, mcp/list 2.3 мс,
env 2.5 мс, settings/current 1.5 мс, settings/backups **37.7 мс / 25 КБ**, frontdoor 2.8 мс,
custom/providers 1.3 мс.

Кеш моделей кастомных провайдеров (`routing/custom-models-cache.json`) против 7 провайдеров:
6 записей возрастом ~9.6 ч (внутри окна 24 ч → отдаются из кеша), одна —
`https://xpeach.codes/v1`, 432 ч → **старше `CUSTOM_MODELS_STALE_MS` (24 ч), уйдёт в апстрим**.

## Правки

### ✅ 1a. Гвард на `grokRenderSaved` в `showTab`
Якорь был `if (name === 'grok') { grokRenderSaved(); }` → стало
`if (name === 'grok' && typeof grokRenderSaved === 'function')` + комментарий-причина.
Проверка: `check-league-chat.js` → 100/0, 7 блоков, DOMContentLoaded == 2.

### ✅ 1b. Порядок инициализации в хвосте блока 5
Якорь `applyTabsConfig();` + блок `{ let _tab = localStorage.getItem('opencode_active_tab') ... }`.
Обе регистрации `document.addEventListener('DOMContentLoaded', ...)` (панель логов +
журнал подмен по MONEY_PROVIDERS) перенесены ВЫШЕ `applyTabsConfig()` и восстановления
вкладки; сам `showTab(_tab)` обёрнут в `try/catch` с `console.warn('[boot] восстановление
вкладки', _tab, 'упало:', e)`. Число обработчиков не изменилось (2).
Проверка: `check-league-chat.js` → 100/0.

### ✅ 2. Проверка измеримости в двух обработчиках `resize`
- Якорь `latResizeTimer = setTimeout(...)`: цикл по `LAT_DATA` теперь пропускает провайдера,
  у которого `$(pfx + '-lat-chart')` отсутствует или `clientWidth === 0`. `$` в этом блоке —
  id-хелпер (строка 8028, `const $ = (id) => document.getElementById(id)`), не селекторный из блока 3.
- Якорь `addEventListener('resize', () => { if (LG.plot) lgDrawPlot(...) })`: тот же пропуск по
  `document.getElementById('lg-plot')`. Взят `getElementById` напрямую, как в самом `lgDrawPlot`,
  чтобы не зависеть от того, какой `$` виден в блоке 7.
- Фолбэки `|| 600` / `|| 1000` / `|| 900` НЕ тронуты; `fitViewBox` не тронут — его обработчик
  `resize` (строка ~3704) уже имеет такую проверку по `.scene`, с неё и списан шаблон.
Проверка: `check-league-chat.js` → 100/0.

### ✅ 3a. `plugins` — второе задание в очередь
Якорь `{ tab: 'plugins',     fn: () => loadPlugins() },` → следом добавлено
`{ tab: 'plugins',     fn: () => loadMcp() },` (отдельным заданием, чтобы очередь выдержала
свою паузу 120 мс между ними). Цена: `/api/mcp/list` = чтение `~/.claude.json`, 2.3 мс.

### ✅ 3b. `custom` — настоящая загрузка вместо цифры
Задание перенесено В КОНЕЦ списка (после `fin`) и переписано: `mark: 'custom'`, и
глубина по флагу — первый проход зовёт `loadCustomProviders()`, все следующие остаются
на прежнем `navCountOnly` для бейджа. Причина условия — замер: `customRender()` в конце
зовёт `customAutoLoadModels()`, а тот бьёт в `/custom/models` по всем 7 провайдерам
параллельно; **замер burst'а: 1.50 с на 7 запросов, шесть из кеша (~0.2 с), седьмой
(xpeach.codes) уходит в апстрим, получает 403 и падает на старый кеш, метку времени НЕ
обновляя** — то есть на круговом тике раз в 20 с это была бы вечная капель в мёртвый шлюз.
Плюс в `loadCustomProviders` добавлен флаг `state.customLoadedOk` (true в конце try, false
в catch) и в задании бросок при `!state.customLoadedOk`: без него `mark` встал бы и на
провалившейся загрузке, а showTab второй раз вкладку не грузит — она осталась бы с текстом
ошибки до F5. Флаг объявлен в `state` рядом с `customLoading`.

### ✅ 3c. `league` — снята задержка, когда лига и есть восстановленная вкладка
Якорь `setTimeout(() => lgLoad(), 2500);` в конце блока 7 → ветка: если
`localStorage.opencode_active_tab === 'league'`, сразу `lgRender()` (рисует «срез
считается…» вместо пустоты) + `lgLoad()` + `state.loaded.league = true`; иначе прежний
таймер 2.5 с. `showTab` до лиги не доезжает — его гвард по typeof её отсекает, так что
таймер был единственным, кто её включал.

### ⛔ 3d. `settings` — сознательно НЕ сделано
Причины (в комментарии над `NAV_COUNT_JOBS`): экономия ~45 мс, которых не видно (все четыре
загрузчика локальные, и showTab зовёт их на КАЖДЫЙ заход, а не однажды), против трёх
издержек: ключ активного шлюза в textarea и ключ OmniRoute в поле ввода с загрузки страницы;
фоновый проход очереди раз в 20 с затирал бы несохранённую правку владельца в редакторе
settings.json, стоило ему отойти на другую вкладку; два загрузчика из четырёх ругаются
toast'ом — на старте это всплывашка ни к чему.

## Итоговые прогоны (после всех правок)

| прогон | итог |
|---|---|
| `node tools/check-league-chat.js` | 100 прошло, 0 упало (7 inline-блоков OK, DOMContentLoaded == 2) |
| `node tools/check-log-tabs.js` | exit 0 |
| `node tools/check-provider-sort.js` | ✅ всё зелёное |
| `node tools/check-hub.js` | 119 пройдено, 0 провалено |
| `node tools/check-league.js` | 51 прошло, 0 упало |
| ещё 16 прогонов, читающих `proxy-dashboard.html` | все exit 0 |
| свой `node --check` по каждому inline-блоку | 9 тегов `<script>`, из них 7 inline — все разбираются; CR в файле 0 |

Залп на старте: **+8 запросов** (1 × `/api/mcp/list` + 7 × `/custom/models`), все к
локальному хабу, из них один тянет за собой апстрим-попытку к xpeach.codes (403).
Постоянная цена: **+1 запрос на каждый круг очереди** (раз в 20 с) — только `/api/mcp/list`.
Заданий в очереди 26 против 25.
