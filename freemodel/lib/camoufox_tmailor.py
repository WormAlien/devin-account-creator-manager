"""freemodel/lib/camoufox_tmailor.py
Camoufox (Firefox stealth) клиент для tmailor.com.
Протокол: JSON-lines через stdin/stdout.
Команды:
  {"cmd":"create"}                -> {"ok":true, "email":..., "accesstoken":...}
  {"cmd":"regenerate"}            -> {"ok":true, "email":..., "accesstoken":...}
  {"cmd":"wait_otp", "timeout":120, "poll":4, "from_hint":"freemodel"} -> {"ok":true, "code":"123456", "link":...} | {"ok":false, "error":"timeout"}
  {"cmd":"stop"}                  -> завершает процесс
"""
import asyncio, json, os, re, shutil, sys, time, traceback
from pathlib import Path

from camoufox import AsyncCamoufox

BASE_URL = "https://tmailor.com"
API_URL = "https://tmailor.com/api"

PROFILE_DIR = Path(__file__).parent / f"camoufox_tmailor_profile_{os.getpid()}"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)

# Профиль свой на каждый запуск и до 21.08.2026 не убирался никогда: накопилось
# 580 каталогов на 37.4 ГБ — 82% веса всего репо. Подметаем по mtime, а НЕ по
# живости PID: Windows переиспользует номера (2 из 580 мёртвых профилей совпали
# с чужими живыми python.exe), а os.kill(pid, 0) здесь зовёт TerminateProcess.
# 6 часов — с большим запасом дольше любого прогона, который длится минуты.
for _stale in PROFILE_DIR.parent.glob("camoufox_tmailor_profile_*"):
    try:
        if _stale != PROFILE_DIR and _stale.is_dir() and _stale.stat().st_mtime < time.time() - 6 * 3600:
            shutil.rmtree(_stale, ignore_errors=True)
    except OSError:
        pass


def log(tag: str, msg: str):
    t = time.strftime("%H:%M:%S")
    line = f"[{t}] [{tag}] {msg}"
    try:
        print(line, flush=True, file=sys.stderr)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode(), flush=True, file=sys.stderr)


def out(obj: dict):
    try:
        print(json.dumps(obj, ensure_ascii=False), flush=True, file=sys.stdout)
    except UnicodeEncodeError:
        # cp1251-консоль (Windows без utf-8 stdout): не-ASCII символ в error-тексте
        # роняет сам print, и Node не получает даже {"ok":false} — процесс умирает
        # с UnicodeEncodeError вместо ответа. ASCII-эскейпы JSON парсит одинаково.
        print(json.dumps(obj, ensure_ascii=True), flush=True, file=sys.stdout)


def _flatten_strings(obj, acc=None):
    if acc is None:
        acc = []
    if obj is None:
        return acc
    if isinstance(obj, str):
        acc.append(obj)
        return acc
    if isinstance(obj, (int, float, bool)):
        return acc
    if isinstance(obj, list):
        for v in obj:
            _flatten_strings(v, acc)
        return acc
    if isinstance(obj, dict):
        for v in obj.values():
            _flatten_strings(v, acc)
        return acc
    return acc


def _strip_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", str(s).replace("&nbsp;", " ").replace("&amp;", "&"))).strip()


def email_to_text(email):
    return _strip_html(" ".join(_flatten_strings(email)))


def extract_otp(text):
    if not text:
        return None
    codes = re.findall(r"(?<!\d)\d{6}(?!\d)", text)
    candidates = []
    for c in codes:
        n = int(c)
        if n < 100000:
            continue
        if c.startswith("20") and 200000 <= n <= 209999:
            continue
        candidates.append(c)
    if not candidates:
        return None
    kw = re.compile(r"(?:code|verification|otp|verify|token|confirm|код|пин)", re.I)
    for c in candidates:
        idx = text.find(c)
        if idx < 0:
            continue
        window = text[max(0, idx - 80):idx + 86]
        if kw.search(window):
            return c
    return candidates[0]


def extract_magic_link(text):
    if not text:
        return None
    m = re.search(r"https?://(?:www\.)?freemodel\.dev/[^\s\"'<>]+", text, re.I)
    return m.group(0) if m else None


SERVER_ERROR_PATTERNS = [
    "an error occurred on the server",
    "please try again later",
    "server error",
    "internal server error",
    "service unavailable",
    "gateway timeout",
    "bad gateway",
]


def _is_server_error_api(result):
    if not result or not isinstance(result, dict):
        return False
    msg = str(result.get("msg", "") or result.get("error", "") or result.get("message", ""))
    msg_lower = msg.lower()
    return any(p in msg_lower for p in SERVER_ERROR_PATTERNS)


async def _is_server_error_page(page):
    try:
        body = await page.evaluate("() => document.body?.innerText || ''")
        body_lower = body.lower()
        return any(p in body_lower for p in SERVER_ERROR_PATTERNS)
    except Exception:
        return False


async def _safe_fetch_json(page, api_url, body_data):
    """Fetch API и возвращает JSON, но не падает если ответ не JSON (HTML-страница с ошибкой)."""
    return await page.evaluate(
        """async ({ apiUrl, bodyData }) => {
            try {
                const res = await fetch(apiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify(bodyData),
                });
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch (e) {
                    return { _fetchError: true, _status: res.status, _text: text.slice(0, 500) };
                }
            } catch (e) {
                return { _fetchError: true, _message: e.message };
            }
        }""",
        {"apiUrl": api_url, "bodyData": body_data},
    )


# Реальный endpoint создания email (не общий /api).
WEBAPP_API_URL = "https://tmailor.com/api/webapp-newemail"


async def _get_turnstile_token(page, timeout=15):
    """Ждёт cf-turnstile-response токен на странице. Camoufox обычно решает
    Cloudflare Turnstile сам за ~5с (fingerprint), токен появляется в скрытом input.
    Возвращает строку токена или '' если не появился."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            tok = await page.eval_on_selector(
                'input[name="cf-turnstile-response"]', "el => el.value"
            )
        except Exception:
            tok = ""
        if tok and len(tok) > 20:
            return tok
        await asyncio.sleep(0.5)
    return ""


async def _request_new_email(page, wait_token_timeout=30):
    """Правильный флоу создания email (актуальный API tmailor 2026):
    1) взять turnstile-токен; если его нет — АКТИВНО решить капчу (клик мышью);
    2) POST webapp-newemail с cf_turnstile_response + choose_domain:"1".
    Возвращает dict ответа сервера (или None)."""
    # Быстрая проверка: токен уже есть? (2с, не ждём долго — Turnstile сам не решается)
    token = await _get_turnstile_token(page, timeout=2)
    if not token:
        # Токена нет → капча ждёт клика. Решаем АКТИВНО мышью, без ожидания.
        log("email", "токена нет — решаю капчу кликом мыши")
        token = await _auto_solve_turnstile(page, timeout=min(wait_token_timeout + 30, 60))
    if not token:
        log("email", "turnstile-токен получить не удалось")
        return None
    log("email", f"turnstile-токен получен ({len(token)} симв), шлю newemail")
    result = await _safe_fetch_json(page, WEBAPP_API_URL, {
        "action": "newemail",
        "curentToken": "",
        "choose_domain": "1",
        "cf_turnstile_response": token,
    })
    if isinstance(result, dict) and result.get("_fetchError"):
        log("email", f"newemail fetch error: {result.get('_text') or result.get('_message')}")
        return None
    return result


async def create_email(page):
    log("email", "открываю tmailor.com...")

    captured = {}

    async def on_response(res):
        try:
            url = res.url
            if not url.startswith(API_URL.rstrip("/")):
                return
            method = res.request.method if res.request else "GET"
            if method.upper() != "POST":
                return
            body = await res.json()
            if body and body.get("msg") == "ok" and body.get("email") and body.get("accesstoken"):
                captured["email"] = body["email"]
                captured["accesstoken"] = body["accesstoken"]
                log("email", f"перехвачен из API response ({url}): {body['email']}")
        except Exception:
            pass

    page.on("response", lambda res: asyncio.create_task(on_response(res)))

    for page_attempt in range(1, 4):
        log("email", f"загрузка страницы (попытка {page_attempt}/3)...")
        await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(2)

        # tmailor САМ создаёт email при загрузке страницы — просто ждём его ответ.
        # Никакой капчи для первого адреса не нужно.
        early_deadline = time.time() + 20
        while time.time() < early_deadline:
            if captured.get("email") and captured.get("accesstoken"):
                log("email", f"email готов при загрузке: {captured['email']}")
                return {"email": captured["email"], "accesstoken": captured["accesstoken"]}
            await asyncio.sleep(0.3)

        # ОСНОВНОЙ ПУТЬ (актуальный API 2026): дождаться turnstile-токена и послать
        # newemail с cf_turnstile_response + choose_domain. Camoufox решает CF сам.
        result = await _request_new_email(page, wait_token_timeout=30)
        if result and result.get("msg") == "ok" and result.get("email") and result.get("accesstoken"):
            log("email", f"email создан: {result['email']}")
            return {"email": result["email"], "accesstoken": result["accesstoken"]}

        # Проверяем — не перехватили ли ответ через listener параллельно.
        if captured.get("email") and captured.get("accesstoken"):
            return {"email": captured["email"], "accesstoken": captured["accesstoken"]}

        # Серверная ошибка tmailor — перезагрузка и повтор.
        if _is_server_error_api(result) or await _is_server_error_page(page):
            log("email", f"tmailor серверная ошибка (попытка {page_attempt}/3), перезагружаю...")
            await asyncio.sleep(2)
            continue

        log("email", f"api result: {json.dumps(result, ensure_ascii=False) if result else 'None'}")

        # errorcaptcha/client-block: токен не получен (Camoufox не решил CF) —
        # даём пройти капчу вручную, потом снова шлём newemail с токеном.
        is_block = bool(
            result
            and (
                result.get("msg") == "errorcaptcha"
                or result.get("captcha") == 1
                or result.get("client-block") == 1
            )
        )
        if is_block or result is None:
            log("email", "create: нужен turnstile-токен — переключаюсь на ручное прохождение капчи")
            return await _manual_captcha_recover(page)

    # Все попытки исчерпаны
    raise Exception("tmailor.com не дал создать email после 3 попыток (возможно, Camoufox детектится)")



async def regenerate_email(page):
    # Токен Turnstile ОДНОРАЗОВЫЙ: после создания первого email он сгорает,
    # поэтому для регенерации сразу проходим капчу заново и жмём Create.
    return await _manual_captcha_recover(page)


async def _human_click(page, x, y, label=""):
    """Мгновенный прямой клик мышью: сразу в точку и нажатие."""
    await page.mouse.move(x, y)
    await asyncio.sleep(0.02)
    await page.mouse.down()
    await asyncio.sleep(0.03)
    await page.mouse.up()
    log("captcha", f"клик мышью [{label}] ({round(x)},{round(y)})")


async def _cf_widget_box(page):
    """bbox отрисованного Turnstile-виджета (или None)."""
    try:
        return await page.evaluate(
            """() => { const el=document.querySelector('.cf-turnstile'); if(!el) return null;
               const r=el.getBoundingClientRect();
               return r.width>0 && r.height>0 ? {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)} : null; }"""
        )
    except Exception:
        return None


FIND_VERIFY_JS = """
() => {
  const RE = /not a robot|verify that you|подтвердите|не робот|я не робот|verify you are human|подтвердите, что вы человек/i;
  const els = Array.from(document.querySelectorAll('button,div,span,a,p,label'));
  const cand = els.filter(x => {
    const r = x.getBoundingClientRect();
    if (r.width < 60 || r.height < 12 || r.height > 120) return false;
    if (x.offsetParent === null) return false;   // невидимый
    const txt = (x.textContent || '');
    if (!RE.test(txt)) return false;
    // отбрасываем контейнеры, у которых слишком много текста (значит это родитель)
    return txt.trim().length < 120;
  }).sort((a,b) => {
    const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height) - (rb.width*rb.height);   // самый маленький = сама плашка
  });
  const b = cand[0];
  if (!b) return null;
  b.scrollIntoView({block:'center'});
  const r = b.getBoundingClientRect();
  return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
          box:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
          text:(b.textContent||'').trim().slice(0,60)};
}
"""


async def _click_verify_trigger(page, retries=6, delay=0.3):
    """Красная плашка 'Please verify that you are not a robot' — триггер показа
    Turnstile. На свежей странице она появляется НЕ СРАЗУ, поэтому ищем с ретраями."""
    for attempt in range(1, retries + 1):
        try:
            info = await page.evaluate(FIND_VERIFY_JS)
        except Exception as e:
            log("captcha", f"verify-trigger err: {e}")
            info = None

        if info:
            log("captcha", f"нашёл кнопку 'не робот' {info.get('box')} «{info.get('text')}» — жму")
            await _human_click(page, info["x"], info["y"], "verify-not-a-robot")
            return True

        # виджет мог отрисоваться и без плашки — тогда триггер не нужен
        if await _cf_widget_box(page):
            log("captcha", "виджет уже отрисован, плашка не нужна")
            return True

        if attempt == 1 or attempt % 3 == 0:
            log("captcha", f"жду появления кнопки 'не робот' ({attempt}/{retries})")
        await asyncio.sleep(delay)

    log("captcha", "кнопка 'не робот' не найдена")
    return False


async def _click_create_button(page):
    """Жмём кнопку Create в модалке (после прохождения капчи)."""
    try:
        info = await page.evaluate(
            """() => {
              const b = Array.from(document.querySelectorAll('button')).find(x => {
                const r = x.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && /^\\s*create\\s*$/i.test((x.textContent||'').trim());
              });
              if (!b) return null;
              b.scrollIntoView({block:'center'});
              const r = b.getBoundingClientRect();
              return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)};
            }"""
        )
    except Exception as e:
        log("captcha", f"create-btn err: {e}")
        return False
    if not info:
        log("captcha", "кнопка Create не найдена")
        return False
    await _human_click(page, info["x"], info["y"], "Create")
    return True


async def _auto_solve_turnstile(page, timeout=30, reset_token=True):
    """АВТО-прохождение Turnstile: жмём красный триггер, ждём рендер виджета,
    кликаем мышью по чекбоксу (левая часть, x+30, центр по высоте), ждём токен.
    Возвращает токен или None. Никаких MessageBox — всё само."""
    # ВАЖНО: токен Turnstile ОДНОРАЗОВЫЙ. После создания email в input остаётся
    # сгоревший токен — если его не сбросить, мы примем его за валидный,
    # получим errorcaptcha и потеряем ~25с на лишний круг капчи.
    if reset_token:
        try:
            await page.evaluate(
                """() => { const el=document.querySelector('input[name="cf-turnstile-response"]');
                   if (el) el.value = '';
                   if (window.turnstile && window.turnstile.reset) { try { window.turnstile.reset(); } catch(e){} } }"""
            )
        except Exception:
            pass

    # 1) триггерим показ виджета (один раз — достаточно, чтобы Turnstile
    #    инициализировался). Повторные клики по плашке «не робот» только
    #    сбрасывают виджет и залипают в цикле.
    await _click_verify_trigger(page)

    deadline = time.time() + timeout
    clicked = False
    last_trigger = time.time()  # момент последнего клика на триггер
    trigger_count = 1           # уже кликнули один раз на входе
    while time.time() < deadline:
        tok = await _get_turnstile_token(page, timeout=1)
        if tok:
            log("captcha", f"turnstile решён, токен {len(tok)} симв")
            return tok

        box = await _cf_widget_box(page)
        if box and not clicked:
            try:
                await page.evaluate(
                    "() => { const el=document.querySelector('.cf-turnstile'); if(el) el.scrollIntoView({block:'center'}); }"
                )
            except Exception:
                pass
            await asyncio.sleep(0.2)
            box = await _cf_widget_box(page)
            if box:
                cx = box["x"] + 30                 # чекбокс слева
                cy = box["y"] + box["h"] / 2
                log("captcha", f"виджет найден {box}, кликаю чекбокс ({cx},{round(cy)})")
                await _human_click(page, cx, cy, "turnstile-checkbox")
                clicked = True
                await asyncio.sleep(0.5)
        elif not box and not clicked:
            # Виджет не появился — даём ему шанс инициализироваться, но
            # НЕ кликаем триггер снова через 3с после первого. Ретриггер
            # только если вообще виджет НИКОГДА не рендерился (10с пауза).
            now = time.time()
            if trigger_count < 2 and now - last_trigger >= 10.0:
                last_trigger = now
                trigger_count += 1
                log("captcha", "виджет не появился через 10с — пробую триггер ещё раз")
                await _click_verify_trigger(page)

        await asyncio.sleep(0.3)

    log("captcha", "turnstile не решён за отведённое время (триггер был нажат один раз, виджет не появился)")
    return None



async def _click_new_email_button(page, retries=10, delay=0.5):
    """Нажимаем кнопку 'New Email' в UI tmailor — открывает модалку создания.
    Без этого клика скрипт копирует уже существующий email вместо создания нового."""
    RE = r"new\s*e-?mail|create\s*e-?mail"
    for attempt in range(1, retries + 1):
        try:
            clicked = await page.evaluate(
                """async (reStr) => {
                   const RE = new RegExp(reStr, 'i');
                   const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                   const b = btns.find(x => {
                     const r = x.getBoundingClientRect();
                     return r.width > 0 && r.height > 0 && RE.test((x.textContent||'').trim());
                   });
                   if (!b) return false;
                   b.scrollIntoView({block:'center'});
                   const r = b.getBoundingClientRect();
                   const cx = r.x + r.width/2, cy = r.y + r.height/2;
                   const hit = document.elementFromPoint(cx, cy);
                   (hit || b).click();
                   return true;
                 }""",
                RE,
            )
            if clicked:
                log("email", "нажата кнопка New Email — модалка создания открыта")
                return True
        except Exception as e:
            log("email", f"new-email-btn err: {e}")

        if attempt == 1 or attempt % 3 == 0:
            log("email", f"ищу кнопку 'New Email' ({attempt}/{retries})")
        await asyncio.sleep(delay)
    log("email", "кнопка 'New Email' не найдена")
    return False


async def _manual_captcha_recover(page, poll_timeout=60, poll=2):
    """АВТО-прохождение капчи (имя оставлено для совместимости вызовов).
    Скрипт сам: нажимает New Email -> жмёт красный триггер 'not a robot' ->
    кликает чекбокс Turnstile -> получает токен -> создаёт email.
    Никаких всплывающих окон и участия пользователя."""
    if page.is_closed():
        raise Exception("окно Camoufox закрыто — прервано пользователем")

    log("captcha", "капча — прохожу автоматически (клик по чекбоксу Turnstile)")

    attempts = 3
    for attempt in range(1, attempts + 1):
        if page.is_closed():
            raise Exception("окно Camoufox закрыто — прервано пользователем")

        # Ловим email из ответа сервера на нажатие Create.
        got = {}

        async def _catch(res):
            try:
                if "webapp-newemail" not in res.url:
                    return
                b = await res.json()
                if b and b.get("msg") == "ok" and b.get("email") and b.get("accesstoken"):
                    got["email"] = b["email"]
                    got["accesstoken"] = b["accesstoken"]
            except Exception:
                pass

        handler = lambda res: asyncio.create_task(_catch(res))
        page.on("response", handler)
        try:
            # Сначала ЖМЁМ "New Email" — открывает модалку создания с капчей.
            # Без этого скрипт копирует уже существующий email вместо создания нового.
            if not await _click_new_email_button(page, retries=12, delay=0.5):
                if got.get("email"):
                    log("captcha", f"email пришёл из API пока искали кнопку: {got['email']}")
                    return {"email": got["email"], "accesstoken": got["accesstoken"]}
                log("captcha", f"попытка {attempt}/{attempts}: кнопка New Email не найдена")
                await asyncio.sleep(1)
                continue

            # В модалке капчи нет — сразу жмём Create. Turnstile появляется
            # только если сервер ответит errorcaptcha.
            await asyncio.sleep(0.6)   # модалка дорисовывается
            if await _click_create_button(page):
                for _ in range(15):
                    if got.get("email"):
                        log("captcha", f"email создан кликом Create: {got['email']}")
                        return {"email": got["email"], "accesstoken": got["accesstoken"]}
                    await asyncio.sleep(0.4)

            # Create не дал email — значит нужен turnstile-токен.
            tok = await _auto_solve_turnstile(page, timeout=30)
            if got.get("email"):
                log("captcha", f"email пришёл из API: {got['email']}")
                return {"email": got["email"], "accesstoken": got["accesstoken"]}
            if not tok:
                log("captcha", f"попытка {attempt}/{attempts}: токен не получен")
            else:
                if await _click_create_button(page):
                    for _ in range(10):
                        if got.get("email"):
                            log("captcha", f"email создан после капчи: {got['email']}")
                            return {"email": got["email"], "accesstoken": got["accesstoken"]}
                        await asyncio.sleep(0.4)

                # Если Create ничего не дал — пробуем API с этим токеном.
                r = await _safe_fetch_json(page, WEBAPP_API_URL, {
                    "action": "newemail",
                    "curentToken": "",
                    "choose_domain": "1",
                    "cf_turnstile_response": tok,
                })
                if isinstance(r, dict) and r.get("msg") == "ok" and r.get("email") and r.get("accesstoken"):
                    log("captcha", f"капча пройдена, email: {r['email']}")
                    return {"email": r["email"], "accesstoken": r["accesstoken"]}
                if got.get("email"):
                    return {"email": got["email"], "accesstoken": got["accesstoken"]}
                log("captcha", f"попытка {attempt}/{attempts}: ответ {(r or {}).get('msg')}")
        finally:
            try:
                page.remove_listener("response", handler)
            except Exception:
                pass

    raise Exception("captcha: автопрохождение не удалось за 3 попытки")



async def fetch_inbox(page, email, accesstoken):
    return await _safe_fetch_json(
        page, API_URL,
        {"action": "listinbox", "listToken": {email: accesstoken}},
    )


async def fetch_email_body(page, email, accesstoken, email_code, email_token):
    return await _safe_fetch_json(
        page, API_URL,
        {"action": "read", "accesstoken": accesstoken, "email_code": email_code, "email_token": email_token},
    )


async def _ensure_page_alive(page):
    """tmailor иногда закрывает вкладку (Target page closed). Тогда fetch изнутри
    страницы падает. Переоткрываем tmailor.com на том же page, чтобы credentials
    (cookies) и fetch снова работали."""
    try:
        if page.is_closed():
            return False  # сам объект page закрыт — восстановить нельзя
        # cheap-пинг: если контекст жив, evaluate вернёт значение
        await page.evaluate("() => 1")
        return True
    except Exception:
        # страница/контекст в непригодном состоянии — пробуем перезагрузить
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(2)
            log("inbox", "страница восстановлена (reload tmailor.com)")
            return True
        except Exception as e:
            log("inbox", f"не смог восстановить страницу: {e}")
            return False


async def wait_for_otp(page, email, accesstoken, timeout=120, poll=4, from_hint="freemodel"):
    deadline = time.time() + timeout
    seen_ids = set()
    while time.time() < deadline:
        if not await _ensure_page_alive(page):
            log("inbox", "страница мертва, жду и пробую снова")
            await asyncio.sleep(poll)
            continue
        try:
            result = await fetch_inbox(page, email, accesstoken)
        except Exception as e:
            log("inbox", f"ошибка запроса: {e}")
            await asyncio.sleep(poll)
            continue

        if not result or result.get("msg") != "ok":
            log("inbox", f"API msg={result.get('msg') if result else 'no-result'}")
            await asyncio.sleep(poll)
            continue

        email_data = (result.get("data") or {}).get(email)
        if not email_data or email_data.get("dead"):
            await asyncio.sleep(poll)
            continue

        emails = email_data.get("data") or {}
        new_items = [(k, v) for k, v in emails.items() if k not in seen_ids]
        for email_id, em in new_items:
            seen_ids.add(email_id)
            log("inbox", f"новое письмо: subject={em.get('subject')}, from={em.get('sender_email')}")
            body = None
            try:
                read_result = await fetch_email_body(page, email, accesstoken, email_id, em.get("email_id"))
                if read_result and read_result.get("msg") == "ok" and read_result.get("data"):
                    body = read_result["data"]
            except Exception as e:
                log("inbox", f"read body err: {e}")

            text = email_to_text(body or em)
            code = extract_otp(text)
            link = extract_magic_link(text)
            log("inbox", f"code={code or '-'}, link={'yes' if link else 'no'}")
            if code or link:
                return {"ok": True, "code": code, "link": link, "raw": body or em}

        await asyncio.sleep(poll)

    return {"ok": False, "error": "timeout"}


async def main():
    headless = "--headless" in sys.argv or os.environ.get("HEADLESS") == "1"
    log("start", f"Camoufox tmailor headless={headless}")

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
        ) as browser:
            # persistent_context уже даёт пустую вкладку (page 0) — переиспользуем
            # её, иначе new_page() плодит лишнюю пустую вкладку в окне.
            page = browser.pages[0] if browser.pages else await browser.new_page()
            page.on("pageerror", lambda e: None)

            current_email = None
            current_accesstoken = None

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
                if action == "create":
                    try:
                        creds = await create_email(page)
                        current_email = creds["email"]
                        current_accesstoken = creds["accesstoken"]
                        out({"ok": True, "email": current_email, "accesstoken": current_accesstoken})
                    except Exception as e:
                        log("create", f"error: {e}")
                        out({"ok": False, "error": str(e)})

                elif action == "regenerate":
                    try:
                        creds = await regenerate_email(page)
                        current_email = creds["email"]
                        current_accesstoken = creds["accesstoken"]
                        out({"ok": True, "email": current_email, "accesstoken": current_accesstoken})
                    except Exception as e:
                        log("regenerate", f"error: {e}")
                        out({"ok": False, "error": str(e)})

                elif action == "wait_otp":
                    if not current_email or not current_accesstoken:
                        out({"ok": False, "error": "no email created yet"})
                        continue
                    try:
                        result = await wait_for_otp(
                            page,
                            current_email,
                            current_accesstoken,
                            timeout=cmd.get("timeout", 120),
                            poll=cmd.get("poll", 4),
                            from_hint=cmd.get("from_hint", "freemodel"),
                        )
                        out(result)
                    except Exception as e:
                        log("wait_otp", f"error: {e}")
                        out({"ok": False, "error": str(e)})

                elif action == "stop":
                    out({"ok": True})
                    break

                else:
                    out({"ok": False, "error": f"unknown cmd: {action}"})

    except Exception as e:
        log("fatal", f"{e}\n{traceback.format_exc()}")
        out({"ok": False, "error": str(e)})
    finally:
        # Оставляем профиль для отладки; можно включить очистку позже.
        pass


if __name__ == "__main__":
    asyncio.run(main())
