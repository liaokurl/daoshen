// 刀神「三刀流」與「海龜突破」。
// 劉備 MA240＝戰略方向；關羽 MA60＝戰術進場（扣板機）；張飛 MA20＝停利收兵。全部用 60 分K。
// 海龜：4 小時K 收盤突破前 20 根最高 → 偏多；跌破前 20 根最低 → 偏空。
import { aggregate } from "./bars.js";
import { smaLast, closeThreshold, slopeOf, atr, mean } from "./indicators.js";

export const SWORD_MODES = {
  TREND_LONG: { label: "順勢多", tone: "up", desc: "站上劉備（240）也站上關羽（60）：大方向與進場方向一致向上" },
  BOUNCE_LONG: { label: "短打反彈多", tone: "mixed", desc: "還在劉備（240）之下，但已站上關羽（60）：只能短打反彈，目標小、停利快" },
  PULLBACK_SHORT: { label: "修正空", tone: "mixed", desc: "還在劉備（240）之上，但跌破關羽（60）：大方向仍多，只做修正段的短空" },
  TREND_SHORT: { label: "順勢空", tone: "down", desc: "跌破劉備（240）也在關羽（60）之下：大方向與進場方向一致向下" },
  INSUFFICIENT: { label: "資料不足", tone: "muted", desc: "60 分K 不足 240 根" },
};

function modeOf(px, m60, m240) {
  if (px == null || m60 == null || m240 == null) return "INSUFFICIENT";
  if (px >= m240) return px >= m60 ? "TREND_LONG" : "PULLBACK_SHORT";
  return px >= m60 ? "BOUNCE_LONG" : "TREND_SHORT";
}

/**
 * h1Done: 已完成 60 分K；price: 現價（盤中估算用）
 * 回傳收盤確認的狀態（confirmed）與「若現在收盤」的估算（live）
 */
export function threeSwords(h1Done, price) {
  const closes = h1Done.map(b => b.c);
  const atr60 = atr(h1Done, 14);
  const line = n => ({
    n,
    ma: smaLast(closes, n),
    threshold: closeThreshold(closes, n), // 下一根收盤要過的精確價
    slope: slopeOf(closes, n, { lookback: 5, flatAtr: 0.03, atrValue: atr60 }).dir,
  });
  const liu = line(240), guan = line(60), zhang = line(20);
  const last = h1Done.at(-1);
  const confirmed = modeOf(last?.c ?? null, guan.ma, liu.ma);
  const live = price == null ? confirmed : modeOf(price, guan.threshold, liu.threshold);
  let align = "MIXED";
  if (zhang.ma != null && guan.ma != null && liu.ma != null) {
    if (zhang.ma > guan.ma && guan.ma > liu.ma) align = "BULL";
    else if (zhang.ma < guan.ma && guan.ma < liu.ma) align = "BEAR";
  }
  // 張飛：持多看跌破 MA20 停利，持空看站上 MA20 停利
  const isLong = confirmed === "TREND_LONG" || confirmed === "BOUNCE_LONG";
  const exit = zhang.threshold == null ? null : {
    side: isLong ? "long" : "short",
    level: zhang.threshold,
    text: isLong ? "多單：60分K 收盤跌破張飛（MA20）停利" : "空單：60分K 收盤站上張飛（MA20）停利",
    hit: last ? (isLong ? last.c < zhang.ma : last.c > zhang.ma) : false,
  };
  // 何時切換：下一根要收在哪裡，狀態才會變
  const flips = [];
  if (guan.threshold != null) flips.push({ who: "關羽", n: 60, level: guan.threshold, text: last && last.c >= guan.ma ? "60分K 收盤跌破 → 失去關羽（進場方向轉空）" : "60分K 收盤站上 → 關羽扣板機（進場方向轉多）" });
  if (liu.threshold != null) flips.push({ who: "劉備", n: 240, level: liu.threshold, text: last && last.c >= liu.ma ? "60分K 收盤跌破 → 劉備翻空（大方向轉弱）" : "60分K 收盤站上 → 劉備翻多（大方向轉強）" });
  return { liu, guan, zhang, confirmed, live, align, exit, flips, lastClose: last?.c ?? null, lastEnd: last?.end ?? null, atr60 };
}

/** 4 小時K：每盤從開盤起每 16 根 15 分K 一組（日盤 08:45–12:45、12:45–13:45；夜盤 15–19、19–23、23–03、03–05） */
export function bars4h(bars15) {
  return aggregate(bars15.map(b => ({ ...b })), 240);
}

export function turtle(h4Done, { length = 20 } = {}) {
  if (h4Done.length < length + 1) return { state: "INSUFFICIENT", label: "4小時K 不足", upper: null, lower: null, since: null };
  let state = "NONE", since = null, at = null;
  for (let i = length; i < h4Done.length; i += 1) {
    const prior = h4Done.slice(i - length, i);
    const hi = Math.max(...prior.map(b => b.h)), lo = Math.min(...prior.map(b => b.l));
    if (h4Done[i].c > hi && state !== "UP") { state = "UP"; since = h4Done[i].end; at = hi; }
    else if (h4Done[i].c < lo && state !== "DOWN") { state = "DOWN"; since = h4Done[i].end; at = lo; }
  }
  const recent = h4Done.slice(-length);
  return {
    state,
    label: state === "UP" ? "海龜偏多（4小時突破 20 根高點）" : state === "DOWN" ? "海龜偏空（4小時跌破 20 根低點）" : "海龜尚未突破",
    upper: Math.max(...recent.map(b => b.h)),
    lower: Math.min(...recent.map(b => b.l)),
    since, breakLevel: at,
  };
}

/** PCR：賣權成交量 ÷ 買權成交量，看 5 日平均 */
export function pcrView(rows) {
  if (!rows?.length) return null;
  const last5 = rows.slice(-5);
  const avg = mean(last5.map(r => r.ratioVol));
  const label = avg < 0.6 ? "極度樂觀，警戒拉回" : avg > 0.9 ? "極度恐慌，警覺嘎空反彈" : "中性";
  return { avg, label, tone: avg < 0.6 ? "warn-up" : avg > 0.9 ? "warn-down" : "neutral", last: rows.at(-1), days: last5.length, series: rows.slice(-20) };
}

/** 刀神總結：方向（海龜）× 三刀流 × 排列，給一句提示（規則整理，不是買賣建議） */
export function swordSummary(sw, tt) {
  const m = SWORD_MODES[sw.confirmed];
  let side = "觀望", text;
  const turtleUp = tt.state === "UP", turtleDown = tt.state === "DOWN";
  if (sw.confirmed === "TREND_LONG") {
    side = turtleDown ? "觀望" : "偏多";
    text = turtleDown ? "60分順勢多，但4小時海龜仍偏空：方向衝突，等海龜翻多或60分轉弱再說" : "順勢多：只找多單，回測關羽（MA60）不破是進場區，跌破張飛（MA20）停利";
  } else if (sw.confirmed === "TREND_SHORT") {
    side = turtleUp ? "觀望" : "偏空";
    text = turtleUp ? "60分順勢空，但4小時海龜仍偏多：方向衝突，等海龜翻空或60分轉強再說" : "順勢空：只找空單，反彈到關羽（MA60）不過是進場區，站上張飛（MA20）停利";
  } else if (sw.confirmed === "BOUNCE_LONG") {
    side = "短多";
    text = "短打反彈多：劉備仍在上方壓著，目標看劉備（MA240）附近，跌破張飛（MA20）就收";
  } else if (sw.confirmed === "PULLBACK_SHORT") {
    side = "短空";
    text = "修正空：大方向仍多，只做回檔段，目標看劉備（MA240）附近，站上張飛（MA20）就收";
  } else text = "60分K 資料不足，暫不判斷";
  return { side, text, mode: m };
}

/**
 * 三刀流回測：每次「狀態切換」（60分K收盤後進入新狀態），之後 horizon 根 60分K 往該方向走了多少。
 * 多方狀態看漲、空方狀態看跌。只用同一合約的已完成 K 棒。
 */
export function swordStudy(contracts, { horizon = 4 } = {}) {
  const tally = {};
  for (const C of contracts) {
    const h1 = aggregate(C.bars15, 60).filter(b => !b.partial);
    const closes = h1.map(b => b.c);
    let prev = null;
    for (let i = 240; i < h1.length - horizon; i += 1) {
      const c = closes.slice(0, i + 1);
      const m = modeOf(h1[i].c, smaLast(c, 60), smaLast(c, 240));
      if (m !== prev && prev !== null) {
        const dir = m === "TREND_LONG" || m === "BOUNCE_LONG" ? 1 : -1;
        const move = (h1[i + horizon].c - h1[i].c) * dir;
        const t = tally[m] ?? (tally[m] = { n: 0, win: 0, sum: 0 });
        t.n += 1; t.sum += move; if (move > 0) t.win += 1;
      }
      prev = m;
    }
  }
  const out = {};
  for (const [k, t] of Object.entries(tally)) out[k] = { n: t.n, winRate: t.n ? t.win / t.n : null, avgMove: t.n ? t.sum / t.n : null, horizon };
  return out;
}
