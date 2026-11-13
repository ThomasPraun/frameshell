import { describe, expect, it } from "vitest";
import {
  BUNDLED_CAPTION_FONT,
  type CaptionFont,
  SUBTITLE_FONT,
  SUBTITLE_PRESETS,
  type StyleFile,
  captionFontSource,
  captionTokens,
  resolveStyle,
  resolveSubtitleStyle,
  scaledCaptions,
  styleCaptionTokens,
  styleTokenCss,
  subtitleLayout,
} from "../src/index.js";

const file = (fields: Omit<StyleFile, "schemaVersion">): StyleFile => ({ schemaVersion: 1, ...fields });
const brand = resolveStyle(file({ colors: { ink: "#F5F5F0", bg: "#0B1020cc", accent: "#ff5a1f" }, type: { caption: 54 } }));
const brandFont: CaptionFont = { family: "Brand Sans", file: "assets/fonts/Brand.ttf", ascent: 0.9, descent: 0.25 };

describe("captions take the project style as their base (ADR 0028 decision 11)", () => {
  it("maps ink, bg, accent and type.caption onto the preset fields, alpha dropped", () => {
    expect(captionTokens(brand)).toEqual({
      values: { color: "#f5f5f0", outlineColor: "#0b1020", keywordColor: "#ff5a1f", highlight: "#ff5a1f", size: 0.05 },
      font: BUNDLED_CAPTION_FONT,
      paths: { color: "colors.ink", outlineColor: "colors.bg", keywordColor: "colors.accent", highlight: "colors.accent", size: "type.caption" },
    });
    const own = resolveStyle(file({ colors: { accent: "#ff5a1f", keyword: "#00ff00", highlight: "#0000ff" } }));
    expect(captionTokens(own).values).toEqual({ keywordColor: "#00ff00", highlight: "#0000ff" });
  });

  it("sets nothing for a style without caption values, so the preset looks as before", () => {
    const tokens = captionTokens(resolveStyle(file({ brand: { product: "Acme" } })));
    expect(tokens.values).toEqual({});
    expect(resolveSubtitleStyle(undefined, tokens).style).toEqual(resolveSubtitleStyle(undefined).style);
    expect(resolveSubtitleStyle(undefined).style).toMatchObject({ font: BUNDLED_CAPTION_FONT, styled: [] });
  });

  it("drops both marks under motion.highlight false (calm), whatever the colours say", () => {
    const calm = captionTokens(resolveStyle(file({ colors: { accent: "#ff5a1f" }, motion: { personality: "calm" } })));
    expect(calm.values).toMatchObject({ highlight: null, keywordColor: null });
    expect(calm.paths).toMatchObject({ highlight: "motion.highlight", keywordColor: "motion.highlight" });
  });

  it("layers the most specific last: default preset, style, named preset, the track's own fields", () => {
    const tokens = captionTokens(brand, brandFont);
    const unnamed = resolveSubtitleStyle({ position: "top" }, tokens).style;
    expect(unnamed).toMatchObject({ preset: "big-keyword", color: "#f5f5f0", outlineColor: "#0b1020", highlight: "#ff5a1f", size: 0.05, position: "top" });
    expect(unnamed.maxWords).toBe(SUBTITLE_PRESETS["big-keyword"].maxWords);
    expect(unnamed.styled).toEqual(["colors.ink", "colors.bg", "colors.accent", "type.caption", "fonts.captions"]);
    // A named preset wins over the style's values; the face stays the style's.
    const named = resolveSubtitleStyle({ preset: "plain" }, tokens).style;
    expect(named).toMatchObject({ ...SUBTITLE_PRESETS.plain, font: brandFont, styled: ["fonts.captions"] });
    // The track's own keyword colour wins over the style's.
    const own = resolveSubtitleStyle({ keywordColor: "#123456" }, tokens).style;
    expect(own).toMatchObject({ keywordColor: "#123456", highlight: "#ff5a1f" });
    const keyword = captionTokens(resolveStyle(file({ colors: { keyword: "#00ff00" } })));
    expect(resolveSubtitleStyle({ keywordColor: "#123456" }, keyword).style.styled).toEqual([]);
    // An unknown preset counts as none: the style applies.
    expect(resolveSubtitleStyle({ preset: "neon" }, tokens)).toMatchObject({ style: { color: "#f5f5f0" }, unknownPreset: "neon" });
  });

  it("scales the style's size per format like a preset's (the format wins last)", () => {
    const style = resolveSubtitleStyle(undefined, captionTokens(brand)).style;
    const [scaled] = scaledCaptions([{ style }], { cover: true, captionScale: 1.3 });
    expect(scaled!.style.size).toBeCloseTo(0.065, 6);
  });

  it("lays lines out on the face's own ascent and descent", () => {
    const frame = { width: 1920, height: 1080 };
    const bundled = subtitleLayout(resolveSubtitleStyle(undefined).style, frame);
    const brandStyle = resolveSubtitleStyle(undefined, captionTokens(resolveStyle(file({})), brandFont)).style;
    const layout = subtitleLayout(brandStyle, frame);
    expect(layout.fontSize).toBe(bundled.fontSize);
    expect(layout.baseline).toBeCloseTo(frame.height - 0.12 * frame.height - layout.fontSize * 0.25, 1);
    expect(bundled.baseline).toBeCloseTo(frame.height - 0.12 * frame.height - bundled.fontSize * SUBTITLE_FONT.descent, 1);
  });
});

describe("the caption face of a style", () => {
  it("is a project .ttf or .otf file, the bundled face named on purpose, or the bundled one with a problem", () => {
    expect(captionFontSource(null)).toEqual({ file: null, problem: null });
    expect(captionFontSource({ family: "Brand", file: "assets/fonts/Brand.otf" })).toEqual({ file: "assets/fonts/Brand.otf" });
    expect(captionFontSource({ family: "archivo black" })).toEqual({ file: null, problem: null });
    expect(captionFontSource({ family: "Inter" })).toMatchObject({ file: null, problem: expect.stringContaining("Import the font into assets/fonts/") });
    expect(captionFontSource({ family: "Brand", file: "assets/fonts/Brand.woff2" })).toMatchObject({ file: null, problem: expect.stringContaining("not a .ttf or .otf") });
  });

  it("takes the family and metrics the file holds, and falls back with a warning when it cannot be read", async () => {
    const style = resolveStyle(file({ fonts: { captions: { family: "Brand", file: "assets/fonts/Brand.ttf" } } }));
    const read = await styleCaptionTokens(style, async () => ({ family: "Brand Sans", ascent: 0.9, descent: 0.25 }));
    expect(read).toEqual({ tokens: expect.objectContaining({ font: brandFont, paths: { font: "fonts.captions" } }), warning: null });
    const unnamed = await styleCaptionTokens(style, async () => ({ family: null, ascent: 0.9, descent: 0.25 }));
    expect(unnamed.tokens.font.family).toBe("Brand");
    const missing = await styleCaptionTokens(style, async () => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    });
    expect(missing.tokens.font).toEqual(BUNDLED_CAPTION_FONT);
    expect(missing.tokens.paths).not.toHaveProperty("font");
    expect(missing.warning).toBe(`fonts.captions.file assets/fonts/Brand.ttf cannot be used (it does not exist): captions use ${SUBTITLE_FONT.family}.`);
  });

  it("falls back with a warning for a family name an ASS style cannot hold as is", async () => {
    const style = resolveStyle(file({ fonts: { captions: { family: "Brand", file: "assets/fonts/Brand.ttf" } } }));
    const comma = await styleCaptionTokens(style, async () => ({ family: "Brand, Sans", ascent: 0.9, descent: 0.25 }));
    expect(comma.tokens.font).toEqual(BUNDLED_CAPTION_FONT);
    expect(comma.warning).toContain("holds a comma, quote or backslash");
  });
});

describe("style token sheet of generated clips (ADR 0028)", () => {
  it("writes the set colours, named fonts, type sizes and motion values as :root variables", () => {
    const css = styleTokenCss(
      resolveStyle(file({ colors: { accent: "#FF5A1F" }, fonts: { display: { family: 'Brand "Display"', weight: 800, tracking: -0.02 } }, motion: { personality: "premium" } })),
    );
    expect(css).toContain("  --fs-color-accent: #ff5a1f;\n");
    expect(css).not.toContain("--fs-color-ink");
    expect(css).toContain('  --fs-font-display: "Brand Display", system-ui, sans-serif;\n  --fs-font-display-weight: 800;\n  --fs-font-display-tracking: -0.02em;\n');
    expect(css).toContain("  --fs-type-hero: 200px;\n");
    expect(css).not.toContain("--fs-type-caption");
    expect(css).toContain("  --fs-motion-personality: premium;\n  --fs-motion-quick: 0.35s;\n  --fs-motion-standard: 0.5s;\n  --fs-motion-slow: 0.8s;\n");
    expect(css).toMatch(/--fs-motion-ease: cubic-bezier\([\d., -]+\);/);
    expect(css).toContain("  --fs-motion-highlight: 1;\n");
    expect(css).not.toContain("@font-face");
  });

  it("embeds each font file it has bytes for once, as data, and is the same text for the same input", () => {
    const style = resolveStyle(
      file({ fonts: { display: { family: "Brand", file: "assets/fonts/Brand.woff2" }, ui: { family: "Brand", file: "assets/fonts/Brand.woff2" }, captions: { family: "Gone", file: "assets/fonts/Gone.ttf" } } }),
    );
    const css = styleTokenCss(style, [{ file: "assets/fonts/Brand.woff2", base64: "AAEC" }]);
    expect(css.match(/@font-face/g)).toHaveLength(1);
    expect(css).toContain('@font-face { font-family: "Brand"; src: url("data:font/woff2;base64,AAEC") format("woff2"); }');
    expect(styleTokenCss(style, [{ file: "assets/fonts/Brand.woff2", base64: "AAEC" }])).toBe(css);
  });
});
