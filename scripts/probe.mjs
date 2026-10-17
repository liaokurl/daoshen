// 資料來源探測：確認 GitHub 主機連得到期交所與 Yahoo，並印出實際格式。
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fetchBuffer, taifexDailyZipUrl, fetchFutDataDown, fetchYahooChart, decodeBig5 } from "./lib/sources.mjs";

const out = { at: new Date().toISOString(), checks: [] };
const log = (name, data) => { out.checks.push({ name, ...data }); console.log(`\n## ${name}\n${JSON.stringify(data, null, 2).slice(0, 4000)}`); };

const dates = [];
for (let i = 0; i < 6; i += 1) {
  const d = new Date(Date.now() + 8 * 3600_000 - i * 86_400_000);
  dates.push(d.toISOString().slice(0, 10).replaceAll("-", ""));
}

for (const d of dates) {
  try {
    const buf = await fetchBuffer(taifexDailyZipUrl(d));
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    let info = { bytes: buf.length, isZip };
    if (isZip) {
      mkdirSync("/tmp/probe", { recursive: true });
      writeFileSync(`/tmp/probe/${d}.zip`, buf);
      const text = decodeBig5(execFileSync("unzip", ["-p", `/tmp/probe/${d}.zip`], { maxBuffer: 1 << 30 }));
      const lines = text.split(/\r?\n/);
      const tx = lines.filter(l => /^\d{8},TX\s*,/.test(l));
      const dateSet = [...new Set(tx.map(l => l.split(",")[0]))];
      const times = tx.map(l => l.split(",")[3].trim());
      const contracts = {};
      for (const l of tx) { const c = l.split(",")[2].trim(); contracts[c] = (contracts[c] ?? 0) + 1; }
      info = { ...info, lines: lines.length, header: lines[0], sample: lines.slice(1, 4), txRows: tx.length, txDates: dateSet, firstTime: times[0], lastTime: times.at(-1), minTime: times.reduce((a, b) => (a < b ? a : b), "999999"), maxTime: times.reduce((a, b) => (a > b ? a : b), "000000"), contracts, txSample: tx.slice(0, 3) };
    } else info.head = buf.subarray(0, 200).toString("latin1");
    log(`tick ${d}`, info);
  } catch (e) { log(`tick ${d}`, { error: String(e) }); }
}

try {
  const now = new Date(Date.now() + 8 * 3600_000);
  const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const text = await fetchFutDataDown("TX", `${ym}/01`, `${ym}/${String(now.getUTCDate()).padStart(2, "0")}`);
  const lines = text.split(/\r?\n/);
  log("futDataDown TX", { lines: lines.length, header: lines[0], sample: lines.slice(1, 8), tail: lines.slice(-6) });
} catch (e) { log("futDataDown TX", { error: String(e) }); }

try {
  const json = await fetchYahooChart();
  const keys = Object.keys(json);
  const ts = json.timestamp ?? [];
  const q = json.indicators?.quote?.[0] ?? {};
  log("yahoo WTX&", { keys, metaKeys: Object.keys(json.meta ?? {}), meta: json.meta, quote: json.quote, points: ts.length, firstTs: ts[0], lastTs: ts.at(-1), quoteKeys: Object.keys(q), sample: ts.slice(-3).map((t, i) => ({ t, o: q.open?.at(-3 + i), h: q.high?.at(-3 + i), l: q.low?.at(-3 + i), c: q.close?.at(-3 + i), v: q.volume?.at(-3 + i) })) });
} catch (e) { log("yahoo WTX&", { error: String(e) }); }

mkdirSync("probe", { recursive: true });
writeFileSync("probe/probe.json", JSON.stringify(out, null, 2));
