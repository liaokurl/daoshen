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
  for (const rec of tx.recs) {
    const key = sessionKey(rec.start, rec.type);
    const i = B.sessions15.findIndex(s => sessionKey(s.start, s.type) === key);
    if (i >= 0 && B.sessions15[i].source === "official") continue;
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
      const merged = { ...rec, contract: B.contract, td: tdOf(rec), adjusted: 0 };
      if (i >= 0) B.tmf5[i] = merged; else B.tmf5.push(merged);
    }
    B.tmfLive = { lastBarTime: tm.lastT || null, lastPrice: tm.lastPrice };
  }
  return B;
}
