// Ваш маппак: список калибровочных объектов (model.js).
//
// Внутри адреса хранятся как СМЕЩЕНИЯ В ФАЙЛЕ, а адрес CPU получается как
// база + смещение. Тогда смена базы не сдвигает разметку с байтов, а в
// файл маппака (A2L/DAMOS) пишутся уже адреса CPU.
(function (root) {
  "use strict";
  const ET = root.ET = root.ET || {};
  const M = () => ET.model;

  class Pack {
    constructor(size) {
      this.size = size;
      this.objects = [];
      this.version = 0;
      this._units = null;
    }

    touch() { this.version++; this._units = null; }

    // объекты, отсортированные по началу, с границами в файле
    units() {
      if (this._units) return this._units;
      this._units = this.objects.map(o => {
        const g = M().geometry(o);
        return { off: g.start, end: Math.max(g.end, g.start + 1), item: o, geom: g };
      }).sort((a, b) => a.off - b.off);
      return this._units;
    }

    unitAt(off) {
      const u = this.units();
      let lo = 0, hi = u.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (u[mid].off <= off) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      for (let i = best; i >= 0 && i > best - 16; i--) {
        if (u[i].off <= off && off < u[i].end) return u[i];
      }
      return null;
    }

    overlapping(a, b) { return this.units().filter(u => u.off < b && u.end > a); }

    add(o) { this.objects.push(o); this.touch(); }
    remove(o) { this.objects = this.objects.filter(x => x !== o); this.touch(); }

    toJSON() { return this.objects.map(o => JSON.parse(JSON.stringify(o))); }

    static fromJSON(list, size) {
      const p = new Pack(size);
      p.objects = (list || []).map(o => M().normalize(o));
      p.touch();
      return p;
    }
  }

  // Копия объекта со сдвигом всех адресов (смещение <-> адрес CPU)
  function shift(o, delta) {
    const c = JSON.parse(JSON.stringify(o));
    c.addr += delta;
    for (const k of ["axisC", "axisR"]) if (c[k] && c[k].mode === "ref" && c[k].ref !== null && c[k].ref !== undefined) c[k].ref += delta;
    return M().normalize(c);
  }

  // Маппак в адресах CPU -- для сверки и записи в файл
  function cpuObjects(pack, base) { return pack.objects.map(o => Object.assign(shift(o, base), { _orig: o })); }

  ET.markup = { Pack, shift, cpuObjects };
})(typeof window !== "undefined" ? window : globalThis);
