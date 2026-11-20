// The spur's answers as queries, all under ["contacts"], so a contacts event in the brain marks
// every one of them stale at once.
import { queryOptions } from "@tanstack/react-query"

import { History, Identified, Log, People, Person } from "./answers.ts"
import { call } from "./core.ts"

export const CONTACTS = ["contacts"] as const

export const peopleQuery = queryOptions({
  queryKey: [...CONTACTS, "people"],
  queryFn: async () => (await call("people", {}, People)).people,
})

/** One person, by id, phone, email or exact name. */
export const personQuery = (person: string) =>
  queryOptions({
    queryKey: [...CONTACTS, "person", person],
    queryFn: async () => await call("get", { person }, Person),
  })

export const historyQuery = (person: string) =>
  queryOptions({
    queryKey: [...CONTACTS, "history", person],
    queryFn: async () => (await call("history", { person, limit: 100 }, History)).changes,
  })

export const identifiedQuery = queryOptions({
  queryKey: [...CONTACTS, "identified"],
  queryFn: async () => await call("identified", {}, Identified),
})

export const logQuery = queryOptions({
  queryKey: [...CONTACTS, "log"],
  queryFn: async () => (await call("log", { limit: 200 }, Log)).batches,
})
