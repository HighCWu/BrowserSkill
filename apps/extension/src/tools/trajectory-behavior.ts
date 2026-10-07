// v2 pointer behaviour state machine.
//
// Where the v1 planner (trajectory.ts) draws one eased arc, a real hand
// moves in intents: a main pulse that covers most of the distance, then
// hesitation, en-route inspection of things the cursor passes, small
// corrective pulses, the occasional rethink — and, before a click, a
// brake into the landing. This module composes those phases into a
// single dispatchable trace.
//
// State machine (per move):
//
//   PLAN → MOVE_MAIN (main pulse, 85–95% of the distance, min-jerk
//          profile with high-curvature slowdown inside the segment)
//     → { HESITATE | HOVER_INSPECT | CORRECT_1..k | RETHINK } (cascade ≤ 3)
//     → ARRIVE → DWELL_BEFORE_CLICK (click glides only)
//
// Model sources are catalogued in the workspace research notes: Fitts
// timing (Shannon form, practical constants), the submovement hypothesis
// (main pulse + stochastic corrective pulses), the 2/3 power law as a
// curvature slowdown weight, and a pre-click deceleration channel with
// centre-avoiding landing scatter. Probabilities sit in a controlled
// range on purpose: over-randomised motion is easier to flag than
// slightly-too-regular motion, so every knob here is biased towards
// "mostly ordinary".

import {
  clamp,
  createSeededRng,
  cubicBezier,
  distance,
  type TrajectoryPoint,
  type Vec2,
} from "./trajectory";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Behaviour intensity presets; "auto" picks one per move, weighted. */
export type BehaviorPersona = "auto" | "fast" | "careful";

/** Axis-aligned element box in CSS pixels. */
export interface BehaviorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the page probe reports for a sampled path point. */
export interface BehaviorProbeHit {
  box: BehaviorBox;
  /** The element advertises a tooltip (title/aria description family). */
  tooltipish: boolean;
}

/**
 * Async page-world probe: "what sits under this path point?". Returns
 * null when nothing interactive is there. Implementation lives in
 * page-probe.ts; tests inject stubs.
 */
export type BehaviorProbe = (x: number, y: number) => Promise<BehaviorProbeHit | null>;

/** One planned phase, recorded as a point-index range for introspection. */
export interface BehaviorSegmentInfo {
  kind: "main" | "hesitate" | "hover" | "correct" | "rethink" | "dwell";
  /** Index of the first point in the segment. */
  start: number;
  /** Index of the last point in the segment (inclusive). */
  end: number;
}

export interface BehaviorPlan {
  points: TrajectoryPoint[];
  /** Final pointer position (may scatter inside the box before a click). */
  landed: Vec2;
  segments: BehaviorSegmentInfo[];
  /** Sum of planned per-point sleeps, ms. */
  plannedDurationMs: number;
  persona: "fast" | "careful";
  /** Whether the plan includes an overshoot past the target. */
  overshoot: boolean;
}

export interface PlanBehaviorOptions {
  from: Vec2;
  to: Vec2;
  /** Destination element box when known (Fitts width, landing scatter). */
  targetBox?: BehaviorBox | null;
  /** Page probe enabling en-route hover inspection. */
  probe?: BehaviorProbe | null;
  /** Click approach: brake into the landing and settle before the press. */
  dwell?: boolean;
  /** Force overshoot on/off; default decides stochastically. */
  overshoot?: boolean;
  /** Disable all positional noise for a deterministic geometry. */
  jitter?: boolean;
  persona?: BehaviorPersona;
  /**
   * Hard duration override (ms); replaces the Fitts draw and is split
   * proportionally across phases.
   */
  durationMs?: number;
  /** Injected random source; defaults to `Math.random`. */
  rng?: () => number;
  /** Test hooks: force stochastic branches without rigging the RNG. */
  testing?: {
    forceHesitate?: boolean;
    forceHoverTrigger?: boolean;
    forceRethink?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Model constants (research-derived; see module comment)
// ---------------------------------------------------------------------------

/** Nominal pointer sample interval; move-point delays cluster around it. */
const FRAME_INTERVAL_MS = 12.5;
/** Per-point delay bounds for movement legs, ms. */
const MIN_LEG_DELAY_MS = 4;
const MAX_LEG_DELAY_MS = 36;
/** Chance a frame behaves "merged" and takes twice as long. */
const MERGED_FRAME_PROBABILITY = 0.06;
/** Fitts lognormal spread (σ of the multiplier's log). */
const FITTS_LOGNORMAL_SIGMA = 0.22;
/** Fitts duration clamp, ms. */
const FITTS_MIN_MS = 40;
const FITTS_MAX_MS = 1400;
/** Default target width for bare coordinates, px. */
const DEFAULT_TARGET_WIDTH_PX = 24;
/** Main pulse coverage of the travel distance. */
const MAIN_PULSE_MIN_FRACTION = 0.85;
const MAIN_PULSE_MAX_FRACTION = 0.95;
/** Overshoot: distance and width gates, probability, and range (px). */
const OVERSHOOT_MIN_DISTANCE_PX = 120;
const OVERSHOOT_MIN_WIDTH_PX = 12;
const OVERSHOOT_PROBABILITY = 0.2;
const OVERSHOOT_MIN_PX = 6;
const OVERSHOOT_MAX_PX = 24;
/** Hesitation: distance gate, probability, position range, micro-move shape. */
const HESITATE_MIN_DISTANCE_PX = 80;
const HESITATE_PROBABILITY = 0.12;
const HESITATE_FRACTION_MIN = 0.35;
const HESITATE_FRACTION_MAX = 0.65;
const HESITATE_POINTS_MIN = 3;
const HESITATE_POINTS_MAX = 6;
const HESITATE_STEP_MS_MIN = 40;
const HESITATE_STEP_MS_MAX = 130;
const HESITATE_DRIFT_SIGMA_PX = 2;
/** En-route inspection: trigger probability band and box padding band (px). */
const HOVER_PROBE_FRACTIONS = [0.3, 0.52, 0.76];
const HOVER_TRIGGER_PROBABILITY = 0.25;
const HOVER_TRIGGER_PROBABILITY_MIN = 0.15;
const HOVER_TRIGGER_PROBABILITY_MAX = 0.4;
const HOVER_BOX_PAD_MIN_PX = 8;
const HOVER_BOX_PAD_MAX_PX = 16;
const HOVER_STAY_MS_MEDIAN = 500;
const HOVER_STAY_MS_SIGMA = 0.5;
const HOVER_STAY_MS_MIN = 300;
const HOVER_STAY_MS_MAX = 1500;
const HOVER_TOOLTIP_EXTENSION_MIN_MS = 500;
const HOVER_TOOLTIP_EXTENSION_MAX_MS = 1500;
/** Rethink (u-turn): probability band, turn window, retreat shape. */
const RETHINK_PROBABILITY_MIN = 0.03;
const RETHINK_PROBABILITY_MAX = 0.05;
const RETHINK_MIN_DISTANCE_PX = 160;
const RETHINK_FRACTION_MIN = 0.45;
const RETHINK_FRACTION_MAX = 0.7;
/** Corrective pulses: duration lognormal and clamp, per-pulse travel share. */
const CORRECT_DURATION_MS_MEDIAN = 90;
const CORRECT_DURATION_MS_SIGMA = 0.25;
const CORRECT_DURATION_MS_MIN = 60;
const CORRECT_DURATION_MS_MAX = 220;
const CORRECT_TRAVEL_MIN_SHARE = 0.55;
const CORRECT_TRAVEL_MAX_SHARE = 0.85;
const CORRECT_MAX_PULSES = 3;
/** Pre-click dwell: brake budget share and settle time, ms. */
const DWELL_BRAKE_SHARE_MIN = 0.55;
const DWELL_BRAKE_SHARE_MAX = 0.75;
const DWELL_BRAKE_MS_MIN = 360;
const DWELL_BRAKE_MS_MAX = 780;
/** Extended ceiling when the brake must cover the detector window. */
const DWELL_BRAKE_MS_MAX_EXTENDED = 1100;
const DWELL_SETTLE_MS_MEDIAN = 55;
/** The main pulse never gets shorter than this, ms. */
const MAIN_PULSE_MIN_MS = 150;
/** Landing scatter: box size gate, centre-avoidance radius, offset band. */
const SCATTER_MIN_BOX_DIMENSION_PX = 28;
const SCATTER_CENTRE_RADIUS_PX = 6;
const SCATTER_OFFSET_MIN_PX = 6;
const SCATTER_OFFSET_MAX_PX = 12;
/** Element interior sampling margins for en-route inspection stops. */
const HOVER_STOP_EDGE_MARGIN_PX = 5;
const HOVER_STOP_CENTRE_AVOID_PX = 4;
/** Cascade cap on mid-flight phase insertions. */
const MAX_MIDFLIGHT_INSERTS = 3;
/** Below this the planner emits a degenerate two-point trace. */
const MIN_MEANINGFUL_DISTANCE_PX = 0.5;

/** Weight of the curvature slowdown inside main pulses (band, drawn per leg). */
const CURVATURE_WEIGHT_MIN = 1.6;
const CURVATURE_WEIGHT_MAX = 3.2;
/** Control-anchor spread as a fraction of leg length (v2 arcs bow deeper). */
const ANCHOR_SPREAD_MIN = 0.16;
const ANCHOR_SPREAD_MAX = 0.3;
/** Chance the two anchors sit on opposite sides (gentle S-shaped arc). */
const S_CURVE_PROBABILITY = 0.45;

/** Persona time multipliers (fast scan vs careful read). */
const PERSONA_SCALE: Record<"fast" | "careful", { time: number; hesitate: number; hover: number }> =
  {
    fast: { time: 0.82, hesitate: 0.6, hover: 0.7 },
    careful: { time: 1.12, hesitate: 1.3, hover: 1.25 },
  };
/** Auto persona mix: mostly careful reading, occasionally a fast scan. */
const PERSONA_AUTO_FAST_WEIGHT = 0.42;

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

/** Standard normal via Box–Muller. */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** lognormal(µ, σ): exp(µ + σ·N(0,1)). */
export function lognormal(rng: () => number, mu: number, sigma: number): number {
  return Math.exp(mu + sigma * gaussian(rng));
}

export function uniform(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Poisson(λ) for small λ (Knuth). */
function poisson(rng: () => number, lambda: number): number {
  const limit = Math.exp(-lambda);
  let count = 0;
  let product = rng();
  while (product > limit) {
    count++;
    product *= rng();
  }
  return count;
}

// ---------------------------------------------------------------------------
// Timing model
// ---------------------------------------------------------------------------

/**
 * Fitts law (Shannon form) with practical constants, lognormally
 * jittered: `MT = (80 + 90·log2(D/W + 1)) × lognormal(1, 0.22)`.
 */
export function fittsDurationMs(d: number, w: number, rng: () => number): number {
  const width = Math.max(w, 1);
  const id = Math.log2(d / width + 1);
  return clamp(
    (80 + 90 * id) * lognormal(rng, 0, FITTS_LOGNORMAL_SIGMA),
    FITTS_MIN_MS,
    FITTS_MAX_MS,
  );
}

/**
 * Upward strokes run slightly quicker than downward ones (hand
 * biomechanics show direction-asymmetric acceleration distributions).
 * Mostly-vertical moves get a small duration nudge plus a noise
 * asymmetry; horizontal moves are untouched.
 */
function verticalAsymmetry(
  from: Vec2,
  to: Vec2,
  rng: () => number,
): { timeScale: number; noiseScale: number } {
  const dy = to.y - from.y;
  const dx = to.x - from.x;
  if (Math.abs(dy) <= Math.abs(dx) * 1.2 || Math.abs(dy) < 1) {
    return { timeScale: 1, noiseScale: 1 };
  }
  return dy < 0
    ? { timeScale: uniform(rng, 0.93, 0.97), noiseScale: 0.9 }
    : { timeScale: uniform(rng, 1.0, 1.04), noiseScale: 1.15 };
}

// ---------------------------------------------------------------------------
// Leg planning (one continuous movement segment)
// ---------------------------------------------------------------------------

/** Minimum-jerk position profile on [0,1]: 10t³ − 15t⁴ + 6t⁵. */
export function minJerk(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (10 - 15 * x + 6 * x * x);
}

/** Corrective easeOut on [0,1]: fast departure, decelerating landing. */
export function easeOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - (1 - x) ** 3;
}

/** Derivative of the minimum-jerk profile (peak at t = 0.5). */
function minJerkDerivative(t: number): number {
  const x = clamp(t, 0, 1);
  return 30 * x * x * (1 - x) * (1 - x);
}

/**
 * Curvature of a cubic Bézier at parameter u: κ = |d1×d2| / |d1|³
 * (units 1/px — the reciprocal of the turning radius). Used as a
 * slowdown signal, so the absolute scale is normalised away by the
 * caller; the cap only guards against near-cusp blowups.
 */
function bezierCurvature(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: number): number {
  const d1 = {
    x:
      3 * (1 - u) ** 2 * (p1.x - p0.x) +
      6 * (1 - u) * u * (p2.x - p1.x) +
      3 * u * u * (p3.x - p2.x),
    y:
      3 * (1 - u) ** 2 * (p1.y - p0.y) +
      6 * (1 - u) * u * (p2.y - p1.y) +
      3 * u * u * (p3.y - p2.y),
  };
  const d2 = {
    x: 6 * (1 - u) * (p2.x - 2 * p1.x + p0.x) + 6 * u * (p3.x - 2 * p2.x + p1.x),
    y: 6 * (1 - u) * (p2.y - 2 * p1.y + p0.y) + 6 * u * (p3.y - 2 * p2.y + p1.y),
  };
  const speed = Math.hypot(d1.x, d1.y);
  if (speed < 1e-9) return 0;
  const cross = Math.abs(d1.x * d2.y - d1.y * d2.x);
  return Math.min(100, cross / Math.max(speed ** 3, 1e-9));
}

interface Reparameterisation {
  /** Map normalised leg time τ ∈ [0,1] to Bézier parameter u ∈ [0,1]. */
  uAt(tau: number): number;
}

/** Mid-reach micro-correction drawn for a leg. */
interface MicroCorrection {
  /** Normalised leg time of the correction centre. */
  tau0: number;
  /** Normalised width of the correction. */
  sigma: number;
  /** Lateral amplitude, px (signed). */
  amp: number;
}

function bumpShape(tau: number, bump: MicroCorrection): number {
  return Math.exp(-((tau - bump.tau0) ** 2) / (2 * bump.sigma ** 2));
}

/**
 * Build the time→path map for a leg: a minimum-jerk (or corrective
 * easeOut) base profile weighted by a curvature slowdown term. The 2/3
 * power law says fast turns are impossible; making progress slower
 * where the path curves harder is what puts the speed/curvature slope β
 * into the human band instead of the flat signature of a pure easing.
 * A drawn micro-correction (if any) rides a matching speed dip: hands
 * shed speed exactly where they correct direction.
 */
function buildReparameterisation(
  anchors: [Vec2, Vec2],
  from: Vec2,
  to: Vec2,
  profile: "pulse" | "correct",
  curvatureWeight: number,
  bump?: MicroCorrection | null,
): Reparameterisation {
  const steps = 256;
  const [c1, c2] = anchors;
  const useWeight = curvatureWeight > 0;
  const curvatures = new Array<number>(steps + 1).fill(0);
  let maxCurvature = 0;
  if (useWeight) {
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      curvatures[i] = bezierCurvature(from, c1, c2, to, u);
      if (curvatures[i] > maxCurvature) maxCurvature = curvatures[i];
    }
  }
  const weightAt = (u: number): number => {
    if (!useWeight || maxCurvature <= 1e-9) return 1;
    const index = clamp(Math.round(u * steps), 0, steps);
    return 1 / (1 + curvatureWeight * (curvatures[index] / maxCurvature));
  };
  const bumpDipAt = (tau: number): number => {
    if (!bump) return 1;
    // Deeper corrections shed more speed through the correction.
    return 1 / (1 + Math.abs(bump.amp) * 1.2 * bumpShape(tau, bump));
  };
  const baseAt = (tau: number): number =>
    profile === "pulse"
      ? Math.max(minJerkDerivative(tau), 1e-6)
      : Math.max(3 * (1 - tau) ** 2, 1e-6);

  // Euler-integrate dτ-weighted progress into a τ→u table. `table[i]`
  // holds the path parameter reached at normalised leg time i/steps;
  // renormalising by the final value makes every leg end exactly at u=1.
  const table = new Array<number>(steps + 1).fill(0);
  let u = 0;
  for (let i = 1; i <= steps; i++) {
    const tauMid = (i - 0.5) / steps;
    u = clamp(u + (baseAt(tauMid) * weightAt(u) * bumpDipAt(tauMid)) / steps, 0, 1);
    table[i] = u;
  }
  const total = table[steps];
  if (total <= 1e-6) {
    return {
      uAt: (tau) => (profile === "pulse" ? minJerk(tau) : easeOutCubic(tau)),
    };
  }
  return {
    uAt(tau: number): number {
      const index = clamp(Math.round(clamp(tau, 0, 1) * steps), 0, steps);
      return table[index] / total;
    },
  };
}

/** Clustered per-point delays around the frame interval, scaled to a budget. */
function frameDelays(rng: () => number, count: number, budgetMs: number): number[] {
  const raw: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    let value = FRAME_INTERVAL_MS * lognormal(rng, 0, 0.12);
    if (rng() < MERGED_FRAME_PROBABILITY) value *= 2;
    raw.push(value);
    sum += value;
  }
  const scale = sum > 0 ? budgetMs / sum : 1;
  return raw.map((value) => clamp(value * scale, MIN_LEG_DELAY_MS, MAX_LEG_DELAY_MS));
}

/**
 * v2 control anchors: at ⅓ and ⅔ along the leg, offset perpendicular by
 * a deeper spread than the v1 planner (12–30% of the leg) and
 * occasionally on opposite sides, which draws a gentle S — wrists do
 * this constantly, and the curvature swing it adds is what gives the
 * speed/curvature relation its human slope.
 */
function behaviorAnchors(a: Vec2, b: Vec2, rng: () => number): [Vec2, Vec2] {
  const len = distance(a, b);
  if (len < 6) {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return [mid, mid];
  }
  const spread = len * uniform(rng, ANCHOR_SPREAD_MIN, ANCHOR_SPREAD_MAX);
  const side = rng() < 0.5 ? -1 : 1;
  const opposite = rng() < S_CURVE_PROBABILITY;
  const normal = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const anchor = (along: number, ownSide: number, scale: number): Vec2 => ({
    x: a.x + (b.x - a.x) * along + normal.x * spread * ownSide * scale,
    y: a.y + (b.y - a.y) * along + normal.y * spread * ownSide * scale,
  });
  return [
    anchor(1 / 3, side, uniform(rng, 0.7, 1.3)),
    anchor(2 / 3, opposite ? -side : side, uniform(rng, 0.7, 1.3)),
  ];
}

interface PlanLegOptions {
  from: Vec2;
  to: Vec2;
  durationMs: number;
  rng: () => number;
  jitter: boolean;
  /** "pulse" = min-jerk with curvature weighting; "correct" = easeOut. */
  profile?: "pulse" | "correct";
  /** Drawn per leg; 0 disables the slowdown weighting. */
  curvatureWeight?: number;
  /** Extra noise multiplier (vertical asymmetry). */
  noiseScale?: number;
  minPoints?: number;
  maxPoints?: number;
}

/**
 * Plan one continuous movement leg. The returned points exclude the
 * start (legs chain from the previous segment's last point) and the
 * final point lands exactly on `to`.
 */
function planLeg(options: PlanLegOptions): TrajectoryPoint[] {
  const { from, to, rng, jitter } = options;
  const durationMs = Math.max(options.durationMs, 2 * MIN_LEG_DELAY_MS);
  const minPoints = Math.max(2, options.minPoints ?? 4);
  const maxPoints = options.maxPoints ?? 140;
  const count = clamp(Math.round(durationMs / FRAME_INTERVAL_MS), minPoints, maxPoints);
  const profile = options.profile ?? "pulse";
  const noiseScale = options.noiseScale ?? 1;

  const legLength = distance(from, to);
  const anchors: [Vec2, Vec2] =
    legLength < 6
      ? [
          { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
          { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
        ]
      : behaviorAnchors(from, to, rng);

  // Mid-reach micro-correction: hands nudge their course mid-move and
  // shed speed through the nudge. This also keeps the trace's
  // speed/curvature relation from collapsing on flat arcs.
  const bump: MicroCorrection | null =
    profile === "pulse" && jitter && legLength >= 40
      ? {
          tau0: uniform(rng, 0.3, 0.7),
          sigma: uniform(rng, 0.05, 0.12),
          amp: (rng() < 0.5 ? -1 : 1) * uniform(rng, 2, 4.5),
        }
      : null;

  const reparam = buildReparameterisation(
    anchors,
    from,
    to,
    profile,
    profile === "pulse"
      ? (options.curvatureWeight ?? uniform(rng, CURVATURE_WEIGHT_MIN, CURVATURE_WEIGHT_MAX))
      : 0,
    bump,
  );

  // Correlated low-frequency wander for the leg: one drawn vector under
  // a sine envelope reads as hand drift, unlike per-point white noise.
  const drift = jitter
    ? { x: gaussian(rng) * 0.6 * noiseScale, y: gaussian(rng) * 0.6 * noiseScale }
    : { x: 0, y: 0 };
  const phase = rng() * Math.PI;

  const delays = frameDelays(rng, count, durationMs);
  const points: TrajectoryPoint[] = [];
  for (let j = 1; j <= count; j++) {
    const tau = j / count;
    const u = reparam.uAt(tau);
    let pos = cubicBezier(from, anchors[0], anchors[1], to, u);
    if (bump && u > 0 && u < 1) {
      // Local normal from a finite tangent, bump displaced along it.
      const e = 0.01;
      const ahead = cubicBezier(from, anchors[0], anchors[1], to, clamp(u + e, 0, 1));
      const behind = cubicBezier(from, anchors[0], anchors[1], to, clamp(u - e, 0, 1));
      const tx = ahead.x - behind.x;
      const ty = ahead.y - behind.y;
      const tl = Math.hypot(tx, ty) || 1;
      const shape = bumpShape(tau, bump);
      pos = {
        x: pos.x + (-ty / tl) * bump.amp * shape,
        y: pos.y + (tx / tl) * bump.amp * shape,
      };
    }
    const isFinal = j === count;
    const envelope = Math.sin(Math.PI * clamp(tau, 0, 1) + phase);
    points.push({
      x: isFinal
        ? to.x
        : pos.x + drift.x * envelope + (jitter ? gaussian(rng) * 0.25 * noiseScale : 0),
      y: isFinal
        ? to.y
        : pos.y + drift.y * envelope + (jitter ? gaussian(rng) * 0.25 * noiseScale : 0),
      delayMs: delays[j - 1],
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Locked windows (hesitation, inspection stays, pre-click settle)
// ---------------------------------------------------------------------------

interface PlanLockOptions {
  at: Vec2;
  /** Total window drift σ (px); spread smoothly across the stay. */
  driftSigma: number;
  /** White noise per point (px). */
  noiseSigma: number;
  rng: () => number;
  jitter: boolean;
  delays: number[];
}

/**
 * Near-stationary points inside a locked window. The drift is one drawn
 * slow vector spread across the window (seconds-scale wander, never
 * high-frequency tremble — trembling on a locked position is itself a
 * synthetic signature). The last point sits at the drifted position so
 * the next leg continues from where the pointer actually is.
 */
function planLockBlock(options: PlanLockOptions): TrajectoryPoint[] {
  const { at, driftSigma, noiseSigma, rng, jitter, delays } = options;
  const drift = jitter
    ? { x: gaussian(rng) * driftSigma, y: gaussian(rng) * driftSigma }
    : { x: 0, y: 0 };
  return delays.map((delayMs, i) => {
    const share = (i + 1) / (delays.length + 1);
    return {
      x: at.x + drift.x * share + (jitter ? gaussian(rng) * noiseSigma : 0),
      y: at.y + drift.y * share + (jitter ? gaussian(rng) * noiseSigma : 0),
      delayMs,
    };
  });
}

/** Clustered delays for a fixed-duration locked window. */
function lockDelays(rng: () => number, count: number, totalMs: number, minMs: number): number[] {
  const raw: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const value = lognormal(rng, 0, 0.2);
    raw.push(value);
    sum += value;
  }
  const scale = sum > 0 ? totalMs / sum : 1;
  return raw.map((value) => Math.max(minMs, value * scale));
}

// ---------------------------------------------------------------------------
// Landing helpers
// ---------------------------------------------------------------------------

/**
 * Truncated-Gaussian point inside a box that avoids the dead centre and
 * the edges — bots aim for the exact middle; hands do not.
 */
function pointInBox(
  box: BehaviorBox,
  rng: () => number,
  centreAvoidPx: number,
  edgeMarginPx: number,
): Vec2 {
  const sigma = Math.max(box.width, box.height) / 6;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = {
      x: box.x + box.width / 2 + gaussian(rng) * sigma,
      y: box.y + box.height / 2 + gaussian(rng) * sigma,
    };
    if (
      candidate.x < box.x + edgeMarginPx ||
      candidate.x > box.x + box.width - edgeMarginPx ||
      candidate.y < box.y + edgeMarginPx ||
      candidate.y > box.y + box.height - edgeMarginPx
    ) {
      continue;
    }
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (distance(candidate, centre) < centreAvoidPx) continue;
    return candidate;
  }
  // Deterministic fallback: offset towards a corner, still off-centre.
  return {
    x: clamp(
      box.x + box.width / 2 + centreAvoidPx + 1,
      box.x + edgeMarginPx,
      box.x + box.width - edgeMarginPx,
    ),
    y: clamp(box.y + box.height / 2, box.y + edgeMarginPx, box.y + box.height - edgeMarginPx),
  };
}

/**
 * Pre-click landing scatter: a point 6–12 px off the resolved target,
 * rejected if it leaves the box or approaches its centre. Only applied
 * when the box is comfortably larger than the scatter, so small
 * controls keep their exact action point.
 */
function scatterLanding(to: Vec2, box: BehaviorBox, rng: () => number): Vec2 {
  if (Math.min(box.width, box.height) < SCATTER_MIN_BOX_DIMENSION_PX) return to;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = rng() * Math.PI * 2;
    const radius = Math.min(
      SCATTER_OFFSET_MIN_PX + Math.abs(gaussian(rng)) * 2.2,
      SCATTER_OFFSET_MAX_PX,
    );
    const candidate = {
      x: to.x + Math.cos(angle) * radius,
      y: to.y + Math.sin(angle) * radius,
    };
    const margin = HOVER_STOP_EDGE_MARGIN_PX;
    if (
      candidate.x < box.x + margin ||
      candidate.x > box.x + box.width - margin ||
      candidate.y < box.y + margin ||
      candidate.y > box.y + box.height - margin
    ) {
      continue;
    }
    if (distance(candidate, centre) < SCATTER_CENTRE_RADIUS_PX) continue;
    return candidate;
  }
  return to;
}

// ---------------------------------------------------------------------------
// State machine orchestration
// ---------------------------------------------------------------------------

interface InsertDecision {
  kind: "hesitate" | "hover" | "rethink";
  fraction: number;
  /** Hover only: the box to inspect and whether a tooltip is advertised. */
  box?: BehaviorBox;
  tooltipish?: boolean;
}

function resolvePersona(rng: () => number, persona: BehaviorPersona): "fast" | "careful" {
  if (persona !== "auto") return persona;
  return rng() < PERSONA_AUTO_FAST_WEIGHT ? "fast" : "careful";
}

function decideOvershoot(
  explicit: boolean | undefined,
  d: number,
  w: number,
  rng: () => number,
): boolean {
  if (explicit !== undefined) return explicit;
  return (
    d > OVERSHOOT_MIN_DISTANCE_PX && w > OVERSHOOT_MIN_WIDTH_PX && rng() < OVERSHOOT_PROBABILITY
  );
}

function correctPulseCount(
  d: number,
  w: number,
  persona: "fast" | "careful",
  rng: () => number,
): number {
  const id = Math.log2(d / Math.max(w, 1) + 1);
  if (id <= 3) return rng() < 0.5 ? 1 : 0;
  const base = 1 + poisson(rng, 0.5);
  const capped = Math.min(base, CORRECT_MAX_PULSES);
  return persona === "fast" ? Math.min(capped, 2) : capped;
}

/**
 * Probe up to three sampled path points for an interactive element the
 * cursor will pass. Sampling follows the leg's fraction order and stops
 * at the first qualifying hit.
 */
async function probeForHoverInsert(
  probe: BehaviorProbe | null,
  anchors: [Vec2, Vec2],
  from: Vec2,
  mainEnd: Vec2,
  busyFractions: number[],
  personaScale: number,
  force: boolean,
  rng: () => number,
): Promise<InsertDecision | null> {
  if (!probe) return null;
  const fractions = HOVER_PROBE_FRACTIONS.map((f) =>
    clamp(f + uniform(rng, -0.04, 0.04), 0.1, 0.9),
  );
  let calls = 0;
  for (const fraction of fractions) {
    if (calls >= 3) break;
    if (busyFractions.some((busy) => Math.abs(busy - fraction) < 0.08)) continue;
    const point = cubicBezier(from, anchors[0], anchors[1], mainEnd, fraction);
    calls++;
    let hit: BehaviorProbeHit | null;
    try {
      hit = await probe(point.x, point.y);
    } catch {
      continue;
    }
    if (!hit) continue;
    const pad = uniform(rng, HOVER_BOX_PAD_MIN_PX, HOVER_BOX_PAD_MAX_PX);
    const expanded = {
      x: hit.box.x - pad,
      y: hit.box.y - pad,
      width: hit.box.width + pad * 2,
      height: hit.box.height + pad * 2,
    };
    const inside =
      point.x >= expanded.x &&
      point.x <= expanded.x + expanded.width &&
      point.y >= expanded.y &&
      point.y <= expanded.y + expanded.height;
    if (!inside) continue;
    const trigger =
      force ||
      rng() <
        clamp(
          HOVER_TRIGGER_PROBABILITY * personaScale,
          HOVER_TRIGGER_PROBABILITY_MIN,
          HOVER_TRIGGER_PROBABILITY_MAX,
        );
    if (!trigger) continue;
    return { kind: "hover", fraction, box: hit.box, tooltipish: hit.tooltipish };
  }
  return null;
}

/** Degenerate same-point plan: nothing to traverse. */
function degeneratePlan(to: Vec2, dwell: boolean, rng: () => number): BehaviorPlan {
  const settle = clamp(lognormal(rng, 0, 0.3) * DWELL_SETTLE_MS_MEDIAN, 20, 140);
  const points: TrajectoryPoint[] = [{ x: to.x, y: to.y, delayMs: FRAME_INTERVAL_MS }];
  if (dwell) points.push({ x: to.x, y: to.y, delayMs: settle });
  points.push({ x: to.x, y: to.y, delayMs: FRAME_INTERVAL_MS });
  return {
    points,
    landed: { x: to.x, y: to.y },
    segments: dwell ? [{ kind: "dwell", start: 0, end: points.length - 1 }] : [],
    plannedDurationMs: plannedSum(points),
    persona: "careful",
    overshoot: false,
  };
}

function plannedSum(points: TrajectoryPoint[]): number {
  return points.reduce((sum, p) => sum + p.delayMs, 0);
}

/**
 * Plan a full v2 behaviour trace. Async only because the en-route
 * element probe is a page-world call; with `probe: null` the result is
 * fully determined by the seeded RNG.
 */
export async function planBehaviorTrajectory(options: PlanBehaviorOptions): Promise<BehaviorPlan> {
  const rng = options.rng ?? Math.random;
  const jitter = options.jitter ?? true;
  const dwell = options.dwell ?? false;
  const testing = options.testing ?? {};
  const { from, to } = options;
  const d = distance(from, to);
  const persona = resolvePersona(rng, options.persona ?? "auto");
  const personaScale = PERSONA_SCALE[persona];

  if (d < MIN_MEANINGFUL_DISTANCE_PX) {
    return degeneratePlan(to, dwell, rng);
  }

  const box = options.targetBox ?? null;
  const width = box
    ? clamp(Math.min(box.width, box.height), 4, Math.max(d, 8))
    : DEFAULT_TARGET_WIDTH_PX;

  // --- PLAN: total motion budget -------------------------------------------
  let budget = options.durationMs ?? fittsDurationMs(d, width, rng);
  budget *= personaScale.time;
  // Aiming at something you are about to press reads as slightly more
  // deliberate than a plain traverse.
  if (dwell) budget *= 0.92;
  const asymmetry = verticalAsymmetry(from, to, rng);
  budget *= asymmetry.timeScale;
  budget = clamp(budget, FITTS_MIN_MS, 60_000);

  // Landing: pre-click scatter keeps the press off the geometric centre.
  const landed = dwell && box ? scatterLanding(to, box, rng) : to;

  // --- Decide stochastic branches ------------------------------------------
  const overshootEnabled = decideOvershoot(options.overshoot, d, width, rng);
  const mainSpan = overshootEnabled
    ? d + uniform(rng, OVERSHOOT_MIN_PX, OVERSHOOT_MAX_PX)
    : d * uniform(rng, MAIN_PULSE_MIN_FRACTION, MAIN_PULSE_MAX_FRACTION);
  const unit = { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
  const mainEnd: Vec2 = { x: from.x + unit.x * mainSpan, y: from.y + unit.y * mainSpan };

  const inserts: InsertDecision[] = [];
  // Rethink first: it claims a mid/late fraction and pre-empts inspection.
  const rethinkP =
    uniform(rng, RETHINK_PROBABILITY_MIN, RETHINK_PROBABILITY_MAX) * (dwell ? 0.5 : 1);
  const rethink =
    d >= RETHINK_MIN_DISTANCE_PX && (testing.forceRethink === true || rng() < rethinkP);
  const rethinkFraction = uniform(rng, RETHINK_FRACTION_MIN, RETHINK_FRACTION_MAX);
  if (rethink) {
    inserts.push({ kind: "rethink", fraction: rethinkFraction });
  }
  if (
    d > HESITATE_MIN_DISTANCE_PX &&
    (testing.forceHesitate === true || rng() < HESITATE_PROBABILITY * personaScale.hesitate)
  ) {
    let fraction = uniform(rng, HESITATE_FRACTION_MIN, HESITATE_FRACTION_MAX);
    if (rethink && Math.abs(fraction - rethinkFraction) < 0.12) {
      fraction = clamp(fraction - 0.15, HESITATE_FRACTION_MIN, HESITATE_FRACTION_MAX);
    }
    inserts.push({ kind: "hesitate", fraction });
  }

  // Base arc for the main pulse (used for fraction sampling and probing).
  const anchors = behaviorAnchors(from, mainEnd, rng);

  // En-route inspection: probe up to three sampled points. A rethink
  // later on the path pre-empts a stop further along (the hand has
  // already committed to going back).
  const busy = inserts.map((insert) => insert.fraction);
  const hoverInsert = await probeForHoverInsert(
    options.probe ?? null,
    anchors,
    from,
    mainEnd,
    busy,
    personaScale.hover,
    testing.forceHoverTrigger === true,
    rng,
  );
  const hoverDropped = hoverInsert !== null && rethink && hoverInsert.fraction > rethinkFraction;
  if (hoverInsert && !hoverDropped) {
    inserts.push(hoverInsert);
  }
  inserts.sort((a, b) => a.fraction - b.fraction);
  const midflight = inserts.slice(0, MAX_MIDFLIGHT_INSERTS);

  // --- Time allocation -------------------------------------------------------
  const pulseCount = correctPulseCount(d, width, persona, rng);
  const correctionsBudget = dwell ? 0 : pulseCount * uniform(rng, 80, 150);
  // A click move takes longer than a plain one: the brake extends the
  // motion instead of eating the main pulse's Fitts share.
  const drawnBrakeMs = dwell
    ? clamp(
        budget * uniform(rng, DWELL_BRAKE_SHARE_MIN, DWELL_BRAKE_SHARE_MAX),
        DWELL_BRAKE_MS_MIN,
        DWELL_BRAKE_MS_MAX,
      )
    : 0;
  const arrivalBudget = dwell ? 0 : correctionsBudget;

  const hesitateInsert = midflight.find((insert) => insert.kind === "hesitate");
  const activeHover = midflight.find((insert) => insert.kind === "hover");
  const activeRethink = midflight.find((insert) => insert.kind === "rethink");

  // Hesitation is drawn at research pacing, then fitted to the budget by
  // trimming point count (never below three) — a short move still gets
  // its moment of doubt, just a briefer one.
  const hesitateDraw = hesitateInsert
    ? {
        count:
          HESITATE_POINTS_MIN + Math.floor(rng() * (HESITATE_POINTS_MAX - HESITATE_POINTS_MIN + 1)),
        stepMs: uniform(rng, HESITATE_STEP_MS_MIN, HESITATE_STEP_MS_MAX),
      }
    : null;
  let hesitateCount = hesitateDraw?.count ?? 0;
  const hesitateStepMs = hesitateDraw?.stepMs ?? 0;
  if (hesitateDraw) {
    const cap = Math.max(120, budget * 0.45);
    if (hesitateDraw.count * hesitateStepMs > cap) {
      hesitateCount = Math.max(HESITATE_POINTS_MIN, Math.floor(cap / hesitateStepMs));
    }
  }
  const hesitateMs = hesitateCount * hesitateStepMs;
  let hoverStayMs = 0;
  if (activeHover) {
    hoverStayMs = clamp(
      lognormal(rng, Math.log(HOVER_STAY_MS_MEDIAN), HOVER_STAY_MS_SIGMA),
      HOVER_STAY_MS_MIN,
      HOVER_STAY_MS_MAX,
    );
    if (activeHover.tooltipish && rng() < 0.5) {
      hoverStayMs = Math.min(
        hoverStayMs + uniform(rng, HOVER_TOOLTIP_EXTENSION_MIN_MS, HOVER_TOOLTIP_EXTENSION_MAX_MS),
        HOVER_STAY_MS_MAX + HOVER_TOOLTIP_EXTENSION_MAX_MS,
      );
    }
  }
  const approachMs = activeHover ? uniform(rng, 120, 220) : 0;
  const retreatMs = activeRethink ? budget * uniform(rng, 0.1, 0.16) : 0;

  let mainBudget = budget - hesitateMs - approachMs - hoverStayMs - retreatMs - arrivalBudget;
  if (mainBudget < 120 && midflight.length > 0) {
    // Not enough room for the expensive colour; hesitation was already
    // fitted to the budget and stays, hover/rethink go.
    const kept = midflight.filter((entry) => entry.kind === "hesitate");
    midflight.length = 0;
    midflight.push(...kept);
    mainBudget = Math.max(budget - hesitateMs - arrivalBudget, 120);
  }
  mainBudget = Math.max(mainBudget, MAIN_PULSE_MIN_MS);

  // The pre-click brake must be long enough that the detector's final
  // window (up to 500 ms, at most half the trace) contains brake content
  // only — a resume pulse peaking seconds before the press would defeat
  // the deceleration channel. Scale the brake to whatever went before it.
  const elapsedBeforeBrake = mainBudget + hesitateMs + approachMs + hoverStayMs + retreatMs;
  const brakeBudget = dwell
    ? clamp(
        Math.max(drawnBrakeMs, elapsedBeforeBrake * uniform(rng, 1.05, 1.2)),
        DWELL_BRAKE_MS_MIN,
        DWELL_BRAKE_MS_MAX_EXTENDED,
      )
    : 0;

  // --- Build the trace --------------------------------------------------------
  const points: TrajectoryPoint[] = [];
  const segments: BehaviorSegmentInfo[] = [];
  const mark = (kind: BehaviorSegmentInfo["kind"]): number => {
    segments.push({ kind, start: points.length, end: points.length });
    return segments.length - 1;
  };
  const extend = (segmentIndex: number, added: TrajectoryPoint[]): void => {
    points.push(...added);
    segments[segmentIndex].end = points.length - 1;
  };

  // The trace opens on the start position (first frame delay).
  points.push({
    x: from.x,
    y: from.y,
    delayMs: clamp(FRAME_INTERVAL_MS * lognormal(rng, 0, 0.15), MIN_LEG_DELAY_MS, MAX_LEG_DELAY_MS),
  });
  const mainIndex = mark("main");
  let cursor: Vec2 = from;

  const arcPoint = (fraction: number): Vec2 =>
    cubicBezier(from, anchors[0], anchors[1], mainEnd, fraction);

  /** Main-pulse leg from the current cursor to `target`. */
  const pulseLeg = (target: Vec2, ms: number, minPoints = 4): TrajectoryPoint[] =>
    planLeg({
      from: cursor,
      to: target,
      durationMs: ms,
      rng,
      jitter,
      profile: "pulse",
      noiseScale: asymmetry.noiseScale,
      minPoints,
    });

  // Pre-insert arc travel (hesitate sits on the arc; hover/rethink break it).
  const preInsertFraction = midflight.length > 0 ? midflight[0].fraction : 1;
  if (preInsertFraction < 1) {
    const preMs = Math.max(mainBudget * preInsertFraction * uniform(rng, 0.85, 1.0), 60);
    extend(mainIndex, pulseLeg(arcPoint(preInsertFraction), preMs));
  } else {
    extend(mainIndex, pulseLeg(mainEnd, mainBudget, 6));
  }
  cursor = points[points.length - 1];

  for (const insert of midflight) {
    if (insert.kind === "hesitate") {
      const count = Math.max(HESITATE_POINTS_MIN, hesitateCount);
      const delays = Array.from({ length: count }, () =>
        Math.round(
          clamp(
            hesitateStepMs * lognormal(rng, 0, 0.2),
            HESITATE_STEP_MS_MIN,
            HESITATE_STEP_MS_MAX,
          ),
        ),
      );
      const hesitateIndex = mark("hesitate");
      extend(
        hesitateIndex,
        planLockBlock({
          at: cursor,
          driftSigma: HESITATE_DRIFT_SIGMA_PX,
          noiseSigma: 0.3,
          rng,
          jitter,
          delays,
        }),
      );
      cursor = points[points.length - 1];
      // Resume along a fresh sub-arc to the pulse end (or the next break).
      const nextBreak = midflight.find((later) => later.fraction > insert.fraction);
      const resumeTarget = nextBreak ? arcPoint(nextBreak.fraction) : mainEnd;
      const resumeMs = Math.max(mainBudget * (1 - insert.fraction) * uniform(rng, 0.8, 1.0), 90);
      extend(mainIndex, pulseLeg(resumeTarget, resumeMs));
      cursor = points[points.length - 1];
    } else if (insert.kind === "hover" && insert.box) {
      // Steer into the element and inspect it.
      const stop = pointInBox(
        insert.box,
        rng,
        HOVER_STOP_CENTRE_AVOID_PX,
        HOVER_STOP_EDGE_MARGIN_PX,
      );
      const approachIndex = mark("main");
      extend(
        approachIndex,
        planLeg({
          from: cursor,
          to: stop,
          durationMs: approachMs || 160,
          rng,
          jitter,
          profile: "pulse",
          curvatureWeight: 0,
          minPoints: 3,
        }),
      );
      cursor = points[points.length - 1];
      const stayCount = 2 + Math.floor(rng() * 3);
      const stayDelays = lockDelays(rng, stayCount, hoverStayMs, 25);
      const hoverIndex = mark("hover");
      extend(
        hoverIndex,
        planLockBlock({
          at: cursor,
          driftSigma: 0.8,
          noiseSigma: 0.22,
          rng,
          jitter,
          delays: stayDelays,
        }),
      );
      cursor = points[points.length - 1];
      // Leave towards the pulse end on a fresh sub-arc.
      const leaveMs = Math.max(mainBudget * uniform(rng, 0.2, 0.35), 90);
      extend(mainIndex, pulseLeg(mainEnd, leaveMs));
      cursor = points[points.length - 1];
    } else if (insert.kind === "rethink") {
      // Walk out to the turn, retreat part-way, then commit again.
      const turn = arcPoint(insert.fraction);
      if (distance(cursor, turn) > 1) {
        extend(mainIndex, pulseLeg(turn, Math.max(mainBudget * 0.3, 80)));
        cursor = points[points.length - 1];
      }
      const back = { x: -unit.x, y: -unit.y };
      const normal = { x: -unit.y, y: unit.x };
      const side = rng() < 0.5 ? -1 : 1;
      const retreat: Vec2 = {
        x:
          cursor.x + back.x * d * uniform(rng, 0.08, 0.15) + normal.x * side * uniform(rng, 14, 48),
        y:
          cursor.y + back.y * d * uniform(rng, 0.08, 0.15) + normal.y * side * uniform(rng, 14, 48),
      };
      const retreatIndex = mark("rethink");
      extend(
        retreatIndex,
        planLeg({
          from: cursor,
          to: retreat,
          durationMs: retreatMs || 120,
          rng,
          jitter,
          profile: "pulse",
          curvatureWeight: 0,
          minPoints: 4,
        }),
      );
      cursor = points[points.length - 1];
      extend(mainIndex, pulseLeg(mainEnd, Math.max(mainBudget * uniform(rng, 0.3, 0.45), 90)));
      cursor = points[points.length - 1];
    }
  }

  // Safety: any plan whose cursor has not reached the pulse end closes it.
  if (distance(cursor, mainEnd) > 1) {
    extend(mainIndex, pulseLeg(mainEnd, Math.max(mainBudget * 0.3, 90)));
    cursor = points[points.length - 1];
  }

  // --- Arrival -----------------------------------------------------------------
  if (dwell) {
    const dwellIndex = mark("dwell");
    // Min-jerk brake: leave the pulse end, gather a little speed, then
    // a slow, decelerating settle into the landing — the last 500 ms of
    // the trace stays far below the global peak speed.
    extend(
      dwellIndex,
      planLeg({
        from: cursor,
        to: landed,
        durationMs: brakeBudget,
        rng,
        jitter,
        profile: "pulse",
        curvatureWeight: 0,
        minPoints: 10,
        maxPoints: 40,
        noiseScale: 0.6,
      }),
    );
    cursor = points[points.length - 1];
    // Settle pair: a real pause on the landing, then the exact press point.
    const settleMs = clamp(lognormal(rng, Math.log(DWELL_SETTLE_MS_MEDIAN), 0.3), 20, 140);
    points.push({ x: cursor.x, y: cursor.y, delayMs: settleMs });
    points.push({ x: landed.x, y: landed.y, delayMs: MIN_LEG_DELAY_MS });
    segments[dwellIndex].end = points.length - 1;
  } else {
    // Corrective pulses eat the remaining error; the last lands exactly.
    const remaining = distance(cursor, landed);
    if (remaining >= 1) {
      const pulses = Math.max(1, remaining <= 24 ? Math.min(pulseCount, 1) : pulseCount);
      const correctIndex = mark("correct");
      for (let k = 1; k <= pulses; k++) {
        const isLast = k === pulses;
        const residual = distance(cursor, landed);
        if (residual < 0.5) break;
        const travel = isLast
          ? residual
          : residual * uniform(rng, CORRECT_TRAVEL_MIN_SHARE, CORRECT_TRAVEL_MAX_SHARE);
        const angleNoise = isLast ? 0 : (gaussian(rng) * 6 * Math.PI) / 180;
        const baseAngle = Math.atan2(landed.y - cursor.y, landed.x - cursor.x);
        const target: Vec2 = {
          x: cursor.x + Math.cos(baseAngle + angleNoise) * travel,
          y: cursor.y + Math.sin(baseAngle + angleNoise) * travel,
        };
        const pulseMs = clamp(
          lognormal(rng, Math.log(CORRECT_DURATION_MS_MEDIAN), CORRECT_DURATION_MS_SIGMA),
          CORRECT_DURATION_MS_MIN,
          CORRECT_DURATION_MS_MAX,
        );
        extend(
          correctIndex,
          planLeg({
            from: cursor,
            to: isLast ? landed : target,
            durationMs: pulseMs,
            rng,
            jitter,
            profile: "correct",
            minPoints: isLast ? 3 : 2,
            maxPoints: 10,
            noiseScale: 0.8,
          }),
        );
        cursor = points[points.length - 1];
      }
      // Guarantee the exact landing even if every pulse was skipped.
      const last = points[points.length - 1];
      if (last.x !== landed.x || last.y !== landed.y) {
        points.push({ x: landed.x, y: landed.y, delayMs: MIN_LEG_DELAY_MS });
        segments[correctIndex].end = points.length - 1;
      }
    }
  }

  return {
    points,
    landed: { x: landed.x, y: landed.y },
    segments,
    plannedDurationMs: plannedSum(points),
    persona,
    overshoot: overshootEnabled,
  };
}

/** Re-export for callers that want a reproducible default RNG. */
export { createSeededRng };
