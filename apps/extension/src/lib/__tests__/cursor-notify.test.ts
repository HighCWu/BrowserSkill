import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_OVERLAY_MSG } from "@/lib/cursor-bridge";
import {
  createCursorNotifier,
  isCursorOverlayEnabled,
  LANDING_SETTLE_BUDGET_MS,
  noopCursorNotifier,
  setCursorOverlayEnabled,
} from "@/lib/cursor-notify";

describe("cursor notifier", () => {
  let sendToTab: ReturnType<typeof vi.fn>;
  let notifier: ReturnType<typeof createCursorNotifier>["notifier"];

  beforeEach(() => {
    vi.useFakeTimers();
    setCursorOverlayEnabled(false);
    sendToTab = vi.fn().mockResolvedValue(undefined);
    ({ notifier } = createCursorNotifier(sendToTab));
  });

  afterEach(() => {
    setCursorOverlayEnabled(false);
    vi.useRealTimers();
  });

  it("sends nothing while the overlay is disabled", () => {
    notifier.move(1, 10, 20);
    notifier.press(1, 10, 20, 1);
    notifier.release(1, 10, 20, 1);
    notifier.wheel(1, 10, 20, 0, 120);
    notifier.key(1);
    expect(sendToTab).not.toHaveBeenCalled();
    expect(isCursorOverlayEnabled()).toBe(false);
  });

  it("fire-and-forget calls send the expected payloads when enabled", () => {
    setCursorOverlayEnabled(true);
    notifier.move(7, 1.5, 2.5);
    expect(sendToTab).toHaveBeenCalledWith(7, {
      type: CURSOR_OVERLAY_MSG,
      kind: "move",
      x: 1.5,
      y: 2.5,
    });

    sendToTab.mockClear();
    notifier.move(7, 3, 4, { tweenMs: 180 });
    expect(sendToTab).toHaveBeenCalledWith(7, {
      type: CURSOR_OVERLAY_MSG,
      kind: "move",
      x: 3,
      y: 4,
      tweenMs: 180,
    });

    notifier.press(7, 5, 6, 2);
    expect(sendToTab).toHaveBeenCalledWith(7, {
      type: CURSOR_OVERLAY_MSG,
      kind: "press",
      x: 5,
      y: 6,
      clickCount: 2,
    });

    notifier.release(7, 5, 6, 2);
    expect(sendToTab).toHaveBeenCalledWith(7, {
      type: CURSOR_OVERLAY_MSG,
      kind: "release",
      x: 5,
      y: 6,
      clickCount: 2,
    });

    notifier.wheel(7, 5, 6, -40, 120);
    expect(sendToTab).toHaveBeenCalledWith(7, {
      type: CURSOR_OVERLAY_MSG,
      kind: "wheel",
      x: 5,
      y: 6,
      deltaX: -40,
      deltaY: 120,
    });

    notifier.key(7);
    expect(sendToTab).toHaveBeenCalledWith(7, { type: CURSOR_OVERLAY_MSG, kind: "key" });
  });

  it("swallows a missing receiver instead of raising unhandled rejections", () => {
    setCursorOverlayEnabled(true);
    sendToTab.mockRejectedValue(new Error("Receiving end does not exist"));
    expect(() => notifier.move(9, 1, 1)).not.toThrow();
  });

  it("settle resolves immediately while disabled", async () => {
    await expect(notifier.settle(1, 3, 4)).resolves.toBeUndefined();
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it("settle resolves as soon as the indicator acks", async () => {
    setCursorOverlayEnabled(true);
    sendToTab.mockResolvedValue({ type: CURSOR_OVERLAY_MSG, kind: "settle", ok: true });
    const pending = notifier.settle(7, 30, 40);
    await expect(pending).resolves.toBeUndefined();
    expect(sendToTab).toHaveBeenCalledWith(7, {
      type: CURSOR_OVERLAY_MSG,
      kind: "settle",
      x: 30,
      y: 40,
    });
  });

  it("settle gives up after the budget when no receiver answers", async () => {
    setCursorOverlayEnabled(true);
    sendToTab.mockReturnValue(new Promise(() => {}));
    const pending = notifier.settle(7, 30, 40, 150);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(LANDING_SETTLE_BUDGET_MS - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it("reports state changes once", () => {
    expect(setCursorOverlayEnabled(true)).toBe(true);
    expect(setCursorOverlayEnabled(true)).toBe(false);
    expect(isCursorOverlayEnabled()).toBe(true);
    expect(setCursorOverlayEnabled(false)).toBe(true);
  });

  it("noop notifier never touches tabs", async () => {
    setCursorOverlayEnabled(true);
    noopCursorNotifier.move(1, 0, 0);
    await expect(noopCursorNotifier.settle(1, 0, 0)).resolves.toBeUndefined();
    expect(sendToTab).not.toHaveBeenCalled();
  });
});
