import sys, struct
d = open(sys.argv[1],'rb').read()
BASE=0xC00000; lo, hi = 0x80000, 0x88000
cal = d[lo:hi]
WIDTHS=[8,9,10,11,12,13,14,15,16,17,18,20,21,24,32]

def getrow(p,W,word):
    if word: return list(struct.unpack_from('<%dH'%W, cal, p)) if p+2*W<=len(cal) else None
    return list(cal[p:p+W]) if p+W<=len(cal) else None

def run(o,W,word):
    st=2 if word else 1; n=0; prev=None; p=o
    while True:
        r=getrow(p,W,word)
        if r is None: break
        if len(set(r))==1 and r[0] in (0,0xFF,0xFFFF): break
        tol = (max(r)*0.12+3) if word else 14
        if sum(abs(r[i]-r[i-1]) for i in range(1,W))/(W-1) > tol: break
        if prev and sum(abs(r[i]-prev[i]) for i in range(W))/W > tol: break
        if word and max(r) < 16: break
        prev=r; p+=W*st; n+=1
    return n

res=[]
for word in (False, True):
    st=2 if word else 1
    used=bytearray(len(cal)) if not word else used8
    o=0
    while o < len(cal)-8*st:
        if used[o]: o+=st; continue
        best=None
        for W in WIDTHS:
            n=run(o,W,word)
            if n>=5:
                blk=sum((getrow(o+i*W*st,W,word) for i in range(n)),[])
                if len(set(blk))<6: continue
                area=n*W
                if best is None or area>best[2]: best=(W,n,area,blk)
        if best:
            W,n,area,blk=best
            res.append((o,'u16' if word else 'u8',n,W,min(blk),max(blk),blk[:W]))
            for i in range(o,o+area*st): used[i]=1
            o+=area*st
        else: o+=st
    if not word: used8=used

for o,t,n,W,mn,mx,r0 in sorted(res):
    print(f"{BASE+lo+o:06X}\t{t}\t{n}x{W}\t{mn}..{mx}\t{r0[:16]}")
