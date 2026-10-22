/*
 * Hero carousel and project tree. One real clip; each part adds a layer, introduced by a title
 * while the request types itself out, then the clip plays once the agent answers. It waits for a
 * click to start, so it can play with sound (browsers mute media that starts by itself).
 * Times are source seconds of the clip, from its word-level transcript.
 *
 * Markup hooks (Showcase.astro): <template data-if="key"> mounts its content while key is true
 * (a fresh mount restarts its CSS animations), data-style/-class/-aria/-text bind values,
 * data-list containers are filled here, data-on names a click handler.
 */

import { runtime } from "./i18n";

const TOTAL = 9.44;
const GAP_IN = 1.36;
const GAP_OUT = 3.18;
const GAP = GAP_OUT - GAP_IN;
const SHORT_IN = 3.18;
const SHORT_OUT = 7.6;
// Logo and drawing: the chalk starts to clear after "a mess." and the sponsor card lands just
// before "Brought to you by our sponsor." (7.84).
const CHALK_OUT = 7.05;
const SPONSOR_IN = 7.6;
const TOUR_MS = 10500;
const TYPE_MS = 28;
const TITLE_MS = 700;
const REPLY_HOLD_MS = 1200;
const FILE_MS = 4200;

const STR = runtime();
const LABELS = STR.labels;
const ASKS = STR.asks;

interface Cue {
  a: number;
  b: number;
  t: string;
  hot?: boolean;
}
const CUES: Cue[] = [
  { a: 0.18, b: 0.47, t: "What can't" },
  { a: 0.47, b: 0.81, t: "you edit" },
  { a: 0.81, b: 1.36, t: "without?" },
  { a: 3.18, b: 3.9, t: "A good" },
  { a: 3.9, b: 4.82, t: "timeline.", hot: true },
  { a: 4.82, b: 5.0, t: "If your" },
  { a: 5.0, b: 5.81, t: "timeline's a" },
  { a: 5.81, b: 6.32, t: "mess,", hot: true },
  { a: 6.32, b: 6.96, t: "your video's" },
  { a: 6.96, b: 7.6, t: "a mess.", hot: true },
  { a: 7.84, b: 8.02, t: "Brought to" },
  { a: 8.02, b: 8.32, t: "you by" },
  { a: 8.32, b: 9.3, t: "our sponsor.", hot: true },
];
// From audio: when each beat of the animation starts, from the words it illustrates. Her question
// (question marks), "A good" (play), "timeline." (a clean track), "If your" (the track tangles),
// "mess," (play greys out), "your video's" (worried face, more knots), the sponsor line (resolved).
const AUDIO_BEATS = [CUES[0].a, CUES[3].a, CUES[4].a, CUES[5].a, CUES[7].a, CUES[8].a, CUES[10].a - 0.15];
// Demo multicam angles, by index (wide, him, her): crops of the one clip, zoomed by `k` around
// (ox, oy), fractions of the frame. Colours paint the angle's tile and its shots, as the app does.
const ANGLES = [
  { k: 1, ox: 0.5, oy: 0.5, color: "#7092c4", dark: "#3f5373" },
  { k: 1.7, ox: 0.88, oy: 0.36, color: "#66c2e0", dark: "#2b5260" },
  { k: 1.6, ox: 0.06, oy: 0.36, color: "#d98aa6", dark: "#5b3a47" },
];
// What the director picks: her question, his answer with a wide cutaway when it runs long, her.
const SHOTS = [
  { a: 0, b: GAP_IN, angle: 2, label: STR.shots[0] },
  { a: GAP_OUT, b: 6.32, angle: 1, label: STR.shots[1] },
  { a: 6.32, b: 7.6, angle: 0, label: STR.shots[2] },
  { a: 7.6, b: TOTAL, angle: 2, label: STR.shots[3] },
];
// Who is speaking, from the transcript: her until the cut and from the sponsor line, him between.
const speaking = (angle: number, t: number) =>
  angle === 2 ? (t >= 0.18 && t < GAP_IN) || (t >= 7.84 && t < 9.3) : angle === 1 && t >= GAP_OUT && t < SHORT_OUT;
const DIRECT = 2;
const OVERLAY = 3;
const SHORT = 4;
const AUDIO = 5;
const TOUR = 6;

// Project folder; `f` is the preview a file opens, `by` who made it.
type By = keyof typeof STR.by;
const TREE: { p: string; name: string; dir?: boolean; f?: number; by?: By }[] = [
  { p: "", name: "podcast-ep12/", dir: true },
  { p: "├─ ", name: "frameshell.json", f: -1 },
  { p: "├─ ", name: "assets/", dir: true },
  { p: "│  └─ ", name: "podcast-ep12.mp4", f: 0, by: "you" },
  { p: "├─ ", name: "transcripts/", dir: true },
  { p: "│  └─ ", name: "podcast-ep12.words.json", f: 1, by: "auto" },
  { p: "├─ ", name: "scripts/", dir: true },
  { p: "│  └─ ", name: "episode-12.md", f: 2, by: "youAgent" },
  { p: "├─ ", name: "timelines/", dir: true },
  { p: "│  ├─ ", name: "main.json", f: 3, by: "agentYou" },
  { p: "│  └─ ", name: "short-guest.json", f: 4, by: "agent" },
  { p: "├─ ", name: "compositions/", dir: true },
  { p: "│  ├─ ", name: "hyperframes/sketch/index.html", f: 5, by: "agent" },
  { p: "│  └─ ", name: "remotion/src/Explainer.tsx", f: 6, by: "agent" },
  { p: "└─ ", name: "exports/", dir: true },
  { p: "   ├─ ", name: "main-youtube-1080p.mp4", f: 7, by: "render" },
  { p: "   ├─ ", name: "short-guest-vertical-1080x1920.mp4", f: 8, by: "render" },
  { p: "   └─ ", name: "explainer.mp4", f: 6, by: "render" },
];
// Preview per file, by position; notes are translated (STR.notes).
const FILES: { path: string; live?: boolean }[] = [
  { path: "assets/podcast-ep12.mp4" },
  { path: "transcripts/podcast-ep12.words.json" },
  { path: "scripts/episode-12.md" },
  { path: "timelines/main.json" },
  { path: "timelines/short-guest.json" },
  { path: "compositions/hyperframes/sketch/index.html", live: true },
  { path: "compositions/remotion/src/Explainer.tsx", live: true },
  { path: "exports/main-youtube-1080p.mp4" },
  { path: "exports/short-guest-vertical-1080x1920.mp4" },
];
const BY_COLOR: Record<By, string> = {
  you: "#e3a53c",
  auto: "#a3a49f",
  youAgent: "#e3a53c",
  agentYou: "#66c2e0",
  agent: "#66c2e0",
  render: "#6fae8b",
};

interface State {
  slide: number;
  intro: boolean;
  ended: boolean;
  typed: number;
  cutDone: boolean;
  t: number;
  tourP: number;
  started: boolean;
  playing: boolean;
  soundOn: boolean;
  fi: number;
  treeSeen: boolean;
  pickedFile: boolean;
}

type Vals = Record<string, unknown>;

export function startShowcase(): void {
  const roots = [...document.querySelectorAll<HTMLElement>("[data-showcase], [data-showcase-project]")];
  const video = document.querySelector<HTMLVideoElement>("[data-showcase] [data-ref=video]");
  const tree = document.querySelector<HTMLElement>("[data-ref=tree]");
  if (!roots.length || !video) return;

  // Every cut is a seek. A server that ignores Range requests (Cloudflare preview deployments)
  // leaves the clip unseekable and the seek restarts it, so play it from memory instead.
  video.addEventListener(
    "loadedmetadata",
    () => {
      const v = video;
      if (v.seekable.length && v.seekable.end(0) >= v.duration - 0.1) return;
      fetch(v.currentSrc)
        .then((r) => (r.ok ? r.blob() : Promise.reject()))
        .then((blob) => {
          const at = v.currentTime;
          const playing = !v.paused;
          v.src = URL.createObjectURL(blob);
          v.currentTime = at;
          if (playing) v.play().catch(() => {});
        })
        .catch(() => {});
    },
    { once: true },
  );

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let state: State = {
    slide: 0,
    intro: false,
    ended: false,
    typed: 0,
    cutDone: false,
    t: 0,
    tourP: 0,
    started: false,
    playing: false,
    soundOn: false,
    fi: 0,
    treeSeen: false,
    pickedFile: false,
  };
  let introAt = 0;
  let startScheduled = false;
  let introTimer = 0;
  let tourMs = 0;
  let lastFrame = 0;
  let queued = false;

  const setState = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    if (!queued) {
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        render();
      });
    }
  };

  // --- carousel flow ---

  function goTo(i: number) {
    clearTimeout(introTimer);
    tourMs = 0;
    lastFrame = 0;
    startScheduled = false;
    introAt = performance.now();
    video!.muted = i === TOUR ? true : !state.soundOn;
    // Reset the clock with the clip, or layers timed to the clip read the last part's end time.
    setState({ slide: i, cutDone: false, intro: true, typed: 0, ended: false, t: i === SHORT ? SHORT_IN : 0, tourP: 0 });
    video!.pause();
    video!.currentTime = i === SHORT ? SHORT_IN : 0;
  }

  // First click, on the big play button or a part's tab: sound on. play() inside the click lets later
  // plays of this element keep their sound (Safari); goTo pauses it again for the part's intro.
  function begin(i: number) {
    setState({ started: true, soundOn: true });
    video!.muted = false;
    video!.play().catch(() => {});
    goTo(i);
  }

  function startVideo() {
    clearTimeout(introTimer);
    setState({ intro: false, typed: ASKS[state.slide].length });
    if (still) return;
    video!.play().catch((error: DOMException) => {
      // Sound refused after all: play muted, the sound button turns it on.
      if (error.name !== "NotAllowedError" || video!.muted) return;
      video!.muted = true;
      setState({ soundOn: false });
      video!.play().catch(() => {});
    });
  }

  const next = () => goTo((state.slide + 1) % LABELS.length);

  // The request types itself out under the step title; one beat after the reply, the clip plays.
  setInterval(() => {
    const len = ASKS[state.slide].length;
    if (state.typed >= len) {
      if (state.intro && !startScheduled) {
        startScheduled = true;
        introTimer = window.setTimeout(startVideo, still ? 0 : REPLY_HOLD_MS);
      }
      return;
    }
    if (still) setState({ typed: len });
    else if (state.intro ? performance.now() - introAt > TITLE_MS : state.playing) setState({ typed: state.typed + 1 });
  }, TYPE_MS);

  function tick() {
    requestAnimationFrame(tick);
    if (state.intro || state.ended) return;
    const s = state.slide;
    let t = video!.currentTime;
    if (s === TOUR) {
      const now = performance.now();
      if (state.playing && lastFrame) tourMs += now - lastFrame;
      lastFrame = now;
      if (tourMs >= TOUR_MS + 300) {
        // Last part: stop on the final frame so the visitor can follow the link.
        setState({ ended: true, tourP: 1 });
        video!.pause();
        return;
      }
      const rp = Math.round(Math.min(1, tourMs / TOUR_MS) * 200) / 200;
      if (rp !== state.tourP) setState({ tourP: rp });
    }
    if (s === 1 && !state.cutDone && t >= 0.9) setState({ cutDone: true });
    const cut = s >= 2 || (s === 1 && state.cutDone);
    if (cut && t > GAP_IN && t < GAP_OUT) {
      video!.currentTime = GAP_OUT;
      t = GAP_OUT;
    }
    if (s === SHORT) {
      if (t < SHORT_IN - 0.05) {
        video!.currentTime = SHORT_IN;
        t = SHORT_IN;
      }
      if (t >= SHORT_OUT) {
        next();
        return;
      }
    }
    const rounded = Math.round(t * 20) / 20;
    if (rounded !== state.t) setState({ t: rounded });
    if (s === DIRECT) drawAngles();
  }

  /** Paints each angle tile of the director part with its crop of the playing clip. */
  function drawAngles() {
    const v = video!;
    if (v.readyState < 2 || !v.videoWidth) return;
    for (const c of document.querySelectorAll<HTMLCanvasElement>("[data-showcase] canvas[data-angle]")) {
      const a = ANGLES[Number(c.dataset.angle)];
      const w = v.videoWidth / a.k;
      const h = v.videoHeight / a.k;
      c.getContext("2d")?.drawImage(v, a.ox * (v.videoWidth - w), a.oy * (v.videoHeight - h), w, h, 0, 0, c.width, c.height);
    }
  }

  video.addEventListener("play", () => setState({ playing: true }));
  video.addEventListener("pause", () => setState({ playing: false }));
  video.addEventListener("ended", () => {
    if (state.slide === TOUR) {
      if (!state.ended) {
        video.currentTime = 0;
        video.play().catch(() => {});
      }
    } else next();
  });

  const handlers: Record<string, () => void> = {
    togglePlay() {
      if (!state.started) begin(0);
      else if (state.ended) goTo(0);
      else if (state.intro) startVideo();
      else if (video.paused) video.play().catch(() => {});
      else video.pause();
    },
    toggleSound() {
      const on = !state.soundOn;
      if (state.slide !== TOUR) video.muted = !on;
      setState({ soundOn: on });
    },
  };

  for (const root of roots) {
    root.addEventListener("click", (e) => {
      const el = (e.target as Element).closest<HTMLElement>("[data-on], [data-pick], [data-file]");
      if (!el) return;
      if (el.dataset.on) handlers[el.dataset.on]?.();
      else if (el.dataset.pick) (state.started ? goTo : begin)(Number(el.dataset.pick));
      else if (el.dataset.file) setState({ fi: Number(el.dataset.file), pickedFile: true });
    });
  }

  // --- project tree: starts its tour once on screen ---
  if (tree && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setState({ treeSeen: true });
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(tree);
  } else setState({ treeSeen: true });
  setInterval(() => {
    if (state.treeSeen && !state.pickedFile && !still) setState({ fi: (state.fi + 1) % FILES.length });
  }, FILE_MS);

  // --- values for the markup (the canvas renderVals) ---

  function values(): Vals {
    const s = state.slide;
    const t = state.t;
    const intro = state.intro;
    const applied = !intro || state.typed >= ASKS[s].length;
    const cut = s >= 2 || (s === 1 && state.cutDone);
    const x = (sec: number) => (cut ? (sec >= GAP_OUT ? sec - GAP : Math.min(sec, GAP_IN)) : sec);
    const pct = (sec: number) => (x(sec) / TOTAL) * 100;
    const box = (a: number, b: number) =>
      "left: " + pct(a).toFixed(2) + "%; width: " + Math.max(0, pct(b) - pct(a)).toFixed(2) + "%;";

    const cues = (s === 0 && !applied ? [] : CUES).map((c) => ({
      text: c.t,
      style: box(c.a, c.b) + " border-radius: 3px; background: #4a3a55; box-shadow: inset 0 2px 0 #b48acb; padding: 0 5px; font-size: 11px",
    }));
    const VIDEO = "background-color: #3f5373; box-shadow: inset 0 2px 0 #7092c4;";
    const VOICE =
      "background: repeating-linear-gradient(90deg, rgba(143,209,171,0.55) 0 3px, transparent 3px 6px) center / 100% 70% no-repeat, #2f4a3c; box-shadow: inset 0 2px 0 #6fae8b;";
    const HATCH =
      "background: repeating-linear-gradient(-45deg, rgba(224,103,95,0.65) 0 3px, transparent 3px 7px), #3b2a2c; box-shadow: inset 0 2px 0 #e0675f;";
    const gapStyle = (base: string) => box(GAP_IN, GAP_OUT) + (s === 1 && !cut && applied ? HATCH : base);
    const directed = s === DIRECT && applied;
    const fromAudio = s === AUDIO && applied;
    const videoSegs = directed
      ? SHOTS.map((shot) => {
          const a = ANGLES[shot.angle];
          return {
            text: shot.label,
            style: box(shot.a, shot.b) + "background-color: " + a.dark + "; box-shadow: inset 0 2px 0 " + a.color + "; border-radius: 3px; border-right: 2px solid #1d1e20",
          };
        })
      : [
            {
              text: fromAudio ? "background.png" : "podcast-ep12.mp4",
              style: box(0, GAP_IN) + VIDEO + (cut ? " border-radius: 3px; border-right: 2px solid #1d1e20" : " border-radius: 3px 0 0 3px"),
            },
            { text: s === 1 && !cut && applied ? STR.silence : "", style: gapStyle(VIDEO) + " color: #ffd2cc" },
            { text: "", style: box(GAP_OUT, TOTAL) + VIDEO + (cut ? " border-radius: 3px" : " border-radius: 0 3px 3px 0") },
          ];
    const voiceSegs = [
      { text: "", style: box(0, GAP_IN) + VOICE + " border-radius: 3px 0 0 3px" },
      { text: "", style: gapStyle("background: #2f4a3c; box-shadow: inset 0 2px 0 #6fae8b;") },
      { text: "", style: box(GAP_OUT, TOTAL) + VOICE + " border-radius: 0 3px 3px 0" },
    ];

    const shot = s === DIRECT && !intro ? SHOTS.find((sh) => t >= sh.a && t < sh.b) : null;
    const angle = shot ? shot.angle : 0;
    const view = ANGLES[angle];
    const base = "display: block; width: 100%; height: 100%; object-fit: cover; ";
    let videoStyle =
      base +
      (view.k === 1
        ? "object-position: 50% 50%; transform: none;"
        : "transform: scale(" + view.k + "); transform-origin: " + view.ox * 100 + "% " + view.oy * 100 + "%;");
    const isVertical = s === SHORT;
    if (isVertical) videoStyle = base + "object-position: 84% 50%; transform: none;";
    const sponsorOn = s === OVERLAY && !intro && t >= SPONSOR_IN;
    videoStyle += intro
      ? " filter: grayscale(1) brightness(0.55);"
      : sponsorOn
        ? " filter: brightness(0.5) saturate(0.75);"
        : " filter: none;";
    videoStyle += " transition: filter .8s ease;";

    const tourOn = s === TOUR && !intro;
    const viewStyle = isVertical
      ? "position: absolute; top: 0; bottom: 0; left: 50%; width: 31.64%; transform: translateX(-50%); overflow: hidden; box-shadow: 0 0 0 2px #e3a53c, 0 20px 60px rgba(0,0,0,0.6); z-index: 2"
      : tourOn
        ? "position: absolute; inset: 0; overflow: hidden; z-index: 3; box-shadow: 0 2cqw 6cqw rgba(0,0,0,0.6); transform-origin: 0 0; animation: intoApp " +
          TOUR_MS +
          "ms cubic-bezier(.5,0,.2,1) forwards"
        : "position: absolute; inset: 0; overflow: hidden";

    const cue = CUES.find((c, i) => t >= c.a && t < (CUES[i + 1] && CUES[i + 1].a - c.b < 0.6 ? CUES[i + 1].a : c.b + 0.3));
    const showCaption = !!cue && !intro && s <= AUDIO && (!isVertical || (t >= SHORT_IN && t < SHORT_OUT));
    const captionStyle =
      (isVertical
        ? "position: absolute; left: 6%; right: 6%; bottom: 22%; font-size: 3.6cqw; line-height: 1.05;"
        : s === AUDIO
          ? "position: absolute; left: 0; right: 0; bottom: 8%; font-size: 3cqw;"
          : "position: absolute; left: 0; right: 0; bottom: 7%; font-size: 3.8cqw;") +
      " margin: 0; text-align: center; font-weight: 900; font-stretch: 112%; text-transform: uppercase; letter-spacing: -0.01em; text-shadow: 0 0.3cqw 1.2cqw rgba(0,0,0,0.75), 0 0 0.2cqw rgba(0,0,0,0.9); color: " +
      (cue && cue.hot ? "#e3a53c" : "#ffffff");

    // Rows above Voice that the playhead spans (26 px lane + 6 px gap each), plus the video row.
    const overlays = s === OVERLAY && applied;
    const reach = ((s <= AUDIO ? 1 : 0) + (overlays ? 2 : 0) + (fromAudio ? 1 : 0) + 1) * 32 + 8;
    // Without motion the clip never plays: show the tangled beat as the still.
    const beatsAt = still ? AUDIO_BEATS[5] : t;
    const two = (n: number) => String(Math.floor(n)).padStart(2, "0");
    const file = FILES[state.fi];

    const vals: Vals = {
      slides: s,
      cues,
      videoSegs,
      voiceSegs,
      tree: state.fi,
      treeSeen: state.treeSeen,
      filePath: file.path,
      fileNote: STR.notes[state.fi],
      fileLive: !!file.live,
      intro,
      introNum: String(s + 1).padStart(2, "0"),
      introTitle: LABELS[s],
      veilStyle: intro ? "opacity: 1" : "opacity: 0",
      askTyped: ASKS[s].slice(0, state.typed),
      typing: state.typed < ASKS[s].length,
      replyOn: state.typed >= ASKS[s].length,
      drawOn: s === OVERLAY && !intro,
      anglesOn: s === DIRECT && !intro,
      audioOn: fromAudio,
      videoRowLabel: directed ? STR.rowProgram : STR.rowVideo,
      tourOn,
      tourBadge: tourOn,
      frameCls: state.playing || intro ? "" : "paused",
      soundAvail: s !== TOUR,
      clock:
        s === TOUR
          ? "0:" + two((state.tourP * TOUR_MS) / 1000) + " / 0:" + two(Math.round(TOUR_MS / 1000))
          : "0:" + two(x(t)) + " / 0:" + two(Math.round(x(TOTAL))),
      progressStyle:
        "display: block; height: 100%; border-radius: 1cqw; background: #e3a53c; width: " +
        (s === TOUR ? state.tourP * 100 : (x(t) / x(TOTAL)) * 100).toFixed(1) +
        "%",
      hasAnim: overlays || fromAudio,
      animLabel: fromAudio ? "dialogue/index.html (HyperFrames)" : "sketch/index.html (HyperFrames)",
      animStyle:
        box(0, fromAudio ? TOTAL : CHALK_OUT + 0.9) + " border-radius: 3px; background: #2b5260; box-shadow: inset 0 2px 0 #66c2e0; font-size: 11px",
      chalkCls: "chalk" + (t >= CHALK_OUT ? " out" : ""),
      sponsorCls: "sponsor" + (sponsorOn ? " on" : ""),
      audCls: "aud" + AUDIO_BEATS.map((at, i) => (beatsAt >= at ? " b" + (i + 1) : "")).join(""),
      videoRowStyle: "position: relative; height: 26px",
      isVertical,
      videoStyle,
      viewStyle,
      showCaption,
      caption: cue ? cue.t : "",
      captionStyle,
      hasLogo: overlays,
      shortOn: s === SHORT && applied,
      rowSubs: s <= AUDIO,
      logoStyle: box(SPONSOR_IN, TOTAL) + " border-radius: 3px; background: #5a4a2a; box-shadow: inset 0 2px 0 #e3a53c; font-size: 11px",
      shortStyle:
        "position: absolute; top: -" +
        reach +
        "px; bottom: -4px; " +
        box(SHORT_IN, SHORT_OUT) +
        " border: 2px solid #e3a53c; border-radius: 4px; background: rgba(227,165,60,0.08); pointer-events: none; z-index: 2",
      playheadStyle: "top: -" + reach + "px; left: " + pct(t).toFixed(2) + "%",
      started: state.started,
      waiting: !state.started,
      playing: state.playing,
      paused: !state.playing,
      playLabel: state.ended ? STR.watchAgain : state.playing ? STR.pause : STR.play,
      showTimeline: s !== TOUR,
      soundOn: state.soundOn,
      soundOff: !state.soundOn,
      soundLabel: state.soundOn ? STR.mute : STR.soundOn,
    };
    for (let i = 0; i < LABELS.length; i++) vals["s" + i] = s === i;
    ANGLES.forEach((a, i) => {
      const on = !!shot && shot.angle === i;
      vals["angle" + i] =
        "position: relative; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 0.6cqw; background: #0b0b0c; box-shadow: " +
        (on ? "0 0 0 0.3cqw " + a.color : "0 0 0 1px rgba(255,255,255,0.18)") +
        "; opacity: " +
        (on ? "1" : "0.72") +
        "; transition: opacity .2s, box-shadow .2s";
      vals["speak" + i] = speaking(i, t);
    });
    for (let i = 0; i < 9; i++) vals["f" + i] = state.fi === i;
    return vals;
  }

  // --- the little runtime ---

  const mounted = new Map<HTMLTemplateElement, Node[]>();

  function syncIfs(root: ParentNode, vals: Vals) {
    for (const tpl of root.querySelectorAll<HTMLTemplateElement>("template[data-if]")) {
      if (!tpl.isConnected) continue;
      const want = !!vals[tpl.dataset.if!];
      const nodes = mounted.get(tpl);
      if (want && !nodes) {
        const frag = tpl.content.cloneNode(true) as DocumentFragment;
        const list = [...frag.childNodes];
        tpl.after(frag);
        mounted.set(tpl, list);
      } else if (!want && nodes) unmount(tpl);
    }
  }

  /** Removes what `tpl` mounted, including blocks mounted by templates nested in it (they sit beside them). */
  function unmount(tpl: HTMLTemplateElement) {
    const nodes = mounted.get(tpl);
    if (!nodes) return;
    mounted.delete(tpl);
    for (const n of nodes) {
      if (n instanceof HTMLTemplateElement) unmount(n);
      else if (n instanceof Element) for (const inner of n.querySelectorAll<HTMLTemplateElement>("template[data-if]")) unmount(inner);
      n.parentNode?.removeChild(n);
    }
  }

  function bind(root: ParentNode, vals: Vals) {
    for (const el of root.querySelectorAll<HTMLElement>("[data-style]")) {
      const v = String(vals[el.dataset.style!] ?? "");
      if (el.getAttribute("style") !== v) el.setAttribute("style", v);
    }
    for (const el of root.querySelectorAll<HTMLElement>("[data-class]")) {
      const v = String(vals[el.dataset.class!] ?? "");
      if (el.className !== v) el.className = v;
    }
    for (const el of root.querySelectorAll<HTMLElement>("[data-aria]")) el.setAttribute("aria-label", String(vals[el.dataset.aria!] ?? ""));
    for (const el of root.querySelectorAll<HTMLElement>("[data-text]")) {
      const v = String(vals[el.dataset.text!] ?? "");
      if (el.textContent !== v) el.textContent = v;
    }
  }

  /** Index-keyed spans, so left/width changes animate instead of re-creating the clip. */
  function syncSegs(box: HTMLElement, items: { text: string; style: string }[]) {
    while (box.children.length > items.length) box.lastElementChild!.remove();
    items.forEach((it, i) => {
      let el = box.children[i] as HTMLElement | undefined;
      if (!el) {
        el = document.createElement("span");
        el.className = "seg";
        box.append(el);
      }
      if (el.getAttribute("style") !== it.style) el.setAttribute("style", it.style);
      if (el.textContent !== it.text) el.textContent = it.text;
    });
  }

  let tabsFor = -1;
  function renderTabs(box: HTMLElement, s: number) {
    if (tabsFor === s) return;
    tabsFor = s;
    box.innerHTML = LABELS.map(
      (label, i) =>
        `<button type="button" role="tab" class="tab${i === s ? " on" : ""}" aria-selected="${i === s}" data-pick="${i}">` +
        `<span class="mono" style="font-size: 12px; font-weight: 500; color: #8a8b8f">${String(i + 1).padStart(2, "0")}</span>` +
        `<span>${label}</span></button>`,
    ).join("");
  }

  let treeFor = -1;
  function renderTree(ul: HTMLElement, fi: number) {
    if (!ul.children.length) {
      ul.innerHTML = TREE.map((r, i) => {
        const selectable = typeof r.f === "number" && r.f >= 0;
        const color = r.by ? BY_COLOR[r.by] : "#6b6c70";
        if (r.dir)
          return `<li class="beat" style="--d: ${(i * 0.07).toFixed(2)}s"><span style="display: block; padding: 7px 8px; color: #a3a49f; white-space: nowrap"><span style="color: #4a4b50; white-space: pre">${r.p}</span>${r.name}</span></li>`;
        return (
          `<li class="beat" style="--d: ${(i * 0.07).toFixed(2)}s"><button type="button" ${selectable ? `data-file="${r.f}"` : "disabled"} data-row="${i}">` +
          `<span style="color: #4a4b50; white-space: pre">${r.p}</span>` +
          `<span style="flex: none; width: 7px; height: 7px; border-radius: 2px; background: ${selectable ? color : "#4a4b50"}"></span>` +
          `<span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${r.name}</span>` +
          `<span style="flex: none; font-size: 10.5px; color: ${color}">${r.by ? STR.by[r.by] : ""}</span></button></li>`
        );
      }).join("");
    }
    if (treeFor === fi) return;
    treeFor = fi;
    for (const btn of ul.querySelectorAll<HTMLButtonElement>("button[data-row]")) {
      const r = TREE[Number(btn.dataset.row)];
      const on = r.f === fi;
      const selectable = typeof r.f === "number" && r.f >= 0;
      btn.setAttribute(
        "style",
        "display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 0 8px; border: 0; border-radius: 6px; font: inherit; text-align: left; cursor: " +
          (selectable ? "pointer" : "default") +
          "; color: " +
          (on ? "#ffffff" : selectable ? "#e4e3dc" : "#6b6c70") +
          "; background: " +
          (on ? "rgba(227,165,60,0.14)" : "none") +
          "; box-shadow: " +
          (on ? "inset 2px 0 0 #e3a53c" : "none"),
      );
      btn.setAttribute("aria-current", on ? "true" : "false");
    }
  }

  function render() {
    const vals = values();
    for (const root of roots) {
      // Mount/unmount until stable: a newly mounted block can hold more data-if templates.
      for (let pass = 0; pass < 4; pass++) syncIfs(root, vals);
      bind(root, vals);
      for (const box of root.querySelectorAll<HTMLElement>("[data-list]")) {
        const key = box.dataset.list!;
        if (key === "slides") renderTabs(box, state.slide);
        else if (key === "tree") renderTree(box, state.fi);
        else syncSegs(box, vals[key] as { text: string; style: string }[]);
      }
    }
  }

  render();
  requestAnimationFrame(tick);
  video.muted = true;
  if (still) setState({ treeSeen: true });
}
