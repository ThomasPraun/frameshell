// Stand-in for an agent TUI such as Claude Code, for the "Ask agent" e2e test (#49): raw-mode stdin, bracketed
// paste on, the input line echoed as typed. Enter outside a paste submits: it prints SUBMITTED, which the test
// must never see. Ctrl+C quits. Run with `node fake-agent.mjs`.
const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const out = process.stdout;

let pasting = false;
out.write(`${ESC}[?2004h`);
out.write("fake-agent ready\r\n> ");
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (/** @type {string} */ chunk) => {
  let rest = chunk;
  while (rest.length > 0) {
    if (rest.startsWith(PASTE_START) || rest.startsWith(PASTE_END)) {
      pasting = rest.startsWith(PASTE_START);
      rest = rest.slice(PASTE_START.length);
      continue;
    }
    const char = rest.charAt(0);
    rest = rest.slice(1);
    if (char === "\u0003") {
      out.write(`${ESC}[?2004l\r\n`);
      process.exit(0);
    }
    if (char === "\r" || char === "\n") out.write(pasting ? "\r\n  " : "\r\nSUBMITTED\r\n> ");
    else out.write(char);
  }
});
