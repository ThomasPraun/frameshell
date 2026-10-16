import { describe, expect, it } from "vitest";
import { type SyncHost, syncedFolder } from "../src/synced-folder.js";

function host(overrides: Partial<SyncHost> = {}, dirs: string[] = [], files: Record<string, string> = {}): SyncHost {
  return {
    platform: "darwin",
    env: {},
    home: "/Users/ana",
    isDir: (path) => dirs.includes(path),
    readText: (path) => files[path] ?? null,
    ...overrides,
  };
}

describe("syncedFolder", () => {
  it("finds macOS iCloud Drive and File Provider folders", () => {
    expect(syncedFolder("/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/talk", host())).toEqual({
      service: "iCloud Drive",
      root: "/Users/ana/Library/Mobile Documents",
    });
    expect(syncedFolder("/Users/ana/Library/CloudStorage/Dropbox/videos/talk", host())).toEqual({
      service: "Dropbox",
      root: "/Users/ana/Library/CloudStorage/Dropbox",
    });
    expect(syncedFolder("/Users/ana/Library/CloudStorage/GoogleDrive-ana@example.com/My Drive/talk", host())).toMatchObject({
      service: "Google Drive",
    });
    expect(syncedFolder("/Users/ana/Library/CloudStorage/OneDrive-Personal/talk", host())).toMatchObject({ service: "OneDrive" });
  });

  it("finds the Desktop only when iCloud syncs Desktop & Documents", () => {
    expect(syncedFolder("/Users/ana/Desktop/talk", host())).toBeNull();
    const synced = host({}, ["/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Desktop"]);
    expect(syncedFolder("/Users/ana/Desktop/talk", synced)).toEqual({ service: "iCloud Drive", root: "/Users/ana/Desktop" });
    expect(syncedFolder("/Users/ana/Documents/talk", synced)).toBeNull();
  });

  it("reads Dropbox's own list of folders, and survives a broken one", () => {
    const files = { "/home/ana/.dropbox/info.json": JSON.stringify({ personal: { path: "/home/ana/Dropbox" }, business: { path: "/srv/Acme Dropbox" } }) };
    const linux = host({ platform: "linux", home: "/home/ana" }, [], files);
    expect(syncedFolder("/srv/Acme Dropbox/promo", linux)).toEqual({ service: "Dropbox", root: "/srv/Acme Dropbox" });
    expect(syncedFolder("/home/ana/Videos/promo", linux)).toBeNull();
    const broken = host({ platform: "linux", home: "/home/ana" }, [], { "/home/ana/.dropbox/info.json": "{" });
    expect(syncedFolder("/home/ana/Dropbox/promo", broken)).toBeNull();
  });

  it("finds OneDrive, iCloud and Google Drive on Windows, ignoring case", () => {
    const windows = host({ platform: "win32", home: "C:\\Users\\Ana", env: { OneDrive: "C:\\Users\\Ana\\OneDrive" } });
    expect(syncedFolder("c:\\users\\ana\\onedrive\\Videos\\talk", windows)).toEqual({ service: "OneDrive", root: "C:\\Users\\Ana\\OneDrive" });
    expect(syncedFolder("C:\\Users\\Ana\\iCloudDrive\\talk", windows)).toMatchObject({ service: "iCloud Drive" });
    expect(syncedFolder("G:\\My Drive\\talk", windows)).toEqual({ service: "Google Drive", root: "G:\\My Drive" });
    expect(syncedFolder("C:\\Users\\Ana\\Videos\\talk", windows)).toBeNull();
  });
});
