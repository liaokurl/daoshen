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

// ================= 戰神帶狀翻向通知（ntfy 推播）=================
// 每分鐘檢查一次微台 5 分K；帶狀「2 根收在另一側」翻向時推播到手機。
// 設定：把 NTFY_TOPIC 改成你訂閱的主題，然後在編輯器執行一次 setupMonitor。
const NTFY_TOPIC = '請換成你的推播主題';
const APP_URL = 'https://liaokurl.github.io/daoshen/';
const NOTIFY_WARN = false;   // true＝第 1 根收在另一側時也先預警

function setupMonitor() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'monitor').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('monitor').timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().deleteProperty('zs');
  monitor();
  notify_('刀神×葵哥 通知已開啟', '之後戰神帶狀翻多／翻空會推播到這裡。', 'white_check_mark', 3);
}

function stopMonitor() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'monitor').forEach(t => ScriptApp.deleteTrigger(t));
}

function testNotify() { notify_('測試｜戰神帶狀翻多', '微台 46,626（11:05 收）\n上軌 46,681／下軌 46,592', 'red_circle', 4); }

/** 台北時間是否在交易時段（含收盤後幾分鐘，讓最後一根能確認） */
function inSession_() {
  const t = new Date(Date.now() + 8 * 3600000), wd = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  const day = wd >= 1 && wd <= 5 && m >= 8 * 60 + 45 && m <= 13 * 60 + 52;
  const nightEve = wd >= 1 && wd <= 5 && m >= 15 * 60;
  const nightMorning = wd >= 2 && wd <= 6 && m <= 5 * 60 + 7;
  return day || nightEve || nightMorning;
}

function monitor() {
  if (!inSession_()) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const d = chartData_('WTM&');
    if (d.error) return;
    const props = PropertiesService.getScriptProperties();
    const st = JSON.parse(props.getProperty('zs') || '{"bars":[],"dir":0,"pend":0,"cnt":0,"lastT":0}');
    // 1 分K → 5 分K（Yahoo 時間是分鐘結束）
    const ts = d.timestamp || [], q = d.indicators.quote[0];
    const map = {};
    let lastMin = 0;
    for (let i = 0; i < ts.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if ([o, h, l, c].some(v => v == null)) continue;
      const start = ts[i] * 1000 - 60000;
      lastMin = Math.max(lastMin, start);
      const k = Math.floor(start / 300000) * 300000;
      const b = map[k];
      if (!b) map[k] = { t: k, o: o, h: h, l: l, c: c, last: start };
      else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); if (start >= b.last) { b.c = c; b.last = start; } }
    }
    // 只用已收完的 5 分K
    const fresh = Object.keys(map).map(k => map[k]).filter(b => b.t + 300000 <= lastMin + 60000).sort((a, b) => a.t - b.t);
    const byT = {};
    st.bars.forEach(b => { byT[b.t] = b; });
    fresh.forEach(b => { byT[b.t] = { t: b.t, h: b.h, l: b.l, c: b.c }; });
    const bars = Object.keys(byT).map(k => byT[k]).sort((a, b) => a.t - b.t).slice(-60);
    const first = st.lastT === 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.t <= st.lastT || i < 23) continue;
      const win = bars.slice(i - 23, i + 1);
      const up = wma_(win.map(x => x.h), 24), lo = wma_(win.map(x => x.l), 24);
      const raw = b.c > up ? 1 : b.c < lo ? -1 : 0;
      if (raw !== 0 && raw !== st.dir) { st.pend = raw; st.cnt += 1; }
      else if (raw !== 0 && raw === st.dir) { st.pend = 0; st.cnt = 0; }
      const timeTxt = Utilities.formatDate(new Date(b.t + 300000), 'Asia/Taipei', 'HH:mm');
      if (st.pend && st.cnt >= 2) {
        const was = st.dir;
        st.dir = st.pend; st.pend = 0; st.cnt = 0;
        if (!first && was !== 0) notify_(`戰神帶狀翻${st.dir > 0 ? '多' : '空'}｜微台 ${fmt_(b.c)}`, `${timeTxt} 收盤確認（第 2 根收在帶狀${st.dir > 0 ? '上方' : '下方'}）\n上軌 ${fmt_(up)}／下軌 ${fmt_(lo)}`, st.dir > 0 ? 'red_circle' : 'green_circle', 5);
      } else if (!first && NOTIFY_WARN && st.pend && st.cnt === 1) {
        notify_(`預警｜帶狀可能翻${st.pend > 0 ? '多' : '空'}`, `${timeTxt} 第 1 根收在帶狀${st.pend > 0 ? '上方' : '下方'}，再 1 根就翻向\n微台 ${fmt_(b.c)}`, 'warning', 3);
      }
      st.lastT = b.t;
    }
    st.bars = bars.slice(-40);
    props.setProperty('zs', JSON.stringify(st));
  } finally {
    lock.releaseLock();
  }
}

function wma_(arr, n) { let a = 0; for (let k = 0; k < n; k++) a += arr[arr.length - 1 - k] * (n - k); return a / (n * (n + 1) / 2); }
function fmt_(v) { return Math.round(v).toLocaleString('en-US'); }

function notify_(title, message, tag, priority) {
  if (!NTFY_TOPIC || NTFY_TOPIC.indexOf('請換成') === 0) return;
  UrlFetchApp.fetch('https://ntfy.sh', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ topic: NTFY_TOPIC, title: title, message: message, tags: [tag], priority: priority, click: APP_URL }),
  });
}
