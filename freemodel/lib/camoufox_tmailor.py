"""freemodel/lib/camoufox_tmailor.py
Camoufox (Firefox stealth) клиент для tmailor.com.
Протокол: JSON-lines через stdin/stdout.
Команды:
  {"cmd":"create"}                -> {"ok":true, "email":..., "accesstoken":...}
  {"cmd":"regenerate"}            -> {"ok":true, "email":..., "accesstoken":...}
  {"cmd":"wait_otp", "timeout":120, "poll":4, "from_hint":"freemodel"} -> {"ok":true, "code":"123456", "link":...} | {"ok":false, "error":"timeout"}
  {"cmd":"stop"}                  -> завершает процесс
"""
import asyncio, json, os, re, sys, time, traceback
from pathlib import Path

from camoufox import AsyncCamoufox

BASE_URL = "https://tmailor.com"
API_URL = "https://tmailor.com/api"

PROFILE_DIR = Path(__file__).parent / f"camoufox_tmailor_profile_{os.getpid()}"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)


def log(tag: str, msg: str):
    t = time.strftime("%H:%M:%S")
    line = f"[{t}] [{tag}] {msg}"
    try:
        print(line, flush=True, file=sys.stderr)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode(), flush=True, file=sys.stderr)


def out(obj: dict):
    print(json.dumps(obj, ensure_ascii=False), flush=True, file=sys.stdout)


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


async def handle_turnstile(page):
    log("turnstile", "проверяю...")
    await asyncio.sleep(1.5)

    try:
        await page.click("body", position={"x": 100, "y": 100}, timeout=2000)
    except Exception:
        pass
    await asyncio.sleep(0.3)

    for attempt in range(5):
        try:
            await page.click("iframe[src*='cloudflare'], iframe[src*='turnstile'], .cf-turnstile", timeout=3000)
            log("turnstile", f"клик по iframe (попытка {attempt+1})")
        except Exception:
            frame = None
            for f in page.frames:
                if "challenges.cloudflare.com" in f.url:
                    frame = f
                    break
            if frame:
                try:
                    await frame.click("body", position={"x": 30, "y": 30}, timeout=3000)
                    log("turnstile", "клик внутри iframe")
                except Exception as e:
                    log("turnstile", f"iframe err: {e}")

        await asyncio.sleep(2)
        try:
            token = await page.eval_on_selector('input[name="cf-turnstile-response"]', "el => el.value")
            if token and len(token) > 10:
                log("turnstile", "PASSED!")
                return True
        except Exception:
            pass

    log("turnstile", "не удалось автоматически; жду ручного прохождения")
    # В Camoufox Cloudflare обычно решается сам благодаря fingerprint.
    # Если не решился — даём 15 сек добровольного прохождения.
    for _ in range(15):
        await asyncio.sleep(1)
        try:
            token = await page.eval_on_selector('input[name="cf-turnstile-response"]', "el => el.value")
            if token and len(token) > 10:
                log("turnstile", "PASSED!")
                return True
        except Exception:
            pass
    return False


async def create_email(page):
    log("email", "открываю tmailor.com...")

    captured = {}

    async def on_response(res):
        try:
            url = res.url
            if url.rstrip("/") != API_URL.rstrip("/"):
                return
            method = res.request.method if res.request else "GET"
            if method.upper() != "POST":
                return
            body = await res.json()
            if body and body.get("msg") == "ok" and body.get("email") and body.get("accesstoken"):
                captured["email"] = body["email"]
                captured["accesstoken"] = body["accesstoken"]
                log("email", f"перехвачен из API response: {body['email']}")
        except Exception:
            pass

    page.on("response", lambda res: asyncio.create_task(on_response(res)))

    await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)

    # Ждём, пока страница сама вызовет newemail (обычно происходит сразу после прохождения CF).
    deadline = time.time() + 30
    while time.time() < deadline:
        if captured.get("email") and captured.get("accesstoken"):
            return {"email": captured["email"], "accesstoken": captured["accesstoken"]}
        await asyncio.sleep(0.5)

    # Fallback: вызываем API вручную изнутри страницы.
    log("email", "не перехватил авто-ответ, вызываю API вручную...")
    result = await page.evaluate(
        """async (apiUrl) => {
            const currentToken = (window.currentEmail && window.currentEmail.accesstoken) || "";
            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ action: "newemail", curentToken: currentToken }),
            });
            return res.json();
        }""",
        API_URL,
    )
    if result and result.get("msg") == "ok" and result.get("email") and result.get("accesstoken"):
        log("email", f"получен вручную: {result['email']}")
        return {"email": result["email"], "accesstoken": result["accesstoken"]}

    raise Exception(f"failed to create email: {result}")


async def regenerate_email(page):
    result = await page.evaluate(
        """async (apiUrl) => {
            const currentToken = (window.currentEmail && window.currentEmail.accesstoken) || "";
            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ action: "newemail", curentToken: currentToken }),
            });
            return res.json();
        }""",
        API_URL,
    )
    if result and result.get("msg") == "ok" and result.get("email") and result.get("accesstoken"):
        log("email", f"перегенерирован: {result['email']}")
        return {"email": result["email"], "accesstoken": result["accesstoken"]}
    raise Exception(f"regenerate failed: {result.get('msg') or result}")


async def fetch_inbox(page, email, accesstoken):
    return await page.evaluate(
        """async ({ address, accesstoken, apiUrl }) => {
            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ action: "listinbox", listToken: { [address]: accesstoken } }),
            });
            return res.json();
        }""",
        {"address": email, "accesstoken": accesstoken, "apiUrl": API_URL},
    )


async def fetch_email_body(page, email, accesstoken, email_code, email_token):
    return await page.evaluate(
        """async ({ accesstoken, email_code, email_token, apiUrl }) => {
            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ action: "read", accesstoken, email_code, email_token }),
            });
            return res.json();
        }""",
        {"accesstoken": accesstoken, "email_code": email_code, "email_token": email_token, "apiUrl": API_URL},
    )


async def wait_for_otp(page, email, accesstoken, timeout=120, poll=4, from_hint="freemodel"):
    deadline = time.time() + timeout
    seen_ids = set()
    while time.time() < deadline:
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
            humanize=10.0,
            main_world_eval=True,
            i_know_what_im_doing=True,
        ) as browser:
            page = await browser.new_page()
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
