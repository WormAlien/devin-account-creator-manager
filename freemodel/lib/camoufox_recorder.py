"""freemodel/lib/camoufox_recorder.py
Запускает Camoufox на tmailor.com в видимом окне и записывает:
  - клики (селектор, координаты, текст элемента)
  - URL-изменения
  - console.log / console.error / page errors
  - network responses на tmailor.com/api
  - скриншоты после каждого клика
  - DOM-слепок перед и после генерации email

Использование:
  python freemodel/lib/camoufox_recorder.py
Затем кликай в браузере. Нажми Enter в консоли, когда закончишь.
"""
import asyncio, json, os, re, sys, time, traceback
from pathlib import Path

from camoufox import AsyncCamoufox

BASE_URL = "https://tmailor.com"
API_URL = "https://tmailor.com/api"
OUT_DIR = Path(__file__).parent / "camoufox_recordings"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SESSION_ID = time.strftime("%Y%m%d_%H%M%S")
LOG_FILE = OUT_DIR / f"{SESSION_ID}_log.jsonl"
SHOT_DIR = OUT_DIR / f"{SESSION_ID}_shots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)

PROFILE_DIR = OUT_DIR / f"profile_{SESSION_ID}"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)


def log_event(kind, payload):
    entry = {"t": time.time(), "kind": kind, "payload": payload}
    line = json.dumps(entry, ensure_ascii=False, default=str)
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


async def snapshot_dom(page, label):
    try:
        data = await page.evaluate("""() => {
            const input = (name) => {
                const el = document.querySelector(`input[name="${name}"]`) || document.querySelector(`input[id="${name}"]`);
                return el ? el.value : null;
            };
            const buttons = Array.from(document.querySelectorAll('button, a')).map(b => ({
                tag: b.tagName,
                text: b.textContent.trim().slice(0, 80),
                id: b.id,
                class: b.className.slice(0, 100),
                href: b.href || null,
                rect: b.getBoundingClientRect ? {
                    x: b.getBoundingClientRect().x,
                    y: b.getBoundingClientRect().y,
                    w: b.getBoundingClientRect().width,
                    h: b.getBoundingClientRect().height,
                } : null,
            }));
            return {
                url: location.href,
                title: document.title,
                currentEmail: (typeof window.currentEmail !== "undefined" ? window.currentEmail : null),
                cfToken: input("cf-turnstile-response"),
                buttons: buttons.slice(0, 100),
                bodyText: document.body ? document.body.innerText.slice(0, 500) : "",
            };
        }""")
        log_event("dom_snapshot", {"label": label, "data": data})
    except Exception as e:
        log_event("dom_snapshot_error", {"label": label, "error": str(e)})


async def main():
    print(f"Запись в: {OUT_DIR}")
    print("Открой браузерное окно, кликай по tmailor.com. Нажми Enter в консоли, когда закончишь.")

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
            page = await browser.new_page()
            page.on("pageerror", lambda e: log_event("pageerror", {"msg": str(e)}))
            page.on("console", lambda msg: log_event("console", {"type": msg.type, "text": msg.text}))

            # Слушаем network responses для tmailor.com/api
            page.on("response", lambda res: asyncio.create_task(log_response(res)))

            await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(1)
            await snapshot_dom(page, "after_goto")

            # Экспонируем Python-функцию в страницу для записи кликов
            async def click_handler(data):
                log_event("click", data)
                # Скриншот после клика
                try:
                    shot_path = SHOT_DIR / f"{int(time.time()*1000)}.png"
                    await page.screenshot(path=str(shot_path), full_page=False)
                    log_event("screenshot", {"path": str(shot_path)})
                except Exception as e:
                    log_event("screenshot_error", {"error": str(e)})
                await snapshot_dom(page, "after_click")

            await page.expose_function("__recorderClick", click_handler)

            # Инжектируем JS-рекордер кликов
            await page.evaluate("""() => {
                window.__recorderClicks = [];
                document.addEventListener("click", (e) => {
                    const el = e.target;
                    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
                    const data = {
                        time: Date.now(),
                        x: e.clientX,
                        y: e.clientY,
                        tag: el.tagName,
                        id: el.id,
                        class: el.className,
                        text: (el.textContent || "").trim().slice(0, 100),
                        href: el.href || null,
                        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                    };
                    window.__recorderClicks.push(data);
                    if (typeof window.__recorderClick === "function") {
                        window.__recorderClick(data).catch(() => {});
                    }
                }, true);
            }""")

            # Периодические слепки DOM и currentEmail
            async def poll():
                while True:
                    await asyncio.sleep(3)
                    await snapshot_dom(page, "poll")

            poll_task = asyncio.create_task(poll())

            # Ожидаем Enter в консоли
            await asyncio.to_thread(sys.stdin.readline)

            poll_task.cancel()
            try:
                await poll_task
            except asyncio.CancelledError:
                pass

            await snapshot_dom(page, "final")
            print(f"Готово. Лог: {LOG_FILE}")
            print(f"Скриншоты: {SHOT_DIR}")

    except Exception as e:
        print(f"Ошибка: {e}")
        traceback.print_exc()


async def log_response(res):
    try:
        url = res.url
        if "tmailor.com/api" in url:
            status = res.status
            try:
                body = await res.text()
                if len(body) > 2000:
                    body = body[:2000] + "..."
            except Exception:
                body = "<unreadable>"
            log_event("api_response", {"url": url, "status": status, "body": body})
    except Exception:
        pass


if __name__ == "__main__":
    asyncio.run(main())
