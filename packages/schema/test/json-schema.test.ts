import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateJsonSchemas } from "../src/index.js";

const committed = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`../json-schema/${file}`, import.meta.url), "utf8"));

describe("published JSON Schema", () => {
  it("is generated for project and timeline files", () => {
    expect(Object.keys(generateJsonSchemas()).sort()).toEqual(["project.json", "timeline.json"]);
  });

  it("carries the $id that project files reference in $schema", () => {
    const project = generateJsonSchemas()["project.json"] as { $id: string; required: string[] };
    expect(project.$id).toBe("https://frameshell.dev/schema/v1/project.json");
    expect(project.required).toContain("schemaVersion");
  });

  it("matches the committed files (run `pnpm gen:json-schema` after changing a Zod model)", () => {
    for (const [file, schema] of Object.entries(generateJsonSchemas())) {
      expect(committed(file), file).toEqual(schema);
    }
  });
});
