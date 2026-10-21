// 按「更新」時即時抓行情：
// 1. 有設定 Google Apps Script 中繼站（config.json 的 liveUrl）→ 抓台指期近一＋微型台指近一的完整分K
// 2. 沒有 → 退而求其次，用葵哥站的公開 API 只拿最新價（不含分K）
import { yahooToRecords } from "./engine/yahoo.js";
import { summarize, sessionToBars } from "./engine/bars.js";
import { sessionKey, nextTradingDate } from "./engine/sessions.js";

const FALLBACK = "https://tx-public-range.liao-kurl.chatgpt.site/api/market/current";

export async function fetchLive(cfg) {
  const t0 = Date.now();
  if (cfg.liveUrl) {
    try {
      const r = await fetch(`${cfg.liveUrl}${cfg.liveUrl.includes("?") ? "&" : "?"}action=charts&t=${t0}`, { cache: "no-store" });
      const j = await r.json();
      if (j.WTX && !j.WTX.error) return { kind: "bars", ...j, ms: Date.now() - t0 };
    } catch { /* 改用備援 */ }
  }
  try {
    const r = await fetch(`${FALLBACK}?t=${t0}`, { cache: "no-store" });
    const j = await r.json();
    if (Number.isFinite(j.last_price)) return { kind: "price", price: j.last_price, high: j.high, low: j.low, quotedAt: Date.parse(j.quoted_at) || t0, ms: Date.now() - t0 };
  } catch { /* 都失敗 */ }
  return null;
}

/** 把即時資料套進 bundle（只取代「盤中、非官方」的盤別） */
export function applyLive(B, L, now = Date.now()) {
  if (!L) return B;
  const cal = B.calendarTail ?? [];
  const tdOf = rec => (rec.type === "D" ? rec.start : nextTradingDate(rec.start, cal).date);
  if (L.kind === "price") {
    B.live = { ...(B.live ?? {}), lastPrice: L.price, quotedAt: L.quotedAt, fetchedAt: now, source: "Yahoo 台指期近一（經葵哥站，只有最新價）", priceOnly: true };
    return B;
  }
  const tx = yahooToRecords(L.WTX, 15, cal, "yahoo-live", now);
  rollIfNeeded(B, tx.recs.map(tdOf));
  // 這一盤是不是 bundle 目前合約的：換月後，結算日（含）以前的盤屬舊合約；沒換月時，結算日以後的盤屬次月
  const sameContract = rec => { const td = tdOf(rec); return !(B.rollCut && td <= B.rollCut) && !(B.expiry && td > B.expiry); };
  for (const rec of tx.recs) {
    const key = sessionKey(rec.start, rec.type);
    const i = B.sessions15.findIndex(s => sessionKey(s.start, s.type) === key);
    if (i >= 0 && B.sessions15[i].source === "official") continue;
    if (!sameContract(rec)) continue; // 換月後 Yahoo 舊合約的盤不要混進新合約
    const merged = { ...rec, contract: B.contract, td: tdOf(rec) };
    if (i >= 0) B.sessions15[i] = merged; else B.sessions15.push(merged);
    const sm = summarize(sessionToBars(merged));
    if (sm) {
      const j = B.summaries.findIndex(s => s.td === merged.td && s.type === merged.type);
      const row = { td: merged.td, type: merged.type, start: merged.start, ...sm, complete: merged.complete, source: "yahoo-live" };
      if (j >= 0) { if (B.summaries[j].source !== "official-daily") B.summaries[j] = row; } else B.summaries.push(row);
    }
  }
  B.live = { lastPrice: tx.lastPrice, lastBarTime: tx.lastT || null, quotedAt: tx.refreshedAt || tx.lastT || now, fetchedAt: now, source: "Yahoo 台指期近一（即時中繼）" };
  if (L.WTM && !L.WTM.error && B.tmf5) {
    const tm = yahooToRecords(L.WTM, 5, cal, "yahoo-tmf-live", now);
    for (const rec of tm.recs) {
      const key = sessionKey(rec.start, rec.type);
      const i = B.tmf5.findIndex(s => sessionKey(s.start, s.type) === key);
      if (i >= 0 && B.tmf5[i].source === "official") continue;
      // 微台是連續序列：舊合約的盤要平移到新合約價位
      if (!sameContract(rec) && !B.rollCut) continue;
      const adj = sameContract(rec) ? 0 : (B.rollShift ?? 0);
      const merged = { ...rec, contract: B.contract, td: tdOf(rec), adjusted: adj, bars: adj ? rec.bars.map(b => (b ? [b[0] + adj, b[1] + adj, b[2] + adj, b[3] + adj, b[4]] : null)) : rec.bars };
      if (i >= 0) B.tmf5[i] = merged; else B.tmf5.push(merged);
    }
    B.tmfLive = { lastBarTime: tm.lastT || null, lastPrice: tm.lastPrice };
  }
  return B;
}

/**
 * 換月：結算日（第三個週三）13:45 後，Yahoo「近一」變成次月合約。
 * 網站資料還沒重算時，用 bundle 裡預先放好的次月資料自己切過去，微台連續序列整段平移換月價差。
 */
export function rollIfNeeded(B, liveTds) {
  if (!B.next || !B.expiry || !liveTds.length) return false;
  const latest = liveTds.reduce((a, x) => (x > a ? x : a), "");
  if (latest <= B.expiry) return false;
  const N = B.next, shift = N.spread ?? 0;
  B.prevContract = B.contract;
  B.contract = N.contract;
  B.sessions15 = N.sessions15;
  B.summaries = N.summaries;
  if (B.tmf5) B.tmf5 = B.tmf5.map(r => ({ ...r, adjusted: (r.adjusted ?? 0) + shift, bars: shift ? r.bars.map(b => (b ? [b[0] + shift, b[1] + shift, b[2] + shift, b[3] + shift, b[4]] : null)) : r.bars }));
  B.rollShift = shift;
  B.rollCut = B.expiry;
  B.roll = { from: B.prevContract, to: N.contract, spread: shift, td: N.spreadTd, client: true };
  B.expiry = null; B.next = null;
  return true;
}
