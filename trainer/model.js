// Общая модель калибровочного объекта: и ваш маппак, и DAMOS/A2L
// приводятся к одному виду, иначе их нельзя честно сравнить.
//
// Объект (все адреса -- адреса CPU, как в Ghidra и в DAMOS):
//   name, desc
//   kind    value | curve | map | axis | block | string
//   addr    начало записи (для раскладки Bosch -- первый счётчик)
//   layout  plain -- по адресу сразу данные
//           bosch -- перед данными счётчики и оси (порядок -- header)
//   header  порядок элементов заголовка: nR nC aR aC (по умолчанию так,
//           как лежит у Bosch: счётчик строк, счётчик столбцов, ось строк,
//           ось столбцов); для кривой и оси -- nC aC
//   countSize  ширина счётчика, 1 или 2 байта
//   cols    число точек по БЫСТРОМУ индексу -- соседние ячейки в памяти
//   rows    число точек по медленному индексу
//   cell    u8 s8 u16 s16 u32 s32 f32
//   be      true -- старший байт первым (по умолчанию little-endian, как C166)
//   factor, offset, unit -- физ = сырое * factor + offset
//   axisC, axisR -- оси столбцов и строк:
//           {mode: none | inline | ref, ref: адрес записи оси, cell, factor, offset, unit}
//
// "Столбцы" и "строки" здесь -- про память, а не про подписи X/Y: у Bosch
// ось X в DAMOS -- это строки (медленный индекс), а в A2L всё зависит от
// ROW_DIR/COLUMN_DIR. Сравнивать по X/Y значило бы сравнивать соглашения.
(function (root) {
  "use strict";
  const ET = root.ET = root.ET || {};

  const CELLS = {
    u8: { size: 1, signed: false }, s8: { size: 1, signed: true },
    u16: { size: 2, signed: false }, s16: { size: 2, signed: true },
    u32: { size: 4, signed: false }, s32: { size: 4, signed: true },
    f32: { size: 4, signed: true, float: true },
  };

  const KINDS = {
    value: "значение", curve: "кривая", map: "карта", axis: "ось",
    block: "блок значений", string: "строка",
  };

  function cellOf(name) { return CELLS[name] || CELLS.u8; }

  function readCell(data, off, cell, be) {
    const c = cellOf(cell);
    if (off < 0 || off + c.size > data.length) return NaN;
    if (c.float) {
      const dv = new DataView(data.buffer, data.byteOffset + off, 4);
      return dv.getFloat32(0, !be);
    }
    let v = 0;
    if (be) for (let i = 0; i < c.size; i++) v = v * 256 + data[off + i];
    else for (let i = c.size - 1; i >= 0; i--) v = v * 256 + data[off + i];
    if (c.signed) {
      const lim = Math.pow(2, 8 * c.size - 1);
      if (v >= lim) v -= 2 * lim;
    }
    return v;
  }

  function defaultHeader(kind) {
    return kind === "map" ? ["nR", "nC", "aR", "aC"] : ["nC", "aC"];
  }

  function axisDefaults() {
    return { mode: "none", ref: null, cell: "u8", factor: 1, offset: 0, unit: "" };
  }

  // Заполнить пропущенные поля -- объект из любого источника становится полным
  function normalize(o) {
    const n = Object.assign({
      name: "", desc: "", kind: "value", addr: 0, layout: "plain", header: null,
      countSize: 1, cols: 1, rows: 1, cell: "u8", be: false,
      factor: 1, offset: 0, unit: "", length: 0, comment: "",
    }, o);
    n.axisC = Object.assign(axisDefaults(), o.axisC || {});
    n.axisR = Object.assign(axisDefaults(), o.axisR || {});
    if (n.kind === "value") { n.cols = 1; n.rows = 1; }
    if (n.kind === "curve" || n.kind === "axis" || n.kind === "block") n.rows = n.rows || 1;
    if (n.kind !== "map") { n.rows = Math.max(1, n.kind === "block" ? n.rows : 1); }
    if (n.layout === "bosch" && !n.header) n.header = defaultHeader(n.kind);
    if (n.kind === "axis") {
      // у оси точки -- это и есть её значения
      n.axisC.mode = "none"; n.axisR.mode = "none";
    }
    return n;
  }

  // Геометрия: где что лежит. Возвращает части в порядке памяти.
  //   {start, dataAddr, end, parts: [{what, addr, n, cell}]}
  // what: nR nC (счётчики), aR aC (оси внутри записи), data, str
  function geometry(o) {
    o = o.axisC ? o : normalize(o);
    const parts = [];
    let a = o.addr;
    if (o.kind === "string") {
      const len = Math.max(1, o.length || 1);
      parts.push({ what: "str", addr: a, n: len, cell: "u8", size: len });
      return { start: o.addr, dataAddr: o.addr, end: o.addr + len, parts };
    }
    if (o.layout === "bosch") {
      for (const h of o.header || defaultHeader(o.kind)) {
        if (h === "nR" || h === "nC") {
          if (h === "nR" && o.kind !== "map") continue;
          parts.push({ what: h, addr: a, n: 1, cell: o.countSize === 2 ? "u16" : "u8", size: o.countSize });
          a += o.countSize;
        } else if (h === "aR" || h === "aC") {
          const ax = h === "aR" ? o.axisR : o.axisC;
          const n = h === "aR" ? o.rows : o.cols;
          if (h === "aR" && o.kind !== "map") continue;
          if (o.kind === "axis") continue;   // у оси точки -- это данные
          if (ax.mode !== "inline") continue;
          const sz = cellOf(ax.cell).size * n;
          parts.push({ what: h, addr: a, n, cell: ax.cell, size: sz });
          a += sz;
        }
      }
    }
    const n = o.cols * o.rows;
    const sz = cellOf(o.cell).size * n;
    const dataAddr = a;
    parts.push({ what: "data", addr: a, n, cell: o.cell, size: sz });
    a += sz;
    return { start: o.addr, dataAddr, end: a, parts };
  }

  // Прочитать объект из образа. toOff(addr) -> смещение в файле.
  function readObject(o, data, toOff, resolveAxis) {
    const g = geometry(o);
    const res = { geom: g, values: [], axisC: null, axisR: null, counts: {} };
    for (const p of g.parts) {
      const off = toOff(p.addr);
      const vals = [];
      const sz = cellOf(p.cell).size;
      for (let i = 0; i < p.n && p.what !== "str"; i++) vals.push(readCell(data, off + i * sz, p.cell, o.be));
      if (p.what === "nR" || p.what === "nC") res.counts[p.what] = vals[0];
      else if (p.what === "aR") res.axisR = scaleAll(vals, o.axisR);
      else if (p.what === "aC") res.axisC = scaleAll(vals, o.axisC);
      else if (p.what === "data") { res.raw = vals; res.values = vals.map(v => v * o.factor + o.offset); }
      else if (p.what === "str") {
        res.text = decodeText(data, off, p.n);
      }
    }
    for (const [key, n] of [["axisC", o.cols], ["axisR", o.rows]]) {
      const ax = o[key];
      if (res[key] || ax.mode !== "ref" || !resolveAxis) continue;
      const axObj = resolveAxis(ax.ref);
      if (axObj) {
        const r = readObject(axObj, data, toOff);
        res[key] = r.values.slice(0, n);
        res[key + "Obj"] = axObj;
      }
    }
    return res;
  }

  function scaleAll(vals, ax) {
    return vals.map(v => v * (ax.factor === undefined ? 1 : ax.factor) + (ax.offset || 0));
  }

  // Строки в прошивках из России -- обычно cp1251
  const CP1251 = (function () {
    const t = [];
    const hi = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї";
    for (let i = 0; i < 0x80; i++) t.push(String.fromCharCode(i));
    for (let i = 0; i < 0x40; i++) t.push(hi[i]);
    for (let i = 0; i < 0x40; i++) t.push(String.fromCharCode(0x410 + i));
    return t;
  })();

  function decodeText(data, off, n) {
    let s = "";
    for (let i = 0; i < n && off + i < data.length; i++) {
      const b = data[off + i];
      if (b === 0) break;
      s += b < 0x20 ? "\\x" + b.toString(16).padStart(2, "0") : CP1251[b];
    }
    return s;
  }

  function isPrintable(b) { return (b >= 0x20 && b < 0x7F) || b >= 0xC0 || b === 0xA8 || b === 0xB8; }

  function fmtNum(v, digits) {
    if (!isFinite(v)) return "—";
    if (Number.isInteger(v)) return String(v);
    const d = digits === undefined ? 4 : digits;
    return String(Number(v.toFixed(d)));
  }

  function hex(v, n) { return (v >>> 0).toString(16).toUpperCase().padStart(n || 0, "0"); }

  function describe(o) {
    o = normalize(o);
    let s = KINDS[o.kind] || o.kind;
    if (o.kind === "map") s += " " + o.cols + "×" + o.rows;
    else if (o.kind !== "value" && o.kind !== "string") s += " " + o.cols;
    if (o.kind === "string") s += " [" + o.length + "]";
    else s += " " + o.cell + (o.be ? " BE" : "");
    if (o.factor !== 1 || o.offset) s += " ×" + fmtNum(o.factor, 6) + (o.offset ? (o.offset > 0 ? " +" : " ") + fmtNum(o.offset, 6) : "");
    if (o.unit) s += " " + o.unit;
    if (o.layout === "bosch") s += " [заголовок]";
    return s;
  }

  ET.model = {
    CELLS, KINDS, cellOf, readCell, normalize, geometry, readObject,
    decodeText, isPrintable, defaultHeader, fmtNum, hex, describe, CP1251,
  };
})(typeof window !== "undefined" ? window : globalThis);
