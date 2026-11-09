import type { PointerEvent as ReactPointerEvent } from "react";

type Lookup<Surface> = { querySelector: (selector: string) => Surface | null };
type Under<Surface> = {
  closest: (selector: string) => { parentElement: Lookup<Surface> | null } | null;
};

/**
 * The chart surface a hover over the zoom (brush) layer should reach, or null to leave the event alone.
 * The chart library clears its tooltip whenever the pointer is over a control, and the brush covers the whole plot.
 */
export const hoverTarget = <Surface>(event: {
  buttons: number;
  target: Under<Surface>;
}): Surface | null => {
  if (event.buttons !== 0) return null;
  const brush = event.target.closest("[data-chart-brush]");
  return brush?.parentElement?.querySelector(":scope > :not([data-chart-brush])") ?? null;
};

/** `onPointerMoveCapture` for a chart with a brush: replays a plain hover on the chart, so the crosshair and tooltip follow the mouse. */
export const hoverThroughBrush = (event: ReactPointerEvent<HTMLElement>): void => {
  if (!(event.target instanceof Element)) return;
  const surface = hoverTarget<Element>({ buttons: event.buttons, target: event.target });
  if (surface === null) return;
  // The original would reach the library with the brush as its target and clear the tooltip again.
  event.stopPropagation();
  surface.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType,
    }),
  );
};
