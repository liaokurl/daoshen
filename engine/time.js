// 台北時間工具。台灣沒有日光節約，固定 UTC+8。
export const TPE_OFFSET = 8 * 3600_000;
export const MIN = 60_000;

/** YYYYMMDD + 分鐘數（台北）→ epoch ms */
export function tpeMs(ymd, minuteOfDay = 0) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(4, 6)) - 1, d = Number(ymd.slice(6, 8));
  return Date.UTC(y, m, d) - TPE_OFFSET + minuteOfDay * MIN;
}

/** epoch ms → 台北 { ymd, minute, weekday } */
export function tpeParts(ms) {
  const t = new Date(ms + TPE_OFFSET);
  const ymd = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
  return { ymd, minute: t.getUTCHours() * 60 + t.getUTCMinutes(), weekday: t.getUTCDay() };
}

export function addDays(ymd, days) {
  return tpeParts(tpeMs(ymd) + days * 86_400_000).ymd;
}

export function weekdayOf(ymd) {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))).getUTCDay();
}

export function fmtYmd(ymd) {
  return `${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`;
}

export function fmtTime(ms) {
  const p = tpeParts(ms);
  return `${String(Math.floor(p.minute / 60)).padStart(2, "0")}:${String(p.minute % 60).padStart(2, "0")}`;
}

export function fmtDateTime(ms) {
  const p = tpeParts(ms);
  return `${p.ymd.slice(4, 6)}/${p.ymd.slice(6, 8)} ${fmtTime(ms)}`;
}
