/*
 * Hero carousel and project tree. One real clip; each part adds a layer, introduced by a title
 * while the request types itself out, then the clip plays once the agent answers.
 * Times are source seconds of the clip, from its word-level transcript.
 *
 * Markup hooks (Showcase.astro): <template data-if="key"> mounts its content while key is true
 * (a fresh mount restarts its CSS animations), data-style/-class/-aria/-text bind values,
 * data-list containers are filled here, data-on names a click handler.
 */

const TOTAL = 9.44;
const GAP_IN = 1.36;
const GAP_OUT = 3.18;
const GAP = GAP_OUT - GAP_IN;
const SHORT_IN = 3.18;
const SHORT_OUT = 7.6;
const LOGO_IN = 7.6;
const TOUR_MS = 10500;
const TYPE_MS = 28;
const TITLE_MS = 700;
const REPLY_HOLD_MS = 1200;
const FILE_MS = 4200;

const LABELS = [
  "Subtitles",
  "Cut the pauses",
  "Focus on the speaker",
  "Sponsor logo",
  "Vertical short",
  "Draw over it",
  "Explain with animations",
];
const ASKS = [
  "Add subtitles from what they say, two words at a time.",
  "Cut the dead air after her question.",
  "Zoom in on whoever is talking.",
  "Put our sponsor's logo next to her when she mentions them.",
  "Make a vertical short of his answer for Reels and TikTok.",
  "Draw the table in chalk, point out who's who, and put the show's title on the wall.",
  "Make a new explainer video: pull this clip out of full screen, drop it into its project folder and open the folder to show what we made from it.",
];

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
// Hard-cut punch-ins: wide question, close on him, wide, close on her.
const SHOTS = [
  { a: 0, b: GAP_IN, zoom: "wide", label: "Wide" },
  { a: GAP_OUT, b: 6.32, zoom: "him", label: "Zoom on him" },
  { a: 6.32, b: 7.6, zoom: "wide", label: "Wide" },
  { a: 7.6, b: TOTAL, zoom: "her", label: "Zoom on her" },
];

// Project folder; `f` is the preview a file opens, `by` who made it.
const TREE: { p: string; name: string; dir?: boolean; f?: number; by?: string }[] = [
  { p: "", name: "podcast-ep12/", dir: true },
  { p: "├─ ", name: "frameshell.json", f: -1 },
  { p: "├─ ", name: "assets/", dir: true },
  { p: "│  └─ ", name: "podcast-ep12.mp4", f: 0, by: "you" },
  { p: "├─ ", name: "transcripts/", dir: true },
  { p: "│  └─ ", name: "podcast-ep12.words.json", f: 1, by: "auto" },
  { p: "├─ ", name: "scripts/", dir: true },
  { p: "│  └─ ", name: "episode-12.md", f: 2, by: "you + agent" },
  { p: "├─ ", name: "timelines/", dir: true },
  { p: "│  ├─ ", name: "main.json", f: 3, by: "agent + you" },
  { p: "│  └─ ", name: "short-guest.json", f: 4, by: "agent" },
  { p: "├─ ", name: "compositions/", dir: true },
  { p: "│  ├─ ", name: "hyperframes/sketch/index.html", f: 5, by: "agent" },
  { p: "│  └─ ", name: "remotion/src/Explainer.tsx", f: 6, by: "agent" },
  { p: "└─ ", name: "exports/", dir: true },
  { p: "   ├─ ", name: "main-youtube-1080p.mp4", f: 7, by: "render" },
  { p: "   ├─ ", name: "short-guest-vertical-1080x1920.mp4", f: 8, by: "render" },
  { p: "   └─ ", name: "explainer.mp4", f: 6, by: "render" },
];
const FILES: { path: string; note: string; live?: boolean }[] = [
  { path: "assets/podcast-ep12.mp4", note: "Your recording, untouched. The only file you bring; everything else branches off it." },
  { path: "transcripts/podcast-ep12.words.json", note: "Every spoken word with its time, written by the transcription plugin. Subtitles and clean cuts come from here." },
  { path: "scripts/episode-12.md", note: "The plan, kept as plain text next to the video. Write it yourself or ask the agent to; clips point back to the scene they play." },
  { path: "timelines/main.json", note: "The edited episode as one JSON file: every layer, every cut. You edit it in the timeline, the agent through the CLI." },
  { path: "timelines/short-guest.json", note: "A second timeline from the same recording. Make as many shorts as you want; none of them copies the footage." },
  {
    path: "compositions/hyperframes/sketch/index.html",
    note: "HyperFrames: the chalk table, the pointers and the show title from part 06, written in HTML and CSS and rendered with transparency over the footage. It plays live while it renders.",
    live: true,
  },
  {
    path: "compositions/remotion/src/Explainer.tsx",
    note: "Remotion: the explainer from part 07, written in React. It uses your clip as footage and renders to exports/explainer.mp4. It can even use components from your own app.",
    live: true,
  },
  { path: "exports/main-youtube-1080p.mp4", note: "The finished episode, rendered through ffmpeg with subtitles burned in and loudness evened out." },
  { path: "exports/short-guest-vertical-1080x1920.mp4", note: "The short, ready to post. Re-export any time the episode changes." },
];
const BY_COLOR: Record<string, string> = {
  you: "#e3a53c",
  auto: "#a3a49f",
  "you + agent": "#e3a53c",
  "agent + you": "#66c2e0",
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

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let state: State = {
    slide: 0,
    intro: false,
    ended: false,
    typed: 0,
    cutDone: false,
    t: 0,
    tourP: 0,
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
    video!.muted = i === 6 ? true : !state.soundOn;
    // Reset the clock with the clip, or layers timed to the clip read the last part's end time.
    setState({ slide: i, cutDone: false, intro: true, typed: 0, ended: false, t: i === 4 ? SHORT_IN : 0, tourP: 0 });
    video!.pause();
    video!.currentTime = i === 4 ? SHORT_IN : 0;
  }

  function startVideo() {
    clearTimeout(introTimer);
    setState({ intro: false, typed: ASKS[state.slide].length });
    if (!still) video!.play().catch(() => {});
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
    if (s === 6) {
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
    if (s === 4) {
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
  }

  video.addEventListener("play", () => setState({ playing: true }));
  video.addEventListener("pause", () => setState({ playing: false }));
  video.addEventListener("ended", () => {
    if (state.slide === 6) {
      if (!state.ended) {
        video.currentTime = 0;
        video.play().catch(() => {});
      }
    } else next();
  });

  const handlers: Record<string, () => void> = {
    togglePlay() {
      if (state.ended) goTo(0);
      else if (state.intro) startVideo();
      else if (video.paused) video.play().catch(() => {});
      else video.pause();
    },
    toggleSound() {
      const on = !state.soundOn;
      if (state.slide !== 6) video.muted = !on;
      setState({ soundOn: on });
    },
  };

  for (const root of roots) {
    root.addEventListener("click", (e) => {
      const el = (e.target as Element).closest<HTMLElement>("[data-on], [data-pick], [data-file]");
      if (!el) return;
      if (el.dataset.on) handlers[el.dataset.on]?.();
      else if (el.dataset.pick) goTo(Number(el.dataset.pick));
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
    const videoSegs =
      (s === 2 && applied) || s === 3
        ? SHOTS.map((shot) => ({ text: shot.label, style: box(shot.a, shot.b) + VIDEO + " border-radius: 3px; border-right: 2px solid #1d1e20" }))
        : [
            {
              text: "podcast-ep12.mp4",
              style: box(0, GAP_IN) + VIDEO + (cut ? " border-radius: 3px; border-right: 2px solid #1d1e20" : " border-radius: 3px 0 0 3px"),
            },
            { text: s === 1 && !cut && applied ? "silence" : "", style: gapStyle(VIDEO) + " color: #ffd2cc" },
            { text: "", style: box(GAP_OUT, TOTAL) + VIDEO + (cut ? " border-radius: 3px" : " border-radius: 0 3px 3px 0") },
          ];
    const voiceSegs = [
      { text: "", style: box(0, GAP_IN) + VOICE + " border-radius: 3px 0 0 3px" },
      { text: "", style: gapStyle("background: #2f4a3c; box-shadow: inset 0 2px 0 #6fae8b;") },
      { text: "", style: box(GAP_OUT, TOTAL) + VOICE + " border-radius: 0 3px 3px 0" },
    ];

    const shot = s === 2 || s === 3 ? SHOTS.find((sh) => t >= sh.a && t < sh.b) : null;
    const zoom = shot ? shot.zoom : "wide";
    const base = "display: block; width: 100%; height: 100%; object-fit: cover; ";
    let videoStyle = base + "object-position: 50% 50%; transform: none;";
    if (zoom === "him") videoStyle = base + "transform: scale(1.7); transform-origin: 88% 36%;";
    if (zoom === "her") videoStyle = base + "transform: scale(1.6); transform-origin: 6% 36%;";
    const isVertical = s === 4;
    if (isVertical) videoStyle = base + "object-position: 84% 50%; transform: none;";
    videoStyle += intro ? " filter: grayscale(1) brightness(0.55);" : " filter: none;";
    videoStyle += " transition: filter .4s ease;";

    const tourOn = s === 6 && !intro;
    const viewStyle = isVertical
      ? "position: absolute; top: 0; bottom: 0; left: 50%; width: 31.64%; transform: translateX(-50%); overflow: hidden; box-shadow: 0 0 0 2px #e3a53c, 0 20px 60px rgba(0,0,0,0.6); z-index: 2"
      : tourOn
        ? "position: absolute; inset: 0; overflow: hidden; z-index: 3; box-shadow: 0 2cqw 6cqw rgba(0,0,0,0.6); transform-origin: 0 0; animation: intoApp " +
          TOUR_MS +
          "ms cubic-bezier(.5,0,.2,1) forwards"
        : "position: absolute; inset: 0; overflow: hidden";

    const cue = CUES.find((c, i) => t >= c.a && t < (CUES[i + 1] && CUES[i + 1].a - c.b < 0.6 ? CUES[i + 1].a : c.b + 0.3));
    const showCaption = !!cue && !intro && s <= 4 && (!isVertical || (t >= SHORT_IN && t < SHORT_OUT));
    const captionStyle =
      (isVertical
        ? "position: absolute; left: 6%; right: 6%; bottom: 22%; font-size: 3.6cqw; line-height: 1.05;"
        : "position: absolute; left: 0; right: 0; bottom: 7%; font-size: 3.8cqw;") +
      " margin: 0; text-align: center; font-weight: 900; font-stretch: 112%; text-transform: uppercase; letter-spacing: -0.01em; text-shadow: 0 0.3cqw 1.2cqw rgba(0,0,0,0.75), 0 0 0.2cqw rgba(0,0,0,0.9); color: " +
      (cue && cue.hot ? "#e3a53c" : "#ffffff");

    // Rows above Voice that the playhead spans (26 px lane + 6 px gap each), plus the video row.
    const reach = ((s <= 4 ? 1 : 0) + (s === 3 && applied ? 1 : 0) + (s === 5 && applied ? 1 : 0) + 1) * 32 + 8;
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
      fileNote: file.note,
      fileLive: !!file.live,
      intro,
      introNum: String(s + 1).padStart(2, "0"),
      introTitle: LABELS[s],
      veilStyle: intro ? "opacity: 1" : "opacity: 0",
      askTyped: ASKS[s].slice(0, state.typed),
      typing: state.typed < ASKS[s].length,
      replyOn: state.typed >= ASKS[s].length,
      drawOn: s === 5 && !intro,
      tourOn,
      tourBadge: tourOn,
      frameCls: state.playing || intro ? "" : "paused",
      soundAvail: s !== 6,
      clock:
        s === 6
          ? "0:" + two((state.tourP * TOUR_MS) / 1000) + " / 0:" + two(Math.round(TOUR_MS / 1000))
          : "0:" + two(x(t)) + " / 0:" + two(Math.round(x(TOTAL))),
      progressStyle:
        "display: block; height: 100%; border-radius: 1cqw; background: #e3a53c; width: " +
        (s === 6 ? state.tourP * 100 : (x(t) / x(TOTAL)) * 100).toFixed(1) +
        "%",
      hasAnim: s === 5 && applied,
      animLabel: "sketch/index.html (HyperFrames)",
      animStyle: box(0, TOTAL) + " border-radius: 3px; background: #2b5260; box-shadow: inset 0 2px 0 #66c2e0; font-size: 11px",
      videoRowStyle: "position: relative; height: 26px",
      isVertical,
      videoStyle,
      viewStyle,
      showCaption,
      caption: cue ? cue.t : "",
      captionStyle,
      showLogo: s === 3 && !intro && t >= LOGO_IN,
      hasLogo: s === 3 && applied,
      shortOn: s === 4 && applied,
      rowSubs: s <= 4,
      logoStyle: box(LOGO_IN, TOTAL) + " border-radius: 3px; background: #5a4a2a; box-shadow: inset 0 2px 0 #e3a53c; font-size: 11px",
      shortStyle:
        "position: absolute; top: -" +
        reach +
        "px; bottom: -4px; " +
        box(SHORT_IN, SHORT_OUT) +
        " border: 2px solid #e3a53c; border-radius: 4px; background: rgba(227,165,60,0.08); pointer-events: none; z-index: 2",
      playheadStyle: "top: -" + reach + "px; left: " + pct(t).toFixed(2) + "%",
      playing: state.playing,
      paused: !state.playing,
      playLabel: state.ended ? "Watch again from the start" : state.playing ? "Pause" : "Play",
      showTimeline: s !== 6,
      soundOn: state.soundOn,
      soundOff: !state.soundOn,
      soundLabel: state.soundOn ? "Mute" : "Turn sound on",
    };
    for (let i = 0; i < 7; i++) vals["s" + i] = s === i;
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
        const color = BY_COLOR[r.by ?? ""] ?? "#6b6c70";
        if (r.dir)
          return `<li class="beat" style="--d: ${(i * 0.07).toFixed(2)}s"><span style="display: block; padding: 7px 8px; color: #a3a49f; white-space: nowrap"><span style="color: #4a4b50; white-space: pre">${r.p}</span>${r.name}</span></li>`;
        return (
          `<li class="beat" style="--d: ${(i * 0.07).toFixed(2)}s"><button type="button" ${selectable ? `data-file="${r.f}"` : "disabled"} data-row="${i}">` +
          `<span style="color: #4a4b50; white-space: pre">${r.p}</span>` +
          `<span style="flex: none; width: 7px; height: 7px; border-radius: 2px; background: ${selectable ? color : "#4a4b50"}"></span>` +
          `<span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${r.name}</span>` +
          `<span style="flex: none; font-size: 10.5px; color: ${color}">${r.by ?? ""}</span></button></li>`
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
  if (!still) goTo(0);
  else setState({ treeSeen: true });
}
