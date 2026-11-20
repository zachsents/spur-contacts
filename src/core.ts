// The rest of Switch, reached the way an agent reaches it: the core's apps over MCP (`/apps`), and
// its loopback routes. What Contacts asks of it: the user's connected Google account and a fresh
// token for it, or an action item asking the user to connect one.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { Effect } from "effect"

import { isJson, parse, rec, str } from "./json.ts"

export const core = (): string => process.env.SWITCH_URL ?? "http://127.0.0.1:4871"

let connected: Promise<Client> | null = null

const open = async () => {
  const client = new Client({ name: "contacts", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${core()}/apps`)))
  return client
}

/** Calls another app's tool (`<app>_<tool>`): its structured result, or null if it isn't there. */
export const callCore = (name: string, args: Record<string, unknown>) =>
  Effect.promise(async () => {
    try {
      connected ??= open()
      const client = await connected
      const r = await client.callTool({ name, arguments: args })
      if (r.isError === true) {
        return null
      }
      if (isJson(r.structuredContent)) {
        return r.structuredContent
      }
      const first = Array.isArray(r.content) ? r.content[0] : undefined
      const parsed = parse(first?.type === "text" ? first.text : "null")
      return isJson(parsed) ? parsed : null
    } catch {
      connected = null
      return null
    }
  })

/** The first connected Google account that granted `scope`; null when there's none or no core. */
export const googleAccount = (scope: string) =>
  Effect.map(callCore("connections_list", {}), (r) => {
    const list = Array.isArray(r?.connections) ? r.connections : []
    for (const c of list) {
      const one = rec(c)
      const scopes = Array.isArray(one.scopes) ? one.scopes : []
      if (one.provider === "google" && str(one.account) !== "" && scopes.includes(scope)) {
        return str(one.account)
      }
    }
    return null
  })

/** Asks the user to connect a Google account: an action item with a Connect button. */
export const askForGoogle: Effect.Effect<unknown> = callCore("connections_request", {
  provider: "google",
})

/** A fresh access token from the core, which holds the account's connection. */
export const accessToken = async (account: string): Promise<string> => {
  const id = encodeURIComponent(`google:${account}`)
  const res = await fetch(`${core()}/connections/token?id=${id}`)
  const t = rec(await res.json().catch(() => ({})))
  if (!res.ok || typeof t.token !== "string") {
    throw new Error(`${account} isn't connected`)
  }
  return t.token
}
