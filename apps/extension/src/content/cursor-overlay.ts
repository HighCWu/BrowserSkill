/**
 * On-page visual pointer indicator (content-script side).
 *
 * A tiny, inert overlay so a human watching the borrowed tab can follow
 * what the agent's input is doing: the pointer glides to every dispatched
 * position, clicks ripple, scrolling shows a direction hint, typing flashes
 * the cursor. Everything renders inside a *closed* shadow root on a single
 * host element under `documentElement`, so page scripts and a11y walks see
 * one anonymous, `aria-hidden`, `pointer-events: none` node and nothing
 * else.
 *
 * Cleanliness rules this module owns:
 *  - teardown removes every node (host, shadow subtree, stylesheet) — no
 *    residue is left in the page after a session ends or the tab is returned;
 *  - screenshots: the capture-suppress bridge hides the host before a frame
 *    is captured and restores it afterwards;
 *  - `document.hidden` tabs skip rendering entirely;
 *  - `prefers-reduced-motion` disables every animation.
 */

import type { CaptureSuppressPhase } from "@/lib/capture-suppress-bridge";
import {
  CURSOR_OVERLAY_MSG,
  type CursorOverlayMessage,
  type CursorOverlaySettleAck,
  isCursorOverlayMessage,
} from "@/lib/cursor-bridge";
import {
  isOverlayAgentOverlayResetMessage,
  isOverlayAgentStateMessage,
  type OverlayAgentStateMessage,
  OverlayVersionGate,
} from "@/lib/overlay-bridge";

/** One below the 32-bit signed maximum; above any realistic page content. */
const CURSOR_LAYER_Z = 2147483646;
/** Default glide duration for trajectory points arriving back to back. */
const MOVE_TRANSITION_MS = 100;
/** Fallback for the settle ack when no `transitionend` fires (already there). */
const SETTLE_FALLBACK_MS = 220;
/** How long the typing flash stays on. */
const KEY_FLASH_MS = 140;
/** Ring lifetime after a release finishes it off. */
const RING_FADE_MS = 260;
/** Scroll hint lifetime. */
const WHEEL_HINT_MS = 480;
const MOVE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

const ARROW_PATH = "M4 1.5 L4 16.8 L8 13.2 L10.5 19 L13.2 17.8 L10.7 12.1 L16.2 11.7 Z";

const SHADOW_STYLES = `
  :host {
    all: initial;
    display: block;
    position: absolute;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .pv-pointer {
    position: fixed;
    left: 0;
    top: 0;
    width: 20px;
    height: 20px;
    z-index: ${CURSOR_LAYER_Z};
    pointer-events: none;
    transform: translate3d(0, 0, 0);
    transition: transform ${MOVE_TRANSITION_MS}ms ${MOVE_EASING};
    will-change: transform;
  }
  .pv-pointer > svg {
    position: absolute;
    inset: 0;
    transition: opacity 60ms ease;
  }
  .pv-pointer .pv-accent {
    opacity: 0;
    filter: drop-shadow(0 0 4px rgba(96, 150, 255, 0.85));
  }
  .pv-pointer.pv-pressing .pv-accent,
  .pv-pointer.pv-typing .pv-accent { opacity: 1; }
  .pv-pointer.pv-pressing .pv-plain { opacity: 0.25; }
  .pv-pointer.pv-pressing { transform-origin: 2px 2px; }
  .pv-ring {
    position: fixed;
    width: 30px;
    height: 30px;
    margin: -15px 0 0 -15px;
    border: 2px solid rgba(96, 150, 255, 0.9);
    border-radius: 50%;
    z-index: ${CURSOR_LAYER_Z};
    pointer-events: none;
    opacity: 0.9;
    transform: scale(0.3);
    animation: pv-ring-grow 420ms ease-out forwards;
  }
  .pv-ring.pv-ring-done {
    animation: pv-ring-fade ${RING_FADE_MS}ms ease-out forwards;
  }
  @keyframes pv-ring-grow {
    from { opacity: 0.9; transform: scale(0.3); }
    to { opacity: 0.55; transform: scale(1.25); }
  }
  @keyframes pv-ring-fade {
    from { opacity: 0.55; transform: scale(1.25); }
    to { opacity: 0; transform: scale(1.7); }
  }
  .pv-wheel {
    position: fixed;
    width: 18px;
    height: 26px;
    margin: -13px 0 0 -9px;
    z-index: ${CURSOR_LAYER_Z};
    pointer-events: none;
    opacity: 0.85;
    animation: pv-wheel-hint ${WHEEL_HINT_MS}ms ease-out forwards;
  }
  .pv-wheel.pv-wheel-x { width: 26px; height: 18px; margin: -9px 0 0 -13px; }
  @keyframes pv-wheel-hint {
    0% { opacity: 0; }
    25% { opacity: 0.85; }
    100% { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pv-pointer { transition: none; }
    .pv-ring, .pv-wheel { animation: none; opacity: 0; }
  }
`;

function arrowSvg(className: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ARROW_PATH);
  path.setAttribute("stroke", "#ffffff");
  path.setAttribute("stroke-width", "1.1");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("fill", className === "pv-accent" ? "#4f8cff" : "#20242c");
  svg.append(path);
  return svg;
}

/** Roughly how long the pointer's transform transition will run. */
function transitionDurationMs(tweenMs: number | undefined): number {
  return tweenMs && tweenMs > 0 ? tweenMs : MOVE_TRANSITION_MS;
}

export interface CursorOverlayController {
  /** Authoritative agent-state push: mounts, shows, or tears the node down. */
  applyAgentState(state: OverlayAgentStateMessage): void;
  /** Per-tab reset (tab returned to its owner): remove everything. */
  reset(): void;
  /**
   * Handle one cursor message. Returns true when the response will be sent
   * asynchronously (`settle`), false otherwise.
   */
  handleMessage(
    message: CursorOverlayMessage,
    sendResponse: (ack: CursorOverlaySettleAck) => void,
  ): boolean;
  /** Capture-suppress bridge participant: hides for screenshots. */
  applyCaptureSuppress(phase: CaptureSuppressPhase): void;
  /** Whether the indicator nodes are currently in the page (tests). */
  readonly isMounted: boolean;
  /** Remove all nodes and timers; keeps listeners managed by the entrypoint. */
  teardown(): void;
  /** Full teardown plus any timers; called on content-script invalidation. */
  dispose(): void;
}

export function createCursorOverlayController(
  options: { shadowMode?: ShadowRootMode } = {},
): CursorOverlayController {
  // Production uses a closed root (page scripts and observers cannot reach
  // inside); tests open it to assert on the rendered nodes.
  const shadowMode = options.shadowMode ?? "closed";
  const versions = new OverlayVersionGate();
  let host: HTMLDivElement | null = null;
  // Kept from `attachShadow`: for a *closed* root, `host.shadowRoot` reads
  // back as null, so the only way in is this reference.
  let shadow: ShadowRoot | null = null;
  let pointer: HTMLDivElement | null = null;
  let mounted = false;
  let lastStateActive = false;
  let keyFlashTimer: ReturnType<typeof setTimeout> | undefined;
  let captureCount = 0;
  const rings = new Set<HTMLElement>();
  const hints = new Set<HTMLElement>();
  const position = { x: 0, y: 0 };
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensureMounted(): void {
    if (mounted && host?.isConnected) return;
    if (!document.documentElement) return;
    teardown();
    const el = document.createElement("div");
    // Neutral name + per-mount random suffix: nothing stable for a page to
    // fingerprint across visits, nothing meaningful to grep for.
    const suffix = Math.random().toString(36).slice(2, 8);
    el.className = `pvx-${suffix}`;
    el.setAttribute("aria-hidden", "true");
    const shadowRoot = el.attachShadow({ mode: shadowMode });
    const style = document.createElement("style");
    style.textContent = SHADOW_STYLES;
    const cursorEl = document.createElement("div");
    cursorEl.className = "pv-pointer";
    cursorEl.append(arrowSvg("pv-plain"), arrowSvg("pv-accent"));
    shadowRoot.append(style, cursorEl);
    document.documentElement.append(el);
    host = el;
    shadow = shadowRoot;
    pointer = cursorEl;
    mounted = true;
    applyPosition(0);
  }

  function applyPosition(tweenMs?: number): void {
    const el = pointer;
    if (!el || document.hidden) return;
    const ms = transitionDurationMs(tweenMs);
    el.style.transition = `transform ${ms}ms ${MOVE_EASING}`;
    el.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
  }

  function teardown(): void {
    if (keyFlashTimer) {
      clearTimeout(keyFlashTimer);
      keyFlashTimer = undefined;
    }
    for (const node of [...rings, ...hints]) node.remove();
    rings.clear();
    hints.clear();
    host?.remove();
    host = null;
    shadow = null;
    pointer = null;
    mounted = false;
  }

  function spawnRing(x: number, y: number): void {
    if (reducedMotion || document.hidden) return;
    const ring = document.createElement("div");
    ring.className = "pv-ring";
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    ring.addEventListener("animationend", () => finishRing(ring), { once: true });
    shadow?.append(ring);
    rings.add(ring);
  }

  function finishRing(ring: HTMLElement): void {
    ring.classList.add("pv-ring-done");
    window.setTimeout(() => {
      ring.remove();
      rings.delete(ring);
    }, RING_FADE_MS);
  }

  function spawnWheelHint(x: number, y: number, deltaX: number, deltaY: number): void {
    if (reducedMotion || document.hidden) return;
    const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
    const positive = horizontal ? deltaX >= 0 : deltaY >= 0;
    // Two chevrons pointing along the scroll direction.
    const chevrons = positive
      ? horizontal
        ? "M10 4 L16 9 L10 14 M16 4 L22 9 L16 14"
        : "M4 10 L9 16 L14 10 M4 16 L9 22 L14 16"
      : horizontal
        ? "M16 4 L10 9 L16 14 M10 4 L4 9 L10 14"
        : "M14 10 L9 16 L4 10 M14 16 L9 22 L4 16";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", horizontal ? "26" : "18");
    svg.setAttribute("height", horizontal ? "18" : "26");
    svg.setAttribute("viewBox", horizontal ? "0 0 26 18" : "0 0 18 26");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", horizontal ? "pv-wheel pv-wheel-x" : "pv-wheel");
    const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path");
    stroke.setAttribute("d", chevrons);
    stroke.setAttribute("fill", "none");
    stroke.setAttribute("stroke", "#4f8cff");
    stroke.setAttribute("stroke-width", "2");
    stroke.setAttribute("stroke-linecap", "round");
    stroke.setAttribute("stroke-linejoin", "round");
    svg.append(stroke);
    svg.style.left = `${x}px`;
    svg.style.top = `${y}px`;
    svg.addEventListener(
      "animationend",
      () => {
        svg.remove();
        hints.delete(svg);
      },
      { once: true },
    );
    shadow?.append(svg);
    hints.add(svg);
  }

  function flashTyping(): void {
    if (!pointer || reducedMotion) return;
    pointer.classList.add("pv-typing");
    if (keyFlashTimer) clearTimeout(keyFlashTimer);
    keyFlashTimer = window.setTimeout(() => {
      pointer?.classList.remove("pv-typing");
      keyFlashTimer = undefined;
    }, KEY_FLASH_MS);
  }

  return {
    get isMounted() {
      return mounted;
    },

    applyAgentState(state: OverlayAgentStateMessage): void {
      if (!versions.admit(state)) return;
      lastStateActive = state.mode !== "hidden" && state.cursor_overlay === true;
      if (lastStateActive) {
        ensureMounted();
      } else {
        teardown();
      }
    },

    reset(): void {
      lastStateActive = false;
      teardown();
    },

    handleMessage(message, sendResponse) {
      if (!mounted || !pointer) {
        // No indicator here: ack settles immediately so callers never wait
        // on a tab that cannot show anything.
        if (message.kind === "settle") {
          sendResponse({ type: message.type, kind: "settle", ok: true });
          return false;
        }
        return false;
      }
      switch (message.kind) {
        case "move":
          position.x = message.x;
          position.y = message.y;
          applyPosition(message.tweenMs);
          return false;
        case "press":
          position.x = message.x;
          position.y = message.y;
          applyPosition(0);
          pointer.classList.add("pv-pressing");
          spawnRing(message.x, message.y);
          return false;
        case "release":
          pointer.classList.remove("pv-pressing");
          for (const ring of rings) finishRing(ring);
          return false;
        case "wheel":
          spawnWheelHint(message.x, message.y, message.deltaX, message.deltaY);
          return false;
        case "key":
          flashTyping();
          return false;
        case "settle": {
          position.x = message.x;
          position.y = message.y;
          applyPosition();
          const el = pointer;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            el.removeEventListener("transitionend", finish);
            sendResponse({ type: CURSOR_OVERLAY_MSG, kind: "settle", ok: true });
          };
          el.addEventListener("transitionend", finish, { once: true });
          window.setTimeout(finish, SETTLE_FALLBACK_MS);
          return true;
        }
        default:
          return false;
      }
    },

    applyCaptureSuppress(phase: CaptureSuppressPhase): void {
      if (!host) return;
      if (phase === "begin") {
        captureCount += 1;
        host.style.display = "none";
        return;
      }
      captureCount = Math.max(0, captureCount - 1);
      if (captureCount === 0) host.style.removeProperty("display");
    },

    teardown,

    dispose(): void {
      reset();
    },
  };
}
