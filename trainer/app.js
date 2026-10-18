// ЭБУ hex-тренажёр: интерфейс.
//
// Устроен как WinOLS: меню и панель инструментов сверху, слева окно
// «Карты», в центре вкладки (hex-дамп и открытые карты), справа значения
// под курсором, внизу строка состояния. Только чтение.
//
// Поверх байтов -- до трёх слоёв:
//   * ваш маппак (заливка): карты, кривые, оси, которые вы разметили сами
//     и сохраняете в A2L или DAMOS;
//   * эталон (подчёркивание): DAMOS или A2L, с которым идёт сверка. Для
//     тренировки его можно скрыть -- тогда он молчит до сверки;
//   * сравнение (красный цвет): байты, которыми прошивка отличается от
//     второго файла, например сток от тюна.
// Адреса -- адреса CPU: база образа + смещение в файле, как Base Address
// в Ghidra и как адреса в DAMOS/A2L.
(function () {
  "use strict";
  const M = ET.model, F = ET.fmt, MK = ET.markup, CMP = ET.compare;
  const LINE_H = 18;

  // ------------------------------------------------------------ состояние
  const S = {
    fw: null,                 // {name, size, data, crc}
    base: 0,
    pack: null,               // ваш маппак (адреса -- смещения в файле)
    ref: null,                // {name, format, raw, objects (CPU), shift, pack (смещения)}
    hideRef: false,
    cmp: null,                // {name, size, data, crc, blocks, bytes}
    cur: 0, sel: null, anchor: null, top: 0,
    hist: [], fwd: [],
    showOff: false, showInsp: true,
    vw: { cols: 16, cell: "u8", be: false, fmt: "hex", mode: "text", org: 0 },
    rot: { az: -0.7, el: 0.6 },
    tabs: [], tab: "hex",     // вкладки карт: {key, src: mine|ref, name, addr}
    mapView: "table", mapFmt: "phys", mapCmp: "cur", mapCell: { r: 0, c: 0 },
    dock: "pack", filter: { pack: "", ref: "" }, refKind: "all", diffGroup: "maps",
    sort: { pack: { k: "addr", d: 1 }, ref: { k: "addr", d: 1 } },
    checkOpts: { kinds: ["map", "curve"], lo: "", hi: "", reveal: false },
    lastCheck: null, lastSearch: null,
    undo: [], redo: [],
  };

  // ---------------------------------------------------------------- утилиты
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "html") e.innerHTML = v;
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : String(c));
    return e;
  }
  let toastT = 0;
  function toast(msg, ms) {
    const t = $("#toast");
    t.textContent = msg; t.style.display = "block";
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.style.display = "none"), ms || 2600);
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type: type || "text/plain" });
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // Архив .zip без сжатия: в опубликованной странице сохранять можно только
  // файлы из белого списка расширений, .a2l и .dam в него не входят
  function makeZip(name, bytes) {
    const nm = new TextEncoder().encode(name);
    const crc = parseInt(crc32(bytes), 16);
    const local = new DataView(new ArrayBuffer(30)), cen = new DataView(new ArrayBuffer(46)), end = new DataView(new ArrayBuffer(22));
    const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const head = (v, sig, off) => {
      v.setUint32(0, sig, true);
      let o = 4;
      if (sig === 0x02014b50) { v.setUint16(o, 20, true); o += 2; }
      v.setUint16(o, 20, true); v.setUint16(o + 2, 0x0800, true); v.setUint16(o + 4, 0, true);
      v.setUint16(o + 6, time, true); v.setUint16(o + 8, date, true);
      v.setUint32(o + 10, crc, true); v.setUint32(o + 14, bytes.length, true); v.setUint32(o + 18, bytes.length, true);
      v.setUint16(o + 22, nm.length, true);
      if (sig === 0x02014b50) v.setUint32(42, off, true);
    };
    head(local, 0x04034b50, 0);
    head(cen, 0x02014b50, 0);
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
    end.setUint32(12, 46 + nm.length, true); end.setUint32(16, 30 + nm.length + bytes.length, true);
    return new Blob([local, nm, bytes, cen, nm, end], { type: "application/zip" });
  }

  // Сохранить файл: в опубликованной странице -- через просмотрщик, в zip;
  // при локальном запуске -- обычным скачиванием
  async function saveFile(name, bytes) {
    const cl = window.claude && typeof window.claude.use === "function" ? window.claude : null;
    const dl = cl ? await cl.use("downloads") : null;
    if (!dl) { download(name, bytes, "application/octet-stream"); return true; }
    try {
      await dl.save({ filename: name + ".zip", data: makeZip(name, bytes) });
      toast("Сохранено: " + name + " (внутри " + name + ".zip)", 4000);
      return true;
    } catch (e) {
      toast(e && e.code === "declined" ? "Сохранение отменено" : "Не удалось сохранить: " + ((e && (e.message || e.code)) || e), 5000);
      return false;
    }
  }

  function pickFile(accept) {
    return new Promise(res => {
      const inp = $("#fileIn");
      inp.value = ""; inp.accept = accept || "";
      inp.onchange = () => res(inp.files[0] || null);
      inp.click();
    });
  }
  async function readText(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder("windows-1251").decode(buf); }
  }
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(d) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
    return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, "0");
  }
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };

  // ----------------------------------------------------------------- адреса
  const size = () => (S.fw ? S.fw.size : 0);
  const data = () => S.fw.data;
  const hexl = (v, n) => (v >>> 0).toString(16).padStart(n || 0, "0").toUpperCase();
  function addrW() { return Math.max(6, (S.base + Math.max(0, size() - 1)).toString(16).length); }
  const fa = off => hexl(S.base + off, addrW());
  const inImg = off => off >= 0 && off < size();
  const refVisible = () => !!(S.ref && !S.hideRef);

  // "C84B78", "0xC84B78", "+1F0" (смещение в файле), имя объекта
  function parseAddr(str) {
    str = String(str || "").trim();
    if (!str) return null;
    if (/^\+/.test(str)) {
      const v = parseInt(str.slice(1).replace(/^0x/i, ""), 16);
      return isNaN(v) ? null : v;
    }
    if (S.pack) for (const o of S.pack.objects) if (o.name === str) return o.addr;
    if (refVisible()) for (const o of S.ref.objects) if (o.name === str) return o.addr - S.base;
    const h = str.replace(/^0x/i, "").replace(/h$/i, "");
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    return parseInt(h, 16) - S.base;
  }

  // ------------------------------------------------------- объекты под байтом
  function partAt(u, off) {
    for (const p of u.geom.parts) if (off >= p.addr && off < p.addr + p.size) return p;
    return null;
  }
  const PART_CLASS = { data: "obj", aR: "axis", aC: "axis", nR: "cnt", nC: "cnt", str: "str" };
  function mineAt(off) { return S.pack ? S.pack.unitAt(off) : null; }
  function refAt(off) { return refVisible() && S.ref.pack ? S.ref.pack.unitAt(off) : null; }
  const differs = off => !!S.cmp && (off >= S.cmp.size || S.cmp.data[off] !== S.fw.data[off]);

  // Элемент объекта под байтом: какая часть, индекс, значение
  function elementAt(u, off) {
    const p = partAt(u, off);
    if (!p) return null;
    const o = u.item;
    if (p.what === "str") return { p, text: "строка" };
    const csz = M.cellOf(p.cell).size;
    const i = Math.floor((off - p.addr) / csz);
    const raw = M.readCell(data(), p.addr + i * csz, p.cell, o.be);
    const un = s => (s ? " " + s : "");
    if (p.what === "data") {
      const v = M.fmtNum(raw * o.factor + o.offset, 4) + un(o.unit);
      if (o.kind === "map" || (o.kind === "block" && o.rows > 1)) return { p, i, text: "[" + Math.floor(i / o.cols) + "," + (i % o.cols) + "] = " + v };
      if (o.kind === "value") return { p, i, text: "= " + v };
      return { p, i, text: "[" + i + "] = " + v };
    }
    if (p.what === "aR" || p.what === "aC") {
      const ax = p.what === "aR" ? o.axisR : o.axisC;
      return { p, i, text: (p.what === "aR" ? "ось строк" : "ось столбцов") + " [" + i + "] = " + M.fmtNum(raw * ax.factor + ax.offset, 4) + un(ax.unit) };
    }
    return { p, i, text: (p.what === "nR" ? "счётчик строк" : "счётчик столбцов") + " = " + raw };
  }

  // ------------------------------------------------------------------ вид
  //
  // Основной вид -- как текстовый режим WinOLS: N столбцов ячеек выбранного
  // формата (8/16/32 бит, LoHi/HiLo, hex/dec). Ширину меняют M (больше) и W
  // (меньше): когда она равна ширине карты, карта встаёт ровной таблицей.
  // В 2D те же байты -- графиком с линией через каждые N ячеек; в 3D --
  // поверхностью. A начинает строки с курсора.
  const cs = () => M.cellOf(S.vw.cell).size;
  const rowBytes = () => S.vw.cols * cs();
  const mod = (a, n) => ((a % n) + n) % n;
  const org = () => mod(S.vw.org, rowBytes());
  const rowBase = r => (org() ? org() - rowBytes() : 0) + r * rowBytes();
  const rowOf = off => Math.floor((off - rowBase(0)) / rowBytes());
  function visibleRows() { return Math.max(4, Math.floor($("#view").clientHeight / LINE_H)); }
  const totalRows = () => rowOf(Math.max(0, size() - 1)) + 1;
  const cellStart = off => off - mod(off - S.vw.org, cs());
  const MAX_COLS = 128;

  function cellWidth() {
    const c = M.cellOf(S.vw.cell);
    if (c.float) return 11;
    if (S.vw.fmt === "hex") return 2 * c.size;
    return { 1: 4, 2: 6, 4: 11 }[c.size];
  }
  function fmtCell(v) {
    if (!isFinite(v)) return "—";
    const c = M.cellOf(S.vw.cell);
    if (c.float) return M.fmtNum(v, 4);
    if (S.vw.fmt === "hex") return hexl(v < 0 ? v + Math.pow(2, 8 * c.size) : v, 2 * c.size);
    return String(v);
  }
  // формат ячейки из ширины и знака
  function cellName(bits, signed) {
    if (bits === "f") return "f32";
    return (signed ? "s" : "u") + bits;
  }
  const cellBits = () => (S.vw.cell === "f32" ? "f" : String(8 * cs()));
  const cellSigned = () => S.vw.cell[0] === "s";

  function setVw(ch) {
    Object.assign(S.vw, ch);
    S.vw.cols = Math.max(1, Math.min(MAX_COLS, S.vw.cols | 0));
    S.cur = cellStart(S.cur);
    S.sel = null; S.anchor = S.cur;
    S.top = Math.max(0, rowOf(S.cur) - 3);
    if (S.tab !== "hex") S.tab = "hex";
    renderToolbar(); renderTabs(); renderPane(); renderInsp(); renderStatus();
  }
  function alignRows() { setVw({ org: S.cur }); }

  function renderHex() {
    if (!S.fw) { renderWelcome(); return; }
    S.top = Math.max(0, Math.min(S.top, totalRows() - 1));
    if (S.vw.mode === "2d") render2d();
    else if (S.vw.mode === "3d") render3d();
    else renderText();
    const n = visibleRows(), tr = $("#vscroll"), th = $("#vthumb");
    const H = tr.clientHeight, part = Math.min(1, n / Math.max(1, totalRows()));
    const tH = Math.max(18, H * part);
    th.style.height = tH + "px";
    th.style.top = (totalRows() > n ? (S.top / (totalRows() - n)) * (H - tH) : 0) + "px";
  }

  function selBounds() { return S.sel ? selRange() : [-1, -1]; }

  function renderText() {
    const view = $("#view");
    const n = visibleRows(), c = cs(), cols = S.vw.cols, rb = rowBytes();
    const [selA, selEnd] = selBounds();
    const d = data();
    const col = $("#hexcol");
    col.style.setProperty("--cw", cellWidth() + "ch");
    col.style.setProperty("--ca", S.vw.fmt === "hex" && !M.cellOf(S.vw.cell).float ? "center" : "right");
    const showText = rb <= 64;
    const group = cols > 8 && cols % 8 === 0;
    const aw = S.showOff ? Math.max(6, (size() - 1).toString(16).length) : addrW();
    let head = '<span class=a title="Щелчок — адрес CPU или смещение в файле">' + (S.showOff ? "смещение" : "адрес") + "</span>";
    for (let i = 0; i < cols; i++) head += '<span class="y' + (group && i % 8 === 7 ? " g8" : "") + '">' + hexl(i * c, 2) + "</span>";
    $("#hexhead").innerHTML = head + (showText ? "  <span>текст (cp1251)</span>" : "");
    const out = [];
    const curCell = cellStart(S.cur);
    for (let r = S.top; r < Math.min(totalRows(), S.top + n); r++) {
      const base = rowBase(r);
      let h = "<span class=a>" + hexl(S.showOff ? Math.max(0, base) : S.base + Math.max(0, base), aw) + "</span>";
      for (let i = 0; i < cols; i++) {
        const o = base + i * c;
        const g = group && i % 8 === 7 ? " g8" : "";
        if (o < 0 || o + c > size()) { h += '<span class="y' + g + '"></span>'; continue; }
        const v = M.readCell(d, o, S.vw.cell, S.vw.be);
        let cls = "y" + g + (v === 0 ? " z" : "");
        const mu = mineAt(o);
        if (mu) { const p = partAt(mu, o); cls += " k-" + (p ? PART_CLASS[p.what] : "obj"); }
        const ru = refAt(o);
        if (ru) { const p = partAt(ru, o); const k = p ? PART_CLASS[p.what] : "obj"; cls += " r-" + (k === "obj" ? "data" : k); }
        if (S.cmp) for (let k = 0; k < c; k++) if (differs(o + k)) { cls += " df"; break; }
        if (o === curCell) cls += " cur";
        if (o >= selA && o < selEnd) cls += " sel";
        h += '<span class="' + cls + '" data-o="' + o + '">' + fmtCell(v) + "</span>";
      }
      let t = "";
      if (showText) {
        for (let i = 0; i < rb && base + i < size(); i++) {
          const o = base + i;
          if (o < 0) { t += " "; continue; }
          const b = d[o], pr = M.isPrintable(b);
          const cell = cellStart(o);
          t += '<span data-o="' + cell + '" class="' + (cell === curCell ? "cur " : "") + (pr ? "on" : "") + (o >= selA && o < selEnd ? " sel" : "") + '">' + (pr ? esc(M.CP1251[b]) : "·") + "</span>";
        }
      }
      out.push("<div class=hx>" + h + (showText ? "<span class=t>" + t + "</span>" : "") + "</div>");
    }
    view.innerHTML = out.join("");
  }

  // ---- 2D: значения графиком, линии через каждые N ячеек
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function fitCanvas(cv, w, h) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  // start -- смещение первой ячейки, count -- сколько ячеек, grid -- ячеек в строке
  function drawStrip(cv, w, h, start, count, grid, opt) {
    const g = fitCanvas(cv, w, h);
    const c = cs(), d = data();
    const vals = [], cvals = [];
    for (let i = 0; i < count; i++) {
      vals.push(M.readCell(d, start + i * c, S.vw.cell, S.vw.be));
      if (S.cmp) cvals.push(M.readCell(S.cmp.data, start + i * c, S.vw.cell, S.vw.be));
    }
    const fin = vals.concat(cvals).filter(isFinite);
    const lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 1;
    const L = 52, R = 8, T = 16, B = 18;
    const step = count > 1 ? (w - L - R) / (count - 1) : 0;
    const xOf = i => L + i * step;
    const yOf = v => T + (h - T - B) * (hi > lo ? 1 - (v - lo) / (hi - lo) : 0.5);
    g.fillStyle = cssVar("--bg"); g.fillRect(0, 0, w, h);
    const band = (test, color, y0, y1) => {
      let i = 0;
      while (i < count) {
        if (!test(start + i * c)) { i++; continue; }
        let j = i;
        while (j + 1 < count && test(start + (j + 1) * c)) j++;
        g.fillStyle = color;
        g.fillRect(xOf(i) - step / 2, y0, Math.max(1, (j - i + 1) * step), y1 - y0);
        i = j + 1;
      }
    };
    band(o => !!mineAt(o), cssVar("--hex-obj"), T, h - B);
    if (opt.sel && S.sel) { const [a, b] = selRange(); band(o => o >= a && o < b, cssVar("--sel-bg"), T, h - B); }
    if (refVisible()) band(o => !!refAt(o), cssVar("--ref"), h - B, h - B + 4);
    if (S.cmp) band(o => differs(o), cssVar("--bad"), T - 4, T);
    g.strokeStyle = cssVar("--line"); g.lineWidth = 1;
    g.fillStyle = cssVar("--muted"); g.font = "10px " + cssVar("--mono");
    const rowPx = grid * step;
    const labelEvery = Math.max(1, Math.ceil(70 / Math.max(1, rowPx)));
    const i0 = mod((rowBase(0) - start) / c, grid);
    for (let k = 0, i = i0; i <= count; i += grid, k++) {
      const x = Math.round(xOf(i) - step / 2) + 0.5;
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, h - B); g.stroke();
      if (opt.labels && k % labelEvery === 0 && i < count) g.fillText(hexl(S.base + start + i * c), x + 2, T - 6);
    }
    const line = (arr, color, width) => {
      g.strokeStyle = color; g.lineWidth = width;
      g.beginPath();
      arr.forEach((v, i) => { const x = xOf(i), y = yOf(v); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    };
    if (S.cmp) line(cvals, cssVar("--bad"), 1);
    line(vals, cssVar("--fg"), 1.2);
    if (opt.cursor) {
      const i = (cellStart(S.cur) - start) / c;
      if (i >= 0 && i < count) {
        g.strokeStyle = cssVar("--accent"); g.lineWidth = 2;
        g.beginPath(); g.moveTo(xOf(i), T); g.lineTo(xOf(i), h - B); g.stroke();
      }
    }
    g.fillStyle = cssVar("--muted"); g.font = "11px " + cssVar("--ui");
    g.fillText(M.fmtNum(hi, 3), 4, T + 10); g.fillText(M.fmtNum(lo, 3), 4, h - B - 2);
    cv._map = { start, count, L, step };
  }

  function render2d() {
    const view = $("#view");
    const c = cs();
    const start = Math.max(0, rowBase(S.top));
    const count = Math.max(1, Math.min(visibleRows() * S.vw.cols, Math.floor((size() - start) / c)));
    $("#hexhead").innerHTML = '<span> 2D: ' + count + " ячеек с " + fa(start) + ", линии — через " + S.vw.cols + " (M/W)" +
      (S.cmp ? ", красным — " + esc(S.cmp.name) : "") + "</span>";
    let cv = view.querySelector("canvas.v2d");
    if (!cv) { view.innerHTML = ""; cv = el("canvas", { class: "v2d" }); view.append(cv); }
    drawStrip(cv, view.clientWidth, view.clientHeight, start, count, S.vw.cols, { cursor: true, sel: true, labels: true });
  }

  // 3D основного вида: выделение (или видимые строки) при текущей ширине
  function render3d() {
    const view = $("#view");
    const c = cs(), cols = Math.min(S.vw.cols, 64);
    let start, rows;
    if (S.sel) {
      const [a, b] = selRange();
      start = a; rows = Math.max(2, Math.min(64, Math.ceil((b - a) / rowBytes())));
    } else {
      start = Math.max(0, rowBase(S.top)); rows = Math.max(2, Math.min(64, visibleRows()));
    }
    const vals = [];
    for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) vals.push(M.readCell(data(), start + r * rowBytes() + k * c, S.vw.cell, S.vw.be));
    $("#hexhead").innerHTML = "<span> 3D: " + cols + "×" + rows + " с " + fa(start) + (S.sel ? " (выделение)" : " (видимые строки; выделите карту, чтобы показать только её)") + "</span>";
    view.innerHTML = "";
    view.append(surface3d(vals, cols, rows, null, null, view.clientWidth, view.clientHeight));
  }

  // смещение ячейки под точкой графика
  function offAtCanvas(cv, x) {
    const m = cv._map;
    if (!m) return null;
    const i = Math.max(0, Math.min(m.count - 1, Math.round(m.step ? (x - m.L) / m.step : 0)));
    return m.start + i * cs();
  }

  function renderWelcome() {
    $("#hexhead").innerHTML = "";
    $("#view").innerHTML = '<div id=welcome>' +
      "<h2>Hex-редактор для разметки прошивок ЭБУ</h2><ol>" +
      "<li><b>Проект → Открыть прошивку</b> (<kbd>Ctrl+O</kbd>) — или перетащите .bin в окно.</li>" +
      "<li><b>Эталон → Открыть DAMOS / A2L</b> — его карты подчёркнуты в hex и перечислены во вкладке «Эталон». База образа подбирается сама. Для тренировки эталон можно скрыть.</li>" +
      "<li>Ищите карты как в WinOLS: <kbd>M</kbd> и <kbd>W</kbd> меняют число столбцов, <kbd>Tab</kbd> — текст, 2D, 3D, <kbd>A</kbd> начинает строки с курсора. Формат 8/16/32 бит, LoHi/HiLo — на панели инструментов.</li>" +
      "<li>Выделите карту и нажмите <kbd>K</kbd> — размер и формат подставятся сами. <kbd>Enter</kbd> открывает карту во вкладке: таблица, 2D, 3D.</li>" +
      "<li><b>Проект → Сравнить с файлом</b> — отличия от второй прошивки подсвечиваются, <kbd>N</kbd> — к следующему.</li>" +
      "<li><b>Проект → Сохранить маппак</b> — A2L или DAMOS. <b>Сверка</b> — что совпало с эталоном и почему нет.</li>" +
      "</ol><p class=muted>Только чтение: байты прошивки не меняются. Файлы никуда не отправляются, маппак сохраняется в браузере сам. Все клавиши — <kbd>F1</kbd>.</p></div>";
  }

  // ------------------------------------------------------------ значения
  function renderInsp() {
    $("#insp").hidden = !S.showInsp;
    const box = $("#inspbody");
    if (!S.fw || !S.showInsp) { box.innerHTML = ""; return; }
    const d = data(), o = curOff();
    const rd = (cell, be, src) => M.readCell(src || d, o, cell, be);
    const fmt = v => (isFinite(v) ? M.fmtNum(v, 6) : "—");
    const rows = [
      ["адрес", fa(o)], ["смещение", "+" + hexl(o)],
      ["u8 / s8", rd("u8") + " / " + rd("s8")],
      ["двоично", d[o].toString(2).padStart(8, "0")],
      ["u16 LoHi", fmt(rd("u16"))], ["s16 LoHi", fmt(rd("s16"))],
      ["u16 HiLo", fmt(rd("u16", true))], ["s16 HiLo", fmt(rd("s16", true))],
      ["u32 LoHi", fmt(rd("u32"))], ["u32 HiLo", fmt(rd("u32", true))],
      ["float LoHi", fmt(rd("f32"))], ["float HiLo", fmt(rd("f32", true))],
    ];
    let h = "<table>" + rows.map(([k, v]) => "<tr><td>" + k + "</td><td>" + esc(v) + "</td></tr>").join("") + "</table>";
    if (S.cmp && o < S.cmp.size) {
      const c = S.cmp.data;
      h += "<h4 class=" + (differs(o) ? "bad" : "") + ">Сравнение: " + esc(S.cmp.name) + "</h4><table>" +
        "<tr><td>u8</td><td>" + c[o] + " (" + hexl(c[o], 2) + "h)" + (c[o] !== d[o] ? " ≠ " + d[o] : "") + "</td></tr>" +
        "<tr><td>u16 LoHi</td><td>" + fmt(rd("u16", false, c)) + "</td></tr></table>";
    }
    if (S.sel) {
      const [a, b] = selRange();
      h += "<h4>Выделено</h4><table><tr><td>байт</td><td>" + (b - a) + " (0x" + hexl(b - a) + ")</td></tr><tr><td>с</td><td>" + fa(a) + "</td></tr><tr><td>по</td><td>" + fa(b - 1) + "</td></tr></table>";
    }
    const objBox = (u, ref) => {
      const e = elementAt(u, o);
      return '<div class="objbox' + (ref ? " ref" : "") + '"><b>' + esc(u.item.name || "(без имени)") + "</b><br><span class=muted>" + esc(M.describe(u.item)) + "</span>" +
        (e ? "<br>" + esc(e.text) : "") + (u.item.desc ? "<br><span class=muted>" + esc(u.item.desc) + "</span>" : "") + "</div>";
    };
    const mu = mineAt(o), ru = refAt(o);
    h += "<h4>Мой маппак</h4>" + (mu ? objBox(mu, false) : "<div class=muted>—</div>");
    if (S.ref) h += "<h4>Эталон</h4>" + (S.hideRef ? "<div class=muted>скрыт (тренировка)</div>" : ru ? objBox(ru, true) : "<div class=muted>—</div>");
    h += '<div class=legend><span><i class=k-obj></i>данные</span><span><i class=k-axis></i>ось</span><span><i class=k-cnt></i>счётчик</span>' +
      (refVisible() ? '<span><i style="box-shadow: inset 0 -3px 0 var(--ref)"></i>эталон</span>' : "") +
      (S.cmp ? '<span><i class=df style="background:none"></i><span class=bad>отличие</span></span>' : "") + "</div>";
    box.innerHTML = h;
  }

  // ------------------------------------------------- таблицы, графики, 3D
  function heat(v, lo, hi, diverge) {
    if (!isFinite(v)) return "";
    if (diverge) {
      if (!v) return "";
      const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      return "background:hsla(" + (v > 0 ? 0 : 215) + ",80%,52%," + (0.12 + 0.5 * Math.abs(v) / m).toFixed(2) + ")";
    }
    if (hi <= lo) return "";
    const t = (v - lo) / (hi - lo);
    return "background:hsla(" + Math.round(220 - 220 * t) + ",75%,52%,var(--heat-a))";
  }
  const fmtVal = v => M.fmtNum(v, 3);

  // opt: {sel: {r,c}, chg: bool[], diverge}
  function tableHtml(values, cols, rows, axC, axR, fmt, opt) {
    opt = opt || {};
    const fin = values.filter(isFinite);
    const lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 0;
    let h = "<table class=map><tr><th class=corner>" + (rows > 1 ? "стр\\стлб" : "") + "</th>";
    for (let c = 0; c < cols; c++) h += "<th>" + (axC && axC[c] !== undefined ? fmtVal(axC[c]) : c) + "</th>";
    h += "</tr>";
    for (let r = 0; r < rows; r++) {
      h += "<tr><th>" + (axR && axR[r] !== undefined ? fmtVal(axR[r]) : r) + "</th>";
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c, v = values[i];
        const cls = (opt.sel && opt.sel.r === r && opt.sel.c === c ? "on" : "") + (opt.chg && opt.chg[i] ? " chg" : "");
        h += '<td data-r="' + r + '" data-c="' + c + '" class="' + cls + '" style="' + heat(v, lo, hi, opt.diverge) + '">' + fmt(v) + "</td>";
      }
      h += "</tr>";
    }
    return h + "</table>";
  }

  // Строки карты линиями: каждая строка -- своя кривая; сравнение -- пунктиром
  function plotRows(values, cols, rows, axC, w, h, other) {
    const cv = el("canvas", { class: "plot" });
    const g = fitCanvas(cv, w, h);
    const fin = values.concat(other || []).filter(isFinite);
    const lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 1;
    const L = 52, R = 10, T = 10, B = 20;
    const xOf = i => L + (cols > 1 ? i * (w - L - R) / (cols - 1) : (w - L - R) / 2);
    const yOf = v => T + (h - T - B) * (hi > lo ? 1 - (v - lo) / (hi - lo) : 0.5);
    g.strokeStyle = cssVar("--line"); g.strokeRect(L - 0.5, T - 0.5, w - L - R + 1, h - T - B + 1);
    const draw = (arr, dash) => {
      g.setLineDash(dash ? [4, 3] : []);
      for (let r = 0; r < rows; r++) {
        g.strokeStyle = "hsl(" + Math.round(220 - 220 * (rows > 1 ? r / (rows - 1) : 0)) + ",70%," + (dash ? 40 : 50) + "%)";
        g.lineWidth = dash ? 1 : 1.5;
        g.beginPath();
        for (let c = 0; c < cols; c++) { const v = arr[r * cols + c], x = xOf(c), y = yOf(v); if (c) g.lineTo(x, y); else g.moveTo(x, y); }
        g.stroke();
      }
      g.setLineDash([]);
    };
    if (other) draw(other, true);
    draw(values, false);
    g.fillStyle = cssVar("--muted"); g.font = "11px " + cssVar("--ui");
    g.fillText(M.fmtNum(hi, 3), 4, T + 10); g.fillText(M.fmtNum(lo, 3), 4, h - B);
    if (axC) { g.fillText(M.fmtNum(axC[0], 3), L, h - 5); const t = M.fmtNum(axC[cols - 1], 3); g.fillText(t, w - R - g.measureText(t).width, h - 5); }
    if (other) g.fillText("пунктир — сравниваемый файл", L + 8, T + 12);
    return cv;
  }

  // 3D-поверхность: перетаскивание мышью вращает, двойной щелчок -- сброс
  let drag3d = null;
  window.addEventListener("mousemove", e => {
    if (!drag3d) return;
    S.rot.az = drag3d.az + (e.clientX - drag3d.x) * 0.01;
    S.rot.el = Math.max(0.05, Math.min(1.55, drag3d.el + (e.clientY - drag3d.y) * 0.01));
    if (drag3d.cv.isConnected) drag3d.draw();
  });
  window.addEventListener("mouseup", () => { if (drag3d) { drag3d.cv.style.cursor = "grab"; drag3d = null; } });

  function surface3d(values, cols, rows, axC, axR, w, h) {
    const cv = el("canvas", { class: "plot", style: { cursor: "grab" } });
    const draw = () => {
      const g = fitCanvas(cv, w, h);
      g.fillStyle = cssVar("--bg"); g.fillRect(0, 0, w, h);
      const fin = values.filter(isFinite);
      const lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 1;
      const { az, el: elv } = S.rot;
      const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(elv), se = Math.sin(elv);
      const scale = Math.min(w * 0.38, h * 0.5), cx = w / 2, cy = h / 2 + 8;
      const P = (c, r) => {
        const X = cols > 1 ? (c / (cols - 1) - 0.5) * 2 : 0;
        const Y = rows > 1 ? (r / (rows - 1) - 0.5) * 2 : 0;
        const v = values[r * cols + c];
        const Z = ((hi > lo ? (v - lo) / (hi - lo) : 0.5) - 0.5) * 1.3;
        const x1 = X * ca - Y * sa, y1 = X * sa + Y * ca;
        const up = Z * ce + y1 * se, depth = y1 * ce - Z * se;
        return { x: cx + x1 * scale, y: cy - up * scale, d: depth, t: hi > lo ? (v - lo) / (hi - lo) : 0.5 };
      };
      const pts = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push(P(c, r));
      const at = (c, r) => pts[r * cols + c];
      const quads = [];
      for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
        const q = [at(c, r), at(c + 1, r), at(c + 1, r + 1), at(c, r + 1)];
        quads.push({ q, d: (q[0].d + q[1].d + q[2].d + q[3].d) / 4, t: (q[0].t + q[1].t + q[2].t + q[3].t) / 4 });
      }
      quads.sort((a, b) => b.d - a.d);
      g.lineWidth = 0.6;
      for (const { q, t } of quads) {
        g.beginPath(); g.moveTo(q[0].x, q[0].y); for (let k = 1; k < 4; k++) g.lineTo(q[k].x, q[k].y); g.closePath();
        g.fillStyle = "hsl(" + Math.round(220 - 220 * t) + ",70%,58%)"; g.fill();
        g.strokeStyle = "rgba(0,0,0,.35)"; g.stroke();
      }
      g.fillStyle = cssVar("--muted"); g.font = "11px " + cssVar("--ui");
      const lab = (p, s) => g.fillText(s, p.x + 4, p.y + 12);
      if (axC) { lab(at(0, 0), "" + M.fmtNum(axC[0], 3)); lab(at(cols - 1, 0), "" + M.fmtNum(axC[cols - 1], 3)); }
      if (axR && rows > 1) lab(at(0, rows - 1), "" + M.fmtNum(axR[rows - 1], 3));
      g.fillText("макс " + M.fmtNum(hi, 3) + "   мин " + M.fmtNum(lo, 3) + "   (тяните мышью, двойной щелчок — сброс)", 8, 14);
    };
    cv.addEventListener("mousedown", e => { drag3d = { x: e.clientX, y: e.clientY, az: S.rot.az, el: S.rot.el, draw, cv }; cv.style.cursor = "grabbing"; e.preventDefault(); e.stopPropagation(); });
    cv.addEventListener("dblclick", e => { S.rot = { az: -0.7, el: 0.6 }; draw(); e.stopPropagation(); });
    draw();
    return cv;
  }

  // -------------------------------------------------------------- вкладки
  // Как окна карт в WinOLS: hex-дамп всегда первой вкладкой, карты --
  // своими вкладками. Ищем объект по имени и адресу: после правки свойств
  // ссылка на старый объект устаревает.
  const tabKey = (src, o) => src + ":" + o.name + "@" + o.addr;
  function resolveTab(t) {
    if (!t) return null;
    const list = t.src === "ref" ? (S.ref && S.ref.pack ? S.ref.pack.objects : []) : (S.pack ? S.pack.objects : []);
    return list.find(o => o.name === t.name && o.addr === t.addr) || null;
  }
  const activeTab = () => S.tabs.find(t => t.key === S.tab) || null;

  function openObj(src, o) {
    const key = tabKey(src, o);
    if (!S.tabs.some(t => t.key === key)) S.tabs.push({ key, src, name: o.name, addr: o.addr });
    S.tab = key;
    S.mapCell = { r: 0, c: 0 };
    if (o.kind === "value" || o.kind === "string") S.mapView = "table";
    renderTabs(); renderPane(); renderStatus();
  }
  function closeTab(key) {
    S.tabs = S.tabs.filter(t => t.key !== key);
    if (S.tab === key) S.tab = "hex";
    renderTabs(); renderPane(); renderStatus();
  }
  function showHex() { S.tab = "hex"; renderTabs(); renderPane(); renderInsp(); renderStatus(); $("#view").focus(); }

  function renderTabs() {
    // вкладки, чей объект пропал (удалён, эталон скрыт), закрываем
    S.tabs = S.tabs.filter(t => resolveTab(t) && (t.src !== "ref" || refVisible()));
    if (S.tab !== "hex" && !activeTab()) S.tab = "hex";
    const bar = $("#tabs");
    bar.innerHTML = "";
    if (!S.fw) return;
    bar.append(el("div", { class: "tab" + (S.tab === "hex" ? " on" : ""), onclick: showHex, title: S.fw.name },
      el("span", { class: "t" }, "Hex: " + S.fw.name)));
    for (const t of S.tabs) {
      bar.append(el("div", { class: "tab" + (S.tab === t.key ? " on" : ""), title: t.name,
        onclick: () => { S.tab = t.key; renderTabs(); renderPane(); renderStatus(); },
        onauxclick: e => { if (e.button === 1) closeTab(t.key); } },
        el("span", { class: "kind" }, t.src === "ref" ? "эталон" : "мой"), el("span", { class: "t" }, t.name),
        el("button", { class: "x", title: "Закрыть", onclick: e => { e.stopPropagation(); closeTab(t.key); } }, "×")));
    }
  }

  function renderPane() {
    const hex = S.tab === "hex";
    $("#hexpane").hidden = !hex;
    $("#mappane").hidden = hex;
    if (hex) renderHex(); else renderMap();
  }

  // Окно карты: таблица, 2D, 3D; при сравнении -- текущий, второй файл, разница
  function mapData(t, o) {
    const isRef = t.src === "ref";
    const axisAt = isRef ? refAxisAt : myAxisAt;
    const r = M.readObject(o, data(), a => a, axisAt);
    const rc = S.cmp ? M.readObject(o, S.cmp.data, a => a, axisAt) : null;
    return { r, rc };
  }

  function renderMap() {
    const t = activeTab();
    const o = resolveTab(t);
    const bar = $("#mapbar"), info = $("#mapinfo"), body = $("#mapbody");
    bar.innerHTML = ""; info.innerHTML = ""; body.innerHTML = "";
    if (!o) { showHex(); return; }
    const isRef = t.src === "ref";
    const { r, rc } = mapData(t, o);
    const rows = (o.kind === "map" || o.kind === "block") ? o.rows : 1;
    const views = (o.kind === "value" || o.kind === "string") ? [["table", "Текст"]] : rows > 1 ? [["table", "Текст"], ["2d", "2D"], ["3d", "3D"]] : [["table", "Текст"], ["2d", "2D"]];
    if (!views.some(v => v[0] === S.mapView)) S.mapView = "table";
    const btn = (on, text, title, fn) => el("button", { class: on ? "on" : "", title, onclick: fn }, text);
    bar.append(...views.map(([k, txt]) => btn(S.mapView === k, txt, "Вид карты (Tab)", () => { S.mapView = k; renderMap(); })),
      el("span", { class: "lab muted" }, " │ "),
      ...[["phys", "Физ."], ["raw", "Сырое"], ["hex", "Hex"]].map(([k, txt]) => btn(S.mapFmt === k, txt, "Значения: физические, сырые или hex", () => { S.mapFmt = k; renderMap(); })));
    if (S.cmp) bar.append(el("span", { class: "lab muted" }, " │ сравнение: "),
      ...[["cur", "Текущий"], ["cmp", "Второй файл"], ["diff", "Разница"], ["pct", "%"]].map(([k, txt]) =>
        btn(S.mapCmp === k, txt, "Что показывать при сравнении с " + S.cmp.name, () => { S.mapCmp = k; renderMap(); })));
    bar.append(el("span", { class: "lab muted" }, " │ "));
    if (isRef) bar.append(el("button", { onclick: () => adoptRef([refOrig(o)]) }, "Взять в маппак"));
    else bar.append(el("button", { onclick: () => mapDialog(o) }, "Свойства… (K)"), el("button", { onclick: () => { closeTab(t.key); change(() => S.pack.remove(o)); } }, "Удалить"));
    bar.append(el("button", { title: "К hex-дампу (Esc)", onclick: () => { goTo(M.geometry(o).start); } }, "В hex (Esc)"),
      el("span", { class: "title" }, o.name || "(без имени)"));
    const g = M.geometry(o);
    let chg = null, nchg = 0;
    if (rc && r.raw) { chg = r.raw.map((v, i) => v !== rc.raw[i]); nchg = chg.filter(Boolean).length; }
    info.append(el("span", {}, M.describe(o) + "  ·  " + fa(g.start) + "–" + fa(g.end - 1) + (g.dataAddr !== g.start ? ", данные с " + fa(g.dataAddr) : "") +
      (isRef ? "  ·  эталон " + S.ref.name : "")),
      o.desc ? el("span", {}, "  ·  " + o.desc) : null,
      S.cmp ? el("span", { class: nchg ? "bad" : "ok" }, "  ·  отличий от " + S.cmp.name + ": " + nchg) : null);
    if (o.layout === "bosch") {
      const bad = [];
      if ("nR" in r.counts && r.counts.nR !== o.rows) bad.push("строк в заголовке " + r.counts.nR);
      if ("nC" in r.counts && r.counts.nC !== o.cols) bad.push("столбцов в заголовке " + r.counts.nC);
      if (bad.length) info.append(el("span", { class: "bad" }, "  ·  заголовок не сходится: " + bad.join(", ")));
    }
    if (o.kind === "string") { body.append(el("div", { class: "mono", style: { fontSize: "14px" } }, '"' + (r.text || "") + '"')); return; }
    // значения для показа
    const phys = S.mapFmt === "phys";
    const pick = x => (phys ? x.values : (x.raw || []));
    let vals = pick(r), diverge = false;
    if (rc) {
      const a = pick(r), b = pick(rc);
      if (S.mapCmp === "cmp") vals = b;
      else if (S.mapCmp === "diff") { vals = a.map((v, i) => v - b[i]); diverge = true; }
      else if (S.mapCmp === "pct") { vals = a.map((v, i) => (b[i] ? (v - b[i]) / Math.abs(b[i]) * 100 : (v === b[i] ? 0 : NaN))); diverge = true; }
    }
    const csz = M.cellOf(o.cell).size;
    const fmt = S.mapCmp === "pct" && rc ? (v => isFinite(v) ? M.fmtNum(v, 1) + "%" : "—")
      : phys ? fmtVal : S.mapFmt === "raw" ? (v => String(v)) : (v => hexl(v < 0 ? v + Math.pow(2, 8 * csz) : v, 2 * csz));
    const w = Math.max(320, body.clientWidth - 16), h = Math.max(200, body.clientHeight - 16);
    if (S.mapView === "3d") body.append(surface3d(vals, o.cols, rows, r.axisC, r.axisR, w, h));
    else if (S.mapView === "2d") body.append(plotRows(vals, o.cols, rows, r.axisC, w, h, rc && S.mapCmp === "cur" ? pick(rc) : null));
    else {
      S.mapCell.r = Math.min(S.mapCell.r, rows - 1); S.mapCell.c = Math.min(S.mapCell.c, o.cols - 1);
      body.append(el("div", { html: tableHtml(vals, o.cols, rows, r.axisC, o.kind === "map" ? r.axisR : null, fmt, { sel: S.mapCell, chg, diverge }) }));
    }
  }

  // адрес ячейки, выбранной в окне карты
  function mapCellOff() {
    const t = activeTab(), o = resolveTab(t);
    if (!o) return null;
    const g = M.geometry(o);
    const i = S.mapCell.r * o.cols + S.mapCell.c;
    return g.dataAddr + i * M.cellOf(o.cell).size;
  }
  // смещение, о котором сейчас речь: курсор hex или ячейка открытой карты
  function curOff() {
    if (S.tab !== "hex") { const m = mapCellOff(); if (m !== null && inImg(m)) return m; }
    return S.cur;
  }

  function myAxisAt(off) { return S.pack.objects.find(o => o.addr === off && o.kind === "axis") || null; }
  function refAxisAt(off) { return S.ref.pack.objects.find(o => o.addr === off && o.kind === "axis") || null; }

  // ----------------------------------------------------------- окно «Карты»
  const kindText = o => M.KINDS[o.kind] + (o.kind === "map" ? " " + o.cols + "×" + o.rows : (o.kind === "value" || o.kind === "string") ? "" : " " + o.cols);
  const KIND_ICON = { map: "▦", curve: "∿", axis: "↔", value: "•", block: "▤", string: "T" };
  const sizeText = o => o.kind === "map" ? o.cols + "×" + o.rows : (o.kind === "value" ? "1" : o.kind === "string" ? o.length + " б" : String(o.cols));

  function renderDock() {
    const body = $("#dockbody"), tools = $("#docktools");
    const keep = document.activeElement && tools.contains(document.activeElement) && document.activeElement.dataset.keep;
    body.innerHTML = ""; tools.innerHTML = "";
    for (const b of $("#docktabs").children) b.classList.toggle("on", b.dataset.tab === S.dock);
    $("#dockcount").textContent = "";
    if (!S.fw) { body.append(el("div", { class: "empty" }, "Откройте прошивку: Проект → Открыть прошивку (Ctrl+O).")); return; }
    ({ pack: dockPack, ref: dockRef, diff: dockDiff, check: dockCheck })[S.dock](body, tools);
    if (keep) { const i = tools.querySelector('[data-keep="' + keep + '"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }

  function filterInput(which, placeholder) {
    return el("input", { placeholder, value: S.filter[which], "data-keep": which, oninput: e => { S.filter[which] = e.target.value; renderDock(); } });
  }

  // Таблица объектов с сортировкой по щелчку на заголовке
  function objTable(body, items, src, offOf) {
    const srt = S.sort[src];
    const keyF = { name: o => (o.name || "").toLowerCase(), addr: o => o.addr, size: o => o.cols * o.rows, kind: o => o.kind };
    items = items.slice().sort((a, b) => { const x = keyF[srt.k](a), y = keyF[srt.k](b); return (x < y ? -1 : x > y ? 1 : 0) * srt.d; });
    const head = (k, t, w) => el("th", { style: { width: w }, onclick: () => { S.sort[src] = { k, d: srt.k === k ? -srt.d : 1 }; renderDock(); } },
      t + (srt.k === k ? (srt.d > 0 ? " ▴" : " ▾") : ""));
    const tbl = el("table", { class: "lst" }, el("tr", {}, head("name", "Имя", "38%"), head("addr", "Адрес", "21%"), head("size", "Размер", "19%"), head("kind", "Тип", "22%")));
    const cu = src === "ref" ? refAt(S.cur) : mineAt(S.cur);
    for (const o of items.slice(0, 3000)) {
      const off = offOf(o);
      const on = cu && cu.item.name === o.name && cu.off === off;
      tbl.append(el("tr", { class: (on ? "on " : "") + (src === "ref" ? "ref" : ""), title: o.desc || o.name,
        onclick: e => { goTo(off, false, true); pickRow(e.currentTarget); },
        ondblclick: () => { const u = (src === "ref" ? S.ref.pack : S.pack).unitAt(off); if (u) openObj(src === "ref" ? "ref" : "mine", u.item); } },
        el("td", {}, el("span", { class: "ic" }, KIND_ICON[o.kind] || "•"), " ", o.name || "(без имени)"),
        el("td", { class: "m" }, hexl(S.base + off, addrW())), el("td", { class: "m" }, sizeText(o)), el("td", {}, M.KINDS[o.kind])));
    }
    body.append(tbl);
    if (items.length > 3000) body.append(el("div", { class: "hint pad" }, "показаны первые 3000 из " + items.length + " — уточните фильтр"));
  }

  function dockPack(body, tools) {
    const objs = S.pack.objects;
    const f = S.filter.pack.toLowerCase();
    const shown = objs.filter(o => !f || (o.name || "").toLowerCase().includes(f) || fa(o.addr).toLowerCase().includes(f));
    tools.append(filterInput("pack", "фильтр: имя или адрес"), el("button", { title: "Новая карта у курсора (K)", onclick: () => mapDialog(null) }, "Новая… K"));
    $("#dockcount").textContent = shown.length + (shown.length !== objs.length ? " из " + objs.length : "");
    if (!objs.length) { body.append(el("div", { class: "empty" }, "Маппак пуст. Подберите ширину клавишами M/W, чтобы карта встала таблицей, выделите её и нажмите K. Сохранить — Проект → Сохранить маппак (A2L или DAMOS).")); return; }
    objTable(body, shown, "pack", o => o.addr);
  }

  function dockRef(body, tools) {
    if (!S.ref) { body.append(el("div", { class: "empty" }, "Эталон не загружен: Эталон → Открыть DAMOS / A2L, или перетащите .dam / .a2l в окно.")); return; }
    tools.append(el("label", {}, el("input", { type: "checkbox", checked: S.hideRef, onchange: e => setHideRef(e.target.checked) }), " скрыть (тренировка)"));
    if (S.hideRef) { body.append(el("div", { class: "empty" }, "Эталон скрыт: нет подчёркивания в hex и списка. Сверка работает.")); return; }
    const kinds = [["all", "все"]].concat(Object.entries(M.KINDS));
    tools.append(filterInput("ref", "имя, описание или адрес"),
      el("select", { onchange: e => { S.refKind = e.target.value; renderDock(); } }, ...kinds.map(([k, t]) => el("option", { value: k, selected: S.refKind === k }, t))));
    const f = S.filter.ref.toLowerCase();
    const shown = S.ref.objects.filter(o => (S.refKind === "all" || o.kind === S.refKind) &&
      (!f || o.name.toLowerCase().includes(f) || (o.desc || "").toLowerCase().includes(f) || hexl(o.addr).toLowerCase().includes(f)));
    tools.append(el("button", { title: "Скопировать показанные объекты в ваш маппак — например, чтобы пересохранить DAMOS как A2L", onclick: () => adoptRef(shown) }, "В маппак"));
    $("#dockcount").textContent = shown.length + " из " + S.ref.objects.length;
    objTable(body, shown, "ref", o => o.addr - S.base);
  }

  // ---- вкладка «Отличия»
  function changedObjects() {
    const out = [];
    const scan = (list, src) => {
      for (const o of list) {
        const g = M.geometry(o);
        let any = false;
        for (let k = g.start; k < g.end && !any; k++) if (differs(k)) any = true;
        if (!any) continue;
        const axisAt = src === "ref" ? refAxisAt : myAxisAt;
        const a = M.readObject(o, data(), x => x, axisAt), b = M.readObject(o, S.cmp.data, x => x, axisAt);
        let n = 0, dmin = Infinity, dmax = -Infinity;
        (a.values || []).forEach((v, i) => { const d = v - b.values[i]; if (a.raw[i] !== b.raw[i]) { n++; dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); } });
        out.push({ o, src, n, cells: (a.values || []).length, dmin, dmax, hdr: n === 0 });
      }
    };
    scan(S.pack.objects, "pack");
    if (refVisible()) scan(S.ref.pack.objects.filter(o => !S.pack.objects.some(m => m.addr === o.addr)), "ref");
    return out.sort((x, y) => x.o.addr - y.o.addr);
  }

  function dockDiff(body, tools) {
    if (!S.cmp) { body.append(el("div", { class: "empty" }, "Сравнения нет. Проект → Сравнить с файлом… — откройте вторую прошивку, например сток против тюна. Отличия подсветятся красным, N — к следующему.")); return; }
    const c = S.cmp;
    tools.append(el("button", { class: S.diffGroup === "maps" ? "primary" : "", onclick: () => { S.diffGroup = "maps"; renderDock(); } }, "По картам"),
      el("button", { class: S.diffGroup === "blocks" ? "primary" : "", onclick: () => { S.diffGroup = "blocks"; renderDock(); } }, "Блоки байт"),
      el("button", { title: "Сделать второй файл текущим, а текущий — вторым", onclick: swapCompare }, "⇄"),
      el("button", { title: "Закрыть сравнение", onclick: closeCompare }, "Закрыть"));
    body.append(el("div", { class: "pad hint" }, "С " + c.name + ": " + c.blocks.length + " блоков, " + c.bytes + " байт отличаются" +
      (c.size !== size() ? "; размеры разные (" + c.size + " и " + size() + " байт)" : "")));
    if (S.diffGroup === "blocks") {
      const tbl = el("table", { class: "lst" }, el("tr", {}, el("th", { style: { width: "26%" } }, "Адрес"), el("th", { style: { width: "18%" } }, "Байт"), el("th", {}, "Карта")));
      for (const b of c.blocks.slice(0, 3000)) {
        const u = mineAt(b.a) || refAt(b.a);
        tbl.append(el("tr", { onclick: e => { goTo(b.a, false, true); pickRow(e.currentTarget); S.sel = { a: b.a, b: cellStart(b.b - 1) }; renderPane(); renderInsp(); renderStatus(); } },
          el("td", { class: "m" }, fa(b.a)), el("td", { class: "m" }, String(b.b - b.a)), el("td", {}, u ? u.item.name : "")));
      }
      body.append(tbl);
      $("#dockcount").textContent = c.blocks.length;
      return;
    }
    const ch = changedObjects();
    $("#dockcount").textContent = ch.length + " карт";
    if (!ch.length) { body.append(el("div", { class: "empty" }, "Ни одна размеченная карта (ваша или эталона) не задета. Смотрите «Блоки байт» — отличия лежат вне разметки.")); return; }
    const tbl = el("table", { class: "lst" }, el("tr", {}, el("th", { style: { width: "32%" } }, "Карта"), el("th", { style: { width: "20%" } }, "Адрес"),
      el("th", { style: { width: "20%" } }, "Ячеек"), el("th", {}, "Δ физ.")));
    for (const x of ch) {
      const o = x.o;
      tbl.append(el("tr", { class: x.src === "ref" ? "ref" : "", title: (o.desc || o.name) + (x.hdr ? " — изменён заголовок или ось" : ""),
        onclick: e => { goTo(M.geometry(o).start, false, true); pickRow(e.currentTarget); },
        ondblclick: () => { S.mapCmp = "diff"; openObj(x.src === "ref" ? "ref" : "mine", o); } },
        el("td", {}, el("span", { class: "ic" }, KIND_ICON[o.kind] || "•"), " ", o.name),
        el("td", { class: "m" }, fa(o.addr)), el("td", { class: "m" }, x.n + "/" + x.cells),
        el("td", { class: "m" }, x.n ? (M.fmtNum(x.dmin, 2) === M.fmtNum(x.dmax, 2) ? M.fmtNum(x.dmax, 2) : M.fmtNum(x.dmin, 2) + "…" + M.fmtNum(x.dmax, 2)) : "оси")));
    }
    body.append(tbl, el("div", { class: "hint pad" }, "Двойной щелчок открывает карту с разницей. Δ — текущий файл минус второй, в единицах карты."));
  }

  // ---- вкладка «Сверка»
  const KIND_OPTS = [["map", "карты"], ["curve", "кривые"], ["axis", "оси"], ["value", "значения"], ["block", "блоки"], ["string", "строки"]];
  function kindBoxes(arr) {
    return el("div", { class: "row" }, ...KIND_OPTS.map(([k, t]) => el("label", {},
      el("input", { type: "checkbox", checked: arr.includes(k), onchange: e => {
        const i = arr.indexOf(k);
        if (e.target.checked && i < 0) arr.push(k); else if (!e.target.checked && i >= 0) arr.splice(i, 1);
      } }), " " + t)));
  }
  const parseHexOpt = s => (s && /^(0x)?[0-9a-f]+$/i.test(s) ? parseInt(s.replace(/^0x/i, ""), 16) : null);

  function runCheck() {
    const o = S.checkOpts;
    S.lastCheck = CMP.compare(MK.cpuObjects(S.pack, S.base), S.ref.objects, {
      kinds: new Set(o.kinds), lo: parseHexOpt(o.lo), hi: parseHexOpt(o.hi),
    });
  }

  function dockCheck(body) {
    const b = el("div", { class: "pad" });
    body.append(b);
    if (!S.ref) { b.append(el("div", { class: "empty" }, "Загрузите эталон: Эталон → Открыть DAMOS / A2L.")); return; }
    const o = S.checkOpts;
    b.append(el("div", { class: "hint" }, "Ваш маппак (" + S.pack.objects.length + ") против " + S.ref.name + ". Пара ищется по адресу, имя может быть любым."),
      el("div", { class: "sec" }, "Что проверять"), kindBoxes(o.kinds),
      el("div", { class: "row" }, "адреса",
        el("input", { class: "mono", placeholder: "от", value: o.lo, style: { width: "90px" }, onchange: e => (o.lo = e.target.value.trim()) }), "—",
        el("input", { class: "mono", placeholder: "до", value: o.hi, style: { width: "90px" }, onchange: e => (o.hi = e.target.value.trim()) })),
      el("div", { class: "row" },
        el("button", { title: "Только та область, где вы размечали", onclick: () => {
          const uo = MK.cpuObjects(S.pack, S.base);
          if (!uo.length) { toast("Маппак пуст"); return; }
          o.lo = hexl(Math.min(...uo.map(x => x.addr))); o.hi = hexl(Math.max(...uo.map(x => M.geometry(x).end)));
          renderDock();
        } }, "по моей разметке"),
        el("button", { onclick: () => { o.lo = ""; o.hi = ""; renderDock(); } }, "вся прошивка"),
        el("button", { class: "primary", onclick: () => { runCheck(); renderDock(); } }, "Сверить")));
    if (S.lastCheck) runCheck();     // маппак мог измениться
    const res = S.lastCheck;
    if (!res) return;
    b.append(el("div", { class: "row" }, el("span", { class: "score" }, (res.score * 100).toFixed(res.score < 0.1 ? 1 : 0) + "%"),
      el("span", { class: "hint" }, "найдено " + res.inScopePairs.length + " из " + res.total + "; верно полностью " + res.ok + ", частично " + res.partial)));
    const sect = (title, cls, items, render) => {
      b.append(el("div", { class: "sec" }, title, el("span", { class: "badge " + cls }, items.length)));
      const l = el("div", { class: "list" });
      items.slice(0, 500).forEach(x => l.append(render(x)));
      if (items.length > 500) l.append(el("div", { class: "hint" }, "показаны первые 500"));
      b.append(l);
    };
    const pairItem = p => el("div", { class: "item", onclick: () => { goTo(p.u.addr - S.base); pairDialog(p); } },
      el("span", { class: "addr" }, hexl(p.u.addr, addrW())), el("span", { class: "nm" }, p.r.name),
      el("span", { class: "kd " + (p.status === "ok" ? "ok" : "warn") }, p.status === "ok" ? "✔" : p.checks.filter(c => !c.ok).map(c => c.what).join(", ")));
    sect("Совпало", "ok", res.inScopePairs.filter(p => p.status === "ok"), pairItem);
    sect("Частично", "warn", res.inScopePairs.filter(p => p.status !== "ok"), pairItem);
    sect("Нет в эталоне", "bad", res.extra, u => el("div", { class: "item", onclick: () => goTo(u.addr - S.base) },
      el("span", { class: "addr" }, hexl(u.addr, addrW())), el("span", { class: "nm" }, u.name || "(без имени)"), el("span", { class: "kd" }, M.KINDS[u.kind])));
    const out = res.pairs.length - res.inScopePairs.length;
    if (out) b.append(el("div", { class: "hint" }, "Ещё совпавших с эталоном вне выбранных видов или диапазона: " + out));
    if (!o.reveal) {
      b.append(el("div", { class: "sec" }, "Пропущено", el("span", { class: "badge" }, res.missing.length)),
        el("div", { class: "row" }, el("button", { onclick: () => { o.reveal = true; renderDock(); } }, "Показать пропущенные (это подсказка!)")));
    } else {
      sect("Пропущено", "", res.missing, r => el("div", { class: "item", title: r.desc || "", onclick: () => { goTo(r.addr - S.base); refDialog(r); } },
        el("span", { class: "addr" }, hexl(r.addr, addrW())), el("span", { class: "nm" }, r.name), el("span", { class: "kd" }, kindText(r))));
      b.append(el("div", { class: "row" }, el("button", { onclick: () => { o.reveal = false; renderDock(); } }, "Скрыть пропущенные")));
    }
  }

  // ----------------------------------------------------------------- навигация
  function ensureVisible() {
    const n = visibleRows(), r = rowOf(S.cur);
    if (r < S.top) S.top = r;
    else if (r >= S.top + n) S.top = r - n + 1;
  }
  function setCur(off, extend) {
    if (!S.fw) return;
    off = cellStart(Math.max(0, Math.min(size() - 1, off)));
    if (extend) {
      if (S.anchor === null) S.anchor = S.cur;
      S.sel = { a: S.anchor, b: off };
    } else { S.sel = null; S.anchor = off; }
    const pm = mineAt(S.cur), pr = refAt(S.cur);
    S.cur = off;
    ensureVisible();
    renderHex(); renderInsp(); renderStatus();
    // список карт перерисовываем, только когда сменился объект под курсором
    const same = (a, b) => (a ? a.item : null) === (b ? b.item : null);
    if (!same(mineAt(off), pm) || !same(refAt(off), pr)) renderDock();
  }
  // keepDock: переход из списка -- список не перерисовываем, иначе второй
  // щелчок двойного попадёт уже в новую строку и двойной щелчок не сработает
  function goTo(off, noHist, keepDock) {
    if (!S.fw || !inImg(off)) { toast("Адрес вне образа — проверьте базу"); return; }
    if (!noHist) { S.hist.push(S.cur); if (S.hist.length > 200) S.hist.shift(); S.fwd = []; }
    S.cur = off; S.sel = null; S.anchor = off;
    S.top = Math.max(0, rowOf(off) - 3);
    S.tab = "hex";
    if (keepDock) { renderMenubar(); renderToolbar(); renderTabs(); renderPane(); renderInsp(); renderStatus(); }
    else renderAll();
    $("#view").focus();
  }
  function pickRow(tr) {
    for (const x of tr.parentNode.querySelectorAll("tr.on")) x.classList.remove("on");
    tr.classList.add("on");
  }
  function back() { if (S.hist.length) { S.fwd.push(S.cur); goTo(S.hist.pop(), true); } }
  function forward() { if (S.fwd.length) { S.hist.push(S.cur); goTo(S.fwd.pop(), true); } }

  function selRange() {
    if (S.sel) return [Math.min(S.sel.a, S.sel.b), Math.min(size(), Math.max(S.sel.a, S.sel.b) + cs())];
    return [S.cur, S.cur + 1];
  }
  function selectObjectAtCursor() {
    const u = mineAt(S.cur) || refAt(S.cur);
    if (!u) { toast("Под курсором нет карты"); return; }
    S.sel = { a: u.off, b: cellStart(u.end - 1) }; S.anchor = u.off;
    renderPane(); renderInsp(); renderStatus();
  }

  // следующий/предыдущий объект -- ваш или эталона
  function jumpObject(dir) {
    const starts = [];
    for (const u of S.pack.units()) starts.push(u.off);
    if (refVisible()) for (const u of S.ref.pack.units()) if (inImg(u.off)) starts.push(u.off);
    if (!starts.length) { toast("Объектов нет"); return; }
    starts.sort((a, b) => a - b);
    let t = null;
    if (dir > 0) t = starts.find(s => s > S.cur);
    else for (const s of starts) if (s < S.cur) t = s;
    if (t === null || t === undefined) { toast(dir > 0 ? "Дальше объектов нет" : "Раньше объектов нет"); return; }
    goTo(t);
  }

  // следующее/предыдущее отличие от второго файла
  function jumpDiff(dir) {
    if (!S.cmp) { toast("Сравнения нет: Проект → Сравнить с файлом…"); return; }
    const bl = S.cmp.blocks;
    if (!bl.length) { toast("Файлы совпадают"); return; }
    let t = null;
    if (dir > 0) { const b = bl.find(x => x.a > S.cur); t = b ? b.a : null; }
    else for (const x of bl) if (x.a < cellStart(S.cur)) t = x.a;
    if (t === null) { toast(dir > 0 ? "Дальше отличий нет" : "Раньше отличий нет"); return; }
    goTo(t);
  }

  // -------------------------------------------------------- изменения и отмена
  function change(fn) {
    if (!S.fw) return;
    const before = JSON.stringify(S.pack.toJSON());
    if (fn() === false) return;
    S.undo.push(before); if (S.undo.length > 80) S.undo.shift();
    S.redo = [];
    S.pack.touch();
    saveSoon();
    renderAll();
  }
  function restorePack(js) { S.pack = MK.Pack.fromJSON(JSON.parse(js), size()); saveSoon(); renderAll(); }
  function undo() { if (!S.undo.length) { toast("Отменять нечего"); return; } S.redo.push(JSON.stringify(S.pack.toJSON())); restorePack(S.undo.pop()); toast("Отменено"); }
  function redo() { if (!S.redo.length) return; S.undo.push(JSON.stringify(S.pack.toJSON())); restorePack(S.redo.pop()); }

  function nameTaken(name, except) {
    return !!name && S.pack.objects.some(o => o !== except && o.name === name);
  }

  // Объекты эталона -> в маппак (с адресами-смещениями)
  function refOrig(o) { return S.ref.objects.find(r => r.addr - S.base === o.addr && r.name === o.name) || MK.shift(o, S.base); }
  function adoptRef(list) {
    if (!list.length) return;
    let added = 0, skipped = 0;
    change(() => {
      for (const r of list) {
        const o = MK.shift(r, -S.base);
        delete o.source; delete o.typ;
        if (!inImg(o.addr)) { skipped++; continue; }
        if (S.pack.objects.some(x => x.addr === o.addr && x.name === o.name)) { skipped++; continue; }
        if (nameTaken(o.name)) o.name = o.name + "_" + hexl(S.base + o.addr);
        S.pack.add(o); added++;
      }
      if (!added) return false;
    });
    toast("В маппак добавлено: " + added + (skipped ? ", пропущено (уже есть или вне образа): " + skipped : ""), 4000);
  }
  function setHideRef(v) { S.hideRef = v; saveSoon(); renderAll(); }

  // ---------------------------------------------------- свойства карты
  function mapDialog(existing, preset) {
    if (!S.fw) return;
    const o = M.normalize(existing ? JSON.parse(JSON.stringify(existing)) : Object.assign({
      kind: "map", addr: S.cur, cols: 16, rows: 16, cell: "u8", name: "",
    }, preset || {}));
    // как в WinOLS: ширина и формат ячейки -- те, при которых карта встала ровно
    if (!existing && !preset) {
      o.cell = S.vw.cell; o.be = S.vw.be; o.cols = S.vw.cols;
      if (S.sel) {
        const [a, b] = selRange();
        const n = Math.max(1, Math.floor((b - a) / cs()));
        o.addr = a;
        if (n <= S.vw.cols) { o.kind = "curve"; o.cols = n; o.rows = 1; }
        else { o.kind = "map"; o.rows = Math.ceil(n / S.vw.cols); }
      }
    }
    const f = {};
    const inp = (k, w, cls) => (f[k] = el("input", { value: o[k] === undefined ? "" : o[k], class: cls || "", style: { width: w || "100%" } }));
    const selOf = (k, opts, val) => (f[k] = el("select", {}, ...opts.map(([v, t]) => el("option", { value: v, selected: String(val) === String(v) }, t))));
    const cellOpts = Object.keys(M.CELLS).map(c => [c, c]);
    inp("name"); inp("desc");
    f.addr = el("input", { class: "mono", value: hexl(S.base + o.addr), style: { width: "120px" } });
    selOf("kind", Object.entries(M.KINDS), o.kind);
    selOf("layout", [["plain", "по адресу сразу данные"], ["bosch", "заголовок Bosch: счётчики и оси перед данными"]], o.layout);
    selOf("order", [["R", "сначала строки (nR nC aR aC) — как у Bosch"], ["C", "сначала столбцы (nC nR aC aR)"]], (o.header && o.header[0] === "nC" && o.kind === "map") ? "C" : "R");
    selOf("countSize", [[1, "1 байт"], [2, "2 байта"]], o.countSize);
    f.cols = el("input", { type: "number", min: 1, value: o.cols, style: { width: "80px" } });
    f.rows = el("input", { type: "number", min: 1, value: o.rows, style: { width: "80px" } });
    f.length = el("input", { type: "number", min: 1, value: o.length || 16, style: { width: "80px" } });
    selOf("cell", cellOpts, o.cell);
    f.be = el("input", { type: "checkbox", checked: !!o.be });
    inp("factor", "110px", "mono"); inp("offset", "110px", "mono"); inp("unit", "110px");
    const axisUi = (key, title) => {
      const a = o[key];
      const g = {};
      g.mode = el("select", {}, ...[["none", "нет"], ["inline", "в записи (заголовок)"], ["ref", "отдельная ось по адресу"]].map(([v, t]) => el("option", { value: v, selected: a.mode === v }, t)));
      g.ref = el("input", { class: "mono", style: { width: "130px" }, value: a.mode === "ref" && a.ref !== null ? hexl(S.base + a.ref) : "", placeholder: "адрес или имя оси" });
      g.cell = el("select", {}, ...cellOpts.map(([v]) => el("option", { value: v, selected: a.cell === v }, v)));
      g.factor = el("input", { class: "mono", value: a.factor, style: { width: "90px" } });
      g.offset = el("input", { class: "mono", value: a.offset, style: { width: "90px" } });
      g.unit = el("input", { value: a.unit || "", style: { width: "80px" } });
      g.box = el("fieldset", {}, el("legend", {}, title),
        el("div", { class: "row" }, g.mode, g.ref, el("span", { class: "muted" }, "точки"), g.cell),
        el("div", { class: "row" }, "×", g.factor, "+", g.offset, "ед.", g.unit));
      return g;
    };
    const axC = axisUi("axisC", "Ось столбцов (X) — быстрый индекс: соседние ячейки в памяти");
    const axR = axisUi("axisR", "Ось строк (Y) — медленный индекс");
    const info = el("div", { class: "hint mono" });
    const prev = el("div", { style: { overflow: "auto", maxHeight: "34vh", marginTop: "6px" } });
    const numOr = (s, d) => { const v = parseFloat(String(s).replace(",", ".")); return isNaN(v) ? d : v; };

    function collect() {
      const n = {
        name: f.name.value.trim().replace(/\s+/g, "_"), desc: f.desc.value.trim(), kind: f.kind.value,
        addr: parseInt(f.addr.value.replace(/^0x/i, ""), 16) - S.base,
        layout: f.layout.value, countSize: +f.countSize.value,
        cols: Math.max(1, parseInt(f.cols.value, 10) || 1), rows: Math.max(1, parseInt(f.rows.value, 10) || 1),
        length: Math.max(1, parseInt(f.length.value, 10) || 1),
        cell: f.cell.value, be: f.be.checked,
        factor: numOr(f.factor.value, 1), offset: numOr(f.offset.value, 0), unit: f.unit.value.trim(),
      };
      if (n.layout === "bosch") n.header = n.kind === "map" ? (f.order.value === "C" ? ["nC", "nR", "aC", "aR"] : ["nR", "nC", "aR", "aC"]) : ["nC", "aC"];
      for (const [key, g] of [["axisC", axC], ["axisR", axR]]) {
        n[key] = { mode: g.mode.value, ref: g.mode.value === "ref" ? parseAddr(g.ref.value) : null, cell: g.cell.value,
                   factor: numOr(g.factor.value, 1), offset: numOr(g.offset.value, 0), unit: g.unit.value.trim() };
      }
      if (n.kind === "string") n.layout = "plain";
      return M.normalize(n);
    }
    function refresh() {
      const kind = f.kind.value;
      axR.box.style.display = kind === "map" ? "" : "none";
      axC.box.style.display = (kind === "map" || kind === "curve") ? "" : "none";
      f.rows.disabled = kind !== "map" && kind !== "block";
      f.cols.disabled = kind === "value" || kind === "string";
      lenBox.style.display = kind === "string" ? "" : "none";
      f.order.disabled = f.layout.value !== "bosch" || kind !== "map";
      f.countSize.disabled = f.layout.value !== "bosch";
      for (const g of [axC, axR]) {
        g.ref.style.display = g.mode.value === "ref" ? "" : "none";
        // отдельная ось: масштаб и единицу по умолчанию берём у неё самой
        if (g.mode.value === "ref" && g.factor.value === "1" && g.offset.value === "0" && !g.unit.value) {
          const ax = myAxisAt(parseAddr(g.ref.value));
          if (ax) { g.factor.value = ax.factor; g.offset.value = ax.offset; g.unit.value = ax.unit || ""; g.cell.value = ax.cell; }
        }
      }
      const n = collect();
      if (isNaN(n.addr) || !inImg(n.addr)) { info.textContent = "адрес вне образа"; prev.innerHTML = ""; return; }
      const g = M.geometry(n);
      const warn = [];
      if (g.end > size()) warn.push("выходит за конец образа");
      const busy = S.pack.overlapping(g.start, g.end).filter(u => u.item !== existing);
      if (busy.length) warn.push("пересекается с вашими объектами: " + busy.map(u => u.item.name || fa(u.off)).slice(0, 4).join(", "));
      for (const [key, t] of [["axisC", "столбцов"], ["axisR", "строк"]]) {
        const a = n[key];
        const used = n.kind === "map" || (n.kind === "curve" && key === "axisC");
        if (used && a.mode === "ref") {
          if (a.ref === null) warn.push("ось " + t + ": не понял адрес");
          else if (!myAxisAt(a.ref)) warn.push("ось " + t + ": по " + fa(a.ref) + " в маппаке нет оси — разметьте её отдельно, вид «ось»");
        }
        if (used && a.mode === "inline" && n.layout !== "bosch") warn.push("ось " + t + " «в записи» бывает только с заголовком");
      }
      const r = M.readObject(n, data(), x => x, myAxisAt);
      if (n.layout === "bosch") {
        if ("nR" in r.counts) warn.push("в заголовке строк: " + r.counts.nR + (r.counts.nR === n.rows ? " ✔" : " ✗"));
        if ("nC" in r.counts) warn.push("в заголовке столбцов: " + r.counts.nC + (r.counts.nC === n.cols ? " ✔" : " ✗"));
      }
      info.innerHTML = esc(fa(g.start) + "–" + fa(g.end - 1) + "  (" + (g.end - g.start) + " байт), данные с " + fa(g.dataAddr)) +
        (warn.length ? "<br>" + warn.map(esc).join("<br>") : "");
      if (n.kind === "value") prev.innerHTML = '<div class="score mono">' + fmtVal(r.values[0]) + " " + esc(n.unit) + "</div>";
      else if (n.kind === "string") prev.innerHTML = '<div class=mono>"' + esc(r.text || "") + '"</div>';
      else prev.innerHTML = tableHtml(r.values, n.cols, (n.kind === "map" || n.kind === "block") ? n.rows : 1, r.axisC, n.kind === "map" ? r.axisR : null, fmtVal);
    }
    const readHdr = el("button", { onclick: () => {
      const n = collect();
      if (n.layout !== "bosch") { toast("Только для раскладки с заголовком"); return; }
      const r = M.readObject(n, data(), x => x);
      if ("nC" in r.counts) f.cols.value = r.counts.nC;
      if ("nR" in r.counts) f.rows.value = r.counts.nR;
      refresh();
    } }, "Размер из заголовка");
    const step = (inpEl, d) => () => { inpEl.value = Math.max(1, (+inpEl.value || 1) + d); refresh(); };
    const lenBox = el("span", {}, "длина ", f.length);
    const body = el("div", { style: { minWidth: "min(880px, 90vw)" } },
      el("div", { class: "form" },
        el("label", {}, "Имя"), f.name, el("label", {}, "Описание"), f.desc,
        el("label", {}, "Вид"), el("div", { class: "row" }, f.kind, "адрес", f.addr, lenBox),
        el("label", {}, "Раскладка"), el("div", { class: "row" }, f.layout, f.order, "счётчик", f.countSize, readHdr),
        el("label", {}, "Размер"), el("div", { class: "row" }, "столбцов", el("button", { onclick: step(f.cols, -1) }, "−"), f.cols, el("button", { onclick: step(f.cols, 1) }, "+"),
          "строк", el("button", { onclick: step(f.rows, -1) }, "−"), f.rows, el("button", { onclick: step(f.rows, 1) }, "+")),
        el("label", {}, "Ячейка"), el("div", { class: "row" }, f.cell, el("label", {}, f.be, " HiLo (big-endian)")),
        el("label", {}, "Пересчёт"), el("div", { class: "row" }, "физ = сырое ×", f.factor, "+", f.offset, "единица", f.unit)),
      axC.box, axR.box, info, prev);
    body.addEventListener("input", refresh);
    body.addEventListener("change", refresh);
    const btns = [];
    if (existing) btns.push({ text: "Удалить", run: () => change(() => S.pack.remove(existing)) });
    btns.push({ text: "OK", primary: true, run: () => {
      const n = collect();
      if (!inImg(n.addr) || M.geometry(n).end > size()) { toast("Объект вне образа"); return false; }
      if (nameTaken(n.name, existing)) { toast("Имя «" + n.name + "» уже есть в маппаке"); return false; }
      if (!n.name) n.name = (n.kind === "axis" ? "AX_" : n.kind === "map" ? "KF_" : n.kind === "curve" ? "KL_" : "W_") + hexl(S.base + n.addr);
      // открытая вкладка этой карты остаётся открытой
      if (existing) for (const t of S.tabs) if (t.src === "mine" && t.name === existing.name && t.addr === existing.addr) {
        t.name = n.name; t.addr = n.addr; t.key = tabKey("mine", n);
        if (S.tab === tabKey("mine", existing)) S.tab = t.key;
      }
      if (!existing) { S.cur = n.addr; S.sel = null; S.anchor = n.addr; }
      change(() => { if (existing) S.pack.remove(existing); S.pack.add(n); });
    } });
    dialog((existing ? "Свойства карты: " + (existing.name || "") : "Новая карта") + " — K", body, btns);
    refresh();
    f.name.focus();
  }

  // ---- карточки сверки и эталона
  function pairDialog(p) {
    const t = el("table", { class: "chk" }, el("tr", {}, el("td", {}, ""), el("td", {}, el("b", {}, "Проверка")), el("td", {}, el("b", {}, "У вас")), el("td", {}, el("b", {}, "В эталоне"))));
    for (const c of p.checks) {
      t.append(el("tr", {}, el("td", { class: c.ok ? "ok" : "bad" }, c.ok ? "✔" : "✗"), el("td", {}, c.what, c.note ? el("div", { class: "hint" }, c.note) : null),
        el("td", { class: "mono" }, String(c.user)), el("td", { class: "mono" }, String(c.ref))));
    }
    dialog((p.u.name || "") + " ↔ " + p.r.name + " — " + (p.status === "ok" ? "совпало" : "частично"),
      el("div", {}, p.r.desc ? el("p", { class: "hint" }, p.r.desc) : null, t), [
        { text: "К эталону", run: () => goTo(p.r.addr - S.base) }, { text: "OK", primary: true, run: () => { } }]);
  }
  function refDialog(r) {
    const res = M.readObject(r, data(), a => a - S.base, ref => S.ref.objects.find(x => x.addr === ref && x.kind === "axis") || null);
    const rows = (r.kind === "map" || r.kind === "block") ? r.rows : 1;
    const body = el("div", {}, el("p", {}, el("b", {}, r.name), " — ", r.desc || ""), el("p", { class: "mono" }, hexl(r.addr, addrW()) + "  " + M.describe(r)),
      r.kind === "value" ? el("div", { class: "score mono" }, fmtVal(res.values[0])) :
        el("div", { style: { overflow: "auto", maxHeight: "50vh" }, html: r.kind === "string" ? esc(res.text || "") : tableHtml(res.values, r.cols, rows, res.axisC, r.kind === "map" ? res.axisR : null, fmtVal) }));
    dialog("Эталон: " + r.name, body, [
      { text: "Взять в маппак", run: () => adoptRef([r]) },
      { text: "OK", primary: true, run: () => { } }]);
  }

  // ------------------------------------------------------------- диалоги
  let dlgClose = null;
  function dialog(title, body, buttons) {
    closeMenus();
    const veil = $("#veil");
    veil.innerHTML = "";
    const btns = el("div", { class: "btns" });
    const box = el("div", { class: "dlg", role: "dialog" }, el("h3", {}, title), el("div", { class: "body" }, body), btns);
    const close = () => { veil.classList.remove("on"); veil.innerHTML = ""; dlgClose = null; (S.tab === "hex" ? $("#view") : $("#mapbody")).focus(); };
    for (const b of buttons.concat([{ text: buttons.length ? "Отмена" : "Закрыть", cancel: true }])) {
      btns.append(el("button", { class: b.primary ? "primary" : "", onclick: () => {
        if (b.cancel) { close(); return; }
        const r = b.run();
        // действие могло открыть следующий диалог -- его не трогаем
        if (r !== false && dlgClose === close) close();
      } }, b.text));
    }
    box.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter" && (e.ctrlKey || (e.target.tagName === "INPUT" && e.target.type !== "checkbox"))) {
        const p = btns.querySelector(".primary");
        if (p) { e.preventDefault(); p.click(); }
      }
      e.stopPropagation();
    });
    veil.append(box);
    veil.classList.add("on");
    dlgClose = close;
    // фокус сразу, а не по таймеру: иначе первые набранные символы теряются
    const first = box.querySelector("input,select,textarea,button.primary");
    if (first) first.focus();
    return close;
  }

  function gotoDialog() {
    if (!S.fw) return;
    const dl = el("datalist", { id: "gotoList" });
    const names = S.pack.objects.map(o => o.name).concat(refVisible() ? S.ref.objects.map(o => o.name) : []);
    for (const n of names.slice(0, 5000)) dl.append(el("option", { value: n }));
    const inp = el("input", { style: { width: "100%" }, class: "mono", list: "gotoList", placeholder: "адрес (C84B78, 0x…), +смещение в файле или имя карты" });
    dialog("Перейти к адресу — G", el("div", {}, inp, dl), [
      { text: "Перейти", primary: true, run: () => {
        const off = parseAddr(inp.value);
        if (off === null || !inImg(off)) { toast("Не понял адрес или он вне образа"); return false; }
        goTo(off);
      } }]);
    inp.focus();
  }

  function baseDialog() {
    if (!S.fw) return;
    const inp = el("input", { class: "mono", value: "0x" + hexl(S.base), style: { width: "140px" } });
    const body = el("div", {}, el("div", { class: "row" }, "База образа", inp),
      el("p", { class: "hint" }, "Адрес первого байта файла — как Base Address при загрузке в Ghidra и смещение при импорте DAMOS/A2L в WinOLS (для C166 обычно 0x800000)."));
    if (S.ref) {
      const sug = F.suggestBases(S.ref.raw, data()).slice(0, 3);
      body.append(el("div", { class: "sec" }, "По эталону"),
        ...sug.map(s => el("div", { class: "row" }, el("span", { class: "mono" }, "0x" + hexl(s.base)),
          el("span", { class: "hint" }, "в образе " + s.inside + " объектов, заголовков совпало " + s.hdrOk + " из " + s.hdr),
          el("button", { onclick: () => (inp.value = "0x" + hexl(s.base)) }, "взять"))));
    }
    dialog("База образа", body, [{ text: "OK", primary: true, run: () => {
      const v = parseInt(inp.value.trim().replace(/^0x/i, ""), 16);
      if (isNaN(v) || v < 0) { toast("База — шестнадцатеричное число"); return false; }
      setBase(v);
    } }]);
    inp.select();
  }

  function encodeText(s) {
    const out = [];
    for (const ch of s) { let b = M.CP1251.indexOf(ch); if (b < 0) b = ch.charCodeAt(0) & 0xFF; out.push(b); }
    return out;
  }
  function parsePattern(mode, s) {
    if (mode === "text") return encodeText(s);
    const t = s.replace(/[\s,]+/g, "");
    if (!t || t.length % 2) return null;
    const out = [];
    for (let i = 0; i < t.length; i += 2) {
      const p = t.slice(i, i + 2);
      if (p === "??") out.push(-1);
      else if (/^[0-9a-f]{2}$/i.test(p)) out.push(parseInt(p, 16));
      else return null;
    }
    return out;
  }
  function findAll(pat, limit) {
    const d = data(), res = [];
    const first = pat.findIndex(b => b >= 0);
    outer: for (let i = 0; i + pat.length <= d.length; i++) {
      if (first >= 0 && d[i + first] !== pat[first]) continue;
      for (let k = 0; k < pat.length; k++) if (pat[k] >= 0 && d[i + k] !== pat[k]) continue outer;
      res.push(i);
      if (res.length >= limit) break;
    }
    return res;
  }
  function searchDialog() {
    if (!S.fw) return;
    const last = S.lastSearch || { mode: "hex", text: "" };
    const mode = el("select", {}, el("option", { value: "hex", selected: last.mode === "hex" }, "байты (hex, ?? — любой)"),
      el("option", { value: "text", selected: last.mode === "text" }, "текст (cp1251)"));
    const inp = el("input", { class: "mono", style: { width: "100%" }, value: last.text, placeholder: "e6 f8 ?? 4b   или   AEC 07" });
    const list = el("div", { class: "list", style: { maxHeight: "40vh", overflow: "auto" } });
    const run = all => {
      const pat = parsePattern(mode.value, inp.value);
      if (!pat || !pat.length) { toast("Пустой или неверный образец"); return false; }
      S.lastSearch = { mode: mode.value, text: inp.value, pat };
      if (!all) { searchNext(); return; }
      const res = findAll(pat, 500);
      list.innerHTML = "";
      list.append(el("div", { class: "hint" }, "Найдено: " + res.length + (res.length >= 500 ? " (первые 500)" : "")));
      for (const o of res) {
        const u = mineAt(o) || refAt(o);
        list.append(el("div", { class: "item", onclick: () => goTo(o) }, el("span", { class: "addr" }, fa(o)), el("span", { class: "nm" }, u ? u.item.name : "")));
      }
      return false;
    };
    dialog("Найти — Ctrl+F", el("div", {}, el("div", { class: "row" }, mode), inp, list), [
      { text: "Найти все", run: () => run(true) },
      { text: "Найти далее (F3)", primary: true, run: () => run(false) }]);
    inp.focus();
  }
  function searchNext() {
    const ls = S.lastSearch;
    if (!ls) { searchDialog(); return; }
    const d = data(), pat = ls.pat;
    for (let n = 1; n <= d.length; n++) {
      const i = (S.cur + n) % d.length;
      if (i + pat.length > d.length) continue;
      let ok = true;
      for (let k = 0; k < pat.length; k++) if (pat[k] >= 0 && d[i + k] !== pat[k]) { ok = false; break; }
      if (ok) { goTo(i); S.sel = { a: i, b: cellStart(i + pat.length - 1) }; renderHex(); renderInsp(); return; }
    }
    toast("Не найдено");
  }

  const KEYS = [
    ["Hex-дамп", null],
    ["стрелки, PgUp/PgDn", "курсор по ячейкам; с Shift — выделение (или тяните мышью)"],
    ["Home / End", "начало / конец строки; с Ctrl — начало / конец файла"],
    ["M / W", "больше / меньше столбцов"],
    ["Tab", "вид: текст → 2D → 3D"],
    ["A", "начинать строки с курсора"],
    ["K", "новая карта по выделению; на своей карте — свойства"],
    ["Enter, двойной щелчок", "открыть карту под курсором во вкладке"],
    ["Ctrl+A", "выделить карту под курсором"],
    ["Del", "удалить свою карту под курсором"],
    ["] / [", "следующая / предыдущая карта"],
    ["N / Shift+N", "следующее / предыдущее отличие от второго файла"],
    ["Окно карты", null],
    ["стрелки", "ячейка; её адрес и значение — в строке состояния"],
    ["Enter", "к этой ячейке в hex"],
    ["Tab", "вид: текст → 2D → 3D"],
    ["Esc", "вернуться к hex"],
    ["Везде", null],
    ["G, Ctrl+G", "перейти к адресу, +смещению или имени"],
    ["Ctrl+F, F3", "поиск байтов или текста; следующее"],
    ["Alt+← / Alt+→", "назад / вперёд по переходам"],
    ["Ctrl+Z / Ctrl+Y", "отменить / вернуть"],
    ["Ctrl+S / Ctrl+Shift+S", "сохранить маппак как A2L / DAMOS"],
    ["Ctrl+O", "открыть прошивку"],
  ];
  function helpDialog() {
    const t = el("table", { class: "keys" }, ...KEYS.map(([k, d]) => d === null
      ? el("tr", {}, el("td", { colspan: 2 }, el("b", {}, k)))
      : el("tr", {}, el("td", {}, el("kbd", {}, k)), el("td", {}, d))));
    dialog("Горячие клавиши", el("div", {}, t,
      el("p", { class: "hint" }, "Цвета в hex: заливка — ваш маппак (данные, оси, счётчики), подчёркивание — эталон, красный — отличие от второго файла. Щелчок по заголовку «адрес» переключает на смещение в файле.")), []);
  }
  function aboutDialog() {
    dialog("О программе", el("div", {},
      el("p", {}, el("b", {}, "ЭБУ hex-тренажёр"), " — hex-редактор для чтения прошивок ЭБУ и разметки калибровок в духе WinOLS."),
      el("p", { class: "hint" }, "Открывает DAMOS (.dam) и A2L как эталон, пишет свой маппак в A2L и DAMOS, сравнивает две прошивки, сверяет разметку с эталоном. Байты прошивки не меняются; файлы никуда не отправляются.")), []);
  }

  // ------------------------------------------------------------ файлы
  async function openFirmware(file) {
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    if (!buf.length) { toast("Пустой файл"); return; }
    S.fw = { name: file.name, size: buf.length, data: buf, crc: crc32(buf) };
    S.pack = new MK.Pack(buf.length);
    S.cur = 0; S.sel = null; S.anchor = 0; S.top = 0; S.hist = []; S.fwd = []; S.undo = []; S.redo = []; S.lastCheck = null;
    S.tabs = []; S.tab = "hex";
    if (S.cmp) computeDiff();
    const saved = lsGet("ecu-hex:" + S.fw.crc);
    if (saved) {
      try {
        const p = JSON.parse(saved);
        S.base = p.base || 0;
        S.pack = MK.Pack.fromJSON(p.pack, buf.length);
        S.hideRef = !!p.hideRef;
        if (inImg(p.cur)) { S.cur = p.cur; S.anchor = p.cur; S.top = Math.max(0, (p.cur >> 4) - 3); }
        if (S.pack.objects.length) toast("Восстановлен маппак этой прошивки: " + S.pack.objects.length + " объектов");
      } catch (e) { /* испорчено -- начинаем заново */ }
    }
    if (S.ref) relinkRef();
    renderAll();
    $("#view").focus();
    if (S.ref && !saved) suggestBase(S.ref.raw, "эталона");
  }

  // ---- сравнение с другим файлом
  function computeDiff() {
    const a = data(), b = S.cmp.data, n = Math.max(a.length, b.length);
    const blocks = [];
    let bytes = 0, i = 0;
    while (i < n) {
      if (i < a.length && i < b.length && a[i] === b[i]) { i++; continue; }
      const s = i;
      let last = i;
      // соседние отличия через 1-3 одинаковых байта -- один блок
      while (i < n && i - last <= 3) {
        if (!(i < a.length && i < b.length && a[i] === b[i])) { last = i; bytes++; }
        i++;
      }
      blocks.push({ a: s, b: Math.min(last + 1, size()) });
      i = last + 1;
    }
    S.cmp.blocks = blocks.filter(x => x.a < size());
    S.cmp.bytes = bytes;
  }
  async function openCompare(file) {
    if (!file || !S.fw) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    S.cmp = { name: file.name, size: buf.length, data: buf, crc: crc32(buf) };
    computeDiff();
    toast("Сравнение с " + file.name + ": " + S.cmp.blocks.length + " блоков, " + S.cmp.bytes + " байт" + (buf.length !== size() ? "; размеры разные" : ""), 4500);
    S.dock = "diff"; S.mapCmp = "cur";
    renderAll();
  }
  function closeCompare() { S.cmp = null; if (S.dock === "diff") S.dock = "pack"; renderAll(); }
  // Поменять местами: второй файл становится текущим. Маппак остаётся --
  // он привязан к смещениям, а у версий одной прошивки они общие.
  function swapCompare() {
    if (!S.cmp) return;
    const a = S.fw, b = S.cmp;
    S.fw = { name: b.name, size: b.size, data: b.data, crc: b.crc };
    S.cmp = { name: a.name, size: a.size, data: a.data, crc: a.crc };
    S.cur = Math.min(S.cur, size() - 1);
    relinkRef(); computeDiff();
    toast("Текущий файл: " + S.fw.name);
    renderAll();
  }

  // Предложить базу, при которой объекты файла ложатся в образ
  function suggestBase(objs, what, after) {
    if (!S.fw || !objs.length) { if (after) after(); return; }
    const sug = F.suggestBases(objs, data());
    const cur = F.scoreBase(objs, data(), S.base);
    const best = sug[0];
    if (!best || best.base === S.base || best.score <= cur.score) { if (after) after(); return; }
    const body = el("div", {},
      el("p", {}, "При базе 0x" + hexl(S.base) + " в образ попадает " + cur.inside + " объектов " + what + " из " + objs.length + "."),
      el("p", {}, "При базе ", el("b", { class: "mono" }, "0x" + hexl(best.base)), " — " + best.inside + (best.hdr ? ", и совпадает " + best.hdrOk + " заголовков карт из " + best.hdr : "") + "."),
      el("p", { class: "hint" }, "База — адрес первого байта файла (Base Address в Ghidra, смещение импорта в WinOLS). Если у вас другая база, оставьте её: адреса " + what + " будут сдвинуты."));
    const btns = [{ text: "Сделать базу 0x" + hexl(best.base), primary: true, run: () => { setBase(best.base); if (after) setTimeout(after, 0); } }];
    if (what === "эталона") btns.unshift({ text: "Оставить базу, сдвинуть эталон", run: () => { S.ref.shift = S.base - best.base; relinkRef(); renderAll(); } });
    else btns.unshift({ text: "Оставить базу", run: () => { if (after) setTimeout(after, 0); } });
    dialog("База образа", body, btns);
  }

  function setBase(b) {
    S.base = b;
    relinkRef();
    S.lastCheck = null;
    saveSoon(); renderAll();
  }

  async function openReference(file) {
    if (!file) return;
    let r;
    try { r = F.loadReference(await readText(file), file.name); }
    catch (e) { toast("Не удалось разобрать: " + e.message, 5000); return; }
    S.ref = { name: file.name, format: r.format, raw: r.objects, objects: r.objects, shift: 0 };
    S.lastCheck = null;
    relinkRef();
    toast(r.format + ": " + r.objects.length + " объектов", 3000);
    if (!S.hideRef) S.dock = "ref";
    renderAll();
    suggestBase(r.objects, "эталона");
  }

  // Сдвиг эталона, уточнение размеров по заголовкам и индекс по смещениям
  function relinkRef() {
    if (!S.ref) return;
    const sh = S.ref.shift || 0;
    S.ref.objects = S.ref.raw.map(o => MK.shift(o, sh));
    if (S.fw) {
      F.refineWithImage(S.ref.objects, data(), a => a - S.base);
      S.ref.pack = MK.Pack.fromJSON(S.ref.objects.map(o => MK.shift(o, -S.base)), size());
    }
  }

  async function openPack(file) {
    if (!file || !S.fw) return;
    let r;
    try { r = F.loadReference(await readText(file), file.name); }
    catch (e) { toast("Не удалось разобрать: " + e.message, 5000); return; }
    const load = mode => {
      F.refineWithImage(r.objects, data(), a => a - S.base);
      change(() => {
        if (mode === "replace") S.pack.objects = [];
        for (const o of r.objects) {
          const c = MK.shift(o, -S.base);
          delete c.source; delete c.typ;
          if (nameTaken(c.name)) c.name += "_" + hexl(o.addr);
          S.pack.add(c);
        }
      });
      toast("Маппак: " + r.objects.length + " объектов из " + file.name);
      S.dock = "pack"; renderDock();
    };
    const ask = () => {
      if (!S.pack.objects.length) { load("replace"); return; }
      dialog("Открыть маппак", el("p", {}, "В маппаке уже " + S.pack.objects.length + " объектов. Заменить их или добавить объекты из " + file.name + "?"), [
        { text: "Добавить", run: () => load("merge") }, { text: "Заменить", primary: true, run: () => load("replace") }]);
    };
    suggestBase(r.objects, "маппака", ask);
  }

  async function savePack(fmt) {
    if (!S.fw) return toast("Нет прошивки");
    if (!S.pack.objects.length) return toast("Маппак пуст — нечего сохранять");
    const objs = MK.cpuObjects(S.pack, S.base).map(o => { delete o._orig; return o; });
    const name = S.fw.name.replace(/\.[^.]+$/, "");
    const opts = { project: name, comment: S.fw.name + " CRC32 " + S.fw.crc, base: S.base, size: size() };
    const res = fmt === "a2l" ? F.writeA2l(objs, opts) : F.writeDamos(objs, opts);
    const bytes = fmt === "a2l" ? new TextEncoder().encode(res.text) : F.encodeCp1251(res.text);
    if (!(await saveFile(name + (fmt === "a2l" ? ".a2l" : ".dam"), bytes))) return;
    if (res.warnings.length) {
      dialog("Сохранено с замечаниями", el("div", {}, el("p", {}, "Формат " + (fmt === "a2l" ? "A2L" : "DAMOS") + " выражает не всё:"),
        el("ul", {}, ...res.warnings.slice(0, 100).map(w => el("li", {}, w)))), []);
    } else if (!window.claude) toast("Сохранено: " + objs.length + " объектов");
  }

  let saveT = 0;
  function saveSoon() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      if (!S.fw) return;
      const ok = lsSet("ecu-hex:" + S.fw.crc, JSON.stringify({ base: S.base, pack: S.pack.toJSON(), hideRef: S.hideRef, cur: S.cur }));
      if (!ok) toast("Автосохранение недоступно — сохраните маппак в файл");
    }, 1000);
  }

  const needFw = fn => () => (S.fw ? fn() : toast("Сначала откройте прошивку: Проект → Открыть прошивку"));
  const ACTIONS = {
    openFw: async () => openFirmware(await pickFile()),
    openRef: async () => openReference(await pickFile(".dam,.DAM,.a2l,.A2L")),
    openCmp: needFw(async () => openCompare(await pickFile())),
    newObject: needFw(() => mapDialog(null)),
    saveA2l: () => savePack("a2l"),
    saveDamos: () => savePack("dam"),
    openPack: needFw(async () => openPack(await pickFile(".a2l,.A2L,.dam,.DAM"))),
    clearPack: () => {
      if (!S.fw || !S.pack.objects.length) return;
      dialog("Очистить маппак", el("p", {}, "Удалить все " + S.pack.objects.length + " объектов маппака? Отменить можно клавишами Ctrl+Z."), [
        { text: "Удалить всё", primary: true, run: () => change(() => { S.pack.objects = []; }) }]);
    },
  };

  // ------------------------------------------------------- меню и панель
  function viewMode(m) { setVw({ mode: m }); }
  function cycleMode() { setVw({ mode: { text: "2d", "2d": "3d", "3d": "text" }[S.vw.mode] }); }
  function toggleTheme() {
    const r = document.documentElement;
    const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    r.dataset.theme = dark ? "light" : "dark";
    lsSet("ecu-hex:theme", r.dataset.theme);
    renderAll();
  }
  const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  const underMine = () => (S.tab === "hex" ? mineAt(S.cur) : null);
  const tabObj = () => { const t = activeTab(); return t ? resolveTab(t) : null; };

  // пункт: [текст, клавиша, действие, {on, dis}] или "-"
  function menus() {
    const fw = !!S.fw;
    const u = underMine();
    return [
      ["Проект", [
        ["Открыть прошивку…", "Ctrl+O", ACTIONS.openFw],
        ["Сравнить с файлом…", "", ACTIONS.openCmp, { dis: !fw }],
        ["Поменять файлы местами", "", swapCompare, { dis: !S.cmp }],
        ["Закрыть сравнение", "", closeCompare, { dis: !S.cmp }],
        "-",
        ["Открыть маппак (A2L / DAMOS)…", "", ACTIONS.openPack, { dis: !fw }],
        ["Сохранить маппак как A2L…", "Ctrl+S", ACTIONS.saveA2l, { dis: !fw }],
        ["Сохранить маппак как DAMOS…", "Ctrl+Shift+S", ACTIONS.saveDamos, { dis: !fw }],
        ["Очистить маппак…", "", ACTIONS.clearPack, { dis: !fw }],
        "-",
        ["База образа…", "", baseDialog, { dis: !fw }],
      ]],
      ["Правка", [
        ["Отменить", "Ctrl+Z", undo, { dis: !S.undo.length }],
        ["Вернуть", "Ctrl+Y", redo, { dis: !S.redo.length }],
        "-",
        ["Новая карта…", "K", ACTIONS.newObject, { dis: !fw }],
        ["Свойства карты…", "K", () => { const o = u ? u.item : (activeTab() && activeTab().src === "mine" ? tabObj() : null); if (o) mapDialog(o); else toast("Под курсором нет вашей карты"); }, { dis: !fw }],
        ["Удалить карту", "Del", () => { if (u) change(() => S.pack.remove(u.item)); else toast("Под курсором нет вашей карты"); }, { dis: !u }],
      ]],
      ["Вид", [
        ["Текст", "Tab", () => viewMode("text"), { on: S.vw.mode === "text", dis: !fw }],
        ["2D", "Tab", () => viewMode("2d"), { on: S.vw.mode === "2d", dis: !fw }],
        ["3D", "Tab", () => viewMode("3d"), { on: S.vw.mode === "3d", dis: !fw }],
        "-",
        ["Больше столбцов", "M", () => setVw({ cols: S.vw.cols + 1 }), { dis: !fw }],
        ["Меньше столбцов", "W", () => setVw({ cols: S.vw.cols - 1 }), { dis: !fw }],
        ["Строки с курсора", "A", alignRows, { dis: !fw }],
        ["Строки от начала файла", "", () => setVw({ org: 0 }), { dis: !fw || !org() }],
        "-",
        ["8 бит", "", () => setVw({ cell: cellName(8, cellSigned()) }), { on: cellBits() === "8" }],
        ["16 бит", "", () => setVw({ cell: cellName(16, cellSigned()) }), { on: cellBits() === "16" }],
        ["32 бит", "", () => setVw({ cell: cellName(32, cellSigned()) }), { on: cellBits() === "32" }],
        ["Float", "", () => setVw({ cell: "f32" }), { on: cellBits() === "f" }],
        ["Со знаком", "", () => setVw({ cell: cellName(+cellBits() || 8, !cellSigned()) }), { on: cellSigned(), dis: cellBits() === "f" }],
        ["LoHi (Intel)", "", () => setVw({ be: false }), { on: !S.vw.be }],
        ["HiLo (Motorola)", "", () => setVw({ be: true }), { on: S.vw.be }],
        ["Hex", "", () => setVw({ fmt: "hex" }), { on: S.vw.fmt === "hex" }],
        ["Десятичные", "", () => setVw({ fmt: "dec" }), { on: S.vw.fmt === "dec" }],
        "-",
        ["Адреса: смещение в файле", "", () => { S.showOff = !S.showOff; renderPane(); }, { on: S.showOff }],
        ["Панель значений", "", () => { S.showInsp = !S.showInsp; renderAll(); }, { on: S.showInsp }],
        ["Тёмная тема", "", toggleTheme, { on: isDark() }],
      ]],
      ["Выделение", [
        ["Выделить карту под курсором", "Ctrl+A", selectObjectAtCursor, { dis: !fw }],
        ["Снять выделение", "Esc", () => { S.sel = null; renderPane(); renderInsp(); renderStatus(); }, { dis: !S.sel }],
        ["Новая карта из выделения…", "K", ACTIONS.newObject, { dis: !S.sel }],
      ]],
      ["Поиск", [
        ["Перейти к адресу…", "G", gotoDialog, { dis: !fw }],
        ["Найти…", "Ctrl+F", searchDialog, { dis: !fw }],
        ["Найти далее", "F3", searchNext, { dis: !fw }],
        "-",
        ["Следующая карта", "]", () => jumpObject(1), { dis: !fw }],
        ["Предыдущая карта", "[", () => jumpObject(-1), { dis: !fw }],
        ["Следующее отличие", "N", () => jumpDiff(1), { dis: !S.cmp }],
        ["Предыдущее отличие", "Shift+N", () => jumpDiff(-1), { dis: !S.cmp }],
        "-",
        ["Назад", "Alt+←", back, { dis: !S.hist.length }],
        ["Вперёд", "Alt+→", forward, { dis: !S.fwd.length }],
      ]],
      ["Эталон", [
        ["Открыть DAMOS / A2L…", "", ACTIONS.openRef],
        ["Скрыть эталон (тренировка)", "", () => setHideRef(!S.hideRef), { on: S.hideRef, dis: !S.ref }],
        "-",
        ["Список карт эталона", "", () => { S.dock = "ref"; renderDock(); }, { dis: !S.ref }],
        ["Сверить с маппаком", "", () => { S.dock = "check"; if (S.ref) runCheck(); renderDock(); }, { dis: !S.ref || !fw }],
      ]],
      ["Справка", [
        ["Горячие клавиши", "F1", helpDialog],
        ["О программе", "", aboutDialog],
      ]],
    ];
  }

  let openMenu = null;
  function closeMenus() {
    openMenu = null;
    for (const m of document.querySelectorAll("#menubar > .mi")) m.classList.remove("open");
    const d = $("#menubar .drop");
    if (d) d.remove();
  }
  function showMenu(idx) {
    closeMenus();
    openMenu = idx;
    const items = menus()[idx][1];
    const mi = $("#menubar").children[idx];
    mi.classList.add("open");
    const drop = el("div", { class: "drop", style: { left: mi.offsetLeft + "px" } });
    for (const it of items) {
      if (it === "-") { drop.append(el("hr")); continue; }
      const [text, key, run, st] = it;
      const s = st || {};
      drop.append(el("div", { class: "it" + (s.dis ? " dis" : ""), onclick: e => { e.stopPropagation(); if (s.dis) return; closeMenus(); run(); } },
        el("span", {}, s.on ? "✓" : ""), el("span", {}, text), el("span", { class: "k" }, key || "")));
    }
    $("#menubar").append(drop);
  }
  function renderMenubar() {
    const bar = $("#menubar");
    bar.innerHTML = "";
    menus().forEach(([title], i) => bar.append(el("div", { class: "mi",
      onclick: e => { e.stopPropagation(); if (openMenu === i) closeMenus(); else showMenu(i); },
      onmouseenter: () => { if (openMenu !== null && openMenu !== i) showMenu(i); } }, title)));
  }

  function renderToolbar() {
    const tb = $("#toolbar");
    tb.innerHTML = "";
    const fw = !!S.fw;
    const b = (text, title, fn, on, dis) => el("button", { class: on ? "on" : "", title, onclick: fn, disabled: dis || false }, text);
    const grp = (...k) => el("span", { class: "grp" }, ...k);
    tb.append(grp(b("Открыть", "Открыть прошивку (Ctrl+O)", ACTIONS.openFw), b("Эталон", "Открыть DAMOS / A2L как эталон", ACTIONS.openRef),
      b("Сравнить", "Сравнить с другой прошивкой", ACTIONS.openCmp, !!S.cmp, !fw), b("Сохранить", "Сохранить маппак как A2L (Ctrl+S)", ACTIONS.saveA2l, false, !fw)));
    if (!fw) return;
    const v = S.vw;
    const colsIn = el("input", { type: "number", min: 1, max: MAX_COLS, value: v.cols, title: "Столбцов", onchange: e => setVw({ cols: parseInt(e.target.value, 10) || 1 }) });
    tb.append(
      grp(b("Текст", "Вид: значения таблицей (Tab)", () => viewMode("text"), v.mode === "text"), b("2D", "Вид: график (Tab)", () => viewMode("2d"), v.mode === "2d"),
        b("3D", "Вид: поверхность выделения или видимых строк (Tab)", () => viewMode("3d"), v.mode === "3d")),
      grp(b("◂", "Меньше столбцов (W)", () => setVw({ cols: v.cols - 1 })), colsIn, b("▸", "Больше столбцов (M)", () => setVw({ cols: v.cols + 1 })),
        b("⇤", "Строки с курсора (A)", alignRows, !!org())),
      grp(...[["8", "8 бит"], ["16", "16 бит"], ["32", "32 бит"], ["f", "float"]].map(([k, t]) =>
        b(k === "f" ? "F" : k, t, () => setVw({ cell: k === "f" ? "f32" : cellName(+k, cellSigned()) }), cellBits() === k)),
        b("±", "Со знаком", () => setVw({ cell: cellName(+cellBits() || 8, !cellSigned()) }), cellSigned(), cellBits() === "f")),
      grp(b("LoHi", "Порядок байт Intel: C166, TriCore", () => setVw({ be: false }), !v.be, cs() === 1), b("HiLo", "Порядок байт Motorola", () => setVw({ be: true }), v.be, cs() === 1)),
      grp(b("Hex", "Числа в hex", () => setVw({ fmt: "hex" }), v.fmt === "hex"), b("Dec", "Десятичные числа", () => setVw({ fmt: "dec" }), v.fmt === "dec")),
      grp(b("Карта…", "Новая карта по выделению (K)", ACTIONS.newObject), b("Перейти", "Перейти к адресу (G)", gotoDialog), b("Найти", "Найти (Ctrl+F)", searchDialog)));
    if (S.cmp) tb.append(grp(el("span", { class: "lab" }, "отличия:"), b("▲", "Предыдущее отличие (Shift+N)", () => jumpDiff(-1)), b("▼", "Следующее отличие (N)", () => jumpDiff(1))));
  }

  // ------------------------------------------------------------ статус
  function renderStatus() {
    const st = $("#status");
    if (!S.fw) { st.innerHTML = "<span>Прошивка не открыта</span><span class=sp></span>"; return; }
    const o = curOff(), d = data();
    const seg = (html, cls, title) => '<span class="' + (cls || "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + html + "</span>";
    let h = seg("Адрес <b>" + fa(o) + "</b>") + seg("Смещение <b>+" + hexl(o) + "</b>") +
      seg("Значение <b>" + d[o] + "</b> (" + hexl(d[o], 2) + "h)" + (S.cmp && o < S.cmp.size && S.cmp.data[o] !== d[o] ? ' <span class=bad>было ' + S.cmp.data[o] + "</span>" : ""));
    const u = S.tab === "hex" ? (mineAt(o) || refAt(o)) : null;
    if (S.tab !== "hex") {
      const t = activeTab(), ob = resolveTab(t);
      if (ob) h += seg(esc(ob.name) + " [" + S.mapCell.r + "," + S.mapCell.c + "]");
    } else if (u) { const e = elementAt(u, o); h += seg(esc(u.item.name) + (e ? " " + esc(e.text) : "")); }
    if (S.sel) { const [a, b] = selRange(); h += seg("Выделено " + (b - a) + " байт"); }
    h += '<span class=sp></span>';
    if (S.cmp) h += seg("Сравнение: " + esc(S.cmp.name) + ", " + S.cmp.blocks.length + " отл.");
    h += seg("Маппак: " + S.pack.objects.length) +
      seg(S.ref ? "Эталон: " + esc(S.ref.name) + (S.hideRef ? " (скрыт)" : "") : "Эталона нет") +
      '<span class="clk" data-act="base" title="Изменить базу образа">База <b>0x' + hexl(S.base) + "</b></span>" +
      seg(esc(S.fw.name) + ", " + S.fw.size.toLocaleString("ru") + " байт");
    st.innerHTML = h;
  }

  function renderAll() {
    renderMenubar(); renderToolbar(); renderTabs(); renderPane(); renderInsp(); renderStatus(); renderDock();
  }

  // ------------------------------------------------------------ клавиатура
  function mapKeys(e, k, kl) {
    const t = activeTab(), o = resolveTab(t);
    if (!o) return false;
    const rows = (o.kind === "map" || o.kind === "block") ? o.rows : 1;
    const mv = (dr, dc) => {
      S.mapCell = { r: Math.max(0, Math.min(rows - 1, S.mapCell.r + dr)), c: Math.max(0, Math.min(o.cols - 1, S.mapCell.c + dc)) };
      renderMap(); renderInsp(); renderStatus();
    };
    if (k === "ArrowRight") mv(0, 1);
    else if (k === "ArrowLeft") mv(0, -1);
    else if (k === "ArrowDown") mv(1, 0);
    else if (k === "ArrowUp") mv(-1, 0);
    else if (k === "Home") mv(0, -o.cols);
    else if (k === "End") mv(0, o.cols);
    else if (k === "Escape") showHex();
    else if (k === "Enter") { const off = mapCellOff(); if (off !== null) goTo(off); }
    else if (k === "Tab") {
      const views = rows > 1 ? ["table", "2d", "3d"] : (o.kind === "value" || o.kind === "string") ? ["table"] : ["table", "2d"];
      S.mapView = views[(views.indexOf(S.mapView) + 1) % views.length]; renderMap();
    }
    else if (kl === "k" && t.src === "mine") mapDialog(o);
    else if (k === "Delete" && t.src === "mine") { closeTab(t.key); change(() => S.pack.remove(o)); }
    else return false;
    return true;
  }

  document.addEventListener("keydown", e => {
    if ($("#veil").classList.contains("on")) return;
    if (openMenu !== null && e.key === "Escape") { closeMenus(); e.preventDefault(); return; }
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const k = e.key, kl = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === "F1") { e.preventDefault(); helpDialog(); return; }
    if (ctrl && kl === "o") { e.preventDefault(); ACTIONS.openFw(); return; }
    if (!S.fw) return;
    let handled = true;
    if (e.altKey && k === "ArrowLeft") back();
    else if (e.altKey && k === "ArrowRight") forward();
    else if (ctrl && kl === "s") savePack(e.shiftKey ? "dam" : "a2l");
    else if (ctrl && kl === "z" && !e.shiftKey) undo();
    else if (ctrl && (kl === "y" || (kl === "z" && e.shiftKey))) redo();
    else if (ctrl && kl === "f") searchDialog();
    else if (ctrl && kl === "g") gotoDialog();
    else if (ctrl && kl === "a") { if (S.tab !== "hex") showHex(); selectObjectAtCursor(); }
    else if (ctrl || e.altKey) handled = false;
    else if (k === "F3") searchNext();
    else if (kl === "g") gotoDialog();
    else if (S.tab !== "hex") handled = mapKeys(e, k, kl);
    else handled = hexKeys(e, k, kl);
    if (handled) e.preventDefault();
  });

  function hexKeys(e, k, kl) {
    const n = visibleRows();
    if (k === "ArrowRight") setCur(cellStart(S.cur) + cs(), e.shiftKey);
    else if (k === "ArrowLeft") setCur(cellStart(S.cur) - cs(), e.shiftKey);
    else if (k === "ArrowDown") setCur(S.cur + rowBytes(), e.shiftKey);
    else if (k === "ArrowUp") setCur(S.cur - rowBytes(), e.shiftKey);
    else if (k === "PageDown") { S.top += n - 1; setCur(S.cur + rowBytes() * (n - 1), e.shiftKey); }
    else if (k === "PageUp") { S.top = Math.max(0, S.top - n + 1); setCur(S.cur - rowBytes() * (n - 1), e.shiftKey); }
    else if (k === "Home" && (e.ctrlKey || e.metaKey)) setCur(0, e.shiftKey);
    else if (k === "End" && (e.ctrlKey || e.metaKey)) setCur(size() - 1, e.shiftKey);
    else if (k === "Home") setCur(Math.max(0, rowBase(rowOf(S.cur))), e.shiftKey);
    else if (k === "End") setCur(rowBase(rowOf(S.cur)) + rowBytes() - cs(), e.shiftKey);
    else if (kl === "a") alignRows();
    else if (k === "Tab") cycleMode();
    else if (k === "Escape") { S.sel = null; renderHex(); renderInsp(); renderStatus(); }
    else if (k === "Enter") openUnderCursor();
    else if (k === "Delete") { const u = mineAt(S.cur); if (u) change(() => S.pack.remove(u.item)); }
    else if (kl === "k") { const u = mineAt(S.cur); mapDialog(u && !S.sel ? u.item : null); }
    else if (kl === "m" || k === "+" || k === "=") setVw({ cols: S.vw.cols + 1 });
    else if (kl === "w" || k === "-") setVw({ cols: S.vw.cols - 1 });
    else if (kl === "n") jumpDiff(e.shiftKey ? -1 : 1);
    else if (k === "]") jumpObject(1);
    else if (k === "[") jumpObject(-1);
    else if (k === "?") helpDialog();
    else return false;
    return true;
  }

  function openUnderCursor() {
    const mu = mineAt(S.cur);
    if (mu) return openObj("mine", mu.item);
    const ru = refAt(S.cur);
    if (ru) return openObj("ref", ru.item);
    toast("Под курсором нет карты. Новая — K");
  }

  // ------------------------------------------------------------ мышь
  // смещение ячейки под мышью: в тексте -- по ячейке, в 2D -- по точке графика
  function offAtEvent(e) {
    const cv = e.target.closest && e.target.closest("canvas.v2d");
    if (cv) return offAtCanvas(cv, e.clientX - cv.getBoundingClientRect().left);
    const t = e.target.closest && e.target.closest("[data-o]");
    return t ? +t.dataset.o : null;
  }

  function wireView() {
    const view = $("#view");
    let dragging = false;
    view.addEventListener("mousedown", e => {
      if (!S.fw) return;
      view.focus();
      const off = offAtEvent(e);
      if (off === null) return;
      e.preventDefault();
      if (e.shiftKey) { setCur(off, true); return; }
      setCur(off, false);
      dragging = true;
    });
    view.addEventListener("mousemove", e => {
      if (!dragging || !(e.buttons & 1)) return;
      const off = offAtEvent(e);
      if (off !== null && off !== S.cur) setCur(off, true);
    });
    window.addEventListener("mouseup", () => { dragging = false; });
    view.addEventListener("dblclick", e => { if (offAtEvent(e) !== null) openUnderCursor(); });
    view.addEventListener("wheel", e => {
      if (!S.fw) return;
      e.preventDefault();
      const rowsStep = S.vw.mode === "text" ? 3 : Math.max(1, Math.round(visibleRows() / 8));
      S.top = Math.max(0, Math.min(totalRows() - 1, S.top + Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40)) * rowsStep));
      renderHex();
    }, { passive: false });
    $("#hexhead").addEventListener("click", e => { if (e.target.closest(".a")) { S.showOff = !S.showOff; renderHex(); } });
    // окно карты: щелчок -- ячейка, двойной -- к ней в hex
    const mb = $("#mapbody");
    mb.addEventListener("click", e => {
      const td = e.target.closest("td[data-r]");
      if (!td) return;
      S.mapCell = { r: +td.dataset.r, c: +td.dataset.c };
      renderMap(); renderInsp(); renderStatus();
      mb.focus();
    });
    mb.addEventListener("dblclick", e => { if (e.target.closest("td[data-r]")) { const off = mapCellOff(); if (off !== null) goTo(off); } });
    // полоса прокрутки
    const track = $("#vscroll");
    const jump = e => {
      if (!S.fw) return;
      const r = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      S.top = Math.floor(frac * Math.max(0, totalRows() - visibleRows()));
      renderHex();
    };
    let tdrag = false;
    track.addEventListener("mousedown", e => { tdrag = true; jump(e); e.preventDefault(); });
    window.addEventListener("mousemove", e => { if (tdrag) jump(e); });
    window.addEventListener("mouseup", () => (tdrag = false));
    window.addEventListener("resize", () => renderPane());
    // ширина окна «Карты»
    let sdrag = false;
    $("#splitL").addEventListener("mousedown", e => { sdrag = true; e.preventDefault(); });
    window.addEventListener("mousemove", e => {
      if (!sdrag) return;
      const w = Math.max(200, Math.min(window.innerWidth * 0.6, e.clientX - $("#work").getBoundingClientRect().left));
      $("#dock").style.width = w + "px";
      renderPane();
    });
    window.addEventListener("mouseup", () => (sdrag = false));
  }

  function wireChrome() {
    const th = lsGet("ecu-hex:theme");
    if (th) document.documentElement.dataset.theme = th;
    document.addEventListener("click", () => { if (openMenu !== null) closeMenus(); });
    $("#docktabs").addEventListener("click", e => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      S.dock = b.dataset.tab; renderDock();
    });
    $("#status").addEventListener("click", e => { if (e.target.closest("[data-act=base]")) baseDialog(); });
    $("#inspClose").onclick = () => { S.showInsp = false; renderAll(); };
    // перетаскивание: .dam/.a2l -- эталон (с Shift -- в свой маппак); бинарный
    // файл -- прошивка, а если прошивка уже открыта -- спросим, сравнить ли
    const drop = $("#drop");
    window.addEventListener("dragover", e => { e.preventDefault(); drop.style.display = "block"; });
    window.addEventListener("dragleave", e => { if (!e.relatedTarget) drop.style.display = "none"; });
    window.addEventListener("drop", async e => {
      e.preventDefault(); drop.style.display = "none";
      const files = Array.from(e.dataTransfer.files);
      files.sort((a, b) => /\.(dam|a2l)$/i.test(a.name) - /\.(dam|a2l)$/i.test(b.name));
      const shift = e.shiftKey;
      for (const f of files) {
        if (/\.(dam|a2l)$/i.test(f.name)) { if (shift && S.fw) await openPack(f); else await openReference(f); }
        else if (S.fw) {
          dialog("Файл " + f.name, el("p", {}, "Прошивка уже открыта. Сравнить с этим файлом или открыть его вместо текущей?"), [
            { text: "Открыть вместо", run: () => { openFirmware(f); } },
            { text: "Сравнить", primary: true, run: () => { openCompare(f); } }]);
        } else await openFirmware(f);
      }
    });
  }

  wireChrome();
  wireView();
  renderAll();

  // для отладки и тестов в браузере
  window.ETApp = { S, makeZip, openFirmware, openReference, openPack, openCompare, savePack, goTo, setBase, runCheck, change, ACTIONS, renderAll, openObj, showHex };
})();
