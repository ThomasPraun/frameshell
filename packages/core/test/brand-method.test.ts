import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: `brand.capture` over the wire (ADR 0044): a URL that is not public http(s) is refused before any
// job, proxy or Chrome starts.

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    brandNetwork: { resolve: async (host) => (host === "nas.test" ? ["10.1.2.3"] : []) },
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
});

afterAll(async () => {
  conn.close();
  await daemon.close();
});

async function refusal(url: string): Promise<RpcError> {
  const error = await conn.request("brand.capture", { cwd: project, url }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

describe("brand.capture", () => {
  it.each([
    ["file:///etc/hosts", "scheme"],
    ["data:text/html,hi", "scheme"],
    ["chrome://version", "scheme"],
    ["https://me:pw@example.com/", "credentials"],
    ["http://example.com:3000/", "port"],
  ])("refuses %s with reason %s and queues no job", async (url, reason) => {
    const error = await refusal(url);
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.data).toMatchObject({ op: "brand.capture", reason, field: "url" });
    expect((await conn.request("job.list", { cwd: project })).jobs.filter((job) => job.kind === "brand")).toEqual([]);
  });

  it("refuses a private or loopback host before Chrome starts", async () => {
    for (const url of ["http://nas.test/", "http://127.0.0.1/", "http://[::1]/"]) {
      const error = await refusal(url);
      expect(error.data).toMatchObject({ reason: "address" });
      expect(error.message).toMatch(/non-public address/);
    }
  });
});
