import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { AiAppStatus } from "../../../shared/api.js";
import { DESKTOP_ROWS, DEVELOPER_ROWS, ROW_APP, type RowId, cardView } from "../connect/model.js";
import { type ConnectState, connectPanel } from "../connect/store.js";
import { t } from "../i18n.js";
import { useModal } from "./modal.js";

const said = t.agents.connect;

/** Each row's strings. */
const ROW_TEXT: Record<RowId, { name: string; about: string; note?: string }> = {
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
export function ConnectAiButton({ className = "button" }: { className?: string }) {
  return (
    <button
      className={className}
      data-testid="connect-ai-open"
      data-tip={said.openTitle}
      onClick={(event) => connectPanel.open(event.currentTarget.ownerDocument.defaultView ?? window)}
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
        <h2 id={title} className="voiceover-title">
          {said.title}
        </h2>
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

        <div className="voiceover-actions">
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
  const view = cardView(status, state.working.includes(app), state.last[app]);
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
      {(view.connect || view.disconnect || view.kind === "working") && (
        <div className="connect-ai-buttons">
          {view.kind === "working" && <span className="connect-ai-hint">{said.working}</span>}
          {view.connect && (
            <button className={big ? "button primary" : "button"} onClick={() => void connectPanel.change(app, true)}>
              {view.connect === "again" ? said.connectAgain : said.connect}
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
