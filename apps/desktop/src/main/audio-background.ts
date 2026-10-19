// Built-in subtitles-on-background video for projects made from audio (ADR 0015, simple level).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import type { DaemonLink } from "./daemon-link.js";

/** Plain background colour behind the title and the subtitles. */
const BACKGROUND_COLOUR = "#16191f";

/** Project frame size in pixels. */
export interface FrameSize {
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
}

/** The page rendered into the background image: the project title on a plain colour, in the upper third. */
export function backgroundHtml(title: string, size: FrameSize): string {
  const text = title.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  // Sized from the shorter side so 16:9 and 9:16 frames look alike.
  const unit = Math.min(size.width, size.height) / 100;
  return (
    `<!doctype html><meta charset="utf-8"><style>` +
    `html,body{margin:0;width:${size.width}px;height:${size.height}px;overflow:hidden;background:${BACKGROUND_COLOUR}}` +
    `h1{position:absolute;left:${6 * unit}px;right:${6 * unit}px;top:${size.height * 0.12}px;margin:0;text-align:center;` +
    `color:#f4f5f7;font:600 ${6.5 * unit}px/1.15 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}` +
    `</style><h1>${text}</h1>`
  );
}

/** Render {@link backgroundHtml} with Chromium (offscreen window) into a PNG of exactly `size` pixels. */
export async function renderBackground(title: string, size: FrameSize): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    width: size.width,
    height: size.height,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, javascript: false, backgroundThrottling: false },
  });
  try {
    await window.loadURL(`data:text/html;base64,${Buffer.from(backgroundHtml(title, size)).toString("base64")}`);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: size.width, height: size.height });
    // A high-density display captures more pixels than the frame has.
    const exact = image.getSize().width === size.width ? image : image.resize(size);
    return exact.toPNG();
  } finally {
    window.destroy();
  }
}

/** Production render step of {@link BackgroundDeps}: {@link renderBackground} written to `path`. */
export async function renderBackgroundTo(title: string, size: FrameSize, path: string): Promise<void> {
  await writeFile(path, await renderBackground(title, size));
}

/** What {@link addAudioBackground} needs from the app; replaced in tests. */
export interface BackgroundDeps {
  /** The app's daemon connection (`ui` author). */
  request: DaemonLink["request"];
  /** Runs `work` between the editor's own transactions (`TimelineEditor.alone`). */
  alone: <T>(work: () => Promise<T>) => Promise<T>;
  /** Writes the background PNG for `title` at `path`. */
  render: (title: string, size: FrameSize, path: string) => Promise<void>;
}

/**
 * Give a project made from audio its picture: a plain-colour image with the
 * project title in `assets/` over the audio's length on a video track, and
 * a subtitle track following the audio (default preset), as one undoable
 * `ui` transaction. Left alone, returning false, when a video track already
 * has clips or there is no audio to follow (offered once).
 */
export async function addAudioBackground(dir: string, title: string, size: FrameSize, deps: BackgroundDeps): Promise<boolean> {
  const { request } = deps;
  const { tracks } = await request("track.list", { cwd: dir, timeline: "main" });
  const audio = tracks.find((track) => track.kind === "audio" && track.clips > 0);
  const length = audio?.end ?? 0;
  if (!audio || length <= 0 || tracks.some((track) => track.kind === "video" && track.clips > 0)) return false;
  const scratch = await mkdtemp(join(tmpdir(), "frameshell-background-"));
  try {
    const file = join(scratch, "background.png");
    await deps.render(title, size, file);
    const { imported } = await request("asset.import", { cwd: dir, files: [file], mode: "copy" });
    const asset = imported[0]?.asset;
    if (!asset) return false;
    return await deps.alone(async () => {
      await request("tx.begin", { label: "Add subtitles on a background", autoCommitAfter: 30 });
      try {
        // Checked again: the user or an agent may have edited since the first look.
        const fresh = (await request("track.list", { cwd: dir, timeline: "main" })).tracks;
        const current = fresh.find((track) => track.id === audio.id && track.kind === "audio");
        const end = current?.end ?? 0;
        if (!current || end <= 0 || fresh.some((track) => track.kind === "video" && track.clips > 0)) {
          await request("tx.abort", {});
          return false;
        }
        let video = fresh.find((track) => track.kind === "video")?.id;
        video ??= (await request("track.add", { cwd: dir, timeline: "main", kind: "video", name: "Background" })).changes.added[0];
        if (!video) throw new Error("The video track was not created.");
        await request("clip.add", { cwd: dir, timeline: "main", track: video, asset, start: 0, duration: end });
        await request("track.add", { cwd: dir, timeline: "main", kind: "subtitles", follows: audio.id });
      } catch (error) {
        await request("tx.abort", {}).catch(() => undefined);
        throw error;
      }
      await request("tx.commit", {});
      return true;
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
