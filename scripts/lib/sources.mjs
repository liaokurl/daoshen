// 外部資料來源（只在 GitHub Actions 主機上執行）。
const UA = "Mozilla/5.0 (daoshen-plan; +https://github.com/liaokurl/daoshen)";

export function decodeBig5(buf) {
  return new TextDecoder("big5").decode(buf);
}

export async function fetchBuffer(url, init = {}, { retries = 2, timeoutMs = 60_000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const res = await fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP_${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

export const taifexDailyZipUrl = ymd =>
  `https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_${ymd.slice(0, 4)}_${ymd.slice(4, 6)}_${ymd.slice(6, 8)}.zip`;

/** 期交所「期貨每日交易行情」下載（含一般、盤後兩個時段，各合約月份）。日期格式 YYYY/MM/DD */
export async function fetchFutDataDown(commodity, start, end) {
  const body = new URLSearchParams({ down_type: "1", commodity_id: commodity, commodity_id2: "", queryStartDate: start, queryEndDate: end });
  const buf = await fetchBuffer("https://www.taifex.com.tw/cht/3/futDataDown", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/csv,text/plain,*/*" },
    body,
  });
  const text = decodeBig5(buf).replace(/^﻿/, "");
  if (!text.startsWith("交易日期")) throw new Error(`FUTDATADOWN_NOT_CSV: ${text.slice(0, 120)}`);
  return text;
}

/** Yahoo 奇摩股市 台指期近一（WTX&）分鐘走勢 */
export async function fetchYahooChart(symbol = "WTX&") {
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.chart;symbol=${encodeURIComponent(symbol)}?bkt=&device=desktop&ecma=modern&feature=ecmaModern`;
  const buf = await fetchBuffer(url, { headers: { accept: "application/json", "accept-language": "zh-TW,zh;q=0.9" } }, { retries: 1, timeoutMs: 20_000 });
  return JSON.parse(buf.toString("utf8"));
}

/** 期交所 台指選擇權 Put/Call Ratio（比率欄位是百分比，這裡換成倍數） */
export async function fetchPcr(start, end) {
  const body = new URLSearchParams({ down_type: "", queryStartDate: start, queryEndDate: end });
  const text = decodeBig5(await fetchBuffer("https://www.taifex.com.tw/cht/3/pcRatioDown", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }));
  if (!text.startsWith("日期")) throw new Error(`PCR_NOT_CSV: ${text.slice(0, 80)}`);
  return text.split(/\r?\n/).slice(1).filter(Boolean).map(l => {
    const r = l.split(",");
    return { date: r[0].replace(/\D/g, ""), putVol: Number(r[1]), callVol: Number(r[2]), ratioVol: Number(r[3]) / 100, putOI: Number(r[4]), callOI: Number(r[5]), ratioOI: Number(r[6]) / 100 };
  }).filter(r => /^\d{8}$/.test(r.date) && Number.isFinite(r.ratioVol)).sort((a, b) => a.date.localeCompare(b.date));
}

/** CNN Fear & Greed（美股情緒） */
export async function fetchFearGreed() {
  const buf = await fetchBuffer("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", accept: "application/json", referer: "https://edition.cnn.com/" } }, { retries: 1, timeoutMs: 20_000 });
  const j = JSON.parse(buf.toString("utf8")).fear_and_greed;
  return { score: j.score, rating: j.rating, timestamp: j.timestamp, previousClose: j.previous_close, week: j.previous_1_week, month: j.previous_1_month };
}
