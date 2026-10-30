// 使用者自己的 TradingView 指標，逐行照 Pine 原始碼移植：
// 1.「微台 Pro Sniper 融合系統 v2.4.1」（預設參數、進場模式＝狙擊融合）
// 2.「洗盤偵測支撐壓力」
import { aggregate } from "./bars.js";
import { ema, rma, sma, stdev, highest, lowest, sum, change, rsi, macd, dmi, supertrend, atr, pivotHigh, pivotLow, crossover, crossunder } from "./pine.js";

const nn = v => v != null && Number.isFinite(v);

export const SNIPER_DEFAULTS = {
  fastLen: 10, slowLen: 20, htfMinutes: 60, slopeLen: 2,
  chopLen: 14, trendChopMax: 48, rangeChopMin: 61.8, diLen: 14, adxSmooth: 14, adxMin: 20, rangeAdxMax: 15, atrLen: 14, minSepAtr: 0.1,
  avoidStrongRange: true, rangeLen: 12,
  erLen: 10, erMin: 0.25, earlyChopMax: 55, kamaFast: 2, kamaSlow: 30, squeezeLen: 20, bbMult: 2, kcMult: 1.5,
  stAtrPeriod: 10, stAtrMult: 3,
  useSmartExit: true, minProfitAtr: 0.8, exitScoreMin: 2, rsiLen: 14, rsiOB: 70, rsiOS: 30, pivotLen: 3, srZoneAtr: 0.25, wickRatio: 0.35,
};

function tr(h, l, c) {
  return h.map((_, i) => (i === 0 ? null : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
}
function chopOf(h, l, c, len) {
  const t = tr(h, l, c), s = sum(t, len), hi = highest(h, len), lo = lowest(l, len);
  return h.map((_, i) => {
    if (s[i] == null || hi[i] == null) return null;
    const range = hi[i] - lo[i];
    return range > 0 ? (100 * Math.log10(s[i] / range)) / Math.log10(len) : 100;
  });
}

/**
 * bars: 已完成的 K 棒（建議 5 分K）；回傳逐根狀態、訊號列表、最後一根的儀表板
 */
export function proSniper(bars, cfg = {}) {
  const P = { ...SNIPER_DEFAULTS, ...cfg };
  const n = bars.length;
  const O = bars.map(b => b.o), H = bars.map(b => b.h), L = bars.map(b => b.l), C = bars.map(b => b.c);
  const T = tr(H, L, C);
  const emaFast = ema(C, P.fastLen), emaSlow = ema(C, P.slowLen);
  const atrS = rma(T, P.atrLen);
  const { plus: diP, minus: diM, adx } = dmi(H, L, C, P.diLen, P.adxSmooth);
  const { st, dir } = supertrend(H, L, C, P.stAtrMult, P.stAtrPeriod);
  const chop = chopOf(H, L, C, P.chopLen);
  const absCh = change(C).map(v => (v == null ? null : Math.abs(v)));
  const erVol = sum(absCh, P.erLen);
  const er = C.map((c, i) => (nn(erVol[i]) && erVol[i] > 0 && i >= P.erLen ? Math.abs(c - C[i - P.erLen]) / erVol[i] : 0));
  const fastSC = 2 / (P.kamaFast + 1), slowSC = 2 / (P.kamaSlow + 1);
  const kama = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const sc = (er[i] * (fastSC - slowSC) + slowSC) ** 2;
    kama[i] = i === 0 ? C[i] : kama[i - 1] + sc * (C[i] - kama[i - 1]);
  }
  const sqBasis = sma(C, P.squeezeLen), bbDev = stdev(C, P.squeezeLen).map(v => (v == null ? null : v * P.bbMult));
  const kc = rma(T, P.squeezeLen).map(v => (v == null ? null : v * P.kcMult));
  const squeezeOn = C.map((_, i) => nn(bbDev[i]) && nn(kc[i]) && sqBasis[i] + bbDev[i] < sqBasis[i] + kc[i] && sqBasis[i] - bbDev[i] > sqBasis[i] - kc[i]);
  const atrSma5 = sma(atrS, 5);
  const volExp = C.map((_, i) => (!squeezeOn[i] && i > 0 && squeezeOn[i - 1]) || (nn(atrS[i]) && nn(atrSma5[i]) && atrS[i] > atrSma5[i] && i > 0 && nn(atrS[i - 1]) && atrS[i] > atrS[i - 1]));
  const rsiV = rsi(C, P.rsiLen);
  const { hist } = macd(C, 12, 26, 9);
  const ph = pivotHigh(H, P.pivotLen, P.pivotLen), pl = pivotLow(L, P.pivotLen, P.pivotLen);

  // 高週期（預設 60 分）：用「前一根已完成的高週期K」數值，不重繪
  const htfBars = aggregate(bars, P.htfMinutes);
  const hC = htfBars.map(b => b.c), hFast = ema(hC, P.fastLen), hSlow = ema(hC, P.slowLen);
  const htfIdx = []; // 每根 K 對應到哪一根高週期K
  { let k = 0; for (const b of bars) { while (k + 1 < htfBars.length && htfBars[k + 1].t <= b.t) k += 1; htfIdx.push(k); } }

  const rangeHi = highest(H, P.rangeLen), rangeLo = lowest(L, P.rangeLen);
  const redTurn = crossover(emaFast, emaSlow), greenTurn = crossunder(emaFast, emaSlow);
  const kamaCrossDn = crossunder(C, kama), kamaCrossUp = crossover(C, kama);

  let lastRes = null, lastSup = null, pending = 0, pos = 0, entryPx = null, entryAtr = null, entryBar = null;
  const signals = [], rows = [];
  for (let i = 0; i < n; i += 1) {
    if (nn(ph[i])) lastRes = ph[i];
    if (nn(pl[i])) lastSup = pl[i];
    const k = htfIdx[i] - 1;
    const hf = k >= 0 ? hFast[k] : null, hs = k >= 0 ? hSlow[k] : null, hsp = k - P.slopeLen >= 0 ? hSlow[k - P.slopeLen] : null;
    const htfBull = nn(hf) && nn(hs) && nn(hsp) && hf > hs && hs > hsp;
    const htfBear = nn(hf) && nn(hs) && nn(hsp) && hf < hs && hs < hsp;
    const slowPast = i >= P.slopeLen ? emaSlow[i - P.slopeLen] : null;
    const localBull = nn(emaFast[i]) && nn(emaSlow[i]) && nn(slowPast) && emaFast[i] > emaSlow[i] && emaSlow[i] > slowPast;
    const localBear = nn(emaFast[i]) && nn(emaSlow[i]) && nn(slowPast) && emaFast[i] < emaSlow[i] && emaSlow[i] < slowPast;
    const sep = nn(atrS[i]) && Math.abs(emaFast[i] - emaSlow[i]) >= atrS[i] * P.minSepAtr;
    const trendMarket = nn(chop[i]) && chop[i] <= P.trendChopMax && nn(adx[i]) && adx[i] >= P.adxMin && sep;
    const rangeMarket = nn(chop[i]) && chop[i] >= P.rangeChopMin && nn(adx[i]) && adx[i] <= P.rangeAdxMax;
    const prevRange = rows[i - 1]?.rangeMarket ?? false;
    const rHi = i > 0 ? rangeHi[i - 1] : null, rLo = i > 0 ? rangeLo[i - 1] : null;
    const breakLong = nn(rHi) && C[i] > rHi && i > 1 && C[i - 1] <= rangeHi[i - 2];
    const breakShort = nn(rLo) && C[i] < rLo && i > 1 && C[i - 1] >= rangeLo[i - 2];
    const kamaUp = i > 0 && kama[i] > kama[i - 1], kamaDn = i > 0 && kama[i] < kama[i - 1];
    const stBull = dir[i] != null && dir[i] < 0, stBear = dir[i] != null && dir[i] > 0;
    const dch = i > 0 && dir[i] != null && dir[i - 1] != null ? dir[i] - dir[i - 1] : 0;
    const stLongFlip = dch < 0, stShortFlip = dch > 0;
    if (stLongFlip) pending = 1;
    if (stShortFlip) pending = -1;
    const momentum = er[i] >= P.erMin || volExp[i];
    const sniperLongState = stBull && !rangeMarket && kamaUp && diP[i] > diM[i] && momentum;
    const sniperShortState = stBear && !rangeMarket && kamaDn && diM[i] > diP[i] && momentum;
    const sniperLong = pending === 1 && sniperLongState, sniperShort = pending === -1 && sniperShortState;
    if (sniperLong || sniperShort) pending = 0;
    const earlyLongState = C[i] > kama[i] && kamaUp && er[i] >= P.erMin && i > 0 && er[i] > er[i - 1] && nn(chop[i]) && chop[i] < P.earlyChopMax && diP[i] > diM[i];
    const earlyShortState = C[i] < kama[i] && kamaDn && er[i] >= P.erMin && i > 0 && er[i] > er[i - 1] && nn(chop[i]) && chop[i] < P.earlyChopMax && diM[i] > diP[i];
    const regimeOK = !P.avoidStrongRange || !rangeMarket;
    const longEntry = sniperLong && regimeOK && pos !== 1;
    const shortEntry = sniperShort && regimeOK && pos !== -1;
    const rangeExit = pos !== 0 && rangeMarket && !prevRange;
    const bar = bars[i];
    if (rangeExit) { signals.push({ i, t: bar.end, type: "RANGE_EXIT", label: "盤整出場", price: C[i], from: pos }); pos = 0; entryPx = entryAtr = entryBar = null; }
    if (longEntry) { pos = 1; entryPx = C[i]; entryAtr = atrS[i]; entryBar = i; signals.push({ i, t: bar.end, type: "LONG", label: "Sniper多方進場", price: C[i] }); }
    if (shortEntry) { pos = -1; entryPx = C[i]; entryAtr = atrS[i]; entryBar = i; signals.push({ i, t: bar.end, type: "SHORT", label: "Sniper空方進場", price: C[i] }); }
    const range = Math.max(H[i] - L[i], 1);
    const upperWick = H[i] - Math.max(O[i], C[i]), lowerWick = Math.min(O[i], C[i]) - L[i];
    const resReject = lastRes != null && nn(atrS[i]) && H[i] >= lastRes - atrS[i] * P.srZoneAtr && C[i] < lastRes && upperWick / range >= P.wickRatio;
    const supReject = lastSup != null && nn(atrS[i]) && L[i] <= lastSup + atrS[i] * P.srZoneAtr && C[i] > lastSup && lowerWick / range >= P.wickRatio;
    const longExitScore = (rsiV[i] >= P.rsiOB && rsiV[i] < rsiV[i - 1] ? 1 : 0) + (hist[i] > 0 && hist[i] < hist[i - 1] ? 1 : 0) + (resReject ? 1 : 0) + (kamaCrossDn[i] || kamaDn ? 1 : 0) + (greenTurn[i] ? 2 : 0) + (stShortFlip ? 2 : 0);
    const shortExitScore = (rsiV[i] <= P.rsiOS && rsiV[i] > rsiV[i - 1] ? 1 : 0) + (hist[i] < 0 && hist[i] > hist[i - 1] ? 1 : 0) + (supReject ? 1 : 0) + (kamaCrossUp[i] || kamaUp ? 1 : 0) + (redTurn[i] ? 2 : 0) + (stLongFlip ? 2 : 0);
    const longTP = P.useSmartExit && pos === 1 && entryPx != null && C[i] >= entryPx + entryAtr * P.minProfitAtr && i > entryBar && longExitScore >= P.exitScoreMin;
    const shortTP = P.useSmartExit && pos === -1 && entryPx != null && C[i] <= entryPx - entryAtr * P.minProfitAtr && i > entryBar && shortExitScore >= P.exitScoreMin;
    if (longTP || shortTP) { signals.push({ i, t: bar.end, type: longTP ? "LONG_TP" : "SHORT_TP", label: longTP ? "多單停利出場" : "空單停利出場", price: C[i], from: pos }); pos = 0; entryPx = entryAtr = entryBar = null; }
    rows.push({
      t: bar.t, rangeMarket, trendMarket, htfBull, htfBear, localBull, localBear, breakLong, breakShort,
      sniperLongState, sniperShortState, earlyLongState, earlyShortState, stBull, squeezeOn: squeezeOn[i], er: er[i], kamaUp,
      adx: adx[i], chop: chop[i], longExitScore, shortExitScore, pos, entryPx,
      action: longTP ? "多單停利" : shortTP ? "空單停利" : longEntry ? "狙擊多" : shortEntry ? "狙擊空" : rangeExit ? "盤整出場" : trendMarket ? "等待訊號" : "暫停交易",
      superTrend: st[i], emaFast: emaFast[i], kama: kama[i], lastRes, lastSup, rangeHigh: rHi, rangeLow: rLo,
    });
  }
  const last = rows.at(-1) ?? null;
  const dash = last && {
    market: last.rangeMarket ? "盤整／退出" : last.trendMarket ? "趨勢盤" : "過渡／等待",
    htf: last.htfBull ? "偏多 ↑" : last.htfBear ? "偏空 ↓" : "中性",
    local: last.localBull ? "多頭排列" : last.localBear ? "空頭排列" : "均線糾結",
    sniper: last.sniperLongState ? "狙擊多方" : last.sniperShortState ? "狙擊空方" : last.stBull ? "多方待命" : "空方待命",
    adxChop: `${nn(last.adx) ? last.adx.toFixed(1) : "—"} / ${nn(last.chop) ? last.chop.toFixed(1) : "—"}`,
    action: last.action,
    exitScores: `${last.longExitScore}／${last.shortExitScore}`,
    position: last.pos === 1 ? "持有多單" : last.pos === -1 ? "持有空單" : "空手",
    entryPx: last.entryPx,
    superTrend: last.superTrend, redGreenLine: last.emaFast, kama: last.kama,
    resistance: last.lastRes, support: last.lastSup,
  };
  return { rows, signals, dash, trades: tradesFrom(signals, bars) };
}

/** 訊號 → 每筆交易（進場到出場或反手）的點數 */
export function tradesFrom(signals, bars) {
  const trades = [];
  let open = null;
  for (const s of signals) {
    if (s.type === "LONG" || s.type === "SHORT") {
      if (open) trades.push(close(open, s, "反手"));
      open = { side: s.type === "LONG" ? 1 : -1, entry: s.price, t: s.t };
    } else if (open) {
      trades.push(close(open, s, s.label));
      open = null;
    }
  }
  const lastBar = bars.at(-1);
  return { closed: trades, open: open && lastBar ? { ...open, mark: lastBar.c, pnl: (lastBar.c - open.entry) * open.side } : null };
  function close(o, s, why) { return { side: o.side, entry: o.entry, exit: s.price, t0: o.t, t1: s.t, pnl: (s.price - o.entry) * o.side, why }; }
}

export function tradeSummary(trades) {
  const c = trades.closed;
  if (!c.length) return null;
  const wins = c.filter(t => t.pnl > 0);
  return { n: c.length, winRate: wins.length / c.length, total: c.reduce((s, t) => s + t.pnl, 0), avg: c.reduce((s, t) => s + t.pnl, 0) / c.length, best: Math.max(...c.map(t => t.pnl)), worst: Math.min(...c.map(t => t.pnl)) };
}

/** 洗盤偵測支撐壓力 */
export function washout(bars, { bbLen = 20, bbMult = 2, chopLen = 14, chopThresh = 50, srLen = 10 } = {}) {
  const H = bars.map(b => b.h), L = bars.map(b => b.l), C = bars.map(b => b.c);
  const mid = sma(C, bbLen), dev = stdev(C, bbLen);
  const upper = mid.map((m, i) => (m == null ? null : m + bbMult * dev[i])), lower = mid.map((m, i) => (m == null ? null : m - bbMult * dev[i]));
  const ci = chopOf(H, L, C, chopLen);
  const hh = highest(H, srLen * 2 + 1), ll = lowest(L, srLen * 2 + 1);
  let res1 = null, res2 = null, sup1 = null, sup2 = null;
  const marks = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i >= srLen && hh[i] != null && H[i - srLen] === hh[i]) { res2 = res1; res1 = H[i - srLen]; }
    if (i >= srLen && ll[i] != null && L[i - srLen] === ll[i]) { sup2 = sup1; sup1 = L[i - srLen]; }
    const choppy = ci[i] != null && ci[i] > chopThresh;
    if (choppy && upper[i] != null && H[i] > upper[i] && C[i] < upper[i]) marks.push({ t: bars[i].end, type: "TOP", label: "洗盤誘多（偏空）", price: H[i] });
    if (choppy && lower[i] != null && L[i] < lower[i] && C[i] > lower[i]) marks.push({ t: bars[i].end, type: "BOTTOM", label: "洗盤誘空（偏多）", price: L[i] });
  }
  const c = C.at(-1), lastCi = ci.at(-1);
  const tag = (price, isRes) => (price == null ? null : isRes ? (c > price ? "壓轉撐" : "壓力") : (c < price ? "撐轉壓" : "支撐"));
  return {
    state: lastCi != null && lastCi > chopThresh ? "震盪中" : "趨勢中",
    chop: lastCi,
    res1, res2, sup1, sup2,
    res1Status: res1 == null ? null : c > res1 ? "突破站穩" : "承壓",
    sup1Status: sup1 == null ? null : c < sup1 ? "跌破失守" : "支撐",
    lines: [
      { price: res2, tag: tag(res2, true), main: false }, { price: res1, tag: tag(res1, true), main: true },
      { price: sup1, tag: tag(sup1, false), main: true }, { price: sup2, tag: tag(sup2, false), main: false },
    ].filter(x => x.price != null),
    bbUpper: upper.at(-1), bbLower: lower.at(-1),
    marks: marks.slice(-10),
  };
}

/** 加權移動平均（Pine ta.wma） */
function wmaArr(src, n) {
  const den = (n * (n + 1)) / 2;
  return src.map((_, i) => {
    if (i < n - 1) return null;
    let a = 0;
    for (let k = 0; k < n; k += 1) a += src[i - k] * (n - k);
    return a / den;
  });
}

/**
 * 傑哥「台指期戰神」通道（近似版，用截圖數值反推，誤差約 1～3 點）：
 * 上軌＝最高價 WMA24、中軌＝收盤 WMA20、下軌＝最低價 WMA24。
 * 方向：收盤穿出上軌→偏多、跌破下軌→偏空，沒穿出對側就維持原方向。
 */
/** 追價濾網：近 W 根 5 分K 的效率＝淨走幅 ÷ 來回總走幅（0＝來回震盪，1＝一路單邊）
 *  回測 9/2～10/30 微台（傑哥翻向＋吊燈過濾，每筆扣 5 點）：效率 ≥ 0.2 時才翻向的單（＝追已經走一段的）拿掉後，
 *  移動停利 180：−131 → +1,971 點、最大回落 −2,037 → −855；140：+926 → +2,093。門檻 0.15～0.5、看 1～2 小時都有改善。 */
export const CHASE_ER = 0.2, CHASE_BARS = 24;
export function effRatio(C, i, w = CHASE_BARS) {
  if (i < w) return null;
  let s = 0;
  for (let k = i - w + 1; k <= i; k += 1) s += Math.abs(C[k] - C[k - 1]);
  return s ? Math.abs(C[i] - C[i - w]) / s : 0;
}
export function zhanshenBand(bars, { upLen = 24, midLen = 20, loLen = 24, confirm = 2 } = {}) {
  const H = bars.map(b => b.h), L = bars.map(b => b.l), C = bars.map(b => b.c);
  const up = wmaArr(H, upLen), mid = wmaArr(C, midLen), lo = wmaArr(L, loLen);
  // 收盤連續 confirm 根都收在帶狀另一側才翻向（實測跟傑哥 10/16、10/19 共 10 筆訊號的方向與筆數一致）
  let dir = 0, since = null, flipPrice = null, flipEr = null, pend = 0, cnt = 0;
  const flips = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (up[i] == null) continue;
    const raw = C[i] > up[i] ? 1 : C[i] < lo[i] ? -1 : 0;
    // 收在對側就累計；收回原方向那一側才歸零；留在帶狀裡面不歸零（照實測最吻合傑哥的規則）
    if (raw !== 0 && raw !== dir) { pend = raw; cnt += 1; }
    else if (raw !== 0 && raw === dir) { pend = 0; cnt = 0; }
    if (pend && cnt >= confirm) {
      if (dir !== 0) flips.push({ t: bars[i].end, side: pend, price: C[i], er: effRatio(C, i) });
      dir = pend; since = bars[i].end; flipPrice = C[i]; flipEr = effRatio(C, i); pend = 0; cnt = 0;
    }
  }
  const i = bars.length - 1;
  return { dir, since, flipPrice, flipEr, erNow: effRatio(C, i), pending: pend ? { side: pend, count: cnt, need: confirm } : null, up: up[i], mid: mid[i], lo: lo[i], close: C[i], flips: flips.slice(-30) };
}

/**
 * 吊燈出場 Chandelier Exit（Alex Elder 提出；TradingView 熱門版本 by everget）
 * 多方停損＝近 n 根最高收盤 − m×ATR；空方停損＝近 n 根最低收盤 + m×ATR（只往有利方向移動）
 * 收盤突破空方停損＝翻多；跌破多方停損＝翻空。用 60 分K（回測時 5 分／15 分都被洗到虧）。
 */
export function chandelierExit(bars, { n = 22, m = 3 } = {}) {
  const H = bars.map(b => b.h), L = bars.map(b => b.l), C = bars.map(b => b.c);
  const a = atr(H, L, C, n), hh = highest(C, n), ll = lowest(C, n);
  let dir = 0, ls = null, ss = null, since = null, flipPrice = null;
  const flips = [];
  for (let i = 0; i < C.length; i += 1) {
    if (a[i] == null || hh[i] == null) continue;
    let l = hh[i] - m * a[i], s = ll[i] + m * a[i];
    const pl = ls ?? l, ps = ss ?? s;
    if (i > 0 && C[i - 1] > pl) l = Math.max(l, pl);
    if (i > 0 && C[i - 1] < ps) s = Math.min(s, ps);
    const nd = C[i] > ps ? 1 : C[i] < pl ? -1 : dir || (C[i] >= (l + s) / 2 ? 1 : -1);
    if (nd !== dir) {
      if (dir !== 0) flips.push({ t: bars[i].end, side: nd, price: C[i] });
      dir = nd; since = bars[i].end; flipPrice = C[i];
    }
    ls = l; ss = s;
  }
  const i = bars.length - 1;
  return { dir, since, flipPrice, longStop: ls, shortStop: ss, close: C[i], lastEnd: bars[i]?.end, flips: flips.slice(-8), n, m };
}
