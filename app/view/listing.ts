// The side list's lines: worked out from the spur's answers on every render (the compiler keeps
// them while nothing changes), searched in the view with the spur's own scoring, so typing never
// waits on the network.
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"

import { score } from "../../src/text.ts"
import type { Listed, Queued, Waiting } from "./answers.ts"
import type { KindFilter } from "./forms.ts"
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

/** Every label anyone has, as first written, in order. */
export const labelsIn = (everyone: readonly Listed[]) => {
  const seen = new Map<string, string>()
  for (const p of everyone) {
    for (const l of p.labels ?? []) {
      if (!seen.has(l.toLowerCase())) {
        seen.set(l.toLowerCase(), l)
      }
    }
  }
  return [...seen.values()].toSorted((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  )
}

const fits = (p: Listed, label: string, type: KindFilter) =>
  (label === "" || (p.labels ?? []).some((l) => l.toLowerCase() === label.toLowerCase())) &&
  (type === "" || (p.type ?? "none") === type)

/** The identified queue and the numbers still unknown, each under its heading. */
const waitingLines = (
  { queue, waiting }: { readonly queue: readonly Queued[]; readonly waiting: readonly Waiting[] },
  lookUpAll: ReactNode,
) => {
  const lines: Line[] = []
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
  return lines
}

export const useListing = (
  { query, label, type }: { query: string; label: string; type: KindFilter },
  lookUpAll: ReactNode,
) => {
  const people = useQuery(peopleQuery)
  const identified = useQuery(identifiedQuery)
  const all = people.data ?? []
  const labels = labelsIn(all)
  const filtered = label !== "" || type !== ""
  const everyone = filtered ? all.filter((p) => fits(p, label, type)) : all
  const lines: Line[] = []
  if (query.trim() === "") {
    if (!filtered && identified.data) {
      lines.push(...waitingLines(identified.data, lookUpAll))
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
  return { lines, labels, order: [...order], error: error === null ? null : error.message }
}
