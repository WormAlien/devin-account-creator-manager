"""Playwright-разведчик Grok Usage.

Headed Chromium, куки от Anatol Pruss (3.json), клик по аватарке → Настройки → Использование.
Захватываем:
  - все network responses (URL, status, body если json/text)
  - HTML модалки после появления
  - innerText модалки

Цель: найти endpoint / DOM-путь для 87% + Imagine 40% / Голосовой 35% / Разговор 12%.
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

SESSION = 'D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/3.json'
LOG_DIR = Path('C:/Users/WormAlien/Desktop/Autoreger_Clean/routing/tools/probe_out')
LOG_DIR.mkdir(exist_ok=True)

cookies = json.load(open(SESSION, encoding='utf-8'))

SS_MAP = {'no_restriction': 'None', 'lax': 'Lax', 'strict': 'Strict', 'unspecified': 'Lax'}
def pw_cookie(c):
    dom = c.get('domain') or '.grok.com'
    ss = c.get('sameSite') or 'unspecified'
    ss = SS_MAP.get(str(ss).lower(), 'Lax')
    o = {
        'name': c['name'], 'value': c['value'], 'domain': dom,
        'path': c.get('path', '/'), 'secure': bool(c.get('secure', True)),
        'httpOnly': bool(c.get('httpOnly', False)), 'sameSite': ss,
    }
    if c.get('expirationDate'): o['expires'] = int(c['expirationDate'])
    return o

collected = []

def on_response(res):
    try:
        url = res.url
        if not any(k in url.lower() for k in ('/rest/', '/api/', 'grpc', 'usage', 'billing', 'subscription', 'credits', 'quota', 'plan', 'account')):
            return
        try:
            body = res.body()
            body_str = body.decode('utf-8', errors='replace')
            is_b64 = False
        except Exception:
            body_str = ''
            is_b64 = False
        collected.append({
            'url': url,
            'status': res.status,
            'mime': res.headers.get('content-type', ''),
            'body': body_str[:5000],
        })
    except Exception as e:
        print(f'[resp] error: {e}')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, args=['--disable-blink-features=AutomationControlled'])
    context = browser.new_context(viewport={'width': 1400, 'height': 900})
    context.add_cookies([pw_cookie(c) for c in cookies])
    page = context.new_page()
    page.on('response', on_response)

    print(f'[probe] session: {SESSION} · cookies: {len(cookies)}')
    page.goto('https://grok.com/', wait_until='domcontentloaded', timeout=30000)
    print('[probe] loaded grok.com — жду hydration...')
    page.wait_for_timeout(4000)

    # Кликаю по кнопке профиля (последняя внизу в sidebar). У неё внутри имя+email.
    try:
        # Ищем контейнер аккаунта через email в тексте
        avatar = page.locator('button:has-text("@")').last
        avatar.click(timeout=5000)
        print('[probe] clicked avatar')
    except Exception as e:
        print(f'[probe] avatar click fail: {e}')
        # fallback: последняя кнопка nav
        try:
            page.locator('nav button, aside button').last.click(timeout=3000)
            print('[probe] fallback: clicked last nav btn')
        except Exception as e2:
            print(f'[probe] fallback fail: {e2}')

    page.wait_for_timeout(1500)

    # Клик "Настройки"
    try:
        page.get_by_text('Настройки', exact=True).first.click(timeout=5000)
        print('[probe] clicked Настройки')
    except Exception as e:
        print(f'[probe] Настройки fail: {e}')

    page.wait_for_timeout(2000)

    # Клик "Использование"
    try:
        page.get_by_text('Использование', exact=True).first.click(timeout=5000)
        print('[probe] clicked Использование')
    except Exception as e:
        print(f'[probe] Использование fail: {e}')

    print('[probe] waiting 8s for usage tab to load...')
    page.wait_for_timeout(8000)

    # Захват модалки
    try:
        modal = page.locator('[role="dialog"]').first
        modal_html = modal.evaluate('el => el.outerHTML')
        modal_text = modal.inner_text()
        (LOG_DIR / 'modal.html').write_text(modal_html, encoding='utf-8')
        (LOG_DIR / 'modal.txt').write_text(modal_text, encoding='utf-8')
        print(f'[probe] modal HTML saved: {len(modal_html)} chars')
        print('\n=== MODAL TEXT ===')
        print(modal_text[:3000])
    except Exception as e:
        print(f'[probe] modal capture fail: {e}')
        # fallback: весь body
        body_text = page.evaluate('document.body.innerText')
        (LOG_DIR / 'body.txt').write_text(body_text, encoding='utf-8')
        print('body text saved (no dialog role found)')

    # Дамп всех интересных responses
    (LOG_DIR / 'responses.json').write_text(
        json.dumps(collected, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    print(f'\n[probe] {len(collected)} responses saved')
    seen = set()
    for e in collected:
        u = e['url'].split('?')[0]
        if u in seen: continue
        seen.add(u)
        print(f"  {e['status']}  {u}")

    print('\n[probe] нажми Enter в консоли когда закончишь смотреть...')
    try: input()
    except: pass
    browser.close()
