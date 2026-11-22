import { useEffect, useRef, useState } from "react";
import { BUILTIN_FORMAT_IDS } from "@frameshell/schema";
import type { IdeaBrief, IdeaProjectPlan } from "../../../shared/api.js";
import { withScheme } from "../../../shared/web-address.js";
import { IDEA_LENGTHS } from "../idea.js";
import { t } from "../i18n.js";
import { systemErrorText } from "../system-error.js";

/** Value of the length menu for "not sure". */
const UNKNOWN = "";

/** What the form holds, kept across Cancel while the window lives (#752: Cancel threw the draft away). */
interface Draft {
  name: string;
  about: string;
  formats: string[];
  main: string;
  length: string;
  url: string;
}

const EMPTY_DRAFT: Draft = { name: "", about: "", formats: ["16x9"], main: "16x9", length: UNKNOWN, url: "" };
let draft: Draft = EMPTY_DRAFT;

/** How long typing in the name waits before the folder is planned again, ms. */
const REPLAN_MS = 300;

/**
 * Brief of a video made from an idea, with no footage: name, what it is about, formats, rough length and an optional
 * web page. The folder is planned by main (the videos folder unless changed) as the name is typed; the project is
 * created by the caller. Escape or Cancel leave it, keeping the draft; `error` shows above the buttons and goes once
 * a field changes.
 */
export function NewFromIdea({
  busy,
  error,
  onError,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  /** The last refusal, from this form or from main. */
  error: string | null;
  onError: (message: string | null) => void;
  onCancel: () => void;
  /** `parent` is the folder the person picked, undefined for the default. */
  onCreate: (brief: IdeaBrief, parent: string | undefined) => void;
}) {
  const [name, setNameState] = useState(draft.name);
  const [about, setAbout] = useState(draft.about);
  const [formats, setFormats] = useState<string[]>(draft.formats);
  /** The main format: the project's own size, first in the brief. */
  const [main, setMain] = useState(draft.main);
  const [length, setLength] = useState(draft.length);
  const [url, setUrl] = useState(draft.url);
  draft = { name, about, formats, main, length, url };
  // A change answers the refusal shown: it goes, and submitting checks again.
  const edited = () => {
    if (error) onError(null);
  };
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
      if (ticket === latest.current) onError(systemErrorText((failure as Error).message) ?? (failure as Error).message);
    }
  };
  // Once: the default folder.
  useEffect(() => {
    void replan({});
  }, []);
  // The folder follows the name as it is typed, not only when the field is left (#752).
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  const setName = (next: string) => {
    setNameState(next);
    edited();
    clearTimeout(typing.current);
    typing.current = setTimeout(() => void replan({ name: next }), REPLAN_MS);
  };

  const changeParent = async () => {
    const chosen = await window.frameshell.project.chooseParent();
    if (!chosen) return;
    setParent(chosen);
    await replan({ parent: chosen });
  };

  const toggle = (id: string, on: boolean) => {
    edited();
    const next = on ? [...formats, id] : formats.filter((other) => other !== id);
    setFormats(next);
    // The main format stays ticked: the first ticked one in the list takes over, the first ticked becomes it.
    if (!next.includes(main)) setMain(BUILTIN_FORMAT_IDS.find((other) => next.includes(other)) ?? id);
  };

  const submit = () => {
    const bad = name.trim() === "" ? t.welcome.ideaNeedName : formats.length === 0 ? t.welcome.ideaNeedFormat : badUrl(url);
    if (bad) {
      onError(bad);
      return;
    }
    onError(null);
    draft = EMPTY_DRAFT;
    onCreate(
      {
        name,
        formats: [main, ...formats.filter((id) => id !== main)],
        seconds: length === UNKNOWN ? null : Number(length),
        url: url.trim() === "" ? null : url.trim(),
        about: about.trim() === "" ? null : about.trim(),
      },
      parent,
    );
  };

  return (
    <form
      className="welcome-new"
      aria-label={t.welcome.ideaForm}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="welcome-hint">{t.welcome.ideaLede}</p>
      <label className="welcome-field">
        <span>{t.welcome.ideaName}</span>
        <input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} spellCheck={false} autoFocus />
      </label>
      <label className="welcome-field">
        <span>{t.welcome.ideaAbout}</span>
        <textarea
          value={about}
          disabled={busy}
          rows={3}
          maxLength={2000}
          placeholder={t.welcome.ideaAboutPlaceholder}
          onChange={(event) => {
            setAbout(event.target.value);
            edited();
          }}
        />
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
        {BUILTIN_FORMAT_IDS.map((id) => {
          const label = t.welcome.formatLabels[id] ?? id;
          const ticked = formats.includes(id);
          return (
            <div key={id} className="welcome-format">
              <label>
                <input type="checkbox" checked={ticked} disabled={busy} onChange={(event) => toggle(id, event.target.checked)} />
                {label}
              </label>
              {ticked && formats.length > 1 && (
                <label className="welcome-format-main">
                  <input type="radio" name="idea-main-format" checked={main === id} disabled={busy} aria-label={t.welcome.mainFormatOf(label)} onChange={() => setMain(id)} />
                  {t.welcome.mainFormat}
                </label>
              )}
            </div>
          );
        })}
        <p className="welcome-hint">{t.welcome.formatsHint}</p>
      </fieldset>
      <label className="welcome-field">
        <span>{t.welcome.ideaLength}</span>
        <select
          value={length}
          disabled={busy}
          onChange={(event) => {
            setLength(event.target.value);
            edited();
          }}
        >
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
        <input
          value={url}
          disabled={busy}
          onChange={(event) => {
            setUrl(event.target.value);
            edited();
          }}
          placeholder="https://"
          spellCheck={false}
        />
        <small className="welcome-hint">{t.welcome.ideaUrlHint}</small>
      </label>
      {error && (
        <p className="welcome-error" role="alert">
          {error}
        </p>
      )}
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
    const url = new URL(withScheme(text.trim()));
    return url.protocol === "https:" || url.protocol === "http:" ? null : t.welcome.ideaBadUrl;
  } catch {
    return t.welcome.ideaBadUrl;
  }
}
