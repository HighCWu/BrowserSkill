// Built-in exam for the v2 behaviour planner.
//
// The detector-side statistics (trajectory-metrics.ts) are turned back
// onto our own traces: a seeded batch of short/medium/long moves has to
// land inside the human envelopes reported by the kitsune Balabit
// analysis (power-law exponent, pause ratio, submovement count) and pass
// the motion-attestation channels (pre-click deceleration, non-constant
// acceleration, no tremble on locked windows). Constant-speed synthetic
// traces are graded alongside to prove the metrics can tell the
// difference.
//
// On the power-law exponent: the Balabit envelope is a population
// statistic (quantiles over 18k human aiming segments), while a single
// trace's OLS slope over a few dozen samples is a noisy estimate. The
// exam therefore holds the per-course *median* inside the human band,
// requires a strong majority of individual traces inside it, and rejects
// outright pathologies (strongly negative slopes — the signature of the
// inverted slowdown weighting this planner once had).

import { describe, expect, it } from "vitest";
import { createSeededRng, type TrajectoryPoint, type Vec2 } from "../trajectory";
import { planBehaviorTrajectory } from "../trajectory-behavior";
import {
  accelerationVariance,
  computeTraceMetrics,
  countSubmovements,
  curvatureRadii,
  endDecelerationRatio,
  endsExactlyAt,
  fitPowerLawExponent,
  lockWindowStats,
  pauseRatio,
  plannedDurationMs,
} from "../trajectory-metrics";

/** Uniform-step straight line: the "obvious script" baseline. */
function constantSpeedLine(from: Vec2, to: Vec2, steps: number): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    points.push({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      delayMs: 16,
    });
  }
  return points;
}

describe("trajectory metrics sanity", () => {
  it("scores a constant-speed line with beta near zero and no submovement structure", () => {
    const points = constantSpeedLine({ x: 100, y: 100 }, { x: 600, y: 400 }, 60);
    const metrics = computeTraceMetrics(points);
    expect(Math.abs(metrics.beta)).toBeLessThan(0.1);
    expect(metrics.submovementCount).toBeLessThanOrEqual(1);
    expect(metrics.accelerationVariance).toBeLessThan(1e-9);
    expect(metrics.pauseRatio).toBe(0);
  });

  it("reads the pause ratio off a hand-built trace with a stall", () => {
    const moving = Array.from({ length: 20 }, (_, i) => ({
      x: 100 + i * 10,
      y: 100,
      delayMs: 16,
    }));
    const stalled = Array.from({ length: 10 }, () => ({ x: 290, y: 100, delayMs: 60 }));
    const tail = Array.from({ length: 10 }, (_, i) => ({
      x: 290 + i * 10,
      y: 100,
      delayMs: 16,
    }));
    const ratio = pauseRatio([...moving, ...stalled, ...tail]);
    // 10 of 39 moving samples are stalled.
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.3);
  });

  it("sees the difference between braking into a target and driving in", () => {
    const braking: TrajectoryPoint[] = [];
    for (let i = 0; i < 30; i++) {
      const t = i / 29;
      const eased = 1 - (1 - t) ** 3;
      braking.push({ x: 800 * eased, y: 0, delayMs: 16 });
    }
    braking.push({ x: 800, y: 0, delayMs: 16 });
    const slowTail: TrajectoryPoint[] = [];
    for (let i = 0; i < 12; i++) {
      slowTail.push({ x: 800 + (i + 1) * 0.4, y: 0, delayMs: 60 });
    }
    const driven = constantSpeedLine({ x: 0, y: 0 }, { x: 800, y: 0 }, 40);
    expect(endDecelerationRatio([...braking, ...slowTail])).toBeLessThan(0.25);
    expect(endDecelerationRatio(driven)).toBeGreaterThan(0.9);
  });

  it("treats straight stretches as infinitely flat curvature", () => {
    const points = constantSpeedLine({ x: 0, y: 0 }, { x: 300, y: 0 }, 30);
    for (const radius of curvatureRadii(points)) {
      if (radius !== null) expect(radius).toBe(5_000);
    }
  });

  it("returns zeroed statistics for traces too short to grade", () => {
    const points: TrajectoryPoint[] = [
      { x: 1, y: 1, delayMs: 8 },
      { x: 2, y: 1, delayMs: 8 },
    ];
    expect(fitPowerLawExponent(points)).toBe(0);
    expect(countSubmovements(points)).toBe(0);
    expect(accelerationVariance(points)).toBe(0);
    expect(endsExactlyAt(points, { x: 2, y: 1 })).toBe(true);
    expect(plannedDurationMs(points)).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// The graded batch
// ---------------------------------------------------------------------------

const SEEDS = [11, 23, 37, 52, 68, 74, 89, 95, 101, 117];
const COURSES = [
  { name: "short", from: { x: 100, y: 300 }, to: { x: 190, y: 300 } },
  { name: "medium", from: { x: 80, y: 600 }, to: { x: 300, y: 380 } },
  { name: "long", from: { x: 40, y: 680 }, to: { x: 760, y: 80 } },
] as const;
/** Human band for the speed/curvature slope (kitsune Balabit quantiles). */
const BETA_HUMAN_MIN = 0.1;
const BETA_HUMAN_MAX = 0.6;
/** Estimator tolerance for individual traces (the median is held harder). */
const BETA_TRACE_GUARD_MIN = -0.3;
const BETA_TRACE_GUARD_MAX = 0.7;
/** Share of a batch that must sit inside the human band. */
const BETA_PASS_RATE = 0.75;

interface Graded {
  points: TrajectoryPoint[];
  segments: Awaited<ReturnType<typeof planBehaviorTrajectory>>["segments"];
  landed: Vec2;
  target: Vec2;
  dwell: boolean;
  beta: number;
  submovements: number;
  course: string;
}

async function gradeBatch(dwell: boolean): Promise<Graded[]> {
  const graded: Graded[] = [];
  for (const course of COURSES) {
    for (const seed of SEEDS) {
      const plan = await planBehaviorTrajectory({
        from: course.from,
        to: course.to,
        dwell,
        targetBox: dwell
          ? { x: course.to.x - 50, y: course.to.y - 30, width: 100, height: 60 }
          : null,
        overshoot: false,
        rng: createSeededRng(seed),
      });
      const metrics = computeTraceMetrics(plan.points);
      graded.push({
        points: plan.points,
        segments: plan.segments,
        landed: plan.landed,
        target: course.to,
        dwell,
        beta: metrics.beta,
        submovements: metrics.submovementCount,
        course: course.name,
      });
    }
  }
  return graded;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("v2 behaviour exam", () => {
  it("holds the power-law exponent inside the Balabit human envelope", async () => {
    for (const dwell of [false, true]) {
      const graded = await gradeBatch(dwell);
      for (const trace of graded) {
        // Pathology guard: a strongly negative slope means the slowdown
        // weighting is fighting the profile (a real bug, seen before).
        expect(trace.beta).toBeGreaterThan(BETA_TRACE_GUARD_MIN);
        expect(trace.beta).toBeLessThan(BETA_TRACE_GUARD_MAX);
      }
      const passRate =
        graded.filter((trace) => trace.beta >= BETA_HUMAN_MIN && trace.beta <= BETA_HUMAN_MAX)
          .length / graded.length;
      expect(passRate).toBeGreaterThanOrEqual(BETA_PASS_RATE);
      for (const course of COURSES) {
        const courseMedian = median(
          graded.filter((trace) => trace.course === course.name).map((trace) => trace.beta),
        );
        expect(courseMedian).toBeGreaterThanOrEqual(BETA_HUMAN_MIN);
        expect(courseMedian).toBeLessThanOrEqual(BETA_HUMAN_MAX);
      }
    }
  });

  it("always shows submovement structure, ~2-4 peaks median on long hauls", async () => {
    const graded = await gradeBatch(false);
    for (const trace of graded) {
      expect(trace.submovements).toBeGreaterThanOrEqual(1);
    }
    const long = graded.filter((trace) => trace.course === "long");
    const counts = long.map((trace) => trace.submovements);
    expect(median(counts)).toBeGreaterThanOrEqual(2);
    expect(median(counts)).toBeLessThanOrEqual(4);
  });

  it("brakes into click landings (pre-click deceleration channel)", async () => {
    const graded = await gradeBatch(true);
    for (const trace of graded) {
      const ratio = endDecelerationRatio(trace.points);
      expect(ratio).toBeLessThanOrEqual(0.25);
    }
  });

  it("has non-constant acceleration on every trace (anti single-easing signature)", async () => {
    for (const dwell of [false, true]) {
      const graded = await gradeBatch(dwell);
      for (const trace of graded) {
        expect(accelerationVariance(trace.points)).toBeGreaterThan(1e-6);
      }
    }
  });

  it("ends every trace exactly on its landing (zero endpoint tolerance)", async () => {
    for (const dwell of [false, true]) {
      const graded = await gradeBatch(dwell);
      for (const trace of graded) {
        expect(endsExactlyAt(trace.points, trace.landed)).toBe(true);
      }
    }
  });

  it("keeps locked windows slow and free of high-frequency tremor", async () => {
    let checkedWindows = 0;
    for (const dwell of [false, true]) {
      const graded = await gradeBatch(dwell);
      for (const trace of graded) {
        for (const segment of trace.segments) {
          if (segment.kind !== "hesitate" && segment.kind !== "hover") continue;
          const stats = lockWindowStats(trace.points, segment.start, segment.end);
          checkedWindows++;
          expect(stats.meanSpeed).toBeLessThan(0.05);
          expect(stats.maxStep).toBeLessThanOrEqual(4);
          expect(stats.driftVariance).toBeLessThanOrEqual(12);
        }
        if (dwell) {
          for (const segment of trace.segments) {
            if (segment.kind !== "dwell") continue;
            // The brake tail itself must read as a slow approach.
            const tail = lockWindowStats(
              trace.points,
              Math.max(segment.end - 5, segment.start),
              segment.end,
            );
            expect(tail.maxStep).toBeLessThanOrEqual(4);
          }
        }
      }
    }
    // Hesitation is probabilistic; force it on a dedicated sub-batch so
    // the lock-window properties are always exercised deterministically.
    for (const course of COURSES) {
      const plan = await planBehaviorTrajectory({
        from: course.from,
        to: course.to,
        overshoot: false,
        testing: { forceHesitate: true },
        rng: createSeededRng(202),
      });
      const hesitate = plan.segments.find((segment) => segment.kind === "hesitate");
      expect(hesitate).toBeDefined();
      const stats = lockWindowStats(plan.points, hesitate!.start, hesitate!.end);
      checkedWindows++;
      expect(stats.meanSpeed).toBeLessThan(0.05);
      expect(stats.maxStep).toBeLessThanOrEqual(4);
      expect(stats.driftVariance).toBeLessThanOrEqual(12);
      // Micro-move pacing stays inside the 40–130 ms research band.
      for (let i = hesitate!.start; i <= hesitate!.end; i++) {
        expect(plan.points[i].delayMs).toBeGreaterThanOrEqual(40);
        expect(plan.points[i].delayMs).toBeLessThanOrEqual(130);
      }
    }
    expect(checkedWindows).toBeGreaterThan(0);
  });
});
