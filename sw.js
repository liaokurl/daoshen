// 車干製V1.5：資料走網路優先，畫面檔案可離線
const CACHE = "daoshen-v2.9";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png", "icon-64.png", "logo.png",
  "signals.js", "live.js", "engine/yahoo.js", "config.json", "engine/sword.js", "engine/kuige.js", "engine/pine.js", "engine/myind.js", "engine/bars.js", "engine/sessions.js", "engine/time.js", "engine/indicators.js", "engine/structure.js", "engine/backtest.js", "engine/plan.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // 一律網路優先，斷線才用快取（避免看到舊程式或舊資料）
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(url.pathname.endsWith("bundle.json") ? new Request("data/bundle.json") : e.request, copy)); }
    return r;
  }).catch(() => caches.match(url.pathname.endsWith("bundle.json") ? new Request("data/bundle.json") : e.request)));
});
