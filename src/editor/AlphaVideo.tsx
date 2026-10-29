import { useEffect, useRef, useState } from "react";
import { usePlayWhenVisible } from "./usePlayWhenVisible";

const VERTEX = `attribute vec2 p; varying vec2 uv;
void main() { uv = vec2((p.x + 1.0) / 2.0, (1.0 - p.y) / 2.0); gl_Position = vec4(p, 0.0, 1.0); }`;
// Top half is the picture, bottom half its alpha (as grey): see scripts/import-meme-kit.mjs.
const FRAGMENT = `precision mediump float; varying vec2 uv; uniform sampler2D frame;
void main() {
  vec3 color = texture2D(frame, vec2(uv.x, uv.y * 0.5)).rgb;
  float alpha = texture2D(frame, vec2(uv.x, 0.5 + uv.y * 0.5)).r;
  gl_FragColor = vec4(color * alpha, alpha);
}`;

/** A green-screen meme: a "stacked alpha" clip drawn see-through over the page. Tap for sound. */
export function AlphaVideo({ src, onTap }: { src: string; onTap?: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const c = canvas.current;
    const v = video.current;
    const gl = c?.getContext("webgl", { premultipliedAlpha: true, alpha: true });
    if (!c || !v || !gl) return;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let frame = 0;
    // Draw only when the video has a new frame (24 a second), not on every screen refresh.
    const next = () => {
      if ("requestVideoFrameCallback" in v) frame = (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(draw);
      else frame = requestAnimationFrame(draw);
    };
    const draw = () => {
      if (v.readyState >= 2 && v.videoWidth) {
        if (c.width !== v.videoWidth || c.height !== v.videoHeight / 2) {
          c.width = v.videoWidth;
          c.height = v.videoHeight / 2;
          gl.viewport(0, 0, c.width, c.height);
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      next();
    };
    next();
    return () => {
      if ("cancelVideoFrameCallback" in v) (v as HTMLVideoElement & { cancelVideoFrameCallback: (h: number) => void }).cancelVideoFrameCallback(frame);
      cancelAnimationFrame(frame);
    };
  }, [src]);
  usePlayWhenVisible(video, [src]);

  return (
    <span className="alpha-video">
      <video ref={video} src={src} autoPlay loop muted={muted} playsInline aria-hidden />
      <canvas
        ref={canvas}
        // Never focus the text (that would open the keyboard and scroll).
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          setMuted((m) => !m);
          void video.current?.play();
          // Select it too, so its size/placement tools show.
          onTap?.();
        }}
        title={muted ? "Tap for sound" : "Tap to mute"}
      />
    </span>
  );
}
