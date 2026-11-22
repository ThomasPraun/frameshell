import { type AppDirs, type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProvidedCredentials } from "../src/credentials.js";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the daemon over its socket (ADR 0050). The app hands it the OpenAI key with `credentials.provide`;
// the daemon keeps it in its environment while that connection is open, and its own environment wins.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

const KEY = "sk-test-0123456789abcdef";

async function setup(env: Record<string, string | undefined>) {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, env });
  const connect = async (client: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client });
    connections.push(conn);
    return conn;
  };
  return { connect, dirs };
}

describe("credentials.provide", () => {
  it("keeps the key in the daemon's environment while the app connection is open", async () => {
    const env: Record<string, string | undefined> = {};
    const { connect } = await setup(env);
    const app = await connect("desktop/0.1.0");
    expect(await app.request("credentials.provide", { name: "OPENAI_API_KEY", value: KEY })).toEqual({ source: "app" });
    expect(env.OPENAI_API_KEY).toBe(KEY);

    const dir = join(tempDir(), "talk");
    await app.request("project.init", { dir });
    const catalog = await app.request("plugin.catalog", { cwd: dir });
    const speech = catalog.plugins.find((plugin) => plugin.name === "@frameshell/openai-speech");
    expect(speech?.need.met).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain(KEY);

    app.close();
    await expect.poll(() => env.OPENAI_API_KEY).toBeUndefined();
  });

  it("forgets the key on null, and only the giver's", async () => {
    const env: Record<string, string | undefined> = {};
    const { connect } = await setup(env);
    const app = await connect("desktop/0.1.0");
    const other = await connect("cli/test");
    await app.request("credentials.provide", { name: "OPENAI_API_KEY", value: KEY });
    expect(await other.request("credentials.provide", { name: "OPENAI_API_KEY", value: null })).toEqual({ source: "app" });
    expect(env.OPENAI_API_KEY).toBe(KEY);
    expect(await app.request("credentials.provide", { name: "OPENAI_API_KEY", value: null })).toEqual({ source: "none" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("lets a key the daemon started with win", async () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-from-env" };
    const { connect } = await setup(env);
    const app = await connect("desktop/0.1.0");
    expect(await app.request("credentials.provide", { name: "OPENAI_API_KEY", value: KEY })).toEqual({ source: "environment" });
    app.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(env.OPENAI_API_KEY).toBe("sk-from-env");
  });

  it("refuses an empty key without echoing the value", async () => {
    const { connect } = await setup({});
    const app = await connect("desktop/0.1.0");
    await expect(app.request("credentials.provide", { name: "OPENAI_API_KEY", value: "   " })).rejects.toThrow();
    const long = `sk-${"x".repeat(1200)}`;
    const error = await app.request("credentials.provide", { name: "OPENAI_API_KEY", value: long }).catch((caught: unknown) => caught);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain(long);
  });
});

describe("ProvidedCredentials", () => {
  it("takes the latest giver as owner", () => {
    const env: Record<string, string | undefined> = {};
    const credentials = new ProvidedCredentials<string>(env);
    credentials.provide("OPENAI_API_KEY", "a", "first");
    credentials.provide("OPENAI_API_KEY", "b", "second");
    credentials.drop("first");
    expect(env.OPENAI_API_KEY).toBe("b");
    credentials.drop("second");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
