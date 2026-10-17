// 驗證：用期交所 TMF 逐筆組 5 分K（＋Yahoo 補最新夜盤），跑兩支指標，跟 TradingView 截圖數字比對。
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fetchBuffer, taifexDailyZipUrl, decodeBig5, fetchYahooChart } from "./lib/sources.mjs";
import { ticksToSessions, buildBars15 } from "../engine/bars.js";
import { classifyTick, sessionKey, slotsOf } from "../engine/sessions.js";
import { tpeParts } from "../engine/time.js";
import { proSniper, washout, tradeSummary } from "../engine/myind.js";

const out = { at: new Date().toISOString() };
const dates = ["20261005", "20261006", "20261007", "20261008", "20261012", "20261013", "20261014", "20261015", "20261016"];
const recs = [];
for (const d of dates) {
  const buf = await fetchBuffer(taifexDailyZipUrl(d));
  writeFileSync(`/tmp/${d}.zip`, buf);
  const text = decodeBig5(execFileSync("unzip", ["-p", `/tmp/${d}.zip`], { maxBuffer: 1 << 30 }));
  const m = ticksToSessions(text, { product: "TMF", res: 5 });
  const vol = c => [...m.get(c).values()].reduce((s, r) => s + r.bars.reduce((a, b) => a + (b ? b[4] : 0), 0), 0);
  const front = [...m.keys()].sort((a, b) => vol(b) - vol(a))[0];
  for (const r of m.get(front).values()) recs.push({ ...r, complete: true });
  out[`contracts_${d}`] = Object.fromEntries([...m.keys()].map(c => [c, vol(c)]));
}
// Yahoo 補週五夜盤（先試微台，再退回台指期近一）
for (const sym of ["WTM&", "WTMF&", "TMF&", "WMT&", "WTX&"]) {
  try {
    const j = await fetchYahooChart(sym);
    const ts = j.timestamp ?? [];
    out[`yahoo_${sym}`] = { name: j.meta?.name, points: ts.length, price: j.meta?.regularMarketPrice };
    if (!ts.length || out.yahooUsed) continue;
    if (!/微|WTX/.test(`${j.meta?.name}${sym}`)) continue;
    const q = j.indicators.quote[0];
    const rec = { start: "20261016", type: "N", contract: "202610", source: `yahoo ${sym}`, res: 5, complete: true, bars: new Array(slotsOf("N", 5)).fill(null) };
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i] * 1000 - 60_000 - 2 * 86400_000; // Yahoo 週五夜盤被標成週日，往回搬兩天
      const p = tpeParts(t);
      const s = classifyTick(p.ymd, `${String(Math.floor(p.minute / 60)).padStart(2, "0")}${String(p.minute % 60).padStart(2, "0")}00`, 5);
      if (!s || s.start !== "20261016" || s.type !== "N") continue;
      const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
      if (![o, h, l, c].every(Number.isFinite)) continue;
      const b = rec.bars[s.slot];
      if (!b) rec.bars[s.slot] = [o, h, l, c, 0]; else { b[1] = Math.max(b[1], h); b[2] = Math.min(b[2], l); b[3] = c; }
    }
    if (rec.bars.filter(Boolean).length > 100) { recs.push(rec); out.yahooUsed = sym; }
  } catch (e) { out[`yahoo_${sym}`] = { error: String(e).slice(0, 120) }; }
}
const bars = buildBars15(recs);
out.bars = bars.length;
out.lastBar = bars.at(-1);
const w = washout(bars);
out.washout = { ...w, marks: w.marks };
out.expected = { res1: 46981, res2: 47329, sup1: 46164, sup2: 46304, state: "趨勢中" };
const sn = proSniper(bars);
out.sniperDash = sn.dash;
out.sniperSignals = sn.signals.slice(-15);
out.sniperSummary = tradeSummary(sn.trades);
mkdirSync("probe", { recursive: true });
writeFileSync("probe/check.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ washout: { res1: w.res1, res2: w.res2, sup1: w.sup1, sup2: w.sup2, state: w.state }, dash: sn.dash }, null, 1));
