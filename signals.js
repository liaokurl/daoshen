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
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}limit=100&t=${Date.now()}`, { cache: "no-store" });
    const j = await res.json();
    const items = (j.items ?? []).map(parseSignal).filter(s => s.at).sort((a, b) => b.at - a.at);
    return { configured: true, items };
  } catch (e) {
    return { configured: true, error: e.message, items: [] };
  }
}

// ---------- Plutus Core：跟 Apps Script 的 plutusPost_ 同一套規則，用試算表裡的快訊重播 ----------
export const PL_PAIR_MIN = 30, PL_CONFIRM_MIN = 60;
export function plutusKind(t) {
  t = String(t || "");
  if (!/Plutus|三角|狀態轉|輔助標記/.test(t) && !/^\s*(Plutus\s*)?(訊號)?[｜|]?\s*(底|頂|支撐|阻力)\s*$/.test(t)) return null;
  if (/向上三角|上三角/.test(t)) return { k: "tri", side: 1, name: "向上三角" };
  if (/向下三角|下三角/.test(t)) return { k: "tri", side: -1, name: "向下三角" };
  if (/狀態轉強/.test(t)) return { k: "sub", side: 1, name: "副圖轉強" };
  if (/狀態轉弱/.test(t)) return { k: "sub", side: -1, name: "副圖轉弱" };
  if (/輔助標記/.test(t)) return { k: "misc", side: 0, name: "輔助標記更新" };
  if (/支撐/.test(t)) return { k: "misc", side: 1, name: "支撐" };
  if (/阻力/.test(t)) return { k: "misc", side: -1, name: "阻力" };
  if (/頂/.test(t)) return { k: "tb", side: -1, name: "頂" };
  if (/底/.test(t)) return { k: "tb", side: 1, name: "底" };
  return null;
}
/** items：parseSignal 後的快訊（新到舊）→ Plutus 事件（新到舊）與目前狀態 */
export function plutusReplay(items) {
  const M = 60_000, ev = [], st = { last: {} };
  const rows = items.map(s => ({ ...s, kd: plutusKind(s.text) })).filter(s => s.kd).sort((a, b) => a.at - b.at);
  for (const r of rows) {
    const { kd, at } = r, key = kd.k + kd.side;
    if (st.last[key] && at - st.last[key] < 3 * M) continue;
    st.last[key] = at;
    if (kd.k === "tri" || kd.k === "tb") {
      st[kd.k] = { side: kd.side, at, name: kd.name, price: r.price };
      const other = st[kd.k === "tri" ? "tb" : "tri"];
      const paired = other && other.side === kd.side && at - other.at <= PL_PAIR_MIN * M;
      const dup = st.dbl && st.dbl.side === kd.side && at - st.dbl.at < PL_CONFIRM_MIN * M;
      if (paired && !dup) { st.dbl = { side: kd.side, at, price: r.price ?? other.price, confirmed: st.sub?.side === kd.side }; ev.push({ type: "雙訊號", side: kd.side, at, price: st.dbl.price, sub: st.sub?.side === kd.side }); }
      else ev.push({ type: kd.k === "tri" ? "預警" : kd.name, side: kd.side, at, price: r.price, name: kd.name });
    } else if (kd.k === "sub") {
      st.sub = { side: kd.side, at, name: kd.name };
      if (st.dbl && !st.dbl.confirmed && at - st.dbl.at <= PL_CONFIRM_MIN * M) {
        if (st.dbl.side === kd.side) { st.dbl.confirmed = true; ev.push({ type: "副圖確認", side: kd.side, at }); }
        else ev.push({ type: "副圖反向", side: kd.side, at });
      } else ev.push({ type: kd.name, side: kd.side, at });
    } else ev.push({ type: kd.name, side: kd.side, at, price: r.price });
  }
  return { events: ev.reverse(), dbl: st.dbl ?? null, sub: st.sub ?? null, tri: st.tri ?? null, tb: st.tb ?? null, count: rows.length };
}

// ---------- 模擬交易（Apps Script 紙上下單） ----------
export async function loadPaper() {
  try {
    const cfg = await fetch(`config.json?t=${Date.now()}`, { cache: "no-store" }).then(r => (r.ok ? r.json() : {}));
    const url = cfg.signalsUrl ?? ""; if (!url) return null;
    return await fetch(`${url}${url.includes("?") ? "&" : "?"}action=paper&t=${Date.now()}`, { cache: "no-store" }).then(r => r.json());
  } catch (e) { return { error: e.message }; }
}
