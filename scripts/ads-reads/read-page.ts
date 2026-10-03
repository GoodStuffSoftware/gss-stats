// read-page: builds the retest morning read's HTML report page (docs/routines/bsk-retest-morning-read.md, Step 8).
//
//   npm run -s ads:read-page -- --input <morning-read.out> --narrative <narrative.json> --out <page.html>
//                               [--audit-commit <sha> [--audit-branch <branch>] [--audit-file <path>]]
//
// --input is the full stdout of `npm run -s ads:morning-read` (the human report, a line
// `----- JSON -----`, then the JSON). --narrative is the Step 5 narrative as JSON:
// { headline, working[], notWorking[], soWhat[] }. --audit-commit is the Step 7 audit-trail
// commit; leave it out when Step 7 failed and the page says the audit trail was not written.
// The branch and file default to the routine's own (docs/ads-next-campaign, and the campaign's
// audit path from its read plan: docs/marketing/google-ads/<auditSlug>/data/<ET date>.json, so
// two campaigns read on one date never share a file; the retest's slug is "retest"). The
// threshold ladder is drawn from the same campaign's read plan, looked up by the id in the JSON.
//
// Fails loudly (exit 1, one line on stderr, nothing written) when the JSON block is missing or
// unparseable, or the narrative is incomplete. On success prints the output path. Read-only
// apart from the one output file; never publishes anything.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { auditPathFor, planOrThrow } from '../../src/lib/adsRules'

export const JSON_SPLIT = '----- JSON -----'
export const PLACEHOLDER = '"@@SRC@@"'
export const DEFAULT_AUDIT_BRANCH = 'docs/ads-next-campaign'
export const auditFileFor = (campaignId: string, etDate: string) => auditPathFor(campaignId, etDate)
export const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'read-page.template.html')

export interface Narrative {
  headline: string
  working: string[]
  notWorking: string[]
  soWhat: string[]
}
export interface Audit {
  commit: string
  branch: string
  file: string
}
export interface PagePayload {
  raw: string
  narrative: Narrative
  audit: Audit | null
  /** The campaign's cumulative-spend read points, from its read plan (null: no campaign id in the JSON). */
  thresholds: number[] | null
}

/** The parsed JSON block of a morning-read's stdout; throws a one-line reason. */
export function parseCliJson(raw: string): Record<string, unknown> {
  const at = raw.indexOf(JSON_SPLIT)
  if (at < 0) throw new Error(`no "${JSON_SPLIT}" line in the CLI output`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(at + JSON_SPLIT.length))
  } catch (e) {
    throw new Error(`the CLI output's JSON block does not parse (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error("the CLI output's JSON block is not an object")
  return parsed as Record<string, unknown>
}

/** Checks the Step 5 narrative's shape; throws a one-line reason. */
export function validateNarrative(n: unknown): Narrative {
  if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('narrative is not a JSON object')
  const o = n as Record<string, unknown>
  if (typeof o.headline !== 'string' || !o.headline.trim()) throw new Error('narrative.headline is missing or empty')
  for (const k of ['working', 'notWorking', 'soWhat'] as const) {
    const v = o[k]
    if (!Array.isArray(v) || v.length === 0) throw new Error(`narrative.${k} is missing or an empty array`)
    if (v.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`narrative.${k} has an empty or non-string entry`)
  }
  return { headline: o.headline, working: o.working as string[], notWorking: o.notWorking as string[], soWhat: o.soWhat as string[] }
}

/** The payload as a JSON string safe inside a <script> element (every "<" escaped). */
export function serializePayload(p: PagePayload): string {
  return JSON.stringify(p).replace(/</g, '\\u003c')
}

/** Builds the page HTML. Throws a one-line reason on any bad input. */
export function buildReadPage(i: { template: string; raw: string; narrative: unknown; audit?: Partial<Audit> | null }): string {
  const json = parseCliJson(i.raw)
  const narrative = validateNarrative(i.narrative)
  const campaignId = json.campaign && typeof json.campaign === 'object' && typeof (json.campaign as { id?: unknown }).id === 'string' ? (json.campaign as { id: string }).id : null
  // Looked up by id at build time, so the template carries no campaign's ladder and the CLI's
  // JSON does not need to carry thresholds.
  const thresholds = campaignId ? [...planOrThrow(campaignId).thresholds] : null
  let audit: Audit | null = null
  if (i.audit?.commit) {
    const etDate = typeof json.etDate === 'string' ? json.etDate : null
    const file = i.audit.file || (etDate && campaignId ? auditFileFor(campaignId, etDate) : null)
    if (!file) throw new Error('no --audit-file given and the JSON block has no campaign id and etDate to derive it from')
    audit = { commit: i.audit.commit, branch: i.audit.branch || DEFAULT_AUDIT_BRANCH, file }
  }
  const parts = i.template.split(PLACEHOLDER)
  if (parts.length !== 2) throw new Error(`the template must contain ${PLACEHOLDER} exactly once (found ${parts.length - 1})`)
  const payload = serializePayload({ raw: i.raw, narrative, audit, thresholds })
  // A replacer function, never a replacement string: the report contains "$", which a
  // replacement string would read as $&, $1 and so on.
  return i.template.replace(PLACEHOLDER, () => payload)
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      narrative: { type: 'string' },
      out: { type: 'string' },
      'audit-commit': { type: 'string' },
      'audit-branch': { type: 'string' },
      'audit-file': { type: 'string' },
      template: { type: 'string' },
    },
    strict: true,
  })
  for (const k of ['input', 'narrative', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`)
  const read = (p: string, what: string) => {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      throw new Error(`cannot read the ${what} file ${p}`)
    }
  }
  const raw = read(values.input!, 'CLI output')
  let narrative: unknown
  try {
    narrative = JSON.parse(read(values.narrative!, 'narrative'))
  } catch (e) {
    throw e instanceof SyntaxError ? new Error(`the narrative file is not valid JSON (${e.message})`) : e
  }
  const html = buildReadPage({
    template: read(values.template || TEMPLATE_PATH, 'template'),
    raw,
    narrative,
    audit: values['audit-commit'] ? { commit: values['audit-commit'], branch: values['audit-branch'], file: values['audit-file'] } : null,
  })
  const out = path.resolve(values.out!)
  fs.writeFileSync(out, html, 'utf8')
  process.stdout.write(out + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`read-page: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
}
