/**
 * Mobile data or Wi-Fi. Android's web view reports the connection type (Network Information
 * API); the Mac and a desktop browser don't, and count as Wi-Fi.
 */
interface Connection {
  type?: string;
  saveData?: boolean;
}
export function onMobileData(): boolean {
  if (typeof navigator === "undefined") return false;
  const c = (navigator as Navigator & { connection?: Connection }).connection;
  return c?.type === "cellular" || (c?.type === undefined && !!c?.saveData);
}
