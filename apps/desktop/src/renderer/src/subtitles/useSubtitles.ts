import { type ResolvedSubtitleTrack, SUBTITLE_FONT, subtitleTracks } from "@frameshell/schema/subtitles";
import fontUrl from "@expo-google-fonts/archivo-black/400Regular/ArchivoBlack_400Regular.ttf?url";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { flattenView } from "../preview/program.js";
import { useNestedViews } from "../preview/useProgram.js";
import { SELECTION_TIMELINE } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { useTranscripts } from "../transcript/useTranscripts.js";

/** Subtitle tracks of the timeline the panels show, resolved like export resolves them. */
export interface SubtitlesState {
  tracks: ResolvedSubtitleTrack[];
  fps: number;
  /** Transcript file of an asset, project-relative; null when it has none. */
  transcriptOf: (asset: string) => string | null;
}

/**
 * Cues of every subtitle track of {@link SELECTION_TIMELINE}, live: from the
 * shared timeline feed (nested timelines flattened, as export does) and the
 * shared transcripts feed, so a cut or a transcript correction shows at once.
 */
export function useSubtitles(): SubtitlesState {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const nested = useNestedViews(view);
  const { sources } = useTranscripts();
  return useMemo(() => {
    const byAsset = new Map(sources.map((source) => [source.transcript.asset, source] as const));
    const transcriptOf = (asset: string) => byAsset.get(asset)?.path ?? null;
    if (!view) return { tracks: [], fps: 30, transcriptOf };
    const tracks = subtitleTracks(flattenView(view, nested), (asset) => byAsset.get(asset)?.transcript ?? null, view.fps);
    return { tracks, fps: view.fps, transcriptOf };
  }, [view, nested, sources]);
}

const fontLoads = new WeakMap<Document, Promise<void>>();

/**
 * Load the bundled subtitle face (the file export burns with) once per
 * document: a detached panel's window (ADR 0012) has fonts of its own.
 * Resolves when canvas text in `doc` can use it.
 */
export function loadSubtitleFont(doc: Document = document): Promise<void> {
  let load = fontLoads.get(doc);
  if (!load) {
    load = (async () => {
      // A face of the document's own realm: a font set takes no other. The URL is absolute: a blank window's resolves nothing.
      const face = new (doc.defaultView ?? window).FontFace(SUBTITLE_FONT.family, `url(${new URL(fontUrl, document.baseURI).href})`);
      doc.fonts.add(await face.load());
    })();
    fontLoads.set(doc, load);
  }
  return load;
}

/**
 * True once {@link loadSubtitleFont} has finished for the document `element`
 * is in; drawing before it would use a fallback face.
 */
export function useSubtitleFont(element: RefObject<Element | null>): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    loadSubtitleFont(element.current?.ownerDocument).then(
      () => live && setReady(true),
      (error: unknown) => console.error(`Subtitle font failed to load: ${(error as Error).message}`),
    );
    return () => {
      live = false;
    };
  }, [element]);
  return ready;
}
