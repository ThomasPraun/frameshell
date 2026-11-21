import { describe, expect, it } from "vitest";
import { strings } from "../src/shared/i18n/index.js";
import { handoffKindOf, handoffNotice } from "../src/renderer/src/handoff-notice.js";
import { HANDOFF_KINDS, HANDOFFS, isHandoffKind } from "../src/shared/handoff.js";

describe("handoffKindOf", () => {
  it("maps the two export commands to their file kind, and nothing else", () => {
    expect(handoffKindOf("exportOtio")).toBe("otio");
    expect(handoffKindOf("exportPremiere")).toBe("premiere");
    expect(handoffKindOf("imageFromFrame")).toBeUndefined();
    expect(handoffKindOf("toggleReview")).toBeUndefined();
  });
});

describe("handoffNotice", () => {
  it("OpenTimelineIO: names the file, with the count of what it leaves out only when there is something (the list is in Details, #749)", () => {
    const said = strings("en").workspace;
    expect(handoffNotice({ path: "C:\\p\\exports\\main.otio", warnings: [] }, "otio", said)).toBe("Exported main.otio.");
    expect(handoffNotice({ path: "/p/exports/main.otio", warnings: ["a"] }, "otio", said)).toBe(
      "Exported main.otio. 1 thing is not in the OpenTimelineIO file.",
    );
    expect(handoffNotice({ path: "/p/exports/main.otio", warnings: ["a", "b", "c"] }, "otio", said)).toBe(
      "Exported main.otio. 3 things are not in the OpenTimelineIO file.",
    );
  });

  it("OpenTimelineIO in Spanish", () => {
    const said = strings("es").workspace;
    expect(handoffNotice({ path: "/p/main.otio", warnings: [] }, "otio", said)).toBe("Se exportó main.otio.");
    expect(handoffNotice({ path: "/p/main.otio", warnings: ["a", "b"] }, "otio", said)).toBe(
      "Se exportó main.otio. Hay 2 cosas que no están en el archivo de OpenTimelineIO.",
    );
    expect(handoffNotice({ path: "/p/main.otio", warnings: ["a"] }, "otio", said)).toBe(
      "Se exportó main.otio. Hay 1 cosa que no está en el archivo de OpenTimelineIO.",
    );
  });

  it("Premiere XML names its own editor", () => {
    const en = strings("en").workspace;
    expect(handoffNotice({ path: "C:\\p\\exports\\main.xml", warnings: [] }, "premiere", en)).toBe("Exported main.xml.");
    expect(handoffNotice({ path: "/p/exports/main.xml", warnings: ["a", "b"] }, "premiere", en)).toBe(
      "Exported main.xml. 2 things are not in the Premiere file.",
    );
    const es = strings("es").workspace;
    expect(handoffNotice({ path: "/p/main.xml", warnings: [] }, "premiere", es)).toBe("Se exportó main.xml.");
    expect(handoffNotice({ path: "/p/main.xml", warnings: ["a"] }, "premiere", es)).toBe(
      "Se exportó main.xml. Hay 1 cosa que no está en el archivo de Premiere.",
    );
  });
});

describe("HANDOFFS", () => {
  it("gives every hand-off kind its own command, menu item id, extension and daemon method", () => {
    for (const kind of HANDOFF_KINDS) {
      const info = HANDOFFS[kind];
      expect(handoffKindOf(info.command)).toBe(kind);
      expect(info.menuId).toMatch(/^export-/);
      expect(info.extension).toMatch(/^[a-z]+$/);
      expect(info.method).toMatch(/^export./);
      expect(isHandoffKind(kind)).toBe(true);
    }
    for (const field of ["command", "menuId", "extension", "method", "cli"] as const) {
      expect(new Set(HANDOFF_KINDS.map((kind) => HANDOFFS[kind][field])).size).toBe(HANDOFF_KINDS.length);
    }
    expect(isHandoffKind("pdf")).toBe(false);
    expect(isHandoffKind(undefined)).toBe(false);
  });
});
