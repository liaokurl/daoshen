// 指標：SMA、ATR、斜率、擺盪高低點。全部只用傳入的（已完成）K 棒，不偷看未來。

export function mean(values) {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** 最後一根的 SMA（含最後一根）；不足 n 根回 null */
export function smaLast(closes, n, offset = 0) {
  const end = closes.length - offset;
  if (end < n || end <= 0) return null;
  return mean(closes.slice(end - n, end));
}

/** 整條 SMA 序列（前 n-1 根為 null） */
export function smaSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  let s = 0;
  for (let i = 0; i < closes.length; i += 1) {
    s += closes[i];
    if (i >= n) s -= closes[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/**
 * 「下一根收盤要站上多少，收盤後的 SMA 才會被收盤價超過」
 * close > (sum(前 n-1 根) + close) / n  ⇔  close > mean(前 n-1 根)
 * 這是精確門檻，不是近似值。
 */
export function closeThreshold(closes, n) {
  if (closes.length < n - 1 || n < 2) return null;
  return mean(closes.slice(closes.length - (n - 1)));
}

/** 平均真實區間（簡單平均） */
export function atr(bars, n = 14) {
  if (bars.length < 2) return null;
  const trs = [];
  for (let i = Math.max(1, bars.length - n); i < bars.length; i += 1) {
    const b = bars[i], pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  return mean(trs);
}

export function atrSeries(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  const trs = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
  let s = 0;
  for (let i = 0; i < trs.length; i += 1) {
    s += trs[i];
    if (i >= n) s -= trs[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/**
 * 均線方向：比較現在與 lookback 根前的 SMA，每根變化量相對 ATR。
 * |每根變化| < flatAtr × ATR → 走平
 */
export function slopeOf(closes, n, { lookback = 5, flatAtr = 0.03, atrValue = null } = {}) {
  const now = smaLast(closes, n), before = smaLast(closes, n, lookback);
  if (now == null || before == null || !atrValue) return { dir: "INSUFFICIENT", perBar: null };
  const perBar = (now - before) / lookback;
  const dir = Math.abs(perBar) < flatAtr * atrValue ? "FLAT" : perBar > 0 ? "RISING" : "FALLING";
  return { dir, perBar };
}

/**
 * 擺盪低點／高點：左 left 根、右 right 根都比它高（低）才成立，
 * 而且右側 right 根都必須是已完成 K 棒才算確認。回傳依時間排序。
 */
export function swings(bars, { left = 2, right = 2 } = {}) {
  const lows = [], highs = [];
  for (let i = left; i < bars.length - right; i += 1) {
    const b = bars[i];
    let isLow = true, isHigh = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      const o = bars[j];
      if (j < i ? !(o.l > b.l) : !(o.l >= b.l)) isLow = false;
      if (j < i ? !(o.h < b.h) : !(o.h <= b.h)) isHigh = false;
    }
    const confirmedAt = bars[i + right].end;
    if (isLow) lows.push({ price: b.l, t: b.t, confirmedAt, index: i });
    if (isHigh) highs.push({ price: b.h, t: b.t, confirmedAt, index: i });
  }
  return { lows, highs };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
