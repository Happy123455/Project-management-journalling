import { useEffect, useRef, useState } from "react";
import { formatAnswer } from "../../lib/mathEval";
import { niceRange, niceStep } from "../../lib/mathSmart";

/** How a variable is changed by hand in a math block. */
export type ControlKind = "slider" | "wheel" | "dial" | "tumbler";
export const CONTROL_KINDS: { id: ControlKind; label: string; icon: string }[] = [
  { id: "slider", label: "Slider", icon: "🎚️" },
  { id: "wheel", label: "Picker wheel", icon: "🎡" },
  { id: "dial", label: "Scroll wheel", icon: "🛞" },
  { id: "tumbler", label: "Tumbler", icon: "🔢" },
];

interface Props {
  name: string;
  value: number;
  /** The value written in the note (the reset point and the centre of the range). */
  base: number;
  onChange: (v: number) => void;
}

const round = (v: number, step: number) => {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return Number((Math.round(v / step) * step).toFixed(Math.min(10, decimals)));
};

function Slider({ value, base, onChange }: Props) {
  const step = niceStep(base);
  const [lo, hi] = niceRange(base);
  const min = Math.min(lo, value);
  const max = Math.max(hi, value);
  return (
    <input
      type="range"
      className="mc-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(round(Number(e.target.value), step))}
      style={{ "--fill": `${((value - min) / (max - min || 1)) * 100}%` } as React.CSSProperties}
    />
  );
}

/** A vertical picker like a phone's time picker: values roll past a centre window and snap. */
function Wheel({ value, base, onChange }: Props) {
  const step = niceStep(base);
  const ITEM = 30;
  const N = 40;
  // The list is built around the current value; after each pick it re-centres (the same value stays
  // in the window), so the wheel never runs out.
  const centre = value;
  const box = useRef<HTMLDivElement>(null);
  const settle = useRef(0);
  const [top, setTop] = useState(N * ITEM);
  useEffect(() => {
    if (box.current) box.current.scrollTop = N * ITEM;
    setTop(N * ITEM);
  }, [centre]);
  const values = Array.from({ length: 2 * N + 1 }, (_, i) => round(centre + (i - N) * step, step));
  return (
    <div
      ref={box}
      className="mc-wheel"
      onScroll={(e) => {
        const t = e.currentTarget.scrollTop;
        setTop(t);
        window.clearTimeout(settle.current);
        settle.current = window.setTimeout(() => {
          const i = Math.max(0, Math.min(values.length - 1, Math.round(t / ITEM)));
          if (i !== N && values[i] !== value) onChange(values[i]);
        }, 140);
      }}
    >
      <div className="mc-wheel-pad" />
      {values.map((v, i) => {
        const d = (i * ITEM - top) / ITEM;
        return (
          <div key={i} className={`mc-wheel-item${Math.abs(d) < 0.5 ? " on" : ""}`} style={{ transform: `rotateX(${Math.max(-80, Math.min(80, -d * 22))}deg)`, opacity: Math.max(0.15, 1 - Math.abs(d) * 0.28) }} onClick={() => box.current?.scrollTo({ top: i * ITEM, behavior: "smooth" })}>
            {formatAnswer(v)}
          </div>
        );
      })}
      <div className="mc-wheel-pad" />
    </div>
  );
}

/** A ridged thumbwheel lying on its side: drag it (or scroll over it) to roll the value up or down. */
function Dial({ value, base, onChange }: Props) {
  const step = niceStep(base);
  const drag = useRef<{ x: number; v: number } | null>(null);
  const turns = Math.round((value - base) / step);
  return (
    <div
      className="mc-dial"
      role="slider"
      aria-valuenow={value}
      tabIndex={0}
      style={{ "--roll": `${(turns * 6) % 600}px` } as React.CSSProperties}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, v: value };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const ticks = Math.round((e.clientX - drag.current.x) / 6);
        onChange(round(drag.current.v + ticks * step, step));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onWheel={(e) => onChange(round(value + (e.deltaY < 0 || e.deltaX > 0 ? step : -step), step))}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(round(value + step, step));
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(round(value - step, step));
      }}
    >
      <span className="mc-dial-ridges" />
    </div>
  );
}

/** Odometer digits: roll each place up or down on its own (tap ▲/▼, swipe, or scroll over a digit). */
function Tumbler({ value, base, onChange }: Props) {
  const step = niceStep(base);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const text = Math.abs(value).toFixed(decimals);
  const [whole, frac = ""] = text.split(".");
  const width = Math.max(whole.length, 2);
  const digits = whole.padStart(width, "0") + frac;
  const placeOf = (i: number) => Math.pow(10, width - 1 - i);
  const swipe = useRef<{ y: number; i: number } | null>(null);
  const bump = (i: number, dir: number) => onChange(round(value + dir * placeOf(i), placeOf(digits.length - 1)));
  return (
    <div className="mc-tumbler">
      {value < 0 && <span className="mc-sign">−</span>}
      {[...digits].map((d, i) => (
        <span key={i} className="mc-digit-wrap">
          {i === width && <span className="mc-point">.</span>}
          <span
            className="mc-digit"
            onWheel={(e) => bump(i, e.deltaY < 0 ? 1 : -1)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              swipe.current = { y: e.clientY, i };
            }}
            onPointerUp={(e) => {
              const s = swipe.current;
              swipe.current = null;
              if (!s) return;
              const dy = e.clientY - s.y;
              if (Math.abs(dy) > 12) bump(s.i, dy < 0 ? 1 : -1);
            }}
          >
            <button type="button" className="mc-up" aria-label="Up" onClick={() => bump(i, 1)}>▲</button>
            <span key={d} className="mc-num">{d}</span>
            <button type="button" className="mc-down" aria-label="Down" onClick={() => bump(i, -1)}>▼</button>
          </span>
        </span>
      ))}
    </div>
  );
}

/** One variable's control row: name, the chosen kind of control, its value and a reset. */
export function VariableControl(props: Props & { kind: ControlKind; label?: string }) {
  const { kind, name, value, base, onChange, label } = props;
  const C = kind === "wheel" ? Wheel : kind === "dial" ? Dial : kind === "tumbler" ? Tumbler : Slider;
  return (
    <div className={`mc-row mc-${kind}-row`}>
      <span className="mc-name" title={label}>
        {name}
        {label && <small>{label}</small>}
      </span>
      <C name={name} value={value} base={base} onChange={onChange} />
      <input
        className="mc-value"
        type="number"
        inputMode="decimal"
        value={formatAnswer(value)}
        step={niceStep(base)}
        onChange={(e) => e.target.value !== "" && Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))}
      />
      <button type="button" className="mc-reset" disabled={value === base} title={`Back to ${formatAnswer(base)}`} onClick={() => onChange(base)}>↺</button>
    </div>
  );
}
