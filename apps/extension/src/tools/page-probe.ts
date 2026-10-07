// Page-world element probe for en-route hover inspection.
//
// During a v2 trajectory the planner samples a few path points and asks
// the page what sits under each: if the cursor is about to cross an
// interactive element (or anything advertising a tooltip), the hand may
// pause over it — the way a person slows down to read a control before
// clicking it. The mechanism mirrors the existing overlay hit-test:
// one-shot `Runtime.evaluate` calls against the page's main world, no
// domain enabling, no persistent bindings.

import type { CdpRunner } from "./shared";
import type { BehaviorProbeHit } from "./trajectory-behavior";

/** Probe result as returned from the page world. */
interface RawProbeResult {
  /** Element box, or null when nothing interactive is under the point. */
  box: { x: number; y: number; width: number; height: number } | null;
  tooltipish: boolean;
}

/**
 * Page-world body: resolves the element stack at (x, y), walks a few
 * ancestors of the top candidates, and reports the first box that looks
 * interactive (widget semantics, editable, scripted click target,
 * focusable) or tooltip-bearing (title / described-by family).
 */
function probeInteractiveAtPointJs(x: number, y: number): RawProbeResult {
  const INTERACTIVE =
    "a,button,input,select,textarea,label,summary,option,optgroup," +
    "[contenteditable],[onclick],[tabindex]," +
    "[role=button],[role=link],[role=tab],[role=menuitem],[role=option]," +
    "[role=checkbox],[role=radio],[role=switch],[role=slider],[role=combobox]," +
    "[role=textbox],[role=searchbox],[role=menuitemcheckbox],[role=menuitemradio]";
  const TOOLTIPISH = "[title],[aria-label],[aria-describedby],[data-tooltip],[data-tip]";
  const at = (el: Element, selector: string): boolean => {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  };
  const stack =
    typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(x, y)
      : (() => {
          const top = document.elementFromPoint(x, y);
          return top ? [top] : [];
        })();
  for (const el of stack.slice(0, 4)) {
    if (!(el instanceof Element)) continue;
    let node: Element | null = el;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const interactive = at(node, INTERACTIVE);
      const tooltipish = at(node, TOOLTIPISH);
      if (!interactive && !tooltipish) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      return {
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        tooltipish,
      };
    }
  }
  return { box: null, tooltipish: false };
}

/**
 * Ask the page what sits under a viewport point. Returns null when the
 * tab is gone, the call fails, or nothing interactive is there —
 * probing must never break a move.
 */
export async function probeInteractiveAt(
  cdp: CdpRunner,
  tabId: number,
  x: number,
  y: number,
): Promise<BehaviorProbeHit | null> {
  try {
    const response = await cdp.send<{
      result?: { value?: RawProbeResult | null };
    }>(tabId, "Runtime.evaluate", {
      expression: `(${probeInteractiveAtPointJs.toString()})(${x},${y})`,
      returnByValue: true,
    });
    const value = response.result?.value;
    if (!value?.box) return null;
    if (![value.box.x, value.box.y, value.box.width, value.box.height].every(Number.isFinite)) {
      return null;
    }
    return { box: value.box, tooltipish: value.tooltipish === true };
  } catch (err) {
    console.debug("[bsk trajectory] interactive probe failed", err);
    return null;
  }
}
