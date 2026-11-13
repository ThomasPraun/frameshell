import { kitScript } from "./kit.js";

/**
 * Page-script math of a typed line, shared by `typing-field` and `comment-box`
 * (the tries feed `fitFirst` of the cursor kit): the seeded, uneven rhythm, and
 * the tries of the timing guard.
 */
export const TYPING_MATH = kitScript(String.raw`
      // Each character takes 1/speed seconds, stretched or squeezed by 30 % with a fixed pseudo-random wobble (a space takes 40 % longer), so the same text always types the same way. Returns when each character appears and when the last one has.
      function rhythm(chars, from, speed) {
        var when = [];
        var clock = from;
        chars.forEach(function (ch, k) {
          when.push(clock);
          var wobble = Math.sin((k + 1) * 12.9898) * 43758.5453;
          clock += (1 / speed) * (0.7 + 0.6 * (wobble - Math.floor(wobble))) * (ch === " " ? 1.4 : 1);
        });
        return { when: when, end: clock };
      }
      // Tries of the timing guard for a typed line, as (typing speed factor, seconds the progress line takes): as asked, a shorter progress line, then faster typing up to 9 times.
      function typingTries(run) {
        var short = Math.min(run, 0.5);
        return [[1, run], [1, short], [1.5, short], [2, 0.4], [3, 0.4], [4, 0.4], [6, 0.4], [9, 0.4]];
      }`);
