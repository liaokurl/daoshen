// Telegram 通知模組（Node.js 18+ 版，伺服器端／GitHub Actions 用；不要放在網頁前端，權杖會外洩）
// 用法：
//   import { tgSend } from "./telegram.mjs";
//   await tgSend("進場多單 46,888", "目標1 46,908\n目標2 46,968");
// 環境變數：TG_TOKEN（必填）、TG_CHAT（必填，聊天室編號）、TG_PREFIX（可省略）
const TOKEN = process.env.TG_TOKEN, CHAT = process.env.TG_CHAT, PREFIX = process.env.TG_PREFIX ?? "【選股】";
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function tgSend(title, message = "", link = "") {
  if (!TOKEN || !CHAT) { console.warn("缺 TG_TOKEN 或 TG_CHAT"); return false; }
  let text = `<b>${esc(PREFIX + title)}</b>\n${esc(message)}`;
  if (link) text += `\n<a href="${link}">打開</a>`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (e) { console.warn("Telegram 失敗：", e.message); return false; }
}
