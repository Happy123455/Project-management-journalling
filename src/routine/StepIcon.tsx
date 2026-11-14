import { useFileUrl } from "../editor/attachments";

/** A routine step's or habit's icon: its GIF (or picture) when it has one, else its emoji. */
export function StepIcon({ item }: { item: { icon: string; gif?: string } }) {
  const { url } = useFileUrl(item.gif ?? null);
  if (item.gif && url) return <img className="step-gif" src={url} alt={item.icon} draggable={false} />;
  return <>{item.icon}</>;
}
