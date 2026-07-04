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

def add_to_omniroute(email, api_key):
    """Добавить ourtoken-аккаунт в OmniRoute через прямой INSERT в БД контейнера
    (docker exec omniroute node - <email> <apiKey> <omniApiKey>)."""
    if not api_key:
        log("omniroute", "skip: нет api_key"); return
    import subprocess
    script = BASE_DIR.parent / "routing" / "add-to-omniroute.js"
    if not script.exists():
        script = BASE_DIR / "add-to-omniroute.js"
    if not script.exists():
        log("omniroute", f"скрипт не найден: {script}"); return
    # читаем OmniRoute API-ключ из .env (нужен для auto-test внутри контейнера)
    omni_key = ""
    env_file = BASE_DIR.parent / "routing" / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("OMNIROUTE_API_KEY="):
                omni_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    try:
        code = script.read_text(encoding="utf-8")
        r = subprocess.run(
            ["docker", "exec", "-i", "omniroute", "node", "-", email, api_key, omni_key],
            input=code, text=True, capture_output=True, timeout=30,
            encoding="utf-8", errors="replace",
        )
        out = (r.stdout or "").strip()
        err = (r.stderr or "").strip()
        if r.returncode == 0:
            try:
                data = json.loads(out.splitlines()[-1]) if out else {}
                action = data.get("action", "ok")
            except Exception:
                action = "ok"
            log("omniroute", f"{email} → {action}")
        else:
            log("omniroute", f"FAIL: {err or out}")
    except Exception as e:
        log("omniroute", f"error: {e}")

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

def ite_create(retries=3):
    for attempt in range(retries):
        try:
            r = requests.post(f"{ITE_BASE}/api/create", headers=_ite_headers(), timeout=20)
            d = r.json()
            return {"address": d["address"], "token": d["token"]}
        except Exception as e:
            log("mail", f"ite_create attempt {attempt+1}/{retries}: {e}")
            if attempt < retries - 1:
                time.sleep(3)
    raise RuntimeError("instanttempemail.com недоступен после 3 попыток")

def ite_inbox(token, retries=2):
    for attempt in range(retries):
        try:
            r = requests.get(f"{ITE_BASE}/api/inbox/{token}", headers=_ite_headers(), timeout=20)
            d = r.json()
            return d.get("emails", []) if isinstance(d, dict) else []
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2)
            else:
                raise e

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
    """Extract 6-digit OTP from email text. Prefer code near 'verification' keyword."""
    if not text: return None
    # 1) "verification code ... 123456" — ищем код после этой фразы
    m = re.search(r'verification\s*code[\s\S]{0,120}?(\d{6})', text, re.I)
    if m: return m.group(1)
    # 2) Фолбэк: любое 6-значное рядом с ключевыми словами
    cands = []
    for m in re.findall(r"(?<!\d)\d{6}(?!\d)", text):
        n = int(m)
        if n < 100000: continue
        if m.startswith("20") and 200000 <= n <= 209999: continue
        cands.append(m)
    if not cands: return None
    kw = re.compile(r"(?:code|verification|otp|verify|код)", re.I)
    for c in cands:
        idx = text.find(c)
        if idx < 0: continue
        if kw.search(text[max(0, idx-80):idx+86]):
            return c
    return cands[0]

def wait_for_otp(token, timeout=90, poll=4):
    """Ждём OTP в inbox. Берём код из САМОГО ПОСЛЕДНЕГО письма.
    baseline-счётчики ненадёжны — порядок писем в API непредсказуем."""
    deadline = time.time() + timeout
    last_count = -1
    while time.time() < deadline:
        try:
            emails = ite_inbox(token)
        except Exception as e:
            log("mail", f"inbox error: {e}")
            time.sleep(poll); continue
        if len(emails) != last_count:
            log("mail", f"inbox: {len(emails)} писем")
            last_count = len(emails)
        if not emails:
            time.sleep(poll); continue
        # самое свежее письмо — всегда последнее в ответе API
        text = _email_text(emails[-1])
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
    # ponytail: focus_browser_window() сворачивал активное окно пользователя — убрали   # Turnstile не рендерится в фоне — держим окно впереди
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
    # ponytail: focus_browser_window() сворачивал активное окно пользователя — убрали

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
        await loc.click()
        await loc.clear()
        await page.keyboard.type(val, delay=random.randint(30, 80))
        await loc.press("Tab")
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

    # 5. Ждём OTP — берём из последнего письма в inbox
    log("reg", "жду код с почты…")
    code = wait_for_otp(email_token, timeout=90)
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
        # НЕ пересолвиваем Turnstile — токен ещё живой от 1-го шага.
        # Пересолв занимает 12+ секунд → OTP протухает → "Verification code is invalid".
        # Сразу жмём "Create account".
        await asyncio.sleep(0.3)
        btn = page.get_by_role("button", name=re.compile(r"create account", re.I)).first
        if await btn.count() == 0:
            btn = page.locator('button[type="submit"]').first
        try:
            await btn.scroll_into_view_if_needed(timeout=3000)
            await asyncio.sleep(0.2)
            await btn.click(timeout=6000)
            log("reg", "сабмит (2-й): ✓ клик по Create account")
        except Exception as e:
            log("reg", f"сабмит (2-й): клик не прошёл ({str(e)[:60]})")
        await asyncio.sleep(1.5)
        if "/login" in page.url:
            # Проверяем есть ли ошибка на форме
            try:
                err = await page.evaluate("""() => {
                    // Only texts that look like actual form validation errors
                    const ERROR_LIKE = /(invalid|incorrect|already|taken|exist|wrong|expired|try again|required|must|should|failed|denied|blocked|limit|verify|confirm|check|enter|provide|valid)/i;
                    const NOT_ERROR = /(google|github|apple|facebook|microsoft|twitter|discord|continue with|sign in with|log in with|or continue|english|language|EN\b|ru\b|something went wrong)/i;
                    for (const el of document.querySelectorAll('[role="alert"], [class*="error"], [class*="Error"], [class*="invalid"], .text-red-500, .text-red-600, [class*="danger"]')) {
                        const txt = el.textContent.trim();
                        if (txt && txt.length > 3 && txt.length < 200 && ERROR_LIKE.test(txt) && !NOT_ERROR.test(txt)) return txt;
                    }
                    return null;
                }""")
                if err:
                    log("reg", f"сабмит (2-й): ОШИБКА НА ФОРМЕ: {err}")
                    return None  # выходим — регистрация не прошла
            except Exception:
                pass
            log("reg", "сабмит (2-й): нет ухода → Enter в поле кода")
            try:
                await one.click()
                await one.press("Enter")
            except Exception:
                pass
        await asyncio.sleep(1)
    else:
        log("reg", "✗ код с почты не пришёл за 90с")

    # 7. Wait for redirect from /login (таймаут 15с — не 30)
    log("reg", "жду редирект из /login...")
    redirected = False
    for i in range(15):
        await asyncio.sleep(1)
        cur = page.url
        # Успех: ушли с /login
        if "/login" not in cur and "ourtoken.ai" in cur:
            log("reg", f"✓ редирект на {cur}")
            redirected = True
            break

    if not redirected:
        log("reg", f"✗ редиректа нет — текущий URL: {page.url}")
        # Проверяем ошибку на форме (если ещё на /login)
        if "/login" in page.url:
            try:
                err = await page.evaluate("""() => {
                    const ERROR_LIKE = /(invalid|incorrect|already|taken|exist|wrong|expired|try again|required|must|should|failed|denied|blocked|limit|verify|confirm|check|enter|provide|valid)/i;
                    const NOT_ERROR = /(google|github|apple|facebook|microsoft|twitter|discord|continue with|sign in with|log in with|or continue|english|language|EN\b|ru\b|something went wrong)/i;
                    for (const el of document.querySelectorAll('[role="alert"], [class*="error"], [class*="Error"], [class*="invalid"], .text-red-500, .text-red-600, [class*="danger"]')) {
                        const txt = el.textContent.trim();
                        if (txt && txt.length > 3 && txt.length < 200 && ERROR_LIKE.test(txt) && !NOT_ERROR.test(txt)) return txt;
                    }
                    return null;
                }""")
                if err:
                    log("reg", f"ОШИБКА НА ФОРМЕ: {err}")
            except Exception:
                pass
        return None  # не регистрировался — выходим

    # 7.1. Переход на /api-keys
    if "/api-keys" not in page.url:
        log("reg", f"переход на /api-keys...")
        await page.goto(f"{BASE_URL}/api-keys", wait_until="domcontentloaded", timeout=30000)
        log("reg", f"URL после перехода: {page.url}")
        # Если снова кинуло на /login — сессия не создалась
        if "/login" in page.url:
            log("reg", "✗ кинуло на /login — сессия не создалась")
            return None

    await asyncio.sleep(2)  # ждём рендер страницы

    # Диагностика: какие кнопки/ссылки есть на странице
    try:
        all_btns = await page.evaluate("""() => {
            return [...document.querySelectorAll('button, a')]
                .map(b => ({tag: b.tagName, text: b.textContent.trim().slice(0, 50), visible: b.offsetParent !== null}))
                .filter(b => b.text)
                .slice(0, 30);
        }""")
        log("reg", f"кнопки на /api-keys: {[(b['tag'], b['text']) for b in all_btns[:15]]}")
    except Exception as e:
        log("reg", f"не удалось получить список кнопок: {e}")

    # Ждём пока появится кнопка Create (страница рендерится через JS)
    # Пробуем несколько вариантов локатора
    create_btn = None
    for pattern in [r"create", r"generate", r"new.*key", r"add.*key"]:
        btn = page.locator("button, a").filter(has_text=re.compile(pattern, re.I)).first
        try:
            await btn.wait_for(state="visible", timeout=3000)
            create_btn = btn
            log("reg", f"нашёл кнопку по паттерну '{pattern}'")
            break
        except Exception:
            continue

    if not create_btn:
        log("reg", "кнопка Create/Generate не найдена — возможно ключ уже есть")

    # 8. Click "Create" → модалка (если кнопка найдена)
    if create_btn:
        try:
            await create_btn.scroll_into_view_if_needed(timeout=2000)
            await create_btn.click(timeout=5000)
            log("reg", "кликнул Create")
            await asyncio.sleep(1.5)
        except Exception as e:
            log("reg", f"Create клик не прошёл: {str(e)[:80]}")
    else:
        await asyncio.sleep(1)

    # 9. Если открылась модалка с полем имени — заполнить и подтвердить
    try:
        dlg = page.locator('[role="dialog"]')
        if await dlg.count() > 0:
            log("reg", "модалка открылась")
            name_inp = dlg.locator('input[type="text"], input:not([type])')
            if await name_inp.count() > 0:
                await name_inp.first.fill(f"key-{random.randint(1000,9999)}")
                await asyncio.sleep(0.3)
            dbtn = dlg.locator('button[type="submit"]')
            if await dbtn.count() == 0:
                dbtn = dlg.locator('button').filter(has_text=re.compile(r"create|generate|confirm|submit", re.I))
            if await dbtn.count() > 0:
                await dbtn.first.click(timeout=5000)
                log("reg", "подтвердил модалку")
                await asyncio.sleep(2)
        else:
            log("reg", "модалки нет — ключ может появиться сразу")
    except Exception as e:
        log("reg", f"модалка: {e}")

    # 10. Extract API key
    api_key = None

    def is_valid_key(v):
        """Проверка что это реальный API-ключ, а не мусор со страницы."""
        if not v or len(v) < 30:
            return False
        # не должен содержать названия моделей/сервисов
        bad_words = ["anthropic", "claude", "openai", "gpt", "gemini", "glm", "llama", "mistral"]
        if any(bw in v.lower() for bw in bad_words):
            return False
        # должен быть base64-подобной строкой (буквы+цифры+_-)
        if not re.match(r'^[A-Za-z0-9_-]{30,}$', v):
            return False
        return True

    for attempt in range(5):
        try:
            api_key = await page.evaluate("""() => {
                const scope = document.querySelector('[role="dialog"]') || document.body;
                // Приоритет: input/textarea в модалке
                const dlg = document.querySelector('[role="dialog"]');
                if (dlg) {
                    for (const el of dlg.querySelectorAll('input, textarea')) {
                        const v = (el.value || '').trim();
                        if (v.length >= 30 && /^[A-Za-z0-9_-]+$/.test(v)) return v;
                    }
                    for (const el of dlg.querySelectorAll('code, pre, [class*="key"], [class*="mono"]')) {
                        const v = (el.textContent || '').trim();
                        if (v.length >= 30 && /^[A-Za-z0-9_-]+$/.test(v)) return v;
                    }
                }
                // Фолбэк: весь документ, но только короткие строки (не абзацы)
                for (const el of document.querySelectorAll('input[readonly], textarea[readonly]')) {
                    const v = (el.value || '').trim();
                    if (v.length >= 30 && v.length <= 100 && /^[A-Za-z0-9_-]+$/.test(v)) return v;
                }
                return null;
            }""")
        except Exception: pass
        if api_key and is_valid_key(api_key):
            break
        api_key = None  # сбрасываем невалидный
        await asyncio.sleep(1)

    if api_key:
        log("reg", f"ключ: ***{api_key[-6:]} (len={len(api_key)})")
    else:
        log("reg", "ключ не найден")

    if not api_key:
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
        add_to_omniroute(email_address, api_key)
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
                log("main", "создаю temp-email…")
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
