import type { DaemonConnection, MethodResult, Progress } from "@frameshell/protocol";

/** Help text of the `brand` commands (ADR 0044), in `frameshell --help`. */
export const BRAND_USAGE = `  brand capture <url>          Capture a brand from a public http(s) page in headless Chrome: logos (header and nav SVG or
                               image), icons, share image, first screen and full page into assets/brand/<id>/, fonts into
                               assets/fonts/ only when the font file names OFL, Apache or UFL; colours with an accent, fonts by
                               use, :root variables, headings, buttons into brand.json. Never changes style.json: prints the
                               style set commands to suggest. Public addresses only, ports 80/443, at most 120 s and 150 MB
`;

/** Flags each `brand` command takes besides the global ones. */
export const BRAND_FLAGS: Record<string, readonly string[]> = {
  "brand capture": [],
};

/** A parsed `brand` command. */
export type BrandInvocation = { kind: "brand.capture"; url: string };

/** Parse `brand capture <url>`; null when the shape is wrong. */
export function parseBrand(rest: string[]): BrandInvocation | null {
  const [sub, ...args] = rest;
  if (sub !== "capture" || args.length !== 1) return null;
  return { kind: "brand.capture", url: args[0]! };
}

/** Run a parsed `brand` command; human output unless `json`. */
export async function executeBrand(
  conn: DaemonConnection,
  inv: BrandInvocation,
  cwd: string,
  json: boolean,
  progress: ((update: Progress) => void) | undefined,
): Promise<string> {
  const result = await conn.request("brand.capture", { cwd, url: inv.url }, progress ? { onProgress: progress } : {});
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatCapture(result);
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
