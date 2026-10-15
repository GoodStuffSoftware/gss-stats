import { ref, watchEffect, type Directive } from 'vue'

// View-only access (README "Auth → View-only access"). The server decides who is a viewer and
// refuses every write a viewer sends (functions/_lib/auth.ts); this is only the UI side of it.
// GET /auth/me says `role: "viewer"` (src/session.ts loadIdentity sets `viewOnly`), and then:
//   - every edit control carries `v-edit`, which shows it greyed out and inert, with the
//     tooltip "View-only access" (disabled, not hidden: the viewer sees what the owner sees);
//   - App.vue never saves the layout, and its edit handlers do nothing (a backstop for any
//     control without `v-edit`);
//   - the grid can't be dragged or resized.
// The owner (role "owner", or no answer at all) is unaffected.

export const VIEW_ONLY_TITLE = 'View-only access'

/** True once GET /auth/me has said this account is a viewer. */
export const viewOnly = ref(false)

const VIEW_ONLY_CLASS = 'view-only-disabled'
const stops = new WeakMap<HTMLElement, () => void>()

function apply(el: HTMLElement, on: boolean): void {
  if (on) {
    if (!el.classList.contains(VIEW_ONLY_CLASS)) {
      el.dataset.viewOnlyTitle = el.getAttribute('title') ?? ''
      el.classList.add(VIEW_ONLY_CLASS)
    }
    el.setAttribute('disabled', '')
    el.setAttribute('aria-disabled', 'true')
    el.setAttribute('title', VIEW_ONLY_TITLE)
  } else if (el.classList.contains(VIEW_ONLY_CLASS)) {
    el.classList.remove(VIEW_ONLY_CLASS)
    el.removeAttribute('disabled')
    el.removeAttribute('aria-disabled')
    const title = el.dataset.viewOnlyTitle
    if (title) el.setAttribute('title', title)
    else el.removeAttribute('title')
    delete el.dataset.viewOnlyTitle
  }
}

/** `v-edit` on an edit control: disabled with the "View-only access" tooltip for a viewer.
 *  Re-applied after every patch, so a component's own `:disabled` binding can't re-enable it. */
export const vEdit: Directive<HTMLElement> = {
  mounted(el) {
    stops.set(el, watchEffect(() => apply(el, viewOnly.value)))
  },
  updated(el) {
    apply(el, viewOnly.value)
  },
  unmounted(el) {
    stops.get(el)?.()
    stops.delete(el)
  },
}
