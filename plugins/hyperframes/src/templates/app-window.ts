import { CAMERA_MATH, CURSOR_CSS, CURSOR_HTML, CURSOR_MATH, CURSOR_SCRIPT, cameraVariables, cursorModeVariable, cursorVariables, hesitateVariable } from "./cursor-kit.js";
import { COLOR_HELPERS, PLACEHOLDER, type Template, type TemplateInput, type TemplateVariable, fontSetup, pageHead, trimScript } from "./kit.js";

/**
 * App window mockup (#466, UI demo): a window in CRM, spreadsheet or inbox style
 * springs in, its rows follow one by one, then a cursor clicks a row and, on that
 * same frame, the row highlight sweeps across, the other rows dim and the
 * window's own state changes (an unread dot clears in the inbox). With the cursor
 * off the click happens at `selectAt`. `then: copy-paste` adds an empty slot row:
 * a key chip shows the copy half a second after the click, the cursor clicks the
 * slot (it lights up on that frame) and the chip of the paste shows as the copied
 * row fills it. `camera: follow` zooms in with the cursor and pulls back after the
 * last beat. A clip too short for the click gets a cursor without its hesitation,
 * then a faster one (timing guard). Always on its own solid background.
 */
export const appWindow: Template = {
  id: "app-window",
  description: "App window mockup (CRM, spreadsheet or inbox): rows come in, a cursor clicks one and its highlight sweeps in on that frame; solid background",
  defaultDuration: 5,
  overlay: false,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "kind",
        type: "enum",
        label: "Kind of window",
        default: "crm",
        options: [
          { value: "crm", label: "CRM: name, company, stage, value" },
          { value: "spreadsheet", label: "Spreadsheet: item and three number columns" },
          { value: "inbox", label: "Inbox: sender, subject, time" },
        ],
      },
      { id: "title", type: "string", label: "Window title", default: "Pipeline", maxLength: 32 },
      {
        id: "rows",
        type: "string",
        label: "Rows separated by |, cells by ; (the first 7 rows are shown); empty = sample rows of the kind",
        default: "",
        maxLength: 600,
      },
      { id: "columns", type: "string", label: "Column headings separated by ;; empty = the kind's own", default: "", maxLength: 120 },
      { id: "select", type: "number", label: "Row the cursor clicks, counted from 1", default: 3, min: 1, max: 7, step: 1 },
      {
        id: "then",
        type: "enum",
        label: "What happens after the click",
        default: "none",
        options: [
          { value: "none", label: "Nothing: the row stays selected" },
          { value: "copy-paste", label: "Copy and paste: the row is copied into an empty slot at the bottom" },
        ],
      },
      {
        id: "keys",
        type: "enum",
        label: "Shortcut chips of the copy and the paste",
        default: "mac",
        options: [
          { value: "mac", label: "Mac: Cmd C and Cmd V" },
          { value: "windows", label: "Windows: Ctrl C and Ctrl V" },
        ],
      },
      cursorModeVariable(),
      { id: "selectAt", type: "number", label: "Seconds until the click when the cursor is off", default: 1.8, min: 0.5, max: 4, step: 0.1, unit: "s" },
      hesitateVariable(0.25),
      ...cameraVariables(),
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Highlight colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Window colour", default: tokens.colors.card ?? "#161d33" },
      ...cursorVariables(),
      { id: "size", type: "number", label: "Row size, 1 = the format's default", default: 1, min: 0.6, max: 1.5, step: 0.05 },
      { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #bgfill { position: absolute; inset: 0; }
      #world { position: absolute; inset: 0; }
      #win { position: absolute; overflow: hidden; border-radius: 0.9em; font-family: ${fonts.ui}; box-shadow: 0 1.6em 3.6em rgba(0, 0, 0, 0.45); }
      #bar { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: center; font-weight: 600; }
      #dots { position: absolute; left: 1em; top: 50%; margin-top: -0.3em; display: flex; gap: 0.45em; }
      #dots i { width: 0.6em; height: 0.6em; border-radius: 50%; }
      #head, .row { position: absolute; left: 0; right: 0; }
      .cell { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; padding: 0 0.8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cell.r { justify-content: flex-end; }
      #head .cell { font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
      .hl { position: absolute; inset: 0; transform-origin: 0 50%; }
      .edge { position: absolute; left: 0; top: 0; bottom: 0; width: 0.28em; transform-origin: 0 50%; }
      .cells { position: absolute; inset: 0; }
      .chip { padding: 0.18em 0.7em; border-radius: 999px; font-size: 0.86em; font-weight: 600; }
      .slot, .slot-on { position: absolute; inset: 0.3em 0.5em; border: 0.12em dashed; border-radius: 0.5em; }
      .kbd { position: absolute; display: flex; align-items: center; justify-content: center; white-space: pre; font-weight: 700; border-radius: 0.45em; }
      .dot { position: absolute; left: 0.55em; top: 50%; width: 0.6em; height: 0.6em; margin-top: -0.3em; border-radius: 50%; }
      ${CURSOR_CSS}`;
    return trimScript(`${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="app-window-clip" class="clip">
        <div id="bgfill"></div>
        <div id="world">
          <div id="win">
            <div id="bar"><div id="dots"><i></i><i></i><i></i></div><span id="win-title"></span></div>
            <div id="head"></div>
            <div id="rows"></div>
          </div>
          <div id="kbd-copy" class="kbd"></div>
          <div id="kbd-paste" class="kbd"></div>
          ${CURSOR_HTML}
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${CURSOR_MATH}
      ${CAMERA_MATH}
      ${CURSOR_SCRIPT}

      var bgfill = document.getElementById("bgfill");
      bgfill.style.background = "radial-gradient(ellipse at 50% 40%, " + mix(P.bg, "#ffffff", 0.09) + " 0%, " + P.bg + " 72%)";

      // What each kind shows: headings, column widths, alignment, and the columns kept on a tall frame.
      var KINDS = {
        crm: {
          head: ["Name", "Company", "Stage", "Value"], w: [0.3, 0.28, 0.24, 0.18], align: ["l", "l", "chip", "r"], tall: [0, 2, 3],
          sample: "Ada Lovelace;Analytical Engines;Proposal;$18,400|Grace Hopper;COBOL Labs;Negotiation;$42,000|Alan Turing;Enigma Co;Qualified;$9,800|Katherine Johnson;Orbit Works;Won;$27,500|Margaret Hamilton;Apollo Software;Proposal;$31,200"
        },
        spreadsheet: {
          head: ["Item", "Jan", "Feb", "Mar"], w: [0.34, 0.22, 0.22, 0.22], align: ["l", "r", "r", "r"], tall: [0, 1, 2],
          sample: "Hosting;1,240;1,310;1,290|Salaries;18,400;18,400;19,100|Software;2,150;2,380;2,610|Travel;860;1,420;990|Marketing;4,300;3,900;5,200"
        },
        inbox: {
          head: ["Sender", "Subject", "Time"], w: [0.26, 0.54, 0.2], align: ["l", "l", "r"], tall: [0, 1, 2],
          sample: "Ada Lovelace;Notes on the engine;9:41|Grace Hopper;Compiler draft attached;9:12|Alan Turing;Re: the imitation game;8:50|Katherine Johnson;Trajectory check;Yesterday|Margaret Hamilton;Landing software review;Yesterday"
        }
      };
      var kind = KINDS[P.kind] || KINDS.crm;
      var tallFrame = S.format === "tall";
      var shown = tallFrame ? kind.tall : kind.head.map(function (unused, i) { return i; });
      var sum = 0;
      shown.forEach(function (c) { sum += kind.w[c]; });
      var headings = String(P.columns).trim() ? String(P.columns).split(";").map(function (cell) { return cell.trim(); }) : kind.head;
      var copying = P.then === "copy-paste";
      // The copy needs a free slot below the rows, so one row fewer is shown.
      var table = (String(P.rows).trim() || kind.sample).split("|").map(function (row) {
        return row.split(";").map(function (cell) { return cell.trim(); });
      }).slice(0, copying ? 6 : 7);
      var n = table.length;
      var slots = n + (copying ? 1 : 0);
      var picked = Math.min(n, Math.max(1, Math.round(P.select))) - 1;

      // Layout per format: the window's width as a fraction of the frame, and the row height as a fraction of the short side. wide, square, tall.
      var L = M.pick({ w: 0.7, row: 0.1 }, { w: 0.86, row: 0.095 }, { w: 0.94, row: 0.11 });
      var winW = L.w * S.width;
      var barH = unit * 0.075;
      var headH = unit * 0.07;
      var rh = Math.min(L.row * unit * P.size, (0.8 * S.height - barH - headH) / slots);
      var winH = barH + headH + slots * rh;
      var wx = (S.width - winW) / 2;
      var wy = (S.height - winH) / 2;
      var fs = rh * 0.36;

      var win = document.getElementById("win");
      win.style.cssText += "left:" + wx + "px;top:" + wy + "px;width:" + winW + "px;height:" + winH + "px;font-size:" + fs + "px;color:" + P.ink + ";background:" + P.card;
      var bar = document.getElementById("bar");
      bar.style.height = barH + "px";
      bar.style.borderBottom = "1px solid " + alpha(P.ink, 0.1);
      bar.style.color = alpha(P.ink, 0.75);
      document.getElementById("win-title").textContent = P.title;
      var dots = document.getElementById("dots").children;
      for (var d = 0; d < dots.length; d++) dots[d].style.background = alpha(P.ink, 0.3);

      // Fills a row element with its cells.
      function cells(holder, values, header) {
        var x = 0;
        shown.forEach(function (c) {
          var cell = document.createElement("div");
          var w = (kind.w[c] / sum) * winW;
          var align = kind.align[c];
          cell.className = "cell" + (align === "r" ? " r" : "");
          cell.style.left = x + "px";
          cell.style.width = w + "px";
          if (c > 0 && P.kind === "spreadsheet") cell.style.borderLeft = "1px solid " + alpha(P.ink, 0.08);
          var text = values[c] === undefined ? "" : values[c];
          if (align === "chip" && !header) {
            var chip = document.createElement("span");
            chip.className = "chip";
            chip.style.background = alpha(P.accent, 0.22);
            chip.textContent = text;
            cell.appendChild(chip);
          } else {
            cell.textContent = text;
          }
          if (header) cell.style.color = alpha(P.ink, 0.5);
          if (c === 0 && P.kind === "inbox" && !header) cell.style.paddingLeft = "1.6em";
          holder.appendChild(cell);
          x += w;
        });
      }
      var head = document.getElementById("head");
      head.style.cssText += "top:" + barH + "px;height:" + headH + "px;border-bottom:1px solid " + alpha(P.ink, 0.1);
      cells(head, headings, true);

      var holder = document.getElementById("rows");
      var rowEls = [];
      for (var i = 0; i < n; i++) {
        var row = document.createElement("div");
        row.className = "row";
        row.style.cssText += "top:" + (barH + headH + i * rh) + "px;height:" + rh + "px;border-bottom:1px solid " + alpha(P.ink, 0.07);
        row.innerHTML = '<i class="hl"></i><i class="edge"></i><div class="cells"></div>';
        var wash = row.children[0];
        wash.style.background = alpha(P.accent, 0.22);
        row.children[1].style.background = P.accent;
        cells(row.children[2], table[i], false);
        // Unread mail has a dot; reading the picked one is the window's own reaction to the click.
        var unread = null;
        if (P.kind === "inbox" && (i < 3 || i === picked)) {
          unread = document.createElement("i");
          unread.className = "dot";
          unread.style.background = P.accent;
          row.children[2].firstChild.appendChild(unread);
        }
        holder.appendChild(row);
        rowEls.push({ row: row, wash: wash, edge: row.children[1], cells: row.children[2], dot: unread });
      }

      // The empty slot below the rows: it takes a copy of the picked row (dashed outline until the paste).
      var slotRow = null;
      if (copying) {
        var holderRow = document.createElement("div");
        holderRow.className = "row";
        holderRow.style.cssText += "top:" + (barH + headH + n * rh) + "px;height:" + rh + "px;border-bottom:1px solid " + alpha(P.ink, 0.07);
        holderRow.innerHTML = '<i class="hl"></i><i class="edge"></i><div class="cells"></div><i class="slot"></i><i class="slot-on"></i>';
        holderRow.children[0].style.background = alpha(P.accent, 0.22);
        holderRow.children[1].style.background = P.accent;
        cells(holderRow.children[2], table[picked], false);
        holderRow.children[3].style.borderColor = alpha(P.ink, 0.28);
        holderRow.children[4].style.borderColor = P.accent;
        holder.appendChild(holderRow);
        slotRow = { row: holderRow, wash: holderRow.children[0], edge: holderRow.children[1], cells: holderRow.children[2], slot: holderRow.children[3], on: holderRow.children[4] };
      }

      // Shortcut chips that show the copy and the paste, at the right end of the row they act on.
      var chipPx = fs * 0.9;
      var chipText = P.keys === "windows" ? ["Ctrl C", "Ctrl V"] : ["\u2318 C", "\u2318 V"];
      var chipW = (chipText[0].length * 0.62 + 1.6) * chipPx;
      var chipH = chipPx * 2.2;
      var chipLeft = wx + winW - chipW - 1.1 * chipPx;
      var chips = [document.getElementById("kbd-copy"), document.getElementById("kbd-paste")];
      chips.forEach(function (chip, k) {
        var rowCentre = wy + barH + headH + ((k === 0 ? picked : n) + 0.5) * rh;
        chip.textContent = chipText[k];
        chip.style.cssText += "left:" + chipLeft + "px;top:" + (rowCentre - chipH / 2) + "px;width:" + chipW + "px;height:" + chipH + "px;font-size:" + chipPx + "px;color:" + P.ink + ";background:" + mix(P.card, P.ink, 0.2) + ";border:1px solid " + alpha(P.ink, 0.3) + ";box-shadow:0 0.3em 0.9em rgba(0, 0, 0, 0.35);" + (copying ? "" : "display:none;");
      });

      // The click lands on the picked row, a little right of the first cell; the cursor then drifts to the window's lower right (below the slot when copying).
      var target = { x: wx + winW * 0.3, y: wy + barH + headH + (picked + 0.5) * rh };
      var slotTarget = { x: wx + winW * 0.3, y: wy + barH + headH + (n + 0.5) * rh };
      var base = copying ? slotTarget : target;
      var rest = inFrame({ x: wx + winW * 0.78, y: Math.min(wy + winH - rh * 0.3, base.y + (copying ? rh * 0.5 : rh * 2)) }, 0.05);
      var useCursor = P.cursor === "on";
      var follow = P.camera === "follow" && useCursor;
      // The click is the one moment the highlight, the dimming and the window's own state share; the copy follows 0.5 s later, then the click on the slot and, 0.45 s after it, the paste.
      var made = fitFirst(CURSOR_TRIES, function (hesitate, rate) {
        var stops = [{ x: target.x, y: target.y, hesitate: P.hesitate * hesitate, wait: copying ? 0.74 : 0.54 }];
        if (copying) stops.push({ x: slotTarget.x, y: slotTarget.y, hesitate: P.hesitate * hesitate * 0.5, wait: 0.89 });
        stops.push({ x: rest.x, y: rest.y, weight: "light", bend: 0.2 });
        var trip = journey(FROM, stops, START, { x: 0.004 * unit, y: 0.003 * unit }, rate);
        var click = trip.legs[0].arrive + 0.04;
        var click2 = copying ? trip.legs[1].arrive + 0.04 : click;
        return { trip: trip, click: click, click2: click2, ready: copying ? click2 + 0.45 : click };
      }, latest(copying ? 0.6 : 0.5));
      var trip = made.trip;
      var clickAt = useCursor ? made.click : Math.max(0.3, Math.min(P.selectAt, latest(copying ? 2.2 : 0.5)));
      var copyAt = clickAt + 0.5;
      var slotAt = useCursor ? made.click2 : clickAt + 1.25;
      var pasteAt = slotAt + 0.45;
      var camIn = Math.max(0.5, clickAt - 0.1);
      var camOut = Math.max((copying ? pasteAt : clickAt) + 0.3, Math.min((copying ? pasteAt : clickAt) + 0.9, latest(0.7)));

      var world = document.getElementById("world");
      var D = S.duration;
      var OUT = 0.3;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        // Holds never stop: a slow push over the whole clip, or the follow camera.
        if (follow) {
          var cam = camera(trip.at(Math.max(0, t - 0.12)), zoomAt(t, 0.1, camIn, camOut, camOut + 0.7), P.zoom);
          put(world, { x: cam.x, y: cam.y, scale: cam.scale * (1 - 0.02 * out), opacity: 1 - out });
        } else {
          put(world, { scale: 1 + 0.03 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });
        }
        var s = M.spring("default", t - 0.05);
        put(win, { y: (1 - s) * unit * 0.06, scale: 0.95 + 0.05 * s, opacity: M.ease("enter", (t - 0.05) / 0.25) });

        var chosen = M.ease("snap", (t - clickAt) / 0.15);
        for (var k = 0; k < n; k++) {
          var r = rowEls[k];
          var at = 0.25 + M.stagger(k, slots, M.STAGGER_STEPS.items);
          var mine = k === picked;
          var sweep = mine ? M.spring("default", t - clickAt) : 0;
          put(r.row, { x: (1 - M.spring("default", t - at)) * -rh * 0.4, opacity: M.ease("enter", (t - at) / 0.2) });
          put(r.wash, { scaleX: sweep, opacity: mine ? 1 : 0 });
          put(r.edge, { scaleX: mine ? M.spring("snappy", t - clickAt) : 0, opacity: mine ? 1 : 0 });
          // The copy blinks the picked row once.
          var blink = mine ? M.ease("snap", (t - copyAt) / 0.08) * (1 - M.ease("enter", (t - copyAt - 0.08) / 0.25)) : 0;
          put(r.cells, { opacity: (mine ? 1 : 1 - 0.45 * chosen) * (copying ? 1 - 0.4 * blink : 1) });
          if (r.dot) put(r.dot, { scale: mine ? 1 - chosen : 1, opacity: mine ? 1 - chosen : 1 });
        }

        if (slotRow) {
          var sat = 0.25 + M.stagger(n, slots, M.STAGGER_STEPS.items);
          var pasted = M.spring("default", t - pasteAt);
          put(slotRow.row, { x: (1 - M.spring("default", t - sat)) * -rh * 0.4, opacity: M.ease("enter", (t - sat) / 0.2) });
          put(slotRow.slot, { opacity: 1 - M.ease("snap", (t - pasteAt) / 0.12) });
          put(slotRow.on, { opacity: M.ease("snap", (t - slotAt) / 0.12) * (1 - M.ease("snap", (t - pasteAt) / 0.12)) });
          put(slotRow.wash, { scaleX: pasted, opacity: M.ease("enter", (t - pasteAt) / 0.1) * (1 - 0.55 * M.ease("enter", (t - pasteAt - 0.3) / 0.4)) });
          put(slotRow.edge, { scaleX: M.spring("snappy", t - pasteAt), opacity: M.ease("enter", (t - pasteAt) / 0.05) * (1 - M.ease("enter", (t - pasteAt - 0.3) / 0.4)) });
          put(slotRow.cells, { x: (1 - pasted) * -rh * 0.3, opacity: M.ease("enter", (t - pasteAt) / 0.15) });
          [copyAt, pasteAt].forEach(function (at, c) {
            var pop = M.spring("snappy", t - at);
            put(chips[c], { y: (1 - pop) * chipH * 0.5, scale: 0.8 + 0.2 * pop, opacity: M.ease("enter", (t - at) / 0.1) * (1 - M.ease("enter", (t - at - 0.55) / 0.2)) });
          });
        }

        var cp = press(t, clickAt, clickAt + 0.1) * (copying ? press(t, slotAt, slotAt + 0.1) : 1);
        if (useCursor) {
          var second = copying && t >= slotAt;
          drawRipple(t, second ? slotAt : clickAt, second ? slotTarget.x : target.x, second ? slotTarget.y : target.y);
          drawCursor(trip.at(t), cp);
        } else {
          put(rippleEl, { opacity: 0 });
          put(cursorEl, { opacity: 0 });
        }
      });
    </script>
  </body>
</html>
`);
  },
};
