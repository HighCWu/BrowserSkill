// Unit tests for the v2 behaviour state machine planner: state layout,
// budget rules, stochastic branch caps, landing scatter and the option
// surface that keeps v1 behaviour reachable.

import { describe, expect, it } from "vitest";
import { createSeededRng, distance, type Vec2 } from "../trajectory";
import {
  type BehaviorProbeHit,
  easeOutCubic,
  fittsDurationMs,
  minJerk,
  planBehaviorTrajectory,
} from "../trajectory-behavior";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("profile and timing primitives", () => {
  it("keeps the minimum-jerk and easeOut profiles in bounds", () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBe(0.5);
    // Symmetric slow-fast-slow: quarter points match.
    expect(minJerk(0.25)).toBeCloseTo(1 - minJerk(0.75), 9);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    // Fast departure: a quarter of the time already covers most of the way.
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.55);
  });

  it("draws Fitts durations inside the research clamp", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = createSeededRng(seed * 7);
      const value = fittsDurationMs(600, 24, rng);
      expect(value).toBeGreaterThanOrEqual(40);
      expect(value).toBeLessThanOrEqual(1400);
    }
    // Longer distances take longer in the median.
    const short = median(
      Array.from({ length: 30 }, (_, i) => fittsDurationMs(60, 24, createSeededRng(i + 1))),
    );
    const long = median(
      Array.from({ length: 30 }, (_, i) => fittsDurationMs(900, 24, createSeededRng(i + 1))),
    );
    expect(long).toBeGreaterThan(short);
  });
});

describe("plan structure", () => {
  const from: Vec2 = { x: 120, y: 200 };
  const to: Vec2 = { x: 520, y: 460 };

  it("collapses a same-point move to a tiny stationary trace", async () => {
    const plan = await planBehaviorTrajectory({
      from: to,
      to,
      rng: createSeededRng(5),
    });
    expect(plan.points.length).toBeGreaterThanOrEqual(2);
    for (const point of plan.points) {
      expect(point.x).toBe(to.x);
      expect(point.y).toBe(to.y);
    }
    const dwelled = await planBehaviorTrajectory({
      from: to,
      to,
      dwell: true,
      rng: createSeededRng(5),
    });
    expect(dwelled.segments.some((segment) => segment.kind === "dwell")).toBe(true);
  });

  it("ends exactly on the landing for every seeded plan", async () => {
    for (let seed = 1; seed <= 24; seed++) {
      const rng = createSeededRng(seed * 13);
      const plan = await planBehaviorTrajectory({ from, to, rng });
      const last = plan.points[plan.points.length - 1];
      expect(last.x).toBe(plan.landed.x);
      expect(last.y).toBe(plan.landed.y);
      expect(plan.landed.x).toBe(to.x);
      expect(plan.landed.y).toBe(to.y);
    }
  });

  it("splits an explicit duration override across the whole trace", async () => {
    for (const durationMs of [200, 600, 1200]) {
      const plan = await planBehaviorTrajectory({
        from,
        to,
        durationMs,
        overshoot: false,
        rng: createSeededRng(9),
      });
      const ratio = plan.plannedDurationMs / durationMs;
      expect(ratio).toBeGreaterThan(0.55);
      expect(ratio).toBeLessThan(1.6);
    }
  });

  it("keeps overshoot off the target unless asked", async () => {
    const travel = { x: to.x - from.x, y: to.y - from.y };
    const total = distance(from, to);
    const projection = (p: Vec2) =>
      ((p.x - from.x) * travel.x + (p.y - from.y) * travel.y) / (travel.x ** 2 + travel.y ** 2);
    // Intermediate points carry a few px of noise and micro-correction;
    // only the final point is held exact. Planned overshoot means going
    // meaningfully past (≥5 px), so allow a small noise margin.
    const noiseMargin = 8 / total;
    for (let seed = 1; seed <= 10; seed++) {
      const off = await planBehaviorTrajectory({
        from,
        to,
        overshoot: false,
        rng: createSeededRng(seed),
      });
      const furthest = Math.max(...off.points.map(projection));
      expect(furthest).toBeLessThanOrEqual(1 + noiseMargin);

      const on = await planBehaviorTrajectory({
        from,
        to,
        overshoot: true,
        rng: createSeededRng(seed),
      });
      expect(on.overshoot).toBe(true);
      // Passes the target by 6–24 px along the travel axis (531 px total).
      const past = Math.max(...on.points.map(projection));
      expect(past).toBeGreaterThan(1 + 5 / total);
      expect(past).toBeLessThanOrEqual(1 + 24.5 / total);
      // And corrects back to land exactly on target.
      const last = on.points[on.points.length - 1];
      expect(last.x).toBe(to.x);
      expect(last.y).toBe(to.y);
    }
  });

  it("runs fast scans quicker than careful reads in median", async () => {
    const durations = async (persona: "fast" | "careful") => {
      const values: number[] = [];
      for (let seed = 1; seed <= 16; seed++) {
        const plan = await planBehaviorTrajectory({
          from,
          to,
          persona,
          overshoot: false,
          rng: createSeededRng(seed * 31),
        });
        values.push(plan.plannedDurationMs);
      }
      return median(values);
    };
    expect(await durations("fast")).toBeLessThan(await durations("careful"));
  });

  it("caps mid-flight insertions and rethinks even when everything triggers", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const plan = await planBehaviorTrajectory({
        from,
        to,
        overshoot: false,
        testing: { forceHesitate: true, forceRethink: true, forceHoverTrigger: true },
        rng: createSeededRng(seed * 3),
      });
      const kinds = plan.segments.map((segment) => segment.kind);
      const rethinkCount = kinds.filter((kind) => kind === "rethink").length;
      expect(rethinkCount).toBeLessThanOrEqual(1);
      const midFlight = kinds.filter(
        (kind) => kind === "hesitate" || kind === "hover" || kind === "rethink",
      ).length;
      expect(midFlight).toBeLessThanOrEqual(3);
    }
  });

  it("probes at most three path points and stops at the first hit", async () => {
    let calls = 0;
    const probed: Vec2[] = [];
    const probe = async (x: number, y: number): Promise<BehaviorProbeHit | null> => {
      calls++;
      // Only the later part of the path crosses an interactive element:
      // an 80 px square centred on the sampled point.
      if (x < 300) return null;
      probed.push({ x, y });
      return { box: { x: x - 40, y: y - 40, width: 80, height: 80 }, tooltipish: false };
    };
    const plan = await planBehaviorTrajectory({
      from,
      to,
      overshoot: false,
      // Room for the approach plus a full inspection stay.
      durationMs: 2200,
      probe,
      testing: { forceHoverTrigger: true },
      rng: createSeededRng(17),
    });
    expect(calls).toBeLessThanOrEqual(3);
    const hover = plan.segments.find((segment) => segment.kind === "hover");
    expect(hover).toBeDefined();
    // The stop happens where the cursor crossed the element: within the
    // probed box of one of the sampled points.
    const anchor = probed.find((sample) => {
      const point = plan.points[hover!.start];
      return distance(sample, point) <= 45;
    });
    expect(anchor).toBeDefined();
    for (let i = hover!.start; i <= hover!.end; i++) {
      expect(distance(plan.points[i], anchor!)).toBeLessThanOrEqual(60);
    }
    // Inspection pacing lands in the research band (300–1500 ms plus a
    // possible tooltip extension), and the stay is genuinely slow.
    const stay = plan.points
      .slice(hover!.start, hover!.end + 1)
      .reduce((sum, point) => sum + point.delayMs, 0);
    expect(stay).toBeGreaterThanOrEqual(250);
    expect(stay).toBeLessThanOrEqual(3100);
  });

  it("survives a throwing probe and plans a normal move", async () => {
    const plan = await planBehaviorTrajectory({
      from,
      to,
      probe: async () => {
        throw new Error("page went away");
      },
      rng: createSeededRng(21),
    });
    const last = plan.points[plan.points.length - 1];
    expect(last.x).toBe(to.x);
    expect(last.y).toBe(to.y);
  });

  it("freezes all positional noise when jitter is off", async () => {
    const plan = await planBehaviorTrajectory({
      from,
      to,
      overshoot: false,
      jitter: false,
      testing: { forceHesitate: true },
      rng: createSeededRng(4),
    });
    const hesitate = plan.segments.find((segment) => segment.kind === "hesitate");
    expect(hesitate).toBeDefined();
    for (let i = hesitate!.start; i < hesitate!.end; i++) {
      const a = plan.points[i];
      const b = plan.points[i + 1];
      expect(a.x).toBe(b.x);
      expect(a.y).toBe(b.y);
    }
  });
});

describe("pre-click landing scatter", () => {
  const from: Vec2 = { x: 100, y: 100 };
  const to: Vec2 = { x: 300, y: 220 };

  it("scatters the landing off the centre inside a roomy box", async () => {
    const box = { x: 200, y: 150, width: 220, height: 160 };
    for (let seed = 1; seed <= 12; seed++) {
      const plan = await planBehaviorTrajectory({
        from,
        to,
        dwell: true,
        targetBox: box,
        rng: createSeededRng(seed * 5),
      });
      const offset = distance(plan.landed, to);
      expect(offset).toBeGreaterThanOrEqual(5.5);
      expect(offset).toBeLessThanOrEqual(12.5);
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(distance(plan.landed, centre)).toBeGreaterThanOrEqual(5.5);
      expect(plan.landed.x).toBeGreaterThan(box.x + 4);
      expect(plan.landed.x).toBeLessThan(box.x + box.width - 4);
      expect(plan.landed.y).toBeGreaterThan(box.y + 4);
      expect(plan.landed.y).toBeLessThan(box.y + box.height - 4);
      const last = plan.points[plan.points.length - 1];
      expect(last.x).toBe(plan.landed.x);
      expect(last.y).toBe(plan.landed.y);
    }
  });

  it("keeps the exact landing for small boxes and hover moves", async () => {
    const smallBox = { x: to.x - 10, y: to.y - 10, width: 20, height: 20 };
    const cramped = await planBehaviorTrajectory({
      from,
      to,
      dwell: true,
      targetBox: smallBox,
      rng: createSeededRng(2),
    });
    expect(cramped.landed.x).toBe(to.x);
    expect(cramped.landed.y).toBe(to.y);

    const hover = await planBehaviorTrajectory({
      from,
      to,
      dwell: false,
      targetBox: { x: 200, y: 150, width: 220, height: 160 },
      rng: createSeededRng(3),
    });
    expect(hover.landed.x).toBe(to.x);
    expect(hover.landed.y).toBe(to.y);
  });
});
