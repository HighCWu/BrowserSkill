/**
 * Visual pointer indicator content script.
 *
 * Deliberately separate from the React control overlay: this one must be
 * trivially cheap, always listening, and independent of the overlay UI's
 * lifecycle.
 *
 * The mount decision needs two independent facts, which arrive through
 * independent channels and may land in either order:
 *  - the tab's control mode — via `OVERLAY_AGENT_STATE` pushes and the
 *    synchronous response to an `overlay.ready` request;
 *  - the daemon's handshake verdict — persisted in `chrome.storage.session`
 *    by the background (survives SW restarts), read here and kept fresh via
 *    `storage.onChanged`.
 *
 * Nothing renders until both say "on", and every node is removed as soon as
 * either says "off".
 */

import { createCursorOverlayController } from "@/content/cursor-overlay";
import {
  CAPTURE_SUPPRESS,
  type CaptureSuppressMessage,
  isCaptureSuppressMessage,
} from "@/lib/capture-suppress-bridge";
import { type CursorOverlaySettleAck, isCursorOverlayMessage } from "@/lib/cursor-bridge";
import { CURSOR_OVERLAY_VERDICT_KEY, readCursorOverlayVerdict } from "@/lib/cursor-verdict";
import {
  isOverlayAgentOverlayResetMessage,
  isOverlayAgentStateMessage,
  OVERLAY_MSG_READY,
  type OverlayAgentOverlayResetMessage,
  type OverlayAgentStateMessage,
} from "@/lib/overlay-bridge";

// Top-level frames only: CDP input coordinates are main-frame viewport
// coordinates, and one indicator per tab is exactly right.
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: false,

  main(ctx) {
    if (window.top !== window) return;

    const controller = createCursorOverlayController();

    const onMessage = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: CursorOverlaySettleAck) => void,
    ): boolean => {
      if (isCursorOverlayMessage(message)) {
        // Tool traffic on an unmounted tab proves a live session here: if a
        // state push was lost (SW restart window), re-sync once instead of
        // staying dark until the next tab event. Throttled; input timing is
        // untouched (fire-and-forget).
        if (!controller.isMounted) {
          const kind = (message as CursorOverlayMessage).kind;
          if (kind !== "settle") requestStateThrottled();
        }
        return controller.handleMessage(message, sendResponse);
      }
      if (isCaptureSuppressMessage(message)) {
        // Hide silently; the control overlay's content script owns the ack
        // (it waits for the compositor frame there). Both hosts are hidden
        // synchronously here.
        controller.applyCaptureSuppress((message as CaptureSuppressMessage).phase);
        return false;
      }
      if (isOverlayAgentStateMessage(message)) {
        controller.applyAgentState(message as OverlayAgentStateMessage);
        return false;
      }
      if (isOverlayAgentOverlayResetMessage(message)) {
        controller.reset();
        return false;
      }
      return false;
    };

    /**
     * Ask the background for the current control state. The handler responds
     * synchronously with the state for this tab, so no push can be missed;
     * the duplicate delivery (response + push) is idempotent through the
     * version gate.
     */
    const requestState = (): void => {
      void chrome.runtime
        .sendMessage({ kind: OVERLAY_MSG_READY })
        .then((state) => {
          if (state && isOverlayAgentStateMessage(state)) {
            controller.applyAgentState(state as OverlayAgentStateMessage);
          }
        })
        .catch(() => {
          // Background unavailable (restricted page, shutdown). Nothing to show.
        });
    };

    let lastResyncAt = 0;
    const RESYNC_THROTTLE_MS = 2_000;
    const requestStateThrottled = (): void => {
      const now = Date.now();
      if (now - lastResyncAt < RESYNC_THROTTLE_MS) return;
      lastResyncAt = now;
      requestState();
    };

    // Daemon verdict: persisted by the background at every handshake, so it
    // is available before (and independent of) any runtime message.
    void readCursorOverlayVerdict().then((enabled) => controller.setVerdict(enabled));
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "session" || !(CURSOR_OVERLAY_VERDICT_KEY in changes)) return;
      controller.setVerdict(changes[CURSOR_OVERLAY_VERDICT_KEY].newValue === true);
    };

    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        // BFCache restore: beforeunload removed the nodes; re-read both
        // halves of the decision (the verdict may have changed while dormant).
        void readCursorOverlayVerdict().then((enabled) => controller.setVerdict(enabled));
        requestState();
      }
    };

    const onBeforeUnload = (): void => {
      // Leave no residue in the page — including the stylesheet. BFCache
      // restores re-read the decision above.
      controller.reset();
    };

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("beforeunload", onBeforeUnload);
    requestState();

    // Extension updated/reloaded: drop every node and listener. (Page
    // navigation kills the context anyway; this covers in-place invalidation.)
    ctx.onInvalidated(() => {
      controller.dispose();
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("beforeunload", onBeforeUnload);
    });
  },
});
