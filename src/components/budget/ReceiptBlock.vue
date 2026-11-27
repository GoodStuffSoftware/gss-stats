<script setup lang="ts">
// The read-only "Receipt" block under a transaction's note (plan section 8 item 5). Every string here came from an email, so
// it is untrusted: each one is drawn through plain Vue text interpolation (escaped) after receiptText() strips control and
// bidi characters and caps its length. No v-html, no markdown. The only link is "Open in Gmail", built from `gmailMsgId`
// after re-checking it against a strict pattern (gmailUrl); without a valid id there is no link.
import { computed } from 'vue'
import { photoUrlOf, type ReceiptLink } from '../../lib/budget/receiptsClient'
import { formatDate, gmailUrl, receiptMoney, receiptText } from '../../lib/budget/tableModel'

// "View photo" only asks the host to show it (`view-photo`): the viewer lives at table level, outside the tip, so a touch or
// scroll on the photo cannot close the tip that holds this block.
const props = defineProps<{ link: ReceiptLink }>()
const emit = defineEmits<{ 'view-photo': [url: string] }>()

const MAX_ITEMS = 8

const merchant = computed(() => receiptText(props.link.merchant, 60))
const date = computed(() => {
  const raw = receiptText(props.link.date, 40)
  const m = /^\d{4}-\d{2}-\d{2}/.exec(raw)
  return m ? formatDate(m[0]) : raw
})
const total = computed(() => receiptMoney(props.link.totalCents, props.link.currency))
const tax = computed(() => receiptMoney(props.link.taxCents, props.link.currency))
const orderRef = computed(() => receiptText(props.link.orderRef, 64))
const card = computed(() => receiptText(props.link.cardLast4, 4))
const allItems = computed(() => (Array.isArray(props.link.items) ? props.link.items : []))
const items = computed(() =>
  allItems.value.slice(0, MAX_ITEMS).map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
    const q = typeof o.quantity === 'number' && Number.isFinite(o.quantity) && o.quantity > 0 ? Math.min(Math.round(o.quantity), 9999) : null
    return { name: receiptText(o.description, 80) || 'Item', qty: q, amount: receiptMoney(o.amountCents, props.link.currency) }
  }),
)
const more = computed(() => Math.max(0, allItems.value.length - MAX_ITEMS))
const href = computed(() => gmailUrl(props.link.gmailMsgId))
/** The photo, only when the server sent a same-origin path for this viewer (it decides who may see it). */
const photoUrl = computed(() => photoUrlOf(props.link.imageUrl))
</script>

<template>
  <section class="rb" aria-label="Receipt" data-testid="receipt-block">
    <div class="rb-head">
      <span class="rb-title">Receipt</span>
      <span v-if="merchant" class="rb-merchant" data-testid="receipt-merchant">{{ merchant }}</span>
    </div>
    <dl class="rb-facts">
      <template v-if="date"><dt>Date</dt><dd data-testid="receipt-date">{{ date }}</dd></template>
      <template v-if="total"><dt>Total</dt><dd data-testid="receipt-total">{{ total }}</dd></template>
      <template v-if="tax"><dt>Tax</dt><dd data-testid="receipt-tax">{{ tax }}</dd></template>
      <template v-if="orderRef"><dt>Order</dt><dd data-testid="receipt-order">{{ orderRef }}</dd></template>
      <template v-if="card"><dt>Card</dt><dd data-testid="receipt-card">ending {{ card }}</dd></template>
    </dl>
    <ul v-if="items.length" class="rb-items" data-testid="receipt-items">
      <li v-for="(it, n) in items" :key="n">
        <span class="rb-iname">{{ it.name }}<template v-if="it.qty && it.qty !== 1"> × {{ it.qty }}</template></span>
        <span v-if="it.amount" class="rb-iamt">{{ it.amount }}</span>
      </li>
      <li v-if="more" class="rb-more">+{{ more }} more</li>
    </ul>
    <a v-if="href" class="rb-link" :href="href" target="_blank" rel="noopener noreferrer" data-testid="receipt-gmail">Open in Gmail</a>
    <button v-if="photoUrl" type="button" class="btn btn-ghost rb-photo" data-testid="receipt-photo-btn" @click="emit('view-photo', photoUrl)">View photo</button>
  </section>
</template>

<style scoped>
.rb {
  display: block;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgb(var(--line-2));
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  min-width: 0;
  max-width: 100%;
  cursor: auto;
}
.rb-head {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  align-items: baseline;
}
.rb-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: rgb(var(--ink-2));
}
.rb-merchant {
  font-weight: 600;
  min-width: 0;
}
.rb-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1px 8px;
  margin: 4px 0 0;
}
.rb-facts dt {
  color: rgb(var(--ink-2));
}
.rb-facts dd {
  margin: 0;
  min-width: 0;
}
.rb-items {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}
.rb-items li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.rb-iname {
  min-width: 0;
  overflow-wrap: anywhere;
}
.rb-iamt {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.rb-more {
  color: rgb(var(--ink-2));
}
.rb-photo {
  min-height: 36px;
  margin-top: 4px;
  padding: 0 8px;
}
.rb-link {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  min-width: 36px;
  margin-top: 4px;
  color: rgb(var(--amber-hover));
  text-decoration: underline;
}
</style>
