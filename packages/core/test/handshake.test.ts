import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, PROTOCOL_VERSION, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { rawSession, tempDir, uniqueSocketPath } from "./helpers.js";

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

  it("serves a request pipelined in the same write as the handshake", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const { createConnection } = await import("node:net");
    const socket = createConnection(daemon.socketPath);
    const replies = await new Promise<Array<{ id: number; result?: unknown; error?: unknown }>>((resolve) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n").filter(Boolean);
        if (lines.length === 2) resolve(lines.map((line) => JSON.parse(line)));
      });
      const handshake = { jsonrpc: "2.0", id: 1, method: "handshake", params: { protocolVersion: PROTOCOL_VERSION, client: "pipeline" } };
      const status = { jsonrpc: "2.0", id: 2, method: "status", params: { cwd: tempDir() } };
      socket.write(`${JSON.stringify(handshake)}\n${JSON.stringify(status)}\n`);
    });
    socket.destroy();
    const byId = new Map(replies.map((reply) => [reply.id, reply]));
    expect(byId.get(1)).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSION } });
    expect(byId.get(2)?.error).toBeUndefined();
    expect(byId.get(2)).toMatchObject({ result: { daemon: { pid: process.pid } } });
  });

  it("keeps the connection unauthenticated after a handshake with invalid params", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const session = await rawSession(daemon.socketPath, false);
    const bad = await session.call("handshake", { protocolVersion: PROTOCOL_VERSION });
    expect(bad.error).toMatchObject({ code: ErrorCode.InvalidParams });
    const status = await session.call("status", { cwd: tempDir() });
    session.close();
    expect(status.error).toMatchObject({ code: ErrorCode.HandshakeRequired });
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
