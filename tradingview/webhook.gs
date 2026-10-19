// 刀神×葵哥：即時行情中繼站＋TradingView 快訊接收器（貼到 Google 試算表的 Apps Script）
// 1. App 按「更新」→ 這裡向 Yahoo 抓台指期近一／微型台指近一分K → 回傳給 App（瀏覽器不能直接讀 Yahoo）
// 2. TradingView 快訊 → Webhook → 存進「快訊」工作表 → App 讀取最新 20 則
const KEY = '請換成你自己的一串密碼';   // TradingView Webhook 網址要帶 ?key=這串，避免別人亂送
const SHEET = '快訊';
const SYMBOLS = { 'WTX&': 1, 'WTM&': 1 };   // 只允許這兩個代號，避免被拿去當萬用代理

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'chart') return chart_(p.symbol || 'WTX&');
  if (p.action === 'charts') return json_({ WTX: chartData_('WTX&'), WTM: chartData_('WTM&'), at: new Date().toISOString() });
  return signals_(p);
}

function doPost(e) {
  if (!e || !e.parameter || e.parameter.key !== KEY) return ContentService.createTextOutput('forbidden');
  const body = e.postData ? e.postData.contents : '';
  sheet_().appendRow([new Date(), body]);
  return ContentService.createTextOutput('ok');
}

function chartData_(symbol) {
  if (!SYMBOLS[symbol]) return { error: 'symbol not allowed' };
  const url = 'https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.chart;symbol=' + encodeURIComponent(symbol) + '?bkt=&device=desktop&ecma=modern&feature=ecmaModern';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'accept': 'application/json', 'accept-language': 'zh-TW' } });
  if (res.getResponseCode() !== 200) return { error: 'HTTP ' + res.getResponseCode() };
  const j = JSON.parse(res.getContentText());
  // 只回傳 App 需要的欄位，縮小傳輸量
  return { timestamp: j.timestamp, indicators: { quote: [{ open: j.indicators.quote[0].open, high: j.indicators.quote[0].high, low: j.indicators.quote[0].low, close: j.indicators.quote[0].close, volume: j.indicators.quote[0].volume }] }, meta: { regularMarketPrice: j.meta && j.meta.regularMarketPrice, regularMarketTime: j.meta && j.meta.regularMarketTime }, quote: { price: j.quote && j.quote.price, refreshedTs: j.quote && j.quote.refreshedTs } };
}

function chart_(symbol) { return json_(chartData_(symbol)); }

function signals_(p) {
  const limit = Math.min(100, Number(p.limit) || 20);
  const sh = sheet_();
  const n = sh.getLastRow();
  const count = Math.min(limit, Math.max(0, n - 1));
  const rows = count ? sh.getRange(n - count + 1, 1, count, 2).getValues() : [];
  const items = rows.reverse().map(r => ({ at: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), text: String(r[1]) }));
  return json_({ items: items });
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) { sh = ss.insertSheet(SHEET); sh.appendRow(['時間', '內容']); }
  return sh;
}

// 在編輯器選 testChart 按「執行」：第一次會要求授權，之後看執行紀錄有沒有抓到價格
function testChart() {
  const d = chartData_('WTM&');
  Logger.log(d.error || ('微台最新價 ' + d.quote.price + '，分K ' + d.timestamp.length + ' 根'));
}
