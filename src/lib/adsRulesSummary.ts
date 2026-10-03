// The dashboard widget's one-line summary of a reading's kill-rule results, and the tone it is
// drawn in. Counts only. 'watch' keeps its own tone so a rule on watch never reads like an
// all-clear.
import type { RuleResult } from './adsRules'

export type RulesTone = 'trip' | 'watch' | 'clear' | 'muted'

export function rulesSummary(rules: RuleResult[] | null): { text: string; tone: RulesTone } {
  if (!rules?.length) return { text: '—', tone: 'muted' }
  const tripped = rules.filter((x) => x.status === 'trip')
  if (tripped.length) return { text: `TRIPPED: ${tripped.map((x) => x.id).join(', ')}`, tone: 'trip' }
  const clear = rules.filter((x) => x.status === 'clear').length
  const noData = rules.filter((x) => x.status === 'no-data').length
  const na = rules.filter((x) => x.status === 'n/a').length
  const watch = rules.filter((x) => x.status === 'watch').length
  if (!clear && !noData && !watch) return { text: `not armed${na ? `, ${na} n/a` : ''}`, tone: 'muted' }
  return {
    text: `${clear} clear${watch ? `, ${watch} watch` : ''}${noData ? `, ${noData} no data` : ''}${na ? `, ${na} n/a` : ''}`,
    tone: watch ? 'watch' : 'clear',
  }
}
