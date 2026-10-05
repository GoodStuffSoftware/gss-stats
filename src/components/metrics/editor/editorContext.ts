// The page's filter context, as the card editor was given it, for the label editors nested inside it
// (CardEditorLabel, however deep: title, section heading, item label, caption, hint, empty message).
// A label's "Insert value" menu shows what each metric reads right now, from a value the page
// ALREADY holds for this context (peekMetricValue); an editor mounted outside a CardEditor, or given
// no context, lists the metrics by name alone.
import { inject, provide, type InjectionKey, type MaybeRefOrGetter } from 'vue'
import type { MetricsContext } from '../../../lib/metrics/types'

const KEY: InjectionKey<MaybeRefOrGetter<MetricsContext | undefined>> = Symbol('cardEditorMetricsContext')

export function provideEditorContext(context: MaybeRefOrGetter<MetricsContext | undefined>): void {
  provide(KEY, context)
}

export function injectEditorContext(): MaybeRefOrGetter<MetricsContext | undefined> | undefined {
  return inject(KEY, undefined)
}
