// 回測：每一種「線」第一次被碰到之後，是先反彈還是先穿越？跟隨機畫一條線比較。
// 嚴格只用碰線當下已知的資料（均線用已完成 K 棒、擺盪點需右側確認）。
import { aggregate } from "./bars.js";
import { smaSeries, atrSeries, swings, mean } from "./indicators.js";

export const LEVEL_TYPES = {
  h1_60: "60分 MA60",
  h1_240: "60分 MA240",
  d1_20: "日K MA20",
  prevHigh: "前一盤高點",
  prevLow: "前一盤低點",
  swingLow: "60分擺盪低點",
  swingHigh: "60分擺盪高點",
  random: "隨機線（對照組）",
};

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * 盤中碰線回測（15 分 K）。
 * contracts: [{ contract, bars15, sessions:[{key, td, type, front:boolean}], daily:[全日盤日K] }]
 * 回傳 { byType: {type: {bounce, brk, ambiguous, none, n, rate}}, events: [...] }
 */
export function intradayTouchStudy(contracts, { horizon = 12, rFactor = 0.5, rMin = 15, randomPerSession = 4, seed = 7 } = {}) {
  const tally = {};
  const events = [];
  const rand = rng(seed);
  for (const C of contracts) {
    const b15 = C.bars15;
    if (b15.length < 100) continue;
    const h1 = aggregate(b15, 60);
    const h1c = h1.map(b => b.c);
    const ma60 = smaSeries(h1c, 60), ma240 = smaSeries(h1c, 240), atr60 = atrSeries(h1, 14);
    const sw = swings(h1, { left: 2, right: 2 });
    const dailyC = C.daily.map(d => d.c), dma20 = smaSeries(dailyC, 20);
    const frontKeys = new Set(C.sessions.filter(s => s.front).map(s => s.key));
    // 依盤別分組
    const bySession = new Map();
    b15.forEach((b, i) => { if (!bySession.has(b.key)) bySession.set(b.key, []); bySession.get(b.key).push(i); });
    const sessionOrder = [...bySession.keys()];
    let h1ptr = -1;
    for (let si = 1; si < sessionOrder.length; si += 1) {
      const key = sessionOrder[si];
      if (!frontKeys.has(key)) continue;
      const idxs = bySession.get(key);
      const prevIdxs = bySession.get(sessionOrder[si - 1]);
      const prevBars = prevIdxs.map(i => b15[i]);
      const prevHigh = Math.max(...prevBars.map(b => b.h)), prevLow = Math.min(...prevBars.map(b => b.l));
      const sessionStart = b15[idxs[0]].t;
      const td = C.sessions.find(s => s.key === key)?.td;
      // 日K MA20：只用此交易日之前已完成的日K
      let d20 = null;
      if (td) {
        let k = -1;
        for (let j = 0; j < C.daily.length; j += 1) if (C.daily[j].td < td && C.daily[j].complete) k = j;
        d20 = k >= 0 ? dma20[k] : null;
      }
      // 隨機對照線
      const pr = prevHigh - prevLow;
      const randoms = Array.from({ length: randomPerSession }, () => prevLow - 0.5 * pr + rand() * 2 * pr);
      const touched = new Set();
      for (let p = 0; p < idxs.length; p += 1) {
        const i = idxs[p];
        const bar = b15[i];
        // 推進 60 分指標到「此根開始前已完成」
        while (h1ptr + 1 < h1.length && h1[h1ptr + 1].end <= bar.t) h1ptr += 1;
        const atrNow = h1ptr >= 0 ? atr60[h1ptr] : null;
        if (atrNow == null) continue;
        const R = Math.max(rMin, rFactor * atrNow);
        const lastLow = lastConfirmed(sw.lows, bar.t), lastHigh = lastConfirmed(sw.highs, bar.t);
        const levels = [
          ["h1_60", h1ptr >= 0 ? ma60[h1ptr] : null],
          ["h1_240", h1ptr >= 0 ? ma240[h1ptr] : null],
          ["d1_20", d20],
          ["prevHigh", prevHigh],
          ["prevLow", prevLow],
          ["swingLow", lastLow?.price ?? null],
          ["swingHigh", lastHigh?.price ?? null],
          ...randoms.map((v, k) => [`random:${k}`, v]),
        ];
        const prevClose = i > 0 ? b15[i - 1].c : null;
        if (prevClose == null) continue;
        for (const [name, L] of levels) {
          if (L == null || touched.has(name)) continue;
          if (!(bar.l <= L && bar.h >= L)) continue;
          touched.add(name);
          if (prevClose === L) continue;
          const side = prevClose > L ? "support" : "resistance";
          // 開盤跳空直接越過：不算「碰線反應」
          if (p === 0 && ((side === "support" && bar.o < L) || (side === "resistance" && bar.o > L))) continue;
          const outcome = evaluate(b15, idxs, p, L, side, R, horizon);
          const type = name.startsWith("random") ? "random" : name;
          const t = tally[type] ?? (tally[type] = { bounce: 0, brk: 0, ambiguous: 0, none: 0, support: { bounce: 0, brk: 0 }, resistance: { bounce: 0, brk: 0 }, rSum: 0 });
          t[outcome] += 1;
          t.rSum += R;
          if (outcome === "bounce" || outcome === "brk") t[side][outcome] += 1;
          if (type !== "random") events.push({ type, t: bar.t, level: Math.round(L), side, outcome, R: Math.round(R), contract: C.contract });
        }
      }
      void sessionStart;
    }
  }
  return { byType: finalize(tally), events };
}

function lastConfirmed(list, t) {
  let found = null;
  for (const s of list) { if (s.confirmedAt <= t) found = s; else break; }
  return found;
}

function evaluate(b15, idxs, p, L, side, R, horizon) {
  const first = b15[idxs[p]];
  const brkFirst = side === "support" ? L - first.l >= R : first.h - L >= R;
  if (brkFirst) return "brk";
  for (let q = p + 1; q < Math.min(idxs.length, p + 1 + horizon); q += 1) {
    const b = b15[idxs[q]];
    const bounce = side === "support" ? b.h - L >= R : L - b.l >= R;
    const brk = side === "support" ? L - b.l >= R : b.h - L >= R;
    if (bounce && brk) return "ambiguous";
    if (bounce) return "bounce";
    if (brk) return "brk";
  }
  return "none";
}

/**
 * 盤別收盤回測（期交所每盤開高低收，可回測多年）。
 * 事件：開盤在線的一側，盤中碰到線。結果：收盤是否仍在原來那一側（守住）。
 * contracts: [{ contract, sessions:[{key, td, type, o,h,l,c, front}], daily:[全日盤日K] }]
 */
export function sessionCloseStudy(contracts, { randomPerSession = 4, seed = 11 } = {}) {
  const tally = {};
  const rand = rng(seed);
  for (const C of contracts) {
    const S = C.sessions;
    const dailyC = C.daily.map(d => d.c), dma20 = smaSeries(dailyC, 20);
    const ranges = [];
    for (let i = 1; i < S.length; i += 1) {
      const s = S[i], prev = S[i - 1];
      ranges.push(prev.h - prev.l);
      if (!s.front) continue;
      let k = -1;
      for (let j = 0; j < C.daily.length; j += 1) if (C.daily[j].td < s.td && C.daily[j].complete) k = j;
      const avgRange = mean(ranges.slice(-20));
      const levels = [
        ["prevHigh", prev.h], ["prevLow", prev.l], ["d1_20", k >= 0 ? dma20[k] : null],
        ...Array.from({ length: randomPerSession }, (_, r) => [`random:${r}`, s.o + (rand() * 2 - 1) * 1.2 * avgRange]),
      ];
      for (const [name, L] of levels) {
        if (L == null || s.o === L) continue;
        if (!(s.l <= L && s.h >= L)) continue;
        const side = s.o > L ? "support" : "resistance";
        const held = side === "support" ? s.c > L : s.c < L;
        const type = name.startsWith("random") ? "random" : name;
        const t = tally[type] ?? (tally[type] = { held: 0, crossed: 0 });
        t[held ? "held" : "crossed"] += 1;
      }
    }
  }
  const out = {};
  for (const [type, t] of Object.entries(tally)) {
    const n = t.held + t.crossed;
    out[type] = { ...t, n, rate: n ? t.held / n : null };
  }
  return judge(out, "rate");
}

function finalize(tally) {
  const out = {};
  for (const [type, t] of Object.entries(tally)) {
    const n = t.bounce + t.brk;
    out[type] = { bounce: t.bounce, brk: t.brk, ambiguous: t.ambiguous, none: t.none, n, rate: n ? t.bounce / n : null, avgR: (t.bounce + t.brk + t.ambiguous + t.none) ? t.rSum / (t.bounce + t.brk + t.ambiguous + t.none) : null, support: t.support, resistance: t.resistance };
  }
  return judge(out, "rate");
}

/** 與隨機線比較，給出白話判定 */
export function judge(byType, key) {
  const base = byType.random;
  for (const [type, s] of Object.entries(byType)) {
    if (type === "random") { s.verdict = "BASELINE"; continue; }
    if (!base || base.n < 20 || s.n < 20 || s[key] == null) { s.verdict = "SMALL_SAMPLE"; continue; }
    const p = s[key], pb = base[key];
    const se = Math.sqrt((p * (1 - p)) / s.n + (pb * (1 - pb)) / base.n) || 1;
    const z = (p - pb) / se;
    s.edge = p - pb;
    s.z = z;
    s.verdict = z > 1.64 ? "EDGE" : z < -1.64 ? "WEAK" : "NO_EDGE";
  }
  return byType;
}

export const VERDICT_TEXT = {
  EDGE: "比隨機線更常有反應",
  NO_EDGE: "跟隨機線差不多",
  WEAK: "比隨機線更常被穿越",
  SMALL_SAMPLE: "樣本不足，僅供參考",
  BASELINE: "對照組",
};
