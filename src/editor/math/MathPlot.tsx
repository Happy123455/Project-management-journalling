import { useMemo } from "react";
import { formatAnswer, type Vars } from "../../lib/mathEval";
import { sample } from "../../lib/mathSmart";
import { smoothPath } from "../../routine/charts";

const short = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${formatAnswer(Math.round(v / 1e5) / 10)}M`;
  if (a >= 1e4) return `${formatAnswer(Math.round(v / 100) / 10)}k`;
  return formatAnswer(Math.round(v * 100) / 100);
};

/** A line chart of the block's expression as one variable runs across a range; the current value is marked. */
export function MathPlot({ expr, vars, name, from, to, at, yName }: { expr: string; vars: Vars; name: string; from: number; to: number; at?: number; yName: string }) {
  const pts = useMemo(() => sample(expr, vars, name, from, to, 80), [expr, vars, name, from, to]);
  if (pts.length < 2) return <p className="hint">Nothing to draw: the formula has no value over {name} = {short(from)}…{short(to)}.</p>;
  const W = 320;
  const H = 160;
  const pad = { l: 40, r: 10, t: 12, b: 22 };
  let lo = Math.min(...pts.map((p) => p[1]));
  let hi = Math.max(...pts.map((p) => p[1]));
  if (hi - lo < 1e-9) (lo -= 1), (hi += 1);
  const x = (v: number) => pad.l + ((v - from) / (to - from || 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const line = smoothPath(pts.map(([a, b]) => [x(a), y(b)]));
  const area = `${line} L${x(pts[pts.length - 1][0]).toFixed(1)},${(H - pad.b).toFixed(1)} L${x(pts[0][0]).toFixed(1)},${(H - pad.b).toFixed(1)} Z`;
  const here = at !== undefined ? pts.reduce((best, p) => (Math.abs(p[0] - at) < Math.abs(best[0] - at) ? p : best)) : null;
  return (
    <figure className="math-plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${yName} as ${name} changes`}>
        <defs>
          <linearGradient id="mp-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" className="mp-fill-top" />
            <stop offset="1" className="mp-fill-bottom" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(lo + (hi - lo) * f)} y2={y(lo + (hi - lo) * f)} className="grid" />
            <text x={pad.l - 4} y={y(lo + (hi - lo) * f) + 3} textAnchor="end" className="axis">{short(lo + (hi - lo) * f)}</text>
          </g>
        ))}
        {[from, (from + to) / 2, to].map((v, i) => (
          <text key={i} x={x(v)} y={H - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} className="axis">{short(v)}</text>
        ))}
        <path d={area} fill="url(#mp-fill)" />
        <path d={line} className="curve" />
        {here && (
          <g>
            <line x1={x(here[0])} x2={x(here[0])} y1={pad.t} y2={H - pad.b} className="mp-now" />
            <circle cx={x(here[0])} cy={y(here[1])} r={4.5} className="mp-dot" />
          </g>
        )}
      </svg>
      <figcaption>
        {yName} as <strong>{name}</strong> goes {short(from)} → {short(to)}
        {here && <> · at {name} = {short(here[0])}: <strong>{short(here[1])}</strong></>}
      </figcaption>
    </figure>
  );
}
