import { type BinaryPackage, type PlatformKey, mirrorUrl } from "./manifest.js";

/** Files the mirror job writes itself; no pinned asset may use these names. */
export const MIRROR_GENERATED_FILES = ["SHA256SUMS.txt", "SOURCE-OFFER.txt", "COPYING.GPLv3"] as const;

/** One file the mirror release republishes byte for byte. */
export interface MirrorAsset {
  /** Asset name in the release; last path segment of its mirror URL. */
  readonly name: string;
  /** Where the mirror job downloads it (the canonical URL). */
  readonly from: string;
  /** Mirror URL the daemon falls back to. Sources have one too, but the daemon never fetches them. */
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly kind: "binary" | "source";
  /** Pins that use this file. */
  readonly platforms: readonly PlatformKey[];
  /** Release-notes line: builder for binaries, content for sources. */
  readonly description: string;
}

/** Everything one mirror release must contain, besides `MIRROR_GENERATED_FILES`. */
export interface MirrorPlan {
  readonly package: string;
  readonly repo: string;
  readonly tag: string;
  /** SPDX licences of the mirrored builds, deduplicated. */
  readonly licenses: readonly string[];
  /** Binaries first, then sources; each in manifest order. */
  readonly assets: readonly MirrorAsset[];
}

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Derive the mirror release of `pkg` from its manifest and check the invariants the mirror relies on.
 * Every archive must list the canonical URL first and exactly one mirror URL after it; every build
 * must carry its corresponding source (GPL-3.0 §6); asset names must be unique per content.
 * Throws with every violation listed.
 */
export function planMirror(pkg: BinaryPackage): MirrorPlan {
  const { mirror } = pkg;
  if (!mirror) throw new Error(`Package ${pkg.name} has no mirror.`);
  const errors: string[] = [];
  const byName = new Map<string, MirrorAsset>();
  const add = (asset: MirrorAsset): void => {
    if (!ASSET_NAME.test(asset.name)) errors.push(`${asset.name}: invalid asset name`);
    if ((MIRROR_GENERATED_FILES as readonly string[]).includes(asset.name)) {
      errors.push(`${asset.name}: reserved for a generated file`);
    }
    const seen = byName.get(asset.name);
    if (!seen) {
      byName.set(asset.name, asset);
    } else if (seen.from !== asset.from || seen.sha256 !== asset.sha256 || seen.kind !== asset.kind) {
      errors.push(`${asset.name}: two different files share this asset name`);
    } else {
      byName.set(asset.name, { ...seen, platforms: [...seen.platforms, ...asset.platforms] });
    }
  };

  const prefix = mirrorUrl(mirror, "");
  const licenses = new Set<string>();
  for (const [key, build] of Object.entries(pkg.builds)) {
    if (!build) continue;
    const platform = key as PlatformKey;
    licenses.add(build.license);
    for (const archive of build.archives) {
      const [canonical, ...rest] = archive.urls;
      const mirrors = rest.filter((url) => url.startsWith(prefix));
      if (!canonical || canonical.startsWith(prefix)) {
        errors.push(`${platform}: the first URL must be the canonical one, not the mirror`);
        continue;
      }
      if (mirrors.length !== 1) {
        errors.push(`${platform}: ${canonical} needs exactly one URL under ${prefix}, has ${mirrors.length}`);
        continue;
      }
      const url = mirrors[0]!;
      add({
        name: url.slice(prefix.length),
        from: canonical,
        url,
        sha256: archive.sha256,
        size: archive.size,
        kind: "binary",
        platforms: [platform],
        description: `${Object.keys(archive.files).join(" + ")} ${build.version}, built by ${build.origin}`,
      });
    }
    if (!build.sources || build.sources.length === 0) {
      errors.push(`${platform}: a mirrored build needs its corresponding source (GPL-3.0 §6)`);
      continue;
    }
    for (const source of build.sources) {
      add({
        name: source.name,
        from: source.url,
        url: mirrorUrl(mirror, source.name),
        sha256: source.sha256,
        size: source.size,
        kind: "source",
        platforms: [platform],
        description: source.description,
      });
    }
  }
  for (const asset of byName.values()) {
    if (!/^[0-9a-f]{64}$/.test(asset.sha256)) errors.push(`${asset.name}: SHA-256 must be 64 lowercase hex digits`);
  }
  if (errors.length > 0) throw new Error(`Mirror of ${pkg.name} is inconsistent:\n  ${errors.join("\n  ")}`);

  const assets = [...byName.values()];
  return {
    package: pkg.name,
    repo: mirror.repo,
    tag: mirror.tag,
    licenses: [...licenses],
    assets: [...assets.filter((a) => a.kind === "binary"), ...assets.filter((a) => a.kind === "source")],
  };
}

/**
 * Parse a `sha256sum` listing (`<hex>  <name>` or `<hex> *<name>`) into name -> lowercase hex.
 * Blank lines are skipped; malformed lines throw, so a truncated file cannot pass as valid.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`Malformed SHA256SUMS line: ${line}`);
    sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

/**
 * Compare a published `SHA256SUMS.txt` with the plan. Returns one message per problem; empty means
 * the release holds every pinned binary and source with the pinned bytes, plus the generated files.
 */
export function checkMirrorSums(plan: MirrorPlan, sums: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const asset of plan.assets) {
    const actual = sums.get(asset.name);
    if (actual === undefined) problems.push(`${asset.name}: missing from the mirror`);
    else if (actual !== asset.sha256) problems.push(`${asset.name}: mirror has ${actual}, manifest pins ${asset.sha256}`);
  }
  for (const file of MIRROR_GENERATED_FILES) {
    if (file !== "SHA256SUMS.txt" && !sums.has(file)) problems.push(`${file}: missing from the mirror`);
  }
  return problems;
}
