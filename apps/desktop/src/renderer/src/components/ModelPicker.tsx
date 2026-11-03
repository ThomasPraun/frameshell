import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ModelListResult } from "@frameshell/protocol";
import { t } from "../i18n.js";
import { CUSTOM_CHOICE, DEFAULT_CHOICE, type ModelOption, fileName, modelChoices, modelIdFromFile } from "../transcript/model-choice.js";

/** Feedback for the toolbar's status line. */
export type ModelStatus = (text: string, tone: "info" | "error" | "warning") => void;

/**
 * Transcription model picker of the transcript toolbar (#427): the project's `transcription.model` (Default = this
 * machine's default, else the provider's), the provider's own models with their size, the model files registered on
 * this computer, and "Custom file…", which registers a file under a name and selects it. Re-reads the list when its
 * window gets focus, so a change made in the terminal shows.
 */
export function ModelPicker({ onStatus }: { onStatus: ModelStatus }) {
  const [list, setList] = useState<ModelListResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** A file being registered: its path, the name typed for it, and its provider settings. */
  const [pending, setPending] = useState<{ file: string; id: string; options: Record<string, string> } | null>(null);
  const select = useRef<HTMLSelectElement>(null);

  const reload = useCallback(async () => {
    try {
      setList(await window.frameshell.models.list());
    } catch (error) {
      onStatus(t.models.cannotList((error as Error).message), "error");
    }
  }, [onStatus]);

  useEffect(() => {
    void reload();
    const view = select.current?.ownerDocument.defaultView;
    const onFocus = () => void reload();
    view?.addEventListener("focus", onFocus);
    return () => view?.removeEventListener("focus", onFocus);
  }, [reload]);

  const choices = list ? modelChoices(list) : null;

  const use = async (model: string | null) => {
    setBusy(true);
    try {
      await window.frameshell.models.use(model);
      onStatus(model ? t.models.using(model) : t.models.usingDefault(choices?.defaultModel ?? null), "info");
    } catch (error) {
      onStatus(t.models.notChanged((error as Error).message), "error");
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const onChange = async (value: string) => {
    if (value !== CUSTOM_CHOICE) return use(value === DEFAULT_CHOICE ? null : value);
    const file = await window.frameshell.models.pickFile();
    if (file) setPending({ file, id: modelIdFromFile(file), options: {} });
  };

  const register = async (event: FormEvent) => {
    event.preventDefault();
    if (!pending) return;
    setBusy(true);
    try {
      await window.frameshell.models.add(pending.id, pending.file, pending.options);
      setPending(null);
    } catch (error) {
      onStatus(t.models.notRegistered((error as Error).message), "error");
      setBusy(false);
      return;
    }
    setBusy(false);
    await use(pending.id);
  };

  const label = (option: ModelOption) => {
    if (option.kind === "unknown") return t.models.unknown(option.id);
    if (option.kind === "registered") {
      const mark = option.state === "missing" ? t.models.missingFile : option.state === "changed" ? t.models.changedFile : "";
      return `${t.models.registered(option.id, fileName(option.file ?? ""))}${mark}`;
    }
    return t.models.pinned(option.id, option.size === null ? null : sizeLabel(option.size), option.downloaded);
  };

  return (
    <span className="transcript-model">
      <select
        ref={select}
        className="clip-field-select transcript-model-picker"
        aria-label={t.models.label}
        title={t.models.title}
        data-testid="model-picker"
        value={pending ? CUSTOM_CHOICE : (choices?.current ?? DEFAULT_CHOICE)}
        disabled={busy || !choices}
        onChange={(event) => void onChange(event.target.value)}
      >
        <option value={DEFAULT_CHOICE}>{t.models.defaultOption(choices?.defaultModel ?? null)}</option>
        {choices && choices.pinned.length > 0 && (
          <optgroup label={t.models.providerGroup(choices.provider)}>
            {choices.pinned.map((option) => (
              <option key={option.id} value={option.id}>
                {label(option)}
              </option>
            ))}
          </optgroup>
        )}
        {choices && choices.registered.length > 0 && (
          <optgroup label={t.models.registeredGroup}>
            {choices.registered.map((option) => (
              <option key={option.id} value={option.id}>
                {label(option)}
              </option>
            ))}
          </optgroup>
        )}
        {choices?.unknown && <option value={choices.unknown.id}>{label(choices.unknown)}</option>}
        <option value={CUSTOM_CHOICE}>{t.models.customFile}</option>
      </select>
      {pending && (
        <form className="transcript-model-register" aria-label={t.models.registerTitle(fileName(pending.file))} onSubmit={(event) => void register(event)}>
          <input
            className="clip-field-input"
            aria-label={t.models.idLabel}
            title={t.models.idHint}
            value={pending.id}
            required
            maxLength={64}
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
            onChange={(event) => setPending({ ...pending, id: event.target.value })}
          />
          {(choices?.options ?? []).map(({ key, values }) => (
            <select
              key={key}
              className="clip-field-select"
              aria-label={key === "dtw" ? t.models.dtwLabel : key}
              title={key === "dtw" ? t.models.dtwTitle : undefined}
              value={pending.options[key] ?? ""}
              onChange={(event) => {
                const { [key]: _old, ...rest } = pending.options;
                setPending({ ...pending, options: event.target.value ? { ...rest, [key]: event.target.value } : rest });
              }}
            >
              <option value="">{key === "dtw" ? t.models.dtwNone : t.models.optionNone}</option>
              {values.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ))}
          <button type="submit" className="button primary" disabled={busy}>
            {t.models.register}
          </button>
          <button type="button" className="link" onClick={() => setPending(null)}>
            {t.models.cancel}
          </button>
        </form>
      )}
    </span>
  );
}

/** `574 MB`, `1.6 GB`. */
function sizeLabel(bytes: number): string {
  return bytes < 1e9 ? t.models.megabytes(Math.round(bytes / 1e6)) : t.models.gigabytes((bytes / 1e9).toFixed(1));
}
