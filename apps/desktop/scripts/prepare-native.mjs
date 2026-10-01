// Postinstall: make Electron and node-pty usable.
// - Electron >= 44 has no postinstall: `require("electron")` downloads the binary on first use.
//   Playwright requires it, but `electron-vite preview`/`dev` only read `path.txt` and fail with
//   "Electron uninstall" on a fresh clone. Require it here so the binary exists after install.
// - node-pty >= 1.0 is N-API: one binary serves Node and Electron, so no electron-rebuild.
//   macOS/Windows use its prebuilds; Linux compiles with node-gyp during install.
// - node-pty 1.1.0 ships `spawn-helper` without the exec bit, so every spawn on macOS
//   fails with "posix_spawnp failed". Restore it.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
require("electron");

if (process.platform !== "win32") {
  const root = dirname(require.resolve("node-pty/package.json"));
  const candidates = [join(root, "build", "Release", "spawn-helper")];
  const prebuilds = join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) candidates.push(join(prebuilds, dir, "spawn-helper"));
  }
  for (const file of candidates) {
    if (existsSync(file)) chmodSync(file, 0o755);
  }
}
