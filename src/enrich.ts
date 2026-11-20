// Enrichment: people search for unsaved numbers (FastPeopleSearch, as Switchboard's people-lookup
// did), and a web search read by a small model for email, company, role and socials. Pages load in
// the user's Chrome through AQB, politely; each finding keeps its source, URL and confidence, and
// anything under `WRITE` is only a suggestion.
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { Log, Models } from "spur-kit"
import { Effect } from "effect"

import { parse, rec, recs, text as toText } from "./json.ts"
import {
  best,
  Enriched,
  nameOf,
  PersonUpdated,
  readPerson,
  SenderIdentified,
} from "./model.ts"
import type { Field, Finding, Person } from "./model.ts"
import { commit, make, missing } from "./store.ts"
import { phoneKey } from "./text.ts"

/** At or over this, a finding is written; under it, suggested. */
export const WRITE = 0.8
const GAP_MS = 6000
const PER_HOUR = 30

// The browser.

let aqb: Client | null = null
const pages: number[] = []
let lastPage = 0
let resting = 0

const browser = async () => {
  if (aqb !== null) {
    return aqb
  }
  const c = new Client({ name: "switch-contacts", version: "1" })
  await c.connect(
    new StdioClientTransport({ command: "zsh", args: ["-lc", "exec aqb mcp"], stderr: "ignore" }),
  )
  aqb = c
  return c
}

const SESSION = { session: "switch-contacts", group: "Switch contacts" }

const textOf = (r: unknown) => {
  const content = recs(rec(r).content)
  return content.map((c) => (typeof c.text === "string" ? c.text : "")).join("\n")
}

class BlockedError extends Error {
  override name = "BlockedError"
}

/** Loads a page in the background tab and returns its text. Never solves a human check. */
const page = async (url: string) => {
  const now = Date.now()
  if (now < resting) {
    throw new BlockedError("Resting after a human check")
  }
  while (pages.length > 0 && now - (pages[0] ?? 0) > 3_600_000) {
    pages.shift()
  }
  if (pages.length >= PER_HOUR) {
    throw new BlockedError("Page budget for the hour spent")
  }
  const wait = lastPage + GAP_MS + Math.random() * 2000 - now
  if (wait > 0) {
    await Bun.sleep(wait)
  }
  const c = await browser()
  await c.callTool({ name: "browser_navigate", arguments: { url, ...SESSION } })
  lastPage = Date.now()
  pages.push(lastPage)
  const text = textOf(await c.callTool({ name: "browser_page_text", arguments: SESSION }))
  if (
    /Just a moment|Verify you are human|are you a robot|unusual traffic|captcha/iu.test(
      text.slice(0, 3000),
    )
  ) {
    resting = Date.now() + 30 * 60_000
    throw new BlockedError("Human check")
  }
  return text
}

export const releaseBrowser = async () => {
  if (aqb !== null) {
    // A tab already gone, or a closed connection: nothing left to release.
    await aqb.callTool({ name: "browser_release", arguments: SESSION }).catch(() => null)
    await aqb.close().catch(() => null)
    aqb = null
  }
}

// People search.

export interface Owner {
  readonly name: string
  readonly age: number | null
  readonly relatives: readonly string[]
  readonly url: string
}

const CANADA =
  /^(?:204|226|236|249|250|263|289|306|343|354|365|367|368|382|387|403|416|418|428|431|437|438|450|468|474|506|514|519|548|579|581|584|587|604|613|639|647|672|683|705|709|742|753|778|780|782|807|819|825|867|873|879|902|905)/u

/** FastPeopleSearch's current owner of a US number; null when it lists none. */
export const phoneOwner = async (phone: string): Promise<Owner | null | "unsupported"> => {
  const d = phoneKey(phone)
  if (d.length !== 10 || CANADA.test(d)) {
    return "unsupported"
  }
  const url = `https://www.fastpeoplesearch.com/${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
  const text = await page(url)
  const owner = /current owner of the phone number [\d-]+ is (?<name>[^.\n]+)\./iu.exec(text)
    ?.groups?.name
  if (owner === undefined) {
    return null
  }
  const name = owner.trim()
  const lines = text.split("\n").map((l) => l.trim())
  const at = lines.indexOf(name)
  const age =
    at === -1
      ? null
      : Number(/^Age (?<age>\d+)/u.exec(lines[at + 1] ?? "")?.groups?.age ?? Number.NaN)
  const rel = lines.find((l, i) => i > at && l.startsWith("Relatives:"))
  return {
    name,
    age: age === null || Number.isNaN(age) ? null : age,
    relatives:
      rel === undefined
        ? []
        : rel
            .slice(10)
            .split("•")
            .map((x) => x.trim()),
    url,
  }
}

const titleCase = (s: string) => s.toLowerCase().replaceAll(/\b[a-z]/gu, (c) => c.toUpperCase())

const STABLE_OWNER =
  "A public-records site names the current owner of a phone number that texted the user. Judge whether that person is who is texting, from what the messages and any other names say. Records lag: numbers get recycled, family plans list a parent, businesses use personal lines."

/** How sure the public record names who's texting: Jev reads what they wrote. */
const ownerConfidence = (owner: Owner, context: string) =>
  Effect.gen(function* judging() {
    const models = yield* Models
    const d = yield* models.decide(
      {
        stable: STABLE_OWNER,
        item: `Owner on record: ${owner.name}${owner.age === null ? "" : `, age ${owner.age}`}. Relatives: ${owner.relatives.join(", ") || "none"}.\nWhat we know of the texter: ${context || "nothing beyond the number"}`,
      },
      {
        same: {
          instructions: "Is the owner on record the person texting the user?",
          choices: [
            { value: "yes", description: "Likely the same person" },
            { value: "no", description: "Something says it's someone else" },
          ],
        },
      },
    )
    const p = d.answers.same?.probabilities.yes ?? 0.5
    return { p, cost: d.cost }
  })

// Web search, read by a small model.

const EXTRACT = `You read web search results about one person and pull out facts about them. Answer JSON only:
{"findings":[{"kind":"email|company|role|location|handle|url","value":"...","service":"linkedin|instagram|x|facebook|telegram|github (handles only)","url":"page it came from","confidence":0.0}]}
Confidence is how sure the fact is about THIS person (same name AND the known details agree), not how sure the page is. A namesake gets 0.3 or less. Skip anything you can't tie to them. A LinkedIn profile URL is a handle with service linkedin and value the profile slug.`

/** Kinds a web page can tell. */
const FOUND = ["email", "company", "role", "location", "handle", "url"] as const

const parseFindings = (text: string): Finding[] => {
  const m = /\{[\s\S]*\}/u.exec(text)
  if (!m) {
    return []
  }
  try {
    const raw = rec(parse(m[0]))
    return recs(raw.findings).flatMap((f): Finding[] => {
      const kind = FOUND.find((k) => k === f.kind)
      const value = toText(f.value).trim()
      if (kind === undefined || value === "") {
        return []
      }
      const confidence = Math.max(0, Math.min(1, Number(f.confidence ?? 0)))
      return [
        {
          kind,
          value,
          ...(typeof f.service === "string" && kind === "handle"
            ? { service: f.service.toLowerCase() }
            : {}),
          source: "web",
          ...(typeof f.url === "string" ? { url: f.url } : {}),
          confidence,
          written: confidence >= WRITE,
        },
      ]
    })
  } catch {
    return []
  }
}

const known = (p: Person) =>
  p.fields
    .filter((f) => f.suggested !== true && !["ref", "last_contact", "note"].includes(f.kind))
    .slice(0, 16)
    .map((f) => `${f.kind}${f.service === undefined ? "" : `/${f.service}`}: ${f.value}`)
    .join("; ")

/** The error as thrown, so its message survives. */
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

/** Nothing found, nothing looked at. */
const nothing = (): { findings: Finding[]; cost: number; looked: boolean } => ({
  findings: [],
  cost: 0,
  looked: false,
})

const webSearch = (p: Person) =>
  Effect.gen(function* searching() {
    const name = best(p, "name")
    if (name === undefined || name.split(/\s+/u).length < 2) {
      return nothing()
    }
    const hint = best(p, "company") ?? best(p, "location") ?? ""
    const q = `"${name}" ${hint} linkedin`.trim()
    const text = yield* Effect.tryPromise({
      try: async () => await page(`https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`),
      catch: asError,
    })
    const models = yield* Models
    const reply = yield* models.complete(
      "triage",
      EXTRACT,
      `Person: ${known(p)}\n\nSearch results for ${q}:\n${text.slice(0, 9000)}`,
    )
    return { findings: parseFindings(reply.text), cost: reply.cost, looked: true }
  })

// One person, end to end.

const toField = (f: Finding, at: number): Field =>
  make(
    {
      kind: f.kind,
      value: f.value,
      ...(f.service === undefined ? {} : { service: f.service }),
      ...(f.url === undefined ? {} : { url: f.url }),
      confidence: f.confidence,
      suggested: !f.written,
    },
    f.source,
    false,
    at,
  )

export interface EnrichResult {
  readonly id: string
  readonly name: string
  readonly findings: readonly Finding[]
  readonly identified: boolean
  readonly cost: number
  readonly note?: string
}

/** Looks one person up and writes what it found (or suggests it). `context`: what they wrote. */
export const enrich = (
  id: string,
  batch: string,
  options: { readonly web: boolean; readonly context?: string },
) =>
  Effect.gen(function* enriching() {
    const log = yield* Log
    const p = yield* log.read((db) => readPerson(db, id))
    if (p === null) {
      return yield* Effect.fail(new Error(`No person ${id}`))
    }
    const started = Date.now()
    const findings: Finding[] = []
    const looked: string[] = []
    let cost = 0
    let identified: { name: string; url: string; confidence: number; handle: string } | null = null
    let note: string | undefined
    /** The search couldn't be read (a human check): not a lookup, so it's tried again later. */
    let failed = false

    const phone = best(p, "phone")
    const hasName = p.fields.some((f) => f.kind === "name" && f.suggested !== true)
    if (phone !== undefined && !hasName) {
      looked.push("phone")
      const owner = yield* Effect.tryPromise({
        try: async () => await phoneOwner(phone),
        catch: asError,
      }).pipe(
        Effect.catch((error) => {
          note = error instanceof Error ? error.message : String(error)
          failed = true
          return Effect.succeed(null)
        }),
      )
      if (owner === "unsupported") {
        note = "Not a US number"
      } else if (owner !== null) {
        const context = [
          options.context ?? "",
          ...p.fields
            .filter((f) => f.kind === "handle" || f.kind === "space")
            .map((f) => `${f.kind}: ${f.value}`),
        ]
          .filter((x) => x !== "")
          .join("\n")
        const judged = yield* ownerConfidence(owner, context).pipe(
          Effect.orElseSucceed(() => ({ p: 0.5, cost: 0 })),
        )
        cost += judged.cost
        // A current-owner listing alone is fairly strong; Jev's read moves it.
        const confidence = Math.round((0.55 + 0.4 * judged.p) * 100) / 100
        const name = titleCase(owner.name)
        findings.push({
          kind: "name",
          value: name,
          source: "fastpeoplesearch",
          url: owner.url,
          confidence,
          written: confidence >= WRITE,
        })
        identified = { name, url: owner.url, confidence, handle: phone }
      }
    }

    if (options.web) {
      looked.push("web")
      const web = yield* webSearch(
        identified !== null && identified.confidence >= WRITE
          ? {
              ...p,
              fields: [
                ...p.fields,
                make({ kind: "name", value: identified.name }, "fastpeoplesearch", false),
              ],
            }
          : p,
      ).pipe(
        Effect.catch((error) => {
          note = error instanceof Error ? error.message : String(error)
          return Effect.succeed(nothing())
        }),
      )
      cost += web.cost
      findings.push(...web.findings)
    }

    const at = Date.now()
    const added = missing(
      p,
      findings.map((f) => toField(f, at)),
    )
    const events = [
      ...(added.length > 0
        ? [PersonUpdated.make({ id: p.id, added, removed: [], batch, reason: "enriched" })]
        : []),
      ...(failed && findings.length === 0
        ? []
        : [
            Enriched.make({
              id: p.id,
              findings,
              looked,
              cost,
              ms: at - started,
              batch,
              reason: "enriched",
            }),
          ]),
      ...(identified !== null && identified.confidence >= WRITE
        ? [
            SenderIdentified.make({
              id: p.id,
              handle: identified.handle,
              name: identified.name,
              source: "fastpeoplesearch",
              url: identified.url,
              confidence: identified.confidence,
              batch,
              reason: "identified",
            }),
          ]
        : []),
    ]
    yield* commit(batch, events)
    const after = yield* log.read((db) => readPerson(db, p.id))
    return {
      id: p.id,
      name: after === null ? "" : nameOf(after),
      findings,
      identified: identified !== null && identified.confidence >= WRITE,
      cost,
      ...(note === undefined ? {} : { note }),
    } satisfies EnrichResult
  })
