---
status: accepted
---

# Projects created from a video

Adds a way in to SPEC §3.2 and §10; the project layout of §5.1 does not change. Frameshell's target user includes creators who never used a terminal (grilling 2026-10-16). They have a video file, not a project folder. Before this, the welcome screen offered only **Open folder…**, and a folder without `frameshell.json` got "Create a project here". The user had to know what a project folder is before the app was of any use.

## Context (verified in the tree)

- `project.init` scaffolds a project in a given directory, creating it if missing, and fails with `ProjectExists` on a folder that already holds `frameshell.json`.
- `asset.import` copies into `assets/` with `copyFile(…, COPYFILE_FICLONE)`: a copy-on-write clone on APFS, Btrfs, XFS and ReFS (instant, no extra space), a plain copy elsewhere. `mode: "link"` hard-links instead, or symlinks across volumes, so the source must stay.
- The welcome screen (`renderer/src/components/Welcome.tsx`) talks to main through `window.frameshell.project`.

## Decision

1. **Where.** The project folder goes beside the first video, named after it: `~/Desktop/interview.mp4` becomes `~/Desktop/interview/`. The confirmation shows the name and the place, and the user can change both.
2. **Several videos** make one project, named after the first. They are usually takes of the same video.
3. **Name clash.**
   - If the folder exists and is a Frameshell project whose `assets/` already holds a file with the first video's name and size, that project opens.
   - Otherwise the next free name is used: `interview (2)`, `interview (3)`, and so on.
4. **The original is never moved.** Import copies it, which is a clone where the volume allows one.
   - Before importing, main tests whether a clone is possible, by force-cloning the first video next to the project folder. The test file is deleted.
   - When no clone is possible and the videos total more than 2 GB, the user chooses between a copy (the size is shown) and using the files in place (`mode: "link"`, so the originals must stay).
5. **Then** the app runs `project.init` (the agent skill included), then `asset.import`, then opens the project. Ingest starts as usual. Transcription and binary prefetch belong to #188.

## Considered options

- **Move the video into `assets/`.** Rejected: the file disappears from where the user left it.
- **A central projects folder** (`~/Movies/Frameshell/`). Rejected as the default: the project is harder to find than one next to the video. It stays reachable through **Change…**.
- **Always ask copy or link.** Rejected: a clone makes the question moot on most Macs, and a question with no visible stakes confuses the target user.

## Consequences

- No protocol change: the flow composes `status`, `project.init` and `asset.import` from main.
- Drag and drop (#183) and Open with / the context menu (#184, #185) reuse the same plan and create steps.
- Follow-up #197: placing the videos on the main timeline and matching the project's resolution and frame rate to the first video. Both need ingest to finish first.
