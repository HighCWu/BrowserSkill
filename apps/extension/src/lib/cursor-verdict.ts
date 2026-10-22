/**
 * Durable daemon verdict for the on-page visual pointer indicator, mirrored
 * into `chrome.storage.session`.
 *
 * Why storage: the background service worker is ephemeral. Its in-memory
 * handshake verdict dies with every SW restart, and a state push that lands
 * in the restart window would carry no verdict — the indicator would then
 * never mount even though the daemon enabled it. `chrome.storage.session`
 * survives SW restarts (it lives for the browser session), so the content
 * script consults it as the source of truth and re-evaluates whenever either
 * half of the mount condition changes (agent mode via runtime messages,
 * verdict via storage).
 *
 * `chrome.storage.session` defaults to TRUSTED_CONTEXTS only, so the writer
 * opts the area into TRUSTED_AND_UNTRUSTED_CONTEXTS the first time it
 * touches it (same pattern as `sessions-live-flag.ts`). The stored value is
 * a single boolean and carries no user data.
 */

export const CURSOR_OVERLAY_VERDICT_KEY = "bh.pointer_enabled";

/** Subset of `chrome.storage.session` we use; lets tests inject a fake. */
export interface CursorVerdictStorageApi {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  setAccessLevel?(options: { accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }): Promise<void>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export function defaultCursorVerdictStorage(): CursorVerdictStorageApi | null {
  if (typeof chrome === "undefined") return null;
  if (!chrome.storage?.session?.get || !chrome.storage?.session?.set) return null;
  return {
    get: (keys) => chrome.storage.session.get(keys),
    setAccessLevel: chrome.storage.session.setAccessLevel?.bind(chrome.storage.session),
    set: (items) => chrome.storage.session.set(items),
    remove: (keys) => chrome.storage.session.remove(keys),
  };
}

function ensureAccessLevel(storage: CursorVerdictStorageApi): void {
  if (!storage.setAccessLevel) return;
  storage.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch((err) => {
    console.debug("[bsk pointer] storage.session.setAccessLevel failed (continuing)", err);
  });
}

/**
 * Background side: persist the latest handshake verdict. Fire-and-forget;
 * a failed write only means content scripts keep the previous verdict until
 * the next handshake.
 */
export function writeCursorOverlayVerdict(
  enabled: boolean,
  storage: CursorVerdictStorageApi | null = defaultCursorVerdictStorage(),
): void {
  if (!storage) return;
  ensureAccessLevel(storage);
  const write = enabled
    ? storage.set({ [CURSOR_OVERLAY_VERDICT_KEY]: true })
    : storage.remove(CURSOR_OVERLAY_VERDICT_KEY);
  write.catch((err) => {
    console.debug("[bsk pointer] verdict write failed", err);
  });
}

/**
 * Content-script side: read the persisted verdict. Absent (never written
 * this browser session) means disabled.
 */
export async function readCursorOverlayVerdict(
  storage: CursorVerdictStorageApi | null = defaultCursorVerdictStorage(),
): Promise<boolean> {
  if (!storage) return false;
  try {
    const values = await storage.get(CURSOR_OVERLAY_VERDICT_KEY);
    return values[CURSOR_OVERLAY_VERDICT_KEY] === true;
  } catch (err) {
    console.debug("[bsk pointer] verdict read failed", err);
    return false;
  }
}
