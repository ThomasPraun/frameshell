// Release plan: what one packaging run builds and how it signs. Pure: no I/O, so tests pin every branch.
// Secrets arrive as env vars named like the repository secrets (docs/release.md).

/** @typedef {"darwin" | "linux" | "win32"} ReleasePlatform */

/**
 * How the build is signed.
 * - `notarized`: macOS, Developer ID signed and notarized.
 * - `signpath`: Windows, signed through SignPath (ADR 0051). This run builds only the unpacked app; the workflow
 *   signs it, runs `package.mjs --installer` and signs the installer.
 * - `unsigned`: macOS or Windows without signing configuration.
 * - `not-applicable`: Linux packages carry no code signature.
 * @typedef {"notarized" | "signpath" | "unsigned" | "not-applicable"} SigningMode
 */

/**
 * @typedef {object} ReleasePlan
 * @property {string} version Version stamped into the app (`extraMetadata.version`).
 * @property {string[]} args electron-builder CLI arguments.
 * @property {Record<string, string>} env Extra env for electron-builder (signing credentials). Never log it.
 * @property {string | undefined} appleApiKeyBase64 `.p8` key content. The runner writes it to a file and sets `APPLE_API_KEY` to that path.
 * @property {SigningMode} signing
 * @property {string} executable Unpacked app executable for the smoke test, relative to `apps/desktop`.
 * @property {string | undefined} installer Windows installer this run writes, relative to `apps/desktop`. Undefined on
 *   macOS and Linux, and when the run builds no installer (`--dir`, or the SignPath app phase).
 * @property {string} summary Markdown for the job summary. Holds no secret values.
 * @property {string[]} errors Configuration problems. Non-empty: the runner must not build.
 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

const API_KEY_SECRETS = ["APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
const APPLE_ID_SECRETS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

const EXECUTABLES = {
  darwin: { arm64: "release/mac-arm64/Frameshell.app/Contents/MacOS/Frameshell", x64: "release/mac/Frameshell.app/Contents/MacOS/Frameshell" },
  linux: { arm64: "release/linux-arm64-unpacked/frameshell", x64: "release/linux-unpacked/frameshell" },
  win32: { arm64: "release/win-arm64-unpacked/Frameshell.exe", x64: "release/win-unpacked/Frameshell.exe" },
};

const PLATFORM_FLAG = { darwin: "--mac", linux: "--linux", win32: "--win" };

/**
 * SignPath settings (ADR 0051). The token is a repository secret; the workflow passes only whether it exists
 * (`SIGNPATH_API_TOKEN_SET`), so the token never reaches electron-builder. The others are repository variables.
 */
const SIGNPATH_SETTINGS = ["SIGNPATH_API_TOKEN_SET", "SIGNPATH_ORGANIZATION_ID", "SIGNPATH_PROJECT_SLUG", "SIGNPATH_SIGNING_POLICY_SLUG"];

/**
 * Plan one packaging run.
 *
 * Version: tag `v1.2.3[-pre]` gives `1.2.3[-pre]`; other CI refs give `0.0.0-ci.<run>`; no CI gives `0.0.0-local`.
 * macOS signs and notarizes only when the certificate and one notarization method are complete. No macOS
 * secret at all: unsigned build plus a warning. Partial secrets: an error, never a silent unsigned release.
 * Windows signs through SignPath only when all its settings exist; partial settings are an error too. Signing
 * happens in two runs: the app phase builds the unpacked app (the workflow signs it), then the `installer` phase
 * builds the NSIS installer from that signed app with `--prepackaged` (the workflow signs it too).
 *
 * @param {{ platform: ReleasePlatform, arch: "arm64" | "x64", env: Record<string, string | undefined>, dirOnly?: boolean, installer?: boolean }} input
 *   `dirOnly`: stop at the unpacked app for the host arch (local checks), no installers.
 *   `installer`: Windows only, the SignPath installer phase: package the already unpacked (and signed) app.
 * @returns {ReleasePlan}
 */
export function planRelease({ platform, arch, env, dirOnly = false, installer = false }) {
  /** @type {string[]} */
  const errors = [];
  const version = releaseVersion(env, errors);
  const args = [PLATFORM_FLAG[platform], "--publish", "never", `-c.extraMetadata.version=${version}`];
  const executable = EXECUTABLES[platform][arch];

  if (installer) {
    if (platform !== "win32") errors.push("--installer is for the Windows SignPath phase only.");
    if (dirOnly) errors.push("--installer and --dir exclude each other.");
    args.push("--prepackaged", executable.slice(0, executable.lastIndexOf("/")), `--${arch}`);
    return {
      version,
      args,
      env: {},
      appleApiKeyBase64: undefined,
      signing: "signpath",
      executable,
      installer: windowsInstaller(version, arch),
      // The app phase already wrote the summary.
      summary: "",
      errors,
    };
  }

  if (dirOnly) args.push("--dir", `--${arch}`);

  const signing = platform === "darwin" ? macSigning(env, errors) : undefined;
  if (signing?.mode === "unsigned") args.push("-c.mac.identity=null", "-c.mac.notarize=false");

  const windows = platform === "win32" ? windowsSigning(env, errors) : undefined;
  // SignPath app phase: the installer is built after the app is signed.
  if (windows === "signpath" && !dirOnly) args.push("--dir", `--${arch}`);

  const mode = signing?.mode ?? windows ?? "not-applicable";
  return {
    version,
    args,
    env: signing?.env ?? {},
    appleApiKeyBase64: signing?.appleApiKeyBase64,
    signing: mode,
    executable,
    installer: platform === "win32" && !dirOnly && windows !== "signpath" ? windowsInstaller(version, arch) : undefined,
    summary: summaryFor(platform, version, mode, signing?.method),
    errors,
  };
}

/**
 * The NSIS installer's path, from `artifactName` in `electron-builder.yml`.
 * @param {string} version
 * @param {"arm64" | "x64"} arch
 */
function windowsInstaller(version, arch) {
  return `release/Frameshell-${version}-win-${arch}.exe`;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} errors
 * @returns {SigningMode}
 */
function windowsSigning(env, errors) {
  // GitHub passes unset variables as "" and the token flag as "false".
  const has = (/** @type {string} */ name) => Boolean(env[name]) && env[name] !== "false";
  const present = SIGNPATH_SETTINGS.filter(has);
  if (present.length === 0) return "unsigned";
  if (present.length < SIGNPATH_SETTINGS.length) {
    for (const name of SIGNPATH_SETTINGS.filter((name) => !has(name))) {
      const label = name === "SIGNPATH_API_TOKEN_SET" ? "The SIGNPATH_API_TOKEN secret" : `The ${name} variable`;
      errors.push(`${label} is missing (SignPath signing is partly configured).`);
    }
    return "unsigned";
  }
  return "signpath";
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} errors
 */
function releaseVersion(env, errors) {
  const ref = env["GITHUB_REF"] ?? "";
  if (env["GITHUB_REF_TYPE"] === "tag" || ref.startsWith("refs/tags/")) {
    const tag = ref.replace(/^refs\/tags\//, "");
    const version = tag.replace(/^v/, "");
    if (tag.startsWith("v") && SEMVER.test(version)) return version;
    errors.push(`Tag "${tag}" is not a release tag: expected v<major>.<minor>.<patch>[-prerelease], e.g. v0.1.0.`);
    return "0.0.0-invalid";
  }
  const run = env["GITHUB_RUN_NUMBER"];
  return run ? `0.0.0-ci.${run}` : "0.0.0-local";
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} errors
 * @returns {{ mode: SigningMode, method?: string, env: Record<string, string>, appleApiKeyBase64?: string | undefined }}
 */
function macSigning(env, errors) {
  // GitHub passes unset secrets as "": treat as absent.
  const get = (/** @type {string} */ name) => env[name] || undefined;
  const has = (/** @type {string} */ name) => get(name) !== undefined;
  const certificate = get("MACOS_CERTIFICATE_P12_BASE64");
  const apiKeyCount = API_KEY_SECRETS.filter(has).length;
  // APPLE_TEAM_ID alone does not start the Apple ID method: it is also useful as plain metadata.
  const appleIdCount = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"].filter(has).length;
  // Keychain identities on a developer Mac must not leak into a build meant to be unsigned.
  const unsigned = { mode: /** @type {SigningMode} */ ("unsigned"), env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" } };

  if (!certificate) {
    if (has("MACOS_CERTIFICATE_PASSWORD") || apiKeyCount > 0 || appleIdCount > 0) {
      errors.push("MACOS_CERTIFICATE_P12_BASE64 is missing: notarization secrets are set, but notarizing needs a signed app.");
    }
    return unsigned;
  }
  const password = get("MACOS_CERTIFICATE_PASSWORD");
  if (!password) errors.push("MACOS_CERTIFICATE_PASSWORD is missing (MACOS_CERTIFICATE_P12_BASE64 is set).");
  const signingEnv = { CSC_LINK: certificate, CSC_KEY_PASSWORD: password ?? "" };

  if (apiKeyCount > 0) {
    for (const name of API_KEY_SECRETS.filter((name) => !has(name))) {
      errors.push(`${name} is missing (the App Store Connect API key is partly set).`);
    }
    return {
      mode: "notarized",
      method: "App Store Connect API key",
      env: { ...signingEnv, APPLE_API_KEY_ID: get("APPLE_API_KEY_ID") ?? "", APPLE_API_ISSUER: get("APPLE_API_ISSUER") ?? "" },
      appleApiKeyBase64: get("APPLE_API_KEY_P8_BASE64"),
    };
  }
  if (appleIdCount > 0) {
    for (const name of APPLE_ID_SECRETS.filter((name) => !has(name))) {
      errors.push(`${name} is missing (Apple ID notarization is partly set).`);
    }
    return {
      mode: "notarized",
      method: "Apple ID app-specific password",
      env: {
        ...signingEnv,
        APPLE_ID: get("APPLE_ID") ?? "",
        APPLE_APP_SPECIFIC_PASSWORD: get("APPLE_APP_SPECIFIC_PASSWORD") ?? "",
        APPLE_TEAM_ID: get("APPLE_TEAM_ID") ?? "",
      },
    };
  }
  errors.push(
    "The certificate is set but no notarization method is: add APPLE_API_KEY_P8_BASE64, APPLE_API_KEY_ID and " +
      "APPLE_API_ISSUER (or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID). A signed app that is not " +
      "notarized still triggers Gatekeeper.",
  );
  return { mode: "unsigned", env: signingEnv };
}

/**
 * @param {ReleasePlatform} platform
 * @param {string} version
 * @param {SigningMode} mode
 * @param {string | undefined} method
 */
function summaryFor(platform, version, mode, method) {
  const name = { darwin: "macOS", linux: "Linux", win32: "Windows" }[platform];
  const lines = [`### ${name} ${version}`, ""];
  if (platform === "darwin" && mode === "notarized") {
    lines.push(`Signed with the Developer ID certificate and notarized (${method}).`);
  } else if (platform === "darwin") {
    lines.push(
      "> [!WARNING]",
      "> **Unsigned macOS build.** No signing secrets are configured, so this DMG is neither signed nor notarized " +
        "and Gatekeeper will block it on first launch. See `docs/release.md` to add the secrets.",
    );
  } else if (platform === "win32" && mode === "signpath") {
    lines.push("App and installer signed through SignPath (certificate by SignPath Foundation).");
  } else if (platform === "win32") {
    lines.push(
      "> [!WARNING]",
      "> **Unsigned Windows beta.** Windows SmartScreen warns on first run (\"More info\" → \"Run anyway\"). " +
        "See `docs/release.md` to set up SignPath signing.",
    );
  } else {
    lines.push("AppImage and .deb. Linux packages are not code-signed.");
  }
  return `${lines.join("\n")}\n`;
}
