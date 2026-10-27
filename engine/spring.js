// 破底翻（Spring）：先有一個低點 → 跌破它 → 拉回站上 → 往上走一段 → 回測那個低點不破 → 偏多訊號
// 用在 5／15／30 分K。所有門檻用 ATR 計，換週期不用改參數。

export const SPRING_DEFAULTS = {
  piv: 3,          // 低點：左右各 piv 根都沒有更低
  look: 80,        // 低點最多往回找幾根
  breakAtr: 0.1,   // 跌破：最低價 < 低點 − 0.1 ATR
  reclaimBars: 12, // 跌破後幾根內要收盤站回低點上方
  rallyAtr: 1.0,   // 站回後要先往上走到 低點 + 1 ATR（「往上」）
  retestAtr: 0.35, // 回測：最低價回到 低點 + 0.35 ATR 以內
  retestBars: 40,  // 站回後幾根內要出現回測
};

function atrOf(bars, n = 14) {
  const tr = bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l));
  const out = new Array(bars.length).fill(null);
  let a = null;
  for (let i = 0; i < tr.length; i += 1) {
    if (i < n - 1) continue;
    a = a == null ? tr.slice(0, n).reduce((s, x) => s + x, 0) / n : (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

/**
 * bars：已收完的 K 棒 {t,end,o,h,l,c}
 * 回傳 signals（每次回測不破的那根）、watch（正在形成中的型態，給 App 顯示）、last（最後一根剛好觸發）
 * 訊號欄位：level＝被跌破又站回的低點（支撐）、low2＝破底的最低點、stop＝最低點下方、target＝N 字等幅
 */
export function springs(bars, cfg = {}) {
  const P = { ...SPRING_DEFAULTS, ...cfg };
  const N = bars.length, A = atrOf(bars);
  const L = bars.map(b => b.l), H = bars.map(b => b.h), C = bars.map(b => b.c);
  const signals = [], watch = [];
  const used = new Set();
  for (let i = P.piv; i < N - P.piv; i += 1) {
    let isLow = true;
    for (let k = i - P.piv; k <= i + P.piv; k += 1) if (k !== i && L[k] < L[i]) { isLow = false; break; }
    if (!isLow) continue;
    const level = L[i];
    // 1. 找跌破
    let j = i + P.piv + 1, brk = -1;
    for (; j < N && j - i <= P.look; j += 1) {
      const a = A[j]; if (!a) continue;
      if (L[j] < level - P.breakAtr * a) { brk = j; break; }
    }
    if (brk < 0) continue;
    // 2. 跌破後 reclaimBars 根內收盤站回
    let low2 = L[brk], low2i = brk, rec = -1;
    for (let k = brk; k < N && k - brk <= P.reclaimBars; k += 1) {
      if (L[k] < low2) { low2 = L[k]; low2i = k; }
      if (C[k] > level) { rec = k; break; }
    }
    if (rec < 0) { if (N - 1 - brk <= P.reclaimBars) watch.push({ stage: "破底中", level, low2, t: bars[brk].end }); continue; }
    // 3. 往上走一段，再回測不破
    let rallied = false, hi = H[rec], state = "站回";
    for (let k = rec + 1; k < N && k - rec <= P.retestBars; k += 1) {
      const a = A[k]; if (!a) continue;
      if (C[k] < level || L[k] < low2) { state = "失敗"; break; }      // 收盤又跌回低點下方，或再破新低 → 型態失敗
      if (!rallied) { hi = Math.max(hi, H[k]); if (hi >= level + P.rallyAtr * a) { rallied = true; state = "往上"; } continue; }
      hi = Math.max(hi, H[k]);
      if (L[k] <= level + P.retestAtr * a) {                             // 回測到低點附近、收盤還在上面
        const key = `${i}`;
        if (!used.has(key)) {
          used.add(key);
          const risk = Math.max(C[k] - (low2 - 0.2 * a), a * 0.5);
          signals.push({ t: bars[k].end, j: k, level, low2, close: C[k], retestLow: L[k], hi, atr: a, from: bars[i].end, brokeAt: bars[brk].end, stop: low2 - 0.2 * a, risk, target: C[k] + (hi - low2) });
        }
        state = "觸發"; break;
      }
    }
    if ((state === "站回" || state === "往上") && N - 1 - rec <= P.retestBars) watch.push({ stage: state === "往上" ? "等回測" : "剛站回", level, low2, hi, t: bars[rec].end });
  }
  // 回測結果：先到 +1R（risk）還是先到停損
  for (const s of signals) {
    s.result = null;
    for (let k = s.j + 1; k < N; k += 1) {
      if (L[k] <= s.stop) { s.result = -1; break; }
      if (H[k] >= s.close + s.risk) { s.result = 1; break; }
    }
  }
  const lastI = N - 1;
  return { signals, watch: watch.slice(-3), last: signals.at(-1)?.j === lastI ? signals.at(-1) : null, atr: A[lastI] };
}
