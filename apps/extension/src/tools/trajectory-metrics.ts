// Offline behavioural metrics for planned pointer traces.
//
// This is the graded half of the v2 behaviour work: the same statistics
// that detection stacks score traces with, computed here so the planner
// can be held to a human envelope in unit tests. Thresholds and feature
// definitions follow the published detector literature — the power-law
// speed/curvature envelope and pause/submovement quantiles from the
// MIT-licensed kitsune Balabit analysis, the pre-click deceleration and
// constant-second-derivative channels from the MIT-licensed
// motion-attestation write-up. Nothing here talks to CDP; it is pure
// math over a point list.

import type { TrajectoryPoint, Vec2 } from "./trajectory";

/** One trace sample placed on the time axis, with step speed. */
export interface TimedSample {
  /** Milliseconds since the first dispatch (cumulative preceding delays). */
  t: number;
  x: number;
  y: number;
  /** Speed over the step arriving at this sample, px/ms. */
  v: number;
}

/** Aggregate detector-view of a trace. */
export interface TraceMetrics {
  /** Slope of log(speed) vs log(curvature radius); humans ≈ 0.1–0.6. */
  beta: number;
  /** Share of samples moving slower than the pause threshold. */
  pauseRatio: number;
  /** Number of distinct speed peaks (main pulse + corrections). */
  submovementCount: number;
  /** Peak speed in the final window divided by the global peak speed. */
  endDecelerationRatio: number;
  /** Variance of the along-path acceleration; constant for naive ramps. */
  accelerationVariance: number;
}

/** Radius at or above which a path is considered straight (px). */
const FLAT_RADIUS_PX = 5_000;
/**
 * Speeds below this fraction of the peak are pause phenomena, not
 * movement: they are scored by the pause ratio (where they belong) and
 * excluded from the power-law fit, whose subject is the moving body of
 * the trace. Launch/landing samples would otherwise drag the slope with
 * near-zero speeds measured on gentle departure curvature.
 */
const BETA_SPEED_FLOOR = 0.15;
/** Pauses are steps slower than max(absolute floor, share of peak). */
const PAUSE_ABS_PX_MS = 0.02;
const PAUSE_PEAK_SHARE = 0.05;
/** Peaks below this fraction of the smoothed maximum are not submovements. */
const SUBMOVEMENT_PEAK_SHARE = 0.18;
/** Peaks separated by a valley shallower than this count as one movement. */
const SUBMOVEMENT_VALLEY_SHARE = 0.6;

/**
 * Place a trace on the time axis. The delay stored on each point is the
 * real sleep dispatched *after* that point, so sample `i` sits at the
 * sum of the delays of points `0..i-1`, and its speed is the step
 * distance divided by the preceding delay.
 */
export function sampleTimeline(points: TrajectoryPoint[]): TimedSample[] {
  const samples: TimedSample[] = [];
  let t = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i === 0) {
      samples.push({ t, x: p.x, y: p.y, v: 0 });
    } else {
      const prev = points[i - 1];
      const dt = Math.max(prev.delayMs, 1e-6);
      const v = Math.hypot(p.x - prev.x, p.y - prev.y) / dt;
      t += prev.delayMs;
      samples.push({ t, x: p.x, y: p.y, v });
    }
  }
  return samples;
}

/** Step distances between consecutive samples (px). */
export function stepLengths(points: TrajectoryPoint[]): number[] {
  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    lengths.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return lengths;
}

/**
 * Local curvature radius at each interior sample, via the circumcircle
 * of the sample with its immediate neighbours. Near-collinear triples
 * clamp to `FLAT_RADIUS_PX` so straight stretches do not dominate the
 * log fit.
 */
export function curvatureRadii(points: TrajectoryPoint[]): Array<number | null> {
  const radii: Array<number | null> = points.map(() => null);
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const product = ab * bc * ca;
    if (product < 1e-9 || Math.abs(cross) < 1e-9) {
      radii[i] = FLAT_RADIUS_PX;
      continue;
    }
    radii[i] = Math.min(FLAT_RADIUS_PX, product / (2 * Math.abs(cross)));
  }
  return radii;
}

/**
 * Least-squares slope of log(speed) against log(curvature radius) over
 * samples that are actually moving. A constant-speed trace yields ≈ 0;
 * human traces follow V ∝ R^β with β roughly 0.1–0.6. Samples sitting
 * on the flat-radius ceiling carry no curvature information (synthetic
 * arcs can be perfectly straight there; real paths never are), so they
 * are excluded like missing regressor data rather than allowed to dilute
 * the fit.
 */
export function fitPowerLawExponent(points: TrajectoryPoint[]): number {
  const samples = sampleTimeline(points);
  const radii = curvatureRadii(points);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, s.v);
  if (peak <= 0) return 0;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 1; i < samples.length - 1; i++) {
    const r = radii[i];
    if (r === null || !Number.isFinite(r) || r >= FLAT_RADIUS_PX || r <= 1) continue;
    if (samples[i].v <= peak * BETA_SPEED_FLOOR) continue;
    const lx = Math.log(r);
    const ly = Math.log(samples[i].v);
    n++;
    sx += lx;
    sy += ly;
    sxx += lx * lx;
    sxy += lx * ly;
  }
  if (n < 6) return 0;
  const denominator = n * sxx - sx * sx;
  if (Math.abs(denominator) < 1e-9) return 0;
  return (n * sxy - sx * sy) / denominator;
}

/** Share of moving samples that fall under the pause speed threshold. */
export function pauseRatio(points: TrajectoryPoint[]): number {
  const samples = sampleTimeline(points);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, s.v);
  if (peak <= 0) return 0;
  const threshold = Math.max(PAUSE_ABS_PX_MS, peak * PAUSE_PEAK_SHARE);
  let paused = 0;
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    total++;
    if (samples[i].v < threshold) paused++;
  }
  return total === 0 ? 0 : paused / total;
}

/**
 * Count distinct speed peaks: the main pulse plus correction pulses.
 * Speeds are smoothed over a 3-sample window; local maxima above a
 * fraction of the smoothed peak count separately unless the valley
 * between them stays shallow.
 */
export function countSubmovements(points: TrajectoryPoint[]): number {
  const samples = sampleTimeline(points);
  if (samples.length < 5) return 0;
  const smoothed = samples.map((_, i) => {
    const from = Math.max(0, i - 1);
    const to = Math.min(samples.length - 1, i + 1);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += samples[j].v;
    return sum / (to - from + 1);
  });
  let peak = 0;
  for (const v of smoothed) peak = Math.max(peak, v);
  if (peak <= 0) return 0;
  const threshold = peak * SUBMOVEMENT_PEAK_SHARE;
  const maxima: Array<{ index: number; value: number }> = [];
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (smoothed[i] < threshold) continue;
    if (smoothed[i] >= smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) {
      maxima.push({ index: i, value: smoothed[i] });
    }
  }
  // Merge neighbours that never dive below a shared valley.
  const merged: Array<{ index: number; value: number }> = [];
  for (const candidate of maxima) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(candidate);
      continue;
    }
    let valley = Infinity;
    for (let j = last.index; j <= candidate.index; j++) valley = Math.min(valley, smoothed[j]);
    if (valley > SUBMOVEMENT_VALLEY_SHARE * Math.min(last.value, candidate.value)) {
      if (candidate.value > last.value) merged[merged.length - 1] = candidate;
      continue;
    }
    merged.push(candidate);
  }
  return merged.length;
}

/**
 * Pre-click deceleration channel: peak speed inside the final `windowMs`
 * divided by the global peak speed. Detector stacks flag landings above
 * ~0.25 as "drove into the target at full speed".
 */
export function endDecelerationRatio(points: TrajectoryPoint[], windowMs = 500): number {
  const samples = sampleTimeline(points);
  if (samples.length < 3) return 0;
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, s.v);
  if (peak <= 0) return 0;
  const span = samples[samples.length - 1].t - samples[0].t;
  const window = Math.min(windowMs, span * 0.5);
  const cutoff = samples[samples.length - 1].t - window;
  let localPeak = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t < cutoff) continue;
    localPeak = Math.max(localPeak, samples[i].v);
  }
  return localPeak / peak;
}

/**
 * Variance of the signed along-path acceleration. A naive single-ramp
 * plan keeps this (near) constant — the detector signature — while
 * pulse-plus-correction traces swing acceleration across the move.
 */
export function accelerationVariance(points: TrajectoryPoint[]): number {
  const samples = sampleTimeline(points);
  if (samples.length < 4) return 0;
  const accelerations: number[] = [];
  for (let i = 2; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    const dtPrev = samples[i - 1].t - samples[i - 2].t;
    if (dt <= 0 || dtPrev <= 0) continue;
    accelerations.push((samples[i].v - samples[i - 1].v) / ((dt + dtPrev) / 2));
  }
  if (accelerations.length < 2) return 0;
  const mean = accelerations.reduce((sum, a) => sum + a, 0) / accelerations.length;
  const variance =
    accelerations.reduce((sum, a) => sum + (a - mean) ** 2, 0) / accelerations.length;
  return variance;
}

/** Everything the exam asserts, in one pass. */
export function computeTraceMetrics(points: TrajectoryPoint[]): TraceMetrics {
  return {
    beta: fitPowerLawExponent(points),
    pauseRatio: pauseRatio(points),
    submovementCount: countSubmovements(points),
    endDecelerationRatio: endDecelerationRatio(points),
    accelerationVariance: accelerationVariance(points),
  };
}

/** Statistics over a "locked" window (hesitation or pre-click dwell). */
export interface LockWindowStats {
  /** Per-axis position variance summed over both axes (px²). */
  driftVariance: number;
  /** Mean step length inside the window (px). */
  meanStep: number;
  /** Largest single step inside the window (px) — tremor shows up here. */
  maxStep: number;
  /** Mean speed inside the window (px/ms). */
  meanSpeed: number;
}

/**
 * Summarise a contiguous run of points that should be nearly still.
 * A slow drift fills a small variance budget smoothly; high-frequency
 * tremor would show up as alternating steps and a large `maxStep`.
 */
export function lockWindowStats(
  points: TrajectoryPoint[],
  from: number,
  to: number,
): LockWindowStats {
  const slice = points.slice(from, to + 1);
  if (slice.length < 2) {
    return { driftVariance: 0, meanStep: 0, maxStep: 0, meanSpeed: 0 };
  }
  const n = slice.length;
  const meanX = slice.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = slice.reduce((sum, p) => sum + p.y, 0) / n;
  const driftVariance =
    slice.reduce((sum, p) => sum + (p.x - meanX) ** 2 + (p.y - meanY) ** 2, 0) / n;
  let totalStep = 0;
  let maxStep = 0;
  let totalMs = 0;
  for (let i = 1; i < slice.length; i++) {
    const step = Math.hypot(slice[i].x - slice[i - 1].x, slice[i].y - slice[i - 1].y);
    totalStep += step;
    maxStep = Math.max(maxStep, step);
    totalMs += slice[i - 1].delayMs;
  }
  const steps = n - 1;
  return {
    driftVariance,
    meanStep: totalStep / steps,
    maxStep,
    meanSpeed: totalMs > 0 ? totalStep / totalMs : 0,
  };
}

/** Total planned wall-clock time (sum of per-point sleeps), ms. */
export function plannedDurationMs(points: TrajectoryPoint[]): number {
  return points.reduce((sum, p) => sum + p.delayMs, 0);
}

/** True when the trace lands exactly on `target` (zero tolerance). */
export function endsExactlyAt(points: TrajectoryPoint[], target: Vec2): boolean {
  const last = points[points.length - 1];
  return last !== undefined && last.x === target.x && last.y === target.y;
}
