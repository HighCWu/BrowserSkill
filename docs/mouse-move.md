# Humanised mouse movement

`mouse-move` glides the pointer along a curved, timed path instead of
teleporting it in a single event. Use it when pointer motion itself matters:
hover-intent menus, drag affordances, pages that score input timing, or any
flow that should look like a hand driving the mouse.

| Entry point | Name |
| --- | --- |
| CLI | `bsk mouse-move` |
| Wire protocol | `tool.mouse_move` |

The same engine is available on element tools through a `glide` switch:
`bsk hover @e3 --glide` and `bsk click @e3 --glide` approach the element along
a humanised path instead of snapping to it. Without `--glide` their behaviour
is unchanged.

## Two planning regimes

**Default — v2 behaviour state machine.** With every knob left at its default
the move is planned as a sequence of intents rather than one eased arc:

- **PLAN → MOVE_MAIN**: a main pulse covers 85–95% of the distance along a
  curved path, timed by a Fitts law draw
  `MT = (80 + 90·log2(D/W + 1)) × lognormal(1, 0.22)` clamped to
  40–1400 ms. Inside the pulse the velocity follows a minimum-jerk profile
  weighted down where the path curves harder (the 2/3 power law), and a
  small mid-reach micro-correction — a lateral nudge with a matching speed
  dip — keeps the motion from reading as a single flawless easing.
- **HESITATE** (distance > 80 px, ~12% chance): 3–6 near-stationary
  micro-moves of 40–130 ms at 35–65% of the path, drifting 1–2 px — slow
  wander, never high-frequency tremble.
- **HOVER_INSPECT** (en-route, up to three page probes per move, ~25%
  trigger): when a sampled path point falls inside an interactive element's
  box padded by 8–16 px, the pointer steers into the element, pauses
  lognormal(500 ms) clamped to 300–1500 ms (extended once for tooltip
  bearing elements), then resumes. Probing uses the existing page-world
  evaluate channel (`elementFromPoint` plus interactive/tooltip semantics);
  a failing probe never breaks the move.
- **CORRECT** (arrival, 0–3 pulses): short corrective pulses eat the
  remaining error, 60–220 ms each, ease-out.
- **RETHINK** (~3–5% chance on longer moves): walk out 45–70% of the way,
  retreat, then commit again.
- **DWELL before clicks** (`click --glide` only): the approach brakes into
  the landing — the brake is scaled to cover the detector's final-window
  channel, so the last 500 ms stays far below the peak speed — followed by
  a settle pause and a landing point scattered 6–12 px off the element
  centre (only when the element is comfortably larger than the scatter;
  small controls keep their exact action point, and the click is pressed at
  the scattered landing, which is what the result reports).
- Cascade cap: at most three mid-flight insertions per move, at most one
  rethink.

Event-level details: inter-point delays cluster around the pointer sampling
interval with jitter and occasional doubled frames (never a fixed cadence),
coordinates stay sub-pixel, mostly-vertical moves run slightly asymmetrically
up vs down, and positional noise is correlated drift rather than white
tremble.

**Explicit knobs — v1 deterministic single segment.** Passing `--steps`,
`--duration-ms`, or `--curve linear` plans one deterministic Bézier (or
straight) segment with an ease-in-out envelope and an optional
overshoot-and-correct tail, exactly as before — for callers who want a
reproducible, fully specified path. `--overshoot off` under the default v2
regime disables the overshoot branch there.

## Usage

```sh
bsk mouse-move --x 800 --y 400 --session abcd
bsk mouse-move --x 800 --y 400 --from-x 100 --from-y 90 --session abcd
bsk mouse-move --x 800 --y 400 --duration-ms 700 --steps 48 --session abcd
bsk mouse-move --x 800 --y 400 --overshoot on --curve linear --session abcd --json
```

`--x`/`--y` are required and interpreted as top-level viewport CSS pixels,
validated against the layout viewport like `hover --x/--y`. Out-of-range
points fail with `invalid_params` before any input is dispatched.

`--from-x`/`--from-y` must be given together. When omitted, the move starts
from the pointer's last dispatched position on that tab — recorded by
`mouse-move`, `hover`, and `click` — or from the viewport centre when
nothing is tracked yet.

Tuning flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--duration-ms` | v2: Fitts draw 40–1400 ms; v1: adaptive 350–950 ms | Passing it selects the v1 regime and pins the duration |
| `--steps` | v2: derived from the budget; v1: `duration / 12`, clamped 12–80 | Passing it selects the v1 regime |
| `--curve` | `bezier` | `linear` selects the v1 regime; `bezier` keeps v2 when everything else is default |
| `--overshoot` | random (v2: ~20% past 120 px; v1: ~12%) | `on`/`off` force the branch in either regime |
| `--jitter` | on | Positional noise (v2 noise is correlated drift, not white) |
| `--tab-id`, `--timeout` | active tab, 30s | Same semantics as other tools |

`hover --glide` / `click --glide` always use the v2 state machine; clicks get
the pre-click brake and landing scatter, hovers get the en-route inspection.

## Trajectory model (v1 regime)

- **Path**: a cubic Bézier through two random control anchors placed at ⅓
  and ⅔ along the start–end line, each offset perpendicular to it by a
  random 5–25% of the travel distance, sharing one random side so the path
  reads as a single arc. `linear` skips the anchors.
- **Speed envelope**: an ease-in-out curve — slow departure, faster
  middle, slow landing — sampled across the Bézier parameter.
- **Noise**: intermediate points carry ±0.5 px jitter. The final point is
  always exactly the destination (and the overshoot correction lands
  exactly on target), so downstream clicks hit what was aimed at.
- **Timing**: each point is dispatched as a real `Input.dispatchMouseEvent`
  `mouseMoved` followed by a genuine sleep of a few milliseconds — never a
  zero-delay burst. Per-point sleeps are jittered ±20% around
  `duration / points` and clamped to 4–64 ms, keeping the total within
  roughly ±20% of `--duration-ms`.

These are heuristics for naturalness, not guarantees: pages see trusted
input events whose pacing approximates a hand, not an exact replay.

## Input and result contract

The move is transient input: it dispatches real trusted `mouseMoved` events
and can trigger hover UI, but commits nothing by itself. Like `hover`, the
control overlay's input blocker is bypassed while the trajectory runs and
restored afterwards.

Example result:

```json
{
  "tab_id": 42,
  "from_x": 640,
  "from_y": 360,
  "x": 800,
  "y": 400,
  "steps": 42,
  "duration_ms": 613,
  "overshoot": false,
  "curve": "bezier"
}
```

`from_x/from_y` echo the start actually used; `x/y` are the final dispatch
point (equal to the requested destination; a glided click reports its
scattered landing instead); `steps` counts dispatched `mouseMoved` events;
`duration_ms` is the planned sum of per-point sleeps. The optional
`dialogs` array reports dialogs handled during the call.

## Protocol

```json
{
  "id": "mouse-move-1",
  "method": "tool.mouse_move",
  "params": {
    "session_id": "abcd",
    "to_x": 800,
    "to_y": 400,
    "duration_ms": 700,
    "steps": 48,
    "curve": "bezier",
    "overshoot": false,
    "jitter": true,
    "timeout_ms": 5000
  }
}
```

Only `session_id`, `to_x` and `to_y` are required; every knob is optional
and the wire schema is unchanged by the v2 work. See the generated
[parameter schema](../crates/bsk-protocol/schema/tool_mouse_move_params.json)
and [result schema](../crates/bsk-protocol/schema/tool_mouse_move_result.json).

## Errors and interruption

Invalid input (non-finite or out-of-viewport endpoints, partial `from_*`
pairs, out-of-range `duration_ms`/`steps`) returns `invalid_params` before
any CDP traffic. Cancellation and deadlines are checked between trajectory
points: an aborted call stops dispatching and reports `cancelled` /
`timeout`, leaving the pointer wherever the last completed point put it.

## Tests

The planner ships with a built-in exam (`trajectory-metrics.ts` +
`trajectory-metrics.test.ts`): detector-side statistics — the power-law
speed/curvature exponent β, pause ratio, submovement count, pre-click
deceleration ratio, acceleration variance, and locked-window drift — are
computed over seeded batches of short/medium/long moves and held inside the
human envelopes reported by the kitsune Balabit analysis and the
motion-attestation channels. `trajectory-behavior.test.ts` covers the state
machine itself (segment caps, budget rules, landing scatter, probe
behaviour); `trajectory.test.ts` keeps the v1 regime under seeded-RNG math
tests.

```sh
cd apps/extension && pnpm vitest run src/tools/__tests__/trajectory.test.ts \
  src/tools/__tests__/trajectory-behavior.test.ts \
  src/tools/__tests__/trajectory-metrics.test.ts \
  src/tools/__tests__/mouse-move.test.ts
```
