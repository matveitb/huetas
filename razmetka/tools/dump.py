import sys
d=open(sys.argv[1],'rb').read(); a=int(sys.argv[2],16)-0xC00000; n=int(sys.argv[3],0); W=int(sys.argv[4]) if len(sys.argv)>4 else 16
for o in range(a, a+n, W):
    print(f"{o+0xC00000:06X}: " + " ".join(f"{b:3d}" for b in d[o:o+W]))
