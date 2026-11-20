// Taking sources in. Apple and Google once, as the first import: after that Switch is the source of
// truth and only pushes out. Other sources' records and message senders keep flowing in.
import { Log } from "spur-kit"
import { Effect } from "effect"

import { appleRecords } from "./apple.ts"
import { googlePeople, toRecord as googleRecord } from "./google.ts"
import { take } from "./merge.ts"
import type { SourceRecord } from "./merge.ts"
import { best, Imported, readPerson, SenderUnknown } from "./model.ts"
import { phoneKey } from "./text.ts"
import { offered } from "./offered.ts"
import { batchId, commit } from "./store.ts"
import { fromBrain, fromSwitchboard, gather, toRecord as senderRecord } from "./senders.ts"
import type { Sender } from "./senders.ts"

export interface Tally {
  readonly source: string
  readonly records: number
  readonly created: number
  readonly merged: number
  /** Records that turned out to be someone already there: duplicates, merged. */
  readonly matched: number
  readonly asked: number
  readonly cost: number
  readonly batch: string
}

export const takeAll = (source: string, records: readonly SourceRecord[], useModel = true) =>
  Effect.gen(function* taking() {
    const batch = batchId(`import-${source}`)
    let created = 0
    let merged = 0
    let matched = 0
    let asked = 0
    let cost = 0
    for (const r of records) {
      const o = yield* take(r, batch, `import ${source}`, useModel)
      created += o.created ? 1 : 0
      merged += o.merged
      matched += o.matched ? 1 : 0
      asked += o.asked
      cost += o.cost
    }
    yield* commit(batch, [
      Imported.make({ source, records: records.length, created, merged: merged + matched, batch }),
    ])
    return {
      source,
      records: records.length,
      created,
      merged,
      matched,
      asked,
      cost,
      batch,
    } satisfies Tally
  })

export const importApple = appleRecords.pipe(Effect.flatMap((rs) => takeAll("apple", rs)))
export const importGoogle = googlePeople.pipe(
  Effect.flatMap((gs) =>
    takeAll(
      "google",
      gs.map((g) => googleRecord(g)),
    ),
  ),
)
/** What other spurs publish, one tally per source. */
export const importOffered = (useModel = true) =>
  offered.pipe(
    Effect.flatMap((by) =>
      Effect.forEach([...by], ([source, rs]) => takeAll(source, rs, useModel)),
    ),
  )

/** Phones that text the user one to one, with no name in Apple or Google. */
export const unknownSender = (s: Sender) =>
  s.kind === "phone" && s.fromThem > 0 && s.marketing < s.fromThem

/**
 * Senders since the cursors: folded in, and each phone no address book names recorded as an
 * unknown sender, once. Returns the unknown ones, for enrichment.
 */
export const importSenders = (cursor: { readonly brain: number; readonly since: number }) =>
  Effect.gen(function* sensing() {
    const log = yield* Log
    const own = yield* fromBrain(cursor.brain)
    const sb = yield* fromSwitchboard(cursor.since).pipe(Effect.orElseSucceed(() => []))
    const seen = [...own.seen, ...sb]
    const senders = gather(seen)
    const tally = yield* takeAll("senders", senders.map(senderRecord))
    const batch = batchId("unknown")
    const unknown: { id: string; sender: Sender }[] = []
    for (const s of senders.filter(unknownSender)) {
      // Whoever already holds the number is who it is; a new person only for a number no one has.
      const holder = yield* log.read(
        (db) =>
          db
            .query<{ person: string }, [string]>(
              "SELECT f.person FROM fields f JOIN people p ON p.id = f.person WHERE f.kind = 'phone' AND f.norm = ? AND p.merged_into IS NULL AND p.retired = 0 ORDER BY p.created LIMIT 1",
            )
            .get(phoneKey(s.handle))?.person ?? null,
      )
      const o =
        holder === null
          ? yield* take({ ...senderRecord(s), create: true }, batch, "senders", false)
          : { person: holder }
      if (o.person === null) {
        continue
      }
      const id = o.person
      const named = yield* log.read((db) => {
        const p = readPerson(db, id)
        const fromBook = p?.fields.some(
          (f) =>
            f.kind === "name" &&
            f.suggested !== true &&
            (f.user || ["apple", "google", "imessage", "fastpeoplesearch"].includes(f.source)),
        )
        const flagged =
          db
            .query<{ n: number }, [string]>(
              "SELECT count(*) AS n FROM events WHERE type = 'contacts.sender_unknown' AND json_extract(payload, '$.id') = ?",
            )
            .get(id)?.n ?? 0
        return {
          fromBook: fromBook === true,
          flagged: flagged > 0,
          name: p ? best(p, "name") : undefined,
        }
      })
      if (!named.fromBook) {
        unknown.push({ id, sender: s })
        if (!named.flagged) {
          yield* commit(batch, [
            SenderUnknown.make({
              id,
              handle: s.handle,
              channel: s.channel,
              batch,
              reason: "unknown sender",
            }),
          ])
        }
      }
    }
    let last = cursor.since
    for (const r of seen) {
      last = Math.max(last, r.at)
    }
    return { tally, unknown, cursor: { brain: own.cursor, since: last } }
  })
