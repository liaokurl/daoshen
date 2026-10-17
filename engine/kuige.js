// 葵哥模型（原始核心）：前一個完整盤的高低點切三等分。
// 高點、回測點1（高−⅓）、回測點2（高−⅔）、低點，再各往外延伸一格。
// 目前盤也用當盤已知高低點算一份「動態」三等分（盤中會變，只當參考）。

export function thirds(high, low) {
  if (!(high > low)) return null;
  const step = (high - low) / 3;
  return {
    high, low, step, range: high - low,
    levels: [
      { id: "kgUp", label: "上延伸1", price: high + step },
      { id: "prevHigh", label: "高點", price: high },
      { id: "kgR1", label: "回測點1", price: high - step },
      { id: "kgR2", label: "回測點2", price: high - 2 * step },
      { id: "prevLow", label: "低點", price: low },
      { id: "kgDn", label: "下延伸1", price: low - step },
    ],
  };
}

/** 價格目前落在三等分的哪一格 */
export function zoneOf(t, price) {
  if (!t || price == null) return null;
  const pos = (price - t.low) / t.range; // 0 = 低點，1 = 高點
  if (pos > 1) return { pos, label: "在高點之上（強勢延伸區）" };
  if (pos >= 2 / 3) return { pos, label: "上三分之一（偏強）" };
  if (pos >= 1 / 3) return { pos, label: "中間三分之一（整理）" };
  if (pos >= 0) return { pos, label: "下三分之一（偏弱）" };
  return { pos, label: "在低點之下（弱勢延伸區）" };
}

export function kuigeModel({ prevSession, currentBars, price }) {
  const fixed = prevSession ? thirds(prevSession.h, prevSession.l) : null;
  let current = null;
  if (currentBars?.length) {
    const h = Math.max(...currentBars.map(b => b.h)), l = Math.min(...currentBars.map(b => b.l));
    current = thirds(h, l);
  }
  return {
    fixed, current,
    prevLabel: prevSession ? `${(prevSession.start ?? prevSession.td).slice(4, 6)}/${(prevSession.start ?? prevSession.td).slice(6, 8)} ${prevSession.type === "D" ? "日盤" : "夜盤"}` : null,
    zone: zoneOf(fixed, price),
  };
}
