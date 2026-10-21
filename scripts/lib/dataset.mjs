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

/**
 * 微台 5 分K 連續序列（跟 TradingView TMF1! B-ADJ 一樣：換月時把舊合約往新合約價位平移）。
 * tmfRecords: 各檔案的 tmf5 紀錄（多合約）＋ Yahoo 暫存（近月）
 */
/** 換月價差（新合約 − 舊合約）：取兩個合約都有日盤收盤的最近一天（期交所日行情） */
export function rollSpread(dailyRows, from, to) {
  const byTd = new Map();
  for (const r of dailyRows ?? []) {
    if (r.type !== "D" || (r.contract !== from && r.contract !== to)) continue;
    if (!byTd.has(r.td)) byTd.set(r.td, {});
    byTd.get(r.td)[r.contract] = r.c;
  }
  const tds = [...byTd.keys()].filter(td => byTd.get(td)[from] != null && byTd.get(td)[to] != null).sort();
  if (!tds.length) return null;
  const td = tds.at(-1), x = byTd.get(td);
  return { from, to, td, spread: x[to] - x[from], fromClose: x[from], toClose: x[to] };
}

/** 兩個合約同一盤、同一根 K 棒都有成交的最後一根：新 − 舊 */
export function sameSlotDiff(oldRec, newRec) {
  if (!oldRec || !newRec) return null;
  for (let k = Math.min(oldRec.bars.length, newRec.bars.length) - 1; k >= 0; k -= 1) {
    const a = oldRec.bars[k], b = newRec.bars[k];
    if (a && b) return b[3] - a[3];
  }
  return null;
}

/** 換月價差優先用微台逐筆（同一根 K 棒），沒有才用日行情收盤 */
export function rollSpreadBest(tmfRecords, dailyRows, from, to) {
  const by = new Map();
  for (const r of tmfRecords ?? []) {
    if (r.source !== "official" || (r.contract !== from && r.contract !== to)) continue;
    const key = sessionKey(r.start, r.type);
    if (!by.has(key)) by.set(key, {});
    by.get(key)[r.contract] = r;
  }
  const keys = [...by.keys()].sort((a, b) => sessionStartMs(b.slice(0, 8), b.slice(8)) - sessionStartMs(a.slice(0, 8), a.slice(8)));
  for (const k of keys) {
    const d = sameSlotDiff(by.get(k)[from], by.get(k)[to]);
    if (d != null) return { from, to, td: k, spread: d, src: "tmf" };
  }
  return rollSpread(dailyRows, from, to);
}

export function tmfContinuous(tmfRecords, { calendar, expiry, dailyRows = [] }, toContract = null) {
  const byKey = new Map(); // key -> Map(contract -> rec)
  for (const r of tmfRecords) {
    const key = sessionKey(r.start, r.type);
    if (!byKey.has(key)) byKey.set(key, new Map());
    const m = byKey.get(key), prev = m.get(r.contract);
    // 官方逐筆優先於 Yahoo；同來源取資料較完整者
    const rank = x => (x.source === "official" ? 1000 : 0) + x.bars.filter(Boolean).length;
    if (!prev || rank(r) > rank(prev)) m.set(r.contract, r);
  }
  const keys = [...byKey.keys()].sort((a, b) => sessionStartMs(a.slice(0, 8), a.slice(8)) - sessionStartMs(b.slice(0, 8), b.slice(8)));
  const out = [];
  // toContract：整段序列要對齊到哪個合約（換月後網站資料改用新合約，但新合約的盤可能還沒進來）
  let offset = 0, nextFront = toContract;
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const key = keys[i], start = key.slice(0, 8), type = key.slice(8);
    const td = tdOf(start, type, calendar);
    const front = frontContract(td, expiry);
    const m = byKey.get(key);
    const rec = m.get(front) ?? [...m.values()].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0];
    if (!rec) continue;
    if (nextFront && rec.contract !== nextFront) {
      // 換月那一盤兩個合約都有資料 → 取「同一根 K 棒」的收盤差（結算日舊合約 13:30 就停了，不能拿兩個收盤直接相減）；
      // 沒有（例如結算日官方逐筆還沒出來）→ 往前找兩合約都有的一盤，再不行用日行情
      let diff = null;
      for (let k = i; k >= Math.max(0, i - 12) && diff == null; k -= 1) {
        const mm = byKey.get(keys[k]);
        diff = sameSlotDiff(mm.get(rec.contract), mm.get(nextFront));
      }
      if (diff == null) diff = rollSpread(dailyRows, rec.contract, nextFront)?.spread ?? 0;
      offset += diff;
    }
    nextFront = rec.contract;
    const adj = offset;
    out.unshift({ ...rec, td, adjusted: adj, bars: adj ? rec.bars.map(b => (b ? [b[0] + adj, b[1] + adj, b[2] + adj, b[3] + adj, b[4]] : null)) : rec.bars });
  }
  return out;
}
