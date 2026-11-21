// What runs beyond single tool calls: the whole import, and the loops that keep senders and other
// sources coming in and changes going out.
import { AppEvents, Log } from "spur-kit"
import { Effect, Layer, Schedule, Stream } from "effect"

import { importApple, importGoogle, importOffered, importSenders } from "./ingest.ts"
import { askForGoogle } from "./core.ts"
import { googleConnected } from "./google.ts"
import { push } from "./push.ts"
import { load, markImported, save } from "./state.ts"
import { batchId } from "./store.ts"

const failed = (error: Error) => ({ error: error.message })

/**
 * Apple and Google, each the first time it can be read (`again`: once more), merged only where a
 * card is surely someone already there. Google waits for its connection; `ask` asks for it.
 */
export const importBooks = (again: boolean, ask: boolean) =>
  Effect.gen(function* importing() {
    const { imported } = load()
    const apple =
      again || imported.apple === undefined
        ? yield* importApple.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                markImported("apple")
              }),
            ),
            Effect.catch((error) => Effect.succeed(failed(error))),
          )
        : null
    const connected = yield* googleConnected
    if (!connected && ask) {
      yield* askForGoogle
    }
    const google =
      (again || imported.google === undefined) && connected
        ? yield* importGoogle.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                markImported("google")
              }),
            ),
            Effect.catch((error) => Effect.succeed(failed(error))),
          )
        : null
    return { apple, google: connected ? google : { error: "Google isn't connected" } }
  })

/** The books (each once), other sources and senders, with counts. */
export const importAll = (again: boolean) =>
  Effect.gen(function* importing() {
    const { apple, google } = yield* importBooks(again, true)
    const others = yield* importOffered()
    const state = load()
    const senders = yield* importSenders({ brain: state.brain, since: state.since })
    state.brain = senders.cursor.brain
    state.since = senders.cursor.since
    save(state)
    return { apple, google, others, senders: senders.tally, unknown: senders.unknown.length }
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
  save(state)
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
 * hour, a book not yet imported every 10 minutes (Google once it's connected), changes out every 2.
 */
export const background = Layer.effectDiscard(
  Effect.gen(function* starting() {
    yield* Effect.forkScoped(forward)
    if (process.env.CONTACTS_LOOPS === "0") {
      return
    }
    yield* every(sense, Schedule.spaced("10 minutes"))
    yield* every(importOffered("keys"), Schedule.spaced("1 hour"))
    yield* every(importBooks(false, false), Schedule.spaced("10 minutes"))
    yield* every(outward, Schedule.spaced("2 minutes"))
  }),
)
