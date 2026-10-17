// 資料來源探測（PCR、恐懼貪婪指數）
import { writeFileSync, mkdirSync } from "node:fs";
import { fetchBuffer, decodeBig5 } from "./lib/sources.mjs";
const out = { at: new Date().toISOString(), checks: [] };
const log = (name, data) => { out.checks.push({ name, ...data }); console.log(name, JSON.stringify(data).slice(0, 2000)); };
try {
  const body = new URLSearchParams({ down_type: "", queryStartDate: "2026/09/20", queryEndDate: "2026/10/17" });
  const buf = await fetchBuffer("https://www.taifex.com.tw/cht/3/pcRatioDown", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const text = decodeBig5(buf);
  log("pcr", { bytes: buf.length, head: text.slice(0, 1200) });
} catch (e) { log("pcr", { error: String(e) }); }
try {
  const buf = await fetchBuffer("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", accept: "application/json", referer: "https://edition.cnn.com/" } });
  const j = JSON.parse(buf.toString());
  log("fng", { keys: Object.keys(j), fear_and_greed: j.fear_and_greed });
} catch (e) { log("fng", { error: String(e) }); }
mkdirSync("probe", { recursive: true });
writeFileSync("probe/probe.json", JSON.stringify(out, null, 2));
