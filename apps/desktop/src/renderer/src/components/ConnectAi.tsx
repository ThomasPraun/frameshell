import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { DESKTOP_APP_DOWNLOAD, type AiAppStatus, isDesktopAppId } from "../../../shared/api.js";
import { DESKTOP_ROWS, DEVELOPER_ROWS, ROW_APP, type RowId, cardView, starterPhrase } from "../connect/model.js";
import { type ConnectState, connectPanel } from "../connect/store.js";
import { t } from "../i18n.js";
import { useModal } from "./modal.js";

const said = t.agents.connect;

/** Each row's strings. */
const ROW_TEXT: Record<RowId, { name: string; about: string; note?: string; short?: string; label?: string }> = {
  "claude-desktop": said.apps.claudeDesktop,
  chatgpt: said.apps.chatgpt,
  "claude-code": said.apps.claudeCode,
  "codex-cli": said.apps.codexCli,
  gemini: said.apps.gemini,
};

/**
 * "Connect your AI": desktop AI apps first (Claude Desktop, the ChatGPT desktop app) as big cards, then a smaller group
 * for developers (Claude Code, Codex CLI, Gemini CLI, and a snippet to paste into Cursor, VS Code and others). Mount
 * once per window root; a panel asked for from a detached panel's window is drawn there through a portal.
 */
export function ConnectAiHost() {
  const state = useSyncExternalStore(connectPanel.subscribe, connectPanel.get);
  if (!state) return null;
  const element = <ConnectAi state={state} />;
  return state.view === window ? element : createPortal(element, state.view.document.body);
}

/** The button that opens the panel, from the window it is in. */
export function ConnectAiButton({ className = "button", project = null }: { className?: string; /** The open project's name. */ project?: string | null }) {
  return (
    <button
      className={className}
      data-testid="connect-ai-open"
      data-tip={said.openTitle}
      onClick={(event) => connectPanel.open(event.currentTarget.ownerDocument.defaultView ?? window, project)}
    >
      {said.open}
    </button>
  );
}

function ConnectAi({ state }: { state: ConnectState }) {
  const title = useId();
  const box = useRef<HTMLDivElement>(null);
  const onKeyDown = useModal(box, state.view, () => connectPanel.close());
  const status = (row: RowId) => state.apps?.apps.find((app) => app.id === ROW_APP[row]);
  return (
    <div className="voiceover-backdrop" data-testid="connect-ai-backdrop" onClick={(event) => event.target === event.currentTarget && connectPanel.close()}>
      <div
        ref={box}
        className="voiceover-dialog connect-ai"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        data-testid="connect-ai"
        onKeyDown={onKeyDown}
      >
        <div className="connect-ai-top">
          <h2 id={title} className="voiceover-title">
            {said.title}
          </h2>
          <button className="icon-button" aria-label={said.close} data-tip={said.close} data-testid="connect-ai-x" onClick={() => connectPanel.close()}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4L12 12M12 4L4 12" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
        <p className="connect-ai-lede">{said.lede}</p>

        <section className="connect-ai-desktop" aria-label={said.desktop} data-testid="connect-ai-desktop">
          {DESKTOP_ROWS.map((row) => (
            <AppCard key={row} row={row} status={status(row)} state={state} big />
          ))}
        </section>

        <section className="connect-ai-developers" aria-labelledby={`${title}-dev`} data-testid="connect-ai-developers">
          <h3 id={`${title}-dev`} className="voiceover-heading">
            {said.developers}
          </h3>
          <p className="connect-ai-hint">{said.developersLede}</p>
          {DEVELOPER_ROWS.map((row) => (
            <AppCard key={row} row={row} status={status(row)} state={state} />
          ))}
          {state.apps && <Snippets snippets={state.apps.snippets} />}
        </section>

        <div className="voiceover-actions connect-ai-footer">
          <button className="link" onClick={() => connectPanel.refresh()}>
            {said.checkAgain}
          </button>
          <button className="button" data-testid="connect-ai-close" onClick={() => connectPanel.close()}>
            {said.close}
          </button>
        </div>
      </div>
    </div>
  );
}

function AppCard({ row, status, state, big = false }: { row: RowId; status: AiAppStatus | undefined; state: ConnectState; big?: boolean }) {
  const app = ROW_APP[row];
  const text = ROW_TEXT[row];
  const desktop = big && isDesktopAppId(row) ? row : null;
  const view = cardView(status, state.working.includes(app), state.last[app], desktop ? state.launched[desktop] : undefined);
  const short = text.short ?? text.name;
  const label = text.label ?? text.name;
  return (
    <article className={`connect-ai-card${big ? " is-big" : ""}`} aria-label={text.name} data-testid="connect-ai-card" data-row={row} data-state={view.kind}>
      <div className="connect-ai-card-head">
        <h3 className="connect-ai-name">{text.name}</h3>
        {view.kind === "connected" && <span className="connect-ai-badge">{said.connected}</span>}
      </div>
      <p className="connect-ai-about">{text.about}</p>
      {text.note && <p className="connect-ai-hint">{text.note}</p>}
      {view.kind === "unavailable" && <p className="connect-ai-hint">{said.notAvailable}</p>}
      {view.kind === "not-installed" && <p className="connect-ai-hint">{said.notInstalled(text.name)}</p>}
      {view.kind === "no-settings" && <p className="connect-ai-hint">{said.noSettings(text.name)}</p>}
      {view.kind === "different" && <p className="connect-ai-hint">{said.different}</p>}
      {view.restart && (
        <p className="connect-ai-done" role="status" data-testid="connect-ai-restart">
          {view.restart === "connected" ? said.restartConnected(text.name) : said.restartDisconnected(text.name)}
        </p>
      )}
      {view.backups.length > 0 && <p className="connect-ai-hint">{said.backups(view.backups.join(", "))}</p>}
      {view.problem && view.problem.kind !== "not-installed" && (
        <p className="voiceover-error" role="alert">
          {view.problem.kind === "invalid" ? said.invalid(view.problem.file) : said.failed(view.problem.message)}
        </p>
      )}
      {desktop && view.launch?.kind === "opened" && view.launch.copied && (
        <p className="connect-ai-done" role="status" data-testid="connect-ai-copied">
          {said.copiedPaste(short)}
        </p>
      )}
      {desktop && view.launch?.kind === "not-found" && (
        <p className="connect-ai-hint" role="status" data-testid="connect-ai-not-found">
          {said.notFound(text.name)}
        </p>
      )}
      {desktop && view.launch?.kind === "failed" && (
        <p className="voiceover-error" role="alert">
          {said.openFailed(view.launch.message)}
        </p>
      )}
      {(view.connect || view.disconnect || view.checkAgain || view.showFile || (desktop && (view.open || view.download)) || view.kind === "working") && (
        <div className="connect-ai-buttons">
          {view.kind === "working" && <span className="connect-ai-hint">{said.working}</span>}
          {desktop && view.download && (
            <a className="button primary" href={DESKTOP_APP_DOWNLOAD[desktop]} target="_blank" rel="noreferrer" data-testid="connect-ai-download">
              {said.downloadApp(label)}
            </a>
          )}
          {desktop && view.open && (
            <button
              className={view.download ? "button" : "button primary"}
              data-testid="connect-ai-launch"
              disabled={state.launching.includes(desktop)}
              onClick={() => void connectPanel.launch(desktop, starterPhrase(state.project, said.starter))}
            >
              {said.openApp(label)}
            </button>
          )}
          {view.connect && (
            <button
              className={big ? "button primary" : "button"}
              disabled={view.connectBlocked}
              data-testid="connect-ai-connect"
              data-tip={view.connectBlocked ? said.fixFileFirst : undefined}
              onClick={() => void connectPanel.change(app, true)}
            >
              {view.connect === "again" ? said.connectAgain : said.connect}
            </button>
          )}
          {view.showFile && (
            <button className="button" data-testid="connect-ai-show-file" onClick={() => void window.frameshell.agents.showFile(app, view.showFile!)}>
              {said.showFile}
            </button>
          )}
          {view.checkAgain && (
            <button className="button" data-testid="connect-ai-check-again" onClick={() => connectPanel.refresh()}>
              {said.checkAgain}
            </button>
          )}
          {view.disconnect && (
            <button className="button" onClick={() => void connectPanel.change(app, false)}>
              {said.disconnect}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function Snippets({ snippets }: { snippets: { mcpServers: string; vscode: string } }) {
  return (
    <article className="connect-ai-card" aria-label={said.others.name} data-testid="connect-ai-card" data-row="others">
      <h3 className="connect-ai-name">{said.others.name}</h3>
      <p className="connect-ai-about">{said.others.about}</p>
      <Snippet label={said.others.mcpServers} text={snippets.mcpServers} />
      <Snippet label={said.others.vscode} text={snippets.vscode} />
    </article>
  );
}

/** How long "Copied" replaces "Copy", ms. */
const COPIED_MS = 2000;

function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="connect-ai-snippet">
      <div className="connect-ai-snippet-head">
        <span>{label}</span>
        <button className="link" aria-label={`${said.others.copy}: ${label}`} onClick={() => void navigator.clipboard.writeText(`${text}\n`).then(() => setCopied(true))}>
          {copied ? said.others.copied : said.others.copy}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}
