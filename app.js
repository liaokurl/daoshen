import { buildBars15, buildDaily, aggregate } from "./engine/bars.js";
import { analyzeStructure, LINE_DEFS } from "./engine/structure.js";
import { buildPlan, reviseIntraday, touchOutcome, POINT_VALUE_TMF } from "./engine/plan.js";
import { LEVEL_TYPES, VERDICT_TEXT } from "./engine/backtest.js";
import { SESSION, sessionKey, sessionEndMs, sessionStartMs } from "./engine/sessions.js";
import { fmtYmd, fmtDateTime, fmtTime, weekdayOf } from "./engine/time.js";
import { smaSeries } from "./engine/indicators.js";

const VERSION = "車干製V1.0";
const $app = document.getElementById("app");
const MANUAL_KEY = "daoshen-manual-price";
const state = { bundle: null, manual: null, error: null };

const fmt = v => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US"));
const signed = v => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v)).toLocaleString("en-US")}`);
const money = pts => `NT$${Math.round(Math.abs(pts) * POINT_VALUE_TMF).toLocaleString("en-US")}`;
const pct = v => (v == null ? "—" : `${Math.round(v * 100)}%`);
const WD = "日一二三四五六";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function readManual() {
  try { const v = JSON.parse(localStorage.getItem(MANUAL_KEY) ?? "null"); return v && Date.now() - v.at < 6 * 3600_000 ? v : null; } catch { return null; }
}
function saveManual(v) {
  try { v ? localStorage.setItem(MANUAL_KEY, JSON.stringify(v)) : localStorage.removeItem(MANUAL_KEY); } catch { /* 私密模式 */ }
}

async function load() {
  try {
    const res = await fetch(`data/bundle.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.bundle = await res.json();
    state.error = null;
  } catch (e) {
    state.error = `讀不到資料（${e.message}）。如果之前讀過，畫面保留上次的結果。`;
  }
  state.manual = readManual();
  render();
}

function compute() {
  const B = state.bundle;
  const now = Date.now();
  const bars15 = buildBars15(B.sessions15);
  const daily = buildDaily(B.summaries);
  const live = B.live;
  const target = B.target;
  const liveNow = now >= sessionStartMs(target.start, target.type) && now < sessionEndMs(target.start, target.type);
  // 資料時間：盤中以 Yahoo 最後一分鐘為準（分K以開始時間標記，所以 +1 分鐘才收完）
  let dataAsOf = bars15.length ? bars15.at(-1).end : now;
  const liveSession = B.sessions15.find(s => s.source === "yahoo" && s.complete === false);
  if (liveSession && live?.lastBarTime) dataAsOf = Math.min(live.lastBarTime + 60_000, sessionEndMs(liveSession.start, liveSession.type));
  else if (bars15.length) dataAsOf = Math.max(...B.sessions15.filter(s => s.complete !== false).map(s => sessionEndMs(s.start, s.type)));
  const completeBars = bars15.filter(b => b.t < dataAsOf);
  const manual = state.manual;
  const autoPrice = live?.lastPrice ?? completeBars.at(-1)?.c ?? null;
  const price = manual?.price ?? autoPrice;
  const analysis = analyzeStructure({ daily, bars15: completeBars, dataAsOf, price });
  const R = Math.max(15, 0.5 * (analysis.atr["60m"] ?? 40));
  let plan = B.plans.find(p => p && sessionKey(p.session.start, p.session.type) === target.key) ?? null;
  let planIsLive = false;
  if (!plan) {
    const prev = B.summaries.filter(s => s.complete !== false).at(-1);
    plan = buildPlan({ analysis, session: { start: target.start, type: target.type, td: target.td }, prevSession: prev, summaries: B.summaries, stats: B.stats, contract: B.contract, refPrice: price, createdAt: now });
    planIsLive = true;
  }
  const sessionBars = completeBars.filter(b => b.key === target.key);
  const revision = reviseIntraday(plan, { bars15Session: sessionBars, price, analysis, R });
  const prevClose = B.summaries.filter(s => s.complete !== false && `${s.start}${s.type}` !== target.key).at(-1)?.c ?? null;
  return { B, bars15: completeBars, daily, analysis, plan, planIsLive, revision, price, autoPrice, manual, prevClose, dataAsOf, liveNow, R, now };
}

function render() {
  if (!state.bundle) {
    $app.innerHTML = `<section class="card ${state.error ? "error" : "loading"}">${esc(state.error ?? "讀取資料中…")}</section>`;
    return;
  }
  let c;
  try { c = compute(); } catch (e) {
    console.error(e);
    $app.innerHTML = `<section class="card error">計算失敗：${esc(e.message)}</section>`;
    return;
  }
  $app.innerHTML = [
    state.error ? `<section class="card error">${esc(state.error)}</section>` : "",
    quoteCard(c),
    structureCard(c),
    planCard(c),
    chartCard(c),
    reviewCard(c),
    extCard(c),
    statsCard(c),
    statusCard(c),
  ].join("");
  bind();
}

function sessionLabel(s) {
  const td = s.td ?? s.start;
  return `${fmtYmd(td).slice(5)}（${WD[weekdayOf(td)]}）${SESSION[s.type].label}`;
}

function quoteCard(c) {
  const { B, price, autoPrice, manual, prevClose, liveNow } = c;
  const chg = price != null && prevClose != null ? price - prevClose : null;
  const live = B.live;
  const src = manual
    ? `手動輸入 ${fmtTime(manual.at)}`
    : live?.lastPrice != null
      ? `Yahoo 台指期近一 ${live.quotedAt ? fmtDateTime(live.quotedAt) : ""}（延遲報價）`
      : "最後一根已收 K 棒收盤";
  const chips = [
    `<span class="chip">TX ${B.contract.slice(0, 4)}/${B.contract.slice(4)}（微台同價）</span>`,
    `<span class="chip ${liveNow ? "ok" : ""}">${liveNow ? "盤中" : "休市中"}｜${sessionLabel(B.target)}</span>`,
    B.status.provisional.length ? `<span class="chip warn">含 Yahoo 暫存 K 棒</span>` : "",
  ].join("");
  return `<section class="card quote">
    <div class="quote-row"><span class="big">${fmt(price)}</span><span class="chg ${chg > 0 ? "up" : chg < 0 ? "down" : ""}">${signed(chg)}</span></div>
    <div class="meta">${esc(src)}</div>
    <div class="chips">${chips}</div>
    <form class="manual" id="manual">
      <input id="manual-input" inputmode="numeric" pattern="[0-9]*" placeholder="${fmt(autoPrice)}" aria-label="手動輸入現價" value="${manual ? Math.round(manual.price) : ""}">
      <button class="primary" type="submit">用這個價格修正</button>
      ${manual ? `<button class="ghost" type="button" id="manual-clear">改回自動</button>` : ""}
    </form>
  </section>`;
}

function condRow(id, cond, label, detail) {
  const cls = cond.value == null ? "" : cond.value ? "yes" : "no";
  const mark = cond.value == null ? "？" : cond.value ? "✓" : "✗";
  return `<div class="cond ${cls}"><span class="mark">${mark}</span><div><div class="what">${label}</div><div class="how">${detail}</div></div></div>`;
}

function structureCard(c) {
  const { analysis, price } = c;
  const { A, B } = analysis.conditions;
  const d = analysis.byId;
  const aDetail = A.value == null ? `資料不足（日K ${d.d1_20.barsAvailable}/20 根）`
    : `最後收盤 ${fmt(d.d1_20.lastClose)}，MA20 ${fmt(d.d1_20.ma)}（${slopeTxt(d.d1_20.slope)}）<br>今日 13:45 收盤門檻 <b>${fmt(A.threshold)}</b>，現價${distTxt(price, A.threshold)}${A.est != null && A.est !== A.value ? `｜<b>若現在收盤會${A.est ? "成立" : "失效"}</b>` : ""}`;
  const bDetail = B.value == null ? `資料不足（60分K ${d.h1_240.barsAvailable}/240 根）`
    : `最後收盤 ${fmt(d.h1_60.lastClose)}｜MA60 ${fmt(d.h1_60.ma)}（${slopeTxt(d.h1_60.slope)}）｜MA240 ${fmt(d.h1_240.ma)}（${slopeTxt(d.h1_240.slope)}）<br>下一根收盤門檻 <b>${fmt(B.threshold)}</b>，現價${distTxt(price, B.threshold)}${B.est != null && B.est !== B.value ? `｜<b>若現在收盤會${B.est ? "成立" : "失效"}</b>` : ""}`;
  const sc = analysis.conditions.shortCover;
  const hl = analysis.swings.higherLow;
  return `<section class="card structure ${analysis.structure.tone}">
    <h2>方向｜刀神結構</h2>
    <p class="title">${esc(analysis.structure.title)}</p>
    <div class="conds">
      ${condRow("A", A, "條件A　日K（全日盤）收盤站上 MA20", aDetail)}
      ${condRow("B", B, "條件B　60分K 收盤同時站上 MA60、MA240", bDetail)}
    </div>
    <div class="verdict-line">${sc == null ? "資料不足，無法判斷空單回補條件" : sc ? "空單回補條件：<b>成立</b>（A 或 B 任一成立）。代表結構改善，不等於多頭反轉。" : "空單回補條件：<b>未成立</b>（A、B 都還沒站回）"}</div>
    <p class="note">60分擺盪低點：${esc(hl.label)}${hl.latest ? `（最近 ${fmt(hl.latest.price)}${hl.prior ? `、前一個 ${fmt(hl.prior.price)}` : ""}）` : ""}</p>
  </section>`;
}

const slopeTxt = s => ({ RISING: "上彎", FALLING: "下彎", FLAT: "走平", INSUFFICIENT: "—" })[s] ?? "—";
const distTxt = (price, level) => (price == null || level == null ? "" : price >= level ? `在門檻上方 ${fmt(price - level)} 點` : `差 ${fmt(level - price)} 點（${money(level - price)}/口）`);

function statLines(line) {
  return line.stats.map(s => {
    const parts = s.parts.map(p => esc(p.text)).join("；") || "還沒有回測樣本";
    return `<div><span class="badge ${s.verdict}">${esc(VERDICT_TEXT[s.verdict])}</span>${esc(s.label)}：${parts}</div>`;
  }).join("");
}

function planCard(c) {
  const { plan, planIsLive, revision, price, B } = c;
  const sess = plan.session;
  const head = planIsLive
    ? `<span class="when">尚未封存（伺服器還沒產生這一盤的計畫），以下為即時試算</span>`
    : `<span class="when">${plan.late ? "開盤後補做" : "盤前封存"} ${fmtDateTime(plan.createdAt)}｜參考價 ${fmt(plan.refPrice)}</span>`;
  const exp = plan.expected
    ? `<p class="expect">${SESSION[sess.type].label}振幅：一般約 <b>${fmt(plan.expected.median)}</b> 點，八成在 <b>${fmt(plan.expected.p80)}</b> 點內（近 ${plan.expected.n} 盤）${revision.range != null ? `｜本盤目前 <b>${fmt(revision.range)}</b> 點` : ""}</p>` : "";
  const items = [];
  let markerDone = price == null;
  const lines = revision.lines;
  for (const l of lines) {
    if (!markerDone && price > l.price) { items.push(nowMarker(price)); markerDone = true; }
    items.push(levelRow(l, price));
  }
  if (!markerDone) items.push(nowMarker(price));
  const rules = revision.rules.map(r => `<li>${esc(r.text)}${r.liveThreshold != null && r.liveThreshold !== r.level ? `<span class="st">門檻已隨新 K 棒更新為 ${fmt(r.liveThreshold)}</span>` : ""}<span class="st ${/成立|失效|跌破|等收盤/.test(r.status) ? "hit" : ""}">現況：${esc(r.status)}</span></li>`).join("");
  const hidden = plan.hidden?.length
    ? `<details class="sub"><summary class="note">其他候選線（${plan.hidden.length}）— 距離太遠或被前三條擋住</summary>${plan.hidden.map(h => `<div class="note">${fmt(h.price)}｜${esc(h.label)}｜${h.inReach ? "距離內" : "超出一般振幅"}｜${esc(VERDICT_TEXT[h.verdict])}</div>`).join("")}</details>` : "";
  return `<section class="card">
    <div class="plan-head"><h2 style="margin:0">今日計畫｜${esc(sessionLabel({ ...sess, td: sess.td }))}</h2>${head}</div>
    ${exp}
    <div class="ladder">${items.join("") || `<p class="note">附近沒有符合條件的線。</p>`}</div>
    <ul class="rules">${rules}</ul>
    ${hidden}
    <p class="note">「先回頭」＝碰線後先往反方向走 ${fmt(c.R)} 點（約半根 60 分K），算這條線有反應；先順著穿越 ${fmt(c.R)} 點算被突破。</p>
  </section>`;
}

function nowMarker(price) {
  return `<div class="now-marker">現價 ${fmt(price)}</div>`;
}

function levelRow(l, price) {
  const cls = l.role === "壓力" ? "res" : "sup";
  const d = price == null ? null : l.price - price;
  const zone = l.hi !== l.lo ? `（${fmt(l.lo)}–${fmt(l.hi)}）` : "";
  return `<div class="lvl ${cls}">
    <span class="p">${fmt(l.price)}<small class="meta">${zone}</small></span><span class="role">${l.role}</span>
    <span class="name">${esc(l.label)}</span>
    <span class="dist">距現價 ${signed(d)} 點｜每口 ${money(d ?? 0)}</span>
    <div class="stat">${statLines(l)}</div>
    ${l.status && l.status !== "未碰" ? `<span class="status">本盤：${esc(l.status)}</span>` : ""}
  </div>`;
}

// ---------- 60 分 K 小圖 ----------
function chartCard(c) {
  const h1all = aggregate(c.bars15, 60);
  if (h1all.length < 10) return "";
  const closes = h1all.map(b => b.c);
  const m60 = smaSeries(closes, 60), m240 = smaSeries(closes, 240);
  const N = Math.min(90, h1all.length);
  const bars = h1all.slice(-N), s60 = m60.slice(-N), s240 = m240.slice(-N);
  const levels = c.plan.lines.map(l => l.price);
  const vals = [...bars.flatMap(b => [b.h, b.l]), ...s60.filter(Boolean), ...s240.filter(Boolean), ...levels];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const W = 700, H = 280, L = 4, Rr = 56;
  const x = i => L + (i + 0.5) * ((W - L - Rr) / N);
  const y = v => 8 + (hi - v) / (hi - lo) * (H - 24);
  const bw = Math.max(1.5, (W - L - Rr) / N * 0.6);
  const path = s => s.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" ");
  const candles = bars.map((b, i) => {
    const up = b.c >= b.o, col = up ? "var(--up)" : "var(--down)";
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.h)}" y2="${y(b.l)}" stroke="${col}" stroke-width="1"/><rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, bot - top)}" fill="${up ? "var(--card)" : col}" stroke="${col}"/>`;
  }).join("");
  const lvl = c.plan.lines.map(l => `<line x1="${L}" x2="${W - Rr}" y1="${y(l.price)}" y2="${y(l.price)}" stroke="${l.role === "壓力" ? "var(--mix)" : "var(--accent)"}" stroke-dasharray="5 4" stroke-width="1.2"/><text x="${W - Rr + 4}" y="${y(l.price) + 4}" font-size="12" fill="var(--muted)">${fmt(l.price)}</text>`).join("");
  // 日盤/夜盤分隔
  const seps = bars.map((b, i) => (i > 0 && b.key !== bars[i - 1].key ? `<line x1="${x(i) - (W - L - Rr) / N / 2}" x2="${x(i) - (W - L - Rr) / N / 2}" y1="0" y2="${H - 14}" stroke="var(--line)"/>` : "")).join("");
  const pr = c.price != null ? `<line x1="${L}" x2="${W - Rr}" y1="${y(c.price)}" y2="${y(c.price)}" stroke="var(--ink)" stroke-width=".8" opacity=".6"/><text x="${W - Rr + 4}" y="${y(c.price) + 4}" font-size="12" font-weight="700" fill="var(--ink)">${fmt(c.price)}</text>` : "";
  return `<section class="card"><h2>60 分 K（最近 ${N} 根）</h2>
    <div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="60分K線與均線">
      ${seps}${lvl}
      <polyline points="${path(s240)}" fill="none" stroke="#8b5cf6" stroke-width="2"/>
      <polyline points="${path(s60)}" fill="none" stroke="#f59e0b" stroke-width="2"/>
      ${candles}${pr}
    </svg></div>
    <div class="legend"><span><i style="background:#f59e0b"></i>MA60</span><span><i style="background:#8b5cf6"></i>MA240</span><span><i style="background:var(--mix)"></i>壓力候選</span><span><i style="background:var(--accent)"></i>支撐候選</span><span>直線＝換盤</span></div>
  </section>`;
}

// ---------- 盤後對帳 ----------
function reviewCard(c) {
  const { B } = c;
  const past = B.plans.filter(p => p && sessionKey(p.session.start, p.session.type) !== B.target.key).slice(-8).reverse();
  if (!past.length) return `<details class="card"><summary>盤後對帳</summary><div class="inner"><p class="note">還沒有封存過的計畫。每盤開盤前約 2 小時內，伺服器會自動封存一份，收盤後在這裡對照。</p></div></details>`;
  const items = past.map(p => {
    const key = sessionKey(p.session.start, p.session.type);
    const bars = c.bars15.filter(b => b.key === key);
    if (!bars.length) return `<div class="item"><b>${esc(sessionLabel(p.session))}</b><br><span class="note">這一盤的 K 棒資料已超出保存範圍或尚未取得</span></div>`;
    const hi = Math.max(...bars.map(b => b.h)), lo = Math.min(...bars.map(b => b.l)), cl = bars.at(-1).c;
    const R = Math.max(15, 0.5 * (p.atr60 ?? 40));
    const ls = p.lines.map(l => `${fmt(l.price)} ${esc(l.label)}：${esc(touchOutcome(bars, l, R))}`).join("<br>");
    const h1 = aggregate(bars, 60).filter(b => !b.partial);
    const rs = p.rules.map(r => {
      let res = "—";
      if (r.id === "B") res = r.kind === "trigger" ? (h1.some(b => b.c > r.level) ? "有 60 分K 收在門檻上（以計畫門檻核對）" : "沒有") : (h1.some(b => b.c < r.level) ? "有 60 分K 收在門檻下" : "守住");
      if (r.id === "A") res = p.session.type === "D" ? (r.kind === "trigger" ? (cl > r.level ? "收盤站上" : "沒有站上") : (cl < r.level ? "收盤跌破" : "守住")) : "夜盤不判定日K";
      if (r.id === "HL") res = lo < r.level ? "跌破" : "守住";
      return `${esc(r.text.split("→")[0])}→ <b>${res}</b>`;
    }).join("<br>");
    return `<div class="item"><b>${esc(sessionLabel(p.session))}</b>｜實際 高 ${fmt(hi)}／低 ${fmt(lo)}／收 ${fmt(cl)}（振幅 ${fmt(hi - lo)}${p.expected ? `，預估 ${fmt(p.expected.median)}` : ""}）<br>${ls}<br>${rs}</div>`;
  }).join("");
  return `<details class="card"><summary>盤後對帳（最近 ${past.length} 盤）</summary><div class="inner review">${items}</div></details>`;
}

// ---------- 延伸觀察 ----------
function extCard(c) {
  const rows = c.analysis.lines.map(l => `<tr><td>${esc(l.label)}${l.core ? "" : "<br><span class='note'>延伸觀察</span>"}</td>
    <td class="r">${l.insufficient ? `資料不足<br><span class="note">${l.barsAvailable}/${l.n}</span>` : fmt(l.ma)}</td>
    <td>${l.insufficient ? "—" : `${slopeTxt(l.slope)}｜現價${l.side === "ABOVE" ? "在上" : "在下"} ${fmt(Math.abs(l.distance))}`}${l.intrabarCross ? "<br><b>盤中穿越，未收盤確認</b>" : ""}</td></tr>`).join("");
  return `<details class="card"><summary>全部均線（含 30／15 分延伸觀察）</summary><div class="inner scroll-x">
    <table class="tbl"><thead><tr><th>均線</th><th class="r">數值</th><th>狀態</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">課程核心只有日K MA20、60分 MA60／MA240；30、15 分是延伸觀察，不放進計畫的條件。均線全部以「同一個合約」的已收盤 K 棒計算，不跨合約拼接。</p>
  </div></details>`;
}

// ---------- 回測成績 ----------
function statsCard(c) {
  const S = c.B.stats;
  if (!S) return "";
  const row = (type, s, kind) => s ? `<tr><td>${esc(LEVEL_TYPES[type] ?? type)}</td><td class="r">${s.n}</td><td class="r">${pct(s.rate)}</td><td>${esc(VERDICT_TEXT[s.verdict] ?? "")}${s.edge != null ? `（${s.edge > 0 ? "+" : ""}${Math.round(s.edge * 100)}%）` : ""}</td></tr>` : "";
  const order = ["h1_60", "h1_240", "d1_20", "prevHigh", "prevLow", "swingLow", "swingHigh", "random"];
  const cov = S.coverage ?? {};
  const intra = order.map(t => row(t, S.intraday?.[t])).join("");
  const sess = ["prevHigh", "prevLow", "d1_20", "random"].map(t => row(t, S.session?.[t])).join("");
  return `<details class="card"><summary>回測成績（每種線到底有沒有用）</summary><div class="inner scroll-x">
    <p class="note">盤中碰線：15 分K，${cov.intradayFrom && Number.isFinite(cov.intradayFrom) ? `${fmtDateTime(cov.intradayFrom)} ～ ${fmtDateTime(cov.intradayTo)}` : "資料不足"}（期交所逐筆檔只保留最近 30 個交易日，之後每天自動累積）</p>
    <table class="tbl"><thead><tr><th>線</th><th class="r">次數</th><th class="r">先回頭</th><th>判定</th></tr></thead><tbody>${intra}</tbody></table>
    <p class="note" style="margin-top:14px">盤別收盤：期交所每日行情 ${cov.sessionFrom ? `${fmtYmd(cov.sessionFrom)} ～ ${fmtYmd(cov.sessionTo)}` : ""}。碰到線之後，收盤仍在原來那一側＝守住。</p>
    <table class="tbl"><thead><tr><th>線</th><th class="r">次數</th><th class="r">收盤守住</th><th>判定</th></tr></thead><tbody>${sess}</tbody></table>
    <p class="note">判定方式：和「隨機畫的線」比，差距在統計上明顯（單尾 95%）才算有優勢；次數少於 20 一律標示樣本不足。過去有效不代表未來有效。</p>
  </div></details>`;
}

function statusCard(c) {
  const { B } = c;
  const st = B.status;
  return `<details class="card"><summary>資料來源與狀態</summary><div class="inner">
    <table class="tbl"><tbody>
      <tr><td>網站資料產生</td><td>${fmtDateTime(B.builtAt)}</td></tr>
      <tr><td>期交所逐筆（官方 15 分K）</td><td>至 ${st.officialThrough ? esc(sessionLabel({ start: st.officialThrough.slice(0, 8), type: st.officialThrough.slice(8), td: st.officialThrough.slice(8) === "D" ? st.officialThrough.slice(0, 8) : null })) : "無"}</td></tr>
      <tr><td>期交所每日行情</td><td>至 ${st.dailyThrough ? fmtYmd(st.dailyThrough) : "無"}</td></tr>
      <tr><td>Yahoo 暫存盤</td><td>${st.provisional.length ? esc(st.provisional.join("、")) : "無"}（官方資料出來後自動取代）</td></tr>
      <tr><td>現價</td><td>${B.live ? `${esc(B.live.source)}，抓取 ${fmtDateTime(B.live.fetchedAt)}` : "這次沒有抓到盤中報價"}</td></tr>
      <tr><td>版本</td><td>${VERSION}</td></tr>
    </tbody></table>
    <p class="note">資料由 GitHub 每 15 分鐘自動更新一次（GitHub 排程偶爾會延遲幾分鐘）。要看最新價格，直接在上方輸入你看盤軟體的現價即可，所有門檻與狀態會立刻重算。</p>
  </div></details>`;
}

function bind() {
  document.getElementById("manual")?.addEventListener("submit", e => {
    e.preventDefault();
    const v = Number(document.getElementById("manual-input").value.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(v) || v <= 0) return;
    state.manual = { price: v, at: Date.now() };
    saveManual(state.manual);
    render();
  });
  document.getElementById("manual-clear")?.addEventListener("click", () => {
    state.manual = null;
    saveManual(null);
    render();
  });
}

document.getElementById("refresh").addEventListener("click", load);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden) load(); }, 5 * 60_000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
void LINE_DEFS;
load();
