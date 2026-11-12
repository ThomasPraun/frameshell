import { useEffect, useRef, useState } from "react";
import { BUILTIN_FORMAT_IDS } from "@frameshell/schema";
import type { IdeaBrief, IdeaProjectPlan } from "../../../shared/api.js";
import { IDEA_LENGTHS } from "../idea.js";
import { t } from "../i18n.js";

/** Value of the length menu for "not sure". */
const UNKNOWN = "";

/**
 * Brief of a video made from an idea, with no footage (#472): name, formats, rough length and an optional web page.
 * The folder is planned by main (the videos folder unless changed); the project is created by the caller.
 */
export function NewFromIdea({
  busy,
  onError,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onError: (message: string | null) => void;
  onCancel: () => void;
  /** `parent` is the folder the person picked, undefined for the default. */
  onCreate: (brief: IdeaBrief, parent: string | undefined) => void;
}) {
  const [name, setName] = useState("");
  const [formats, setFormats] = useState<string[]>(["16x9"]);
  const [length, setLength] = useState(UNKNOWN);
  const [url, setUrl] = useState("");
  const [plan, setPlan] = useState<IdeaProjectPlan | null>(null);
  const [parent, setParent] = useState<string | undefined>(undefined);
  // Replans only for the latest edit: a slow answer for an older name must not overwrite a newer one.
  const latest = useRef(0);

  const replan = async (place: { parent?: string; name?: string }) => {
    const ticket = ++latest.current;
    try {
      const next = await window.frameshell.project.planIdea({ ...(parent && { parent }), name, ...place });
      if (ticket === latest.current) setPlan(next);
    } catch (failure) {
      if (ticket === latest.current) onError((failure as Error).message);
    }
  };
  // Once: the default folder.
  useEffect(() => {
    void replan({});
  }, []);

  const changeParent = async () => {
    const chosen = await window.frameshell.project.chooseParent();
    if (!chosen) return;
    setParent(chosen);
    await replan({ parent: chosen });
  };

  const toggle = (id: string, on: boolean) => setFormats((now) => (on ? [...now, id] : now.filter((other) => other !== id)));

  const submit = () => {
    const bad = name.trim() === "" ? t.welcome.ideaNeedName : formats.length === 0 ? t.welcome.ideaNeedFormat : badUrl(url);
    if (bad) {
      onError(bad);
      return;
    }
    onError(null);
    onCreate({ name, formats, seconds: length === UNKNOWN ? null : Number(length), url: url.trim() === "" ? null : url.trim() }, parent);
  };

  return (
    <form
      className="welcome-new"
      aria-label={t.welcome.ideaForm}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="welcome-hint">{t.welcome.ideaLede}</p>
      <label className="welcome-field">
        <span>{t.welcome.ideaName}</span>
        <input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} onBlur={() => void replan({ name })} spellCheck={false} autoFocus />
      </label>
      <div className="welcome-field">
        <span>{t.welcome.folder}</span>
        <div className="welcome-place">
          <code title={plan?.dir}>
            <bdi dir="ltr">{plan?.dir ?? ""}</bdi>
          </code>
          <button type="button" className="link" disabled={busy} onClick={() => void changeParent()}>
            {t.welcome.change}
          </button>
        </div>
      </div>
      <fieldset className="welcome-mode">
        <legend>{t.welcome.formatsLegend}</legend>
        {BUILTIN_FORMAT_IDS.map((id) => (
          <label key={id}>
            <input type="checkbox" checked={formats.includes(id)} disabled={busy} onChange={(event) => toggle(id, event.target.checked)} />
            {t.welcome.formatLabels[id] ?? id}
          </label>
        ))}
        <p className="welcome-hint">{t.welcome.formatsHint}</p>
      </fieldset>
      <label className="welcome-field">
        <span>{t.welcome.ideaLength}</span>
        <select value={length} disabled={busy} onChange={(event) => setLength(event.target.value)}>
          <option value={UNKNOWN}>{t.welcome.lengthUnknown}</option>
          {IDEA_LENGTHS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {t.welcome.durationLabel(seconds)}
            </option>
          ))}
        </select>
      </label>
      <label className="welcome-field">
        <span>{t.welcome.ideaUrl}</span>
        <input value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} placeholder="https://" spellCheck={false} />
        <small className="welcome-hint">{t.welcome.ideaUrlHint}</small>
      </label>
      <div className="welcome-actions">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? t.welcome.creating : t.welcome.createProject}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          {t.welcome.cancel}
        </button>
      </div>
    </form>
  );
}

/** A message when `text` is filled in and is not an http(s) address; null otherwise. Main checks again. */
function badUrl(text: string): string | null {
  if (text.trim() === "") return null;
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? null : t.welcome.ideaBadUrl;
  } catch {
    return t.welcome.ideaBadUrl;
  }
}
