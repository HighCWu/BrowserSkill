# Humanised mouse movement

`mouse-move` glides the pointer along a curved, timed path instead of
teleporting it in a single event. Use it when pointer motion itself matters:
hover-intent menus, drag affordances, pages that score input timing, or any
flow that should look like a hand driving the mouse.

| Entry point | Name |
| --- | --- |
| CLI | `bsk mouse-move` |
| Wire protocol | `tool.mouse_move` |

The same trajectory engine is available on element tools through a `glide`
switch: `bsk hover @e3 --glide` and `bsk click @e3 --glide` approach the
element along a humanised path instead of snapping to it. Without `--glide`
their behaviour is unchanged.

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
| `--duration-ms` | adaptive 350–950 ms by travel distance | Approximate wall-clock duration |
| `--steps` | `duration / 12`, clamped to 12–80 | Dispatched move points (incl. destination) |
| `--curve` | `bezier` | `bezier` arc or `linear` straight line |
| `--overshoot` | random, ~12% chance | Pass the target by 2–8% of the distance, then correct back in 1–3 steps |
| `--tab-id`, `--timeout` | active tab, 30s | Same semantics as other tools |

## Trajectory model

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
  `duration / points` and clamped to 4–64 ms, which keeps defaults in the
  ~8–16 ms band and the total within roughly ±20% of `--duration-ms`.

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
point (equal to the requested destination); `steps` counts dispatched
`mouseMoved` events including overshoot correction; `duration_ms` is the
planned sum of per-point sleeps. The optional `dialogs` array reports
dialogs handled during the call.

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

Only `session_id`, `to_x` and `to_y` are required. `jitter` defaults to
true. See the generated [parameter schema](../crates/bsk-protocol/schema/tool_mouse_move_params.json)
and [result schema](../crates/bsk-protocol/schema/tool_mouse_move_result.json).

## Errors and interruption

Invalid input (non-finite or out-of-viewport endpoints, partial `from_*`
pairs, out-of-range `duration_ms`/`steps`) returns `invalid_params` before
any CDP traffic. Cancellation and deadlines are checked between trajectory
points: an aborted call stops dispatching and reports `cancelled` /
`timeout`, leaving the pointer wherever the last completed point put it.

## Tests

Trajectory math is unit-tested against a seeded RNG: point counts,
monotonic approach, zero endpoint tolerance, overshoot projection bounds,
per-point delay bounds and total-duration tolerance, plus dispatch
ordering, abort semantics and real inter-point sleeps.

```sh
cd apps/extension && pnpm vitest run src/tools/__tests__/trajectory.test.ts src/tools/__tests__/mouse-move.test.ts
```
