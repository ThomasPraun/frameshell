import type { Size } from "@frameshell/schema/composite";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type LiveTarget, liveSeconds } from "../preview/live.js";
import { livePage } from "../preview/live-pages.js";
import { t } from "../i18n.js";

/** `source` of the messages the preview posts to a live page and the page's bridge posts back (main's `LIVE_MESSAGE`). */
const TO_PAGE = "frameshell-preview";
const FROM_PAGE = "frameshell-live";

/** The clip whose live page shows, and the render key the page was built for. */
export interface LiveShown {
  clip: string;
  key: string;
}

/** Live page of one clip render key: loading, loaded at `url`, or failed (the slate stays). */
type PageState = { status: "loading" } | { status: "loaded"; url: string } | { status: "failed"; error: string };

/**
 * Live preview of the generated clip `target` names (ADR 0010): its
 * composition in a sandboxed frame over the program canvas, placed and faded
 * as the engine would place its render, and seeked to the playhead. The page
 * is asked for once per clip and render key, so a new key (the composition
 * or its props changed) reloads it; a clip whose adapter has no live
 * preview, or whose page fails, keeps its slate. `onLive` names the clip
 * and key while its page shows, so the slate can step aside; null otherwise.
 * `hidden` keeps the page loaded but unseen, while an element drag's page
 * shows that clip instead (ADR 0021).
 */
export function LivePreview({
  target,
  timeline,
  time,
  fps,
  resolution,
  hidden = false,
  onLive,
}: {
  target: LiveTarget | null;
  timeline: string | null;
  time: number;
  fps: number;
  resolution: Size;
  hidden?: boolean;
  onLive: (live: LiveShown | null) => void;
}) {
  const pages = useRef(new Map<string, PageState>());
  const [, setVersion] = useState(0);
  const id = target ? `${target.clip}@${target.key}` : null;
  const clip = target?.clip ?? null;
  const key = target?.key ?? null;

  useEffect(() => {
    if (!id || !clip || !key || !timeline || pages.current.has(id)) return;
    const settle = (state: PageState) => {
      pages.current.set(id, state);
      setVersion((n) => n + 1);
    };
    pages.current.set(id, { status: "loading" });
    livePage(timeline, clip, key).then(
      (url) => settle({ status: "loaded", url }),
      (error: unknown) => settle({ status: "failed", error: (error as Error)?.message ?? String(error) }),
    );
  }, [id, clip, key, timeline]);

  const page = id ? pages.current.get(id) : undefined;
  // No frame: an unmounting LiveFrame has already reported null.
  if (!target || !id || page?.status !== "loaded") return null;
  return (
    <LiveFrame
      key={page.url}
      url={page.url}
      target={target}
      time={time}
      fps={fps}
      resolution={resolution}
      hidden={hidden}
      onLive={onLive}
      onError={(error) => {
        pages.current.set(id, { status: "failed", error });
        setVersion((n) => n + 1);
      }}
    />
  );
}

function LiveFrame({
  url,
  target,
  time,
  fps,
  resolution,
  hidden,
  onLive,
  onError,
}: {
  url: string;
  target: LiveTarget;
  time: number;
  fps: number;
  resolution: Size;
  hidden: boolean;
  onLive: (live: LiveShown | null) => void;
  onError: (error: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(0);
  const failed = useRef(onError);
  failed.current = onError;
  const seconds = liveSeconds(target.span, time, fps);

  // The page is laid out at the project format; CSS scales it to the box the render would fill.
  useLayoutEffect(() => {
    const element = box.current!;
    const measure = () => setScale(element.clientWidth / resolution.width);
    measure();
    // From the window the frame is drawn in (ADR 0012).
    const observer = new (element.ownerDocument.defaultView ?? window).ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [resolution.width]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: unknown; ready?: unknown; shown?: unknown; error?: unknown } | null;
      if (event.source !== frame.current?.contentWindow || !data || data.source !== FROM_PAGE) return;
      if (data.ready === true) setReady(true);
      // Written straight to the DOM: while playing, one arrives per frame.
      else if (typeof data.shown === "number") box.current?.setAttribute("data-shown", data.shown.toFixed(3));
      else if (typeof data.error === "string") failed.current(data.error);
    };
    // The page posts to its own parent: the window this frame is drawn in, a detached panel's too (ADR 0012).
    const view = box.current?.ownerDocument.defaultView ?? window;
    view.addEventListener("message", onMessage);
    return () => view.removeEventListener("message", onMessage);
  }, []);

  // One seek per playhead change: per frame while playing (the bridge keeps only the latest), exact while paused.
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ source: TO_PAGE, seek: seconds }, "*");
  }, [ready, seconds]);

  useEffect(() => {
    onLive(ready ? { clip: target.clip, key: target.key } : null);
  }, [ready, target.clip, target.key, onLive]);
  useEffect(() => () => onLive(null), [onLive]);

  const percent = (value: number) => `${value * 100}%`;
  return (
    <div
      ref={box}
      className="preview-live"
      data-testid="preview-live"
      data-clip={target.clip}
      data-ready={ready || undefined}
      style={{
        left: percent(target.box.left),
        top: percent(target.box.top),
        width: percent(target.box.width),
        height: percent(target.box.height),
        opacity: ready && !hidden ? target.opacity : 0,
      }}
    >
      <iframe
        ref={frame}
        src={url}
        title={t.preview.liveFrame(target.clip)}
        sandbox="allow-scripts"
        allow="autoplay 'none'"
        referrerPolicy="no-referrer"
        tabIndex={-1}
        aria-hidden="true"
        width={resolution.width}
        height={resolution.height}
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  );
}
