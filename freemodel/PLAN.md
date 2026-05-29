# FreeModel.dev Autoreg — План

**Дата:** 2026-05-28
**Цель:** Массовая регистрация аккаунтов на freemodel.dev для получения $10 баланса и API-ключа на каждый. Каждый ключ → новый коннект в OmniRoute → больше квоты на Claude Opus 4.7 / GPT-5.5 / Codex.

## Архитектура

```
[hero-sms.com API] ──→ TG номера + коды
        │
        ▼
[TG-аккаунты] ──→ передаются боту FreeModel ──→ код подтверждения
        │
        ▼
[Playwright] ──→ regform на freemodel.dev
        │
        ▼
[freemodel/keys.txt] ──→ email|password|api_key|tg_phone
        │
        ▼
[OmniRoute API] ──→ автодобавление провайдера с новым ключом
```

## Поток одного аккаунта

1. Заказать TG-номер на hero-sms.com (`getNumber`, service=tg)
2. Создать TG-аккаунт через telethon: phone → SMS код → 2FA пропуск
3. Сохранить `.session` файл в `freemodel/sessions/<phone>.session`
4. Открыть Playwright, перейти на `freemodel.dev/invite/FRE-db15a867`
5. Создать email через emailnator (Gmail с точками) — есть в `notion/notion_autoreger.js`
6. Заполнить форму регистрации, выбрать **Telegram verification**
7. FreeModel показывает username бота → telethon шлёт `/start` от имени аккаунта
8. Бот возвращает код → читаем через telethon → вводим в форму
9. После регистрации: Dashboard → API Keys → Create Key → копируем `fe_xxx`
10. Сохраняем строку `email|password|api_key|tg_phone` в `freemodel/keys.txt`
11. (Опционально) дёргаем OmniRoute API: добавить новый Anthropic-провайдер с этим ключом

## Стек

- **SMS/TG:** hero-sms.com — https://hero-sms.com/ru/api
- **Email:** emailnator.com (Gmail с точками) — функция уже есть в `notion/notion_autoreger.js`
- **TG логин:** Python + Telethon (или Node `gramjs`/`telegram` npm пакет — чтобы не плодить языки)
- **Браузер:** Playwright (как в существующем `autoreger.js`)
- **Хранилище ключей:** `freemodel/keys.txt` (gitignored) + опционально SQLite для статусов
- **Интеграция с OmniRoute:** REST API на `http://localhost:20128/api/...`

## Файлы (план)

```
freemodel/
├── PLAN.md                    # этот файл
├── README.md                  # инструкция запуска
├── config.js                  # настройки: hero-sms key, кол-во аккаунтов, country
├── freemodel_autoreger.js     # основной цикл
├── lib/
│   ├── hero-sms.js            # клиент hero-sms.com API
│   ├── telegram-account.js    # gramjs создание/логин TG-аккаунта
│   ├── emailnator.js          # вынести из notion/
│   └── omniroute-add.js       # автодобавление в OmniRoute
├── sessions/                  # .session файлы TG (gitignored)
├── keys.txt                   # email|password|api_key|tg_phone (gitignored)
└── logs/
```

## Решения по умолчанию

- **Один TG-аккаунт = один FreeModel-аккаунт.** Не переиспользуем TG между регами FreeModel — баним всю цепочку.
- **TG-аккаунты регаем on-demand**, не заранее. Каждая итерация: купил номер → создал TG → зарегал FreeModel → выкинул TG.
- **Country:** Россия по дефолту (дешевле всего на hero-sms), переопределяется в config.
- **2FA на TG** не ставим — только лишний шаг и потеря номера если что.
- **Прокси:** один прокси = одна регистрация (как в основном `autoreger.js`). Иначе freemodel забанит по IP.

## Следующие шаги

1. ☐ Изучить hero-sms.com API (`https://hero-sms.com/ru/api`) — формат вызовов, service code для TG, цены
2. ☐ Изучить FreeModel signup flow вручную — какие поля, как выглядит TG-вериф (бот username и т.д.)
3. ☐ Прототип `lib/hero-sms.js` — getNumber/getStatus/setStatus
4. ☐ Прототип `lib/telegram-account.js` — создать TG-акк по номеру (gramjs)
5. ☐ Прототип `freemodel_autoreger.js` — собрать всё вместе на 1 аккаунте
6. ☐ Тест end-to-end на 1 аккаунте
7. ☐ Параллелизация на N аккаунтов с прокси-ротацией
8. ☐ Авто-добавление ключа в OmniRoute через REST API

## Бюджет

- 300₽ на hero-sms.com → надо узнать цену TG-номера. Если ~3-7₽/SMS, то ~40-100 регистраций FreeModel
- Каждая = $10 баланса = ~$400-1000 кредита суммарно

## Риски

- **Бан freemodel по паттерну:** одинаковые user-agent, одинаковые fingerprint, частые реги с одного IP → реализовать ротацию
- **Бан TG-аккаунта при первом сообщении боту:** свежий TG без прогрева может уйти в read-only. Решение: между созданием и /start выждать 30-60с, написать в Saved Messages что-то нейтральное
- **FreeModel меняет инвайт-коды или закрывает регистрацию:** хардкодить инвайт в config, мониторить
- **hero-sms.com нет TG-номеров в нужный момент:** добавить fallback на sms-activate / smsfast

## Связанное

- Основной autoreger: `../autoreger.js` (Devin.ai)
- Аналог: `../notion/notion_autoreger.js`
- OmniRoute уже настроен локально, FreeModel Claude провайдер добавлен
