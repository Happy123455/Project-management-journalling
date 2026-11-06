import { useState } from "react";
import { minuteClock, minutesText, type PhaseSummary, type RoutineConfig } from "../lib/routine";

/** Categorical slots in fixed order (identity of a routine step); a 9th step and later are grey "other". */
export const STEP_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const stepColor = (index: number) => (index >= 0 && index < STEP_COLORS.length ? STEP_COLORS[index] : "#8a8a85");

/** Catmull-Rom through the points, as a smooth SVG path. */
export function smoothPath(pts: [number, number][]): string {
  if (!pts.length) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * One habit over time: a bar per day/week/month, a smooth curve through them, and the curve's
 * likely path ahead (dashed, lighter). Hover or touch a bar for its count.
 */
export function TrendChart({ values, curve, ahead, labels, aheadLabels }: { values: number[]; curve: number[]; ahead: number[]; labels: string[]; aheadLabels: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 140;
  const pad = { l: 22, r: 6, t: 10, b: 18 };
  const n = values.length + ahead.length;
  const max = Math.max(1, ...values, ...curve, ...ahead);
  const step = (W - pad.l - pad.r) / Math.max(1, n);
  const x = (i: number) => pad.l + step * i + step / 2;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const bw = Math.max(2, Math.min(18, step - 2));
  const curvePts = curve.map((v, i) => [x(i), y(v)] as [number, number]);
  const aheadPts = [curvePts[curvePts.length - 1], ...ahead.map((v, i) => [x(values.length + i), y(v)] as [number, number])].filter(Boolean);
  const tick = Math.ceil(n / 6);
  const all = [...labels, ...aheadLabels];
  const shown = hover === null ? null : hover < values.length ? { label: labels[hover], text: `${values[hover]}` } : { label: aheadLabels[hover - values.length], text: `~${ahead[hover - values.length].toFixed(1)} likely` };
  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Habit over time, with the likely path ahead" onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end" className="axis">{Math.round(max * f * 10) / 10}</text>
          </g>
        ))}
        {values.map((v, i) => (
          <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(0, y(0) - y(v))} rx={Math.min(4, bw / 2)} className={hover === i ? "bar on" : "bar"} />
        ))}
        {curvePts.length > 1 && <path d={smoothPath(curvePts)} className="curve" />}
        {aheadPts.length > 1 && <path d={smoothPath(aheadPts)} className="curve ahead" />}
        {ahead.map((v, i) => <circle key={i} cx={x(values.length + i)} cy={y(v)} r={3} className="ahead-dot" />)}
        {all.map((l, i) => (i % tick === 0 ? <text key={i} x={x(i)} y={H - 4} textAnchor="middle" className="axis">{l}</text> : null))}
        {/* Hit areas wider than the bars. */}
        {all.map((_, i) => <rect key={`h${i}`} x={x(i) - step / 2} y={0} width={step} height={H} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />)}
      </svg>
      <p className="trend-tip" aria-live="polite">{shown ? <><strong>{shown.text}</strong> · {shown.label}</> : " "}</p>
    </div>
  );
}

/** Each life phase's usual day as a bar from 04:00 to 04:00, one under the other, to compare. */
export function PhaseChart({ summaries, config }: { summaries: PhaseSummary[]; config: RoutineConfig }) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 320;
  const row = 30;
  const left = 70;
  const H = summaries.length * row + 20;
  const sx = (m: number) => left + ((W - left - 4) * m) / 1440;
  return (
    <div className="phase-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Your usual day in each phase">
        {[0, 240, 480, 720, 960, 1200].map((m) => (
          <g key={m}>
            <line x1={sx(m)} x2={sx(m)} y1={0} y2={H - 16} className="grid" />
            <text x={sx(m)} y={H - 4} textAnchor="middle" className="axis">{minuteClock(m)}</text>
          </g>
        ))}
        {summaries.map((s, r) => {
          const top = r * row + 6;
          return (
            <g key={s.phase?.id ?? "none"}>
              <text x={0} y={top + 13} className="label">{s.name.slice(0, 11)}</text>
              <rect x={sx(0)} y={top + 4} width={sx(1440) - sx(0)} height={10} rx={5} className="track" />
              {s.wake !== null && s.sleep !== null && s.sleep > s.wake && <rect x={sx(s.wake)} y={top + 4} width={sx(s.sleep) - sx(s.wake)} height={10} rx={5} className="awake" />}
              {s.blocks.filter((b) => config.steps.find((x) => x.id === b.id)?.span).map((b) => {
                const i = config.steps.findIndex((x) => x.id === b.id);
                const step = config.steps[i];
                const id = `${r}|${b.id}`;
                return (
                  <rect
                    key={b.id}
                    x={sx(b.start)}
                    y={top + 2}
                    width={Math.max(3, sx(b.start + b.minutes) - sx(b.start))}
                    height={14}
                    rx={3}
                    fill={stepColor(i)}
                    stroke="var(--chart-surface)"
                    strokeWidth={1}
                    onPointerEnter={() => setHover(id)}
                    onPointerDown={() => setHover(id)}
                  >
                    <title>{`${step?.label ?? b.id}: ${minuteClock(b.start)}, ${minutesText(b.minutes)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
      <p className="trend-tip">
        {(() => {
          if (!hover) return " ";
          const [r, id] = hover.split("|");
          const s = summaries[Number(r)];
          const b = s?.blocks.find((x) => x.id === id);
          const step = config.steps.find((x) => x.id === id);
          return b && step ? <><strong>{step.icon} {step.label}</strong> · {s.name}: usually {minuteClock(b.start)}{b.minutes ? `, ${minutesText(b.minutes)}` : ""}</> : " ";
        })()}
      </p>
      <ul className="phase-legend">
        {config.steps.filter((s) => s.span).map((s) => {
          const i = config.steps.indexOf(s);
          return <li key={s.id}><i style={{ background: stepColor(i) }} />{s.icon} {s.label}</li>;
        })}
      </ul>
    </div>
  );
}
