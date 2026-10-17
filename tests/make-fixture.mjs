// 產生離線測試用的假資料（只給本機畫面測試，不會上線）。用法：DATA_DIR=/tmp/fx node tests/make-fixture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION, frontContract, secondContract } from "../engine/sessions.js";
import { addDays, weekdayOf } from "../engine/time.js";

const DIR = process.env.DATA_DIR ?? "/tmp/fx";
const END = process.env.END ?? "20261016";
let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

const days = [];
for (let d = END; days.length < 260; d = addDays(d, -1)) if (weekdayOf(d) % 6 !== 0) days.unshift(d);
let px = 22000;
const dailyRows = [];
const tickFiles = new Map();
for (let i = 0; i < days.length; i += 1) {
  const td = days[i];
  for (const type of ["N", "D"]) {
    if (type === "N" && i === 0) continue;
    const start = type === "D" ? td : days[i - 1];
    const n = SESSION[type].slots15;
    const bars = [];
    for (let k = 0; k < n; k += 1) {
      const o = px;
      const drift = Math.sin(i / 18) * 2.5;
      const c = Math.round(o + drift + gauss() * (type === "D" ? 22 : 12));
      const h = Math.max(o, c) + Math.round(rnd() * 15), l = Math.min(o, c) - Math.round(rnd() * 15);
      bars.push([o, h, l, c, Math.round(200 + rnd() * 800)]);
      px = c;
    }
    const f = frontContract(td), s = secondContract(td);
    for (const [contract, basis] of [[f, 0], [s, -35]]) {
      const shifted = bars.map(b => [b[0] + basis, b[1] + basis, b[2] + basis, b[3] + basis, contract === f ? b[4] : Math.round(b[4] / 8)]);
      const o = shifted[0][0], h = Math.max(...shifted.map(b => b[1])), l = Math.min(...shifted.map(b => b[2])), c = shifted.at(-1)[3];
      dailyRows.push({ td, contract, type, o, h, l, c, v: 1000 });
      if (i >= days.length - 30) {
        const key = td;
        if (!tickFiles.has(key)) tickFiles.set(key, []);
        tickFiles.get(key).push({ start, type, contract, source: "official", complete: true, bars: shifted });
      }
    }
  }
}
mkdirSync(join(DIR, "daily"), { recursive: true });
mkdirSync(join(DIR, "ticks"), { recursive: true });
const byMonth = new Map();
for (const r of dailyRows) { const m = r.td.slice(0, 6); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(r); }
for (const [m, rows] of byMonth) writeFileSync(join(DIR, "daily", `TX-${m}.json`), JSON.stringify({ month: m, fetchedAt: 0, rows }));
for (const [d, sessions] of tickFiles) writeFileSync(join(DIR, "ticks", `${d}.json`), JSON.stringify({ file: d, fetchedAt: 0, complete: true, sessions }));
console.log(`fixture: ${days[0]}..${days.at(-1)} daily=${dailyRows.length} tickFiles=${tickFiles.size}`);
