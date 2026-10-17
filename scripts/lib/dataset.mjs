// 把存檔資料組成「某一個合約」的 15 分 K、各盤摘要、日 K（引擎可直接用）。
import { buildBars15, buildDaily, summarize, sessionToBars } from "../../engine/bars.js";
import { sessionKey, sessionStartMs, sessionEndMs, nextTradingDate, prevTradingDate, frontContract } from "../../engine/sessions.js";

/** 期交所日行情 CSV → 列 */
export function parseDailyCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(",").map(s => s.trim());
  const ix = name => header.indexOf(name);
  const need = ["交易日期", "契約", "到期月份(週別)", "開盤價", "最高價", "最低價", "收盤價", "成交量", "交易時段"];
  for (const n of need) if (ix(n) < 0) throw new Error(`DAILY_CSV_HEADER_MISSING ${n}`);
  const rows = [];
  for (const line of lines) {
    const r = line.split(",").map(s => s.trim());
    if (r[ix("契約")] !== "TX") continue;
    const contract = r[ix("到期月份(週別)")];
    if (!/^\d{6}$/.test(contract)) continue;
    const num = k => { const v = Number(r[ix(k)]); return Number.isFinite(v) ? v : null; };
    const o = num("開盤價"), h = num("最高價"), l = num("最低價"), c = num("收盤價"), v = num("成交量");
    if ([o, h, l, c].some(x => x == null) || !v) continue;
    const sess = r[ix("交易時段")];
    rows.push({ td: r[ix("交易日期")].replace(/\D/g, ""), contract, type: sess === "一般" ? "D" : sess === "盤後" ? "N" : null, o, h, l, c, v });
  }
  return rows.filter(x => x.type);
}

/** 交易日曆：日行情一般時段日期 ∪ 逐筆檔日盤日期 */
export function buildCalendar(dailyRows, tickSessions) {
  const set = new Set(dailyRows.filter(r => r.type === "D").map(r => r.td));
  for (const s of tickSessions) if (s.type === "D") set.add(s.start);
  return [...set].sort();
}

/** 已到期合約的實際最後交易日 */
export function expiryOverrides(dailyRows, calendar) {
  const last = {};
  for (const r of dailyRows) if (r.type === "D" && (!last[r.contract] || r.td > last[r.contract])) last[r.contract] = r.td;
  const latest = calendar.at(-1);
  const out = {};
  for (const [c, d] of Object.entries(last)) if (d < latest) out[c] = d;
  return out;
}

export function tdOf(start, type, calendar) {
  return type === "D" ? start : nextTradingDate(start, calendar).date;
}

/**
 * 某合約的完整資料。
 * tickSessions: 期交所逐筆重建的盤別紀錄（多合約）
 * provisional: Yahoo 暫存盤別紀錄（近月）
 */
export function contractDataset(contract, { tickSessions, provisional = [], dailyRows, calendar, expiry, nowMs = Date.now() }) {
  const byKey = new Map();
  for (const s of tickSessions) {
    if (s.contract !== contract) continue;
    const key = sessionKey(s.start, s.type);
    const prev = byKey.get(key);
    if (!prev || filled(s) > filled(prev)) byKey.set(key, { ...s, complete: s.complete ?? sessionEndMs(s.start, s.type) <= nowMs });
  }
  for (const s of provisional) {
    if (s.contract !== contract) continue;
    const key = sessionKey(s.start, s.type);
    if (!byKey.has(key)) byKey.set(key, s);
  }
  const sessions15 = [...byKey.values()].sort((a, b) => sessionStartMs(a.start, a.type) - sessionStartMs(b.start, b.type));
  for (const s of sessions15) s.td = tdOf(s.start, s.type, calendar);

  // 各盤摘要：官方日行情為主，逐筆/暫存補最新
  const summaries = new Map();
  for (const r of dailyRows) {
    if (r.contract !== contract) continue;
    const start = r.type === "D" ? r.td : prevTradingDate(r.td, calendar);
    summaries.set(`${r.td}${r.type}`, { td: r.td, type: r.type, start, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, complete: true, source: "official-daily" });
  }
  for (const s of sessions15) {
    const k = `${s.td}${s.type}`;
    if (summaries.has(k)) continue;
    const sm = summarize(sessionToBars(s));
    if (sm) summaries.set(k, { td: s.td, type: s.type, start: s.start, ...sm, complete: s.complete !== false, source: s.source });
  }
  const summaryList = [...summaries.values()].sort((a, b) => (a.td === b.td ? (a.type === "N" ? -1 : 1) : a.td.localeCompare(b.td)));
  const daily = buildDaily(summaryList);
  const fronts = new Set(summaryList.filter(s => frontContract(s.td, expiry) === contract).map(s => `${s.td}${s.type}`));
  return { contract, sessions15, summaries: summaryList, daily, fronts };
}

function filled(s) {
  return s.bars.filter(Boolean).length;
}

export function bars15Of(ds, opts) {
  return buildBars15(ds.sessions15, opts);
}
