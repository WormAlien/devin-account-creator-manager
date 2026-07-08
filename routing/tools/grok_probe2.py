"""Второй заход: собираем то что не отдаёт REST — план, email, нюанс квоты.

Идём на /settings/billing и /settings, ждём hydration, читаем document.body.innerText
и document.querySelector паттерны. Grok на React — SSR + hydration, innerText после
пары секунд должен содержать всё видимое.
"""
import asyncio, json, os, random, subprocess, sys, tempfile
from pathlib import Path
import httpx, websockets

SESSION_FILE = sys.argv[1] if len(sys.argv) > 1 else 'D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/2.json'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
sys.stdout.reconfigure(encoding='utf-8')


def spawn():
    port = random.randint(9500, 9600)
    ud = tempfile.mkdtemp(prefix='grok-probe-')
    args = [CHROME, f'--remote-debugging-port={port}', f'--user-data-dir={ud}',
            '--headless=new', '--no-first-run', '--no-default-browser-check',
            '--disable-sync', 'about:blank']
    subprocess.Popen(args, creationflags=0x00000008 | 0x00000200,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return port, ud


async def recv_id(ws, wid, timeout=10):
    dl = asyncio.get_event_loop().time() + timeout
    while True:
        rem = dl - asyncio.get_event_loop().time()
        if rem <= 0: raise RuntimeError(f'timeout id={wid}')
        raw = await asyncio.wait_for(ws.recv(), timeout=rem)
        m = json.loads(raw)
        if m.get('id') == wid: return m


async def main():
    cookies = json.load(open(SESSION_FILE, encoding='utf-8'))
    port, ud = spawn()
    print(f'[probe2] port={port}')
    ws_url = None
    for _ in range(30):
        await asyncio.sleep(0.4)
        try:
            async with httpx.AsyncClient() as c:
                pages = (await c.get(f'http://localhost:{port}/json')).json()
                p = next((x for x in pages if x.get('type') == 'page'), None)
                if p: ws_url = p['webSocketDebuggerUrl']; break
        except Exception: pass
    if not ws_url: print('CDP not ready'); return

    async with websockets.connect(ws_url, max_size=None) as ws:
        wid = [0]
        def nid(): wid[0]+=1; return wid[0]
        async def send(method, params=None):
            i = nid()
            await ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
            return i

        for method in ('Network.enable', 'Page.enable', 'Runtime.enable'):
            await recv_id(ws, await send(method))

        for c in cookies:
            dom = c.get('domain') or '.grok.com'
            ss = str(c.get('sameSite', 'unspecified')).lower()
            ss = {'no_restriction': 'None', 'lax': 'Lax', 'strict': 'Strict'}.get(ss, 'Lax')
            i = await send('Network.setCookie', {
                'name': c['name'], 'value': c['value'], 'domain': dom,
                'path': c.get('path', '/'), 'secure': bool(c.get('secure', True)),
                'httpOnly': bool(c.get('httpOnly', False)), 'sameSite': ss,
            })
            await recv_id(ws, i)

        async def visit_and_snapshot(url, wait=5, label=''):
            print(f'\n[probe2] === {label}: {url} ===')
            await send('Page.navigate', {'url': url})
            await asyncio.sleep(wait)
            # innerText
            i = await send('Runtime.evaluate', {
                'expression': '(function(){return document.body ? document.body.innerText.slice(0, 5000) : null;})()',
                'returnByValue': True,
            })
            r = await recv_id(ws, i)
            text = r.get('result', {}).get('result', {}).get('value', '') or ''
            print(f'--- innerText[:5000] ---')
            print(text)

        await visit_and_snapshot('https://grok.com/settings', 5, 'settings root')
        await visit_and_snapshot('https://grok.com/settings/usage', 5, 'usage')
        await visit_and_snapshot('https://grok.com/settings/billing', 5, 'billing')

asyncio.run(main())
