import { spawn } from "node:child_process";

/**
 * Frames of the first video stream of absolute `path` decoded by ffmpeg through the video filter `filter`
 * (which must end in a `format=`), `frameBytes` each, in order. Reading waits for the consumer, so a slow
 * model never piles frames up in memory. `range` (source seconds) limits decoding to that span. Throws when
 * ffmpeg cannot decode the file.
 */
export async function* readRawFrames(
  ffmpeg: string,
  path: string,
  filter: string,
  frameBytes: number,
  range?: { from: number; to: number },
): AsyncGenerator<Uint8Array> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...(range ? ["-ss", String(range.from), "-t", String(range.to - range.from)] : []),
    "-i",
    path,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    filter,
    "-f",
    "rawvideo",
    "-",
  ];
  const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  exited.catch(() => undefined);
  // Pipe chunks (64 KB) copied once into the frame being filled: joining them as they come copies a 4K frame
  // (25 MB) hundreds of times over.
  let frame = new Uint8Array(frameBytes);
  let filled = 0;
  let finished = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      for (let at = 0; at < chunk.length; ) {
        const take = Math.min(frameBytes - filled, chunk.length - at);
        frame.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === frameBytes) {
          yield frame;
          frame = new Uint8Array(frameBytes);
          filled = 0;
        }
      }
    }
    const code = await exited;
    finished = true;
    if (code !== 0) throw new Error(`ffmpeg could not read the picture of ${path} (exit ${code}): ${stderr.trim()}`);
  } finally {
    // The consumer stopped early (an error, a closed connection): do not leave ffmpeg decoding.
    if (!finished) {
      child.kill();
      // Windows keeps the input file locked until the process is gone: callers delete it right after.
      await exited.catch(() => undefined);
    }
  }
}
