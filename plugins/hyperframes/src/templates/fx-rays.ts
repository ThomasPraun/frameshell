import { fxTemplate } from "./fx-kit.js";

/** Light rays (#802): thin rays that shoot out from a point and turn a little as they fade; additive light. */
export const fxRays = fxTemplate({
  id: "fx-rays",
  description: "Light rays: on each hit thin rays shoot out from a point, turn a little and fade, the light core first; seeded, additive light, transparent overlay",
  count: { default: 12, min: 3, max: 48 },
  life: 0.6,
  at: { x: 0.5, y: 0.5 },
  blend: "lighter",
  draw: String.raw`
        var n = Math.round(P.count), u = age / LIFE;
        var spin = 0.25 * jitter(seed, 1) * u;
        ctx.lineCap = "round";
        for (var i = 0; i < n; i++) {
          var s = 2 * Math.PI * (i + 0.3 * jitter(seed, i + 10)) / n + spin;
          var reach = unit * (0.35 + 0.2 * jitter(seed, i + 50)) * (1 - Math.pow(1 - u, 4));
          var from = reach * 0.35 * u;
          ctx.strokeStyle = alpha(i % 2 ? colors[1] : colors[0], Math.pow(1 - u, 1.5));
          ctx.lineWidth = Math.max(1, 0.008 * unit * (1 - u));
          ctx.beginPath();
          ctx.moveTo(X + Math.cos(s) * from, Y + Math.sin(s) * from);
          ctx.lineTo(X + Math.cos(s) * reach, Y + Math.sin(s) * reach);
          ctx.stroke();
        }
        var core = ctx.createRadialGradient(X, Y, 0, X, Y, 0.08 * unit);
        core.addColorStop(0, alpha(colors[2], 0.8 * Math.pow(1 - u, 3)));
        core.addColorStop(1, alpha(colors[2], 0));
        ctx.fillStyle = core;
        ctx.fillRect(X - 0.08 * unit, Y - 0.08 * unit, 0.16 * unit, 0.16 * unit);`,
});
