// Utility process entry: spawns frameshelld for the main process, then exits. See `daemon-launcher.ts` for why.
import { serveDaemonSpawner } from "./daemon-launcher.js";

serveDaemonSpawner(process.parentPort, () => process.exit(0));
