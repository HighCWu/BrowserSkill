import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { FrameHandler, Transport } from "@/transport/transport";
import type { ProtocolFrame } from "@/transport/types";
import { ToolDispatcher } from "../dispatcher";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const create = vi.fn(async () => ({ windowId: 10, initialTabIds: [100] }));
  const remove = vi.fn(async () => {});
  const sessions = new SessionManager({
    agentWindow: { create, remove, ensureActiveTab: async () => 100 },
  });
  let receive!: FrameHandler;
  const send = vi.fn<(frame: ProtocolFrame) => void>();
  const transport: Transport = {
    state: "connected",
    connect: async () => {},
    disconnect: async () => {},
    send,
    onMessage: (handler) => {
      receive = handler;
      return { dispose: () => {} };
    },
    onConnectionStateChange: () => ({ dispose: () => {} }),
  };
  const dispatcher = new ToolDispatcher({ transport, sessions });
  dispatcher.start();
  const start = (id: string) =>
    receive({ id, method: "tool.session_start", params: { session_id: id } });
  return { dispatcher, sessions, create, remove, send, receive, start };
}

describe("idle connection changes", () => {
  it("leaves an existing session alone", async () => {
    const s = setup();
    await s.sessions.startWithWindow("active");
    const change = vi.fn(async () => {});

    expect(await s.dispatcher.runWhenIdle(change)).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(s.sessions.has("active")).toBe(true);
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("registers a lazy session without a window; the idle gate stays shut for its lifetime", async () => {
    const s = setup();
    const change = vi.fn(async () => {});

    s.start("starting");
    await vi.waitFor(() => expect(s.sessions.has("starting")).toBe(true));
    // Lazy: no window was created for the session.
    expect(s.create).not.toHaveBeenCalled();
    expect(await s.dispatcher.runWhenIdle(change)).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("rejects starts throughout saving and reconnecting, then allows a fresh request", async () => {
    const s = setup();
    const saved = deferred<void>();
    const reconnected = deferred<void>();
    const reconnect = vi.fn(() => reconnected.promise);
    const change = s.dispatcher.runWhenIdle(async () => {
      await saved.promise;
      await reconnect();
    });

    const expectStartRejected = async (id: string) => {
      s.start(id);
      await vi.waitFor(() =>
        expect(s.send).toHaveBeenCalledWith({
          id,
          error: {
            code: "protocol_error",
            message: "Browser settings are updating; retry session start.",
          },
        }),
      );
      expect(s.create).not.toHaveBeenCalled();
      expect(s.sessions.list()).toHaveLength(0);
    };
    await expectStartRejected("during-save");
    saved.resolve();
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledOnce());
    await expectStartRejected("during-reconnect");
    const secondChange = vi.fn(async () => {});
    expect(await s.dispatcher.runWhenIdle(secondChange)).toBe(false);
    expect(secondChange).not.toHaveBeenCalled();

    reconnected.resolve();
    expect(await change).toBe(true);
    s.start("retry");
    await vi.waitFor(() => expect(s.sessions.has("retry")).toBe(true));
    // Lazy: the fresh start still opens no window.
    expect(s.create).not.toHaveBeenCalled();
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("releases the reservation when a settings update fails", async () => {
    const s = setup();
    await expect(
      s.dispatcher.runWhenIdle(async () => {
        throw new Error("storage unavailable");
      }),
    ).rejects.toThrow("storage unavailable");

    s.start("retry");
    await vi.waitFor(() => expect(s.sessions.has("retry")).toBe(true));
    expect(s.create).not.toHaveBeenCalled();
  });

  it("allows a connection change after a failed session start", async () => {
    const s = setup();
    // A rejected start registers nothing, so the gate must not wedge shut.
    s.receive({
      id: "failed",
      method: "tool.session_start",
      params: { session_id: "" },
    });
    await vi.waitFor(() =>
      expect(s.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: "failed", error: expect.any(Object) }),
      ),
    );
    expect(s.sessions.list()).toHaveLength(0);
    const change = vi.fn(async () => {});
    expect(await s.dispatcher.runWhenIdle(change)).toBe(true);
    expect(change).toHaveBeenCalledOnce();
  });

  it("allows a connection change once the session is stopped", async () => {
    const s = setup();
    await s.sessions.startWithWindow("active");
    expect(await s.dispatcher.runWhenIdle(vi.fn(async () => {}))).toBe(false);
    await s.sessions.stop("active");
    const change = vi.fn(async () => {});
    expect(await s.dispatcher.runWhenIdle(change)).toBe(true);
    expect(change).toHaveBeenCalledOnce();
  });
});
