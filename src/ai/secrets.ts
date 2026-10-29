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
 * API keys for this device only: the Android Keystore, the macOS Keychain, or memory in the
 * browser preview. They are never written to the journal, so never synced or backed up.
 */
export async function getKey(provider: Provider): Promise<string | null> {
  if (window.JournalSecrets) return window.JournalSecrets.get(name(provider)) || null;
  if (onDesktopApp()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("secret_get", { name: name(provider) })) || null;
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
  } else memory.delete(name(provider));
  window.dispatchEvent(new Event("journal:ai-settings"));
}
