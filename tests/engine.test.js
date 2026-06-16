/* Node test harness for SlideSearchEngine.
 * Run:  node tests/engine.test.js
 * Loads the real slides.json, builds the engine, checks ranking quality
 * against ground-truth page ranges, and benchmarks query latency.
 */
const fs = require("fs");
const path = require("path");
const SlideSearchEngine = require("../assets/search-engine.js");

const dataPath = path.join(__dirname, "..", "data", "slides.json");
const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const engine = new SlideSearchEngine(data.slides);

console.log("== build stats ==");
console.log(engine.stats);
console.log("");

// helper: is a page within any of the given [lo,hi] ranges?
const inRanges = (p, ranges) => ranges.some(([lo, hi]) => p >= lo && p <= hi);

// ground-truth expectations (top result should fall in these page ranges)
const CASES = [
  { q: "Was bedeutet ACID?", expect: [[295, 305]] },
  { q: "3. Normalform", expect: [[123, 151]] },
  { q: "Was ist die dritte Normalform", expect: [[123, 151]] },
  { q: "INNER JOIN erklären", expect: [[207, 255]] },
  // PK+FK is covered in VL3 (modeling), VL4 (DDL syntax) and VL7 (integrity)
  { q: "Primärschlüssel und Fremdschlüssel", expect: [[88, 120], [160, 180], [280, 290]] },
  { q: "GROUP BY und HAVING", expect: [[207, 260]] },
  { q: "Transaktionen und Sperren", expect: [[275, 317]] },
  { q: "Entity Relationship Modell", expect: [[39, 83]] },
  // p.96 (cardinality + relationship types) is the correct best hit, in VL3
  { q: "Kardinalität einer Beziehung", expect: [[39, 120]] },
  // as-you-type partials — fair to check the top-3 for one-word fragments
  { q: "norm", expect: [[16, 151]], top: 3 },
  { q: "transak", expect: [[14, 317]] },
  { q: "primärschlü", expect: [[88, 151]] }, // Primärschlüssel spans into the NF slides
  // typo tolerance (note the missing letters)
  { q: "primärschlüsel", expect: [[88, 151]] },
  { q: "normalisierung", expect: [[16, 151]] },
  // concept-bridge paraphrases (slide shares NO words with the question)
  { q: "Wie verhindere ich doppelte Werte in einer Spalte?", expect: [[103, 118], [181, 181], [279, 290]], top: 3 },
  { q: "Spalte darf nicht leer sein", expect: [[111, 119], [169, 195], [279, 290]], top: 3 },
  { q: "Durchschnitt pro Produktkategorie berechnen", expect: [[228, 271]], top: 3 },
];

let pass = 0;
console.log("== ranking quality ==");
for (const c of CASES) {
  const r = engine.search(c.q, { limit: 5 });
  const top = r.results[0];
  const within = c.top ? r.results.slice(0, c.top) : [r.results[0]];
  const ok = within.some((x) => x && inRanges(x.page, c.expect));
  if (ok) pass++;
  const pages = r.results.map((x) => x.page).join(", ");
  console.log(
    `${ok ? "PASS" : "FAIL"}  "${c.q}"`.padEnd(46) +
      `top=p.${top ? top.page : "-"}  [${top ? top.lecture.split(" · ")[0] : ""}]  ` +
      `(${r.total} hits, ${r.ms.toFixed(2)}ms)  pages: ${pages}`
  );
}
console.log(`\n${pass}/${CASES.length} ranking checks passed\n`);

// detailed look at three representative queries
console.log("== detailed top-5 ==");
for (const q of ["Was bedeutet ACID?", "Unterschied Primärschlüssel Fremdschlüssel", "GROUP BY und HAVING"]) {
  console.log(`\nQ: ${q}`);
  const r = engine.search(q, { limit: 5 });
  for (const x of r.results) {
    console.log(
      `  p.${String(x.page).padStart(3)}  ${(x.norm * 100).toFixed(0).padStart(3)}%  ` +
        `${x.lecture.split(" · ")[0].padEnd(4)}  ${x.title.slice(0, 48)}`
    );
    console.log(`         …${x.snippet.replace(/\s+/g, " ").slice(0, 110)}…`);
  }
}

// benchmark
console.log("\n== latency benchmark ==");
const bq = ["Was bedeutet ACID?", "Primärschlüssel Fremdschlüssel Beziehung", "group by having aggregat", "norm"];
const ITER = 4000;
let t0 = performance.now();
let sink = 0;
for (let i = 0; i < ITER; i++) sink += engine.search(bq[i % bq.length], { limit: 40 }).results.length;
let dt = performance.now() - t0;
console.log(`${ITER} queries in ${dt.toFixed(1)}ms  ->  ${((dt / ITER) * 1000).toFixed(1)} µs/query  (sink=${sink})`);

process.exit(pass === CASES.length ? 0 : 1);
