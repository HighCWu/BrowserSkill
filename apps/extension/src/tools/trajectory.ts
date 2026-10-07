// Humanised mouse trajectories.
//
// Plans pointer paths that approximate how a hand moves a mouse: a curved
// route with a slow-fast-slow velocity envelope, per-point noise, and an
// occasional overshoot past the target followed by a short correction.
// Points are dispatched as real `Input.dispatchMouseEvent` `mouseMoved`
// events with genuine sleeps in between — the timing is part of the
// output, never zero-delay bursts.
//
// The path shapes (perpendicular Bézier anchor offsets, overshoot radius)
// follow ideas popularised by the MIT-licensed ghost-cursor project; the
// implementation here is original.

import type { MouseCurve } from "@/transport/types";
import type { CdpRunner } from "./shared";

export interface Vec2 {
  x: number;
  y: number;
}

export interface TrajectoryPoint {
  x: number;
  y: number;
  /** Real sleep after dispatching this point, in milliseconds. */
  delayMs: number;
}

export interface PlanTrajectoryOptions {
  from: Vec2;
  to: Vec2;
  /** Approximate total wall-clock duration of the move. */
  durationMs: number;
  /** Number of dispatched points on the main segment (>= 2). */
  steps: number;
  curve: MouseCurve;
  /** Whether an overshoot-and-correct segment may be planned. */
  overshoot: boolean;
  /** Add ±0.5 px noise to intermediate points. */
  jitter: boolean;
  /** Injected random source; defaults to `Math.random`. */
  rng?: () => number;
}

/** Control-point offset as a fraction of travel distance. */
const MIN_ANCHOR_SPREAD = 0.05;
const MAX_ANCHOR_SPREAD = 0.25;
/** Overshoot distance as a fraction of travel distance. */
const MIN_OVERSHOOT_FRACTION = 0.02;
const MAX_OVERSHOOT_FRACTION = 0.08;
/** Per-point sleep bounds in milliseconds. */
const MIN_DELAY_MS = 4;
const MAX_DELAY_MS = 64;
/** Relative sleep noise applied around the per-point mean. */
const DELAY_NOISE = 0.2;
/** Jitter amplitude in CSS pixels (±0.5 px). */
const JITTER_PX = 0.5;
/** Chance a default-enabled overshoot actually happens. */
export const DEFAULT_OVERSHOOT_PROBABILITY = 0.12;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Small deterministic PRNG (mulberry32) so tests — and anyone who needs
 * reproducible motion — can seed the planner.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Adaptive default duration for a move: 350 ms for short hops growing
 * towards 950 ms for long hauls.
 */
export function adaptiveDurationMs(distancePx: number): number {
  return Math.round(clamp(350 + distancePx / 2, 350, 950));
}

/** Default point count for a duration: `duration / 12` clamped to 12–80. */
export function defaultSteps(durationMs: number): number {
  return Math.round(clamp(durationMs / 12, 12, 80));
}

/**
 * Ease-in-out (cubic) velocity envelope: slow start, faster middle,
 * slow landing. Maps normalised progress to reparameterised progress.
 */
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Evaluate a cubic Bézier at parameter `t` through the given anchors.
 */
export function cubicBezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}

/**
 * Two Bézier control anchors between `a` and `b`: placed at ⅓ and ⅔
 * along the line, each offset perpendicular to it by a random 5–25% of
 * the travel distance, sharing one random side so the path reads as a
 * single arc.
 */
export function bezierAnchors(a: Vec2, b: Vec2, rng: () => number): [Vec2, Vec2] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    const mid = { x: lerp(a.x, b.x, 0.5), y: lerp(a.y, b.y, 0.5) };
    return [mid, mid];
  }
  const side = rng() < 0.5 ? -1 : 1;
  const normal = { x: -dy / len, y: dx / len };
  const anchor = (along: number): Vec2 => {
    const spread = len * (MIN_ANCHOR_SPREAD + rng() * (MAX_ANCHOR_SPREAD - MIN_ANCHOR_SPREAD));
    return {
      x: lerp(a.x, b.x, along) + normal.x * spread * side,
      y: lerp(a.y, b.y, along) + normal.y * spread * side,
    };
  };
  return [anchor(1 / 3), anchor(2 / 3)];
}

function jittered(point: Vec2, jitter: boolean, rng: () => number): Vec2 {
  if (!jitter) return point;
  return {
    x: point.x + (rng() - 0.5) * 2 * JITTER_PX,
    y: point.y + (rng() - 0.5) * 2 * JITTER_PX,
  };
}

/**
 * Plan a humanised trajectory from `from` to `to`.
 *
 * The returned list always ends exactly on `to` (destination tolerance:
 * zero) and each delay sits in `[4, 64]` ms, jittered ±20% around
 * `durationMs / pointCount`, so the total sleep lands within ~±20% of
 * the requested duration while per-point timing stays in the 8–16 ms
 * band under default settings.
 */
export function planTrajectory(options: PlanTrajectoryOptions): TrajectoryPoint[] {
  const { from, to, durationMs, curve, jitter } = options;
  const rng = options.rng ?? Math.random;
  const steps = Math.max(2, Math.round(options.steps));

  // Decide the overshoot layout up front so timing covers every point.
  const dist = distance(from, to);
  let pathEnd = to;
  let returnSteps = 0;
  if (options.overshoot && dist >= 1) {
    const fraction =
      MIN_OVERSHOOT_FRACTION + rng() * (MAX_OVERSHOOT_FRACTION - MIN_OVERSHOOT_FRACTION);
    pathEnd = {
      x: from.x + (to.x - from.x) * (1 + fraction),
      y: from.y + (to.y - from.y) * (1 + fraction),
    };
    returnSteps = 1 + Math.floor(rng() * 3); // 1–3 correction steps
  }

  const totalPoints = steps + returnSteps;
  const meanDelay = durationMs / totalPoints;
  const delay = (): number =>
    clamp(meanDelay * (1 - DELAY_NOISE + rng() * 2 * DELAY_NOISE), MIN_DELAY_MS, MAX_DELAY_MS);

  const points: TrajectoryPoint[] = [];
  if (curve === "bezier" && dist >= 1e-6) {
    const [c1, c2] = bezierAnchors(from, pathEnd, rng);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const eased = easeInOut(t);
      const raw = cubicBezier(from, c1, c2, pathEnd, eased);
      const final = i === steps - 1;
      points.push({
        ...((final ? { x: pathEnd.x, y: pathEnd.y } : jittered(raw, jitter, rng)) as Vec2),
        delayMs: delay(),
      });
    }
  } else {
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const eased = easeInOut(t);
      const raw = { x: lerp(from.x, pathEnd.x, eased), y: lerp(from.y, pathEnd.y, eased) };
      const final = i === steps - 1;
      points.push({
        ...((final ? { x: pathEnd.x, y: pathEnd.y } : jittered(raw, jitter, rng)) as Vec2),
        delayMs: delay(),
      });
    }
  }

  // Correction segment: glide back from the overshoot point to the real
  // destination. Intermediate points may jitter; the last one is exact.
  for (let i = 1; i <= returnSteps; i++) {
    const t = i / returnSteps;
    const eased = easeInOut(t);
    const raw = { x: lerp(pathEnd.x, to.x, eased), y: lerp(pathEnd.y, to.y, eased) };
    const final = i === returnSteps;
    points.push({
      ...((final ? { x: to.x, y: to.y } : jittered(raw, jitter, rng)) as Vec2),
      delayMs: delay(),
    });
  }

  return points;
}

export interface DispatchTrajectoryOptions {
  signal?: AbortSignal;
  /** CDP modifier bitfield forwarded to every `mouseMoved`. */
  modifiers?: number;
  /** Called after each dispatched point (used to track pointer position). */
  remember?: (point: Vec2) => void;
  /**
   * Visual pointer indicator hook, called after each dispatched point.
   * Fire-and-forget; implementations must never await page work here.
   */
  notify?: (point: Vec2) => void;
}

/**
 * Abort-aware sleep used between trajectory points. The wait is real —
 * callers must never collapse it to zero.
 */
export function trajectorySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("trajectory aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("trajectory aborted", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Dispatch planned points as real `mouseMoved` input, sleeping for each
 * point's delay between events. The sleep after the final point is
 * skipped. Returns the number of dispatched points.
 */
export async function dispatchTrajectory(
  cdp: CdpRunner,
  tabId: number,
  points: TrajectoryPoint[],
  options: DispatchTrajectoryOptions = {},
): Promise<number> {
  const modifiers = options.modifiers ?? 0;
  let dispatched = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (options.signal?.aborted) {
      throw new DOMException("trajectory aborted", "AbortError");
    }
    await cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      modifiers,
    });
    dispatched++;
    options.remember?.({ x: point.x, y: point.y });
    options.notify?.({ x: point.x, y: point.y });
    if (i < points.length - 1) {
      await trajectorySleep(point.delayMs, options.signal);
    }
  }
  return dispatched;
}

/** Resolve the random default for `overshoot` (~12% chance). */
export function randomOvershoot(rng: () => number = Math.random): boolean {
  return rng() < DEFAULT_OVERSHOOT_PROBABILITY;
}

/**
 * Where a glide should start: the tab's last dispatched pointer
 * position, or the viewport centre when nothing is tracked yet.
 * Returns `null` when neither is available (metrics call failed).
 */
export async function glideStart(cdp: CdpRunner, tabId: number): Promise<Vec2 | null> {
  const last = cdp.lastMousePos?.(tabId);
  if (last) return last;
  try {
    const metrics = await cdp.send<{
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      layoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>(tabId, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (
      typeof width === "number" &&
      typeof height === "number" &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return { x: width / 2, y: height / 2 };
    }
  } catch {
    // Fall through to the null return.
  }
  return null;
}

export const trajectoryTesting = {
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  DELAY_NOISE,
  JITTER_PX,
  MIN_ANCHOR_SPREAD,
  MAX_ANCHOR_SPREAD,
  MIN_OVERSHOOT_FRACTION,
  MAX_OVERSHOOT_FRACTION,
};
