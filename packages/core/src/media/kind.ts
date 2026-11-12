import { extname } from "node:path";
import { type AssetInfo, ErrorCode, RpcError } from "@frameshell/protocol";

const NON_MEDIA: Readonly<Record<string, Exclude<AssetInfo["kind"], "media">>> = {
  ".svg": "svg",
  ".ttf": "font",
  ".otf": "font",
  ".woff": "font",
  ".woff2": "font",
};

const LABELS = { svg: "an SVG file", font: "a font file" } as const;

/**
 * What kind of asset `path` is, by extension (case-insensitive): `svg` and `font`
 * files are not media (ingest only hashes them); everything else is `media`.
 */
export function assetKindOf(path: string): AssetInfo["kind"] {
  return NON_MEDIA[extname(path).toLowerCase()] ?? "media";
}

/**
 * `InvalidOperation` for `path` used where media is needed (a clip, a probe,
 * an ingested proxy); null when `path` is media. `data` joins the error data.
 */
export function nonMediaError(path: string, data: Record<string, unknown> = {}): RpcError | null {
  const kind = assetKindOf(path);
  if (kind === "media") return null;
  return new RpcError(
    ErrorCode.InvalidOperation,
    `${path} is ${LABELS[kind]}, not media: it has no picture or sound to place as a clip. Use a video, audio or image file.`,
    { reason: "not media", path, ...data },
  );
}
