import { ErrorCode, type RequirementsChange, RpcError } from "@frameshell/protocol";
import { CLIP_REQUIREMENT_FIELDS, type CraftCheck, REQUIREMENTS_FILE, REQUIREMENT_PATHS } from "@frameshell/schema";
import type { ConfigChanger, ConfigEdit, ConfigJournal } from "../config/journal.js";
import { type ConfigState, PLAIN_RULES, diffConfig } from "../config/patch.js";
import type { TxRef } from "../timeline/service.js";
import { REQUIREMENTS_KEY, checkedRequirementsState, clipRequirementKey, waiverKey } from "./requirements-doc.js";

/** What {@link RequirementsService} needs. */
export interface RequirementsServiceOptions {
  /** Journal with the `requirements` document (`requirementsConfigDocument`): one change at a time per project. */
  journal: ConfigJournal;
  /** Applies a change, or holds it in review mode (`TimelineService.changeConfig`). */
  change: ConfigChanger;
}

/**
 * `review.require` and `review.waive` (#457): `requirements.json` changed only through the config journal
 * (ADR 0036), in the caller's transaction, held by review mode like a timeline change.
 */
export class RequirementsService {
  readonly #options: RequirementsServiceOptions;

  constructor(options: RequirementsServiceOptions) {
    this.#options = options;
  }

  /** Set the expectation at `path` (of `clip` when given); null removes it. */
  require(root: string, request: { path: string; clip?: string | undefined; value: unknown }, author: string, tx: TxRef): Promise<RequirementsChange> {
    const { path, clip, value } = request;
    const paths: readonly string[] = clip === undefined ? REQUIREMENT_PATHS : CLIP_REQUIREMENT_FIELDS;
    if (!paths.includes(path)) {
      const what = clip === undefined ? "the film" : `clip ${clip}`;
      throw new RpcError(ErrorCode.InvalidOperation, `No requirement "${path}" of ${what}. Paths: ${paths.join(", ")}${clip === undefined ? "; per clip (with `clip`): " + CLIP_REQUIREMENT_FIELDS.join(", ") : ""}.`, {
        op: "review.require",
        reason: "path",
        field: "path",
        paths: [...paths],
      });
    }
    if (value === undefined) {
      throw new RpcError(ErrorCode.InvalidOperation, "review.require needs a `value`; null removes the requirement.", { op: "review.require", reason: "value", field: "value" });
    }
    const key = REQUIREMENTS_KEY + (clip === undefined ? path : clipRequirementKey(clip, path));
    return this.#change(root, { author, tx }, (base) => ({
      op: "review.require",
      args: { path, ...(clip === undefined ? {} : { clip }), value },
      undo: { method: "review.require", params: { path, ...(clip === undefined ? {} : { clip }), value: base[key] ?? null } },
      after: checkedRequirementsState(PLAIN_RULES.apply(base, [{ key, value }]), "review.require"),
    }));
  }

  /** Waive the craft warnings of `check` (overlapping `clip` when given) with `reason`; null removes the waiver. */
  waive(root: string, request: { check: CraftCheck; clip?: string | undefined; reason: string | null }, author: string, tx: TxRef): Promise<RequirementsChange> {
    const { check, clip, reason } = request;
    const key = REQUIREMENTS_KEY + waiverKey(check, clip);
    return this.#change(root, { author, tx }, (base) => ({
      op: "review.waive",
      args: { check, ...(clip === undefined ? {} : { clip }), reason },
      undo: { method: "review.waive", params: { check, ...(clip === undefined ? {} : { clip }), reason: base[key] ?? null } },
      after: checkedRequirementsState(PLAIN_RULES.apply(base, [{ key, value: reason }]), "review.waive"),
    }));
  }

  /** Run `edit` on the state the change applies to (the open proposal's in review mode) and journal or propose it. */
  #change(root: string, who: { author: string; tx: TxRef }, edit: (base: ConfigState) => ConfigEdit): Promise<RequirementsChange> {
    return this.#options.journal.serial(root, async () => {
      let base: ConfigState = {};
      let after: ConfigState = {};
      const changed = await this.#options.change(root, "requirements", who, async (state) => {
        const made = edit(state);
        [base, after] = [state, made.after];
        return made;
      });
      const changes = diffConfig(base, after).map(({ key, before, after: value }) => ({ key: key.slice(REQUIREMENTS_KEY.length), before, after: value }));
      return { dir: root, path: REQUIREMENTS_FILE, changes, op: changed.operation.id, tx: changed.operation.tx, proposal: changed.proposal };
    });
  }
}
