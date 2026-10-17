// 刀神×葵哥：TradingView 快訊接收器（貼到 Google 試算表的 Apps Script）
// TradingView 快訊 → Webhook → 這裡存進「快訊」工作表 → App 讀取最新 20 則
const KEY = '請換成你自己的一串密碼';   // Webhook 網址要帶 ?key=這串，避免別人亂送
const SHEET = '快訊';

function doPost(e) {
  if (!e || !e.parameter || e.parameter.key !== KEY) return ContentService.createTextOutput('forbidden');
  const body = e.postData ? e.postData.contents : '';
  sheet_().appendRow([new Date(), body]);
  return ContentService.createTextOutput('ok');
}

function doGet(e) {
  const limit = Math.min(100, Number(e && e.parameter && e.parameter.limit) || 20);
  const sh = sheet_();
  const n = sh.getLastRow();
  const count = Math.min(limit, Math.max(0, n - 1));
  const rows = count ? sh.getRange(n - count + 1, 1, count, 2).getValues() : [];
  const items = rows.reverse().map(r => ({ at: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), text: String(r[1]) }));
  return ContentService.createTextOutput(JSON.stringify({ items: items })).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) { sh = ss.insertSheet(SHEET); sh.appendRow(['時間', '內容']); }
  return sh;
}

// 在編輯器按「執行 → testPost」可以先塞一筆假快訊測試
function testPost() {
  doPost({ parameter: { key: KEY }, postData: { contents: '測試\n多單進場，點位46500' } });
}
