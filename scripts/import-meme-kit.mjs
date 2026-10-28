// Copies the usable parts of the meme kit (photos, GIF clips, sounds) into public/meme-kit and
// writes an index for the in-app picker. The source folder is only read, never changed.
// Usage: node scripts/import-meme-kit.mjs [path-to-meme-kit]
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
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()) : []);

// Photos (named in meta/photos.json when available).
const photoMeta = fs.existsSync(path.join(src, "meta/photos.json")) ? JSON.parse(fs.readFileSync(path.join(src, "meta/photos.json"), "utf8")) : {};
for (const f of files(path.join(src, "photos")).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))) {
  const stem = path.basename(f).replace(/\.\w+$/, "");
  copy(f, `photos/${path.basename(f)}`);
  items.push({ id: `photo:${stem}`, kind: "photo", name: photoMeta[stem]?.name ?? title(stem), file: `photos/${path.basename(f)}` });
}

// GIF clips: looping mp4s with a jpg poster.
for (const f of files(path.join(src, "gifs")).filter((f) => /\.mp4$/i.test(f))) {
  const stem = path.basename(f, ".mp4");
  const poster = path.join(path.dirname(f), `${stem}.jpg`);
  copy(f, `gifs/${stem}.mp4`);
  if (fs.existsSync(poster)) copy(poster, `gifs/${stem}.jpg`);
  items.push({ id: `gif:${stem}`, kind: "gif", name: title(stem), file: `gifs/${stem}.mp4`, thumb: fs.existsSync(poster) ? `gifs/${stem}.jpg` : null });
}

// Sounds: the loudness-levelled versions when the kit has them.
const levelled = path.join(src, "leveled", "sounds");
const soundDir = fs.existsSync(levelled) ? levelled : path.join(src, "sounds");
for (const f of files(soundDir).filter((f) => /\.(mp3|m4a|ogg|wav)$/i.test(f))) {
  const stem = path.basename(f).replace(/\.\w+$/, "");
  const rel = path.relative(soundDir, f);
  copy(f, `sounds/${rel}`);
  items.push({ id: `sound:${rel}`, kind: "sound", name: title(stem), file: `sounds/${rel}`, group: path.dirname(rel) === "." ? null : path.dirname(rel) });
}

fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(items));
console.log(`${items.length} items, ${(bytes / 1024 / 1024).toFixed(1)} MB → ${out}`);
