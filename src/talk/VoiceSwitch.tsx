// 🎙️ One voice feature (Hapi, 25 Nov): Talk (the interviewer / Gujarati call), Thought (say it, pick
// the block) and Talk + type (the box you can type into while it listens), switched at the top.
export type VoiceKind = "talk" | "thought" | "type";
const KEY = "journal.voiceKind";
export const OPEN_VOICE = "journal:voice";

export function lastVoiceKind(): VoiceKind {
  try {
    const v = localStorage.getItem(KEY);
    return v === "thought" || v === "type" ? v : "talk";
  } catch {
    return "talk";
  }
}
export const openVoice = (kind: VoiceKind = lastVoiceKind()) => window.dispatchEvent(new CustomEvent(OPEN_VOICE, { detail: kind }));

const KINDS: [VoiceKind, string, string][] = [
  ["talk", "🎙️ Talk", "It asks about your day out loud; you answer"],
  ["thought", "💭 Thought", "Say a thought, pick the block it goes in today"],
  ["type", "⌨︎ Talk + type", "A box you can type into while it listens"],
];

export function VoiceSwitch({ kind }: { kind: VoiceKind }) {
  return (
    <div className="voice-switch" role="tablist" aria-label="Voice">
      {KINDS.map(([k, label, title]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={k === kind}
          className={k === kind ? "on" : ""}
          title={title}
          onClick={() => {
            if (k === kind) return;
            try {
              localStorage.setItem(KEY, k);
            } catch {
              /* this session only */
            }
            openVoice(k);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
