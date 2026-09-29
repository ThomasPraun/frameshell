import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, PROTOCOL_VERSION, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { uniqueSocketPath } from "./helpers.js";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

describe("protocol handshake", () => {
  it("accepts a client speaking the same protocol version", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    expect(conn.daemon).toMatchObject({ protocolVersion: PROTOCOL_VERSION, pid: process.pid });
    conn.close();
  });

  it("rejects an incompatible client with a clear error naming both versions", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const attempt = connectToDaemon(daemon.socketPath, {
      client: "test",
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    await expect(attempt).rejects.toBeInstanceOf(RpcError);
    await expect(attempt).rejects.toMatchObject({
      code: ErrorCode.IncompatibleProtocol,
      message: expect.stringMatching(
        new RegExp(`client.*${PROTOCOL_VERSION + 1}.*frameshelld.*${PROTOCOL_VERSION}.*[Uu]pgrade`, "s"),
      ),
    });
  });

  it("refuses other methods before the handshake", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const { createConnection } = await import("node:net");
    const socket = createConnection(daemon.socketPath);
    const reply = await new Promise<string>((resolve) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => resolve(chunk));
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { cwd: "/" } })}\n`);
    });
    socket.destroy();
    expect(JSON.parse(reply)).toMatchObject({ id: 1, error: { code: ErrorCode.HandshakeRequired } });
  });

  it.each(["null", "42", '"text"', "[]", "true"])(
    "answers InvalidRequest to non-object message %s and keeps serving",
    async (line) => {
      daemon = await startDaemon({ socketPath: uniqueSocketPath() });
      const { createConnection } = await import("node:net");
      const socket = createConnection(daemon.socketPath);
      const reply = await new Promise<string>((resolve) => {
        socket.setEncoding("utf8");
        socket.once("data", (chunk: string) => resolve(chunk));
        socket.write(`${line}\n`);
      });
      socket.destroy();
      expect(JSON.parse(reply)).toMatchObject({ id: null, error: { code: ErrorCode.InvalidRequest } });
      const conn = await connectToDaemon(daemon.socketPath, { client: "test" });
      expect(conn.daemon.pid).toBe(process.pid);
      conn.close();
    },
  );

  it("replies with null id when the request id is not a string or number", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const { createConnection } = await import("node:net");
    const socket = createConnection(daemon.socketPath);
    const reply = await new Promise<string>((resolve) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => resolve(chunk));
      socket.write(`${JSON.stringify({ jsonrpc: "1.0", id: { x: 1 }, method: "status" })}\n`);
    });
    socket.destroy();
    expect(JSON.parse(reply)).toMatchObject({ id: null, error: { code: ErrorCode.InvalidRequest } });
  });
});
