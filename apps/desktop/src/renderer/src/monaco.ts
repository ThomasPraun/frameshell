// Monaco wired for a sandboxed, offline renderer: local workers, app theme, project JSON Schemas.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import projectSchema from "@frameshell/schema/json-schema/project.json";
import timelineSchema from "@frameshell/schema/json-schema/timeline.json";

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

// Validate and complete frameshell.json and timelines as the user types, from the same Zod-generated schemas the daemon enforces.
monaco.json.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  enableSchemaRequest: false,
  schemas: [
    { uri: "https://frameshell.dev/schema/v1/project.json", fileMatch: ["**/frameshell.json"], schema: projectSchema },
    { uri: "https://frameshell.dev/schema/v1/timeline.json", fileMatch: ["**/timelines/*.json"], schema: timelineSchema },
  ],
});

monaco.editor.defineTheme("frameshell", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword.md", foreground: "e3a53c", fontStyle: "bold" },
    { token: "string.key.json", foreground: "9fb6d9" },
    { token: "string.value.json", foreground: "a9cfa4" },
    { token: "number.json", foreground: "e3a53c" },
  ],
  colors: {
    "editor.background": "#232427",
    "editor.lineHighlightBackground": "#2a2b2f",
    "editorLineNumber.foreground": "#56585d",
    "editorLineNumber.activeForeground": "#a9aaad",
    "editorCursor.foreground": "#e3a53c",
    "editor.selectionBackground": "#4a4436",
    "editorIndentGuide.background1": "#2f3034",
    "editorWidget.background": "#2b2c30",
    "editorGutter.background": "#232427",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff24",
  },
});

/** Media and binaries: no text editor for these. */
const BINARY = new Set(
  "mp4 mov mkv webm avi m4v wav mp3 aac m4a flac ogg opus png jpg jpeg gif webp avif ico psd pdf zip ttf otf woff woff2 bin".split(" "),
);

/**
 * Language id for a project-relative path; null = binary, not opened.
 * Only Markdown and JSON get language services (SPEC §11); other text opens
 * as plain text, so no TypeScript/CSS/HTML workers are bundled.
 */
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (BINARY.has(ext)) return null;
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json") return "json";
  return "plaintext";
}

export { monaco };
