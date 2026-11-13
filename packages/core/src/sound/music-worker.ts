// Worker thread of `sound.music`: one track rendered off the daemon's event loop (a minute of music is a few seconds of work).
import { serveWorkerTask } from "../worker-task.js";
import { type MusicSpec, synthesizeMusic } from "./music.js";

await serveWorkerTask(async (spec: MusicSpec) => synthesizeMusic(spec));
