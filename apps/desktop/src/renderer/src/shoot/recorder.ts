// The shoot recorder (ADR 0024): one store per project renderer, outside any component, so a recording goes on while
// the Shoot view switches tabs or moves to its own window (ADR 0012). Main appends the chunks and finishes the session.
import { useSyncExternalStore } from "react";
import type { ShootFinish, ShootRole, ShootScreenSource, ShootSourceSpec, ShootSupport } from "../../../shared/api.js";
import { LEVEL_FLOOR, capSize, heldLevel, levelDb, meterWindow, pickType, silentSince, silentTooLong } from "./model.js";

/** A camera or microphone. */
export interface ShootDevice {
  id: string;
  label: string;
}

/** Where the recorder is: setting up, starting the recorders, recording, or saving after End. */
export type ShootPhase = "idle" | "starting" | "recording" | "ending";

/** Everything the Shoot view shows. */
export interface ShootState {
  /** Device labels readable (camera and mic permission given); null until known. */
  access: boolean | null;
  accessError: string | null;
  cameras: ShootDevice[];
  mics: ShootDevice[];
  camera: string | null;
  mic: string | null;
  screen: ShootScreenSource | null;
  systemAudio: boolean;
  support: ShootSupport["systemAudio"] | null;
  /** Frameshell's windows hide from screen captures while recording; null until known. */
  protection: boolean | null;
  /** Screens and windows offered; null until asked for. */
  screens: ShootScreenSource[] | null;
  screensError: string | null;
  /** Live streams for the previews: the camera's, the screen's (also carrying system audio when on). */
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
  /** Levels, dBFS. */
  micLevel: number;
  systemLevel: number;
  /** System audio is on and has been silent for 10 s. */
  systemSilent: boolean;
  phase: ShootPhase;
  /** `performance.now()` when recording began. */
  startedAt: number | null;
  error: string | null;
  /** The session finished last here: by End, or recovered after a crash. */
  finished: ShootFinish | null;
}

const LEVEL_MS = 100;

/**
 * Create a recorder store. The app has one ({@link shoot}); it needs the
 * browser's media APIs and `window.frameshell.shoot`.
 */
export function createShootRecorder() {
  let state: ShootState = {
    access: null,
    accessError: null,
    cameras: [],
    mics: [],
    camera: null,
    mic: null,
    screen: null,
    systemAudio: false,
    support: null,
    protection: null,
    screens: null,
    screensError: null,
    cameraStream: null,
    screenStream: null,
    micLevel: -100,
    systemLevel: -100,
    systemSilent: false,
    phase: "idle",
    startedAt: null,
    error: null,
    finished: null,
  };
  const listeners = new Set<() => void>();
  let micStream: MediaStream | null = null;
  let audio: AudioContext | null = null;
  const meters = new Map<"mic" | "system", { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>();  let meterTimer: number | undefined;
  let silence: number | null = null;
  let initialized = false;
  let mounted = 0;
  let releaseTimer: number | undefined;
  let session: { id: string; recorders: { role: ShootRole; recorder: MediaRecorder; queue: Promise<void> }[] } | null = null;
  /** `performance.now()` of the first recorder's start: 0 on the session clock (the group clock). */
  let origin: number | null = null;
  let beforeEnd: (() => Promise<void>) | null = null;

  const set = (next: Partial<ShootState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const api = () => window.frameshell.shoot;
  const message = (error: unknown) => (error as Error)?.message ?? String(error);
  const busy = () => state.phase !== "idle";

  async function refreshDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const list = (kind: MediaDeviceKind) =>
      devices.filter((device) => device.kind === kind && device.deviceId).map((device) => ({ id: device.deviceId, label: device.label }));
    const cameras = list("videoinput");
    const mics = list("audioinput");
    const access = devices.some((device) => device.label !== "");
    set({ cameras, mics, access });
    if (access && state.mic === null && mics.length > 0 && !busy()) await store.selectMic(mics[0]!.id);
  }

  function meter(kind: "mic" | "system", stream: MediaStream | null): void {
    const old = meters.get(kind);
    old?.source.disconnect();
    meters.delete(kind);
    const track = stream?.getAudioTracks()[0];
    if (!track) {
      set(kind === "mic" ? { micLevel: -100 } : { systemLevel: -100, systemSilent: false });
      if (kind === "system") silence = null;
      return;
    }
    audio ??= new AudioContext();
    void audio.resume().catch(() => undefined);
    // Analysed only, never connected to the output: the mic must not play back.
    const source = audio.createMediaStreamSource(new MediaStream([track]));
    const analyser = audio.createAnalyser();
    analyser.fftSize = meterWindow(audio.sampleRate, LEVEL_MS);
    source.connect(analyser);
    meters.set(kind, { analyser, source });
    meterTimer ??= window.setInterval(readLevels, LEVEL_MS);
  }

  function readLevels(): void {
    const level = (kind: "mic" | "system") => {
      const node = meters.get(kind);
      if (!node) return LEVEL_FLOOR;
      const buffer = new Float32Array(node.analyser.fftSize);
      node.analyser.getFloatTimeDomainData(buffer);
      return levelDb(buffer);
    };
    const mic = level("mic");
    const system = level("system");
    const now = performance.now();
    // The silence check reads the level as it is; the meters hold peaks so a short sound is seen.
    silence = state.systemAudio && meters.has("system") ? silentSince(silence, system, now) : null;
    set({
      micLevel: meters.has("mic") ? heldLevel(state.micLevel, mic, LEVEL_MS) : LEVEL_FLOOR,
      systemLevel: meters.has("system") ? heldLevel(state.systemLevel, system, LEVEL_MS) : LEVEL_FLOOR,
      systemSilent: silentTooLong(silence, now),
    });
    if (meters.size === 0) {
      window.clearInterval(meterTimer);
      meterTimer = undefined;
    }
  }

  function stopStream(stream: MediaStream | null): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
  }

  /** Display capture for the picked screen and system audio; none when neither is wanted. */
  async function openDisplay(): Promise<void> {
    stopStream(state.screenStream);
    set({ screenStream: null });
    meter("system", null);
    if (!state.screen && !state.systemAudio) return;
    await api().pickScreen(state.screen?.id ?? null, state.systemAudio);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: state.systemAudio });
    const video = stream.getVideoTracks()[0];
    const settings = video?.getSettings();
    const capped = settings?.width && settings.height ? capSize(settings.width, settings.height) : null;
    if (video && capped) await video.applyConstraints({ width: capped.width, height: capped.height }).catch(() => undefined);
    set({ screenStream: stream });
    meter("system", state.systemAudio ? stream : null);
  }

  function releaseAll(): void {
    stopStream(micStream);
    micStream = null;
    stopStream(state.cameraStream);
    stopStream(state.screenStream);
    meter("mic", null);
    meter("system", null);
    set({ cameraStream: null, screenStream: null, camera: null, mic: null, screen: null, systemAudio: false });
  }

  const store = {
    /** Current state; the same object until it changes. */
    get: (): ShootState => state,
    /** The recording session and the time on its clock now, s; null while none records. */
    clock(): { session: string; seconds: number } | null {
      if (!session || origin === null || state.phase !== "recording") return null;
      return { session: session.id, seconds: Math.max(0, (performance.now() - origin) / 1000) };
    },
    /** Run `work` when End is pressed, before the recorders stop (the takes store cuts an open take). */
    setBeforeEnd(work: (() => Promise<void>) | null): void {
      beforeEnd = work;
    },
    /** Call `listener` after every change. Returns an unsubscribe function. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * A Shoot view mounted: read devices and support the first time. Returns its unmount, which frees the devices
     * a second after the last view goes, unless a session records.
     */
    mount(): () => void {
      mounted++;
      window.clearTimeout(releaseTimer);
      if (!initialized) {
        initialized = true;
        navigator.mediaDevices.addEventListener("devicechange", () => void refreshDevices());
        void refreshDevices();
        void api()
          .support()
          .then(
            ({ systemAudio, contentProtection }) => set({ support: systemAudio, protection: contentProtection }),
            () => set({ support: "linux", protection: false }),
          );
        void api()
          .recovered()
          .then((list) => list.at(-1) && set({ finished: list.at(-1)! }), () => undefined);
        api().onRecovered((finish) => set({ finished: finish }));
      }
      return () => {
        mounted--;
        if (mounted > 0) return;
        releaseTimer = window.setTimeout(() => mounted === 0 && !busy() && releaseAll(), 1000);
      };
    },

    /** Ask for camera and microphone (labels come with the permission). */
    async requestAccess(): Promise<void> {
      try {
        const stream = await navigator.mediaDevices
          .getUserMedia({ audio: true, video: true })
          .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
        stopStream(stream);
        set({ accessError: null });
      } catch (error) {
        set({ accessError: message(error) });
      }
      await refreshDevices();
    },

    async selectCamera(id: string | null): Promise<void> {
      if (busy()) return;
      stopStream(state.cameraStream);
      set({ camera: id, cameraStream: null, error: null });
      if (!id) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: id }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        });
        if (state.camera !== id) return stopStream(stream);
        set({ cameraStream: stream });
      } catch (error) {
        set({ camera: null, error: message(error) });
      }
    },

    async selectMic(id: string | null): Promise<void> {
      if (busy()) return;
      stopStream(micStream);
      micStream = null;
      meter("mic", null);
      set({ mic: id, error: null });
      if (!id) return;
      try {
        // A shoot records the voice as it is: no echo cancelling, noise suppression or gain riding.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        if (state.mic !== id) return stopStream(stream);
        micStream = stream;
        meter("mic", stream);
      } catch (error) {
        set({ mic: null, error: message(error) });
      }
    },

    /** Load the screens and windows to pick from. */
    async loadScreens(): Promise<void> {
      try {
        set({ screens: await api().screens(), screensError: null });
      } catch (error) {
        set({ screensError: message(error) });
      }
    },

    async selectScreen(screen: ShootScreenSource | null): Promise<void> {
      if (busy()) return;
      set({ screen, error: null });
      await openDisplay().catch((error: unknown) => set({ screen: null, error: message(error) }));
    },

    async setSystemAudio(on: boolean): Promise<void> {
      if (busy() || (on && state.support !== "available")) return;
      set({ systemAudio: on, error: null });
      await openDisplay().catch((error: unknown) => set({ systemAudio: false, error: message(error) }));
    },

    /** Start a session recording every picked source. Needs a microphone. */
    async start(): Promise<void> {
      if (busy() || !micStream) return;
      set({ phase: "starting", error: null, finished: null });
      const tracks: { role: ShootRole; track: MediaStreamTrack; label: string }[] = [];
      const camera = state.cameraStream?.getVideoTracks()[0];
      if (camera) tracks.push({ role: "camera", track: camera, label: deviceLabel(state.cameras, state.camera) });
      const screen = state.screen ? state.screenStream?.getVideoTracks()[0] : undefined;
      if (screen) tracks.push({ role: "screen", track: screen, label: state.screen!.name });
      tracks.push({ role: "mic", track: micStream.getAudioTracks()[0]!, label: deviceLabel(state.mics, state.mic) });
      const system = state.systemAudio ? state.screenStream?.getAudioTracks()[0] : undefined;
      if (system) tracks.push({ role: "system", track: system, label: "System audio" });
      let id: string | null = null;
      try {
        const specs: ShootSourceSpec[] = tracks.map(({ role, track, label }) => {
          const mime = pickType(track.kind === "video" ? "video" : "audio", (type) => MediaRecorder.isTypeSupported(type));
          if (!mime) throw new Error(`no recording format for ${track.kind}`);
          return { role, mime, label: label || role };
        });
        const opened = await api().begin(specs);
        id = opened;
        const recorders = tracks.map(({ role, track }, i) => ({
          role,
          recorder: new MediaRecorder(new MediaStream([track]), recorderOptions(specs[i]!.mime, track.kind)),
          queue: Promise.resolve(),
        }));
        for (const entry of recorders) {
          entry.recorder.ondataavailable = (event) => {
            if (event.data.size === 0) return;
            // Chained per recorder: chunks reach main in the order they were recorded.
            entry.queue = entry.queue
              .then(async () => api().chunk(opened, entry.role, new Uint8Array(await event.data.arrayBuffer())))
              .catch((error: unknown) => set({ error: message(error) }));
          };
        }
        session = { id: opened, recorders };
        // `performance.now()` right before each `start()` predicts where its file's time 0 is (spike Q3, ~2 ms).
        const starts: Partial<Record<ShootRole, number>> = {};
        for (const { role, recorder } of recorders) {
          starts[role] = performance.now();
          recorder.start(1000);
        }
        origin = Math.min(...Object.values(starts));
        set({ phase: "recording", startedAt: performance.now() });
        await api().started(opened, starts);
      } catch (error) {
        set({ error: message(error) });
        if (session) await store.end();
        else {
          // Begun but no recorder started: main still keeps the session; End leaves nothing behind.
          if (id) await api().end(id).catch(() => undefined);
          set({ phase: "idle", startedAt: null });
        }
      }
    },

    /** Stop every recorder, hand over the last chunks, and let main finish the session. */
    async end(): Promise<void> {
      const current = session;
      if (!current || state.phase === "ending") return;
      // An open take is cut first, while the session clock still runs.
      await beforeEnd?.().catch((error: unknown) => set({ error: message(error) }));
      set({ phase: "ending" });
      await Promise.all(
        current.recorders.map(
          ({ recorder }) =>
            new Promise<void>((resolve) => {
              if (recorder.state === "inactive") return resolve();
              recorder.addEventListener("stop", () => resolve(), { once: true });
              recorder.stop();
            }),
        ),
      );
      // The last `dataavailable` comes before `stop`; its chunk joins the queue then.
      await Promise.all(current.recorders.map((entry) => entry.queue));
      session = null;
      try {
        const finished = await api().end(current.id);
        set({ phase: "idle", startedAt: null, finished });
      } catch (error) {
        set({ phase: "idle", startedAt: null, error: message(error) });
      }
      if (mounted === 0) releaseAll();
    },
  };
  return store;
}

/**
 * A keyframe every second: MP4 fragments, and so the chunks that reach disk, follow keyframes, and without this a
 * still camera or screen can go many seconds without one, all lost in a crash. Chromium 125+; ignored elsewhere,
 * and not in TypeScript's DOM types yet.
 */
function recorderOptions(mimeType: string, kind: string): MediaRecorderOptions {
  return kind === "video" ? ({ mimeType, videoKeyFrameIntervalDuration: 1000 } as MediaRecorderOptions) : { mimeType };
}

function deviceLabel(devices: readonly ShootDevice[], id: string | null): string {
  return devices.find((device) => device.id === id)?.label ?? "";
}

/** The app's one shoot recorder. */
export const shoot = createShootRecorder();

/** The recorder's state, re-rendering on change. */
export function useShoot(): ShootState {
  return useSyncExternalStore(shoot.subscribe, shoot.get);
}

/** True while a session records (or is starting or saving): the preview keeps quiet then (ADR 0024 decision 7). */
export function useShootRecording(): boolean {
  return useSyncExternalStore(shoot.subscribe, () => shoot.get().phase !== "idle");
}
