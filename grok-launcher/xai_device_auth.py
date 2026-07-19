"""Авторизация на accounts.x.ai по кукам из менеджера сессий Grok.

Берём sso/sso-rw куку из grok-launcher/cookies/*.json и инжектируем её
под домен .x.ai (xAI использует общий SSO), затем открываем браузер на
странице device-flow с переданным user_code.

Пример:
    python xai_device_auth.py N5M4-SFZP
    python xai_device_auth.py N5M4-SFZP --cookie 1.json
    python xai_device_auth.py N5M4-SFZP --open-account   # сразу на accounts.x.ai
"""

import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

LOG_PATH = Path(__file__).parent / "xai_device_auth.log"


def log(*a):
    msg = " ".join(str(x) for x in a)
    print(msg, flush=True)
    try:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass

COOKIE_DIR = Path(__file__).parent / "cookies"
XAI_TARGET_DOMAINS = [".x.ai", "x.ai", "accounts.x.ai", "auth.x.ai",
                      "www.x.ai", "api.x.ai", "grok.com", ".grok.com"]


def load_cookie_file(name: str | None) -> Path:
    if name:
        p = COOKIE_DIR / name
        if not p.exists():
            p = Path(name)
        if not p.exists():
            sys.exit(f"[x] cookie file not found: {name}")
        return p
    # берём первый .json без .meta
    candidates = sorted(
        f for f in COOKIE_DIR.glob("*.json") if not f.name.endswith(".meta.json")
    )
    if not candidates:
        sys.exit(f"[x] no cookie files in {COOKIE_DIR}")
    return candidates[0]


def read_cookies(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "cookies" in data:
        data = data["cookies"]
    if not isinstance(data, list):
        sys.exit("[x] cookie file must be a JSON array (Cookie-Editor format)")
    return data


def to_xai_cookies(cookies: list[dict]) -> list[dict]:
    """Копируем sso/sso-rw и прочие grok.com/x.ai куки под домен .x.ai.

    Кука с domain '.grok.com' браузер НЕ отправит на accounts.x.ai, поэтому
    делаем дополнительную копию с domain '.x.ai' (ведущая точка -> все
    поддомены, включая accounts.x.ai).
    """
    out: list[dict] = []
    for c in cookies:
        dom = (c.get("domain") or "").lower()
        if "grok.com" not in dom and "x.ai" not in dom:
            continue
        value = c.get("value")
        name = c.get("name")
        if not name or value is None:
            continue
        # оригинал (на всякий случай)
        out.append(_fmt(c, dom))
        # копия под .x.ai
        for target in XAI_TARGET_DOMAINS:
            out.append(_fmt(c, target))
    return out


def _fmt(c: dict, domain: str) -> dict:
    expires = c.get("expirationDate") or c.get("expiration") or c.get("expires")
    same = c.get("sameSite", "Lax")
    if isinstance(same, str):
        same = {"unspecified": "None", "no_restriction": "None"}.get(same.lower(), same.capitalize())
    else:
        same = "Lax"
    return {
        "name": c["name"],
        "value": c["value"],
        "domain": domain,
        "path": c.get("path", "/"),
        "expires": float(expires) if expires else 2147483647,
        "httpOnly": bool(c.get("httpOnly", False)),
        "secure": bool(c.get("secure", True)),
        "sameSite": same,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("user_code", nargs="?", help="user_code из ссылки device-flow")
    ap.add_argument("--cookie", help="имя файла в cookies/ или путь")
    ap.add_argument("--open-account", action="store_true",
                    help="сразу открыть https://accounts.x.ai (без device-страницы)")
    ap.add_argument("--shot", metavar="FILE",
                    help="сделать скриншот страницы и выйти (без ожидания)")
    args = ap.parse_args()

    cpath = load_cookie_file(args.cookie)
    cookies = read_cookies(cpath)
    xai = to_xai_cookies(cookies)
    if not xai:
        sys.exit(f"[x] в {cpath.name} нет grok.com/x.ai кук (sso)")
    log(f"[+] загружено {len(cookies)} кук из {cpath.name}, "
        f"для .x.ai подготовлено {len(xai)}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, channel="chrome")
        ctx = browser.new_context()
        ctx.add_cookies(xai)

        # SSO warmup: сначала грузим grok.com (sso срабатывает, ставятся
        # x.ai session-куки), затем переходим на accounts.x.ai в том же окне.
        warm = ctx.new_page()
        warm.goto("https://grok.com", wait_until="domcontentloaded", timeout=60000)
        warm.wait_for_timeout(4000)
        log("[+] SSO warmup: grok.com загружен")

        if args.open_account:
            page = ctx.new_page()
            page.goto("https://accounts.x.ai", wait_until="domcontentloaded", timeout=60000)
            log("[+] открыт accounts.x.ai — сессия должна быть активна")
        elif args.user_code:
            url = f"https://accounts.x.ai/oauth2/device?user_code={args.user_code}"
            page = ctx.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            log(f"[+] открыта device-страница: {url}")
            log("    Нажми Authorize в браузере (сессия уже залогинена через sso).")
        else:
            page = ctx.new_page()
            page.goto("https://accounts.x.ai", wait_until="domcontentloaded", timeout=60000)
            log("[+] открыт accounts.x.ai")
        warm.close()

        log("[*] браузер открыт. Закрой окно для выхода.")

        if args.shot:
            page.wait_for_timeout(3500)
            page.screenshot(path=args.shot, full_page=True)
            log(f"[+] скриншот сохранён: {args.shot}")
            try:
                txt = page.inner_text("body")
                Path(__file__).parent.joinpath("page_text.txt").write_text(
                    txt, encoding="utf-8")
                log("=== TEXT saved to page_text.txt ===")
            except Exception as e:
                log(f"[!] не удалось прочитать текст: {e}")
            browser.close()
            return

        try:
            page.wait_for_timeout(600_000)
        except KeyboardInterrupt:
            pass
        browser.close()


if __name__ == "__main__":
    main()
