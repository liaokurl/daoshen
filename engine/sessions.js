// 台指期盤別與合約月份規則。
// 日盤 08:45–13:45；夜盤 15:00–次日 05:00，夜盤歸屬「下一個交易日」。
import { tpeMs, addDays, weekdayOf, MIN } from "./time.js";

export const SESSION = {
  D: { start: 8 * 60 + 45, length: 300, slots15: 20, label: "日盤" },
  N: { start: 15 * 60, length: 840, slots15: 56, label: "夜盤" },
};

/**
 * 把一筆逐筆成交歸到盤別與 15 分 K 格位。
 * rawDate: 成交日曆日 YYYYMMDD；clock: HHMMSS（可少前導 0）
 * 回傳 { type:'D'|'N', start:YYYYMMDD(盤開始日), slot } 或 null（非交易時段）
 */
export function classifyTick(rawDate, clock, res = 15) {
  const c = String(clock).trim().padStart(6, "0");
  const sec = Number(c.slice(0, 2)) * 3600 + Number(c.slice(2, 4)) * 60 + Number(c.slice(4, 6));
  if (!Number.isFinite(sec)) return null;
  const w = res * 60;
  const daySt = SESSION.D.start * 60, dayEnd = daySt + SESSION.D.length * 60;
  const nightSt = SESSION.N.start * 60;
  const maxD = SESSION.D.length / res - 1, maxN = SESSION.N.length / res - 1;
  if (sec >= daySt && sec <= dayEnd) {
    return { type: "D", start: rawDate, slot: Math.min(maxD, Math.floor((sec - daySt) / w)) };
  }
  if (sec >= nightSt) {
    return { type: "N", start: rawDate, slot: Math.min(maxN, Math.floor((sec - nightSt) / w)) };
  }
  if (sec <= 5 * 3600) {
    const since = sec + 86400 - nightSt;
    return { type: "N", start: addDays(rawDate, -1), slot: Math.min(maxN, Math.floor(since / w)) };
  }
  return null;
}

/** 某解析度下每盤格數 */
export const slotsOf = (type, res = 15) => SESSION[type].length / res;

export const sessionKey = (start, type) => `${start}${type}`;

export function sessionStartMs(start, type) {
  return tpeMs(start, SESSION[type].start);
}

export function sessionEndMs(start, type) {
  return sessionStartMs(start, type) + SESSION[type].length * MIN;
}

/** 合約到期日：該月第三個星期三（遇假日順延由資料覆寫） */
export function thirdWednesday(yyyymm) {
  const first = `${yyyymm}01`;
  const wd = weekdayOf(first);
  const offset = (3 - wd + 7) % 7; // 第一個星期三
  return addDays(first, offset + 14);
}

export function nextMonth(yyyymm) {
  let y = Number(yyyymm.slice(0, 4)), m = Number(yyyymm.slice(4, 6)) + 1;
  if (m > 12) { y += 1; m = 1; }
  return `${y}${String(m).padStart(2, "0")}`;
}

/** 依交易日決定近月合約。expiryOverride: { '202602': '20260223' } 等資料觀察到的實際最後交易日 */
export function frontContract(tradingDate, expiryOverride = {}) {
  let month = tradingDate.slice(0, 6);
  for (let i = 0; i < 3; i += 1) {
    const expiry = expiryOverride[month] ?? thirdWednesday(month);
    if (tradingDate <= expiry) return month;
    month = nextMonth(month);
  }
  return month;
}

export function secondContract(tradingDate, expiryOverride = {}) {
  return nextMonth(frontContract(tradingDate, expiryOverride));
}

/** 下一個交易日：優先查已知交易日曆，沒有就假設下一個平日（標示為推估） */
export function nextTradingDate(ymd, calendar = []) {
  const known = calendar.find(d => d > ymd);
  if (known) return { date: known, estimated: false };
  let d = addDays(ymd, 1);
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, 1);
  return { date: d, estimated: true };
}

export function prevTradingDate(ymd, calendar = []) {
  const list = calendar.filter(d => d < ymd);
  if (list.length) return list[list.length - 1];
  let d = addDays(ymd, -1);
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, -1);
  return d;
}

/** 依目前時間判斷：正在進行或下一個要開始的盤 */
export function sessionAt(nowMs, calendar = []) {
  const { ymd, minute, weekday } = partsOf(nowMs);
  const isWeekday = weekday >= 1 && weekday <= 5;
  // 日盤進行中
  if (isWeekday && minute >= SESSION.D.start && minute < SESSION.D.start + SESSION.D.length) {
    return { start: ymd, type: "D", live: true };
  }
  // 夜盤（前一天晚上開始）進行中：00:00–05:00
  if (minute < 5 * 60) {
    const prev = addDays(ymd, -1), wd = weekdayOf(prev);
    if (wd >= 1 && wd <= 5) return { start: prev, type: "N", live: true };
  }
  if (isWeekday && minute >= SESSION.N.start) return { start: ymd, type: "N", live: true };
  // 休息中：找下一個盤
  if (isWeekday && minute < SESSION.D.start) return { start: ymd, type: "D", live: false };
  if (isWeekday && minute >= SESSION.D.start + SESSION.D.length && minute < SESSION.N.start) return { start: ymd, type: "N", live: false };
  const next = nextTradingDate(ymd, calendar).date;
  return { start: next, type: "D", live: false };
}

function partsOf(ms) {
  const t = new Date(ms + 8 * 3600_000);
  return {
    ymd: `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`,
    minute: t.getUTCHours() * 60 + t.getUTCMinutes(),
    weekday: t.getUTCDay(),
  };
}

/** 夜盤歸屬交易日 = 開始日的下一個交易日；日盤 = 當天 */
export function tradingDateOf(start, type, calendar = []) {
  return type === "D" ? { date: start, estimated: false } : nextTradingDate(start, calendar);
}
