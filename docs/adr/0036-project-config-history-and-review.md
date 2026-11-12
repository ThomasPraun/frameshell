---
status: accepted
---

# Project config changes in history and review mode: one config journal of keyed operations

#496 (follow-up of #469 / PR #495, owner decision 14 on #469; epic #451) asks that changes of project config (`formats` of `frameshell.json` today, `style.json` with `style set` next, #468 S3) behave like timeline changes: listed by `history`, undone by `revert` and `tx abort`, and held by review mode. The owner chose option A on 2026-11-11, with every recommendation of the draft (the eight points below, from the ticket's decision comment). Slice 1 implements the journal, history and revert for formats; review mode for config is slice 2.

## Context

- `FormatService` (`packages/core/src/formats.ts`) journaled each format edit in `.frameshell/history/project.config.jsonl` as `{ id, op, args, author, at, before, after, undo }`: the whole list before and after and the call that undoes it, with no transaction and no hash chain.
- Stopgaps of ADR 0027 decision 11: `revert` of a format change's op id was refused (InvalidOperation, reason `format change`) naming its `undo` call, and while review mode is on `format.add`/`format.remove` from anyone but `ui` are refused with ProposalState `forbidden`.
- Timeline history (SPEC §6.2) is one journal per timeline with a `timeline.patch` inverse and a hash chain of the timeline; `planRevert` (`history/revert.ts`) is pure over `TimelinePatch` with entity keys `group:`, `track:`, `clip:`, `marker:`, `order`. `TransactionTracker` records `{ root, timeline }` per open transaction for `tx abort`.
- Review mode (ADR 0019) holds timeline parts and new timeline files only. `file.write` validates `frameshell.json` and `style.json` but neither journals them nor routes them through review.
- Nothing in the app shows a format or style visually yet (no preview format switcher, ADR 0027 slice 2), so a config change has no visual After.

## Decision

1. **Journal.** Project-config changes stay in their own journal, `.frameshell/history/project.config.jsonl`, separate from the timeline journals. Entries gain `doc`, `patch: [{ key, before, after }]`, `tx`, `txLabel`, `hashBefore`/`hash` of the document section and `proposal`.
2. **Keyed operations, not snapshots.** Keys `format:<id>` (entry plus list position; the primary format is never a key) and `style:<dotted leaf path>`. A pure `planConfigRevert` mirrors `planRevert`: a later foreign op on the same key conflicts, a hash gap means an edit outside the journal.
3. **One transaction = one proposal.** A proposal gains a `config` part next to `parts` and `files`. A transaction mixing clip ops and a format or style change is one proposal, accepted or rejected whole. Rebase replays when the person's config changes since base touch none of the proposal's keys; otherwise stale with those keys as `conflicts`.
4. **Before/After.** A text list in the proposal bar ("+ 9x16 (1080x1920)", "colors.accent A → B"), plus `view: proposal` on `format.list`, `style.show` and `frame --format`. The visual After arrives with the format switcher and style consumers.
5. **`file.write` of `frameshell.json`/`style.json`.** A later slice diffs it into keyed config ops, journaled and routed through review (as ADR 0019 §9 does for timelines). Until then, in review mode a non-`ui` author is refused with a hint to use `style set` / `format add`.
6. **Style key granularity.** Leaf paths; string arrays (`notes`, `rules`, `banned`) are one key each.
7. **History panel.** Config transactions show in every timeline's History, with a config mark, because a format change affects every timeline's export.
8. **Old journal lines** are not migrated on disk: they are read as patches of `format:<id>` keys, each its own transaction.

`style set` (#468 S3, ADR 0028 decision 6) is built on this journal only (`ConfigJournal`); brand capture (#467) reuses it.

## Considered options

- **B. Whole-document snapshots in proposals and journal.** Rejected: any change by the person to the same file makes an agent's proposal stale (the rule ADR 0019 rejected for timelines), and revert of an older change becomes impossible after any later change to the file.
- **C. Config operations in the timeline journal** (main timeline or a pseudo-timeline). Rejected: timeline entries carry a timeline hash chain and a `timeline.patch` inverse config cannot fill, and every timeline consumer would have to skip config entries.
- **D. Replay the stored undo calls.** Rejected: each config service would carry its own conflict and rebase rules, and a replay on a changed base can succeed with another effect than proposed.

## Consequences

- **Code (slice 1):** `packages/core/src/config/`: `patch.ts` (keyed diff and apply, `ConfigRules`), `project-doc.ts` (the `project` document: `formatState`, `FORMAT_RULES`), `revert.ts` (`planConfigRevert`), `journal.ts` (`CONFIG_JOURNAL`, `readConfigJournal` with the legacy reader, `ConfigJournal`: one queue per project, `commit`, `planRevert`, `commitRevert`). `FormatService` writes only through `ConfigJournal.commit`; the hash is `contentHash` of the keyed state (`history/hash.ts`, shared with `timelineHash`).
- **Format keys:** the value of `format:<id>` is `{ id, width, height, index }`. A format that only moved because another was added or removed before it did not change (`FORMAT_RULES.same` compares id and size), so adding `9x16` never conflicts with the person adding `1x1`. Writing a key inserts the format at its `index` (clamped) and renumbers, so reverting a removal puts it back where it was.
- **Legacy lines** (`before`/`after` lists, no `patch`): read as a diff of their lists with transaction id `tx_<hex of the op id>`, hashes computed from the lists.
- **History:** `history` merges config operations into a timeline's listing by time, grouped under their transaction, each with `doc: "project"`, its keys as `touched`, and `revisionBefore` = `revision` = the timeline's revision at the time. `since` finds transactions in either journal. `history.diff` of a config-only target returns no clips.
- **Revert:** `revert <tx|op>` undoes config operations of the target, and its operations on the named timeline when that journal holds some, in one standalone transaction. Config is planned first (conflicts and hash gaps refuse before anything is written), then the timeline is reverted, then config is written. A config-only revert returns the config `revert` as `operation` with an empty `timeline.patch` inverse and an unchanged `revision`; the result's `config` lists the config `revert` operations.
- **Transactions:** `TransactionTracker.touched` holds `{ root, timeline }` or `{ root, doc }` (persisted open transactions of an older daemon still parse). `tx abort` plans config reverts before the timelines and writes them after, all or nothing; its result gains `config`.
- **Kept stopgap (until slice 2):** while review mode is on, `format.add`, `format.remove`, `revert` of a target holding config, and `tx abort` of a transaction that changed config are refused for anyone but `ui` with ProposalState `forbidden`.
- **Wire** (`PROTOCOL_VERSION` 86): `format.add`/`format.remove` results gain `tx`; `history` operations gain `doc`; `revert` and `tx.abort` results gain `config`; `revert` no longer throws reason `format change`. New protocol schemas `ConfigJournalEntrySchema`, `ConfigOperationSchema`.
- **App:** History rows of a transaction that changed config carry a `project` mark; `format.add`/`format.remove` have verbs; the list reloads after a revert from the panel, since a config-only revert keeps the timeline revision. It does not yet reload when someone else changes only config.
- **Not migrated:** old journal lines stay as written.
- **Still uncovered:** other `frameshell.json` keys (plugins, export, transcription), `people.json`, `director.json`, compositions and assets, until they register as config documents.

## Implementation plan (each slice ships and is tested alone)

1. Config journal + revert for formats: keyed patch, journal with legacy reader, pure revert with conflict and hash-gap checks; `FormatService` through it in the caller's transaction; `history`, `revert <tx|op>`, `tx abort`; wire bump; CLI `history` rows; History panel mark. (This slice.)
2. Review mode for formats: proposal `config` part, `#route`/`#propose` for `format.add`/`remove`, rebase/stale by keys then schema check, accept/reject writing journal + `frameshell.json`; `view` on `format.list` and `frame --format`; `proposal.diff`/`proposal.changed` carry config; the review-mode refusal goes; skill note.
3. App: proposal bar text list of config changes (i18n en + es); live History reload on config-only changes; e2e of an agent's format proposal accepted and reverted from History.
4. `style set` (#468 S3) on the same journal: `style` document (leaf keys, `StyleFileSchema`), `style.set`, CLI, MCP, skill; `view` on `style.show`.
5. Direct edits: `file.write` and on-disk edits of `frameshell.json` `formats` and `style.json` diffed into keyed config ops, journaled and routed through review; until then refused for non-`ui` authors while review is on.
