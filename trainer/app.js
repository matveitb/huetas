// ЭБУ hex-тренажёр: интерфейс.
//
// Hex-редактор только для чтения. Поверх байтов -- два слоя:
//   * ваш маппак (заливка): карты, кривые, оси, которые вы разметили сами
//     и сохраняете в A2L или DAMOS;
//   * эталон (подчёркивание): DAMOS или A2L, с которым идёт сверка. Для
//     тренировки его можно скрыть -- тогда он молчит до сверки.
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
    cur: 0, sel: null, anchor: null, top: 0,
    hist: [], fwd: [],
    showOff: false,
    side: "pack", packFilter: "", refFilter: "", refKind: "all",
    vw: { cols: 16, cell: "u8", be: false, fmt: "hex", mode: "text", org: 0 },
    rot: { az: -0.7, el: 0.6 },
    objFmt: "phys", objView: "table",
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
  const refVisible = () => S.ref && !S.hideRef;

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

  // Элемент объекта под байтом: какая часть, индекс, значение
  function elementAt(u, off) {
    const p = partAt(u, off);
    if (!p) return null;
    const o = u.item;
    if (p.what === "str") return { p, text: "строка" };
    const cs = M.cellOf(p.cell).size;
    const i = Math.floor((off - p.addr) / cs);
    const raw = M.readCell(data(), p.addr + i * cs, p.cell, o.be);
    const u8 = s => (s ? " " + s : "");
    if (p.what === "data") {
      const v = M.fmtNum(raw * o.factor + o.offset, 4) + u8(o.unit);
      if (o.kind === "map" || (o.kind === "block" && o.rows > 1)) return { p, text: "ячейка [" + Math.floor(i / o.cols) + "," + (i % o.cols) + "] = " + v };
      if (o.kind === "value") return { p, text: "значение = " + v };
      return { p, text: "точка [" + i + "] = " + v };
    }
    if (p.what === "aR" || p.what === "aC") {
      const ax = p.what === "aR" ? o.axisR : o.axisC;
      return { p, text: (p.what === "aR" ? "ось строк" : "ось столбцов") + " [" + i + "] = " + M.fmtNum(raw * ax.factor + ax.offset, 4) + u8(ax.unit) };
    }
    return { p, text: (p.what === "nR" ? "счётчик строк" : "счётчик столбцов") + " = " + raw };
  }

  // ------------------------------------------------------------------ вид
  //
  // Основной вид -- как текстовый режим WinOLS: N столбцов ячеек выбранного
  // формата (8/16/32 бит, LoHi/HiLo, hex/dec). Классический hex -- это 16
  // столбцов по байту. Ширину меняют клавиши M (больше) и W (меньше): когда
  // она равна ширине карты, карта встаёт ровной таблицей. В режиме 2D те же
  // байты рисуются графиком, вертикальные линии -- через каждые N ячеек, и у
  // карты они встают параллельно «скачкам».
  //
  // Строки можно выровнять по курсору (A): тогда строка начинается ровно с
  // карты, а не с адреса, кратного ширине.
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

  const CELL_OPTS = [["u8", "8 бит"], ["s8", "8 бит со знаком"], ["u16", "16 бит"], ["s16", "16 бит со знаком"],
    ["u32", "32 бит"], ["s32", "32 бит со знаком"], ["f32", "float"]];

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

  function setVw(ch) {
    Object.assign(S.vw, ch);
    S.vw.cols = Math.max(1, Math.min(MAX_COLS, S.vw.cols | 0));
    S.cur = cellStart(S.cur);
    S.sel = null; S.anchor = S.cur;
    S.top = Math.max(0, rowOf(S.cur) - 3);
    renderBar(); renderHex(); renderInsp(); renderBottom();
  }

  function renderBar() {
    const bar = $("#viewbar");
    bar.innerHTML = "";
    if (!S.fw) return;
    const v = S.vw;
    const seg = (val, text, title) => el("button", { class: v.mode === val ? "on" : "", title, onclick: () => setVw({ mode: val }) }, text);
    const colsIn = el("input", { type: "number", min: 1, max: MAX_COLS, value: v.cols, style: { width: "62px" },
      onchange: e => setVw({ cols: parseInt(e.target.value, 10) || 1 }) });
    const c = M.cellOf(v.cell);
    bar.append(
      el("span", { class: "seg" }, seg("text", "Текст", "Значения таблицей (Tab — переключить)"), seg("2d", "2D", "Те же байты графиком (Tab — переключить)")),
      el("span", { class: "muted" }, "столбцов"),
      el("button", { title: "Меньше столбцов (W)", onclick: () => setVw({ cols: v.cols - 1 }) }, "W −"), colsIn,
      el("button", { title: "Больше столбцов (M)", onclick: () => setVw({ cols: v.cols + 1 }) }, "M +"),
      el("select", { title: "Формат ячейки", onchange: e => setVw({ cell: e.target.value }) },
        ...CELL_OPTS.map(([k, t]) => el("option", { value: k, selected: v.cell === k }, t))),
      el("select", { title: "Порядок байт: LoHi — Intel (C166, TriCore), HiLo — Motorola", disabled: c.size === 1, onchange: e => setVw({ be: e.target.value === "hilo" }) },
        el("option", { value: "lohi", selected: !v.be }, "LoHi"), el("option", { value: "hilo", selected: v.be }, "HiLo")),
      el("select", { title: "Запись чисел", disabled: c.float || v.mode === "2d", onchange: e => setVw({ fmt: e.target.value }) },
        el("option", { value: "hex", selected: v.fmt === "hex" }, "hex"), el("option", { value: "dec", selected: v.fmt === "dec" }, "dec")),
      el("button", { title: "Начинать строки с курсора (A) — карта встанет таблицей с первого столбца", onclick: alignRows }, "A ⇤ строки с курсора"));
    if (org()) bar.append(el("span", { class: "muted mono" }, "с " + fa(S.vw.org)),
      el("button", { title: "Строки — снова от начала файла", onclick: () => setVw({ org: 0 }) }, "×"));
  }
  function alignRows() { setVw({ org: S.cur }); }

  function renderHex() {
    if (!S.fw) { renderWelcome(); return; }
    S.top = Math.max(0, Math.min(S.top, totalRows() - 1));
    if (S.vw.mode === "2d") render2d(); else renderText();
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
    let head = '<span class=a title="Щелчок — переключить адрес CPU / смещение в файле">' + (S.showOff ? "смещение" : "адрес") + "</span>";
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
    const vals = [];
    for (let i = 0; i < count; i++) vals.push(M.readCell(d, start + i * c, S.vw.cell, S.vw.be));
    const fin = vals.filter(isFinite);
    const lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 1;
    const L = 52, R = 8, T = 16, B = 18;
    const step = count > 1 ? (w - L - R) / (count - 1) : 0;
    const xOf = i => L + i * step;
    const yOf = v => T + (h - T - B) * (hi > lo ? 1 - (v - lo) / (hi - lo) : 0.5);
    g.fillStyle = cssVar("--bg"); g.fillRect(0, 0, w, h);
    // полосы: ваш маппак, выделение, эталон
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
    // линии строк
    g.strokeStyle = cssVar("--line"); g.lineWidth = 1;
    g.fillStyle = cssVar("--muted"); g.font = "10px " + cssVar("--mono");
    const rowPx = grid * step;
    const labelEvery = Math.max(1, Math.ceil(70 / Math.max(1, rowPx)));
    // линии -- по границам строк основного вида (с учётом выравнивания)
    const i0 = mod((rowBase(0) - start) / c, grid);
    for (let k = 0, i = i0; i <= count; i += grid, k++) {
      const x = Math.round(xOf(i) - step / 2) + 0.5;
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, h - B); g.stroke();
      if (opt.labels && k % labelEvery === 0 && i < count) g.fillText(hexl(S.base + start + i * c), x + 2, T - 4);
    }
    // значения
    g.strokeStyle = cssVar("--fg"); g.lineWidth = 1.2;
    g.beginPath();
    vals.forEach((v, i) => { const x = xOf(i), y = yOf(v); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    // курсор
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
    $("#hexhead").innerHTML = '<span class=muted> 2D: ' + count + " ячеек с " + fa(start) + ", линии — через " + S.vw.cols + " (M/W)</span>";
    let cv = view.querySelector("canvas.v2d");
    if (!cv) { view.innerHTML = ""; cv = el("canvas", { class: "v2d" }); view.append(cv); }
    drawStrip(cv, view.clientWidth, view.clientHeight, start, count, S.vw.cols, { cursor: true, sel: true, labels: true });
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
    $("#viewbar").innerHTML = "";
    $("#view").innerHTML = '<div id=welcome>' +
      "<h2>Hex-редактор для разметки прошивок ЭБУ</h2><ol>" +
      "<li><b>Прошивка…</b> — откройте .bin (или перетащите файл в окно).</li>" +
      "<li><b>база</b> — адрес первого байта файла, как <i>Base Address</i> при загрузке в Ghidra и как адреса в DAMOS/A2L. При загрузке эталона база подбирается сама.</li>" +
      "<li><b>Эталон DAMOS / A2L…</b> — его карты подчёркнуты в hex и перечислены на вкладке «Эталон». Для тренировки эталон можно скрыть.</li>" +
      "<li>Ищите карты как в WinOLS: клавишами <kbd>M</kbd> и <kbd>W</kbd> меняйте число столбцов, пока карта не встанет ровной таблицей (в режиме 2D, <kbd>Tab</kbd>, — пока линии не станут параллельны скачкам). Формат ячеек — 8/16/32 бит, LoHi/HiLo — над таблицей.</li>" +
      "<li>Выделите карту и нажмите <kbd>K</kbd> — размер и формат подставятся сами. Внизу — таблица, 2D и 3D в физических единицах.</li>" +
      "<li><b>Мой маппак → Сохранить как A2L / DAMOS</b>. <b>Сверка</b> — что совпало с эталоном, что нет и почему.</li>" +
      "</ol><p class=muted>Только чтение: байты прошивки не меняются. Файлы никуда не отправляются, маппак автоматически сохраняется в браузере. Клавиши — <kbd>F1</kbd>.</p></div>";
  }

  // ------------------------------------------------------------ инспектор
  function renderInsp() {
    const box = $("#insp");
    if (!S.fw) { box.innerHTML = ""; return; }
    const d = data(), o = S.cur;
    const rd = (cell, be) => M.readCell(d, o, cell, be);
    const fmt = v => (isFinite(v) ? M.fmtNum(v, 6) : "—");
    const rows = [
      ["адрес", fa(o)], ["смещение", "+" + hexl(o)],
      ["u8 / s8", rd("u8") + " / " + rd("s8")],
      ["двоично", d[o].toString(2).padStart(8, "0")],
      ["u16 LE", fmt(rd("u16"))], ["s16 LE", fmt(rd("s16"))],
      ["u16 BE", fmt(rd("u16", true))], ["s16 BE", fmt(rd("s16", true))],
      ["u32 LE", fmt(rd("u32"))], ["u32 BE", fmt(rd("u32", true))],
      ["f32 LE", fmt(rd("f32"))], ["f32 BE", fmt(rd("f32", true))],
    ];
    let h = "<table>" + rows.map(([k, v]) => "<tr><td>" + k + "</td><td>" + esc(v) + "</td></tr>").join("") + "</table>";
    if (S.sel) {
      const [a, b] = selRange();
      h += "<h4>Выделено</h4><table><tr><td>байт</td><td>" + (b - a) + " (0x" + hexl(b - a) + ")</td></tr><tr><td>с</td><td>" + fa(a) + "</td></tr><tr><td>по</td><td>" + fa(b - 1) + "</td></tr></table>";
    }
    const objBox = (u, ref) => {
      const e = elementAt(u, o);
      return '<div class="objbox' + (ref ? " ref" : "") + '"><b>' + esc(u.item.name || "(без имени)") + "</b><br><span class=muted>" + esc(M.describe(u.item)) + "</span>" +
        (e ? "<br>" + esc(e.text) : "") + (ref && u.item.desc ? "<br><span class=muted>" + esc(u.item.desc) + "</span>" : "") + "</div>";
    };
    const mu = mineAt(o), ru = refAt(o);
    h += "<h4>Мой маппак</h4>" + (mu ? objBox(mu, false) : "<div class=muted>—</div>");
    if (S.ref) h += "<h4>Эталон</h4>" + (S.hideRef ? "<div class=muted>скрыт (тренировка)</div>" : ru ? objBox(ru, true) : "<div class=muted>—</div>");
    h += '<div class=legend><span><i class=k-obj></i>данные</span><span><i class=k-axis></i>ось</span><span><i class=k-cnt></i>счётчик</span>' +
      (refVisible() ? '<span><i style="box-shadow: inset 0 -3px 0 var(--ref)"></i>эталон</span>' : "") + "</div>";
    box.innerHTML = h;
  }

  // --------------------------------------------------------- нижняя панель
  function heat(v, lo, hi) {
    if (!isFinite(v) || hi <= lo) return "";
    const t = (v - lo) / (hi - lo);
    return "background:hsla(" + Math.round(220 - 220 * t) + ",75%,52%,.28)";
  }
  const fmtVal = v => M.fmtNum(v, 3);

  function tableHtml(values, cols, rows, axC, axR, fmt) {
    const fin = values.filter(isFinite);
    const lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 0;
    let h = "<table class=map><tr><th class=corner>" + (rows > 1 ? "стр\\стлб" : "") + "</th>";
    for (let c = 0; c < cols; c++) h += "<th>" + (axC && axC[c] !== undefined ? fmtVal(axC[c]) : c) + "</th>";
    h += "</tr>";
    for (let r = 0; r < rows; r++) {
      h += "<tr><th>" + (axR && axR[r] !== undefined ? fmtVal(axR[r]) : r) + "</th>";
      for (let c = 0; c < cols; c++) {
        const v = values[r * cols + c];
        h += '<td style="' + heat(v, lo, hi) + '">' + fmt(v) + "</td>";
      }
      h += "</tr>";
    }
    return h + "</table>";
  }

  function myAxisAt(off) { return S.pack.objects.find(o => o.addr === off && o.kind === "axis") || null; }
  function refAxisAt(off) { return S.ref.pack.objects.find(o => o.addr === off && o.kind === "axis") || null; }

  function renderBottom() {
    const bar = $("#bottombar"), body = $("#bottombody");
    bar.innerHTML = ""; body.innerHTML = "";
    if (!S.fw) { bar.append(el("span", { class: "muted" }, "Просмотр")); return; }
    const mu = mineAt(S.cur);
    if (mu) return objPanel(mu.item, false, bar, body);
    const ru = refAt(S.cur);
    if (ru) return objPanel(ru.item, true, bar, body);
    stripPanel(bar, body);
  }

  function objPanel(o, isRef, bar, body) {
    const r = M.readObject(o, data(), a => a, isRef ? refAxisAt : myAxisAt);
    const fmtSel = el("select", { onchange: e => { S.objFmt = e.target.value; renderBottom(); } },
      ...[["phys", "физ."], ["raw", "сырое"], ["hex", "hex"]].map(([v, t]) => el("option", { value: v, selected: S.objFmt === v }, t)));
    bar.append(el("span", { class: "badge", style: { color: isRef ? "var(--ref)" : "var(--obj)" } }, isRef ? "эталон" : "мой маппак"),
      el("b", { class: "mono" }, o.name || "(без имени)"), el("span", { class: "muted" }, M.describe(o)), fmtSel);
    if (isRef) bar.append(el("button", { onclick: () => adoptRef([refOrig(o)]) }, "Взять в маппак"));
    else bar.append(el("button", { onclick: () => mapDialog(o) }, "Изменить (K)"),
      el("button", { onclick: () => change(() => S.pack.remove(o)) }, "Удалить (Del)"));
    const csz = M.cellOf(o.cell).size;
    const fmt = S.objFmt === "phys" ? fmtVal : S.objFmt === "raw" ? (v => String(v)) : (v => hexl(v < 0 ? v + Math.pow(2, 8 * csz) : v, 2 * csz));
    const vals = S.objFmt === "phys" ? r.values : (r.raw || []);
    const rows = (o.kind === "map" || o.kind === "block") ? o.rows : 1;
    const views = (o.kind === "value" || o.kind === "string") ? [] : rows > 1 ? [["table", "Таблица"], ["2d", "2D"], ["3d", "3D"]] : [["table", "Таблица"], ["2d", "2D"]];
    let view = views.some(v => v[0] === S.objView) ? S.objView : "table";
    if (views.length) bar.prepend(el("span", { class: "seg" }, ...views.map(([k, t]) =>
      el("button", { class: view === k ? "on" : "", onclick: () => { S.objView = k; renderBottom(); } }, t))));
    if (o.desc) body.append(el("div", { class: "hint" }, o.desc));
    if (o.layout === "bosch") {
      const bad = [];
      if ("nR" in r.counts && r.counts.nR !== o.rows) bad.push("строк в заголовке " + r.counts.nR);
      if ("nC" in r.counts && r.counts.nC !== o.cols) bad.push("столбцов в заголовке " + r.counts.nC);
      if (bad.length) body.append(el("div", { class: "bad" }, "Заголовок не сходится с размером: " + bad.join(", ")));
    }
    if (o.kind === "string") { body.append(el("div", { class: "mono" }, '"' + (r.text || "") + '"')); return; }
    if (o.kind === "value") { body.append(el("div", { class: "score mono" }, fmt(vals[0]) + (S.objFmt === "phys" && o.unit ? " " + o.unit : ""))); return; }
    const w = Math.max(320, Math.min(1000, body.clientWidth - 24)), h = Math.max(160, body.clientHeight - 40);
    if (view === "3d") body.append(surface3d(vals, o.cols, rows, r.axisC, r.axisR, w, h));
    else if (view === "2d") body.append(plotRows(vals, o.cols, rows, r.axisC, w, h));
    else body.append(el("div", { html: tableHtml(vals, o.cols, rows, r.axisC, o.kind === "map" ? r.axisR : null, fmt) }));
  }

  function stripPanel(bar, body) {
    bar.append(el("b", {}, "2D от курсора"),
      el("span", { class: "hint" }, "линии через " + S.vw.cols + " ячеек (M/W), формат — как в основном виде"),
      el("button", { onclick: () => mapDialog(null) }, "Новый объект… (K)"));
    const w = Math.max(300, body.clientWidth - 20);
    const cv = el("canvas", { class: "plot" });
    body.append(cv);
    const count = Math.max(2, Math.min(S.vw.cols * 24, 2048, Math.floor((size() - cellStart(S.cur)) / cs())));
    drawStrip(cv, w, Math.max(120, body.clientHeight - 16), cellStart(S.cur), count, S.vw.cols, { labels: true });
  }

  // Строки карты линиями: каждая строка -- своя кривая
  function plotRows(values, cols, rows, axC, w, h) {
    const cv = el("canvas", { class: "plot" });
    const g = fitCanvas(cv, w, h);
    const fin = values.filter(isFinite);
    const lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 1;
    const L = 52, R = 10, T = 10, B = 20;
    const xOf = i => L + (cols > 1 ? i * (w - L - R) / (cols - 1) : (w - L - R) / 2);
    const yOf = v => T + (h - T - B) * (hi > lo ? 1 - (v - lo) / (hi - lo) : 0.5);
    g.strokeStyle = cssVar("--line"); g.strokeRect(L - 0.5, T - 0.5, w - L - R + 1, h - T - B + 1);
    for (let r = 0; r < rows; r++) {
      g.strokeStyle = "hsl(" + Math.round(220 - 220 * (rows > 1 ? r / (rows - 1) : 0)) + ",70%,50%)";
      g.lineWidth = 1.5;
      g.beginPath();
      for (let c = 0; c < cols; c++) { const v = values[r * cols + c], x = xOf(c), y = yOf(v); if (c) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
    }
    g.fillStyle = cssVar("--muted"); g.font = "11px " + cssVar("--ui");
    g.fillText(M.fmtNum(hi, 3), 4, T + 10); g.fillText(M.fmtNum(lo, 3), 4, h - B);
    if (axC) { g.fillText(M.fmtNum(axC[0], 3), L, h - 5); const t = M.fmtNum(axC[cols - 1], 3); g.fillText(t, w - R - g.measureText(t).width, h - 5); }
    return cv;
  }

  // 3D-поверхность карты: перетаскивание мышью вращает, двойной щелчок -- сброс
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
    cv.addEventListener("mousedown", e => { drag3d = { x: e.clientX, y: e.clientY, az: S.rot.az, el: S.rot.el, draw, cv }; cv.style.cursor = "grabbing"; e.preventDefault(); });
    cv.addEventListener("dblclick", () => { S.rot = { az: -0.7, el: 0.6 }; draw(); });
    draw();
    return cv;
  }

  // ----------------------------------------------------------- боковая панель
  function renderSide() {
    const b = $("#sidebody");
    const keep = document.activeElement && b.contains(document.activeElement) && document.activeElement.dataset.keep;
    b.innerHTML = "";
    if (!S.fw) { b.append(el("div", { class: "empty" }, "Откройте прошивку.")); return; }
    ({ pack: sidePack, ref: sideRef, check: sideCheck })[S.side](b);
    if (keep) { const i = b.querySelector('[data-keep="' + keep + '"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }

  const kindText = o => M.KINDS[o.kind] + (o.kind === "map" ? " " + o.cols + "×" + o.rows : (o.kind === "value" || o.kind === "string") ? "" : " " + o.cols);

  function objList(container, items, offOf, curUnit) {
    const list = el("div", { class: "list" });
    for (const o of items.slice(0, 3000)) {
      const off = offOf(o);
      list.append(el("div", { class: "item" + (curUnit && curUnit.item.name === o.name && curUnit.off === off ? " on" : ""),
        title: o.desc || "", onclick: () => goTo(off) },
        el("span", { class: "addr" }, hexl(S.base + off, addrW())), el("span", { class: "nm" }, o.name || "(без имени)"), el("span", { class: "kd" }, kindText(o))));
    }
    if (items.length > 3000) list.append(el("div", { class: "hint" }, "показаны первые 3000 из " + items.length + " — уточните фильтр"));
    container.append(list);
  }

  function sidePack(b) {
    const objs = S.pack.objects.slice().sort((x, y) => x.addr - y.addr);
    const f = S.packFilter.toLowerCase();
    const shown = objs.filter(o => !f || (o.name || "").toLowerCase().includes(f) || fa(o.addr).toLowerCase().includes(f));
    b.append(el("div", { class: "row" },
      el("input", { placeholder: "фильтр по имени или адресу", value: S.packFilter, style: { flex: "1" }, "data-keep": "pf",
        oninput: e => { S.packFilter = e.target.value; renderSide(); } }),
      el("button", { title: "Новый объект у курсора (K)", onclick: () => mapDialog(null) }, "+ K")));
    b.append(el("div", { class: "hint" }, objs.length + " объектов" + (shown.length !== objs.length ? ", показано " + shown.length : "")));
    if (!objs.length) b.append(el("div", { class: "empty" }, "Маппак пуст. Подберите ширину клавишами M/W, чтобы карта встала ровной таблицей, выделите её и нажмите K. Сохраняется в A2L или DAMOS через меню «Мой маппак»."));
    objList(b, shown, o => o.addr, mineAt(S.cur));
  }

  function sideRef(b) {
    if (!S.ref) { b.append(el("div", { class: "empty" }, "Эталон не загружен. Откройте DAMOS (.dam) или A2L кнопкой «Эталон DAMOS / A2L…» или перетащите файл в окно.")); return; }
    const inside = S.ref.objects.filter(o => inImg(o.addr - S.base)).length;
    b.append(el("div", { class: "hint" }, S.ref.name + " — " + S.ref.format + ", " + S.ref.objects.length + " объектов, в образе " + inside +
      (S.ref.shift ? ", адреса сдвинуты на " + (S.ref.shift > 0 ? "+" : "-") + "0x" + hexl(Math.abs(S.ref.shift)) : "")));
    b.append(el("div", { class: "row" }, el("label", {}, el("input", { type: "checkbox", checked: S.hideRef, onchange: e => { S.hideRef = e.target.checked; saveSoon(); renderAll(); } }),
      " Скрыть эталон"), el("span", { class: "hint" }, "тренировка: размечайте сами, потом «Сверка»")));
    if (S.hideRef) { b.append(el("div", { class: "empty" }, "Эталон скрыт: нет подчёркивания в hex и списка. Сверка работает.")); return; }
    const kinds = [["all", "все виды"]].concat(Object.entries(M.KINDS));
    b.append(el("div", { class: "row" },
      el("input", { placeholder: "имя, описание или адрес", value: S.refFilter, style: { flex: "1" }, "data-keep": "rf",
        oninput: e => { S.refFilter = e.target.value; renderSide(); } }),
      el("select", { onchange: e => { S.refKind = e.target.value; renderSide(); } }, ...kinds.map(([k, t]) => el("option", { value: k, selected: S.refKind === k }, t)))));
    const f = S.refFilter.toLowerCase();
    const shown = S.ref.objects.filter(o => (S.refKind === "all" || o.kind === S.refKind) &&
      (!f || o.name.toLowerCase().includes(f) || (o.desc || "").toLowerCase().includes(f) || hexl(o.addr).toLowerCase().includes(f)))
      .sort((x, y) => x.addr - y.addr);
    b.append(el("div", { class: "row" }, el("span", { class: "hint" }, "показано " + shown.length),
      el("button", { title: "Скопировать показанные объекты эталона в ваш маппак — например, чтобы пересохранить DAMOS как A2L", onclick: () => adoptRef(shown) }, "Взять показанные в маппак")));
    objList(b, shown, o => o.addr - S.base, refAt(S.cur));
  }

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

  function sideCheck(b) {
    if (!S.ref) { b.append(el("div", { class: "empty" }, "Загрузите эталон: DAMOS (.dam) или A2L.")); return; }
    const o = S.checkOpts;
    b.append(el("div", { class: "hint" }, "Ваш маппак (" + S.pack.objects.length + ") против " + S.ref.name + ". Пара ищется по адресу, имя может быть любым."),
      el("div", { class: "sec" }, "Что проверять"), kindBoxes(o.kinds),
      el("div", { class: "row" }, "адреса",
        el("input", { class: "mono", placeholder: "от", value: o.lo, style: { width: "92px" }, onchange: e => (o.lo = e.target.value.trim()) }), "—",
        el("input", { class: "mono", placeholder: "до", value: o.hi, style: { width: "92px" }, onchange: e => (o.hi = e.target.value.trim()) })),
      el("div", { class: "row" },
        el("button", { title: "Только та область, где вы размечали", onclick: () => {
          const uo = MK.cpuObjects(S.pack, S.base);
          if (!uo.length) { toast("Маппак пуст"); return; }
          o.lo = hexl(Math.min(...uo.map(x => x.addr))); o.hi = hexl(Math.max(...uo.map(x => M.geometry(x).end)));
          renderSide();
        } }, "по моей разметке"),
        el("button", { onclick: () => { o.lo = ""; o.hi = ""; renderSide(); } }, "вся прошивка"),
        el("button", { class: "primary", onclick: () => { runCheck(); renderSide(); } }, "Сверить")));
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
        el("div", { class: "row" }, el("button", { onclick: () => { o.reveal = true; renderSide(); } }, "Показать пропущенные (это подсказка!)")));
    } else {
      sect("Пропущено", "", res.missing, r => el("div", { class: "item", title: r.desc || "", onclick: () => { goTo(r.addr - S.base); refDialog(r); } },
        el("span", { class: "addr" }, hexl(r.addr, addrW())), el("span", { class: "nm" }, r.name), el("span", { class: "kd" }, kindText(r))));
      b.append(el("div", { class: "row" }, el("button", { onclick: () => { o.reveal = false; renderSide(); } }, "Скрыть пропущенные")));
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
    // нижнюю панель перерисовываем, только когда сменился объект под курсором
    const m = mineAt(off), r = refAt(off);
    const same = (a, b) => (a ? a.item : null) === (b ? b.item : null);
    if (!(m || r) || !same(m, pm) || !same(r, pr)) renderBottom();
  }
  function goTo(off, noHist) {
    if (!S.fw || !inImg(off)) { toast("Адрес вне образа — проверьте базу"); return; }
    if (!noHist) { S.hist.push(S.cur); if (S.hist.length > 200) S.hist.shift(); S.fwd = []; }
    S.cur = off; S.sel = null; S.anchor = off;
    S.top = Math.max(0, rowOf(off) - 3);
    renderAll();
    $("#view").focus();
  }
  function back() { if (S.hist.length) { S.fwd.push(S.cur); goTo(S.hist.pop(), true); } }
  function forward() { if (S.fwd.length) { S.hist.push(S.cur); goTo(S.fwd.pop(), true); } }

  function selRange() {
    if (S.sel) return [Math.min(S.sel.a, S.sel.b), Math.min(size(), Math.max(S.sel.a, S.sel.b) + cs())];
    return [S.cur, S.cur + 1];
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

  // ---------------------------------------------------- карта / кривая / ось
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
    const axC = axisUi("axisC", "Ось столбцов — быстрый индекс: соседние ячейки в памяти");
    const axR = axisUi("axisR", "Ось строк — медленный индекс");
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
        el("label", {}, "Ячейка"), el("div", { class: "row" }, f.cell, el("label", {}, f.be, " big-endian")),
        el("label", {}, "Пересчёт"), el("div", { class: "row" }, "физ = сырое ×", f.factor, "+", f.offset, "единица", f.unit)),
      axC.box, axR.box, info, prev);
    body.addEventListener("input", refresh);
    body.addEventListener("change", refresh);
    const btns = [];
    if (existing) btns.push({ text: "Удалить", run: () => change(() => S.pack.remove(existing)) });
    btns.push({ text: "Сохранить", primary: true, run: () => {
      const n = collect();
      if (!inImg(n.addr) || M.geometry(n).end > size()) { toast("Объект вне образа"); return false; }
      if (nameTaken(n.name, existing)) { toast("Имя «" + n.name + "» уже есть в маппаке"); return false; }
      if (!n.name) n.name = (n.kind === "axis" ? "AX_" : n.kind === "map" ? "KF_" : n.kind === "curve" ? "KL_" : "W_") + hexl(S.base + n.addr);
      S.cur = n.addr; S.sel = null; S.anchor = n.addr;
      change(() => { if (existing) S.pack.remove(existing); S.pack.add(n); });
    } });
    dialog((existing ? "Изменить: " : "Новый объект: ") + "карта / кривая / ось — K", body, btns);
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
    const veil = $("#veil");
    veil.innerHTML = "";
    const btns = el("div", { class: "btns" });
    const box = el("div", { class: "dlg", role: "dialog" }, el("h3", {}, title), el("div", { class: "body" }, body), btns);
    const close = () => { veil.classList.remove("on"); veil.innerHTML = ""; dlgClose = null; $("#view").focus(); };
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
    const dl = el("datalist", { id: "gotoList" });
    const names = S.pack.objects.map(o => o.name).concat(refVisible() ? S.ref.objects.map(o => o.name) : []);
    for (const n of names.slice(0, 5000)) dl.append(el("option", { value: n }));
    const inp = el("input", { style: { width: "100%" }, class: "mono", list: "gotoList", placeholder: "адрес (C84B78, 0x…), +смещение в файле или имя объекта" });
    dialog("Перейти — G", el("div", {}, inp, dl), [
      { text: "Перейти", primary: true, run: () => {
        const off = parseAddr(inp.value);
        if (off === null || !inImg(off)) { toast("Не понял адрес или он вне образа"); return false; }
        goTo(off);
      } }]);
    inp.focus();
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
    dialog("Поиск — Ctrl+F", el("div", {}, el("div", { class: "row" }, mode), inp, list), [
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

  function helpDialog() {
    const keys = [
      ["стрелки, PgUp/PgDn", "курсор; с Shift — выделение (или тяните мышью)"],
      ["Home / End", "начало / конец строки; с Ctrl — начало / конец файла"],
      ["G, Ctrl+G", "перейти к адресу, +смещению или имени"],
      ["] / [", "следующий / предыдущий объект (ваш или эталона)"],
      ["Alt+← / Alt+→", "назад / вперёд по переходам"],
      ["M / W", "больше / меньше столбцов (как в WinOLS)"],
      ["A", "начинать строки с курсора — карта встанет таблицей с первого столбца"],
      ["Tab", "переключить вид: текст ↔ 2D"],
      ["K", "новый объект у курсора или по выделению; на своём объекте — изменить"],
      ["Enter, двойной щелчок", "открыть объект под курсором"],
      ["Del", "удалить свой объект под курсором"],
      ["Ctrl+F, F3", "поиск байтов или текста; следующее"],
      ["Ctrl+Z / Ctrl+Y", "отменить / вернуть"],
      ["Ctrl+S / Ctrl+Shift+S", "сохранить маппак как A2L / DAMOS"],
      ["Ctrl+O", "открыть прошивку"],
    ];
    const t = el("table", { class: "keys" }, ...keys.map(([k, d]) => el("tr", {}, el("td", {}, el("kbd", {}, k)), el("td", {}, d))));
    dialog("Горячие клавиши", el("div", {}, t,
      el("p", { class: "hint" }, "Цвета: заливка — ваш маппак (данные, оси, счётчики), подчёркивание — эталон. Адрес — база + смещение; щелчок по заголовку столбца адресов переключает на смещение в файле. В 3D-виде карту вращают мышью.")), []);
  }

  // ------------------------------------------------------------ файлы
  async function openFirmware(file) {
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    if (!buf.length) { toast("Пустой файл"); return; }
    S.fw = { name: file.name, size: buf.length, data: buf, crc: crc32(buf) };
    S.pack = new MK.Pack(buf.length);
    S.cur = 0; S.sel = null; S.anchor = 0; S.top = 0; S.hist = []; S.fwd = []; S.undo = []; S.redo = []; S.lastCheck = null;
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
      el("p", { class: "hint" }, "База — адрес первого байта файла (Base Address в Ghidra). Если в Ghidra у вас другая база, оставьте её: адреса " + what + " будут сдвинуты."));
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
    if (!S.hideRef) S.side = "ref";
    syncTabs();
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
      S.side = "pack"; syncTabs(); renderSide();
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

  const ACTIONS = {
    newObject: () => (S.fw ? mapDialog(null) : toast("Сначала откройте прошивку")),
    saveA2l: () => savePack("a2l"),
    saveDamos: () => savePack("dam"),
    openPack: async () => { if (!S.fw) return toast("Сначала откройте прошивку"); openPack(await pickFile(".a2l,.A2L,.dam,.DAM")); },
    clearPack: () => {
      if (!S.fw || !S.pack.objects.length) return;
      dialog("Очистить маппак", el("p", {}, "Удалить все " + S.pack.objects.length + " объектов маппака? Отменить можно клавишами Ctrl+Z."), [
        { text: "Удалить всё", primary: true, run: () => change(() => { S.pack.objects = []; }) }]);
    },
  };

  // ------------------------------------------------------------ статус
  function renderStatus() {
    const st = $("#status");
    if (!S.fw) { st.innerHTML = "<span>Прошивка не открыта</span>"; return; }
    let sel = "";
    if (S.sel) { const [a, b] = selRange(); sel = " · выделено " + (b - a) + " байт"; }
    st.innerHTML =
      "<span><b>" + esc(S.fw.name) + "</b> " + S.fw.size.toLocaleString("ru") + " байт, CRC32 " + S.fw.crc + "</span>" +
      "<span>курсор <b>" + fa(S.cur) + "</b> (+" + hexl(S.cur) + ")" + sel + "</span>" +
      "<span>маппак: " + S.pack.objects.length + "</span>" +
      "<span>" + (S.ref ? "эталон: " + esc(S.ref.name) + (S.hideRef ? " (скрыт)" : "") : "эталон не загружен") + "</span>";
  }

  function renderAll() {
    $("#baseIn").value = "0x" + hexl(S.base);
    renderBar(); renderHex(); renderInsp(); renderStatus(); renderBottom(); renderSide();
  }
  function syncTabs() { for (const x of $("#sidetabs").children) x.classList.toggle("on", x.dataset.tab === S.side); }

  // ------------------------------------------------------------ клавиатура
  document.addEventListener("keydown", e => {
    if ($("#veil").classList.contains("on")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const k = e.key, kl = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === "F1") { e.preventDefault(); helpDialog(); return; }
    if (ctrl && kl === "o") { e.preventDefault(); pickFile().then(openFirmware); return; }
    if (!S.fw) return;
    const n = visibleRows();
    let handled = true;
    if (e.altKey && k === "ArrowLeft") back();
    else if (e.altKey && k === "ArrowRight") forward();
    else if (ctrl && kl === "s") savePack(e.shiftKey ? "dam" : "a2l");
    else if (ctrl && kl === "z" && !e.shiftKey) undo();
    else if (ctrl && (kl === "y" || (kl === "z" && e.shiftKey))) redo();
    else if (ctrl && kl === "f") searchDialog();
    else if (ctrl && kl === "g") gotoDialog();
    else if (ctrl && k === "Home") setCur(0, e.shiftKey);
    else if (ctrl && k === "End") setCur(size() - 1, e.shiftKey);
    else if (ctrl || e.altKey) handled = false;
    else if (k === "ArrowRight") setCur(cellStart(S.cur) + cs(), e.shiftKey);
    else if (k === "ArrowLeft") setCur(cellStart(S.cur) - cs(), e.shiftKey);
    else if (k === "ArrowDown") setCur(S.cur + rowBytes(), e.shiftKey);
    else if (k === "ArrowUp") setCur(S.cur - rowBytes(), e.shiftKey);
    else if (k === "PageDown") { S.top += n - 1; setCur(S.cur + rowBytes() * (n - 1), e.shiftKey); }
    else if (k === "PageUp") { S.top = Math.max(0, S.top - n + 1); setCur(S.cur - rowBytes() * (n - 1), e.shiftKey); }
    else if (k === "Home") setCur(Math.max(0, rowBase(rowOf(S.cur))), e.shiftKey);
    else if (k === "End") setCur(rowBase(rowOf(S.cur)) + rowBytes() - cs(), e.shiftKey);
    else if (kl === "a") alignRows();
    else if (k === "Tab") setVw({ mode: S.vw.mode === "2d" ? "text" : "2d" });
    else if (k === "Escape") { S.sel = null; renderHex(); renderInsp(); renderStatus(); }
    else if (k === "F3") searchNext();
    else if (k === "Enter") openUnderCursor();
    else if (k === "Delete") { const u = mineAt(S.cur); if (u) change(() => S.pack.remove(u.item)); }
    else if (kl === "g") gotoDialog();
    else if (kl === "k") { const u = mineAt(S.cur); mapDialog(u && !S.sel ? u.item : null); }
    else if (kl === "m" || k === "+" || k === "=") setVw({ cols: S.vw.cols + 1 });
    else if (kl === "w" || k === "-") setVw({ cols: S.vw.cols - 1 });
    else if (k === "]") jumpObject(1);
    else if (k === "[") jumpObject(-1);
    else if (k === "?") helpDialog();
    else handled = false;
    if (handled) e.preventDefault();
  });

  function openUnderCursor() {
    const mu = mineAt(S.cur);
    if (mu) return mapDialog(mu.item);
    const ru = refAt(S.cur);
    if (ru) return refDialog(refOrig(ru.item));
    mapDialog(null);
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
      const rowsStep = S.vw.mode === "2d" ? Math.max(1, Math.round(visibleRows() / 8)) : 3;
      S.top = Math.max(0, Math.min(totalRows() - 1, S.top + Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40)) * rowsStep));
      renderHex();
    }, { passive: false });
    $("#hexhead").addEventListener("click", e => { if (e.target.closest(".a")) { S.showOff = !S.showOff; renderHex(); } });
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
    window.addEventListener("resize", () => renderHex());
    // высота нижней панели
    let sdrag = false;
    $("#split").addEventListener("mousedown", e => { sdrag = true; e.preventDefault(); });
    window.addEventListener("mousemove", e => {
      if (!sdrag) return;
      const c = $("#center").getBoundingClientRect();
      $("#bottom").style.height = Math.max(60, Math.min(c.height - 120, c.bottom - e.clientY)) + "px";
      renderHex();
    });
    window.addEventListener("mouseup", () => (sdrag = false));
  }

  function wireChrome() {
    $("#bOpenFw").onclick = async () => openFirmware(await pickFile());
    $("#bOpenRef").onclick = async () => openReference(await pickFile(".dam,.DAM,.a2l,.A2L"));
    $("#bHelp").onclick = helpDialog;
    $("#baseIn").addEventListener("change", e => {
      const v = parseInt(e.target.value.trim().replace(/^0x/i, ""), 16);
      if (isNaN(v) || v < 0) { toast("База — шестнадцатеричное число"); e.target.value = "0x" + hexl(S.base); return; }
      if (S.fw) setBase(v); else S.base = v;
    });
    $("#baseIn").addEventListener("keydown", e => { if (e.key === "Enter") { e.target.blur(); $("#view").focus(); } });
    $("#bTheme").onclick = () => {
      const r = document.documentElement;
      const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      r.dataset.theme = dark ? "light" : "dark";
      lsSet("ecu-hex:theme", r.dataset.theme);
      renderAll();
    };
    const th = lsGet("ecu-hex:theme");
    if (th) document.documentElement.dataset.theme = th;
    const menu = $("#mPack");
    menu.firstElementChild.onclick = e => { e.stopPropagation(); menu.classList.toggle("open"); };
    document.addEventListener("click", () => menu.classList.remove("open"));
    menu.querySelectorAll("[data-act]").forEach(b => (b.onclick = () => { menu.classList.remove("open"); ACTIONS[b.dataset.act](); }));
    $("#sidetabs").addEventListener("click", e => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      S.side = b.dataset.tab; syncTabs(); renderSide();
    });
    // перетаскивание: .dam/.a2l -- эталон (с Shift -- в свой маппак), остальное -- прошивка
    const drop = $("#drop");
    window.addEventListener("dragover", e => { e.preventDefault(); drop.style.display = "block"; });
    window.addEventListener("dragleave", e => { if (!e.relatedTarget) drop.style.display = "none"; });
    window.addEventListener("drop", async e => {
      e.preventDefault(); drop.style.display = "none";
      const files = Array.from(e.dataTransfer.files);
      // прошивку -- первой, чтобы эталону было к чему привязаться
      files.sort((a, b) => /\.(dam|a2l)$/i.test(a.name) - /\.(dam|a2l)$/i.test(b.name));
      for (const f of files) {
        if (/\.(dam|a2l)$/i.test(f.name)) { if (e.shiftKey && S.fw) await openPack(f); else await openReference(f); }
        else await openFirmware(f);
      }
    });
  }

  wireChrome();
  wireView();
  renderAll();

  // для отладки и тестов в браузере
  window.ETApp = { S, makeZip, openFirmware, openReference, openPack, savePack, goTo, setBase, runCheck, change, ACTIONS, renderAll };
})();
