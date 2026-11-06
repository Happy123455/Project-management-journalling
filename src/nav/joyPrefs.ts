/**
 * Home joystick's sideways sensitivity: how far (px) the thumb may lean left or right of the Home
 * button and still only scroll. Crossing that line changes the day. Bigger = less sensitive.
 */
const KEY = "journal.joyLane";
export const JOY_LANE_MIN = 40;
export const JOY_LANE_MAX = 150;
export const JOY_LANE_DEFAULT = 80;

export function joyLane(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v >= JOY_LANE_MIN && v <= JOY_LANE_MAX ? v : JOY_LANE_DEFAULT;
  } catch {
    return JOY_LANE_DEFAULT;
  }
}

export function setJoyLane(v: number) {
  try {
    localStorage.setItem(KEY, String(Math.round(Math.min(JOY_LANE_MAX, Math.max(JOY_LANE_MIN, v)))));
  } catch {
    // Only a preference.
  }
}
