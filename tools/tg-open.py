#!/usr/bin/env python3
# tools/tg-open.py
#
# Открыть TG-сессию из freemodel/tg_pool.json в отдельном портативном
# Telegram Desktop (tools/telegram-portable). auth_key_hex + dc_id -> tdata
# через opentele (UseCurrentSession = тот же auth_key, без релогина/SMS).
#
# Каждый аккаунт = свой -workdir, профили не пересекаются и НЕ трогают
# пользовательский AyuGram.
#
# Запуск только через tools/tg-venv (py3.12 + opentele). Пример:
#   tools/tg-venv/Scripts/python.exe tools/tg-open.py 240718298
#   ... tg-open.py 240718298 --check        # офлайн-проверка, без сети/запуска
#   ... tg-open.py 240718298 --no-launch     # сделать tdata, но не запускать

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POOL = ROOT / "freemodel" / "tg_pool.json"
PROFILES = ROOT / "tools" / "tg-profiles"
TELEGRAM_EXE = ROOT / "tools" / "telegram-portable" / "Telegram" / "Telegram.exe"

# Prod DC адреса (как в freemodel/lib/tg-client.js). telethon знает их сам,
# но из голой StringSession без bootstrap иногда не находит — задаём явно.
DC_IPS = {
    1: ("149.154.175.50", 443),
    2: ("149.154.167.51", 443),
    3: ("149.154.175.100", 443),
    4: ("149.154.167.91", 443),
    5: ("91.108.56.130", 443),
}


def find_entry(phone: str) -> dict:
    entries = json.loads(POOL.read_text(encoding="utf-8"))
    p = phone.lstrip("+")
    for e in entries:
        if str(e.get("phone", "")).lstrip("+") == p:
            return e
    raise SystemExit(f"phone {phone!r} не найден в {POOL}")


def build_session(entry: dict):
    from telethon.sessions import StringSession
    from telethon.crypto import AuthKey

    dc_id = int(entry["dc_id"])
    if dc_id not in DC_IPS:
        raise SystemExit(f"неизвестный dc_id: {dc_id}")
    key_hex = entry["auth_key_hex"]
    if len(key_hex) != 512:
        raise SystemExit(f"auth_key_hex неверной длины: {len(key_hex)} (нужно 512)")

    ip, port = DC_IPS[dc_id]
    s = StringSession()
    s.set_dc(dc_id, ip, port)
    s.auth_key = AuthKey(bytes.fromhex(key_hex))
    return s


def profile_dir(entry: dict) -> Path:
    safe = str(entry["phone"]).lstrip("+").replace("\\", "_").replace("/", "_")
    return PROFILES / safe


async def make_tdata(entry: dict) -> Path:
    from opentele.tl import TelegramClient
    from opentele.api import API, UseCurrentSession

    wd = profile_dir(entry)
    tdata = wd / "tdata"
    if (tdata / "key_datas").exists():
        return wd  # уже сконвертировано — переиспользуем

    client = TelegramClient(build_session(entry), api=API.TelegramDesktop)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise SystemExit("auth_key не авторизован (сессия мертва/отозвана)")
    me = await client.get_me()
    print(f"[tg] me id={me.id} @{me.username or '-'} phone={me.phone or '-'}",
          file=sys.stderr)

    tdesk = await client.ToTDesktop(flag=UseCurrentSession)
    await client.disconnect()
    tdata.mkdir(parents=True, exist_ok=True)
    tdesk.SaveTData(str(tdata))
    return wd


def launch(workdir: Path):
    if not TELEGRAM_EXE.exists():
        raise SystemExit(f"не найден портативный клиент: {TELEGRAM_EXE}")
    subprocess.Popen(
        [str(TELEGRAM_EXE), "-workdir", str(workdir)],
        creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
        close_fds=True,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phone")
    ap.add_argument("--check", action="store_true",
                    help="офлайн: только собрать сессию и проверить, без сети/запуска")
    ap.add_argument("--no-launch", action="store_true",
                    help="сделать tdata, но не запускать клиент")
    args = ap.parse_args()

    entry = find_entry(args.phone)

    if args.check:
        build_session(entry)  # бросит SystemExit при битом ключе/dc
        print(f"OK check: {entry['phone']} dc={entry['dc_id']} "
              f"key_len={len(entry['auth_key_hex'])}")
        return

    wd = asyncio.run(make_tdata(entry))
    print(f"tdata: {wd / 'tdata'}")
    if args.no_launch:
        return
    launch(wd)
    print(f"launched: {TELEGRAM_EXE.name} -workdir {wd}")


if __name__ == "__main__":
    main()
