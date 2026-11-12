import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  pageHead,
} from "./kit.js";
import { UI_HELPERS, WINDOW_DOTS_CSS, WINDOW_DOTS_HTML } from "./ui-parts.js";

/**
 * Terminal (#466): a window where a command types out, then tasks run one
 * after another (a ring spins, then a check ticks) and a last line lands.
 * Tasks are one `|`-separated prop. The window keeps its final size from the
 * first frame, and the whole run shrinks to fit a short clip. Transparent
 * around the window unless `backdrop` is raised.
 */
export const terminal: Template = {
  id: "terminal",
  description: "Terminal window: a command types out, then tasks spin and tick one by one; transparent unless a background is set",
  defaultDuration: 6,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "title", type: "string", label: "Window title; empty for none", default: "zsh: ~/project", maxLength: 40 },
      { id: "prompt", type: "string", label: "Prompt symbol before the command", default: "$", maxLength: 6 },
      { id: "command", type: "string", label: "Command that types out", default: "frameshell export --preset reels", maxLength: 120 },
      {
        id: "tasks",
        type: "string",
        label: "Tasks separated by | (the first 6 are shown); each spins, then ticks",
        default: "Transcribe the interview|Cut the silences|Render 9:16",
        maxLength: 300,
      },
      { id: "result", type: "string", label: "Last line once every task is ticked; empty for none", default: "Done in 4.2 s", maxLength: 60 },
      { id: "startAt", type: "number", label: "Seconds until typing starts", default: 0.6, min: 0.2, max: 3, step: 0.1, unit: "s" },
      { id: "typeSpeed", type: "number", label: "Characters typed per second", default: 28, min: 8, max: 80, step: 1 },
      { id: "taskGap", type: "number", label: "Seconds each task takes", default: 0.8, min: 0.2, max: 3, step: 0.05, unit: "s" },
      { id: "card", type: "color", label: "Window colour", default: tokens.colors.card ?? "#0e1424" },
      { id: "accent", type: "color", label: "Prompt, ring and tick colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const css = `
      ${BACKDROP_CSS}
      ${WINDOW_DOTS_CSS}
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #win { overflow: hidden; border-radius: 0.7em; box-shadow: 0 0.8em 2.2em rgba(0, 0, 0, 0.4); font-family: ui-monospace, monospace; }
      #bar { position: relative; display: flex; align-items: center; padding: 0.8em 1em; }
      #win-title { position: absolute; left: 0; right: 0; text-align: center; font-size: 0.8em; opacity: 0.6; }
      #body { padding: 0.9em 1.3em 1.3em; line-height: 1.55; }
      #cmd { white-space: pre-wrap; word-break: break-all; min-height: 1.55em; }
      #ps { margin-right: 0.6em; font-weight: 700; }
      .cur { position: relative; display: inline-block; vertical-align: top; width: 0; height: 1.55em; }
      #caret { position: absolute; left: 0.05em; top: 0.2em; width: 0.55em; height: 1.1em; }
      #rest { visibility: hidden; }
      #tasks { list-style: none; margin-top: 0.5em; }
      .task { display: flex; align-items: center; gap: 0.7em; min-width: 0; line-height: 1.75; }
      .mark { position: relative; flex: none; width: 1.05em; height: 1.05em; }
      .ring { position: absolute; inset: 0.08em; border-radius: 50%; border: 0.13em solid; }
      .ok { position: absolute; inset: 0; border-radius: 50%; }
      .ok i { position: absolute; left: 34%; top: 14%; width: 27%; height: 52%; border: solid; border-width: 0 0.13em 0.13em 0; transform: rotate(45deg); }
      .label { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #result { margin-top: 0.45em; font-weight: 700; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="terminal-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="win">
            <div id="bar">${WINDOW_DOTS_HTML}<span id="win-title"></span></div>
            <div id="body">
              <p id="cmd"><span id="ps"></span><span id="typed"></span><span class="cur"><i id="caret"></i></span><span id="rest"></span></p>
              <ul id="tasks"></ul>
              <p id="result"></p>
            </div>
          </div>
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${UI_HELPERS}
      ${BACKDROP_SETUP}

      // Layout per format: window width as a fraction of the frame, type size as a fraction of the short side. wide, square, tall.
      var L = M.pick({ w: 0.62, fs: 0.036 }, { w: 0.84, fs: 0.034 }, { w: 0.9, fs: 0.036 });
      var command = String(P.command);
      var sigil = String(P.prompt);
      var taskTexts = parts(P.tasks, 6);
      var n = taskTexts.length;
      var winW = L.w * S.width;
      var fs = L.fs * unit * P.size;
      // Estimated height in lines (a character is about 0.6 em wide): shrink the type so a long command keeps the window in the frame.
      var cpl = Math.max(8, Math.floor((winW - 2.6 * fs) / (0.6 * fs)));
      var cmdLines = Math.max(1, Math.ceil((sigil.length + 1 + command.length) / cpl));
      var rows = 3 + cmdLines * 1.55 + n * 1.75 + (P.result ? 2 : 0);
      if (rows * fs > 0.86 * S.height) fs = (0.86 * S.height) / rows;

      var ink = onColor(P.card);
      var win = document.getElementById("win");
      win.style.width = winW + "px";
      win.style.fontSize = fs + "px";
      win.style.background = P.card;
      win.style.color = ink;
      var bar = document.getElementById("bar");
      bar.style.background = mix(P.card, ink, 0.08);
      var title = document.getElementById("win-title");
      title.textContent = P.title;

      var ps = document.getElementById("ps");
      ps.textContent = sigil;
      ps.style.color = P.accent;
      var typed = document.getElementById("typed");
      var rest = document.getElementById("rest");
      rest.textContent = command;
      var caret = document.getElementById("caret");
      caret.style.background = ink;

      var list = document.getElementById("tasks");
      var items = taskTexts.map(function (text) {
        var row = document.createElement("li");
        row.className = "task";
        row.innerHTML = '<span class="mark"><i class="ring"></i><i class="ok"><i></i></i></span><span class="label"></span>';
        row.lastChild.textContent = text;
        var mark = row.firstChild;
        mark.firstChild.style.borderColor = rgba(ink, 0.18);
        mark.firstChild.style.borderTopColor = P.accent;
        mark.lastChild.style.background = P.accent;
        mark.lastChild.firstChild.style.borderColor = onColor(P.accent);
        list.appendChild(row);
        return { row: row, ring: mark.firstChild, ok: mark.lastChild, label: row.lastChild };
      });
      var result = document.getElementById("result");
      result.textContent = P.result;
      result.style.color = P.accent;
      if (!P.result) result.style.display = "none";

      var D = S.duration;
      var OUT = 0.3;
      // The run is typing, a pause, n tasks and the last line. In a clip too short for it, the speeds scale up together.
      var needed = command.length / P.typeSpeed + 0.35 + n * P.taskGap + (P.result ? 0.4 : 0);
      var fit = Math.max(0.3, Math.min(1, (D - OUT - P.startAt - 0.4) / Math.max(needed, 0.1)));
      var cps = P.typeSpeed / fit;
      var gap = P.taskGap * fit;
      var runAt = P.startAt + command.length / cps + 0.35 * fit;
      var rise = fs * 0.8;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        var s = M.spring("heavy", t - 0.05);
        M.write(win, { y: (1 - s) * unit * 0.04, scale: 0.95 + 0.05 * s + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", t / 0.25) * (1 - out) });

        var count = typedCount(t, P.startAt, cps, command.length);
        typed.textContent = command.slice(0, count);
        rest.textContent = command.slice(count);
        var typing = t >= P.startAt && count < command.length;
        M.write(caret, { opacity: t < runAt && caretOn(t, typing) ? 1 : 0 });

        for (var i = 0; i < n; i++) {
          var it = items[i];
          var at = runAt + i * gap;
          var doneAt = at + gap * 0.85;
          M.write(it.row, { x: (1 - M.spring("default", t - at)) * -rise, opacity: M.ease("enter", (t - at) / 0.2) });
          M.write(it.ring, { rotate: (t - at) * 540, opacity: t >= doneAt ? 0 : 1 });
          M.write(it.ok, { scale: 0.3 + 0.7 * M.spring("snappy", t - doneAt), opacity: M.ease("enter", (t - doneAt) / 0.1) });
          M.write(it.label, { opacity: 1 - 0.3 * M.ease("enter", (t - doneAt) / 0.25) });
        }
        var last = runAt + n * gap;
        M.write(result, { y: (1 - M.spring("default", t - last)) * rise * 0.5, opacity: M.ease("enter", (t - last) / 0.25) });
      });
    </script>
  </body>
</html>
`;
  },
};
