// PROTOTYPE. Runs each technique in its own Electron process (sequentially, so they never
// compete for the decoder), then analyzes. Usage: node scripts/run-all.mjs [--cuts=N] [A1 A2 B B-bufsrc]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadavg } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const args = process.argv.slice(2);
const cuts = args.find((a) => a.startsWith('--cuts=')) ?? '';
// Run ids: A1, A2, B (audio via worklet), B-bufsrc (audio via one AudioBufferSourceNode per segment).
const runs = args.filter((a) => !a.startsWith('--'));
for (const id of runs.length ? runs : ['A1', 'A2', 'B', 'B-bufsrc']) {
  const [t, audio = 'worklet'] = id.split('-');
  console.log(`== ${id} (load avg before: ${loadavg().map((x) => x.toFixed(2)).join(' ')})`);
  const r = spawnSync(electron, [root, `--technique=${t}`, `--audio=${audio}`, ...(cuts ? [cuts] : [])], { stdio: 'inherit' });
  if (r.status !== 0) console.error(`${id} exited with ${r.status}`);
}
spawnSync(process.execPath, [join(root, 'scripts', 'analyze.mjs'), ...runs], { stdio: 'inherit' });
