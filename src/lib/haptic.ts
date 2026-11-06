/** A short haptic on the phone (MainActivity's glass ticks); a tiny vibration elsewhere, if any. */
export function haptic(kind: "tap" | "tick" | "press" | "edge" | "warn", strength = 0.6) {
  try {
    if (window.JournalHaptics) window.JournalHaptics.play(kind, strength);
    else navigator.vibrate?.(kind === "press" ? 12 : 5);
  } catch {
    // No haptics here.
  }
}
