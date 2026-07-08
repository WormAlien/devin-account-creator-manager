"""Смотрим внутренности f8/f11/f13 из GetGrokCreditsConfig — там должен быть план."""
import base64, struct, sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
fn = sys.argv[1] if len(sys.argv) > 1 else 'probe_out/credits_raw.b64'
raw = base64.b64decode(Path(fn).read_text())
print(f'FILE: {fn}')
payload = raw[5:5 + int.from_bytes(raw[1:5], 'big')]

def varint(b, o):
    v = 0; s = 0
    while True:
        x = b[o]; o += 1
        v |= (x & 0x7f) << s
        if not (x & 0x80): return v, o
        s += 7

def dump(b, depth=0):
    o = 0; n = len(b)
    p = '  ' * depth
    while o < n:
        tag, o = varint(b, o)
        f = tag >> 3; wt = tag & 7
        if wt == 0:
            v, o = varint(b, o); print(f'{p}f{f} varint = {v}')
        elif wt == 1:
            v = struct.unpack_from('<Q', b, o)[0]; o += 8
            print(f'{p}f{f} fixed64 = {v}')
        elif wt == 2:
            ln, o = varint(b, o); chunk = b[o:o+ln]; o += ln
            # эвристика: если печатается как ASCII — строка
            try:
                s = chunk.decode('utf-8')
                if all(0x20 <= c < 0x7f or c in (0x0a, 0x0d) for c in chunk):
                    print(f'{p}f{f} STR[{ln}] = {s!r}')
                    continue
            except: pass
            print(f'{p}f{f} sub[{ln}] hex={chunk.hex()}:')
            try:
                dump(chunk, depth+1)
            except Exception as e:
                print(f'{p}  parse fail: {e}')
        elif wt == 5:
            v = struct.unpack_from('<f', b, o)[0]; o += 4
            print(f'{p}f{f} float = {v}')
        else:
            print(f'{p}unknown wt={wt}'); break

# outer message
tag, o = varint(payload, 0)  # f1 wt=2
ln, o = varint(payload, o)
inner = payload[o:o+ln]
print(f'inner len={len(inner)}')
print(f'inner hex={inner.hex()}')
print()
dump(inner)
