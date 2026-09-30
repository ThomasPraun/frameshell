import { type ResolvedSubtitleTrack, SUBTITLE_FONT, subtitleTracks } from "@frameshell/schema/subtitles";
import fontUrl from "@expo-google-fonts/archivo-black/400Regular/ArchivoBlack_400Regular.ttf?url";
import { useEffect, useMemo, useState } from "react";
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

let fontLoad: Promise<void> | null = null;

/**
 * Load the bundled subtitle face (the file export burns with) once per page.
 * Resolves when canvas text can use it.
 */
export function loadSubtitleFont(): Promise<void> {
  fontLoad ??= (async () => {
    const face = new FontFace(SUBTITLE_FONT.family, `url(${fontUrl})`);
    document.fonts.add(await face.load());
  })();
  return fontLoad;
}

/** True once {@link loadSubtitleFont} has finished; drawing before it would use a fallback face. */
export function useSubtitleFont(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    loadSubtitleFont().then(
      () => live && setReady(true),
      (error: unknown) => console.error(`Subtitle font failed to load: ${(error as Error).message}`),
    );
    return () => {
      live = false;
    };
  }, []);
  return ready;
}
