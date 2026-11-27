<script setup lang="ts">
// The Budget section's Banks page (bank-links plan section 6; ADR 0005 and 0007: a code-defined page built from the shared
// pieces only: `.card`, `.btn`, ModalPanel, SegmentedControl, EditableTable). One GET status on mount and after every
// action (lib/budget/banksClient.ts); Plaid Link comes from lib/budget/plaidLink.ts and its script loads only when a link
// is started. Everything the page shows about a bank is a name, a last 4, a type and a balance: no Plaid id, token or
// cursor ever reaches it. Owner-only buttons (Reconnect, Unlink, Share new accounts, the account switches) are shown to
// the owner only; the server enforces the same rule.
//
// States: loading / failed (Retry) / not configured (one calm line) / the page: slot counter, consent card (until this
// person has linked a bank of their own), Link a bank, one card per bank with its accounts table, and the rows the bank removed.
import { computed, onMounted, reactive, ref } from 'vue'
import {
  banksMessage,
  BanksApiError,
  createLinkToken,
  exchangeLink,
  fetchBanksStatus,
  markReconnected,
  refreshAccounts,
  requestSync,
  resolveDropped,
  setBankAccount,
  unlinkItem,
  type LinkResult,
} from '../../lib/budget/banksClient'
import { openLink, readLink, resumeLink, takeOAuthReturn } from '../../lib/budget/plaidLink'
import { formatCents } from '../../lib/budget/money'
import type { Account, AccountKind, BankAccountView, BankDroppedRow, BankItemView, BanksStatus } from '../../lib/budget/types'
import ModalPanel from '../ui/ModalPanel.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import EditableTable, { type EditableColumn, type RowStatus, type SelectOption } from '../table/EditableTable.vue'

const props = withDefaults(defineProps<{ accounts?: Account[] }>(), { accounts: () => [] })
const emit = defineEmits<{ 'account-added': [account: Account] }>()

const status = ref<BanksStatus | null>(null)
const loading = ref(true)
const failed = ref(false)
const agreed = ref(false)
const busy = ref(false)
const notice = ref<{ text: string; tone: 'ok' | 'bad' } | null>(null)
const linkModal = ref(false)
const unlinkTarget = ref<BankItemView | null>(null)
const linkBtn = ref<HTMLElement | null>(null)
/** The Budget account picked for a bank account that is not syncing yet ('__new' = make one). */
const choice = reactive<Record<string, string>>({})
const rowState = reactive<Record<string, { pending?: boolean; error?: string }>>({})
const droppedBusy = reactive<Record<string, boolean>>({})

const NEW_ACCOUNT = '__new'
const LIVE = ['active', 'needs_reconnect', 'pending_disconnect']
const STATUS_WORDS: Record<string, string> = {
  active: 'Connected',
  needs_reconnect: 'Needs reconnect',
  pending_disconnect: 'Disconnecting soon',
  revoked: 'Access revoked',
}
/** Budget account kinds a bank account type may feed (the server's rule, so the picker only offers what it accepts). */
const FITS: Record<string, AccountKind[]> = { depository: ['checking', 'savings'], credit: ['card', 'line_of_credit'], loan: ['loan'] }

async function load() {
  failed.value = false
  try {
    status.value = await fetchBanksStatus()
  } catch {
    status.value = null
    failed.value = true
  } finally {
    loading.value = false
  }
}

function errText(e: unknown): string {
  if (e instanceof BanksApiError) return e.message
  if (e instanceof Error && e.message === 'link_unavailable') return 'Plaid Link could not load. Check your connection or content blocker, then try again.'
  return 'Something went wrong. Please try again.'
}
const fail = (e: unknown) => {
  notice.value = { text: errText(e), tone: 'bad' }
}

// ── Link ──────────────────────────────────────────────────────────────────────────────────────────────────────
const left = computed(() => status.value?.slots.left ?? 0)
const limit = computed(() => status.value?.slots.limit ?? 10)
const used = computed(() => status.value?.slots.used ?? 0)
const items = computed(() => status.value?.items ?? [])
/** The consent card shows to each person until they have a bank of their own, so each person's consent time is real. */
const noLinksYet = computed(() => !items.value.some((i) => i.mine))
const warn = computed(() => left.value <= 3)
const slotsLine = computed(() => `${used.value} of ${limit.value} bank links used`)
const slotsExtra = computed(() => (left.value === 0 ? `All ${limit.value} are used. More need a paid Plaid plan.` : warn.value ? `Only ${left.value} left.` : ''))
const canLink = computed(() => !!status.value?.linkEnabled && !busy.value && (!noLinksYet.value || agreed.value))

/** A new Link finished: hand the public token to the server, then show the new bank. */
async function onNewLinked(r: LinkResult | null) {
  try {
    if (!r) throw new BanksApiError(400, 'bad_request')
    await exchangeLink(r)
    notice.value = { text: 'Bank linked. Choose which Budget account each bank account feeds below.', tone: 'ok' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
    await load()
  }
}
/** An update-mode Link finished (Reconnect, or Share new accounts): in that order, once each, then refresh. */
async function onUpdated(itemId: string, shareAccounts: boolean) {
  try {
    await markReconnected(itemId)
    if (shareAccounts) await refreshAccounts(itemId)
    notice.value = { text: shareAccounts ? 'New accounts added below.' : 'Reconnected.', tone: 'ok' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
    await load()
  }
}
const onExit = () => {
  busy.value = false
}

function askLink() {
  if (!canLink.value) return
  linkModal.value = true
}
async function startLink() {
  linkModal.value = false
  if (busy.value) return
  busy.value = true
  notice.value = null
  try {
    const { linkToken } = await createLinkToken()
    await openLink({ token: linkToken, onSuccess: (r) => onNewLinked(r), onExit })
  } catch (e) {
    fail(e)
    busy.value = false
  }
}
async function startUpdate(item: BankItemView, shareAccounts: boolean) {
  if (busy.value) return
  busy.value = true
  notice.value = null
  try {
    const { linkToken } = await createLinkToken(shareAccounts ? { itemId: item.id, accountSelection: true } : { itemId: item.id })
    await openLink({ token: linkToken, itemId: item.id, share: shareAccounts, onSuccess: () => onUpdated(item.id, shareAccounts), onExit })
  } catch (e) {
    fail(e)
    busy.value = false
  }
}

// ── Items ─────────────────────────────────────────────────────────────────────────────────────────────────────
function ago(iso: string | null): string {
  if (!iso) return 'not yet'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'not yet'
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.round(h / 24)} days ago`
}
const isLive = (i: BankItemView) => LIVE.includes(i.status)
const canReconnect = (i: BankItemView) => i.mine && (i.status === 'needs_reconnect' || i.status === 'pending_disconnect')
const bankName = (i: BankItemView) => i.institutionName || 'Bank'

async function syncNow(item: BankItemView) {
  if (busy.value) return
  busy.value = true
  notice.value = null
  try {
    await requestSync(item.id)
    notice.value = { text: 'Queued. It starts within 10 minutes.', tone: 'ok' }
    await load()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
async function unlink() {
  const item = unlinkTarget.value
  if (!item || busy.value) return
  busy.value = true
  try {
    await unlinkItem(item.id)
    unlinkTarget.value = null
    notice.value = { text: `${bankName(item)} unlinked. Rows already in Budget stay.`, tone: 'ok' }
    await load()
  } catch (e) {
    unlinkTarget.value = null
    fail(e)
  } finally {
    busy.value = false
  }
}

// ── Accounts table ────────────────────────────────────────────────────────────────────────────────────────────
const taken = computed(() => new Set(items.value.flatMap((i) => i.accounts).filter((a) => a.sync === 'on' && a.accountId).map((a) => a.accountId as string)))
function accountOptions(row: BankAccountView): SelectOption[] {
  const kinds = FITS[row.type] ?? []
  const own = props.accounts.filter((a) => kinds.includes(a.kind)).map((a) => ({
    value: a.id,
    label: taken.value.has(a.id) && a.id !== row.accountId ? `${a.label} (already syncing)` : a.label,
    disabled: taken.value.has(a.id) && a.id !== row.accountId,
  }))
  return [{ value: '', label: 'Choose an account', disabled: true }, ...own, { value: NEW_ACCOUNT, label: 'New account' }]
}
const COLUMNS: EditableColumn<BankAccountView>[] = [
  { key: 'name', label: 'Account', editor: null, cardLine: 1, minWidth: 160 },
  { key: 'mask', label: 'Last 4', editor: null, cardLine: 1, value: (r) => (r.mask ? `ending ${r.mask}` : '—'), minWidth: 90 },
  { key: 'type', label: 'Type', editor: null, cardLine: 1, value: (r) => r.subtype ?? r.type, minWidth: 100 },
  { key: 'balance', label: 'Balance', editor: null, cardLine: 1, align: 'end', value: (r) => (r.balanceCents === null ? '—' : formatCents(r.balanceCents)), minWidth: 100 },
  {
    key: 'budgetAccount',
    label: 'Budget account',
    editor: 'select',
    cardLine: 2,
    minWidth: 190,
    value: (r) => r.accountId ?? choice[r.id] ?? '',
    options: (r) => (r.sync === 'on' ? props.accounts.map((a) => ({ value: a.id, label: a.label })) : accountOptions(r)),
  },
  { key: 'sync', label: 'Sync', editor: 'select', cardLine: 2, minWidth: 130, value: (r) => (r.sync === 'on' ? 'on' : 'off'), options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
]
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return Number.isFinite(y) ? new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : iso
}
function rowStatus(item: BankItemView): Record<string, RowStatus> {
  const out: Record<string, RowStatus> = {}
  for (const a of item.accounts) {
    const st = rowState[a.id]
    const s: RowStatus = {}
    if (st?.pending) s.pending = true
    if (st?.error) s.error = st.error
    else if (a.sync === 'on' && item.mine) {
      s.message = a.syncFrom
        ? `Bank rows from ${fmtDate(a.syncFrom)} on. Statement rows from that day on will be skipped for this account.`
        : 'Bank rows for every date. Statement rows for this account will be skipped.'
    }
    if (s.pending || s.error || s.message) out[a.id] = s
  }
  return out
}
const defaultKind = (a: BankAccountView): string =>
  a.type === 'credit' ? ((a.subtype ?? '').includes('line') ? 'line_of_credit' : 'card') : a.type === 'loan' ? 'loan' : a.subtype === 'savings' ? 'savings' : 'checking'

function pick(a: BankAccountView, value: string) {
  choice[a.id] = value
  delete rowState[a.id]
}
async function setSync(a: BankAccountView, value: string) {
  if (rowState[a.id]?.pending) return
  const on = value === 'on'
  if (on === (a.sync === 'on')) return
  const chosen = a.accountId ?? choice[a.id] ?? ''
  if (on && !chosen) {
    rowState[a.id] = { error: 'Choose a Budget account first.' }
    return
  }
  rowState[a.id] = { pending: true }
  try {
    const body = !on
      ? { sync: 'off' as const }
      : chosen === NEW_ACCOUNT
        ? { sync: 'on' as const, newAccount: { name: a.name.trim().slice(0, 40) || 'Bank account', kind: defaultKind(a), personId: null } }
        : { sync: 'on' as const, accountId: chosen }
    const r = await setBankAccount(a.id, body)
    const made = 'newAccount' in body ? body.newAccount : undefined
    if (r.created && r.accountId && made) {
      const kind = made.kind as AccountKind
      const debt = kind === 'card' || kind === 'line_of_credit' || kind === 'loan'
      emit('account-added', { id: r.accountId, label: made.name, kind, personId: null, last4: a.mask, isDebt: debt, inSpending: kind === 'checking' || kind === 'savings' || kind === 'card', creditLimitCents: null, aprBp: null })
    }
    delete choice[a.id]
    delete rowState[a.id]
    await load()
  } catch (e) {
    rowState[a.id] = { error: errText(e) }
  }
}
function onEdit(item: BankItemView, rowKey: string, field: string, value: string) {
  const a = item.accounts.find((x) => x.id === rowKey)
  if (!a || !item.mine) return
  if (field === 'budgetAccount') pick(a, value)
  else if (field === 'sync') void setSync(a, value)
}

// ── Rows the bank removed ─────────────────────────────────────────────────────────────────────────────────────
const DROPPED_COLUMNS: EditableColumn<BankDroppedRow>[] = [
  { key: 'postedDate', label: 'Date', editor: null, cardLine: 1, value: (r) => fmtDate(r.postedDate), minWidth: 110 },
  { key: 'accountId', label: 'Account', editor: null, cardLine: 1, value: (r) => props.accounts.find((a) => a.id === r.accountId)?.label ?? '—', minWidth: 140 },
  { key: 'description', label: 'Description', editor: null, cardLine: 1, minWidth: 200 },
  { key: 'amountCents', label: 'Amount', editor: null, cardLine: 1, align: 'end', value: (r) => formatCents(r.amountCents), minWidth: 100 },
  { key: 'actions', label: 'Choose', editor: null, cardLine: 2, minWidth: 170 },
]
async function settle(r: BankDroppedRow, action: 'delete' | 'keep') {
  if (droppedBusy[r.txnId]) return
  droppedBusy[r.txnId] = true
  notice.value = null
  try {
    await resolveDropped(r.txnId, action)
    await load()
  } catch (e) {
    fail(e)
  } finally {
    delete droppedBusy[r.txnId]
  }
}

onMounted(async () => {
  const href = takeOAuthReturn()
  await load()
  // A bank's OAuth page sent the browser back: reopen Link with the token saved before it left.
  if (href && readLink() && status.value?.linkEnabled !== undefined) {
    // What the person started (Reconnect, Share new accounts, or a new link) was saved with the token: finish the same way.
    const saved = readLink()
    const itemId = saved?.itemId
    const share = !!saved?.share
    busy.value = true
    try {
      const r = await resumeLink(href, {
        onSuccess: (res) => (itemId ? onUpdated(itemId, share) : onNewLinked(res)),
        onExit,
      })
      if (!r) busy.value = false
    } catch (e) {
      fail(e)
      busy.value = false
    }
  }
})
</script>

<template>
  <div class="banks-page" data-testid="banks-page">
    <h2 class="bp-h2">Banks</h2>
    <p v-if="notice" class="bp-notice" :class="`bp-${notice.tone}`" role="status" data-testid="banks-notice">{{ notice.text }}</p>

    <p v-if="loading && !status" class="bp-muted" data-testid="banks-loading">Loading…</p>
    <div v-else-if="failed" class="bp-row" data-testid="banks-failed">
      <span class="bp-muted">Banks could not be loaded.</span>
      <button type="button" class="btn bp-btn" data-testid="banks-retry" @click="load">Retry</button>
    </div>
    <p v-else-if="status && !status.configured" class="bp-muted" data-testid="banks-not-configured">Bank links are not set up here.</p>

    <template v-else-if="status">
      <section class="card bp-card" :class="{ 'bp-warn': warn }" data-testid="banks-slots">
        <p class="bp-lead" data-testid="banks-slots-count">{{ slotsLine }}</p>
        <p v-if="slotsExtra" class="bp-warn-text" data-testid="banks-slots-extra">{{ slotsExtra }}</p>
        <p class="bp-muted">Plaid's free plan allows 10 bank links for life. Unlinking a bank does not give its link back.</p>
      </section>

      <section v-if="noLinksYet" class="card bp-card" data-testid="banks-consent">
        <p class="bp-lead">Link a bank so transactions arrive without statement files.</p>
        <p>
          Budget reads, through Plaid, up to 2 years of transactions, each account's balances, and for cards and loans the payment details
          (rate, minimum, due date). Bank usernames and passwords go to Plaid, never to this site.
        </p>
        <p>It is kept in this site's private database, and only the two people allowed into Budget can see it.</p>
        <p>The person who links a bank can unlink it here at any time. Rows already in Budget stay.</p>
        <p><a href="/privacy" target="_blank" rel="noopener">Privacy policy</a></p>
        <label class="bp-agree"><input v-model="agreed" type="checkbox" data-testid="banks-agree" /> I agree</label>
      </section>

      <div class="bp-row">
        <button ref="linkBtn" type="button" class="btn btn-primary bp-btn" :disabled="!canLink" data-testid="banks-link" @click="askLink">
          {{ busy ? 'Working…' : 'Link a bank' }}
        </button>
      </div>

      <section v-for="item in items" :key="item.id" class="card bp-card" :data-item-id="item.id" data-testid="banks-item">
        <p class="bp-lead">
          <span class="bp-dot" :class="{ off: item.status !== 'active' }" aria-hidden="true"></span>{{ bankName(item) }}
          <span class="bp-status" data-testid="banks-item-status">{{ STATUS_WORDS[item.status] ?? item.status }}</span>
        </p>
        <p class="bp-muted" data-testid="banks-item-synced">Last good sync {{ ago(item.lastOkAt) }}.<template v-if="item.syncRequested"> A sync is queued.</template></p>
        <p v-if="item.lastError" class="bp-warn-text" data-testid="banks-item-error">{{ banksMessage(item.lastError) }}</p>
        <p v-if="!item.mine" class="bp-muted" data-testid="banks-other-owner">Linked by the other person.</p>
        <p v-if="item.mine && item.newAccounts" class="bp-muted" data-testid="banks-new-accounts-line">This bank has accounts you have not shared yet.</p>
        <div class="bp-row">
          <button type="button" class="btn bp-btn" :disabled="busy || item.status !== 'active'" data-testid="banks-sync-now" @click="syncNow(item)">Sync now</button>
          <button v-if="canReconnect(item)" type="button" class="btn btn-primary bp-btn" :disabled="busy" data-testid="banks-reconnect" @click="startUpdate(item, false)">Reconnect</button>
          <button v-if="item.mine && item.newAccounts && isLive(item)" type="button" class="btn bp-btn" :disabled="busy" data-testid="banks-new-accounts" @click="startUpdate(item, true)">Share new accounts</button>
          <button v-if="item.mine" type="button" class="btn btn-ghost bp-btn" :disabled="busy" data-testid="banks-unlink" @click="unlinkTarget = item">Unlink</button>
        </div>
        <EditableTable
          v-if="item.accounts.length"
          :columns="COLUMNS"
          :rows="item.accounts"
          row-key="id"
          :editable="item.mine && isLive(item)"
          :row-status="rowStatus(item)"
          :row-label="(r: BankAccountView) => `${r.name}${r.mask ? ' ending ' + r.mask : ''}`"
          card-labels
          :label="`${bankName(item)} accounts`"
          @edit="(k: string, f: string, v: string) => onEdit(item, k, f, v)"
        >
          <template #editor-budgetAccount="{ row, disabled, label, cardLayout }">
            <span v-if="row.sync === 'on'" class="bp-static">{{ accounts.find((a) => a.id === row.accountId)?.label ?? 'Budget account' }}</span>
            <select
              v-else
              class="bp-select"
              :class="{ 'bp-select-card': cardLayout }"
              :value="row.accountId ?? choice[row.id] ?? ''"
              :disabled="disabled"
              :aria-label="label"
              data-testid="banks-account-select"
              @change="pick(row, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in accountOptions(row)" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
            </select>
          </template>
          <template #editor-sync="{ row, disabled, cardLayout }">
            <SegmentedControl
              :model-value="row.sync === 'on' ? 'on' : 'off'"
              :options="[{ value: 'on', label: 'On', testid: 'banks-sync-on' }, { value: 'off', label: 'Off', testid: 'banks-sync-off' }]"
              :label="`Sync ${row.name}`"
              :size="cardLayout ? 'default' : 'compact'"
              :class="{ 'bp-disabled': disabled }"
              @update:model-value="(v: string) => !disabled && setSync(row, v)"
            />
          </template>
        </EditableTable>
      </section>

      <section v-if="status.dropped.length" class="card bp-card" data-testid="banks-dropped">
        <p class="bp-lead">Removed by the bank</p>
        <p class="bp-muted">The bank removed these rows, which you had edited.</p>
        <EditableTable :columns="DROPPED_COLUMNS" :rows="status.dropped" row-key="txnId" card-labels label="Rows removed by the bank">
          <template #cell-actions="{ row, cardLayout }">
            <span class="bp-actions" :class="{ 'bp-actions-card': cardLayout }">
              <button type="button" class="btn bp-btn" :disabled="droppedBusy[row.txnId]" data-testid="banks-dropped-delete" @click="settle(row, 'delete')">Delete</button>
              <button type="button" class="btn bp-btn" :disabled="droppedBusy[row.txnId]" data-testid="banks-dropped-keep" @click="settle(row, 'keep')">Keep</button>
            </span>
          </template>
        </EditableTable>
      </section>
    </template>

    <ModalPanel :open="linkModal" :title="`Use 1 of your ${left} remaining bank links?`" title-id="bp-link-title" described-by="bp-link-desc" :return-to="linkBtn" @close="linkModal = false">
      <p id="bp-link-desc" class="bp-muted" data-testid="banks-link-modal-text">
        Linking the same bank login twice uses another one. If a linked bank stopped working, use Reconnect on it instead.
      </p>
      <template #actions>
        <button type="button" class="btn bp-btn" @click="linkModal = false">Cancel</button>
        <button type="button" class="btn btn-primary bp-btn" data-testid="banks-link-confirm" @click="startLink">Link a bank</button>
      </template>
    </ModalPanel>

    <ModalPanel :open="!!unlinkTarget" :title="`Unlink ${unlinkTarget ? bankName(unlinkTarget) : ''}?`" title-id="bp-unlink-title" described-by="bp-unlink-desc" @close="unlinkTarget = null">
      <p id="bp-unlink-desc" class="bp-muted" data-testid="banks-unlink-text">Rows already in Budget stay. This does not give back the bank link.</p>
      <template #actions>
        <button type="button" class="btn bp-btn" @click="unlinkTarget = null">Cancel</button>
        <button type="button" class="btn btn-primary bp-btn" :disabled="busy" data-testid="banks-unlink-confirm" @click="unlink">Unlink</button>
      </template>
    </ModalPanel>
  </div>
</template>

<style scoped>
.banks-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.bp-h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.bp-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  font-size: 13px;
  min-width: 0;
}
.bp-card p {
  margin: 0;
}
.bp-warn {
  border-color: rgb(var(--amber));
}
.bp-warn-text {
  color: rgb(var(--amber-hover));
  font-weight: 500;
}
.bp-lead {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.bp-status {
  margin-left: 8px;
  font-weight: 500;
  color: rgb(var(--ink-2));
}
.bp-muted {
  margin: 0;
  color: rgb(var(--ink-2));
  font-size: 13px;
}
.bp-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.bp-btn {
  min-height: 36px;
}
@media (max-width: 599px) {
  .bp-btn {
    min-height: 44px;
  }
}
.bp-agree {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}
.bp-agree input {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  margin: 6px;
  accent-color: rgb(var(--amber));
}
.bp-notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 13px;
  border: 1px solid rgb(var(--line-2));
}
.bp-bad {
  border-color: rgb(var(--amber));
}
.bp-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  background: rgb(var(--amber));
}
.bp-dot.off {
  background: rgb(var(--ink-2));
}
.bp-select {
  min-height: 36px;
  max-width: 100%;
  font: inherit;
}
.bp-select-card {
  min-height: 44px;
  width: 100%;
  box-sizing: border-box;
  font-size: 15px;
}
.bp-static {
  overflow-wrap: anywhere;
}
.bp-disabled {
  opacity: 0.6;
  pointer-events: none;
}
.bp-actions {
  display: inline-flex;
  gap: 8px;
}
.bp-actions-card {
  width: 100%;
}
.bp-actions-card .btn {
  flex: 1 1 0;
}
</style>
