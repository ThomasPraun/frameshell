// TEMPORARY (#109 diagnosis, reverted before merge): does killing a ConPTY right after spawn hang the killing thread?
// Parent: runs N children with a watchdog. Child: spawns PowerShell like the app, kills it after <delay> ms, exits.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const [mode, arg] = process.argv.slice(2);
if (mode === "child") {
  const pty = createRequire(import.meta.url)("node-pty");
  const delay = Number(arg);
  const started = Date.now();
  const proc = pty.spawn("powershell.exe", ["-NoLogo"], { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  let firstData = -1;
  proc.onData(() => {
    if (firstData < 0) firstData = Date.now() - started;
  });
  setTimeout(() => {
    const t = Date.now();
    proc.kill();
    process.stdout.write(`killed after ${delay} ms (first data ${firstData} ms), kill() took ${Date.now() - t} ms\n`);
    process.exit(0);
  }, delay);
} else {
  const n = Number(mode ?? 40);
  let hung = 0;
  for (let i = 0; i < n; i++) {
    const delay = [0, 20, 50, 100, 150, 250, 400, 800][i % 8];
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "child", String(delay)], { encoding: "utf8", timeout: 20_000 });
    const verdict = r.error ? `HUNG (${r.error.message}) stdout=${JSON.stringify(r.stdout)}` : r.stdout.trim() || `exit ${r.status} ${r.stderr.slice(0, 300)}`;
    if (r.error) hung++;
    console.log(`[${i}] delay ${delay}: ${verdict}`);
  }
  console.log(`hung ${hung}/${n}`);
}
