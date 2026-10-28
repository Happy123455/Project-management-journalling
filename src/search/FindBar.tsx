/** Floating ↑ ↓ bar for stepping through search matches in the open note. */
export function FindBar({ index, count, onMove, onClose }: { index: number; count: number; onMove: (index: number) => void; onClose: () => void }) {
  const go = (step: number) => count && onMove((index + step + count) % count);
  return (
    <div className="find-bar" role="toolbar" aria-label="Search matches in this note">
      <button type="button" onClick={() => go(-1)} disabled={!count} aria-label="Previous match">↑</button>
      <span className="find-count">{count ? `${index + 1} of ${count}` : "No matches here"}</span>
      <button type="button" onClick={() => go(1)} disabled={!count} aria-label="Next match">↓</button>
      <button type="button" className="find-close" onClick={onClose} aria-label="Stop highlighting">✕</button>
    </div>
  );
}
