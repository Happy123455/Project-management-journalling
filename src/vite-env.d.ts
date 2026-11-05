/// <reference types="vite/client" />

interface Window {
  /** The phone's Back: true when the app handled it (MainActivity asks before leaving). */
  journalBack?: () => boolean;
}
