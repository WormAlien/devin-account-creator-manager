"""routing/tokenrouter/camoufox_autoreg.py
TokenRouter.me auto-reg on Camoufox (Firefox + patched Juggler — не CDP!)
Usage: python camoufox_autoreg.py [count]
"""
import asyncio, sys, json, os, re, time, random, string, shutil, uuid, subprocess, tempfile
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
    """Add the account to OmniRoute via the official REST API client."""
    if not api_key:
        log("omniroute", "skip: no API key")
        return
    client_path = BASE_DIR / "omniroute-api-client.js"
    if not client_path.exists():
        log("omniroute", f"client not found: {client_path}")
        return
    try:
        result = subprocess.run(
            ["node", str(client_path), email, api_key],
            text=True,
            capture_output=True,
            timeout=60,
        )
        out = (result.stdout or "").strip()
        err = (result.stderr or "").strip()
        if result.returncode == 0:
            log("omniroute", f"{email} -> {out.splitlines()[-1] if out else 'ok'}")
        else:
            log("omniroute", f"failed: {err or out}")
    except Exception as e:
        log("omniroute", f"error: {e}")

# ---- Email providers + blacklist management ----
EMAIL_BLACKLIST_FILE = BASE_DIR / "email-blacklist.json"
EMAIL_PROVIDER_BLACKLIST_FILE = BASE_DIR / "email-provider-blacklist.json"
MAX_EMAIL_RETRIES = 3
PROVIDER_BLACKLIST_TTL_SECONDS = 3600

# Patterns that indicate the email/domain was rejected by tokenrouter during registration
REGISTRATION_REJECTION_PATTERNS = [
    "banned", "blocked", "suspended", "not allowed", "cannot create", "cannot sign up",
    "limit", "too many", "try again with a different email", "invalid email",
    "email is not valid", "this email", "already in use", "already exists",
    "registration limit", "signup limit", "rate limit", "temp email", "disposable",
    "email has been used", "email already taken", "maximum number", "too many accounts",
]

def load_json_file(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}

def save_json_file(path, data):
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

def is_email_blacklisted(address):
    bl = load_json_file(EMAIL_BLACKLIST_FILE, {})
    return address.lower() in bl

def add_email_to_blacklist(address, reason=""):
    bl = load_json_file(EMAIL_BLACKLIST_FILE, {})
    bl[address.lower()] = {
        "reason": reason,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    save_json_file(EMAIL_BLACKLIST_FILE, bl)
    log("email", f"blacklisted: {address} ({reason})")

def is_provider_blacklisted(name):
    bl = load_json_file(EMAIL_PROVIDER_BLACKLIST_FILE, {})
    entry = bl.get(name)
    if not entry:
        return False
    try:
        at = time.mktime(time.strptime(entry.get("at", "2000-01-01T00:00:00Z"), "%Y-%m-%dT%H:%M:%SZ"))
    except Exception:
        return False
    return (time.time() - at) < PROVIDER_BLACKLIST_TTL_SECONDS

def blacklist_provider(name, reason=""):
    bl = load_json_file(EMAIL_PROVIDER_BLACKLIST_FILE, {})
    bl[name] = {
        "reason": reason,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    save_json_file(EMAIL_PROVIDER_BLACKLIST_FILE, bl)
    log("email", f"provider blacklisted: {name} ({reason})")

# ---- instanttempemail.com ----
def ite_create():
    r = requests.post(f"{ITE_BASE}/api/create", headers={
        "user-agent": UA, "accept": "application/json",
        "referer": f"{ITE_BASE}/", "origin": ITE_BASE,
    })
    d = r.json()
    return {"address": d["address"], "token": d["token"], "provider": "instanttempemail"}

def ite_fetch(token):
    r = requests.get(f"{ITE_BASE}/api/inbox/{token}", headers={
        "user-agent": UA, "accept": "application/json",
        "referer": f"{ITE_BASE}/", "origin": ITE_BASE,
    })
    return r.json().get("emails", [])

# ---- 10minutemail.com (fallback via curl + cookie jar) ----
def tenmin_curl(url, cookie_path, timeout=10):
    args = [
        "curl.exe", "-A", UA, "-s", "-S",
        "--max-time", str(timeout),
        "-H", "Accept: application/json, text/plain, */*",
        "-H", "Referer: https://10minutemail.com/",
        "-c", cookie_path, "-b", cookie_path,
        url,
    ]
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout + 5)
    if result.returncode != 0:
        raise Exception(f"curl {url} failed: {result.stderr.strip()}")
    try:
        return json.loads(result.stdout)
    except Exception as e:
        raise Exception(f"curl {url} non-JSON: {result.stdout[:200]}")

def tenmin_create():
    cookie_path = tempfile.mktemp(suffix="_10mm.txt")
    data = tenmin_curl("https://10minutemail.com/session/address", cookie_path)
    address = data.get("address")
    if not address:
        raise Exception("no address in response")
    return {"address": address, "cookie_path": cookie_path, "provider": "10minutemail"}

def tenmin_inbox_count(cookie_path):
    data = tenmin_curl("https://10minutemail.com/messages/messageCount", cookie_path)
    return data.get("messageCount", 0)

def tenmin_messages(cookie_path, after=0):
    return tenmin_curl(f"https://10minutemail.com/messages/messagesAfter/{after}", cookie_path)

# ---- Shared helpers ----
def email_flatten(obj):
    if obj is None: return []
    if isinstance(obj, str): return [obj]
    if isinstance(obj, (int, float, bool)): return []
    if isinstance(obj, list):
        res = []
        for v in obj: res.extend(email_flatten(v))
        return res
    if isinstance(obj, dict):
        res = []
        for v in obj.values(): res.extend(email_flatten(v))
        return res
    return []

def email_extract_otp(text):
    if not text: return None
    codes = re.findall(r'(?<!\d)\d{6}(?!\d)', text)
    if not codes: return None
    candidates = []
    for c in codes:
        n = int(c)
        if n < 100000: continue
        if c.startswith("20") and 200000 <= n <= 209999: continue
        candidates.append(c)
    if not candidates: return None
    kw = re.compile(r'(?:code|verification|otp|verify|token|confirm|код|пин)', re.I)
    for c in candidates:
        idx = text.find(c)
        if idx < 0: continue
        window = text[max(0, idx - 80):idx + 86]
        if kw.search(window): return c
    return candidates[0]

async def create_email_with_fallback(max_attempts=10):
    """Try providers until a non-blacklisted, clean email is created."""
    providers = [
        ("instanttempemail", lambda: ite_create()),
        ("10minutemail", lambda: tenmin_create()),
    ]
    for attempt in range(max_attempts):
        for name, create in providers:
            if is_provider_blacklisted(name):
                log("email", f"skipping blacklisted provider {name}")
                continue
            try:
                data = create()
                address = data["address"]
                if is_email_blacklisted(address):
                    log("email", f"blacklisted address generated, retrying: {address}")
                    continue
                if name == "instanttempemail":
                    initial = len(ite_fetch(data["token"]))
                    if initial > 0:
                        log("email", f"inbox has {initial} old msgs, retrying")
                        continue
                data["initial_count"] = 0
                return data
            except Exception as e:
                log("email", f"{name} failed: {e}")
                blacklist_provider(name, str(e))
    raise Exception("all email providers failed to create a clean address")

async def wait_for_email(email_data, from_hint="tokenrouter", timeout=120, poll=4):
    provider = email_data.get("provider")
    if provider == "10minutemail":
        return await tenmin_wait(email_data, from_hint, timeout, poll)
    return await ite_wait(email_data["token"], initial_count=email_data.get("initial_count", 0), from_hint=from_hint, timeout=timeout, poll=poll)

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
            text = " ".join(email_flatten(em))
            text = re.sub(r'<[^>]*>', ' ', text)
            text = re.sub(r'\s+', ' ', text).strip()
            print(f"[EMAIL] raw text: {text[:700]}")
            code = email_extract_otp(text)
            link_match = re.search(r'https?://(?:www\.)?tokenrouter\.me/[^\s"\'<>]+', text, re.I)
            link = link_match.group(0) if link_match else None
            if not link and from_hint.lower() in text.lower():
                link_match = re.search(r'https?://[^\s"\'<>]+', text, re.I)
                link = link_match.group(0) if link_match else None
            print(f"[EMAIL] extracted: code={code}, link={link}")
            if code or link:
                return {"code": code, "link": link}
        await asyncio.sleep(poll)
    print("[EMAIL] timeout, no code/link found")
    return None

async def tenmin_wait(email_data, from_hint="tokenrouter", timeout=120, poll=4):
    cookie_path = email_data["cookie_path"]
    last_count = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            count = tenmin_inbox_count(cookie_path)
        except Exception as e:
            print(f"[EMAIL] inbox error: {e}")
            await asyncio.sleep(poll)
            continue
        if count != last_count:
            print(f"[EMAIL] inbox: {count} message(s)")
            last_count = count
        if count > 0:
            try:
                emails = tenmin_messages(cookie_path, 0)
                for em in (emails if isinstance(emails, list) else []):
                    text = " ".join(email_flatten(em))
                    text = re.sub(r'<[^>]*>', ' ', text)
                    text = re.sub(r'\s+', ' ', text).strip()
                    if from_hint.lower() not in text.lower():
                        continue
                    code = email_extract_otp(text)
                    link_match = re.search(r'https?://(?:www\.)?tokenrouter\.me/[^\s"\'<>]+', text, re.I)
                    link = link_match.group(0) if link_match else None
                    if not link:
                        link_match = re.search(r'https?://[^\s"\'<>]+', text, re.I)
                        link = link_match.group(0) if link_match else None
                    print(f"[EMAIL] extracted: code={code}, link={link}")
                    if code or link:
                        return {"code": code, "link": link}
            except Exception as e:
                print(f"[EMAIL] messages error: {e}")
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

async def is_email_rejected(page):
    """Check if tokenrouter rejected the email after signup submit."""
    try:
        body = await page.evaluate("() => document.body?.innerText || ''")
        text = body.lower()
        for p in REGISTRATION_REJECTION_PATTERNS:
            if p in text:
                return p
    except Exception:
        pass
    return None

async def register_one_account(page, email, password, email_data):
    """One registration attempt. Returns {verified: bool, rejected: bool, reason: str}."""
    await page.goto(f"{TOKENROUTER_URL}/register", wait_until="domcontentloaded", timeout=45000)
    await asyncio.sleep(1.5)

    for attempt in range(3):
        current_url = page.url
        if '/register' in current_url or '/signup' in current_url:
            break
        await page.goto(f"{TOKENROUTER_URL}/register", wait_until="domcontentloaded", timeout=15000)
        await asyncio.sleep(1)
    else:
        log("reg", "WARNING: may not be on registration page")

    has_email = await page.query_selector("input[type='email'], input[name='email']")
    has_pw = await page.query_selector("input[type='password']")
    if has_email and not has_pw:
        for tab in ["text=Sign up", "text=Register", "text=Create account", "a:has-text('Sign up')"]:
            try:
                await page.click(tab, timeout=2000)
                await asyncio.sleep(0.5)
                break
            except: continue

    await js_fill(page, "input[type='email']", email)
    await js_fill(page, "input[type='password']", password)

    await handle_turnstile(page)

    await page.evaluate("""() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
            if (b.textContent.includes('Sign Up') || b.type === 'submit') { b.click(); return; }
        }
    }""")
    await asyncio.sleep(1.5)

    reason = await is_email_rejected(page)
    if reason:
        return {"verified": False, "rejected": True, "reason": reason}

    otp = await wait_for_email(email_data, from_hint="tokenrouter")

    verified = False
    verify_link = None
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

    if not verified and otp and otp.get("link"):
        verify_link = otp["link"]
    if verify_link:
        await page.goto(verify_link, wait_until="domcontentloaded", timeout=45000)
        await asyncio.sleep(0.5)
        if "/dashboard" in page.url:
            verified = True

    if not verified:
        reason = await is_email_rejected(page)
        if reason:
            return {"verified": False, "rejected": True, "reason": reason}

    if verified:
        save_account({"email": email, "password": password, "apiKey": None, "apiKeyName": None,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cookies": []})
        log("save", f"account saved (no key yet): {email}")

    return {"verified": verified, "rejected": False, "reason": None}

def cleanup_email_data(email_data):
    if email_data and email_data.get("provider") == "10minutemail":
        try:
            cp = email_data.get("cookie_path")
            if cp and os.path.exists(cp):
                os.unlink(cp)
        except Exception:
            pass

async def create_account(browser, idx):
    log("acc", f"=== Account #{idx + 1} ===")
    page = await browser.new_page()
    page.on("pageerror", lambda e: None)

    password = gen_pwd()
    email = None
    email_data = None
    verified = False

    for email_attempt in range(MAX_EMAIL_RETRIES):
        try:
            email_data = await create_email_with_fallback()
            email = email_data["address"]
            log("email", f"attempt {email_attempt + 1}: {email}")
        except Exception as e:
            log("email", f"failed to create email: {e}")
            break

        try:
            result = await register_one_account(page, email, password, email_data)
        except Exception as e:
            log("err", f"registration attempt {email_attempt + 1} error: {e}")
            import traceback; traceback.print_exc()
            break

        if result["verified"]:
            verified = True
            break
        if result["rejected"]:
            add_email_to_blacklist(email, result["reason"])
            log("reg", f"email rejected ({result['reason']}), retrying with new email")
            continue
        log("reg", "not verified and no rejection pattern; stopping retries")
        break

    cleanup_email_data(email_data)

    if not verified:
        try:
            await page.close()
        except Exception as e:
            log("page", f"close error: {e}")
        raise Exception("registration failed after max email retries")

    log("nav", "going to /keys...")
    await page.goto(KEYS_URL, wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(0.5)

    # Remove popup overlays (not dialogs) — they block clicks
    await page.evaluate("""() => {
        document.querySelectorAll('.fixed.inset-0').forEach(el => {
            if (el.querySelector('[role="dialog"]')) return;
            if (el.className.includes('backdrop-blur') || el.className.includes('z-[120]') || el.className.includes('popup')) {
                el.remove();
            }
        });
    }""")
    await asyncio.sleep(0.3)
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

    await asyncio.sleep(0.3)
    await js_fill(page, "[role='dialog'] input[type='text']", key_name)

    group_ok = False
    try:
        await page.click("[role='dialog'] button:has-text('Select a group')", timeout=4000)
        await asyncio.sleep(0.8)
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

    await page.evaluate("""() => {
        for (const b of document.querySelectorAll('button')) {
            if (/mark as read|got it|dismiss|done/i.test(b.textContent)) { b.click(); return; }
        }
    }""")
    await asyncio.sleep(0.3)

    # Save session (cookies + localStorage)
    session = {"url": TOKENROUTER_URL, "email": email, "password": password}
    try:
        raw_cookies = await page.context.cookies()
        session["cookies"] = [{
            "name": c.get("name", ""), "value": c.get("value", ""),
            "domain": c.get("domain", ""), "path": c.get("path", "/"),
            "secure": bool(c.get("secure", False)),
            "httpOnly": bool(c.get("httpOnly", False)),
            "sameSite": c.get("sameSite", "Lax"),
        } for c in raw_cookies]
    except Exception as e:
        log("session", f"cookies error: {e}")
        session["cookies"] = []

    try:
        session["localStorage"] = await page.evaluate("""() => {
            const data = {};
            try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); data[k] = localStorage.getItem(k); } } catch(e) {}
            return data;
        }""")
    except Exception as e:
        log("session", f"localStorage error: {e}")
        session["localStorage"] = {}

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
        "cookies": session["cookies"], "localStorage": session["localStorage"],
        "sessionDir": str(session_dir),
    }
    update_account(acc)

    if os.environ.get("AUTO_ADD_TOKENROUTER_TO_OMNIROUTE") in ("1", "true", "yes"):
        add_to_omniroute(email, api_key)

    try:
        await page.close()
    except Exception as e:
        log("page", f"close error: {e}")

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
