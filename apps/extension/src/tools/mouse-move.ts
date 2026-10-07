// tool.mouse_move — move the pointer along a humanised trajectory.
//
// Unlike `hover` (which snaps the pointer in a single event), this tool
// dispatches a planned sequence of real `mouseMoved` inputs with genuine
// sleeps in between: a Bézier path with an ease-in-out velocity
// envelope, per-point noise, and an occasional overshoot-and-correct
// tail. The planned timings are part of the observable behaviour.

import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type { MouseCurve, MouseMoveParams, MouseMoveResult, RpcError } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { cdpError } from "./errors";
import { checkOverlayAtPoint, hoverPointInViewport } from "./interaction";
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

export interface MouseMoveDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  signal?: AbortSignal;
  /** Temporarily disable the Agent Window overlay's input blocker. */
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
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

    const curve: MouseCurve = params.curve ?? "bezier";
    const dist = distance(start, destination);
    const durationMs = params.duration_ms ?? adaptiveDurationMs(dist);
    const steps = params.steps ?? defaultSteps(durationMs);
    const overshoot = params.overshoot ?? randomOvershoot();
    const jitter = params.jitter ?? true;

    const points = planTrajectory({
      from: start,
      to: destination,
      durationMs,
      steps,
      curve,
      overshoot,
      jitter,
      rng: Math.random,
    });

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
      });
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
      overshoot: points.length > steps,
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
