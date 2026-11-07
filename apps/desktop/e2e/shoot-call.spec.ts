import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";

// After a call recorded in the Shoot view (#394, ADR 0024 decision 8): the view offers splitting the call window into
// its tiles, finding who speaks in the system audio and linking speakers in People. The session is written to disk as
// one the app was killed in (camera, a gallery-view call window, mic, system audio), so it is finished on open; screen
// capture of a real call needs macOS permissions no test can grant (docs/acceptance/shoot.md).
const box = sandbox("multicam");
const mainFile = join(box.projectDir, "timelines", "main.json");
const session = "20261107-120000";
const folder = join(box.projectDir, "assets", "shoot", session);

let app: ElectronApplication;
let page: Page;

interface Group {
  id: string;
  angles: { id: string; asset: string; offset: number; screen?: boolean; mic?: string | null; crop?: object }[];
  mics?: { id: string; asset: string }[];
}

/** A 640×360 gallery of four moving tiles on a dark gray background, `seconds` long, no sound. */
async function gallery(ffmpeg: string, out: string, seconds: number): Promise<void> {
  const tiles = [
    [8, 8],
    [324, 8],
    [8, 184],
    [324, 184],
  ];
  const parts = [`color=c=0x303030:s=640x360:r=30:d=${seconds}[bg]`];
  let previous = "bg";
  tiles.forEach(([x, y], i) => {
    parts.push(`testsrc2=s=308x168:r=30:d=${seconds},hue=h=${i * 70}[t${i}]`);
    parts.push(`[${previous}][t${i}]overlay=${x}:${y}[o${i}]`);
    previous = `o${i}`;
  });
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-filter_complex", parts.join(";"), "-map", `[${previous}]`],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "mp4", out],
  ]);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const ffmpeg = await testFfmpeg();
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  mkdirSync(folder, { recursive: true });
  const seconds = 6;
  const quiet = ["-hide_banner", "-loglevel", "error", "-y"];
  await ffmpegRun(ffmpeg, [...quiet, "-f", "lavfi", "-i", `testsrc2=s=320x180:r=30:d=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "mp4", join(folder, "camera.mp4.part")]);
  await gallery(ffmpeg, join(folder, "screen.mp4.part"), seconds);
  for (const [role, hz] of [
    ["mic", 220],
    ["system", 440],
  ] as const) {
    await ffmpegRun(ffmpeg, [...quiet, "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`, "-c:a", "aac", "-f", "mp4", join(folder, `${role}.m4a.part`)]);
  }
  const source = (role: string, file: string, mime: string, label: string, start: number) => ({ role, file, mime, label, start });
  const state = {
    version: 1,
    id: session,
    createdAt: "2026-11-07T12:00:00.000Z",
    sources: [
      source("camera", "camera.mp4", "video/mp4;codecs=avc1.640028", "Camera", 1000),
      source("screen", "screen.mp4", "video/mp4;codecs=avc1.640028", "Call window", 1500),
      source("mic", "mic.m4a", "audio/mp4;codecs=mp4a.40.2", "Microphone", 1000),
      source("system", "system.m4a", "audio/mp4;codecs=mp4a.40.2", "System audio", 1500),
    ],
  };
  const sessions = join(box.projectDir, ".frameshell", "shoot", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${session}.json`), JSON.stringify(state));
  ({ app, page } = await launch(box, { env: { FRAMESHELL_SHOOT_STAND_IN: "1" } }));
});

test.afterAll(async () => {
  await app?.close();
});

test("offers the call's tiles, its speakers and People after a call session, and adds the tiles to the session's group", async () => {
  test.setTimeout(180_000);
  await page.getByRole("tab", { name: "Shoot" }).click();
  await expect(page.getByTestId("shoot-finished")).toContainText("Recovered a shoot that was interrupted", { timeout: 60_000 });
  const steps = page.getByTestId("shoot-call-steps");
  await expect(steps).toContainText("After the call");
  await expect(page.getByTestId("shoot-call-speakers").getByRole("button", { name: "Find who speaks in the call audio" })).toBeVisible();

  await page.getByTestId("shoot-call-gallery").getByRole("button", { name: "Split the call window into its tiles" }).click();
  await expect(page.getByTestId("shoot-call-gallery")).toHaveAttribute("data-state", "done", { timeout: 90_000 });
  await expect(page.getByTestId("shoot-call-gallery")).toContainText("Added 4 tiles as angles of the session.");
  const group = ((JSON.parse(readFileSync(mainFile, "utf8")) as { groups?: Group[] }).groups ?? []).find((candidate) =>
    candidate.angles.some((angle) => angle.asset === `assets/shoot/${session}/screen.mp4`),
  )!;
  const window = group.angles.find((angle) => angle.screen === true)!;
  const system = group.mics!.find((mic) => mic.asset === `assets/shoot/${session}/system.m4a`)!;
  const tiles = group.angles.filter((angle) => angle.crop !== undefined);
  expect(tiles).toHaveLength(4);
  for (const tile of tiles) expect(tile).toMatchObject({ asset: window.asset, offset: window.offset, mic: system.id });

  await page.getByTestId("shoot-call-people").click();
  await expect(page.getByTestId("people-panel")).toBeVisible();
  // Back in the Shoot view the tiles are not offered again: a second run would add them twice.
  await page.getByRole("tab", { name: "Shoot" }).click();
  await expect(page.getByTestId("shoot-call-gallery")).toHaveAttribute("data-state", "done");
});
