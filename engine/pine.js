// TradingView Pine 內建函式的 JavaScript 版本（照 Pine v5/v6 的定義），全部輸入陣列、輸出等長陣列，na 用 null。
const isNum = v => v != null && Number.isFinite(v);

export function sma(src, len) {
  const out = new Array(src.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < src.length; i += 1) {
    sum += src[i] ?? 0; cnt += isNum(src[i]) ? 1 : 0;
    if (i >= len) { sum -= src[i - len] ?? 0; cnt -= isNum(src[i - len]) ? 1 : 0; }
    if (i >= len - 1 && cnt === len) out[i] = sum / len;
  }
  return out;
}

/** Pine 的 ema/rma：第一個值是前 len 根的 SMA，之後遞迴 */
function smoothed(src, len, alpha) {
  const out = new Array(src.length).fill(null);
  let prev = null;
  const seed = sma(src, len);
  for (let i = 0; i < src.length; i += 1) {
    if (prev == null) { if (isNum(seed[i])) prev = seed[i]; out[i] = prev; continue; }
    if (!isNum(src[i])) { out[i] = prev; continue; }
    prev = alpha * src[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}
export const ema = (src, len) => smoothed(src, len, 2 / (len + 1));
export const rma = (src, len) => smoothed(src, len, 1 / len);

/** 母體標準差（Pine ta.stdev 預設 biased=true） */
export function stdev(src, len) {
  const m = sma(src, len);
  return src.map((_, i) => {
    if (m[i] == null) return null;
    let s = 0;
    for (let j = i - len + 1; j <= i; j += 1) s += (src[j] - m[i]) ** 2;
    return Math.sqrt(s / len);
  });
}

export function highest(src, len) {
  return src.map((_, i) => (i < len - 1 ? null : Math.max(...src.slice(i - len + 1, i + 1))));
}
export function lowest(src, len) {
  return src.map((_, i) => (i < len - 1 ? null : Math.min(...src.slice(i - len + 1, i + 1))));
}
export function sum(src, len) {
  return src.map((_, i) => (i < len - 1 ? null : src.slice(i - len + 1, i + 1).reduce((a, b) => a + (b ?? NaN), 0))).map(v => (Number.isFinite(v) ? v : null));
}
export const change = (src, n = 1) => src.map((v, i) => (i < n || !isNum(v) || !isNum(src[i - n]) ? null : v - src[i - n]));
export const shift = (src, n = 1) => src.map((_, i) => (i - n >= 0 && i - n < src.length ? src[i - n] : null));

/** 真實區間；第一根沒有前收，用高減低 */
export function trueRange(h, l, c) {
  return h.map((_, i) => (i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
}
/** ta.atr 內部的 tr 第一根是 na */
function trNa(h, l, c) {
  return h.map((_, i) => (i === 0 ? null : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
}
export const atr = (h, l, c, len) => rma(trNa(h, l, c), len);

export function rsi(src, len) {
  const ch = change(src);
  const up = rma(ch.map(v => (v == null ? null : Math.max(v, 0))), len);
  const dn = rma(ch.map(v => (v == null ? null : Math.max(-v, 0))), len);
  return src.map((_, i) => (up[i] == null || dn[i] == null ? null : dn[i] === 0 ? 100 : up[i] === 0 ? 0 : 100 - 100 / (1 + up[i] / dn[i])));
}

export function macd(src, fast = 12, slow = 26, sig = 9) {
  const f = ema(src, fast), s = ema(src, slow);
  const line = src.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const firstIdx = line.findIndex(v => v != null);
  const sigArr = new Array(src.length).fill(null);
  if (firstIdx >= 0) {
    const part = ema(line.slice(firstIdx), sig);
    part.forEach((v, k) => { sigArr[firstIdx + k] = v; });
  }
  const hist = line.map((v, i) => (v == null || sigArr[i] == null ? null : v - sigArr[i]));
  return { line, signal: sigArr, hist };
}

/** ta.dmi(diLength, adxSmoothing) */
export function dmi(h, l, c, diLen, adxLen) {
  const up = change(h), down = change(l).map(v => (v == null ? null : -v));
  const plusDM = up.map((u, i) => (u == null ? null : u > down[i] && u > 0 ? u : 0));
  const minusDM = down.map((d, i) => (d == null ? null : d > up[i] && d > 0 ? d : 0));
  const tr = rma(trNa(h, l, c), diLen);
  const p = rma(plusDM, diLen), m = rma(minusDM, diLen);
  const plus = h.map((_, i) => (tr[i] ? (100 * p[i]) / tr[i] : null));
  const minus = h.map((_, i) => (tr[i] ? (100 * m[i]) / tr[i] : null));
  const dx = h.map((_, i) => (plus[i] == null || minus[i] == null ? null : Math.abs(plus[i] - minus[i]) / (plus[i] + minus[i] === 0 ? 1 : plus[i] + minus[i])));
  const adx = rma(dx, adxLen).map(v => (v == null ? null : 100 * v));
  return { plus, minus, adx };
}

/** ta.supertrend(factor, atrPeriod)：direction -1 = 多方（線在下）、1 = 空方 */
export function supertrend(h, l, c, factor, period) {
  const a = atr(h, l, c, period);
  const st = new Array(c.length).fill(null), dir = new Array(c.length).fill(null);
  let pu = null, pl = null, pst = null;
  for (let i = 0; i < c.length; i += 1) {
    const src = (h[i] + l[i]) / 2;
    if (a[i] == null) { continue; }
    let upper = src + factor * a[i], lower = src - factor * a[i];
    const prevLower = pl ?? 0, prevUpper = pu ?? 0;
    lower = lower > prevLower || c[i - 1] < prevLower ? lower : prevLower;
    upper = upper < prevUpper || c[i - 1] > prevUpper ? upper : prevUpper;
    let d;
    if (a[i - 1] == null) d = 1;
    else if (pst === prevUpper) d = c[i] > upper ? -1 : 1;
    else d = c[i] < lower ? 1 : -1;
    const s = d === -1 ? lower : upper;
    st[i] = s; dir[i] = d;
    pu = upper; pl = lower; pst = s;
  }
  return { st, dir };
}

/** ta.pivothigh / pivotlow：在 i 時回報 i-right 那根（右側確認後才出現） */
export function pivotHigh(src, left, right) {
  const out = new Array(src.length).fill(null);
  for (let i = left + right; i < src.length; i += 1) {
    const p = i - right, v = src[p];
    let ok = true;
    for (let j = p - left; j <= p + right && ok; j += 1) if (j !== p && (j < p ? src[j] >= v : src[j] > v)) ok = false;
    if (ok) out[i] = v;
  }
  return out;
}
export function pivotLow(src, left, right) {
  const out = new Array(src.length).fill(null);
  for (let i = left + right; i < src.length; i += 1) {
    const p = i - right, v = src[p];
    let ok = true;
    for (let j = p - left; j <= p + right && ok; j += 1) if (j !== p && (j < p ? src[j] <= v : src[j] < v)) ok = false;
    if (ok) out[i] = v;
  }
  return out;
}

export const crossover = (a, b) => a.map((_, i) => i > 0 && isNum(a[i]) && isNum(b[i]) && isNum(a[i - 1]) && isNum(b[i - 1]) && a[i] > b[i] && a[i - 1] <= b[i - 1]);
export const crossunder = (a, b) => a.map((_, i) => i > 0 && isNum(a[i]) && isNum(b[i]) && isNum(a[i - 1]) && isNum(b[i - 1]) && a[i] < b[i] && a[i - 1] >= b[i - 1]);
