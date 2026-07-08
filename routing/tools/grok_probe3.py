"""Клик по кнопке пользователя → меню Настройки → парсим модалку.

Идея: раз URL /settings не открывает модалку сам, найдём кнопку профиля
(бывает <button> с data-testid или aria-label) и кликнем через CDP.
Затем найдём в меню "Настройки" и кликнем. Плюс — распечатаем ВЕСЬ
document.body.innerText чтобы увидеть какие элементы вообще есть.
"""
import asyncio, json, os, random, subprocess, sys, tempfile
from pathlib import Path
import httpx, websockets

SESSION_FILE = sys.argv[1] if len(sys.argv) > 1 else 'D:/WORMALIENAIGIGANT/app/grok-cookie-mcp/cookies/2.json'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
sys.stdout.reconfigure(encoding='utf-8')


def spawn():
    port = random.randint(9500, 9700)
    ud = tempfile.mkdtemp(prefix='grok-probe-')
    args = [CHROME, f'--remote-debugging-port={port}', f'--user-data-dir={ud}',
            '--headless=new', '--no-first-run', '--no-default-browser-check',
            '--disable-sync', '--window-size=1400,900', 'about:blank']
    subprocess.Popen(args, creationflags=0x00000008 | 0x00000200,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return port, ud


async def recv_id(ws, wid, timeout=15):
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
    print(f'[probe3] port={port} session={Path(SESSION_FILE).stem}')
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
        async def eval_expr(expr):
            i = await send('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
            r = await recv_id(ws, i)
            return r.get('result', {}).get('result', {}).get('value')

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

        await send('Page.navigate', {'url': 'https://grok.com/'})
        await asyncio.sleep(6)

        # Задача 1: расскажи что вообще есть на странице — сгруппируем buttons
        buttons_json = await eval_expr("""(function(){
          const arr = [];
          document.querySelectorAll('button, [role="button"], a').forEach(el => {
            const t = (el.innerText || '').trim().slice(0, 60);
            const aria = el.getAttribute('aria-label') || '';
            const testid = el.getAttribute('data-testid') || '';
            if (t || aria || testid) arr.push({t, aria, testid});
          });
          return JSON.stringify(arr.slice(0, 40));
        })()""")
        print('\n--- BUTTONS (top 40) ---')
        try:
            for b in json.loads(buttons_json):
                print(f"  text='{b['t']}' aria='{b['aria']}' testid='{b['testid']}'")
        except Exception:
            print(buttons_json[:2000])

        # Задача 2: расскажи что в rate-limits (уже видели), плюс попробуй прямой fetch
        # на /rest/user или похожие
        for url in ['/rest/user', '/rest/account', '/rest/subscription', '/rest/me',
                    '/rest/user/profile', '/rest/plan', '/rest/settings', '/rest/quota']:
            r = await eval_expr(f"""(async()=>{{
              try {{
                const r = await fetch('{url}', {{credentials:'include'}});
                return r.status + ' | ' + (await r.text()).slice(0, 300);
              }} catch(e) {{ return 'err: '+e.message }}
            }})()""")
            print(f'  {url}: {r}')

        # Задача 3: попробуем нажать кнопку "Настройки" в меню.
        # Сначала — найдём кнопку профиля (обычно в левом-нижнем углу sidebar'а).
        # Пробуем разные селекторы
        settings_res = await eval_expr("""(function(){
          // Ищем кнопку с текстом ‘Настройки’ где-нибудь
          const findText = (txt) => {
            const els = document.querySelectorAll('button, div[role="menuitem"], a');
            for (const e of els) if ((e.innerText||'').trim().includes(txt)) return e;
            return null;
          };
          // 1) Сначала попробуем прямо нажать "Настройки" если оно уже видно
          const s = findText('Настройки');
          if (s) { s.click(); return 'clicked-directly'; }
          // 2) Иначе — найти аватарку/меню (последняя кнопка внизу left sidebar)
          const nav = document.querySelector('nav, aside, [role="navigation"]');
          if (nav) {
            const btns = nav.querySelectorAll('button, [role="button"]');
            const last = btns[btns.length-1];
            if (last) { last.click(); return 'clicked-avatar-'+(last.getAttribute('aria-label')||last.innerText||'?'); }
          }
          return 'not-found';
        })()""")
        print(f'\n[settings click]: {settings_res}')

        await asyncio.sleep(1.5)

        # Теперь попробуем ещё раз найти "Настройки" и нажать
        step2 = await eval_expr("""(function(){
          const els = document.querySelectorAll('button, div[role="menuitem"], a, span');
          for (const e of els) {
            const t = (e.innerText||'').trim();
            if (t === 'Настройки' || t === 'Settings') { e.click(); return 'clicked-settings-item'; }
          }
          return 'not-found';
        })()""")
        print(f'[settings step2]: {step2}')

        await asyncio.sleep(2)

        # Захватим текст модалки, если есть
        modal_text = await eval_expr("""(function(){
          // ищем модалку — [role="dialog"] или fixed-positioned с большим содержимым
          const dlg = document.querySelector('[role="dialog"]');
          if (dlg) return dlg.innerText.slice(0, 4000);
          // fallback: body
          return document.body.innerText.slice(0, 4000);
        })()""")
        print(f'\n--- MODAL/BODY TEXT after settings click ---')
        print(modal_text)

asyncio.run(main())
