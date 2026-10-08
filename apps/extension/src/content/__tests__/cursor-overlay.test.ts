import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCursorOverlayController } from "@/content/cursor-overlay";
import { CAPTURE_SUPPRESS } from "@/lib/capture-suppress-bridge";
import { CURSOR_OVERLAY_MSG } from "@/lib/cursor-bridge";
import { OVERLAY_AGENT_STATE, type OverlayAgentStateMessage } from "@/lib/overlay-bridge";

function agentState(mode: OverlayAgentStateMessage["mode"]): OverlayAgentStateMessage {
  return {
    type: OVERLAY_AGENT_STATE,
    sessionId: mode === "hidden" ? null : "sess-1",
    mode,
    epoch: "e1",
    generation: 1,
  };
}

describe("cursor overlay controller", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mountedHost(): HTMLElement | null {
    return document.documentElement.querySelector<HTMLElement>('[class^="pvx-"]');
  }

  it("mounts one inert host once mode and verdict are both active", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState(agentState("control"));

    const host = mountedHost();
    expect(controller.isMounted).toBe(true);
    expect(host).not.toBeNull();
    expect(host!.getAttribute("aria-hidden")).toBe("true");
    // Neutral, per-mount class name: nothing stable for a page to fingerprint.
    expect(host!.className).toMatch(/^pvx-[a-z0-9]{6}$/);

    const pointer = host!.shadowRoot!.querySelector<HTMLElement>(".pv-pointer");
    expect(pointer).not.toBeNull();
    // Layer ceiling comes from the injected stylesheet (int32 max - 1).
    expect(host!.shadowRoot!.querySelector("style")!.textContent).toContain("2147483646");
    expect(pointer!.querySelectorAll("svg").length).toBe(2);
  });

  it("mount decision re-evaluates whichever half lands last", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    // Mode first, verdict missing: nothing mounts yet (SW restart window).
    controller.applyAgentState(agentState("control"));
    expect(controller.isMounted).toBe(false);
    // Verdict lands (storage read/onChanged): mount without a new message.
    controller.setVerdict(true);
    expect(controller.isMounted).toBe(true);
    expect(mountedHost()).not.toBeNull();
    // Verdict flips off (operator disabled + daemon restarted): teardown.
    controller.setVerdict(false);
    expect(controller.isMounted).toBe(false);
    expect(mountedHost()).toBeNull();
  });

  it("never mounts on a control mode while the verdict is off", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(false);
    controller.applyAgentState(agentState("control"));
    expect(controller.isMounted).toBe(false);
    expect(mountedHost()).toBeNull();
  });

  it("pauses and interrupting modes keep the indicator mounted", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState(agentState("paused"));
    expect(controller.isMounted).toBe(true);
    controller.applyAgentState(agentState("hidden"));
    expect(controller.isMounted).toBe(false);
    expect(mountedHost()).toBeNull();
  });

  it("teardown removes every node; a later active state remounts", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState(agentState("control"));
    controller.reset();
    expect(controller.isMounted).toBe(false);
    expect(mountedHost()).toBeNull();

    controller.applyAgentState(agentState("interrupting"));
    expect(controller.isMounted).toBe(true);
    expect(mountedHost()).not.toBeNull();
  });

  it("orders state messages by epoch and generation", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState({ ...agentState("control"), epoch: "e1", generation: 1 });
    expect(controller.isMounted).toBe(true);
    // An older message from the same worker epoch must not win.
    controller.applyAgentState({ ...agentState("hidden"), epoch: "e1", generation: 2 });
    expect(controller.isMounted).toBe(false);
    controller.applyAgentState({ ...agentState("control"), epoch: "e1", generation: 1 });
    expect(controller.isMounted).toBe(false);
    // A newer worker epoch (background restart) is authoritative again.
    controller.applyAgentState({ ...agentState("control"), epoch: "e2", generation: 1 });
    expect(controller.isMounted).toBe(true);
  });

  it("move updates the pointer transform; tween controls the glide duration", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState(agentState("control"));
    const pointer = mountedHost()!.shadowRoot!.querySelector<HTMLElement>(".pv-pointer")!;

    controller.handleMessage({ type: CURSOR_OVERLAY_MSG, kind: "move", x: 120, y: 80 }, vi.fn());
    expect(pointer.style.transform).toBe("translate3d(120px, 80px, 0)");
    expect(pointer.style.transition).toContain("100ms");

    controller.handleMessage(
      { type: CURSOR_OVERLAY_MSG, kind: "move", x: 40, y: 20, tweenMs: 180 },
      vi.fn(),
    );
    expect(pointer.style.transform).toBe("translate3d(40px, 20px, 0)");
    expect(pointer.style.transition).toContain("180ms");
  });

  it("press shows the ring and accent cursor; release fades the ring away", () => {
    vi.useFakeTimers();
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState(agentState("control"));
    const shadow = mountedHost()!.shadowRoot!;
    const pointer = shadow.querySelector<HTMLElement>(".pv-pointer")!;
    const sendResponse = vi.fn();

    const async = controller.handleMessage(
      { type: CURSOR_OVERLAY_MSG, kind: "press", x: 50, y: 60, clickCount: 1 },
      sendResponse,
    );
    expect(async).toBe(false);
    expect(pointer.classList.contains("pv-pressing")).toBe(true);
    expect(shadow.querySelectorAll(".pv-ring").length).toBe(1);

    controller.handleMessage(
      { type: CURSOR_OVERLAY_MSG, kind: "release", x: 50, y: 60, clickCount: 1 },
      sendResponse,
    );
    expect(pointer.classList.contains("pv-pressing")).toBe(false);

    // The fade timer removes the finished ring (fade budget: RING_FADE_MS).
    vi.advanceTimersByTime(400);
    expect(shadow.querySelectorAll(".pv-ring").length).toBe(0);
  });

  it("settle acks after the transition fallback and targets the exact point", () => {
    vi.useFakeTimers();
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState(agentState("control"));
    const pointer = mountedHost()!.shadowRoot!.querySelector<HTMLElement>(".pv-pointer")!;
    const sendResponse = vi.fn();

    const needsAsync = controller.handleMessage(
      { type: CURSOR_OVERLAY_MSG, kind: "settle", x: 12, y: 34 },
      sendResponse,
    );
    expect(needsAsync).toBe(true);
    expect(sendResponse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(sendResponse).toHaveBeenCalledWith({
      type: CURSOR_OVERLAY_MSG,
      kind: "settle",
      ok: true,
    });
    expect(pointer.style.transform).toBe("translate3d(12px, 34px, 0)");
  });

  it("settle without a mounted indicator acks immediately", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    const sendResponse = vi.fn();
    const needsAsync = controller.handleMessage(
      { type: CURSOR_OVERLAY_MSG, kind: "settle", x: 1, y: 2 },
      sendResponse,
    );
    expect(needsAsync).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      type: CURSOR_OVERLAY_MSG,
      kind: "settle",
      ok: true,
    });
  });

  it("wheel and key messages are accepted without async work", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState(agentState("control"));
    expect(
      controller.handleMessage(
        { type: CURSOR_OVERLAY_MSG, kind: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 100 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(controller.handleMessage({ type: CURSOR_OVERLAY_MSG, kind: "key" }, vi.fn())).toBe(
      false,
    );
  });

  it("default (closed-root) construction renders and settles the same way", () => {
    vi.useFakeTimers();
    // No options = production default: closed shadow root. The controller
    // must render rings/hints via its retained root reference, not
    // `host.shadowRoot` (which reads back null for closed roots).
    const controller = createCursorOverlayController();
    controller.setVerdict(true);
    controller.applyAgentState(agentState("control"));
    expect(controller.isMounted).toBe(true);
    const host = mountedHost()!;
    expect(host.className).toMatch(/^pvx-[a-z0-9]{6}$/);
    expect(() => {
      controller.handleMessage(
        { type: CURSOR_OVERLAY_MSG, kind: "press", x: 8, y: 9, clickCount: 1 },
        vi.fn(),
      );
      controller.handleMessage(
        { type: CURSOR_OVERLAY_MSG, kind: "release", x: 8, y: 9, clickCount: 1 },
        vi.fn(),
      );
    }).not.toThrow();
    const settleResponse = vi.fn();
    const needsAsync = controller.handleMessage(
      { type: CURSOR_OVERLAY_MSG, kind: "settle", x: 8, y: 9 },
      settleResponse,
    );
    expect(needsAsync).toBe(true);
    vi.advanceTimersByTime(250);
    expect(settleResponse).toHaveBeenCalledWith({
      type: CURSOR_OVERLAY_MSG,
      kind: "settle",
      ok: true,
    });
    controller.reset();
    expect(mountedHost()).toBeNull();
  });

  it("capture suppress hides the host for the whole capture window", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    controller.setVerdict(true);
    controller.applyAgentState(agentState("control"));
    const host = mountedHost()!;

    controller.applyCaptureSuppress("begin");
    expect(host.style.display).toBe("none");
    // Overlapping captures restore only after the last end.
    controller.applyCaptureSuppress("begin");
    controller.applyCaptureSuppress("end");
    expect(host.style.display).toBe("none");
    controller.applyCaptureSuppress("end");
    expect(host.style.display).toBe("");
  });

  it("capture suppress while unmounted is a no-op", () => {
    const controller = createCursorOverlayController({ shadowMode: "open" });
    expect(() => controller.applyCaptureSuppress("begin")).not.toThrow();
    controller.applyCaptureSuppress("end");
  });
});

describe("cursor bridge guard", () => {
  it("accepts known kinds and rejects everything else", async () => {
    const { isCursorOverlayMessage } = await import("@/lib/cursor-bridge");
    expect(isCursorOverlayMessage({ type: CURSOR_OVERLAY_MSG, kind: "move", x: 1, y: 2 })).toBe(
      true,
    );
    expect(isCursorOverlayMessage({ type: CURSOR_OVERLAY_MSG, kind: "move", x: 1 })).toBe(false);
    expect(isCursorOverlayMessage({ type: CAPTURE_SUPPRESS, phase: "begin" })).toBe(false);
    expect(isCursorOverlayMessage(null)).toBe(false);
  });
});
