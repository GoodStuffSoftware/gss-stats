// One definition of "mobile" for the whole app. The dashboard stacks its cards, and the
// drill-down menu renders as a bottom sheet, below this width — keep the CSS media queries
// (@media (max-width: 700px)) in step with it.
export const MOBILE_MAX_WIDTH = 700

export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX_WIDTH
}

// Touch CAPABILITY, not viewport width — a wide screen can still be a touchscreen (e.g. an
// unfolded Pixel Fold is >700px, so isMobileViewport() is false, but it's still a phone).
// Dashboard.vue uses this to keep grid-layout-plus's drag/resize off touch devices regardless
// of width: on Android, grid-layout-plus applies `touch-action: none` to the WHOLE grid item
// (title + body + canvas — see its injected `.vgl-item--no-touch` rule) whenever the item is
// draggable or resizable, which silently kills page scroll anywhere on that card. Disabling
// drag/resize keeps that class from ever being applied, restoring normal scroll — see
// Dashboard.vue for the full reasoning.
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
}
