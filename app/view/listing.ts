// The side list's lines: worked out from the spur's answers on every render (the compiler keeps
// them while nothing changes), searched in the view with the spur's own scoring, so typing never
// waits on the network.
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"

import { score } from "../../src/text.ts"
import type { Listed } from "./answers.ts"
import { identifiedQuery, peopleQuery } from "./queries.ts"

export type Line =
  | {
      readonly kind: "head"
      readonly key: string
      readonly label: string
      readonly count: number
      readonly mark?: "hand"
      readonly action?: ReactNode
    }
  | { readonly kind: "empty"; readonly key: string; readonly label: string }
  | {
      readonly kind: "person"
      readonly key: string
      readonly id: string
      readonly name: string
      readonly detail?: string
    }

/** Names before numbers and addresses, then as a book sorts them. */
const byName = (a: Listed, b: Listed) => {
  const la = /^\p{L}/u.test(a.name)
  const lb = /^\p{L}/u.test(b.name)
  if (la !== lb) {
    return la ? -1 : 1
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
}

const person = (section: string, p: { id: string; name: string }, detail?: string): Line =>
  detail === undefined
    ? { kind: "person", key: `${section}:${p.id}`, id: p.id, name: p.name }
    : { kind: "person", key: `${section}:${p.id}`, id: p.id, name: p.name, detail }

export const useListing = (query: string, lookUpAll: ReactNode) => {
  const people = useQuery(peopleQuery)
  const identified = useQuery(identifiedQuery)
  const everyone = people.data ?? []
  const lines: Line[] = []
  if (query.trim() === "") {
    const queue = identified.data?.queue ?? []
    const waiting = identified.data?.waiting ?? []
    if (queue.length > 0) {
      lines.push({
        kind: "head",
        key: "h:identified",
        label: "Identified",
        count: queue.length,
        mark: "hand",
      })
      for (const q of queue) {
        lines.push(person("identified", q, q.phone))
      }
    }
    if (waiting.length > 0) {
      lines.push({
        kind: "head",
        key: "h:unknown",
        label: "Unknown",
        count: waiting.length,
        action: lookUpAll,
      })
      for (const w of waiting) {
        lines.push(person("unknown", { id: w.id, name: w.phone }))
      }
    }
    lines.push({ kind: "head", key: "h:people", label: "People", count: everyone.length })
    for (const p of everyone.toSorted(byName)) {
      lines.push(person("people", p))
    }
  } else {
    const hits = everyone
      .map((p) => ({ p, s: score(p.fields, query) }))
      .filter((h) => h.s > 0)
      .toSorted((a, b) => b.s - a.s || byName(a.p, b.p))
    lines.push({ kind: "head", key: "h:people", label: "People", count: hits.length })
    for (const h of hits) {
      lines.push(person("people", h.p))
    }
  }
  if (people.isSuccess && lines.at(-1)?.kind === "head") {
    lines.push({ kind: "empty", key: "empty", label: "Nobody" })
  }
  const order = new Set<string>()
  for (const l of lines) {
    if (l.kind === "person") {
      order.add(l.id)
    }
  }
  const error = people.error ?? identified.error
  return { lines, order: [...order], error: error === null ? null : error.message }
}
