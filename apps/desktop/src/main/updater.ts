// Update check (#193): GitHub Releases on start and daily. `auto` builds install with electron-updater; `notify`
// builds, and `auto` builds whose install fails (unsigned, read-only volume), show a banner linking to the download.
import { BrowserWindow, app, dialog, net, shell } from "electron";
import type { AppUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/api.js";
import type { Dict } from "../shared/i18n/index.js";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  LATEST_RELEASE_API,
  type ReleaseInfo,
  type UpdateMode,
  type UpdatePreferences,
  isNewer,
  releaseFromGitHub,
} from "./update-check.js";

/** Options for {@link Updater}. */
export interface UpdaterOptions {
  mode: UpdateMode;
  preferences: UpdatePreferences;
  /** This app's version. */
  version: string;
  /** Tell every window the banner's state changed. */
  broadcast(status: UpdateStatus | null): void;
  /** Dialog strings in the app's current language. */
  text(): Dict["app"]["updates"];
}

/** One per app: checks, keeps the found update, and installs it on "Restart to update". */
export class Updater {
  #status: UpdateStatus | null = null;
  /** Version whose banner the user closed this session. */
  #dismissed: string | null = null;
  #timer: NodeJS.Timeout | undefined;
  #updater: Promise<AppUpdater> | undefined;
  /** electron-updater failed to install here: notify instead. */
  #autoFailed = false;

  constructor(private readonly options: UpdaterOptions) {}

  /** Read the user's choices; before {@link automatic} and {@link start}. */
  load(): Promise<void> {
    return this.options.preferences.load();
  }

  /** The automatic checks are on (menu checkbox). */
  get automatic(): boolean {
    return this.options.preferences.automatic;
  }

  /** The banner to show; null when none or dismissed. */
  status(): UpdateStatus | null {
    return this.#status && this.#status.version !== this.#dismissed ? this.#status : null;
  }

  /** Start the automatic checks when the user wants them. */
  start(): void {
    if (this.options.mode === "off" || !this.options.preferences.automatic) return;
    this.#schedule(FIRST_CHECK_DELAY_MS);
  }

  /** Menu checkbox: turn the automatic checks on or off, remembered in `configDir`. */
  async setAutomatic(automatic: boolean): Promise<void> {
    await this.options.preferences.setAutomatic(automatic);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (automatic) this.start();
  }

  /** Hide the banner of the current update until the app restarts. */
  dismiss(): void {
    if (!this.#status) return;
    this.#dismissed = this.#status.version;
    this.options.broadcast(null);
  }

  /** Menu "Check for Updates…": check now and say what was found. */
  async checkFromMenu(): Promise<void> {
    if (this.options.mode === "off") {
      await this.#box({ type: "info", message: this.options.text().notInThisBuild });
      return;
    }
    try {
      const found = await this.#check();
      if (!found) {
        await this.#box({ type: "info", message: this.options.text().upToDate(this.options.version) });
      } else if (found.state === "ready") {
        await this.#offerRestart(found.version);
      } else if (found.state === "available") {
        const { response } = await this.#box({
          type: "info",
          message: this.options.text().available(found.version),
          buttons: [this.options.text().download, this.options.text().later],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) void shell.openExternal(found.url);
      } else {
        await this.#box({ type: "info", message: this.options.text().downloading(found.version) });
      }
    } catch (error) {
      await this.#box({ type: "error", message: this.options.text().checkFailed, detail: (error as Error).message });
    }
  }

  /**
   * Banner "Restart to update". Releases the single-instance lock first: the
   * AppImage updater starts the new app before this one has quit.
   */
  async restart(): Promise<void> {
    if (this.#status?.state !== "ready" || !this.#updater) return;
    const updater = await this.#updater;
    app.releaseSingleInstanceLock();
    updater.quitAndInstall(true, true);
  }

  #schedule(delayMs: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.#check()
        .catch(() => undefined)
        .finally(() => {
          if (this.options.preferences.automatic) this.#schedule(CHECK_INTERVAL_MS);
        });
    }, delayMs);
    this.#timer.unref();
  }

  /**
   * One check. Resolves with the update found (`downloading` while
   * electron-updater fetches it), or null when this version is the newest.
   */
  async #check(): Promise<UpdateStatus | { state: "downloading"; version: string } | null> {
    if (this.#status?.state === "ready") return this.#status;
    if (this.options.mode === "auto" && !this.#autoFailed) {
      try {
        const updater = await this.#autoUpdater();
        const result = await updater.checkForUpdates();
        if (!result?.isUpdateAvailable) return null;
        return this.status() ?? { state: "downloading", version: result.updateInfo.version };
      } catch {
        this.#autoFailed = true;
      }
    }
    const release = await latestRelease();
    if (!isNewer(release.version, this.options.version)) return null;
    this.#show({ state: "available", version: release.version, url: release.url });
    return this.#status;
  }

  #autoUpdater(): Promise<AppUpdater> {
    // Loaded only here: dev, e2e and notify builds never load it. CommonJS, so the named export sits on the default.
    this.#updater ??= import("electron-updater").then(({ default: updaterModule }) => {
      const updater = updaterModule.autoUpdater;
      updater.autoDownload = true;
      // The AppImage updater runs the new AppImage synchronously on quit, while this app holds the single-instance
      // lock: install only through restart(). macOS installs on quit through Squirrel.
      updater.autoInstallOnAppQuit = process.platform === "darwin";
      updater.logger = null;
      updater.on("update-downloaded", (info) => this.#show({ state: "ready", version: info.version }));
      updater.on("error", () => {
        if (this.#status?.state === "ready") return;
        // Download or install refused here (unsigned app, read-only volume): fall back to the banner.
        this.#autoFailed = true;
        void latestRelease()
          .then((release) => {
            if (isNewer(release.version, this.options.version)) this.#show({ state: "available", version: release.version, url: release.url });
          })
          .catch(() => undefined);
      });
      return updater;
    });
    return this.#updater;
  }

  #show(status: UpdateStatus): void {
    this.#status = status;
    this.options.broadcast(this.status());
  }

  async #offerRestart(version: string): Promise<void> {
    const { response } = await this.#box({
      type: "info",
      message: this.options.text().ready(version),
      buttons: [this.options.text().restart, this.options.text().later],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await this.restart();
  }

  #box(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const parent = BrowserWindow.getFocusedWindow();
    const withOk = options.buttons ? options : { ...options, buttons: [this.options.text().ok] };
    return parent ? dialog.showMessageBox(parent, withOk) : dialog.showMessageBox(withOk);
  }
}

/** Newest published release on GitHub. Rejects on a network or API error. */
async function latestRelease(): Promise<ReleaseInfo> {
  const response = await net.fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `Frameshell/${app.getVersion()}` },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
  const release = releaseFromGitHub(await response.json());
  if (!release) throw new Error("The latest GitHub release is not a Frameshell release");
  return release;
}
