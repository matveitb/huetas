// Форматы маппаков: чтение и запись DAMOS (.dam, формат ASAP2DAM от Bosch)
// и A2L (ASAP2). Оба приводятся к общей модели из model.js -- в ней же
// живёт и ваш маппак, поэтому он пишется обратно в те же форматы.
//
// Разбор DAMOS -- тот же, что в tools/damos.py репозитория Ivanbl4, где он
// проверен на px5ns03d.dam и его образе. Оттуда же два установленных факта:
//   * в DAMOS ось X -- это СТРОКИ (медленный индекс), Y -- столбцы;
//   * в заголовке карты сначала счётчик строк, потом столбцов, затем ось
//     строк и ось столбцов; счётчики -- слова, только если обе оси словные.
(function (root) {
  "use strict";
  const ET = root.ET = root.ET || {};
  const M = () => ET.model;

  // ---------------------------------------------------------------- DAMOS

  const SPZ = /^(\d+),\s*\/SPZ,\s*([^,]+),\s*\{(.*?)\},\s*(\d+),\s*\$([0-9A-Fa-f]+),\s*\$([0-9A-Fa-f]+)/;
  const REG = /^(\d+),\s*\/REG,\s*([^,]+),\s*\{(.*?)\},\s*(\d+),\s*([^,]+),\s*\{(.*?)\},\s*(\d+),\s*([^,]+),\s*([^,]+),\s*(.+)$/;

  const num = s => { const v = parseFloat(s); return isNaN(v) ? 0 : v; };
  const int = s => { const v = parseInt(s, 10); return isNaN(v) ? 0 : v; };

  function fields(line) {
    const i = line.indexOf(",");
    if (i < 0) return [];
    return line.slice(i + 1).split(",").map(p => p.trim().replace(/;$/, "").trim());
  }

  function parseDamos(text) {
    const vars = [], convs = new Map(), segments = [], header = {};
    let v = null, c = null;
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith("/SND,")) {
        const p = line.slice(5).trim().replace(/;$/, "").split(/\s+/);
        if (p.length >= 3 && p[1][0] === "$" && p[2][0] === "$") {
          segments.push({ name: p[0], start: parseInt(p[1].slice(1), 16), end: parseInt(p[2].slice(1), 16) });
        }
        continue;
      }
      if (/^\/(EPK|SGB|EPR|UP|PNR),/.test(line)) {
        header[line.slice(1, line.indexOf(","))] = line.slice(line.indexOf(",") + 1).trim();
        continue;
      }
      let m = SPZ.exec(line);
      if (m) {
        v = {
          idx: int(m[1]), name: m[2].trim(), desc: m[3].trim(), typ: int(m[4]),
          addr: parseInt(m[5], 16), addr2: parseInt(m[6], 16),
          cw: 0, wmin: 0, wmax: 0, cx: 0, xref: 0, cy: 0, yref: 0, nx: 0, ny: 0,
        };
        vars.push(v); c = null;
        continue;
      }
      m = REG.exec(line);
      if (m) {
        c = { idx: int(m[1]), name: m[2].trim(), unit: m[6].trim(), pmin: num(m[9]), pmax: num(m[10]),
              rawMax: 0, off: 0, span: 0 };
        convs.set(c.idx, c); v = null;
        continue;
      }
      if (line.startsWith("/REP,") && c) {
        const p = fields(line);
        c.rawMax = int(p[0]); c.off = num(p[1]); c.span = num(p[3]);
        continue;
      }
      if (!v) continue;
      const p = fields(line);
      if (line.startsWith("/SPW,")) { v.cw = int(p[0]); v.wmin = num(p[2]); v.wmax = num(p[3]); }
      else if (line.startsWith("/SPX,")) { v.cx = int(p[0]); v.xmin = num(p[2]); v.xmax = num(p[3]); v.xref = int(p[4]); }
      else if (line.startsWith("/SPY,")) { v.cy = int(p[0]); v.ymin = num(p[2]); v.ymax = num(p[3]); v.yref = int(p[4]); }
      else if (line.startsWith("/FKX,")) v.nx = int(p[0]);
      else if (line.startsWith("/FKY,")) v.ny = int(p[0]);
      else if (line.startsWith("/ABL,")) v = null;
    }
    return { vars, convs, segments, header };
  }

  function convScale(c) {
    if (!c || !c.rawMax) return { factor: 1, offset: 0, unit: c ? c.unit : "" };
    return { factor: c.span / c.rawMax, offset: -c.off / c.rawMax, unit: c.unit };
  }

  // Ширина и знак величины. Надёжный источник -- метка в имени пересчёта
  // (ub, uw, sb, sw, ul, sl). "_@_SL" -- не метка ширины, а пометка оси.
  function damosCell(c, pmin, pmax) {
    if (c) {
      const nm = c.name.replace(/_@_SL$/i, "");
      const m = /(?:^|_)(ub|uw|sb|sw|ul|sl)(?:_|$)/i.exec(nm);
      if (m) {
        const t = m[1].toLowerCase();
        return (t[0] === "s" ? "s" : "u") + { b: "8", w: "16", l: "32" }[t[1]];
      }
    }
    // без метки -- по диапазону сырых значений
    const sc = convScale(c);
    const f = sc.factor || 1;
    const lo = ((pmin || 0) - sc.offset) / f, hi = ((pmax || 0) - sc.offset) / f;
    const signed = Math.min(lo, hi) < -0.5;
    const span = Math.max(Math.abs(lo), Math.abs(hi));
    if (span > (signed ? 32767.5 : 65535.5)) return signed ? "s32" : "u32";
    if (span > (signed ? 127.5 : 255.5)) return signed ? "s16" : "u16";
    return signed ? "s8" : "u8";
  }

  function damosToObjects(d) {
    const byIdx = new Map(d.vars.map(v => [v.idx, v]));
    const conv = id => d.convs.get(id);
    const out = [];
    const axisCell = v => damosCell(conv(v.cx), v.xmin, v.xmax);
    const axisFrom = (scaleConv, refVar) => {
      const sc = convScale(conv(scaleConv));
      if (refVar && refVar.typ === 6) {
        return { mode: "ref", ref: refVar.addr, refName: refVar.name, cell: axisCell(refVar),
                 factor: sc.factor, offset: sc.offset, unit: sc.unit };
      }
      return { mode: "none", factor: sc.factor, offset: sc.offset, unit: sc.unit };
    };
    for (const v of d.vars) {
      const sw = convScale(conv(v.cw));
      const base = {
        name: v.name, desc: v.desc, addr: v.addr, source: "DAMOS", typ: v.typ,
        factor: sw.factor, offset: sw.offset, unit: sw.unit,
        cell: damosCell(conv(v.cw), v.wmin, v.wmax),
      };
      let o = null;
      switch (v.typ) {
        case 1: o = Object.assign(base, { kind: "value" }); break;
        case 2: {
          const cx = axisCell(v), sx = convScale(conv(v.cx));
          o = Object.assign(base, {
            kind: "curve", layout: "bosch", header: ["nC", "aC"], cols: v.nx,
            countSize: M().cellOf(cx).size === 2 ? 2 : 1,
            axisC: { mode: "inline", cell: cx, factor: sx.factor, offset: sx.offset, unit: sx.unit },
          });
          break;
        }
        case 3: {
          const cx = axisCell(v), cy = damosCell(conv(v.cy), v.ymin, v.ymax);
          const sx = convScale(conv(v.cx)), sy = convScale(conv(v.cy));
          const both16 = M().cellOf(cx).size === 2 && M().cellOf(cy).size === 2;
          o = Object.assign(base, {
            kind: "map", layout: "bosch", header: ["nR", "nC", "aR", "aC"],
            rows: v.nx, cols: v.ny, countSize: both16 ? 2 : 1,
            axisR: { mode: "inline", cell: cx, factor: sx.factor, offset: sx.offset, unit: sx.unit },
            axisC: { mode: "inline", cell: cy, factor: sy.factor, offset: sy.offset, unit: sy.unit },
          });
          break;
        }
        case 4: case 7: {
          const ax = byIdx.get(v.xref);
          o = Object.assign(base, {
            kind: "curve", layout: "plain",
            cols: v.nx || (ax && ax.typ === 6 ? ax.nx : 0),
            axisC: axisFrom(v.cx, ax),
          });
          break;
        }
        case 5: case 8: {
          const ax = byIdx.get(v.xref), ay = byIdx.get(v.yref);
          o = Object.assign(base, {
            kind: "map", layout: "plain",
            rows: v.nx || (ax && ax.typ === 6 ? ax.nx : 0),
            cols: v.ny || (ay && ay.typ === 6 ? ay.nx : 0),
            axisR: axisFrom(v.cx, ax), axisC: axisFrom(v.cy, ay),
          });
          break;
        }
        case 6: {
          const cx = axisCell(v), sx = convScale(conv(v.cx));
          o = Object.assign(base, {
            kind: "axis", layout: "bosch", header: ["nC", "aC"], cols: v.nx, cell: cx,
            countSize: M().cellOf(cx).size === 2 ? 2 : 1,
            factor: sx.factor, offset: sx.offset, unit: sx.unit,
          });
          break;
        }
        case 12: o = Object.assign(base, { kind: "string", length: v.addr2 > v.addr ? v.addr2 - v.addr + 1 : 0 }); break;
        case 13: o = Object.assign(base, { kind: "block", cols: v.nx || 1 }); break;
        default: o = Object.assign(base, { kind: "value", note: "тип DAMOS " + v.typ }); break;
      }
      if ((o.kind === "curve" || o.kind === "axis" || o.kind === "block") && !o.cols) o.cols = 1;
      if (o.kind === "map") { o.cols = o.cols || 1; o.rows = o.rows || 1; }
      out.push(M().normalize(o));
    }
    return out;
  }

  // ------------------------------------------------------------------ A2L

  function tokenizeA2l(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const ch = src[i];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { i++; continue; }
      if (ch === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
      if (ch === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); i = j < 0 ? n : j + 1; continue; }
      if (ch === '"') {
        let s = "", j = i + 1;
        while (j < n) {
          if (src[j] === "\\" && j + 1 < n) { s += src[j + 1]; j += 2; continue; }
          if (src[j] === '"') {
            if (src[j + 1] === '"') { s += '"'; j += 2; continue; }
            break;
          }
          s += src[j++];
        }
        toks.push({ s: true, v: s });
        i = j + 1;
        continue;
      }
      let j = i;
      while (j < n && !/\s/.test(src[j])) j++;
      toks.push({ s: false, v: src.slice(i, j) });
      i = j;
    }
    return toks;
  }

  function parseA2lTree(src) {
    const toks = tokenizeA2l(src);
    const rootB = { kind: "ROOT", args: [], children: [] };
    const stack = [rootB];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t.s && t.v === "/begin") {
        const b = { kind: (toks[++i] || {}).v || "?", args: [], children: [] };
        stack[stack.length - 1].children.push(b);
        stack.push(b);
      } else if (!t.s && t.v === "/end") {
        i++;
        if (stack.length > 1) stack.pop();
      } else {
        stack[stack.length - 1].args.push(t);
      }
    }
    return rootB;
  }

  const argv = b => b.args.map(t => t.v);
  function kv(b, key, n) {
    for (let i = 0; i < b.args.length; i++) {
      if (!b.args[i].s && b.args[i].v === key) return b.args.slice(i + 1, i + 1 + n).map(t => t.v);
    }
    return null;
  }
  const all = (b, kind) => b.children.filter(c => c.kind === kind);
  const toInt = s => { const v = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10); return isNaN(v) ? 0 : v; };

  const DTYPE = {
    UBYTE: "u8", SBYTE: "s8", UWORD: "u16", SWORD: "s16", ULONG: "u32", SLONG: "s32",
    FLOAT32_IEEE: "f32",
  };

  function compu(b) {
    const a = argv(b);
    const cm = { name: a[0], kind: a[2] || "IDENTICAL", unit: a[4] || "", factor: 1, offset: 0, linear: true };
    const co = kv(b, "COEFFS", 6);
    const cl = kv(b, "COEFFS_LINEAR", 2);
    if (co) {
      const [ca, cb, cc, cd, ce, cf] = co.map(parseFloat);
      if (ca === 0 && cd === 0 && ce === 0 && cb !== 0) {
        cm.factor = cf / cb; cm.offset = -cc / cb;
      } else cm.linear = false;
    } else if (cl) {
      cm.factor = parseFloat(cl[0]); cm.offset = parseFloat(cl[1]);
    }
    return cm;
  }

  function layout(b) {
    const rl = { name: argv(b)[0], fnc: "u8", colDir: false, pos: {}, dt: {} };
    const f = kv(b, "FNC_VALUES", 3);
    if (f) { rl.fnc = DTYPE[f[1]] || "u8"; rl.colDir = f[2] === "COLUMN_DIR"; rl.pos.FNC = toInt(f[0]); }
    for (const k of ["AXIS_PTS_X", "AXIS_PTS_Y", "NO_AXIS_PTS_X", "NO_AXIS_PTS_Y"]) {
      const p = kv(b, k, 2);
      if (p) { rl.pos[k] = toInt(p[0]); rl.dt[k] = DTYPE[p[1]] || "u8"; }
    }
    return rl;
  }

  function parseA2l(text) {
    const tree = parseA2lTree(text);
    let proj = null;
    (function find(b) {
      for (const c of b.children) { if (c.kind === "PROJECT") { proj = c; return; } find(c); }
    })(tree);
    if (!proj) throw new Error("в файле нет блока PROJECT — это точно A2L?");
    const mod = all(proj, "MODULE")[0];
    if (!mod) throw new Error("в PROJECT нет MODULE");
    let be = false;
    for (const mc of all(mod, "MOD_COMMON")) {
      const bo = kv(mc, "BYTE_ORDER", 1);
      if (bo && /MSB_FIRST/.test(bo[0])) be = true;
    }
    const compus = new Map(), layouts = new Map(), axisPts = new Map();
    for (const c of all(mod, "COMPU_METHOD")) { const cm = compu(c); compus.set(cm.name, cm); }
    for (const c of all(mod, "RECORD_LAYOUT")) { const rl = layout(c); layouts.set(rl.name, rl); }
    const cmOf = n => compus.get(n) || { factor: 1, offset: 0, unit: "" };
    const out = [];

    for (const b of all(mod, "AXIS_PTS")) {
      const a = argv(b);
      // Name, Long, Address, InputQuantity, Deposit, MaxDiff, Conversion, MaxAxisPoints, Lower, Upper
      const rl = layouts.get(a[4]) || layout({ args: [], children: [] });
      const cm = cmOf(a[6]);
      const n = toInt(a[7]);
      const hasCount = "NO_AXIS_PTS_X" in rl.pos;
      const o = {
        name: a[0], desc: a[1] || "", addr: toInt(a[2]), kind: "axis", source: "A2L",
        cols: n, cell: rl.dt.AXIS_PTS_X || rl.fnc, factor: cm.factor, offset: cm.offset, unit: cm.unit,
        layout: hasCount ? "bosch" : "plain", header: ["nC", "aC"],
        countSize: hasCount ? M().cellOf(rl.dt.NO_AXIS_PTS_X).size : 1, be,
      };
      const bo = kv(b, "BYTE_ORDER", 1);
      if (bo) o.be = /MSB_FIRST/.test(bo[0]);
      axisPts.set(o.name, o);
      out.push(M().normalize(o));
    }

    for (const b of all(mod, "CHARACTERISTIC")) {
      const a = argv(b);
      // Name, Long, Type, Address, Deposit, MaxDiff, Conversion, Lower, Upper
      const type = a[2] || "VALUE";
      const rl = layouts.get(a[4]) || layout({ args: [], children: [] });
      const cm = cmOf(a[6]);
      const o = {
        name: a[0], desc: a[1] || "", addr: toInt(a[3]), source: "A2L",
        cell: rl.fnc, factor: cm.factor, offset: cm.offset, unit: cm.unit, be,
      };
      const bo = kv(b, "BYTE_ORDER", 1);
      if (bo) o.be = /MSB_FIRST/.test(bo[0]);
      const descrs = all(b, "AXIS_DESCR").map(d => {
        const x = argv(d);
        const ref = kv(d, "AXIS_PTS_REF", 1);
        const dc = cmOf(x[2]);
        return { attr: x[0], n: toInt(x[3]), ref: ref ? ref[0] : null, cm: dc };
      });
      const num = kv(b, "NUMBER", 1);
      const md = kv(b, "MATRIX_DIM", 3);
      const inline = ("AXIS_PTS_X" in rl.pos) || ("NO_AXIS_PTS_X" in rl.pos);
      const axisOf = (d, dt) => {
        if (!d) return { mode: "none" };
        const base = { factor: d.cm.factor, offset: d.cm.offset, unit: d.cm.unit };
        if (d.ref && axisPts.has(d.ref)) {
          const ap = axisPts.get(d.ref);
          return Object.assign(base, { mode: "ref", ref: ap.addr, refName: ap.name, cell: ap.cell });
        }
        if (d.attr === "STD_AXIS" && dt) return Object.assign(base, { mode: "inline", cell: dt });
        return Object.assign(base, { mode: "none" });
      };
      if (type === "VALUE") o.kind = "value";
      else if (type === "ASCII") { o.kind = "string"; o.length = num ? toInt(num[0]) : (md ? toInt(md[0]) : 0); }
      else if (type === "VAL_BLK") {
        o.kind = "block";
        const dims = md ? md.map(toInt).filter(Boolean) : [];
        o.cols = num ? toInt(num[0]) : (dims[0] || 1);
        if (dims.length > 1) o.rows = dims[1];
      } else if (type === "CURVE") {
        o.kind = "curve"; o.cols = descrs[0] ? descrs[0].n : 1;
        o.axisC = axisOf(descrs[0], rl.dt.AXIS_PTS_X);
        if (inline) {
          o.layout = "bosch";
          o.header = headerOrder(rl, { X: "C" });
          o.countSize = M().cellOf(rl.dt.NO_AXIS_PTS_X || "u8").size;
        }
      } else if (type === "MAP") {
        o.kind = "map";
        const dx = descrs[0], dy = descrs[1];
        const nx = dx ? dx.n : 1, ny = dy ? dy.n : 1;
        const ax = axisOf(dx, rl.dt.AXIS_PTS_X), ay = axisOf(dy, rl.dt.AXIS_PTS_Y);
        // COLUMN_DIR: по памяти быстрее меняется Y; ROW_DIR -- X
        if (rl.colDir) { o.cols = ny; o.rows = nx; o.axisC = ay; o.axisR = ax; }
        else { o.cols = nx; o.rows = ny; o.axisC = ax; o.axisR = ay; }
        if (inline) {
          o.layout = "bosch";
          o.header = headerOrder(rl, rl.colDir ? { X: "R", Y: "C" } : { X: "C", Y: "R" });
          o.countSize = M().cellOf(rl.dt.NO_AXIS_PTS_X || "u8").size;
        }
      } else continue;    // CUBOID и прочее тренажёр не сравнивает
      out.push(M().normalize(o));
    }
    return { objects: out };
  }

  // Порядок элементов заголовка -- по номерам позиций в RECORD_LAYOUT
  function headerOrder(rl, map) {
    const items = [];
    for (const [k, tag] of [["NO_AXIS_PTS_X", "nX"], ["NO_AXIS_PTS_Y", "nY"],
                            ["AXIS_PTS_X", "aX"], ["AXIS_PTS_Y", "aY"]]) {
      if (k in rl.pos) items.push([rl.pos[k], tag]);
    }
    items.sort((a, b) => a[0] - b[0]);
    return items.map(([, t]) => t[0] + (map[t[1]] || "C"));
  }

  // ------------------------------------------------------------- привязка

  // Уточнить размеры по счётчикам в самом образе: в A2L число точек -- это
  // максимум (MaxAxisPoints), а настоящее записано в заголовке.
  function refineWithImage(objs, data, toOff) {
    let checked = 0, agree = 0;
    for (const o of objs) {
      if (o.layout !== "bosch") continue;
      const g = M().geometry(o);
      for (const p of g.parts) {
        if (p.what !== "nR" && p.what !== "nC") continue;
        const v = M().readCell(data, toOff(p.addr), p.cell, o.be);
        const want = p.what === "nR" ? o.rows : o.cols;
        checked++;
        if (v === want) { agree++; continue; }
        if (o.source === "A2L" && v > 0 && v <= want) {
          if (p.what === "nR") o.rows = v; else o.cols = v;
          agree++;
        }
      }
    }
    return { checked, agree };
  }

  // Подобрать базу образа: при какой базе больше объектов попадает в файл и
  // больше счётчиков в заголовках совпадает с DAMOS. Считаем, а не гадаем.
  function scoreBase(objs, data, base) {
    let inside = 0, hdrOk = 0, hdr = 0;
    const size = data.length;
    for (const o of objs) {
      const off = o.addr - base;
      if (off < 0 || off >= size) continue;
      inside++;
      if (o.layout === "bosch") {
        hdr++;
        const g = M().geometry(o);
        const p = g.parts[0];
        if (p.what === "nR" || p.what === "nC") {
          const v = M().readCell(data, off, p.cell, o.be);
          if (v === (p.what === "nR" ? o.rows : o.cols)) hdrOk++;
        }
      }
    }
    return { base, inside, hdr, hdrOk, score: inside + 4 * hdrOk };
  }

  function suggestBases(objs, data, extra) {
    const cands = new Set([0, 0x800000, 0x80000, 0xC00000, 0x400000, 0x10000, 0x80000000, 0xA0000000]);
    for (const e of extra || []) cands.add(e);
    // база по наименьшему адресу объектов, выровненная на 64 КБ
    if (objs.length) {
      const lo = Math.min(...objs.map(o => o.addr));
      cands.add(lo - (lo % 0x10000));
      cands.add(lo - (lo % 0x100000));
    }
    return Array.from(cands).filter(b => b >= 0).map(b => scoreBase(objs, data, b))
      .sort((a, b) => b.score - a.score || a.base - b.base);
  }

  function loadReference(text, fileName) {
    const isA2l = /\/begin\s+PROJECT/i.test(text) || /\.a2l$/i.test(fileName || "");
    if (isA2l) {
      const r = parseA2l(text);
      return { format: "A2L", objects: r.objects, segments: [], header: {} };
    }
    if (/\/SPZ,/.test(text)) {
      const d = parseDamos(text);
      return { format: "DAMOS", objects: damosToObjects(d), segments: d.segments, header: d.header };
    }
    throw new Error("не похоже ни на DAMOS (.dam), ни на A2L");
  }

  // --------------------------------------------------------------- запись
  //
  // objs -- объекты с адресами CPU. Возвращает {text, warnings}. Всё, что
  // формат выразить не может, попадает в warnings, а не теряется молча.

  const A2L_DT = { u8: "UBYTE", s8: "SBYTE", u16: "UWORD", s16: "SWORD", u32: "ULONG", s32: "SLONG", f32: "FLOAT32_IEEE" };
  const TAG = { u8: "ub", s8: "sb", u16: "uw", s16: "sw", u32: "ul", s32: "sl" };

  function rawRange(cell) {
    const c = M().cellOf(cell);
    if (c.float) return [-1e6, 1e6];
    const bits = 8 * c.size;
    return c.signed ? [-Math.pow(2, bits - 1), Math.pow(2, bits - 1) - 1] : [0, Math.pow(2, bits) - 1];
  }
  function physRange(cell, factor, offset) {
    const [a, b] = rawRange(cell).map(v => v * (factor === undefined ? 1 : factor) + (offset || 0));
    return [Math.min(a, b), Math.max(a, b)];
  }
  const fnum = v => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12))));
  const hexAddr = v => "0x" + (v >>> 0).toString(16).toUpperCase();

  // Имена: только буквы, цифры, "_" и уникальные
  function uniqueNames(objs) {
    const used = new Set(), out = new Map();
    for (const o of objs) {
      let n = String(o.name || "").replace(/[^A-Za-z0-9_.]/g, "_");
      if (!n || /^[0-9.]/.test(n)) n = (o.kind === "axis" ? "AX_" : "OBJ_") + (o.addr >>> 0).toString(16).toUpperCase() + (n ? "_" + n : "");
      let k = n, i = 2;
      while (used.has(k)) k = n + "_" + i++;
      used.add(k); out.set(o, k);
    }
    return out;
  }

  function writeA2l(objs, opts) {
    opts = opts || {};
    const warnings = [];
    const names = uniqueNames(objs);
    const axisAt = new Map(objs.filter(o => o.kind === "axis").map(o => [o.addr, o]));
    const layouts = new Map(), compus = new Map();
    const q = s => '"' + String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

    // физ = f*сырое - c, то есть int = (1*физ + c) / f
    function cmName(factor, offset, unit) {
      if (factor === 1 && !offset && !unit) return "NO_COMPU_METHOD";
      const key = fnum(factor) + "|" + fnum(offset || 0) + "|" + (unit || "");
      if (!compus.has(key)) {
        const name = "CM_" + (compus.size + 1);
        compus.set(key, { name, text: [
          "    /begin COMPU_METHOD " + name + ' "" RAT_FUNC "%.4" ' + q(unit),
          "      COEFFS 0 1 " + fnum(-(offset || 0)) + " 0 0 " + fnum(factor),
          "    /end COMPU_METHOD"].join("\n") });
      }
      return compus.get(key).name;
    }
    function rl(items) {
      const name = "RL_" + items.map(i => i[0].replace(/_PTS/, "").replace(/^NO_AXIS/, "N").replace(/^AXIS/, "A").replace("FNC_VALUES", "V") + "_" + i[1]).join("_");
      if (!layouts.has(name)) {
        const body = items.map((it, k) => {
          const [kind, dt] = it;
          if (kind === "FNC_VALUES") return "      FNC_VALUES " + (k + 1) + " " + dt + " COLUMN_DIR DIRECT";
          if (kind.startsWith("AXIS_PTS")) return "      " + kind + " " + (k + 1) + " " + dt + " INDEX_INCR DIRECT";
          return "      " + kind + " " + (k + 1) + " " + dt;
        });
        layouts.set(name, ["    /begin RECORD_LAYOUT " + name].concat(body, ["    /end RECORD_LAYOUT"]).join("\n"));
      }
      return name;
    }
    const dt = cell => A2L_DT[cell] || "UBYTE";
    const cntDt = o => (o.countSize === 2 ? "UWORD" : "UBYTE");

    function axisDescr(o, key, n) {
      const a = o[key];
      const [lo, hi] = physRange(a.cell || "u8", a.factor, a.offset);
      const c = cmName(a.factor === undefined ? 1 : a.factor, a.offset, a.unit);
      if (a.mode === "ref") {
        const ax = axisAt.get(a.ref);
        if (ax) return ["      /begin AXIS_DESCR COM_AXIS NO_INPUT_QUANTITY " + c + " " + n + " " + fnum(lo) + " " + fnum(hi),
                        "        AXIS_PTS_REF " + names.get(ax), "      /end AXIS_DESCR"];
        warnings.push(names.get(o) + ": ось по " + hexAddr(a.ref) + " не размечена — записана как FIX_AXIS");
      }
      if (a.mode === "inline" && o.layout === "bosch") {
        return ["      /begin AXIS_DESCR STD_AXIS NO_INPUT_QUANTITY " + c + " " + n + " " + fnum(lo) + " " + fnum(hi), "      /end AXIS_DESCR"];
      }
      return ["      /begin AXIS_DESCR FIX_AXIS NO_INPUT_QUANTITY " + c + " " + n + " " + fnum(lo) + " " + fnum(hi),
              "        FIX_AXIS_PAR_DIST 0 1 " + n, "      /end AXIS_DESCR"];
    }

    const chars = [], axes = [];
    for (const o0 of objs) {
      const o = M().normalize(o0);
      const name = names.get(o0);
      const be = o.be ? ["      BYTE_ORDER MSB_FIRST"] : [];
      if (o.kind === "axis") {
        const lay = o.layout === "bosch" ? rl([["NO_AXIS_PTS_X", cntDt(o)], ["AXIS_PTS_X", dt(o.cell)]]) : rl([["AXIS_PTS_X", dt(o.cell)]]);
        const [lo, hi] = physRange(o.cell, o.factor, o.offset);
        axes.push(["    /begin AXIS_PTS " + name + " " + q(o.desc) + " " + hexAddr(o.addr) + " NO_INPUT_QUANTITY " + lay + " 0 " +
          cmName(o.factor, o.offset, o.unit) + " " + o.cols + " " + fnum(lo) + " " + fnum(hi)].concat(be, ["    /end AXIS_PTS"]).join("\n"));
        continue;
      }
      const [lo, hi] = physRange(o.kind === "string" ? "u8" : o.cell, o.factor, o.offset);
      let type, lay, extra = [];
      const c = o.kind === "string" ? "NO_COMPU_METHOD" : cmName(o.factor, o.offset, o.unit);
      if (o.kind === "value") { type = "VALUE"; lay = rl([["FNC_VALUES", dt(o.cell)]]); }
      else if (o.kind === "string") { type = "ASCII"; lay = rl([["FNC_VALUES", "UBYTE"]]); extra.push("      NUMBER " + Math.max(1, o.length || 1)); }
      else if (o.kind === "block") {
        type = "VAL_BLK"; lay = rl([["FNC_VALUES", dt(o.cell)]]);
        extra.push(o.rows > 1 ? "      MATRIX_DIM " + o.cols + " " + o.rows + " 1" : "      NUMBER " + o.cols);
      } else if (o.kind === "curve") {
        type = "CURVE";
        if (o.layout === "bosch") {
          const items = [["NO_AXIS_PTS_X", cntDt(o)]];
          if (o.axisC.mode === "inline") items.push(["AXIS_PTS_X", dt(o.axisC.cell)]);
          items.push(["FNC_VALUES", dt(o.cell)]);
          lay = rl(items);
        } else lay = rl([["FNC_VALUES", dt(o.cell)]]);
        extra = extra.concat(axisDescr(o, "axisC", o.cols));
      } else if (o.kind === "map") {
        type = "MAP";
        if (o.layout === "bosch") {
          // X -- строки, Y -- столбцы, данные COLUMN_DIR (быстрее меняется Y)
          const tok = { nR: ["NO_AXIS_PTS_X", cntDt(o)], nC: ["NO_AXIS_PTS_Y", cntDt(o)],
                        aR: o.axisR.mode === "inline" ? ["AXIS_PTS_X", dt(o.axisR.cell)] : null,
                        aC: o.axisC.mode === "inline" ? ["AXIS_PTS_Y", dt(o.axisC.cell)] : null };
          lay = rl(o.header.map(h => tok[h]).filter(Boolean).concat([["FNC_VALUES", dt(o.cell)]]));
        } else lay = rl([["FNC_VALUES", dt(o.cell)]]);
        extra = extra.concat(axisDescr(o, "axisR", o.rows), axisDescr(o, "axisC", o.cols));
      } else continue;
      chars.push(["    /begin CHARACTERISTIC " + name + " " + q(o.desc) + " " + type + " " + hexAddr(o.addr) + " " + lay + " 0 " + c + " " + fnum(lo) + " " + fnum(hi)]
        .concat(be, extra, ["    /end CHARACTERISTIC"]).join("\n"));
    }
    const proj = String(opts.project || "ECU").replace(/[^A-Za-z0-9_]/g, "_") || "ECU";
    const text = [
      "/* Маппак: " + (opts.comment || "") + " */",
      "/* Создан ЭБУ hex-тренажёром, " + objs.length + " объектов */",
      "ASAP2_VERSION 1 61",
      "/begin PROJECT " + proj + ' ""',
      "  /begin MODULE " + proj + ' ""',
      '    /begin MOD_COMMON "" BYTE_ORDER MSB_LAST ALIGNMENT_BYTE 1 ALIGNMENT_WORD 1 ALIGNMENT_LONG 1 /end MOD_COMMON',
      Array.from(compus.values()).map(c => c.text).join("\n"),
      Array.from(layouts.values()).join("\n"),
      axes.join("\n"),
      chars.join("\n"),
      "  /end MODULE",
      "/end PROJECT", ""].filter(s => s !== "").join("\n");
    return { text, warnings };
  }

  function writeDamos(objs, opts) {
    opts = opts || {};
    const warnings = [];
    const names = uniqueNames(objs);
    const idx = new Map();
    objs.forEach((o, i) => idx.set(o, i + 1));
    const axisAt = new Map(objs.filter(o => o.kind === "axis").map(o => [o.addr, o]));
    const convs = new Map();
    function conv(cell, factor, offset, unit) {
      if (cell === "f32") cell = "u32";
      const key = cell + "|" + fnum(factor) + "|" + fnum(offset || 0) + "|" + (unit || "");
      if (!convs.has(key)) {
        const id = convs.size + 1;
        const [lo, hi] = physRange(cell, factor, offset);
        convs.set(key, { id, text: id + ", /REG, cv" + id + "_" + (TAG[cell] || "ub") + ", {}, 6, 0, {" + (unit || "") + "}, 4, 5, " + fnum(lo) + ", " + fnum(hi) +
          "\r\n/REP, 1, " + fnum(-(offset || 0)) + ", 0, " + fnum(factor) + ", 0, 0;" });
      }
      return convs.get(key).id;
    }
    const rng = (cell, f, o) => physRange(cell, f, o).map(num).join(", ");
    const vars = [];
    for (const o0 of objs) {
      const o = M().normalize(o0);
      const n = names.get(o0);
      if (o.be) warnings.push(n + ": в DAMOS нет big-endian — записан как little-endian");
      if (o.cell === "f32") warnings.push(n + ": в DAMOS нет float — записан как 32-битное целое");
      let typ, addr2 = o.addr, w = [0, "0, 0"], x = [0, "0, 0", 0], y = [0, "0, 0", 0], nx = 0, ny = 0;
      const W = () => [conv(o.cell, o.factor, o.offset, o.unit), rng(o.cell, o.factor, o.offset)];
      const AX = (a, ref) => [conv(ref ? ref.cell : (a.cell || "u8"), a.factor === undefined ? 1 : a.factor, a.offset, a.unit),
                              rng(ref ? ref.cell : (a.cell || "u8"), a.factor === undefined ? 1 : a.factor, a.offset), ref ? idx.get(ref) : 0];
      const refOf = a => {
        if (a.mode !== "ref") return null;
        const r = axisAt.get(a.ref);
        if (!r) warnings.push(n + ": ось по " + hexAddr(a.ref) + " не размечена — ссылка не записана");
        return r || null;
      };
      switch (o.kind) {
        case "value": typ = 1; w = W(); break;
        case "string": typ = 12; addr2 = o.addr + Math.max(1, o.length || 1) - 1; break;
        case "block":
          typ = 13; w = W(); nx = o.cols * Math.max(1, o.rows);
          if (o.rows > 1) warnings.push(n + ": двумерный блок записан одномерным (" + nx + ")");
          break;
        case "axis":
          typ = 6; x = AX({ cell: o.cell, factor: o.factor, offset: o.offset, unit: o.unit }, null); nx = o.cols;
          if (o.layout !== "bosch") warnings.push(n + ": ось без счётчика — в DAMOS ось всегда со счётчиком");
          else if (o.countSize !== M().cellOf(o.cell).size) warnings.push(n + ": ширина счётчика оси в DAMOS равна ширине точек");
          break;
        case "curve":
          w = W(); nx = o.cols;
          if (o.layout === "bosch" && o.axisC.mode === "inline") {
            typ = 2; x = AX(o.axisC, null);
            if (o.countSize !== M().cellOf(o.axisC.cell).size) warnings.push(n + ": ширина счётчика кривой в DAMOS равна ширине точек оси");
          } else {
            const r = refOf(o.axisC);
            typ = r ? 7 : 4; x = AX(o.axisC, r);
            if (o.layout === "bosch") warnings.push(n + ": заголовок без оси внутри DAMOS не выражает — записано без заголовка");
          }
          break;
        case "map":
          w = W(); nx = o.rows; ny = o.cols;
          if (o.layout === "bosch" && o.axisR.mode === "inline" && o.axisC.mode === "inline") {
            typ = 3; x = AX(o.axisR, null); y = AX(o.axisC, null);
            const both16 = M().cellOf(o.axisR.cell).size === 2 && M().cellOf(o.axisC.cell).size === 2;
            if (o.countSize !== (both16 ? 2 : 1)) warnings.push(n + ": в DAMOS счётчики карты словные, только если обе оси словные");
            if (o.header.join() !== "nR,nC,aR,aC") warnings.push(n + ": в DAMOS заголовок всегда «строки, столбцы» — порядок изменён");
          } else {
            const rr = refOf(o.axisR), rc = refOf(o.axisC);
            typ = (rr || rc) ? 8 : 5; x = AX(o.axisR, rr); y = AX(o.axisC, rc);
            if (o.layout === "bosch") warnings.push(n + ": заголовок без обеих осей внутри DAMOS не выражает — записано без заголовка");
          }
          break;
        default: continue;
      }
      const h = v => "$" + (v >>> 0).toString(16).toUpperCase();
      const desc = String(o.desc || "").replace(/[{}\r\n]/g, " ");
      vars.push([
        idx.get(o0) + ", /SPZ, " + n + ", {" + desc + "}, " + typ + ", " + h(o.addr) + ", " + h(addr2),
        "/SPW, " + w[0] + ", 0, " + w[1],
        "/SPX, " + x[0] + ", 0, " + x[1] + ", " + x[2],
        "/SPY, " + y[0] + ", 0, " + y[1] + ", " + y[2],
        "/FKX, " + nx + ", 0, 0",
        "/FKY, " + ny + ", 0, 0",
        "/ABL, 0;", ""].join("\r\n"));
    }
    const lines = [
      "*** Created by ECU hex trainer ***",
      "/EPR, {" + String(opts.project || "ECU").replace(/[{}]/g, "") + "}, {mappack}, DAMPAR_03",
      "/EPK, {" + String(opts.comment || "").replace(/[{}]/g, "") + "}",
      "/SPC, " + objs.length,
      "/UMR, " + convs.size,
    ];
    if (opts.size) lines.push("/SND, DATA1 $" + (opts.base >>> 0).toString(16).toUpperCase() + " $" + ((opts.base + opts.size - 1) >>> 0).toString(16).toUpperCase());
    lines.push(";", "");
    const text = lines.join("\r\n") + "\r\n" + vars.join("\r\n") + "\r\n" + Array.from(convs.values()).map(c => c.text).join("\r\n\r\n") + "\r\n";
    return { text, warnings };
  }

  // Текст в cp1251 -- так DAMOS пишут исторически
  function encodeCp1251(text) {
    const tbl = M().CP1251, rev = new Map();
    tbl.forEach((ch, i) => rev.set(ch, i));
    const out = new Uint8Array(text.length);
    let n = 0;
    for (const ch of text) out[n++] = rev.has(ch) ? rev.get(ch) : 0x3F;
    return out.slice(0, n);
  }

  ET.fmt = {
    parseDamos, damosToObjects, parseA2l, parseA2lTree, tokenizeA2l, loadReference,
    refineWithImage, suggestBases, scoreBase, damosCell, convScale,
    writeA2l, writeDamos, encodeCp1251, uniqueNames,
  };
})(typeof window !== "undefined" ? window : globalThis);
