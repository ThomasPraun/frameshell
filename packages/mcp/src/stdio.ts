import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type McpServerOptions, createMcpServer } from "./server.js";

/** Options for {@link serveStdio}. */
export interface ServeStdioOptions extends McpServerOptions {
  /** MCP messages from the client. Default `process.stdin`. */
  stdin?: Readable;
  /** MCP messages to the client; nothing else may be written here. Default `process.stdout`. */
  stdout?: Writable;
}

/**
 * Serve MCP over stdio until the client goes away (stdin ends), then drop the
 * daemon connection. Resolves once shut down.
 */
export async function serveStdio(options: ServeStdioOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const server = createMcpServer(options);
  const transport = new StdioServerTransport(stdin, stdout);
  const done = new Promise<void>((resolve) => {
    server.onclose = ((previous) => () => {
      previous?.();
      resolve();
    })(server.onclose);
  });
  // The SDK transport does not watch for end of input; the client closing stdin is the shutdown signal.
  const stop = () => void server.close();
  stdin.once("end", stop);
  stdin.once("close", stop);
  await server.connect(transport);
  await done;
}
