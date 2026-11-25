import type { Provider } from "./providers";

declare global {
  interface Window {
    /** Android: Keystore-encrypted storage (MainActivity.kt SecretsBridge). */
    JournalSecrets?: { get(name: string): string; set(name: string, value: string): boolean; remove(name: string): void };
  }
}

const name = (provider: Provider) => `ai-key-${provider}`;
const onDesktopApp = () => "__TAURI_INTERNALS__" in window && !window.JournalSecrets;

/** In the browser preview keys are kept in memory only, never written anywhere. */
const memory = new Map<string, string>();
/**
 * The Mac app: a key read once stays in memory until the app quits (25 Nov, Hapi: "every time I
 * use AI on my Mac it asks for my password"). Every AI call used to read the Keychain again.
 */
const cache = new Map<string, Promise<string | null>>();

/**
 * API keys for this device only: the Android Keystore, the macOS Keychain, or memory in the
 * browser preview. They are never written to the journal, so never synced or backed up.
 */
export async function getKey(provider: Provider): Promise<string | null> {
  if (window.JournalSecrets) return window.JournalSecrets.get(name(provider)) || null;
  if (onDesktopApp()) {
    const k = name(provider);
    // One read even when several AI calls start at once; a failed read is tried again next time.
    let read = cache.get(k);
    if (!read) {
      read = import("@tauri-apps/api/core").then(({ invoke }) => invoke<string | null>("secret_get", { name: k })).then((v) => v || null);
      cache.set(k, read);
      read.catch(() => cache.delete(k));
    }
    return read;
  }
  return memory.get(name(provider)) ?? null;
}

export async function setKey(provider: Provider, key: string): Promise<void> {
  const value = key.trim();
  if (window.JournalSecrets) {
    if (!window.JournalSecrets.set(name(provider), value)) throw new Error("Couldn't store the key on this device");
  } else if (onDesktopApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secret_set", { name: name(provider), value });
    cache.set(name(provider), Promise.resolve(value || null));
  } else {
    memory.set(name(provider), value);
  }
  window.dispatchEvent(new Event("journal:ai-settings"));
}

export async function removeKey(provider: Provider): Promise<void> {
  if (window.JournalSecrets) window.JournalSecrets.remove(name(provider));
  else if (onDesktopApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secret_delete", { name: name(provider) });
    cache.delete(name(provider));
  } else memory.delete(name(provider));
  window.dispatchEvent(new Event("journal:ai-settings"));
}
