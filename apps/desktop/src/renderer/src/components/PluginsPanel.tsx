import { officialPlugin } from "@frameshell/protocol/official-plugins";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineDownloads, PluginsView } from "../../../shared/api.js";
import { downloadSize, sizeText } from "../../../shared/sizes.js";
import { t } from "../i18n.js";
import { type DownloadRow, type PluginRow, downloadRows, otherPlugins, pluginRows, trustPrompt } from "../plugins/model.js";
import { useIdea } from "../idea.js";

/** What a video made from an idea needs first: a generator of motion clips (#752). */
const IDEA_PLUGINS = ["@frameshell/hyperframes"];

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

  const readPlugins = useCallback(async () => {
    try {
      setView(await window.frameshell.plugins.read());
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
            <PluginItem key={row.name} row={row} busy={busy} onInstall={() => void install(row)} onRemove={() => void remove(row)} />
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
                    <span className={`plugin-state is-${plugin.status}`}>{stateText(plugin.status)}</span>
                  </div>
                  {plugin.error && <p className="plugins-error">{plugin.error}</p>}
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
                {row.name} <span className="plugins-meta">{row.kind === "model" ? t.plugins.downloads.model : t.plugins.downloads.program}</span>
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

function PluginItem({ row, busy, onInstall, onRemove }: { row: PluginRow; busy: string | null; onInstall: () => void; onRemove: () => void }) {
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
      <p className={`plugins-meta${row.need.met === false ? " is-unmet" : ""}`}>{needText(row)}</p>
      <p className="plugins-meta">{row.cost === "free" ? t.plugins.free : row.cost === "cloud-audio" ? t.plugins.paidAudio : t.plugins.paidText}</p>
      <p className="plugins-meta">{downloadText(row)}</p>
      {row.error && <p className="plugins-error">{row.error}</p>}
      <div className="plugins-actions">
        {row.install && (
          <button
            className="button"
            disabled={busy !== null || row.installBlocked}
            data-tip={row.installBlocked ? t.plugins.installNeedsTrust : undefined}
            onClick={onInstall}
          >
            {busy === `install:${row.name}` ? t.plugins.installing : t.plugins.install}
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

/** A plugin's name for a person; the package name for one this app has no words for. */
function titleOf(name: string): string {
  return t.plugins.about[name]?.title ?? name;
}

function stateText(state: PluginRow["state"]): string {
  const said = t.plugins.state;
  return state === "loaded" ? said.loaded : state === "error" ? said.error : state === "untrusted" ? said.untrusted : said.notInstalled;
}

/** What the plugin needs, and whether this machine has it. The key's value is never read here: only set or not. */
function needText(row: PluginRow): string {
  const said = t.plugins.need;
  switch (row.need.kind) {
    case "none":
      return said.none;
    case "blender":
      return `${said.blender} ${row.need.met ? said.blenderFound : said.blenderMissing}`;
    case "openai-key": {
      const variable = officialPlugin(row.name)?.need.variable ?? "";
      return `${said.openaiKey(variable)} ${row.need.met ? said.keySet : said.keyMissing(variable)}`;
    }
    case "remotion-project":
      return said.remotion;
  }
}

function downloadText(row: PluginRow): string {
  const { download } = row;
  if (download.state === "none") return t.plugins.noDownloads;
  if (download.state === "ready") return t.plugins.downloadsReady(download.names.join(", "));
  return download.bytes > 0
    ? t.plugins.downloadsFirst(downloadSize(download.bytes), download.names.join(", "))
    : t.plugins.downloadsFirstUnsized(download.names.join(", "));
}
