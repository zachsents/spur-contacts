// Apple Contacts, through Contacts.app's scripting (JXA): it works headless where the Contacts
// framework needs a prompt a CLI can't show. osascript runs as this spur's child, so the access
// asked for is the host's that launched the spur (Switch Host), not a terminal's.
import { Effect } from "effect"

import { isJson, parse, rec, recs, strings, text } from "./json.ts"
import type { SourceRecord } from "./merge.ts"
import type { Stated } from "./store.ts"

const jxa = (script: string, input: unknown = null) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], {
        env: { ...process.env, SWITCH_INPUT: JSON.stringify(input) },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) {
        throw new Error(`Contacts: ${err.trim().slice(0, 300)}`)
      }
      return parse(out)
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

const READ = `
const C = Application("Contacts"); const p = C.people;
const pick = (f) => { try { return f() } catch (e) { return [] } };
JSON.stringify({
  ids: p.id(), first: p.firstName(), middle: p.middleName(), last: p.lastName(), nick: p.nickname(),
  org: p.organization(), title: p.jobTitle(), dept: p.department(), company: p.company(), note: p.note(),
  phones: p.phones.value(), phoneLabels: p.phones.label(), emails: p.emails.value(), emailLabels: p.emails.label(),
  urls: p.urls.value(), urlLabels: p.urls.label(), city: p.addresses.city(), state: p.addresses.state(),
  related: p.relatedNames.value(), relatedLabels: p.relatedNames.label(),
  socialUser: pick(() => p.socialProfiles.userName()), socialSvc: pick(() => p.socialProfiles.serviceName()),
  birth: p.birthDate(),
})`

const nested = (v: unknown): (string | null)[][] =>
  Array.isArray(v) ? v.map((x: unknown) => strings(x)) : []

/** Contacts' columns, one entry per card. */
const dumpOf = (raw: unknown) => {
  const d = rec(raw)
  return {
    ids: strings(d.ids),
    first: strings(d.first),
    middle: strings(d.middle),
    last: strings(d.last),
    nick: strings(d.nick),
    org: strings(d.org),
    title: strings(d.title),
    company: Array.isArray(d.company) ? d.company.map((x: unknown) => x === true) : [],
    note: strings(d.note),
    phones: nested(d.phones),
    phoneLabels: nested(d.phoneLabels),
    emails: nested(d.emails),
    emailLabels: nested(d.emailLabels),
    urls: nested(d.urls),
    urlLabels: nested(d.urlLabels),
    city: nested(d.city),
    state: nested(d.state),
    related: nested(d.related),
    relatedLabels: nested(d.relatedLabels),
    socialUser: nested(d.socialUser),
    socialSvc: nested(d.socialSvc),
    birth: strings(d.birth),
  }
}
type Dump = ReturnType<typeof dumpOf>

/** Apple's labels come as `_$!<Mobile>!$_`. */
const label = (raw: string | null | undefined) =>
  (raw ?? "")
    .replace(/^_\$!</u, "")
    .replace(/>!\$_$/u, "")
    .toLowerCase()

const SOCIAL: Readonly<Record<string, string>> = {
  instagram: "instagram",
  twitter: "x",
  facebook: "facebook",
  linkedin: "linkedin",
  telegram: "telegram",
}

const PROFILE =
  /^(?:https?:\/\/)?(?:www\.)?(?<site>instagram\.com|linkedin\.com\/in|t\.me|x\.com|twitter\.com|facebook\.com)\/(?<user>[^/?#]+)/iu

const serviceOf = (site: string) => {
  if (site.startsWith("instagram")) {
    return "instagram"
  }
  if (site.startsWith("linkedin")) {
    return "linkedin"
  }
  if (site === "t.me") {
    return "telegram"
  }
  if (site.startsWith("facebook")) {
    return "facebook"
  }
  return "x"
}

/** A profile URL as a handle on its service, if it's one we know. */
export const handleOfUrl = (url: string): Stated | null => {
  const m = PROFILE.exec(url)
  if (!m) {
    return null
  }
  const site = (m.groups?.site ?? "").toLowerCase()
  return { kind: "handle", value: m.groups?.user ?? "", service: serviceOf(site), url }
}

const clean = (s: string | null | undefined) => (s ?? "").trim()

const nameFields = (d: Dump, i: number): Stated[] => {
  const fields: Stated[] = []
  const first = clean(d.first[i])
  const last = clean(d.last[i])
  const middle = clean(d.middle[i])
  const org = clean(d.org[i])
  const full = [first, middle, last].filter((x) => x !== "").join(" ")
  if (full !== "") {
    fields.push({ kind: "name", value: full })
  } else if (org !== "" && d.company[i] === true) {
    fields.push({ kind: "name", value: org })
  }
  const nick = clean(d.nick[i])
  if (nick !== "") {
    fields.push({ kind: "name", value: nick, label: "nickname" })
  }
  if (org !== "") {
    fields.push({ kind: "company", value: org })
  }
  const title = clean(d.title[i])
  if (title !== "") {
    fields.push({ kind: "role", value: title })
  }
  return fields
}

/** Values Apple keeps several of, each with its label. */
const reachFields = (d: Dump, i: number): Stated[] => {
  const fields: Stated[] = []
  for (const [j, v] of (d.phones[i] ?? []).entries()) {
    if (v !== null) {
      fields.push({ kind: "phone", value: v, label: label(d.phoneLabels[i]?.[j]) })
    }
  }
  for (const [j, v] of (d.emails[i] ?? []).entries()) {
    if (v !== null) {
      fields.push({ kind: "email", value: v, label: label(d.emailLabels[i]?.[j]) })
    }
  }
  for (const [j, v] of (d.urls[i] ?? []).entries()) {
    if (v !== null) {
      fields.push(handleOfUrl(v) ?? { kind: "url", value: v, label: label(d.urlLabels[i]?.[j]) })
    }
  }
  return fields
}

const linkFields = (d: Dump, i: number): Stated[] => {
  const fields: Stated[] = []
  for (const [j, v] of (d.socialUser[i] ?? []).entries()) {
    const svc = SOCIAL[label(d.socialSvc[i]?.[j])]
    if (v !== null && svc !== undefined) {
      fields.push({ kind: "handle", value: v, service: svc })
    }
  }
  for (const [j, v] of (d.related[i] ?? []).entries()) {
    if (v !== null) {
      fields.push({ kind: "relation", value: v, label: label(d.relatedLabels[i]?.[j]) })
    }
  }
  return fields
}

const otherFields = (d: Dump, i: number): Stated[] => {
  const fields: Stated[] = []
  const city = clean(d.city[i]?.[0])
  const state = clean(d.state[i]?.[0])
  if (city !== "" || state !== "") {
    fields.push({ kind: "location", value: [city, state].filter((x) => x !== "").join(", ") })
  }
  const note = clean(d.note[i])
  if (note !== "") {
    fields.push({ kind: "note", value: note })
  }
  const birth = d.birth[i]
  if (birth !== null && birth !== undefined) {
    // Apple keeps a birthday without a year as 1604.
    const date = birth.slice(0, 10)
    fields.push({ kind: "birthday", value: date.startsWith("1604-") ? `-${date.slice(4)}` : date })
  }
  return fields
}

export const appleRecords = Effect.map(jxa(READ), (raw): SourceRecord[] => {
  const d = dumpOf(raw)
  return d.ids.flatMap((id, i): SourceRecord[] => {
    if (id === null) {
      return []
    }
    const other = otherFields(d, i)
    const links = linkFields(d, i)
    // In the order the fields always came: names, lists, then location, relations, note, birthday.
    const fields = [
      ...nameFields(d, i),
      ...reachFields(d, i),
      ...links.filter((f) => f.kind !== "relation"),
      ...other.filter((f) => f.kind === "location"),
      ...links.filter((f) => f.kind === "relation"),
      ...other.filter((f) => f.kind !== "location"),
    ]
    return [
      { source: "apple", ref: { service: "apple", value: id }, fields, user: true, create: true },
    ]
  })
})

/** Every card as a vCard, for the backup. */
export const appleVcards = Effect.map(
  jxa(`JSON.stringify(Application("Contacts").people.vcard())`),
  (raw) =>
    strings(raw)
      .filter((v) => v !== null)
      .join("\n"),
)

/** One card's values now, to check before writing. */
export interface AppleCard {
  readonly id: string
  readonly first: string
  readonly last: string
  readonly org: string
  readonly title: string
  readonly note: string
  readonly phones: string[]
  readonly emails: string[]
  readonly urls: string[]
}

const CARD = `
const C = Application("Contacts"); const ids = JSON.parse($.NSProcessInfo.processInfo.environment.objectForKey("SWITCH_INPUT").js);
JSON.stringify(ids.map((id) => { try { const p = C.people.byId(id); return { id, first: p.firstName() || "", last: p.lastName() || "",
  org: p.organization() || "", title: p.jobTitle() || "", note: p.note() || "", phones: p.phones.value(), emails: p.emails.value(), urls: p.urls.value() } } catch (e) { return null } }))`

const values = (v: unknown) => strings(v).filter((x) => x !== null)

const cardOf = (c: unknown): AppleCard[] => {
  if (!isJson(c) || typeof c.id !== "string") {
    return []
  }
  return [
    {
      id: c.id,
      first: text(c.first),
      last: text(c.last),
      org: text(c.org),
      title: text(c.title),
      note: text(c.note),
      phones: values(c.phones),
      emails: values(c.emails),
      urls: values(c.urls),
    },
  ]
}

export const appleCards = (ids: readonly string[]) =>
  Effect.map(jxa(CARD, ids), (raw) =>
    Array.isArray(raw) ? raw.flatMap((c: unknown) => cardOf(c)) : [],
  )

/** What to do to one card: fill blanks, add values, or take back values Switch added. */
export interface AppleEdit {
  /** Absent: a new card, in the Switch group. */
  readonly id?: string
  readonly set?: Readonly<Partial<Record<"first" | "last" | "org" | "title" | "note", string>>>
  readonly add?: {
    readonly phones?: readonly { value: string; label: string }[]
    readonly emails?: readonly { value: string; label: string }[]
    readonly urls?: readonly { value: string; label: string }[]
  }
  readonly remove?: {
    readonly phones?: readonly string[]
    readonly emails?: readonly string[]
    readonly urls?: readonly string[]
  }
  /** Clear these, if they still hold what Switch put there. */
  readonly clear?: Readonly<Partial<Record<"first" | "last" | "org" | "title" | "note", string>>>
  /** Delete the card: only one Switch made, on undo. */
  readonly delete?: boolean
}

const EDIT = `
const C = Application("Contacts");
const edits = JSON.parse($.NSProcessInfo.processInfo.environment.objectForKey("SWITCH_INPUT").js);
const props = { first: "firstName", last: "lastName", org: "organization", title: "jobTitle", note: "note" };
const kinds = { phones: ["phones", "Phone"], emails: ["emails", "Email"], urls: ["urls", "Url"] };
let group = null;
const switchGroup = () => {
  if (group) return group;
  const found = C.groups.whose({ name: "Switch" })();
  if (found.length > 0) { group = found[0]; return group; }
  group = C.Group({ name: "Switch" }); C.groups.push(group); C.save(); group = C.groups.whose({ name: "Switch" })()[0]; return group;
};
const out = [];
for (const e of edits) {
  try {
    let p;
    if (e.id) { p = C.people.byId(e.id); p.id(); } else { p = C.Person({}); C.people.push(p); }
    if (e.delete) { C.delete(p); C.save(); out.push({ id: e.id, ok: true }); continue; }
    for (const [k, v] of Object.entries(e.set || {})) { const cur = p[props[k]]() || ""; if (cur === "") p[props[k]] = v; }
    for (const [k, v] of Object.entries(e.clear || {})) { const cur = p[props[k]]() || ""; if (cur === v) p[props[k]] = ""; }
    for (const [k, list] of Object.entries(e.add || {})) {
      const [coll, make] = kinds[k];
      const have = p[coll].value();
      for (const item of list) { if (!have.includes(item.value)) p[coll].push(C[make]({ label: item.label, value: item.value })); }
    }
    for (const [k, list] of Object.entries(e.remove || {})) {
      const [coll] = kinds[k];
      const items = p[coll]();
      for (let i = items.length - 1; i >= 0; i--) { if (list.includes(items[i].value())) C.delete(items[i]); }
    }
    C.save();
    if (!e.id) { C.add(p, { to: switchGroup() }); C.save(); }
    out.push({ id: p.id(), ok: true });
  } catch (err) { out.push({ id: e.id || null, ok: false, error: String(err) }); }
}
JSON.stringify(out)`

export const appleEdit = (edits: readonly AppleEdit[]) =>
  Effect.map(jxa(EDIT, edits), (raw) =>
    recs(raw).map((r) => ({
      id: typeof r.id === "string" ? r.id : null,
      ok: r.ok === true,
      ...(typeof r.error === "string" ? { error: r.error } : {}),
    })),
  )
