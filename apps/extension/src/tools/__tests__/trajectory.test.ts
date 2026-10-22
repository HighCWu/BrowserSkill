import { describe, expect, it, vi } from "vitest";
import type { CdpRunner } from "../shared";
import {
  adaptiveDurationMs,
  createSeededRng,
  cubicBezier,
  defaultSteps,
  dispatchTrajectory,
  distance,
  easeInOut,
  planTrajectory,
  randomOvershoot,
  type TrajectoryPoint,
  trajectorySleep,
  trajectoryTesting,
  type Vec2,
} from "../trajectory";

const { MAX_DELAY_MS, MIN_DELAY_MS } = trajectoryTesting;

/** Collect every mouseMoved dispatch for assertions. */
function recordingCdp(signal?: AbortSignal) {
  const moves: Array<{ x: number; y: number; type: string }> = [];
  const send = async <T>(_tabId: number, method: string, params?: object): Promise<T> => {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (method === "Input.dispatchMouseEvent") {
      const args = params as { type: string; x: number; y: number };
      if (args.type === "mouseMoved") moves.push({ ...args });
    }
    return {} as T;
  };
  const cdp: CdpRunner = { send };
  return { cdp, moves };
}

describe("trajectory planning", () => {
  const from: Vec2 = { x: 100, y: 100 };
  const to: Vec2 = { x: 500, y: 400 };

  it("produces the requested point count with a monotonic progress curve", () => {
    const points = planTrajectory({
      from,
      to,
      durationMs: 480,
      steps: 25,
      curve: "bezier",
      overshoot: false,
      jitter: false,
      rng: createSeededRng(42),
    });
    expect(points).toHaveLength(25);
    // Distance to destination shrinks (mostly) monotonically for the
    // eased traversal of a single arc.
    let regressions = 0;
    for (let i = 1; i < points.length; i++) {
      if (distance(points[i], to) > distance(points[i - 1], to) + 1e-6) regressions++;
    }
    // Ease-in-out + same-side arc keeps the approach monotonic.
    expect(regressions).toBe(0);
  });

  it("ends exactly on the destination (zero endpoint tolerance)", () => {
    for (const curve of ["bezier", "linear"] as const) {
      const points = planTrajectory({
        from,
        to,
        durationMs: 400,
        steps: 20,
        curve,
        overshoot: false,
        jitter: true,
        rng: createSeededRng(7),
      });
      const last = points[points.length - 1];
      expect(last.x).toBe(to.x);
      expect(last.y).toBe(to.y);
    }
  });

  it("keeps intermediate jitter within ±0.5 px of the ideal curve", () => {
    // Same rng stream, jitter on vs off: the only difference between the
    // two plans is the per-point noise, because jitter draws replace the
    // ideal position instead of adding a separately-seeded offset.
    // Verify the bound directly instead: recompute each ideal linear
    // point and compare.
    const points = planTrajectory({
      from,
      to,
      durationMs: 400,
      steps: 30,
      curve: "linear",
      overshoot: false,
      jitter: true,
      rng: createSeededRng(99),
    });
    for (let i = 0; i < points.length - 1; i++) {
      const t = i / (points.length - 1);
      const eased = easeInOut(t);
      const idealX = from.x + (to.x - from.x) * eased;
      const idealY = from.y + (to.y - from.y) * eased;
      expect(Math.abs(points[i].x - idealX)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(points[i].y - idealY)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("plans an overshoot segment that passes the target and corrects back", () => {
    const points = planTrajectory({
      from,
      to,
      durationMs: 600,
      steps: 30,
      curve: "bezier",
      overshoot: true,
      jitter: false,
      rng: createSeededRng(1234),
    });
    expect(points.length).toBeGreaterThan(30);
    const main = points.slice(0, 30);
    const correction = points.slice(30);
    expect(correction.length).toBeGreaterThanOrEqual(1);
    expect(correction.length).toBeLessThanOrEqual(3);
    // The main segment ends past the destination along the travel axis.
    const travel = { x: to.x - from.x, y: to.y - from.y };
    const projection = (p: Vec2) =>
      ((p.x - from.x) * travel.x + (p.y - from.y) * travel.y) / (travel.x ** 2 + travel.y ** 2);
    const overshootProjection = projection(main[main.length - 1]);
    expect(overshootProjection).toBeGreaterThan(1.019);
    expect(overshootProjection).toBeLessThanOrEqual(1.081);
    // Correction returns exactly to the destination.
    const last = correction[correction.length - 1];
    expect(last.x).toBe(to.x);
    expect(last.y).toBe(to.y);
    // No overshoot leaves exactly `steps` points ending at the target.
    const plain = planTrajectory({
      from,
      to,
      durationMs: 600,
      steps: 30,
      curve: "bezier",
      overshoot: false,
      jitter: false,
      rng: createSeededRng(1234),
    });
    expect(plain).toHaveLength(30);
    expect(plain[29]).toEqual({ x: to.x, y: to.y, delayMs: plain[29].delayMs });
  });

  it("keeps every per-point delay within bounds and the total near the request", () => {
    for (const durationMs of [350, 480, 950, 2_000]) {
      const points = planTrajectory({
        from,
        to,
        durationMs,
        steps: 40,
        curve: "bezier",
        overshoot: true,
        jitter: true,
        rng: createSeededRng(5),
      });
      let total = 0;
      for (const point of points) {
        expect(point.delayMs).toBeGreaterThanOrEqual(MIN_DELAY_MS);
        expect(point.delayMs).toBeLessThanOrEqual(MAX_DELAY_MS);
        total += point.delayMs;
      }
      const ratio = total / durationMs;
      expect(ratio).toBeGreaterThan(0.8);
      expect(ratio).toBeLessThan(1.2);
    }
  });

  it("collapses to a constant path when start equals destination", () => {
    const points = planTrajectory({
      from: to,
      to,
      durationMs: 360,
      steps: 12,
      curve: "bezier",
      overshoot: false,
      jitter: true,
      rng: createSeededRng(3),
    });
    expect(points).toHaveLength(12);
    expect(points[points.length - 1]).toEqual({ x: to.x, y: to.y, delayMs: points[11].delayMs });
  });

  it("disables jitter on the final correction point only", () => {
    const points = planTrajectory({
      from,
      to,
      durationMs: 700,
      steps: 20,
      curve: "bezier",
      overshoot: true,
      jitter: true,
      rng: createSeededRng(64),
    });
    const last = points[points.length - 1];
    expect(last.x).toBe(to.x);
    expect(last.y).toBe(to.y);
  });
});

describe("trajectory defaults", () => {
  it("adapts duration to distance within 350–950 ms", () => {
    expect(adaptiveDurationMs(0)).toBe(350);
    expect(adaptiveDurationMs(100)).toBe(400);
    expect(adaptiveDurationMs(10_000)).toBe(950);
    expect(adaptiveDurationMs(600)).toBe(650);
  });

  it("derives steps as duration/12 clamped to 12–80", () => {
    expect(defaultSteps(144)).toBe(12);
    expect(defaultSteps(480)).toBe(40);
    expect(defaultSteps(9_600)).toBe(80);
    expect(defaultSteps(50)).toBe(12);
  });

  it("eases progress with a slow-fast-slow envelope", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.25)).toBeCloseTo(0.0625, 6);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOut(0.75)).toBeCloseTo(0.9375, 6);
    // Midpoint speed exceeds endpoint speed on the unit interval.
    const midSpeed = easeInOut(0.51) - easeInOut(0.49);
    const endSpeed = easeInOut(0.02) - easeInOut(0);
    expect(midSpeed).toBeGreaterThan(endSpeed);
  });

  it("evaluates the cubic Bézier at its anchors", () => {
    const p0: Vec2 = { x: 0, y: 0 };
    const p3: Vec2 = { x: 10, y: 0 };
    const p1: Vec2 = { x: 3, y: 1 };
    const p2: Vec2 = { x: 7, y: 1 };
    expect(cubicBezier(p0, p1, p2, p3, 0)).toEqual(p0);
    expect(cubicBezier(p0, p1, p2, p3, 1)).toEqual(p3);
    const mid = cubicBezier(p0, p1, p2, p3, 0.5);
    expect(mid.x).toBeCloseTo(5, 6);
    // y(0.5) = 3·(0.5)²·0.5·(1 + 1) = 0.75 for these anchors.
    expect(mid.y).toBeCloseTo(0.75, 6);
  });

  it("resolves the default overshoot decision from the injected rng", () => {
    expect(randomOvershoot(() => 0.05)).toBe(true);
    expect(randomOvershoot(() => 0.5)).toBe(false);
    expect(randomOvershoot(() => 0.119999)).toBe(true);
  });
});

describe("trajectory dispatch", () => {
  it("dispatches every point in order and honours delays", async () => {
    vi.useFakeTimers();
    try {
      const { cdp, moves } = recordingCdp();
      const points: TrajectoryPoint[] = [
        { x: 1, y: 2, delayMs: 10 },
        { x: 3, y: 4, delayMs: 12 },
        { x: 5, y: 6, delayMs: 8 },
      ];
      const start = Date.now();
      const done = dispatchTrajectory(cdp, 4, points, { modifiers: 0 });
      // Two sleeps (after point 1 and 2); the final delay is skipped.
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(12);
      const dispatched = await done;
      expect(dispatched).toBe(3);
      expect(moves.map((m) => ({ x: m.x, y: m.y }))).toEqual([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(20);
      expect(elapsed).toBeLessThan(20 + 15);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies the position tracker after each dispatch", async () => {
    const { cdp } = recordingCdp();
    const seen: Vec2[] = [];
    await dispatchTrajectory(
      cdp,
      4,
      [
        { x: 10, y: 20, delayMs: 1 },
        { x: 30, y: 40, delayMs: 1 },
      ],
      { remember: (p) => seen.push({ ...p }) },
    );
    expect(seen).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it("refuses to dispatch at all when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const { cdp, moves } = recordingCdp(abort.signal);
    await expect(
      dispatchTrajectory(
        cdp,
        4,
        [
          { x: 1, y: 1, delayMs: 5 },
          { x: 2, y: 2, delayMs: 5 },
        ],
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(moves).toHaveLength(0);
  });

  it("aborts during an inter-point sleep without dispatching further points", async () => {
    const abort = new AbortController();
    const { cdp, moves } = recordingCdp(abort.signal);
    const done = dispatchTrajectory(
      cdp,
      4,
      [
        { x: 1, y: 1, delayMs: 5 },
        { x: 2, y: 2, delayMs: 5 },
      ],
      { signal: abort.signal },
    );
    await vi.waitFor(() => expect(moves).toHaveLength(1));
    abort.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(moves).toHaveLength(1);
  });

  it("sleeps for the requested real duration", async () => {
    const start = Date.now();
    await trajectorySleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});
