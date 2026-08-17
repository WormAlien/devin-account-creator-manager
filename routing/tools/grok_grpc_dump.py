"""Достаёт RAW body /GetGrokCreditsConfig для Anatol'а — bytes сохраняются как base64."""
import json, sys, base64, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

SESSION = sys.argv[1] if len(sys.argv) > 1 else 'D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/3.json'
OUT_NAME = sys.argv[2] if len(sys.argv) > 2 else 'credits_raw.b64'
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

captured = {}
def on_response(res):
    try:
        if 'GetGrokCreditsConfig' in res.url:
            b = res.body()
            captured['credits'] = base64.b64encode(b).decode()
            print(f'[dump] credits raw len={len(b)} b64_len={len(captured["credits"])}')
    except Exception as e:
        print(f'err: {e}')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1400, 'height': 900})
    context.add_cookies([pw_cookie(c) for c in cookies])
    page = context.new_page()
    page.on('response', on_response)
    page.goto('https://grok.com/', wait_until='domcontentloaded', timeout=30000)
    page.wait_for_timeout(8000)
    browser.close()

if 'credits' in captured:
    (LOG_DIR / OUT_NAME).write_text(captured['credits'], encoding='utf-8')
    print(f'[dump] saved to {LOG_DIR}/{OUT_NAME}')
else:
    print('[dump] not captured')
