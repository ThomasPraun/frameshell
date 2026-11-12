import { runTool } from "../media/ffmpeg.js";
import { type SceneScore, parseSceneScores } from "./shots.js";

/** Width the frames are scaled to before they are compared: the score needs the layout of a picture, not its detail. */
const SCENE_WIDTH = 160;

/**
 * The scene score of every frame of the first video stream of absolute `path` (a film at `fps`), from ffmpeg's `scene`
 * measure on small frames. Every frame is read once, none dropped or repeated (`-fps_mode passthrough`), so VFR files
 * keep their own frames. Rejects with ffmpeg's error.
 */
export async function sceneScores(ffmpeg: string, path: string, fps: number, signal?: AbortSignal): Promise<SceneScore[]> {
  const text = await runTool(
    ffmpeg,
    [
      ...["-hide_banner", "-loglevel", "error", "-nostdin"],
      ...["-i", path, "-map", "0:v:0", "-an"],
      ...["-vf", `scale=${SCENE_WIDTH}:-2:flags=area,select='gte(scene,0)',metadata=print:file=-`],
      ...["-fps_mode", "passthrough", "-f", "null", "-"],
    ],
    signal ? { signal } : {},
  );
  return parseSceneScores(text, fps);
}
