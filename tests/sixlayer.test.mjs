import test from "node:test";
import assert from "node:assert/strict";
import { periodAnchor, periodRange, sixLevels } from "../engine/sixlayer.js";

test("六層：中軸與倍率", () => {
  const L = sixLevels(48775, 48071);
  assert.equal(Math.round(L.mid), 48423);
  assert.equal(Math.round(L.up[4]), 48871);
  assert.equal(Math.round(L.dn[4]), 47975);
});

test("期間起點：週三結算、第三個週三月結算", () => {
  assert.equal(periodAnchor("W", "20261022"), "20261021"); // 週四 → 前一天週三
  assert.equal(periodAnchor("W", "20261021"), "20261014"); // 週三當天仍屬上一週
  assert.equal(periodAnchor("W", "20261019"), "20261014"); // 週一
  assert.equal(periodAnchor("M", "20261019"), "20260916"); // 10/21 還沒結算 → 從 9/16 結算後起算
  assert.equal(periodAnchor("M", "20261022"), "20261021");
});

test("日：前一個日盤＋夜盤當基準，這一盤破底就納入", () => {
  const S = [
    { td: "20261021", type: "N", h: 999, l: 1, complete: true },         // 再前一盤，不算
    { td: "20261021", type: "D", start: "20261021", h: 47450, l: 46872, complete: true },
    { td: "20261022", type: "N", start: "20261021", h: 47555, l: 46983, complete: true },
    { td: "20261022", type: "D", start: "20261022", h: 47337, l: 46797, complete: false }, // 現在這一盤
  ];
  const r = periodRange(S, "D", 46900);
  assert.equal(r.baseHi, 47555); assert.equal(r.baseLo, 46872);
  assert.equal(r.hi, 47555); assert.equal(r.lo, 46797); assert.equal(r.brokeLo, true);
  // 收盤後（這一盤已完成）→ 下一盤的基準是剛收的日盤＋前一個夜盤
  const after = periodRange(S.map(x => ({ ...x, complete: true })), "D");
  assert.equal(after.hi, 47555); assert.equal(after.lo, 46797); assert.equal(after.live, false);
});

test("週、月用上一個完整期間，破高破底跟著擴大", () => {
  const S = [
    { td: "20261014", type: "D", h: 999, l: 1 },     // 上上週，不算
    { td: "20261015", type: "D", h: 120, l: 100 },   // 上一週 10/15～10/21
    { td: "20261021", type: "D", h: 130, l: 95 },
    { td: "20261022", type: "N", h: 140, l: 135 },   // 這一週，不算
  ];
  const w0 = periodRange(S, "W", 120);
  assert.equal(w0.hi, 140); assert.equal(w0.lo, 95); assert.equal(w0.from, "20261015"); assert.equal(w0.brokeHi, true); // 這週夜盤 140 已破上週高 130
  const w = periodRange(S, "W", 80);
  assert.equal(w.lo, 80); assert.equal(w.brokeLo, true);   // 現價破底 → 低點跟著改
  const m = periodRange(S, "M", 120);
  assert.equal(m.hi, 999); assert.equal(m.from, "20261014"); // 上一個月 9/17～10/21

});
