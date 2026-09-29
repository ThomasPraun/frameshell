import { ErrorCode, RpcError } from "@frameshell/protocol";

/**
 * Where a plugin comes from (SPEC §8.3). Every form is also a valid npm
 * dependency spec, so npm does the fetching.
 */
export type PluginSpec =
  /** `base` has no `#ref`; the pin appends the resolved commit to it. */
  | { kind: "git"; spec: string; base: string; ref: string | null }
  | { kind: "npm"; spec: string; name: string; range: string | null };

const GITHUB = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)(?:#(\S+))?$/;
const GIT_URL = /^(git\+(?:https|ssh|file):\/\/[^#\s]+)(?:#(\S+))?$/;
const NPM = /^((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)(?:@(\S+))?$/;

/**
 * Parse a user-supplied install spec: `github:<user>/<repo>[#ref]`,
 * `git+{https,ssh,file}://…[#ref]` or `[@scope/]name[@version|tag|range]`.
 * Throws `InvalidPluginSpec` for anything else (local paths, tarball URLs).
 */
export function parsePluginSpec(raw: string): PluginSpec {
  const spec = raw.trim();
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
    `Unsupported plugin spec "${raw}". Use github:<user>/<repo>[#ref], git+https://…[#ref], or an npm name like @scope/name@1.2.3.`,
    { spec: raw },
  );
}
