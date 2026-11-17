/**
 * Position helpers for the draggable on-page overlay.
 *
 * The overlay is anchored with `top` / `right` offsets (px from the viewport's
 * top and right edges) so the collapsed side tab can always slide back to the
 * right edge while keeping the vertical position the user picked.
 */

export interface OverlayPosition {
  top: number;
  right: number;
}

export interface OverlayBounds {
  viewportWidth: number;
  viewportHeight: number;
  /** Rendered width of the card. */
  width: number;
  /** Rendered height of whatever must stay on screen (card or tab). */
  height: number;
  /** Extra space the side tab sticks out to the left of the card. */
  tabWidth: number;
}

export const DEFAULT_OVERLAY_POSITION: OverlayPosition = { top: 86, right: 18 };

/** Minimum gap kept between the overlay and the viewport edges. */
export const OVERLAY_EDGE_GAP = 8;

/** Pointer travel (px) before a press on the tab turns into a drag. */
export const DRAG_THRESHOLD = 4;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export const normalizeOverlayPosition = (value: unknown): OverlayPosition | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { top, right } = value as Record<string, unknown>;
  if (typeof top !== 'number' || typeof right !== 'number') {
    return null;
  }
  if (!Number.isFinite(top) || !Number.isFinite(right)) {
    return null;
  }
  return { top, right };
};

/** Keep the overlay fully reachable inside the current viewport. */
export const clampOverlayPosition = (
  position: OverlayPosition,
  bounds: OverlayBounds,
): OverlayPosition => ({
  top: clampNumber(
    position.top,
    OVERLAY_EDGE_GAP,
    bounds.viewportHeight - bounds.height - OVERLAY_EDGE_GAP,
  ),
  right: clampNumber(
    position.right,
    OVERLAY_EDGE_GAP,
    bounds.viewportWidth - bounds.width - bounds.tabWidth - OVERLAY_EDGE_GAP,
  ),
});
