# Лига в хабе — шесть правок, ход работы

Владение: `routing/transparent-proxy.js` (только он). Тесты и `proxy-dashboard.html` — чужие, не трогаю.
Базовые счёта ДО правок: `node --check` ok · check-league 51/0 · check-league-chat 100/0 ·
check-journal-tail 85/0 · check-hub 119/0 · check-after-restart 12 ok / 3 fail ([2],[3],[5] —
процесс на старом коде) / 2 skip.

| п. | что | якорь | проверено |
|---|---|---|---|
| 2 | `hubIdentityWrite` пишет `.tmp` + `renameSync` | `function hubIdentityWrite(patch)` | node --check, check-league 51/0, check-league-chat 100/0 |
| 3a | `readJsonBody(req, maxBytes)`: потолок, `httpStatus = 413`, unpipe+pause вместо destroy | `function readJsonBody(req, maxBytes)` | node --check |
| 4 | аватарка соседа через `avatarFromDoc` в `leaguePeers` | `.map(p => ({ ...p, avatar: avatarFromDoc(p.avatar) }))` | node --check, check-league 51/0 |
| 6 | `LEAGUE_AVATAR_RECEIVER_MAX` убрана, комментарий про «длину строки» переписан | `const LEAGUE_NO_RECEIVER` (выше него) | `grep -c LEAGUE_AVATAR_RECEIVER_MAX` = 0, node --check |
| 5 | `leagueWriteGuard` + вызовы на 5 входах записи | `function leagueWriteGuard(req, res)` | node --check; прогон тестов ниже |
| 3b | потолки переданы: ник 64 КБ, аватар 64 КБ, чат 3 МБ; 413 в трёх catch | `readJsonBody(req, LEAGUE_BODY_MAX)` ×2, `readJsonBody(req, LEAGUE_CHAT_BODY_MAX)` | node --check |
| 1 | `handleLeagueAvatarDelete` + маршрут `DELETE …/league/avatar` | `async function handleLeagueAvatarDelete`, `req.method === 'DELETE' && req.url === '/__switch/api/league/avatar'` | node --check; живая проба ниже |

## Готово, счёта ПОСЛЕ всех шести правок

`node --check` OK · check-league **51/0** · check-league-chat **100/0** · check-journal-tail **85/0** ·
check-hub **119/0** · check-after-restart **12 ok / 3 fail / 2 skip** — те же три ([2],[3],[5]:
процесс поднят на старом коде), что и до правок.

Разовый провал [9]/[10] в промежуточном прогоне — таймаут 20 с обмена с приёмником у ЖИВОГО
процесса; на следующем тике сам позеленел (`league-peers.json` обновился в 20:05). Мой код в том
процессе не загружен вовсе, к сети правки не касаются.

Своё, чего нет в чужих тестах, проверено `_research/probe-league-writes.js` — **36/0**:
песочница из того же блока лиги, свой каталог в tmp, приёмник в конфиге мёртвый (порт 1).
Покрывает: снятие лица (200 `{ok:true}`, поле удалено, идемпотентность), `.tmp`+rename в записи
личности, 413 на 70 КБ ника / 70 КБ аватарки / 3.5 МБ чата, 403 на `Sec-Fetch-Site`
cross-site|same-site|none и на чужой `Origin`, 415 на `text/plain` с телом, проход Node-клиентов
(без заголовков браузера) и обнуление негодной аватарки соседа шестью видами мусора.

Файл в **CRLF** целиком (19457 строк, ни одной bare LF) — правки конвенцию не нарушили.

## Догон от координатора (вложения любых файлов) — 21:04

`handleLeagueAtt` **по существу не тронут**: регулярка по-прежнему только `\.webp`, проверка
сигнатуры, зашитый `image/webp`, `nosniff`, никакого `Content-Disposition` (единственное
упоминание в файле — в комментарии-предупреждении). Это и есть безопасное состояние: 400 на всё,
что не webp. Расширения регулярки я НЕ делал — значит и заголовки не нужны.

Сделано только комментариями (поведение нулевое):
- `handleLeague` — цепочка «`report.html` в чате → скачан → открыт с диска → страница читает срез,
  чат и вложения»: `file://` живёт в локальном адресном пространстве, запись закрыта
  `leagueWriteGuard`, ключей на других ручках не достать; это утечка переписки и решение владельца;
- `handleLeagueAtt` — красный блок с требованием: расширил регулярку → в той же правке
  `application/octet-stream` + `Content-Disposition: attachment` для непроверенных байтов; `nosniff`
  от html не спасает (тип при заявленном HTML/XML возвращается заявленным, блокировка касается
  скриптов и стилей), `attachment` читает только навигация; имя файла — `filename` ASCII плюс
  `filename*=UTF-8''…` с доводкой `'()*` после `encodeURIComponent`, выше U+00FF и CR/LF/NUL дают
  `ERR_INVALID_CHAR`.

Перепроверка после комментариев: `node --check` OK · check-league **51/0** · check-league-chat
**156/0** (файл теста переписан соседним агентом в 21:03, вырос с 100 проверок — все зелёные) ·
check-journal-tail **85/0** · check-hub **119/0** · check-after-restart **12/3/2** · своя проба
**36/0**.
