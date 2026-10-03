// One definition of "mobile" for the whole app. The dashboard stacks its cards, and the
// drill-down menu renders as a bottom sheet, below this width — keep the CSS media queries
// (@media (max-width: 700px)) in step with it.
export const MOBILE_MAX_WIDTH = 700

// The header bar's compact band: just above the phone layout (MOBILE_MAX_WIDTH) and up to this width
// the bar would wrap onto a second row (it needs ~855px with the full search box and the e-mail +
// Sign out form, ~985px with a "Save failed" label and a classic scrollbar), so the account becomes
// an icon menu (AccountMenu.vue) and the search box its icon (App.vue).
export const TOPBAR_COMPACT_MAX_WIDTH = 1000

// The band as a media query, written as the exact complement of the phone layout's
// `(max-width: 700px)` — `width > 700px` takes over where that stops, so a fractional width such as
// 700.4px (browser zoom, a scaled display) is in one or the other, never neither. AccountMenu.vue
// listens on it; its stylesheet carries the same text (CSS can't import this), pinned by
// AccountMenu.test.ts.
export const TOPBAR_COMPACT_QUERY = `(width > ${MOBILE_MAX_WIDTH}px) and (width <= ${TOPBAR_COMPACT_MAX_WIDTH}px)`

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
