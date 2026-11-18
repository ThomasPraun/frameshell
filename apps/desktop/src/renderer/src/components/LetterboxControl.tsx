import { parseAspect } from "@frameshell/schema/finish";
import { useEffect, useRef, useState } from "react";
import { LETTERBOX_PRESETS, type LetterboxChoice, aspectText, letterboxArgs, letterboxChoice, storedAspect } from "../finish/model.js";
import { t } from "../i18n.js";
import { SELECTION_TIMELINE } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { sendClipEdit } from "./clip-edits.js";

/** `2.39` shows as `2.39:1`; `4:3` already is a ratio. */
const presetLabel = (id: string) => (id.includes(":") ? id : `${id}:1`);

/**
 * The timeline's letterbox (ADR 0043), a menu next to the preview's format switcher: no bars, a film aspect (2.39,
 * 2.35, 1.85, 4:3) or a custom one typed as `2.2`, `2.2:1` or `16:9`. Each choice is one `letterbox.set`, or `clear`
 * for none. With a format other than the primary shown (`format`), the menu reads and writes that format's own bars
 * (ADR 0027 decision 14), which start out as none. Rejections of the daemon go to `onError`.
 */
export function LetterboxControl({ format, onError }: { format: string | null; onError: (message: string) => void }) {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const aspect = storedAspect(view, format);
  const choice = letterboxChoice(aspect);
  // `Custom…` picked with no custom aspect stored yet keeps the typing field open until something is applied.
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const stored = aspect === null ? "" : aspectText(aspect);
  useEffect(() => {
    setTyping(false);
    setInvalid(false);
    setText(stored);
  }, [stored, format]);
  useEffect(() => {
    if (typing) field.current?.focus();
  }, [typing]);

  const send = (next: number | null) => {
    setTyping(false);
    setInvalid(false);
    sendClipEdit({ op: "letterbox.set", args: letterboxArgs(next, format) }).catch((failure: unknown) => onError((failure as Error).message));
  };
  const shown: LetterboxChoice = typing ? "custom" : choice;
  const apply = () => {
    const parsed = parseAspect(text);
    if (parsed === null) setInvalid(true);
    else send(parsed);
  };
  return (
    <>
      <select
        className={`clip-field-select preview-letterbox-menu${aspect === null ? "" : " on"}`}
        aria-label={t.preview.letterbox}
        data-tip={format === null ? t.preview.letterboxHint : t.preview.letterboxHintFormat(format)}
        data-testid="letterbox-menu"
        value={shown}
        disabled={view === null}
        onChange={(event) => {
          const picked = event.target.value as LetterboxChoice;
          if (picked === "none") send(null);
          else if (picked === "custom") setTyping(true);
          else send(LETTERBOX_PRESETS.find((preset) => preset.id === picked)!.aspect);
        }}
      >
        <option value="none">{t.preview.letterboxNone}</option>
        {LETTERBOX_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {presetLabel(preset.id)}
          </option>
        ))}
        <option value="custom">{choice === "custom" && !typing && aspect !== null ? `${aspectText(aspect)}:1` : t.preview.letterboxCustom}</option>
      </select>
      {shown === "custom" && (
        <input
          ref={field}
          className={`clip-field-input preview-letterbox-custom${invalid ? " is-invalid" : ""}`}
          aria-label={t.preview.letterboxCustomLabel}
          aria-invalid={invalid}
          data-tip={t.preview.letterboxCustomHint}
          data-testid="letterbox-custom"
          value={text}
          size={6}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
          onBlur={() => {
            if (text.trim() !== "" && text.trim() !== stored) apply();
            else setTyping(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") apply();
            else if (event.key === "Escape") {
              setTyping(false);
              setInvalid(false);
              setText(stored);
            } else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      )}
    </>
  );
}
