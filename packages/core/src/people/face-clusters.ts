// Face clusters and who they are (ADR 0020 decision 4): tracks of every scanned video grouped by face print,
// then tied to people through their face anchors. Cluster ids are for display only; anchors are what persist.
import { createHash } from "node:crypto";
import type { Person } from "@frameshell/schema";
import type { FaceTrack, TrackBox } from "./scan.js";
import type { StoredFaceScan } from "./scan-cache.js";
import { type Span, mergeSpans } from "./ranges.js";
import { runWorkerTask } from "../worker-task.js";
import { averageLinkage, cosine, meanDirection } from "./vector.js";

/**
 * Lowest average similarity (cosine of track mean face prints, average
 * linkage) at which two groups of tracks are one face. OpenCV gives 0.363 as
 * SFace's same-person line for two single faces; a track mean averages out
 * pose and blur, so a stricter line costs little and keeps two people apart.
 * Placeholder until tuned on real recordings.
 */
export const FACE_CLUSTER_MATCH = 0.45;
/** Seconds of picture each face sample stands for on either side (samples are 0.5 s apart). */
export const FACE_SAMPLE_SPAN_S = 0.25;
/** An anchor names the face whose box holds its point in a sample at most this many seconds from it. */
export const FACE_ANCHOR_WINDOW_S = 0.5;

/** The face scan of one project video. */
export interface ScannedAsset {
  /** Project-relative path. */
  asset: string;
  scan: StoredFaceScan;
}

/** A face track of one asset, with its mean face print and its cluster. */
export interface ClusterTrack {
  asset: string;
  track: FaceTrack;
  /** `<asset>#<track id>`: unique in the project. */
  key: string;
  /** Normalized mean of its embeddings; null when it has none (faces under 32 px): such a track joins no cluster. */
  mean: Float32Array | null;
  /** Id of its cluster, or null without a print. */
  cluster: string | null;
}

/** A point of a face sample, as a face anchor stores it. */
export interface FaceAnchorPoint {
  asset: string;
  /** Source seconds. */
  at: number;
  /** Fractions of the picture. */
  x: number;
  y: number;
}

/** Tracks with one face, across every scanned asset. */
export interface FaceCluster {
  /** `fc_` + 6 hex of its tracks: changes when its tracks change. */
  id: string;
  /** By asset, then first sight. */
  tracks: ClusterTrack[];
  /** Normalized mean of its tracks' means. */
  mean: Float32Array;
  /** Seconds it is on screen, summed over assets ({@link presence}). */
  seconds: number;
  /** Its most central sample (closest to `mean`): the anchor a confirmation links. */
  anchor: FaceAnchorPoint;
  /** Key of its track with the most prints: a handle that survives tracks added elsewhere, for suggestion ids. */
  handle: string;
}

/** Every face of the project: {@link clusterFaces}. */
export interface FaceModel {
  /** By seconds on screen, most first. */
  clusters: FaceCluster[];
  /** Every track, clustered or not, by asset then first sight. */
  tracks: ClusterTrack[];
  /** Scans by asset. */
  scans: Map<string, StoredFaceScan>;
}

/**
 * Cluster the tracks of `assets` by face print: average-linkage agglomerative
 * clustering on cosine similarity of track means, cut at
 * {@link FACE_CLUSTER_MATCH}. Tracks without prints stay out of clusters.
 */
export function clusterFaces(assets: readonly ScannedAsset[]): FaceModel {
  const prepared = prepareClusters(assets);
  return assembleClusters(prepared, averageLinkage(prepared.printed.map((track) => track.mean), { threshold: FACE_CLUSTER_MATCH }));
}

/**
 * {@link clusterFaces} with the O(n²) linkage in a worker thread, so a long
 * recording never blocks the daemon. The model of a set of scans is kept: the
 * same scans give it again without clustering.
 */
export async function clusterFacesOffThread(assets: readonly ScannedAsset[], options: { signal?: AbortSignal | undefined } = {}): Promise<FaceModel> {
  const key = modelKey(assets);
  const kept = modelCache.get(key);
  if (kept) return kept;
  const prepared = prepareClusters(assets);
  const request: ClusterRequest = { vectors: prepared.printed.map((track) => track.mean), threshold: FACE_CLUSTER_MATCH };
  const groups = prepared.printed.length < 2 ? averageLinkage(request.vectors, { threshold: request.threshold }) : await runWorkerTask<number[][]>(CLUSTER_WORKER, request, "face clustering", options);
  const model = assembleClusters(prepared, groups);
  modelCache.set(key, model);
  if (modelCache.size > MODEL_CACHE_SIZE) modelCache.delete(modelCache.keys().next().value!);
  return model;
}

/** What the clustering worker reads (`cluster-worker.ts`). */
export interface ClusterRequest {
  vectors: Float32Array[];
  threshold: number;
}

const MODEL_CACHE_SIZE = 4;
/** Models by {@link modelKey}, oldest first; a model is never mutated after it is built. */
const modelCache = new Map<string, FaceModel>();

/** Same scans (assets, content, tracks) and threshold: same model. */
function modelKey(assets: readonly ScannedAsset[]): string {
  const parts = [...assets].sort((a, b) => a.asset.localeCompare(b.asset)).map(({ asset, scan }) => `${asset}\0${scan.hash}\0${scan.tracks.length}\0${scan.tracks.reduce((sum, track) => sum + track.embeddings.length, 0)}`);
  return createHash("sha256").update(`${FACE_CLUSTER_MATCH}\n${parts.join("\n")}`).digest("hex");
}

/**
 * Worker script beside this module. Under the test runner this module is the
 * TypeScript source, so the worker runs from the build (`pnpm test` builds first).
 */
const CLUSTER_WORKER = import.meta.url.endsWith(".ts") ? new URL("../../dist/people/cluster-worker.js", import.meta.url) : new URL("./cluster-worker.js", import.meta.url);

interface PreparedClusters {
  sorted: ScannedAsset[];
  tracks: ClusterTrack[];
  printed: (ClusterTrack & { mean: Float32Array })[];
}

function prepareClusters(assets: readonly ScannedAsset[]): PreparedClusters {
  const sorted = [...assets].sort((a, b) => a.asset.localeCompare(b.asset));
  const tracks: ClusterTrack[] = sorted.flatMap(({ asset, scan }) =>
    scan.tracks.map((track) => ({ asset, track, key: `${asset}#${track.id}`, mean: meanOf(track.embeddings.map((entry) => entry.vector)), cluster: null })),
  );
  const printed = tracks.filter((track): track is ClusterTrack & { mean: Float32Array } => track.mean !== null);
  return { sorted, tracks, printed };
}

/** The model of `prepared` once its printed tracks are grouped (`groups` = indexes into `printed`). */
function assembleClusters({ sorted, tracks, printed }: PreparedClusters, groups: readonly (readonly number[])[]): FaceModel {
  const clusters = groups.map((members) => {
    const own = members.map((index) => printed[index]!);
    const id = `fc_${createHash("sha256").update(own.map((track) => track.key).join("\0")).digest("hex").slice(0, 6)}`;
    for (const track of own) track.cluster = id;
    const mean = meanOf(own.map((track) => track.mean))!;
    const handle = own.reduce((best, track) => (track.track.embeddings.length > best.track.embeddings.length ? track : best)).key;
    return { id, tracks: own, mean, seconds: presenceSeconds(own), anchor: centralSample(own, mean), handle };
  });
  clusters.sort((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id));
  return { clusters, tracks, scans: new Map(sorted.map(({ asset, scan }) => [asset, scan])) };
}

/**
 * Source seconds of `asset` where any of `tracks` is on screen: each sample
 * stands for {@link FACE_SAMPLE_SPAN_S} either side, merged as ranges are.
 */
export function presence(tracks: readonly ClusterTrack[], asset: string): Span[] {
  return mergeSpans(
    tracks.filter((track) => track.asset === asset).flatMap(({ track }) => track.boxes.map((box) => ({ start: Math.max(0, box.time - FACE_SAMPLE_SPAN_S), end: box.time + FACE_SAMPLE_SPAN_S }))),
  );
}

/** Seconds covered by `spans` (disjoint). */
export function spanSeconds(spans: readonly Span[]): number {
  return spans.reduce((sum, span) => sum + span.end - span.start, 0);
}

/** Seconds where `a` and `b` (each sorted and disjoint) overlap. */
export function overlapSeconds(a: readonly Span[], b: readonly Span[]): number {
  let total = 0;
  let j = 0;
  for (const span of a) {
    while (j < b.length && b[j]!.end <= span.start) j++;
    for (let k = j; k < b.length && b[k]!.start < span.end; k++) total += Math.min(span.end, b[k]!.end) - Math.max(span.start, b[k]!.start);
  }
  return total;
}

/**
 * The track a face anchor names: in its asset's scan, a box holding the
 * point at most {@link FACE_ANCHOR_WINDOW_S} from `at`, nearest in time then
 * nearest centre. Null when the asset is not scanned or no face is there.
 */
export function resolveAnchor(model: FaceModel, anchor: FaceAnchorPoint): ClusterTrack | null {
  let best: { track: ClusterTrack; dt: number; distance: number } | null = null;
  for (const track of model.tracks) {
    if (track.asset !== anchor.asset) continue;
    for (const box of track.track.boxes) {
      const dt = Math.abs(box.time - anchor.at);
      if (dt > FACE_ANCHOR_WINDOW_S + 1e-9 || !holds(box, anchor)) continue;
      const distance = Math.hypot(box.x - anchor.x, box.y - anchor.y);
      if (!best || dt < best.dt - 1e-9 || (Math.abs(dt - best.dt) <= 1e-9 && distance < best.distance)) best = { track, dt, distance };
    }
  }
  return best?.track ?? null;
}

/** Who the faces are: {@link facesOfPeople}. */
export interface FaceOwners {
  /** Tracks of each person, by person id. */
  tracks: Map<string, ClusterTrack[]>;
  /** The one person owning tracks of each cluster; clusters split between people or owned by nobody are absent. */
  clusters: Map<string, string>;
  /** Anchors that name no face, with why (unscanned asset, nothing at that point). */
  unresolved: { person: Person; anchor: FaceAnchorPoint; reason: string }[];
}

/**
 * Tie faces to people (ADR 0020: a face is the person's whose anchors it is
 * closest to). An anchored track is its person's. Every other track of a
 * cluster holding anchors of one person is theirs; of a cluster holding
 * anchors of several, it goes to the person whose anchored tracks' mean
 * print is closest. Clusters without anchors are nobody's.
 */
export function facesOfPeople(model: FaceModel, people: readonly Person[]): FaceOwners {
  const anchored = new Map<ClusterTrack, string>();
  const unresolved: FaceOwners["unresolved"] = [];
  for (const person of people) {
    for (const anchor of person.faces) {
      const track = resolveAnchor(model, anchor);
      if (track) {
        if (!anchored.has(track)) anchored.set(track, person.id);
        continue;
      }
      const reason = model.scans.has(anchor.asset) ? `no face at (${anchor.x}, ${anchor.y}) near ${anchor.at} s in ${anchor.asset}` : `${anchor.asset} has no face scan`;
      unresolved.push({ person, anchor, reason });
    }
  }
  const owner = new Map<ClusterTrack, string>(anchored);
  for (const cluster of model.clusters) {
    const byPerson = new Map<string, Float32Array[]>();
    for (const track of cluster.tracks) {
      const person = anchored.get(track);
      if (person) byPerson.set(person, [...(byPerson.get(person) ?? []), track.mean!]);
    }
    if (byPerson.size === 0) continue;
    const means = [...byPerson].map(([person, prints]) => ({ person, mean: meanOf(prints)! }));
    for (const track of cluster.tracks) {
      if (owner.has(track)) continue;
      const closest = means.reduce((best, entry) => (cosine(track.mean!, entry.mean) > cosine(track.mean!, best.mean) ? entry : best));
      owner.set(track, closest.person);
    }
  }
  const tracks = new Map<string, ClusterTrack[]>();
  for (const track of model.tracks) {
    const person = owner.get(track);
    if (person) tracks.set(person, [...(tracks.get(person) ?? []), track]);
  }
  const clusters = new Map<string, string>();
  for (const cluster of model.clusters) {
    const owners = new Set(cluster.tracks.map((track) => owner.get(track)));
    const [only] = owners;
    if (owners.size === 1 && only !== undefined) clusters.set(cluster.id, only);
  }
  return { tracks, clusters, unresolved };
}

/** Normalized mean of a person's track prints, or null without any. */
export function personFacePrint(tracks: readonly ClusterTrack[]): Float32Array | null {
  return meanOf(tracks.flatMap((track) => (track.mean ? [track.mean] : [])));
}

function holds(box: TrackBox, point: { x: number; y: number }): boolean {
  return Math.abs(point.x - box.x) <= box.width / 2 + 1e-6 && Math.abs(point.y - box.y) <= box.height / 2 + 1e-6;
}

function meanOf(vectors: readonly ArrayLike<number>[]): Float32Array | null {
  const mean = meanDirection(vectors);
  return mean ? Float32Array.from(mean) : null;
}

function presenceSeconds(tracks: readonly ClusterTrack[]): number {
  const assets = [...new Set(tracks.map((track) => track.asset))];
  return Math.round(assets.reduce((sum, asset) => sum + spanSeconds(presence(tracks, asset)), 0) * 1000) / 1000;
}

function centralSample(tracks: readonly ClusterTrack[], mean: Float32Array): FaceAnchorPoint {
  let best: { track: ClusterTrack; time: number; score: number } | null = null;
  for (const track of tracks) {
    for (const { time, vector } of track.track.embeddings) {
      const score = cosine(vector, mean);
      if (!best || score > best.score) best = { track, time, score };
    }
  }
  const { track, time } = best!;
  const box = track.track.boxes.find((candidate) => candidate.time === time) ?? track.track.boxes[0]!;
  const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  return { asset: track.asset, at: round(time, 3), x: round(box.x, 4), y: round(box.y, 4) };
}

