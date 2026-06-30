# tgbot/stt_server.py
#
# Долгоживущий STT-демон для ТГ-бота: грузит faster-whisper ОДИН раз в RAM,
# потом по строке-запросу из stdin транскрибирует файл и пишет JSON в stdout.
# Так нет 3-5с оверхеда на загрузку модели при каждом голосовом.
#
# Протокол (по строке на сообщение):
#   IN  : <путь к аудиофайлу>\n          (Telegram .oga/opus, ffmpeg декодит сам)
#   OUT : {"ok": true, "text": "...", "lang": "ru", "dur": 3.4}\n
#         {"ok": false, "error": "..."}\n
#
# Запуск (бот делает сам): python stt_server.py
# Env:
#   WHISPER_MODEL  — размер модели (tiny/base/small/medium/large-v3), по умолч. small
#   WHISPER_DEVICE — cpu | cuda (по умолч. cpu)
#   WHISPER_COMPUTE— int8 (cpu) | float16 (cuda), по умолч. int8

import os
import sys
import json
import time

# Модель уже в локальном кэше — не ходим в HF Hub за апдейтами на каждом старте
# (иначе faster-whisper висит на rate-limit/сети). Ставим ДО импорта библиотек.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

def log(*a):
    # диагностика — в stderr, чтобы не засорять протокольный stdout
    print(*a, file=sys.stderr, flush=True)

def main():
    model_size = os.environ.get("WHISPER_MODEL", "base")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute = os.environ.get("WHISPER_COMPUTE", "int8" if device == "cpu" else "float16")

    log(f"[stt] loading faster-whisper '{model_size}' device={device} compute={compute}…")
    t0 = time.time()
    try:
        from faster_whisper import WhisperModel
        # local_files_only — только кэш, без сети (модель уже скачана)
        model = WhisperModel(model_size, device=device, compute_type=compute, local_files_only=True)
    except Exception as e:
        # фатально: сообщаем боту первой же строкой и выходим
        print(json.dumps({"ok": False, "error": f"model load failed: {e}"}), flush=True)
        log(f"[stt] FATAL: {e}")
        return
    log(f"[stt] ready in {time.time()-t0:.1f}s")
    # сигнал готовности боту
    print(json.dumps({"ready": True, "model": model_size}), flush=True)

    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        if path == "__quit__":
            break
        if not os.path.exists(path):
            print(json.dumps({"ok": False, "error": f"file not found: {path}"}), flush=True)
            continue
        try:
            t0 = time.time()
            # beam_size=5 — баланс точность/скорость; язык не форсим (автоопределение),
            # vad_filter режет тишину/паузы → меньше галлюцинаций на длинных паузах.
            segments, info = model.transcribe(path, beam_size=5, vad_filter=True)
            text = "".join(seg.text for seg in segments).strip()
            out = {
                "ok": True,
                "text": text,
                "lang": info.language,
                "dur": round(time.time() - t0, 2),
            }
            print(json.dumps(out, ensure_ascii=False), flush=True)
            log(f"[stt] {info.language} {out['dur']}s → {len(text)} chars")
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)
            log(f"[stt] ERROR: {e}")

if __name__ == "__main__":
    main()
