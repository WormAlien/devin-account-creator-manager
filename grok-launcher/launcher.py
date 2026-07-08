"""Cookie Session Launcher — paste cookie JSON, get a working browser session.

Opens Chrome with cookies injected via CDP. No API key needed.
Windows-only: spawns Chrome via Popen + DETACHED_PROCESS with a fresh
--user-data-dir so a running Chrome cannot hijack the new window into the
user's main profile.
"""

import asyncio
import json
import os
import random
import subprocess
import tempfile
from pathlib import Path

import httpx
import websockets
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

app = FastAPI(title="Cookie Launcher")

# CORS для dashboard
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEBUG_PORT = 9222


def find_chrome() -> str | None:
    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    ]
    for path in candidates:
        if Path(path).exists():
            return path
    return None


async def get_cdp_ws_url() -> str | None:
    """Try to connect to already-running Chrome CDP. Returns page-level WebSocket."""
    try:
        async with httpx.AsyncClient() as client:
            # Get list of pages (not browser-level endpoint)
            resp = await client.get(
                f"http://localhost:{DEBUG_PORT}/json",
                timeout=httpx.Timeout(2),
            )
            pages = resp.json()
            if pages:
                # Return first page's WebSocket (page-level, not browser-level)
                return pages[0]["webSocketDebuggerUrl"]
    except Exception:
        pass
    return None


def launch_chrome_window(debug_port: int) -> str:
    """Launch fully isolated Chrome instance with debugging port.

    Uses Popen + DETACHED_PROCESS so a running Chrome doesn't hijack the new
    window into an existing instance (which would ignore --user-data-dir and
    --remote-debugging-port, leaving the user in their main profile).
    Returns the user_data_dir path so caller can verify isolation.
    """
    chrome_path = find_chrome()
    if not chrome_path:
        raise RuntimeError("Chrome not found")

    user_data = tempfile.mkdtemp(prefix="cookie-session-")
    args = [
        chrome_path,
        f"--remote-debugging-port={debug_port}",
        f"--user-data-dir={user_data}",
        # Force a distinct singleton lock so we never latch onto the user's main Chrome.
        f"--profile-directory=Default",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-features=ChromeWhatsNewUI,SigninInterceptFirstRun",
        "about:blank",
    ]
    # DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP = child survives after we return, and
    # Windows shell won't re-route the call into an existing chrome.exe.
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    subprocess.Popen(
        args,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"[launcher] Spawned Chrome: port={debug_port} profile={user_data}", flush=True)
    return user_data


_SAMESITE_MAP = {
    "no_restriction": "None",
    "lax": "Lax",
    "strict": "Strict",
    "unspecified": "Lax",
    None: "Lax",
}


def _normalize_samesite(value):
    if value is None:
        return "Lax"
    if isinstance(value, str):
        return _SAMESITE_MAP.get(value.lower(), value if value in ("Lax", "Strict", "None") else "Lax")
    return "Lax"


async def _recv_id(ws, want_id: int, timeout: float = 5.0):
    """Read WS messages until we see one with matching id (ignore CDP events).

    The overall wait is bounded by ``timeout``; each individual recv gets
    whatever time is left, so events firing during Network.enable can't stretch
    the wall clock past the budget.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise RuntimeError(f"CDP response id={want_id} timed out")
        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get("id") == want_id:
            return msg


async def inject_cookies_and_navigate(ws_url: str, cookies: list[dict], target_domain: str):
    """Inject cookies via CDP and navigate to target.

    Explicitly clears the fresh profile's cookies first (paranoia — should be
    empty on a brand new user-data-dir, but if the CDP session ever attaches to
    the wrong Chrome we want the failure to be visible, not silently mixed).
    Uses each cookie's own domain when present; only falls back to target_domain
    when the cookie has no domain field.
    """
    async with websockets.connect(ws_url, max_size=None) as ws:
        # Enable Network domain
        await ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
        await _recv_id(ws, 1)

        # Wipe any pre-existing cookies (fresh profile should have none, but be safe).
        await ws.send(json.dumps({"id": 2, "method": "Network.clearBrowserCookies"}))
        await _recv_id(ws, 2)
        print("  Cleared pre-existing cookies", flush=True)

        # Inject cookies. Preserve original domain — never override with target_domain
        # unless the source cookie truly has no domain at all.
        ok_count = 0
        for i, cookie in enumerate(cookies):
            domain = cookie.get("domain")
            if not domain:
                domain = f".{target_domain}"

            params = {
                "name": cookie["name"],
                "value": cookie["value"],
                "domain": domain,
                "path": cookie.get("path", "/"),
                "secure": bool(cookie.get("secure", True)),
                "httpOnly": bool(cookie.get("httpOnly", False)),
                "sameSite": _normalize_samesite(cookie.get("sameSite")),
            }
            if "expirationDate" in cookie and cookie["expirationDate"]:
                params["expires"] = float(cookie["expirationDate"])

            msg_id = i + 100
            await ws.send(json.dumps({"id": msg_id, "method": "Network.setCookie", "params": params}))
            resp = await _recv_id(ws, msg_id)
            ok = resp.get("result", {}).get("success", False)
            if ok:
                ok_count += 1
            else:
                print(f"  Cookie {cookie.get('name')} FAILED: {json.dumps(resp)[:200]}", flush=True)

        print(f"  Injected {ok_count}/{len(cookies)} cookies", flush=True)

        # Verify: read back cookies for the target domain.
        await ws.send(json.dumps({
            "id": 500,
            "method": "Network.getCookies",
            "params": {"urls": [f"https://{target_domain}"]},
        }))
        verify = await _recv_id(ws, 500)
        got = verify.get("result", {}).get("cookies", []) or []
        print(f"  Verified {len(got)} cookies visible for https://{target_domain}", flush=True)

        # Now navigate to target with cookies already set
        await ws.send(json.dumps({
            "id": 999,
            "method": "Page.navigate",
            "params": {"url": f"https://{target_domain}/"},
        }))
        await _recv_id(ws, 999)
        print(f"  Navigated to https://{target_domain}/", flush=True)


async def launch_browser(cookies: list[dict], target: str = "grok.com") -> str:
    # Always launch isolated Chrome with random port so nothing else can be there.
    debug_port = random.randint(9300, 9400)
    user_data = launch_chrome_window(debug_port)

    # Give Chrome time to start CDP before we hammer it.
    await asyncio.sleep(2)

    # Wait for CDP on OUR port. If port never comes up, the spawn was hijacked
    # by an existing Chrome — fail loudly instead of touching the user's real profile.
    last_err = None
    for i in range(30):
        await asyncio.sleep(0.5)
        try:
            async with httpx.AsyncClient() as client:
                # Verify the browser identity is our fresh profile — /json/version has
                # the userDataDir echoed in some Chrome builds; regardless, we picked a
                # random port that only OUR spawn can be listening on.
                resp = await client.get(
                    f"http://localhost:{debug_port}/json",
                    timeout=httpx.Timeout(2),
                )
                pages = resp.json()
                # Prefer about:blank (fresh tab). If Chrome opened multiple pages, this
                # avoids injecting into some stale/wrong URL.
                page = next(
                    (p for p in pages if p.get("type") == "page" and p.get("url", "").startswith("about:")),
                    None,
                )
                if page is None:
                    page = next((p for p in pages if p.get("type") == "page"), None)
                if page:
                    ws_url = page["webSocketDebuggerUrl"]
                    print(f"[launcher] port={debug_port} profile={user_data}", flush=True)
                    print(f"[launcher] Attaching to page: {page.get('url')}  ws={ws_url}", flush=True)
                    await inject_cookies_and_navigate(ws_url, cookies, target)
                    return f"Isolated Chrome on port {debug_port}, {len(cookies)} cookies injected"
        except Exception as e:
            last_err = e
            print(f"[launcher] CDP attempt {i}: {e}", flush=True)

    raise RuntimeError(
        f"Chrome CDP not available on port {debug_port} "
        f"(profile={user_data}, last_err={last_err}) — вероятно, старый Chrome перехватил spawn. "
        f"Закрой все окна Chrome и попробуй снова."
    )


# --- HTML UI ---

INDEX_HTML = """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cookie Session Launcher</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: #0d0d0d; color: #e0e0e0;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .container { max-width: 640px; width: 100%; padding: 24px; }
  h1 { font-size: 1.4em; margin-bottom: 8px; color: #fff; }
  .sub { color: #888; font-size: 0.85em; margin-bottom: 20px; }
  textarea {
    width: 100%; height: 280px; background: #1a1a1a; border: 1px solid #333;
    color: #e0e0e0; padding: 12px; font-family: 'Cascadia Code', 'Fira Code', monospace;
    font-size: 0.8em; border-radius: 8px; resize: vertical;
  }
  textarea:focus { outline: none; border-color: #4af; }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  input {
    flex: 1; background: #1a1a1a; border: 1px solid #333; color: #e0e0e0;
    padding: 10px 12px; border-radius: 8px; font-size: 0.9em;
  }
  input:focus { outline: none; border-color: #4af; }
  button {
    padding: 10px 24px; background: #4af; color: #000; border: none;
    border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.9em;
    white-space: nowrap;
  }
  button:hover { background: #6bf; }
  button:disabled { background: #333; color: #666; cursor: not-allowed; }
  .status { margin-top: 12px; padding: 10px; border-radius: 6px; font-size: 0.85em; display: none; }
  .status.ok { background: #1a3a1a; color: #4f8; display: block; }
  .status.err { background: #3a1a1a; color: #f66; display: block; }
  .status.info { background: #1a1a3a; color: #8af; display: block; }
  .hint { color: #666; font-size: 0.75em; margin-top: 16px; line-height: 1.5; }
  code { background: #222; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
<div class="container">
  <h1>Cookie Session Launcher</h1>
  <div class="sub">Paste Cookie-Editor JSON → open Chrome with working session</div>

  <textarea id="cookies" placeholder='[{"domain":".grok.com","name":"sso","value":"eyJ...","secure":true}]'></textarea>

  <div class="row">
    <input id="target" value="grok.com" placeholder="grok.com">
    <button id="launch" onclick="launch()">Launch</button>
  </div>

  <div id="status" class="status"></div>

  <div class="hint">
    <strong>How to get cookies:</strong><br>
    1. Open target site in browser where you're logged in<br>
    2. Cookie-Editor extension → Export → copy JSON<br>
    3. Paste here → Launch<br>
    <br>
    Works for any site: <code>grok.com</code>, <code>cursor.com</code>, <code>x.ai</code>, etc.
  </div>
</div>

<script>
async function launch() {
  const btn = document.getElementById('launch');
  const status = document.getElementById('status');
  const raw = document.getElementById('cookies').value.trim();
  const target = document.getElementById('target').value.trim() || 'grok.com';

  if (!raw) { status.className = 'status err'; status.textContent = 'Paste cookie JSON first'; return; }

  let cookies;
  try { cookies = JSON.parse(raw); } catch(e) { status.className = 'status err'; status.textContent = 'Invalid JSON: ' + e.message; return; }
  if (!Array.isArray(cookies)) { status.className = 'status err'; status.textContent = 'JSON must be an array'; return; }

  btn.disabled = true;
  status.className = 'status info';
  status.textContent = 'Launching Chrome...';

  try {
    const resp = await fetch('/launch', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({cookies, target}),
    });
    const data = await resp.json();
    if (resp.ok) {
      status.className = 'status ok';
      status.textContent = data.message + ' — Chrome window opened, work in it';
    } else {
      status.className = 'status err';
      status.textContent = data.detail || 'Launch failed';
    }
  } catch(e) {
    status.className = 'status err';
    status.textContent = 'Connection failed: ' + e.message;
  }
  btn.disabled = false;
}
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def index():
    return INDEX_HTML


@app.post("/launch")
async def launch(data: dict):
    cookies = data.get("cookies", [])
    target = data.get("target", "grok.com")
    if not cookies:
        return {"detail": "No cookies provided"}, 400
    try:
        print(f"[launcher] Received {len(cookies)} cookies for {target}", flush=True)
        result = await launch_browser(cookies, target)
        print(f"[launcher] Success: {result}", flush=True)
        return {"message": result}
    except Exception as e:
        print(f"[launcher] Error: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return {"detail": str(e)}, 500


# --- Grok quota / plan / identity probe ---------------------------------------
#
# Забирает в headless Chrome:
#   email + display name — из кнопки профиля (sidebar)
#   план (SuperGrok / Lite / Heavy / free) — по DOM-маркерам
#   rate-limits — из /rest/rate-limits (простой REST)
#   credits/billing period — из /grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig
#     (grpc-web, декодируется через минимальный protobuf-парсер ниже)
#
# Всё делается через тот же spawn+CDP что и Launch, но с --headless=new и
# автоматическим завершением инстанса после сбора данных.

import struct as _struct


def _pb_varint(data, i):
    val = 0
    shift = 0
    while i < len(data):
        b = data[i]; i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80): break
        shift += 7
    return val, i


def _pb_parse(data, i, end):
    """Мини-парсер protobuf wire format. Возвращает dict field->list of values."""
    out = {}
    while i < end:
        tag, i = _pb_varint(data, i)
        field = tag >> 3
        wtype = tag & 7
        if wtype == 0:
            v, i = _pb_varint(data, i)
        elif wtype == 1:
            v = _struct.unpack('<d', data[i:i+8])[0]; i += 8
        elif wtype == 2:
            l, i = _pb_varint(data, i); v = data[i:i+l]; i += l
        elif wtype == 5:
            v = _struct.unpack('<f', data[i:i+4])[0]; i += 4
        else:
            return out
        out.setdefault(field, []).append(v)
    return out


def _parse_grok_credits(b64_body: str) -> dict:
    """Разбирает body /GetGrokCreditsConfig — grpc-web frame → protobuf.

    Внешнее сообщение имеет один вложенный field 1 (msg) c реальными данными:
      f1 float  — общий % использования за неделю ("87% было в использовании")
      f4/f5     — Google.Timestamp: начало/конец недельного окна
      f7 rep    — { f1 tier_id, f2 float value } — разбивка по типам:
                    tier=5 → Imagine
                    tier=6 → Голосовой режим (Voice)
                    tier=4 → Разговор (Chat)
    Найдено эмпирически на живой сессии, совпадает со скринами UI grok.
    """
    import base64
    data = base64.b64decode(b64_body)
    # grpc-web frame: [0x00, len(BE), msg, trailer...]
    if len(data) < 5:
        return {}
    msg_len = int.from_bytes(data[1:5], 'big')
    outer = _pb_parse(data[5:5+msg_len], 0, msg_len)
    # реальные данные в outer.field(1) как sub-message
    inner_raw = outer.get(1, [None])[0]
    if not isinstance(inner_raw, (bytes, bytearray)):
        return {}
    parsed = _pb_parse(inner_raw, 0, len(inner_raw))

    result = {}
    if 1 in parsed and isinstance(parsed[1][0], (int, float)):
        result['weeklyUsedPct'] = float(parsed[1][0])

    def ts_seconds(nested):
        try:
            sub = _pb_parse(nested, 0, len(nested))
            secs = sub.get(1, [None])[0]
            return int(secs) if secs else None
        except Exception:
            return None
    if 4 in parsed:
        s = ts_seconds(parsed[4][0])
        if s: result['periodStart'] = s
    if 5 in parsed:
        s = ts_seconds(parsed[5][0])
        if s: result['periodEnd'] = s

    tier_names = {4: 'Разговор', 5: 'Imagine', 6: 'Голосовой режим'}
    breakdown = []
    for entry in parsed.get(7, []):
        if isinstance(entry, (bytes, bytearray)):
            sub = _pb_parse(entry, 0, len(entry))
            tier = sub.get(1, [None])[0]
            val = sub.get(2, [None])[0]
            if tier is not None and val is not None:
                breakdown.append({
                    'tier': int(tier),
                    'name': tier_names.get(int(tier), f'tier{tier}'),
                    'pct': float(val),
                })
    if breakdown:
        result['breakdown'] = breakdown
    return result


async def _probe_quota(cookies: list[dict]) -> dict:
    """Запускает headless Chrome, инжектит куки, собирает данные и убивает инстанс."""
    debug_port = random.randint(9500, 9700)
    chrome_path = find_chrome()
    if not chrome_path:
        raise RuntimeError("Chrome not found")
    user_data = tempfile.mkdtemp(prefix="grok-probe-")
    args = [
        chrome_path,
        f"--remote-debugging-port={debug_port}",
        f"--user-data-dir={user_data}",
        "--headless=new",
        "--window-size=1400,900",
        "--no-first-run", "--no-default-browser-check", "--disable-sync",
        "about:blank",
    ]
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    proc = subprocess.Popen(
        args, creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        # wait for CDP
        ws_url = None
        for _ in range(30):
            await asyncio.sleep(0.4)
            try:
                async with httpx.AsyncClient() as c:
                    pages = (await c.get(f"http://localhost:{debug_port}/json", timeout=httpx.Timeout(2))).json()
                    page = next((p for p in pages if p.get("type") == "page"), None)
                    if page:
                        ws_url = page["webSocketDebuggerUrl"]; break
            except Exception:
                pass
        if not ws_url:
            raise RuntimeError("CDP not ready")

        result = {"fetchedAt": int(asyncio.get_event_loop().time() * 1000)}
        credits_body_b64 = None

        async with websockets.connect(ws_url, max_size=None) as ws:
            wid_counter = [0]
            def nid():
                wid_counter[0] += 1; return wid_counter[0]
            async def send(method, params=None):
                i = nid()
                await ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
                return i

            for m in ("Network.enable", "Page.enable", "Runtime.enable"):
                await _recv_id(ws, await send(m), timeout=10)

            # inject cookies
            for c in cookies:
                dom = c.get("domain") or ".grok.com"
                ss = _normalize_samesite(c.get("sameSite"))
                await _recv_id(ws, await send("Network.setCookie", {
                    "name": c["name"], "value": c["value"], "domain": dom,
                    "path": c.get("path", "/"), "secure": bool(c.get("secure", True)),
                    "httpOnly": bool(c.get("httpOnly", False)), "sameSite": ss,
                }), timeout=10)

            # navigate to grok, sniff network. Ловим сразу три endpoint'а:
            #   /api/auth/session       — identity (email, given/family name, userId)
            #   /rest/rate-limits       — короткое окно (2ч, 50/50)
            #   /grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig — недельный лимит
            # Всё через Network.responseReceived, а не искусственный fetch (тот 501).
            await send("Page.navigate", {"url": "https://grok.com/"})
            deadline = asyncio.get_event_loop().time() + 12
            credits_req_id = None
            rate_limits_req_id = None
            auth_req_id = None
            while asyncio.get_event_loop().time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1)
                except asyncio.TimeoutError:
                    continue
                msg = json.loads(raw)
                if msg.get("method") == "Network.responseReceived":
                    p = msg["params"]
                    url = p["response"]["url"]
                    if "GetGrokCreditsConfig" in url and credits_req_id is None:
                        credits_req_id = p["requestId"]
                    elif url.endswith("/rest/rate-limits") and rate_limits_req_id is None:
                        rate_limits_req_id = p["requestId"]
                    elif url.endswith("/api/auth/session") and auth_req_id is None:
                        auth_req_id = p["requestId"]

            async def read_body(req_id):
                try:
                    i = await send("Network.getResponseBody", {"requestId": req_id})
                    r = await _recv_id(ws, i, timeout=5)
                    body = r.get("result", {}).get("body", "")
                    is_b64 = r.get("result", {}).get("base64Encoded", False)
                    return body, is_b64
                except Exception:
                    return None, False

            if auth_req_id:
                body, _ = await read_body(auth_req_id)
                if body:
                    try:
                        auth = json.loads(body)
                        if auth.get("status") == "authenticated" and auth.get("session"):
                            s = auth["session"]
                            display = " ".join(x for x in (s.get("givenName"), s.get("familyName")) if x).strip()
                            result['identity'] = {
                                'email': s.get("email"),
                                'displayName': display or (s.get("email") or "").split("@")[0],
                                'userId': s.get("userId"),
                            }
                    except Exception as e:
                        print(f"[probe] auth parse fail: {e}", flush=True)

            if rate_limits_req_id:
                body, _ = await read_body(rate_limits_req_id)
                if body:
                    try:
                        result['rateLimits'] = json.loads(body)
                    except Exception as e:
                        print(f"[probe] rate-limits parse fail: {e}", flush=True)

            if credits_req_id:
                body, is_b64 = await read_body(credits_req_id)
                if body:
                    if is_b64:
                        credits_body_b64 = body
                    else:
                        import base64 as _b64
                        credits_body_b64 = _b64.b64encode(body.encode('latin-1', 'replace')).decode()

            # Runtime.evaluate helper (returnByValue+awaitPromise)
            async def evalx(expr):
                i = await send("Runtime.evaluate", {
                    "expression": expr, "returnByValue": True, "awaitPromise": True,
                })
                r = await _recv_id(ws, i, timeout=10)
                return r.get("result", {}).get("result", {}).get("value")

            # Fallback identity через DOM если auth-endpoint не отдал
            if not result.get('identity'):
                body_text = await evalx("document.body ? document.body.innerText.slice(0, 8000) : ''") or ''
                import re as _re
                m = _re.search(r"([^\r\n]{1,80})\s*\n\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})", body_text)
                if m:
                    result['identity'] = {'displayName': m.group(1).strip(), 'email': m.group(2).strip()}
            else:
                body_text = await evalx("document.body ? document.body.innerText.slice(0, 8000) : ''") or ''

            body_low = (body_text or '').lower()

        if credits_body_b64:
            try:
                credits = _parse_grok_credits(credits_body_b64)
                if credits:
                    result['credits'] = credits
            except Exception as e:
                print(f"[probe] credits decode fail: {e}", flush=True)

        # План определяем по составу weekly tier'ов: у Free только Imagine(5)+Разговор(4);
        # у SuperGrok/Lite добавляется Голосовой(6); Heavy — доп. маркер в DOM.
        tiers = {b.get('tier') for b in (result.get('credits', {}).get('breakdown') or [])}
        body_low = locals().get('body_low', '')
        if 'supergrok heavy' in body_low:
            result['plan'] = 'SuperGrok Heavy'
        elif 'supergrok lite' in body_low:
            result['plan'] = 'SuperGrok Lite'
        elif 6 in tiers:
            result['plan'] = 'SuperGrok'
        elif tiers:
            result['plan'] = 'Free'

        return result
    finally:
        try: proc.kill()
        except Exception: pass


@app.post("/quota")
async def quota(data: dict):
    cookies = data.get("cookies", [])
    if not cookies:
        return {"detail": "No cookies provided"}, 400
    try:
        print(f"[quota] probing session ({len(cookies)} cookies)", flush=True)
        res = await _probe_quota(cookies)
        print(f"[quota] result: {json.dumps(res)[:300]}", flush=True)
        return res
    except Exception as e:
        print(f"[quota] error: {e}", flush=True)
        import traceback; traceback.print_exc()
        return {"detail": str(e)}, 500


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8765"))
    print(f"\n  Cookie Launcher: http://localhost:{port}\n")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
