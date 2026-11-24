// The one place this Worker writes a log line (plan section 9, Logging): an event name, counts and one code, nothing else.
// No Gmail ids, addresses, subjects, merchants, amounts or model output ever reach a log: callers pass numbers and a
// fixed code, and this helper drops anything that is not a short [a-z0-9_] name or a finite number.
// A test fails on any other console.* in workers/receipts/src (workers/receipts/test/run.test.ts).

const NAME = /^[a-z0-9_]{1,40}$/

export function log(event: string, counts: Record<string, number> = {}, code?: string | null): void {
  const line: Record<string, string | number> = { event: NAME.test(event) ? event : 'invalid_event' }
  for (const [k, v] of Object.entries(counts)) {
    if (NAME.test(k) && typeof v === 'number' && Number.isFinite(v)) line[k] = Math.trunc(v)
  }
  if (code && NAME.test(code)) line.code = code
  console.log(JSON.stringify(line))
}
