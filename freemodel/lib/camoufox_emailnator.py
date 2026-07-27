"""freemodel/lib/camoufox_emailnator.py
Camoufox (Firefox stealth) клиент для emailnator.com.
Протокол: JSON-lines через stdin/stdout.
Команды:
  {"cmd":"create"}                -> {"ok":true, "email":...}
  {"cmd":"wait_otp", "timeout":120, "poll":8, "from_hint":"cun"} -> {"ok":true, "code":"123456"} | {"ok":false, "error":"timeout"}
  {"cmd":"stop"}                  -> завершает процесс
"""
import asyncio, json, os, re, sys, time, traceback
from pathlib import Path

from camoufox import AsyncCamoufox

BASE_URL = "https://www.emailnator.com"
PROFILE_DIR = Path(__file__).parent / f"camoufox_emailnator_profile_{os.getpid()}"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)

POLL_INTERVAL_MS = 8000
MAX_WAIT_MIN = 15


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
        print(json.dumps(obj, ensure_ascii=True), flush=True, file=sys.stdout)


async def create_email(page):
    log("email", "открываю emailnator.com...")
    await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)
    try:
        await page.click('button:has-text("Consent")', timeout=4000)
    except Exception:
        pass
    await asyncio.sleep(1.5)

    email = ""
    for i in range(6):
        try:
            email = await page.eval_on_selector("input", "el => el.value")
            if email and "@gmail.com" in email:
                break
        except Exception:
            pass
        await asyncio.sleep(1)

    if not email or "@gmail.com" not in email:
        raise Exception("Не удалось получить email от emailnator")

    log("email", f"Gmail alias: {email}")
    return email


async def poll_inbox(page, email, timeout=120, poll=8, from_hint=""):
    max_attempts = int((timeout * 1000) / (poll * 1000))
    log("inbox", f"проверяю {email} каждые {poll}s ({timeout}s макс)...")

    await page.goto(f"{BASE_URL}/mailbox#{email}", wait_until="domcontentloaded", timeout=60000)
    try:
        await page.click('button:has-text("Consent")', timeout=3000)
    except Exception:
        pass
    await asyncio.sleep(2)

    last_body_len = 0

    for i in range(max_attempts):
        try:
            try:
                refresh = await page.query_selector('button:has-text("Refresh"), button:has-text("Обновить")')
                if refresh:
                    await refresh.click(timeout=2000)
                else:
                    await page.reload(wait_until="domcontentloaded", timeout=30000)
                    try:
                        await page.click('button:has-text("Consent")', timeout=1500)
                    except Exception:
                        pass
            except Exception:
                await page.reload(wait_until="domcontentloaded", timeout=30000)

            await asyncio.sleep(2.5)

            body_text = await page.evaluate("() => document.body.innerText || ''")

            if len(body_text) > last_body_len + 50:
                last_body_len = len(body_text)
                log("inbox", f"📬 обновился ({len(body_text)} символов)")

                # Кликаем первое не-системное письмо
                links = await page.query_selector_all('a, [role="link"], li.message, div.message')
                for j, ml in enumerate(links[:10]):
                    try:
                        t = (await ml.inner_text() or "").lower()
                        if len(t) < 5:
                            continue
                        if "emailnator" in t or "refresh" in t or "consent" in t:
                            continue
                        await ml.click(timeout=2000)
                        await asyncio.sleep(1.5)
                        break
                    except Exception:
                        pass

                msg_text = await page.evaluate("() => document.body.innerText || ''")

                if from_hint and from_hint.lower() not in msg_text.lower():
                    pass  # письмо есть, но не от нужного отправителя
                else:
                    patterns = [
                        r"(?:code|код|verify|verification|otp|pin)[^\d]{0,40}(\d{4,8})",
                        r"\b(\d{6})\b",
                        r"\b(\d{8})\b",
                        r"\b(\d{5})\b",
                        r"\b(\d{4})\b",
                    ]
                    for pat in patterns:
                        m = re.search(pat, msg_text, re.I)
                        if m:
                            code = m.group(1)
                            log("inbox", f"🎉 КОД: {code}")
                            return {"ok": True, "code": code}
        except Exception as e:
            log("inbox", f"⚠️ {e}")

        await asyncio.sleep(poll)

    log("inbox", f"❌ Письмо не пришло за {timeout}s")
    return {"ok": False, "error": "timeout"}


async def main():
    headless = "--headless" in sys.argv or os.environ.get("HEADLESS") == "1"
    log("start", f"Camoufox emailnator headless={headless}")

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
            page = browser.pages[0] if browser.pages else await browser.new_page()
            page.on("pageerror", lambda e: None)

            current_email = None

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
                        current_email = await create_email(page)
                        out({"ok": True, "email": current_email})
                    except Exception as e:
                        log("create", f"error: {e}")
                        out({"ok": False, "error": str(e)})

                elif action == "wait_otp":
                    if not current_email:
                        out({"ok": False, "error": "no email created yet"})
                        continue
                    try:
                        result = await poll_inbox(
                            page,
                            current_email,
                            timeout=cmd.get("timeout", 120),
                            poll=cmd.get("poll", 8),
                            from_hint=cmd.get("from_hint", ""),
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
        pass


if __name__ == "__main__":
    asyncio.run(main())
