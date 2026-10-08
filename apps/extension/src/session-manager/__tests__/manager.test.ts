import { describe, expect, it, vi } from "vitest";
import type {
  AgentWindowApi,
  AgentWindowCreateOptions,
  AgentWindowCreation,
} from "../agent-window";
import { isAgentControlledTab, SessionManager } from "../manager";

function fakeAgentWindow(): AgentWindowApi & {
  createMock: ReturnType<typeof vi.fn>;
  removeMock: ReturnType<typeof vi.fn>;
  ensureActiveTabMock: ReturnType<typeof vi.fn>;
} {
  let nextId = 100;
  const createMock = vi.fn(async (_url: string, _opts?: AgentWindowCreateOptions) => {
    const id = nextId++;
    return { windowId: id, initialTabIds: [] };
  });
  const removeMock = vi.fn(async (_id: number) => {});
  const ensureActiveTabMock = vi.fn(async (_windowId: number, _url: string) => 0);
  return {
    create: createMock,
    remove: removeMock,
    ensureActiveTab: ensureActiveTabMock,
    createMock,
    removeMock,
    ensureActiveTabMock,
  };
}

describe("SessionManager", () => {
  it("registers a session without opening an Agent Window", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw, now: () => 1700000000000 });
    const ctx = await sm.start("aa11");
    expect(aw.createMock).not.toHaveBeenCalled();
    expect(ctx.sessionId).toBe("aa11");
    expect(ctx.agentWindowId).toBeUndefined();
    expect(ctx.createdAtMs).toBe(1700000000000);
    expect(ctx.refStore.isEmpty()).toBe(true);
    expect(ctx.borrowedTabs.size).toBe(0);
    expect(ctx.agentCreatedTabs.size).toBe(0);
  });

  it("materializes the Agent Window on first ensureAgentWindow", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11", { size: { width: 1280, height: 800 }, focused: false });
    const windowId = await sm.ensureAgentWindow(ctx);
    expect(windowId).toBe(100);
    expect(aw.createMock).toHaveBeenCalledOnce();
    expect(aw.createMock).toHaveBeenCalledWith("about:blank", {
      size: { width: 1280, height: 800 },
      focused: false,
    });
    expect(aw.ensureActiveTabMock).toHaveBeenCalledWith(100, "about:blank", expect.any(Set));
    expect(ctx.agentWindowId).toBe(100);
    expect(sm.findByWindowId(100)).toBe(ctx);
    // The home tab is claimed for the session.
    expect(isAgentControlledTab(ctx, 0)).toBe(true);

    // Second ensure is a no-op.
    await expect(sm.ensureAgentWindow(ctx)).resolves.toBe(100);
    expect(aw.createMock).toHaveBeenCalledOnce();
  });

  it("shares one creation between concurrent ensureAgentWindow calls", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    const [a, b] = await Promise.all([sm.ensureAgentWindow(ctx), sm.ensureAgentWindow(ctx)]);
    expect(a).toBe(100);
    expect(b).toBe(100);
    expect(aw.createMock).toHaveBeenCalledOnce();
  });

  it("rolls the window back when ensureAgentWindow is aborted", async () => {
    const aw = fakeAgentWindow();
    let resolveCreate: (result: AgentWindowCreation) => void = () => {};
    aw.createMock.mockImplementationOnce(
      () =>
        new Promise<AgentWindowCreation>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    const controller = new AbortController();
    const pending = sm.ensureAgentWindow(ctx, { signal: controller.signal });

    controller.abort();
    resolveCreate({ windowId: 777, initialTabIds: [7] });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(aw.removeMock).toHaveBeenCalledWith(777);
    expect(ctx.agentWindowId).toBeUndefined();
    expect(ctx.agentCreatedTabs.size).toBe(0);
    // A later ensure can start over.
    await expect(sm.ensureAgentWindow(ctx)).resolves.toBe(100);
  });

  it("removes an incomplete Agent Window when active-tab setup fails", async () => {
    const aw = fakeAgentWindow();
    aw.ensureActiveTabMock.mockRejectedValueOnce(new Error("tab setup failed"));
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");

    await expect(sm.ensureAgentWindow(ctx)).rejects.toThrow("tab setup failed");

    expect(aw.removeMock).toHaveBeenCalledWith(100);
    expect(ctx.agentWindowId).toBeUndefined();
    // The session itself survives a failed lazy creation.
    expect(sm.has("aa11")).toBe(true);
  });

  it("retains a failed ensure window so stop can retry cleanup", async () => {
    const aw = fakeAgentWindow();
    aw.ensureActiveTabMock.mockRejectedValueOnce(new Error("tab setup failed"));
    aw.removeMock.mockRejectedValueOnce(new Error("window removal denied"));
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");

    await expect(sm.ensureAgentWindow(ctx)).rejects.toMatchObject({
      name: "SessionStartCleanupError",
      windowId: 100,
      message: expect.stringMatching(/cleanup of Agent Window 100 failed.*window removal denied/),
    });
    expect(sm.has("aa11")).toBe(true);
    expect(sm.findByWindowId(100)?.sessionId).toBe("aa11");
    await sm.stop("aa11");
    expect(aw.removeMock).toHaveBeenCalledTimes(2);
    expect(sm.has("aa11")).toBe(false);
    expect(sm.findByWindowId(100)).toBeNull();
  });

  it("indexes the session by sessionId and agent window id once materialized", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    expect(sm.has("aa11")).toBe(true);
    expect(sm.get("aa11")).toBe(ctx);
    expect(sm.findByWindowId(99999)).toBeNull();
    await sm.ensureAgentWindow(ctx);
    expect(sm.findByWindowId(100)).toBe(ctx);
    expect(sm.list().length).toBe(1);
  });

  it("rejects starting the same session twice", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    await sm.start("aa11");
    await expect(sm.start("aa11")).rejects.toThrow(/already exists/);
  });

  it("stop() without a materialized window skips chrome.windows.remove", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    const removed = await sm.stop("aa11");
    expect(removed).toBe(ctx);
    expect(aw.removeMock).not.toHaveBeenCalled();
    expect(sm.has("aa11")).toBe(false);
  });

  it("stop() closes the Agent Window and forgets the session", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    const windowId = await sm.ensureAgentWindow(ctx);
    const removed = await sm.stop("aa11");
    expect(removed).toBe(ctx);
    expect(aw.removeMock).toHaveBeenCalledWith(windowId);
    expect(sm.has("aa11")).toBe(false);
    expect(sm.findByWindowId(windowId)).toBeNull();
  });

  it("stop({ dropOnly: true }) skips the chrome.windows.remove call", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    await sm.start("aa11");
    await sm.stop("aa11", { dropOnly: true });
    expect(aw.removeMock).not.toHaveBeenCalled();
    expect(sm.has("aa11")).toBe(false);
  });

  it("stopAll() drops every session and returns their ids", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    await sm.start("aa11");
    await sm.start("bb22");
    const dropped = await sm.stopAll();
    expect(dropped.sort()).toEqual(["aa11", "bb22"]);
    expect(sm.list()).toEqual([]);
  });

  describe("explicit tab claims", () => {
    it("claims the exact home tab returned by AgentWindowApi", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      await sm.ensureAgentWindow(ctx);
      expect(ctx.agentCreatedTabs).toEqual(new Set([0]));
      expect(isAgentControlledTab(ctx, 0)).toBe(true);
    });

    it("keeps every other tab free without classification state", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      await sm.ensureAgentWindow(ctx);
      expect(isAgentControlledTab(ctx, 99)).toBe(false);
      expect(ctx).not.toHaveProperty("userTabs");
      expect(ctx).not.toHaveProperty("pendingAgentTabCount");
    });

    it("treats a committed borrow as an explicit claim", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      const reservation = sm.tryReserveBorrow(42, ctx.sessionId);
      if ("borrowedBy" in reservation) throw new Error("unexpected borrow conflict");
      reservation.commit({ tabId: 42, originalWindowId: 7, originalIndex: 3 });
      expect(isAgentControlledTab(ctx, 42)).toBe(true);
    });

    it("forgets an agent-created tab after Chrome removes it", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      await sm.ensureAgentWindow(ctx);
      ctx.agentCreatedTabs.add(42);
      sm.forgetClosedTab(42);
      expect(ctx.agentCreatedTabs.has(42)).toBe(false);
      expect(isAgentControlledTab(ctx, 0)).toBe(true);
    });

    it("forgets closed borrows idempotently without affecting other tabs or sessions", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const a = await sm.start("aa11");
      const b = await sm.start("bb22");
      a.borrowedTabs.set(42, { tabId: 42, originalWindowId: 7, originalIndex: 0 });
      a.borrowedTabs.set(43, { tabId: 43, originalWindowId: 7, originalIndex: 1 });
      b.borrowedTabs.set(44, { tabId: 44, originalWindowId: 8, originalIndex: 0 });

      sm.forgetClosedTab(42);
      sm.forgetClosedTab(42);
      sm.forgetClosedTab(999);

      expect(isAgentControlledTab(a, 42)).toBe(false);
      expect(sm.findBorrowingSession(42, null)).toBeNull();
      expect([...a.borrowedTabs.keys()]).toEqual([43]);
      expect([...b.borrowedTabs.keys()]).toEqual([44]);
      expect(sm.list()).toHaveLength(2);
    });

    it("prevents an in-flight borrow from reclaiming a closed tab", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      const reservation = sm.tryReserveBorrow(42, ctx.sessionId);
      if ("borrowedBy" in reservation) throw new Error("unexpected borrow conflict");

      sm.forgetClosedTab(42);

      expect(() =>
        reservation.commit({ tabId: 42, originalWindowId: 7, originalIndex: 0 }),
      ).toThrow(/reservation disappeared/);
      reservation.release();
      expect(sm.findBorrowingSession(42, null)).toBeNull();
      expect(ctx.borrowedTabs.has(42)).toBe(false);
    });
  });

  describe("findBorrowingSession", () => {
    it("returns null when no session has borrowed the tab", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      await sm.start("aa11");
      expect(sm.findBorrowingSession(42, "aa11")).toBeNull();
      expect(sm.findBorrowingSession(42, null)).toBeNull();
    });

    it("ignores borrows held by the calling session itself", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      ctx.borrowedTabs.set(42, { tabId: 42, originalWindowId: 7, originalIndex: 3 });
      expect(sm.findBorrowingSession(42, "aa11")).toBeNull();
    });

    it("reports the borrowing session id when a different session holds the tab", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const a = await sm.start("aa11");
      await sm.start("bb22");
      a.borrowedTabs.set(42, { tabId: 42, originalWindowId: 7, originalIndex: 3 });
      expect(sm.findBorrowingSession(42, "bb22")).toBe("aa11");
      // currentSessionId=null asks "is anyone borrowing this tab?"
      expect(sm.findBorrowingSession(42, null)).toBe("aa11");
    });
  });
});
