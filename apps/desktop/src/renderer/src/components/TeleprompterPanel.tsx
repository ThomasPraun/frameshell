import { type ShootScript, isScriptPath, parseShootScript } from "@frameshell/schema";
import { type KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n.js";
import {
  FONT_SIZES,
  type PromptLine,
  type PromptSentence,
  type PromptStream,
  type StopBox,
  focusOffset,
  glide,
  positionOf,
  promptStream,
  stepLine,
  stepWord,
  stopOf,
} from "../teleprompter/model.js";
import { teleprompter, useTeleprompter, useTeleprompterSettings } from "../teleprompter/store.js";
import { scriptFiles } from "../timeline/scenes.js";
import { elementOf, windowOf } from "../windows.js";

/**
 * Teleprompter (ADR 0024 decision 6): a shoot script with the word being said held on a focus line in the middle,
 * the text gliding up under it. Moved by keys here; its position lives in {@link teleprompter}, so the Shoot view
 * and live following read and drive the same one. Meant for its own window, on a second screen or a prompter.
 */
export function TeleprompterPanel() {
  const state = useTeleprompter();
  const settings = useTeleprompterSettings();
  const scripts = useShootScripts();
  const chosen = scripts.list?.find(({ path }) => path === state.script) ?? scripts.list?.[0] ?? null;
  const stream = useMemo(() => (chosen ? promptStream(chosen.script) : null), [chosen]);
  const current = stream && state.position ? stopOf(stream, state.position) : -1;

  useEffect(() => {
    if (chosen && chosen.path !== state.script) teleprompter.setScript(chosen.path);
  }, [chosen, state.script]);

  // No position in this script yet: start at the Shoot view's scene, else the shoot's next scene, else the first.
  const placed = current !== -1;
  useEffect(() => {
    if (!chosen || !stream || placed || stream.stops.length === 0) return;
    let live = true;
    void window.frameshell.shoot
      .status(chosen.path)
      .then((status) => status.next)
      .catch(() => null)
      .then((next) => {
        const now = teleprompter.get();
        if (!live || now.script !== chosen.path || (now.position && stopOf(stream, now.position) !== -1)) return;
        const scene = stream.scenes.find(({ slug, start, end }) => slug === next && end > start) ?? stream.scenes.find(({ start, end }) => end > start);
        const position = scene && positionOf(stream, scene.start);
        if (position) teleprompter.setPosition(position, "keys", chosen.path);
      });
    return () => {
      live = false;
    };
  }, [chosen, stream, placed]);

  const move = useCallback(
    (stop: number) => {
      const position = stream && positionOf(stream, stop);
      if (position) teleprompter.setPosition(position);
    },
    [stream],
  );

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!stream || event.metaKey || event.ctrlKey || event.altKey) return;
    const from = Math.max(0, current);
    if (event.key === "ArrowRight") move(stepWord(stream, from, 1));
    else if (event.key === "ArrowLeft") move(stepWord(stream, from, -1));
    else if (event.key === "ArrowDown") move(stepLine(stream, from, 1));
    else if (event.key === "ArrowUp") move(stepLine(stream, from, -1));
    else if (event.key === " ") teleprompter.setHeld(!state.held);
    else return;
    event.preventDefault();
  };

  const scene = stream && current !== -1 ? stream.scenes[stream.lines[stream.stops[current]!.line]!.scene]! : null;

  return (
    <div className="teleprompter" data-testid="teleprompter" data-held={state.held || undefined}>
      <div className="teleprompter-bar">
        {scripts.list && scripts.list.length > 1 && (
          <select
            className="teleprompter-select"
            aria-label={t.teleprompter.script}
            value={chosen?.path ?? ""}
            onChange={(event) => teleprompter.setScript(event.target.value)}
          >
            {scripts.list.map(({ path }) => (
              <option key={path} value={path}>
                {path.replace(/^scripts\//, "")}
              </option>
            ))}
          </select>
        )}
        {stream && stream.scenes.length > 0 && (
          <select
            className="teleprompter-select"
            aria-label={t.teleprompter.scene}
            data-testid="teleprompter-scene"
            value={scene?.slug ?? ""}
            onChange={(event) => {
              const target = stream.scenes.find(({ slug }) => slug === event.target.value);
              if (target) move(Math.min(target.start, stream.stops.length - 1));
            }}
          >
            {stream.scenes.map(({ slug, title }) => (
              <option key={slug} value={slug}>
                {title || slug}
              </option>
            ))}
          </select>
        )}
        <span className="teleprompter-tools">
          <button
            className="icon-button"
            aria-label={t.teleprompter.smaller}
            title={t.teleprompter.smaller}
            disabled={settings.fontSize <= FONT_SIZES.min}
            onClick={() => teleprompter.setSettings({ fontSize: settings.fontSize - FONT_SIZES.step })}
          >
            {t.teleprompter.smallerMark}
          </button>
          <button
            className="icon-button"
            aria-label={t.teleprompter.larger}
            title={t.teleprompter.larger}
            disabled={settings.fontSize >= FONT_SIZES.max}
            onClick={() => teleprompter.setSettings({ fontSize: settings.fontSize + FONT_SIZES.step })}
          >
            {t.teleprompter.largerMark}
          </button>
          <label className="teleprompter-check" title={t.teleprompter.mirrorHint}>
            <input type="checkbox" checked={settings.mirror} onChange={(event) => teleprompter.setSettings({ mirror: event.target.checked })} />
            {t.teleprompter.mirror}
          </label>
          <label className="teleprompter-check" title={t.teleprompter.cuesHint}>
            <input type="checkbox" checked={settings.cues} onChange={(event) => teleprompter.setSettings({ cues: event.target.checked })} />
            {t.teleprompter.cues}
          </label>
          <button className="button" data-testid="teleprompter-hold" aria-pressed={state.held} onClick={() => teleprompter.setHeld(!state.held)}>
            {state.held ? t.teleprompter.resume : t.teleprompter.hold}
          </button>
        </span>
      </div>
      {scripts.error ? (
        <p className="empty">{t.teleprompter.unreadable(scripts.error)}</p>
      ) : scripts.list && !chosen ? (
        <p className="empty">{t.teleprompter.noScripts}</p>
      ) : stream && stream.stops.length === 0 ? (
        <p className="empty">{t.teleprompter.empty}</p>
      ) : (
        stream && (
          <PromptView
            stream={stream}
            current={current}
            fontSize={settings.fontSize}
            mirror={settings.mirror}
            cues={settings.cues}
            held={state.held}
            onKey={onKey}
          />
        )
      )}
      <p className="teleprompter-keys">{t.teleprompter.keys}</p>
    </div>
  );
}

/**
 * The scrolled text and its focus line. Stop boxes are measured after layout (and again on resize, font size or
 * cues); the scroll glides toward {@link focusOffset} on the animation frames of the window it is drawn in.
 */
function PromptView({
  stream,
  current,
  fontSize,
  mirror,
  cues,
  held,
  onKey,
}: {
  stream: PromptStream;
  current: number;
  fontSize: number;
  mirror: boolean;
  cues: boolean;
  held: boolean;
  onKey: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const view = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const boxes = useRef<StopBox[]>([]);
  const scroll = useRef<{ shown: number | null; target: number; focus: number; frame: number }>({ shown: null, target: 0, focus: 0, frame: 0 });
  const [layout, setLayout] = useState(0);

  // Every frame until the glide arrives; the first placement (and a new script) snaps instead.
  const aim = useCallback(() => {
    const element = view.current;
    const text = content.current;
    if (!element || !text || current === -1) return;
    const height = element.clientHeight;
    const state = scroll.current;
    state.focus = height / 2;
    state.target = focusOffset(stream, boxes.current, current, { height, focus: state.focus, margin: Math.min(fontSize, height / 10) });
    const win = element.ownerDocument.defaultView ?? window;
    const paint = () => {
      text.style.transform = `translateY(${state.focus - (state.shown ?? state.target)}px)`;
      text.dataset["settled"] = String(state.shown === state.target);
    };
    if (state.shown === null) {
      state.shown = state.target;
      paint();
      return;
    }
    if (state.frame) return;
    let last = win.performance.now();
    const step = (now: number) => {
      state.shown = glide(state.shown ?? state.target, state.target, now - last);
      last = now;
      paint();
      state.frame = state.shown === state.target ? 0 : win.requestAnimationFrame(step);
    };
    state.frame = win.requestAnimationFrame(step);
  }, [stream, current, fontSize]);

  useLayoutEffect(() => {
    scroll.current.shown = null;
  }, [stream]);

  useLayoutEffect(() => {
    const text = content.current;
    if (!text) return;
    const measured: StopBox[] = [];
    for (const node of text.querySelectorAll("[data-stop]")) {
      const element = elementOf(node);
      if (element) measured[Number(element.dataset["stop"])] = { top: element.offsetTop, left: element.offsetLeft, width: element.offsetWidth, height: element.offsetHeight };
    }
    boxes.current = measured;
  }, [stream, fontSize, cues, layout]);

  useLayoutEffect(aim, [aim, layout, cues]);

  useEffect(() => {
    const element = view.current;
    if (!element) return;
    const win = element.ownerDocument.defaultView ?? window;
    const observer = new win.ResizeObserver(() => setLayout((count) => count + 1));
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    // A detached teleprompter takes the keys as soon as its window opens; docked, it waits for a click.
    if (windowOf(element) !== window) element.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      const state = scroll.current;
      if (state.frame) win.cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, []);

  const sentence = current === -1 ? null : stream.sentences[stream.stops[current]!.sentence]!;
  return (
    <div
      ref={view}
      className="teleprompter-view"
      tabIndex={0}
      role="document"
      aria-label={t.teleprompter.text}
      data-testid="teleprompter-view"
      data-stop={current}
      onKeyDown={onKey}
      onPointerDown={(event) => event.currentTarget.focus({ preventScroll: true })}
    >
      <div className="teleprompter-focus" data-testid="teleprompter-focus" aria-hidden="true" />
      {held && <span className="teleprompter-held">{t.teleprompter.held}</span>}
      <div className={`teleprompter-page${mirror ? " is-mirrored" : ""}`}>
        <div ref={content} className="teleprompter-content" style={{ fontSize }}>
          {stream.scenes.map((scene) => (
            <section key={scene.slug} className="teleprompter-scene">
              <h3 className="teleprompter-scene-title">{scene.title}</h3>
              {stream.lines.slice(scene.firstLine, scene.endLine).map((line) => (
                <LineView
                  key={line.fileLine}
                  stream={stream}
                  line={line}
                  cues={cues}
                  mark={current < line.start ? "ahead" : current >= line.end ? "said" : current}
                  sentence={sentence && line.start <= sentence.start && sentence.end <= line.end ? sentence : null}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One shoot line: speaker, stops and cues. `mark` is where the reader is against it (every stop still ahead, all
 * said, or the current stop in it), and `sentence` the current sentence when it is in this line, so a move
 * redraws only the lines it touches.
 */
const LineView = memo(function LineView({
  stream,
  line,
  cues,
  mark,
  sentence,
}: {
  stream: PromptStream;
  line: PromptLine;
  cues: boolean;
  mark: "ahead" | "said" | number;
  sentence: PromptSentence | null;
}) {
  const shown = line.cues.filter((cue) => cues || cue.free);
  if (line.start === line.end && shown.length === 0) return null;
  const cuesBefore = (stop: number) =>
    shown
      .filter((cue) => cue.before === stop)
      .map((cue, index) => (
        <span key={`c${stop}-${index}`} className={`teleprompter-cue${cue.free ? " is-free" : ""}`}>
          {cue.free ? `${t.teleprompter.free}: ${cue.text ?? ""}` : `${cue.label}${cue.text ? `: ${cue.text}` : ""}`}
        </span>
      ));
  const parts = [];
  for (let stop = line.start; stop < line.end; stop++) {
    parts.push(...cuesBefore(stop));
    const said = mark === "said" || (typeof mark === "number" && stop < mark);
    const isCurrent = mark === stop;
    const className = [
      stream.stops[stop]!.kind === "free" ? "teleprompter-free" : "teleprompter-word",
      said ? "is-said" : "",
      isCurrent ? "is-current" : "",
      sentence && stop >= sentence.start && stop < sentence.end ? "in-sentence" : "",
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(
      <span key={stop} data-stop={stop} className={className} aria-current={isCurrent || undefined}>
        {stream.stops[stop]!.kind === "free" && <span className="teleprompter-free-label">{t.teleprompter.free}</span>}
        {stream.stops[stop]!.text}
      </span>,
      " ",
    );
  }
  parts.push(...cuesBefore(line.end));
  return (
    <p className="teleprompter-line" data-line={line.fileLine}>
      {line.speaker && line.start < line.end && <span className="teleprompter-speaker">{line.speaker}</span>}
      {parts}
    </p>
  );
});

/** Shoot scripts of the project (`shoot: true`), read again when a script changes; `list` is null before the first read. */
function useShootScripts(): { list: { path: string; script: ShootScript }[] | null; error: string | null } {
  const [scripts, setScripts] = useState<{ list: { path: string; script: ShootScript }[] | null; error: string | null }>({ list: null, error: null });
  const [changed, setChanged] = useState(0);
  useEffect(
    () =>
      window.frameshell.files.onChanged((paths) => {
        if (paths.some(isScriptPath)) setChanged((count) => count + 1);
      }),
    [],
  );
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const files = scriptFiles(await window.frameshell.files.tree());
        const read = await Promise.all(
          files.map(async (path) => {
            try {
              return { path, script: parseShootScript(await window.frameshell.files.read(path)) };
            } catch {
              return null;
            }
          }),
        );
        if (live) setScripts({ list: read.filter((entry): entry is { path: string; script: ShootScript } => entry?.script.shoot.shoot === true), error: null });
      } catch (error) {
        if (live) setScripts({ list: null, error: (error as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [changed]);
  return scripts;
}
