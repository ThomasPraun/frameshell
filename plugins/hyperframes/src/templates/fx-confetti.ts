import { fxTemplate } from "./fx-kit.js";

/** Confetti (#802): paper pieces thrown up from a point, fluttering and turning as they fall; solid pieces. */
export const fxConfetti = fxTemplate({
  id: "fx-confetti",
  description: "Confetti: paper pieces are thrown up from a point on each hit, flutter, flip and fall, in the two colours and a light one; seeded, transparent overlay",
  count: { default: 40, min: 6, max: 120 },
  life: 1.8,
  at: { x: 0.5, y: 0.75 },
  blend: "source-over",
  draw: String.raw`
        var n = Math.round(P.count), u = age / LIFE, k = 3, fall = 0.32 * unit;
        var out = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
        for (var i = 0; i < n; i++) {
          var s = -Math.PI / 2 + 1.05 * jitter(seed, i);
          var v = (1.6 + 0.6 * jitter(seed, i + 300)) * unit;
          var d = v * (1 - Math.exp(-k * age)) / k;
          var phase = 3 * jitter(seed, i + 600);
          var x = X + Math.cos(s) * d + 0.04 * unit * Math.sin(age * 6 + phase);
          // Thrown up against drag, then falling at a steady speed like paper.
          var y = Y + Math.sin(s) * d + fall * (1 + 0.3 * jitter(seed, i + 1200)) * age;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(phase + age * (4 + 3 * jitter(seed, i + 900)));
          ctx.scale(1, Math.cos(age * 9 + phase));
          ctx.globalAlpha *= out;
          ctx.fillStyle = colors[i % 3];
          ctx.fillRect(-0.012 * unit, -0.0065 * unit, 0.024 * unit, 0.013 * unit);
          ctx.restore();
        }`,
});
