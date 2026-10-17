// TradingView 快訊：TradingView → Webhook → Google Apps Script（存進試算表）→ 這裡讀取。
// 網址設定在 config.json 的 signalsUrl；沒設定就不顯示。

export function parseSignal(raw) {
  const text = String(raw.text ?? raw.message ?? "").trim();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 不是 JSON 就當純文字 */ }
  const body = data ? (data.text ?? data.message ?? JSON.stringify(data)) : text;
  const sideRaw = data?.side ?? data?.action ?? body;
  const side = /空|short|sell|賣/i.test(sideRaw) ? "空" : /多|long|buy|買/i.test(sideRaw) ? "多" : /平|出場|exit|close|停利|停損/i.test(sideRaw) ? "平" : null;
  const priceMatch = data?.price ?? (body.match(/(?:點位|價格|price)[^\d]{0,4}(\d{4,6}(?:\.\d+)?)/i)?.[1]) ?? (body.match(/\b(\d{5})(?:\.\d+)?\b/)?.[1]);
  const price = priceMatch != null ? Number(priceMatch) : null;
  const source = data?.source ?? body.match(/^([^\s，,：:]{1,12}?(?:\d+K|\d+分))/i)?.[1] ?? raw.source ?? null;
  const at = Date.parse(raw.at ?? raw.time ?? data?.time ?? "") || null;
  return { at, text: body, side, price: Number.isFinite(price) ? price : null, source, extra: data };
}

export async function loadSignals() {
  let url = "";
  try {
    const cfg = await fetch(`config.json?t=${Date.now()}`, { cache: "no-store" }).then(r => (r.ok ? r.json() : {}));
    url = cfg.signalsUrl ?? "";
  } catch { /* 沒有設定檔 */ }
  if (!url) return { configured: false };
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}limit=20&t=${Date.now()}`, { cache: "no-store" });
    const j = await res.json();
    const items = (j.items ?? []).map(parseSignal).filter(s => s.at).sort((a, b) => b.at - a.at);
    return { configured: true, items };
  } catch (e) {
    return { configured: true, error: e.message, items: [] };
  }
}
