import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLive } from "../live.js";
import { yahooToRecords } from "../engine/yahoo.js";

// 假的 Yahoo 回應：10/19 日盤 08:46～09:30 每分鐘一根（時間是分鐘結束）
function fakeYahoo(startUtcMs, n, base) {
  const ts = [], o = [], h = [], l = [], c = [], v = [];
  for (let i = 0; i < n; i += 1) { ts.push((startUtcMs + (i + 1) * 60000) / 1000); const p = base + i; o.push(p); h.push(p + 2); l.push(p - 2); c.push(p + 1); v.push(1); }
  return { timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] }, quote: { price: String(base + n), refreshedTs: new Date(startUtcMs + n * 60000).toISOString() } };
}

test("Yahoo 分K：時間是分鐘結束，08:46 那筆屬於 08:45 那根", () => {
  const start = Date.UTC(2026, 9, 19, 0, 45);
  const r = yahooToRecords(fakeYahoo(start, 45, 46500), 15, ["20261016"], "yahoo", start + 46 * 60000);
  assert.equal(r.recs.length, 1);
  assert.equal(r.recs[0].start, "20261019");
  assert.equal(r.recs[0].type, "D");
  assert.equal(r.recs[0].bars.filter(Boolean).length, 3);
  assert.equal(r.recs[0].bars[0][0], 46500);
});

test("即時資料取代暫存盤，但不動官方資料，摘要也跟著更新", () => {
  const start = Date.UTC(2026, 9, 19, 0, 45);
  const B = {
    contract: "202610", calendarTail: ["20261015", "20261016"],
    sessions15: [{ start: "20261016", type: "D", source: "official", complete: true, bars: [[1, 2, 0, 1, 1]] }, { start: "20261019", type: "D", source: "yahoo", complete: false, bars: [[9, 9, 9, 9, 1]] }],
    summaries: [{ td: "20261019", type: "D", start: "20261019", o: 9, h: 9, l: 9, c: 9, complete: false, source: "yahoo" }],
    tmf5: [],
  };
  const now = start + 46 * 60000;
  applyLive(B, { kind: "bars", WTX: fakeYahoo(start, 45, 46500), WTM: fakeYahoo(start, 45, 46500) }, now);
  const live = B.sessions15.find(s => s.start === "20261019");
  assert.equal(live.source, "yahoo-live");
  assert.equal(live.bars[0][0], 46500);
  assert.equal(B.sessions15[0].source, "official");
  assert.equal(B.summaries[0].h, 46546);
  assert.equal(B.live.lastPrice, 46545);
  assert.equal(B.tmf5.length, 1);
});

test("換月：結算日夜盤進來時切到次月合約，微台歷史平移價差，舊合約那盤也平移", () => {
  // 10/21（週三結算）15:00 夜盤 → 交易日 10/22，屬 202611
  const night = Date.UTC(2026, 9, 21, 7, 0);
  const B = {
    contract: "202610", expiry: "20261021", calendarTail: ["20261020", "20261021"],
    next: { contract: "202611", spread: -30, spreadTd: "20261021", sessions15: [{ start: "20261021", type: "D", td: "20261021", source: "official", complete: true, bars: [[100, 100, 100, 100, 1]] }], summaries: [{ td: "20261021", type: "D", start: "20261021", o: 1, h: 2, l: 0, c: 1, complete: true }] },
    sessions15: [{ start: "20261021", type: "D", td: "20261021", source: "yahoo", complete: true, bars: [[130, 130, 130, 130, 1]] }],
    summaries: [],
    tmf5: [{ start: "20261021", type: "D", td: "20261021", source: "yahoo-tmf", contract: "202610", adjusted: 0, complete: true, bars: [[1000, 1001, 999, 1000, 1]] }],
  };
  applyLive(B, { kind: "bars", WTX: fakeYahoo(night, 20, 970), WTM: fakeYahoo(night, 20, 970) }, night + 21 * 60000);
  assert.equal(B.contract, "202611");
  assert.equal(B.sessions15[0].bars[0][0], 100);           // 換成次月的 15 分K
  assert.equal(B.tmf5[0].bars[0][0], 970);                 // 舊合約 1000 − 30
  assert.equal(B.tmf5.at(-1).bars[0][0], 970);             // 新合約夜盤原價
  assert.equal(B.roll.spread, -30);
});
