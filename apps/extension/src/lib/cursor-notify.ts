/**
 * Background-side notifier for the on-page visual pointer indicator.
 *
 * Input tools call these methods right where they dispatch real CDP input;
 * the notifier translates them into fire-and-forget messages for the tiny
 * content script that renders the indicator. When the daemon disabled the
 * overlay (`BSK_CURSOR_OVERLAY=off`) every method degrades to a no-op, so
 * disabled runs behave byte-for-byte like runs without the feature — no
 * messages, no waits, no timing change.
 */

import {
  CURSOR_OVERLAY_MSG,
  type CursorOverlayMessage,
  type CursorOverlaySettleAck,
} from "./cursor-bridge";

/** Upper bound for the one short landing wait after a trajectory's final point. */
export const LANDING_SETTLE_BUDGET_MS = 150;

/** Single-hop (element-centroid) moves glide locally for this long. */
export const TELEPORT_TWEEN_MS = 180;

export interface CursorVisualNotifier {
  /** Pointer position update. Trajectory points omit `tweenMs`. */
  move(tabId: number, x: number, y: number, options?: { tweenMs?: number }): void;
  press(tabId: number, x: number, y: number, clickCount: number): void;
  release(tabId: number, x: number, y: number, clickCount: number): void;
  wheel(tabId: number, x: number, y: number, deltaX: number, deltaY: number): void;
  key(tabId: number): void;
  /**
   * One bounded wait for the indicator to visually reach (x, y). Resolves
   * immediately when the overlay is disabled or the tab has no indicator;
   * never exceeds `budgetMs`.
   */
  settle(tabId: number, x: number, y: number, budgetMs?: number): Promise<void>;
}

let overlayEnabled = false;

/** Apply the daemon handshake verdict (idempotent). Returns true on change. */
export function setCursorOverlayEnabled(enabled: boolean): boolean {
  if (overlayEnabled === enabled) return false;
  overlayEnabled = enabled;
  return true;
}

export function isCursorOverlayEnabled(): boolean {
  return overlayEnabled;
}

/** Minimal `chrome.tabs.sendMessage` surface so tests can inject a fake. */
export type CursorSendToTab = (tabId: number, message: CursorOverlayMessage) => Promise<unknown>;

const defaultSendToTab: CursorSendToTab = (tabId, message) =>
  chrome.tabs.sendMessage(tabId, message);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Production notifier. `move`/`press`/`release`/`wheel`/`key` never await —
 * a lost or missing receiver (restricted page, indicator not mounted) is
 * swallowed; the visual layer is strictly best-effort. `settle` waits for
 * the indicator's ack but races it against `budgetMs`, so a tab without the
 * indicator only pays the budget when the overlay is enabled — and zero
 * when it is not.
 */
export function createCursorNotifier(sendToTab: CursorSendToTab = defaultSendToTab): {
  notifier: CursorVisualNotifier;
} {
  const send = (tabId: number, message: CursorOverlayMessage): void => {
    if (!overlayEnabled) return;
    void sendToTab(tabId, message).catch(() => {
      // No indicator in this tab (restricted page, not yet mounted). Visual
      // feedback is optional; the input itself already happened.
    });
  };
  return {
    notifier: {
      move(tabId, x, y, options) {
        send(tabId, {
          type: CURSOR_OVERLAY_MSG,
          kind: "move",
          x,
          y,
          ...(options?.tweenMs ? { tweenMs: options.tweenMs } : {}),
        });
      },
      press(tabId, x, y, clickCount) {
        send(tabId, { type: CURSOR_OVERLAY_MSG, kind: "press", x, y, clickCount });
      },
      release(tabId, x, y, clickCount) {
        send(tabId, { type: CURSOR_OVERLAY_MSG, kind: "release", x, y, clickCount });
      },
      wheel(tabId, x, y, deltaX, deltaY) {
        send(tabId, { type: CURSOR_OVERLAY_MSG, kind: "wheel", x, y, deltaX, deltaY });
      },
      key(tabId) {
        send(tabId, { type: CURSOR_OVERLAY_MSG, kind: "key" });
      },
      async settle(tabId, x, y, budgetMs = LANDING_SETTLE_BUDGET_MS) {
        if (!overlayEnabled) return;
        await Promise.race([
          sendToTab(tabId, { type: CURSOR_OVERLAY_MSG, kind: "settle", x, y })
            .then((ack) => {
              const confirmed = ack as CursorOverlaySettleAck | undefined;
              return confirmed?.kind === "settle";
            })
            .catch(() => false),
          sleep(budgetMs).then(() => false),
        ]);
      },
    },
  };
}

/**
 * Shared background instance. Tools receive it through their deps objects;
 * tests construct their own notifier instead.
 */
const shared = createCursorNotifier();
export const cursorNotifier: CursorVisualNotifier = shared.notifier;

/** Always-off notifier for tests and overlay-disabled constructions. */
export const noopCursorNotifier: CursorVisualNotifier = {
  move() {},
  press() {},
  release() {},
  wheel() {},
  key() {},
  async settle() {},
};
