// Yahoo 奇摩股市分K（台指期近一 WTX&、微型台指近一 WTM&）→ 盤別紀錄。伺服器與手機共用。
import { classifyTick, sessionKey, sessionStartMs, sessionEndMs, slotsOf, prevTradingDate } from "./sessions.js";
import { tpeParts, tpeMs, addDays } from "./time.js";

export function yahooToRecords(json, res, calendar, source, now = Date.now()) {
  const ts = json.timestamp ?? [];
  const q = json.indicators?.quote?.[0] ?? {};
  const recs = new Map();
  let lastT = 0, lastPrice = null;
  for (let i = 0; i < ts.length; i += 1) {
    // Yahoo 分K時間是「該分鐘結束時間」，減 1 分鐘當開始時間
    const t = ts[i] * 1000 - 60_000;
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i] ?? 0;
    if (![o, h, l, c].every(Number.isFinite)) continue;
    const parts = tpeParts(t);
    const clock = `${String(Math.floor(parts.minute / 60)).padStart(2, "0")}${String(parts.minute % 60).padStart(2, "0")}00`;
    const slot = classifyTick(parts.ymd, clock, res);
    if (!slot) continue;
    const key = sessionKey(slot.start, slot.type);
    let rec = recs.get(key);
    if (!rec) { rec = { start: slot.start, type: slot.type, source, res, bars: new Array(slotsOf(slot.type, res)).fill(null) }; recs.set(key, rec); }
    const b = rec.bars[slot.slot];
    if (!b) rec.bars[slot.slot] = [o, h, l, c, v];
    else { b[1] = Math.max(b[1], h); b[2] = Math.min(b[2], l); b[3] = c; b[4] += v; }
    if (t >= lastT) { lastT = t; lastPrice = c; }
  }
  // Yahoo 把夜盤時間搬到「交易日前一天 15:00」：週五夜盤會被標成週日晚上。搬回真正開盤日。
  for (const [key, rec] of [...recs.entries()]) {
    if (rec.type !== "N") continue;
    const actual = prevTradingDate(addDays(rec.start, 1), calendar);
    if (actual === rec.start) continue;
    const shift = tpeMs(actual) - tpeMs(rec.start);
    if (lastT >= sessionStartMs(rec.start, "N") && lastT < sessionEndMs(rec.start, "N")) lastT += shift;
    recs.delete(key);
    rec.yahooStart = rec.start;
    rec.start = actual;
    recs.set(sessionKey(actual, "N"), rec);
  }
  for (const rec of recs.values()) rec.complete = now >= sessionEndMs(rec.start, rec.type) + 2 * 60_000;
  const metaPrice = Number(json.quote?.price ?? json.meta?.regularMarketPrice);
  return { recs: [...recs.values()], lastT, lastPrice: Number.isFinite(metaPrice) ? metaPrice : lastPrice, points: ts.length, refreshedAt: Date.parse(json.quote?.refreshedTs ?? "") || null };
}
