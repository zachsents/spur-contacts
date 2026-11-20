// Contacts as a spur: its tools, its events, and two widgets (a person card for chat, and the people
// it recently identified, for Home).
import { defineApp, HOME, Log, SWITCH_CATALOG, tool } from "spur-kit"
import type { LogService, ModelsService } from "spur-kit"
import { Effect, Schema } from "effect"

import { SCOPE } from "./google.ts"

import { enrich } from "./enrich.ts"
import { mergeByHand } from "./merge.ts"
import {
  best,
  contactEvents,
  everyone,
  KINDS,
  nameOf,
  normOf,
  PersonCreated,
  PersonUpdated,
  phoneKey,
  ranked,
  readPerson,
  SenderIdentified,
} from "./model.ts"
import type { Field, Person } from "./model.ts"
import { batchId, commit, make, missing } from "./store.ts"
import { identify, importAll } from "./run.ts"
import { undo } from "./undo.ts"

const LABELS: Readonly<Record<string, string>> = {
  phone: "Phone",
  email: "Email",
  company: "Company",
  role: "Role",
  location: "Location",
  birthday: "Birthday",
  relation: "Related",
  space: "Space",
  url: "Link",
  note: "Note",
  last_contact: "Last",
}

const SERVICES: Readonly<Record<string, string>> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  telegram: "Telegram",
  imessage: "iMessage",
  x: "X",
  facebook: "Facebook",
  github: "GitHub",
}

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** `1990-07-22` as Jul 22, 1990; `--07-22` as Jul 22. */
const birthday = (v: string) => {
  const m = /^(?<year>\d{4}|-)-(?<month>\d{2})-(?<day>\d{2})$/u.exec(v)
  const month = MONTHS[Number(m?.groups?.month) - 1]
  if (m?.groups === undefined || month === undefined) {
    return v
  }
  const md = `${month} ${Number(m.groups.day)}`
  return m.groups.year === "-" ? md : `${md}, ${m.groups.year}`
}

const pretty = (f: Field) => {
  if (f.kind === "phone") {
    const d = phoneKey(f.value)
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : f.value
  }
  if (f.kind === "last_contact") {
    return day(Number(f.value))
  }
  if (f.kind === "birthday") {
    return birthday(f.value)
  }
  return f.value
}

/** A person as tools answer it: the best of each kind, every field with its source, and suggestions. */
const view = (p: Person) => {
  const facts: { label: string; value: string }[] = []
  for (const kind of KINDS) {
    if (kind === "name" || kind === "ref") {
      continue
    }
    const shown = new Set<string>()
    for (const f of ranked(p, kind)) {
      if (f.suggested === true || (kind === "handle" && f.service === "imessage")) {
        continue
      }
      const label =
        kind === "handle"
          ? (SERVICES[f.service ?? ""] ?? f.service ?? "Handle")
          : (LABELS[kind] ?? kind)
      const value = pretty(f)
      if (!shown.has(`${label}:${value}`)) {
        shown.add(`${label}:${value}`)
        facts.push({ label, value })
      }
      if (["company", "role", "location", "birthday", "last_contact"].includes(kind)) {
        break
      }
    }
  }
  return {
    id: p.id,
    name: nameOf(p),
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
    })),
  }
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .split(/[^a-z0-9@.+_-]+/u)
    .filter((t) => t !== "")

/** How well `q` fits a person: every word must land in some field, prefix or digits. */
const score = (p: Person, q: string) => {
  const words = tokens(q)
  if (words.length === 0) {
    return 0
  }
  const digits = q.replaceAll(/\D/gu, "")
  let total = 0
  const hay = p.fields.filter((f) => f.kind !== "ref" && f.kind !== "last_contact")
  if (
    digits.length >= 4 &&
    hay.some((f) => f.kind === "phone" && phoneKey(f.value).includes(digits))
  ) {
    return 10
  }
  for (const w of words) {
    let bestHit = 0
    for (const f of hay) {
      for (const t of tokens(f.value)) {
        const weight = f.kind === "name" ? 3 : 1
        if (t === w) {
          bestHit = Math.max(bestHit, 2 * weight)
        } else if (t.startsWith(w)) {
          bestHit = Math.max(bestHit, 1.5 * weight)
        } else if (w.length >= 4 && (t.includes(w) || editsWithin(t, w))) {
          bestHit = Math.max(bestHit, 0.8 * weight)
        }
      }
    }
    if (bestHit === 0) {
      return 0
    }
    total += bestHit
  }
  return total
}

/** One typo: a letter off, in or out. */
const editsWithin = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 1) {
    return false
  }
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
    } else {
      edits += 1
      if (edits > 1) {
        return false
      }
      if (a.length > b.length) {
        i += 1
      } else if (b.length > a.length) {
        j += 1
      } else {
        i += 1
        j += 1
      }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

const search = tool(
  "search",
  {
    description:
      "Find people by any field, fuzzily: name, phone (any digits), email, company, handle, city, note.",
    readOnly: true,
    input: Schema.Struct({ query: Schema.String, limit: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    Effect.gen(function* searching() {
      const log = yield* Log
      const all = yield* log.read(everyone)
      const hits = all
        .map((p) => ({ p, s: score(p, input.query) }))
        .filter((h) => h.s > 0)
        .toSorted((a, b) => b.s - a.s)
        .slice(0, Math.min(50, input.limit ?? 10))
      return {
        people: hits.map((h) => ({
          id: h.p.id,
          name: nameOf(h.p),
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
      return view(p)
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
      "Add fields to a person, or remove ones by id. `user`: the user asked for it, which makes the fields theirs (never overwritten) and lets their own fields go. Without it, a field the user set can't be removed. Pass `create` to make a new person.",
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
      const added = (input.add ?? []).map((s) => make(s, source, byUser))
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
    description: "Fold people into one: `from` into `into`. Undo splits them again.",
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
      "Take every source in: Apple and Google (the first time; after that only new cards), other spurs' contacts and everyone who messages the user. Returns counts per source.",
  },
  () => importAll,
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

const identified = tool(
  "identified",
  {
    description: "People recently identified from an unsaved number, newest first.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const log = yield* Log
      const rows = yield* log.read((db) =>
        db
          .query<{ payload: string }, []>(
            `SELECT payload FROM events WHERE type = '${SenderIdentified.type}' ORDER BY seq DESC LIMIT 40`,
          )
          .all()
          .flatMap((r) => {
            const e = SenderIdentified.decode(JSON.parse(r.payload))
            const p = readPerson(db, e.id)
            return p
              ? [
                  {
                    id: p.id,
                    name: nameOf(p),
                    phone: pretty(make({ kind: "phone", value: e.handle }, "", false)),
                  },
                ]
              : []
          }),
      )
      const seen = new Set<string>()
      const people = []
      for (const r of rows) {
        if (!seen.has(r.id)) {
          seen.add(r.id)
          people.push(r)
        }
      }
      return { people: people.slice(0, 12), empty: people.length === 0 ? "Nobody" : "" }
    }),
)

const component = (id: string, rest: Record<string, unknown>) => ({ id, ...rest })

export const contactsApp = defineApp<LogService | ModelsService>({
  name: "contacts",
  version: "1",
  connections: [{ provider: "google", scopes: [SCOPE], multiple: false }],
  instructions:
    "The user's people and companies, merged from Apple, Google, other sources and everyone who messages them; Switch is the source of truth and pushes changes out to Apple and Google. Every field keeps its source and confidence; every change is a batch `undo` reverts.",
  tools: [
    search,
    get,
    update,
    merge,
    enrichTool,
    undoTool,
    importTool,
    identifyTool,
    logTool,
    identified,
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
      space: HOME,
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
