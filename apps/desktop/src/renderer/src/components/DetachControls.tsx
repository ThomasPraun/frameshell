// Controls of detachable panels (ADR 0012): moving a panel to its own window and back.

/**
 * Header button that moves a panel to its own window (`detached` false) or
 * docks it back (`detached` true). `name` completes the labels ("Open
 * `name` in its own window", "Dock `name` back").
 */
export function DetachButton({
  name,
  detached,
  onClick,
  testId,
  disabled = false,
}: {
  name: string;
  detached: boolean;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  const label = detached ? `Dock ${name} back` : `Open ${name} in its own window`;
  return (
    <button className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled} data-testid={testId}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M9 3H13V7M13 3L8 8M7 4H3V13H12V9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          transform={detached ? "rotate(180 8 8)" : undefined}
        />
      </svg>
    </button>
  );
}

/** What stays in a detached panel's slot: where the panel went, and a way back. */
export function DockedElsewhere({ title, onBringBack }: { title: string; onBringBack: () => void }) {
  return (
    <div className="panel-docked-elsewhere" data-testid="panel-docked-elsewhere">
      <p>
        <strong>{title}</strong> is docked in another window
      </p>
      <button className="button" onClick={onBringBack}>
        Bring back
      </button>
    </div>
  );
}
