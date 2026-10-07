#!/usr/bin/env python3
"""Apply a JSON recipe of map edits to a MED17 full-flash dump.

Each edit: {"name", "addr" (record start as printed by mapfinder), "nx", "ny",
            "op": "scale"|"add"|"set", "value", optional "x_from" (rpm*4 raw)}
Original bytes are checked (axes must match) before writing.
Checksums are NOT corrected - let the flashing tool do it.
"""
import json, struct, sys

def main(src, recipe, dst):
    d = bytearray(open(src, 'rb').read())
    for e in json.load(open(recipe))['edits']:
        o, nx, ny = int(e['addr'], 0), e['nx'], e['ny']
        if struct.unpack_from('<HH', d, o) != (nx, ny):
            sys.exit(f"{e['name']}: header mismatch at {e['addr']}")
        x = struct.unpack_from(f'<{nx}H', d, o + 4)
        p = o + 4 + 2*nx + 2*ny
        for i in range(nx):
            if x[i] < e.get('x_from', 0):
                continue
            for j in range(ny):
                a = p + 2*(i*ny + j)
                v = struct.unpack_from('<H', d, a)[0]
                v = {'scale': lambda: v*e['value'], 'add': lambda: v+e['value'],
                     'set': lambda: e['value']}[e['op']]()
                struct.pack_into('<H', d, a, max(0, min(0xFFFF, round(v))))
        print('applied', e['name'])
    open(dst, 'wb').write(d)

if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('usage: patch.py original.bin recipe.json out.bin')
    main(*sys.argv[1:])
