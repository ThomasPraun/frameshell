import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliShim } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";

// Seam under test: the `.deb` maintainer scripts (#143), rendered as electron-builder renders them and run against a
// temp root instead of `/`, with only the tools they need on PATH.

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "linux");
const TOOLS = ["cat", "chmod", "mv", "rm", "grep"];

function setup(options: { alternatives?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "frameshell-deb-"));
  const bin = join(root, "tools");
  mkdirSync(bin);
  for (const tool of TOOLS) symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  if (options.alternatives) {
    writeFileSync(join(bin, "update-alternatives"), `#!/bin/sh\necho "$*" >> '${root}/alternatives.log'\n`);
    chmodSync(join(bin, "update-alternatives"), 0o755);
  }
  mkdirSync(join(root, "usr", "bin"), { recursive: true });
  mkdirSync(join(root, "opt", "Frameshell"), { recursive: true });
  // Stands in for the Electron binary: prints what it was asked to run.
  writeFileSync(join(root, "opt", "Frameshell", "frameshell"), '#!/bin/sh\necho "RUN_AS_NODE=$ELECTRON_RUN_AS_NODE $*"\n');
  chmodSync(join(root, "opt", "Frameshell", "frameshell"), 0o755);
  const run = (name: string) => {
    const script = join(root, name);
    // electron-builder's macro substitution, then every absolute path moved under the temp root.
    writeFileSync(
      script,
      readFileSync(join(SCRIPTS, name), "utf8")
        .replace(/\$\{executable\}/g, "frameshell")
        .replace(/\$\{sanitizedProductName\}/g, "Frameshell")
        .replace(/'\/(usr|opt|etc)\//g, `'${root}/$1/`),
    );
    execFileSync("/bin/bash", [script], { env: { PATH: bin }, stdio: "pipe" });
  };
  return { root, command: join(root, "usr", "bin", "frameshell"), run };
}

describe.skipIf(process.platform === "win32")(".deb maintainer scripts", () => {
  it("leave no electron-builder macro unknown and no other brace variable", () => {
    for (const name of ["after-install.sh", "after-remove.sh"]) {
      const macros = readFileSync(join(SCRIPTS, name), "utf8").match(/\$\{[a-zA-Z]+\}/g) ?? [];
      expect(new Set(macros)).toEqual(new Set(["${executable}", "${sanitizedProductName}"]));
    }
  });

  it("install a frameshell command that runs the bundled CLI as Node, in the app's shim format", () => {
    const { root, command, run } = setup();
    run("after-install.sh");
    const cliEntry = `${root}/opt/Frameshell/resources/app.asar/node_modules/@frameshell/cli/dist/bin/frameshell.js`;
    expect(parseCliShim(readFileSync(command, "utf8"))).toEqual({ runtime: `${root}/opt/Frameshell/frameshell`, cliEntry });
    expect(execFileSync(command, ["status", "two words"], { encoding: "utf8" }).trim()).toBe(`RUN_AS_NODE=1 ${cliEntry} status two words`);
  });

  it("replace the update-alternatives link of older packages", () => {
    const { root, command, run } = setup({ alternatives: true });
    symlinkSync(`${root}/opt/Frameshell/frameshell`, command);
    run("after-install.sh");
    expect(readFileSync(join(root, "alternatives.log"), "utf8")).toBe(`--remove frameshell ${root}/opt/Frameshell/frameshell\n`);
    expect(parseCliShim(readFileSync(command, "utf8"))).not.toBeNull();
  });

  it("remove the command on uninstall, but never one another install put there", () => {
    const { command, run } = setup();
    run("after-install.sh");
    run("after-remove.sh");
    expect(existsSync(command)).toBe(false);

    writeFileSync(command, "#!/bin/sh\nexec node /somewhere/else/frameshell.js \"$@\"\n");
    run("after-remove.sh");
    expect(existsSync(command)).toBe(true);
  });
});
