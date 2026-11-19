// Downloads the CC0 tracks of the real-music check (#689) from the Internet Archive into a directory OUTSIDE the repo
// and writes manifest.json. Each item's metadata is read first: an item whose licenseurl is not CC0 is refused.
// The expected tempo is the one the artist put in the title ("(120 bpm)"): a tempo label, no beat times.
//
//   FRAMESHELL_BEATS_MUSIC_DIR=<dir outside the repo> node fetch-cc0.mjs
//
// Delete the directory afterwards; nothing here is committed.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outsideRepo } from "./lib.mjs";

const dirArg = process.argv[2] ?? process.env.FRAMESHELL_BEATS_MUSIC_DIR;
if (!dirArg) {
  console.error("usage: FRAMESHELL_BEATS_MUSIC_DIR=<dir> node fetch-cc0.mjs");
  process.exit(2);
}
const dir = outsideRepo(dirArg);
mkdirSync(dir, { recursive: true });

const CC0 = "http://creativecommons.org/publicdomain/zero/1.0/";
/** [item identifier, bpm in the title]. Mostly Dante Ross (hip-hop, funk, game and library cues); one other beat. */
const ITEMS = [
  ["TheSetUp75Bpm", 75],
  ["TentPole75Bpm", 75],
  ["LateNight80Bpm", 80],
  ["Dreamt_772", 80],
  ["TheLurk86Bpm", 86],
  ["AnacondaMaltLiquor90Bpm", 90],
  ["SecretBoss90Bpm", 90],
  ["SnazzyBitch95Bpm", 95],
  ["FRESH-Hip-Hop-Beat", 95],
  ["CoolUncle100Bpm", 100],
  ["UkeJoint100Bpm", 100],
  ["SlowSpeedChase110Bpm", 110],
  ["Gaslight120Bpm", 120],
  ["Broke120Bpm", 120],
  ["EverybodyGetShot130Bpm", 130],
  ["CodeBreaker130Bpm", 130],
  ["FromTheTop180Bpm", 180],
];

const tracks = [];
for (const [id, bpm] of ITEMS) {
  const meta = await (await fetch(`https://archive.org/metadata/${id}`)).json();
  if (meta.metadata?.licenseurl !== CC0) {
    console.error(`skip ${id}: licenseurl is ${meta.metadata?.licenseurl}, not CC0`);
    continue;
  }
  const mp3 = (meta.files ?? []).find((file) => file.format === "VBR MP3");
  if (!mp3) {
    console.error(`skip ${id}: no mp3 derivative`);
    continue;
  }
  const file = `cc0-${id}.mp3`;
  if (!existsSync(join(dir, file)) || statSync(join(dir, file)).size !== Number(mp3.size)) {
    const response = await fetch(`https://archive.org/download/${id}/${encodeURIComponent(mp3.name)}`);
    if (!response.ok) {
      console.error(`skip ${id}: HTTP ${response.status}`);
      continue;
    }
    writeFileSync(join(dir, file), Buffer.from(await response.arrayBuffer()));
  }
  tracks.push({
    file,
    group: "cc0",
    bpm,
    source: `https://archive.org/details/${id}`,
    licence: `CC0 1.0 (${CC0}), creator ${meta.metadata.creator}`,
    note: `title: ${meta.metadata.title}`,
  });
  console.log("ok", file, Math.round(Number(mp3.size) / 1e5) / 10, "MB");
}
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tracks }, null, 2));
console.log(`wrote ${tracks.length} tracks to ${dir}`);
