"""Telegram 通知模組（Python 版，伺服器端用）
用法：
    from telegram_notify import tg_send
    tg_send("SMC 雷達觸發｜2327 國巨", "現價 534 (-5.82%)\n形態評級 A+")
環境變數：TG_TOKEN、TG_CHAT（必填），TG_PREFIX（可省略）
"""
import html, json, os, urllib.request

TOKEN = os.environ.get("TG_TOKEN", "")
CHAT = os.environ.get("TG_CHAT", "")
PREFIX = os.environ.get("TG_PREFIX", "【選股】")

def tg_send(title: str, message: str = "", link: str = "") -> bool:
    if not TOKEN or not CHAT:
        print("缺 TG_TOKEN 或 TG_CHAT"); return False
    text = f"<b>{html.escape(PREFIX + title)}</b>\n{html.escape(message)}"
    if link:
        text += f'\n<a href="{link}">打開</a>'
    body = json.dumps({"chat_id": CHAT, "text": text[:4000], "parse_mode": "HTML", "disable_web_page_preview": True}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/sendMessage", data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == 200
    except Exception as e:  # 通知失敗不要讓主程式中斷
        print("Telegram 失敗：", e); return False
