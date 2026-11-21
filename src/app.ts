// Contacts as a spur: its tools, its events, and two widgets (a person card for chat, and the people
// it recently identified, for Home).
import type { Database } from "bun:sqlite"
import { defineApp, Log, SWITCH_CATALOG, tool } from "spur-kit"
import type { LogService, ModelsService } from "spur-kit"
import { Effect, Schema } from "effect"

import { SCOPE } from "./google.ts"

import { linkCard, normalizeAll, setFields } from "./edit.ts"
import { enrich } from "./enrich.ts"
import { mergeByHand } from "./merge.ts"
import {
  best,
  contactEvents,
  Enriched,
  everyone,
  KINDS,
  nameOf,
  normOf,
  PersonCreated,
  PersonMerged,
  PersonSplit,
  PersonUpdated,
  Pushed,
  ranked,
  readPerson,
  SenderIdentified,
  SenderUnknown,
  SINGLE,
  TYPES,
} from "./model.ts"
import type { Field, Person } from "./model.ts"
import { batchId, commit, make, makeAll, missing } from "./store.ts"
import { backup, linksOf, push } from "./push.ts"
import { identify, importAll } from "./run.ts"
import { labelOf, pretty, score } from "./text.ts"
import { undo } from "./undo.ts"

/** The live person and everyone merged into them, for what happened to any of them. */
const family = (db: Database, id: string) => {
  const ids = [id]
  for (let i = 0; i < ids.length && ids.length < 500; i += 1) {
    for (const r of db
      .query<{ id: string }, [string]>("SELECT id FROM people WHERE merged_into = ?")
      .all(ids[i] ?? "")) {
      ids.push(r.id)
    }
  }
  return ids
}

const inList = (ids: readonly string[]) => ids.map(() => "?").join(", ")

/** The last lookup of them: when, what it looked at, what it found and wrote, its cost. */
const lookedUp = (db: Database, ids: readonly string[]) => {
  const row = db
    .query<{ payload: string; time: number }, string[]>(
      `SELECT payload, time FROM events WHERE type = '${Enriched.type}'
       AND json_extract(payload, '$.id') IN (${inList(ids)})
       AND json_extract(payload, '$.batch') NOT IN (SELECT batch FROM batches WHERE undone = 1)
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(...ids)
  if (row === null) {
    return null
  }
  const e = Enriched.decode(JSON.parse(row.payload))
  return {
    at: row.time,
    looked: e.looked,
    found: e.findings.length,
    written: e.findings.filter((f) => f.written).length,
    cost: e.cost,
  }
}

/** A person as tools answer it: the best of each kind, every field with its source, and suggestions. */
const view = (db: Database, p: Person) => {
  const facts: { label: string; value: string }[] = []
  for (const kind of KINDS) {
    if (kind === "name" || kind === "ref" || kind === "group") {
      continue
    }
    const shown = new Set<string>()
    for (const f of ranked(p, kind)) {
      if (f.suggested === true || (kind === "handle" && f.service === "imessage")) {
        continue
      }
      const label = labelOf(f)
      const value = pretty(f)
      if (!shown.has(`${label}:${value}`)) {
        shown.add(`${label}:${value}`)
        facts.push({ label, value })
      }
      if (SINGLE.has(kind)) {
        break
      }
    }
  }
  const ids = family(db, p.id)
  const conflicts = db
    .query<{ target: string; key: string; ours: string; theirs: string }, string[]>(
      `SELECT target, key, ours, theirs FROM conflicts WHERE person IN (${inList(ids)})`,
    )
    .all(...ids)
  return {
    id: p.id,
    name: nameOf(p),
    type: best(p, "type") ?? null,
    labels: [
      ...new Set(
        p.fields.filter((f) => f.kind === "group" && f.suggested !== true).map((f) => f.value),
      ),
    ],
    links: linksOf(p),
    facts,
    fields: p.fields.map((f) => ({
      id: f.id,
      kind: f.kind,
      value: f.value,
      ...(f.label === undefined ? {} : { label: f.label }),
      ...(f.service === undefined ? {} : { service: f.service }),
      source: f.source,
      ...(f.url === undefined ? {} : { url: f.url }),
      confidence: f.confidence,
      user: f.user,
      ...(f.suggested === true ? { suggested: true } : {}),
      at: f.at,
    })),
    lookup: lookedUp(db, ids),
    conflicts,
  }
}

/** Labels on a person, as written. */
const labelsOf = (p: Person) => [
  ...new Set(
    p.fields.filter((f) => f.kind === "group" && f.suggested !== true).map((f) => f.value),
  ),
]

const search = tool(
  "search",
  {
    description:
      "Find people by any field, fuzzily: name, nickname, phone (any digits), email, company, handle, city, note. `label` and `type` (person, company, system, or none for unset) narrow it; with an empty query they list everyone matching them.",
    readOnly: true,
    input: Schema.Struct({
      query: Schema.String,
      label: Schema.optionalKey(Schema.String),
      type: Schema.optionalKey(Schema.Literals([...TYPES, "none"])),
      limit: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* searching() {
      const log = yield* Log
      const all = yield* log.read(everyone)
      const label = input.label?.toLowerCase()
      const fits = (p: Person) =>
        (label === undefined || labelsOf(p).some((l) => l.toLowerCase() === label)) &&
        (input.type === undefined || (best(p, "type") ?? "none") === input.type)
      const blank = input.query.trim() === ""
      const hits = all
        .filter(fits)
        .map((p) => ({ p, s: blank ? 1 : score(p.fields, input.query) }))
        .filter((h) => h.s > 0)
        .toSorted((a, b) => b.s - a.s || nameOf(a.p).localeCompare(nameOf(b.p)))
        .slice(0, Math.min(500, input.limit ?? (blank ? 100 : 10)))
      return {
        people: hits.map((h) => ({
          id: h.p.id,
          name: nameOf(h.p),
          nickname: best(h.p, "nickname") ?? null,
          type: best(h.p, "type") ?? null,
          labels: labelsOf(h.p),
          phone: best(h.p, "phone") ?? null,
          email: best(h.p, "email") ?? null,
          company: best(h.p, "company") ?? null,
        })),
      }
    }),
)

const get = tool(
  "get",
  {
    description:
      "One person, by id, phone, email or exact name: their facts, and every field with its source and confidence. Shows as a card in chat.",
    readOnly: true,
    input: Schema.Struct({ person: Schema.String }),
  },
  (input) =>
    Effect.gen(function* getting() {
      const log = yield* Log
      const p = yield* log.read((db) => {
        const direct = readPerson(db, input.person)
        if (direct) {
          return direct
        }
        for (const kind of ["phone", "email", "name"] as const) {
          const row = db
            .query<{ person: string }, [string, string]>(
              "SELECT f.person FROM fields f JOIN people p ON p.id = f.person WHERE f.kind = ? AND f.norm = ? AND p.merged_into IS NULL AND p.retired = 0 LIMIT 1",
            )
            .get(kind, normOf(kind, input.person))
          if (row) {
            return readPerson(db, row.person)
          }
        }
        return null
      })
      if (p === null) {
        return yield* Effect.fail(new Error(`No one matches ${input.person}`))
      }
      return yield* log.read((db) => view(db, p))
    }),
)

const stated = Schema.Struct({
  kind: Schema.Literals(KINDS),
  value: Schema.String,
  label: Schema.optionalKey(Schema.String),
  service: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
})

const update = tool(
  "update",
  {
    description:
      "Add fields to a person, or remove ones by id (ids from `get`): for what a person has several of, such as phones, emails, handles (`service`: instagram, linkedin, x, tiktok…), links and relations. `set` is for single fields and labels. `user`: the user asked for it, which makes the fields theirs (never overwritten) and lets their own fields go. Without it, a field the user set can't be removed. Pass `create` to make a new person.",
    input: Schema.Struct({
      person: Schema.optionalKey(Schema.String),
      add: Schema.optionalKey(Schema.Array(stated)),
      remove: Schema.optionalKey(Schema.Array(Schema.String)),
      user: Schema.optionalKey(Schema.Boolean),
      create: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.gen(function* updating() {
      const log = yield* Log
      const byUser = input.user === true
      const batch = batchId("update")
      const source = byUser ? "user" : "agent"
      const added = makeAll(input.add ?? [], source, byUser)
      if (input.create === true) {
        const id = crypto.randomUUID()
        yield* commit(
          batch,
          [PersonCreated.make({ id, fields: missing(null, added), batch, reason: "update" })],
          byUser,
        )
        return { id, batch }
      }
      const p = yield* log.read((db) => readPerson(db, input.person ?? ""))
      if (p === null) {
        return yield* Effect.fail(new Error(`No person ${input.person ?? ""}`))
      }
      const ids = new Set(input.remove)
      const removed = p.fields.filter((f) => ids.has(f.id))
      yield* commit(
        batch,
        [
          PersonUpdated.make({
            id: p.id,
            added: missing(p, added),
            removed,
            batch,
            reason: "update",
          }),
        ],
        byUser,
      )
      return { id: p.id, batch }
    }),
)

const merge = tool(
  "merge",
  {
    description:
      "Fold people into one: `from` into `into`, every field kept. In Apple and Google, at the next push, the person's first-linked card in each book gets everything and their other cards there are deleted (each kept whole in the log). Undo splits them again and brings deleted cards back.",
    input: Schema.Struct({ into: Schema.String, from: Schema.Array(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* merging() {
      const batch = batchId("merge")
      const out = yield* mergeByHand(input.into, input.from, batch, "merge")
      return { ...out, batch }
    }),
)

const enrichTool = tool(
  "enrich",
  {
    description:
      "Look a person up: an unsaved number in public records (FastPeopleSearch), and the web for email, company, role, LinkedIn and socials. Sure findings are written; unsure ones become suggestions. Takes 10 to 40 seconds.",
    input: Schema.Struct({ person: Schema.String, web: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) => enrich(input.person, batchId("enrich"), { web: input.web ?? true }),
)

const undoTool = tool(
  "undo",
  {
    description:
      "Revert a batch: every change in it, including what it wrote to Apple or Google. `log` lists batches.",
    input: Schema.Struct({ batch: Schema.String }),
  },
  (input) => undo(input.batch),
)

const importTool = tool(
  "import",
  {
    description:
      "Take every source in: Apple and Google the first time (`again`: once more, for cards made there since), merged only into someone who surely is the same (a shared phone, email or handle and the same name); other spurs' contacts; and everyone who messages the user. Returns counts per source.",
    input: Schema.Struct({ again: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) => importAll(input.again === true),
)

const identifyTool = tool(
  "identify",
  {
    description:
      "Look up unknown senders' numbers in public records, newest first, within the day's budget. `count`: how many (default 5).",
    input: Schema.Struct({ count: Schema.optionalKey(Schema.Number) }),
  },
  (input) => identify(input.count ?? 5),
)

const logTool = tool(
  "log",
  {
    description: "Recent batches of changes, newest first, for undo.",
    readOnly: true,
    input: Schema.Struct({ limit: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    Effect.gen(function* listing() {
      const log = yield* Log
      const batches = yield* log.read((db) =>
        db
          .query<
            { batch: string; reason: string; at: number; events: number; undone: number },
            [number]
          >("SELECT * FROM batches ORDER BY at DESC LIMIT ?")
          .all(Math.min(200, input.limit ?? 20)),
      )
      return { batches: batches.map((b) => ({ ...b, undone: b.undone === 1 })) }
    }),
)

/** Their name came from a lookup the user hasn't made theirs yet. */
const unsure = (p: Person) => !p.fields.some((f) => f.kind === "name" && f.user)

const identified = tool(
  "identified",
  {
    description:
      "People recently identified from an unsaved number, newest first: `queue` holds those the user hasn't kept (`confirm`) or undone, `waiting` unknown numbers not looked up yet.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const log = yield* Log
      return yield* log.read((db) => {
        const undone = new Set(
          db
            .query<{ batch: string }, []>("SELECT batch FROM batches WHERE undone = 1")
            .all()
            .map((b) => b.batch),
        )
        const seen = new Set<string>()
        const people = []
        const queue = []
        for (const r of db
          .query<{ payload: string; time: number }, []>(
            `SELECT payload, time FROM events WHERE type = '${SenderIdentified.type}' ORDER BY seq DESC LIMIT 200`,
          )
          .all()) {
          const e = SenderIdentified.decode(JSON.parse(r.payload))
          const p = undone.has(e.batch) ? null : readPerson(db, e.id)
          if (p === null || seen.has(p.id)) {
            continue
          }
          seen.add(p.id)
          const phone = pretty({ kind: "phone", value: e.handle })
          people.push({ id: p.id, name: nameOf(p), phone })
          if (unsure(p)) {
            queue.push({
              id: p.id,
              name: nameOf(p),
              phone,
              source: e.source,
              url: e.url,
              confidence: e.confidence,
              batch: e.batch,
              at: r.time,
              fields: p.fields
                .filter((f) => f.kind === "name" && !f.user && f.source === e.source)
                .map((f) => f.id),
            })
          }
        }
        const waiting = []
        for (const r of db
          .query<{ payload: string; time: number }, []>(
            `SELECT payload, time FROM events WHERE type = '${SenderUnknown.type}' ORDER BY seq DESC LIMIT 200`,
          )
          .all()) {
          const e = SenderUnknown.decode(JSON.parse(r.payload))
          const p = readPerson(db, e.id)
          if (
            p === null ||
            seen.has(p.id) ||
            best(p, "name") !== undefined ||
            lookedUp(db, [p.id])
          ) {
            continue
          }
          seen.add(p.id)
          waiting.push({
            id: p.id,
            phone: pretty({ kind: "phone", value: e.handle }),
            channel: e.channel,
            at: r.time,
          })
        }
        return {
          people: people.slice(0, 12),
          empty: people.length === 0 ? "Nobody" : "",
          queue,
          waiting,
        }
      })
    }),
)

const peopleTool = tool(
  "people",
  {
    description:
      "Everyone, with their fields' kinds and values (no suggestions or records): a client's own list, searched as it types.",
    readOnly: true,
    appOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const log = yield* Log
      const all = yield* log.read(everyone)
      return {
        people: all.map((p) => ({
          id: p.id,
          name: nameOf(p),
          ...(best(p, "type") === undefined ? {} : { type: best(p, "type") }),
          labels: labelsOf(p),
          fields: p.fields
            .filter((f) => f.suggested !== true && f.kind !== "ref" && f.kind !== "last_contact")
            .map((f) => ({
              kind: f.kind,
              value: f.value,
              ...(f.service === undefined ? {} : { service: f.service }),
            })),
        })),
      }
    }),
)

const fact = (f: Field) => ({
  kind: f.kind,
  value: f.value,
  ...(f.service === undefined ? {} : { service: f.service }),
})

interface Change {
  batch: string
  reason: string
  at: number
  undone: boolean
  created: boolean
  added: ReturnType<typeof fact>[]
  removed: ReturnType<typeof fact>[]
  merged: string[]
  split: string[]
  sent: string[]
  found: number
}

const history = tool(
  "history",
  {
    description:
      "What happened to one person, newest first, a batch at a time: fields added and removed, merges and splits, lookups, what went out to Apple or Google. Each batch can be undone.",
    readOnly: true,
    input: Schema.Struct({ person: Schema.String, limit: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const log = yield* Log
      return yield* log.read((db) => {
        const live = readPerson(db, input.person)
        if (live === null) {
          return { changes: [] }
        }
        const ids = family(db, live.id)
        const list = inList(ids)
        const rows = db
          .query<
            {
              type: string
              payload: string
              time: number
              batch: string
              reason: string
              undone: number
            },
            string[]
          >(
            `SELECT e.type, e.payload, e.time, b.batch, b.reason, b.undone FROM events e
             JOIN batches b ON b.batch = json_extract(e.payload, '$.batch')
             WHERE json_extract(e.payload, '$.id') IN (${list})
               OR json_extract(e.payload, '$.into') IN (${list})
               OR json_extract(e.payload, '$.from') IN (${list})
             ORDER BY e.seq DESC LIMIT 2000`,
          )
          .all(...ids, ...ids, ...ids)
        const byBatch = new Map<string, Change>()
        for (const r of rows) {
          const raw: unknown = JSON.parse(r.payload)
          const { batch } = r
          let c = byBatch.get(batch)
          if (c === undefined) {
            c = {
              batch,
              reason: r.reason,
              at: r.time,
              undone: r.undone === 1,
              created: false,
              added: [],
              removed: [],
              merged: [],
              split: [],
              sent: [],
              found: 0,
            }
            byBatch.set(batch, c)
          }
          if (r.type === PersonCreated.type) {
            c.created = true
            c.added.push(...PersonCreated.decode(raw).fields.map(fact))
          } else if (r.type === PersonUpdated.type) {
            const e = PersonUpdated.decode(raw)
            c.added.push(...e.added.map(fact))
            c.removed.push(...e.removed.map(fact))
          } else if (r.type === PersonMerged.type) {
            const e = PersonMerged.decode(raw)
            c.merged.push(e.fields.find((f) => f.kind === "name")?.value ?? e.from)
          } else if (r.type === PersonSplit.type) {
            const e = PersonSplit.decode(raw)
            c.split.push(e.fields.find((f) => f.kind === "name")?.value ?? e.from)
          } else if (r.type === Pushed.type) {
            const e = Pushed.decode(raw)
            if (!c.sent.includes(e.target)) {
              c.sent.push(e.target)
            }
          } else if (r.type === Enriched.type) {
            c.found += Enriched.decode(raw).findings.length
          }
        }
        return { changes: [...byBatch.values()].slice(0, Math.min(200, input.limit ?? 50)) }
      })
    }),
)

const confirm = tool(
  "confirm",
  {
    description:
      "Make fields the user's, as sure: an identified name or a suggestion they keep. Theirs are never overwritten, and suggestions start going out to Apple and Google. `fields`: ids from `get`.",
    input: Schema.Struct({ person: Schema.String, fields: Schema.Array(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* confirming() {
      const log = yield* Log
      const p = yield* log.read((db) => readPerson(db, input.person))
      if (p === null) {
        return yield* Effect.fail(new Error(`No person ${input.person}`))
      }
      const ids = new Set(input.fields)
      const chosen = p.fields.filter((f) => ids.has(f.id) && (!f.user || f.suggested === true))
      if (chosen.length === 0) {
        return yield* Effect.fail(new Error("Nothing to keep"))
      }
      const batch = batchId("confirm")
      const kept = chosen.map((f) =>
        make({ ...f, confidence: 1, suggested: false }, f.source, true),
      )
      yield* commit(
        batch,
        [PersonUpdated.make({ id: p.id, added: kept, removed: chosen, batch, reason: "kept" })],
        true,
      )
      return { id: p.id, batch, kept: kept.length }
    }),
)

const nullable = Schema.optionalKey(Schema.NullOr(Schema.String))

const setTool = tool(
  "set",
  {
    description:
      "Set or clear a person's single fields, replacing whatever they hold, as the user's own (never overwritten by an import; sent to Apple and Google). name (a name set alone also sets given and family from it), given, family, initial (one letter: the family name's initial when that's all that's known; clears family), nickname (what the user calls them), type (person, company or system; leave unset when none fits), relationship (who they are to the user, such as grandmother: Apple's related names), note, company, role, location, birthday (YYYY-MM-DD, or --MM-DD without a year). null clears one. `labels` adds or removes labels (Apple groups, Google labels).",
    input: Schema.Struct({
      person: Schema.String,
      name: nullable,
      given: nullable,
      family: nullable,
      initial: nullable,
      nickname: nullable,
      type: Schema.optionalKey(Schema.NullOr(Schema.Literals(TYPES))),
      relationship: nullable,
      note: nullable,
      company: nullable,
      role: nullable,
      location: nullable,
      birthday: nullable,
      labels: Schema.optionalKey(
        Schema.Struct({
          add: Schema.optionalKey(Schema.Array(Schema.String)),
          remove: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  },
  (input) => {
    const { person, labels, ...settings } = input
    return setFields(person, settings, labels ?? {})
  },
)

const linkTool = tool(
  "link",
  {
    description:
      "Link a person to a card in Apple (its id, `…:ABPerson`) or Google (`people/c…`), so pushes go to that card; `unlink` takes a link off. A card linked to someone else can't be linked again: merge the two people instead. A person linked to several cards in one book keeps the first and the push deletes the rest after giving the first everything.",
    input: Schema.Struct({
      person: Schema.String,
      target: Schema.Literals(["apple", "google"]),
      record: Schema.String,
      unlink: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) => linkCard(input.person, input.target, input.record, input.unlink === true),
)

const normalizeTool = tool(
  "normalize",
  {
    description:
      "Make every field normal once (phones in E.164, names without emoji and properly cased, full names split into given and family): one batch, undone whole. New writes are made normal on their own.",
  },
  () => normalizeAll,
)

const backupTool = tool(
  "backup",
  {
    description:
      "Back both address books up whole now: Apple as vCards and JSON (notes and groups included), Google as JSON, in a new folder under contacts-backup.",
  },
  () => backup,
)

const pushTool = tool(
  "push",
  {
    description:
      "Send what changed to Apple and Google now, instead of at the next two-minute pass. A book gets nothing until it's been imported; anything already there changes only after a backup from the last hour. `dry`: what it would send.",
    input: Schema.Struct({
      target: Schema.optionalKey(Schema.Literals(["apple", "google"])),
      dry: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.all(
      (input.target === undefined ? (["apple", "google"] as const) : [input.target]).map((t) =>
        push(t, batchId(`push-${t}`), undefined, input.dry === true),
      ),
    ).pipe(Effect.map((reports) => ({ reports }))),
)

const component = (id: string, rest: Record<string, unknown>) => ({ id, ...rest })

export const contactsApp = defineApp<LogService | ModelsService>({
  name: "contacts",
  version: "1",
  connections: [{ provider: "google", scopes: [SCOPE], multiple: false }],
  instructions:
    "The user's people and companies, merged from Apple, Google, other sources and everyone who messages them; Switch is the source of truth and pushes changes out to Apple and Google every two minutes. Every field keeps its source and confidence; every change is a batch `undo` reverts, including what it sent. `set` edits single fields and labels; `update` adds or removes list fields (phones, emails, handles, links); `merge` folds duplicates; `link` ties a person to a card.",
  tools: [
    search,
    get,
    setTool,
    update,
    merge,
    linkTool,
    normalizeTool,
    backupTool,
    pushTool,
    enrichTool,
    undoTool,
    importTool,
    identifyTool,
    logTool,
    identified,
    peopleTool,
    history,
    confirm,
  ],
  events: contactEvents,
  widgets: [
    {
      name: "person",
      title: "Person",
      surfaces: ["chat"],
      resource: "ui://contacts/person",
      tool: "get",
      refresh: [PersonUpdated.type],
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "person", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "person",
            components: [
              component("root", { component: "Stack", children: ["name", "facts"] }),
              component("name", { component: "Title", label: { "@path": "/name" } }),
              component("facts", {
                component: "Lines",
                children: { componentId: "fact", path: "/facts" },
              }),
              component("fact", {
                component: "Field",
                label: { "@path": "label" },
                value: { "@path": "value" },
              }),
            ],
          },
        },
      ],
    },
    {
      name: "identified",
      title: "Identified",
      surfaces: ["space"],
      resource: "ui://contacts/identified",
      size: {
        aspect: "auto",
        min: { cols: 3, rows: 1 },
        preferred: { cols: 4, rows: 3 },
        grows: true,
        empty: "hide",
      },
      tool: "identified",
      refresh: [SenderIdentified.type],
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "identified", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "identified",
            components: [
              component("root", { component: "Stack", children: ["people", "empty"] }),
              component("people", {
                component: "Lines",
                children: { componentId: "line", path: "/people" },
              }),
              component("line", {
                component: "Field",
                label: { "@path": "name" },
                value: { "@path": "phone" },
              }),
              component("empty", { component: "Empty", label: { "@path": "/empty" } }),
            ],
          },
        },
      ],
    },
  ],
})
