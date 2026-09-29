import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode, PROTOCOL_VERSION } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { type RawSession, rawSession, tempDir, uniqueSocketPath } from "./helpers.js";

let daemon: Daemon;
let session: RawSession;
beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath() });
  session = await rawSession(daemon.socketPath);
});
afterEach(async () => {
  session.close();
  await daemon.close();
});

/** Asserts an InvalidParams reply whose message names `field`. */
async function expectInvalidParams(method: string, params: unknown, field: string) {
  const reply = await session.call(method, params);
  expect(reply.error).toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining(field) });
  expect(reply.error?.message).toContain(method);
  return reply.error!;
}

describe("params validation", () => {
  describe("status", () => {
    it("rejects null params as InvalidParams instead of an internal error", async () => {
      await expectInvalidParams("status", null, "params");
    });

    it("rejects missing params", async () => {
      await expectInvalidParams("status", undefined, "params");
    });

    it("names the wrongly typed field", async () => {
      const error = await expectInvalidParams("status", { cwd: 42 }, "cwd");
      expect(error.data).toMatchObject({ issues: [{ path: ["cwd"] }] });
    });

    it("rejects a relative cwd, which would resolve against the daemon's own directory", async () => {
      await expectInvalidParams("status", { cwd: "relative/dir" }, "cwd");
    });

    it("rejects unknown fields so typos surface", async () => {
      await expectInvalidParams("status", { cwd: tempDir(), cwdd: "/x" }, "cwdd");
    });
  });

  describe("project.init", () => {
    it("requires dir", async () => {
      await expectInvalidParams("project.init", { name: "x" }, "dir");
    });

    it("rejects a non-string name", async () => {
      await expectInvalidParams("project.init", { dir: tempDir(), name: 7 }, "name");
    });

    it("rejects a relative dir", async () => {
      await expectInvalidParams("project.init", { dir: "my-video" }, "dir");
    });
  });

  describe("handshake", () => {
    it("names a missing client id", async () => {
      const fresh = await rawSession(daemon.socketPath, false);
      try {
        const reply = await fresh.call("handshake", { protocolVersion: PROTOCOL_VERSION });
        expect(reply.error).toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("client") });
      } finally {
        fresh.close();
      }
    });

    it("names a missing protocolVersion", async () => {
      const fresh = await rawSession(daemon.socketPath, false);
      try {
        const reply = await fresh.call("handshake", { client: "x" });
        expect(reply.error).toMatchObject({
          code: ErrorCode.InvalidParams,
          message: expect.stringContaining("protocolVersion"),
        });
      } finally {
        fresh.close();
      }
    });

    it("stays unauthenticated after an invalid handshake", async () => {
      const fresh = await rawSession(daemon.socketPath, false);
      try {
        await fresh.call("handshake", { protocolVersion: PROTOCOL_VERSION });
        const reply = await fresh.call("status", { cwd: tempDir() });
        expect(reply.error).toMatchObject({ code: ErrorCode.HandshakeRequired });
      } finally {
        fresh.close();
      }
    });
  });

  it("still serves valid requests on the same connection after a rejection", async () => {
    await session.call("status", null);
    const reply = await session.call("status", { cwd: tempDir() });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ project: null });
  });
});
