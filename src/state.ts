// What the spur remembers between runs, beside its log: cursors into Switch's brain and
// Switchboard, how far its log has gone out, and today's lookups.
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { parse, rec } from "./json.ts"
import { DIR } from "./store.ts"

const STATE = path.join(DIR, "contacts-state.json")

export interface State {
  brain: number
  since: number
  forwarded: number
  lookups: number[]
  pushedThrough: number
}

const num = (v: unknown) => (typeof v === "number" ? v : 0)

export const load = (): State => {
  try {
    const s = rec(parse(readFileSync(STATE, "utf-8")))
    const lookups = Array.isArray(s.lookups)
      ? s.lookups.filter((t: unknown) => typeof t === "number")
      : []
    return {
      brain: num(s.brain),
      since: num(s.since),
      forwarded: num(s.forwarded),
      lookups,
      pushedThrough: num(s.pushedThrough),
    }
  } catch {
    return { brain: 0, since: 0, forwarded: 0, lookups: [], pushedThrough: 0 }
  }
}
export const save = (s: State) => {
  writeFileSync(STATE, JSON.stringify(s))
}
