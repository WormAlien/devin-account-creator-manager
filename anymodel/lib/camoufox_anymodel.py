"""anymodel/lib/camoufox_anymodel.py
Camoufox для регистрации на anymodel.org.
Протокол: JSON-lines через stdin/stdout.
Команды:
  {"cmd":"register","email":"...","password":"...","proxy":{...}}
  {"cmd":"enter_otp","code":"123456"}
  {"cmd":"stop"}
"""
import asyncio, json, os, re, sys, time, traceback
from pathlib import Path
from camoufox import AsyncCamoufox

# Node пишет в пайп UTF-8, а Windows-Python открывает stdin в cp1251 — кириллица
# в командах (текст кнопок) приезжает битой. Переопределяем явно.
for _stream in ("stdin", "stdout", "stderr"):
    try:
        getattr(sys, _stream).reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE_URL = "https://anymodel.org"
REGISTER_URL = f"{BASE_URL}/app/register"
PROFILE_DIR = Path(__file__).parent / f"camoufox_anymodel_profile_{os.getpid()}"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)

def log(tag, msg):
    t = time.strftime("%H:%M:%S")
    line = f"[{t}] [{tag}] {msg}"
    try:
        print(line, flush=True, file=sys.stderr)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode(), flush=True, file=sys.stderr)

def out(obj):
    try:
        print(json.dumps(obj, ensure_ascii=False), flush=True, file=sys.stdout)
    except UnicodeEncodeError:
        print(json.dumps(obj, ensure_ascii=True), flush=True, file=sys.stdout)

async def _get_turnstile_token(page, timeout=15):
    """Токен из скрытого поля. Camoufox обычно решает Turnstile сам за ~5с
    (fingerprint), клик нужен только если виджет ждёт интеракции."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            token = await page.evaluate("""() => {
                const sel = 'input[name="cf-turnstile-response"], input[name="turnstile_token"], input[name="cf_turnstile"], textarea[name="cf-turnstile-response"]';
                for (const el of document.querySelectorAll(sel)) {
                    if (el.value && el.value.length > 10) return el.value;
                }
                return '';
            }""")
            if token:
                return token
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return ""


FIND_VERIFY_JS = """
() => {
  const RE = /not a robot|verify that you|подтвердите|не робот|verify you are human/i;
  const els = Array.from(document.querySelectorAll('button,div,span,a,p,label,iframe'));
  const cand = els.filter(x => {
    const r = x.getBoundingClientRect();
    if (r.width < 60 || r.height < 12 || r.height > 200) return false;
    if (x.offsetParent === null) return false;
    const txt = (x.textContent || x.title || x.getAttribute('aria-label') || '');
    return RE.test(txt) && txt.trim().length < 120;
  }).sort((a,b) => {
    const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height) - (rb.width*rb.height);
  });
  const b = cand[0];
  if (!b) return null;
  b.scrollIntoView({block:'center'});
  const r = b.getBoundingClientRect();
  return {x: Math.round(r.x + 20), y: Math.round(r.y + r.height/2),
          box:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
          text:(b.textContent||'').trim().slice(0,60)};
}
"""


async def _cf_widget_box(page):
    """bbox Turnstile-виджета: ищем и .cf-turnstile div, и iframe от CF."""
    try:
        return await page.evaluate("""() => {
            let el = document.querySelector('.cf-turnstile, [class*="turnstile"]');
            if (!el) {
                el = [...document.querySelectorAll('iframe')]
                    .find(f => (f.src||'').includes('challenges.cloudflare') ||
                               (f.src||'').includes('turnstile'));
            }
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0
                ? {x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height)}
                : null;
        }""")
    except Exception:
        return None


async def _click_turnstile_widget(page):
    """Кликает чекбокс Turnstile.

    Метод 1 (основной): page.frames — единственный способ найти CF-iframe когда он
    вложен в другой iframe (document.querySelectorAll не видит вложенные фреймы).
    Получаем frame_element() → JS getBoundingClientRect → page.mouse.click.

    Метод 2 (fallback): ищем .cf-turnstile или любой видимый iframe в main DOM.
    """
    # — Метод 1: page.frames ------------------------------------------------
    try:
        cf_frame = None
        for f in page.frames:
            if "challenges.cloudflare" in f.url or "turnstile" in f.url:
                cf_frame = f
                break
        if cf_frame:
            log("captcha", f"CF frame: {cf_frame.url[:80]}")
            try:
                frame_el = await cf_frame.frame_element()
                box = await page.evaluate(
                    """el => { const r = el.getBoundingClientRect();
                       return r.width > 0 ? {x:r.x, y:r.y, w:r.width, h:r.height} : null; }""",
                    frame_el
                )
                if box:
                    cx = box["x"] + 24   # checkbox слева в Turnstile-виджете
                    cy = box["y"] + box["h"] / 2
                    log("captcha", f"frame_element bbox {box['w']}×{box['h']} → click ({round(cx)},{round(cy)})")
                    await _human_click(page, cx, cy, "cf-frame")
                    return True
            except Exception as e:
                log("captcha", f"frame_element err: {e}")
    except Exception as e:
        log("captcha", f"page.frames err: {e}")

    # — Метод 2: main-DOM fallback ------------------------------------------
    try:
        info = await page.evaluate("""() => {
            for (const f of document.querySelectorAll('iframe')) {
                const r = f.getBoundingClientRect();
                if (r.width > 60 && r.height > 10) {
                    f.scrollIntoView({block:'center'});
                    const r2 = f.getBoundingClientRect();
                    return {x: r2.x + 24, y: r2.y + r2.height/2, w: Math.round(r2.width), h: Math.round(r2.height)};
                }
            }
            const div = document.querySelector('.cf-turnstile,[class*="turnstile"]');
            if (div) {
                div.scrollIntoView({block:'center'});
                const r = div.getBoundingClientRect();
                if (r.width > 0)
                    return {x: r.x + 24, y: r.y + r.height/2, w: Math.round(r.width), h: Math.round(r.height)};
            }
            return null;
        }""")
        if info:
            log("captcha", f"DOM fallback {info['w']}×{info['h']} ({round(info['x'])},{round(info['y'])})")
            await _human_click(page, info["x"], info["y"], "ts-dom")
            return True
    except Exception as e:
        log("captcha", f"DOM fallback err: {e}")

    return False


async def _human_click(page, x, y, label=""):
    """Прямой клик мышью. Клик по iframe через DOM (.click()) Turnstile не
    засчитывает — нужны настоящие события мыши на координатах."""
    await page.mouse.move(x, y)
    await asyncio.sleep(0.02)
    await page.mouse.down()
    await asyncio.sleep(0.03)
    await page.mouse.up()
    log("captcha", f"клик мышью [{label}] ({round(x)},{round(y)})")


async def solve_turnstile(page, timeout=45):
    """Как у tmailor: в цикле ищем виджет по тексту/iframe, кликаем, ждём токен."""
    tok = await _get_turnstile_token(page, timeout=3)
    if tok:
        log("turnstile", f"токен готов сразу ({len(tok)} симв)")
        return tok

    deadline = time.time() + timeout
    clicked = False
    last_click_attempt = 0

    while time.time() < deadline:
        tok = await _get_turnstile_token(page, timeout=1)
        if tok:
            log("turnstile", f"решён, токен {len(tok)} симв")
            return tok

        now = time.time()
        # Каждые 3с пробуем найти и кликнуть виджет
        if now - last_click_attempt >= 3:
            found = await _click_turnstile_widget(page)
            last_click_attempt = now
            if found:
                clicked = True
            elif not clicked:
                elapsed = round(now - (deadline - timeout))
                log("turnstile", f"виджет не найден ({elapsed}с)...")

        await asyncio.sleep(0.5)

    log("turnstile", "не решён за отведённое время")
    return ""

async def do_register(page, email, password):
    log("reg", f"opening {REGISTER_URL}")
    await page.goto(REGISTER_URL, wait_until="domcontentloaded", timeout=60000)
    await asyncio.sleep(3)

    log("reg", f"filling email: {email}")
    email_sel = await page.query_selector('input[type="email"], input[name="email"], input[placeholder*="mail"]')
    if not email_sel:
        email_sel = await page.query_selector('input')
    if email_sel:
        # JS-запись обходит блокирующие event-обработчики страницы.
        # fill() и click() виснут на anymodel из-за тяжёлых JS-хендлеров на input.
        await page.evaluate(
            """([el, val]) => {
                const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSet.call(el, val);
                el.dispatchEvent(new Event('input',  {bubbles:true}));
                el.dispatchEvent(new Event('change', {bubbles:true}));
            }""",
            [email_sel, email]
        )
        await asyncio.sleep(0.5)

    log("reg", "filling password")
    pwd_sel = await page.query_selector('input[type="password"]')
    if pwd_sel:
        await page.evaluate(
            """([el, val]) => {
                const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSet.call(el, val);
                el.dispatchEvent(new Event('input',  {bubbles:true}));
                el.dispatchEvent(new Event('change', {bubbles:true}));
            }""",
            [pwd_sel, password]
        )
        await asyncio.sleep(0.5)

    # --- Debug: проверяем состояние Turnstile на странице ----------------------
    ts_debug = await page.evaluate("""() => ({
        hasTurnstile: typeof window.turnstile !== 'undefined',
        sitekey: (document.querySelector('[data-sitekey]') || {dataset: {}}).dataset.sitekey || '',
        iframes: document.querySelectorAll('iframe').length,
        cfInputs: Array.from(document.querySelectorAll('input')).map(el => ({
            name: el.name, type: el.type, val: el.value.slice(0,30)
        })),
    })""")
    log("reg", f"ts-debug: {ts_debug}")

    # --- Turnstile pre-submit --------------------------------------------------
    # solve_turnstile использует _click_turnstile_widget (frame_locator + mouse),
    # что надёжнее старого подхода через page.frames + wait_for_selector.
    # Даём 20с: если виджет уже отрендерился — решим сейчас; если invisible —
    # токен появится сам; если render=explicit (только после Submit) — вернём "".
    log("reg", "pre-submit: пробуем решить Turnstile (20с)...")
    token = await solve_turnstile(page, timeout=20)
    if token:
        log("reg", f"turnstile solved pre-submit ({len(token)} симв)")
    else:
        log("reg", "turnstile pre-submit: нет токена (invisible или render=explicit)")

    # --- Клик Sign up ---------------------------------------------------------
    # ElementHandle-операции (.scroll_into_view, .bounding_box, .click) виснут
    # на anymodel — всё через page.evaluate() + page.mouse.
    async def _click_submit():
        try:
            info = await page.evaluate("""() => {
                let btn = document.querySelector('button[type="submit"]');
                if (!btn) {
                    for (const b of document.querySelectorAll('button')) {
                        if (/sign.?up|register|зарегистрир/i.test(b.textContent || '')) {
                            btn = b; break;
                        }
                    }
                }
                if (!btn) return null;
                btn.scrollIntoView({block: 'center', inline: 'center'});
                const r = btn.getBoundingClientRect();
                return {x: r.x + r.width / 2, y: r.y + r.height / 2,
                        w: Math.round(r.width), h: Math.round(r.height)};
            }""")
            if info and info.get('w', 0) > 0:
                await asyncio.sleep(0.2)
                log("reg", f"submit btn JS ({round(info['x'])},{round(info['y'])})")
                # JS .click() — page.mouse.* виснет на anymodel из-за CF-скриптов
                await page.evaluate("""(pos) => {
                    const el = document.elementFromPoint(pos.x, pos.y)
                        || document.querySelector('button[type="submit"]');
                    if (el) el.click();
                }""", {'x': info['x'], 'y': info['y']})
            else:
                log("reg", "submit btn not found — form.submit()")
                await page.evaluate("() => { const f = document.querySelector('form'); if(f) f.submit(); }")
        except Exception as ce:
            log("reg", f"submit click failed: {ce}")

    await _click_submit()

    # --- Post-submit: render=explicit Turnstile --------------------------------
    # Некоторые сайты запускают Turnstile только при нажатии Submit.
    # Если pre-submit токена не было — решаем сейчас и нажимаем Submit повторно.
    if not token:
        log("reg", "post-submit: ждём Turnstile render=explicit (30с)...")
        token = await solve_turnstile(page, timeout=30)
        if token:
            log("reg", f"turnstile solved post-submit ({len(token)} симв) — нажимаю Submit повторно")
            await asyncio.sleep(0.5)
            await _click_submit()
        else:
            log("reg", "turnstile post-submit: токен не получен")
            await take_ss(page, "turnstile_failed")

    # --- Ждём навигации -------------------------------------------------------
    try:
        await page.wait_for_url(
            lambda u: "register" not in u and "anymodel.org" in u,
            timeout=8000
        )
        log("reg", f"navigated to: {page.url}")
    except Exception:
        await asyncio.sleep(1)

    url = page.url
    content = await page.evaluate("() => document.body.innerText.substring(0, 500)")
    log("reg", f"after click URL: {url}")
    log("reg", f"content preview: {content[:200]}")

    # Читаем весь видимый текст формы — там могут быть ошибки валидации.
    form_text = await page.evaluate("""() => {
        const form = document.querySelector('form');
        if (!form) return 'NO FORM';
        return form.innerText || '';
    }""")
    log("reg", f"form text: {form_text[:400]}")

    # Проверяем ошибки формы
    error_el = await page.query_selector('[class*="error"], [class*="Error"], .alert, [role="alert"]')
    if error_el:
        err_text = (await error_el.inner_text()).strip()
        if err_text:
            log("reg", f"error element: {err_text}")
            return {"ok": False, "error": err_text, "url": url}

    # Fallback: ищем известные ошибки прямо в тексте формы.
    known_errors = [
        "already registered",
        "уже зарегистрирован",
        "couldn't complete",
        "invalid email",
    ]
    for phrase in known_errors:
        if phrase.lower() in form_text.lower():
            log("reg", f"form error detected: {phrase!r}")
            return {"ok": False, "error": form_text[:200], "url": url}

    if "verify" in url.lower() or "otp" in url.lower() or "code" in url.lower():
        log("reg", "on OTP/verify page")
        return {"ok": True, "stage": "otp", "url": url}

    # Убеждаемся что мы НЕ на странице регистрации — "/app/register" содержит
    # "app" но это не дашборд.
    if "register" in url.lower():
        log("reg", "still on register page — form did not submit")
        await take_ss(page, "register_stuck")
        return {"ok": False, "error": "form not submitted", "url": url}

    if "dashboard" in url.lower() or ("app" in url.lower() and "register" not in url.lower()):
        log("reg", "on dashboard")
        api_key = await extract_api_key(page)
        return {"ok": True, "stage": "done", "api_key": api_key, "url": url}

    return {"ok": True, "stage": "unknown", "url": url, "content": content[:300]}

async def do_enter_otp(page, code):
    log("otp", f"entering code: {code}")
    await asyncio.sleep(1)

    # Try common OTP input selectors
    otp_input = await page.query_selector('input[name="code"], input[name="otp"], input[placeholder*="code"], input[placeholder*="код"]')
    if not otp_input:
        # Try to find any visible text input
        otp_input = await page.query_selector('input[type="text"]')
    if otp_input:
        await otp_input.click()
        await otp_input.fill(code)
        await asyncio.sleep(0.3)
        log("otp", "filled")
    else:
        log("otp", "no OTP input found!")
        # Maybe it's a different page
        content = await page.evaluate("() => document.body.innerText.substring(0, 300)")
        log("otp", f"page content: {content}")
        return {"ok": False, "error": "no OTP input found"}

    # Click confirm/verify button
    btn = await page.query_selector('button[type="submit"]')
    if not btn:
        for name in ("Verify", "Подтвердить", "Confirm", "Продолжить"):
            loc = page.get_by_role("button", name=name)
            try:
                if await loc.count():
                    btn = loc.first
                    break
            except Exception:
                pass
    if btn:
        try:
            box = await btn.bounding_box()
            if box:
                await _human_click(page, box["x"] + box["width"]/2, box["y"] + box["height"]/2, "verify-btn")
            else:
                await page.keyboard.press("Enter")
        except Exception:
            await page.keyboard.press("Enter")
        log("otp", "clicked verify")
    else:
        # Try Enter key
        await page.keyboard.press("Enter")
        log("otp", "pressed Enter")

    await asyncio.sleep(5)
    url = page.url
    log("otp", f"after OTP URL: {url}")

    # Extract API key
    api_key = await extract_api_key(page)
    if api_key:
        log("otp", f"API key found: {api_key[:20]}...")
        return {"ok": True, "api_key": api_key}

    # Check if on dashboard
    content = await page.evaluate("() => document.body.innerText.substring(0, 500)")
    if "dashboard" in url.lower() or "api" in content.lower():
        return {"ok": True, "url": url, "content": content[:300]}

    return {"ok": True, "url": url, "content": content[:300]}

async def extract_api_key(page):
    """Извлекает API-ключ со страницы дашборда."""
    try:
        key = await page.evaluate("""() => {
            // Ищем в инпутах
            const inputs = document.querySelectorAll('input[readonly], input[type="text"]');
            for (const inp of inputs) {
                if (inp.value && (inp.value.startsWith('sk-') || inp.value.length > 20)) return inp.value;
            }
            // Ищем в тексте
            const body = document.body.innerText;
            const m = body.match(/sk-[a-zA-Z0-9_-]{20,}/);
            return m ? m[0] : '';
        }""")
        return key or ''
    except Exception:
        return ''

async def take_ss(page, name):
    try:
        ss_dir = Path(__file__).parent.parent / "recordings"
        ss_dir.mkdir(exist_ok=True)
        await page.screenshot(path=str(ss_dir / f"{name}.png"))
        log("ss", f"saved {name}.png")
    except Exception as e:
        log("ss", f"err: {e}")

async def main():
    headless = "--headless" in sys.argv or os.environ.get("HEADLESS") == "1"
    proxy = None

    # Parse proxy from env
    proxy_str = os.environ.get("PROXY")
    if proxy_str:
        try:
            proxy = json.loads(proxy_str)
        except Exception:
            pass

    log("start", f"Camoufox anymodel headless={headless}")

    try:
        async with AsyncCamoufox(
            headless=headless,
            os="windows",
            window=(1280, 720),
            persistent_context=True,
            user_data_dir=str(PROFILE_DIR),
            disable_coop=True,
            humanize=True,
            main_world_eval=True,
            i_know_what_im_doing=True,
            proxy=proxy,
        ) as browser:
            page = browser.pages[0] if browser.pages else await browser.new_page()
            page.on("pageerror", lambda e: None)

            current_page = page  # track which page we're on for OTP

            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                except Exception as e:
                    out({"ok": False, "error": f"invalid json: {e}"})
                    continue

                action = cmd.get("cmd")

                if action == "register":
                    try:
                        await take_ss(page, "01_before_register")
                        result = await do_register(page, cmd["email"], cmd["password"])
                        await take_ss(page, "02_after_register")
                        out(result)
                    except Exception as e:
                        log("register", f"error: {e}\n{traceback.format_exc()}")
                        await take_ss(page, "error_register")
                        out({"ok": False, "error": str(e)})

                elif action == "enter_otp":
                    try:
                        await take_ss(page, "03_before_otp")
                        result = await do_enter_otp(page, cmd["code"])
                        await take_ss(page, "04_after_otp")
                        out(result)
                    except Exception as e:
                        log("enter_otp", f"error: {e}\n{traceback.format_exc()}")
                        await take_ss(page, "error_otp")
                        out({"ok": False, "error": str(e)})

                elif action == "navigate":
                    try:
                        await page.goto(cmd["url"], wait_until="domcontentloaded", timeout=60000)
                        await asyncio.sleep(2)
                        await take_ss(page, f"nav_{int(time.time())}")
                        out({"ok": True})
                    except Exception as e:
                        out({"ok": False, "error": str(e)})

                elif action == "click":
                    try:
                        sel = cmd.get("selector", "")
                        text = cmd.get("text", "")
                        if text:
                            # :has-text() — playwright-псевдокласс, в
                            # query_selector он не работает; берём locator.
                            el = page.get_by_text(text, exact=False).first
                            if not await el.count():
                                el = None
                        else:
                            el = await page.query_selector(sel)
                        if el:
                            await el.click()
                            await asyncio.sleep(2)
                            await take_ss(page, f"click_{int(time.time())}")
                            out({"ok": True})
                        else:
                            out({"ok": False, "error": "element not found"})
                    except Exception as e:
                        out({"ok": False, "error": str(e)})

                elif action == "evaluate":
                    try:
                        result = await page.evaluate(cmd["code"])
                        out({"ok": True, "result": str(result)[:500]})
                    except Exception as e:
                        out({"ok": False, "error": str(e)})

                elif action == "save_session":
                    # Экспорт сессии наружу: профиль Camoufox привязан к pid и
                    # уходит вместе с процессом, дальше её взять неоткуда.
                    try:
                        d = Path(cmd["dir"])
                        d.mkdir(parents=True, exist_ok=True)
                        await browser.storage_state(path=str(d / "session.json"))
                        cookies = await browser.cookies()
                        (d / "cookies.json").write_text(
                            json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8"
                        )
                        log("session", f"saved {len(cookies)} cookies -> {d}")
                        out({"ok": True, "count": len(cookies), "dir": str(d)})
                    except Exception as e:
                        log("session", f"save err: {e}")
                        out({"ok": False, "error": str(e)})

                elif action == "get_url":
                    out({"ok": True, "url": page.url})

                elif action == "screenshot":
                    try:
                        name = cmd.get("name", f"ss_{int(time.time())}")
                        await take_ss(page, name)
                        out({"ok": True})
                    except Exception as e:
                        out({"ok": False, "error": str(e)})

                elif action == "stop":
                    out({"ok": True})
                    break

                else:
                    out({"ok": False, "error": f"unknown cmd: {action}"})

    except Exception as e:
        log("fatal", f"{e}\n{traceback.format_exc()}")
        out({"ok": False, "error": str(e)})

if __name__ == "__main__":
    asyncio.run(main())
