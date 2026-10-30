import { buildBars15, buildDaily, aggregate } from "./engine/bars.js";
import { analyzeStructure, LINE_DEFS } from "./engine/structure.js";
import { buildPlan, reviseIntraday, touchOutcome, POINT_VALUE_TMF } from "./engine/plan.js";
import { LEVEL_TYPES, VERDICT_TEXT } from "./engine/backtest.js";
import { SESSION, sessionKey, sessionEndMs, sessionStartMs } from "./engine/sessions.js";
import { fmtYmd, fmtDateTime, fmtTime, weekdayOf } from "./engine/time.js";
import { smaSeries } from "./engine/indicators.js";
import { threeSwords, turtle, pcrView, swordSummary, SWORD_MODES } from "./engine/sword.js";
import { kuigeModel } from "./engine/kuige.js";
import { loadSignals } from "./signals.js";
import { fetchLive, applyLive } from "./live.js";
import { proSniper, washout, zhanshenBand, chandelierExit, tradesFrom, CHASE_ER } from "./engine/myind.js";
import { sixLevels, periodRange, SIX_RATIOS, SIX_PERIODS } from "./engine/sixlayer.js";
import { swingLows } from "./engine/swing.js";

const VERSION = "車干製V1.5";
const $app = document.getElementById("app");
const MANUAL_KEY = "daoshen-manual-price";
const state = { base: null, cfg: null, liveInfo: null, loading: false, bundle: null, manual: null, error: null, tab: readTab(), signals: null, editLayout: null };
const TABS = [["dao", "刀神"], ["kui", "葵哥"], ["plan", "計畫"], ["more", "資料"]];
function readTab() { try { return localStorage.getItem("daoshen-tab") || "dao"; } catch { return "dao"; } }

const fmt = v => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US"));
const signed = v => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v)).toLocaleString("en-US")}`);
const money = pts => `NT$${Math.round(Math.abs(pts) * POINT_VALUE_TMF).toLocaleString("en-US")}`;
const pct = v => (v == null ? "—" : `${Math.round(v * 100)}%`);
const WD = "日一二三四五六";
const fmtClock = ms => new Date(ms).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function readManual() {
  try { const v = JSON.parse(localStorage.getItem(MANUAL_KEY) ?? "null"); return v && Date.now() - v.at < 6 * 3600_000 ? v : null; } catch { return null; }
}
function saveManual(v) {
  try { v ? localStorage.setItem(MANUAL_KEY, JSON.stringify(v)) : localStorage.removeItem(MANUAL_KEY); } catch { /* 私密模式 */ }
}

async function load() {
  state.loading = true; render();
  const cfgP = fetch(`config.json?t=${Date.now()}`, { cache: "no-store" }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  try {
    const res = await fetch(`data/bundle.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.base = await res.json();
    state.error = null;
  } catch (e) {
    state.error = `讀不到資料（${e.message}）。如果之前讀過，畫面保留上次的結果。`;
  }
  state.cfg = await cfgP;
  state.manual = readManual();
  await refreshLive(false);
  state.loading = false;
  render();
  loadSignals().then(s => { state.signals = s; render(); });
}

/** 只抓即時行情（不重抓 bundle） */
async function refreshLive(doRender = true) {
  if (!state.base) return;
  const L = await fetchLive(state.cfg ?? {});
  state.liveInfo = L ? { kind: L.kind, at: Date.now(), ms: L.ms } : { kind: "fail", at: Date.now() };
  // 每次都從伺服器的 bundle 複製一份再套即時資料，避免累積
  state.bundle = applyLive(structuredClone(state.base), L);
  if (doRender) render();
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
  const liveSession = B.sessions15.find(s => String(s.source).startsWith("yahoo") && s.complete === false);
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
  // 盤中：跟上一盤收盤比；休市：顯示剛結束那一盤的漲跌
  const doneSums = B.summaries.filter(s => s.complete !== false && `${s.start}${s.type}` !== target.key);
  const prevClose = (liveNow ? doneSums.at(-1) : doneSums.at(-2))?.c ?? null;
  const chgLabel = liveNow ? "比上一盤收盤" : `${SESSION[doneSums.at(-1)?.type ?? "D"].label}漲跌`;
  const h1Done = analysis.frames["60m"].done;
  const sw = threeSwords(h1Done, price);
  const h4Done = aggregate(completeBars, 240).filter(b => b.end <= dataAsOf && !b.partial);
  const tt = turtle(h4Done);
  const summary = swordSummary(sw, tt);
  const pcr = pcrView(B.pcr?.rows);
  const lastDone = doneSums.at(-1);
  const kg = kuigeModel({ prevSession: liveNow ? lastDone : lastDone, currentBars: liveNow ? sessionBars : [], price });
  // 使用者自己的指標：微台 5 分K
  let my = null, b5 = null;
  if (B.tmf5?.length) {
    const all5 = buildBars15(B.tmf5);
    const liveTmf = B.tmf5.find(s => s.complete === false);
    const asOf5 = liveTmf && B.tmfLive?.lastBarTime ? B.tmfLive.lastBarTime + 60_000 : (all5.at(-1)?.end ?? 0);
    const done5 = all5.filter(b => b.end <= asOf5);
    b5 = done5;
    if (done5.length > 100) my = { sn: proSniper(done5), wo: washout(done5), zs: zhanshenBand(done5), ce: chandelierExit(aggregate(done5, 60).filter(b => !b.partial)), sw60: swingLows(aggregate(done5, 60).filter(b => !b.partial)), sw30: swingLows(aggregate(done5, 30).filter(b => !b.partial)), last: done5.at(-1), live: Boolean(liveTmf), src: B.tmf5.find(s => s.start + s.type === done5.at(-1).key)?.source };
  }
  return { B, bars15: completeBars, daily, analysis, plan, planIsLive, revision, price, autoPrice, manual, prevClose, chgLabel, dataAsOf, liveNow, R, now, sw, tt, summary, pcr, kg, my, b5 };
}

function render() {
  const btn = document.getElementById("refresh");
  if (btn) btn.textContent = state.loading ? "更新中…" : "↻ 更新";
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
  const tabs = `<nav class="tabs" role="tablist">${TABS.map(([id, label]) => `<button role="tab" data-tab="${id}" class="${state.tab === id ? "on" : ""}">${label}</button>`).join("")}</nav>`;
  const defs = {
    dao: [["zs", "傑哥戰神帶狀", zsCard], ["my", "我的指標（狙擊）", myCard], ["ce", "多空主開關", ceCard], ["draw", "畫線看盤", drawCard], ["six", "六層第 5 層", sixMini], ["swing", "前低第二支腳", swingCard], ["sword", "三刀流", swordCard], ["sig", "TradingView 快訊", signalsCard], ["struct", "均線結構", structureCard], ["chart", "走勢圖", chartCard]],
    kui: [["six", "六層多空點位", sixCard], ["kuige", "葵哥三等分", kuigeCard]],
    plan: [["plan", "盤前計畫", planCard], ["review", "檢討", reviewCard]],
    more: [["ext", "外部資料", extCard], ["stats", "回測統計", statsCard], ["status", "資料狀態", statusCard]],
  }[state.tab] ?? [];
  const body = layoutCards(state.tab, defs, c);
  const focusId = document.activeElement?.id, caret = document.activeElement?.selectionStart;
  $app.innerHTML = [
    state.error ? `<section class="card error">${esc(state.error)}</section>` : "",
    quoteCard(c),
    tabs,
    ...body,
  ].join("");
  bind();
  bindSix();
  bindLayout();
  checkLineAlerts(c);
  bindDraw();
  document.getElementById("more-snipe")?.addEventListener("toggle", e => { state.snipeOpen = e.target.open; e.target.querySelector("summary").textContent = e.target.open ? "收起" : `顯示其他 ${e.target.querySelectorAll(".fr").length} 筆`; });
  document.getElementById("more-flips")?.addEventListener("toggle", e => { state.flipsOpen = e.target.open; e.target.querySelector("summary").textContent = e.target.open ? "收起" : `顯示其他 ${e.target.querySelectorAll(".fr").length} 筆`; });
  // 自動更新時保留輸入框的游標，不打斷正在輸入的數字
  if (focusId) { const el = document.getElementById(focusId); if (el && el.tagName === "INPUT") { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* 忽略 */ } } }
}

// ---------- 卡片排序／隱藏（每個分頁各自記在這台裝置） ----------
const LAYOUT_KEY = "daoshen-layout";
function loadLayout() { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") || {}; } catch { return {}; } }
function saveLayout(v) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(v)); } catch { /* 私密模式 */ } }
function orderOf(tab, defs) {
  const L = loadLayout()[tab] ?? {};
  const ids = defs.map(d => d[0]);
  const order = (L.order ?? []).filter(id => ids.includes(id));
  // 新加入的卡片放在預設順序裡它前一張卡片的後面，不要都擠到最下面
  ids.forEach((id, k) => { if (order.includes(id)) return; const prev = ids.slice(0, k).reverse().find(p => order.includes(p)); order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id); });
  return { order, hidden: new Set((L.hidden ?? []).filter(id => ids.includes(id))) };
}
function layoutCards(tab, defs, c) {
  const { order, hidden } = orderOf(tab, defs);
  const byId = Object.fromEntries(defs.map(d => [d[0], d]));
  const edit = state.editLayout === tab;
  const out = [];
  order.forEach((id, i) => {
    const [, name, fn] = byId[id];
    if (edit) {
      const off = hidden.has(id);
      out.push(`<div class="mv${off ? " off" : ""}"><b>${esc(name)}</b><span>
        <button class="ghost" data-mv="${id}" data-dir="top" ${i === 0 ? "disabled" : ""} aria-label="移到最上面">⤒</button>
        <button class="ghost" data-mv="${id}" data-dir="up" ${i === 0 ? "disabled" : ""} aria-label="上移">↑</button>
        <button class="ghost" data-mv="${id}" data-dir="down" ${i === order.length - 1 ? "disabled" : ""} aria-label="下移">↓</button>
        <button class="ghost" data-mv="${id}" data-dir="hide">${off ? "顯示" : "隱藏"}</button></span></div>`);
      return;
    }
    if (hidden.has(id)) return;
    let html = "";
    try { html = fn(c); } catch (e) { console.error(e); html = `<section class="card error">${esc(name)} 計算失敗：${esc(e.message)}</section>`; }
    out.push(html);
  });
  out.push(`<div class="layout-bar">${edit
    ? `<button class="primary" data-layout="done">完成</button><button class="ghost" data-layout="reset">恢復預設順序</button>`
    : `<button class="ghost" data-layout="edit">⇅ 調整卡片順序</button>`}</div>`);
  if (edit) out.unshift(`<p class="note layout-tip">用 ⤒ ↑ ↓ 調整順序，「隱藏」可以收起不常看的卡片。調好按「完成」，會記在這台裝置。</p>`);
  return out;
}
function bindLayout() {
  document.querySelectorAll("[data-layout]").forEach(b => b.addEventListener("click", () => {
    const act = b.dataset.layout;
    if (act === "edit") state.editLayout = state.tab;
    else if (act === "done") state.editLayout = null;
    else if (act === "reset") { const all = loadLayout(); delete all[state.tab]; saveLayout(all); }
    render();
    if (act === "edit") window.scrollTo({ top: 0 });
  }));
  document.querySelectorAll("[data-mv]").forEach(b => b.addEventListener("click", () => {
    const all = loadLayout(), tab = state.tab;
    const ids = [...document.querySelectorAll(".mv [data-dir=top]")].map(x => x.dataset.mv);
    const cur = all[tab] ?? {};
    const order = ids.length ? ids : (cur.order ?? []);
    const hidden = new Set(cur.hidden ?? []);
    const id = b.dataset.mv, i = order.indexOf(id), dir = b.dataset.dir;
    if (dir === "up" && i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
    if (dir === "down" && i < order.length - 1) [order[i + 1], order[i]] = [order[i], order[i + 1]];
    if (dir === "top" && i > 0) { order.splice(i, 1); order.unshift(id); }
    if (dir === "hide") hidden.has(id) ? hidden.delete(id) : hidden.add(id);
    all[tab] = { order, hidden: [...hidden] };
    saveLayout(all);
    render();
  }));
}

function sessionLabel(s) {
  const td = s.td ?? s.start;
  return `${fmtYmd(td).slice(5)}（${WD[weekdayOf(td)]}）${SESSION[s.type].label}`;
}

function quoteCard(c) {
  const { B, price, autoPrice, manual, prevClose, liveNow, chgLabel } = c;
  const chg = price != null && prevClose != null ? price - prevClose : null;
  const live = B.live;
  const src = manual
    ? `手動輸入 ${fmtTime(manual.at)}`
    : live?.lastPrice != null
      ? `${esc(live.source ?? "Yahoo 台指期近一")}｜報價時間 ${live.quotedAt ? fmtClock(live.quotedAt) : "—"}`
      : "最後一根已收 K 棒收盤";
  const li = state.liveInfo;
  const liveTxt = !li ? "" : li.kind === "bars" ? `即時行情已更新 ${fmtClock(li.at)}（含分K，${(li.ms / 1000).toFixed(1)} 秒）`
    : li.kind === "price" ? `即時價已更新 ${fmtClock(li.at)}；分K仍是伺服器 ${fmtTime(B.builtAt)} 的資料（設定即時中繼站後就會即時）`
    : `即時行情抓取失敗，顯示伺服器 ${fmtTime(B.builtAt)} 的資料`;
  const chips = [
    `<span class="chip">TX ${B.contract.slice(0, 4)}/${B.contract.slice(4)}（微台同價）</span>`,
    `<span class="chip ${liveNow ? "ok" : ""}">${liveNow ? "盤中" : "休市中"}｜${sessionLabel(B.target)}</span>`,
    B.status.provisional.length ? `<span class="chip warn">含 Yahoo 暫存 K 棒</span>` : "",
    B.roll ? `<span class="chip warn">已換月 ${B.roll.from.slice(4)}→${B.roll.to.slice(4)}月｜價差 ${signed(B.roll.spread)}（歷史已平移）</span>` : "",
  ].join("");
  return `<section class="card quote">
    <div class="quote-row"><span class="big">${fmt(price)}</span><span class="chg ${chg > 0 ? "up" : chg < 0 ? "down" : ""}">${signed(chg)}</span><span class="meta">${esc(chgLabel)}</span></div>
    <div class="meta">${src}</div>
    ${liveTxt ? `<div class="meta">${liveTxt}</div>` : ""}
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
    <span class="dist">距現價 ${signed(d)} 點｜每口 ${money(d ?? 0)}${l.inReach === false ? "｜<b>超出一般振幅，今天不太會碰到</b>" : ""}</span>
    <div class="stat">${statLines(l)}</div>
    ${l.status && l.status !== "未碰" ? `<span class="status">本盤：${esc(l.status)}</span>` : ""}
  </div>`;
}

// ---------- 畫線看盤：自己畫支撐／壓力線，價格碰到時提醒 ----------
const DRAW_KEY = "daoshen-lines", DRAW_TF_KEY = "daoshen-draw-tf";
function loadLines() { try { const v = JSON.parse(localStorage.getItem(DRAW_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
function saveLines(v) { try { localStorage.setItem(DRAW_KEY, JSON.stringify(v)); } catch { /* 私密模式 */ } }
function drawTf() { try { const v = localStorage.getItem(DRAW_TF_KEY); return ["5", "15", "30", "60", "D"].includes(v) ? v : "60"; } catch { return "60"; } }
const DRAW_ZOOM_KEY = "daoshen-draw-zoom", ZOOMS = [40, 80, 160, 300];
const ZOOM_DEFAULT = { 5: 1, 15: 1, 30: 1, 60: 2, D: 2 };
function drawZoom(tf) { try { const v = JSON.parse(localStorage.getItem(DRAW_ZOOM_KEY) ?? "{}")[tf]; return Number.isInteger(v) && v >= 0 && v < ZOOMS.length ? v : ZOOM_DEFAULT[tf]; } catch { return ZOOM_DEFAULT[tf]; } }
function setDrawZoom(tf, z) { try { const all = JSON.parse(localStorage.getItem(DRAW_ZOOM_KEY) ?? "{}"); all[tf] = z; localStorage.setItem(DRAW_ZOOM_KEY, JSON.stringify(all)); } catch { /* 忽略 */ } }
/** 畫線看盤用的 K 棒：5／15／30 分用微台；60 分、日K 用「台指近全」（每天當時的近月，跟看盤軟體一樣） */
function drawBars(c, tf) {
  const B = c.B;
  if (tf === "5" || tf === "15" || tf === "30") return c.b5?.length ? (tf === "5" ? c.b5 : aggregate(c.b5, Number(tf))) : [];
  if (tf === "60") {
    const byKey = new Map((B.front15 ?? []).map(s => [s.start + s.type, s]));
    for (const s of B.sessions15) { const k = s.start + s.type; const old = byKey.get(k); if (!old || s.contract === B.contract) byKey.set(k, s); }
    const sess = [...byKey.values()].sort((a, b) => sessionStartMs(a.start, a.type) - sessionStartMs(b.start, b.type));
    return aggregate(buildBars15(sess).filter(b => b.t < c.dataAsOf), 60);
  }
  const days = (B.frontDaily ?? []).map(d => ({ ...d, t: Date.parse(`${d.td.slice(0, 4)}-${d.td.slice(4, 6)}-${d.td.slice(6, 8)}T00:00:00+08:00`) }));
  const cur = c.daily.at(-1);
  if (cur) { const row = { td: cur.td, o: cur.o, h: cur.h, l: cur.l, c: c.price ?? cur.c, t: Date.parse(`${cur.td.slice(0, 4)}-${cur.td.slice(4, 6)}-${cur.td.slice(6, 8)}T00:00:00+08:00`) }; if (days.at(-1)?.td === cur.td) days[days.length - 1] = row; else days.push(row); }
  if (!days.length) return c.daily.map(d => ({ ...d, t: Date.parse(`${d.td.slice(0, 4)}-${d.td.slice(4, 6)}-${d.td.slice(6, 8)}T00:00:00+08:00`) }));
  return days;
}
/** 還沒被破的前低（支撐）、還沒被過的前高（壓力），離現價最近的幾個 */
function majorLevels(bars, price, piv) {
  const N = bars.length, lows = [], highs = [];
  for (let i = piv; i < N - piv; i += 1) {
    let lo = true, hi = true;
    for (let k = i - piv; k <= i + piv; k += 1) { if (k === i) continue; if (bars[k].l < bars[i].l) lo = false; if (bars[k].h > bars[i].h) hi = false; }
    if (lo && !bars.slice(i + 1).some(b => b.l < bars[i].l) && bars[i].l < price) lows.push({ price: bars[i].l, t: bars[i].t });
    if (hi && !bars.slice(i + 1).some(b => b.h > bars[i].h) && bars[i].h > price) highs.push({ price: bars[i].h, t: bars[i].t });
  }
  // 很接近的兩個低點（或高點）只留一個，避免字疊在一起
  const pick = (arr, keep) => arr.reduce((out, x) => (out.some(o => Math.abs(o.price - x.price) < Math.max(40, price * 0.0012)) ? out : [...out, x]), []).slice(0, keep);
  return { lows: pick(lows.sort((a, b) => b.price - a.price), 3), highs: pick(highs.sort((a, b) => a.price - b.price), 2) };
}
/** 還沒補完的缺口：往上跳空（這根最低 > 前一根最高）＝下方支撐缺口；往下跳空＝上方壓力缺口。
 *  之後的 K 棒回到缺口裡就把缺口縮小，整個穿過去就算補完。 */
function openGaps(bars, price) {
  const minGap = Math.max(10, Math.round(price * 0.0003));
  const gaps = [];
  for (let i = 1; i < bars.length; i += 1) {
    const p = bars[i - 1], b = bars[i];
    if (b.l - p.h >= minGap) gaps.push({ dir: "up", lo: p.h, hi: b.l, t: b.t, size: b.l - p.h });
    else if (p.l - b.h >= minGap) gaps.push({ dir: "down", lo: b.h, hi: p.l, t: b.t, size: p.l - b.h });
    for (const g of gaps) {
      if (g.done || g.t === b.t) continue;
      if (g.dir === "up") { if (b.l <= g.lo) g.done = true; else if (b.l < g.hi) g.hi = b.l; }
      else { if (b.h >= g.hi) g.done = true; else if (b.h > g.lo) g.lo = b.h; }
    }
  }
  const open = gaps.filter(g => !g.done && g.hi - g.lo >= minGap / 2);
  const below = open.filter(g => g.hi <= price).sort((a, b) => b.hi - a.hi).slice(0, 2);
  const above = open.filter(g => g.lo >= price).sort((a, b) => a.lo - b.lo).slice(0, 2);
  return [...below, ...above];
}
const md2 = t => { const d = new Date(t + 8 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
function lineStopPts(c) { const a = c.my?.sw60?.atr; return Math.max(20, Math.round((a ?? 120) * 0.5)); }
function addLine(price, c) {
  const p = Math.round(price);
  const lines = loadLines();
  if (lines.some(l => Math.abs(l.price - p) < 3)) return;
  lines.push({ id: Date.now().toString(36), price: p, kind: c.price != null && p > c.price ? "壓力" : "支撐", alert: true });
  lines.sort((a, b) => b.price - a.price);
  saveLines(lines);
}
function drawCard(c) {
  const tf = drawTf();
  const all = drawBars(c, tf);
  if (all.length < 10) return "";
  const zoom = drawZoom(tf);
  const N = Math.min(ZOOMS[zoom], all.length);
  const bars = all.slice(-N);
  const lines = loadLines();
  const price = c.price ?? bars.at(-1).c;
  const mj = majorLevels(all, price, tf === "D" ? 3 : 5);
  const auto = [...mj.lows.map(a => ({ ...a, kind: "前低" })), ...mj.highs.map(a => ({ ...a, kind: "前高" }))];
  const gaps = openGaps(all, price);
  let lo = Math.min(...bars.map(b => b.l), price), hi = Math.max(...bars.map(b => b.h), price);
  const span = hi - lo;
  // 畫面範圍：K 棒加上附近的線（太遠的線不撐開畫面，改列在下面）
  for (const p of [...lines.map(l => l.price), ...auto.map(a => a.price), ...gaps.flatMap(g => [g.lo, g.hi])]) if (p > lo - span * 0.35 && p < hi + span * 0.35) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const W = 700, H = 460, L = 4, Rr = 62;
  const x = i => L + (i + 0.5) * ((W - L - Rr) / N);
  const y = v => 8 + (hi - v) / (hi - lo) * (H - 24);
  const bw = Math.max(1.5, (W - L - Rr) / N * 0.6);
  const candles = bars.map((b, i) => {
    const up = b.c >= b.o, col = up ? "var(--up)" : "var(--down)";
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.h)}" y2="${y(b.l)}" stroke="${col}" stroke-width="1"/><rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, bot - top)}" fill="${up ? "var(--card)" : col}" stroke="${col}"/>`;
  }).join("");
  const inView = p => p >= lo && p <= hi;
  const autoSvg = auto.filter(a => inView(a.price)).map(a => `<line x1="${L}" x2="${W - Rr}" y1="${y(a.price)}" y2="${y(a.price)}" stroke="var(--muted)" stroke-dasharray="2 4" stroke-width="1"/><text x="${L + 4}" y="${y(a.price) - 4}" font-size="13" fill="var(--muted)">${a.kind} ${md2(a.t)} ${fmt(a.price)}</text>`).join("");
  const gapSvg = gaps.filter(g => g.hi >= lo && g.lo <= hi).map(g => {
    const col = g.dir === "up" ? "var(--up)" : "var(--down)";
    const t = y(Math.min(g.hi, hi)), b = y(Math.max(g.lo, lo));
    return `<rect x="${L}" y="${t}" width="${W - Rr - L}" height="${Math.max(1, b - t)}" fill="${col}" fill-opacity=".1"/><line x1="${L}" x2="${W - Rr}" y1="${t}" y2="${t}" stroke="${col}" stroke-opacity=".6" stroke-dasharray="6 3"/><line x1="${L}" x2="${W - Rr}" y1="${b}" y2="${b}" stroke="${col}" stroke-opacity=".6" stroke-dasharray="6 3"/><text x="${W - Rr - 4}" y="${(g.dir === "up" ? b : t) + (g.dir === "up" ? 14 : -4)}" font-size="12" text-anchor="end" fill="${col}">缺口 ${md2(g.t)} ${fmt(g.lo)}～${fmt(g.hi)}</text>`;
  }).join("");
  // 底部日期
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.min(N - 1, Math.round(f * (N - 1)))).map(i => `<text x="${Math.min(Math.max(x(i), 52), W - Rr - 40)}" y="${H - 2}" font-size="13" text-anchor="middle" fill="var(--muted)">${md2(bars[i].t)}${tf === "D" ? "" : " " + new Date(bars[i].t + 8 * 3600e3).toISOString().slice(11, 16)}</text>`).join("");
  const userSvg = lines.filter(l => inView(l.price)).map(l => {
    const col = l.kind === "壓力" ? "var(--mix)" : "var(--accent)";
    return `<line x1="${L}" x2="${W - Rr}" y1="${y(l.price)}" y2="${y(l.price)}" stroke="${col}" stroke-width="2"/><rect x="${W - Rr + 2}" y="${y(l.price) - 9}" width="${Rr - 4}" height="18" rx="3" fill="${col}"/><text x="${W - Rr + 6}" y="${y(l.price) + 4}" font-size="12" font-weight="700" fill="var(--card)">${fmt(l.price)}</text>`;
  }).join("");
  const pr = `<line x1="${L}" x2="${W - Rr}" y1="${y(price)}" y2="${y(price)}" stroke="var(--ink)" stroke-width=".8" stroke-dasharray="1 3"/><text x="${W - Rr + 6}" y="${y(price) + 4}" font-size="12" font-weight="700" fill="var(--ink)">${fmt(price)}</text>`;
  const sp = lineStopPts(c);
  const near = l => Math.abs(price - l.price) <= Math.max(10, sp * 0.3);
  const rows = lines.map(l => {
    const d = l.price - price, res = l.kind === "壓力";
    const plan = res ? `靠近可試空，停損 ${fmt(l.price + sp)}（+${sp}）` : `靠近可試多，停損 ${fmt(l.price - sp)}（−${sp}）`;
    return `<div class="dl-row${near(l) ? " hit" : ""}">
      <b class="dl-p ${res ? "t-mix" : "t-acc"}">${fmt(l.price)}</b>
      <button type="button" class="dl-kind ${res ? "res" : "sup"}" data-dl-kind="${l.id}" aria-label="切換支撐或壓力">${l.kind}</button>
      <span class="dl-d">${near(l) ? "<b>已到附近</b>" : `距現價 ${signed(d)} 點`}${inView(l.price) ? "" : "（在畫面外）"}</span>
      <button type="button" class="ghost dl-ic" data-dl-alert="${l.id}" aria-label="${l.alert ? "關閉提醒" : "開啟提醒"}">${l.alert ? "🔔" : "🔕"}</button>
      <button type="button" class="ghost dl-ic" data-dl-del="${l.id}" aria-label="刪除這條線">✕</button>
      <span class="dl-plan">${plan}</span>
    </div>`;
  }).join("");
  const tfName = tf === "D" ? "日K" : `${tf} 分K`;
  const tfBtns = [["5", "5 分"], ["15", "15 分"], ["30", "30 分"], ["60", "60 分"], ["D", "日K"]].map(([t, n]) => `<button type="button" class="${t === tf ? "primary" : "ghost"}" data-dl-tf="${t}">${n}</button>`).join("");
  const zoomBtns = `<button type="button" class="ghost" data-dl-zoom="-1" ${zoom === 0 ? "disabled" : ""} aria-label="放大（看比較少根）">＋</button><button type="button" class="ghost" data-dl-zoom="1" ${zoom === ZOOMS.length - 1 || N >= all.length ? "disabled" : ""} aria-label="縮小（看比較多根）">－</button>`;
  const autoTxt = [...auto.map(a => `${a.kind} ${md2(a.t)} <b>${fmt(a.price)}</b>`), ...gaps.map(g => `${g.dir === "up" ? "下方缺口" : "上方缺口"} ${md2(g.t)} <b>${fmt(g.lo)}～${fmt(g.hi)}</b>`)].join("｜");
  return `<section class="card" id="draw-card">
    <h2>畫線看盤｜${["5", "15", "30"].includes(tf) ? "微台" : "台指近全"} ${tfName}（${N} 根，${md2(bars[0].t)} 起）</h2>
    <div class="dl-bar">${tfBtns}${zoomBtns}<button type="button" class="${state.drawMode ? "primary" : "ghost"}" data-dl-mode="1">${state.drawMode ? "✏️ 畫線中，點圖加線" : "✏️ 畫線"}</button></div>
    <div class="chart-wrap"><svg id="draw-svg" class="${state.drawMode ? "drawing" : ""}" viewBox="0 0 ${W} ${H}" data-hi="${hi}" data-lo="${lo}" data-h="${H}" role="img" aria-label="${tfName}線與自己畫的線">${gapSvg}${autoSvg}${userSvg}${candles}${pr}${ticks}</svg></div>
    ${autoTxt ? `<p class="dl-auto">系統找到（還沒被破）：${autoTxt}</p>` : ""}
    <div class="dl-add"><input id="dl-price" type="number" inputmode="numeric" placeholder="輸入價位，例如 45700" aria-label="線的價位"><button type="button" class="primary" data-dl-add="1">加線</button></div>
    ${lines.length ? `<div class="dl-list">${rows}</div>` : `<p class="note">還沒有線。按「✏️ 畫線」後點圖上的價位，或直接輸入價位加線。高於現價自動當壓力、低於現價當支撐，點標籤可以切換。</p>`}
    ${lines.length ? `<div class="dl-foot"><button type="button" class="ghost" data-dl-clear="1">${state.dlClear ? "再按一次確定清除全部" : "清除全部線"}</button></div>` : ""}
    <p class="note">停損參考＝60 分K 平均波幅的一半（目前 ${sp} 點）。🔔 開著時，App 開在畫面上、價格碰到或穿過線就會震動跳提醒。線只存在這台裝置。灰色虛線是系統找的前低／前高（之後還沒被跌破／突破），跟著上面選的週期。紅／綠色帶是還沒補完的跳空缺口（之後回到缺口裡會縮小，整個穿過就消失），只顯示現價上下最近各 2 個；回測「缺口回補」沒有優勢，只當地圖參考。60 分K、日K 用台指近全（每天當時的近月合約，跟看盤軟體一樣）。支撐壓力不保證守住，先看主開關方向再決定要不要接。</p>
  </section>`;
}
function bindDraw() {
  const card = document.getElementById("draw-card");
  if (!card) return;
  const c = state.lastC;
  card.querySelectorAll("[data-dl-tf]").forEach(b => b.addEventListener("click", () => { try { localStorage.setItem(DRAW_TF_KEY, b.dataset.dlTf); } catch { /* 忽略 */ } render(); }));
  card.querySelectorAll("[data-dl-zoom]").forEach(b => b.addEventListener("click", () => { const tf = drawTf(); setDrawZoom(tf, Math.max(0, Math.min(ZOOMS.length - 1, drawZoom(tf) + Number(b.dataset.dlZoom)))); render(); }));
  card.querySelector("[data-dl-mode]")?.addEventListener("click", () => { state.drawMode = !state.drawMode; render(); });
  const svg = document.getElementById("draw-svg");
  svg?.addEventListener("click", e => {
    if (!state.drawMode) return;
    const r = svg.getBoundingClientRect(), H = Number(svg.dataset.h), hi = Number(svg.dataset.hi), lo = Number(svg.dataset.lo);
    const vy = (e.clientY - r.top) * H / r.height;
    addLine(hi - (vy - 8) / (H - 24) * (hi - lo), c);
    askNotify();
    render();
  });
  card.querySelector("[data-dl-add]")?.addEventListener("click", () => {
    const v = Number(document.getElementById("dl-price").value);
    if (Number.isFinite(v) && v > 1000) { addLine(v, c); askNotify(); render(); }
  });
  document.getElementById("dl-price")?.addEventListener("keydown", e => { if (e.key === "Enter") card.querySelector("[data-dl-add]").click(); });
  const edit = fn => { const lines = loadLines(); fn(lines); saveLines(lines); render(); };
  card.querySelectorAll("[data-dl-kind]").forEach(b => b.addEventListener("click", () => edit(ls => { const l = ls.find(x => x.id === b.dataset.dlKind); if (l) l.kind = l.kind === "壓力" ? "支撐" : "壓力"; })));
  card.querySelectorAll("[data-dl-alert]").forEach(b => b.addEventListener("click", () => { askNotify(); edit(ls => { const l = ls.find(x => x.id === b.dataset.dlAlert); if (l) l.alert = !l.alert; }); }));
  card.querySelectorAll("[data-dl-del]").forEach(b => b.addEventListener("click", () => edit(ls => { const i = ls.findIndex(x => x.id === b.dataset.dlDel); if (i >= 0) ls.splice(i, 1); })));
  card.querySelector("[data-dl-clear]")?.addEventListener("click", () => { if (state.dlClear) { saveLines([]); state.dlClear = false; } else { state.dlClear = true; setTimeout(() => { state.dlClear = false; }, 5000); } render(); });
}
function askNotify() { try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch { /* 不支援 */ } }
function lineToast(msg) {
  let t = document.getElementById("dl-toast");
  if (!t) { t = document.createElement("div"); t.id = "dl-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 12000);
}
/** 價格碰到或穿過自己畫的線 → 震動＋提醒（App 開著時） */
function checkLineAlerts(c) {
  state.lastC = c;
  const price = c.price;
  if (price == null) return;
  const band = Math.max(10, Math.round(lineStopPts(c) * 0.3));
  const prev = state.lastLinePrice;
  state.lineFired ??= {};
  for (const l of loadLines()) {
    if (!l.alert) continue;
    const dist = Math.abs(price - l.price);
    const crossed = prev != null && (prev - l.price) * (price - l.price) < 0;
    if (dist > band * 3) { state.lineFired[l.id] = false; continue; }
    if ((dist <= band || crossed) && !state.lineFired[l.id]) {
      state.lineFired[l.id] = true;
      if (prev == null) continue; // 剛打開 App 時不算
      const sp = lineStopPts(c);
      const res = l.kind === "壓力";
      const msg = `${crossed ? (price > l.price ? "突破" : "跌破") : "碰到"}${l.kind} ${fmt(l.price)}（現價 ${fmt(price)}）｜${res ? `試空停損 ${fmt(l.price + sp)}` : `試多停損 ${fmt(l.price - sp)}`}`;
      lineToast("📏 " + msg);
      try { navigator.vibrate?.([200, 100, 200]); } catch { /* 忽略 */ }
      try { if ("Notification" in window && Notification.permission === "granted") new Notification("刀神×葵哥｜畫線提醒", { body: msg, tag: "line-" + l.id, icon: "icon-192.png" }); } catch { /* iOS 不在主畫面時不支援 */ }
    }
  }
  state.lastLinePrice = price;
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

// ---------- 刀神：三刀流＋海龜＋PCR ----------
function swordCard(c) {
  const { sw, tt, summary, pcr, price, B } = c;
  const S = B.stats?.sword ?? {};
  const sideCls = { 偏多: "up", 偏空: "down", 短多: "mixed", 短空: "mixed", 觀望: "neutral" }[summary.side] ?? "neutral";
  const row = (who, role, l) => {
    const above = price != null && l.ma != null ? price >= l.ma : null;
    return `<div class="sword-row">
      <div class="who"><b>${who}</b><span>${role}</span></div>
      <div class="val"><span class="p">${fmt(l.ma)}</span><small>MA${l.n}｜${slopeTxt(l.slope)}</small></div>
      <div class="pos ${above == null ? "" : above ? "above" : "below"}">${above == null ? "資料不足" : above ? `現價在上 ${fmt(price - l.ma)}` : `現價在下 ${fmt(l.ma - price)}`}<small>收盤門檻 ${fmt(l.threshold)}</small></div>
    </div>`;
  };
  const liveDiff = sw.live !== sw.confirmed ? `<p class="note"><b>盤中估算：</b>若現在收盤，會變成「${esc(SWORD_MODES[sw.live].label)}」（尚未確認）</p>` : "";
  const st = S[sw.confirmed];
  const stat = st && st.n ? `<p class="note">回測：過去 ${st.n} 次切換到「${esc(SWORD_MODES[sw.confirmed].label)}」後 ${st.horizon} 小時，朝該方向走的比例 ${pct(st.winRate)}，平均 ${signed(st.avgMove)} 點${st.n < 20 ? "（樣本不足，僅供參考）" : ""}</p>` : "";
  const alignTxt = { BULL: "多頭排列（20＞60＞240）", BEAR: "空頭排列（20＜60＜240）", MIXED: "均線糾結（未排列）" }[sw.align];
  const fng = B.fng;
  return `<section class="card sword ${sideCls}">
    <h2>刀神提示｜60分 三刀流 × 4小時海龜</h2>
    <div class="verdict"><span class="side">${esc(summary.side)}</span><span class="mode">${esc(summary.mode.label)}</span></div>
    <p class="say">${esc(summary.text)}</p>
    ${liveDiff}
    <div class="swords">
      ${row("劉備", "戰略方向", sw.liu)}
      ${row("關羽", "進場扣板機", sw.guan)}
      ${row("張飛", "停利收兵", sw.zhang)}
    </div>
    <div class="facts">
      <div><span>排列</span><b>${alignTxt}</b></div>
      <div><span>4小時海龜</span><b>${esc(tt.label)}</b><small>${tt.upper != null ? `突破上軌 ${fmt(tt.upper)}｜跌破下軌 ${fmt(tt.lower)}` : ""}</small></div>
      ${sw.exit ? `<div><span>張飛停利</span><b>${esc(sw.exit.text)}</b><small>門檻 ${fmt(sw.exit.level)}${sw.exit.hit ? "｜<b>上一根已觸發</b>" : ""}</small></div>` : ""}
      ${pcr ? `<div><span>PCR 5日均</span><b>${pcr.avg.toFixed(2)}｜${esc(pcr.label)}</b><small>最新 ${fmtYmd(pcr.last.date).slice(5)}：${pcr.last.ratioVol.toFixed(2)}（賣權量÷買權量）｜只校正部位，不決定方向</small></div>` : ""}
      ${fng ? `<div><span>美股恐懼貪婪</span><b>${Math.round(fng.score)}｜${esc(fngTxt(fng.rating))}</b><small>前一日 ${Math.round(fng.previousClose)}、一週前 ${Math.round(fng.week)}（CNN）</small></div>` : ""}
    </div>
    <ul class="rules">${sw.flips.map(f => `<li>${esc(f.who)}：${esc(f.text)}<span class="st">門檻 ${fmt(f.level)}${price != null ? `，現價${distTxt(price, f.level)}` : ""}</span></li>`).join("")}</ul>
    ${stat}
    <p class="note">「劉備看方向，關羽負責打，張飛負責收。」狀態以已收盤的 60 分K 為準；不要自己當諸葛亮亂預測。</p>
  </section>`;
}
const fngTxt = r => ({ "extreme fear": "極度恐懼", fear: "恐懼", neutral: "中性", greed: "貪婪", "extreme greed": "極度貪婪" })[r] ?? r;

// ---------- 葵哥：前盤三等分 ----------
function kuigeCard(c) {
  const { kg, price, B } = c;
  if (!kg.fixed) return `<section class="card"><h2>葵哥｜前盤三等分</h2><p class="note">沒有前一盤資料。</p></section>`;
  const S = B.stats ?? {};
  const statFor = id => {
    const a = S.intraday?.[id], b = S.session?.[id], base = S.session?.random;
    const v = b && b.n >= 20 ? b : a;
    if (!v) return "";
    const kind = v === b ? `收盤守住 ${pct(b.rate)}（隨機 ${pct(base?.rate)}，${b.n} 次）` : `碰到後先回頭 ${pct(a.rate)}（${a.n} 次）`;
    return `<div><span class="badge ${v.verdict}">${esc(VERDICT_TEXT[v.verdict])}</span>${kind}</div>`;
  };
  const items = [];
  let marked = price == null;
  for (const l of kg.fixed.levels) {
    if (!marked && price > l.price) { items.push(nowMarker(price)); marked = true; }
    const cls = l.price > (price ?? 0) ? "res" : "sup";
    items.push(`<div class="lvl ${cls} kg"><span class="p">${fmt(l.price)}</span><span class="role">${esc(l.label)}</span><span class="dist">距現價 ${signed(price == null ? null : l.price - price)} 點｜每口 ${money(price == null ? 0 : l.price - price)}</span><div class="stat">${statFor(l.id)}</div></div>`);
  }
  if (!marked) items.push(nowMarker(price));
  const cur = kg.current ? `<details class="sub"><summary class="note">目前盤動態三等分（盤中會變）</summary>${kg.current.levels.map(l => `<div class="note">${esc(l.label)} ${fmt(l.price)}</div>`).join("")}</details>` : "";
  return `<section class="card">
    <h2>葵哥｜前盤三等分（${esc(kg.prevLabel ?? "")}）</h2>
    <p class="expect">前盤 高 <b>${fmt(kg.fixed.high)}</b>／低 <b>${fmt(kg.fixed.low)}</b>，振幅 ${fmt(kg.fixed.range)}，每格 ${fmt(kg.fixed.step)} 點。現價位置：<b>${esc(kg.zone?.label ?? "—")}</b></p>
    <div class="ladder">${items.join("")}</div>
    ${cur}
    <p class="note">只保留葵哥最原始的「前盤高低三等分」，不再疊 Pivot、CDP、Fib。每條線的成績單同樣跟隨機線比較。</p>
  </section>`;
}

// ---------- 六層多空點位（日／週／月，自動） ----------
const SIX_KEY = "daoshen-six-mode";
function sixMode() { try { const m = localStorage.getItem(SIX_KEY); return ["D", "W", "M"].includes(m) ? m : "D"; } catch { return "D"; } }
const SIX_NAME = { D: "日", W: "週", M: "月" };
const md = t => `${+t.slice(4, 6)}/${+t.slice(6, 8)}`;
function sixPeriod(c, mode) {
  const r = periodRange(c.B.summaries, mode, c.price);
  return r ? { ...r, L: sixLevels(r.hi, r.lo) } : null;
}
function sixSpan(r) {
  if (r.mode === "D" && r.base) return `${r.base.map(b => `${md(b.start)} ${b.type === "N" ? "夜盤" : "日盤"}`).join("＋")}（前兩盤的最高／最低${r.live ? "，這一盤進行中" : ""}）`;
  const rule = { D: "前一晚夜盤＋當天日盤", W: "上一個完整的週，週三結算到週三結算", M: "上一個完整的月，第三個週三結算到第三個週三結算" }[r.mode];
  return `${md(r.from)}${r.from !== r.to ? `～${md(r.to)}` : ""}（${rule}，${r.days} 個交易日${r.live ? "，含盤中" : ""}）`;
}
function sixResult(r, price) {
  const L = r?.L;
  if (!L) return `<p class="note">資料不足，算不出區間。</p>`;
  const lv = [
    ...L.up.map((p, i) => ({ p, name: `多方第 ${i + 1} 層`, r: SIX_RATIOS[i], side: 1 })),
    { p: L.mid, name: "多空中軸", r: 0, side: 0 },
    ...L.dn.map((p, i) => ({ p, name: `空方第 ${i + 1} 層`, r: SIX_RATIOS[i], side: -1 })),
  ].sort((a, b) => b.p - a.p);
  const rows = [];
  let marked = price == null;
  for (const l of lv) {
    if (!marked && price > l.p) { rows.push(nowMarker(price)); marked = true; }
    const cls = l.side > 0 ? "t-up" : l.side < 0 ? "t-down" : "";
    rows.push(`<div class="lvl ${l.p > (price ?? 0) ? "res" : "sup"} kg"><span class="p ${cls}">${fmt(l.p)}</span><span class="role">${esc(l.name)}${l.r ? ` ×${l.r.toFixed(3)}` : ""}</span>${price != null ? `<span class="dist">距現價 ${signed(l.p - price)} 點｜每口 ${money(l.p - price)}</span>` : ""}</div>`);
  }
  if (!marked) rows.push(nowMarker(price));
  return `<p class="expect">高 <b>${fmt(L.hi)}</b>／低 <b>${fmt(L.lo)}</b>｜多空中軸 <b>${fmt(L.mid)}</b>｜中軸到高低各 ${fmt(L.d)} 點${r.broke ? `｜<b>現價剛突破${price > L.mid ? "高點" : "低點"}，區間已自動放大</b>` : ""}</p>${price != null ? `<p class="expect">現價 <b>${fmt(price)}</b> 在中軸${price >= L.mid ? `<b class="t-up">上方（偏多）</b>` : `<b class="t-down">下方（偏空）</b>`}</p>` : ""}<div class="ladder">${rows.join("")}</div>`;
}
function sixCard(c) {
  const mode = sixMode(), r = sixPeriod(c, mode);
  const btns = SIX_PERIODS.map(([m, label]) => `<button type="button" class="${mode === m ? "primary" : "ghost"}" data-six="${m}">${label}</button>`).join("");
  return `<section class="card" id="six-card">
    <h2>六層多空點位｜${SIX_NAME[mode]}</h2>
    <div class="manual">${btns}</div>
    ${r ? `<p class="note">區間：${esc(sixSpan(r))}。${r.prev ? `高低用上一期（${fmt(r.baseHi)}／${fmt(r.baseLo)}），這一期破高或破底就立刻跟著擴大；${r.mode === "W" ? "下個週三" : "下個月第三個週三"}收盤後換新一期。${r.brokeLo ? `<b>已破底，低點改用 ${fmt(r.lo)}。</b>` : ""}${r.brokeHi ? `<b>已破高，高點改用 ${fmt(r.hi)}。</b>` : ""}` : `基準高 ${fmt(r.baseHi)}／低 ${fmt(r.baseLo)}，這一盤破高或破底就立刻納入重算。${r.brokeLo ? `<b>已破底，低點改用 ${fmt(r.lo)}，各層已重算。</b>` : ""}${r.brokeHi ? `<b>已破高，高點改用 ${fmt(r.hi)}，各層已重算。</b>` : ""}`}</p>` : ""}
    ${sixResult(r, c.price)}
    <p class="note">多空中軸＝（高＋低）÷2；多方＝中軸＋距離×倍率，空方＝中軸−距離×倍率；倍率 0.382／0.618／0.786／1／1.272／1.618。結算日照「週三」「第三個週三」計算，遇到休市順延的那次會差一天。高低用台指期近月（微台同價）。沒有回測驗證，當區間規劃參考。</p>
  </section>`;
}
/** 進場參考目標：六層點位（目前選的日／週／月）在進場價之後的下一階、下下階 */
function sixTargets(c, dir, entry) {
  const r = sixPeriod(c, sixMode());
  if (!r?.L || !dir || entry == null) return null;
  const lv = [...r.L.dn, r.L.mid, ...r.L.up].map(Math.round).sort((a, b) => a - b);
  const t = dir > 0 ? lv.filter(v => v > entry + 1) : lv.filter(v => v < entry - 1).reverse();
  return { mode: r.mode, t: t.slice(0, 2) };
}
function sixTargetHtml(c, dir, entry) {
  const cls = dir > 0 ? "t-up" : "t-down";
  const r = sixTargets(c, dir, entry);
  if (!r?.t.length) return `參考目標 +20 <b class="${cls}">${fmt(entry + dir * 20)}</b>、+80 <b class="${cls}">${fmt(entry + dir * 80)}</b>`;
  const hit = v => c.price != null && (dir > 0 ? c.price >= v : c.price <= v);
  return `🎯 六層目標（${SIX_NAME[r.mode]}）${r.t.map(v => `<b class="${cls}">${fmt(v)}</b>（${signed(v - entry)}${hit(v) ? "，已到" : ""}）`).join("、")}${r.t.length < 2 ? "，再上去看移動停利" : ""}`;
}

/** 刀神首頁用：日／週／月 各自的中軸與上下第 5 層 */
function sixMini(c) {
  const rows = SIX_PERIODS.map(([m, label]) => ({ label, r: sixPeriod(c, m) })).filter(x => x.r?.L);
  if (!rows.length) return "";
  const px = c.price;
  const pos = (L) => px == null ? "" : px > L.up[4] ? "已過多方第 5 層" : px < L.dn[4] ? "已破空方第 5 層" : px >= L.mid ? "中軸上方" : "中軸下方";
  return `<section class="card">
    <h2>六層點位｜第 5 層（×1.272）</h2>
    <div class="six-mini">
      <div class="h"><span></span><span class="t-up">多 5</span><span>中軸</span><span class="t-down">空 5</span></div>
      ${rows.map(({ label, r }) => `<div class="row"><span><b>${label}</b><small>${esc(pos(r.L))}</small></span><b class="t-up">${fmt(r.L.up[4])}</b><b>${fmt(r.L.mid)}</b><b class="t-down">${fmt(r.L.dn[4])}</b></div>`).join("")}
    </div>
    <p class="note">日＝前兩盤（前一個日盤＋夜盤）；週＝上一個完整的週；月＝上一個完整的月；三種都是破高／破底就立刻重算。完整 13 個點位在「葵哥」分頁。方向看上面的主開關與三刀流，這裡只看點位。</p>
  </section>`;
}
function bindSix() {
  document.querySelectorAll("[data-six]").forEach(b => b.addEventListener("click", () => {
    try { localStorage.setItem(SIX_KEY, b.dataset.six); } catch { /* 忽略 */ }
    render();
  }));
}

// ---------- 我的 TradingView 指標（App 內重算） ----------
function myCard(c) {
  const my = c.my;
  if (!my) return "";
  const d = my.sn.dash, w = my.wo, S = c.B.stats?.sniper;
  const posCls = d.position === "持有多單" ? "up" : d.position === "持有空單" ? "down" : "neutral";
  const cell = (k, v, cls = "") => `<div><span>${k}</span><b class="${cls}">${esc(v)}</b></div>`;
  const toneOf = v => (/多|↑|突破站穩|支撐$/.test(v) ? "t-up" : /空|↓|跌破|承壓/.test(v) ? "t-down" : "");
  const sigs = my.sn.signals.slice(-6).reverse().map(s => `<div class="item">${fmtDateTime(s.t)}｜<b class="${/多/.test(s.label) && !/停利/.test(s.label) ? "t-up" : /空/.test(s.label) && !/停利/.test(s.label) ? "t-down" : ""}">${esc(s.label)}</b> 點位 ${fmt(s.price)}</div>`).join("");
  const bt = S?.summary ? `<p class="note">回測（預設參數，${fmtYmd(new Date(S.from + 8 * 3600e3).toISOString().slice(0, 10).replaceAll("-", "")).slice(5)} 起 ${S.summary.n} 筆）：勝率 ${pct(S.summary.winRate)}，合計 ${signed(S.summary.total)} 點（每口 ${S.summary.total >= 0 ? "" : "−"}${money(S.summary.total)}），平均每筆 ${signed(S.summary.avg)} 點，最好 ${signed(S.summary.best)}／最差 ${signed(S.summary.worst)}。未扣手續費與滑價。</p>` : "";
  return `<section class="card sword ${posCls}">
    <h2>我的指標｜微台 PRO v2.4.1 × 洗盤偵測（5 分K）</h2>
    <div class="verdict"><span class="side">${esc(d.action)}</span><span class="mode"></span></div>
    ${posBadge(d.position === "持有多單" ? 1 : d.position === "持有空單" ? -1 : 0, d.entryPx ?? null, c.price ?? my.last?.c)}
    ${sniperFlat(c, d)}
    <p class="note">最後一根：${fmtDateTime(my.last.end)}${my.src === "official" ? "（期交所微台逐筆）" : "（Yahoo 微型台指近一，官方資料出來後自動取代）"}</p>
    <div class="dash">
      ${cell("市場型態", d.market)}${cell("高週期方向", d.htf, toneOf(d.htf))}${cell("本週期結構", d.local, toneOf(d.local))}${cell("Sniper狀態", d.sniper, toneOf(d.sniper))}
      ${cell("ADX / CHOP", d.adxChop)}${cell("停利分數 多／空", d.exitScores)}${cell("SuperTrend", fmt(d.superTrend))}${cell("紅綠趨勢線", fmt(d.redGreenLine))}
    </div>
    <div class="dash two-col">
      ${cell("洗盤：市場狀態", w.state)}
      ${cell("關鍵壓力", `${fmt(w.res1)}（${w.res1Status}）`, toneOf(w.res1Status ?? ""))}
      ${cell("關鍵支撐", `${fmt(w.sup1)}（${w.sup1Status}）`, toneOf(w.sup1Status ?? ""))}
      ${cell("次要", w.lines.filter(x => !x.main).map(x => `${x.tag} ${fmt(x.price)}`).join("、") || "—")}
    </div>
    ${w.marks.length ? `<p class="note">最近洗盤訊號：${w.marks.slice(-3).reverse().map(m => `${fmtDateTime(m.t)} ${m.label} ${fmt(m.price)}`).join("；")}</p>` : ""}
    ${sniperTrades(c)}
    ${bt}
    <p class="note">照你的 Pine 原始碼在 App 裡重算（預設參數、狙擊融合模式），洗盤指標的四條支撐壓力已和你的 TradingView 截圖逐一核對一致。</p>
  </section>`;
}

// ---------- 前低第二支腳（60 分K 主訊號、30 分K 提早提醒） ----------
function swingCard(c) {
  const a = c.my?.sw60, b = c.my?.sw30;
  if (!a || !b) return "";
  const px = c.price ?? a.close;
  const recent = (sw, bars) => { const s = sw.signals.at(-1); return s && s.result == null && Date.now() - s.t < bars * (sw === a ? 3600e3 : 1800e3) ? s : null; };
  const live60 = recent(a, 3), live30 = recent(b, 3);
  const badge = (s, tf, main) => `<div class="${main ? "pos long" : "reentry up"}"><span class="k">${main ? "🔴 60 分K 前低守住" : "🟠 30 分K 前低守住（提早提醒）"}</span>
    <span class="pl">${fmtDateTime(s.t)} 回測前低 <b>${fmt(s.level)}</b>（最低 ${fmt(s.low)}）收 ${fmt(s.close)}｜做多參考：停損 <b>${fmt(s.stop)}</b>、移動停利約 ${fmt(s.trail)} 點</span></div>`;
  const lowsOf = (sw, tf) => sw.lows.length ? sw.lows.slice(0, 3).map(l => `<div class="fr"><span>${tf} 前低</span><span>${fmt(l.price)}</span><b class="${l.near ? "t-up" : ""}">${signed(l.price - px)} 點${l.near ? "<small>接近中</small>" : ""}</b></div>`).join("") : `<div class="fr"><span>${tf} 前低</span><span>—</span><b>目前沒有</b></div>`;
  const hist = [...a.signals.map(s => ({ ...s, tf: "60分" })), ...b.signals.map(s => ({ ...s, tf: "30分" }))].sort((x, y) => y.t - x.t).slice(0, 5);
  const rate = sw => { const d = sw.signals.filter(s => s.result); return d.length ? `${Math.round(d.filter(s => s.result > 0).length / d.length * 100)}%（${d.length} 次）` : "—"; };
  return `<section class="card sword ${live60 || live30 ? "up" : "neutral"}">
    <h2>前低第二支腳（60 分K＋30 分K）</h2>
    ${live60 ? badge(live60, "60", true) : ""}${!live60 && live30 ? badge(live30, "30", false) : ""}
    ${!live60 && !live30 ? `<p class="say">目前沒有新的訊號。價格回到下面這些前低、而且 K 棒收盤守住時會跳出提示。</p>` : ""}
    <div class="flips">${lowsOf(a, "60分")}${lowsOf(b, "30分")}</div>
    ${hist.length ? `<p class="note">最近訊號：${hist.map(s => `${fmtDateTime(s.t)} ${s.tf} ${fmt(s.level)} ${s.result > 0 ? "✓ 守住" : s.result < 0 ? "✗ 跌破" : "…進行中"}`).join("；")}</p>` : ""}
    <p class="note">規則：前低＝左右各 3 根 K 的最低點；價格回到前低 ±0.3 ATR 內、而且這根收盤站在前低之上＝守住。之後先漲 1.5 ATR 算 ✓、先跌 1 ATR 算 ✗。App 內近 12 個交易日：60 分K 守住 ${rate(a)}、30 分K ${rate(b)}。7 週回測：60 分K 守住 79～87%（隨機價位 50～64%），30 分K 75～84%（隨機 66～74%）。前高「第二次過不去」沒有優勢，所以不做。</p>
  </section>`;
}

// ---------- 主開關：60 分K 吊燈出場（多空轉換） ----------
function ceCard(c) {
  const e = c.my?.ce;
  if (!e || e.longStop == null) return "";
  const cls = e.dir > 0 ? "up" : "down";
  const px = c.price ?? e.close;
  const flip = e.dir > 0 ? e.longStop : e.shortStop;
  const dist = e.dir > 0 ? px - flip : flip - px;
  const say = e.dir > 0
    ? `抱多／只找多。60 分K 收盤跌破 ${fmt(flip)} 才轉空（現價還差 ${fmt(dist)} 點）`
    : `抱空／只找空。60 分K 收盤站上 ${fmt(flip)} 才轉多（現價還差 ${fmt(dist)} 點）`;
  return `<section class="card sword ${cls}">
    <h2>多空主開關（60 分K 吊燈）</h2>
    <div class="verdict"><span class="side">${e.dir > 0 ? "多" : "空"}</span><span class="mode">${e.since ? `${fmtDateTime(e.since)} 轉${e.dir > 0 ? "多" : "空"}，轉向價 ${fmt(e.flipPrice)}` : ""}</span></div>
    <p class="say">${esc(say)}</p>
    ${dist < 0 ? `<p class="say">⚠ 現價已越過轉向線，等這根 60 分K 收盤確認</p>` : ""}
    <p class="note">最近轉向：${e.flips.slice(-5).reverse().map(f => `${fmtDateTime(f.t)} ${f.side > 0 ? "轉多" : "轉空"} ${fmt(f.price)}`).join("；") || "—"}</p>
    <p class="note">Chandelier Exit(22, 3)：近 22 根最高收盤 − 3×ATR 是多方防守線，近 22 根最低收盤 + 3×ATR 是空方防守線，只往有利方向移動。回測 9/2～10/17 微台（每筆扣 5 點、轉向就反手）：17 筆、勝率 41%、合計 +2,864 點、最大回落 −1,896；同樣規則用 5 分、15 分、30 分K 都比較差。樣本只有 6 週，當方向濾網用，不是聖杯。</p>
  </section>`;
}

/** 狙擊：每筆交易的損益（進場→停利／盤整出場／反手），最上面是持有中 */
function sniperTrades(c) {
  const my = c.my, px = c.price ?? my.last?.c;
  const T = tradesFrom(my.sn.signals, [{ c: px }]);
  const rows = [...T.closed.map(t => ({ ...t, open: false })), ...(T.open ? [{ side: T.open.side, entry: T.open.entry, t0: T.open.t, pnl: T.open.pnl, open: true }] : [])];
  if (!rows.length) return `<p class="note">最近沒有狙擊交易。</p>`;
  const tone = v => (v > 0 ? "t-up" : v < 0 ? "t-down" : "");
  const row = r => `<div class="fr${r.open ? " open" : ""}"><span>${fmtDateTime(r.t0)}</span><span class="${r.side > 0 ? "t-up" : "t-down"}">${r.side > 0 ? "多" : "空"} ${fmt(r.entry)}${r.open ? "" : ` → ${fmt(r.exit)}`}</span><b class="${tone(r.pnl)}">${signed(r.pnl)} 點<small>${r.open ? "持有中" : esc(r.why.replace("出場", ""))}</small></b></div>`;
  const all = rows.slice().reverse(), first = all.slice(0, 5), rest = all.slice(5);
  const closed = T.closed, tot = closed.reduce((a, t) => a + t.pnl, 0), win = closed.filter(t => t.pnl > 0).length;
  return `<div class="flips">
    ${first.map(row).join("")}
    ${rest.length ? `<details class="more-flips" id="more-snipe"${state.snipeOpen ? " open" : ""}><summary>${state.snipeOpen ? "收起" : `顯示其他 ${rest.length} 筆`}</summary><div class="flips">${rest.map(row).join("")}</div></details>` : ""}
    ${closed.length ? `<div class="fr sum"><span>已結算 ${closed.length} 筆</span><span>勝率 ${Math.round(win / closed.length * 100)}%</span><b class="${tone(tot)}">${signed(tot)} 點</b></div>` : ""}
  </div>`;
}

/** 狙擊空手時：上一筆結果＋原趨勢還在就提示可再進場 */
function sniperFlat(c, d) {
  if (d.position !== "空手") return "";
  const my = c.my, px = c.price ?? my.last?.c;
  const T = tradesFrom(my.sn.signals, [{ c: px }]);
  const last = T.closed.at(-1);
  const head = `<div class="pos flat"><span class="k">空手</span>${last ? `<span class="pl">上一筆 ${last.side > 0 ? "多單" : "空單"} ${fmt(last.entry)} → ${fmt(last.exit)}（${esc(last.why.replace("出場", ""))}）<b class="${last.pnl > 0 ? "t-up" : last.pnl < 0 ? "t-down" : ""}">${signed(last.pnl)} 點</b></span>` : ""}</div>`;
  return head;
}

/** 每次翻向的損益：翻向價進場，下一次翻向價出場；最後一筆用現價算浮動損益（每筆扣 0 點，未含手續費） */
function flipTable(flips, px, snipes = []) {
  const dual = f => snipes.some(s => (s.type === "LONG" ? 1 : s.type === "SHORT" ? -1 : 0) === f.side && Math.abs(s.t - f.t) <= 15 * 60000);
  if (!flips?.length) return `<p class="note">最近還沒有翻向紀錄。</p>`;
  const rows = flips.map((f, i) => {
    const exit = flips[i + 1]?.price ?? px;
    const pnl = exit == null ? null : (exit - f.price) * f.side;
    return { ...f, pnl, open: !flips[i + 1] };
  });
  const closed = rows.filter(r => !r.open && r.pnl != null);
  const tot = closed.reduce((a, r) => a + r.pnl, 0), win = closed.filter(r => r.pnl > 0).length;
  const tone = v => (v > 0 ? "t-up" : v < 0 ? "t-down" : "");
  const all = rows.slice().reverse(), first = all.slice(0, 5), rest = all.slice(5);
  const row = r => `<div class="fr${r.open ? " open" : ""}"><span>${fmtDateTime(r.t)}</span><span class="${r.side > 0 ? "t-up" : "t-down"}">${dual(r) ? "⭐" : ""}${r.er != null && r.er >= CHASE_ER ? "⛔" : ""}${r.side > 0 ? "翻多" : "翻空"} ${fmt(r.price)}</span><b class="${tone(r.pnl)}">${r.pnl == null ? "—" : `${signed(r.pnl)} 點`}${r.open ? "<small>持有中</small>" : ""}</b></div>`;
  return `<div class="flips">
    ${first.map(row).join("")}
    ${rest.length ? `<details class="more-flips" id="more-flips"${state.flipsOpen ? " open" : ""}><summary>${state.flipsOpen ? "收起" : `顯示其他 ${rest.length} 筆`}</summary><div class="flips">${rest.map(row).join("")}</div></details>` : ""}
    ${closed.length ? `<div class="fr sum"><span>已結算 ${closed.length} 筆</span><span>勝率 ${Math.round(win / closed.length * 100)}%</span><b class="${tone(tot)}">${signed(tot)} 點</b></div>` : ""}
  </div>
  ${(() => { const ok = closed.filter(r => r.er != null && r.er < CHASE_ER), bad = closed.filter(r => r.er != null && r.er >= CHASE_ER); if (!bad.length) return ""; const s = a => a.reduce((x, r) => x + r.pnl, 0), w = a => a.length ? Math.round(a.filter(r => r.pnl > 0).length / a.length * 100) : 0; return `<p class="note">⛔ 追價單（翻向前 2 小時效率 ≥ ${CHASE_ER}）：${bad.length} 筆，勝率 ${w(bad)}%，合計 <b class="${tone(s(bad))}">${signed(s(bad))} 點</b>｜不追的：${ok.length} 筆，勝率 ${w(ok)}%，合計 <b class="${tone(s(ok))}">${signed(s(ok))} 點</b>（這裡是「翻向就反手」的算法、沒過濾主開關；回測規則見上面說明）</p>`; })()}
  ${(() => { const d = closed.filter(dual); if (!d.length) return ""; const t = d.reduce((a, r) => a + r.pnl, 0), w = d.filter(r => r.pnl > 0).length; return `<p class="note">⭐ 雙重確認（狙擊 3 根內同向）：${d.length} 筆，勝率 ${Math.round(w / d.length * 100)}%，合計 <b class="${tone(t)}">${signed(t)} 點</b></p>`; })()}
  <p class="note">每筆＝在翻向價進場、下一次翻向價出場（反手），最上面一筆是目前持有中的浮動損益。統計範圍是 App 現有的近 12 個交易日 5 分K，沒扣手續費與滑價。</p>`;
}

/** 持倉醒目標示：持有多單／空單＋進場點位＋目前損益 */
function posBadge(side, entry, price) {
  if (!side || entry == null) return "";
  const pnl = price == null ? null : (price - entry) * side;
  return `<div class="pos ${side > 0 ? "long" : "short"}"><span class="k">${side > 0 ? "持有多單" : "持有空單"}</span><span class="v">${fmt(entry)}</span>${pnl == null ? "" : `<span class="pl">${signed(pnl)} 點｜每口 ${pnl >= 0 ? "" : "−"}${money(Math.abs(pnl))}</span>`}</div>`;
}

// ---------- 傑哥戰神帶狀（近似） ----------
function zsCard(c) {
  const z = c.my?.zs;
  if (!z || z.up == null) return "";
  const cls = z.dir > 0 ? "up" : z.dir < 0 ? "down" : "neutral";
  const px = c.price ?? z.close;
  const pos = px > z.up ? "在帶狀上方" : px < z.lo ? "在帶狀下方" : "在帶狀裡面";
  const chase = er => er != null && er >= CHASE_ER;
  const erTxt = er => (er == null ? "—" : er.toFixed(2));
  const chaseLine = z.dir && z.flipEr != null
    ? (chase(z.flipEr)
      ? `<p class="say chase">⛔ 這次翻向是<b>追價</b>：翻向前 2 小時已經單邊走（效率 ${erTxt(z.flipEr)} ≥ ${CHASE_ER}），回測跳過這種單比較好，<b>這筆不做</b>。</p>`
      : `<p class="say">✅ 不是追價：翻向前 2 小時在來回震盪（效率 ${erTxt(z.flipEr)} &lt; ${CHASE_ER}）。</p>`)
    : "";
  const nowLine = `<p class="note">現在的效率 ${erTxt(z.erNow)}：${chase(z.erNow) ? "⛔ 如果這時候翻向＝追價，不做" : "✅ 如果這時候翻向＝可以做（還要看主開關方向）"}。效率＝近 2 小時（24 根 5 分K）淨走幅 ÷ 來回總走幅，0 是來回震盪、1 是一路單邊。</p>`;
  const flipNeed = z.pending
    ? `⚠ 已有 ${z.pending.count} 根收在帶狀${z.pending.side > 0 ? "上方" : "下方"}，再 ${z.pending.need - z.pending.count} 根收在${z.pending.side > 0 ? "上方" : "下方"}就翻${z.pending.side > 0 ? "多" : "空"}`
    : z.dir < 0 ? `2 根收盤站上上軌 ${fmt(z.up)} 才翻多（還差 ${fmt(z.up - px)} 點）` : z.dir > 0 ? `2 根收盤跌破下軌 ${fmt(z.lo)} 才翻空（還差 ${fmt(px - z.lo)} 點）` : "等收盤穿出任一邊";
  return `<section class="card sword ${cls}">
    <h2>傑哥戰神帶狀（5 分K，近似）</h2>
    <div class="verdict"><span class="side">${z.dir > 0 ? "偏多" : z.dir < 0 ? "偏空" : "未定"}</span><span class="mode">${z.since ? `${fmtDateTime(z.since)} 翻向` : ""}</span></div>
    ${posBadge(z.dir, z.flipPrice, px)}
    ${chaseLine}
    ${z.dir && z.flipPrice != null ? `<p class="say">🛡 智慧單：移動停利 180 點（初始停損 <b>${fmt(z.flipPrice - z.dir * 180)}</b>）｜${sixTargetHtml(c, z.dir, z.flipPrice)}${c.my?.ce ? (c.my.ce.dir === z.dir ? "｜✅ 順主開關" : "｜⚠️ 逆主開關，回測勝率低，建議不做") : ""}</p>` : ""}
    <div class="dash">
      <div><span>上軌</span><b>${fmt(z.up)}</b></div><div><span>中軌</span><b>${fmt(z.mid)}</b></div>
      <div><span>下軌</span><b>${fmt(z.lo)}</b></div><div><span>現價</span><b>${fmt(px)}｜${pos}</b></div>
    </div>
    <p class="say">${esc(flipNeed)}</p>
    ${nowLine}
    ${flipTable(z.flips, px, c.my?.sn?.signals)}
    <p class="note">帶狀公式由你的截圖反推（最高價 WMA24／收盤 WMA20／最低價 WMA24），跟原版差約 1～3 點。翻向規則「2 根 5 分K 收在帶狀另一側（中間沒有收回原方向那一側）」：對照傑哥 10/16、10/19 共 10 筆訊號，方向與筆數全部一致，時間多數相同或差 1 根，少數晚 2～5 根。</p>
  </section>`;
}

// ---------- TradingView 快訊 ----------
function signalsCard(c) {
  const sig = state.signals;
  if (!sig || !sig.configured) return "";
  if (sig.error) return `<section class="card"><h2>TradingView 快訊</h2><p class="note">讀不到快訊（${esc(sig.error)}）</p></section>`;
  const list = sig.items.slice(0, 6);
  if (!list.length) return `<section class="card"><h2>TradingView 快訊</h2><p class="note">還沒有收到快訊。</p></section>`;
  const latest = list[0];
  const cls = latest.side === "多" ? "up" : latest.side === "空" ? "down" : "neutral";
  return `<section class="card sword ${cls}">
    <h2>TradingView 快訊</h2>
    <div class="verdict"><span class="side">${esc(latest.side ?? "—")}</span><span class="mode">${esc(latest.source ?? "")}${latest.price ? `｜${fmt(latest.price)}` : ""}</span></div>
    <p class="say">${esc(latest.text)}</p>
    <p class="note">${fmtDateTime(latest.at)}${latest.price && c.price != null ? `｜距現價 ${signed(c.price - latest.price)} 點` : ""}</p>
    <div class="review">${list.slice(1).map(s => `<div class="item">${fmtDateTime(s.at)}｜<b>${esc(s.side ?? "")}</b> ${esc(s.text)}</div>`).join("")}</div>
  </section>`;
}

function bind() {
  document.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => {
    state.tab = b.dataset.tab;
    try { localStorage.setItem("daoshen-tab", state.tab); } catch { /* 忽略 */ }
    render();
    window.scrollTo({ top: 0 });
  }));
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
// 盤中每 60 秒自動抓一次即時行情；伺服器資料每 5 分鐘重抓
setInterval(() => { if (!document.hidden && state.base) refreshLive(); }, 60_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden) load(); }, 5 * 60_000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
void LINE_DEFS;
load();
