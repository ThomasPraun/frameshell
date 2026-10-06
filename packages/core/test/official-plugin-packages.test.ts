import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

// Official plugins ship to npm from the release pipeline (docs/release.md). The static half of
// `plugins-npm.mjs` needs no network and no pack, so every `pnpm test` catches a package.json or
// manifest that would publish broken. CI runs the pack + `npm publish --dry-run` half on Linux.
describe("official plugin npm packages", () => {
  it("are publishable: public scope, provenance, repository, files, manifest in step with package.json", () => {
    const output = execFileSync(process.execPath, ["scripts/plugins-npm.mjs", "verify"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(output).toContain("@frameshell/whisper-cpp@");
    expect(output).toContain("@frameshell/hyperframes@");
  });
});
