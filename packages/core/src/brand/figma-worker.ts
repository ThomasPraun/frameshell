// Worker thread of `readFigmaFolderInWorker` (figma.ts): reads and sanitises one Figma folder off the daemon's event loop.
import { serveWorkerTask } from "../worker-task.js";
import { type FigmaLimits, readFigmaFolder } from "./figma.js";

await serveWorkerTask(async ({ dir, limits }: { dir: string; limits: FigmaLimits }) => readFigmaFolder(dir, limits));
