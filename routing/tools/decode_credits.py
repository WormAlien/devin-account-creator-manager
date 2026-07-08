"""Полный protobuf-dump сохранённого /GetGrokCreditsConfig — ищем plan/tier field."""
import base64, struct, sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
raw = base64.b64decode(Path('probe_out/credits_raw.b64').read_text())
print(f'total {len(raw)} bytes')
print('hex:', raw.hex())

# grpc-web frame: 1 byte flag + 4 byte BE length + payload
flag = raw[0]
msg_len = int.from_bytes(raw[1:5], 'big')
print(f'flag={flag} msg_len={msg_len}')
payload = raw[5:5+msg_len]

def varint(b, o):
    v = 0; s = 0
    while True:
        x = b[o]; o += 1
        v |= (x & 0x7f) << s
        if not (x & 0x80): return v, o
        s += 7

def parse(b, depth=0):
    o = 0; n = len(b)
    prefix = '  ' * depth
    out = {}
    while o < n:
        tag, o = varint(b, o)
        field = tag >> 3
        wt = tag & 7
        if wt == 0:  # varint
            v, o = varint(b, o)
            print(f'{prefix}f{field} varint = {v}')
            out.setdefault(field, []).append(v)
        elif wt == 1:  # 64-bit
            v = struct.unpack_from('<Q', b, o)[0]; o += 8
            print(f'{prefix}f{field} fixed64 = {v}')
            out.setdefault(field, []).append(v)
        elif wt == 2:  # length-delimited
            ln, o = varint(b, o)
            chunk = b[o:o+ln]; o += ln
            # try recurse
            try:
                sub = parse(chunk, depth+1)
                print(f'{prefix}f{field} sub[{ln}]:')
                for k, vs in sub.items():
                    for v in vs:
                        pass  # already printed by recurse
                out.setdefault(field, []).append(sub)
            except Exception:
                try:
                    s = chunk.decode('utf-8')
                    print(f'{prefix}f{field} str[{ln}] = {s!r}')
                    out.setdefault(field, []).append(s)
                except Exception:
                    print(f'{prefix}f{field} bytes[{ln}] = {chunk.hex()}')
                    out.setdefault(field, []).append(chunk.hex())
        elif wt == 5:  # 32-bit
            v = struct.unpack_from('<f', b, o)[0]; o += 4
            print(f'{prefix}f{field} float = {v}')
            out.setdefault(field, []).append(v)
        else:
            print(f'{prefix}unknown wt={wt}')
            break
    return out

print('\n=== payload parse ===')
parse(payload)
