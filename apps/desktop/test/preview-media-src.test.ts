import { expect, it } from "vitest";
import { mediaSrc } from "../src/renderer/src/preview/media-src.js";

it("encodes each path segment and keeps the separators", () => {
  expect(mediaSrc("frameshell-media://p/", "a b/c#d/é.mp4")).toBe("frameshell-media://p/a%20b/c%23d/%C3%A9.mp4");
});
