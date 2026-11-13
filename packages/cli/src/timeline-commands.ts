import type {
  CaptionsSetResult,
  ClipReframeResult,
  ClipVerifyResult,
  CleanupResult,
  ConfigOperation,
  DaemonConnection,
  HistoryResult,
  MarkerListResult,
  MulticamCreateResult,
  MulticamDirectResult,
  MulticamFacesResult,
  MulticamGalleryResult,
  MulticamTurnsResult,
  MusicCandidatesResult,
  MusicFitResult,
  MethodName,
  MethodResult,
  OperationResult,
  Progress,
  TimelineProblem,
  TimelineView,
  TrackDuckResult,
  TrackSummary,
} from "@frameshell/protocol";
import { SECONDS_TEXT } from "@frameshell/protocol";
import { glassOf, resolveStyle, resolveSubtitleStyle, voiceChainOf } from "@frameshell/schema";

/** Usage text of the timeline commands, appended to the CLI help. */
export const TIMELINE_USAGE = `Timeline (all accept --timeline <id>, default main; times in seconds, snapped to the frame grid;
mutations print the new revision):
  timeline show [--json]       Tracks and clips with ids, start/end, in/out (--json: compact dump)
  track list                   Tracks in stacking order (first video track = bottom layer)
  track add <video|audio|subtitles> [--name n] [--follows <track>] [--index n] [--preset p] [--position pos]
           [--entry none|chars|words|line] [--keyword-color #rrggbb|none] [--keyword-scale 1-2]
  track set <track> [--name n | --clear-name] [--index n] [--follows <track>] [--preset p] [--position pos]
           [--entry none|chars|words|line] [--keyword-color #rrggbb|none] [--keyword-scale 1-2]
           [--gap from-to … | --clear-gaps] [--muted | --unmuted] [--hidden | --shown] [--behind <plate track> | none]
           [--format <id> [--reset]]
                               --muted silences a video, audio or program track; --hidden leaves a video or
                               program track's pictures out of export and preview (its sound still plays);
                               --behind puts a video track's pictures behind the person in front on a lower video
                               track (export makes the plate's subject matte when missing; not in the preview yet).
                               --format <id> (a format other than the primary) sets a subtitle track's style
                               fields in that format only; --reset first drops that format's style
  track remove <track> [--force]
  captions set <track> (--text "…" | --file path) [--from s] [--to s] [--replace]
                               Hand-chunked captions on a subtitle track: one phrase per line, chunks (one cue each)
                               split by |, the phrase's one keyword between asterisks, e.g.
                               'No need to | open any | *editor*'. Covers the words the track shows between --from
                               and --to, matched by position (a lost or repeated word fails). --replace drops the
                               track's other phrases (alone: clears them)
  clip add <track> [asset] [--start s] [--in s] [--out s | --duration s] [--speed x]
           [--type media|timeline|<adapter>] [--source path] [--props json]
           [--gain dB] [--muted] [--audio-fade-in ms] [--audio-fade-out ms] [--x px] [--y px] [--scale k]
           [--opacity 0-1] [--script-ref ref] [--ripple [--ripple-track <track>…]] [--snap] [--snap-window s]
  clip move <clip> [--start s] [--track <track>]
  clip trim <clip> [--in s | --start s] [--out s | --end s] [--ripple [--ripple-track <track>…]]
           [--no-snap] [--snap-window s]
  clip split <clip> --at s
  clip remove <clip>
  clip key <clip> --prop x|y|scale|opacity|gain --at s [--value v] [--ease linear|in|out|in-out] [--remove] [--clear]
           [--format <id>]
                               Keyframe: --at is timeline seconds inside the clip; --value defaults to what plays
                               there now. --remove deletes the key at --at; --clear (no --at) every key of --prop.
                               --format <id> keys x, y, scale or opacity in that format only; with --clear the
                               clip moves there as in the primary again
  clip reframe <clip> [--format 9x16] [--person <id|name> | --anchor 0-1]
                               Frame a video clip for another aspect (default 9x16, for reels), keeping a face in
                               it: scales the picture to cover the frame and positions it so the face sits centered,
                               30 % from the top, never showing outside the picture. Looks at 2 frames per second
                               of the clip's own stretch (first run downloads the YuNet face detector, about 33 MB),
                               follows the largest face and writes x/y keys only where it moves (a face that never
                               moves gives a static placement). --person follows that person's face from the cached
                               people scan instead; --anchor (0 left edge, 1 right edge) fixes the picture's
                               horizontal position with no face detection. Replaces the clip's x, y and scale; one
                               transaction, revert undoes it. Correct the keys with clip key or in the app
  clip verify <clip> [--probes n] [--tolerance 0-255]
                               Check that a generated clip (a motion clip, any adapter with a live preview) paints
                               a pure function of time: captures --probes frames (default 12, 2 to 48) at
                               (i + 0.37) x duration / n of the clip, each twice, cold (a fresh page seeks to the
                               time) and after a reseek (the page shows an unrelated probe first), and compares
                               the pixels: more than --tolerance of 255 on a channel (default 2) fails, exit 1,
                               naming the worst frame, pixel and element. Also warns when every probe is the same
                               picture (the clip never moves). Takes up to a minute; writes nothing, renders nothing
  clip set <clip> [--speed x] [--gain dB] [--muted | --unmuted] [--audio-fade-in ms] [--audio-fade-out ms]
           [--x px] [--y px] [--scale k] [--opacity 0-1] [--props json] [--elements json | --clear-elements]
           [--voice | --audio-effects json | --clear-audio-effects] [--script-ref ref | --clear-script-ref]
           [--glass] [--backdrop-blur px] [--backdrop-saturate x] [--backdrop-dim 0-1] [--clear-backdrop]
           [--format <id> [--x px] [--y px] [--scale k] [--opacity 0-1] [--props json] [--elements json]
           [--hidden | --shown] [--reset]]
                               --format <id> (a format other than the primary, see format list) sets the clip in
                               that format only, where its automatic layout is wrong: placement, a generated clip's
                               props and elements, --hidden (no picture there, its sound still plays); --reset
                               first drops what that format had. Timing and sound are every format's
                               --audio-fade-in/--audio-fade-out ms: equal-power sound ramps at a media clip's
                               start/end, sample-accurate (not whole frames), e.g. 12 to de-click a cut; 0 removes
                               --voice writes the style's voice chain (style.json sound.voice; by default high-pass
                               85 Hz, denoise floor -30 dB reduction 8 dB, compressor -20 dB 2.5:1 attack 8 ms
                               release 140 ms makeup +2 dB) as explicit audio effects; --audio-effects replaces the list, e.g.
                               '[{"kind":"highpass","frequency":90}]'. Media clips only; baked in the background.
                               --glass gives a generated clip on an upper track the style's glass backdrop (style.json
                               glass; by default blur 46 px, saturate 1.45, dim 0.55): what is below the clip is
                               blurred, saturated and dimmed where the clip shows. Glass is a style choice, never a
                               default. --backdrop-* set one number each, over --glass (blur = Gaussian sigma in project px)
  multicam create <asset> <asset>… [--name <angle>…] [--mic-file <file>…] [--mic-name <n>…] [--sound <s>…]
                  [--group-name n]
                               One video file per camera or person: measures every file's offset against all the
                               others by audio cross-correlation, adds a group, a program track and one grid shot
                               over the cameras' length. Prints every file's confidence; below 0.5 the file is not
                               shifted and a warning says so. --name once per file, in order (default: file name).
                               Separate mic files: --mic-file once per mic (any start time; --mic-name names them).
                               --sound once per camera, in order: a mic number (1 = first --mic-file), none (wide
                               camera, no sound) or camera (its own file); default: camera n takes mic n. One mic
                               may serve several cameras
  multicam gallery <asset> [--name <tile>…] [--group-name n] [--at s] [--into <group> [--mic <mic id> | none]]
                               One gallery-view call recording (Zoom, Meet, Teams): finds the tile grid by its
                               gutters on frames sampled over the whole file, adds one angle per tile (a crop of the
                               same file, rows top to bottom, each left to right), a program track and one grid shot.
                               The file's sound plays once, through one group mic all tiles share. Prints each tile's
                               crop and confidence and every layout change (someone joins, a screen share) with its
                               time; the tiles follow the layout held longest, or the one playing at --at. --name
                               once per tile, in that order (default Tile 1, Tile 2…). Fix a tile with multicam angle
                               --crop-*. --into: add the tiles to an existing group that has <asset> as an angle (a
                               call recorded in the Shoot view), at its offset, keeping its shots; --mic picks the
                               group mic they are heard through (the call's system audio), default that angle's sound
  multicam offset <group> <angle> <seconds>
                               Fix one angle's sync by hand: the group second at which its file's time 0 plays
                               (absolute, >= 0; a smaller number plays the angle earlier)
  multicam angle <group> <angle> [--name n] [--crop-left f] [--crop-top f] [--crop-right f] [--crop-bottom f]
                 [--clear-crop] [--gain dB] [--muted | --unmuted] [--mic <mic id> | camera | none] [--screen | --no-screen]
                 [--speaker s1 | --clear-speaker]
                               Rename an angle, crop its picture (fractions cut off each side, 0 to below 1), set
                               its sound under every shot, pick where it is heard (a mic of the group, camera: its
                               own file, or none; with a mic, gain and mute belong to the mic) or mark it a screen
                               share (--screen: shown by screen and pip shots while it moves, never as a speaker), or
                               name the transcript speaker whose words are its turns (a file or mic people share;
                               transcribe --speakers on that sound's file first)
  multicam mic <group> <mic> [--name n] [--offset s] [--gain dB] [--muted | --unmuted]
                               Fix a separate mic: rename it, set the group second at which its file's time 0 plays
                               (absolute, >= 0) or its sound under every shot
  multicam reframe <group> <angle> (--time s | --at s) [--x f] [--y f] [--remove]
  multicam reframe <group> <angle> --clear
                               Keep a face in frame when a tile cuts the angle's picture (solo and two-up shots of a
                               9:16 export of 16:9 cameras): a key at timeline second --time (or group second --at)
                               centering the cut on --x/--y (fractions of the picture, 0 left/top, 1 right/bottom;
                               omitted: the point there now). The point moves in a straight line between keys and
                               holds outside them. --remove deletes the key in that frame, --clear every key
  multicam faces <group> [<angle>…] [--replace]
                               Propose reframe keys from faces: looks at 2 frames per second of each angle (default:
                               every angle that is not a screen), follows the largest face in its crop and writes keys
                               where it moves, in one transaction (one revert undoes it). Skips angles that already
                               have keys unless --replace. First run downloads ONNX Runtime and the YuNet face
                               detector (about 33 MB). Correct the keys with multicam reframe or in the app
  multicam paint <group> [<angle>] --from s --to s (--speaking [--alone] | --silent | --measured)
                               Correct who speaks by hand, on the group clock: --speaking marks the angle as
                               speaking from --from to --to (--alone: everyone else that can speak is silent
                               there), --silent as not speaking, whatever its sound says; --measured takes the range
                               back to the measured turns (no <angle>: every angle). Painted turns replace the
                               measured ones for multicam turns and direct, and revert undoes them
  shot set <shot> [--layout solo|two-up|grid|screen|pip] [--angles a,b,…] [--corner top-left|top-right|bottom-left|bottom-right]
                               Change a shot's layout and the angles it shows, in layout order. Only --layout: the
                               angles are kept, cut or filled from the group; only --angles: the layout follows the
                               count when it does not fit (1 solo, 2 two-up, more grid). screen shows one angle whole,
                               with bars; pip takes the screen first, then the speaker as an inset in --corner (default
                               bottom-right)
  multicam turns <group>       Who speaks when: every angle's speaking turns on the group clock, from that angle's own
                               mic (a voice heard in another person's mic does not count; people talking at once
                               overlap), or from transcript speakers for angles sharing a file or naming a speaker.
                               Read-only; --json gives {turns: [{angle, name, start, end}], duration, warnings, speakers}
  image cutout <clip> --mask <png>
                               Image projects: cut a part of a photo out as a new layer right above it, exactly over
                               it. <clip> is the photo's clip; --mask a grayscale PNG at the photo's pixel size, white
                               = keep (the mask of an inspect --segment point, or your own). Writes
                               assets/<photo>-cutout-<n>.png (the photo is not changed), one transaction; revert
                               removes the layer. Background removal: image cutout, then clip set <photo> --opacity 0
  direct <group> [--template interview|podcast-calm|panel-dynamic] [--rules file] [--from s] [--to s] [--replace-human]
                               Shots from who speaks, by rules (director.json at the project root on top of the
                               template, or --rules): written on the program track in one operation, each with a
                               confidence and reason. Same input, same shots. Keeps shots a person chose in the app
                               unless --replace-human. Lists the doubtful ones (--json: low)
  duck <track> --under <track>… [--depth dB] [--attack ms] [--release ms] [--threshold dBFS] [--gap s] [--level dB]
                               Music under a voice: writes gain keys on the clips of audio track <track> that dip
                               while someone speaks on the --under tracks (video or audio; speech = sound above
                               --threshold=-40 style, default -38 dBFS; stretches closer than --gap, default 0.6 s, merge).
                               Dip --depth dB (default 7), complete as the voice starts (--attack ms, default 40) and
                               gone --release ms after it ends (default 450). The keys are the clip's level minus
                               the dip, marked as the duck's: run it again after an edit and they are replaced, keys
                               you set with clip key stay (and are dipped too where a voice speaks). Edit the curve
                               like any gain key; a key you set is a level, not a dip. --level dB first sets the
                               static gain of each clip so the music's loudness (EBU R128, measured once per file
                               and cached) sits that many dB under the voice's (about 12 is a start); a clip with gain
                               keys of its own is left alone. The settings are kept in each ducked clip (audio.duck):
                               music fit runs the same duck again after it moves one. Revert undoes it
  transition set --at s [--kind dissolve|fade|wipe|push|iris|dip-cut] [--direction left|right|up|down]
           [--origin x0,y0,x1,y1] [--duration s] [--track <track>…]
                               At the clip edge at --at on every video and audio track (--track limits): dissolve
                               (default, sound crossfades) or fade (dip through black), 0.5 s by default. wipe and
                               push move the picture the --direction way (default left), iris opens it in a circle
                               from the centre of --origin (fractions of the frame, default its centre); these play on
                               the bottom video track only. dip-cut: a hard cut, the clip ending there darkened 40 %
                               over its last 3 frames (opacity keys; bottom video track, sound untouched). A clip's
                               start or end with nothing butted fades in or out. Short material shortens it, with a warning
  transition remove --at s [--track <track>…]
  marker add --at s --label l [--color red|orange|yellow|green|blue|purple]
                               A named point on the timeline clock (a hook, a beat to land on); labels are unique
                               ignoring case, never shaped like an id (m_…) or a grid ref (beat:8,
                               bar:2). cut moves markers after the cut with the
                               material and removes markers strictly inside the range (one on its first frame stays)
                               when it cuts every track; ripple trims and inserts move them the same way, and a ripple
                               trim removes markers inside the material it cuts away
  marker set <marker> [--at s] [--label l] [--color c | --clear-color]
                               <marker> is the id (m_…) or the label
  marker remove <marker>
  marker list                  Markers by time: id, time, label, colour
  tempo set (--clip <clip> | --bpm n [--offset s] [--meter n] | --clip <clip> --bpm n [--offset s] [--meter n])
                               The timeline's beat grid (the app draws it, bars stronger than beats; drags and
                               --snap-to land on it). --clip: follow the measured grid of that music clip
                               (run beats measure on its asset first; moving or trimming the clip moves the grid).
                               --bpm: a nominal grid for blocking a film before music exists, beat i at
                               --offset + 60 i / bpm seconds (default 0), --meter beats per bar (default 4); with
                               --clip it rides on that clip and --offset is in the clip's source seconds. Replaces
                               the whole tempo; removing the clip clears it
  tempo clear                  Remove the timeline's tempo
  tempo show                   The stored tempo and its grid on the timeline clock: bpm, bars and beats in seconds;
                               says why there is no grid yet (no beats file for the clip)
  cut [track…] --from s --to s [--no-snap] [--snap-window s]
                               Remove a timeline range and close the gap on every (or the given) track
  cleanup [--pauses s | --no-pauses] [--breath s] [--retakes] [--min-confidence 0-1] [--skip id…] [--dry-run]
                               Cut dead air and false starts of a talking head: pauses between words longer than
                               --pauses (default 0.4 s) that the audio confirms are quiet, with --breath (0.1 s)
                               left on each side; --retakes also cuts the earlier attempt of a phrase said again
                               (the last take stays). --dry-run lists the candidates (kind, start, end, words,
                               reason, confidence) and changes nothing; run again without it, --skip dropping the
                               ids to leave. One transaction (\`revert\` it); candidates under --min-confidence
                               (default 0.5) are not proposed. Needs a transcript of the speech
  music fit <clip> --end <time> [--from <time>] [--hit s] [--exact] [--skip duck] [--dry-run]
                               Fit a music clip (a media clip of an audio track) to the cut: back-time it so the
                               track's own final hit lands on --end (seconds, or a marker id or label such as
                               end-card) and it plays unspliced before it; prints where the music then starts.
                               The hit is found on the track's energy (--hit s: source seconds of the file) and
                               reported with a confidence and the other strong hits. The clip slides, keeping its
                               speed: when that would start it before --from (default 0) the intro is dropped, when the
                               track is shorter than the picture the music starts late (never looped or spliced).
                               --exact keeps the start (the clip's, or --from) and changes the speed so the hit lands
                               on --end: at most 1.7 %, refused beyond it with the ends that fit; a doubtful hit
                               never does. --dry-run changes nothing. If the clip carries duck keys, duck runs again
                               in the same transaction over the other tracks with the settings the duck was run with
                               (--skip duck leaves them). One transaction (revert it)
  music candidates <asset> <asset>… [--end <time>] [--from <time>] [--loudness LUFS] [--dry-run]
                               Put 2 to 7 candidate tracks under the same picture to pick by ear: each file on its own
                               new audio track Music 1..n, all muted but the first, at one loudness (EBU R128 over the
                               whole file, measured once and cached): --loudness LUFS, default the quietest file's own,
                               so none is made louder than it is. They start at --from (default 0) and play whole;
                               with --end each is fitted like music fit slides a clip (its own final hit lands on
                               --end) and they are ranked: files that cover the picture first, then by how sure the
                               hit is. A file that cannot be placed is listed and left out. --dry-run changes nothing.
                               Choose with track set <track> --unmuted, then track remove <others> --force. One
                               transaction (revert it)
  cut and clip trim move edges on media with audio into the nearest pause (±0.5 s, or frameshell.json
  editing.snapWindow; --snap-window 0.5-10 overrides); the output lists requested vs applied times.
  --no-snap uses the exact times. clip add snaps media in/out only with --snap.
  --snap-to beat|bar|marker (clip add, clip move, clip trim, clip split, clip key, transition, marker add and set, cut)
  moves each time of the command to the nearest beat, bar start or marker (within 1 s) first; a cut or clip trim
  then lands exactly (no pause snapping, so --snap-window is refused with it). beat and bar are refused without a
  tempo, and on a LOW confidence grid (check beats show, correct edits in the beats file or measure again with --bpm).
  --ripple (clip add, clip trim) moves later clips on every video, audio and program track by the length added or
  removed, the inverse of cut: restore removed material without overlapping the next clip.
  --ripple-track <track> (repeatable) limits that to the clip's own track plus the named ones.
  Subtitle tracks (--follows a video or audio track) show the transcript words of that track's clips: cuts
  update them, text corrections go in the transcript. --preset big-keyword (default: few large words, the
  spoken one highlighted) or plain; --position top, center or bottom. --entry fades the text in (chars, words as
  spoken, or the whole line); --keyword-color/--keyword-scale style the word captions set marks; --gap 12-15.5
  hides cues in that range (repeatable). Preview and export look the same.
  Negative values need =, e.g. --gain=-6.
  Times on the timeline clock (--at, --from, --to of cut, marker, transition, clip split and clip key; --start and
  --end of clip add, clip move and clip trim) are seconds or a marker id or label, with an optional offset:
  --at hook, --at hook+0.5, --from intro --to outro-1. The daemon turns the name into seconds before the change
  runs and the history records seconds. A label that looks like an offset (end-card) is tried whole first.
  beat:N and bar:N name a beat or a bar start counting from 1 in the music FILE (beat:1 = its first measured
  beat, bar:1 = its first downbeat; trimming the clip head does not renumber), with the same optional
  offset: --at bar:8, --from bar:2 --to bar:6, --start beat:17-0.1, --at beat:2.5 (halfway between beats 2 and 3).
  Past the measured part they continue at the tempo. With a pickup, bar:N is not beat:(meter*(N-1)+1). They need
  a tempo (tempo set) and are refused on a LOW confidence grid or with no beats file, like --snap-to beat|bar.
  music fit --end/--from take them too (bar:16 is read on the clip as it is before the fit). word: names are still refused.

History (per terminal session; mutations print their op and tx ids). The session is FRAMESHELL_SESSION (set in
app terminals), else generated per shell (sh-<pid>-<hash>): calls from one shell share it. Harnesses that start a
new shell per command should export FRAMESHELL_SESSION to group across commands. History names the agent CLI
the app detects in its terminal (agent:<label>:<session>); FRAMESHELL_AGENT=<label> names it yourself, empty = none.
  tx begin "<label>"           Group the following operations until commit/abort (else grouped until ~10 s idle).
                               Survives daemon restarts
  tx commit | tx abort         Keep, or undo, the open transaction's changes. Abort undoes every timeline or,
                               on any conflict, none (listing every conflict)
  history [--since <tx>]       Operations grouped by transaction; --since: only what came after <tx>
  revert <tx|op>               Undo a transaction or one operation, as a new operation
`;

/** Timeline command words handled here. */
export const TIMELINE_COMMANDS = new Set(["timeline", "track", "captions", "clip", "multicam", "shot", "direct", "duck", "cut", "cleanup", "music", "transition", "marker", "tempo", "tx", "history", "revert", "image"]);

/** Flags these commands read; declared once for `parseArgs`. */
export const TIMELINE_OPTIONS = {
  timeline: { type: "string" },
  name: { type: "string", multiple: true },
  "mic-file": { type: "string", multiple: true },
  "mic-name": { type: "string", multiple: true },
  sound: { type: "string", multiple: true },
  mic: { type: "string" },
  offset: { type: "string" },
  "group-name": { type: "string" },
  into: { type: "string" },
  "clear-name": { type: "boolean" },
  follows: { type: "string" },
  preset: { type: "string" },
  position: { type: "string" },
  index: { type: "string" },
  force: { type: "boolean" },
  type: { type: "string" },
  source: { type: "string" },
  start: { type: "string" },
  end: { type: "string" },
  in: { type: "string" },
  out: { type: "string" },
  duration: { type: "string" },
  speed: { type: "string" },
  gain: { type: "string" },
  "audio-fade-in": { type: "string" },
  "audio-fade-out": { type: "string" },
  muted: { type: "boolean" },
  unmuted: { type: "boolean" },
  hidden: { type: "boolean" },
  shown: { type: "boolean" },
  behind: { type: "string" },
  x: { type: "string" },
  y: { type: "string" },
  scale: { type: "string" },
  opacity: { type: "string" },
  props: { type: "string" },
  elements: { type: "string" },
  "clear-elements": { type: "boolean" },
  voice: { type: "boolean" },
  "audio-effects": { type: "string" },
  "clear-audio-effects": { type: "boolean" },
  glass: { type: "boolean" },
  "backdrop-blur": { type: "string" },
  "backdrop-saturate": { type: "string" },
  "backdrop-dim": { type: "string" },
  "clear-backdrop": { type: "boolean" },
  "script-ref": { type: "string" },
  "clear-script-ref": { type: "boolean" },
  track: { type: "string", multiple: true },
  kind: { type: "string" },
  direction: { type: "string" },
  origin: { type: "string" },
  prop: { type: "string" },
  ease: { type: "string" },
  value: { type: "string" },
  at: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  since: { type: "string" },
  "no-snap": { type: "boolean" },
  "snap-to": { type: "string" },
  clip: { type: "string" },
  bpm: { type: "string" },
  meter: { type: "string" },
  snap: { type: "boolean" },
  ripple: { type: "boolean" },
  "ripple-track": { type: "string", multiple: true },
  "snap-window": { type: "string" },
  "crop-left": { type: "string" },
  "crop-top": { type: "string" },
  "crop-right": { type: "string" },
  "crop-bottom": { type: "string" },
  "clear-crop": { type: "boolean" },
  speaker: { type: "string" },
  "clear-speaker": { type: "boolean" },
  layout: { type: "string" },
  angles: { type: "string" },
  corner: { type: "string" },
  screen: { type: "boolean" },
  "no-screen": { type: "boolean" },
  time: { type: "string" },
  remove: { type: "boolean" },
  clear: { type: "boolean" },
  speaking: { type: "boolean" },
  silent: { type: "boolean" },
  measured: { type: "boolean" },
  alone: { type: "boolean" },
  template: { type: "string" },
  rules: { type: "string" },
  "replace-human": { type: "boolean" },
  replace: { type: "boolean" },
  under: { type: "string", multiple: true },
  depth: { type: "string" },
  attack: { type: "string" },
  release: { type: "string" },
  threshold: { type: "string" },
  mask: { type: "string" },
  label: { type: "string" },
  color: { type: "string" },
  "clear-color": { type: "boolean" },
  text: { type: "string" },
  file: { type: "string" },
  entry: { type: "string" },
  "keyword-color": { type: "string" },
  "keyword-scale": { type: "string" },
  gap: { type: "string", multiple: true },
  "clear-gaps": { type: "boolean" },
  format: { type: "string" },
  reset: { type: "boolean" },
  person: { type: "string" },
  anchor: { type: "string" },
  pauses: { type: "string" },
  "no-pauses": { type: "boolean" },
  breath: { type: "string" },
  retakes: { type: "boolean" },
  "min-confidence": { type: "string" },
  skip: { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
  hit: { type: "string" },
  exact: { type: "boolean" },
  level: { type: "string" },
  loudness: { type: "string" },
  probes: { type: "string" },
  tolerance: { type: "string" },
} as const;

type Values = Record<string, string | boolean | string[] | undefined>;

/** Parsed timeline invocation: one daemon method and its params minus `cwd`. */
export interface TimelineInvocation {
  kind: "timeline";
  method: MethodName;
  params: Record<string, unknown>;
  /** False for `tx.*`: session-scoped, no project directory. */
  withCwd: boolean;
  /** `clip set --voice`: `audioEffects` is filled from the project's style (`sound.voice`) before the request. */
  voiceFromStyle?: boolean;
  /** `clip set --glass`: `backdrop` is filled from the project's style (`glass`) before the request; other `--backdrop-*` win. */
  glassFromStyle?: boolean;
}

/** Bad arguments; the message says which and how to fix. Exit code 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Flags allowed per command besides `--json`/`--timeline`. */
const ALLOWED: Record<string, string[]> = {
  "timeline show": [],
  "track list": [],
  "track add": ["name", "follows", "index", "preset", "position", "entry", "keyword-color", "keyword-scale"],
  "track set": ["name", "clear-name", "index", "follows", "preset", "position", "entry", "keyword-color", "keyword-scale", "gap", "clear-gaps", "muted", "unmuted", "hidden", "shown", "behind", "format", "reset"],
  "captions set": ["text", "file", "from", "to", "replace"],
  "track remove": ["force"],
  "clip add": ["type", "source", "start", "in", "out", "duration", "speed", "gain", "muted", "audio-fade-in", "audio-fade-out", "x", "y", "scale", "opacity", "props", "script-ref", "ripple", "ripple-track", "snap", "snap-window", "snap-to"],
  "clip move": ["start", "track", "snap-to"],
  "clip trim": ["in", "out", "start", "end", "ripple", "ripple-track", "no-snap", "snap-window", "snap-to"],
  "clip split": ["at", "snap-to"],
  "clip remove": [],
  "clip key": ["prop", "at", "value", "ease", "remove", "clear", "snap-to", "format"],
  "clip reframe": ["format", "person", "anchor"],
  "clip verify": ["probes", "tolerance"],
  "clip set": [
    "speed",
    "gain",
    "muted",
    "unmuted",
    "audio-fade-in",
    "audio-fade-out",
    "x",
    "y",
    "scale",
    "opacity",
    "props",
    "elements",
    "clear-elements",
    "voice",
    "audio-effects",
    "clear-audio-effects",
    "glass",
    "backdrop-blur",
    "backdrop-saturate",
    "backdrop-dim",
    "clear-backdrop",
    "script-ref",
    "clear-script-ref",
    "format",
    "hidden",
    "shown",
    "reset",
  ],
  "transition set": ["at", "kind", "direction", "origin", "duration", "track", "snap-to"],
  "transition remove": ["at", "track", "snap-to"],
  "marker add": ["at", "label", "color", "snap-to"],
  "marker set": ["at", "label", "color", "clear-color", "snap-to"],
  "marker remove": [],
  "marker list": [],
  "tempo set": ["clip", "bpm", "offset", "meter"],
  "tempo clear": [],
  "tempo show": [],
  "multicam create": ["name", "group-name", "mic-file", "mic-name", "sound"],
  "multicam gallery": ["name", "group-name", "at", "into", "mic"],
  "multicam offset": [],
  "multicam angle": ["name", "crop-left", "crop-top", "crop-right", "crop-bottom", "clear-crop", "gain", "muted", "unmuted", "mic", "screen", "no-screen", "speaker", "clear-speaker"],
  "multicam mic": ["name", "offset", "gain", "muted", "unmuted"],
  "multicam reframe": ["time", "at", "x", "y", "remove", "clear"],
  "multicam faces": ["replace"],
  "multicam paint": ["from", "to", "speaking", "silent", "measured", "alone"],
  "shot set": ["layout", "angles", "corner"],
  "image cutout": ["mask"],
  "multicam turns": [],
  "direct ": ["template", "rules", "from", "to", "replace-human"],
  "duck ": ["under", "depth", "attack", "release", "threshold", "gap", "level"],
  cut: ["from", "to", "no-snap", "snap-window", "snap-to"],
  cleanup: ["pauses", "no-pauses", "breath", "retakes", "min-confidence", "skip", "dry-run"],
  "music fit": ["end", "from", "hit", "exact", "skip", "dry-run"],
  "music candidates": ["end", "from", "loudness", "dry-run"],
  "tx begin": [],
  "tx commit": [],
  "tx abort": [],
  "history ": ["since"],
  "revert ": [],
};

/** Positional count per command: [min, max]. */
const ARITY: Record<string, [number, number]> = {
  "timeline show": [0, 0],
  "track list": [0, 0],
  "track add": [1, 1],
  "track set": [1, 1],
  "captions set": [1, 1],
  "track remove": [1, 1],
  "clip add": [1, 2],
  "clip move": [1, 1],
  "clip trim": [1, 1],
  "clip split": [1, 1],
  "clip remove": [1, 1],
  "clip key": [1, 1],
  "transition set": [0, 0],
  "transition remove": [0, 0],
  "marker add": [0, 0],
  "marker set": [1, 1],
  "marker remove": [1, 1],
  "marker list": [0, 0],
  "tempo set": [0, 0],
  "tempo clear": [0, 0],
  "tempo show": [0, 0],
  "clip reframe": [1, 1],
  "clip verify": [1, 1],
  "clip set": [1, 1],
  "multicam create": [2, Number.POSITIVE_INFINITY],
  "multicam gallery": [1, 1],
  "multicam offset": [3, 3],
  "multicam angle": [2, 2],
  "multicam mic": [2, 2],
  "multicam reframe": [2, 2],
  "multicam faces": [1, Number.POSITIVE_INFINITY],
  "multicam paint": [1, 2],
  "shot set": [1, 1],
  "image cutout": [1, 1],
  "multicam turns": [1, 1],
  "direct ": [1, 1],
  "duck ": [1, 1],
  cut: [0, Number.POSITIVE_INFINITY],
  cleanup: [0, 0],
  "music fit": [1, 1],
  "music candidates": [2, 7],
  "tx begin": [1, 1],
  "tx commit": [0, 0],
  "tx abort": [0, 0],
  "history ": [0, 0],
  "revert ": [1, 1],
};

/**
 * Timeline commands (`clip add`, `cut`, `history`…) and the flags each
 * takes, `--timeline` included where it applies.
 */
export function timelineCommandFlags(): Map<string, string[]> {
  return new Map(
    Object.entries(ALLOWED).map(([command, flags]) => [command.trim(), command.startsWith("tx ") ? [...flags] : [...flags, "timeline"]]),
  );
}

/**
 * Parse `timeline|track|clip|cut …`. Returns null for an unknown
 * subcommand; throws {@link UsageError} for bad flags or values.
 */
export function parseTimelineCommand(positionals: string[], values: Values): TimelineInvocation | null {
  const [group, ...rest] = positionals;
  // `history`, `revert`, `direct` and `duck` take no subcommand: key them as "<group> " so ALLOWED/ARITY stay one table.
  const flat = group === "cut" || group === "cleanup" || group === "history" || group === "revert" || group === "direct" || group === "duck";
  const command = group === "cut" || group === "cleanup" ? group : flat ? `${group} ` : `${group} ${rest[0] ?? ""}`;
  const args = flat ? rest : rest.slice(1);
  const allowed = ALLOWED[command];
  const arity = ARITY[command];
  if (!allowed || !arity) return null;
  if (args.length < arity[0] || args.length > arity[1]) {
    throw new UsageError(`\`frameshell ${command.trim()}\` takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]}+`} argument(s), got ${args.length}.`);
  }
  const given = Object.keys(TIMELINE_OPTIONS).filter((flag) => values[flag] !== undefined && values[flag] !== false && flag !== "timeline");
  const extra = given.filter((flag) => !allowed.includes(flag));
  if (extra.length > 0) {
    throw new UsageError(`\`frameshell ${command.trim()}\` does not take ${extra.map((f) => `--${f}`).join(", ")}.`);
  }
  if (group === "tx") {
    if (values["timeline"] !== undefined) throw new UsageError("`frameshell tx` spans every timeline; it does not take --timeline.");
    const method = `tx.${rest[0]}` as "tx.begin" | "tx.commit" | "tx.abort";
    return { kind: "timeline", method, params: method === "tx.begin" ? { label: args[0] } : {}, withCwd: method === "tx.begin" };
  }
  const num = (flag: string): number | undefined => {
    const raw = values[flag];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (typeof raw !== "string" || raw.trim() === "" || !Number.isFinite(value)) {
      throw new UsageError(`--${flag}: expected a number, got "${String(raw)}".`);
    }
    return value;
  };
  const str = (flag: string) => values[flag] as string | undefined;
  /** A rectangle in fractions of the frame: four numbers `x0,y0,x1,y1`. */
  const frameRect = (flag: string): number[] | undefined => {
    const raw = str(flag);
    if (raw === undefined) return undefined;
    const parts = raw.split(",").map((part) => Number(part.trim()));
    if (parts.length !== 4 || raw.split(",").some((part) => part.trim() === "") || parts.some((part) => !Number.isFinite(part))) {
      throw new UsageError(`--${flag}: expected x0,y0,x1,y1 in fractions of the frame, e.g. 0.6,0.2,0.8,0.4, got "${raw}".`);
    }
    return parts;
  };
  /** A time flag: seconds as a number, else the text (a marker id or label, `beat:N` or `bar:N`, optionally `+s` or `-s`) for the daemon to resolve. */
  const when = (flag: string): number | string | undefined => {
    const raw = values[flag];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || raw.trim() === "") throw new UsageError(`--${flag}: expected seconds, a marker id or label, or beat:N / bar:N, got "${String(raw)}".`);
    return SECONDS_TEXT.test(raw.trim()) ? Number(raw) : raw.trim();
  };
  const list = (flag: string): string[] | undefined => {
    const raw = values[flag];
    return raw === undefined ? undefined : ([] as string[]).concat(raw as string | string[]);
  };
  const seconds = (raw: string, what: string): number => {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) throw new UsageError(`${what}: expected a number, got "${raw}".`);
    return value;
  };
  const json = (flag: string): Record<string, unknown> | undefined => {
    const raw = str(flag);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Reported below.
    }
    throw new UsageError(`--${flag}: expected a JSON object, e.g. '{"title":"Hola"}'.`);
  };
  const jsonList = (flag: string): unknown[] | undefined => {
    const raw = str(flag);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Reported below.
    }
    throw new UsageError(`--${flag}: expected a JSON array, e.g. '[{"kind":"highpass","frequency":85}]'.`);
  };
  const transform = () => {
    const t = { x: num("x"), y: num("y"), scale: num("scale"), opacity: num("opacity") };
    return Object.values(t).some((v) => v !== undefined) ? t : undefined;
  };
  const style = () => {
    const color = str("keyword-color");
    const s = {
      preset: str("preset"),
      position: str("position"),
      entry: str("entry"),
      keywordColor: color === "none" ? null : color,
      keywordScale: num("keyword-scale"),
    };
    return Object.values(s).some((v) => v !== undefined) ? s : undefined;
  };
  const gaps = () => {
    if (values["clear-gaps"] === true && values["gap"] !== undefined) throw new UsageError("Pass --gap or --clear-gaps, not both.");
    if (values["clear-gaps"] === true) return [];
    return list("gap")?.map((range) => {
      const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(range);
      if (!match) throw new UsageError(`--gap: expected from-to in seconds, e.g. 12-15.5, got "${range}".`);
      return { from: Number(match[1]), to: Number(match[2]) };
    });
  };
  /** `--snap-to beat|bar|marker` as the `snapTo` param. */
  const snapTo = (): { snapTo: string | undefined } => {
    const kind = str("snap-to");
    if (kind !== undefined && kind !== "beat" && kind !== "bar" && kind !== "marker") throw new UsageError(`--snap-to: expected beat, bar or marker, got "${kind}".`);
    if (kind !== undefined && values["snap-window"] !== undefined && (command === "cut" || command === "clip trim")) {
      throw new UsageError("--snap-window does nothing with --snap-to: the time lands exactly on the beat, bar or marker.");
    }
    return { snapTo: kind };
  };
  const snap = () => {
    if (values["no-snap"] === true && values["snap-window"] !== undefined) throw new UsageError("Pass --no-snap or --snap-window, not both.");
    return { snap: values["no-snap"] === true ? false : undefined, snapWindow: num("snap-window") };
  };
  /** `--format <id>` and `--reset` of `clip set`, `clip key` and `track set` (ADR 0027 overrides), as `format` / `reset`. */
  const inFormat = () => {
    if (values["reset"] === true && str("format") === undefined) throw new UsageError("--reset drops a format's override: pass --format <id> too.");
    return { format: str("format"), reset: values["reset"] === true ? true : undefined };
  };
  /** `--ripple` and its `--ripple-track` scope, as `ripple` / `rippleTracks` params. */
  const ripple = () => {
    const tracks = values["ripple-track"] as string[] | undefined;
    if (tracks !== undefined && values["ripple"] !== true) throw new UsageError("--ripple-track needs --ripple.");
    return { ripple: values["ripple"] === true ? true : undefined, rippleTracks: tracks };
  };
  const tracks = values["track"] as string[] | undefined;
  const params: Record<string, unknown> = { timeline: str("timeline") };
  let method: MethodName;
  switch (command) {
    case "timeline show":
      method = "timeline.show";
      break;
    case "track list":
      method = "track.list";
      break;
    case "track add": {
      method = "track.add";
      const index = num("index");
      if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new UsageError("--index: expected an integer >= 0.");
      Object.assign(params, { kind: args[0], name: str("name"), follows: str("follows"), index, style: style() });
      break;
    }
    case "track set": {
      method = "track.set";
      if (str("name") !== undefined && values["clear-name"] === true) throw new UsageError("Pass --name or --clear-name, not both.");
      const index = num("index");
      if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new UsageError("--index: expected an integer >= 0.");
      if (values["muted"] === true && values["unmuted"] === true) throw new UsageError("Pass --muted or --unmuted, not both.");
      if (values["hidden"] === true && values["shown"] === true) throw new UsageError("Pass --hidden or --shown, not both.");
      Object.assign(params, {
        track: args[0],
        name: values["clear-name"] === true ? null : str("name"),
        index,
        follows: str("follows"),
        style: style(),
        gaps: gaps(),
        muted: values["muted"] === true ? true : values["unmuted"] === true ? false : undefined,
        hidden: values["hidden"] === true ? true : values["shown"] === true ? false : undefined,
        behind: str("behind") === "none" ? null : str("behind"),
        ...inFormat(),
      });
      break;
    }
    case "captions set":
      method = "captions.set";
      if (str("text") !== undefined && str("file") !== undefined) throw new UsageError("Pass --text or --file, not both.");
      if (str("text") === undefined && str("file") === undefined && values["replace"] !== true) {
        throw new UsageError("`frameshell captions set` needs --text <captions> or --file <path> (or --replace alone to clear the phrases).");
      }
      Object.assign(params, { track: args[0], text: str("text"), file: str("file"), from: num("from"), to: num("to"), replace: values["replace"] === true ? true : undefined });
      break;
    case "track remove":
      method = "track.remove";
      Object.assign(params, { track: args[0], force: values["force"] === true });
      break;
    case "clip add":
      method = "clip.add";
      Object.assign(params, {
        track: args[0],
        asset: args[1],
        type: str("type"),
        source: str("source"),
        start: when("start"),
        in: num("in"),
        out: num("out"),
        duration: num("duration"),
        speed: num("speed"),
        gain: num("gain"),
        muted: values["muted"] === true ? true : undefined,
        audioFadeInMs: num("audio-fade-in"),
        audioFadeOutMs: num("audio-fade-out"),
        transform: transform(),
        props: json("props"),
        scriptRef: str("script-ref"),
        ...ripple(),
        snap: values["snap"] === true ? true : undefined,
        snapWindow: num("snap-window"),
        ...snapTo(),
      });
      break;
    case "clip move":
      method = "clip.move";
      if ((tracks?.length ?? 0) > 1) throw new UsageError("--track: clip move takes one track.");
      Object.assign(params, { clip: args[0], start: when("start"), track: tracks?.[0], ...snapTo() });
      break;
    case "clip trim":
      method = "clip.trim";
      Object.assign(params, { clip: args[0], in: num("in"), out: num("out"), start: when("start"), end: when("end"), ...snap(), ...ripple(), ...snapTo() });
      break;
    case "clip split":
      method = "clip.split";
      if (values["at"] === undefined) throw new UsageError("`frameshell clip split <clip>` needs --at <seconds|marker>.");
      Object.assign(params, { clip: args[0], at: when("at"), ...snapTo() });
      break;
    case "clip remove":
      method = "clip.remove";
      params["clip"] = args[0];
      break;
    case "clip key": {
      method = "clip.key";
      if (str("prop") === undefined) throw new UsageError("`frameshell clip key <clip>` needs --prop x, y, scale, opacity or gain.");
      if (values["clear"] === true) {
        const other = ["at", "value", "ease", "remove"].find((flag) => values[flag] !== undefined);
        if (other) throw new UsageError(`--clear removes every key: pass it without --${other}.`);
      } else if (values["at"] === undefined) {
        throw new UsageError("Pass the key time --at <timeline seconds>, or --clear.");
      } else if (values["remove"] === true && (values["value"] !== undefined || values["ease"] !== undefined)) {
        throw new UsageError("--remove deletes the key: pass it without --value or --ease.");
      }
      Object.assign(params, {
        clip: args[0],
        prop: str("prop"),
        time: when("at"),
        value: num("value"),
        ease: str("ease"),
        remove: values["remove"] === true ? true : undefined,
        clear: values["clear"] === true ? true : undefined,
        format: str("format"),
        ...snapTo(),
      });
      break;
    }
    case "transition set":
    case "transition remove": {
      method = command === "transition set" ? "transition.set" : "transition.remove";
      if (values["at"] === undefined) throw new UsageError(`\`frameshell ${command}\` needs --at <seconds|marker>, a clip edge.`);
      Object.assign(params, { at: when("at"), tracks, ...snapTo() });
      if (method === "transition.set") {
        Object.assign(params, { kind: str("kind"), direction: str("direction"), origin: frameRect("origin"), duration: num("duration") });
      }
      break;
    }
    case "marker add":
      method = "marker.add";
      if (values["at"] === undefined || str("label") === undefined) throw new UsageError("`frameshell marker add` needs --at <seconds|marker> and --label <label>.");
      Object.assign(params, { at: when("at"), label: str("label"), color: str("color"), ...snapTo() });
      break;
    case "marker set":
      method = "marker.set";
      if (str("color") !== undefined && values["clear-color"] === true) throw new UsageError("Pass --color or --clear-color, not both.");
      Object.assign(params, { marker: args[0], at: when("at"), label: str("label"), color: values["clear-color"] === true ? null : str("color"), ...snapTo() });
      break;
    case "marker remove":
      method = "marker.remove";
      params["marker"] = args[0];
      break;
    case "marker list":
      method = "marker.list";
      break;
    case "tempo set":
      method = "tempo.set";
      if (str("clip") === undefined && str("bpm") === undefined) throw new UsageError("`frameshell tempo set` needs --clip <music clip> or --bpm <n>.");
      if (str("bpm") === undefined && (str("offset") !== undefined || str("meter") !== undefined)) throw new UsageError("--offset and --meter belong to a nominal grid: pass --bpm too.");
      Object.assign(params, { clip: str("clip"), bpm: num("bpm"), offset: num("offset"), meter: num("meter") });
      break;
    case "tempo clear":
      method = "tempo.set";
      params["clear"] = true;
      break;
    case "tempo show":
      method = "tempo.show";
      break;
    case "clip set": {
      method = "clip.set";
      if (values["muted"] === true && values["unmuted"] === true) throw new UsageError("Pass --muted or --unmuted, not both.");
      if (values["hidden"] === true && values["shown"] === true) throw new UsageError("Pass --hidden or --shown, not both.");
      if (str("script-ref") !== undefined && values["clear-script-ref"] === true) {
        throw new UsageError("Pass --script-ref or --clear-script-ref, not both.");
      }
      if (str("elements") !== undefined && values["clear-elements"] === true) {
        throw new UsageError("Pass --elements or --clear-elements, not both.");
      }
      const effectFlags = [values["voice"] === true, str("audio-effects") !== undefined, values["clear-audio-effects"] === true].filter(Boolean);
      if (effectFlags.length > 1) throw new UsageError("Pass one of --voice, --audio-effects or --clear-audio-effects.");
      const backdropFlags = (["backdrop-blur", "backdrop-saturate", "backdrop-dim"] as const).filter((flag) => str(flag) !== undefined);
      if (values["clear-backdrop"] === true && (values["glass"] === true || backdropFlags.length > 0)) {
        throw new UsageError("Pass --clear-backdrop alone, without --glass or --backdrop-*.");
      }
      const backdrop =
        values["clear-backdrop"] === true
          ? null
          : backdropFlags.length > 0
            ? { blur: num("backdrop-blur"), saturate: num("backdrop-saturate"), dim: num("backdrop-dim") }
            : undefined;
      Object.assign(params, {
        clip: args[0],
        speed: num("speed"),
        gain: num("gain"),
        muted: values["muted"] === true ? true : values["unmuted"] === true ? false : undefined,
        audioFadeInMs: num("audio-fade-in"),
        audioFadeOutMs: num("audio-fade-out"),
        audioEffects:
          values["voice"] === true ? undefined : values["clear-audio-effects"] === true ? null : jsonList("audio-effects"),
        backdrop,
        transform: transform(),
        props: json("props"),
        elements: values["clear-elements"] === true ? null : json("elements"),
        scriptRef: values["clear-script-ref"] === true ? null : str("script-ref"),
        hidden: values["hidden"] === true ? true : values["shown"] === true ? false : undefined,
        ...inFormat(),
      });
      break;
    }
    case "multicam create": {
      method = "multicam.create";
      const names = list("name");
      if (names !== undefined && names.length !== args.length) {
        throw new UsageError(`--name: give one per file (${args.length}), in the same order as the files, got ${names.length}.`);
      }
      const micNames = list("mic-name");
      const micFiles = list("mic-file");
      if (micNames !== undefined && micNames.length !== (micFiles?.length ?? 0)) {
        throw new UsageError(`--mic-name: give one per --mic-file (${micFiles?.length ?? 0}), in the same order, got ${micNames.length}.`);
      }
      Object.assign(params, { assets: args, names, mics: micFiles, micNames, soundOf: list("sound"), name: str("group-name") });
      break;
    }
    case "multicam gallery":
      method = "multicam.gallery";
      if (str("mic") !== undefined && str("into") === undefined) throw new UsageError("--mic: only with --into <group>.");
      Object.assign(params, {
        asset: args[0],
        names: list("name"),
        name: str("group-name"),
        at: num("at"),
        group: str("into"),
        mic: str("mic") === "none" ? null : str("mic"),
      });
      break;
    case "multicam offset":
      method = "multicam.offset";
      Object.assign(params, { group: args[0], angle: args[1], offset: seconds(args[2]!, "<seconds>") });
      break;
    case "multicam angle": {
      method = "multicam.angle";
      if (values["muted"] === true && values["unmuted"] === true) throw new UsageError("Pass --muted or --unmuted, not both.");
      const sides = { left: num("crop-left"), top: num("crop-top"), right: num("crop-right"), bottom: num("crop-bottom") };
      const cropped = Object.values(sides).some((value) => value !== undefined);
      if (cropped && values["clear-crop"] === true) throw new UsageError("Pass --crop-<side> or --clear-crop, not both.");
      if (str("speaker") !== undefined && values["clear-speaker"] === true) throw new UsageError("Pass --speaker or --clear-speaker, not both.");
      if (values["screen"] === true && values["no-screen"] === true) throw new UsageError("Pass --screen or --no-screen, not both.");
      Object.assign(params, {
        group: args[0],
        angle: args[1],
        name: str("name"),
        crop: values["clear-crop"] === true ? null : cropped ? sides : undefined,
        gain: num("gain"),
        muted: values["muted"] === true ? true : values["unmuted"] === true ? false : undefined,
        speaker: values["clear-speaker"] === true ? null : str("speaker"),
        mic: str("mic"),
        screen: values["screen"] === true ? true : values["no-screen"] === true ? false : undefined,
      });
      break;
    }
    case "multicam mic": {
      method = "multicam.mic";
      if (values["muted"] === true && values["unmuted"] === true) throw new UsageError("Pass --muted or --unmuted, not both.");
      const offset = str("offset");
      Object.assign(params, {
        group: args[0],
        mic: args[1],
        name: str("name"),
        offset: offset === undefined ? undefined : seconds(offset, "--offset"),
        gain: num("gain"),
        muted: values["muted"] === true ? true : values["unmuted"] === true ? false : undefined,
      });
      break;
    }
    case "multicam reframe": {
      method = "multicam.reframe";
      const at = str("at");
      const time = str("time");
      if (values["clear"] === true) {
        const other = ["time", "at", "x", "y", "remove"].find((flag) => values[flag] !== undefined);
        if (other) throw new UsageError(`--clear removes every key: pass it without --${other}.`);
      } else if ((at === undefined) === (time === undefined)) {
        throw new UsageError("Pass the key time: --time <timeline seconds> or --at <group seconds>, one of them (or --clear).");
      } else if (values["remove"] === true && (values["x"] !== undefined || values["y"] !== undefined)) {
        throw new UsageError("--remove deletes the key: pass it without --x or --y.");
      } else if (values["remove"] !== true && values["x"] === undefined && values["y"] === undefined) {
        throw new UsageError("Pass --x and/or --y (fractions of the picture, 0 to 1), --remove or --clear.");
      }
      Object.assign(params, {
        group: args[0],
        angle: args[1],
        at: at === undefined ? undefined : seconds(at, "--at"),
        time: time === undefined ? undefined : seconds(time, "--time"),
        x: num("x"),
        y: num("y"),
        remove: values["remove"] === true ? true : undefined,
        clear: values["clear"] === true ? true : undefined,
      });
      break;
    }
    case "multicam faces":
      method = "multicam.faces";
      Object.assign(params, {
        group: args[0],
        angles: args.length > 1 ? args.slice(1) : undefined,
        replace: values["replace"] === true ? true : undefined,
      });
      break;
    case "multicam paint": {
      method = "multicam.paint";
      const kinds = ["speaking", "silent", "measured"].filter((flag) => values[flag] === true);
      if (kinds.length !== 1) throw new UsageError("Pass one of --speaking, --silent or --measured.");
      if (values["alone"] === true && values["speaking"] !== true) throw new UsageError("--alone goes with --speaking.");
      if (args.length === 1 && values["measured"] !== true) throw new UsageError("Name the angle: multicam paint <group> <angle> …");
      if (values["from"] === undefined || values["to"] === undefined) throw new UsageError("Pass --from <group seconds> and --to <group seconds>.");
      Object.assign(params, {
        group: args[0],
        angle: args[1],
        start: num("from"),
        end: num("to"),
        speaking: values["speaking"] === true ? true : values["silent"] === true ? false : null,
        alone: values["alone"] === true ? true : undefined,
      });
      break;
    }
    case "shot set": {
      method = "shot.set";
      const angles = str("angles")
        ?.split(",")
        .map((angle) => angle.trim())
        .filter((angle) => angle !== "");
      if (angles !== undefined && angles.length === 0) throw new UsageError("--angles: give angle ids separated by commas, e.g. --angles ana,ben.");
      Object.assign(params, { clip: args[0], shot: str("layout"), angles, corner: str("corner") });
      break;
    }
    case "clip reframe":
      method = "clip.reframe";
      if (str("person") !== undefined && str("anchor") !== undefined) throw new UsageError("Pass --person or --anchor, not both: they are two ways to place the picture.");
      Object.assign(params, { clip: args[0], format: str("format"), person: str("person"), anchor: num("anchor") });
      break;
    case "clip verify": {
      method = "clip.verify";
      const probes = num("probes");
      if (probes !== undefined && (!Number.isInteger(probes) || probes < 2 || probes > 48)) throw new UsageError("--probes: expected a whole number from 2 to 48.");
      const tolerance = num("tolerance");
      if (tolerance !== undefined && (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255)) throw new UsageError("--tolerance: expected a whole number from 0 to 255.");
      Object.assign(params, { clip: args[0], probes, tolerance });
      break;
    }
    case "image cutout":
      method = "image.cutout";
      if (str("mask") === undefined) throw new UsageError("`frameshell image cutout` needs --mask <png>: a grayscale PNG at the photo's size, white = keep.");
      Object.assign(params, { clip: args[0], mask: str("mask") });
      break;
    case "multicam turns":
      method = "multicam.turns";
      params["group"] = args[0];
      break;
    case "direct ":
      method = "multicam.direct";
      Object.assign(params, {
        group: args[0],
        template: str("template"),
        rules: str("rules"),
        from: num("from"),
        to: num("to"),
        replaceHuman: values["replace-human"] === true ? true : undefined,
      });
      break;
    case "duck ": {
      method = "track.duck";
      const duckGap = (): number | undefined => {
        const raw = list("gap");
        if (raw === undefined) return undefined;
        if (raw.length > 1) throw new UsageError("--gap: pass it once for `duck` (seconds).");
        return seconds(raw[0]!, "--gap");
      };
      const under = list("under");
      if (under === undefined) throw new UsageError("`frameshell duck <track>` needs --under <track>: the track with the voice (repeat it for more).");
      Object.assign(params, {
        track: args[0],
        under,
        depth: num("depth"),
        attackMs: num("attack"),
        releaseMs: num("release"),
        threshold: num("threshold"),
        gap: duckGap(),
        level: num("level"),
      });
      break;
    }
    case "cleanup":
      method = "cleanup";
      if (values["no-pauses"] === true && values["pauses"] !== undefined) throw new UsageError("Pass --pauses <s> or --no-pauses, not both.");
      if (values["no-pauses"] === true && values["retakes"] !== true) throw new UsageError("--no-pauses leaves nothing to look for without --retakes.");
      Object.assign(params, {
        pauses: values["no-pauses"] === true ? false : num("pauses"),
        breath: num("breath"),
        retakes: values["retakes"] === true ? true : undefined,
        minConfidence: num("min-confidence"),
        skip: list("skip")?.flatMap((ids) => ids.split(",")).map((id) => id.trim()).filter((id) => id !== ""),
        dryRun: values["dry-run"] === true ? true : undefined,
      });
      break;
    case "music fit":
      method = "music.fit";
      if (values["end"] === undefined) throw new UsageError("`frameshell music fit <clip>` needs --end <time>: seconds, a marker id or label, or beat:N / bar:N.");
      Object.assign(params, {
        clip: args[0],
        end: when("end"),
        from: when("from"),
        hit: num("hit"),
        exact: values["exact"] === true ? true : undefined,
        skip: list("skip")?.flatMap((ids) => ids.split(",")).map((id) => id.trim()).filter((id) => id !== ""),
        dryRun: values["dry-run"] === true ? true : undefined,
      });
      break;
    case "music candidates":
      method = "music.candidates";
      Object.assign(params, {
        assets: args,
        end: when("end"),
        from: when("from"),
        loudness: num("loudness"),
        dryRun: values["dry-run"] === true ? true : undefined,
      });
      break;
    case "history ":
      method = "history";
      params["since"] = str("since");
      break;
    case "revert ":
      method = "revert";
      params["target"] = args[0];
      break;
    default:
      method = "cut";
      if (values["from"] === undefined || values["to"] === undefined) throw new UsageError("`frameshell cut` needs --from <s> and --to <s>.");
      Object.assign(params, { from: when("from"), to: when("to"), tracks: args.length > 0 ? args : undefined, ...snap(), ...snapTo() });
  }
  const clean = (value: Record<string, unknown> | undefined) =>
    value && Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  if (params["transform"]) params["transform"] = clean(params["transform"] as Record<string, unknown>);
  if (params["style"]) params["style"] = clean(params["style"] as Record<string, unknown>);
  if (params["backdrop"]) params["backdrop"] = clean(params["backdrop"] as Record<string, unknown>);
  const voiceFromStyle = method === "clip.set" && values["voice"] === true;
  const glassFromStyle = method === "clip.set" && values["glass"] === true;
  return {
    kind: "timeline",
    method,
    params: clean(params)!,
    withCwd: true,
    ...(voiceFromStyle ? { voiceFromStyle } : {}),
    ...(glassFromStyle ? { glassFromStyle } : {}),
  };
}

/** Run a parsed timeline command; returns stdout text. `onProgress` gets the progress of long ones (`multicam faces`). */
export async function executeTimeline(
  conn: DaemonConnection,
  inv: TimelineInvocation,
  cwd: string,
  json: boolean,
  onProgress?: (progress: Progress) => void,
  exit?: { code: number },
): Promise<string> {
  const params = inv.withCwd ? { cwd, ...inv.params } : inv.params;
  if (inv.voiceFromStyle || inv.glassFromStyle) {
    const { style } = await conn.request("style.show", { cwd });
    const resolved = style ?? resolveStyle(null);
    if (inv.voiceFromStyle) params["audioEffects"] = voiceChainOf(resolved.sound.voice);
    if (inv.glassFromStyle) params["backdrop"] = { ...glassOf(resolved.glass), ...(params["backdrop"] as object | undefined) };
  }
  // Params are validated by the daemon against the method registry.
  const result = (await conn.request(inv.method, params as never, onProgress ? { onProgress } : {})) as unknown;
  if (inv.method === "timeline.show") {
    // Compact on purpose: agents read this, and indentation roughly doubles its tokens.
    return json ? `${JSON.stringify(result)}\n` : formatTimeline(result as TimelineView);
  }
  if (inv.method === "clip.verify" && !(result as ClipVerifyResult).ok && exit) exit.code = 1;
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  if (inv.method === "track.list") return formatTracks(result as Parameters<typeof formatTracks>[0]);
  if (inv.method === "marker.list") return formatMarkers(result as MarkerListResult);
  if (inv.method === "tempo.show") return formatTempo(result as MethodResult<"tempo.show">);
  if (inv.method === "history") return formatHistory(result as HistoryResult);
  if (inv.method === "tx.begin") {
    const { tx, label } = result as MethodResult<"tx.begin">;
    return `Began ${tx} "${label}"\n`;
  }
  if (inv.method === "tx.commit") {
    const { tx, label, operations } = result as MethodResult<"tx.commit">;
    return `Committed ${tx} "${label}" (${operations} operation${operations === 1 ? "" : "s"})\n`;
  }
  if (inv.method === "tx.abort") {
    const { tx, label, reverted, proposal, config } = result as MethodResult<"tx.abort">;
    const lines = [...reverted.map((r) => `  ${r.timeline}: revision ${r.revision} · op ${r.operation.id}`), ...config.map(formatConfigRevert)];
    const outcome = proposal
      ? `: the undo waits for review as proposal ${proposal.tx}; run \`frameshell proposal wait\`${reverted.length === 0 ? "" : ". Undone at once:"}`
      : reverted.length + config.length === 0
        ? " (nothing to undo)"
        : ", changes undone:";
    return `Aborted ${tx} "${label}"${outcome}\n${lines.map((l) => `${l}\n`).join("")}`;
  }
  if (inv.method === "revert") {
    const { config, ...reverted } = result as MethodResult<"revert">;
    const timelineReverted = !config.some((op) => op.id === reverted.operation.id);
    const lines = config.map(formatConfigRevert).map((line) => `${line}\n`).join("");
    return timelineReverted ? `${formatOperation(reverted)}${lines}` : `${lines}revision ${reverted.revision} (timeline unchanged) · tx ${reverted.operation.tx}\n`;
  }
  if (inv.method === "cleanup") return formatCleanup(result as CleanupResult);
  if (inv.method === "music.fit") return formatMusicFit(result as MusicFitResult);
  if (inv.method === "music.candidates") return formatMusicCandidates(result as MusicCandidatesResult);
  if (inv.method === "multicam.create") return formatMulticamCreate(result as MulticamCreateResult);
  if (inv.method === "multicam.gallery") return formatMulticamGallery(result as MulticamGalleryResult);
  if (inv.method === "multicam.turns") return formatMulticamTurns(result as MulticamTurnsResult);
  if (inv.method === "multicam.direct") return formatMulticamDirect(result as MulticamDirectResult);
  if (inv.method === "multicam.faces") return formatMulticamFaces(result as MulticamFacesResult);
  if (inv.method === "captions.set") return formatCaptions(result as CaptionsSetResult);
  if (inv.method === "clip.reframe") return formatClipReframe(result as ClipReframeResult);
  if (inv.method === "clip.verify") return formatClipVerify(result as ClipVerifyResult);
  if (inv.method === "track.duck") return formatTrackDuck(result as TrackDuckResult);
  if (inv.method === "image.cutout") {
    const { asset, track, clip } = result as MethodResult<"image.cutout">;
    return `Cut-out ${asset} · layer ${clip} on new track ${track}\n${formatOperation(result as OperationResult)}`;
  }
  return formatOperation(result as OperationResult);
}

/** `clip verify` for people: the verdict, one line per probe, then the worst frame and element. */
export function formatClipVerify(result: ClipVerifyResult): string {
  const { probes, worst } = result;
  const failed = probes.filter((probe) => !probe.ok).length;
  const lines = [
    `${result.ok ? "OK" : "FAIL"} · ${result.type} clip ${result.clip} of ${result.timeline} · ${probes.length} probes at ${result.size.width}x${result.size.height}, ` +
      `${result.distinct} different pictures · tolerance ${result.tolerance}/255` +
      (result.ok ? "" : ` · ${failed} of ${probes.length} probes differ after a reseek`),
  ];
  for (const probe of probes) {
    lines.push(`  ${probe.at.toFixed(3).padStart(8)} s  after ${probe.reseekFrom.toFixed(3)} s  max ${String(probe.max).padStart(3)}/255  ${probe.pixels} px over  ${probe.ok ? "ok" : "DIFFERS"}`);
  }
  if (worst) {
    const element = worst.element ? `${worst.element.selector}${worst.element.text === "" ? "" : ` "${worst.element.text}"`}` : "nothing paints there (transparent)";
    lines.push(`Worst: ${worst.at.toFixed(3)} s, pixel ${worst.pixel.x},${worst.pixel.y}, ${worst.max}/255 · ${element}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (!result.ok) {
    lines.push("The picture depends on the order frames are painted. Look for CSS transitions, timers, requestAnimationFrame, Date, unseeded random, will-change or 3D transforms on that element.");
  }
  return `${lines.join("\n")}\n`;
}

function formatCaptions(result: CaptionsSetResult): string {
  const lines = [`Captions on ${result.track}: ${result.phrases} phrase${result.phrases === 1 ? "" : "s"}, ${result.words} word${result.words === 1 ? "" : "s"}`];
  for (const cue of result.cues) lines.push(`  ${cue.start}–${cue.end} s  ${cue.text}${cue.entry === "none" ? "" : `  [${cue.entry}]`}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n${formatOperation(result)}`;
}

function formatMusicFit(result: MusicFitResult): string {
  const s = (value: number) => `${value.toFixed(2)} s`;
  const { hit, before, after } = result;
  const lines = [`Music fit of ${result.clip} (${result.asset}) on ${result.track} · ${result.mode}${result.dryRun ? " · dry run" : ""}`];
  const how = hit.source === "given" ? "given" : `found, confidence ${Math.round(hit.confidence * 100)} %, +${hit.rise} dB`;
  lines.push(`  final hit at ${s(hit.at)} of the file (${how}) lands on ${s(result.landsAt)} (asked ${s(result.end)}, ${result.offsetMs >= 0 ? "+" : ""}${result.offsetMs} ms)`);
  lines.push(`  music starts at ${s(after.start)}, plays to ${s(after.end)}; ${s(result.tail)} after the hit`);
  lines.push(`  was start ${s(before.start)}, in ${s(before.in)}, speed ${before.speed}; now start ${s(after.start)}, in ${s(after.in)}, speed ${after.speed}`);
  if (result.speedChangePercent !== null) lines.push(`  speed ${result.speedChangePercent >= 0 ? "+" : ""}${result.speedChangePercent} %`);
  if (result.introCut > 0) lines.push(`  intro dropped: ${s(result.introCut)}`);
  if (result.silentBefore > 0) lines.push(`  nothing plays in the first ${s(result.silentBefore)}: the track is shorter than the picture before the hit`);
  if (result.steps.length > 0) {
    lines.push("Steps:");
    for (const step of result.steps) lines.push(`  ${step.id.padEnd(6)}${step.detail}${step.skippable ? `  (--skip ${step.id})` : ""}`);
  }
  if (hit.candidates.length > 1) lines.push(`Other strong hits (--hit): ${hit.candidates.slice(0, -1).map((candidate) => s(candidate.at)).join(", ")}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.applied && result.tx) lines.push(`revision ${result.revision} · tx ${result.tx}`);
  return `${lines.join("\n")}\n`;
}

function formatMusicCandidates(result: MusicCandidatesResult): string {
  const s = (value: number) => `${value.toFixed(2)} s`;
  const db = (value: number) => `${value > 0 ? "+" : ""}${value} dB`;
  const lines = [`Music candidates · ${result.candidates.length} track${result.candidates.length === 1 ? "" : "s"} at ${result.loudness.target} LUFS (${result.loudness.source === "given" ? "asked" : "the quietest file's own"})${result.dryRun ? " · dry run" : ""}`];
  for (const c of result.candidates) {
    const where = c.track ? `${c.name} (${c.track}, clip ${c.clip})` : c.name;
    lines.push(`  ${c.rank}. ${c.asset}  ${where}${c.muted ? "" : "  unmuted"}`);
    const fit = c.hit && c.landsAt !== null ? `, final hit ${c.hit.source === "given" ? "" : `${Math.round(c.hit.confidence * 100)} % sure `}lands on ${s(c.landsAt)}` : "";
    lines.push(`     ${c.loudness} LUFS, gain ${db(c.gain)}; plays ${s(c.place.start)}–${s(c.place.end)} from ${s(c.place.in)} of the file${fit}`);
    if (c.introCut > 0) lines.push(`     intro dropped: ${s(c.introCut)}`);
    if (c.silentBefore > 0) lines.push(`     nothing plays in the first ${s(c.silentBefore)}: the file is shorter than the picture before the hit`);
    for (const warning of c.warnings) lines.push(`     warning: ${warning}`);
  }
  for (const skip of result.skipped) lines.push(`Left out ${skip.asset}: ${skip.reason}`);
  lines.push(`Ranking: ${result.ranking}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.applied && result.tx) lines.push(`revision ${result.revision} · tx ${result.tx} (\`frameshell revert ${result.tx}\` undoes it)`);
  return `${lines.join("\n")}\n`;
}

function formatCleanup(result: CleanupResult): string {
  const time = (value: number) => value.toFixed(2);
  const lines = [`Cleanup of ${result.timeline} · ${result.words} words looked at · ${result.candidates.length} candidate${result.candidates.length === 1 ? "" : "s"}`];
  for (const c of result.candidates) {
    const words = c.words.length > 0 ? `  “${c.words.map((word) => word.text).join(" ")}”` : "";
    lines.push(`  ${c.id.padEnd(4)}${c.kind.padEnd(8)}${`${time(c.start)}–${time(c.end)} s`.padEnd(16)}${c.duration.toFixed(2)} s  ${Math.round(c.confidence * 100)}%${c.clean ? "" : "  unclean edge"}${words}`);
    lines.push(`      ${c.reason}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Left alone (${result.skipped.length}):`);
    for (const skip of result.skipped.slice(0, 20)) lines.push(`  ${skip.kind} at ${time(skip.at)} s: ${skip.reason}`);
    if (result.skipped.length > 20) lines.push(`  … and ${result.skipped.length - 20} more (--json lists all)`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.candidates.length === 0) lines.push("Nothing to cut.");
  else if (result.dryRun) lines.push(`Dry run: nothing changed. ${time(result.removed)} s would go; run again without --dry-run (--skip <id> leaves candidates out).`);
  else lines.push(`Cut ${time(result.removed)} s · revision ${result.revision} · tx ${result.tx} (\`frameshell revert ${result.tx}\` undoes it)`);
  return `${lines.join("\n")}\n`;
}

function formatMulticamTurns(result: MulticamTurnsResult): string {
  const lines = [`Group ${result.group} · ${result.turns.length} turn${result.turns.length === 1 ? "" : "s"} over ${result.duration} s`];
  for (const turn of result.turns) lines.push(`  ${turn.start}–${turn.end} s  ${turn.angle}  ${turn.name}`);
  for (const { angle, speaker, transcript } of result.speakers) lines.push(`  ${angle}: turns from speaker ${speaker} of ${transcript}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function formatMulticamDirect(result: MulticamDirectResult): string {
  const rules = result.rulesFile ? `${result.template} + ${result.rulesFile}` : result.template;
  const kept = result.kept.length > 0 ? ` · kept ${result.kept.length} shot${result.kept.length === 1 ? "" : "s"} a person chose` : "";
  const lines = [`Directed group ${result.group} on ${result.track} (${rules}): ${result.shots} shot${result.shots === 1 ? "" : "s"}${kept}`];
  if (result.low.length > 0) lines.push(`Low confidence (${result.low.length}), worth a look:`);
  for (const shot of result.low) {
    lines.push(`  ${shot.clip}  ${shot.start}–${shot.end} s  ${shot.shot} ${shot.angles.join(",")}  ${Math.round(shot.confidence * 100)}%  ${shot.reason}`);
  }
  return `${lines.join("\n")}\n${formatOperation(result)}`;
}

function formatClipReframe(result: ClipReframeResult): string {
  const follows = { face: `face in ${result.faces} of ${result.samples} frames`, person: `person's face in ${result.faces} of ${result.samples} frames`, anchor: "fixed anchor" }[result.follows];
  const lines = [`Reframe ${result.clip} for ${result.format}: ${follows}`];
  if (result.placement) {
    const { scale, x, y } = result.placement;
    const moves = result.keys > 0 ? `${result.keys} keys on x/y` : "static, no keys";
    lines.push(`  scale ${scale} · x ${x} · y ${y} at the start · ${moves}`);
  }
  lines.push(result.tx ? `revision ${result.revision} · tx ${result.tx}` : `Nothing written · revision ${result.revision}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function formatTrackDuck(result: TrackDuckResult): string {
  const heard = `${result.stretches} stretch${result.stretches === 1 ? "" : "es"} of speech (${result.speechSeconds} s) on ${result.under.join(", ")}`;
  const written = result.changes.updated.length;
  const level = result.level
    ? `Level: voice ${result.level.voice} LUFS, music set to ${result.level.target} LUFS (${result.level.under} dB under): ${result.level.clips.map((c) => `${c.clip} ${c.gain > 0 ? "+" : ""}${c.gain} dB`).join(", ")}\n`
    : "";
  return `Ducked ${result.track} under ${heard}: ${written} clip${written === 1 ? "" : "s"} changed\n${level}${formatOperation(result)}`;
}

function formatMulticamFaces(result: MulticamFacesResult): string {
  const lines = [`Faces in group ${result.group}:`];
  for (const angle of result.angles) {
    const keys = angle.keys > 0 ? `${angle.keys} key${angle.keys === 1 ? "" : "s"} (op ${angle.operation})` : "no keys";
    lines.push(`  ${angle.angle}  ${angle.name}  face in ${angle.faces} of ${angle.samples} frames  ${keys}`);
  }
  if (result.kept.length > 0) lines.push(`Kept the keys of ${result.kept.join(", ")} (--replace redoes them)`);
  lines.push(result.tx ? `revision ${result.revision} · tx ${result.tx}` : `Nothing written · revision ${result.revision}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function formatMulticamCreate(result: MulticamCreateResult): string {
  const lines = [`Multicam group ${result.group} · program track ${result.track} · shot ${result.clip} (grid, whole length)`];
  for (const angle of result.sync) {
    const against = angle.against === null ? "" : ` with ${angle.against}`;
    const match = angle.confidence === null ? "reference" : `confidence ${Math.round(angle.confidence * 100)}%${angle.synced ? against : " (not synced)"}`;
    lines.push(`  ${angle.kind === "mic" ? "mic " : ""}${angle.angle}  ${angle.name}  ${angle.asset}  offset ${angle.offset} s  ${match}`);
  }
  return `${lines.join("\n")}\n${formatOperation(result)}`;
}

function formatMulticamGallery(result: MulticamGalleryResult): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const counted = `${result.tiles.length} tiles from ${result.samples} frames, confidence ${percent(result.confidence)}`;
  const lines = [
    result.clip === null
      ? `Added to multicam group ${result.group}: ${counted}`
      : `Multicam group ${result.group} · program track ${result.track} · shot ${result.clip} (grid, whole length) · ${counted}`,
  ];
  for (const tile of result.tiles) {
    const crop = (["left", "top", "right", "bottom"] as const).map((side) => `${side} ${tile.crop[side] ?? 0}`).join(" ");
    lines.push(`  ${tile.angle}  ${tile.name}  crop ${crop}  confidence ${percent(tile.confidence)}`);
  }
  if (result.layouts.length > 1) {
    lines.push("Layouts:");
    for (const layout of result.layouts) {
      lines.push(`  ${layout.start}–${layout.end} s  ${layout.tiles === 0 ? "no tile grid" : `${layout.tiles} tiles`}${layout.used ? "  (used)" : ""}`);
    }
  }
  if (result.mic) lines.push(result.clip === null ? `Sound: mic ${result.mic}` : `Sound: mic ${result.mic} (the recording's own track, once for every tile)`);
  return `${lines.join("\n")}\n${formatOperation(result)}`;
}

function formatHistory(result: HistoryResult): string {
  const since = result.since ? ` since ${result.since}` : "";
  if (result.transactions.length === 0) return `No operations on timeline ${result.timeline}${since}.\n`;
  const lines = [`Timeline ${result.timeline}${since} · revision ${result.revision}:`];
  for (const tx of result.transactions) {
    const label = tx.label ? ` "${tx.label}"` : "";
    const count = `${tx.operations.length} op${tx.operations.length === 1 ? "" : "s"}`;
    lines.push(`${tx.tx}  ${tx.author}${label}  ${count}  ${tx.at}`);
    for (const op of tx.operations) {
      const target = op.op === "revert" ? ` ${String(op.args["target"])}` : "";
      const touched = op.touched.length > 0 ? `  ${op.touched.join(", ")}` : "";
      // A config operation changes no timeline (ADR 0036): it says which file instead of a revision.
      const doc = op.doc === "style" ? "style.json" : "project config";
      lines.push(`  ${op.id}  ${op.op}${target}${touched}  (${op.doc ? doc : `revision ${op.revision}`})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A config `revert` of `revert`/`tx.abort` (ADR 0036). */
function formatConfigRevert(op: ConfigOperation): string {
  return `  project config: op ${op.id} · ${op.touched.join(", ") || "no change"}`;
}

function formatOperation(result: OperationResult): string {
  const { added, updated, removed, range } = result.changes;
  const parts = [
    ...(added.length > 0 ? [`added ${added.join(", ")}`] : []),
    ...(updated.length > 0 ? [`updated ${updated.join(", ")}`] : []),
    ...(removed.length > 0 ? [`removed ${removed.join(", ")}`] : []),
    ...(range ? [`${range.from}–${range.to ?? "?"} s`] : []),
  ];
  const snaps = result.snaps.map(
    (snap) =>
      `snapped ${snap.field}${snap.clip ? ` of ${snap.clip}` : ""} ${snap.requested} -> ${snap.applied} ` +
      (snap.clean ? "(in a pause)" : `(no pause within ±${snap.window} s: quietest frame, speech may be clipped)`),
  );
  const warnings = result.warnings.map((warning) => `warning: ${warning}`);
  return [
    `${result.operation.op}: ${parts.join(" · ") || "no change"}`,
    ...snaps,
    `revision ${result.revision} · op ${result.operation.id} · tx ${result.operation.tx}`,
    ...warnings,
    "",
  ].join("\n");
}

function formatTracks(result: { timeline: string; revision: number; tracks: TrackSummary[]; problems: TimelineProblem[] }): string {
  if (result.tracks.length === 0) {
    return `Timeline ${result.timeline} (revision ${result.revision}) has no tracks. Add one: \`frameshell track add video\`.\n`;
  }
  const lines = [`Timeline ${result.timeline} · revision ${result.revision} · bottom to top:`];
  for (const track of result.tracks) {
    const name = track.name ? ` "${track.name}"` : "";
    const ends = track.end === null ? "end unknown" : `ends ${track.end} s`;
    const detail = track.kind === "subtitles" ? `follows ${track.follows}, ${styleText(track.style)}` : `${track.clips} clip(s), ${ends}`;
    lines.push(`  ${track.id}  ${track.kind}${name}  ${detail}${trackState(track)}`);
  }
  return `${[...lines, ...formatProblems(result.problems)].join("\n")}\n`;
}

function formatTempo(result: MethodResult<"tempo.show">): string {
  const head = `Timeline ${result.timeline} · revision ${result.revision}`;
  if (!result.tempo) return `${head} has no tempo. Set one: \`frameshell tempo set --clip <music clip>\` (measured) or \`frameshell tempo set --bpm 120\` (nominal).\n`;
  const stored = Object.entries(result.tempo).map(([key, value]) => `${key} ${value}`).join(", ");
  const lines = [`${head} · tempo: ${stored}`];
  const { grid } = result;
  if (!grid) {
    lines.push(`  no grid: ${result.problem ?? "nothing to show"}`);
    return `${lines.join("\n")}\n`;
  }
  const facts = [`${grid.bpm} BPM`, `bars of ${grid.meter}`, `${grid.beats.length} beats`, grid.source === "beats" ? `measured from ${grid.asset} (confidence ${grid.confidence?.toFixed(2)}${grid.low ? " LOW" : ""})` : "nominal"];
  lines.push(`  ${facts.join(", ")}`);
  const list = (times: number[]) => (times.length > 12 ? `${times.slice(0, 12).join(" ")} … (${times.length} in all)` : times.join(" "));
  lines.push(`  bar starts: ${list(grid.bars)}`, `  beats: ${list(grid.beats)}`);
  if (grid.low) lines.push("  LOW confidence: --snap-to is refused until the grid is corrected (edits.tempo, edits.downbeat in the beats file) or measured again with --bpm.");
  return `${lines.join("\n")}\n`;
}

function formatMarkers(result: MarkerListResult): string {
  if (result.markers.length === 0) {
    return `Timeline ${result.timeline} (revision ${result.revision}) has no markers. Add one: \`frameshell marker add --at 12.5 --label hook\`.\n`;
  }
  const lines = [`Timeline ${result.timeline} · revision ${result.revision} · ${result.markers.length} marker${result.markers.length === 1 ? "" : "s"}:`];
  for (const marker of result.markers) lines.push(`  ${marker.id}  ${marker.at} s  ${marker.label}${marker.color ? `  (${marker.color})` : ""}`);
  return `${lines.join("\n")}\n`;
}

/** `  muted`, `  hidden`, `  behind <plate>` or several, as a track line ends; empty for a plain track. */
function trackState(track: { muted?: true | undefined; hidden?: true | undefined; behind?: string | undefined }): string {
  return `${track.muted ? "  muted" : ""}${track.hidden ? "  hidden" : ""}${track.behind ? `  behind ${track.behind}` : ""}`;
}

/** A subtitle track's look as rendered, e.g. `big-keyword at the bottom`; an unknown preset is named. */
function styleText(stored: TrackSummary["style"]): string {
  const { style, unknownPreset } = resolveSubtitleStyle(stored ?? undefined);
  const preset = unknownPreset ? `${style.preset} (unknown preset "${unknownPreset}")` : style.preset;
  return `${preset} ${style.position === "center" ? "in the center" : `at the ${style.position}`}`;
}

/** Clips whose nested timeline is unavailable, with the fix; nothing when none. */
function formatProblems(problems: TimelineProblem[]): string[] {
  if (problems.length === 0) return [];
  return [`Problems (${problems.length}):`, ...problems.map((problem) => `  ${problem.message}`)];
}

function formatTimeline(view: TimelineView): string {
  const duration = view.duration === null ? "duration unknown" : `${view.duration} s`;
  const lines = [`Timeline ${view.timeline} · revision ${view.revision} · ${view.fps} fps · ${duration}`];
  if (view.tracks.length === 0) lines.push("  (no tracks: `frameshell track add video`)");
  for (const track of view.tracks) {
    const name = track.name ? ` "${track.name}"` : "";
    lines.push(`${track.id}  ${track.kind}${name}${track.follows ? `  follows ${track.follows}` : ""}${trackState(track)}`);
    for (const clip of track.clips) {
      const c = clip as Record<string, unknown> & { id: string; type: string; start: number; end: number | null };
      const what = typeof c["asset"] === "string" ? c["asset"] : typeof c["source"] === "string" ? c["source"] : "";
      const source =
        c["in"] !== undefined || c["out"] !== undefined
          ? `  in ${String(c["in"] ?? 0)}${c["out"] !== undefined ? ` out ${String(c["out"])}` : ""}`
          : "";
      const speed = c["speed"] !== undefined ? `  ×${String(c["speed"])}` : "";
      lines.push(`  ${c.id}  ${c.type} ${what}  ${c.start}–${c.end ?? "?"}${source}${speed}`);
    }
  }
  if (view.markers) lines.push(`Markers: ${view.markers.map((marker) => `${marker.id} ${marker.at} "${marker.label}"`).join(", ")}`);
  if (view.tempo) lines.push(`Tempo: ${Object.entries(view.tempo).map(([key, value]) => `${key} ${value}`).join(", ")} (grid: \`frameshell tempo show\`)`);
  return `${[...lines, ...formatProblems(view.problems)].join("\n")}\n`;
}
