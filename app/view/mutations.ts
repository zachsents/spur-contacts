// Every change is one of the spur's tools, the same ones the agent calls. Each marks the contacts
// queries stale when it lands; the brain's events do the same for changes made elsewhere.
import { mutationOptions } from "@tanstack/react-query"

import { Done } from "./answers.ts"
import { call } from "./core.ts"
import { queryClient } from "./query.ts"
import { CONTACTS } from "./queries.ts"

const settle = async () => {
  await queryClient.invalidateQueries({ queryKey: CONTACTS })
}

export interface Stated {
  readonly kind: string
  readonly value: string
}

/** The user's own edit: added fields are theirs, and their own may go. */
export const updateMutation = mutationOptions({
  mutationKey: [...CONTACTS, "update"],
  mutationFn: async (input: {
    person?: string
    add?: readonly Stated[]
    remove?: readonly string[]
    create?: boolean
  }) => await call("update", { ...input, user: true }, Done),
  onSettled: settle,
})

export const mergeMutation = mutationOptions({
  mutationKey: [...CONTACTS, "merge"],
  mutationFn: async (input: { into: string; from: readonly string[] }) =>
    await call("merge", input, Done),
  onSettled: settle,
})

export const undoMutation = mutationOptions({
  mutationKey: [...CONTACTS, "undo"],
  mutationFn: async (batch: string) => await call("undo", { batch }, Done),
  onSettled: settle,
})

export const confirmMutation = mutationOptions({
  mutationKey: [...CONTACTS, "confirm"],
  mutationFn: async (input: { person: string; fields: readonly string[] }) =>
    await call("confirm", input, Done),
  onSettled: settle,
})

/** A lookup: keyed by person, so their page shows it running. */
export const enrichKey = (person: string) => [...CONTACTS, "enrich", person] as const

export const enrichMutation = (person: string) =>
  mutationOptions({
    mutationKey: enrichKey(person),
    mutationFn: async () => await call("enrich", { person }, Done),
    onSettled: settle,
  })

export const identifyMutation = mutationOptions({
  mutationKey: [...CONTACTS, "identify"],
  mutationFn: async () => await call("identify", { count: 5 }, Done),
  onSettled: settle,
})

export const importMutation = mutationOptions({
  mutationKey: [...CONTACTS, "import"],
  mutationFn: async () => await call("import", {}, Done),
  onSettled: settle,
})
