import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const CHANNEL_ID = "UCqJuMiGXqB8Hl41YsGV_sMA";
export const CHANNEL_URL = "https://www.youtube.com/@ksiazulo";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

/** Ostatnie ~15 filmów z kanału RSS (nie wymaga klucza API). */
export async function fetchFeed(channelId = CHANNEL_ID) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: { "User-Agent": UA, "Accept-Language": "pl" },
  });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: e.match(/<yt:videoId>([^<]+)/)[1],
    title: decode(e.match(/<title>([^<]*)/)[1]),
    date: e.match(/<published>([^<]+)/)[1],
    description: decode(e.match(/<media:description>([^<]*)/)?.[1] ?? ""),
  }));
}

// yt-dlp: w GitHub Actions jest jako komenda, lokalnie często tylko jako moduł Pythona.
let ytdlpCmd;
async function ytdlp(args, opts = {}) {
  const candidates = process.env.YTDLP
    ? [[process.env.YTDLP, []]]
    : [["yt-dlp", []], ["python", ["-m", "yt_dlp"]], ["python3", ["-m", "yt_dlp"]]];
  const extra = ["--extractor-args", "youtube:lang=pl", "--no-warnings"];
  if (process.env.YT_COOKIES_FILE) extra.push("--cookies", process.env.YT_COOKIES_FILE);
  for (const [cmd, pre] of ytdlpCmd ? [ytdlpCmd] : candidates) {
    try {
      const out = await run(cmd, [...pre, ...extra, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });
      ytdlpCmd = [cmd, pre];
      return out.stdout;
    } catch (err) {
      if (err.code === "ENOENT" || /No module named/.test(err.stderr ?? "")) continue;
      throw err;
    }
  }
  throw new Error("Nie znaleziono yt-dlp (pip install yt-dlp)");
}

/** Pełna lista filmów kanału — do jednorazowego uzupełnienia historii (--backfill). */
export async function listAllVideos() {
  const out = await ytdlp(["--flat-playlist", "--print", "%(id)s\t%(duration)s\t%(title)s", `${CHANNEL_URL}/videos`]);
  return out
    .trim()
    .split("\n")
    .map((l) => l.split("\t"))
    .map(([id, duration, title]) => ({ id, duration: Number(duration) || 0, title }));
}

/** Opis + data + długość filmu. Najpierw yt-dlp, awaryjnie strona /watch. */
export async function fetchVideoMeta(id) {
  try {
    const out = await ytdlp(["-J", "--skip-download", `https://www.youtube.com/watch?v=${id}`]);
    const j = JSON.parse(out);
    return {
      id,
      title: j.title,
      description: j.description ?? "",
      duration: j.duration ?? 0,
      date: j.timestamp ? new Date(j.timestamp * 1000).toISOString() : null,
    };
  } catch {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${id}&hl=pl`, { headers: { "User-Agent": UA } })).text();
    const desc = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1];
    const len = html.match(/"lengthSeconds":"(\d+)"/)?.[1];
    return {
      id,
      title: decode(html.match(/<meta name="title" content="([^"]*)"/)?.[1] ?? ""),
      description: desc ? JSON.parse(`"${desc}"`) : "",
      duration: Number(len) || 0,
      date: html.match(/"uploadDate":"([^"]+)"/)?.[1] ?? null,
    };
  }
}

/** Rozdziały z opisu, np. "04:15 - 09:50 CHILLI CHILL KEBAB" albo "04:15 HARIS KEBAB". */
export function parseChapters(description) {
  const ts = "(\\d{1,2}:\\d{2}(?::\\d{2})?)";
  const re = new RegExp(`^\\s*${ts}(?:\\s*[-–—]\\s*${ts})?\\s*[-–—:]?\\s*(.+)$`);
  const toSec = (t) => t.split(":").reduce((a, n) => a * 60 + Number(n), 0);
  return description
    .split("\n")
    .map((l) => l.match(re))
    .filter(Boolean)
    .map((m) => ({ start: toSec(m[1]), title: m[3].trim() }));
}

/** Automatyczne napisy PL jako tekst ze znacznikami [mm:ss] co ~20 s. */
export async function fetchTranscript(id) {
  const dir = await mkdtemp(path.join(tmpdir(), "ksz-"));
  try {
    await ytdlp([
      "--skip-download",
      "--write-auto-subs",
      "--write-subs",
      "--sub-langs",
      "pl,pl-orig",
      "--sub-format",
      "vtt",
      "-o",
      path.join(dir, "%(id)s.%(ext)s"),
      `https://www.youtube.com/watch?v=${id}`,
    ]);
    const file = (await readdir(dir)).find((f) => f.endsWith(".vtt"));
    if (!file) return null;
    return vttToText(await readFile(path.join(dir, file), "utf8"));
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function vttToText(vtt) {
  const lines = [];
  const seen = new Set();
  let t = 0;
  for (const raw of vtt.split("\n")) {
    const time = raw.match(/^(\d{2}):(\d{2}):(\d{2})\.\d{3} -->/);
    if (time) {
      t = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
      continue;
    }
    const text = raw.replace(/<[^>]+>/g, "").trim();
    if (!text || /^(WEBVTT|Kind:|Language:)/.test(text) || seen.has(text)) continue;
    seen.add(text);
    lines.push({ t, text });
  }
  let out = "";
  let lastMark = -Infinity;
  for (const { t, text } of lines) {
    if (t - lastMark >= 20) {
      out += `\n[${fmt(t)}] `;
      lastMark = t;
    }
    out += text + " ";
  }
  return out.trim();
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
