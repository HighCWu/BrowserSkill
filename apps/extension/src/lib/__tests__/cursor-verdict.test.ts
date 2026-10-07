import { describe, expect, it, vi } from "vitest";
import {
  CURSOR_OVERLAY_VERDICT_KEY,
  type CursorVerdictStorageApi,
  readCursorOverlayVerdict,
  writeCursorOverlayVerdict,
} from "@/lib/cursor-verdict";

function fakeStorage(): CursorVerdictStorageApi & {
  data: Map<string, unknown>;
  accessLevelCalls: number;
} {
  const data = new Map<string, unknown>();
  const accessLevelCalls = { count: 0 };
  return {
    data,
    get accessLevelCalls() {
      return accessLevelCalls.count;
    },
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (data.has(key)) out[key] = data.get(key);
      }
      return out;
    },
    setAccessLevel() {
      accessLevelCalls.count += 1;
      return Promise.resolve();
    },
    set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
      return Promise.resolve();
    },
    remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      return Promise.resolve();
    },
  };
}

describe("cursor verdict persistence", () => {
  it("write(true) stores the verdict; read returns true", async () => {
    const storage = fakeStorage();
    writeCursorOverlayVerdict(true, storage);
    await vi.waitFor(() => {
      expect(storage.data.get(CURSOR_OVERLAY_VERDICT_KEY)).toBe(true);
    });
    await expect(readCursorOverlayVerdict(storage)).resolves.toBe(true);
  });

  it("write(false) removes the verdict; read returns false", async () => {
    const storage = fakeStorage();
    writeCursorOverlayVerdict(true, storage);
    await vi.waitFor(() => {
      expect(storage.data.has(CURSOR_OVERLAY_VERDICT_KEY)).toBe(true);
    });
    writeCursorOverlayVerdict(false, storage);
    await vi.waitFor(() => {
      expect(storage.data.has(CURSOR_OVERLAY_VERDICT_KEY)).toBe(false);
    });
    await expect(readCursorOverlayVerdict(storage)).resolves.toBe(false);
  });

  it("an absent verdict (fresh browser session) reads as disabled", async () => {
    const storage = fakeStorage();
    await expect(readCursorOverlayVerdict(storage)).resolves.toBe(false);
  });

  it("a failed read degrades to disabled instead of throwing", async () => {
    const storage = fakeStorage();
    storage.get = () => Promise.reject(new Error("storage unavailable"));
    await expect(readCursorOverlayVerdict(storage)).resolves.toBe(false);
  });

  it("requests the trusted+untrusted access level so content scripts can read", async () => {
    const storage = fakeStorage();
    writeCursorOverlayVerdict(true, storage);
    await vi.waitFor(() => {
      expect(storage.accessLevelCalls).toBe(1);
    });
  });

  it("works without any storage available (tests, restricted contexts)", () => {
    expect(() => writeCursorOverlayVerdict(true, null)).not.toThrow();
  });
});
