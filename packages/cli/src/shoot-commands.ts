import type { DaemonConnection, ShootStatusResult } from "@frameshell/protocol";

/** Help text of the `shoot` commands (ADR 0023), in `frameshell --help`. */
export const SHOOT_USAGE = `  shoot status <script>        Scenes of a shoot script with their state (none, deviations, done) and chosen take,
                               every take with its deviations (missing, changed, added, moved, restart, pause,
                               speaker, length, free), the next scene to record and the cues
  shoot add <script> <asset> [--scene slug] [--recorded-at iso]
                               Link a recorded file as a take starting at a scene (default the first); it is
                               compared once the file has a transcript (\`transcribe\` it)
  shoot accept <script> <take> [<deviation>…] [--undo]
                               Let deviations pass (default: all of the take's); --undo takes it back
  shoot choose <script> <scene> <take|default>
                               Pick the take that goes into the cut for a scene; \`default\` = the newest covering it
  shoot discard <script> <take> [--restore]
                               Set a take aside (never chosen); --restore brings it back
`;

/** Flags each `shoot` command takes besides the global ones. */
export const SHOOT_FLAGS: Record<string, readonly string[]> = {
  "shoot status": [],
  "shoot add": ["scene", "recorded-at"],
  "shoot accept": ["undo"],
  "shoot choose": [],
  "shoot discard": ["restore"],
};

/** A parsed `shoot` command. */
export type ShootInvocation =
  | { kind: "shoot.status"; script: string }
  | { kind: "shoot.add"; script: string; asset: string; scene?: string; recordedAt?: string }
  | { kind: "shoot.accept"; script: string; take: string; deviations: string[]; undo: boolean }
  | { kind: "shoot.choose"; script: string; scene: string; take: string | null }
  | { kind: "shoot.discard"; script: string; take: string; restore: boolean };

/** Parse `shoot <sub> …`; null when the shape is wrong. */
export function parseShoot(
  rest: string[],
  options: { scene?: string | undefined; "recorded-at"?: string | undefined; undo?: boolean | undefined; restore?: boolean | undefined },
): ShootInvocation | null {
  const [sub, ...args] = rest;
  switch (sub) {
    case "status":
      return args.length === 1 ? { kind: "shoot.status", script: args[0]! } : null;
    case "add":
      if (args.length !== 2) return null;
      return {
        kind: "shoot.add",
        script: args[0]!,
        asset: args[1]!,
        ...(options.scene !== undefined ? { scene: options.scene } : {}),
        ...(options["recorded-at"] !== undefined ? { recordedAt: options["recorded-at"] } : {}),
      };
    case "accept":
      return args.length >= 2 ? { kind: "shoot.accept", script: args[0]!, take: args[1]!, deviations: args.slice(2), undo: options.undo === true } : null;
    case "choose":
      return args.length === 3 ? { kind: "shoot.choose", script: args[0]!, scene: args[1]!, take: args[2] === "default" ? null : args[2]! } : null;
    case "discard":
      return args.length === 2 ? { kind: "shoot.discard", script: args[0]!, take: args[1]!, restore: options.restore === true } : null;
    default:
      return null;
  }
}

/** Run a parsed `shoot` command; human output unless `json`. */
export async function executeShoot(conn: DaemonConnection, inv: ShootInvocation, cwd: string, json: boolean): Promise<string> {
  const print = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  switch (inv.kind) {
    case "shoot.status": {
      const result = await conn.request("shoot.status", { cwd, script: inv.script });
      return json ? print(result) : formatStatus(result);
    }
    case "shoot.add": {
      const { kind: _kind, ...params } = inv;
      const result = await conn.request("shoot.add", { cwd, ...params });
      if (json) return print(result);
      const { take } = result;
      const state = take.state === "analyzed" ? `${take.deviations.length} deviation${take.deviations.length === 1 ? "" : "s"}, covers ${take.scenes.join(", ") || "nothing"}` : take.problem;
      return `Added take ${take.id} (${take.asset}, from #${take.scene}) to ${result.file}\n  ${state}\n`;
    }
    case "shoot.accept": {
      const result = await conn.request("shoot.accept", {
        cwd,
        script: inv.script,
        take: inv.take,
        undo: inv.undo,
        ...(inv.deviations.length > 0 ? { deviations: inv.deviations } : {}),
      });
      if (json) return print(result);
      const count = `${result.deviations.length} deviation${result.deviations.length === 1 ? "" : "s"}`;
      return `${inv.undo ? "Unaccepted" : "Accepted"} ${count} of take ${result.take}\n`;
    }
    case "shoot.choose": {
      const result = await conn.request("shoot.choose", { cwd, script: inv.script, scene: inv.scene, take: inv.take });
      return json ? print(result) : `Scene #${result.scene}: ${result.take ?? "default (newest take)"} (was ${result.previous ?? "default"})\n`;
    }
    case "shoot.discard": {
      const result = await conn.request("shoot.discard", { cwd, script: inv.script, take: inv.take, restore: inv.restore });
      return json ? print(result) : `${result.discarded ? "Discarded" : "Restored"} take ${result.take}\n`;
    }
  }
}

function formatStatus(status: ShootStatusResult): string {
  const lines = [`${status.script} · ${status.file} · timeline ${status.timeline} · next: ${status.next ? `#${status.next}` : "nothing, every scene is done"}`];
  for (const scene of status.scenes) {
    const chosen = scene.chosen ? `take ${scene.chosen}${scene.picked ? " (picked)" : ""}` : "no take";
    lines.push(`  #${scene.slug}  ${scene.state}  ${chosen}${scene.pending > 0 ? `  ${scene.pending} pending` : ""}`);
  }
  if (status.takes.length === 0) lines.push("No takes yet: `frameshell shoot add <script> <asset>`.");
  for (const take of status.takes) {
    const head = `Take ${take.id}  ${take.asset}  from #${take.scene}  ${take.recordedAt}${take.discarded ? "  discarded" : ""}`;
    lines.push(head);
    if (take.state !== "analyzed") {
      lines.push(`  ${take.problem}`);
      continue;
    }
    lines.push(`  covers ${take.scenes.map((slug) => `#${slug}`).join(", ") || "nothing"}`);
    for (const d of take.deviations) {
      const where = d.line !== null ? `line ${d.line}` : d.scene ? `#${d.scene}` : "outside";
      const at = d.at ? ` @${d.at.start.toFixed(2)}s` : "";
      const what = [d.expected ? `"${d.expected}"` : "", d.heard ? `heard "${d.heard}"` : ""].filter(Boolean).join(" ");
      const flags = [d.maybeTranscription ? "maybe transcription" : "", d.accepted ? "accepted" : ""].filter(Boolean).join(", ");
      lines.push(`  ${d.id}  ${d.kind}  ${where}${at}  ${what}${flags ? `  (${flags})` : ""}`);
    }
  }
  if (status.warnings.length > 0) lines.push("Warnings:", ...status.warnings.map((warning) => `  ${warning}`));
  return `${lines.join("\n")}\n`;
}
