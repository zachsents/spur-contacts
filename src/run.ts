// What runs beyond single tool calls: the whole import, lookups of unknown senders, and the loops
// that keep senders and other sources coming in and changes going out.
import { AppEvents, Log } from "spur-kit"
import { Effect, Layer, Schedule, Stream } from "effect"

import { enrich, releaseBrowser } from "./enrich.ts"
import { importApple, importGoogle, importOffered, importSenders } from "./ingest.ts"
import { push } from "./push.ts"
import { load, save } from "./state.ts"
import type { State } from "./state.ts"
import { batchId } from "./store.ts"

/** Lookups a day it starts on its own: people search is slow and polite. */
const AUTO_PER_DAY = 12

/** Unknown senders, looked up, within the day's budget. */
const lookUp = (
  state: State,
  unknown: readonly { id: string; sender: { firstText: string } }[],
  max: number,
) =>
  Effect.gen(function* identifying() {
    const day = Date.now() - 86_400_000
    state.lookups = state.lookups.filter((t) => t > day)
    const out = []
    for (const u of unknown) {
      if (out.length >= max || state.lookups.length >= AUTO_PER_DAY * 4) {
        break
      }
      state.lookups.push(Date.now())
      const r = yield* enrich(u.id, batchId("identify"), {
        web: false,
        context: u.sender.firstText,
      }).pipe(Effect.catch((error) => Effect.succeed({ id: u.id, error: String(error) })))
      out.push(r)
    }
    return out
  })

/** Looked up already: a lookup that wasn't undone. Undoing one queues the number again. */
const already = (id: string) =>
  Effect.gen(function* checking() {
    const log = yield* Log
    return yield* log.read(
      (db) =>
        (db
          .query<{ n: number }, [string]>(
            `SELECT count(*) AS n FROM events WHERE type = 'contacts.enriched' AND json_extract(payload, '$.id') = ?
             AND json_extract(payload, '$.batch') NOT IN (SELECT batch FROM batches WHERE undone = 1)`,
          )
          .get(id)?.n ?? 0) > 0,
    )
  })

const fresh = (unknown: readonly { id: string; sender: { firstText: string; last: number } }[]) =>
  Effect.gen(function* filtering() {
    const out = []
    for (const u of unknown.toSorted((a, b) => b.sender.last - a.sender.last)) {
      if (!(yield* already(u.id))) {
        out.push(u)
      }
    }
    return out
  })

/** Apple and Google (once), other sources and senders, with counts. */
export const importAll = Effect.gen(function* importing() {
  const state = load()
  const apple = yield* importApple
  const google = yield* importGoogle
  const others = yield* importOffered()
  const senders = yield* importSenders({ brain: state.brain, since: state.since })
  state.brain = senders.cursor.brain
  state.since = senders.cursor.since
  save(state)
  return { apple, google, others, senders: senders.tally, unknown: senders.unknown.length }
})

/** Looks up to `n` unknown senders, newest first, among everyone no book or lookup has named. */
export const identify = (n: number) =>
  Effect.gen(function* identifying() {
    const state = load()
    const senders = yield* importSenders({ brain: 0, since: 0 })
    const queue = yield* fresh(senders.unknown)
    const results = yield* lookUp(state, queue, n)
    save(state)
    yield* Effect.promise(releaseBrowser)
    return { unknown: senders.unknown.length, queued: queue.length, results }
  })

/** The spur's own log, forwarded to whoever subscribed (Switch's brain), from where it left off. */
const forward = Effect.gen(function* forwarding() {
  const log = yield* Log
  const events = yield* AppEvents
  yield* log.changes(load().forwarded).pipe(
    Stream.runForEach((e) =>
      Effect.gen(function* sending() {
        if (e.type.startsWith("contacts.")) {
          yield* Effect.ignore(events.emit({ type: e.type, payload: e.payload }))
        }
        const s = load()
        s.forwarded = e.seq
        save(s)
      }),
    ),
  )
})

const sense = Effect.gen(function* sensing() {
  const state = load()
  const senders = yield* importSenders({ brain: state.brain, since: state.since })
  state.brain = senders.cursor.brain
  state.since = senders.cursor.since
  yield* lookUp(state, yield* fresh(senders.unknown), 3)
  save(state)
  yield* Effect.promise(releaseBrowser)
})

const outward = Effect.gen(function* pushing() {
  const log = yield* Log
  const head = (yield* log.snapshot).seq
  if (head > load().pushedThrough) {
    for (const t of ["apple", "google"] as const) {
      yield* push(t, batchId(`push-${t}`)).pipe(
        Effect.catch((error) => Effect.logWarning(String(error))),
      )
    }
    const s = load()
    s.pushedThrough = (yield* log.snapshot).seq
    save(s)
  }
})

const warn = (cause: unknown) => Effect.logWarning(String(cause))

const every = <E, R>(task: Effect.Effect<unknown, E, R>, interval: Schedule.Schedule<unknown>) =>
  Effect.forkScoped(Effect.repeat(task.pipe(Effect.catch(warn)), interval))

/**
 * The log forwarded, and, unless CONTACTS_LOOPS=0: senders every 10 minutes, other sources every
 * hour, changes out every 2.
 */
export const background = Layer.effectDiscard(
  Effect.gen(function* starting() {
    yield* Effect.forkScoped(forward)
    if (process.env.CONTACTS_LOOPS === "0") {
      return
    }
    yield* every(sense, Schedule.spaced("10 minutes"))
    yield* every(importOffered(false), Schedule.spaced("1 hour"))
    yield* every(outward, Schedule.spaced("2 minutes"))
  }),
)
