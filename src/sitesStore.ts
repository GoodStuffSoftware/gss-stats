import { ref } from 'vue'
import type { SiteGroup, SiteSub } from './types'

// The auto-built site tree (from /api/sites): registrable domains, each with its
// real subdomains, both RUM + beacon identifiers folded in, dev/preview excluded.
export const sitesTree = ref<SiteGroup[]>([])
export const sitesLoaded = ref(false)

export async function loadSites(): Promise<void> {
  try {
    const res = await fetch('/api/sites')
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data?.sites)) sitesTree.value = data.sites
    }
  } catch {
    /* leave the tree empty — queries fall back to unfiltered */
  } finally {
    sitesLoaded.value = true
  }
}

// A selection token is either a domain ("goodstuff.software" = the whole site) or a
// full host ("starrupture.goodstuff.software" = one subdomain). Empty = all real
// sites. Resolve it to the concrete RUM requestHosts + beacon site tags to filter by.
export function resolveSelection(sel: string[] | undefined): { hosts: string[]; tags: string[] } {
  const tree = sitesTree.value
  const hosts = new Set<string>()
  const tags = new Set<string>()
  const add = (s: SiteSub) => {
    // Each sub carries every host/tag it represents (canonical + folded aliases).
    for (const h of s.hosts?.length ? s.hosts : s.host ? [s.host] : []) hosts.add(h)
    for (const t of s.tags?.length ? s.tags : s.tag ? [s.tag] : []) tags.add(t)
  }
  if (!sel || !sel.length) {
    for (const g of tree) for (const s of g.subs) add(s)
    return { hosts: [...hosts], tags: [...tags] }
  }
  for (const token of sel) {
    const domain = tree.find((g) => g.domain === token)
    if (domain) {
      for (const s of domain.subs) add(s)
      continue
    }
    for (const g of tree) {
      const s = g.subs.find((x) => x.host === token)
      if (s) add(s)
    }
  }
  return { hosts: [...hosts], tags: [...tags] }
}

// Human label for a selection token (a domain shows as-is; a host shows its subdomain
// label under its domain, e.g. "starrupture").
export function tokenLabel(token: string): string {
  const domain = sitesTree.value.find((g) => g.domain === token)
  if (domain) return token
  const parts = token.split('.')
  return parts.length > 2 ? parts.slice(0, parts.length - 2).join('.') : token
}
