import { parseScript } from "@frameshell/schema";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type SceneLink, type ScriptLinks, isScriptPath, linkScenes } from "../../../shared/script-links.js";
import { languageFor, monaco } from "../monaco.js";
import { SELECTION_TIMELINE, selection, useSelection } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";

/** One open file. `savedVersion` is Monaco's alternative version id at last load or save: differs = dirty. */
interface OpenDoc {
  model: monaco.editor.ITextModel | null;
  savedVersion: number;
  /** Set when the file changed on disk while it had unsaved edits, or vanished. */
  diskNotice: "changed" | "deleted" | null;
  error: string | null;
  /** Scene and whole-script decoration ids on `model` (scripts only). */
  decorations: string[];
}

/**
 * Editor tabs over one Monaco instance; one model per file keeps each tab's
 * undo history. Scripts (`scripts/**.md`) link scenes and clips of the
 * timeline panel's timeline both ways: the gutter flags each `##` scene as
 * linked or not, the scene of a selected clip is highlighted (the whole
 * script for a clip whose `scriptRef` has no `#anchor`), clicking a scene
 * heading selects its clips, and clicking the whole-script flag on line 1
 * selects the clips linked to the whole script.
 */
export function EditorArea({
  tabs,
  active,
  onActivate,
  onClose,
}: {
  tabs: string[];
  active: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const docs = useRef(new Map<string, OpenDoc>());
  const activeRef = useRef(active);
  const [edits, rerender] = useReducer((n: number) => n + 1, 0);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Scene links per open script path, as last decorated. */
  const links = useRef(new Map<string, ScriptLinks>());
  const { view: timeline } = useTimelineView(SELECTION_TIMELINE);
  const { clips: selected } = useSelection();
  activeRef.current = active;

  const isDirty = (doc: OpenDoc | undefined) => !!doc?.model && doc.model.getAlternativeVersionId() !== doc.savedVersion;

  const save = useCallback(async () => {
    const path = activeRef.current;
    const doc = path ? docs.current.get(path) : undefined;
    if (!path || !doc?.model) return;
    const version = doc.model.getAlternativeVersionId();
    try {
      await window.frameshell.files.write(path, doc.model.getValue());
      doc.savedVersion = version;
      doc.diskNotice = null;
      setSaveError(null);
    } catch (error) {
      setSaveError((error as Error).message);
    }
    rerender();
  }, []);

  // One editor for the component's lifetime.
  useEffect(() => {
    if (!host.current) return;
    const instance = monaco.editor.create(host.current, {
      theme: "frameshell",
      automaticLayout: true,
      fontFamily: '"JetBrains Mono Variable", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      wordWrap: "on",
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      padding: { top: 10 },
      model: null,
    });
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    const onEdit = instance.onDidChangeModelContent(() => rerender());
    const onClick = instance.onMouseDown((event) => {
      const path = activeRef.current;
      const line = event.target.position?.lineNumber;
      const script = path && line ? links.current.get(path) : undefined;
      if (!script || !line) return;
      const scene = script.scenes.find((link) => link.line === line);
      if (scene) selection.selectClips(scene.clips);
      else if (line === 1 && script.wholeClips.length > 0 && event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        selection.selectClips(script.wholeClips);
      }
    });
    editor.current = instance;
    const open = docs.current;
    return () => {
      onEdit.dispose();
      onClick.dispose();
      instance.dispose();
      for (const doc of open.values()) doc.model?.dispose();
      open.clear();
    };
  }, [save]);

  // Load newly opened tabs, show the active one, drop closed ones.
  useEffect(() => {
    for (const [path, doc] of docs.current) {
      if (!tabs.includes(path)) {
        doc.model?.dispose();
        docs.current.delete(path);
      }
    }
    if (!active) {
      editor.current?.setModel(null);
      return;
    }
    const existing = docs.current.get(active);
    if (existing) {
      editor.current?.setModel(existing.model);
      if (existing.model) editor.current?.focus();
      return;
    }
    const language = languageFor(active);
    const doc: OpenDoc = { model: null, savedVersion: 0, diskNotice: null, error: null, decorations: [] };
    docs.current.set(active, doc);
    if (!language) {
      doc.error = "This file type has no editor. Media plays in the preview.";
      editor.current?.setModel(null);
      rerender();
      return;
    }
    const path = active;
    window.frameshell.files.read(path).then(
      (content) => {
        if (docs.current.get(path) !== doc) return; // Closed while loading.
        doc.model = monaco.editor.createModel(content, language, monaco.Uri.file(`/${path}`));
        doc.savedVersion = doc.model.getAlternativeVersionId();
        if (activeRef.current === path) {
          editor.current?.setModel(doc.model);
          editor.current?.focus();
        }
        rerender();
      },
      (error: Error) => {
        doc.error = error.message;
        rerender();
      },
    );
  }, [tabs, active]);

  useEffect(() => {
    editor.current?.updateOptions({ glyphMargin: !!active && isScriptPath(active) });
  }, [active]);

  // Scene links follow script edits, timeline changes and the selection.
  useEffect(() => {
    const clips = (timeline?.tracks ?? []).flatMap((track) =>
      track.clips.map((clip) => ({ id: clip.id, scriptRef: typeof clip["scriptRef"] === "string" ? clip["scriptRef"] : undefined })),
    );
    links.current.clear();
    for (const [path, doc] of docs.current) {
      if (!doc.model || !isScriptPath(path)) continue;
      const script = linkScenes(path, parseScript(doc.model.getValue()).scenes, clips, selected);
      links.current.set(path, script);
      doc.decorations = doc.model.deltaDecorations(doc.decorations, scriptDecorations(script, doc.model.getLineCount()));
    }
  }, [timeline, selected, edits, tabs]);

  // Bring the selected clip's scene into view when the selection changes.
  useEffect(() => {
    const path = activeRef.current;
    const script = path ? links.current.get(path) : undefined;
    const scene = script?.scenes.find((link) => link.selected);
    if (scene) editor.current?.revealLineInCenterIfOutsideViewport(scene.line);
    else if (script?.wholeSelected) editor.current?.revealLineInCenterIfOutsideViewport(1);
  }, [selected]);

  // Files change under the editor when the agent writes them: reload clean tabs, flag dirty ones.
  useEffect(
    () =>
      window.frameshell.files.onChanged((paths) => {
        for (const path of paths) {
          const doc = docs.current.get(path);
          if (!doc?.model) continue;
          window.frameshell.files.read(path).then(
            (content) => {
              if (!doc.model || doc.model.getValue() === content) return;
              if (isDirty(doc)) {
                doc.diskNotice = "changed";
              } else {
                doc.model.setValue(content);
                doc.savedVersion = doc.model.getAlternativeVersionId();
              }
              rerender();
            },
            () => {
              doc.diskNotice = "deleted";
              rerender();
            },
          );
        }
      }),
    [],
  );

  const close = (path: string) => {
    if (isDirty(docs.current.get(path)) && !window.confirm(`Discard unsaved changes to ${path}?`)) return;
    onClose(path);
  };

  const reloadFromDisk = (path: string) => {
    const doc = docs.current.get(path);
    if (!doc?.model) return;
    void window.frameshell.files.read(path).then((content) => {
      doc.model?.setValue(content);
      doc.savedVersion = doc.model?.getAlternativeVersionId() ?? 0;
      doc.diskNotice = null;
      rerender();
    });
  };

  const activeDoc = active ? docs.current.get(active) : undefined;

  return (
    <div className="editor-area">
      <div className="tab-strip" role="tablist" aria-label="Open files">
        {tabs.map((path) => {
          const dirty = isDirty(docs.current.get(path));
          return (
            <div
              key={path}
              role="tab"
              aria-selected={path === active}
              aria-label={path}
              className={`file-tab${path === active ? " is-active" : ""}`}
              title={path}
              onMouseDown={(event) => {
                if (event.button === 1) close(path);
              }}
              onClick={() => onActivate(path)}
            >
              <span className="file-tab-name">{path.slice(path.lastIndexOf("/") + 1)}</span>
              <button
                className={`file-tab-close${dirty ? " is-dirty" : ""}`}
                aria-label={dirty ? `Close ${path} (unsaved)` : `Close ${path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  close(path);
                }}
              />
            </div>
          );
        })}
      </div>

      {activeDoc?.diskNotice && active && (
        <div className="editor-notice" role="status">
          {activeDoc.diskNotice === "changed"
            ? "This file changed on disk while you were editing."
            : "This file was deleted on disk. Saving recreates it."}
          {activeDoc.diskNotice === "changed" && (
            <button className="link" onClick={() => reloadFromDisk(active)}>
              Load disk version
            </button>
          )}
        </div>
      )}
      {saveError && (
        <div className="editor-notice is-error" role="alert">
          Not saved: {saveError}
        </div>
      )}

      <div className="editor-host" ref={host} hidden={!activeDoc?.model} />
      {!active && (
        <div className="empty editor-empty">
          <p>Open a script or JSON file from the explorer.</p>
          <p className="hint">Saved files go through frameshelld, so the agent sees your edits right away.</p>
        </div>
      )}
      {activeDoc?.error && <div className="empty editor-empty">{activeDoc.error}</div>}
    </div>
  );
}

/**
 * Decorations of one linked script: a gutter flag per scene heading, the
 * selected scenes highlighted, or every line when a clip linked to the
 * whole script is selected; a flag on line 1 when such clips exist.
 */
function scriptDecorations(script: ScriptLinks, lineCount: number): monaco.editor.IModelDeltaDecoration[] {
  const whole = script.wholeClips.length;
  const decorations = script.scenes.flatMap((scene) => sceneDecorations(scene, script.wholeSelected));
  if (whole > 0) {
    const hover = `${whole} clip${whole === 1 ? "" : "s"} linked to the whole script (${script.wholeClips.join(", ")}). Click to select ${whole === 1 ? "it" : "them"}.`;
    decorations.push({
      range: new monaco.Range(1, 1, 1, 1),
      options: { glyphMarginClassName: "script-glyph-linked", glyphMarginHoverMessage: { value: hover } },
    });
  }
  if (script.wholeSelected) {
    decorations.push({ range: new monaco.Range(1, 1, lineCount, 1), options: { isWholeLine: true, className: "script-selected" } });
  }
  return decorations;
}

/** Gutter flag on a scene heading; highlight over a scene holding a selected clip, or every heading while the whole script is. */
function sceneDecorations(scene: SceneLink, wholeSelected: boolean): monaco.editor.IModelDeltaDecoration[] {
  const count = scene.clips.length;
  const hover =
    count > 0
      ? `Scene \`#${scene.slug}\`: ${count} clip${count === 1 ? "" : "s"} (${scene.clips.join(", ")}). Click the heading to select ${count === 1 ? "it" : "them"}.`
      : `Scene \`#${scene.slug}\` has no clips yet. Link one with \`frameshell clip set <clip> --script-ref <script>#${scene.slug}\`.`;
  const heading: monaco.editor.IModelDeltaDecoration = {
    range: new monaco.Range(scene.line, 1, scene.line, 1),
    options: {
      isWholeLine: true,
      glyphMarginClassName: count > 0 ? "scene-glyph-linked" : "scene-glyph-unlinked",
      glyphMarginHoverMessage: { value: hover },
      ...(scene.selected || wholeSelected ? { className: "scene-heading-selected" } : {}),
    },
  };
  if (!scene.selected || scene.endLine <= scene.line) return [heading];
  return [
    heading,
    { range: new monaco.Range(scene.line + 1, 1, scene.endLine, 1), options: { isWholeLine: true, className: "scene-selected" } },
  ];
}
