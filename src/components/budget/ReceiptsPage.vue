<script setup lang="ts">
// The Budget section's Receipts page, top part (docs/adr/0007-budget-section.md; plan section 8): connect the signed-in
// person's Gmail for receipts, show the connection and the last run, "Check now", and disconnect. Shared pieces only:
// `.btn` buttons and the shared ModalPanel (ADR 0005). One /api/budget/email/status call on mount and after each action
// (lib/budget/receiptsClient.ts); the page never shows a Gmail message id.
//
// States: loading / failed (Retry); not configured (one calm line, no button); not connected (the consent card);
// connected (address for the person who connected, last run and counts, Check now, Disconnect). Any run or connection
// error code shows in plain words (receiptsRunMessage) and dims the dot; the codes that need the connection made again
// (RECONNECT_CODES) also swap Check now for a Reconnect button.
//
// The connect callback redirects to `?section=budget&b_page=receipts&email=<code>`: its message shows once, then
// `email` is removed from the URL with history.replaceState.
//
// The review list (ReceiptsReview) is mounted below the status card, only while connected.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatCents } from '../../lib/budget/money'
import { prepareReceiptImage, ReceiptImageError } from '../../lib/budget/receiptImage'
import {
  disconnectReceipts,
  fetchReceipts,
  fetchReceiptsStatus,
  fetchUpload,
  uploadReceiptImage,
  type ReceiptRow,
  receiptsMessage,
  receiptsRunMessage,
  ReceiptsApiError,
  RECONNECT_CODES,
  startReceiptsConnect,
  syncReceiptsNow,
  type ReceiptsRun,
  type ReceiptsStatus,
} from '../../lib/budget/receiptsClient'
import { receiptText } from '../../lib/budget/tableModel'
import type { Category } from '../../lib/budget/types'
import ModalPanel from '../ui/ModalPanel.vue'
import ReceiptsReview from './ReceiptsReview.vue'

/** The Budget categories, as BudgetSection already holds them; the review list picks from them. */
withDefaults(defineProps<{ categories?: Category[] }>(), { categories: () => [] })

const status = ref<ReceiptsStatus | null>(null)
const loading = ref(true)
const failed = ref(false)
const agreed = ref(false)
const busy = ref<'connect' | 'sync' | 'disconnect' | null>(null)
const notice = ref<{ text: string; tone: 'ok' | 'bad' } | null>(null)
const modalOpen = ref(false)
const purge = ref(false)
const disconnectBtn = ref<HTMLElement | null>(null)

/** The consent text, version 1 (plan section 8; Mike 2026-11-23 added the sharing sentence). */
const CONSENT_LINES = [
  'Read-only access to receipt emails; nothing is sent, deleted or changed.',
  'Receipts you connect are also shown to the other Budget person.',
]

/** Without Gmail, the list still shows when this person has photo receipts: one look at each tab, once per load. */
const hasUploads = ref(false)
async function probeUploads() {
  try {
    const pages = await Promise.all((['suggested', 'unmatched', 'applied'] as const).map((s) => fetchReceipts({ status: s })))
    if (pages.some((p) => p.receipts.some((r) => r.source === 'upload'))) hasUploads.value = true
  } catch {
    // the list is optional here; the photo card still works
  }
}
const showReview = computed(() => isConnected.value || hasUploads.value)

async function load() {
  loading.value = true
  failed.value = false
  try {
    status.value = await fetchReceiptsStatus()
    if (status.value.configured && !(status.value.connection && status.value.connection.status !== 'revoked')) void probeUploads()
  } catch {
    status.value = null
    failed.value = true
  } finally {
    loading.value = false
  }
}

/** Shows the callback's code once, then drops `email` from the address bar (other parameters stay). */
function takeCallbackCode() {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('email')
  if (code === null) return
  notice.value = { text: receiptsMessage(code), tone: code === 'connected' ? 'ok' : 'bad' }
  url.searchParams.delete('email')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

onMounted(() => {
  takeCallbackCode()
  void load()
})

// ---- Receipt photos ----
/** One photo at a time: pick, re-encode on the device, send, then poll the upload every 2 s for up to 40 s. */
const POLL_MS = 2000
const POLL_MAX_MS = 40_000
type PhotoPhase = 'idle' | 'sending' | 'reading' | 'slow' | 'done' | 'error'
const photo = ref<{ phase: PhotoPhase; text: string; row: ReceiptRow | null }>({ phase: 'idle', text: '', row: null })
const takeInput = ref<HTMLInputElement | null>(null)
const chooseInput = ref<HTMLInputElement | null>(null)
const reviewKey = ref(0)
const photoBusy = computed(() => photo.value.phase === 'sending' || photo.value.phase === 'reading')
let pollTimer: ReturnType<typeof setTimeout> | null = null
let photoRun = 0

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}
onBeforeUnmount(() => {
  photoRun++
  stopPolling()
})

const DONE_TEXT: Record<string, string> = {
  suggested: 'Read. A matching bank row was found.',
  unmatched: 'Read. No matching bank row yet; it will be matched when the transaction arrives.',
  no_total: 'Read, but no total was found on that photo.',
  applied: 'Read and already applied.',
  dismissed: 'Read, and it was dismissed.',
  skipped: 'That photo was skipped; it does not look like a receipt.',
}
const photoFacts = computed(() => {
  const r = photo.value.row
  if (!r) return []
  const out: { label: string; value: string }[] = []
  const store = receiptText(r.merchant, 60)
  if (store) out.push({ label: 'Store', value: store })
  const d = receiptText(r.receiptDate ?? r.emailDate, 40)
  if (d) out.push({ label: 'Date', value: d })
  if (r.totalCents !== null && r.totalCents !== undefined) out.push({ label: 'Total', value: formatCents(r.totalCents) })
  if (r.items?.length) out.push({ label: 'Items', value: String(r.items.length) })
  return out
})
const photoSuggestion = computed(() => {
  const r = photo.value.row
  const m = r?.matches?.length ? [...r.matches].sort((a, b) => b.score - a.score)[0] : null
  if (!r || !m) return ''
  return `Suggested: ${m.txn.postedDate} ${formatCents(m.txn.amountCents)} ${receiptText(m.txn.merchantName, 60)}. Apply it in the list below.`.replace(/\s+/g, ' ')
})

function photoFailed(e: unknown) {
  photo.value = {
    phase: 'error',
    text: e instanceof ReceiptImageError || e instanceof ReceiptsApiError ? e.message : 'Something went wrong. Please try again.',
    row: null,
  }
}

function finishPhoto(s: { status: string; row?: ReceiptRow }) {
  if (s.status === 'error') {
    photo.value = { phase: 'error', text: 'That receipt could not be read. Try a clearer photo.', row: null }
    return
  }
  photo.value = { phase: 'done', text: DONE_TEXT[s.status] ?? 'Read.', row: s.row ?? null }
  hasUploads.value = true
  reviewKey.value++
}

function poll(id: string, run: number, startedAt: number) {
  pollTimer = setTimeout(async () => {
    pollTimer = null
    if (run !== photoRun) return
    try {
      const s = await fetchUpload(id)
      if (run !== photoRun) return
      if (s.status !== 'pending') return finishPhoto(s)
    } catch (e) {
      if (run !== photoRun) return
      return photoFailed(e)
    }
    if (Date.now() - startedAt >= POLL_MAX_MS) {
      photo.value = { phase: 'slow', text: '', row: null }
      return
    }
    poll(id, run, startedAt)
  }, POLL_MS)
}

async function onPicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || photoBusy.value) return
  const run = ++photoRun
  stopPolling()
  photo.value = { phase: 'sending', text: '', row: null }
  try {
    const jpeg = await prepareReceiptImage(file)
    const r = await uploadReceiptImage(jpeg)
    if (run !== photoRun) return
    if (r.duplicate && !r.id) {
      photo.value = { phase: 'done', text: 'That photo was already added.', row: null }
      return
    }
    photo.value = { phase: 'reading', text: '', row: null }
    poll(r.id!, run, Date.now())
  } catch (e) {
    if (run === photoRun) photoFailed(e)
  }
}

const connection = computed(() => status.value?.connection ?? null)
const lastRun = computed<ReceiptsRun | null>(() => status.value?.lastRuns[0] ?? null)
/** The error code to show: the connection's, else the newest run's. `run_busy` is not a failure. */
const problemCode = computed<string | null>(() => {
  for (const c of [connection.value?.lastError, lastRun.value?.errorCode]) if (c && c !== 'run_busy') return c
  return null
})
const needsReconnect = computed(() => connection.value?.status === 'needs_reconnect' || (!!problemCode.value && RECONNECT_CODES.has(problemCode.value)))
const isConnected = computed(() => !!connection.value && connection.value.status !== 'revoked')
/** The line under the status: the reconnect words, the code's words, or the plain paused line for a paused connection with no code. */
const problemText = computed(() => {
  if (needsReconnect.value) return receiptsRunMessage('needs_reconnect')
  if (problemCode.value) return receiptsRunMessage(problemCode.value)
  return connection.value && connection.value.status !== 'active' ? receiptsRunMessage('paused') : ''
})
/** The green dot is only for a connection that is active and whose last check did not fail. */
const healthy = computed(() => !!connection.value && connection.value.status === 'active' && !problemCode.value)
/** Shown to the person who connected only (the server leaves it out for anyone else), drawn through receiptText. */
const connectedAs = computed(() => receiptText(connection.value?.googleEmail, 120))

function when(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const lastRunLine = computed(() => {
  const r = lastRun.value
  if (!r) return connection.value?.lastRunAt ? `Last check ${when(connection.value.lastRunAt)}.` : 'No check has run yet. The first one runs within the hour.'
  if (!r.finishedAt) return `Check started ${when(r.startedAt)}, still running.`
  if (r.errorCode && r.errorCode !== 'run_busy') return `Last check ${when(r.startedAt)} stopped before it finished.`
  return `Last check ${when(r.startedAt)}: ${r.fetched} emails read, ${r.extracted} receipts found, ${r.matched} matched.`
})

function errText(e: unknown): string {
  if (e instanceof ReceiptsApiError) {
    if (e.code === 'rate_limited' && e.retryAfterSec) return `${e.message} Try again in about ${Math.max(1, Math.ceil(e.retryAfterSec / 60))} min.`
    return e.message
  }
  return 'Something went wrong. Please try again.'
}

async function connect() {
  if (busy.value) return
  busy.value = 'connect'
  notice.value = null
  try {
    const { url } = await startReceiptsConnect()
    // Only Google's own consent address; anything else from the server is not followed.
    if (typeof url !== 'string' || !url.startsWith('https://accounts.google.com/')) throw new ReceiptsApiError(502, 'receipts_failed')
    window.location.assign(url)
  } catch (e) {
    notice.value = { text: errText(e), tone: 'bad' }
    busy.value = null
  }
}

async function checkNow() {
  if (busy.value) return
  busy.value = 'sync'
  notice.value = null
  try {
    await syncReceiptsNow()
    notice.value = { text: 'Checking now. New receipts show up here in a minute or two.', tone: 'ok' }
    await load()
  } catch (e) {
    notice.value = { text: errText(e), tone: 'bad' }
  } finally {
    busy.value = null
  }
}

function openDisconnect() {
  purge.value = false
  modalOpen.value = true
}
async function disconnect() {
  if (busy.value) return
  busy.value = 'disconnect'
  try {
    const r = await disconnectReceipts(purge.value)
    modalOpen.value = false
    notice.value = {
      text: `Disconnected${r.purged ? ' and the extracted receipts were deleted' : ''}.${r.revoked ? '' : " If this app still shows in your Google account's third-party access, remove it there."}`,
      tone: 'ok',
    }
    await load()
  } catch (e) {
    modalOpen.value = false
    notice.value = { text: errText(e), tone: 'bad' }
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="receipts-page" data-testid="receipts-page">
    <h2 class="rp-h2">Receipts</h2>
    <p v-if="notice" class="rp-notice" :class="`rp-${notice.tone}`" role="status" data-testid="receipts-notice">{{ notice.text }}</p>

    <p v-if="loading && !status" class="rp-muted" data-testid="receipts-loading">Loading…</p>
    <div v-else-if="failed" class="rp-row" data-testid="receipts-failed">
      <span class="rp-muted">Receipts could not be loaded.</span>
      <button type="button" class="btn rp-btn" data-testid="receipts-retry" @click="load">Retry</button>
    </div>

    <p v-else-if="status && !status.configured" class="rp-muted" data-testid="receipts-not-configured">Receipts aren't set up yet.</p>

    <template v-else-if="status">
    <!-- Receipt photos work with or without Gmail: this card shows in every configured state. -->
    <section class="card rp-card" data-testid="receipts-photo">
      <p class="rp-lead">Add a receipt photo</p>
      <p class="rp-muted">Take a photo of a paper receipt, or choose one from your phone. It is read and matched like an email receipt.</p>
      <div class="rp-row">
        <button type="button" class="btn btn-primary rp-btn" :disabled="photoBusy" data-testid="receipts-take-btn" @click="takeInput?.click()">Take photo</button>
        <button type="button" class="btn rp-btn" :disabled="photoBusy" data-testid="receipts-choose-btn" @click="chooseInput?.click()">Choose image</button>
        <input ref="takeInput" type="file" accept="image/*" capture="environment" class="rp-file" tabindex="-1" aria-hidden="true" data-testid="receipts-take" @change="onPicked" />
        <input ref="chooseInput" type="file" accept="image/*" class="rp-file" tabindex="-1" aria-hidden="true" data-testid="receipts-choose" @change="onPicked" />
      </div>
      <p v-if="photo.phase === 'sending'" class="rp-muted" role="status" data-testid="receipts-photo-sending">Sending the photo…</p>
      <p v-else-if="photo.phase === 'reading'" class="rp-muted" role="status" data-testid="receipts-photo-reading">Reading the receipt…</p>
      <p v-else-if="photo.phase === 'slow'" class="rp-muted" role="status" data-testid="receipts-photo-slow">Still reading; it will show in the list within the hour</p>
      <p v-else-if="photo.phase === 'error'" class="rp-bad-text" role="alert" data-testid="receipts-photo-error">{{ photo.text }}</p>
      <div v-else-if="photo.phase === 'done'" role="status" data-testid="receipts-photo-done">
        <p class="rp-lead">{{ photo.text }}</p>
        <dl v-if="photoFacts.length" class="rp-facts">
          <template v-for="f in photoFacts" :key="f.label"><dt>{{ f.label }}</dt><dd>{{ f.value }}</dd></template>
        </dl>
        <p v-if="photoSuggestion" class="rp-muted" data-testid="receipts-photo-suggestion">{{ photoSuggestion }}</p>
      </div>
    </section>

    <section v-if="!isConnected" class="card rp-card" data-testid="receipts-consent">
      <p class="rp-lead">{{ CONSENT_LINES[0] }}</p>
      <p>
        Connect your Gmail so Budget can find receipts and match them to your bank purchases. With your permission this site reads emails
        that look like receipts, once an hour.
      </p>
      <p>
        It keeps only the extracted facts (store, date, total, tax, order number, items, last four digits of the card) and the email's Gmail
        id, so you can open it in Gmail. It never stores the email itself. To read each receipt, its text is sent to Anthropic's Claude API,
        which does not train on it; it is used for nothing else.
      </p>
      <p data-testid="receipts-share-line">{{ CONSENT_LINES[1] }}</p>
      <p>
        You can disconnect at any time, which revokes access and can delete what was extracted. Google shows an "unverified app" warning:
        choose Advanced, then continue. This app's use and transfer of information received from Google APIs adheres to the Google API
        Services User Data Policy, including the Limited Use requirements.
      </p>
      <label class="rp-agree"><input v-model="agreed" type="checkbox" data-testid="receipts-agree" /> I agree</label>
      <div class="rp-row">
        <button type="button" class="btn btn-primary rp-btn" :disabled="!agreed || busy === 'connect'" data-testid="receipts-connect" @click="connect">
          {{ busy === 'connect' ? 'Opening Google…' : 'Connect your email' }}
        </button>
      </div>
    </section>

    <template v-else-if="connection">
      <section class="card rp-card" data-testid="receipts-status">
        <p class="rp-lead" data-testid="receipts-conn-line">
          <span class="rp-dot" :class="{ off: !healthy }" aria-hidden="true"></span>
          <template v-if="connectedAs">Connected as {{ connectedAs }}</template>
          <template v-else>Gmail connected</template>
        </p>
        <p class="rp-muted" data-testid="receipts-last-run">{{ lastRunLine }}</p>
        <p v-if="problemText" class="rp-bad-text" :data-testid="needsReconnect ? 'receipts-reconnect-note' : 'receipts-paused'">{{ problemText }}</p>
        <div class="rp-row">
          <button v-if="needsReconnect" type="button" class="btn btn-primary rp-btn" :disabled="!!busy" data-testid="receipts-reconnect" @click="connect">Reconnect</button>
          <button v-else type="button" class="btn rp-btn" :disabled="!!busy" data-testid="receipts-check" @click="checkNow">
            {{ busy === 'sync' ? 'Checking…' : 'Check now' }}
          </button>
          <button ref="disconnectBtn" type="button" class="btn btn-ghost rp-btn" :disabled="!!busy" data-testid="receipts-disconnect" @click="openDisconnect">Disconnect</button>
        </div>
      </section>
    </template>
    <!-- The list shows Gmail receipts and photo receipts; it mounts once the page is set up, and reloads when a photo is read. -->
    <ReceiptsReview v-if="showReview" :key="reviewKey" :categories="categories" />
    </template>

    <ModalPanel :open="modalOpen" title="Disconnect Gmail?" title-id="rp-dc-title" described-by="rp-dc-desc" :return-to="disconnectBtn" initial-focus="input:checked" @close="modalOpen = false">
      <p id="rp-dc-desc" class="rp-muted">Budget stops reading your email and Google access is revoked. Choose what happens to the receipts already extracted.</p>
      <div class="rp-choices" role="radiogroup" aria-label="Extracted receipts">
        <label class="rp-choice"><input v-model="purge" type="radio" name="rp-purge" :value="false" data-testid="receipts-keep" /> Keep the receipts</label>
        <label class="rp-choice"><input v-model="purge" type="radio" name="rp-purge" :value="true" data-testid="receipts-purge" /> Delete the receipts</label>
      </div>
      <template #actions>
        <button type="button" class="btn rp-btn" @click="modalOpen = false">Cancel</button>
        <button type="button" class="btn btn-primary rp-btn" :disabled="busy === 'disconnect'" data-testid="receipts-disconnect-confirm" @click="disconnect">Disconnect</button>
      </template>
    </ModalPanel>
  </div>
</template>

<style scoped>
.receipts-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.rp-h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.rp-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  font-size: 13px;
}
.rp-card p {
  margin: 0;
}
.rp-lead {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.rp-muted {
  margin: 0;
  color: rgb(var(--ink-2));
  font-size: 13px;
}
.rp-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.rp-btn {
  min-height: 36px;
}
.rp-file {
  display: none;
}
.rp-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1px 8px;
  margin: 4px 0 0;
}
.rp-facts dt {
  color: rgb(var(--ink-2));
}
.rp-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.rp-agree {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}
/* The tick box and the radios are 24px with a 6px margin: a 36px tap area, and the whole label row taps too. */
.rp-agree input,
.rp-choice input {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  margin: 6px;
  accent-color: rgb(var(--amber));
}
.rp-notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 13px;
  border: 1px solid rgb(var(--line-2));
}
.rp-bad {
  border-color: rgb(var(--amber));
}
.rp-bad-text {
  color: rgb(var(--amber-hover));
  font-weight: 500;
}
.rp-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  background: rgb(var(--amber));
}
.rp-dot.off {
  background: rgb(var(--ink-2));
}
.rp-choices {
  display: flex;
  flex-direction: column;
}
.rp-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}
</style>
