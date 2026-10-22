/**
 * Wire protocol for the on-page visual pointer indicator between the
 * background service worker and its tiny content script.
 *
 * Background → content (fire-and-forget, except `settle`):
 *  - `move`    — the pointer dispatch layer reported a position. Trajectory
 *    points arrive at their natural cadence (30–80 Hz); element-centroid
 *    hops arrive once and carry `tweenMs` so the indicator glides there.
 *  - `press` / `release` — a click pair; the indicator plays a short
 *    squash-and-ring animation at the given point.
 *  - `wheel`   — a wheel gesture; the indicator shows a scroll hint.
 *  - `key`     — keyboard input started; the indicator flashes briefly.
 *  - `settle`  — ask the indicator to confirm it has visually arrived at
 *    (x, y). The caller bounds the wait itself; the ack is best-effort.
 *
 * The indicator only ever renders inside a closed shadow root it mounts on
 * `documentElement`, so page scripts cannot read its internals; the host
 * element itself is inert (`pointer-events: none`, `aria-hidden`).
 */

export const CURSOR_OVERLAY_MSG = "bsk/cursor-overlay";

export type CursorOverlayMessageKind = "move" | "press" | "release" | "wheel" | "key" | "settle";

export interface CursorOverlayMoveMessage {
  type: typeof CURSOR_OVERLAY_MSG;
  kind: "move";
  x: number;
  y: number;
  /** Local glide duration for single-hop moves (element-centroid hovers). */
  tweenMs?: number;
}

export interface CursorOverlayButtonMessage {
  type: typeof CURSOR_OVERLAY_MSG;
  kind: "press" | "release";
  x: number;
  y: number;
  clickCount: number;
}

export interface CursorOverlayWheelMessage {
  type: typeof CURSOR_OVERLAY_MSG;
  kind: "wheel";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

export interface CursorOverlayKeyMessage {
  type: typeof CURSOR_OVERLAY_MSG;
  kind: "key";
}

export interface CursorOverlaySettleMessage {
  type: typeof CURSOR_OVERLAY_MSG;
  kind: "settle";
  x: number;
  y: number;
}

export interface CursorOverlaySettleAck {
  type: typeof CURSOR_OVERLAY_MSG;
  kind: "settle";
  ok: true;
}

export type CursorOverlayMessage =
  | CursorOverlayMoveMessage
  | CursorOverlayButtonMessage
  | CursorOverlayWheelMessage
  | CursorOverlayKeyMessage
  | CursorOverlaySettleMessage;

export function isCursorOverlayMessage(msg: unknown): msg is CursorOverlayMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== CURSOR_OVERLAY_MSG) return false;
  const num = (v: unknown): v is number => typeof v === "number";
  switch (m.kind) {
    case "move":
      return num(m.x) && num(m.y);
    case "press":
    case "release":
      return num(m.x) && num(m.y) && num(m.clickCount);
    case "wheel":
      return num(m.x) && num(m.y) && num(m.deltaX) && num(m.deltaY);
    case "key":
      return true;
    case "settle":
      return num(m.x) && num(m.y);
    default:
      return false;
  }
}
