// Najpierw sieć, kopia tylko na wypadek braku internetu — dzięki temu nowe odcinki i poprawki
// strony nigdy nie utkną w pamięci telefonu. Kafelków mapy nie zapisujemy (regulamin OSM).
const CACHE = "ksiapulo-v1";
const CDN = ["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const own = url.origin === location.origin;
  if (e.request.method !== "GET" || (!own && !CDN.includes(url.hostname))) return;
  // data/meta.json?t=123 itd. — trzymamy jedną kopię na plik, bez względu na parametry
  const key = own ? url.origin + url.pathname : url.href;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit ?? Response.error())),
  );
});
