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

test("高低被突破時跟著現價改", () => {
  const S = [{ td: "20261019", type: "N", h: 100, l: 90 }, { td: "20261019", type: "D", h: 105, l: 92 }];
  const r = periodRange(S, "D", 110);
  assert.equal(r.hi, 110); assert.equal(r.lo, 90); assert.equal(r.broke, true);
});

test("週、月用上一個完整期間，而且不跟著現價擴大", () => {
  const S = [
    { td: "20261014", type: "D", h: 999, l: 1 },     // 上上週，不算
    { td: "20261015", type: "D", h: 120, l: 100 },   // 上一週 10/15～10/21
    { td: "20261021", type: "D", h: 130, l: 95 },
    { td: "20261022", type: "N", h: 140, l: 135 },   // 這一週，不算
  ];
  const w = periodRange(S, "W", 200);
  assert.equal(w.hi, 130); assert.equal(w.lo, 95); assert.equal(w.from, "20261015"); assert.equal(w.to, "20261021"); assert.equal(w.broke, true);
  const m = periodRange(S, "M", 120);
  assert.equal(m.hi, 999); assert.equal(m.from, "20261014"); // 上一個月 9/17～10/21
  const d = periodRange(S, "D", 150);
  assert.equal(d.hi, 150); assert.equal(d.lo, 135);
});
