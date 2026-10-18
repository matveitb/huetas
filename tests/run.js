// Тесты без браузера и без зависимостей:  node tests/run.js
//
// 1. Синтетическая прошивка с заранее известными картами: запись маппака в
//    A2L и DAMOS и чтение обратно должны дать те же объекты.
// 2. Сверка: верная карта, транспонированная, размеченная без заголовка.
// 3. Если рядом лежит настоящая пара DAMOS + образ (переменные DAMOS и BIN
//    или репозиторий Ivanbl4 по соседству), -- круг по всем её объектам.
const fs = require("fs");
const path = require("path");
const ET = require("./load.js");
const M = ET.model, F = ET.fmt, CMP = ET.compare, MK = ET.markup;

let failed = 0, passed = 0;
function check(cond, what) {
  if (cond) { passed++; return; }
  failed++;
  console.log("  ✗ " + what);
}

// ------------------------------------------------- синтетическая прошивка
const BASE = 0x800000;
const fw = new Uint8Array(0x1000);
function put(off, bytes) { bytes.forEach((b, i) => (fw[off + i] = b)); }
const le16 = v => [v & 0xFF, (v >> 8) & 0xFF];
// карта Bosch 3 столбца x 4 строки: счётчики, ось строк, ось столбцов, данные
put(0x100, [4, 3, 10, 20, 30, 40, 1, 2, 3, ...Array.from({ length: 12 }, (_, i) => 100 + i)]);
// отдельная ось: счётчик-слово 5 и 5 слов
put(0x200, [...le16(5), ...[500, 1000, 2000, 3000, 4000].flatMap(le16)]);
// карта без заголовка 5 x 2 со ссылкой на ось, s16
put(0x300, Array.from({ length: 10 }, (_, i) => le16((i * 37 - 100) & 0xFFFF)).flat());
// кривая Bosch: счётчик 4, ось u8, данные u8
put(0x400, [4, 0, 50, 100, 200, 9, 8, 7, 6]);

const mine = [
  { name: "KF_BOSCH", desc: "карта с заголовком", kind: "map", addr: BASE + 0x100, layout: "bosch", cols: 3, rows: 4, cell: "u8",
    factor: 0.75, offset: -48, unit: "°C", axisR: { mode: "inline", cell: "u8", factor: 40, unit: "1/min" }, axisC: { mode: "inline", cell: "u8" } },
  { name: "AX_RPM", kind: "axis", addr: BASE + 0x200, layout: "bosch", countSize: 2, cols: 5, cell: "u16", unit: "1/min" },
  { name: "KF_PLAIN", kind: "map", addr: BASE + 0x300, cols: 5, rows: 2, cell: "s16", factor: 0.1,
    axisC: { mode: "ref", ref: BASE + 0x200, cell: "u16" } },
  { name: "KL_CURVE", kind: "curve", addr: BASE + 0x400, layout: "bosch", cols: 4, cell: "u8", axisC: { mode: "inline", cell: "u8" } },
  { name: "W_VALUE", kind: "value", addr: BASE + 0x500, cell: "s16", factor: 0.01 },
  { name: "BLK", kind: "block", addr: BASE + 0x600, cols: 8, cell: "u8" },
].map(o => M.normalize(o));

console.log("геометрия и чтение");
{
  const r = M.readObject(mine[0], fw, a => a - BASE);
  check(r.counts.nR === 4 && r.counts.nC === 3, "счётчики заголовка 4 и 3");
  check(JSON.stringify(r.axisR) === JSON.stringify([400, 800, 1200, 1600]), "ось строк x40");
  check(r.values[0] === 100 * 0.75 - 48, "первая ячейка с пересчётом");
  check(M.geometry(mine[0]).dataAddr === BASE + 0x109, "данные после 2 счётчиков и 7 точек осей");
  const r2 = M.readObject(mine[2], fw, a => a - BASE, a => mine.find(o => o.addr === a && o.kind === "axis"));
  check(JSON.stringify(r2.axisC) === JSON.stringify([500, 1000, 2000, 3000, 4000]), "ось по ссылке");
  check(r2.raw[0] === -100, "знаковое слово");
}

console.log("запись и чтение A2L / DAMOS");
for (const [fmt, write, ext] of [["A2L", F.writeA2l, "x.a2l"], ["DAMOS", F.writeDamos, "x.dam"]]) {
  const out = write(mine, { project: "test", base: BASE, size: fw.length });
  // DAMOS пишется в cp1251 -- проверим и кодировку
  const text = fmt === "DAMOS" ? new TextDecoder("windows-1251").decode(F.encodeCp1251(out.text)) : out.text;
  const back = F.loadReference(text, ext).objects;
  F.refineWithImage(back, fw, a => a - BASE);
  check(out.warnings.length === 0, fmt + ": без замечаний (" + out.warnings.join("; ") + ")");
  check(back.length === mine.length, fmt + ": объектов " + back.length);
  const res = CMP.compare(back, mine, {});
  const bad = res.pairs.filter(p => p.status !== "ok");
  check(res.pairs.length === mine.length && !bad.length, fmt + ": круг без расхождений, ошибок " +
    bad.map(p => p.r.name + ": " + p.checks.filter(c => !c.ok).map(c => c.what + " " + c.user + "≠" + c.ref).join(", ")).join("; "));
  check(back.every(o => mine.some(m => m.name === o.name)), fmt + ": имена сохранены");
  check(back.find(o => o.name === "KF_BOSCH").desc === "карта с заголовком", fmt + ": русское описание");
}

console.log("сверка");
{
  const ref = mine;
  const user = [
    M.normalize(Object.assign({}, mine[0])),                                                   // верно
    M.normalize({ kind: "map", addr: BASE + 0x300, cols: 2, rows: 5, cell: "s16", factor: 0.1 }), // транспонирована, без оси
    M.normalize({ kind: "curve", addr: BASE + 0x405, cols: 4, cell: "u8" }),                     // тело без заголовка
    M.normalize({ kind: "value", addr: BASE + 0x800, cell: "u8" }),                              // лишнее
  ];
  const res = CMP.compare(user, ref, {});
  const by = n => res.pairs.find(p => p.r.name === n);
  check(by("KF_BOSCH") && by("KF_BOSCH").status === "ok", "верная карта совпала");
  const tr = by("KF_PLAIN");
  check(tr && tr.checks.some(c => c.what === "Размер" && !c.ok && /транспонировано/.test(c.note)), "транспонирование распознано");
  check(tr && tr.checks.some(c => c.what === "Ось столбцов" && !c.ok), "пропущенная ось отмечена");
  const cu = by("KL_CURVE");
  check(cu && cu.how === "data" && /заголовка/.test(cu.checks[0].note), "тело без заголовка найдено по началу данных");
  check(res.extra.length === 1, "лишний объект один");
  check(res.missing.map(r => r.name).sort().join() === "AX_RPM,BLK,W_VALUE", "пропущены ось, блок и значение");
}

console.log("подбор базы");
{
  const sug = F.suggestBases(mine, fw);
  check(sug[0].base === BASE, "база 0x800000 по заголовкам, получено 0x" + sug[0].base.toString(16));
}

// ------------------------------------------------- настоящий DAMOS
const damPath = process.env.DAMOS || path.join(__dirname, "..", "..", "Ivanbl4", "firmware", "px5ns03d.dam");
const binPath = process.env.BIN || path.join(__dirname, "..", "..", "Ivanbl4", "firmware", "px5ns03d.BIN");
if (fs.existsSync(damPath) && fs.existsSync(binPath)) {
  console.log("настоящий DAMOS: " + path.basename(damPath));
  const text = new TextDecoder("windows-1251").decode(fs.readFileSync(damPath));
  const ref = F.loadReference(text, damPath).objects;
  const data = new Uint8Array(fs.readFileSync(binPath));
  const base = F.suggestBases(ref, data)[0];
  check(base.hdrOk / base.hdr > 0.9, "заголовки карт сходятся с образом: " + base.hdrOk + " из " + base.hdr);
  F.refineWithImage(ref, data, a => a - base.base);
  for (const [fmt, write, ext] of [["A2L", F.writeA2l, "x.a2l"], ["DAMOS", F.writeDamos, "x.dam"]]) {
    const back = F.loadReference(write(ref, {}).text, ext).objects;
    F.refineWithImage(back, data, a => a - base.base);
    const res = CMP.compare(back, ref, {});
    check(res.pairs.length === ref.length && res.pairs.every(p => p.status === "ok"),
      fmt + ": все " + ref.length + " объектов прошли круг, совпало " + res.pairs.filter(p => p.status === "ok").length);
  }
} else {
  console.log("настоящий DAMOS не найден — пропуск (задайте DAMOS=… BIN=…)");
}

console.log((failed ? "ПРОВАЛ" : "OK") + ": прошло " + passed + ", не прошло " + failed);
process.exit(failed ? 1 : 0);
