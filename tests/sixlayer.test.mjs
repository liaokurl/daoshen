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
