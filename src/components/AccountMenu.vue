<script setup lang="ts">
// Signed-in account + sign-out. Sign-out is a plain same-origin form POST (the auth
// gate refuses GET and cross-origin POSTs to /auth/logout), so it works without JS
// state and lands on the server's "Signed out" page.
//
// Two renderings of the same account, one shown at a time by CSS (the media query is
// lib/responsive.ts TOPBAR_COMPACT_MAX_WIDTH): the e-mail + "Sign out" form in the header, and — in
// the compact band where the bar would wrap — an account icon opening a small menu with who is
// signed in and "Log out", which posts to the same /auth/logout.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { signedInEmail, loadIdentity } from '../session'
import { UserIcon } from '../lib/icons'

onMounted(loadIdentity)

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const btn = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
}
// Closing from the keyboard or by choosing an item puts focus back on the button; an outside click or
// tabbing away leaves focus wherever the viewer moved it.
function close(refocus: boolean) {
  if (!open.value) return
  open.value = false
  if (refocus) btn.value?.focus()
}
function onDocPointerDown(e: Event) {
  if (open.value && !root.value?.contains(e.target as Node)) close(false)
}
function onDocKeydown(e: KeyboardEvent) {
  if (open.value && e.key === 'Escape') {
    e.preventDefault()
    close(true)
  }
}
function onFocusOut(e: FocusEvent) {
  const to = e.relatedTarget as Node | null
  if (open.value && to && !root.value?.contains(to)) close(false)
}
// The menu stays in the DOM (v-show) so choosing "Log out" can't unmount its form before the browser
// submits it.
watch(open, async (v) => {
  if (!v) return
  await nextTick()
  menu.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
})
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onDocKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onDocKeydown)
})
</script>

<template>
  <div v-if="signedInEmail" class="account-root">
    <form class="account" method="post" action="/auth/logout">
      <span class="account-email mono" :title="`Signed in as ${signedInEmail}`">{{ signedInEmail }}</span>
      <button class="btn" type="submit">Sign out</button>
    </form>
    <div ref="root" class="account-compact" @focusout="onFocusOut">
      <button
        ref="btn"
        type="button"
        class="btn account-btn"
        aria-label="Account menu"
        aria-haspopup="menu"
        :aria-expanded="open"
        aria-controls="account-menu"
        @click="toggle"
      >
        <UserIcon :size="15" aria-hidden="true" />
      </button>
      <div v-show="open" id="account-menu" ref="menu" class="account-menu" role="menu" aria-label="Account">
        <div class="account-menu-who" role="none">
          <span class="account-menu-hint">Signed in as</span>
          <span class="account-menu-email mono">{{ signedInEmail }}</span>
        </div>
        <form method="post" action="/auth/logout" role="none" @submit="close(true)">
          <button class="account-menu-item" type="submit" role="menuitem">Log out</button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account-root {
  display: flex;
  align-items: center;
}
.account {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.account-email {
  font-size: 11px;
  color: rgb(var(--ink-3));
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 600px) {
  .account-email {
    display: none;
  }
}
.account-compact {
  display: none;
  position: relative;
}
.account-btn {
  padding: 7px;
}
.account-btn[aria-expanded='true'] {
  border-color: rgb(var(--amber));
  background: rgb(var(--sunken));
}
.account-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  min-width: 200px;
  max-width: min(320px, calc(100vw - 24px));
  padding: 5px;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 11px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.16);
  font-size: 13px;
  color: rgb(var(--ink));
}
.account-menu-who {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 8px 8px;
  margin-bottom: 4px;
  border-bottom: 1px solid rgb(var(--line));
}
.account-menu-hint {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgb(var(--ink-3));
}
.account-menu-email {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.account-menu form {
  margin: 0;
}
.account-menu-item {
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: rgb(var(--ink));
  padding: 7px 8px;
  border-radius: 7px;
  font-size: 13px;
  cursor: pointer;
}
.account-menu-item:hover,
.account-menu-item:focus-visible {
  background: rgb(var(--amber-tint));
  color: rgb(var(--amber-hover));
  outline: none;
}
/* Compact bar (lib/responsive.ts TOPBAR_COMPACT_MAX_WIDTH): the icon + menu replace the e-mail and
   Sign out. At 700px and below the phone layout keeps the form as it is. */
@media (min-width: 701px) and (max-width: 1000px) {
  .account {
    display: none;
  }
  .account-compact {
    display: block;
  }
}
</style>
