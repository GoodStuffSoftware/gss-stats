<script setup lang="ts">
// Signed-in account + sign-out. Sign-out is a plain same-origin form POST (the auth
// gate refuses GET and cross-origin POSTs to /auth/logout), so it works without JS
// state and lands on the server's "Signed out" page.
import { onMounted } from 'vue'
import { signedInEmail, loadIdentity } from '../session'

onMounted(loadIdentity)
</script>

<template>
  <form v-if="signedInEmail" class="account" method="post" action="/auth/logout">
    <span class="account-email mono" :title="`Signed in as ${signedInEmail}`">{{ signedInEmail }}</span>
    <button class="btn" type="submit">Sign out</button>
  </form>
</template>

<style scoped>
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
</style>
