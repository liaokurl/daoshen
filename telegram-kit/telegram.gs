/**
 * Telegram 通知模組（Google Apps Script 版）
 * 用法：
 *   1. 把這整段貼到你的 Apps Script 專案（可以另開一個 .gs 檔）
 *   2. 填 TG_TOKEN（@BotFather 給的權杖）；TG_CHAT 可留空，會自動抓
 *   3. 先在 Telegram 對機器人按「開始」並傳一句話，再執行一次 tgSetup()
 *   4. 程式裡任何地方呼叫：tgSend('標題', '內容第一行\n第二行');
 */
const TG_TOKEN = '請填機器人權杖';
const TG_CHAT = '';            // 留空＝自動抓最近傳話給機器人的聊天室
const TG_PREFIX = '【選股】';   // 每則訊息標題前加的字，跟刀神的通知區分；不要就留空

function tgChat_() {
  if (TG_CHAT) return TG_CHAT;
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('tgChat');
  if (id) return id;
  const j = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates', { muteHttpExceptions: true }).getContentText());
  const ups = (j.result || []).filter(u => u.message && u.message.chat);
  if (!ups.length) return null;
  id = String(ups[ups.length - 1].message.chat.id);
  props.setProperty('tgChat', id);
  return id;
}

function tgEsc_(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** 傳一則訊息：title 會變粗體放第一行；link 可省略 */
function tgSend(title, message, link) {
  try {
    const chat = tgChat_();
    if (!chat) { console.warn('找不到聊天室：先對機器人傳一句話，再執行 tgSetup'); return false; }
    let text = '<b>' + tgEsc_(TG_PREFIX + title) + '</b>\n' + tgEsc_(message || '');
    if (link) text += '\n<a href="' + link + '">打開</a>';
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return res.getResponseCode() === 200;
  } catch (err) {
    console.warn('Telegram 失敗：' + err);   // 通知失敗不要讓主程式中斷
    return false;
  }
}

function tgSetup() {
  PropertiesService.getScriptProperties().deleteProperty('tgChat');
  const chat = tgChat_();
  Logger.log(chat ? '聊天室 ' + chat : '找不到：先在 Telegram 對機器人按「開始」並傳一句話');
  if (chat) tgSend('✅ 通知已接上', '之後的訊號會傳到這裡。');
}
