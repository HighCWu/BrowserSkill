// tool.mouse_move — move the pointer along a humanised trajectory.
//
// Two planning regimes share this handler. With every knob at its
// default the pointer follows the v2 behaviour state machine
// (trajectory-behavior.ts): a main pulse, hesitation, en-route
// inspection of interactive elements, corrective pulses, the occasional
// rethink. Passing any explicit knob (`steps`, `duration_ms`,
// `curve: "linear"`) selects the deterministic single-segment v1 plan
// (trajectory.ts) so scripted callers get exactly what they asked for.
// Both dispatch real `Input.dispatchMouseEvent` `mouseMoved` events with
// genuine sleeps in between — the timing is part of the output, never
// zero-delay bursts.
//
// The v1 path shapes (perpendicular Bézier anchor offsets, overshoot
// radius) follow ideas popularised by the MIT-licensed ghost-cursor
// project; the implementation here is original.

import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { type CursorVisualNotifier, LANDING_SETTLE_BUDGET_MS } from "@/lib/cursor-notify";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type { MouseCurve, MouseMoveParams, MouseMoveResult, RpcError } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { cdpError } from "./errors";
import { checkOverlayAtPoint, hoverPointInViewport } from "./interaction";
import { probeInteractiveAt } from "./page-probe";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";
import {
  adaptiveDurationMs,
  defaultSteps,
  dispatchTrajectory,
  distance,
  glideStart,
  planTrajectory,
  randomOvershoot,
  type Vec2,
} from "./trajectory";
import { planBehaviorTrajectory } from "./trajectory-behavior";

export interface MouseMoveDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  signal?: AbortSignal;
  /** Temporarily disable the Agent Window overlay's input blocker. */
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
  /**
   * Visual pointer indicator notifier (no-op unless the daemon enabled the
   * overlay). Trajectory points stream to it fire-and-forget; the landing
   * gets one short capped settle wait.
   */
  cursor?: CursorVisualNotifier;
  /** Injected random source for reproducible plans (tests). */
  rng?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DURATION_MS = 60_000;
const MAX_STEPS = 500;

let defaultDeps: { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } | null = null;
function getDefaultDeps(): MouseMoveDeps {
  if (!defaultDeps) defaultDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi };
  return defaultDeps;
}

/** Reject invalid requests before any CDP work. */
function paramsError(params: MouseMoveParams): RpcError | null {
  if (!Number.isFinite(params.to_x) || !Number.isFinite(params.to_y)) {
    return { code: "invalid_params", message: "mouse_move to_x/to_y must be finite numbers" };
  }
  const hasFromX = params.from_x !== undefined;
  const hasFromY = params.from_y !== undefined;
  if (hasFromX !== hasFromY) {
    return {
      code: "invalid_params",
      message: "mouse_move from_x and from_y must be provided together",
    };
  }
  if (hasFromX && (!Number.isFinite(params.from_x!) || !Number.isFinite(params.from_y!))) {
    return { code: "invalid_params", message: "mouse_move from_x/from_y must be finite numbers" };
  }
  if (params.duration_ms !== undefined) {
    if (!Number.isSafeInteger(params.duration_ms) || params.duration_ms < 1) {
      return {
        code: "invalid_params",
        message: "mouse_move duration_ms must be a positive integer",
      };
    }
    if (params.duration_ms > MAX_DURATION_MS) {
      return {
        code: "invalid_params",
        message: `mouse_move duration_ms must be at most ${MAX_DURATION_MS}`,
      };
    }
  }
  if (params.steps !== undefined) {
    if (!Number.isSafeInteger(params.steps) || params.steps < 2) {
      return {
        code: "invalid_params",
        message: "mouse_move steps must be an integer of at least 2",
      };
    }
    if (params.steps > MAX_STEPS) {
      return {
        code: "invalid_params",
        message: `mouse_move steps must be at most ${MAX_STEPS}`,
      };
    }
  }
  return null;
}

export async function handleMouseMove(
  manager: SessionManager,
  params: MouseMoveParams,
  deps: MouseMoveDeps = getDefaultDeps(),
): Promise<MouseMoveResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "mouse_move");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx: SessionContext = ctxOrErr;
  const invalid = paramsError(params);
  if (invalid) return invalid;
  const deadline = Date.now() + (params.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const checkActive = () => {
    if (deps.signal?.aborted) throw new DOMException("mouse_move aborted", "AbortError");
    if (Date.now() >= deadline) throw new DOMException("mouse_move timed out", "TimeoutError");
  };

  try {
    checkActive();
    const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
    checkActive();
    if (isRpcError(target)) return target;
    const denied = enforceAgentWindow(ctx, target, "mouse_move");
    if (denied) return denied;

    const tabId = target.tabId;
    const dialogCursor = markDialogCursor(deps.cdp, tabId);
    deps.cdp.trackSessionTab?.(ctx.sessionId, tabId);

    const destination = await hoverPointInViewport(deps.cdp, tabId, params.to_x, params.to_y);
    if (isRpcError(destination)) return destination;

    // Start: explicit from_* > remembered pointer position > viewport centre.
    let start: Vec2;
    if (params.from_x !== undefined && params.from_y !== undefined) {
      const explicit = await hoverPointInViewport(deps.cdp, tabId, params.from_x, params.from_y);
      if (isRpcError(explicit)) return explicit;
      start = explicit;
    } else {
      const resolved = await glideStart(deps.cdp, tabId);
      if (!resolved) {
        return { code: "cdp_failed", message: "Page.getLayoutMetrics returned no viewport size" };
      }
      start = resolved;
    }
    checkActive();

    checkActive();

    // v1 deterministic single-segment mode: any explicit knob opts out
    // of the behaviour state machine.
    const legacyMode =
      params.steps !== undefined || params.duration_ms !== undefined || params.curve === "linear";

    const curve: MouseCurve = params.curve ?? "bezier";
    const jitter = params.jitter ?? true;
    let points: Awaited<ReturnType<typeof planTrajectory>>;
    let overshootHappened: boolean;
    if (legacyMode) {
      const dist = distance(start, destination);
      const durationMs = params.duration_ms ?? adaptiveDurationMs(dist);
      const steps = params.steps ?? defaultSteps(durationMs);
      const overshoot = params.overshoot ?? randomOvershoot();
      points = planTrajectory({
        from: start,
        to: destination,
        durationMs,
        steps,
        curve,
        overshoot,
        jitter,
        rng: deps.rng ?? Math.random,
      });
      overshootHappened = points.length > steps;
    } else {
      const plan = await planBehaviorTrajectory({
        from: start,
        to: destination,
        probe: (x, y) => probeInteractiveAt(deps.cdp, tabId, x, y),
        overshoot: params.overshoot,
        jitter,
        rng: deps.rng ?? Math.random,
      });
      points = plan.points;
      overshootHappened = plan.overshoot;
    }

    // The overlay input blocker would swallow the trajectory's hover
    // events the same way it does for hover, so bypass it when present.
    const overlayBlocking = await checkOverlayAtPoint(
      deps.cdp,
      tabId,
      destination.x,
      destination.y,
    );
    let bypassTab: number | undefined;
    if (overlayBlocking && deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(tabId, true);
        bypassTab = tabId;
      } catch (err) {
        console.debug("[bsk mouse_move] overlay bypass enable failed", err);
      }
    }

    try {
      await dispatchTrajectory(deps.cdp, tabId, points, {
        signal: deps.signal,
        remember: (point) => deps.cdp.rememberMousePos?.(tabId, point.x, point.y),
        notify: (point) => deps.cursor?.move(tabId, point.x, point.y),
      });
      // One capped beat so the indicator's glide settles at the destination
      // before the command returns. Zero-cost while the overlay is off.
      await deps.cursor?.settle(tabId, destination.x, destination.y, LANDING_SETTLE_BUDGET_MS);
      checkActive();
    } finally {
      if (bypassTab !== undefined && deps.bypassOverlay) {
        try {
          await deps.bypassOverlay(bypassTab, false);
        } catch (err) {
          console.debug("[bsk mouse_move] overlay bypass disable failed", err);
        }
      }
    }

    const plannedDurationMs = Math.round(points.reduce((sum, p) => sum + p.delayMs, 0));
    return attachDialogs(deps.cdp, tabId, dialogCursor, {
      tab_id: tabId,
      from_x: start.x,
      from_y: start.y,
      x: destination.x,
      y: destination.y,
      steps: points.length,
      duration_ms: plannedDurationMs,
      overshoot: overshootHappened,
      curve,
    });
  } catch (error) {
    if (deps.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return { code: "cancelled", message: "mouse_move aborted" };
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { code: "timeout", message: "mouse_move timed out" };
    }
    return cdpError(error);
  }
}
