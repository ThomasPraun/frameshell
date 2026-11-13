import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Timeline } from "@frameshell/schema";
import { soundHits } from "../analyze/events.js";
import { EnvelopeBuilder, ENERGY_HOP_S } from "../media/energy.js";
import { wavData } from "../media/energy-store.js";
import { soundsOn } from "../sound/place.js";
import { extractAudioWithFfmpeg } from "../transcripts/audio.js";
import type { Onset } from "./sync.js";

// Where sounds start, for the sync check (#457): the anchors of generated takes on the timeline's audio tracks, or the
// hits found in an exported file's sound. A timeline's sound is mixed only by `render`, so nothing else of it is heard here.

/** The generated takes (`sound.place`) on the audio tracks of `timeline`, at the second their anchor plays; a muted track or clip is not heard, so it is left out. */
export async function takeOnsets(root: string, timeline: Timeline): Promise<Onset[]> {
  const heard: Timeline = {
    ...timeline,
    tracks: timeline.tracks
      .filter((track) => !(track.kind === "audio" && track.muted === true))
      .map((track) => (track.kind === "audio" ? { ...track, clips: track.clips.filter((clip) => clip.audio?.muted !== true) } : track)),
  };
  return (await soundsOn(root, heard)).map((item) => ({ at: item.at, kind: item.kind }));
}

/**
 * Hits in the sound of `file`: the ones `analyze` reports as `hit` events (a 12 dB rise over the 80 ms before, in the 10 ms
 * envelope, 150 ms apart), decoded on the ingest clock so they line up with the picture. `scratch` is a folder the WAV goes in,
 * removed afterwards.
 */
export async function fileOnsets(ffmpeg: string, file: string, scratch: string): Promise<Onset[]> {
  const wav = join(scratch, "onsets.wav");
  await mkdir(scratch, { recursive: true });
  try {
    await extractAudioWithFfmpeg({ path: file }, wav, async () => ffmpeg);
    const sound = wavData(await readFile(wav));
    const builder = new EnvelopeBuilder(sound.rate, sound.channels);
    builder.push(sound.data);
    return soundHits(builder.finish(), ENERGY_HOP_S).map((hit) => ({ at: hit.time, kind: null }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
