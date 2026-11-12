import { PLACEHOLDER, type Template, type TemplateInput, type TemplateVariable, fontSetup, pageHead } from "./kit.js";

/**
 * Big word behind the subject (#466, ADR 0032): one huge word whose letters
 * rise through a mask, drifting slowly while it holds. Transparent, built for
 * a video track with `behind` set to the footage track, so the word sits
 * between the background and the person. Its default place is the upper part
 * of the frame, where a head and shoulders shot leaves room.
 */
export const bigWord: Template = {
  id: "big-word",
  description: "Big word behind the subject: huge letters rise through a mask; transparent, for a track with `behind` (ADR 0032)",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "word", type: "string", label: "The word", default: "CREATE", maxLength: 24 },
      { id: "ink", type: "color", label: "Word colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "wordOpacity", type: "number", label: "How solid the word is, 1 = opaque", default: 0.92, min: 0.2, max: 1, step: 0.02 },
      { id: "size", type: "number", label: "Size, 1 = the format's default (a long word shrinks to fit the frame)", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      { id: "drift", type: "number", label: "Slow push while it holds, percent", default: 4, min: 0, max: 10, step: 0.5, unit: "%" },
      {
        id: "place",
        type: "enum",
        label: "Where in the frame",
        default: "auto",
        options: [
          { value: "auto", label: "By format" },
          { value: "upper", label: "Upper third" },
          { value: "center", label: "Centre" },
          { value: "lower", label: "Lower third" },
        ],
      },
      {
        id: "letterCase",
        type: "enum",
        label: "Letter case",
        default: "upper",
        options: [
          { value: "upper", label: "CAPITALS" },
          { value: "as-typed", label: "As typed" },
        ],
      },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #word {
        position: absolute; left: 0; width: 100%; display: flex; justify-content: center; align-items: center; white-space: pre;
        font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1; letter-spacing: -0.02em;
      }
      /* The mask clips a letter while it travels; the padding keeps accents and descenders inside it. */
      .mask { display: inline-block; overflow: hidden; padding: 0.1em 0.03em 0.16em; margin: -0.1em -0.03em -0.16em; }
      .letter { display: inline-block; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="big-word-clip" class="clip">
        <div id="word"></div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);

      // Layout per format (y is the word's centre as a fraction of the frame height; size a fraction of the short side).
      // The word is wider than the head it sits behind, so it only needs the room above the shoulders. wide, square, tall.
      var L = M.pick({ y: 0.42, size: 0.6 }, { y: 0.4, size: 0.5 }, { y: 0.36, size: 0.5 });
      var y = P.place === "upper" ? 0.3 : P.place === "center" ? 0.5 : P.place === "lower" ? 0.7 : L.y;
      var text = P.letterCase === "upper" ? String(P.word).toUpperCase() : String(P.word);
      var letters = Array.from(text);
      var n = letters.length;
      // Heavy capitals are about 0.65 em wide, so the word is capped to 92 % of the frame width without measuring text.
      var px = Math.min(L.size * unit * P.size, (0.92 * S.width) / (Math.max(1, n) * 0.65));

      var word = document.getElementById("word");
      word.style.fontSize = px + "px";
      word.style.color = P.ink;
      word.style.height = px * 1.3 + "px";
      word.style.top = (y * S.height - px * 0.65) + "px";

      var marks = [];
      letters.forEach(function (letter) {
        var mask = document.createElement("span");
        var mark = document.createElement("span");
        mask.className = "mask";
        mark.className = "letter";
        mark.textContent = letter;
        mask.appendChild(mark);
        word.appendChild(mask);
        marks.push(mark);
      });

      var D = S.duration;
      var START = 0.1;
      var OUT = 0.35;
      var rise = px * 1.1;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        for (var i = 0; i < n; i++) {
          var d = M.stagger(i, n, M.STAGGER_STEPS.letters);
          M.write(marks[i], { y: (1 - M.spring("heavy", t - START - d)) * rise, opacity: M.ease("enter", (t - START - d) / 0.2) });
        }
        // Holds never stop: a slow push over the whole clip; the exit fades and sinks a little.
        M.write(word, { scale: 1.04 - 0.04 * M.spring("heavy", t) + (P.drift / 100) * Math.min(1, t / D), y: out * px * 0.12, opacity: P.wordOpacity * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
