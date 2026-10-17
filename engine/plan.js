// 盤前計畫：1 個方向 + 最多 3 條線 + 幾條「收盤若…則…」規則。
import { LEVEL_TYPES, VERDICT_TEXT } from "./backtest.js";
import { percentile } from "./indicators.js";
import { SESSION } from "./sessions.js";

export const POINT_VALUE_TMF = 10; // 微型臺指 1 點 = NT$10

/** 同盤別最近 n 盤的振幅分布 */
export function expectedRange(sessionSummaries, type, n = 20) {
  const list = sessionSummaries.filter(s => s.type === type && s.complete !== false).slice(-n).map(s => s.h - s.l);
  if (list.length < 5) return null;
  return { median: percentile(list, 0.5), p80: percentile(list, 0.8), n: list.length };
}

/** 候選線（全部都是「已知當下」可算出的價位） */
export function candidateLevels(analysis, prevSession) {
  const c = [];
  const { byId, swings } = analysis;
  for (const id of ["d1_20", "h1_60", "h1_240"]) {
    const l = byId[id];
    if (!l.insufficient) c.push({ type: id, price: l.ma, slope: l.slope });
  }
  if (prevSession) {
    c.push({ type: "prevHigh", price: prevSession.h });
    c.push({ type: "prevLow", price: prevSession.l });
  }
  const lastLow = swings.lows.at(-1), lastHigh = swings.highs.at(-1);
  if (lastLow) c.push({ type: "swingLow", price: lastLow.price });
  if (lastHigh) c.push({ type: "swingHigh", price: lastHigh.price });
  return c;
}

/** 相近的線合併成一個區（避免一堆擠在一起的數字） */
export function mergeLevels(levels, tolerance) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const zones = [];
  for (const l of sorted) {
    const z = zones.at(-1);
    if (z && l.price - z.hi <= tolerance) {
      z.members.push(l); z.hi = l.price;
    } else zones.push({ lo: l.price, hi: l.price, members: [l] });
  }
  return zones.map(z => ({ price: Math.round(z.members.reduce((s, m) => s + m.price, 0) / z.members.length), lo: Math.round(z.lo), hi: Math.round(z.hi), members: z.members }));
}

function statsFor(type, stats) {
  const intra = stats?.intraday?.[type] ?? null;
  const sess = stats?.session?.[type] ?? null;
  return { intraday: intra, session: sess };
}

/** 一條線的白話成績單 */
export function describeStats(type, stats) {
  const { intraday, session } = statsFor(type, stats);
  const parts = [];
  const baseI = stats?.intraday?.random, baseS = stats?.session?.random;
  if (intraday && intraday.n) parts.push({ kind: "intraday", n: intraday.n, rate: intraday.rate, base: baseI?.rate ?? null, verdict: intraday.verdict, text: `碰到後先回頭 ${pct(intraday.rate)}（隨機線 ${pct(baseI?.rate)}，${intraday.n} 次）` });
  if (session && session.n) parts.push({ kind: "session", n: session.n, rate: session.rate, base: baseS?.rate ?? null, verdict: session.verdict, text: `收盤守住 ${pct(session.rate)}（隨機線 ${pct(baseS?.rate)}，${session.n} 次）` });
  // 主要判定：樣本較大且非樣本不足者優先
  const ranked = parts.filter(p => p.verdict !== "SMALL_SAMPLE").sort((a, b) => b.n - a.n);
  const main = ranked[0] ?? parts.sort((a, b) => b.n - a.n)[0] ?? null;
  return { parts, verdict: main?.verdict ?? "SMALL_SAMPLE", verdictText: VERDICT_TEXT[main?.verdict ?? "SMALL_SAMPLE"] };
}

const pct = v => (v == null ? "—" : `${Math.round(v * 100)}%`);

/**
 * 產生計畫。
 * analysis: analyzeStructure 結果；session: {start,type,td}；prevSession: 前一盤摘要
 * summaries: 同合約各盤摘要（算預估振幅）；stats: 回測結果
 */
export function buildPlan({ analysis, session, prevSession, summaries, stats, contract, refPrice, createdAt, maxLines = 3 }) {
  const P = refPrice ?? analysis.lastPrice;
  const atr60 = analysis.atr["60m"] ?? 40;
  const exp = expectedRange(summaries, session.type);
  const reach = exp ? exp.p80 * 1.2 : atr60 * 4;
  const zones = mergeLevels(candidateLevels(analysis, prevSession), Math.max(10, 0.2 * atr60)).map(z => {
    const types = z.members.map(m => m.type);
    const statList = types.map(t => ({ type: t, label: LEVEL_TYPES[t], ...describeStats(t, stats) }));
    const best = statList.find(s => s.verdict === "EDGE") ?? statList.find(s => s.verdict === "NO_EDGE") ?? statList[0];
    return {
      ...z,
      types,
      label: types.map(t => LEVEL_TYPES[t]).join("＋"),
      role: z.price >= P ? "壓力" : "支撐",
      distance: Math.round(z.price - P),
      money: Math.round(Math.abs(z.price - P) * POINT_VALUE_TMF),
      stats: statList,
      verdict: best?.verdict ?? "SMALL_SAMPLE",
      inReach: Math.abs(z.price - P) <= reach,
    };
  });
  const above = zones.filter(z => z.price > P && z.inReach).sort((a, b) => a.price - b.price);
  const below = zones.filter(z => z.price <= P && z.inReach).sort((a, b) => b.price - a.price);
  const picked = [];
  // 優先順序：課程核心均線 > 回測有優勢 > 樣本不足 > 跟隨機差不多；同級看距離
  const isCore = z => z.types.some(t => t === "h1_60" || t === "h1_240" || t === "d1_20");
  const score = z => (isCore(z) ? 0 : 1) + (z.verdict === "EDGE" ? 0 : z.verdict === "NO_EDGE" ? 2 : 1);
  const best = list => [...list].sort((a, b) => score(a) - score(b) || Math.abs(a.distance) - Math.abs(b.distance))[0];
  // 上下各取最近的一條，讓你知道兩邊的第一道關卡
  // 一般振幅內沒有線時，仍給最近的一條，並標示「一般振幅碰不到」
  const nearAbove = above[0] ?? zones.filter(z => z.price > P).sort((a, b) => a.price - b.price)[0];
  const nearBelow = below[0] ?? zones.filter(z => z.price <= P).sort((a, b) => b.price - a.price)[0];
  if (nearAbove) picked.push(nearAbove);
  if (nearBelow) picked.push(nearBelow);
  const minGap = Math.max(20, 0.5 * atr60);
  const rest = zones.filter(z => z.inReach && !picked.includes(z) && picked.every(q => Math.abs(q.price - z.price) >= minGap));
  while (picked.length < maxLines && rest.length) {
    const z = best(rest);
    picked.push(z);
    rest.splice(rest.indexOf(z), 1);
    for (let i = rest.length - 1; i >= 0; i -= 1) if (Math.abs(rest[i].price - z.price) < minGap) rest.splice(i, 1);
  }
  picked.sort((a, b) => b.price - a.price);
  const hidden = zones.filter(z => !picked.includes(z)).sort((a, b) => b.price - a.price);

  // 收盤條件規則（精確門檻）
  const rules = [];
  const { A, B } = analysis.conditions;
  if (B.threshold != null) {
    rules.push(B.value
      ? { id: "B", kind: "hold", level: Math.round(B.threshold), text: `60分K 收盤跌破 ${fmt(B.threshold)} → 條件B失效（60分K回到雙均線下）` }
      : { id: "B", kind: "trigger", level: Math.round(B.threshold), text: `60分K 收盤站上 ${fmt(B.threshold)} → 條件B成立（空單回補條件）` });
  }
  if (A.threshold != null) {
    rules.push(A.value
      ? { id: "A", kind: "hold", level: Math.round(A.threshold), text: `今日 13:45 收盤低於 ${fmt(A.threshold)} → 條件A失效（日K跌回 MA20 下）` }
      : { id: "A", kind: "trigger", level: Math.round(A.threshold), text: `今日 13:45 收盤站上 ${fmt(A.threshold)} → 條件A成立（空單回補條件）` });
  }
  const hl = analysis.swings.higherLow;
  if (hl.state === "FORMED" && hl.latest) rules.push({ id: "HL", kind: "hold", level: Math.round(hl.latest.price), text: `跌破 60分擺盪低點 ${fmt(hl.latest.price)} → 低點墊高失敗` });

  return {
    version: 1,
    createdAt,
    contract,
    session: { ...session, label: SESSION[session.type].label },
    refPrice: P,
    structure: analysis.structure,
    conditions: {
      A: { value: A.value, threshold: A.threshold && Math.round(A.threshold) },
      B: { value: B.value, threshold: B.threshold && Math.round(B.threshold) },
      shortCover: analysis.conditions.shortCover,
    },
    higherLow: { state: hl.state, label: hl.label, price: hl.latest ? Math.round(hl.latest.price) : null },
    expected: exp && { median: Math.round(exp.median), p80: Math.round(exp.p80), n: exp.n },
    atr60: Math.round(atr60),
    lines: picked.map(strip),
    hidden: hidden.map(strip),
    rules,
    maValues: Object.fromEntries(analysis.lines.map(l => [l.id, l.ma == null ? null : Math.round(l.ma)])),
  };
}

function strip(z) {
  return { price: z.price, lo: z.lo, hi: z.hi, types: z.types, label: z.label, role: z.role, distance: z.distance, money: z.money, verdict: z.verdict, inReach: z.inReach, stats: z.stats.map(s => ({ type: s.type, label: s.label, verdict: s.verdict, verdictText: s.verdictText, parts: s.parts })) };
}

const fmt = v => Math.round(v).toLocaleString("en-US");

/**
 * 盤中修正：計畫不變，只回報「現在」發生了什麼。
 * bars15Session: 本盤已有的 15 分 K；price: 現價
 */
export function reviseIntraday(plan, { bars15Session, price, analysis, R }) {
  const hi = bars15Session.length ? Math.max(...bars15Session.map(b => b.h)) : null;
  const lo = bars15Session.length ? Math.min(...bars15Session.map(b => b.l)) : null;
  const lines = plan.lines.map(l => {
    const touched = hi != null && lo != null && lo <= l.hi && hi >= l.lo;
    let status = "未碰";
    if (touched) {
      const ref = touchOutcome(bars15Session, l, R);
      status = ref;
    }
    return { ...l, touched, status, nowDistance: price == null ? null : Math.round(l.price - price) };
  });
  const rules = plan.rules.map(r => {
    const cond = analysis.conditions[r.id];
    let status = "等待";
    if (r.id === "B" || r.id === "A") {
      const now = cond?.value;
      const est = cond?.est;
      if (r.kind === "trigger") status = now ? "已成立（收盤確認）" : est ? "現價已在門檻上，等收盤確認" : "未達";
      else status = now === false ? "已失效（收盤確認）" : est === false ? "現價已跌破門檻，等收盤確認" : "維持中";
      return { ...r, status, liveThreshold: cond?.threshold == null ? null : Math.round(cond.threshold) };
    }
    if (r.id === "HL") status = price != null && price < r.level ? "已跌破" : "維持中";
    return { ...r, status };
  });
  const range = hi != null ? hi - lo : null;
  return { lines, rules, sessionHigh: hi, sessionLow: lo, range, rangeVsExpected: plan.expected && range != null ? range / plan.expected.median : null };
}

/** 碰線後先反彈 R 點還是先穿越 R 點（用本盤 15 分 K） */
export function touchOutcome(bars, line, R) {
  const L = line.price;
  let start = -1;
  for (let i = 0; i < bars.length; i += 1) if (bars[i].l <= L && bars[i].h >= L) { start = i; break; }
  if (start < 0) return "未碰";
  const side = line.role === "支撐" ? "support" : "resistance";
  const first = bars[start];
  if (side === "support" ? L - first.l >= R : first.h - L >= R) return "已穿越";
  for (let i = start + 1; i < bars.length; i += 1) {
    const b = bars[i];
    const bounce = side === "support" ? b.h - L >= R : L - b.l >= R;
    const brk = side === "support" ? L - b.l >= R : b.h - L >= R;
    if (bounce && brk) return "反應不明";
    if (bounce) return side === "support" ? "已反彈" : "已拉回";
    if (brk) return "已穿越";
  }
  return "碰到，觀察中";
}
