#!/usr/bin/env python3
"""Heuristic map finder for Bosch MED17 calibration areas (no A2L needed).

Looks for Bosch-style inline records:
  CURVE (KL): [nx:u16][x[nx]:u16][val[nx]]
  MAP   (KF): [nx:u16][ny:u16][x[nx]:u16][y[ny]:u16][val[nx*ny]:u16]
with strictly increasing axes. Prints candidates as CSV.
"""
import argparse, struct, sys

def u16(d, o): return struct.unpack_from('<H', d, o)[0]

def inc(a): return all(a[i] < a[i+1] for i in range(len(a)-1))

def find(d, start, end, minpts=4, maxpts=32):
    o = start
    out = []
    while o < end - 8:
        nx = u16(d, o)
        if minpts <= nx <= maxpts:
            ny = u16(d, o+2)
            if minpts <= ny <= maxpts:
                p = o + 4
                x = struct.unpack_from(f'<{nx}H', d, p); p += 2*nx
                y = struct.unpack_from(f'<{ny}H', d, p); p += 2*ny
                if inc(x) and inc(y) and x[-1] > 0 and y[-1] > 0 and p + 2*nx*ny <= end:
                    v = struct.unpack_from(f'<{nx*ny}H', d, p)
                    out.append(('KF', o, nx, ny, x, y, v))
                    o = p + 2*nx*ny
                    o += o & 1
                    continue
        o += 2
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('bin'); ap.add_argument('--start', type=lambda s: int(s, 0), default=0x220000)
    ap.add_argument('--end', type=lambda s: int(s, 0), default=0x2BE000)
    ap.add_argument('--dump', action='store_true')
    a = ap.parse_args()
    d = open(a.bin, 'rb').read()
    for kind, o, nx, ny, x, y, v in find(d, a.start, a.end):
        print(f"{kind},0x{o:06X},{nx}x{ny},x=[{x[0]}..{x[-1]}],y=[{y[0]}..{y[-1]}],v=[{min(v)}..{max(v)}]")
        if a.dump:
            print('      ' + ' '.join(f'{xx:6d}' for xx in x))
            for j in range(ny):
                # Bosch MED17 stores values column-major (y runs fastest)
                print(f'{y[j]:6d}' + ' '.join(f'{v[i*ny+j]:6d}' for i in range(nx)))
main()
