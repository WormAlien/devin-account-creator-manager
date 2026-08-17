"""Открывает Chromium с куки, ТЫ КЛИКАЕШЬ Настройки → Использование ВРУЧНУЮ.

Скрипт 45 секунд собирает все network responses с bodies. Потом сам сохраняет
всё в probe_out/ и закрывается. Тебе НЕ надо нажимать Enter.
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

SESSION = 'D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/3.json'
# от самого файла, а не от абсолютного пути: папку репо можно переносить
LOG_DIR = Path(__file__).resolve().parent / 'probe_out'
LOG_DIR.mkdir(exist_ok=True)

cookies = json.load(open(SESSION, encoding='utf-8'))
SS_MAP = {'no_restriction': 'None', 'lax': 'Lax', 'strict': 'Strict', 'unspecified': 'Lax'}
def pw_cookie(c):
    dom = c.get('domain') or '.grok.com'
    ss = SS_MAP.get(str(c.get('sameSite') or 'unspecified').lower(), 'Lax')
    o = {'name': c['name'], 'value': c['value'], 'domain': dom,
         'path': c.get('path', '/'), 'secure': bool(c.get('secure', True)),
         'httpOnly': bool(c.get('httpOnly', False)), 'sameSite': ss}
    if c.get('expirationDate'): o['expires'] = int(c['expirationDate'])
    return o

collected = []
def on_response(res):
    try:
        url = res.url
        if not any(k in url.lower() for k in ('/rest/', '/api/', 'grpc', 'usage', 'billing', 'subscription', 'credits', 'quota', 'plan', 'account', 'settings', 'user')):
            return
        try:
            body_bytes = res.body()
            body = body_bytes.decode('utf-8', errors='replace')
        except Exception:
            body = '[binary]'
        collected.append({
            'url': url, 'status': res.status,
            'mime': res.headers.get('content-type', ''),
            'body': body[:5000],
        })
        # print live
        print(f"  → {res.status} {url.split('?')[0]}")
    except Exception:
        pass

with sync_playwright() as p:
    print('[probe] запускаю Chromium (headed, viewport 1400x900)...')
    browser = p.chromium.launch(headless=False)
    context = browser.new_context(viewport={'width': 1400, 'height': 900})
    context.add_cookies([pw_cookie(c) for c in cookies])
    page = context.new_page()
    page.on('response', on_response)

    page.goto('https://grok.com/', wait_until='domcontentloaded', timeout=30000)
    print('[probe] grok.com открыт.')
    print('=' * 60)
    print('ТЕПЕРЬ ВРУЧНУЮ:')
    print('  1. Кликни по аватарке в левом-нижнем углу')
    print('  2. Кликни "Настройки"')
    print('  3. Кликни "Использование" (слева в модалке)')
    print('  У тебя 60 секунд. Все запросы логируются live.')
    print('=' * 60)

    for i in range(60, 0, -5):
        time.sleep(5)
        print(f'[probe] ...{i}с осталось · собрано {len(collected)} responses')

    # Сохранить всё
    try:
        modal = page.locator('[role="dialog"]').first
        if modal.is_visible():
            html = modal.evaluate('el => el.outerHTML')
            text = modal.inner_text()
            (LOG_DIR / 'modal.html').write_text(html, encoding='utf-8')
            (LOG_DIR / 'modal.txt').write_text(text, encoding='utf-8')
            print(f'[probe] modal saved: {len(html)} chars HTML')
            print('\n=== MODAL TEXT ===')
            print(text[:3000])
        else:
            print('[probe] модалка не открыта')
    except Exception as e:
        print(f'[probe] modal capture fail: {e}')

    (LOG_DIR / 'responses.json').write_text(
        json.dumps(collected, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    print(f'\n[probe] {len(collected)} responses saved to probe_out/responses.json')
    seen = set()
    for e in collected:
        u = e['url'].split('?')[0]
        if u in seen: continue
        seen.add(u)
        print(f"  {e['status']}  {u}")

    browser.close()
    print('[probe] done.')
