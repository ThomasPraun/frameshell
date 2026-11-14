import type { DaemonConnection, MethodResult, Progress } from "@frameshell/protocol";

/** Help text of the `brand` commands (ADR 0044), in `frameshell --help`. */
export const BRAND_USAGE = `  brand capture <url>          Capture a brand from a public http(s) page in headless Chrome: logos (header and nav SVG or
                               image), icons, share image, first screen and full page into assets/brand/<id>/, fonts into
                               assets/fonts/ only when the font file names OFL, Apache or UFL; colours with an accent, fonts by
                               use, :root variables, headings, buttons into brand.json. Never changes style.json: prints the
                               style set commands to suggest. Public addresses only, ports 80/443, at most 120 s and 150 MB
  brand import-figma <dir>     Import a folder of SVG frames exported from Figma into assets/brand/<id>/: each sanitised (no
                               script, foreign content, event handlers or external references), one scale for the whole
                               folder (canvas width / widest frame), centred; recorded in brand.json with credits entries
                               that need the person's confirmation (credits set --licence own). No network
  brand show                   The project's brand from brand.json: captures (files, colours, accent, fonts) and Figma
                               imports (frames, scale, positions), each with its source
`;

/** Flags each `brand` command takes besides the global ones. */
export const BRAND_FLAGS: Record<string, readonly string[]> = {
  "brand capture": [],
  "brand import-figma": [],
  "brand show": [],
};

/** A parsed `brand` command. */
export type BrandInvocation = { kind: "brand.capture"; url: string } | { kind: "brand.importFigma"; dir: string } | { kind: "brand.show" };

/** Parse `brand capture <url>`, `brand import-figma <dir>` or `brand show`; null when the shape is wrong. */
export function parseBrand(rest: string[]): BrandInvocation | null {
  const [sub, ...args] = rest;
  if (sub === "capture" && args.length === 1) return { kind: "brand.capture", url: args[0]! };
  if (sub === "import-figma" && args.length === 1) return { kind: "brand.importFigma", dir: args[0]! };
  if (sub === "show" && args.length === 0) return { kind: "brand.show" };
  return null;
}

/** Run a parsed `brand` command; human output unless `json`. */
export async function executeBrand(
  conn: DaemonConnection,
  inv: BrandInvocation,
  cwd: string,
  json: boolean,
  progress: ((update: Progress) => void) | undefined,
): Promise<string> {
  if (inv.kind === "brand.show") {
    const result = await conn.request("brand.show", { cwd });
    return json ? `${JSON.stringify(result, null, 2)}\n` : formatShow(result);
  }
  if (inv.kind === "brand.importFigma") {
    const result = await conn.request("brand.importFigma", { cwd, dir: inv.dir });
    return json ? `${JSON.stringify(result, null, 2)}\n` : `${formatImport(result.import, `Imported ${result.import.frames.length} Figma frame${result.import.frames.length === 1 ? "" : "s"} into ${result.manifest}`).join("\n")}\n  Frames have credits entries without a licence: \`frameshell credits\` fails on placed ones until the person confirms (credits set --licence own).\n`;
  }
  const result = await conn.request("brand.capture", { cwd, url: inv.url }, progress ? { onProgress: progress } : {});
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatCapture(result);
}

function formatShow(result: MethodResult<"brand.show">): string {
  if (!result.exists) return `No ${result.manifest} in ${result.dir}: no brand captured or imported yet (frameshell brand capture <url>, frameshell brand import-figma <dir>).\n`;
  const lines: string[] = [];
  for (const capture of result.captures) {
    lines.push(`Capture ${capture.id}: ${capture.finalUrl}${capture.title ? `  "${capture.title}"` : ""}, ${capture.capturedAt}${capture.ok ? "" : "  FAILED (little text)"}`);
    for (const file of capture.files) lines.push(`  ${file.role.padEnd(5)} ${file.path}  from ${file.sourceUrl}`);
    if (capture.colors.length > 0) lines.push(`  colours: ${capture.colors.slice(0, 8).map((color) => `${color.hex} (${color.roles.join("/")})`).join(", ")}`, `  accent: ${capture.accent ?? "none"}`);
    for (const font of capture.fonts) {
      const faces = font.faces.map((face) => `${face.weight}: ${face.file ? `${face.file} (${face.licence})` : "not copied"}`).join("; ");
      lines.push(`  font ${font.family} (weights ${font.weights.join(" ")})${faces ? `: ${faces}` : font.generic ? ": system or generic" : ""}`);
    }
    for (const warning of capture.warnings) lines.push(`  ${warning}`);
  }
  for (const entry of result.imports) lines.push(...formatImport(entry, `Figma import ${entry.id}: ${entry.source}, ${entry.importedAt}`));
  return `${lines.join("\n")}\n`;
}

function formatImport(entry: MethodResult<"brand.importFigma">["import"], title: string): string[] {
  const lines = [title, `  canvas ${entry.canvas.width}x${entry.canvas.height}, scale ${round(entry.scale)} (widest frame ${entry.reference} px), centred`];
  for (const frame of entry.frames) {
    const removed = frame.removed.length > 0 ? `  removed: ${frame.removed.join(", ")}` : "";
    lines.push(`  frame ${frame.path}  ${frame.width}x${frame.height} at ${round(frame.x)},${round(frame.y)}  from ${frame.name}${removed}`);
  }
  for (const warning of entry.warnings) lines.push(`  ${warning}`);
  return lines;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatCapture(result: MethodResult<"brand.capture">): string {
  const { capture } = result;
  const lines = [
    `${capture.ok ? "Captured" : "Capture FAILED (little text)"} ${capture.finalUrl}${capture.title ? `  "${capture.title}"` : ""}`,
    `  ${result.manifest} capture ${capture.id}, ${capture.textLength} characters of text, ${(result.bytes / 1_048_576).toFixed(1)} MB transferred`,
  ];
  for (const file of capture.files) lines.push(`  ${file.role.padEnd(5)} ${file.path}${file.width && file.height ? `  ${file.width}x${file.height}` : ""}`);
  const colors = capture.colors.slice(0, 8).map((color) => `${color.hex} (${color.roles.join("/")})`);
  if (colors.length > 0) lines.push(`  colours: ${colors.join(", ")}`, `  accent: ${capture.accent ?? "none (every colour is neutral)"}`);
  for (const font of capture.fonts) {
    const what = font.generic ? "system or generic" : font.icon ? "icon font, skipped" : font.faces.map((face) => `${face.weight}: ${face.file ?? face.note}`).join("; ");
    lines.push(`  font ${font.family} (${font.uses} uses, weights ${font.weights.join(" ")}): ${what}`);
  }
  if (capture.videos.length > 0) lines.push(`  videos (not downloaded): ${capture.videos.join(", ")}`);
  for (const warning of capture.warnings) lines.push(`  ${warning}`);
  if (result.style.length > 0) {
    lines.push("  Suggested, only after the person agrees (style.json was not changed):");
    for (const one of result.style) lines.push(`    frameshell style set ${one.path} ${shellValue(one.value)}   # ${one.why}`);
  }
  lines.push("  Saved files have credits entries without a licence: `frameshell credits` fails on them until the person confirms (credits set --licence own).");
  return `${lines.join("\n")}\n`;
}

/** A `style set` value as one single-quoted shell word: plain text when `styleValue` reads it back as that text, else JSON. */
function shellValue(value: unknown): string {
  let text = JSON.stringify(value);
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      text = value;
    }
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}
