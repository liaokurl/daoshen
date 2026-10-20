// 前低第二支腳：價格回到前一個波段低點附近、而且 K 棒收盤守住 → 偏多訊號
// 回測（9/2～10/21 微台）：60 分K 守住後反彈的比例 79～87%，隨機價位只有 50～64%；30 分K 優勢較小（+11～18%）
// 前高「第二次過不去」在各週期都看不出優勢，所以只做前低。

export const SWING_DEFAULTS = { piv: 3, look: 60, tol: 0.3, stopAtr: 0.5, trailAtr: 2 };

function atrOf(bars, n = 14) {
  const tr = bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l));
  return tr.map((_, i) => (i < n ? null : tr.slice(i - n + 1, i + 1).reduce((a, x) => a + x, 0) / n));
}

/**
 * bars：已收完的 K 棒（{t,end,o,h,l,c}）
 * 回傳 lows：目前還沒被跌破的前低；signals：歷史上每次「回測前低且收盤守住」；last：最後一根是否剛好觸發
 */
export function swingLows(bars, cfg = {}) {
  const P = { ...SWING_DEFAULTS, ...cfg };
  const N = bars.length, A = atrOf(bars);
  const H = bars.map(b => b.h), L = bars.map(b => b.l), C = bars.map(b => b.c);
  const pivots = [];
  for (let i = P.piv; i < N - P.piv; i += 1) {
    let ok = true;
    for (let k = i - P.piv; k <= i + P.piv; k += 1) if (k !== i && L[k] < L[i]) { ok = false; break; }
    if (ok) pivots.push({ i, price: L[i], t: bars[i].end, confirmed: i + P.piv });
  }
  const signals = [];
  const state = pivots.map(p => ({ ...p, broken: false, touched: false }));
  for (let j = 0; j < N; j += 1) {
    const a = A[j];
    if (!a) continue;
    const tol = P.tol * a;
    for (const p of state) {
      if (p.broken || p.touched || j <= p.confirmed || j - p.i > P.look) continue;
      if (L[j] < p.price - tol) { p.broken = true; continue; }
      if (L[j] <= p.price + tol) {
        p.touched = true;
        if (C[j] > p.price) signals.push({ t: bars[j].end, j, level: p.price, low: L[j], close: C[j], stop: p.price - P.stopAtr * a, trail: P.trailAtr * a, atr: a, from: p.t });
      }
    }
  }
  const i = N - 1, lastA = A[i];
  const lows = state
    .filter(p => !p.broken && !p.touched && i - p.i <= P.look && i > p.confirmed)
    .map(p => ({ price: p.price, t: p.t, dist: C[i] - p.price, near: lastA ? (C[i] - p.price) <= 1.5 * lastA : false }))
    .sort((x, y) => y.price - x.price);
  // 回測結果：每個訊號之後，先 +1.5ATR（守住）還是先 −1ATR（失敗）
  for (const s of signals) {
    s.result = null;
    for (let k = s.j + 1; k < N; k += 1) {
      if (L[k] < s.level - s.atr) { s.result = -1; break; }
      if (H[k] >= s.level + 1.5 * s.atr) { s.result = 1; break; }
    }
  }
  return { lows, signals, last: signals.at(-1)?.j === i ? signals.at(-1) : null, atr: lastA, close: C[i] };
}
