// Page icons and group badges (layout version 12).
//
// Keys in data, components in code: a page stores at most a short registry key (DashboardPage.icon,
// e.g. "megaphone"), never markup or SVG, and this file maps each key to a Lucide icon component
// (@lucide/vue, the maintained successor of the deprecated lucide-vue-next — same component names;
// nothing else imports the library).
// Named imports only, so the bundle carries exactly the icons listed here. A key the registry
// doesn't know (removed later, or typed into the config by hand) resolves to the generic page icon.
//
// Every page shows an icon without anyone setting one (resolveIcon): the one someone picked, else
// (a drill page) its root page's icon with a small drill mark, else the icon of the dataset most of
// its charts read, else the generic page icon. Groups get a lettered badge and a colour computed
// from their name (groupBadge), overridable per group with the config's groupMeta.
import type { Component } from 'vue'
import {
  Activity,
  AppWindow,
  Bell,
  Building2,
  ChartColumn,
  ChartLine,
  Clock,
  Compass,
  CreditCard,
  DollarSign,
  Eye,
  File as FileIcon,
  Flag,
  FlaskConical,
  Gamepad2,
  Globe,
  Grid3x3,
  Heart,
  Layers,
  LayoutGrid,
  Link,
  Map as MapIcon,
  MapPin,
  Megaphone,
  MessageCircle,
  MousePointerClick,
  Navigation,
  Package,
  PiggyBank,
  Puzzle,
  Receipt,
  Repeat,
  Rocket,
  ShoppingCart,
  Smartphone,
  Tag,
  Target,
  TrendingUp,
  Trophy,
  Users,
  Wallet,
} from '@lucide/vue'
import type { DashboardPage, Dataset, GroupMeta, Widget } from '../types'
import { parentOf } from './nav'

// The navigation UI's own glyphs (menus, the drill mark, …), re-exported so this file stays the
// only one importing the icon library.
export {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  CornerDownRight as DrillMarkIcon,
  Ellipsis as EllipsisIcon,
  Menu as MenuIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  Sparkles as SparklesIcon,
  Star as StarIcon,
  X as CloseIcon,
} from '@lucide/vue'

export const ICON_CATEGORIES = ['Traffic', 'Engagement', 'Money', 'Product', 'Geography'] as const
export type IconCategory = (typeof ICON_CATEGORIES)[number]

interface IconEntry {
  component: Component
  label: string
  /** Picker category; absent = not offered in the picker (the generic page icon). */
  category?: IconCategory
  /** Extra words the picker's search matches. */
  keywords?: string
}

// The registry. Order within a category is the picker's order.
const REGISTRY = {
  // Traffic
  'trending-up': { component: TrendingUp, label: 'Traffic line', category: 'Traffic', keywords: 'trend growth rum visits' },
  'chart-column': { component: ChartColumn, label: 'Bar chart', category: 'Traffic', keywords: 'bars stats' },
  'chart-line': { component: ChartLine, label: 'Line chart', category: 'Traffic', keywords: 'timeline trend' },
  activity: { component: Activity, label: 'Activity', category: 'Traffic', keywords: 'pulse live' },
  eye: { component: Eye, label: 'Views', category: 'Traffic', keywords: 'pageviews seen' },
  users: { component: Users, label: 'Visitors', category: 'Traffic', keywords: 'people audience' },
  clock: { component: Clock, label: 'Time', category: 'Traffic', keywords: 'hour duration' },
  link: { component: Link, label: 'Referrers', category: 'Traffic', keywords: 'links sources' },
  // Engagement
  'mouse-pointer-click': { component: MousePointerClick, label: 'Clicks', category: 'Engagement', keywords: 'taps pointer' },
  'app-window': { component: AppWindow, label: 'Pop-up', category: 'Engagement', keywords: 'popup prompt window' },
  repeat: { component: Repeat, label: 'Returns', category: 'Engagement', keywords: 'retention returning' },
  bell: { component: Bell, label: 'Notifications', category: 'Engagement', keywords: 'alerts' },
  trophy: { component: Trophy, label: 'Completions', category: 'Engagement', keywords: 'wins games achievements' },
  target: { component: Target, label: 'Goals', category: 'Engagement', keywords: 'conversion aim' },
  heart: { component: Heart, label: 'Favourites', category: 'Engagement', keywords: 'likes love' },
  'message-circle': { component: MessageCircle, label: 'Feedback', category: 'Engagement', keywords: 'comments chat' },
  // Money
  'dollar-sign': { component: DollarSign, label: 'Revenue', category: 'Money', keywords: 'money income' },
  'credit-card': { component: CreditCard, label: 'Payments', category: 'Money', keywords: 'card purchase' },
  wallet: { component: Wallet, label: 'Wallet', category: 'Money', keywords: 'spend budget' },
  tag: { component: Tag, label: 'Ads / pricing', category: 'Money', keywords: 'price ads readings' },
  megaphone: { component: Megaphone, label: 'Campaigns', category: 'Money', keywords: 'marketing ads promo' },
  'piggy-bank': { component: PiggyBank, label: 'Savings', category: 'Money', keywords: 'budget' },
  receipt: { component: Receipt, label: 'Receipts', category: 'Money', keywords: 'invoice cost' },
  'shopping-cart': { component: ShoppingCart, label: 'Store', category: 'Money', keywords: 'shop checkout' },
  // Product
  'layout-grid': { component: LayoutGrid, label: 'Overview', category: 'Product', keywords: 'dashboard grid summary' },
  smartphone: { component: Smartphone, label: 'App', category: 'Product', keywords: 'phone mobile device' },
  'gamepad-2': { component: Gamepad2, label: 'Game', category: 'Product', keywords: 'play controller' },
  'grid-3x3': { component: Grid3x3, label: 'Puzzle grid', category: 'Product', keywords: 'sudoku board' },
  puzzle: { component: Puzzle, label: 'Puzzle', category: 'Product', keywords: 'piece feature' },
  package: { component: Package, label: 'Release', category: 'Product', keywords: 'version build ship' },
  rocket: { component: Rocket, label: 'Launch', category: 'Product', keywords: 'ship start' },
  'flask-conical': { component: FlaskConical, label: 'Experiment', category: 'Product', keywords: 'test lab beta' },
  layers: { component: Layers, label: 'Layers', category: 'Product', keywords: 'stack platform' },
  // Geography
  'map-pin': { component: MapPin, label: 'Map pin', category: 'Geography', keywords: 'location beacon geo' },
  globe: { component: Globe, label: 'Globe', category: 'Geography', keywords: 'world international' },
  map: { component: MapIcon, label: 'Map', category: 'Geography', keywords: 'regions' },
  flag: { component: Flag, label: 'Country', category: 'Geography', keywords: 'flag nation' },
  compass: { component: Compass, label: 'Compass', category: 'Geography', keywords: 'direction explore' },
  navigation: { component: Navigation, label: 'Navigation', category: 'Geography', keywords: 'arrow direction' },
  'building-2': { component: Building2, label: 'City', category: 'Geography', keywords: 'building office town' },
  // Not offered in the picker: what a page with nothing better gets.
  file: { component: FileIcon, label: 'Page', keywords: 'generic document' },
} as const satisfies Record<string, IconEntry>

export type IconKey = keyof typeof REGISTRY
export const FALLBACK_ICON: IconKey = 'file'

/** Key → component, for rendering (`<component :is="ICONS[key]">`). */
export const ICONS: Readonly<Record<IconKey, Component>> = Object.freeze(
  Object.fromEntries(Object.entries(REGISTRY).map(([k, v]) => [k, v.component])) as Record<IconKey, Component>,
)

export function isIconKey(key: unknown): key is IconKey {
  return typeof key === 'string' && Object.hasOwn(REGISTRY, key)
}
export function iconLabel(key: IconKey): string {
  return REGISTRY[key].label
}

/** The picker's icons, by category, in order. */
export interface PickerIcon {
  key: IconKey
  label: string
  category: IconCategory
  keywords: string
}
export const PICKER_ICONS: readonly PickerIcon[] = Object.freeze(
  (Object.entries(REGISTRY) as [IconKey, IconEntry][])
    .filter(([, v]) => v.category)
    .map(([key, v]) => ({ key, label: v.label, category: v.category!, keywords: v.keywords ?? '' })),
)

// What each dataset's charts are about — the 7 values of Dataset.
export const DATASET_ICON: Readonly<Record<Dataset, IconKey>> = Object.freeze({
  rum: 'trending-up',
  geo: 'map-pin',
  popup: 'app-window',
  campaigns: 'megaphone',
  completions: 'trophy',
  'ads-readings': 'tag',
  overview: 'layout-grid',
})

/** The dataset most of a page's charts read: note widgets don't count, a chart with no dataset
 * counts as 'rum' (as it does everywhere else), and a tie goes to the dataset whose first chart
 * comes first in layout order (top to bottom, then left to right). null = no charts. */
export function chartsDataset(widgets: readonly Widget[]): Dataset | null {
  const inLayoutOrder = widgets
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.type !== 'note')
    .sort((a, b) => a.w.y - b.w.y || a.w.x - b.w.x || a.i - b.i)
  const count = new Map<Dataset, number>()
  const first = new Map<Dataset, number>()
  inLayoutOrder.forEach(({ w }, pos) => {
    const d: Dataset = w.dataset ?? 'rum'
    count.set(d, (count.get(d) ?? 0) + 1)
    if (!first.has(d)) first.set(d, pos)
  })
  let best: Dataset | null = null
  for (const [d, n] of count) {
    if (best === null || n > count.get(best)! || (n === count.get(best)! && first.get(d)! < first.get(best)!)) best = d
  }
  return best
}

export type IconSource = 'explicit' | 'inherited' | 'charts' | 'fallback'
export interface ResolvedIcon {
  key: IconKey
  /** A drill page: shown with a small drill mark. */
  drill: boolean
  source: IconSource
  /** source 'charts': the dataset it came from. */
  dataset?: Dataset
  /** source 'inherited': the root page it came from. */
  from?: DashboardPage
}

function ownIcon(page: DashboardPage): Omit<ResolvedIcon, 'drill'> {
  if (page.icon) return isIconKey(page.icon) ? { key: page.icon, source: 'explicit' } : { key: FALLBACK_ICON, source: 'fallback' }
  const d = chartsDataset(page.widgets)
  if (d && Object.hasOwn(DATASET_ICON, d)) return { key: DATASET_ICON[d], source: 'charts', dataset: d }
  return { key: FALLBACK_ICON, source: 'fallback' }
}

/** The icon a page shows. First match wins: 1) the icon someone picked (page.icon; a key the
 * registry doesn't know falls back to the generic page icon), 2) a drill page shows its root
 * page's icon, 3) the icon of the dataset most of its charts read (chartsDataset), 4) the generic
 * page icon. A drill page always carries the drill mark. */
export function resolveIcon(page: DashboardPage, pages: readonly DashboardPage[]): ResolvedIcon {
  const parent = parentOf(page, pages)
  const drill = !!parent
  if (page.icon || !parent) return { ...ownIcon(page), drill }
  return { key: ownIcon(parent).key, drill: true, source: 'inherited', from: parent }
}

/** What "Auto" would show for a page: resolveIcon as if no icon had been picked. */
export function autoIcon(page: DashboardPage, pages: readonly DashboardPage[]): ResolvedIcon {
  const { icon: _picked, ...rest } = page
  return resolveIcon(rest as DashboardPage, pages)
}

// ── Group badges ────────────────────────────────────────────────────────────────────────────
// A lettered monogram and one of seven fixed colours (style.css --g0…--g6, each with a light and a
// dark value), both computed from the group's name, so a new group needs no setup.
export const GROUP_PALETTE_SIZE = 7

/** 32-bit FNV-1a over the name's UTF-16 code units. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
/** The palette slot a group name hashes to ("All sites" 1 teal, "Best Sudoku" 3 orange, "Mine" 5
 * green, "Star Rupture" 2 violet). */
export function groupColorIndex(name: string): number {
  return fnv1a(name) % GROUP_PALETTE_SIZE
}
/** The first letter of the first two words; a one-word name takes its first two letters. */
export function groupMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  const letters = words.length >= 2 ? [Array.from(words[0])[0], Array.from(words[1])[0]] : Array.from(words[0]).slice(0, 2)
  return letters.join('').toUpperCase()
}

export interface GroupBadgeStyle {
  text: string
  /** Palette slot 0…6 (class gb-c<slot>), unless a hex colour is pinned. */
  slot?: number
  /** A pinned hex colour, with a readable text colour for it. */
  color?: string
  onColor?: string
  /** A logo image replacing the monogram. */
  logo?: string
}
function readableOn(hex: string): string {
  const h = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : hex
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return lum > 0.4 ? '#15120F' : '#FFFFFF'
}
/** A group's badge: its monogram and hashed palette colour, with the group's groupMeta (already
 * validated by lib/defaults.ts normGroupMeta) pinning a colour and/or a logo. */
export function groupBadge(name: string, meta?: GroupMeta): GroupBadgeStyle {
  const out: GroupBadgeStyle = { text: groupMonogram(name) }
  const c = meta?.color
  if (c && /^g[0-6]$/.test(c)) out.slot = Number(c.slice(1))
  else if (c && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
    out.color = c
    out.onColor = readableOn(c)
  } else out.slot = groupColorIndex(name)
  if (meta?.logo) out.logo = meta.logo
  return out
}
