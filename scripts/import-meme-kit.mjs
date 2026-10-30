// Copies the usable parts of the meme kit (photos, GIF clips, sounds, green-screen clips) into
// public/meme-kit and writes an index for the in-app picker, each item tagged with categories.
// Green-screen clips are trimmed and re-encoded by ffmpeg (see greenscreen below). The source
// folder is only read, never changed.
// Usage: node scripts/import-meme-kit.mjs [path-to-meme-kit]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.argv[2] ?? path.join(os.homedir(), "Desktop", "meme-kit");
const out = path.resolve("public", "meme-kit");
const items = [];
let bytes = 0;

const title = (stem) => stem.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
function copy(from, to) {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.copyFileSync(from, path.join(out, to));
  bytes += fs.statSync(from).size;
}
// The kit's catalog: mood, rating and description per item, keyed by its file path.
const catalog = new Map();
if (fs.existsSync(path.join(src, "catalog.json"))) {
  for (const c of JSON.parse(fs.readFileSync(path.join(src, "catalog.json"), "utf8")).items) {
    for (const p of [c.file, c.mp4, c.video].filter((p) => typeof p === "string")) catalog.set(p, c);
  }
}

/** Picker categories from the catalog's mood, plus Animals and Bollywood/Indian from the words. */
const MOODS = {
  Funny: ["laugh", "dumb", "cringe", "chaos", "fail", "dance"],
  Shocked: ["shock", "confusion", "suspicious", "warning"],
  Sad: ["sad", "pain", "ending"],
  Angry: ["angry", "disagree"],
  Wholesome: ["success", "proud", "hype", "cool", "agree", "calm", "romance"],
  Thinking: ["thinking", "smart", "waiting", "compare", "money"],
  "Sound effects": ["sfx", "intro"],
  Reactions: ["misc"],
};
function categories(rel, name) {
  const c = catalog.get(rel);
  const tags = Object.entries(MOODS).filter(([, moods]) => moods.includes(c?.mood)).map(([tag]) => tag);
  const words = `${name} ${c?.what ?? ""} ${c?.source ?? ""} ${rel}`.toLowerCase();
  if (/\b(cats?|dogs?|kitten|puppy|monkey|frog|capybara|hamster|goat|duck|bird|raccoon|toothless|seal|horse|cow|penguin|animal)\b/.test(words)) tags.push("Animals");
  if (/\b(bollywood|hindi|indian|india|desi|bhai|modi|paresh|rawal|akshay|salman|shah ?rukh|srk|amitabh|hera pheri|babu ?rao|carry ?minati|ipl|cricket|chai|jethalal|tmkoc|gujarati|punjabi|tamil|telugu)\b/.test(words)) tags.push("Bollywood/Indian");
  return tags.length ? tags : ["Other"];
}
const unwanted = (rel) => catalog.get(rel)?.rating === "never";
/** The rating given in the meme-kit dashboard (kept as it is; the picker sorts and filters by it). */
const rating = (rel) => catalog.get(rel)?.rating ?? catalog.get(rel)?.stars ?? null;

/** A sound's length and a 48-bar loudness outline (digits 0–9) for the picker's wave. */
function soundShape(file) {
  try {
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "2000", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024 });
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const bars = 48;
    const per = Math.max(1, Math.floor(samples.length / bars));
    const peaks = [];
    for (let b = 0; b < bars; b++) {
      let max = 0;
      for (let i = b * per; i < Math.min(samples.length, (b + 1) * per); i++) max = Math.max(max, Math.abs(samples[i]));
      peaks.push(max / 32768);
    }
    const top = Math.max(...peaks, 0.01);
    return { duration: Math.round((samples.length / 2000) * 10) / 10, wave: peaks.map((p) => Math.round((p / top) * 9)).join("") };
  } catch {
    return {};
  }
}

const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()) : []);

// Photos (named in meta/photos.json when available).
const photoMeta = fs.existsSync(path.join(src, "meta/photos.json")) ? JSON.parse(fs.readFileSync(path.join(src, "meta/photos.json"), "utf8")) : {};
for (const f of files(path.join(src, "photos")).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))) {
  const stem = path.basename(f).replace(/\.\w+$/, "");
  const rel = `photos/${path.basename(f)}`;
  if (unwanted(rel)) continue;
  const name = photoMeta[stem]?.name ?? title(stem);
  copy(f, rel);
  items.push({ id: `photo:${stem}`, kind: "photo", name, file: rel, tags: categories(rel, name), rating: rating(rel) });
}

// GIF clips: looping mp4s with a jpg poster.
for (const f of files(path.join(src, "gifs")).filter((f) => /\.mp4$/i.test(f))) {
  const stem = path.basename(f, ".mp4");
  const rel = `gifs/${stem}.mp4`;
  if (unwanted(rel)) continue;
  const poster = path.join(path.dirname(f), `${stem}.jpg`);
  copy(f, rel);
  if (fs.existsSync(poster)) copy(poster, `gifs/${stem}.jpg`);
  const name = title(stem);
  items.push({ id: `gif:${stem}`, kind: "gif", name, file: rel, thumb: fs.existsSync(poster) ? `gifs/${stem}.jpg` : null, tags: categories(rel, name), rating: rating(rel) });
}

// Sounds: the loudness-levelled versions when the kit has them.
const levelled = path.join(src, "leveled", "sounds");
const soundDir = fs.existsSync(levelled) ? levelled : path.join(src, "sounds");
for (const f of files(soundDir).filter((f) => /\.(mp3|m4a|ogg|wav)$/i.test(f))) {
  const stem = path.basename(f).replace(/\.\w+$/, "");
  const rel = path.relative(soundDir, f);
  if (unwanted(`sounds/${rel}`)) continue;
  copy(f, `sounds/${rel}`);
  const name = title(stem);
  items.push({ id: `sound:${rel}`, kind: "sound", name, file: `sounds/${rel}`, group: path.dirname(rel) === "." ? null : path.dirname(rel), tags: categories(`sounds/${rel}`, name), rating: rating(`sounds/${rel}`) ?? rating(path.relative(src, f)), ...soundShape(f) });
}

// Green-screen clips, cut to their punchline (at most 6 s), 360p, with their sound.
// Keyed clips (VP9 with alpha) become "stacked alpha" H.264: the picture on top, its alpha as grey
// underneath. One file that plays on Android and the Mac alike; the page draws it see-through
// with a small WebGL shader (AlphaVideo in attachments.tsx). Clips that aren't keyed stay normal clips.
const ffmpeg = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
const fresh = (outFile, from) => fs.existsSync(outFile) && fs.statSync(outFile).mtimeMs > fs.statSync(from).mtimeMs;
for (const c of [...new Set(catalog.values())].filter((c) => c.type === "greenscreen" && c.rating !== "never" && c.video)) {
  const video = path.join(src, c.video);
  if (!fs.existsSync(video)) continue;
  const [from, to] = c.punch ? [Math.max(0, c.punch[0] - 0.3), Math.min(c.punch[1], c.punch[0] + 6)] : [c.start ?? 0, (c.start ?? 0) + Math.min(c.usable ?? c.dur ?? 6, 6)];
  const cut = ["-ss", String(from), "-t", String(Math.max(0.5, to - from))];
  const audio = c.audio && fs.existsSync(path.join(src, c.audio)) ? [...cut, "-i", path.join(src, c.audio)] : [];
  const rel = `greenscreen/${c.id}.mp4`;
  const thumb = `greenscreen/${c.id}.jpg`;
  const target = path.join(out, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fresh(target, video)) {
    const keyed = c.alpha
      ? ["-filter_complex", "[0:v]fps=24,scale=-2:360:flags=lanczos,format=yuva420p,split=2[c][m];[m]alphaextract,format=yuv420p[mask];[c]format=yuv420p[col];[col][mask]vstack=inputs=2[v]", "-map", "[v]"]
      : ["-vf", "fps=24,scale=-2:360:flags=lanczos", "-map", "0:v"];
    ffmpeg([...cut, ...(c.alpha ? ["-c:v", "libvpx-vp9"] : []), "-i", video, ...audio, ...keyed, ...(audio.length ? ["-map", "1:a"] : []),
      "-c:v", "libx264", "-crf", "30", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "64k", "-ac", "1", target]);
    // Poster: the middle frame over dark grey.
    ffmpeg(["-ss", String((from + to) / 2), ...(c.alpha ? ["-c:v", "libvpx-vp9"] : []), "-i", video, "-filter_complex",
      "[0:v]scale=-2:200,format=rgba[f];color=c=0x2b2b2b:s=16x16[bg];[bg][f]scale2ref[b][f2];[b][f2]overlay=format=auto", "-frames:v", "1", path.join(out, thumb)]);
  }
  bytes += fs.statSync(target).size;
  const name = title(c.id);
  items.push({ id: `greenscreen:${c.id}`, kind: c.alpha ? "greenscreen" : "gif", name, file: rel, thumb, tags: [c.alpha ? "Green screen" : "Clips", ...categories(c.video, name)], sound: audio.length > 0, rating: c.rating ?? null });
}

fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(items));
console.log(`${items.length} items, ${(bytes / 1024 / 1024).toFixed(1)} MB → ${out}`);
