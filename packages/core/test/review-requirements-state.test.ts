import { describe, expect, it } from "vitest";
import { requirementsFromState } from "../src/review/requirements-doc.js";

describe("requirementsFromState", () => {
  it("is no file and no error for an empty state", () => {
    expect(requirementsFromState({})).toEqual({ file: null });
  });

  it("is the file a valid state stands for", () => {
    const found = requirementsFromState({ "requirements:film.maxSeconds": 30 });
    expect(found.error).toBeUndefined();
    expect(found.file?.film.maxSeconds).toBe(30);
  });

  it("names the schema's complaint when no valid file holds the state", () => {
    const found = requirementsFromState({ "requirements:fail": ["no-such-check"] });
    expect(found.file).toBeNull();
    expect(found.error).toMatch(/fail/);
  });
});
