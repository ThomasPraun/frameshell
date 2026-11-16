import { z } from "zod";
import { ANALYSIS_NAME_PATTERN } from "../analyze.js";
import { ViewedShape } from "../proposals.js";
import { ResolvedStyleSchema, SafeZoneSchema, UserStyleIdSchema } from "@frameshell/schema";
import { type MethodSpec, CwdParam, ViewParam, StyleChangeSchema } from "./shared.js";

/** Daemon methods: project styles. */
export const styleMethods = {
  "style.show": {
    description:
      "The project's style guide (ADR 0028): `style.json` at the project root, with measurable values for every " +
      "visual and sound decision: `brand` (product, hook, CTA, audience; `?` = ask the person), `colors` (hex), " +
      "`fonts` (family, file under `assets/fonts/`, weight, tracking in em), `type` (px on a frame whose short side " +
      "is 1080), `motion` (seconds; `personality` playful, premium, corporate, energetic or calm, then the file's " +
      "overrides), `sound` (dB under the voice, ducking, voice-chain defaults; the loudness target stays " +
      "`export.loudness`), `platforms`, `notes`, `rules`, `banned`. Every value is `{ value, source }`: `file` " +
      "(written in style.json), `personality` (from its motion personality) or `default` (Frameshell's; null = not " +
      "decided, ask the person). `safeZones`: for each platform named, the pixels of a reference frame its app " +
      "covers (`measured: false` = from editing guides). `style` is null when the project has no style.json: none " +
      "is required. `from.status` says whether the user style it was copied from changed since (`style.apply` it " +
      "again to take the change). While a review-mode proposal changes the style (ADR 0036), `view: \"proposal\"` " +
      "shows its version. Read-only; nothing renders from it yet. Fails with InvalidProjectFile when the file is invalid.",
    params: z.strictObject({ cwd: CwdParam, view: ViewParam }),
    result: z.object({
      ...ViewedShape,
      dir: z.string().describe("Project root."),
      path: z.string().describe("The style file, project-relative: `style.json`."),
      style: ResolvedStyleSchema.nullable().describe("Every value with its source; null when there is no style.json."),
      from: z
        .object({
          id: z.string(),
          sha256: z.string(),
          status: z
            .enum(["same", "changed", "missing"])
            .describe("`same`: the user style still holds what was copied. `changed`: edited since. `missing`: no user style with that id on this machine."),
        })
        .nullable()
        .describe("User style the file was copied from (id, SHA-256 at copy time); null when none."),
      safeZones: z.array(SafeZoneSchema).describe("Safe zone of each platform in `platforms`, in that order; empty when none."),
    }),
  },
  "style.set": {
    mutating: true,
    description:
      "Set one value of the project's style guide (`style.json`, ADR 0028) by its dotted path, e.g. " +
      "`{ path: \"colors.accent\", value: \"#ff5500\" }`, `{ path: \"motion.personality\", value: \"premium\" }`, " +
      "`{ path: \"type.hero\", value: 220 }`, `{ path: \"banned\", value: [\"emoji in captions\"] }`. A path names one " +
      "value: a colour, a number, a font object (`fonts.display`: `{ family, file?, weight?, tracking? }`), an ease (4 " +
      "numbers) or a whole list; `style.show` lists every path. `value: null` removes it from the file, so the " +
      "personality's or the default value applies again. Units as `style.show` describes them (seconds, not ms). " +
      "Creates `style.json` when missing; the rest of the file is kept. Journaled in " +
      "`.frameshell/history/project.config.jsonl` in the caller's transaction (ADR 0036): `history` lists it, `revert` " +
      "with its `op` or `tx` undoes it. While review mode is on (ADR 0019), a change by anyone but the person in the app " +
      "waits in the transaction's proposal (`proposal` in the result). Change the style only with the person's agreement. " +
      "Fails with InvalidOperation (`reason`: `path` unknown, `value` invalid, with the schema's message), " +
      "InvalidProjectFile (the file on disk is invalid), ProposalPending, ProposalState, ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      path: z.string().min(1).describe("Dotted path of one style value, e.g. `colors.accent`, `motion.duration.quick`, `sound.duck.depth`."),
      value: z.unknown().describe("New value as JSON (string, number, boolean, list, font object); null removes it from the file."),
    }),
    result: StyleChangeSchema,
  },
  "style.apply": {
    mutating: true,
    description:
      "Copy a user style (a library in Frameshell's config folder, `style.list`) or a motion personality (`playful`, " +
      "`premium`, `corporate`, `energetic`, `calm`) into the project's `style.json` (ADR 0028 decision 10). By default " +
      "it merges value by value: every value the user style sets replaces the project's, the others stay. " +
      "`replace: true` makes the file exactly the user style. A user style also records `from` (its id and SHA-256), " +
      "so `style.show` can say when it changed later; nothing is inherited afterwards. A personality sets only " +
      "`motion.personality` (with `replace`, it is all the file keeps). " +
      "With `analysis` instead of `name`, it applies the `suggestions` of that `analyze` run (read from " +
      "`.frameshell/analysis/<analysis>/analysis.json`), all of them or only the `paths` given: apply only what the " +
      "person agreed to after seeing them; `from` is not recorded. `changes` reports every value that changed. " +
      "Journaled and held by review mode like `style.set`; `revert` with its `op` undoes it. Fails with InvalidParams " +
      "(both or neither of `name` and `analysis`; `replace` or `paths` with the wrong one), InvalidOperation " +
      "(`reason` `not found`, with the user styles or analyses available in `data.available`; `no suggestions`: an analysis " +
      "older than its suggestions, run `analyze` again; `not suggested`: a path of `paths` the analysis does not suggest; " +
      "`value`: a suggestion no longer fits the schema), InvalidGlobalConfig (the user style is invalid), InvalidProjectFile, " +
      "ProposalPending, ProposalState, ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      name: UserStyleIdSchema.optional().describe("User style id (`style.list`) or a motion personality id. Give this or `analysis`."),
      replace: z.boolean().optional().describe("Overwrite the project's style with it instead of merging value by value. Default false. Not with `analysis`."),
      analysis: z
        .string()
        .regex(ANALYSIS_NAME_PATTERN, "letters, digits, `.`, `_` and `-`, at most 64, starting with a letter or digit")
        .optional()
        .describe("Name of an `analyze` run whose `suggestions` to apply (its folder `.frameshell/analysis/<analysis>/`). Give this or `name`."),
      paths: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("With `analysis`: apply only these suggested paths, e.g. `[\"colors.accent\", \"motion.personality\"]`. Default: every suggestion."),
    }),
    result: StyleChangeSchema,
  },
  "style.save": {
    mutating: true,
    description:
      "Save the project's `style.json` as user style `name` in Frameshell's config folder (`styles/<name>.json`), so " +
      "other projects can `style.apply` it. The file is copied as it is, without `from`. Not a project change: not " +
      "journaled, not held by review mode. An existing user style of that name is kept unless `force: true`. Fails " +
      "with InvalidOperation (`reason` `no style`: the project has no style.json; `exists`; `personality`: the name is a " +
      "motion personality's), InvalidProjectFile, ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      name: UserStyleIdSchema,
      force: z.boolean().optional().describe("Overwrite a user style of the same name. Default false."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      id: z.string().describe("User style id."),
      path: z.string().describe("Absolute path of the user style file."),
      sha256: z.string().describe("SHA-256 of the user style file as written."),
      replaced: z.boolean().describe("True when it overwrote a user style of the same name."),
    }),
  },
  "style.list": {
    description:
      "The user styles saved on this machine (`style.save`; files `styles/<id>.json` in Frameshell's config folder) " +
      "and the motion personalities, both names `style.apply` takes. A user style that fails validation is listed " +
      "with `error` and cannot be applied until fixed.",
    params: z.strictObject({}),
    result: z.object({
      dir: z.string().describe("Absolute folder of the user styles."),
      styles: z
        .array(
          z.object({
            id: z.string(),
            sha256: z.string().describe("SHA-256 of the file."),
            personality: z.string().nullable().describe("Motion personality it picks; null when none."),
            error: z.string().nullable().describe("Why it is invalid; null when it is valid."),
          }),
        )
        .describe("Sorted by id."),
      personalities: z.array(z.string()).describe("Motion personality ids."),
    }),
  },
} as const satisfies Record<string, MethodSpec>;
