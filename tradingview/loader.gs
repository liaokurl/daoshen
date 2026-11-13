// 刀神×葵哥 監控｜載入器（貼一次就好，以後不用再換）
// 每次執行都去 GitHub 抓最新的 tradingview/webhook.gs 來跑；Claude 推新版後，最慢 5 分鐘自動生效，不用再貼程式、不用再部署。
// 密碼（KEY、TG_TOKEN）存在「指令碼屬性」，不在程式裡。GitHub 抓不到時，用最近一次抓到的版本（最多保留 6 小時）。
const CORE_URL = 'https://raw.githubusercontent.com/liaokurl/daoshen/main/tradingview/webhook.gs';
const CORE_REFRESH = 5 * 60 * 1000, CORE_CHUNK = 90000;
let CORE_ = null;

function coreSource_(force) {
  const cache = CacheService.getScriptCache();
  const meta = JSON.parse(cache.get('coreMeta') || 'null');
  if (!force && meta && Date.now() - meta.at < CORE_REFRESH) { const src = coreFromCache_(cache, meta); if (src) return src; }
  try {
    const res = UrlFetchApp.fetch(CORE_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
    const src = res.getContentText();
    if (res.getResponseCode() === 200 && src.indexOf('function monitor()') >= 0) {
      const parts = {}, n = Math.ceil(src.length / CORE_CHUNK);
      for (let k = 0; k < n; k++) parts['core' + k] = src.slice(k * CORE_CHUNK, (k + 1) * CORE_CHUNK);
      parts.coreMeta = JSON.stringify({ at: Date.now(), n: n });
      cache.putAll(parts, 21600);
      return src;
    }
  } catch (err) { console.warn('抓 GitHub 失敗：' + err); }
  return meta ? coreFromCache_(cache, meta) : null;   // 抓不到就用舊的
}
function coreFromCache_(cache, meta) {
  const keys = []; for (let k = 0; k < meta.n; k++) keys.push('core' + k);
  const got = cache.getAll(keys); if (keys.some(k => got[k] == null)) return null;
  return keys.map(k => got[k]).join('');
}
function core_(force) {
  if (CORE_ && !force) return CORE_;
  const src = coreSource_(force);
  if (!src) throw new Error('讀不到 GitHub 上的程式');
  const names = []; src.replace(/^function ([A-Za-z0-9_]+)\(/gm, (m, n) => { names.push(n); return m; });
  CORE_ = new Function(src + '\nreturn { ' + names.join(', ') + ' };')();
  return CORE_;
}

// 觸發條件與網頁入口（名稱不能改）
function monitor() { return core_().monitor(); }
function doGet(e) { return core_().doGet(e); }
function doPost(e) { return core_().doPost(e); }

/** 換成載入器後執行一次：清掉舊的自動更新觸發條件、確認抓得到 GitHub，並推播通知 */
function setupLoader() {
  ScriptApp.getProjectTriggers().filter(t => ['autoUpdate'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  const c = core_(true);
  const hasMonitor = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'monitor');
  c.notify_('✅ 已改成自動載入', '以後 GitHub 有新版，最慢 5 分鐘自動生效，不用再貼程式、不用再部署' + (hasMonitor ? '' : '\n⚠️ 沒有找到每分鐘監控，請執行 setupMonitor'), 'white_check_mark', 2);
}
/** 舊版留下的觸發條件，留著不會出錯 */
function autoUpdate() {}

// 手動測試用（從上方選函式執行）
function testChart(e) { return core_().testChart(e); }
function setupMonitor(e) { return core_().setupMonitor(e); }
function stopMonitor(e) { return core_().stopMonitor(e); }
function testNotify(e) { return core_().testNotify(e); }
function testFiveNotify(e) { return core_().testFiveNotify(e); }
function testFive(e) { return core_().testFive(e); }
function setupEntryGroup(e) { return core_().setupEntryGroup(e); }
function testEntryAlert(e) { return core_().testEntryAlert(e); }
function testCe(e) { return core_().testCe(e); }
function setupEmail(e) { return core_().setupEmail(e); }
function setupTelegram(e) { return core_().setupTelegram(e); }
function testEntry(e) { return core_().testEntry(e); }
function testRoll(e) { return core_().testRoll(e); }
