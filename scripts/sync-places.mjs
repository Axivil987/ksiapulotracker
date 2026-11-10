// Wgrywa lokale z data/places.json do tabeli `places` w Supabase (potrzebne do sprawdzania odhaczeń).
//
//   node scripts/sync-places.mjs            zapisuje supabase/places.sql (do wklejenia w SQL Editor)
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/sync-places.mjs   wysyła prosto do bazy
//
// Grupowanie wizyt w lokale musi działać tak samo jak groupVisits() w assets/app.js.
import { readFile, writeFile } from "node:fs/promises";

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const { places: raw } = JSON.parse(await readFile(new URL("../data/places.json", import.meta.url), "utf8"));
const groups = new Map();
for (const v of raw) {
  const key = `${norm(v.name).replace(/ /g, "")}--${norm(v.city).replace(/ /g, "")}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(v);
}

const rows = [...groups].map(([id, visits]) => {
  visits.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const located = visits.find((v) => !v.approx) ?? visits[0];
  return {
    id,
    name: visits[0].name,
    city: visits[0].city ?? null,
    lat: located.lat,
    lng: located.lng,
    approx: !!located.approx,
    category: visits[0].category ?? null,
    muala: visits.some((v) => v.verdict === "muala"),
    closed: visits.some((v) => v.closed),
    video_ids: [...new Set(visits.map((v) => v.videoId))],
    video_dates: [...new Set(visits.map((v) => v.date).filter(Boolean))],
  };
});

const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
if (url && key) {
  // Lokali nigdy nie usuwamy — skasowanie zabrałoby ludziom odhaczenia i punkty
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(`${url}/rest/v1/places?on_conflict=id`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  }
  console.log(`Wysłano ${rows.length} lokali do Supabase.`);
} else {
  const lit = (v) =>
    v === null ? "null"
    : typeof v === "boolean" || typeof v === "number" ? String(v)
    : Array.isArray(v) ? `'{${v.map((x) => `"${String(x).replace(/["\\]/g, "\\$&")}"`).join(",")}}'`
    : `'${String(v).replace(/'/g, "''")}'`;
  const cols = Object.keys(rows[0]);
  const sql =
    `-- Wygenerowane przez scripts/sync-places.mjs — wklej w Supabase SQL Editor po schema.sql\n` +
    `insert into public.places (${cols.join(", ")}) values\n` +
    rows.map((r) => `(${cols.map((c) => lit(r[c])).join(", ")})`).join(",\n") +
    `\non conflict (id) do update set ${cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")};\n`;
  await writeFile(new URL("../supabase/places.sql", import.meta.url), sql);
  console.log(`Zapisano supabase/places.sql (${rows.length} lokali).`);
}
