// 六層多空點位：用一段期間的最高／最低算中軸與上下六層
// 期間切法照使用者規則（都以日盤收盤 13:45 為界，夜盤算下一個交易日）：
//   日＝前兩盤（現在日盤 → 前一天日盤＋昨晚夜盤；現在夜盤 → 今天日盤＋昨晚夜盤）的最高／最低，
//       這一盤破高或破底就把新高／新低納入重算
//   週＝「上一個完整的週」：上上個週三結算後～上個週三結算；這一週破高／破底就跟著擴大
//   月＝「上一個完整的月」：上上個第三個週三結算後～上個第三個週三結算；這個月破高／破底就跟著擴大
import { thirdWednesday } from "./sessions.js";
import { addDays, weekdayOf } from "./time.js";

export const SIX_RATIOS = [0.382, 0.618, 0.786, 1, 1.272, 1.618];
export const SIX_PERIODS = [["D", "日"], ["W", "週"], ["M", "月"]];

export function sixLevels(hi, lo) {
  if (!(hi > lo)) return null;
  const mid = (hi + lo) / 2, d = hi - mid;
  return { hi, lo, mid, d, up: SIX_RATIOS.map(r => mid + d * r), dn: SIX_RATIOS.map(r => mid - d * r) };
}

/** 期間開始前的最後一個結算日（YYYYMMDD）；期間＝交易日 > 這一天 */
export function periodAnchor(mode, td) {
  if (mode === "D") return addDays(td, -1);
  if (mode === "W") {
    const back = (weekdayOf(td) - 3 + 7) % 7 || 7; // 往回找「嚴格早於 td」的週三
    return addDays(td, -back);
  }
  const ym = td.slice(0, 6);
  const tw = thirdWednesday(ym);
  if (td > tw) return tw;
  const [y, m] = [Number(ym.slice(0, 4)), Number(ym.slice(4, 6))];
  const prev = m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, "0")}`;
  return thirdWednesday(prev);
}

/**
 * summaries: 各盤摘要（含 td、type、h、l；盤中那一盤也在裡面）
 * price: 現價；被突破時高低立即跟著改
 */
const ord = s => s.td + (s.type === "N" ? "0" : "1");
function dayRange(S, price) {
  const sorted = [...S].sort((a, b) => ord(a).localeCompare(ord(b)));
  const last = sorted.at(-1), live = last.complete === false;
  const base = (live ? sorted.slice(0, -1) : sorted).slice(-2);
  if (!base.length) return null;
  let hi = Math.max(...base.map(s => s.h)), lo = Math.min(...base.map(s => s.l));
  const baseHi = hi, baseLo = lo;
  if (live) { hi = Math.max(hi, last.h); lo = Math.min(lo, last.l); }
  if (price != null) { hi = Math.max(hi, price); lo = Math.min(lo, price); }
  const tds = [...new Set(base.map(s => s.td))].sort();
  return { mode: "D", hi, lo, from: tds[0], to: tds.at(-1), days: tds.length, sessions: base.length, base: base.map(s => ({ start: s.start ?? s.td, type: s.type })), live, broke: hi > baseHi || lo < baseLo, brokeHi: hi > baseHi, brokeLo: lo < baseLo, baseHi, baseLo, prev: false };
}

export function periodRange(summaries, mode, price = null) {
  const S = (summaries ?? []).filter(s => s.h != null && s.l != null && s.td);
  if (!S.length) return null;
  if (mode === "D") return dayRange(S, price);
  const lastTd = S.reduce((a, s) => (s.td > a ? s.td : a), "");
  const anchor = periodAnchor(mode, lastTd);
  // 週、月：用上一個完整期間（結算日當天的日盤算在那一期）
  const prev = mode !== "D";
  const from = prev ? periodAnchor(mode, anchor) : anchor, to = prev ? anchor : lastTd;
  const rows = S.filter(s => s.td > from && s.td <= to);
  if (!rows.length) return null;
  let hi = Math.max(...rows.map(s => s.h)), lo = Math.min(...rows.map(s => s.l));
  const baseHi = hi, baseLo = lo;
  if (prev) for (const s of S) if (s.td > anchor && s.td <= lastTd) { hi = Math.max(hi, s.h); lo = Math.min(lo, s.l); } // 這一期已經破高／破底
  if (price != null) { hi = Math.max(hi, price); lo = Math.min(lo, price); }
  const broke = hi > baseHi || lo < baseLo;
  const tds = [...new Set(rows.map(s => s.td))].sort();
  return { mode, hi, lo, from: tds[0], to: tds.at(-1), days: tds.length, sessions: rows.length, live: rows.some(s => s.complete === false), broke, brokeHi: hi > baseHi, brokeLo: lo < baseLo, baseHi, baseLo, anchor, prev };
}
