"""routing/tokenrouter/camoufox_autoreg.py
TokenRouter.me auto-reg on Camoufox (Firefox + patched Juggler — не CDP!)
Usage: python camoufox_autoreg.py [count]
"""
import asyncio, sys, json, os, re, time, random, string, shutil, uuid, subprocess
from pathlib import Path
import requests

from camoufox import AsyncCamoufox

TOKENROUTER_URL = "https://tokenrouter.me"
KEYS_URL = "https://tokenrouter.me/keys"
ITE_BASE = "https://instanttempemail.com"
BASE_DIR = Path(__file__).parent  # routing/tokenrouter/
PROFILE_DIR = BASE_DIR / f"camoufox-{uuid.uuid4().hex[:8]}"
ACCOUNTS_FILE = BASE_DIR / "accounts.json"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0"

def log(tag: str, msg: str):
    t = time.strftime("%H:%M:%S")
    try:
        print(f"[{t}] [{tag}] {msg}", flush=True)
    except UnicodeEncodeError:
        print(f"[{t}] [{tag}] {msg.encode('ascii', 'replace').decode()}", flush=True)

def gen_pwd():
    c = string.ascii_letters + string.digits + "!@#$%"
    return "".join(random.choices(c, k=16)) + "aA1!"

def load_accounts():
    try: return json.loads(ACCOUNTS_FILE.read_text())
    except: return []

def save_account(acc):
    a = load_accounts()
    a.append(acc)
    ACCOUNTS_FILE.write_text(json.dumps(a, indent=2, ensure_ascii=False))
    log("save", f"saved (total: {len(a)})")

def update_account(acc):
    """Update an existing account by email, or append if not found."""
    a = load_accounts()
    for entry in a:
        if entry.get("email") == acc["email"]:
            entry.update({k: v for k, v in acc.items() if v is not None})
            ACCOUNTS_FILE.write_text(json.dumps(a, indent=2, ensure_ascii=False))
            log("save", f"updated: {acc['email']}")
            return
    a.append(acc)
    ACCOUNTS_FILE.write_text(json.dumps(a, indent=2, ensure_ascii=False))
    log("save", f"saved (total: {len(a)})")

def add_to_omniroute(email: str, api_key: str):
    """Add the account to the running OmniRoute Docker container via direct DB insert."""
    if not api_key:
        log("omniroute", "skip: no API key")
        return
    script_path = BASE_DIR / "add-to-omniroute.js"
    if not script_path.exists():
        log("omniroute", f"script not found: {script_path}")
        return
    try:
        script = script_path.read_text(encoding="utf-8")
        result = subprocess.run(
            ["docker", "exec", "-i", "omniroute", "node", "-", email, api_key],
            input=script,
            text=True,
            capture_output=True,
            timeout=30,
        )
        out = (result.stdout or "").strip()
        err = (result.stderr or "").strip()
        if result.returncode == 0:
            try:
                data = json.loads(out.splitlines()[-1]) if out else {}
            except Exception:
                data = {}
            action = data.get("action", "ok")
            log("omniroute", f"{email} -> {action}")
        else:
            log("omniroute", f"failed: {err or out}")
    except Exception as e:
        log("omniroute", f"error: {e}")

# ---- instanttempemail.com REST API ----
def ite_create():
    r = requests.post(f"{ITE_BASE}/api/create", headers={
        "user-agent": UA, "accept": "application/json",
        "referer": f"{ITE_BASE}/", "origin": ITE_BASE,
    })
    d = r.json()
    return {"address": d["address"], "token": d["token"]}

def ite_fetch(token):
    r = requests.get(f"{ITE_BASE}/api/inbox/{token}", headers={
        "user-agent": UA, "accept": "application/json",
        "referer": f"{ITE_BASE}/", "origin": ITE_BASE,
    })
    return r.json().get("emails", [])

def ite_flatten(obj):
    if obj is None: return []
    if isinstance(obj, str): return [obj]
    if isinstance(obj, (int, float, bool)): return []
    if isinstance(obj, list):
        res = []
        for v in obj: res.extend(ite_flatten(v))
        return res
    if isinstance(obj, dict):
        res = []
        for v in obj.values(): res.extend(ite_flatten(v))
        return res
    return []

def ite_extract_otp(text):
    if not text: return None
    codes = re.findall(r'(?<!\d)\d{6}(?!\d)', text)
    if not codes: return None
    for c in codes:
        n = int(c)
        if n < 100000: continue
        if c.startswith("20") and 200000 <= n <= 209999: continue
        idx = text.find(c)
        window = text[max(0, idx-80):idx+86]
        if re.search(r'(?:code|verification|otp|verify|token|confirm)', window, re.I):
            return c
    # Fallback: return first valid-looking code
    for c in codes:
        n = int(c)
        if n < 100000: continue
        if c.startswith("20") and 200000 <= n <= 209999: continue
        return c
    return None

async def ite_wait(token, initial_count=0, from_hint="tokenrouter", timeout=120, poll=4):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            emails = ite_fetch(token)
        except Exception as e:
            print(f"[EMAIL] fetch error: {e}")
            await asyncio.sleep(poll)
            continue
        new_emails = emails[initial_count:]
        print(f"[EMAIL] poll: total={len(emails)}, new={len(new_emails)}")
        for em in new_emails:
            text = " ".join(ite_flatten(em))
            text = re.sub(r'<[^>]*>', ' ', text)
            text = re.sub(r'\s+', ' ', text).strip()
            print(f"[EMAIL] raw text: {text[:700]}")
            code = ite_extract_otp(text)
            # Accept tokenrouter.me, www.tokenrouter.me, or any tokenrouter link
            link_match = re.search(r'https?://(?:www\.)?tokenrouter\.me/[^\s"\'<>]+', text, re.I)
            link = link_match.group(0) if link_match else None
            # Also accept any other link if text mentions tokenrouter
            if not link and from_hint.lower() in text.lower():
                link_match = re.search(r'https?://[^\s"\'<>]+', text, re.I)
                link = link_match.group(0) if link_match else None
            print(f"[EMAIL] extracted: code={code}, link={link}")
            if code or link:
                return {"code": code, "link": link}
        await asyncio.sleep(poll)
    print("[EMAIL] timeout, no code/link found")
    return None

# ---- Fast helpers (JS-based, no humanize delay) ----
async def js_fill(page, selector, value):
    """Fill input via JS — instant, no mouse movement."""
    try:
        result = await page.evaluate("""([sel, val]) => {
            const el = document.querySelector(sel);
            if (!el) return 'not_found';
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
        }""", [selector, value])
        return result == 'ok'
    except Exception as e:
        log("fill", f"JS fill error: {e}")
        return False

async def js_click(page, selector):
    """Click via JS — instant, no mouse movement."""
    try:
        await page.evaluate("""(sel) => {
            const el = document.querySelector(sel);
            if (el) { el.click(); return true; }
            return false;
        }""", selector)
        return True
    except:
        return False

async def js_click_text(page, text):
    """Click button by text content via JS."""
    try:
        await page.evaluate("""(txt) => {
            const btns = document.querySelectorAll('button, a');
            for (const b of btns) {
                if (b.textContent.includes(txt)) { b.click(); return true; }
            }
            return false;
        }""", text)
        return True
    except:
        return False

async def handle_turnstile(page):
    log("turnstile", "looking...")
    await asyncio.sleep(1.5)

    # Click main page first to ensure focus
    try:
        await page.click("body", position={"x": 100, "y": 100}, timeout=2000)
    except: pass
    await asyncio.sleep(0.3)

    for attempt in range(5):
        # Try clicking the iframe element on the page (not inside it)
        try:
            await page.click("iframe[src*='cloudflare'], iframe[src*='turnstile'], .cf-turnstile", timeout=3000)
            log("turnstile", f"clicked iframe element (attempt {attempt+1})")
        except:
            # Fallback: click inside iframe
            frame = None
            for f in page.frames:
                if "challenges.cloudflare.com" in f.url:
                    frame = f
                    break
            if frame:
                try:
                    await frame.click("body", position={"x": 30, "y": 30}, timeout=3000)
                    log("turnstile", f"clicked inside iframe")
                except Exception as e:
                    log("turnstile", f"iframe click err: {e}")

        await asyncio.sleep(2)
        try:
            token = await page.eval_on_selector('input[name="cf-turnstile-response"]', "el => el.value")
            if token and len(token) > 10:
                log("turnstile", "PASSED!")
                return True
        except: pass

    log("turnstile", "polling...")
    for _ in range(12):
        await asyncio.sleep(2)
        try:
            token = await page.eval_on_selector('input[name="cf-turnstile-response"]', "el => el.value")
            if token and len(token) > 10:
                log("turnstile", "PASSED!")
                return True
        except: pass

    log("turnstile", "manual")
    print("\n  >>> Solve CAPTCHA, press Enter <<<")
    try: sys.stdin.readline()
    except: pass
    try:
        token = await page.eval_on_selector('input[name="cf-turnstile-response"]', "el => el.value")
        if token and len(token) > 10:
            log("turnstile", "manual OK")
            return True
    except: pass
    return False

async def create_account(browser, idx):
    log("acc", f"=== Account #{idx + 1} ===")

    page = await browser.new_page()
    page.on("pageerror", lambda e: None)

    for attempt in range(5):
        email_data = ite_create()
        email = email_data["address"]
        token = email_data["token"]
        initial_inbox = len(ite_fetch(token))
        if initial_inbox == 0:
            break
        log("email", f"inbox has {initial_inbox} old msgs, retry {attempt+1}...")
    else:
        log("email", "WARNING: all inboxes had old mail, using last one")
    password = gen_pwd()
    log("email", email)

    await page.goto(f"{TOKENROUTER_URL}/register", wait_until="domcontentloaded", timeout=45000)
    await asyncio.sleep(1.5)

    # Make sure we're on the SIGN UP form, not login
    # Check URL contains 'register' or look for signup-specific elements
    for attempt in range(3):
        current_url = page.url
        if '/register' in current_url or '/signup' in current_url:
            break
        # We might be on login page — try to navigate to register
        await page.goto(f"{TOKENROUTER_URL}/register", wait_until="domcontentloaded", timeout=15000)
        await asyncio.sleep(1)
    else:
        log("reg", "WARNING: may not be on registration page")

    # Look for sign-up tab/link only if there's no password field visible yet
    has_email = await page.query_selector("input[type='email'], input[name='email']")
    has_pw = await page.query_selector("input[type='password']")
    if has_email and not has_pw:
        # Probably on login page — click Sign Up
        for tab in ["text=Sign up", "text=Register", "text=Create account", "a:has-text('Sign up')"]:
            try:
                await page.click(tab, timeout=2000)
                await asyncio.sleep(0.5)
                break
            except: continue

    # Fill forms — JS (instant)
    await js_fill(page, "input[type='email']", email)
    await js_fill(page, "input[type='password']", password)

    # CF Turnstile — MOUSE (only humanize interaction)
    await handle_turnstile(page)

    # Submit via JS
    await page.evaluate("""() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
            if (b.textContent.includes('Sign Up') || b.type === 'submit') { b.click(); return; }
        }
    }""")
    await asyncio.sleep(1.5)

    otp = await ite_wait(token, initial_count=initial_inbox, from_hint="tokenrouter")

    verify_link = None
    verified = False
    if otp and otp.get("code"):
        log("email", f"OTP: {otp['code']}")
        try:
            el = await page.wait_for_selector("input[placeholder*='code' i], input[maxlength='6']", timeout=5000, state="visible")
            await el.click()
            await page.keyboard.type(otp["code"], delay=50)
        except:
            await page.evaluate("""(code) => {
                const inputs = document.querySelectorAll('input[maxlength="1"], input[placeholder*="code" i]');
                if (inputs.length >= 6) {
                    for (let i = 0; i < code.length && i < inputs.length; i++) {
                        inputs[i].focus(); inputs[i].value = code[i];
                        inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                    }
                } else {
                    const el = document.querySelector('input[placeholder*="code" i], input[maxlength="6"]');
                    if (el) { el.value = code; el.dispatchEvent(new Event('input', { bubbles: true })); }
                }
            }""", otp["code"])
        await asyncio.sleep(0.2)
        await js_click(page, "button[type='submit']")
        for _ in range(10):
            await asyncio.sleep(0.5)
            if "/dashboard" in page.url:
                verified = True
                break

    if otp and otp.get("link"):
        verify_link = otp["link"]
    if verify_link:
        await page.goto(verify_link, wait_until="domcontentloaded", timeout=45000)
        await asyncio.sleep(0.5)
        if "/dashboard" in page.url:
            verified = True

    # Save immediately after registration
    if verified:
        save_account({"email": email, "password": password, "apiKey": None, "apiKeyName": None,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cookies": []})
        log("save", f"account saved (no key yet): {email}")

    log("nav", "going to /keys...")
    await page.goto(KEYS_URL, wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(0.5)

    # Remove popup overlays (not dialogs) — they block clicks
    await page.evaluate("""() => {
        document.querySelectorAll('.fixed.inset-0').forEach(el => {
            // Skip API key dialogs
            if (el.querySelector('[role="dialog"]')) return;
            // Only remove blur-backdrop popups (z-120, backdrop-blur etc)
            if (el.className.includes('backdrop-blur') || el.className.includes('z-[120]') || el.className.includes('popup')) {
                el.remove();
            }
        });
    }""")
    await asyncio.sleep(0.3)
    # Try clicking dismiss buttons
    await page.evaluate("""() => {
        for (const b of document.querySelectorAll('button')) {
            if (/mark as read|got it|dismiss/i.test(b.textContent)) b.click();
        }
    }""")
    await asyncio.sleep(0.3)

    # Re-login if needed (JS)
    has_login = await page.query_selector("input[type='email']")
    if has_login:
        await js_fill(page, "input[type='email']", email)
        await js_fill(page, "input[type='password']", password)
        await js_click(page, "button[type='submit']")
        await asyncio.sleep(1)
        if "/keys" not in page.url:
            await page.goto(KEYS_URL, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(0.3)

    # Open API key dialog (JS)
    await page.evaluate("""() => {
        for (const b of document.querySelectorAll('button')) {
            if (b.textContent.includes('Create API Key')) { b.click(); return; }
        }
    }""")
    await asyncio.sleep(0.5)
    for _ in range(10):
        if await page.query_selector("[role='dialog']"): break
        await asyncio.sleep(0.3)

    # === DIALOG: name JS, group mouse, create mouse, copy JS ===
    key_name = f"k{random.randint(10,99)}"
    api_key = None

    # Fill name (JS)
    await asyncio.sleep(0.3)
    await js_fill(page, "[role='dialog'] input[type='text']", key_name)

    # Select group — MOUSE, wait for it to actually complete
    group_ok = False
    try:
        await page.click("[role='dialog'] button:has-text('Select a group')", timeout=4000)
        # Wait for dropdown to fully appear
        await asyncio.sleep(0.8)
        # Click group option
        try:
            await page.click(":has-text('Free trial 1 day')", timeout=4000)
            group_ok = True
        except:
            try: await page.click("[role='option']:first-child", timeout=3000); group_ok = True
            except: pass
        await asyncio.sleep(0.3)
    except Exception as e:
        log("keys", f"group select failed: {e}")
    log("keys", f"group selected: {group_ok}")

    # Click Create (JS)
    await page.evaluate("""() => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return;
        const btn = d.querySelector('button[type="submit"]');
        if (btn) { btn.click(); return; }
        for (const b of d.querySelectorAll('button')) {
            if (b.textContent.includes('Create')) { b.click(); return; }
        }
    }""")
    await asyncio.sleep(2.5)

    # Copy key (JS)
    await page.evaluate("""() => {
        for (const b of document.querySelectorAll('button')) {
            if ((b.title && b.title.includes('Copy')) || b.textContent.includes('Copy')) { b.click(); return; }
        }
    }""")
    await asyncio.sleep(0.3)
    api_key = await page.evaluate("async () => { try { return await navigator.clipboard.readText(); } catch(e) { return null; } }")

    if not api_key:
        body = await page.evaluate("() => document.body?.innerText || ''")
        m = re.search(r'(?:sk-|fe[_-])[A-Za-z0-9_-]{20,}', body)
        if m: api_key = m.group(0)

    log("keys", f"KEY: {'***'+api_key[-8:] if api_key and len(api_key)>20 else 'NOT FOUND'}")

    # Dismiss post-create popup
    await page.evaluate("""() => {
        for (const b of document.querySelectorAll('button')) {
            if (/mark as read|got it|dismiss|done/i.test(b.textContent)) { b.click(); return; }
        }
    }""")
    await asyncio.sleep(0.3)

    # Save session (cookies + localStorage) — like FreeModel session.json
    session = {}
    try:
        raw_cookies = await page.context.cookies()
        session["cookies"] = [{
            "name": c.get("name", ""), "value": c.get("value", ""),
            "domain": c.get("domain", ""), "path": c.get("path", "/"),
            "secure": c.get("secure", False), "httpOnly": c.get("httpOnly", False),
            "sameSite": c.get("sameSite", "Lax"),
        } for c in raw_cookies]
    except:
        session["cookies"] = []

    try:
        session["localStorage"] = await page.evaluate("""() => {
            const data = {};
            try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); data[k] = localStorage.getItem(k); } } catch(e) {}
            return data;
        }""")
    except:
        session["localStorage"] = {}

    # Save session file
    session_dir = BASE_DIR / "sessions" / email.replace("@", "_").replace(".", "_")
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "session.json").write_text(json.dumps(session, indent=2))
    (session_dir / "account_info.txt").write_text(
        f"Email: {email}\nPassword: {password}\nAPI Key: {api_key or ''}\n"
        f"API Key Name: {key_name}\nCreated: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
    )

    acc = {
        "email": email, "password": password, "apiKey": api_key,
        "apiKeyName": key_name, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    update_account(acc)

    if os.environ.get("AUTO_ADD_TOKENROUTER_TO_OMNIROUTE") in ("1", "true", "yes"):
        add_to_omniroute(email, api_key)

    await page.close()
    log("acc", f"DONE: {email} {'***' + api_key[-8:] if api_key and len(api_key)>20 else 'NO KEY'}  session → {session_dir}")
    return acc

def cleanup_old_profiles():
    for entry in BASE_DIR.iterdir():
        if entry.is_dir() and entry.name.startswith("camoufox-"):
            try: shutil.rmtree(entry, ignore_errors=True)
            except: pass

async def main():
    count = 1
    for a in sys.argv[1:]:
        if a.isdigit():
            count = max(1, min(20, int(a)))

    print("=" * 60)
    print("  TokenRouter.me — Camoufox (Firefox + patched Juggler)")
    print(f"  Accounts: {count}")
    print("=" * 60 + "\n")

    try:
        async with AsyncCamoufox(
            headless=False,
            os="windows",
            window=(1280, 720),
            persistent_context=True,
            user_data_dir=str(PROFILE_DIR),
            disable_coop=True,
            humanize=10.0,
            main_world_eval=True,
            i_know_what_im_doing=True,
        ) as browser:
            for i in range(count):
                try:
                    await create_account(browser, i)
                except Exception as e:
                    log("err", str(e))
                    import traceback; traceback.print_exc()
                if i < count - 1:
                    await asyncio.sleep(0.5)
    finally:
        try: shutil.rmtree(PROFILE_DIR, ignore_errors=True)
        except: pass
        cleanup_old_profiles()

if __name__ == "__main__":
    asyncio.run(main())
