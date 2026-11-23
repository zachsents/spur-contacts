// What runs beyond single tool calls: the whole import, and the loops that keep senders and other
// sources coming in and changes going out.
import { AppEvents, Log } from "switch-ext-kit"
import { Effect, Layer, Schedule, Stream } from "effect"

import { importApple, importGoogle, importOffered, importSenders } from "./ingest.ts"
import { askForGoogle } from "./core.ts"
import { googleConnected } from "./google.ts"
import { attempt, beat, setFailing, several, why } from "./heartbeat.ts"
import { keepEvent, kept, keptLine, tried } from "./kept.ts"
import { take } from "./merge.ts"
import { contactEvents } from "./model.ts"
import { push } from "./push.ts"
import { load, markImported, save } from "./state.ts"
import { batchId } from "./store.ts"

const MINUTE = 60_000

const failed = (error: Error) => ({ error: error.message })

/** A book's import: its error is the part's trouble until one works. */
const tracked = (part: string) => ({
  ok: () =>
    Effect.sync(() => {
      setFailing(part, null)
    }),
  failed: (error: Error) =>
    Effect.sync(() => {
      setFailing(part, error.message)
      return failed(error)
    }),
})

/**
 * Apple and Google, each the first time it can be read (`again`: once more), merged only where a
 * card is surely someone already there. Google waits for its connection; `ask` asks for it.
 */
export const importBooks = (again: boolean, ask: boolean) =>
  Effect.gen(function* importing() {
    const { imported } = load()
    const appleImport = tracked("apple import")
    const apple =
      again || imported.apple === undefined
        ? yield* importApple.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                markImported("apple")
              }),
            ),
            Effect.tap(appleImport.ok),
            Effect.catch(appleImport.failed),
          )
        : null
    const connected = yield* googleConnected
    if (!connected && ask) {
      yield* askForGoogle
    }
    const googleImport = tracked("google import")
    const google =
      (again || imported.google === undefined) && connected
        ? yield* importGoogle.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                markImported("google")
              }),
            ),
            Effect.tap(googleImport.ok),
            Effect.catch(googleImport.failed),
          )
        : null
    return { apple, google: connected ? google : { error: "Google isn't connected" } }
  })

/** The books (each once), other sources and senders, with counts. */
export const importAll = (again: boolean) =>
  Effect.gen(function* importing() {
    const { apple, google } = yield* importBooks(again, true)
    const others = yield* importOffered().pipe(
      Effect.catch((error) => Effect.succeed(failed(error))),
    )
    const state = load()
    const senders = yield* importSenders({ brain: state.brain, since: state.since })
    state.brain = senders.cursor.brain
    state.since = senders.cursor.since
    save(state)
    return { apple, google, others, senders: senders.tally, unknown: senders.unknown.length }
  })

const published = new Set<string>(contactEvents.map((e) => e.type))

/**
 * The extension's own log, forwarded to whoever subscribed (Switch's brain), from where it left
 * off. An event refused is kept, with why, and the rest go on.
 */
const forward = Effect.gen(function* forwarding() {
  const log = yield* Log
  const events = yield* AppEvents
  yield* log.changes(load().forwarded).pipe(
    Stream.runForEach((e) =>
      Effect.gen(function* sending() {
        if (published.has(e.type)) {
          const sent = { id: e.id, type: e.type, payload: e.payload }
          const error = yield* attempt(events.emit(sent))
          if (error !== null) {
            keepEvent(sent, error)
          }
        }
        const s = load()
        s.forwarded = e.seq
        save(s)
      }),
    ),
  )
})

/** Forwarding for good: when it stops, that's its trouble, and it starts again a minute later. */
const forwarding = Effect.forever(
  Effect.gen(function* again() {
    setFailing("forwarding", (yield* attempt(forward)) ?? "stopped")
    yield* Effect.sleep("1 minute")
    setFailing("forwarding", null)
  }),
)

/** At most this many skipped are tried again a round. */
const RETRIES = 50

/** What earlier passes skipped, tried again, oldest first. */
const retry = Effect.gen(function* retrying() {
  const events = yield* AppEvents
  for (const k of kept().slice(0, RETRIES)) {
    tried(
      k.key,
      k.kind === "record"
        ? yield* attempt(
            take(k.record, batchId(`retry-${k.source}`), `retry ${k.source}`, k.matching),
          )
        : yield* attempt(events.emit({ id: k.id, type: k.type, payload: k.payload })),
    )
  }
})

const sense = Effect.gen(function* sensing() {
  yield* retry
  const state = load()
  const senders = yield* importSenders({ brain: state.brain, since: state.since })
  state.brain = senders.cursor.brain
  state.since = senders.cursor.since
  save(state)
  if (!senders.whole) {
    yield* Effect.fail(new Error("Can't reach the core"))
  }
})

/** When a book whose push had errors is pushed again, though nothing changed. */
const pushAgain = new Map<"apple" | "google", number>()

const outward = Effect.gen(function* pushing() {
  const log = yield* Log
  const head = (yield* log.snapshot).seq
  const moved = head > load().pushedThrough
  const now = Date.now()
  for (const t of ["apple", "google"] as const) {
    if (moved || (pushAgain.get(t) ?? Infinity) <= now) {
      const exit = yield* Effect.exit(push(t, batchId(`push-${t}`)))
      let error: string | null = null
      if (exit._tag === "Failure") {
        error = why(exit.cause)
      } else if (load().imported[t] !== undefined) {
        error = several(exit.value.errors)
      }
      setFailing(`push to ${t}`, error)
      if (error === null) {
        pushAgain.delete(t)
      } else {
        pushAgain.set(t, now + 10 * MINUTE)
      }
    }
  }
  if (moved) {
    const s = load()
    s.pushedThrough = (yield* log.snapshot).seq
    save(s)
  }
})

const facts = Effect.gen(function* counting() {
  const log = yield* Log
  const people = yield* log.read(
    (db) =>
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM people WHERE merged_into IS NULL AND retired = 0",
        )
        .get()?.n ?? 0,
  )
  return { people, skipped: kept().length }
})

/**
 * A loop: `task` every `interval`, its failure the part's trouble, and a beat if what's failing
 * changed (`round`: the senders loop, whose beat is due every five minutes).
 */
const every = <E, R>(
  part: string,
  task: Effect.Effect<unknown, E, R>,
  interval: Schedule.Schedule<unknown>,
  round = false,
) =>
  Effect.forkScoped(
    Effect.repeat(
      Effect.gen(function* running() {
        setFailing(part, yield* attempt(task))
        setFailing("skipped", keptLine())
        yield* beat(round, facts)
      }),
      interval,
    ),
  )

/**
 * The log forwarded, and, unless CONTACTS_LOOPS=0: senders and what was skipped every 5 minutes,
 * with the heartbeat; other sources every hour; a book not yet imported every 10 minutes (Google
 * once it's connected); changes out every 2.
 */
export const background = Layer.effectDiscard(
  Effect.gen(function* starting() {
    yield* Effect.forkScoped(forwarding)
    if (process.env.CONTACTS_LOOPS === "0") {
      return
    }
    yield* every("senders", sense, Schedule.spaced("5 minutes"), true)
    yield* every("other sources", importOffered("keys"), Schedule.spaced("1 hour"))
    yield* every("books", importBooks(false, false), Schedule.spaced("10 minutes"))
    yield* every("push", outward, Schedule.spaced("2 minutes"))
  }),
)
