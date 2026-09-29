import { describe, expect, it } from "vitest";
import { planRelease } from "../scripts/release/plan.mjs";

const tag = { GITHUB_REF: "refs/tags/v0.1.0", GITHUB_REF_TYPE: "tag", GITHUB_RUN_NUMBER: "7" };
const certificate = { MACOS_CERTIFICATE_P12_BASE64: "cDEy", MACOS_CERTIFICATE_PASSWORD: "hunter2" };
const apiKey = { APPLE_API_KEY_P8_BASE64: "cDg=", APPLE_API_KEY_ID: "ABC123", APPLE_API_ISSUER: "0000-issuer" };
const appleId = { APPLE_ID: "dev@example.com", APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh", APPLE_TEAM_ID: "TEAM12345" };

describe("planRelease: version", () => {
  it("takes the version from a v-prefixed tag", () => {
    expect(planRelease({ platform: "linux", arch: "x64", env: tag }).version).toBe("0.1.0");
    const pre = { ...tag, GITHUB_REF: "refs/tags/v0.2.0-beta.3" };
    expect(planRelease({ platform: "linux", arch: "x64", env: pre }).version).toBe("0.2.0-beta.3");
  });

  it("stamps branch and dispatch builds as CI prereleases, and local builds as local", () => {
    const branch = { GITHUB_REF: "refs/heads/main", GITHUB_REF_TYPE: "branch", GITHUB_RUN_NUMBER: "42" };
    expect(planRelease({ platform: "linux", arch: "x64", env: branch }).version).toBe("0.0.0-ci.42");
    expect(planRelease({ platform: "linux", arch: "x64", env: {} }).version).toBe("0.0.0-local");
  });

  it("rejects a tag that is not a semantic version", () => {
    const bad = { ...tag, GITHUB_REF: "refs/tags/v1.2" };
    expect(planRelease({ platform: "linux", arch: "x64", env: bad }).errors).toEqual([
      'Tag "v1.2" is not a release tag: expected v<major>.<minor>.<patch>[-prerelease], e.g. v0.1.0.',
    ]);
  });

  it("writes the version into the packaged app and never lets electron-builder publish", () => {
    const { args } = planRelease({ platform: "linux", arch: "x64", env: tag });
    expect(args).toContain("-c.extraMetadata.version=0.1.0");
    expect(args.join(" ")).toContain("--publish never");
  });
});

describe("planRelease: macOS signing", () => {
  it("builds unsigned, and says so, when no signing secrets exist", () => {
    const plan = planRelease({ platform: "darwin", arch: "arm64", env: tag });
    expect(plan.errors).toEqual([]);
    expect(plan.signing).toBe("unsigned");
    expect(plan.args).toEqual(expect.arrayContaining(["--mac", "-c.mac.identity=null", "-c.mac.notarize=false"]));
    // A keychain identity on a developer Mac must not sneak into an "unsigned" build.
    expect(plan.env["CSC_IDENTITY_AUTO_DISCOVERY"]).toBe("false");
    expect(plan.summary).toMatch(/unsigned/i);
    expect(plan.summary).toMatch(/Gatekeeper/);
  });

  it("signs with the certificate and notarizes with an App Store Connect API key", () => {
    const plan = planRelease({ platform: "darwin", arch: "arm64", env: { ...tag, ...certificate, ...apiKey } });
    expect(plan.errors).toEqual([]);
    expect(plan.signing).toBe("notarized");
    expect(plan.env).toMatchObject({
      CSC_LINK: "cDEy",
      CSC_KEY_PASSWORD: "hunter2",
      APPLE_API_KEY_ID: "ABC123",
      APPLE_API_ISSUER: "0000-issuer",
    });
    // electron-builder wants a .p8 path: the runner writes this content and sets APPLE_API_KEY.
    expect(plan.appleApiKeyBase64).toBe("cDg=");
    expect(plan.args).not.toContain("-c.mac.identity=null");
    expect(plan.summary).toMatch(/notarized/i);
    expect(plan.summary).not.toContain("hunter2");
  });

  it("notarizes with an Apple ID app-specific password when no API key is set", () => {
    const plan = planRelease({ platform: "darwin", arch: "x64", env: { ...tag, ...certificate, ...appleId } });
    expect(plan.errors).toEqual([]);
    expect(plan.signing).toBe("notarized");
    expect(plan.env).toMatchObject({
      APPLE_ID: "dev@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh",
      APPLE_TEAM_ID: "TEAM12345",
    });
    expect(plan.appleApiKeyBase64).toBeUndefined();
  });

  it("refuses half-configured signing instead of silently shipping an unsigned build", () => {
    const noPassword = planRelease({
      platform: "darwin",
      arch: "arm64",
      env: { ...tag, MACOS_CERTIFICATE_P12_BASE64: "cDEy", ...apiKey },
    });
    expect(noPassword.errors).toEqual(["MACOS_CERTIFICATE_PASSWORD is missing (MACOS_CERTIFICATE_P12_BASE64 is set)."]);

    const noNotarization = planRelease({ platform: "darwin", arch: "arm64", env: { ...tag, ...certificate } });
    expect(noNotarization.errors[0]).toMatch(/notariz/i);

    const partialApiKey = planRelease({
      platform: "darwin",
      arch: "arm64",
      env: { ...tag, ...certificate, APPLE_API_KEY_P8_BASE64: "cDg=", APPLE_API_KEY_ID: "ABC123" },
    });
    expect(partialApiKey.errors).toEqual(["APPLE_API_ISSUER is missing (the App Store Connect API key is partly set)."]);

    const notarizeWithoutCertificate = planRelease({ platform: "darwin", arch: "arm64", env: { ...tag, ...apiKey } });
    expect(notarizeWithoutCertificate.errors[0]).toMatch(/MACOS_CERTIFICATE_P12_BASE64/);
  });

  it("treats empty secrets as absent, as GitHub passes unset secrets", () => {
    const empty = { MACOS_CERTIFICATE_P12_BASE64: "", MACOS_CERTIFICATE_PASSWORD: "", APPLE_API_KEY_ID: "" };
    const plan = planRelease({ platform: "darwin", arch: "arm64", env: { ...tag, ...empty } });
    expect(plan.errors).toEqual([]);
    expect(plan.signing).toBe("unsigned");
  });
});

describe("planRelease: platforms", () => {
  it("packages Linux as AppImage and .deb, unsigned by design", () => {
    const plan = planRelease({ platform: "linux", arch: "x64", env: tag });
    expect(plan.args).toContain("--linux");
    expect(plan.signing).toBe("not-applicable");
    expect(plan.executable).toBe("release/linux-unpacked/frameshell");
  });

  it("packages Windows as an unsigned beta installer and warns about SmartScreen", () => {
    const plan = planRelease({ platform: "win32", arch: "x64", env: { ...tag, ...certificate } });
    expect(plan.args).toContain("--win");
    expect(plan.signing).toBe("unsigned");
    expect(plan.summary).toMatch(/SmartScreen/);
    // The macOS certificate is never handed to the Windows build.
    expect(plan.env["CSC_LINK"]).toBeUndefined();
    expect(plan.executable).toBe("release/win-unpacked/Frameshell.exe");
  });

  it("points the smoke test at the unpacked app for the build machine's architecture", () => {
    expect(planRelease({ platform: "darwin", arch: "arm64", env: tag }).executable).toBe(
      "release/mac-arm64/Frameshell.app/Contents/MacOS/Frameshell",
    );
    expect(planRelease({ platform: "darwin", arch: "x64", env: tag }).executable).toBe(
      "release/mac/Frameshell.app/Contents/MacOS/Frameshell",
    );
  });

  it("can stop at the unpacked app for quick local checks", () => {
    const plan = planRelease({ platform: "darwin", arch: "arm64", env: {}, dirOnly: true });
    expect(plan.args).toContain("--dir");
    expect(plan.args).toContain("--arm64");
  });
});
