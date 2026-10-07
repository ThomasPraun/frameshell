import { fileURLToPath } from "node:url";
import { ErrorCode, RpcError } from "@frameshell/protocol";

/**
 * Where a plugin comes from (SPEC §8.3). npm does the fetching for every
 * form; a tarball's path is resolved by the host against the caller's cwd.
 */
export type PluginSpec =
  /** `base` has no `#ref`; the pin appends the resolved commit to it. */
  | { kind: "git"; spec: string; base: string; ref: string | null }
  | { kind: "npm"; spec: string; name: string; range: string | null }
  /** Local `npm pack` output. `path` is as typed: relative to the caller's cwd, or absolute. */
  | { kind: "tarball"; spec: string; path: string };

const GITHUB = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)(?:#(\S+))?$/;
const GIT_URL = /^(git\+(?:https|ssh|file):\/\/[^#\s]+)(?:#(\S+))?$/;
const NPM = /^((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)(?:@(\S+))?$/;
const TARBALL = /\.(?:tgz|tar\.gz)$/i;
/** URL schemes other than `file:`; Windows drive letters (`C:`) are one letter, so never match. */
const REMOTE = /^[a-z][a-z0-9+.-]+:\/\//i;
const TARBALL_PIN = /^file:(.+)#sha256=([0-9a-f]{64})$/;

/**
 * Parse a user-supplied install spec: `github:<user>/<repo>[#ref]`,
 * `git+{https,ssh,file}://…[#ref]`, `[@scope/]name[@version|tag|range]`, or a
 * local tarball (`<path>.tgz`, `file:<path>`, `file://…`). Throws
 * `InvalidPluginSpec` for anything else: directories, remote tarball URLs.
 */
export function parsePluginSpec(raw: string): PluginSpec {
  const spec = raw.trim();
  const tarball = parseTarball(spec);
  if (tarball) return tarball;
  const github = GITHUB.exec(spec);
  if (github) {
    const repo = github[2]!.replace(/\.git$/, "");
    return { kind: "git", spec, base: `github:${github[1]}/${repo}`, ref: github[3] ?? null };
  }
  const git = GIT_URL.exec(spec);
  if (git) return { kind: "git", spec, base: git[1]!, ref: git[2] ?? null };
  const npm = NPM.exec(spec);
  if (npm) return { kind: "npm", spec, name: npm[1]!, range: npm[2] ?? null };
  throw new RpcError(
    ErrorCode.InvalidPluginSpec,
    `Unsupported plugin spec "${raw}". Use github:<user>/<repo>[#ref], git+https://…[#ref], an npm name like @scope/name@1.2.3, ` +
      "or a local tarball made by `npm pack` (./name-1.2.3.tgz).",
    { spec: raw },
  );
}

function parseTarball(spec: string): PluginSpec | null {
  let path: string;
  if (spec.startsWith("file://")) path = fileURLToPath(spec);
  else if (spec.startsWith("file:")) path = spec.slice("file:".length);
  else if (TARBALL.test(spec) && !REMOTE.test(spec)) path = spec;
  else return null;
  if (!TARBALL.test(path)) {
    throw new RpcError(
      ErrorCode.InvalidPluginSpec,
      `Plugin spec "${spec}" is not a tarball. Local plugins install from \`npm pack\` output: run it in the plugin directory and install the .tgz it writes.`,
      { spec },
    );
  }
  return { kind: "tarball", spec, path };
}

/**
 * Pin of a local tarball: `file:<path>#sha256=<hex>`. `path` uses `/`,
 * project-relative when the tarball is inside the project, else absolute.
 * The digest makes the pin immutable like a commit or a version: trust is
 * granted to these bytes, and a changed file is never installed.
 */
export function formatTarballPin(path: string, sha256: string): string {
  return `file:${path}#sha256=${sha256}`;
}

/** Path and digest of a {@link formatTarballPin} pin; null for every other pin. */
export function parseTarballPin(pin: string): { path: string; sha256: string } | null {
  const match = TARBALL_PIN.exec(pin);
  return match ? { path: match[1]!, sha256: match[2]! } : null;
}
