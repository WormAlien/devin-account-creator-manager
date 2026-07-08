"""Точечная проверка что evalx возвращает по каждому шагу."""
import asyncio, json, os, random, subprocess, sys, tempfile
from pathlib import Path
import httpx, websockets

sys.stdout.reconfigure(encoding='utf-8')
cookies = json.load(open('D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/2.json', encoding='utf-8'))
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'


async def recv_id(ws, wid, timeout=10):
    dl = asyncio.get_event_loop().time() + timeout
    while True:
        rem = dl - asyncio.get_event_loop().time()
        if rem <= 0: raise RuntimeError(f'timeout {wid}')
        raw = await asyncio.wait_for(ws.recv(), timeout=rem)
        m = json.loads(raw)
        if m.get('id') == wid: return m


async def main():
    port = random.randint(9500, 9700)
    ud = tempfile.mkdtemp(prefix='qdebug-')
    subprocess.Popen([CHROME, f'--remote-debugging-port={port}', f'--user-data-dir={ud}',
                      '--headless=new', '--no-first-run', '--disable-sync', 'about:blank'],
                     creationflags=0x8 | 0x200,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws_url = None
    for _ in range(30):
        await asyncio.sleep(0.4)
        try:
            async with httpx.AsyncClient() as c:
                pages = (await c.get(f'http://localhost:{port}/json')).json()
                p = next((x for x in pages if x.get('type') == 'page'), None)
                if p: ws_url = p['webSocketDebuggerUrl']; break
        except Exception: pass
    print(f'ws: {ws_url}')

    async with websockets.connect(ws_url, max_size=None) as ws:
        wid = [0]
        def nid(): wid[0]+=1; return wid[0]
        async def send(method, params=None):
            i = nid()
            await ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
            return i
        async def evalx(expr, timeout=15):
            i = await send('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
            r = await recv_id(ws, i, timeout)
            return r

        for m in ('Network.enable','Page.enable','Runtime.enable'):
            await recv_id(ws, await send(m))

        for c in cookies:
            dom = c.get('domain') or '.grok.com'
            ss = str(c.get('sameSite', 'unspecified')).lower()
            ss = {'no_restriction': 'None', 'lax': 'Lax', 'strict': 'Strict'}.get(ss, 'Lax')
            await recv_id(ws, await send('Network.setCookie', {
                'name': c['name'], 'value': c['value'], 'domain': dom,
                'path': c.get('path', '/'), 'secure': bool(c.get('secure', True)),
                'httpOnly': bool(c.get('httpOnly', False)), 'sameSite': ss,
            }))

        # navigate
        await send('Page.navigate', {'url': 'https://grok.com/'})
        # NB: не ждём response events, просто спим
        await asyncio.sleep(8)

        # DRAIN queue
        drained = 0
        while True:
            try:
                await asyncio.wait_for(ws.recv(), timeout=0.1)
                drained += 1
            except asyncio.TimeoutError:
                break
        print(f'drained events: {drained}')

        # rate-limits
        r = await evalx("(async()=>{try{const r=await fetch('/rest/rate-limits',{credentials:'include'});return {status:r.status, body:await r.text()};}catch(e){return {err:e.message}}})()")
        print(f'rate-limits raw resp: {json.dumps(r)[:500]}')

        # identity
        r2 = await evalx("""(function(){
          const btns = document.querySelectorAll('button, a, div');
          for (const b of btns) {
            const t = (b.innerText || '').trim();
            if (!t || t.length > 200) continue;
            const lines = t.split(/\\n+/).map(s=>s.trim()).filter(Boolean);
            if (lines.length !== 2) continue;
            if (lines[1].includes('@') && lines[1].includes('.')) {
              return { displayName: lines[0], email: lines[1] };
            }
          }
          return null;
        })()""")
        print(f'identity raw: {json.dumps(r2)[:500]}')

asyncio.run(main())
