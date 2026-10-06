// The day selector on a "today so far" card (the Today at a glance card): which ET day the card
// reads, and how that day is named. Pure — MetricCard owns the state, MetricDayPicker the control,
// ChartCard the title. A day is an ET calendar day (YYYY-MM-DD); nothing here touches the clock
// except through the `todayEt` it is given.
import { addDays } from './etTime'
import { MAX_DAY_LOOKBACK_DAYS } from './metrics/validate'

/** The earliest day the selector offers: the same bound the server enforces (context.day). */
export function earliestDay(todayEt: string): string {
  return addDays(todayEt, -MAX_DAY_LOOKBACK_DAYS)
}

/** The day a card reads for a chosen one: `null` = today, live. A chosen day that is today or later
 * (a stale choice after a bad URL, or a clock that rolled back) is today; one before the floor is
 * the floor; a string that is not a real date is today. */
export function effectiveDay(chosen: string | null | undefined, todayEt: string): string | null {
  if (!chosen || !/^\d{4}-\d{2}-\d{2}$/.test(chosen) || addDays(chosen, 0) !== chosen) return null
  if (chosen >= todayEt) return null
  const floor = earliestDay(todayEt)
  return chosen < floor ? floor : chosen
}

/** One day back/forward from the shown day (`null` = today); stepping forward onto today is
 * `null`, back past the floor stays on the floor, forward from today stays on today. */
export function stepDay(current: string | null, delta: -1 | 1, todayEt: string): string | null {
  return effectiveDay(addDays(current ?? todayEt, delta), todayEt)
}

/** The bounds for a date input: `max` is today (the picker never offers the future). */
export function dayBounds(todayEt: string): { min: string; max: string } {
  return { min: earliestDay(todayEt), max: todayEt }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Mon Oct 5" for an ET calendar day (calendar arithmetic only, no time zone). */
export function dayLabel(dayEt: string): string {
  const [y, m, d] = dayEt.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${WEEKDAYS[dow]} ${MONTHS[m - 1]} ${d}`
}

/** A card title for the shown day: the stock "Today at a glance" becomes "Mon Oct 5 at a glance"
 * on a past day; any other title keeps its words and gets the day appended. Today keeps the title. */
export function dayTitle(title: string, day: string | null): string {
  if (!day) return title
  return /^today\b/i.test(title) ? `${dayLabel(day)}${title.slice('today'.length)}` : `${title} · ${dayLabel(day)}`
}
