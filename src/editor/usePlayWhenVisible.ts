import { useEffect, type RefObject } from "react";

/** Plays a looping clip only while it's on screen (a note full of memes shouldn't keep the phone busy). */
export function usePlayWhenVisible(video: RefObject<HTMLVideoElement | null>, deps: unknown[] = []) {
  useEffect(() => {
    const v = video.current;
    if (!v || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void v.play().catch(() => {});
      else v.pause();
    });
    seen.observe(v.parentElement ?? v);
    return () => seen.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
