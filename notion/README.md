# Notion Autoreger

Автоматизация регистрации аккаунтов Notion.

## Проверенные данные (25.05.2026)

### Временная почта
- **Сервис:** emailnator.com
- **Домен:** Gmail (с точками) — Notion принимает
- **Пример:** `m.yl.lasan.j.os.e@gmail.com`

**Как работает:**
1. Заходим на https://www.emailnator.com/
2. Принимаем Consent popup
3. Копируем сгенерированный email
4. Для проверки почты: https://www.emailnator.com/mailbox#EMAIL_ЗДЕСЬ

**НЕ работают с Notion:**
- mail.tm (домен wshu.net заблокирован)
- tempmail.lol (домены заблокированы)

### Временные номера США
- **Сервис:** sms-online.co
- **Рабочий номер:** `+1 201-857-7757`
- **URL:** https://sms-online.co/receive-free-sms

⚠️ Публичные номера — могут быть заблокированы Notion

### Биллинг данные (USA)
```
Имя: Michael Johnson
Адрес: 456 Oak Avenue
Город: Los Angeles
Штат: CA
Индекс: 90001
Страна: United States / US
Телефон: +1 201-857-7757
```

Альтернатива (New York):
```
Имя: John Smith
Адрес: 123 Main Street
Город: New York
Штат: NY
Индекс: 10001
Страна: United States / US
```

### Карта (проверено)
```
Номер: 6233586376545103
Месяц/Год: 07/2029
CVC: 747
```

## URL регистрации
```
https://www.notion.so/signup?from=marketing&pathname=%2Fexplore
```

## Процесс регистрации

1. **Email** — ввести временный Gmail от emailnator
2. **Код подтверждения** — получить из emailnator mailbox (6 цифр)
3. **Данные профиля** — имя, телефон США
4. **Биллинг** — адрес США + карта

## Зависимости

- Node.js 18+
- Playwright

## Файлы

- `notion_autoreger.js` — основной скрипт (в разработке)
- `config.js` — конфигурация (в разработке)
