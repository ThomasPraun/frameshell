# People acceptance run: results and chosen thresholds

Template for the owner's run of `docs/acceptance/people.md` on real recordings (#374, ADR 0020 decision 15). Fill it in after the run; keep scores and constants only. Recordings, transcripts, face crops and `people.json` never go in the repo.

The thresholds are tuned here and nowhere else: this file is the evidence, a later small PR changes the constants and updates ADR 0020 decision 15 with the values below.

## How to get the numbers

1. Run the acceptance steps. Confirm every person the panel suggests, and link a face of each person in every video (`people link <person> --face <asset>@<seconds>`): face anchors are the labels the face sweeps are scored against.
2. `frameshell people suggest` once, so the voice prints of the linked speakers are cached (they are never made by the next command).
3. `frameshell people tune` prints the tables; `frameshell people tune --json` has every score and the timings to paste below.

`people tune` only reads: it scans, downloads and changes nothing. Voices are matched leave-one-out (each linked speaker against every person's voice made of their other prints; a person with a single print has nothing to match, so any suggestion for that speaker counts as wrong). Faces are labelled only by face anchors: link more anchors for a sharper cluster sweep.

## Run

| Field | Value |
|---|---|
| Date | |
| Frameshell version | |
| Machine (OS, CPU, RAM) | |
| Material (videos, minutes each, mics, people) | |
| Linked speakers with a print / people | |
| Anchored face tracks / people | |

## Timings

| Step | Time |
|---|---|
| `people scan` per hour of footage | |
| Voice prints per transcript (first `people suggest`) | |
| `people tune`: reading voice prints (`timings.voicesMs`) | |
| `people tune`: reading and clustering faces (`timings.facesMs`) | |
| `people tune`: sweeps (`timings.sweepMs`) | |

## Voices

Constants now: `SPEAKER_MATCH` 0.7, `SPEAKER_MARGIN` 0.1 (`packages/core/src/people/suggest.ts`).

| Score spread (cosine) | n | min | p10 | median | p90 | max |
|---|---|---|---|---|---|---|
| Same person | | | | | | |
| Different people | | | | | | |
| Own person minus best other (`margin`) | | | | | | |

Gap (lowest same minus highest different): 

| `SPEAKER_MATCH` | `SPEAKER_MARGIN` | Suggested | Correct | Wrong | Precision | Recall |
|---|---|---|---|---|---|---|
| | | | | | | |

Wrong suggestions at the current constants (what and why; no names of real people needed):

## Faces

Constants now: `FACE_CLUSTER_MATCH` 0.45 (`face-clusters.ts`), `FACE_PERSON_MATCH` 0.4, `FACE_PERSON_MARGIN` 0.1 (`face-suggest.ts`).

| Score spread (cosine of track prints) | n | min | p10 | median | p90 | max |
|---|---|---|---|---|---|---|
| Same person | | | | | | |
| Different people | | | | | | |

| `FACE_CLUSTER_MATCH` | Clusters | Purity | Mixed | Splits |
|---|---|---|---|---|
| | | | | |

| `FACE_PERSON_MATCH` | `FACE_PERSON_MARGIN` | Suggested | Correct | Wrong | Precision | Recall |
|---|---|---|---|---|---|---|
| | | | | | | |

Wrong suggestions at the current constants:

## Chosen constants

| Constant | Now | Chosen | Why (the rows above it rests on) |
|---|---|---|---|
| `SPEAKER_MATCH` | 0.7 | | |
| `SPEAKER_MARGIN` | 0.1 | | |
| `FACE_CLUSTER_MATCH` | 0.45 | | |
| `FACE_PERSON_MATCH` | 0.4 | | |
| `FACE_PERSON_MARGIN` | 0.1 | | |

Not run or not enough material for: 

## Frictions

Each friction noted during the run, with its issue number.
