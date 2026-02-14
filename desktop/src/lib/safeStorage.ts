/**
 * Token storage via Electron safeStorage API.
 * Uses macOS Keychain (or platform equivalent) for secure credential persistence.
 *
 * These functions call into the preload bridge which invokes
 * Electron's safeStorage.encryptString / decryptString under the hood,
 * backed by localStorage for the encrypted blob.
 *
 * When running outside Electron (e.g. in tests), falls back to plain localStorage.
 */

const PREFIX = 'ifb_secure_';

function isElectronAvailable(): boolean {
  return typeof window !== 'undefined' && 'desktopAPI' in window;
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (isElectronAvailable() && window.desktopAPI.secureStore) {
    await window.desktopAPI.secureStore({ key, value });
  } else {
    // Fallback: plain localStorage (development / browser context)
    localStorage.setItem(PREFIX + key, value);
  }
}

export async function secureGet(key: string): Promise<string | null> {
  if (isElectronAvailable() && window.desktopAPI.secureRetrieve) {
    return await window.desktopAPI.secureRetrieve({ key });
  }
  return localStorage.getItem(PREFIX + key);
}

export async function secureDelete(key: string): Promise<void> {
  if (isElectronAvailable() && window.desktopAPI.secureDelete) {
    await window.desktopAPI.secureDelete({ key });
  } else {
    localStorage.removeItem(PREFIX + key);
  }
}
