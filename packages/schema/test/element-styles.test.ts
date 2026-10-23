import { describe, expect, it } from "vitest";
import { AdapterClipSchema, elementStyles } from "../src/index.js";

describe("elementStyles", () => {
  it("is empty without adjustments", () => {
    expect(elementStyles(undefined)).toBe("");
    expect(elementStyles({})).toBe("");
    expect(elementStyles({ "#a": {}, "#b": { x: 0, scale: 1 } })).toBe("");
  });

  it("writes separate translate and scale with !important, sorted by selector", () => {
    expect(elementStyles({ "#title": { y: -40, scale: 1.2 }, "#logo": { x: 12.5 }, ".b": { scale: 2 } })).toBe(
      [
        "#logo { translate: 12.5px 0px !important; }",
        "#title { translate: 0px -40px !important; scale: 1.2 !important; }",
        ".b { scale: 2 !important; }",
      ].join("\n"),
    );
  });

  it.each(["a { color: red }", "a;b", "a</style>", "a /* x */", "  "])("refuses selector %j", (selector) => {
    expect(() => elementStyles({ [selector]: { x: 1 } })).toThrow(/selector/);
  });

  it("refuses non-finite numbers and a non-positive scale", () => {
    expect(() => elementStyles({ "#a": { x: Number.NaN } })).toThrow(/finite/);
    expect(() => elementStyles({ "#a": { scale: 0 } })).toThrow(/scale/);
  });
});

describe("AdapterClipSchema elements", () => {
  const clip = { id: "c_1", type: "hyperframes", start: 0, duration: 5 };

  it("is optional and checks the shape", () => {
    expect(AdapterClipSchema.safeParse(clip).success).toBe(true);
    expect(AdapterClipSchema.safeParse({ ...clip, elements: { "#t": { y: -40, scale: 1.2 } } }).success).toBe(true);
    expect(AdapterClipSchema.safeParse({ ...clip, elements: { "#t": { scale: -1 } } }).success).toBe(false);
    expect(AdapterClipSchema.safeParse({ ...clip, elements: { "#t": { rotate: 3 } } }).success).toBe(false);
  });
});
