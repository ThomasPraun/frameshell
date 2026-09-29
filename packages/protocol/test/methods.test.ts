import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError, methodJsonSchemas, methods, parseParams } from "../src/index.js";

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

  it("flags only connection plumbing as internal, so tool generators skip it", () => {
    const internal = Object.entries(schemas)
      .filter(([, schema]) => schema.internal)
      .map(([name]) => name);
    expect(internal).toEqual(["handshake"]);
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
