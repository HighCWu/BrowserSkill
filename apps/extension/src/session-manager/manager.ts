import {
  AGENT_WINDOW_HOME,
  type AgentWindowApi,
  type AgentWindowCreateOptions,
  chromeAgentWindowApi,
} from "./agent-window";
import { RefStore } from "./ref-store";

export interface SessionContext {
  /** Remote connections retain dedicated windows, with explicit page ownership. */
  remote?: boolean;
  sessionId: string;
  /**
   * The session's Agent Window, created lazily: `start` registers the
   * session without opening any window, and the window materializes on
   * first need (`ensureAgentWindow`) — `tab_create`, a legacy (moving)
   * `tab_borrow`, `window_resize`, `record_start`. In-place workflows
   * never trigger it, so no window and no blank home tab appear.
   */
  agentWindowId?: number;
  /** Creation options captured at `start` for the lazy `ensureAgentWindow`. */
  agentWindowOptions?: AgentWindowCreateOptions;
  refStore: RefStore;
  borrowedTabs: Map<number, BorrowedTab>;
  /**
   * Tabs explicitly claimed by the agent because it created them. This
   * includes the Agent Window's home tab and tabs created by `tool.tab_create`.
   * Tabs opened through Chrome UI never enter this set.
   */
  agentCreatedTabs: Set<number>;
  /** Observed same-window popups: controllable, but preserved by session stop. */
  observedTabs?: Set<number>;
  /**
   * Tab that commands without an explicit `tab_id` target. Set by
   * `tab_borrow` (both modes) and `tab_select`, cleared by `tab_return`.
   * In-place borrows need this: their tab never enters the Agent Window,
   * so the window-based fallback cannot find it.
   */
  defaultTabId?: number;
  /** Unclassified arrivals and failed external moves must not become implicit tool targets. */
  pendingRoutingTabs?: Set<number>;
  createdAtMs: number;
}

/** Whether this session has explicitly claimed control of `tabId`. */
export function isAgentControlledTab(ctx: SessionContext, tabId: number): boolean {
  return (
    ctx.agentCreatedTabs.has(tabId) ||
    ctx.borrowedTabs.has(tabId) ||
    (ctx.observedTabs?.has(tabId) ?? false)
  );
}

/**
 * Whether `tabId` is an in-place borrow: authorized by the CLI invocation,
 * still living (and active) in its own window — exempt from Agent Window
 * scope checks, and `tab_return` only detaches.
 */
export function isInPlaceBorrowedTab(ctx: SessionContext, tabId: number): boolean {
  return ctx.borrowedTabs.get(tabId)?.inPlace === true;
}

export interface BorrowedTab {
  tabId: number;
  originalWindowId: number;
  originalIndex: number;
  /** Set for in-place borrows: the tab never moved. */
  inPlace?: boolean;
}

export interface BorrowReservation {
  release(): void;
  commit(entry: BorrowedTab): void;
}

export interface SessionManagerOptions {
  remote?: () => boolean;
  agentWindow?: AgentWindowApi;
  now?: () => number;
}

/** Options for starting a session's Agent Window. */
export interface SessionStartOptions {
  /** Optional Agent Window outer size in CSS pixels. */
  size?: { width: number; height: number };
  /** Background by default; true explicitly opens the window in front. */
  focused?: boolean;
  /** Cancellation for the transactional Agent Window startup sequence. */
  signal?: AbortSignal;
}

export class SessionStartCleanupError extends Error {
  readonly windowId: number;
  readonly startupError: unknown;
  readonly cleanupError: unknown;

  constructor(windowId: number, startupError: unknown, cleanupError: unknown) {
    const startupMessage =
      startupError instanceof Error ? startupError.message : String(startupError);
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    super(
      `session_start failed (${startupMessage}) and cleanup of Agent Window ${windowId} failed: ${cleanupMessage}`,
    );
    this.name = "SessionStartCleanupError";
    this.windowId = windowId;
    this.startupError = startupError;
    this.cleanupError = cleanupError;
  }
}

function sessionStartAbortError(): Error {
  const error = new Error("session_start aborted");
  error.name = "AbortError";
  return error;
}

function throwIfSessionStartAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw sessionStartAbortError();
}

/**
 * Owner of all live agent sessions inside the extension.
 *
 * The daemon side has its own `SessionRegistry`; this class is the
 * extension-side mirror that holds the per-session Agent Window id,
 * ref-store, and borrowed-tab table. Tool implementations (M6+) read
 * from here to map a `session_id` back to "which Chrome window /
 * which ref / which borrowed tab".
 *
 * Designed to be unit-testable: chrome.* is injected via `AgentWindowApi`
 * so vitest never touches a real `chrome.windows` object.
 */
export class SessionManager {
  private readonly remote: () => boolean;
  private readonly sessions = new Map<string, SessionContext>();
  private readonly windowIndex = new Map<number, string>();
  private readonly borrowReservations = new Map<number, string>();
  private readonly expectedWindowClosures = new WeakSet<SessionContext>();
  private readonly pendingWindowCreations = new Map<string, Promise<number>>();
  private readonly agentWindow: AgentWindowApi;
  private readonly now: () => number;

  constructor(options: SessionManagerOptions = {}) {
    this.remote = options.remote ?? (() => false);
    this.agentWindow = options.agentWindow ?? chromeAgentWindowApi;
    this.now = options.now ?? Date.now;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionContext | null {
    return this.sessions.get(sessionId) ?? null;
  }

  isWindowCloseExpected(ctx: SessionContext): boolean {
    return this.expectedWindowClosures.has(ctx);
  }

  /** Mark only the committed window/tab removal stage of session.stop. */
  async withExpectedWindowClose<T>(ctx: SessionContext, close: () => Promise<T>): Promise<T> {
    this.expectedWindowClosures.add(ctx);
    try {
      return await close();
    } finally {
      // Failed teardown must not hide a later user-initiated close.
      this.expectedWindowClosures.delete(ctx);
    }
  }

  findByWindowId(windowId: number): SessionContext | null {
    const id = this.windowIndex.get(windowId);
    return id ? (this.sessions.get(id) ?? null) : null;
  }

  list(): SessionContext[] {
    return Array.from(this.sessions.values());
  }

  invalidateTabRefs(tabId: number): void {
    for (const ctx of this.sessions.values()) ctx.refStore.invalidateTab(tabId);
  }

  /**
   * Forget a tab Chrome has removed, including any uncommitted borrow.
   * Whole-window closures keep committed borrows until the window-removed
   * handler reports which user tabs could not be returned.
   */
  forgetClosedTab(tabId: number, { isWindowClosing = false } = {}): void {
    this.borrowReservations.delete(tabId);
    this.invalidateTabRefs(tabId);
    for (const ctx of this.sessions.values()) {
      ctx.agentCreatedTabs.delete(tabId);
      ctx.observedTabs?.delete(tabId);
      if (!isWindowClosing) ctx.borrowedTabs.delete(tabId);
    }
  }

  /** All kinds of committed control, not just borrowed tabs. */
  findControllingSession(tabId: number): string | null {
    return this.list().find((ctx) => isAgentControlledTab(ctx, tabId))?.sessionId ?? null;
  }

  /** Observation does not follow a page moved out by the browser user. */
  releaseObservedTab(tabId: number): string[] {
    const released: string[] = [];
    for (const ctx of this.sessions.values()) {
      if (ctx.observedTabs?.delete(tabId)) {
        ctx.refStore.invalidateTab(tabId);
        released.push(ctx.sessionId);
      }
    }
    return released;
  }

  /**
   * Look up whether `tabId` is currently borrowed by some *other*
   * session than the one calling. Used by M8 `tab_borrow` to refuse
   * a second borrow on the same Chrome tab, and by `tab_close` to
   * tell apart "user tab" from "another session's borrowed tab"
   * (which we must not allow direct access to).
   *
   * Returns the borrowing session id when applicable, otherwise null.
   */
  findBorrowingSession(tabId: number, currentSessionId: string | null): string | null {
    for (const ctx of this.sessions.values()) {
      if (ctx.sessionId === currentSessionId) continue;
      if (ctx.borrowedTabs.has(tabId)) return ctx.sessionId;
    }
    const reservedBy = this.borrowReservations.get(tabId);
    if (reservedBy && reservedBy !== currentSessionId) return reservedBy;
    return null;
  }

  /**
   * Reserve a tab for `tool.tab_borrow` before the handler performs any
   * awaited Chrome work. This closes the cross-session race between the
   * "is anyone borrowing this tab?" check and the eventual borrowedTabs
   * write after `chrome.tabs.move`.
   */
  tryReserveBorrow(tabId: number, sessionId: string): BorrowReservation | { borrowedBy: string } {
    const borrowedBy =
      this.borrowReservations.get(tabId) ??
      this.findControllingSession(tabId) ??
      this.findBorrowingSession(tabId, sessionId);
    if (borrowedBy) return { borrowedBy };
    this.borrowReservations.set(tabId, sessionId);
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      if (this.borrowReservations.get(tabId) === sessionId) {
        this.borrowReservations.delete(tabId);
      }
    };
    return {
      release,
      commit: (entry) => {
        if (closed) return;
        const ctx = this.sessions.get(sessionId);
        if (!ctx) {
          release();
          throw new Error(`session ${sessionId} disappeared during tab_borrow`);
        }
        if (this.borrowReservations.get(tabId) !== sessionId) {
          throw new Error(`tab ${tabId} borrow reservation disappeared before commit`);
        }
        ctx.borrowedTabs.set(tabId, entry);
        release();
      },
    };
  }

  /**
   * Register a fresh session **without opening any window**.
   *
   * The Agent Window is a lazily-created resource since the in-place
   * borrow workflow became the default: a session that only borrows user
   * tabs in place never needs one, so `start` captures the creation
   * options and leaves the window to `ensureAgentWindow`. Returns the
   * context immediately; callers echo `agent_window_id` (absent until a
   * window exists) back to the daemon.
   */
  async start(sessionId: string, opts: SessionStartOptions = {}): Promise<SessionContext> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`[bh] session ${sessionId} already exists`);
    }
    throwIfSessionStartAborted(opts.signal);

    const { signal: _signal, size, focused, ...rest } = opts;
    void rest;
    const agentWindowOptions: AgentWindowCreateOptions = {
      ...(size ? { size } : {}),
      ...(focused !== undefined ? { focused } : {}),
    };
    const ctx: SessionContext = {
      ...(this.remote() ? { remote: true } : {}),
      sessionId,
      ...(Object.keys(agentWindowOptions).length > 0 ? { agentWindowOptions } : {}),
      refStore: new RefStore(),
      borrowedTabs: new Map(),
      agentCreatedTabs: new Set<number>(),
      createdAtMs: this.now(),
    };
    this.sessions.set(sessionId, ctx);
    return ctx;
  }

  /**
   * `start` + immediate `ensureAgentWindow` — the eager equivalent of the
   * old window-at-start behavior. Callers that know they need the Agent
   * Window (tests, remote sessions) use this; everything else stays lazy.
   */
  async startWithWindow(
    sessionId: string,
    opts: SessionStartOptions = {},
  ): Promise<SessionContext> {
    const ctx = await this.start(sessionId, opts);
    await this.ensureAgentWindow(ctx, { signal: opts.signal });
    return ctx;
  }

  /**
   * Materialize the session's Agent Window on first need. Concurrent
   * callers share one creation; a mid-flight abort rolls the window back.
   * Resolves with the window id and registers the window + its home tab
   * as session-owned.
   */
  async ensureAgentWindow(
    ctx: SessionContext,
    opts: { signal?: AbortSignal } = {},
  ): Promise<number> {
    if (ctx.agentWindowId !== undefined) return ctx.agentWindowId;
    const inFlight = this.pendingWindowCreations.get(ctx.sessionId);
    if (inFlight) return inFlight;
    const creation = this.createAgentWindowNow(ctx, opts.signal).finally(() => {
      this.pendingWindowCreations.delete(ctx.sessionId);
    });
    this.pendingWindowCreations.set(ctx.sessionId, creation);
    return creation;
  }

  private async createAgentWindowNow(ctx: SessionContext, signal?: AbortSignal): Promise<number> {
    throwIfSessionStartAborted(signal);
    const created = await this.agentWindow.create(AGENT_WINDOW_HOME, ctx.agentWindowOptions ?? {});
    const windowId = created.windowId;
    const agentCreatedTabs = new Set<number>(created.initialTabIds);
    try {
      throwIfSessionStartAborted(signal);
      const homeTabId = await this.agentWindow.ensureActiveTab(
        windowId,
        AGENT_WINDOW_HOME,
        agentCreatedTabs,
      );
      agentCreatedTabs.add(homeTabId);
      throwIfSessionStartAborted(signal);
    } catch (startupError) {
      try {
        await this.agentWindow.remove(windowId);
      } catch (cleanupError) {
        // Retain the exact window handle on the context (indexed for
        // findByWindowId) so a retried `stop` can close it.
        ctx.agentWindowId = windowId;
        for (const tabId of agentCreatedTabs) ctx.agentCreatedTabs.add(tabId);
        this.windowIndex.set(windowId, ctx.sessionId);
        throw new SessionStartCleanupError(windowId, startupError, cleanupError);
      }
      throw startupError;
    }
    // Re-check the session still exists (a concurrent stop must win).
    if (this.sessions.get(ctx.sessionId) !== ctx) {
      try {
        await this.agentWindow.remove(windowId);
      } catch {
        /* Session teardown already reported the state; nothing to add. */
      }
      throw new Error(`[bh] session ${ctx.sessionId} ended during Agent Window creation`);
    }
    ctx.agentWindowId = windowId;
    for (const tabId of agentCreatedTabs) ctx.agentCreatedTabs.add(tabId);
    this.windowIndex.set(windowId, ctx.sessionId);
    return windowId;
  }

  /**
   * Tear down a session: close its Agent Window and drop the context.
   *
   * `dropOnly = true` skips closing the window — used when the user
   * already closed it manually (M5.4 path) so we don't accidentally
   * close a window that has been re-purposed.
   */
  async stop(
    sessionId: string,
    options: { dropOnly?: boolean } = {},
  ): Promise<SessionContext | null> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return null;
    if (!options.dropOnly && ctx.agentWindowId !== undefined) {
      await this.agentWindow.remove(ctx.agentWindowId);
    }
    this.sessions.delete(sessionId);
    if (ctx.agentWindowId !== undefined) this.windowIndex.delete(ctx.agentWindowId);
    return ctx;
  }

  /**
   * Best-effort cleanup of every live session (emergency brake / SW
   * shutdown). Returns the set of `session_id`s that were removed.
   */
  async stopAll(options: { dropOnly?: boolean } = {}): Promise<string[]> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.stop(id, options);
    }
    return ids;
  }
}
