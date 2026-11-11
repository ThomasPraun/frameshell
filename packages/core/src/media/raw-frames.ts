import { spawn } from "node:child_process";

/**
 * Frames of the first video stream of absolute `path` decoded by ffmpeg through the video filter `filter`
 * (which must end in a `format=`), `frameBytes` each, in order. Reading waits for the consumer, so a slow
 * model never piles frames up in memory. Throws when ffmpeg cannot decode the file.
 */
export async function* readRawFrames(ffmpeg: string, path: string, filter: string, frameBytes: number): AsyncGenerator<Uint8Array> {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-an", "-vf", filter, "-f", "rawvideo", "-"];
  const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let pending: Buffer = Buffer.alloc(0);
  let finished = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let at = 0;
      for (; at + frameBytes <= pending.length; at += frameBytes) yield Uint8Array.from(pending.subarray(at, at + frameBytes));
      pending = pending.subarray(at);
    }
    const code = await exited;
    finished = true;
    if (code !== 0) throw new Error(`ffmpeg could not read the picture of ${path} (exit ${code}): ${stderr.trim()}`);
  } finally {
    // The consumer stopped early (an error, a closed connection): do not leave ffmpeg decoding.
    if (!finished) child.kill();
  }
}
