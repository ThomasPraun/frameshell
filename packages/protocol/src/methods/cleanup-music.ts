import { z } from "zod";
import {
  CLEANUP_BREATH_DEFAULT_S,
  CLEANUP_MIN_CONFIDENCE_DEFAULT,
  CLEANUP_PAUSES_DEFAULT_S,
  CleanupResultSchema,
} from "../cleanup.js";
import {
  MUSIC_CANDIDATES_MAX,
  MUSIC_GRID_MAX_SHIFT_DEFAULT_S,
  MUSIC_GRID_MAX_SHIFT_LIMIT_S,
  MusicCandidatesResultSchema,
  MusicFitResultSchema,
  MusicGridResultSchema,
  MusicShapeResultSchema,
} from "../music.js";
import { TimelineIdSchema, TimeRef } from "../timeline.js";
import { type MethodSpec, CwdParam } from "./shared.js";

/** Daemon methods: cleanup passes and music fitting. */
export const cleanupMusicMethods = {
  cleanup: {
    mutating: true,
    description:
      "Propose, then make, the cuts that take dead air and false starts out of a talking head. It reads the words of the " +
      "transcripts of the unmuted media clips (and the sound of multicam program tracks) and the audio energy of their files, " +
      "and cuts like `cut` does (ripple on every video, audio and program track). `pauses` (seconds, default 0.4; `false` = " +
      "off): a gap between two kept words longer than that, confirmed by the audio being quiet there (whisper stretches words " +
      "over silence, so the edges come from the audio, not from the word times); the cut leaves `breath` seconds (default 0.1) " +
      "of silence on each side and lies on the frame grid. `retakes: true`: a phrase of 1 to 6 words said again right after " +
      "(a false start, a stop, a restart; spelling variants and a cut-off last word match) cuts the earlier attempt and " +
      "keeps the last. Only candidates with `confidence` of `minConfidence` or more (default 0.5) count. A cut is made only " +
      "where transcribed speech covers every instant of it, so it never removes b-roll or other material that is not part of " +
      "the speech; a word with `speechInside` is never cut around. `dryRun: true` changes nothing and returns the candidates: " +
      "show them as a table (kind, start, end, words, reason, confidence), ask, then call again with the same options (the " +
      "plan is made again from the timeline as it is) and `skip` the ids the person rejected (a retake covers the pauses around it: rejecting it brings them back as `p` candidates). Without `dryRun` the cuts are " +
      "one transaction labelled `Cleanup: …` (`revert` undoes it whole; with review mode on it is one proposal); a cut word " +
      "shows struck through in the transcript view and clicking it restores it. Example: `{ pauses: 0.5, retakes: true, " +
      "dryRun: true }`. Fails with InvalidOperation (`breath` too large for `pauses`, a `skip` id that is not a candidate, " +
      "no transcript for the speech) or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      pauses: z
        .union([z.number().min(0.15).max(30), z.literal(false)])
        .default(CLEANUP_PAUSES_DEFAULT_S)
        .describe(`Shortest gap between two words, in seconds, to cut as a pause; \`false\` leaves pauses alone. Default ${CLEANUP_PAUSES_DEFAULT_S}.`),
      breath: z
        .number()
        .min(0)
        .max(2)
        .default(CLEANUP_BREATH_DEFAULT_S)
        .describe(`Seconds of silence left on each side of a cut. Default ${CLEANUP_BREATH_DEFAULT_S}; must be under half of \`pauses\`.`),
      retakes: z.boolean().default(false).describe("Also cut the earlier attempts of repeated phrases (false starts). Default false."),
      minConfidence: z
        .number()
        .min(0)
        .max(1)
        .default(CLEANUP_MIN_CONFIDENCE_DEFAULT)
        .describe(`Drop candidates below this confidence. Default ${CLEANUP_MIN_CONFIDENCE_DEFAULT}.`),
      dryRun: z.boolean().default(false).describe("Only return the candidates; change nothing."),
      skip: z.array(z.string().min(1)).optional().describe("Candidate ids (`p1`, `r2`…) from a dry run to leave out."),
    }),
    result: CleanupResultSchema,
  },
  "music.fit": {
    mutating: true,
    description:
      "Fit a music clip to the cut (ADR 0037): back-time it so the track's own final hit lands on `end` and it plays unspliced " +
      "before it, and report where the music then starts. `end` is a time on the timeline: seconds, or a marker id or label " +
      "(`end-card`, `outro-1`) or a beat or bar of the timeline's grid (`bar:16`, read on the clip as it is before the fit). The final hit is `hit` (source seconds of the music file) when given, else found on the track's " +
      "energy: the last sharp jump in level near the end of the part the clip plays, reported with a `confidence` and the other " +
      "`candidates`. Default (`mode: slide`): the clip slides so the hit lands on `end` within half a frame, keeping its speed. " +
      "Where that would start the music before `from` (default 0), the intro is dropped instead (`in` moves later, `introCut`); " +
      "where the clip plays the file from later than 0 and the start lands after `from`, the intro comes back as far as the file has it; " +
      "where the file is shorter than the picture before the hit, the music starts late (`silentBefore`), and it is never looped " +
      "or spliced. `exact: true` keeps the start (the clip's own, or `from`) and changes the speed so the hit lands exactly on " +
      "`end`: at most ±1.7 % of the clip's speed (export and preview keep the pitch); beyond that it refuses and says " +
      "which `end` would fit, or to drop `exact`. A detected hit under confidence 0.5 never changes the speed: pass `hit`. `dryRun: true` changes nothing and returns the plan with its `steps`. " +
      "If the clip carries duck keys (`track.duck`), they sit on the clip's clock and would no longer match the voice: duck runs " +
      "again in the same transaction over the other video and audio tracks with its defaults (`skip: [\"duck\"]` leaves them and " +
      "says so). Music keys (`music.shape`) are run again first with the settings kept on the clip, so the steps down stay on the hits of the picture " +
      "(`skip: [\"shape\"]` leaves them and says so). The clip's start gets a 5 ms fade in (`audio.fadeInMs`, so the entry does not click) " +
      "unless it already has a fade in or a dissolve (`skip: [\"fade\"]` leaves it out). Writes only existing fields (`start`, `in`, `speed`, `audio.fadeInMs`, gain keys) as one transaction labelled `Music fit: …` " +
      "(`revert` undoes it whole; with review mode on it is one proposal). Example: `{ clip: \"c_1a2b3c\", end: \"end-card\" }`. " +
      "Fails with InvalidOperation (not a music clip of an audio track, `end` not after `from`, a `hit` outside the played part, " +
      "no hit found, more than ±1.7 % needed, low confidence with `exact`, the new place overlaps another clip), " +
      "TimelineNotFound, ClipNotFound or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Music clip: a media clip of an audio track, id from `timeline.show`, e.g. `c_1a2b3c`."),
      end: TimeRef("Timeline time the final hit lands on, e.g. the cut into the end card."),
      from: TimeRef(
        "Earliest timeline time the music may start (default 0). With `exact`, where it starts (default: where the clip starts now).",
      ).optional(),
      hit: z
        .number()
        .positive()
        .optional()
        .describe("Source seconds of the music file where the final hit begins. Default: found on the track's energy (see `hit.candidates` of a dry run)."),
      exact: z
        .boolean()
        .default(false)
        .describe("Keep the start and land the hit exactly on `end` with a small change of speed (at most ±1.7 %). Default false: slide the clip, keep its speed."),
      dryRun: z.boolean().default(false).describe("Only return the plan; change nothing."),
      skip: z.array(z.string().min(1)).optional().describe("Step ids from a dry run's `steps` to leave out; `fade`, `duck` and `shape` can be."),
    }),
    result: MusicFitResultSchema,
  },
  "music.candidates": {
    mutating: true,
    description:
      "Place 2 to 7 candidate music tracks under the same picture at the same loudness, so the person picks by ear (ADR 0037). Each file " +
      "in `assets` goes on its own new audio track `Music 1` to `Music n`, all muted but the first, with a static clip gain that brings its " +
      "EBU R128 integrated loudness (measured over the whole file, once per file, cached by content) to one target: `loudness` (LUFS) when " +
      "given, else the quietest file's own, so no candidate is made louder than it is (a warning says when a gain would push a peak over " +
      "-1 dBTP). The clip starts at `from` (default 0) and plays the whole file. With `end` (seconds, a marker id or label) each is fitted " +
      "like `music.fit` slides it: its own final hit (found on its energy) lands on `end`, the intro dropped where the file is longer than " +
      "the picture before it and the music starting late where it is shorter (never looped), and the candidates are ranked: files that " +
      "cover the picture first, then by how sure the final hit is, ties in the order given. Without `end` the order given is the rank. " +
      "A file that cannot be placed (silent, no sound, no final hit, undecodable) is listed in `skipped` and the rest go on. `dryRun: true` " +
      "changes nothing and returns the plan. Every clip is added with a 5 ms fade in (`audio.fadeInMs`). One transaction labelled `Music candidates: …` (`revert` undoes it whole; with review mode on it is " +
      "one proposal). To choose: `track.set` `muted: false` on the winner and `track.remove` with `force` on the others, then `music.fit` " +
      "the clip that stays. Example: `{ assets: [\"assets/music/a.wav\", \"assets/music/b.wav\", \"assets/music/c.wav\"], end: \"end-card\" }`. " +
      "Fails with InvalidOperation (fewer than 2 or more than 7 files, a file twice, none placeable, `end` not after `from`), AssetNotFound, " +
      "TimelineNotFound, or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      assets: z
        .array(z.string().min(1))
        .min(2)
        .max(MUSIC_CANDIDATES_MAX)
        .describe("Music files inside the project, absolute or relative to `cwd`, e.g. `assets/music/theme.mp3`; 2 to 7, in the order of your preference."),
      end: TimeRef("Timeline time every final hit lands on, e.g. the cut into the end card.").optional(),
      from: TimeRef("Timeline time the music may start from (default 0).").optional(),
      loudness: z
        .number()
        .min(-70)
        .max(0)
        .optional()
        .describe("LUFS to bring every candidate to. Default: the quietest candidate's own loudness."),
      dryRun: z.boolean().default(false).describe("Only return the plan; change nothing."),
    }),
    result: MusicCandidatesResultSchema,
  },
  "music.shape": {
    mutating: true,
    description:
      "Shape a music clip's level around the picture (ADR 0037): the music steps down BEFORE a hit instead of ducking after it, and fades out at the ending. " +
      "`drop` lists the times of the hits (timeline seconds, a marker id or label, `beat:N`/`bar:N`; the cut into the end card, a title slam, a sound effect). For each, " +
      "the music is `depth` dB down (default 9) over a quick step that is complete `lead` seconds before the hit (default 0.4), stays down until `hold` seconds after it (0.3) " +
      "and comes back over `release` (0.6). `ending` is where the closing fade begins (e.g. the end of the last word, or `bar:17` with a short `fade` to stop on a bar line): " +
      "the music fades straight down over `fade` seconds (default 2.5) to inaudible and stays there to the clip's end. The result is gain keys " +
      "(`clip.key` `gain`) on the clip, marked `auto: \"music\"`: running it again replaces those and keeps the keys you set by hand (a hand key inside a dip stays as set and " +
      "a warning names it); `clear: true` removes them. The level they dip from is the clip's `audio.gain` or its own keys. The times of the hits are kept in the clip's `audio.shape`, " +
      "so `music.fit` runs the same shaping again after it moves the clip (`skip: [\"shape\"]` leaves the keys and says so). The keys replace the clip's duck keys (`track.duck`): " +
      "duck runs again in the same transaction with its stored parameters, so the voice still ducks the shaped music. The clip's start also gets a 5 ms fade in " +
      "(`audio.fadeInMs`) unless it already has a fade in or a dissolve; `clear` leaves the clip's edges alone. Not done here: the rising high-pass build before a drop. " +
      "`dryRun: true` changes nothing and returns the `curve` and `steps`. One transaction labelled `Music shape: …` (`revert` undoes it whole; with review mode on it is one proposal). " +
      "Example: `{ clip: \"c_1a2b3c\", drop: [\"hit\"], ending: 28 }`. Fails with InvalidOperation (not a music clip of an audio track, nothing to shape, `clear` with `drop` or `ending`, " +
      "no time falls on the clip), ClipNotFound or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Music clip: a media clip of an audio track, id from `timeline.show`, e.g. `c_1a2b3c`."),
      drop: z
        .array(TimeRef("Timeline time of a hit the music steps down before."))
        .min(1)
        .max(32)
        .optional()
        .describe("Hits of the picture, as timeline times. The music is complete down `lead` seconds before each."),
      ending: TimeRef("Timeline time the closing fade begins.").optional(),
      lead: z.number().min(0.05).max(3).default(0.4).describe("Seconds before a hit that the step down is complete. Default 0.4."),
      depth: z.number().positive().max(40).default(9).describe("dB the music steps down by. Default 9."),
      hold: z.number().min(0).max(5).default(0.3).describe("Seconds after a hit the music stays down. Default 0.3."),
      release: z.number().min(0.05).max(5).default(0.6).describe("Seconds the level takes to come back after the hold. Default 0.6."),
      fade: z.number().min(0.05).max(15).default(2.5).describe("Seconds of the closing fade from `ending`. Default 2.5."),
      clear: z.boolean().default(false).describe("Remove the clip's `music` keys instead; takes no `drop` or `ending`."),
      dryRun: z.boolean().default(false).describe("Only return the plan; change nothing."),
    }),
    result: MusicShapeResultSchema,
  },
  "music.grid": {
    mutating: true,
    description:
      "Move picture cuts onto the timeline's beat grid (ADR 0037): list the cuts that are off the grid and land each on its nearest beat " +
      "(`to: \"bar\"`: bar start). The grid is the timeline's `tempo` (`tempo.set`: the measured grid of a music clip, or a nominal BPM); a LOW " +
      "confidence grid is refused. A cut is where two clips of a video track meet. Each cut off the grid by at most `maxShift` seconds (default 0.25) " +
      "gets an id (`g1`, `g2`… in time order) and moves exactly onto its beat; the others stay where they are. A move is a ripple trim of the clip " +
      "before the cut: its tail grows or shrinks, and the clip after the cut and everything later move with it on every track that has no clip " +
      "running across a cut (`ripple`); the music the grid follows runs across the cuts, so it and its beats stay put, as does a voice line or " +
      "a long background clip. Clips of a rippled track that end at the cut are trimmed with it, so sound cut with the picture stays in sync. " +
      "Every cut keeps its own place: after a move the next cut that does not move is put back where it was, so only the shots between them " +
      "change length. A move is `blocked` (with a `reason`) when the material is not there (no more of the file after the clip's end), a clip " +
      "would be empty or overlap, a multicam shot would be trimmed, or a transcribed word would be cut, dropped or added at the trimmed end " +
      "(clips with sound but no transcript are moved with a warning). `skip` leaves moves out by id; `dryRun: true` changes nothing and returns " +
      "every cut with its `status`. If the music clip carries duck keys (`track.duck`), duck runs again in the same transaction, since the voice " +
      "moved with the picture (`skip: [\"duck\"]` leaves them). Markers stay where they are unless every track ripples (no music under the cuts). One transaction labelled `Music grid: …` (`revert` " +
      "undoes it whole; with review mode on it is one proposal). Example: `{ dryRun: true }`, then `{ skip: [\"g3\"] }`. Fails with " +
      "InvalidOperation (no tempo, no beats file yet, a LOW confidence grid, a `skip` id that is no move) or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      to: z.enum(["beat", "bar"]).default("beat").describe("Land cuts on beats (default) or on bar starts."),
      maxShift: z
        .number()
        .positive()
        .max(MUSIC_GRID_MAX_SHIFT_LIMIT_S)
        .default(MUSIC_GRID_MAX_SHIFT_DEFAULT_S)
        .describe(`Farthest a cut moves, seconds. Default ${MUSIC_GRID_MAX_SHIFT_DEFAULT_S} (half a beat at 120 BPM); cuts farther off are listed as \`far\`.`),
      dryRun: z.boolean().default(false).describe("Only return the cuts and the planned moves; change nothing."),
      skip: z.array(z.string().min(1)).optional().describe("Move ids (`g1`…) from a dry run to leave out, and `duck` to leave the duck keys as they are."),
    }),
    result: MusicGridResultSchema,
  },
} as const satisfies Record<string, MethodSpec>;
