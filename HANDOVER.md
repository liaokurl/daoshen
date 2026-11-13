# 刀神×葵哥 App 交接（2026/11/13 更新）

> 給下一個 Claude：開新對話時先讀這份。repo 是公開的，**這裡不放任何密碼**。

## 使用者的工作方式（最重要）

- **改推播內容、App 程式，Claude 直接做到好**：改程式 → 跑測試 → push 到 GitHub → 確認 Actions 發布成功。不要叫使用者複製貼上、不要叫他部署。
- 不要繞彎路：先想清楚最直接、能全自動的做法再動手。只有 Google 授權這種非本人不可的步驟才請他做，而且一次講完。
- 繁體中文、白話說明；要有回測證據；他常截圖問問題。
- 不要在 App／通知加回測警語（他說沒必要）。
- 推送權限：新對話要先用 add_repo（liaokurl/daoshen，access=push）把 repo 加進來才能 push。

## 架構

| 部分 | 位置 | 更新方式 |
|---|---|---|
| App（PWA） | https://liaokurl.github.io/daoshen/ ，repo `liaokurl/daoshen` | push 到 main → GitHub Actions「更新資料並發布」自動發布（約 30 秒） |
| 資料 | GitHub Actions 排程抓期交所＋Yahoo，組 `data/bundle.json` | 自動；排程常延遲，push 會立刻重跑 |
| 即時監控＋Telegram | Google Apps Script，綁在雲端硬碟「Untitled spreadsheet」 | **自動**：見下方「載入器」 |

### Apps Script 載入器（2026/11/13 起）

- Apps Script 裡只放 `tradingview/loader.gs`（固定不變）。每次執行都去 GitHub 抓最新的 `tradingview/webhook.gs` 來跑（快取 5 分鐘；抓不到就用最近一次的版本，最多 6 小時）。
- **所以改 Telegram／監控邏輯＝只要改 `tradingview/webhook.gs` 並 push，最慢 5 分鐘自動生效**，不用貼程式、不用部署。
- 密碼 KEY、TG_TOKEN 存在 Apps Script「指令碼屬性」（`KEY`、`TG_TOKEN`），程式裡沒有。群組編號也在屬性裡（`tgChat` 原本群組、`tgEntryChat`「⚡ 要下單」群組）。
- `appsscript.json` 已設定明確的 oauthScopes（repo 裡有一份 `tradingview/appsscript.json`）。因為程式是動態載入，Google 抓不到用了哪些服務，**如果新程式用到新的 Google 服務（例如 Drive、Gmail 讀信），要先加 scope，而且使用者要重新授權一次**——這種情況才需要請他動手。
- 載入器只轉接這些函式：monitor、doGet、doPost、setupLoader，以及手動測試用的 testChart、setupMonitor、stopMonitor、testNotify、testFiveNotify、testFive、setupEntryGroup、testEntryAlert、testCe、setupEmail、setupTelegram、testEntry、testRoll。**webhook.gs 新增「需要觸發條件或手動執行」的函式時，才要改 loader.gs**（那時候要請使用者重貼載入器一次），所以盡量用既有函式。
- webhook.gs 的頂層程式碼每次執行都會跑，不要在頂層做耗時或有副作用的事。
- 推上去前一定要 `node --check`（把 .gs 複製成 .js 檢查語法），語法錯了監控會整個停掉。

## App 分頁

刀神／葵哥／計畫／資料。刀神分頁順序：傑哥 → 五線 → 主開關 → 畫線看盤 …

## 策略

### 傑哥 SOP（主要）
- 傑哥帶狀翻向（5 分K，WMA24 高／低，2 根收在另一側）
- 只做 60 分K 吊燈 Chandelier(22,3) 方向；主開關轉向時傑哥已同向也可補進場
- 不追價：翻向前 24 根 5 分K 效率 ≥ 0.2 就不做（App 和通知標 ⛔）
- 移動停利 180
- 回測 9/2～11/10（1 口，每筆扣 5 點）：137 筆，勝率 44%，+2,845，最大回落 −855
- 進場通知和 App 卡片會標「✅ 五線同向（N 條）」或「⚠️ 五線沒同向」（只標示，不擋單）
  - 回測 9/2～11/12（Claude 自己重算的 SOP 有 208 筆，和 137 筆對不太上，絕對數字只供參考）：只照 SOP 40%、+3,790、每筆 +18；＋五線 ≥3 同向 62 筆 44%、每筆 +54；＋五線 ≥5 同向 36 筆 50%、每筆 +82、回落 −354；五線沒同向的 146 筆合計只 +439
- Telegram 照 SOP 的進場另發「⚡ 要下單」群組，每分鐘提醒共 3 次
- SOP 全部符合（傑哥翻向＋順主開關＋不追價，或主開關轉向時傑哥已同向＝補進場）時，原本群組也另發一則「⚡ 可立刻下單」（含停損、五線是否同向）
- 週期：傑哥帶狀 5 分K、主開關吊燈 60 分K、五線 15 分K（只有五線是 15 分K）

### 五線（均線加減碼，獨立策略）
- SMA 5／10／20／60／120／240，從短往長數，連續幾條「收盤在線上＋線上揚（收盤 > n 根前收盤）」＝幾線多（空方反過來）
- **2026/11/13 改版**：用 **15 分K**；新出現的三線、而且跟 60 分K 吊燈同方向才進場，一律先 1 口；之後 15 分K 收盤 ≥ 四線就加到 2 口（最多 2 口）；五線／全線只提示（合併在同一則通知）
- 收盤破 5MA 減碼 1 口（只剩 1 口續抱）；破 10MA 出清；反向新三線（也要跟主開關同方向）就反手
- Telegram 只發原本群組；同一根 K 棒的事件合成一則
- 回測 9/2～11/12（每口每次扣 5 點）：166 筆、勝率 31%、+10,467、最大回落 −2,826；前半段只 +499，大多來自 11 月趨勢
- 舊版（5 分K、不過濾）：936 筆、−3,068；改用 15 分K 是因為使用者嫌訊號太多太亂
- 和 TradingView「Trend Channels & Position Scaling」指標會有落差：邊緣情況（均線差幾點）兩邊資料源不同；TV 指標規則不明，使用者如果拿到它的規則或 Pine 原始碼可以再對齊

### 其他
- 監控只用已走完的 1 分K（`chartData_(symbol, true)`），收盤通知在收盤後幾十秒內發
- 狙擊推播關閉（`NOTIFY_SNIPER=false`）

## 回測結論整理

- 沒優勢：白箭頭（盤中先畫、事後會改）、狙擊單獨用、⭐ 星星（有星 43% vs 沒星 42%）、全線多單獨進場、15 分K 60MA 站上做多、頭肩頂、大波動盤整縮停利、無波動盤整等突破
- 有用：60 分K 前低守住（約 8 成）、不追價濾網、傑哥＋主開關＋五線同向
- 五線用大週期（15／30／60 分K）比 5 分K 好很多；5 分K 在盤整會一直雙巴

## 待辦

- 觀察五線 15 分K 紀錄幾週，跟傑哥 SOP 比較
- 觀察「五線同向」標示準不準，再決定要不要只做同向的單
- 確認「⚡ 要下單」群組是否已設定（/setentry → setupEntryGroup → testEntryAlert）
- 可測試：SOP＋2 口、先減碼 1 口
- 達錢 AI+（月費 1,000）：建議先付 1 個月跑 2 年回測（開始日 2024-10-24），再決定要不要自動下單
- 使用者會貼傑哥的操作教學文字，可以整理成規則、對照 SOP 找可回測的點（例：下彎通道走平、不破支撐 → 空單先出、可試多，但灰色走平通道雙巴風險高）

## 備註

- App 傑哥卡片的翻向表是「翻向就反手」的算法，不是 SOP 的成績
- 回測可以用 repo 裡的 `data/ticks/*.json`（tmf5 官方 5 分K）＋`data/provisional5/*.json`（Yahoo）自己組序列
