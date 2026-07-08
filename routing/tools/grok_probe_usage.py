"""Захватить responses при открытии /settings/usage через клик по меню.

Ищем откуда grok берёт 87% + Imagine 40% · Голосовой 35% · Разговор 12%.
Логи: /tmp/grok_usage_probe.json — все responses с bodies (base64 если бинарь).
"""
import asyncio, json, os, random, subprocess, sys, tempfile
from pathlib import Path
import httpx, websockets

SESSION_FILE = sys.argv[1] if len(sys.argv) > 1 else 'D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/3.json'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
sys.stdout.reconfigure(encoding='utf-8')


def spawn():
    port = random.randint(9500, 9700)
    ud = tempfile.mkdtemp(prefix='usage-')
    subprocess.Popen([CHROME, f'--remote-debugging-port={port}', f'--user-data-dir={ud}',
                      '--headless=new', '--window-size=1400,900', '--no-first-run',
                      '--disable-sync', 'about:blank'],
                     creationflags=0x8|0x200,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return port


async def recv_id(ws, wid, timeout=15):
    dl = asyncio.get_event_loop().time() + timeout
    while True:
        rem = dl - asyncio.get_event_loop().time()
        if rem <= 0: raise RuntimeError(f't/o {wid}')
        raw = await asyncio.wait_for(ws.recv(), timeout=rem)
        m = json.loads(raw)
        if m.get('id') == wid: return m


async def main():
    cookies = json.load(open(SESSION_FILE, encoding='utf-8'))
    print(f'[usage] session: {SESSION_FILE}')
    port = spawn()
    ws_url = None
    for _ in range(30):
        await asyncio.sleep(0.4)
        try:
            async with httpx.AsyncClient() as c:
                p = next((x for x in (await c.get(f'http://localhost:{port}/json')).json() if x.get('type')=='page'), None)
                if p: ws_url = p['webSocketDebuggerUrl']; break
        except: pass
    async with websockets.connect(ws_url, max_size=None) as ws:
        wid=[0]
        async def send(m,p=None):
            wid[0]+=1
            await ws.send(json.dumps({'id':wid[0],'method':m,'params':p or {}}))
            return wid[0]
        for m in ('Network.enable','Page.enable','Runtime.enable'):
            await recv_id(ws, await send(m))
        for c in cookies:
            dom = c.get('domain') or '.grok.com'
            ss = str(c.get('sameSite','unspecified')).lower()
            ss = {'no_restriction':'None','lax':'Lax','strict':'Strict'}.get(ss,'Lax')
            await recv_id(ws, await send('Network.setCookie', {
                'name':c['name'],'value':c['value'],'domain':dom,
                'path':c.get('path','/'),'secure':bool(c.get('secure',True)),
                'httpOnly':bool(c.get('httpOnly',False)),'sameSite':ss,
            }))

        # Собираем ВСЕ responses с bodies
        collected = []
        pending_bodies = {}  # requestId → url

        async def collect_body(rid, url, mime):
            try:
                i = await send('Network.getResponseBody', {'requestId': rid})
                r = await recv_id(ws, i, timeout=3)
                res = r.get('result', {})
                body = res.get('body', '')
                is_b64 = res.get('base64Encoded', False)
                collected.append({'url': url, 'mime': mime, 'body': body, 'is_b64': is_b64})
            except Exception:
                pass

        async def pump_events(seconds):
            end = asyncio.get_event_loop().time() + seconds
            while asyncio.get_event_loop().time() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.3)
                except asyncio.TimeoutError:
                    continue
                msg = json.loads(raw)
                if msg.get('method') == 'Network.responseReceived':
                    p = msg['params']
                    url = p['response']['url']
                    mime = p['response'].get('mimeType', '')
                    if any(k in url.lower() for k in ('/rest/', '/api/', 'grpc', 'usage', 'billing', 'subscription', 'credits', 'quota', 'plan')):
                        pending_bodies[p['requestId']] = (url, mime)
                elif msg.get('method') == 'Network.loadingFinished':
                    p = msg['params']
                    rid = p['requestId']
                    if rid in pending_bodies:
                        u, m = pending_bodies.pop(rid)
                        await collect_body(rid, u, m)

        # 1. Загрузка home
        await send('Page.navigate', {'url': 'https://grok.com/'})
        await pump_events(6)
        print(f'[usage] after home: {len(collected)} responses')

        # 2. Клик по кнопке профиля (последняя кнопка в nav/aside — обычно аватар)
        i = await send('Runtime.evaluate', {'expression': """(function(){
          const nav = document.querySelector('nav, aside, [role="navigation"]');
          if (!nav) return 'no-nav';
          const btns = [...nav.querySelectorAll('button, [role="button"]')];
          const last = btns[btns.length-1];
          if (last) { last.click(); return 'clicked: '+(last.getAttribute('aria-label')||last.innerText||'?').slice(0,60); }
          return 'no-btn';
        })()""", 'returnByValue': True})
        r = await recv_id(ws, i)
        print(f'[usage] avatar click: {r.get("result",{}).get("result",{}).get("value")}')
        await asyncio.sleep(2)

        # 3. Клик по «Настройки» в открывшемся меню
        i = await send('Runtime.evaluate', {'expression': """(function(){
          const els = document.querySelectorAll('button, div[role="menuitem"], a, span');
          for (const e of els) {
            const t = (e.innerText || '').trim();
            if (t === 'Настройки' || t === 'Settings') { e.click(); return 'clicked-settings'; }
          }
          return 'not-found';
        })()""", 'returnByValue': True})
        r = await recv_id(ws, i)
        print(f'[usage] settings click: {r.get("result",{}).get("result",{}).get("value")}')
        await pump_events(3)

        # 4. Клик по «Использование» в модалке
        i = await send('Runtime.evaluate', {'expression': """(function(){
          const els = document.querySelectorAll('button, div[role="menuitem"], a, span, div');
          for (const e of els) {
            const t = (e.innerText || '').trim();
            if (t === 'Использование' || t === 'Usage') { e.click(); return 'clicked-usage'; }
          }
          return 'not-found';
        })()""", 'returnByValue': True})
        r = await recv_id(ws, i)
        print(f'[usage] usage click: {r.get("result",{}).get("result",{}).get("value")}')

        # 5. Пампаем сеть 6 секунд чтобы поймать всё что грузит usage-таб
        await pump_events(7)
        print(f'[usage] after usage-tab: {len(collected)} responses')

        # 6. Скинем в файл + распечатаем интересное
        Path('/tmp/grok_usage_probe.json').write_text(
            json.dumps(collected, ensure_ascii=False, indent=2), encoding='utf-8'
        )
        print(f'\n[usage] === COLLECTED URLs ===')
        seen = set()
        for e in collected:
            u = e['url'].split('?')[0]
            if u in seen: continue
            seen.add(u)
            body_preview = e['body'][:200] if e['body'] else ''
            print(f"\n  {e['mime']}")
            print(f"  {u}")
            if e['is_b64']:
                print(f"  [base64, {len(e['body'])} chars]")
            else:
                print(f"  {body_preview}")

        # 7. Ещё возьмём body_text модалки — там 87% и разбивка
        i = await send('Runtime.evaluate', {'expression': """(function(){
          const dlg = document.querySelector('[role="dialog"]');
          if (dlg) return dlg.innerText.slice(0, 3000);
          return document.body.innerText.slice(0, 3000);
        })()""", 'returnByValue': True})
        r = await recv_id(ws, i)
        print('\n[usage] === MODAL TEXT ===')
        print(r.get('result',{}).get('result',{}).get('value',''))

asyncio.run(main())
