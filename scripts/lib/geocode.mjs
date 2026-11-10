import { readFile, writeFile } from "node:fs/promises";

// Nominatim (OpenStreetMap): max 1 zapytanie/s i własny User-Agent — wymóg regulaminu.
const UA = "ksiapulotracker/1.0 (nieoficjalna mapa fanowska)";
const CACHE_FILE = new URL("../../data/geocache.json", import.meta.url);
const POI = ["amenity", "shop", "tourism", "leisure", "craft"];
const AREA = ["city", "town", "village", "state", "county", "municipality", "suburb", "quarter", "neighbourhood", "city_district", "borough"];

let cache;
let last = 0;

async function loadCache() {
  if (!cache) cache = JSON.parse(await readFile(CACHE_FILE, "utf8").catch(() => "{}"));
  return cache;
}

export async function saveCache() {
  if (cache) await writeFile(CACHE_FILE, JSON.stringify(cache, null, 1) + "\n");
}

async function search(q) {
  const c = await loadCache();
  if (q in c) return c[q];
  const wait = 1100 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=pl&addressdetails=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "pl" } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const [hit] = await res.json();
  c[q] = hit
    ? {
        lat: +(+hit.lat).toFixed(6),
        lng: +(+hit.lon).toFixed(6),
        name: hit.name || null,
        category: hit.category,
        type: hit.addresstype,
        address: [hit.address?.road, hit.address?.house_number].filter(Boolean).join(" ") || null,
      }
    : null;
  return c[q];
}

const norm = (s) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9 ]+/g, " ");

// Słowa, które nic nie mówią o konkretnym lokalu
const GENERIC = new Set("kebab kebap doner restauracja bar pizza pizzeria burger burgers hotel sklep the and i w na smash".split(" "));

/** Czy znaleziony obiekt to naprawdę ten lokal? Nominatim lubi trafić np. "Blacha" → "Pałac pod Blachą". */
function sameVenue(hit, name, category) {
  if (!POI.includes(hit.category) || !hit.name) return false;
  // "shop" pod nazwą restauracji to zwykle inny biznes (np. kwiaciarnia "Flaming")
  if (hit.category === "shop" && !(category === "slodkie" || /sklep|piekarn|cukiern/i.test(name))) return false;
  const want = norm(name).split(" ").filter((w) => w.length > 2 && !GENERIC.has(w));
  const got = norm(hit.name);
  if (!want.length) return got.includes(norm(name).trim());
  return want.every((w) => got.includes(w));
}

/**
 * Od najdokładniejszego: nazwa + ulica/dzielnica + miasto → ulica + miasto → dzielnica + miasto → miasto.
 * Trafienie po nazwie liczy się tylko, gdy to lokal o pasującej nazwie; inaczej pinezka "w okolicy" (approx).
 */
export async function geocodePlace({ name, street, district, city, category }) {
  if (!city) return null;
  // Gdy znamy dzielnicę, nie bierzemy trafienia z drugiego końca miasta o tej samej nazwie
  const byName = [street && `${name}, ${street}, ${city}`, district && `${name}, ${district}, ${city}`, !district && `${name}, ${city}`].filter(Boolean);
  for (const q of byName) {
    const hit = await search(q);
    if (hit && sameVenue(hit, name, category)) return { lat: hit.lat, lng: hit.lng, approx: false, address: street || hit.address, query: q };
  }
  if (street) {
    const hit = await search(`${street}, ${city}`);
    if (hit && !AREA.includes(hit.type)) return { lat: hit.lat, lng: hit.lng, approx: false, address: street, query: `${street}, ${city}` };
  }
  for (const q of [district && `${district}, ${city}`, city].filter(Boolean)) {
    const hit = await search(q);
    if (hit) return { lat: hit.lat, lng: hit.lng, approx: true, address: null, query: q };
  }
  return null;
}
