#!/usr/bin/env node
// Sprawdza kanał Książula i dopisuje nowe lokale do data/*.json.
//
//   node scripts/update.mjs                  nowe filmy z RSS (to odpala GitHub Action)
//   node scripts/update.mjs --backfill 50    dodatkowo 50 najnowszych nieprzetworzonych z całej historii
//   node scripts/update.mjs --video ID       przetwórz jeden film od nowa
//   node scripts/update.mjs --from-file F    wyniki ekstrakcji wpisane ręcznie ({ videoId: { places: [...] } })
import { readFile, writeFile } from "node:fs/promises";
import { extractHeuristic, extractWithClaude, hasClaude } from "./lib/extract.mjs";
import { geocodePlace, saveCache } from "./lib/geocode.mjs";
import { fetchFeed, fetchTranscript, fetchVideoMeta, listAllVideos, parseChapters } from "./lib/youtube.mjs";

const DATA = new URL("../data/", import.meta.url);
const MIN_DURATION = 240; // shortsy i krótkie zapowiedzi pomijamy
const MAX_TRIES = 3;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? true;
};

const readJson = async (name, fallback) =>
  JSON.parse(await readFile(new URL(name, DATA), "utf8").catch(() => JSON.stringify(fallback)));
const writeJson = (name, value) => writeFile(new URL(name, DATA), JSON.stringify(value, null, 1) + "\n");

const slug = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

const state = await readJson("videos.json", { videos: {} });
const { places } = await readJson("places.json", { places: [] });
const overrides = await readJson("overrides.json", {});
const meta = await readJson("meta.json", {});
const before = JSON.stringify([state, places]);

const manual = opt("--from-file") ? JSON.parse(await readFile(opt("--from-file"), "utf8")) : {};

// 1. Kolejka filmów do przetworzenia
const feed = await fetchFeed();
const queue = new Map();
const wants = (id) => {
  const v = state.videos[id];
  return !v || (v.status === "error" && (v.tries ?? 0) < MAX_TRIES) || (v.status === "pending" && v.source === "heuristic" && hasClaude());
};
for (const v of feed) if (wants(v.id)) queue.set(v.id, v);
for (const id of Object.keys(manual)) queue.set(id, { id, ...manual[id] });
if (opt("--video")) queue.set(opt("--video"), { id: opt("--video") });
if (opt("--backfill")) {
  const all = (await listAllVideos()).filter((v) => v.duration >= MIN_DURATION && wants(v.id));
  for (const v of all.slice(0, Number(opt("--backfill")))) queue.set(v.id, v);
}

console.log(`Claude API: ${hasClaude() ? "tak" : "nie (tryb rozdziałów)"} · do przetworzenia: ${queue.size}`);

// 2. Przetwarzanie
let processed = 0;
for (const [id, hint] of queue) {
  // Geokodowanie jest najwolniejsze — przy długim uzupełnianiu historii zapisujemy cache po drodze
  if (++processed % 10 === 0) await saveCache();
  const prev = state.videos[id] ?? {};
  try {
    // Ręczny wpis z tytułem i datą nie potrzebuje odpytywania YouTube
    const m = manual[id]?.title && manual[id]?.date ? { ...manual[id], description: "", duration: 0 } : await fetchVideoMeta(id);
    const video = { id, title: m.title || hint.title, date: m.date || hint.date || prev.date };
    const chapters = parseChapters(m.description);

    if (m.duration && m.duration < MIN_DURATION && !manual[id]) {
      state.videos[id] = { ...video, status: "skipped", reason: "short" };
      continue;
    }

    let extraction;
    let source;
    if (manual[id]) {
      extraction = { is_food_review: true, ...manual[id] };
      source = "manual";
    } else if (hasClaude()) {
      extraction = await extractWithClaude({ title: video.title, description: m.description, transcript: await fetchTranscript(id) });
      source = "claude";
    } else {
      extraction = extractHeuristic({ title: video.title, chapters });
      source = "heuristic";
    }

    if (!extraction.is_food_review) {
      state.videos[id] = { ...video, status: "skipped", reason: "not-review", source };
      continue;
    }

    // Stare pinezki z tego filmu zastępujemy nowym wynikiem
    for (let i = places.length - 1; i >= 0; i--) if (places[i].videoId === id) places.splice(i, 1);

    const unresolved = [];
    for (const p of extraction.places) {
      const geo = await geocodePlace(p).catch(() => null);
      if (!geo) {
        unresolved.push(p.name);
        continue;
      }
      // Ten sam lokal dwa razy w odcinku (np. powrót po weryfikacji) dostaje osobne id
      let placeId = `${id}-${slug(p.name)}`;
      for (let n = 2; places.some((x) => x.id === placeId); n++) placeId = `${id}-${slug(p.name)}-${n}`;
      places.push({
        id: placeId,
        name: p.name,
        city: p.city,
        address: p.street || geo.address || null,
        lat: geo.lat,
        lng: geo.lng,
        approx: geo.approx,
        category: p.category,
        verdict: p.verdict,
        dishes: p.dishes ?? [],
        price: p.price_pln ?? null,
        note: p.note || null,
        videoId: id,
        t: p.start_seconds ?? null,
        date: video.date,
      });
    }

    state.videos[id] = {
      ...video,
      status: unresolved.length || !extraction.places.length ? "pending" : "done",
      source,
      places: extraction.places.length - unresolved.length,
      ...(unresolved.length && { unresolved }),
    };
    console.log(`✓ ${video.title} → ${extraction.places.length - unresolved.length} lokali${unresolved.length ? `, bez lokalizacji: ${unresolved.join(", ")}` : ""}`);
  } catch (err) {
    console.error(`✗ ${id}: ${err.message}`);
    state.videos[id] = { ...prev, id, title: prev.title ?? hint.title, date: prev.date ?? hint.date, status: "error", tries: (prev.tries ?? 0) + 1, error: err.message };
  }
}

await saveCache();

// 3. Ręczne poprawki (data/overrides.json): { "<placeId>": { lat, lng, ... } | { hidden: true } }
const out = places
  .map((p) => ({ ...p, ...overrides[p.id] }))
  .filter((p) => !p.hidden)
  .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

const changed = JSON.stringify([state, places]) !== before;
const done = Object.values(state.videos).filter((v) => v.status === "done" || v.status === "pending");
const newest = (list) => list.reduce((a, v) => ((v.date ?? "") > (a?.date ?? "") ? v : a), null);
const latest = newest([...feed, ...Object.values(state.videos)]);

// meta.json odświeżamy co najmniej raz na godzinę, żeby strona wiedziała, że bot żyje,
// ale bez commitowania co 15 minut, jeśli nic się nie zmieniło.
const staleCheck = Date.now() - Date.parse(meta.lastCheckAt ?? 0) > 55 * 60 * 1000;
if (changed || staleCheck) {
  await writeJson("places.json", { places: out });
  await writeJson("videos.json", state);
  await writeJson("meta.json", {
    lastCheckAt: new Date().toISOString(),
    dataAsOf: newest(done)?.date ?? null,
    latestVideo: latest && { id: latest.id, title: latest.title, date: latest.date },
    counts: {
      places: out.length,
      cities: new Set(out.map((p) => p.city).filter(Boolean)).size,
      videos: done.length,
      pending: Object.values(state.videos).filter((v) => v.status === "pending").length,
    },
  });
}
console.log(changed ? "Zapisano zmiany." : staleCheck ? "Odświeżono meta.json." : "Brak zmian.");
