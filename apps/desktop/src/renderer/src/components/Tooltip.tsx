import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "../tooltip-place.js";
import { elementOf, listenEverywhere, windowOf } from "../windows.js";

/** Hover this long before the tooltip shows. */
const SHOW_DELAY_MS = 500;
/** For this long after a tooltip hides, the next one shows at once: moving along a toolbar reads every button. */
const WARM_MS = 400;
/** A focus this soon after a press came from the pointer, not the keyboard: it shows no tooltip. */
const PRESS_FOCUS_MS = 100;
/** How often a shown tooltip checks that its control is still in the page. */
const POLL_MS = 250;
const TOOLTIP_ID = "frameshell-tooltip";

interface Shown {
  anchor: HTMLElement;
  text: string;
  shortcut: string | undefined;
  view: Window;
}

const read = (anchor: HTMLElement, view: Window): Shown | null => {
  const text = anchor.dataset["tip"];
  return text ? { anchor, text, shortcut: anchor.dataset["tipKey"] || undefined, view } : null;
};

/**
 * The app's one tooltip; mount once, in the project window. Any element with
 * `data-tip="what it does"` (and optionally `data-tip-key="⌘L"`, from
 * `shortcutLabel`) gets it: after a short hover, or at once on keyboard focus.
 * Escape, a press, scroll or leaving hide it. It listens on every project
 * window and draws in the control's own window (ADR 0012).
 */
export function TooltipHost() {
  const [tip, setTip] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    /** The control whose tooltip shows or waits to show, and how it was reached. */
    let anchor: HTMLElement | null = null;
    let via: "hover" | "focus" = "hover";
    let shown = false;
    let hiddenAt = 0;
    let pressedAt = 0;
    /** Pressed or escaped: hovering it shows nothing until the pointer leaves it. */
    let dismissed: HTMLElement | null = null;
    let timer: { view: Window; id: number } | null = null;
    let poll: { view: Window; id: number } | null = null;
    let observer: MutationObserver | null = null;
    /** The control's own `aria-describedby`, put back when the tooltip hides. */
    let describedBy: string | null = null;

    const hide = () => {
      if (timer) timer.view.clearTimeout(timer.id);
      if (poll) poll.view.clearInterval(poll.id);
      timer = poll = null;
      observer?.disconnect();
      observer = null;
      if (anchor && shown) {
        if (describedBy === null) anchor.removeAttribute("aria-describedby");
        else anchor.setAttribute("aria-describedby", describedBy);
        hiddenAt = Date.now();
      }
      anchor = null;
      shown = false;
      setTip(null);
    };

    const show = () => {
      timer = null;
      const element = anchor;
      if (!element) return;
      const view = windowOf(element);
      const next = read(element, view);
      if (!next || !element.isConnected) return hide();
      shown = true;
      describedBy = element.getAttribute("aria-describedby");
      // A tip that repeats the control's name would be read twice.
      if (next.text !== element.getAttribute("aria-label")) element.setAttribute("aria-describedby", TOOLTIP_ID);
      setTip(next);
      // A changed tip (Play becomes Pause) shows at once; the observer comes from the control's window.
      const watch = new (view as typeof window).MutationObserver(() => {
        const changed = read(element, view);
        if (changed) setTip(changed);
        else hide();
      });
      observer = watch;
      watch.observe(element, { attributes: true, attributeFilter: ["data-tip", "data-tip-key"] });
      poll = { view, id: view.setInterval(() => !element.isConnected && hide(), POLL_MS) };
    };

    const arm = (element: HTMLElement, how: "hover" | "focus") => {
      if (element === anchor) {
        if (how === "focus") via = "focus";
        return;
      }
      hide();
      anchor = element;
      via = how;
      if (how === "focus" || Date.now() - hiddenAt < WARM_MS) return show();
      const view = windowOf(element);
      timer = { view, id: view.setTimeout(show, SHOW_DELAY_MS) };
    };

    const tipOf = (target: EventTarget | null) => elementOf(target)?.closest<HTMLElement>("[data-tip]") ?? null;

    const offs = [
      listenEverywhere("pointerover", (event) => {
        const element = tipOf(event.target);
        if (element !== dismissed) dismissed = null;
        if (element && element !== dismissed) arm(element, "hover");
        else if (anchor && via === "hover" && element !== anchor) hide();
      }),
      listenEverywhere("pointerout", (event) => {
        if (!event.relatedTarget && via === "hover") hide();
      }),
      listenEverywhere("focusin", (event) => {
        const element = tipOf(event.target);
        if (element && Date.now() - pressedAt > PRESS_FOCUS_MS) arm(element, "focus");
      }),
      listenEverywhere("focusout", () => {
        if (via === "focus") hide();
      }),
      listenEverywhere(
        "pointerdown",
        (event) => {
          pressedAt = Date.now();
          dismissed = tipOf(event.target);
          hide();
        },
        true,
      ),
      listenEverywhere(
        "keydown",
        (event) => {
          if (event.key !== "Escape" || !anchor) return;
          dismissed = anchor;
          hide();
        },
        true,
      ),
      listenEverywhere("wheel", hide, true),
      listenEverywhere("scroll", hide, true),
      listenEverywhere("blur", hide),
    ];
    return () => {
      for (const off of offs) off();
      hide();
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !box.current) return setPlace(null);
    const size = box.current.getBoundingClientRect();
    const placed = placeTooltip(tip.anchor.getBoundingClientRect(), size, { width: tip.view.innerWidth, height: tip.view.innerHeight });
    setPlace({ left: placed.left, top: placed.top });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={box}
      id={TOOLTIP_ID}
      role="tooltip"
      className="tooltip"
      data-testid="tooltip"
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      <span>{tip.text}</span>
      {tip.shortcut && <kbd>{tip.shortcut}</kbd>}
    </div>,
    tip.view.document.body,
  );
}
