import { isScriptPath, parseScript } from "@frameshell/schema";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type SceneLink, type ScriptLinks, linkScenes } from "../../../shared/script-links.js";
import { askAgent } from "../ask/ask-agent.js";
import { t } from "../i18n.js";
import { languageFor, monaco } from "../monaco.js";
import { SELECTION_TIMELINE, selection, useSelection } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { windowOf } from "../windows.js";
import { DetachButton, DockedElsewhere } from "./DetachControls.js";
import { TRANSCRIPT_SHORTCUT, TRANSCRIPT_TAB, type TranscriptFocus, TranscriptView } from "./TranscriptView.js";

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
 * selects the clips linked to the whole script. "Ask agent" (Cmd/Ctrl+L or
 * the editor's context menu) in a script first selects the scene under the
 * caret; elsewhere it asks about the current selection.
 *
 * The {@link TRANSCRIPT_TAB} tab shows the transcript view instead of a file.
 *
 * The area can move to its own window (ADR 0012): while `detached`, it draws
 * into `target` (that window's root) and leaves a placeholder here. It stays
 * mounted here either way, so open files keep their unsaved edits, undo
 * history and caret; only the Monaco view is created again in the new window.
 */
export function EditorArea({
  tabs,
  active,
  onActivate,
  onClose,
  onOpenFile,
  transcriptFocus,
  detached,
  target,
  onDetach,
}: {
  tabs: string[];
  active: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  /** Open a project file (or {@link TRANSCRIPT_TAB}) in a tab. */
  onOpenFile: (path: string) => void;
  /** Transcript file to bring into view in the transcript tab. */
  transcriptFocus: TranscriptFocus | null;
  /** The area is in its own window. */
  detached: boolean;
  /** Root of the area's window while it is open; null otherwise. */
  target: HTMLElement | null;
  /** Move the area to its own window (`true`) or dock it back. */
  onDetach: (detached: boolean) => void;
}) {
  /** Where the Monaco view lives now: a new element, in the other window, after a move. */
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  /** Scroll and caret per file, kept while the view is created again elsewhere. */
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
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

  // One editor per host element: models outlive it, so a move to another window keeps every file.
  useEffect(() => {
    if (!host) return;
    const instance = monaco.editor.create(host, {
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
    const ask = instance.addAction({
      id: "frameshell.askAgent",
      label: t.workspace.askAgent,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: () => {
        const path = activeRef.current;
        const line = instance.getPosition()?.lineNumber;
        const script = path && line ? links.current.get(path) : undefined;
        // The scene holding the caret: the last heading at or above it.
        const scene = script && line ? script.scenes.filter((link) => link.line <= line).at(-1) : undefined;
        if (path && scene) selection.selectScene({ script: path, slug: scene.slug, title: scene.title }, scene.clips);
        askAgent.run();
      },
    });
    const onEdit = instance.onDidChangeModelContent(() => rerender());
    const onClick = instance.onMouseDown((event) => {
      const path = activeRef.current;
      const line = event.target.position?.lineNumber;
      const script = path && line ? links.current.get(path) : undefined;
      if (!path || !script || !line) return;
      const scene = script.scenes.find((link) => link.line === line);
      if (scene) selection.selectScene({ script: path, slug: scene.slug, title: scene.title }, scene.clips, { reveal: true });
      else if (line === 1 && script.wholeClips.length > 0 && event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        selection.selectClips(script.wholeClips, "script", { reveal: true });
      }
    });
    editor.current = instance;
    return () => {
      const path = activeRef.current;
      const state = instance.getModel() ? instance.saveViewState() : null;
      if (path && state) viewStates.current.set(path, state);
      ask.dispose();
      onEdit.dispose();
      onClick.dispose();
      instance.dispose();
      if (editor.current === instance) editor.current = null;
    };
  }, [host, save]);

  useEffect(() => {
    const open = docs.current;
    return () => {
      for (const doc of open.values()) doc.model?.dispose();
      open.clear();
    };
  }, []);

  // Load newly opened tabs, show the active one, drop closed ones.
  useEffect(() => {
    for (const [path, doc] of docs.current) {
      if (!tabs.includes(path)) {
        doc.model?.dispose();
        docs.current.delete(path);
        viewStates.current.delete(path);
      }
    }
    if (!active || active === TRANSCRIPT_TAB) {
      editor.current?.setModel(null);
      return;
    }
    const existing = docs.current.get(active);
    if (existing) {
      editor.current?.setModel(existing.model);
      // Once, right after a move: switching tabs starts each file at its top, as before.
      const state = viewStates.current.get(active);
      viewStates.current.delete(active);
      if (existing.model && state) editor.current?.restoreViewState(state);
      if (existing.model) editor.current?.focus();
      return;
    }
    const language = languageFor(active);
    const doc: OpenDoc = { model: null, savedVersion: 0, diskNotice: null, error: null, decorations: [] };
    docs.current.set(active, doc);
    if (!language) {
      doc.error = t.editor.noEditor;
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
  }, [tabs, active, host]);

  useEffect(() => {
    editor.current?.updateOptions({ glyphMargin: !!active && isScriptPath(active) });
  }, [active, host]);

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

  /** `view`: the window asking, which shows the confirmation. */
  const close = (path: string, view: Window) => {
    if (isDirty(docs.current.get(path)) && !view.confirm(t.editor.discard(path))) return;
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

  const body = (
    <div className="editor-area">
      <div className="tab-strip" role="tablist" aria-label={t.editor.openFiles}>
        {tabs.map((path) => {
          const dirty = isDirty(docs.current.get(path));
          return (
            <div
              key={path}
              role="tab"
              aria-selected={path === active}
              aria-label={path === TRANSCRIPT_TAB ? t.workspace.transcript : path}
              className={`file-tab${path === active ? " is-active" : ""}`}
              title={path}
              onMouseDown={(event) => {
                if (event.button === 1) close(path, windowOf(event.target));
              }}
              onClick={() => onActivate(path)}
            >
              <span className="file-tab-name">{path === TRANSCRIPT_TAB ? t.workspace.transcript : path.slice(path.lastIndexOf("/") + 1)}</span>
              <button
                className={`file-tab-close${dirty ? " is-dirty" : ""}`}
                aria-label={dirty ? t.editor.closeTabUnsaved(path) : t.editor.closeTab(path === TRANSCRIPT_TAB ? t.workspace.transcript : path)}
                onClick={(event) => {
                  event.stopPropagation();
                  close(path, windowOf(event.target));
                }}
              />
            </div>
          );
        })}
        {!tabs.includes(TRANSCRIPT_TAB) && (
          <button
            className="tab-strip-action"
            title={t.editor.showTranscript(TRANSCRIPT_SHORTCUT)}
            onClick={() => onOpenFile(TRANSCRIPT_TAB)}
          >
            {t.workspace.transcript}
          </button>
        )}
        <span className="tab-strip-actions">
          <DetachButton name={t.workspace.editor.toLowerCase()} detached={detached} onClick={() => onDetach(!detached)} testId="editor-detach" />
        </span>
      </div>

      {activeDoc?.diskNotice && active && (
        <div className="editor-notice" role="status">
          {activeDoc.diskNotice === "changed"
            ? t.editor.diskChanged
            : t.editor.diskDeleted}
          {activeDoc.diskNotice === "changed" && (
            <button className="link" onClick={() => reloadFromDisk(active)}>
              {t.editor.loadDisk}
            </button>
          )}
        </div>
      )}
      {saveError && (
        <div className="editor-notice is-error" role="alert">
          {t.editor.notSaved(saveError)}
        </div>
      )}

      <div className="editor-host" ref={setHost} hidden={!activeDoc?.model} />
      {active === TRANSCRIPT_TAB && <TranscriptView onOpenFile={onOpenFile} focus={transcriptFocus} />}
      {!active && (
        <div className="empty editor-empty">
          <p>{t.editor.emptyOpen(TRANSCRIPT_SHORTCUT)}</p>
          <p className="hint">{t.editor.emptyHint}</p>
        </div>
      )}
      {activeDoc?.error && <div className="empty editor-empty">{activeDoc.error}</div>}
    </div>
  );
  if (!detached) return body;
  return (
    <>
      <DockedElsewhere title={t.workspace.editor} onBringBack={() => onDetach(false)} />
      {target && createPortal(<div className="panel editor">{body}</div>, target)}
    </>
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
    const hover = t.editor.wholeScriptLinked(whole, script.wholeClips.join(", "));
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
      ? t.editor.sceneLinked(scene.slug, count, scene.clips.join(", "))
      : t.editor.sceneUnlinked(scene.slug);
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
