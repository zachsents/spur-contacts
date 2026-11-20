// What a lookup found but wasn't sure enough to write: Keep makes it the user's, Drop removes it.
import { useMutation } from "@tanstack/react-query"

import { labelOf, pretty } from "../../../src/text.ts"
import type { Person } from "../answers.ts"
import { confirmMutation, updateMutation } from "../mutations.ts"
import { Cells, percent, SourceLink } from "./cells.tsx"
import { Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"

export const SuggestedSection = ({ person }: { person: Person }) => {
  const keep = useMutation(confirmMutation)
  const drop = useMutation(updateMutation)
  const suggested = person.fields
    .filter((f) => f.suggested === true)
    .toSorted((a, b) => b.confidence - a.confidence)
  if (suggested.length === 0) {
    return null
  }
  const busy = keep.isPending || drop.isPending
  const error = keep.error ?? drop.error
  return (
    <Section label="Suggested" count={suggested.length}>
      {suggested.map((f) => (
        <Cells
          key={f.id}
          label={labelOf(f)}
          source={<SourceLink source={f.source} url={f.url} />}
          sure={percent(f.confidence)}
          end={
            <>
              <Key
                disabled={busy}
                onClick={() => {
                  keep.mutate({ person: person.id, fields: [f.id] })
                }}
              >
                Keep
              </Key>
              <Key
                disabled={busy}
                onClick={() => {
                  drop.mutate({ person: person.id, remove: [f.id] })
                }}
              >
                Drop
              </Key>
            </>
          }
        >
          {pretty(f)}
        </Cells>
      ))}
      {error !== null && <Cells label={<Stop size={12} />}>{error.message}</Cells>}
    </Section>
  )
}
