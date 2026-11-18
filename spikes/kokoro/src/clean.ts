// Deletes WORK_DIR: downloaded weights, voices, dictionary, whisper.cpp + its model, every WAV.
import { rm } from "node:fs/promises";
import { WORK_DIR } from "./paths.ts";

await rm(WORK_DIR, { recursive: true, force: true });
console.log(`removed ${WORK_DIR}`);
