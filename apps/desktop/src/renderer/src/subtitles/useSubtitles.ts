import { type CaptionTokens, type ResolvedSubtitleTrack, SUBTITLE_FONT, subtitleTracks } from "@frameshell/schema/subtitles";
import fontUrl from "@expo-google-fonts/archivo-black/400Regular/ArchivoBlack_400Regular.ttf?url";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { flattenView } from "../preview/program.js";
import { useNestedViews } from "../preview/useProgram.js";
import { SELECTION_TIMELINE } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { useTranscripts } from "../transcript/useTranscripts.js";
import type { CaptionStyle } from "./caption-style.js";

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
 * `tokens`: the project style's caption values (`useCaptionStyle`); they change looks, never cue timing.
 */
export function useSubtitles(tokens?: CaptionTokens): SubtitlesState {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const nested = useNestedViews(view);
  const { sources } = useTranscripts();
  return useMemo(() => {
    const byAsset = new Map(sources.map((source) => [source.transcript.asset, source] as const));
    const transcriptOf = (asset: string) => byAsset.get(asset)?.path ?? null;
    if (!view) return { tracks: [], fps: 30, transcriptOf };
    const tracks = subtitleTracks(flattenView(view, nested), (asset) => byAsset.get(asset)?.transcript ?? null, view.fps, tokens);
    return { tracks, fps: view.fps, transcriptOf };
  }, [view, nested, sources, tokens]);
}

const fontLoads = new WeakMap<Document, Promise<void>>();
const projectFaces = new WeakMap<Document, WeakMap<ArrayBuffer, Promise<void>>>();

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

/** Load a project caption face (`CaptionStyle.face`) under `family` into `doc`, once per document and bytes. */
function loadProjectFace(doc: Document, family: string, bytes: ArrayBuffer): Promise<void> {
  let faces = projectFaces.get(doc);
  if (!faces) projectFaces.set(doc, (faces = new WeakMap()));
  let load = faces.get(bytes);
  if (!load) {
    load = (async () => {
      const face = new (doc.defaultView ?? window).FontFace(family, bytes.slice(0));
      doc.fonts.add(await face.load());
    })();
    faces.set(bytes, load);
  }
  return load;
}

/**
 * True once the bundled face and the style's project face (`style`, when it has one) have loaded for the document
 * `element` is in; drawing before it would use a fallback face.
 */
export function useSubtitleFont(element: RefObject<Element | null>, style?: CaptionStyle): boolean {
  const [ready, setReady] = useState(false);
  const face = style?.face ?? null;
  const family = style?.tokens?.font.family ?? null;
  useEffect(() => {
    let live = true;
    setReady(false);
    const doc = element.current?.ownerDocument ?? document;
    Promise.all([loadSubtitleFont(doc), face && family ? loadProjectFace(doc, family, face) : null]).then(
      () => live && setReady(true),
      (error: unknown) => console.error(`Subtitle font failed to load: ${(error as Error).message}`),
    );
    return () => {
      live = false;
    };
  }, [element, face, family]);
  return ready;
}
