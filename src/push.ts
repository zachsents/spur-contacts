// Outbound: Switch is the source of truth, and Apple and Google get what changed in it, so caller ID
// and Gmail show it. Only values Switch hasn't written before go out; a blank is filled, a value is
// added, nothing of the user's is replaced or removed. Where the book now differs from what Switch last
// wrote, it's left alone and recorded as a conflict.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Log } from "spur-kit"
import type { Draft } from "spur-kit"
import { Effect } from "effect"

import { appleCards, appleEdit, appleVcards } from "./apple.ts"
import type { AppleCard, AppleEdit } from "./apple.ts"
import { googleCreate, googleDelete, googleGet, googlePeople, googleUpdate } from "./google.ts"
import type { GooglePerson } from "./google.ts"
import { parse, recs, text } from "./json.ts"
import type { Json } from "./json.ts"
import { best, Conflicted, everyone, PersonUpdated, phoneKey, Pushed } from "./model.ts"
import type { Field, Person, Target } from "./model.ts"
import { commit, DIR, make } from "./store.ts"

export const BACKUPS = path.join(DIR, "contacts-backup")

/** Both books, whole, before anything is first written to them. */
export const backup = Effect.gen(function* backingUp() {
  const day = new Date().toISOString().slice(0, 10)
  const dir = path.join(BACKUPS, day)
  mkdirSync(dir, { recursive: true })
  const [vcf, google] = yield* Effect.all([appleVcards, googlePeople], { concurrency: 2 })
  writeFileSync(path.join(dir, "apple.vcf"), vcf, { mode: 0o600 })
  writeFileSync(path.join(dir, "google.json"), JSON.stringify(google, null, 1), { mode: 0o600 })
  return { dir, apple: vcf.split("BEGIN:VCARD").length - 1, google: google.length }
})

const backedUp = () =>
  existsSync(BACKUPS) &&
  readdirSync(BACKUPS).some(
    (d) =>
      existsSync(path.join(BACKUPS, d, "apple.vcf")) &&
      existsSync(path.join(BACKUPS, d, "google.json")),
  )

const SITES: Readonly<Record<string, string>> = {
  linkedin: "https://www.linkedin.com/in/",
  instagram: "https://www.instagram.com/",
  telegram: "https://t.me/",
  x: "https://x.com/",
  facebook: "https://www.facebook.com/",
  github: "https://github.com/",
}

const OK = 0.8
const usable = (f: Field) => f.suggested !== true && f.confidence >= OK

type WantKind = "first" | "last" | "org" | "title" | "phone" | "email" | "url"
type Single = "first" | "last" | "org" | "title"

interface Want {
  readonly key: string
  readonly kind: WantKind
  readonly value: string
  readonly label: string
}

const isSingle = (k: string): k is Single =>
  k === "first" || k === "last" || k === "org" || k === "title"

/** Name, company and role, where the book didn't give them. */
const singles = (p: Person, target: Target): Want[] => {
  const out: Want[] = []
  const name = p.fields.find((f) => f.kind === "name" && usable(f) && f.label === undefined)
  if (name !== undefined && name.source !== target) {
    const [first = "", ...rest] = name.value.split(/\s+/u)
    out.push({ key: "first", kind: "first", value: first, label: "" })
    if (rest.length > 0) {
      out.push({ key: "last", kind: "last", value: rest.join(" "), label: "" })
    }
  }
  const company = p.fields.find((f) => f.kind === "company" && usable(f))
  if (company !== undefined && company.source !== target) {
    out.push({ key: "org", kind: "org", value: company.value, label: "" })
  }
  const role = p.fields.find((f) => f.kind === "role" && usable(f))
  if (role !== undefined && role.source !== target) {
    out.push({ key: "title", kind: "title", value: role.value, label: "" })
  }
  return out
}

/** A phone, an email or a profile, as the book would hold it; null for anything else. */
const listWant = (f: Field): Want | null => {
  if (f.kind === "phone" && phoneKey(f.value) !== "") {
    return {
      key: `phone:${phoneKey(f.value)}`,
      kind: "phone",
      value: f.value,
      label: f.label ?? "mobile",
    }
  }
  if (f.kind === "email") {
    return {
      key: `email:${f.value.toLowerCase()}`,
      kind: "email",
      value: f.value.toLowerCase(),
      label: f.label ?? "other",
    }
  }
  const site = f.service === undefined ? undefined : SITES[f.service]
  if (f.kind === "handle" && f.service !== undefined && site !== undefined) {
    const url = f.url ?? `${site}${f.value}`
    return {
      key: `url:${f.service}:${f.value.toLowerCase()}`,
      kind: "url",
      value: url,
      label: f.service,
    }
  }
  return null
}

/** What Switch would have each book hold for a person: key → value. */
const wanted = (p: Person, target: Target) => {
  const out = singles(p, target)
  for (const f of p.fields) {
    const w = usable(f) && f.source !== target ? listWant(f) : null
    if (w !== null) {
      out.push(w)
    }
  }
  const seen = new Set<string>()
  const kept: Want[] = []
  for (const w of out) {
    if (w.value !== "" && !seen.has(w.key)) {
      seen.add(w.key)
      kept.push(w)
    }
  }
  return kept
}

interface Remote {
  readonly first: string
  readonly last: string
  readonly org: string
  readonly title: string
  readonly phones: readonly string[]
  readonly emails: readonly string[]
  readonly urls: readonly string[]
}

const singleOf = (r: Remote, k: Single) => {
  if (k === "first") {
    return r.first
  }
  if (k === "last") {
    return r.last
  }
  if (k === "org") {
    return r.org
  }
  return r.title
}

const holds = (r: Remote, w: Want) => {
  if (w.kind === "phone") {
    return r.phones.some((x) => phoneKey(x) === phoneKey(w.value))
  }
  if (w.kind === "email") {
    return r.emails.some((x) => x.toLowerCase() === w.value)
  }
  if (w.kind === "url") {
    const tail = w.key.split(":").at(-1) ?? ""
    return r.urls.some((x) => x.toLowerCase().includes(tail))
  }
  return singleOf(r, w.kind).trim() !== ""
}

const current = (r: Remote, w: Want) => (isSingle(w.kind) ? singleOf(r, w.kind).trim() : "")

export interface Plan {
  readonly person: Person
  readonly remote: string | null
  readonly writes: readonly Want[]
  readonly conflicts: readonly { key: string; ours: string; theirs: string }[]
}

/**
 * What to send: values not written before, not there already; single values only into blanks.
 * A key Switch wrote that the book no longer holds as written is a conflict, never rewritten.
 */
export const plan = (
  target: Target,
  p: Person,
  remoteId: string | null,
  r: Remote | null,
  pushed: ReadonlyMap<string, string>,
  conflicted: ReadonlySet<string>,
): Plan => {
  const writes: Want[] = []
  const conflicts: { key: string; ours: string; theirs: string }[] = []
  for (const w of wanted(p, target)) {
    const last = pushed.get(w.key)
    if (last !== undefined) {
      if (r !== null && !conflicted.has(w.key)) {
        const stillThere = isSingle(w.kind)
          ? current(r, w) === last
          : holds(r, { ...w, value: last })
        if (!stillThere) {
          conflicts.push({ key: w.key, ours: last, theirs: current(r, w) })
        }
      }
      continue
    }
    if (r !== null && holds(r, w)) {
      continue
    }
    writes.push(w)
  }
  return { person: p, remote: remoteId, writes, conflicts }
}

const appleRemote = (c: AppleCard): Remote => c

const valuesOf = (v: unknown, key: string) => recs(v).map((x) => text(x[key]))

const googleRemote = (g: GooglePerson): Remote => {
  const [name = {}] = recs(g.names)
  const [org = {}] = recs(g.organizations)
  return {
    first: text(name.givenName),
    last: text(name.familyName),
    org: text(org.name),
    title: text(org.title),
    phones: recs(g.phoneNumbers).map((x) => text(x.canonicalForm ?? x.value)),
    emails: valuesOf(g.emailAddresses, "value"),
    urls: valuesOf(g.urls, "value"),
  }
}

const refOf = (p: Person, target: Target) =>
  p.fields.find((f) => f.kind === "ref" && f.service === target)?.value ?? null

/**
 * Who gets a new card: someone named, with a number or an email, who is in either book or has
 * written to the user. Someone only another source knows, who never has, stays in Switch.
 */
const shouldCreate = (p: Person, target: Target) => {
  if (refOf(p, target) !== null) {
    return false
  }
  const named = p.fields.some((f) => f.kind === "name" && usable(f))
  const reachable = p.fields.some((f) => (f.kind === "phone" || f.kind === "email") && usable(f))
  const inBook = refOf(p, "apple") !== null || refOf(p, "google") !== null
  const messaged = p.fields.some((f) => f.kind === "last_contact" && f.label === "messaged")
  return named && reachable && (inBook || messaged)
}

interface Labelled {
  value: string
  label: string
}

/** Phones, emails and URLs, each into its own list. */
const lists = <T>(ws: readonly Want[], item: (w: Want) => T) => {
  const out: { phones: T[]; emails: T[]; urls: T[] } = { phones: [], emails: [], urls: [] }
  for (const w of ws) {
    if (w.kind === "phone") {
      out.phones.push(item(w))
    } else if (w.kind === "email") {
      out.emails.push(item(w))
    } else if (w.kind === "url") {
      out.urls.push(item(w))
    }
  }
  return out
}

const appleEditOf = (pl: Plan): AppleEdit => {
  const set: Partial<Record<Single, string>> = {}
  for (const w of pl.writes) {
    if (isSingle(w.kind)) {
      set[w.kind] = w.value
    }
  }
  const add = lists(pl.writes, (w): Labelled => ({ value: w.value, label: w.label }))
  return { ...(pl.remote === null ? {} : { id: pl.remote }), set, add }
}

const NAME_KEYS: Readonly<Record<string, string>> = {
  first: "givenName",
  last: "familyName",
  org: "name",
  title: "title",
}
const LIST_FIELDS: Readonly<Record<string, string>> = {
  phone: "phoneNumbers",
  email: "emailAddresses",
  url: "urls",
}

const googleBody = (pl: Plan, r: GooglePerson | null) => {
  const fields = new Set<string>()
  const body: Json = {}
  const [name = {}] = recs(r?.names)
  const [org = {}] = recs(r?.organizations)
  const named: Json = { ...name }
  const organization: Json = { ...org }
  const listed: Record<string, Json[]> = {
    phoneNumbers: [...recs(r?.phoneNumbers)],
    emailAddresses: [...recs(r?.emailAddresses)],
    urls: [...recs(r?.urls)],
  }
  for (const w of pl.writes) {
    const key = NAME_KEYS[w.kind] ?? ""
    if (w.kind === "first" || w.kind === "last") {
      named[key] = w.value
      fields.add("names")
    } else if (w.kind === "org" || w.kind === "title") {
      organization[key] = w.value
      fields.add("organizations")
    } else {
      const list = LIST_FIELDS[w.kind] ?? "urls"
      listed[list]?.push({ value: w.value, type: w.label })
      fields.add(list)
    }
  }
  if (fields.has("names")) {
    delete named.displayName
    delete named.unstructuredName
    body.names = [named]
  }
  if (fields.has("organizations")) {
    body.organizations = [organization]
  }
  for (const list of ["phoneNumbers", "emailAddresses", "urls"]) {
    if (fields.has(list)) {
      body[list] = listed[list]
    }
  }
  return { body, fields: [...fields] }
}

export interface PushReport {
  readonly target: Target
  readonly people: number
  readonly created: number
  readonly values: number
  readonly conflicts: number
  readonly errors: readonly string[]
}

/** What Switch has written to one book, and the conflicts it already recorded there. */
const history = (target: Target) =>
  Effect.gen(function* reading() {
    const log = yield* Log
    const { all, pushed, conflicted } = yield* log.read((db) => {
      const pushedRows = db
        .query<{ person: string; key: string; value: string }, [string]>(
          "SELECT person, key, value FROM pushed WHERE target = ?",
        )
        .all(target)
      const conflictRows = db
        .query<{ person: string; key: string }, [string]>(
          "SELECT person, key FROM conflicts WHERE target = ?",
        )
        .all(target)
      return { all: everyone(db), pushed: pushedRows, conflicted: conflictRows }
    })
    const pushedBy = new Map<string, Map<string, string>>()
    for (const r of pushed) {
      const m = pushedBy.get(r.person) ?? new Map<string, string>()
      m.set(r.key, r.value)
      pushedBy.set(r.person, m)
    }
    const conflictBy = new Map<string, Set<string>>()
    for (const c of conflicted) {
      const m = conflictBy.get(c.person) ?? new Set<string>()
      m.add(c.key)
      conflictBy.set(c.person, m)
    }
    return { all, pushedBy, conflictBy }
  })

/** Each linked card as it is now, by its id there. */
const remotesOf = (target: Target, ids: readonly string[]) =>
  Effect.gen(function* reading() {
    const remotes = new Map<string, Remote>()
    const googles = new Map<string, GooglePerson>()
    if (target === "apple") {
      for (let i = 0; i < ids.length; i += 100) {
        const cards = yield* appleCards(ids.slice(i, i + 100))
        for (const c of cards) {
          remotes.set(c.id, appleRemote(c))
        }
      }
    } else {
      const everyoneThere = yield* googlePeople
      for (const g of everyoneThere) {
        googles.set(g.resourceName, g)
        remotes.set(g.resourceName, googleRemote(g))
      }
    }
    return { remotes, googles }
  })

const nameOrId = (pl: Plan) => best(pl.person, "name") ?? pl.person.id

/** Writes to Apple, 25 cards a script, each script's cards recorded as soon as it returns. */
const writeApple = (writing: readonly Plan[], batch: string) =>
  Effect.gen(function* sending() {
    const done: Plan[] = []
    const errors: string[] = []
    for (let i = 0; i < writing.length; i += 25) {
      const chunk = writing.slice(i, i + 25)
      const results = yield* appleEdit(chunk.map((pl) => appleEditOf(pl)))
      const events: Draft[] = []
      for (const [j, r] of results.entries()) {
        const pl = chunk[j]
        if (pl !== undefined && r.ok && r.id !== null) {
          done.push(pl)
          events.push(...recorded("apple", batch, pl, r.id))
        } else if (pl !== undefined) {
          errors.push(`${nameOrId(pl)}: ${r.error ?? "failed"}`)
        }
      }
      yield* commit(batch, events)
    }
    return { done, errors }
  })

/** Writes to Google a card at a time, each recorded as soon as it's written. */
const writeGoogle = (
  writing: readonly Plan[],
  googles: ReadonlyMap<string, GooglePerson>,
  batch: string,
) =>
  Effect.gen(function* sending() {
    const done: Plan[] = []
    const errors: string[] = []
    for (const pl of writing) {
      const g = pl.remote === null ? null : (googles.get(pl.remote) ?? null)
      const { body, fields } = googleBody(pl, g)
      const result = yield* Effect.result(
        g === null ? googleCreate(body) : googleUpdate(g, fields, body),
      )
      if (result._tag === "Success") {
        done.push(pl)
        yield* commit(batch, recorded("google", batch, pl, result.success.resourceName))
      } else {
        errors.push(`${nameOrId(pl)}: ${result.failure.message}`)
      }
    }
    return { done, errors }
  })

/** A card's id there, as the person's `ref`: how the next push finds the card it made. */
const linked = (target: Target, batch: string, person: string, remote: string) =>
  PersonUpdated.make({
    id: person,
    added: [make({ kind: "ref", value: remote, service: target }, target, false)],
    removed: [],
    batch,
    reason: `linked to ${target}`,
  })

/** What one write did: the values sent and, for a new card, the link to it. */
const recorded = (target: Target, batch: string, pl: Plan, remote: string): Draft[] => [
  ...(pl.remote === null ? [linked(target, batch, pl.person.id, remote)] : []),
  Pushed.make({
    id: pl.person.id,
    target,
    remote,
    created: pl.remote === null,
    written: pl.writes.map((w) => ({ key: w.key, value: w.value })),
    reverted: false,
    batch,
    reason: `pushed to ${target}`,
  }),
]

/** The Google cards there were before Switch first wrote, from the first backup. */
const googleBefore = () => {
  if (!existsSync(BACKUPS)) {
    return null
  }
  const [first] = readdirSync(BACKUPS)
    .filter((d) => existsSync(path.join(BACKUPS, d, "google.json")))
    .toSorted()
  if (first === undefined) {
    return null
  }
  const raw = parse(readFileSync(path.join(BACKUPS, first, "google.json"), "utf-8"))
  return new Set(recs(raw).map((g) => text(g.resourceName)))
}

/**
 * Cards in Google no one is linked to that hold a number or email of someone who'd get a new
 * card: a write that went out without being recorded. Linked instead of made again; one that
 * wasn't there before Switch first wrote counts as made by Switch, so an undo deletes it.
 */
const adopt = (
  candidates: readonly Person[],
  all: readonly Person[],
  googles: ReadonlyMap<string, GooglePerson>,
  remotes: ReadonlyMap<string, Remote>,
  batch: string,
) =>
  Effect.gen(function* adopting() {
    const taken = new Set(
      all.flatMap((p) =>
        p.fields.filter((f) => f.kind === "ref" && f.service === "google").map((f) => f.value),
      ),
    )
    const byKey = new Map<string, string>()
    for (const [id, r] of remotes) {
      if (taken.has(id)) {
        continue
      }
      for (const ph of r.phones) {
        if (phoneKey(ph) !== "") {
          byKey.set(`phone:${phoneKey(ph)}`, id)
        }
      }
      for (const e of r.emails) {
        byKey.set(`email:${e.toLowerCase()}`, id)
      }
    }
    const before = googleBefore()
    const adopted = new Map<string, string>()
    for (const p of candidates) {
      const keys = wanted(p, "google").filter((w) => w.kind === "phone" || w.kind === "email")
      const id = keys.map((w) => byKey.get(w.key)).find((x) => x !== undefined)
      const r = id === undefined ? undefined : remotes.get(id)
      if (
        id === undefined ||
        r === undefined ||
        [...adopted.values()].includes(id) ||
        !googles.has(id)
      ) {
        continue
      }
      adopted.set(p.id, id)
      // A name or company counts only where it reads as Switch's: else it's the card's own.
      const held = wanted(p, "google").filter((w) =>
        isSingle(w.kind) ? current(r, w) === w.value : holds(r, w),
      )
      yield* commit(batch, [
        linked("google", batch, p.id, id),
        Pushed.make({
          id: p.id,
          target: "google",
          remote: id,
          created: before !== null && !before.has(id),
          written: held.map((w) => ({ key: w.key, value: w.value })),
          reverted: false,
          batch,
          reason: "found in google",
        }),
      ])
    }
    return adopted
  })

/** Sends what changed to one book. `only`: just these people. `dry`: says what it would send. */
export const push = (target: Target, batch: string, only?: ReadonlySet<string>, dry = false) =>
  Effect.gen(function* pushing() {
    if (!dry && !backedUp()) {
      yield* backup
    }
    const { all, pushedBy, conflictBy } = yield* history(target)
    const people = all.filter(
      (p) =>
        (only === undefined || only.has(p.id)) &&
        (refOf(p, target) !== null || shouldCreate(p, target)),
    )
    const ids = people.flatMap((p) => {
      const r = refOf(p, target)
      return r === null ? [] : [r]
    })
    const { remotes, googles } = yield* remotesOf(target, ids)
    const adopted =
      target === "google" && !dry
        ? yield* adopt(
            people.filter((p) => refOf(p, target) === null),
            all,
            googles,
            remotes,
            batch,
          )
        : new Map<string, string>()
    const after = adopted.size > 0 ? yield* history(target) : null

    const plans = people.flatMap((p) => {
      const id = refOf(p, target) ?? adopted.get(p.id) ?? null
      if (id !== null && !remotes.has(id)) {
        return []
      }
      const own = (after ?? { pushedBy }).pushedBy.get(p.id) ?? new Map<string, string>()
      const mine = conflictBy.get(p.id) ?? new Set<string>()
      const pl = plan(target, p, id, id === null ? null : (remotes.get(id) ?? null), own, mine)
      return pl.writes.length > 0 || pl.conflicts.length > 0 ? [pl] : []
    })

    const events: Draft[] = plans.flatMap((pl) =>
      pl.conflicts.map((c) =>
        Conflicted.make({
          id: pl.person.id,
          target,
          remote: pl.remote ?? "",
          key: c.key,
          ours: c.ours,
          theirs: c.theirs,
        }),
      ),
    )
    const conflicts = events.length
    const writing = plans.filter((pl) => pl.writes.length > 0)
    if (dry) {
      let planned = 0
      for (const pl of writing) {
        planned += pl.writes.length
      }
      return {
        target,
        people: writing.length,
        created: writing.filter((pl) => pl.remote === null).length,
        values: planned,
        conflicts,
        errors: [],
      } satisfies PushReport
    }
    yield* commit(batch, events)
    const { done, errors } =
      target === "apple"
        ? yield* writeApple(writing, batch)
        : yield* writeGoogle(writing, googles, batch)
    let created = 0
    let values = 0
    for (const pl of done) {
      values += pl.writes.length
      if (pl.remote === null) {
        created += 1
      }
    }
    return {
      target,
      people: writing.length,
      created,
      values,
      conflicts,
      errors,
    } satisfies PushReport
  })

interface Written {
  readonly id: string
  readonly target: Target
  readonly remote: string
  readonly created: boolean
  readonly written: readonly { key: string; value: string }[]
}

const unpushApple = (p: Written) => {
  if (p.created) {
    return appleEdit([{ id: p.remote, delete: true }])
  }
  const clear: Partial<Record<Single, string>> = {}
  const rest: Want[] = []
  for (const w of p.written) {
    const kind = w.key.split(":")[0] ?? ""
    if (isSingle(kind)) {
      clear[kind] = w.value
    } else if (kind === "phone" || kind === "email" || kind === "url") {
      rest.push({ key: w.key, kind, value: w.value, label: "" })
    }
  }
  const remove = lists(rest, (w) => w.value)
  return appleEdit([{ id: p.remote, remove, clear }])
}

/** The Google lists with what Switch added taken out. */
const googleLists = (p: Written, g: GooglePerson, body: Json, fields: string[]) => {
  const added = new Set(p.written.map((w) => w.value.toLowerCase()))
  const keys = new Set(p.written.map((w) => w.key.split(":")[0] ?? ""))
  if (keys.has("phone")) {
    body.phoneNumbers = recs(g.phoneNumbers).filter(
      (x) =>
        !p.written.some(
          (w) => w.key.startsWith("phone:") && phoneKey(text(x.value)) === phoneKey(w.value),
        ),
    )
    fields.push("phoneNumbers")
  }
  if (keys.has("email")) {
    body.emailAddresses = recs(g.emailAddresses).filter(
      (x) => !added.has(text(x.value).toLowerCase()),
    )
    fields.push("emailAddresses")
  }
  if (keys.has("url")) {
    body.urls = recs(g.urls).filter((x) => !added.has(text(x.value).toLowerCase()))
    fields.push("urls")
  }
}

/** The Google name and organisation with what Switch filled in cleared, where it's still there. */
const googleSingles = (p: Written, g: GooglePerson, body: Json, fields: string[]) => {
  const r = googleRemote(g)
  const [name = {}] = recs(g.names)
  const [org = {}] = recs(g.organizations)
  const named: Json = { ...name }
  const organization: Json = { ...org }
  for (const w of p.written) {
    if (isSingle(w.key) && singleOf(r, w.key) === w.value) {
      const key = NAME_KEYS[w.key] ?? ""
      if (w.key === "first" || w.key === "last") {
        named[key] = ""
        fields.push("names")
      } else {
        organization[key] = ""
        fields.push("organizations")
      }
    }
  }
  if (fields.includes("names")) {
    delete named.displayName
    delete named.unstructuredName
    body.names = [named]
  }
  if (fields.includes("organizations")) {
    body.organizations = [organization]
  }
}

const unpushGoogle = (p: Written) =>
  Effect.gen(function* undoing() {
    if (p.created) {
      yield* googleDelete(p.remote)
      return
    }
    const g = yield* googleGet(p.remote)
    const body: Json = {}
    const fields: string[] = []
    googleLists(p, g, body, fields)
    googleSingles(p, g, body, fields)
    if (fields.length > 0) {
      yield* googleUpdate(g, [...new Set(fields)], body)
    }
  })

/** Takes back what one push wrote, where the book still holds it as written. */
export const unpush = (p: Written, batch: string) =>
  Effect.gen(function* undoing() {
    yield* p.target === "apple" ? unpushApple(p) : unpushGoogle(p)
    yield* commit(batch, [
      Pushed.make({
        ...p,
        written: [...p.written],
        reverted: true,
        batch,
        reason: `undo push to ${p.target}`,
      }),
    ])
  })
