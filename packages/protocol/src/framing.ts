import type { Socket } from "node:net";

/** JSON-RPC 2.0 request. Omitting `id` makes it a notification (no response). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response: exactly one of `result` or `error`. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Newline-delimited JSON framing. One message per line; `JSON.stringify`
 * never emits raw newlines, so no escaping needed. Lines that fail to parse
 * go to `onInvalid` instead of killing the stream.
 */
export function readMessages(
  socket: Socket,
  onMessage: (message: unknown) => void,
  onInvalid: (line: string) => void = () => {},
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        onInvalid(line);
        continue;
      }
      onMessage(parsed);
    }
  });
}

/** Write one framed message. No-op once the socket is no longer writable. */
export function writeMessage(socket: Socket, message: JsonRpcRequest | JsonRpcResponse): void {
  if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}
