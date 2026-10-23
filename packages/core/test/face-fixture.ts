import { spawn } from "node:child_process";
import type { FaceDetector } from "../src/index.js";
import { run } from "./media-tools.js";

/**
 * A drawn head and shoulders (hair, skin with shading, brows, eyes, nose,
 * mouth) as packed BGR, centered on (`x`, `y`) in fractions of the picture,
 * `size` = face height over picture height. YuNet scores it about 0.9.
 */
export function drawFace(width: number, height: number, faces: readonly { x: number; y: number; size: number }[]): Uint8Array {
  const image = new Uint8Array(width * height * 3);
  const set = (i: number, b: number, g: number, r: number) => {
    image[i * 3] = b;
    image[i * 3 + 1] = g;
    image[i * 3 + 2] = r;
  };
  const inside = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let i = 0; i < width * height; i++) set(i, 90, 100, 110);
  for (const face of faces) {
    const cx = face.x * width;
    const cy = face.y * height;
    const fh = face.size * height;
    const fw = fh * 0.78;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (inside(x, y, cx, cy + fh * 1.25, fw * 1.6, fh * 0.7)) set(i, 120, 60, 40);
        if (Math.abs(x - cx) < fw * 0.25 && y > cy && y < cy + fh * 0.75) set(i, 120, 150, 195);
        if (inside(x, y, cx, cy - fh * 0.08, fw * 0.56, fh * 0.56)) set(i, 30, 40, 60);
        if (inside(x, y, cx, cy + fh * 0.04, fw * 0.48, fh * 0.5)) {
          const shade = 1 - 0.25 * (((x - cx) / (fw * 0.48)) ** 2 + ((y - cy - fh * 0.04) / (fh * 0.5)) ** 2);
          set(i, 130 * shade, 165 * shade, 215 * shade);
        }
        for (const side of [-1, 1]) {
          if (inside(x, y, cx + side * fw * 0.2, cy - fh * 0.12, fw * 0.11, fh * 0.025)) set(i, 30, 40, 60);
          if (inside(x, y, cx + side * fw * 0.2, cy - fh * 0.03, fw * 0.09, fh * 0.04)) set(i, 240, 240, 240);
          if (inside(x, y, cx + side * fw * 0.2, cy - fh * 0.03, fw * 0.04, fh * 0.04)) set(i, 40, 30, 20);
        }
        if (inside(x, y, cx, cy + fh * 0.1, fw * 0.06, fh * 0.08)) set(i, 110, 140, 190);
        if (inside(x, y, cx, cy + fh * 0.26, fw * 0.16, fh * 0.035)) set(i, 70, 70, 170);
      }
    }
  }
  return image;
}

/** Encode BGR frames (each `width`×`height`) at `fps` as an H.264 MP4 with no sound. */
export async function encodeFrames(ffmpeg: string, path: string, width: number, height: number, fps: number, frames: readonly Uint8Array[]): Promise<void> {
  const args = ["-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-"];
  const child = spawn(ffmpeg, [...args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", path], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`))));
  });
  for (const frame of frames) if (!child.stdin.write(frame)) await new Promise((resolve) => child.stdin.once("drain", resolve));
  child.stdin.end();
  await done;
}

/**
 * Silent H.264 clip: a white square (`box` px) on black whose left edge sits
 * at x pixel `x(t)`, an ffmpeg expression of `t`, vertically centered.
 */
export async function makeMarkerClip(ffmpeg: string, path: string, { width = 320, height = 180, box = 40, durationS = 8, x }: { width?: number; height?: number; box?: number; durationS?: number; x: string }): Promise<void> {
  const graph = `color=c=black:s=${width}x${height}:r=10:d=${durationS}[bg];color=c=white:s=${box}x${box}:r=10[fg];[bg][fg]overlay=x='${x}':y=${(height - box) / 2}:shortest=1,format=yuv420p`;
  await run(ffmpeg, ["-v", "error", "-filter_complex", graph, "-c:v", "libx264", "-y", path]);
}

/** Stand-in for YuNet: the bright pixels of a frame are one face, at their centroid. */
export const markerDetector: FaceDetector = async ({ width, height, data }) => {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (data[i]! < 200 || data[i + 1]! < 200 || data[i + 2]! < 200) continue;
      count++;
      sumX += x + 0.5;
      sumY += y + 0.5;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + 1);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + 1);
    }
  }
  if (count === 0) return [];
  return [{ x: sumX / count / width, y: sumY / count / height, width: (maxX - minX) / width, height: (maxY - minY) / height, score: 1 }];
};
