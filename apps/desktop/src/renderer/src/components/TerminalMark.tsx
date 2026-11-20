/** The prompt glyph of the app icon (`build/icon.svg`): a chevron and a cursor bar in the brand gradient. */
export function TerminalMark() {
  return (
    <svg className="terminal-mark" viewBox="332 360 366 306" aria-hidden="true">
      <defs>
        <linearGradient id="terminal-mark-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb347" />
          <stop offset="0.55" stopColor="#ff6a3d" />
          <stop offset="1" stopColor="#e8336f" />
        </linearGradient>
      </defs>
      <path d="M372 392 L532 512 L372 632" fill="none" stroke="url(#terminal-mark-gradient)" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="560" y="600" width="130" height="58" rx="29" fill="url(#terminal-mark-gradient)" />
    </svg>
  );
}
