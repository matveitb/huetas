// Загрузка модулей тренажёра в Node -- для тестов без браузера.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = path.join(__dirname, "..", "trainer");
for (const f of ["model.js", "formats.js", "markup.js", "compare.js"]) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) continue;
  vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p });
}
module.exports = globalThis.ET;
