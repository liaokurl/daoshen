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
  // TradingView 快訊（狙擊、傑哥…）也轉寄 Email；取樣器的資料不寄
  if (body && body.indexOf('戰神通道') < 0) notify_('TradingView 快訊｜' + body.slice(0, 60), body, 'bell', 4);
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
        if (!first) notify_(entryTitle_(st.dir, b.c), entryBody_(st.dir, b.c, timeTxt, up, lo, props), st.dir > 0 ? 'red_circle' : 'green_circle', 5);
      } else if (!first && NOTIFY_WARN && st.pend && st.cnt === 1) {
        notify_(`預警｜帶狀可能翻${st.pend > 0 ? '多' : '空'}`, `${timeTxt} 第 1 根收在帶狀${st.pend > 0 ? '上方' : '下方'}，再 1 根就翻向\n微台 ${fmt_(b.c)}`, 'warning', 3);
      }
      st.lastT = b.t;
    }
    st.bars = bars.slice(-40);
    props.setProperty('zs', JSON.stringify(st));
    ceUpdate_(d, props);
  } finally {
    lock.releaseLock();
  }
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
function ceSeedBars_(recs) {
  const out = [];
  recs.filter(r => r.complete !== false).forEach(r => {
    const y = +r.start.slice(0, 4), mo = +r.start.slice(4, 6) - 1, d = +r.start.slice(6, 8);
    const base = Date.UTC(y, mo, d) - 8 * H + (r.type === 'D' ? (8 * 60 + 45) * 60000 : 15 * H);
    const first = r.bars.find(b => b);
    if (!first) return;
    let last = first[0], cur = null;
    r.bars.forEach((b, i) => {
      const k = base + Math.floor(i / 12) * H;
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
      `${timeTxt} 60 分K 收盤${e.dir > 0 ? '站上空方防守線' : '跌破多方防守線'}\n之後只找${e.dir > 0 ? '多' : '空'}單；60 分K 收盤${e.dir > 0 ? '跌破' : '站上'} ${fmt_(line)} 才再轉向`,
      e.dir > 0 ? 'red_circle' : 'green_circle', 5);
  }
  st.bars = bars; st.dir = e.dir; st.lastT = last.t;
  props.setProperty('ce', JSON.stringify(st));
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
  const text = '<b>' + esc_(title) + '</b>\n' + esc_(message) + '\n<a href="' + APP_URL + '">打開 App</a>';
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
function entryBody_(dir, px, timeTxt, up, lo, props) {
  const ce = JSON.parse(props.getProperty('ce') || '{}').dir || 0;
  const with_ = ce === dir;
  return [
    '🛡 智慧單：移動停利 ' + TRAIL + ' 點（初始停損 ' + fmt_(px - dir * TRAIL) + '）',
    '🎯 參考目標 ' + fmt_(px + dir * TP1) + '（' + (dir > 0 ? '+' : '−') + TP1+ '）／' + fmt_(px + dir * TP2) + '（' + (dir > 0 ? '+' : '−') + TP2 + '）',
    (with_ ? '✅ 順主開關（60 分K 吊燈＝' : '⚠️ 逆主開關（60 分K 吊燈＝') + (ce > 0 ? '多' : ce < 0 ? '空' : '未定') + '）' + (with_ ? '' : '，回測逆勢這側勝率低，建議不做'),
    '',
    '戰神帶狀 5 分K｜' + timeTxt + ' 收盤確認',
    '上軌 ' + fmt_(up) + '／下軌 ' + fmt_(lo),
  ].join('\n');
}
function testEntry() { const p = PropertiesService.getScriptProperties(); notify_('【測試】' + entryTitle_(1, 46888), entryBody_(1, 46888, '10:05', 46932, 46884, p), 'red_circle', 4); }
