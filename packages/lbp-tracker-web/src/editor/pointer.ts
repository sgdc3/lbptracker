/**
 * Pointer capture that does not throw.
 *
 * ⚠️ `setPointerCapture` throws `NotFoundError` for a pointer id the browser
 * is not tracking -- a synthetic `PointerEvent` dispatched by a script, and
 * on some browsers a pen or touch that has already lifted. A drag handler
 * that dies on that line leaves the view mid-gesture, so both canvases go
 * through these instead.
 */

export function capture(el: Element, event: PointerEvent): void {
  try {
    el.setPointerCapture(event.pointerId);
  } catch {
    // not a tracked pointer: the gesture still works, just without capture
  }
}

export function release(el: Element, event: PointerEvent): void {
  try {
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  } catch {
    // as above
  }
}
