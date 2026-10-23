// Worker thread of `clusterFacesOffThread` (face-clusters.ts): the linkage of one project's track prints.
import { serveWorkerTask } from "../worker-task.js";
import type { ClusterRequest } from "./face-clusters.js";
import { averageLinkage } from "./vector.js";

await serveWorkerTask(async ({ vectors, threshold }: ClusterRequest) => averageLinkage(vectors, { threshold }));
