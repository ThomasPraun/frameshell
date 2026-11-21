import { officialPlugin } from "@frameshell/protocol/official-plugins";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineDownloads, OpenAiKeyState, PluginsView } from "../../../shared/api.js";
import { downloadSize, sizeText } from "../../../shared/sizes.js";
import { t } from "../i18n.js";
import { type DownloadRow, type PluginRow, downloadRows, downloadUse, errorParts, otherPlugins, pluginRows, trustPrompt } from "../plugins/model.js";
import { useIdea } from "../idea.js";

/** What a video made from an idea needs first: a generator of motion clips (#752). */
const IDEA_PLUGINS = ["@frameshell/hyperframes"];

/** Where people get an OpenAI API key. */
const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

/** Notice line above the sections: what the last action did or why it failed. */
type Notice = { text: string; error: boolean };

/**
 * The Plugins view: the official plugins of this project with what each needs, costs and downloads, Install and
 * Remove, the trust banner when the project declares plugins nobody trusted yet, and this machine's managed
 * downloads with Remove. Nothing installs, downloads or is trusted without a click; removals confirm in main.
 * Reads again after each action, when `frameshell.json` changes and when its window gets focus (downloads only
 * after actions: `doctor` is the costlier call).
 */
export function PluginsPanel() {
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<PluginsView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [machine, setMachine] = useState<MachineDownloads | null>(null);
  const [machineError, setMachineError] = useState<string | null>(null);
  /** Key of the action running (`install:<name>`, `remove:<name>`, `trust`, `download:<name>`); one at a time. */
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [key, setKey] = useState<OpenAiKeyState | null>(null);

  const readPlugins = useCallback(async () => {
    try {
      const [read, keyState] = await Promise.all([window.frameshell.plugins.read(), window.frameshell.plugins.keyState()]);
      setView(read);
      setKey(keyState);
      setReadError(null);
    } catch (error) {
      setReadError((error as Error).message);
    }
  }, []);
  const readDownloads = useCallback(async () => {
    try {
      setMachine(await window.frameshell.plugins.downloads());
      setMachineError(null);
    } catch (error) {
      setMachineError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void readPlugins();
    void readDownloads();
    const offFiles = window.frameshell.files.onChanged((paths) => {
      if (paths.includes("frameshell.json")) void readPlugins();
    });
    const own = root.current?.ownerDocument.defaultView;
    const onFocus = () => void readPlugins();
    own?.addEventListener("focus", onFocus);
    return () => {
      offFiles();
      own?.removeEventListener("focus", onFocus);
    };
  }, [readPlugins, readDownloads]);

  const act = async (key: string, work: () => Promise<string | null>, failed: (reason: string) => string) => {
    setBusy(key);
    setNotice(null);
    try {
      const done = await work();
      if (done) setNotice({ text: done, error: false });
    } catch (error) {
      setNotice({ text: failed((error as Error).message), error: true });
    } finally {
      await Promise.all([readPlugins(), readDownloads()]);
      setBusy(null);
    }
  };

  const install = (row: PluginRow) =>
    act(
      `install:${row.name}`,
      async () => {
        const { plugin } = await window.frameshell.plugins.install(row.name);
        return plugin.status === "error"
          ? t.plugins.installedNotLoaded(titleOf(row.name), plugin.error ?? "")
          : t.plugins.installed(titleOf(row.name));
      },
      t.plugins.installFailed,
    );
  const remove = (row: { name: string }) =>
    act(`remove:${row.name}`, async () => ((await window.frameshell.plugins.remove(row.name)) ? t.plugins.removed(titleOf(row.name)) : null), t.plugins.removeFailed);
  const decide = (decision: "trust" | "deny") =>
    act(
      "trust",
      async () => {
        await window.frameshell.plugins.trust(decision);
        return null;
      },
      t.plugins.trust.failed,
    );
  /** Resolves true when the key was saved, so the field can forget what was typed. */
  const saveKey = async (value: string) => {
    let saved = false;
    await act(
      "key",
      async () => {
        await window.frameshell.plugins.saveKey(value);
        saved = true;
        return t.plugins.key.saved;
      },
      t.plugins.key.saveFailed,
    );
    return saved;
  };
  const removeKey = () =>
    act(
      "key",
      async () => {
        await window.frameshell.plugins.removeKey();
        return t.plugins.key.removed;
      },
      t.plugins.key.removeFailed,
    );
  const removeDownload = (row: DownloadRow) =>
    act(
      `download:${row.name}`,
      async () => {
        const result = await window.frameshell.plugins.removeDownload(row.name, row.bytes ?? 0);
        return result?.removed ? t.plugins.downloads.removed(row.name, sizeText(result.bytes)) : null;
      },
      t.plugins.downloads.cannotRemove,
    );

  const prompt = view ? trustPrompt(view.catalog.trust) : null;
  const idea = useIdea();
  const rows = view ? pluginRows(view.catalog, idea ? IDEA_PLUGINS : []) : [];
  const others = view ? otherPlugins(view) : [];
  const downloads = machine ? downloadRows(machine, view?.catalog ?? null) : null;
  const installOpen = view !== null && (view.catalog.trust === "not-required" || view.catalog.trust === "trusted");

  return (
    <div className="plugins-panel" ref={root} data-testid="plugins-panel">
      {notice && (
        <p className={`plugins-notice${notice.error ? " is-error" : ""}`} role="status" data-testid="plugins-notice">
          {notice.text}
        </p>
      )}
      {prompt && view && (
        <div className="plugins-trust" role="alert" data-testid="plugins-trust" data-trust={view.catalog.trust}>
          <p>{prompt === "ask" ? t.plugins.trust.ask : t.plugins.trust.denied}</p>
          <p className="plugins-meta">{t.plugins.trust.declared(view.declared.map((plugin) => plugin.name).join(", "))}</p>
          <div className="plugins-actions">
            <button className="button" disabled={busy !== null} onClick={() => void decide("trust")}>
              {t.plugins.trust.trust}
            </button>
            {prompt === "ask" && (
              <button className="button" disabled={busy !== null} onClick={() => void decide("deny")}>
                {t.plugins.trust.dontTrust}
              </button>
            )}
          </div>
        </div>
      )}

      <section className="plugins-section" aria-label={t.plugins.heading}>
        <h3 className="plugins-heading">{t.plugins.heading}</h3>
        <p className="plugins-meta">{t.plugins.intro}</p>
        {installOpen && <p className="plugins-meta">{t.plugins.installTrusts}</p>}
        {!view && !readError && <p className="plugins-meta">{t.plugins.loading}</p>}
        {readError && <p className="plugins-error">{t.plugins.cannotRead(readError)}</p>}
        <ul className="plugins-list">
          {rows.map((row) => (
            <PluginItem
              key={row.name}
              row={row}
              busy={busy}
              keyState={key}
              onInstall={() => void install(row)}
              onRemove={() => void remove(row)}
              onSaveKey={saveKey}
              onRemoveKey={() => void removeKey()}
            />
          ))}
        </ul>
        {others.length > 0 && (
          <>
            <h4 className="plugins-subheading">{t.plugins.others}</h4>
            <p className="plugins-meta">{t.plugins.othersNote}</p>
            <ul className="plugins-list">
              {others.map((plugin) => (
                <li key={plugin.name} className="plugin" data-testid="plugin" data-name={plugin.name} data-state={plugin.status}>
                  <div className="plugin-head">
                    <span className="plugin-title">{plugin.name}</span>
                    <span className={`plugin-state is-${plugin.status}`}>{plugin.status === "untrusted" ? t.plugins.state.declared : stateText(plugin.status)}</span>
                  </div>
                  {plugin.error && <PluginError text={plugin.error} />}
                  <div className="plugins-actions">
                    <button className="button" disabled={busy !== null} onClick={() => void remove(plugin)}>
                      {busy === `remove:${plugin.name}` ? t.plugins.removing : t.plugins.remove}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="plugins-section" aria-label={t.plugins.downloads.heading}>
        <h3 className="plugins-heading">{t.plugins.downloads.heading}</h3>
        <p className="plugins-meta">{t.plugins.downloads.intro}</p>
        {machineError && <p className="plugins-error">{t.plugins.downloads.cannotRead(machineError)}</p>}
        {downloads && (
          <p className="plugins-total" data-testid="downloads-total">
            {downloads.totalBytes > 0 ? t.plugins.downloads.total(sizeText(downloads.totalBytes)) : t.plugins.downloads.none}
          </p>
        )}
        <ul className="plugins-list">
          {downloads?.rows.map((row) => (
            <li key={row.name} className="download" data-testid="download" data-name={row.name} data-on-disk={row.onDisk}>
              <span className="download-name">
                <span className="download-title">{row.name}</span>
                <span className="plugins-meta" data-testid="download-use">
                  {usedFor(row)}
                </span>
              </span>
              <span className="download-size">
                {row.onDisk ? sizeText(row.bytes ?? 0) : row.bytes ? t.plugins.downloads.notYetSized(downloadSize(row.bytes)) : t.plugins.downloads.notYet}
              </span>
              {row.onDisk && (
                <button className="button" disabled={busy !== null} onClick={() => void removeDownload(row)}>
                  {busy === `download:${row.name}` ? t.plugins.removing : t.plugins.downloads.remove}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

interface PluginItemProps {
  row: PluginRow;
  busy: string | null;
  /** Where the OpenAI key comes from; null until read. */
  keyState: OpenAiKeyState | null;
  onInstall: () => void;
  onRemove: () => void;
  onSaveKey: (value: string) => Promise<boolean>;
  onRemoveKey: () => void;
}

function PluginItem({ row, busy, keyState, onInstall, onRemove, onSaveKey, onRemoveKey }: PluginItemProps) {
  return (
    <li className="plugin" data-testid="plugin" data-name={row.name} data-state={row.state}>
      <div className="plugin-head">
        <span className="plugin-title">{titleOf(row.name)}</span>
        <span className={`plugin-state is-${row.state}`}>
          {stateText(row.state)}
          {row.version && ` · ${t.plugins.version(row.version)}`}
        </span>
      </div>
      <p className="plugin-purpose">{t.plugins.about[row.name]?.purpose ?? row.name}</p>
      <p className={`plugins-meta${row.need.met === false ? " is-unmet" : ""}`} data-testid="plugin-need">
        {needText(row, keyState)}
      </p>
      {row.need.kind === "openai-key" && keyState && (
        <OpenAiKeyField state={keyState} met={row.need.met === true} busy={busy} onSave={onSaveKey} onRemove={onRemoveKey} />
      )}
      <p className="plugins-meta">{row.cost === "free" ? t.plugins.free : row.cost === "cloud-audio" ? t.plugins.paidAudio : t.plugins.paidText}</p>
      <p className="plugins-meta">{downloadText(row)}</p>
      {row.error && <PluginError text={row.error} />}
      {busy === `install:${row.name}` && (
        <p className="plugins-meta" role="status" data-testid="plugin-installing">
          {t.plugins.installingNote}
        </p>
      )}
      <div className="plugins-actions">
        {row.install && (
          <button
            className="button"
            disabled={busy !== null || row.installBlocked}
            data-tip={row.installBlocked ? t.plugins.installNeedsTrust : undefined}
            onClick={onInstall}
          >
            {busy === `install:${row.name}` ? <Elapsed /> : t.plugins.install}
          </button>
        )}
        {row.remove && (
          <button className="button" disabled={busy !== null} onClick={onRemove}>
            {busy === `remove:${row.name}` ? t.plugins.removing : t.plugins.remove}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The OpenAI key field (ADR 0048): a password input with Save while no key is set and this computer can encrypt one,
 * Remove once one is saved here, nothing when the key comes from the environment. What was typed is dropped after a
 * save; the saved key never comes back to this view.
 */
function OpenAiKeyField({
  state,
  met,
  busy,
  onSave,
  onRemove,
}: {
  state: OpenAiKeyState;
  met: boolean;
  busy: string | null;
  onSave: (value: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState("");
  const said = t.plugins.key;
  if (state.source === "environment") return null;
  if (state.source === "app") {
    return (
      <div className="plugins-actions">
        <button className="button" disabled={busy !== null} onClick={onRemove} data-testid="openai-key-remove">
          {busy === "key" ? t.plugins.removing : said.remove}
        </button>
      </div>
    );
  }
  // Set in the engine's own environment (started from a terminal), or nowhere to keep one: nothing to type here.
  if (met || !state.storable) return null;
  const save = async () => {
    if (await onSave(draft)) setDraft("");
  };
  return (
    <form
      className="plugin-key"
      data-testid="openai-key-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="plugin-key-label">
        <span>{said.label}</span>
        <input
          type="password"
          className="plugin-key-input"
          value={draft}
          placeholder={said.placeholder}
          autoComplete="off"
          spellCheck={false}
          data-testid="openai-key-input"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="plugins-actions">
        <button type="submit" className="button primary" disabled={busy !== null || draft.trim() === ""} data-testid="openai-key-save">
          {busy === "key" ? said.saving : said.save}
        </button>
        <a className="link" href={OPENAI_KEYS_URL} target="_blank" rel="noreferrer">
          {said.getOne}
        </a>
      </div>
    </form>
  );
}

/** "Installing… 12 s": the seconds of an install so far, so a long npm run shows it is still going (#740). */
function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  const own = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const view = own.current?.ownerDocument.defaultView ?? window;
    const started = Date.now();
    const timer = view.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => view.clearInterval(timer);
  }, []);
  return <span ref={own}>{seconds === 0 ? t.plugins.installing : t.plugins.installingFor(seconds)}</span>;
}

/**
 * A plugin's load error, short: its first line (first sentence of a long one) shows, the rest folds under
 * Details, so a missing key does not fill the card with red lines (#753).
 */
function PluginError({ text }: { text: string }) {
  const { head, rest } = errorParts(text);
  return (
    <div className="plugins-error" data-testid="plugin-error">
      <p>{head}</p>
      {rest && (
        <details className="plugin-error-details">
          <summary>{t.plugins.errorDetails}</summary>
          <pre>{rest}</pre>
        </details>
      )}
    </div>
  );
}

/** A plugin's name for a person; the package name for one this app has no words for. */
function titleOf(name: string): string {
  return t.plugins.about[name]?.title ?? name;
}

function stateText(state: PluginRow["state"]): string {
  const said = t.plugins.state;
  return state === "loaded" ? said.loaded : state === "error" ? said.error : state === "untrusted" ? said.untrusted : said.notInstalled;
}

/**
 * What the plugin needs, and whether this machine has it. The key's value is never read here: only where it comes
 * from (`key`, ADR 0048) and whether the engine has one (`need.met`).
 */
function needText(row: PluginRow, key: OpenAiKeyState | null): string {
  const said = t.plugins.need;
  switch (row.need.kind) {
    case "none":
      return said.none;
    case "blender":
      return `${said.blender} ${row.need.met ? said.blenderFound : said.blenderMissing}`;
    case "openai-key": {
      const variable = officialPlugin(row.name)?.need.variable ?? "";
      const where =
        key?.source === "environment"
          ? said.keyFromEnvironment(variable)
          : key?.source === "app"
            ? said.keySaved
            : row.need.met
              ? said.keySet
              : key && !key.storable
                ? said.keyNotStorable(variable)
                : said.keyMissing;
      return `${said.openaiKey} ${where}`;
    }
    case "remotion-project":
      return said.remotion;
  }
}

/** A download's kind, and what it is for when this app knows. */
function usedFor(row: DownloadRow): string {
  const said = t.plugins.downloads;
  const kind = row.kind === "model" ? said.model : said.program;
  const use = downloadUse(row.name);
  return use ? said.usedFor(kind, said.use[use]) : kind;
}

function downloadText(row: PluginRow): string {
  const { download } = row;
  if (download.state === "none") return t.plugins.noDownloads;
  if (download.state === "ready") return t.plugins.downloadsReady(download.names.join(", "));
  return download.bytes > 0
    ? t.plugins.downloadsFirst(downloadSize(download.bytes), download.names.join(", "))
    : t.plugins.downloadsFirstUnsized(download.names.join(", "));
}
