// Terminal tabs and windows (TerminalPanel).

const en = {
  terminal: "Terminal",
  /** Panel name as a sentence shows it (lower case in English). */
  terminalName: "terminal",
  terminals: "Terminals",
  starting: "starting…",
  newTerminal: "New terminal",
  closeTerminal: "Close terminal",
  hideTerminal: "Hide terminal",
  sessionTitle: (session: string, agent: string | undefined, detached: boolean) =>
    `${agent ? `Agent ${agent} in session` : "Session"} ${session}${detached ? ", in its own window" : ""}`,
  processExited: (code: number | null) => `process exited with code ${code}`,
};

const es: typeof en = {
  terminal: "Terminal",
  terminalName: "terminal",
  terminals: "Terminales",
  starting: "iniciando…",
  newTerminal: "Nueva terminal",
  closeTerminal: "Cerrar terminal",
  hideTerminal: "Ocultar terminal",
  sessionTitle: (session, agent, detached) =>
    `${agent ? `Agente ${agent} en la sesión` : "Sesión"} ${session}${detached ? ", en su propia ventana" : ""}`,
  processExited: (code) => `el proceso terminó con código ${code}`,
};

export const terminal = { en, es };
