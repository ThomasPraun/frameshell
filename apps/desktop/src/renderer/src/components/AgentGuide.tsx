import { useCallback, useEffect, useState } from "react";
import type { AgentChoice, ClaudeCodeStatus, ClaudeDesktopStatus } from "../../../shared/api.js";
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
 * How to talk to an agent (#190), above the docked terminals. With no agent in the active terminal: the agents
 * found, each with Start, the others with their official installer typed into the terminal for the user to run,
 * and Claude Desktop (#191). With an agent running: prompt suggestions it types there, unsent. A video made from
 * an idea (#472) adds its prompt as the first suggestion and keeps the guide open until it is hidden.
 */
export function AgentGuide({
  agent,
  compact,
  idea,
  onIdeaDone,
  onRun,
  onType,
}: {
  /** Label of the agent in the active terminal; null when its shell runs. */
  agent: string | null;
  /** The shell is in use: only the way to open the guide shows, until opened. */
  compact: boolean;
  /** The prompt for the film of the project's idea (#472); null when the project was not made from one, or it was dismissed. */
  idea: string | null;
  /** The person hid the guide while an idea was offered: forget the idea, keep the guide's own hidden setting. */
  onIdeaDone: () => void;
  /** Run `command` in the active terminal (typed, then Enter). */
  onRun: (command: string) => void;
  /** Type `text` at the active terminal's prompt without sending it. */
  onType: (text: string) => void;
}) {
  const [hidden, setHidden] = useState(readHidden);
  const [choices, setChoices] = useState<AgentChoice[] | null>(null);
  const [claude, setClaude] = useState<ClaudeDesktopStatus | null>(null);
  const [code, setCode] = useState<ClaudeCodeStatus | null>(null);
  const [installTyped, setInstallTyped] = useState(false);
  const [opened, setOpened] = useState(false);

  const detect = useCallback(() => {
    void window.frameshell.agents.detect().then(setChoices);
    void window.frameshell.agents.claudeDesktop().then(setClaude);
    void window.frameshell.agents.claudeCode().then(setCode);
  }, []);
  useEffect(detect, [detect]);

  const hide = (value: boolean) => {
    setHidden(value);
    setOpened(!value);
    writeHidden(value);
  };

  const dismiss = () => (idea ? onIdeaDone() : hide(true));

  if (!idea && (hidden || (compact && !agent && !opened))) {
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
          {idea && (
            <button className="chip" data-tip={t.agents.suggestionTitle} data-testid="agent-guide-idea" onClick={() => onType(idea)}>
              {t.agents.idea.chip}
            </button>
          )}
          {t.agents.prompts.map((prompt) => (
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
      {idea && (
        <p className="agent-guide-hint" role="status">
          {t.agents.idea.ready}
        </p>
      )}
      {found.length > 0 && (
        <ul className="agent-guide-list" aria-label={t.agents.found}>
          {found.map((choice) => (
            <li key={choice.id}>
              <button className="button primary" onClick={() => onRun(choice.command)}>
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
        {claude?.available &&
          (claude.connected ? (
            <span>
              {t.agents.claudeConnected}{" "}
              <button className="link" onClick={() => void window.frameshell.agents.disconnectClaudeDesktop().then(setClaude)}>
                {t.agents.disconnectClaude}
              </button>
            </span>
          ) : (
            <button className="link" onClick={() => void window.frameshell.agents.connectClaudeDesktop().then(setClaude)}>
              {t.agents.connectClaude}
            </button>
          ))}
        {code?.installed &&
          (code.connected ? (
            <span>
              {t.agents.codeConnected}{" "}
              <button className="link" onClick={() => void window.frameshell.agents.disconnectClaudeCode().then(setCode)}>
                {t.agents.disconnectCode}
              </button>
            </span>
          ) : (
            <button className="link" onClick={() => void window.frameshell.agents.connectClaudeCode().then(setCode)}>
              {t.agents.connectCode}
            </button>
          ))}
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
