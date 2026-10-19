// page.evaluate bodies run in the renderer, app.evaluate bodies in main.
/// <reference lib="dom" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { FrameshellApi } from "../src/shared/api.js";
import { launch, sandbox } from "./harness.js";
import { makeAudio, makeSource, testFfmpeg, useTestBinaries } from "./media.js";

// Projects created from a video (ADR 0013, #182): the welcome screen plans the folder beside the video, creates the
// project and imports the video without the terminal. The native file dialog is replaced in main.
const box = sandbox("demo");
// New projects probe their first video: the shared ffprobe, not a download per sandbox.
test.beforeAll(() => useTestBinaries(box.configDir));
const home = join(dirname(box.projectDir), "desktop");
mkdirSync(home, { recursive: true });
// Ingest of these bytes fails; the flow under test ends before it matters.
const interview = join(home, "interview.mp4");
writeFileSync(interview, Buffer.alloc(4096, 7));
const broll = join(home, "broll.mov");
writeFileSync(broll, Buffer.alloc(2048, 3));

/** Launch on a folder that is not a project, so the window shows the welcome screen. */
async function launchWelcome() {
  return launch({ ...box, projectDir: home });
}

test("choosing a video creates its project beside it and opens it", async () => {
  const { app, page } = await launchWelcome();
  try {
    await expect(page.locator(".welcome")).toHaveCount(1);
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, [interview, broll]);

    await page.getByRole("button", { name: "New from video or audio…" }).click();
    const form = page.getByRole("form", { name: "New project from video or audio" });
    await expect(form.getByText("interview.mp4, broll.mov")).toBeVisible();
    await expect(form.getByLabel("Project name")).toHaveValue("interview");
    await expect(form.locator(".welcome-place code")).toHaveText(join(home, "interview"));

    // Transcription would download the plugin and a 574 MB model: covered with a dead registry in new-from-video.
    await form.getByLabel("Transcribe what is said").uncheck();
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("interview", { timeout: 60_000 });
    await page.locator(".tree-row", { hasText: "assets" }).click();
    await expect(page.locator(".tree-name", { hasText: "interview.mp4" })).toBeVisible();
    await expect(page.locator(".tree-name", { hasText: "broll.mov" })).toBeVisible();
    // The originals stay where the user left them.
    expect(existsSync(interview) && existsSync(broll)).toBe(true);

    // The same video again leads to the same project; a folder of that name holding something else does not.
    const again = await page.evaluate(
      (file) => (window as unknown as { frameshell: FrameshellApi }).frameshell.project.planVideos([file]),
      interview,
    );
    expect(again.plan).toMatchObject({ dir: join(home, "interview"), existing: true });
    const other = await page.evaluate(
      (file) => (window as unknown as { frameshell: FrameshellApi }).frameshell.project.planVideos([file]),
      broll,
    );
    expect(other.plan).toMatchObject({ dir: join(home, "broll"), existing: false });

    // A drop plans the videos among the files and names the rest (#183).
    const notes = join(home, "notes.pdf");
    writeFileSync(notes, "%PDF");
    const mixed = await page.evaluate(
      (files) => (window as unknown as { frameshell: FrameshellApi }).frameshell.project.planVideos(files),
      [notes, broll],
    );
    expect(mixed).toMatchObject({ plan: { files: [broll] }, refused: [notes] });
  } finally {
    await app.close();
  }
});

test("with transcription on, the setup runs in the background and its outcome shows in the status bar", async () => {
  // Its own sandbox: the daemon runs npm, and one still up from an earlier test would lack this env and download for real.
  const own = sandbox("demo");
  await useTestBinaries(own.configDir);
  const folder = join(dirname(own.projectDir), "videos");
  mkdirSync(folder, { recursive: true });
  const take = join(folder, "talk.mp4");
  writeFileSync(take, Buffer.alloc(1024, 9));
  // npm offline with an empty cache: the plugin install fails at once (ENOTCACHED), with no network, which proves the
  // setup runs and reports.
  const { app, page } = await launch(
    { ...own, projectDir: folder },
    { env: { npm_config_offline: "true", npm_config_cache: join(dirname(own.projectDir), "npm-cache") } },
  );
  try {
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, [take]);
    await page.getByRole("button", { name: "New from video or audio…" }).click();
    const form = page.getByRole("form", { name: "New project from video or audio" });
    await expect(form.getByLabel("Transcribe what is said")).toBeChecked();
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("talk", { timeout: 60_000 });
    const setup = page.getByTestId("project-setup");
    await expect(setup).toContainText("Could not download the transcription plugin.", { timeout: 120_000 });
    await expect(setup).toHaveAttribute("title", /npm install failed/);
  } finally {
    await app.close();
  }
});

test("the project takes the first video's format and starts with the videos on its timeline", async () => {
  const own = sandbox("demo");
  await useTestBinaries(own.configDir);
  const folder = join(dirname(own.projectDir), "clips");
  mkdirSync(folder, { recursive: true });
  const first = join(folder, "intro.mp4");
  const second = join(folder, "outro.mp4");
  const ffmpeg = await testFfmpeg();
  await makeSource(ffmpeg, first, { seconds: 1, fps: 25, width: 640, height: 360 });
  await makeSource(ffmpeg, second, { seconds: 1, fps: 25, width: 640, height: 360 });
  const { app, page } = await launch({ ...own, projectDir: folder });
  try {
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, [first, second]);
    await page.getByRole("button", { name: "New from video or audio…" }).click();
    const form = page.getByRole("form", { name: "New project from video or audio" });
    await form.getByLabel("Transcribe what is said").uncheck();
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("intro", { timeout: 60_000 });
    const config = JSON.parse(readFileSync(join(folder, "intro", "frameshell.json"), "utf8"));
    expect(config).toMatchObject({ fps: 25, resolution: { width: 640, height: 360 } });
    await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "2", { timeout: 30_000 });
  } finally {
    await app.close();
  }
});

for (const { frame, label, size } of [
  { frame: "horizontal", label: "Horizontal, 16:9 (1920x1080)", size: { width: 1920, height: 1080 } },
  { frame: "vertical", label: "Vertical, 9:16 (1080x1920)", size: { width: 1080, height: 1920 } },
]) {
  test(`an audio file starts a ${frame} project with the audio on its own track (ADR 0015)`, async () => {
    const own = sandbox("demo");
    await useTestBinaries(own.configDir);
    const folder = join(dirname(own.projectDir), `podcasts-${frame}`);
    mkdirSync(folder, { recursive: true });
    const episode = join(folder, "episode.mp3");
    await makeAudio(episode);
    const { app, page } = await launch({ ...own, projectDir: folder });
    try {
      // A drop plans the audio among the files and names the rest (#183).
      const notes = join(folder, "notes.pdf");
      writeFileSync(notes, "%PDF");
      const dropped = await page.evaluate(
        (files) => (window as unknown as { frameshell: FrameshellApi }).frameshell.project.planVideos(files),
        [notes, episode],
      );
      expect(dropped).toMatchObject({ plan: { files: [episode], audioOnly: true, existing: false }, refused: [notes] });
      await app.evaluate(({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      }, [episode]);
      await page.getByRole("button", { name: "New from video or audio…" }).click();
      const form = page.getByRole("form", { name: "New project from video or audio" });
      await expect(form.getByText("This audio has no picture")).toBeVisible();
      // 16:9 is the default.
      await expect(form.getByLabel("Horizontal, 16:9 (1920x1080)")).toBeChecked();
      await form.getByLabel(label).check();
      await form.getByLabel("Transcribe what is said").uncheck();
      await form.getByRole("button", { name: "Create project" }).click();
      await expect(page.locator(".titlebar-project")).toHaveText("episode", { timeout: 60_000 });
      const dir = join(folder, "episode");
      expect(JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"))).toMatchObject({ resolution: size, fps: 30, sampleRate: 44100 });
      await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1", { timeout: 30_000 });
      const timeline = JSON.parse(readFileSync(join(dir, "timelines", "main.json"), "utf8"));
      expect(timeline.tracks).toHaveLength(1);
      expect(timeline.tracks[0]).toMatchObject({ kind: "audio", clips: [{ asset: "assets/episode.mp3" }] });
      expect(existsSync(episode)).toBe(true);
    } finally {
      await app.close();
    }
  });
}

test("an audio-only project with transcription on runs the setup in the background", async () => {
  const own = sandbox("demo");
  await useTestBinaries(own.configDir);
  const folder = join(dirname(own.projectDir), "podcasts-transcribed");
  mkdirSync(folder, { recursive: true });
  const episode = join(folder, "talk.mp3");
  await makeAudio(episode);
  // Same dead registry as the video test: the plugin install fails at once, which proves the setup ran.
  const { app, page } = await launch(
    { ...own, projectDir: folder },
    { env: { npm_config_offline: "true", npm_config_cache: join(dirname(own.projectDir), "npm-cache") } },
  );
  try {
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, [episode]);
    await page.getByRole("button", { name: "New from video or audio…" }).click();
    const form = page.getByRole("form", { name: "New project from video or audio" });
    await expect(form.getByLabel("Transcribe what is said")).toBeChecked();
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("talk", { timeout: 60_000 });
    await expect(page.getByTestId("project-setup")).toContainText("Could not download the transcription plugin.", { timeout: 120_000 });
  } finally {
    await app.close();
  }
});
