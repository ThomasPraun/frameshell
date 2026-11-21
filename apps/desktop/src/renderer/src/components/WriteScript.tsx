import { useState } from "react";
import { t } from "../i18n.js";
import { newShootScript } from "../teleprompter/model.js";
import { scriptFiles } from "../timeline/scenes.js";

/**
 * Write or paste a script where none exists yet (#737): saved through the daemon as a shoot script in `scripts/`, so
 * the teleprompter and the Shoot view pick it up at once. Shown in their empty states.
 */
export function WriteScript() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { path, content } = newShootScript(text, t.teleprompter.write.title, scriptFiles(await window.frameshell.files.tree()));
      await window.frameshell.files.write(path, content);
      setText("");
    } catch (failure) {
      setError(t.teleprompter.write.failed((failure as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="write-script" data-testid="write-script">
      <textarea
        className="write-script-text"
        aria-label={t.teleprompter.write.label}
        placeholder={t.teleprompter.write.placeholder}
        value={text}
        rows={6}
        onChange={(event) => setText(event.target.value)}
      />
      <button className="button primary" disabled={saving || text.trim() === ""} onClick={() => void save()} data-testid="write-script-save">
        {t.teleprompter.write.save}
      </button>
      {error && (
        <p className="write-script-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
