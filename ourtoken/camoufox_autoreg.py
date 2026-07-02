"""ourtoken/camoufox_autoreg.py
Авторегистрация на ourtoken.ai через CamoFox (Firefox + обход Cloudflare).
Сохраняет аккаунты в routing/ourtoken-sessions.json.
"""
import asyncio, json, os, sys, re, random, string, time
from pathlib import Path
from camoufox import AsyncCamoufox

# Windows-консоль в cp1251 не умеет юникод (✓✗…) — форсим UTF-8, чтобы log() не падал.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_URL = "https://ourtoken.ai"
BASE_DIR = Path(__file__).parent
ROUTING_DIR = BASE_DIR.parent / "routing"
SESSIONS_FILE = ROUTING_DIR / "ourtoken-sessions.json"

def log(tag, msg):
    t = time.strftime("%H:%M:%S")
    print(f"[{t}] [{tag}] {msg}", flush=True)

# Вывести окно Firefox/Camoufox на передний план (в фоне вкладка троттлится/крашится).
def focus_browser_window():
    if sys.platform != "win32":
        return
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        SW_RESTORE = 9
        target = []
        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def enum_cb(hwnd, _):
            if not u.IsWindowVisible(hwnd):
                return True
            n = u.GetWindowTextLengthW(hwnd)
            if n == 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            title = buf.value.lower()
            if any(k in title for k in ("mozilla firefox", "camoufox", "ourtoken", "our token")):
                target.append(hwnd)
            return True
        u.EnumWindows(enum_cb, 0)
        for hwnd in target:
            u.ShowWindow(hwnd, SW_RESTORE)
            u.SetForegroundWindow(hwnd)
    except Exception:
        pass

def gen_name():
    prefixes = ['Alex','Sam','Jordan','Casey','Morgan','Riley','Avery','Quinn','Chen','Max',
                'Leo','Kai','Nico','Luca','Mia','Zoe','Luna','Nova','Eden','Skye']
    return random.choice(prefixes) + str(random.randint(100, 9999))

def gen_pwd():
    c = string.ascii_letters + string.digits + "!@#$%^&*"
    return ''.join(random.choices(c, k=18)) + 'aA1!'

def load_sessions():
    try: return json.loads(SESSIONS_FILE.read_text())
    except: return []

def save_session(entry):
    all_s = load_sessions()
    all_s.append(entry)
    SESSIONS_FILE.write_text(json.dumps(all_s, indent=2))
    log("save", f"сохранён: {entry['email']} (***{entry.get('api_key','')[-6:]})")

# ---- instanttempemail ----
ITE_BASE = "https://instanttempemail.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

import requests
def _ite_headers():
    return {"user-agent": UA, "accept": "application/json",
            "referer": f"{ITE_BASE}/", "origin": ITE_BASE}

def ite_create():
    r = requests.post(f"{ITE_BASE}/api/create", headers=_ite_headers(), timeout=20)
    d = r.json()
    return {"address": d["address"], "token": d["token"]}

def ite_inbox(token):
    r = requests.get(f"{ITE_BASE}/api/inbox/{token}", headers=_ite_headers(), timeout=20)
    d = r.json()
    return d.get("emails", []) if isinstance(d, dict) else []

def _flatten(obj, acc):
    if obj is None: return
    if isinstance(obj, str): acc.append(obj); return
    if isinstance(obj, (int, float, bool)): return
    if isinstance(obj, list):
        for v in obj: _flatten(v, acc)
        return
    if isinstance(obj, dict):
        for v in obj.values(): _flatten(v, acc)

def _email_text(em):
    acc = []; _flatten(em, acc)
    s = " \n ".join(acc)
    s = re.sub(r"<[^>]*>", " ", s)
    s = re.sub(r"&nbsp;|&amp;|&#x?\w+;", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def extract_otp6(text):
    if not text: return None
    cands = []
    for m in re.findall(r"(?<!\d)\d{6}(?!\d)", text):
        n = int(m)
        if n < 100000: continue
        if m.startswith("20") and 200000 <= n <= 209999: continue  # похоже на год
        cands.append(m)
    if not cands: return None
    kw = re.compile(r"(?:code|verification|otp|verify|код)", re.I)
    for c in cands:
        idx = text.find(c)
        if idx < 0: continue
        window = text[max(0, idx-80):idx+86]
        if kw.search(window): return c
    return cands[0]

def wait_for_otp(token, from_hint="ourtoken", timeout=90, poll=4, since_ts=None):
    """Опросить inbox до OTP. since_ts = unix-ts начала регистрации: письма старше
    since_ts игнорируются (иначе можем схватить кэшированный OTP от прошлого
    использования этого email-адреса в пуле instanttempemail)."""
    if since_ts is None: since_ts = time.time()
    # первый опрос ПОСЛЕ отправки формы — сначала запомним "стартовые" ID,
    # чтобы отсекать всё, что уже лежало в inbox на момент регистрации
    initial_ids = set()
    try:
        for em in ite_inbox(token):
            eid = em.get("id") or em.get("uid") or em.get("messageId") or json.dumps(em, sort_keys=True)[:80]
            initial_ids.add(str(eid))
        if initial_ids:
            log("mail", f"игнорирую {len(initial_ids)} прошлых письм(о/а) в inbox")
    except Exception:
        pass

    deadline = time.time() + timeout
    last = -1
    while time.time() < deadline:
        try:
            emails = ite_inbox(token)
        except Exception as e:
            log("mail", f"inbox error: {e}")
            time.sleep(poll); continue
        if len(emails) != last:
            log("mail", f"inbox: {len(emails)} писем")
            last = len(emails)
        for em in emails:
            eid = em.get("id") or em.get("uid") or em.get("messageId") or json.dumps(em, sort_keys=True)[:80]
            if str(eid) in initial_ids:
                continue   # это письмо было ещё ДО регистрации — не наше
            text = _email_text(em)
            if from_hint and from_hint.lower() not in text.lower():
                continue
            code = extract_otp6(text)
            if code:
                return code
        time.sleep(poll)
    return None

# ---- Turnstile handler ----
async def _token(page):
    try:
        t = await page.eval_on_selector('input[name="cf-turnstile-response"]', "el => el.value")
        return t if (t and len(t) > 10) else None
    except: return None

async def handle_turnstile(page):
    focus_browser_window()   # Turnstile не рендерится в фоне — держим окно впереди
    log("turnstile", "жму Turnstile...")
    for attempt in range(8):
        try:
            await page.click("iframe[src*='cloudflare'], iframe[src*='turnstile'], .cf-turnstile", timeout=3000)
        except:
            for f in page.frames:
                if "challenges.cloudflare.com" in f.url:
                    try: await f.click("body", position={"x": 30, "y": 30}, timeout=3000)
                    except Exception as e: log("turnstile", f"iframe err: {e}")
                    break
        await asyncio.sleep(1.5)
        t = await _token(page)
        if t:
            log("turnstile", f"✓ токен получен ({len(t)} символов)")
            return True
    log("turnstile", "токен не получен — продолжаю")
    return False

async def register_one(browser, email_address, email_token):
    name = gen_name()
    password = gen_pwd()
    log("reg", f"{name} <{email_address}>")

    page = browser.pages[0] if browser.pages else await browser.new_page()

    # Окно ДОЛЖНО быть на переднем плане: в фоне Firefox троттлит/крашит вкладку,
    # Turnstile не рендерится, навигация висит. Выводим окно вперёд.
    try:
        await page.bring_to_front()
    except Exception:
        pass
    focus_browser_window()

    # Свежее состояние: чистим куки прошлой почты/сессии (иначе "verification code is invalid")
    try:
        await browser.clear_cookies()
    except Exception:
        pass

    # 1. Форма регистрации — с ретраем (холодный профиль грузится медленно)
    for attempt in range(3):
        await page.goto(f"{BASE_URL}/login?mode=signup", wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_selector("#signup-name", state="visible", timeout=20000)
            break
        except Exception:
            log("reg", f"поле #signup-name не появилось (попытка {attempt+1}), релоад")
    else:
        log("reg", "форма регистрации не загрузилась")

    # 2. Fill form — РЕАЛЬНЫЙ ввод (клик+печать+blur), чтобы React провалидировал
    #    и разблокировал кнопку "Create Account".
    async def real_fill(sel, val):
        loc = page.locator(sel)
        await loc.wait_for(state="visible", timeout=8000)
        await loc.fill(val)             # fill сам ждёт редактируемости + шлёт input-события
        await loc.press("Tab")          # blur → триггерит валидацию поля
        await asyncio.sleep(0.15)

    await real_fill("#signup-name", name)
    await real_fill("#signup-email", email_address)
    await real_fill("#signup-password", password)
    log("reg", "поля заполнены (реальный ввод)")

    # Диагностика + РЕАЛЬНЫЙ клик по "Create Account".
    # Реальный .click() НЕ молчит: если кнопка disabled — бросит ошибку,
    # и мы наконец увидим настоящую причину.
    async def click_create_account(tag):
        # найти кнопку по тексту
        btn = page.get_by_role("button", name=re.compile(r"create account|continue with email", re.I))
        try:
            cnt = await btn.count()
        except Exception:
            cnt = 0
        if cnt == 0:
            # fallback на submit
            btn = page.locator('button[type="submit"]')
            try: cnt = await btn.count()
            except Exception: cnt = 0
        if cnt == 0:
            log("reg", f"{tag}: КНОПКА НЕ НАЙДЕНА")
            return False
        first = btn.first
        try:
            disabled = await first.is_disabled()
        except Exception:
            disabled = "?"
        log("reg", f"{tag}: найдено кнопок={cnt}, disabled={disabled}")
        try:
            await first.scroll_into_view_if_needed(timeout=3000)
            await first.click(timeout=6000)   # реальный клик мышью
            log("reg", f"{tag}: ✓ кликнуто (реальный клик)")
            return True
        except Exception as e:
            log("reg", f"{tag}: ✗ клик не прошёл: {type(e).__name__}: {str(e)[:120]}")
            # запасной вариант — force click сквозь оверлеи
            try:
                await first.click(timeout=3000, force=True)
                log("reg", f"{tag}: ✓ кликнуто (force)")
                return True
            except Exception as e2:
                log("reg", f"{tag}: ✗ force тоже не прошёл: {str(e2)[:120]}")
                return False

    # Правильный порядок (как описал пользователь):
    #   имя+email+пароль → Turnstile → "Create Account" → код с почты → код → "Create Account"

    # 3. Turnstile ДО сабмита
    await handle_turnstile(page)

    # 4. Click "Create Account" — на почту уходит код
    await click_create_account("сабмит (1-й, шлёт код)")

    # 5. Ждём 6-значный код с почты и вписываем
    log("reg", "жду код с почты…")
    code = wait_for_otp(email_token, from_hint="ourtoken", timeout=90)
    if code:
        log("reg", f"код получен: {code}")
        one = page.locator("#signup-verification-code")
        try:
            await one.wait_for(state="visible", timeout=15000)
        except Exception:
            log("reg", "поле кода не появилось за 15с")
        await one.click()
        await one.fill(code)
        await one.press("Tab")   # blur → React валидирует
        typed = await one.input_value()
        log("reg", f"код вписан: '{typed}'")
        # Turnstile-токен ОДНОРАЗОВЫЙ: 1-й сабмит его потратил. Чистим старый и пересолвим.
        try:
            await page.eval_on_selector('input[name="cf-turnstile-response"]', "el => el.value = ''")
        except Exception:
            pass
        await handle_turnstile(page)
        # 6. Сабмит: кнопка "Create Account" внизу за краем вьюпорта и часто не докликивается.
        #    Скроллим её в вид, кликаем; если не сработало — Enter в поле кода (нативный submit формы).
        btn = page.get_by_role("button", name=re.compile(r"create account", re.I)).first
        if await btn.count() == 0:
            btn = page.locator('button[type="submit"]').first
        try:
            await btn.scroll_into_view_if_needed(timeout=3000)
            await asyncio.sleep(0.3)
            await btn.click(timeout=6000)
            log("reg", "сабмит (2-й): ✓ клик по Create account")
        except Exception as e:
            log("reg", f"сабмит (2-й): клик не прошёл ({str(e)[:60]})")
        # проверяем — ушли ли со страницы; если нет, дожимаем Enter в поле кода
        await asyncio.sleep(1.5)
        if "/login" in page.url:
            log("reg", "сабмит (2-й): нет ухода → Enter в поле кода")
            try:
                await one.click()
                await one.press("Enter")
            except Exception:
                pass
        await asyncio.sleep(1)
    else:
        log("reg", "✗ код с почты не пришёл за 90с")

    # 7. Wait for redirect from /login
    for _ in range(30):
        await asyncio.sleep(1)
        cur = page.url
        if "/dashboard" in cur or "/api-keys" in cur or ("ourtoken.ai" in cur and "/login" not in cur):
            log("reg", f"редирект на {cur}")
            break
    else:
        log("reg", f"редиректа нет, текущий URL: {page.url}")

    # 7. Navigate to API keys
    cur = page.url
    if "/api-keys" not in cur:
        await page.goto(f"{BASE_URL}/api-keys", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2)
    log("reg", f"на странице API-keys")

    # 7. Click "Create" (реальный клик — откроет модалку или сразу выдаст ключ)
    async def click_by_text(pat):
        btn = page.get_by_role("button", name=re.compile(pat, re.I))
        if await btn.count() == 0:
            btn = page.locator("button, a").filter(has_text=re.compile(pat, re.I))
        if await btn.count() == 0:
            return False
        try:
            await btn.first.click(timeout=5000)
            return True
        except Exception:
            try: await btn.first.click(timeout=3000, force=True); return True
            except Exception: return False

    await click_by_text(r"create")
    await asyncio.sleep(1.5)

    # Если открылась модалка с полем имени + своей кнопкой Create — заполнить и подтвердить
    try:
        name_inp = page.locator('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')
        if await name_inp.count() > 0:
            await name_inp.first.fill(f"key-{random.randint(1000,9999)}")
            await asyncio.sleep(0.3)
            # submit внутри диалога
            dbtn = page.locator('[role="dialog"] button[type="submit"]')
            if await dbtn.count() == 0:
                dbtn = page.locator('[role="dialog"] button').filter(has_text=re.compile(r"create|generate|confirm", re.I))
            if await dbtn.count() > 0:
                await dbtn.first.click(timeout=5000)
                await asyncio.sleep(1.5)
    except Exception as e:
        log("reg", f"модалка: {e}")

    # 8. Extract API key — сначала из input/code (чистое значение), потом из текста
    api_key = None
    try:
        api_key = await page.evaluate("""() => {
            const dlg = document.querySelector('[role="dialog"]') || document.body;
            // 1) значение поля/кода — там ключ без мусора вроде "Copy"
            for (const el of dlg.querySelectorAll('input, textarea')) {
                const v = (el.value || '').trim();
                if (/^(sk-)?[A-Za-z0-9_-]{20,}$/.test(v)) return v;
            }
            for (const el of dlg.querySelectorAll('code, pre')) {
                const v = (el.textContent || '').trim();
                if (/^(sk-)?[A-Za-z0-9_-]{20,}$/.test(v)) return v;
            }
            return null;
        }""")
        if not api_key:
            # фолбэк: regex по тексту, но обрезаем прилипший "Copy"
            dialog_text = await page.evaluate("""() => {
                const dlg = document.querySelector('[role="dialog"]');
                return dlg ? dlg.textContent : document.body.textContent;
            }""")
            m = re.search(r'sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,}', dialog_text or '')
            if m:
                api_key = re.sub(r'Copy.*$', '', m.group(0))
        if api_key:
            log("reg", f"ключ: ***{api_key[-6:]} (len={len(api_key)})")
    except Exception as e:
        log("reg", f"ошибка извлечения ключа: {e}")

    if not api_key:
        # диагностика: что реально на странице
        try:
            dump = await page.evaluate("""() => {
                const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 20);
                const dlg = document.querySelector('[role="dialog"]');
                return JSON.stringify({url: location.href, buttons: btns, dialog: dlg ? dlg.textContent.slice(0,300) : null});
            }""")
            log("reg", f"DUMP: {dump}")
        except Exception: pass

    if api_key:
        save_session({
            "email": email_address,
            "name": name,
            "api_key": api_key,
            "active": False,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        })
    else:
        log("reg", "✗ ключ не получен")

    return api_key

async def main():
    count = max(1, int(sys.argv[1])) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 1
    log("main", f"ourToken.ai reg via CamoFox: {count} аккаунт(ов)")

    import tempfile, uuid
    profile_dir = Path(tempfile.gettempdir()) / f"camoufox-our-{uuid.uuid4().hex[:8]}"

    # Prefs против троттлинга фонового окна — чтобы Turnstile рендерился даже не в фокусе
    bg_prefs = {
        "widget.windows.window_occlusion_tracking.enabled": False,  # не пауза рендера перекрытого окна
        "dom.min_background_timeout_value": 4,                       # не тормозить фоновые таймеры
        "dom.timeout.enable_budget_timer_throttling": False,
        "media.suspend-bkgnd-video.enabled": False,
        "browser.tabs.unloadOnLowMemory": False,
    }

    async with AsyncCamoufox(
        headless=False,
        os="windows",
        window=(1280, 900),
        persistent_context=True,
        user_data_dir=str(profile_dir),
        disable_coop=True,
        humanize=8.0,
        main_world_eval=True,
        i_know_what_im_doing=True,
        firefox_user_prefs=bg_prefs,
    ) as browser:
        success = 0
        for i in range(count):
            log("main", f"--- {i+1}/{count} ---")
            try:
                email = ite_create()
                log("main", f"email: {email['address']}")
                key = await register_one(browser, email["address"], email["token"])
                if key: success += 1
            except Exception as e:
                log("err", str(e))
                import traceback; traceback.print_exc()
            if i < count - 1:
                await asyncio.sleep(2)

    log("main", f"Готово: {success}/{count} успешно")

if __name__ == "__main__":
    asyncio.run(main())
