import { mediaTools } from "./packages/core/test/media-tools.js";

/** Install the managed ffmpeg once before any worker starts, so parallel media tests never race a download. */
export default async function setup(): Promise<void> {
  await mediaTools();
}
