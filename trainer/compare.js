// Сверка вашего маппака с эталоном (DAMOS или A2L).
//
// Пара ищется по адресу, а не по имени: имя вы вправе дать своё, а вот
// найти объект -- значит указать, где он лежит. Порядок поиска пары:
//   1. совпало начало записи;
//   2. совпало начало данных (вы разметили тело без заголовка или наоборот);
//   3. области пересекаются -- найдено, но с неверной границей.
// Каждый объект эталона идёт в пару не больше одного раза.
(function (root) {
  "use strict";
  const ET = root.ET = root.ET || {};
  const M = () => ET.model;

  const ONE_D = new Set(["curve", "axis", "block"]);

  function close(a, b) {
    if (a === b) return true;
    const d = Math.abs(a - b), s = Math.max(Math.abs(a), Math.abs(b));
    return d <= 1e-9 || d / s < 2e-4;
  }

  function scaleText(f, o) {
    return "×" + M().fmtNum(f, 6) + (o ? (o > 0 ? " +" : " ") + M().fmtNum(o, 6) : "");
  }

  function checkPair(u, r, how) {
    const checks = [];
    const gr = M().geometry(r);
    // 1. граница
    if (how === "addr") checks.push({ what: "Адрес", ok: true, user: hexs(u.addr), ref: hexs(r.addr) });
    else if (how === "data") {
      checks.push({
        what: "Адрес", ok: false, user: hexs(u.addr), ref: hexs(r.addr),
        note: gr.dataAddr !== r.addr
          ? "данные совпали, но запись начинается раньше — с заголовка (счётчики и оси)"
          : "данные совпали, но у вас перед ними учтён заголовок, которого нет",
      });
    } else {
      checks.push({
        what: "Адрес", ok: false, user: hexs(u.addr), ref: hexs(r.addr),
        note: "области пересекаются, сдвиг " + (u.addr - r.addr > 0 ? "+" : "") + (u.addr - r.addr) + " байт",
      });
    }
    // 2. вид
    const kindOk = u.kind === r.kind || (ONE_D.has(u.kind) && ONE_D.has(r.kind)) ||
      (u.kind === "block" && r.kind === "value" && u.cols === 1);
    checks.push({
      what: "Вид", ok: kindOk, user: M().KINDS[u.kind], ref: M().KINDS[r.kind],
      note: kindOk && u.kind !== r.kind ? "одномерные виды считаются равными" : "",
    });
    // 3. размер
    if (r.kind === "string") {
      if (r.length && u.kind === "string") {
        checks.push({ what: "Длина", ok: u.length >= r.length, user: u.length, ref: r.length });
      }
    } else if (r.kind !== "value") {
      const same = u.cols === r.cols && u.rows === r.rows;
      const tr = !same && u.cols === r.rows && u.rows === r.cols;
      checks.push({
        what: "Размер", ok: same, user: u.cols + "×" + u.rows, ref: r.cols + "×" + r.rows,
        note: tr ? "транспонировано: перепутаны строки и столбцы (быстрый индекс в памяти — столбцы)" : "",
      });
    }
    // 4. ячейка
    if (r.kind !== "string") {
      const cu = M().cellOf(u.cell), cr = M().cellOf(r.cell);
      const ok = u.cell === r.cell && !!u.be === !!r.be;
      let note = "";
      if (!ok && cu.size === cr.size) note = "ширина верна, ошибка в знаке или порядке байт";
      checks.push({ what: "Ячейка", ok, user: u.cell + (u.be ? " BE" : ""), ref: r.cell + (r.be ? " BE" : ""), note });
      // 5. пересчёт
      if (!close(r.factor, 1) || Math.abs(r.offset) > 1e-9 || !close(u.factor, 1) || Math.abs(u.offset) > 1e-9) {
        const ok2 = close(u.factor, r.factor) && (Math.abs(u.offset - r.offset) < 1e-6 * Math.max(1, Math.abs(r.offset)) + 1e-9);
        checks.push({
          what: "Пересчёт", ok: ok2, user: scaleText(u.factor, u.offset) + (u.unit ? " " + u.unit : ""),
          ref: scaleText(r.factor, r.offset) + (r.unit ? " " + r.unit : ""),
        });
      }
    }
    // 6. оси
    if (r.kind === "map" || r.kind === "curve") {
      for (const [k, title] of [["axisC", "Ось столбцов"], ["axisR", "Ось строк"]]) {
        if (k === "axisR" && r.kind !== "map") continue;
        const ra = r[k], ua = u[k];
        if (!ra || ra.mode === "none") continue;
        let ok = ua && ua.mode === ra.mode;
        let note = "";
        if (ok && ra.mode === "ref") {
          ok = ua.ref === ra.ref;
          if (!ok) note = "ссылка указывает не на ту ось";
        } else if (ok && ra.mode === "inline") {
          ok = ua.cell === ra.cell;
          if (!ok) note = "ширина точек оси другая";
        }
        checks.push({
          what: title, ok, user: axisText(ua), ref: axisText(ra) + (ra.refName ? " (" + ra.refName + ")" : ""), note,
        });
      }
    }
    const allOk = checks.every(c => c.ok);
    return { checks, status: allOk ? "ok" : "partial" };
  }

  function axisText(a) {
    if (!a || a.mode === "none") return "нет";
    if (a.mode === "inline") return "в записи, " + a.cell;
    return "по адресу " + hexs(a.ref);
  }

  function hexs(v) { return v === null || v === undefined ? "—" : M().hex(v, 6); }

  // opts: {kinds: Set|null, lo, hi, only: Set(ключей эталона)|null}
  function inScope(r, opts) {
    if (opts.kinds && !opts.kinds.has(r.kind)) return false;
    if (opts.lo !== undefined && opts.lo !== null && r.addr < opts.lo) return false;
    if (opts.hi !== undefined && opts.hi !== null && r.addr > opts.hi) return false;
    if (opts.only && !opts.only.has(refKey(r))) return false;
    return true;
  }

  function refKey(r) { return r.name + "@" + r.addr.toString(16); }

  function compare(userObjs, refObjs, opts) {
    opts = opts || {};
    const used = new Set();
    const pairs = [], extra = [];
    const byAddr = new Map(), byData = new Map();
    const geoms = new Map();
    for (const r of refObjs) {
      const g = M().geometry(r);
      geoms.set(r, g);
      if (!byAddr.has(r.addr)) byAddr.set(r.addr, []);
      byAddr.get(r.addr).push(r);
      if (!byData.has(g.dataAddr)) byData.set(g.dataAddr, []);
      byData.get(g.dataAddr).push(r);
    }
    const sorted = refObjs.slice().sort((a, b) => a.addr - b.addr);
    const pick = (list, u) => {
      if (!list) return null;
      const free = list.filter(r => !used.has(r));
      if (!free.length) return null;
      // предпочесть тот же вид
      return free.find(r => r.kind === u.kind) || free[0];
    };
    const pending = [];
    // проход 1: точное начало
    for (const u of userObjs) {
      const r = pick(byAddr.get(u.addr), u);
      if (r) { used.add(r); pairs.push(Object.assign({ u, r, how: "addr" }, checkPair(u, r, "addr"))); }
      else pending.push(u);
    }
    // проход 2: начало данных
    const pending2 = [];
    for (const u of pending) {
      const gu = M().geometry(u);
      const r = pick(byData.get(gu.dataAddr), u) || pick(byData.get(u.addr), u);
      if (r) { used.add(r); pairs.push(Object.assign({ u, r, how: "data" }, checkPair(u, r, "data"))); }
      else pending2.push(u);
    }
    // проход 3: пересечение областей
    for (const u of pending2) {
      const gu = M().geometry(u);
      let best = null, bestOv = 0;
      // двоичный поиск первого эталона, начинающегося до конца объекта
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].addr < gu.end) lo = mid + 1; else hi = mid; }
      for (let i = lo - 1; i >= 0 && i > lo - 400; i--) {
        const r = sorted[i];
        if (used.has(r)) continue;
        const gr = geoms.get(r);
        const ov = Math.min(gu.end, gr.end) - Math.max(gu.start, gr.start);
        if (ov <= 0) continue;
        const score = ov + (r.kind === u.kind ? 1e6 : 0) + (r.kind !== "value" ? 1e3 : 0);
        if (score > bestOv) { bestOv = score; best = r; }
      }
      if (best) { used.add(best); pairs.push(Object.assign({ u, r: best, how: "overlap" }, checkPair(u, best, "overlap"))); }
      else extra.push(u);
    }
    const scoped = refObjs.filter(r => inScope(r, opts));
    const scopedSet = new Set(scoped);
    const missing = scoped.filter(r => !used.has(r));
    // баллы: найти -- 40 %, остальные проверки делят 60 %
    let got = 0;
    for (const p of pairs) {
      if (!scopedSet.has(p.r)) continue;
      const rest = p.checks.filter(c => c.what !== "Адрес");
      const addrOk = p.how === "addr" ? 1 : 0.5;
      const part = rest.length ? rest.filter(c => c.ok).length / rest.length : 1;
      got += 0.4 * addrOk + 0.6 * part;
    }
    const total = scoped.length;
    return {
      pairs, extra, missing,
      inScopePairs: pairs.filter(p => scopedSet.has(p.r)),
      total, score: total ? got / total : 0,
      ok: pairs.filter(p => p.status === "ok" && scopedSet.has(p.r)).length,
      partial: pairs.filter(p => p.status !== "ok" && scopedSet.has(p.r)).length,
    };
  }

  ET.compare = { compare, checkPair, refKey, axisText };
})(typeof window !== "undefined" ? window : globalThis);
