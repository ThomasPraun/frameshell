import { useCallback, useEffect, useState } from "react";
import type { AgentChoice } from "../../../shared/api.js";
import { connectPanel } from "../connect/store.js";
import { t } from "../i18n.js";

/** Remembered across projects and restarts: a per-viewer convenience, so browser storage. */
const HIDDEN_KEY = "frameshell.agentGuide.hidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    localStorage.setItem(HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Storage blocked: the guide just shows again next time.
  }
}

/**
 * How to talk to an agent, above the docked terminals. With no agent in the active terminal: first the way to
 * "Connect your AI" (desktop apps, the main button), then the agents found, each with Start, the others with their official installer
 * typed into the terminal for the user to run. With an agent running: prompt suggestions it types there, unsent. A video made from
 * an idea shows its prompt with Copy (for an AI app outside) and as the first suggestion, and keeps the guide open until
 * the prompt is used or put away (#752); then one link offers it again, and the brief stays in `brief.md`.
 */
export function AgentGuide({
  agent,
  compact,
  idea,
  ideaUsed,
  projectName,
  onIdeaUsed,
  onRun,
  onType,
}: {
  /** Name of the project, for the starter phrase "Connect your AI" copies. */
  projectName: string;
  /** Label of the agent in the active terminal; null when its shell runs. */
  agent: string | null;
  /** The shell is in use: only the way to open the guide shows, until opened. */
  compact: boolean;
  /** The prompt for the film of the project's idea; null when the project was not made from one. */
  idea: string | null;
  /** The prompt was typed into an agent or put away: the guide only offers it again. */
  ideaUsed: boolean;
  /** The prompt was used or put away (`true`), or asked for again (`false`). */
  onIdeaUsed: (used: boolean) => void;
  /** Run `command` in the active terminal (typed, then Enter). */
  onRun: (command: string) => void;
  /** Type `text` at the active terminal's prompt without sending it. */
  onType: (text: string) => void;
}) {
  const [hidden, setHidden] = useState(readHidden);
  const [choices, setChoices] = useState<AgentChoice[] | null>(null);
  const [installTyped, setInstallTyped] = useState(false);
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState(false);
  /** The idea's prompt is on offer: shown, and the guide stays open for it. */
  const offered = idea !== null && !ideaUsed;

  const detect = useCallback(() => {
    void window.frameshell.agents.detect().then(setChoices);
  }, []);
  useEffect(detect, [detect]);

  const hide = (value: boolean) => {
    setHidden(value);
    setOpened(!value);
    writeHidden(value);
  };

  const dismiss = () => (offered ? onIdeaUsed(true) : hide(true));

  if (!offered && (hidden || (compact && !agent && !opened))) {
    return (
      <div className="agent-guide is-hidden">
        <button className="link" onClick={() => (hidden ? hide(false) : setOpened(true))} data-testid="agent-guide-show">
          {t.agents.show}
        </button>
      </div>
    );
  }

  if (agent) {
    return (
      <div className="agent-guide is-running" role="region" aria-label={t.agents.suggestions} data-testid="agent-guide">
        <span className="agent-guide-label">{t.agents.suggestions}</span>
        <div className="agent-guide-prompts">
          {offered && (
            <button
              className="chip"
              data-tip={t.agents.suggestionTitle}
              data-testid="agent-guide-idea"
              onClick={() => {
                onType(idea);
                onIdeaUsed(true);
              }}
            >
              {t.agents.idea.chip}
            </button>
          )}
          {/* A project made from an idea has no footage to cut: its own suggestions (#752). */}
          {(idea !== null ? t.agents.ideaPrompts : t.agents.prompts).map((prompt) => (
            <button key={prompt} className="chip" data-tip={t.agents.suggestionTitle} onClick={() => onType(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
        <button className="link" onClick={dismiss}>
          {t.agents.hide}
        </button>
      </div>
    );
  }

  const found = choices?.filter((choice) => choice.path) ?? [];
  const missing = choices?.filter((choice) => !choice.path) ?? [];
  return (
    <section className="agent-guide" aria-label={t.agents.title} data-testid="agent-guide">
      <header className="agent-guide-head">
        <h2>{t.agents.title}</h2>
        <button className="link" onClick={dismiss}>
          {t.agents.hide}
        </button>
      </header>
      <p className="agent-guide-lede">{t.agents.lede}</p>
      {/* The way for someone who came without a terminal, so it leads (#740); the terminal agents follow. */}
      <button
        className="button primary agent-guide-apps"
        data-testid="agent-guide-connect"
        onClick={(event) => connectPanel.open(event.currentTarget.ownerDocument.defaultView ?? window, projectName)}
      >
        {t.agents.desktopApps}
      </button>
      {offered && (
        <div className="agent-guide-idea" data-testid="agent-guide-idea-prompt">
          <p className="agent-guide-hint" role="status">
            {t.agents.idea.ready}
          </p>
          <span className="agent-guide-label">{t.agents.idea.promptLabel}</span>
          <p className="agent-guide-idea-text">{idea}</p>
          <div className="agent-guide-idea-actions">
            <button
              className="button"
              data-testid="agent-guide-idea-copy"
              onClick={() => void navigator.clipboard.writeText(idea).then(() => setCopied(true), () => undefined)}
            >
              {copied ? t.agents.idea.copied : t.agents.idea.copy}
            </button>
            <button className="link" onClick={() => onIdeaUsed(true)}>
              {t.agents.idea.putAway}
            </button>
          </div>
        </div>
      )}
      {idea !== null && !offered && (
        <button className="link" data-testid="agent-guide-idea-again" onClick={() => onIdeaUsed(false)}>
          {t.agents.idea.showAgain}
        </button>
      )}
      {found.length > 0 && (
        <ul className="agent-guide-list" aria-label={t.agents.found}>
          {found.map((choice) => (
            <li key={choice.id}>
              <button className="button" onClick={() => onRun(choice.command)}>
                {t.agents.start(choice.name)}
              </button>
              {choice.unattended && <span className="agent-guide-warning">{t.agents.unattended}</span>}
            </li>
          ))}
        </ul>
      )}
      {choices && missing.length > 0 && (
        <details className="agent-guide-install" open={found.length === 0}>
          <summary>{found.length === 0 ? t.agents.notFound : t.agents.installOther}</summary>
          <ul className="agent-guide-list">
            {missing.map((choice) => (
              <li key={choice.id}>
                <button
                  className="button"
                  data-tip={choice.install}
                  onClick={() => {
                    onType(choice.install);
                    setInstallTyped(true);
                  }}
                >
                  {t.agents.install(choice.name)}
                </button>
                <code>{choice.install}</code>
                {choice.unattended && <span className="agent-guide-warning">{t.agents.unattended}</span>}
              </li>
            ))}
          </ul>
          {installTyped && (
            <p className="agent-guide-hint" role="status">
              {t.agents.installTyped}
            </p>
          )}
          <button className="link" onClick={detect}>
            {t.agents.checkAgain}
          </button>
        </details>
      )}
      <div className="agent-guide-more">
        <button className="link" onClick={() => void window.frameshell.agents.installCli()}>
          {t.agents.installCli}
        </button>
        <a className="link" href={t.agents.howToUrl} target="_blank" rel="noreferrer">
          {t.agents.howTo}
        </a>
      </div>
    </section>
  );
}
