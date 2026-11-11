// Efekty: konfetti, liczniki, wibracje, szkielety ładowania. Wszystko opcjonalne —
// przy "ogranicz ruch" w systemie animacje są pomijane, a strona działa bez tego pliku.
(() => {
  "use strict";

  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const COLORS = ["#f39200", "#d97c00", "#1f9d4c", "#fffdf6", "#141414", "#ffc928", "#e3301f"];

  /** Konfetti w kolorach marki. Rysowane w otwartym oknie (dialog), żeby było nad nim. */
  function confetti({ count = 130, duration = 2200 } = {}) {
    if (calm()) return;
    const host = document.querySelector("dialog[open]") ?? document.body;
    const c = document.createElement("canvas");
    c.className = "fx-confetti";
    host.append(c);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = (c.width = innerWidth * dpr);
    const H = (c.height = innerHeight * dpr);
    const g = c.getContext("2d");
    const bits = Array.from({ length: count }, (_, i) => {
      // dwie "armaty" z dolnych rogów, strzał w górę do środka
      const left = i % 2 === 0;
      const angle = (left ? -Math.PI / 3 : (-2 * Math.PI) / 3) + (Math.random() - 0.5) * 0.9;
      const speed = (9 + Math.random() * 13) * dpr;
      return {
        x: left ? 0 : W,
        y: H * 0.92,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 1.35,
        w: (6 + Math.random() * 7) * dpr,
        h: (4 + Math.random() * 5) * dpr,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        color: COLORS[i % COLORS.length],
        round: Math.random() < 0.25,
      };
    });
    const t0 = performance.now();
    (function frame(t) {
      const k = (t - t0) / duration;
      if (k >= 1 || !c.isConnected) return c.remove();
      g.clearRect(0, 0, W, H);
      g.globalAlpha = k > 0.75 ? (1 - k) * 4 : 1;
      for (const b of bits) {
        b.vy += 0.42 * dpr;
        b.vx *= 0.992;
        b.x += b.vx;
        b.y += b.vy;
        b.rot += b.vr;
        g.save();
        g.translate(b.x, b.y);
        g.rotate(b.rot);
        g.fillStyle = b.color;
        if (b.round) {
          g.beginPath();
          g.arc(0, 0, b.h / 1.4, 0, Math.PI * 2);
          g.fill();
        } else g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.rot * 2)) + 1);
        g.restore();
      }
      requestAnimationFrame(frame);
    })(t0);
  }

  /** Liczba "nabija się" od zera. Element musi zawierać samą liczbę. */
  function countUp(el, ms = 900) {
    const target = parseInt(el.textContent.replace(/\D/g, ""), 10);
    if (!Number.isFinite(target) || calm() || target === 0) return;
    const t0 = performance.now();
    (function tick(t) {
      const k = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(target * eased).toLocaleString("pl-PL");
      if (k < 1 && el.isConnected) requestAnimationFrame(tick);
    })(t0);
  }

  /** Krótka wibracja (Android; iPhone po cichu ignoruje). */
  const buzz = (pattern = 12) => {
    try {
      navigator.vibrate?.(pattern);
    } catch {}
  };

  /** Szare "kości" zamiast napisu Wczytuję… */
  const skeleton = (n = 3, kind = "row") =>
    Array.from({ length: n }, () => `<li class="fx-skel fx-skel--${kind}" aria-hidden="true"><i></i><i></i></li>`).join("");

  /** Jednorazowo odtwórz animację CSS przez klasę (np. kostka przy losowaniu). */
  function play(el, cls, ms = 600) {
    if (!el || calm()) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }

  // Lekka wibracja przy stuknięciu w główne przyciski
  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest(".btn, .chip, .tabs button, .seg button, .feed__react")) buzz(8);
    },
    { passive: true },
  );

  // Easter egg: 5 szybkich stuknięć w logo
  let taps = 0;
  let tapTimer;
  document.querySelector(".logo")?.addEventListener("click", (e) => {
    e.preventDefault();
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => (taps = 0), 1200);
    if (++taps < 5) {
      if (taps === 1) document.getElementById("panel")?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    taps = 0;
    confetti({ count: 220, duration: 2800 });
    buzz([30, 40, 30, 40, 80]);
    const el = document.createElement("div");
    el.className = "fx-muala";
    el.textContent = "MUALA!";
    document.body.append(el);
    setTimeout(() => el.remove(), 1900);
  });

  window.KsiapuloFx = { confetti, countUp, buzz, skeleton, play, calm };
})();
