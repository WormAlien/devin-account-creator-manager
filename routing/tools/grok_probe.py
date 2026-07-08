"""Одноразовый разведчик API grok.com/x.ai для quota/billing/plan.

Запускает headless Chrome с куками сохранённой сессии, ходит по:
  /                         (baseline)
  /settings                 (аккаунт)
  /settings/usage           (квота)
  /settings/billing         (план + кредиты)

Пишет все XHR/fetch-ответы (application/json) в /tmp/grok_probe.log
и печатает найденные API endpoints + preview тел, чтобы я построил парсер.
"""
import asyncio, json, os, random, subprocess, sys, tempfile, time
from pathlib import Path
import httpx, websockets

SESSION_FILE = sys.argv[1] if len(sys.argv) > 1 else 'D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/2.json'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
if not Path(CHROME).exists():
    CHROME = os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe')

sys.stdout.reconfigure(encoding='utf-8')

def spawn():
    port = random.randint(9500, 9600)
    ud = tempfile.mkdtemp(prefix='grok-probe-')
    args = [
        CHROME,
        f'--remote-debugging-port={port}',
        f'--user-data-dir={ud}',
        '--headless=new',
        '--no-first-run', '--no-default-browser-check', '--disable-sync',
        'about:blank',
    ]
    subprocess.Popen(args, creationflags=0x00000008 | 0x00000200,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return port, ud


async def recv_id(ws, wid, timeout=8):
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        rem = deadline - asyncio.get_event_loop().time()
        if rem <= 0:
            raise RuntimeError(f'timeout id={wid}')
        raw = await asyncio.wait_for(ws.recv(), timeout=rem)
        m = json.loads(raw)
        if m.get('id') == wid:
            return m


async def main():
    cookies = json.load(open(SESSION_FILE, encoding='utf-8'))
    print(f'[probe] using session: {SESSION_FILE}  ({len(cookies)} cookies)')
    port, ud = spawn()
    print(f'[probe] chrome port={port} profile={ud}')
    # wait for CDP
    ws_url = None
    for _ in range(30):
        await asyncio.sleep(0.4)
        try:
            async with httpx.AsyncClient() as c:
                pages = (await c.get(f'http://localhost:{port}/json')).json()
                page = next((p for p in pages if p.get('type') == 'page'), None)
                if page:
                    ws_url = page['webSocketDebuggerUrl']
                    break
        except Exception:
            pass
    if not ws_url:
        print('[probe] CDP not ready'); return

    async with websockets.connect(ws_url, max_size=None) as ws:
        wid = [0]
        def nid():
            wid[0] += 1; return wid[0]

        async def send(method, params=None):
            i = nid()
            await ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
            return i

        i = await send('Network.enable')
        await recv_id(ws, i)
        i = await send('Page.enable')
        await recv_id(ws, i)
        i = await send('Runtime.enable')
        await recv_id(ws, i)

        # inject cookies
        for c in cookies:
            dom = c.get('domain') or '.grok.com'
            sameSite = c.get('sameSite') or 'unspecified'
            sameSite = {'no_restriction': 'None', 'lax': 'Lax', 'strict': 'Strict', 'unspecified': 'Lax'}.get(str(sameSite).lower(), 'Lax')
            i = await send('Network.setCookie', {
                'name': c['name'], 'value': c['value'], 'domain': dom,
                'path': c.get('path', '/'), 'secure': bool(c.get('secure', True)),
                'httpOnly': bool(c.get('httpOnly', False)), 'sameSite': sameSite,
            })
            await recv_id(ws, i)

        # network sniffer: collect ALL response bodies during navigation
        interesting = []  # list of (url, status, body_preview, mime)
        seen_req = {}     # requestId → url

        async def sniff(url_hint, seconds):
            print(f'\n[probe] === navigating: {url_hint} (sniff {seconds}s) ===')
            i = await send('Page.navigate', {'url': url_hint})
            # don't await id - just start collecting
            end = asyncio.get_event_loop().time() + seconds
            while asyncio.get_event_loop().time() < end:
                rem = end - asyncio.get_event_loop().time()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, rem))
                except asyncio.TimeoutError:
                    break
                msg = json.loads(raw)
                m = msg.get('method')
                if m == 'Network.requestWillBeSent':
                    p = msg['params']
                    seen_req[p['requestId']] = p['request']['url']
                elif m == 'Network.responseReceived':
                    p = msg['params']
                    url = p['response']['url']
                    mime = p['response'].get('mimeType', '')
                    status = p['response']['status']
                    if any(k in url.lower() for k in ('/rest/', '/api/', 'graphql', 'subscription', 'usage', 'billing', 'quota', 'plan', 'user', 'account')):
                        # fetch body
                        try:
                            bi = nid()
                            await ws.send(json.dumps({'id': bi, 'method': 'Network.getResponseBody', 'params': {'requestId': p['requestId']}}))
                            # collect response
                            deadline = asyncio.get_event_loop().time() + 3
                            body = None
                            while asyncio.get_event_loop().time() < deadline:
                                try:
                                    r = await asyncio.wait_for(ws.recv(), timeout=1)
                                except asyncio.TimeoutError:
                                    break
                                rm = json.loads(r)
                                if rm.get('id') == bi:
                                    body = rm.get('result', {}).get('body', '')
                                    break
                            if body is not None:
                                preview = body[:800]
                                interesting.append((url, status, mime, preview))
                        except Exception:
                            pass
            print(f'[probe]   collected so far: {len(interesting)}')

        # navigate
        await sniff('https://grok.com/', 6)
        await sniff('https://grok.com/settings', 5)
        await sniff('https://grok.com/settings/usage', 5)
        await sniff('https://grok.com/settings/billing', 5)

        # dedup by URL (keep first occurrence)
        seen = set()
        dedup = []
        for e in interesting:
            u = e[0].split('?')[0]
            if u in seen: continue
            seen.add(u); dedup.append(e)

        print('\n[probe] === INTERESTING RESPONSES (dedup by url) ===')
        for url, status, mime, preview in dedup:
            print(f'\n  {status}  {mime}')
            print(f'  {url}')
            print(f'  body: {preview[:400]}')

        Path('/tmp/grok_probe_result.json').write_text(
            json.dumps([{'url': u, 'status': s, 'mime': m, 'body': b} for u, s, m, b in interesting], ensure_ascii=False, indent=2),
            encoding='utf-8'
        )
        print(f'\n[probe] Full log saved to /tmp/grok_probe_result.json')

asyncio.run(main())
