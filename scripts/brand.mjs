// Logo Ksiapulo Tracker: pinezka z ptaszkiem "odhaczone" pod kapiącym sosem.
// Jedno źródło (SVG) → ikony strony, ikona i ekran startowy aplikacji iOS.
//
//   node scripts/brand.mjs        (potrzebuje: npm i --no-save @resvg/resvg-js)
import { mkdir, writeFile } from "node:fs/promises";

const C = { orange: "#f39200", deep: "#d97c00", cream: "#fff4e2", sauce: "#fffdf6", ink: "#141414", plus: "#1f9d4c" };

/** Sama grafika (pinezka + sos) na płótnie 1024×1024. */
function mark({ drips = true } = {}) {
  const pin = "M512 930 C 405 800 250 660 250 472 A262 262 0 1 1 774 472 C 774 660 619 800 512 930 Z";
  const drip = (x, w, bottom) =>
    `<rect x="${x}" y="0" width="${w}" height="${bottom - w / 2}" fill="${C.orange}"/><circle cx="${x + w / 2}" cy="${bottom - w / 2}" r="${w / 2}" fill="${C.orange}"/>`;
  return `
    ${drips ? `<rect width="1024" height="236" fill="${C.orange}"/>
    ${drip(70, 120, 440)}${drip(262, 84, 330)}${drip(690, 92, 360)}${drip(838, 124, 480)}` : ""}
    <path d="${pin}" transform="translate(22 22)" fill="${C.ink}"/>
    <path d="${pin}" fill="${C.orange}" stroke="${C.ink}" stroke-width="38" stroke-linejoin="round"/>
    <circle cx="512" cy="472" r="168" fill="${C.sauce}" stroke="${C.ink}" stroke-width="30"/>
    <path d="M436 480 L496 538 L592 420" fill="none" stroke="${C.ink}" stroke-width="82" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M436 480 L496 538 L592 420" fill="none" stroke="${C.plus}" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>`;
}

export const iconSvg = (bg = C.cream) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${bg}"/>${mark()}</svg>`;

/** Wersja "maskable" (Android/PWA): grafika zmniejszona do bezpiecznego koła. */
const maskableSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${C.cream}"/>
   <rect width="1024" height="300" fill="${C.orange}"/><g transform="translate(153 170) scale(0.7)">${mark({ drips: false })}</g></svg>`;

/** Ekran startowy 2732×2732: logo + napis, centralnie (iOS przycina boki). */
const splashSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2732 2732"><rect width="2732" height="2732" fill="${C.cream}"/>
   <g transform="translate(966 760) scale(0.78)">${mark({ drips: false })}</g>
   <text x="1366" y="1720" text-anchor="middle" font-family="Arial Black" font-size="200" fill="${C.ink}" letter-spacing="6">KSIAPULO</text>
   <text x="1366" y="1830" text-anchor="middle" font-family="Arial Black" font-size="72" fill="${C.deep}" letter-spacing="34">TRACKER</text></svg>`;

const render = async (svg, size) => {
  const { Resvg } = await import("@resvg/resvg-js");
  return new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { fontFiles: ["C:/Windows/Fonts/ariblk.ttf"], loadSystemFonts: false, defaultFontFamily: "Arial Black" },
  })
    .render()
    .asPng();
};

const root = new URL("../", import.meta.url);
await mkdir(new URL("resources/", root), { recursive: true });
const out = {
  "assets/icons/logo.svg": iconSvg(),
  // sama pinezka (bez tła) do nagłówka strony
  "assets/icons/pin.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="228 188 590 790">${mark({ drips: false })}</svg>`,
  "assets/icons/icon-192.png": [iconSvg(), 192],
  "assets/icons/icon-512.png": [iconSvg(), 512],
  "assets/icons/icon-maskable-512.png": [maskableSvg(), 512],
  "assets/icons/apple-touch-icon.png": [iconSvg(), 180],
  // dla @capacitor/assets (ikona i ekran startowy aplikacji iOS)
  "resources/icon-only.png": [iconSvg(), 1024],
  "resources/splash.png": [splashSvg(), 2732],
  "resources/splash-dark.png": [splashSvg(), 2732],
};
for (const [file, v] of Object.entries(out)) {
  await writeFile(new URL(file, root), typeof v === "string" ? v : await render(...v));
  console.log("✓", file);
}
