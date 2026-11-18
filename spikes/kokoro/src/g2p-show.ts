// Prints the phonemes and token counts of every test line (and the characters the vocabulary drops).
// Usage: node src/g2p-show.ts [--castilian] [--no-allophones] [--lleismo]
import { OOV, g2pEn } from "./g2p-en.ts";
import { g2pEs } from "./g2p-es.ts";
import { tokenize } from "./kokoro.ts";
import { QUALITY, SPEED, spoken } from "./lines.ts";

const args = new Set(process.argv.slice(2));
const es = { seseo: !args.has("--castilian"), allophones: !args.has("--no-allophones"), yeismo: !args.has("--lleismo") };
for (const line of [...QUALITY, ...SPEED]) {
  const text = spoken(line);
  const ps = line.lang === "es" ? g2pEs(text, es) : g2pEn(text);
  const { ids, dropped } = tokenize(ps);
  console.log(`${line.id}  ${ids.length} tokens${dropped.length ? `  dropped ${JSON.stringify(dropped.join(""))}` : ""}`);
  console.log(`  ${text}`);
  console.log(`  ${ps}`);
}
console.log(`English words read by the letter fallback: ${[...OOV].join(", ") || "none"}`);
