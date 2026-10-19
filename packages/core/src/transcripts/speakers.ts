import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { ErrorCode, type Progress, RpcError, type TranscribeSpeakersResult } from "@frameshell/protocol";
import { SCHEMA_VERSION, TRANSCRIPT_SCHEMA_URL, type Transcript, parseTranscript, wordSpeaker } from "@frameshell/schema";
import { writeJsonAtomic } from "../fs-util.js";
import { DIARIZATION_TOOL, SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL } from "../binaries/manifest.js";
import { type AudioExtractor, extractAudioWithFfmpeg } from "./audio.js";
import { type SpeakerSegment, labelSpeakers, wordLabels } from "./speaker-labels.js";
import {
  type TranscriberMedia,
  type TranscriberTools,
  hashAsset,
  readPrevious,
  resolveAsset,
  resolveTranscript,
  transcriptionAudio,
} from "./transcriber.js";

/** What a {@link Diarizer} runs on. */
export interface DiarizeRequest {
  /** Absolute path of the diarization executable. */
  binary: string;
  /** Absolute paths of the segmentation and speaker embedding models. */
  segmentation: string;
  embedding: string;
  /** 16 kHz mono WAV. */
  audio: string;
  /** Known number of people; undefined: the clustering decides. */
  speakers?: number | undefined;
  /** 0..1 of the audio done. */
  onProgress(fraction: number): void;
}

/** Speaker diarization of one WAV: who speaks when, by anonymous cluster. */
export type Diarizer = (request: DiarizeRequest) => Promise<SpeakerSegment[]>;

/** Output lines kept for error messages. */
const TAIL_LINES = 20;

/**
 * Segments printed by `sherpa-onnx-offline-speaker-diarization` on stdout,
 * one per line: `0.318 -- 3.997 speaker_00`. Other lines (its config echo,
 * `Started`) are ignored.
 */
export function parseDiarization(stdout: string): SpeakerSegment[] {
  const segments: SpeakerSegment[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+(?:\.\d+)?)\s+--\s+(\d+(?:\.\d+)?)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end > start) segments.push({ start, end, label: match[3]! });
  }
  return segments;
}

/**
 * {@link Diarizer} running sherpa-onnx's offline speaker diarization: pyannote
 * segmentation, then speaker embeddings clustered by distance (or into
 * `speakers` clusters when the count is known). CPU only, up to 4 threads.
 */
export const sherpaDiarizer: Diarizer = (request) =>
  new Promise((resolve, reject) => {
    const threads = String(Math.max(1, Math.min(4, availableParallelism())));
    const args = [
      `--segmentation.pyannote-model=${request.segmentation}`,
      `--embedding.model=${request.embedding}`,
      `--segmentation.num-threads=${threads}`,
      `--embedding.num-threads=${threads}`,
      ...(request.speakers ? [`--clustering.num-clusters=${request.speakers}`] : []),
      request.audio,
    ];
    const child = spawn(request.binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    const tail: string[] = [];
    let partial = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const progress = /^progress (\d+(?:\.\d+)?)%/.exec(line);
        if (progress) request.onProgress(Math.min(1, Number(progress[1]) / 100));
        else if (line.trim() !== "") tail.push(line);
      }
      tail.splice(0, Math.max(0, tail.length - TAIL_LINES));
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve(parseDiarization(stdout));
      const reason = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      reject(new Error(`${DIARIZATION_TOOL} ${reason}:\n${[...tail, partial].filter(Boolean).join("\n")}`));
    });
  });

/** Input of {@link diarizeAsset}. */
export interface DiarizeAssetOptions {
  /** Project root (real path). */
  projectDir: string;
  /** Asset path, absolute. */
  asset: string;
  /** Known number of people speaking; undefined: found from the voices. */
  speakers?: number | undefined;
  tools: TranscriberTools;
  media?: TranscriberMedia | undefined;
  extractAudio?: AudioExtractor | undefined;
  /** Defaults to {@link sherpaDiarizer}. */
  diarize?: Diarizer | undefined;
  progress?: ((progress: Progress) => void) | undefined;
}

/**
 * Who says each word of an asset's transcript (ADR 0016 decision 3): runs
 * speaker diarization on the transcription WAV and writes `speaker` on the
 * words and the `speakers` list. A voice keeps the id (and name) of the
 * speaker it shares most words with from the last run; human corrections
 * in `edits` stay and win. Needs a current transcript.
 *
 * Throws `InvalidOperation` (no transcript, or a stale one), `AssetNotFound`,
 * `OutsideProject`, `InvalidProjectFile`, `TranscriptionFailed` (extraction or
 * diarization error), or the binary manager's errors unchanged.
 */
export async function diarizeAsset(options: DiarizeAssetOptions): Promise<TranscribeSpeakersResult> {
  const started = performance.now();
  const { projectDir, tools } = options;
  const progress = options.progress ?? (() => {});
  const { real: assetPath, rel: assetRel } = await resolveAsset(projectDir, options.asset);
  const { rel: transcriptRel, path: transcriptPath, previous: found } = await resolveTranscript(projectDir, assetRel);
  if (!found) {
    throw refused(`${assetRel} has no transcript yet. Run \`transcribe\` on it first: speakers are set on its words.`, "no transcript");
  }
  const hashed = await hashAsset({ assetPath, assetRel, media: options.media, progress });
  if (found.assetHash !== `sha256:${hashed.hash}`) {
    throw refused(`${transcriptRel} is stale: ${assetRel} changed after it was transcribed. Run \`transcribe\` on it again first.`, "stale transcript");
  }
  const failed = (error: unknown): never => {
    if (error instanceof RpcError) throw error;
    const details = (error as Error)?.message ?? String(error);
    throw new RpcError(ErrorCode.TranscriptionFailed, `Finding the speakers of ${assetRel} failed: ${details}`, {
      provider: "sherpa-onnx",
      asset: assetRel,
      details,
    });
  };

  let segments: SpeakerSegment[];
  try {
    const { audio } = await transcriptionAudio({
      projectDir,
      assetPath,
      assetRel,
      hashed,
      tools,
      extractAudio: options.extractAudio ?? extractAudioWithFfmpeg,
      progress,
    });
    const binary = await tools.ensureBinary(DIARIZATION_TOOL, progress);
    const segmentation = await tools.ensureModel(SEGMENTATION_MODEL, progress);
    const embedding = await tools.ensureModel(SPEAKER_EMBEDDING_MODEL, progress);
    const message = `Finding who speaks in ${assetRel}`;
    progress({ message });
    segments = await (options.diarize ?? sherpaDiarizer)({
      binary,
      segmentation,
      embedding,
      audio,
      speakers: options.speakers,
      onProgress: (fraction) => progress({ message, fraction }),
    });
  } catch (error) {
    return failed(error);
  }

  // Re-read: the person may have corrected words while diarization ran.
  const previous = (await readPrevious(transcriptPath)) ?? found;
  if (previous.assetHash !== found.assetHash || previous.asset !== assetRel) {
    throw refused(`${transcriptRel} was replaced while the speakers were being found. Run it again.`, "transcript changed");
  }
  const labels = wordLabels(previous.words, segments);
  const { words, speakers, nextSpeakerId } = labelSpeakers(previous.words, labels, previous);
  const transcript: Transcript = {
    ...previous,
    $schema: previous.$schema ?? TRANSCRIPT_SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    words,
    speakers,
    nextSpeakerId,
  };
  const checked = parseTranscript(transcript);
  if (!checked.ok) failed(new Error(`the speakers gave a transcript the format rejects:\n${checked.error}`));
  await writeJsonAtomic(transcriptPath, transcript);

  const summary = speakers.map((speaker) => {
    const said = words.filter((word) => wordSpeaker(transcript, word) === speaker.id);
    return { id: speaker.id, name: speaker.name, words: said.length, seconds: round(said.reduce((sum, word) => sum + (word.end - word.start), 0)) };
  });
  return {
    transcript: transcriptRel,
    asset: assetRel,
    speakers: summary,
    segments: segments.length,
    unassigned: words.filter((word) => wordSpeaker(transcript, word) === undefined).length,
    corrections: Object.values(transcript.edits).filter((edit) => edit.speaker !== undefined).length,
    seconds: Math.round(performance.now() - started) / 1000,
  };
}

function refused(message: string, reason: string): RpcError {
  return new RpcError(ErrorCode.InvalidOperation, `transcribe.speakers: ${message}`, {
    op: "transcribe.speakers",
    reason,
    hint: "frameshell transcribe <asset>",
  });
}

/** SPEC §5.3: times with 3 decimals. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
