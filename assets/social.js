// Część społecznościowa: konta, odhaczanie lokali, rangi, odznaki, rankingi, aktywność, filmiki.
// Mapa (assets/app.js) działa bez tego pliku; tu korzystamy z jej API: window.Ksiapulo.
(() => {
  "use strict";

  const K = window.Ksiapulo;
  const CFG = window.KSIAPULO_CONFIG ?? {};
  const ON = Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const IS_APP = Boolean(window.Capacitor?.isNativePlatform?.());
  const APP_LINK = "ksiapulo://auth";
  const SB_SRC = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  const { esc, plural } = K;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- rangi i odznaki
  // Progi punktów. Muszą rosnąć.
  const RANKS = [
    [0, "Głodny Junior", "🥄"],
    [50, "Turysta budkowy", "🌭"],
    [150, "Osiedlowy wyjadacz", "🥙"],
    [350, "Koneser sosu", "🧄"],
    [700, "Weryfikator", "🔍"],
    [1200, "Łowca MUALA", "🏆"],
    [2000, "Legenda kebaba", "👑"],
  ];
  const rankOf = (pts) => {
    let i = 0;
    while (i + 1 < RANKS.length && pts >= RANKS[i + 1][0]) i++;
    const [from, name, emoji] = RANKS[i];
    const next = RANKS[i + 1];
    return { level: i + 1, name, emoji, from, next: next?.[0] ?? null, nextName: next?.[1] ?? null };
  };

  // Te same kody i punkty co w evaluate_badges() w supabase/schema.sql
  const BADGES = {
    pierwszy_kes: ["🍽️", "Pierwszy kęs", "Odhacz pierwszy lokal", 20],
    dziesiatka: ["🔟", "Dziesiątka", "Odhacz 10 lokali", 60],
    piecdziesiatka: ["💯", "Pięćdziesiątka", "Odhacz 50 lokali", 200],
    kebabiarz: ["🥙", "Kebabiarz", "Odhacz 5 kebabów", 40],
    lowca_muala: ["🏅", "Łowca MUALA", "Odhacz 3 lokale z MUALA", 60],
    kolekcjoner_muala: ["🏆", "Kolekcjoner MUALA", "Odhacz 10 lokali z MUALA", 150],
    podroznik: ["🧳", "Podróżnik", "Lokale w 5 różnych miastach", 80],
    maraton: ["🏃", "Maraton", "3 lokale jednego dnia", 50],
    nocny_glod: ["🌙", "Nocny głód", "Odhaczenie między 22:00 a 4:00", 20],
    swiezak: ["🆕", "Świeżak", "Bądź w lokalu do 7 dni po premierze odcinka", 40],
    lokalny_25: ["📍", "Lokalny patriota", "Odhacz 25% swojej listy", 60],
    lokalny_100: ["🗺️", "Władca okolicy", "Odhacz całą swoją listę", 250],
    trasa_odcinka: ["🎬", "Cały odcinek", "Wszystkie lokale z jednego odcinka (min. 3)", 100],
    recenzent: ["🎥", "Recenzent", "Dodaj pierwszy filmik z opinią", 30],
    ulubieniec: ["🧡", "Ulubieniec widzów", "Filmik z 10 reakcjami MUALA", 80],
    influencer: ["📣", "Influencer", "Ktoś z twojego linku odhaczył pierwszy lokal", 50],
  };

  const POINTS = [
    ["Odhaczenie lokalu (GPS + zdjęcie)", "+10"],
    ["Lokal z MUALA", "+15"],
    ["Pierwszy na Ksiapulo w tym lokalu", "+10"],
    ["W ciągu 7 dni od premiery odcinka", "+10"],
    ["Filmik z opinią o odhaczonym lokalu", "+25"],
    ["Reakcja MUALA na twój filmik", "+2"],
    ["Reakcja na twoje odhaczenie", "+1"],
    ["Ktoś dołączył z twojego linku / story", "+20"],
    ["…i odhaczył pierwszy lokal", "+40"],
    ["Odznaki za zadania", "+20 do +250"],
  ];

  // ---------------------------------------------------------------- stan
  const S = {
    sb: null,
    user: null,
    profile: null,
    checkins: [], // moje: { id, place_id, status, created_at }
    view: "mapa",
    feedScope: "city",
    boardScope: "city",
    boardPeriod: "week",
    stats: null, // profile_stats dla mnie
  };

  // Polecenie: ?ref=nazwa zapamiętujemy do rejestracji
  const params = new URLSearchParams(location.search);
  if (params.get("ref")) {
    try {
      localStorage.setItem("ksiapulo_ref", params.get("ref").toLowerCase().slice(0, 20));
    } catch {}
    params.delete("ref");
    history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash);
  }
  const storedRef = () => {
    try {
      return localStorage.getItem("ksiapulo_ref");
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------- pomocnicze
  const placeById = (id) => K.places.find((p) => p.id === id);
  const mediaUrl = (bucket, path) => (path ? `${CFG.supabaseUrl}/storage/v1/object/public/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}` : "");
  const ago = (iso) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return "przed chwilą";
    if (m < 60) return `${m} min temu`;
    if (m < 1440) return `${Math.round(m / 60)} godz. temu`;
    if (m < 2880) return "wczoraj";
    return K.fmtDate(iso);
  };
  const errText = (e) => (e?.message ?? String(e)).replace(/^.*?ERROR:\s*/, "");
  const doneMap = () => new Map(S.checkins.filter((c) => c.status !== "rejected").map((c) => [c.place_id, c]));
  const shareUrl = () => `${location.origin}${location.pathname}${S.profile ? `?ref=${encodeURIComponent(S.profile.username)}` : ""}`;

  /** Lista do odhaczenia zależy tylko od miasta domowego — ten sam algorytm co local_radius() w bazie. */
  function localList(lat, lng) {
    const open = K.places.filter((p) => !p.closed);
    const within = (r) => open.filter((p) => K.km({ lat, lng }, p) <= r);
    for (const r of [15, 25, 40, 60, 90, 150]) {
      const list = within(r);
      if (list.length >= 12) return { r, list };
    }
    return { r: 150, list: within(150) };
  }

  // ---------------------------------------------------------------- okno (sheet)
  const sheet = $("sheet");
  function openSheet(title, html) {
    $("sheetTitle").innerHTML = title;
    $("sheetBody").innerHTML = html;
    if (!sheet.open) sheet.showModal();
    $("sheetBody").scrollTop = 0;
    return $("sheetBody");
  }
  const closeSheet = () => sheet.open && sheet.close();
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || e.target.closest("[data-close]")) closeSheet();
  });

  // ---------------------------------------------------------------- zakładki
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b) showView(b.dataset.view);
  });

  function showView(view) {
    const prev = S.view;
    S.view = view;
    document.querySelectorAll("#tabs [data-view]").forEach((b) => b.classList.toggle("is-on", b.dataset.view === view));
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
    if (matchMedia("(max-width: 820px)").matches && document.body.classList.contains("show-map")) K.toggleMap(false);
    $("panel").scrollTop = 0;
    if (prev === "lista" && view !== "lista") K.setScope(null);
    renderView();
  }

  function renderView() {
    if (S.view === "lista") renderList();
    else if (S.view === "aktywnosc") renderFeed();
    else if (S.view === "ranking") renderBoard();
    else if (S.view === "ty") renderMe();
  }

  const offHtml = `<div class="soc-empty"><span class="hand">chwila moment…</span>
    <p>Konta, rankingi i odhaczanie lokali startują wkrótce. Mapa działa normalnie.</p></div>`;

  function loginCta(text) {
    return `<div class="soc-empty">
      <span class="hand">no to jedziemy</span>
      <p>${text}</p>
      <button type="button" class="btn btn--locate js-login">Zaloguj się / załóż konto</button>
    </div>`;
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest(".js-login")) openLogin();
  });

  // ---------------------------------------------------------------- logowanie
  function openLogin() {
    if (!ON) return openSheet("Wkrótce", offHtml);
    const body = openSheet(
      "Zaloguj się",
      `<p class="soc-lead">Odhaczaj lokale z odcinków, zbieraj punkty i rywalizuj ze znajomymi z miasta.</p>
      ${
        CFG.google
          ? `<button type="button" class="btn btn--google" id="gBtn"><b>G</b> Zaloguj przez Google</button>
             <div class="soc-or"><span>albo linkiem na e-mail</span></div>`
          : ""
      }
      <form id="mailForm" class="soc-form">
        <input type="email" required placeholder="twoj@email.pl" autocomplete="email" id="mailInput">
        <button type="submit" class="btn btn--ink">Wyślij link</button>
      </form>
      <p class="soc-note" id="loginMsg">Bez hasła — dostaniesz maila z kodem i linkiem do logowania.</p>
      <form id="codeForm" class="soc-form soc-code" hidden>
        <input id="codeInput" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" placeholder="Kod z maila" required>
        <button type="submit" class="btn btn--locate">Zaloguj</button>
      </form>
      <p class="soc-fine">Logując się akceptujesz <a href="zasady.html" target="_blank">zasady i politykę prywatności</a>.</p>`,
    );
    // W aplikacji link z maila wraca przez własny adres ksiapulo:// (Info.plist → CFBundleURLTypes)
    const redirectTo = IS_APP ? APP_LINK : location.origin + location.pathname;
    body.querySelector("#gBtn")?.addEventListener("click", () => S.sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo } }));
    const send = body.querySelector("#mailForm button");
    // Supabase pozwala poprosić o link raz na 60 s — odliczamy, zamiast pokazywać błąd
    const cooldown = (s) => {
      send.disabled = true;
      const tick = () => {
        if (!send.isConnected) return;
        if (s <= 0) {
          send.disabled = false;
          send.textContent = "Wyślij ponownie";
          return;
        }
        send.textContent = `Ponownie za ${s--} s`;
        setTimeout(tick, 1000);
      };
      tick();
    };
    body.querySelector("#mailForm").onsubmit = async (e) => {
      e.preventDefault();
      const email = body.querySelector("#mailInput").value.trim();
      const msg = body.querySelector("#loginMsg");
      send.disabled = true;
      msg.textContent = "Wysyłam…";
      const { error } = await S.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
      if (!error) {
        msg.innerHTML = `Mail poszedł na <b>${esc(email)}</b>. ${
          IS_APP ? "Otwórz go na tym iPhonie i kliknij link — wrócisz do aplikacji już zalogowany." : "Kliknij link w tej samej przeglądarce."
        } Nie widzisz maila? Zajrzyj do spamu.`;
        if (CFG.emailCode) showCode(email);
        return cooldown(60);
      }
      const wait = errText(error).match(/after (\d+) seconds?/);
      if (wait) {
        msg.textContent = "Mail został już wysłany przed chwilą — sprawdź skrzynkę (także spam). O kolejny możesz poprosić za chwilę.";
        if (CFG.emailCode) showCode(email);
        return cooldown(+wait[1]);
      }
      send.disabled = false;
      msg.textContent = authError(error);
    };

    // Kod z maila zamiast linku: w aplikacji na iPhonie link otworzyłby Safari, a nie aplikację
    function showCode(email) {
      const form = body.querySelector("#codeForm");
      form.hidden = false;
      const input = body.querySelector("#codeInput");
      input.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        const msg = body.querySelector("#loginMsg");
        const btn = form.querySelector("button");
        btn.disabled = true;
        msg.textContent = "Sprawdzam kod…";
        const { error } = await S.sb.auth.verifyOtp({ email, token: input.value.trim(), type: "email" });
        btn.disabled = false;
        if (error) {
          msg.textContent = /expired|invalid/i.test(errText(error)) ? "Kod jest błędny albo wygasł. Sprawdź najnowszego maila." : authError(error);
          return;
        }
        closeSheet();
        await loadMe();
      };
    }
  }

  /** Komunikaty Supabase Auth są po angielsku — tłumaczymy te, które zobaczy zwykły użytkownik. */
  function authError(error) {
    const t = errText(error);
    if (/rate limit/i.test(t)) return "Wysłaliśmy już za dużo maili w tej godzinie. Spróbuj za jakiś czas.";
    if (/invalid.*email|email.*invalid|unable to validate email/i.test(t)) return "Ten adres e-mail wygląda na nieprawidłowy.";
    if (/signups? not allowed/i.test(t)) return "Rejestracja nowych kont jest chwilowo wyłączona.";
    if (/fetch|network/i.test(t)) return "Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.";
    return `Nie udało się wysłać linku (${t}).`;
  }

  // ---------------------------------------------------------------- miasto (Nominatim)
  async function searchCity(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=pl&accept-language=pl&featuretype=settlement&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Wyszukiwarka miast nie odpowiada");
    const hits = await res.json();
    return hits.filter((h, i, all) => all.findIndex((x) => x.display_name === h.display_name) === i);
  }

  /** Pole wyboru miasta domowego; cb({ city, lat, lng }) po wybraniu. */
  function cityPicker(root, current, cb) {
    root.innerHTML = `<div class="soc-form">
        <input type="search" placeholder="np. Tarnowskie Góry" value="${esc(current?.city ?? "")}" class="js-city-q">
        <button type="button" class="btn btn--ink js-city-go">Szukaj</button>
      </div>
      <ul class="results js-city-res" hidden></ul>
      <p class="soc-note js-city-info"></p>`;
    const info = root.querySelector(".js-city-info");
    const show = (c) => {
      const { r, list } = localList(c.lat, c.lng);
      info.innerHTML = `<b>${esc(c.city)}</b> — twoja lista: <b>${list.length} ${plural(list.length, "lokal", "lokale", "lokali")}</b> w promieniu ${r} km. Tę samą listę mają wszyscy z tym miastem domowym.`;
    };
    if (current?.city) show(current);
    const go = async () => {
      const q = root.querySelector(".js-city-q").value.trim();
      if (!q) return;
      info.textContent = "Szukam…";
      try {
        const hits = await searchCity(q);
        const res = root.querySelector(".js-city-res");
        if (!hits.length) return (info.textContent = "Nie znalazłem takiej miejscowości.");
        info.textContent = "↑ Kliknij swoje miasto na liście.";
        res.innerHTML = hits.map((h, i) => `<li><button type="button" data-i="${i}">${esc(h.display_name)}</button></li>`).join("");
        res.hidden = false;
        res.onclick = (e) => {
          const b = e.target.closest("button");
          if (!b) return;
          const h = hits[+b.dataset.i];
          const c = { city: h.name || h.display_name.split(",")[0], lat: +h.lat, lng: +h.lon };
          res.hidden = true;
          root.querySelector(".js-city-q").value = c.city;
          show(c);
          cb(c);
        };
      } catch (e) {
        info.textContent = errText(e);
      }
    };
    root.querySelector(".js-city-go").onclick = go;
    // addEventListener, nie onkeydown: zwrócone `false` z onkeydown blokowałoby wpisywanie liter
    root.querySelector(".js-city-q").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      go();
    });
  }

  // ---------------------------------------------------------------- pierwszy profil
  function openOnboarding() {
    const suggested = (S.user.email ?? "").split("@")[0].toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 20);
    const ref = storedRef();
    let city = null;
    const body = openSheet(
      "Załóż profil",
      `<form id="obForm" class="soc-stack">
        <label>Nazwa użytkownika <small>(małe litery, cyfry, _ i .)</small>
          <input name="username" required pattern="[a-z0-9_.]{3,20}" maxlength="20" value="${esc(suggested.length >= 3 ? suggested : "")}" autocomplete="username"></label>
        <label>Jak cię wyświetlać
          <input name="display" required minlength="2" maxlength="30" value="${esc(S.user.user_metadata?.full_name ?? "")}"></label>
        <div><span class="soc-label">Miasto domowe — od niego zależy twoja lista lokali i ranking miasta</span><div id="obCity"></div></div>
        ${ref ? `<p class="soc-note">Zaprosił cię: <b>@${esc(ref)}</b> — dostanie punkty, gdy odhaczysz pierwszy lokal.</p>` : ""}
        <label class="soc-check"><input type="checkbox" required> Mam co najmniej 16 lat i akceptuję <a href="zasady.html" target="_blank">zasady społeczności</a></label>
        <button type="submit" class="btn btn--locate">Zaczynam</button>
        <p class="soc-err" id="obErr"></p>
      </form>`,
    );
    cityPicker(body.querySelector("#obCity"), null, (c) => (city = c));
    body.querySelector("#obForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const err = body.querySelector("#obErr");
      if (!city) return (err.textContent = "Wybierz miasto domowe z listy.");
      const { error } = await S.sb.rpc("create_profile", {
        p_username: f.get("username"),
        p_display: f.get("display"),
        p_city: city.city,
        p_lat: city.lat,
        p_lng: city.lng,
        p_ref: ref,
      });
      if (error) return (err.textContent = errText(error));
      try {
        localStorage.removeItem("ksiapulo_ref");
      } catch {}
      closeSheet();
      await loadMe();
      showView("lista");
    };
  }

  // ---------------------------------------------------------------- dane zalogowanego
  async function loadMe() {
    const { data } = await S.sb.auth.getUser();
    S.user = data.user;
    if (!S.user) {
      S.profile = null;
      S.checkins = [];
      S.stats = null;
      K.setDone([]);
      renderChip();
      renderView();
      return;
    }
    const { data: profile } = await S.sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle();
    S.profile = profile;
    if (!profile) {
      renderChip();
      return openOnboarding();
    }
    const { data: cks } = await S.sb.from("checkins").select("id, place_id, status, created_at").eq("user_id", S.user.id);
    S.checkins = cks ?? [];
    const { data: stats } = await S.sb.rpc("profile_stats", { p_username: profile.username });
    S.stats = stats;
    K.setDone([...doneMap().keys()]);
    renderChip();
    renderView();
  }

  function renderChip() {
    const chip = $("meChip");
    if (!ON) return;
    chip.hidden = false;
    if (!S.profile) {
      chip.innerHTML = S.user ? "Dokończ profil" : "Zaloguj się";
      chip.onclick = () => (S.user ? openOnboarding() : openLogin());
      $("tabMe").textContent = "Ty";
      return;
    }
    const r = rankOf(S.profile.points);
    chip.innerHTML = `<span>${r.emoji}</span><b>${S.profile.points}</b><small>pkt</small>`;
    chip.title = `${r.name} — poziom ${r.level}`;
    chip.onclick = () => showView("ty");
    $("tabMe").textContent = S.profile.display_name.split(" ")[0].slice(0, 10);
  }

  // ---------------------------------------------------------------- dymek lokalu
  K.on("popup", (p, el) => {
    if (!ON || !el) return;
    const c = doneMap().get(p.id);
    if (!S.profile) {
      el.innerHTML = `<button type="button" class="btn btn--checkin js-login">✅ Odhacz ten lokal</button>`;
    } else if (c?.status === "review") {
      el.innerHTML = `<p class="pop__state">⏳ Odhaczenie czeka na sprawdzenie</p>`;
    } else if (c) {
      el.innerHTML = `<p class="pop__state is-done">✅ Odhaczone ${K.fmtDate(c.created_at)}</p>
        <div class="pop__tools">
          <button type="button" class="js-video">🎥 Dodaj opinię</button>
          <button type="button" class="js-story">📸 Story</button>
        </div>`;
      el.querySelector(".js-video").onclick = () => openVideo(p);
      el.querySelector(".js-story").onclick = () => shareStory("checkin", p);
    } else if (p.closed) {
      el.innerHTML = "";
    } else {
      el.innerHTML = `<button type="button" class="btn btn--checkin js-checkin">✅ Jestem tu — odhacz</button>`;
      el.querySelector(".js-checkin").onclick = () => openCheckin(p);
    }
    // opinie widzów o tym lokalu
    S.sb
      .from("videos")
      .select("id", { count: "exact", head: true })
      .eq("place_id", p.id)
      .eq("status", "visible")
      .then(({ count }) => {
        if (!count || !el.isConnected) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pop__opinions";
        b.textContent = `🎥 ${count} ${plural(count, "opinia", "opinie", "opinii")} widzów`;
        b.onclick = () => openPlaceVideos(p);
        el.append(b);
      });
  });

  // ---------------------------------------------------------------- odhaczanie
  const maxDistance = (p, acc) => (p.approx ? 4000 : 250 + Math.min(acc ?? 0, 150));

  async function compressImage(file, max = 1280) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    // przerysowanie usuwa też metadane EXIF (np. dokładną lokalizację z telefonu)
    return new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
  }
  async function sha256(blob) {
    const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function openCheckin(p) {
    let photo = null;
    let pos = null;
    const body = openSheet(
      `Odhacz: ${esc(p.name)}`,
      `<p class="soc-lead">${esc(p.city ?? "")} · zrób zdjęcie jedzenia na miejscu. Lokalizacja potwierdzi, że tu jesteś.</p>
      <p class="soc-gps" id="ckGps">📍 Sprawdzam, gdzie jesteś…</p>
      <label class="btn btn--photo">📸 Zrób zdjęcie jedzenia
        <input type="file" accept="image/*" capture="environment" id="ckFile" hidden></label>
      <img id="ckPreview" class="soc-preview" alt="" hidden>
      <button type="button" class="btn btn--locate" id="ckGo" disabled>Odhacz lokal</button>
      <p class="soc-err" id="ckErr"></p>
      ${p.approx ? '<p class="soc-fine">Ten lokal ma przybliżoną pinezkę, więc wystarczy, że jesteś w okolicy.</p>' : ""}`,
    );
    const gps = body.querySelector("#ckGps");
    const go = body.querySelector("#ckGo");
    const ready = () => (go.disabled = !(photo && pos && pos.ok));

    navigator.geolocation?.getCurrentPosition(
      (g) => {
        const d = K.km({ lat: g.coords.latitude, lng: g.coords.longitude }, p) * 1000;
        const ok = d <= maxDistance(p, g.coords.accuracy);
        pos = { lat: g.coords.latitude, lng: g.coords.longitude, acc: g.coords.accuracy, ok };
        const dist = d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1).replace(".", ",")} km`;
        gps.innerHTML = ok ? `📍 Jesteś ${dist} od lokalu — git.` : `📍 Jesteś ${dist} od lokalu. Odhaczyć możesz tylko na miejscu.`;
        gps.classList.toggle("is-bad", !ok);
        ready();
      },
      () => {
        gps.textContent = "📍 Nie mam dostępu do lokalizacji. Zezwól na nią w przeglądarce i otwórz to okno ponownie.";
        gps.classList.add("is-bad");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );

    body.querySelector("#ckFile").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        photo = await compressImage(f);
        const img = body.querySelector("#ckPreview");
        img.src = URL.createObjectURL(photo);
        img.hidden = false;
        ready();
      } catch {
        body.querySelector("#ckErr").textContent = "Nie umiem odczytać tego zdjęcia, spróbuj zrobić je jeszcze raz.";
      }
    };

    go.onclick = async () => {
      go.disabled = true;
      go.textContent = "Wysyłam…";
      const err = body.querySelector("#ckErr");
      const path = `${S.user.id}/${crypto.randomUUID()}.jpg`;
      const before = S.profile.points;
      try {
        const up = await S.sb.storage.from("checkins").upload(path, photo, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        const { data, error } = await S.sb.rpc("check_in", {
          p_place: p.id,
          p_lat: pos.lat,
          p_lng: pos.lng,
          p_accuracy: pos.acc,
          p_photo: path,
          p_hash: await sha256(photo),
        });
        if (error) {
          await S.sb.storage.from("checkins").remove([path]);
          throw error;
        }
        await loadMe();
        K.refreshPopup();
        showResult(p, data, before, URL.createObjectURL(photo));
      } catch (e) {
        err.textContent = errText(e);
        go.disabled = false;
        go.textContent = "Spróbuj jeszcze raz";
      }
    };
  }

  function showResult(p, r, before, photoUrl) {
    const after = S.profile.points;
    const up = rankOf(after).level > rankOf(before).level ? rankOf(after) : null;
    const badges = (r.badges ?? []).map((b) => BADGES[b]).filter(Boolean);
    const body = openSheet(
      r.status === "ok" ? "Odhaczone! 🎉" : "Prawie gotowe ⏳",
      `${
        r.status === "ok"
          ? `<div class="soc-points">+${r.points + badges.reduce((s, b) => s + b[3], 0)} <small>pkt</small></div>`
          : `<p class="soc-lead">Odhaczenie trafiło do sprawdzenia (np. słaby GPS albo powtórzone zdjęcie). Punkty dostaniesz po akceptacji.</p>`
      }
      ${up ? `<div class="soc-rankup">Nowa ranga: <b>${up.emoji} ${esc(up.name)}</b></div>` : ""}
      ${badges.map((b) => `<div class="soc-badge-new"><span>${b[0]}</span><div><b>${esc(b[1])}</b><small>${esc(b[2])} · +${b[3]} pkt</small></div></div>`).join("")}
      <div class="soc-actions">
        <button type="button" class="btn btn--locate js-story">📸 Wrzuć story (+20 pkt za każdego, kto dołączy)</button>
        <button type="button" class="btn js-video">🎥 Nagraj opinię (+25 pkt)</button>
      </div>`,
    );
    body.querySelector(".js-story").onclick = () => shareStory("checkin", p, photoUrl);
    body.querySelector(".js-video").onclick = () => openVideo(p);
  }

  // ---------------------------------------------------------------- filmiki z opiniami
  function videoMeta(file) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      v.src = URL.createObjectURL(file);
      v.onloadedmetadata = () => {
        v.currentTime = Math.min(1, v.duration / 2);
      };
      v.onseeked = () => {
        const c = document.createElement("canvas");
        const s = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
        c.width = Math.round(v.videoWidth * s);
        c.height = Math.round(v.videoHeight * s);
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((poster) => resolve({ duration: v.duration, poster }), "image/jpeg", 0.8);
      };
      v.onerror = () => reject(new Error("Nie umiem odczytać tego filmiku"));
    });
  }

  function openVideo(p) {
    let file = null;
    let meta = null;
    const body = openSheet(
      `Opinia: ${esc(p.name)}`,
      `<p class="soc-lead">Powiedz, jak było — max 60 sekund. Bez wulgaryzmów i hejtu na ludzi, zasady są <a href="zasady.html" target="_blank">tutaj</a>.</p>
      <label class="btn btn--photo">🎥 Nagraj albo wybierz filmik
        <input type="file" accept="video/*" id="vdFile" hidden></label>
      <video id="vdPreview" class="soc-preview" controls playsinline hidden></video>
      <textarea id="vdCaption" maxlength="300" rows="2" placeholder="Krótki opis (opcjonalnie)"></textarea>
      <button type="button" class="btn btn--locate" id="vdGo" disabled>Opublikuj opinię</button>
      <p class="soc-err" id="vdErr"></p>`,
    );
    const err = body.querySelector("#vdErr");
    const go = body.querySelector("#vdGo");
    body.querySelector("#vdFile").onchange = async (e) => {
      file = e.target.files[0];
      go.disabled = true;
      err.textContent = "";
      if (!file) return;
      if (file.size > 60 * 1024 * 1024) return (err.textContent = "Filmik jest za duży (max 60 MB). Nagraj krócej albo w niższej jakości.");
      try {
        meta = await videoMeta(file);
        if (meta.duration > 60.5) return (err.textContent = `Filmik ma ${Math.round(meta.duration)} s — max 60 s.`);
        const v = body.querySelector("#vdPreview");
        v.src = URL.createObjectURL(file);
        v.hidden = false;
        go.disabled = false;
      } catch (e2) {
        err.textContent = errText(e2);
      }
    };
    go.onclick = async () => {
      go.disabled = true;
      go.textContent = "Wysyłam filmik…";
      const id = crypto.randomUUID();
      const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${S.user.id}/${id}.${ext}`;
      const poster = `${S.user.id}/${id}-poster.jpg`;
      try {
        const up = await S.sb.storage.from("videos").upload(path, file, { contentType: file.type || "video/mp4" });
        if (up.error) throw up.error;
        if (meta.poster) await S.sb.storage.from("videos").upload(poster, meta.poster, { contentType: "image/jpeg" });
        const { data, error } = await S.sb.rpc("post_video", {
          p_place: p.id,
          p_path: path,
          p_poster: meta.poster ? poster : null,
          p_caption: body.querySelector("#vdCaption").value,
          p_duration: meta.duration,
        });
        if (error) {
          await S.sb.storage.from("videos").remove([path, poster]);
          throw error;
        }
        await loadMe();
        const badges = (data.badges ?? []).map((b) => BADGES[b]).filter(Boolean);
        openSheet(
          "Opinia dodana! 🎥",
          `<div class="soc-points">+${data.points + badges.reduce((s, b) => s + b[3], 0)} <small>pkt</small></div>
          <p class="soc-lead">Każda reakcja MUALA na twój filmik to kolejne +2 pkt.</p>
          ${badges.map((b) => `<div class="soc-badge-new"><span>${b[0]}</span><div><b>${esc(b[1])}</b><small>+${b[3]} pkt</small></div></div>`).join("")}`,
        );
      } catch (e2) {
        err.textContent = errText(e2);
        go.disabled = false;
        go.textContent = "Spróbuj jeszcze raz";
      }
    };
  }

  async function openPlaceVideos(p) {
    const body = openSheet(`Opinie: ${esc(p.name)}`, `<p class="soc-note">Wczytuję…</p>`);
    const { data, error } = await S.sb
      .from("videos")
      .select("id, created_at, path, poster_path, caption, user_id, profiles(username, display_name)")
      .eq("place_id", p.id)
      .eq("status", "visible")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) return (body.innerHTML = `<p class="soc-err">${esc(errText(error))}</p>`);
    body.innerHTML = `<ol class="feed">${data
      .map((v) =>
        feedItem({
          kind: "video",
          id: v.id,
          created_at: v.created_at,
          username: v.profiles.username,
          display_name: v.profiles.display_name,
          place_id: p.id,
          place_name: p.name,
          place_city: p.city,
          media_path: v.path,
          poster_path: v.poster_path,
          caption: v.caption,
          reactions: null,
        }),
      )
      .join("")}</ol>`;
  }

  // ---------------------------------------------------------------- moja lista
  function renderList() {
    const root = $("view-lista");
    if (!ON) return (root.innerHTML = offHtml);
    if (!S.profile) {
      K.setScope(null);
      return (root.innerHTML = loginCta("Każdy dostaje listę lokali z odcinków w okolicy swojego miasta. Ludzie z tego samego miasta mają tę samą listę — kto odhaczy więcej?"));
    }
    const { r, list } = localList(S.profile.home_lat, S.profile.home_lng);
    const done = doneMap();
    const home = { lat: S.profile.home_lat, lng: S.profile.home_lng };
    const sorted = [...list].sort((a, b) => (done.has(a.id) - done.has(b.id)) || K.km(home, a) - K.km(home, b));
    const n = list.filter((p) => done.get(p.id)?.status === "ok").length;
    const pct = list.length ? Math.round((n / list.length) * 100) : 0;
    root.innerHTML = `<section class="soc-card">
        <div class="soc-card__top"><div><span class="soc-label">Twoja lista</span>
          <h2>${esc(S.profile.home_city)} <small>i okolice do ${r} km</small></h2></div>
          <div class="soc-big">${n}<small>/${list.length}</small></div></div>
        <div class="soc-bar"><i style="width:${pct}%"></i></div>
        <p class="soc-note">Tę samą listę mają wszyscy z miastem domowym ${esc(S.profile.home_city)}. Sprawdź <a href="#" class="js-cityboard">ranking miasta</a>.</p>
      </section>
      <ol class="soc-list">${sorted
        .map((p) => {
          const c = done.get(p.id);
          const d = K.km(home, p);
          return `<li class="${c ? "is-done" : ""}" data-id="${esc(p.id)}">
            <span class="soc-list__mark">${c ? (c.status === "review" ? "⏳" : "✅") : (K.CATS[p.category] ?? K.CATS.inne)[0]}</span>
            <div><b>${esc(p.name)}</b><small>${esc(p.city ?? "")} · ${d < 10 ? d.toFixed(1).replace(".", ",") : Math.round(d)} km${p.verdict === "muala" ? ' · <span class="stk stk--muala">MUALA</span>' : ""}</small></div>
            <span class="soc-list__go">›</span>
          </li>`;
        })
        .join("")}</ol>`;
    K.setScope(new Set(list.map((p) => p.id)));
    root.querySelector(".soc-list").onclick = (e) => {
      const li = e.target.closest("li");
      if (li) K.focusPlace(li.dataset.id);
    };
    root.querySelector(".js-cityboard").onclick = (e) => {
      e.preventDefault();
      S.boardScope = "city";
      showView("ranking");
    };
  }

  // ---------------------------------------------------------------- aktywność
  function feedItem(it) {
    const isVideo = it.kind === "video";
    const media = isVideo
      ? `<video controls playsinline preload="none" poster="${esc(mediaUrl("videos", it.poster_path))}" src="${esc(mediaUrl("videos", it.media_path))}"></video>`
      : `<img src="${esc(mediaUrl("checkins", it.media_path))}" alt="Zdjęcie jedzenia" loading="lazy">`;
    return `<li class="feed__item" data-kind="${it.kind}" data-id="${it.id}">
      <header>
        <button type="button" class="feed__avatar js-user" data-user="${esc(it.username)}">${esc(it.display_name.slice(0, 1).toUpperCase())}</button>
        <div><button type="button" class="feed__name js-user" data-user="${esc(it.username)}">${esc(it.display_name)}</button>
          <small>${isVideo ? "nagrał(a) opinię o" : "odhaczył(a)"} <a href="#" class="js-place" data-place="${esc(it.place_id)}">${esc(it.place_name)}</a>, ${esc(it.place_city ?? "")} · ${ago(it.created_at)}</small></div>
      </header>
      <div class="feed__media">${media}</div>
      ${it.caption ? `<p class="feed__caption">${esc(it.caption)}</p>` : ""}
      <footer>
        ${it.reactions === null ? "" : `<button type="button" class="feed__react js-react${it.mine ? " is-on" : ""}">🧡 MUALA <b>${it.reactions}</b></button>`}
        ${isVideo ? `<button type="button" class="feed__report js-report" title="Zgłoś filmik">⚑ Zgłoś</button>` : ""}
      </footer>
    </li>`;
  }

  async function renderFeed(more) {
    const root = $("view-aktywnosc");
    if (!ON) return (root.innerHTML = offHtml);
    const scopes = [
      ["city", "Moje miasto"],
      ["friends", "Obserwowani"],
      ["all", "Wszyscy"],
    ];
    if (!S.profile && S.feedScope !== "all") S.feedScope = "all";
    if (!more) {
      root.innerHTML = `<div class="seg soc-seg">${scopes
        .map(([k, l]) => `<button type="button" data-scope="${k}" class="${S.feedScope === k ? "is-on" : ""}" ${!S.profile && k !== "all" ? "disabled" : ""}>${l}</button>`)
        .join("")}</div>
        ${S.profile ? "" : loginCta("Zaloguj się, żeby odhaczać lokale, reagować i obserwować znajomych.")}
        <ol class="feed" id="feedList"><li class="soc-note">Wczytuję…</li></ol>
        <button type="button" class="btn btn--more" id="feedMore" hidden>Starsze</button>`;
      root.querySelector(".soc-seg").onclick = (e) => {
        const b = e.target.closest("[data-scope]");
        if (!b || b.disabled) return;
        S.feedScope = b.dataset.scope;
        renderFeed();
      };
    }
    const list = root.querySelector("#feedList");
    const before = more ? list.lastElementChild?.dataset.at : new Date().toISOString();
    const { data, error } = await S.sb.rpc("feed", { p_scope: S.feedScope, p_before: before, p_limit: 20 });
    if (!more) list.innerHTML = "";
    if (error) return (list.innerHTML = `<li class="soc-err">${esc(errText(error))}</li>`);
    if (!data.length && !more) {
      list.innerHTML = `<li class="soc-empty"><span class="hand">cisza…</span><p>${
        S.feedScope === "friends" ? "Zacznij obserwować ludzi z rankingu, a ich odhaczenia pojawią się tutaj." : "Nikt jeszcze niczego nie odhaczył. Bądź pierwszy!"
      }</p></li>`;
    }
    list.insertAdjacentHTML("beforeend", data.map((it) => feedItem(it).replace("<li ", `<li data-at="${it.created_at}" `)).join(""));
    const moreBtn = root.querySelector("#feedMore");
    moreBtn.hidden = data.length < 20;
    moreBtn.onclick = () => renderFeed(true);
  }

  // kliknięcia w aktywności i opiniach (także w oknie)
  document.addEventListener("click", async (e) => {
    const user = e.target.closest(".js-user");
    if (user) return openProfile(user.dataset.user);
    const place = e.target.closest(".js-place");
    if (place) {
      e.preventDefault();
      closeSheet();
      return K.focusPlace(place.dataset.place);
    }
    const react = e.target.closest(".js-react");
    if (react) {
      if (!S.profile) return openLogin();
      const item = react.closest(".feed__item");
      const on = !react.classList.contains("is-on");
      const { data, error } = await S.sb.rpc("react", { p_kind: item.dataset.kind, p_target: item.dataset.id, p_on: on });
      if (error) return;
      react.classList.toggle("is-on", on);
      react.querySelector("b").textContent = data;
      return;
    }
    const report = e.target.closest(".js-report");
    if (report) {
      if (!S.profile) return openLogin();
      return openReport(report.closest(".feed__item").dataset.id);
    }
  });

  function openReport(videoId) {
    const reasons = ["Wulgaryzmy lub hejt", "Nie dotyczy lokalu / spam", "Oszustwo (to nie ten lokal)", "Treści dla dorosłych lub przemoc", "Inne"];
    const body = openSheet(
      "Zgłoś filmik",
      `<form class="soc-stack" id="rpForm">${reasons
        .map((r, i) => `<label class="soc-check"><input type="radio" name="r" value="${esc(r)}" ${i === 0 ? "checked" : ""}> ${esc(r)}</label>`)
        .join("")}
        <button type="submit" class="btn btn--ink">Wyślij zgłoszenie</button>
        <p class="soc-note">Po 3 zgłoszeniach filmik znika do decyzji moderatora.</p></form>`,
    );
    body.querySelector("#rpForm").onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await S.sb.rpc("report_video", { p_video: videoId, p_reason: new FormData(e.target).get("r") });
      body.innerHTML = error ? `<p class="soc-err">${esc(errText(error))}</p>` : `<p class="soc-lead">Dzięki, zgłoszenie przyjęte.</p>`;
    };
  }

  // ---------------------------------------------------------------- ranking
  async function renderBoard() {
    const root = $("view-ranking");
    if (!ON) return (root.innerHTML = offHtml);
    if (!S.profile && S.boardScope !== "all") S.boardScope = "all";
    const scopes = [
      ["city", S.profile ? S.profile.home_city : "Moje miasto"],
      ["friends", "Obserwowani"],
      ["all", "Polska"],
    ];
    const periods = [
      ["week", "Ten tydzień"],
      ["all", "Od początku"],
    ];
    root.innerHTML = `<div class="seg soc-seg js-scope">${scopes
      .map(([k, l]) => `<button type="button" data-k="${k}" class="${S.boardScope === k ? "is-on" : ""}" ${!S.profile && k !== "all" ? "disabled" : ""}>${esc(l)}</button>`)
      .join("")}</div>
      <div class="sort soc-period js-period">${periods.map(([k, l]) => `<button type="button" data-k="${k}" class="${S.boardPeriod === k ? "is-on" : ""}">${l}</button>`).join("")}</div>
      <ol class="board" id="boardList"><li class="soc-note">Wczytuję…</li></ol>
      ${S.profile ? "" : loginCta("Zaloguj się, żeby wejść do rankingu swojego miasta.")}`;
    root.querySelector(".js-scope").onclick = (e) => {
      const b = e.target.closest("[data-k]");
      if (!b || b.disabled) return;
      S.boardScope = b.dataset.k;
      renderBoard();
    };
    root.querySelector(".js-period").onclick = (e) => {
      const b = e.target.closest("[data-k]");
      if (!b) return;
      S.boardPeriod = b.dataset.k;
      renderBoard();
    };
    const { data, error } = await S.sb.rpc("leaderboard", { p_scope: S.boardScope, p_period: S.boardPeriod, p_limit: 100 });
    const list = root.querySelector("#boardList");
    if (error) return (list.innerHTML = `<li class="soc-err">${esc(errText(error))}</li>`);
    if (!data.length) return (list.innerHTML = `<li class="soc-empty"><span class="hand">pusto…</span><p>Nikt jeszcze nie zdobył punktów. Odhacz lokal i bądź pierwszy!</p></li>`);
    list.innerHTML = data
      .map((u) => {
        const r = rankOf(u.points);
        const medal = ["🥇", "🥈", "🥉"][u.place - 1] ?? u.place;
        return `<li class="${u.user_id === S.profile?.id ? "is-me" : ""}">
          <span class="board__pos">${medal}</span>
          <button type="button" class="board__who js-user" data-user="${esc(u.username)}">
            <b>${esc(u.display_name)}</b><small>${r.emoji} ${esc(r.name)} · ${esc(u.home_city)}</small></button>
          <span class="board__pts">${u.points}<small> pkt</small></span>
        </li>`;
      })
      .join("");
  }

  // ---------------------------------------------------------------- profile
  function badgeGrid(earned, progress) {
    return `<ul class="badges">${Object.entries(BADGES)
      .map(([code, [emoji, name, desc, pts]]) => {
        const has = earned.has(code);
        const pr = progress?.[code];
        return `<li class="${has ? "is-on" : ""}"><span>${emoji}</span><b>${esc(name)}</b><small>${esc(desc)}</small>
          ${!has && pr ? `<div class="soc-bar soc-bar--sm"><i style="width:${Math.min(100, (pr[0] / pr[1]) * 100)}%"></i></div><small>${pr[0]}/${pr[1]}</small>` : ""}
          <em>${has ? "zdobyta" : `+${pts} pkt`}</em></li>`;
      })
      .join("")}</ul>`;
  }

  /** Postęp zadań liczony z moich odhaczeń (serwer i tak przyznaje odznaki sam). */
  function myProgress() {
    const ok = S.checkins.filter((c) => c.status === "ok");
    const places = ok.map((c) => placeById(c.place_id)).filter(Boolean);
    const perDay = {};
    for (const c of ok) {
      const d = new Date(c.created_at).toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" });
      perDay[d] = (perDay[d] ?? 0) + 1;
    }
    const { list } = localList(S.profile.home_lat, S.profile.home_lng);
    const ids = new Set(ok.map((c) => c.place_id));
    const local = list.filter((p) => ids.has(p.id)).length;
    return {
      pierwszy_kes: [ok.length, 1],
      dziesiatka: [ok.length, 10],
      piecdziesiatka: [ok.length, 50],
      kebabiarz: [places.filter((p) => p.category === "kebab").length, 5],
      lowca_muala: [places.filter((p) => p.mualaDate).length, 3],
      kolekcjoner_muala: [places.filter((p) => p.mualaDate).length, 10],
      podroznik: [new Set(places.map((p) => p.city)).size, 5],
      maraton: [Math.max(0, ...Object.values(perDay)), 3],
      lokalny_25: [local, Math.ceil(list.length / 4)],
      lokalny_100: [local, list.length],
      recenzent: [S.stats?.videos ?? 0, 1],
      influencer: [S.stats?.referrals ?? 0, 1],
    };
  }

  function rankBlock(points) {
    const r = rankOf(points);
    const pct = r.next ? Math.round(((points - r.from) / (r.next - r.from)) * 100) : 100;
    return `<div class="soc-rank"><span class="soc-rank__emoji">${r.emoji}</span>
      <div><span class="soc-label">Poziom ${r.level} z ${RANKS.length}</span><b>${esc(r.name)}</b>
        <div class="soc-bar"><i style="width:${pct}%"></i></div>
        <small>${r.next ? `${points} / ${r.next} pkt do rangi „${esc(r.nextName)}”` : "Najwyższa ranga — szacun."}</small></div></div>`;
  }

  function renderMe() {
    const root = $("view-ty");
    if (!ON) return (root.innerHTML = offHtml);
    if (!S.profile) {
      root.innerHTML = `${loginCta("Odhaczaj lokale z odcinków Książula, zdobywaj rangi i odznaki, rywalizuj ze znajomymi z miasta.")}
        <section class="soc-card"><h3>Rangi</h3><ol class="soc-ranks">${RANKS.map(([pts, name, emoji]) => `<li><span>${emoji}</span><b>${esc(name)}</b><small>od ${pts} pkt</small></li>`).join("")}</ol></section>
        <section class="soc-card"><h3>Za co są punkty</h3>${pointsTable()}</section>
        <section class="soc-card"><h3>Zadania i odznaki</h3>${badgeGrid(new Set())}</section>`;
      return;
    }
    const pr = S.profile;
    const earned = new Set((S.stats?.badges ?? []).map((b) => b.code));
    root.innerHTML = `<section class="soc-card soc-me">
        <div class="soc-card__top"><div><h2>${esc(pr.display_name)}</h2><small>@${esc(pr.username)} · ${esc(pr.home_city)}</small></div>
          <div class="soc-big">${pr.points}<small> pkt</small></div></div>
        ${rankBlock(pr.points)}
        <div class="soc-stats">
          <div><b>${S.checkins.filter((c) => c.status === "ok").length}</b><small>lokali</small></div>
          <div><b>${S.stats?.videos ?? 0}</b><small>opinii</small></div>
          <div><b>${S.stats?.week ?? 0}</b><small>pkt w tym tyg.</small></div>
          <div><b>${S.stats?.followers ?? 0}</b><small>obserwuje cię</small></div>
        </div>
      </section>
      <section class="soc-card"><h3>Zaproś znajomych</h3>
        <p class="soc-note">Wrzuć story z linkiem. Za każdą osobę, która dołączy: +20 pkt, a gdy odhaczy pierwszy lokal: +40 pkt.</p>
        <div class="soc-actions"><button type="button" class="btn btn--locate js-invite">📸 Story z zaproszeniem</button>
        <button type="button" class="btn js-copy">🔗 Kopiuj mój link</button></div></section>
      <section class="soc-card"><h3>Zadania i odznaki <small>${earned.size}/${Object.keys(BADGES).length}</small></h3>${badgeGrid(earned, myProgress())}</section>
      <section class="soc-card"><h3>Za co są punkty</h3>${pointsTable()}</section>
      <section class="soc-card"><h3>Ustawienia</h3>
        <div class="soc-actions">
          <button type="button" class="btn js-edit">✏️ Zmień nazwę lub miasto</button>
          ${pr.is_admin ? '<button type="button" class="btn btn--ink js-admin">🛡️ Panel moderacji</button>' : ""}
          <button type="button" class="btn js-logout">Wyloguj</button>
          <button type="button" class="btn btn--danger js-delete">Usuń konto</button>
        </div></section>`;
    root.querySelector(".js-invite").onclick = () => shareStory("invite");
    root.querySelector(".js-copy").onclick = async (e) => {
      try {
        await navigator.clipboard.writeText(shareUrl());
        e.target.textContent = "✓ Skopiowano";
      } catch {
        e.target.textContent = shareUrl();
      }
    };
    root.querySelector(".js-edit").onclick = openEdit;
    root.querySelector(".js-logout").onclick = async () => {
      await S.sb.auth.signOut();
      await loadMe();
    };
    root.querySelector(".js-delete").onclick = openDelete;
    root.querySelector(".js-admin")?.addEventListener("click", openAdmin);
  }

  const pointsTable = () => `<table class="soc-table">${POINTS.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${b}</td></tr>`).join("")}</table>`;

  async function openProfile(username) {
    const body = openSheet("Profil", `<p class="soc-note">Wczytuję…</p>`);
    const { data: u, error } = await S.sb.rpc("profile_stats", { p_username: username });
    if (error || !u) return (body.innerHTML = `<p class="soc-err">Nie ma takiego profilu.</p>`);
    $("sheetTitle").textContent = u.display_name;
    const earned = new Set(u.badges.map((b) => b.code));
    const me = S.profile?.id === u.id;
    body.innerHTML = `<p class="soc-note">@${esc(u.username)} · ${esc(u.home_city)} · od ${K.fmtDate(u.created_at)}</p>
      ${rankBlock(u.points)}
      <div class="soc-stats">
        <div><b>${u.points}</b><small>pkt</small></div><div><b>${u.places.length}</b><small>lokali</small></div>
        <div><b>${u.videos}</b><small>opinii</small></div><div><b>${u.followers}</b><small>obserwujących</small></div>
      </div>
      ${S.profile && !me ? `<button type="button" class="btn ${u.am_following ? "" : "btn--locate"} js-follow">${u.am_following ? "Obserwujesz ✓" : "➕ Obserwuj"}</button>` : ""}
      <h3>Odznaki</h3>
      <ul class="badges badges--mini">${[...earned].map((c) => BADGES[c]).filter(Boolean).map((b) => `<li class="is-on" title="${esc(b[2])}"><span>${b[0]}</span><b>${esc(b[1])}</b></li>`).join("") || '<li class="soc-note">Jeszcze żadnej.</li>'}</ul>`;
    body.querySelector(".js-follow")?.addEventListener("click", async (e) => {
      const on = !u.am_following;
      const { error: err } = await S.sb.rpc("follow", { p_user: u.id, p_on: on });
      if (err) return;
      u.am_following = on;
      e.target.textContent = on ? "Obserwujesz ✓" : "➕ Obserwuj";
      e.target.classList.toggle("btn--locate", !on);
    });
  }

  function openEdit() {
    let city = { city: S.profile.home_city, lat: S.profile.home_lat, lng: S.profile.home_lng };
    const body = openSheet(
      "Zmień profil",
      `<form id="edForm" class="soc-stack">
        <label>Jak cię wyświetlać <input name="display" required minlength="2" maxlength="30" value="${esc(S.profile.display_name)}"></label>
        <div><span class="soc-label">Miasto domowe</span><div id="edCity"></div></div>
        <button type="submit" class="btn btn--locate">Zapisz</button>
        <p class="soc-err" id="edErr"></p></form>`,
    );
    cityPicker(body.querySelector("#edCity"), city, (c) => (city = c));
    body.querySelector("#edForm").onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await S.sb.rpc("update_profile", {
        p_display: new FormData(e.target).get("display"),
        p_city: city.city,
        p_lat: city.lat,
        p_lng: city.lng,
      });
      if (error) return (body.querySelector("#edErr").textContent = errText(error));
      closeSheet();
      await loadMe();
    };
  }

  function openDelete() {
    const body = openSheet(
      "Usuń konto",
      `<p class="soc-lead">Usuniemy profil, punkty, odhaczenia, zdjęcia i filmiki. Tego nie da się cofnąć.</p>
      <form id="dlForm" class="soc-stack"><label>Wpisz <b>USUŃ</b>, żeby potwierdzić <input name="c" required autocomplete="off"></label>
      <button type="submit" class="btn btn--danger">Usuń na zawsze</button><p class="soc-err" id="dlErr"></p></form>`,
    );
    body.querySelector("#dlForm").onsubmit = async (e) => {
      e.preventDefault();
      if (new FormData(e.target).get("c").trim().toUpperCase() !== "USUŃ") return;
      const err = body.querySelector("#dlErr");
      err.textContent = "Usuwam pliki…";
      for (const bucket of ["checkins", "videos"]) {
        const { data } = await S.sb.storage.from(bucket).list(S.user.id, { limit: 1000 });
        if (data?.length) await S.sb.storage.from(bucket).remove(data.map((f) => `${S.user.id}/${f.name}`));
      }
      const { error } = await S.sb.rpc("delete_account");
      if (error) return (err.textContent = errText(error));
      await S.sb.auth.signOut();
      closeSheet();
      await loadMe();
      showView("mapa");
    };
  }

  // ---------------------------------------------------------------- story
  /** Grafika 1080×1920 do story z linkiem polecającym. */
  async function storyImage(kind, p, photoUrl) {
    await document.fonts.ready;
    const W = 1080;
    const H = 1920;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    g.fillStyle = "#fff4e2";
    g.fillRect(0, 0, W, H);
    // sos u góry
    g.fillStyle = "#f39200";
    g.fillRect(0, 0, W, 300);
    for (const [x, w, h] of [[80, 110, 170], [300, 80, 90], [470, 130, 230], [720, 70, 120], [900, 100, 180]]) {
      g.fillRect(x, 290, w, h - w / 2);
      g.beginPath();
      g.arc(x + w / 2, 290 + h - w / 2, w / 2, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "#141414";
    g.font = "900 92px Poppins";
    g.fillText("KSIAPULO", 70, 160);
    g.font = "700 96px Caveat";
    g.fillStyle = "#fffdf6";
    g.fillText("tracker", 640, 165);

    const r = rankOf(S.profile.points);
    let y = 640;
    if (kind === "checkin") {
      if (photoUrl) {
        const img = await new Promise((res) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => res(null);
          i.src = photoUrl;
        });
        if (img) {
          const box = [120, 520, 840, 700];
          const s = Math.max(box[2] / img.width, box[3] / img.height);
          g.save();
          g.beginPath();
          g.roundRect(box[0], box[1], box[2], box[3], 40);
          g.clip();
          g.drawImage(img, box[0] + (box[2] - img.width * s) / 2, box[1] + (box[3] - img.height * s) / 2, img.width * s, img.height * s);
          g.restore();
          g.lineWidth = 10;
          g.strokeStyle = "#141414";
          g.beginPath();
          g.roundRect(box[0], box[1], box[2], box[3], 40);
          g.stroke();
          y = 1300;
        }
      }
      // naklejka
      g.save();
      g.translate(W / 2, y);
      g.rotate(-0.06);
      g.fillStyle = "#1f9d4c";
      g.strokeStyle = "#141414";
      g.lineWidth = 8;
      g.beginPath();
      g.roundRect(-260, -70, 520, 120, 24);
      g.fill();
      g.stroke();
      g.fillStyle = "#fff";
      g.font = "900 72px Poppins";
      g.textAlign = "center";
      g.fillText("ODHACZONE ✓", 0, 15);
      g.restore();
      g.textAlign = "center";
      g.fillStyle = "#141414";
      g.font = "900 78px Poppins";
      wrap(g, p.name, W / 2, y + 160, 920, 86);
      g.font = "600 46px Poppins";
      g.fillStyle = "#4a4238";
      g.fillText(`${p.city ?? ""}${p.mualaDate ? " · lokal z MUALA" : ""}`, W / 2, y + 330);
    } else {
      g.textAlign = "center";
      g.font = "700 110px Caveat";
      g.fillStyle = "#d97c00";
      g.fillText("wpadaj na mapę!", W / 2, 640);
      g.font = "900 64px Poppins";
      g.fillStyle = "#141414";
      wrap(g, "Odhaczam lokale z odcinków Książula", W / 2, 800, 900, 78);
      g.font = "900 220px Poppins";
      g.fillText(String(S.checkins.filter((x) => x.status === "ok").length), W / 2, 1220);
      g.font = "600 52px Poppins";
      g.fillText("odhaczonych lokali", W / 2, 1300);
    }
    // ranga i link
    g.textAlign = "center";
    g.fillStyle = "#141414";
    g.beginPath();
    g.roundRect(120, 1560, 840, 230, 36);
    g.fill();
    g.fillStyle = "#fffdf6";
    g.font = "800 50px Poppins";
    g.fillText(`${r.emoji} ${r.name} · ${S.profile.points} pkt`, W / 2, 1650);
    g.fillStyle = "#f39200";
    g.font = "700 40px Poppins";
    g.fillText(`dołącz: @${S.profile.username} · ksiapulo tracker`, W / 2, 1730);
    return new Promise((res) => c.toBlob(res, "image/png"));
  }

  function wrap(g, text, x, y, max, lh) {
    const words = String(text).split(" ");
    let line = "";
    let lines = 0;
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (g.measureText(test).width > max && line) {
        g.fillText(line, x, y + lines * lh);
        line = w;
        if (++lines === 2) break;
      } else line = test;
    }
    if (lines < 3) g.fillText(line, x, y + lines * lh);
  }

  async function shareStory(kind, p, photoUrl) {
    const blob = await storyImage(kind, p, photoUrl);
    const file = new File([blob], "ksiapulo-story.png", { type: "image/png" });
    const url = shareUrl();
    try {
      await navigator.clipboard.writeText(url);
    } catch {}
    const text = kind === "checkin" ? `Odhaczone: ${p.name}! Dołącz do mnie na Ksiapulo Tracker` : "Odhaczam lokale z odcinków Książula — dołącz!";
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Ksiapulo Tracker", text: `${text} ${url}` });
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    const href = URL.createObjectURL(blob);
    openSheet(
      "Twoje story",
      `<img src="${href}" class="soc-story" alt="Grafika do story">
      <p class="soc-note">Zapisz grafikę i wrzuć na Instagram/TikTok. Twój link jest już skopiowany — dodaj go jako naklejkę „Link”:<br><b>${esc(url)}</b></p>
      <a class="btn btn--locate" href="${href}" download="ksiapulo-story.png">⬇ Zapisz grafikę</a>`,
    );
  }

  // ---------------------------------------------------------------- moderacja
  async function openAdmin() {
    const body = openSheet("Panel moderacji", `<p class="soc-note">Wczytuję…</p>`);
    const { data, error } = await S.sb.rpc("admin_queue");
    if (error) return (body.innerHTML = `<p class="soc-err">${esc(errText(error))}</p>`);
    const FLAGS = {
      slaby_gps: "słaby GPS",
      niemozliwa_predkosc: "niemożliwa prędkość między lokalami",
      za_duzo_dziennie: "ponad 10 odhaczeń na dobę",
      powtorzone_zdjecie: "to samo zdjęcie co ktoś inny",
      ai: "AI: podejrzane zdjęcie",
    };
    body.innerHTML = `<div class="soc-actions"><button type="button" class="btn js-sync">🔄 Wgraj lokale z mapy do bazy (${K.places.length})</button></div>
      <p class="soc-note js-sync-msg">Potrzebne po pierwszym uruchomieniu i po nowych odcinkach, jeśli GitHub nie robi tego sam.</p>
      <h3>Odhaczenia do sprawdzenia (${data.checkins.length})</h3>
      <ol class="adm">${data.checkins
        .map(
          (c) => `<li data-id="${c.id}"><img src="${esc(mediaUrl("checkins", c.photo_path))}" alt="">
          <div><b>@${esc(c.username)}</b> → ${esc(c.place_name)}, ${esc(c.place_city ?? "")}<br>
          <small>${(c.flags ?? []).map((f) => FLAGS[f] ?? f).join(", ")} · ${Math.round(c.distance_m)} m, GPS ±${Math.round(c.accuracy ?? 0)} m · ${ago(c.created_at)}</small>
          ${c.ai_note ? `<small class="adm__ai">AI: ${esc(c.ai_note)}</small>` : ""}
          <div class="soc-actions"><button type="button" class="btn btn--locate js-ok">Akceptuj</button><button type="button" class="btn btn--danger js-no">Odrzuć</button></div></div></li>`,
        )
        .join("") || '<li class="soc-note">Pusto 👌</li>'}</ol>
      <h3>Filmiki ukryte lub zgłoszone (${data.videos.length})</h3>
      <ol class="adm">${data.videos
        .map(
          (v) => `<li data-id="${v.id}" data-path="${esc(v.path)}" data-poster="${esc(v.poster_path ?? "")}">
          <video controls playsinline preload="none" poster="${esc(mediaUrl("videos", v.poster_path))}" src="${esc(mediaUrl("videos", v.path))}"></video>
          <div><b>@${esc(v.username)}</b> → ${esc(v.place_name)} · <i>${esc(v.status)}</i>, zgłoszeń: ${v.reports}<br>
          <small>${esc(v.caption)}</small><br><small>${(v.reasons ?? []).map(esc).join(" · ")}</small>
          ${v.ai_note ? `<small class="adm__ai">AI: ${esc(v.ai_note)}</small>` : ""}
          <div class="soc-actions"><button type="button" class="btn btn--locate js-show">Przywróć</button><button type="button" class="btn btn--danger js-remove">Usuń</button>
          <button type="button" class="btn js-ban" data-user="${esc(v.username)}">Zbanuj @${esc(v.username)}</button></div></div></li>`,
        )
        .join("") || '<li class="soc-note">Pusto 👌</li>'}</ol>`;
    body.querySelector(".js-sync").onclick = () => syncPlaces(body.querySelector(".js-sync-msg"));
    body.onclick = async (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      let res;
      if (e.target.closest(".js-ok")) res = await S.sb.rpc("admin_checkin", { p_id: li.dataset.id, p_ok: true });
      else if (e.target.closest(".js-no")) res = await S.sb.rpc("admin_checkin", { p_id: li.dataset.id, p_ok: false });
      else if (e.target.closest(".js-show")) res = await S.sb.rpc("admin_video", { p_id: li.dataset.id, p_status: "visible" });
      else if (e.target.closest(".js-remove")) {
        res = await S.sb.rpc("admin_video", { p_id: li.dataset.id, p_status: "removed" });
        if (!res.error) await S.sb.storage.from("videos").remove([li.dataset.path, li.dataset.poster].filter(Boolean));
      } else if (e.target.closest(".js-ban")) {
        if (!confirm(`Zbanować @${e.target.dataset.user}? Wszystkie jego filmiki zostaną usunięte.`)) return;
        res = await S.sb.rpc("admin_ban", { p_username: e.target.dataset.user, p_ban: true });
      } else return;
      if (res.error) return alert(errText(res.error));
      li.remove();
    };
  }

  /** Lokale z mapy → tabela places (to samo co scripts/sync-places.mjs, ale z sesji admina). */
  async function syncPlaces(msg) {
    const rows = K.places.map((p) => ({
      id: p.id,
      name: p.name,
      city: p.city ?? null,
      lat: p.lat,
      lng: p.lng,
      approx: !!p.approx,
      category: p.category ?? null,
      muala: !!p.mualaDate,
      closed: !!p.closed,
      video_ids: [...new Set(p.visits.map((v) => v.videoId))],
      video_dates: [...new Set(p.visits.map((v) => v.date).filter(Boolean))],
    }));
    let done = 0;
    for (let i = 0; i < rows.length; i += 250) {
      msg.textContent = `Wgrywam… ${done}/${rows.length}`;
      const { data, error } = await S.sb.rpc("admin_sync_places", { p_rows: rows.slice(i, i + 250) });
      if (error) return (msg.textContent = `Błąd: ${errText(error)}`);
      done += data;
    }
    msg.textContent = `Gotowe: ${done} lokali w bazie.`;
  }

  // ---------------------------------------------------------------- start
  async function boot() {
    if (!ON) {
      renderView();
      return;
    }
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = SB_SRC;
      s.onload = res;
      s.onerror = rej;
      document.head.append(s);
    });
    S.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    S.sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") loadMe();
    });
    K.on("data", () => S.view !== "mapa" && renderView());
    if (IS_APP) listenForLoginLink();
    await loadMe();
  }

  /** Aplikacja: link z maila otwiera ksiapulo://auth#access_token=… (albo ?code=… przy PKCE). */
  function listenForLoginLink() {
    const App = window.Capacitor?.Plugins?.App;
    if (!App) return;
    const handle = async (url) => {
      if (!url?.startsWith("ksiapulo://")) return;
      const q = new URLSearchParams(url.split("#")[1] || url.split("?")[1] || "");
      let error = null;
      if (q.get("access_token") && q.get("refresh_token")) {
        ({ error } = await S.sb.auth.setSession({ access_token: q.get("access_token"), refresh_token: q.get("refresh_token") }));
      } else if (q.get("code")) {
        ({ error } = await S.sb.auth.exchangeCodeForSession(q.get("code")));
      } else if (q.get("error_description")) {
        error = { message: q.get("error_description") };
      } else return;
      if (error) {
        openSheet("Logowanie", `<p class="soc-err">Link nie zadziałał: ${esc(/expired|invalid/i.test(errText(error)) ? "wygasł albo był już użyty. Poproś o nowy." : errText(error))}</p>`);
        return;
      }
      closeSheet();
      await loadMe();
    };
    App.addListener("appUrlOpen", (e) => handle(e.url));
    App.getLaunchUrl?.().then((r) => handle(r?.url)).catch(() => {});
  }

  boot().catch(() => {
    $("meChip").hidden = true;
  });
})();
