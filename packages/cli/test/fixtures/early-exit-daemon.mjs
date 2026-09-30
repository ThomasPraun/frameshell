// Stand-in daemon entry for daemon-client tests; each start leaves a file in FAKE_DAEMON_STARTS_DIR.
// The first FAKE_DAEMON_EARLY_EXITS starts exit 0 without listening: what the client sees when
// frameshelld idle-exits before its first client reaches it. Later starts run the real frameshelld.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.FAKE_DAEMON_STARTS_DIR;
const start = readdirSync(dir).length;
writeFileSync(join(dir, `start-${start}-${process.pid}`), "");
if (start < Number(process.env.FAKE_DAEMON_EARLY_EXITS ?? "0")) process.exit(0);
await import(fileURLToPath(import.meta.resolve("@frameshell/core/frameshelld")));
