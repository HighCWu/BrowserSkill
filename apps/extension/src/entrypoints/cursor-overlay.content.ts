/**
 * Visual pointer indicator content script.
 *
 * Deliberately separate from the React control overlay: this one must be
 * trivially cheap, always listening, and independent of the overlay UI's
 * lifecycle. It renders nothing until the background pushes an agent state
 * that carries `cursor_overlay` (the daemon handshake verdict) with an
 * active control mode, and it removes every node as soon as that stops
 * being true.
 */

import { createCursorOverlayController } from "@/content/cursor-overlay";
import {
  CAPTURE_SUPPRESS,
  type CaptureSuppressMessage,
  isCaptureSuppressMessage,
} from "@/lib/capture-suppress-bridge";
import { type CursorOverlaySettleAck, isCursorOverlayMessage } from "@/lib/cursor-bridge";
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

    // Ask for the current agent state so a tab the agent already controls
    // (or one restored from BFCache) mounts or clears the indicator without
    // waiting for the next push.
    const requestState = (): void => {
      void chrome.runtime.sendMessage({ kind: OVERLAY_MSG_READY }).catch(() => {
        // Background unavailable (restricted page, shutdown). Nothing to show.
      });
    };

    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        // BFCache restore: beforeunload removed the nodes; state will be
        // re-pushed for the (persisted) document.
        requestState();
      }
    };

    const onBeforeUnload = (): void => {
      // Leave no residue in the page — including the stylesheet. BFCache
      // restores re-request state above.
      controller.reset();
    };

    chrome.runtime.onMessage.addListener(onMessage);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("beforeunload", onBeforeUnload);
    requestState();

    // Extension updated/reloaded: drop every node and listener. (Page
    // navigation kills the context anyway; this covers in-place invalidation.)
    ctx.onInvalidated(() => {
      controller.dispose();
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("beforeunload", onBeforeUnload);
    });
  },
});
