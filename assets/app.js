(() => {
  "use strict";

  const POLL_MS = 60_000;
  const PAGE = 40;
  const NEW_DAYS = 7;
  const POLAND = [52.07, 19.48];
  // Zgłoszenia błędów trafiają jako issue do repozytorium strony (poprawki → data/overrides.json)
  const REPORT_URL = "https://github.com/Axivil987/ksiapulotracker/issues/new";

  const CATS = {
    kebab: ["🥙", "Kebab"],
    pizza: ["🍕", "Pizza"],
    burger: ["🍔", "Burger"],
    zapiekanka: ["🥖", "Zapiekanka"],
    obiad: ["🍽️", "Obiad"],
    azjatyckie: ["🥡", "Azjatyckie"],
    sushi: ["🍣", "Sushi"],
    hotdog: ["🌭", "Hot dog"],
    fastfood: ["🍟", "Fast food"],
    slodkie: ["🍩", "Słodkie"],
    inne: ["🍴", "Inne"],
  };
  const VERDICTS = {
    muala: "MUALA",
    plus: "na plus",
    srednio: "średnio",
    minus: "na minus",
    nieznany: "bez oceny",
  };
  const VERDICT_FILTERS = [
    ["all", "Wszystkie"],
    ["muala", "MUALA"],
    ["plus", "Na plus"],
    ["minus", "Na minus"],
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtDate = (iso, long) =>
    iso ? new Date(iso).toLocaleDateString("pl-PL", long ? { day: "numeric", month: "long", year: "numeric" } : { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
  const thumb = (id, q = "mqdefault") => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
  const ytLink = (id, t) => `https://www.youtube.com/watch?v=${id}${t ? `&t=${t}s` : ""}`;
  const isNew = (p) => p.date && Date.now() - Date.parse(p.date) < NEW_DAYS * 864e5;
  // "Kebab Ćma" i "kebab cma" to ten sam lokal — porównujemy bez wielkości liter, ogonków i znaków
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ł/g, "l")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const plural = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);

  /**
   * W danych każda wizyta to osobny wpis (lokal z danego odcinka). Na mapie ten sam lokal
   * odwiedzony kilka razy (np. weryfikacja MUALA) ma być jedną pinezką z historią wizyt.
   */
  function groupVisits(raw) {
    const groups = new Map();
    for (const v of raw) {
      const key = `${norm(v.name).replace(/ /g, "")}--${norm(v.city).replace(/ /g, "")}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    return [...groups].map(([key, visits]) => {
      visits.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      const [latest] = visits;
      const located = visits.find((v) => !v.approx) ?? latest;
      const rated = visits.find((v) => v.verdict !== "nieznany") ?? latest;
      const muala = visits.find((v) => v.verdict === "muala");
      return {
        ...latest,
        id: key,
        lat: located.lat,
        lng: located.lng,
        approx: located.approx,
        address: located.address ?? latest.address,
        verdict: rated.verdict,
        note: latest.note || rated.note || visits.find((v) => v.note)?.note || null,
        dishes: latest.dishes?.length ? latest.dishes : rated.dishes ?? [],
        mualaDate: muala?.date ?? null,
        closed: visits.some((v) => v.closed),
        visits,
        hay: norm([latest.name, latest.city, located.address, ...visits.flatMap((v) => v.dishes ?? [])].join(" ")),
      };
    });
  }

  const state = {
    raw: [],
    places: [],
    q: "",
    route: null, // miasto, którego trasę pokazujemy
    done: new Set(), // lokale odhaczone przez zalogowanego (ustawia social.js)
    stories: new Map(), // lokal → liczba świeżych story od widzów (ustawia social.js)
    mine: null, // Set lokali z "Mojej listy", gdy mapa ma pokazywać tylko ją
    videos: {},
    meta: null,
    cat: "all",
    verdict: "all",
    sort: "new",
    me: null, // { lat, lng, label }
    shown: PAGE,
    activeId: null,
  };

  // ---------- Mapa ----------
  const map = L.map("map", { zoomControl: false, preferCanvas: false }).setView(POLAND, 6);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 46,
    spiderfyOnMaxZoom: true,
    iconCreateFunction(c) {
      const muala = c.getAllChildMarkers().some((m) => m.options.place.verdict === "muala");
      const story = c.getAllChildMarkers().some((m) => state.stories.has(m.options.place.id));
      return L.divIcon({
        html: `<div class="cluster${muala ? " cluster--muala" : ""}${story ? " has-story" : ""}">${c.getChildCount()}</div>`,
        className: "",
        iconSize: [44, 44],
      });
    },
  });
  map.addLayer(cluster);
  const markers = new Map();
  let meMarker = null;

  function pinIcon(p) {
    const [emoji] = CATS[p.category] ?? CATS.inne;
    const cls = ["pin", `pin--${p.verdict}`, p.approx && "pin--approx", p.closed && "pin--closed", state.done.has(p.id) && "is-done", state.stories.has(p.id) && "has-story", p.id === state.activeId && "is-active"].filter(Boolean).join(" ");
    return L.divIcon({
      html: `<div class="${cls}"><span>${emoji}</span>${isNew(p) ? '<b class="pin__new">NOWE</b>' : ""}${state.done.has(p.id) ? '<b class="pin__done">✓</b>' : ""}</div>`,
      className: "",
      iconSize: [38, 38],
      iconAnchor: [5, 38],
      popupAnchor: [14, -36],
    });
  }

  function popupHtml(p) {
    const where = [p.address, p.city].filter(Boolean).join(", ");
    const dishes = p.dishes?.length ? `<p class="pop__dishes">Zamówił: ${esc(p.dishes.join(", "))}${p.price ? ` · ${p.price} zł` : ""}</p>` : "";
    const video = state.videos[p.videoId];
    const visits =
      p.visits.length > 1
        ? `<div class="pop__visits"><b>Był tu ${p.visits.length}×</b>${p.visits
            .map(
              (v) => `<a href="${ytLink(v.videoId, v.t)}" target="_blank" rel="noopener">
                <span class="stk stk--${v.verdict}">${VERDICTS[v.verdict] ?? v.verdict}</span>
                <span>${fmtDate(v.date)}</span><span class="pop__play">▶</span>
              </a>`,
            )
            .join("")}</div>`
        : "";
    const age = p.date ? Math.floor((Date.now() - Date.parse(p.date)) / (365.25 * 864e5)) : 0;
    const cityCount = state.places.filter((x) => x.city === p.city).length;
    return `
      <a class="pop__img" href="${ytLink(p.videoId, p.t)}" target="_blank" rel="noopener" aria-label="Obejrzyj fragment odcinka">
        <img src="${thumb(p.videoId)}" alt="" loading="lazy">
      </a>
      <div class="pop__body">
        <h3 class="pop__name">${esc(p.name)}</h3>
        <p class="pop__where">${esc(where || "lokalizacja przybliżona")}${distLabel(p) ? ` · <b>${distLabel(p)}</b>` : ""}</p>
        <div class="pop__row">
          <span class="stk stk--${p.verdict}">${VERDICTS[p.verdict] ?? p.verdict}</span>
          <span class="tag">${(CATS[p.category] ?? CATS.inne).join(" ")}</span>
          ${isNew(p) ? '<span class="new">NOWE</span>' : ""}
          ${p.closed ? '<span class="stk stk--closed">zamknięte</span>' : ""}
        </div>
        ${p.note ? `<p class="pop__note">${esc(p.note)}</p>` : ""}
        ${dishes}
        ${p.approx ? '<p class="pop__approx">⚠ Pinezka w okolicy — dokładny adres niepotwierdzony</p>' : ""}
        ${age >= 2 && !p.closed ? `<p class="pop__old">Odcinek sprzed ${age} ${plural(age, "roku", "lat", "lat")} — sprawdź, czy lokal wciąż działa.</p>` : ""}
        ${visits}
        <div class="pop__social"></div>
        <div class="pop__actions">
          <a href="${ytLink(p.videoId, p.t)}" target="_blank" rel="noopener">▶ Fragment</a>
          <a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">Prowadź ↗</a>
        </div>
        <p class="pop__ep">${p.visits.length > 1 ? "Ostatnio w odcinku" : "Z odcinka"} z ${fmtDate(p.date)}${video ? `: <i>${esc(video.title)}</i>` : ""}</p>
        <div class="pop__tools">
          <button type="button" class="js-share">🔗 Udostępnij</button>
          ${cityCount >= 3 ? `<button type="button" class="js-route">🧭 Trasa: ${esc(p.city)}</button>` : ""}
        </div>
        <a class="pop__report" href="${reportUrl(p)}" target="_blank" rel="noopener">⚑ Zgłoś błąd: zła pinezka, nazwa, lokal zamknięty</a>
      </div>`;
  }

  function reportUrl(p) {
    const title = `Błąd: ${p.name} (${p.city ?? "?"})`;
    const body = [
      `Lokal: ${p.name}, ${[p.address, p.city].filter(Boolean).join(", ")}`,
      `Odcinek: ${ytLink(p.videoId, p.t)}`,
      `Id wizyt: ${p.visits.map((v) => v.id).join(", ")}`,
      "",
      "Co jest nie tak? (zaznacz [x])",
      "- [ ] pinezka w złym miejscu — poprawny adres:",
      "- [ ] zła nazwa — poprawna nazwa:",
      "- [ ] lokal jest zamknięty",
      "- [ ] inne:",
    ].join("\n");
    return `${REPORT_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=zgloszenie`;
  }

  // ---------- Odległość ----------
  function km(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function distLabel(p) {
    if (!state.me) return "";
    const d = km(state.me, p);
    // pinezka "w okolicy" stoi w środku miasta/dzielnicy, więc odległość jest tylko orientacyjna
    if (p.approx) return d < 2 ? "≈ w okolicy" : `≈ ${Math.round(d)} km`;
    return d < 1 ? `${Math.round(d * 1000)} m` : `${d < 10 ? d.toFixed(1).replace(".", ",") : Math.round(d)} km`;
  }

  // ---------- Filtry i lista ----------
  const firstVisit = (p) => p.visits[p.visits.length - 1];
  const byFirstVisit = (a, b) => (firstVisit(a).date ?? "").localeCompare(firstVisit(b).date ?? "") || (firstVisit(a).t ?? 0) - (firstVisit(b).t ?? 0);

  function filtered() {
    const words = norm(state.q).split(" ").filter(Boolean);
    let list = state.places.filter(
      (p) =>
        words.every((w) => p.hay.includes(w)) &&
        (!state.mine || state.mine.has(p.id)) &&
        (!state.route || p.city === state.route) &&
        (state.cat === "all" || p.category === state.cat) &&
        (state.verdict === "all" ||
          p.verdict === state.verdict ||
          (state.verdict === "plus" && p.verdict === "muala")),
    );
    if (state.route) list = [...list].sort(byFirstVisit);
    else if (state.sort === "near" && state.me) list = list.map((p) => [km(state.me, p), p]).sort((a, b) => a[1].closed - b[1].closed || a[0] - b[0]).map(([, p]) => p);
    else list = [...list].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return list;
  }

  function renderChips() {
    const counts = {};
    for (const p of state.places) counts[p.category] = (counts[p.category] ?? 0) + 1;
    const chip = (key, label, n) =>
      `<button type="button" class="chip${state.cat === key ? " is-on" : ""}" data-cat="${key}" ${n === 0 ? "disabled" : ""}>${label} <small>${n}</small></button>`;
    $("cats").innerHTML =
      chip("all", "Wszystko", state.places.length) +
      Object.entries(CATS)
        .filter(([k]) => counts[k])
        .sort((a, b) => counts[b[0]] - counts[a[0]])
        .map(([k, [e, name]]) => chip(k, `${e} ${name}`, counts[k]))
        .join("");
    $("verdicts").innerHTML = VERDICT_FILTERS.map(
      ([k, label]) => `<button type="button" data-v="${k}" class="${state.verdict === k ? "is-on" : ""}">${label}</button>`,
    ).join("");
  }

  function renderList() {
    const list = filtered();
    const n = list.length;
    $("count").textContent = `${n} ${plural(n, "lokal", "lokale", "lokali")}${state.me ? ` · od: ${state.me.label}` : ""}`;
    if (!n) {
      $("list").innerHTML = `<li class="empty"><span class="hand">nie no, słabo…</span>${
        state.q ? `Nic nie znalazłem dla „${esc(state.q)}”${state.cat !== "all" || state.verdict !== "all" ? " przy tych filtrach" : ""}.` : "Brak lokali dla tych filtrów."
      }</li>`;
      $("more").hidden = true;
      return;
    }
    $("list").innerHTML = list
      .slice(0, state.shown)
      .map((p, i) => {
        const [emoji, catName] = CATS[p.category] ?? CATS.inne;
        return `<li class="card${p.id === state.activeId ? " is-active" : ""}${p.closed ? " is-closed" : ""}" data-id="${esc(p.id)}" tabindex="0">
          <div class="card__img">
            <img src="${thumb(p.videoId)}" alt="" loading="lazy">
            ${state.route ? `<span class="card__num">${i + 1}</span>` : ""}
            ${state.me ? `<span class="card__dist">${distLabel(p)}</span>` : ""}
          </div>
          <div>
            <h3 class="card__name">${esc(p.name)}</h3>
            <p class="card__where">${esc([p.address, p.city].filter(Boolean).join(", ") || "lokalizacja przybliżona")}</p>
            <div class="card__meta">
              <span class="stk stk--${p.verdict}">${VERDICTS[p.verdict] ?? p.verdict}</span>
              <span class="tag">${emoji} ${catName}</span>
              ${isNew(p) ? '<span class="new">NOWE</span>' : ""}
              ${p.closed ? '<span class="stk stk--closed">zamknięte</span>' : ""}
              ${p.visits.length > 1 ? `<span class="tag tag--visits">${p.visits.length}× odwiedzony</span>` : ""}
            </div>
            ${p.note ? `<p class="card__note">${esc(p.note)}</p>` : ""}
            <span class="card__date">odcinek z ${fmtDate(p.date)}</span>
          </div>
        </li>`;
      })
      .join("");
    $("more").hidden = n <= state.shown;
  }

  function renderMarkers() {
    const list = filtered();
    const keep = new Set(list.map((p) => p.id));
    cluster.clearLayers();
    const layers = [];
    for (const p of list) {
      let m = markers.get(p.id);
      if (!m) {
        m = L.marker([p.lat, p.lng], { icon: pinIcon(p), place: p, riseOnHover: true });
        m.bindPopup(() => popupHtml(m.options.place), { maxWidth: 280, minWidth: 280, autoPanPadding: [30, 60] });
        m.on("click", () => setActive(p.id, false));
        m.on("popupopen", (e) => onPopupOpen(m.options.place, e.popup));
        m.on("popupclose", () => onPopupClose(m.options.place));
        markers.set(p.id, m);
      }
      layers.push(m);
    }
    for (const id of markers.keys()) if (!keep.has(id) && !state.places.some((p) => p.id === id)) markers.delete(id);
    cluster.addLayers(layers);
    renderRoute();
  }

  // ---------- Link do lokalu ----------
  const hashOf = (p) => `#lokal=${encodeURIComponent(p.id)}`;

  function onPopupOpen(p, popup) {
    history.replaceState(null, "", hashOf(p));
    const el = popup.getElement();
    el.querySelector(".js-share").onclick = (e) => share(p, e.currentTarget);
    const route = el.querySelector(".js-route");
    if (route) route.onclick = () => startRoute(p.city);
    emit("popup", p, el.querySelector(".pop__social"));
  }

  function onPopupClose(p) {
    if (location.hash === hashOf(p)) history.replaceState(null, "", location.pathname + location.search);
  }

  async function share(p, btn) {
    const url = location.origin + location.pathname + hashOf(p);
    try {
      if (navigator.share && matchMedia("(max-width: 820px)").matches) {
        await navigator.share({ title: `${p.name} — Ksiapulo Tracker`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      btn.textContent = "✓ Skopiowano link";
    } catch (err) {
      if (err.name !== "AbortError") btn.textContent = "Nie udało się skopiować";
    }
  }

  function openFromHash() {
    const m = location.hash.match(/^#lokal=(.+)$/);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    if (state.places.some((p) => p.id === id)) focusPlace(id);
  }
  window.addEventListener("hashchange", openFromHash);

  // ---------- Trasa po mieście ----------
  let routeLine = null;

  function startRoute(city) {
    state.route = city;
    state.cat = "all";
    state.verdict = "all";
    state.q = $("placeQ").value = "";
    state.shown = PAGE;
    map.closePopup();
    renderAll();
    const list = filtered();
    map.fitBounds(L.latLngBounds(list.map((p) => [p.lat, p.lng])).pad(0.15), { maxZoom: 14 });
  }

  function endRoute() {
    state.route = null;
    state.shown = PAGE;
    renderAll();
  }

  function renderRoute() {
    routeLine?.remove();
    routeLine = null;
    const bar = $("routeBar");
    bar.hidden = !state.route;
    if (!state.route) return;
    const list = filtered();
    // pinezki przybliżone stoją w jednym punkcie miasta, więc linia łączy tylko dokładne adresy
    const exact = list.filter((p) => !p.approx);
    if (exact.length > 1) {
      routeLine = L.polyline(
        exact.map((p) => [p.lat, p.lng]),
        { color: "#d97c00", weight: 3, dashArray: "8 8", interactive: false },
      ).addTo(map);
    }
    const years = list.map((p) => new Date(firstVisit(p).date).getFullYear());
    const span = list.length ? (years[0] === years[years.length - 1] ? years[0] : `${years[0]}–${years[years.length - 1]}`) : "";
    bar.innerHTML = `<div><b>🧭 Trasa: ${esc(state.route)}</b><span>${list.length} ${plural(list.length, "lokal", "lokale", "lokali")} po kolei${span ? `, ${span}` : ""}${
      exact.length > 1 ? ` · linia łączy ${exact.length} z dokładnym adresem` : ""
    }</span></div><button type="button" class="btn">Zakończ</button>`;
    bar.querySelector("button").onclick = endRoute;
  }

  function renderAll() {
    renderChips();
    renderList();
    renderMarkers();
  }

  function setActive(id, fly = true) {
    const prev = markers.get(state.activeId);
    state.activeId = id;
    if (prev) prev.setIcon(pinIcon(prev.options.place));
    const m = markers.get(id);
    if (!m) return;
    m.setIcon(pinIcon(m.options.place));
    document.querySelectorAll(".card.is-active").forEach((c) => c.classList.remove("is-active"));
    const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    card?.classList.add("is-active");
    if (fly) {
      if (matchMedia("(max-width: 820px)").matches) toggleMap(true);
      cluster.zoomToShowLayer(m, () => m.openPopup());
    } else {
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // ---------- Lokalizacja ----------
  function setMe(lat, lng, label, zoom = 13, keepView = false) {
    state.me = { lat, lng, label };
    state.sort = "near";
    document.querySelectorAll(".sort button").forEach((b) => b.classList.toggle("is-on", b.dataset.sort === "near"));
    if (meMarker) meMarker.setLatLng([lat, lng]);
    else meMarker = L.marker([lat, lng], { icon: L.divIcon({ html: '<div class="me"></div>', className: "", iconSize: [20, 20] }), zIndexOffset: 2000, keyboard: false }).addTo(map);
    meMarker.bindTooltip(label);
    // przybliż tak, żeby było widać kilka najbliższych lokali
    const near = filtered().slice(0, 5);
    if (keepView) {
      // użytkownik już ogląda konkretny lokal
    } else if (near.length) map.fitBounds(L.latLngBounds([[lat, lng], ...near.map((p) => [p.lat, p.lng])]).pad(0.25), { maxZoom: zoom });
    else map.setView([lat, lng], zoom);
    state.shown = PAGE;
    renderList();
    const first = near.find((p) => !p.approx) ?? near[0];
    $("whereStatus").textContent = first ? `Najbliżej: ${first.name} (${distLabel(first)})` : "";
  }

  function locate(silent) {
    if (!navigator.geolocation) {
      if (!silent) $("whereStatus").textContent = "Twoja przeglądarka nie udostępnia lokalizacji — wpisz miasto.";
      return;
    }
    const btn = $("locateBtn");
    btn.classList.add("is-busy");
    if (!silent) $("whereStatus").textContent = "Szukam cię…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.classList.remove("is-busy");
        setMe(pos.coords.latitude, pos.coords.longitude, "twoja lokalizacja", 13, silent && !!state.activeId);
      },
      () => {
        btn.classList.remove("is-busy");
        $("whereStatus").textContent = silent ? "Wpisz miasto albo udostępnij lokalizację, żeby zobaczyć najbliższe miejsca." : "Nie udało się pobrać lokalizacji — wpisz miasto lub adres.";
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  }

  async function geocode(q) {
    // Nominatim: wyszukiwanie tylko po zatwierdzeniu (bez autouzupełniania) — wymóg regulaminu OSM
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=pl&accept-language=pl&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }

  $("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("searchInput").value.trim();
    if (!q) return;
    $("whereStatus").textContent = "Szukam…";
    $("searchResults").hidden = true;
    try {
      // Nominatim potrafi zwrócić np. dworzec i przystanek pod tą samą nazwą — zostaw unikalne
      // Granica gminy (addresstype "administrative") ma środek np. w zatoce — wolimy punkt miasta
      const rank = (h) => (h.addresstype === "administrative" || h.category === "natural" ? 1 : 0);
      const hits = (await geocode(q))
        .sort((a, b) => rank(a) - rank(b))
        .filter((h, i, all) => all.findIndex((x) => x.display_name === h.display_name) === i);
      if (!hits.length) {
        $("whereStatus").textContent = `Nie znalazłem „${q}”. Spróbuj inaczej (np. „Gdańsk Wrzeszcz”).`;
        return;
      }
      if (hits.length === 1 || hits[0].importance > 0.5) {
        pick(hits[0]);
        return;
      }
      $("whereStatus").textContent = "Który z nich?";
      $("searchResults").innerHTML = hits
        .map((h, i) => `<li><button type="button" data-i="${i}">${esc(h.display_name)}</button></li>`)
        .join("");
      $("searchResults").hidden = false;
      $("searchResults").onclick = (ev) => {
        const b = ev.target.closest("button");
        if (b) pick(hits[+b.dataset.i]);
      };
    } catch {
      $("whereStatus").textContent = "Wyszukiwarka adresów nie odpowiada, spróbuj za chwilę.";
    }
  });

  function pick(hit) {
    $("searchResults").hidden = true;
    const zoom = ["city", "town", "state", "county"].includes(hit.addresstype) ? 12 : 14;
    setMe(+hit.lat, +hit.lon, hit.name || hit.display_name.split(",")[0], zoom);
  }

  $("locateBtn").addEventListener("click", () => locate(false));

  // ---------- Kliknięcia w panelu ----------
  $("cats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    state.cat = b.dataset.cat;
    state.shown = PAGE;
    renderAll();
  });
  $("verdicts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    state.verdict = b.dataset.v;
    state.shown = PAGE;
    renderAll();
  });
  document.querySelector(".sort").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b) return;
    if (b.dataset.sort === "near" && !state.me) {
      $("whereStatus").textContent = "Najpierw podaj, gdzie jesteś 👆";
      $("searchInput").focus();
      return;
    }
    state.sort = b.dataset.sort;
    document.querySelectorAll(".sort button").forEach((x) => x.classList.toggle("is-on", x === b));
    renderList();
  });
  $("list").addEventListener("click", (e) => {
    const c = e.target.closest(".card");
    if (c) setActive(c.dataset.id);
  });
  $("list").addEventListener("keydown", (e) => {
    const c = e.target.closest(".card");
    if (c && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setActive(c.dataset.id);
    }
  });
  $("more").addEventListener("click", () => {
    state.shown += PAGE;
    renderList();
  });

  let qTimer;
  $("placeQ").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      state.shown = PAGE;
      renderList();
      renderMarkers();
      // jeden wynik — od razu pokaż go na mapie (na telefonie bez przełączania widoku)
      const list = filtered();
      if (state.q && list.length === 1 && !matchMedia("(max-width: 820px)").matches) setActive(list[0].id);
    }, 180);
  });

  $("randomBtn").addEventListener("click", () => {
    const pool = filtered().filter((p) => !p.closed);
    if (!pool.length) return;
    window.KsiapuloFx?.play($("randomBtn"), "is-rolling");
    const near = state.me ? pool.filter((p) => km(state.me, p) < 30) : pool;
    const from = near.length ? near : pool;
    const choices = from.length > 1 ? from.filter((p) => p.id !== state.activeId) : from;
    setActive(choices[Math.floor(Math.random() * choices.length)].id);
  });

  /** Pokaż lokal, nawet jeśli obecne filtry go ukrywają. */
  function focusPlace(id) {
    if (!filtered().some((p) => p.id === id)) {
      state.cat = "all";
      state.verdict = "all";
      state.q = $("placeQ").value = "";
      state.route = null;
      renderAll();
    }
    setActive(id);
  }

  // ---------- Ściana MUALA ----------
  const mualaPlaces = () => state.places.filter((p) => p.mualaDate).sort((a, b) => b.mualaDate.localeCompare(a.mualaDate));

  function renderWall() {
    const list = mualaPlaces();
    $("wallCount").textContent = list.length;
    $("wallGrid").innerHTML = list
      .map(
        (p, i) => `<li><button type="button" class="wall__item" data-id="${esc(p.id)}" style="--tilt:${(i % 5) - 2}deg">
          <img src="${thumb(p.visits.find((v) => v.verdict === "muala").videoId)}" alt="" loading="lazy">
          <span class="stk stk--muala">MUALA</span>
          <b>${esc(p.name)}</b>
          <span class="wall__where">${esc(p.city)}${state.me ? ` · ${distLabel(p)}` : ""}</span>
          <span class="wall__date">przyznana ${fmtDate(p.mualaDate)}</span>
        </button></li>`,
      )
      .join("");
  }

  $("wallBtn").addEventListener("click", () => {
    renderWall();
    $("wall").showModal();
  });
  $("wall").addEventListener("click", (e) => {
    if (e.target === $("wall") || e.target.closest(".wall__close")) return $("wall").close();
    const b = e.target.closest(".wall__item");
    if (!b) return;
    $("wall").close();
    focusPlace(b.dataset.id);
  });

  function toggleMap(show) {
    const on = show ?? !document.body.classList.contains("show-map");
    document.body.classList.toggle("show-map", on);
    $("mapToggle").textContent = on ? "☰ Lista" : "🗺 Mapa";
    if (on) setTimeout(() => map.invalidateSize(), 50);
  }
  $("mapToggle").addEventListener("click", () => toggleMap());
  $("mapToggle").textContent = "🗺 Mapa";

  // ---------- Dane + aktualizacja na żywo ----------
  const getJson = (name) => fetch(`data/${name}?t=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

  function renderMeta() {
    const m = state.meta;
    if (!m) return;
    const v = m.latestVideo;
    if (m.dataAsOf || v) {
      $("fresh").hidden = false;
      $("freshDate").textContent = fmtDate(m.dataAsOf || v.date, true);
      if (v) {
        $("freshLink").textContent = v.title;
        $("freshLink").href = $("freshThumb").href = ytLink(v.id);
        $("freshImg").src = thumb(v.id);
      }
    }
    const pending = Object.values(state.videos)
      .filter((x) => x.status === "pending" || (x.status === "error" && (x.tries ?? 0) < 3))
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, 6);
    $("pending").hidden = !pending.length;
    $("pendingList").innerHTML = pending
      .map(
        (x) => `<li>
          <a href="${ytLink(x.id)}" target="_blank" rel="noopener"><img src="${thumb(x.id)}" alt="" loading="lazy"></a>
          <div><strong>${esc(x.title)}</strong><span>${fmtDate(x.date)} · ${
            x.unresolved?.length ? `do ustalenia: ${esc(x.unresolved.slice(0, 4).join(", "))}${x.unresolved.length > 4 ? "…" : ""}` : "ustalamy lokale"
          }</span></div>
        </li>`,
      )
      .join("");
    tickLive();
  }

  function tickLive() {
    const m = state.meta;
    if (!m?.lastCheckAt) return;
    const mins = Math.round((Date.now() - Date.parse(m.lastCheckAt)) / 60_000);
    const ago = mins < 1 ? "przed chwilą" : mins < 60 ? `${mins} min temu` : mins < 1440 ? `${Math.round(mins / 60)} godz. temu` : `${Math.round(mins / 1440)} dni temu`;
    $("liveText").textContent = `kanał sprawdzony ${ago}`;
    $("live").classList.toggle("is-stale", mins > 180);
  }

  async function loadAll() {
    const [meta, places, videos] = await Promise.all([getJson("meta.json"), getJson("places.json"), getJson("videos.json")]);
    state.meta = meta;
    state.raw = places.places;
    state.places = groupVisits(state.raw);
    state.videos = videos.videos;
    // zaktualizuj obiekty w istniejących markerach (np. poprawiona ocena)
    for (const p of state.places) {
      const m = markers.get(p.id);
      if (m) {
        m.options.place = p;
        m.setLatLng([p.lat, p.lng]);
        m.setIcon(pinIcon(p));
      }
    }
    renderAll();
    renderMeta();
    $("wallCount").textContent = mualaPlaces().length;
    renderStats();
    emit("data", state.places);
  }

  // ---------- Most do części społecznościowej (assets/social.js) ----------
  const listeners = {};
  function emit(name, ...args) {
    for (const fn of listeners[name] ?? []) fn(...args);
  }
  window.Ksiapulo = {
    on(name, fn) {
      (listeners[name] ??= []).push(fn);
      if (name === "data" && state.places.length) fn(state.places);
    },
    get places() {
      return state.places;
    },
    get me() {
      return state.me;
    },
    map,
    km,
    esc,
    thumb,
    ytLink,
    fmtDate,
    plural,
    CATS,
    focusPlace,
    toggleMap,
    /** Odhaczone lokale dostają zieloną pinezkę z ptaszkiem. */
    setDone(ids) {
      state.done = new Set(ids);
      for (const [id, m] of markers) m.setIcon(pinIcon(m.options.place));
      renderList();
    },
    /** Lokale ze świeżymi story dostają animowany pierścień na pinezce. */
    setStories(map) {
      state.stories = map;
      for (const [, m] of markers) m.setIcon(pinIcon(m.options.place));
      cluster.refreshClusters();
    },
    /** null = cała mapa, Set = tylko te lokale (np. "Moja lista"). */
    setScope(ids) {
      state.mine = ids;
      state.shown = PAGE;
      renderAll();
      const list = filtered();
      if (ids && list.length) map.fitBounds(L.latLngBounds(list.map((p) => [p.lat, p.lng])).pad(0.1), { maxZoom: 13 });
    },
    refreshPopup() {
      const m = markers.get(state.activeId);
      if (m?.isPopupOpen()) m.getPopup().setContent(popupHtml(m.options.place)).update();
      if (m?.isPopupOpen()) onPopupOpen(m.options.place, m.getPopup());
    },
  };

  function renderStats() {
    const tile = (n, label) => `<div><b>${n.toLocaleString("pl-PL")}</b><span>${label}</span></div>`;
    const cities = new Set(state.places.map((p) => p.city)).size;
    const eps = new Set(state.raw.map((v) => v.videoId)).size;
    const muala = mualaPlaces().length;
    $("stats").innerHTML =
      tile(state.places.length, plural(state.places.length, "lokal", "lokale", "lokali")) +
      tile(cities, plural(cities, "miasto", "miasta", "miast")) +
      tile(muala, "× MUALA") +
      tile(eps, plural(eps, "odcinek", "odcinki", "odcinków"));
    // liczniki "nabijają się" tylko przy pierwszym wczytaniu
    if (!renderStats.done) {
      renderStats.done = true;
      document.querySelectorAll("#stats b").forEach((b) => window.KsiapuloFx?.countUp(b));
    }
  }

  function toast(html, onShow) {
    const t = $("toast");
    t.innerHTML = `${html}<button type="button" class="btn btn--ink">Pokaż</button>`;
    t.hidden = false;
    t.querySelector("button").onclick = () => {
      t.hidden = true;
      onShow?.();
    };
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 15_000);
  }

  async function poll() {
    try {
      const meta = await getJson("meta.json");
      const prev = state.meta;
      const changed = !prev || meta.latestVideo?.id !== prev.latestVideo?.id || meta.counts?.places !== prev.counts?.places || meta.dataAsOf !== prev.dataAsOf;
      if (changed) {
        // nowa wizyta w znanym już lokalu też się liczy — porównujemy pojedyncze wizyty
        const known = new Set(state.raw.map((v) => v.id));
        await loadAll();
        const fresh = state.places.filter((p) => p.visits.some((v) => !known.has(v.id)));
        if (fresh.length) {
          toast(`<span style="font-size:26px">🔔</span><div><b>Książulo wrzucił nowy odcinek!</b>${fresh.length} ${fresh.length === 1 ? "nowe miejsce" : "nowych miejsc"} na mapie</div>`, () =>
            map.fitBounds(L.latLngBounds(fresh.map((p) => [p.lat, p.lng])).pad(0.3), { maxZoom: 13 }),
          );
        } else if (meta.latestVideo?.id !== prev?.latestVideo?.id && meta.latestVideo) {
          toast(`<span style="font-size:26px">📺</span><div><b>Nowy odcinek:</b>${esc(meta.latestVideo.title)} — ustalamy lokale</div>`, () => $("pending").scrollIntoView({ behavior: "smooth" }));
        }
      } else {
        state.meta = meta;
        tickLive();
      }
    } catch {
      /* chwilowy brak sieci — spróbujemy za minutę */
    }
  }

  loadAll()
    .catch(() => {
      $("list").innerHTML = `<li class="empty"><span class="hand">chwila moment…</span>Nie udało się wczytać danych. Odśwież stronę.</li>`;
    })
    .finally(() => {
      setInterval(poll, POLL_MS);
      setInterval(tickLive, 30_000);
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && poll());
      openFromHash();
      locate(true);
    });

  // ---------- Instalacja jak aplikacja ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    const btn = $("installBtn");
    btn.hidden = false;
    btn.onclick = async () => {
      e.prompt();
      await e.userChoice;
      btn.hidden = true;
    };
  });
})();
