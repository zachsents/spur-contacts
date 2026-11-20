// Their cards in other books (Apple, Google, a CRM), and where a book holds something else than
// what Switch would write there.
import { SERVICES } from "../../../src/text.ts"
import type { Person } from "../answers.ts"
import { Cells, sourceName } from "./cells.tsx"
import { Warn } from "./marks.tsx"
import { Section } from "./parts.tsx"

export const RecordsSection = ({ person }: { person: Person }) => {
  const refs = person.fields.filter((f) => f.kind === "ref")
  if (refs.length === 0 && person.conflicts.length === 0) {
    return null
  }
  return (
    <Section label="Records" count={refs.length}>
      {refs.map((f) => (
        <Cells key={f.id} label={SERVICES[f.service ?? ""] ?? sourceName(f.service ?? f.source)}>
          <span className="font-mono text-data text-ink2">{f.value}</span>
        </Cells>
      ))}
      {person.conflicts.map((c) => (
        <Cells
          key={`${c.target}:${c.key}`}
          label={
            <span className="flex items-center gap-2">
              <Warn size={12} />
              {sourceName(c.target)}
            </span>
          }
          source={c.key}
        >
          {c.theirs}
          <span className="ml-2 text-small text-ink3">{c.ours}</span>
        </Cells>
      ))}
    </Section>
  )
}
