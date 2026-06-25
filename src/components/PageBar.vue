<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import type { DashboardPage } from '../types'

defineProps<{ pages: DashboardPage[]; activePageId: string }>()
const emit = defineEmits<{
  switch: [string]
  add: []
  rename: [string, string]
  duplicate: [string]
  delete: [string]
  restore: [string]
}>()

const menuFor = ref<string | null>(null)
function toggleMenu(id: string) {
  menuFor.value = menuFor.value === id ? null : id
}
function close() {
  menuFor.value = null
}
onMounted(() => document.addEventListener('click', close))
onBeforeUnmount(() => document.removeEventListener('click', close))

function rename(p: DashboardPage) {
  const name = window.prompt('Rename page', p.name)
  if (name && name.trim()) emit('rename', p.id, name.trim())
  close()
}
</script>

<template>
  <div class="page-bar">
    <div class="tabs">
      <div
        v-for="p in pages"
        :key="p.id"
        :class="['tab', { active: p.id === activePageId }]"
        @click="emit('switch', p.id)"
      >
        <span v-if="p.isDefault" class="badge" title="Default page">★</span>
        <span class="tab-name">{{ p.name }}</span>
        <button v-if="p.id === activePageId" class="caret" title="Page options" @click.stop="toggleMenu(p.id)">▾</button>
        <div v-if="menuFor === p.id" class="pmenu" @click.stop>
          <button @click="rename(p)">Rename</button>
          <button @click="emit('duplicate', p.id); close()">Duplicate</button>
          <button @click="emit('restore', p.id); close()">Restore default charts</button>
          <button v-if="!p.isDefault" class="danger" @click="emit('delete', p.id); close()">Delete page</button>
        </div>
      </div>
    </div>
    <button class="add-page" title="New page (duplicates the current one)" @click="emit('add')">＋ Page</button>
  </div>
</template>

<style scoped>
.page-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px 7px 12px;
  border: 1px solid rgb(var(--line));
  border-radius: 10px;
  background: rgb(var(--surface));
  color: rgb(var(--ink-2));
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}
.tab:hover {
  border-color: rgb(var(--line-2));
}
.tab.active {
  border-color: rgb(var(--amber));
  background: rgb(var(--amber-tint));
  color: rgb(var(--ink));
}
.badge {
  color: rgb(var(--amber));
  font-size: 11px;
}
.tab-name {
  white-space: nowrap;
}
.caret {
  border: none;
  background: transparent;
  color: rgb(var(--ink-3));
  font-size: 11px;
  padding: 0 2px;
  margin-left: 2px;
}
.caret:hover {
  color: rgb(var(--ink));
}
.pmenu {
  position: absolute;
  left: 0;
  top: 100%;
  margin-top: 5px;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 10px;
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.16);
  padding: 4px;
  z-index: 40;
  min-width: 168px;
  display: flex;
  flex-direction: column;
}
.pmenu button {
  text-align: left;
  border: none;
  background: transparent;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: rgb(var(--ink));
}
.pmenu button:hover {
  background: rgb(var(--sunken));
}
.pmenu button.danger {
  color: #bc4749;
}
.add-page {
  border: 1px dashed rgb(var(--line-2));
  background: transparent;
  color: rgb(var(--ink-2));
  border-radius: 10px;
  padding: 7px 12px;
  font-size: 13px;
  font-weight: 500;
}
.add-page:hover {
  border-color: rgb(var(--amber));
  color: rgb(var(--amber-hover));
}
</style>
