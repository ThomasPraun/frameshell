import { fxTemplate } from "./fx-kit.js";

/** Sparks (#802): a burst of hot streaks that fly out from a point, slow, sag and burn out; additive light. */
export const fxSparks = fxTemplate({
  id: "fx-sparks",
  description: "Sparks: a burst of hot streaks flies out from a point on each hit, slows, sags and burns out; seeded, additive light, transparent overlay",
  count: { default: 28, min: 4, max: 120 },
  life: 0.9,
  at: { x: 0.5, y: 0.5 },
  blend: "lighter",
  draw: String.raw`
        var n = Math.round(P.count), u = age / LIFE, k = 2.6, g = 0.45 * unit;
        function pos(a, s, v) { var d = v * (1 - Math.exp(-k * a)) / k; return [X + Math.cos(s) * d, Y + Math.sin(s) * d + 0.5 * g * a * a]; }
        ctx.lineCap = "round";
        for (var i = 0; i < n; i++) {
          var s = 2 * Math.PI * (i + 0.5 * jitter(seed, i)) / n;
          var v = (1.7 + 0.8 * jitter(seed, i + 200)) * unit;
          var tail = Math.max(0, age - 0.07);
          var a = pos(tail, s, v), b = pos(age, s, v);
          var glow = Math.pow(1 - u, 1.6);
          ctx.strokeStyle = alpha(i % 3 === 0 ? colors[1] : colors[0], glow);
          ctx.lineWidth = Math.max(1.5, 0.008 * unit * (1 - 0.5 * u));
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
          ctx.fillStyle = alpha(colors[2], glow);
          ctx.beginPath(); ctx.arc(b[0], b[1], Math.max(1, 0.006 * unit * (1 - u)), 0, 2 * Math.PI); ctx.fill();
        }`,
});
