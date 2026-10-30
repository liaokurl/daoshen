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
  try { sniperPost_(body); } catch (err) { console.warn('狙擊快訊處理失敗：' + err); }
  // TradingView 快訊（狙擊、傑哥…）也轉寄 Email；取樣器的資料不寄
  // 狙擊快訊只拿來做「雙重確認」，不另外轉發，避免通知太多
  if (body && body.indexOf('戰神通道') < 0 && !sniperSide_(body) && !/狙擊|Sniper/.test(body)) notify_('TradingView 快訊｜' + body.slice(0, 60), body, 'bell', 4);
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

// ================= 推播（ntfy）：戰神帶狀翻向＋多空主開關轉向 =================
// 每分鐘檢查一次微台 5 分K；帶狀「2 根收在另一側」翻向時推播到手機。
// 設定：把 NTFY_TOPIC 改成你訂閱的主題，然後在編輯器執行一次 setupMonitor。
const NTFY_TOPIC = '請換成你的推播主題';
const APP_URL = 'https://liaokurl.github.io/daoshen/';
const NOTIFY_WARN = false;   // true＝第 1 根收在另一側時也先預警
const NOTIFY_EMAIL = '';      // 也寄 Gmail 的話填你的信箱（留空＝不寄）
const TG_TOKEN = '';          // Telegram 機器人權杖（@BotFather 給的）；留空＝不用 Telegram
const TG_CHAT = '';           // 指定聊天室／群組編號（群組是負數）；留空＝自動抓最近傳話給機器人的聊天室

function setupMonitor() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'monitor').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('monitor').timeBased().everyMinutes(1).create();
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('zs');
  props.deleteProperty('ce');
  const seeded = ceSeed_();
  monitor();
  const st = JSON.parse(props.getProperty('ce') || '{}');
  notify_('刀神×葵哥 通知已開啟', '之後「多空主開關（60 分K 吊燈）」轉多／轉空、戰神帶狀翻向都會推播到這裡。\n' + (seeded ? '主開關目前：' + (st.dir > 0 ? '多' : st.dir < 0 ? '空' : '未定') + '（已載入 ' + st.bars.length + ' 根 60 分K）' : '⚠ 讀不到 App 的歷史資料，主開關要等累積 36 根 60 分K 才會開始'), 'white_check_mark', 3);
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
    try { rollFix_(props); } catch (err) { console.warn('換月處理失敗：' + err); }
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
      if (raw !== 0 && raw !== st.dir) { st.cnt = raw === st.pend ? st.cnt + 1 : 1; st.pend = raw; }
      else if (raw !== 0 && raw === st.dir) { st.pend = 0; st.cnt = 0; }
      const timeTxt = Utilities.formatDate(new Date(b.t + 300000), 'Asia/Taipei', 'HH:mm');
      if (st.pend && st.cnt >= 2) {
        const was = st.dir;
        st.dir = st.pend; st.pend = 0; st.cnt = 0;
        props.setProperty('zsFlip', JSON.stringify({ t: b.t + 300000, side: st.dir, px: b.c, ce: (JSON.parse(props.getProperty('ce') || '{}').dir || 0) }));
        const er = effRatio_(bars.slice(0, i + 1).map(x => x.c));
        if (!first) notify_((er != null && er >= CHASE_ER ? '⛔ 追價別進｜' : '') + entryTitle_(st.dir, b.c), entryBody_(st.dir, b.c, timeTxt, up, lo, props, d, b.t + 300000, er), st.dir > 0 ? 'red_circle' : 'green_circle', 5);
      } else if (!first && NOTIFY_WARN && st.pend && st.cnt === 1) {
        notify_(`預警｜帶狀可能翻${st.pend > 0 ? '多' : '空'}`, `${timeTxt} 第 1 根收在帶狀${st.pend > 0 ? '上方' : '下方'}，再 1 根就翻向\n微台 ${fmt_(b.c)}`, 'warning', 3);
      }
      st.lastT = b.t;
    }
    st.bars = bars.slice(-40);
    props.setProperty('zs', JSON.stringify(st));
    ceUpdate_(d, props);
    try { h30Update_(d, props); } catch (err) { console.warn('30 分K 更新失敗：' + err); }
    try { springMinutes_(d, props); } catch (err) { console.warn('破底翻 5／15 分失敗：' + err); }
  } finally {
    lock.releaseLock();
  }
}

// 追價濾網：近 24 根 5 分K 效率＝淨走幅 ÷ 來回總走幅。回測 9/2～10/30：效率 ≥ 0.2 才翻向的單拿掉後，停利 180 由 −131 → +1,971 點、最大回落 −2,037 → −855
const CHASE_ER = 0.2, CHASE_BARS = 24;
function effRatio_(closes) {
  const n = closes.length; if (n <= CHASE_BARS) return null;
  let s = 0; for (let k = n - CHASE_BARS; k < n; k++) s += Math.abs(closes[k] - closes[k - 1]);
  return s ? Math.abs(closes[n - 1] - closes[n - 1 - CHASE_BARS]) / s : 0;
}
function chaseLine_(er) {
  if (er == null) return '';
  return er >= CHASE_ER
    ? '⛔ 追價：翻向前 2 小時已單邊走（效率 ' + er.toFixed(2) + ' ≥ ' + CHASE_ER + '），回測跳過比較好，這筆不做'
    : '✅ 不是追價（翻向前 2 小時來回震盪，效率 ' + er.toFixed(2) + '）';
}
function wma_(arr, n) { let a = 0; for (let k = 0; k < n; k++) a += arr[arr.length - 1 - k] * (n - k); return a / (n * (n + 1) / 2); }
function fmt_(v) { return Math.round(v).toLocaleString('en-US'); }

function notify_(title, message, tag, priority) {
  if (TG_TOKEN) {
    try { telegram_(title, message); } catch (err) { console.warn('Telegram 失敗：' + err); }
  }
  if (NOTIFY_EMAIL) {
    try {
      // 同一天的通知用同一個標題，Gmail 會疊成一串，不會洗版
      const day = Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd');
      MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: '【刀神×葵哥】' + day + ' 通知', body: title + '\n' + message + '\n\n打開 App：' + APP_URL, name: '刀神×葵哥' });
    } catch (err) { console.warn('寄信失敗：' + err); }
  }
  if (!NTFY_TOPIC || NTFY_TOPIC.indexOf('請換成') === 0) return;
  try {
    UrlFetchApp.fetch('https://ntfy.sh', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ topic: NTFY_TOPIC, title: title, message: message, tags: [tag], priority: priority, click: APP_URL }),
    });
  } catch (err) { console.warn('ntfy 推播失敗：' + err); }
}

// ================= 多空主開關：60 分K 吊燈出場 Chandelier Exit(22,3) =================
// 跟 App 刀神分頁最上面那張卡同一套規則；60 分K 收盤轉多／轉空時推播。
// 歷史 60 分K 由 App 網站的資料（微台連續月、已做換月調整）載入，之後每分鐘用 Yahoo 分K 接上。
const CE_N = 22, CE_M = 3, CE_KEEP = 120;
const H = 3600000;

/** 台北時間的交易時段起點（毫秒）；不在盤中回傳 null */
function sessionStartOf_(ms) {
  const t = new Date(ms + 8 * H), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  const day0 = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - 8 * H;   // 台北當天 00:00
  if (m >= 8 * 60 + 45 && m < 13 * 60 + 45) return day0 + (8 * 60 + 45) * 60000;
  if (m >= 15 * 60) return day0 + 15 * H;
  if (m < 5 * 60) return day0 - 9 * H;   // 前一天 15:00
  return null;
}
/** 60 分K 的起點（每盤從開盤起算：日盤 08:45、09:45…；夜盤 15:00、16:00…） */
function hourKey_(ms) { const s = sessionStartOf_(ms); return s == null ? null : s + Math.floor((ms - s) / H) * H; }
/** Yahoo 把週五夜盤標成週日、週六凌晨標成週一：拉回 2 天 */
function fixYahoo_(ms) {
  const t = new Date(ms + 8 * H), wd = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  if ((wd === 0 && m >= 15 * 60) || (wd === 1 && m < 5 * 60 + 5)) return ms - 48 * H;
  return ms;
}

/** 從 App 網站載入近 12 個交易日的微台 5 分K → 60 分K */
function ceSeed_() {
  const res = UrlFetchApp.fetch(APP_URL + 'data/bundle.json?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return false;
  const B = JSON.parse(res.getContentText());
  const bars = ceSeedBars_(B.tmf5 || []);
  if (bars.length < CE_N + 5) return false;
  const props = PropertiesService.getScriptProperties();
  const st = { bars: bars.slice(-CE_KEEP), dir: 0, lastT: 0 };
  const e = chandelier_(st.bars);
  st.dir = e.dir; st.lastT = st.bars[st.bars.length - 1].t;
  props.setProperty('ce', JSON.stringify(st));
  return true;
}

/** tmf5 紀錄（每盤一筆，bars 為 5 分K 陣列，null＝沒成交）→ 60 分K；沒成交的格子沿用前收，跟 App 一樣 */
function ceSeedBars_(recs, per, span) {
  per = per || 12; span = span || H;
  const out = [];
  recs.filter(r => r.complete !== false).forEach(r => {
    const y = +r.start.slice(0, 4), mo = +r.start.slice(4, 6) - 1, d = +r.start.slice(6, 8);
    const base = Date.UTC(y, mo, d) - 8 * H + (r.type === 'D' ? (8 * 60 + 45) * 60000 : 15 * H);
    const first = r.bars.find(b => b);
    if (!first) return;
    let last = first[0], cur = null;
    r.bars.forEach((b, i) => {
      const k = base + Math.floor(i / per) * span;
      const v = b || [last, last, last, last];
      last = v[3];
      if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, h: v[1], l: v[2], c: v[3] }; }
      else { cur.h = Math.max(cur.h, v[1]); cur.l = Math.min(cur.l, v[2]); cur.c = v[3]; }
    });
    if (cur) out.push(cur);
  });
  return out.sort((a, b) => a.t - b.t);
}

/** Chandelier Exit：照 TradingView 版本（ATR 用 RMA、最高最低用收盤），回傳最後方向、防守線與轉向紀錄 */
function chandelier_(bars) {
  const n = CE_N, m = CE_M, C = bars.map(b => b.c);
  let atr = null, trSum = 0, trCnt = 0, dir = 0, ls = null, ss = null;
  const flips = [];
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - C[i - 1]), Math.abs(bars[i].l - C[i - 1]));
      if (atr == null) { trSum += tr; trCnt++; if (trCnt === n) atr = trSum / n; }
      else atr = (tr + (n - 1) * atr) / n;
    }
    if (atr == null || i < n - 1) continue;
    const win = C.slice(i - n + 1, i + 1);
    let l = Math.max.apply(null, win) - m * atr, s = Math.min.apply(null, win) + m * atr;
    const pl = ls == null ? l : ls, ps = ss == null ? s : ss;
    if (C[i - 1] > pl) l = Math.max(l, pl);
    if (C[i - 1] < ps) s = Math.min(s, ps);
    const nd = C[i] > ps ? 1 : C[i] < pl ? -1 : (dir || (C[i] >= (l + s) / 2 ? 1 : -1));
    if (nd !== dir) { if (dir !== 0) flips.push({ t: bars[i].t, side: nd, price: C[i] }); dir = nd; }
    ls = l; ss = s;
  }
  return { dir: dir, longStop: ls, shortStop: ss, flips: flips };
}

/** 每分鐘：把 Yahoo 1 分K 併成已收完的 60 分K，算吊燈，轉向就推播 */
function ceUpdate_(d, props) {
  let st = JSON.parse(props.getProperty('ce') || 'null');
  if (!st || !st.bars || st.bars.length < CE_N + 5) { if (!ceSeed_()) return; st = JSON.parse(props.getProperty('ce')); }
  const ts = d.timestamp || [], q = d.indicators.quote[0];
  const map = {};
  let lastMin = 0;
  for (let i = 0; i < ts.length; i++) {
    const h = q.high[i], l = q.low[i], c = q.close[i];
    if ([h, l, c].some(v => v == null)) continue;
    const start = fixYahoo_(ts[i] * 1000 - 60000);
    const k = hourKey_(start);
    if (k == null) continue;
    lastMin = Math.max(lastMin, start);
    const b = map[k];
    if (!b) map[k] = { t: k, h: h, l: l, c: c, first: start, last: start };
    else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); if (start >= b.last) { b.c = c; b.last = start; } b.first = Math.min(b.first, start); }
  }
  const byT = {};
  st.bars.forEach(b => { byT[b.t] = b; });
  let added = false;
  Object.keys(map).map(k => map[k]).forEach(b => {
    const end = b.t + H, sEnd = sessionStartOf_(b.t) + (new Date(b.t + 8 * H).getUTCHours() >= 15 || new Date(b.t + 8 * H).getUTCHours() < 5 ? 14 : 5) * H;
    const done = Math.min(end, sEnd) <= lastMin + 60000;   // 這根 60 分K 已收完
    const whole = b.first <= b.t + 5 * 60000;               // Yahoo 資料有涵蓋這根的開頭
    if (done && whole && b.t > st.lastT) { byT[b.t] = { t: b.t, h: b.h, l: b.l, c: b.c }; added = true; }
  });
  if (!added) return;
  const bars = Object.keys(byT).map(k => byT[k]).sort((a, b) => a.t - b.t).slice(-CE_KEEP);
  const e = chandelier_(bars);
  const last = bars[bars.length - 1];
  if (st.dir !== 0 && e.dir !== st.dir) {
    const timeTxt = Utilities.formatDate(new Date(last.t + H), 'Asia/Taipei', 'MM/dd HH:mm');
    const line = e.dir > 0 ? e.longStop : e.shortStop;
    notify_(`🔔 主開關轉${e.dir > 0 ? '多' : '空'}｜微台 ${fmt_(last.c)}`,
      `${timeTxt} 60 分K 收盤${e.dir > 0 ? '站上空方防守線' : '跌破多方防守線'}\n之後只找${e.dir > 0 ? '多' : '空'}單；60 分K 收盤${e.dir > 0 ? '跌破' : '站上'} ${fmt_(line)} 才再轉向` + reentryLine_(e.dir, props),
      e.dir > 0 ? 'red_circle' : 'green_circle', 5);
  }
  st.bars = bars; st.dir = e.dir; st.lastT = last.t;
  props.setProperty('ce', JSON.stringify(st));
  try { swingNotify_(bars, 60, props); } catch (err) { console.warn('前低檢查失敗：' + err); }
}

/** 主開關轉向時，傑哥帶狀如果已經同方向＝補進場；順便判斷是不是追價 */
function reentryLine_(dir, props) {
  const zs = JSON.parse(props.getProperty('zs') || '{}');
  if (zs.dir !== dir || !zs.bars) return '';
  const er = effRatio_(zs.bars.map(x => x.c));
  return '\n\n傑哥帶狀已經同方向' + (er != null && er >= CHASE_ER ? '，但' + chaseLine_(er).replace('⛔ 追價：', '⛔ 屬於追價：') : '→ 可補進場\n' + chaseLine_(er));
}

/** 在編輯器執行：看主開關目前狀態（不推播） */
function testCe() {
  const ok = ceSeed_();
  const st = JSON.parse(PropertiesService.getScriptProperties().getProperty('ce') || '{}');
  const e = st.bars ? chandelier_(st.bars) : null;
  Logger.log(ok ? `主開關：${e.dir > 0 ? '多' : '空'}｜多方防守線 ${fmt_(e.longStop)}／空方防守線 ${fmt_(e.shortStop)}｜最後一根 ${Utilities.formatDate(new Date(st.lastT), 'Asia/Taipei', 'MM/dd HH:mm')} 收 ${fmt_(st.bars[st.bars.length - 1].c)}` : '讀不到 App 資料');
}

/** 第一次用 Gmail 通知：執行這個，會跳出授權（要勾選「傳送電子郵件」），然後寄一封測試信 */
function setupEmail() {
  Logger.log('今天還能寄 ' + MailApp.getRemainingDailyQuota() + ' 封');
  MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: '【刀神×葵哥】Gmail 通知已開啟', body: '之後多空主開關轉向、戰神帶狀翻向都會寄到這裡。\n\n打開 App：' + APP_URL, name: '刀神×葵哥' });
}

// ================= Telegram =================
// 設定：把 TG_TOKEN 填上，先在 Telegram 對你的機器人按「開始」並傳一句話，再執行一次 setupTelegram
function tgChatId_() {
  if (TG_CHAT) return TG_CHAT;
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('tgChat');
  if (id) return id;
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates', { muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText());
  const ups = (j.result || []).filter(u => u.message && u.message.chat);
  if (!ups.length) return null;
  id = String(ups[ups.length - 1].message.chat.id);
  props.setProperty('tgChat', id);
  return id;
}
function esc_(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function telegram_(title, message) {
  const chat = tgChatId_();
  if (!chat) { console.warn('還沒拿到 Telegram 聊天室：請先對機器人傳一句話'); return; }
  const text = '<b>' + esc_(title) + '</b>\n' + esc_(message) + '\n<a href="' + APP_URL + '">打開 App</a>\n<i>僅供參考，非投資建議</i>';
  UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ chat_id: chat, text: text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
}
function setupTelegram() {
  PropertiesService.getScriptProperties().deleteProperty('tgChat');
  const chat = tgChatId_();
  Logger.log(chat ? '找到聊天室 ' + chat : '找不到：請先在 Telegram 對機器人按「開始」並傳一句話，再執行一次');
  if (chat) telegram_('✅ 刀神×葵哥 通知已接上 Telegram', '之後帶狀翻向、主開關轉向、TradingView 快訊都會傳到這裡。');
}

// ================= 進場訊息格式（帶狀翻向） =================
// 目標用固定點數：回測 9/2～10/19 微台 5 分K，只做順主開關的翻向時，+20 點達標率約 90%、+80 點約 59%（未達標就在下一次反向翻時出場）
const TP1 = 20, TP2 = 80, TRAIL = 180;   // 回測（9/2～10/20，順主開關）：移動停利 180 合計 +1,621 點、140 合計 +2,866 點
function entryTitle_(dir, px) { return (dir > 0 ? '🔴 進場多單 ' : '🟢 進場空單 ') + fmt_(px); }
function entryBody_(dir, px, timeTxt, up, lo, props, d, at, er) {
  const ce = JSON.parse(props.getProperty('ce') || '{}').dir || 0;
  const with_ = ce === dir;
  return [
    chaseLine_(er),
    '🛡 智慧單：移動停利 ' + TRAIL + ' 點（初始停損 ' + fmt_(px - dir * TRAIL) + '）',
    targetLine_(dir, px, d, at),
    (with_ ? '✅ 順主開關（60 分K 吊燈＝' : '⚠️ 逆主開關（60 分K 吊燈＝') + (ce > 0 ? '多' : ce < 0 ? '空' : '未定') + '）' + (with_ ? '' : '，回測逆勢這側勝率低，建議不做'),
    dualLine_(dir, props),
    '',
    '戰神帶狀 5 分K｜' + timeTxt + ' 收盤確認',
    '上軌 ' + fmt_(up) + '／下軌 ' + fmt_(lo),
  ].join('\n');
}
function testEntry() { const p = PropertiesService.getScriptProperties(), d = chartData_('WTM&'), px = Number(d.quote && d.quote.price) || 47000; notify_('【測試】' + entryTitle_(1, px), entryBody_(1, px, '測試', px + 20, px - 20, p, d, Date.now()), 'red_circle', 4); }

// ================= 前低第二支腳（60 分K 主訊號、30 分K 提早提醒） =================
// 回測 9/2～10/21 微台：60 分K 回測前低且收盤守住，之後先漲 1.5 ATR 的比例 79～87%（隨機價位 50～64%）；30 分K 75～84%（隨機 66～74%）
const SW_PIV = 3, SW_LOOK = 60, SW_TOL = 0.3, H30_KEEP = 140, M30 = 30 * 60000;

function swingSignal_(bars) {
  const N = bars.length; if (N < 20) return null;
  const C = bars.map(b => b.c), Hh = bars.map(b => b.h), Ll = bars.map(b => b.l);
  const tr = bars.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - C[i - 1]), Math.abs(b.l - C[i - 1])) : b.h - b.l);
  const atr = i => { if (i < 14) return null; let a = 0; for (let k = i - 13; k <= i; k++) a += tr[k]; return a / 14; };
  const piv = [];
  for (let i = SW_PIV; i < N - SW_PIV; i++) { let ok = true; for (let k = i - SW_PIV; k <= i + SW_PIV; k++) if (k !== i && Ll[k] < Ll[i]) { ok = false; break; } if (ok) piv.push({ i: i, p: Ll[i], broken: false, touched: false }); }
  let sig = null;
  for (let j = 0; j < N; j++) { const a = atr(j); if (!a) continue; const tol = SW_TOL * a;
    piv.forEach(v => { if (v.broken || v.touched || j <= v.i + SW_PIV || j - v.i > SW_LOOK) return;
      if (Ll[j] < v.p - tol) { v.broken = true; return; }
      if (Ll[j] <= v.p + tol) { v.touched = true; if (C[j] > v.p && j === N - 1) sig = { t: bars[j].t, level: v.p, low: Ll[j], close: C[j], stop: v.p - 0.5 * a, trail: 2 * a }; } }); }
  return sig;
}

function swingNotify_(bars, tf, props) {
  const sig = swingSignal_(bars); if (!sig) return;
  const key = 'swing' + tf; if (Number(props.getProperty(key) || 0) >= sig.t) return;
  props.setProperty(key, String(sig.t));
  const ce = JSON.parse(props.getProperty('ce') || '{}').dir || 0;
  const span = tf === 60 ? H : M30;
  const timeTxt = Utilities.formatDate(new Date(sig.t + span), 'Asia/Taipei', 'MM/dd HH:mm');
  const title = tf === 60 ? '🔴 60分K 前低守住｜做多參考 ' + fmt_(sig.close) : '🟠 30分K 前低守住（提早提醒）' + fmt_(sig.close);
  notify_(title, [
    '📍 回測前低 ' + fmt_(sig.level) + '（最低 ' + fmt_(sig.low) + '），' + timeTxt + ' 收 ' + fmt_(sig.close) + ' 守住',
    '🛡 停損 ' + fmt_(sig.stop) + '｜移動停利約 ' + fmt_(sig.trail) + ' 點',
    ce > 0 ? '✅ 主開關＝多' : ce < 0 ? '⚠️ 主開關＝空（逆勢，小量或等 60 分K 確認）' : '主開關未定',
    tf === 60 ? '回測 60 分K 守住率約 8 成' : '30 分K 只是提早提醒，等 60 分K 收盤確認更穩',
  ].join('\n'), 'red_circle', 4);
}

function h30Key_(ms) { const s = sessionStartOf_(ms); return s == null ? null : s + Math.floor((ms - s) / M30) * M30; }

function h30Update_(d, props) {
  let st = JSON.parse(props.getProperty('h30') || 'null');
  if (!st || !st.bars || st.bars.length < 40) {
    const res = UrlFetchApp.fetch(APP_URL + 'data/bundle.json?t=' + Date.now(), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return;
    const bars0 = ceSeedBars_(JSON.parse(res.getContentText()).tmf5 || [], 6, M30);
    if (bars0.length < 40) return;
    st = { bars: bars0.slice(-H30_KEEP), lastT: bars0[bars0.length - 1].t };
    props.setProperty('h30', JSON.stringify(st));
    return;
  }
  const ts = d.timestamp || [], q = d.indicators.quote[0];
  const map = {}; let lastMin = 0;
  for (let i = 0; i < ts.length; i++) {
    const h = q.high[i], l = q.low[i], c = q.close[i];
    if ([h, l, c].some(v => v == null)) continue;
    const start = fixYahoo_(ts[i] * 1000 - 60000), k = h30Key_(start);
    if (k == null) continue;
    lastMin = Math.max(lastMin, start);
    const b = map[k];
    if (!b) map[k] = { t: k, h: h, l: l, c: c, first: start, last: start };
    else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); if (start >= b.last) { b.c = c; b.last = start; } b.first = Math.min(b.first, start); }
  }
  const byT = {}; st.bars.forEach(b => { byT[b.t] = b; });
  let added = false;
  Object.keys(map).map(k => map[k]).forEach(b => {
    const hr = new Date(b.t + 8 * H).getUTCHours();
    const sEnd = sessionStartOf_(b.t) + (hr >= 15 || hr < 5 ? 14 : 5) * H;
    const done = Math.min(b.t + M30, sEnd) <= lastMin + 60000, whole = b.first <= b.t + 5 * 60000;
    if (done && whole && b.t > st.lastT) { byT[b.t] = { t: b.t, h: b.h, l: b.l, c: b.c }; added = true; }
  });
  if (!added) return;
  const bars = Object.keys(byT).map(k => byT[k]).sort((a, b) => a.t - b.t).slice(-H30_KEEP);
  st.bars = bars; st.lastT = bars[bars.length - 1].t;
  props.setProperty('h30', JSON.stringify(st));
  swingNotify_(bars, 30, props);
  try { springNotify_(bars, 30, props); } catch (err) { console.warn('破底翻 30 分失敗：' + err); }
}

// ================= 雙重確認：狙擊（TradingView 快訊）＋傑哥帶狀，3 根 5 分K 內同方向 =================
// 回測 9/2～10/21：雙重確認＋順主開關，勝率約 44%、每天約 1.4 次（只看帶狀＋主開關是 37%）
const DUAL_MS = 3 * 5 * 60000 + 2 * 60000;   // 3 根 5 分K（多留 2 分鐘給快訊延遲）

function sniperSide_(text) {
  const t = String(text || '');
  if (/停利|出場|平倉/.test(t)) return 0;
  if (/(狙擊|Sniper)[^空]*多|LONG/i.test(t)) return 1;
  if (/(狙擊|Sniper)[^多]*空|SHORT/i.test(t)) return -1;
  return 0;
}

/** 進場訊息裡加一行：最近 3 根內有沒有同方向的狙擊 */
function dualLine_(dir, props) {
  const sn = JSON.parse(props.getProperty('snipe') || 'null');
  if (sn && sn.side === dir && Date.now() - sn.t <= DUAL_MS) return '⭐ 雙重確認：狙擊' + (dir > 0 ? '多' : '空') + '已在 ' + Utilities.formatDate(new Date(sn.t), 'Asia/Taipei', 'HH:mm') + ' 出現（回測勝率較高，可加碼）';
  return '☆ 尚未雙重確認（狙擊還沒同向，3 根 K 內出現會再通知）';
}

/** 收到 TradingView 狙擊快訊：記下來；如果傑哥剛翻同方向（3 根內），補一則「雙重確認成立」 */
function sniperPost_(body) {
  const side = sniperSide_(body); if (!side) return;
  const props = PropertiesService.getScriptProperties();
  props.setProperty('snipe', JSON.stringify({ t: Date.now(), side: side }));
  const f = JSON.parse(props.getProperty('zsFlip') || 'null');
  if (!f || f.side !== side || Date.now() - f.t > DUAL_MS) return;
  if (props.getProperty('dualSent') === String(f.t)) return;
  props.setProperty('dualSent', String(f.t));
  const ce = JSON.parse(props.getProperty('ce') || '{}').dir || 0;
  notify_('⭐ 雙重確認成立｜' + (side > 0 ? '多單' : '空單') + ' ' + fmt_(f.px), [
    '傑哥帶狀 ' + Utilities.formatDate(new Date(f.t), 'Asia/Taipei', 'HH:mm') + ' 翻' + (side > 0 ? '多' : '空') + '（' + fmt_(f.px) + '），狙擊隨後同向',
    '🛡 移動停利 ' + TRAIL + ' 點（停損 ' + fmt_(f.px - side * TRAIL) + '）',
    targetLine_(side, f.px, null, f.t),
    ce === side ? '✅ 順主開關' : '⚠️ 逆主開關，雙重確認也建議小量',
  ].join('\n'), 'star', 5);
}


// ================= 換月：每月第三個週三 13:45 結算後，Yahoo「近一」換成次月合約 =================
// 存著的 5 分K／30 分K／60 分K 都還是舊合約價位，要整段平移「新−舊」價差，不然會出現假突破、假翻向。
// 價差從 App 網站的 bundle.json 拿（GitHub 用期交所兩個合約的日盤收盤算好）。
function tdAt_(ms) {   // 這個時間點屬於哪個交易日（夜盤算下一個交易日；不管國定假日）
  const t = new Date(ms + 8 * H), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  let d = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  if (m >= 15 * 60) d += 24 * H;
  let wd = new Date(d).getUTCDay();
  while (wd === 0 || wd === 6) { d += 24 * H; wd = new Date(d).getUTCDay(); }
  return d;
}
function ym_(d) { const x = new Date(d); return x.getUTCFullYear() * 100 + x.getUTCMonth() + 1; }
function thirdWedOf_(ym) {
  const y = Math.floor(ym / 100), mo = ym % 100 - 1, first = Date.UTC(y, mo, 1);
  return first + (((3 - new Date(first).getUTCDay() + 7) % 7) + 14) * 24 * H;
}
function frontAt_(ms) {
  const td = tdAt_(ms); let ym = ym_(td);
  if (td > thirdWedOf_(ym)) ym = ym % 100 === 12 ? ym + 89 : ym + 1;
  return String(ym);
}
function rollFix_(props) {
  const cur = frontAt_(Date.now());
  if (props.getProperty('contract') === cur) { rollRefine_(props, cur); return; }
  const keys = ['zs', 'ce', 'h30'];
  const states = {}; let stale = false;
  keys.forEach(k => {
    const st = JSON.parse(props.getProperty(k) || 'null');
    states[k] = st;
    if (st && st.bars && st.bars.some(b => frontAt_(b.t) !== cur)) stale = true;
  });
  if (!stale) { props.setProperty('contract', cur); return; }
  const res = UrlFetchApp.fetch(APP_URL + 'data/bundle.json?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;
  const B = JSON.parse(res.getContentText());
  const sp = B.next && B.next.contract === cur ? B.next.spread : B.roll && B.roll.to === cur ? B.roll.spread : null;
  if (sp == null) return;   // 網站還沒算出價差，下一分鐘再試
  keys.forEach(k => {
    const st = states[k];
    if (!st || !st.bars) return;
    st.bars = st.bars.map(b => frontAt_(b.t) === cur ? b : Object.assign({}, b, { h: b.h + sp, l: b.l + sp, c: b.c + sp, o: b.o == null ? b.o : b.o + sp }));
    if (k === 'ce' && st.bars.length > CE_N) st.dir = chandelier_(st.bars).dir;   // 重算主開關，不推播
    props.setProperty(k, JSON.stringify(st));
  });
  const f = JSON.parse(props.getProperty('zsFlip') || 'null');
  if (f && frontAt_(f.t) !== cur) { f.px += sp; props.setProperty('zsFlip', JSON.stringify(f)); }
  props.setProperty('contract', cur);
  props.setProperty('rollSp', String(sp));
  notify_('📅 期貨換月｜' + cur.slice(4) + ' 月合約',
    '近月改成 ' + cur.slice(0, 4) + '/' + cur.slice(4) + '，換月價差 ' + (sp > 0 ? '+' : '') + sp + ' 點\n傑哥帶狀、60 分K 主開關、前低點位都已平移到新合約價位', 'calendar', 3);
}

/** 換月後 3 天內每 15 分鐘：拿網站已平移好的 60 分K 跟自己存的舊合約 K 棒比，有差就補平移（網站價差算得更準時會自動修正） */
function rollRefine_(props, cur) {
  const now = Date.now(), last = Number(props.getProperty('rollChk') || 0);
  if (now - last < 15 * 60000) return;
  const ce = JSON.parse(props.getProperty('ce') || 'null');
  if (!ce || !ce.bars || !ce.bars.some(b => frontAt_(b.t) !== cur)) return;
  props.setProperty('rollChk', String(now));
  const B = JSON.parse(UrlFetchApp.fetch(APP_URL + 'data/bundle.json?t=' + now, { muteHttpExceptions: true }).getContentText() || '{}');
  if (!B.roll || B.roll.to !== cur || B.contract !== cur) return;
  const ref = {};
  ceSeedBars_((B.tmf5 || []).filter(r => r.complete !== false)).forEach(x => { ref[x.t] = x.c; });
  const diffs = ce.bars.filter(x => frontAt_(x.t) !== cur && ref[x.t] != null).map(x => ref[x.t] - x.c).sort((p, q) => p - q);
  if (diffs.length < 5) return;
  const delta = diffs[Math.floor(diffs.length / 2)];
  if (Math.abs(delta) < 3) return;   // Yahoo 跟官方資料本來就會差一兩點
  ['zs', 'ce', 'h30'].forEach(k => {
    const st = JSON.parse(props.getProperty(k) || 'null');
    if (!st || !st.bars) return;
    st.bars = st.bars.map(x => frontAt_(x.t) === cur ? x : Object.assign({}, x, { h: x.h + delta, l: x.l + delta, c: x.c + delta, o: x.o == null ? x.o : x.o + delta }));
    if (k === 'ce' && st.bars.length > CE_N) st.dir = chandelier_(st.bars).dir;
    props.setProperty(k, JSON.stringify(st));
  });
  const f = JSON.parse(props.getProperty('zsFlip') || 'null');
  if (f && frontAt_(f.t) !== cur) { f.px += delta; props.setProperty('zsFlip', JSON.stringify(f)); }
  props.setProperty('rollSp', String(Number(props.getProperty('rollSp') || 0) + delta));
  console.log('換月價差補正 ' + delta);
}

/** 在編輯器執行：看現在判斷的近月合約與換月狀態 */
function testRoll() {
  const p = PropertiesService.getScriptProperties();
  const cur = frontAt_(Date.now()), ce = JSON.parse(p.getProperty('ce') || '{}');
  const old = (ce.bars || []).filter(b => frontAt_(b.t) !== cur).pop();
  console.log('近月 ' + cur + '｜已處理到 ' + p.getProperty('contract') + '｜已平移 ' + p.getProperty('rollSp') +
    '｜舊合約最後一根 60 分K ' + (old ? Utilities.formatDate(new Date(old.t), 'Asia/Taipei', 'MM/dd HH:mm') + ' 收 ' + old.c : '無'));
}


// ================= 參考目標：六層點位（日）的下一階、下下階 =================
// 跟 App「葵哥」分頁的六層「日」一樣：前兩盤的高低當基準，這一盤破高／破底就跟著擴大。
const SIX_MODE = 'D';
const SIX_R = [0.382, 0.618, 0.786, 1, 1.272, 1.618];
function ymdOf_(ms) { return Utilities.formatDate(new Date(ms), 'UTC', 'yyyyMMdd'); }
function sixAnchor_(mode, tdMs) {
  if (mode === 'D') return ymdOf_(tdMs - 24 * H);
  if (mode === 'W') { const back = (new Date(tdMs).getUTCDay() - 3 + 7) % 7 || 7; return ymdOf_(tdMs - back * 24 * H); }
  const ym = ym_(tdMs), tw = thirdWedOf_(ym);
  if (tdMs > tw) return ymdOf_(tw);
  return ymdOf_(thirdWedOf_(ym % 100 === 1 ? ym - 89 : ym - 1));
}
function sixSummaries_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('sixSum');
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch(APP_URL + 'data/bundle.json?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  const rows = (JSON.parse(res.getContentText()).summaries || []).slice(-60).map(x => ({ td: x.td, type: x.type, h: x.h, l: x.l }));
  cache.put('sixSum', JSON.stringify(rows), 600);
  return rows;
}
/** 回傳 { mode, hi, lo, t: [下一階, 下下階] }；at＝訊號時間（毫秒），d＝Yahoo 分K
 *  日＝前兩盤（現在日盤 → 前一天日盤＋昨晚夜盤；現在夜盤 → 今天日盤＋昨晚夜盤）的高低，這一盤到訊號為止破高／破底就納入 */
function sessTypeOf_(ms) { const t = new Date(ms + 8 * H), m = t.getUTCHours() * 60 + t.getUTCMinutes(); return m >= 15 * 60 || m < 5 * 60 + 5 ? 'N' : 'D'; }
function sixTargets_(dir, px, d, at) {
  const sess = {};
  const add = (k, h, l) => { const x = sess[k]; if (!x) sess[k] = { h: h, l: l }; else { x.h = Math.max(x.h, h); x.l = Math.min(x.l, l); } };
  sixSummaries_().forEach(x => add(x.td + (x.type === 'N' ? '0' : '1'), x.h, x.l));
  if (d && d.timestamp) {
    const q = d.indicators.quote[0];
    d.timestamp.forEach((t, i) => {
      const ms = fixYahoo_(t * 1000 - 60000);
      if (q.high[i] == null || ms >= at || sessionStartOf_(ms) == null) return;
      const ty = sessTypeOf_(ms);
      add(ymdOf_(tdAt_(ms)) + (ty === 'N' ? '0' : '1'), q.high[i], q.low[i]);
    });
  }
  const curMs = at - 60000, cur = ymdOf_(tdAt_(curMs)) + (sessTypeOf_(curMs) === 'N' ? '0' : '1');
  const base = Object.keys(sess).filter(k => k < cur).sort().slice(-2);
  if (!base.length) return null;
  let hi = Math.max.apply(null, base.map(k => sess[k].h)), lo = Math.min.apply(null, base.map(k => sess[k].l));
  if (sess[cur]) { hi = Math.max(hi, sess[cur].h); lo = Math.min(lo, sess[cur].l); }
  hi = Math.max(hi, px); lo = Math.min(lo, px);
  if (!(hi > lo)) return null;
  const mid = (hi + lo) / 2, half = hi - mid;
  const lv = [mid].concat(SIX_R.map(r => mid + half * r), SIX_R.map(r => mid - half * r)).map(Math.round).sort((p, q) => p - q);
  const t = dir > 0 ? lv.filter(v => v > px + 1) : lv.filter(v => v < px - 1).reverse();
  return { mode: 'D', hi: hi, lo: lo, t: t.slice(0, 2) };
}
function targetLine_(dir, px, d, at) {
  let r = null;
  try { r = sixTargets_(dir, px, d, at); } catch (err) { console.warn('六層目標失敗：' + err); }
  const pts = v => (v - px > 0 ? '+' : '−') + Math.abs(Math.round(v - px));
  if (!r || !r.t.length) return '🎯 參考目標 ' + fmt_(px + dir * TP1) + '（' + pts(px + dir * TP1) + '）／' + fmt_(px + dir * TP2) + '（' + pts(px + dir * TP2) + '）';
  const name = { D: '日', W: '週', M: '月' }[r.mode];
  return '🎯 六層目標（' + name + '）' + r.t.map(v => fmt_(v) + '（' + pts(v) + '）').join('／') + (r.t.length < 2 ? '，再上去看移動停利' : '');
}


// ================= 破底翻：低點被跌破 → 站回 → 往上 → 回測低點不破（5／15／30 分K） =================
// 回測 9/2～10/27 微台：5／15／30 分K 的破底翻，之後先漲 1R 的比例跟隨機進場差不多（沒有明顯優勢），所以通知只當提醒。
const SPR = { piv: 3, look: 80, breakAtr: 0.1, reclaimBars: 12, rallyAtr: 1.0, retestAtr: 0.35, retestBars: 40 };
function springAtr_(bars) {
  const out = []; let a = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l;
    if (i < 13) { out.push(null); continue; }
    a = a == null ? tr : (a * 13 + tr) / 14; out.push(a);
  }
  return out;
}
/** 回傳最後一根剛好觸發的破底翻（沒有就 null） */
function springLast_(bars) {
  const N = bars.length, A = springAtr_(bars), last = N - 1;
  for (let i = SPR.piv; i < N - SPR.piv; i++) {
    let isLow = true;
    for (let k = i - SPR.piv; k <= i + SPR.piv; k++) if (k !== i && bars[k].l < bars[i].l) { isLow = false; break; }
    if (!isLow || last - i > SPR.look + SPR.reclaimBars + SPR.retestBars) continue;
    const level = bars[i].l;
    let brk = -1;
    for (let j = i + SPR.piv + 1; j < N && j - i <= SPR.look; j++) { if (A[j] && bars[j].l < level - SPR.breakAtr * A[j]) { brk = j; break; } }
    if (brk < 0) continue;
    let low2 = bars[brk].l, rec = -1;
    for (let k = brk; k < N && k - brk <= SPR.reclaimBars; k++) { low2 = Math.min(low2, bars[k].l); if (bars[k].c > level) { rec = k; break; } }
    if (rec < 0) continue;
    let rallied = false, hi = bars[rec].h;
    for (let k = rec + 1; k < N && k - rec <= SPR.retestBars; k++) {
      const a = A[k]; if (!a) continue;
      const b = bars[k];
      if (b.c < level || b.l < low2) break;
      hi = Math.max(hi, b.h);
      if (!rallied) { if (hi >= level + SPR.rallyAtr * a) rallied = true; continue; }
      if (b.l <= level + SPR.retestAtr * a) {
        if (k === last) return { level: level, low2: low2, close: b.c, t: b.t, stop: low2 - 0.2 * a, target: b.c + (hi - low2), from: bars[i].t };
        break;
      }
    }
  }
  return null;
}
/** Yahoo 1 分K → 已收完的 per 分K（每盤從開盤起算） */
function minuteBars_(d, per) {
  const span = per * 60000, ts = d.timestamp || [], q = d.indicators.quote[0], map = {};
  let lastMin = 0;
  for (let i = 0; i < ts.length; i++) {
    const h = q.high[i], l = q.low[i], c = q.close[i];
    if ([h, l, c].some(v => v == null)) continue;
    const ms = fixYahoo_(ts[i] * 1000 - 60000), s = sessionStartOf_(ms);
    if (s == null) continue;
    lastMin = Math.max(lastMin, ms);
    const k = s + Math.floor((ms - s) / span) * span, b = map[k];
    if (!b) map[k] = { t: k, h: h, l: l, c: c, last: ms, s: s };
    else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); if (ms >= b.last) { b.c = c; b.last = ms; } }
  }
  return Object.keys(map).map(k => map[k]).filter(b => {
    const hr = new Date(b.s + 8 * H).getUTCHours();
    const sEnd = b.s + (hr >= 15 ? 14 : 5) * H;
    return Math.min(b.t + span, sEnd) <= lastMin + 60000;
  }).sort((a, b) => a.t - b.t);
}
function springMinutes_(d, props) {
  [5, 15].forEach(tf => springNotify_(minuteBars_(d, tf), tf, props));
}
function springNotify_(bars, tf, props) {
  if (!bars || bars.length < 30) return;
  const sig = springLast_(bars); if (!sig) return;
  const key = 'spring' + tf; if (Number(props.getProperty(key) || 0) >= sig.t) return;
  props.setProperty(key, String(sig.t));
  const ce = JSON.parse(props.getProperty('ce') || '{}').dir || 0;
  const timeTxt = Utilities.formatDate(new Date(sig.t + tf * 60000), 'Asia/Taipei', 'MM/dd HH:mm');
  notify_('🔄 破底翻｜' + tf + '分K 回測不破，做多參考 ' + fmt_(sig.close), [
    '📍 低點 ' + fmt_(sig.level) + ' 被跌破到 ' + fmt_(sig.low2) + '，站回後往上，' + timeTxt + ' 回測不破（收 ' + fmt_(sig.close) + '）',
    '🛡 停損 ' + fmt_(sig.stop) + '（破底低點下方，風險約 ' + fmt_(sig.close - sig.stop) + ' 點）',
    '🎯 N 字目標 ' + fmt_(sig.target),
    ce > 0 ? '✅ 主開關＝多（順勢）' : ce < 0 ? '⚠️ 主開關＝空（逆勢，回測勝率更低，建議不做）' : '主開關未定',
    '回測 9/2～10/27：破底翻勝率跟隨機進場差不多，當提醒用，進場還是看傑哥＋主開關',
  ].join('\n'), 'red_circle', 4);
}
