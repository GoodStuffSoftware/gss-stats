<script setup lang="ts">
// Topbar entry to the Budget section (before AccountMenu). It asks GET /api/budget/access once per page
// load (clientRead.probeAccess: no retry, no poll) and renders NOTHING unless the answer is 200, so an
// account that is not on the Budget list sees no trace of it (one 403 in its network log).
// Props: `active` (the section is open). Emits: `open` (open the section), `close` (it is open and the
// link was used again). A plain click is handled in place; a modified click or middle click follows the
// href like any link.
import { onMounted, ref } from 'vue'
import { probeAccess } from '../../lib/budget/clientRead'
import { searchWithSection } from '../../lib/budget/sectionLink'

defineProps<{ active?: boolean }>()
const emit = defineEmits<{ open: []; close: [] }>()

const allowed = ref(false)
onMounted(async () => {
  allowed.value = (await probeAccess()).state === 'ok'
})

function href(active: boolean): string {
  const loc = globalThis.location
  return loc.pathname + searchWithSection(loc.search, !active) + loc.hash
}
function onClick(e: MouseEvent, active: boolean) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  if (active) emit('close')
  else emit('open')
}
</script>

<template>
  <a
    v-if="allowed"
    class="btn budget-nav-link"
    :class="{ active }"
    :href="href(!!active)"
    :aria-current="active ? 'page' : undefined"
    data-testid="budget-nav-link"
    @click="onClick($event, !!active)"
  >Budget</a>
</template>

<style scoped>
.budget-nav-link {
  text-decoration: none;
  min-height: 32px;
}
.budget-nav-link.active {
  border-color: rgb(var(--amber));
  background: rgb(var(--amber-tint));
}
</style>
