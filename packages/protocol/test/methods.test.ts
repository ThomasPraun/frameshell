import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError, methodJsonSchemas, methods, parseParams, parseRequest } from "../src/index.js";

describe("method registry JSON Schema", () => {
  const schemas = methodJsonSchemas();

  it("covers every declared method", () => {
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(methods).sort());
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining(["handshake", "status", "project.init"]));
  });

  it.each(Object.keys(methods))("%s has a description and object schemas for params and result", (name) => {
    const schema = schemas[name as keyof typeof schemas];
    expect(schema.description.length).toBeGreaterThan(20);
    expect(schema.params).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" });
    expect(schema.result).toMatchObject({ type: "object" });
  });

  it("describes project.init params the way a tool caller needs them", () => {
    expect(schemas["project.init"].params).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["dir"],
      properties: {
        dir: { type: "string", description: expect.stringContaining("Absolute") },
        name: { type: "string" },
      },
    });
  });

  it("lets doctor callers omit install, which defaults to report-only", () => {
    expect(schemas.doctor.params).toMatchObject({ required: ["cwd"], properties: { install: { type: "boolean" } } });
    expect(parseParams("doctor", { cwd: process.cwd() })).toEqual({ cwd: process.cwd(), install: false });
  });

  it("defaults asset.import to copying and job.list to every job", () => {
    const cwd = process.cwd();
    expect(parseParams("asset.import", { cwd, files: [cwd] })).toEqual({ cwd, files: [cwd], mode: "copy" });
    expect(parseParams("job.list", { cwd })).toEqual({ cwd, active: false });
    expect(() => parseParams("asset.import", { cwd, files: [] })).toThrow(/params\.files/);
    expect(() => parseParams("asset.import", { cwd, files: ["relative.mp4"] })).toThrow(/params\.files\.0/);
  });

  it("flags only connection plumbing as internal, so tool generators skip it", () => {
    const internal = Object.entries(schemas)
      .filter(([, schema]) => schema.internal)
      .map(([name]) => name);
    expect(internal).toEqual(["handshake", "session.tag", "events.subscribe", "events.unsubscribe"]);
  });
});

describe("parseParams", () => {
  it("returns validated params unchanged when valid", () => {
    const dir = process.cwd(); // Absolute on every platform.
    expect(parseParams("project.init", { dir, name: "Talk" })).toEqual({ dir, name: "Talk" });
  });

  it("throws InvalidParams listing every bad field with its path", () => {
    let caught: unknown;
    try {
      parseParams("project.init", { dir: 1, name: 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect(caught).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringMatching(/project\.init[\s\S]*params\.dir[\s\S]*params\.name/),
      data: { issues: [{ path: ["dir"] }, { path: ["name"] }] },
    });
  });
});

describe("idempotency keys", () => {
  const schemas = methodJsonSchemas();
  const mutating = Object.entries(schemas)
    .filter(([, schema]) => schema.mutating)
    .map(([name]) => name);

  it("flags every method that changes a project or daemon state, and no read", () => {
    expect(mutating).toEqual(
      expect.arrayContaining(["file.write", "clip.move", "clip.trim", "clip.split", "clip.remove", "cut", "revert", "tx.begin", "tx.commit", "tx.abort"]),
    );
    for (const read of ["status", "timeline.show", "track.list", "history", "asset.list", "job.list", "script.outline", "handshake"]) {
      expect(mutating).not.toContain(read);
    }
  });

  it("keeps the key out of tool schemas: it is transport plumbing, not an argument", () => {
    for (const name of mutating) expect(JSON.stringify(schemas[name as keyof typeof schemas].params)).not.toContain("idempotencyKey");
  });

  it("splits the key off a mutating method's params before validating them", () => {
    const cwd = process.cwd();
    expect(parseRequest("clip.remove", { cwd, clip: "c_1", idempotencyKey: "k-0123456789" })).toEqual({
      params: { cwd, timeline: "main", clip: "c_1" },
      idempotencyKey: "k-0123456789",
    });
    expect(parseRequest("clip.remove", { cwd, clip: "c_1" })).toEqual({ params: { cwd, timeline: "main", clip: "c_1" }, idempotencyKey: null });
  });

  it("refuses a malformed key, and a key on a method that reads", () => {
    const cwd = process.cwd();
    expect(() => parseRequest("clip.remove", { cwd, clip: "c_1", idempotencyKey: "" })).toThrow(/params\.idempotencyKey/);
    expect(() => parseRequest("timeline.show", { cwd, idempotencyKey: "k-0123456789" })).toThrow(RpcError);
  });
});
