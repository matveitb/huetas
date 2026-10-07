import sys, math, collections
d = open(sys.argv[1],'rb').read()
B = 0x4000
print("size", hex(len(d)))
for off in range(0, len(d), B):
    blk = d[off:off+B]
    c = collections.Counter(blk)
    ent = -sum(v/len(blk)*math.log2(v/len(blk)) for v in c.values())
    ff = c[0xff]/len(blk); z = c[0]/len(blk)
    print(f"{0xC00000+off:06X} file+{off:05X} ent={ent:4.2f} ff={ff:4.2f} 00={z:4.2f}")
