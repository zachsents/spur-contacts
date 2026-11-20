// The contacts log: the brain's write path on its own file, with the contacts projection.
import { homedir } from "node:os"
import path from "node:path"
import { Log } from "spur-kit"
import type { Draft } from "spur-kit"
import { Effect } from "effect"

import { Change, contactEvents, keyOf, people, readPerson } from "./model.ts"
import type { Field, Kind, Person } from "./model.ts"

/** Beside the brain it tells. */
export const SWITCH = process.env.SWITCH_DIR ?? path.join(homedir(), ".switch")
export const DIR = process.env.SWITCH_CONTACTS_DIR ?? SWITCH
export const DB = path.join(DIR, "contacts.db")

export const logLayer = (file = DB) =>
  Log.layer({ path: file, events: contactEvents, projections: [people], commands: [Change] })

export const batchId = (what: string) =>
  `${what}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`

/** A field as a source states it; the rest is filled in. */
export interface Stated {
  readonly kind: Kind
  readonly value: string
  readonly label?: string
  readonly service?: string
  readonly url?: string
  readonly confidence?: number
  readonly suggested?: boolean
}

export const make = (s: Stated, source: string, user: boolean, at = Date.now()): Field => ({
  id: crypto.randomUUID(),
  kind: s.kind,
  value: s.value.trim(),
  ...(s.label === undefined || s.label === "" ? {} : { label: s.label }),
  ...(s.service === undefined ? {} : { service: s.service }),
  source,
  ...(s.url === undefined ? {} : { url: s.url }),
  confidence: s.confidence ?? 1,
  user,
  ...(s.suggested === true ? { suggested: true } : {}),
  at,
})

/** Writes one change: its events, checked, in one transaction. */
export const commit = (batch: string, events: readonly Draft[], byUser = false) =>
  Effect.gen(function* committing() {
    if (events.length === 0) {
      return 0
    }
    const log = yield* Log
    const receipt = yield* log.dispatch({
      id: crypto.randomUUID(),
      type: Change.type,
      source: byUser ? "user" : "contacts",
      payload: { batch, byUser, events },
    })
    return receipt.seq
  })

export const getPerson = (id: string) =>
  Effect.gen(function* getting() {
    const log = yield* Log
    return yield* log.read((db) => readPerson(db, id))
  })

/** The fields of `incoming` the person doesn't hold yet, by kind and normal form. */
export const missing = (p: Person | null, incoming: readonly Field[]) => {
  const have = new Set((p?.fields ?? []).map((f) => keyOf(f)))
  const out: Field[] = []
  for (const f of incoming) {
    const k = keyOf(f)
    if (f.kind !== "last_contact" && !have.has(k) && f.value.trim() !== "") {
      have.add(k)
      out.push(f)
    }
  }
  return out
}
