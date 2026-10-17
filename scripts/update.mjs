// 資料更新主程式（GitHub Actions 每 15 分鐘執行）。
// 1. 期交所日行情（多年，算日K與收盤回測）  2. 期交所逐筆檔（最近 30 個交易日，重建 15 分K）
// 3. Yahoo 台指期近一分鐘走勢（盤中暫存）    4. 回測統計  5. 盤前計畫封存  6. 產生網站用 bundle.json
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fetchBuffer, taifexDailyZipUrl, fetchFutDataDown, fetchYahooChart, decodeBig5 } from "./lib/sources.mjs";
import { parseDailyCsv, buildCalendar, expiryOverrides, contractDataset, bars15Of } from "./lib/dataset.mjs";
import { ticksToSessions } from "../engine/bars.js";
import { classifyTick, sessionAt, sessionStartMs, sessionEndMs, frontContract, nextTradingDate, SESSION, sessionKey } from "../engine/sessions.js";
import { tpeParts, addDays, weekdayOf } from "../engine/time.js";
import { intradayTouchStudy, sessionCloseStudy } from "../engine/backtest.js";
import { analyzeStructure } from "../engine/structure.js";
import { buildPlan } from "../engine/plan.js";

const DATA = process.env.DATA_DIR ?? "data";
const NOW = Number(process.env.NOW_MS ?? Date.now());
const BACKFILL_MONTHS = Number(process.env.BACKFILL_MONTHS ?? 36);
const OFFLINE = process.env.OFFLINE === "1";
const report = { at: new Date(NOW).toISOString(), steps: [] };
const step = (name, info) => { report.steps.push({ name, ...info }); console.log(`::notice title=${name}::${JSON.stringify(info).slice(0, 900)}`); };

const p = (...x) => join(DATA, ...x);
const readJson = (f, fb = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fb; } };
const writeJson = (f, v) => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, JSON.stringify(v)); };
const list = dir => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")) : []);

mkdirSync(DATA, { recursive: true });
const meta = readJson(p("meta.json"), { dailyFetched: {}, tickFetched: {}, tickMissing: {} });
const today = tpeParts(NOW).ymd;

// ---------- 1. 期交所日行情 ----------
function monthsBack(n) {
  const out = [];
  let y = Number(today.slice(0, 4)), m = Number(today.slice(4, 6));
  for (let i = 0; i < n; i += 1) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m -= 1; if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

async function updateDaily() {
  if (OFFLINE) return;
  const months = monthsBack(BACKFILL_MONTHS);
  let fetched = 0, failed = 0;
  for (const ym of months) {
    const file = p("daily", `TX-${ym}.json`);
    const isRecent = ym >= monthsBack(2).at(-1);
    const last = meta.dailyFetched[ym] ?? 0;
    // 舊月份抓一次就好；本月與上月每 2 小時最多抓一次
    if (existsSync(file) && (!isRecent || NOW - last < 2 * 3600_000)) continue;
    const y = ym.slice(0, 4), m = ym.slice(4, 6);
    const endDay = ym === today.slice(0, 6) ? today.slice(6, 8) : String(new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate()).padStart(2, "0");
    try {
      const text = await fetchFutDataDown("TX", `${y}/${m}/01`, `${y}/${m}/${endDay}`);
      const rows = parseDailyCsv(text);
      writeJson(file, { month: ym, fetchedAt: NOW, rows });
      meta.dailyFetched[ym] = NOW;
      fetched += 1;
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      failed += 1;
      step("daily-error", { ym, error: String(e).slice(0, 200) });
      if (failed >= 3 && fetched === 0) break; // 整個連不上就不要一直打
    }
  }
  step("daily", { fetched, failed });
}

// ---------- 2. 期交所逐筆檔 ----------
function recentWeekdays(days) {
  const out = [];
  for (let i = 0; out.length < days; i += 1) {
    const d = addDays(today, -i);
    const wd = weekdayOf(d);
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

async function updateTicks(calendarGuess) {
  if (OFFLINE) return;
  let fetched = 0, skipped = 0, missing = 0;
  const minute = tpeParts(NOW).minute;
  for (const d of recentWeekdays(32)) {
    const file = p("ticks", `${d}.json`);
    const have = readJson(file);
    // 已經有日盤＋完整夜盤的檔就不再抓
    if (have?.complete) { skipped += 1; continue; }
    // 當天的檔：日盤收盤後才可能完整；其餘時間每小時最多試一次
    const lastTry = meta.tickFetched[d] ?? 0;
    if (have && NOW - lastTry < 50 * 60_000) { skipped += 1; continue; }
    if (meta.tickMissing[d] && NOW - meta.tickMissing[d] < 3 * 3600_000 && d !== today) { skipped += 1; continue; }
    if (d === today && minute < 14 * 60 && !have && minute > 6 * 60) { /* 早上可試抓夜盤 */ }
    try {
      const buf = await fetchBuffer(taifexDailyZipUrl(d), {}, { retries: 1, timeoutMs: 120_000 });
      meta.tickFetched[d] = NOW;
      if (!(buf[0] === 0x50 && buf[1] === 0x4b)) { meta.tickMissing[d] = NOW; missing += 1; continue; }
      const tmp = `/tmp/daoshen-${d}.zip`;
      writeFileSync(tmp, buf);
      const text = decodeBig5(execFileSync("unzip", ["-p", tmp], { maxBuffer: 1 << 30 }));
      const byContract = ticksToSessions(text);
      const sessions = [];
      for (const [contract, recs] of byContract) for (const rec of recs.values()) sessions.push(rec);
      // 只留成交量前兩大的合約（近月、次月），避免存一堆遠月
      const vol = c => sessions.filter(s => s.contract === c).reduce((s, r) => s + r.bars.reduce((a, b) => a + (b ? b[4] : 0), 0), 0);
      const keep = [...new Set(sessions.map(s => s.contract))].sort((a, b) => vol(b) - vol(a)).slice(0, 2);
      const kept = sessions.filter(s => keep.includes(s.contract));
      const hasDay = kept.some(s => s.type === "D" && sessionEndMs(s.start, s.type) <= NOW);
      writeJson(file, { file: d, fetchedAt: NOW, complete: hasDay && NOW - tpeMsOf(d, 14 * 60) > 0, sessions: kept.map(s => ({ ...s, complete: sessionEndMs(s.start, s.type) <= NOW - 60_000 })) });
      fetched += 1;
      delete meta.tickMissing[d];
    } catch (e) {
      meta.tickFetched[d] = NOW;
      step("tick-error", { d, error: String(e).slice(0, 200) });
    }
  }
  step("ticks", { fetched, skipped, missing });
  void calendarGuess;
}

function tpeMsOf(ymd, minute) {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) - 8 * 3600_000 + minute * 60_000;
}

// ---------- 3. Yahoo 盤中 ----------
async function updateYahoo(frontFor) {
  if (OFFLINE) return null;
  try {
    const json = await fetchYahooChart();
    const ts = json.timestamp ?? [];
    const q = json.indicators?.quote?.[0] ?? {};
    const recs = new Map();
    let lastT = 0, lastPrice = null;
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i] * 1000;
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i] ?? 0;
      if (![o, h, l, c].every(Number.isFinite)) continue;
      const parts = tpeParts(t);
      const clock = `${String(Math.floor(parts.minute / 60)).padStart(2, "0")}${String(parts.minute % 60).padStart(2, "0")}00`;
      const slot = classifyTick(parts.ymd, clock);
      if (!slot) continue;
      const key = sessionKey(slot.start, slot.type);
      let rec = recs.get(key);
      if (!rec) { rec = { start: slot.start, type: slot.type, source: "yahoo", bars: new Array(SESSION[slot.type].slots15).fill(null) }; recs.set(key, rec); }
      const b = rec.bars[slot.slot];
      if (!b) rec.bars[slot.slot] = [o, h, l, c, v];
      else { b[1] = Math.max(b[1], h); b[2] = Math.min(b[2], l); b[3] = c; b[4] += v; }
      if (t >= lastT) { lastT = t; lastPrice = c; }
    }
    const metaPrice = Number(json.quote?.price ?? json.meta?.regularMarketPrice);
    const quotedAt = (json.meta?.regularMarketTime ?? 0) * 1000;
    const out = [];
    for (const rec of recs.values()) {
      const end = sessionEndMs(rec.start, rec.type);
      rec.complete = NOW >= end + 2 * 60_000;
      rec.contract = frontFor(rec.start, rec.type);
      out.push(rec);
      // 盤結束後把暫存寫進 repo，下一盤的盤前計畫才用得到（官方逐筆檔出來後會被取代）
      if (rec.complete) writeJson(p("provisional", `${sessionKey(rec.start, rec.type)}.json`), rec);
    }
    const live = { fetchedAt: NOW, lastBarTime: lastT || null, lastPrice: Number.isFinite(metaPrice) ? metaPrice : lastPrice, quotedAt: quotedAt || lastT || null, sessions: out.filter(r => !r.complete), source: "Yahoo奇摩股市 台指期近一（分鐘走勢，可能延遲）" };
    step("yahoo", { points: ts.length, sessions: out.map(r => `${r.start}${r.type}:${r.bars.filter(Boolean).length}${r.complete ? "✓" : "…"}`), lastPrice: live.lastPrice, lastBarTime: lastT ? new Date(lastT).toISOString() : null });
    return live;
  } catch (e) {
    step("yahoo-error", { error: String(e).slice(0, 200) });
    return null;
  }
}

// ---------- 載入 ----------
function loadAll() {
  const dailyRows = list(p("daily")).flatMap(f => readJson(p("daily", f))?.rows ?? []);
  const tickSessions = list(p("ticks")).flatMap(f => readJson(p("ticks", f))?.sessions ?? []);
  const provisional = list(p("provisional")).map(f => readJson(p("provisional", f))).filter(Boolean);
  const calendar = buildCalendar(dailyRows, tickSessions);
  const expiry = expiryOverrides(dailyRows, calendar);
  return { dailyRows, tickSessions, provisional, calendar, expiry };
}

function frontForFactory(calendar, expiry) {
  return (start, type) => frontContract(type === "D" ? start : nextTradingDate(start, calendar).date, expiry);
}

// ---------- 4. 回測 ----------
function updateStats(all) {
  const hash = createHash("sha1").update(JSON.stringify([list(p("ticks")).map(f => [f, readJson(p("ticks", f))?.fetchedAt]), list(p("daily")).length, all.dailyRows.length])).digest("hex");
  const cached = readJson(p("stats.json"));
  if (cached?.hash === hash) return cached;
  const contracts = [...new Set(all.tickSessions.map(s => s.contract))];
  const intraInput = [];
  for (const c of contracts) {
    const ds = contractDataset(c, { ...all, provisional: [], nowMs: NOW });
    const official = { ...ds, sessions15: ds.sessions15.filter(s => s.source === "official" && s.complete !== false) };
    const b15 = bars15Of(official);
    const sessions = official.sessions15.map(s => ({ key: sessionKey(s.start, s.type), td: s.td, type: s.type, front: ds.fronts.has(`${s.td}${s.type}`) }));
    intraInput.push({ contract: c, bars15: b15, sessions, daily: ds.daily });
  }
  const intraday = intradayTouchStudy(intraInput);
  const dailyContracts = [...new Set(all.dailyRows.map(r => r.contract))];
  const sessInput = dailyContracts.map(c => {
    const ds = contractDataset(c, { ...all, tickSessions: [], provisional: [], nowMs: NOW });
    return { contract: c, sessions: ds.summaries.map(s => ({ ...s, key: `${s.td}${s.type}`, front: ds.fronts.has(`${s.td}${s.type}`) })), daily: ds.daily };
  });
  const session = sessionCloseStudy(sessInput);
  const tdList = all.calendar;
  const stats = {
    hash, computedAt: NOW,
    intraday: intraday.byType, session,
    coverage: {
      intradayFrom: intraInput.flatMap(x => x.bars15).reduce((m, b) => Math.min(m, b.t), Infinity),
      intradayTo: intraInput.flatMap(x => x.bars15).reduce((m, b) => Math.max(m, b.t), 0),
      sessionFrom: tdList[0] ?? null, sessionTo: tdList.at(-1) ?? null,
    },
    recentEvents: intraday.events.slice(-60),
  };
  writeJson(p("stats.json"), stats);
  step("stats", { intradayTypes: Object.fromEntries(Object.entries(stats.intraday).map(([k, v]) => [k, `${v.n}:${v.rate?.toFixed(2)}:${v.verdict}`])), sessionTypes: Object.fromEntries(Object.entries(stats.session).map(([k, v]) => [k, `${v.n}:${v.rate?.toFixed(2)}:${v.verdict}`])) });
  return stats;
}

// ---------- 5 & 6. 計畫與網站資料 ----------
function buildBundle(all, stats, live) {
  const target = sessionAt(NOW, all.calendar);
  const td = target.type === "D" ? target.start : nextTradingDate(target.start, all.calendar).date;
  const contract = frontContract(td, all.expiry);
  const provisional = [...all.provisional, ...(live?.sessions ?? []).map(s => ({ ...s, contract: s.contract ?? contract }))];
  const ds = contractDataset(contract, { ...all, provisional, nowMs: NOW });
  // 只送最近 40 個交易日的 15 分K 給手機（MA240 60分約需 13 個交易日）
  const keepFrom = all.calendar.at(-40) ?? "00000000";
  const sessions15 = ds.sessions15.filter(s => s.td >= keepFrom);
  const summaries = ds.summaries.slice(-400);

  const targetKey = sessionKey(target.start, target.type);
  const planFile = p("plans", `${targetKey}.json`);
  let plan = readJson(planFile);
  const minsToStart = (sessionStartMs(target.start, target.type) - NOW) / 60_000;
  if (!plan && (minsToStart <= 150 || target.live)) {
    // 只用目前已完成的 K 棒
    const doneSessions = ds.sessions15.filter(s => sessionEndMs(s.start, s.type) <= NOW);
    const b15 = bars15Of({ sessions15: doneSessions });
    if (b15.length) {
      const dataAsOf = b15.at(-1).end;
      const daily = ds.daily.filter(d => d.complete);
      const analysis = analyzeStructure({ daily, bars15: b15, dataAsOf });
      const prev = ds.summaries.filter(s => s.complete).at(-1);
      plan = buildPlan({ analysis, session: { start: target.start, type: target.type, td }, prevSession: prev, summaries: ds.summaries, stats, contract, refPrice: b15.at(-1).c, createdAt: NOW });
      plan.late = target.live; // 開盤後才補做的計畫要標示
      plan.dataAsOf = dataAsOf;
      plan.dataSources = [...new Set(doneSessions.slice(-3).map(s => s.source))];
      writeJson(planFile, plan);
      step("plan", { key: targetKey, late: plan.late, lines: plan.lines.map(l => `${l.label}@${l.price}`) });
    }
  }
  const plans = list(p("plans")).sort().slice(-30).map(f => readJson(p("plans", f)));
  const officialThrough = ds.sessions15.filter(s => s.source === "official").at(-1);
  return {
    builtAt: NOW,
    contract,
    target: { ...target, td, key: targetKey },
    calendarTail: all.calendar.slice(-10),
    sessions15, summaries,
    live: live ? { lastPrice: live.lastPrice, quotedAt: live.quotedAt, lastBarTime: live.lastBarTime, fetchedAt: live.fetchedAt, source: live.source } : null,
    status: {
      officialThrough: officialThrough ? sessionKey(officialThrough.start, officialThrough.type) : null,
      dailyThrough: all.calendar.at(-1) ?? null,
      provisional: sessions15.filter(s => s.source === "yahoo").map(s => sessionKey(s.start, s.type)),
    },
    stats: stats && { intraday: stats.intraday, session: stats.session, coverage: stats.coverage, computedAt: stats.computedAt },
    plans,
    report: report.steps,
  };
}

// ---------- main ----------
await updateDaily();
let all = loadAll();
await updateTicks(all.calendar);
all = loadAll();
const live = await updateYahoo(frontForFactory(all.calendar, all.expiry));
all = loadAll();
const stats = updateStats(all);
const bundle = buildBundle(all, stats, live);
writeJson(p("bundle.json"), bundle);
writeJson(p("meta.json"), meta);
writeJson(p("last-run.json"), report);
console.log(`bundle: contract=${bundle.contract} target=${bundle.target.key} sessions15=${bundle.sessions15.length} summaries=${bundle.summaries.length}`);
