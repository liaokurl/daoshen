// K 棒建構：逐筆 → 15 分 K（每盤固定格位）→ 30 / 60 分 K、全日盤日 K。
import { classifyTick, sessionKey, sessionStartMs, slotsOf } from "./sessions.js";
import { MIN } from "./time.js";

/**
 * 解析期交所逐筆成交 CSV（Daily_YYYY_MM_DD.zip 內容），只取 TX 單月合約。
 * 欄位：成交日期,商品代號,到期月份(週別),成交時間,成交價格,成交數量(B+S),...
 * 回傳 Map(contract → Map(sessionKey → sessionRecord))
 */
export function ticksToSessions(csvText, { product = "TX", contracts = null, res = 15 } = {}) {
  const out = new Map();
  let start = 0;
  const len = csvText.length;
  while (start < len) {
    let end = csvText.indexOf("\n", start);
    if (end < 0) end = len;
    const line = csvText.slice(start, end);
    start = end + 1;
    // 快速過濾：第二欄必須剛好是商品代號
    const c1 = line.indexOf(",");
    if (c1 < 0) continue;
    const c2 = line.indexOf(",", c1 + 1);
    if (c2 < 0 || line.slice(c1 + 1, c2).trim() !== product) continue;
    const row = line.split(",");
    const rawDate = row[0].trim(), month = row[2].trim(), clock = row[3].trim();
    if (!/^\d{8}$/.test(rawDate) || !/^\d{6}$/.test(month)) continue;
    if (contracts && !contracts.includes(month)) continue;
    const price = Number(row[4]), qty = Number(row[5]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const slot = classifyTick(rawDate, clock, res);
    if (!slot) continue;
    let byContract = out.get(month);
    if (!byContract) { byContract = new Map(); out.set(month, byContract); }
    const key = sessionKey(slot.start, slot.type);
    let rec = byContract.get(key);
    if (!rec) {
      rec = { start: slot.start, type: slot.type, contract: month, source: "official", res, bars: new Array(slotsOf(slot.type, res)).fill(null) };
      byContract.set(key, rec);
    }
    const sec = toSec(clock);
    const b = rec.bars[slot.slot];
    // 成交數量欄為買賣雙邊合計，除以 2 才是口數
    const vol = Number.isFinite(qty) ? qty / 2 : 0;
    if (!b) {
      rec.bars[slot.slot] = [price, price, price, price, vol, sec, sec];
    } else {
      if (price > b[1]) b[1] = price;
      if (price < b[2]) b[2] = price;
      b[4] += vol;
      // 檔案通常依時間排序，但仍以時間決定開/收
      if (sec < b[5]) { b[5] = sec; b[0] = price; }
      if (sec >= b[6]) { b[6] = sec; b[3] = price; }
    }
  }
  // 去掉排序用欄位
  for (const byContract of out.values()) {
    for (const rec of byContract.values()) {
      rec.bars = rec.bars.map(b => (b ? [b[0], b[1], b[2], b[3], Math.round(b[4])] : null));
      delete rec.lastSec;
    }
  }
  return out;
}

function toSec(clock) {
  const c = String(clock).padStart(6, "0");
  let s = Number(c.slice(0, 2)) * 3600 + Number(c.slice(2, 4)) * 60 + Number(c.slice(4, 6));
  if (s < 8 * 3600) s += 86400; // 跨午夜的夜盤時間排在後面
  return s;
}

/**
 * 盤別紀錄 → 引擎 K 棒陣列（15 分）。沒有成交的格位以前一根收盤補平（v=0, filled=true）。
 * upTo: 只輸出開始時間 < upTo 的格位（盤中用）
 */
export function sessionToBars(rec, { prevClose = null, upTo = Infinity } = {}) {
  const first = rec.bars.find(Boolean);
  if (!first) return [];
  const base = sessionStartMs(rec.start, rec.type);
  const res = rec.res ?? 15, W = res * MIN;
  const out = [];
  let last = prevClose ?? first[0];
  for (let i = 0; i < rec.bars.length; i += 1) {
    const t = base + i * W;
    if (t >= upTo) break;
    const b = rec.bars[i];
    if (b) {
      out.push({ t, end: t + W, o: b[0], h: b[1], l: b[2], c: b[3], v: b[4], key: sessionKey(rec.start, rec.type), type: rec.type, slot: i, res, filled: false });
      last = b[3];
    } else {
      // 尚未有任何成交前、而且盤還沒結束的尾端不補（避免盤中捏造）
      if (rec.complete === false && i > lastFilledIndex(rec)) break;
      out.push({ t, end: t + W, o: last, h: last, l: last, c: last, v: 0, key: sessionKey(rec.start, rec.type), type: rec.type, slot: i, res, filled: true });
    }
  }
  return out;
}

function lastFilledIndex(rec) {
  for (let i = rec.bars.length - 1; i >= 0; i -= 1) if (rec.bars[i]) return i;
  return -1;
}

/** 依時間排序的多個盤別紀錄 → 連續 15 分 K（同一合約） */
export function buildBars15(records, opts = {}) {
  const sorted = [...records].sort((a, b) => sessionStartMs(a.start, a.type) - sessionStartMs(b.start, b.type));
  const out = [];
  for (const rec of sorted) {
    const prevClose = out.length ? out[out.length - 1].c : null;
    out.push(...sessionToBars(rec, { prevClose, upTo: opts.upTo }));
  }
  return out;
}

/** 15 分 K 合成較大週期（每盤從開盤起算對齊；日盤 60 分 = 5 根、夜盤 = 14 根） */
export function aggregate(bars15, minutes) {
  const out = [];
  let cur = null;
  for (const b of bars15) {
    const res = b.res ?? 15;
    const k = minutes / res;
    const group = Math.floor(b.slot / k);
    const id = `${b.key}:${group}`;
    if (!cur || cur.id !== id) {
      if (cur) out.push(finish(cur));
      cur = { id, t: b.t - (b.slot % k) * res * MIN, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, key: b.key, type: b.type, slot: group, res: minutes, parts: 1, k, filled: b.filled };
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; cur.parts += 1;
      cur.filled = cur.filled && b.filled;
    }
  }
  if (cur) out.push(finish(cur));
  return out;
}

function finish(cur) {
  const { id, parts, k, ...bar } = cur;
  bar.end = bar.t + bar.res * MIN;
  bar.partial = parts < k; // 盤中尚未湊滿
  return bar;
}

/**
 * 全日盤日 K：交易日 D = 夜盤（前一交易日 15:00 起）+ 日盤 D。
 * sessions: [{ td, type, o,h,l,c,v }]（同一合約），回傳依交易日排序的日 K。
 */
export function buildDaily(sessionSummaries) {
  const byTd = new Map();
  for (const s of sessionSummaries) {
    const cur = byTd.get(s.td) ?? {};
    cur[s.type] = s;
    byTd.set(s.td, cur);
  }
  return [...byTd.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([td, parts]) => {
    const n = parts.N, d = parts.D;
    const list = [n, d].filter(Boolean);
    return {
      td,
      o: (n ?? d).o,
      h: Math.max(...list.map(x => x.h)),
      l: Math.min(...list.map(x => x.l)),
      c: (d ?? n).c,
      v: list.reduce((s, x) => s + (x.v || 0), 0),
      hasNight: Boolean(n),
      hasDay: Boolean(d),
      complete: Boolean(d && d.complete !== false),
    };
  });
}

/** 15 分 K 某一盤的摘要 */
export function summarize(bars) {
  if (!bars.length) return null;
  return { o: bars[0].o, h: Math.max(...bars.map(b => b.h)), l: Math.min(...bars.map(b => b.l)), c: bars[bars.length - 1].c, v: bars.reduce((s, b) => s + b.v, 0) };
}
