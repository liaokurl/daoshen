// 刀神多週期均線結構判讀。
// 課程核心：日K MA20、60分K MA60 / MA240。30 / 15 分為 App 延伸觀察。
import { aggregate } from "./bars.js";
import { smaLast, closeThreshold, atr, slopeOf, swings } from "./indicators.js";

export const LINE_DEFS = [
  { id: "d1_20", tf: "1d", n: 20, label: "日K MA20", core: true },
  { id: "h1_60", tf: "60m", n: 60, label: "60分 MA60", core: true },
  { id: "h1_240", tf: "60m", n: 240, label: "60分 MA240", core: true },
  { id: "m30_60", tf: "30m", n: 60, label: "30分 MA60", core: false },
  { id: "m30_240", tf: "30m", n: 240, label: "30分 MA240", core: false },
  { id: "m15_20", tf: "15m", n: 20, label: "15分 MA20", core: false },
  { id: "m15_240", tf: "15m", n: 240, label: "15分 MA240", core: false },
];

export const DEFAULT_CONFIG = {
  slopeLookback: 5,
  flatAtr: 0.03,
  tangleAtr: 0.35, // 60分 MA60 與 MA240 距離 < 0.35×ATR 視為糾結
  swingLeft: 2,
  swingRight: 2,
};

/** 把 15 分 K 拆成「已完成」與「目前進行中」 */
function splitByCompletion(bars, dataAsOf) {
  const done = [], open = [];
  for (const b of bars) {
    if (b.end <= dataAsOf && !b.partial) done.push(b);
    else if (b.t < dataAsOf) open.push(b);
  }
  return { done, open };
}

/**
 * series: { daily: 日K(含未完成), bars15: 15分K(含盤中) }
 * dataAsOf: 資料最新時間（ms）；price: 現價（可手動），沒有就用最後一筆收盤
 */
export function buildFrames({ daily, bars15, dataAsOf }) {
  const tf = {
    "15m": splitByCompletion(bars15, dataAsOf),
    "30m": splitByCompletion(markPartial(aggregate(bars15, 30), dataAsOf), dataAsOf),
    "60m": splitByCompletion(markPartial(aggregate(bars15, 60), dataAsOf), dataAsOf),
  };
  const dDone = daily.filter(d => d.complete), dOpen = daily.filter(d => !d.complete);
  tf["1d"] = { done: dDone, open: dOpen };
  return tf;
}

function markPartial(bars, dataAsOf) {
  return bars.map(b => (b.end > dataAsOf ? { ...b, partial: true } : b));
}

export function analyzeStructure({ daily, bars15, dataAsOf, price = null, config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const frames = buildFrames({ daily, bars15, dataAsOf });
  const lastPrice = price ?? bars15.at(-1)?.c ?? daily.at(-1)?.c ?? null;
  const atrBy = {};
  for (const key of Object.keys(frames)) atrBy[key] = atr(frames[key].done, 14);

  const lines = LINE_DEFS.map(def => {
    const fr = frames[def.tf];
    const closes = fr.done.map(b => b.c);
    const ma = smaLast(closes, def.n);
    const threshold = closeThreshold(closes, def.n);
    const lastBar = fr.done.at(-1) ?? null;
    const openBar = fr.open.length ? mergeOpen(fr.open) : null;
    const slope = slopeOf(closes, def.n, { lookback: cfg.slopeLookback, flatAtr: cfg.flatAtr, atrValue: atrBy[def.tf] });
    // 盤中估算：最近 n-1 根已收盤 + 現價 當作進行中這一根
    const maEst = threshold != null && lastPrice != null && openBar ? (threshold * (def.n - 1) + lastPrice) / def.n : ma;
    const insufficient = ma == null;
    return {
      ...def,
      barsAvailable: closes.length,
      ma, maEst, threshold,
      slope: slope.dir,
      lastClose: lastBar?.c ?? null,
      lastBarEnd: lastBar?.end ?? null,
      lastBarTd: lastBar?.td ?? null,
      lastCloseAbove: insufficient || !lastBar ? null : lastBar.c > ma,
      distance: insufficient || lastPrice == null ? null : lastPrice - ma,
      side: insufficient || lastPrice == null ? null : lastPrice >= ma ? "ABOVE" : "BELOW",
      // 進行中的 K 棒是否已經穿越均線（盤中穿越 ≠ 收盤確認）
      intrabarCross: Boolean(!insufficient && openBar && openBar.l <= ma && openBar.h >= ma),
      openBar,
      insufficient,
    };
  });
  const L = Object.fromEntries(lines.map(l => [l.id, l]));

  // 條件 A：日K（全日盤）已收盤價 > MA20
  const a = L.d1_20;
  const conditionA = a.insufficient ? null : a.lastCloseAbove;
  // 條件 B：60分K 已收盤價同時 > MA60、MA240
  const b60 = L.h1_60, b240 = L.h1_240;
  const conditionB = b60.insufficient || b240.insufficient ? null : Boolean(b60.lastCloseAbove && b240.lastCloseAbove);
  const thresholdA = a.threshold;
  const thresholdB = b60.threshold != null && b240.threshold != null ? Math.max(b60.threshold, b240.threshold) : null;
  const holdB = b60.threshold != null && b240.threshold != null ? Math.max(b60.threshold, b240.threshold) : null;

  // 擺盪點（60分，左右各 2 根，右側收盤後才確認）
  const sw = swings(frames["60m"].done, { left: cfg.swingLeft, right: cfg.swingRight });
  const lows = sw.lows.slice(-2), highs = sw.highs.slice(-2);
  let higherLow = { state: "INSUFFICIENT", label: "擺盪低點不足", prior: null, latest: null };
  if (lows.length === 2) {
    const [p, q] = lows;
    if (lastPrice != null && lastPrice < q.price) higherLow = { state: "BROKEN", label: "已跌破最近擺盪低點", prior: p, latest: q };
    else if (q.price > p.price) higherLow = { state: "FORMED", label: "低點墊高（Higher Low）已確認", prior: p, latest: q };
    else higherLow = { state: "LOWER_LOW", label: "低點仍在下移", prior: p, latest: q };
  }

  // 綜合結構
  const atr60 = atrBy["60m"];
  const tangled = !b60.insufficient && !b240.insufficient && atr60 != null
    && Math.abs(b60.ma - b240.ma) < cfg.tangleAtr * atr60
    && b60.slope !== "RISING" && b240.slope !== "RISING"
    && b60.slope !== "FALLING";
  let state, title, tone;
  if (conditionA == null || conditionB == null) {
    state = "INSUFFICIENT"; title = "資料不足，暫不判讀"; tone = "muted";
  } else if (tangled) {
    state = "TANGLED"; title = "60分均線糾結，方向不明"; tone = "neutral";
  } else if (conditionA && conditionB) {
    state = "BOTH"; title = "日線、60分都已站回"; tone = "up";
  } else if (conditionA) {
    state = "DAILY_ONLY"; title = "日線站回 MA20，60分尚未站回雙均線"; tone = "mixed";
  } else if (conditionB) {
    state = "HOURLY_ONLY"; title = "60分已站回雙均線，日線仍在 MA20 下"; tone = "mixed";
  } else {
    const allFalling = [a, b60, b240].every(l => l.slope === "FALLING");
    state = allFalling ? "BEAR" : "WEAK";
    title = allFalling ? "空方結構：價在線下、均線下彎" : "偏弱：日線與60分都在均線下";
    tone = "down";
  }

  // 盤中估算：如果「現在」就收盤，條件會不會成立（不等於確認）
  const est = {
    A: lastPrice != null && thresholdA != null ? lastPrice > thresholdA : null,
    B: lastPrice != null && thresholdB != null ? lastPrice > thresholdB : null,
  };

  return {
    lastPrice,
    dataAsOf,
    lines,
    byId: L,
    atr: atrBy,
    conditions: {
      A: { value: conditionA, threshold: thresholdA, est: est.A, barTd: a.lastBarTd, barEnd: a.lastBarEnd },
      B: { value: conditionB, threshold: thresholdB, hold: holdB, est: est.B, barEnd: b60.lastBarEnd },
      shortCover: conditionA == null && conditionB == null ? null : Boolean(conditionA || conditionB),
    },
    structure: { state, title, tone },
    swings: { lows, highs, higherLow },
    frames,
  };
}

function mergeOpen(bars) {
  return {
    t: bars[0].t,
    o: bars[0].o,
    h: Math.max(...bars.map(b => b.h)),
    l: Math.min(...bars.map(b => b.l)),
    c: bars.at(-1).c,
  };
}
