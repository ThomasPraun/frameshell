import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { languageFor, monaco } from "../monaco.js";

/** One open file. `savedVersion` is Monaco's alternative version id at last load or save: differs = dirty. */
interface OpenDoc {
  model: monaco.editor.ITextModel | null;
  savedVersion: number;
  /** Set when the file changed on disk while it had unsaved edits, or vanished. */
  diskNotice: "changed" | "deleted" | null;
  error: string | null;
}

/** Editor tabs over one Monaco instance; one model per file keeps each tab's undo history. */
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
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [saveError, setSaveError] = useState<string | null>(null);
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
    editor.current = instance;
    const open = docs.current;
    return () => {
      onEdit.dispose();
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
    const doc: OpenDoc = { model: null, savedVersion: 0, diskNotice: null, error: null };
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
