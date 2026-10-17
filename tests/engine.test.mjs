import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTick, frontContract, thirdWednesday, sessionAt, nextTradingDate } from "../engine/sessions.js";
import { ticksToSessions, buildBars15, aggregate, buildDaily } from "../engine/bars.js";
import { closeThreshold, smaLast, swings } from "../engine/indicators.js";
import { analyzeStructure } from "../engine/structure.js";
import { intradayTouchStudy, sessionCloseStudy } from "../engine/backtest.js";
import { buildPlan, mergeLevels, touchOutcome } from "../engine/plan.js";
import { tpeMs } from "../engine/time.js";

test("盤別歸屬：日盤、夜盤跨午夜、收盤那一筆", () => {
  assert.deepEqual(classifyTick("20261016", "084500"), { type: "D", start: "20261016", slot: 0 });
  assert.deepEqual(classifyTick("20261016", "134500"), { type: "D", start: "20261016", slot: 19 });
  assert.deepEqual(classifyTick("20261016", "150000"), { type: "N", start: "20261016", slot: 0 });
  // 週六凌晨的成交屬於週五晚上開始的夜盤
  assert.deepEqual(classifyTick("20261017", "045959"), { type: "N", start: "20261016", slot: 55 });
  assert.deepEqual(classifyTick("20261017", "50000"), { type: "N", start: "20261016", slot: 55 });
  assert.equal(classifyTick("20261016", "140000"), null);
  assert.equal(classifyTick("20261016", "060000"), null);
});

test("近月合約：第三個星期三結算後換月", () => {
  assert.equal(thirdWednesday("202610"), "20261021");
  assert.equal(frontContract("20261021"), "202610");
  assert.equal(frontContract("20261022"), "202611");
  assert.equal(frontContract("20261231"), "202701");
});

test("交易日推算與目前盤別", () => {
  assert.deepEqual(nextTradingDate("20261016"), { date: "20261019", estimated: true });
  assert.equal(sessionAt(tpeMs("20261017", 3 * 60)).type, "N"); // 週六 03:00 仍是週五夜盤
  assert.deepEqual(sessionAt(tpeMs("20261017", 12 * 60)), { start: "20261019", type: "D", live: false });
  assert.deepEqual(sessionAt(tpeMs("20261019", 9 * 60)), { start: "20261019", type: "D", live: true });
});

function csv(rows) {
  return ["成交日期,商品代號,到期月份(週別),成交時間,成交價格,成交數量(B+S),近月價格,遠月價格,開盤集合競價", ...rows.map(r => r.join(","))].join("\r\n");
}

test("逐筆 → 15分K，價差單與他商品排除，數量除以 2", () => {
  const text = csv([
    ["20261016", "TX     ", "202610", "084500", "27000", "20", "-", "-", "*"],
    ["20261016", "TX", "202610", "084959", "27050", "4", "-", "-", ""],
    ["20261016", "TX", "202610", "090000", "26980", "2", "-", "-", ""],
    ["20261016", "TX", "202610/202611", "085000", "50", "2", "-", "-", ""],
    ["20261016", "MTX", "202610", "085000", "1", "2", "-", "-", ""],
  ]);
  const out = ticksToSessions(text);
  const rec = out.get("202610").get("20261016D");
  assert.deepEqual(rec.bars[0], [27000, 27050, 27000, 27050, 12]);
  assert.deepEqual(rec.bars[1], [26980, 26980, 26980, 26980, 1]);
  assert.equal(out.has("202610/202611"), false);
});

function makeSession(start, type, closes) {
  return { start, type, contract: "202611", source: "test", complete: true, bars: closes.map(c => [c, c + 5, c - 5, c, 10]) };
}

test("60分K：日盤 5 根、夜盤 14 根；缺格以前收補平", () => {
  const day = makeSession("20261016", "D", Array.from({ length: 20 }, (_, i) => 100 + i));
  day.bars[3] = null;
  const night = makeSession("20261016", "N", Array.from({ length: 56 }, () => 200));
  const b15 = buildBars15([night, day]);
  assert.equal(b15.length, 76);
  assert.equal(b15[3].filled, true);
  assert.equal(b15[3].c, 102);
  const h1 = aggregate(b15, 60);
  assert.equal(h1.filter(b => b.type === "D").length, 5);
  assert.equal(h1.filter(b => b.type === "N").length, 14);
  assert.equal(h1[0].c, 102);
});

test("收盤門檻是精確值：收在門檻上方就一定高於含自己的均線", () => {
  const closes = Array.from({ length: 300 }, (_, i) => 1000 + Math.sin(i / 7) * 50);
  const th = closeThreshold(closes, 60);
  for (const c of [th + 0.01, th - 0.01]) {
    const ma = smaLast([...closes, c], 60);
    assert.equal(c > ma, c > th);
  }
});

test("擺盪低點：右側 2 根收完才確認，沒有未來資料", () => {
  const mk = lows => lows.map((l, i) => ({ t: i, end: i + 1, h: l + 10, l, c: l + 5 }));
  const partial = mk([10, 9, 5, 8]); // 右側只有 1 根
  assert.equal(swings(partial).lows.length, 0);
  const full = mk([10, 9, 5, 8, 9]);
  const s = swings(full).lows;
  assert.equal(s.length, 1);
  assert.equal(s[0].price, 5);
  assert.equal(s[0].confirmedAt, 5);
});

// 產生測試行情：一段價格路徑 → 夜/日盤紀錄
function syntheticMarket(pathFn, days = 30) {
  const recs = [];
  const dates = [];
  let d = new Date(Date.UTC(2026, 8, 1));
  while (dates.length < days) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) dates.push(d.toISOString().slice(0, 10).replaceAll("-", ""));
    d = new Date(d.getTime() + 86400000);
  }
  let k = 0;
  for (let i = 0; i < dates.length; i += 1) {
    if (i > 0) {
      const closes = Array.from({ length: 56 }, () => pathFn(k++));
      recs.push({ ...makeSession(dates[i - 1], "N", closes), td: dates[i] });
    }
    const closes = Array.from({ length: 20 }, () => pathFn(k++));
    recs.push({ ...makeSession(dates[i], "D", closes), td: dates[i] });
  }
  return { recs, dates };
}

function seriesFrom(recs) {
  const b15 = buildBars15(recs);
  const summaries = recs.map(r => {
    const bs = b15.filter(b => b.key === `${r.start}${r.type}`);
    return { td: r.td, type: r.type, o: bs[0].o, h: Math.max(...bs.map(b => b.h)), l: Math.min(...bs.map(b => b.l)), c: bs.at(-1).c, v: 1 };
  });
  return { b15, summaries, daily: buildDaily(summaries) };
}

test("條件 A/B：都不成立 → 空方或偏弱；上漲後兩者成立", () => {
  const down = syntheticMarket(k => 30000 - k * 2);
  const s1 = seriesFrom(down.recs);
  const a1 = analyzeStructure({ daily: s1.daily, bars15: s1.b15, dataAsOf: s1.b15.at(-1).end });
  assert.equal(a1.conditions.A.value, false);
  assert.equal(a1.conditions.B.value, false);
  assert.equal(a1.structure.state, "BEAR");
  const up = syntheticMarket(k => 20000 + k * 2);
  const s2 = seriesFrom(up.recs);
  const a2 = analyzeStructure({ daily: s2.daily, bars15: s2.b15, dataAsOf: s2.b15.at(-1).end });
  assert.equal(a2.conditions.A.value, true);
  assert.equal(a2.conditions.B.value, true);
  assert.equal(a2.conditions.shortCover, true);
  assert.equal(a2.structure.state, "BOTH");
});

test("只有條件B成立（60分站回、日線仍弱）也算回補條件", () => {
  // 長期下跌，最後一段急拉
  const n = 30 * 20 + 29 * 56;
  const m = syntheticMarket(k => (k < n - 80 ? 30000 - k * 2 : 30000 - (n - 80) * 2 + (k - (n - 80)) * 12));
  const s = seriesFrom(m.recs);
  const a = analyzeStructure({ daily: s.daily, bars15: s.b15, dataAsOf: s.b15.at(-1).end });
  assert.equal(a.conditions.B.value, true);
  assert.equal(a.conditions.A.value, false);
  assert.equal(a.conditions.shortCover, true);
  assert.equal(a.structure.state, "HOURLY_ONLY");
});

test("盤中穿越不等於收盤確認", () => {
  const m = syntheticMarket(k => 30000 - k * 2);
  const s = seriesFrom(m.recs);
  const asOf = s.b15.at(-1).end - 30 * 60000; // 最後一根 60 分還沒收完
  const live = s.b15.filter(b => b.t < asOf);
  const ma = analyzeStructure({ daily: s.daily, bars15: live, dataAsOf: asOf }).byId.h1_60.ma;
  const spike = live.map((b, i) => (i === live.length - 1 ? { ...b, h: ma + 100 } : b));
  const a = analyzeStructure({ daily: s.daily, bars15: spike, dataAsOf: asOf, price: ma + 50 });
  assert.equal(a.byId.h1_60.intrabarCross, true);
  assert.equal(a.byId.h1_60.lastCloseAbove, false);
  assert.equal(a.conditions.B.value, false);
});

test("資料不足時回報資料不足，不補值", () => {
  const m = syntheticMarket(k => 30000 + Math.sin(k) * 10, 3);
  const s = seriesFrom(m.recs);
  const a = analyzeStructure({ daily: s.daily, bars15: s.b15, dataAsOf: s.b15.at(-1).end });
  assert.equal(a.byId.h1_240.insufficient, true);
  assert.equal(a.byId.h1_240.ma, null);
  assert.equal(a.structure.state, "INSUFFICIENT");
});

test("相近的線合併；計畫最多 3 條線且上下各至少一條", () => {
  const zones = mergeLevels([{ type: "a", price: 100 }, { type: "b", price: 108 }, { type: "c", price: 150 }], 10);
  assert.equal(zones.length, 2);
  const m = syntheticMarket(k => 27000 + Math.sin(k / 40) * 300, 30);
  const s = seriesFrom(m.recs);
  const a = analyzeStructure({ daily: s.daily, bars15: s.b15, dataAsOf: s.b15.at(-1).end });
  const plan = buildPlan({ analysis: a, session: { start: "20261019", type: "D", td: "20261019" }, prevSession: s.summaries.at(-1), summaries: s.summaries, stats: {}, contract: "202611", createdAt: 0 });
  assert.ok(plan.lines.length <= 3);
  assert.ok(plan.lines.some(l => l.role === "壓力") || plan.lines.some(l => l.role === "支撐"));
  assert.ok(plan.rules.some(r => r.id === "B"));
});

test("碰線結果：先反彈 vs 先穿越", () => {
  const bar = (h, l) => ({ h, l });
  const line = { price: 100, role: "支撐" };
  assert.equal(touchOutcome([bar(110, 99), bar(130, 105)], line, 20), "已反彈");
  assert.equal(touchOutcome([bar(110, 99), bar(101, 75)], line, 20), "已穿越");
  assert.equal(touchOutcome([bar(110, 70)], line, 20), "已穿越");
  assert.equal(touchOutcome([bar(130, 101)], line, 20), "未碰");
});

test("回測：有隨機線對照組，且結果都有樣本數", () => {
  const m = syntheticMarket(k => 27000 + Math.sin(k / 25) * 200 + Math.sin(k / 3) * 30, 30);
  const s = seriesFrom(m.recs);
  const sessions = m.recs.map(r => ({ key: `${r.start}${r.type}`, td: r.td, type: r.type, front: true }));
  const res = intradayTouchStudy([{ contract: "202611", bars15: s.b15, sessions, daily: s.daily }]);
  assert.ok(res.byType.random.n > 0);
  for (const v of Object.values(res.byType)) assert.ok(Number.isInteger(v.n));
  const sc = sessionCloseStudy([{ contract: "202611", sessions: s.summaries.map((x, i) => ({ ...x, key: sessions[i].key, front: true })), daily: s.daily }]);
  assert.ok(sc.random.n > 0);
});
