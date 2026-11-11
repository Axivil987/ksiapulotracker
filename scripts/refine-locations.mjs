// Doprecyzowuje pinezki "w okolicy": szuka każdego przybliżonego lokalu w Photon (wyszukiwarka OSM
// odporna na literówki) w pobliżu centrum jego miasta i przyjmuje wynik tylko, gdy zgadza się nazwa.
// Wynik trafia do data/overrides.json (trwałe, update.mjs je nakłada) i od razu do data/places.json.
//
//   node scripts/refine-locations.mjs            wszystkie przybliżone
//   node scripts/refine-locations.mjs --dry      tylko pokaż, nic nie zapisuj
import { readFile, writeFile } from "node:fs/promises";

const UA = "ksiapulotracker/1.0 (nieoficjalna mapa fanowska)";
const DATA = new URL("../data/", import.meta.url);
const dry = process.argv.includes("--dry");
const MAX_KM = 10; // dalej od centrum miasta/dzielnicy to już raczej inny lokal o tej samej nazwie
const AMBIGUOUS_KM = 1.5; // gdy w okolicy jest kilka lokali o tej nazwie

const norm = (s) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim();
const GENERIC = new Set(
  "kebab kebap doner döner restauracja restaurant bar bistro pizza pizzeria burger burgers hotel sklep the and i w na u pod smash food grill house craft kraft street budka zapiekanki zapiekanka mleczny karczma".split(" "),
);
const tokens = (name) => norm(name.replace(/\(.*?\)/g, " ")).split(" ").filter((w) => w.length > 2 && !GENERIC.has(w));
const km = (a, b) => {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
};

/** Odległość edycyjna (Levenshtein). */
function edits(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

let last = 0;
async function photon(q, near) {
  const wait = 1000 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const url = `https://photon.komoot.io/api/?limit=8&lat=${near.lat}&lon=${near.lng}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  return (await res.json()).features ?? [];
}

const POI = new Set(["amenity", "shop", "tourism", "leisure", "craft"]);
const FOOD = new Set(
  "restaurant fast_food cafe bar pub food_court ice_cream biergarten canteen bakery pastry confectionery butcher deli convenience supermarket hotel guest_house hostel motel alpine_hut chalet attraction theme_park zoo water_park marketplace".split(" "),
);
function pick(features, place, want) {
  const hits = [];
  for (const f of features) {
    const p = f.properties;
    if (p.countrycode !== "PL" || !POI.has(p.osm_key) || !p.name) continue;
    // tylko gastronomia i noclegi — inaczej "Messi" trafia we fryzjera "Męski"
    if (!FOOD.has(p.osm_value)) continue;
    const got = norm(p.name);
    const gotWords = got.split(" ");
    // napisy z YouTube przekręcają nazwy ("Kebilla" → w OSM "Kebila"), więc dopuszczamy 1–2 literówki
    const close = (w) => gotWords.includes(w) || (w.length >= 5 && got.includes(w)) || gotWords.some((g) => edits(w, g) <= (w.length >= 10 ? 2 : w.length >= 7 ? 1 : 0));
    if (!want.every(close)) continue;
    const [lng, lat] = f.geometry.coordinates;
    const d = km(place, { lat, lng });
    if (d > MAX_KM) continue;
    hits.push({ d, lat: +lat.toFixed(6), lng: +lng.toFixed(6), address: [p.street, p.housenumber].filter(Boolean).join(" ") || null, name: p.name });
  }
  if (!hits.length) return null;
  hits.sort((x, y) => x.d - y.d);
  // Kilka różnych lokali o tej nazwie w okolicy (sieć, popularna nazwa): bierzemy tylko bardzo bliski,
  // bo błędna pinezka jest gorsza niż przybliżona.
  const distinct = hits.filter((h) => km(h, hits[0]) > 0.3).length > 0;
  if (distinct && hits[0].d > AMBIGUOUS_KM) return null;
  return hits[0];
}

const file = JSON.parse(await readFile(new URL("places.json", DATA), "utf8"));
const overrides = JSON.parse(await readFile(new URL("overrides.json", DATA), "utf8").catch(() => "{}"));
const todo = file.places.filter((p) => p.approx && !overrides[p.id]?.lat);
console.log(`Przybliżonych: ${todo.length}`);

const memo = new Map();
let fixed = 0;
let n = 0;
for (const p of todo) {
  n++;
  const want = tokens(p.name);
  if (!want.length || !p.city) continue; // sama nazwa typu "Kebab" nic nie znajdzie
  const key = `${want.join(" ")}|${norm(p.city)}`;
  if (!memo.has(key)) {
    let hit = null;
    try {
      hit = pick(await photon(`${p.name.replace(/\(.*?\)/g, "").trim()} ${p.city}`, p), p, want);
      if (!hit) hit = pick(await photon(`${want.join(" ")} ${p.city}`, p), p, want);
    } catch (err) {
      console.error(`  ! ${p.name}: ${err.message}`);
    }
    memo.set(key, hit);
  }
  const hit = memo.get(key);
  if (!hit) continue;
  fixed++;
  console.log(`✓ ${p.name} (${p.city}) → ${hit.name}${hit.address ? `, ${hit.address}` : ""}`);
  overrides[p.id] = { ...overrides[p.id], lat: hit.lat, lng: hit.lng, approx: false, ...(hit.address && { address: hit.address }) };
  Object.assign(p, overrides[p.id]);
  if (!dry && fixed % 20 === 0) await save();
  if (n % 50 === 0) console.log(`… ${n}/${todo.length}`);
}

async function save() {
  await writeFile(new URL("overrides.json", DATA), JSON.stringify(overrides, null, 1) + "\n");
  await writeFile(new URL("places.json", DATA), JSON.stringify(file, null, 1) + "\n");
}
if (!dry) await save();
const left = file.places.filter((p) => p.approx).length;
console.log(`Doprecyzowano ${fixed} z ${todo.length}. Dokładnych: ${file.places.length - left}/${file.places.length}, przybliżonych zostało ${left}.`);
