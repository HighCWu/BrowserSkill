import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { handleMouseMove } from "../mouse-move";
import { createSeededRng, distance, type Vec2 } from "../trajectory";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return { windowId: id, initialTabIds: [] };
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => 1),
  };
}

function makeFakeCdp(handlers: Record<string, (params: unknown) => unknown>, tracked?: Vec2) {
  const sent: Array<{ tabId: number; method: string; params?: object }> = [];
  const remembered: Array<{ tabId: number; x: number; y: number }> = [];
  const sendImpl = async (tabId: number, method: string, params?: object) => {
    sent.push({ tabId, method, params });
    const h = handlers[method];
    // No control overlay present unless a test says otherwise.
    if (!h && method === "Runtime.evaluate") {
      return { result: { value: { overlayHostPresent: false, overlayHostConnected: false } } };
    }
    if (!h && method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
    }
    if (!h) throw new Error(`unexpected CDP call ${method}`);
    return h(params);
  };
  const cdp: CdpRunner & { remembered: typeof remembered } = {
    send: sendImpl,
    trackSessionTab: vi.fn(),
    lastMousePos: (tabId: number) => (tracked ? { tabId, ...tracked } && tracked : undefined),
    rememberMousePos: (tabId: number, x: number, y: number) => {
      remembered.push({ tabId, x, y });
    },
  };
  const tabsApi = {
    get: vi.fn(
      async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
    ),
    query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
  };
  return { cdp: cdp as CdpRunner, tabsApi, sent, remembered };
}

/** Mouse events dispatched by a handler run, in order. */
function moves(sent: Array<{ method: string; params?: object }>) {
  return sent
    .filter((c) => c.method === "Input.dispatchMouseEvent")
    .map((c) => c.params as { type: string; x: number; y: number })
    .filter((p) => p.type === "mouseMoved");
}

// Small explicit duration/steps keep the real inter-point sleeps short.
const QUICK = { duration_ms: 96, steps: 12, jitter: false } as const;

describe("handleMouseMove", () => {
  it("uses the v2 behaviour state machine when every knob is default", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({ "Input.dispatchMouseEvent": () => ({}) });

    const res = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 800, to_y: 400 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, rng: createSeededRng(9) },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    // v2 result contract: exact landing, multi-phase point count, and a
    // Fitts-derived duration well above the v1 floor.
    expect(res).toMatchObject({ tab_id: 4, from_x: 640, from_y: 360, x: 800, y: 400 });
    expect(res.x).toBe(800);
    expect(res.y).toBe(400);
    expect(res.curve).toBe("bezier");
    expect(res.steps).toBeGreaterThan(12);
    expect(res.duration_ms).toBeGreaterThanOrEqual(40);
    expect(res.duration_ms).toBeLessThanOrEqual(2000);
    const path = moves(fake.sent);
    expect(path.length).toBe(res.steps);
    expect(path[path.length - 1]).toMatchObject({ x: 800, y: 400 });
    // En-route probing happened through the page-world channel (the fake
    // reports no overlay and nothing interactive).
    expect(fake.sent.some((c) => c.method === "Runtime.evaluate")).toBe(true);
  });

  it("glides from the viewport centre when nothing is tracked", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({ "Input.dispatchMouseEvent": () => ({}) });

    const res = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 800, to_y: 400, overshoot: false, ...QUICK },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res).toMatchObject({
      tab_id: 4,
      from_x: 640, // viewport centre of 1280x720
      from_y: 360,
      x: 800,
      y: 400,
      steps: 12,
      curve: "bezier",
      overshoot: false,
    });
    const path = moves(fake.sent);
    expect(path).toHaveLength(12);
    // First eased point sits on the start, last lands exactly on target.
    expect(path[0]).toMatchObject({ x: 640, y: 360 });
    expect(path[path.length - 1]).toMatchObject({ x: 800, y: 400 });
    // Planned duration is the sum of per-point sleeps, near the request.
    expect(res.duration_ms).toBeGreaterThanOrEqual(76);
    expect(res.duration_ms).toBeLessThanOrEqual(116);
    // The pointer position was tracked at every dispatched point.
    expect(fake.remembered[fake.remembered.length - 1]).toMatchObject({ tabId: 4, x: 800, y: 400 });
    expect(fake.remembered).toHaveLength(12);
  });

  it("starts from the remembered pointer position when present", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({ "Input.dispatchMouseEvent": () => ({}) }, { x: 100, y: 50 });

    const res = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 200, to_y: 90, overshoot: false, ...QUICK },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.from_x).toBe(100);
    expect(res.from_y).toBe(50);
    expect(moves(fake.sent)[0]).toMatchObject({ x: 100, y: 50 });
  });

  it("starts from explicit from_* coordinates when given", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({ "Input.dispatchMouseEvent": () => ({}) }, { x: 1, y: 2 });

    const res = await handleMouseMove(
      sm,
      {
        session_id: "aa11",
        to_x: 300,
        to_y: 200,
        from_x: 10,
        from_y: 20,
        overshoot: false,
        ...QUICK,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.from_x).toBe(10);
    expect(res.from_y).toBe(20);
    expect(moves(fake.sent)[0]).toMatchObject({ x: 10, y: 20 });
  });

  it("keeps a linear no-jitter path exactly on the start–end segment", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({ "Input.dispatchMouseEvent": () => ({}) });

    const res = await handleMouseMove(
      sm,
      {
        session_id: "aa11",
        to_x: 700,
        to_y: 500,
        from_x: 100,
        from_y: 100,
        curve: "linear",
        overshoot: false,
        ...QUICK,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    const start: Vec2 = { x: 100, y: 100 };
    for (const p of moves(fake.sent)) {
      // Cross product with the travel direction must vanish on the line.
      const cross = (p.x - start.x) * 400 - (p.y - start.y) * 600;
      expect(Math.abs(cross)).toBeLessThan(1e-6);
    }
  });

  it("overshoots past the target and corrects back when requested", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({ "Input.dispatchMouseEvent": () => ({}) });

    const res = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 800, to_y: 400, overshoot: true, ...QUICK },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.overshoot).toBe(true);
    expect(res.steps).toBeGreaterThan(12);
    const path = moves(fake.sent);
    expect(path.length).toBeGreaterThan(12);
    expect(path.length).toBeLessThanOrEqual(15);
    // Past the destination along the travel axis, then back exactly.
    const start: Vec2 = { x: 640, y: 360 };
    const projection = (p: Vec2) =>
      ((p.x - start.x) * 160 + (p.y - start.y) * 40) / (160 ** 2 + 40 ** 2);
    expect(projection(path[11])).toBeGreaterThan(1.019);
    expect(projection(path[11])).toBeLessThanOrEqual(1.081);
    expect(path[path.length - 1]).toMatchObject({ x: 800, y: 400 });
    const d = distance(path[path.length - 1], { x: 800, y: 400 });
    expect(d).toBe(0);
  });

  it("rejects an out-of-viewport destination before dispatching", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({});

    const res = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 1300, to_y: 300 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    expect(res).toMatchObject({
      code: "invalid_params",
      message: /outside the 1280x720 viewport/,
    });
    expect(fake.sent.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("rejects partial or non-finite from_* pairs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({});

    const partial = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 100, to_y: 100, from_x: 5 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(partial).toMatchObject({ code: "invalid_params", message: /provided together/ });

    const nonFinite = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 100, to_y: 100, from_x: Number.NaN, from_y: 5 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(nonFinite).toMatchObject({ code: "invalid_params", message: /finite/ });
    expect(fake.sent.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("validates duration and step bounds locally", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({});

    const badDuration = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 100, to_y: 100, duration_ms: 0 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(badDuration).toMatchObject({ code: "invalid_params", message: /duration_ms/ });

    const bigDuration = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 100, to_y: 100, duration_ms: 61_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(bigDuration).toMatchObject({ code: "invalid_params", message: /duration_ms/ });

    const oneStep = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 100, to_y: 100, steps: 1 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(oneStep).toMatchObject({ code: "invalid_params", message: /steps/ });
    expect(fake.sent.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("reports cancelled when the signal is already aborted", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.startWithWindow("aa11");
    const fake = makeFakeCdp({ "Input.dispatchMouseEvent": () => ({}) });
    const controller = new AbortController();
    controller.abort();

    const res = await handleMouseMove(
      sm,
      { session_id: "aa11", to_x: 800, to_y: 400, ...QUICK },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: controller.signal },
    );

    expect(res).toMatchObject({ code: "cancelled" });
    expect(fake.sent.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });
});
