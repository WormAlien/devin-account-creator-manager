"""Пробуем разные URL — вдруг какой-то откроет модалку Usage автоматом.

Список URL берётся из наблюдений: grok уже принимает `/settings/usage` (200 text/html),
может быть работают query-параметры.
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

SESSION = 'D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/3.json'
# от самого файла, а не от абсолютного пути: папку репо можно переносить
LOG_DIR = Path(__file__).resolve().parent / 'probe_out'

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

urls = [
    'https://grok.com/settings/usage',
    'https://grok.com/?settings=usage',
    'https://grok.com/?dialog=settings.usage',
    'https://grok.com/settings',
]

collected = {}  # url_visited → list of responses

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1400, 'height': 900})
    context.add_cookies([pw_cookie(c) for c in cookies])
    page = context.new_page()
    current_url = ['']
    def on_response(res):
        try:
            u = res.url
            if not any(k in u.lower() for k in ('/rest/', '/api/', 'grpc', 'usage', 'subscription', 'credits')): return
            try: body = res.body().decode('utf-8', errors='replace')
            except Exception: body = '[bin]'
            collected.setdefault(current_url[0], []).append({'url': u, 'status': res.status, 'body': body[:3000]})
        except: pass
    page.on('response', on_response)

    for url in urls:
        current_url[0] = url
        print(f'\n=== {url} ===')
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=15000)
            page.wait_for_timeout(4000)
            # innerText модалки, если есть
            dlg = page.locator('[role="dialog"]').first
            try:
                if dlg.is_visible(timeout=1000):
                    txt = dlg.inner_text()[:800]
                    print(f'  MODAL: {txt}')
                else:
                    print('  no dialog visible')
            except Exception as e:
                print(f'  no dialog: {e}')
            # ищем 87% / Imagine / weekly в body
            body_txt = page.evaluate('document.body.innerText')
            for kw in ['87%', 'Imagine', 'Голосовой', 'Разговор', 'недельн', 'Использован']:
                if kw in body_txt:
                    idx = body_txt.find(kw)
                    print(f'  found "{kw}" at {idx}: ...{body_txt[max(0,idx-30):idx+80]}...')
                    break
        except Exception as e:
            print(f'  goto fail: {e}')

    print(f'\n=== Собранные responses ({sum(len(v) for v in collected.values())}) ===')
    for u, resps in collected.items():
        for e in resps:
            print(f"  [{u.split('/')[-1] or 'root'}] {e['status']} {e['url'].split('?')[0]}")
    (LOG_DIR / 'url_probe.json').write_text(json.dumps(collected, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
