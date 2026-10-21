import { basename, extname } from "node:path";
import type { Size } from "@frameshell/schema/composite";
import type { DaemonLink } from "./daemon-link.js";
import { isImageFile } from "./media-files.js";

/** What {@link addImageLayers} needs from the app; replaced in tests. */
export interface ImageLayersDeps {
  /** The app's daemon connection (`ui` author). */
  request: DaemonLink["request"];
  /** Runs `work` with no gesture burst open around it (`TimelineEditor.alone`). */
  alone: <T>(work: () => Promise<T>) => Promise<T>;
  /** Pixel size of a project-relative image; null when unknown (the layer then fits the frame). */
  imageSize: (asset: string) => Size | null;
  /** The project's frame size (`frameshell.json` `resolution`). */
  resolution: Size;
}

/**
 * Put each image among `assets` (project-relative) on a new video track on top
 * of `timeline`, named after its file and starting at 0, as one `ui`
 * transaction: one undo takes them all off (ADR 0017). Each shows at its own
 * pixel size, centered, as a picture pasted into an image editor would, or with
 * `fit: "cover"` fills the frame, cropping what overflows; the first image ends up lowest. Assets that are not images are skipped. Resolves
 * with the new track ids.
 */
export async function addImageLayers(
  dir: string,
  timeline: string,
  assets: readonly string[],
  deps: ImageLayersDeps,
  fit: "native" | "cover" = "native",
): Promise<string[]> {
  const images = assets.filter(isImageFile);
  if (images.length === 0) return [];
  return deps.alone(async () => {
    await deps.request("tx.begin", { label: images.length === 1 ? "Add layer" : `Add ${images.length} layers`, autoCommitAfter: 30 });
    const tracks: string[] = [];
    try {
      for (const asset of images) {
        const name = basename(asset, extname(asset)) || asset;
        const added = await deps.request("track.add", { cwd: dir, timeline, kind: "video", name });
        const track = added.changes.added[0];
        if (!track) continue;
        tracks.push(track);
        const size = deps.imageSize(asset);
        const scale = fit === "cover" ? coverScale(size, deps.resolution) : nativeScale(size, deps.resolution);
        await deps.request("clip.add", { cwd: dir, timeline, track, asset, start: 0, ...(scale !== 1 ? { transform: { scale } } : {}) });
      }
    } finally {
      await deps.request("tx.commit", {}).catch(() => undefined);
    }
    return tracks;
  });
}

/**
 * The clip scale that undoes the fit to the frame (`layerRect` letterboxes an untransformed picture), so `size`
 * shows pixel for pixel in a `resolution` frame; 1 when the size is unknown or already fits exactly.
 */
export function nativeScale(size: Size | null, resolution: Size): number {
  if (!size || size.width <= 0 || size.height <= 0) return 1;
  const fit = Math.min(resolution.width / size.width, resolution.height / size.height);
  return Math.round((1 / fit) * 10_000) / 10_000;
}

/** The clip scale that makes `size` cover a `resolution` frame with no bars (overflow is cropped); 1 when unknown. */
export function coverScale(size: Size | null, resolution: Size): number {
  if (!size || size.width <= 0 || size.height <= 0) return 1;
  const across = resolution.width / size.width;
  const down = resolution.height / size.height;
  return Math.round((Math.max(across, down) / Math.min(across, down)) * 10_000) / 10_000;
}
