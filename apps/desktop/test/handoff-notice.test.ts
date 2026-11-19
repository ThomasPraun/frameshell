import { describe, expect, it } from "vitest";
import { strings } from "../src/shared/i18n/index.js";
import { handoffKindOf, handoffNotice } from "../src/renderer/src/handoff-notice.js";

describe("handoffKindOf", () => {
  it("maps the two export commands to their file kind, and nothing else", () => {
    expect(handoffKindOf("exportOtio")).toBe("otio");
    expect(handoffKindOf("exportPremiere")).toBe("premiere");
    expect(handoffKindOf("imageFromFrame")).toBeUndefined();
    expect(handoffKindOf("toggleReview")).toBeUndefined();
  });
});

describe("handoffNotice", () => {
  it("OpenTimelineIO: names the file, with the count of what it leaves out only when there is something", () => {
    const said = strings("en").workspace;
    expect(handoffNotice({ path: "C:\\p\\exports\\main.otio", warnings: [] }, "otio", said)).toBe("Exported main.otio.");
    expect(handoffNotice({ path: "/p/exports/main.otio", warnings: ["a"] }, "otio", said)).toBe(
      "Exported main.otio. 1 thing is not in the file: run frameshell export otio --out <file>.otio in a terminal to list it.",
    );
    expect(handoffNotice({ path: "/p/exports/main.otio", warnings: ["a", "b", "c"] }, "otio", said)).toBe(
      "Exported main.otio. 3 things are not in the file: run frameshell export otio --out <file>.otio in a terminal to list them.",
    );
  });

  it("OpenTimelineIO in Spanish", () => {
    const said = strings("es").workspace;
    expect(handoffNotice({ path: "/p/main.otio", warnings: [] }, "otio", said)).toBe("Se exportó main.otio.");
    expect(handoffNotice({ path: "/p/main.otio", warnings: ["a", "b"] }, "otio", said)).toBe(
      "Se exportó main.otio. Hay 2 cosas que no están en el archivo: ejecuta frameshell export otio --out <archivo>.otio en una terminal para verlas.",
    );
    expect(handoffNotice({ path: "/p/main.otio", warnings: ["a"] }, "otio", said)).toBe(
      "Se exportó main.otio. Hay 1 cosa que no está en el archivo: ejecuta frameshell export otio --out <archivo>.otio en una terminal para verla.",
    );
  });

  it("Premiere XML names its own command", () => {
    const en = strings("en").workspace;
    expect(handoffNotice({ path: "C:\\p\\exports\\main.xml", warnings: [] }, "premiere", en)).toBe("Exported main.xml.");
    expect(handoffNotice({ path: "/p/exports/main.xml", warnings: ["a", "b"] }, "premiere", en)).toBe(
      "Exported main.xml. 2 things are not in the file: run frameshell export premiere --out <file>.xml in a terminal to list them.",
    );
    const es = strings("es").workspace;
    expect(handoffNotice({ path: "/p/main.xml", warnings: [] }, "premiere", es)).toBe("Se exportó main.xml.");
    expect(handoffNotice({ path: "/p/main.xml", warnings: ["a"] }, "premiere", es)).toBe(
      "Se exportó main.xml. Hay 1 cosa que no está en el archivo: ejecuta frameshell export premiere --out <archivo>.xml en una terminal para verla.",
    );
  });
});
