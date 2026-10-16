// electron-builder afterPack hook (#204): copy npm, with the packages it bundles inside itself, into the app's
// resources/npm/, where the plugin store runs it as Node (packages/core/src/plugins/npm-runtime.ts). electron-builder's
// own copying (dependencies, extraResources) drops node_modules folders nested in a package. Runs before signing.
import { cp, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** @param {{ appOutDir: string, electronPlatformName: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function bundleNpm(context) {
  const npm = await realpath(dirname(createRequire(import.meta.url).resolve("npm/package.json")));
  const resources =
    context.electronPlatformName === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(context.appOutDir, "resources");
  await cp(npm, join(resources, "npm"), { recursive: true, dereference: true });
}
