// Their enrichment: when they were last looked up, what it looked at, what it found and wrote, and
// what it cost.
import type { Person } from "../answers.ts"
import { day } from "../../../src/text.ts"
import { Cells } from "./cells.tsx"
import { Stop } from "./marks.tsx"
import { Section } from "./parts.tsx"

const LOOKED: Readonly<Record<string, string>> = { phone: "Phone", name: "Name", web: "Web" }

export const LookupSection = ({ person, error }: { person: Person; error: string | null }) => {
  const l = person.lookup
  return (
    <Section label="Lookup">
      {l === null ? (
        <Cells label="Last">Never</Cells>
      ) : (
        <>
          <Cells label="Last">{day(l.at)}</Cells>
          <Cells label="Looked at">{l.looked.map((x) => LOOKED[x] ?? x).join(", ")}</Cells>
          <Cells label="Found">
            <span className="font-mono">{l.found}</span>
          </Cells>
          <Cells label="Written">
            <span className="font-mono">{l.written}</span>
          </Cells>
          <Cells label="Cost">
            <span className="font-mono">${l.cost.toFixed(3)}</span>
          </Cells>
        </>
      )}
      {error !== null && <Cells label={<Stop size={12} />}>{error}</Cells>}
    </Section>
  )
}
